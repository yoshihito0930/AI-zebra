// 画面の切り替え（URL のハッシュ）。#/ は一覧、#/reservations/{id} は予約の詳細、#/direct-entry は予約の直接入力、
// #/drafts は未送信の下書きの一覧、#/reservations/{id}/drafts/{draftId} は下書きを開く画面。
// パスではなくハッシュにするのは、dev サーバーが /admin を API へ中継していて、画面のパスとぶつからないようにするため
import { useSyncExternalStore } from "react";

export type Route =
  | { page: "list" }
  | { page: "detail"; reservationId: string }
  | { page: "direct-entry" }
  | { page: "drafts" }
  | { page: "draft"; reservationId: string; draftId: string };

export function parseRoute(hash: string): Route {
  if (hash === directEntryHref()) return { page: "direct-entry" };
  if (hash === draftsHref()) return { page: "drafts" };
  const draft = /^#\/reservations\/([^/]+)\/drafts\/([^/]+)$/.exec(hash);
  if (draft?.[1] !== undefined && draft[2] !== undefined) {
    return {
      page: "draft",
      reservationId: decodeURIComponent(draft[1]),
      draftId: decodeURIComponent(draft[2]),
    };
  }
  const match = /^#\/reservations\/([^/]+)$/.exec(hash);
  if (match?.[1] !== undefined) {
    return { page: "detail", reservationId: decodeURIComponent(match[1]) };
  }
  return { page: "list" };
}

export function listHref(): string {
  return "#/";
}

export function detailHref(reservationId: string): string {
  return `#/reservations/${encodeURIComponent(reservationId)}`;
}

export function directEntryHref(): string {
  return "#/direct-entry";
}

export function draftsHref(): string {
  return "#/drafts";
}

export function draftHref(reservationId: string, draftId: string): string {
  return `${detailHref(reservationId)}/drafts/${encodeURIComponent(draftId)}`;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** 今のハッシュ */
export function useHash(): string {
  return useSyncExternalStore(subscribe, () => window.location.hash);
}

export function navigate(href: string): void {
  window.location.hash = href;
}
