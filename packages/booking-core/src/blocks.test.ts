import { ReservationStatus } from "@zebra/contracts";
import fc from "fast-check";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  type BufferMinutes,
  type ExistingBlock,
  type ExistingReservation,
  type ReservationBufferMinutes,
  type TimeRange,
  checkAvailability,
  occupiedRange,
} from "./availability";
import { type AdminBlockResult, blockFromCalendarEvent, checkAdminBlock } from "./blocks";

// ブロック枠の判定と変換は現在時刻を使わない（日時はすべて引数で渡す。INV-7）

// 仕様の日時は JST で書かれている（INV-7）。例の表には年がないので 2026 年とし、日付のない行は 10/20 とする。
// 例の各行は、JST で表した日時と、同じ時点を UTC で表した日時の両方で確かめる（docs/TESTING.md「仕様の例とテストの対応づけ」）
const zones = ["Asia/Tokyo", "UTC"] as const;
type Zone = (typeof zones)[number];

function at(iso: string, zone: Zone): DateTime {
  const dateTime = DateTime.fromISO(iso, { zone: "Asia/Tokyo" });
  if (!dateTime.isValid) {
    throw new Error(`テストの日時が不正：${iso}`);
  }
  return dateTime.setZone(zone);
}

// 区間が、JST で書いた [start, end) と同じ時点かを確かめる（ゾーンの表し方は問わない）
function expectRange(range: TimeRange, start: string, end: string, message: string): void {
  expect(range.start.toUTC().toISO(), message).toBe(at(start, "UTC").toISO());
  expect(range.end.toUTC().toISO(), message).toBe(at(end, "UTC").toISO());
}

// 入れられるはずのブロック枠。不可なら、理由を出してテストを落とす
function expectOk(result: AdminBlockResult, message: string): TimeRange {
  if (!result.ok) {
    throw new Error(`${message}：入るはずが不可になった（${result.reason}）`);
  }
  return result.occupied;
}

// Googleカレンダーの予定から作ったブロック枠が、予定の時刻のままで、バッファが1時間かを確かめる
function expectCalendarBlock(block: ExistingBlock, start: string, end: string, zone: Zone): void {
  expect(block.start.toMillis(), zone).toBe(at(start, zone).toMillis());
  expect(block.end.toMillis(), zone).toBe(at(end, zone).toMillis());
  expect(block.bufferMinutes, zone).toBe(60);
}

