import type { ApplicationRejection, ReservationStatus } from "@zebra/contracts";
import type { DateTime } from "luxon";
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
 * 警告：管理者が確認すれば変えられる。締め切りだけ（本予約は past-24-hours-before-start、
 * 仮予約は past-provisional-deadline）。名前は申込の理由（公開 API の契約 ApplicationRejection）にそろえる
 */
export type ReservationChangeTimeWarning = Extract<
  ApplicationRejection,
  "past-24-hours-before-start" | "past-provisional-deadline"
>;

/**
 * 不可の理由：例外を認めない（30分単位、最短時間〈2時間、深夜帯を含むときは4時間〉、最長24時間）。
 * 名前は申込の理由（ApplicationRejection）にそろえる
 */
export type ReservationChangeTimeRejection = Extract<
  ApplicationRejection,
  | "not-on-30-minute-boundary"
  | "shorter-than-2-hours"
  | "late-night-shorter-than-4-hours"
  | "longer-than-24-hours"
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
 * 空き判定は含まない（applyReservationChange が行う）。判定は JST で行う（INV-7）
 */
export function checkReservationChangeTime(
  input: ReservationChangeTimeInput,
): ReservationChangeTimeResult {
  void input;
  throw new Error("未実装");
}
