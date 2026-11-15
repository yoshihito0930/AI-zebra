// 受付番号から探す（GET /admin/receipts/{受付番号}）。見つかったら、その予約の詳細を開く。
// 取消・終了した予約は一覧に出ないので、ここから開く
import { ReceiptNumber } from "@zebra/contracts";
import { useState, type FormEvent } from "react";
import type { AdminApi } from "./api.ts";
import { failureMessage } from "./labels.ts";

export function ReceiptSearch(props: { api: AdminApi; onFound: (reservationId: string) => void }) {
  const { api, onFound } = props;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    // お客様が小文字で伝えることもあるので、大文字にそろえる
    const receiptNumber = ReceiptNumber.safeParse(text.trim().toUpperCase());
    if (!receiptNumber.success) {
      setError("受付番号は8文字の英数字です（0・1・I・O は使いません）。");
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await api.lookupReceipt(receiptNumber.data);
    setBusy(false);
    if (result.ok) {
      setText("");
      onFound(result.value.reservationId);
      return;
    }
    const { failure } = result;
    setError(
      failure.kind === "rejected" && failure.error === "not-found"
        ? "その受付番号の予約はありません。"
        : failureMessage(failure),
    );
  };

  return (
    <form onSubmit={(e) => void submit(e)} aria-label="受付番号から探す">
      <label>
        受付番号{" "}
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="例：ABCD2345" />
      </label>{" "}
      <button type="submit" disabled={busy}>
        開く
      </button>
      {error !== undefined && <span role="alert"> {error}</span>}
    </form>
  );
}
