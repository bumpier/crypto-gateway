'use strict';

require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const axios = require('axios');

const db = require('./db');
const { matchPayments } = require('./match');
const { allowedWebhookUrls, resolveWebhookUrl } = require('./webhooks');

const checkers = {
  BTC: require('./checkers/btc'),
  ETH: require('./checkers/eth'),
  USDT: require('./checkers/usdt'),
  XMR: require('./checkers/xmr'),
};

// --------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 3000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 30000);
const EXPIRY_MINUTES = Number(process.env.EXPIRY_MINUTES || 30);
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
// Extra destinations a caller may choose per payment (comma-separated), on top
// of the default WEBHOOK_URL — one gateway serving several shops.
const ALLOWED_WEBHOOK_URLS = allowedWebhookUrls(WEBHOOK_URL, process.env.WEBHOOK_URLS);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const CONFIG = {
  blockstreamApi: process.env.BLOCKSTREAM_API || 'https://blockstream.info/api',
  etherscanApi: process.env.ETHERSCAN_API || 'https://api.etherscan.io/v2/api',
  etherscanApiKey: process.env.ETHERSCAN_API_KEY || '',
  trongridApiKey: process.env.TRONGRID_API_KEY || '',
  usdtContract: process.env.USDT_CONTRACT || '0xdAC17F958D2ee523a2206206994597C13D831ec7',
  xmrWalletRpc: process.env.XMR_WALLET_RPC || 'http://127.0.0.1:18082/json_rpc',
};

const ADDRESSES = {
  BTC: process.env.BTC_ADDRESS || '',
  ETH: process.env.ETH_ADDRESS || '',
  USDT: process.env.USDT_ADDRESS || '',
  XMR: process.env.XMR_ADDRESS || '',
};

const CONFIRMATIONS = {
  BTC: Number(process.env.CONFIRMATIONS_BTC || 1),
  ETH: Number(process.env.CONFIRMATIONS_ETH || 12),
  USDT: Number(process.env.CONFIRMATIONS_USDT || 1),
  XMR: Number(process.env.CONFIRMATIONS_XMR || 10),
};

// Tolerance when matching a received amount to an expected amount, per currency.
// We require received >= expected - epsilon (i.e. underpayments do NOT settle).
const AMOUNT_EPSILON = {
  BTC: 1e-8,
  ETH: 1e-9,
  USDT: 1e-6,
  XMR: 1e-9,
};

const CURRENCIES = Object.keys(checkers);

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function newPaymentId() {
  return 'pay_' + crypto.randomBytes(12).toString('hex');
}

// Decimal string -> wei string, without floating point.
function toWei(amountStr) {
  const [whole, frac = ''] = String(amountStr).split('.');
  const fracPadded = (frac + '0'.repeat(18)).slice(0, 18);
  return (BigInt(whole || '0') * 10n ** 18n + BigInt(fracPadded || '0')).toString();
}

// Build a wallet-friendly payment URI to encode in the QR code.
function toQrPayload(currency, address, amount) {
  switch (currency) {
    case 'BTC': return `bitcoin:${address}?amount=${amount}`;
    case 'ETH': return `ethereum:${address}?value=${toWei(amount)}`;
    case 'XMR': return `monero:${address}?tx_amount=${amount}`;
    case 'USDT': return address; // no widely-supported TRON payment URI scheme
    default: return address;
  }
}

async function qrDataUrl(currency, address, amount) {
  try {
    return await QRCode.toDataURL(toQrPayload(currency, address, amount), {
      width: 280,
      margin: 1,
    });
  } catch (_) {
    return null;
  }
}

function publicView(row, extra = {}) {
  if (!row) return null;
  return {
    paymentId: row.paymentId,
    orderId: row.orderId,
    currency: row.currency,
    amount: row.amount,
    wallet: row.wallet,
    status: row.status,
    txHash: row.txHash,
    confirmations: row.confirmations,
    confirmationsRequired: CONFIRMATIONS[row.currency],
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    confirmedAt: row.confirmedAt,
    ...extra,
  };
}

// --------------------------------------------------------------------------
// Webhooks
// --------------------------------------------------------------------------

async function fireWebhook(payload, url = WEBHOOK_URL) {
  if (!url) {
    return { ok: false, error: 'WEBHOOK_URL not configured' };
  }
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json' };
  if (WEBHOOK_SECRET) {
    headers['X-Webhook-Signature'] =
      'sha256=' + crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
  }
  try {
    const res = await axios.post(url, body, { headers, timeout: 8000 });
    return { ok: true, status: res.status };
  } catch (err) {
    const status = err.response ? err.response.status : null;
    console.error(`[webhook] delivery failed (${status || 'no response'}): ${err.message}`);
    return { ok: false, status, error: err.message };
  }
}

// --------------------------------------------------------------------------
// Polling engine
// --------------------------------------------------------------------------

async function pollCurrency(currency) {
  const pending = db.getPendingByCurrency(currency);
  if (!pending.length) return;

  const address = ADDRESSES[currency];
  if (!address) return;

  let incoming;
  try {
    incoming = await checkers[currency].getIncoming(address, CONFIG);
  } catch (err) {
    console.error(`[poll ${currency}] ${err.message}`);
    return;
  }

  const required = CONFIRMATIONS[currency];
  // Closest-fit matching, one tx -> one order (see match.js).
  const matches = matchPayments(pending, incoming, {
    epsilon: AMOUNT_EPSILON[currency] || 0,
    isTxUsed: (txHash, paymentId) => db.txHashUsed(txHash, paymentId),
  });

  for (const { payment: p, tx: match } of matches) {
    if (match.confirmations >= required) {
      if (p.status !== 'confirmed') {
        db.markConfirmed(p.paymentId, match.txHash, match.confirmations, new Date().toISOString());
        const fresh = db.getPayment(p.paymentId);
        console.log(`[poll ${currency}] CONFIRMED ${p.paymentId} (order ${p.orderId}) tx=${match.txHash}`);
        fireWebhook({ event: 'payment.confirmed', payment: publicView(fresh) }, fresh.webhookUrl || WEBHOOK_URL);
      }
    } else {
      // Seen on-chain but not deep enough yet — record progress, keep polling.
      db.markDetected(p.paymentId, match.txHash, match.confirmations);
    }
  }
}

