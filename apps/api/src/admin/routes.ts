// 管理 API（管理画面のスタッフだけ）のルート。1回目：予約の一覧・詳細、受付番号から探す、承認・却下・昇格・取消・繰り上げ。
// 形は docs/design-docs/admin-api.md、契約は packages/contracts の admin.ts。
// - GET  /admin/reservations?from=&to=&status=  一覧（AdminReservationListQuery → AdminReservationList）
// - GET  /admin/reservations/:id                詳細（AdminReservationDetail）
// - GET  /admin/receipts/:receiptNumber         受付番号から探す（AdminReceiptLookup）
// - POST /admin/reservations/:id/approve        承認（AdminApproveRequest → AdminOperationAccepted）
// - POST /admin/reservations/:id/reject|promote|cancel|move-up（AdminEmptyRequest → AdminOperationAccepted）
// エラーは AdminRejected（{ error: <理由> }）。管理者の id が取れないときは、どのルートも 401
// - 外から来るクエリ・本文は、最初に契約でパースする（INV-4）。返す本文も契約でパースしてから返す
// - 判定と保存は保存の層（saveReservationOperation など）に、料金・キャンセル料の計算は booking-core に任せ、ここには同じ判定を書かない
// - 日時は JST のオフセット付きの ISO 8601 で返す（INV-7）。操作の日時は API の現在時刻（deps.now）
// - ログには、思わぬエラーの種類（name）だけを出す。本文・個人情報は出さない（INV-10。公開 API と同じ）
import {
  calculateCancellationFee,
  calculatePriceFromTable,
  decidePlanId,
  holdsSlots,
} from "@zebra/booking-core";
import {
  AdminApproveRequest,
  AdminEmptyRequest,
  type AdminError,
  AdminOperationAccepted,
  AdminReceiptLookup,
  AdminRejected,
  AdminReservationDetail,
  AdminReservationList,
  AdminReservationListQuery,
  type PriceTable,
  ReceiptNumber,
} from "@zebra/contracts";
import { type Context, Hono } from "hono";
import { DateTime } from "luxon";
import {
  type AdminList,
  type AdminListedBlock,
  type AdminListedReservation,
  listAdminReservationsByStatus,
  listAdminReservationsInPeriod,
} from "../db/admin-list.ts";
import {
  type ReservationOperationInput,
  type SaveOperationFailure,
  type SaveOperationOptions,
  saveReservationOperation,
} from "../db/operations.ts";
import {
  type HistoryEntry,
  type HistorySnapshot,
  JST,
  type ReservationDetail,
  type ReservationStore,
  findReservationIdByReceiptNumber,
  getReservation,
} from "../db/reservations.ts";
import type { AdminUserIdSource } from "./admin-user.ts";

export interface AdminDeps {
  store: ReservationStore;
  /** API の現在時刻（INV-7）。操作の日時、今の見積・今取消したときのキャンセル料の計算に使う */
  now: () => DateTime;
  /** 今の料金表。承認待ちの詳細で、見積を計算し直すのに使う */
  priceTable: PriceTable;
  /** 管理者の id の取り出し方（本番は adminUserIdFromLambdaContext、手元は devAdminUserId） */
  adminUserId: AdminUserIdSource;
  /** 操作の保存のやり直しの設定（混み合ったときの確認に使う） */
  save?: Pick<SaveOperationOptions, "maxAttempts" | "beforeWrite">;
}

/** 一覧の期間の最長（JST の日。両端を含む。admin-api.md「予約の一覧」） */
export const MAX_LIST_PERIOD_DAYS = 62;

/** 1回目の操作（ルートの最後の部分）。本文は、承認だけが確定金額を持ち、ほかは何も持たない */
type OperationKind = "approve" | "reject" | "promote" | "cancel" | "move-up";

