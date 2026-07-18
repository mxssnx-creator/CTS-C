/**
 * Volume Calculator (TDZ fix: accountBalance declared before balanceCap block)
 * Calculates position volume based on base volume factor, leverage, and risk management
 * Calculates position volume ONLY at Exchange level when actual orders are executed
 * This calculator is ONLY used by ExchangePositionManager
 * Base/Main/Real pseudo positions do NOT use volume - they use counts and ratios
 * 
 * Redis-native: All data stored in Redis via redis-db
 */

import { initRedis, getSettings, getAppSettings, setSettings, getRedisClient, getConnection } from "@/lib/redis-db"
import { getMaxLeverageForExchange } from "@/lib/leverage-policy"

interface VolumeCalculationParams {
  baseVolumeFactor?: number
  positionsAverage?: number
  riskPercentage?: number
  maxLeverage?: number
  positionCost?: number
  accountBalance: number
  currentPrice: number
  leverage?: number
  exchangeMinVolume?: number

  // ── LIVE-only engine factor (spec: pseudo positions are ratio-only) ──
  //
  // Which Trade Engine is asking for sizing? Determines which volume-
  // factor multiplier (if any) is applied to the LIVE notional.
  //
  // The Strategy stack (Base/Main/Real pseudo positions) is RATIO-based
  // and count-driven per spec — it MUST NOT receive any volume-factor
  // multiplier. Only Live Positions (real exchange orders) get the
  // engine-specific scalar applied. So Strategy callers leave
  // `tradeMode` undefined keeps the pseudo-position path at 1.0 (identity).
  //
  //   - `"main"`   → multiply by `mainVolumeFactor`   (a.k.a. live_volume_factor)
  //   - `"preset"` → multiply by `presetVolumeFactor` (a.k.a. preset_volume_factor)
  //   - omitted    → no engine multiplier (pseudo-position / Strategy path)
  tradeMode?: "main" | "preset"

  // Volume scaling factors applied at the LIVE-EXECUTION layer only.
  // Live-engine factors default to the canonical minimum 0.1 when missing
  // or invalid. Bounded to [0.1, 10] inside `calculatePositionVolume` so a misconfigured
  // setting can never blow out a live order to 100× the intended size.
  mainVolumeFactor?: number
  presetVolumeFactor?: number
  // Adjust-type variant multiplier: block=1.5-2.0, dca=0.5, others=1.0.
  // Applied after liveEngineFactor; absent/undefined → 1.0 (no scaling).
  // Clamped to [0.1, 5] — narrower than engine factor's [0.1, 10] since
  // this comes from automated variantProfiles, not operator overrides.
  sizeMultiplier?: number
}

interface VolumeCalculationResult {
  calculatedVolume?: number
  finalVolume?: number
  leverage: number
  positionSize?: number
  volume?: number
  volumeUsd?: number
  volumeAdjusted: boolean
  adjustmentReason?: string
  riskAmount?: number
  /** Pure strategy notional before exchange/universal minimum floors. */
  intendedNotionalUsd?: number
  /** Exchange/universal minimum notional implied by the effective quantity floor. */
  exchangeMinNotionalUsd?: number
  /** Raw sizing inputs echoed for live-stage risk validation and diagnostics. */
  accountBalance?: number
  positionCost?: number
  positionsAverage?: number
  liveEngineFactor?: number
  sizeMultiplier?: number
  exchangeMinVolume?: number
}

export class VolumeCalculator {
  /** Used only when live contract metadata cannot be resolved. */
  private static readonly UNIVERSAL_MIN_NOTIONAL_USD = 5

