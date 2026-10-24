// 管理者の操作（直接入力と予約の変更）の日時の決まり（docs/product-specs/booking.md「直接入れる予約のルール」「予約の変更」）。
// 直接入力（direct-entry.ts）と変更（reservation-change-time.ts）で同じ判定を使うために、ここにまとめる。
// 判定そのものは申込の判定（checkTimeUnitAndDuration・checkApplicationDeadline・checkSecondHoldApplicationDeadline）を使い、
// ここに同じ計算を書き直さない。申込の判定の振る舞いは変えない。
// 現在時刻は使わない。管理者が操作する日時は、呼ぶ側が時計の部品から取って引数で渡す（INV-7）
import type { DateTime } from "luxon";
import {
  type ApplicationDeadlineViolation,
  checkApplicationDeadline,
} from "./application-deadline.ts";
import { assertValidRange } from "./availability.ts";
import { checkSecondHoldApplicationDeadline } from "./second-hold-application-deadline.ts";
import {
  type TimeUnitRejectionReason,
  checkTimeUnitAndDuration,
  isShorterThan2Hours,
} from "./time-unit-and-duration.ts";

/**
 * 時間の単位と利用時間で、管理者の操作でも不可になる理由（例外を認めない）
 * - not-on-30-minute-boundary：開始か終了が30分単位（JST）でない
 * - shorter-than-2-hours：2時間未満（深夜帯にかかっても）
 * - longer-than-24-hours：24時間を超える
 */
export type AdminDurationRejection = Extract<
  TimeUnitRejectionReason,
  "not-on-30-minute-boundary" | "shorter-than-2-hours" | "longer-than-24-hours"
>;

/** 時間の単位と利用時間で、管理者の操作では警告になるもの：深夜帯にかかり4時間未満（2時間以上） */
export type AdminDurationWarning = Extract<
  TimeUnitRejectionReason,
  "late-night-shorter-than-4-hours"
>;

export type AdminDurationResult =
  | { ok: true; warnings: readonly AdminDurationWarning[] }
  | { ok: false; reason: AdminDurationRejection };

/**
 * 管理者の操作で入れる・変える予約区間 [start, end) の、時間の単位と利用時間の判定（JST。INV-7）。
 * 申込の判定（checkTimeUnitAndDuration）で不可になる理由のうち、深夜帯の最短4時間だけを警告にする。
 * ただし、2時間未満なら深夜帯にかかっても不可（shorter-than-2-hours）。
 *
 * 不可の理由が2つ以上当てはまるときは、checkTimeUnitAndDuration の順（30分単位、24時間）で最初のものを返し、
 * 2時間未満はそのあと（仕様では未決事項）。
 * 不正な日時か、終了が開始以前の区間なら RangeError を投げる（黙って「2時間未満」などにしない。checkAvailability と同じ扱い）
 */
export function checkAdminDuration(start: DateTime, end: DateTime): AdminDurationResult {
  assertValidRange({ start, end }, "予約区間");
  const duration = checkTimeUnitAndDuration(start, end);
  if (duration.ok) {
    return { ok: true, warnings: [] };
  }
  switch (duration.reason) {
    case "not-on-30-minute-boundary":
    case "longer-than-24-hours":
    case "shorter-than-2-hours":
      return { ok: false, reason: duration.reason };
    case "late-night-shorter-than-4-hours":
      // 申込の判定は、深夜帯の最短4時間を2時間未満より先に返すので、2時間未満かはここで確かめる
      return isShorterThan2Hours(start, end)
        ? { ok: false, reason: "shorter-than-2-hours" }
        : { ok: true, warnings: [duration.reason] };
  }
}

/** 管理者の操作で入れる・変える予約の種類（変更後も同じ。変更で状態は変わらない） */
export type AdminDeadlineKind = "provisional" | "firm" | "second-hold";

/**
 * 管理者の操作の締め切り（警告）。申込と同じで、本予約は開始の24時間前、仮予約と第二キープは仮予約の期限。
 * start は入れる・変更後の予約区間の開始、operatedAt は管理者が操作する日時。
 * 締め切りを過ぎていれば、その理由を1つだけ入れた配列を返す（過ぎていなければ空）
 */
export function adminDeadlineWarnings(
  kind: AdminDeadlineKind,
  start: DateTime,
  operatedAt: DateTime,
): readonly ApplicationDeadlineViolation[] {
  const deadline =
    kind === "second-hold"
      ? checkSecondHoldApplicationDeadline({ start, appliedAt: operatedAt })
      : checkApplicationDeadline({ kind, start, appliedAt: operatedAt });
  return deadline.ok ? [] : [deadline.reason];
}
