import {
  type AttributeValue,
  CreateTableCommand,
  DeleteTableCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import {
  AdminDraftDetail,
  AdminRejected,
  AdminReservationDraftList,
  AdminUnsentDraftList,
  PriceTable,
  Yen,
} from "@zebra/contracts";
import { DateTime } from "luxon";
import https from "node:https";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.ts";
import { createLocalDynamoClient } from "../db/client.ts";
import { saveCustomerInfo } from "../db/customer-info.ts";
import { type ReservationOperationInput, saveReservationOperation } from "../db/operations.ts";
import {
  type ApplicationKind,
  type ReservationApplication,
  type ReservationStore,
  saveApplication,
} from "../db/reservations.ts";
import { mailSettingsFromEnv } from "../mail/settings-env.ts";
import type { AdminUserIdSource } from "./admin-user.ts";

// 管理 API の3回目（下書き）のルートの統合テスト（DynamoDB Local）。
// 根拠：docs/product-specs/mail.md「下書きの送り方」（例の表のすべての行）、「下書きのテンプレート」（例の表の
// 「メールアドレスのない予約の下書き」の行。ほかの行は文面を作る関数の単体テスト apps/api/src/mail/draft-mail.test.ts）、
// docs/design-docs/admin-api.md「下書き（3回目）」「担当者名と署名の設定」「返すときの決まり」「認証」、
// dynamodb-keys.md（下書きのアイテムと、未送信の下書きの GSI）、core-beliefs.md（INV-4、INV-6、INV-7、INV-10）、
// packages/contracts の admin.ts（AdminUnsentDraftList、AdminReservationDraftList、AdminDraftDetail、AdminEmptyRequest、
// AdminRejected。返す本文は契約でパースできること）。
// - アプリは createApp(store, 管理者の id の取り出し方, 担当者名と署名の設定) で作る。担当者名と署名の設定は、
//   環境変数の形（MAIL_STAFF_NAME・MAIL_SIGNATURE。署名の改行は \n の2文字）から mailSettingsFromEnv で作る
// - API の現在時刻は、Date だけを偽の時計にして固定する（vi.useFakeTimers({ toFake: ["Date"] })。INV-7）
// - 下書きは、申込の保存（saveApplication）と承認などの保存（saveReservationOperation）で作る。下書きの id は API が
//   決める文字列なので、一覧で受け取ったものをそのまま使う（パスに入れるときは encodeURIComponent する）
// - 送信済み・送らないの成功は 200 で本文なし（admin-api.md の表「200（本文なし）」）。本文が空であることを確かめる
// - 「予約の詳細には残る」は、予約の下書きの一覧（GET /admin/reservations/{id}/drafts）に残ることで確かめる
//   （mail.md「送信済み・送らないにしたものは一覧から消え、予約の詳細でだけ見られる」）
// - 「不可」は 409 draft-not-unsent（admin-api.md「返すときの決まり」）
// - メールを送らないこと（INV-6）：今のコードにメールを送る部品はないので、確かめられる範囲で確かめる。
//   (1) 下書きの操作のあいだに、fetch と https.request（AWS の SES などの外の HTTPS）を呼ばない
//   （DynamoDB Local は http なので https.request は呼ばれない）。(2) 開くは何も書かず、送信済み・送らないは
//   その下書きのアイテムだけを変える。送る経路を lint で1つに限るのは、テストの外（core-beliefs.md の INV-6）
// - 承認の下書きの文面は、承認したときの状態（承認の履歴に残っている承認したあとの状態）で選ぶ（mail.md「承認（本予約）」）。
//   承認のあとに昇格・取消をしても、承認の下書きは承認したときの文面のまま
// - 架空の担当者名・署名・お客様の情報を使う

const client = createLocalDynamoClient();
let store: ReservationStore;

// テーブルはキー設計どおり（pk・sk、GSI の gsi1pk・gsi1sk）にテストごとに作り、終わったら消す
async function createTable(): Promise<ReservationStore> {
  const tableName = `int-test-admin-3-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
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
/** テストの準備でする承認・取消・変更の時刻（固定。下書きを作った日時を違えるため、いくつか使う） */
const preparedAt = jst("2026-10-02T12:00");
const preparedAt2 = jst("2026-10-03T12:00");
const preparedAt3 = jst("2026-10-04T12:00");
/** API の現在時刻（固定） */
const now = jst("2026-10-05T09:00");

/** API の現在時刻を変える（偽の時計） */
function setApiNow(at: DateTime): void {
  vi.setSystemTime(at.toMillis());
}

beforeEach(async () => {
  store = await createTable();
  vi.useFakeTimers({ toFake: ["Date"] });
  setApiNow(now);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await client.send(new DeleteTableCommand({ TableName: store.tableName }));
});

/** API を呼ぶ管理者（架空のユーザー id） */
const adminUserId = "admin-user-kaku-3";
/** 準備の操作をした管理者（架空のユーザー id。API を呼ぶ管理者と見分けるため別にする） */
const preparingAdminUserId = "admin-user-kaku-3-prep";

/** 返した日時の文字列が ISO 8601 で JST のオフセット（+09:00）付きであること（admin-api.md「返すときの決まり」） */
function expectJstOffset(value: string | undefined): void {
  expect(value, value).toMatch(/\+09:00$/);
  expect(DateTime.fromISO(value ?? "", { setZone: true }).isValid, value).toBe(true);
}

function expectInstant(value: string | undefined, at: DateTime): void {
  expectJstOffset(value);
  expect(DateTime.fromISO(value ?? "", { setZone: true }).toMillis()).toBe(at.toMillis());
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

// ---- 架空の設定とお客様の情報（INV-10 の確認に使うので、ほかの値と紛れない文字列にする） ----

const staffName = "仮名 三回目担当";
const signatureLines = [
  "スタジオゼブラ（架空の三回目署名）",
  "〒000-0000 架空県架空市三回目町0-0-3",
  "TEL 090-0000-0303",
  "Mail kaku.sankaime.studio@example.com",
] as const;
/** 設定の署名（環境変数の形。改行は \n の2文字） */
const signatureEnv = signatureLines.join("\\n");
/** 担当者名と署名の設定（環境変数の形から作る。テストごとに作り、失敗はそのテストの失敗にする） */
function mailSettings(): ReturnType<typeof mailSettingsFromEnv> {
  return mailSettingsFromEnv({
    MAIL_STAFF_NAME: staffName,
    MAIL_SIGNATURE: signatureEnv,
  });
}

const formCustomer = {
  name: "架空 三回目花子",
  email: "sankaime.hanako.kaku@example.com",
  phone: "090-0000-0333",
  address: "架空県架空市三回目町3-3-3",
  photographerName: "仮名 三回目写真",
} as const;

const formShooting = {
  types: ["still", "movie"],
  details: "架空の撮影詳細：3回目の確認用",
  notes: "架空の補足事項：3回目の確認用",
} as const;

const personalValues: readonly string[] = [
  ...Object.values(formCustomer),
  formShooting.details,
  formShooting.notes,
];

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
    customer: formCustomer,
    shooting: formShooting,
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

async function prepareOperation(
  operation: ReservationOperationInput,
  at: DateTime = preparedAt,
): Promise<void> {
  const result = await saveReservationOperation(store, operation, {
    now: at,
    adminUserId: preparingAdminUserId,
  });
  if (!result.ok) {
    throw new Error(`準備の操作が不可になった（${operation.kind}、${result.reason}）`);
  }
}

/** 申込して承認する（準備）。確定金額は 22,000円 */
async function applyApproved(
  kind: ApplicationKind,
  start: string,
  end: string,
  at: DateTime = preparedAt,
): Promise<string> {
  const id = await apply(kind, start, end);
  await prepareOperation(
    { kind: "approve", reservationId: id, confirmedPrice: Yen.parse(22_000) },
    at,
  );
  return id;
}

/** 本予約 A 10/20 15:00–17:00（承認済み。承認の下書きが未送信である） */
async function prepareA(at: DateTime = preparedAt): Promise<string> {
  return applyApproved("firm", "2026-10-20T15:00", "2026-10-20T17:00", at);
}

function changeOf(reservationId: string, start: string, end: string): ReservationOperationInput {
  return {
    kind: "change",
    reservationId,
    start: jst(start),
    end: jst(end),
    content: {
      partySize: 4,
      cycloramaFloorProtection: false,
      equipmentInsurance: false,
      optionIds: [],
    },
    confirmedPrice: Yen.parse(22_000),
    priceTable,
  };
}

// ---- API を呼ぶ道具 ----

const adminSource: AdminUserIdSource = () => adminUserId;
const noAdmin: AdminUserIdSource = () => undefined;

type App = ReturnType<typeof createApp>;

/** 担当者名と署名の設定を渡したアプリ */
function app(): App {
  return createApp(store, adminSource, mailSettings());
}

function draftPath(reservationId: string, draftId: string): string {
  return `/admin/reservations/${encodeURIComponent(reservationId)}/drafts/${encodeURIComponent(draftId)}`;
}

async function get(path: string, target: App = app()): Promise<Response> {
  return target.request(path, { method: "GET" });
}

/** 送信済み・送らないにする。body が文字列ならそのまま本文にし、それ以外は JSON にする */
async function mark(
  reservationId: string,
  draftId: string,
  action: "sent" | "skip",
  body: unknown = {},
  target: App = app(),
): Promise<Response> {
  return target.request(`${draftPath(reservationId, draftId)}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function okJson(res: Response): Promise<unknown> {
  const text = await res.text();
  expect(res.status, text).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("application/json");
  return JSON.parse(text) as unknown;
}

/** 送信済み・送らないの成功：200 で本文なし */
async function expectMarkedWithoutBody(res: Response): Promise<void> {
  const text = await res.text();
  expect(res.status, text).toBe(200);
  expect(text).toBe("");
}

/** エラーの応答が、ステータスと { error: <理由> }（AdminRejected）であることを確かめる */
async function expectError(res: Response, status: number, error: string): Promise<void> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  expect(res.headers.get("content-type") ?? "").toContain("application/json");
  const json = JSON.parse(text) as unknown;
  expect(AdminRejected.safeParse(json).success, text).toBe(true);
  expect(json).toEqual({ error });
}

async function unsentList(target: App = app()): Promise<AdminUnsentDraftList["drafts"]> {
  const json = await okJson(await get("/admin/drafts", target));
  const parsed = AdminUnsentDraftList.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  if (!parsed.success) throw new Error("AdminUnsentDraftList を通らない");
  return parsed.data.drafts;
}

async function reservationDrafts(
  reservationId: string,
  target: App = app(),
): Promise<AdminReservationDraftList["drafts"]> {
  const json = await okJson(
    await get(`/admin/reservations/${encodeURIComponent(reservationId)}/drafts`, target),
  );
  const parsed = AdminReservationDraftList.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  if (!parsed.success) throw new Error("AdminReservationDraftList を通らない");
  return parsed.data.drafts;
}

/** その予約の、その種類の下書き（1件だけあること）の id */
async function draftIdOf(
  reservationId: string,
  kind: AdminReservationDraftList["drafts"][number]["kind"],
): Promise<string> {
  const found = (await reservationDrafts(reservationId)).filter((d) => d.kind === kind);
  expect(found, `${reservationId} の ${kind} の下書き`).toHaveLength(1);
  return found[0]?.draftId ?? "";
}

async function openDraft(
  reservationId: string,
  draftId: string,
  target: App = app(),
): Promise<AdminDraftDetail> {
  const json = await okJson(await get(draftPath(reservationId, draftId), target));
  const parsed = AdminDraftDetail.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  if (!parsed.success) throw new Error("AdminDraftDetail を通らない");
  return parsed.data;
}

function lines(detail: AdminDraftDetail): string[] {
  return detail.text.split("\n");
}

// ---- テーブルを直接読む道具 ----

function plain(value: AttributeValue): unknown {
  if (value.S !== undefined) return value.S;
  if (value.N !== undefined) return Number(value.N);
  if (value.BOOL !== undefined) return value.BOOL;
  if (value.NULL !== undefined) return null;
  if (value.L !== undefined) return value.L.map(plain);
  if (value.M !== undefined) return plainItem(value.M);
  if (value.SS !== undefined) return [...value.SS];
  if (value.NS !== undefined) return value.NS.map(Number);
  throw new Error(`テストで扱わない属性の形：${JSON.stringify(value)}`);
}

type PlainItem = Record<string, unknown>;

function plainItem(item: Record<string, AttributeValue>): PlainItem {
  return Object.fromEntries(Object.entries(item).map(([key, value]) => [key, plain(value)]));
}

async function scanAll(): Promise<PlainItem[]> {
  const items: PlainItem[] = [];
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const res = await client.send(
      new ScanCommand({
        TableName: store.tableName,
        ConsistentRead: true,
        ExclusiveStartKey: startKey,
      }),
    );
    items.push(...(res.Items ?? []).map(plainItem));
    startKey = res.LastEvaluatedKey;
  } while (startKey !== undefined);
  return items;
}