  /**
   * Fetch account balance and compute the leverage safety cap.
   *
   * Extracted into its own method so the balance-fetch + cap logic lives in
   * a single clean scope with no `let` mutation — eliminating the TDZ risk
   * that existed when this logic was inlined inside calculateVolumeForConnection.
   *
   * Returns { accountBalance, maxLeverage } — both always finite numbers.
   */
  static async resolveBalanceAndLeverage(
    connectionId: string,
    rawLeverage: number,
  ): Promise<{ accountBalance: number; maxLeverage: number }> {
    // Fetch balance — default $10,000 so the leverage cap is benign when
    // the exchange API is unreachable or the connection has no real key.
    let balance = 10000
    try {
      const cachedBalance = await getSettings(`connection_balance:${connectionId}`)
      if (cachedBalance?.balance && parseFloat(String(cachedBalance.balance)) > 0) {
        balance = parseFloat(String(cachedBalance.balance))
      } else {
        const connection = await getConnection(connectionId)
        if (
          connection?.api_key &&
          connection?.api_secret &&
          !connection.api_key.includes("PLACEHOLDER") &&
          connection.api_key.length >= 20
        ) {
          const { createExchangeConnector } = await import("@/lib/exchange-connectors")
          const connector = await createExchangeConnector(connection.exchange, {
            apiKey: connection.api_key,
            apiSecret: connection.api_secret,
            apiType: connection.api_type,
            contractType: connection.contract_type,
            isTestnet:
              connection.is_testnet === true || connection.is_testnet === "true",
          })
          try {
            const result = await connector.getBalance()
            if (result?.success && result?.balance && result.balance > 0) {
              balance = result.balance
            }
          } catch {
            // getBalance threw (e.g. 100421 timestamp error) — use the $10k default.
            // Fall through to cache write below so subsequent calls skip the live fetch.
          }
        }
        // Cache the resolved balance (real or fallback) so every subsequent live
        // dispatch in this cycle skips the getBalance() round-trip entirely.
        // TTL: 90 s — short enough that a real balance change is picked up within
        // two minutes, long enough to cover a full 15-symbol cycle at 1 Hz.
        await setSettings(`connection_balance:${connectionId}`, {
          balance,
          updated_at: new Date().toISOString(),
          is_fallback: balance === 10000,
        })
        // Optionally refresh the cache in the background after 90 s to avoid
        // every worker racing for the balance on the same expiry boundary.
        setTimeout(async () => {
          try {
            const { getRedisClient: _rc } = await import("@/lib/redis-db")
            await _rc().del(`settings:connection_balance:${connectionId}`)
          } catch { /* best-effort TTL reset */ }
        }, 90_000)
      }
    } catch {
      // Non-critical — fall back to the $10k default so volume is calculated.
    }

    // No balance-based leverage cap — operator policy is always-max-leverage.
    // The exchange setLeverage call clamps to the per-symbol bracket and the
    // 101204 auto-halve retry handles any remaining margin rejections.
    return { accountBalance: balance, maxLeverage: rawLeverage }
  }

