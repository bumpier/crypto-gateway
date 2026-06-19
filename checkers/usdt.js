'use strict';

const axios = require('axios');

/**
 * USDT (ERC-20) checker — Etherscan API v2 (chainid=1 mainnet).
 *
 * Detects incoming USDT ERC-20 token transfers to the watched address by
 * reading the token-transfer event log (`tokentx`) for the USDT contract.
 * (Native ETH transfers are handled separately in checkers/eth.js.)
 *
 * USDT_CONTRACT must be the Ethereum USDT contract
 * (0xdAC17F958D2ee523a2206206994597C13D831ec7), NOT a Tron address.
 */
async function getIncoming(address, cfg) {
  const url = cfg.etherscanApi || 'https://api.etherscan.io/v2/api';
  const contract = cfg.usdtContract || '0xdAC17F958D2ee523a2206206994597C13D831ec7';
  const target = String(address).toLowerCase();

  const res = await axios.get(url, {
    timeout: 15000,
    params: {
      chainid: 1,
      module: 'account',
      action: 'tokentx',
      contractaddress: contract,
      address,
      page: 1,
      offset: 100,
      sort: 'desc',
      apikey: cfg.etherscanApiKey || '',
    },
  });

  const data = res.data || {};
  const result = data.result;

  // Etherscan returns status '0' + "No transactions found" with an empty result
  // for a quiet address — that's normal. Any other non-array result (bad key,
  // rate limit) is surfaced so the poller logs it instead of silently stalling.
  if (!Array.isArray(result)) {
    if (data.status === '0' && /no transactions/i.test(data.message || '')) return [];
    const detail = typeof result === 'string' ? ` (${result})` : '';
    throw new Error(`etherscan tokentx: ${data.message || 'unexpected response'}${detail}`);
  }

  const out = [];
  for (const t of result) {
    if ((t.to || '').toLowerCase() !== target) continue;                                 // incoming only
    if ((t.contractAddress || '').toLowerCase() !== contract.toLowerCase()) continue;    // USDT only
    const decimals = Number(t.tokenDecimal || 6);
    const raw = BigInt(t.value || '0');
    if (raw <= 0n) continue;

    out.push({
      txHash: t.hash,
      amount: Number(raw) / Math.pow(10, decimals),
      confirmations: Number(t.confirmations || 0),
      timestamp: Number(t.timeStamp || 0),
    });
  }

  return out;
}

module.exports = { getIncoming };
