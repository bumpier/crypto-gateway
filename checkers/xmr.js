'use strict';

const axios = require('axios');

/**
 * Monero checker — talks to a local monero-wallet-rpc via `get_transfers`.
 *
 * Monero is private: an incoming transfer does NOT expose a destination address
 * we can filter on. Instead each payment gets its own subaddress (see
 * provisionAddress below), and every transfer carries the `subaddr_index.minor`
 * it landed on — the server matches on that. The `address` argument is accepted
 * for interface symmetry but unused.
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
      subaddrIndex: t.subaddr_index ? Number(t.subaddr_index.minor) : null,
    });
  }

  return out;
}

// Create a fresh subaddress for one payment. Label it with the orderId so the
// transfer is easy to identify in the wallet. The wallet assigns the index.
async function provisionAddress({ cfg, orderId }) {
  const res = await axios.post(
    cfg.xmrWalletRpc,
    {
      jsonrpc: '2.0',
      id: '0',
      method: 'create_address',
      params: { account_index: Number(cfg.xmrAccountIndex || 0), label: orderId || '' },
    },
    { timeout: 15000, headers: { 'Content-Type': 'application/json' } }
  );

  if (res.data && res.data.error) {
    throw new Error(`monero-wallet-rpc: ${res.data.error.message || JSON.stringify(res.data.error)}`);
  }
  const result = (res.data && res.data.result) || {};
  if (!result.address) throw new Error('monero-wallet-rpc: create_address returned no address');
  return { address: result.address, addressIndex: Number(result.address_index) };
}

module.exports = { getIncoming, provisionAddress };
