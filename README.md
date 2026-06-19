# Crypto Payment Gateway

A self-hosted cryptocurrency payment gateway in Node.js + Express. Accepts
**BTC**, **ETH**, **USDT (ERC-20)** and **XMR**, polls each chain for incoming
payments, expires unpaid invoices, and fires a signed webhook on confirmation.

```
payment-gateway/
├── server.js              # Express app + polling engine + webhooks
├── db.js                  # SQLite (better-sqlite3) persistence
├── checkers/
│   ├── btc.js             # Blockstream Esplora
│   ├── eth.js             # Etherscan v2
│   ├── usdt.js            # Etherscan v2 (USDT ERC-20 on Ethereum)
│   └── xmr.js             # local monero-wallet-rpc
├── public/index.html      # single-page checkout UI
├── ecosystem.config.js    # PM2 process definition
├── .env.example
└── package.json
```

---

## ⚠️ Security & limitations — read before going live

This gateway is a solid, working foundation, but it makes deliberate
simplifications. **Understand these before taking real money:**

1. **Static, reused addresses.** Each currency uses one address for every
   order (`*_ADDRESS` in `.env`). Payments are matched by
   `address + amount + time window`. If two open invoices request the *same
   amount* in the *same currency*, the gateway cannot reliably tell their
   payments apart. **Production fix:** derive a unique address per payment from
   an HD wallet / xpub (BTC, ETH), or use Monero subaddresses / integrated
   addresses (XMR), or enforce per-invoice unique amounts.

2. **Confirmation depth matters.** A payment is only marked `confirmed` once it
   reaches `CONFIRMATIONS_*`. Detecting a transaction in the mempool is **not**
   payment. Defaults: BTC=1, ETH=12, USDT=1, XMR=10 — raise BTC/ETH for larger
   amounts. USDT is an ERC-20 token on Ethereum, so its confirmations come from
   Etherscan (real depth) — consider raising `CONFIRMATIONS_USDT` above 1 for
   larger amounts, same as ETH.

3. **Underpayments don't settle; overpayments do.** Matching requires
   `received >= expected`. Underpaid invoices stay pending and then expire.

4. **Monero is private.** An incoming XMR transfer does not reveal a
   destination address, so XMR matching is **amount-only**. For
   reliable multi-invoice operation, issue a subaddress or integrated address
   per payment and match on `subaddr_index` / `payment_id`.

5. **Amounts are crypto amounts**, not fiat. There is no exchange-rate feed;
   `amount` in `create-payment` is denominated in the chosen coin. Add a price
   oracle if you want to quote in fiat.

6. **Amounts are matched with a small epsilon** (floating point). This is fine
   for matching but do your real accounting from the on-chain `txHash`.

7. **Run a single instance.** The poller must not run concurrently (PM2 config
   uses `instances: 1`). Put the admin endpoints behind auth/network controls.

---

## Setup

Requires Node.js ≥ 18.

```bash
cd payment-gateway
npm install
cp .env.example .env
#   edit .env: set ADMIN_TOKEN, your receiving addresses, and API keys
npm start
```

Open <http://localhost:3000>.

### Free API keys

| Currency | Provider     | Key needed?                              |
|----------|--------------|------------------------------------------|
| BTC      | Blockstream  | No                                       |
| ETH      | Etherscan v2 | Yes — <https://etherscan.io/myapikey>    |
| USDT     | Etherscan v2 | Yes — same key as ETH (ERC-20 on Ethereum)|
| XMR      | your wallet  | No key; runs against monero-wallet-rpc   |

---

## API

### `POST /create-payment`
```json
{ "amount": 0.001, "orderId": "order-1234", "currency": "BTC" }
```
Returns the payment record plus a `qr` (data-URL) and a wallet `uri`:
```json
{
  "paymentId": "pay_…", "orderId": "order-1234", "currency": "BTC",
  "amount": "0.001", "wallet": "bc1q…", "status": "pending",
  "confirmations": 0, "confirmationsRequired": 1,
  "createdAt": "…", "expiresAt": "…", "qr": "data:image/png;base64,…",
  "uri": "bitcoin:bc1q…?amount=0.001"
}
```

### `GET /payment-status/:paymentId`
Returns the current record (same shape, including live `status` /
`confirmations`). `status` is one of `pending`, `confirmed`, `expired`.

### `GET /payments`  *(admin)*
Lists every payment. Requires the admin token:
```bash
curl -H "x-admin-token: $ADMIN_TOKEN" http://localhost:3000/payments
```

### `POST /webhook-test`  *(admin)*
Fires a sample webhook to `WEBHOOK_URL` so you can verify your receiver.
```bash
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" http://localhost:3000/webhook-test
```

### `GET /health`
Liveness + which currencies are configured.

### Webhook payload
On confirmation the gateway POSTs:
```json
{ "event": "payment.confirmed", "payment": { …full record… } }
```
If `WEBHOOK_SECRET` is set, verify the signature:
```js
const sig = req.get('X-Webhook-Signature'); // "sha256=<hex>"
const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
// use crypto.timingSafeEqual to compare
```

---

## Running with PM2

```bash
npm install -g pm2

pm2 start ecosystem.config.js      # or: pm2 start server.js --name crypto-gateway
pm2 save                           # persist the process list
pm2 startup                        # print the OS boot command — run what it outputs

pm2 logs crypto-gateway            # tail logs
pm2 restart crypto-gateway
pm2 stop crypto-gateway
```

---

## Monero wallet RPC

The XMR checker talks to a local `monero-wallet-rpc`. Point it at a remote
public daemon so you don't have to run a full node, but keep the **wallet**
(your keys) local:

```bash
monero-wallet-rpc \
  --wallet-file /path/to/your-wallet \
  --prompt-for-password \
  --rpc-bind-port 18082 \
  --rpc-bind-ip 127.0.0.1 \
  --disable-rpc-login \
  --daemon-address node.moneroworld.com:18089 \
  --trusted-daemon \
  --log-level 1
```

Notes:
- `--disable-rpc-login` is required here — this client does not implement HTTP
  digest auth. Keep the RPC bound to `127.0.0.1`.
- The wallet must already exist (`monero-wallet-cli` to create/restore it). The
  wallet only needs the **view key** to *detect* incoming payments.
- For per-invoice matching, generate a subaddress per payment
  (`create_address` RPC) and extend `checkers/xmr.js` to match on
  `subaddr_index`.

---

## Nginx reverse proxy (`pay.yourdomain.com`)

```nginx
server {
    listen 80;
    server_name pay.yourdomain.com;
    # Redirect everything to HTTPS (after you've issued a cert).
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name pay.yourdomain.com;

    ssl_certificate     /etc/letsencrypt/live/pay.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pay.yourdomain.com/privkey.pem;

    # Lock the admin endpoint down to your IP(s).
    location = /payments {
        allow 203.0.113.10;   # your office/VPN IP
        deny all;
        proxy_pass http://127.0.0.1:3000;
    }

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
```

Issue a certificate with `sudo certbot --nginx -d pay.yourdomain.com`.

---

## How matching works

Every `POLL_INTERVAL_MS` the server:
1. Expires `pending` invoices past `expiresAt` that have no detected tx.
2. For each configured currency, fetches recent incoming transactions via the
   checker and, for each open invoice, finds a tx where
   `received >= expected`, `tx.timestamp >= createdAt − 10min`, and the tx hash
   isn't already claimed by another invoice.
3. If the match has `>= CONFIRMATIONS_<CCY>` confirmations → mark `confirmed`,
   set `confirmedAt`, fire the webhook (once). Otherwise record the tx hash and
   confirmation count and keep polling.
