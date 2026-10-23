import fc from "fast-check";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { provisionalDeadline } from "./provisional-deadline";
import { checkSecondHoldApplicationDeadline } from "./second-hold-application-deadline";

// 根拠：docs/product-specs/booking.md「申込の締め切り」の「第二キープ申込も、仮予約の期限まで」と、
// 第二キープ申込の例の表（開始が 10/20 15:00 の場合）。core-beliefs.md の INV-7。
// 表の「ほかの条件（承認済みの仮予約と重なる など）」は、空き判定（second-hold.ts）の側で確かめるので、ここでは締め切りだけを見る

// 仕様の日時は JST で書かれている（INV-7）。例の表には年がないので 2026 年とする
function jst(iso: string): DateTime {
  const dateTime = DateTime.fromISO(iso, { zone: "Asia/Tokyo" });
  if (!dateTime.isValid) {
    throw new Error(`テストの日時が不正：${iso}`);
  }
  return dateTime;
}

// 申込日時は引数で渡す（現在時刻を固定する。INV-7）
function check(start: string, appliedAt: string) {
  return checkSecondHoldApplicationDeadline({ start: jst(start), appliedAt: jst(appliedAt) });
}

// 同じ時点を UTC のゾーンで表して、start と appliedAt の両方を渡す（INV-7。docs/TESTING.md「仕様の例とテストの対応づけ」）
function checkUtc(start: string, appliedAt: string) {
  return checkSecondHoldApplicationDeadline({
    start: jst(start).toUTC(),
    appliedAt: jst(appliedAt).toUTC(),
  });
}

describe("申込の締め切り", () => {
  describe("同じく開始が 10/20 15:00 の場合の、第二キープ申込（承認済みの仮予約と重なり、ほかの条件は満たすとき）。", () => {
    const start = "2026-10-20T15:00";

    it("開始 10/20 15:00、申込 10/13 17:59：第二キープ申込は受付", () => {
      expect(check(start, "2026-10-13T17:59")).toEqual({ ok: true });
    });

    it("開始 10/20 15:00、申込 10/13 18:00：第二キープ申込は不可（期限を過ぎた）", () => {
      expect(check(start, "2026-10-13T18:00")).toEqual({
        ok: false,
        reason: "past-provisional-deadline",
      });
    });

    // 上の表の各行を、同じ時点の UTC で渡す。期待値は表の行のまま。
    // UTC では申込 10/13 18:00 が 10/13 09:00、開始が 10/20 06:00 になる。UTC の日付や時刻で期限を求めると結果がずれる
    describe("UTC で渡しても同じ結果（INV-7）", () => {
      it("開始 10/20 15:00、申込 10/13 17:59：第二キープ申込は受付", () => {
        expect(checkUtc(start, "2026-10-13T17:59")).toEqual({ ok: true });
      });

      it("開始 10/20 15:00、申込 10/13 18:00：第二キープ申込は不可（期限を過ぎた）", () => {
        expect(checkUtc(start, "2026-10-13T18:00")).toEqual({
          ok: false,
          reason: "past-provisional-deadline",
        });
      });
    });
  });

  // 「第二キープ申込も、仮予約の期限まで」「ちょうど境界の時刻は過ぎた側」を、どの開始・申込日時でも確かめる。
  // 仮予約の期限は provisionalDeadline（provisional-deadline.test.ts で例から確かめている）で求める
  describe("プロパティ（INV-7。どの入力でも成り立つこと）", () => {
    const base = jst("2026-10-01T00:00");
    const input = fc.record({
      // 10/01 00:00 から60日のうち、30分単位の開始
      startSlot: fc.integer({ min: 0, max: 48 * 60 - 1 }),
      // 開始の30日前から、開始まで（分単位）
      minutesBeforeStart: fc.integer({ min: 0, max: 60 * 24 * 30 }),
    });

    it("第二キープ申込は、申込日時が仮予約の期限より前なら受付、期限ちょうどか過ぎていれば不可（期限を過ぎた）。同じ時点を UTC で渡しても同じ結果", () => {
      fc.assert(
        fc.property(input, ({ startSlot, minutesBeforeStart }) => {
          const start = base.plus({ minutes: 30 * startSlot });
          const appliedAt = start.minus({ minutes: minutesBeforeStart });
          const expected =
            appliedAt.toMillis() < provisionalDeadline(start).toMillis()
              ? { ok: true }
              : { ok: false, reason: "past-provisional-deadline" };
          expect(checkSecondHoldApplicationDeadline({ start, appliedAt })).toEqual(expected);
          expect(
            checkSecondHoldApplicationDeadline({
              start: start.toUTC(),
              appliedAt: appliedAt.toUTC(),
            }),
          ).toEqual(expected);
        }),
      );
    });
  });
});
