'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { allowedWebhookUrls, resolveWebhookUrl } = require('../webhooks');

const ASIA = 'https://shifalabsasia.com/api/crypto-webhook';
const PH = 'https://shifalabsphilippines.com/api/crypto-webhook';

test('the allowlist is WEBHOOK_URL plus each WEBHOOK_URLS entry, trimmed, blanks dropped', () => {
  const allowed = allowedWebhookUrls(ASIA, ` ${PH} , ,`);
  assert.deepEqual([...allowed].sort(), [ASIA, PH].sort());
});

test('an unset WEBHOOK_URLS leaves just WEBHOOK_URL', () => {
  assert.deepEqual([...allowedWebhookUrls(ASIA, undefined)], [ASIA]);
});

test('no webhookUrl in the request means "use the default"', () => {
  assert.deepEqual(resolveWebhookUrl(undefined, allowedWebhookUrls(ASIA, PH)), { ok: true, url: null });
  assert.deepEqual(resolveWebhookUrl('', allowedWebhookUrls(ASIA, PH)), { ok: true, url: null });
});

test('an allowlisted webhookUrl is accepted as given', () => {
  assert.deepEqual(resolveWebhookUrl(PH, allowedWebhookUrls(ASIA, PH)), { ok: true, url: PH });
});

test('anything off the allowlist is refused — no open relay for signed webhooks', () => {
  const allowed = allowedWebhookUrls(ASIA, PH);
  assert.equal(resolveWebhookUrl('https://evil.example/hook', allowed).ok, false);
  assert.equal(resolveWebhookUrl(`${PH}/`, allowed).ok, false, 'exact match only');
  assert.equal(resolveWebhookUrl({ url: PH }, allowed).ok, false, 'must be a string');
});