export function createAdminRoute(deps: AdminDeps): Hono {
  const route = new Hono();

  /** 管理者の id。取れない・空なら undefined */
  const adminUserIdOf = (c: Context): string | undefined => {
    const id = deps.adminUserId(c);
    return id === undefined || id === "" ? undefined : id;
  };

  // 管理者の id が取れないときは、入力の誤りやない予約でも、どのルートも 401（何も読まず、何も書かない）
  route.use("/admin/*", async (c, next) => {
    if (adminUserIdOf(c) === undefined) return rejected(c, "unauthorized");
    await next();
  });

  // 予約の一覧
  route.get("/admin/reservations", async (c) => {
    const query = parseListQuery(c.req.queries());
    if (query === undefined) return rejected(c, "invalid-input");

    const list: AdminList =
      query.from !== undefined && query.to !== undefined
        ? await listAdminReservationsInPeriod(deps.store, {
            from: query.from,
            to: query.to,
            ...(query.status === undefined ? {} : { status: query.status }),
          })
        : {
            // 契約で、期間がなければ状態があることを確かめ済み
            reservations: await listAdminReservationsByStatus(
              deps.store,
              requireDefined(query.status),
            ),
            blocks: [],
          };

    return c.json(
      AdminReservationList.parse({
        reservations: list.reservations.map(toReservationSummary),
        blocks: list.blocks.map(toBlockSummary),
      }),
      200,
    );
  });

  // 予約の詳細
  route.get("/admin/reservations/:id", async (c) => {
    const detail = await getReservation(deps.store, c.req.param("id"));
    if (detail === null) return rejected(c, "not-found");
    return c.json(AdminReservationDetail.parse(toDetail(detail, deps)), 200);
  });

  // 受付番号から探す
  route.get("/admin/receipts/:receiptNumber", async (c) => {
    const receiptNumber = ReceiptNumber.safeParse(c.req.param("receiptNumber"));
    if (!receiptNumber.success) return rejected(c, "invalid-input");
    const reservationId = await findReservationIdByReceiptNumber(deps.store, receiptNumber.data);
    if (reservationId === null) return rejected(c, "not-found");
    return c.json(AdminReceiptLookup.parse({ reservationId }), 200);
  });

  // 承認・却下・昇格・取消・繰り上げ
  for (const kind of ["approve", "reject", "promote", "cancel", "move-up"] as const) {
    route.post(`/admin/reservations/:id/${kind}`, async (c) => {
      const body = await readJsonBody(c.req.raw);
      if (!body.ok) return rejected(c, "invalid-input");
      const operation = parseOperation(kind, c.req.param("id"), body.value);
      if (operation === undefined) return rejected(c, "invalid-input");

      // 上の middleware で、取れることを確かめ済み
      const adminUserId = requireDefined(adminUserIdOf(c));
      const result = await saveReservationOperation(deps.store, operation, {
        now: deps.now(),
        adminUserId,
        ...(deps.save?.maxAttempts === undefined ? {} : { maxAttempts: deps.save.maxAttempts }),
        ...(deps.save?.beforeWrite === undefined ? {} : { beforeWrite: deps.save.beforeWrite }),
      });
      if (!result.ok) return rejected(c, errorOf(result.reason));
      // 下書きは作るだけで送らない（INV-6。送るのは3回目の管理 API）
      return c.json(
        AdminOperationAccepted.parse({ drafts: result.drafts.map((saved) => saved.draft) }),
        200,
      );
    });
  }

  // 思わぬエラー：お客様の情報が混ざらないよう、エラーの種類（name）だけをログに出し、中身は返さない（INV-10）
  route.onError((error, c) => {
    console.error(`管理 API の処理で思わぬエラー（${error.name}）`);
    return c.text("Internal Server Error", 500);
  });

  return route;
}

// ---- 入力のパース（INV-4） ----

/**
 * 一覧のクエリを契約（AdminReservationListQuery）でパースし、期間の前後と長さ（最長62日）を確かめる。
 * 同じキーが2回以上あるクエリは、どちらを使うか決められないので通さない。正しくなければ undefined
 */
function parseListQuery(queries: Record<string, string[]>): AdminReservationListQuery | undefined {
  const single: Record<string, string> = {};
  for (const [key, values] of Object.entries(queries)) {
    const [value, ...rest] = values;
    if (value === undefined || rest.length > 0) return undefined;
    single[key] = value;
  }
  const parsed = AdminReservationListQuery.safeParse(single);
  if (!parsed.success) return undefined;
  const query = parsed.data;
  if (query.from !== undefined && query.to !== undefined) {
    const from = DateTime.fromISO(query.from, { zone: JST });
    const to = DateTime.fromISO(query.to, { zone: JST });
    if (!from.isValid || !to.isValid) return undefined;
    // JST には夏時間がないので、日の差は整数になる。両端を含むので、日数は差 + 1
    const days = to.diff(from, "days").days + 1;
    if (days < 1 || days > MAX_LIST_PERIOD_DAYS) return undefined;
  }
  return query;
}

