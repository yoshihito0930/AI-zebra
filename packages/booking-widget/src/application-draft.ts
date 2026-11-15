// 申込フォームの入力から、利用日時・予約の種類・見積額・送る前の確かめ・送る本文を求める（入出力を持たない）。
// 判定と見積は booking-core の関数を使う（API と同じ計算。TECH_STACK.md）。最後の判定は API が行う。
// - 日時は JST で入力を受け取り、送るときはオフセット付きの ISO 8601 にする（INV-7）
// - 金額は booking-core が返す整数の円をそのまま使う（INV-9）
// - カレンダーから分かるのは表示名と時間だけ（INV-3）。承認待ちかどうかやバッファの長さは分からないので、推測しない
import {
  calculatePriceFromTable,
  checkApplicationDeadline,
  checkSecondHoldApplicationDeadline,
  checkTimeUnitAndDuration,
  decidePlanId,
  provisionalDeadline,
} from "@zebra/booking-core";
import {
  ApplicationRequest,
  type ApplicationRejection,
  type PriceTable,
  type Yen,
} from "@zebra/contracts";
import { DateTime } from "luxon";
import { JST, toJst, type PublicBooking } from "./format.ts";

export type ShootingTypeValue = ApplicationRequest["shooting"]["types"][number];

/** 撮影内容の選択肢（booking.md「申込フォーム」） */
export const SHOOTING_TYPES: readonly { value: ShootingTypeValue; text: string }[] = [
  { value: "still", text: "スチール撮影" },
  { value: "movie", text: "ムービー撮影" },
  { value: "music", text: "楽器の演奏を伴う撮影（制限あり）" },
];

/** フォームで受けるご利用人数の上限（15人以上は問い合わせに案内する。booking.md「申込フォーム」） */
export const MAX_PARTY_SIZE = 14;

/** フォームの入力（画面の値そのまま。選んでいない欄は空文字） */
export interface FormValues {
  /** 予約の種類。第二キープは選ばせず、希望日時が「仮予約」と重なるときにフォームが切り替える */
  kind: "" | "firm" | "provisional";
  /** 利用日（JST、YYYY-MM-DD） */
  date: string;
  /** 開始・終了の時刻（JST、HH:mm）。終了が開始以前なら翌日の時刻とする */
  startTime: string;
  endTime: string;
  partySize: string;
  cycloramaFloorProtection: "" | "yes" | "no";
  equipmentInsurance: boolean;
  optionIds: string[];
  name: string;
  companyName: string;
  email: string;
  phone: string;
  address: string;
  photographerName: string;
  shootingTypes: ShootingTypeValue[];
  shootingDetails: string;
  notes: string;
  agreedToCycloramaRules: boolean;
  agreedToTerms: boolean;
}

export const emptyFormValues = (date = ""): FormValues => ({
  kind: "",
  date,
  startTime: "",
  endTime: "",
  partySize: "",
  cycloramaFloorProtection: "",
  equipmentInsurance: false,
  optionIds: [],
  name: "",
  companyName: "",
  email: "",
  phone: "",
  address: "",
  photographerName: "",
  shootingTypes: [],
  shootingDetails: "",
  notes: "",
  agreedToCycloramaRules: false,
  agreedToTerms: false,
});

/** 開始・終了の時刻の選択肢（JST の 0:00〜23:30、30分ごと。「時間の単位と利用時間」） */
export const TIME_OPTIONS: readonly string[] = Array.from({ length: 48 }, (_, index) =>
  // 夏時間のあるゾーンでも時刻が飛ばないよう、UTC で並べる（時刻の文字列だけを使う）
  DateTime.fromObject({ hour: 0, minute: 0 }, { zone: "UTC" })
    .plus({ minutes: index * 30 })
    .toFormat("HH:mm"),
);

export interface TimeRange {
  readonly start: DateTime;
  readonly end: DateTime;
}

/**
 * 利用日と開始・終了の時刻から、予約区間を作る（JST）。終了の時刻が開始以前なら、終了は翌日。
 * 日・時刻のどれかがなければ undefined
 */
