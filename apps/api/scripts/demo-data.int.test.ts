import { type AttributeValue, DeleteTableCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { DateTime } from "luxon";
import { afterEach, describe, expect, it } from "vitest";
import { listAdminReservationsInPeriod } from "../src/db/admin-list.ts";
import { createLocalDynamoClient } from "../src/db/client.ts";
import { getReservation } from "../src/db/reservations.ts";
import { type DemoResult, type DemoRow, insertDemoData } from "./demo-data.ts";
import { createLocalTable } from "./local-table.ts";

const client = createLocalDynamoClient();
const endpoint = process.env["DYNAMODB_ENDPOINT"] ?? "http://127.0.0.1:8000";
const created: string[] = [];

// デモのデータを一通り入れるテストは書き込みが多い（トランザクションが25回ほど）。
// 統合テストを並べて動かすと既定の15秒を超えることがあるので、長めにする
const INSERT_TIMEOUT_MS = 60_000;

afterEach(async () => {
  for (const tableName of created.splice(0)) {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  }
});

async function newTable(): Promise<string> {
  const tableName = `int-test-demo-data-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  await createLocalTable(client, tableName);
  created.push(tableName);
  return tableName;
}

async function itemCount(tableName: string): Promise<number> {
  let count = 0;
  let startKey: Record<string, AttributeValue> | undefined;
  do {
    const res = await client.send(
      new ScanCommand({ TableName: tableName, Select: "COUNT", ExclusiveStartKey: startKey }),
    );
    count += res.Count ?? 0;
    startKey = res.LastEvaluatedKey;
  } while (startKey !== undefined);
  return count;
}

function rowsOf(result: DemoResult): DemoRow[] {
  if (result.kind !== "inserted") throw new Error(`入らなかった：${result.kind}`);
  return result.rows;
}

const jst = (iso: string) => DateTime.fromISO(iso, { zone: "Asia/Tokyo" });

function insert(tableName: string, now: DateTime) {
  return insertDemoData({ endpoint, tableName, now, adminUserId: "dev-admin" });
}

describe("デモのデータを入れるスクリプト", () => {
  it.each([
    ["月の半ば", "2026-11-15T10:00"],
    // 翌日の予約が24時間前を過ぎ、仮予約の期限も近い。今月は1日しか残っていない
    ["月末の夜遅く", "2026-11-30T23:30"],
  ])(
    "%s（%s JST）に動かすと、承認待ち・仮予約・本予約・第二キープ・取消・ブロック枠が一通り入る",
    async (_, nowIso) => {
      const tableName = await newTable();
      const now = jst(nowIso);
      const rows = rowsOf(await insert(tableName, now));

      const reservations = rows.filter((row) => row.kind === "reservation");
      const statuses = reservations.map((row) => row.status).sort();
      expect(statuses).toEqual(
        [
          "cancelled",
          "firm",
          "firm",
          "firm",
          "firm",
          "firm",
          "pending-firm",
          "pending-firm",
          "pending-provisional",
          "pending-second-hold",
          "provisional",
          "provisional",
          "second-hold",
        ].sort(),
      );
      expect(rows.filter((row) => row.kind === "block")).toHaveLength(1);

      // フォームの申込は受付番号つき、直接入力は受付番号なし。両方ある
      for (const row of reservations) {
        expect(row.receiptNumber !== undefined).toBe(row.route === "form");
      }
      expect(reservations.some((row) => row.route === "form")).toBe(true);
      expect(reservations.some((row) => row.route === "admin")).toBe(true);

      // 第二キープ（承認済み・承認待ち）は、どちらも承認済みの仮予約に付いている
      const provisionalIds = new Set(
        reservations.filter((row) => row.status === "provisional").map((row) => row.id),
      );
      for (const row of reservations.filter(
        (r) => r.status === "second-hold" || r.status === "pending-second-hold",
      )) {
        expect(row.provisionalIds?.length).toBe(1);
        expect(provisionalIds.has(row.provisionalIds?.[0] ?? "")).toBe(true);
      }

      // 深夜帯（23:00〜翌8:00）にかかり日をまたがない予約と、日をまたぐ予約がある
      const inJst = reservations.map((row) => ({
        start: row.start.setZone("Asia/Tokyo"),
        end: row.end.setZone("Asia/Tokyo"),
      }));
      expect(inJst.some(({ start, end }) => start.hasSame(end, "day") && start.hour < 8)).toBe(
        true,
      );
      expect(inJst.some(({ start, end }) => !start.hasSame(end, "day"))).toBe(true);

      // すべて動かした日より後で、来月の末日までに入る。今月にも来月にも入る（今月が翌日しか残っていなくても、翌日以降に入る）
      const today = now.startOf("day");
      const lastDay = today.plus({ months: 1 }).endOf("month");
      for (const row of rows) {
        expect(row.start > now).toBe(true);
        expect(row.start <= lastDay).toBe(true);
      }
      expect(
        rows.some(
          (row) => row.start.setZone("Asia/Tokyo").month === today.plus({ months: 1 }).month,
        ),
      ).toBe(true);

      // 管理画面の一覧（期間）に、取消のほかの予約とブロック枠が並ぶ
      const list = await listAdminReservationsInPeriod(
        { client, tableName },
        { from: today.toISODate() ?? "", to: lastDay.toISODate() ?? "" },
      );
      expect(list.reservations).toHaveLength(reservations.length - 1);
      expect(list.blocks).toHaveLength(1);

      // 本番と同じ流れで入っている：承認した予約には承認の履歴と確定金額があり、取消した予約には取消の履歴がある
      const cancelled = reservations.find((row) => row.status === "cancelled");
      const detail = await getReservation({ client, tableName }, cancelled?.id ?? "");
      expect(detail?.history.map((entry) => entry.operation)).toEqual([
        "apply",
        "approve",
        "cancel",
      ]);
    },
    INSERT_TIMEOUT_MS,
  );

  it(
    "2回目は何も入れず、not-empty を返す（テーブルが空のときだけ入れる）",
    async () => {
      const tableName = await newTable();
      const now = jst("2026-11-15T10:00");
      expect((await insert(tableName, now)).kind).toBe("inserted");
      const before = await itemCount(tableName);
      expect(before).toBeGreaterThan(0);

      expect(await insert(tableName, now)).toEqual({ kind: "not-empty", tableName });
      expect(await itemCount(tableName)).toBe(before);
    },
    INSERT_TIMEOUT_MS,
  );

  it("テーブルがなければ、何も入れず no-table を返す", async () => {
    const tableName = `int-test-demo-data-missing-${process.pid}`;
    expect(await insert(tableName, jst("2026-11-15T10:00"))).toEqual({
      kind: "no-table",
      tableName,
    });
  });

  it.each(["https://dynamodb.ap-northeast-1.amazonaws.com", "not a url"])(
    "接続先 %s は手元でないので、接続せずに not-local を返す",
    async (remote) => {
      const tableName = await newTable();
      expect(
        await insertDemoData({
          endpoint: remote,
          tableName,
          now: jst("2026-11-15T10:00"),
          adminUserId: "dev-admin",
        }),
      ).toEqual({ kind: "not-local", endpoint: remote });
      expect(await itemCount(tableName)).toBe(0);
    },
  );
});
