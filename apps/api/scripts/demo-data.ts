// 手元のデモ用に、架空の予約を、ローカルの DynamoDB のテーブル（pnpm db:table で作ったもの）に入れる。使い方：pnpm db:demo
// 管理画面を触るときに、一覧に予約が並んでいる状態を作るためのもの。
// - 入れ方は本番と同じ流れ：フォームの申込は公開 API の申込の処理（submitApplication。締め切り・見積・受付番号・保存）、
//   承認・取消は操作の保存（saveReservationOperation）、管理者の直接入力は saveDirectEntry、ブロック枠は saveAdminBlock。
//   DynamoDB にアイテムを直接書かない（キー設計 docs/design-docs/dynamodb-keys.md とずれないように）
// - 日付は、動かした日（JST）の翌日から来月の末日までに散らばるように決める。ルール（空き判定、締め切り、警告）で入らなければ、
//   1日ずつ後ろにずらして入れ直す
// - 何度動かしてもよい：テーブルが空のときだけ入れる。空でなければ（前に入れたデモのデータや、手で入れた予約がある）何も入れずに知らせる
// - AWS の DynamoDB には入れない（接続先が手元でなければ止める。local-table.ts と同じ）
// 氏名・連絡先・撮影内容はすべて架空のもの（このリポジトリは公開する）。入れた予約の一覧（架空の氏名を含む）を標準出力に出すのは、
// 手元のデモのためだけ（API とは別。INV-10 のログの決まりの対象外）
import {
  DescribeTableCommand,
  type DynamoDBClient,
  ResourceNotFoundException,
  ScanCommand,
} from "@aws-sdk/client-dynamodb";
import {
  calculatePriceFromTable,
  checkAdminDuration,
  currentPriceTable,
  decidePlanId,
} from "@zebra/booking-core";
import type { ApplicationRequest, PriceTable, ReservationStatus } from "@zebra/contracts";
import { DateTime } from "luxon";
import { getBlock, saveAdminBlock } from "../src/db/blocks.ts";
import { createDynamoClient } from "../src/db/client.ts";
import { type DirectEntryKind, saveDirectEntry } from "../src/db/direct-entry.ts";
import { saveReservationOperation } from "../src/db/operations.ts";
import {
  type ReservationStore,
  type StoredCustomerInfo,
  type StoredShootingInfo,
  JST,
  findReservationIdByReceiptNumber,
  getReservation,
} from "../src/db/reservations.ts";
import { submitApplication } from "../src/public/applications.ts";
import {
  DEFAULT_LOCAL_ENDPOINT,
  DEFAULT_LOCAL_TABLE_NAME,
  isLocalEndpoint,
} from "./local-table.ts";

/** 直接入力・承認・取消の履歴の「誰が」に使う管理者の id の既定（README の DEV_ADMIN_USER_ID の例と同じ） */
export const DEFAULT_DEMO_ADMIN_USER_ID = "dev-admin";

/** ルールで入らなかったときに、後ろにずらす日数の上限 */
const MAX_SHIFT_DAYS = 31;

/** 入れた予約・ブロック枠の1行（標準出力の一覧に出すもの） */
export interface DemoRow {
  kind: "reservation" | "block";
  id: string;
  /** 予約区間（ブロック枠はその区間）。バッファを含まない */
  start: DateTime;
  end: DateTime;
  /** 予約の状態（ブロック枠にはない） */
  status?: ReservationStatus;
  /** 予約の経路（form＝フォームの申込、admin＝管理者の直接入力） */
  route?: "form" | "admin";
  /** 予約の氏名（架空のもの） */
  customerName?: string;
  /** フォームの申込だけが持つ */
  receiptNumber?: string;
  /** 第二キープ（承認待ちを含む）だけが持つ。付く仮予約の id */
  provisionalIds?: readonly string[];
  /** ブロック枠の理由のメモ */
  memo?: string;
}

