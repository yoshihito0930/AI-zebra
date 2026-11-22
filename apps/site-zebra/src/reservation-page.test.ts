// 予約ページ（src/pages/reservation/index.astro）を、環境変数（PUBLIC_BOOKING_WIDGET_ENABLED、PUBLIC_STUDIO_TEL）を変えて実際に組み立て（astro build）、
// 生成された HTML に何が入るかを確かめる。
// ページのテストはここに置く（src/pages の下の .ts はページ〈エンドポイント〉として組み立てられるため）
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOOKING_WIDGET_FLAG } from "./booking-widget-flag";
import { STUDIO_TEL } from "./studio-tel";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const astroCli = join(siteRoot, "node_modules/astro/bin/astro.mjs");

/** 架空の電話番号 */
const FAKE_TEL = "000-0000-0000";

const outDirs: string[] = [];

/** 環境変数（undefined は変数なし）を渡して HP を組み立て、予約ページの HTML を返す */
async function buildReservationPage(vars: {
  flag: string | undefined;
  tel: string | undefined;
}): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "zebra-site-build-"));
  outDirs.push(outDir);
  // Vitest が足す変数（NODE_ENV=test など）と、手元で付けた変数を外し、pnpm build と同じ条件で組み立てる
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        key !== BOOKING_WIDGET_FLAG &&
        key !== STUDIO_TEL &&
        key !== "NODE_ENV" &&
        !key.startsWith("VITE"),
    ),
  );
  if (vars.flag !== undefined) env[BOOKING_WIDGET_FLAG] = vars.flag;
  if (vars.tel !== undefined) env[STUDIO_TEL] = vars.tel;
  await promisify(execFile)(process.execPath, [astroCli, "build", "--outDir", outDir], {
    cwd: siteRoot,
    env,
  });
  return readFile(join(outDir, "reservation/index.html"), "utf8");
}

/** 予約ウィジェット（packages/booking-widget の BookingWidget をブラウザで描く島） */
function hasBookingWidget(html: string): boolean {
  return /<astro-island[^>]*component-export="BookingWidget"/.test(html);
}

/** Googleカレンダーの埋め込み */
function hasCalendarEmbed(html: string): boolean {
  return /<iframe[^>]*src="https:\/\/calendar\.google\.com\/calendar\/embed\?/.test(html);
}

/** form.run の予約フォーム */
function hasReservationForm(html: string): boolean {
  return html.includes("form.run/@studiozebra-1st-reservation");
}

/** 連絡先のうち、お問い合わせフォームと LINE */
function hasContacts(html: string): boolean {
  return (
    html.includes('href="https://form.run/@studiozebra-st-inquiry"') &&
    html.includes('href="https://line.me/R/ti/p/%40190bnuvc"')
  );
}

/** 電話番号の行（tel: のリンク） */
function hasTelRow(html: string): boolean {
  return html.includes('href="tel:');
}

const pages = new Map<string, string>();

// 組み立ては同じフォルダー（apps/site-zebra/.astro など）を使うので、1つずつ動かす
beforeAll(async () => {
  pages.set("なし", await buildReservationPage({ flag: undefined, tel: undefined }));
  pages.set("空・電話あり", await buildReservationPage({ flag: "", tel: FAKE_TEL }));
  pages.set("true", await buildReservationPage({ flag: "true", tel: undefined }));
  pages.set("true・電話あり", await buildReservationPage({ flag: "true", tel: FAKE_TEL }));
}, 240_000);

afterAll(async () => {
  await Promise.all(outDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("予約ページの予約ウィジェットの切り替え（組み立てた HTML）", () => {
  it("変数なし：今の仕組み（Googleカレンダーの埋め込みと予約フォーム）・連絡先・注意事項が入り、ウィジェットは入らない", () => {
    const html = pages.get("なし") ?? "";
    expect(hasCalendarEmbed(html)).toBe(true);
    expect(hasReservationForm(html)).toBe(true);
    expect(hasContacts(html)).toBe(true);
    expect(html).toContain("ご予約についての注意事項");
    expect(hasBookingWidget(html)).toBe(false);
  });

  it("空：今の仕組みと連絡先が入り、ウィジェットは入らない", () => {
    const html = pages.get("空・電話あり") ?? "";
    expect(hasCalendarEmbed(html)).toBe(true);
    expect(hasReservationForm(html)).toBe(true);
    expect(hasContacts(html)).toBe(true);
    expect(hasBookingWidget(html)).toBe(false);
  });

  it("true：ウィジェットと連絡先が入り、Googleカレンダーの埋め込み・予約フォーム・注意事項は入らない", () => {
    const html = pages.get("true") ?? "";
    expect(hasBookingWidget(html)).toBe(true);
    expect(hasContacts(html)).toBe(true);
    expect(html).not.toContain("calendar.google.com");
    expect(hasReservationForm(html)).toBe(false);
    expect(html).not.toContain("ご予約についての注意事項");
  });

  it("true：連絡先はウィジェットの下", () => {
    const html = pages.get("true") ?? "";
    expect(html.indexOf("form.run/@studiozebra-st-inquiry")).toBeGreaterThan(
      html.indexOf("<astro-island"),
    );
  });
});

describe("予約ページの連絡先の電話番号（組み立てた HTML）", () => {
  it.each([
    ["今の仕組み", "なし"],
    ["ウィジェット", "true"],
  ])("%s・電話番号の変数なし：電話番号の行がない", (_, key) => {
    const html = pages.get(key) ?? "";
    expect(hasTelRow(html)).toBe(false);
    expect(html).not.toContain("（電話番号）");
  });

  it.each([
    ["今の仕組み", "空・電話あり"],
    ["ウィジェット", "true・電話あり"],
  ])(`%s・架空の値（${FAKE_TEL}）：その値が出る`, (_, key) => {
    const html = pages.get(key) ?? "";
    expect(html).toContain('href="tel:00000000000"');
    expect(html).toContain(FAKE_TEL);
  });
});