  /**
   * Calculate position volume with risk management (pure math, no DB).
   *
   * BEHAVIOR: minimum volume is ALWAYS enforced — never reject for "qty
   * too small". Three layers:
   *   1. Per-pair `exchangeMinVolume` (from trading_pair metadata)
   *   2. Universal $5-notional floor when no per-pair min is known
   *   3. Numeric safety: if math yields 0/NaN/Infinity (e.g. balance=0
   *      or currentPrice rounding), still emit at least layer 1 or 2.
   *
   * The result is flagged `volumeAdjusted: true` with an
   * `adjustmentReason` explaining the clamp so UI + logs show the user
   * exactly why the quantity doesn't match the pure math.
   */
  static calculatePositionVolume(params: VolumeCalculationParams): VolumeCalculationResult {
    const {
      baseVolumeFactor,
      positionsAverage,
      riskPercentage,
      maxLeverage,
      positionCost,
      accountBalance,
      currentPrice,
      leverage = 1,
      exchangeMinVolume = 0,
      tradeMode,
      mainVolumeFactor,
      presetVolumeFactor,
      sizeMultiplier,
    } = params

    // ── Resolve the engine-specific volume factor (Live-only) ──────
    //
    // Only applied when the CALLER explicitly identifies as a Live trade
    // engine via `tradeMode`. The Strategy stack (Base/Main/Real pseudo
    // positions) never sets `tradeMode`, so it always sees a 1.0
    // identity multiplier here — pseudo positions stay strictly ratio-based per
    // spec ("at Strategies, pseudo pos use ratios for volume calcs").
    //
    // Bounds: [0.1, 10]. A misconfigured 0 or negative collapses the
    // position to zero (the universal $5 floor would clamp back up but
    // we'd still log misleading numbers); a runaway 100× value would
    // silently blow live orders. Clipping here means the slider's UI
    // range (0.1-10x) is also enforced server-side even if a malformed
    // POST bypasses the UI.
    const clampFactor = (raw: number | undefined): number => {
      const n = Number(raw)
      if (!Number.isFinite(n) || n <= 0) return 0.1
      return Math.max(0.1, Math.min(10, n))
    }
    const liveEngineFactor =
      tradeMode === "preset" ? clampFactor(presetVolumeFactor)
      : tradeMode === "main" ? clampFactor(mainVolumeFactor)
      : 1  // Strategy / pseudo-position path → identity (ratio-only)

    // ── Resolve the effective minimum that MUST be honored ──────────
    // A real exchange rule wins exactly. The $5 value is only a fail-safe
    // when no per-pair rule could be loaded; it must never inflate a known
    // venue minimum because the requested policy is true minimum volume.
    const universalMinFromNotional =
      currentPrice > 0
        ? VolumeCalculator.UNIVERSAL_MIN_NOTIONAL_USD / currentPrice
        : 0
    const effectiveMin = exchangeMinVolume > 0 ? exchangeMinVolume : universalMinFromNotional

    /**
     * Final clamp: never return less than `effectiveMin`, never NaN,
     * never Infinity. Used by both the positionCost and the
     * risk-percentage branches below.
     */
    const clampUp = (raw: number): { final: number; adjusted: boolean; reason?: string } => {
      const safeRaw = Number.isFinite(raw) && raw > 0 ? raw : 0
      if (effectiveMin > 0 && safeRaw < effectiveMin) {
        const usingUniversalFallback = exchangeMinVolume <= 0
        return {
          final: effectiveMin,
          adjusted: true,
          reason:
            safeRaw <= 0
              ? `Sizing math yielded ${raw} — clamped up to enforced minimum ${effectiveMin.toFixed(8)} (${usingUniversalFallback ? `universal $${VolumeCalculator.UNIVERSAL_MIN_NOTIONAL_USD} notional fallback` : "exchange minimum"}).`
              : `Calculated volume ${safeRaw.toFixed(8)} was below ${usingUniversalFallback ? `universal $${VolumeCalculator.UNIVERSAL_MIN_NOTIONAL_USD} notional fallback` : "exchange minimum"} ${effectiveMin.toFixed(8)} — clamped up to minimum order size.`,
        }
      }
      return { final: safeRaw, adjusted: false }
    }

    if (positionCost) {
      // ── positions_average + engine factor wired into positionCost ─────
      //
      // Previous formula:
      //   pos_usd = (balance × positionCost) / posAvg
      //
      // New formula (with per-engine volume factor):
      //   pos_usd = (balance × positionCost × liveEngineFactor) / posAvg
      //
      // With positionCost expressed as a fraction of balance (the
      // calling site already converts `pct/100`), the denominator
      // divides total budgeted exposure across the expected concurrent
      // position count. The `liveEngineFactor` (1.0 by default; tunable
      // per Trade Engine — Main vs. Preset — through the Settings
      // dialog) lets operators independently scale the notional of
      // Main-engine orders vs. Preset-engine orders without touching
      // positionCost (which controls the per-position BUDGET share —
      // the two knobs compose).
      //
      // Strategy / pseudo-position calls leave `tradeMode` undefined,
      // so `liveEngineFactor === 1` and this branch behaves identically
      // for them. Only LIVE exchange-order callers see the multiplier
      // — which is exactly the spec: pseudo positions are ratio-only,
      // live positions calculate "indeed volume" (real notional) using
      // the per-engine ratio.
      // ── Adjust-type variant multiplier (Block / DCA) ──────────────────
      // Clamped to [0.1, 5]; absent/invalid → 1.0 (identity).
      // Applied after liveEngineFactor so both multipliers compose:
      //   notional = balance × positionCost × liveEngineFactor × variantMult / posAvg
      const clampVariant = (raw: number | undefined): number => {
        const n = Number(raw)
        if (!Number.isFinite(n) || n <= 0) return 1
        return Math.max(0.1, Math.min(5, n))
      }
      const variantMult = clampVariant(sizeMultiplier)

      const posAvg = positionsAverage && positionsAverage > 0 ? positionsAverage : 1
      const positionSizeUsd = (accountBalance * positionCost * liveEngineFactor * variantMult) / posAvg
      const calculatedVolume = positionSizeUsd / currentPrice
      const { final, adjusted, reason } = clampUp(calculatedVolume)

      // Surface multiplier provenance in the adjustment reason only when
      // the factor actually changed sizing (≠ 1.0) to avoid log spam.
      const factorReason =
        liveEngineFactor !== 1 && tradeMode
          ? `${tradeMode}-engine volume factor ${liveEngineFactor.toFixed(2)}x applied`
          : undefined
      const variantReason =
        variantMult !== 1
          ? `variant size multiplier ${variantMult.toFixed(2)}x applied (Block/DCA adjust-type)`
          : undefined
      const composedReason = [
        adjusted ? reason : undefined,
        factorReason,
        variantReason,
      ].filter(Boolean).join(" | ") || undefined

      return {
        calculatedVolume,
        finalVolume: final,
        volume: final,
        volumeUsd: final * currentPrice,
        leverage,
        volumeAdjusted: adjusted || liveEngineFactor !== 1 || variantMult !== 1,
        adjustmentReason: composedReason,
        intendedNotionalUsd: positionSizeUsd,
        exchangeMinNotionalUsd: effectiveMin * currentPrice,
        accountBalance,
        positionCost,
        positionsAverage: posAvg,
        liveEngineFactor,
        sizeMultiplier: variantMult,
        exchangeMinVolume: effectiveMin,
      }
    }

    if (!riskPercentage || !positionsAverage) {
      throw new Error("riskPercentage and positionsAverage are required when positionCost is not provided")
    }

    const calculatedLeverage = maxLeverage || leverage
    const totalRiskAmount = accountBalance * (riskPercentage / 100)
    const riskPerPosition = totalRiskAmount / positionsAverage
    const adjustedRisk = riskPerPosition * (baseVolumeFactor || 1)
    const positionSize = adjustedRisk / (riskPercentage / 100)
    const rawVolume = positionSize / (currentPrice * calculatedLeverage)

    const { final, adjusted, reason } = clampUp(rawVolume)

    return {
      calculatedVolume: rawVolume,
      finalVolume: final,
      volume: final,
      volumeUsd: final * currentPrice,
      leverage: calculatedLeverage,
      positionSize,
      volumeAdjusted: adjusted,
      adjustmentReason: reason,
      riskAmount: adjustedRisk,
      intendedNotionalUsd: rawVolume * currentPrice,
      exchangeMinNotionalUsd: effectiveMin * currentPrice,
      accountBalance,
      positionCost,
      positionsAverage,
      liveEngineFactor,
      sizeMultiplier: 1,
      exchangeMinVolume: effectiveMin,
    }
  }

