import type { List } from './types.ts';

/**
 * Kết quả của các hàm `list()` có phân trang: `await` để lấy một trang (`{ data, hasMore }`), hoặc `for await` để duyệt
 * hết mọi phần tử, thư viện tự gọi trang tiếp theo bằng `starting_after`.
 *
 * @example
 * const page = await boa.transactions.list({ limit: 20 });
 * for await (const tx of boa.transactions.list({ type: 'credit', from: '2026-11-01' })) console.log(tx.amount);
 */
export type PagePromise<T> = Promise<List<T>> & AsyncIterable<T>;

export function pagePromise<T extends { id: string }>(fetchPage: (startingAfter: string | undefined) => Promise<List<T>>, startingAfter?: string): PagePromise<T> {
  const first = fetchPage(startingAfter);
  const iterate = async function* () {
    let page = await first;
    for (;;) {
      for (const item of page.data) yield item;
      const last = page.data.at(-1);
      if (!page.hasMore || !last) return;
      page = await fetchPage(last.id);
    }
  };
  return Object.assign(first, { [Symbol.asyncIterator]: iterate });
}
