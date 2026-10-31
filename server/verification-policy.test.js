import test from 'node:test';
import assert from 'node:assert/strict';
import { needsEmailVerification } from './verification-policy.js';

const preview = {
  saasMode: true, environment: 'production', vercel: '1',
  vercelEnv: 'preview', unverifiedPreviewOptIn: 'false',
};

test('personal owner mode does not need SaaS email verification', () => {
  assert.equal(needsEmailVerification({ ...preview, saasMode: false }), false);
});
test('preview requires email verification by default', () => {
  assert.equal(needsEmailVerification(preview), true);
});
test('protected preview can opt in to signup without an email provider', () => {
  assert.equal(needsEmailVerification({ ...preview, unverifiedPreviewOptIn: 'true' }), false);
});
test('production always requires verification, even with the preview flag', () => {
  assert.equal(needsEmailVerification({ ...preview, vercelEnv: 'production', unverifiedPreviewOptIn: 'true' }), true);
});
test('non-Vercel hosts cannot use the preview bypass', () => {
  assert.equal(needsEmailVerification({ ...preview, vercel: '0', unverifiedPreviewOptIn: 'true' }), true);
});
test('explicit required verification takes priority', () => {
  assert.equal(needsEmailVerification({ ...preview, unverifiedPreviewOptIn: 'true', forceVerification: true }), true);
});
test('local development can use signup without verification', () => {
  assert.equal(needsEmailVerification({ ...preview, environment: 'development' }), false);
});
