// 予約の詳細（GET /admin/reservations/{id}）。予約の内容、お客様の情報、履歴、承認待ちなら今の見積、取消できるなら今のキャンセル料。
// 下に、今の状態でできる操作（OperationPanel）と、直す（予約の変更・バッファの切り替え・お客様の情報。ReservationEditPanel）を出す
import type { AdminOperationAccepted, AdminReservationDetail } from "@zebra/contracts";
import { useCallback, useEffect, useState } from "react";
import type { AdminApi, AdminOperation } from "./api.ts";
import { formatDateTime, formatTimeRange, formatYen } from "./format.ts";
import {
  customerFieldLabel,
  failureMessage,
  historyOperationLabel,
  optionLabel,
  planLabel,
  reservationRouteLabel,
  shootingTypeLabel,
  statusLabel,
} from "./labels.ts";
import { OperationPanel, OperationResult, operationLabel } from "./OperationPanel.tsx";
import { ReservationEditPanel } from "./ReservationEditPanel.tsx";
import { detailHref, listHref } from "./route.ts";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; detail: AdminReservationDetail }
  | { kind: "failed"; message: string };

export function ReservationDetailPage(props: { api: AdminApi; reservationId: string }) {
  const { api, reservationId } = props;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [lastResult, setLastResult] = useState<{
    message: string;
    accepted?: AdminOperationAccepted | undefined;
  }>();

  const load = useCallback(async () => {
    const result = await api.getReservation(reservationId);
    return result.ok
      ? ({ kind: "loaded", detail: result.value } as const)
      : ({ kind: "failed", message: failureMessage(result.failure) } as const);
  }, [api, reservationId]);

  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    setLastResult(undefined);
    void load().then((next) => {
      if (current) setState(next);
    });
    return () => {
      current = false;
    };
  }, [load]);

  const onEdited = async (message: string, accepted?: AdminOperationAccepted) => {
    setLastResult({ message, accepted });
    setState(await load());
  };
  const onSucceeded = (operation: AdminOperation, accepted: AdminOperationAccepted) =>
    onEdited(`${operationLabel[operation]}しました。`, accepted);

  return (
    <section>
      <p>
        <a href={listHref()}>← 一覧へ</a>
      </p>
      <h2>予約の詳細</h2>
      {lastResult !== undefined && (
        <OperationResult
          message={lastResult.message}
          accepted={lastResult.accepted}
          reservationId={reservationId}
        />
      )}
      {state.kind === "loading" && <p>読み込み中…</p>}
      {state.kind === "failed" && <p role="alert">{state.message}</p>}
      {state.kind === "loaded" && (
        <>
          <ReservationDetailView detail={state.detail} />
          <OperationPanel
            key={state.detail.id}
            api={api}
            detail={state.detail}
            onSucceeded={onSucceeded}
          />
          <ReservationEditPanel
            key={`edit-${state.detail.id}`}
            api={api}
            detail={state.detail}
            onEdited={onEdited}
          />
        </>
      )}
    </section>
  );
}

const yesNo = (value: boolean) => (value ? "あり" : "なし");
const orDash = (value: string | undefined) => (value === undefined || value === "" ? "—" : value);