  /**
   * Resolve the LIVE engine + scaling factor for a given connection.
   *
   * Used by `calculateVolumeForConnection` when the caller passes
   * `tradeMode` explicitly OR leaves it for auto-resolve from the
   * connection's `is_preset_trade` / `is_live_trade` flags. Two-tier
   * factor stack:
   *
   *   per-connection override (saved by VolumeConfigurationPanel)
   *   > global setting (Settings → Overall → Volume Configuration)
   *   > 0.1 (canonical minimum when unset)
   *
   * Trade-mode resolution from connection flags:
   *   - `is_preset_trade === true` AND `is_live_trade !== true` → "preset"
   *   - else                                                    → "main"
   *
   * Both flags true is unusual but possible during transitions; we
   * pick "main" because it's the conservative default — Preset's
   * factor often applies more aggressive multipliers and we don't
   * want an in-flight toggle to silently up-size existing live orders.
   *
   * Strategy callers (pseudo-position-manager) DO NOT call this helper
   * — they pass NO `tradeMode` to `calculateVolumeForConnection`, so
   * the engine factor never applies to pseudo positions per spec.
   */
  static resolveLiveEngine(
    connection: Record<string, unknown> | null | undefined,
    appSettings: Record<string, unknown> | null | undefined,
  ): { tradeMode: "main" | "preset"; mainVolumeFactor: number; presetVolumeFactor: number } {
    const truthy = (v: unknown) =>
      v === true || v === "true" || v === 1 || v === "1"
    const num = (v: unknown, fallback: number) => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? n : fallback
    }
    const conn = connection || {}
    const app = appSettings || {}

    const isPreset = truthy(conn["is_preset_trade"])
    const isLive   = truthy(conn["is_live_trade"])
    const tradeMode: "main" | "preset" = isPreset && !isLive ? "preset" : "main"

