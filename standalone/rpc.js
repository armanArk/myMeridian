import { Connection } from '@solana/web3.js';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { REPO_ROOT } from '../repo-root.js';

export async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Data request failed (HTTP ${response.status})`);
  return response.json();
}

export function maskUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    const key = u.searchParams.get('api-key');
    if (key && key.length > 8) {
      u.searchParams.set('api-key', `${key.slice(0, 4)}...${key.slice(-4)}`);
      return u.toString();
    }
    return url;
  } catch {
    return url.replace(/api-key=[a-zA-Z0-9_-]+/g, 'api-key=***');
  }
}

export function isQuotaExhausted(error) {
  if (!error) return false;
  const s = String(error?.message || error).toLowerCase();
  return ['max usage', 'monthly', 'quota', 'credits', 'credit limit', 'plan limit', 'daily limit', 'exceeded your plan', 'usage limit'].some(w => s.includes(w));
}

export function isRateLimited(error) {
  if (!error) return false;
  const s = String(error?.message || error).toLowerCase();
  const status = error?.status || error?.statusCode || error?.response?.status;
  return status === 429 || s.includes('429') || s.includes('too many requests') || s.includes('rate limit') || s.includes('exceeded') || s.includes('quota');
}

const connections = new Map();
const exhaustedUntil = new Map();
let activeUrl = null;

export function getRpcUrls(kind = 'default') {
  let primary;
  if (kind === 'balance') primary = config.standalone.balanceRpcUrl;
  else if (kind === 'monitor') primary = config.standalone.monitorRpcUrl;
  else primary = config.rpc?.activeRpcUrl || process.env.RPC_URL;

  const pool = config.rpc?.rpcUrls || [];
  const fallback = config.standalone.fallbackRpcUrl;

  const all = [...new Set([primary, ...pool, fallback].filter(Boolean))];
  return all.length ? all : ['https://api.mainnet-beta.solana.com'];
}

export function getHealthyUrls(kind = 'default') {
  const all = getRpcUrls(kind);
  const now = Date.now();
  const healthy = all.filter(u => now >= (exhaustedUntil.get(u) || 0));
  if (!healthy.length) {
    // Failsafe: if all URLs were marked in cooldown, reset cooldowns so bot doesn't get bricked
    exhaustedUntil.clear();
    return all;
  }
  return healthy;
}

export function getActiveRpcUrl(kind = 'default') {
  const healthy = getHealthyUrls(kind);
  if (!activeUrl || !healthy.includes(activeUrl)) {
    activeUrl = healthy[0];
  }
  return activeUrl;
}

function syncCurrentKeyFile(url) {
  try {
    const u = new URL(url);
    const key = u.searchParams.get('api-key');
    if (key) {
      const keyFile = path.join(REPO_ROOT, '.current_helius_key');
      fs.writeFileSync(keyFile, key, { encoding: 'utf8' });
    }
  } catch {}
}

export function rotateConnection(failedUrl = null, error = null) {
  const all = getRpcUrls();
  const now = Date.now();

  if (failedUrl) {
    const exhausted = isQuotaExhausted(error);
    const cooldownMs = exhausted ? 3600_000 : 30_000; // 1 hr for quota, 30s for burst
    exhaustedUntil.set(failedUrl, now + cooldownMs);
    const reason = exhausted ? 'KUOTA HABIS (max usage reached)' : 'Rate limit reached (429)';
    console.warn(`[RPC POOL] ${reason} on ${maskUrl(failedUrl)}. Marked in cooldown for ${cooldownMs / 1000}s.`);
  }

  const healthy = getHealthyUrls();
  const currIdx = activeUrl ? healthy.indexOf(activeUrl) : -1;
  const nextIdx = (currIdx + 1) % healthy.length;
  activeUrl = healthy[nextIdx];

  process.env.RPC_URL = activeUrl;
  if (config.rpc) config.rpc.activeRpcUrl = activeUrl;

  syncCurrentKeyFile(activeUrl);

  console.log(`[RPC POOL] Rotated active RPC to: ${maskUrl(activeUrl)} (${healthy.length}/${all.length} healthy)`);
  return getConnection(activeUrl);
}

export function connection(url, wsEndpoint) {
  if (!url) throw new Error('Configure RPC_URL (and optionally MONITOR_RPC_URL/BALANCE_RPC_URL)');
  let resolvedWs = wsEndpoint;
  if (!resolvedWs && url.includes('helius-rpc.com')) {
    try {
      const parsed = new URL(url);
      resolvedWs = `wss://${parsed.host}${parsed.pathname}${parsed.search}`;
    } catch {}
  }

  return new Connection(url, {
    commitment: 'confirmed',
    ...(resolvedWs ? { wsEndpoint: resolvedWs } : {}),
    disableRetryOnRateLimit: true,
    fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(15_000) }),
  });
}

export function getConnection(url = null) {
  const target = url || getActiveRpcUrl();
  if (!connections.has(target)) {
    connections.set(target, connection(target));
  }
  return connections.get(target);
}

export function getPnlConnection() {
  const pnlUrl = config.pnl?.rpcUrl;
  return getConnection(pnlUrl || null);
}

export function getRpcPoolStats() {
  const all = getRpcUrls();
  const healthy = getHealthyUrls();
  return {
    total: all.length,
    healthy: healthy.length,
    activeUrl: maskUrl(getActiveRpcUrl()),
    exhausted: all.filter(u => !healthy.includes(u)).map(u => ({ url: maskUrl(u), cooldownSec: Math.max(0, Math.round(((exhaustedUntil.get(u) || 0) - Date.now()) / 1000)) }))
  };
}

export async function readRpc(kind, fn) {
  const healthy = getHealthyUrls(kind);
  if (!healthy.length) throw new Error('RPC_URL is required');

  const maxAttempts = Math.max(3, healthy.length * 2);
  let lastError;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const url = getActiveRpcUrl(kind);
    const conn = getConnection(url);
    try {
      return await fn(conn);
    } catch (err) {
      lastError = err;
      if (isRateLimited(err)) {
        rotateConnection(url, err);
        continue;
      }
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('fetch failed') || msg.includes('timeout') || msg.includes('econnrefused')) {
        rotateConnection(url, err);
        continue;
      }
      throw err;
    }
  }

  // Provider errors may contain authenticated URLs. Keep them out of persisted state.
  throw new Error(`RPC ${kind} read failed (${lastError?.name || 'Error'})`);
}

export async function withRpcRetry(fn, { maxRetries = 3 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(getConnection());
    } catch (err) {
      lastError = err;
      if (isRateLimited(err) && attempt < maxRetries) {
        rotateConnection(getActiveRpcUrl(), err);
        await new Promise(r => setTimeout(r, 500));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}
