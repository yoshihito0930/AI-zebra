// 下書きの文面を作る（docs/product-specs/mail.md「下書きのテンプレート」）。入出力を持たない関数。
// 文面は保存しない・ログに出さない（INV-10）。メールは送らない（INV-6。管理者が Gmail から送る）
// - テンプレートの文面は mail.md の各テンプレートの枠の中身をそのまま写す（行の単位。全角の空白も含む）
// - 強調の印（<赤>…</赤>、<青>…</青>、<下線>…</下線>）は、テキストでは外し、HTML では mail.md「強調の書き方」の span にする
// - 差し込む値（{氏名} など）は、強調の印を読んだあとに置き換える（値の中の文字を印として読まない）。HTML ではエスケープする
// - 日時はすべて JST で書く（INV-7。日時ライブラリは Luxon）。仮予約の期限は booking-core の provisionalDeadline で決める
import { provisionalDeadline } from "@zebra/booking-core";
import type { ShootingType, Yen } from "@zebra/contracts";
import type { DateTime } from "luxon";
import type { z } from "zod";

/** 撮影内容（スチール撮影・ムービー撮影・楽器の演奏を伴う撮影） */
export type DraftMailShootingType = z.infer<typeof ShootingType>;

/**
 * 下書きの種類と、下書きに差し込む値（下書きを作ったときの値。mail.md「下書きの送り方」）。
 * - approval：承認。approvedAs は、どの承認のテンプレートを使うか（本予約・仮予約・第二キープ）
 * - cancellation：取消。cancellationFee は下書きに差し込んだキャンセル料
 * - move-up-notice：繰り上げの案内。remainingProvisionalIds は、まだ付いている仮予約の id
 */
export type DraftMailContent =
  | { kind: "approval"; approvedAs: "firm" | "provisional" | "second-hold" }
  | { kind: "rejection" }
  | { kind: "promotion" }
  | { kind: "second-hold-ended" }
  | { kind: "cancellation"; cancellationFee: { ratePercent: number; fee: Yen } }
  | { kind: "move-up-notice"; remainingProvisionalIds: readonly string[] }
  | { kind: "bring-forward-notice" }
  | { kind: "change" };

/** 下書きを開いたときの予約の内容（mail.md「文面は、下書きを開いたときの予約の内容で作る」） */
export interface DraftMailReservation {
  /** 予約区間（バッファを含まない）。どのゾーンで渡しても、JST で書く（INV-7） */
  start: DateTime;
  end: DateTime;
  partySize: number;
  equipmentInsurance: boolean;
  customer: {
    name: string;
    photographerName?: string | undefined;
  };
  shooting: {
    types?: readonly DraftMailShootingType[] | undefined;
    details?: string | undefined;
  };
}

export interface DraftMailInput {
  draft: DraftMailContent;
  reservation: DraftMailReservation;
  /** 担当者名（MAIL_STAFF_NAME）。なければ「（担当者名）」と出す */
  staffName?: string | undefined;
  /** 署名（MAIL_SIGNATURE。改行を含む）。なければ「--」の行から下を出さない */
  signature?: string | undefined;
}

/**
 * 作った文面。
 * - text：強調の印を除いた本文（改行は "\n"）
 * - html：強調を赤字・青字・下線の span にし、改行を <br> にした本文。差し込む値は HTML のエスケープをする
 * - attachConsentForm：同意書を Gmail で添付するか（本予約の承認と昇格）
 */
export interface DraftMail {
  subject: string;
  text: string;
  html: string;
  attachConsentForm: boolean;
}

export function renderDraftMail(input: DraftMailInput): DraftMail {
  const template = templateOf(input.draft);
  const values = valuesOf(input);
  const lines = expandLines(template.lines, input);
  const rendered = lines.map((line) => renderLine(line, values));
  return {
    subject: renderSubject(template.subject, values),
    text: rendered.map((segments) => segments.map((s) => s.text).join("")).join("\n"),
    html: rendered.map((segments) => segments.map(segmentHtml).join("")).join("<br>"),
    attachConsentForm: template.attachConsentForm,
  };
}

