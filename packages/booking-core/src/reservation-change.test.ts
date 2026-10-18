import { ReservationStatus, Yen } from "@zebra/contracts";
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
import { currentPriceTable } from "./current-price-table";
import { calculatePriceFromTable, decidePlanId } from "./price-table-pricing";
import { provisionalDeadline } from "./provisional-deadline";
import { approveReservation, rejectReservation } from "./reservation-approval";
import {
  type ReservationChangeContent,
  type ReservationChangeDraft,
  applyReservationChange,
} from "./reservation-change";
import {
  type Reservation,
  type ReservationOperation,
  applyReservationOperation,
} from "./reservation-transitions";
import { checkSecondHoldApplication } from "./second-hold";

// 変更の関数は現在時刻を使わない（日時はすべて引数で渡す。INV-7）

// 仕様の日時は JST で書かれている（INV-7）。例の表には年がないので 2026 年とし、日付のない行は 10/20 とする（「翌日」は 10/21）。
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

function oct20(time: string): string {
  return `2026-10-20T${time}`;
}
function oct21(time: string): string {
  return `2026-10-21T${time}`;
}

// 見積の再計算には、変更後の申込内容が要る。例の本予約 A（10:00–12:00 で 11,000円）は、プランA の単価で
// 時間料金だけの金額なので、人数 4人・ホリゾントの養生なし・機材保険なし・オプションなし（プランA）とする。
// 例の表は日時だけを変えるので、どの行も申込内容は変えない
const content: ReservationChangeContent = {
  partySize: 4,
  cycloramaFloorProtection: false,
  equipmentInsurance: false,
  optionIds: [],
};

// 例の表に金額のない予約（仮予約・第二キープ・ほかの本予約）の確定金額は 22,000円とする
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
    confirmedAmount?: number;
  },
): Reservation {
  return {
    id: fields.id,
    status: fields.status,
    start: at(fields.start, zone),
    end: at(fields.end, zone),
    bufferMinutes: 60,
    provisionalIds: fields.provisionalIds ?? [],
    confirmedAmount: fields.status.startsWith("pending-")
      ? null
      : Yen.parse(fields.confirmedAmount ?? otherConfirmedAmount),
  };
}

function change(
  zone: Zone,
  reservations: readonly Reservation[],
  fields: { id: string; start: string; end: string; confirmedAmount: number },
) {
  return applyReservationChange({
    reservations,
    blocks: [],
    priceTable: currentPriceTable(),
    change: {
      reservationId: fields.id,
      start: at(fields.start, zone),
      end: at(fields.end, zone),
      content,
      confirmedAmount: Yen.parse(fields.confirmedAmount),
    },
  });
}

// 成功するはずの変更。失敗したら、理由を出してテストを落とす
function changeOk(
  zone: Zone,
  reservations: readonly Reservation[],
  fields: { id: string; start: string; end: string; confirmedAmount: number },
) {
  const result = change(zone, reservations, fields);
  if (!result.ok) {
    throw new Error(`${zone}：変更が成功するはずが失敗した（${fields.id}、${result.reason}）`);
  }
  return result;
}

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

// 区間の並びが、JST で書いた区間の並びと同じ時点かを確かめる
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
  drafts: readonly ReservationChangeDraft[],
  expected: readonly ReservationChangeDraft[],
  message: string,
): void {
  expect(drafts, message).toHaveLength(expected.length);
  expect(drafts, message).toEqual(expect.arrayContaining([...expected]));
}

// 変更しなかった予約が、変更の前と同じかを確かめる
function expectUnchanged(after: Reservation, before: Reservation, message: string): void {
  expect(after.status, message).toBe(before.status);
  expect(after.start.toMillis(), message).toBe(before.start.toMillis());
  expect(after.end.toMillis(), message).toBe(before.end.toMillis());
  expect(after.bufferMinutes, message).toBe(before.bufferMinutes);
  expect(after.provisionalIds, message).toEqual(before.provisionalIds);
  expect(after.confirmedAmount, message).toBe(before.confirmedAmount);
}

// 仮予約を動かして重ならなくなった第二キープは、その仮予約に付かなくなる（付く仮予約の id から外す）。
// それ以外（状態・予約区間・バッファ・確定金額）は変わらない（reservation-model.md「第二キープと仮予約」）
function expectDetached(
  after: Reservation,
  before: Reservation,
  provisionalIds: readonly string[],
  message: string,
): void {
  expectUnchanged({ ...after, provisionalIds: before.provisionalIds }, before, message);
  expect(after.provisionalIds, `${message}、付く仮予約の id`).toEqual(provisionalIds);
}

