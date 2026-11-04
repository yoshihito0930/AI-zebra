import { describe, expect, it } from "vitest";
import {
  AdminBlockCreated,
  AdminBlockRequest,
  AdminChangeRequest,
  AdminDirectEntryAccepted,
  AdminDirectEntryRequest,
  AdminError,
  AdminOperationAccepted,
  AdminRejected,
  AdminWarning,
} from "./admin.ts";

// 管理 API の2回目a（予約の変更・直接入力・ブロック枠と、警告の確認）の契約。
// 根拠：docs/design-docs/admin-api.md「警告の確認（2回目）」「変更・直接入力・ブロック枠（2回目a）」「返すときの決まり」、
// docs/product-specs/booking.md「直接入れる予約のルール」（お客様の情報は氏名と、電話番号かメールアドレスのどちらか1つが必須。
// ほかは任意。入れた欄の形と長さの上限は申込フォームと同じ）、「申込フォーム」（メールアドレス・電話番号の形、
// 15人以上は管理者が直接入れる）、「ブロック枠のバッファ」（なし／30分／1時間）。
// 既存の admin.test.ts（1回目の契約）は変えず、このファイルに分けた。テストデータの氏名・連絡先は架空のもの。

/** オブジェクトから、指定のキーを除いたもの（任意の項目を持たない値を作るのに使う） */
function without(value: object, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)));
}

// ---- 警告と、確認した警告の一覧 ----

describe("管理 API の契約：警告（AdminWarning）", () => {
  it.each([
    "past-24-hours-before-start",
    "past-provisional-deadline",
    "late-night-shorter-than-4-hours",
  ])("警告 %s：通す（名前は公開APIの ApplicationRejection と同じ）", (warning) => {
    expect(AdminWarning.safeParse(warning).success).toBe(true);
  });

  it.each([
    ["不可の決まり（2時間未満は警告でない）", "shorter-than-2-hours"],
    ["不可の決まり（30分単位は警告でない）", "not-on-30-minute-boundary"],
    ["不可の決まり（24時間超は警告でない）", "longer-than-24-hours"],
    ["空き判定は警告でない", "overlaps-existing"],
    ["名前が不正", "deadline"],
  ])("%s（%s）：通さない", (_, warning) => {
    expect(AdminWarning.safeParse(warning).success).toBe(false);
  });
});

// ---- 予約の変更の本文 ----

const changeRequest = {
  start: "2026-10-20T10:00:00+09:00",
  end: "2026-10-20T13:00:00+09:00",
  partySize: 4,
  cycloramaFloorProtection: false,
  equipmentInsurance: false,
  optionIds: [],
  confirmedPrice: 16_500,
};