// ---- テンプレート（mail.md「下書きのテンプレート」から写す） ----

/** テンプレートの中で、共通の部分や条件つきの行に置き換える行（mail.md「共通の部分」「取消」「繰り上げの案内」） */
const RESERVATION_DETAILS_LINE = "（ご予約内容）";
const NOTICES_LINE = "（注意事項）";
const CLOSING_LINE = "（結び）";
const CANCELLATION_FEE_LINE = "（キャンセル料）";
const OTHER_PROVISIONALS_LINE = "（ほかの仮予約）";

/** ご予約内容（本予約の承認・昇格・変更で使う） */
const RESERVATION_DETAILS: readonly string[] = [
  "◇ ご予約内容 ◇",
  "ご予約日時：{予約日時}（{利用時間}）",
  "撮影内容：{撮影内容}",
  "ご利用人数：{人数}名様",
  "カメラマン様：{カメラマン}",
  "機材保険：{機材保険}",
];

/** 注意事項（本予約の承認・昇格で使う）。ホリゾントの注意事項は、養生の有無にかかわらずいつも書く */
const NOTICES: readonly string[] = [
  "◆ 注意事項 ◆",
  "",
  "〈ホリゾントの床面が露出した状態でご利用の場合の注意事項〉",
  "",
  "・<赤>撮影当日に履いていらっしゃった靴のご使用は禁止です。</赤>",
  "　被写体の方の靴は別途ご用意いただき、新品・内履きにかかわらず",
  "　養生テープでの養生をお願いします。",
  "　※ガムテープや色付きのビニールテープはご使用不可。",
  "　※やむを得ず、当日履いてきた靴をご使用になる場合は、¥550(税込)／1足にて",
  "　 ご使用可能とさせていただきます。",
  "",
  "・<青>撮影者様・スタイリスト様など、ホリゾント内にお入りになる方は</青>",
  "　<青>デニム等の色落ちするボトムの着用をお控えください。</青>",
  "",
  "・<下線>ブーツなど、ソール部分が厚い靴</下線>はホリゾントを著しく汚損する恐れがございますので",
  "　ポージングの際には十分ご注意ください。",
  "",
  "〈その他〉",
  "",
  "・ご予約時間の5分前よりご入室いただけます。",
  "　ご退室時は現状復帰をお願いいたします。",
  "　なお、ご予約終了時間を5分以上超過した場合は、追加料金が発生いたします。",
  "",
  "・スタジオ専用の、駐車場・駐輪場のご用意はございません。",
  "　近隣のコインパーキングや公共の駐輪場等をご利用ください。",
  "　<赤>※スタジオが入っている建物周辺への駐輪は厳禁です。</赤>",
  "",
  "・スタジオのある建物内および周辺の路上は禁煙です。",
  "　防犯カメラ等により喫煙が確認された場合、建物の管理人より連絡が入り",
  "　撮影が中断となる可能性がございますのでご注意ください。",
  "",
  "・ご利用料金は、ご利用当日に現金またはクレジットカードにてお支払いください。",
];

/** 結び（どのテンプレートも最後に付ける）。{署名} の設定がなければ「--」の行から下を出さない */
const CLOSING: readonly string[] = ["{担当者名}", "", "--", "{署名}"];

/** 承認（本予約） */
const FIRM_APPROVAL: readonly string[] = [
  "{氏名}様",
  "",
  "お世話になっております。",
  "スタジオゼブラの{担当者名}です。",
  "",
  "この度はスタジオ利用のお申し込みをありがとうございます。",
  "",
  "",
  "【{予約日時}】にて、本予約を承りました。",
  "",
  "",
  "＊ ＊ ＊ ＊ ＊ ＊",
  "",
  "それでは、ご予約内容とスタジオご利用時の注意事項をお送りいたします。",
  "あわせて同意書を添付しておりますので、事前にご確認ください。",
  "（スタジオご利用の当日に、サイン用の原本をお渡しいたします）",
  "",
  "また、下記の注意事項につきましては、ご利用前に必ずご確認いただき",
  "撮影に参加される皆様にも共有をお願いします。",
  "",
  "☆靴のご利用につきましては、条件を必ずお守りください☆",
  "",
  "ーーーーーーーーーー",
  "",
  "（ご予約内容）",
  "",
  "＊本予約受付後の時間変更・キャンセルには、キャンセル料が発生します。",
  "",
  "ーーーーーーーーーー",
  "",
  "（注意事項）",
  "",
  "ーーーーーーーーーー",
  "",
  "ご不明な点がございましたらお気軽にご連絡いただけますと幸いです。",
  "どうぞよろしくお願いいたします。",
  "",
  "（結び）",
];

