import {
  type AttributeValue,
  CreateTableCommand,
  DeleteTableCommand,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import { PriceTable, Yen } from "@zebra/contracts";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalDynamoClient } from "./client.ts";
import {
  type ReservationChangeContent,
  type ReservationOperationInput,
  type SaveOperationResult,
  saveReservationOperation,
} from "./operations.ts";
import {
  type ApplicationKind,
  type ReservationApplication,
  type ReservationStore,
  getReservation,
  saveApplication,
} from "./reservations.ts";

// 何もしない予約の変更の保存の統合テスト（DynamoDB Local）。
// 根拠：docs/product-specs/booking.md「予約の変更」の箇条「日時・人数・ホリゾントの養生・機材保険・オプション・確定金額がすべて
// 今と同じ変更は、何もしない（成功として扱い、履歴も下書きも作らない）。オプションは並びによらず、同じものを選んでいれば同じとする」、
// docs/design-docs/admin-api.md「予約の変更」（何も書かずに 200 と空の下書きの一覧。バッファの切り替えと同じ）、
// core-beliefs.md（INV-2、INV-7）。
// - 今と同じかを比べるのは保存の層（saveReservationOperation）とする。バッファの切り替えで今と同じかを決めるのが保存の層であるのと
//   そろえるため（admin-api.md「バッファの切り替え」、db/buffer-change.int.test.ts）。予約の META を読んだのと同じ書き込みの中で
//   比べないと、ほかの管理者の変更と入れ違ったときに、古い値と比べて「何もしない」にしてしまうため
// - 何もしないことは、成功（ok）で下書きが空であることと、テーブルの中身（日ごとのアイテムの版番号と占有区間、予約の META、
//   履歴、下書き、個人情報）がまったく変わらないことで確かめる。戻り値に「変わったか」の印（バッファの切り替えの changed）を
//   足すことは、実装済みの型を変えることになるので、このテストでは求めない
// - 日時は、JST で渡す場合と、同じ時点を UTC に直して渡す場合の両方で確かめる（INV-7）。UTC で渡しても同じ時点なら今と同じ
// - 1つでも違う欄があれば、今までどおり変更になる（成功、変更の下書き、履歴が1件増える）ことも確かめる
// - 例の表には年がないので 2026 年とする。既存の operations.int.test.ts は変えず、このファイルに分けた（道具は同じものを持つ）

const client = createLocalDynamoClient();
let store: ReservationStore;