    // Priority stack for the main (live) volume factor:
    //   1. Per-connection override in connection:{id} hash  → `live_volume_factor`
    //   2. Per-connection override in connection_settings:{id} overlay → same key
    //      (when the caller passes the merged settings object as `appSettings`)
    //   3. Global app_settings hash written by migration 034 → `volume_factor_live`
    //   4. Legacy UI-named variant                          → `mainTradeVolumeFactor`
    //   5. Snake-case UI variant                            → `main_trade_volume_factor`
    //   6. Canonical minimum (0.1) when unset
    //
    // Key-name history:
    //   Migration 034 writes `volume_factor_live` to app_settings.
    //   The volume endpoint writes `live_volume_factor` to connection:{id}.
    //   Older UI code may have written `mainTradeVolumeFactor` / `main_trade_volume_factor`.
    //   All variants are tried so every write path resolves correctly.
    const mainVolumeFactor = num(
      conn["live_volume_factor"]
        ?? app["live_volume_factor"]
        ?? app["volume_factor_live"]
        ?? app["mainTradeVolumeFactor"]
        ?? app["main_trade_volume_factor"],
      0.1,
    )

    // Priority stack for the preset volume factor:
    //   1. Per-connection `preset_volume_factor`
    //   2. Global `volume_factor_preset` (migration 034)
    //   3. Legacy UI variants
    //   4. Canonical minimum (0.1) when unset
    const presetVolumeFactor = num(
      conn["preset_volume_factor"]
        ?? app["preset_volume_factor"]
        ?? app["volume_factor_preset"]
        ?? app["presetTradeVolumeFactor"]
        ?? app["preset_trade_volume_factor"],
      0.1,
    )

