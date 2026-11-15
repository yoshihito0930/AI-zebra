// 予約の変更・直接入力・お客様の情報の変更のフォームの入力を、管理 API の本文の形（packages/contracts）にする。
// 見積は、API と同じ booking-core の料金の関数と今の料金表で計算する（booking.md「料金」。INV-9）。
// 日時は JST で入力し、送るときは JST のオフセット付きにする（INV-7）
import {
  calculatePriceFromTable,
  currentPriceTable,
  decidePlanId,
  type PriceTableQuote,
} from "@zebra/booking-core";
import {
  AdminCustomerInfoRequest,
  type AdminChangeRequest,
  type AdminCustomerField,
  type AdminReservationDetail,
} from "@zebra/contracts";
import { DateTime } from "luxon";
import { fromJstInput, parseYenInput, toJstInput } from "./format.ts";
import { customerFieldLabel } from "./labels.ts";

/** 今の料金表（API の app.ts と同じ currentPriceTable） */
export const priceTable = currentPriceTable();

/** 人数の上限（契約の形の上限。booking.md では直接入力の人数に上限を設けない） */
const MAX_PARTY_SIZE = 100;

/** 予約の内容の入力（変更と直接入力で同じ）。日時は入力欄の値（JST の「2026-11-20T13:00」） */
export interface ContentInput {
  start: string;
  end: string;
  partySize: string;
  cycloramaFloorProtection: boolean;
  equipmentInsurance: boolean;
  optionIds: string[];
  /**
   * 確定金額の欄に管理者が入れた値。入れるまでは undefined で、欄には初期値
   * （直接入力は見積、変更は今の確定金額。内容を変えたら見積）を出す
   */
  confirmedPrice: string | undefined;
}

export const emptyContentInput = (): ContentInput => ({
  start: "",
  end: "",
  partySize: "",
  cycloramaFloorProtection: false,
  equipmentInsurance: false,
  optionIds: [],
  confirmedPrice: undefined,
});

/** 変更のフォームの初期値：今の予約の値 */
export function contentInputOf(detail: AdminReservationDetail): ContentInput {
  return {
    start: toJstInput(detail.start),
    end: toJstInput(detail.end),
    partySize: String(detail.partySize),
    cycloramaFloorProtection: detail.cycloramaFloorProtection,
    equipmentInsurance: detail.equipmentInsurance,
    optionIds: [...detail.optionIds],
    confirmedPrice: undefined,
  };
}

/** 予約の内容（確定金額を除く）が、今の予約と違うか */
export function contentChanged(input: ContentInput, detail: AdminReservationDetail): boolean {
  const current = contentInputOf(detail);
  return (
    input.start !== current.start ||
    input.end !== current.end ||
    input.partySize.trim() !== current.partySize ||
    input.cycloramaFloorProtection !== current.cycloramaFloorProtection ||
    input.equipmentInsurance !== current.equipmentInsurance ||
    [...input.optionIds].sort().join(",") !== [...current.optionIds].sort().join(",")
  );
}

function parsePartySize(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= 1 && value <= MAX_PARTY_SIZE ? value : undefined;
}

export type EstimateResult =
  { ok: true; planId: string; quote: PriceTableQuote } | { ok: false; message: string };

/**
 * 入力に応じた見積（今の料金表）。料金を決められない入力（日時がない・30分単位でない・終わりが開始以前、人数がない）は、
 * 理由を返す。30分単位などの決まりの判定は API が行い、ここでは見積を出せるかだけを見る
 */
export function estimateOf(input: ContentInput): EstimateResult {
  const partySize = parsePartySize(input.partySize);
  const start = fromJstInput(input.start);
  const end = fromJstInput(input.end);
  if (start === undefined || end === undefined) {
    return { ok: false, message: "開始と終わりの日時を入れると、見積を出します。" };
  }
  if (partySize === undefined) {
    return { ok: false, message: "人数を入れると、見積を出します。" };
  }
  const startAt = DateTime.fromISO(start, { setZone: true });
  const endAt = DateTime.fromISO(end, { setZone: true });
  if (startAt.minute % 30 !== 0 || endAt.minute % 30 !== 0) {
    return { ok: false, message: "日時が30分単位でないため、見積を出せません。" };
  }
  if (endAt.toMillis() <= startAt.toMillis()) {
    return { ok: false, message: "終わりが開始より前のため、見積を出せません。" };
  }
  const planId = decidePlanId(priceTable, {
    partySize,
    cycloramaFloorProtection: input.cycloramaFloorProtection,
  });
  const quote = calculatePriceFromTable(priceTable, {
    planId,
    start: startAt,
    end: endAt,
    equipmentInsurance: input.equipmentInsurance,
    optionIds: sortedOptionIds(input.optionIds),
  });
  return { ok: true, planId, quote };
}

/** オプションの id を料金表の順に並べる（本文の並びを決めるため） */
function sortedOptionIds(optionIds: readonly string[]): string[] {
  return priceTable.options.map((option) => option.id).filter((id) => optionIds.includes(id));
}

/** 変更と直接入力で同じ、予約の内容の本文（確認した警告を除く） */
export type ContentRequest = Omit<AdminChangeRequest, "acknowledgedWarnings">;

export type Built<T> = { ok: true; value: T } | { ok: false; messages: string[] };

