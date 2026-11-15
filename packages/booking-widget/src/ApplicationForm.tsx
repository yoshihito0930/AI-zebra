// 申込フォーム（docs/product-specs/booking.md「申込フォーム」）。入力に応じて見積額（税込）を表示する。
// 送る本文は契約 ApplicationRequest の形にし、返事は契約でパースする（INV-4。api.ts）。
// 受け付けたら受付番号と見積額を出す（予約の成立や空きの可否は書かない）。断られたら理由を日本語で出す
import type { ApplicationAccepted, PriceTable } from "@zebra/contracts";
import { useId, useState, type ReactNode } from "react";
import type { PublicApi } from "./api.ts";
import {
  MAX_PARTY_SIZE,
  SHOOTING_TYPES,
  TIME_OPTIONS,
  buildRequest,
  draftOf,
  emptyFormValues,
  type FormValues,
} from "./application-draft.ts";
import type { Now } from "./clock.ts";
import {
  formatDeadline,
  formatDuration,
  formatRange,
  formatYen,
  jstDate,
  type PublicBooking,
} from "./format.ts";
import { REJECTION_TEXT, SEND_FAILED_TEXT } from "./messages.ts";

export interface ApplicationFormLinks {
  /** ホリゾントルールのページ（docs/product-specs/index.md の HP の表） */
  horizon: string;
  /** 利用規約のページ */
  policy: string;
}

export interface ApplicationFormProps {
  api: PublicApi;
  now: Now;
  priceTable: PriceTable;
  /** カレンダーに出ている予約（重なりの案内に使う） */
  bookings: readonly PublicBooking[];
  /** 利用日（JST、YYYY-MM-DD）。カレンダーと共有する */
  date: string;
  onDateChange(date: string): void;
  /** 受け付けられたとき（カレンダーを読み直す） */
  onAccepted(): void;
  links: ApplicationFormLinks;
}

type Submission =
  | { status: "idle" }
  | { status: "sending" }
  | { status: "accepted"; accepted: ApplicationAccepted }
  | { status: "failed"; message: string; fields?: string[] };

