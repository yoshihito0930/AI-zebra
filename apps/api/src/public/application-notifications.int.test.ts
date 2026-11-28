import { CreateTableCommand, DeleteTableCommand } from "@aws-sdk/client-dynamodb";
import {
  AdminDirectEntryAccepted,
  AdminReceiptLookup,
  AdminReservationDetail,
  ApplicationAccepted,
  ReceiptNumber,
} from "@zebra/contracts";
import { DateTime } from "luxon";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdminUserIdSource } from "../admin/admin-user.ts";
import { createApp } from "../app.ts";
import { createLocalDynamoClient } from "../db/client.ts";
import type { ReservationStore } from "../db/reservations.ts";
import type { MailSender, OutgoingMail } from "../mail/sender.ts";
import type { MailSettings } from "../mail/settings.ts";

// 申込の処理（POST /public/applications）が受付通知と管理者への通知を送ることの統合テスト（DynamoDB Local）。
// 根拠：docs/product-specs/mail.md「受付通知」「管理者への新しい申込の通知」（例の表のうち、あて先・送るかどうか・
// 送れなかったときの扱いの行。文面の行は apps/api/src/mail/notification-mail.test.ts）、docs/design-docs/notifications.md
// （部品、送る流れ、設定、テスト）、docs/product-specs/booking.md「確認メール」「申込フォーム」、core-beliefs.md（INV-6、INV-7、INV-10）。
// - アプリは createApp(store, 管理者の id の取り出し方, 設定, 送る部品) で作る。送る部品は、渡されたメールを覚えておく偽物
//   （notifications.md「テスト：送ったメールを覚えておく偽物を渡す」）。SES は呼ばない
// - 設定（MailSettings）は、環境変数から読むところを通さず、値を直接渡す（環境変数の読み取りは
//   apps/api/src/mail/settings-env-notifications.test.ts）
// - API の現在時刻は、Date だけを偽の時計にして固定する（vi.useFakeTimers({ toFake: ["Date"] })。INV-7）
// - 予約の id は、受付番号から探す管理 API（GET /admin/receipts/{受付番号}）で受け取る
// - 送れなかったとき：偽物が投げる例外のメッセージに、あて先・件名・本文を入れる。ログにエラーの中身をそのまま出すと、
//   あて先などが出てしまうことを確かめるため（mail.md「エラーの種類だけをログに残す」）
// - 「送り終えてから、お客様の画面に受付番号を返す」（mail.md「受付通知」）は、偽物の送信に時間がかかっても、
//   返事が来た時点で2通とも送り終えていることで確かめる
// - 文面の細かいところ（テンプレートどおりか）は文面を作る関数の単体テストで確かめるので、ここでは件名と、
//   あて先・氏名・受付番号・リンクが正しく差し込まれていることだけを確かめる
// - 混み合っている（busy）で断る場合は、createApp からは起こせないのでここでは扱わない
// - 架空のお客様の情報・設定を使う

const client = createLocalDynamoClient();
let store: ReservationStore;

