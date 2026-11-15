import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  calendarWeeks,
  compareBookings,
  formatBooking,
  formatDuration,
  formatRange,
  formatYen,
  monthRange,
  monthStartOf,
} from "./format.ts";

describe("マスに出す予約の表示名と時間（JST）", () => {
  it("表示名と時間を「仮予約 9:00-12:00」の形にする", () => {
    expect(
      formatBooking(
        {
          label: "provisional",
          start: "2026-11-20T09:00:00+09:00",
          end: "2026-11-20T12:00:00+09:00",
        },
        "2026-11-20",
      ),
    ).toBe("仮予約 9:00-12:00");
    expect(
      formatBooking(
        { label: "firm", start: "2026-11-20T14:00:00+09:00", end: "2026-11-20T17:00:00+09:00" },
        "2026-11-20",
      ),
    ).toBe("本予約 14:00-17:00");
    expect(
      formatBooking(
        {
          label: "unavailable",
          start: "2026-11-20T18:00:00+09:00",
          end: "2026-11-20T22:00:00+09:00",
        },
        "2026-11-20",
      ),
    ).toBe("予約不可 18:00-22:00");
    expect(
      formatBooking(
        {
          label: "second-hold",
          start: "2026-11-20T13:30:00+09:00",
          end: "2026-11-20T16:00:00+09:00",
        },
        "2026-11-20",
      ),
    ).toBe("第二キープ 13:30-16:00");
  });

  it("UTC で来た日時も JST で出す", () => {
    expect(
      formatBooking(
        { label: "firm", start: "2026-11-20T01:00:00Z", end: "2026-11-20T03:00:00Z" },
        "2026-11-20",
      ),
    ).toBe("本予約 10:00-12:00");
  });

  it("日をまたぐ予約は、マスの日付でない側に日付を付ける", () => {
    const overnight = {
      label: "firm" as const,
      start: "2026-11-20T22:00:00+09:00",
      end: "2026-11-21T02:00:00+09:00",
    };
    expect(formatBooking(overnight, "2026-11-20")).toBe("本予約 22:00-11/21 2:00");
    expect(formatBooking(overnight, "2026-11-21")).toBe("本予約 11/20 22:00-2:00");
  });

  it("ちょうど翌日の0時に終わる予約は「24:00」と出す", () => {
    expect(
      formatBooking(
        { label: "firm", start: "2026-11-20T20:00:00+09:00", end: "2026-11-21T00:00:00+09:00" },
        "2026-11-20",
      ),
    ).toBe("本予約 20:00-24:00");
  });

  it("開始の早い順（同じなら終わりの早い順）に並べる", () => {
    const bookings = [
      {
        label: "firm" as const,
        start: "2026-11-20T14:00:00+09:00",
        end: "2026-11-20T17:00:00+09:00",
      },
      {
        label: "unavailable" as const,
        start: "2026-11-20T09:00:00+09:00",
        end: "2026-11-20T12:00:00+09:00",
      },
      {
        label: "provisional" as const,
        start: "2026-11-20T09:00:00+09:00",
        end: "2026-11-20T11:00:00+09:00",
      },
    ];
    expect([...bookings].sort(compareBookings).map((b) => b.label)).toEqual([
      "provisional",
      "unavailable",
      "firm",
    ]);
  });
});

describe("月のカレンダーの並び", () => {
  it("今の時点の JST の月を出す（UTC では前の月でも）", () => {
    // 2026-11-30T16:00Z は JST の 12/1 01:00
    const month = monthStartOf(DateTime.fromISO("2026-11-30T16:00:00Z"));
    expect(monthRange(month)).toEqual({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("週は日曜はじまりで、月の外のマスは空", () => {
    // 2026年11月1日は日曜、30日は月曜
    const weeks = calendarWeeks(monthStartOf(DateTime.fromISO("2026-11-15T10:00:00+09:00")));
    expect(weeks).toHaveLength(5);
    expect(weeks[0]?.[0]).toBe("2026-11-01");
    expect(weeks[4]).toEqual(["2026-11-29", "2026-11-30", null, null, null, null, null]);
    // 2026年12月1日は火曜
    const december = calendarWeeks(monthStartOf(DateTime.fromISO("2026-12-10T10:00:00+09:00")));
    expect(december[0]).toEqual([
      null,
      null,
      "2026-12-01",
      "2026-12-02",
      "2026-12-03",
      "2026-12-04",
      "2026-12-05",
    ]);
  });
});

describe("申込の日時と金額の形", () => {
  it("利用日時と長さ", () => {
    const start = DateTime.fromISO("2026-11-20T22:00:00+09:00");
    const end = DateTime.fromISO("2026-11-21T02:30:00+09:00");
    expect(formatRange(start, end)).toBe("11/20(金) 22:00〜11/21(土) 2:30");
    expect(formatDuration(start, end)).toBe("4時間30分");
    expect(formatDuration(start, DateTime.fromISO("2026-11-21T00:00:00+09:00"))).toBe("2時間");
  });

  it("金額は整数の円に3桁区切りを付ける（INV-9）", () => {
    expect(formatYen(28_737)).toBe("28,737円");
    expect(() => formatYen(28_737.5)).toThrow();
  });
});