/** 予約の内容の入力を、本文の形にする。確定金額の欄が初期値のままなら defaultPrice を使う */
export function buildContent(input: ContentInput, defaultPrice: string): Built<ContentRequest> {
  const messages: string[] = [];
  const start = fromJstInput(input.start);
  const end = fromJstInput(input.end);
  if (start === undefined) messages.push("開始の日時を入れてください。");
  if (end === undefined) messages.push("終わりの日時を入れてください。");
  const partySize = parsePartySize(input.partySize);
  if (partySize === undefined) {
    messages.push(`人数は、1〜${MAX_PARTY_SIZE}の整数で入れてください。`);
  }
  const confirmedPrice = parseYenInput(input.confirmedPrice ?? defaultPrice);
  if (confirmedPrice === undefined) {
    messages.push("確定金額は、0以上の整数（円）で入れてください。");
  }
  if (
    start === undefined ||
    end === undefined ||
    partySize === undefined ||
    confirmedPrice === undefined
  ) {
    return { ok: false, messages };
  }
  return {
    ok: true,
    value: {
      start,
      end,
      partySize,
      cycloramaFloorProtection: input.cycloramaFloorProtection,
      equipmentInsurance: input.equipmentInsurance,
      optionIds: sortedOptionIds(input.optionIds),
      confirmedPrice,
    },
  };
}

type ShootingType = NonNullable<AdminCustomerInfoRequest["shooting"]["types"]>[number];

/** お客様の情報と撮影の内容の入力（直接入力とお客様の情報の変更で同じ） */
export interface CustomerInput {
  name: string;
  companyName: string;
  email: string;
  phone: string;
  address: string;
  photographerName: string;
  shootingTypes: ShootingType[];
  shootingDetails: string;
  shootingNotes: string;
}

export const emptyCustomerInput = (): CustomerInput => ({
  name: "",
  companyName: "",
  email: "",
  phone: "",
  address: "",
  photographerName: "",
  shootingTypes: [],
  shootingDetails: "",
  shootingNotes: "",
});

/** お客様の情報の変更のフォームの初期値：今の予約の値 */
export function customerInputOf(detail: AdminReservationDetail): CustomerInput {
  const { customer, shooting } = detail;
  return {
    name: customer.name,
    companyName: customer.companyName ?? "",
    email: customer.email ?? "",
    phone: customer.phone ?? "",
    address: customer.address ?? "",
    photographerName: customer.photographerName ?? "",
    shootingTypes: [...(shooting.types ?? [])],
    shootingDetails: shooting.details ?? "",
    shootingNotes: shooting.notes ?? "",
  };
}

const SHOOTING_TYPE_ORDER: readonly ShootingType[] = ["still", "movie", "music"];

/** 本文の欄の場所（契約のパースの path）から、項目の名前へ */
const fieldOfPath: Record<string, AdminCustomerField> = {
  "customer.name": "name",
  "customer.companyName": "companyName",
  "customer.email": "email",
  "customer.phone": "phone",
  "customer.address": "address",
  "customer.photographerName": "photographerName",
  "shooting.types": "shootingTypes",
  "shooting.details": "shootingDetails",
  "shooting.notes": "shootingNotes",
};

function fieldMessage(field: AdminCustomerField): string {
  switch (field) {
    case "email":
      return "メールアドレスは「〇〇@〇〇.〇〇」の形で入れてください。";
    case "phone":
      return "電話番号は、先頭が0の10〜11桁の数字で入れてください（ハイフンは入れてよい。+81 は使えません）。";
    default:
      return `${customerFieldLabel[field]}が長すぎます。`;
  }
}

/**
 * お客様の情報と撮影の内容の入力を、本文の形（AdminCustomerInfoRequest。直接入力の customer・shooting と同じ）にする。
 * 前後の空白を除き、空の欄は送らない（全部を送って置き換えるので、送らない欄は消える）。
 * 氏名と、電話番号かメールアドレスのどちらか1つが必須。入れた欄の形と長さは契約で確かめる
 */
export function buildCustomer(input: CustomerInput): Built<AdminCustomerInfoRequest> {
  const filled = (value: string) => {
    const trimmed = value.trim();
    return trimmed === "" ? undefined : trimmed;
  };
  const entries = <K extends string>(record: Record<K, string | undefined>) =>
    Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

  const name = filled(input.name);
  const email = filled(input.email);
  const phone = filled(input.phone);
  const messages: string[] = [];
  if (name === undefined) messages.push("氏名を入れてください。");
  if (email === undefined && phone === undefined) {
    messages.push("電話番号かメールアドレスのどちらか1つを入れてください。");
  }
  if (messages.length > 0) return { ok: false, messages };

  const types = SHOOTING_TYPE_ORDER.filter((type) => input.shootingTypes.includes(type));
  const body = {
    customer: {
      name,
      ...entries({
        companyName: filled(input.companyName),
        email,
        phone,
        address: filled(input.address),
        photographerName: filled(input.photographerName),
      }),
    },
    shooting: {
      ...(types.length === 0 ? {} : { types }),
      ...entries({ details: filled(input.shootingDetails), notes: filled(input.shootingNotes) }),
    },
  };
  const parsed = AdminCustomerInfoRequest.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };

  const fieldMessages = parsed.error.issues.map((issue) => {
    const field = fieldOfPath[issue.path.slice(0, 2).join(".")];
    return field === undefined ? "お客様の情報の形が正しくありません。" : fieldMessage(field);
  });
  return { ok: false, messages: [...new Set(fieldMessages)] };
}
