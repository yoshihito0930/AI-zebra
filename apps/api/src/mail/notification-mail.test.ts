import fc from "fast-check";
import { DateTime } from "luxon";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type AdminNotificationMailInput,
  type NotificationMail,
  type ReceiptMailInput,
  renderAdminNotificationMail,
  renderReceiptMail,
} from "./notification-mail.ts";

// 受付通知と管理者への新しい申込の通知の文面を作る関数（renderReceiptMail・renderAdminNotificationMail）の単体テスト。
// 根拠：docs/product-specs/mail.md「受付通知」「管理者への新しい申込の通知」（テンプレートと件名、例の表の行）、
// 「日時の書き方」、docs/design-docs/notifications.md「部品」、core-beliefs.md（INV-6、INV-7、INV-10）。
// - 例の表の行のうち、文面を作る関数で決まるものをここで確かめる。あて先・送るかどうか・送れなかったときの扱いは
//   申込の処理が決めるので、申込の処理の統合テスト（apps/api/src/public/application-notifications.int.test.ts）で確かめる
//   - 受付通知：「締め切りを過ぎた申込を断った」「管理者が直接入力した」「SES に送れなかった」の行と、1行目の「あて先は
//     フォームのメールアドレス」
//   - 管理者への通知：「`MAIL_ADMIN_TO` がない」「管理者への通知だけ送れなかった」の行と、1行目の「あて先は `MAIL_ADMIN_TO`」
// - 日時の行は、同じ時点を JST と UTC の2通りで渡して、どちらも同じ文面になることを確かめる（INV-7。TESTING.md）
// - 受付通知は人がレビューしたテンプレートだけを使う（INV-6）ので、テンプレートどおりの本文になることを一字一句確かめる。
//   本文の終わりの改行の有無は mail.md にないので、比べる前に終わりの改行と空白を除く
// - INV-6（金額・「確定しました」・空きの有無の文がない）は、例の行に加えて、種類・日時・受付番号・署名の有無を
//   いろいろに変えたプロパティベーステスト（fast-check）でも確かめる
// - INV-10：管理者への通知の関数は、お客様の情報を受け取らない形（予約の id と管理画面の URL だけ）にする。
//   型で確かめ、余計な値を混ぜて渡しても件名・本文に出ないことも確かめる
// - 氏名・署名・メールアドレスなどは架空の値を使う

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

// ---- 架空の設定と申込 ----

const signatureLines = [
  "スタジオゼブラ（架空の受付通知の署名）",
  "〒000-0000 架空県架空市受付町0-0-1",
  "TEL 090-0000-0101",
  "Mail kaku.uketsuke.studio@example.com",
  "HP https://kaku-uketsuke.example.com",
] as const;
const signature = signatureLines.join("\n");

function receipt(overrides: Partial<ReceiptMailInput> = {}): ReceiptMailInput {
  return {
    customerName: "架空 花子",
    receiptNumber: "ABCD2345",
    kind: "firm",
    start: jst("2026-10-20T15:00"),
    end: jst("2026-10-20T17:00"),
    signature,
    ...overrides,
  };
}

function lines(mail: NotificationMail): string[] {
  return mail.text.split("\n");
}

/** 本文の終わりの改行と空白を除いた行 */
function trimmedLines(mail: NotificationMail): string[] {
  return mail.text.replace(/\s+$/, "").split("\n");
}

/** 受付通知のテンプレートの「--」の行より前（mail.md「受付通知」の本文） */
function receiptBodyLines(
  name: string,
  receiptNumber: string,
  kindLabel: string,
  dateTime: string,
  duration: string,
): string[] {
  return [
    `${name}様`,
    "",
    "この度はスタジオゼブラへお申し込みいただき、ありがとうございます。",
    "下記の内容で、お申し込みを受け付けました。",
    "",
    `受付番号：${receiptNumber}`,
    `お申し込みの種類：${kindLabel}`,
    `ご希望の日時：${dateTime}（${duration}）`,
    "",
    "お申し込みの内容を確認のうえ、担当者からあらためてご連絡いたします。",
    "このメールの時点では、ご予約はまだ確定していません。",
    "",
    "お問い合わせの際は、受付番号をお伝えください。",
    "このメールは自動でお送りしています。ご返信いただくと、スタジオゼブラの担当者に届きます。",
  ];
}

