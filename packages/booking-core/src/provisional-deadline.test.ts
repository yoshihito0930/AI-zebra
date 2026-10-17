import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { provisionalDeadline } from "./provisional-deadline";

// 仕様の日時は JST で書かれている（INV-7）。例には年がないので 2026 年とする
function jst(iso: string): DateTime {
  const dateTime = DateTime.fromISO(iso, { zone: "Asia/Tokyo" });
  if (!dateTime.isValid) {
    throw new Error(`テストの日時が不正：${iso}`);
  }
  return dateTime;
}

// 返す DateTime のゾーンは決めていないので、時点（UTC からのミリ秒）で比べる
function deadlineOf(start: string): number {
  return provisionalDeadline(jst(start)).toMillis();
}

// 同じ時点を UTC のゾーンで表した開始日時で求める（INV-7。docs/TESTING.md「仕様の例とテストの対応づけ」）
function deadlineOfUtc(start: string): number {
  return provisionalDeadline(jst(start).toUTC()).toMillis();
}

// 「申込の締め切り」の例の文のうち、仮予約の期限の部分。
// 24時間前の部分（10/19 15:00）は、application-deadline.test.ts の表の行で確かめる
describe("申込の締め切り", () => {
  it("開始が 10/20 15:00 の場合、仮予約の期限は 10/13 18:00", () => {
    expect(deadlineOf("2026-10-20T15:00")).toBe(jst("2026-10-13T18:00").toMillis());
  });

  // UTC では開始が 10/20 15:30 になる。利用日を UTC の日付で取ると 10/20 になり、期限が 10/13 18:00 にずれる
  it("開始が 10/21 00:30 の場合（利用日は10/21）、仮予約の期限は 10/14 18:00", () => {
    expect(deadlineOf("2026-10-21T00:30")).toBe(jst("2026-10-14T18:00").toMillis());
  });

  // 上の各例を、同じ時点の UTC で渡す。期待値は例のまま
  describe("UTC で渡しても同じ結果（INV-7）", () => {
    it("開始が 10/20 15:00 の場合、仮予約の期限は 10/13 18:00", () => {
      expect(deadlineOfUtc("2026-10-20T15:00")).toBe(jst("2026-10-13T18:00").toMillis());
    });

    // UTC では開始が 10/20 15:30。入力のゾーンの日付をそのまま使うと、期限が 10/13 18:00 にずれる
    it("開始が 10/21 00:30 の場合（利用日は10/21）、仮予約の期限は 10/14 18:00", () => {
      expect(deadlineOfUtc("2026-10-21T00:30")).toBe(jst("2026-10-14T18:00").toMillis());
    });
  });
});