describe("管理 API の契約：予約の変更の本文（AdminChangeRequest）", () => {
  it.each([
    ["確認した警告なし（省略は空と同じ）", changeRequest],
    ["確認した警告が空", { ...changeRequest, acknowledgedWarnings: [] }],
    [
      "確認した警告が1つ",
      { ...changeRequest, acknowledgedWarnings: ["late-night-shorter-than-4-hours"] },
    ],
    [
      "確認した警告が3つとも（今は出ていない警告が入っていてもよい）",
      {
        ...changeRequest,
        acknowledgedWarnings: [
          "past-24-hours-before-start",
          "past-provisional-deadline",
          "late-night-shorter-than-4-hours",
        ],
      },
    ],
    [
      "日時が UTC で表されている",
      { ...changeRequest, start: "2026-10-20T01:00:00Z", end: "2026-10-20T04:00:00Z" },
    ],
    [
      "人数 15人・機材保険・オプション2つ（管理者の変更は人数の上限がフォームと違う）",
      {
        ...changeRequest,
        partySize: 15,
        equipmentInsurance: true,
        optionIds: ["workshop", "glitter"],
      },
    ],
    ["確定金額 0円", { ...changeRequest, confirmedPrice: 0 }],
  ])("%s：通す", (_, value) => {
    expect(AdminChangeRequest.safeParse(value).success).toBe(true);
  });

  it.each([
    [
      "同じ警告が2回ある",
      {
        ...changeRequest,
        acknowledgedWarnings: ["past-24-hours-before-start", "past-24-hours-before-start"],
      },
    ],
    [
      "確認した警告の名前が不正",
      { ...changeRequest, acknowledgedWarnings: ["shorter-than-2-hours"] },
    ],
    ["開始がない（日時を変えないときも、今の日時を送る）", without(changeRequest, "start")],
    ["終わりがない", without(changeRequest, "end")],
    ["人数がない（変える欄だけを送る形にはしない）", without(changeRequest, "partySize")],
    ["ホリゾントの養生がない", without(changeRequest, "cycloramaFloorProtection")],
    ["機材保険がない", without(changeRequest, "equipmentInsurance")],
    ["オプションがない", without(changeRequest, "optionIds")],
    ["確定金額がない", without(changeRequest, "confirmedPrice")],
    ["確定金額が小数（INV-9）", { ...changeRequest, confirmedPrice: 16_500.5 }],
    ["確定金額が負", { ...changeRequest, confirmedPrice: -1 }],
    ["人数 0", { ...changeRequest, partySize: 0 }],
    ["人数が小数", { ...changeRequest, partySize: 4.5 }],
    ["日時にオフセットがない", { ...changeRequest, start: "2026-10-20T10:00:00" }],
    ["同じオプションが2回ある", { ...changeRequest, optionIds: ["workshop", "workshop"] }],
    ["余計なキー（状態。変更では状態を変えない）", { ...changeRequest, status: "provisional" }],
    [
      "余計なキー（誰が。管理者の id は本文から受け取らない）",
      { ...changeRequest, userId: "admin-user-kaku" },
    ],
    [
      "余計なキー（バッファ。バッファの切り替えは別の操作）",
      { ...changeRequest, bufferMinutes: 30 },
    ],
    ["null", null],
  ])("%s：通さない", (_, value) => {
    expect(AdminChangeRequest.safeParse(value).success).toBe(false);
  });
});

// ---- 直接入力の本文 ----

const directEntry = {
  kind: "firm",
  start: "2026-10-20T15:00:00+09:00",
  end: "2026-10-20T17:00:00+09:00",
  partySize: 3,
  cycloramaFloorProtection: false,
  equipmentInsurance: false,
  optionIds: [],
  confirmedPrice: 11_000,
  customer: { name: "架空 電話太郎", phone: "090-0000-1357" },
  shooting: {},
};

const fullCustomer = {
  name: "架空 全部花子",
  companyName: "架空全部株式会社",
  email: "zenbu.kaku@example.com",
  phone: "03-0000-2468",
  address: "架空県架空市全部町1-2-3",
  photographerName: "仮名 全部撮影",
};