export type DemoResult =
  | { kind: "not-local"; endpoint: string }
  | { kind: "no-table"; tableName: string }
  | { kind: "not-empty"; tableName: string }
  | { kind: "inserted"; rows: DemoRow[] };

export interface DemoOptions {
  endpoint: string;
  tableName: string;
  /** 現在時刻（INV-7）。申込の締め切りの判定と、作成日時・履歴の日時に使う */
  now: DateTime;
  /** 直接入力・承認・取消の履歴の「誰が」 */
  adminUserId: string;
}

/**
 * デモのデータを入れる。接続先が手元でなければ、接続せずに not-local。テーブルがなければ no-table。
 * テーブルにアイテムが1つでもあれば、何も入れずに not-empty
 */
export async function insertDemoData(options: DemoOptions): Promise<DemoResult> {
  if (!isLocalEndpoint(options.endpoint)) return { kind: "not-local", endpoint: options.endpoint };
  if (!options.now.isValid) throw new RangeError("現在時刻が不正");

  const client = createDynamoClient({ endpoint: options.endpoint, region: "ap-northeast-1" });
  const store: ReservationStore = { client, tableName: options.tableName };
  if (!(await tableExists(client, options.tableName))) {
    return { kind: "no-table", tableName: options.tableName };
  }
  if (!(await tableIsEmpty(client, options.tableName))) {
    return { kind: "not-empty", tableName: options.tableName };
  }

  const placer = new DemoPlacer(store, options.now, options.adminUserId, currentPriceTable());
  for (const group of DEMO_GROUPS) await placer.place(group);
  return { kind: "inserted", rows: await placer.readBack() };
}

async function tableExists(client: DynamoDBClient, tableName: string): Promise<boolean> {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return true;
  } catch (error) {
    if (error instanceof ResourceNotFoundException) return false;
    throw error;
  }
}

/** テーブルが空か（読むだけ。書かない） */
async function tableIsEmpty(client: DynamoDBClient, tableName: string): Promise<boolean> {
  const res = await client.send(
    new ScanCommand({ TableName: tableName, Limit: 1, ProjectionExpression: "pk" }),
  );
  return (res.Items ?? []).length === 0 && res.LastEvaluatedKey === undefined;
}

// ---- デモのデータの中身 ----

/** 予約区間：その日（JST）の開始時刻と長さ（時間）。日をまたいでもよい */
interface TimeSpec {
  startTime: `${number}:${"00" | "30"}`;
  hours: number;
}

/** フォームの申込（公開 API の申込と同じ処理で入れる）。then は申込のあとに続けて行う管理者の操作 */
interface FormItem extends TimeSpec {
  route: "form";
  kind: ApplicationRequest["kind"];
  partySize: number;
  cycloramaFloorProtection: boolean;
  equipmentInsurance: boolean;
  optionIds: string[];
  customer: ApplicationRequest["customer"];
  shooting: ApplicationRequest["shooting"];
  then: ("approve" | "cancel")[];
}

/** 管理者の直接入力（警告が出るものは入れずに、日をずらす） */
interface DirectItem extends TimeSpec {
  route: "admin";
  kind: DirectEntryKind;
  partySize: number;
  cycloramaFloorProtection: boolean;
  equipmentInsurance: boolean;
  optionIds: string[];
  customer: StoredCustomerInfo;
  shooting: StoredShootingInfo;
}

/** 管理者が入れるブロック枠 */
interface BlockItem extends TimeSpec {
  route: "block";
  bufferMinutes: 0 | 30 | 60;
  memo: string;
}

type DemoItem = FormItem | DirectItem | BlockItem;

/**
 * 同じ日に入れるもののまとまり。先頭を入れる日を決め（ルールで入らなければ後ろにずらす）、残り（第二キープ）を同じ日に入れる。
 * position は、翌日から来月の末日までのどのあたりに置くか（0＝翌日、1＝来月の末日）
 */
interface DemoGroup {
  position: number;
  items: [DemoItem, ...DemoItem[]];
}

