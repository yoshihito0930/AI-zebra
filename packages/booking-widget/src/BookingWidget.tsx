// 予約ウィジェット（docs/product-specs/index.md「予約ウィジェット」）。HP の予約ページに埋め込む。
// 月のカレンダー（予約状況）、第二キープと予約の間の案内、申込フォームを並べる。
// 予約状況は公開 API の返事（表示名と時間だけ。INV-3）をそのまま出し、誰の予約か・承認待ちか・金額は推測しない
import { currentPriceTable } from "@zebra/booking-core";
import type { PriceTable } from "@zebra/contracts";
import { useEffect, useMemo, useState } from "react";
import { createPublicApi, type FetchLike, type PublicApi } from "./api.ts";
import { ApplicationForm, Guidance, type ApplicationFormLinks } from "./ApplicationForm.tsx";
import { Calendar, type CalendarState } from "./Calendar.tsx";
import { systemNow, type Now } from "./clock.ts";
import { dayStart, jstDate, monthRange, monthStartOf, type PublicBooking } from "./format.ts";
import { WIDGET_CSS } from "./styles.ts";

export interface BookingWidgetProps {
  /** 公開 API の呼び出し。省略時は同じオリジンの /public を fetch で呼ぶ */
  api?: PublicApi;
  /** 現在時刻（INV-7）。省略時は clock.ts の systemNow。テストでは固定する */
  now?: Now;
  /** 料金表（見積に使う）。省略時は booking-core の今の料金表（API と同じ） */
  priceTable?: PriceTable;
  /** ホリゾントルールと利用規約のページ。省略時は HP の /horizon/ と /policy/ */
  links?: ApplicationFormLinks;
}

const defaultFetch: FetchLike = (input, init) => fetch(input, init);
const DEFAULT_LINKS: ApplicationFormLinks = { horizon: "/horizon/", policy: "/policy/" };

export function BookingWidget(props: BookingWidgetProps) {
  const now = props.now ?? systemNow;
  const api = useMemo(() => props.api ?? createPublicApi(defaultFetch), [props.api]);
  const priceTable = useMemo(() => props.priceTable ?? currentPriceTable(), [props.priceTable]);
  const links = props.links ?? DEFAULT_LINKS;

  const today = jstDate(now());
  const thisMonth = monthStartOf(now());
  const [month, setMonth] = useState(thisMonth);
  const [state, setState] = useState<CalendarState>({ status: "loading" });
  const [reload, setReload] = useState(0);
  const [selectedDate, setSelectedDate] = useState("");

  const monthKey = month.toISODate() ?? "";
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void api.getCalendar(monthRange(dayStart(monthKey))).then((result) => {
      if (cancelled) return;
      setState(result.ok ? { status: "ready", calendar: result.value } : { status: "error" });
    });
    return () => {
      cancelled = true;
    };
    // 月が変わったとき（monthKey で比べる）と、読み直すときに読む
  }, [api, monthKey, reload]);

  // フォームの重なりの案内に使う、読み込んだ月の予約（日をまたぐ予約は両方の日に入るので、1件にまとめる）
  const bookings = useMemo(() => {
    if (state.status !== "ready") return [];
    const unique = new Map<string, PublicBooking>();
    for (const day of state.calendar.days) {
      for (const booking of day.bookings) {
        unique.set(`${booking.label} ${booking.start} ${booking.end}`, booking);
      }
    }
    return [...unique.values()];
  }, [state]);

  const selectDate = (date: string) => {
    setSelectedDate(date);
    // 選んだ日の月をカレンダーに出す（フォームの重なりの案内は、出している月の予約で行う）
    if (date !== "") {
      const selectedMonth = monthStartOf(dayStart(date));
      if (selectedMonth.toMillis() !== month.toMillis()) setMonth(selectedMonth);
    }
  };

  return (
    <div className="zw-root">
      <style>{WIDGET_CSS}</style>
      <section aria-label="予約状況">
        <h2>予約状況</h2>
        <p className="zw-note">
          すでに入っている予約の種類と時間です。空いている時間に申込めます。日付を押すと、申込フォームの利用日になります。
        </p>
        <Guidance />
        <Calendar
          month={month}
          state={state}
          today={today}
          selectedDate={selectedDate}
          canGoPrevious={month.toMillis() > thisMonth.toMillis()}
          onPrevious={() => setMonth(month.minus({ months: 1 }))}
          onNext={() => setMonth(month.plus({ months: 1 }))}
          onRetry={() => setReload((count) => count + 1)}
          onSelectDate={selectDate}
        />
      </section>
      <ApplicationForm
        api={api}
        now={now}
        priceTable={priceTable}
        bookings={bookings}
        date={selectedDate}
        onDateChange={selectDate}
        onAccepted={() => setReload((count) => count + 1)}
        links={links}
      />
    </div>
  );
}
