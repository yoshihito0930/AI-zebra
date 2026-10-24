import type { ApplicationRejection, ReservationStatus } from "@zebra/contracts";
import type { DateTime } from "luxon";
import { adminDeadlineWarnings, checkAdminDuration } from "./admin-time-rules.ts";
import type { TimeRange } from "./availability.ts";

/**
 * 日時を変えられる予約の状態。変更しても状態は変わらないので、変更前と変更後で同じ（booking.md「予約の変更」）。
 * 第二キープの変更は、未決事項が決まるまで不可（not-changeable。applyReservationChange の判定）なので含めない
 */
export type ReservationChangeTimeStatus = Extract<ReservationStatus, "provisional" | "firm">;

export interface ReservationChangeTimeInput {
  /** 変更する予約の状態 */
  status: ReservationChangeTimeStatus;
  /** 変更前の予約区間 */
  before: TimeRange;
  /** 変更後の予約区間 */
  after: TimeRange;
  /** 管理者が変更を操作する日時（締め切りの判定に使う） */
  changedAt: DateTime;
}

/**
 * 警告：管理者が確認すれば変えられる。締め切り（本予約は past-24-hours-before-start、仮予約は past-provisional-deadline）と、
 * 深夜帯にかかる予約の最短4時間（late-night-shorter-than-4-hours。2時間以上4時間未満）。
 * 名前は申込の理由（公開 API の契約 ApplicationRejection）にそろえる
 */
export type ReservationChangeTimeWarning = Extract<
  ApplicationRejection,
  "past-24-hours-before-start" | "past-provisional-deadline" | "late-night-shorter-than-4-hours"
>;

/**
 * 不可の理由：例外を認めない（30分単位、最短2時間〈深夜帯にかかっても2時間〉、最長24時間）。
 * 名前は申込の理由（ApplicationRejection）にそろえる
 */
export type ReservationChangeTimeRejection = Extract<
  ApplicationRejection,
  "not-on-30-minute-boundary" | "shorter-than-2-hours" | "longer-than-24-hours"
>;

/**
 * 結果。日時を変えない変更（変更前と変更後の予約区間が同じ時点）では判定せず、{ ok: true, warnings: [] }。
 * 警告があっても ok: true。管理者の確認を受けてから保存するのは、呼ぶ側（管理 API・管理画面）
 */
export type ReservationChangeTimeResult =
  | { ok: true; warnings: readonly ReservationChangeTimeWarning[] }
  | { ok: false; reason: ReservationChangeTimeRejection };

/**
 * 予約の変更で日時を変えるときの、直接入力と同じ決まりの判定（booking.md「予約の変更」）。
 * 空き判定は含まない（applyReservationChange が行う）。判定は JST で行う（INV-7）。
 * 不可の理由が2つ以上当てはまるときは、30分単位・24時間・2時間未満の順で最初のものを返す（checkAdminDuration。仕様では未決事項）。
 * 日時を変えるときに、変更後の予約区間が不正な日時か終了が開始以前なら RangeError を投げる
 */
export function checkReservationChangeTime(
  input: ReservationChangeTimeInput,
): ReservationChangeTimeResult {
  const { status, before, after, changedAt } = input;
  // 日時を変えない変更（人数・オプションなど）では判定しない。同じ時点かで比べる（ゾーンの表し方が違ってもよい）
  if (sameInstant(before.start, after.start) && sameInstant(before.end, after.end)) {
    return { ok: true, warnings: [] };
  }

  // 時間の単位と利用時間・締め切りの決まりは、直接入力と共有する（admin-time-rules.ts）
  const duration = checkAdminDuration(after.start, after.end);
  if (!duration.ok) {
    return duration;
  }
  // 締め切りは、管理者が変更を操作する日時と、変更後の開始で数える。警告の並びは直接入力と同じ（締め切り、深夜帯の最短4時間）
  return {
    ok: true,
    warnings: [...adminDeadlineWarnings(status, after.start, changedAt), ...duration.warnings],
  };
}

function sameInstant(a: DateTime, b: DateTime): boolean {
  return a.toMillis() === b.toMillis();
}
