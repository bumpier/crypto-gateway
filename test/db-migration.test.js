'use strict';

// Runs in its own process (node --test isolates files), so DB_PATH set here
// only affects this file's require('../db').

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

// A gateway.db as the PREVIOUS release created it: no webhookUrl column.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-db-'));
const DB_PATH = path.join(dir, 'gateway.db');
const old = new Database(DB_PATH);
old.exec(`
  CREATE TABLE payments (
    paymentId TEXT PRIMARY KEY, orderId TEXT NOT NULL, currency TEXT NOT NULL,
    amount TEXT NOT NULL, wallet TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    txHash TEXT, confirmations INTEGER NOT NULL DEFAULT 0, createdAt TEXT NOT NULL,
    expiresAt TEXT NOT NULL, confirmedAt TEXT
  );
  INSERT INTO payments (paymentId, orderId, currency, amount, wallet, createdAt, expiresAt)
  VALUES ('pay_old', 'order_old', 'USDT', '100', '0xwallet', '2026-10-01T00:00:00.000Z', '2026-10-01T00:30:00.000Z');
`);
old.close();

process.env.DB_PATH = DB_PATH;
const db = require('../db');

const row = (paymentId, extra = {}) => ({
  paymentId, orderId: `order_${paymentId}`, currency: 'USDT', amount: '50', wallet: '0xwallet',
  status: 'pending', txHash: null, confirmations: 0, createdAt: '2026-10-14T00:00:00.000Z',
  expiresAt: '2026-10-14T00:30:00.000Z', confirmedAt: null, ...extra,
});

test('booting on an old database adds the webhookUrl column', () => {
  const cols = db.db.prepare('PRAGMA table_info(payments)').all().map((c) => c.name);
  assert.ok(cols.includes('webhookUrl'));
});

test('existing payments survive the upgrade, with no webhookUrl', () => {
  const p = db.getPayment('pay_old');
  assert.equal(p.orderId, 'order_old');
  assert.equal(p.webhookUrl, null);
});

test('a payment stores the webhookUrl it was created with', () => {
  db.insertPayment(row('pay_ph', { webhookUrl: 'https://shifalabsphilippines.com/api/crypto-webhook' }));
  assert.equal(db.getPayment('pay_ph').webhookUrl, 'https://shifalabsphilippines.com/api/crypto-webhook');
});

test('a payment created without one stores NULL', () => {
  db.insertPayment(row('pay_default'));
  assert.equal(db.getPayment('pay_default').webhookUrl, null);
});

test('re-running the migration is harmless', () => {
  delete require.cache[require.resolve('../db')];
  assert.doesNotThrow(() => require('../db'));
});
