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
  saveApplication,
} from "../db/reservations.ts";
import { type AdminDeps, createAdminRoute } from "./routes.ts";

// 何もしない予約の変更の、管理 API のルートの統合テスト（DynamoDB Local）。
// 根拠：docs/product-specs/booking.md「予約の変更」（箇条「日時・人数・ホリゾントの養生・機材保険・オプション・確定金額がすべて
// 今と同じ変更は、何もしない（成功として扱い、履歴も下書きも作らない）。オプションは並びによらず、同じものを選んでいれば同じとする」と、
// 例の表の「A の日時・内容・金額をすべて今のまま送る」「A の確定金額だけを 10,000円に変える」の行）、
// docs/design-docs/admin-api.md「予約の変更」（日時・内容・確定金額がすべて今と同じなら、何も書かずに 200 と空の下書きの一覧）、
// 「警告の確認（2回目）」、packages/contracts の AdminChangeRequest・AdminOperationAccepted、core-beliefs.md（INV-2、INV-7）。
// - 例の表のほかの行は routes-round2a.int.test.ts にある。既存のファイルは変えず、足した2行と何もしない変更の確かめをこのファイルに
//   分けた（道具は routes-round2a.int.test.ts と同じものを持つ）
// - 例の行は、本文の日時と API の現在時刻を JST で渡す場合と、同じ時点を UTC に直して渡す場合の両方で確かめる（INV-7）。
//   本文の日時を UTC で表しても、同じ時点なら今と同じ日時
// - 例の行に操作の日時が書かれていないときは、API の現在時刻を 2026/10/05 09:00 とする（routes-round2a.int.test.ts と同じ）。
//   例の表には年がないので 2026 年とする
// - 何もしないことは、200 と { drafts: [] }（AdminOperationAccepted）と、テーブルの中身（日ごとのアイテムの版番号と占有区間、
//   予約の META、履歴、下書き）がまったく変わらないことで確かめる
// - 「日時を変えないので、日時の判定はしない」は、例の行のほかに、締め切りを過ぎた時刻（10/20 9:00。人数だけを変える行と同じ）でも
//   警告を出さずに変わることで確かめる

const client = createLocalDynamoClient();
let store: ReservationStore;

