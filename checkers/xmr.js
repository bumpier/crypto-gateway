'use strict';

const axios = require('axios');

/**
 * Monero checker — talks to a local monero-wallet-rpc via `get_transfers`.
 *
 * IMPORTANT: Monero is private. Unlike the other chains, an incoming transfer
 * does NOT expose a destination address we can filter on, so matching is done
 * purely by amount (and, ideally, payment_id / subaddress — see README). The
 * `address` argument is accepted for interface symmetry but unused.
 *
 * Run monero-wallet-rpc with --disable-rpc-login (or this client must implement
 * HTTP digest auth, which axios does not do out of the box).
 */
async function getIncoming(_address, cfg) {
  const res = await axios.post(
    cfg.xmrWalletRpc,
    {
      jsonrpc: '2.0',
      id: '0',
      method: 'get_transfers',
      params: { in: true, pool: true, pending: true },
    },
    { timeout: 15000, headers: { 'Content-Type': 'application/json' } }
  );

  if (res.data && res.data.error) {
    throw new Error(`monero-wallet-rpc: ${res.data.error.message || JSON.stringify(res.data.error)}`);
  }

  const result = (res.data && res.data.result) || {};
  const transfers = [
    ...(result.in || []),
    ...(result.pool || []),
    ...(result.pending || []),
  ];

  const out = [];
  for (const t of transfers) {
    const xmr = Number(t.amount || 0) / 1e12; // atomic units -> XMR
    if (xmr <= 0) continue;
    out.push({
      txHash: t.txid,
      amount: xmr,
      confirmations: Number(t.confirmations || 0),
      timestamp: Number(t.timestamp || 0),
      paymentId: t.payment_id || null,
    });
  }

  return out;
}

module.exports = { getIncoming };
