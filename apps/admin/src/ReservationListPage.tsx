// 予約の一覧（GET /admin/reservations）。期間と状態で絞り、予約とブロック枠を開始の早い順に表にする。予約の行から詳細へ。
// ブロック枠は、ここから入れる・直す・消す（ブロック枠の詳細のルートはないので、直すときは行の値を使う）
import { HoldingReservationStatus, type AdminReservationList } from "@zebra/contracts";
import { useEffect, useState, type FormEvent } from "react";
import type { AdminApi } from "./api.ts";
import { BlockDeleteConfirm, BlockForm } from "./BlockForm.tsx";
import { compareByTime, formatTimeRange, formatYen } from "./format.ts";
import { blockRouteLabel, failureMessage, reservationRouteLabel, statusLabel } from "./labels.ts";
import { loadList, type ListFilter, type StatusFilter } from "./list.ts";
import { detailHref, navigate } from "./route.ts";

type Reservation = AdminReservationList["reservations"][number];
type Block = AdminReservationList["blocks"][number];
type Row = { kind: "reservation"; item: Reservation } | { kind: "block"; item: Block };

/** ブロック枠の操作：入れる、行のブロック枠を直す・消す */
type BlockAction =
  { kind: "create" } | { kind: "edit"; block: Block } | { kind: "delete"; block: Block };

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; list: AdminReservationList }
  | { kind: "failed"; message: string };

const statusOptions: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "すべて（ブロック枠を含む）" },
  { value: "pending", label: "承認待ち（仮・本・第二キープ）" },
  ...HoldingReservationStatus.options.map((status) => ({
    value: status,
    label: statusLabel[status],
  })),
];

export function ReservationListPage(props: {
  api: AdminApi;
  filter: ListFilter;
  onFilterChange: (filter: ListFilter) => void;
}) {
  const { api, filter, onFilterChange } = props;
  const [draft, setDraft] = useState<ListFilter>(filter);
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadCount, setReloadCount] = useState(0);
  const [blockAction, setBlockAction] = useState<BlockAction>();
  const [notice, setNotice] = useState<string>();

  useEffect(() => setDraft(filter), [filter]);

  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    void loadList(api, filter).then((result) => {
      if (!current) return;
      setState(
        result.ok
          ? { kind: "loaded", list: result.value }
          : { kind: "failed", message: failureMessage(result.failure) },
      );
    });
    return () => {
      current = false;
    };
  }, [api, filter, reloadCount]);

  /** ブロック枠を入れた・直した・消したあと：閉じて、一覧を読み直す */
  const onBlockSaved = (message: string) => {
    setBlockAction(undefined);
    setNotice(message);
    setReloadCount((count) => count + 1);
  };
  const openBlockAction = (action: BlockAction | undefined) => {
    setNotice(undefined);
    setBlockAction(action);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onFilterChange({ ...draft });
  };

  const showPending = () => onFilterChange({ ...draft, status: "pending", ignorePeriod: true });

  return (
    <section>
      <h2>予約の一覧</h2>
      <form onSubmit={submit} aria-label="絞り込み">
        <label>
          期間{" "}
          <input
            type="date"
            aria-label="期間の初日"
            value={draft.from}
            disabled={draft.status !== "all" && draft.ignorePeriod}
            onChange={(e) => setDraft({ ...draft, from: e.target.value })}
          />
        </label>
        〜
        <input
          type="date"
          aria-label="期間の末日"
          value={draft.to}
          disabled={draft.status !== "all" && draft.ignorePeriod}
          onChange={(e) => setDraft({ ...draft, to: e.target.value })}
        />{" "}
        <label>
          状態{" "}
          <select
            value={draft.status}
            onChange={(e) => setDraft({ ...draft, status: e.target.value as StatusFilter })}
          >
            {statusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>{" "}
        <label>
          <input
            type="checkbox"
            checked={draft.ignorePeriod}
            disabled={draft.status === "all"}
            onChange={(e) => setDraft({ ...draft, ignorePeriod: e.target.checked })}
          />
          期間によらず探す
        </label>{" "}
        <button type="submit">表示</button>{" "}
        <button type="button" onClick={showPending}>
          承認待ちをすべて見る
        </button>
      </form>
      <p>
        <small>
          一覧に出るのは、枠を確保している予約（承認待ち・仮予約・本予約・第二キープ）とブロック枠です。取消・終了した予約は、受付番号から開いてください。期間は最長62日です。
        </small>
      </p>
      {blockAction?.kind !== "create" && (
        <p>
          <button type="button" onClick={() => openBlockAction({ kind: "create" })}>
            ブロック枠を入れる…
          </button>
        </p>
      )}
      {notice !== undefined && <p role="status">{notice}</p>}
      {blockAction?.kind === "create" && (
        <BlockForm api={api} onSaved={onBlockSaved} onCancel={() => openBlockAction(undefined)} />
      )}
      <ListBody
        api={api}
        state={state}
        blockAction={blockAction}
        onBlockAction={openBlockAction}
        onBlockSaved={onBlockSaved}
      />
    </section>
  );
}