// テーブルはキー設計どおり（pk・sk、GSI の gsi1pk・gsi1sk）にテストごとに作り、終わったら消す
async function createTable(): Promise<ReservationStore> {
  const tableName = `int-test-notify-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
        { AttributeName: "gsi1pk", AttributeType: "S" },
        { AttributeName: "gsi1sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      GlobalSecondaryIndexes: [
        {
          IndexName: "gsi1",
          KeySchema: [
            { AttributeName: "gsi1pk", KeyType: "HASH" },
            { AttributeName: "gsi1sk", KeyType: "RANGE" },
          ],
          Projection: { ProjectionType: "ALL" },
        },
      ],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
  return { client, tableName };
}

// ---- 日時（INV-7）。テストの日時は JST で書く。現在時刻は固定する ----

function jst(iso: string): DateTime {
  const dateTime = DateTime.fromISO(iso, { zone: "Asia/Tokyo" });
  if (!dateTime.isValid) {
    throw new Error(`テストの日時が不正：${iso}`);
  }
  return dateTime;
}

/** JST で書いた日時を、本文の形（ISO 8601、+09:00 のオフセット付き）にする */
function isoJst(local: string): string {
  return jst(local).toISO({ suppressMilliseconds: true }) ?? "";
}

/** JST で書いた日時と同じ時点を、UTC で表した ISO 8601 にする（INV-7 の確認に使う） */
function isoUtc(local: string): string {
  return jst(local).toUTC().toISO({ suppressMilliseconds: true }) ?? "";
}

/** API の現在時刻（固定）。締め切りにかからないよう、利用日（10/20 ごろ）より十分前に置く */
const now = jst("2026-10-01T12:00");

beforeEach(async () => {
  store = await createTable();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now.toMillis());
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await client.send(new DeleteTableCommand({ TableName: store.tableName }));
});

// ---- 架空の設定とお客様の情報（INV-10 の確認に使うので、ほかの値と紛れない文字列にする） ----

/** 管理者への通知のあて先（MAIL_ADMIN_TO の値） */
const adminTo = "kaku.admin.tsuchi@example.com";
/** 管理画面の URL（ADMIN_APP_URL の値） */
const adminAppUrl = "http://localhost:5174/";
const signature = ["スタジオゼブラ（架空の通知の署名）", "TEL 090-0000-0202"].join("\n");

const fullSettings: MailSettings = { signature, adminNotificationTo: adminTo, adminAppUrl };

const customer = {
  name: "架空 通知五郎",
  companyName: "架空通知撮影株式会社",
  email: "goro.tsuchi.kaku@example.com",
  phone: "090-0000-5555",
  address: "架空県架空市通知通5-5-5",
  photographerName: "仮名 通知撮影四郎",
} as const;

const shooting = {
  types: ["still", "movie"],
  details: "架空の撮影詳細：通知の確認用の商品撮影",
  notes: "架空の補足事項：通知の確認用の機材の持ち込み",
} as const;

/** INV-10：管理者への通知とログに出さない、お客様の情報と撮影の内容 */
const personalValues: readonly string[] = [
  customer.name,
  customer.companyName,
  customer.email,
  customer.phone,
  customer.address,
  customer.photographerName,
  shooting.details,
  shooting.notes,
];
/** 撮影内容の名前（mail.md「差し込む値」。申込フォームと同じ名前） */
const shootingTypeNames: readonly string[] = ["スチール撮影", "ムービー撮影"];

type Kind = "firm" | "provisional" | "second-hold";
type Body = Record<string, unknown>;

/** 契約（ApplicationRequest）どおりの申込の本文。人数4人・養生なし、機材保険なし、オプションなし */
function body(kind: Kind, start: string, end: string, overrides: Body = {}): Body {
  return {
    kind,
    start: isoJst(start),
    end: isoJst(end),
    partySize: 4,
    cycloramaFloorProtection: false,
    equipmentInsurance: false,
    optionIds: [],
    customer: { ...customer },
    shooting: { ...shooting, types: [...shooting.types] },
    agreedToCycloramaRules: true,
    agreedToTerms: true,
    ...overrides,
  };
}

// ---- 偽物の送る部品 ----

interface FakeSender {
  readonly sender: MailSender;
  /** send に渡されたメール（例外を投げたものも含む。渡された順） */
  readonly attempted: OutgoingMail[];
  /** 送り終えたメール（例外を投げなかったもの。送り終えた順） */
  readonly sent: OutgoingMail[];
}

/**
 * 渡されたメールを覚えておく偽物。fail が true を返す種類は、例外を投げる（送れなかった）。
 * 例外のメッセージには、あて先・件名・本文を入れる（ログに出ないことの確認に使う）。
 * delayMs があれば、送り終えるまでにその時間がかかる
 */
function fakeSender(
  options: { fail?: (mail: OutgoingMail) => boolean; delayMs?: number } = {},
): FakeSender {
  const attempted: OutgoingMail[] = [];
  const sent: OutgoingMail[] = [];
  const sender: MailSender = {
    async send(mail) {
      attempted.push(mail);
      if (options.delayMs !== undefined) {
        const ms = options.delayMs;
        await new Promise((resolve) => setTimeout(resolve, ms));
      }
      if (options.fail?.(mail) === true) {
        throw new Error(
          `偽物の送信の失敗（to=${mail.to} subject=${mail.subject} text=${mail.text}）`,
        );
      }
      sent.push(mail);
    },
  };
  return { sender, attempted, sent };
}

// ---- API を呼ぶ道具 ----

/** API を呼ぶ管理者（架空のユーザー id） */
const adminUserId = "admin-user-kaku-notify";
const adminSource: AdminUserIdSource = () => adminUserId;

type App = ReturnType<typeof createApp>;

function app(fake: FakeSender | undefined, settings: MailSettings = fullSettings): App {
  return fake === undefined
    ? createApp(store, adminSource, settings)
    : createApp(store, adminSource, settings, fake.sender);
}

async function postJson(target: App, path: string, value: unknown): Promise<Response> {
  return target.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
}

async function apply(target: App, value: unknown): Promise<Response> {
  return postJson(target, "/public/applications", value);
}

/** 受け付けられるはずの申込を送り、受付番号を返す */
async function applyOk(target: App, value: unknown): Promise<ApplicationAccepted> {
  const res = await apply(target, value);
  const text = await res.text();
  expect(res.status, text).toBe(201);
  const accepted = ApplicationAccepted.parse(JSON.parse(text));
  expect(ReceiptNumber.safeParse(accepted.receiptNumber).success).toBe(true);
  return accepted;
}

/** 受付番号から予約の id を探す（GET /admin/receipts/{受付番号}） */
async function reservationIdOf(receiptNumber: string): Promise<string> {
  const res = await app(undefined).request(`/admin/receipts/${encodeURIComponent(receiptNumber)}`);
  expect(res.status).toBe(200);
  return AdminReceiptLookup.parse(await res.json()).reservationId;
}

/** 予約の詳細（GET /admin/reservations/{id}） */
async function detailOf(reservationId: string): Promise<AdminReservationDetail> {
  const res = await app(undefined).request(
    `/admin/reservations/${encodeURIComponent(reservationId)}`,
  );
  expect(res.status).toBe(200);
  return AdminReservationDetail.parse(await res.json());
}

/** 承認する（準備。POST /admin/reservations/{id}/approve） */
async function approve(reservationId: string): Promise<void> {
  const res = await postJson(
    app(undefined),
    `/admin/reservations/${encodeURIComponent(reservationId)}/approve`,
    { confirmedPrice: 11_000 },
  );
  expect(res.status, await res.text()).toBe(200);
}

/** 承認済みの仮予約を用意する（第二キープの申込の準備）。メールは送らない（送る部品を渡さない） */
async function prepareApprovedProvisional(start: string, end: string): Promise<void> {
  const accepted = await applyOk(
    app(undefined),
    body("provisional", start, end, {
      customer: {
        name: "架空 準備一子",
        email: "junbi.ichiko.kaku@example.com",
        phone: "090-0000-1111",
        address: "架空県架空市準備町1-1-1",
        photographerName: "仮名 準備写真",
      },
    }),
  );
  await approve(await reservationIdOf(accepted.receiptNumber));
}

/** console と標準出力・標準エラーに出たものを集める（出力はそのまま通す） */
function captureOutput(): () => string {
  const calls: (() => unknown[][])[] = [
    ...(["log", "info", "warn", "error", "debug"] as const).map((method) => {
      const spy = vi.spyOn(console, method);
      return () => spy.mock.calls as unknown[][];
    }),
    ...[process.stdout, process.stderr].map((stream) => {
      const spy = vi.spyOn(stream, "write");
      return () => spy.mock.calls as unknown[][];
    }),
  ];
  // 文字列以外（オブジェクト、Error、バイト列）も、中の値が見える文字列に直す
  const show = (arg: unknown): string =>
    typeof arg === "string"
      ? arg
      : arg instanceof Uint8Array
        ? Buffer.from(arg).toString("utf8")
        : inspect(arg, { depth: 10, breakLength: Number.POSITIVE_INFINITY });
  return () =>
    calls
      .flatMap((read) => read())
      .map((args) => args.map(show).join(" "))
      .join("\n");
}

function kinds(mails: readonly OutgoingMail[]): OutgoingMail["kind"][] {
  return mails.map((mail) => mail.kind);
}

function mailOf(mails: readonly OutgoingMail[], kind: OutgoingMail["kind"]): OutgoingMail {
  const found = mails.filter((mail) => mail.kind === kind);
  expect(found, kind).toHaveLength(1);
  return found[0] as OutgoingMail;
}

/** 管理者への通知の件名・本文に、お客様の情報と撮影の内容がないこと（INV-10） */
function expectNoPersonalIn(mail: OutgoingMail): void {
  for (const value of [...personalValues, ...shootingTypeNames]) {
    expect(mail.subject, value).not.toContain(value);
    expect(mail.text, value).not.toContain(value);
  }
}

/** ログに、あて先・氏名などのお客様の情報・件名・本文が出ていないこと（INV-10） */
function expectNothingPrivateInLog(log: string, mails: readonly OutgoingMail[]): void {
  for (const value of [...personalValues, adminTo]) {
    expect(log, value).not.toContain(value);
  }
  for (const mail of mails) {
    expect(log).not.toContain(mail.to);
    expect(log).not.toContain(mail.subject);
    // 「--」のような短い行は、ほかの出力にも出うるので除く
    for (const line of mail.text.split("\n").filter((l) => l.trim().length >= 6)) {
      expect(log, line).not.toContain(line);
    }
  }
}

// ---- テスト ----

describe("受付通知", () => {
  it("本予約 2026/10/20 15:00–17:00 をフォームで受け付けた。氏名「架空 花子」、受付番号 ABCD2345：あて先はフォームのメールアドレス（受付番号はシステムが決めるので、返した受付番号が本文にある）", async () => {
    const fake = fakeSender();
    const form = body("firm", "2026-10-20T15:00", "2026-10-20T17:00", {
      customer: { ...customer, name: "架空 花子", email: "hanako.kaku@example.com" },
    });

    const accepted = await applyOk(app(fake), form);

    const receipt = mailOf(fake.sent, "receipt");
    expect(receipt.to).toBe("hanako.kaku@example.com");
    expect(receipt.subject).toBe(
      "2026年10月20日(火) 15時00分〜17時00分のお申し込みを受け付けました（スタジオゼブラ）",
    );
    const lines = receipt.text.split("\n");
    expect(lines).toContain("架空 花子様");
    expect(lines).toContain(`受付番号：${accepted.receiptNumber}`);
    expect(lines).toContain("お申し込みの種類：本予約");
    expect(lines).toContain("ご希望の日時：2026年10月20日(火) 15時00分〜17時00分（2時間）");
    expect(receipt.text).toContain("ご予約はまだ確定していません");
  });

  it("同じ申込の日時を UTC で送っても、受付通知の件名・日時は JST で書く（INV-7）", async () => {
    const fake = fakeSender();
    const form = {
      ...body("firm", "2026-10-20T15:00", "2026-10-20T17:00"),
      start: isoUtc("2026-10-20T15:00"),
      end: isoUtc("2026-10-20T17:00"),
    };

    await applyOk(app(fake), form);

    const receipt = mailOf(fake.sent, "receipt");
    expect(receipt.subject).toBe(
      "2026年10月20日(火) 15時00分〜17時00分のお申し込みを受け付けました（スタジオゼブラ）",
    );
    expect(receipt.text.split("\n")).toContain(
      "ご希望の日時：2026年10月20日(火) 15時00分〜17時00分（2時間）",
    );
  });

  it("仮予約 2026/10/20 22:00–10/21 02:00 を受け付けた：「お申し込みの種類：仮予約」「ご希望の日時：2026年10月20日(火) 22時00分〜翌2時00分（4時間）」", async () => {
    const fake = fakeSender();

    await applyOk(app(fake), body("provisional", "2026-10-20T22:00", "2026-10-21T02:00"));

    const lines = mailOf(fake.sent, "receipt").text.split("\n");
    expect(lines).toContain("お申し込みの種類：仮予約");
    expect(lines).toContain("ご希望の日時：2026年10月20日(火) 22時00分〜翌2時00分（4時間）");
  });

  it("第二キープを受け付けた：「お申し込みの種類：第二キープ」", async () => {
    await prepareApprovedProvisional("2026-10-20T15:00", "2026-10-20T17:00");
    const fake = fakeSender();

    await applyOk(app(fake), body("second-hold", "2026-10-20T15:00", "2026-10-20T17:00"));

    expect(kinds(fake.sent)).toEqual(["receipt", "admin-new-application"]);
    expect(mailOf(fake.sent, "receipt").text.split("\n")).toContain("お申し込みの種類：第二キープ");
  });

  it.each([
    [
      "本予約申込が開始の24時間前を過ぎた（申込 10/01 12:00、開始 10/02 11:00）",
      body("firm", "2026-10-02T11:00", "2026-10-02T13:00"),
      422,
    ],
    [
      "仮予約申込が仮予約の期限を過ぎた（申込 10/01 12:00、開始 10/05 10:00。期限は 9/28 18:00）",
      body("provisional", "2026-10-05T10:00", "2026-10-05T12:00"),
      422,
    ],
  ] as [string, Body, number][])(
    "締め切りを過ぎた申込を断った：送らない（%s）",
    async (_, value, status) => {
      const fake = fakeSender();

      const res = await apply(app(fake), value);

      expect(res.status).toBe(status);
      expect(fake.attempted).toEqual([]);
    },
  );

  it("管理者が直接入力した：送らない（POST /admin/reservations。受付通知も管理者への通知も）", async () => {
    const fake = fakeSender();

    const res = await postJson(app(fake), "/admin/reservations", {
      kind: "firm",
      start: isoJst("2026-10-22T10:00"),
      end: isoJst("2026-10-22T12:00"),
      partySize: 3,
      cycloramaFloorProtection: false,
      equipmentInsurance: false,
      optionIds: [],
      confirmedPrice: 11_000,
      customer: { name: customer.name, email: customer.email, phone: customer.phone },
      shooting: {},
    });

    const text = await res.text();
    expect(res.status, text).toBe(201);
    expect(AdminDirectEntryAccepted.safeParse(JSON.parse(text)).success).toBe(true);
    expect(fake.attempted).toEqual([]);
  });

  it("SES に送れなかった：申込は受け付けたまま（201 と受付番号）。ログにはエラーの種類だけが出て、あて先や氏名は出ない", async () => {
    const fake = fakeSender({ fail: (mail) => mail.kind === "receipt" });
    const output = captureOutput();

    const accepted = await applyOk(app(fake), body("firm", "2026-10-20T15:00", "2026-10-20T17:00"));

    // 申込は保存されていて、管理画面の承認待ちに出る
    const id = await reservationIdOf(accepted.receiptNumber);
    expect((await detailOf(id)).status).toBe("pending-firm");
    // 片方が送れなくても、もう片方は送る
    expect(kinds(fake.attempted)).toEqual(["receipt", "admin-new-application"]);
    expect(kinds(fake.sent)).toEqual(["admin-new-application"]);

    const log = output();
    expect(log).toContain("receipt-mail-failed");
    expect(log).not.toContain("admin-notification-failed");
    expectNothingPrivateInLog(log, fake.attempted);
  });
});

describe("管理者への新しい申込の通知", () => {
  it("フォームで申込を受け付けた。`MAIL_ADMIN_TO` と `ADMIN_APP_URL`（http://localhost:5174/）がある：あて先は `MAIL_ADMIN_TO`。件名は「新しいお申し込みがあります（スタジオゼブラ）」。本文に予約の詳細へのリンク（http://localhost:5174/#/reservations/{予約の id}）がある", async () => {
    const fake = fakeSender();

    const accepted = await applyOk(app(fake), body("firm", "2026-10-20T15:00", "2026-10-20T17:00"));

    const id = await reservationIdOf(accepted.receiptNumber);
    const notification = mailOf(fake.sent, "admin-new-application");
    expect(notification.to).toBe(adminTo);
    expect(notification.subject).toBe("新しいお申し込みがあります（スタジオゼブラ）");
    expect(notification.text.split("\n")).toContain(`http://localhost:5174/#/reservations/${id}`);
  });

  it("同上：本文・件名に、お客様の氏名・メールアドレス・電話番号・撮影の内容がない（INV-10）", async () => {
    await prepareApprovedProvisional("2026-10-21T15:00", "2026-10-21T17:00");
    const fake = fakeSender();
    const target = app(fake);

    await applyOk(target, body("firm", "2026-10-20T15:00", "2026-10-20T17:00"));
    await applyOk(target, body("provisional", "2026-10-20T22:00", "2026-10-21T02:00"));
    await applyOk(target, body("second-hold", "2026-10-21T15:00", "2026-10-21T17:00"));

    const notifications = fake.sent.filter((mail) => mail.kind === "admin-new-application");
    expect(notifications).toHaveLength(3);
    for (const notification of notifications) {
      expectNoPersonalIn(notification);
    }
  });

  it("`MAIL_ADMIN_TO` がない：管理者への通知は送らない（受付通知は送る）", async () => {
    const fake = fakeSender();
    const settings: MailSettings = { signature, adminAppUrl };

    await applyOk(app(fake, settings), body("firm", "2026-10-20T15:00", "2026-10-20T17:00"));

    expect(kinds(fake.attempted)).toEqual(["receipt"]);
    expect(mailOf(fake.sent, "receipt").to).toBe(customer.email);
  });

  it("`ADMIN_APP_URL` がない：リンクの代わりに「管理画面の承認待ちを確かめてください」と書く", async () => {
    const fake = fakeSender();
    const settings: MailSettings = { signature, adminNotificationTo: adminTo };

    await applyOk(app(fake, settings), body("firm", "2026-10-20T15:00", "2026-10-20T17:00"));

    const notification = mailOf(fake.sent, "admin-new-application");
    expect(notification.to).toBe(adminTo);
    expect(notification.text).toContain("管理画面の承認待ちを確かめてください");
    expect(notification.text).not.toContain("#/reservations/");
  });

  it("管理者への通知だけ送れなかった：申込は受け付けたまま。受付通知は送る", async () => {
    const fake = fakeSender({ fail: (mail) => mail.kind === "admin-new-application" });
    const output = captureOutput();

    const accepted = await applyOk(app(fake), body("firm", "2026-10-20T15:00", "2026-10-20T17:00"));

    const id = await reservationIdOf(accepted.receiptNumber);
    expect((await detailOf(id)).status).toBe("pending-firm");
    expect(kinds(fake.attempted)).toEqual(["receipt", "admin-new-application"]);
    expect(kinds(fake.sent)).toEqual(["receipt"]);
    expect(mailOf(fake.sent, "receipt").to).toBe(customer.email);

    const log = output();
    expect(log).toContain("admin-notification-failed");
    expect(log).not.toContain("receipt-mail-failed");
    expectNothingPrivateInLog(log, fake.attempted);
  });
});

