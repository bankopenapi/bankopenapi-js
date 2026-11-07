# bankopenapi

Thư viện chính thức của [BankOpenAPI](https://bankopenapi.com) cho JavaScript và TypeScript: nhận tiền chuyển khoản vào tài khoản ngân hàng Việt Nam, hiện mã VietQR cho từng đơn, nhận webhook khi tiền về để đơn tự chuyển sang đã thanh toán.

Official BankOpenAPI SDK for Node.js, Next.js, Cloudflare Workers, Bun and Deno: bank-transfer payments with VietQR and signed payment webhooks in Vietnam. Zero dependencies, fully typed.

- Chạy trên Node.js 20+, Next.js (App Router, Pages Router, Edge), Cloudflare Workers, Bun, Deno. Không phụ thuộc gói nào.
- Kiểu TypeScript cho mọi đối tượng và sự kiện webhook.
- Tự thử lại khi lỗi mạng, 429, 5xx; tự gửi `Idempotency-Key` nên thử lại không bao giờ tạo trùng yêu cầu thanh toán.
- Verify webhook theo chuẩn Standard Webhooks, có sẵn hàm ký để viết test.

## Cài đặt

```bash
npm install bankopenapi
# hoặc: pnpm add bankopenapi · yarn add bankopenapi · bun add bankopenapi
```

Lấy API key ở [app.bankopenapi.com/api-key](https://app.bankopenapi.com/api-key) rồi đặt vào biến môi trường của backend:

```bash
BANKOPENAPI_API_KEY=boa_test_...          # Sandbox: thử miễn phí, không cần tài khoản ngân hàng thật
BANKOPENAPI_WEBHOOK_SECRET=whsec_...      # signing secret của webhook endpoint (trang Webhook trong app)
```

API key là bí mật: chỉ dùng ở backend (route handler, server action, API route, Worker), không đưa vào code chạy trên trình duyệt. Thư viện báo lỗi nếu bị gọi trên trình duyệt.

## Bắt đầu nhanh

```ts
import BankOpenAPI from 'bankopenapi';

const boa = new BankOpenAPI(); // đọc BANKOPENAPI_API_KEY

// 1. Khách đặt đơn: tạo yêu cầu thanh toán
const pr = await boa.paymentRequests.create(
  { amount: 150000, orderId: 'DH1028', description: 'Đơn hàng DH1028' },
  { idempotencyKey: 'order-DH1028' }, // bấm hai lần cũng chỉ tạo một yêu cầu
);

// 2. Cho người mua trả tiền: chuyển tới trang thanh toán có sẵn...
console.log(pr.hostedUrl);
// ...hoặc tự vẽ mã QR trên trang của bạn (vd. npm install qrcode)
// const dataUrl = await QRCode.toDataURL(pr.qr!.payload);
// pr.transfer: ngân hàng, số tài khoản, số tiền, nội dung chuyển khoản (mã TT…) để hiện kèm QR

// 3. Tiền về đúng mã: BankOpenAPI gửi webhook payment_request.paid (xem mục Webhook)
```

CommonJS: `const { BankOpenAPI } = require('bankopenapi');`

## Webhook

BankOpenAPI `POST` tới URL bạn đăng ký mỗi khi có sự kiện. Luôn verify chữ ký trên **body thô** trước khi tin dữ liệu, trả `2xx` thật nhanh, và chống xử lý trùng theo `event.id` (một sự kiện có thể tới nhiều lần khi được gửi lại).

### Next.js (App Router)

```ts
// app/api/webhooks/bankopenapi/route.ts
import { verifyWebhook, WebhookVerificationError } from 'bankopenapi';

export async function POST(req: Request) {
  const body = await req.text(); // body thô, đừng dùng req.json() trước khi verify
  let event;
  try {
    event = await verifyWebhook(body, req.headers, process.env.BANKOPENAPI_WEBHOOK_SECRET!);
  } catch (err) {
    if (err instanceof WebhookVerificationError) return new Response('Invalid signature', { status: 400 });
    throw err;
  }

  if (await alreadyProcessed(event.id)) return new Response(null, { status: 200 });

  switch (event.type) {
    case 'payment_request.paid':
      await markOrderPaid(event.data.orderId, event.data.amountReceived); // event.data là PaymentRequest
      break;
    case 'transaction.received':
      console.log('Tiền về', event.data.amount, event.data.content); // event.data là Transaction
      break;
  }

  await markProcessed(event.id);
  return new Response(null, { status: 200 });
}
```

### Express

```ts
import express from 'express';
import { verifyWebhook } from 'bankopenapi';

const app = express();

// express.raw giữ nguyên body thô; đặt route này trước app.use(express.json())
app.post('/webhooks/bankopenapi', express.raw({ type: 'application/json' }), async (req, res) => {
  let event;
  try {
    event = await verifyWebhook(req.body, req.headers, process.env.BANKOPENAPI_WEBHOOK_SECRET!);
  } catch {
    return res.status(400).send('Invalid signature');
  }
  if (event.type === 'payment_request.paid') await markOrderPaid(event.data.orderId);
  res.sendStatus(200);
});
```

`verifyWebhook` không cần API key, chỉ cần signing secret. Nếu đã có client thì dùng `boa.webhooks.verify(body, headers)` (đọc `BANKOPENAPI_WEBHOOK_SECRET`).

### Các loại sự kiện

| `event.type` | `event.data` | Khi nào |
| --- | --- | --- |
| `payment_request.paid` | `PaymentRequest` | Yêu cầu nhận đủ tiền (`status` là `paid`, hoặc `overpaid` nếu chuyển thừa) |
| `payment_request.underpaid` | `PaymentRequest` | Nhận thiếu tiền; có thể đến nhiều lần khi người trả chuyển thêm |
| `transaction.received` | `Transaction` | Tiền vào một tài khoản đã liên kết, kể cả không thuộc đơn nào |
| `bank_account.linked`, `bank_account.removed` | `BankAccount` | Liên kết hoặc hủy liên kết tài khoản ngân hàng |
| `webhook.test` | `{ message, endpointId, livemode }` | Tin gửi thử |

### Viết test cho endpoint webhook

```ts
import { signWebhook } from 'bankopenapi';

const body = JSON.stringify({ id: 'evt_test_1', type: 'payment_request.paid', livemode: false, timestamp: new Date().toISOString(), data: { orderId: 'DH1028' } });
const headers = await signWebhook(body, process.env.BANKOPENAPI_WEBHOOK_SECRET!);
await fetch('http://localhost:3000/api/webhooks/bankopenapi', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });
```

## Sandbox

Dùng API key `boa_test_…` để thử toàn bộ luồng mà không cần tài khoản ngân hàng thật, không tốn phí. Webhook vẫn được gửi thật với `livemode: false`.

```ts
const boa = new BankOpenAPI({ apiKey: process.env.BANKOPENAPI_TEST_KEY });

await boa.sandbox.createBankAccount();                       // tài khoản ngân hàng thử, liên kết xong ngay
const pr = await boa.paymentRequests.create({ amount: 150000, orderId: 'DH1028' });
await boa.sandbox.payPaymentRequest(pr.id);                  // người mua "chuyển khoản": yêu cầu thành paid, webhook được gửi
await boa.sandbox.createTransaction({ amount: 50000, content: 'chuyen tien' }); // tiền vào không thuộc đơn nào
```

## Danh sách và phân trang

Hàm `list()` trả một trang khi `await`, hoặc duyệt hết mọi trang bằng `for await`:

```ts
const page = await boa.transactions.list({ type: 'credit', limit: 20 });
console.log(page.data, page.hasMore);

for await (const tx of boa.transactions.list({ type: 'credit', from: '2026-11-01' })) {
  console.log(tx.transactedAt, tx.amount, tx.content);
}
```

## Các hàm

| Nhóm | Hàm |
| --- | --- |
| `boa.paymentRequests` | `create`, `retrieve`, `list({ status, orderId })`, `cancel` |
| `boa.transactions` | `list({ bankAccountId, type, from, to })`, `retrieve` |
| `boa.bankAccounts` | `list`, `retrieve` (liên kết tài khoản mới làm trong app vì cần OTP của ngân hàng) |
| `boa.webhookEndpoints` | `create`, `retrieve`, `update`, `delete`, `list`, `retrieveSecret`, `rotateSecret`, `sendTest`, `testUrl`, `listDeliveries`, `retrieveDelivery`, `retryDelivery`, `retryFailed` |
| `boa.events` | `list({ type })`, `retrieve`, `resend` |
| `boa.account` | `retrieve` (thử API key) |
| `boa.sandbox` | `createBankAccount`, `createTransaction`, `payPaymentRequest` |
| `boa.webhooks` | `verify`, `sign` |

Tham số và đối tượng trả về có đủ kiểu TypeScript; chi tiết từng trường: [tài liệu API](https://bankopenapi.com/tai-lieu).

## Lỗi

Mọi lỗi từ API là `BankOpenAPIError` (hoặc lớp con), có `code` (vd. `INVALID_AMOUNT`), `status`, `message` tiếng Việt và `requestId` để gửi kèm khi cần hỗ trợ.

```ts
import { BankOpenAPIError, NotFoundError } from 'bankopenapi';

try {
  await boa.paymentRequests.retrieve(id);
} catch (err) {
  if (err instanceof NotFoundError) return null;
  if (err instanceof BankOpenAPIError) console.error(err.code, err.message, err.requestId);
  throw err;
}
```

Lớp con: `InvalidRequestError` (400, 422), `AuthenticationError` (401), `PermissionDeniedError` (403), `NotFoundError` (404), `ConflictError` (409), `RateLimitError` (429), `InternalServerError` (5xx), `APIConnectionError`, `APITimeoutError`. Danh sách mã lỗi: [bankopenapi.com/tai-lieu/loi](https://bankopenapi.com/tai-lieu/loi).

## Cấu hình

```ts
const boa = new BankOpenAPI({
  apiKey: env.BANKOPENAPI_API_KEY,         // bắt buộc truyền khi không có process.env (vd. Cloudflare Workers)
  webhookSecret: env.BANKOPENAPI_WEBHOOK_SECRET,
  timeout: 30_000,                         // mili giây mỗi lần gọi
  maxRetries: 2,                           // tự thử lại khi lỗi mạng, 429, 5xx
});
```

Mỗi hàm nhận thêm tham số cuối `{ idempotencyKey, signal, timeout, maxRetries }`. Giới hạn: 100 request mỗi phút cho mỗi API key.

## Dùng với AI agent

Cài skill BankOpenAPI để Claude Code, Cursor, Codex viết code tích hợp đúng tài liệu: `npx skills add bankopenapi/skills`. MCP server và cách cấu hình: [bankopenapi.com/tai-lieu/ai-agent](https://bankopenapi.com/tai-lieu/ai-agent).

## Hỗ trợ

Tài liệu: [bankopenapi.com/tai-lieu](https://bankopenapi.com/tai-lieu). Góp ý, báo lỗi: [teams@bankopenapi.com](mailto:teams@bankopenapi.com).

## License

MIT
