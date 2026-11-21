// 予約ページ（src/pages/reservation/index.astro）を、切り替えの環境変数（PUBLIC_BOOKING_WIDGET_ENABLED）を変えて実際に組み立て（astro build）、
// 生成された HTML に予約ウィジェットと今の仕組みのどちらが入るかを確かめる。
// ページのテストはここに置く（src/pages の下の .ts はページ〈エンドポイント〉として組み立てられるため）
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOOKING_WIDGET_FLAG } from "./booking-widget-flag";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));
const astroCli = join(siteRoot, "node_modules/astro/bin/astro.mjs");

const outDirs: string[] = [];

/** 切り替えの値（undefined は変数なし）で HP を組み立て、予約ページの HTML を返す */
async function buildReservationPage(flag: string | undefined): Promise<string> {
  const outDir = await mkdtemp(join(tmpdir(), "zebra-site-build-"));
  outDirs.push(outDir);
  // Vitest が足す変数（NODE_ENV=test など）と、手元で付けた切り替えの変数を外し、pnpm build と同じ条件で組み立てる
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== BOOKING_WIDGET_FLAG && key !== "NODE_ENV" && !key.startsWith("VITE"),
    ),
  );
  if (flag !== undefined) env[BOOKING_WIDGET_FLAG] = flag;
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

/** 今の仕組み（Googleカレンダーの埋め込みと、form.run の予約フォーム） */
function hasLegacyReservation(html: string): boolean {
  return (
    /<iframe[^>]*src="https:\/\/calendar\.google\.com\/calendar\/embed\?/.test(html) &&
    html.includes('href="https://form.run/@studiozebra-1st-reservation"')
  );
}

describe("予約ページの予約ウィジェットの切り替え（組み立てた HTML）", () => {
  const pages = new Map<string, string>();

  // 組み立ては同じフォルダー（apps/site-zebra/.astro など）を使うので、1つずつ動かす
  beforeAll(async () => {
    pages.set("なし", await buildReservationPage(undefined));
    pages.set("空", await buildReservationPage(""));
    pages.set("true", await buildReservationPage("true"));
  }, 180_000);

  afterAll(async () => {
    await Promise.all(outDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("変数なし：今の仕組みが入り、ウィジェットは入らない", () => {
    const html = pages.get("なし") ?? "";
    expect(hasLegacyReservation(html)).toBe(true);
    expect(hasBookingWidget(html)).toBe(false);
  });

  it("空：今の仕組みが入り、ウィジェットは入らない", () => {
    const html = pages.get("空") ?? "";
    expect(hasLegacyReservation(html)).toBe(true);
    expect(hasBookingWidget(html)).toBe(false);
  });

  it("true：ウィジェットが入り、今の仕組みは入らない", () => {
    const html = pages.get("true") ?? "";
    expect(hasBookingWidget(html)).toBe(true);
    expect(html).not.toContain("calendar.google.com");
    expect(html).not.toContain("form.run");
  });
});
