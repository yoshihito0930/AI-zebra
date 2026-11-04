// 管理 API（管理画面のスタッフだけ）のルート。形は docs/design-docs/admin-api.md、契約は packages/contracts の admin.ts。
// 1回目：予約の一覧・詳細、受付番号から探す、承認・却下・昇格・取消・繰り上げ
// - GET  /admin/reservations?from=&to=&status=  一覧（AdminReservationListQuery → AdminReservationList）
// - GET  /admin/reservations/:id                詳細（AdminReservationDetail）
// - GET  /admin/receipts/:receiptNumber         受付番号から探す（AdminReceiptLookup）
// - POST /admin/reservations/:id/approve        承認（AdminApproveRequest → AdminOperationAccepted）
// - POST /admin/reservations/:id/reject|promote|cancel|move-up（AdminEmptyRequest → AdminOperationAccepted）
// 2回目a：予約の変更・直接入力（警告の確認つき）、ブロック枠を入れる・直す・消す
// - POST   /admin/reservations/:id/change       変更（AdminChangeRequest → 200 と AdminOperationAccepted）
// - POST   /admin/reservations                  直接入力（AdminDirectEntryRequest → 201 と AdminDirectEntryAccepted）
// - POST   /admin/blocks                        ブロック枠を入れる（AdminBlockRequest → 201 と AdminBlockCreated）
// - PUT    /admin/blocks/:id                    ブロック枠を直す（AdminBlockRequest → 200。本文なし。契約がないため）
// - DELETE /admin/blocks/:id                    ブロック枠を消す（本文は読まない → 200。本文なし）
// エラーは AdminRejected（{ error: <理由> }。確認していない警告があるときは warnings も）。管理者の id が取れないときは、どのルートも 401
// - 外から来るクエリ・本文は、最初に契約でパースする（INV-4）。返す本文も契約でパースしてから返す
// - 判定と保存は保存の層（saveReservationOperation・saveDirectEntry・saveAdminBlock など）に、料金・キャンセル料の計算は
//   booking-core に任せ、ここには同じ判定を書かない
// - 警告の確認（変更・直接入力）は、保存の層に確認した警告の一覧を渡し、保存の層が不可の決まりと同じ読んだデータで警告を計算して比べる
//   （ここで別に読んで警告を計算すると、読んでから保存までのほかの書き込みで、判定に使うデータが食い違うため）
// - 日時は JST のオフセット付きの ISO 8601 で返す（INV-7）。操作の日時は API の現在時刻（deps.now）
// - ログには、思わぬエラーの種類（name）だけを出す。本文・個人情報は出さない（INV-10。公開 API と同じ）
import {
  calculateCancellationFee,
  calculatePriceFromTable,
  checkAdminDuration,
  decidePlanId,
  holdsSlots,
} from "@zebra/booking-core";
import {
  AdminApproveRequest,
  AdminBlockCreated,
  AdminBlockRequest,
  AdminChangeRequest,
  AdminDirectEntryAccepted,
  AdminDirectEntryRequest,
  AdminEmptyRequest,
  type AdminError,
  AdminOperationAccepted,
  AdminReceiptLookup,
  AdminRejected,
  AdminReservationDetail,
  AdminReservationList,
  AdminReservationListQuery,
  type AdminWarning,
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
  type AdminBlockInput,
  deleteAdminBlock,
  saveAdminBlock,
  updateAdminBlock,
} from "../db/blocks.ts";
import { type DirectEntry, saveDirectEntry } from "../db/direct-entry.ts";
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
  type StoredCustomerInfo,
  type StoredShootingInfo,
  findReservationIdByReceiptNumber,
  getReservation,
} from "../db/reservations.ts";
import type { AdminUserIdSource } from "./admin-user.ts";

