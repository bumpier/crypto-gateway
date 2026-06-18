'use strict';

const axios = require('axios');

/**
 * Ethereum checker — Etherscan API v2 (multichain, chainid=1 mainnet).
 *
 * Detects NATIVE ETH transfers into the watched address. ERC-20 token transfers
 * and internal (contract) transfers are intentionally NOT covered here — those
 * would need the `tokentx` / `txlistinternal` actions respectively.
 */
async function getIncoming(address, cfg) {
  const url = cfg.etherscanApi || 'https://api.etherscan.io/v2/api';
  const target = String(address).toLowerCase();

  const res = await axios.get(url, {
    timeout: 15000,
    params: {
      chainid: 1,
      module: 'account',
      action: 'txlist',
      address,
      startblock: 0,
      endblock: 99999999,
      sort: 'desc',
      apikey: cfg.etherscanApiKey || '',
    },
  });

  const data = res.data || {};
  // status '0' with an empty result just means "no transactions found".
  const txs = Array.isArray(data.result) ? data.result : [];
  const out = [];

  for (const tx of txs) {
    if ((tx.to || '').toLowerCase() !== target) continue; // incoming only
    if (tx.isError === '1') continue;                      // failed tx
    const wei = BigInt(tx.value || '0');
    if (wei <= 0n) continue;

    out.push({
      txHash: tx.hash,
      amount: Number(wei) / 1e18,
      confirmations: Number(tx.confirmations || 0),
      timestamp: Number(tx.timeStamp || 0),
    });
  }

  return out;
}

module.exports = { getIncoming };
