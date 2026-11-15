import { Yen } from "@zebra/contracts";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  type DraftMail,
  type DraftMailContent,
  type DraftMailReservation,
  renderDraftMail,
} from "./draft-mail.ts";

// 下書きの文面を作る関数（renderDraftMail）の単体テスト。
// 根拠：docs/product-specs/mail.md「下書きのテンプレート」（差し込む値、日時の書き方、強調の書き方、共通の部分、
// 種類ごとのテンプレートと件名、例の表のすべての行）、docs/design-docs/admin-api.md「下書き（3回目）」（本文はテキストと
// HTML の2つ。HTML は強調を赤字・青字・下線の span にし、改行を <br> にする。差し込む値は HTML のエスケープをする）、
// 「担当者名と署名の設定」、core-beliefs.md（INV-7）。
// - テンプレートの本文を一字一句すべては写さない。例の行と、種類ごとの要所（mail.md に書いた文）を行の単位で確かめる
// - 例の表の「メールアドレスのない予約の下書き」の行は、あて先を決めるのが API なので、管理 API のテスト
//   （apps/api/src/admin/routes-round3.int.test.ts）で確かめる
// - 日時の行は、同じ時点を JST と UTC の2通りで渡して、どちらも同じ文面になることを確かめる（INV-7。TESTING.md）
// - HTML の本文は、「HTML から <br> を改行に、ほかのタグを除き、エスケープを戻すと、テキストの本文と同じになる」ことと、
//   強調した文を mail.md「強調の書き方」の形の span（`<span style="color:#ff0000">` 赤、`<span style="color:#0000ff">` 青、
//   `<span style="text-decoration:underline">` 下線）で囲むことで確かめる
// - キャンセル料の2行は、金額が1円以上のときだけ出す（mail.md「取消」）
// - 承認のテンプレート（本予約・仮予約・第二キープ）は、承認したときの状態で選ぶ（mail.md「承認（本予約）」）。
//   どの状態だったかは呼び出す側（API）が approvedAs で渡す
// - 例の表には撮影内容の並びの指定がないが、mail.md に「並びはこの順」とあるので、逆の順で渡しても同じ文面になることも確かめる
// - 担当者名・署名・お客様の情報は、架空の値を使う

// ---- 日時（INV-7）。テストの日時は JST で書く ----

function jst(iso: string): DateTime {
  const dateTime = DateTime.fromISO(iso, { zone: "Asia/Tokyo" });
  if (!dateTime.isValid) {
    throw new Error(`テストの日時が不正：${iso}`);
  }
  return dateTime;
}

/** 同じ時点を、JST と UTC の2通りで表す（INV-7） */
function bothZones(start: string, end: string): [zone: string, start: DateTime, end: DateTime][] {
  return [
    ["JST", jst(start), jst(end)],
    ["UTC", jst(start).toUTC(), jst(end).toUTC()],
  ];
}

// ---- 架空の設定とお客様 ----

const staffName = "仮名 担当一郎";
const signatureLines = [
  "スタジオゼブラ（架空の署名）",
  "〒000-0000 架空県架空市署名町0-0-0",
  "TEL 090-0000-0000",
  "Mail kaku.studio@example.com",
  "HP https://kaku-studio.example.com",
] as const;
const signature = signatureLines.join("\n");

const customerName = "架空 花子";

interface Settings {
  staffName?: string;
  signature?: string;
}

const fullSettings: Settings = { staffName, signature };

function reservation(overrides: Partial<DraftMailReservation> = {}): DraftMailReservation {
  return {
    start: jst("2026-10-20T15:00"),
    end: jst("2026-10-20T17:00"),
    partySize: 4,
    equipmentInsurance: false,
    customer: { name: customerName },
    shooting: { types: ["still"] },
    ...overrides,
  };
}

function render(
  draft: DraftMailContent,
  overrides: Partial<DraftMailReservation> = {},
  settings: Settings = fullSettings,
): DraftMail {
  return renderDraftMail({ draft, reservation: reservation(overrides), ...settings });
}

const firmApproval: DraftMailContent = { kind: "approval", approvedAs: "firm" };
const provisionalApproval: DraftMailContent = { kind: "approval", approvedAs: "provisional" };

