// 第二キープの申込を受けられるかの判定（docs/product-specs/booking.md「第二キープ」）。
// 第二キープ以外の申込の判定は availability.ts の checkAvailability（第二キープも枠を確保するものとして扱う）。
import type { DateTime } from "luxon";
import type { ExistingBlock, ExistingReservation, ReservationBufferMinutes } from "./availability";

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
 */
export type SecondHoldRejection = "overlaps-existing";

export type SecondHoldApplicationResult = { ok: true } | { ok: false; reason: SecondHoldRejection };

/** 第二キープの申込を受けられるか。受けられるなら承認待ち（pending-second-hold）として枠を確保する */
export function checkSecondHoldApplication(
  application: SecondHoldApplication,
): SecondHoldApplicationResult {
  void application;
  throw new Error("未実装");
}
