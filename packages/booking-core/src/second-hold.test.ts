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
import { checkSecondHoldApplication } from "./second-hold";

// 第二キープの申込の判定は現在時刻を使わない（日時はすべて引数で渡す。INV-7）

// 仕様の日時は JST で書かれている（INV-7）。例の表には年も日付もないので 2026-10-20 とする。
// 例の各行は、JST で表した日時と、同じ時点を UTC で表した日時の両方で確かめる（docs/TESTING.md「仕様の例とテストの対応づけ」）
const zones = ["Asia/Tokyo", "UTC"] as const;
type Zone = (typeof zones)[number];

function at(time: string, zone: Zone): DateTime {
  const dateTime = DateTime.fromISO(`2026-10-20T${time}`, { zone: "Asia/Tokyo" });
  if (!dateTime.isValid) {
    throw new Error(`テストの日時が不正：${time}`);
  }
  return dateTime.setZone(zone);
}

// 区間が、JST で書いた [start, end) と同じ時点かを確かめる（ゾーンの表し方は問わない）
function expectRange(range: TimeRange, start: string, end: string): void {
  expect(range.start.toUTC().toISO()).toBe(at(start, "UTC").toISO());
  expect(range.end.toUTC().toISO()).toBe(at(end, "UTC").toISO());
}

// 例の表の予約は、バッファがすべて1時間（バッファを縮めるとは書いていないため）
function reservation(
  zone: Zone,
  id: string,
  status: ReservationStatus,
  start: string,
  end: string,
): ExistingReservation {
  return { id, status, start: at(start, zone), end: at(end, zone), bufferMinutes: 60 };
}

function applySecondHold(
  zone: Zone,
  start: string,
  end: string,
  reservations: ExistingReservation[],
) {
  return checkSecondHoldApplication({
    start: at(start, zone),
    end: at(end, zone),
    bufferMinutes: 60,
    reservations,
    blocks: [],
  });
}

function applyOther(zone: Zone, start: string, end: string, reservations: ExistingReservation[]) {
  return checkAvailability({
    start: at(start, zone),
    end: at(end, zone),
    bufferMinutes: 60,
    reservations,
    blocks: [],
  });
}

// 結果の形：
// - 受付：{ ok: true, provisionalIds }。provisionalIds は、申込の占有区間と重なる承認済みの仮予約（provisional）すべての id。
//   並び順は、引数の reservations の並び順（第二キープが付く仮予約。reservation-model.md「第二キープと仮予約」）
// - 不可（承認済みの仮予約以外の、枠を確保している予約かブロック枠と重なる）：{ ok: false, reason: "overlaps-existing" }
// - 不可（どの承認済みの仮予約とも重ならない。第二キープとしては受けない）：{ ok: false, reason: "no-provisional-to-hold" }
// 不可の理由が2つとも当てはまるときにどちらを返すかは決めない（booking.md の未決事項「予約不可の理由が複数当てはまるとき」と同じ扱い）

