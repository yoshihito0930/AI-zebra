import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  compareByTime,
  formatDateTime,
  formatTimeRange,
  formatYen,
  fromJstInput,
  monthOf,
  toJstInput,
} from "./format.ts";

describe("日時の表示（JST）", () => {
  it("JST のオフセット付きの日時を、そのまま JST で出す", () => {
    expect(formatDateTime("2026-11-20T13:00:00.000+09:00")).toBe("2026/11/20(金) 13:00");
  });

  it("UTC の日時も JST に直して出す（日付が変わる時刻）", () => {
    expect(formatDateTime("2026-11-19T15:30:00Z")).toBe("2026/11/20(金) 00:30");
  });

  it("同じ日の区間は、終わりを時刻だけで出す", () => {
    expect(formatTimeRange("2026-11-20T13:00:00+09:00", "2026-11-20T15:00:00+09:00")).toBe(
      "2026/11/20(金) 13:00〜15:00",
    );
  });

  it("日をまたぐ区間は、終わりにも日付を出す", () => {
    expect(formatTimeRange("2026-11-20T22:00:00+09:00", "2026-11-21T02:00:00+09:00")).toBe(
      "2026/11/20(金) 22:00〜11/21(土) 02:00",
    );
  });
});

describe("日時の入力欄（JST）", () => {
  it("API の日時を、JST の入力欄の値にする（UTC で来ても JST に直す）", () => {
    expect(toJstInput("2026-11-20T13:00:00.000+09:00")).toBe("2026-11-20T13:00");
    expect(toJstInput("2026-11-19T15:30:00Z")).toBe("2026-11-20T00:30");
  });

  it("入力欄の値を JST の時刻として読み、JST のオフセット付きで送る形にする", () => {
    expect(fromJstInput("2026-11-20T13:00")).toBe("2026-11-20T13:00:00.000+09:00");
    // 日をまたいだ深夜
    expect(fromJstInput("2026-11-21T02:30")).toBe("2026-11-21T02:30:00.000+09:00");
  });

  it("日時の形でない値は undefined", () => {
    for (const value of ["", "2026-11-20", "2026-11-20T25:00", "2026-02-30T10:00", "あ"]) {
      expect(fromJstInput(value)).toBeUndefined();
    }
  });
});

describe("金額の表示", () => {
  it("整数の円を、桁区切りと「円」で出す", () => {
    expect(formatYen(12_100)).toBe("12,100円");
    expect(formatYen(0)).toBe("0円");
  });

  it("整数でない金額は出さずにエラーにする（INV-9）", () => {
    expect(() => formatYen(100.5)).toThrow();
  });
});

describe("一覧の期間の初期値（今月）", () => {
  it("JST の月の初日と末日", () => {
    expect(monthOf(DateTime.fromISO("2026-11-15T12:00:00+09:00"))).toEqual({
      from: "2026-11-01",
      to: "2026-11-30",
    });
  });

  it("UTC ではまだ前の月でも、JST で月が変わっていれば JST の月", () => {
    expect(monthOf(DateTime.fromISO("2026-10-31T15:30:00Z", { zone: "utc" }))).toEqual({
      from: "2026-11-01",
      to: "2026-11-30",
    });
  });
});

describe("並べ方", () => {
  it("開始の早い順、同じなら終わりの早い順、それも同じなら id の順（オフセットが違っても時刻で比べる）", () => {
    const items = [
      // c は UTC で書いた 13:00〜15:00（JST）。d と同じ時刻なので id の順
      { id: "c", start: "2026-11-20T04:00:00Z", end: "2026-11-20T06:00:00Z" },
      { id: "b", start: "2026-11-20T13:00:00+09:00", end: "2026-11-20T16:00:00+09:00" },
      { id: "a", start: "2026-11-20T13:00:00+09:00", end: "2026-11-20T16:00:00+09:00" },
      { id: "d", start: "2026-11-20T13:00:00+09:00", end: "2026-11-20T15:00:00+09:00" },
    ];
    expect(items.sort(compareByTime).map((i) => i.id)).toEqual(["c", "d", "a", "b"]);
  });
});
