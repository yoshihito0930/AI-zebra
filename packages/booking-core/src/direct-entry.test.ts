import { ReservationStatus } from "@zebra/contracts";
import fc from "fast-check";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { checkApplicationDeadline } from "./application-deadline";
import {
  type BufferMinutes,
  type ExistingBlock,
  type ExistingReservation,
  type ReservationBufferMinutes,
  type TimeRange,
  occupiedRange,
} from "./availability";
import { checkAdminBlock } from "./blocks";
import {
  type DirectEntryKind,
  type DirectEntryResult,
  type DirectEntryWarning,
  checkDirectEntry,
} from "./direct-entry";
import { provisionalDeadline } from "./provisional-deadline";
import { checkSecondHoldApplicationDeadline } from "./second-hold-application-deadline";
import { checkTimeUnitAndDuration } from "./time-unit-and-duration";

// 直接入力の判定は現在時刻を使わない。管理者が入れる日時（enteredAt）を引数で渡して固定する（INV-7）

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

// 区間が、JST で書いた [start, end) と同じ時点かを確かめる（ゾーンの表し方は問わない）
function expectRange(range: TimeRange, start: string, end: string, message: string): void {
  expect(range.start.toUTC().toISO(), message).toBe(at(start, "UTC").toISO());
  expect(range.end.toUTC().toISO(), message).toBe(at(end, "UTC").toISO());
}

// 例の行に、管理者が入れる日時が書かれていないときの日時。どの行でも締め切り（本予約の24時間前・仮予約の期限）より前。
// その行で当てはまる警告が、行に書かれたものだけになるようにする
const enteredBeforeDeadlines = "2026-10-01T10:00";

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

// 直接入れる予約のバッファも1時間（初期値。reservation-model.md「予約が持つもの」）
function enter(
  zone: Zone,
  fields: {
    kind: DirectEntryKind;
    start: string;
    end: string;
    enteredAt?: string;
    reservations?: readonly ExistingReservation[];
  },
): DirectEntryResult {
  return checkDirectEntry({
    kind: fields.kind,
    start: at(fields.start, zone),
    end: at(fields.end, zone),
    bufferMinutes: 60,
    enteredAt: at(fields.enteredAt ?? enteredBeforeDeadlines, zone),
    reservations: fields.reservations ?? [],
    blocks: [],
  });
}

// 結果の形（direct-entry.ts）：
// - 入れられる：{ ok: true, warnings, provisionalIds }。「警告。確認すれば入る」は、warnings にその警告があり ok: true であること。
//   管理者の確認を受けてから保存するのは、呼ぶ側（管理 API・管理画面）
// - 不可：{ ok: false, reason }
// 警告は締め切りだけ（本予約は開始の24時間前、仮予約と第二キープは仮予約の期限）なので、当てはまる警告は多くても1つ。
// 最短時間（2時間、深夜帯を含むときは4時間）に満たない予約は不可（booking.md e5fb5cd で警告から不可に変わった）。
// 不可の理由が2つ以上当てはまるときにどれを返すかは仕様にない（未決事項）ので、テストしない（例の行は、どれも当てはまる理由が1つだけ）。
// 最短時間の理由（shorter-than-2-hours・late-night-shorter-than-4-hours）は、今の DirectEntryRejection の型にないので、
// 型ではなく戻り値の値で確かめる（ユーザーの判断。実装担当が型を直す）