describe("管理 API の契約：直接入力の本文（AdminDirectEntryRequest）", () => {
  it.each([
    ["本予約。お客様の情報は氏名と電話番号だけ、撮影の内容はなし", directEntry],
    ["仮予約", { ...directEntry, kind: "provisional" }],
    ["第二キープ", { ...directEntry, kind: "second-hold" }],
    [
      "お客様の情報は氏名とメールアドレスだけ",
      { ...directEntry, customer: { name: "架空 メール次郎", email: "jiro.kaku@example.com" } },
    ],
    [
      "お客様の情報と撮影の内容を全部入れる",
      {
        ...directEntry,
        customer: fullCustomer,
        shooting: {
          types: ["still", "music"],
          details: "架空の撮影詳細",
          notes: "架空の補足事項",
        },
      },
    ],
    ["撮影詳細だけ", { ...directEntry, shooting: { details: "架空の撮影詳細" } }],
    [
      "人数 15人（15人以上は管理者が直接入れる。フォームの上限 14人は効かない）",
      { ...directEntry, partySize: 15 },
    ],
    ["人数 100人（形の上限）", { ...directEntry, partySize: 100 }],
    ["確認した警告が1つ", { ...directEntry, acknowledgedWarnings: ["past-24-hours-before-start"] }],
    [
      "電話番号が11桁でハイフンなし",
      { ...directEntry, customer: { name: "架空 電話太郎", phone: "09000001357" } },
    ],
    [
      "電話番号が10桁（固定電話）",
      { ...directEntry, customer: { name: "架空 電話太郎", phone: "03-0000-1357" } },
    ],
    [
      "氏名がちょうど100文字（申込フォームの上限）",
      { ...directEntry, customer: { name: "架".repeat(100), phone: "090-0000-1357" } },
    ],
    [
      "住所がちょうど200文字（申込フォームの上限）",
      {
        ...directEntry,
        customer: { name: "架空 電話太郎", phone: "090-0000-1357", address: "架".repeat(200) },
      },
    ],
    [
      "撮影詳細がちょうど2000文字（申込フォームの上限）",
      { ...directEntry, shooting: { details: "架".repeat(2000) } },
    ],
  ])("%s：通す", (_, value) => {
    expect(AdminDirectEntryRequest.safeParse(value).success).toBe(true);
  });

  it.each([
    ["氏名がない", { phone: "090-0000-1357" }],
    ["氏名が空白だけ", { name: "   ", phone: "090-0000-1357" }],
    [
      "氏名が101文字（申込フォームの上限を超える）",
      { name: "架".repeat(101), phone: "090-0000-1357" },
    ],
    [
      "電話番号もメールアドレスもない（連絡先は1つ必須）",
      { name: "架空 電話太郎", address: "架空県架空市架空町9-9-9" },
    ],
    ["メールアドレスの形が不正", { name: "架空 電話太郎", email: "jiro.kaku@example" }],
    ["電話番号が +81 で始まる", { name: "架空 電話太郎", phone: "+81-90-0000-1357" }],
    ["電話番号の先頭が0でない", { name: "架空 電話太郎", phone: "90-0000-13579" }],
    ["電話番号が9桁", { name: "架空 電話太郎", phone: "03-000-1357" }],
    ["電話番号が12桁", { name: "架空 電話太郎", phone: "090-0000-13579" }],
    [
      "電話番号の形は正しいが、メールアドレスの形が不正（入れた欄は形を確かめる）",
      { name: "架空 電話太郎", phone: "090-0000-1357", email: "not-an-email" },
    ],
    [
      "会社名が101文字",
      { name: "架空 電話太郎", phone: "090-0000-1357", companyName: "架".repeat(101) },
    ],
    ["住所が201文字", { name: "架空 電話太郎", phone: "090-0000-1357", address: "架".repeat(201) }],
    [
      "カメラマン氏名が101文字",
      { name: "架空 電話太郎", phone: "090-0000-1357", photographerName: "架".repeat(101) },
    ],
    ["余計なキー（会員の id）", { name: "架空 電話太郎", phone: "090-0000-1357", memberId: "m-1" }],
  ])("お客様の情報で %s と通さない", (_, customer) => {
    expect(AdminDirectEntryRequest.safeParse({ ...directEntry, customer }).success).toBe(false);
  });

  it.each([
    ["撮影内容が選択肢にない", { types: ["drone"] }],
    ["撮影内容が空の配列", { types: [] }],
    ["同じ撮影内容が2回ある", { types: ["still", "still"] }],
    ["撮影詳細が2001文字", { details: "架".repeat(2001) }],
    ["補足事項が2001文字", { notes: "架".repeat(2001) }],
  ])("撮影の内容で %s と通さない", (_, shooting) => {
    expect(AdminDirectEntryRequest.safeParse({ ...directEntry, shooting }).success).toBe(false);
  });

  it.each([
    ["種類が承認待ち（直接入力は承認待ちを経ない）", { ...directEntry, kind: "pending-firm" }],
    ["種類がない", without(directEntry, "kind")],
    ["お客様の情報がない", without(directEntry, "customer")],
    ["撮影の内容がない", without(directEntry, "shooting")],
    ["人数がない（人数はプランを決めるのに使うので必須）", without(directEntry, "partySize")],
    [
      "ホリゾントの養生がない（プランを決めるのに使うので必須）",
      without(directEntry, "cycloramaFloorProtection"),
    ],
    ["確定金額がない", without(directEntry, "confirmedPrice")],
    ["確定金額が小数（INV-9）", { ...directEntry, confirmedPrice: 11_000.5 }],
    ["人数 0", { ...directEntry, partySize: 0 }],
    [
      "同じ警告が2回ある",
      {
        ...directEntry,
        acknowledgedWarnings: ["past-provisional-deadline", "past-provisional-deadline"],
      },
    ],
    ["確認した警告の名前が不正", { ...directEntry, acknowledgedWarnings: ["overlaps-existing"] }],
    ["余計なキー（経路。直接入力の経路は API が決める）", { ...directEntry, route: "admin" }],
    [
      "余計なキー（見積。見積は API が今の料金表で計算する）",
      { ...directEntry, estimateIncludingTax: 11_000 },
    ],
    ["余計なキー（バッファ。初期値の60分になる）", { ...directEntry, bufferMinutes: 30 }],
    ["余計なキー（申込フォームの同意）", { ...directEntry, agreedToTerms: true }],
    ["日時にオフセットがない", { ...directEntry, start: "2026-10-20T15:00:00" }],
  ])("%s：通さない", (_, value) => {
    expect(AdminDirectEntryRequest.safeParse(value).success).toBe(false);
  });
});