/** 承認（仮予約） */
const PROVISIONAL_APPROVAL: readonly string[] = [
  "{氏名}様",
  "",
  "いつもお世話になっております。",
  "スタジオゼブラの{担当者名}です。",
  "",
  "この度は仮予約のお申し込みをありがとうございます。",
  "",
  "【{予約日時}】にて、仮予約を承りました。",
  "",
  "ご利用のご決定につきましては、",
  "【{仮予約の期限}まで】にご連絡いただけますと幸いです。",
  "",
  "（ご利用日が近くなりましたら、こちらからご連絡をさせていただくかもしれません）",
  "",
  "お手数をおかけいたしますが、何卒よろしくお願い申し上げます。",
  "",
  "（結び）",
];

/** 承認（第二キープ） */
const SECOND_HOLD_APPROVAL: readonly string[] = [
  "{氏名}様",
  "",
  "いつもお世話になっております。",
  "スタジオゼブラの{担当者名}です。",
  "",
  "この度はお申し込みをありがとうございます。",
  "",
  "【{予約日時}】にて、第二キープを承りました。",
  "",
  "ご希望の日時には、先に仮予約をいただいているお客様がいらっしゃいます。",
  "仮予約のお客様がキャンセルされた場合は、こちらからご連絡し、",
  "仮予約へ繰り上げのご案内をいたします。",
  "仮予約のお客様がご利用を決定された場合は、第二キープは終了となります。その際もご連絡いたします。",
  "",
  "何卒よろしくお願い申し上げます。",
  "",
  "（結び）",
];

/** 却下 */
const REJECTION: readonly string[] = [
  "{氏名}様",
  "",
  "お世話になっております。",
  "スタジオゼブラの{担当者名}です。",
  "",
  "この度はお申し込みをありがとうございます。",
  "",
  "誠に申し訳ございませんが、【{予約日時}】のお申し込みは",
  "お受けすることができませんでした。",
  "",
  "またの機会にご利用いただけますと幸いです。",
  "何卒よろしくお願い申し上げます。",
  "",
  "（結び）",
];

/** 取消 */
const CANCELLATION: readonly string[] = [
  "{氏名}様",
  "",
  "お世話になっております。",
  "スタジオゼブラの{担当者名}です。",
  "",
  "【{予約日時}】のご予約のキャンセルを承りました。",
  "",
  "（キャンセル料）",
  "",
  "またの機会にご利用いただけますと幸いです。",
  "何卒よろしくお願い申し上げます。",
  "",
  "（結び）",
];

/** 取消の（キャンセル料）。本予約の取消で、キャンセル料が1円以上のときだけ */
const CANCELLATION_FEE: readonly string[] = [
  "キャンセル料として、{キャンセル料}を申し受けます。",
  "お支払い方法につきましては、追ってご連絡いたします。",
];

/** 変更 */
const CHANGE: readonly string[] = [
  "{氏名}様",
  "",
  "お世話になっております。",
  "スタジオゼブラの{担当者名}です。",
  "",
  "ご予約内容の変更を承りました。",
  "変更後のご予約内容は下記のとおりです。",
  "",
  "ーーーーーーーーーー",
  "",
  "（ご予約内容）",
  "",
  "ーーーーーーーーーー",
  "",
  "ご不明な点がございましたらお気軽にご連絡いただけますと幸いです。",
  "どうぞよろしくお願いいたします。",
  "",
  "（結び）",
];

