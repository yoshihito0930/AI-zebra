import { ReservationStatus, Yen } from "@zebra/contracts";
import fc from "fast-check";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  type ReservationBufferMinutes,
  type TimeRange,
  checkAvailability,
  occupiedRange,
} from "./availability";
import { provisionalDeadline } from "./provisional-deadline";
import {
  type Reservation,
  type ReservationDraft,
  type ReservationOperation,
  applyReservationOperation,
  needsProvisionalDeadlineWarning,
} from "./reservation-transitions";
import { checkSecondHoldApplication } from "./second-hold";

// 状態の移り変わりの関数は現在時刻を使わない（日時はすべて引数で渡す。INV-7）

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

// 第二キープの例の表には日付がないので 10/20 とする
function oct20(time: string): string {
  return `2026-10-20T${time}`;
}

// 例の表には金額がないので、承認済みの予約の確定金額は 22,000円とする。承認待ちのあいだは確定金額がない（null）。
// 例の取消はどれも仮予約か第二キープなので、キャンセル料は金額によらず 0円
const confirmedAmount = Yen.parse(22_000);
const noFee = { ratePercent: 0, fee: Yen.parse(0) } as const;

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
    confirmedAmount: fields.status.startsWith("pending-") ? null : confirmedAmount,
  };
}

