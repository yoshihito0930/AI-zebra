// 詳細からの操作（POST /admin/reservations/{id}/{approve|reject|promote|cancel|move-up}）と、その結果（作った下書きの一覧）。
// 出す操作は、今の状態でできるもの（reservation-model.md「状態と操作」）。判定は API が行い、できなければ理由を日本語で出す
import type {
  AdminOperationAccepted,
  AdminReservationDetail,
  ReservationStatus,
} from "@zebra/contracts";
import { useState, type FormEvent } from "react";
import type { AdminApi, AdminOperation, ApiResult } from "./api.ts";
import { formatYen, parseYenInput } from "./format.ts";
import { draftKindLabel, failureMessage } from "./labels.ts";
import { detailHref } from "./route.ts";

export const operationLabel: Record<AdminOperation, string> = {
  approve: "承認",
  reject: "却下",
  promote: "昇格",
  cancel: "取消",
  "move-up": "繰り上げ",
};

/** 状態ごとにできる操作（reservation-model.md「状態と操作」） */
export const operationsByStatus: Record<ReservationStatus, readonly AdminOperation[]> = {
  "pending-provisional": ["approve", "reject"],
  "pending-firm": ["approve", "reject"],
  "pending-second-hold": ["approve", "reject"],
  provisional: ["promote", "cancel"],
  firm: ["cancel"],
  "second-hold": ["move-up", "cancel"],
  cancelled: [],
  ended: [],
};

type Confirming = "reject" | "cancel" | undefined;

export function OperationPanel(props: {
  api: AdminApi;
  detail: AdminReservationDetail;
  /** 成功したとき。返した Promise が終わるまで（詳細を読み直すまで）、操作のボタンを押せなくする */
  onSucceeded: (operation: AdminOperation, accepted: AdminOperationAccepted) => Promise<void>;
}) {
  const { api, detail, onSucceeded } = props;
  const operations = operationsByStatus[detail.status];
  const [price, setPrice] = useState(String(detail.estimate.estimateIncludingTax));
  const [confirming, setConfirming] = useState<Confirming>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  if (operations.length === 0) {
    return (
      <section aria-label="操作">
        <h3>操作</h3>
        <p>この状態の予約にできる操作はありません。</p>
      </section>
    );
  }

  const run = async (
    operation: AdminOperation,
    send: () => Promise<ApiResult<AdminOperationAccepted>>,
  ) => {
    setBusy(true);
    setError(undefined);
    const result = await send();
    setConfirming(undefined);
    if (result.ok) {
      // 詳細を読み直すまでは、同じ操作をもう一度押せないようにしておく
      await onSucceeded(operation, result.value);
    } else {
      setError(`${operationLabel[operation]}できませんでした。${failureMessage(result.failure)}`);
    }
    setBusy(false);
  };

  const approve = (event: FormEvent) => {
    event.preventDefault();
    const confirmedPrice = parseYenInput(price);
    if (confirmedPrice === undefined) {
      setError("確定金額は、0以上の整数（円）で入れてください。");
      return;
    }
    void run("approve", () => api.approve(detail.id, confirmedPrice));
  };

  const simple = (operation: Exclude<AdminOperation, "approve">) =>
    void run(operation, () => api.operate(detail.id, operation));

  const fee = detail.cancellationFeeIfCancelledNow;

  return (
    <section aria-label="操作">
      <h3>操作</h3>
      {error !== undefined && <p role="alert">{error}</p>}

      {operations.includes("approve") && (
        <form onSubmit={approve} aria-label="承認">
          <label>
            確定金額（税込・円）{" "}
            <input
              type="text"
              inputMode="numeric"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </label>{" "}
          <button type="submit" disabled={busy}>
            承認する
          </button>
          <p>
            <small>
              初期値は申込のときの見積（{formatYen(detail.estimate.estimateIncludingTax)}）です。
              {detail.currentEstimate !== undefined &&
                `今の料金表での見積は ${formatYen(detail.currentEstimate.estimateIncludingTax)} です。`}
            </small>
          </p>
        </form>
      )}

      {operations.includes("reject") &&
        (confirming === "reject" ? (
          <div role="group" aria-label="却下の確認">
            <p>却下すると、予約は取消になり、枠を解放します。却下しますか？</p>
            <button type="button" disabled={busy} onClick={() => simple("reject")}>
              却下する
            </button>{" "}
            <button type="button" disabled={busy} onClick={() => setConfirming(undefined)}>
              やめる
            </button>
          </div>
        ) : (
          <p>
            <button type="button" disabled={busy} onClick={() => setConfirming("reject")}>
              却下…
            </button>
          </p>
        ))}

      {operations.includes("promote") && (
        <p>
          <button type="button" disabled={busy} onClick={() => simple("promote")}>
            本予約に昇格する
          </button>{" "}
          <small>付いている第二キープは終了になります。</small>
        </p>
      )}

      {operations.includes("move-up") && (
        <p>
          <button type="button" disabled={busy} onClick={() => simple("move-up")}>
            仮予約に繰り上げる
          </button>{" "}
          <small>お客様の承諾を受けてから操作してください。</small>
        </p>
      )}

      {operations.includes("cancel") &&
        (confirming === "cancel" ? (
          <div role="group" aria-label="取消の確認">
            <p>
              {fee === undefined
                ? "今取消したときのキャンセル料を読めませんでした。"
                : `今取消したときのキャンセル料は ${formatYen(fee.fee)}（${fee.ratePercent}%）です。`}
              取消すと、枠を解放します。取消しますか？
            </p>
            <button type="button" disabled={busy} onClick={() => simple("cancel")}>
              取消する
            </button>{" "}
            <button type="button" disabled={busy} onClick={() => setConfirming(undefined)}>
              やめる
            </button>
          </div>
        ) : (
          <p>
            <button type="button" disabled={busy} onClick={() => setConfirming("cancel")}>
              取消…
            </button>
          </p>
        ))}
    </section>
  );
}