/** INV-6：受付通知に書かない、金額・予約の成立・空きの可否の文 */
const forbiddenInReceipt: readonly RegExp[] = [
  /\d[\d,]*\s*円/,
  /[¥￥]/,
  /税込|税抜|料金|見積|金額/,
  /確定しました/,
  /成立/,
  /空き|空いて/,
];

function expectNoForbiddenInReceipt(mail: NotificationMail): void {
  for (const pattern of forbiddenInReceipt) {
    expect(mail.subject, `件名に ${String(pattern)}`).not.toMatch(pattern);
    expect(mail.text, `本文に ${String(pattern)}`).not.toMatch(pattern);
  }
}

// ---- 受付通知 ----

describe("受付通知", () => {
  describe.each(bothZones("2026-10-20T15:00", "2026-10-20T17:00"))("%s で渡す", (_, start, end) => {
    it("本予約 2026/10/20 15:00–17:00 をフォームで受け付けた。氏名「架空 花子」、受付番号 ABCD2345：件名は「2026年10月20日(火) 15時00分〜17時00分のお申し込みを受け付けました（スタジオゼブラ）」。本文に「架空 花子様」「受付番号：ABCD2345」「お申し込みの種類：本予約」「ご希望の日時：2026年10月20日(火) 15時00分〜17時00分（2時間）」「ご予約はまだ確定していません」がある", () => {
      const mail = renderReceiptMail(
        receipt({ customerName: "架空 花子", receiptNumber: "ABCD2345", kind: "firm", start, end }),
      );

      expect(mail.subject).toBe(
        "2026年10月20日(火) 15時00分〜17時00分のお申し込みを受け付けました（スタジオゼブラ）",
      );
      expect(lines(mail)).toContain("架空 花子様");
      expect(lines(mail)).toContain("受付番号：ABCD2345");
      expect(lines(mail)).toContain("お申し込みの種類：本予約");
      expect(lines(mail)).toContain("ご希望の日時：2026年10月20日(火) 15時00分〜17時00分（2時間）");
      expect(mail.text).toContain("ご予約はまだ確定していません");
    });
  });

  describe.each(bothZones("2026-10-20T22:00", "2026-10-21T02:00"))("%s で渡す", (_, start, end) => {
    it("仮予約 2026/10/20 22:00–10/21 02:00 を受け付けた：「お申し込みの種類：仮予約」「ご希望の日時：2026年10月20日(火) 22時00分〜翌2時00分（4時間）」", () => {
      const mail = renderReceiptMail(receipt({ kind: "provisional", start, end }));

      expect(lines(mail)).toContain("お申し込みの種類：仮予約");
      expect(lines(mail)).toContain(
        "ご希望の日時：2026年10月20日(火) 22時00分〜翌2時00分（4時間）",
      );
      // 件名も同じ書き方（mail.md「日時の書き方」：件名は本文と同じ書き方）
      expect(mail.subject).toBe(
        "2026年10月20日(火) 22時00分〜翌2時00分のお申し込みを受け付けました（スタジオゼブラ）",
      );
    });
  });

  it("第二キープを受け付けた：「お申し込みの種類：第二キープ」", () => {
    const mail = renderReceiptMail(receipt({ kind: "second-hold" }));

    expect(lines(mail)).toContain("お申し込みの種類：第二キープ");
  });

  it("本文に金額・「確定しました」・空きの有無の文がない：受付通知のどの文面にもない（INV-6）", () => {
    const kinds: ReceiptMailInput["kind"][] = ["firm", "provisional", "second-hold"];
    for (const kind of kinds) {
      for (const withSignature of [true, false]) {
        for (const [, start, end] of [
          ...bothZones("2026-10-20T15:00", "2026-10-20T17:00"),
          ...bothZones("2026-10-20T22:00", "2026-10-21T02:00"),
        ]) {
          const mail = renderReceiptMail(
            receipt({ kind, start, end, signature: withSignature ? signature : undefined }),
          );
          expectNoForbiddenInReceipt(mail);
        }
      }
    }
  });

  it("`{署名}` の設定がない：本文は「スタジオゼブラの担当者に届きます。」の行で終わる", () => {
    for (const mail of [
      renderReceiptMail(receipt({ signature: undefined })),
      renderReceiptMail({
        customerName: "架空 花子",
        receiptNumber: "ABCD2345",
        kind: "firm",
        start: jst("2026-10-20T15:00"),
        end: jst("2026-10-20T17:00"),
      }),
    ]) {
      const all = trimmedLines(mail);
      expect(all.at(-1)).toBe(
        "このメールは自動でお送りしています。ご返信いただくと、スタジオゼブラの担当者に届きます。",
      );
      expect(all).not.toContain("--");
    }
  });

  // ---- テンプレート（例の行のほかに、mail.md「受付通知」のテンプレートどおりであること） ----

  it("テンプレート：署名の設定がある：本文はテンプレートどおりで、「--」の行のあとに署名の行が続いて終わる", () => {
    const mail = renderReceiptMail(receipt());

    expect(trimmedLines(mail)).toEqual([
      ...receiptBodyLines(
        "架空 花子",
        "ABCD2345",
        "本予約",
        "2026年10月20日(火) 15時00分〜17時00分",
        "2時間",
      ),
      "",
      "--",
      ...signatureLines,
    ]);
  });

  it("テンプレート：署名の設定がない：本文はテンプレートの「--」の行より前だけ", () => {
    const mail = renderReceiptMail(receipt({ kind: "second-hold", signature: undefined }));

    expect(trimmedLines(mail)).toEqual(
      receiptBodyLines(
        "架空 花子",
        "ABCD2345",
        "第二キープ",
        "2026年10月20日(火) 15時00分〜17時00分",
        "2時間",
      ),
    );
  });

  it("テンプレート：担当者名を書かない・テキストだけ（強調の印や HTML のタグがない）", () => {
    const mail = renderReceiptMail(receipt());

    expect(mail.text).not.toContain("（担当者名）");
    expect(mail.text).not.toMatch(/<\/?(赤|青|下線|span|br|p|div|a)\b/);
  });

  // ---- プロパティベーステスト（INV-6、INV-7） ----

  const fictionalNames = ["架空 花子", "仮名 太郎", "架空 撮影二郎", "仮名 三子"] as const;
  const receiptNumberChars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  /** 30分単位の予約区間（2026-10-01 から約1年の中の開始、長さ 2〜24時間）を JST で作る */
  const interval = fc
    .record({
      startHalfHour: fc.integer({ min: 0, max: 365 * 48 }),
      halfHours: fc.integer({ min: 4, max: 48 }),
    })
    .map(({ startHalfHour, halfHours }) => {
      const start = jst("2026-10-01T00:00").plus({ minutes: startHalfHour * 30 });
      return { start, end: start.plus({ minutes: halfHours * 30 }) };
    });

  const receiptInput = fc
    .record({
      customerName: fc.constantFrom(...fictionalNames),
      receiptNumber: fc
        .array(fc.constantFrom(...receiptNumberChars), { minLength: 8, maxLength: 8 })
        .map((chars) => chars.join("")),
      kind: fc.constantFrom<ReceiptMailInput["kind"][]>("firm", "provisional", "second-hold"),
      interval,
      withSignature: fc.boolean(),
    })
    .map(
      ({ customerName, receiptNumber, kind, interval: { start, end }, withSignature }) =>
        ({
          customerName,
          receiptNumber,
          kind,
          start,
          end,
          signature: withSignature ? signature : undefined,
        }) satisfies ReceiptMailInput,
    );

  it("プロパティ：どの種類・日時・受付番号・署名の有無でも、件名・本文に金額・「確定しました」・空きの有無の文がなく、「ご予約はまだ確定していません」がある（INV-6）", () => {
    fc.assert(
      fc.property(receiptInput, (input) => {
        const mail = renderReceiptMail(input);
        expectNoForbiddenInReceipt(mail);
        expect(mail.text).toContain("このメールの時点では、ご予約はまだ確定していません。");
        expect(lines(mail)).toContain(`受付番号：${input.receiptNumber}`);
      }),
    );
  });

  it("プロパティ：同じ時点を UTC で渡しても、JST で渡したときと同じ件名・本文になる（INV-7）", () => {
    fc.assert(
      fc.property(receiptInput, (input) => {
        const inJst = renderReceiptMail(input);
        const inUtc = renderReceiptMail({
          ...input,
          start: input.start.toUTC(),
          end: input.end.toUTC(),
        });
        expect(inUtc).toEqual(inJst);
      }),
    );
  });
});

