// お客様の情報・撮影の内容の変更の保存（docs/product-specs/booking.md「お客様の情報・撮影の内容を直す」、
// reservation-model.md「状態と操作」「履歴」、admin-api.md「バッファの切り替え・お客様の情報の変更（2回目b）」）。
// 枠に関わらないので、日ごとのアイテムは読まない・書かない。読む → 比べる → 1トランザクションで書く（衝突したら読み直す）は、
// 申込の保存と同じ writeWithRetry で回す。PII のアイテムの形は申込・直接入力と共有する（piiItem・parsePii）。
// 履歴には変わった項目の名前だけを書き、中身は書かない（INV-10）。ログは出さない。
import { GetItemCommand, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import type { AdminCustomerField } from "@zebra/contracts";
import type { DateTime } from "luxon";
import { lastSequence } from "./operations.ts";
import {
  type Item,
  type ReservationStore,
  type StoredCustomerInfo,
  type StoredShootingInfo,
  actorAttribute,
  historySortKey,
  parsePii,
  piiItem,
  stringList,
  utcIso,
  writeWithRetry,
} from "./reservations.ts";

/**
 * 直したあとのお客様の情報と撮影の内容。全部の欄を渡して置き換える（渡さなかった欄は消える）。
 * 入力の形の確かめ（氏名と、電話番号かメールアドレスのどちらか1つが必須、欄の形と長さの上限）は API の層で済ませてから渡す
 */
export interface CustomerInfoChange {
  reservationId: string;
  customer: StoredCustomerInfo;
  shooting: StoredShootingInfo;
}

export interface SaveCustomerInfoOptions {
  /** 現在時刻（予約の更新日時・履歴の日時）。INV-7 */
  now: DateTime;
  /** 操作した管理者のユーザー id（履歴の「誰が」） */
  adminUserId: string;
}

/**
 * 保存の結果。changedFields は変わった項目の名前（並びは AdminCustomerField の順）。
 * 空なら、変わった項目がなく何も書いていない
 */
export type SaveCustomerInfoResult =
  { ok: true; changedFields: readonly AdminCustomerField[] } | { ok: false; reason: "not-found" };

/**
 * お客様の情報・撮影の内容の変更を保存する。どの状態の予約でも直せる（空き判定はしない）。
 * 個人情報のアイテム（PII）の置き換えと、予約の META の更新日時（now）と、履歴（操作は customer-info-change、changedFields は
 * 変わった項目の名前だけで、中身は書かない。INV-10）を、予約の META があることを条件に1トランザクションで書く。META のほかの属性は変えない。日ごとのアイテムは読まない・書かない。
 * 予約がなければ not-found で何も書かない。変わった項目がなければ何も書かない
 */
export async function saveCustomerInfo(
  store: ReservationStore,
  change: CustomerInfoChange,
  options: SaveCustomerInfoOptions,
): Promise<SaveCustomerInfoResult> {
  if (!options.now.isValid) {
    throw new RangeError("現在時刻が不正");
  }
  const at = utcIso(options.now);
  const pk = `RES#${change.reservationId}`;

  const result = await writeWithRetry<SaveCustomerInfoResult>(store, {}, async () => {
    // 予約の META と PII を強い整合性で読む
    const meta = await getItem(store, pk, "META");
    if (meta === undefined) return { kind: "stop", result: { ok: false, reason: "not-found" } };
    const pii = await getItem(store, pk, "PII");
    if (pii === undefined) throw new Error(`DB のアイテムの形が不正（${pk} の PII のアイテム）`);
    const current = parsePii(change.reservationId, pii);

    const changedFields = changedFieldsOf(current, change);
    // 変わった項目がなければ、更新日時も含めて何も書かない
    if (changedFields.length === 0) {
      return { kind: "stop", result: { ok: true, changedFields: [] } };
    }

    const sequence = (await lastSequence(store, pk, `HIST#${at}#`)) + 1;
    const transactItems: TransactWriteItem[] = [
      // PII は全部の欄を置き換える（渡さなかった欄は消える）
      {
        Put: {
          TableName: store.tableName,
          Item: piiItem(change.reservationId, change.customer, change.shooting),
        },
      },
      // META は更新日時だけを変える。予約の META があることを条件にする
      {
        Update: {
          TableName: store.tableName,
          Key: { pk: { S: pk }, sk: { S: "META" } },
          UpdateExpression: "SET #updatedAt = :at",
          ConditionExpression: "attribute_exists(#pk)",
          ExpressionAttributeNames: { "#updatedAt": "updatedAt", "#pk": "pk" },
          ExpressionAttributeValues: { ":at": { S: at } },
        },
      },
      // 履歴：変わった項目の名前だけ（中身は書かない。INV-10）。同じキーがあれば読み直して連番を取り直す
      {
        Put: {
          TableName: store.tableName,
          Item: {
            pk: { S: pk },
            sk: { S: historySortKey(at, sequence) },
            at: { S: at },
            actor: actorAttribute({ kind: "admin", userId: options.adminUserId }),
            operation: { S: "customer-info-change" },
            changedFields: stringList(changedFields),
          },
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
    ];
    return { kind: "write", transactItems, result: { ok: true, changedFields } };
  });

  if (!result.ok && result.reason === "busy") {
    // 衝突するのは、同じ予約への同時の書き込みだけ。試す回数の上限まで続くことは、ふつうは起きない
    throw new Error("お客様の情報の変更を書き込めなかった（衝突が続いた）");
  }
  return result;
}

async function getItem(store: ReservationStore, pk: string, sk: string): Promise<Item | undefined> {
  const res = await store.client.send(
    new GetItemCommand({
      TableName: store.tableName,
      Key: { pk: { S: pk }, sk: { S: sk } },
      ConsistentRead: true,
    }),
  );
  return res.Item;
}

/** 変わった項目の名前（AdminCustomerField の順）。撮影内容は選んだものの集まりとして比べる（並びの違いは変わったとしない） */
function changedFieldsOf(
  current: { readonly customer: StoredCustomerInfo; readonly shooting: StoredShootingInfo },
  next: { readonly customer: StoredCustomerInfo; readonly shooting: StoredShootingInfo },
): AdminCustomerField[] {
  const fields: [AdminCustomerField, boolean][] = [
    ["name", current.customer.name !== next.customer.name],
    ["companyName", current.customer.companyName !== next.customer.companyName],
    ["email", current.customer.email !== next.customer.email],
    ["phone", current.customer.phone !== next.customer.phone],
    ["address", current.customer.address !== next.customer.address],
    ["photographerName", current.customer.photographerName !== next.customer.photographerName],
    ["shootingTypes", !sameTypes(current.shooting.types, next.shooting.types)],
    ["shootingDetails", current.shooting.details !== next.shooting.details],
    ["shootingNotes", current.shooting.notes !== next.shooting.notes],
  ];
  return fields.filter(([, changed]) => changed).map(([field]) => field);
}

function sameTypes(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const set = new Set(a);
  return a.length === b.length && new Set(b).size === set.size && b.every((type) => set.has(type));
}