function lines(mail: DraftMail): string[] {
  return mail.text.split("\n");
}

// ---- HTML を確かめる道具 ----

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    }
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    const named: Record<string, string> = {
      lt: "<",
      gt: ">",
      amp: "&",
      quot: '"',
      apos: "'",
      nbsp: " ",
    };
    return named[name] ?? whole;
  });
}

/** HTML の本文から、<br> を改行に、ほかのタグを除き、エスケープを戻す */
function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>\n?/gi, "\n").replace(/<[^>]*>/g, ""));
}

/**
 * その文だけを、決まった形の span で囲んでいること（mail.md「強調の書き方」：
 * `<span style="color:#ff0000">`・`<span style="color:#0000ff">`・`<span style="text-decoration:underline">`）
 */
function expectSpan(html: string, style: string, inner: string): void {
  expect(html, `「${inner}」を囲む span（${style}）`).toContain(
    `<span style="${style}">${inner}</span>`,
  );
}

function expectRed(html: string, inner: string): void {
  expectSpan(html, "color:#ff0000", inner);
}

function expectBlue(html: string, inner: string): void {
  expectSpan(html, "color:#0000ff", inner);
}

function expectUnderline(html: string, inner: string): void {
  expectSpan(html, "text-decoration:underline", inner);
}

/** どの文面にも言えること：テキストに強調の印やテンプレートの印が残らない。HTML はテキストと同じ中身 */
function expectWellFormed(mail: DraftMail): void {
  for (const marker of ["<赤>", "</赤>", "<青>", "</青>", "<下線>", "</下線>"]) {
    expect(mail.text).not.toContain(marker);
    expect(mail.html).not.toContain(marker);
  }
  for (const placeholder of [
    "{",
    "}",
    "（ご予約内容）",
    "（注意事項）",
    "（結び）",
    "（キャンセル料）",
    "（ほかの仮予約）",
  ]) {
    expect(mail.text).not.toContain(placeholder);
  }
  expect(mail.html).toMatch(/<br\s*\/?>/i);
  expect(htmlToText(mail.html).trimEnd()).toBe(mail.text.trimEnd());
}

/** 本文が結び（{担当者名}、空行、「--」、{署名}）で終わる */
function expectClosing(mail: DraftMail, staff: string, sign: string | undefined): void {
  const text = mail.text.trimEnd();
  if (sign === undefined) {
    expect(text.endsWith(`\n${staff}`), text).toBe(true);
    expect(lines(mail)).not.toContain("--");
  } else {
    expect(text.endsWith(`\n${staff}\n\n--\n${sign}`), text).toBe(true);
  }
}

// ---- 共通の部分の行（mail.md「共通の部分」） ----

const reservationDetailsHeading = "◇ ご予約内容 ◇";
const noticesHeading = "◆ 注意事項 ◆";
const redShoes = "撮影当日に履いていらっしゃった靴のご使用は禁止です。";
const redParking = "※スタジオが入っている建物周辺への駐輪は厳禁です。";
const blueFirst = "撮影者様・スタイリスト様など、ホリゾント内にお入りになる方は";
const blueSecond = "デニム等の色落ちするボトムの着用をお控えください。";
const underlineBoots = "ブーツなど、ソール部分が厚い靴";
const fullWidthSpace = "　";

/** キャンセル料の2行のうち、金額を書かない2行目（1行目は金額ごとに確かめる） */
const cancellationFeeLines = ["お支払い方法につきましては、追ってご連絡いたします。"] as const;
const otherProvisionalLines = [
  "ただし、ご希望の日時にはほかにも仮予約をいただいているお客様がいらっしゃるため、",
  "すぐには繰り上げができません。状況が変わりましたら、あらためてご連絡いたします。",
] as const;

// ---- テスト ----

