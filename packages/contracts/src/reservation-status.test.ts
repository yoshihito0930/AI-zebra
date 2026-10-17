import { describe, expect, it } from "vitest";
import { ReservationStatus } from "./reservation-status";

describe("予約の状態", () => {
  it("仕様の状態は8つ（承認待ちは仮・本・第二キープの3つ）", () => {
    expect(ReservationStatus.options).toEqual([
      "pending-provisional",
      "pending-firm",
      "pending-second-hold",
      "provisional",
      "firm",
      "second-hold",
      "cancelled",
      "ended",
    ]);
  });

  it.each(["pending", "confirmed", "rejected", ""])("仕様にない状態 %j は通さない", (value) => {
    expect(ReservationStatus.safeParse(value).success).toBe(false);
  });
});
