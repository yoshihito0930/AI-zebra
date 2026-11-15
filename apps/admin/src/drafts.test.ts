import { Yen, type AdminReservationDraftList } from "@zebra/contracts";
import { describe, expect, it } from "vitest";
import { findOperationDraftIds, matchOperationDrafts } from "./drafts.ts";
import { fakeApi } from "./test-support.ts";

type Listed = AdminReservationDraftList["drafts"][number];

const listed = (draftId: string, kind: Listed["kind"], status: Listed["status"]): Listed => ({
  draftId,
  kind,
  status,
  createdAt: "2026-11-01T12:00:00.000+09:00",
  ...(status === "unsent" ? {} : { statusChangedAt: "2026-11-01T13:00:00.000+09:00" }),
});

describe("操作の返事の下書きを、開ける下書きに当てる", () => {
  it("あて先の予約の、同じ種類のいちばん新しい未送信の下書きを当てる（送信済み・送らないは当てない）", () => {
    const lists: Record<string, Listed[]> = {
      "res-1": [
        listed("d-old", "change", "unsent"),
        listed("d-sent", "change", "sent"),
        listed("d-new", "change", "unsent"),
        listed("d-approval", "approval", "sent"),
      ],
    };
    expect(
      matchOperationDrafts([{ kind: "change", reservationId: "res-1" }], (id) => lists[id]),
    ).toEqual(["d-new"]);
  });

  it("あて先の予約が違う下書きは、それぞれの予約の一覧から当てる", () => {
    const lists: Record<string, Listed[]> = {
      "res-firm-1": [listed("d-cancel", "cancellation", "unsent")],
      "res-second-1": [listed("d-bring", "bring-forward-notice", "unsent")],
    };
    expect(
      matchOperationDrafts(
        [
          {
            kind: "cancellation",
            reservationId: "res-firm-1",
            cancellationFee: { ratePercent: 50, fee: Yen.parse(5_500) },
          },
          { kind: "bring-forward-notice", reservationId: "res-second-1" },
        ],
        (id) => lists[id],
      ),
    ).toEqual(["d-cancel", "d-bring"]);
  });

  it("同じ予約に同じ種類を2つ作ったら、新しいほうの2つを作った順に当てる", () => {
    const lists: Record<string, Listed[]> = {
      "res-2": [
        listed("d-1", "move-up-notice", "unsent"),
        listed("d-2", "move-up-notice", "unsent"),
        listed("d-3", "move-up-notice", "unsent"),
      ],
    };
    const notice = {
      kind: "move-up-notice" as const,
      reservationId: "res-2",
      remainingProvisionalIds: [],
    };
    expect(matchOperationDrafts([notice, notice], (id) => lists[id])).toEqual(["d-2", "d-3"]);
  });

  it("当てる下書きがない・一覧を読めなかったときは、当てない", () => {
    const lists: Record<string, Listed[]> = {
      "res-1": [listed("d-sent", "rejection", "sent")],
    };
    expect(
      matchOperationDrafts(
        [
          { kind: "rejection", reservationId: "res-1" },
          { kind: "promotion", reservationId: "res-unknown" },
        ],
        (id) => lists[id],
      ),
    ).toEqual([undefined, undefined]);
  });

  it("あて先の予約ごとに1回だけ、予約の下書きの一覧を読む", async () => {
    const { api, calls } = fakeApi(({ url }) =>
      url === "/admin/reservations/res-1/drafts"
        ? { status: 200, body: { drafts: [listed("d-1", "cancellation", "unsent")] } }
        : { status: 404, body: { error: "not-found" } },
    );
    const ids = await findOperationDraftIds(api, [
      {
        kind: "cancellation",
        reservationId: "res-1",
        cancellationFee: { ratePercent: 0, fee: Yen.parse(0) },
      },
      { kind: "bring-forward-notice", reservationId: "res-2" },
    ]);
    expect(ids).toEqual(["d-1", undefined]);
    expect(calls.map((c) => c.url).sort()).toEqual([
      "/admin/reservations/res-1/drafts",
      "/admin/reservations/res-2/drafts",
    ]);
  });
});