describe("下書きのテンプレート", () => {
  it("本予約 2026/10/20 15:00–17:00 の承認：件名は「【スタジオゼブラ】本予約を承りました」。本文に「【2026年10月20日(火) 15時00分〜17時00分】にて、本予約を承りました。」と「ご予約日時：2026年10月20日(火) 15時00分〜17時00分（2時間）」。「同意書を Gmail で添付する」と表示する", () => {
    for (const [zone, start, end] of bothZones("2026-10-20T15:00", "2026-10-20T17:00")) {
      const mail = render(firmApproval, { start, end });
      expect(mail.subject, zone).toBe("【スタジオゼブラ】本予約を承りました");
      expect(lines(mail), zone).toContain(
        "【2026年10月20日(火) 15時00分〜17時00分】にて、本予約を承りました。",
      );
      expect(lines(mail), zone).toContain(
        "ご予約日時：2026年10月20日(火) 15時00分〜17時00分（2時間）",
      );
      expect(mail.attachConsentForm, zone).toBe(true);
      expectWellFormed(mail);
    }
  });

  it("本予約 2026/10/20 9:00–11:30：ご予約日時は「2026年10月20日(火) 9時00分〜11時30分（2時間30分）」", () => {
    for (const [zone, start, end] of bothZones("2026-10-20T09:00", "2026-10-20T11:30")) {
      expect(lines(render(firmApproval, { start, end })), zone).toContain(
        "ご予約日時：2026年10月20日(火) 9時00分〜11時30分（2時間30分）",
      );
    }
  });

  it("本予約 2026/10/20 22:00–10/21 02:00：ご予約日時は「2026年10月20日(火) 22時00分〜翌2時00分（4時間）」", () => {
    for (const [zone, start, end] of bothZones("2026-10-20T22:00", "2026-10-21T02:00")) {
      expect(lines(render(firmApproval, { start, end })), zone).toContain(
        "ご予約日時：2026年10月20日(火) 22時00分〜翌2時00分（4時間）",
      );
    }
  });

  it("本予約 2026/10/20 20:00–10/21 00:00：ご予約日時は「2026年10月20日(火) 20時00分〜翌0時00分（4時間）」", () => {
    for (const [zone, start, end] of bothZones("2026-10-20T20:00", "2026-10-21T00:00")) {
      expect(lines(render(firmApproval, { start, end })), zone).toContain(
        "ご予約日時：2026年10月20日(火) 20時00分〜翌0時00分（4時間）",
      );
    }
  });

  it("仮予約 2026/10/20 15:00–17:00 の承認：「【10月13日(火)の18時まで】にご連絡いただけますと幸いです。」", () => {
    for (const [zone, start, end] of bothZones("2026-10-20T15:00", "2026-10-20T17:00")) {
      const mail = render(provisionalApproval, { start, end });
      expect(lines(mail), zone).toContain(
        "【10月13日(火)の18時まで】にご連絡いただけますと幸いです。",
      );
      expectWellFormed(mail);
    }
  });

  it("撮影内容がスチール撮影とムービー撮影、撮影詳細が「アパレルの着用撮影」：「撮影内容：スチール撮影・ムービー撮影（アパレルの着用撮影）」", () => {
    // 並びは申込フォームと同じ順（mail.md「撮影内容の名前は、申込フォームと同じ…並びはこの順」）。逆の順で渡しても同じ
    for (const types of [
      ["still", "movie"],
      ["movie", "still"],
    ] as const) {
      const mail = render(firmApproval, {
        shooting: { types, details: "アパレルの着用撮影" },
      });
      expect(lines(mail), types.join(",")).toContain(
        "撮影内容：スチール撮影・ムービー撮影（アパレルの着用撮影）",
      );
    }
  });

  it("撮影内容も撮影詳細もない（管理者が直接入れた予約）：「撮影内容：-」", () => {
    expect(lines(render(firmApproval, { shooting: {} }))).toContain("撮影内容：-");
  });

  it("カメラマン氏名が「架空 太郎」、機材保険あり：「カメラマン様：架空 太郎様」「機材保険：ご付帯」", () => {
    const mail = render(firmApproval, {
      customer: { name: customerName, photographerName: "架空 太郎" },
      equipmentInsurance: true,
    });
    expect(lines(mail)).toContain("カメラマン様：架空 太郎様");
    expect(lines(mail)).toContain("機材保険：ご付帯");
  });

  it("カメラマン氏名なし、機材保険なし：「カメラマン様：-」「機材保険：-」", () => {
    const mail = render(firmApproval, {
      customer: { name: customerName },
      equipmentInsurance: false,
    });
    expect(lines(mail)).toContain("カメラマン様：-");
    expect(lines(mail)).toContain("機材保険：-");
  });

  it("本予約の取消、キャンセル料 5,500円（50%）：「キャンセル料として、5,500円（ご利用料金の50%）を申し受けます。」がある", () => {
    const mail = render({
      kind: "cancellation",
      cancellationFee: { ratePercent: 50, fee: Yen.parse(5_500) },
    });
    expect(lines(mail)).toContain("キャンセル料として、5,500円（ご利用料金の50%）を申し受けます。");
    for (const line of cancellationFeeLines) {
      expect(lines(mail)).toContain(line);
    }
    expectWellFormed(mail);
  });

  it("本予約の取消、キャンセル料 0円（0%）：キャンセル料の2行がない", () => {
    const mail = render({
      kind: "cancellation",
      cancellationFee: { ratePercent: 0, fee: Yen.parse(0) },
    });
    expect(mail.text).not.toContain("キャンセル料として");
    for (const line of cancellationFeeLines) {
      expect(mail.text).not.toContain(line);
    }
    expectWellFormed(mail);
  });

  // 仮予約の取消の下書きのキャンセル料は 0円（0%）（booking.md「取消とキャンセル料」：仮予約の取消は無料）
  it("仮予約の取消：キャンセル料の2行がない", () => {
    const mail = render(
      { kind: "cancellation", cancellationFee: { ratePercent: 0, fee: Yen.parse(0) } },
      { start: jst("2026-10-20T13:00"), end: jst("2026-10-20T15:00") },
    );
    expect(mail.text).not.toContain("キャンセル料として");
    for (const line of cancellationFeeLines) {
      expect(mail.text).not.toContain(line);
    }
  });

  it("繰り上げの案内、残っている仮予約が1件：「すぐには繰り上げができません」の2行がある", () => {
    const mail = render({
      kind: "move-up-notice",
      remainingProvisionalIds: ["kaku-provisional-2"],
    });
    for (const line of otherProvisionalLines) {
      expect(lines(mail)).toContain(line);
    }
    expectWellFormed(mail);
  });

  it("繰り上げの案内、残っている仮予約がない：「すぐには繰り上げができません」の2行がない", () => {
    const mail = render({ kind: "move-up-notice", remainingProvisionalIds: [] });
    expect(mail.text).not.toContain("すぐには繰り上げができません");
    for (const line of otherProvisionalLines) {
      expect(mail.text).not.toContain(line);
    }
    expectWellFormed(mail);
  });

  it("本文の `<赤>撮影当日に履いていらっしゃった靴のご使用は禁止です。</赤>`：コピーする本文では、その文が赤字になる。テキストの本文には印が出ない", () => {
    const mail = render(firmApproval);
    expect(lines(mail)).toContain(`・${redShoes}`);
    expectRed(mail.html, redShoes);
    expectWellFormed(mail);
  });

  it("`{署名}` の設定がない：本文は `{担当者名}` の行で終わる（「--」の行がない）", () => {
    const mail = render(firmApproval, {}, { staffName });
    expectClosing(mail, staffName, undefined);
    for (const line of signatureLines) {
      expect(mail.text).not.toContain(line);
    }
    expectWellFormed(mail);
  });

  it("UTC で保存した予約区間 2026-10-20T06:00Z–08:00Z：ご予約日時は「2026年10月20日(火) 15時00分〜17時00分」（JST で書く。INV-7）", () => {
    const start = DateTime.fromISO("2026-10-20T06:00:00Z", { setZone: true });
    const end = DateTime.fromISO("2026-10-20T08:00:00Z", { setZone: true });
    expect(start.offset).toBe(0);
    const mail = render(firmApproval, { start, end });
    expect(lines(mail)).toContain("ご予約日時：2026年10月20日(火) 15時00分〜17時00分（2時間）");
    expect(lines(mail)).toContain(
      "【2026年10月20日(火) 15時00分〜17時00分】にて、本予約を承りました。",
    );
  });
});

