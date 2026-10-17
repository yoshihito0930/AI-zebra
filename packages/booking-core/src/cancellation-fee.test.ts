import { Yen } from "@zebra/contracts";
import fc from "fast-check";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  calculateCancellationFee,
  type CancellableStatus,
  type CancellationFeeRatePercent,
} from "./cancellation-fee";

// 仕様の日時は JST で書かれている（INV-7）。例には年がないので 2026 年とする
function jst(iso: string): DateTime {
  const dateTime = DateTime.fromISO(iso, { zone: "Asia/Tokyo" });
  if (!dateTime.isValid) {
    throw new Error(`テストの日時が不正：${iso}`);
  }
  return dateTime;
}

// 同じ時点を UTC のゾーンで表した日時（INV-7。docs/TESTING.md「仕様の例とテストの対応づけ」）
function utc(iso: string): DateTime {
  return jst(iso).toUTC();
}

// 例の「利用日が 10/20 の本予約」の開始日時。例には開始の時刻がないので 07:00 とする。
// 07:00 JST は UTC では 10/19 22:00 で、UTC の日付が 10/19 になる。利用日を UTC の日付で取る誤り
// （利用日が 10/19 になり、10/16 12:00 の取消が 3日前の 80%、10/19 23:59 の取消が当日の 100% になる）を、
// 例の行で見つけるため。
// 当日の取消（10/20 00:00 など）も、開始より前（利用中・利用後の取消は未決事項）になる
const start = "2026-10-20T07:00";

interface Row {
  readonly status: CancellableStatus;
  readonly amount: number;
  readonly cancelledAt: string;
}

function feeOf(row: Row, toDateTime: (iso: string) => DateTime) {
  return calculateCancellationFee({
    status: row.status,
    amount: Yen.parse(row.amount),
    start: toDateTime(start),
    cancelledAt: toDateTime(row.cancelledAt),
  });
}

function expected(fee: number, ratePercent: CancellationFeeRatePercent) {
  return { ratePercent, fee: Yen.parse(fee) };
}

// 例の表の行。金額のない行は、例の前提の 27,500円とする。
// 「5日前」「2日前」「当日」の行は、利用日 10/20 から日付を決め、時刻は開始より前の時刻にする
const rows = {
  oct13At2359: { status: "firm", amount: 27_500, cancelledAt: "2026-10-13T23:59" },
  oct14At0000: { status: "firm", amount: 27_500, cancelledAt: "2026-10-14T00:00" },
  oct16At1200: { status: "firm", amount: 27_500, cancelledAt: "2026-10-16T12:00" },
  oct17At0000: { status: "firm", amount: 27_500, cancelledAt: "2026-10-17T00:00" },
  oct19At2359: { status: "firm", amount: 27_500, cancelledAt: "2026-10-19T23:59" },
  oct20At0000: { status: "firm", amount: 27_500, cancelledAt: "2026-10-20T00:00" },
  // 5日前＝10/15
  fiveDaysBefore: { status: "firm", amount: 28_737, cancelledAt: "2026-10-15T12:00" },
  // 2日前＝10/18
  twoDaysBefore: { status: "firm", amount: 28_737, cancelledAt: "2026-10-18T12:00" },
  // 当日＝10/20。開始 07:00 より前
  adjustedOnTheDay: { status: "firm", amount: 25_000, cancelledAt: "2026-10-20T06:00" },
  provisionalOct13: { status: "provisional", amount: 27_500, cancelledAt: "2026-10-13T17:00" },
  // 取消の時点では本予約。昇格の日時（10/13 12:00）は率に関わらないので、入力にない
  promotedThenCancelled: { status: "firm", amount: 27_500, cancelledAt: "2026-10-13T20:00" },
  // 10/16 の時刻は 12:00 とする
  provisionalPastDeadline: {
    status: "provisional",
    amount: 27_500,
    cancelledAt: "2026-10-16T12:00",
  },
  // 当日＝10/20。開始 07:00 より前
  pendingFirmOnTheDay: { status: "pending-firm", amount: 27_500, cancelledAt: "2026-10-20T06:00" },
  // 当日＝10/20。開始 07:00 より前
  secondHoldOnTheDay: { status: "second-hold", amount: 27_500, cancelledAt: "2026-10-20T06:00" },
} satisfies Record<string, Row>;

