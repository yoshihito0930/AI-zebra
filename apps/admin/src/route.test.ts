import { describe, expect, it } from "vitest";
import { detailHref, draftHref, draftsHref, parseRoute } from "./route.ts";

describe("画面の切り替え（ハッシュ）", () => {
  it("未送信の下書きの一覧", () => {
    expect(draftsHref()).toBe("#/drafts");
    expect(parseRoute(draftsHref())).toEqual({ page: "drafts" });
  });

  it("下書きを開く：予約の id と下書きの id をパスに入れ、読み戻せる", () => {
    const href = draftHref("res/1", "20261030T001500000Z-0001");
    expect(href).toBe("#/reservations/res%2F1/drafts/20261030T001500000Z-0001");
    expect(parseRoute(href)).toEqual({
      page: "draft",
      reservationId: "res/1",
      draftId: "20261030T001500000Z-0001",
    });
  });

  it("予約の詳細と、知らないハッシュ（一覧）は今までどおり", () => {
    expect(parseRoute(detailHref("res-1"))).toEqual({ page: "detail", reservationId: "res-1" });
    expect(parseRoute("#/reservations/res-1/drafts")).toEqual({ page: "list" });
    expect(parseRoute("")).toEqual({ page: "list" });
  });
});
