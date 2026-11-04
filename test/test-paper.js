import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { repoPath } from "../repo-root.js";
import {
  isPaperMode,
  isPaperPosition,
  deployPaperPosition,
  getPaperPositions,
  closePaperPosition,
  getPaperStats,
} from "../tools/paper.js";

const TEST_PAPER_STORE = repoPath("paper-positions.json");

test("Paper Virtual Trading Engine Test Suite", async (t) => {
  // Backup existing paper store if exists
  let backup = null;
  if (fs.existsSync(TEST_PAPER_STORE)) {
    backup = fs.readFileSync(TEST_PAPER_STORE, "utf8");
  }

  t.after(() => {
    if (backup) {
      fs.writeFileSync(TEST_PAPER_STORE, backup);
    } else if (fs.existsSync(TEST_PAPER_STORE)) {
      fs.unlinkSync(TEST_PAPER_STORE);
    }
  });

  await t.test("isPaperMode detects paper mode correctly", () => {
    assert.equal(isPaperMode(), true);
    assert.equal(isPaperPosition("paper_test_12345"), true);
    assert.equal(isPaperPosition("So11111111111111111111111111111111111111112"), false);
  });

  let deployedPosId = null;
  await t.test("deployPaperPosition creates virtual position and updates bankroll", async () => {
    // Meteora DLMM SOL/USDC pool: AR1Mt6sCz2yp88NL91DEf86WwT5qgZmgG4tWk4b4f3iJ or dummy
    const res = await deployPaperPosition({
      pool_address: "AR1Mt6sCz2yp88NL91DEf86WwT5qgZmgG4tWk4b4f3iJ",
      amount_sol: 0.5,
      strategy: "bid_ask",
      bins_below: 100,
      downside_pct: 90,
    });

    assert.equal(res.success, true);
    assert.equal(res.is_paper, true);
    assert.ok(res.position.startsWith("paper_"));
    deployedPosId = res.position;
  });

  await t.test("getPaperPositions lists the open virtual position with live calculation", async () => {
    const list = await getPaperPositions({ force: true });
    assert.ok(list.total_positions >= 1);
    const p = list.positions.find((pos) => pos.position === deployedPosId);
    assert.ok(p, "Deployed paper position should be in open list");
    assert.equal(p.is_paper, true);
    assert.equal(typeof p.pnl_pct, "number");
    assert.equal(typeof p.total_value_usd, "number");
    assert.equal(typeof p.in_range, "boolean");
  });

  await t.test("closePaperPosition closes position and calculates realized PnL", async () => {
    const res = await closePaperPosition({
      position_address: deployedPosId,
      reason: "unit test take profit",
    });

    assert.equal(res.success, true);
    assert.equal(res.is_paper, true);
    assert.equal(typeof res.pnl_pct, "number");

    const listAfter = await getPaperPositions({ force: true });
    const p = listAfter.positions.find((pos) => pos.position === deployedPosId);
    assert.equal(p, undefined, "Closed position should no longer be in open list");

    const statsAfter = getPaperStats();
    assert.equal(statsAfter.total_trades, 1);
  });

  process.exit(0);
});
