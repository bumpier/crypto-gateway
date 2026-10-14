'use strict';

// Pairs incoming on-chain transactions with pending payments for ONE currency
// and receiving address. Pure: no I/O, so it can be unit-tested.
//
// Rules:
//  1. A payment already tied to a tx (detected, awaiting confirmations) only
//     ever matches that same tx.
//  2. Every other tx, oldest first, settles the eligible payment with the
//     LARGEST expected amount it still covers — the closest fit. Matching the
//     first payment it covers instead lets a 290 USDT payment settle a pending
//     100 USDT order, leaving the real 290 order unpaid forever.
//  3. Eligible = not yet matched, expected <= tx.amount + epsilon (underpayments
//     never settle), tx no older than the payment (minus clock skew), and the tx
//     not already held by another payment. Ties go to the oldest payment.

const DEFAULT_SKEW_SEC = 600; // chain timestamps vs our createdAt

/**
 * @param {Array<{paymentId:string, amount:string, createdAt:string, txHash:string|null}>} pending
 * @param {Array<{txHash:string, amount:number, timestamp:number, confirmations:number}>} incoming
 * @param {{epsilon?:number, isTxUsed?:(txHash:string, paymentId:string)=>boolean, skewSec?:number}} [opts]
 * @returns {Array<{payment:object, tx:object}>}
 */
function matchPayments(pending, incoming, opts = {}) {
  const epsilon = opts.epsilon || 0;
  const isTxUsed = opts.isTxUsed || (() => false);
  const skewSec = opts.skewSec == null ? DEFAULT_SKEW_SEC : opts.skewSec;

  const results = [];
  const matched = new Set(); // paymentIds
  const claimed = new Set(); // txHashes

  // 1. Detected payments keep their tx.
  for (const p of pending) {
    if (!p.txHash) continue;
    matched.add(p.paymentId);
    const tx = incoming.find((t) => t.txHash === p.txHash);
    if (tx) {
      results.push({ payment: p, tx });
      claimed.add(tx.txHash);
    }
  }

  // 2. Remaining txs, oldest first, to the closest-fitting payment.
  const txs = incoming
    .filter((t) => !claimed.has(t.txHash))
    .sort((a, b) => a.timestamp - b.timestamp);

  for (const tx of txs) {
    let best = null;
    let bestAmount = -Infinity;
    for (const p of pending) {
      if (matched.has(p.paymentId)) continue;
      const expected = parseFloat(p.amount);
      const createdSec = Math.floor(new Date(p.createdAt).getTime() / 1000) - skewSec;
      if (!(tx.amount + epsilon >= expected)) continue;
      if (tx.timestamp < createdSec) continue;
      if (isTxUsed(tx.txHash, p.paymentId)) continue;
      if (expected > bestAmount || (expected === bestAmount && p.createdAt < best.createdAt)) {
        best = p;
        bestAmount = expected;
      }
    }
    if (best) {
      results.push({ payment: best, tx });
      matched.add(best.paymentId);
      claimed.add(tx.txHash);
    }
  }

  return results;
}

module.exports = { matchPayments };