function itemKey(item: PlainItem): string {
  return `${String(item["pk"])} ${String(item["sk"])}`;
}

function sortedItems(items: readonly PlainItem[]): PlainItem[] {
  return [...items].sort((x, y) => itemKey(x).localeCompare(itemKey(y)));
}

/** できない操作・開く操作で、テーブルの中身が何も変わっていないことを確かめる */
async function expectNothingWritten(before: readonly PlainItem[]): Promise<void> {
  expect(sortedItems(await scanAll())).toEqual(sortedItems(before));
}

/**
 * 送信済み・送らないにしたあと、変わったアイテムがその予約の下書きのアイテム1件だけで、そのアイテムは
 * 未送信の一覧の GSI の属性（gsi1pk・gsi1sk）を持たないことを確かめる（dynamodb-keys.md）
 */
async function expectOnlyOneDraftItemChanged(
  before: readonly PlainItem[],
  reservationId: string,
): Promise<void> {
  const after = await scanAll();
  expect(after.map(itemKey).sort()).toEqual(before.map(itemKey).sort());
  const beforeByKey = new Map(before.map((item) => [itemKey(item), item]));
  const changed = after.filter((item) => {
    const old = beforeByKey.get(itemKey(item));
    return JSON.stringify(sortedEntries(old)) !== JSON.stringify(sortedEntries(item));
  });
  expect(changed.map(itemKey)).toHaveLength(1);
  const item = changed[0];
  expect(item?.["pk"]).toBe(`RES#${reservationId}`);
  expect(String(item?.["sk"])).toMatch(/^DRAFT#/);
  expect(item).not.toHaveProperty("gsi1pk");
  expect(item).not.toHaveProperty("gsi1sk");
  expect(JSON.stringify(item)).toContain(adminUserId);
}

function sortedEntries(item: PlainItem | undefined): [string, unknown][] {
  return Object.entries(item ?? {}).sort(([x], [y]) => x.localeCompare(y));
}

// ---- テスト ----

describe("下書きの送り方", () => {
  it("未送信の下書き、管理者が「送信済み」にする：送信済みになり、未送信の一覧から消える。予約の詳細には残る", async () => {
    const a = await prepareA();
    const draftId = await draftIdOf(a, "approval");
    expect((await unsentList()).map((d) => d.draftId)).toEqual([draftId]);
    const before = await scanAll();

    await expectMarkedWithoutBody(await mark(a, draftId, "sent"));

    expect(await unsentList()).toEqual([]);
    const drafts = await reservationDrafts(a);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.draftId).toBe(draftId);
    expect(drafts[0]?.kind).toBe("approval");
    expect(drafts[0]?.status).toBe("sent");
    expectInstant(drafts[0]?.statusChangedAt, now);
    expectInstant(drafts[0]?.createdAt, preparedAt);
    expect((await openDraft(a, draftId)).status).toBe("sent");
    await expectOnlyOneDraftItemChanged(before, a);
  });

  it("未送信の下書き、管理者が「送らない」にする：送らないになり、未送信の一覧から消える", async () => {
    const a = await prepareA();
    const draftId = await draftIdOf(a, "approval");
    const before = await scanAll();

    await expectMarkedWithoutBody(await mark(a, draftId, "skip"));

    expect(await unsentList()).toEqual([]);
    const drafts = await reservationDrafts(a);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.status).toBe("skipped");
    expectInstant(drafts[0]?.statusChangedAt, now);
    expect((await openDraft(a, draftId)).status).toBe("skipped");
    await expectOnlyOneDraftItemChanged(before, a);
  });

  it("送信済みの下書き、管理者が「送らない」にする：不可（未送信の下書きだけ変えられる）", async () => {
    const a = await prepareA();
    const draftId = await draftIdOf(a, "approval");
    await expectMarkedWithoutBody(await mark(a, draftId, "sent"));
    setApiNow(now.plus({ hours: 1 }));
    const before = await scanAll();

    await expectError(await mark(a, draftId, "skip"), 409, "draft-not-unsent");

    await expectNothingWritten(before);
    const drafts = await reservationDrafts(a);
    expect(drafts[0]?.status).toBe("sent");
    expectInstant(drafts[0]?.statusChangedAt, now);
  });

  it("送らないにした下書き、管理者が「送信済み」にする：不可", async () => {
    const a = await prepareA();
    const draftId = await draftIdOf(a, "approval");
    await expectMarkedWithoutBody(await mark(a, draftId, "skip"));
    setApiNow(now.plus({ hours: 1 }));
    const before = await scanAll();

    await expectError(await mark(a, draftId, "sent"), 409, "draft-not-unsent");

    await expectNothingWritten(before);
    const drafts = await reservationDrafts(a);
    expect(drafts[0]?.status).toBe("skipped");
    expectInstant(drafts[0]?.statusChangedAt, now);
  });

  it("承認の下書きを作ったあとに、予約の日時を変えた、承認の下書きを開く：文面は変えたあとの日時になる", async () => {
    const a = await prepareA();
    await prepareOperation(changeOf(a, "2026-10-27T15:00", "2026-10-27T17:00"), preparedAt2);
    const draftId = await draftIdOf(a, "approval");

    const detail = await openDraft(a, draftId);

    expect(detail.kind).toBe("approval");
    expect(lines(detail)).toContain(
      "【2026年10月27日(火) 15時00分〜17時00分】にて、本予約を承りました。",
    );
    expect(lines(detail)).toContain("ご予約日時：2026年10月27日(火) 15時00分〜17時00分（2時間）");
    expect(detail.text).not.toContain("2026年10月20日");
  });
});