    return { tradeMode, mainVolumeFactor, presetVolumeFactor }
  }

  /**
   * Calculate volume for a specific connection and symbol using Redis settings.
   *
   * ── `tradeMode` is an explicit, opt-in parameter ───────────────────
   * `calculateVolumeForConnection` is called from BOTH:
   *   - the pseudo-position manager (Strategy stack — ratio-only, MUST
   *     NOT see a volume multiplier per spec), and
   *   - the live-stage executor (real exchange orders — MUST see the
   *     multiplier).
   *
   * Auto-resolving the engine would silently apply the factor to
   * Strategy pseudo positions too, violating the spec. Instead the
   * caller decides:
   *   - Pseudo-position-manager (Strategy): omits `tradeMode` →
   *     `liveEngineFactor = 1` → ratio-only preserved.
   *   - Live-stage: passes `tradeMode: "main" | "preset"` explicitly
   *     (resolved via `resolveLiveEngine` at callsite).
   *
   * This is enforced by the type system: the only way to apply an
   * engine factor is to pass `tradeMode`, which the Strategy stack
   * never does.
   */
  static async calculateVolumeForConnection(
    connectionId: string,
    symbol: string,
    currentPrice: number,
    options: {
      tradeMode?: "main" | "preset"
      // Block/DCA variant multiplier from RealPosition.sizeMultiplier.
      // Absent / undefined → treated as 1.0 (no Block/DCA scaling).
      sizeMultiplier?: number
      // Live-stage margin retries can ask for a concrete leverage target
      // after an exchange-side leverage reduction. This keeps quantity
      // sizing coupled to the new margin target instead of blindly
      // resubmitting the quantity calculated for the original leverage.
      leverageOverride?: number
    } = {},
  ): Promise<VolumeCalculationResult> {
    try {
      await initRedis()
      const client = getRedisClient()

      // Get settings from Redis via the mirror-aware reader. The volume
      // calculator needs `exchangePositionCost`/`positionCost`,
      // `leveragePercentage`, and `useMaximalLeverage` — all of which are
      // managed from the main Settings UI (canonical `app_settings`).
      // Previously this read `system_settings`, which is a different
      // bundle (cleanup schedule, backup toggles) — so the operator's
      // saved leverage/cost never reached volume calculations.
      //
      // Per-connection override: the connection settings dialog can save
      // `leveragePercentage` / `useMaximalLeverage` / `exchangePositionCost`
      // per-connection, mirrored into the `connection_settings:{id}` hash.
      // Overlay any non-empty connection-hash scalar on top of the global
      // app settings so per-connection sizing wins, else inherits global.
      const globalSettings = (await getAppSettings()) || {}
      let connSettings: Record<string, string> = {}
      try {
        connSettings = ((await client.hgetall(`connection_settings:${connectionId}`)) ||
          {}) as Record<string, string>
      } catch {
        connSettings = {}
      }
      const settings: Record<string, unknown> = { ...(globalSettings as Record<string, unknown>) }
      for (const [k, v] of Object.entries(connSettings)) {
        if (v !== undefined && v !== null && v !== "") settings[k] = v
      }
      // ── Position cost resolution ─────────────────────────────────────
      // Priority: connection_settings:{id} overlay (in `settings`)
      //           > connection:{id} record direct field
      //           > global app_settings (also in `settings`)
      //           > built-in default 0.02 (0.02% of balance)
      //
      // `settings` already merges global app_settings + connection_settings
      // overlay so checking `settings` first covers both those sources.
      // We also check the raw connection record fields because operators
      // may set `exchangePositionCost` via updateConnection() which writes
      // to connection:{id} directly without going through connection_settings.
      // The connection record is fetched later (line 494 area) so we keep
      // these as lazy reads from the already-fetched `settings` object here;
      // the raw connection record fields will be merged in below once fetched.
      const positionCostRaw =
        settings.exchangePositionCost ??
        settings.positionCost ??
        settings.exchange_position_cost ??
        "0.02"
      const positionCostPercent = parseFloat(String(positionCostRaw))
      const clampedPositionCostPercent =
        Number.isFinite(positionCostPercent) && positionCostPercent > 0
          ? Math.max(0.02, Math.min(1.0, positionCostPercent))
          : 0.02
      const positionCost = clampedPositionCostPercent / 100  // 0.02% absolute fallback

      // ── Positions-average resolution ─────────────────────────────────
      // Same priority stack: connection_settings overlay → app_settings → default 2.
      const positionsAverage = (() => {
        const raw = parseFloat(String(settings.positions_average ?? settings.positionsAverage ?? "2"))
        return Number.isFinite(raw) && raw > 0 ? raw : 2
      })()

      // Resolve effective leverage:
      //   useMaximalLeverage (default true)  → exchange predefinition max
      //   useMaximalLeverage false            → maxLeverage × (leveragePercentage / 100)
      //
      // Both settings can be set per-connection (connection_settings:{id} hash
      // overlaid on top of app_settings above). This makes the Settings UI
      // controls ("Leverage %", "Max Leverage", "Use Maximal Leverage") actually
      // reach volume calculations.
      //
      // Two downstream safety nets still apply after this:
      //   1. setLeverage(symbol, X) on the connector — venue clamps to per-symbol bracket.
      //   2. The live-stage 101204 auto-halve retry handles margin rejections.
      // ── Single getConnection call ─────────────────────────────────────
      // Fetch the connection record ONCE — reused for exchange type
      // (leverage max lookup) AND for live/preset volume factor resolution.
      // Previously this was called twice (lines 494 and 537), creating a
      // race window and doubling Redis round-trips on every live order.
      //
      // After fetching, we also overlay the connection record's own fields
      // (exchangePositionCost, positionCost, live_volume_factor, etc.) into
      // `settings` so positionCost resolution above uses the correct value
      // if the operator set it via updateConnection() directly.
      const connection = await getConnection(connectionId).catch(() => null)
      if (connection) {
        const CONN_FIELDS_TO_OVERLAY = [
          "exchangePositionCost", "exchange_position_cost", "positionCost",
          "positions_average", "positionsAverage",
          "live_volume_factor", "preset_volume_factor",
          "leveragePercentage", "useMaximalLeverage",
        ] as const
        for (const f of CONN_FIELDS_TO_OVERLAY) {
          const v = (connection as Record<string, unknown>)[f]
          if (v !== undefined && v !== null && v !== "") settings[f] = v
        }
      }
      const exchangeMax   = getMaxLeverageForExchange(connection?.exchange)
      const useMaximal    = settings.useMaximalLeverage === true ||
                            settings.useMaximalLeverage === "true" ||
                            settings.useMaximalLeverage === undefined  // default on
      const levPct        = Math.max(1, Math.min(100, parseFloat(String(settings.leveragePercentage ?? "100"))))
      const overrideLeverage = Number(options.leverageOverride)
      const rawLeverage   = Number.isFinite(overrideLeverage) && overrideLeverage > 0
        ? Math.max(1, Math.floor(overrideLeverage))
        : useMaximal
          ? exchangeMax
          : Math.max(1, Math.round(exchangeMax * (levPct / 100)))

      // Delegate balance-fetch + leverage-cap to the helper method so the
      // logic lives in its own clean scope (no let mutation, no TDZ risk).
      const { accountBalance, maxLeverage } =
        await VolumeCalculator.resolveBalanceAndLeverage(connectionId, rawLeverage)

      // ── Exchange minimum order size from Redis trading-pair metadata ─
      const tradingPair = await getSettings(`trading_pair:${symbol}`)
      let exchangeMinVolume = tradingPair?.min_order_size
        ? parseFloat(tradingPair.min_order_size)
        : undefined
      const ruleAgeMs = tradingPair?.min_order_updated_at
        ? Date.now() - new Date(tradingPair.min_order_updated_at).getTime()
        : Number.POSITIVE_INFINITY
      const needsRuleRefresh =
        !(exchangeMinVolume && exchangeMinVolume > 0) ||
        tradingPair?.min_order_source !== "bingx-contracts-v2" ||
        !Number.isFinite(ruleAgeMs) ||
        ruleAgeMs > 60 * 60_000

      if (needsRuleRefresh) {
        try {
          const { resolveExchangeMinimum } = await import("@/lib/exchange-contract-rules")
          const minimumRule = await resolveExchangeMinimum(connection?.exchange, symbol, currentPrice)
          exchangeMinVolume = minimumRule.quantity
          await setSettings(`trading_pair:${symbol}`, {
            ...(tradingPair || {}),
            min_order_size: minimumRule.quantity,
            quantity_step_size: minimumRule.stepSize,
            quantity_precision: minimumRule.quantityPrecision,
            min_order_notional: minimumRule.minNotional,
            min_order_source: minimumRule.source,
            min_order_updated_at: new Date().toISOString(),
          })
        } catch (error) {
          console.warn(`[VolumeCalculator] Could not refresh exchange minimum for ${symbol}:`, error)
        }
      }

      // ── Resolve engine factor IFF caller asked for it ──────────────
      //
      // We only do the connection-flag resolution when the caller
      // passed `options.tradeMode`. The pseudo-position-manager call
      // omits it, so this entire block is skipped for Strategy callers
      // — they go through with no engine multiplier (the in-place
      // ratio-only behaviour the spec requires).
      //
      // Live-stage callers pass tradeMode: "main" | "preset" explicitly.
      // Strategy callers omit it → liveEngineFactor stays 1.0.
      let resolvedMode: "main" | "preset" | undefined = options.tradeMode
      let mainVolumeFactor = 0.1
      let presetVolumeFactor = 0.1
      if (resolvedMode === "main" || resolvedMode === "preset") {
        // Pass BOTH the connection record (has live_volume_factor written
        // by the volume endpoint) AND the merged settings object (has
        // live_volume_factor from connection_settings overlay + global
        // volume_factor_live from app_settings) so resolveLiveEngine
        // can find the factor from whichever write path was used.
        const resolved = VolumeCalculator.resolveLiveEngine(connection, settings)
        mainVolumeFactor = resolved.mainVolumeFactor
        presetVolumeFactor = resolved.presetVolumeFactor
        // We honour the CALLER's explicit mode; resolveLiveEngine's
        // tradeMode result is informational here (used only when the
        // caller did not specify).
      }

      const result = this.calculatePositionVolume({
        positionCost,
        positionsAverage,
        accountBalance,
        currentPrice,
        leverage: maxLeverage,
        exchangeMinVolume,
        tradeMode: resolvedMode,
        mainVolumeFactor,
        presetVolumeFactor,
        // Variant multiplier forwarded from the callsite (Block/DCA sizing).
        sizeMultiplier: options.sizeMultiplier,
      })

      return result
    } catch (error) {
      console.error("[v0] Failed to calculate volume for connection:", error)
      throw error
    }
  }

  /**
   * Log volume calculation to Redis
   */
  static async logVolumeCalculation(
    connectionId: string,
    symbol: string,
    calculation: VolumeCalculationResult,
  ): Promise<void> {
    try {
      await initRedis()
      const client = getRedisClient()
      const logId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const logKey = `volume_calc:${connectionId}:${logId}`

      await client.set(logKey, JSON.stringify({
        connection_id: connectionId,
        symbol,
        leverage: calculation.leverage,
        calculated_volume: calculation.calculatedVolume,
        final_volume: calculation.finalVolume || calculation.volume,
        volume_usd: calculation.volumeUsd,
        volume_adjusted: calculation.volumeAdjusted,
        adjustment_reason: calculation.adjustmentReason || null,
        intended_notional_usd: calculation.intendedNotionalUsd,
        exchange_min_notional_usd: calculation.exchangeMinNotionalUsd,
        account_balance: calculation.accountBalance,
        position_cost: calculation.positionCost,
        positions_average: calculation.positionsAverage,
        live_engine_factor: calculation.liveEngineFactor,
        size_multiplier: calculation.sizeMultiplier,
        created_at: new Date().toISOString(),
      }))

      // Store in Redis list instead of sorted set (Upstash doesn't support zadd)
      const volumeCalcsKey = `volume_calcs:${connectionId}`
      let volumeCalcs: string[] = []
      
      const existing = await client.get(volumeCalcsKey)
      if (existing) {
        try { volumeCalcs = JSON.parse(existing) } catch { volumeCalcs = [] }
      }
      
      // Prepend new entry
      volumeCalcs.unshift(logId)
      
      // Trim to max 500 entries
      if (volumeCalcs.length > 500) {
        volumeCalcs = volumeCalcs.slice(0, 500)
      }
      
      await client.set(volumeCalcsKey, JSON.stringify(volumeCalcs))
    } catch (error) {
      console.error("[v0] Failed to log volume calculation:", error)
    }
  }

  /**
   * Get volume calculation history from Redis
   */
  static async getVolumeHistory(connectionId: string, _symbol?: string, limit = 100) {
    try {
      await initRedis()
      const client = getRedisClient()

      // Get recent log IDs from list (prepended order, so slice from beginning)
      const volumeCalcsKey = `volume_calcs:${connectionId}`
      const existing = await client.get(volumeCalcsKey)
      
      let logIds: string[] = []
      if (existing) {
        try { logIds = JSON.parse(existing) } catch { logIds = [] }
      }
      
      if (!logIds || logIds.length === 0) return []

      // Take most recent entries (first in list)
      const recentIds = logIds.slice(0, Math.min(limit, logIds.length))
      
      const history = []
      for (const logId of recentIds) {
        const data = await client.get(`volume_calc:${connectionId}:${logId}`)
        if (data) {
          const parsed = typeof data === "string" ? JSON.parse(data) : data
          if (!_symbol || parsed.symbol === _symbol) {
            history.push(parsed)
          }
        }
      }

      return history.slice(0, limit)
    } catch (error) {
      console.error("[v0] Failed to get volume history:", error)
      return []
    }
  }

  /**
   * Calculate risk metrics for a position (pure math, no DB)
   */
  static calculateRiskMetrics(params: {
    entryPrice: number
    currentPrice: number
    volume: number
    leverage: number
    side: "long" | "short"
    stopLossPrice?: number
    takeProfitPrice?: number
  }) {
    const { entryPrice, currentPrice, volume, leverage, side, stopLossPrice, takeProfitPrice } = params

    const positionValue = volume * currentPrice

    let unrealizedPnL = 0
    if (side === "long") {
      unrealizedPnL = (currentPrice - entryPrice) * volume * leverage
    } else {
      unrealizedPnL = (entryPrice - currentPrice) * volume * leverage
    }

    const unrealizedPnLPercent = (unrealizedPnL / (entryPrice * volume)) * 100

    let potentialLoss = 0
    if (stopLossPrice) {
      if (side === "long") {
        potentialLoss = (stopLossPrice - entryPrice) * volume * leverage
      } else {
        potentialLoss = (entryPrice - stopLossPrice) * volume * leverage
      }
    }

    let potentialProfit = 0
    if (takeProfitPrice) {
      if (side === "long") {
        potentialProfit = (takeProfitPrice - entryPrice) * volume * leverage
      } else {
        potentialProfit = (entryPrice - takeProfitPrice) * volume * leverage
      }
    }

    let riskRewardRatio = 0
    if (potentialLoss !== 0) {
      riskRewardRatio = Math.abs(potentialProfit / potentialLoss)
    }

    return {
      positionValue,
      unrealizedPnL,
      unrealizedPnLPercent,
      potentialLoss,
      potentialProfit,
      riskRewardRatio,
    }
  }
}