// テーブルはキー設計どおり（pk・sk、GSI の gsi1pk・gsi1sk）にテストごとに作り、終わったら消す
async function createTable(): Promise<ReservationStore> {
  const tableName = `int-test-admin-noop-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
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

type ToZone = (at: DateTime) => DateTime;

/** 日時の表し方（INV-7）：JST のまま渡すか、同じ時点を UTC に直して渡すか */
const zones: readonly (readonly [string, ToZone])[] = [
  ["JST", (at) => at],
  ["UTC", (at) => at.toUTC()],
];

/** 本文に入れる日時（ISO 8601、オフセット付き。UTC なら Z） */
function iso(toZone: ToZone, local: string): string {
  const text = toZone(jst(local)).toISO({ suppressMilliseconds: true });
  if (text === null) throw new Error(`テストの日時が不正：${local}`);
  return text;
}

/** 申込の時刻（固定） */
const appliedAt = jst("2026-10-01T12:00");
/** テストの準備でする承認の時刻（固定） */
const preparedAt = jst("2026-10-02T12:00");
/** 例の行に操作の日時が書かれていないときの、API の現在時刻（固定） */
const operatedAt = "2026-10-05T09:00";
/** 本予約 A（開始 10/20 10:00）の、開始の24時間前を過ぎた時刻（例の表の「10/20 9:00 に、A の人数だけを変える」と同じ） */
const pastDeadlineAt = "2026-10-20T09:00";

/** API を呼ぶ管理者（架空のユーザー id） */
const adminUserId = "admin-user-kaku-noop-api";
/** 準備の承認をした管理者（架空のユーザー id） */
const preparingAdminUserId = "admin-user-kaku-noop-prep";

/** 返した日時の文字列を、比べやすい JST の "yyyy-MM-ddTHH:mm" にする */
function local(value: unknown): string {
  expect(typeof value).toBe("string");
  const parsed = DateTime.fromISO(value as string, { setZone: true });
  expect(parsed.isValid, String(value)).toBe(true);
  return parsed.setZone("Asia/Tokyo").toFormat("yyyy-MM-dd'T'HH:mm");
}

/** 保存された日時（UTC）を、比べやすい JST の "yyyy-MM-ddTHH:mm" にする */
function storedLocal(value: unknown): string {
  const parsed = DateTime.fromISO(String(value), { setZone: true });
  expect(parsed.isValid, String(value)).toBe(true);
  return parsed.setZone("Asia/Tokyo").toFormat("yyyy-MM-dd'T'HH:mm");
}

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
  name: "架空 据置花子",
  companyName: "架空現状合同会社",
  email: "sueoki.hanako.kaku@example.com",
  phone: "090-0000-1357",
  address: "架空県架空市現状町1-3-5",
  photographerName: "仮名 現状撮影",
} as const;

const shooting = {
  types: ["still"],
  details: "架空の撮影詳細：何もしない変更の API の確認用",
  notes: "架空の補足事項：何もしない変更の API の確認用",
} as const;

/** 申込の内容（変更の本文の内容の欄と同じ形） */
interface Content {
  partySize: number;
  cycloramaFloorProtection: boolean;
  equipmentInsurance: boolean;
  optionIds: readonly string[];
}

/** 本予約 A の申込の内容：4人・養生なし（プランA）・機材保険なし・オプションなし。見積は税抜 10,000円・税込 11,000円 */
const plainContent: Content = {
  partySize: 4,
  cycloramaFloorProtection: false,
  equipmentInsurance: false,
  optionIds: [],
};

/**
 * オプションを2つ選んだ本予約 Q の申込の内容：6人・養生あり（プランA）・機材保険あり・オプション workshop と glitter（この並び）。
 * 6人なのは、「6人以上のワークショップ」を5人以下で選べるかが未決事項のため。
 * 見積は 2,500 × 4 + 1,000 + 2,000 × 2 = 15,000円（税抜）、税込 16,500円
 */
const optionsContent: Content = {
  partySize: 6,
  cycloramaFloorProtection: true,
  equipmentInsurance: true,
  optionIds: ["workshop", "glitter"],
};

function application(
  kind: ApplicationKind,
  content: Content,
  estimate: { subtotalExcludingTax: number; estimateIncludingTax: number },
): ReservationApplication {
  return {
    kind,
    start: jst("2026-10-20T10:00"),
    end: jst("2026-10-20T12:00"),
    partySize: content.partySize,
    cycloramaFloorProtection: content.cycloramaFloorProtection,
    planId: "A",
    equipmentInsurance: content.equipmentInsurance,
    optionIds: [...content.optionIds],
    estimate: {
      subtotalExcludingTax: Yen.parse(estimate.subtotalExcludingTax),
      estimateIncludingTax: Yen.parse(estimate.estimateIncludingTax),
    },
    customer,
    shooting,
  };
}

// ---- 準備の道具（保存の層の関数で作る） ----

async function prepareOperation(operation: ReservationOperationInput): Promise<void> {
  const result = await saveReservationOperation(store, operation, {
    now: preparedAt,
    adminUserId: preparingAdminUserId,
  });
  if (!result.ok) {
    throw new Error(`準備の操作が不可になった（${operation.kind}、${result.reason}）`);
  }
}

async function applyApproved(
  kind: ApplicationKind,
  content: Content,
  estimate: { subtotalExcludingTax: number; estimateIncludingTax: number },
  confirmedPrice: number,
): Promise<string> {
  const result = await saveApplication(store, application(kind, content, estimate), {
    now: appliedAt,
  });
  if (!result.ok) {
    throw new Error(`準備の申込が不可になった（${kind}、${result.reason}）`);
  }
  await prepareOperation({
    kind: "approve",
    reservationId: result.id,
    confirmedPrice: Yen.parse(confirmedPrice),
  });
  return result.id;
}

/** 本予約 A 10/20 10:00–12:00（占有区間 10:00–13:00、確定金額 11,000円） */
async function prepareA(): Promise<string> {
  return applyApproved(
    "firm",
    plainContent,
    { subtotalExcludingTax: 10_000, estimateIncludingTax: 11_000 },
    11_000,
  );
}

/** 本予約 Q 10/20 10:00–12:00（オプション workshop・glitter、確定金額 16,500円） */
async function prepareQ(): Promise<string> {
  return applyApproved(
    "firm",
    optionsContent,
    { subtotalExcludingTax: 15_000, estimateIncludingTax: 16_500 },
    16_500,
  );
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

async function send(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  now: DateTime,
): Promise<Response> {
  const route = createAdminRoute(deps(now));
  if (body === undefined) {
    return route.request(path, { method });
  }
  return route.request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 予約の変更（POST /admin/reservations/{id}/change） */
async function change(id: string, body: unknown, now: DateTime): Promise<Response> {
  return send("POST", `/admin/reservations/${id}/change`, body, now);
}

/**
 * 変更の本文（AdminChangeRequest）。日時は指定がなければ今の 10/20 10:00–12:00、内容と確定金額は指定のとおり。
 * 日時を変えないときも今の日時を送る（admin-api.md「予約の変更」）
 */
function changeBody(
  toZone: ToZone,
  content: Content,
  confirmedPrice: number,
  overrides: { start?: string; end?: string; acknowledgedWarnings?: readonly string[] } = {},
): Record<string, unknown> {
  return {
    start: iso(toZone, overrides.start ?? "2026-10-20T10:00"),
    end: iso(toZone, overrides.end ?? "2026-10-20T12:00"),
    partySize: content.partySize,
    cycloramaFloorProtection: content.cycloramaFloorProtection,
    equipmentInsurance: content.equipmentInsurance,
    optionIds: [...content.optionIds],
    confirmedPrice,
    ...(overrides.acknowledgedWarnings === undefined
      ? {}
      : { acknowledgedWarnings: [...overrides.acknowledgedWarnings] }),
  };
}

/** 成功の JSON を返す（ステータスと content-type を確かめる） */
async function okJson(res: Response, status: number): Promise<unknown> {
  const text = await res.text();
  expect(res.status, text).toBe(status);
  expect(res.headers.get("content-type") ?? "").toContain("application/json");
  return JSON.parse(text) as unknown;
}

/** 操作が成功したときの返事が 200 と AdminOperationAccepted であることを確かめ、本文を返す */
async function accepted(res: Response): Promise<AdminOperationAccepted> {
  const json = await okJson(res, 200);
  const parsed = AdminOperationAccepted.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  if (!parsed.success) throw new Error("AdminOperationAccepted を通らない");
  // 確認していない警告で止まった（409）のでも、決まりで不可（422）でもないことも、ここで確かめている
  expect(AdminRejected.safeParse(json).success).toBe(false);
  return parsed.data;
}

async function detailJson(id: string, now: DateTime): Promise<AdminReservationDetail> {
  const json = await okJson(await send("GET", `/admin/reservations/${id}`, undefined, now), 200);
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

function sortedItems(items: readonly PlainItem[]): PlainItem[] {
  return [...items].sort((x, y) => itemKey(x).localeCompare(itemKey(y)));
}

/** テーブルの中身（日ごとのアイテム・予約の META・個人情報・履歴・下書き）が何も変わっていないことを確かめる */
async function expectNothingWritten(before: readonly PlainItem[]): Promise<void> {
  expect(sortedItems(await scanAll())).toEqual(sortedItems(before));
}

/** その日のアイテムにある、その id の占有区間（バッファ込み）を JST の [開始, 終わり] で返す。なければ undefined */
async function occupancy(day: string, id: string): Promise<[string, string] | undefined> {
  const res = await client.send(
    new GetItemCommand({
      TableName: store.tableName,
      Key: { pk: { S: `DAY#${day}` }, sk: { S: "META" } },
      ConsistentRead: true,
    }),
  );
  if (res.Item === undefined) return undefined;
  const found = (plainItem(res.Item)["intervals"] as PlainItem[]).filter((i) => i["id"] === id);
  if (found.length === 0) return undefined;
  expect(found).toHaveLength(1);
  return [storedLocal(found[0]?.["start"]), storedLocal(found[0]?.["end"])];
}

