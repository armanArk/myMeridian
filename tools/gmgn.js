import { randomUUID } from "crypto";
import { setDefaultResultOrder } from "dns";
import { config } from "../config.js";
import { log } from "../logger.js";

// Force IPv4 — GMGN OpenAPI does not support IPv6
setDefaultResultOrder("ipv4first");

let lastGmgnRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function paceGmgnRequest() {
  const delayMs = Math.max(0, Number(config.gmgn?.requestDelayMs ?? 2500));
  if (!delayMs) return;
  const elapsed = Date.now() - lastGmgnRequestAt;
  if (elapsed < delayMs) await sleep(delayMs - elapsed);
  lastGmgnRequestAt = Date.now();
}

function getApiKey() {
  const key = config.gmgn?.apiKey || process.env.GMGN_API_KEY;
  if (!key) throw new Error("GMGN_API_KEY is required for the GMGN fee source.");
  return key;
}

export function hasGmgnApiKey() {
  return !!(config.gmgn?.apiKey || process.env.GMGN_API_KEY);
}

function appendParams(url, params = {}) {
  for (const [key, value] of Object.entries(params)) {
    if (value == null) continue;
    if (Array.isArray(value)) {
      for (const entry of value.filter((item) => item != null && item !== "")) {
        url.searchParams.append(key, String(entry));
      }
    } else {
      url.searchParams.set(key, String(value));
    }
  }
}

async function gmgnFetch(pathname, { method = "GET", params = {}, body = null } = {}) {
  const baseUrl = String(config.gmgn?.baseUrl || "https://openapi.gmgn.ai").replace(/\/+$/, "");
  const url = new URL(`${baseUrl}${pathname}`);
  appendParams(url, {
    ...params,
    timestamp: Math.floor(Date.now() / 1000),
    client_id: randomUUID(),
  });

  const maxRetries = Math.max(0, Number(config.gmgn?.maxRetries ?? 2));
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await paceGmgnRequest();
    const res = await fetch(url, {
      method,
      headers: {
        "X-APIKEY": getApiKey(),
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : null,
    });
    const text = await res.text().catch(() => "");
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }
    const message = payload?.message || payload?.error || payload?.raw || `GMGN ${pathname} ${res.status}`;
    const rateLimited = res.status === 429 || /rate limit|temporarily banned/i.test(String(message));
    if (res.ok) return payload;
    if (rateLimited && attempt < maxRetries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const backoffMs = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : /temporarily banned/i.test(String(message))
          ? 60000
          : Math.min(30000, 3000 * Math.pow(2, attempt));
      await sleep(backoffMs);
      continue;
    }
    throw new Error(message);
  }
  throw new Error(`GMGN ${pathname} failed`);
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// ─── Token fees (SOL) for the minTokenFeesSol gate ──────────────
// Returns { total_fee, trade_fee } in SOL, or null on missing key / error
// so callers can fall back to Jupiter's fee figure.
export async function getGmgnTokenFees(mint) {
  if (!mint || !hasGmgnApiKey()) return null;
  try {
    const payload = await gmgnFetch("/v1/token/info", { params: { chain: "sol", address: mint } });
    const info = payload?.data?.data || payload?.data || payload;
    if (!info || typeof info !== "object") return null;
    return {
      total_fee: num(info.total_fee),
      trade_fee: num(info.trade_fee),
    };
  } catch (error) {
    log("gmgn", `token fees lookup failed for ${String(mint).slice(0, 8)}: ${error.message}`);
    return null;
  }
}

/**
 * Fetch comprehensive security metrics for a token mint.
 * Sources from GMGN OpenAPI (if key provided) + RugCheck public API.
 */
export async function getGmgnSecurity(mint) {
  if (!mint) return null;

  let top10_pct = null;
  let insiders_pct = null;
  let bundling_pct = null;
  let warning_pct = null;
  let total_fees_sol = null;

  // 1. Try GMGN OpenAPI if key is configured
  if (hasGmgnApiKey()) {
    try {
      const payload = await gmgnFetch("/v1/token/security", { params: { chain: "sol", address: mint } });
      const sec = payload?.data?.data || payload?.data || payload;
      if (sec && typeof sec === "object") {
        insiders_pct = num(sec.insider_percent ?? sec.insider_rate);
        bundling_pct = num(sec.bundling_percent ?? sec.bundle_rate);
        top10_pct = num(sec.top10_percent ?? sec.top10_holder_rate);
        warning_pct = num(sec.warning_percent ?? sec.risk_score);
      }
    } catch (err) {
      log("gmgn_warn", `GMGN security fetch failed for ${mint.slice(0, 8)}: ${err.message}`);
    }

    try {
      const fees = await getGmgnTokenFees(mint);
      if (fees?.total_fee != null) total_fees_sol = fees.total_fee;
    } catch {}
  }

  // 2. Fetch from RugCheck public API to complement or fallback
  try {
    const rcRes = await fetch(`https://api.rugcheck.xyz/v1/tokens/${mint}/report`);
    if (rcRes.ok) {
      const rc = await rcRes.json();
      if (top10_pct == null && Array.isArray(rc.topHolders)) {
        const top10Sum = rc.topHolders.slice(0, 10).reduce((sum, h) => sum + (num(h.pct) || 0), 0);
        top10_pct = Math.round(top10Sum * 100) / 100;
      }
      if (insiders_pct == null) {
        if (Array.isArray(rc.insiderNetworks) && rc.insiderNetworks.length > 0) {
          // If total supply known, compute percentage, or use number of detected accounts
          const insiderHolding = rc.insiderNetworks.reduce((sum, n) => sum + (num(n.currentHolding) || 0), 0);
          const totalSupply = num(rc.token?.supply) || 1;
          insiders_pct = Math.min(100, Math.round(((insiderHolding / totalSupply) * 100) * 100) / 100);
        } else {
          insiders_pct = rc.graphInsidersDetected ? Math.min(100, Number(rc.graphInsidersDetected)) : 0;
        }
      }
      if (warning_pct == null) {
        warning_pct = num(rc.score_normalised) ?? (rc.score ? Math.min(100, Math.round(rc.score / 10)) : 0);
      }
      if (bundling_pct == null && rc.risks) {
        const bundleRisk = rc.risks.find((r) => /bundle|sniper/i.test(r.name || ""));
        if (bundleRisk) bundling_pct = 70; // flag high bundling if detected by rugcheck
      }
    }
  } catch (err) {
    log("gmgn_warn", `Rugcheck fallback fetch failed for ${mint.slice(0, 8)}: ${err.message}`);
  }

  return {
    top10_pct,
    insiders_pct,
    bundling_pct,
    warning_pct,
    total_fees_sol,
  };
}