describe("下書きのテンプレート", () => {
  it("メールアドレスのない予約の下書き：あて先は空で、「メールアドレスがありません」と表示する", async () => {
    const a = await prepareA();
    const withoutEmail = {
      name: formCustomer.name,
      phone: formCustomer.phone,
      address: formCustomer.address,
      photographerName: formCustomer.photographerName,
    };
    const saved = await saveCustomerInfo(
      store,
      { reservationId: a, customer: withoutEmail, shooting: formShooting },
      { now: preparedAt2, adminUserId: preparingAdminUserId },
    );
    expect(saved.ok).toBe(true);
    const draftId = await draftIdOf(a, "approval");

    const json = await okJson(await get(draftPath(a, draftId)));

    // あて先（to）を持たない。「メールアドレスがありません」の表示は管理画面がする
    expect(AdminDraftDetail.safeParse(json).success, JSON.stringify(json)).toBe(true);
    expect(json).not.toHaveProperty("to");
    const detail = AdminDraftDetail.parse(json);
    expect(detail.subject).toBe("【スタジオゼブラ】本予約を承りました");
    expect(lines(detail)[0]).toBe(`${formCustomer.name}様`);
  });
});

describe("管理 API：未送信の下書きの一覧（GET /admin/drafts）", () => {
  it("未送信の下書きを作った順（古い順）に返す。下書きごとに、下書きの id、あて先の予約の id、種類、作った日時、予約の開始、お客様の氏名", async () => {
    // B を先に承認し、A をあとで承認し、最後に B を取消す（予約の id の順ではなく、作った順に並ぶ）
    const b = await applyApproved("firm", "2026-10-21T10:00", "2026-10-21T12:00", preparedAt);
    const a = await prepareA(preparedAt2);
    await prepareOperation({ kind: "cancel", reservationId: b }, preparedAt3);

    const drafts = await unsentList();

    expect(drafts.map((d) => [d.reservationId, d.kind])).toEqual([
      [b, "approval"],
      [a, "approval"],
      [b, "cancellation"],
    ]);
    expectInstant(drafts[0]?.createdAt, preparedAt);
    expectInstant(drafts[1]?.createdAt, preparedAt2);
    expectInstant(drafts[2]?.createdAt, preparedAt3);
    expectInstant(drafts[0]?.reservationStart, jst("2026-10-21T10:00"));
    expectInstant(drafts[1]?.reservationStart, jst("2026-10-20T15:00"));
    expect(drafts.every((d) => d.customerName === formCustomer.name)).toBe(true);
    expect(new Set(drafts.map((d) => d.draftId)).size).toBe(3);
    // 予約の下書きの一覧と同じ下書きの id
    expect((await reservationDrafts(b)).map((d) => d.draftId)).toEqual([
      drafts[0]?.draftId,
      drafts[2]?.draftId,
    ]);
  });

  it("予約の開始は、一覧を読んだときの予約の開始（下書きを作ったあとに日時を変えたら、変えたあと）", async () => {
    const a = await prepareA();
    await prepareOperation(changeOf(a, "2026-10-27T15:00", "2026-10-27T17:00"), preparedAt2);

    const drafts = await unsentList();

    expect(drafts.map((d) => d.kind)).toEqual(["approval", "change"]);
    for (const draft of drafts) {
      expectInstant(draft.reservationStart, jst("2026-10-27T15:00"));
    }
  });

  it("送信済み・送らないにした下書きは出ない。未送信の下書きがなければ空", async () => {
    expect(await unsentList()).toEqual([]);
    const a = await prepareA();
    const b = await applyApproved("firm", "2026-10-21T10:00", "2026-10-21T12:00", preparedAt2);
    await expectMarkedWithoutBody(await mark(a, await draftIdOf(a, "approval"), "sent"));

    expect((await unsentList()).map((d) => d.reservationId)).toEqual([b]);

    await expectMarkedWithoutBody(await mark(b, await draftIdOf(b, "approval"), "skip"));

    expect(await unsentList()).toEqual([]);
  });
});

