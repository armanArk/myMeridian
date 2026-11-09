import fs from "node:fs";
import { repoPath } from "../repo-root.js";
import { log } from "../logger.js";
import { config } from "../config.js";
import {
  trackPosition,
  recordClose,
  getTrackedPosition,
  markInRange,
  markOutOfRange,
  minutesOutOfRange,
} from "../state.js";
import { recordPerformance } from "../lessons.js";
import { appendDecision } from "../decision-log.js";
import { sendMessage, isEnabled as telegramEnabled } from "../telegram.js";

const PAPER_STORE_FILE = repoPath("paper-positions.json");
const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUPITER_PRICE_API = "https://api.jup.ag/price/v3";
const DEFAULT_JUPITER_API_KEY = "b15d42e9-e0e4-4f90-a424-ae41ceeaa382";

function loadPaperStore() {
  if (!fs.existsSync(PAPER_STORE_FILE)) {
    return {
      realized_pnl_sol: 0.0,
      realized_pnl_usd: 0.0,
      total_trades: 0,
      winning_trades: 0,
      positions: {},
      trade_history: [],
      last_updated: new Date().toISOString(),
    };
  }
  try {
    return JSON.parse(fs.readFileSync(PAPER_STORE_FILE, "utf8"));
  } catch (err) {
    log("paper_error", `Failed to read paper-positions.json: ${err.message}. Trying backup...`);
    const bakFile = `${PAPER_STORE_FILE}.bak`;
    if (fs.existsSync(bakFile)) {
      try {
        const restored = JSON.parse(fs.readFileSync(bakFile, "utf8"));
        log("paper_warn", `Successfully restored paper store from backup (${bakFile})`);
        return restored;
      } catch (bakErr) {
        log("paper_error", `Failed to read backup file: ${bakErr.message}`);
      }
    }
    return {
      realized_pnl_sol: 0.0,
      realized_pnl_usd: 0.0,
      total_trades: 0,
      winning_trades: 0,
      positions: {},
      trade_history: [],
      last_updated: new Date().toISOString(),
    };
  }
}

function savePaperStore(store) {
  try {
    store.last_updated = new Date().toISOString();
    const tmpFile = `${PAPER_STORE_FILE}.tmp`;
    const bakFile = `${PAPER_STORE_FILE}.bak`;
    const content = JSON.stringify(store, null, 2);

    // 1. Write atomic temp file
    fs.writeFileSync(tmpFile, content);

    // 2. Keep backup of previous healthy store
    if (fs.existsSync(PAPER_STORE_FILE)) {
      try {
        fs.copyFileSync(PAPER_STORE_FILE, bakFile);
      } catch {}
    }

    // 3. Atomically replace target
    fs.renameSync(tmpFile, PAPER_STORE_FILE);
  } catch (err) {
    log("paper_error", `Failed to write paper-positions.json: ${err.message}`);
  }
}

export function isPaperMode() {
  if (process.env.PAPER_TRADING === "true") return true;
  if (config?.paperTrading === true) return true;
  return process.env.DRY_RUN === "true" || config?.dryRun === true;
}

export function isPaperPosition(position_address) {
  if (!position_address) return false;
  return String(position_address).startsWith("paper_");
}

async function fetchJupiterPrices(mints) {
  const unique = [...new Set(mints.filter(Boolean))];
  if (unique.length === 0) return {};
  try {
    const key = config?.jupiter?.apiKey || process.env.JUPITER_API_KEY || DEFAULT_JUPITER_API_KEY;
    const res = await fetch(`${JUPITER_PRICE_API}?ids=${encodeURIComponent(unique.join(","))}`, {
      headers: key ? { "x-api-key": key } : {},
    });
    if (!res.ok) return {};
    const data = await res.json();
    const result = {};
    for (const [mint, info] of Object.entries(data || {})) {
      const price = parseFloat(info?.usdPrice ?? info?.price);
      if (Number.isFinite(price)) result[mint] = price;
    }
    return result;
  } catch (err) {
    log("paper_warn", `Price fetch failed: ${err.message}`);
    return {};
  }
}

