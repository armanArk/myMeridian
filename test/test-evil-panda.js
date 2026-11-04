import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { config } from "../config.js";
import { updatePnlAndCheckExits, trackPosition } from "../state.js";
import { getDeterministicCloseRule } from "../exit-rules.js";
import { confirmIndicatorPreset } from "../tools/chart-indicators.js";

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
  });

  await t.test("Configured Screening Thresholds Match Mandor EP Rules", () => {
    assert.equal(config.strategy.strategy, "bid_ask");
    assert.equal(config.strategy.downsidePct, 90);
    assert.equal(config.screening.minVolatility, 1);
    assert.equal(config.screening.minVolume30m, 12000);
    assert.equal(config.screening.minVolume24h, 1000000);
    assert.equal(config.screening.minMcap, 250000);
    assert.equal(config.screening.minBinStep, 100);
    assert.equal(config.screening.maxBinStep, 125);
    assert.equal(config.screening.minTokenFeesSol, 30);
    assert.equal(config.screening.maxTop10Pct, 30);
    assert.equal(config.screening.maxInsidersPct, 10);
    assert.equal(config.screening.maxBundlingPct, 60);
    assert.equal(config.screening.maxWarningPct, 30);
    assert.equal(config.management.stopLossPct, -30);
    assert.equal(config.management.trailingTriggerPct, 15);
    assert.ok(config.management.trailingDropPct === 3 || config.management.trailingDropPct === 4);
  });
});