function ListBody(props: {
  api: AdminApi;
  state: LoadState;
  blockAction: BlockAction | undefined;
  onBlockAction: (action: BlockAction | undefined) => void;
  onBlockSaved: (message: string) => void;
}) {
  const { api, state, blockAction, onBlockAction, onBlockSaved } = props;
  if (state.kind === "loading") return <p>読み込み中…</p>;
  if (state.kind === "failed") return <p role="alert">{state.message}</p>;

  const rows: Row[] = [
    ...state.list.reservations.map((item): Row => ({ kind: "reservation", item })),
    ...state.list.blocks.map((item): Row => ({ kind: "block", item })),
  ].sort((a, b) => compareByTime(a.item, b.item));

  if (rows.length === 0) return <p>該当する予約・ブロック枠はありません。</p>;

  return (
    <>
      <p>
        予約 {state.list.reservations.length}件・ブロック枠 {state.list.blocks.length}件
      </p>
      <table>
        <thead>
          <tr>
            <th>日時（JST）</th>
            <th>種類・状態</th>
            <th>氏名・メモ</th>
            <th>人数</th>
            <th>見積額（税込）</th>
            <th>確定金額（税込）</th>
            <th>バッファ</th>
            <th>経路</th>
            <th>受付番号</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) =>
            row.kind === "reservation" ? (
              <ReservationRow key={`r-${row.item.id}`} reservation={row.item} />
            ) : (
              <BlockRows
                key={`b-${row.item.id}`}
                api={api}
                block={row.item}
                action={
                  blockAction !== undefined &&
                  blockAction.kind !== "create" &&
                  blockAction.block.id === row.item.id
                    ? blockAction.kind
                    : undefined
                }
                onAction={onBlockAction}
                onSaved={onBlockSaved}
              />
            ),
          )}
        </tbody>
      </table>
    </>
  );
}

function ReservationRow({ reservation: r }: { reservation: Reservation }) {
  const href = detailHref(r.id);
  return (
    <tr onClick={() => navigate(href)} style={{ cursor: "pointer" }}>
      <td>
        <a href={href}>{formatTimeRange(r.start, r.end)}</a>
      </td>
      <td>{statusLabel[r.status]}</td>
      <td>{r.customerName}</td>
      <td>{r.partySize}人</td>
      <td>{formatYen(r.estimateIncludingTax)}</td>
      <td>{r.confirmedPrice === undefined ? "未定" : formatYen(r.confirmedPrice)}</td>
      <td>{r.bufferMinutes}分</td>
      <td>{reservationRouteLabel[r.route]}</td>
      <td>{r.receiptNumber ?? "—"}</td>
      <td></td>
    </tr>
  );
}

const COLUMN_COUNT = 10;

/** ブロック枠の行と、直す・消すを開いたときのフォームの行 */
function BlockRows(props: {
  api: AdminApi;
  block: Block;
  action: "edit" | "delete" | undefined;
  onAction: (action: BlockAction | undefined) => void;
  onSaved: (message: string) => void;
}) {
  const { api, block: b, action, onAction, onSaved } = props;
  // Googleカレンダーから取り込んだブロック枠は、取り込みで更新するので、直す・消すを出さない（booking.md「ブロック枠を消す・直す」）
  const editable = b.route === "admin";
  const close = () => onAction(undefined);
  return (
    <>
      <tr>
        <td>{formatTimeRange(b.start, b.end)}</td>
        <td>ブロック枠</td>
        <td>{b.memo ?? "—"}</td>
        <td>—</td>
        <td>—</td>
        <td>—</td>
        <td>{b.bufferMinutes}分</td>
        <td>{blockRouteLabel[b.route]}</td>
        <td>—</td>
        <td>
          {editable && action === undefined && (
            <>
              <button type="button" onClick={() => onAction({ kind: "edit", block: b })}>
                直す…
              </button>{" "}
              <button type="button" onClick={() => onAction({ kind: "delete", block: b })}>
                消す…
              </button>
            </>
          )}
        </td>
      </tr>
      {action !== undefined && (
        <tr>
          <td colSpan={COLUMN_COUNT}>
            {action === "edit" ? (
              <BlockForm api={api} block={b} onSaved={onSaved} onCancel={close} />
            ) : (
              <BlockDeleteConfirm api={api} block={b} onDeleted={onSaved} onCancel={close} />
            )}
          </td>
        </tr>
      )}
    </>
  );
}
