// 警告の確認（docs/design-docs/admin-api.md「警告の確認」）。予約の変更と直接入力で使う。
// 1回目は確認なしで送り、409（unacknowledged-warnings）で返った警告を日本語で見せる。管理者が確かめたら、
// その警告の一覧を acknowledgedWarnings に付けて、同じ入力を送り直す。不可（422 など）は理由を出して止める
import type { AdminWarning } from "@zebra/contracts";
import { useState } from "react";
import type { ApiResult } from "./api.ts";
import { failureMessage, warningLabel } from "./labels.ts";

/** 確認した警告を本文に付ける。何も確認していないときは付けない（契約では、省略は空と同じ） */
export const withAcknowledged = <T extends object>(
  body: T,
  acknowledged: readonly AdminWarning[],
): T & { acknowledgedWarnings?: AdminWarning[] } =>
  acknowledged.length === 0 ? body : { ...body, acknowledgedWarnings: [...acknowledged] };

/** 確認した警告の一覧を付けて送る */
export type SendWithAcknowledged<T> = (
  acknowledged: readonly AdminWarning[],
) => Promise<ApiResult<T>>;

export function useWarningSubmit<T>(options: {
  /** 成功したとき。返した Promise が終わるまで、送るボタンを押せなくする */
  onSucceeded: (value: T) => Promise<void> | void;
  /** 失敗の文の頭（例：「変更できませんでした。」） */
  failurePrefix: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  /** 確かめてもらう警告（API が 409 で返したもの）と、それを返した入力の送り方 */
  const [pending, setPending] = useState<{
    warnings: AdminWarning[];
    send: SendWithAcknowledged<T>;
  }>();

  const run = async (send: SendWithAcknowledged<T>, acknowledged: readonly AdminWarning[]) => {
    setBusy(true);
    setError(undefined);
    setPending(undefined);
    const result = await send(acknowledged);
    if (result.ok) {
      await options.onSucceeded(result.value);
    } else if (
      result.failure.kind === "rejected" &&
      result.failure.error === "unacknowledged-warnings" &&
      result.failure.warnings !== undefined
    ) {
      setPending({ warnings: result.failure.warnings, send });
    } else {
      setError(`${options.failurePrefix}${failureMessage(result.failure)}`);
    }
    setBusy(false);
  };

  return {
    busy,
    error,
    /** 確かめてもらう警告。なければ undefined */
    warnings: pending?.warnings,
    /** 確認なしで送る（1回目） */
    submit: (send: SendWithAcknowledged<T>) => void run(send, []),
    /** 見せた警告を確認したものとして、同じ入力を送り直す */
    confirm: () => {
      if (pending !== undefined) void run(pending.send, pending.warnings);
    },
    /** やめたとき・入力を直したとき：見せていた警告とエラーを消す（直したあとの入力の警告は、送ったときに API が出す） */
    reset: () => {
      setPending(undefined);
      setError(undefined);
    },
  };
}

/** 見せる警告と、確かめて送り直すボタン */
export function WarningConfirmation(props: {
  warnings: readonly AdminWarning[];
  busy: boolean;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="group" aria-label="警告の確認">
      <p>次の警告があります。確かめたうえで進めるときは、下のボタンを押してください。</p>
      <ul>
        {props.warnings.map((warning) => (
          <li key={warning}>{warningLabel[warning]}</li>
        ))}
      </ul>
      <button type="button" disabled={props.busy} onClick={props.onConfirm}>
        {props.confirmLabel}
      </button>{" "}
      <button type="button" disabled={props.busy} onClick={props.onCancel}>
        やめる
      </button>
    </div>
  );
}