describe("申込の処理：受付通知と管理者への通知を送る流れ（notifications.md「送る流れ」）", () => {
  it.each([
    ["本予約", "firm", "2026-10-20T15:00", "2026-10-20T17:00"],
    ["仮予約", "provisional", "2026-10-20T15:00", "2026-10-20T17:00"],
  ] as [string, Kind, string, string][])(
    "%sの申込を受け付けた：受付通知（あて先はフォームのメールアドレス）、管理者への通知（あて先は MAIL_ADMIN_TO）の順に2通を渡す。ほかの種類は渡さない（INV-6）",
    async (_, kind, start, end) => {
      const fake = fakeSender();

      await applyOk(app(fake), body(kind, start, end));

      expect(kinds(fake.attempted)).toEqual(["receipt", "admin-new-application"]);
      expect(kinds(fake.sent)).toEqual(["receipt", "admin-new-application"]);
      expect(fake.sent.map((mail) => mail.to)).toEqual([customer.email, adminTo]);
    },
  );

  it("送り終えてから受付番号を返す：送るのに時間がかかっても、返事が来た時点で2通とも送り終えている", async () => {
    const fake = fakeSender({ delayMs: 50 });

    await applyOk(app(fake), body("firm", "2026-10-20T15:00", "2026-10-20T17:00"));

    expect(kinds(fake.sent)).toEqual(["receipt", "admin-new-application"]);
  });

  it("空き判定で断った（本予約 10/20 15:00–17:00 の承認待ちと重なる 16:00–18:00）：1通も渡さない", async () => {
    await applyOk(app(undefined), body("firm", "2026-10-20T15:00", "2026-10-20T17:00"));
    const fake = fakeSender();

    const res = await apply(app(fake), body("firm", "2026-10-20T16:00", "2026-10-20T18:00"));

    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: "overlaps-existing" });
    expect(fake.attempted).toEqual([]);
  });

  it("時間の単位で断った（2時間未満）・入力の誤り（利用規約への同意なし）：1通も渡さない", async () => {
    const fake = fakeSender();
    const target = app(fake);

    const short = await apply(target, body("firm", "2026-10-20T10:00", "2026-10-20T11:30"));
    const invalid = await apply(
      target,
      body("firm", "2026-10-20T15:00", "2026-10-20T17:00", { agreedToTerms: false }),
    );
    const notJson = await apply(target, "{");

    expect(short.status).toBe(422);
    expect(invalid.status).toBe(400);
    expect(notJson.status).toBe(400);
    expect(fake.attempted).toEqual([]);
  });

  it("両方とも送れなかった：201 と受付番号が返り、申込は保存されている。ログにはエラーの種類（receipt-mail-failed・admin-notification-failed）だけが出て、あて先・氏名・本文は出ない", async () => {
    const fake = fakeSender({ fail: () => true });
    const output = captureOutput();

    const accepted = await applyOk(app(fake), body("firm", "2026-10-20T15:00", "2026-10-20T17:00"));

    const id = await reservationIdOf(accepted.receiptNumber);
    expect((await detailOf(id)).status).toBe("pending-firm");
    expect(kinds(fake.attempted)).toEqual(["receipt", "admin-new-application"]);
    expect(fake.sent).toEqual([]);

    const log = output();
    expect(log).toContain("receipt-mail-failed");
    expect(log).toContain("admin-notification-failed");
    expectNothingPrivateInLog(log, fake.attempted);
  });

  it("送れたとき：ログにエラーの種類も、あて先・氏名・本文も出ない", async () => {
    const fake = fakeSender();
    const output = captureOutput();

    await applyOk(app(fake), body("firm", "2026-10-20T15:00", "2026-10-20T17:00"));

    expect(fake.sent).toHaveLength(2);
    const log = output();
    expect(log).not.toContain("receipt-mail-failed");
    expect(log).not.toContain("admin-notification-failed");
    expectNothingPrivateInLog(log, fake.sent);
  });

  it("送る部品を渡さない（createApp の4つ目の引数を省く）：今までどおり 201 と受付番号を返し、申込を保存する", async () => {
    const accepted = await applyOk(
      app(undefined),
      body("firm", "2026-10-20T15:00", "2026-10-20T17:00"),
    );

    const id = await reservationIdOf(accepted.receiptNumber);
    expect((await detailOf(id)).status).toBe("pending-firm");
  });
});
