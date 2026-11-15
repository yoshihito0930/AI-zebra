// 管理 API（docs/design-docs/admin-api.md）を呼ぶ部品。
// 返ってきた本文は、packages/contracts のスキーマでパースしてから使う（INV-4）。送る本文とクエリも契約の形にする。
// 手元では Vite の dev サーバーが /admin を API（http://localhost:8787）へ中継する（vite.config.ts）
import {
  AdminApproveRequest,
  AdminEmptyRequest,
  AdminOperationAccepted,
  AdminReceiptLookup,
  AdminRejected,
  AdminReservationDetail,
  AdminReservationList,
  AdminReservationListQuery,
  type AdminError,
  type AdminWarning,
  type Yen,
} from "@zebra/contracts";

/** 呼べなかった・思った返事でなかったときの中身 */
export type ApiFailure =
  /** API がエラーの理由を返した（AdminRejected） */
  | { kind: "rejected"; status: number; error: AdminError; warnings?: AdminWarning[] }
  /** API に届かなかった */
  | { kind: "network" }
  /** 返事が契約の形でなかった（API が落ちている、中継先がない、など） */
  | { kind: "unexpected"; status: number };

export type ApiResult<T> = { ok: true; value: T } | { ok: false; failure: ApiFailure };

/** 詳細から行う操作（1回目の操作。ルートの最後の部分） */
export type AdminOperation = "approve" | "reject" | "promote" | "cancel" | "move-up";

export interface AdminApi {
  listReservations(query: AdminReservationListQuery): Promise<ApiResult<AdminReservationList>>;
  getReservation(id: string): Promise<ApiResult<AdminReservationDetail>>;
  lookupReceipt(receiptNumber: string): Promise<ApiResult<AdminReceiptLookup>>;
  approve(id: string, confirmedPrice: Yen): Promise<ApiResult<AdminOperationAccepted>>;
  operate(
    id: string,
    operation: Exclude<AdminOperation, "approve">,
  ): Promise<ApiResult<AdminOperationAccepted>>;
}

/** パースに使うスキーマの形（Zod のスキーマが満たす） */
interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** fetch を受け取って、管理 API の呼び出しを作る（テストではモックの fetch を渡す） */
export function createAdminApi(fetchFn: FetchLike, baseUrl = ""): AdminApi {
  const call = async <T>(path: string, schema: Schema<T>, body?: unknown) => {
    const init: RequestInit =
      body === undefined
        ? { method: "GET", headers: { accept: "application/json" } }
        : {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify(body),
          };
    return request(fetchFn, `${baseUrl}${path}`, init, schema);
  };

  return {
    async listReservations(query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(AdminReservationListQuery.parse(query))) {
        if (value !== undefined) params.set(key, value);
      }
      return call(`/admin/reservations?${params.toString()}`, AdminReservationList);
    },
    async getReservation(id) {
      return call(`/admin/reservations/${encodeURIComponent(id)}`, AdminReservationDetail);
    },
    async lookupReceipt(receiptNumber) {
      return call(`/admin/receipts/${encodeURIComponent(receiptNumber)}`, AdminReceiptLookup);
    },
    async approve(id, confirmedPrice) {
      return call(
        `/admin/reservations/${encodeURIComponent(id)}/approve`,
        AdminOperationAccepted,
        AdminApproveRequest.parse({ confirmedPrice }),
      );
    },
    async operate(id, operation) {
      return call(
        `/admin/reservations/${encodeURIComponent(id)}/${operation}`,
        AdminOperationAccepted,
        AdminEmptyRequest.parse({}),
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

  const rejected = AdminRejected.safeParse(body);
  if (!rejected.success) {
    return { ok: false, failure: { kind: "unexpected", status: response.status } };
  }
  return {
    ok: false,
    failure: {
      kind: "rejected",
      status: response.status,
      error: rejected.data.error,
      ...(rejected.data.warnings === undefined ? {} : { warnings: rejected.data.warnings }),
    },
  };
}