/** 第二キープの終了 */
const SECOND_HOLD_ENDED: readonly string[] = [
  "{氏名}様",
  "",
  "お世話になっております。",
  "スタジオゼブラの{担当者名}です。",
  "",
  "【{予約日時}】の第二キープについてご連絡いたします。",
  "",
  "先に仮予約をいただいていたお客様がご利用を決定されたため、",
  "誠に申し訳ございませんが、第二キープは終了となりました。",
  "",
  "またの機会にご利用いただけますと幸いです。",
  "何卒よろしくお願い申し上げます。",
  "",
  "（結び）",
];

/** 繰り上げの案内 */
const MOVE_UP_NOTICE: readonly string[] = [
  "{氏名}様",
  "",
  "お世話になっております。",
  "スタジオゼブラの{担当者名}です。",
  "",
  "【{予約日時}】の第二キープについてご連絡いたします。",
  "",
  "先に仮予約をいただいていたお客様の予定が変わり、",
  "第二キープを仮予約へ繰り上げてご案内できるようになりました。",
  "",
  "（ほかの仮予約）",
  "",
  "繰り上げをご希望の場合は、ご連絡いただけますと幸いです。",
  "何卒よろしくお願い申し上げます。",
  "",
  "（結び）",
];

/** 繰り上げの案内の（ほかの仮予約）。残っている仮予約が1件以上のときだけ */
const OTHER_PROVISIONALS: readonly string[] = [
  "ただし、ご希望の日時にはほかにも仮予約をいただいているお客様がいらっしゃるため、",
  "すぐには繰り上げができません。状況が変わりましたら、あらためてご連絡いたします。",
];

/** 前倒しの案内 */
const BRING_FORWARD_NOTICE: readonly string[] = [
  "{氏名}様",
  "",
  "お世話になっております。",
  "スタジオゼブラの{担当者名}です。",
  "",
  "【{予約日時}】のご予約についてご連絡いたします。",
  "",
  "ご予約の直前の時間帯に空きが出たため、",
  "ご希望であれば、開始時間を早めることができる場合がございます。",
  "",
  "ご希望の場合は、ご連絡いただけますと幸いです。",
  "何卒よろしくお願い申し上げます。",
  "",
  "（結び）",
];

/**
 * 昇格（仮予約から本予約へ）：本文は「承認（本予約）」と同じで、2つの文だけを変える（mail.md「昇格（仮予約から本予約へ）」）
 */
const PROMOTION_REPLACEMENTS: ReadonlyMap<string, string> = new Map([
  [
    "この度はスタジオ利用のお申し込みをありがとうございます。",
    "ご利用のご決定のご連絡をありがとうございます。",
  ],
  [
    "【{予約日時}】にて、本予約を承りました。",
    "【{予約日時}】にて、仮予約から本予約に切り替えました。",
  ],
]);

const PROMOTION: readonly string[] = FIRM_APPROVAL.map(
  (line) => PROMOTION_REPLACEMENTS.get(line) ?? line,
);

/** 件名はどれも「{予約日時}の…（スタジオゼブラ）」の形（mail.md「日時の書き方」） */
const SUBJECT_SUFFIX = "（スタジオゼブラ）";

interface Template {
  /** 件名の「{予約日時}の」に続く部分（「（スタジオゼブラ）」の前まで） */
  readonly subject: string;
  readonly lines: readonly string[];
  /** 同意書を Gmail で添付するか（本予約の承認と昇格。mail.md「下書きの送り方」） */
  readonly attachConsentForm: boolean;
}