// ---- 種類ごとの件名と要所（mail.md の種類ごとのテンプレート） ----

const when = "【2026年10月20日(火) 15時00分〜17時00分】";

interface KindCase {
  label: string;
  draft: DraftMailContent;
  subject: string;
  attachConsentForm: boolean;
  /** 本文にある行 */
  present: readonly string[];
  /** 本文にない行 */
  absent: readonly string[];
  /** ご予約内容・注意事項を付けるか */
  details: boolean;
  notices: boolean;
}

const kindCases: readonly KindCase[] = [
  {
    label: "承認（本予約）",
    draft: firmApproval,
    subject: "【スタジオゼブラ】本予約を承りました",
    attachConsentForm: true,
    present: [
      "この度はスタジオ利用のお申し込みをありがとうございます。",
      `${when}にて、本予約を承りました。`,
      "あわせて同意書を添付しておりますので、事前にご確認ください。",
      "＊本予約受付後の時間変更・キャンセルには、キャンセル料が発生します。",
    ],
    absent: ["ご利用のご決定のご連絡をありがとうございます。"],
    details: true,
    notices: true,
  },
  {
    label: "承認（仮予約）",
    draft: provisionalApproval,
    subject: "【スタジオゼブラ】仮予約を承りました",
    attachConsentForm: false,
    present: [
      "この度は仮予約のお申し込みをありがとうございます。",
      `${when}にて、仮予約を承りました。`,
      "ご利用のご決定につきましては、",
      "【10月13日(火)の18時まで】にご連絡いただけますと幸いです。",
    ],
    absent: ["お時間の短縮の可能性につきましても承知いたしました。"],
    details: false,
    notices: false,
  },
  {
    label: "承認（第二キープ）",
    draft: { kind: "approval", approvedAs: "second-hold" },
    subject: "【スタジオゼブラ】第二キープを承りました",
    attachConsentForm: false,
    present: [
      `${when}にて、第二キープを承りました。`,
      "ご希望の日時には、先に仮予約をいただいているお客様がいらっしゃいます。",
      "仮予約へ繰り上げのご案内をいたします。",
    ],
    absent: [],
    details: false,
    notices: false,
  },
  {
    label: "却下",
    draft: { kind: "rejection" },
    subject: "【スタジオゼブラ】お申し込みについて",
    attachConsentForm: false,
    present: [
      `誠に申し訳ございませんが、${when}のお申し込みは`,
      "お受けすることができませんでした。",
    ],
    absent: [],
    details: false,
    notices: false,
  },
  {
    label: "昇格（仮予約から本予約へ）",
    draft: { kind: "promotion" },
    subject: "【スタジオゼブラ】本予約を承りました",
    attachConsentForm: true,
    present: [
      "ご利用のご決定のご連絡をありがとうございます。",
      `${when}にて、仮予約から本予約に切り替えました。`,
      "あわせて同意書を添付しておりますので、事前にご確認ください。",
    ],
    absent: [
      "この度はスタジオ利用のお申し込みをありがとうございます。",
      `${when}にて、本予約を承りました。`,
    ],
    details: true,
    notices: true,
  },
  {
    label: "取消",
    draft: {
      kind: "cancellation",
      cancellationFee: { ratePercent: 80, fee: Yen.parse(17_600) },
    },
    subject: "【スタジオゼブラ】ご予約のキャンセルを承りました",
    attachConsentForm: false,
    present: [
      `${when}のご予約のキャンセルを承りました。`,
      "キャンセル料として、17,600円（ご利用料金の80%）を申し受けます。",
      "お支払い方法につきましては、追ってご連絡いたします。",
    ],
    absent: [],
    details: false,
    notices: false,
  },
  {
    label: "変更",
    draft: { kind: "change" },
    subject: "【スタジオゼブラ】ご予約内容の変更を承りました",
    attachConsentForm: false,
    present: ["ご予約内容の変更を承りました。", "変更後のご予約内容は下記のとおりです。"],
    absent: [],
    details: true,
    notices: false,
  },
  {
    label: "第二キープの終了",
    draft: { kind: "second-hold-ended" },
    subject: "【スタジオゼブラ】第二キープについて",
    attachConsentForm: false,
    present: [
      `${when}の第二キープについてご連絡いたします。`,
      "先に仮予約をいただいていたお客様がご利用を決定されたため、",
      "誠に申し訳ございませんが、第二キープは終了となりました。",
    ],
    absent: [],
    details: false,
    notices: false,
  },
  {
    label: "繰り上げの案内",
    draft: { kind: "move-up-notice", remainingProvisionalIds: [] },
    subject: "【スタジオゼブラ】第二キープの繰り上げのご案内",
    attachConsentForm: false,
    present: [
      `${when}の第二キープについてご連絡いたします。`,
      "第二キープを仮予約へ繰り上げてご案内できるようになりました。",
      "繰り上げをご希望の場合は、ご連絡いただけますと幸いです。",
    ],
    absent: [],
    details: false,
    notices: false,
  },
  {
    label: "前倒しの案内",
    draft: { kind: "bring-forward-notice" },
    subject: "【スタジオゼブラ】ご予約の開始時間について",
    attachConsentForm: false,
    present: [
      `${when}のご予約についてご連絡いたします。`,
      "ご希望であれば、開始時間を早めることができる場合がございます。",
    ],
    absent: [],
    details: false,
    notices: false,
  },
];

