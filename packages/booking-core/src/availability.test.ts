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
  checkBufferChange,
  occupiedRange,
} from "./availability";

// 空き判定の関数は現在時刻を使わない（日時はすべて引数で渡す。INV-7）

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
function expectRange(range: TimeRange, start: string, end: string): void {
  expect(range.start.toUTC().toISO()).toBe(at(start, "UTC").toISO());
  expect(range.end.toUTC().toISO()).toBe(at(end, "UTC").toISO());
}

function reservation(
  zone: Zone,
  fields: {
    id: string;
    status: ReservationStatus;
    start: string;
    end: string;
    bufferMinutes: ReservationBufferMinutes;
  },
): ExistingReservation {
  return { ...fields, start: at(fields.start, zone), end: at(fields.end, zone) };
}

// 「予約の状態」の節の表：占有区間の枠を確保する状態と、しない状態
const holdingStatuses = [
  "pending-provisional",
  "pending-firm",
  "pending-second-hold",
  "provisional",
  "firm",
  "second-hold",
] as const satisfies readonly ReservationStatus[];
const releasedStatuses = ["cancelled", "ended"] as const satisfies readonly ReservationStatus[];

// プロパティテストの入力。時刻は 10/20 00:00（JST）からの30分単位の枠で作る（10/20〜10/24 の範囲）
const base = DateTime.fromISO("2026-10-20T00:00", { zone: "Asia/Tokyo" });
const slot = fc.integer({ min: 0, max: 48 * 4 });
const anyZone = fc.constantFrom(...zones);

interface Shape {
  startMinutes: number;
  endMinutes: number;
  bufferMinutes: BufferMinutes;
}

// 予約区間：開始・終了は30分単位、長さは2〜24時間。バッファは1時間か30分
const reservationShape = fc
  .record({
    startSlot: slot,
    lengthSlots: fc.integer({ min: 4, max: 48 }),
    bufferMinutes: fc.constantFrom<ReservationBufferMinutes>(30, 60),
  })
  .map(({ startSlot, lengthSlots, bufferMinutes }) => ({
    startMinutes: startSlot * 30,
    endMinutes: (startSlot + lengthSlots) * 30,
    bufferMinutes,
  }));

