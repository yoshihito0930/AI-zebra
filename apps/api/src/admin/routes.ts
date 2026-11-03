// 管理 API（管理画面のスタッフだけ）のルート。1回目：予約の一覧・詳細、受付番号から探す、承認・却下・昇格・取消・繰り上げ。
// 形は docs/design-docs/admin-api.md、契約は packages/contracts の admin.ts。
// - GET  /admin/reservations?from=&to=&status=  一覧（AdminReservationListQuery → AdminReservationList）
// - GET  /admin/reservations/:id                詳細（AdminReservationDetail）
// - GET  /admin/receipts/:receiptNumber         受付番号から探す（AdminReceiptLookup）
// - POST /admin/reservations/:id/approve        承認（AdminApproveRequest → AdminOperationAccepted）
// - POST /admin/reservations/:id/reject|promote|cancel|move-up（AdminEmptyRequest → AdminOperationAccepted）
// エラーは AdminRejected（{ error: <理由> }）。管理者の id が取れないときは、どのルートも 401
import type { PriceTable } from "@zebra/contracts";
import type { Hono } from "hono";
import type { DateTime } from "luxon";
import type { SaveOperationOptions } from "../db/operations.ts";
import type { ReservationStore } from "../db/reservations.ts";
import type { AdminUserIdSource } from "./admin-user.ts";

export interface AdminDeps {
  store: ReservationStore;
  /** API の現在時刻（INV-7）。操作の日時、今の見積・今取消したときのキャンセル料の計算に使う */
  now: () => DateTime;
  /** 今の料金表。承認待ちの詳細で、見積を計算し直すのに使う */
  priceTable: PriceTable;
  /** 管理者の id の取り出し方（本番は adminUserIdFromLambdaContext、手元は devAdminUserId） */
  adminUserId: AdminUserIdSource;
  /** 操作の保存のやり直しの設定（混み合ったときの確認に使う） */
  save?: Pick<SaveOperationOptions, "maxAttempts" | "beforeWrite">;
}

export function createAdminRoute(deps: AdminDeps): Hono {
  void deps;
  throw new Error("未実装");
}