describe("管理 API：予約の下書きの一覧（GET /admin/reservations/{id}/drafts）", () => {
  it("その予約の下書きすべて（送信済み・送らないも）を作った順に返す。送信済み・送らないにした日時は、未送信なら持たない", async () => {
    const a = await prepareA(preparedAt);
    await prepareOperation(changeOf(a, "2026-10-27T15:00", "2026-10-27T17:00"), preparedAt2);
    await prepareOperation({ kind: "cancel", reservationId: a }, preparedAt3);
    await applyApproved("firm", "2026-10-21T10:00", "2026-10-21T12:00", preparedAt2);
    await expectMarkedWithoutBody(await mark(a, await draftIdOf(a, "approval"), "sent"));
    setApiNow(now.plus({ minutes: 30 }));
    await expectMarkedWithoutBody(await mark(a, await draftIdOf(a, "change"), "skip"));

    const drafts = await reservationDrafts(a);

    expect(drafts.map((d) => [d.kind, d.status])).toEqual([
      ["approval", "sent"],
      ["change", "skipped"],
      ["cancellation", "unsent"],
    ]);
    expectInstant(drafts[0]?.createdAt, preparedAt);
    expectInstant(drafts[1]?.createdAt, preparedAt2);
    expectInstant(drafts[2]?.createdAt, preparedAt3);
    expectInstant(drafts[0]?.statusChangedAt, now);
    expectInstant(drafts[1]?.statusChangedAt, now.plus({ minutes: 30 }));
    expect(drafts[2]).not.toHaveProperty("statusChangedAt");
  });

  it("下書きのない予約（承認待ち）：空の一覧", async () => {
    const pending = await apply("firm", "2026-10-20T15:00", "2026-10-20T17:00");

    expect(await reservationDrafts(pending)).toEqual([]);
  });

  it("ない予約：404（not-found）", async () => {
    await expectError(
      await get("/admin/reservations/no-such-reservation/drafts"),
      404,
      "not-found",
    );
  });
});

