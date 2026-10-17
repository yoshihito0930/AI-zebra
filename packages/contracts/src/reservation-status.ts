// 予約の状態（docs/product-specs/booking.md「予約の状態」）。管理画面の API、空き判定、取消、予約の変更で同じ型を使う。
// 呼び名は booking-core の申込の種類（firm＝本予約、provisional＝仮予約）に揃える。
import { z } from "zod";

/**
 * - pending-provisional：承認待ち（仮）。仮予約申込を、管理者がまだ承認していない
 * - pending-firm：承認待ち（本）。本予約申込を、管理者がまだ承認していない
 * - pending-second-keep：承認待ち（第二キープ）
 * - provisional：仮予約
 * - firm：本予約
 * - second-keep：第二キープ
 * - cancelled：取消（却下を含む）
 * - ended：終了（重なる仮予約が本予約に昇格した第二キープ）
 */
export const ReservationStatus = z.enum([
  "pending-provisional",
  "pending-firm",
  "pending-second-keep",
  "provisional",
  "firm",
  "second-keep",
  "cancelled",
  "ended",
]);
export type ReservationStatus = z.infer<typeof ReservationStatus>;
