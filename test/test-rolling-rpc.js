import test from 'node:test';
import assert from 'node:assert/strict';
import {
  maskUrl,
  isQuotaExhausted,
  isRateLimited,
  getRpcUrls,
  getHealthyUrls,
  getActiveRpcUrl,
  rotateConnection,
  getConnection,
  readRpc,
  getRpcPoolStats
} from '../standalone/rpc.js';
import { config } from '../config.js';

test('maskUrl masks Helius api-key query param and preserves structure', () => {
  const masked = maskUrl('https://mainnet.helius-rpc.com/?api-key=12345678-abcd-ef01-2345-6789abcdef01');
  assert.equal(masked, 'https://mainnet.helius-rpc.com/?api-key=1234...ef01');
  assert.equal(maskUrl('https://api.mainnet-beta.solana.com'), 'https://api.mainnet-beta.solana.com');
  assert.equal(maskUrl(null), '');
});

test('isQuotaExhausted distinguishes quota/plan limit from burst rate limits', () => {
  assert.equal(isQuotaExhausted(new Error('Rate limit exceeded: Max usage reached')), true);
  assert.equal(isQuotaExhausted(new Error('You have reached your monthly credit limit')), true);
  assert.equal(isQuotaExhausted(new Error('Plan limit exceeded')), true);
  assert.equal(isQuotaExhausted(new Error('Too Many Requests: Rate limit exceeded (burst)')), false);
  assert.equal(isQuotaExhausted(new Error('Socket timeout')), false);
});

test('isRateLimited catches HTTP 429 and rate limit messages', () => {
  assert.equal(isRateLimited({ status: 429 }), true);
  assert.equal(isRateLimited(new Error('Too Many Requests')), true);
  assert.equal(isRateLimited(new Error('Helius API error 429: Rate limit')), true);
  assert.equal(isRateLimited(new Error('Transaction simulation failed')), false);
});

test('RPC pool parses comma-separated keys and handles rotation', () => {
  const stats = getRpcPoolStats();
  assert.ok(stats.total >= 1, 'Pool should have at least 1 URL');
  assert.ok(stats.healthy >= 1, 'Pool should have at least 1 healthy URL');

  const beforeUrl = getActiveRpcUrl();
  const conn = getConnection();
  assert.ok(conn, 'Should return active Connection');

  const rotatedConn = rotateConnection(beforeUrl, new Error('429 Too Many Requests'));
  assert.ok(rotatedConn, 'Should return new Connection after rotation');
});

test('readRpc rotates and succeeds if next endpoint succeeds', async () => {
  let callCount = 0;
  const result = await readRpc('test', async (conn) => {
    callCount++;
    if (callCount === 1) {
      const err = new Error('429 Too Many Requests (Rate limit)');
      err.status = 429;
      throw err;
    }
    return 'success-from-pool';
  });

  assert.equal(result, 'success-from-pool');
  assert.equal(callCount, 2, 'Should retry on next endpoint after 429');
});