export interface AdminDeps {
  store: ReservationStore;
  /** API の現在時刻（INV-7）。操作の日時、今の見積・今取消したときのキャンセル料の計算に使う */
  now: () => DateTime;
  /** 今の料金表。承認待ちの詳細・変更・直接入力で、見積を計算し直す（計算する）のに使う */
  priceTable: PriceTable;
  /** 管理者の id の取り出し方（本番は adminUserIdFromLambdaContext、手元は devAdminUserId） */
  adminUserId: AdminUserIdSource;
  /** 操作の保存のやり直しの設定（混み合ったときの確認に使う）。どの操作の保存（変更・直接入力・ブロック枠を含む）にも渡す */
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
        ...retryOptions(deps),
      });
      if (!result.ok) {
        // 警告の確認は、確認した警告の一覧を渡したとき（変更）だけなので、1回目の操作では起きない
        if (result.reason === "unacknowledged-warnings") {
          throw new Error("1回目の操作では起きない理由");
        }
        return rejected(c, errorOf(result.reason));
      }
      // 下書きは作るだけで送らない（INV-6。送るのは3回目の管理 API）
      return c.json(
        AdminOperationAccepted.parse({ drafts: result.drafts.map((saved) => saved.draft) }),
        200,
      );
    });
  }

  // 予約の変更。不可の決まり（30分単位・最短2時間・最長24時間・空き判定・変更できない状態）と警告は、保存の層が同じ読んだデータで判定する
  route.post("/admin/reservations/:id/change", async (c) => {
    const body = await readJsonBody(c.req.raw);
    if (!body.ok) return rejected(c, "invalid-input");
    const parsed = AdminChangeRequest.safeParse(body.value);
    if (!parsed.success) return rejected(c, "invalid-input");
    const request = parsed.data;
    const range = rangeOf(request);
    if (range === undefined || !knownOptions(deps.priceTable, request.optionIds)) {
      return rejected(c, "invalid-input");
    }

    const result = await saveReservationOperation(
      deps.store,
      {
        kind: "change",
        reservationId: c.req.param("id"),
        start: range.start,
        end: range.end,
        content: {
          partySize: request.partySize,
          cycloramaFloorProtection: request.cycloramaFloorProtection,
          equipmentInsurance: request.equipmentInsurance,
          optionIds: request.optionIds,
        },
        confirmedPrice: request.confirmedPrice,
        // 見積は今の料金表で計算し直す（保存の層が履歴に残す）
        priceTable: deps.priceTable,
      },
      {
        now: deps.now(),
        adminUserId: requireDefined(adminUserIdOf(c)),
        ...retryOptions(deps),
        // 省略は空と同じ（まだ何も確認していない）。渡すと、保存の層が確認していない警告で止める
        acknowledgedWarnings: request.acknowledgedWarnings ?? [],
      },
    );
    if (!result.ok) {
      return result.reason === "unacknowledged-warnings"
        ? unacknowledged(c, result.warnings)
        : rejected(c, changeErrorOf(result.reason));
    }
    // 下書きは作るだけで送らない（INV-6）
    return c.json(
      AdminOperationAccepted.parse({ drafts: result.drafts.map((saved) => saved.draft) }),
      200,
    );
  });

  // 直接入力。経路は admin、バッファは初期値の60分（保存の層が決める）。不可の決まりと警告は、保存の層が同じ読んだデータで判定する
  route.post("/admin/reservations", async (c) => {
    const body = await readJsonBody(c.req.raw);
    if (!body.ok) return rejected(c, "invalid-input");
    const parsed = AdminDirectEntryRequest.safeParse(body.value);
    if (!parsed.success) return rejected(c, "invalid-input");
    const request = parsed.data;
    const range = rangeOf(request);
    if (range === undefined || !knownOptions(deps.priceTable, request.optionIds)) {
      return rejected(c, "invalid-input");
    }

    // 見積は30分単位でない区間では計算できないので、時間の決まり（不可）を見積より先に確かめる（保存の層も同じ判定をもう一度する）
    const duration = checkAdminDuration(range.start, range.end);
    if (!duration.ok) return rejected(c, duration.reason);

    // プランと見積は、今の料金表で決める（booking.md「料金」。INV-9。金額の計算は booking-core だけで行う）
    const planId = decidePlanId(deps.priceTable, {
      partySize: request.partySize,
      cycloramaFloorProtection: request.cycloramaFloorProtection,
    });
    const estimate = calculatePriceFromTable(deps.priceTable, {
      planId,
      start: range.start,
      end: range.end,
      equipmentInsurance: request.equipmentInsurance,
      optionIds: request.optionIds,
    });
    const entry: DirectEntry = {
      kind: request.kind,
      start: range.start,
      end: range.end,
      partySize: request.partySize,
      cycloramaFloorProtection: request.cycloramaFloorProtection,
      planId,
      equipmentInsurance: request.equipmentInsurance,
      optionIds: request.optionIds,
      estimate,
      confirmedPrice: request.confirmedPrice,
      customer: storedCustomerOf(request.customer),
      shooting: storedShootingOf(request.shooting),
    };

    const result = await saveDirectEntry(deps.store, entry, {
      now: deps.now(),
      adminUserId: requireDefined(adminUserIdOf(c)),
      ...retryOptions(deps),
      // 省略は空と同じ（まだ何も確認していない）
      acknowledgedWarnings: request.acknowledgedWarnings ?? [],
    });
    if (!result.ok) {
      return result.reason === "unacknowledged-warnings"
        ? unacknowledged(c, result.warnings)
        : rejected(c, result.reason);
    }
    return c.json(AdminDirectEntryAccepted.parse({ reservationId: result.id }), 201);
  });

  // ブロック枠を入れる（警告はない）
  route.post("/admin/blocks", async (c) => {
    const block = await readBlockRequest(c.req.raw);
    if (block === undefined) return rejected(c, "invalid-input");
    const result = await saveAdminBlock(deps.store, block, retryOptions(deps));
    if (!result.ok) return rejected(c, result.reason);
    return c.json(AdminBlockCreated.parse({ blockId: result.id }), 201);
  });

  // ブロック枠を直す（直すときも全部を送る。メモを送らなければメモはなくなる）
  route.put("/admin/blocks/:id", async (c) => {
    const block = await readBlockRequest(c.req.raw);
    if (block === undefined) return rejected(c, "invalid-input");
    const result = await updateAdminBlock(deps.store, c.req.param("id"), block, retryOptions(deps));
    if (!result.ok) return rejected(c, result.reason);
    // 返す本文の形は資料・契約にないので、本文は返さない
    return c.body(null, 200);
  });

  // ブロック枠を消す（本文は読まない）
  route.delete("/admin/blocks/:id", async (c) => {
    const result = await deleteAdminBlock(deps.store, c.req.param("id"), retryOptions(deps));
    if (!result.ok) return rejected(c, result.reason);
    return c.body(null, 200);
  });

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

