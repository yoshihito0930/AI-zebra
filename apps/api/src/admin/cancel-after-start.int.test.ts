import {
  type AttributeValue,
  CreateTableCommand,
  DeleteTableCommand,
  GetItemCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import {
  AdminOperationAccepted,
  AdminRejected,
  AdminReservationDetail,
  PriceTable,
  Yen,
} from "@zebra/contracts";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalDynamoClient } from "../db/client.ts";
import { type ReservationOperationInput, saveReservationOperation } from "../db/operations.ts";
import {
  type ApplicationKind,
  type ReservationApplication,
  type ReservationStore,
  getReservation,
  saveApplication,
} from "../db/reservations.ts";
import { type AdminDeps, createAdminRoute } from "./routes.ts";

// 開始以降（利用中・利用後）の取消を、管理 API で確かめる統合テスト（DynamoDB Local）。
// 根拠：docs/product-specs/booking.md の未決事項「利用日を過ぎてから（利用中・利用後）の取消の扱い」
// （決まるまでは、開始以降の本予約は取消できない。管理 API は 409 invalid-status を返し、何も書かない。
// 詳細には今取消したときのキャンセル料を出さない。仮予約・第二キープは、開始以降も今までどおり取消できる）、
// 「取消とキャンセル料」（利用日当日は100%。仮予約・第二キープは無料）、「第二キープ」（仮予約の取消で第二キープに案内の下書き）、
// docs/design-docs/admin-api.md（取消のルート、詳細のキャンセル料は取消できる状態のときだけ、返すときの決まり）、
// core-beliefs.md（INV-2：できない操作は何も残さない、INV-7：現在時刻は固定し、JST と UTC のどちらで渡しても同じ結果）。
// - 「開始以降」は、予約区間の開始の時刻と同じか後。開始ちょうどは取消できない。開始の直前（1分前）は今までどおり取消できる
// - 「何も書かない」は、テーブルの中身（予約の META・個人情報・履歴、日ごとのアイテム、下書き）が操作の前と同じであることで確かめる
// - どこで「取消できない」と判定するか（保存の層・booking-core）は決めない。API の返事と DB で確かめる
// - routes.int.test.ts の道具と同じものをこのファイルに持つ（既存のテストファイルを変えないため）

const client = createLocalDynamoClient();
let store: ReservationStore;

// テーブルはキー設計どおり（pk・sk、GSI の gsi1pk・gsi1sk）にテストごとに作り、終わったら消す
async function createTable(): Promise<ReservationStore> {
  const tableName = `int-test-admin-after-start-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
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

beforeEach(async () => {
  store = await createTable();
});

afterEach(async () => {
  await client.send(new DeleteTableCommand({ TableName: store.tableName }));
});

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
/** テストの準備でする承認の時刻（固定） */
const preparedAt = jst("2026-10-02T12:00");

/** API を呼ぶ管理者（架空のユーザー id） */
const adminUserId = "admin-user-kaku-api";
/** 準備の承認をした管理者（架空のユーザー id） */
const preparingAdminUserId = "admin-user-kaku-prep";

/** 現在時刻の表し方（INV-7）：JST のまま渡すか、同じ時点を UTC に直して渡すか */
const zones = [
  ["JST", (at: DateTime) => at],
  ["UTC", (at: DateTime) => at.toUTC()],
] as const;

// ---- 料金表（booking.md「料金」の単価・追加・プランの決め方から作る） ----

const specPriceTable = PriceTable.parse({
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
  name: "架空 開始後花子",
  companyName: "架空開始後株式会社",
  email: "kaishigo.kaku@example.com",
  phone: "090-0000-2468",
  address: "架空県架空市開始後町2-4-6",
  photographerName: "仮名 開始後撮影",
} as const;

const shooting = {
  types: ["still"],
  details: "架空の撮影詳細：開始以降の取消の確認用",
  notes: "架空の補足事項：開始以降の取消の確認用",
} as const;

/** 申込（見積は 10,000円・税込 11,000円） */
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
    shooting,
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

function deps(now: DateTime): AdminDeps {
  return {
    store,
    now: () => now,
    priceTable: specPriceTable,
    adminUserId: () => adminUserId,
  };
}

/** 取消（POST /admin/reservations/{id}/cancel）。本文は契約（AdminEmptyRequest）どおり {} */
async function cancel(id: string, now: DateTime): Promise<Response> {
  return createAdminRoute(deps(now)).request(`/admin/reservations/${id}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

async function okJson(res: Response): Promise<unknown> {
  const text = await res.text();
  expect(res.status, text).toBe(200);
  expect(res.headers.get("content-type") ?? "").toContain("application/json");
  return JSON.parse(text) as unknown;
}

/** エラーの応答が、ステータスと { error: <理由> }（AdminRejected）であることを確かめる */
async function expectError(res: Response, status: number, error: string): Promise<void> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  expect(res.headers.get("content-type") ?? "").toContain("application/json");
  const json = JSON.parse(text) as unknown;
  expect(AdminRejected.safeParse(json).success).toBe(true);
  expect(json).toEqual({ error });
}