/** 架空のお客様（フォームの申込の全部の欄） */
function fictionalCustomer(
  name: string,
  n: string,
  extra: { companyName?: string } = {},
): ApplicationRequest["customer"] {
  return {
    name,
    ...extra,
    email: `demo${n}@example.com`,
    phone: `090-0000-00${n}`,
    address: `東京都架空区架空町${n}-${n}`,
    photographerName: `架空 撮影${n}`,
  };
}

/** デモのデータ。氏名・連絡先・撮影内容はすべて架空のもの */
export const DEMO_GROUPS: readonly DemoGroup[] = [
  {
    position: 0,
    items: [
      {
        route: "form",
        kind: "firm",
        startTime: "13:00",
        hours: 3,
        partySize: 3,
        cycloramaFloorProtection: false,
        equipmentInsurance: false,
        optionIds: [],
        customer: fictionalCustomer("架空 一郎", "01"),
        shooting: { types: ["still"], details: "架空の商品の物撮り（デモ）" },
        then: [],
      },
    ],
  },
  {
    position: 0.08,
    items: [
      {
        route: "form",
        kind: "firm",
        startTime: "10:00",
        hours: 3,
        partySize: 4,
        cycloramaFloorProtection: false,
        equipmentInsurance: true,
        optionIds: [],
        customer: fictionalCustomer("架空 花子", "02"),
        shooting: { types: ["still"], details: "架空のアーティスト写真（デモ）" },
        then: ["approve"],
      },
    ],
  },
  {
    position: 0.15,
    items: [
      {
        // 電話で受けた予約（連絡先は電話番号だけ）
        route: "admin",
        kind: "firm",
        startTime: "09:00",
        hours: 3,
        partySize: 2,
        cycloramaFloorProtection: false,
        equipmentInsurance: false,
        optionIds: [],
        customer: { name: "架空 次郎", phone: "090-0000-0003" },
        shooting: {},
      },
    ],
  },
  {
    position: 0.22,
    items: [
      {
        // 承認したあとに取消した予約（一覧には出ない。取消の下書きができる）
        route: "form",
        kind: "firm",
        startTime: "14:00",
        hours: 4,
        partySize: 5,
        cycloramaFloorProtection: false,
        equipmentInsurance: false,
        optionIds: [],
        customer: fictionalCustomer("架空 三郎", "04"),
        shooting: { types: ["movie"], details: "架空のミュージックビデオ（デモ）" },
        then: ["approve", "cancel"],
      },
    ],
  },
  {
    position: 0.3,
    items: [
      {
        // 仮予約（承認済み）。下の第二キープが付く
        route: "form",
        kind: "provisional",
        startTime: "13:00",
        hours: 4,
        partySize: 6,
        cycloramaFloorProtection: false,
        equipmentInsurance: false,
        optionIds: [],
        customer: fictionalCustomer("架空 桜", "05"),
        shooting: { types: ["still"], details: "架空のファッション撮影（デモ）" },
        then: ["approve"],
      },
      {
        // 上の仮予約に付く第二キープ（承認済み）。占有区間 15:00–20:00 が仮予約の 13:00–18:00 と重なる
        route: "form",
        kind: "second-hold",
        startTime: "15:00",
        hours: 4,
        partySize: 3,
        cycloramaFloorProtection: false,
        equipmentInsurance: false,
        optionIds: [],
        customer: fictionalCustomer("架空 菫", "06"),
        shooting: { types: ["still", "movie"], details: "架空のウェブ広告（デモ）" },
        then: ["approve"],
      },
    ],
  },
  {
    position: 0.4,
    items: [
      {
        // 深夜帯にかかる予約（直接入力。深夜帯にかかるので4時間以上にする）
        route: "admin",
        kind: "firm",
        startTime: "03:00",
        hours: 5,
        partySize: 4,
        cycloramaFloorProtection: false,
        equipmentInsurance: false,
        optionIds: [],
        customer: {
          name: "架空 夜一",
          email: "demo07@example.com",
          phone: "090-0000-0007",
        },
        shooting: { types: ["movie"], details: "架空の夜明けのシーン（デモ）" },
      },
    ],
  },
  {
    position: 0.5,
    items: [
      { route: "block", startTime: "00:00", hours: 24, bufferMinutes: 0, memo: "臨時休業（デモ）" },
    ],
  },
  {
    position: 0.58,
    items: [
      {
        route: "form",
        kind: "provisional",
        startTime: "10:00",
        hours: 4,
        partySize: 2,
        cycloramaFloorProtection: false,
        equipmentInsurance: false,
        optionIds: [],
        customer: fictionalCustomer("架空 梅子", "08"),
        shooting: {
          types: ["still"],
          details: "架空の家族写真（デモ）",
          notes: "ベビーカーで来ます",
        },
        then: [],
      },
    ],
  },
  {
    position: 0.66,
    items: [
      {
        // 仮予約（直接入力）。下の承認待ちの第二キープが付く
        route: "admin",
        kind: "provisional",
        startTime: "12:00",
        hours: 4,
        partySize: 8,
        cycloramaFloorProtection: false,
        equipmentInsurance: false,
        optionIds: [],
        customer: {
          name: "架空 竹子",
          companyName: "架空スタジオ合同会社",
          email: "demo09@example.com",
        },
        shooting: { types: ["still"] },
      },
      {
        // 上の仮予約に付く、承認待ちの第二キープ。占有区間 14:00–19:00 が仮予約の 12:00–17:00 と重なる
        route: "form",
        kind: "second-hold",
        startTime: "14:00",
        hours: 4,
        partySize: 4,
        cycloramaFloorProtection: false,
        equipmentInsurance: false,
        optionIds: [],
        customer: fictionalCustomer("架空 松子", "10"),
        shooting: { types: ["movie"], details: "架空のインタビュー動画（デモ）" },
        then: [],
      },
    ],
  },
  {
    position: 0.75,
    items: [
      {
        // 日をまたぐ予約（20:00–翌1:00。深夜帯にもかかる）。11人でホリゾントの養生なしなのでプランB
        route: "form",
        kind: "firm",
        startTime: "20:00",
        hours: 5,
        partySize: 11,
        cycloramaFloorProtection: false,
        equipmentInsurance: false,
        optionIds: ["glitter"],
        customer: fictionalCustomer("架空 星子", "11"),
        shooting: {
          types: ["still", "music"],
          details: "架空のバンドの撮影（デモ）",
          notes: "アコースティックギターを持ち込みます",
        },
        then: ["approve"],
      },
    ],
  },
  {
    position: 0.85,
    items: [
      {
        route: "form",
        kind: "firm",
        startTime: "10:00",
        hours: 5,
        partySize: 8,
        cycloramaFloorProtection: true,
        equipmentInsurance: true,
        optionIds: ["workshop"],
        customer: fictionalCustomer("架空 太郎", "12", { companyName: "架空映像株式会社" }),
        shooting: { types: ["still"], details: "架空の撮影ワークショップ（デモ）" },
        then: [],
      },
    ],
  },
  {
    position: 0.95,
    items: [
      {
        // メールで受けた予約（直接入力）
        route: "admin",
        kind: "firm",
        startTime: "15:00",
        hours: 4,
        partySize: 3,
        cycloramaFloorProtection: false,
        equipmentInsurance: false,
        optionIds: [],
        customer: {
          name: "架空 美咲",
          email: "demo13@example.com",
          phone: "090-0000-0013",
          address: "東京都架空区架空町13-13",
          photographerName: "架空 撮影13",
        },
        shooting: { types: ["still"], details: "架空の雑誌の撮影（デモ）" },
      },
    ],
  },
];

