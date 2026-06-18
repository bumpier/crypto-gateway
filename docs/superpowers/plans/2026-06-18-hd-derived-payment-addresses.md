# HD-Derived Payment Addresses Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every payment a unique receive address (BTC/ETH via xpub derivation, XMR via wallet-rpc subaddress) so invoices can never be confused by amount; USDT stays static.

**Architecture:** Each currency has an addressing *mode* (`derived` | `static` | `subaddress`) that drives both provisioning at `create-payment` and matching in the poller. A SQLite counter hands out monotonic indices for BTC/ETH; the `payments.wallet` column already carries the per-row address into the QR/URI and matcher, so derived addresses slot straight in.

**Tech Stack:** Node.js (CommonJS), Express, better-sqlite3, bitcoinjs-lib + bip32 + tiny-secp256k1 + bs58check (BTC), ethereumjs-wallet (ETH), axios (XMR RPC), node:test.

## Global Constraints

- Node.js ≥ 18; CommonJS (`require`), `'use strict'` at top of every file — match existing style.
- **Fail-closed:** if provisioning fails, return 5xx and DO NOT insert the payment. Never fall back to a static/shared address for BTC/ETH/XMR.
- BTC: `BTC_XPUB` = account key (`m/84'/0'/0'`); derive external chain `0/index`; build P2WPKH (`bc1q…`). Accept xpub/ypub/zpub (normalize version bytes to xpub).
- ETH: `ETH_XPUB` = account key (`m/44'/60'/0'`); derive `0/index`; EIP-55 checksummed address.
- XMR: subaddress index is wallet-assigned (`create_address` → `address_index`), NOT from our counter. Label = `orderId`.
- `addressIndex` persisted on every payment row (NULL for USDT and legacy rows).
- All amounts/epsilon/confirmation logic unchanged; underpayments still don't settle.

---

### Task 1: Add dependencies and the test script

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: the `bitcoinjs-lib`, `bip32`, `tiny-secp256k1`, `bs58check`, `ethereumjs-wallet` modules available to require; `npm test` runs `node --test`.

- [ ] **Step 1: Install runtime deps**

Run:
```bash
npm install bitcoinjs-lib@^6.1.6 bip32@^4.0.0 tiny-secp256k1@^2.2.3 bs58check@^3.0.1 ethereumjs-wallet@^1.0.2
```
Expected: installs without a native-build failure (tiny-secp256k1 v2 is WASM, no node-gyp).

- [ ] **Step 2: Verify the crypto libs load**

Run:
```bash
node -e "const ecc=require('tiny-secp256k1');const {BIP32Factory}=require('bip32');BIP32Factory(ecc);require('bitcoinjs-lib');require('bs58check');require('ethereumjs-wallet').hdkey;console.log('ok')"
```
Expected: prints `ok`. If `bip32` rejects the ecc backend, bump `tiny-secp256k1` to the version `bip32` peer-requires and retry.

- [ ] **Step 3: Add the test script**

