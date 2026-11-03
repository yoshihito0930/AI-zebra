import { describe, expect, it } from "vitest";
import {
  AdminApproveRequest,
  AdminEmptyRequest,
  AdminError,
  AdminOperationAccepted,
  AdminReceiptLookup,
  AdminRejected,
  AdminReservationDetail,
  AdminReservationList,
  AdminReservationListQuery,
  HoldingReservationStatus,
} from "./admin.ts";

// 管理 API の契約（docs/design-docs/admin-api.md の1回目）。
// 根拠：admin-api.md「予約の一覧」「予約の詳細」「受付番号から探す」「操作（1回目）」「返すときの決まり」、
// booking.md「管理者による予約の直接入力とブロック枠」（お客様の情報は氏名と、メールアドレスか電話番号のどちらか1つ）、
// reservation-model.md（予約が持つもの、状態と操作の下書き）。テストデータの氏名・連絡先は架空のもの。

describe("管理 API の契約：一覧のクエリ（AdminReservationListQuery）", () => {
  it.each([
    ["期間だけ（from と to）", { from: "2026-10-01", to: "2026-10-31" }],
    ["同じ日の期間（from と to が同じ）", { from: "2026-10-20", to: "2026-10-20" }],
    ["状態だけ（承認待ち（本））", { status: "pending-firm" }],
    ["期間と状態", { from: "2026-10-01", to: "2026-10-31", status: "provisional" }],
  ])("%s：通す", (_, value) => {
    expect(AdminReservationListQuery.safeParse(value).success).toBe(true);
  });

  it.each([
    "pending-provisional",
    "pending-firm",
    "pending-second-hold",
    "provisional",
    "firm",
    "second-hold",
  ])("枠を確保している状態 %s は、状態に渡せる", (status) => {
    expect(AdminReservationListQuery.safeParse({ status }).success).toBe(true);
    expect(HoldingReservationStatus.safeParse(status).success).toBe(true);
  });

  it.each(["cancelled", "ended"])(
    "取消・終了（%s）は一覧に出ないので、状態に渡せない",
    (status) => {
      expect(AdminReservationListQuery.safeParse({ status }).success).toBe(false);
      expect(
        AdminReservationListQuery.safeParse({ from: "2026-10-01", to: "2026-10-31", status })
          .success,
      ).toBe(false);
      expect(HoldingReservationStatus.safeParse(status).success).toBe(false);
    },
  );

  it.each([
    ["何も渡さない（期間か状態のどちらかは要る）", {}],
    ["from だけ（from と to はそろえる）", { from: "2026-10-01" }],
    ["to だけ（from と to はそろえる）", { to: "2026-10-31" }],
    ["from と状態だけ（to がない）", { from: "2026-10-01", status: "firm" }],
    ["to と状態だけ（from がない）", { to: "2026-10-31", status: "firm" }],
    ["状態が状態の値でない", { status: "仮予約" }],
    ["from の形が不正（2026/10/01）", { from: "2026/10/01", to: "2026-10-31" }],
    ["to の形が不正（日時）", { from: "2026-10-01", to: "2026-10-31T00:00:00+09:00" }],
    ["from が空", { from: "", to: "2026-10-31" }],
    ["余計なキー", { from: "2026-10-01", to: "2026-10-31", limit: "10" }],
    ["余計なキー（お客様の氏名で絞る）", { status: "firm", name: "架空 太郎" }],
  ])("%s：通さない", (_, value) => {
    expect(AdminReservationListQuery.safeParse(value).success).toBe(false);
  });
});

// ---- 一覧 ----

const summary = {
  id: "res-kaku-1",
  receiptNumber: "ABCD2345",
  status: "pending-firm",
  start: "2026-10-20T10:00:00+09:00",
  end: "2026-10-20T12:00:00+09:00",
  bufferMinutes: 60,
  route: "form",
  partySize: 4,
  estimateIncludingTax: 11_000,
  customerName: "架空 太郎",
};

const blockSummary = {
  id: "blk-kaku-1",
  start: "2026-10-21T15:00:00+09:00",
  end: "2026-10-21T16:00:00+09:00",
  bufferMinutes: 30,
  route: "admin",
  memo: "架空のメモ：清掃",
};

/** オブジェクトから、指定のキーを除いたもの（任意の項目を持たない値を作るのに使う） */
function without(value: object, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)));
}

const list = (reservations: unknown[], blocks: unknown[] = []) => ({ reservations, blocks });