// 管理者のブロック枠のバッファは、例の行に書かれていなければ初期値の「なし」（0）とする（「ブロック枠のバッファ」）
// 直接入れる予約の行（「直接入れる予約のルール」）は direct-entry.test.ts にある
describe("管理者による予約の直接入力とブロック枠", () => {
  it("Googleカレンダーの予定 10/20 10:00–12:00 を取り込む：ブロック枠。占有区間は 10:00–13:00", () => {
    for (const zone of zones) {
      const block = blockFromCalendarEvent({
        start: at("2026-10-20T10:00", zone),
        end: at("2026-10-20T12:00", zone),
      });
      expectCalendarBlock(block, "2026-10-20T10:00", "2026-10-20T12:00", zone);
      expectRange(
        occupiedRange(block, block.bufferMinutes),
        "2026-10-20T10:00",
        "2026-10-20T13:00",
        zone,
      );
    }
  });

  // ウィジェットからの申込の判定は、空き判定（checkAvailability）。申込のバッファは1時間
  function applyWithCalendarBlock(zone: Zone, start: string, end: string) {
    const block = blockFromCalendarEvent({
      start: at("2026-10-20T10:00", zone),
      end: at("2026-10-20T12:00", zone),
    });
    return checkAvailability({
      start: at(start, zone),
      end: at(end, zone),
      bufferMinutes: 60,
      reservations: [],
      blocks: [block],
    });
  }

  it("上のブロック枠があるときに、ウィジェットから 10/20 12:00–14:00 を申込む：不可（12:00–13:00が重なる）", () => {
    for (const zone of zones) {
      expect(applyWithCalendarBlock(zone, "2026-10-20T12:00", "2026-10-20T14:00"), zone).toEqual({
        ok: false,
        reason: "overlaps-existing",
      });
    }
  });

  it("同じく、ウィジェットから 10/20 13:00–15:00 を申込む：予約可（13:00で接するだけ）", () => {
    for (const zone of zones) {
      expect(applyWithCalendarBlock(zone, "2026-10-20T13:00", "2026-10-20T15:00"), zone).toEqual({
        ok: true,
      });
    }
  });

  it("管理者が休業のブロック枠 10/20 00:00–10/21 00:00 をバッファなしで入れる：占有区間は 10/20 00:00–10/21 00:00。10/21 00:00–04:00 の申込は予約可", () => {
    for (const zone of zones) {
      const occupied = expectOk(
        checkAdminBlock({
          start: at("2026-10-20T00:00", zone),
          end: at("2026-10-21T00:00", zone),
          bufferMinutes: 0,
          reservations: [],
          blocks: [],
        }),
        zone,
      );
      expectRange(occupied, "2026-10-20T00:00", "2026-10-21T00:00", zone);

      const closed: ExistingBlock = {
        start: at("2026-10-20T00:00", zone),
        end: at("2026-10-21T00:00", zone),
        bufferMinutes: 0,
      };
      expect(
        checkAvailability({
          start: at("2026-10-21T00:00", zone),
          end: at("2026-10-21T04:00", zone),
          bufferMinutes: 60,
          reservations: [],
          blocks: [closed],
        }),
        zone,
      ).toEqual({ ok: true });
    }
  });

  it("管理者が清掃のブロック枠 15:00–16:00 をバッファ30分で入れる：占有区間は 15:00–16:30", () => {
    for (const zone of zones) {
      const occupied = expectOk(
        checkAdminBlock({
          start: at("2026-10-20T15:00", zone),
          end: at("2026-10-20T16:00", zone),
          bufferMinutes: 30,
          reservations: [],
          blocks: [],
        }),
        zone,
      );
      expectRange(occupied, "2026-10-20T15:00", "2026-10-20T16:30", zone);
    }
  });

  it("管理者が清掃のブロック枠 15:15–16:00 を入れる：不可（30分単位でない）", () => {
    for (const zone of zones) {
      expect(
        checkAdminBlock({
          start: at("2026-10-20T15:15", zone),
          end: at("2026-10-20T16:00", zone),
          bufferMinutes: 0,
          reservations: [],
          blocks: [],
        }),
        zone,
      ).toEqual({ ok: false, reason: "not-on-30-minute-boundary" });
    }
  });

  it("管理者が休業のブロック枠 10/20 00:00–10/23 00:00 をバッファなしで入れる：入る（ブロック枠に最長はない）。占有区間は 10/20 00:00–10/23 00:00", () => {
    for (const zone of zones) {
      const occupied = expectOk(
        checkAdminBlock({
          start: at("2026-10-20T00:00", zone),
          end: at("2026-10-23T00:00", zone),
          bufferMinutes: 0,
          reservations: [],
          blocks: [],
        }),
        zone,
      );
      expectRange(occupied, "2026-10-20T00:00", "2026-10-23T00:00", zone);
    }
  });

  // 既存の本予約は 10/20 10:00–12:00（バッファ1時間。占有区間 10:00–13:00）、ブロック枠は 10/20 11:00–12:00 とする
  it("管理者が、既存の本予約と重なるブロック枠を入れる：不可（空き判定）", () => {
    for (const zone of zones) {
      const firm: ExistingReservation = {
        id: "A",
        status: "firm",
        start: at("2026-10-20T10:00", zone),
        end: at("2026-10-20T12:00", zone),
        bufferMinutes: 60,
      };
      expect(
        checkAdminBlock({
          start: at("2026-10-20T11:00", zone),
          end: at("2026-10-20T12:00", zone),
          bufferMinutes: 0,
          reservations: [firm],
          blocks: [],
        }),
        zone,
      ).toEqual({ ok: false, reason: "overlaps-existing" });
    }
  });

  it("Googleカレンダーの予定 10/20 10:15–11:45 を取り込む：ブロック枠（30分単位でなくてよい）。占有区間は 10:15–12:45", () => {
    for (const zone of zones) {
      const block = blockFromCalendarEvent({
        start: at("2026-10-20T10:15", zone),
        end: at("2026-10-20T11:45", zone),
      });
      expectCalendarBlock(block, "2026-10-20T10:15", "2026-10-20T11:45", zone);
      expectRange(
        occupiedRange(block, block.bufferMinutes),
        "2026-10-20T10:15",
        "2026-10-20T12:45",
        zone,
      );
    }
  });

  describe("プロパティ（INV-1・INV-7。どの入力でも成り立つこと）", () => {
    // 時刻は 10/20 00:00（JST）からの分の数で作る
    const base = DateTime.fromISO("2026-10-20T00:00", { zone: "Asia/Tokyo" });
    const slot = fc.integer({ min: 0, max: 48 * 4 });
    const anyZone = fc.constantFrom(...zones);

    interface Shape {
      startMinutes: number;
      endMinutes: number;
      bufferMinutes: BufferMinutes;
    }
    interface Item {
      shape: Shape;
      status: ReservationStatus;
    }

    // 「予約の状態」の節の表：占有区間の枠を確保する状態
    const holdingStatuses = [
      "pending-provisional",
      "pending-firm",
      "pending-second-hold",
      "provisional",
      "firm",
      "second-hold",
    ] as const satisfies readonly ReservationStatus[];
    function isHolding(status: ReservationStatus): boolean {
      return (holdingStatuses as readonly ReservationStatus[]).includes(status);
    }

    // 既存の予約：開始・終了は30分単位、長さは30分〜24時間（直接入力では2時間未満もある）。バッファは1時間か30分
    const reservationShape = fc
      .record({
        startSlot: slot,
        lengthSlots: fc.integer({ min: 1, max: 48 }),
        bufferMinutes: fc.constantFrom<ReservationBufferMinutes>(30, 60),
      })
      .map(({ startSlot, lengthSlots, bufferMinutes }): Shape => ({
        startMinutes: startSlot * 30,
        endMinutes: (startSlot + lengthSlots) * 30,
        bufferMinutes,
      }));

    // 管理者のブロック枠：開始・終了は30分単位、長さは30分〜6日（最短・最長はない）。バッファは「なし／30分／1時間」
    const blockShape = fc
      .record({
        startSlot: slot,
        lengthSlots: fc.integer({ min: 1, max: 48 * 6 }),
        bufferMinutes: fc.constantFrom<BufferMinutes>(0, 30, 60),
      })
      .map(({ startSlot, lengthSlots, bufferMinutes }): Shape => ({
        startMinutes: startSlot * 30,
        endMinutes: (startSlot + lengthSlots) * 30,
        bufferMinutes,
      }));

    function toDateTime(minutes: number, z: Zone): DateTime {
      return base.plus({ minutes }).setZone(z);
    }

    // テストの側で、分の数で占有区間 [start, end + バッファ) を求めて、半開区間の重なりを判定する
    function occupiedOverlaps(a: Shape, b: Shape): boolean {
      return (
        a.startMinutes < b.endMinutes + b.bufferMinutes &&
        b.startMinutes < a.endMinutes + a.bufferMinutes
      );
    }

    function check(block: Shape, list: readonly Item[], blocks: readonly Shape[], z: Zone) {
      return checkAdminBlock({
        start: toDateTime(block.startMinutes, z),
        end: toDateTime(block.endMinutes, z),
        bufferMinutes: block.bufferMinutes,
        reservations: list.map(({ shape, status }, index) => ({
          id: `r${index}`,
          status,
          start: toDateTime(shape.startMinutes, z),
          end: toDateTime(shape.endMinutes, z),
          bufferMinutes: shape.bufferMinutes as ReservationBufferMinutes,
        })),
        blocks: blocks.map((shape) => ({
          start: toDateTime(shape.startMinutes, z),
          end: toDateTime(shape.endMinutes, z),
          bufferMinutes: shape.bufferMinutes,
        })),
      });
    }

    it("管理者のブロック枠は、占有区間 [start, end + バッファ) が、枠を確保している予約（承認済みの仮予約と第二キープを含む）とほかのブロック枠のどれとも重ならなければ、長さによらず入る。重なれば不可（空き判定）。同じ時点を UTC で渡しても同じ結果", () => {
      const items = fc.array(
        fc.record({
          shape: reservationShape,
          status: fc.constantFrom(...ReservationStatus.options),
        }),
        { maxLength: 6 },
      );
      fc.assert(
        fc.property(
          blockShape,
          items,
          fc.array(blockShape, { maxLength: 3 }),
          anyZone,
          (block, list, blocks, z) => {
            const overlaps =
              list.some(
                ({ shape, status }) => isHolding(status) && occupiedOverlaps(block, shape),
              ) || blocks.some((other) => occupiedOverlaps(block, other));
            const result = check(block, list, blocks, z);
            if (overlaps) {
              expect(result).toEqual({ ok: false, reason: "overlaps-existing" });
            } else {
              const occupied = expectOk(result, z);
              expect(occupied.start.toMillis()).toBe(
                base.plus({ minutes: block.startMinutes }).toMillis(),
              );
              expect(occupied.end.toMillis()).toBe(
                base.plus({ minutes: block.endMinutes + block.bufferMinutes }).toMillis(),
              );
            }
          },
        ),
      );
    });

    // 既存の予約・ブロック枠がないので、不可の理由はこれだけ。JST と UTC の時差は整数の時間なので、
    // 30分単位かどうかは、どちらのゾーンで表しても同じ
    it("管理者のブロック枠は、開始か終了が30分単位でなければ不可。同じ時点を UTC で渡しても同じ結果", () => {
      const offGridShape = fc
        .record({
          startMinutes: fc.integer({ min: 0, max: 60 * 24 * 4 }),
          lengthMinutes: fc.integer({ min: 1, max: 60 * 24 * 6 }),
          bufferMinutes: fc.constantFrom<BufferMinutes>(0, 30, 60),
        })
        .map(({ startMinutes, lengthMinutes, bufferMinutes }): Shape => ({
          startMinutes,
          endMinutes: startMinutes + lengthMinutes,
          bufferMinutes,
        }))
        .filter((shape) => shape.startMinutes % 30 !== 0 || shape.endMinutes % 30 !== 0);
      fc.assert(
        fc.property(offGridShape, anyZone, (block, z) => {
          expect(check(block, [], [], z)).toEqual({
            ok: false,
            reason: "not-on-30-minute-boundary",
          });
        }),
      );
    });

    it("Googleカレンダーの予定から作るブロック枠は、30分単位でなくても予定の時刻のまま、バッファは1時間。占有区間は [start, end + 1時間)。同じ時点を UTC で渡しても同じ結果", () => {
      const event = fc.record({
        startMinutes: fc.integer({ min: 0, max: 60 * 24 * 4 }),
        lengthMinutes: fc.integer({ min: 1, max: 60 * 24 * 3 }),
      });
      fc.assert(
        fc.property(event, anyZone, ({ startMinutes, lengthMinutes }, z) => {
          const start = toDateTime(startMinutes, z);
          const end = toDateTime(startMinutes + lengthMinutes, z);
          const block = blockFromCalendarEvent({ start, end });
          expect(block.start.toMillis()).toBe(start.toMillis());
          expect(block.end.toMillis()).toBe(end.toMillis());
          expect(block.bufferMinutes).toBe(60);
          const occupied = occupiedRange(block, block.bufferMinutes);
          expect(occupied.start.toMillis()).toBe(start.toMillis());
          expect(occupied.end.toMillis()).toBe(end.plus({ hours: 1 }).toMillis());
        }),
      );
    });
  });
});
