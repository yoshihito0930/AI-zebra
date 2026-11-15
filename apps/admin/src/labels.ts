// 画面に出す日本語の呼び名。契約（packages/contracts）の値から引く
import { currentPriceTable } from "@zebra/booking-core";
import type {
  AdminCustomerField,
  AdminDraftKind,
  AdminDraftStatus,
  AdminError,
  AdminWarning,
  ReservationStatus,
} from "@zebra/contracts";
import type { ApiFailure } from "./api.ts";

/** 予約の状態（booking.md「予約の状態」） */
export const statusLabel: Record<ReservationStatus, string> = {
  "pending-provisional": "承認待ち（仮）",
  "pending-firm": "承認待ち（本）",
  "pending-second-hold": "承認待ち（第二キープ）",
  provisional: "仮予約",
  firm: "本予約",
  "second-hold": "第二キープ",
  cancelled: "取消",
  ended: "終了",
};

export const reservationRouteLabel: Record<"form" | "admin", string> = {
  form: "フォーム",
  admin: "直接入力",
};

export const blockRouteLabel: Record<"admin" | "google-calendar", string> = {
  admin: "管理者",
  "google-calendar": "Googleカレンダー",
};

export const shootingTypeLabel: Record<"still" | "movie" | "music", string> = {
  still: "スチール撮影",
  movie: "ムービー撮影",
  music: "楽器の演奏を伴う撮影",
};

/** 下書きの種類（mail.md「下書きのテンプレート」） */
export const draftKindLabel: Record<AdminDraftKind, string> = {
  approval: "承認のお知らせ",
  rejection: "却下のお知らせ",
  promotion: "本予約への昇格のお知らせ",
  "second-hold-ended": "第二キープの終了のお知らせ",
  cancellation: "取消のお知らせ",
  "move-up-notice": "第二キープの繰り上げの案内",
  "bring-forward-notice": "第二キープの前倒しの案内",
  change: "変更のお知らせ",
};

/** 下書きの状態（mail.md「下書きの送り方」） */
export const draftStatusLabel: Record<AdminDraftStatus, string> = {
  unsent: "未送信",
  sent: "送信済み",
  skipped: "送らない",
};

/** 履歴の操作（reservation-model.md「履歴」） */
export const historyOperationLabel = {
  apply: "申込",
  approve: "承認",
  reject: "却下",
  promote: "昇格",
  end: "終了",
  cancel: "取消",
  "move-up": "繰り上げ",
  change: "変更",
  "buffer-change": "バッファの切り替え",
  "direct-entry": "直接入力",
  "customer-info-change": "お客様の情報の変更",
} as const;

export const customerFieldLabel: Record<AdminCustomerField, string> = {
  name: "氏名",
  companyName: "会社名",
  email: "メールアドレス",
  phone: "電話番号",
  address: "住所",
  photographerName: "カメラマン氏名",
  shootingTypes: "撮影内容",
  shootingDetails: "撮影詳細",
  shootingNotes: "補足事項",
};

export const warningLabel: Record<AdminWarning, string> = {
  "past-24-hours-before-start": "本予約の締め切り（開始の24時間前）を過ぎています",
  "past-provisional-deadline": "仮予約・第二キープの締め切りを過ぎています",
  "late-night-shorter-than-4-hours": "深夜帯にかかり、4時間より短い予約です",
};

/** API のエラーの理由（admin-api.md「返すときの決まり」）を、管理者に見せる文にする */
export const errorMessage: Record<AdminError, string> = {
  "invalid-input": "入力の形が正しくありません。",
  unauthorized:
    "管理者として認証されていません。手元では、API を DEV_ADMIN_USER_ID を付けて起動してください。",
  "not-found": "予約が見つかりません。",
  "not-pending": "承認待ちではないため、この操作はできません。画面を読み直してください。",
  "invalid-status": "今の状態の予約には、この操作はできません。画面を読み直してください。",
  "still-held": "まだ仮予約のまま重なっている仮予約が付いているため、繰り上げられません。",
  "not-changeable":
    "今の状態の予約は変更できません（変更とバッファの切り替えは、承認済みの仮予約・本予約だけです）。画面を読み直してください。",
  "draft-not-unsent":
    "未送信の下書きではないため（すでに送信済み・送らないにしてあります）、変えられません。送信済み・送らないにした下書きは、未送信に戻せません。",
  "google-calendar-block":
    "Googleカレンダーから取り込んだブロック枠は、直したり消したりできません。",
  "unacknowledged-warnings": "確認していない警告があります。",
  "not-on-30-minute-boundary": "時刻が30分単位ではありません。",
  "shorter-than-2-hours": "2時間より短い予約はできません。",
  "longer-than-24-hours": "24時間を超える予約はできません。",
  "overlaps-existing": "ほかの予約・ブロック枠と重なっています。",
  "no-provisional-to-hold": "第二キープが付く仮予約がありません。",
  "more-than-90-days":
    "ブロック枠がかかる日が90日を超えます（直すときは、直す前と直したあとを合わせて数えます）。分けて入れるか、消して入れ直してください。",
  busy: "混み合っています。少し待ってから、もう一度お試しください。",
};

/** 呼び出しの失敗を、管理者に見せる文にする */
export function failureMessage(failure: ApiFailure): string {
  switch (failure.kind) {
    case "rejected": {
      const warnings = (failure.warnings ?? []).map((w) => warningLabel[w]);
      return [errorMessage[failure.error], ...warnings].join(" ");
    }
    case "network":
      return "API に接続できませんでした。API（pnpm dev:api）が起動しているか確かめてください。";
    case "unexpected":
      return `API から思わぬ返事がありました（HTTP ${failure.status}）。API（pnpm dev:api）が起動しているか確かめてください。`;
  }
}

/** 下書きの読み込み・操作の失敗を、管理者に見せる文にする（ないときは「予約」ではなく「予約か下書き」と書く） */
export function draftFailureMessage(failure: ApiFailure): string {
  return failure.kind === "rejected" && failure.error === "not-found"
    ? "予約か下書きが見つかりません。未送信の下書きの一覧か、予約の詳細から開き直してください。"
    : failureMessage(failure);
}

const priceTable = currentPriceTable();

/** 料金表のプランの名前。今の料金表にない id は、id のまま出す */
export function planLabel(planId: string): string {
  return priceTable.plans.find((plan) => plan.id === planId)?.name ?? planId;
}

/** 料金表のオプションの名前。今の料金表にない id は、id のまま出す */
export function optionLabel(optionId: string): string {
  return priceTable.options.find((option) => option.id === optionId)?.name ?? optionId;
}