describe("管理 API の契約：直接入力が成功したときの返事（AdminDirectEntryAccepted）", () => {
  it("予約の id だけ：通す", () => {
    expect(AdminDirectEntryAccepted.safeParse({ reservationId: "res-kaku-1" }).success).toBe(true);
  });

  it.each([
    ["予約の id が空", { reservationId: "" }],
    ["何もない", {}],
    [
      "余計なキー（受付番号。受付番号はフォームの申込だけ）",
      { reservationId: "res-kaku-1", receiptNumber: "ABCD2345" },
    ],
  ])("%s：通さない", (_, value) => {
    expect(AdminDirectEntryAccepted.safeParse(value).success).toBe(false);
  });
});

// ---- ブロック枠 ----

const blockRequest = {
  start: "2026-10-20T15:00:00+09:00",
  end: "2026-10-20T16:00:00+09:00",
  bufferMinutes: 0,
};

describe("管理 API の契約：ブロック枠を入れる・直す本文（AdminBlockRequest）", () => {
  it.each([
    ["バッファなし、メモなし", blockRequest],
    ["バッファ30分", { ...blockRequest, bufferMinutes: 30 }],
    ["バッファ1時間", { ...blockRequest, bufferMinutes: 60 }],
    ["理由のメモあり", { ...blockRequest, memo: "架空のメモ：清掃" }],
    ["理由のメモがちょうど500文字", { ...blockRequest, memo: "架".repeat(500) }],
    [
      "日時が UTC で表されている",
      { ...blockRequest, start: "2026-10-20T06:00:00Z", end: "2026-10-20T07:00:00Z" },
    ],
  ])("%s：通す", (_, value) => {
    expect(AdminBlockRequest.safeParse(value).success).toBe(true);
  });

  it.each([
    ["バッファ45分（なし／30分／1時間から選ぶ）", { ...blockRequest, bufferMinutes: 45 }],
    ["バッファ90分", { ...blockRequest, bufferMinutes: 90 }],
    ["バッファが文字列", { ...blockRequest, bufferMinutes: "30" }],
    ["バッファがない（直すときも全部を送る）", without(blockRequest, "bufferMinutes")],
    ["開始がない", without(blockRequest, "start")],
    ["終わりがない", without(blockRequest, "end")],
    ["理由のメモが501文字", { ...blockRequest, memo: "架".repeat(501) }],
    ["理由のメモが空白だけ", { ...blockRequest, memo: "   " }],
    ["日時にオフセットがない", { ...blockRequest, end: "2026-10-20T16:00:00" }],
    [
      "余計なキー（経路。Googleカレンダーのブロック枠は管理者が入れない）",
      { ...blockRequest, route: "google-calendar" },
    ],
    ["余計なキー（id）", { ...blockRequest, id: "blk-kaku-1" }],
    ["null", null],
  ])("%s：通さない", (_, value) => {
    expect(AdminBlockRequest.safeParse(value).success).toBe(false);
  });
});

