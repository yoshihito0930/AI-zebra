import { CreateTableCommand, DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import {
  AdminDraftDetail,
  AdminOperationAccepted,
  AdminReservationDraftList,
  AdminUnsentDraftList,
  PriceTable,
  Yen,
} from "@zebra/contracts";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { createLocalDynamoClient } from "../db/client.ts";
import { type ReservationOperationInput, saveReservationOperation } from "../db/operations.ts";
import {
  type ApplicationKind,
  type ReservationApplication,
  type ReservationStore,
  saveApplication,
} from "../db/reservations.ts";
import type { AdminUserIdSource } from "./admin-user.ts";
import { type AdminDeps, createAdminRoute } from "./routes.ts";

// 操作の返事の下書きに、下書きの id（draftId）が付くことの統合テスト（DynamoDB Local）。
// 根拠：docs/design-docs/admin-api.md「操作（1回目）」（成功したら、作った下書きの一覧〈種類、あて先の予約の id、下書きの id、
// 差し込む値〉を返す。下書きの id は、3回目のルートで下書きを開くときに、あて先の予約の id と組で使う）、
// 「下書き（3回目）」（下書きの id が重ならないのは1つの予約の中だけ。下書きを指すときは、いつも予約の id と組にする。
// 未送信の一覧で見分けるときも組で見分ける）、「変更・直接入力・ブロック枠（2回目a）」「バッファの切り替え・お客様の情報の変更（2回目b）」、
// reservation-model.md「状態と操作」（どの操作がどの下書きを作るか）、booking.md「第二キープ」「バッファを30分に縮める」
// 「予約の変更」「取消とキャンセル料」、core-beliefs.md（INV-6、INV-7）、
// packages/contracts の admin.ts（AdminOperationAccepted の draftId。契約は今は省略を許しているが、API はいつも付ける。
// AdminReservationDraftList、AdminDraftDetail、AdminUnsentDraftList）。
// 状態・枠・下書きの種類と差し込む値の細かい決まりは routes.int.test.ts・routes-round2a.int.test.ts・routes-round2b.int.test.ts で、
// 下書きの一覧・開く・文面は routes-round3.int.test.ts で確かめているので、ここでは返事の下書きの id が、
// 3回目のルートの下書きと同じものを指すことを確かめる。
// - 操作は、ほかの操作のテストと同じく createAdminRoute（現在時刻と料金表を渡す）で呼ぶ。下書きの一覧と開くは、
//   3回目のテストと同じく createApp（担当者名と署名の設定なし）で呼ぶ。どちらも同じテーブルを使う
// - 返事の下書きのそれぞれについて、次を確かめる
//   (1) draftId が付いている（1文字以上の文字列）。1つの予約の中で、返事の draftId は重ならない
//   (2) 返事の reservationId と draftId の組で GET /admin/reservations/{reservationId}/drafts/{draftId} を開くと 200 で、
//       AdminDraftDetail を通り、draftId・reservationId・種類が返事と同じ。状態は未送信
//   (3) 返事の draftId は、GET /admin/reservations/{reservationId}/drafts の一覧にある id と同じ。操作の前の一覧になかった
//       下書き（その操作が作ったもの）が、その予約の返事の下書きと、id と種類で過不足なく一致する。作った日時は API の現在時刻
//   (4) 未送信の一覧（GET /admin/drafts）に、同じ予約の id・下書きの id・種類の組がある
// - 1つの操作が別の予約に作った下書き（昇格で終了した第二キープ、取消・変更・バッファの切り替えで付かなくなった第二キープへの
//   繰り上げ案内、第二キープの取消・終了に続く前倒しの案内）も、その予約の id と組で確かめる
// - 何も作らない操作（何も変えない変更、今と同じバッファ、第二キープのない本予約のバッファの切り替え、繰り上げ）は、
//   200 と { drafts: [] } で、関わる予約の下書きの一覧が操作の前と変わらないことを確かめる
// - 下書きの並び順は決めていないので、件数と中身で比べる
// - 例の表には年がないので 2026 年とし、予約は 10/20 とする。API の現在時刻は 2026/10/05 09:00 とする
// - 架空のお客様の情報を使う

const client = createLocalDynamoClient();
let store: ReservationStore;

// テーブルはキー設計どおり（pk・sk、GSI の gsi1pk・gsi1sk）にテストごとに作り、終わったら消す
async function createTable(): Promise<ReservationStore> {
  const tableName = `int-test-draft-id-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
        { AttributeName: "gsi1pk", AttributeType: "S" },
        { AttributeName: "gsi1sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "gsi1",
          KeySchema: [
            { AttributeName: "gsi1pk", KeyType: "HASH" },
            { AttributeName: "gsi1sk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
  return { client, tableName };
}

// ---- 日時（INV-7）。テストの日時は JST で書く。現在時刻は固定する ----

function jst(iso: string): DateTime {
  const dateTime = DateTime.fromISO(iso, { zone: "Asia/Tokyo" });
  if (!dateTime.isValid) {
    throw new Error(`テストの日時が不正：${iso}`);
  }
  return dateTime;
}

/** 申込の時刻（固定） */
const appliedAt = jst("2026-10-01T12:00");
/** テストの準備でする承認・取消の時刻（固定。操作で作った下書きと、準備で作った下書きを見分けるため、API の現在時刻と違える） */
const preparedAt = jst("2026-10-02T12:00");
/** API の現在時刻（固定）。操作の日時になる */
const operatedAt = jst("2026-10-05T09:00");

beforeEach(async () => {
  store = await createTable();
  // 3回目のルート（createApp）の現在時刻も固定する（偽の時計）
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(operatedAt.toMillis());
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await client.send(new DeleteTableCommand({ TableName: store.tableName }));
});

/** API を呼ぶ管理者（架空のユーザー id） */
const adminUserId = "admin-user-kaku-draft-id";
/** 準備の操作をした管理者（架空のユーザー id） */
const preparingAdminUserId = "admin-user-kaku-draft-id-prep";

/** 返した日時の文字列が、ISO 8601 で JST のオフセット（+09:00）付きで、その時点であること */
function expectInstant(value: string | undefined, at: DateTime): void {
  expect(value, value).toMatch(/\+09:00$/);
  const parsed = DateTime.fromISO(value ?? "", { setZone: true });
  expect(parsed.isValid, value).toBe(true);
  expect(parsed.toMillis()).toBe(at.toMillis());
}

// ---- 料金表（booking.md「料金」から作る。変更の見積の再計算に使う） ----

const priceTable = PriceTable.parse({
  plans: [
    { id: "A", name: "プランA", halfHourRates: { normal: 2_500, lateNight: 3_750 } },
    { id: "B", name: "プランB", halfHourRates: { normal: 2_750, lateNight: 4_125 } },
  ],
  planRules: [
    { plan: "A", maxPartySize: 10 },
    { plan: "A", cycloramaFloorProtection: true },
    { plan: "B" },
  ],
  equipmentInsurance: 1_000,
  options: [
    { id: "workshop", name: "6人以上のワークショップでの利用", price: 2_000 },
    { id: "glitter", name: "ラメやグリッターを多用した衣装・小道具の持ち込み", price: 2_000 },
  ],
});

// ---- 架空のお客様の情報 ----

const customer = {
  name: "架空 下書番号花子",
  email: "shitagaki.bango.kaku@example.com",
  phone: "090-0000-4646",
  address: "架空県架空市下書町4-6-4",
  photographerName: "仮名 下書撮影",
} as const;

const shooting = {
  types: ["still"],
  details: "架空の撮影詳細：下書きの id の確認用",
  notes: "架空の補足事項：下書きの id の確認用",
} as const;

/** 申込の内容（人数4人・養生なし・機材保険なし・オプションなし。見積 10,000円・税込 11,000円） */
function application(kind: ApplicationKind, start: string, end: string): ReservationApplication {
  return {
    kind,
    start: jst(start),
    end: jst(end),
    partySize: 4,
    cycloramaFloorProtection: false,
    planId: "A",
    equipmentInsurance: false,
    optionIds: [],
    estimate: {
      subtotalExcludingTax: Yen.parse(10_000),
      estimateIncludingTax: Yen.parse(11_000),
    },
    customer,
    shooting: { ...shooting, types: [...shooting.types] },
  };
}

// ---- 準備の道具（保存の層の関数で作る） ----

async function apply(kind: ApplicationKind, start: string, end: string): Promise<string> {
  const result = await saveApplication(store, application(kind, start, end), { now: appliedAt });
  if (!result.ok) {
    throw new Error(`準備の申込が不可になった（${kind} ${start}–${end}、${result.reason}）`);
  }
  return result.id;
}

async function prepareOperation(operation: ReservationOperationInput): Promise<void> {
  const result = await saveReservationOperation(store, operation, {
    now: preparedAt,
    adminUserId: preparingAdminUserId,
  });
  if (!result.ok) {
    throw new Error(`準備の操作が不可になった（${operation.kind}、${result.reason}）`);
  }
}

/** 申込して承認する（準備）。確定金額は、指定がなければ 22,000円 */
async function applyApproved(
  kind: ApplicationKind,
  start: string,
  end: string,
  confirmedPrice = 22_000,
): Promise<string> {
  const id = await apply(kind, start, end);
  await prepareOperation({
    kind: "approve",
    reservationId: id,
    confirmedPrice: Yen.parse(confirmedPrice),
  });
  return id;
}

// ---- API を呼ぶ道具 ----

function deps(): AdminDeps {
  return {
    store,
    now: () => operatedAt,
    priceTable,
    adminUserId: () => adminUserId,
  };
}

/** 操作を POST する（既定の本文は {}。AdminEmptyRequest） */
async function post(path: string, body: unknown = {}): Promise<Response> {
  return createAdminRoute(deps()).request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const adminSource: AdminUserIdSource = () => adminUserId;

/** 3回目のルート（下書きの一覧・開く）を GET する */
async function getDrafts(path: string): Promise<Response> {
  return createApp(store, adminSource).request(path, { method: "GET" });
}

async function okJson(res: Response): Promise<unknown> {
  const text = await res.text();
  expect(res.status, text).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("application/json");
  return JSON.parse(text) as unknown;
}

type OperationDraft = AdminOperationAccepted["drafts"][number];
/** 下書きの id を除いた返事の下書き（種類ごとに除く） */
type DraftWithoutId = OperationDraft extends infer D
  ? D extends OperationDraft
    ? Omit<D, "draftId">
    : never
  : never;

/** 操作が成功したときの返事が AdminOperationAccepted を通ることを確かめ、下書きを返す */
async function acceptedDrafts(res: Response): Promise<OperationDraft[]> {
  const json = await okJson(res);
  const parsed = AdminOperationAccepted.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  return parsed.success ? parsed.data.drafts : [];
}

function reservationPath(reservationId: string): string {
  return `/admin/reservations/${encodeURIComponent(reservationId)}`;
}

function draftPath(reservationId: string, draftId: string): string {
  return `${reservationPath(reservationId)}/drafts/${encodeURIComponent(draftId)}`;
}

async function reservationDrafts(
  reservationId: string,
): Promise<AdminReservationDraftList["drafts"]> {
  const json = await okJson(await getDrafts(`${reservationPath(reservationId)}/drafts`));
  const parsed = AdminReservationDraftList.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  if (!parsed.success) throw new Error("AdminReservationDraftList を通らない");
  return parsed.data.drafts;
}

async function unsentDrafts(): Promise<AdminUnsentDraftList["drafts"]> {
  const json = await okJson(await getDrafts("/admin/drafts"));
  const parsed = AdminUnsentDraftList.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  if (!parsed.success) throw new Error("AdminUnsentDraftList を通らない");
  return parsed.data.drafts;
}

async function openDraft(reservationId: string, draftId: string): Promise<AdminDraftDetail> {
  const json = await okJson(await getDrafts(draftPath(reservationId, draftId)));
  const parsed = AdminDraftDetail.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  if (!parsed.success) throw new Error("AdminDraftDetail を通らない");
  return parsed.data;
}

type DraftLists = Map<string, AdminReservationDraftList["drafts"]>;

/** 操作の前の、関わる予約それぞれの下書きの一覧 */
async function draftListsOf(reservationIds: readonly string[]): Promise<DraftLists> {
  const lists: DraftLists = new Map();
  for (const id of reservationIds) {
    lists.set(id, await reservationDrafts(id));
  }
  return lists;
}

/** 返事の下書きから、下書きの id を除いたもの（種類・あて先・差し込む値を、ほかの操作のテストと同じ形で比べるため） */
function withoutDraftId(draft: OperationDraft): DraftWithoutId {
  return Object.fromEntries(
    Object.entries(draft).filter(([key]) => key !== "draftId"),
  ) as DraftWithoutId;
}

/** 下書きの並び順は決めていないので、件数と中身で比べる */
function expectSameItems(actual: readonly unknown[], expected: readonly unknown[]): void {
  expect(actual).toHaveLength(expected.length);
  expect(actual).toEqual(expect.arrayContaining([...expected]));
}

function idAndKind(draft: { draftId?: string | undefined; kind: string }): string {
  return `${draft.kind} ${String(draft.draftId)}`;
}

/**
 * 返事の下書きが期待どおりの種類・あて先・差し込む値で、どれにも draftId が付き、その draftId があて先の予約の id と組で
 * 3回目のルートの下書きを指すことを確かめる（冒頭の (1)〜(4)）。
 * before は操作の前の下書きの一覧。返事のあて先の予約と、下書きが増えてはいけない関わる予約を、すべて入れておく
 */
async function expectDraftsWithIds(
  drafts: readonly OperationDraft[],
  expected: readonly DraftWithoutId[],
  before: DraftLists,
): Promise<void> {
  expectSameItems(drafts.map(withoutDraftId), expected);

  // (1) どの下書きにも draftId が付いている。1つの予約の中で重ならない
  for (const draft of drafts) {
    expect(typeof draft.draftId, JSON.stringify(draft)).toBe("string");
    expect((draft.draftId ?? "").length, JSON.stringify(draft)).toBeGreaterThan(0);
  }
  for (const reservationId of new Set(drafts.map((d) => d.reservationId))) {
    const ids = drafts.filter((d) => d.reservationId === reservationId).map((d) => d.draftId);
    expect(new Set(ids).size, `${reservationId} の返事の draftId`).toBe(ids.length);
  }

  // (2) 予約の id と下書きの id の組で開くと、同じ種類の未送信の下書きが開ける
  for (const draft of drafts) {
    const detail = await openDraft(draft.reservationId, draft.draftId ?? "");
    expect(detail.draftId).toBe(draft.draftId);
    expect(detail.reservationId).toBe(draft.reservationId);
    expect(detail.kind).toBe(draft.kind);
    expect(detail.status).toBe("unsent");
    expectInstant(detail.createdAt, operatedAt);
  }

  // (3) 予約の下書きの一覧で、操作の前になかった下書きが、その予約の返事の下書きと id と種類で一致する
  for (const reservationId of new Set([...before.keys(), ...drafts.map((d) => d.reservationId)])) {
    const beforeIds = new Set((before.get(reservationId) ?? []).map((d) => d.draftId));
    const after = await reservationDrafts(reservationId);
    const added = after.filter((d) => !beforeIds.has(d.draftId));
    expectSameItems(
      added.map(idAndKind),
      drafts.filter((d) => d.reservationId === reservationId).map(idAndKind),
    );
    for (const draft of added) {
      expect(draft.status).toBe("unsent");
      expectInstant(draft.createdAt, operatedAt);
    }
    // 操作の前からあった下書きは、残っている
    expect(after.map((d) => d.draftId)).toEqual(expect.arrayContaining([...beforeIds]));
  }

  // (4) 未送信の一覧に、予約の id と下書きの id の組で出る
  const unsent = (await unsentDrafts()).map((d) => ({
    reservationId: d.reservationId,
    draftId: d.draftId,
    kind: d.kind,
  }));
  expect(unsent).toEqual(
    expect.arrayContaining(
      drafts.map((d) => ({ reservationId: d.reservationId, draftId: d.draftId, kind: d.kind })),
    ),
  );
}

/** 何も作らない操作：返事は空の一覧で、関わる予約の下書きの一覧は操作の前と同じ */
async function expectNoDrafts(
  drafts: readonly OperationDraft[],
  before: DraftLists,
): Promise<void> {
  expect(drafts).toEqual([]);
  for (const [reservationId, list] of before) {
    expect(await reservationDrafts(reservationId)).toEqual(list);
  }
}

/** 変更の本文（AdminChangeRequest）。内容は申込と同じ（人数4人・養生なし・機材保険なし・オプションなし） */
function changeBody(start: string, end: string, confirmedPrice: number): Record<string, unknown> {
  return {
    start: jst(start).toISO(),
    end: jst(end).toISO(),
    partySize: 4,
    cycloramaFloorProtection: false,
    equipmentInsurance: false,
    optionIds: [],
    confirmedPrice,
  };
}

// ---- テスト ----

describe("操作の返事の下書きの id：承認・却下・昇格・取消（admin-api.md「操作（1回目）」）", () => {
  it("承認：承認待ち（本）A 10:00–12:00 を確定金額 11,000円で承認：A の承認の下書き（11,000円）に draftId が付き、A の id と組で開ける", async () => {
    const a = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const before = await draftListsOf([a]);

    const drafts = await acceptedDrafts(
      await post(`${reservationPath(a)}/approve`, { confirmedPrice: 11_000 }),
    );

    await expectDraftsWithIds(
      drafts,
      [{ kind: "approval", reservationId: a, confirmedPrice: Yen.parse(11_000) }],
      before,
    );
  });

  it("却下：承認待ち（本）A 10:00–12:00 を却下：A の却下の下書きに draftId が付き、A の id と組で開ける", async () => {
    const a = await apply("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const before = await draftListsOf([a]);

    const drafts = await acceptedDrafts(await post(`${reservationPath(a)}/reject`));

    await expectDraftsWithIds(drafts, [{ kind: "rejection", reservationId: a }], before);
  });

  it("昇格：第二キープの付いていない仮予約 P 13:00–15:00 を昇格：P の昇格の下書きに draftId が付き、P の id と組で開ける（P には準備の承認の下書きもある）", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const before = await draftListsOf([p]);

    const drafts = await acceptedDrafts(await post(`${reservationPath(p)}/promote`));

    await expectDraftsWithIds(drafts, [{ kind: "promotion", reservationId: p }], before);
  });

  it("昇格：仮予約 P 12:00–16:00 に第二キープ K1 15:00–17:00（占有区間 15:00–18:00）と承認待ちの第二キープ K2 10:00–12:00 が付き、本予約 F 18:00–20:00 がある：P の昇格、K1・K2 の第二キープの終了、F への前倒しの案内の下書きのどれにも draftId が付き、それぞれのあて先の予約の id と組で開ける", async () => {
    const p = await applyApproved("provisional", "2026-10-20T12:00", "2026-10-20T16:00");
    const k1 = await applyApproved("second-hold", "2026-10-20T15:00", "2026-10-20T17:00");
    const k2 = await apply("second-hold", "2026-10-20T10:00", "2026-10-20T12:00");
    const f = await applyApproved("firm", "2026-10-20T18:00", "2026-10-20T20:00");
    const before = await draftListsOf([p, k1, k2, f]);

    const drafts = await acceptedDrafts(await post(`${reservationPath(p)}/promote`));

    await expectDraftsWithIds(
      drafts,
      [
        { kind: "promotion", reservationId: p },
        { kind: "second-hold-ended", reservationId: k1 },
        { kind: "second-hold-ended", reservationId: k2 },
        { kind: "bring-forward-notice", reservationId: f },
      ],
      before,
    );
  });

  it("取消：本予約 F 10:00–12:00（確定金額 27,500円、利用日 10/20）を 10/05 に取消：F の取消の下書き（キャンセル料 13,750円・50%）に draftId が付き、F の id と組で開ける", async () => {
    const f = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00", 27_500);
    const before = await draftListsOf([f]);

    const drafts = await acceptedDrafts(await post(`${reservationPath(f)}/cancel`));

    await expectDraftsWithIds(
      drafts,
      [
        {
          kind: "cancellation",
          reservationId: f,
          cancellationFee: { ratePercent: 50, fee: Yen.parse(13_750) },
        },
      ],
      before,
    );
  });

  it("取消：第二キープ K 14:00–17:00 が付いている仮予約 P 13:00–15:00 を取消：P の取消（キャンセル料なし）と、K への繰り上げ案内（残っている仮予約なし）の下書きのどちらにも draftId が付き、それぞれの予約の id と組で開ける", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    const before = await draftListsOf([p, k]);

    const drafts = await acceptedDrafts(await post(`${reservationPath(p)}/cancel`));

    await expectDraftsWithIds(
      drafts,
      [
        {
          kind: "cancellation",
          reservationId: p,
          cancellationFee: { ratePercent: 0, fee: Yen.parse(0) },
        },
        { kind: "move-up-notice", reservationId: k, remainingProvisionalIds: [] },
      ],
      before,
    );
  });

  it("取消：2件の仮予約 P1 10:00–12:00・P2 15:00–17:00 に付く第二キープ K 12:00–16:00 があり、P1 を取消：P1 の取消と、K への繰り上げ案内（残っている仮予約 P2）の下書きのどちらにも draftId が付き、それぞれの予約の id と組で開ける", async () => {
    const p1 = await applyApproved("provisional", "2026-10-20T10:00", "2026-10-20T12:00");
    const p2 = await applyApproved("provisional", "2026-10-20T15:00", "2026-10-20T17:00");
    const k = await applyApproved("second-hold", "2026-10-20T12:00", "2026-10-20T16:00");
    const before = await draftListsOf([p1, p2, k]);

    const drafts = await acceptedDrafts(await post(`${reservationPath(p1)}/cancel`));

    await expectDraftsWithIds(
      drafts,
      [
        {
          kind: "cancellation",
          reservationId: p1,
          cancellationFee: { ratePercent: 0, fee: Yen.parse(0) },
        },
        { kind: "move-up-notice", reservationId: k, remainingProvisionalIds: [p2] },
      ],
      before,
    );
  });

  it("取消：仮予約 P 13:00–15:00 に付く第二キープ K 14:00–17:00（占有区間 14:00–18:00）を、本予約 F 18:00–20:00 があるときに取消：K の取消（キャンセル料なし）と、F への前倒しの案内の下書きのどちらにも draftId が付き、それぞれの予約の id と組で開ける", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    const f = await applyApproved("firm", "2026-10-20T18:00", "2026-10-20T20:00");
    const before = await draftListsOf([p, k, f]);

    const drafts = await acceptedDrafts(await post(`${reservationPath(k)}/cancel`));

    await expectDraftsWithIds(
      drafts,
      [
        {
          kind: "cancellation",
          reservationId: k,
          cancellationFee: { ratePercent: 0, fee: Yen.parse(0) },
        },
        { kind: "bring-forward-notice", reservationId: f },
      ],
      before,
    );
  });
});

describe("操作の返事の下書きの id：変更（admin-api.md「変更・直接入力・ブロック枠（2回目a）」）", () => {
  it("本予約 A 10:00–12:00（確定金額 22,000円）の確定金額だけを 10,000円に変える：A の変更の下書きに draftId が付き、A の id と組で開ける", async () => {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const before = await draftListsOf([a]);

    const drafts = await acceptedDrafts(
      await post(
        `${reservationPath(a)}/change`,
        changeBody("2026-10-20T10:00", "2026-10-20T12:00", 10_000),
      ),
    );

    await expectDraftsWithIds(drafts, [{ kind: "change", reservationId: a }], before);
  });

  it("第二キープ K 14:00–17:00 が付いている仮予約 P 13:00–15:00 を翌日 13:00–15:00 に移動：P の変更と、K への繰り上げ案内（残っている仮予約なし）の下書きのどちらにも draftId が付き、それぞれの予約の id と組で開ける", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    const before = await draftListsOf([p, k]);

    const drafts = await acceptedDrafts(
      await post(
        `${reservationPath(p)}/change`,
        changeBody("2026-10-21T13:00", "2026-10-21T15:00", 22_000),
      ),
    );

    await expectDraftsWithIds(
      drafts,
      [
        { kind: "change", reservationId: p },
        { kind: "move-up-notice", reservationId: k, remainingProvisionalIds: [] },
      ],
      before,
    );
  });
});

describe("操作の返事の下書きの id：バッファの切り替え（admin-api.md「バッファの切り替え・お客様の情報の変更（2回目b）」）", () => {
  it("仮予約 P 13:00–15:00（占有区間 13:00–16:00）に付く第二キープ K 15:30–17:30 があり、P のバッファを30分にする：K への繰り上げ案内（残っている仮予約なし）の下書きに draftId が付き、K の id と組で開ける。P の下書きは増えない", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T15:30", "2026-10-20T17:30");
    const before = await draftListsOf([p, k]);

    const drafts = await acceptedDrafts(
      await post(`${reservationPath(p)}/buffer`, { bufferMinutes: 30 }),
    );

    await expectDraftsWithIds(
      drafts,
      [{ kind: "move-up-notice", reservationId: k, remainingProvisionalIds: [] }],
      before,
    );
  });
});

describe("操作の返事の下書きの id：何も作らない操作", () => {
  it("本予約 A 10:00–12:00 の日時・内容・確定金額をすべて今のまま送る変更：200 と空の一覧。A の下書きの一覧は変わらない", async () => {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const before = await draftListsOf([a]);

    const drafts = await acceptedDrafts(
      await post(
        `${reservationPath(a)}/change`,
        changeBody("2026-10-20T10:00", "2026-10-20T12:00", 22_000),
      ),
    );

    await expectNoDrafts(drafts, before);
  });

  it("本予約 A 10:00–12:00、バッファ1時間を1時間にする（今と同じ）：200 と空の一覧。A の下書きの一覧は変わらない", async () => {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const before = await draftListsOf([a]);

    const drafts = await acceptedDrafts(
      await post(`${reservationPath(a)}/buffer`, { bufferMinutes: 60 }),
    );

    await expectNoDrafts(drafts, before);
  });

  it("第二キープの付いていない本予約 A 10:00–12:00 のバッファを30分にする：200 と空の一覧（お客様への下書きは作らない）。A の下書きの一覧は変わらない", async () => {
    const a = await applyApproved("firm", "2026-10-20T10:00", "2026-10-20T12:00");
    const before = await draftListsOf([a]);

    const drafts = await acceptedDrafts(
      await post(`${reservationPath(a)}/buffer`, { bufferMinutes: 30 }),
    );

    await expectNoDrafts(drafts, before);
  });

  it("繰り上げ：付いている仮予約 P が取消になった第二キープ K を繰り上げ：200 と空の一覧。P・K の下書きの一覧は変わらない", async () => {
    const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
    const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");
    await prepareOperation({ kind: "cancel", reservationId: p });
    const before = await draftListsOf([p, k]);

    const drafts = await acceptedDrafts(await post(`${reservationPath(k)}/move-up`));

    await expectNoDrafts(drafts, before);
  });
});