type Draft = AdminOperationAccepted["drafts"][number];

/** 下書きに差し込む値（あれば） */
function draftValues(draft: Draft): string | undefined {
  switch (draft.kind) {
    case "approval":
      return `確定金額 ${formatYen(draft.confirmedPrice)}`;
    case "cancellation":
      return `キャンセル料 ${formatYen(draft.cancellationFee.fee)}（${draft.cancellationFee.ratePercent}%）`;
    case "move-up-notice":
      return draft.remainingProvisionalIds.length === 0
        ? "残っている仮予約なし（繰り上げられます）"
        : `残っている仮予約：${draft.remainingProvisionalIds.join("、")}`;
    default:
      return undefined;
  }
}

/**
 * 操作・変更が成功したときの表示：結果の文と、作った下書きの一覧（下書きを作らない操作では accepted を渡さない）。
 * 下書きを開いて Gmail から送る画面は次の更新で作る
 */
export function OperationResult(props: {
  message: string;
  accepted?: AdminOperationAccepted | undefined;
  reservationId: string;
}) {
  const { message, accepted, reservationId } = props;
  return (
    <section role="status" aria-label="操作の結果">
      <p>{message}</p>
      {accepted === undefined ? null : accepted.drafts.length === 0 ? (
        <p>作ったメールの下書きはありません。</p>
      ) : (
        <>
          <p>作ったメールの下書き（まだ送っていません）：</p>
          <ul>
            {accepted.drafts.map((draft, i) => {
              const values = draftValues(draft);
              return (
                <li key={i}>
                  {draftKindLabel[draft.kind]}、あて先の予約：
                  {draft.reservationId === reservationId ? (
                    "この予約"
                  ) : (
                    <a href={detailHref(draft.reservationId)}>{draft.reservationId}</a>
                  )}
                  {values !== undefined && `、${values}`}
                </li>
              );
            })}
          </ul>
          <p>
            <small>
              下書きを開いて Gmail から送る画面は、まだありません（次の更新で作ります）。
            </small>
          </p>
        </>
      )}
    </section>
  );
}
