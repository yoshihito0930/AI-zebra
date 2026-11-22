import { describe, expect, it } from "vitest";
import { isBookingWidgetEnabled } from "./booking-widget-flag";

describe("予約ウィジェットの切り替え（PUBLIC_BOOKING_WIDGET_ENABLED）", () => {
  it("true ならウィジェットを出す", () => {
    expect(isBookingWidgetEnabled("true")).toBe(true);
  });

  it("ない・空・false なら今の仕組みを出す", () => {
    expect(isBookingWidgetEnabled(undefined)).toBe(false);
    expect(isBookingWidgetEnabled("")).toBe(false);
    expect(isBookingWidgetEnabled("false")).toBe(false);
  });

  it("それ以外の値（大文字、1、空白つき、打ち間違い）は組み立てを止める", () => {
    for (const value of ["TRUE", "True", "1", "yes", " true", "true ", "ture", "0"]) {
      expect(() => isBookingWidgetEnabled(value)).toThrow("PUBLIC_BOOKING_WIDGET_ENABLED");
    }
  });
});