// ---- 入れる処理 ----

/** 入れた結果。shift＝ルールで入らなかったので日をずらす。ほかの理由はデモのデータの誤りなので、エラーにする */
type PlaceResult =
  { ok: true; id: string; kind: "reservation" | "block" } | { ok: false; shift: true };

/** 後ろにずらせば入るかもしれない理由（空き判定、締め切り、警告） */
const SHIFTABLE_REASONS = new Set<string>([
  "overlaps-existing",
  "past-24-hours-before-start",
  "past-provisional-deadline",
  "unacknowledged-warnings",
]);

class DemoPlacer {
  private readonly usedDays = new Set<string>();
  private readonly placed: { id: string; kind: "reservation" | "block" }[] = [];

  private readonly store: ReservationStore;
  private readonly now: DateTime;
  private readonly adminUserId: string;
  private readonly priceTable: PriceTable;

  constructor(store: ReservationStore, now: DateTime, adminUserId: string, priceTable: PriceTable) {
    this.store = store;
    this.now = now;
    this.adminUserId = adminUserId;
    this.priceTable = priceTable;
  }

  /** まとまりを入れる。先頭が入る日を探し、残りを同じ日に入れる */
  async place(group: DemoGroup): Promise<void> {
    const [first, ...rest] = group.items;
    let day = this.preferredDay(group.position);
    for (let shift = 0; ; shift++) {
      if (shift > MAX_SHIFT_DAYS) {
        throw new Error(`デモのデータを入れられる日が、${MAX_SHIFT_DAYS}日ずらしても見つからない`);
      }
      if (this.daysOf(first, day).some((d) => this.usedDays.has(d))) {
        day = day.plus({ days: 1 });
        continue;
      }
      const result = await this.placeItem(first, day);
      if (result.ok) {
        this.placed.push(result);
        break;
      }
      day = day.plus({ days: 1 });
    }
    for (const item of rest) {
      const result = await this.placeItem(item, day);
      if (!result.ok)
        throw new Error(`デモのデータ（同じ日に入れる第二キープ）が入らない：${day.toISODate()}`);
      this.placed.push(result);
    }
    for (const item of group.items) for (const d of this.daysOf(item, day)) this.usedDays.add(d);
  }