/**
 * 本文の予約区間（ブロック枠の区間）を DateTime にする。日時はオフセット付きの ISO 8601（契約で確かめ済み）で、
 * どのゾーンで来ても、判定は booking-core が JST で行う（INV-7）。終わりが開始以前の区間は、決まりで判定できない入力の誤りとして undefined
 */
function rangeOf(request: {
  readonly start: string;
  readonly end: string;
}): { readonly start: DateTime; readonly end: DateTime } | undefined {
  const start = DateTime.fromISO(request.start, { setZone: true });
  const end = DateTime.fromISO(request.end, { setZone: true });
  if (!start.isValid || !end.isValid || end.toMillis() <= start.toMillis()) return undefined;
  return { start, end };
}

/** オプションが今の料金表にあるものだけか（料金表にない id は、料金を決められない入力の誤り。公開 API の申込と同じ） */
function knownOptions(priceTable: PriceTable, optionIds: readonly string[]): boolean {
  return optionIds.every((id) => priceTable.options.some((option) => option.id === id));
}

/** ブロック枠を入れる・直す本文を読み、契約（AdminBlockRequest）でパースする。正しくなければ undefined */
async function readBlockRequest(request: Request): Promise<AdminBlockInput | undefined> {
  const body = await readJsonBody(request);
  if (!body.ok) return undefined;
  const parsed = AdminBlockRequest.safeParse(body.value);
  if (!parsed.success) return undefined;
  const range = rangeOf(parsed.data);
  if (range === undefined) return undefined;
  const { bufferMinutes, memo } = parsed.data;
  return { ...range, bufferMinutes, ...(memo === undefined ? {} : { memo }) };
}

