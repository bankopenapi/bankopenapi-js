import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { WebhookVerificationError } from '../src/errors.ts';
import { signWebhook, verifyWebhook } from '../src/webhooks.ts';

// Chữ ký tính bằng node:crypto, độc lập với cách thư viện dùng Web Crypto: đúng như apps/app/worker/webhooks/sign.ts
const key = randomBytes(24);
const secret = `whsec_${key.toString('base64')}`;
const sign = (id: string, ts: string, body: string, k = key) => createHmac('sha256', k).update(`${id}.${ts}.${body}`).digest('base64');

const body = JSON.stringify({
  id: 'evt_2Gc7Vn4Kp9Wq3Xr8Ty5Bm1Hd',
  type: 'transaction.received',
  livemode: true,
  timestamp: '2026-11-05T03:24:52.000Z',
  data: { id: 'txn_5Rk8Wm2Qp7Xn4Bv9Ls3Ht6Jc', amount: 150000, content: 'NGUYEN VAN BINH chuyen tien TT7K3M9Q' },
});
const now = new Date('2026-11-05T03:24:53.000Z');
const ts = String(Math.floor(now.getTime() / 1000));
const id = 'evt_2Gc7Vn4Kp9Wq3Xr8Ty5Bm1Hd';

test('verify đúng chữ ký, header dạng object của Node', async () => {
  const event = await verifyWebhook(body, { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sign(id, ts, body)}` }, secret, { now });
  assert.equal(event.type, 'transaction.received');
  assert.equal(event.id, id);
});

test('verify với Headers (Next.js, Workers) và body dạng bytes', async () => {
  const headers = new Headers({ 'Webhook-Id': id, 'Webhook-Timestamp': ts, 'Webhook-Signature': `v1,${sign(id, ts, body)}` });
  const event = await verifyWebhook(new TextEncoder().encode(body), headers, secret, { now });
  assert.equal(event.id, id);
});

test('nhiều chữ ký khi đang đổi secret: chỉ cần một chữ ký khớp', async () => {
  const oldKey = randomBytes(24);
  const signatures = `v1,${sign(id, ts, body, oldKey)} v1,${sign(id, ts, body)}`;
  const event = await verifyWebhook(body, { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': signatures }, secret, { now });
  assert.equal(event.id, id);
});

test('body bị sửa thì báo lỗi', async () => {
  const headers = { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sign(id, ts, body)}` };
  await assert.rejects(verifyWebhook(body.replace('150000', '1500000'), headers, secret, { now }), WebhookVerificationError);
});

test('sai secret thì báo lỗi', async () => {
  const headers = { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sign(id, ts, body)}` };
  await assert.rejects(verifyWebhook(body, headers, `whsec_${randomBytes(24).toString('base64')}`, { now }), WebhookVerificationError);
});

test('timestamp quá 5 phút thì báo lỗi (chống gửi lại request cũ)', async () => {
  const old = String(Number(ts) - 301);
  const headers = { 'webhook-id': id, 'webhook-timestamp': old, 'webhook-signature': `v1,${sign(id, old, body)}` };
  await assert.rejects(verifyWebhook(body, headers, secret, { now }), /quá cũ/);
});

test('thiếu header thì báo lỗi', async () => {
  await assert.rejects(verifyWebhook(body, { 'webhook-id': id }, secret, { now }), /Thiếu header/);
});

test('signWebhook tạo header verify được', async () => {
  const headers = await signWebhook(body, secret, { timestamp: now });
  const event = await verifyWebhook(body, headers, secret, { now });
  assert.equal(event.type, 'transaction.received');
  assert.match(headers['webhook-signature'], /^v1,/);
});