In `package.json` `"scripts"`, add:
```json
"test": "node --test"
```

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add HD-derivation deps (bitcoinjs-lib, bip32, ethereumjs-wallet) + test script"
```

---

### Task 2: SQLite — addressIndex column, counter table, allocateIndex

**Files:**
- Modify: `db.js`
- Test: `test/db.test.js`

**Interfaces:**
- Produces:
  - `db.allocateIndex(currency: string): number` — returns the next index (starting at 0), atomically increments the persisted counter for that currency.
  - `db.insertPayment(row)` now also reads `row.addressIndex` (integer | null).
  - `payments` gains an `addressIndex INTEGER` column.

- [ ] **Step 1: Write the failing test**

Create `test/db.test.js`:
```js
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/db.test.js`
Expected: FAIL — `db.allocateIndex is not a function` (and/or addressIndex column missing).

- [ ] **Step 3: Implement the migration, counter table, and allocator**

In `db.js`, after the existing `db.exec(\`CREATE TABLE IF NOT EXISTS payments …\`)` block (currently lines 12-29), add:
```js
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
```

Change the `insert` prepared statement (currently lines 32-37) to include `addressIndex`:
```js
  insert: db.prepare(`
    INSERT INTO payments
      (paymentId, orderId, currency, amount, wallet, status, txHash, confirmations, addressIndex, createdAt, expiresAt, confirmedAt)
    VALUES
      (@paymentId, @orderId, @currency, @amount, @wallet, @status, @txHash, @confirmations, @addressIndex, @createdAt, @expiresAt, @confirmedAt)
  `),
```

Add an `allocate` statement inside the `statements` object (atomic single-statement upsert using RETURNING; better-sqlite3 v11 bundles SQLite ≥ 3.35):
```js
  allocate: db.prepare(`
    INSERT INTO address_counters (currency, nextIndex) VALUES (?, 1)
    ON CONFLICT(currency) DO UPDATE SET nextIndex = nextIndex + 1
    RETURNING nextIndex - 1 AS allocated
  `),
```

Add the exported method to the `module.exports` object:
```js
  allocateIndex(currency) {
    return statements.allocate.get(currency).allocated;
  },
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/db.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add db.js test/db.test.js
git commit -m "feat(db): addressIndex column + monotonic per-currency index allocator"
```

---

### Task 3: BTC address derivation + provisionAddress

**Files:**
- Modify: `checkers/btc.js`
- Test: `test/derive.test.js` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `btc.deriveAddress(xpub: string, index: number): string` — P2WPKH `bc1q…`.
  - `btc.provisionAddress({ cfg: { xpub }, index }): Promise<{ address: string, addressIndex: number }>`.

- [ ] **Step 1: Write the failing test**

Create `test/derive.test.js`:
```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ecc = require('tiny-secp256k1');
const { BIP32Factory } = require('bip32');
const bs58check = require('bs58check');
const bip32 = BIP32Factory(ecc);
const btc = require('../checkers/btc');

// BIP39 seed for the BIP84 test-vector mnemonic
// "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
const SEED = Buffer.from(
  '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc1' +
  '9a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4',
  'hex'
);
const ACCOUNT_XPUB = bip32.fromSeed(SEED).derivePath("m/84'/0'/0'").neutered().toBase58();

test('BTC derives BIP84 vector addresses from the account xpub', () => {
  assert.strictEqual(btc.deriveAddress(ACCOUNT_XPUB, 0), 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  assert.strictEqual(btc.deriveAddress(ACCOUNT_XPUB, 1), 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g');
});

test('BTC accepts a zpub (version-byte normalization)', () => {
  const data = Buffer.from(bs58check.decode(ACCOUNT_XPUB));
  data.writeUInt32BE(0x04b24746, 0); // zpub version bytes
  const zpub = bs58check.encode(data);
  assert.strictEqual(btc.deriveAddress(zpub, 0), 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
});

test('BTC provisionAddress returns address + the passed index', async () => {
  const out = await btc.provisionAddress({ cfg: { xpub: ACCOUNT_XPUB }, index: 1 });
  assert.deepStrictEqual(out, { address: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g', addressIndex: 1 });
});

test('BTC deriveAddress throws on empty xpub (fail-closed)', () => {
  assert.throws(() => btc.deriveAddress('', 0), /BTC_XPUB/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/derive.test.js`
Expected: FAIL — `btc.deriveAddress is not a function`.

- [ ] **Step 3: Implement derivation in `checkers/btc.js`**

At the top of `checkers/btc.js`, below `const axios = require('axios');`, add:
```js
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
```

Change the bottom export from `module.exports = { getIncoming };` to:
```js
module.exports = { getIncoming, deriveAddress, provisionAddress };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/derive.test.js`
Expected: PASS for the 4 BTC tests. If an address mismatches, confirm the expected values against the BIP84 test vectors in the BIP-0084 spec and correct the literals (the seed + derivation are authoritative).

- [ ] **Step 5: Commit**

```bash
git add checkers/btc.js test/derive.test.js
git commit -m "feat(btc): derive unique P2WPKH addresses from xpub (bip32 + bitcoinjs-lib)"
```

---

### Task 4: ETH address derivation + provisionAddress

**Files:**
- Modify: `checkers/eth.js`
- Test: `test/derive.test.js` (append)

**Interfaces:**
- Produces:
  - `eth.deriveAddress(xpub: string, index: number): string` — EIP-55 `0x…`.
  - `eth.provisionAddress({ cfg: { xpub }, index }): Promise<{ address: string, addressIndex: number }>`.

- [ ] **Step 1: Append the failing test**

Append to `test/derive.test.js`:
```js
const { hdkey } = require('ethereumjs-wallet');
const eth = require('../checkers/eth');

// account xpub at m/44'/60'/0' from the same well-known seed
const ETH_ACCOUNT_XPUB = hdkey.fromMasterSeed(SEED).derivePath("m/44'/60'/0'").publicExtendedKey();

test('ETH derives the canonical vector address from the account xpub', () => {
  assert.strictEqual(eth.deriveAddress(ETH_ACCOUNT_XPUB, 0), '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
});

test('ETH provisionAddress returns address + the passed index', async () => {
  const out = await eth.provisionAddress({ cfg: { xpub: ETH_ACCOUNT_XPUB }, index: 0 });
  assert.deepStrictEqual(out, { address: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', addressIndex: 0 });
});

test('ETH deriveAddress throws on empty xpub (fail-closed)', () => {
  assert.throws(() => eth.deriveAddress('', 0), /ETH_XPUB/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/derive.test.js`
Expected: FAIL — `eth.deriveAddress is not a function`.

- [ ] **Step 3: Implement derivation in `checkers/eth.js`**

At the top of `checkers/eth.js`, below `const axios = require('axios');`, add:
```js
const { hdkey } = require('ethereumjs-wallet');

// Derive the address at 0/index from an account-level xpub (m/44'/60'/0').
function deriveAddress(xpub, index) {
  if (!xpub) throw new Error('ETH_XPUB not configured');
  const wallet = hdkey.fromExtendedKey(xpub).deriveChild(0).deriveChild(index).getWallet();
  return wallet.getChecksumAddressString();
}

async function provisionAddress({ cfg, index }) {
  return { address: deriveAddress(cfg.xpub, index), addressIndex: index };
}
```

Change the bottom export from `module.exports = { getIncoming };` to:
```js
module.exports = { getIncoming, deriveAddress, provisionAddress };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/derive.test.js`
Expected: PASS (all BTC + ETH tests).

- [ ] **Step 5: Commit**

```bash
git add checkers/eth.js test/derive.test.js
git commit -m "feat(eth): derive unique addresses from xpub (ethereumjs-wallet hdkey)"
```

---

### Task 5: USDT provisionAddress (static passthrough)

**Files:**
- Modify: `checkers/usdt.js`
- Test: `test/derive.test.js` (append)

**Interfaces:**
- Produces: `usdt.provisionAddress({ cfg: { address } }): Promise<{ address: string, addressIndex: null }>`.

- [ ] **Step 1: Append the failing test**

Append to `test/derive.test.js`:
```js
const usdt = require('../checkers/usdt');

test('USDT provisionAddress returns the static address, null index', async () => {
  const out = await usdt.provisionAddress({ cfg: { address: 'TXYZstaticUSDTaddress' } });
  assert.deepStrictEqual(out, { address: 'TXYZstaticUSDTaddress', addressIndex: null });
});

test('USDT provisionAddress throws when unconfigured (fail-closed)', async () => {
  await assert.rejects(() => usdt.provisionAddress({ cfg: { address: '' } }), /USDT_ADDRESS/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/derive.test.js`
Expected: FAIL — `usdt.provisionAddress is not a function`.

- [ ] **Step 3: Implement in `checkers/usdt.js`**

Above the existing `module.exports`, add:
```js
async function provisionAddress({ cfg }) {
  if (!cfg.address) throw new Error('USDT_ADDRESS not configured');
  return { address: cfg.address, addressIndex: null };
}
```

Change the export to:
```js
module.exports = { getIncoming, provisionAddress };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/derive.test.js`
Expected: PASS (all derive tests).

- [ ] **Step 5: Commit**

```bash
git add checkers/usdt.js test/derive.test.js
git commit -m "feat(usdt): provisionAddress passthrough for the static address"
```

---

### Task 6: XMR — subaddress provisioning + subaddrIndex on incoming

**Files:**
- Modify: `checkers/xmr.js`

**Interfaces:**
- Consumes: `cfg.xmrWalletRpc` (string), `cfg.xmrAccountIndex` (number, default 0) — supplied by `server.js` CONFIG in Task 7.
- Produces:
  - `xmr.provisionAddress({ cfg, orderId }): Promise<{ address: string, addressIndex: number }>` — calls `create_address`.
  - `xmr.getIncoming(_address, cfg)` transfers now include `subaddrIndex: number | null` (the `subaddr_index.minor`).

- [ ] **Step 1: Add `provisionAddress` (create_address RPC)**

In `checkers/xmr.js`, above the existing `module.exports`, add:
```js
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
```

- [ ] **Step 2: Surface `subaddrIndex` on incoming transfers**

In `checkers/xmr.js` `getIncoming`, replace the pushed object (currently the `out.push({ … paymentId … })` block) with:
```js
    out.push({
      txHash: t.txid,
      amount: xmr,
      confirmations: Number(t.confirmations || 0),
      timestamp: Number(t.timestamp || 0),
      subaddrIndex: t.subaddr_index ? Number(t.subaddr_index.minor) : null,
    });
```

- [ ] **Step 3: Update the export**

Change `module.exports = { getIncoming };` to:
```js
module.exports = { getIncoming, provisionAddress };
```

- [ ] **Step 4: Smoke-check the module loads**

Run: `node -e "const x=require('./checkers/xmr'); console.log(typeof x.provisionAddress, typeof x.getIncoming)"`
Expected: prints `function function`. (Live `create_address` / `get_transfers` against a wallet RPC is verified manually in Task 9.)

- [ ] **Step 5: Commit**

```bash
git add checkers/xmr.js
git commit -m "feat(xmr): create_address subaddress per payment + subaddrIndex on transfers"
```

---

### Task 7: server.js — addressing modes, provisioning, mode-based polling

**Files:**
- Modify: `server.js`

**Interfaces:**
- Consumes: `db.allocateIndex` (Task 2); `provisionAddress` from each checker (Tasks 3-6); `xmr.getIncoming` `subaddrIndex` (Task 6).
- Produces: a working gateway that issues unique addresses and matches each payment on its own address/subaddress.

- [ ] **Step 1: Replace config — CONFIG additions + CURRENCY_CONFIG**

In `server.js`, add to the `CONFIG` object (currently lines 31-38) one field:
```js
  xmrAccountIndex: Number(process.env.XMR_ACCOUNT_INDEX || 0),
```

Replace the `ADDRESSES` block (currently lines 40-45) with:
```js
// Per-currency addressing. A currency is "enabled" when its prerequisite is set.
//   derived    : unique address per payment derived from an account xpub
//   static     : one shared address (USDT — see README)
//   subaddress : unique Monero subaddress per payment via wallet RPC
const CURRENCY_CONFIG = {
  BTC:  { mode: 'derived',    xpub: process.env.BTC_XPUB || '' },
  ETH:  { mode: 'derived',    xpub: process.env.ETH_XPUB || '' },
  USDT: { mode: 'static',     address: process.env.USDT_ADDRESS || '' },
  XMR:  { mode: 'subaddress' },
};

function isEnabled(currency) {
  const cc = CURRENCY_CONFIG[currency];
  if (!cc) return false;
  if (cc.mode === 'derived') return !!cc.xpub;
  if (cc.mode === 'static') return !!cc.address;
  if (cc.mode === 'subaddress') return !!CONFIG.xmrWalletRpc;
  return false;
}

// Provision a receive address for a new payment. Throws on any failure
// (fail-closed: the caller must NOT create the payment).
async function provisionFor(currency, orderId) {
  const cc = CURRENCY_CONFIG[currency];
  if (cc.mode === 'derived') {
    const index = db.allocateIndex(currency);
    return checkers[currency].provisionAddress({ cfg: { xpub: cc.xpub }, index, orderId });
  }
  if (cc.mode === 'static') {
    return checkers[currency].provisionAddress({ cfg: { address: cc.address }, index: null, orderId });
  }
  // subaddress (XMR): wallet assigns the index
  return checkers[currency].provisionAddress({ cfg: CONFIG, index: null, orderId });
}
```

- [ ] **Step 2: Extract a `settle()` helper and rewrite `pollCurrency` for modes**

Replace the whole `pollCurrency` function (currently lines 149-192) with:
```js
function settle(currency, p, match, required) {
  if (!match) return;
  if (match.confirmations >= required) {
    if (p.status !== 'confirmed') {
      db.markConfirmed(p.paymentId, match.txHash, match.confirmations, new Date().toISOString());
      const fresh = db.getPayment(p.paymentId);
      console.log(`[poll ${currency}] CONFIRMED ${p.paymentId} (order ${p.orderId}) tx=${match.txHash}`);
      fireWebhook({ event: 'payment.confirmed', payment: publicView(fresh) });
    }
  } else {
    db.markDetected(p.paymentId, match.txHash, match.confirmations);
  }
}

async function pollCurrency(currency) {
  const pending = db.getPendingByCurrency(currency);
  if (!pending.length) return;

  const cc = CURRENCY_CONFIG[currency];
  const required = CONFIRMATIONS[currency];
  const epsilon = AMOUNT_EPSILON[currency] || 0;

  // derived (BTC/ETH): each payment has its own address — query per address.
  if (cc.mode === 'derived') {
    for (const p of pending) {
      if (!p.wallet) continue;
      let incoming;
      try {
        incoming = await checkers[currency].getIncoming(p.wallet, CONFIG);
      } catch (err) {
        console.error(`[poll ${currency}] ${p.paymentId}: ${err.message}`);
        continue;
      }
      const expected = parseFloat(p.amount);
      const match = incoming.find((tx) => tx.amount + epsilon >= expected);
      settle(currency, p, match, required);
    }
    return;
  }

  // subaddress (XMR): one wallet call, match on the subaddress index.
  if (cc.mode === 'subaddress') {
    let incoming;
    try {
      incoming = await checkers[currency].getIncoming(null, CONFIG);
    } catch (err) {
      console.error(`[poll ${currency}] ${err.message}`);
      return;
    }
    for (const p of pending) {
      const expected = parseFloat(p.amount);
      const match = incoming.find(
        (tx) => tx.subaddrIndex === p.addressIndex && tx.amount + epsilon >= expected
      );
      settle(currency, p, match, required);
    }
    return;
  }

  // static (USDT): shared address — keep amount + time + tx-dedup matching.
  const address = cc.address;
  if (!address) return;
  let incoming;
  try {
    incoming = await checkers[currency].getIncoming(address, CONFIG);
  } catch (err) {
    console.error(`[poll ${currency}] ${err.message}`);
    return;
  }
  for (const p of pending) {
    const expected = parseFloat(p.amount);
    const createdSec = Math.floor(new Date(p.createdAt).getTime() / 1000) - 600;
    const match = incoming.find((tx) =>
      tx.amount + epsilon >= expected &&
      tx.timestamp >= createdSec &&
      (tx.txHash === p.txHash || !db.txHashUsed(tx.txHash, p.paymentId))
    );
    settle(currency, p, match, required);
  }
}
```

- [ ] **Step 3: Rewrite `create-payment` to provision per payment**

In the `POST /create-payment` handler, replace the address lookup + row build + insert (currently lines 249-277, from `const address = ADDRESSES[currency];` through the `res.status(201)...` line) with:
```js
  if (!isEnabled(currency)) {
    return res.status(400).json({ error: `${currency} is not configured on this gateway` });
  }

  let provisioned;
  try {
    provisioned = await provisionFor(currency, orderId);
  } catch (err) {
    console.error(`[create-payment] provisioning ${currency} failed: ${err.message}`);
    return res.status(502).json({ error: `failed to provision a ${currency} address` });
  }

  const now = new Date();
  const row = {
    paymentId: newPaymentId(),
    orderId,
    currency,
    amount: String(amount),
    wallet: provisioned.address,
    status: 'pending',
    txHash: null,
    confirmations: 0,
    addressIndex: provisioned.addressIndex,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + EXPIRY_MINUTES * 60_000).toISOString(),
    confirmedAt: null,
  };

  try {
    db.insertPayment(row);
  } catch (err) {
    console.error(`[create-payment] db insert failed: ${err.message}`);
    return res.status(500).json({ error: 'failed to create payment' });
  }

  const qr = await qrDataUrl(currency, row.wallet, row.amount);
  res.status(201).json(publicView(row, { qr, uri: toQrPayload(currency, row.wallet, row.amount) }));
```

- [ ] **Step 4: Replace remaining `ADDRESSES` references (health + boot log)**

In `GET /health` change `currencies: CURRENCIES.filter((c) => ADDRESSES[c])` to:
```js
    currencies: CURRENCIES.filter(isEnabled),
```
In the `server.listen` callback change `const configured = CURRENCIES.filter((c) => ADDRESSES[c]);` to:
```js
  const configured = CURRENCIES.filter(isEnabled);
```

- [ ] **Step 5: Verify no stale `ADDRESSES` references remain and the server boots**

Run:
```bash
grep -n "ADDRESSES" server.js || echo "no ADDRESSES refs"
node -e "require('./server')" & sleep 2; curl -s localhost:3000/health; kill %1
```
Expected: `no ADDRESSES refs`, and `/health` returns JSON (with `currencies: []` when nothing is configured in the env). Then stop the server.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat(server): per-payment address provisioning + mode-based matching"
```

---

### Task 8: Config + README

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

**Interfaces:** docs only — no code consumers.

- [ ] **Step 1: Update `.env.example`**

Replace the receiving-addresses block (currently lines 27-38) with:
```
# ---------------------------------------------------------------------------
# Receiving keys / addresses. Leave blank to disable a currency.
#
# BTC/ETH derive a UNIQUE address per payment from an account-level extended
# public key (xpub). Export the ACCOUNT xpub:
#   BTC: m/84'/0'/0'  (native segwit; xpub/ypub/zpub all accepted)
#   ETH: m/44'/60'/0'
# The gateway derives the external chain 0/index for each payment, so your
# private keys never touch this server.
#
# USDT is STILL a single static address (see README "Security & limitations").
# XMR derives a unique subaddress per payment via monero-wallet-rpc.
# ---------------------------------------------------------------------------
BTC_XPUB=
ETH_XPUB=
USDT_ADDRESS=
```

Under the Monero section (near `XMR_WALLET_RPC`), add:
```
# Monero account to create per-payment subaddresses under (usually 0).
XMR_ACCOUNT_INDEX=0
```

- [ ] **Step 2: Rewrite README Security §1 and §4**

In `README.md`, replace bullet 1 ("Static, reused addresses.") with:
```
1. **Unique address per payment (BTC/ETH/XMR).** BTC and ETH derive a fresh
   address per invoice from your account `xpub` (`BTC_XPUB` / `ETH_XPUB`); XMR
   creates a fresh subaddress via `monero-wallet-rpc`. Each payment is matched on
   its OWN address (BTC/ETH) or subaddress index (XMR), so two invoices for the
   same amount can never be confused. **USDT (TRC-20) is the exception — it still
   uses one static `USDT_ADDRESS`**, so for USDT keep amounts unique per open
   invoice (or add per-payment Tron addresses later).
```

Replace bullet 4 ("Monero is private.") with:
```
4. **Monero subaddresses.** Each XMR payment gets a unique subaddress
   (`create_address`, labelled with the `orderId`); matching is by
   `subaddr_index`, not by amount. The wallet detects incoming transfers across
   all subaddresses of `XMR_ACCOUNT_INDEX`.
```

Add a new bullet after the confirmations bullet:
```
8. **Per-address polling cost (BTC/ETH).** Because each invoice has its own
   address, every poll cycle makes one explorer request per *open* BTC/ETH
   invoice. With many concurrent invoices, mind the free-tier rate limits
   (Blockstream, Etherscan) and raise `POLL_INTERVAL_MS` if needed.
```

In the "How matching works" section and the Monero section, replace mentions of static/amount-only matching with the per-address / `subaddr_index` behavior. Update the directory tree and `POST /create-payment` notes if they reference static addresses.

- [ ] **Step 3: Verify env keys line up with code**

Run:
```bash
grep -nE "BTC_XPUB|ETH_XPUB|USDT_ADDRESS|XMR_ACCOUNT_INDEX|XMR_WALLET_RPC" .env.example
```
Expected: all five present; no lingering `BTC_ADDRESS`/`ETH_ADDRESS`/`XMR_ADDRESS`.

- [ ] **Step 4: Commit**

```bash
git add .env.example README.md
git commit -m "docs: document xpub config, USDT-static exception, per-address polling"
```

---

### Task 9: Full verification + manual sanity check

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `npm test`
Expected: all tests pass (BTC/ETH/USDT derivation + index allocator + addressIndex persistence). Zero failures.

- [ ] **Step 2: Manual end-to-end provisioning sanity (BTC + ETH)**

Run:
```bash
node -e '
const ecc=require("tiny-secp256k1");const {BIP32Factory}=require("bip32");const bip32=BIP32Factory(ecc);
const {hdkey}=require("ethereumjs-wallet");
const SEED=Buffer.from("5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4","hex");
const bx=bip32.fromSeed(SEED).derivePath("m/84\x270\x270\x27").neutered().toBase58();
const ex=hdkey.fromMasterSeed(SEED).derivePath("m/44\x2760\x270\x27").publicExtendedKey();
console.log("BTC#0", require("./checkers/btc").deriveAddress(bx,0));
console.log("BTC#1", require("./checkers/btc").deriveAddress(bx,1));
console.log("ETH#0", require("./checkers/eth").deriveAddress(ex,0));
'
```
Expected:
```
BTC#0 bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu
BTC#1 bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g
ETH#0 0x9858EfFD232B4033E47d90003D41EC34EcaEda94
```

- [ ] **Step 3: Confirm clean tree**

Run: `git status`
Expected: working tree clean, branch `feature/hd-derived-addresses` ahead of `main`.

---

## Self-Review

**Spec coverage:** BTC derived (T3) ✓ · ETH derived (T4) ✓ · USDT static + README note (T5/T8) ✓ · XMR subaddress via create_address w/ orderId label (T6) ✓ · addressIndex column (T2) ✓ · per-address matching kills amount collision (T7 derived/subaddress branches) ✓ · fail-closed provisioning (T7 step 3) ✓ · tests on derivation + allocator (T2-T5) ✓ · config/docs (T8) ✓.

**Type consistency:** `provisionAddress` returns `{ address, addressIndex }` everywhere; `deriveAddress(xpub, index)` signature identical in BTC/ETH; `db.allocateIndex(currency)` used in T7 matches T2; `subaddrIndex` produced in T6 consumed in T7; `addressIndex` written in T7 row matches T2 insert column.

**Placeholder scan:** no TBD/TODO; every code step shows full code; test vectors are concrete literals.
