import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { config } from "../config.js";
import { updatePnlAndCheckExits, trackPosition } from "../state.js";
import { getDeterministicCloseRule } from "../exit-rules.js";
import { confirmIndicatorPreset, evaluatePreset } from "../tools/chart-indicators.js";

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

    // Test supertrend_break requires fresh breakout (supertrendBreakUp === true)
    const freshBreakPayload = {
      latest: {
        states: { supertrendBreakUp: true, supertrendDirection: "bullish" },
        indicators: { close: 0.05, rsi: 50 },
      },
    };
    const freshRes = evaluatePreset("entry", "supertrend_break", freshBreakPayload);
    assert.equal(freshRes.confirmed, true, "Fresh break must be confirmed");

    const oldTrendPayload = {
      latest: {
        states: { supertrendBreakUp: false, supertrendDirection: "bullish" },
        indicators: { close: 0.05, supertrend: 0.04, rsi: 50 },
      },
    };
    const oldRes = evaluatePreset("entry", "supertrend_break", oldTrendPayload);
    assert.equal(oldRes.confirmed, false, "Already green without fresh break must NOT be confirmed");

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
    assert.equal(config.strategy.strategy, "bid_ask");
    assert.equal(config.strategy.downsidePct, 90);
    assert.equal(config.screening.minVolatility, 1);
    assert.equal(config.screening.minVolume30m, 12000);
    assert.equal(config.screening.minVolume24h, 1000000);
    assert.ok(config.screening.minMcap === 250000 || config.screening.minMcap === 500000);
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
});
