// 管理 API（docs/design-docs/admin-api.md）を呼ぶ部品。
// 返ってきた本文は、packages/contracts のスキーマでパースしてから使う（INV-4）。送る本文とクエリも契約の形にする。
// 手元では Vite の dev サーバーが /admin を API（http://localhost:8787）へ中継する（vite.config.ts）
import {
  AdminApproveRequest,
  AdminBlockCreated,
  AdminBlockRequest,
  AdminBufferRequest,
  AdminChangeRequest,
  AdminCustomerInfoRequest,
  AdminDirectEntryAccepted,
  AdminDirectEntryRequest,
  AdminDraftDetail,
  AdminEmptyRequest,
  AdminOperationAccepted,
  AdminReceiptLookup,
  AdminRejected,
  AdminReservationDetail,
  AdminReservationDraftList,
  AdminReservationList,
  AdminReservationListQuery,
  AdminUnsentDraftList,
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

/** 下書きの状態を変える操作（3回目。ルートの最後の部分）：送信済みにする・送らないにする */
export type DraftAction = "sent" | "skip";

export interface AdminApi {
  listReservations(query: AdminReservationListQuery): Promise<ApiResult<AdminReservationList>>;
  getReservation(id: string): Promise<ApiResult<AdminReservationDetail>>;
  lookupReceipt(receiptNumber: string): Promise<ApiResult<AdminReceiptLookup>>;
  approve(id: string, confirmedPrice: Yen): Promise<ApiResult<AdminOperationAccepted>>;
  operate(
    id: string,
    operation: Exclude<AdminOperation, "approve">,
  ): Promise<ApiResult<AdminOperationAccepted>>;
  /** 予約の変更（2回目a）。確認していない警告があれば 409（unacknowledged-warnings）と今の警告 */
  change(id: string, request: AdminChangeRequest): Promise<ApiResult<AdminOperationAccepted>>;
  /** 直接入力（2回目a）。成功は 201 と予約の id */
  directEntry(request: AdminDirectEntryRequest): Promise<ApiResult<AdminDirectEntryAccepted>>;
  /** バッファの切り替え（2回目b） */
  changeBuffer(
    id: string,
    bufferMinutes: AdminBufferRequest["bufferMinutes"],
  ): Promise<ApiResult<AdminOperationAccepted>>;
  /** お客様の情報・撮影の内容の変更（2回目b）。全部の欄を送って置き換える。成功は 200（本文なし） */
  updateCustomer(id: string, request: AdminCustomerInfoRequest): Promise<ApiResult<undefined>>;
  /** ブロック枠を入れる（2回目a）。成功は 201 とブロック枠の id */
  createBlock(request: AdminBlockRequest): Promise<ApiResult<AdminBlockCreated>>;
  /** ブロック枠を直す（2回目a）。直すときも全部を送る。成功は 200（本文なし） */
  updateBlock(id: string, request: AdminBlockRequest): Promise<ApiResult<undefined>>;
  /** ブロック枠を消す（2回目a）。成功は 200（本文なし） */
  deleteBlock(id: string): Promise<ApiResult<undefined>>;
  /** 未送信の下書きの一覧（3回目）。作った順 */
  listUnsentDrafts(): Promise<ApiResult<AdminUnsentDraftList>>;
  /** 予約の下書きの一覧（3回目）。送信済み・送らないも含め、作った順 */
  listReservationDrafts(reservationId: string): Promise<ApiResult<AdminReservationDraftList>>;
  /** 下書きを開く（3回目）。文面（件名・本文）は API がテンプレートから作る */
  getDraft(reservationId: string, draftId: string): Promise<ApiResult<AdminDraftDetail>>;
  /**
   * 送信済みにする・送らないにする（3回目）。本文は空（{}）、成功は 200（本文なし）。
   * 未送信でない下書きは 409（draft-not-unsent）。メールは送らない（INV-6）
   */
  setDraftStatus(
    reservationId: string,
    draftId: string,
    action: DraftAction,
  ): Promise<ApiResult<undefined>>;
}

/** パースに使うスキーマの形（Zod のスキーマが満たす） */
interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 本文のない返事（ブロック枠を直す・消す、お客様の情報の変更、下書きを送信済み・送らないにする。API は 200 と空の本文を返す）。
 * 契約に返事の形がないので、本文がないことだけを確かめ、中身は使わない
 */
const NoBody: Schema<undefined> = {
  safeParse: (value) =>
    value === undefined ? { success: true, data: undefined } : { success: false },
};

type Method = "GET" | "POST" | "PUT" | "DELETE";

/** fetch を受け取って、管理 API の呼び出しを作る（テストではモックの fetch を渡す） */
export function createAdminApi(fetchFn: FetchLike, baseUrl = ""): AdminApi {
  const send = async <T>(method: Method, path: string, schema: Schema<T>, body?: unknown) => {
    const init: RequestInit =
      body === undefined
        ? { method, headers: { accept: "application/json" } }
        : {
            method,
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify(body),
          };
    return request(fetchFn, `${baseUrl}${path}`, init, schema);
  };
  /** 本文があれば POST、なければ GET */
  const call = async <T>(path: string, schema: Schema<T>, body?: unknown) =>
    send(body === undefined ? "GET" : "POST", path, schema, body);
  const reservationPath = (id: string, rest = "") =>
    `/admin/reservations/${encodeURIComponent(id)}${rest}`;
  const blockPath = (id: string) => `/admin/blocks/${encodeURIComponent(id)}`;
  const draftPath = (reservationId: string, draftId: string, rest = "") =>
    reservationPath(reservationId, `/drafts/${encodeURIComponent(draftId)}${rest}`);

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
    async change(id, body) {
      return call(
        reservationPath(id, "/change"),
        AdminOperationAccepted,
        AdminChangeRequest.parse(body),
      );
    },
    async directEntry(body) {
      return call(
        "/admin/reservations",
        AdminDirectEntryAccepted,
        AdminDirectEntryRequest.parse(body),
      );
    },
    async changeBuffer(id, bufferMinutes) {
      return call(
        reservationPath(id, "/buffer"),
        AdminOperationAccepted,
        AdminBufferRequest.parse({ bufferMinutes }),
      );
    },
    async updateCustomer(id, body) {
      return send(
        "PUT",
        reservationPath(id, "/customer"),
        NoBody,
        AdminCustomerInfoRequest.parse(body),
      );
    },
    async createBlock(body) {
      return call("/admin/blocks", AdminBlockCreated, AdminBlockRequest.parse(body));
    },
    async updateBlock(id, body) {
      return send("PUT", blockPath(id), NoBody, AdminBlockRequest.parse(body));
    },
    async deleteBlock(id) {
      return send("DELETE", blockPath(id), NoBody);
    },
    async listUnsentDrafts() {
      return call("/admin/drafts", AdminUnsentDraftList);
    },
    async listReservationDrafts(reservationId) {
      return call(reservationPath(reservationId, "/drafts"), AdminReservationDraftList);
    },
    async getDraft(reservationId, draftId) {
      return call(draftPath(reservationId, draftId), AdminDraftDetail);
    },
    async setDraftStatus(reservationId, draftId, action) {
      return send(
        "POST",
        draftPath(reservationId, draftId, `/${action}`),
        NoBody,
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