describe("下書きのテンプレート：種類ごとの件名・要所・同意書（8種類。承認は本予約・仮予約・第二キープの3つ）", () => {
  it("種類は8つ（契約の AdminDraftKind）がすべてある", () => {
    expect(new Set(kindCases.map((c) => c.draft.kind))).toEqual(
      new Set([
        "approval",
        "rejection",
        "promotion",
        "second-hold-ended",
        "cancellation",
        "move-up-notice",
        "bring-forward-notice",
        "change",
      ]),
    );
  });

  it.each(kindCases)(
    "$label：件名、同意書を添付するか（本予約の承認と昇格だけ）、要所の文、ご予約内容・注意事項の有無、宛名・名乗り・結び",
    (c) => {
      for (const [zone, start, end] of bothZones("2026-10-20T15:00", "2026-10-20T17:00")) {
        const mail = render(c.draft, { start, end });
        expect(mail.subject, zone).toBe(c.subject);
        expect(mail.attachConsentForm, zone).toBe(c.attachConsentForm);
        const all = lines(mail);
        expect(all[0], zone).toBe(`${customerName}様`);
        expect(all, zone).toContain(`スタジオゼブラの${staffName}です。`);
        for (const line of c.present) {
          expect(all, `${zone} ${line}`).toContain(line);
        }
        for (const line of c.absent) {
          expect(mail.text, `${zone} ${line}`).not.toContain(line);
        }
        if (c.details) {
          expect(all, zone).toContain(reservationDetailsHeading);
          expect(all, zone).toContain("ご予約日時：2026年10月20日(火) 15時00分〜17時00分（2時間）");
          expect(all, zone).toContain("撮影内容：スチール撮影");
          expect(all, zone).toContain("ご利用人数：4名様");
          expect(all, zone).toContain("カメラマン様：-");
          expect(all, zone).toContain("機材保険：-");
        } else {
          expect(mail.text, zone).not.toContain(reservationDetailsHeading);
          expect(mail.text, zone).not.toContain("ご予約日時：");
        }
        if (c.notices) {
          expect(all, zone).toContain(noticesHeading);
          // ホリゾントの注意事項は、養生の有無にかかわらずいつも書く
          expect(all, zone).toContain("〈ホリゾントの床面が露出した状態でご利用の場合の注意事項〉");
          expect(all, zone).toContain(`・${redShoes}`);
          expect(all, zone).toContain(
            "・ご利用料金は、ご利用当日に現金またはクレジットカードにてお支払いください。",
          );
        } else {
          expect(mail.text, zone).not.toContain(noticesHeading);
          expect(mail.text, zone).not.toContain(redShoes);
        }
        expectClosing(mail, staffName, signature);
        expectWellFormed(mail);
      }
    },
  );

  it("承認の下書きの文面に金額を書かない（承認の下書きは確定金額を持つが、文面には使わない）", () => {
    for (const draft of [firmApproval, provisionalApproval]) {
      const mail = render(draft);
      expect(mail.text).not.toMatch(/[0-9],[0-9]{3}円/);
      expect(mail.text).not.toContain("円");
    }
  });
});