// 成功するはずの操作。失敗したら、理由を出してテストを落とす
function operate(reservations: readonly Reservation[], operation: ReservationOperation) {
  const result = applyReservationOperation({ reservations, operation });
  if (!result.ok) {
    throw new Error(`成功するはずが失敗した（${operation.kind}、${result.reason}）`);
  }
  return result;
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

// 下書きの並び順は決めていないので、件数と中身で比べる
function expectDrafts(
  drafts: readonly ReservationDraft[],
  expected: readonly ReservationDraft[],
  message: string,
): void {
  expect(drafts, message).toHaveLength(expected.length);
  expect(drafts, message).toEqual(expect.arrayContaining([...expected]));
}

describe("仮予約から本予約へ", () => {
  describe("仮予約 10/20 15:00–19:00（仮予約の期限は 10/13 18:00）の場合。", () => {
    const start = "2026-10-20T15:00";
    const end = "2026-10-20T19:00";

    function reservationP(zone: Zone, status: ReservationStatus = "provisional"): Reservation {
      return reservation(zone, { id: "P", status, start, end });
    }

    function warning(zone: Zone, status: ReservationStatus, now: string): boolean {
      return needsProvisionalDeadlineWarning({
        status,
        start: at(start, zone),
        now: at(now, zone),
      });
    }

    // 時刻で状態を変える操作はない（ReservationOperation は管理者の操作だけ）。時刻で決まるのは警告だけ
    it("10/13 17:59：仮予約のまま", () => {
      for (const zone of zones) {
        expect(provisionalDeadline(at(start, zone)).toMillis(), zone).toBe(
          at("2026-10-13T18:00", zone).toMillis(),
        );
        expect(warning(zone, "provisional", "2026-10-13T17:59"), zone).toBe(false);
      }
    });

    it("10/13 18:00：仮予約のまま。管理画面で警告する", () => {
      for (const zone of zones) {
        expect(warning(zone, "provisional", "2026-10-13T18:00"), zone).toBe(true);
      }
    });

    // 昇格に日時は要らない（期限を過ぎていても管理者は昇格できる）。10/14 は入力にない
    it("10/14 管理者が本予約に昇格：本予約。通知の下書きができる", () => {
      for (const zone of zones) {
        const result = operate([reservationP(zone)], { kind: "promote", reservationId: "P" });
        expect(find(result.reservations, "P").status, zone).toBe("firm");
        expectReleased(result.released, [], zone);
        expectDrafts(result.drafts, [{ kind: "promotion", reservationId: "P" }], zone);
      }
    });

    // 10/14 の時刻は 12:00 とする。取消で、占有区間 15:00–20:00 の枠を解放する（「予約の状態」の節）
    it("10/14 管理者が取消：取消。キャンセル料なし（仮予約のため）", () => {
      for (const zone of zones) {
        const result = operate([reservationP(zone)], {
          kind: "cancel",
          reservationId: "P",
          cancelledAt: at("2026-10-14T12:00", zone),
        });
        expect(find(result.reservations, "P").status, zone).toBe("cancelled");
        expectReleased(result.released, [["2026-10-20T15:00", "2026-10-20T20:00"]], zone);
        expectDrafts(
          result.drafts,
          [{ kind: "cancellation", reservationId: "P", cancellationFee: noFee }],
          zone,
        );
      }
    });

    // 承認待ちの仮予約申込（pending-provisional）。「ちょうど境界の時刻は過ぎた側に入れる」ので、10/13 18:00 で確かめる。
    // 時刻で状態を変える操作はないので、承認待ちのまま
    it("承認待ちのまま 10/13 18:00 を過ぎる：承認待ちのまま。管理画面で警告する", () => {
      for (const zone of zones) {
        expect(warning(zone, "pending-provisional", "2026-10-13T18:00"), zone).toBe(true);
      }
    });
  });

  describe("プロパティ（INV-7。どの入力でも成り立つこと）", () => {
    const base = DateTime.fromISO("2026-10-01T00:00", { zone: "Asia/Tokyo" });
    const input = fc.record({
      status: fc.constantFrom<ReservationStatus>("provisional", "pending-provisional"),
      // 10/01 00:00 から60日のうち、30分単位の開始
      startSlot: fc.integer({ min: 0, max: 48 * 60 - 1 }),
      // 開始の30日前から、開始まで（分単位）
      minutesBeforeStart: fc.integer({ min: 0, max: 60 * 24 * 30 }),
    });

    it("仮予約と承認待ちの仮予約申込への警告は、現在時刻が仮予約の期限以降のときだけ出る。同じ時点を UTC で渡しても同じ結果", () => {
      fc.assert(
        fc.property(input, ({ status, startSlot, minutesBeforeStart }) => {
          const start = base.plus({ minutes: 30 * startSlot });
          const now = start.minus({ minutes: minutesBeforeStart });
          const expected = now.toMillis() >= provisionalDeadline(start).toMillis();
          expect(needsProvisionalDeadlineWarning({ status, start, now })).toBe(expected);
          expect(
            needsProvisionalDeadlineWarning({ status, start: start.toUTC(), now: now.toUTC() }),
          ).toBe(expected);
        }),
      );
    });
  });
});

describe("第二キープ", () => {
  // 既存の仮予約 P 13:00–15:00（占有区間 13:00–16:00）と、P に付いた第二キープ K 14:00–17:00（占有区間 14:00–18:00）
  function reservationP(zone: Zone): Reservation {
    return reservation(zone, {
      id: "P",
      status: "provisional",
      start: oct20("13:00"),
      end: oct20("15:00"),
    });
  }
  function reservationK(zone: Zone): Reservation {
    return reservation(zone, {
      id: "K",
      status: "second-hold",
      start: oct20("14:00"),
      end: oct20("17:00"),
      provisionalIds: ["P"],
    });
  }

  // 取消の日時は例にないので 10/10 12:00 とする（仮予約・第二キープの取消は無料なので、結果に関わらない）
  function cancel(zone: Zone, reservationId: string): ReservationOperation {
    return { kind: "cancel", reservationId, cancelledAt: at("2026-10-10T12:00", zone) };
  }

  describe("P と K の出来事。", () => {
    // 「お客様が承諾」はシステムの外（電話・メール）で受けるので、操作はない
    it("P が取消 → お客様が承諾 → 管理者が繰り上げ：K は仮予約になる", () => {
      for (const zone of zones) {
        const before = [reservationP(zone), reservationK(zone)];
        expectRange(occupiedRange(before[0]!, 60), oct20("13:00"), oct20("16:00"), zone);
        expectRange(occupiedRange(before[1]!, 60), oct20("14:00"), oct20("18:00"), zone);

        // P の取消：K は第二キープのまま枠を確保し、K のお客様への案内の下書きができる（K はほかの仮予約に付いていない）
        const cancelled = operate(before, cancel(zone, "P"));
        expect(find(cancelled.reservations, "P").status, zone).toBe("cancelled");
        const kAfterCancel = find(cancelled.reservations, "K");
        expect(kAfterCancel.status, zone).toBe("second-hold");
        expect(kAfterCancel.provisionalIds, zone).toEqual(["P"]);
        expectDrafts(
          cancelled.drafts,
          [
            { kind: "cancellation", reservationId: "P", cancellationFee: noFee },
            { kind: "move-up-notice", reservationId: "K", remainingProvisionalIds: [] },
          ],
          zone,
        );

        // 繰り上げ：K は仮予約になり、付いている仮予約の id はなくなる。占有区間は変わらないので、解放する枠はない
        const movedUp = operate(cancelled.reservations, { kind: "move-up", reservationId: "K" });
        const k = find(movedUp.reservations, "K");
        expect(k.status, zone).toBe("provisional");
        expect(k.provisionalIds, zone).toEqual([]);
        expectRange(k, oct20("14:00"), oct20("17:00"), zone);
        expectReleased(movedUp.released, [], zone);
      }
    });

    // 後からの申込は、普通の申込の空き判定（checkAvailability）で確かめる
    it("P が取消 → 繰り上げ前に 13:00–15:00（占有区間 13:00–16:00）の申込が来る：申込は不可（Kと重なる）。K はそのまま繰り上げられる", () => {
      for (const zone of zones) {
        const cancelled = operate([reservationP(zone), reservationK(zone)], cancel(zone, "P"));
        const applied = { start: at(oct20("13:00"), zone), end: at(oct20("15:00"), zone) };
        expectRange(occupiedRange(applied, 60), oct20("13:00"), oct20("16:00"), zone);
        expect(
          checkAvailability({
            ...applied,
            bufferMinutes: 60,
            reservations: [...cancelled.reservations],
            blocks: [],
          }),
          zone,
        ).toEqual({ ok: false, reason: "overlaps-existing" });

        const movedUp = operate(cancelled.reservations, { kind: "move-up", reservationId: "K" });
        const k = find(movedUp.reservations, "K");
        expect(k.status, zone).toBe("provisional");
        expect(k.provisionalIds, zone).toEqual([]);
      }
    });

    // 「辞退」はシステムの外で受けるので、操作はない
    it("P が取消 → K のお客様が辞退 → 管理者が取消：K は取消。14:00–18:00 の枠を解放する", () => {
      for (const zone of zones) {
        const cancelledP = operate([reservationP(zone), reservationK(zone)], cancel(zone, "P"));
        const cancelledK = operate(cancelledP.reservations, cancel(zone, "K"));
        expect(find(cancelledK.reservations, "K").status, zone).toBe("cancelled");
        expectReleased(cancelledK.released, [[oct20("14:00"), oct20("18:00")]], zone);
        expect(cancelledK.drafts, zone).toContainEqual({
          kind: "cancellation",
          reservationId: "K",
          cancellationFee: noFee,
        });
      }
    });

    it("管理者が P を本予約に昇格：K は終了。Pと重ならない 16:00–18:00 の枠を解放する（通知の下書きができる）", () => {
      for (const zone of zones) {
        const result = operate([reservationP(zone), reservationK(zone)], {
          kind: "promote",
          reservationId: "P",
        });
        expect(find(result.reservations, "P").status, zone).toBe("firm");
        expect(find(result.reservations, "K").status, zone).toBe("ended");
        expectReleased(result.released, [[oct20("16:00"), oct20("18:00")]], zone);
        expectDrafts(
          result.drafts,
          [
            { kind: "promotion", reservationId: "P" },
            { kind: "second-hold-ended", reservationId: "K" },
          ],
          zone,
        );
      }
    });
  });

  // K の取消は、P が仮予約のまま管理者が K を取消す場合で確かめる。K の終了は、管理者が P を本予約に昇格させる場合で確かめる
  describe("前倒しの通知（K は 14:00–17:00、占有区間 14:00–18:00）。", () => {
    function bringForwardDrafts(zone: Zone, behind: Reservation[]) {
      const reservations = [reservationP(zone), reservationK(zone), ...behind];
      const cancelled = operate(reservations, cancel(zone, "K"));
      const ended = operate(reservations, { kind: "promote", reservationId: "P" });
      expect(find(ended.reservations, "K").status, zone).toBe("ended");
      return {
        cancelled: cancelled.drafts.filter((d) => d.kind === "bring-forward-notice"),
        ended: ended.drafts.filter((d) => d.kind === "bring-forward-notice"),
      };
    }

    it("K の後ろの予約が本予約 18:00–20:00、K が取消・終了したとき：前倒しの通知の下書きを作る（18:00で接している）", () => {
      for (const zone of zones) {
        const b = reservation(zone, {
          id: "B",
          status: "firm",
          start: oct20("18:00"),
          end: oct20("20:00"),
        });
        const expected = [{ kind: "bring-forward-notice", reservationId: "B" }];
        const drafts = bringForwardDrafts(zone, [b]);
        expect(drafts.cancelled, `${zone}、K が取消`).toEqual(expected);
        expect(drafts.ended, `${zone}、K が終了`).toEqual(expected);
      }
    });

    it("K の後ろの予約が本予約 18:30–20:30、K が取消・終了したとき：作らない（接していない）", () => {
      for (const zone of zones) {
        const b = reservation(zone, {
          id: "B",
          status: "firm",
          start: oct20("18:30"),
          end: oct20("20:30"),
        });
        const drafts = bringForwardDrafts(zone, [b]);
        expect(drafts.cancelled, `${zone}、K が取消`).toEqual([]);
        expect(drafts.ended, `${zone}、K が終了`).toEqual([]);
      }
    });

    it("K の後ろに予約がない、K が取消・終了したとき：作らない", () => {
      for (const zone of zones) {
        const drafts = bringForwardDrafts(zone, []);
        expect(drafts.cancelled, `${zone}、K が取消`).toEqual([]);
        expect(drafts.ended, `${zone}、K が終了`).toEqual([]);
      }
    });
  });

  describe("プロパティ（INV-1。どの操作の列のあとでも成り立つこと）", () => {
    // 時刻は 10/20 00:00（JST）からの30分単位の枠で作る（10/20〜10/23 の範囲）
    const base = DateTime.fromISO("2026-10-20T00:00", { zone: "Asia/Tokyo" });
    const cancelledAt = DateTime.fromISO("2026-10-10T12:00", { zone: "Asia/Tokyo" });
    const slot = fc.integer({ min: 0, max: 48 * 3 });
    const anyZone = fc.constantFrom(...zones);

    interface Shape {
      startMinutes: number;
      endMinutes: number;
      bufferMinutes: ReservationBufferMinutes;
    }

    // 予約区間：開始・終了は30分単位、長さは2〜24時間。バッファは1時間か30分
    const shape = fc
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

    // 「予約の状態」の節の表：占有区間の枠を確保する状態
    const holdingStatuses: readonly ReservationStatus[] = [
      "pending-provisional",
      "pending-firm",
      "pending-second-hold",
      "provisional",
      "firm",
      "second-hold",
    ];
    const secondHoldStatuses: readonly ReservationStatus[] = ["pending-second-hold", "second-hold"];

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

    function expectInv1(reservations: readonly Reservation[]): void {
      const holding = reservations.filter((r) => isHolding(r.status));
      for (const [i, a] of holding.entries()) {
        for (const b of holding.slice(i + 1)) {
          if (!overlaps(occupied(a), occupied(b))) continue;
          const pair = [a.status, b.status];
          const allowed =
            pair.includes("provisional") && pair.some((status) => isSecondHold(status));
          expect(allowed, `${a.id}（${a.status}）と ${b.id}（${b.status}）が重なる`).toBe(true);
        }
      }
    }

    // 付いている仮予約のうち、まだ仮予約のまま第二キープと重なっているもの
    function stillHeld(k: Reservation, reservations: readonly Reservation[]): boolean {
      return k.provisionalIds.some((id) => {
        const p = reservations.find((r) => r.id === id);
        return p !== undefined && p.status === "provisional" && overlaps(occupied(p), occupied(k));
      });
    }

    function toReservation(
      id: string,
      s: Shape,
      status: ReservationStatus,
      z: Zone,
      provisionalIds: readonly string[] = [],
    ): Reservation {
      return {
        id,
        status,
        start: base.plus({ minutes: s.startMinutes }).setZone(z),
        end: base.plus({ minutes: s.endMinutes }).setZone(z),
        bufferMinutes: s.bufferMinutes,
        provisionalIds,
        confirmedAmount: status.startsWith("pending-") ? null : confirmedAmount,
      };
    }

    function shapeInterval(s: Shape): Interval {
      const start = base.plus({ minutes: s.startMinutes }).toMillis();
      return [start, base.plus({ minutes: s.endMinutes + s.bufferMinutes }).toMillis()];
    }

    // 操作した予約のほかに状態が変わってよいのは、昇格した仮予約に付いている第二キープ（承認待ちを含む）だけ。
    // どの操作でも予約区間・バッファは変わらない。解放される枠は、確保している占有区間の操作の前後の差
    function expectOperationResult(
      before: readonly Reservation[],
      operation: ReservationOperation,
      result: Extract<ReturnType<typeof applyReservationOperation>, { ok: true }>,
    ): void {
      const after = result.reservations;
      expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));

      const endedIds =
        operation.kind === "promote"
          ? before
              .filter(
                (r) => isSecondHold(r.status) && r.provisionalIds.includes(operation.reservationId),
              )
              .map((r) => r.id)
          : [];
      for (const [i, b] of before.entries()) {
        const a = after[i]!;
        expect(occupied(a), `${b.id} の占有区間`).toEqual(occupied(b));
        if (b.id === operation.reservationId) {
          if (operation.kind === "promote") expect(a.status).toBe("firm");
          if (operation.kind === "cancel") expect(a.status).toBe("cancelled");
          if (operation.kind === "move-up") {
            expect(a.status).toBe("provisional");
            expect(a.provisionalIds).toEqual([]);
          }
        } else if (endedIds.includes(b.id)) {
          expect(a.status, `${b.id}（${b.status}）は昇格で終了する`).toBe("ended");
        } else {
          expect(a.status, `${b.id} の状態`).toBe(b.status);
          expect(a.provisionalIds, `${b.id} の仮予約の id`).toEqual(b.provisionalIds);
          expect(a.confirmedAmount, `${b.id} の確定金額`).toBe(b.confirmedAmount);
        }
      }

      expect(
        result.released.map((range): Interval => [range.start.toMillis(), range.end.toMillis()]),
        "解放される枠",
      ).toEqual(subtract(holdingIntervals(before), holdingIntervals(after)));
    }

    // 操作の列：申込（仮予約・本予約。承認は枠を変えないので、申込のときに承認済みにするかを決める。直接入力も同じ）、
    // 第二キープの申込（承認待ちか、承認済み）、昇格、取消、第二キープの繰り上げ。
    // 申込はテストの側で空き判定（checkAvailability・checkSecondHoldApplication）を通ったものだけを足す。
    // 操作は、その操作ができる状態（reservation-model.md「状態と操作」）の予約に対して行う
    const step = fc.oneof(
      fc.record({
        kind: fc.constant("apply" as const),
        shape,
        status: fc.constantFrom<ReservationStatus>(
          "pending-provisional",
          "pending-firm",
          "provisional",
          "provisional",
          "firm",
        ),
      }),
      fc.record({
        kind: fc.constant("apply-second-hold" as const),
        shape,
        approve: fc.boolean(),
      }),
      fc.record({
        kind: fc.constantFrom("promote" as const, "cancel" as const, "move-up" as const),
        pick: fc.nat(),
      }),
    );

    const targetStatuses = {
      promote: ["provisional"],
      cancel: ["provisional", "firm", "second-hold"],
      "move-up": ["second-hold"],
    } as const satisfies Record<ReservationOperation["kind"], readonly ReservationStatus[]>;

    it("昇格・取消・繰り上げと申込のどの列のあとでも、枠を確保している予約の占有区間は、第二キープと承認済みの仮予約の組を除いて重ならない。解放される枠は、確保している占有区間の操作の前後の差", () => {
      fc.assert(
        fc.property(fc.array(step, { maxLength: 20 }), anyZone, (steps, z) => {
          let reservations: Reservation[] = [];
          let next = 0;
          for (const s of steps) {
            if (s.kind === "apply") {
              const r = toReservation(`r${next++}`, s.shape, s.status, z);
              if (
                checkAvailability({
                  start: r.start,
                  end: r.end,
                  bufferMinutes: r.bufferMinutes,
                  reservations: [...reservations],
                  blocks: [],
                }).ok
              ) {
                reservations = [...reservations, r];
              }
            } else if (s.kind === "apply-second-hold") {
              const r = toReservation(
                `r${next++}`,
                s.shape,
                s.approve ? "second-hold" : "pending-second-hold",
                z,
              );
              const checked = checkSecondHoldApplication({
                start: r.start,
                end: r.end,
                bufferMinutes: r.bufferMinutes,
                reservations: [...reservations],
                blocks: [],
              });
              if (checked.ok) {
                reservations = [...reservations, { ...r, provisionalIds: checked.provisionalIds }];
              }
            } else {
              const allowed: readonly ReservationStatus[] = targetStatuses[s.kind];
              const candidates = reservations.filter((r) => allowed.includes(r.status));
              if (candidates.length === 0) continue;
              const target = candidates[s.pick % candidates.length]!;
              const operation: ReservationOperation =
                s.kind === "cancel"
                  ? {
                      kind: "cancel",
                      reservationId: target.id,
                      cancelledAt: cancelledAt.setZone(z),
                    }
                  : { kind: s.kind, reservationId: target.id };
              const result = applyReservationOperation({ reservations, operation });

              // 繰り上げできるのは、付いている仮予約がすべて取消になったか、重ならなくなった第二キープだけ。
              // そうなっていれば必ず成功する。昇格と取消は、その状態の予約なら必ず成功する
              if (s.kind === "move-up" && stillHeld(target, reservations)) {
                expect(result).toEqual({ ok: false, reason: "still-held" });
                continue;
              }
              if (!result.ok) {
                throw new Error(
                  `${s.kind} ${target.id}（${target.status}）が失敗した（${result.reason}）`,
                );
              }
              expectOperationResult(reservations, operation, result);
              reservations = [...result.reservations];
            }
            expectInv1(reservations);
          }
        }),
      );
    });

    // 仮予約を動かす操作（予約の変更）はこの関数にないので、動いて重ならなくなった仮予約は、状態を組み立てて作る
    it("繰り上げは、付いている仮予約がすべて取消か重ならなくなっていれば必ず成功する。まだ仮予約のまま重なっているものが残っていれば不可（still-held）", () => {
      const fate = fc.constantFrom("cancelled" as const, "moved" as const, "remaining" as const);
      const otherStatus = fc.constantFrom<ReservationStatus>(
        "pending-provisional",
        "pending-firm",
        "provisional",
        "firm",
        "cancelled",
        "ended",
      );
      fc.assert(
        fc.property(
          shape,
          fc.array(fc.record({ shape, fate }), { minLength: 1, maxLength: 3 }),
          fc.array(fc.record({ shape, status: otherStatus }), { maxLength: 4 }),
          anyZone,
          (kShape, attached, others, z) => {
            const kInterval = shapeInterval(kShape);
            // K のほかに枠を確保しているもの（K と重なってよいのは、付いていてまだ重なっている仮予約だけ）
            const holding: Interval[] = [];
            const items: Reservation[] = [];
            const attachedIds: string[] = [];
            let remaining = 0;
            for (const [i, a] of attached.entries()) {
              const interval = shapeInterval(a.shape);
              const id = `p${i}`;
              if (a.fate === "cancelled") {
                items.push(toReservation(id, a.shape, "cancelled", z));
              } else {
                const overlapsK = overlaps(interval, kInterval);
                if (overlapsK !== (a.fate === "remaining")) continue;
                if (holding.some((h) => overlaps(h, interval))) continue;
                holding.push(interval);
                items.push(toReservation(id, a.shape, "provisional", z));
                if (a.fate === "remaining") remaining += 1;
              }
              attachedIds.push(id);
            }
            fc.pre(attachedIds.length >= 1);
            for (const [i, o] of others.entries()) {
              const interval = shapeInterval(o.shape);
              if (isHolding(o.status)) {
                if (overlaps(interval, kInterval) || holding.some((h) => overlaps(h, interval))) {
                  continue;
                }
                holding.push(interval);
              }
              items.push(toReservation(`o${i}`, o.shape, o.status, z));
            }
            const k = toReservation("K", kShape, "second-hold", z, attachedIds);
            const reservations = [...items, k];
            expectInv1(reservations);

            const result = applyReservationOperation({
              reservations,
              operation: { kind: "move-up", reservationId: "K" },
            });
            if (remaining > 0) {
              expect(result).toEqual({ ok: false, reason: "still-held" });
              return;
            }
            if (!result.ok) {
              throw new Error(`繰り上げが失敗した（${result.reason}）`);
            }
            const movedUp = find(result.reservations, "K");
            expect(movedUp.status).toBe("provisional");
            expect(movedUp.provisionalIds).toEqual([]);
            expectInv1(result.reservations);
          },
        ),
      );
    });
  });
});
