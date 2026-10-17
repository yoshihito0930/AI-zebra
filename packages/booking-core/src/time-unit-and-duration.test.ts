import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { checkTimeUnitAndDuration } from "./time-unit-and-duration";

// 仕様の日時は JST で書かれている（INV-7）。例の表には年がないので 2026 年とする
function jst(iso: string): DateTime {
  const dateTime = DateTime.fromISO(iso, { zone: "Asia/Tokyo" });
  if (!dateTime.isValid) {
    throw new Error(`テストの日時が不正：${iso}`);
  }
  return dateTime;
}

// JST 以外のタイムゾーンで渡す例のために、UTC のゾーンで日時を作る
function utc(iso: string): DateTime {
  const dateTime = DateTime.fromISO(iso, { zone: "UTC" });
  if (!dateTime.isValid) {
    throw new Error(`テストの日時が不正：${iso}`);
  }
  return dateTime;
}

function check(start: string, end: string) {
  return checkTimeUnitAndDuration(jst(start), jst(end));
}

describe("時間の単位と利用時間", () => {
  it("10/20 10:00–12:00：予約可", () => {
    expect(check("2026-10-20T10:00", "2026-10-20T12:00")).toEqual({ ok: true });
  });

  it("10/20 10:30–13:00：予約可", () => {
    expect(check("2026-10-20T10:30", "2026-10-20T13:00")).toEqual({ ok: true });
  });

  it("10/20 10:15–12:15：予約不可（30分単位でない）", () => {
    expect(check("2026-10-20T10:15", "2026-10-20T12:15")).toEqual({
      ok: false,
      reason: "not-on-30-minute-boundary",
    });
  });

  it("10/20 10:00–11:30：予約不可（2時間未満）", () => {
    expect(check("2026-10-20T10:00", "2026-10-20T11:30")).toEqual({
      ok: false,
      reason: "shorter-than-2-hours",
    });
  });

  it("10/20 03:00–07:00：予約可（深夜帯にかかり、ちょうど4時間）", () => {
    expect(check("2026-10-20T03:00", "2026-10-20T07:00")).toEqual({ ok: true });
  });

  it("10/20 03:00–05:00：予約不可（深夜帯にかかり、4時間未満）", () => {
    expect(check("2026-10-20T03:00", "2026-10-20T05:00")).toEqual({
      ok: false,
      reason: "late-night-shorter-than-4-hours",
    });
  });

  it("10/20 23:00–10/21 02:30：予約不可（深夜帯にかかり、4時間未満）", () => {
    expect(check("2026-10-20T23:00", "2026-10-21T02:30")).toEqual({
      ok: false,
      reason: "late-night-shorter-than-4-hours",
    });
  });

  it("10/20 06:00–09:00：予約不可（通常帯にもかかるが、深夜帯にかかるので最短4時間）", () => {
    expect(check("2026-10-20T06:00", "2026-10-20T09:00")).toEqual({
      ok: false,
      reason: "late-night-shorter-than-4-hours",
    });
  });

  it("10/20 05:00–09:00：予約可（深夜帯にかかり、ちょうど4時間）", () => {
    expect(check("2026-10-20T05:00", "2026-10-20T09:00")).toEqual({ ok: true });
  });

  it("10/20 21:00–23:30：予約不可（深夜帯に30分かかり、4時間未満）", () => {
    expect(check("2026-10-20T21:00", "2026-10-20T23:30")).toEqual({
      ok: false,
      reason: "late-night-shorter-than-4-hours",
    });
  });

  it("10/20 21:00–23:00：予約可（23:00で終わるので深夜帯にかからない）", () => {
    expect(check("2026-10-20T21:00", "2026-10-20T23:00")).toEqual({ ok: true });
  });

  it("10/20 08:00–10:00：予約可（8:00から始まるので深夜帯にかからない）", () => {
    expect(check("2026-10-20T08:00", "2026-10-20T10:00")).toEqual({ ok: true });
  });

  // 利用日（10/20）はこの節のルールの外（「用語」の定義）なので、ここでは予約可であることだけを確かめる
  it("10/20 22:00–10/21 02:00：予約可（日付をまたぐ。利用日は10/20。深夜帯にかかり、ちょうど4時間）", () => {
    expect(check("2026-10-20T22:00", "2026-10-21T02:00")).toEqual({ ok: true });
  });

  it("10/20 10:00–10/21 10:00：予約可（ちょうど24時間）", () => {
    expect(check("2026-10-20T10:00", "2026-10-21T10:00")).toEqual({ ok: true });
  });

  it("10/20 10:00–10/21 10:30：予約不可（24時間を超える）", () => {
    expect(check("2026-10-20T10:00", "2026-10-21T10:30")).toEqual({
      ok: false,
      reason: "longer-than-24-hours",
    });
  });

  it("10/20 03:00–05:00 を UTC（10/19 18:00–20:00）で渡す：予約不可（深夜帯にかかり、4時間未満。UTCの時刻では深夜帯にかからないが、判定はJST）", () => {
    expect(checkTimeUnitAndDuration(utc("2026-10-19T18:00"), utc("2026-10-19T20:00"))).toEqual({
      ok: false,
      reason: "late-night-shorter-than-4-hours",
    });
  });

  it("10/20 10:00–12:00 を UTC（10/20 01:00–03:00）で渡す：予約可（UTCの時刻では深夜帯にかかるが、判定はJST）", () => {
    expect(checkTimeUnitAndDuration(utc("2026-10-20T01:00"), utc("2026-10-20T03:00"))).toEqual({
      ok: true,
    });
  });
});
