import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { config } from "../config.js";
import { updatePnlAndCheckExits, trackPosition } from "../state.js";
import { getDeterministicCloseRule } from "../exit-rules.js";
import { confirmIndicatorPreset, evaluatePreset, computeStochRsi } from "../tools/chart-indicators.js";
import { getRawPoolScreeningRejectReason } from "../tools/screening.js";
import { isHiveMindEnabled, getSharedLessonsForPrompt } from "../hivemind.js";

test("Evil Panda Strategy Rules Verification", async (t) => {
  await t.test("Exit Rules - Stop Loss at -30%", () => {
    trackPosition({
      position: "test_pos_sl",
      pool: "fake_pool",
      pool_name: "TEST/SOL",
      strategy: "bid_ask",
      amount_sol: 0.5,
    });
    const fakePosition = {
      pnl_pct: -30.5,
      in_range: true,
      total_value_usd: 50,
      pair: "TEST/SOL",
    };
    const res = updatePnlAndCheckExits("test_pos_sl", fakePosition, config.management);
    assert.ok(res, "Should trigger exit at -30.5% PnL");
    assert.equal(res.action, "STOP_LOSS");
    assert.equal(res.trigger, "sl_hit");
    const state = JSON.parse(fs.readFileSync(new URL("../state.json", import.meta.url), "utf8"));
    delete state.positions["test_pos_sl"];
    fs.writeFileSync(new URL("../state.json", import.meta.url), JSON.stringify(state, null, 2));
  });

  await t.test("Exit Rules - Trailing Take Profit (trigger 15%, drop 4%)", () => {
    trackPosition({
      position: "test_pos_trailing",
      pool: "fake_pool",
      pool_name: "TEST/SOL",
      strategy: "bid_ask",
      amount_sol: 0.5,
    });
    // 1. Position at +16% (activates trailing TP)
    const posPeak = {
      pnl_pct: 16.0,
      in_range: true,
      total_value_usd: 120,
      pair: "TEST/SOL",
    };
    updatePnlAndCheckExits("test_pos_trailing", posPeak, config.management);

    // 2. Position drops to +11.5% (drop of 4.5% >= 4%)
    const posDrop = {
      pnl_pct: 11.5,
      in_range: true,
      total_value_usd: 115,
      pair: "TEST/SOL",
    };
    const res = updatePnlAndCheckExits("test_pos_trailing", posDrop, config.management);
    assert.ok(res, "Should trigger trailing TP exit");
    assert.equal(res.action, "TRAILING_TP");
    assert.equal(res.trigger, "trailing_tp");
    const state = JSON.parse(fs.readFileSync(new URL("../state.json", import.meta.url), "utf8"));
    delete state.positions["test_pos_trailing"];
    fs.writeFileSync(new URL("../state.json", import.meta.url), JSON.stringify(state, null, 2));
  });

  await t.test("Indicator Preset evil_panda_exit logic", () => {
    // Test chart-indicators evil_panda_exit evaluations
    const mockExitPreset = config.indicators.exitPreset;
    assert.equal(mockExitPreset, "evil_panda_exit");
    assert.equal(config.indicators.rsiLength, 2);

    // Test supertrend_break allows fresh breakout OR ongoing bullish price above Supertrend
    const freshBreakPayload = {
      latest: {
        states: { supertrendBreakUp: true, supertrendDirection: "bullish" },
        candle: { close: 0.05 },
        supertrend: { direction: "bullish", value: 0.04 },
      },
    };
    const freshRes = evaluatePreset("entry", "supertrend_break", freshBreakPayload);
    assert.equal(freshRes.confirmed, true, "Fresh break must be confirmed");

    const ongoingBullishPayload = {
      latest: {
        states: { supertrendBreakUp: false, supertrendDirection: "bullish" },
        candle: { close: 0.05 },
        supertrend: { direction: "bullish", value: 0.04 },
      },
    };
    const ongoingRes = evaluatePreset("entry", "supertrend_break", ongoingBullishPayload);
    assert.equal(ongoingRes.confirmed, true, "Ongoing bullish above Supertrend must be confirmed");

    const priceBelowSupertrendPayload = {
      latest: {
        states: { supertrendBreakUp: false, supertrendDirection: "bullish" },
        candle: { close: 0.035 },
        supertrend: { direction: "bullish", value: 0.04 },
      },
    };
    const belowRes = evaluatePreset("entry", "supertrend_break", priceBelowSupertrendPayload);
    assert.equal(belowRes.confirmed, false, "Bullish but price below line must NOT be confirmed");

    const bearishPayload = {
      latest: {
        states: { supertrendBreakUp: false, supertrendDirection: "bearish" },
        candle: { close: 0.05 },
        supertrend: { direction: "bearish", value: 0.06 },
      },
    };
    const bearishRes = evaluatePreset("entry", "supertrend_break", bearishPayload);
    assert.equal(bearishRes.confirmed, false, "Bearish Supertrend must NOT be confirmed");

    // Test evil_panda_exit bypass triggers at RSI >= 90
    const overboughtPayload = {
      latest: {
        candle: { close: 0.05 },
        rsi: { value: 94.5 },
        supertrend: { direction: "bullish" },
      },
    };
    const exitRes = evaluatePreset("exit", "evil_panda_exit", overboughtPayload);
    assert.equal(exitRes.confirmed, true);
    assert.equal(exitRes.trigger, "bypass_rsi");
  });

  await t.test("Mandor Rule - StochRSI Computation & Recovery Exit Condition", () => {
    // 1. Test StochRSI calculation on synthetic RSI series
    // Window of 15 values where min is 20, max is 80, and latest is 80 -> StochRSI raw should be 100
    const rsiSeries = [
      { value: 50 }, { value: 40 }, { value: 30 }, { value: 20 }, { value: 25 },
      { value: 35 }, { value: 45 }, { value: 55 }, { value: 65 }, { value: 70 },
      { value: 75 }, { value: 78 }, { value: 79 }, { value: 80 }, { value: 80 }
    ];
    const stoch = computeStochRsi(rsiSeries, 14, 3);
    assert.ok(stoch != null);
    assert.equal(stoch.raw, 100);
    assert.ok(stoch.k >= 90);

    // 2. Test Mandor Recovery Condition logic:
    // "jika PnL pernah sentuh -10%, boleh exit jika nanti stochrsi 90 dan pnl sentuh +3%"
    function checkMandorRecovery(maxDrawdown, currentPnl, stochRsiK) {
      return maxDrawdown <= -10 && currentPnl >= 3 && stochRsiK != null && stochRsiK >= 90;
    }

    // Scenario A: Drawdown -14%, bounced to +3.5%, StochRSI 92 -> Qualifies for recovery exit!
    assert.equal(checkMandorRecovery(-14, 3.5, 92), true);

    // Scenario B: Drawdown only -6%, bounced to +3.5%, StochRSI 92 -> Does NOT qualify (never hit -10%)
    assert.equal(checkMandorRecovery(-6, 3.5, 92), false);

    // Scenario C: Drawdown -14%, current PnL only +1.8%, StochRSI 92 -> Does NOT qualify (not yet +3%)
    assert.equal(checkMandorRecovery(-14, 1.8, 92), false);

    // Scenario D: Drawdown -14%, bounced to +3.5%, StochRSI 75 -> Does NOT qualify (StochRSI < 90)
    assert.equal(checkMandorRecovery(-14, 3.5, 75), false);
  });

  await t.test("Exit Rules - OOR Above (relaxed to 24h) vs OOR Below (cut at limit)", () => {
    const posId = "test_pos_oor";
    const stateUrl = new URL("../state.json", import.meta.url);
    trackPosition({
      position: posId,
      pool: "fake_pool",
      pool_name: "OOR-SOL",
      strategy: "bid_ask",
      bin_range: { min: -500, max: -300, active: -300 },
    });

    // Simulate position that went OOR 90 minutes ago
    const state = JSON.parse(fs.readFileSync(stateUrl, "utf8"));
    state.positions[posId].out_of_range_since = new Date(Date.now() - 90 * 60 * 1000).toISOString();
    fs.writeFileSync(stateUrl, JSON.stringify(state, null, 2));

    const mgmt = {
      outOfRangeWaitMinutes: 60,
      outOfRangeAboveWaitMinutes: 1440,
      stopLossPct: -30,
    };

    // Scenario 1: Active bin is -250 (ABOVE upperBin -300) -> OOR Above
    // Should NOT trigger OUT_OF_RANGE because 90m < 1440m limit!
    const posAbove = {
      position: posId,
      active_bin: -250,
      upper_bin: -300,
      lower_bin: -500,
      in_range: false,
      pnl_pct: 0,
    };
    const resAbove = updatePnlAndCheckExits(posId, posAbove, mgmt);
    assert.equal(resAbove, null);

    // Scenario 2: Active bin is -550 (BELOW lowerBin -500) -> OOR Below
    // SHOULD trigger OUT_OF_RANGE because 90m >= 60m limit!
    const posBelow = {
      position: posId,
      active_bin: -550,
      upper_bin: -300,
      lower_bin: -500,
      in_range: false,
      pnl_pct: -15,
    };
    const resBelow = updatePnlAndCheckExits(posId, posBelow, mgmt);
    assert.ok(resBelow);
    assert.equal(resBelow.action, "OUT_OF_RANGE");

    const cleanState = JSON.parse(fs.readFileSync(stateUrl, "utf8"));
    delete cleanState.positions[posId];
    fs.writeFileSync(stateUrl, JSON.stringify(cleanState, null, 2));
  });

  await t.test("Configured Screening Thresholds Match Mandor EP Rules", () => {
    assert.equal(config.strategy.strategy, "spot");
    assert.equal(config.strategy.downsidePct, 90);
    assert.equal(config.screening.minVolatility, 1);
    assert.equal(config.screening.minVolume30m, 12000);
    assert.equal(config.screening.minVolume24h, 1000000);
    assert.ok(config.screening.minMcap >= 250000, "minMcap should be at least 250k");
    assert.equal(config.screening.minBinStep, 100);
    assert.equal(config.screening.maxBinStep, 125);
    assert.equal(config.screening.minTokenFeesSol, 30);
    assert.equal(config.screening.maxTop10Pct, 30);
    assert.ok(config.screening.maxInsidersPct === 25 || config.screening.maxInsidersPct === 10);
    assert.equal(config.screening.maxBundlingPct, 60);
    assert.equal(config.screening.maxWarningPct, 30);
    assert.equal(config.management.stopLossPct, -30);
    assert.equal(config.management.trailingTriggerPct, 15);
    assert.ok(config.management.trailingDropPct === 3 || config.management.trailingDropPct === 4);
    assert.equal(config.management.outOfRangeAboveWaitMinutes, 1440);
  });

  await t.test("Cost Optimization - Dev Tax / Jupiter Referral Fee Disabled", () => {
    assert.equal(config.jupiter.referralAccount, "", "Referral account should be empty");
    assert.equal(config.jupiter.referralFeeBps, 0, "Referral fee bps should be 0");
  });

  await t.test("Screening - Mandor Mandatory 30m Volume & 24h Volume Rules", () => {
    const s = {
      ...config.screening,
      minVolume30m: 12000,
      minVolume24h: 1000000,
      minTvl: 50000,
      minBinStep: 100,
      maxBinStep: 125,
      minMcap: 250000,
      requireSolQuote: true,
      timeframe: "30m",
    };

    const baseGoodPool = {
      token_x: { symbol: "GOOD", address: "GoodMint", market_cap: 1000000, organic_score: 80, created_at: Date.now() - 48 * 3600000 },
      token_y: { symbol: "SOL", address: "So11111111111111111111111111111111111111112", organic_score: 90 },
      pool_type: "dlmm",
      dlmm_params: { bin_step: 100 },
      tvl: 100000,
      active_tvl: 80000,
      volatility: 2.5,
      base_token_holders: 2000,
      volume: 15000,
      volume_30m: 15000,
      volume_24h: 1500000,
    };

    // 1. Perfectly qualified pool passes
    assert.equal(getRawPoolScreeningRejectReason(baseGoodPool, s), null);

    // 2. Dead 30m volume MUST FAIL even if 24h volume is huge ($10M)
    const dead30mPool = {
      ...baseGoodPool,
      volume_30m: 2000,
      volume_24h: 10000000,
    };
    const resDead = getRawPoolScreeningRejectReason(dead30mPool, s);
    assert.ok(resDead && resDead.includes("30m volume"));

    // 3. Fresh viral token (< 24h old) with strong 30m volume passes even if 24h vol is under $1M
    const freshViralPool = {
      ...baseGoodPool,
      token_x: { ...baseGoodPool.token_x, created_at: Date.now() - 4 * 3600000 }, // 4h old
      volume_30m: 25000,
      volume_24h: 400000, // not yet $1M because it's only 4h old
    };
    assert.equal(getRawPoolScreeningRejectReason(freshViralPool, s), null);

    // 4. Mature token (>= 24h old) with good 30m volume but low 24h volume (< 1M) fails 24h volume rule
    const matureLow24hPool = {
      ...baseGoodPool,
      token_x: { ...baseGoodPool.token_x, created_at: Date.now() - 72 * 3600000 }, // 3 days old
      volume_30m: 15000,
      volume_24h: 300000, // under $1M
    };
    const resLow24h = getRawPoolScreeningRejectReason(matureLow24hPool, s);
    assert.ok(resLow24h && resLow24h.includes("24h volume"));
  });

  await t.test("Quality & Privacy Optimization - HiveMind Disabled", () => {
    assert.equal(config.hiveMind.enabled, false, "HiveMind config enabled should be false");
    assert.equal(isHiveMindEnabled(), false, "isHiveMindEnabled() should return false");
    assert.equal(getSharedLessonsForPrompt(), null, "getSharedLessonsForPrompt() should return null");
  });
});
