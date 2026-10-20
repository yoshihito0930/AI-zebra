// 公開API（認証なし）の申込の形（docs/product-specs/booking.md「申込フォーム」）。外から来るデータなので、
// APIの境界でこのスキーマでパースする（INV-4）。余計なキーがあれば通さない（strictObject）
import { z } from "zod";
import { Yen } from "./money.ts";

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();

/** メールアドレス：「〇〇@〇〇.〇〇」の形だけをゆるく確かめる。実在するかは確かめない */
const Email = z
  .string()
  .trim()
  .max(254)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);

/** 電話番号：先頭が0の10〜11桁の数字。ハイフンは可。+81 は受け付けない */
const Phone = z
  .string()
  .trim()
  .max(20)
  .regex(/^0[0-9-]+$/)
  .refine((value) => /^\d{10,11}$/.test(value.replaceAll("-", "")), "10〜11桁の数字");

/** 撮影内容：still＝スチール撮影、movie＝ムービー撮影、music＝楽器の演奏を伴う撮影 */
export const ShootingType = z.enum(["still", "movie", "music"]);

export const ApplicationRequest = z.strictObject({
  /** 予約の種類。second-hold は、希望日時が承認済みの仮予約と重なるときにフォームが案内する */
  kind: z.enum(["firm", "provisional", "second-hold"]),
  /** 予約区間の開始と終わり（ISO 8601、オフセット付き） */
  start: z.iso.datetime({ offset: true }),
  end: z.iso.datetime({ offset: true }),
  /** ご利用人数。フォームで受けるのは1〜14人（15人以上は問い合わせに案内する） */
  partySize: z.number().int().min(1).max(14),
  /** ホリゾントの養生（床面を全面養生するなら true） */
  cycloramaFloorProtection: z.boolean(),
  equipmentInsurance: z.boolean(),
  /** 料金表のオプションの id。同じ id は1回まで */
  optionIds: z
    .array(z.string().min(1).max(50))
    .max(10)
    .refine((ids) => new Set(ids).size === ids.length, "同じオプションが2回ある"),
  customer: z.strictObject({
    name: text(100),
    companyName: optionalText(100),
    email: Email,
    phone: Phone,
    address: text(200),
    photographerName: text(100),
  }),
  shooting: z.strictObject({
    types: z
      .array(ShootingType)
      .min(1)
      .refine((types) => new Set(types).size === types.length, "同じ撮影内容が2回ある"),
    details: text(2000),
    notes: optionalText(2000),
  }),
  /** ホリゾントルールの確認と、利用規約への同意。チェックしないと送信できない */
  agreedToCycloramaRules: z.literal(true),
  agreedToTerms: z.literal(true),
});
export type ApplicationRequest = z.infer<typeof ApplicationRequest>;

/** 受付番号：紛らわしい文字（0・O・1・I）を除いた英大文字と数字の8文字 */
export const ReceiptNumber = z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/);

/** 受け付けたときの返事。予約の成立や空きの可否は返さない */
export const ApplicationAccepted = z.strictObject({
  receiptNumber: ReceiptNumber,
  /** 申込のときの見積額（税込） */
  estimateIncludingTax: Yen,
});
export type ApplicationAccepted = z.infer<typeof ApplicationAccepted>;

/**
 * 受け付けられなかったときの理由
 * - invalid-input：入力の形が正しくない
 * - not-on-30-minute-boundary／shorter-than-2-hours／late-night-shorter-than-4-hours／longer-than-24-hours：時間の単位と利用時間
 * - past-24-hours-before-start／past-provisional-deadline：申込の締め切り
 * - overlaps-existing：ほかの予約と重なる（空き判定）
 * - no-provisional-to-hold：第二キープの申込が、どの仮予約とも重ならない
 * - busy：混み合っていて、いま受け付けられない（あとでもう一度）
 */
export const ApplicationRejection = z.enum([
  "invalid-input",
  "not-on-30-minute-boundary",
  "shorter-than-2-hours",
  "late-night-shorter-than-4-hours",
  "longer-than-24-hours",
  "past-24-hours-before-start",
  "past-provisional-deadline",
  "overlaps-existing",
  "no-provisional-to-hold",
  "busy",
]);
export type ApplicationRejection = z.infer<typeof ApplicationRejection>;

export const ApplicationRejected = z.strictObject({ error: ApplicationRejection });
export type ApplicationRejected = z.infer<typeof ApplicationRejected>;