/** 何もしない変更：200 と空の下書きの一覧で、テーブルの中身は何も変わらない */
async function expectNoOp(id: string, body: unknown, now: DateTime): Promise<void> {
  const before = await scanAll();
  expect(await accepted(await change(id, body, now))).toEqual({ drafts: [] });
  await expectNothingWritten(before);
}

/**
 * 今までどおりの変更：200 と変更の下書き1件（あて先はその予約）で、履歴が1件増える（変更、API を呼んだ管理者）。
 * 予約の詳細を返す（変わった欄を確かめるため）
 */
async function expectChanged(
  id: string,
  body: unknown,
  now: DateTime,
): Promise<AdminReservationDetail> {
  const historyBefore = (await detailJson(id, now)).history.length;
  const { drafts } = await accepted(await change(id, body, now));
  expect(drafts).toEqual([{ kind: "change", reservationId: id }]);
  const detail = await detailJson(id, now);
  expect(detail.history).toHaveLength(historyBefore + 1);
  const entry = detail.history.at(-1);
  expect(entry?.operation).toBe("change");
  expect(entry?.actor).toEqual({ kind: "admin", userId: adminUserId });
  return detail;
}

// ---- テスト ----

describe("予約の変更", () => {
  describe("本予約 A が 10/20 10:00–12:00（占有区間 10:00–13:00、金額 11,000円）の場合。（POST /admin/reservations/{id}/change）", () => {
    for (const [zone, toZone] of zones) {
      const z = `（日時を ${zone} で渡す）`;
      const now = toZone(jst(operatedAt));

      it(`A の日時・内容・金額をすべて今のまま送る：何もしない（成功。履歴も変更の下書きも作らない）${z}`, async () => {
        const a = await prepareA();
        const historyBefore = (await detailJson(a, now)).history.length;

        await expectNoOp(a, changeBody(toZone, plainContent, 11_000), now);

        const detail = await detailJson(a, now);
        expect(detail.history).toHaveLength(historyBefore);
        expect(detail.status).toBe("firm");
        expect([local(detail.start), local(detail.end)]).toEqual([
          "2026-10-20T10:00",
          "2026-10-20T12:00",
        ]);
        expect(detail.confirmedPrice).toBe(11_000);
        expect(await occupancy("2026-10-20", a)).toEqual(["2026-10-20T10:00", "2026-10-20T13:00"]);
      });

      it(`A の確定金額だけを 10,000円に変える：可。日時を変えないので、日時の判定はしない。変更の下書きを作る${z}`, async () => {
        const a = await prepareA();

        const detail = await expectChanged(a, changeBody(toZone, plainContent, 10_000), now);

        expect(detail.status).toBe("firm");
        expect(detail.confirmedPrice).toBe(10_000);
        expect([local(detail.start), local(detail.end)]).toEqual([
          "2026-10-20T10:00",
          "2026-10-20T12:00",
        ]);
        expect(detail.partySize).toBe(4);
        expect(detail.cycloramaFloorProtection).toBe(false);
        expect(detail.equipmentInsurance).toBe(false);
        expect(detail.optionIds).toEqual([]);
        expect(await occupancy("2026-10-20", a)).toEqual(["2026-10-20T10:00", "2026-10-20T13:00"]);
      });
    }
  });
});

