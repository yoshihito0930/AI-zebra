import { type ReservationStatus, Yen } from "@zebra/contracts";
import fc from "fast-check";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import {
  type BufferMinutes,
  type ExistingBlock,
  type ReservationBufferMinutes,
  type TimeRange,
  checkAvailability,
  occupiedRange,
} from "./availability";
import {
  type BufferChangeDraft,
  type BufferChangeInput,
  type BufferChangeResult,
  applyBufferChange,
} from "./buffer-change";
import {
  type Reservation,
  type ReservationOperation,
  applyReservationOperation,
} from "./reservation-transitions";
import { checkSecondHoldApplication } from "./second-hold";

// バッファの切り替え（applyBufferChange）の単体テスト。
// 根拠：docs/product-specs/booking.md「バッファを30分に縮める」（例の表のすべての行）、「予約の変更」の
// 「第二キープが付いている仮予約の日時を変える」、reservation-model.md「状態と操作」「第二キープと仮予約」、
// admin-api.md「バッファの切り替え・お客様の情報の変更（2回目b）」、core-beliefs.md（INV-1、INV-7）。
// - 切り替えは予約の変更と同じ扱い：切り替えられるのは承認済みの仮予約・本予約だけ（ほかは not-changeable）。
//   空き判定は自分の前の占有区間を除いて行い、仮予約は付いている第二キープの枠と重なる部分を使ってよい
// - 縮めて第二キープと重ならなくなったら、その第二キープは仮予約に付かなくなる。承認済みなら繰り上げ案内の下書きを作る
// - 今と同じバッファへの切り替えは何もしない（changed: false、下書き・解放・確保なし）
// - 解放・確保する枠は、変更と同じく「枠を確保している予約の占有区間の、前後の差」（reservation-change.test.ts と同じ見方）
// 切り替えの関数は現在時刻を使わない（INV-7）。判定は JST の日付や時刻に依らないが、予約の変更のテストと同じく、
// 例の各行を JST で表した日時と、同じ時点を UTC で表した日時の両方で確かめる

// 仕様の日時は JST で書かれている（INV-7）。例の表には年も日付もないので 2026/10/20 とする
const zones = ["Asia/Tokyo", "UTC"] as const;
type Zone = (typeof zones)[number];

function at(iso: string, zone: Zone): DateTime {
  const dateTime = DateTime.fromISO(iso, { zone: "Asia/Tokyo" });
  if (!dateTime.isValid) {
    throw new Error(`テストの日時が不正：${iso}`);
  }
  return dateTime.setZone(zone);
}

function oct20(time: string): string {
  return `2026-10-20T${time}`;
}

// 例の表に金額がないので、承認済みの予約の確定金額は 22,000円とする（切り替えでは変わらない）
const confirmedAmount = Yen.parse(22_000);

function reservation(
  zone: Zone,
  fields: {
    id: string;
    status: ReservationStatus;
    start: string;
    end: string;
    bufferMinutes: ReservationBufferMinutes;
    provisionalIds?: readonly string[];
  },
): Reservation {
  return {
    id: fields.id,
    status: fields.status,
    start: at(fields.start, zone),
    end: at(fields.end, zone),
    bufferMinutes: fields.bufferMinutes,
    provisionalIds: fields.provisionalIds ?? [],
    confirmedAmount: fields.status.startsWith("pending-") ? null : confirmedAmount,
  };
}

function switchBuffer(
  reservations: readonly Reservation[],
  reservationId: string,
  bufferMinutes: ReservationBufferMinutes,
  blocks: readonly ExistingBlock[] = [],
): BufferChangeResult {
  return applyBufferChange({ reservations, blocks, change: { reservationId, bufferMinutes } });
}

type BufferChangeSuccess = Extract<BufferChangeResult, { ok: true }>;

// 成功するはずの切り替え。失敗したら、理由を出してテストを落とす
function switchOk(
  zone: Zone,
  reservations: readonly Reservation[],
  reservationId: string,
  bufferMinutes: ReservationBufferMinutes,
  blocks: readonly ExistingBlock[] = [],
): BufferChangeSuccess {
  const result = switchBuffer(reservations, reservationId, bufferMinutes, blocks);
  if (!result.ok) {
    throw new Error(
      `${zone}：切り替えが成功するはずが失敗した（${reservationId}、${result.reason}）`,
    );
  }
  return result;
}

function find(reservations: readonly Reservation[], id: string): Reservation {
  const found = reservations.find((r) => r.id === id);
  if (found === undefined) {
    throw new Error(`切り替えのあとの予約に ${id} がない`);
  }
  return found;
}

// 区間が、JST で書いた [start, end) と同じ時点かを確かめる（ゾーンの表し方は問わない）
function expectRange(range: TimeRange, start: string, end: string, message: string): void {
  expect(range.start.toUTC().toISO(), message).toBe(at(start, "UTC").toISO());
  expect(range.end.toUTC().toISO(), message).toBe(at(end, "UTC").toISO());
}

