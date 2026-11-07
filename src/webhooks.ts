import { WebhookVerificationError } from './errors.ts';
import type { WebhookEvent } from './types.ts';

/**
 * Verify webhook BankOpenAPI theo chuẩn Standard Webhooks (https://www.standardwebhooks.com), viết bằng Web Crypto nên
 * chạy được trên Node.js 20+, Next.js (cả Edge), Cloudflare Workers, Bun, Deno.
 *
 * - Ba header: `webhook-id`, `webhook-timestamp` (giây Unix), `webhook-signature` (`v1,<base64>`, có thể nhiều chữ ký
 *   cách nhau dấu cách khi đang đổi secret).
 * - Chữ ký: HMAC-SHA256 của chuỗi `<webhook-id>.<webhook-timestamp>.<body thô>`, khóa là phần sau `whsec_` (base64).
 * - Phải verify trên **body thô** (chuỗi hoặc bytes nhận được), không phải object đã parse rồi stringify lại.
 */

export type WebhookHeaders = Headers | Record<string, string | string[] | undefined | null>;

export interface VerifyOptions {
  /** Độ lệch tối đa giữa `webhook-timestamp` và giờ hiện tại, tính bằng giây. Mặc định 300 (5 phút) */
  tolerance?: number;
  /** Giờ hiện tại (để test) */
  now?: Date;
}

const encoder = new TextEncoder();

function header(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name) ?? undefined;
  const record = headers as Record<string, string | string[] | undefined | null>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : record[key];
  return Array.isArray(value) ? value.join(' ') : (value ?? undefined);
}

function payloadText(payload: string | ArrayBuffer | Uint8Array): string {
  if (typeof payload === 'string') return payload;
  if (payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) return new TextDecoder().decode(payload);
  throw new WebhookVerificationError(
    'Payload phải là body thô (string, Buffer hoặc Uint8Array). Đừng parse JSON trước khi verify. / Payload must be the raw request body.',
  );
}

function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
  if (!secret) throw new WebhookVerificationError('Thiếu signing secret (dạng whsec_…). / Missing webhook signing secret.');
  const base64 = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  try {
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  } catch {
    throw new WebhookVerificationError('Signing secret không hợp lệ: phải là chuỗi whsec_… lấy ở trang Webhook. / Invalid webhook signing secret.');
  }
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** So sánh hai chuỗi trong thời gian không phụ thuộc vị trí khác nhau đầu tiên */
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(secret: string, content: string) {
  const key = await crypto.subtle.importKey('raw', secretBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toBase64(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(content))));
}

/**
 * Kiểm tra chữ ký rồi trả sự kiện đã parse. Sai thì ném `WebhookVerificationError`: trả HTTP 400 cho BankOpenAPI.
 *
 * @example
 * const event = await verifyWebhook(rawBody, req.headers, process.env.BANKOPENAPI_WEBHOOK_SECRET!);
 * if (event.type === 'payment_request.paid') markOrderPaid(event.data.orderId);
 */
export async function verifyWebhook(
  payload: string | ArrayBuffer | Uint8Array,
  headers: WebhookHeaders,
  secret: string,
  options: VerifyOptions = {},
): Promise<WebhookEvent> {
  const body = payloadText(payload);
  const id = header(headers, 'webhook-id');
  const timestamp = header(headers, 'webhook-timestamp');
  const signatures = header(headers, 'webhook-signature');
  if (!id || !timestamp || !signatures)
    throw new WebhookVerificationError('Thiếu header webhook-id, webhook-timestamp hoặc webhook-signature. / Missing Standard Webhooks headers.');

  const seconds = Number(timestamp);
  if (!/^\d+$/.test(timestamp) || !Number.isSafeInteger(seconds)) throw new WebhookVerificationError('Header webhook-timestamp không hợp lệ. / Invalid webhook-timestamp.');
  const tolerance = options.tolerance ?? 300;
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  if (now - seconds > tolerance) throw new WebhookVerificationError('Webhook quá cũ (timestamp lệch quá 5 phút). / Webhook timestamp too old.');
  if (seconds - now > tolerance) throw new WebhookVerificationError('Timestamp của webhook ở tương lai. / Webhook timestamp too new.');

  const expected = await hmac(secret, `${id}.${timestamp}.${body}`);
  const ok = signatures.split(' ').some((part) => {
    const [version, signature] = part.split(',', 2);
    return version === 'v1' && signature !== undefined && safeEqual(signature, expected);
  });
  if (!ok) throw new WebhookVerificationError('Chữ ký webhook không khớp: kiểm tra signing secret và body thô. / Webhook signature mismatch.');

  try {
    return JSON.parse(body) as WebhookEvent;
  } catch {
    throw new WebhookVerificationError('Body của webhook không phải JSON. / Webhook body is not JSON.');
  }
}

/**
 * Ký một payload như BankOpenAPI gửi, để viết test cho endpoint nhận webhook của bạn mà không cần webhook thật.
 * Trả về ba header để gửi kèm body.
 *
 * @example
 * const body = JSON.stringify({ id: 'evt_test', type: 'webhook.test', livemode: false, timestamp: new Date().toISOString(), data: {} });
 * const headers = await signWebhook(body, process.env.BANKOPENAPI_WEBHOOK_SECRET!);
 * await fetch('http://localhost:3000/webhooks/bankopenapi', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });
 */
export async function signWebhook(
  payload: string,
  secret: string,
  options: { id?: string; timestamp?: Date } = {},
): Promise<{ 'webhook-id': string; 'webhook-timestamp': string; 'webhook-signature': string }> {
  const id = options.id ?? `msg_${crypto.randomUUID().replaceAll('-', '')}`;
  const timestamp = String(Math.floor((options.timestamp ?? new Date()).getTime() / 1000));
  const signature = await hmac(secret, `${id}.${timestamp}.${payload}`);
  return { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` };
}
