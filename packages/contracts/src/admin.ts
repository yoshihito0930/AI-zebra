// 管理 API（管理画面のスタッフだけ）の形（docs/design-docs/admin-api.md）。1回目：一覧・詳細と、承認まわりの操作。
// 外から来るクエリ・本文は、APIの境界でこのスキーマでパースする（INV-4）。余計なキーがあれば通さない（strictObject）
import { z } from "zod";
import { ReceiptNumber, ShootingType } from "./application.ts";
import { Yen } from "./money.ts";
import { ReservationStatus } from "./reservation-status.ts";

/** 日時：ISO 8601、オフセット付き（JST で表す） */
const DateTime = z.iso.datetime({ offset: true });

/** 枠を確保している状態（一覧に出る状態）。取消・終了は一覧に出ない */
export const HoldingReservationStatus = ReservationStatus.exclude(["cancelled", "ended"]);
export type HoldingReservationStatus = z.infer<typeof HoldingReservationStatus>;

/**
 * 一覧のクエリ。from・to（JST の日付。両端を含む）か status の、少なくとも一方を渡す。from と to は両方そろえる。
 * 期間の長さ（最長62日）と、from が to より後でないことは、API の層で確かめる
 */
export const AdminReservationListQuery = z
  .strictObject({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    status: HoldingReservationStatus.optional(),
  })
  .refine((q) => (q.from === undefined) === (q.to === undefined), "from と to は両方渡す")
  .refine((q) => q.from !== undefined || q.status !== undefined, "期間か状態を渡す");
export type AdminReservationListQuery = z.infer<typeof AdminReservationListQuery>;

/** 経路：form＝フォームの申込、admin＝管理者の直接入力 */
const ReservationRoute = z.enum(["form", "admin"]);

const Estimate = z.strictObject({
  subtotalExcludingTax: Yen,
  estimateIncludingTax: Yen,
});

/** 一覧の予約1件。個人情報は氏名だけ */
const AdminReservationSummary = z.strictObject({
  id: z.string().min(1),
  /** フォームの申込だけが持つ */
  receiptNumber: ReceiptNumber.optional(),
  status: HoldingReservationStatus,
  /** 予約区間（バッファを含まない） */
  start: DateTime,
  end: DateTime,
  bufferMinutes: z.union([z.literal(30), z.literal(60)]),
  route: ReservationRoute,
  partySize: z.number().int().min(1),
  estimateIncludingTax: Yen,
  /** 承認待ちのあいだはない */
  confirmedPrice: Yen.optional(),
  /** 第二キープ（承認待ちを含む）だけが持つ */
  provisionalIds: z.array(z.string().min(1)).optional(),
  customerName: z.string().min(1),
});

/** 一覧のブロック枠1件 */
const AdminBlockSummary = z.strictObject({
  id: z.string().min(1),
  /** ブロック枠の区間（バッファを含まない） */
  start: DateTime,
  end: DateTime,
  bufferMinutes: z.union([z.literal(0), z.literal(30), z.literal(60)]),
  route: z.enum(["admin", "google-calendar"]),
  memo: z.string().optional(),
});

/** 一覧。どちらも開始の早い順（開始が同じなら終わりの早い順、それも同じなら id の順）。status を渡したときは、ブロック枠は空 */
export const AdminReservationList = z.strictObject({
  reservations: z.array(AdminReservationSummary),
  blocks: z.array(AdminBlockSummary),
});
export type AdminReservationList = z.infer<typeof AdminReservationList>;

const HistorySnapshot = z.strictObject({
  status: ReservationStatus,
  start: DateTime,
  end: DateTime,
  bufferMinutes: z.union([z.literal(30), z.literal(60)]),
  confirmedPrice: Yen.optional(),
  provisionalIds: z.array(z.string().min(1)).optional(),
  partySize: z.number().int().min(1).optional(),
  cycloramaFloorProtection: z.boolean().optional(),
  planId: z.string().min(1).optional(),
  equipmentInsurance: z.boolean().optional(),
  optionIds: z.array(z.string().min(1)).optional(),
});

const HistoryEntry = z.strictObject({
  at: DateTime,
  actor: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("customer") }),
    z.strictObject({ kind: z.literal("admin"), userId: z.string().min(1) }),
    /** 昇格に続く第二キープの終了など、システムが行った操作（reservation-model.md「状態と操作」） */
    z.strictObject({ kind: z.literal("system") }),
  ]),
  operation: z.enum([
    "apply",
    "approve",
    "reject",
    "promote",
    "end",
    "cancel",
    "move-up",
    "change",
    "buffer-change",
    "direct-entry",
  ]),
  before: HistorySnapshot.optional(),
  after: HistorySnapshot.optional(),
  /** お客様の情報や撮影の内容が変わったときの、変わった項目の名前だけ */
  changedFields: z.array(z.string().min(1)).optional(),
  /** 変更のときに料金表で計算し直した見積 */
  estimate: Estimate.optional(),
});

