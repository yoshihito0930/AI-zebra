import { describe, expect, it } from "vitest";
import { PublicCalendar } from "./public-calendar";

const booking = {
  label: "provisional",
  start: "2026-10-20T09:00:00+09:00",
  end: "2026-10-20T12:00:00+09:00",
};
const calendar = (bookings: unknown[]) => ({ days: [{ date: "2026-10-20", bookings }] });

describe("公開APIの予約状況（INV-3）", () => {
  it("表示名と時間だけの予約状況は通す", () => {
    const value = calendar([
      booking,
      { label: "firm", start: "2026-10-20T05:00:00Z", end: "2026-10-20T08:00:00Z" },
      {
        label: "second-hold",
        start: "2026-10-20T10:00:00+09:00",
        end: "2026-10-20T13:00:00+09:00",
      },
      {
        label: "unavailable",
        start: "2026-10-20T18:00:00+09:00",
        end: "2026-10-20T22:00:00+09:00",
      },
    ]);
    expect(PublicCalendar.safeParse(value).success).toBe(true);
  });

  it.each([
    ["予約の id", { ...booking, id: "r-1" }],
    ["状態", { ...booking, status: "pending-provisional" }],
    ["お客様の氏名", { ...booking, name: "山田 太郎" }],
    ["金額", { ...booking, amount: 11_000 }],
    ["ブロック枠の理由", { ...booking, label: "unavailable", reason: "休業" }],
  ])("%s を含む予約状況は通さない", (_, value) => {
    expect(PublicCalendar.safeParse(calendar([value])).success).toBe(false);
  });

  it.each(["pending-provisional", "cancelled", "仮予約", ""])("表示名 %j は通さない", (label) => {
    expect(PublicCalendar.safeParse(calendar([{ ...booking, label }])).success).toBe(false);
  });

  it("日の余計なキーも通さない", () => {
    const value = { days: [{ date: "2026-10-20", bookings: [], note: "x" }] };
    expect(PublicCalendar.safeParse(value).success).toBe(false);
  });
});