  /** 入れたものを読み直して、一覧の行にする（開始の早い順） */
  async readBack(): Promise<DemoRow[]> {
    const rows: DemoRow[] = [];
    for (const { id, kind } of this.placed) {
      if (kind === "block") {
        const block = await getBlock(this.store, id);
        if (block === null) throw new Error("入れたブロック枠が読めない");
        rows.push({
          kind,
          id,
          start: block.start,
          end: block.end,
          ...(block.memo === undefined ? {} : { memo: block.memo }),
        });
        continue;
      }
      const detail = await getReservation(this.store, id);
      if (detail === null) throw new Error("入れた予約が読めない");
      rows.push({
        kind,
        id,
        start: detail.start,
        end: detail.end,
        status: detail.status,
        route: detail.route,
        customerName: detail.customer.name,
        ...(detail.receiptNumber === undefined ? {} : { receiptNumber: detail.receiptNumber }),
        ...(detail.provisionalIds === undefined ? {} : { provisionalIds: detail.provisionalIds }),
      });
    }
    return rows.sort((a, b) => a.start.toMillis() - b.start.toMillis());
  }

  /** 翌日（JST）から来月の末日までのうち、position の位置の日（JST の 0:00） */
  private preferredDay(position: number): DateTime {
    const today = this.now.setZone(JST).startOf("day");
    const first = today.plus({ days: 1 });
    const last = today.plus({ months: 1 }).endOf("month").startOf("day");
    const span = Math.max(0, last.diff(first, "days").days);
    return first.plus({ days: Math.round(position * span) });
  }

  /** 占有区間（バッファは多めに1時間とみる）がかかる JST の日 */
  private daysOf(item: DemoItem, day: DateTime): string[] {
    const { start, end } = rangeOn(item, day);
    const days: string[] = [];
    for (let d = start.startOf("day"); d < end.plus({ hours: 1 }); d = d.plus({ days: 1 })) {
      days.push(d.toISODate() ?? "");
    }
    return days;
  }

