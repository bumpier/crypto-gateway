'use strict';

const axios = require('axios');

/**
 * Bitcoin checker — Blockstream Esplora API (no key required).
 *
 * Returns every transaction that pays the watched address, normalized to:
 *   { txHash, amount (BTC), confirmations, timestamp (unix seconds) }
 */
async function getIncoming(address, cfg) {
  const base = (cfg.blockstreamApi || 'https://blockstream.info/api').replace(/\/$/, '');

  const [txsRes, tipRes] = await Promise.all([
    axios.get(`${base}/address/${address}/txs`, { timeout: 15000 }),
    axios.get(`${base}/blocks/tip/height`, { timeout: 15000 }),
  ]);

  const tipHeight = Number(tipRes.data);
  const txs = Array.isArray(txsRes.data) ? txsRes.data : [];
  const out = [];

  for (const tx of txs) {
    // Sum the outputs that actually credit our address.
    let sats = 0;
    for (const vout of tx.vout || []) {
      if (vout.scriptpubkey_address === address) sats += Number(vout.value || 0);
    }
    if (sats <= 0) continue;

    const confirmed = !!(tx.status && tx.status.confirmed);
    const confirmations = confirmed
      ? Math.max(1, tipHeight - tx.status.block_height + 1)
      : 0; // still in mempool

    out.push({
      txHash: tx.txid,
      amount: sats / 1e8,
      confirmations,
      timestamp: confirmed && tx.status.block_time
        ? tx.status.block_time
        : Math.floor(Date.now() / 1000),
    });
  }

  return out;
}

module.exports = { getIncoming };
