import fc from "fast-check";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { checkApplicationDeadline } from "./application-deadline";
import type { TimeRange } from "./availability";
import { provisionalDeadline } from "./provisional-deadline";
import {
  type ReservationChangeTimeRejection,
  type ReservationChangeTimeResult,
  type ReservationChangeTimeStatus,
  type ReservationChangeTimeWarning,
  checkReservationChangeTime,
} from "./reservation-change-time";
import { checkTimeUnitAndDuration } from "./time-unit-and-duration";

// 予約の変更で日時を変えるときの、直接入力と同じ決まりの判定（booking.md「予約の変更」）。
// 空き判定・見積・下書きなど、変更のほかの行は reservation-change.test.ts にある。
// 判定は現在時刻を使わない。管理者が変更を操作する日時（changedAt）を引数で渡して固定する（INV-7）

// 仕様の日時は JST で書かれている（INV-7）。例の表には年がないので 2026 年とする。
// 例の各行は、JST で表した日時と、同じ時点を UTC で表した日時の両方で確かめる（docs/TESTING.md「仕様の例とテストの対応づけ」）。
// 変更前の予約区間は DB から読んだもの（UTC）、変更後の予約区間と操作の日時は管理画面から来たもの（JST）になりうるので、
// 変更前と、変更後・操作の日時を別々のゾーンで表した組み合わせでも確かめる
const zones = ["Asia/Tokyo", "UTC"] as const;
type Zone = (typeof zones)[number];

interface ZonePair {
  /** 変更前の予約区間のゾーン */
  reservation: Zone;
  /** 変更後の予約区間と、操作の日時のゾーン */
  operation: Zone;
}
const zonePairs: readonly ZonePair[] = zones.flatMap((reservation) =>
  zones.map((operation) => ({ reservation, operation })),
);
function label(pair: ZonePair): string {
  return `変更前 ${pair.reservation}、変更後と操作の日時 ${pair.operation}`;
}

function at(iso: string, zone: Zone): DateTime {
  const dateTime = DateTime.fromISO(iso, { zone: "Asia/Tokyo" });
  if (!dateTime.isValid) {
    throw new Error(`テストの日時が不正：${iso}`);
  }
  return dateTime.setZone(zone);
}

function range(start: string, end: string, zone: Zone): TimeRange {
  return { start: at(start, zone), end: at(end, zone) };
}

// 例の行に、管理者が変更を操作する日時が書かれていないときの日時。どの行でも、変更前・変更後の締め切り
// （本予約の24時間前・仮予約の期限）より前。その行で当てはまる警告・理由が、行に書かれたものだけになるようにする
const changedBeforeDeadlines = "2026-10-01T10:00";

function changeTime(
  pair: ZonePair,
  fields: {
    status: ReservationChangeTimeStatus;
    before: readonly [string, string];
    after: readonly [string, string];
    changedAt?: string;
  },
): ReservationChangeTimeResult {
  return checkReservationChangeTime({
    status: fields.status,
    before: range(fields.before[0], fields.before[1], pair.reservation),
    after: range(fields.after[0], fields.after[1], pair.operation),
    changedAt: at(fields.changedAt ?? changedBeforeDeadlines, pair.operation),
  });
}

// 結果の形（reservation-change-time.ts）：
// - 変えられる：{ ok: true, warnings }。「警告。確認すれば変えられる」は、warnings にその警告があり ok: true であること。
//   管理者の確認を受けてから保存するのは、呼ぶ側（管理 API・管理画面）
// - 不可：{ ok: false, reason }
// 警告は締め切りだけ（本予約は開始の24時間前、仮予約は仮予約の期限）なので、当てはまる警告は多くても1つ。
// 不可の理由が2つ以上当てはまるとき（例：30分単位でなく2時間未満）にどれを返すかは仕様にない（booking.md の未決事項）ので、
// テストしない（例の行は、どれも当てはまる理由が1つだけ）

