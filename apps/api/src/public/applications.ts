// 公開API（認証なし）の申込（docs/product-specs/booking.md「申込フォーム」）。
// 外から来た本文は、最初に契約（ApplicationRequest）でパースする（INV-4）。
// 中身の検証（時間の単位と利用時間・申込の締め切り）とプランの決め方・見積の計算は booking-core の関数に任せ、
// ここには同じ判定を書かない。重なりの判定と保存は db の saveApplication に任せる（dynamodb-keys.md「書き込み」）。
// 受付番号はここで作り、予約と同じトランザクションで「まだないこと」を条件に保存する。
// 番号が既存のものと重なったら、別の番号を作り直してやり直す（お客様の申込を断らない）。上限を超えたら busy。
// 返事は契約（ApplicationAccepted／ApplicationRejected）を通してから返す。予約の id や状態は返さない（INV-3）。
// ログは出さない（INV-10。お客様の情報を含む値を扱うため）。
import { randomInt } from "node:crypto";
import {
  checkApplicationDeadline,
  checkSecondHoldApplicationDeadline,
  checkTimeUnitAndDuration,
  calculatePriceFromTable,
  decidePlanId,
} from "@zebra/booking-core";
import {
  ApplicationAccepted,
  ApplicationRejected,
  type ApplicationRejection,
  ApplicationRequest,
  type PriceTable,
  ReceiptNumber,
} from "@zebra/contracts";
import { Hono } from "hono";
import { DateTime } from "luxon";
import {
  type CustomerInfo,
  type ReservationApplication,
  type ReservationStore,
  type ShootingInfo,
  saveApplication,
} from "../db/reservations.ts";

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
 * 受付番号が既存の番号と重なったときに、別の番号を作り直して保存を試す回数の上限（最初の1回を含む）。
 * 番号は 32 種類の文字の8文字（約1兆通り）なので、重なること自体がまれ。超えたら混み合っている（busy）
 */
export const RECEIPT_NUMBER_MAX_ATTEMPTS = 5;

/**
 * お客様の申込を処理する。外から来た値（body）を ApplicationRequest でパースし（INV-4）、
 * 時間の単位と利用時間・申込の締め切りを確かめ、料金表で見積を出し、空き判定をして保存する。
 * 受け付けなかったときは何も保存しない
 */
export async function submitApplication(
  deps: ApplicationDeps,
  body: unknown,
): Promise<ApplicationResult> {
  // 1. 境界でパースする（INV-4）。理由や値は返さない
  const parsed = ApplicationRequest.safeParse(body);
  if (!parsed.success) return rejected("invalid-input");
  const request = parsed.data;

  // 日時はオフセット付きの ISO 8601（契約で確かめ済み）。どのゾーンで来ても、判定は booking-core が JST で行う（INV-7）
  const start = DateTime.fromISO(request.start, { setZone: true });
  const end = DateTime.fromISO(request.end, { setZone: true });
  if (!start.isValid || !end.isValid) return rejected("invalid-input");

  // オプションは料金表にあるものだけ（料金表にない id は、料金を決められない入力の誤り）
  if (!request.optionIds.every((id) => deps.priceTable.options.some((o) => o.id === id))) {
    return rejected("invalid-input");
  }

  // 2. 時間の単位と利用時間（booking.md「時間の単位と利用時間」）
  const timeUnit = checkTimeUnitAndDuration(start, end);
  if (!timeUnit.ok) return rejected(timeUnit.reason);

  // 3. 申込の締め切り（booking.md「申込の締め切り」）。
  // 本予約申込と仮予約申込は checkApplicationDeadline、第二キープ申込は仮予約の期限まで（checkSecondHoldApplicationDeadline）
  const now = deps.now();
  const deadline =
    request.kind === "second-hold"
      ? checkSecondHoldApplicationDeadline({ start, appliedAt: now })
      : checkApplicationDeadline({ kind: request.kind, start, appliedAt: now });
  if (!deadline.ok) return rejected(deadline.reason);

  // 4. プランと見積（booking.md「料金」。INV-9。金額の計算は booking-core だけで行う）
  const planId = decidePlanId(deps.priceTable, {
    partySize: request.partySize,
    cycloramaFloorProtection: request.cycloramaFloorProtection,
  });
  const estimate = calculatePriceFromTable(deps.priceTable, {
    planId,
    start,
    end,
    equipmentInsurance: request.equipmentInsurance,
    optionIds: request.optionIds,
  });

  const application: ReservationApplication = {
    kind: request.kind,
    start,
    end,
    partySize: request.partySize,
    cycloramaFloorProtection: request.cycloramaFloorProtection,
    planId,
    equipmentInsurance: request.equipmentInsurance,
    optionIds: request.optionIds,
    estimate,
    customer: customerOf(request.customer),
    shooting: shootingOf(request.shooting),
  };

  // 5. 空き判定と保存（受付番号と同じトランザクション）。番号が重なったら作り直してやり直す
  const generate = deps.generateReceiptNumber ?? generateReceiptNumber;
  for (let attempt = 1; attempt <= RECEIPT_NUMBER_MAX_ATTEMPTS; attempt++) {
    const receiptNumber = receiptNumberFrom(generate);
    const saved = await saveApplication(
      deps.store,
      { ...application, receiptNumber },
      {
        now,
        ...(deps.save?.maxAttempts === undefined ? {} : { maxAttempts: deps.save.maxAttempts }),
        ...(deps.save?.beforeWrite === undefined ? {} : { beforeWrite: deps.save.beforeWrite }),
      },
    );
    if (saved.ok) {
      return {
        ok: true,
        accepted: ApplicationAccepted.parse({
          receiptNumber,
          estimateIncludingTax: estimate.estimateIncludingTax,
        }),
      };
    }
    if (saved.reason !== "receipt-number-taken") return rejected(saved.reason);
  }
  return rejected("busy");
}

