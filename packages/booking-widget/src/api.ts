// 公開 API（認証なし）を呼ぶ部品。予約状況 GET /public/calendar と、申込 POST /public/applications。
// 送る本文は契約（ApplicationRequest）の形にし、返ってきた本文は契約でパースしてから使う（INV-4）。
// 手元では HP の dev サーバーが /public を API（http://localhost:8787）へ中継する（apps/site-zebra/astro.config.mjs）
import {
  ApplicationAccepted,
  ApplicationRejected,
  type ApplicationRejection,
  ApplicationRequest,
  PublicCalendar,
} from "@zebra/contracts";

/** 呼べなかった・思った返事でなかったときの中身 */
export type ApiFailure =
  /** 申込を受け付けなかった理由を API が返した（ApplicationRejected） */
  | { kind: "rejected"; reason: ApplicationRejection }
  /** API に届かなかった */
  | { kind: "network" }
  /** 返事が契約の形でなかった（API が落ちている、中継先がない、など） */
  | { kind: "unexpected"; status: number };

export type ApiResult<T> = { ok: true; value: T } | { ok: false; failure: ApiFailure };

export interface PublicApi {
  /** 期間（JST の日付。両端を含む）の予約状況 */
  getCalendar(period: { from: string; to: string }): Promise<ApiResult<PublicCalendar>>;
  /** 申込。本文は送る前に契約でパースする（契約に合わなければ例外。呼ぶ側で先に確かめる） */
  apply(request: ApplicationRequest): Promise<ApiResult<ApplicationAccepted>>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** パースに使うスキーマの形（Zod のスキーマが満たす） */
interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/** fetch を受け取って、公開 API の呼び出しを作る（テストではモックの fetch を渡す） */
export function createPublicApi(fetchFn: FetchLike, baseUrl = ""): PublicApi {
  return {
    async getCalendar(period) {
      const params = new URLSearchParams({ from: period.from, to: period.to });
      return request(
        fetchFn,
        `${baseUrl}/public/calendar?${params.toString()}`,
        { method: "GET", headers: { accept: "application/json" } },
        PublicCalendar,
      );
    },
    async apply(application) {
      return request(
        fetchFn,
        `${baseUrl}/public/applications`,
        {
          method: "POST",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify(ApplicationRequest.parse(application)),
        },
        ApplicationAccepted,
      );
    },
  };
}

async function request<T>(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  schema: Schema<T>,
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetchFn(url, init);
  } catch {
    return { ok: false, failure: { kind: "network" } };
  }
  const body: unknown = await response.json().catch(() => undefined);

  if (response.ok) {
    const parsed = schema.safeParse(body);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, failure: { kind: "unexpected", status: response.status } };
  }

  const rejected = ApplicationRejected.safeParse(body);
  return rejected.success
    ? { ok: false, failure: { kind: "rejected", reason: rejected.data.error } }
    : { ok: false, failure: { kind: "unexpected", status: response.status } };
}
