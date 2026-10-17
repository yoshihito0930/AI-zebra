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
import { type SecondHoldRejection, checkSecondHoldApplication } from "./second-hold";

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
// 第二キープ（承認待ちを含む）。「1件の仮予約に重なる第二キープは、承認待ちを含めて1件まで」
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
        expect(applySecondHold(zone, "13:00", "15:00", [p]), zone).toEqual({ ok: true });

        // 枠を確保する：承認待ちのまま、同じ区間の申込は受けない（理由は「1件まで」と「ほかの第二キープと重なる」の両方に当たるので確かめない）
        const accepted = reservation(zone, "S", "pending-second-hold", "13:00", "15:00");
        expect(applySecondHold(zone, "13:00", "15:00", [p, accepted]).ok, zone).toBe(false);
      }
    });

    it("第二キープ 14:00–17:00（占有区間 14:00–18:00）：受付（Pとだけ重なる）", () => {
      for (const zone of zones) {
        const applied = { start: at("14:00", zone), end: at("17:00", zone) };
        expectRange(occupiedRange(applied, 60), "14:00", "18:00");
        expect(applySecondHold(zone, "14:00", "17:00", [reservationP(zone)]), zone).toEqual({
          ok: true,
        });
      }
    });

    // 申込の区間は例にない。すでにある第二キープ K1 を 14:00–17:00（占有区間 14:00–18:00）とし、
    // 2件目は 11:00–13:00（占有区間 11:00–14:00）とする。P（13:00–16:00）とだけ重なり、K1 とは 14:00 で接するだけなので、
    // 「ほかの第二キープと重なる」ではなく「その仮予約にはすでに第二キープがある」の理由で不可になる
    it("P に第二キープがすでに1件（承認待ちを含む）あるときの、2件目の第二キープ：不可", () => {
      for (const zone of zones) {
        const p = reservationP(zone);
        const applied = { start: at("11:00", zone), end: at("13:00", zone) };
        expectRange(occupiedRange(applied, 60), "11:00", "14:00");

        // 対照：K1 がなければ受付になる区間（P とだけ重なる）
        expect(applySecondHold(zone, "11:00", "13:00", [p]), zone).toEqual({ ok: true });

        for (const status of secondHoldStatuses) {
          const k1 = reservation(zone, "K1", status, "14:00", "17:00");
          expectRange(occupiedRange(k1, 60), "14:00", "18:00");
          expect(
            applySecondHold(zone, "11:00", "13:00", [p, k1]),
            `${zone}、K1 は ${status}`,
          ).toEqual({ ok: false, reason: "provisional-already-has-second-hold" });
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

  // 後半の2つの表は、状態の移り変わりと通知の下書きの形を決めてからテストにする（まだテストしていないことを見失わないため、行の内容のまま置く）
  describe("P と K の出来事。", () => {
    it.todo("P が取消 → お客様が承諾 → 管理者が繰り上げ：K は仮予約になる");
    it.todo(
      "P が取消 → 繰り上げ前に 13:00–15:00（占有区間 13:00–16:00）の申込が来る：申込は不可（Kと重なる）。K はそのまま繰り上げられる",
    );
    it.todo("P が取消 → K のお客様が辞退 → 管理者が取消：K は取消。14:00–18:00 の枠を解放する");
    it.todo(
      "管理者が P を本予約に昇格：K は終了。Pと重ならない 16:00–18:00 の枠を解放する（通知の下書きができる）",
    );
  });

  describe("前倒しの通知（K は 14:00–17:00、占有区間 14:00–18:00）。", () => {
    it.todo(
      "K の後ろの予約が本予約 18:00–20:00、K が取消・終了したとき：前倒しの通知の下書きを作る（18:00で接している）",
    );
    it.todo("K の後ろの予約が本予約 18:30–20:30、K が取消・終了したとき：作らない（接していない）");
    it.todo("K の後ろに予約がない、K が取消・終了したとき：作らない");
  });

  // 未決事項「2件の仮予約にまたがる第二キープを受けるか。どの仮予約とも重ならない第二キープ申込をどう扱うか」に当たる入力
  // （申込の占有区間と重なる承認済みの仮予約が1件でない）は、結果を確かめない
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

    // 申込の占有区間と重なる、承認済みの仮予約（枠を確保しているもの）
    function overlappingProvisionals(applied: Shape, items: readonly Item[]): Item[] {
      return items.filter(
        ({ shape, status }) => status === "provisional" && occupiedOverlaps(applied, shape),
      );
    }

    // 仕様のルールを、テストの側で分の数から判定する。重なる承認済みの仮予約がちょうど1件のときだけ使う
    function rules(applied: Shape, items: readonly Item[], blocks: readonly Shape[]) {
      const [provisional] = overlappingProvisionals(applied, items);
      if (provisional === undefined) {
        throw new Error("重なる仮予約がちょうど1件のときだけ使う");
      }
      // 承認済みの仮予約以外の、枠を確保している予約かブロック枠と重なる
      const overlapsOther =
        items.some(
          ({ shape, status }) =>
            isHolding(status) && status !== "provisional" && occupiedOverlaps(applied, shape),
        ) || blocks.some((block) => occupiedOverlaps(applied, block));
      // 重なる仮予約に、第二キープ（承認待ちを含む）がすでにある
      const alreadyHasSecondHold = items.some(
        ({ shape, status }) => isSecondHold(status) && occupiedOverlaps(provisional.shape, shape),
      );
      return { overlapsOther, alreadyHasSecondHold };
    }

    // P（承認済みの仮予約）と、ほかの予約（取消・終了を含むすべての状態）、ブロック枠
    const provisionalShape = reservationShape;
    const otherItems = fc.array(
      fc.record({ shape: reservationShape, status: fc.constantFrom(...ReservationStatus.options) }),
      { maxLength: 6 },
    );
    const blockShapes = fc.array(blockShape, { maxLength: 3 });

    function itemsWith(p: Shape, others: readonly Item[]): Item[] {
      return [{ shape: p, status: "provisional" }, ...others];
    }

    it("受付になった第二キープの占有区間は、承認済みの仮予約以外の、枠を確保している予約とブロック枠のどの占有区間とも重ならない", () => {
      fc.assert(
        fc.property(
          reservationShape,
          provisionalShape,
          otherItems,
          blockShapes,
          anyZone,
          (applied, p, others, blocks, z) => {
            const items = itemsWith(p, others);
            fc.pre(overlappingProvisionals(applied, items).length === 1);
            const result = check(applied, items, blocks, z);
            fc.pre(result.ok);
            expect(rules(applied, items, blocks).overlapsOther).toBe(false);
          },
        ),
      );
    });

    it("受付になったなら、重なる仮予約に、第二キープ（承認待ちを含む）はほかにない", () => {
      fc.assert(
        fc.property(
          reservationShape,
          provisionalShape,
          otherItems,
          blockShapes,
          anyZone,
          (applied, p, others, blocks, z) => {
            const items = itemsWith(p, others);
            fc.pre(overlappingProvisionals(applied, items).length === 1);
            const result = check(applied, items, blocks, z);
            fc.pre(result.ok);
            expect(rules(applied, items, blocks).alreadyHasSecondHold).toBe(false);
          },
        ),
      );
    });

    // 不可の理由が両方に当たるときに、どちらを返すかは仕様にないので確かめない
    it("上の2つが成り立てば必ず受付になる。不可の理由は、成り立たなかった方（本予約などと重なる／その仮予約にはすでに第二キープがある）", () => {
      fc.assert(
        fc.property(
          reservationShape,
          provisionalShape,
          otherItems,
          blockShapes,
          anyZone,
          (applied, p, others, blocks, z) => {
            const items = itemsWith(p, others);
            fc.pre(overlappingProvisionals(applied, items).length === 1);
            const { overlapsOther, alreadyHasSecondHold } = rules(applied, items, blocks);
            const result = check(applied, items, blocks, z);
            if (!overlapsOther && !alreadyHasSecondHold) {
              expect(result).toEqual({ ok: true });
            } else if (overlapsOther && !alreadyHasSecondHold) {
              expect(result).toEqual({ ok: false, reason: "overlaps-existing" });
            } else if (!overlapsOther && alreadyHasSecondHold) {
              expect(result).toEqual({ ok: false, reason: "provisional-already-has-second-hold" });
            } else {
              expect(result.ok).toBe(false);
              const reasons: readonly SecondHoldRejection[] = [
                "overlaps-existing",
                "provisional-already-has-second-hold",
              ];
              expect(reasons).toContain(result.ok ? undefined : result.reason);
            }
          },
        ),
        // 「その仮予約にはすでに第二キープがある」だけに当たる入力は少ない（前提を満たす入力の2%ほど）ので、回数を増やす
        { numRuns: 1000 },
      );
    });

    // 重ならない予約とブロック枠から始めて、第二キープの申込を順に受け付ける（受け付けたものは承認待ちか、承認して第二キープにする）。
    // どの順でも、第二キープと仮予約1件の組を除いて占有区間は重ならず、仮予約1件に重なる第二キープは1件まで
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

            for (const { shape, approve } of applications) {
              // 未決事項に当たる申込（重なる承認済みの仮予約が1件でない）は出さない
              if (overlappingProvisionals(shape, items).length !== 1) continue;
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
              if (a.status === "provisional") {
                const secondHolds = items.filter(
                  ({ shape, status }) => isSecondHold(status) && occupiedOverlaps(a.shape, shape),
                );
                expect(secondHolds.length).toBeLessThanOrEqual(1);
              }
            }
          },
        ),
      );
    });
  });
});
