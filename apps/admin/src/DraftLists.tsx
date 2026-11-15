// メールの下書きの一覧（3回目）。
// - 未送信の下書きの一覧（GET /admin/drafts）：作った順に、種類・お客様の氏名・予約の開始・作った日時
// - ヘッダーの、未送信の下書きの一覧へのリンク（件数つき）
// - 予約の下書きの一覧（GET /admin/reservations/{id}/drafts）：送信済み・送らないも含め、作った順に、状態とその日時
// どの行からも、下書きを開く画面（DraftPage）へ移る。管理画面はメールを送らない（INV-6）
import type { AdminReservationDraftList, AdminUnsentDraftList } from "@zebra/contracts";
import { useEffect, useState } from "react";
import type { AdminApi } from "./api.ts";
import { formatDateTime } from "./format.ts";
import { draftKindLabel, draftStatusLabel, failureMessage } from "./labels.ts";
import { draftHref, draftsHref, navigate } from "./route.ts";

type LoadState<T> =
  { kind: "loading" } | { kind: "loaded"; value: T } | { kind: "failed"; message: string };

/** 未送信の下書きの一覧の画面 */
export function UnsentDraftListPage(props: { api: AdminApi }) {
  const { api } = props;
  const [state, setState] = useState<LoadState<AdminUnsentDraftList>>({ kind: "loading" });

  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    void api.listUnsentDrafts().then((result) => {
      if (!current) return;
      setState(
        result.ok
          ? { kind: "loaded", value: result.value }
          : { kind: "failed", message: failureMessage(result.failure) },
      );
    });
    return () => {
      current = false;
    };
  }, [api]);

  return (
    <section>
      <h2>未送信のメールの下書き</h2>
      <p>
        <small>
          下書きを開いて内容を確かめ、Gmail に貼って送ってください（管理画面からは送りません）。
          送ったら、下書きの画面で「送信済み」にします。送信済み・送らないにした下書きは、予約の詳細でだけ見られます。
        </small>
      </p>
      {state.kind === "loading" && <p>読み込み中…</p>}
      {state.kind === "failed" && <p role="alert">{state.message}</p>}
      {state.kind === "loaded" &&
        (state.value.drafts.length === 0 ? (
          <p>未送信の下書きはありません。</p>
        ) : (
          <>
            <p>未送信 {state.value.drafts.length}件（作った順）</p>
            <table aria-label="未送信の下書き">
              <thead>
                <tr>
                  <th>作った日時（JST）</th>
                  <th>種類</th>
                  <th>お客様の氏名</th>
                  <th>予約の開始（JST）</th>
                </tr>
              </thead>
              <tbody>
                {state.value.drafts.map((d) => {
                  const href = draftHref(d.reservationId, d.draftId);
                  // 下書きの id は予約の中でだけ重ならない（1つの操作で作った、別の予約への下書きは同じ id になりうる）
                  return (
                    <tr
                      key={`${d.reservationId} ${d.draftId}`}
                      onClick={() => navigate(href)}
                      style={{ cursor: "pointer" }}
                    >
                      <td>{formatDateTime(d.createdAt)}</td>
                      <td>
                        <a href={href}>{draftKindLabel[d.kind]}</a>
                      </td>
                      <td>{d.customerName}</td>
                      <td>{formatDateTime(d.reservationStart)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        ))}
    </section>
  );
}

/**
 * ヘッダーの、未送信の下書きの一覧へのリンク。件数は refreshKey が変わるたびに読み直す
 * （画面を移ったとき、操作や送信済みにしたあと）。読めなければ件数を出さない
 */
export function UnsentDraftsLink(props: { api: AdminApi; refreshKey: string }) {
  const { api, refreshKey } = props;
  const [count, setCount] = useState<number>();

  useEffect(() => {
    let current = true;
    void api.listUnsentDrafts().then((result) => {
      if (current) setCount(result.ok ? result.value.drafts.length : undefined);
    });
    return () => {
      current = false;
    };
  }, [api, refreshKey]);

  return (
    <a href={draftsHref()}>未送信のメールの下書き{count === undefined ? "" : `（${count}件）`}</a>
  );
}

/** 予約の詳細の中の、その予約の下書きの一覧。refreshKey が変わったら読み直す（操作のあと） */
export function ReservationDraftList(props: {
  api: AdminApi;
  reservationId: string;
  refreshKey: number;
}) {
  const { api, reservationId, refreshKey } = props;
  const [state, setState] = useState<LoadState<AdminReservationDraftList>>({ kind: "loading" });

  useEffect(() => {
    let current = true;
    void api.listReservationDrafts(reservationId).then((result) => {
      if (!current) return;
      setState(
        result.ok
          ? { kind: "loaded", value: result.value }
          : { kind: "failed", message: failureMessage(result.failure) },
      );
    });
    return () => {
      current = false;
    };
  }, [api, reservationId, refreshKey]);

  return (
    <section aria-label="メールの下書き">
      <h3>メールの下書き</h3>
      {state.kind === "loading" && <p>読み込み中…</p>}
      {state.kind === "failed" && <p role="alert">下書きを読めませんでした。{state.message}</p>}
      {state.kind === "loaded" &&
        (state.value.drafts.length === 0 ? (
          <p>この予約のメールの下書きはありません。</p>
        ) : (
          <table aria-label="この予約のメールの下書き">
            <thead>
              <tr>
                <th>作った日時（JST）</th>
                <th>種類</th>
                <th>状態</th>
                <th>送信済み・送らないにした日時（JST）</th>
              </tr>
            </thead>
            <tbody>
              {state.value.drafts.map((d) => {
                const href = draftHref(reservationId, d.draftId);
                return (
                  <tr key={d.draftId} onClick={() => navigate(href)} style={{ cursor: "pointer" }}>
                    <td>{formatDateTime(d.createdAt)}</td>
                    <td>
                      <a href={href}>{draftKindLabel[d.kind]}</a>
                    </td>
                    <td>{draftStatusLabel[d.status]}</td>
                    <td>
                      {d.statusChangedAt === undefined ? "—" : formatDateTime(d.statusChangedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ))}
    </section>
  );
}