describe("管理 API：下書きを開く（GET /admin/reservations/{id}/drafts/{draftId}）", () => {
  it("本予約の承認の下書き：種類、状態、あて先（メールアドレス）、件名、本文（テキストと HTML）、同意書を添付するか。担当者名と署名は設定の値（署名の \\n は改行）", async () => {
    const a = await prepareA();
    const draftId = await draftIdOf(a, "approval");

    const detail = await openDraft(a, draftId);

    expect(detail.draftId).toBe(draftId);
    expect(detail.reservationId).toBe(a);
    expect(detail.kind).toBe("approval");
    expect(detail.status).toBe("unsent");
    expectInstant(detail.createdAt, preparedAt);
    expect(detail.to).toBe(formCustomer.email);
    expect(detail.subject).toBe("【スタジオゼブラ】本予約を承りました");
    expect(detail.attachConsentForm).toBe(true);
    const all = lines(detail);
    expect(all[0]).toBe(`${formCustomer.name}様`);
    expect(all).toContain(`スタジオゼブラの${staffName}です。`);
    expect(all).toContain("【2026年10月20日(火) 15時00分〜17時00分】にて、本予約を承りました。");
    expect(all).toContain("ご予約日時：2026年10月20日(火) 15時00分〜17時00分（2時間）");
    expect(all).toContain("撮影内容：スチール撮影・ムービー撮影（架空の撮影詳細：3回目の確認用）");
    expect(all).toContain("ご利用人数：4名様");
    expect(all).toContain(`カメラマン様：${formCustomer.photographerName}様`);
    expect(all).toContain("機材保険：-");
    expect(
      detail.text.trimEnd().endsWith(`\n${staffName}\n\n--\n${signatureLines.join("\n")}`),
    ).toBe(true);
    expect(detail.text).not.toContain("\\n");
    // 承認の下書きは確定金額を持つが、文面には書かない
    expect(detail.text).not.toContain("22,000");
    // HTML の本文：改行は <br>、強調は span（mail.md「強調の書き方」）
    expect(detail.html).toMatch(/<br\s*\/?>/i);
    expect(detail.html).toContain(
      '<span style="color:#ff0000">撮影当日に履いていらっしゃった靴のご使用は禁止です。</span>',
    );
    expect(detail.html).not.toContain("<赤>");
  });

  it("担当者名と署名の設定がない（createApp の3つ目の引数なし）：担当者名は「（担当者名）」、本文は担当者名の行で終わる（「--」の行がない）", async () => {
    const a = await prepareA();
    const draftId = await draftIdOf(a, "approval");

    const detail = await openDraft(a, draftId, createApp(store, adminSource));

    expect(lines(detail)).toContain("スタジオゼブラの（担当者名）です。");
    expect(detail.text.trimEnd().endsWith("\n（担当者名）")).toBe(true);
    expect(lines(detail)).not.toContain("--");
  });

  it("環境変数がない設定（mailSettingsFromEnv({})）：担当者名は「（担当者名）」、署名を出さない", async () => {
    const a = await prepareA();
    const draftId = await draftIdOf(a, "approval");

    const detail = await openDraft(
      a,
      draftId,
      createApp(store, adminSource, mailSettingsFromEnv({})),
    );

    expect(lines(detail)).toContain("スタジオゼブラの（担当者名）です。");
    expect(detail.text.trimEnd().endsWith("\n（担当者名）")).toBe(true);
    expect(lines(detail)).not.toContain("--");
  });

  it("取消の下書き：キャンセル料は下書きを作ったときの値（10/02 に取消：50% の 11,000円）。開くのが利用日の前日でも変わらない", async () => {
    const a = await prepareA();
    await prepareOperation({ kind: "cancel", reservationId: a }, preparedAt);
    setApiNow(jst("2026-10-19T12:00"));
    const draftId = await draftIdOf(a, "cancellation");

    const detail = await openDraft(a, draftId);

    expect(detail.kind).toBe("cancellation");
    expect(detail.subject).toBe("【スタジオゼブラ】ご予約のキャンセルを承りました");
    expect(detail.attachConsentForm).toBe(false);
    expect(lines(detail)).toContain(
      "【2026年10月20日(火) 15時00分〜17時00分】のご予約のキャンセルを承りました。",
    );
    expect(lines(detail)).toContain(
      "キャンセル料として、11,000円（ご利用料金の50%）を申し受けます。",
    );
  });

  it("仮予約 P1 の取消で、P1 と P2 に付く第二キープ K に繰り上げの案内：K の下書きに「すぐには繰り上げができません」の2行がある。P1 の取消の下書きにキャンセル料の2行がない", async () => {
    const p1 = await applyApproved("provisional", "2026-10-20T10:00", "2026-10-20T12:00");
    await applyApproved("provisional", "2026-10-20T15:00", "2026-10-20T17:00");
    const k = await applyApproved("second-hold", "2026-10-20T12:00", "2026-10-20T16:00");
    await prepareOperation({ kind: "cancel", reservationId: p1 }, preparedAt2);

    const notice = await openDraft(k, await draftIdOf(k, "move-up-notice"));
    const cancellation = await openDraft(p1, await draftIdOf(p1, "cancellation"));

    expect(notice.subject).toBe("【スタジオゼブラ】第二キープの繰り上げのご案内");
    expect(lines(notice)).toContain(
      "ただし、ご希望の日時にはほかにも仮予約をいただいているお客様がいらっしゃるため、",
    );
    expect(lines(notice)).toContain(
      "すぐには繰り上げができません。状況が変わりましたら、あらためてご連絡いたします。",
    );
    expect(cancellation.text).not.toContain("キャンセル料として");
    expect(cancellation.text).not.toContain("お支払い方法につきましては");
  });

  it("仮予約の承認の下書き：件名は「【スタジオゼブラ】仮予約を承りました」、同意書は添付しない、仮予約の期限は利用日の7日前の18時", async () => {
    const p = await applyApproved("provisional", "2026-10-20T15:00", "2026-10-20T17:00");

    const detail = await openDraft(p, await draftIdOf(p, "approval"));

    expect(detail.subject).toBe("【スタジオゼブラ】仮予約を承りました");
    expect(detail.attachConsentForm).toBe(false);
    expect(lines(detail)).toContain("【10月13日(火)の18時まで】にご連絡いただけますと幸いです。");
  });

  // 承認のテンプレートは、承認したときの状態で選ぶ（mail.md「承認（本予約）」：承認の履歴に残っている「承認したあとの状態」）
  it("仮予約の申込を承認したあとに昇格し、承認の下書き（未送信）を開く：仮予約の承認の文面（件名「【スタジオゼブラ】仮予約を承りました」）のまま。昇格の下書きは本予約の文面", async () => {
    const p = await applyApproved("provisional", "2026-10-20T15:00", "2026-10-20T17:00");
    await prepareOperation({ kind: "promote", reservationId: p }, preparedAt2);

    const approval = await openDraft(p, await draftIdOf(p, "approval"));
    const promotion = await openDraft(p, await draftIdOf(p, "promotion"));

    expect(approval.kind).toBe("approval");
    expect(approval.status).toBe("unsent");
    expect(approval.subject).toBe("【スタジオゼブラ】仮予約を承りました");
    expect(approval.attachConsentForm).toBe(false);
    expect(lines(approval)).toContain(
      "【2026年10月20日(火) 15時00分〜17時00分】にて、仮予約を承りました。",
    );
    expect(lines(approval)).toContain("【10月13日(火)の18時まで】にご連絡いただけますと幸いです。");
    expect(approval.text).not.toContain("本予約を承りました。");
    expect(approval.text).not.toContain("◇ ご予約内容 ◇");

    expect(promotion.kind).toBe("promotion");
    expect(promotion.subject).toBe("【スタジオゼブラ】本予約を承りました");
    expect(promotion.attachConsentForm).toBe(true);
    expect(lines(promotion)).toContain("ご利用のご決定のご連絡をありがとうございます。");
    expect(lines(promotion)).toContain(
      "【2026年10月20日(火) 15時00分〜17時00分】にて、仮予約から本予約に切り替えました。",
    );
    expect(lines(promotion)).toContain("◇ ご予約内容 ◇");
    expect(lines(promotion)).toContain("◆ 注意事項 ◆");
  });

  it.each([
    [
      "本予約",
      "firm",
      "【スタジオゼブラ】本予約を承りました",
      true,
      "【2026年10月20日(火) 15時00分〜17時00分】にて、本予約を承りました。",
    ],
    [
      "仮予約",
      "provisional",
      "【スタジオゼブラ】仮予約を承りました",
      false,
      "【2026年10月20日(火) 15時00分〜17時00分】にて、仮予約を承りました。",
    ],
  ] as const)(
    "%sの申込を承認したあとに取消し、承認の下書き（未送信）を開く：承認したときの文面のまま",
    async (_, kind, subject, attachConsentForm, line) => {
      const id = await applyApproved(kind, "2026-10-20T15:00", "2026-10-20T17:00");
      await prepareOperation({ kind: "cancel", reservationId: id }, preparedAt2);

      const approval = await openDraft(id, await draftIdOf(id, "approval"));

      expect(approval.kind).toBe("approval");
      expect(approval.subject).toBe(subject);
      expect(approval.attachConsentForm).toBe(attachConsentForm);
      expect(lines(approval)).toContain(line);
    },
  );

  it("開いても何も書かない。下書きは未送信のまま、未送信の一覧に残る", async () => {
    const a = await prepareA();
    const draftId = await draftIdOf(a, "approval");
    const before = await scanAll();

    await openDraft(a, draftId);
    await openDraft(a, draftId);

    await expectNothingWritten(before);
    expect((await unsentList()).map((d) => d.draftId)).toEqual([draftId]);
  });

  it("ない予約、ない下書きの id、ほかの予約の下書きの id：404（not-found）", async () => {
    const a = await prepareA();
    const b = await applyApproved("firm", "2026-10-21T10:00", "2026-10-21T12:00", preparedAt2);
    const draftIdB = await draftIdOf(b, "approval");

    await expectError(await get(draftPath("no-such-reservation", draftIdB)), 404, "not-found");
    await expectError(await get(draftPath(a, "no-such-draft")), 404, "not-found");
    await expectError(await get(draftPath(a, draftIdB)), 404, "not-found");
  });
});

