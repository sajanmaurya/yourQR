import test from 'node:test';
import assert from 'node:assert/strict';
import { addressScope, isLanAddressStale } from '../shared/network.js';

test('sharing labels distinguish this computer, Wi-Fi, and public URLs', () => {
  for (const url of ['http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) assert.equal(addressScope(url), 'device');
  for (const url of ['http://10.177.121.108:8787', 'http://192.168.1.4:8787', 'http://172.16.0.2:8787', 'http://my-pc.local:8787']) assert.equal(addressScope(url), 'lan');
  for (const url of ['https://qr.example.com', 'https://localhost.example.com', 'https://10.example.com', 'http://172.32.0.2']) assert.equal(addressScope(url), 'public');
});

test('Wi-Fi configuration flags an address after the computer changes networks', () => {
  assert.equal(isLanAddressStale('http://10.177.121.108:8787', ['127.0.0.1', '192.168.1.32']), true);
  assert.equal(isLanAddressStale('http://192.168.1.32:8787', ['127.0.0.1', '192.168.1.32']), false);
  assert.equal(isLanAddressStale('http://localhost:8787', []), false);
  assert.equal(isLanAddressStale('https://qr.example.com', []), false);
});
