import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { checkApplicationDeadline } from "./application-deadline";

// 仕様の日時は JST で書かれている（INV-7）。例の表には年がないので 2026 年とする
function jst(iso: string): DateTime {
  const dateTime = DateTime.fromISO(iso, { zone: "Asia/Tokyo" });
  if (!dateTime.isValid) {
    throw new Error(`テストの日時が不正：${iso}`);
  }
  return dateTime;
}

// 申込日時は引数で渡す（現在時刻を固定する。INV-7）
function check(kind: "firm" | "provisional", start: string, appliedAt: string) {
  return checkApplicationDeadline({ kind, start: jst(start), appliedAt: jst(appliedAt) });
}

// 本予約申込には「開始の24時間前」、仮予約申込には「仮予約の期限」のルールしかないので、
// 表で理由が書かれていない「不可」も、申込の種類ごとに理由が1つに決まる
describe("申込の締め切り", () => {
  describe("開始が 10/20 15:00 の場合、仮予約の期限は 10/13 18:00、24時間前は 10/19 15:00。", () => {
    const start = "2026-10-20T15:00";

    it("開始 10/20 15:00、申込 10/13 17:59：本予約申込は受付、仮予約申込は受付", () => {
      expect(check("firm", start, "2026-10-13T17:59")).toEqual({ ok: true });
      expect(check("provisional", start, "2026-10-13T17:59")).toEqual({ ok: true });
    });

    it("開始 10/20 15:00、申込 10/13 18:00：本予約申込は受付、仮予約申込は不可（期限を過ぎた）", () => {
      expect(check("firm", start, "2026-10-13T18:00")).toEqual({ ok: true });
      expect(check("provisional", start, "2026-10-13T18:00")).toEqual({
        ok: false,
        reason: "past-provisional-deadline",
      });
    });

    it("開始 10/20 15:00、申込 10/19 14:59：本予約申込は受付、仮予約申込は不可", () => {
      expect(check("firm", start, "2026-10-19T14:59")).toEqual({ ok: true });
      expect(check("provisional", start, "2026-10-19T14:59")).toEqual({
        ok: false,
        reason: "past-provisional-deadline",
      });
    });

    it("開始 10/20 15:00、申込 10/19 15:00：本予約申込は不可（ちょうど24時間前）、仮予約申込は不可", () => {
      expect(check("firm", start, "2026-10-19T15:00")).toEqual({
        ok: false,
        reason: "past-24-hours-before-start",
      });
      expect(check("provisional", start, "2026-10-19T15:00")).toEqual({
        ok: false,
        reason: "past-provisional-deadline",
      });
    });
  });
});