/** 本文を JSON として読む。JSON でなければ（空の本文を含む）失敗。本文はログに出さない（INV-10） */
async function readJsonBody(
  request: Request,
): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false }> {
  try {
    return { ok: true, value: JSON.parse(await request.text()) as unknown };
  } catch {
    return { ok: false };
  }
}

/** 本文を操作ごとの契約でパースして、保存の層の操作にする。正しくなければ undefined */
function parseOperation(
  kind: OperationKind,
  reservationId: string,
  body: unknown,
): ReservationOperationInput | undefined {
  if (kind === "approve") {
    const parsed = AdminApproveRequest.safeParse(body);
    return parsed.success
      ? { kind, reservationId, confirmedPrice: parsed.data.confirmedPrice }
      : undefined;
  }
  return AdminEmptyRequest.safeParse(body).success ? { kind, reservationId } : undefined;
}

// ---- 返事 ----

function rejected(c: Context, error: AdminError): Response {
  return c.json(AdminRejected.parse({ error }), statusOf(error));
}

function statusOf(error: AdminError): 400 | 401 | 404 | 409 | 503 {
  switch (error) {
    case "invalid-input":
      return 400;
    case "unauthorized":
      return 401;
    case "not-found":
      return 404;
    case "not-pending":
    case "invalid-status":
    case "still-held":
      return 409;
    case "busy":
      return 503;
  }
}

/**
 * 保存の層の、できない理由から管理 API のエラーへ。1回目の操作（承認・却下・昇格・取消・繰り上げ）では、
 * 変更だけの理由（重なり・変更できない・時間の決まり）は起きないので、起きたら思わぬエラーにする
 */
function errorOf(reason: SaveOperationFailure): AdminError {
  switch (reason) {
    case "not-found":
    case "not-pending":
    case "invalid-status":
    case "still-held":
    case "busy":
      return reason;
    case "overlaps-existing":
    case "not-changeable":
    case "not-on-30-minute-boundary":
    case "shorter-than-2-hours":
    case "longer-than-24-hours":
      throw new Error("1回目の操作では起きない理由");
  }
}

function requireDefined<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("契約で確かめ済みの値がない");
  return value;
}

/** 返す日時：ISO 8601、JST のオフセット付き（INV-7。admin-api.md「返すときの決まり」） */
function jstIso(dateTime: DateTime): string {
  const iso = dateTime.setZone(JST).toISO({ suppressMilliseconds: true });
  if (iso === null) throw new RangeError("日時が不正");
  return iso;
}

function toReservationSummary(r: AdminListedReservation) {
  return {
    id: r.id,
    ...(r.receiptNumber === undefined ? {} : { receiptNumber: r.receiptNumber }),
    status: r.status,
    start: jstIso(r.start),
    end: jstIso(r.end),
    bufferMinutes: r.bufferMinutes,
    route: r.route,
    partySize: r.partySize,
    estimateIncludingTax: r.estimateIncludingTax,
    ...(r.confirmedPrice === undefined ? {} : { confirmedPrice: r.confirmedPrice }),
    ...(r.provisionalIds === undefined ? {} : { provisionalIds: [...r.provisionalIds] }),
    customerName: r.customerName,
  };
}

function toBlockSummary(b: AdminListedBlock) {
  return {
    id: b.id,
    start: jstIso(b.start),
    end: jstIso(b.end),
    bufferMinutes: b.bufferMinutes,
    route: b.route,
    ...(b.memo === undefined ? {} : { memo: b.memo }),
  };
}