function expectRanges(
  ranges: readonly TimeRange[],
  expected: readonly (readonly [string, string])[],
  message: string,
): void {
  expect(
    ranges.map((range) => [range.start.toUTC().toISO(), range.end.toUTC().toISO()]),
    message,
  ).toEqual(expected.map(([start, end]) => [at(start, "UTC").toISO(), at(end, "UTC").toISO()]));
}

// 下書きの並び順は決めていないので、件数と中身で比べる
function expectDrafts(
  drafts: readonly BufferChangeDraft[],
  expected: readonly BufferChangeDraft[],
  message: string,
): void {
  expect(drafts, message).toHaveLength(expected.length);
  expect(drafts, message).toEqual(expect.arrayContaining([...expected]));
}

// 予約が、切り替えの前と同じかを確かめる
function expectUnchanged(after: Reservation, before: Reservation, message: string): void {
  expect(after.status, message).toBe(before.status);
  expect(after.start.toMillis(), message).toBe(before.start.toMillis());
  expect(after.end.toMillis(), message).toBe(before.end.toMillis());
  expect(after.bufferMinutes, message).toBe(before.bufferMinutes);
  expect(after.provisionalIds, message).toEqual(before.provisionalIds);
  expect(after.confirmedAmount, message).toBe(before.confirmedAmount);
}

// 切り替えた予約は、バッファだけが変わる（状態・予約区間・付く仮予約の id・確定金額は変わらない）
function expectSwitched(
  after: Reservation,
  before: Reservation,
  bufferMinutes: ReservationBufferMinutes,
  message: string,
): void {
  expectUnchanged({ ...after, bufferMinutes: before.bufferMinutes }, before, message);
  expect(after.bufferMinutes, `${message}、バッファ`).toBe(bufferMinutes);
}

// 仮予約に付かなくなった第二キープは、付く仮予約の id だけが変わる（reservation-model.md「第二キープと仮予約」）
function expectDetached(
  after: Reservation,
  before: Reservation,
  provisionalIds: readonly string[],
  message: string,
): void {
  expectUnchanged({ ...after, provisionalIds: before.provisionalIds }, before, message);
  expect(after.provisionalIds, `${message}、付く仮予約の id`).toEqual(provisionalIds);
}

// 何もしない切り替え：成功、changed は false、予約は渡したまま、下書き・解放・確保はない
function expectNothingChanged(
  result: BufferChangeResult,
  before: readonly Reservation[],
  message: string,
): void {
  if (!result.ok) {
    throw new Error(`${message}：何もしない（成功）はずが失敗した（${result.reason}）`);
  }
  expect(result.changed, message).toBe(false);
  expect(result.reservations, message).toHaveLength(before.length);
  for (const [i, b] of before.entries()) {
    const a = result.reservations[i];
    if (a === undefined) throw new Error(`${message}：予約が減った`);
    expect(a.id, message).toBe(b.id);
    expectUnchanged(a, b, `${message}、${b.id}`);
  }
  expect(result.drafts, message).toEqual([]);
  expect(result.released, message).toEqual([]);
  expect(result.secured, message).toEqual([]);
}

