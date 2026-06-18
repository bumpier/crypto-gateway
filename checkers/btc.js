'use strict';

const axios = require('axios');
const ecc = require('tiny-secp256k1');
const { BIP32Factory } = require('bip32');
const bitcoin = require('bitcoinjs-lib');
const bs58check = require('bs58check');

const bip32 = BIP32Factory(ecc);
const XPUB_VERSION = 0x0488b21e;

// Accept xpub/ypub/zpub: the key material is identical, only the 4 version
// bytes differ. We rewrite them to xpub so bip32.fromBase58 accepts the key;
// the address type comes from how we build the payment (P2WPKH), not the prefix.
function normalizeToXpub(extKey) {
  const data = Buffer.from(bs58check.decode(extKey));
  if (data.readUInt32BE(0) === XPUB_VERSION) return extKey;
  data.writeUInt32BE(XPUB_VERSION, 0);
  return bs58check.encode(data);
}

// Derive the external-chain P2WPKH address at 0/index from an account xpub.
function deriveAddress(xpub, index) {
  if (!xpub) throw new Error('BTC_XPUB not configured');
  const node = bip32.fromBase58(normalizeToXpub(xpub));
  const child = node.derive(0).derive(index);
  const { address } = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(child.publicKey) });
  if (!address) throw new Error('BTC: failed to derive P2WPKH address');
  return address;
}

async function provisionAddress({ cfg, index }) {
  return { address: deriveAddress(cfg.xpub, index), addressIndex: index };
}

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

module.exports = { getIncoming, deriveAddress, provisionAddress };