describe("下書きのテンプレート：強調の書き方（テキストでは印が消え、HTML では赤字・青字・下線の span になる）", () => {
  it.each([
    ["承認（本予約）", firmApproval],
    ["昇格", { kind: "promotion" } as const],
  ])("%s の注意事項：赤字の2つ、青字の2つ、下線の1つ", (_, draft) => {
    const mail = render(draft);
    const all = lines(mail);

    expect(all).toContain(`・${redShoes}`);
    // 続きの行は全角の空白（U+3000）で始まる
    expect(all).toContain(`${fullWidthSpace}${redParking}`);
    expect(all).toContain(`・${blueFirst}`);
    expect(all).toContain(`${fullWidthSpace}${blueSecond}`);
    expect(all).toContain(`・${underlineBoots}はホリゾントを著しく汚損する恐れがございますので`);

    expectRed(mail.html, redShoes);
    expectRed(mail.html, redParking);
    expectBlue(mail.html, blueFirst);
    expectBlue(mail.html, blueSecond);
    expectUnderline(mail.html, underlineBoots);
    expectWellFormed(mail);
  });
});

describe("下書きのテンプレート：担当者名と署名の設定がないとき", () => {
  it.each(kindCases)(
    "$label：担当者名の設定がなければ「（担当者名）」と出し、署名の設定がなければ「--」の行から下を出さない",
    (c) => {
      const mail = render(c.draft, {}, {});
      expect(lines(mail)).toContain("スタジオゼブラの（担当者名）です。");
      expectClosing(mail, "（担当者名）", undefined);
      expectWellFormed(mail);
    },
  );

  it("担当者名の設定はなく、署名の設定はある：結びは「（担当者名）」、空行、「--」、署名", () => {
    const mail = render(firmApproval, {}, { signature });
    expectClosing(mail, "（担当者名）", signature);
    expectWellFormed(mail);
  });

  it("担当者名と署名の設定がある：結びは担当者名、空行、「--」、署名の各行", () => {
    const mail = render(firmApproval);
    expectClosing(mail, staffName, signature);
    for (const line of signatureLines) {
      expect(lines(mail)).toContain(line);
    }
  });
});