describe("取消とキャンセル料", () => {
  it("取消 10/13 23:59：キャンセル料 13,750円（50%。7日前）", () => {
    expect(feeOf(rows.oct13At2359, jst)).toEqual(expected(13_750, 50));
  });

  it("取消 10/14 00:00：キャンセル料 13,750円（50%）", () => {
    expect(feeOf(rows.oct14At0000, jst)).toEqual(expected(13_750, 50));
  });

  it("取消 10/16 12:00：キャンセル料 13,750円（50%）", () => {
    expect(feeOf(rows.oct16At1200, jst)).toEqual(expected(13_750, 50));
  });

  it("取消 10/17 00:00：キャンセル料 22,000円（80%）", () => {
    expect(feeOf(rows.oct17At0000, jst)).toEqual(expected(22_000, 80));
  });

  it("取消 10/19 23:59：キャンセル料 22,000円（80%）", () => {
    expect(feeOf(rows.oct19At2359, jst)).toEqual(expected(22_000, 80));
  });

  it("取消 10/20 00:00：キャンセル料 27,500円（100%）", () => {
    expect(feeOf(rows.oct20At0000, jst)).toEqual(expected(27_500, 100));
  });

  it("金額 28,737円の本予約を5日前に取消：キャンセル料 14,368円（14,368.5 を切り捨て）", () => {
    expect(feeOf(rows.fiveDaysBefore, jst)).toEqual(expected(14_368, 50));
  });

  it("金額 28,737円の本予約を2日前に取消：キャンセル料 22,989円（22,989.6 を切り捨て）", () => {
    expect(feeOf(rows.twoDaysBefore, jst)).toEqual(expected(22_989, 80));
  });

  it("自動計算 27,500円を管理者が 25,000円に調整した本予約を当日に取消：キャンセル料 25,000円", () => {
    expect(feeOf(rows.adjustedOnTheDay, jst)).toEqual(expected(25_000, 100));
  });

  it("仮予約を 10/13 17:00 に取消：キャンセル料なし（仮予約は無料）", () => {
    expect(feeOf(rows.provisionalOct13, jst)).toEqual(expected(0, 0));
  });

  it("10/13 12:00 に本予約へ昇格した予約を、同じ 10/13 の 20:00 に取消：キャンセル料 13,750円（50%。7日前。本予約には無料の期間がない）", () => {
    expect(feeOf(rows.promotedThenCancelled, jst)).toEqual(expected(13_750, 50));
  });

  it("期限を過ぎて仮予約のままの予約を 10/16 に取消：キャンセル料なし（仮予約は無料）", () => {
    expect(feeOf(rows.provisionalPastDeadline, jst)).toEqual(expected(0, 0));
  });

  it("承認待ち（本）の申込を当日に取消：キャンセル料なし（承認待ちは無料）", () => {
    expect(feeOf(rows.pendingFirmOnTheDay, jst)).toEqual(expected(0, 0));
  });

  it("第二キープを当日に取消：キャンセル料なし（第二キープは無料）", () => {
    expect(feeOf(rows.secondHoldOnTheDay, jst)).toEqual(expected(0, 0));
  });

  // 上の各行を、同じ時点の UTC で渡す（開始は 10/19 22:00 UTC）。期待値は表の行のまま
  describe("UTC で渡しても同じ結果（INV-7）", () => {
    it("取消 10/13 23:59：キャンセル料 13,750円（50%。7日前）", () => {
      expect(feeOf(rows.oct13At2359, utc)).toEqual(expected(13_750, 50));
    });

    it("取消 10/14 00:00：キャンセル料 13,750円（50%）", () => {
      expect(feeOf(rows.oct14At0000, utc)).toEqual(expected(13_750, 50));
    });

    it("取消 10/16 12:00：キャンセル料 13,750円（50%）", () => {
      expect(feeOf(rows.oct16At1200, utc)).toEqual(expected(13_750, 50));
    });

    it("取消 10/17 00:00：キャンセル料 22,000円（80%）", () => {
      expect(feeOf(rows.oct17At0000, utc)).toEqual(expected(22_000, 80));
    });

    it("取消 10/19 23:59：キャンセル料 22,000円（80%）", () => {
      expect(feeOf(rows.oct19At2359, utc)).toEqual(expected(22_000, 80));
    });

    it("取消 10/20 00:00：キャンセル料 27,500円（100%）", () => {
      expect(feeOf(rows.oct20At0000, utc)).toEqual(expected(27_500, 100));
    });

    it("金額 28,737円の本予約を5日前に取消：キャンセル料 14,368円（14,368.5 を切り捨て）", () => {
      expect(feeOf(rows.fiveDaysBefore, utc)).toEqual(expected(14_368, 50));
    });

    it("金額 28,737円の本予約を2日前に取消：キャンセル料 22,989円（22,989.6 を切り捨て）", () => {
      expect(feeOf(rows.twoDaysBefore, utc)).toEqual(expected(22_989, 80));
    });

    it("自動計算 27,500円を管理者が 25,000円に調整した本予約を当日に取消：キャンセル料 25,000円", () => {
      expect(feeOf(rows.adjustedOnTheDay, utc)).toEqual(expected(25_000, 100));
    });

    it("仮予約を 10/13 17:00 に取消：キャンセル料なし（仮予約は無料）", () => {
      expect(feeOf(rows.provisionalOct13, utc)).toEqual(expected(0, 0));
    });

    it("10/13 12:00 に本予約へ昇格した予約を、同じ 10/13 の 20:00 に取消：キャンセル料 13,750円（50%。7日前。本予約には無料の期間がない）", () => {
      expect(feeOf(rows.promotedThenCancelled, utc)).toEqual(expected(13_750, 50));
    });

    it("期限を過ぎて仮予約のままの予約を 10/16 に取消：キャンセル料なし（仮予約は無料）", () => {
      expect(feeOf(rows.provisionalPastDeadline, utc)).toEqual(expected(0, 0));
    });

    it("承認待ち（本）の申込を当日に取消：キャンセル料なし（承認待ちは無料）", () => {
      expect(feeOf(rows.pendingFirmOnTheDay, utc)).toEqual(expected(0, 0));
    });

    it("第二キープを当日に取消：キャンセル料なし（第二キープは無料）", () => {
      expect(feeOf(rows.secondHoldOnTheDay, utc)).toEqual(expected(0, 0));
    });
  });

  // INV-9（金額は整数の円。キャンセル料は 金額 × 率 → 1円未満切り捨て）と
  // INV-7（日数は JST の日付で数える）を、ランダムな取消で確かめる。
  // 取消の日時は開始より前だけを作る（利用中・利用後の取消は未決事項のため）
  describe("プロパティ（INV-9、INV-7）", () => {
    const cancellableStatuses: readonly CancellableStatus[] = [
      "pending-provisional",
      "pending-firm",
      "pending-second-hold",
      "provisional",
      "firm",
      "second-hold",
    ];

    const base = jst("2026-10-01T00:00");

    const cancellation = fc.record({
      status: fc.constantFrom(...cancellableStatuses),
      amount: fc.integer({ min: 0, max: 10_000_000 }),
      // 10/01 00:00 から60日のうち、30分単位の開始
      startSlot: fc.integer({ min: 0, max: 48 * 60 - 1 }),
      // 開始の1分前から、開始の30日前まで
      minutesBeforeStart: fc.integer({ min: 1, max: 60 * 24 * 30 }),
    });

    type Cancellation = typeof cancellation extends fc.Arbitrary<infer T> ? T : never;

    function startOf(c: Cancellation): DateTime {
      return base.plus({ minutes: 30 * c.startSlot });
    }

    function cancelledAtOf(c: Cancellation): DateTime {
      return startOf(c).minus({ minutes: c.minutesBeforeStart });
    }

    function feeFor(c: Cancellation, toZone: (dateTime: DateTime) => DateTime = (d) => d) {
      return calculateCancellationFee({
        status: c.status,
        amount: Yen.parse(c.amount),
        start: toZone(startOf(c)),
        cancelledAt: toZone(cancelledAtOf(c)),
      });
    }

    // 仕様の表：取消の日（JST）が利用日（開始の JST の日付）の何日前か。
    // 本予約には無料の期間がないので、4日以上前は何日前でも 50%
    function expectedRatePercent(c: Cancellation): CancellationFeeRatePercent {
      if (c.status !== "firm") {
        return 0;
      }
      const usageDay = startOf(c).setZone("Asia/Tokyo").startOf("day");
      const cancelDay = cancelledAtOf(c).setZone("Asia/Tokyo").startOf("day");
      const daysBefore = Math.round(usageDay.diff(cancelDay, "days").days);
      if (daysBefore >= 4) return 50;
      if (daysBefore >= 1) return 80;
      return 100;
    }

    it("キャンセル料は0以上の整数の円（Yen）で、率は 0・50・80・100 のどれか", () => {
      fc.assert(
        fc.property(cancellation, (c) => {
          const result = feeFor(c);
          expect(Yen.safeParse(result.fee).success).toBe(true);
          expect([0, 50, 80, 100]).toContain(result.ratePercent);
        }),
      );
    });

    it("キャンセル料は、金額 × 率 の1円未満を切り捨てた額", () => {
      fc.assert(
        fc.property(cancellation, (c) => {
          const result = feeFor(c);
          const timesRate = c.amount * result.ratePercent;
          const floored = (timesRate - (timesRate % 100)) / 100;
          expect(result.fee).toBe(floored);
        }),
      );
    });

    it("本予約の率は、取消の日（JST）が利用日（開始の JST の日付）の何日前かで決まる。本予約以外は無料", () => {
      fc.assert(
        fc.property(cancellation, (c) => {
          expect(feeFor(c).ratePercent).toBe(expectedRatePercent(c));
        }),
      );
    });

    it("本予約の率は 0 にならない（本予約には無料の期間がない）", () => {
      fc.assert(
        fc.property(
          cancellation.filter((c) => c.status === "firm"),
          (c) => {
            expect(feeFor(c).ratePercent).not.toBe(0);
          },
        ),
      );
    });

    it("同じ時点を UTC で渡しても、JST で渡したときと同じ結果", () => {
      fc.assert(
        fc.property(cancellation, (c) => {
          expect(feeFor(c, (d) => d.toUTC())).toEqual(feeFor(c));
        }),
      );
    });
  });
});