/**
 * 直接入力のお客様の情報を、保存の形にする（入れていない欄は持たない）。
 * 氏名と、電話番号かメールアドレスのどちらか1つが必須なことは、契約で確かめ済み
 */
function storedCustomerOf(customer: AdminDirectEntryRequest["customer"]): StoredCustomerInfo {
  const optional = {
    ...(customer.companyName === undefined ? {} : { companyName: customer.companyName }),
    ...(customer.address === undefined ? {} : { address: customer.address }),
    ...(customer.photographerName === undefined
      ? {}
      : { photographerName: customer.photographerName }),
  };
  if (customer.email !== undefined) {
    return {
      name: customer.name,
      ...optional,
      email: customer.email,
      ...(customer.phone === undefined ? {} : { phone: customer.phone }),
    };
  }
  return { name: customer.name, ...optional, phone: requireDefined(customer.phone) };
}

/** 直接入力の撮影の内容を、保存の形にする（どの欄も任意。入れていない欄は持たない） */
function storedShootingOf(shooting: AdminDirectEntryRequest["shooting"]): StoredShootingInfo {
  return {
    ...(shooting.types === undefined ? {} : { types: shooting.types }),
    ...(shooting.details === undefined ? {} : { details: shooting.details }),
    ...(shooting.notes === undefined ? {} : { notes: shooting.notes }),
  };
}

/** 保存の層に渡す、やり直しの設定（AdminDeps.save）。どの操作の保存にも同じものを渡す */
function retryOptions(deps: AdminDeps): Pick<SaveOperationOptions, "maxAttempts" | "beforeWrite"> {
  return {
    ...(deps.save?.maxAttempts === undefined ? {} : { maxAttempts: deps.save.maxAttempts }),
    ...(deps.save?.beforeWrite === undefined ? {} : { beforeWrite: deps.save.beforeWrite }),
  };
}

// ---- 返事 ----

function rejected(c: Context, error: AdminError): Response {
  return c.json(AdminRejected.parse({ error }), statusOf(error));
}

/** 確認していない警告がある：409 と、今の警告の一覧（確認したものも含めた全部） */
function unacknowledged(c: Context, warnings: readonly AdminWarning[]): Response {
  return c.json(
    AdminRejected.parse({ error: "unacknowledged-warnings", warnings: [...warnings] }),
    statusOf("unacknowledged-warnings"),
  );
}

/** エラーの理由から HTTP のステータスへ（admin-api.md「返すときの決まり」の表） */
function statusOf(error: AdminError): 400 | 401 | 404 | 409 | 422 | 503 {
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
    case "not-changeable":
    case "google-calendar-block":
    case "unacknowledged-warnings":
      return 409;
    case "not-on-30-minute-boundary":
    case "shorter-than-2-hours":
    case "longer-than-24-hours":
    case "overlaps-existing":
    case "no-provisional-to-hold":
    case "more-than-90-days":
      return 422;
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

/**
 * 変更の保存の、できない理由から管理 API のエラーへ。承認・却下・昇格・取消・繰り上げだけの理由
 * （承認待ちでない・その操作ができる状態でない・まだ重なっている）は変更では起きないので、起きたら思わぬエラーにする
 */
function changeErrorOf(reason: SaveOperationFailure): AdminError {
  switch (reason) {
    case "not-found":
    case "not-changeable":
    case "overlaps-existing":
    case "not-on-30-minute-boundary":
    case "shorter-than-2-hours":
    case "longer-than-24-hours":
    case "busy":
      return reason;
    case "not-pending":
    case "invalid-status":
    case "still-held":
      throw new Error("変更では起きない理由");
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
 * 開始以降の本予約は取消できない（booking.md の未決事項。取消の操作は booking-core が invalid-status にする）ので、返さない
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