describe("下書きのテンプレート：差し込む値の HTML のエスケープ", () => {
  const trickyName = "架空 <b>花子</b> & 太郎";
  const trickyPhotographer = "仮名 <i>写真</i> & 撮影";
  const trickyDetails = "<script>架空</script> & 詳細";
  const trickyStaff = "仮名 <u>担当</u> & 一郎";
  const trickySignature = "架空スタジオ <署名> & Co.\n架空県架空市0-0-0";

  it("氏名・カメラマン氏名・撮影詳細・担当者名・署名に「<」「>」「&」があっても、HTML ではエスケープされ、テキストではそのまま出る", () => {
    const mail = render(
      firmApproval,
      {
        customer: { name: trickyName, photographerName: trickyPhotographer },
        shooting: { types: ["still"], details: trickyDetails },
      },
      { staffName: trickyStaff, signature: trickySignature },
    );

    const all = lines(mail);
    expect(all[0]).toBe(`${trickyName}様`);
    expect(all).toContain(`カメラマン様：${trickyPhotographer}様`);
    expect(all).toContain(`撮影内容：スチール撮影（${trickyDetails}）`);
    expect(all).toContain(`スタジオゼブラの${trickyStaff}です。`);
    expectClosing(mail, trickyStaff, trickySignature);

    for (const raw of ["<b>", "</b>", "<i>", "<script>", "</script>", "<u>", "<署名>"]) {
      expect(mail.html).not.toContain(raw);
    }
    expect(mail.html).not.toMatch(/&(?!(?:#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);)/);
    // エスケープを戻すと、テキストの本文と同じになる（値が消えたり、二重にエスケープされたりしない）
    expectWellFormed(mail);
    // 強調の span はそのまま
    expectRed(mail.html, redShoes);
  });
});