export function ReservationDetailView({ detail: d }: { detail: AdminReservationDetail }) {
  return (
    <>
      <h3>予約の内容</h3>
      <dl>
        <dt>状態</dt>
        <dd>{statusLabel[d.status]}</dd>
        <dt>受付番号</dt>
        <dd>{orDash(d.receiptNumber)}</dd>
        <dt>日時（JST）</dt>
        <dd>{formatTimeRange(d.start, d.end)}</dd>
        <dt>バッファ</dt>
        <dd>{d.bufferMinutes}分</dd>
        <dt>経路</dt>
        <dd>{reservationRouteLabel[d.route]}</dd>
        <dt>人数</dt>
        <dd>{d.partySize}人</dd>
        <dt>ホリゾントの養生</dt>
        <dd>{yesNo(d.cycloramaFloorProtection)}</dd>
        <dt>プラン</dt>
        <dd>{planLabel(d.planId)}</dd>
        <dt>機材保険</dt>
        <dd>{yesNo(d.equipmentInsurance)}</dd>
        <dt>オプション</dt>
        <dd>{d.optionIds.length === 0 ? "なし" : d.optionIds.map(optionLabel).join("、")}</dd>
        <dt>申込のときの見積</dt>
        <dd>
          {formatYen(d.estimate.estimateIncludingTax)}（税込。税抜{" "}
          {formatYen(d.estimate.subtotalExcludingTax)}）
        </dd>
        <dt>確定金額（税込）</dt>
        <dd>{d.confirmedPrice === undefined ? "未定" : formatYen(d.confirmedPrice)}</dd>
        {d.provisionalIds !== undefined && (
          <>
            <dt>付いている仮予約</dt>
            <dd>
              {d.provisionalIds.length === 0
                ? "なし"
                : d.provisionalIds.map((id, i) => (
                    <span key={id}>
                      {i > 0 && "、"}
                      <a href={detailHref(id)}>{id}</a>
                    </span>
                  ))}
            </dd>
          </>
        )}
        <dt>作成日時</dt>
        <dd>{formatDateTime(d.createdAt)}</dd>
        <dt>更新日時</dt>
        <dd>{formatDateTime(d.updatedAt)}</dd>
      </dl>

      {d.currentEstimate !== undefined && (
        <section aria-label="今の料金表での見積">
          <h3>今の料金表での見積</h3>
          <p>
            {formatYen(d.currentEstimate.estimateIncludingTax)}（税込。税抜{" "}
            {formatYen(d.currentEstimate.subtotalExcludingTax)}）
          </p>
          {d.currentEstimate.estimateIncludingTax !== d.estimate.estimateIncludingTax && (
            <p role="note">
              申込のときの見積（{formatYen(d.estimate.estimateIncludingTax)}
              ）と違います。申込のあとに料金表が変わった可能性があります。
            </p>
          )}
        </section>
      )}

      {d.cancellationFeeIfCancelledNow !== undefined && (
        <section aria-label="今取消したときのキャンセル料">
          <h3>今取消したときのキャンセル料</h3>
          <p>
            {formatYen(d.cancellationFeeIfCancelledNow.fee)}（
            {d.cancellationFeeIfCancelledNow.ratePercent}%）
          </p>
        </section>
      )}

      <h3>お客様の情報</h3>
      <dl>
        <dt>氏名</dt>
        <dd>{d.customer.name}</dd>
        <dt>会社名</dt>
        <dd>{orDash(d.customer.companyName)}</dd>
        <dt>メールアドレス</dt>
        <dd>{orDash(d.customer.email)}</dd>
        <dt>電話番号</dt>
        <dd>{orDash(d.customer.phone)}</dd>
        <dt>住所</dt>
        <dd>{orDash(d.customer.address)}</dd>
        <dt>カメラマン氏名</dt>
        <dd>{orDash(d.customer.photographerName)}</dd>
      </dl>

      <h3>撮影の内容</h3>
      <dl>
        <dt>撮影内容</dt>
        <dd>
          {d.shooting.types === undefined || d.shooting.types.length === 0
            ? "—"
            : d.shooting.types.map((t) => shootingTypeLabel[t]).join("、")}
        </dd>
        <dt>撮影詳細</dt>
        <dd style={{ whiteSpace: "pre-wrap" }}>{orDash(d.shooting.details)}</dd>
        <dt>補足事項</dt>
        <dd style={{ whiteSpace: "pre-wrap" }}>{orDash(d.shooting.notes)}</dd>
      </dl>

      <h3>履歴</h3>
      <HistoryTable history={d.history} />
    </>
  );
}

type HistoryEntry = AdminReservationDetail["history"][number];
type Snapshot = NonNullable<HistoryEntry["before"]>;

function actorLabel(actor: HistoryEntry["actor"]): string {
  switch (actor.kind) {
    case "customer":
      return "お客様";
    case "admin":
      return `管理者（${actor.userId}）`;
    case "system":
      return "システム";
  }
}

const priceText = (price: number | undefined) => (price === undefined ? "未定" : formatYen(price));
const idsText = (ids: string[] | undefined) =>
  ids === undefined || ids.length === 0 ? "なし" : ids.join("、");

/** 履歴の1件で変わったもの。変わった項目ごとに「名前：前 → 後」 */
export function describeHistoryChange(entry: HistoryEntry): string[] {
  const lines: string[] = [];
  const { before, after } = entry;
  if (after !== undefined) {
    const diff = (name: string, text: (s: Snapshot) => string) => {
      const next = text(after);
      if (before === undefined) return;
      const previous = text(before);
      if (previous !== next) lines.push(`${name}：${previous} → ${next}`);
    };
    if (before === undefined) {
      lines.push(`状態：${statusLabel[after.status]}`);
      lines.push(`日時：${formatTimeRange(after.start, after.end)}`);
    }
    diff("状態", (s) => statusLabel[s.status]);
    diff("日時", (s) => formatTimeRange(s.start, s.end));
    diff("バッファ", (s) => `${s.bufferMinutes}分`);
    diff("確定金額", (s) => priceText(s.confirmedPrice));
    diff("人数", (s) => (s.partySize === undefined ? "—" : `${s.partySize}人`));
    diff("付いている仮予約", (s) => idsText(s.provisionalIds));
  }
  if (entry.changedFields !== undefined) {
    lines.push(`変えた項目：${entry.changedFields.map((f) => customerFieldLabel[f]).join("、")}`);
  }
  if (entry.estimate !== undefined) {
    lines.push(`計算し直した見積：${formatYen(entry.estimate.estimateIncludingTax)}（税込）`);
  }
  return lines;
}

function HistoryTable({ history }: { history: HistoryEntry[] }) {
  if (history.length === 0) return <p>履歴はありません。</p>;
  return (
    <table aria-label="履歴">
      <thead>
        <tr>
          <th>日時（JST）</th>
          <th>誰が</th>
          <th>操作</th>
          <th>内容</th>
        </tr>
      </thead>
      <tbody>
        {history.map((entry, i) => (
          <tr key={i}>
            <td>{formatDateTime(entry.at)}</td>
            <td>{actorLabel(entry.actor)}</td>
            <td>{historyOperationLabel[entry.operation]}</td>
            <td>
              {describeHistoryChange(entry).map((line) => (
                <div key={line}>{line}</div>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
