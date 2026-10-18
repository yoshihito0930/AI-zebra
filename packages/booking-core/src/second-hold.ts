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
 * - overlaps-existing：申込の占有区間が、承認済みの仮予約（provisional）以外の、枠を確保している予約（承認待ち・本予約・ほかの第二キープ〔承認待ちを含む〕）かブロック枠の占有区間と重なる
 * - no-provisional-to-hold：申込の占有区間が、どの承認済みの仮予約の占有区間とも重ならない（第二キープとしては受けない。普通の申込になる）
 */
export type SecondHoldRejection = "overlaps-existing" | "no-provisional-to-hold";

/**
 * 受付なら、第二キープが付く仮予約の id（申込の占有区間と重なる承認済みの仮予約すべて。1件以上）を返す。
 * 並び順は、引数の reservations の並び順（docs/design-docs/reservation-model.md「第二キープと仮予約」）
 */
export type SecondHoldApplicationResult =
  { ok: true; provisionalIds: string[] } | { ok: false; reason: SecondHoldRejection };

/**
 * 第二キープの申込を受けられるか。受けられるなら承認待ち（pending-second-hold）として枠を確保し、
 * 申込の占有区間と重なる承認済みの仮予約すべてに付く（2件以上にまたがってもよい）。
 *
 * 申込の占有区間が重なってよいのは、承認済みの仮予約（provisional）の占有区間だけ（INV-1 の例外）。
 * 承認待ち（仮・本・第二キープ）・本予約・ほかの第二キープ・ブロック枠と重なれば不可（overlaps-existing）。
 * どの承認済みの仮予約とも重ならなければ、第二キープとしては受けない（no-provisional-to-hold）。
 * 第二キープどうしが重ならなければ、1件の仮予約に何件付いてもよい。
 * 取消・終了の予約は枠を確保しないので見ない。
 * 不可の理由が2つとも当てはまるときは overlaps-existing を返す（どちらを返すかは仕様で決めていない。
 * booking.md の未決事項「予約不可の理由が複数当てはまるとき」）。
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
  const provisionalRanges = provisionals.map((reservation) => ({
    id: reservation.id,
    range: occupiedRangeOf(reservation, reservation.bufferMinutes, "既存の予約の予約区間"),
  }));

  if (overlapsAnyHolding(occupied, others, application.blocks)) {
    return { ok: false, reason: "overlaps-existing" };
  }

  // 付く仮予約は、重なる承認済みの仮予約すべて（reservations の並び順のまま）
  const provisionalIds = provisionalRanges
    .filter(({ range }) => overlaps(occupied, range))
    .map(({ id }) => id);
  if (provisionalIds.length === 0) {
    return { ok: false, reason: "no-provisional-to-hold" };
  }
  return { ok: true, provisionalIds };
}
