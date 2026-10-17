// 第二キープの申込を受けられるかの判定（docs/product-specs/booking.md「第二キープ」）。
// 第二キープ以外の申込の判定は availability.ts の checkAvailability（第二キープも枠を確保するものとして扱う）。
import type { DateTime } from "luxon";
import {
  type ExistingBlock,
  type ExistingReservation,
  type ReservationBufferMinutes,
  holdsSlots,
  occupiedRangeOf,
  overlaps,
  overlapsAnyHolding,
} from "./availability";

/** 第二キープの申込。予約区間 [start, end) と、後ろのバッファ。既存の予約とブロック枠は、取消・終了を含めて渡してよい */
export interface SecondHoldApplication {
  start: DateTime;
  end: DateTime;
  bufferMinutes: ReservationBufferMinutes;
  reservations: readonly ExistingReservation[];
  blocks: readonly ExistingBlock[];
}

/**
 * 不可の理由
 * - overlaps-existing：申込の占有区間が、承認済みの仮予約（provisional）以外の、枠を確保している予約（承認待ち・本予約・ほかの第二キープ〔承認待ちを含む〕）かブロック枠の占有区間と重なる。
 *   未決事項のため仮：承認済みの仮予約2件以上と重なるときも、この理由で不可にしている（checkSecondHoldApplication のコメント）
 */
export type SecondHoldRejection = "overlaps-existing";

export type SecondHoldApplicationResult = { ok: true } | { ok: false; reason: SecondHoldRejection };

/**
 * 第二キープの申込を受けられるか。受けられるなら承認待ち（pending-second-hold）として枠を確保する。
 *
 * 申込の占有区間が重なってよいのは、承認済みの仮予約（provisional）の占有区間だけ。
 * 承認待ち（仮・本・第二キープ）・本予約・ほかの第二キープ・ブロック枠と重なれば不可。
 * 第二キープどうしが重ならなければ、1件の仮予約に何件付いてもよい。
 * 取消・終了の予約は枠を確保しないので見ない。
 *
 * 未決事項（booking.md「2件の仮予約にまたがる第二キープを受けるか。どの仮予約とも重ならない第二キープ申込をどう扱うか」）
 * に当たる入力は、決まるまで次のように扱う（未決事項のため仮。テストはない）。
 * - 承認済みの仮予約2件以上と重なる：不可（overlaps-existing）。INV-1 の例外は「承認済みの仮予約1件とだけ」なので、
 *   受付にすると INV-1 を破る。決まるまでは、枠を確保しない側（不可）に倒す
 * - どの承認済みの仮予約とも重ならない：ほかとも重ならなければ受付。どの占有区間とも重ならないので INV-1 は崩れない。
 *   ただし、繰り上げ・終了のきっかけになる仮予約がない第二キープになる（承認は管理者が行う）
 *
 * 申込・既存の予約（枠を確保しているもの）・ブロック枠の区間が、不正な日時か終了が開始以前なら RangeError を投げる
 * （checkAvailability と同じ扱い）
 */
export function checkSecondHoldApplication(
  application: SecondHoldApplication,
): SecondHoldApplicationResult {
  const occupied = occupiedRangeOf(application, application.bufferMinutes, "申込の予約区間");
  const holding = application.reservations.filter((reservation) => holdsSlots(reservation.status));
  const provisionals = holding.filter((reservation) => reservation.status === "provisional");
  const others = holding.filter((reservation) => reservation.status !== "provisional");

  // 承認済みの仮予約の区間も、ほかと同じく先に確かめる（不正な区間を見落として受付にしない）
  const provisionalRanges = provisionals.map((reservation) =>
    occupiedRangeOf(reservation, reservation.bufferMinutes, "既存の予約の予約区間"),
  );

  if (overlapsAnyHolding(occupied, others, application.blocks)) {
    return { ok: false, reason: "overlaps-existing" };
  }

  // 未決事項のため仮：承認済みの仮予約2件以上と重なる申込は不可（上のコメント）。0件は受付
  const overlappingProvisionals = provisionalRanges.filter((range) => overlaps(occupied, range));
  if (overlappingProvisionals.length > 1) {
    return { ok: false, reason: "overlaps-existing" };
  }
  return { ok: true };
}