describe("管理 API の契約：一覧（AdminReservationList）", () => {
  it.each([
    ["承認待ち（本）のフォームの申込", summary],
    [
      "直接入力の本予約（受付番号なし、確定金額あり）",
      {
        ...summary,
        id: "res-kaku-2",
        receiptNumber: undefined,
        status: "firm",
        route: "admin",
        confirmedPrice: 10_000,
      },
    ],
    [
      "第二キープ（付く仮予約の id あり）",
      {
        ...summary,
        id: "res-kaku-3",
        status: "second-hold",
        confirmedPrice: 11_000,
        provisionalIds: ["res-kaku-4", "res-kaku-5"],
      },
    ],
    ["日時が UTC で表されている", { ...summary, start: "2026-10-20T01:00:00Z" }],
    ["バッファ30分", { ...summary, bufferMinutes: 30 }],
  ])("%s：通す", (_, value) => {
    const reservation = value.receiptNumber === undefined ? without(value, "receiptNumber") : value;
    expect(AdminReservationList.safeParse(list([reservation], [blockSummary])).success).toBe(true);
  });

  it.each([
    ["バッファなし", { ...blockSummary, bufferMinutes: 0 }],
    ["1時間", { ...blockSummary, bufferMinutes: 60 }],
    [
      "Googleカレンダーから取り込んだもの（メモなし）",
      { ...blockSummary, id: "gcal-kaku-ev-1", route: "google-calendar", memo: undefined },
    ],
  ])("ブロック枠（%s）：通す", (_, value) => {
    const block = value.memo === undefined ? without(value, "memo") : value;
    expect(AdminReservationList.safeParse(list([], [block])).success).toBe(true);
  });

  it.each([
    ["取消の予約（取消・終了は一覧に出ない）", { ...summary, status: "cancelled" }],
    ["終了の予約", { ...summary, status: "ended" }],
    [
      "お客様のメールアドレス（一覧に出す個人情報は氏名だけ）",
      { ...summary, email: "taro.kaku@example.com" },
    ],
    ["お客様の電話番号", { ...summary, phone: "090-0000-9999" }],
    ["お客様の住所", { ...summary, address: "架空県架空市架空町9-9-9" }],
    ["氏名がない", { ...summary, customerName: undefined }],
    ["氏名が空", { ...summary, customerName: "" }],
    ["日時にオフセットがない", { ...summary, start: "2026-10-20T10:00:00" }],
    ["バッファ0分の予約", { ...summary, bufferMinutes: 0 }],
    ["経路が不正", { ...summary, route: "google-calendar" }],
    ["受付番号の形が不正", { ...summary, receiptNumber: "abcd2345" }],
    ["見積額が小数", { ...summary, estimateIncludingTax: 11_000.5 }],
    ["人数 0", { ...summary, partySize: 0 }],
  ])("予約に %s があると通さない", (_, value) => {
    expect(AdminReservationList.safeParse(list([value])).success).toBe(false);
  });

  it.each([
    ["バッファ45分", { ...blockSummary, bufferMinutes: 45 }],
    ["経路がフォーム", { ...blockSummary, route: "form" }],
    ["余計なキー（状態）", { ...blockSummary, status: "firm" }],
  ])("ブロック枠に %s があると通さない", (_, value) => {
    expect(AdminReservationList.safeParse(list([], [value])).success).toBe(false);
  });

  it("予約かブロック枠の一覧がないと通さない", () => {
    expect(AdminReservationList.safeParse({ reservations: [] }).success).toBe(false);
    expect(AdminReservationList.safeParse({ blocks: [] }).success).toBe(false);
  });
});

// ---- 詳細 ----

const historyEntry = {
  at: "2026-10-01T12:00:00+09:00",
  actor: { kind: "customer" },
  operation: "apply",
  after: {
    status: "pending-firm",
    start: "2026-10-20T10:00:00+09:00",
    end: "2026-10-20T12:00:00+09:00",
    bufferMinutes: 60,
  },
};

const detail = {
  id: "res-kaku-1",
  receiptNumber: "ABCD2345",
  status: "pending-firm",
  start: "2026-10-20T10:00:00+09:00",
  end: "2026-10-20T12:00:00+09:00",
  bufferMinutes: 60,
  route: "form",
  partySize: 4,
  cycloramaFloorProtection: false,
  planId: "A",
  equipmentInsurance: false,
  optionIds: [],
  estimate: { subtotalExcludingTax: 10_000, estimateIncludingTax: 11_000 },
  createdAt: "2026-10-01T12:00:00+09:00",
  updatedAt: "2026-10-01T12:00:00+09:00",
  customer: {
    name: "架空 太郎",
    companyName: "架空商会",
    email: "taro.kaku@example.com",
    phone: "090-0000-9999",
    address: "架空県架空市架空町9-9-9",
    photographerName: "仮名 撮影係",
  },
  shooting: { types: ["still"], details: "架空の撮影詳細", notes: "架空の補足事項" },
  history: [historyEntry],
  currentEstimate: { subtotalExcludingTax: 10_000, estimateIncludingTax: 11_000 },
};