function templateOf(draft: DraftMailContent): Template {
  switch (draft.kind) {
    case "approval":
      return approvalTemplate(draft.approvedAs);
    case "rejection":
      return { subject: "お申し込みについて", lines: REJECTION, attachConsentForm: false };
    case "promotion":
      return { subject: "本予約を承りました", lines: PROMOTION, attachConsentForm: true };
    case "cancellation":
      return {
        subject: "ご予約のキャンセルを承りました",
        lines: CANCELLATION,
        attachConsentForm: false,
      };
    case "change":
      // 件名の日時は、変更したあとの日時（開いたときの予約の内容で作るので、そのまま今の予約区間）
      return { subject: "ご予約の変更を承りました", lines: CHANGE, attachConsentForm: false };
    case "second-hold-ended":
      return {
        subject: "第二キープについて",
        lines: SECOND_HOLD_ENDED,
        attachConsentForm: false,
      };
    case "move-up-notice":
      return {
        subject: "第二キープの繰り上げのご案内",
        lines: MOVE_UP_NOTICE,
        attachConsentForm: false,
      };
    case "bring-forward-notice":
      return {
        subject: "ご予約の開始時間について",
        lines: BRING_FORWARD_NOTICE,
        attachConsentForm: false,
      };
  }
}

/** 承認の3つのテンプレートは、承認したときの状態で選ぶ（どの状態だったかは呼び出す側が決める。mail.md「承認（本予約）」） */
function approvalTemplate(approvedAs: "firm" | "provisional" | "second-hold"): Template {
  switch (approvedAs) {
    case "firm":
      return { subject: "本予約を承りました", lines: FIRM_APPROVAL, attachConsentForm: true };
    case "provisional":
      return {
        subject: "仮予約を承りました",
        lines: PROVISIONAL_APPROVAL,
        attachConsentForm: false,
      };
    case "second-hold":
      return {
        subject: "第二キープを承りました",
        lines: SECOND_HOLD_APPROVAL,
        attachConsentForm: false,
      };
  }
}

// ---- 共通の部分・条件つきの行の展開 ----

/**
 * テンプレートの「（ご予約内容）」「（注意事項）」「（結び）」「（キャンセル料）」「（ほかの仮予約）」の行を、中身に置き換える。
 * 条件に合わず出さない行（キャンセル料・ほかの仮予約）は、行ごと出さない。そのときは、続く空行も1つ除く
 * （前後の空行が2つ続いて、段落の間が広がらないように）
 */
function expandLines(lines: readonly string[], input: DraftMailInput): string[] {
  const expanded: string[] = [];
  let skipNextBlank = false;
  for (const line of lines) {
    if (skipNextBlank) {
      skipNextBlank = false;
      if (line === "") continue;
    }
    const replacement = blockOf(line, input);
    if (replacement === undefined) {
      expanded.push(line);
    } else if (replacement.length === 0) {
      skipNextBlank = true;
    } else {
      expanded.push(...replacement);
    }
  }
  return expanded;
}

/** 置き換える行なら中身（出さないなら空）。置き換えない行なら undefined */
function blockOf(line: string, input: DraftMailInput): readonly string[] | undefined {
  switch (line) {
    case RESERVATION_DETAILS_LINE:
      return RESERVATION_DETAILS;
    case NOTICES_LINE:
      return NOTICES;
    case CLOSING_LINE:
      // {署名} の設定がなければ、「--」の行から下を出さない（担当者名の行で終わる）
      return signatureOf(input) === undefined ? CLOSING.slice(0, 1) : CLOSING;
    case CANCELLATION_FEE_LINE:
      // 本予約の取消で、キャンセル料がかかるとき（1円以上）だけ。仮予約・第二キープの取消は 0円
      return input.draft.kind === "cancellation" && input.draft.cancellationFee.fee >= 1
        ? CANCELLATION_FEE
        : [];
    case OTHER_PROVISIONALS_LINE:
      // まだ付いている仮予約が残っているときだけ
      return input.draft.kind === "move-up-notice" && input.draft.remainingProvisionalIds.length > 0
        ? OTHER_PROVISIONALS
        : [];
    default:
      return undefined;
  }
}

// ---- 差し込む値（mail.md「差し込む値」） ----

const JST = "Asia/Tokyo";

/** 担当者名の設定がないときに出す文字（管理者が Gmail で直す） */
const STAFF_NAME_PLACEHOLDER = "（担当者名）";

/** 撮影内容の名前と並び（申込フォームと同じ。mail.md「撮影内容の名前は…並びはこの順」） */
const SHOOTING_TYPE_NAMES: readonly (readonly [DraftMailShootingType, string])[] = [
  ["still", "スチール撮影"],
  ["movie", "ムービー撮影"],
  ["music", "楽器の演奏を伴う撮影"],
];