// ブロック枠の行（「ブロック枠のバッファ」）は blocks.test.ts にある
describe("管理者による予約の直接入力とブロック枠", () => {
  it("10/20 9:00 に、管理者が 10/20 15:00–17:00 の本予約を入れる：締め切り（24時間前）を過ぎているので警告。確認すれば入る", () => {
    for (const zone of zones) {
      expect(
        enter(zone, {
          kind: "firm",
          start: "2026-10-20T15:00",
          end: "2026-10-20T17:00",
          enteredAt: "2026-10-20T09:00",
        }),
        zone,
      ).toEqual({ ok: true, warnings: ["past-24-hours-before-start"], provisionalIds: [] });
    }
  });

  // 利用日は例にないので 10/20 とする
  it("管理者が 10/20 10:00–11:00 の本予約を入れる：不可（2時間未満）", () => {
    for (const zone of zones) {
      expect(
        enter(zone, { kind: "firm", start: "2026-10-20T10:00", end: "2026-10-20T11:00" }),
        zone,
      ).toEqual({ ok: false, reason: "shorter-than-2-hours" });
    }
  });

  // 例にない予約区間は、利用日 10/20 の 15:00–17:00（最短時間を満たす）とする。仮予約の期限は 10/13 18:00。
  // 「利用日の5日前」は 10/15 の一日なので、その日の始め・昼・終わりで確かめる
  // （UTC では 10/15 00:00 が 10/14 15:00 になる。どちらでも期限を過ぎている）
  it("管理者が、利用日の5日前に仮予約を入れる：仮予約の期限を過ぎているので警告。確認すれば入る", () => {
    for (const zone of zones) {
      for (const enteredAt of ["2026-10-15T00:00", "2026-10-15T12:00", "2026-10-15T23:59"]) {
        expect(
          enter(zone, {
            kind: "provisional",
            start: "2026-10-20T15:00",
            end: "2026-10-20T17:00",
            enteredAt,
          }),
          `${zone}、${enteredAt}`,
        ).toEqual({ ok: true, warnings: ["past-provisional-deadline"], provisionalIds: [] });
      }
    }
  });

  // 「予約」の種類は書かれていないので、仮予約・本予約・第二キープのすべてで確かめる。
  // 第二キープは、付く仮予約がない理由（no-provisional-to-hold）が重ならないように、承認済みの仮予約 P 10/20 10:00–12:00 と重ねる
  it("管理者が 10/20 10:15–12:15 の予約を入れる：不可（30分単位でない）", () => {
    for (const zone of zones) {
      for (const kind of ["provisional", "firm"] as const) {
        expect(
          enter(zone, { kind, start: "2026-10-20T10:15", end: "2026-10-20T12:15" }),
          `${zone}、${kind}`,
        ).toEqual({ ok: false, reason: "not-on-30-minute-boundary" });
      }
      const p = reservation(zone, "P", "provisional", "2026-10-20T10:00", "2026-10-20T12:00");
      expect(
        enter(zone, {
          kind: "second-hold",
          start: "2026-10-20T10:15",
          end: "2026-10-20T12:15",
          reservations: [p],
        }),
        `${zone}、second-hold`,
      ).toEqual({ ok: false, reason: "not-on-30-minute-boundary" });
    }
  });

  // 既存の本予約は A 10/20 10:00–12:00（占有区間 10:00–13:00）、入れる予約は 10/20 11:00–13:00 とする。
  // 「予約」の種類は書かれていないので、すべてで確かめる。第二キープは、付く仮予約がない理由が重ならないように、
  // 承認済みの仮予約 P 10/20 13:00–15:00（占有区間 13:00–16:00。A とは 13:00 で接するだけ）とも重ねる
  it("管理者が、既存の本予約と重なる予約を入れる：不可（空き判定）", () => {
    for (const zone of zones) {
      const a = reservation(zone, "A", "firm", "2026-10-20T10:00", "2026-10-20T12:00");
      expectRange(occupiedRange(a, 60), "2026-10-20T10:00", "2026-10-20T13:00", zone);
      for (const kind of ["provisional", "firm"] as const) {
        expect(
          enter(zone, {
            kind,
            start: "2026-10-20T11:00",
            end: "2026-10-20T13:00",
            reservations: [a],
          }),
          `${zone}、${kind}`,
        ).toEqual({ ok: false, reason: "overlaps-existing" });
      }
      const p = reservation(zone, "P", "provisional", "2026-10-20T13:00", "2026-10-20T15:00");
      expect(
        enter(zone, {
          kind: "second-hold",
          start: "2026-10-20T11:00",
          end: "2026-10-20T13:00",
          reservations: [a, p],
        }),
        `${zone}、second-hold`,
      ).toEqual({ ok: false, reason: "overlaps-existing" });
    }
  });

  it("管理者が 10/20 10:00–10/21 10:30 の本予約を入れる：不可（24時間を超える）", () => {
    for (const zone of zones) {
      expect(
        enter(zone, { kind: "firm", start: "2026-10-20T10:00", end: "2026-10-21T10:30" }),
        zone,
      ).toEqual({ ok: false, reason: "longer-than-24-hours" });
    }
  });

  // 第二キープの終わりは例にないので、次の行と同じ 17:00 とする（最短時間を満たす）
  it("開始 10/20 15:00 の第二キープを、10/14 12:00 に管理者が入れる。承認済みの仮予約 P 10/20 15:00–17:00 と重なる：仮予約の期限（10/13 18:00）を過ぎているので警告。確認すれば入る。P に付く", () => {
    for (const zone of zones) {
      expect(provisionalDeadline(at("2026-10-20T15:00", zone)).toMillis(), zone).toBe(
        at("2026-10-13T18:00", zone).toMillis(),
      );
      const p = reservation(zone, "P", "provisional", "2026-10-20T15:00", "2026-10-20T17:00");
      expect(
        enter(zone, {
          kind: "second-hold",
          start: "2026-10-20T15:00",
          end: "2026-10-20T17:00",
          enteredAt: "2026-10-14T12:00",
          reservations: [p],
        }),
        zone,
      ).toEqual({ ok: true, warnings: ["past-provisional-deadline"], provisionalIds: ["P"] });
    }
  });

  it("承認済みの仮予約 P 10/20 15:00–17:00 があるときに、管理者が第二キープ 10/20 15:00–17:00 を入れる（締め切りは満たす）：第二キープとして入る。P に付く", () => {
    for (const zone of zones) {
      const p = reservation(zone, "P", "provisional", "2026-10-20T15:00", "2026-10-20T17:00");
      expect(
        enter(zone, {
          kind: "second-hold",
          start: "2026-10-20T15:00",
          end: "2026-10-20T17:00",
          reservations: [p],
        }),
        zone,
      ).toEqual({ ok: true, warnings: [], provisionalIds: ["P"] });
    }
  });

  it("重なる承認済みの仮予約がないときに、管理者が第二キープ 10/20 15:00–17:00 を入れる：不可（付く仮予約がない）", () => {
    for (const zone of zones) {
      expect(
        enter(zone, { kind: "second-hold", start: "2026-10-20T15:00", end: "2026-10-20T17:00" }),
        zone,
      ).toEqual({ ok: false, reason: "no-provisional-to-hold" });
    }
  });

  it("承認待ちの仮予約 10/20 15:00–17:00 があるときに、管理者が第二キープ 10/20 15:00–17:00 を入れる：不可（承認待ちとは重なれない）", () => {
    for (const zone of zones) {
      const pending = reservation(
        zone,
        "P",
        "pending-provisional",
        "2026-10-20T15:00",
        "2026-10-20T17:00",
      );
      expect(
        enter(zone, {
          kind: "second-hold",
          start: "2026-10-20T15:00",
          end: "2026-10-20T17:00",
          reservations: [pending],
        }),
        zone,
      ).toEqual({ ok: false, reason: "overlaps-existing" });
    }
  });

  describe("プロパティ（INV-1・INV-7。どの入力でも成り立つこと）", () => {
    // 時刻は 10/20 00:00（JST）からの分の数で作る（30分単位の枠で 10/20〜10/24 の範囲）
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
    const secondHoldStatuses = [
      "pending-second-hold",
      "second-hold",
    ] as const satisfies readonly ReservationStatus[];

    function isHolding(status: ReservationStatus): boolean {
      return (holdingStatuses as readonly ReservationStatus[]).includes(status);
    }
    function isSecondHold(status: ReservationStatus): boolean {
      return (secondHoldStatuses as readonly ReservationStatus[]).includes(status);
    }

    // 予約区間：開始・終了は30分単位、長さは30分〜24時間（最短時間に満たないものも作り、不可になることを確かめる）。
    // バッファは1時間か30分
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

    // ブロック枠：開始・終了は30分単位、長さは30分〜3日。バッファは「なし／30分／1時間」
    const blockShape = fc
      .record({
        startSlot: slot,
        lengthSlots: fc.integer({ min: 1, max: 48 * 3 }),
        bufferMinutes: fc.constantFrom<BufferMinutes>(0, 30, 60),
      })
      .map(({ startSlot, lengthSlots, bufferMinutes }): Shape => ({
        startMinutes: startSlot * 30,
        endMinutes: (startSlot + lengthSlots) * 30,
        bufferMinutes,
      }));

    // 管理者が入れる日時：開始の30日前から開始まで（分単位）
    const minutesBeforeStart = fc.integer({ min: 0, max: 60 * 24 * 30 });

    const items = fc.array(
      fc.record({ shape: reservationShape, status: fc.constantFrom(...ReservationStatus.options) }),
      { maxLength: 6 },
    );
    const provisionalShapes = fc.array(reservationShape, { maxLength: 3 });
    const blockShapes = fc.array(blockShape, { maxLength: 3 });

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

    function toReservations(list: readonly Item[], z: Zone): ExistingReservation[] {
      return list.map(({ shape, status }, index) => ({
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
      kind: DirectEntryKind,
      entry: Shape,
      before: number,
      list: readonly Item[],
      blocks: readonly Shape[],
      z: Zone,
    ): DirectEntryResult {
      const start = toDateTime(entry.startMinutes, z);
      return checkDirectEntry({
        kind,
        start,
        end: toDateTime(entry.endMinutes, z),
        bufferMinutes: entry.bufferMinutes as ReservationBufferMinutes,
        enteredAt: start.minus({ minutes: before }),
        reservations: toReservations(list, z),
        blocks: toBlocks(blocks, z),
      });
    }

    // 当てはまる警告を、申込の締め切りの判定（「申込の締め切り」の節）から求める。
    // 直接入力の締め切りは申込と同じ（本予約は開始の24時間前、仮予約と第二キープは仮予約の期限）。警告は多くても1つ
    function expectedWarnings(kind: DirectEntryKind, entry: Shape, before: number) {
      const start = base.plus({ minutes: entry.startMinutes });
      const appliedAt = start.minus({ minutes: before });
      const warnings: DirectEntryWarning[] = [];

      const deadline =
        kind === "second-hold"
          ? checkSecondHoldApplicationDeadline({ start, appliedAt })
          : checkApplicationDeadline({ kind, start, appliedAt });
      if (!deadline.ok) {
        if (
          deadline.reason === "past-24-hours-before-start" ||
          deadline.reason === "past-provisional-deadline"
        ) {
          warnings.push(deadline.reason);
        } else {
          throw new Error(`締め切りの理由が想定外：${String(deadline.reason)}`);
        }
      }
      return warnings;
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

    // 当てはまる最短時間の理由（「時間の単位と利用時間」の節。2時間未満、深夜帯にかかり4時間未満）を、分の数で求める。
    // 両方当てはまるとき（例：03:00–04:00）にどちらを返すかは未決事項なので、どちらも返す
    function minimumDurationReasons(shape: Shape): string[] {
      const length = shape.endMinutes - shape.startMinutes;
      const reasons: string[] = [];
      if (length < 120) reasons.push("shorter-than-2-hours");
      if (overlapsLateNight(shape) && length < 240) reasons.push("late-night-shorter-than-4-hours");
      return reasons;
    }

    // 30分単位で24時間以下の予約区間の、最短時間の理由。テストの側の計算を、既存の申込の判定
    // （checkTimeUnitAndDuration。30分単位で24時間以下なので、不可になるのは最短時間だけ）と突き合わせる
    function gridMinimumDurationReasons(shape: Shape): string[] {
      const reasons = minimumDurationReasons(shape);
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

    function rejectedWithOneOf(reasons: readonly string[]) {
      return reasons.map((reason) => ({ ok: false, reason }));
    }

    // 承認済みの仮予約以外の、枠を確保している予約かブロック枠と重なる
    function overlapsOther(entry: Shape, list: readonly Item[], blocks: readonly Shape[]) {
      return (
        list.some(
          ({ shape, status }) =>
            isHolding(status) && status !== "provisional" && occupiedOverlaps(entry, shape),
        ) || blocks.some((block) => occupiedOverlaps(entry, block))
      );
    }

    // 占有区間が重なる承認済みの仮予約の id（toReservations と同じ id。並び順は list の並び順）
    function overlappingProvisionalIds(entry: Shape, list: readonly Item[]): string[] {
      return list.flatMap(({ shape, status }, index) =>
        status === "provisional" && occupiedOverlaps(entry, shape) ? [`r${index}`] : [],
      );
    }

    // 不可の理由が2つ以上当てはまるとき（最短時間と空き判定など）にどれを返すかは未決事項なので、当てはまる理由のどれかであればよい
    it("仮予約・本予約の直接入力は、最短時間（2時間、深夜帯にかかるときは4時間）を満たし、占有区間が、枠を確保している予約とブロック枠のどれとも重ならなければ入る（締め切りを過ぎていれば警告を返す。締め切りは警告だけで、入れるのを止めない）。最短時間に満たなければ不可。重なれば不可（空き判定）。同じ時点を UTC で渡しても同じ結果", () => {
      fc.assert(
        fc.property(
          fc.constantFrom<DirectEntryKind>("provisional", "firm"),
          reservationShape,
          minutesBeforeStart,
          items,
          blockShapes,
          anyZone,
          (kind, entry, before, list, blocks, z) => {
            const overlaps =
              list.some(
                ({ shape, status }) => isHolding(status) && occupiedOverlaps(entry, shape),
              ) || blocks.some((block) => occupiedOverlaps(entry, block));
            const reasons = [
              ...gridMinimumDurationReasons(entry),
              ...(overlaps ? ["overlaps-existing"] : []),
            ];
            const result = check(kind, entry, before, list, blocks, z);
            if (reasons.length > 0) {
              expect(rejectedWithOneOf(reasons)).toContainEqual(result);
            } else {
              expect(result).toEqual({
                ok: true,
                warnings: expectedWarnings(kind, entry, before),
                provisionalIds: [],
              });
            }
          },
        ),
      );
    });

    // 重ならない理由と、ほかと重なる理由が両方当てはまるときにどちらを返すかは決めない（second-hold.test.ts と同じ扱い）。
    // 最短時間の理由とほかの理由が両方当てはまるときも同じ（未決事項）
    it("第二キープの直接入力は、最短時間（2時間、深夜帯にかかるときは4時間）を満たし、承認済みの仮予約の1件以上と重なり、承認済みの仮予約以外の、枠を確保している予約とブロック枠のどれとも重ならなければ入り、重なる承認済みの仮予約すべてに付く（締め切りを過ぎていれば警告を返す）。最短時間に満たなければ不可。ほかと重なれば不可（空き判定）。どの承認済みの仮予約とも重ならなければ不可（付く仮予約がない）。同じ時点を UTC で渡しても同じ結果", () => {
      fc.assert(
        fc.property(
          reservationShape,
          minutesBeforeStart,
          provisionalShapes,
          items,
          blockShapes,
          anyZone,
          (entry, before, provisionals, others, blocks, z) => {
            const list: Item[] = [
              ...provisionals.map((shape): Item => ({ shape, status: "provisional" })),
              ...others,
            ];
            const provisionalIds = overlappingProvisionalIds(entry, list);
            const result = check("second-hold", entry, before, list, blocks, z);
            const reasons = [
              ...gridMinimumDurationReasons(entry),
              ...(overlapsOther(entry, list, blocks) ? ["overlaps-existing"] : []),
              ...(provisionalIds.length === 0 ? ["no-provisional-to-hold"] : []),
            ];
            if (reasons.length > 0) {
              expect(rejectedWithOneOf(reasons)).toContainEqual(result);
            } else {
              expect(result).toEqual({
                ok: true,
                warnings: expectedWarnings("second-hold", entry, before),
                provisionalIds,
              });
            }
          },
        ),
      );
    });

    // 既存の予約・ブロック枠がないので、不可の理由はこれだけ
    it("開始・終了が30分単位でも、24時間を超える予約は、どの種類でも不可（例外を認めない）。同じ時点を UTC で渡しても同じ結果", () => {
      const longShape = fc
        .record({
          startSlot: slot,
          lengthSlots: fc.integer({ min: 49, max: 48 * 3 }),
          bufferMinutes: fc.constantFrom<ReservationBufferMinutes>(30, 60),
        })
        .map(({ startSlot, lengthSlots, bufferMinutes }): Shape => ({
          startMinutes: startSlot * 30,
          endMinutes: (startSlot + lengthSlots) * 30,
          bufferMinutes,
        }));
      fc.assert(
        fc.property(
          fc.constantFrom<DirectEntryKind>("provisional", "firm"),
          longShape,
          minutesBeforeStart,
          anyZone,
          (kind, entry, before, z) => {
            expect(check(kind, entry, before, [], [], z)).toEqual({
              ok: false,
              reason: "longer-than-24-hours",
            });
          },
        ),
      );
    });

    // 既存の予約・ブロック枠がないので、不可の理由は、30分単位でないことと、最短時間に満たないことだけ。
    // 両方当てはまるときにどちらを返すかは未決事項なので、どちらでもよい。JST と UTC の時差は整数の時間なので、
    // 30分単位かどうかは、どちらのゾーンで表しても同じ
    it("開始か終了が30分単位でない予約は、24時間以下でも不可（例外を認めない）。同じ時点を UTC で渡しても同じ結果", () => {
      const offGridShape = fc
        .record({
          startMinutes: fc.integer({ min: 0, max: 60 * 24 * 4 }),
          lengthMinutes: fc.integer({ min: 30, max: 60 * 24 }),
          bufferMinutes: fc.constantFrom<ReservationBufferMinutes>(30, 60),
        })
        .map(({ startMinutes, lengthMinutes, bufferMinutes }): Shape => ({
          startMinutes,
          endMinutes: startMinutes + lengthMinutes,
          bufferMinutes,
        }))
        .filter((shape) => shape.startMinutes % 30 !== 0 || shape.endMinutes % 30 !== 0);
      fc.assert(
        fc.property(
          fc.constantFrom<DirectEntryKind>("provisional", "firm"),
          offGridShape,
          minutesBeforeStart,
          anyZone,
          (kind, entry, before, z) => {
            expect(
              rejectedWithOneOf(["not-on-30-minute-boundary", ...minimumDurationReasons(entry)]),
            ).toContainEqual(check(kind, entry, before, [], [], z));
          },
        ),
      );
    });

    // 重ならない予約とブロック枠から始めて、直接入力（仮予約・本予約・第二キープ）と、管理者のブロック枠を順に入れる。
    // 入ったもの（警告があっても、確認して入れたものとする）を足していっても、第二キープと承認済みの仮予約の組を除いて
    // 占有区間は重ならない。どの承認済みの仮予約とも重ならない第二キープはできない
    it("直接入力と管理者のブロック枠を続けて入れても、INV-1 は崩れない", () => {
      const initialStatus = fc.constantFrom<ReservationStatus>(
        "pending-provisional",
        "pending-firm",
        "provisional",
        "provisional",
        "firm",
      );
      const step = fc.oneof(
        fc.record({
          type: fc.constant("entry" as const),
          kind: fc.constantFrom<DirectEntryKind>("provisional", "firm", "second-hold"),
          shape: reservationShape,
          before: minutesBeforeStart,
        }),
        fc.record({ type: fc.constant("block" as const), shape: blockShape }),
      );
      fc.assert(
        fc.property(
          fc.array(fc.record({ shape: reservationShape, status: initialStatus }), { maxLength: 6 }),
          fc.array(step, { maxLength: 12 }),
          anyZone,
          (initial, steps, z) => {
            const list: Item[] = [];
            for (const item of initial) {
              if (!list.some(({ shape }) => occupiedOverlaps(shape, item.shape))) list.push(item);
            }
            const blocks: Shape[] = [];

            for (const s of steps) {
              if (s.type === "entry") {
                const result = check(s.kind, s.shape, s.before, list, blocks, z);
                if (result.ok) list.push({ shape: s.shape, status: s.kind });
              } else {
                const result = checkAdminBlock({
                  start: toDateTime(s.shape.startMinutes, z),
                  end: toDateTime(s.shape.endMinutes, z),
                  bufferMinutes: s.shape.bufferMinutes,
                  reservations: toReservations(list, z),
                  blocks: toBlocks(blocks, z),
                });
                if (result.ok) blocks.push(s.shape);
              }
            }

            for (const [i, a] of list.entries()) {
              for (const b of list.slice(i + 1)) {
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
                  list.some(
                    ({ shape, status }) =>
                      status === "provisional" && occupiedOverlaps(a.shape, shape),
                  ),
                  `${a.status} がどの承認済みの仮予約とも重ならない`,
                ).toBe(true);
              }
            }
            for (const [i, a] of blocks.entries()) {
              for (const b of blocks.slice(i + 1)) {
                expect(occupiedOverlaps(a, b), "ブロック枠どうしが重なる").toBe(false);
              }
            }
          },
        ),
      );
    });
  });
});