describe("管理 API：送信済み・送らないにする（POST /admin/reservations/{id}/drafts/{draftId}/sent・skip）", () => {
  it.each(["sent", "skip"] as const)(
    "%s：ない予約、ない下書きの id、ほかの予約の下書きの id は 404（not-found）。何も書かない",
    async (action) => {
      const a = await prepareA();
      const b = await applyApproved("firm", "2026-10-21T10:00", "2026-10-21T12:00", preparedAt2);
      const draftIdB = await draftIdOf(b, "approval");
      const before = await scanAll();

      await expectError(await mark("no-such-reservation", draftIdB, action), 404, "not-found");
      await expectError(await mark(a, "no-such-draft", action), 404, "not-found");
      await expectError(await mark(a, draftIdB, action), 404, "not-found");

      await expectNothingWritten(before);
    },
  );

  it.each(["sent", "skip"] as const)(
    "%s：本文が空（{}）でない（余計なキーがある、JSON でない）：400（invalid-input）。何も書かない（INV-4）",
    async (action) => {
      const a = await prepareA();
      const draftId = await draftIdOf(a, "approval");
      const before = await scanAll();

      await expectError(await mark(a, draftId, action, { status: "sent" }), 400, "invalid-input");
      await expectError(await mark(a, draftId, action, "{"), 400, "invalid-input");

      await expectNothingWritten(before);
      expect((await reservationDrafts(a))[0]?.status).toBe("unsent");
    },
  );
});

