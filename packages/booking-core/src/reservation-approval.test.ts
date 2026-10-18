import { ReservationStatus, Yen } from "@zebra/contracts";
import fc from "fast-check";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { type ReservationBufferMinutes, type TimeRange, occupiedRange } from "./availability";
import { approveReservation, rejectReservation } from "./reservation-approval";
import type { Reservation } from "./reservation-transitions";

// 承認・却下の関数は現在時刻を使わない（日時はすべて引数で渡す。INV-7）

// 仕様の日時は JST で書かれている（INV-7）。例の表には年がないので 2026 年とする。
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

// 承認待ちのあいだは確定金額がない（null）。承認済みの予約の確定金額は、例の表にないので 22,000円とする
const otherConfirmedAmount = Yen.parse(22_000);

// 例の表の予約は、バッファがすべて1時間（バッファを縮めるとは書いていないため）
function reservation(
  zone: Zone,
  fields: {
    id: string;
    status: ReservationStatus;
    start: string;
    end: string;
    provisionalIds?: readonly string[];
  },
): Reservation {
  return {
    id: fields.id,
    status: fields.status,
    start: at(fields.start, zone),
    end: at(fields.end, zone),
    bufferMinutes: 60,
    provisionalIds: fields.provisionalIds ?? [],
    confirmedAmount: fields.status.startsWith("pending-") ? null : otherConfirmedAmount,
  };
}

function find(reservations: readonly Reservation[], id: string): Reservation {
  const found = reservations.find((r) => r.id === id);
  if (found === undefined) {
    throw new Error(`操作のあとの予約に ${id} がない`);
  }
  return found;
}

// 区間が、JST で書いた [start, end) と同じ時点かを確かめる（ゾーンの表し方は問わない）
function expectRange(range: TimeRange, start: string, end: string, message: string): void {
  expect(range.start.toUTC().toISO(), message).toBe(at(start, "UTC").toISO());
  expect(range.end.toUTC().toISO(), message).toBe(at(end, "UTC").toISO());
}

// 解放される区間の並びが、JST で書いた区間の並びと同じ時点かを確かめる
function expectReleased(
  released: readonly TimeRange[],
  expected: readonly (readonly [string, string])[],
  message: string,
): void {
  expect(
    released.map((range) => [range.start.toUTC().toISO(), range.end.toUTC().toISO()]),
    message,
  ).toEqual(expected.map(([start, end]) => [at(start, "UTC").toISO(), at(end, "UTC").toISO()]));
}

function approve(reservations: readonly Reservation[], reservationId: string, amount: number) {
  const result = approveReservation({
    reservations,
    reservationId,
    confirmedAmount: Yen.parse(amount),
  });
  if (!result.ok) {
    throw new Error(`承認が失敗した（${reservationId}、${result.reason}）`);
  }
  return result;
}

function reject(reservations: readonly Reservation[], reservationId: string) {
  const result = rejectReservation({ reservations, reservationId });
  if (!result.ok) {
    throw new Error(`却下が失敗した（${reservationId}、${result.reason}）`);
  }
  return result;
}

