// 詳細から直す（2回目）：予約の変更（POST /admin/reservations/{id}/change）、バッファの切り替え（POST …/buffer）、
// お客様の情報・撮影の内容の変更（PUT …/customer）。
// 変更とバッファの切り替えができるのは、承認済みの仮予約・本予約だけ（booking.md「予約の変更」「バッファを30分に縮める」）。
// お客様の情報は、どの状態の予約でも直せる（booking.md「お客様の情報・撮影の内容を直す」）。判定は API が行い、できなければ理由を日本語で出す
import type {
  AdminBufferRequest,
  AdminOperationAccepted,
  AdminReservationDetail,
  ReservationStatus,
} from "@zebra/contracts";
import { useState, type FormEvent } from "react";
import type { AdminApi } from "./api.ts";
import { failureMessage } from "./labels.ts";
import {
  buildContent,
  buildCustomer,
  contentChanged,
  contentInputOf,
  customerInputOf,
  estimateOf,
  type ContentInput,
  type CustomerInput,
} from "./reservation-input.ts";
import { ContentFields, CustomerFields, InputErrors } from "./ReservationFields.tsx";
import { useWarningSubmit, WarningConfirmation, withAcknowledged } from "./warnings.tsx";

/** 変更・バッファの切り替えができる状態（承認済みの仮予約・本予約） */
const CHANGEABLE: readonly ReservationStatus[] = ["provisional", "firm"];

export const isChangeable = (status: ReservationStatus): boolean => CHANGEABLE.includes(status);

/** 直したあと：結果の文と、作った下書き（あれば）。返した Promise が終わるまで（詳細を読み直すまで）待つ */
export type OnEdited = (message: string, accepted?: AdminOperationAccepted) => Promise<void>;

type Editing = "change" | "customer" | undefined;

export function ReservationEditPanel(props: {
  api: AdminApi;
  detail: AdminReservationDetail;
  onEdited: OnEdited;
}) {
  const { api, detail, onEdited } = props;
  const [editing, setEditing] = useState<Editing>();
  const changeable = isChangeable(detail.status);
  const close = () => setEditing(undefined);
  const edited: OnEdited = async (message, accepted) => {
    close();
    await onEdited(message, accepted);
  };

  return (
    <section aria-label="直す">
      <h3>直す</h3>
      {!changeable && (
        <p>
          <small>
            予約の変更とバッファの切り替えは、承認済みの仮予約・本予約だけでできます。お客様の情報・撮影の内容は、どの状態でも直せます。
          </small>
        </p>
      )}
      {editing === undefined && (
        <p>
          {changeable && (
            <>
              <button type="button" onClick={() => setEditing("change")}>
                予約を変更…
              </button>{" "}
            </>
          )}
          <button type="button" onClick={() => setEditing("customer")}>
            お客様の情報・撮影の内容を直す…
          </button>
        </p>
      )}
      {editing === "change" && (
        <ReservationChangeForm api={api} detail={detail} onEdited={edited} onCancel={close} />
      )}
      {editing === "customer" && (
        <CustomerEditForm api={api} detail={detail} onEdited={edited} onCancel={close} />
      )}
      {changeable && editing === undefined && (
        <BufferPanel key={detail.updatedAt} api={api} detail={detail} onEdited={onEdited} />
      )}
    </section>
  );
}

/** 予約の変更。初期値は今の予約の値。日時を変えないときも、今の日時を送る（admin-api.md「予約の変更」） */
export function ReservationChangeForm(props: {
  api: AdminApi;
  detail: AdminReservationDetail;
  onEdited: OnEdited;
  onCancel: () => void;
}) {
  const { api, detail, onEdited, onCancel } = props;
  const [input, setInput] = useState<ContentInput>(() => contentInputOf(detail));
  const [inputErrors, setInputErrors] = useState<string[]>();
  const estimate = estimateOf(input);
  // 確定金額の初期値：内容が今のままなら今の確定金額、内容を変えたら見積
  const changed = contentChanged(input, detail);
  const currentPrice = String(detail.confirmedPrice ?? detail.estimate.estimateIncludingTax);
  const defaultPrice = changed
    ? estimate.ok
      ? String(estimate.quote.estimateIncludingTax)
      : ""
    : currentPrice;

  const submission = useWarningSubmit<AdminOperationAccepted>({
    onSucceeded: (accepted) => onEdited("予約を変更しました。", accepted),
    failurePrefix: "変更できませんでした。",
  });

  const update = (next: ContentInput) => {
    setInput(next);
    setInputErrors(undefined);
    submission.reset();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const built = buildContent(input, defaultPrice);
    if (!built.ok) {
      setInputErrors(built.messages);
      return;
    }
    // 何も変えずに送ると、API はそのまま変更として扱い、お客様への変更のお知らせの下書きを作るので、送らない
    if (!changed && String(built.value.confirmedPrice) === currentPrice) {
      setInputErrors(["変えたところがありません。"]);
      return;
    }
    setInputErrors(undefined);
    const body = built.value;
    submission.submit((acknowledged) =>
      api.change(detail.id, withAcknowledged(body, acknowledged)),
    );
  };

  return (
    <form onSubmit={submit} aria-label="予約の変更" noValidate>
      <h4>予約の変更</h4>
      <ContentFields
        value={input}
        onChange={update}
        estimate={estimate}
        defaultPrice={defaultPrice}
        priceNote={
          changed
            ? "内容を変えたので、初期値は見積です。"
            : "初期値は今の確定金額です。内容を変えると、見積に合わせます。"
        }
      />
      <p>
        <small>
          状態は変わりません。日時を変えると、締め切りと深夜帯の最短4時間を確かめます（警告は、確かめれば変えられます）。お客様への変更のお知らせの下書きを作ります（送りません）。
        </small>
      </p>
      <InputErrors
        messages={inputErrors ?? (submission.error === undefined ? undefined : [submission.error])}
      />
      {submission.warnings === undefined ? (
        <p>
          <button type="submit" disabled={submission.busy}>
            変更する
          </button>{" "}
          <button type="button" disabled={submission.busy} onClick={onCancel}>
            やめる
          </button>
        </p>
      ) : (
        <WarningConfirmation
          warnings={submission.warnings}
          busy={submission.busy}
          confirmLabel="警告を確かめたうえで変更する"
          onConfirm={submission.confirm}
          onCancel={submission.reset}
        />
      )}
    </form>
  );
}