// ブロック枠：開始・終了は30分単位、長さは30分〜24時間。バッファは「なし／30分／1時間」
const blockShape = fc
  .record({
    startSlot: slot,
    lengthSlots: fc.integer({ min: 1, max: 48 }),
    bufferMinutes: fc.constantFrom<BufferMinutes>(0, 30, 60),
  })
  .map(({ startSlot, lengthSlots, bufferMinutes }) => ({
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

function isHolding(status: ReservationStatus): boolean {
  return (holdingStatuses as readonly ReservationStatus[]).includes(status);
}

describe("空き判定", () => {
  describe("以下、バッファはすべて1時間とする。既存の本予約が 09:00–12:00 の場合、占有区間は 09:00–13:00。既存の予約が承認待ち・仮予約・第二キープでも、結果は同じ。", () => {
    function expectRow(
      start: string,
      end: string,
      occupiedEnd: string,
      expected: ReturnType<typeof checkAvailability>,
    ): void {
      for (const zone of zones) {
        for (const status of holdingStatuses) {
          const existing = reservation(zone, {
            id: "A",
            status,
            start: "2026-10-20T09:00",
            end: "2026-10-20T12:00",
            bufferMinutes: 60,
          });
          expectRange(occupiedRange(existing, 60), "2026-10-20T09:00", "2026-10-20T13:00");

          const applied = { start: at(start, zone), end: at(end, zone) };
          expectRange(occupiedRange(applied, 60), start, occupiedEnd);

          expect(
            checkAvailability({
              ...applied,
              bufferMinutes: 60,
              reservations: [existing],
              blocks: [],
            }),
            `${zone}、既存の予約の状態 ${status}`,
          ).toEqual(expected);
        }
      }
    }

    it("13:00–15:00（申込の占有区間 13:00–16:00）：予約可（13:00で接するだけ。間は1時間）", () => {
      expectRow("2026-10-20T13:00", "2026-10-20T15:00", "2026-10-20T16:00", { ok: true });
    });

    it("12:30–14:30（申込の占有区間 12:30–15:30）：予約不可（12:30–13:00が重なる）", () => {
      expectRow("2026-10-20T12:30", "2026-10-20T14:30", "2026-10-20T15:30", {
        ok: false,
        reason: "overlaps-existing",
      });
    });

    it("04:00–08:00（申込の占有区間 04:00–09:00）：予約可（09:00で接するだけ）", () => {
      expectRow("2026-10-20T04:00", "2026-10-20T08:00", "2026-10-20T09:00", { ok: true });
    });

    it("04:30–08:30（申込の占有区間 04:30–09:30）：予約不可（09:00–09:30が重なる）", () => {
      expectRow("2026-10-20T04:30", "2026-10-20T08:30", "2026-10-20T09:30", {
        ok: false,
        reason: "overlaps-existing",
      });
    });

    it("05:00–09:00（申込の占有区間 05:00–10:00）：予約不可（09:00–10:00が重なる）", () => {
      expectRow("2026-10-20T05:00", "2026-10-20T09:00", "2026-10-20T10:00", {
        ok: false,
        reason: "overlaps-existing",
      });
    });
  });

  describe("日付をまたぐ場合：既存の本予約が 10/20 22:00–10/21 02:00 なら、占有区間は 10/20 22:00–10/21 03:00。", () => {
    function expectRow(
      start: string,
      end: string,
      expected: ReturnType<typeof checkAvailability>,
    ): void {
      for (const zone of zones) {
        const existing = reservation(zone, {
          id: "A",
          status: "firm",
          start: "2026-10-20T22:00",
          end: "2026-10-21T02:00",
          bufferMinutes: 60,
        });
        expectRange(occupiedRange(existing, 60), "2026-10-20T22:00", "2026-10-21T03:00");

        const result = checkAvailability({
          start: at(start, zone),
          end: at(end, zone),
          bufferMinutes: 60,
          reservations: [existing],
          blocks: [],
        });
        expect(result, zone).toEqual(expected);
      }
    }

    it("10/21 03:00–07:00：予約可", () => {
      expectRow("2026-10-21T03:00", "2026-10-21T07:00", { ok: true });
    });

    it("10/21 02:30–06:30：予約不可（02:30–03:00が重なる）", () => {
      expectRow("2026-10-21T02:30", "2026-10-21T06:30", {
        ok: false,
        reason: "overlaps-existing",
      });
    });

    it("10/20 18:00–21:00：予約可（占有区間 18:00–22:00。22:00で接するだけ）", () => {
      for (const zone of zones) {
        const applied = { start: at("2026-10-20T18:00", zone), end: at("2026-10-20T21:00", zone) };
        expectRange(occupiedRange(applied, 60), "2026-10-20T18:00", "2026-10-20T22:00");
      }
      expectRow("2026-10-20T18:00", "2026-10-20T21:00", { ok: true });
    });

    it("10/20 18:00–21:30：予約不可（22:00–22:30が重なる）", () => {
      expectRow("2026-10-20T18:00", "2026-10-20T21:30", {
        ok: false,
        reason: "overlaps-existing",
      });
    });
  });

  describe("プロパティ（INV-1。どの入力でも成り立つこと）", () => {
    it("「予約の状態」の表は、すべての状態を、枠を確保するかしないかに分けている", () => {
      expect([...holdingStatuses, ...releasedStatuses].sort()).toEqual(
        [...ReservationStatus.options].sort(),
      );
    });

    const anyStatus = fc.constantFrom(...ReservationStatus.options);
    const existingShapes = fc.array(fc.record({ shape: reservationShape, status: anyStatus }), {
      maxLength: 6,
    });
    const blockShapes = fc.array(blockShape, { maxLength: 3 });

    function toReservations(
      items: readonly { shape: Shape; status: ReservationStatus }[],
      z: Zone,
    ): ExistingReservation[] {
      return items.map(({ shape, status }, index) => ({
        id: `r${index}`,
        status,
        start: toDateTime(shape.startMinutes, z),
        end: toDateTime(shape.endMinutes, z),
        bufferMinutes: shape.bufferMinutes as ReservationBufferMinutes,
      }));
    }

    function toBlocks(shapes: readonly Shape[], z: Zone): ExistingBlock[] {
      return shapes.map((shape) => ({
        start: toDateTime(shape.startMinutes, z),
        end: toDateTime(shape.endMinutes, z),
        bufferMinutes: shape.bufferMinutes,
      }));
    }

    function check(
      applied: Shape,
      items: readonly { shape: Shape; status: ReservationStatus }[],
      blocks: readonly Shape[],
      z: Zone,
    ) {
      return checkAvailability({
        start: toDateTime(applied.startMinutes, z),
        end: toDateTime(applied.endMinutes, z),
        bufferMinutes: applied.bufferMinutes as ReservationBufferMinutes,
        reservations: toReservations(items, z),
        blocks: toBlocks(blocks, z),
      });
    }

    it("占有区間は [start, end + バッファ)", () => {
      fc.assert(
        fc.property(blockShape, anyZone, (shape, z) => {
          const range = occupiedRange(
            { start: toDateTime(shape.startMinutes, z), end: toDateTime(shape.endMinutes, z) },
            shape.bufferMinutes,
          );
          expect(range.start.toMillis()).toBe(
            base.plus({ minutes: shape.startMinutes }).toMillis(),
          );
          expect(range.end.toMillis()).toBe(
            base.plus({ minutes: shape.endMinutes + shape.bufferMinutes }).toMillis(),
          );
        }),
      );
    });

    it("予約可になるのは、申込の占有区間が、枠を確保している予約とブロック枠のどの占有区間とも重ならないときだけ", () => {
      fc.assert(
        fc.property(
          reservationShape,
          existingShapes,
          blockShapes,
          anyZone,
          (applied, items, blocks, z) => {
            const overlaps =
              items.some(
                ({ shape, status }) => isHolding(status) && occupiedOverlaps(applied, shape),
              ) || blocks.some((block) => occupiedOverlaps(applied, block));
            const expected = overlaps ? { ok: false, reason: "overlaps-existing" } : { ok: true };
            expect(check(applied, items, blocks, z)).toEqual(expected);
          },
        ),
      );
    });

    it("取消・終了の予約は枠を確保しない（足しても結果は変わらない）", () => {
      const released = fc.array(
        fc.record({ shape: reservationShape, status: fc.constantFrom(...releasedStatuses) }),
        { minLength: 1, maxLength: 4 },
      );
      fc.assert(
        fc.property(
          reservationShape,
          existingShapes,
          released,
          blockShapes,
          anyZone,
          (applied, items, releasedItems, blocks, z) => {
            expect(check(applied, [...items, ...releasedItems], blocks, z)).toEqual(
              check(applied, items, blocks, z),
            );
          },
        ),
      );
    });

    it("占有区間が接するだけなら予約可。30分でも食い込めば予約不可", () => {
      const existingStatus = fc.constantFrom(...holdingStatuses);
      const middle = fc.integer({ min: 48 * 2, max: 48 * 3 });
      fc.assert(
        fc.property(
          reservationShape,
          reservationShape,
          existingStatus,
          middle,
          fc.boolean(),
          anyZone,
          (existingSize, appliedSize, status, startSlot, after, z) => {
            const length = existingSize.endMinutes - existingSize.startMinutes;
            const existing: Shape = {
              startMinutes: startSlot * 30,
              endMinutes: startSlot * 30 + length,
              bufferMinutes: existingSize.bufferMinutes,
            };
            const appliedLength = appliedSize.endMinutes - appliedSize.startMinutes;
            // after：既存の占有区間の終わりに、申込の開始が接する。そうでなければ、申込の占有区間の終わりが、既存の開始に接する
            const appliedStart = after
              ? existing.endMinutes + existing.bufferMinutes
              : existing.startMinutes - appliedSize.bufferMinutes - appliedLength;
            const touching: Shape = {
              startMinutes: appliedStart,
              endMinutes: appliedStart + appliedLength,
              bufferMinutes: appliedSize.bufferMinutes,
            };
            const shift = after ? -30 : 30;
            const intruding: Shape = {
              startMinutes: touching.startMinutes + shift,
              endMinutes: touching.endMinutes + shift,
              bufferMinutes: touching.bufferMinutes,
            };
            const items = [{ shape: existing, status }];
            expect(check(touching, items, [], z)).toEqual({ ok: true });
            expect(check(intruding, items, [], z)).toEqual({
              ok: false,
              reason: "overlaps-existing",
            });
            // ブロック枠でも同じ
            expect(check(touching, [], [existing], z)).toEqual({ ok: true });
            expect(check(intruding, [], [existing], z)).toEqual({
              ok: false,
              reason: "overlaps-existing",
            });
          },
        ),
      );
    });

    it("バッファがすべて1時間なら、予約可の申込と、枠を確保している予約の間は1時間以上空く", () => {
      const oneHour = (shape: Shape): Shape => ({ ...shape, bufferMinutes: 60 });
      fc.assert(
        fc.property(reservationShape, existingShapes, anyZone, (appliedShape, itemShapes, z) => {
          const applied = oneHour(appliedShape);
          const items = itemShapes.map(({ shape, status }) => ({ shape: oneHour(shape), status }));
          fc.pre(check(applied, items, [], z).ok);
          for (const { shape, status } of items) {
            if (!isHolding(status)) continue;
            const gapAfter = applied.startMinutes - shape.endMinutes;
            const gapBefore = shape.startMinutes - applied.endMinutes;
            expect(gapAfter >= 60 || gapBefore >= 60).toBe(true);
          }
        }),
      );
    });
  });
});

describe("バッファを30分に縮める", () => {
  function reservationA(zone: Zone, bufferMinutes: ReservationBufferMinutes): ExistingReservation {
    return reservation(zone, {
      id: "A",
      status: "firm",
      start: "2026-10-20T09:00",
      end: "2026-10-20T12:00",
      bufferMinutes,
    });
  }

  it("本予約 A 09:00–12:00、バッファ1時間（占有区間 09:00–13:00）、申込 12:30–14:30：不可（12:30–13:00が重なる）", () => {
    for (const zone of zones) {
      const a = reservationA(zone, 60);
      expectRange(occupiedRange(a, 60), "2026-10-20T09:00", "2026-10-20T13:00");
      expect(
        checkAvailability({
          start: at("2026-10-20T12:30", zone),
          end: at("2026-10-20T14:30", zone),
          bufferMinutes: 60,
          reservations: [a],
          blocks: [],
        }),
        zone,
      ).toEqual({ ok: false, reason: "overlaps-existing" });
    }
  });

  it("本予約 A 09:00–12:00、バッファ1時間（同上）、管理者が A のバッファを30分にする：成功。占有区間は 09:00–12:30 になる", () => {
    for (const zone of zones) {
      const a = reservationA(zone, 60);
      const result = checkBufferChange({
        target: a,
        bufferMinutes: 30,
        reservations: [a],
        blocks: [],
      });
      if (!result.ok) {
        throw new Error(`${zone}：成功するはずが失敗した（${result.reason}）`);
      }
      expectRange(result.occupied, "2026-10-20T09:00", "2026-10-20T12:30");
    }
  });

  it("A のバッファ30分（占有区間 09:00–12:30）、申込 12:30–14:30：予約可（12:30で接するだけ）", () => {
    for (const zone of zones) {
      const a = reservationA(zone, 30);
      expectRange(occupiedRange(a, 30), "2026-10-20T09:00", "2026-10-20T12:30");
      expect(
        checkAvailability({
          start: at("2026-10-20T12:30", zone),
          end: at("2026-10-20T14:30", zone),
          bufferMinutes: 60,
          reservations: [a],
          blocks: [],
        }),
        zone,
      ).toEqual({ ok: true });
    }
  });

  it("A のバッファ30分、本予約 B 12:30–14:30 あり、管理者が A のバッファを1時間に戻す：不可（12:30–13:00が B と重なる）", () => {
    for (const zone of zones) {
      const a = reservationA(zone, 30);
      const b = reservation(zone, {
        id: "B",
        status: "firm",
        start: "2026-10-20T12:30",
        end: "2026-10-20T14:30",
        bufferMinutes: 60,
      });
      expect(
        checkBufferChange({ target: a, bufferMinutes: 60, reservations: [a, b], blocks: [] }),
        zone,
      ).toEqual({ ok: false, reason: "overlaps-existing" });
    }
  });

  describe("プロパティ（INV-1。どの入力でも成り立つこと）", () => {
    const others = fc.array(
      fc.record({ shape: reservationShape, status: fc.constantFrom(...ReservationStatus.options) }),
      { maxLength: 6 },
    );
    const blockShapes = fc.array(blockShape, { maxLength: 3 });
    // 第二キープと仮予約の重なりの例外（「第二キープ」の節）に関わらない状態だけを、切り替える予約にする
    const targetStatus = fc.constantFrom<ReservationStatus>(
      "pending-provisional",
      "pending-firm",
      "firm",
    );

    it("切り替えに成功するのは、切り替えたあとの占有区間が、自分以外の枠を確保している予約とブロック枠のどれとも重ならないときだけ。成功したときの占有区間は [start, end + 新しいバッファ)", () => {
      fc.assert(
        fc.property(
          reservationShape,
          targetStatus,
          fc.constantFrom<ReservationBufferMinutes>(30, 60),
          others,
          blockShapes,
          anyZone,
          (targetShape, status, newBuffer, otherItems, blocks, z) => {
            const target: ExistingReservation = {
              id: "target",
              status,
              start: toDateTime(targetShape.startMinutes, z),
              end: toDateTime(targetShape.endMinutes, z),
              bufferMinutes: targetShape.bufferMinutes as ReservationBufferMinutes,
            };
            const reservations: ExistingReservation[] = [
              target,
              ...otherItems.map(({ shape, status: s }, index) => ({
                id: `r${index}`,
                status: s,
                start: toDateTime(shape.startMinutes, z),
                end: toDateTime(shape.endMinutes, z),
                bufferMinutes: shape.bufferMinutes as ReservationBufferMinutes,
              })),
            ];
            const after: Shape = { ...targetShape, bufferMinutes: newBuffer };
            const overlaps =
              otherItems.some(
                ({ shape, status: s }) => isHolding(s) && occupiedOverlaps(after, shape),
              ) || blocks.some((block) => occupiedOverlaps(after, block));

            const result = checkBufferChange({
              target,
              bufferMinutes: newBuffer,
              reservations,
              blocks: blocks.map((block) => ({
                start: toDateTime(block.startMinutes, z),
                end: toDateTime(block.endMinutes, z),
                bufferMinutes: block.bufferMinutes,
              })),
            });

            if (overlaps) {
              expect(result).toEqual({ ok: false, reason: "overlaps-existing" });
            } else {
              if (!result.ok) {
                throw new Error(`成功するはずが失敗した（${result.reason}）`);
              }
              expect(result.occupied.start.toMillis()).toBe(
                base.plus({ minutes: targetShape.startMinutes }).toMillis(),
              );
              expect(result.occupied.end.toMillis()).toBe(
                base.plus({ minutes: targetShape.endMinutes + newBuffer }).toMillis(),
              );
            }
          },
        ),
      );
    });
  });
});
