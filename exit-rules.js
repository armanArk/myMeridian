// Deterministic exit sizing rules shared by the legacy manager and the
// standalone runtime. No LLM input — these run identically in both modes.

import { config } from "./config.js";
import { log } from "./logger.js";
import { getTrackedPosition } from "./state.js";

/**
 * Rule-based close decision for a position (stop loss, take profit, range
 * exhaustion, low yield). Returns { action: "CLOSE", rule, reason } or null.
 */
export function getDeterministicCloseRule(position, managementConfig) {
  const tracked = getTrackedPosition(position.position);
  const pnlSuspect = (() => {
    // Couldn't-price-this-tick flag (e.g. Jupiter outage) — never act on PnL rules.
    if (position.pnl_pct_suspicious) return true;
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    if (tracked?.amount_sol && (position.total_value_usd ?? 0) > 0.01) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
      return true;
    }
    return false;
  })();

  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }
  if (!managementConfig.trailingTakeProfit && !pnlSuspect && position.pnl_pct != null && position.pnl_pct >= managementConfig.takeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }
  const strategy = position.strategy || tracked?.strategy || config.strategy?.strategy || "bid_ask";
  const isBidAsk = strategy === "bid_ask";

  // Rule 3: Pumped far above range.
  // Only applies to 2-sided Spot pairs where pumping above upper_bin leaves the pool
  // holding 100% quote token (missing token upside).
  // For Single-Sided SOL (bid_ask), being above upper_bin means holding 100% SOL (0 IL, 0 loss).
  // Under Mandor's rules, we NEVER cut at +10 bins; we give it up to outOfRangeAboveWaitMinutes (24h)
  // to wait for the natural pullback/dump into our DLMM fee net.
  if (
    !isBidAsk &&
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + managementConfig.outOfRangeBinsToClose
  ) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }

  // Rule 4: Out of Range wait timeout.
  // Case A: Above range (active_bin > upper_bin)
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin
  ) {
    const waitLimitAbove = isBidAsk
      ? (managementConfig.outOfRangeAboveWaitMinutes ?? 1440)
      : managementConfig.outOfRangeWaitMinutes;
    if ((position.minutes_out_of_range ?? 0) >= waitLimitAbove) {
      return { action: "CLOSE", rule: 4, reason: `OOR above (${position.minutes_out_of_range ?? 0}m >= ${waitLimitAbove}m)` };
    }
  }

  // Case B: Below range (active_bin < lower_bin) — real downside / rug risk
  if (
    position.active_bin != null &&
    position.lower_bin != null &&
    position.active_bin < position.lower_bin &&
    (position.minutes_out_of_range ?? 0) >= managementConfig.outOfRangeWaitMinutes
  ) {
    return { action: "CLOSE", rule: 4, reason: `OOR below (${position.minutes_out_of_range ?? 0}m >= ${managementConfig.outOfRangeWaitMinutes}m)` };
  }
  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= 60
  ) {
    return { action: "CLOSE", rule: 5, reason: "low yield" };
  }
  return null;
}

/**
 * Volatility-scaled bins below active bin, clamped to the configured range.
 * Throws on unknown volatility — never deploy a blind fixed range.
 */
export function computeBinsBelow(volatility) {
  const parsedVolatility = Number(volatility);
  if (!Number.isFinite(parsedVolatility) || parsedVolatility <= 0) {
    throw new Error(`Invalid volatility ${volatility ?? "unknown"} — refusing volatility-scaled deploy.`);
  }
  const lo = config.strategy.minBinsBelow;
  const hi = config.strategy.maxBinsBelow;
  return Math.max(lo, Math.min(hi, Math.round(lo + (parsedVolatility / 5) * (hi - lo))));
}