async function poll() {
  try {
    const expired = db.expirePending(new Date().toISOString());
    if (expired) console.log(`[poll] expired ${expired} unpaid payment(s)`);
  } catch (err) {
    console.error(`[poll] expiry sweep failed: ${err.message}`);
  }

  for (const currency of CURRENCIES) {
    await pollCurrency(currency);
  }
}

// --------------------------------------------------------------------------
// HTTP API
// --------------------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: 'ADMIN_TOKEN not configured on the server' });
  }
  const provided = req.get('x-admin-token') || req.query.token;
  if (provided !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    currencies: CURRENCIES.filter((c) => ADDRESSES[c]),
    pollIntervalMs: POLL_INTERVAL_MS,
    expiryMinutes: EXPIRY_MINUTES,
  });
});

// POST /create-payment { amount, orderId, currency, webhookUrl? }
app.post('/create-payment', async (req, res) => {
  const { amount, orderId, currency, webhookUrl } = req.body || {};

  // Optional per-payment destination for the confirmation webhook (allowlisted).
  const hook = resolveWebhookUrl(webhookUrl, ALLOWED_WEBHOOK_URLS);
  if (!hook.ok) {
    return res.status(400).json({ error: 'webhookUrl is not allowed' });
  }

  if (!currency || !CURRENCIES.includes(currency)) {
    return res.status(400).json({ error: `currency must be one of ${CURRENCIES.join(', ')}` });
  }
  const amountNum = parseFloat(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }
  if (!orderId || typeof orderId !== 'string') {
    return res.status(400).json({ error: 'orderId is required' });
  }
  const address = ADDRESSES[currency];
  if (!address) {
    return res.status(400).json({ error: `${currency} is not configured on this gateway` });
  }

  const now = new Date();
  const row = {
    paymentId: newPaymentId(),
    orderId,
    currency,
    amount: String(amount),
    wallet: address,
    status: 'pending',
    txHash: null,
    confirmations: 0,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + EXPIRY_MINUTES * 60_000).toISOString(),
    confirmedAt: null,
    webhookUrl: hook.url, // null = WEBHOOK_URL
  };

  try {
    db.insertPayment(row);
  } catch (err) {
    console.error(`[create-payment] db insert failed: ${err.message}`);
    return res.status(500).json({ error: 'failed to create payment' });
  }

  const qr = await qrDataUrl(currency, address, row.amount);
  res.status(201).json(publicView(row, { qr, uri: toQrPayload(currency, address, row.amount) }));
});

// GET /payment-status/:paymentId
app.get('/payment-status/:paymentId', async (req, res) => {
  const row = db.getPayment(req.params.paymentId);
  if (!row) return res.status(404).json({ error: 'payment not found' });
  const qr = await qrDataUrl(row.currency, row.wallet, row.amount);
  res.json(publicView(row, { qr, uri: toQrPayload(row.currency, row.wallet, row.amount) }));
});

// GET /payments  (admin — lists every payment)
app.get('/payments', requireAdmin, (_req, res) => {
  res.json(db.listPayments().map((r) => publicView(r)));
});

// POST /webhook-test  (admin — fires a sample webhook so you can verify wiring)
// Optional { url } (or ?url=) targets one allowlisted site; default WEBHOOK_URL.
app.post('/webhook-test', requireAdmin, async (req, res) => {
  const hook = resolveWebhookUrl((req.body && req.body.url) || req.query.url, ALLOWED_WEBHOOK_URLS);
  if (!hook.ok) {
    return res.status(400).json({ error: 'url is not allowed' });
  }
  const result = await fireWebhook({
    event: 'payment.confirmed',
    test: true,
    payment: {
      paymentId: 'pay_test',
      orderId: 'order_test',
      currency: 'BTC',
      amount: '0.001',
      status: 'confirmed',
      txHash: '0000000000000000000000000000000000000000000000000000000000000000',
    },
  }, hook.url || WEBHOOK_URL);
  res.status(result.ok ? 200 : 502).json(result);
});

// --------------------------------------------------------------------------
// Boot
// --------------------------------------------------------------------------

const server = app.listen(PORT, () => {
  const configured = CURRENCIES.filter((c) => ADDRESSES[c]);
  console.log(`crypto-gateway listening on :${PORT}`);
  console.log(`  configured currencies : ${configured.length ? configured.join(', ') : '(none — set *_ADDRESS in .env)'}`);
  console.log(`  poll interval         : ${POLL_INTERVAL_MS}ms`);
  console.log(`  expiry window         : ${EXPIRY_MINUTES} min`);
  console.log(`  webhook               : ${WEBHOOK_URL ? WEBHOOK_URL : '(not configured)'}`);
  console.log(`  allowed webhooks      : ${ALLOWED_WEBHOOK_URLS.size ? [...ALLOWED_WEBHOOK_URLS].join(', ') : '(none)'}`);

  // Run an initial sweep shortly after boot, then on the configured interval.
  setTimeout(() => { poll(); }, 2000);
  setInterval(() => { poll(); }, POLL_INTERVAL_MS);
});

function shutdown(signal) {
  console.log(`\n${signal} received — shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = app;