describe("バッファを30分に縮める", () => {
  function reservationA(zone: Zone, bufferMinutes: ReservationBufferMinutes): Reservation {
    return reservation(zone, {
      id: "A",
      status: "firm",
      start: oct20("09:00"),
      end: oct20("12:00"),
      bufferMinutes,
    });
  }

  it("本予約 A 09:00–12:00、バッファ1時間（占有区間 09:00–13:00）、申込 12:30–14:30：不可（12:30–13:00が重なる）", () => {
    for (const zone of zones) {
      const a = reservationA(zone, 60);
      expectRange(occupiedRange(a, a.bufferMinutes), oct20("09:00"), oct20("13:00"), zone);
      expect(
        checkAvailability({
          start: at(oct20("12:30"), zone),
          end: at(oct20("14:30"), zone),
          bufferMinutes: 60,
          reservations: [a],
          blocks: [],
        }),
        zone,
      ).toEqual({ ok: false, reason: "overlaps-existing" });
    }
  });

  // 縮めると、A の占有区間の後ろ 12:30–13:00 を解放する（確保する枠はない）。お客様への下書きは作らない
  it("同上（本予約 A 09:00–12:00、バッファ1時間）、管理者が A のバッファを30分にする：成功。占有区間は 09:00–12:30 になる", () => {
    for (const zone of zones) {
      const a = reservationA(zone, 60);
      const result = switchOk(zone, [a], "A", 30);
      expect(result.changed, zone).toBe(true);
      const after = find(result.reservations, "A");
      expectSwitched(after, a, 30, `${zone}、A`);
      expectRange(occupiedRange(after, after.bufferMinutes), oct20("09:00"), oct20("12:30"), zone);
      expectRanges(result.released, [[oct20("12:30"), oct20("13:00")]], `${zone}、解放`);
      expectRanges(result.secured, [], `${zone}、確保`);
      expect(result.drafts, zone).toEqual([]);
    }
  });

  // A のバッファを30分にした（切り替えの結果の）予約に対して、申込を空き判定する
  it("A のバッファ30分（占有区間 09:00–12:30）、申込 12:30–14:30：予約可（12:30で接するだけ）", () => {
    for (const zone of zones) {
      const switched = switchOk(zone, [reservationA(zone, 60)], "A", 30);
      const a = find(switched.reservations, "A");
      expectRange(occupiedRange(a, a.bufferMinutes), oct20("09:00"), oct20("12:30"), zone);
      expect(
        checkAvailability({
          start: at(oct20("12:30"), zone),
          end: at(oct20("14:30"), zone),
          bufferMinutes: 60,
          reservations: [...switched.reservations],
          blocks: [],
        }),
        zone,
      ).toEqual({ ok: true });
    }
  });

  it("A のバッファ30分、本予約 B 12:30–14:30 あり、管理者が A のバッファを1時間に戻す：不可（12:30–13:00が B と重なる）", () => {
    for (const zone of zones) {
      const b = reservation(zone, {
        id: "B",
        status: "firm",
        start: oct20("12:30"),
        end: oct20("14:30"),
        bufferMinutes: 60,
      });
      expect(switchBuffer([reservationA(zone, 30), b], "A", 60), zone).toEqual({
        ok: false,
        reason: "overlaps-existing",
      });
    }
  });

  it("承認待ち（本）A 09:00–12:00、管理者が A のバッファを30分にする：不可（承認待ちは切り替えられない）", () => {
    for (const zone of zones) {
      const a = reservation(zone, {
        id: "A",
        status: "pending-firm",
        start: oct20("09:00"),
        end: oct20("12:00"),
        bufferMinutes: 60,
      });
      expect(switchBuffer([a], "A", 30), zone).toEqual({ ok: false, reason: "not-changeable" });
    }
  });

  // 第二キープは承認済みの仮予約に付く（「第二キープ」の節）。例の表には仮予約がないので、K が付く仮予約 P を
  // 07:00–09:00（占有区間 07:00–10:00。K と 09:00–10:00 で重なる）とする
  it("第二キープ K 09:00–12:00、管理者が K のバッファを30分にする：不可（第二キープは切り替えられない）", () => {
    for (const zone of zones) {
      const p = reservation(zone, {
        id: "P",
        status: "provisional",
        start: oct20("07:00"),
        end: oct20("09:00"),
        bufferMinutes: 60,
      });
      const k = reservation(zone, {
        id: "K",
        status: "second-hold",
        start: oct20("09:00"),
        end: oct20("12:00"),
        bufferMinutes: 60,
        provisionalIds: ["P"],
      });
      expect(switchBuffer([p, k], "K", 30), zone).toEqual({
        ok: false,
        reason: "not-changeable",
      });
    }
  });

  // P の延びる 15:30–16:00 は、P に付いている K がすでに確保している枠なので、新しく確保する枠も解放する枠もない。
  // K は P と重なったままなので、P に付いたまま変わらない。下書きは作らない
  it("仮予約 P 13:00–15:00、バッファ30分（占有区間 13:00–15:30）。P に付く第二キープ K 15:00–17:00（占有区間 15:00–18:00）、管理者が P のバッファを1時間にする：成功（K の枠と重なる部分は P が使ってよい）。P の占有区間は 13:00–16:00", () => {
    for (const zone of zones) {
      const p = reservation(zone, {
        id: "P",
        status: "provisional",
        start: oct20("13:00"),
        end: oct20("15:00"),
        bufferMinutes: 30,
      });
      const k = reservation(zone, {
        id: "K",
        status: "second-hold",
        start: oct20("15:00"),
        end: oct20("17:00"),
        bufferMinutes: 60,
        provisionalIds: ["P"],
      });
      expectRange(occupiedRange(p, p.bufferMinutes), oct20("13:00"), oct20("15:30"), zone);
      expectRange(occupiedRange(k, k.bufferMinutes), oct20("15:00"), oct20("18:00"), zone);

      const result = switchOk(zone, [p, k], "P", 60);
      expect(result.changed, zone).toBe(true);
      const pAfter = find(result.reservations, "P");
      expectSwitched(pAfter, p, 60, `${zone}、P`);
      expectRange(
        occupiedRange(pAfter, pAfter.bufferMinutes),
        oct20("13:00"),
        oct20("16:00"),
        zone,
      );
      expectUnchanged(find(result.reservations, "K"), k, `${zone}、K`);
      expect(result.drafts, zone).toEqual([]);
      expectRanges(result.released, [], `${zone}、解放`);
      expectRanges(result.secured, [], `${zone}、確保`);
    }
  });

  // K は P と重ならなくなるので、P に付かなくなる（K の付く仮予約の id から P を外す）。K は第二キープのまま枠を確保する。
  // P の縮む 15:30–16:00 は K が確保しているので、解放する枠はない
  it("仮予約 P 13:00–15:00（占有区間 13:00–16:00）。P に付く第二キープ K 15:30–17:30（占有区間 15:30–18:30）、管理者が P のバッファを30分にする：成功。P の占有区間は 13:00–15:30 で、K とは接するだけになる。K は P に付かなくなり、K のお客様への繰り上げ案内の下書きを作る", () => {
    for (const zone of zones) {
      const p = reservation(zone, {
        id: "P",
        status: "provisional",
        start: oct20("13:00"),
        end: oct20("15:00"),
        bufferMinutes: 60,
      });
      const k = reservation(zone, {
        id: "K",
        status: "second-hold",
        start: oct20("15:30"),
        end: oct20("17:30"),
        bufferMinutes: 60,
        provisionalIds: ["P"],
      });
      expectRange(occupiedRange(k, k.bufferMinutes), oct20("15:30"), oct20("18:30"), zone);

      const result = switchOk(zone, [p, k], "P", 30);
      expect(result.changed, zone).toBe(true);
      const pAfter = find(result.reservations, "P");
      expectSwitched(pAfter, p, 30, `${zone}、P`);
      expectRange(
        occupiedRange(pAfter, pAfter.bufferMinutes),
        oct20("13:00"),
        oct20("15:30"),
        zone,
      );
      expectDetached(find(result.reservations, "K"), k, [], `${zone}、K`);
      expectDrafts(
        result.drafts,
        [{ kind: "move-up-notice", reservationId: "K", remainingProvisionalIds: [] }],
        zone,
      );
      expectRanges(result.released, [], `${zone}、解放`);
      expectRanges(result.secured, [], `${zone}、確保`);
    }
  });

  it("本予約 A 09:00–12:00、バッファ1時間、管理者が A のバッファを1時間にする：何もしない（今と同じ）", () => {
    for (const zone of zones) {
      const before = [reservationA(zone, 60)];
      expectNothingChanged(switchBuffer(before, "A", 60), before, zone);
    }
  });
});

