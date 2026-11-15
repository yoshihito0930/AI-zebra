// 予約の内容（日時・人数・ホリゾントの養生・機材保険・オプション・確定金額）と、お客様の情報・撮影の内容の入力欄。
// 予約の変更・直接入力・お客様の情報の変更のフォームで使う。日時は JST で入力する（INV-7）
import { formatYen } from "./format.ts";
import { planLabel, shootingTypeLabel } from "./labels.ts";
import {
  priceTable,
  type ContentInput,
  type CustomerInput,
  type EstimateResult,
} from "./reservation-input.ts";

/** 日時の入力欄は30分ごと（秒で書く） */
const HALF_HOUR_STEP = 1800;

export function ContentFields(props: {
  value: ContentInput;
  onChange: (value: ContentInput) => void;
  estimate: EstimateResult;
  /** 確定金額の欄の初期値（管理者が入れるまで出す値） */
  defaultPrice: string;
  /** 確定金額の初期値の説明 */
  priceNote: string;
}) {
  const { value, onChange, estimate, defaultPrice, priceNote } = props;
  const set = (patch: Partial<ContentInput>) => onChange({ ...value, ...patch });
  const toggleOption = (id: string, checked: boolean) =>
    set({
      optionIds: checked
        ? [...value.optionIds.filter((o) => o !== id), id]
        : value.optionIds.filter((o) => o !== id),
    });

  return (
    <fieldset>
      <legend>予約の内容</legend>
      <p>
        <label>
          開始（JST）{" "}
          <input
            type="datetime-local"
            step={HALF_HOUR_STEP}
            value={value.start}
            onChange={(e) => set({ start: e.target.value })}
          />
        </label>{" "}
        <label>
          終わり（JST）{" "}
          <input
            type="datetime-local"
            step={HALF_HOUR_STEP}
            value={value.end}
            onChange={(e) => set({ end: e.target.value })}
          />
        </label>
      </p>
      <p>
        <label>
          人数{" "}
          <input
            type="number"
            min={1}
            inputMode="numeric"
            value={value.partySize}
            onChange={(e) => set({ partySize: e.target.value })}
          />
        </label>{" "}
        <label>
          <input
            type="checkbox"
            checked={value.cycloramaFloorProtection}
            onChange={(e) => set({ cycloramaFloorProtection: e.target.checked })}
          />
          ホリゾントの養生あり（床面を全面養生する）
        </label>
      </p>
      <p>
        <label>
          <input
            type="checkbox"
            checked={value.equipmentInsurance}
            onChange={(e) => set({ equipmentInsurance: e.target.checked })}
          />
          機材保険
        </label>
      </p>
      <p>
        オプション：
        {priceTable.options.map((option) => (
          <label key={option.id}>
            {" "}
            <input
              type="checkbox"
              checked={value.optionIds.includes(option.id)}
              onChange={(e) => toggleOption(option.id, e.target.checked)}
            />
            {option.name}
          </label>
        ))}
      </p>
      <p role="note" aria-label="見積">
        {estimate.ok
          ? `見積（今の料金表）：${formatYen(estimate.quote.estimateIncludingTax)}（税込。税抜 ${formatYen(estimate.quote.subtotalExcludingTax)}）・${planLabel(estimate.planId)}`
          : estimate.message}
      </p>
      <p>
        <label>
          確定金額（税込・円）{" "}
          <input
            type="text"
            inputMode="numeric"
            value={value.confirmedPrice ?? defaultPrice}
            onChange={(e) => set({ confirmedPrice: e.target.value })}
          />
        </label>{" "}
        <small>{priceNote}</small>
      </p>
    </fieldset>
  );
}

const textFields = [
  ["name", "氏名（必須）"],
  ["companyName", "会社名"],
  ["email", "メールアドレス"],
  ["phone", "電話番号"],
  ["address", "住所"],
  ["photographerName", "カメラマン氏名"],
] as const satisfies readonly (readonly [keyof CustomerInput, string])[];

export function CustomerFields(props: {
  value: CustomerInput;
  onChange: (value: CustomerInput) => void;
}) {
  const { value, onChange } = props;
  const set = (patch: Partial<CustomerInput>) => onChange({ ...value, ...patch });
  const toggleType = (type: CustomerInput["shootingTypes"][number], checked: boolean) =>
    set({
      shootingTypes: checked
        ? [...value.shootingTypes.filter((t) => t !== type), type]
        : value.shootingTypes.filter((t) => t !== type),
    });

  return (
    <>
      <fieldset>
        <legend>お客様の情報</legend>
        <p>
          <small>氏名と、電話番号かメールアドレスのどちらか1つが必須です。ほかは任意です。</small>
        </p>
        {textFields.map(([key, label]) => (
          <p key={key}>
            <label>
              {label} <input value={value[key]} onChange={(e) => set({ [key]: e.target.value })} />
            </label>
          </p>
        ))}
      </fieldset>
      <fieldset>
        <legend>撮影の内容</legend>
        <p>
          撮影内容：
          {(["still", "movie", "music"] as const).map((type) => (
            <label key={type}>
              {" "}
              <input
                type="checkbox"
                checked={value.shootingTypes.includes(type)}
                onChange={(e) => toggleType(type, e.target.checked)}
              />
              {shootingTypeLabel[type]}
            </label>
          ))}
        </p>
        <p>
          <label>
            撮影詳細
            <br />
            <textarea
              rows={3}
              cols={60}
              value={value.shootingDetails}
              onChange={(e) => set({ shootingDetails: e.target.value })}
            />
          </label>
        </p>
        <p>
          <label>
            補足事項
            <br />
            <textarea
              rows={3}
              cols={60}
              value={value.shootingNotes}
              onChange={(e) => set({ shootingNotes: e.target.value })}
            />
          </label>
        </p>
      </fieldset>
    </>
  );
}

/** フォームの入力の誤りの一覧 */
export function InputErrors({ messages }: { messages: readonly string[] | undefined }) {
  if (messages === undefined || messages.length === 0) return null;
  return (
    <div role="alert">
      {messages.map((message) => (
        <p key={message}>{message}</p>
      ))}
    </div>
  );
}
