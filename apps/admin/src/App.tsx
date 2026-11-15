// 管理画面。ログイン（Cognito）はまだなく、手元の API（DEV_ADMIN_USER_ID の管理者）に dev サーバーの中継でつなぐ
import type { DateTime } from "luxon";
import { useState } from "react";
import type { AdminApi } from "./api.ts";
import { monthOf } from "./format.ts";
import type { ListFilter } from "./list.ts";
import { DirectEntryPage } from "./DirectEntryPage.tsx";
import { ReceiptSearch } from "./ReceiptSearch.tsx";
import { ReservationDetailPage } from "./ReservationDetailPage.tsx";
import { ReservationListPage } from "./ReservationListPage.tsx";
import { detailHref, directEntryHref, listHref, navigate, parseRoute, useHash } from "./route.ts";

export function App(props: { api: AdminApi; now: () => DateTime }) {
  const { api, now } = props;
  const route = parseRoute(useHash());
  // 一覧の絞り込みは、詳細から戻っても残す。期間の初期値は今月（JST）
  const [filter, setFilter] = useState<ListFilter>(() => ({
    ...monthOf(now()),
    status: "all",
    ignorePeriod: false,
  }));

  return (
    <>
      <header>
        <h1>スタジオゼブラ 管理画面</h1>
        <p>
          <small>手元の開発用（ログインなし）</small>
        </p>
        <nav aria-label="画面">
          <a href={listHref()}>予約の一覧</a> ・ <a href={directEntryHref()}>予約を直接入れる</a>
        </nav>
        <ReceiptSearch api={api} onFound={(id) => navigate(detailHref(id))} />
      </header>
      <main>
        {route.page === "detail" && (
          <ReservationDetailPage api={api} reservationId={route.reservationId} />
        )}
        {route.page === "direct-entry" && (
          <DirectEntryPage api={api} onCreated={(id) => navigate(detailHref(id))} />
        )}
        {route.page === "list" && (
          <ReservationListPage api={api} filter={filter} onFilterChange={setFilter} />
        )}
      </main>
    </>
  );
}