describe("管理 API：3回目のルートの認証", () => {
  it("管理者の id が取れない：5つのルートのどれも 401（unauthorized）。何も書かない", async () => {
    const a = await prepareA();
    const draftId = await draftIdOf(a, "approval");
    const unauthorized = createApp(store, noAdmin, mailSettings());
    const before = await scanAll();

    await expectError(await get("/admin/drafts", unauthorized), 401, "unauthorized");
    await expectError(
      await get(`/admin/reservations/${encodeURIComponent(a)}/drafts`, unauthorized),
      401,
      "unauthorized",
    );
    await expectError(await get(draftPath(a, draftId), unauthorized), 401, "unauthorized");
    await expectError(await mark(a, draftId, "sent", {}, unauthorized), 401, "unauthorized");
    await expectError(await mark(a, draftId, "skip", {}, unauthorized), 401, "unauthorized");

    await expectNothingWritten(before);
  });
});

describe("管理 API：下書きの操作（開く・送信済み・送らない）はメールを送らない（INV-6）", () => {
  it("開く・送信済み・送らないのあいだに、外へ送る呼び出し（fetch、https.request）をしない。開くは何も書かず、送信済み・送らないはその下書きだけを変える", async () => {
    const a = await prepareA();
    const b = await applyApproved("firm", "2026-10-21T10:00", "2026-10-21T12:00", preparedAt2);
    const draftIdA = await draftIdOf(a, "approval");
    const draftIdB = await draftIdOf(b, "approval");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const httpsSpy = vi.spyOn(https, "request");

    let before = await scanAll();
    await openDraft(a, draftIdA);
    await openDraft(b, draftIdB);
    await expectNothingWritten(before);

    before = await scanAll();
    await expectMarkedWithoutBody(await mark(a, draftIdA, "sent"));
    await expectOnlyOneDraftItemChanged(before, a);

    before = await scanAll();
    await expectMarkedWithoutBody(await mark(b, draftIdB, "skip"));
    await expectOnlyOneDraftItemChanged(before, b);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();
  });
});