export function rangeOf(values: Pick<FormValues, "date" | "startTime" | "endTime">) {
  if (values.date === "" || values.startTime === "" || values.endTime === "") return undefined;
  const start = DateTime.fromISO(`${values.date}T${values.startTime}`, { zone: JST });
  let end = DateTime.fromISO(`${values.date}T${values.endTime}`, { zone: JST });
  if (!start.isValid || !end.isValid) return undefined;
  if (end.toMillis() <= start.toMillis()) end = end.plus({ days: 1 });
  return { start, end } satisfies TimeRange;
}

/**
 * 希望の予約区間と、カレンダーに出ている予約の時間（バッファを含まない）との重なり（半開区間）。
 * - other：本予約・第二キープ・予約不可と重なる（どの種類でも申込めない）
 * - provisional：「仮予約」とだけ重なる（第二キープとして申込む）
 * - none：重ならない（予約の間の1時間は、バッファの長さが分からないので確かめない。API が判定する）
 */
export function overlapOf(
  range: TimeRange,
  bookings: readonly PublicBooking[],
): "none" | "provisional" | "other" {
  const overlapping = bookings.filter(
    (booking) =>
      range.start.toMillis() < toJst(booking.end).toMillis() &&
      toJst(booking.start).toMillis() < range.end.toMillis(),
  );
  if (overlapping.length === 0) return "none";
  return overlapping.every((booking) => booking.label === "provisional") ? "provisional" : "other";
}

/** 入力から求めたもの */
export interface Draft {
  readonly range: TimeRange | undefined;
  /** 送る予約の種類。決まらなければ undefined */
  readonly kind: ApplicationRequest["kind"] | undefined;
  /** 希望日時が「仮予約」とだけ重なり、第二キープとして申込む */
  readonly secondHold: boolean;
  /** 仮予約の期限（利用日の7日前の18:00）。日時が決まらなければ undefined */
  readonly provisionalDeadline: DateTime | undefined;
  /** 仮予約を選べるか（仮予約の期限の前か） */
  readonly provisionalSelectable: boolean;
  /** 送る前に分かる、申込めない理由（API の理由と同じ値） */
  readonly problems: readonly ApplicationRejection[];
  /** 見積（税込）とプランの名前。日時・人数・ホリゾントの養生が決まらなければ undefined */
  readonly estimate: { readonly estimateIncludingTax: Yen; readonly planName: string } | undefined;
}

/** 入力・現在時刻・カレンダーの予約から、送る前の状態を求める */
export function draftOf(
  values: FormValues,
  options: { now: DateTime; bookings: readonly PublicBooking[]; priceTable: PriceTable },
): Draft {
  const range = rangeOf(values);
  const deadline = range === undefined ? undefined : provisionalDeadline(range.start);
  const provisionalSelectable =
    deadline === undefined || options.now.toMillis() < deadline.toMillis();

  const overlap = range === undefined ? "none" : overlapOf(range, options.bookings);
  const secondHold = overlap === "provisional";
  const kind = secondHold ? "second-hold" : values.kind === "" ? undefined : values.kind;

  const problems: ApplicationRejection[] = [];
  let timeUnitOk = false;
  if (range !== undefined) {
    const timeUnit = checkTimeUnitAndDuration(range.start, range.end);
    timeUnitOk = timeUnit.ok;
    if (!timeUnit.ok) problems.push(timeUnit.reason);
    if (overlap === "other") problems.push("overlaps-existing");
    if (kind !== undefined) {
      const result =
        kind === "second-hold"
          ? checkSecondHoldApplicationDeadline({ start: range.start, appliedAt: options.now })
          : checkApplicationDeadline({ kind, start: range.start, appliedAt: options.now });
      if (!result.ok) problems.push(result.reason);
    }
  }

  let estimate: Draft["estimate"];
  if (
    range !== undefined &&
    timeUnitOk &&
    values.partySize !== "" &&
    values.cycloramaFloorProtection !== ""
  ) {
    const planId = decidePlanId(options.priceTable, {
      partySize: Number(values.partySize),
      cycloramaFloorProtection: values.cycloramaFloorProtection === "yes",
    });
    const quote = calculatePriceFromTable(options.priceTable, {
      planId,
      start: range.start,
      end: range.end,
      equipmentInsurance: values.equipmentInsurance,
      optionIds: values.optionIds,
    });
    const planName = options.priceTable.plans.find((plan) => plan.id === planId)?.name ?? planId;
    estimate = { estimateIncludingTax: quote.estimateIncludingTax, planName };
  }

  return {
    range,
    kind,
    secondHold,
    provisionalDeadline: deadline,
    provisionalSelectable,
    problems,
    estimate,
  };
}