const bufferLabel: Record<AdminBufferRequest["bufferMinutes"], string> = {
  30: "30分",
  60: "1時間",
};

/** バッファの切り替え（30分・1時間）。成功したら、作った下書き（第二キープの繰り上げ案内など）の一覧を出す */
export function BufferPanel(props: {
  api: AdminApi;
  detail: AdminReservationDetail;
  onEdited: OnEdited;
}) {
  const { api, detail, onEdited } = props;
  const [minutes, setMinutes] = useState<AdminBufferRequest["bufferMinutes"]>(detail.bufferMinutes);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const result = await api.changeBuffer(detail.id, minutes);
    if (result.ok) {
      await onEdited(`バッファを${bufferLabel[minutes]}にしました。`, result.value);
    } else {
      setError(`バッファを切り替えられませんでした。${failureMessage(result.failure)}`);
    }
    setBusy(false);
  };

  return (
    <form onSubmit={(e) => void submit(e)} aria-label="バッファの切り替え">
      <h4>バッファの切り替え</h4>
      <p>
        <label>
          予約の後ろのバッファ{" "}
          <select value={minutes} onChange={(e) => setMinutes(e.target.value === "30" ? 30 : 60)}>
            <option value={60}>{bufferLabel[60]}</option>
            <option value={30}>{bufferLabel[30]}</option>
          </select>
        </label>{" "}
        <button type="submit" disabled={busy || minutes === detail.bufferMinutes}>
          切り替える
        </button>
      </p>
      <p>
        <small>
          今は{bufferLabel[detail.bufferMinutes]}
          です。1時間に戻すときも、空き判定を通します。お客様への下書きは作りません（仮予約を縮めて第二キープと重ならなくなったときだけ、第二キープのお客様への繰り上げ案内を作ります）。
        </small>
      </p>
      {error !== undefined && <p role="alert">{error}</p>}
    </form>
  );
}

/** お客様の情報・撮影の内容の変更。全部の欄を送って置き換える（空にした欄は送らないので、消える） */
export function CustomerEditForm(props: {
  api: AdminApi;
  detail: AdminReservationDetail;
  onEdited: OnEdited;
  onCancel: () => void;
}) {
  const { api, detail, onEdited, onCancel } = props;
  const [input, setInput] = useState<CustomerInput>(() => customerInputOf(detail));
  const [errors, setErrors] = useState<string[]>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const built = buildCustomer(input);
    if (!built.ok) {
      setErrors(built.messages);
      return;
    }
    setBusy(true);
    setErrors(undefined);
    const result = await api.updateCustomer(detail.id, built.value);
    if (result.ok) {
      await onEdited("お客様の情報・撮影の内容を直しました。");
    } else {
      setErrors([`直せませんでした。${failureMessage(result.failure)}`]);
    }
    setBusy(false);
  };

  return (
    <form onSubmit={(e) => void submit(e)} aria-label="お客様の情報・撮影の内容を直す" noValidate>
      <h4>お客様の情報・撮影の内容を直す</h4>
      <CustomerFields
        value={input}
        onChange={(next) => {
          setInput(next);
          setErrors(undefined);
        }}
      />
      <p>
        <small>
          全部の欄を送って置き換えます。空にした欄は消えます。お客様への下書きは作りません。
        </small>
      </p>
      <InputErrors messages={errors} />
      <p>
        <button type="submit" disabled={busy}>
          直す
        </button>{" "}
        <button type="button" disabled={busy} onClick={onCancel}>
          やめる
        </button>
      </p>
    </form>
  );
}
