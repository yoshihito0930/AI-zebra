// 取消のキャンセル料（docs/product-specs/booking.md「取消とキャンセル料」）。
// INV-9（金額は整数の円。キャンセル料は 金額 × 率 → 1円未満切り捨て）、INV-7（日数は JST の日付で数える）
import type { ReservationStatus } from "@zebra/contracts";
import { Yen } from "@zebra/contracts";
import type { DateTime } from "luxon";
import { jstDate, usageDate } from "./jst-time";

/** 取消せる予約の状態。取消・終了の予約は、さらに取消さない */
export type CancellableStatus = Exclude<ReservationStatus, "cancelled" | "ended">;

/** キャンセル料の率。整数のパーセント（INV-9。浮動小数にしない）。0 は「なし」（本予約以外の取消だけ） */
export type CancellationFeeRatePercent = 0 | 50 | 80 | 100;

export interface CancellationFeeInput {
  /** 取消す時点の予約の状態。キャンセル料がかかるのは本予約（firm）だけ */
  readonly status: CancellableStatus;
  /** 予約の金額（税込の合計。管理者が調整した場合は調整後） */
  readonly amount: Yen;
  /** 予約区間の開始日時。利用日は、この日時の JST での日付（INV-7） */
  readonly start: DateTime;
  /** 管理者が取消を操作した日時。率は、この日時の JST での日付が利用日の何日前かで決まる（INV-7） */
  readonly cancelledAt: DateTime;
}

export interface CancellationFee {
  /** キャンセル料の率（整数のパーセント） */
  readonly ratePercent: CancellationFeeRatePercent;
  /** キャンセル料 ＝ 金額 × 率。1円未満は切り捨て（INV-9） */
  readonly fee: Yen;
}

/**
 * 取消のキャンセル料を計算する。
 * - 本予約（firm）だけが対象。承認待ち・仮予約・第二キープは、いつ取消しても率 0（無料）
 * - 本予約の率は、取消の日（JST）が利用日（開始の JST の日付）の何日前かで決める（0:00 で切り替わる）。
 *   4日以上前は 50%、3日前〜前日は 80%、当日は 100%。本予約には無料の期間がない
 * - 日時のゾーンは問わない（JST に直してから日付を取る）
 *
 * 本予約を開始以降（利用中・利用後）に取消す場合の扱いは、仕様の未決事項
 * （booking.md「未決事項」の「利用日を過ぎてから（利用中・利用後）の取消の扱い」）。
 * 未決事項のため仮に、RangeError を投げる（推測で率を決めない）。決まったら、仕様とテストを足してから変える。
 * 不正な日時も RangeError を投げる。
 */
export function calculateCancellationFee(input: CancellationFeeInput): CancellationFee {
  const { status, amount, start, cancelledAt } = input;
  if (!start.isValid || !cancelledAt.isValid) {
    throw new RangeError("開始日時か取消の日時が不正");
  }
  if (status !== "firm") {
    return { ratePercent: 0, fee: Yen.parse(0) };
  }
  // 未決事項のため仮：開始以降（利用中・利用後）の本予約の取消は、率を決めずにエラーにする
  if (cancelledAt.toMillis() >= start.toMillis()) {
    throw new RangeError("開始以降（利用中・利用後）の本予約の取消は、扱いが未決事項");
  }

  const ratePercent = rateForDaysBefore(daysBeforeUsageDate(start, cancelledAt));
  return { ratePercent, fee: Yen.parse(applyRate(amount, ratePercent)) };
}

/**
 * 取消の日（JST）が利用日の何日前か。当日は 0、前日は 1。
 * どちらも JST の 0:00 の DateTime どうしの差で、JST には夏時間がないので整数になる
 */
function daysBeforeUsageDate(start: DateTime, cancelledAt: DateTime): number {
  return usageDate(start).diff(jstDate(cancelledAt), "days").days;
}

// 本予約の率の表（booking.md「取消とキャンセル料」）。上から順に、何日前以上ならその率か。
// 本予約の率は 0 にならない（本予約には無料で取消せる期間がない）
const RATE_TABLE: readonly {
  readonly minDaysBefore: number;
  readonly ratePercent: CancellationFeeRatePercent;
}[] = [
  { minDaysBefore: 4, ratePercent: 50 }, // 利用日の4日以上前（本予約には無料の期間がない）
  { minDaysBefore: 1, ratePercent: 80 }, // 3日前〜前日
  { minDaysBefore: 0, ratePercent: 100 }, // 利用日当日
];

function rateForDaysBefore(daysBefore: number): CancellationFeeRatePercent {
  for (const { minDaysBefore, ratePercent } of RATE_TABLE) {
    if (daysBefore >= minDaysBefore) {
      return ratePercent;
    }
  }
  // 開始より前の取消なので、取消の日が利用日より後になることはない
  throw new RangeError("取消の日が利用日より後");
}

// 率はパーセントの整数なので、分母は 100
const PERCENT_DENOMINATOR = 100;

/**
 * 金額（整数の円）× 率（整数のパーセント）の1円未満を切り捨てる。
 * キャンセル料の端数の処理はここだけで行う（INV-9）。整数のまま掛けてから、余りを引いて割り切れる形にする
 */
function applyRate(amount: Yen, ratePercent: CancellationFeeRatePercent): number {
  const scaled = amount * ratePercent;
  // eslint-disable-next-line no-restricted-syntax -- INV-9：キャンセル料の1円未満の切り捨ては、ここだけで行う（割り切れる形にしてから割る）
  return (scaled - (scaled % PERCENT_DENOMINATOR)) / PERCENT_DENOMINATOR;
}
