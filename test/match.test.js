'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { matchPayments } = require('../match');

// createdAt 10:00:00Z = 1760436000 (unix seconds)
const T0 = 1760436000;
const at = (sec) => new Date((T0 + sec) * 1000).toISOString();

const pay = (paymentId, amount, createdSec = 0, txHash = null) =>
  ({ paymentId, amount: String(amount), createdAt: at(createdSec), txHash });
const tx = (txHash, amount, sec = 60, confirmations = 3) =>
  ({ txHash, amount, timestamp: T0 + sec, confirmations });

const ids = (results) =>
  results.map((r) => `${r.payment.paymentId}<-${r.tx.txHash}`).sort();

test('an overpaying tx settles the closest pending payment, not the first', () => {
  // The old poller walked payments in order: 290 >= 100, so A took B's money.
  const pending = [pay('A', 100), pay('B', 290)];
  const result = matchPayments(pending, [tx('t290', 290)]);
  assert.deepEqual(ids(result), ['B<-t290']);
});

test('two txs in one poll go to their own payments, whichever lands first', () => {
  const pending = [pay('A', 100), pay('B', 290)];
  const result = matchPayments(pending, [tx('t290', 290, 60), tx('t100', 100, 120)]);
  assert.deepEqual(ids(result), ['A<-t100', 'B<-t290']);
});

test('an underpayment settles nothing', () => {
  const result = matchPayments([pay('A', 100)], [tx('t', 99.5)]);
  assert.deepEqual(result, []);
});

test('amounts within epsilon count as paid', () => {
  const result = matchPayments([pay('A', 100)], [tx('t', 99.9999995)], { epsilon: 1e-6 });
  assert.deepEqual(ids(result), ['A<-t']);
});

test('a tx older than the payment (beyond 10 min skew) is ignored', () => {
  const result = matchPayments([pay('A', 100)], [tx('t', 100, -601)]);
  assert.deepEqual(result, []);
});

test('a tx within the 10 min skew window still matches', () => {
  const result = matchPayments([pay('A', 100)], [tx('t', 100, -300)]);
  assert.deepEqual(ids(result), ['A<-t']);
});

test('a tx another payment already holds is skipped', () => {
  const isTxUsed = (hash, paymentId) => hash === 't' && paymentId !== 'OTHER';
  const result = matchPayments([pay('A', 100)], [tx('t', 100)], { isTxUsed });
  assert.deepEqual(result, []);
});

test('a detected payment keeps its own tx and never takes another', () => {
  // A was detected on tA (awaiting confirmations); a better-fitting tB arrives.
  const pending = [pay('A', 100, 0, 'tA'), pay('B', 50)];
  const result = matchPayments(pending, [tx('tA', 100, 60, 5), tx('tB', 100, 90)]);
  assert.deepEqual(ids(result), ['A<-tA', 'B<-tB']);
  assert.equal(result.find((r) => r.payment.paymentId === 'A').tx.confirmations, 5);
});

test('equal amounts go to the oldest payment', () => {
  const pending = [pay('NEW', 100, 30), pay('OLD', 100, 0)];
  const result = matchPayments(pending, [tx('t', 100)]);
  assert.deepEqual(ids(result), ['OLD<-t']);
});

test('each payment is settled at most once', () => {
  const result = matchPayments([pay('A', 100)], [tx('t1', 100, 60), tx('t2', 100, 90)]);
  assert.deepEqual(ids(result), ['A<-t1']);
});