describe("予約の変更", () => {
  describe("本予約 A が 10/20 10:00–12:00（占有区間 10:00–13:00、金額 11,000円）の場合。", () => {
    function reservationA(zone: Zone): Reservation {
      const a = reservation(zone, {
        id: "A",
        status: "firm",
        start: oct20("10:00"),
        end: oct20("12:00"),
        confirmedAmount: 11_000,
      });
      expectRange(occupiedRange(a, a.bufferMinutes), oct20("10:00"), oct20("13:00"), zone);
      return a;
    }
    function reservationB(zone: Zone): Reservation {
      return reservation(zone, {
        id: "B",
        status: "firm",
        start: oct20("14:00"),
        end: oct20("16:00"),
      });
    }

    // 「管理者が金額を確定する」：確定金額は管理者が決めて渡す。ここでは管理者が見積どおり 16,500円で確定する
    it("A を 10:00–13:00 に延長：可。占有区間は 10:00–14:00。再計算した見積 16,500円を表示し、管理者が金額を確定する", () => {
      for (const zone of zones) {
        const result = changeOk(zone, [reservationA(zone)], {
          id: "A",
          start: oct20("10:00"),
          end: oct20("13:00"),
          confirmedAmount: 16_500,
        });
        const a = find(result.reservations, "A");
        expect(a.status, zone).toBe("firm");
        expectRange(a, oct20("10:00"), oct20("13:00"), zone);
        expectRange(occupiedRange(a, a.bufferMinutes), oct20("10:00"), oct20("14:00"), zone);
        // プランA の通常帯 2,500円 × 6 = 15,000円（税抜）、税込 16,500円（「料金」の節）
        expect(result.estimate, zone).toEqual({
          subtotalExcludingTax: 15_000,
          estimateIncludingTax: 16_500,
        });
        expect(a.confirmedAmount, zone).toBe(16_500);
        expectDrafts(result.drafts, [{ kind: "change", reservationId: "A" }], zone);
      }
    });

    it("本予約 B 14:00–16:00 があるときに、A を 10:00–13:00 に延長：可（占有区間 10:00–14:00。14:00で接するだけ）", () => {
      for (const zone of zones) {
        const b = reservationB(zone);
        const result = changeOk(zone, [reservationA(zone), b], {
          id: "A",
          start: oct20("10:00"),
          end: oct20("13:00"),
          confirmedAmount: 16_500,
        });
        const a = find(result.reservations, "A");
        expect(a.status, zone).toBe("firm");
        expectRange(occupiedRange(a, a.bufferMinutes), oct20("10:00"), oct20("14:00"), zone);
        expectUnchanged(find(result.reservations, "B"), b, `${zone}、B`);
      }
    });

    it("本予約 B 14:00–16:00 があるときに、A を 10:00–13:30 に延長：不可（占有区間 10:00–14:30 が B と重なる）", () => {
      for (const zone of zones) {
        expect(
          change(zone, [reservationA(zone), reservationB(zone)], {
            id: "A",
            start: oct20("10:00"),
            end: oct20("13:30"),
            confirmedAmount: 19_250,
          }),
          zone,
        ).toEqual({ ok: false, reason: "overlaps-existing" });
      }
    });

    it("A を 11:00–13:00 に移動：可（変更前の自分の占有区間とは重なってよい）", () => {
      for (const zone of zones) {
        const result = changeOk(zone, [reservationA(zone)], {
          id: "A",
          start: oct20("11:00"),
          end: oct20("13:00"),
          confirmedAmount: 11_000,
        });
        const a = find(result.reservations, "A");
        expect(a.status, zone).toBe("firm");
        expectRange(a, oct20("11:00"), oct20("13:00"), zone);
      }
    });

    // 解放と確保の1トランザクション（INV-2）は、DB に書く側の統合テストで確かめる。ここでは解放・確保する枠を確かめる
    it("A を 10/27 10:00–12:00 に移動：可。10/20 の枠を解放し、10/27 の枠を確保する（1トランザクション）", () => {
      for (const zone of zones) {
        const result = changeOk(zone, [reservationA(zone)], {
          id: "A",
          start: "2026-10-27T10:00",
          end: "2026-10-27T12:00",
          confirmedAmount: 11_000,
        });
        const a = find(result.reservations, "A");
        expect(a.status, zone).toBe("firm");
        expectRange(a, "2026-10-27T10:00", "2026-10-27T12:00", zone);
        expectRanges(result.released, [[oct20("10:00"), oct20("13:00")]], zone);
        expectRanges(result.secured, [["2026-10-27T10:00", "2026-10-27T13:00"]], zone);
      }
    });

    // 移動のあとの確定金額は、例の金額 11,000円のまま（管理者が見積どおりに確定する）。
    // 取消は既存の取消（applyReservationOperation）で行う。10/22 の時刻は 12:00 とする
    it("A を 10/27 に移動したあと、10/22 に取消：キャンセル料は、利用日 10/27 の5日前として 50%", () => {
      for (const zone of zones) {
        const moved = changeOk(zone, [reservationA(zone)], {
          id: "A",
          start: "2026-10-27T10:00",
          end: "2026-10-27T12:00",
          confirmedAmount: 11_000,
        });
        const cancelled = operate(moved.reservations, {
          kind: "cancel",
          reservationId: "A",
          cancelledAt: at("2026-10-22T12:00", zone),
        });
        expect(find(cancelled.reservations, "A").status, zone).toBe("cancelled");
        expect(cancelled.drafts, zone).toContainEqual({
          kind: "cancellation",
          reservationId: "A",
          cancellationFee: { ratePercent: 50, fee: 5_500 },
        });
      }
    });
  });

  describe("仮予約 P が 10/20 15:00–19:00（仮予約の期限は 10/13 18:00）の場合。", () => {
    it("P を 11/10 15:00–19:00 に移動：仮予約のまま。期限は 11/03 18:00 になる", () => {
      for (const zone of zones) {
        const before = reservation(zone, {
          id: "P",
          status: "provisional",
          start: oct20("15:00"),
          end: oct20("19:00"),
        });
        expect(provisionalDeadline(before.start).toMillis(), zone).toBe(
          at("2026-10-13T18:00", zone).toMillis(),
        );
        const result = changeOk(zone, [before], {
          id: "P",
          start: "2026-11-10T15:00",
          end: "2026-11-10T19:00",
          confirmedAmount: 22_000,
        });
        const p = find(result.reservations, "P");
        expect(p.status, zone).toBe("provisional");
        expectRange(p, "2026-11-10T15:00", "2026-11-10T19:00", zone);
        expect(provisionalDeadline(p.start).toMillis(), zone).toBe(
          at("2026-11-03T18:00", zone).toMillis(),
        );
        expectDrafts(result.drafts, [{ kind: "change", reservationId: "P" }], zone);
      }
    });
  });

  // 仮予約 P 13:00–15:00（占有区間 13:00–16:00）と、P に付いた第二キープ K 14:00–17:00（占有区間 14:00–18:00）
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

  describe("仮予約 P が 13:00–15:00（占有区間 13:00–16:00）、第二キープ K が 14:00–17:00（占有区間 14:00–18:00）の場合。", () => {
    // 変更後の P の占有区間は 13:30–16:30。16:00–16:30 は K だけが確保していた枠で、P が使ってよい
    // （「P を動かすときの空き判定では、K が確保している枠のうち P と重なる部分は、P が使ってよい」）
    it("P を 13:30–15:30 に移動：可。P と K はまだ重なっているので、K はそのまま", () => {
      for (const zone of zones) {
        const k = reservationK(zone);
        const result = changeOk(zone, [reservationP(zone), k], {
          id: "P",
          start: oct20("13:30"),
          end: oct20("15:30"),
          confirmedAmount: 22_000,
        });
        const p = find(result.reservations, "P");
        expect(p.status, zone).toBe("provisional");
        expectRange(p, oct20("13:30"), oct20("15:30"), zone);
        // K は P に付いたまま
        const kAfter = find(result.reservations, "K");
        expectUnchanged(kAfter, k, `${zone}、K`);
        expect(kAfter.provisionalIds, `${zone}、K の付く仮予約の id`).toEqual(["P"]);
        expectDrafts(result.drafts, [{ kind: "change", reservationId: "P" }], zone);
      }
    });

    // K は P と重ならなくなるので、P に付かなくなる（K の付く仮予約の id から P を外す。reservation-model.md「第二キープと仮予約」）。
    // 「K の枠は確保されたまま」：K は第二キープのまま。解放するのは、10/20 の P の占有区間のうち K と重ならない 13:00–14:00 だけ。
    // 確保するのは、10/21 の P の占有区間 13:00–16:00
    it("P を翌日 13:00–15:00 に移動：可。P と K が重ならなくなるので、K のお客様への繰り上げ案内の下書きを作る。K の枠は確保されたまま", () => {
      for (const zone of zones) {
        const k = reservationK(zone);
        const result = changeOk(zone, [reservationP(zone), k], {
          id: "P",
          start: oct21("13:00"),
          end: oct21("15:00"),
          confirmedAmount: 22_000,
        });
        const p = find(result.reservations, "P");
        expect(p.status, zone).toBe("provisional");
        expectRange(p, oct21("13:00"), oct21("15:00"), zone);
        expectDetached(find(result.reservations, "K"), k, [], `${zone}、K`);
        expectDrafts(
          result.drafts,
          [
            { kind: "change", reservationId: "P" },
            { kind: "move-up-notice", reservationId: "K", remainingProvisionalIds: [] },
          ],
          zone,
        );
        expectRanges(result.released, [[oct20("13:00"), oct20("14:00")]], zone);
        expectRanges(result.secured, [[oct21("13:00"), oct21("16:00")]], zone);
      }
    });
  });

  // 小節の表には日時がないので、上の例と同じ P 13:00–15:00・K 14:00–17:00（10/20）で確かめる。
  // 動かす先と、ほかの予約・第二キープの日時は、このテストで決めたもの
  describe("第二キープが付いている仮予約の日時を変える", () => {
    // P を 15:00–17:00（占有区間 15:00–18:00）に動かす。K の占有区間 14:00–18:00 の中に収まり、
    // 16:00–18:00 は K だけが確保していた枠（P が使ってよい）
    it("動かしたあとも P と K が重なっている：何もしない（K は第二キープのまま）", () => {
      for (const zone of zones) {
        const k = reservationK(zone);
        const result = changeOk(zone, [reservationP(zone), k], {
          id: "P",
          start: oct20("15:00"),
          end: oct20("17:00"),
          confirmedAmount: 22_000,
        });
        expect(find(result.reservations, "P").status, zone).toBe("provisional");
        // K は第二キープのまま、P に付いたまま
        const kAfter = find(result.reservations, "K");
        expectUnchanged(kAfter, k, `${zone}、K`);
        expect(kAfter.provisionalIds, `${zone}、K の付く仮予約の id`).toEqual(["P"]);
        expectDrafts(result.drafts, [{ kind: "change", reservationId: "P" }], zone);
      }
    });

    // P を 19:00–21:00（占有区間 19:00–22:00）に動かす。K の占有区間 14:00–18:00 とは重ならない。
    // お客様の承諾・辞退はシステムの外（電話・メール）で受けるので、操作は管理者の繰り上げと取消（applyReservationOperation）。
    // 取消の日時は例にないので 10/10 12:00 とする（仮予約・第二キープの取消は無料なので、結果に関わらない）。
    // 「それ以降の P の動き（昇格・取消・さらに動かす）」は、変更のあとの状態から、P の昇格・P の取消（applyReservationOperation）・
    // P をさらに 10/22 13:00–15:00 へ動かす変更を、それぞれ行って確かめる。どれでも K は変わらず、K への下書きもできない
    it("動かしたあと P と K が重ならなくなった：P が取消になったときと同じ扱い。K は P に付かなくなり、それ以降の P の動き（昇格・取消・さらに動かす）は K に影響しない。K のお客様への繰り上げ案内の下書きを作り、承諾を受けたら管理者が K を仮予約に繰り上げる。辞退したら管理者が取消す", () => {
      for (const zone of zones) {
        const k = reservationK(zone);
        const moved = changeOk(zone, [reservationP(zone), k], {
          id: "P",
          start: oct20("19:00"),
          end: oct20("21:00"),
          confirmedAmount: 22_000,
        });
        expect(find(moved.reservations, "P").status, zone).toBe("provisional");
        // K は P に付かなくなる。第二キープのまま枠を確保する
        const kDetached = find(moved.reservations, "K");
        expectDetached(kDetached, k, [], `${zone}、K`);
        expectDrafts(
          moved.drafts,
          [
            { kind: "change", reservationId: "P" },
            { kind: "move-up-notice", reservationId: "K", remainingProvisionalIds: [] },
          ],
          zone,
        );

        // それ以降の P の昇格：K は終了せず、第二キープのまま。K への下書きはない。枠は変わらない
        const promoted = operate(moved.reservations, { kind: "promote", reservationId: "P" });
        expect(find(promoted.reservations, "P").status, `${zone}、昇格`).toBe("firm");
        expectUnchanged(find(promoted.reservations, "K"), kDetached, `${zone}、昇格のあとの K`);
        expect(
          promoted.drafts.filter((d) => d.reservationId === "K"),
          `${zone}、昇格の K への下書き`,
        ).toEqual([]);
        expectRanges(promoted.released, [], `${zone}、昇格`);

        // それ以降の P の取消：K は変わらない。K への下書きはない。解放するのは P の占有区間 19:00–22:00 だけ
        const cancelledP = operate(moved.reservations, {
          kind: "cancel",
          reservationId: "P",
          cancelledAt: at("2026-10-10T12:00", zone),
        });
        expect(find(cancelledP.reservations, "P").status, `${zone}、P の取消`).toBe("cancelled");
        expectUnchanged(
          find(cancelledP.reservations, "K"),
          kDetached,
          `${zone}、P の取消のあとの K`,
        );
        expect(
          cancelledP.drafts.filter((d) => d.reservationId === "K"),
          `${zone}、P の取消の K への下書き`,
        ).toEqual([]);
        expectRanges(cancelledP.released, [[oct20("19:00"), oct20("22:00")]], `${zone}、P の取消`);

        // それ以降に P をさらに動かす：K は変わらない。下書きは P の変更の下書きだけ
        const movedAgain = changeOk(zone, moved.reservations, {
          id: "P",
          start: "2026-10-22T13:00",
          end: "2026-10-22T15:00",
          confirmedAmount: 22_000,
        });
        expectUnchanged(
          find(movedAgain.reservations, "K"),
          kDetached,
          `${zone}、さらに動かしたあとの K`,
        );
        expectDrafts(
          movedAgain.drafts,
          [{ kind: "change", reservationId: "P" }],
          `${zone}、さらに動かす`,
        );

        // 承諾を受けた：管理者が K を仮予約に繰り上げる
        const movedUp = operate(moved.reservations, { kind: "move-up", reservationId: "K" });
        const kMovedUp = find(movedUp.reservations, "K");
        expect(kMovedUp.status, `${zone}、承諾`).toBe("provisional");
        expect(kMovedUp.provisionalIds, `${zone}、承諾`).toEqual([]);
        expectRange(kMovedUp, oct20("14:00"), oct20("17:00"), `${zone}、承諾`);

        // 辞退した：管理者が K を取消す。P とはもう重ならないので、K の占有区間 14:00–18:00 をすべて解放する
        const cancelled = operate(moved.reservations, {
          kind: "cancel",
          reservationId: "K",
          cancelledAt: at("2026-10-10T12:00", zone),
        });
        expect(find(cancelled.reservations, "K").status, `${zone}、辞退`).toBe("cancelled");
        expectRanges(cancelled.released, [[oct20("14:00"), oct20("18:00")]], `${zone}、辞退`);
      }
    });

    // ほかの予約：本予約 B 20:00–22:00（占有区間 20:00–23:00）があるときに、P を 19:00–21:00（占有区間 19:00–22:00）へ。
    // ほかの第二キープ：翌日に仮予約 P2 13:00–15:00（占有区間 13:00–16:00）と、P2 に付いた第二キープ K2 14:00–17:00
    // （占有区間 14:00–18:00）があるときに、P を翌日 16:00–18:00（占有区間 16:00–19:00）へ。P2 とは 16:00 で接するだけで、
    // K2 とだけ重なる（P の第二キープではないので、P は使えない）
    it("P を、ほかの予約や第二キープがある範囲へ動かす：不可（空き判定）", () => {
      for (const zone of zones) {
        const b = reservation(zone, {
          id: "B",
          status: "firm",
          start: oct20("20:00"),
          end: oct20("22:00"),
        });
        expect(
          change(zone, [reservationP(zone), reservationK(zone), b], {
            id: "P",
            start: oct20("19:00"),
            end: oct20("21:00"),
            confirmedAmount: 22_000,
          }),
          `${zone}、ほかの予約`,
        ).toEqual({ ok: false, reason: "overlaps-existing" });

        const p2 = reservation(zone, {
          id: "P2",
          status: "provisional",
          start: oct21("13:00"),
          end: oct21("15:00"),
        });
        const k2 = reservation(zone, {
          id: "K2",
          status: "second-hold",
          start: oct21("14:00"),
          end: oct21("17:00"),
          provisionalIds: ["P2"],
        });
        expect(
          change(zone, [reservationP(zone), reservationK(zone), p2, k2], {
            id: "P",
            start: oct21("16:00"),
            end: oct21("18:00"),
            confirmedAmount: 22_000,
          }),
          `${zone}、ほかの第二キープ`,
        ).toEqual({ ok: false, reason: "overlaps-existing" });
      }
    });
  });

  describe("プロパティ（INV-1。どの操作の列のあとでも成り立つこと）", () => {
    // 時刻は 10/20 00:00（JST）からの30分単位の枠で作る（10/20〜10/23 の範囲）
    const base = DateTime.fromISO("2026-10-20T00:00", { zone: "Asia/Tokyo" });
    const cancelledAt = DateTime.fromISO("2026-10-10T12:00", { zone: "Asia/Tokyo" });
    const slot = fc.integer({ min: 0, max: 48 * 3 });
    const anyZone = fc.constantFrom(...zones);
    const priceTable = currentPriceTable();

    // 予約区間：開始・終了は30分単位、長さは2〜24時間
    const range = fc
      .record({ startSlot: slot, lengthSlots: fc.integer({ min: 4, max: 48 }) })
      .map(({ startSlot, lengthSlots }) => ({
        startMinutes: startSlot * 30,
        endMinutes: (startSlot + lengthSlots) * 30,
      }));
    const shape = fc.record({
      range,
      bufferMinutes: fc.constantFrom<ReservationBufferMinutes>(30, 60),
    });
    // ブロック枠：長さは30分〜24時間。バッファは「なし／30分／1時間」
    const blockShape = fc.record({
      startSlot: slot,
      lengthSlots: fc.integer({ min: 1, max: 48 }),
      bufferMinutes: fc.constantFrom<BufferMinutes>(0, 30, 60),
    });
    // 変更後の申込内容。オプションは料金表の id（「料金」の節）
    const changeContent = fc.record({
      partySize: fc.integer({ min: 1, max: 20 }),
      cycloramaFloorProtection: fc.boolean(),
      equipmentInsurance: fc.boolean(),
      optionIds: fc.subarray(["workshop", "glitter"]),
    });
    const amount = fc.integer({ min: 0, max: 200_000 }).map((n) => Yen.parse(n));

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

    function isHolding(status: ReservationStatus): boolean {
      return holdingStatuses.includes(status);
    }
    function isSecondHold(status: ReservationStatus): boolean {
      return secondHoldStatuses.includes(status);
    }

    // テストの側で、ミリ秒の数で占有区間 [start, end + バッファ) を求める
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
          const allowed =
            pair.includes("provisional") && pair.some((status) => isSecondHold(status));
          expect(allowed, `${a.id}（${a.status}）と ${b.id}（${b.status}）が重なる`).toBe(true);
        }
        for (const block of blocks) {
          expect(overlaps(occupied(a), occupied(block)), `${a.id} がブロック枠と重なる`).toBe(
            false,
          );
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

    // 関数が引数を書き換えていないかを確かめるための写し
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
      s: {
        range: { startMinutes: number; endMinutes: number };
        bufferMinutes: ReservationBufferMinutes;
      },
      status: ReservationStatus,
      z: Zone,
    ): Reservation {
      return {
        id,
        status,
        start: base.plus({ minutes: s.range.startMinutes }).setZone(z),
        end: base.plus({ minutes: s.range.endMinutes }).setZone(z),
        bufferMinutes: s.bufferMinutes,
        provisionalIds: [],
        confirmedAmount: status.startsWith("pending-") ? null : otherConfirmedAmount,
      };
    }

    // 変更を確かめる。変更が可になるのは、変更後の占有区間が、枠を確保しているほかの予約（変更する予約自身と、
    // 変更するのが仮予約ならそれに付いている第二キープ〔承認待ちを含む〕を除く）とブロック枠の、どの占有区間とも重ならないときだけ。
    // 可なら、変更した予約は予約区間と確定金額だけが変わり、ほかの予約は変わらない。解放・確保する枠は、確保している占有区間の前後の差。
    // 見積は変更後の内容で料金表から再計算したもの。下書きは、変更の下書きと、変更で重ならなくなった第二キープ（承認済み）への繰り上げ案内。
    // 不可なら、何も変わらない（overlaps-existing）
    function checkChange(
      before: readonly Reservation[],
      blocks: readonly ExistingBlock[],
      target: Reservation,
      next: {
        start: DateTime;
        end: DateTime;
        content: ReservationChangeContent;
        confirmedAmount: Yen;
      },
    ): Reservation[] {
      const copy = snapshot(before);
      const result = applyReservationChange({
        reservations: before,
        blocks,
        priceTable,
        change: { reservationId: target.id, ...next },
      });
      expect(snapshot(before), "引数の予約を書き換えない").toEqual(copy);

      const nextOccupied = occupied({ ...next, bufferMinutes: target.bufferMinutes });
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
      ].filter((interval) => overlaps(interval, nextOccupied));

      if (conflicts.length > 0) {
        expect(result).toEqual({ ok: false, reason: "overlaps-existing" });
        return [...before];
      }
      if (!result.ok) {
        throw new Error(`${target.id}（${target.status}）の変更が失敗した（${result.reason}）`);
      }

      const after = result.reservations;
      expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
      // 仮予約を動かして重ならなくなった第二キープ（承認待ちを含む）は、その仮予約に付かなくなる（付く仮予約の id から外す）
      const nextTarget = { ...next, bufferMinutes: target.bufferMinutes };
      const detachedIds =
        target.status === "provisional"
          ? before
              .filter(
                (k) =>
                  isSecondHold(k.status) &&
                  k.provisionalIds.includes(target.id) &&
                  !overlaps(occupied(nextTarget), occupied(k)),
              )
              .map((k) => k.id)
          : [];
      for (const [i, b] of before.entries()) {
        const a = after[i]!;
        if (b.id === target.id) {
          expect(a.status, "状態は変えない").toBe(b.status);
          expect(a.start.toMillis()).toBe(next.start.toMillis());
          expect(a.end.toMillis()).toBe(next.end.toMillis());
          expect(a.bufferMinutes).toBe(b.bufferMinutes);
          expect(a.provisionalIds).toEqual(b.provisionalIds);
          expect(a.confirmedAmount).toBe(next.confirmedAmount);
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

      expect(result.estimate, "見積").toEqual(
        calculatePriceFromTable(priceTable, {
          planId: decidePlanId(priceTable, {
            partySize: next.content.partySize,
            cycloramaFloorProtection: next.content.cycloramaFloorProtection,
          }),
          start: next.start,
          end: next.end,
          equipmentInsurance: next.content.equipmentInsurance,
          optionIds: next.content.optionIds,
        }),
      );

      const targetAfter = find(after, target.id);
      const noticed =
        target.status === "provisional"
          ? before.filter(
              (k) =>
                k.status === "second-hold" &&
                k.provisionalIds.includes(target.id) &&
                overlaps(occupied(target), occupied(k)) &&
                !overlaps(occupied(targetAfter), occupied(k)),
            )
          : [];
      const notices = result.drafts.filter((d) => d.kind === "move-up-notice");
      expect(
        notices
          .map((d) => ({ ...d, remainingProvisionalIds: [...d.remainingProvisionalIds].sort() }))
          .sort((x, y) => (x.reservationId < y.reservationId ? -1 : 1)),
        "繰り上げ案内の下書き",
      ).toEqual(
        noticed
          .map((k) => ({
            kind: "move-up-notice",
            reservationId: k.id,
            remainingProvisionalIds: stillHeldBy(k, after).sort(),
          }))
          .sort((x, y) => (x.reservationId < y.reservationId ? -1 : 1)),
      );
      expect(
        result.drafts.filter((d) => d.kind !== "move-up-notice"),
        "変更の下書き",
      ).toEqual([{ kind: "change", reservationId: target.id }]);
      return [...after];
    }

    // 操作の列：申込（仮予約・本予約。承認待ちか、承認済み）、第二キープの申込（承認待ちか、承認済み）、承認、却下、
    // 昇格、取消、第二キープの繰り上げ、予約の変更（第二キープ付きの仮予約の移動を含む）。
    // 申込はテストの側で空き判定（checkAvailability・checkSecondHoldApplication）を通ったものだけを足す。
    // 変更するのは承認済みの仮予約・本予約（「承認のあとに予約の変更として行う」。第二キープ自身の変更は例にない）
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
        kind: fc.constantFrom(
          "approve" as const,
          "reject" as const,
          "promote" as const,
          "cancel" as const,
          "move-up" as const,
        ),
        pick: fc.nat(),
        confirmedAmount: amount,
      }),
      fc.record({
        kind: fc.constant("change" as const),
        pick: fc.nat(),
        range,
        content: changeContent,
        confirmedAmount: amount,
      }),
      // 第二キープ付きの仮予約の移動が起きやすいように、付いている第二キープの近くへ動かす変更も入れる
      fc.record({
        kind: fc.constant("change-near-second-hold" as const),
        pick: fc.nat(),
        attachedHold: fc.boolean(),
        offsetSlots: fc.integer({ min: -8, max: 8 }),
        lengthSlots: fc.integer({ min: 4, max: 12 }),
        content: changeContent,
        confirmedAmount: amount,
      }),
    );

    const targetStatuses = {
      promote: ["provisional"],
      cancel: ["provisional", "firm", "second-hold"],
      "move-up": ["second-hold"],
    } as const satisfies Record<ReservationOperation["kind"], readonly ReservationStatus[]>;

    it("申込・承認・却下・昇格・取消・繰り上げ・変更のどの列のあとでも、枠を確保している予約の占有区間は、第二キープと承認済みの仮予約の組を除いて重ならない。変更は空き判定を通るときだけ可で、不可なら何も変わらない。仮予約を動かして重ならなくなった第二キープはその仮予約に付かなくなり、それ以降のその仮予約の昇格・取消は第二キープに影響しない", () => {
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
                    reservations: [...reservations],
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
                  reservations: [...reservations],
                  blocks,
                });
                if (checked.ok) {
                  reservations = [
                    ...reservations,
                    { ...r, provisionalIds: checked.provisionalIds },
                  ];
                }
              } else if (s.kind === "approve" || s.kind === "reject") {
                if (reservations.length === 0) continue;
                const target = reservations[s.pick % reservations.length]!;
                const result =
                  s.kind === "approve"
                    ? approveReservation({
                        reservations,
                        reservationId: target.id,
                        confirmedAmount: s.confirmedAmount,
                      })
                    : rejectReservation({ reservations, reservationId: target.id });
                if (!pendingStatuses.includes(target.status)) {
                  expect(result).toEqual({ ok: false, reason: "not-pending" });
                  continue;
                }
                if (!result.ok) {
                  throw new Error(
                    `${s.kind} ${target.id}（${target.status}）が失敗した（${result.reason}）`,
                  );
                }
                reservations = [...result.reservations];
              } else if (s.kind === "change" || s.kind === "change-near-second-hold") {
                const candidates = reservations.filter(
                  (r) => r.status === "provisional" || r.status === "firm",
                );
                if (candidates.length === 0) continue;
                const target = candidates[s.pick % candidates.length]!;
                let start: DateTime;
                let end: DateTime;
                if (s.kind === "change") {
                  start = base.plus({ minutes: s.range.startMinutes }).setZone(z);
                  end = base.plus({ minutes: s.range.endMinutes }).setZone(z);
                } else {
                  // 付いている第二キープの近くか、付いていない第二キープ（重ならなくなって外れたものを含む）の近くへ動かす
                  const holds = reservations.filter((r) => isSecondHold(r.status));
                  const attached = holds.find((r) => r.provisionalIds.includes(target.id));
                  const anyHold = holds.length > 0 ? holds[s.pick % holds.length] : undefined;
                  const anchor = (s.attachedHold ? attached : anyHold) ?? target;
                  start = anchor.start.plus({ minutes: 30 * s.offsetSlots });
                  end = start.plus({ minutes: 30 * s.lengthSlots });
                }
                reservations = checkChange(reservations, blocks, target, {
                  start,
                  end,
                  content: s.content,
                  confirmedAmount: s.confirmedAmount,
                });
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
                // 繰り上げできるのは、付いている仮予約がすべて取消になったか、動いて重ならなくなった第二キープだけ
                if (s.kind === "move-up" && stillHeldBy(target, reservations).length > 0) {
                  expect(result).toEqual({ ok: false, reason: "still-held" });
                  continue;
                }
                if (!result.ok) {
                  throw new Error(
                    `${s.kind} ${target.id}（${target.status}）が失敗した（${result.reason}）`,
                  );
                }
                // 仮予約の昇格・取消が影響するのは、その仮予約に付いている第二キープだけ。
                // 動いて重ならなくなり、付かなくなった第二キープは変わらない
                if (s.kind === "promote" || s.kind === "cancel") {
                  for (const [i, b] of reservations.entries()) {
                    if (b.id === target.id || b.provisionalIds.includes(target.id)) continue;
                    const a = result.reservations[i]!;
                    expect(a.status, `${b.id}（${b.status}）は ${target.id} に付いていない`).toBe(
                      b.status,
                    );
                    expect(a.provisionalIds, `${b.id} の付く仮予約の id`).toEqual(b.provisionalIds);
                  }
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
});
