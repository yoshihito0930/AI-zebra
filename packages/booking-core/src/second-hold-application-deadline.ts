// 第二キープ申込の締め切り（docs/product-specs/booking.md「申込の締め切り」）。
// 第二キープ申込も、仮予約の期限まで。ちょうど期限の時刻は「過ぎた」側に入れる。
// 判定は JST で行う（INV-7）。申込日時は引数で受け取る（現在時刻を取得しない。INV-5）
import type { DateTime } from "luxon";

export type SecondHoldApplicationDeadlineInput = {
  /** 第二キープの予約区間の開始 */
  start: DateTime;
  /** 申込日時 */
  appliedAt: DateTime;
};

/** 不可の理由は、仮予約申込と同じ past-provisional-deadline（packages/contracts の ApplicationRejection） */
export type SecondHoldApplicationDeadlineResult =
  { ok: true } | { ok: false; reason: "past-provisional-deadline" };

export function checkSecondHoldApplicationDeadline(
  input: SecondHoldApplicationDeadlineInput,
): SecondHoldApplicationDeadlineResult {
  void input;
  throw new Error("未実装");
}
