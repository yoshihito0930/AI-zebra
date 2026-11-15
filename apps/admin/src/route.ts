// 画面の切り替え（URL のハッシュ）。#/ は一覧、#/reservations/{id} は予約の詳細。
// パスではなくハッシュにするのは、dev サーバーが /admin を API へ中継していて、画面のパスとぶつからないようにするため
import { useSyncExternalStore } from "react";

export type Route = { page: "list" } | { page: "detail"; reservationId: string };

export function parseRoute(hash: string): Route {
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