describe("予約の状態", () => {
  // 申込のときの見積 11,000円は、承認の初期値として管理画面に出すもの（reservation-model.md「金額」）。
  // 承認の関数は、管理者が決めた確定金額を受け取る
  describe("承認待ち（本）A 10/20 10:00–12:00（占有区間 10:00–13:00、申込のときの見積 11,000円）の場合。", () => {
    const start = "2026-10-20T10:00";
    const end = "2026-10-20T12:00";

    function reservationA(zone: Zone): Reservation {
      const a = reservation(zone, { id: "A", status: "pending-firm", start, end });
      expectRange(occupiedRange(a, a.bufferMinutes), start, "2026-10-20T13:00", zone);
      return a;
    }

    it("管理者が確定金額 11,000円で承認：本予約。確定金額は 11,000円。承認の下書き（11,000円）ができる", () => {
      for (const zone of zones) {
        const result = approve([reservationA(zone)], "A", 11_000);
        const a = find(result.reservations, "A");
        expect(a.status, zone).toBe("firm");
        expect(a.confirmedAmount, zone).toBe(11_000);
        // 承認は申込どおりに行う（予約区間・バッファは変えない）
        expectRange(a, start, end, zone);
        expect(a.bufferMinutes, zone).toBe(60);
        expect(result.drafts, zone).toEqual([
          { kind: "approval", reservationId: "A", confirmedAmount: 11_000 },
        ]);
      }
    });

    it("管理者が確定金額を 10,000円に調整して承認：本予約。確定金額は 10,000円。承認の下書き（10,000円）ができる", () => {
      for (const zone of zones) {
        const result = approve([reservationA(zone)], "A", 10_000);
        const a = find(result.reservations, "A");
        expect(a.status, zone).toBe("firm");
        expect(a.confirmedAmount, zone).toBe(10_000);
        expectRange(a, start, end, zone);
        expect(result.drafts, zone).toEqual([
          { kind: "approval", reservationId: "A", confirmedAmount: 10_000 },
        ]);
      }
    });

    it("管理者が却下：取消。10:00–13:00 の枠を解放する。却下の下書きができる", () => {
      for (const zone of zones) {
        const result = reject([reservationA(zone)], "A");
        expect(find(result.reservations, "A").status, zone).toBe("cancelled");
        expectReleased(result.released, [[start, "2026-10-20T13:00"]], zone);
        expect(result.drafts, zone).toEqual([{ kind: "rejection", reservationId: "A" }]);
      }
    });
  });

  // 「ほかの場合」の表には日時と金額がないので、上の A と同じ 10/20 10:00–12:00、確定金額 11,000円とする。
  // 第二キープの行は、「第二キープ」の節の P 13:00–15:00 と第二キープ 14:00–17:00 を使う
  describe("ほかの場合", () => {
    it("承認待ち（仮）を承認：仮予約", () => {
      for (const zone of zones) {
        const before = reservation(zone, {
          id: "P",
          status: "pending-provisional",
          start: "2026-10-20T10:00",
          end: "2026-10-20T12:00",
        });
        const result = approve([before], "P", 11_000);
        const p = find(result.reservations, "P");
        expect(p.status, zone).toBe("provisional");
        expect(p.confirmedAmount, zone).toBe(11_000);
        expectRange(p, "2026-10-20T10:00", "2026-10-20T12:00", zone);
        expect(result.drafts, zone).toEqual([
          { kind: "approval", reservationId: "P", confirmedAmount: 11_000 },
        ]);
      }
    });

    it("仮予約 P に付く承認待ち（第二キープ）を承認：第二キープ。P に付いたまま", () => {
      for (const zone of zones) {
        const p = reservation(zone, {
          id: "P",
          status: "provisional",
          start: "2026-10-20T13:00",
          end: "2026-10-20T15:00",
        });
        const k = reservation(zone, {
          id: "K",
          status: "pending-second-hold",
          start: "2026-10-20T14:00",
          end: "2026-10-20T17:00",
          provisionalIds: ["P"],
        });
        const result = approve([p, k], "K", 11_000);
        const approved = find(result.reservations, "K");
        expect(approved.status, zone).toBe("second-hold");
        expect(approved.provisionalIds, zone).toEqual(["P"]);
        expectRange(approved, "2026-10-20T14:00", "2026-10-20T17:00", zone);
        // P は変わらない
        const pAfter = find(result.reservations, "P");
        expect(pAfter.status, zone).toBe("provisional");
        expect(pAfter.confirmedAmount, zone).toBe(otherConfirmedAmount);
        expect(result.drafts, zone).toEqual([
          { kind: "approval", reservationId: "K", confirmedAmount: 11_000 },
        ]);
      }
    });

    it("本予約を却下しようとする：不可（却下できるのは承認待ちだけ）", () => {
      for (const zone of zones) {
        const a = reservation(zone, {
          id: "A",
          status: "firm",
          start: "2026-10-20T10:00",
          end: "2026-10-20T12:00",
        });
        expect(rejectReservation({ reservations: [a], reservationId: "A" }), zone).toEqual({
          ok: false,
          reason: "not-pending",
        });
      }
    });

    it("本予約を承認しようとする：不可（承認できるのは承認待ちだけ）", () => {
      for (const zone of zones) {
        const a = reservation(zone, {
          id: "A",
          status: "firm",
          start: "2026-10-20T10:00",
          end: "2026-10-20T12:00",
        });
        expect(
          approveReservation({
            reservations: [a],
            reservationId: "A",
            confirmedAmount: Yen.parse(11_000),
          }),
          zone,
        ).toEqual({ ok: false, reason: "not-pending" });
      }
    });
  });

  describe("プロパティ（INV-1。どの入力でも成り立つこと）", () => {
    // 時刻は 10/20 00:00（JST）からの30分単位の枠で作る（10/20〜10/23 の範囲）
    const base = DateTime.fromISO("2026-10-20T00:00", { zone: "Asia/Tokyo" });
    const anyZone = fc.constantFrom(...zones);

    // 「予約の状態」の節の表：占有区間の枠を確保する状態
    const holdingStatuses: readonly ReservationStatus[] = [
      "pending-provisional",
      "pending-firm",
      "pending-second-hold",
      "provisional",
      "firm",
      "second-hold",
    ];
    const pendingStatuses: readonly ReservationStatus[] = [
      "pending-provisional",
      "pending-firm",
      "pending-second-hold",
    ];
    const secondHoldStatuses: readonly ReservationStatus[] = ["pending-second-hold", "second-hold"];
    // 承認したあとの状態（「予約の状態」の節の図）
    const approvedStatusOf: Partial<Record<ReservationStatus, ReservationStatus>> = {
      "pending-provisional": "provisional",
      "pending-firm": "firm",
      "pending-second-hold": "second-hold",
    };

    function isHolding(status: ReservationStatus): boolean {
      return holdingStatuses.includes(status);
    }
    function isSecondHold(status: ReservationStatus): boolean {
      return secondHoldStatuses.includes(status);
    }

    // テストの側で、ミリ秒の数で占有区間 [start, end + バッファ) を求める
    type Interval = readonly [number, number];
    function occupied(r: Reservation): Interval {
      return [r.start.toMillis(), r.end.toMillis() + r.bufferMinutes * 60_000];
    }
    function overlaps(a: Interval, b: Interval): boolean {
      return a[0] < b[1] && b[0] < a[1];
    }
    // 区間の集まりを、開始の早い順に並べ、重なる区間・接する区間をつないだ形にする
    function normalize(intervals: readonly Interval[]): Interval[] {
      const sorted = [...intervals].filter(([s, e]) => s < e).sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const [s, e] of sorted) {
        const last = merged.at(-1);
        if (last !== undefined && s <= last[1]) {
          last[1] = Math.max(last[1], e);
        } else {
          merged.push([s, e]);
        }
      }
      return merged;
    }
    // a に入っていて b に入らない時間
    function subtract(a: readonly Interval[], b: readonly Interval[]): Interval[] {
      let rest: Interval[] = normalize(a);
      for (const [bs, be] of normalize(b)) {
        rest = rest
          .flatMap(([s, e]): Interval[] =>
            be <= s || e <= bs
              ? [[s, e]]
              : [
                  [s, Math.min(e, bs)],
                  [Math.max(s, be), e],
                ],
          )
          .filter(([s, e]) => s < e);
      }
      return normalize(rest);
    }
    function holdingIntervals(reservations: readonly Reservation[]): Interval[] {
      return reservations.filter((r) => isHolding(r.status)).map(occupied);
    }

    // 2件の予約が重なってよいか（INV-1）：枠を確保していないものがあるか、第二キープと承認済みの仮予約の組
    function mayOverlap(a: Reservation, b: Reservation): boolean {
      if (!isHolding(a.status) || !isHolding(b.status)) return true;
      const pair = [a.status, b.status];
      return pair.includes("provisional") && pair.some((status) => isSecondHold(status));
    }

    function expectInv1(reservations: readonly Reservation[]): void {
      for (const [i, a] of reservations.entries()) {
        for (const b of reservations.slice(i + 1)) {
          if (!overlaps(occupied(a), occupied(b))) continue;
          expect(mayOverlap(a, b), `${a.id}（${a.status}）と ${b.id}（${b.status}）が重なる`).toBe(
            true,
          );
        }
      }
    }

    // 予約区間：開始・終了は30分単位、長さは2〜24時間。バッファは1時間か30分。状態はどれでもよい
    const item = fc.record({
      startSlot: fc.integer({ min: 0, max: 48 * 3 }),
      lengthSlots: fc.integer({ min: 4, max: 48 }),
      bufferMinutes: fc.constantFrom<ReservationBufferMinutes>(30, 60),
      status: fc.constantFrom(...ReservationStatus.options),
    });

    // INV-1 を満たす予約の並びを、テストの側で組み立てる。重なってはいけない組になるものは入れない。
    // 第二キープ（承認待ちを含む）は、重なる承認済みの仮予約すべてに付ける。どの仮予約とも重ならないものは入れない
    function build(items: readonly ItemShape[], z: Zone): Reservation[] {
      const reservations: Reservation[] = [];
      for (const [i, s] of items.entries()) {
        const candidate: Reservation = {
          id: `r${i}`,
          status: s.status,
          start: base.plus({ minutes: s.startSlot * 30 }).setZone(z),
          end: base.plus({ minutes: (s.startSlot + s.lengthSlots) * 30 }).setZone(z),
          bufferMinutes: s.bufferMinutes,
          provisionalIds: [],
          confirmedAmount: s.status.startsWith("pending-") ? null : otherConfirmedAmount,
        };
        if (!isHolding(candidate.status)) {
          reservations.push(candidate);
          continue;
        }
        const overlapping = reservations.filter(
          (r) => isHolding(r.status) && overlapsBoth(r, candidate),
        );
        if (isSecondHold(candidate.status)) {
          // 第二キープが重なってよいのは承認済みの仮予約だけ。重なる仮予約すべてに付く
          if (overlapping.some((r) => r.status !== "provisional")) continue;
          const provisionalIds = overlapping.map((r) => r.id);
          if (provisionalIds.length === 0) continue;
          reservations.push({ ...candidate, provisionalIds });
        } else if (overlapping.length === 0) {
          // 第二キープ以外の申込は、枠を確保しているどの予約とも重なれない（第二キープの占有区間全体を含む）
          reservations.push(candidate);
        }
      }
      return reservations;
    }
    interface ItemShape {
      startSlot: number;
      lengthSlots: number;
      bufferMinutes: ReservationBufferMinutes;
      status: ReservationStatus;
    }
    function overlapsBoth(a: Reservation, b: Reservation): boolean {
      return overlaps(occupied(a), occupied(b));
    }

    // 操作の前後で、操作した予約のほかは変わらないことを確かめる
    function expectOthersUnchanged(
      before: readonly Reservation[],
      after: readonly Reservation[],
      targetId: string,
    ): void {
      expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
      for (const [i, b] of before.entries()) {
        const a = after[i]!;
        expect(occupied(a), `${b.id} の占有区間`).toEqual(occupied(b));
        if (b.id === targetId) continue;
        expect(a.status, `${b.id} の状態`).toBe(b.status);
        expect(a.provisionalIds, `${b.id} の仮予約の id`).toEqual(b.provisionalIds);
        expect(a.confirmedAmount, `${b.id} の確定金額`).toBe(b.confirmedAmount);
      }
    }

    const amount = fc.integer({ min: 0, max: 200_000 }).map((n) => Yen.parse(n));

    it("承認できるのは承認待ちだけ。承認待ちは承認で、仮予約・本予約・第二キープ（付いている仮予約の id はそのまま）になり、確定金額が決まる。枠は変わらず、ほかの予約も変わらない", () => {
      fc.assert(
        fc.property(
          fc.array(item, { minLength: 1, maxLength: 8 }),
          fc.nat(),
          amount,
          anyZone,
          (items, pick, confirmedAmount, z) => {
            const reservations = build(items, z);
            fc.pre(reservations.length > 0);
            const target = reservations[pick % reservations.length]!;
            const result = approveReservation({
              reservations,
              reservationId: target.id,
              confirmedAmount,
            });
            if (!pendingStatuses.includes(target.status)) {
              expect(result).toEqual({ ok: false, reason: "not-pending" });
              return;
            }
            if (!result.ok) {
              throw new Error(
                `${target.id}（${target.status}）の承認が失敗した（${result.reason}）`,
              );
            }
            expectOthersUnchanged(reservations, result.reservations, target.id);
            const approved = find(result.reservations, target.id);
            expect(approved.status).toBe(approvedStatusOf[target.status]);
            expect(approved.confirmedAmount).toBe(confirmedAmount);
            expect(approved.provisionalIds).toEqual(target.provisionalIds);
            expect(approved.bufferMinutes).toBe(target.bufferMinutes);
            expect(result.drafts).toEqual([
              { kind: "approval", reservationId: target.id, confirmedAmount },
            ]);
            expectInv1(result.reservations);
          },
        ),
      );
    });

    it("却下できるのは承認待ちだけ。承認待ちは却下で取消になり、解放される枠は、確保している占有区間の操作の前後の差。ほかの予約は変わらない", () => {
      fc.assert(
        fc.property(
          fc.array(item, { minLength: 1, maxLength: 8 }),
          fc.nat(),
          anyZone,
          (items, pick, z) => {
            const reservations = build(items, z);
            fc.pre(reservations.length > 0);
            const target = reservations[pick % reservations.length]!;
            const result = rejectReservation({ reservations, reservationId: target.id });
            if (!pendingStatuses.includes(target.status)) {
              expect(result).toEqual({ ok: false, reason: "not-pending" });
              return;
            }
            if (!result.ok) {
              throw new Error(
                `${target.id}（${target.status}）の却下が失敗した（${result.reason}）`,
              );
            }
            expectOthersUnchanged(reservations, result.reservations, target.id);
            expect(find(result.reservations, target.id).status).toBe("cancelled");
            expect(
              result.released.map((range): Interval => [
                range.start.toMillis(),
                range.end.toMillis(),
              ]),
              "解放される枠",
            ).toEqual(
              subtract(holdingIntervals(reservations), holdingIntervals(result.reservations)),
            );
            expect(result.drafts.filter((d) => d.kind === "rejection")).toEqual([
              { kind: "rejection", reservationId: target.id },
            ]);
            expectInv1(result.reservations);
          },
        ),
      );
    });
  });
});