describe("管理 API：予約の変更（何もしない変更。日時・人数・ホリゾントの養生・機材保険・オプション・確定金額がすべて今と同じ）", () => {
  for (const [zone, toZone] of zones) {
    const z = `（日時を ${zone} で渡す）`;
    const now = toZone(jst(operatedAt));

    it(`本予約 Q（オプション workshop・glitter）に、オプションを申込と同じ並びで、ほかもすべて今のまま送る：200 と空の下書きの一覧。何も書かない${z}`, async () => {
      const q = await prepareQ();

      await expectNoOp(q, changeBody(toZone, optionsContent, 16_500), now);
    });

    it(`本予約 Q（オプション workshop・glitter）に、オプションの並びだけを逆（glitter・workshop）にして、ほかはすべて今のまま送る：200 と空の下書きの一覧（並びによらず、同じものを選んでいれば同じ）。何も書かない${z}`, async () => {
      const q = await prepareQ();

      await expectNoOp(
        q,
        changeBody(toZone, { ...optionsContent, optionIds: ["glitter", "workshop"] }, 16_500),
        now,
      );
    });

    it(`本予約 A に、開始の24時間前を過ぎた 10/20 9:00 に、すべて今のまま送る：200 と空の下書きの一覧（日時を変えないので警告も出さない）。何も書かない${z}`, async () => {
      const a = await prepareA();

      await expectNoOp(a, changeBody(toZone, plainContent, 11_000), toZone(jst(pastDeadlineAt)));
    });

    it(`本予約 A に、確認した警告の一覧を付けて、ほかはすべて今のまま送る：200 と空の下書きの一覧（確認した一覧に今は出ていない警告があってもよい）。何も書かない${z}`, async () => {
      const a = await prepareA();

      await expectNoOp(
        a,
        changeBody(toZone, plainContent, 11_000, {
          acknowledgedWarnings: ["past-24-hours-before-start"],
        }),
        now,
      );
    });
  }
});