describe("管理 API の契約：ブロック枠を入れたときの返事（AdminBlockCreated）", () => {
  it("ブロック枠の id だけ：通す", () => {
    expect(AdminBlockCreated.safeParse({ blockId: "blk-kaku-1" }).success).toBe(true);
  });

  it.each([
    ["ブロック枠の id が空", { blockId: "" }],
    ["何もない", {}],
    ["余計なキー", { blockId: "blk-kaku-1", memo: "架空のメモ" }],
  ])("%s：通さない", (_, value) => {
    expect(AdminBlockCreated.safeParse(value).success).toBe(false);
  });
});

// ---- 変更の返事・エラー ----

describe("管理 API の契約：変更が成功したときの返事（AdminOperationAccepted）", () => {
  it("変更の下書きと、第二キープへの繰り上げ案内：通す", () => {
    const value = {
      drafts: [
        { kind: "change", reservationId: "res-kaku-1" },
        { kind: "move-up-notice", reservationId: "res-kaku-2", remainingProvisionalIds: [] },
      ],
    };
    expect(AdminOperationAccepted.safeParse(value).success).toBe(true);
  });

  it("変更の下書きにあて先の予約の id がない：通さない", () => {
    expect(AdminOperationAccepted.safeParse({ drafts: [{ kind: "change" }] }).success).toBe(false);
  });
});

describe("管理 API の契約：2回目aのエラー（AdminRejected）", () => {
  it.each([
    "not-changeable",
    "google-calendar-block",
    "not-on-30-minute-boundary",
    "shorter-than-2-hours",
    "longer-than-24-hours",
    "overlaps-existing",
    "no-provisional-to-hold",
    "more-than-90-days",
  ])("理由 %s（警告の一覧なし）：通す", (error) => {
    expect(AdminRejected.safeParse({ error }).success).toBe(true);
    expect(AdminError.safeParse(error).success).toBe(true);
  });

  it.each([
    [["past-24-hours-before-start"]],
    [["late-night-shorter-than-4-hours", "past-provisional-deadline"]],
  ])(
    "確認していない警告がある（unacknowledged-warnings）と、今の警告の一覧 %j：通す",
    (warnings) => {
      expect(AdminRejected.safeParse({ error: "unacknowledged-warnings", warnings }).success).toBe(
        true,
      );
    },
  );

  it.each([
    ["unacknowledged-warnings に警告の一覧がない", { error: "unacknowledged-warnings" }],
    [
      "unacknowledged-warnings の警告の一覧が空（1件以上）",
      { error: "unacknowledged-warnings", warnings: [] },
    ],
    [
      "unacknowledged-warnings の警告の名前が不正",
      { error: "unacknowledged-warnings", warnings: ["shorter-than-2-hours"] },
    ],
    [
      "ほかの理由に警告の一覧を付ける（warnings は unacknowledged-warnings のときだけ）",
      { error: "shorter-than-2-hours", warnings: ["late-night-shorter-than-4-hours"] },
    ],
    [
      "決まりで不可（空き判定）に警告の一覧を付ける",
      { error: "overlaps-existing", warnings: ["past-24-hours-before-start"] },
    ],
    [
      "警告の名前をエラーの理由にする（警告は unacknowledged-warnings で返す）",
      { error: "past-24-hours-before-start" },
    ],
    [
      "余計なキー（エラーの説明に本文を入れない。INV-10）",
      { error: "google-calendar-block", message: "架空のメモ" },
    ],
  ])("%s：通さない", (_, value) => {
    expect(AdminRejected.safeParse(value).success).toBe(false);
  });
});
