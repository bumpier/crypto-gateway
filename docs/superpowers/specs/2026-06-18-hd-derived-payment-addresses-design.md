# Non-static (HD-derived) payment addresses — design

**Date:** 2026-06-18
**Status:** Approved (pending spec review)
**Branch:** `feature/hd-derived-addresses`

## Goal

Give every payment its own unique receive address so that two open invoices for
the same amount in the same currency can never be confused. The receive address
itself (BTC/ETH) or the Monero subaddress index (XMR) becomes the matching
discriminator, making amount-collision structurally impossible.

- **BTC** — derive a unique P2WPKH address from `BTC_XPUB` (bip32 + bitcoinjs-lib).
- **ETH** — derive a unique address from `ETH_XPUB` (ethereumjs-wallet hdkey).
- **USDT** — stays static for now (explicit README note + rationale).
- **XMR** — call `monero-wallet-rpc` `create_address` for a unique subaddress per
  payment, using `orderId` as the label.
- Persist `addressIndex` on the `payments` row.

## Locked decisions

1. **BTC** — `BTC_XPUB` is the **account-level** key (e.g. `m/84'/0'/0'`). Per
   payment we derive the external chain `0/index` and build a **P2WPKH** (`bc1q…`)
   address. A `zpub`/`ypub` is auto-normalized to `xpub` version bytes before
   `bip32.fromBase58` (the key material is identical; address type comes from how
   we build the payment, not the version prefix).
2. **ETH** — `ETH_XPUB` is the **account-level** key (`m/44'/60'/0'`). Per payment
   we derive `0/index` via `EthereumHDKey.deriveChild(0).deriveChild(index)`.
3. **Testing** — Node's built-in `node:test` (zero new deps) covering address
   derivation against published BIP32/BIP84 test vectors and the SQLite index
   allocator. Live network/RPC I/O is verified manually.
4. **Fail-closed** — if address provisioning fails (bad xpub, wallet RPC down), the
   API returns an error and **does not** create the payment. There is **no**
   fallback to a static or shared address — a wrong receive address loses funds.

## Architecture — addressing modes

Each currency has one mode, which drives both provisioning (at `create-payment`)
and matching (in the poller):

| Currency | Mode         | Address source                       | Matched by                          |
|----------|--------------|--------------------------------------|-------------------------------------|
| BTC      | `derived`    | `BTC_XPUB` → `0/index`, P2WPKH       | its own address + amount            |
| ETH      | `derived`    | `ETH_XPUB` → `0/index`               | its own address + amount            |
| USDT     | `static`     | `USDT_ADDRESS` (unchanged)           | address + amount + time + tx-dedup  |
| XMR      | `subaddress` | wallet-rpc `create_address`          | `subaddr_index` + amount            |

`payments.wallet` already stores a per-row address, and the QR/URI builder and the
matcher already read `row.wallet`. So a derived address drops straight in — the
change is to stop assigning the shared `ADDRESSES[currency]`.

## Component breakdown

### `db.js`
- **Migration:** add column `addressIndex INTEGER` to `payments`, guarded via
  `PRAGMA table_info` (SQLite has no `ADD COLUMN IF NOT EXISTS`). Existing rows get
  `NULL`, which is harmless.
- **New table:** `address_counters(currency TEXT PRIMARY KEY, nextIndex INTEGER NOT NULL DEFAULT 0)`.
- **`allocateIndex(currency)`** — runs inside a `better-sqlite3` transaction
  (synchronous; the gateway runs as a single PM2 instance): read current
  `nextIndex`, return it, write `+1`. Monotonic, never reused, survives restarts.
  Used for BTC/ETH only.
- **`insertPayment`** carries `addressIndex`.

### Provisioning — `provisionAddress({ cfg, index, orderId })` per checker
Uniform async signature returning `{ address, addressIndex }`:
- **BTC** (`checkers/btc.js`) — normalize zpub/ypub→xpub → `bip32.fromBase58` →
  `.derive(0).derive(index)` → `bitcoin.payments.p2wpkh({ pubkey })`.
  `addressIndex = index`. Pure/sync.
- **ETH** (`checkers/eth.js`) — `EthereumHDKey.fromExtendedKey(xpub)
  .deriveChild(0).deriveChild(index).getWallet().getChecksumAddressString()`.
  `addressIndex = index`. Pure/sync.
- **USDT** (`checkers/usdt.js`) — returns `{ address: USDT_ADDRESS, addressIndex: null }`.
- **XMR** (`checkers/xmr.js`) — POST `create_address {account_index, label: orderId}`
  → `{ address, address_index }`; `addressIndex = address_index` (**wallet-assigned**,
  not from our counter). Async/network.

New dependencies: `bitcoinjs-lib`, `bip32`, `tiny-secp256k1` (ecc backend for
bip32/bitcoinjs), `ethereumjs-wallet`. The `tiny-secp256k1` native/wasm build is
verified to install cleanly before any code depends on it.

### `create-payment` flow (fail-closed)
1. Validate the currency is *enabled*: BTC/ETH need an xpub; USDT needs the static
   address; XMR needs the wallet RPC reachable (the `create_address` call itself).
2. BTC/ETH: `allocateIndex(currency)`. XMR/USDT: skip.
3. `await provisionAddress(...)`.
4. On throw → 5xx, do **not** insert. (A burned index after a failed provision is
   fine; gaps are harmless and never reused.)
5. Insert row with `wallet = address`, `addressIndex`.

### Polling — `server.js`
- **BTC/ETH (`derived`)** — for each pending payment, call
  `getIncoming(p.wallet, cfg)`; match `amount ≥ expected − ε` and confirmations.
  Cost: N pending invoices = N explorer calls per poll cycle → documented as a
  rate-limit consideration (Blockstream / Etherscan free tier); poll defaults
  unchanged.
- **USDT (`static`)** — unchanged: single-address query, amount + time +
  tx-dedup.
- **XMR (`subaddress`)** — one `get_transfers`; `xmr.js` additionally returns
  `subaddrIndex` (the `subaddr_index.minor`); match
  `subaddrIndex === p.addressIndex` and amount/confirmations. Amount-only matching
  is removed.

### Tests — `node:test`, wired to `npm test`
- BTC derive at index 0 and 1 equals a published BIP84 test-vector address.
- ETH derive at index 0 and 1 equals a published vector address.
- `allocateIndex` is monotonic, persists across a DB re-open (temp DB path), and
  separate currencies keep separate counters.

### Config + README
- `.env.example`: `BTC_ADDRESS`→`BTC_XPUB`, `ETH_ADDRESS`→`ETH_XPUB`, drop
  `XMR_ADDRESS` (now derived via RPC), keep `USDT_ADDRESS`, add optional
  `XMR_ACCOUNT_INDEX=0`.
- README: rewrite Security §1 and §4 — BTC/ETH/XMR are unique-per-payment now;
  **USDT stays static (explicit note + why)**; document the xpub formats, the
  `0/index` derivation paths, zpub auto-normalization, and the per-address polling
  rate-limit note.

## Error handling
- Provisioning failure → fail-closed (no payment created, no fallback address).
- Bad/empty xpub → currency reported as not configured by `/health` and rejected
  at `create-payment`.
- XMR wallet RPC unreachable at create time → 5xx, no payment created.
- Existing payment rows (NULL `addressIndex`) continue to poll against their stored
  `wallet`; no data backfill required.

## Scope guard (YAGNI)
Out of scope: gap-limit scanning, BTC change-address handling, fiat price oracle,
multi-account XMR, address re-derivation/recovery tooling.
