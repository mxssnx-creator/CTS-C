# Preserve venue quote age

Reviewed target: `02d00943a7184bbfb78479b6a10c2d6f182862da`.

The ticker adapter previously replaced a missing or invalid `time`/`timestamp`
with the local clock. That manufactured an apparently fresh quote from a price
whose actual age was unknown. It could therefore pass runtime's existing
15-second stale-price check. Runtime also lacked an explicit timestamp validity
check for custom clients: `NaN` and missing values could reach minute aggregation
and invalidate otherwise sound readiness.

The adapter now excludes quotes without a positive safe-integer venue timestamp.
Valid `time` and `timestamp` aliases, including numeric strings, keep the exact
venue value. Stale or future valid timestamps are not refreshed or hidden by the
adapter; runtime applies its existing 15-second age and five-second future-skew
limits. Runtime independently rejects invalid timestamps before marks, minute
bars or model ticks are changed.

The final focused fixture has 25 tests. Its two new failure cases reproduce on
the unchanged target; all 25 pass after the fix. The timestamp-alias/age control
also passes before the change. The complete `npm run check` passes with 271 tests,
zero failed/skipped, typecheck, production build and runtime smoke. Required
hosted checks must pass at the exact publication head before merge.

This correction changes quote validation, not historical candle replay, costs,
SL/trailing distances or qualification gates. The earlier twelve-symbol replay's
negative Live-model PF remains unchanged and is not relabeled as a profitable
result. No funded test or current own-exposure clearance is established here.