// 例の表にない場合。根拠は各 it のコメント
describe("バッファの切り替え（applyBufferChange）：例の表のほかの場合", () => {
  // 第二キープの例外を確かめるための、P とは別の仮予約 P2 17:00–19:00（占有区間 17:00–20:00）と、
  // P2 に付く第二キープ K2 15:30–17:30（占有区間 15:30–18:30）
  function p2AndK2(zone: Zone): Reservation[] {
    return [
      reservation(zone, {
        id: "P2",
        status: "provisional",
        start: oct20("17:00"),
        end: oct20("19:00"),
        bufferMinutes: 60,
      }),
      reservation(zone, {
        id: "K2",
        status: "second-hold",
        start: oct20("15:30"),
        end: oct20("17:30"),
        bufferMinutes: 60,
        provisionalIds: ["P2"],
      }),
    ];
  }

  // admin-api.md「ほかの状態は 409（not-changeable。変更と同じ）」
  it("承認待ち（仮）・承認待ち（第二キープ）・取消・終了の予約のバッファを切り替えようとする：不可（not-changeable）", () => {
    for (const zone of zones) {
      for (const status of [
        "pending-provisional",
        "pending-second-hold",
        "cancelled",
        "ended",
      ] as const) {
        const x = reservation(zone, {
          id: "X",
          status,
          start: oct20("09:00"),
          end: oct20("12:00"),
          bufferMinutes: 60,
        });
        expect(switchBuffer([x], "X", 30), `${zone}、${status}`).toEqual({
          ok: false,
          reason: "not-changeable",
        });
      }
    }
  });

  it("ない id の予約のバッファを切り替えようとする：不可（not-found）", () => {
    for (const zone of zones) {
      const a = reservation(zone, {
        id: "A",
        status: "firm",
        start: oct20("09:00"),
        end: oct20("12:00"),
        bufferMinutes: 60,
      });
      expect(switchBuffer([a], "no-such-reservation", 30), zone).toEqual({
        ok: false,
        reason: "not-found",
      });
    }
  });

  // 空き判定では、自分の前の占有区間を除く（予約の変更と同じ）。ブロック枠とも重なれない（INV-1）。
  // 本予約 A 09:00–12:00（バッファ30分）を1時間に戻すとき、ブロック枠 12:30–13:30（バッファなし）と重なる
  it("本予約 A 09:00–12:00、バッファ30分のときに、ブロック枠 12:30–13:30（バッファなし）があり、A のバッファを1時間に戻す：不可（overlaps-existing。12:30–13:00 がブロック枠と重なる）", () => {
    for (const zone of zones) {
      const a = reservation(zone, {
        id: "A",
        status: "firm",
        start: oct20("09:00"),
        end: oct20("12:00"),
        bufferMinutes: 30,
      });
      const block: ExistingBlock = {
        start: at(oct20("12:30"), zone),
        end: at(oct20("13:30"), zone),
        bufferMinutes: 0,
      };
      expect(switchBuffer([a], "A", 60, [block]), zone).toEqual({
        ok: false,
        reason: "overlaps-existing",
      });
    }
  });

  // 仮予約が使ってよいのは、その仮予約に付いている第二キープの枠だけ（booking.md「第二キープが付いている仮予約の日時を変える」）。
  // P 13:00–15:00（バッファ30分、占有区間 13:00–15:30）を1時間にすると、P に付いていない K2 の 15:30–16:00 と重なる
  it("仮予約 P 13:00–15:00、バッファ30分のときに、P に付いていない第二キープ K2 15:30–17:30 があり、P のバッファを1時間にする：不可（overlaps-existing）", () => {
    for (const zone of zones) {
      const p = reservation(zone, {
        id: "P",
        status: "provisional",
        start: oct20("13:00"),
        end: oct20("15:00"),
        bufferMinutes: 30,
      });
      expect(switchBuffer([p, ...p2AndK2(zone)], "P", 60), zone).toEqual({
        ok: false,
        reason: "overlaps-existing",
      });
    }
  });

  // 本予約は、第二キープの枠を使えない（第二キープが重なってよいのは承認済みの仮予約だけ）
  it("本予約 A 13:00–15:00、バッファ30分のときに、第二キープ K2 15:30–17:30 があり、A のバッファを1時間にする：不可（overlaps-existing）", () => {
    for (const zone of zones) {
      const a = reservation(zone, {
        id: "A",
        status: "firm",
        start: oct20("13:00"),
        end: oct20("15:00"),
        bufferMinutes: 30,
      });
      expect(switchBuffer([a, ...p2AndK2(zone)], "A", 60), zone).toEqual({
        ok: false,
        reason: "overlaps-existing",
      });
    }
  });

  // reservation-model.md「状態と操作」：仮予約を縮めて第二キープと重ならなくなったら、その第二キープに繰り上げ案内の下書き
  // （変更と同じ）。変更と同じく、案内を作るのは承認済みの第二キープだけで、承認待ちのものは承認待ちのまま枠を確保する
  // （reservation-model.md「第二キープと仮予約」）。承認待ちの第二キープも、重ならなくなった仮予約には付かなくなる
  it("仮予約 P 13:00–15:00（占有区間 13:00–16:00）に付く承認待ちの第二キープ K 15:30–17:30 があり、P のバッファを30分にする：成功。K は承認待ちのまま P に付かなくなる。下書きは作らない", () => {
    for (const zone of zones) {
      const p = reservation(zone, {
        id: "P",
        status: "provisional",
        start: oct20("13:00"),
        end: oct20("15:00"),
        bufferMinutes: 60,
      });
      const k = reservation(zone, {
        id: "K",
        status: "pending-second-hold",
        start: oct20("15:30"),
        end: oct20("17:30"),
        bufferMinutes: 60,
        provisionalIds: ["P"],
      });

      const result = switchOk(zone, [p, k], "P", 30);
      expectSwitched(find(result.reservations, "P"), p, 30, `${zone}、P`);
      expectDetached(find(result.reservations, "K"), k, [], `${zone}、K`);
      expect(result.drafts, zone).toEqual([]);
    }
  });

  // 2件の仮予約に付く第二キープ：1件と重ならなくなっても、もう1件に付いたまま。案内には、残っている仮予約の id を入れる
  // （reservation-model.md「状態と操作」の取消の行「ほかに付いている仮予約が残っていて、まだ繰り上げられないときは、そのことも伝える」）。
  // P1 10:00–12:00（占有区間 10:00–13:00）と P2 15:00–17:00（占有区間 15:00–18:00）に付く K 12:30–15:00（占有区間 12:30–16:00）。
  // P1 を30分にすると占有区間は 10:00–12:30 で、K とは接するだけになる
  it("仮予約 P1 10:00–12:00 と P2 15:00–17:00 に付く第二キープ K 12:30–15:00 があり、P1 のバッファを30分にする：成功。K は P1 に付かなくなり、P2 に付いたまま。K への繰り上げ案内の下書き（残っている仮予約 P2）を作る", () => {
    for (const zone of zones) {
      const p1 = reservation(zone, {
        id: "P1",
        status: "provisional",
        start: oct20("10:00"),
        end: oct20("12:00"),
        bufferMinutes: 60,
      });
      const p2 = reservation(zone, {
        id: "P2",
        status: "provisional",
        start: oct20("15:00"),
        end: oct20("17:00"),
        bufferMinutes: 60,
      });
      const k = reservation(zone, {
        id: "K",
        status: "second-hold",
        start: oct20("12:30"),
        end: oct20("15:00"),
        bufferMinutes: 60,
        provisionalIds: ["P1", "P2"],
      });

      const result = switchOk(zone, [p1, p2, k], "P1", 30);
      expectSwitched(find(result.reservations, "P1"), p1, 30, `${zone}、P1`);
      expectUnchanged(find(result.reservations, "P2"), p2, `${zone}、P2`);
      expectDetached(find(result.reservations, "K"), k, ["P2"], `${zone}、K`);
      expectDrafts(
        result.drafts,
        [{ kind: "move-up-notice", reservationId: "K", remainingProvisionalIds: ["P2"] }],
        zone,
      );
    }
  });

  it("今と同じバッファ（30分の本予約を30分に）：何もしない。ほかの予約と重なっていても、判定せずに成功する（枠は変わらない）", () => {
    for (const zone of zones) {
      const before = [
        reservation(zone, {
          id: "A",
          status: "firm",
          start: oct20("09:00"),
          end: oct20("12:00"),
          bufferMinutes: 30,
        }),
      ];
      expectNothingChanged(switchBuffer(before, "A", 30), before, zone);
    }
  });

  it("引数の予約を書き換えない", () => {
    for (const zone of zones) {
      const p = reservation(zone, {
        id: "P",
        status: "provisional",
        start: oct20("13:00"),
        end: oct20("15:00"),
        bufferMinutes: 60,
      });
      const k = reservation(zone, {
        id: "K",
        status: "second-hold",
        start: oct20("15:30"),
        end: oct20("17:30"),
        bufferMinutes: 60,
        provisionalIds: ["P"],
      });
      const input: BufferChangeInput = {
        reservations: [p, k],
        blocks: [],
        change: { reservationId: "P", bufferMinutes: 30 },
      };
      applyBufferChange(input);
      expect(p.bufferMinutes, zone).toBe(60);
      expect(k.provisionalIds, zone).toEqual(["P"]);
      expect(
        input.reservations.map((r) => r.id),
        zone,
      ).toEqual(["P", "K"]);
    }
  });
});