  private async placeItem(item: DemoItem, day: DateTime): Promise<PlaceResult> {
    switch (item.route) {
      case "form":
        return this.placeForm(item, day);
      case "admin":
        return this.placeDirect(item, day);
      case "block":
        return this.placeBlock(item, day);
    }
  }

  /** フォームの申込：公開 API の申込の処理（パース・締め切り・見積・受付番号・保存）で入れ、続けて管理者の操作をする */
  private async placeForm(item: FormItem, day: DateTime): Promise<PlaceResult> {
    const { start, end } = rangeOn(item, day);
    const body: ApplicationRequest = {
      kind: item.kind,
      start: start.toISO() ?? "",
      end: end.toISO() ?? "",
      partySize: item.partySize,
      cycloramaFloorProtection: item.cycloramaFloorProtection,
      equipmentInsurance: item.equipmentInsurance,
      optionIds: item.optionIds,
      customer: item.customer,
      shooting: item.shooting,
      agreedToCycloramaRules: true,
      agreedToTerms: true,
    };
    const applied = await submitApplication(
      { store: this.store, now: () => this.now, priceTable: this.priceTable },
      body,
    );
    if (!applied.ok) return this.failed("申込", applied.reason);

    const id = await findReservationIdByReceiptNumber(this.store, applied.accepted.receiptNumber);
    if (id === null) throw new Error("受付番号から予約が見つからない");
    for (const operation of item.then) {
      const result = await saveReservationOperation(
        this.store,
        operation === "approve"
          ? {
              kind: "approve",
              reservationId: id,
              // 確定金額は、申込のときの見積どおり
              confirmedPrice: applied.accepted.estimateIncludingTax,
            }
          : { kind: "cancel", reservationId: id },
        { now: this.now, adminUserId: this.adminUserId },
      );
      if (!result.ok)
        throw new Error(`デモのデータの操作（${operation}）ができない：${result.reason}`);
    }
    return { ok: true, id, kind: "reservation" };
  }

  /** 管理者の直接入力：見積とプランは管理 API と同じく料金表で決め、確定金額は見積どおり。警告は確認しない（出たら日をずらす） */
  private async placeDirect(item: DirectItem, day: DateTime): Promise<PlaceResult> {
    const { start, end } = rangeOn(item, day);
    const duration = checkAdminDuration(start, end);
    if (!duration.ok) throw new Error(`デモのデータの時間が決まりに合わない：${duration.reason}`);
    const planId = decidePlanId(this.priceTable, {
      partySize: item.partySize,
      cycloramaFloorProtection: item.cycloramaFloorProtection,
    });
    const estimate = calculatePriceFromTable(this.priceTable, {
      planId,
      start,
      end,
      equipmentInsurance: item.equipmentInsurance,
      optionIds: item.optionIds,
    });
    const result = await saveDirectEntry(
      this.store,
      {
        kind: item.kind,
        start,
        end,
        partySize: item.partySize,
        cycloramaFloorProtection: item.cycloramaFloorProtection,
        planId,
        equipmentInsurance: item.equipmentInsurance,
        optionIds: item.optionIds,
        estimate,
        confirmedPrice: estimate.estimateIncludingTax,
        customer: item.customer,
        shooting: item.shooting,
      },
      { now: this.now, adminUserId: this.adminUserId, acknowledgedWarnings: [] },
    );
    if (!result.ok) return this.failed("直接入力", result.reason);
    return { ok: true, id: result.id, kind: "reservation" };
  }

  private async placeBlock(item: BlockItem, day: DateTime): Promise<PlaceResult> {
    const { start, end } = rangeOn(item, day);
    const result = await saveAdminBlock(this.store, {
      start,
      end,
      bufferMinutes: item.bufferMinutes,
      memo: item.memo,
    });
    if (!result.ok) return this.failed("ブロック枠", result.reason);
    return { ok: true, id: result.id, kind: "block" };
  }