/** 操作が成功したときの返事が AdminOperationAccepted を通ることを確かめ、下書きを返す */
async function acceptedDrafts(res: Response): Promise<AdminOperationAccepted["drafts"]> {
  const json = await okJson(res);
  const parsed = AdminOperationAccepted.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  return parsed.success ? parsed.data.drafts : [];
}

/** 下書きの並び順は決めていないので、件数と中身で比べる */
function expectDrafts(actual: readonly unknown[], expected: readonly unknown[]): void {
  expect(actual).toHaveLength(expected.length);
  expect(actual).toEqual(expect.arrayContaining([...expected]));
}

async function detailJson(id: string, now: DateTime): Promise<AdminReservationDetail> {
  const json = await okJson(await createAdminRoute(deps(now)).request(`/admin/reservations/${id}`));
  const parsed = AdminReservationDetail.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  if (!parsed.success) throw new Error("AdminReservationDetail を通らない");
  return parsed.data;
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

/** できない操作で、テーブルの中身（予約・日ごとのアイテム・履歴・下書き）が何も変わっていないことを確かめる */
async function expectNothingWritten(before: readonly PlainItem[]): Promise<void> {
  const sorted = (items: readonly PlainItem[]) =>
    [...items].sort((x, y) => itemKey(x).localeCompare(itemKey(y)));
  expect(sorted(await scanAll())).toEqual(sorted(before));
}

/** 日ごとのアイテムにある占有区間の id（枠を確保している予約・ブロック枠） */
async function idsHolding(day: string): Promise<string[]> {
  const res = await client.send(
    new GetItemCommand({
      TableName: store.tableName,
      Key: { pk: { S: `DAY#${day}` }, sk: { S: "META" } },
      ConsistentRead: true,
    }),
  );
  if (res.Item === undefined) return [];
  const intervals = plainItem(res.Item)["intervals"] as PlainItem[];
  return intervals.map((i) => String(i["id"]));
}

// ---- テスト ----

/** 本予約（確定金額 27,500円）の予約区間と、開始以降の取消の日時 */
const firmAfterStartCases: [label: string, start: string, end: string, now: string][] = [
  [
    "本予約 10/20 10:00–12:00 を開始ちょうど（10/20 10:00）に取消",
    "2026-10-20T10:00",
    "2026-10-20T12:00",
    "2026-10-20T10:00",
  ],
  [
    "本予約 10/20 10:00–12:00 を利用中（10/20 11:00）に取消",
    "2026-10-20T10:00",
    "2026-10-20T12:00",
    "2026-10-20T11:00",
  ],
  [
    "本予約 10/20 10:00–12:00 を利用後（終わりちょうどの 10/20 12:00）に取消",
    "2026-10-20T10:00",
    "2026-10-20T12:00",
    "2026-10-20T12:00",
  ],
  [
    "本予約 10/20 10:00–12:00 を利用後（翌日の 10/21 09:00）に取消",
    "2026-10-20T10:00",
    "2026-10-20T12:00",
    "2026-10-21T09:00",
  ],
  [
    "本予約 10/20 08:00–10:00（UTC では 10/19 23:00 開始）を開始ちょうど（10/20 08:00。UTC では 10/19 23:00）に取消",
    "2026-10-20T08:00",
    "2026-10-20T10:00",
    "2026-10-20T08:00",
  ],
];

/** 本予約（確定金額 27,500円）の予約区間と、開始の直前（1分前）の取消の日時。利用日当日なので100% */
const firmJustBeforeStartCases: [label: string, start: string, end: string, now: string][] = [
  [
    "本予約 10/20 10:00–12:00 を開始の直前（10/20 09:59）に取消",
    "2026-10-20T10:00",
    "2026-10-20T12:00",
    "2026-10-20T09:59",
  ],
  [
    "本予約 10/20 08:00–10:00 を開始の直前（10/20 07:59。UTC では 10/19 22:59）に取消",
    "2026-10-20T08:00",
    "2026-10-20T10:00",
    "2026-10-20T07:59",
  ],
];

describe("管理 API：開始以降（利用中・利用後）の取消（booking.md 未決事項「利用日を過ぎてから（利用中・利用後）の取消の扱い」。決まるまでは、開始以降の本予約は取消できない）", () => {
  describe("本予約の取消（POST /admin/reservations/{id}/cancel）", () => {
    for (const [zone, toZone] of zones) {
      it.each(firmAfterStartCases)(
        `%s（現在時刻を ${zone} で渡す）：409 と { error: invalid-status }。何も書かない（予約は本予約のまま枠を確保し、履歴・下書きも増えない）`,
        async (_, start, end, now) => {
          const f = await applyApproved("firm", start, end, 27_500);
          const before = await scanAll();

          await expectError(await cancel(f, toZone(jst(now))), 409, "invalid-status");

          await expectNothingWritten(before);
          const stored = await getReservation(store, f);
          expect(stored?.status).toBe("firm");
          expect(stored?.history.at(-1)?.operation).toBe("approve");
          expect(await idsHolding(start.slice(0, 10))).toContain(f);
        },
      );

      it.each(firmJustBeforeStartCases)(
        `%s（現在時刻を ${zone} で渡す）：今までどおり取消できる。取消。枠を解放し、取消の下書きにキャンセル料 27,500円（100%。利用日当日）`,
        async (_, start, end, now) => {
          const f = await applyApproved("firm", start, end, 27_500);

          const drafts = await acceptedDrafts(await cancel(f, toZone(jst(now))));

          const stored = await getReservation(store, f);
          expect(stored?.status).toBe("cancelled");
          expect(stored?.history.at(-1)?.operation).toBe("cancel");
          expect(stored?.history.at(-1)?.actor).toEqual({ kind: "admin", userId: adminUserId });
          expect(stored?.history.at(-1)?.at.toMillis()).toBe(jst(now).toMillis());
          expect(await idsHolding(start.slice(0, 10))).not.toContain(f);
          expectDrafts(drafts, [
            {
              kind: "cancellation",
              reservationId: f,
              cancellationFee: { ratePercent: 100, fee: 27_500 },
            },
          ]);
        },
      );
    }
  });

  describe("仮予約・第二キープの取消は、開始以降も今までどおりできる（仮予約 P 10/20 13:00–15:00 に第二キープ K 14:00–17:00 が付いている）", () => {
    const provisionalCases: [label: string, now: string][] = [
      ["P を P の開始ちょうど（10/20 13:00）に取消", "2026-10-20T13:00"],
      ["P を P・K の利用中（10/20 14:30）に取消", "2026-10-20T14:30"],
      ["P を利用後（翌日の 10/21 09:00）に取消", "2026-10-21T09:00"],
    ];

    const secondHoldCases: [label: string, now: string][] = [
      ["K を K の開始ちょうど（10/20 14:00）に取消", "2026-10-20T14:00"],
      ["K を P・K の利用中（10/20 14:30）に取消", "2026-10-20T14:30"],
      ["K を利用後（翌日の 10/21 09:00）に取消", "2026-10-21T09:00"],
    ];

    for (const [zone, toZone] of zones) {
      it.each(provisionalCases)(
        `%s（現在時刻を ${zone} で渡す）：P は取消（キャンセル料なし）。K は第二キープのまま。下書きは P の取消（0%・0円）と、K への繰り上げ案内（残っている仮予約なし）`,
        async (_, now) => {
          const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
          const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");

          const drafts = await acceptedDrafts(await cancel(p, toZone(jst(now))));

          const stored = await getReservation(store, p);
          expect(stored?.status).toBe("cancelled");
          expect(stored?.history.at(-1)?.operation).toBe("cancel");
          expect(stored?.history.at(-1)?.actor).toEqual({ kind: "admin", userId: adminUserId });
          expect((await getReservation(store, k))?.status).toBe("second-hold");
          expect(await idsHolding("2026-10-20")).not.toContain(p);
          expect(await idsHolding("2026-10-20")).toContain(k);
          expectDrafts(drafts, [
            { kind: "cancellation", reservationId: p, cancellationFee: { ratePercent: 0, fee: 0 } },
            { kind: "move-up-notice", reservationId: k, remainingProvisionalIds: [] },
          ]);
        },
      );

      it.each(secondHoldCases)(
        `%s（現在時刻を ${zone} で渡す）：K は取消（キャンセル料なし）。P は仮予約のまま。下書きは K の取消（0%・0円）だけ（K の後ろに接する予約はない）`,
        async (_, now) => {
          const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
          const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");

          const drafts = await acceptedDrafts(await cancel(k, toZone(jst(now))));

          const stored = await getReservation(store, k);
          expect(stored?.status).toBe("cancelled");
          expect(stored?.history.at(-1)?.operation).toBe("cancel");
          expect(stored?.history.at(-1)?.actor).toEqual({ kind: "admin", userId: adminUserId });
          expect((await getReservation(store, p))?.status).toBe("provisional");
          expect(await idsHolding("2026-10-20")).not.toContain(k);
          expect(await idsHolding("2026-10-20")).toContain(p);
          expectDrafts(drafts, [
            { kind: "cancellation", reservationId: k, cancellationFee: { ratePercent: 0, fee: 0 } },
          ]);
        },
      );
    }
  });

  describe("予約の詳細（GET /admin/reservations/{id}）の、今取消したときのキャンセル料", () => {
    for (const [zone, toZone] of zones) {
      it.each(firmAfterStartCases)(
        `%sしようとして詳細を開く（現在時刻を ${zone} で渡す）：200。本予約のまま、今取消したときのキャンセル料（cancellationFeeIfCancelledNow）はない`,
        async (_, start, end, now) => {
          const f = await applyApproved("firm", start, end, 27_500);

          const detail = await detailJson(f, toZone(jst(now)));

          expect(detail.status).toBe("firm");
          expect(detail.confirmedPrice).toBe(27_500);
          expect(detail.cancellationFeeIfCancelledNow).toBeUndefined();
          expect(detail.currentEstimate).toBeUndefined();
        },
      );

      it.each(firmJustBeforeStartCases)(
        `%sしようとして詳細を開く（現在時刻を ${zone} で渡す）：今取消したときのキャンセル料は 27,500円（100%。利用日当日）`,
        async (_, start, end, now) => {
          const f = await applyApproved("firm", start, end, 27_500);

          const detail = await detailJson(f, toZone(jst(now)));

          expect(detail.status).toBe("firm");
          expect(detail.cancellationFeeIfCancelledNow).toEqual({ ratePercent: 100, fee: 27_500 });
        },
      );

      it.each([
        ["P・K の利用中（10/20 14:30）", "2026-10-20T14:30"],
        ["利用後（翌日の 10/21 09:00）", "2026-10-21T09:00"],
      ])(
        `仮予約 P 10/20 13:00–15:00 と、P に付く第二キープ K 14:00–17:00 の詳細を%sに開く（現在時刻を ${zone} で渡す）：取消できる状態なので、今取消したときのキャンセル料は 0%・0円（無料）`,
        async (_, now) => {
          const p = await applyApproved("provisional", "2026-10-20T13:00", "2026-10-20T15:00");
          const k = await applyApproved("second-hold", "2026-10-20T14:00", "2026-10-20T17:00");

          const pDetail = await detailJson(p, toZone(jst(now)));
          const kDetail = await detailJson(k, toZone(jst(now)));

          expect(pDetail.status).toBe("provisional");
          expect(pDetail.cancellationFeeIfCancelledNow).toEqual({ ratePercent: 0, fee: 0 });
          expect(kDetail.status).toBe("second-hold");
          expect(kDetail.cancellationFeeIfCancelledNow).toEqual({ ratePercent: 0, fee: 0 });
        },
      );
    }
  });
});
