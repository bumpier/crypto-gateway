'use strict';

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'gateway.db');
const db = new Database(DB_PATH);

// WAL gives us concurrent reads while the poller writes.
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS payments (
    paymentId     TEXT PRIMARY KEY,
    orderId       TEXT NOT NULL,
    currency      TEXT NOT NULL,
    amount        TEXT NOT NULL,
    wallet        TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    txHash        TEXT,
    confirmations INTEGER NOT NULL DEFAULT 0,
    createdAt     TEXT NOT NULL,
    expiresAt     TEXT NOT NULL,
    confirmedAt   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_payments_status   ON payments(status);
  CREATE INDEX IF NOT EXISTS idx_payments_currency ON payments(currency);
  CREATE INDEX IF NOT EXISTS idx_payments_txhash   ON payments(txHash);
`);

// --- migration: addressIndex column (SQLite has no ADD COLUMN IF NOT EXISTS) ---
const paymentCols = db.prepare(`PRAGMA table_info(payments)`).all();
if (!paymentCols.some((c) => c.name === 'addressIndex')) {
  db.exec(`ALTER TABLE payments ADD COLUMN addressIndex INTEGER`);
}

// --- per-currency monotonic address index counter ---
db.exec(`
  CREATE TABLE IF NOT EXISTS address_counters (
    currency  TEXT PRIMARY KEY,
    nextIndex INTEGER NOT NULL DEFAULT 0
  );
`);

const statements = {
  insert: db.prepare(`
    INSERT INTO payments
      (paymentId, orderId, currency, amount, wallet, status, txHash, confirmations, addressIndex, createdAt, expiresAt, confirmedAt)
    VALUES
      (@paymentId, @orderId, @currency, @amount, @wallet, @status, @txHash, @confirmations, @addressIndex, @createdAt, @expiresAt, @confirmedAt)
  `),
  // Atomic single-statement index allocation. Returns the index just handed out
  // (0-based). better-sqlite3 v11 bundles SQLite >= 3.35 (RETURNING supported).
  allocate: db.prepare(`
    INSERT INTO address_counters (currency, nextIndex) VALUES (?, 1)
    ON CONFLICT(currency) DO UPDATE SET nextIndex = nextIndex + 1
    RETURNING nextIndex - 1 AS allocated
  `),
  get: db.prepare(`SELECT * FROM payments WHERE paymentId = ?`),
  list: db.prepare(`SELECT * FROM payments ORDER BY createdAt DESC`),
  pendingByCurrency: db.prepare(`SELECT * FROM payments WHERE status = 'pending' AND currency = ?`),
  // A tx is "used" if any OTHER payment already references it — prevents one
  // on-chain transaction from settling two different orders.
  txHashUsed: db.prepare(`SELECT 1 FROM payments WHERE txHash = ? AND paymentId != ? LIMIT 1`),
  // Detected but not yet enough confirmations: record progress, stay pending.
  markDetected: db.prepare(`UPDATE payments SET txHash = ?, confirmations = ? WHERE paymentId = ?`),
  markConfirmed: db.prepare(`
    UPDATE payments SET status = 'confirmed', txHash = ?, confirmations = ?, confirmedAt = ?
    WHERE paymentId = ?
  `),
  // Only expire untouched payments. Once a tx is detected (txHash set) we keep
  // polling past the window until it reaches the confirmation threshold.
  expire: db.prepare(`
    UPDATE payments SET status = 'expired'
    WHERE status = 'pending' AND txHash IS NULL AND expiresAt < ?
  `),
};

module.exports = {
  db,
  insertPayment(row) {
    return statements.insert.run(row);
  },
  getPayment(paymentId) {
    return statements.get.get(paymentId);
  },
  listPayments() {
    return statements.list.all();
  },
  getPendingByCurrency(currency) {
    return statements.pendingByCurrency.all(currency);
  },
  allocateIndex(currency) {
    return statements.allocate.get(currency).allocated;
  },
  txHashUsed(txHash, exceptPaymentId) {
    if (!txHash) return false;
    return !!statements.txHashUsed.get(txHash, exceptPaymentId);
  },
  markDetected(paymentId, txHash, confirmations) {
    return statements.markDetected.run(txHash, confirmations, paymentId);
  },
  markConfirmed(paymentId, txHash, confirmations, confirmedAt) {
    return statements.markConfirmed.run(txHash, confirmations, confirmedAt, paymentId);
  },
  expirePending(nowIso) {
    return statements.expire.run(nowIso).changes;
  },
};