/**
 * 申込のルート（POST /applications、認証なし）。
 * - 受付：201 と ApplicationAccepted
 * - 入力の誤り（JSON でない・契約に合わない）：400 と ApplicationRejected（invalid-input）
 * - ルールで不可（時間の単位と利用時間・申込の締め切り・空き判定）：422 と ApplicationRejected
 * - 混み合っている：503 と ApplicationRejected（busy）
 */
export function createPublicApplicationRoute(deps: ApplicationDeps): Hono {
  const route = new Hono();

  route.post("/applications", async (c) => {
    let body: unknown;
    try {
      body = JSON.parse(await c.req.text());
    } catch {
      // 本文はそのまま返さない・ログに出さない（INV-10）
      return c.json(ApplicationRejected.parse({ error: "invalid-input" }), 400);
    }

    const result = await submitApplication(deps, body);
    if (result.ok) {
      return c.json(ApplicationAccepted.parse(result.accepted), 201);
    }
    return c.json(ApplicationRejected.parse({ error: result.reason }), statusOf(result.reason));
  });

  // 思わぬエラー：お客様の情報が混ざらないよう、エラーの種類（name）だけをログに出し、中身は返さない（INV-10）
  route.onError((error, c) => {
    console.error(`申込の処理で思わぬエラー（${error.name}）`);
    return c.text("Internal Server Error", 500);
  });

  return route;
}

/** 受け付けなかった理由から HTTP のステータスへ */
function statusOf(reason: ApplicationRejection): 400 | 422 | 503 {
  switch (reason) {
    case "invalid-input":
      return 400;
    case "busy":
      return 503;
    case "not-on-30-minute-boundary":
    case "shorter-than-2-hours":
    case "late-night-shorter-than-4-hours":
    case "longer-than-24-hours":
    case "past-24-hours-before-start":
    case "past-provisional-deadline":
    case "overlaps-existing":
    case "no-provisional-to-hold":
      return 422;
  }
}

function rejected(reason: ApplicationRejection): ApplicationResult {
  return { ok: false, reason };
}

/**
 * 任意の欄（会社名・補足事項）は、空（前後の空白を除いて空）なら「なし」として保存しない。
 * 契約が前後の空白を除くので、ここでは空の文字列かどうかだけを見る
 */
function customerOf(customer: ApplicationRequest["customer"]): CustomerInfo {
  const { companyName, ...rest } = customer;
  return { ...rest, ...(companyName === undefined || companyName === "" ? {} : { companyName }) };
}

function shootingOf(shooting: ApplicationRequest["shooting"]): ShootingInfo {
  const { notes, ...rest } = shooting;
  return { ...rest, ...(notes === undefined || notes === "" ? {} : { notes }) };
}

/** 作った受付番号が契約の形か確かめる。形が違えば作る側の誤りなので、保存せずにエラーにする */
function receiptNumberFrom(generate: () => string): string {
  const parsed = ReceiptNumber.safeParse(generate());
  if (!parsed.success) throw new Error("作った受付番号が ReceiptNumber の形でない");
  return parsed.data;
}

/** 受付番号に使う文字：紛らわしい文字（0・O・1・I）を除いた英大文字と数字（32 種類） */
const RECEIPT_NUMBER_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RECEIPT_NUMBER_LENGTH = 8;

/** 受付番号を作る（node:crypto の乱数。電話で読み上げても間違えにくい文字だけを使う） */
export function generateReceiptNumber(): string {
  let receiptNumber = "";
  for (let i = 0; i < RECEIPT_NUMBER_LENGTH; i++) {
    receiptNumber += RECEIPT_NUMBER_ALPHABET.charAt(randomInt(RECEIPT_NUMBER_ALPHABET.length));
  }
  return receiptNumber;
}
