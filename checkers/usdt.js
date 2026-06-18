'use strict';

const axios = require('axios');

/**
 * USDT (TRC-20) checker — TronGrid API.
 *
 * Queries confirmed TRC-20 transfers of the USDT contract into the watched
 * address. TronGrid's trc20 endpoint does not expose a confirmation depth, and
 * `only_confirmed=true` already means the transfer is in a finalized block, so
 * confirmed transfers are reported with confirmations = 1. Pair this with
 * CONFIRMATIONS_USDT=1 (the default).
 */
async function getIncoming(address, cfg) {
  const res = await axios.get(
    `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20`,
    {
      timeout: 15000,
      params: {
        contract_address: cfg.usdtContract,
        only_to: true,
        only_confirmed: true,
        limit: 50,
      },
      headers: cfg.trongridApiKey ? { 'TRON-PRO-API-KEY': cfg.trongridApiKey } : {},
    }
  );

  const transfers = (res.data && Array.isArray(res.data.data)) ? res.data.data : [];
  const out = [];

  for (const t of transfers) {
    if ((t.to || '') !== address) continue;
    if (t.type && t.type !== 'Transfer') continue;

    const decimals = (t.token_info && Number(t.token_info.decimals)) || 6;
    const raw = BigInt(t.value || '0');
    if (raw <= 0n) continue;

    out.push({
      txHash: t.transaction_id,
      amount: Number(raw) / Math.pow(10, decimals),
      confirmations: 1,
      timestamp: Math.floor(Number(t.block_timestamp || 0) / 1000),
    });
  }

  return out;
}

module.exports = { getIncoming };
