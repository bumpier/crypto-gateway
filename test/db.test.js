'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

function freshDb(dbPath) {
  process.env.DB_PATH = dbPath;
  delete require.cache[require.resolve('../db')];
  return require('../db');
}

test('allocateIndex is monotonic, per-currency, and persists across reopen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'));
  const dbPath = path.join(dir, 'test.db');

  let db = freshDb(dbPath);
  assert.strictEqual(db.allocateIndex('BTC'), 0);
  assert.strictEqual(db.allocateIndex('BTC'), 1);
  assert.strictEqual(db.allocateIndex('ETH'), 0); // independent counter
  assert.strictEqual(db.allocateIndex('BTC'), 2);
  db.db.close();

  db = freshDb(dbPath); // reopen same file
  assert.strictEqual(db.allocateIndex('BTC'), 3); // persisted, no reuse
  db.db.close();
});

test('insertPayment stores addressIndex and getPayment returns it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-'));
  const db = freshDb(path.join(dir, 'p.db'));
  db.insertPayment({
    paymentId: 'pay_x', orderId: 'o1', currency: 'BTC', amount: '0.001',
    wallet: 'bc1qexample', status: 'pending', txHash: null, confirmations: 0,
    addressIndex: 7, createdAt: 'now', expiresAt: 'later', confirmedAt: null,
  });
  assert.strictEqual(db.getPayment('pay_x').addressIndex, 7);
  db.db.close();
});