/** 予約の詳細を返す形にする。承認待ちなら今の見積、取消できる状態なら今取消したときのキャンセル料を付ける */
function toDetail(detail: ReservationDetail, deps: AdminDeps) {
  const currentEstimate = isPending(detail) ? estimateNow(detail, deps.priceTable) : undefined;
  const cancellationFee = isCancellable(detail)
    ? cancellationFeeNow(detail, deps.now())
    : undefined;
  return {
    id: detail.id,
    ...(detail.receiptNumber === undefined ? {} : { receiptNumber: detail.receiptNumber }),
    status: detail.status,
    start: jstIso(detail.start),
    end: jstIso(detail.end),
    bufferMinutes: detail.bufferMinutes,
    route: detail.route,
    partySize: detail.partySize,
    cycloramaFloorProtection: detail.cycloramaFloorProtection,
    planId: detail.planId,
    equipmentInsurance: detail.equipmentInsurance,
    optionIds: [...detail.optionIds],
    estimate: { ...detail.estimate },
    ...(detail.confirmedPrice === undefined ? {} : { confirmedPrice: detail.confirmedPrice }),
    ...(detail.provisionalIds === undefined ? {} : { provisionalIds: [...detail.provisionalIds] }),
    createdAt: jstIso(detail.createdAt),
    updatedAt: jstIso(detail.updatedAt),
    customer: { ...detail.customer },
    shooting: {
      ...detail.shooting,
      ...(detail.shooting.types === undefined ? {} : { types: [...detail.shooting.types] }),
    },
    history: detail.history.map(toHistoryEntry),
    ...(currentEstimate === undefined ? {} : { currentEstimate }),
    ...(cancellationFee === undefined ? {} : { cancellationFeeIfCancelledNow: cancellationFee }),
  };
}

function isPending(detail: ReservationDetail): boolean {
  return (
    detail.status === "pending-firm" ||
    detail.status === "pending-provisional" ||
    detail.status === "pending-second-hold"
  );
}

/** 取消できる状態（仮予約・本予約・第二キープ）。承認待ちは取消でなく却下する（reservation-model.md「状態と操作」） */
function isCancellable(
  detail: ReservationDetail,
): detail is ReservationDetail & { status: "provisional" | "firm" | "second-hold" } {
  return holdsSlots(detail.status) && !isPending(detail);
}

/**
 * 今の料金表で計算し直した見積（reservation-model.md「金額」）。プランも今の料金表の決め方で決め直す。
 * 今の料金表で計算できない予約（料金表からなくなったオプションを選んでいる、など）は、比べる見積がないので返さない
 */
function estimateNow(detail: ReservationDetail, priceTable: PriceTable) {
  try {
    const planId = decidePlanId(priceTable, {
      partySize: detail.partySize,
      cycloramaFloorProtection: detail.cycloramaFloorProtection,
    });
    return calculatePriceFromTable(priceTable, {
      planId,
      start: detail.start,
      end: detail.end,
      equipmentInsurance: detail.equipmentInsurance,
      optionIds: detail.optionIds,
    });
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

/**
 * 今取消したときのキャンセル料（確定金額で計算する。reservation-model.md「金額」）。日数は now の JST の日で数える（INV-7）。
 * 開始以降の本予約の取消は扱いが未決事項（booking-core が RangeError を投げる）なので、返さない
 */
function cancellationFeeNow(
  detail: ReservationDetail & { status: "provisional" | "firm" | "second-hold" },
  now: DateTime,
) {
  if (detail.confirmedPrice === undefined) {
    throw new Error("取消できる状態の予約に確定金額がない");
  }
  if (detail.status === "firm" && now.toMillis() >= detail.start.toMillis()) return undefined;
  return calculateCancellationFee({
    status: detail.status,
    amount: detail.confirmedPrice,
    start: detail.start,
    cancelledAt: now,
  });
}

function toHistoryEntry(entry: HistoryEntry) {
  return {
    at: jstIso(entry.at),
    actor: { ...entry.actor },
    operation: entry.operation,
    ...(entry.before === undefined ? {} : { before: toSnapshot(entry.before) }),
    ...(entry.after === undefined ? {} : { after: toSnapshot(entry.after) }),
    ...(entry.changedFields === undefined ? {} : { changedFields: [...entry.changedFields] }),
    ...(entry.estimate === undefined ? {} : { estimate: { ...entry.estimate } }),
  };
}

function toSnapshot(snapshot: HistorySnapshot) {
  return {
    ...snapshot,
    start: jstIso(snapshot.start),
    end: jstIso(snapshot.end),
    ...(snapshot.provisionalIds === undefined
      ? {}
      : { provisionalIds: [...snapshot.provisionalIds] }),
    ...(snapshot.optionIds === undefined ? {} : { optionIds: [...snapshot.optionIds] }),
  };
}