describe("管理 API の契約：詳細（AdminReservationDetail）", () => {
  it("フォームの申込の承認待ち（今の料金表での見積つき）：通す", () => {
    expect(AdminReservationDetail.safeParse(detail).success).toBe(true);
  });

  it("本予約（確定金額、承認の履歴、今取消したときのキャンセル料つき）：通す", () => {
    const value = {
      ...without(detail, "currentEstimate"),
      status: "firm",
      confirmedPrice: 11_000,
      history: [
        historyEntry,
        {
          at: "2026-10-02T12:00:00+09:00",
          actor: { kind: "admin", userId: "admin-user-kaku" },
          operation: "approve",
          before: historyEntry.after,
          after: { ...historyEntry.after, status: "firm", confirmedPrice: 11_000 },
        },
      ],
      cancellationFeeIfCancelledNow: { ratePercent: 50, fee: 5_500 },
    };
    expect(AdminReservationDetail.safeParse(value).success).toBe(true);
  });

  it("終了した第二キープ（履歴の最後は、誰がシステムの終了）：通す", () => {
    const value = {
      ...without(detail, "currentEstimate"),
      status: "ended",
      confirmedPrice: 11_000,
      provisionalIds: ["res-kaku-9"],
      history: [
        historyEntry,
        {
          at: "2026-10-05T09:00:00+09:00",
          actor: { kind: "system" },
          operation: "end",
          before: { ...historyEntry.after, status: "second-hold" },
          after: { ...historyEntry.after, status: "ended" },
        },
      ],
    };
    expect(AdminReservationDetail.safeParse(value).success).toBe(true);
  });

  it("取消した予約（状態は取消）：通す", () => {
    const value = { ...without(detail, "currentEstimate"), status: "cancelled" };
    expect(AdminReservationDetail.safeParse(value).success).toBe(true);
  });

  it.each([
    ["メールアドレスだけ", { name: "架空 太郎", email: "taro.kaku@example.com" }],
    ["電話番号だけ", { name: "架空 太郎", phone: "090-0000-9999" }],
  ])("管理者の直接入力のお客様の情報が、氏名と%s：通す（ほかの項目は任意）", (_, customer) => {
    const rest = without(detail, "receiptNumber", "currentEstimate");
    const value = {
      ...rest,
      route: "admin",
      status: "firm",
      confirmedPrice: 11_000,
      customer,
      shooting: {},
    };
    expect(AdminReservationDetail.safeParse(value).success).toBe(true);
  });

  it.each([
    ["メールアドレスも電話番号もない", { name: "架空 太郎", address: "架空県架空市架空町9-9-9" }],
    ["氏名がない", { email: "taro.kaku@example.com" }],
    ["氏名が空", { name: "", email: "taro.kaku@example.com" }],
    ["余計なキー", { name: "架空 太郎", email: "taro.kaku@example.com", memberId: "m-1" }],
  ])("お客様の情報で %s と通さない", (_, customer) => {
    expect(AdminReservationDetail.safeParse({ ...detail, customer }).success).toBe(false);
  });

  it.each([
    ["日時にオフセットがない", { ...detail, createdAt: "2026-10-01T12:00:00" }],
    ["状態が不正", { ...detail, status: "approved" }],
    ["余計なキー", { ...detail, gsi1pk: "STATUS#pending-firm" }],
    ["撮影内容が選択肢にない", { ...detail, shooting: { types: ["drone"] } }],
    [
      "履歴の誰がが不正（管理者の id がない）",
      { ...detail, history: [{ ...historyEntry, actor: { kind: "admin" } }] },
    ],
    [
      "履歴の誰がが不正（システムに管理者の id を付ける）",
      { ...detail, history: [{ ...historyEntry, actor: { kind: "system", userId: "x" } }] },
    ],
    [
      "履歴の誰がの種類が不正",
      { ...detail, history: [{ ...historyEntry, actor: { kind: "robot" } }] },
    ],
    ["履歴の操作が不正", { ...detail, history: [{ ...historyEntry, operation: "delete" }] }],
    [
      "キャンセル料の率が100を超える",
      { ...detail, cancellationFeeIfCancelledNow: { ratePercent: 120, fee: 13_200 } },
    ],
    [
      "キャンセル料が小数",
      { ...detail, cancellationFeeIfCancelledNow: { ratePercent: 50, fee: 5_500.5 } },
    ],
  ])("%s：通さない", (_, value) => {
    expect(AdminReservationDetail.safeParse(value).success).toBe(false);
  });
});

// ---- 受付番号から探す・操作・エラー ----

