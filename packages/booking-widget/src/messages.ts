// 申込を受け付けなかった理由（契約 ApplicationRejection）を、お客様向けの日本語にする。
// 送る前の画面の確かめ（booking-core の同じ関数）も、同じ理由の値と文面を使う
import type { ApplicationRejection } from "@zebra/contracts";

export const REJECTION_TEXT: Record<ApplicationRejection, string> = {
  "invalid-input": "入力の内容に誤りがあります。各欄を確かめてください。",
  "not-on-30-minute-boundary": "開始・終了の時刻は30分単位（:00 か :30）で選んでください。",
  "shorter-than-2-hours": "ご利用は2時間からです。",
  "late-night-shorter-than-4-hours":
    "深夜帯（23:00〜翌8:00）に少しでもかかるご利用は、4時間からです。",
  "longer-than-24-hours": "ご利用は24時間までです。",
  "past-24-hours-before-start": "ご利用の開始の24時間前を過ぎているため、申込めません。",
  "past-provisional-deadline":
    "仮予約の期限（利用日の7日前の18:00）を過ぎているため、仮予約・第二キープでは申込めません。空いていれば本予約で申込めます。",
  "overlaps-existing":
    "ご希望の時間は、ほかの予約と重なっています（予約と予約の間は1時間空けます）。カレンダーで空いている時間をお選びください。",
  "no-provisional-to-hold":
    "ご希望の時間と重なる仮予約がないため、第二キープとしては申込めません。カレンダーで時間をお確かめください。",
  busy: "ただいま混み合っています。少し時間をおいて、もう一度お送りください。",
};

/** 届かなかった・思った返事でなかったとき */
export const SEND_FAILED_TEXT =
  "送信できませんでした。通信の状態を確かめて、少し時間をおいてもう一度お送りください。";