// ---- 管理者への新しい申込の通知 ----

const reservationId = "res-kaku-0001";

describe("管理者への新しい申込の通知", () => {
  it("フォームで申込を受け付けた。`MAIL_ADMIN_TO` と `ADMIN_APP_URL`（http://localhost:5174/）がある：件名は「新しいお申し込みがあります（スタジオゼブラ）」。本文に予約の詳細へのリンク（http://localhost:5174/#/reservations/{予約の id}）がある", () => {
    const mail = renderAdminNotificationMail({
      reservationId,
      adminAppUrl: "http://localhost:5174/",
    });

    expect(mail.subject).toBe("新しいお申し込みがあります（スタジオゼブラ）");
    expect(lines(mail)).toContain(`http://localhost:5174/#/reservations/${reservationId}`);
  });

  it("同上：本文・件名に、お客様の氏名・メールアドレス・電話番号・撮影の内容がない（INV-10）", () => {
    // 関数は、予約の id と管理画面の URL のほかを受け取らない形にする
    expectTypeOf<keyof AdminNotificationMailInput>().toEqualTypeOf<
      "reservationId" | "adminAppUrl"
    >();

    // 申込のお客様の情報を混ぜて渡しても、件名・本文に出さない
    const personal = {
      name: "架空 通知花子",
      companyName: "架空通知株式会社",
      email: "tsuchi.hanako.kaku@example.com",
      phone: "090-0000-2468",
      address: "架空県架空市通知町2-4-6",
      photographerName: "仮名 通知写真",
      details: "架空の撮影詳細：通知の確認用",
      notes: "架空の補足事項：通知の確認用",
    } as const;
    const mail = renderAdminNotificationMail({
      reservationId,
      adminAppUrl: "http://localhost:5174/",
      customer: personal,
      shooting: { types: ["still", "movie"], details: personal.details, notes: personal.notes },
      ...personal,
    } as AdminNotificationMailInput);

    for (const value of [...Object.values(personal), "スチール撮影", "ムービー撮影"]) {
      expect(mail.subject).not.toContain(value);
      expect(mail.text).not.toContain(value);
    }
  });

  it("`ADMIN_APP_URL` がない：リンクの代わりに「管理画面の承認待ちを確かめてください」と書く", () => {
    for (const mail of [
      renderAdminNotificationMail({ reservationId }),
      renderAdminNotificationMail({ reservationId, adminAppUrl: undefined }),
    ]) {
      expect(mail.subject).toBe("新しいお申し込みがあります（スタジオゼブラ）");
      expect(mail.text).toContain("管理画面の承認待ちを確かめてください");
      expect(mail.text).not.toContain("#/reservations/");
      expect(mail.text).not.toContain("http");
    }
  });

  // ---- テンプレート（例の行のほかに、mail.md「管理者への新しい申込の通知」のテンプレートどおりであること） ----

  it("テンプレート：`ADMIN_APP_URL` がある：本文は案内の文、空の行、予約の詳細へのリンクの3行", () => {
    const mail = renderAdminNotificationMail({
      reservationId,
      adminAppUrl: "http://localhost:5174/",
    });

    expect(trimmedLines(mail)).toEqual([
      "新しいお申し込みがありました。管理画面で内容を確かめ、承認か却下をしてください。",
      "",
      `http://localhost:5174/#/reservations/${reservationId}`,
    ]);
  });
});
