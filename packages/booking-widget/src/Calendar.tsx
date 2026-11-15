// 月のカレンダー（docs/product-specs/index.md「予約ウィジェット」）。
// 日ごとに、すでに入っている予約の表示名と時間を、時間の早い順に並べる（INV-3。出すのは表示名と時間だけ）。
// 各日のマスには3件まで出し、残りは「他○件」と出す。押すと、その日の予約をすべて並べた一覧を開く（ユーザーの判断）
import type { PublicCalendar } from "@zebra/contracts";
import type { DateTime } from "luxon";
import { useState } from "react";
import {
  calendarWeeks,
  compareBookings,
  formatBooking,
  formatDay,
  formatMonth,
  type PublicBooking,
} from "./format.ts";

/** 各日のマスに出す予約の数。超えた分は「他○件」 */
export const BOOKINGS_PER_CELL = 3;

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

export type CalendarState =
  { status: "loading" } | { status: "error" } | { status: "ready"; calendar: PublicCalendar };

export interface CalendarProps {
  /** 表示する月（JST の月の初日） */
  month: DateTime;
  state: CalendarState;
  /** 今日（JST、YYYY-MM-DD） */
  today: string;
  /** 申込フォームで選んでいる利用日 */
  selectedDate: string;
  canGoPrevious: boolean;
  onPrevious(): void;
  onNext(): void;
  onRetry(): void;
  /** 日付を押したとき（申込フォームの利用日にする） */
  onSelectDate(date: string): void;
}

export function Calendar(props: CalendarProps) {
  const { month, state } = props;
  const [openDate, setOpenDate] = useState<string | undefined>(undefined);

  const bookingsByDate = new Map<string, PublicBooking[]>();
  if (state.status === "ready") {
    for (const day of state.calendar.days) {
      bookingsByDate.set(day.date, [...day.bookings].sort(compareBookings));
    }
  }
  const openBookings = openDate === undefined ? undefined : bookingsByDate.get(openDate);

  return (
    <section className="zw-calendar" aria-label="予約状況のカレンダー">
      <div className="zw-calendar-header">
        <button type="button" onClick={props.onPrevious} disabled={!props.canGoPrevious}>
          ← 前の月
        </button>
        <h3 className="zw-month" aria-live="polite">
          {formatMonth(month)}
        </h3>
        <button type="button" onClick={props.onNext}>
          次の月 →
        </button>
      </div>

      {state.status === "loading" && (
        <p className="zw-status" role="status">
          予約状況を読み込んでいます…
        </p>
      )}
      {state.status === "error" && (
        <div className="zw-status zw-error" role="alert">
          <p>予約状況を読み込めませんでした。時間をおいてもう一度お試しください。</p>
          <button type="button" onClick={props.onRetry}>
            もう一度読み込む
          </button>
        </div>
      )}

      <table className="zw-grid">
        <thead>
          <tr>
            {WEEKDAYS.map((weekday) => (
              <th key={weekday} scope="col">
                {weekday}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {calendarWeeks(month).map((week, weekIndex) => (
            <tr key={weekIndex}>
              {week.map((date, dayIndex) =>
                date === null ? (
                  <td key={dayIndex} className="zw-cell zw-outside">
                    <div className="zw-cell-inner" />
                  </td>
                ) : (
                  <DayCell
                    key={date}
                    date={date}
                    bookings={bookingsByDate.get(date) ?? []}
                    isToday={date === props.today}
                    isPast={date < props.today}
                    isSelected={date === props.selectedDate}
                    onSelect={() => props.onSelectDate(date)}
                    onOpen={() => setOpenDate(date)}
                  />
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {openDate !== undefined && openBookings !== undefined && (
        <DayList
          date={openDate}
          bookings={openBookings}
          onClose={() => setOpenDate(undefined)}
          onSelect={() => {
            props.onSelectDate(openDate);
            setOpenDate(undefined);
          }}
        />
      )}
    </section>
  );
}

function DayCell(props: {
  date: string;
  bookings: PublicBooking[];
  isToday: boolean;
  isPast: boolean;
  isSelected: boolean;
  onSelect(): void;
  onOpen(): void;
}) {
  const shown = props.bookings.slice(0, BOOKINGS_PER_CELL);
  const rest = props.bookings.length - shown.length;
  const className = [
    "zw-cell",
    props.isToday ? "zw-today" : "",
    props.isPast ? "zw-past" : "",
    props.isSelected ? "zw-selected" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <td className={className} data-date={props.date}>
      <div className="zw-cell-inner">
        <button
          type="button"
          className="zw-day"
          onClick={props.onSelect}
          aria-label={`${formatDay(props.date)}を利用日に選ぶ`}
          aria-pressed={props.isSelected}
        >
          {Number(props.date.slice(8))}
        </button>
        <ul className="zw-bookings">
          {shown.map((booking, index) => (
            <li key={index} className={`zw-booking zw-${booking.label}`}>
              {formatBooking(booking, props.date)}
            </li>
          ))}
        </ul>
        {rest > 0 && (
          <button
            type="button"
            className="zw-more"
            onClick={props.onOpen}
            aria-label={`${formatDay(props.date)}の予約をすべて見る（他${rest}件）`}
          >
            他{rest}件
          </button>
        )}
      </div>
    </td>
  );
}

function DayList(props: {
  date: string;
  bookings: PublicBooking[];
  onClose(): void;
  onSelect(): void;
}) {
  const title = `${formatDay(props.date)}の予約`;
  return (
    <div className="zw-daylist" role="dialog" aria-label={title}>
      <h4>{title}</h4>
      <ul>
        {props.bookings.map((booking, index) => (
          <li key={index} className={`zw-booking zw-${booking.label}`}>
            {formatBooking(booking, props.date)}
          </li>
        ))}
      </ul>
      <div className="zw-actions">
        <button type="button" onClick={props.onSelect}>
          この日を利用日に選ぶ
        </button>
        <button type="button" onClick={props.onClose}>
          閉じる
        </button>
      </div>
    </div>
  );
}