const CancellationFee = z.strictObject({
  ratePercent: z.number().int().min(0).max(100),
  fee: Yen,
});

/** 予約の詳細。お客様の情報は、管理者の直接入力では氏名と、メールアドレスか電話番号のどちらか1つだけが必須 */
export const AdminReservationDetail = z.strictObject({
  id: z.string().min(1),
  receiptNumber: ReceiptNumber.optional(),
  status: ReservationStatus,
  start: DateTime,
  end: DateTime,
  bufferMinutes: z.union([z.literal(30), z.literal(60)]),
  route: ReservationRoute,
  partySize: z.number().int().min(1),
  cycloramaFloorProtection: z.boolean(),
  planId: z.string().min(1),
  equipmentInsurance: z.boolean(),
  optionIds: z.array(z.string().min(1)),
  /** 申込（または直接入力）のときの見積。あとから変えない */
  estimate: Estimate,
  confirmedPrice: Yen.optional(),
  provisionalIds: z.array(z.string().min(1)).optional(),
  createdAt: DateTime,
  updatedAt: DateTime,
  customer: z
    .strictObject({
      name: z.string().min(1),
      companyName: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      address: z.string().optional(),
      photographerName: z.string().optional(),
    })
    .refine(
      (c) => c.email !== undefined || c.phone !== undefined,
      "メールアドレスか電話番号がない",
    ),
  shooting: z.strictObject({
    types: z.array(ShootingType).optional(),
    details: z.string().optional(),
    notes: z.string().optional(),
  }),
  /** 古い順 */
  history: z.array(HistoryEntry),
  /** 承認待ちのときだけ：今の料金表で計算し直した見積（申込のときの見積と比べるため） */
  currentEstimate: Estimate.optional(),
  /** 取消できる状態（仮予約・本予約・第二キープ）のときだけ：今取消したときのキャンセル料 */
  cancellationFeeIfCancelledNow: CancellationFee.optional(),
});
export type AdminReservationDetail = z.infer<typeof AdminReservationDetail>;

/** 受付番号から探した結果 */
export const AdminReceiptLookup = z.strictObject({ reservationId: z.string().min(1) });
export type AdminReceiptLookup = z.infer<typeof AdminReceiptLookup>;

/** 承認の本文：確定金額（税込） */
export const AdminApproveRequest = z.strictObject({ confirmedPrice: Yen });
export type AdminApproveRequest = z.infer<typeof AdminApproveRequest>;

/** 却下・昇格・取消・繰り上げの本文（何も持たない） */
export const AdminEmptyRequest = z.strictObject({});
export type AdminEmptyRequest = z.infer<typeof AdminEmptyRequest>;

/** 操作で作った下書き（reservation-model.md「状態と操作」）。下書きは送らない（INV-6） */
const AdminOperationDraft = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("approval"),
    reservationId: z.string().min(1),
    confirmedPrice: Yen,
  }),
  z.strictObject({ kind: z.literal("rejection"), reservationId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("promotion"), reservationId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("second-hold-ended"), reservationId: z.string().min(1) }),
  z.strictObject({
    kind: z.literal("cancellation"),
    reservationId: z.string().min(1),
    cancellationFee: CancellationFee,
  }),
  z.strictObject({
    kind: z.literal("move-up-notice"),
    reservationId: z.string().min(1),
    remainingProvisionalIds: z.array(z.string().min(1)),
  }),
  z.strictObject({ kind: z.literal("bring-forward-notice"), reservationId: z.string().min(1) }),
  z.strictObject({ kind: z.literal("change"), reservationId: z.string().min(1) }),
]);

/** 操作が成功したときの返事：作った下書きの一覧 */
export const AdminOperationAccepted = z.strictObject({
  drafts: z.array(AdminOperationDraft),
});
export type AdminOperationAccepted = z.infer<typeof AdminOperationAccepted>;

/**
 * 管理 API のエラーの理由（docs/design-docs/admin-api.md「返すときの決まり」）
 * - invalid-input：入力の形が正しくない（期間が62日を超える、from が to より後、を含む）
 * - unauthorized：管理者の id が取れない
 * - not-found：予約・受付番号がない
 * - not-pending／invalid-status／still-held：今の状態ではできない操作
 * - busy：混み合っている
 * 確認していない警告（unacknowledged-warnings。今の警告の一覧を付ける）は、2回目（変更・直接入力）で足す
 */
export const AdminError = z.enum([
  "invalid-input",
  "unauthorized",
  "not-found",
  "not-pending",
  "invalid-status",
  "still-held",
  "busy",
]);
export type AdminError = z.infer<typeof AdminError>;

export const AdminRejected = z.strictObject({ error: AdminError });
export type AdminRejected = z.infer<typeof AdminRejected>;
