// 公開API（認証なし）の申込（docs/product-specs/booking.md「申込フォーム」）。
// テストの PR で決めた形だけのスタブ。中身は実装の PR で書く（docs/TESTING.md の手順4）。
// app.ts へのつなぎ込みも実装の PR で行う。
import type { ApplicationAccepted, ApplicationRejection, PriceTable } from "@zebra/contracts";
import type { Hono } from "hono";
import type { DateTime } from "luxon";
import type { ReservationStore } from "../db/reservations.ts";

/** 申込の処理が使うもの。テストで固定・差し替えできるように、外から渡す */
export interface ApplicationDeps {
  readonly store: ReservationStore;
  /** 現在時刻（INV-7）。申込の締め切りの判定と、保存する作成日時に使う */
  readonly now: () => DateTime;
  /** 料金表（booking.md「料金」の「料金表」）。プランの決め方と見積額の計算に使う */
  readonly priceTable: PriceTable;
  /**
   * 受付番号を作る（省略時は実装が決める）。packages/contracts の ReceiptNumber の形の文字列を返す。
   * 重ならないことは、作った番号ではなく DB の条件で保証する（dynamodb-keys.md「アイテム」の受付番号）
   */
  readonly generateReceiptNumber?: () => string;
  /**
   * 保存（apps/api/src/db の saveApplication）に渡すもの。テストで衝突を起こすために使う
   * - maxAttempts：版番号の衝突でやり直す回数の上限。超えたら混み合っている（busy）
   * - beforeWrite：読んで判定したあと、書く直前に呼ぶ（attempt は1から）
   */
  readonly save?: {
    readonly maxAttempts?: number;
    readonly beforeWrite?: (attempt: number) => Promise<void>;
  };
}

/** 申込の結果。受け付けたら返事（受付番号と見積額だけ）、受け付けなければ理由 */
export type ApplicationResult =
  | { readonly ok: true; readonly accepted: ApplicationAccepted }
  | { readonly ok: false; readonly reason: ApplicationRejection };

/**
 * お客様の申込を処理する。外から来た値（body）を ApplicationRequest でパースし（INV-4）、
 * 時間の単位と利用時間・申込の締め切りを確かめ、料金表で見積を出し、空き判定をして保存する。
 * 受け付けなかったときは何も保存しない
 */
export async function submitApplication(
  deps: ApplicationDeps,
  body: unknown,
): Promise<ApplicationResult> {
  void deps;
  void body;
  throw new Error("未実装");
}

/**
 * 申込のルート（POST /applications、認証なし）。
 * - 受付：201 と ApplicationAccepted
 * - 入力の誤り（JSON でない・契約に合わない）：400 と ApplicationRejected（invalid-input）
 * - ルールで不可（時間の単位と利用時間・申込の締め切り・空き判定）：422 と ApplicationRejected
 * - 混み合っている：503 と ApplicationRejected（busy）
 */
export function createPublicApplicationRoute(deps: ApplicationDeps): Hono {
  void deps;
  throw new Error("未実装");
}