describe("管理 API：3回目のルートのログに文面や個人情報を出さない（INV-10）", () => {
  /** console と標準出力・標準エラーに出たものを集める（出力はそのまま通す） */
  function captureOutput(): () => string {
    const calls: (() => unknown[][])[] = [
      ...(["log", "info", "warn", "error", "debug"] as const).map((method) => {
        const spy = vi.spyOn(console, method);
        return () => spy.mock.calls as unknown[][];
      }),
      ...[process.stdout, process.stderr].map((stream) => {
        const spy = vi.spyOn(stream, "write");
        return () => spy.mock.calls as unknown[][];
      }),
    ];
    const show = (arg: unknown): string =>
      typeof arg === "string"
        ? arg
        : arg instanceof Uint8Array
          ? Buffer.from(arg).toString("utf8")
          : inspect(arg, { depth: 10, breakLength: Number.POSITIVE_INFINITY });
    return () =>
      calls
        .flatMap((read) => read())
        .map((args) => args.map(show).join(" "))
        .join("\n");
  }

  it("一覧・開く・送信済み・送らない（成功・未送信でない・ないもの・入力の誤り・認証なし）の処理中のログ（console、標準出力、標準エラー）に、お客様の情報と自由記述の値、文面、担当者名・署名、本文の値が出ない", async () => {
    const a = await prepareA();
    const b = await applyApproved("firm", "2026-10-21T10:00", "2026-10-21T12:00", preparedAt2);
    await prepareOperation({ kind: "cancel", reservationId: b }, preparedAt3);
    const draftIdA = await draftIdOf(a, "approval");
    const approvalB = await draftIdOf(b, "approval");
    const cancellationB = await draftIdOf(b, "cancellation");
    /** 本文に入れる、ログに出てはいけない値（架空） */
    const bodyMarker = "架空の本文の値：ログに出さない";
    const output = captureOutput();

    await unsentList();
    await reservationDrafts(a);
    await reservationDrafts(b);
    await openDraft(a, draftIdA);
    await openDraft(b, cancellationB);
    await get(draftPath(a, "no-such-draft"));
    await mark(a, draftIdA, "sent");
    await mark(a, draftIdA, "skip");
    await mark(b, approvalB, "skip");
    await mark(b, approvalB, "sent");
    await mark(a, "no-such-draft", "sent");
    await mark(b, cancellationB, "sent", { memo: bodyMarker });
    await mark(b, cancellationB, "skip", `{"memo":"${bodyMarker}"`);
    const unauthorized = createApp(store, noAdmin, mailSettings());
    await get("/admin/drafts", unauthorized);
    await get(draftPath(b, cancellationB), unauthorized);
    await mark(b, cancellationB, "sent", {}, unauthorized);

    const text = output();
    for (const value of [
      ...personalValues,
      bodyMarker,
      staffName,
      ...signatureLines,
      "【スタジオゼブラ】",
      "お世話になっております",
      "撮影当日に履いていらっしゃった靴のご使用は禁止です。",
      "キャンセル料として",
    ]) {
      expect(text).not.toContain(value);
    }
  });
});