describe("管理 API の契約：受付番号から探す（AdminReceiptLookup）", () => {
  it("予約の id だけ：通す", () => {
    expect(AdminReceiptLookup.safeParse({ reservationId: "res-kaku-1" }).success).toBe(true);
  });

  it.each([
    ["予約の id が空", { reservationId: "" }],
    ["余計なキー（状態）", { reservationId: "res-kaku-1", status: "firm" }],
    ["何もない", {}],
  ])("%s：通さない", (_, value) => {
    expect(AdminReceiptLookup.safeParse(value).success).toBe(false);
  });
});

describe("管理 API の契約：承認の本文（AdminApproveRequest）", () => {
  it.each([
    ["確定金額 11,000円", { confirmedPrice: 11_000 }],
    ["確定金額 0円", { confirmedPrice: 0 }],
  ])("%s：通す", (_, value) => {
    expect(AdminApproveRequest.safeParse(value).success).toBe(true);
  });

  it.each([
    ["確定金額がない", {}],
    ["確定金額が小数（INV-9）", { confirmedPrice: 11_000.5 }],
    ["確定金額が負", { confirmedPrice: -1 }],
    ["確定金額が文字列", { confirmedPrice: "11000" }],
    [
      "余計なキー（日時。承認は申込どおりに行う）",
      { confirmedPrice: 11_000, start: "2026-10-20T10:00:00+09:00" },
    ],
    [
      "余計なキー（誰が。管理者の id は本文から受け取らない）",
      { confirmedPrice: 11_000, userId: "admin-user-kaku" },
    ],
    ["null", null],
  ])("%s：通さない", (_, value) => {
    expect(AdminApproveRequest.safeParse(value).success).toBe(false);
  });
});

describe("管理 API の契約：却下・昇格・取消・繰り上げの本文（AdminEmptyRequest）", () => {
  it("空のオブジェクト：通す", () => {
    expect(AdminEmptyRequest.safeParse({}).success).toBe(true);
  });

  it.each([
    ["余計なキー（確定金額）", { confirmedPrice: 11_000 }],
    ["余計なキー（キャンセル料。キャンセル料は API が計算する）", { cancellationFee: 0 }],
    ["配列", []],
    ["null", null],
  ])("%s：通さない", (_, value) => {
    expect(AdminEmptyRequest.safeParse(value).success).toBe(false);
  });
});

describe("管理 API の契約：操作が成功したときの返事（AdminOperationAccepted）", () => {
  it("1回目の操作で作る下書きの種類：通す", () => {
    const value = {
      drafts: [
        { kind: "approval", reservationId: "res-kaku-1", confirmedPrice: 11_000 },
        { kind: "rejection", reservationId: "res-kaku-1" },
        { kind: "promotion", reservationId: "res-kaku-1" },
        { kind: "second-hold-ended", reservationId: "res-kaku-2" },
        {
          kind: "cancellation",
          reservationId: "res-kaku-1",
          cancellationFee: { ratePercent: 80, fee: 22_000 },
        },
        { kind: "move-up-notice", reservationId: "res-kaku-2", remainingProvisionalIds: [] },
        { kind: "bring-forward-notice", reservationId: "res-kaku-3" },
      ],
    };
    expect(AdminOperationAccepted.safeParse(value).success).toBe(true);
  });

  it("下書きなし（繰り上げ）：通す", () => {
    expect(AdminOperationAccepted.safeParse({ drafts: [] }).success).toBe(true);
  });

  it.each([
    ["承認の下書きに確定金額がない", { kind: "approval", reservationId: "res-kaku-1" }],
    ["取消の下書きにキャンセル料がない", { kind: "cancellation", reservationId: "res-kaku-1" }],
    ["下書きの種類が不正", { kind: "reminder", reservationId: "res-kaku-1" }],
    [
      "下書きにあて先のメールアドレス（個人情報は下書きに持たない）",
      { kind: "rejection", reservationId: "res-kaku-1", to: "taro.kaku@example.com" },
    ],
    ["下書きにあて先の予約の id がない", { kind: "rejection" }],
  ])("%s：通さない", (_, draft) => {
    expect(AdminOperationAccepted.safeParse({ drafts: [draft] }).success).toBe(false);
  });
});

describe("管理 API の契約：エラー（AdminRejected）", () => {
  it.each([
    "invalid-input",
    "unauthorized",
    "not-found",
    "not-pending",
    "invalid-status",
    "still-held",
    "busy",
  ])("理由 %s：通す", (error) => {
    expect(AdminRejected.safeParse({ error }).success).toBe(true);
    expect(AdminError.safeParse(error).success).toBe(true);
  });

  it.each([
    ["理由が不正", { error: "forbidden" }],
    [
      "余計なキー（エラーの説明に本文を入れない。INV-10）",
      { error: "invalid-input", message: "架空 太郎" },
    ],
    ["理由がない", {}],
  ])("%s：通さない", (_, value) => {
    expect(AdminRejected.safeParse(value).success).toBe(false);
  });
});
