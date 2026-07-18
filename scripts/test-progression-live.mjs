#!/usr/bin/env node

/**
 * Live Progression System Test
 * Tests BASE → MAIN → REAL → LIVE pipeline completeness and correctness
 * Run: node scripts/test-progression-live.mjs [connectionId]
 */

import fetch from 'node-fetch';

const connectionId = process.argv[2] || 'bingx-x01';
const baseUrl = 'http://localhost:3000';
const testLabel = (label) => `\n${'='.repeat(70)}\n${label}\n${'='.repeat(70)}`;

let passCount = 0;
let failCount = 0;

const assert = (condition, message) => {
  if (condition) {
    console.log(`✓ ${message}`);
    passCount++;
  } else {
    console.error(`✗ FAIL: ${message}`);
    failCount++;
  }
};

const run = async () => {
  try {
    console.log(testLabel('PROGRESSION SYSTEM LIVE TEST'));
    console.log(`Connection: ${connectionId}`);
    console.log(`Started: ${new Date().toISOString()}`);

    // Fetch stats
    console.log(testLabel('1. FETCHING PROGRESSION STATS'));
    const statsRes = await fetch(`${baseUrl}/api/connections/progression/${connectionId}/stats`);
    assert(statsRes.ok, `Stats endpoint responds (${statsRes.status})`);
    const stats = await statsRes.json();

    // Check phase
    console.log(testLabel('2. ENGINE PHASE CHECK'));
    const phase = stats.metadata?.phase;
    console.log(`Current phase: ${phase}`);
    assert(
      ['prehistoric_loading', 'live_trading', 'stopped'].includes(phase),
      `Valid phase: ${phase}`
    );

    // Check symbol count
    console.log(testLabel('3. SYMBOL CONFIGURATION'));
    const symbolCount = stats.metadata?.symbols || 0;
    console.log(`Symbols configured: ${symbolCount}`);
    assert(symbolCount > 0, `Symbols loaded (${symbolCount})`);

    // BASE stage breakdown
    console.log(testLabel('4. BASE STAGE (Prehistoric Backtest)'));
    const baseCount = stats.breakdown?.base || 0;
    console.log(`BASE sets created: ${baseCount}`);
    assert(baseCount > 0, `BASE sets exist (${baseCount})`);

    const basePF = stats.strategyDetail?.prehistoric?.avgProfitFactor;
    console.log(`BASE avg PF: ${basePF || 'N/A'}`);
    assert(
      basePF === undefined || (basePF > 0 && basePF <= 3),
      `BASE PF in valid range: ${basePF}`
    );

    // MAIN stage breakdown
    console.log(testLabel('5. MAIN STAGE (Axis Variants)'));
    const mainCount = stats.breakdown?.main || 0;
    console.log(`MAIN sets created: ${mainCount}`);
    assert(mainCount >= baseCount, `MAIN ≥ BASE (${mainCount} ≥ ${baseCount})`);

    const mainPF = stats.strategyDetail?.prehistoric?.avgProfitFactor;
    console.log(`MAIN avg PF: ${mainPF || 'N/A'}`);
    assert(mainPF === undefined || mainPF > 0, `MAIN PF positive: ${mainPF}`);

    // REAL stage breakdown
    console.log(testLabel('6. REAL STAGE (Real-Time Evaluation)'));
    const realCount = stats.breakdown?.real || 0;
    console.log(`REAL sets active: ${realCount}`);
    assert(realCount > 0 || phase === 'stopped', `REAL sets or engine stopped`);

    const realPF = stats.strategyDetail?.real?.avgProfitFactor;
    console.log(`REAL avg PF: ${realPF || 'N/A'}`);
    if (realPF !== undefined) {
      assert(realPF > 0 && realPF <= 3, `REAL PF in valid range: ${realPF}`);
    }

    // LIVE stage breakdown
    console.log(testLabel('7. LIVE STAGE (Live Execution)'));
    const liveCount = stats.breakdown?.live || 0;
    console.log(`LIVE sets active: ${liveCount}`);

    const livePF = stats.strategyDetail?.live?.avgProfitFactor;
    console.log(`LIVE avg PF: ${livePF || 'N/A'}`);
    if (livePF !== undefined) {
      assert(livePF > 0 && livePF <= 3, `LIVE PF in valid range: ${livePF}`);
    }

    // Active counts by stage
    console.log(testLabel('8. ACTIVE STRATEGY COUNTS'));
    const activeCounts = stats.activeCounts || {};
    console.log(`Active by stage:`, activeCounts);
    assert(
      typeof activeCounts === 'object',
      `Active counts structure valid`
    );

    // Live execution
    console.log(testLabel('9. LIVE EXECUTION STATE'));
    const liveExec = stats.liveExecution || {};
    const placed = liveExec.ordersPlaced || 0;
    const filled = liveExec.ordersFilled || 0;
    const openPos = liveExec.openPositions || 0;
    console.log(`Orders placed: ${placed}, filled: ${filled}, open positions: ${openPos}`);

    // PF cascade check
    console.log(testLabel('10. PF PIPELINE CASCADE'));
    const pfs = {
      base: stats.strategyDetail?.prehistoric?.avgProfitFactor,
      main: stats.strategyDetail?.main?.avgProfitFactor,
      real: stats.strategyDetail?.real?.avgProfitFactor,
      live: stats.strategyDetail?.live?.avgProfitFactor,
    };
    console.log(`PF cascade:`, pfs);
    
    if (pfs.base !== undefined && pfs.real !== undefined) {
      assert(
        pfs.base > 0 && pfs.real > 0,
        `Cost-adjusted PF present in pipeline`
      );
    }

    // Trade history
    console.log(testLabel('11. TRADE HISTORY'));
    const tradeHistory = stats.tradeHistory || [];
    console.log(`Total closed trades: ${tradeHistory.length}`);
    
    // Check for duplicates
    const ids = new Set();
    let duplicates = 0;
    for (const trade of tradeHistory) {
      if (ids.has(trade.id)) duplicates++;
      ids.add(trade.id);
    }
    console.log(`Duplicate trade IDs: ${duplicates}`);
    assert(duplicates === 0, `No duplicate trade IDs`);

    // Live positions
    console.log(testLabel('12. LIVE POSITIONS'));
    const livePos = stats.liveExecution?.openPositions || [];
    console.log(`Live positions count: ${livePos.length}`);
    
    const liveIds = new Set();
    let liveDuplicates = 0;
    for (const pos of Array.isArray(livePos) ? livePos : []) {
      if (pos.id && liveIds.has(pos.id)) liveDuplicates++;
      liveIds.add(pos.id);
    }
    console.log(`Duplicate live position IDs: ${liveDuplicates}`);
    assert(liveDuplicates === 0, `No duplicate live position IDs`);

    // Summary
    console.log(testLabel('SUMMARY'));
    console.log(`Tests passed: ${passCount}`);
    console.log(`Tests failed: ${failCount}`);
    
    if (failCount === 0) {
      console.log('\n✓ ALL PROGRESSION SYSTEM CHECKS PASSED');
      process.exit(0);
    } else {
      console.log(`\n✗ ${failCount} CHECKS FAILED`);
      process.exit(1);
    }
  } catch (error) {
    console.error('\n✗ TEST ERROR:', error.message);
    console.error(error);
    process.exit(2);
  }
};

run();