/** 各欄の呼び名（契約のキーから。入力の誤りを知らせるときに使う） */
const FIELD_TEXT: Record<string, string> = {
  kind: "予約の種類",
  start: "ご希望の利用日時",
  end: "ご希望の利用日時",
  partySize: "ご利用人数",
  cycloramaFloorProtection: "ホリゾントの養生",
  equipmentInsurance: "機材保険",
  optionIds: "オプション",
  "customer.name": "氏名",
  "customer.companyName": "会社名",
  "customer.email": "メールアドレス",
  "customer.phone": "電話番号",
  "customer.address": "住所",
  "customer.photographerName": "カメラマン氏名",
  "shooting.types": "撮影内容",
  "shooting.details": "撮影詳細",
  "shooting.notes": "補足事項",
  agreedToCycloramaRules: "ホリゾントルールの確認",
  agreedToTerms: "利用規約への同意",
};

const optional = (value: string) => (value.trim() === "" ? {} : { value: value.trim() });

/** 日時をオフセット付きの ISO 8601 にする（JST の +09:00。INV-7） */
function isoOf(dateTime: DateTime): string | undefined {
  return dateTime.setZone(JST).toISO({ suppressMilliseconds: true }) ?? undefined;
}

/**
 * 送る本文を契約（ApplicationRequest）でパースする（INV-4）。
 * 契約に合わなければ、誤りのある欄の呼び名（重ねない、フォームの順）を返す
 */
export function buildRequest(
  values: FormValues,
  draft: Draft,
): { ok: true; request: ApplicationRequest } | { ok: false; fields: string[] } {
  const company = optional(values.companyName);
  const notes = optional(values.notes);
  const candidate = {
    kind: draft.kind,
    start: draft.range === undefined ? undefined : isoOf(draft.range.start),
    end: draft.range === undefined ? undefined : isoOf(draft.range.end),
    partySize: values.partySize === "" ? undefined : Number(values.partySize),
    cycloramaFloorProtection:
      values.cycloramaFloorProtection === ""
        ? undefined
        : values.cycloramaFloorProtection === "yes",
    equipmentInsurance: values.equipmentInsurance,
    optionIds: values.optionIds,
    customer: {
      name: values.name,
      ...("value" in company ? { companyName: company.value } : {}),
      email: values.email,
      phone: values.phone,
      address: values.address,
      photographerName: values.photographerName,
    },
    shooting: {
      types: values.shootingTypes,
      details: values.shootingDetails,
      ...("value" in notes ? { notes: notes.value } : {}),
    },
    agreedToCycloramaRules: values.agreedToCycloramaRules,
    agreedToTerms: values.agreedToTerms,
  };
  const parsed = ApplicationRequest.safeParse(candidate);
  if (parsed.success) return { ok: true, request: parsed.data };

  const keys = new Set(
    parsed.error.issues.map((issue) => issue.path.slice(0, 2).map(String).join(".")),
  );
  const fields = Object.entries(FIELD_TEXT)
    .filter(([key]) =>
      [...keys].some((issueKey) => issueKey === key || issueKey.startsWith(`${key}.`)),
    )
    .map(([, text]) => text);
  return { ok: false, fields: [...new Set(fields)] };
}
