// 予約の直接入力（POST /admin/reservations）。電話・メールで受けた予約を、承認待ちを経ずに仮予約・本予約・第二キープとして入れる
// （booking.md「直接入れる予約のルール」）。見積を確定金額の初期値にする。締め切りと深夜帯の最短4時間は警告で、確かめれば入れられる。
// 成功したら、その予約の詳細を開く
import type { AdminDirectEntryAccepted, AdminDirectEntryRequest } from "@zebra/contracts";
import { useState, type FormEvent } from "react";
import type { AdminApi } from "./api.ts";
import {
  buildContent,
  buildCustomer,
  emptyContentInput,
  emptyCustomerInput,
  estimateOf,
  type ContentInput,
  type CustomerInput,
} from "./reservation-input.ts";
import { ContentFields, CustomerFields, InputErrors } from "./ReservationFields.tsx";
import { listHref } from "./route.ts";
import { useWarningSubmit, WarningConfirmation, withAcknowledged } from "./warnings.tsx";

type Kind = AdminDirectEntryRequest["kind"];

const kindOptions: { value: Kind; label: string }[] = [
  { value: "provisional", label: "仮予約" },
  { value: "firm", label: "本予約" },
  { value: "second-hold", label: "第二キープ" },
];

const SECOND_HOLD_NOTE =
  "重なっている承認済みの仮予約すべてに付きます。どの仮予約とも重ならないときは入りません。";

export function DirectEntryPage(props: {
  api: AdminApi;
  /** 入ったとき（予約の id を渡す） */
  onCreated: (reservationId: string) => void;
}) {
  const { api, onCreated } = props;
  const [kind, setKind] = useState<Kind>();
  const [content, setContent] = useState<ContentInput>(emptyContentInput);
  const [customer, setCustomer] = useState<CustomerInput>(emptyCustomerInput);
  const [inputErrors, setInputErrors] = useState<string[]>();
  const estimate = estimateOf(content);
  const defaultPrice = estimate.ok ? String(estimate.quote.estimateIncludingTax) : "";

  const submission = useWarningSubmit<AdminDirectEntryAccepted>({
    onSucceeded: (accepted) => onCreated(accepted.reservationId),
    failurePrefix: "入れられませんでした。",
  });

  const edited = () => {
    setInputErrors(undefined);
    submission.reset();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const builtContent = buildContent(content, defaultPrice);
    const builtCustomer = buildCustomer(customer);
    const messages = [
      ...(kind === undefined ? ["予約の種類を選んでください。"] : []),
      ...(builtContent.ok ? [] : builtContent.messages),
      ...(builtCustomer.ok ? [] : builtCustomer.messages),
    ];
    if (kind === undefined || !builtContent.ok || !builtCustomer.ok) {
      setInputErrors(messages);
      return;
    }
    setInputErrors(undefined);
    const body: AdminDirectEntryRequest = {
      kind,
      ...builtContent.value,
      ...builtCustomer.value,
    };
    submission.submit((acknowledged) => api.directEntry(withAcknowledged(body, acknowledged)));
  };

  return (
    <section>
      <p>
        <a href={listHref()}>← 一覧へ</a>
      </p>
      <h2>予約を直接入れる</h2>
      <p>
        <small>
          電話・メールで受けた予約を、承認待ちを経ずに入れます。空き判定・30分単位・最短2時間・最長24時間は必ず守ります。締め切りと深夜帯の最短4時間は警告で、確かめれば入れられます。バッファは1時間で入ります（入れたあと、詳細から切り替えられます）。
        </small>
      </p>
      <form onSubmit={submit} aria-label="予約の直接入力" noValidate>
        <fieldset>
          <legend>予約の種類</legend>
          {kindOptions.map((option) => (
            <label key={option.value}>
              <input
                type="radio"
                name="kind"
                value={option.value}
                checked={kind === option.value}
                onChange={() => {
                  setKind(option.value);
                  edited();
                }}
              />
              {option.label}{" "}
            </label>
          ))}
          {kind === "second-hold" && (
            <p>
              <small>{SECOND_HOLD_NOTE}</small>
            </p>
          )}
        </fieldset>
        <ContentFields
          value={content}
          onChange={(next) => {
            setContent(next);
            edited();
          }}
          estimate={estimate}
          defaultPrice={defaultPrice}
          priceNote="初期値は見積です。"
        />
        <CustomerFields
          value={customer}
          onChange={(next) => {
            setCustomer(next);
            edited();
          }}
        />
        <InputErrors
          messages={
            inputErrors ?? (submission.error === undefined ? undefined : [submission.error])
          }
        />
        {submission.warnings === undefined ? (
          <p>
            <button type="submit" disabled={submission.busy}>
              入れる
            </button>
          </p>
        ) : (
          <WarningConfirmation
            warnings={submission.warnings}
            busy={submission.busy}
            confirmLabel="警告を確かめたうえで入れる"
            onConfirm={submission.confirm}
            onCancel={submission.reset}
          />
        )}
      </form>
    </section>
  );
}