// テーブルはキー設計どおり（pk・sk、GSI の gsi1pk・gsi1sk）にテストごとに作り、終わったら消す
async function createTable(): Promise<ReservationStore> {
  const tableName = `int-test-noop-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
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

/** 申込の時刻（固定） */
const appliedAt = jst("2026-10-01T12:00");
/** テストの準備でする承認の時刻（固定） */
const preparedAt = jst("2026-10-02T12:00");
/** 準備でする変更（一度変更した予約を作る）の時刻（固定） */
const preparedChangeAt = jst("2026-10-03T12:00");
/** 確かめる操作の時刻（固定） */
const operatedAt = jst("2026-10-05T09:00");

/** 操作した管理者（架空のユーザー id） */
const adminUserId = "admin-user-kaku-noop";

// ---- 料金表（booking.md「料金」の単価・追加・プランの決め方から作る。変更の見積の再計算に使う） ----

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
  name: "架空 無変更太郎",
  companyName: "架空据置株式会社",
  email: "mihenkou.taro.kaku@example.com",
  phone: "090-0000-2468",
  address: "架空県架空市据置町2-4-6",
  photographerName: "仮名 据置撮影",
} as const;

const shooting = {
  types: ["still"],
  details: "架空の撮影詳細：何もしない変更の確認用",
  notes: "架空の補足事項：何もしない変更の確認用",
} as const;

/**
 * 本予約 A 10/20 10:00–12:00 の申込の内容：4人・養生なし（プランA）・機材保険なし・オプションなし。
 * 見積は 2,500 × 4 = 10,000円（税抜）、税込 11,000円
 */
const plainContent: ReservationChangeContent = {
  partySize: 4,
  cycloramaFloorProtection: false,
  equipmentInsurance: false,
  optionIds: [],
};

/**
 * オプションを2つ選んだ予約 Q 10/20 10:00–12:00 の申込の内容：6人・養生あり（プランA）・機材保険あり・
 * オプション workshop と glitter（この並び）。6人なのは、「6人以上のワークショップ」を5人以下で選べるかが未決事項のため。
 * 見積は 2,500 × 4 + 1,000 + 2,000 × 2 = 15,000円（税抜）、税込 16,500円
 */
const optionsContent: ReservationChangeContent = {
  partySize: 6,
  cycloramaFloorProtection: true,
  equipmentInsurance: true,
  optionIds: ["workshop", "glitter"],
};

/** 申込のときの見積（税抜・税込。booking.md「料金」の計算で出した値をそのまま書く） */
interface Estimate {
  subtotalExcludingTax: number;
  estimateIncludingTax: number;
}

/** 4人・養生なし・機材保険なし・オプションなしの 10:00–12:00 の見積 */
const plainEstimate: Estimate = { subtotalExcludingTax: 10_000, estimateIncludingTax: 11_000 };
/** 6人・養生あり・機材保険あり・オプション2つの 10:00–12:00 の見積 */
const optionsEstimate: Estimate = { subtotalExcludingTax: 15_000, estimateIncludingTax: 16_500 };

function application(
  kind: ApplicationKind,
  start: string,
  end: string,
  content: ReservationChangeContent,
  estimate: Estimate,
): ReservationApplication {
  return {
    kind,
    start: jst(start),
    end: jst(end),
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

// ---- 準備と操作の道具 ----

async function operate(
  operation: ReservationOperationInput,
  now: DateTime = operatedAt,
): Promise<SaveOperationResult> {
  return saveReservationOperation(store, operation, { now, adminUserId });
}

async function operateOk(operation: ReservationOperationInput, now: DateTime = operatedAt) {
  const result = await operate(operation, now);
  if (!result.ok) {
    throw new Error(`成功するはずが不可になった（${operation.kind}、${result.reason}）`);
  }
  return result.drafts;
}

/** 申込して承認する（準備） */
async function applyApproved(
  kind: ApplicationKind,
  content: ReservationChangeContent,
  estimate: Estimate,
  confirmedPrice: number,
): Promise<string> {
  const result = await saveApplication(
    store,
    application(kind, "2026-10-20T10:00", "2026-10-20T12:00", content, estimate),
    { now: appliedAt },
  );
  if (!result.ok) {
    throw new Error(`準備の申込が不可になった（${kind}、${result.reason}）`);
  }
  await operateOk(
    { kind: "approve", reservationId: result.id, confirmedPrice: Yen.parse(confirmedPrice) },
    preparedAt,
  );
  return result.id;
}

/** 本予約 A 10/20 10:00–12:00（4人・養生なし・機材保険なし・オプションなし、確定金額 11,000円） */
async function prepareA(): Promise<string> {
  return applyApproved("firm", plainContent, plainEstimate, 11_000);
}

/** 本予約 Q 10/20 10:00–12:00（6人・養生あり・機材保険あり・オプション workshop と glitter、確定金額 16,500円） */
async function prepareQ(): Promise<string> {
  return applyApproved("firm", optionsContent, optionsEstimate, 16_500);
}

function changeOf(
  toZone: ToZone,
  reservationId: string,
  fields: {
    start?: string;
    end?: string;
    content: ReservationChangeContent;
    confirmedPrice: number;
  },
): ReservationOperationInput {
  return {
    kind: "change",
    reservationId,
    start: toZone(jst(fields.start ?? "2026-10-20T10:00")),
    end: toZone(jst(fields.end ?? "2026-10-20T12:00")),
    content: fields.content,
    confirmedPrice: Yen.parse(fields.confirmedPrice),
    priceTable,
  };
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

/**
 * テーブルの中身が何も変わっていないことを確かめる。日ごとのアイテム（版番号と占有区間）、予約の META（更新日時を含む）、
 * 履歴、下書き、個人情報のどのアイテムも、増えも減りも変わりもしない
 */
async function expectNothingWritten(before: readonly PlainItem[]): Promise<void> {
  expect(sortedItems(await scanAll())).toEqual(sortedItems(before));
}

/** 何もしない変更：成功し、下書きは空で、テーブルの中身は何も変わらない */
async function expectNoOp(operation: ReservationOperationInput, now: DateTime): Promise<void> {
  const before = await scanAll();
  const result = await operate(operation, now);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.ok ? result.drafts : undefined).toEqual([]);
  await expectNothingWritten(before);
}

/**
 * 今までどおりの変更：成功し、下書きは変更の下書き1件（あて先はその予約）で、履歴が1件増える（変更、操作した管理者）。
 * 予約の詳細を返す（変わった欄を確かめるため）
 */
async function expectChanged(
  id: string,
  operation: ReservationOperationInput,
  now: DateTime,
): Promise<NonNullable<Awaited<ReturnType<typeof getReservation>>>> {
  const historyBefore = (await getReservation(store, id))?.history.length ?? 0;
  const drafts = await operateOk(operation, now);
  expect(drafts.map((d) => d.draft)).toEqual([{ kind: "change", reservationId: id }]);
  const detail = await getReservation(store, id);
  if (detail === null || detail === undefined) throw new Error(`変更のあとに ${id} が読めない`);
  expect(detail.history).toHaveLength(historyBefore + 1);
  const entry = detail.history.at(-1);
  expect(entry?.operation).toBe("change");
  expect(entry?.actor).toEqual({ kind: "admin", userId: adminUserId });
  expect(entry?.at.toMillis()).toBe(now.toMillis());
  expect(detail.updatedAt.toMillis()).toBe(now.toMillis());
  return detail;
}

// ---- テスト ----

describe("変更の保存：何もしない変更（日時・人数・ホリゾントの養生・機材保険・オプション・確定金額がすべて今と同じ）", () => {
  for (const [zone, toZone] of zones) {
    const z = `（日時を ${zone} で渡す）`;
    const now = toZone(operatedAt);

    it(`本予約 A 10/20 10:00–12:00（4人・養生なし・機材保険なし・オプションなし、確定金額 11,000円）に、日時・内容・確定金額をすべて今のまま渡す：何もしない（成功、下書きなし）。日ごとのアイテムの版番号と占有区間、予約の META、履歴、下書きのどれも書かれない${z}`, async () => {
      const a = await prepareA();

      await expectNoOp(changeOf(toZone, a, { content: plainContent, confirmedPrice: 11_000 }), now);
    });

    it(`本予約 Q 10/20 10:00–12:00（オプション workshop・glitter）に、オプションを申込と同じ並びで、ほかもすべて今のまま渡す：何もしない。何も書かれない${z}`, async () => {
      const q = await prepareQ();

      await expectNoOp(
        changeOf(toZone, q, { content: optionsContent, confirmedPrice: 16_500 }),
        now,
      );
    });

    it(`本予約 Q 10/20 10:00–12:00（オプション workshop・glitter）に、オプションの並びだけを逆（glitter・workshop）にして、ほかはすべて今のまま渡す：何もしない（並びによらず、同じものを選んでいれば同じ）。何も書かれない${z}`, async () => {
      const q = await prepareQ();

      await expectNoOp(
        changeOf(toZone, q, {
          content: { ...optionsContent, optionIds: ["glitter", "workshop"] },
          confirmedPrice: 16_500,
        }),
        now,
      );
    });

    it(`確定金額が申込のときの見積と違う本予約（見積 11,000円、確定金額 10,000円）に、確定金額 10,000円とほかもすべて今のまま渡す：何もしない（比べるのは今の確定金額）。何も書かれない${z}`, async () => {
      const a = await applyApproved("firm", plainContent, plainEstimate, 10_000);

      await expectNoOp(changeOf(toZone, a, { content: plainContent, confirmedPrice: 10_000 }), now);
    });

    it(`一度変更した本予約 A（10:00–13:00・12人・養生なし・機材保険あり・オプション glitter、確定金額 21,450円）に、変更後と同じ値をもう一度渡す：何もしない（比べるのは申込の値ではなく今の値）。何も書かれない${z}`, async () => {
      const a = await prepareA();
      const changedContent: ReservationChangeContent = {
        partySize: 12,
        cycloramaFloorProtection: false,
        equipmentInsurance: true,
        optionIds: ["glitter"],
      };
      await operateOk(
        changeOf(toZone, a, {
          end: "2026-10-20T13:00",
          content: changedContent,
          confirmedPrice: 21_450,
        }),
        toZone(preparedChangeAt),
      );

      await expectNoOp(
        changeOf(toZone, a, {
          end: "2026-10-20T13:00",
          content: changedContent,
          confirmedPrice: 21_450,
        }),
        now,
      );
    });

    it(`仮予約 P 10/20 10:00–12:00（確定金額 11,000円）に、日時・内容・確定金額をすべて今のまま渡す：何もしない（仮予約でも同じ）。何も書かれない${z}`, async () => {
      const p = await applyApproved("provisional", plainContent, plainEstimate, 11_000);

      await expectNoOp(changeOf(toZone, p, { content: plainContent, confirmedPrice: 11_000 }), now);
    });
  }
});

describe("変更の保存：1つでも違う欄があれば、今までどおり変更になる", () => {
  for (const [zone, toZone] of zones) {
    const z = `（日時を ${zone} で渡す）`;
    const now = toZone(operatedAt);

    it(`本予約 A の確定金額だけを 11,000円から 10,000円に変える：変更になる（変更の下書き、履歴が1件増える）。確定金額は 10,000円、日時と内容はそのまま${z}`, async () => {
      const a = await prepareA();

      const detail = await expectChanged(
        a,
        changeOf(toZone, a, { content: plainContent, confirmedPrice: 10_000 }),
        now,
      );
      expect(detail.confirmedPrice).toBe(10_000);
      expect(detail.start.toMillis()).toBe(jst("2026-10-20T10:00").toMillis());
      expect(detail.end.toMillis()).toBe(jst("2026-10-20T12:00").toMillis());
      expect(detail.partySize).toBe(4);
      const entry = detail.history.at(-1);
      expect(entry?.before?.confirmedPrice).toBe(11_000);
      expect(entry?.after?.confirmedPrice).toBe(10_000);
    });

    it(`本予約 A の人数だけを 4人から 5人に変える：変更になる。人数は 5人${z}`, async () => {
      const a = await prepareA();

      const detail = await expectChanged(
        a,
        changeOf(toZone, a, {
          content: { ...plainContent, partySize: 5 },
          confirmedPrice: 11_000,
        }),
        now,
      );
      expect(detail.partySize).toBe(5);
    });

    it(`本予約 A のホリゾントの養生だけを、なしからありに変える：変更になる。養生はあり${z}`, async () => {
      const a = await prepareA();

      const detail = await expectChanged(
        a,
        changeOf(toZone, a, {
          content: { ...plainContent, cycloramaFloorProtection: true },
          confirmedPrice: 11_000,
        }),
        now,
      );
      expect(detail.cycloramaFloorProtection).toBe(true);
    });

    it(`本予約 A の機材保険だけを、なしからありに変える：変更になる。機材保険はあり${z}`, async () => {
      const a = await prepareA();

      const detail = await expectChanged(
        a,
        changeOf(toZone, a, {
          content: { ...plainContent, equipmentInsurance: true },
          confirmedPrice: 11_000,
        }),
        now,
      );
      expect(detail.equipmentInsurance).toBe(true);
    });

    it(`本予約 A のオプションだけを、なしから glitter に変える：変更になる。オプションは glitter${z}`, async () => {
      const a = await prepareA();

      const detail = await expectChanged(
        a,
        changeOf(toZone, a, {
          content: { ...plainContent, optionIds: ["glitter"] },
          confirmedPrice: 11_000,
        }),
        now,
      );
      expect(detail.optionIds).toEqual(["glitter"]);
    });

    it(`本予約 Q（オプション workshop・glitter）のオプションを glitter だけにする（1つ減らす）：変更になる。オプションは glitter${z}`, async () => {
      const q = await prepareQ();

      const detail = await expectChanged(
        q,
        changeOf(toZone, q, {
          content: { ...optionsContent, optionIds: ["glitter"] },
          confirmedPrice: 16_500,
        }),
        now,
      );
      expect(detail.optionIds).toEqual(["glitter"]);
    });

    it(`本予約 A の終わりだけを 12:00 から 13:00 に変える：変更になる。予約区間は 10:00–13:00${z}`, async () => {
      const a = await prepareA();

      const detail = await expectChanged(
        a,
        changeOf(toZone, a, {
          end: "2026-10-20T13:00",
          content: plainContent,
          confirmedPrice: 11_000,
        }),
        now,
      );
      expect(detail.start.toMillis()).toBe(jst("2026-10-20T10:00").toMillis());
      expect(detail.end.toMillis()).toBe(jst("2026-10-20T13:00").toMillis());
    });

    it(`本予約 A の開始だけを 10:00 から 09:30 に変える：変更になる。予約区間は 09:30–12:00${z}`, async () => {
      const a = await prepareA();

      const detail = await expectChanged(
        a,
        changeOf(toZone, a, {
          start: "2026-10-20T09:30",
          content: plainContent,
          confirmedPrice: 11_000,
        }),
        now,
      );
      expect(detail.start.toMillis()).toBe(jst("2026-10-20T09:30").toMillis());
      expect(detail.end.toMillis()).toBe(jst("2026-10-20T12:00").toMillis());
    });
  }
});
