// 下書きの読み出しと、送信済み・送らないの保存（docs/design-docs/dynamodb-keys.md の下書きのアイテムと、
// 未送信の下書きの GSI。admin-api.md「下書き（3回目）」）。下書きは文面と個人情報を持たない。メールは送らない（INV-6）
import type { AdminDraftStatus } from "@zebra/contracts";
import type { DateTime } from "luxon";
import type { OperationDraft } from "./operations.ts";
import type { ReservationStore } from "./reservations.ts";

/** 保存された下書き1件 */
export interface StoredDraft {
  /** 下書きのアイテムの sk（DRAFT#<作った日時（UTC）>#<連番>）。あて先の予約の id（draft.reservationId）と合わせて下書きを決める */
  sk: string;
  /** 種類、あて先の予約の id、差し込む値（下書きを作ったときの値） */
  draft: OperationDraft;
  status: AdminDraftStatus;
  createdAt: DateTime;
  /** 送信済み・送らないにした日時と管理者の id。未送信なら持たない */
  statusChange?: { at: DateTime; adminUserId: string };
}

/** 未送信の下書きを、作った順（古い順）に返す（GSI：gsi1pk = DRAFT#UNSENT、gsi1sk = 作った日時） */
export function listUnsentDrafts(store: ReservationStore): Promise<StoredDraft[]> {
  void store;
  throw new Error("未実装");
}

/** その予約の下書きすべて（送信済み・送らないも）を、作った順に返す。なければ空 */
export function listReservationDrafts(
  store: ReservationStore,
  reservationId: string,
): Promise<StoredDraft[]> {
  void store;
  void reservationId;
  throw new Error("未実装");
}

/** 下書き1件を読む。その予約の下書きになければ null */
export function getDraft(
  store: ReservationStore,
  reservationId: string,
  sk: string,
): Promise<StoredDraft | null> {
  void store;
  void reservationId;
  void sk;
  throw new Error("未実装");
}

/** 送信済み（sent）・送らない（skipped）にする下書き */
export interface DraftStatusChange {
  reservationId: string;
  sk: string;
  status: "sent" | "skipped";
}

export interface SaveDraftStatusOptions {
  /** 操作の日時（INV-7。UTC で保存する） */
  now: DateTime;
  adminUserId: string;
}

/**
 * - not-found：その予約の下書きがない
 * - draft-not-unsent：未送信でない（送信済み・送らないにしたあとは、未送信に戻さず、ほかの状態にもしない）
 */
export type SaveDraftStatusResult =
  { ok: true } | { ok: false; reason: "not-found" | "draft-not-unsent" };

/**
 * 下書きの状態と、その日時・管理者の id を書き、未送信の一覧の GSI の属性を消す。
 * 下書きの状態が未送信であることを条件に書く
 */
export function saveDraftStatus(
  store: ReservationStore,
  change: DraftStatusChange,
  options: SaveDraftStatusOptions,
): Promise<SaveDraftStatusResult> {
  void store;
  void change;
  void options;
  throw new Error("未実装");
}