export function ApplicationForm(props: ApplicationFormProps) {
  const [values, setValues] = useState<FormValues>(() => emptyFormValues());
  const [submission, setSubmission] = useState<Submission>({ status: "idle" });
  const id = useId();
  const now = props.now();

  const current: FormValues = { ...values, date: props.date };
  const draft = draftOf(current, { now, bookings: props.bookings, priceTable: props.priceTable });
  const set = <K extends keyof FormValues>(key: K, value: FormValues[K]) =>
    setValues((previous) => ({ ...previous, [key]: value }));
  const toggle = <T extends string>(list: T[], value: T, checked: boolean): T[] =>
    checked
      ? [...list.filter((item) => item !== value), value]
      : list.filter((item) => item !== value);

  if (submission.status === "accepted") {
    return (
      <section className="zw-form zw-accepted" aria-label="お申込みの受付">
        <h3>お申込みを受け付けました</h3>
        <dl>
          <dt>受付番号</dt>
          <dd className="zw-receipt">{submission.accepted.receiptNumber}</dd>
          <dt>見積額（税込）</dt>
          <dd>{formatYen(submission.accepted.estimateIncludingTax)}</dd>
        </dl>
        <p>
          スタジオで内容を確かめてから、ご連絡します。お問い合わせのときは、受付番号をお伝えください。
        </p>
        <button
          type="button"
          onClick={() => {
            setValues(emptyFormValues());
            setSubmission({ status: "idle" });
          }}
        >
          別の日時を申込む
        </button>
      </section>
    );
  }

  const sending = submission.status === "sending";
  const canSend =
    !sending &&
    current.agreedToCycloramaRules &&
    current.agreedToTerms &&
    draft.problems.length === 0;

  const submit = async () => {
    const built = buildRequest(current, draft);
    if (!built.ok) {
      setSubmission({
        status: "failed",
        message: "入力が足りない・正しくない欄があります。",
        fields: built.fields,
      });
      return;
    }
    setSubmission({ status: "sending" });
    const result = await props.api.apply(built.request);
    if (result.ok) {
      setSubmission({ status: "accepted", accepted: result.value });
      props.onAccepted();
      return;
    }
    setSubmission({
      status: "failed",
      message:
        result.failure.kind === "rejected"
          ? REJECTION_TEXT[result.failure.reason]
          : SEND_FAILED_TEXT,
    });
  };

  const field = (name: string) => `${id}-${name}`;

  return (
    <form
      className="zw-form"
      aria-label="申込フォーム"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3>申込フォーム</h3>
      <p className="zw-note">
        <span className="zw-required">必須</span> の欄は必ずご入力ください。
      </p>

      <fieldset>
        <legend>ご希望の利用日時</legend>
        <Guidance />
        <Row label="利用日" htmlFor={field("date")} required>
          <input
            id={field("date")}
            type="date"
            value={current.date}
            min={jstDate(now)}
            onChange={(event) => props.onDateChange(event.target.value)}
          />
        </Row>
        <Row label="開始" htmlFor={field("start")} required>
          <TimeSelect
            id={field("start")}
            value={current.startTime}
            onChange={(value) => set("startTime", value)}
          />
        </Row>
        <Row label="終了" htmlFor={field("end")} required>
          <TimeSelect
            id={field("end")}
            value={current.endTime}
            onChange={(value) => set("endTime", value)}
          />
        </Row>
        <p className="zw-note">
          開始・終了は30分単位です。終了が開始より前（または同じ）の時刻なら、翌日の時刻になります。ご利用は2時間から24時間まで（深夜帯
          23:00〜翌8:00 に少しでもかかるときは4時間から）です。
        </p>
        {draft.range !== undefined && (
          <p className="zw-summary" aria-live="polite">
            ご利用：{formatRange(draft.range.start, draft.range.end)}（
            {formatDuration(draft.range.start, draft.range.end)}）
          </p>
        )}
      </fieldset>

      <fieldset>
        <legend>
          予約の種類 <span className="zw-required">必須</span>
        </legend>
        {draft.secondHold ? (
          <p className="zw-info" role="status">
            ご希望の時間は「仮予約」と重なっています。<strong>第二キープ</strong>
            として申込みます。第二キープは、仮予約が取消になったときに繰り上がる順番待ちの予約です。
          </p>
        ) : (
          <>
            <label className="zw-choice">
              <input
                type="radio"
                name={field("kind")}
                value="firm"
                checked={current.kind === "firm"}
                onChange={() => set("kind", "firm")}
              />
              本予約
            </label>
            <label className="zw-choice">
              <input
                type="radio"
                name={field("kind")}
                value="provisional"
                checked={current.kind === "provisional"}
                disabled={!draft.provisionalSelectable}
                onChange={() => set("kind", "provisional")}
              />
              仮予約
              {draft.provisionalDeadline !== undefined &&
                `（期限 ${formatDeadline(draft.provisionalDeadline)}${draft.provisionalSelectable ? "" : "を過ぎたため選べません"}）`}
            </label>
            <p className="zw-note">
              仮予約は、利用日の7日前の18:00（仮予約の期限）まで枠を押さえる予約です。期限までに本予約にするかをお決めください。
            </p>
          </>
        )}
      </fieldset>

      {draft.problems.length > 0 && (
        <ul className="zw-problems" role="alert" aria-label="この日時では申込めません">
          {draft.problems.map((problem) => (
            <li key={problem}>{REJECTION_TEXT[problem]}</li>
          ))}
        </ul>
      )}

      <fieldset>
        <legend>ご利用の内容</legend>
        <Row label="ご利用人数" htmlFor={field("party")} required>
          <select
            id={field("party")}
            value={current.partySize}
            onChange={(event) => set("partySize", event.target.value)}
          >
            <option value="">選んでください</option>
            {Array.from({ length: MAX_PARTY_SIZE }, (_, index) => index + 1).map((size) => (
              <option key={size} value={String(size)}>
                {size}人
              </option>
            ))}
          </select>
        </Row>
        <p className="zw-note">15人以上でのご利用は、お問い合わせください。</p>

        <div className="zw-row" role="radiogroup" aria-label="ホリゾントの養生">
          <span className="zw-label">
            ホリゾントの養生 <span className="zw-required">必須</span>
          </span>
          <label className="zw-choice">
            <input
              type="radio"
              name={field("cyclorama")}
              checked={current.cycloramaFloorProtection === "yes"}
              onChange={() => set("cycloramaFloorProtection", "yes")}
            />
            あり（床面を全面養生する）
          </label>
          <label className="zw-choice">
            <input
              type="radio"
              name={field("cyclorama")}
              checked={current.cycloramaFloorProtection === "no"}
              onChange={() => set("cycloramaFloorProtection", "no")}
            />
            なし
          </label>
        </div>

        <label className="zw-choice">
          <input
            type="checkbox"
            checked={current.equipmentInsurance}
            onChange={(event) => set("equipmentInsurance", event.target.checked)}
          />
          機材保険を付ける
        </label>

        <div className="zw-row" role="group" aria-label="オプション">
          <span className="zw-label">オプション</span>
          {props.priceTable.options.map((option) => (
            <label key={option.id} className="zw-choice">
              <input
                type="checkbox"
                checked={current.optionIds.includes(option.id)}
                onChange={(event) =>
                  set("optionIds", toggle(current.optionIds, option.id, event.target.checked))
                }
              />
              {option.name}
            </label>
          ))}
        </div>

        <div className="zw-estimate" aria-live="polite">
          {draft.estimate === undefined ? (
            <p>見積額（税込）：利用日時・人数・ホリゾントの養生を選ぶと表示します</p>
          ) : (
            <p>
              見積額（税込）：<strong>{formatYen(draft.estimate.estimateIncludingTax)}</strong>（
              {draft.estimate.planName}）
            </p>
          )}
          <p className="zw-note">
            プランは人数とホリゾントの養生で決まります。表示するのは見積額で、金額はスタジオで確かめます。
          </p>
        </div>
      </fieldset>

      <fieldset>
        <legend>撮影の内容</legend>
        <div className="zw-row" role="group" aria-label="撮影内容">
          <span className="zw-label">
            撮影内容 <span className="zw-required">必須</span>
          </span>
          {SHOOTING_TYPES.map((type) => (
            <label key={type.value} className="zw-choice">
              <input
                type="checkbox"
                checked={current.shootingTypes.includes(type.value)}
                onChange={(event) =>
                  set(
                    "shootingTypes",
                    toggle(current.shootingTypes, type.value, event.target.checked),
                  )
                }
              />
              {type.text}
            </label>
          ))}
        </div>
        {current.shootingTypes.includes("music") && (
          <p className="zw-info">
            楽器の演奏を伴う撮影には制限があります。お申込みの内容を見て、スタジオからご連絡します。
          </p>
        )}
        <Row label="撮影詳細" htmlFor={field("details")} required>
          <textarea
            id={field("details")}
            rows={3}
            maxLength={2000}
            value={current.shootingDetails}
            onChange={(event) => set("shootingDetails", event.target.value)}
          />
        </Row>
        <Row label="補足事項" htmlFor={field("notes")}>
          <textarea
            id={field("notes")}
            rows={3}
            maxLength={2000}
            value={current.notes}
            onChange={(event) => set("notes", event.target.value)}
          />
        </Row>
      </fieldset>

      <fieldset>
        <legend>お客様の情報</legend>
        <TextRow
          id={field("name")}
          label="氏名"
          required
          maxLength={100}
          value={current.name}
          onChange={(v) => set("name", v)}
          autoComplete="name"
        />
        <TextRow
          id={field("company")}
          label="会社名"
          maxLength={100}
          value={current.companyName}
          onChange={(v) => set("companyName", v)}
          autoComplete="organization"
        />
        <TextRow
          id={field("email")}
          label="メールアドレス"
          required
          type="email"
          maxLength={254}
          value={current.email}
          onChange={(v) => set("email", v)}
          autoComplete="email"
        />
        <TextRow
          id={field("phone")}
          label="電話番号"
          required
          type="tel"
          maxLength={20}
          value={current.phone}
          onChange={(v) => set("phone", v)}
          autoComplete="tel"
        />
        <TextRow
          id={field("address")}
          label="住所"
          required
          maxLength={200}
          value={current.address}
          onChange={(v) => set("address", v)}
          autoComplete="street-address"
        />
        <TextRow
          id={field("photographer")}
          label="カメラマン氏名"
          required
          maxLength={100}
          value={current.photographerName}
          onChange={(v) => set("photographerName", v)}
        />
      </fieldset>

      <fieldset>
        <legend>確認と同意</legend>
        <label className="zw-choice">
          <input
            type="checkbox"
            checked={current.agreedToCycloramaRules}
            onChange={(event) => set("agreedToCycloramaRules", event.target.checked)}
          />
          <span>
            <a href={props.links.horizon} target="_blank" rel="noopener">
              ホリゾントルール
            </a>
            を確認しました <span className="zw-required">必須</span>
          </span>
        </label>
        <label className="zw-choice">
          <input
            type="checkbox"
            checked={current.agreedToTerms}
            onChange={(event) => set("agreedToTerms", event.target.checked)}
          />
          <span>
            <a href={props.links.policy} target="_blank" rel="noopener">
              利用規約
            </a>
            に同意します <span className="zw-required">必須</span>
          </span>
        </label>
      </fieldset>

      {submission.status === "failed" && (
        <div className="zw-problems" role="alert">
          <p>{submission.message}</p>
          {submission.fields !== undefined && submission.fields.length > 0 && (
            <ul>
              {submission.fields.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      <button type="submit" className="zw-submit" disabled={!canSend}>
        {sending ? "送信しています…" : draft.secondHold ? "第二キープとして申込む" : "申込む"}
      </button>
    </form>
  );
}

/** 第二キープと予約の間の案内（カレンダーとフォームの両方に出す。index.md「予約ウィジェット」） */
export function Guidance() {
  return (
    <ul className="zw-guidance">
      <li>第二キープを申込めるのは、カレンダーの「仮予約」の時間と重なるときだけです。</li>
      <li>
        予約と予約の間は1時間空けてください（前の予約の終わりから1時間は、次の予約を入れられません）。
      </li>
    </ul>
  );
}

function Row(props: { label: string; htmlFor: string; required?: boolean; children: ReactNode }) {
  return (
    <div className="zw-row">
      <label className="zw-label" htmlFor={props.htmlFor}>
        {props.label}
        {props.required === true && (
          <>
            {" "}
            <span className="zw-required">必須</span>
          </>
        )}
      </label>
      {props.children}
    </div>
  );
}

function TextRow(props: {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  maxLength: number;
  required?: boolean;
  type?: "text" | "email" | "tel";
  autoComplete?: string;
}) {
  return (
    <Row label={props.label} htmlFor={props.id} required={props.required === true}>
      <input
        id={props.id}
        type={props.type ?? "text"}
        maxLength={props.maxLength}
        value={props.value}
        autoComplete={props.autoComplete}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </Row>
  );
}

function TimeSelect(props: { id: string; value: string; onChange(value: string): void }) {
  return (
    <select
      id={props.id}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    >
      <option value="">選んでください</option>
      {TIME_OPTIONS.map((time) => (
        <option key={time} value={time}>
          {time.replace(/^0/, "")}
        </option>
      ))}
    </select>
  );
}