  private failed(what: string, reason: string): PlaceResult {
    if (SHIFTABLE_REASONS.has(reason)) return { ok: false, shift: true };
    throw new Error(`デモのデータ（${what}）が入らない：${reason}`);
  }
}

/** その日（JST の 0:00）の予約区間 */
function rangeOn(item: TimeSpec, day: DateTime): { start: DateTime; end: DateTime } {
  const [hour, minute] = item.startTime.split(":").map(Number);
  const start = day.setZone(JST).set({ hour, minute, second: 0, millisecond: 0 });
  return { start, end: start.plus({ hours: item.hours }) };
}

// ---- 表示 ----

const STATUS_LABELS: Record<ReservationStatus, string> = {
  "pending-provisional": "承認待ち（仮）",
  "pending-firm": "承認待ち（本）",
  "pending-second-hold": "承認待ち（第二キープ）",
  provisional: "仮予約",
  firm: "本予約",
  "second-hold": "第二キープ",
  cancelled: "取消",
  ended: "終了",
};

/** 一覧の1行（JST で表示する。INV-7） */
export function formatRow(row: DemoRow): string {
  const start = row.start.setZone(JST);
  const end = row.end.setZone(JST);
  const endText = end.hasSame(start, "day") ? end.toFormat("HH:mm") : end.toFormat("M/d HH:mm");
  const when = `${start.toFormat("yyyy-MM-dd (ccc) HH:mm", { locale: "ja" })}–${endText}`;
  if (row.kind === "block") return `${when}  ブロック枠  ${row.memo ?? ""}`;
  const status = row.status === undefined ? "" : STATUS_LABELS[row.status];
  const route = row.route === "admin" ? "直接入力" : `フォーム 受付番号 ${row.receiptNumber ?? ""}`;
  return `${when}  ${status}  ${row.customerName ?? ""}  ${route}`;
}

/**
 * 現在時刻（INV-7）。apps/api の app.ts と同じく、このスクリプトで現在時刻を取る所をこの1か所に決める
 * （packages/clock ができたら置き換える。lint が止める new Date()・Date.now() は使わない）
 */
const now = (): DateTime => DateTime.now();

/** 環境変数 DYNAMODB_ENDPOINT・DYNAMODB_TABLE_NAME・DEV_ADMIN_USER_ID（pnpm dev:api と同じ）を読み、省略なら既定の値を使う */
async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const endpoint = env["DYNAMODB_ENDPOINT"] || DEFAULT_LOCAL_ENDPOINT;
  const tableName = env["DYNAMODB_TABLE_NAME"] || DEFAULT_LOCAL_TABLE_NAME;
  const adminUserId = env["DEV_ADMIN_USER_ID"] || DEFAULT_DEMO_ADMIN_USER_ID;
  const result = await insertDemoData({ endpoint, tableName, now: now(), adminUserId });
  switch (result.kind) {
    case "not-local":
      console.error(`接続先 ${endpoint} は手元の DynamoDB ではないので、デモのデータを入れない`);
      process.exit(1);
      break;
    case "no-table":
      console.error(`テーブル ${tableName} がない（${endpoint}）。先に pnpm db:table を動かす`);
      process.exit(1);
      break;
    case "not-empty":
      console.log(
        `テーブル ${tableName} は空でないので、デモのデータを入れなかった（${endpoint}）。` +
          "入れ直すときは、別のテーブルの名前（DYNAMODB_TABLE_NAME）で pnpm db:table からやり直すか、" +
          "pnpm db:down → pnpm db:up → pnpm db:table のあとに動かす",
      );
      break;
    case "inserted":
      console.log(
        `テーブル ${tableName} に、デモのデータを ${result.rows.length} 件入れた（${endpoint}）`,
      );
      for (const row of result.rows) console.log(`  ${formatRow(row)}`);
      break;
  }
}

if (import.meta.main) {
  await main(process.env);
}