/** 曜日（Luxon の weekday は 1 が月曜、7 が日曜） */
const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"] as const;

type Values = ReadonlyMap<string, string>;

function valuesOf(input: DraftMailInput): Values {
  const { reservation, draft } = input;
  const values = new Map<string, string>([
    ["氏名", reservation.customer.name],
    ["担当者名", staffNameOf(input)],
    ["予約日時", reservationTimeText(reservation.start, reservation.end)],
    ["利用時間", durationText(reservation.start, reservation.end)],
    ["撮影内容", shootingText(reservation.shooting)],
    ["人数", String(reservation.partySize)],
    ["カメラマン", photographerText(reservation.customer.photographerName)],
    ["機材保険", reservation.equipmentInsurance ? "ご付帯" : "-"],
    ["仮予約の期限", deadlineText(provisionalDeadline(reservation.start))],
  ]);
  const signature = signatureOf(input);
  if (signature !== undefined) values.set("署名", signature);
  if (draft.kind === "cancellation") {
    values.set("キャンセル料", cancellationFeeText(draft.cancellationFee));
  }
  return values;
}

function staffNameOf(input: DraftMailInput): string {
  return input.staffName === undefined || input.staffName === ""
    ? STAFF_NAME_PLACEHOLDER
    : input.staffName;
}

function signatureOf(input: DraftMailInput): string | undefined {
  return input.signature === undefined || input.signature === "" ? undefined : input.signature;
}

