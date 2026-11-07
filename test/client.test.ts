import assert from 'node:assert/strict';
import { test } from 'node:test';
import { APIClient } from '../src/core.ts';
import { AuthenticationError, BankOpenAPIError, ConflictError, InvalidRequestError, RateLimitError } from '../src/errors.ts';

type Call = { url: string; init: RequestInit };

/** fetch giả: trả lần lượt các phản hồi trong danh sách, ghi lại từng lần gọi */
function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('hết phản hồi giả');
    return next();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const headerOf = (c: Call, name: string) => new Headers(c.init.headers as HeadersInit).get(name);

const KEY = 'boa_test_abc123XYZ';

test('gửi API key, query bỏ giá trị undefined, Date thành ISO', async () => {
  const { fn, calls } = fakeFetch([json(200, { object: 'list', data: [] })]);
  const client = new APIClient({ apiKey: KEY, fetch: fn });
  await client.request('GET', '/transactions', { query: { limit: 5, type: undefined, from: new Date('2026-11-01T00:00:00Z') } });
  assert.equal(calls[0]!.url, 'https://app.bankopenapi.com/api/v1/transactions?limit=5&from=2026-11-01T00%3A00%3A00.000Z');
  assert.equal(headerOf(calls[0]!, 'authorization'), `Bearer ${KEY}`);
  assert.equal(headerOf(calls[0]!, 'idempotency-key'), null);
});

test('POST tự có Idempotency-Key, giữ nguyên khi thử lại sau 5xx', async () => {
  const { fn, calls } = fakeFetch([json(503, { error: { code: 'UNAVAILABLE', message: 'x' } }), json(201, { id: 'pr_1' })]);
  const client = new APIClient({ apiKey: KEY, fetch: fn, maxRetries: 2 });
  const out = await client.request<{ id: string }>('POST', '/payment-requests', { body: { amount: 150000 } });
  assert.equal(out.id, 'pr_1');
  assert.equal(calls.length, 2);
  const k1 = headerOf(calls[0]!, 'idempotency-key');
  assert.ok(k1?.startsWith('bankopenapi-js-'));
  assert.equal(headerOf(calls[1]!, 'idempotency-key'), k1);
  assert.equal(calls[0]!.init.body, JSON.stringify({ amount: 150000 }));
});

test('Idempotency-Key do khách truyền được dùng nguyên', async () => {
  const { fn, calls } = fakeFetch([json(201, { id: 'pr_1' })]);
  const client = new APIClient({ apiKey: KEY, fetch: fn });
  await client.request('POST', '/payment-requests', { body: { amount: 1 }, idempotencyKey: 'order-DH1028' });
  assert.equal(headerOf(calls[0]!, 'idempotency-key'), 'order-DH1028');
});

test('429 thử lại theo Retry-After rồi mới ném RateLimitError', async () => {
  const { fn, calls } = fakeFetch([
    json(429, { error: { code: 'RATE_LIMITED', message: 'Chậm lại' } }, { 'retry-after': '0.01' }),
    json(429, { error: { code: 'RATE_LIMITED', message: 'Chậm lại' } }, { 'retry-after': '0.01', 'request-id': 'req_9' }),
  ]);
  const client = new APIClient({ apiKey: KEY, fetch: fn, maxRetries: 1 });
  await assert.rejects(client.request('GET', '/account'), (e: unknown) => {
    assert.ok(e instanceof RateLimitError);
    assert.equal(e.code, 'RATE_LIMITED');
    assert.equal(e.requestId, 'req_9');
    return true;
  });
  assert.equal(calls.length, 2);
});

test('4xx không thử lại, lỗi đúng lớp và mã', async () => {
  const cases: [number, string, new (...a: never[]) => BankOpenAPIError][] = [
    [400, 'VALIDATION_ERROR', InvalidRequestError],
    [401, 'INVALID_API_KEY', AuthenticationError],
    [409, 'IDEMPOTENCY_KEY_REUSED', ConflictError],
  ];
  for (const [status, code, cls] of cases) {
    const { fn, calls } = fakeFetch([json(status, { error: { code, message: 'Câu lỗi tiếng Việt' } })]);
    const client = new APIClient({ apiKey: KEY, fetch: fn });
    await assert.rejects(client.request('GET', '/account'), (e: unknown) => {
      assert.ok(e instanceof cls, `${status} phải là ${cls.name}`);
      assert.equal((e as BankOpenAPIError).code, code);
      assert.equal((e as BankOpenAPIError).status, status);
      assert.equal((e as BankOpenAPIError).message, 'Câu lỗi tiếng Việt');
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('lỗi mạng thử lại, hết lượt thì ném APIConnectionError', async () => {
  const fail = () => Promise.reject(new TypeError('fetch failed'));
  const { fn, calls } = fakeFetch([fail, fail]);
  const client = new APIClient({ apiKey: KEY, fetch: fn, maxRetries: 1 });
  await assert.rejects(client.request('GET', '/account'), (e: unknown) => e instanceof BankOpenAPIError && e.code === 'CONNECTION_ERROR');
  assert.equal(calls.length, 2);
});

test('API key sai dạng hoặc thiếu thì báo lỗi ngay khi tạo client', () => {
  assert.throws(() => new APIClient({ apiKey: 'sk_live_123', fetch: fetch }), /boa_live_/);
  const saved = process.env.BANKOPENAPI_API_KEY;
  delete process.env.BANKOPENAPI_API_KEY;
  try {
    assert.throws(() => new APIClient({ fetch: fetch }), /Thiếu API key/);
  } finally {
    if (saved !== undefined) process.env.BANKOPENAPI_API_KEY = saved;
  }
});

test('livemode theo tiền tố khóa', () => {
  assert.equal(new APIClient({ apiKey: KEY }).livemode, false);
  assert.equal(new APIClient({ apiKey: 'boa_live_abc' }).livemode, true);
});