describe("バッファの切り替え（applyBufferChange）：プロパティ（INV-1。どの操作の列のあとでも成り立つこと）", () => {
  // 時刻は 10/20 00:00（JST）からの30分単位の枠で作る（10/20〜10/22 の範囲）
  const base = DateTime.fromISO("2026-10-20T00:00", { zone: "Asia/Tokyo" });
  const cancelledAt = DateTime.fromISO("2026-10-10T12:00", { zone: "Asia/Tokyo" });
  const slot = fc.integer({ min: 0, max: 48 * 2 });
  const anyZone = fc.constantFrom(...zones);

  // 予約区間：開始・終了は30分単位、長さは2〜8時間（重なりと第二キープが起きやすいように短めにする）
  const shape = fc.record({
    startSlot: slot,
    lengthSlots: fc.integer({ min: 4, max: 16 }),
    bufferMinutes: fc.constantFrom<ReservationBufferMinutes>(30, 60),
  });
  const blockShape = fc.record({
    startSlot: slot,
    lengthSlots: fc.integer({ min: 1, max: 8 }),
    bufferMinutes: fc.constantFrom<BufferMinutes>(0, 30, 60),
  });

  const holdingStatuses: readonly ReservationStatus[] = [
    "pending-provisional",
    "pending-firm",
    "pending-second-hold",
    "provisional",
    "firm",
    "second-hold",
  ];
  const secondHoldStatuses: readonly ReservationStatus[] = ["pending-second-hold", "second-hold"];
  const changeableStatuses: readonly ReservationStatus[] = ["provisional", "firm"];

  function isHolding(status: ReservationStatus): boolean {
    return holdingStatuses.includes(status);
  }
  function isSecondHold(status: ReservationStatus): boolean {
    return secondHoldStatuses.includes(status);
  }

  type Interval = readonly [number, number];
  function occupied(r: { start: DateTime; end: DateTime; bufferMinutes: number }): Interval {
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
  function toIntervals(ranges: readonly TimeRange[]): Interval[] {
    return ranges.map((r): Interval => [r.start.toMillis(), r.end.toMillis()]);
  }

  // INV-1：枠を確保している予約の占有区間は、第二キープと承認済みの仮予約の組を除いて重ならない。ブロック枠とも重ならない
  function expectInv1(
    reservations: readonly Reservation[],
    blocks: readonly ExistingBlock[],
  ): void {
    const holding = reservations.filter((r) => isHolding(r.status));
    for (const [i, a] of holding.entries()) {
      for (const b of holding.slice(i + 1)) {
        if (!overlaps(occupied(a), occupied(b))) continue;
        const pair = [a.status, b.status];
        const allowed = pair.includes("provisional") && pair.some((s) => isSecondHold(s));
        expect(allowed, `${a.id}（${a.status}）と ${b.id}（${b.status}）が重なる`).toBe(true);
      }
      for (const block of blocks) {
        expect(overlaps(occupied(a), occupied(block)), `${a.id} がブロック枠と重なる`).toBe(false);
      }
    }
  }

  // 付いている仮予約のうち、まだ仮予約のまま第二キープと重なっているもの
  function stillHeldBy(k: Reservation, reservations: readonly Reservation[]): string[] {
    return k.provisionalIds.filter((id) => {
      const p = reservations.find((r) => r.id === id);
      return p !== undefined && p.status === "provisional" && overlaps(occupied(p), occupied(k));
    });
  }

  function snapshot(reservations: readonly Reservation[]) {
    return reservations.map((r) => ({
      id: r.id,
      status: r.status,
      start: r.start.toMillis(),
      end: r.end.toMillis(),
      bufferMinutes: r.bufferMinutes,
      provisionalIds: [...r.provisionalIds],
      confirmedAmount: r.confirmedAmount,
    }));
  }

  function toReservation(
    id: string,
    s: { startSlot: number; lengthSlots: number; bufferMinutes: ReservationBufferMinutes },
    status: ReservationStatus,
    z: Zone,
  ): Reservation {
    return {
      id,
      status,
      start: base.plus({ minutes: s.startSlot * 30 }).setZone(z),
      end: base.plus({ minutes: (s.startSlot + s.lengthSlots) * 30 }).setZone(z),
      bufferMinutes: s.bufferMinutes,
      provisionalIds: [],
      confirmedAmount: status.startsWith("pending-") ? null : confirmedAmount,
    };
  }

  // 切り替えを確かめる。テストの側で、期待する結果を仕様から組み立てて比べる。
  // - 承認済みの仮予約・本予約でなければ not-changeable で、何も変わらない
  // - 今と同じバッファなら、何もしない（changed: false）
  // - 切り替えたあとの占有区間が、枠を確保しているほかの予約（自分と、自分が仮予約ならそれに付いている第二キープ〔承認待ちを含む〕を除く）
  //   とブロック枠のどれかと重なれば overlaps-existing で、何も変わらない
  // - 可なら、切り替えた予約はバッファだけが変わる。切り替えたあと重ならなくなった、付いている第二キープ（承認待ちを含む）は、
  //   その仮予約に付かなくなる。ほかの予約は変わらない。解放・確保する枠は、確保している占有区間の前後の差。
  //   下書きは、付かなくなった承認済みの第二キープへの繰り上げ案内だけ
  function checkSwitch(
    before: readonly Reservation[],
    blocks: readonly ExistingBlock[],
    target: Reservation,
    bufferMinutes: ReservationBufferMinutes,
  ): Reservation[] {
    const copy = snapshot(before);
    const result = applyBufferChange({
      reservations: before,
      blocks,
      change: { reservationId: target.id, bufferMinutes },
    });
    expect(snapshot(before), "引数の予約を書き換えない").toEqual(copy);

    if (!changeableStatuses.includes(target.status)) {
      expect(result).toEqual({ ok: false, reason: "not-changeable" });
      return [...before];
    }
    if (target.bufferMinutes === bufferMinutes) {
      expectNothingChanged(result, before, `${target.id} を今と同じバッファに`);
      return [...before];
    }

    const nextTarget = { ...target, bufferMinutes };
    const conflicts = [
      ...before
        .filter((r) => r.id !== target.id && isHolding(r.status))
        .filter(
          (r) =>
            !(
              target.status === "provisional" &&
              isSecondHold(r.status) &&
              r.provisionalIds.includes(target.id)
            ),
        )
        .map(occupied),
      ...blocks.map(occupied),
    ].filter((interval) => overlaps(interval, occupied(nextTarget)));
    if (conflicts.length > 0) {
      expect(result).toEqual({ ok: false, reason: "overlaps-existing" });
      return [...before];
    }
    if (!result.ok) {
      throw new Error(`${target.id}（${target.status}）の切り替えが失敗した（${result.reason}）`);
    }
    expect(result.changed).toBe(true);

    const after = result.reservations;
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    const detached =
      target.status === "provisional"
        ? before.filter(
            (k) =>
              isSecondHold(k.status) &&
              k.provisionalIds.includes(target.id) &&
              !overlaps(occupied(nextTarget), occupied(k)),
          )
        : [];
    const detachedIds = detached.map((k) => k.id);
    for (const [i, b] of before.entries()) {
      const a = after[i];
      if (a === undefined) throw new Error("切り替えのあとの予約が減った");
      if (b.id === target.id) {
        expectSwitched(a, b, bufferMinutes, b.id);
      } else if (detachedIds.includes(b.id)) {
        expectDetached(
          a,
          b,
          b.provisionalIds.filter((id) => id !== target.id),
          `${b.id}（${b.status}）は ${target.id} と重ならなくなった`,
        );
      } else {
        expectUnchanged(a, b, b.id);
      }
    }

    expect(toIntervals(result.released), "解放する枠").toEqual(
      subtract(holdingIntervals(before), holdingIntervals(after)),
    );
    expect(toIntervals(result.secured), "確保する枠").toEqual(
      subtract(holdingIntervals(after), holdingIntervals(before)),
    );

    const byId = (x: { reservationId: string }, y: { reservationId: string }) =>
      x.reservationId < y.reservationId ? -1 : 1;
    expect(
      result.drafts
        .map((d) => ({ ...d, remainingProvisionalIds: [...d.remainingProvisionalIds].sort() }))
        .sort(byId),
      "繰り上げ案内の下書き",
    ).toEqual(
      detached
        .filter((k) => k.status === "second-hold")
        .map((k) => ({
          kind: "move-up-notice",
          reservationId: k.id,
          remainingProvisionalIds: stillHeldBy(find(after, k.id), after).sort(),
        }))
        .sort(byId),
    );
    return [...after];
  }

  // 操作の列：申込（承認待ちか承認済みの仮予約・本予約）、第二キープの申込（承認待ちか承認済み）、昇格、取消、
  // バッファの切り替え（どの状態の予約にも試す。第二キープ付きの仮予約が選ばれやすいように、仮予約を狙う切り替えも入れる）。
  // 申込はテストの側で空き判定（checkAvailability・checkSecondHoldApplication）を通ったものだけを足す
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
    fc.record({ kind: fc.constant("apply-second-hold" as const), shape, approve: fc.boolean() }),
    fc.record({
      kind: fc.constantFrom("promote" as const, "cancel" as const),
      pick: fc.nat(),
    }),
    fc.record({
      kind: fc.constantFrom("buffer" as const, "buffer-provisional" as const),
      pick: fc.nat(),
      bufferMinutes: fc.constantFrom<ReservationBufferMinutes>(30, 60),
    }),
  );

  const targetStatuses = {
    promote: ["provisional"],
    cancel: ["provisional", "firm", "second-hold"],
  } as const satisfies Record<"promote" | "cancel", readonly ReservationStatus[]>;

  it("申込・昇格・取消・バッファの切り替えのどの列のあとでも、枠を確保している予約の占有区間は、第二キープと承認済みの仮予約の組を除いて重ならない。切り替えは、承認済みの仮予約・本予約で、空き判定を通るときだけ可。不可なら何も変わらない。縮めて重ならなくなった第二キープはその仮予約に付かなくなり、承認済みなら繰り上げ案内の下書きを作る", () => {
    fc.assert(
      fc.property(
        fc.array(step, { maxLength: 25 }),
        fc.array(blockShape, { maxLength: 2 }),
        anyZone,
        (steps, blockShapes, z) => {
          const blocks: ExistingBlock[] = blockShapes.map((b) => ({
            start: base.plus({ minutes: b.startSlot * 30 }).setZone(z),
            end: base.plus({ minutes: (b.startSlot + b.lengthSlots) * 30 }).setZone(z),
            bufferMinutes: b.bufferMinutes,
          }));
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
                  reservations,
                  blocks,
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
                reservations,
                blocks,
              });
              if (checked.ok) {
                reservations = [...reservations, { ...r, provisionalIds: checked.provisionalIds }];
              }
            } else if (s.kind === "buffer" || s.kind === "buffer-provisional") {
              const candidates =
                s.kind === "buffer"
                  ? reservations
                  : reservations.filter((r) => r.status === "provisional");
              if (candidates.length === 0) continue;
              const target = candidates[s.pick % candidates.length];
              if (target === undefined) continue;
              reservations = checkSwitch(reservations, blocks, target, s.bufferMinutes);
            } else {
              const allowed: readonly ReservationStatus[] = targetStatuses[s.kind];
              const candidates = reservations.filter((r) => allowed.includes(r.status));
              if (candidates.length === 0) continue;
              const target = candidates[s.pick % candidates.length];
              if (target === undefined) continue;
              const operation: ReservationOperation =
                s.kind === "cancel"
                  ? {
                      kind: "cancel",
                      reservationId: target.id,
                      cancelledAt: cancelledAt.setZone(z),
                    }
                  : { kind: "promote", reservationId: target.id };
              const result = applyReservationOperation({ reservations, operation });
              if (!result.ok) {
                throw new Error(
                  `${s.kind} ${target.id}（${target.status}）が失敗した（${result.reason}）`,
                );
              }
              reservations = [...result.reservations];
            }
            expectInv1(reservations, blocks);
          }
        },
      ),
    );
  });
});