/** JST に直す（INV-7）。どのゾーンで渡しても同じ時点の JST */
function inJst(dateTime: DateTime): DateTime {
  const jst = dateTime.setZone(JST);
  if (!jst.isValid) throw new RangeError("日時が不正");
  return jst;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function weekdayOf(dateTime: DateTime): string {
  const weekday = WEEKDAYS[dateTime.weekday - 1];
  if (weekday === undefined) throw new RangeError("曜日が不正");
  return weekday;
}

/** 時は0を付けず、分は2桁（「9時00分」） */
function clockText(dateTime: DateTime): string {
  return `${dateTime.hour}時${pad2(dateTime.minute)}分`;
}

/**
 * {予約日時}：「2026年10月20日(火) 15時00分〜17時00分」。
 * 終わりが開始の次の日（JST）なら、終わりの前に「翌」を付ける（0時ちょうどに終わるときも「翌0時00分」）
 */
function reservationTimeText(start: DateTime, end: DateTime): string {
  const s = inJst(start);
  const e = inJst(end);
  const nextDay = e.startOf("day").toMillis() > s.startOf("day").toMillis();
  return (
    `${s.year}年${s.month}月${s.day}日(${weekdayOf(s)}) ${clockText(s)}` +
    `〜${nextDay ? "翌" : ""}${clockText(e)}`
  );
}

/** {利用時間}：「2時間」「2時間30分」 */
function durationText(start: DateTime, end: DateTime): string {
  const minutes = Math.round((end.toMillis() - start.toMillis()) / 60_000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest}分`;
  return rest === 0 ? `${hours}時間` : `${hours}時間${rest}分`;
}

/** {仮予約の期限}：「10月13日(火)の18時」の形 */
function deadlineText(deadline: DateTime): string {
  const d = inJst(deadline);
  const minutes = d.minute === 0 ? "" : `${pad2(d.minute)}分`;
  return `${d.month}月${d.day}日(${weekdayOf(d)})の${d.hour}時${minutes}`;
}

/**
 * {撮影内容}：選んだ撮影内容を「・」でつなぎ（申込フォームの順）、撮影詳細があれば後ろに（）で付ける。
 * 撮影内容がなく撮影詳細だけなら撮影詳細だけ、どちらもなければ「-」
 */
function shootingText(shooting: DraftMailReservation["shooting"]): string {
  const selected = new Set(shooting.types ?? []);
  const names = SHOOTING_TYPE_NAMES.filter(([type]) => selected.has(type))
    .map(([, name]) => name)
    .join("・");
  const details =
    shooting.details === undefined || shooting.details === "" ? undefined : shooting.details;
  if (names === "") return details ?? "-";
  return details === undefined ? names : `${names}（${details}）`;
}

/** {カメラマン}：カメラマン氏名に「様」を付けたもの。なければ「-」 */
function photographerText(name: string | undefined): string {
  return name === undefined || name === "" ? "-" : `${name}様`;
}

/** {キャンセル料}：「5,500円（ご利用料金の50%）」の形 */
function cancellationFeeText(fee: { readonly ratePercent: number; readonly fee: Yen }): string {
  return `${withThousandsSeparators(fee.fee)}円（ご利用料金の${fee.ratePercent}%）`;
}

/** 整数の円を3桁ごとのカンマ区切りにする（INV-9。金額は整数のまま扱い、ロケールに頼らない） */
function withThousandsSeparators(amount: number): string {
  if (!Number.isSafeInteger(amount)) throw new RangeError("金額が整数でない");
  return String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// ---- 行の組み立て（強調の印と差し込む値） ----

type Emphasis = "red" | "blue" | "underline";

interface Segment {
  readonly text: string;
  readonly emphasis?: Emphasis;
}

const EMPHASIS_MARKERS: ReadonlyMap<string, Emphasis> = new Map([
  ["赤", "red"],
  ["青", "blue"],
  ["下線", "underline"],
]);

/** HTML の強調（mail.md「強調の書き方」） */
const EMPHASIS_STYLES: Readonly<Record<Emphasis, string>> = {
  red: "color:#ff0000",
  blue: "color:#0000ff",
  underline: "text-decoration:underline",
};

/** テンプレートの強調の印。印の中に印は入れない（mail.md のテンプレートにない） */
const EMPHASIS_PATTERN = /<(赤|青|下線)>(.*?)<\/\1>/gu;

/** 差し込む値の印 */
const PLACEHOLDER_PATTERN = /\{([^{}]+)\}/gu;

/**
 * テンプレートの1行を、強調の印で区切り、差し込む値を置き換える。強調の印はテンプレートの文字だけから読み、
 * 値を置き換えるのはそのあと（値の中の「<赤>」や「{氏名}」のような文字は、そのまま文字として出る）
 */
function renderLine(line: string, values: Values): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of line.matchAll(EMPHASIS_PATTERN)) {
    const [whole, marker = "", inner = ""] = match;
    if (match.index > last) segments.push({ text: line.slice(last, match.index) });
    const emphasis = EMPHASIS_MARKERS.get(marker);
    if (emphasis === undefined) throw new Error("テンプレートの強調の印が不正");
    segments.push({ text: inner, emphasis });
    last = match.index + whole.length;
  }
  if (last < line.length) segments.push({ text: line.slice(last) });
  return segments.map((segment) => {
    const text = fillPlaceholders(segment.text, values);
    if (/<\/?(赤|青|下線)>/u.test(segment.text)) {
      throw new Error("テンプレートの強調の印が閉じていない");
    }
    return segment.emphasis === undefined ? { text } : { text, emphasis: segment.emphasis };
  });
}

function fillPlaceholders(template: string, values: Values): string {
  return template.replace(PLACEHOLDER_PATTERN, (_, name: string) => {
    const value = values.get(name);
    // テンプレートにある印は、どれも値を持つ（ない印はテンプレートの誤り）。印の名前だけを書き、値は書かない
    if (value === undefined) throw new Error(`テンプレートの差し込む値がない（${name}）`);
    return value;
  });
}

function renderSubject(subject: string, values: Values): string {
  return `${fillPlaceholders("{予約日時}の", values)}${subject}${SUBJECT_SUFFIX}`;
}

/** HTML の1区切り：エスケープし、値の中の改行（署名など）も <br> にする。強調は span で囲む */
function segmentHtml(segment: Segment): string {
  const html = escapeHtml(segment.text).replaceAll("\n", "<br>");
  return segment.emphasis === undefined
    ? html
    : `<span style="${EMPHASIS_STYLES[segment.emphasis]}">${html}</span>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
