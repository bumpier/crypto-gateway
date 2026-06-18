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
