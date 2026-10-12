import { describe, expect, it } from "vitest";
import { app } from "./app.ts";

describe("ヘルスチェック", () => {
  it("GET /health は 200 と { status: 'ok' } だけを返す", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