// 既存の仮予約 P 13:00–15:00（占有区間 13:00–16:00）。「承認済みの仮予約」なので状態は provisional
function reservationP(zone: Zone): ExistingReservation {
  return reservation(zone, "P", "provisional", "13:00", "15:00");
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
// 第二キープ（承認待ちを含む）。「第二キープどうしは、承認待ちを含めて重なれない」
const secondHoldStatuses = [
  "pending-second-hold",
  "second-hold",
] as const satisfies readonly ReservationStatus[];

describe("第二キープ", () => {
  describe("既存の仮予約 P が 13:00–15:00（占有区間 13:00–16:00）の場合の、第二キープの申込。", () => {
    it("第二キープ 13:00–15:00：受付（承認待ち。枠を確保する）", () => {
      for (const zone of zones) {
        const p = reservationP(zone);
        expectRange(occupiedRange(p, 60), "13:00", "16:00");
        expect(applySecondHold(zone, "13:00", "15:00", [p]), zone).toEqual({
          ok: true,
          provisionalIds: ["P"],
        });

        // 枠を確保する：承認待ちのまま、同じ区間の第二キープ申込は受けない（ほかの第二キープと重なる）
        const accepted = reservation(zone, "S", "pending-second-hold", "13:00", "15:00");
        expect(applySecondHold(zone, "13:00", "15:00", [p, accepted]), zone).toEqual({
          ok: false,
          reason: "overlaps-existing",
        });
      }
    });

    it("第二キープ 14:00–17:00（占有区間 14:00–18:00）：受付（Pとだけ重なる）", () => {
      for (const zone of zones) {
        const applied = { start: at("14:00", zone), end: at("17:00", zone) };
        expectRange(occupiedRange(applied, 60), "14:00", "18:00");
        expect(applySecondHold(zone, "14:00", "17:00", [reservationP(zone)]), zone).toEqual({
          ok: true,
          provisionalIds: ["P"],
        });
      }
    });

    // すでにある第二キープは、承認待ち（pending-second-hold）と第二キープ（second-hold）の両方で確かめる（「承認待ちでも同じ」）
    it("P に第二キープ 14:00–17:00（占有区間 14:00–18:00）がすでにあるときの、第二キープ 13:00–15:00（占有区間 13:00–16:00）：不可（すでにある第二キープと重なる。承認待ちでも同じ）", () => {
      for (const zone of zones) {
        const p = reservationP(zone);
        const applied = { start: at("13:00", zone), end: at("15:00", zone) };
        expectRange(occupiedRange(applied, 60), "13:00", "16:00");
        for (const status of secondHoldStatuses) {
          const k = reservation(zone, "K", status, "14:00", "17:00");
          expectRange(occupiedRange(k, 60), "14:00", "18:00");
          expect(
            applySecondHold(zone, "13:00", "15:00", [p, k]),
            `${zone}、すでにある第二キープは ${status}`,
          ).toEqual({ ok: false, reason: "overlaps-existing" });
        }
      }
    });

    // すでにある第二キープの状態は例にないので、承認待ちと第二キープの両方で確かめる
    it("P に第二キープ 14:00–17:00（占有区間 14:00–18:00）がすでにあるときの、第二キープ 11:00–13:00（占有区間 11:00–14:00）：受付（Pとだけ重なり、すでにある第二キープとは14:00で接するだけ）", () => {
      for (const zone of zones) {
        const p = reservationP(zone);
        const applied = { start: at("11:00", zone), end: at("13:00", zone) };
        expectRange(occupiedRange(applied, 60), "11:00", "14:00");
        for (const status of secondHoldStatuses) {
          const k = reservation(zone, "K", status, "14:00", "17:00");
          expect(
            applySecondHold(zone, "11:00", "13:00", [p, k]),
            `${zone}、すでにある第二キープは ${status}`,
          ).toEqual({ ok: true, provisionalIds: ["P"] });
        }
      }
    });

    it("第二キープ 14:00–17:00。ただし 17:00–19:00 に本予約がある：不可（本予約と重なる）", () => {
      for (const zone of zones) {
        const firm = reservation(zone, "F", "firm", "17:00", "19:00");
        expect(applySecondHold(zone, "14:00", "17:00", [reservationP(zone), firm]), zone).toEqual({
          ok: false,
          reason: "overlaps-existing",
        });
      }
    });

    it("第二キープ 18:00–20:00（占有区間 18:00–21:00）：第二キープとしては不可（どの仮予約とも重ならない。普通の申込になる）", () => {
      for (const zone of zones) {
        const p = reservationP(zone);
        const applied = { start: at("18:00", zone), end: at("20:00", zone) };
        expectRange(occupiedRange(applied, 60), "18:00", "21:00");
        expect(applySecondHold(zone, "18:00", "20:00", [p]), zone).toEqual({
          ok: false,
          reason: "no-provisional-to-hold",
        });
        // 普通の申込になる：普通の申込（checkAvailability）としては受付
        expect(applyOther(zone, "18:00", "20:00", [p]), zone).toEqual({ ok: true });
      }
    });
  });

  describe("2件の仮予約にまたがる場合。仮予約 P1 10:00–12:00（占有区間 10:00–13:00）と仮予約 P2 15:00–17:00（占有区間 15:00–18:00）があるとき。", () => {
    function provisionals(zone: Zone, p2Status: ReservationStatus): ExistingReservation[] {
      const p1 = reservation(zone, "P1", "provisional", "10:00", "12:00");
      const p2 = reservation(zone, "P2", p2Status, "15:00", "17:00");
      expectRange(occupiedRange(p1, 60), "10:00", "13:00");
      expectRange(occupiedRange(p2, 60), "15:00", "18:00");
      return [p1, p2];
    }

    it("第二キープ 12:00–16:00（占有区間 12:00–17:00）：受付（P1 と P2 の両方に付く）", () => {
      for (const zone of zones) {
        const applied = { start: at("12:00", zone), end: at("16:00", zone) };
        expectRange(occupiedRange(applied, 60), "12:00", "17:00");
        const existing = provisionals(zone, "provisional");
        expect(applySecondHold(zone, "12:00", "16:00", existing), zone).toEqual({
          ok: true,
          provisionalIds: ["P1", "P2"],
        });
        // 付く仮予約の id は、引数の reservations の並び順で返す
        expect(
          applySecondHold(zone, "12:00", "16:00", [...existing].reverse()),
          `${zone}、P2, P1 の順で渡す`,
        ).toEqual({ ok: true, provisionalIds: ["P2", "P1"] });
      }
    });

    it("第二キープ 12:00–16:00。ただし P2 が承認待ち（仮）：不可（承認待ちの仮予約とは重なれない）", () => {
      for (const zone of zones) {
        expect(
          applySecondHold(zone, "12:00", "16:00", provisionals(zone, "pending-provisional")),
          zone,
        ).toEqual({ ok: false, reason: "overlaps-existing" });
      }
    });
  });

  // すでにある第二キープ①の状態は例にないので、承認待ちと第二キープの両方で確かめる
  describe("1件の仮予約に、重ならない第二キープを2件入れる場合。仮予約 12:00–18:00（占有区間 12:00–19:00）に、第二キープ① 11:00–14:00（占有区間 11:00–15:00）がすでにあるとき。", () => {
    function expectRow(start: string, end: string, occupiedEnd: string, expected: unknown): void {
      for (const zone of zones) {
        const provisional = reservation(zone, "P", "provisional", "12:00", "18:00");
        expectRange(occupiedRange(provisional, 60), "12:00", "19:00");
        const applied = { start: at(start, zone), end: at(end, zone) };
        expectRange(occupiedRange(applied, 60), start, occupiedEnd);
        for (const status of secondHoldStatuses) {
          const first = reservation(zone, "S1", status, "11:00", "14:00");
          expectRange(occupiedRange(first, 60), "11:00", "15:00");
          expect(
            applySecondHold(zone, start, end, [provisional, first]),
            `${zone}、①は ${status}`,
          ).toEqual(expected);
        }
      }
    }

    it("第二キープ② 15:00–20:00（占有区間 15:00–21:00）：受付（仮予約とだけ重なり、①とは15:00で接するだけ）", () => {
      expectRow("15:00", "20:00", "21:00", { ok: true, provisionalIds: ["P"] });
    });

    it("第二キープ 14:00–20:00（占有区間 14:00–21:00）：不可（①と重なる）", () => {
      expectRow("14:00", "20:00", "21:00", { ok: false, reason: "overlaps-existing" });
    });
  });

  // 第二キープ以外の申込の判定は checkAvailability。第二キープも枠を確保する（「第二キープの占有区間全体に、後からの申込は入れない」）
  describe("さらに、第二キープ K が 14:00–17:00（占有区間 14:00–18:00）で入っている場合の、後からの申込。", () => {
    function existing(zone: Zone): ExistingReservation[] {
      return [reservationP(zone), reservation(zone, "K", "second-hold", "14:00", "17:00")];
    }

    it("本予約申込 16:00–18:00（占有区間 16:00–19:00）：不可（Pとは重ならないが、Kと重なる）", () => {
      for (const zone of zones) {
        const applied = { start: at("16:00", zone), end: at("18:00", zone) };
        expectRange(occupiedRange(applied, 60), "16:00", "19:00");
        // Pとは重ならない（P だけなら受付になる）
        expect(applyOther(zone, "16:00", "18:00", [reservationP(zone)]), zone).toEqual({
          ok: true,
        });
        expect(applyOther(zone, "16:00", "18:00", existing(zone)), zone).toEqual({
          ok: false,
          reason: "overlaps-existing",
        });
      }
    });

    it("本予約申込 18:00–20:00：受付（18:00で接するだけ）", () => {
      for (const zone of zones) {
        expect(applyOther(zone, "18:00", "20:00", existing(zone)), zone).toEqual({ ok: true });
      }
    });
  });

  // 後半の2つの表（「P と K の出来事。」「前倒しの通知（…）。」）は、状態の移り変わりのテスト
  // （reservation-transitions.test.ts の describe("第二キープ")）にある

  // 申込の占有区間と重なる承認済みの仮予約は、0件・1件・2件以上のすべてを入力にする
  // （1件以上なら、そのすべてに付く。0件なら第二キープとしては受けない）
  describe("プロパティ（INV-1。どの入力でも成り立つこと）", () => {
    // 時刻は 10/20 00:00（JST）からの30分単位の枠で作る（10/20〜10/24 の範囲）
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

    // 予約区間：開始・終了は30分単位、長さは2〜24時間。バッファは1時間か30分
    const reservationShape = fc
      .record({
        startSlot: slot,
        lengthSlots: fc.integer({ min: 4, max: 48 }),
        bufferMinutes: fc.constantFrom<ReservationBufferMinutes>(30, 60),
      })
      .map(({ startSlot, lengthSlots, bufferMinutes }): Shape => ({
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

    function isHolding(status: ReservationStatus): boolean {
      return (holdingStatuses as readonly ReservationStatus[]).includes(status);
    }

    function isSecondHold(status: ReservationStatus): boolean {
      return (secondHoldStatuses as readonly ReservationStatus[]).includes(status);
    }

    function toReservations(items: readonly Item[], z: Zone): ExistingReservation[] {
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

    function check(applied: Shape, items: readonly Item[], blocks: readonly Shape[], z: Zone) {
      return checkSecondHoldApplication({
        start: toDateTime(applied.startMinutes, z),
        end: toDateTime(applied.endMinutes, z),
        bufferMinutes: applied.bufferMinutes as ReservationBufferMinutes,
        reservations: toReservations(items, z),
        blocks: toBlocks(blocks, z),
      });
    }

    // 申込の占有区間と重なる、承認済みの仮予約の id（toReservations と同じ id。並び順は items の並び順）
    function overlappingProvisionalIds(applied: Shape, items: readonly Item[]): string[] {
      return items.flatMap(({ shape, status }, index) =>
        status === "provisional" && occupiedOverlaps(applied, shape) ? [`r${index}`] : [],
      );
    }

    // 仕様のルールを、テストの側で分の数から判定する：承認済みの仮予約以外の、枠を確保している予約
    // （承認待ち・本予約・ほかの第二キープ〔承認待ちを含む〕）かブロック枠と重なる
    function overlapsOther(applied: Shape, items: readonly Item[], blocks: readonly Shape[]) {
      return (
        items.some(
          ({ shape, status }) =>
            isHolding(status) && status !== "provisional" && occupiedOverlaps(applied, shape),
        ) || blocks.some((block) => occupiedOverlaps(applied, block))
      );
    }

    // 承認済みの仮予約（0〜3件）と、ほかの予約（取消・終了を含むすべての状態。承認済みの仮予約も混ざる）、ブロック枠
    const provisionalShapes = fc.array(reservationShape, { maxLength: 3 });
    const otherItems = fc.array(
      fc.record({ shape: reservationShape, status: fc.constantFrom(...ReservationStatus.options) }),
      { maxLength: 6 },
    );
    const blockShapes = fc.array(blockShape, { maxLength: 3 });

    function itemsWith(provisionals: readonly Shape[], others: readonly Item[]): Item[] {
      return [...provisionals.map((shape): Item => ({ shape, status: "provisional" })), ...others];
    }

    it("受付になった第二キープの占有区間は、承認済みの仮予約の1件以上と重なり、承認済みの仮予約以外の、枠を確保している予約（ほかの第二キープ〔承認待ちを含む〕を含む）とブロック枠のどの占有区間とも重ならない", () => {
      fc.assert(
        fc.property(
          reservationShape,
          provisionalShapes,
          otherItems,
          blockShapes,
          anyZone,
          (applied, provisionals, others, blocks, z) => {
            const items = itemsWith(provisionals, others);
            const result = check(applied, items, blocks, z);
            fc.pre(result.ok);
            expect(overlappingProvisionalIds(applied, items).length).toBeGreaterThan(0);
            expect(overlapsOther(applied, items, blocks)).toBe(false);
          },
        ),
      );
    });

    // 重なる仮予約に第二キープがすでにあっても、その第二キープと重ならなければ受付（1件の仮予約に何件でもよい）。
    // 2件以上の仮予約にまたがってもよい
    it("重なる承認済みの仮予約が1件以上なら、承認済みの仮予約以外の、枠を確保している予約とブロック枠のどの占有区間とも重ならなければ受付（付く仮予約は、重なる承認済みの仮予約すべて）。重なれば不可（本予約などと重なる）", () => {
      fc.assert(
        fc.property(
          reservationShape,
          provisionalShapes,
          otherItems,
          blockShapes,
          anyZone,
          (applied, provisionals, others, blocks, z) => {
            const items = itemsWith(provisionals, others);
            const provisionalIds = overlappingProvisionalIds(applied, items);
            fc.pre(provisionalIds.length >= 1);
            const expected = overlapsOther(applied, items, blocks)
              ? { ok: false, reason: "overlaps-existing" }
              : { ok: true, provisionalIds };
            expect(check(applied, items, blocks, z)).toEqual(expected);
          },
        ),
      );
    });

    // ほかの予約かブロック枠とも重なるときは、不可の理由が2つ当てはまる。どちらを返すかは決めない（冒頭の「結果の形」）
    it("重なる承認済みの仮予約が0件なら不可（第二キープとしては受けない）", () => {
      fc.assert(
        fc.property(
          reservationShape,
          provisionalShapes,
          otherItems,
          blockShapes,
          anyZone,
          (applied, provisionals, others, blocks, z) => {
            const items = itemsWith(provisionals, others);
            fc.pre(overlappingProvisionalIds(applied, items).length === 0);
            const result = check(applied, items, blocks, z);
            if (overlapsOther(applied, items, blocks)) {
              expect([
                { ok: false, reason: "overlaps-existing" },
                { ok: false, reason: "no-provisional-to-hold" },
              ]).toContainEqual(result);
            } else {
              expect(result).toEqual({ ok: false, reason: "no-provisional-to-hold" });
            }
          },
        ),
      );
    });

    // 重ならない予約とブロック枠から始めて、第二キープの申込を順に受け付ける（受け付けたものは承認待ちか、承認して第二キープにする）。
    // どの順でも、第二キープと承認済みの仮予約の組を除いて占有区間は重ならない（第二キープは2件以上の仮予約にまたがってもよい。
    // 第二キープどうしは、承認待ちを含めて重ならない）。1件の仮予約に、重ならない第二キープが何件付いてもよい。
    // どの仮予約とも重ならない第二キープはできない
    it("第二キープの申込を続けて受け付けても、INV-1 は崩れない", () => {
      const initialStatus = fc.constantFrom<ReservationStatus>(
        "pending-provisional",
        "pending-firm",
        "provisional",
        "provisional",
        "firm",
      );
      fc.assert(
        fc.property(
          fc.array(fc.record({ shape: reservationShape, status: initialStatus }), { maxLength: 8 }),
          blockShapes,
          fc.array(fc.record({ shape: reservationShape, approve: fc.boolean() }), {
            maxLength: 10,
          }),
          anyZone,
          (initial, initialBlocks, applications, z) => {
            // 初めの状態は、テストの側で重なりを除いて作る
            const blocks: Shape[] = [];
            for (const block of initialBlocks) {
              if (!blocks.some((b) => occupiedOverlaps(b, block))) blocks.push(block);
            }
            const items: Item[] = [];
            for (const item of initial) {
              if (
                !items.some(({ shape }) => occupiedOverlaps(shape, item.shape)) &&
                !blocks.some((block) => occupiedOverlaps(block, item.shape))
              ) {
                items.push(item);
              }
            }

            // 申込は、重なる承認済みの仮予約が0件・1件・2件以上のどれでも出す
            for (const { shape, approve } of applications) {
              if (check(shape, items, blocks, z).ok) {
                items.push({ shape, status: approve ? "second-hold" : "pending-second-hold" });
              }
            }

            for (const [i, a] of items.entries()) {
              for (const b of items.slice(i + 1)) {
                if (!occupiedOverlaps(a.shape, b.shape)) continue;
                const pair = [a.status, b.status];
                const allowed =
                  pair.includes("provisional") && pair.some((status) => isSecondHold(status));
                expect(allowed, `${a.status} と ${b.status} が重なる`).toBe(true);
              }
              for (const block of blocks) {
                expect(occupiedOverlaps(a.shape, block), `${a.status} とブロック枠が重なる`).toBe(
                  false,
                );
              }
              if (isSecondHold(a.status)) {
                expect(
                  items.some(
                    ({ shape, status }) =>
                      status === "provisional" && occupiedOverlaps(a.shape, shape),
                  ),
                  `${a.status} がどの承認済みの仮予約とも重ならない`,
                ).toBe(true);
              }
            }
          },
        ),
      );
    });
  });
});