describe("予約の変更", () => {
  describe("本予約 A が 10/20 10:00–12:00（占有区間 10:00–13:00、金額 11,000円）の場合。", () => {
    const a = ["2026-10-20T10:00", "2026-10-20T12:00"] as const;

    it("A を 10/20 10:00–11:00 に短縮：不可（2時間未満）", () => {
      for (const pair of zonePairs) {
        expect(
          changeTime(pair, {
            status: "firm",
            before: a,
            after: ["2026-10-20T10:00", "2026-10-20T11:00"],
          }),
          label(pair),
        ).toEqual({ ok: false, reason: "shorter-than-2-hours" });
      }
    });

    it("A を 10/20 10:00–10/21 10:30 に延長：不可（24時間を超える）", () => {
      for (const pair of zonePairs) {
        expect(
          changeTime(pair, {
            status: "firm",
            before: a,
            after: ["2026-10-20T10:00", "2026-10-21T10:30"],
          }),
          label(pair),
        ).toEqual({ ok: false, reason: "longer-than-24-hours" });
      }
    });

    it("A を 10/20 10:15–12:15 に移動：不可（30分単位でない）", () => {
      for (const pair of zonePairs) {
        expect(
          changeTime(pair, {
            status: "firm",
            before: a,
            after: ["2026-10-20T10:15", "2026-10-20T12:15"],
          }),
          label(pair),
        ).toEqual({ ok: false, reason: "not-on-30-minute-boundary" });
      }
    });

    // 変更後の開始 10/20 15:00 の24時間前は 10/19 15:00
    it("10/20 9:00 に、A を 10/20 15:00–17:00 に移動：締め切り（変更後の開始の24時間前）を過ぎているので警告。確認すれば変えられる", () => {
      for (const pair of zonePairs) {
        expect(
          changeTime(pair, {
            status: "firm",
            before: a,
            after: ["2026-10-20T15:00", "2026-10-20T17:00"],
            changedAt: "2026-10-20T09:00",
          }),
          label(pair),
        ).toEqual({ ok: true, warnings: ["past-24-hours-before-start"] });
      }
    });

    // 人数だけの変更では、変更後の予約区間は変更前と同じ時点（ゾーンの表し方が違っても、同じ時点なら日時を変えていない）。
    // A の開始 10/20 10:00 の24時間前（10/19 10:00）は過ぎているが、警告は出さない
    it("10/20 9:00 に、A の人数だけを変える：可。日時を変えないので、締め切りの警告は出さない", () => {
      for (const pair of zonePairs) {
        expect(
          changeTime(pair, {
            status: "firm",
            before: a,
            after: a,
            changedAt: "2026-10-20T09:00",
          }),
          label(pair),
        ).toEqual({ ok: true, warnings: [] });
      }
    });
  });

  describe("仮予約 P が 10/20 15:00–19:00（仮予約の期限は 10/13 18:00）の場合。", () => {
    it("10/14 12:00 に、P を 10/18 15:00–19:00 に移動：変更後の仮予約の期限（10/11 18:00）を過ぎているので警告。確認すれば変えられる", () => {
      for (const pair of zonePairs) {
        expect(
          provisionalDeadline(at("2026-10-18T15:00", pair.operation)).toMillis(),
          label(pair),
        ).toBe(at("2026-10-11T18:00", pair.operation).toMillis());
        expect(
          changeTime(pair, {
            status: "provisional",
            before: ["2026-10-20T15:00", "2026-10-20T19:00"],
            after: ["2026-10-18T15:00", "2026-10-18T19:00"],
            changedAt: "2026-10-14T12:00",
          }),
          label(pair),
        ).toEqual({ ok: true, warnings: ["past-provisional-deadline"] });
      }
    });
  });

  describe("プロパティ（INV-7。どの入力でも成り立つこと）：日時を変えるときの、直接入力と同じ決まり", () => {
    // 時刻は 10/20 00:00（JST）からの分の数で作る（10/20〜10/24 の範囲）
    const base = DateTime.fromISO("2026-10-20T00:00", { zone: "Asia/Tokyo" });
    const anyZone = fc.constantFrom(...zones);
    const anyStatus = fc.constantFrom<ReservationChangeTimeStatus>("provisional", "firm");

    interface Shape {
      startMinutes: number;
      endMinutes: number;
    }

    // 変更前の予約区間：開始・終了は30分単位、長さは30分〜24時間のうち、決まり（最短時間）を満たすもの
    // （「日時を変えない変更では、もとの予約がすでに決まりを満たしているので確かめない」。下の validBefore）
    const gridShape = fc
      .record({
        startSlot: fc.integer({ min: 0, max: 48 * 4 }),
        lengthSlots: fc.integer({ min: 1, max: 48 }),
      })
      .map(({ startSlot, lengthSlots }): Shape => ({
        startMinutes: startSlot * 30,
        endMinutes: (startSlot + lengthSlots) * 30,
      }));

    // 変更後の予約区間：30分単位で長さ30分〜30時間のものと、分単位で長さ1分〜30時間のもの
    const afterShape = fc.oneof(
      fc
        .record({
          startSlot: fc.integer({ min: 0, max: 48 * 4 }),
          lengthSlots: fc.integer({ min: 1, max: 60 }),
        })
        .map(({ startSlot, lengthSlots }): Shape => ({
          startMinutes: startSlot * 30,
          endMinutes: (startSlot + lengthSlots) * 30,
        })),
      fc
        .record({
          startMinutes: fc.integer({ min: 0, max: 60 * 24 * 4 }),
          lengthMinutes: fc.integer({ min: 1, max: 60 * 30 }),
        })
        .map(({ startMinutes, lengthMinutes }): Shape => ({
          startMinutes,
          endMinutes: startMinutes + lengthMinutes,
        })),
    );

    // 管理者が変更を操作する日時：10/20 00:00 の30日前から、範囲の終わり（10/25）まで（分単位）。
    // 変更前・変更後の開始より後に操作する場合も含む
    const changedAtMinutes = fc.integer({ min: -60 * 24 * 30, max: 60 * 24 * 5 });

    function toDateTime(minutes: number, zone: Zone): DateTime {
      return base.plus({ minutes }).setZone(zone);
    }
    function toRange(shape: Shape, zone: Zone): TimeRange {
      return {
        start: toDateTime(shape.startMinutes, zone),
        end: toDateTime(shape.endMinutes, zone),
      };
    }

    // 予約区間が深夜帯（JST の 23:00〜翌8:00）に少しでもかかるか。分の数は JST の 0:00 から数えている
    function overlapsLateNight(shape: Shape): boolean {
      const firstDay = Math.floor(shape.startMinutes / (60 * 24)) - 1;
      const lastDay = Math.floor(shape.endMinutes / (60 * 24)) + 1;
      for (let day = firstDay; day <= lastDay; day += 1) {
        // day 日の 23:00 から day + 1 日の 8:00 まで
        const nightStart = day * 60 * 24 + 23 * 60;
        const nightEnd = (day + 1) * 60 * 24 + 8 * 60;
        if (shape.startMinutes < nightEnd && nightStart < shape.endMinutes) return true;
      }
      return false;
    }

    // 当てはまる不可の理由を、分の数で求める（「時間の単位と利用時間」の節）。JST と UTC の時差は整数の時間なので、
    // 30分単位かどうかは、どちらのゾーンで表しても同じ。深夜帯は JST で判定する
    function applicableRejections(shape: Shape): ReservationChangeTimeRejection[] {
      const length = shape.endMinutes - shape.startMinutes;
      const reasons: ReservationChangeTimeRejection[] = [];
      if (shape.startMinutes % 30 !== 0 || shape.endMinutes % 30 !== 0) {
        reasons.push("not-on-30-minute-boundary");
      }
      if (length < 120) reasons.push("shorter-than-2-hours");
      if (overlapsLateNight(shape) && length < 240) reasons.push("late-night-shorter-than-4-hours");
      if (length > 60 * 24) reasons.push("longer-than-24-hours");

      // テストの側の計算を、既存の申込の判定（checkTimeUnitAndDuration）と突き合わせる
      const duration = checkTimeUnitAndDuration(
        base.plus({ minutes: shape.startMinutes }),
        base.plus({ minutes: shape.endMinutes }),
      );
      if (duration.ok) {
        expect(reasons, "テストの側の計算が申込の判定と合わない").toEqual([]);
      } else {
        expect(reasons, "テストの側の計算が申込の判定と合わない").toContain(duration.reason);
      }
      return reasons;
    }

    const validBefore = gridShape.filter((shape) => applicableRejections(shape).length === 0);

    // 当てはまる警告を、申込の締め切りの判定（「申込の締め切り」の節）から求める。
    // 締め切りは、変更後の開始で数える（本予約は開始の24時間前、仮予約は変更後の利用日の仮予約の期限）。
    // 本予約・仮予約で締め切りは1つずつなので、警告は多くても1つ
    function expectedWarnings(
      status: ReservationChangeTimeStatus,
      after: Shape,
      changedAt: number,
    ): ReservationChangeTimeWarning[] {
      const deadline = checkApplicationDeadline({
        kind: status,
        start: base.plus({ minutes: after.startMinutes }),
        appliedAt: base.plus({ minutes: changedAt }),
      });
      if (deadline.ok) return [];
      if (
        deadline.reason === "past-24-hours-before-start" ||
        deadline.reason === "past-provisional-deadline"
      ) {
        return [deadline.reason];
      }
      throw new Error(`締め切りの理由が想定外：${String(deadline.reason)}`);
    }

    function sameRange(a: Shape, b: Shape): boolean {
      return a.startMinutes === b.startMinutes && a.endMinutes === b.endMinutes;
    }

    // 不可の理由が2つ以上当てはまるとき（例：30分単位でなく2時間未満、2時間未満で深夜帯にかかり4時間未満）に
    // どれを返すかは、仕様にない（未決事項）ので決めない。当てはまる理由のどれかであればよい
    it("日時を変えるときは、変更後の予約区間が30分単位でなければ不可、最短時間（2時間、深夜帯にかかるときは4時間）に満たなければ不可、24時間を超えれば不可（例外を認めない）。そうでなければ変えられ、変更後の開始と操作の日時で締め切りを過ぎていれば警告を返す。変更前の予約区間は結果に関わらない。同じ時点を UTC で渡しても同じ結果", () => {
      fc.assert(
        fc.property(
          anyStatus,
          validBefore,
          afterShape,
          changedAtMinutes,
          anyZone,
          anyZone,
          (status, before, after, changedAt, reservationZone, operationZone) => {
            fc.pre(!sameRange(before, after));
            const result = checkReservationChangeTime({
              status,
              before: toRange(before, reservationZone),
              after: toRange(after, operationZone),
              changedAt: toDateTime(changedAt, operationZone),
            });
            const rejections = applicableRejections(after);
            if (rejections.length > 0) {
              expect(rejections.map((reason) => ({ ok: false, reason }))).toContainEqual(result);
              return;
            }
            expect(result).toEqual({
              ok: true,
              warnings: expectedWarnings(status, after, changedAt),
            });
          },
        ),
      );
    });

    it("日時を変えない変更（変更後の予約区間が変更前と同じ時点）では判定せず、操作の日時によらず変えられて警告も出さない。ゾーンの表し方が違っても同じ時点なら同じ結果", () => {
      fc.assert(
        fc.property(
          anyStatus,
          validBefore,
          changedAtMinutes,
          anyZone,
          anyZone,
          (status, shape, changedAt, reservationZone, operationZone) => {
            expect(
              checkReservationChangeTime({
                status,
                before: toRange(shape, reservationZone),
                after: toRange(shape, operationZone),
                changedAt: toDateTime(changedAt, operationZone),
              }),
            ).toEqual({ ok: true, warnings: [] });
          },
        ),
      );
    });
  });
});