async function fetchPoolDetail(poolAddress, timeframe = "24h") {
  try {
    const url = `https://pool-discovery-api.datapi.meteora.ag/pools?page_size=1&filter_by=${encodeURIComponent(`pool_address=${poolAddress}`)}&timeframe=${encodeURIComponent(timeframe)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    return (json?.data || [])[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Mathematical DLMM PnL Simulator for Single-sided SOL bid-ask / spot position
 */
function computeSimulatedPositionState({ pos, currentActiveBin, currentPrice, solUsd, poolDetail }) {
  const amountSol = Number(pos.amount_sol || 0.5);
  const lowerBin = Number(pos.lower_bin);
  const upperBin = Number(pos.upper_bin);
  const entryActiveBin = Number(pos.active_bin_at_deploy);
  const binStep = Number(pos.bin_step || 100);
  const entryPrice = Number(pos.entry_price || currentPrice);
  const strategy = pos.strategy || "bid_ask";

  const inRange = currentActiveBin >= lowerBin && currentActiveBin <= upperBin;
  const totalBins = Math.max(1, upperBin - lowerBin + 1);

  // Compute weight distribution of SOL deposit across bins
  // For bid_ask: highest at upperBin (near active), decreasing towards lowerBin
  // For spot: uniform
  let principalSol = amountSol;
  if (currentActiveBin >= upperBin) {
    // Price stayed at or above entry active bin: 100% SOL held, no IL
    principalSol = amountSol;
  } else if (currentActiveBin < lowerBin) {
    // Price plunged below lower bin: 100% converted to Base Token X at average bin execution prices
    // Then Token X drops linearly with currentPrice vs lowerBin price
    let sumWeight = 0;
    let sumTokenX = 0;
    for (let b = lowerBin; b <= upperBin; b++) {
      const weight = strategy === "bid_ask" ? (b - lowerBin + 1) : 1;
      sumWeight += weight;
      // Price at bin b relative to entry: (1 + step/10000)^(b - entryActiveBin)
      const binPriceRatio = Math.pow(1 + binStep / 10000, b - entryActiveBin);
      sumTokenX += weight / binPriceRatio;
    }
    const tokenXPerSol = sumTokenX / sumWeight;
    // DLMM bin pricing is strictly geometric: (1 + step/10000)^(currentActiveBin - entryActiveBin)
    const currentPriceRatio = Math.pow(1 + binStep / 10000, currentActiveBin - entryActiveBin);
    principalSol = amountSol * tokenXPerSol * currentPriceRatio;
  } else {
    // Inside the range: partial absorption
    let sumWeight = 0;
    let unconvertedSolWeight = 0;
    let convertedTokenXValueWeight = 0;
    // DLMM bin pricing is strictly geometric: (1 + step/10000)^(currentActiveBin - entryActiveBin)
    const currentPriceRatio = Math.pow(1 + binStep / 10000, currentActiveBin - entryActiveBin);

    for (let b = lowerBin; b <= upperBin; b++) {
      const weight = strategy === "bid_ask" ? (b - lowerBin + 1) : 1;
      sumWeight += weight;
      if (b < currentActiveBin) {
        // Unreached bins still hold pristine SOL
        unconvertedSolWeight += weight;
      } else {
        // Converted bins hold Token X
        const binPriceRatio = Math.pow(1 + binStep / 10000, b - entryActiveBin);
        convertedTokenXValueWeight += weight * (currentPriceRatio / binPriceRatio);
      }
    }
    principalSol = amountSol * ((unconvertedSolWeight + convertedTokenXValueWeight) / sumWeight);
  }

  // Estimate DLMM fee capture:
  // Fee = (volume_24h * fee_rate) * (amountSol / active_tvl_sol) * (age_hours / 24)
  const deployedTime = pos.deployed_at ? new Date(pos.deployed_at).getTime() : Date.now();
  const ageMinutes = Math.max(1, Math.floor((Date.now() - deployedTime) / 60000));
  const ageHours = ageMinutes / 60;

  let estimatedFeesSol = 0;
  if (poolDetail) {
    const vol24h = Number(poolDetail.volume ?? poolDetail.volume_24h ?? poolDetail.avg_volume ?? 0);
    const feeRatePct = Number(poolDetail.fee_pct ?? poolDetail.base_fee_percentage ?? (binStep / 100));
    const activeTvlUsd = Number(poolDetail.active_tvl ?? poolDetail.tvl ?? 20000);
    const solPrice = solUsd > 0 ? solUsd : 180;
    const activeTvlSol = Math.max(50, activeTvlUsd / solPrice);

    const poolDailyFeesSol = poolDetail.fee != null && Number(poolDetail.fee) > 0
      ? Number(poolDetail.fee) / solPrice
      : (vol24h * (feeRatePct / 100)) / solPrice;
    const shareOfPool = Math.min(0.25, amountSol / activeTvlSol);

    // Only generate full fees while in range (or reduced fees if out of range)
    const rangeMultiplier = inRange ? 1.0 : (currentActiveBin > upperBin ? 0.3 : 0.05);
    estimatedFeesSol = poolDailyFeesSol * shareOfPool * (ageHours / 24) * rangeMultiplier;
  }

  const totalValueSol = principalSol + estimatedFeesSol;
  const pnlSol = totalValueSol - amountSol;
  const pnlPct = (pnlSol / amountSol) * 100;
  const solPrice = solUsd > 0 ? solUsd : 180;

  const totalValueUsd = totalValueSol * solPrice;
  const unclaimedFeesUsd = estimatedFeesSol * solPrice;
  const pnlUsd = pnlSol * solPrice;

  return {
    in_range: inRange,
    total_value_sol: totalValueSol,
    total_value_usd: Math.round(totalValueUsd * 100) / 100,
    unclaimed_fees_sol: estimatedFeesSol,
    unclaimed_fees_usd: Math.round(unclaimedFeesUsd * 100) / 100,
    pnl_sol: pnlSol,
    pnl_usd: Math.round(pnlUsd * 100) / 100,
    pnl_pct: Math.round(pnlPct * 100) / 100,
    age_minutes: ageMinutes,
    active_bin: currentActiveBin,
    current_price: currentPrice,
  };
}

/**
 * Deploy a new paper virtual position
 */
export async function deployPaperPosition({
  pool_address,
  amount_sol = 0.5,
  strategy = "bid_ask",
  bins_below = 230,
  bins_above = 0,
  downside_pct = 90,
  upside_pct = 0,
  entry_snapshot = null,
}) {
  const store = loadPaperStore();
  const poolDetail = await fetchPoolDetail(pool_address);
  const pairName = poolDetail?.name || pool_address.slice(0, 8);
  const baseMint = poolDetail?.token_x?.address || poolDetail?.base_token_address || null;
  const binStep = Number(poolDetail?.bin_step || 100);

  // Fetch active bin from discovery or fallback
  let activeBin = poolDetail?.active_bin != null ? Number(poolDetail.active_bin) : null;
  if (activeBin == null) {
    try {
      const { getActiveBin } = await import("./dlmm.js");
      const ab = await getActiveBin({ pool_address });
      activeBin = Number(ab?.binId ?? 0);
    } catch {
      activeBin = 0;
    }
  }

  // Calculate bins below: if downside_pct is provided (e.g. 90%), compute bins
  let computedBinsBelow = Number(bins_below);
  if (downside_pct != null && downside_pct > 0) {
    // (1 + step/10000)^(-bins) = 1 - downside_pct/100
    // -bins * ln(1 + step/10000) = ln(1 - downside_pct/100)
    const ratio = Math.max(0.01, 1 - downside_pct / 100);
    computedBinsBelow = Math.round(Math.abs(Math.log(ratio) / Math.log(1 + binStep / 10000)));
  }

  const lowerBin = activeBin - computedBinsBelow;
  const upperBin = activeBin + Number(bins_above || 0);

  // Fetch prices
  const prices = await fetchJupiterPrices([SOL_MINT, baseMint]);
  const solUsd = prices[SOL_MINT] || 180;
  const currentPrice = prices[baseMint] || (poolDetail?.price ? Number(poolDetail.price) : 0);
  const initialValueUsd = amount_sol * solUsd;

  const positionId = `paper_${pairName.replace(/[^a-zA-Z0-9]/g, "")}_${Date.now()}`;

  const paperPos = {
    id: positionId,
    position: positionId,
    pool: pool_address,
    pair: pairName,
    base_mint: baseMint,
    amount_sol: Number(amount_sol),
    strategy,
    bin_step: binStep,
    active_bin_at_deploy: activeBin,
    lower_bin: lowerBin,
    upper_bin: upperBin,
    downside_pct: downside_pct ?? 90,
    entry_price: currentPrice,
    entry_sol_usd: solUsd,
    initial_value_usd: Math.round(initialValueUsd * 100) / 100,
    deployed_at: new Date().toISOString(),
    status: "OPEN",
    closed_at: null,
    peak_pnl_pct: 0,
    max_drawdown_pct: 0,
    entry_snapshot: entry_snapshot || null,
    notes: [],
  };

  store.positions[positionId] = paperPos;
  savePaperStore(store);

  // Register in Meridian's state.js registry so all existing PnL/exit trackers can inspect it
  trackPosition({
    position: positionId,
    pool: pool_address,
    pool_name: pairName,
    strategy,
    bin_range: { min: lowerBin, max: upperBin, active: activeBin },
    amount_sol,
    amount_x: 0,
    active_bin: activeBin,
    bin_step: binStep,
    initial_value_usd: initialValueUsd,
    fee_tvl_ratio: poolDetail?.fee_active_tvl_ratio ?? null,
    organic_score: poolDetail?.token_x?.organic_score ?? null,
    entry_snapshot: entry_snapshot || null,
  });

  log("paper", `[PAPER DEPLOY] Deployed virtual position ${positionId} into ${pairName} (${amount_sol} SOL, range: [${lowerBin}..${upperBin}])`);

  appendDecision({
    type: "paper_deploy",
    actor: "SCREENER",
    pool: pool_address,
    pool_name: pairName,
    position: positionId,
    summary: `Paper deployed ${amount_sol} SOL into ${pairName}`,
    reason: `Screening criteria passed (Virtual Paper Mode)`,
    metrics: {
      amount_sol,
      active_bin: activeBin,
      range: [lowerBin, upperBin],
      ...(entry_snapshot || {}),
    },
  });

  if (telegramEnabled()) {
    sendMessage(`📝 <b>[PAPER MODE ENTRY]</b>\n` +
      `Deployed virtual <b>${amount_sol} SOL</b> into <b>${pairName}</b>\n` +
      `Range: -${downside_pct}% (${computedBinsBelow} bins)\n` +
      `Entry Price: $${currentPrice.toFixed(6)}\n` +
      `ID: <code>${positionId}</code>`).catch(() => {});
  }

  return {
    success: true,
    is_paper: true,
    position: positionId,
    pool_name: pairName,
    pool_address,
    amount_sol,
    strategy,
    bin_step: binStep,
    lower_bin: lowerBin,
    upper_bin: upperBin,
    active_bin: activeBin,
    message: "Paper virtual position deployed successfully (0 real SOL spent).",
  };
}

/**
 * Get all active paper positions with live simulated PnL
 */
export async function getPaperPositions({ force = false, silent = false } = {}) {
  const store = loadPaperStore();
  const openIds = Object.keys(store.positions).filter((id) => store.positions[id].status === "OPEN");

  let realWallet = config.standalone?.walletAddress || null;
  if (!realWallet) {
    try {
      const { getWallet } = await import("./wallet.js");
      realWallet = getWallet().publicKey.toString();
    } catch {
      realWallet = null;
    }
  }

  if (openIds.length === 0) {
    return {
      wallet: realWallet,
      total_positions: 0,
      positions: [],
      source: "paper",
    };
  }

  const baseMints = openIds.map((id) => store.positions[id].base_mint).filter(Boolean);
  const poolAddresses = openIds.map((id) => store.positions[id].pool);

  let getActiveBin = null;
  try {
    const dlmmMod = await import("./dlmm.js");
    getActiveBin = dlmmMod.getActiveBin;
  } catch {
    getActiveBin = null;
  }

  const [prices, poolDetails, activeBins] = await Promise.all([
    fetchJupiterPrices([SOL_MINT, ...baseMints]),
    Promise.all(poolAddresses.map((pool) => fetchPoolDetail(pool))),
    getActiveBin
      ? Promise.all(poolAddresses.map((pool) => getActiveBin({ pool_address: pool }).catch(() => null)))
      : Promise.resolve([]),
  ]);

  const solUsd = prices[SOL_MINT] || 180;
  const shapedPositions = [];

  for (let i = 0; i < openIds.length; i++) {
    const pos = store.positions[openIds[i]];
    const poolDetail = poolDetails[i];
    const ab = activeBins ? activeBins[i] : null;

    const jupPrice = pos.base_mint ? prices[pos.base_mint] : null;
    const poolUsdPrice = poolDetail?.token_x?.price != null ? Number(poolDetail.token_x.price) : (poolDetail?.pool_price != null ? Number(poolDetail.pool_price) * solUsd : null);
    const dlmmUsdPrice = ab?.price != null ? Number(ab.price) * solUsd : null;
    const currentPrice = jupPrice || poolUsdPrice || dlmmUsdPrice || Number(pos.entry_price || 0);

    let activeBin = ab?.binId != null ? Number(ab.binId) : (poolDetail?.active_bin != null ? Number(poolDetail.active_bin) : null);
    if (activeBin == null) {
      activeBin = pos.active_bin_at_deploy;
    }

    const sim = computeSimulatedPositionState({
      pos,
      currentActiveBin: activeBin,
      currentPrice,
      solUsd,
      poolDetail,
    });

    if (sim.in_range) markInRange(pos.id);
    else markOutOfRange(pos.id);

    const tracked = getTrackedPosition(pos.id);

    shapedPositions.push({
      position: pos.id,
      pool: pos.pool,
      pair: pos.pair,
      base_mint: pos.base_mint,
      lower_bin: pos.lower_bin,
      upper_bin: pos.upper_bin,
      active_bin: activeBin,
      in_range: sim.in_range,
      unclaimed_fees_usd: sim.unclaimed_fees_usd,
      total_value_usd: sim.total_value_usd,
      pnl_usd: sim.pnl_usd,
      pnl_pct: sim.pnl_pct,
      pnl_pct_derived: sim.pnl_pct,
      pnl_pct_suspicious: false,
      age_minutes: sim.age_minutes,
      minutes_out_of_range: minutesOutOfRange(pos.id),
      instruction: tracked?.instruction ?? null,
      is_paper: true,
      strategy: pos.strategy,
      amount_sol: pos.amount_sol,
    });
  }

  return {
    wallet: realWallet,
    total_positions: shapedPositions.length,
    positions: shapedPositions,
    source: "paper",
  };
}

/**
 * Close a paper virtual position
 */
export async function closePaperPosition({ position_address, reason = "agent decision", trigger = null, rsi = null, exit_indicators = null }) {
  const store = loadPaperStore();
  const pos = store.positions[position_address];
  if (!pos) {
    return { success: false, error: `Paper position ${position_address} not found.` };
  }
  if (pos.status === "CLOSED") {
    return { success: true, message: `Position ${position_address} already closed.` };
  }

  // Get current live valuation for final performance accounting
  const poolDetail = await fetchPoolDetail(pos.pool);
  let getActiveBin = null;
  try {
    const dlmmMod = await import("./dlmm.js");
    getActiveBin = dlmmMod.getActiveBin;
  } catch {
    getActiveBin = null;
  }

  const [prices, ab] = await Promise.all([
    fetchJupiterPrices([SOL_MINT, pos.base_mint]),
    getActiveBin ? getActiveBin({ pool_address: pos.pool }).catch(() => null) : Promise.resolve(null),
  ]);

  const solUsd = prices[SOL_MINT] || 180;
  const jupPrice = pos.base_mint ? prices[pos.base_mint] : null;
  const poolUsdPrice = poolDetail?.token_x?.price != null ? Number(poolDetail.token_x.price) : (poolDetail?.pool_price != null ? Number(poolDetail.pool_price) * solUsd : null);
  const dlmmUsdPrice = ab?.price != null ? Number(ab.price) * solUsd : null;
  const currentPrice = jupPrice || poolUsdPrice || dlmmUsdPrice || Number(pos.entry_price || 0);
  const activeBin = ab?.binId != null ? Number(ab.binId) : (poolDetail?.active_bin != null ? Number(poolDetail.active_bin) : pos.active_bin_at_deploy);

  const sim = computeSimulatedPositionState({
    pos,
    currentActiveBin: activeBin,
    currentPrice,
    solUsd,
    poolDetail,
  });

  const tracked = getTrackedPosition(pos.id);
  const peakPnlPct = tracked?.peak_pnl_pct ?? (sim.pnl_pct > 0 ? sim.pnl_pct : 0);
  const maxDrawdownPct = tracked?.max_drawdown_pct ?? (sim.pnl_pct < 0 ? sim.pnl_pct : 0);
  const exitTrigger = trigger || (sim.pnl_pct <= -30 ? "stop_loss_hit" : "trailing_take_profit");
  const exitIndicators = exit_indicators || (rsi != null ? { rsi_2: rsi } : null);

  pos.status = "CLOSED";
  pos.closed_at = new Date().toISOString();
  pos.close_reason = reason;
  pos.close_pnl_pct = sim.pnl_pct;
  pos.close_pnl_sol = sim.pnl_sol;
  pos.close_pnl_usd = sim.pnl_usd;
  pos.final_value_usd = sim.total_value_usd;
  pos.exit_trigger = exitTrigger;
  pos.exit_trigger_type = exitTrigger;
  pos.exit_rsi = rsi;
  pos.exit_indicators = exitIndicators;
  pos.peak_pnl_pct = peakPnlPct;
  pos.max_drawdown_pct = maxDrawdownPct;

  store.realized_pnl_sol += sim.pnl_sol;
  store.realized_pnl_usd += sim.pnl_usd;
  store.total_trades += 1;
  if (sim.pnl_sol > 0) store.winning_trades += 1;

  const exitTvlUsd = Number(poolDetail?.active_tvl ?? poolDetail?.tvl ?? 0);
  const entryTvlUsd = Number(pos.entry_snapshot?.entry_tvl ?? pos.entry_tvl ?? 0);
  const poolTvlRetentionPct = entryTvlUsd > 0 ? Math.round((exitTvlUsd / entryTvlUsd) * 1000) / 10 : null;
  const isLiquidityDrained = entryTvlUsd > 2000 && exitTvlUsd < 500;

  store.trade_history.unshift({
    position: pos.id,
    pair: pos.pair,
    pool: pos.pool,
    amount_sol: pos.amount_sol,
    deployed_at: pos.deployed_at,
    closed_at: pos.closed_at,
    duration_minutes: sim.age_minutes,
    pnl_pct: sim.pnl_pct,
    pnl_sol: Math.round(sim.pnl_sol * 10000) / 10000,
    pnl_usd: sim.pnl_usd,
    fees_usd: sim.unclaimed_fees_usd,
    trigger: exitTrigger,
    exit_trigger_type: exitTrigger,
    rsi_at_exit: rsi,
    exit_indicators: exitIndicators,
    peak_pnl_pct: peakPnlPct,
    max_drawdown_pct: maxDrawdownPct,
    entry_tvl_usd: entryTvlUsd || null,
    exit_tvl_usd: exitTvlUsd || null,
    pool_tvl_retention_pct: poolTvlRetentionPct,
    is_liquidity_drained: isLiquidityDrained,
    engine_phase: "phase2_24h_fee",
    reason,
    entry_snapshot: pos.entry_snapshot || null,
  });

  savePaperStore(store);

  // Mark closed in state.js
  recordClose(pos.id, reason);

  // Feed result into lessons.js for AI self-evolution
  try {
    await recordPerformance({
      position: pos.id,
      pool: pos.pool,
      pool_name: pos.pair,
      base_mint: pos.base_mint,
      strategy: pos.strategy,
      bin_range: { min: pos.lower_bin, max: pos.upper_bin },
      bin_step: pos.bin_step,
      amount_sol: pos.amount_sol,
      fees_earned_usd: sim.unclaimed_fees_usd,
      final_value_usd: sim.total_value_usd,
      initial_value_usd: pos.initial_value_usd,
      minutes_in_range: sim.in_range ? sim.age_minutes : Math.max(1, sim.age_minutes - minutesOutOfRange(pos.id)),
      minutes_held: sim.age_minutes,
      close_reason: reason,
      trigger: exitTrigger,
      exit_trigger_type: exitTrigger,
      rsi_at_exit: rsi,
      exit_indicators: exitIndicators,
      peak_pnl_pct: peakPnlPct,
      max_drawdown_pct: maxDrawdownPct,
      entry_tvl: entryTvlUsd || null,
      exit_tvl: exitTvlUsd || null,
      entry_snapshot: pos.entry_snapshot || null,
      is_paper: true,
    });
  } catch (err) {
    log("paper_warn", `Performance record failed: ${err.message}`);
  }

  appendDecision({
    type: "paper_close",
    actor: "MANAGER",
    pool: pos.pool,
    pool_name: pos.pair,
    position: pos.id,
    summary: `Paper closed at ${sim.pnl_pct.toFixed(2)}% (${exitTrigger})`,
    reason,
    metrics: {
      pnl_pct: sim.pnl_pct,
      pnl_usd: sim.pnl_usd,
      duration_minutes: sim.age_minutes,
      trigger: exitTrigger,
      exit_trigger_type: exitTrigger,
      rsi_at_exit: rsi,
      exit_indicators: exitIndicators,
      peak_pnl_pct: peakPnlPct,
      max_drawdown_pct: maxDrawdownPct,
      entry_snapshot: pos.entry_snapshot || null,
    },
  });

  log("paper", `[PAPER CLOSE] Position ${pos.id} closed | Trigger: ${exitTrigger} | RSI: ${rsi ?? "n/a"} | PnL: ${sim.pnl_pct.toFixed(2)}% ($${sim.pnl_usd}) | Peak: ${peakPnlPct}% | MaxDD: ${maxDrawdownPct}% | Age: ${sim.age_minutes}m`);

  if (telegramEnabled()) {
    const emoji = sim.pnl_pct >= 0 ? "🎉" : "🛑";
    sendMessage(`${emoji} <b>[PAPER MODE EXIT]</b>\n` +
      `Pair: <b>${pos.pair}</b>\n` +
      `Trigger: <code>${exitTrigger}</code> (RSI: ${rsi != null ? rsi.toFixed(1) : "n/a"})\n` +
      (reason ? `Reason: <code>${reason}</code>\n` : "") +
      `PnL: <b>${sim.pnl_pct >= 0 ? "+" : ""}${sim.pnl_pct.toFixed(2)}%</b> ($${sim.pnl_usd.toFixed(2)})\n` +
      `Peak: <b>+${peakPnlPct.toFixed(1)}%</b> | MaxDD: <b>${maxDrawdownPct.toFixed(1)}%</b>\n` +
      `Duration: ${sim.age_minutes} minutes`).catch(() => {});
  }

  return {
    success: true,
    is_paper: true,
    position: pos.id,
    pair: pos.pair,
    pnl_pct: sim.pnl_pct,
    pnl_usd: sim.pnl_usd,
    pnl_sol: sim.pnl_sol,
    reason,
  };
}

export function getPaperStats() {
  const store = loadPaperStore();
  return {
    realized_pnl_sol: store.realized_pnl_sol,
    realized_pnl_usd: store.realized_pnl_usd,
    total_trades: store.total_trades,
    winning_trades: store.winning_trades,
    win_rate_pct: store.total_trades > 0 ? (store.winning_trades / store.total_trades) * 100 : 0,
  };
}