describe("管理 API：予約の変更（1つでも違う欄があれば、今までどおり変更になる）", () => {
  for (const [zone, toZone] of zones) {
    const z = `（日時を ${zone} で渡す）`;
    const now = toZone(jst(operatedAt));

    it(`本予約 A の確定金額だけを 10,000円に変える（10/20 9:00、開始の24時間前を過ぎてから）：日時を変えないので警告を出さずに変わる。変更の下書きを作る${z}`, async () => {
      const a = await prepareA();
      const at = toZone(jst(pastDeadlineAt));

      const detail = await expectChanged(a, changeBody(toZone, plainContent, 10_000), at);

      expect(detail.confirmedPrice).toBe(10_000);
    });

    it(`本予約 A の人数だけを 4人から 5人に変える：変更になる。人数は 5人${z}`, async () => {
      const a = await prepareA();

      const detail = await expectChanged(
        a,
        changeBody(toZone, { ...plainContent, partySize: 5 }, 11_000),
        now,
      );

      expect(detail.partySize).toBe(5);
    });

    it(`本予約 A のホリゾントの養生だけを、なしからありに変える：変更になる。養生はあり${z}`, async () => {
      const a = await prepareA();

      const detail = await expectChanged(
        a,
        changeBody(toZone, { ...plainContent, cycloramaFloorProtection: true }, 11_000),
        now,
      );

      expect(detail.cycloramaFloorProtection).toBe(true);
    });

    it(`本予約 A の機材保険だけを、なしからありに変える：変更になる。機材保険はあり${z}`, async () => {
      const a = await prepareA();

      const detail = await expectChanged(
        a,
        changeBody(toZone, { ...plainContent, equipmentInsurance: true }, 11_000),
        now,
      );

      expect(detail.equipmentInsurance).toBe(true);
    });

    it(`本予約 A のオプションだけを、なしから glitter に変える：変更になる。オプションは glitter${z}`, async () => {
      const a = await prepareA();

      const detail = await expectChanged(
        a,
        changeBody(toZone, { ...plainContent, optionIds: ["glitter"] }, 11_000),
        now,
      );

      expect(detail.optionIds).toEqual(["glitter"]);
    });

    it(`本予約 Q（オプション workshop・glitter）のオプションを workshop だけにする（1つ減らす）：変更になる。オプションは workshop${z}`, async () => {
      const q = await prepareQ();

      const detail = await expectChanged(
        q,
        changeBody(toZone, { ...optionsContent, optionIds: ["workshop"] }, 16_500),
        now,
      );

      expect(detail.optionIds).toEqual(["workshop"]);
    });

    it(`本予約 A の終わりだけを 12:00 から 13:00 に変える：変更になる。予約区間は 10:00–13:00、占有区間は 10:00–14:00${z}`, async () => {
      const a = await prepareA();

      const detail = await expectChanged(
        a,
        changeBody(toZone, plainContent, 11_000, { end: "2026-10-20T13:00" }),
        now,
      );

      expect([local(detail.start), local(detail.end)]).toEqual([
        "2026-10-20T10:00",
        "2026-10-20T13:00",
      ]);
      expect(await occupancy("2026-10-20", a)).toEqual(["2026-10-20T10:00", "2026-10-20T14:00"]);
    });

    it(`本予約 A の開始だけを 10:00 から 09:30 に変える：変更になる。予約区間は 09:30–12:00、占有区間は 09:30–13:00${z}`, async () => {
      const a = await prepareA();

      const detail = await expectChanged(
        a,
        changeBody(toZone, plainContent, 11_000, { start: "2026-10-20T09:30" }),
        now,
      );

      expect([local(detail.start), local(detail.end)]).toEqual([
        "2026-10-20T09:30",
        "2026-10-20T12:00",
      ]);
      expect(await occupancy("2026-10-20", a)).toEqual(["2026-10-20T09:30", "2026-10-20T13:00"]);
    });
  }
});
