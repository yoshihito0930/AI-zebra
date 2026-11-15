// ブロック枠を入れる（POST /admin/blocks）・直す（PUT /admin/blocks/{id}）・消す（DELETE /admin/blocks/{id}）。
// 区間（JST）・バッファ（なし・30分・1時間。初期値はなし）・理由のメモ。直すときも全部を送る（booking.md「ブロック枠を消す・直す」）。
// ブロック枠の詳細のルートはないので、直すときの今の内容は一覧の行の値を使う。Googleカレンダーから取り込んだものは、直す・消すを出さない
import { AdminBlockRequest, type AdminReservationList } from "@zebra/contracts";
import { useState, type FormEvent } from "react";
import type { AdminApi, ApiFailure, ApiResult } from "./api.ts";
import { formatTimeRange, fromJstInput, toJstInput } from "./format.ts";
import { failureMessage } from "./labels.ts";
import { InputErrors } from "./ReservationFields.tsx";

export type Block = AdminReservationList["blocks"][number];
type BufferMinutes = AdminBlockRequest["bufferMinutes"];

export const blockBufferLabel: Record<BufferMinutes, string> = {
  0: "なし",
  30: "30分",
  60: "1時間",
};

/** ブロック枠の入力。日時は入力欄の値（JST の「2026-11-20T13:00」） */
export interface BlockInput {
  start: string;
  end: string;
  bufferMinutes: BufferMinutes;
  memo: string;
}

const emptyBlockInput = (): BlockInput => ({ start: "", end: "", bufferMinutes: 0, memo: "" });

/** 直すときの初期値：一覧の行の値 */
export const blockInputOf = (block: Block): BlockInput => ({
  start: toJstInput(block.start),
  end: toJstInput(block.end),
  bufferMinutes: block.bufferMinutes,
  memo: block.memo ?? "",
});

/** ブロック枠の入力を、本文の形（AdminBlockRequest）にする。メモは前後の空白を除き、空なら送らない */
export function buildBlock(
  input: BlockInput,
): { ok: true; value: AdminBlockRequest } | { ok: false; messages: string[] } {
  const start = fromJstInput(input.start);
  const end = fromJstInput(input.end);
  const memo = input.memo.trim();
  const messages: string[] = [];
  if (start === undefined) messages.push("開始の日時を入れてください。");
  if (end === undefined) messages.push("終わりの日時を入れてください。");
  if (start === undefined || end === undefined) return { ok: false, messages };
  const parsed = AdminBlockRequest.safeParse({
    start,
    end,
    bufferMinutes: input.bufferMinutes,
    ...(memo === "" ? {} : { memo }),
  });
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, messages: ["理由のメモが長すぎます（500文字まで）。"] };
}

/** ブロック枠の操作の失敗を、管理者に見せる文にする（ないときは「予約」ではなく「ブロック枠」と書く） */
export function blockFailureMessage(failure: ApiFailure): string {
  return failure.kind === "rejected" && failure.error === "not-found"
    ? "ブロック枠が見つかりません。一覧を読み直してください。"
    : failureMessage(failure);
}

/** ブロック枠を入れる・直すフォーム。block を渡すと直す（初期値はその行の値） */
export function BlockForm(props: {
  api: AdminApi;
  block?: Block;
  onSaved: (message: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const { api, block, onSaved, onCancel } = props;
  const editing = block !== undefined;
  const [input, setInput] = useState<BlockInput>(() =>
    block === undefined ? emptyBlockInput() : blockInputOf(block),
  );
  const [errors, setErrors] = useState<string[]>();
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<BlockInput>) => {
    setInput({ ...input, ...patch });
    setErrors(undefined);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const built = buildBlock(input);
    if (!built.ok) {
      setErrors(built.messages);
      return;
    }
    setBusy(true);
    setErrors(undefined);
    const result: ApiResult<unknown> = editing
      ? await api.updateBlock(block.id, built.value)
      : await api.createBlock(built.value);
    if (result.ok) {
      await onSaved(editing ? "ブロック枠を直しました。" : "ブロック枠を入れました。");
    } else {
      setErrors([
        `${editing ? "直せませんでした。" : "入れられませんでした。"}${blockFailureMessage(result.failure)}`,
      ]);
    }
    setBusy(false);
  };

  const title = editing ? "ブロック枠を直す" : "ブロック枠を入れる";
  return (
    <form onSubmit={(e) => void submit(e)} aria-label={title} noValidate>
      <h3>{title}</h3>
      <p>
        <label>
          開始（JST）{" "}
          <input
            type="datetime-local"
            step={1800}
            value={input.start}
            onChange={(e) => set({ start: e.target.value })}
          />
        </label>{" "}
        <label>
          終わり（JST）{" "}
          <input
            type="datetime-local"
            step={1800}
            value={input.end}
            onChange={(e) => set({ end: e.target.value })}
          />
        </label>
      </p>
      <p>
        <label>
          後ろのバッファ{" "}
          <select
            value={input.bufferMinutes}
            onChange={(e) => {
              const minutes = Number(e.target.value);
              set({ bufferMinutes: minutes === 30 ? 30 : minutes === 60 ? 60 : 0 });
            }}
          >
            {([0, 30, 60] as const).map((minutes) => (
              <option key={minutes} value={minutes}>
                {blockBufferLabel[minutes]}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          理由のメモ <input value={input.memo} onChange={(e) => set({ memo: e.target.value })} />
        </label>
      </p>
      <p>
        <small>
          開始・終わりは30分単位です。24時間を超えてもかまいません（かかる日が90日まで）。ほかの予約・ブロック枠と重なるときは入りません。
          {editing && "空き判定では、直す前のこのブロック枠は除きます。"}
        </small>
      </p>
      <InputErrors messages={errors} />
      <p>
        <button type="submit" disabled={busy}>
          {editing ? "直す" : "入れる"}
        </button>{" "}
        <button type="button" disabled={busy} onClick={onCancel}>
          やめる
        </button>
      </p>
    </form>
  );
}

/** ブロック枠を消す前の確認 */
export function BlockDeleteConfirm(props: {
  api: AdminApi;
  block: Block;
  onDeleted: (message: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const { api, block, onDeleted, onCancel } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const remove = async () => {
    setBusy(true);
    setError(undefined);
    const result = await api.deleteBlock(block.id);
    if (result.ok) {
      await onDeleted("ブロック枠を消しました。");
    } else {
      setError(`消せませんでした。${blockFailureMessage(result.failure)}`);
    }
    setBusy(false);
  };

  return (
    <div role="group" aria-label="ブロック枠を消す確認">
      <p>
        ブロック枠 {formatTimeRange(block.start, block.end)}
        {block.memo === undefined ? "" : `（${block.memo}）`}
        を消すと、その時間は空きに戻ります。記録は残りません。消しますか？
      </p>
      {error !== undefined && <p role="alert">{error}</p>}
      <button type="button" disabled={busy} onClick={() => void remove()}>
        消す
      </button>{" "}
      <button type="button" disabled={busy} onClick={onCancel}>
        やめる
      </button>
    </div>
  );
}
