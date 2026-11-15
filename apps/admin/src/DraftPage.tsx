// 下書きを開く画面（GET /admin/reservations/{id}/drafts/{draftId}）。あて先・件名・本文を出し、Gmail に貼るためにコピーする。
// 送ったら「送信済み」、送らないなら「送らない」にする（POST …/sent、…/skip）。どちらも押す前に確かめる。
// 決まり（mail.md「下書きの送り方」）：
// - 管理画面はメールを送らない。Gmail を開くリンクや mailto も作らない（INV-6。送るのは管理者が Gmail で行う）
// - 本文は、API が返す HTML をそのまま描いて見た目（赤字・青字・下線）を見せる。API は差し込む値をエスケープ済み。
//   HTML として描くのはこの本文だけで、ほかの文字列（件名・あて先など）は文字のまま出す
// - 文面・あて先をログ（console）に出さない（INV-10）
import type { AdminDraftDetail } from "@zebra/contracts";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { AdminApi, DraftAction } from "./api.ts";
import type { Copier, RichCopyResult } from "./clipboard.ts";
import { formatDateTime } from "./format.ts";
import { draftFailureMessage, draftKindLabel, draftStatusLabel } from "./labels.ts";
import { detailHref, draftsHref } from "./route.ts";

type LoadState =
  | { kind: "loading" }
  | { kind: "loaded"; draft: AdminDraftDetail }
  | { kind: "failed"; message: string };

/** コピーしたあとに出す文。failed は role="alert" で出す */
type CopyNotice = { message: string; failed: boolean };

const actionLabel: Record<DraftAction, string> = {
  sent: "送信済み",
  skip: "送らない",
};

/** 色と下線を残してコピーする手（ClipboardItem が使えないとき） */
const SELECT_AND_COPY =
  "「本文を選ぶ」を押して（または下の本文をマウスで選んで）、Ctrl+C（Mac は ⌘+C）でコピーしてください。選んでコピーすれば、色と下線も残ります。";

export const richCopyMessage: Record<RichCopyResult, string> = {
  rich: "本文をコピーしました（色と下線つき）。Gmail の本文に貼ってください。",
  "text-only": `この環境では色と下線つきでコピーできないため、本文をテキストだけでコピーしました。${SELECT_AND_COPY}`,
  failed: `本文をコピーできませんでした。${SELECT_AND_COPY}`,
};

export function DraftPage(props: {
  api: AdminApi;
  copier: Copier;
  reservationId: string;
  draftId: string;
  /** 送信済み・送らないにしたとき（未送信の件数を読み直す） */
  onStatusChanged: () => void;
}) {
  const { api, copier, reservationId, draftId, onStatusChanged } = props;
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [copyNotice, setCopyNotice] = useState<CopyNotice>();
  const [confirming, setConfirming] = useState<DraftAction>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const bodyRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (): Promise<LoadState> => {
    const result = await api.getDraft(reservationId, draftId);
    return result.ok
      ? { kind: "loaded", draft: result.value }
      : { kind: "failed", message: draftFailureMessage(result.failure) };
  }, [api, reservationId, draftId]);

  useEffect(() => {
    let current = true;
    setState({ kind: "loading" });
    setCopyNotice(undefined);
    setConfirming(undefined);
    setNotice(undefined);
    setError(undefined);
    void load().then((next) => {
      if (current) setState(next);
    });
    return () => {
      current = false;
    };
  }, [load]);

  const copyBody = async (draft: AdminDraftDetail) => {
    const result = await copier.copyRich({ html: draft.html, text: draft.text });
    setCopyNotice({ message: richCopyMessage[result], failed: result === "failed" });
  };

  const copyPlain = async (name: string, text: string) => {
    const copied = await copier.copyText(text);
    setCopyNotice(
      copied
        ? { message: `${name}をコピーしました。`, failed: false }
        : {
            message: `${name}をコピーできませんでした。${name}を選んで、Ctrl+C（Mac は ⌘+C）でコピーしてください。`,
            failed: true,
          },
    );
  };

  /** 描いた本文を選ぶ（ClipboardItem が使えないとき、選んでコピーすれば色と下線が残る） */
  const selectBody = () => {
    const body = bodyRef.current;
    if (body !== null) window.getSelection()?.selectAllChildren(body);
  };

  const decide = async (action: DraftAction) => {
    setBusy(true);
    setNotice(undefined);
    setError(undefined);
    const result = await api.setDraftStatus(reservationId, draftId, action);
    setConfirming(undefined);
    if (result.ok) {
      setNotice(`${actionLabel[action]}にしました。未送信の一覧から消えました。`);
    } else {
      setError(`${actionLabel[action]}にできませんでした。${draftFailureMessage(result.failure)}`);
    }
    // できなかったとき（ほかの画面で先に変えていた、など）も、今の状態を読み直して見せる
    onStatusChanged();
    setState(await load());
    setBusy(false);
  };

  return (
    <section>
      <p>
        <a href={draftsHref()}>← 未送信の下書きの一覧へ</a> ・{" "}
        <a href={detailHref(reservationId)}>予約の詳細へ</a>
      </p>
      <h2>メールの下書き</h2>
      <p>
        <small>
          管理画面からはメールを送りません。内容を確かめ、あて先・件名・本文をコピーして Gmail
          に貼って送ってください。文面を直すときは、Gmail に貼ったあとで直します。
        </small>
      </p>
      {notice !== undefined && <p role="status">{notice}</p>}
      {error !== undefined && <p role="alert">{error}</p>}
      {state.kind === "loading" && <p>読み込み中…</p>}
      {state.kind === "failed" && <p role="alert">{state.message}</p>}
      {state.kind === "loaded" && (
        <DraftView
          draft={state.draft}
          bodyRef={bodyRef}
          copyNotice={copyNotice}
          onCopyBody={() => void copyBody(state.draft)}
          onCopySubject={() => void copyPlain("件名", state.draft.subject)}
          onCopyTo={(to) => void copyPlain("あて先", to)}
          onSelectBody={selectBody}
        >
          <DraftStatusPanel
            draft={state.draft}
            confirming={confirming}
            busy={busy}
            onConfirm={setConfirming}
            onDecide={(action) => void decide(action)}
          />
        </DraftView>
      )}
    </section>
  );
}

function DraftView(props: {
  draft: AdminDraftDetail;
  bodyRef: RefObject<HTMLDivElement | null>;
  copyNotice: CopyNotice | undefined;
  onCopyBody: () => void;
  onCopySubject: () => void;
  onCopyTo: (to: string) => void;
  onSelectBody: () => void;
  children: ReactNode;
}) {
  const { draft: d, bodyRef, copyNotice } = props;
  return (
    <>
      <dl>
        <dt>種類</dt>
        <dd>{draftKindLabel[d.kind]}</dd>
        <dt>状態</dt>
        <dd>{draftStatusLabel[d.status]}</dd>
        <dt>作った日時（JST）</dt>
        <dd>{formatDateTime(d.createdAt)}</dd>
      </dl>

      {d.attachConsentForm && (
        <p role="note" style={{ fontWeight: "bold", border: "2px solid", padding: "0.5em" }}>
          同意書を Gmail で添付する（同意書の PDF は、システムでは扱いません）
        </p>
      )}

      {copyNotice !== undefined &&
        (copyNotice.failed ? (
          <p role="alert">{copyNotice.message}</p>
        ) : (
          <p role="status">{copyNotice.message}</p>
        ))}

      <h3>あて先</h3>
      {d.to === undefined ? (
        <p role="note">
          メールアドレスがありません（電話で伝える）。電話で伝えたら「送信済み」、伝えないなら「送らない」にしてください。
        </p>
      ) : (
        <p>
          <span>{d.to}</span>{" "}
          <button type="button" onClick={() => props.onCopyTo(d.to ?? "")}>
            あて先をコピー
          </button>
        </p>
      )}

      <h3>件名</h3>
      <p>
        <span>{d.subject}</span>{" "}
        <button type="button" onClick={props.onCopySubject}>
          件名をコピー
        </button>
      </p>

      <h3>本文</h3>
      <p>
        <button type="button" onClick={props.onCopyBody}>
          本文をコピー
        </button>{" "}
        <button type="button" onClick={props.onSelectBody}>
          本文を選ぶ
        </button>{" "}
        <small>
          色と下線（赤字・青字・下線）つきでコピーします。Gmail の本文に貼ってください。
        </small>
      </p>
      <div
        ref={bodyRef}
        role="document"
        aria-label="本文"
        style={{ border: "1px solid #999", padding: "1em" }}
        // API が返す本文の HTML（差し込む値はエスケープ済み）。HTML として描くのはここだけ
        dangerouslySetInnerHTML={{ __html: d.html }}
      />

      {props.children}
    </>
  );
}

/** 送信済みにする・送らないにする。未送信の下書きだけ。どちらも押す前に確かめる */
function DraftStatusPanel(props: {
  draft: AdminDraftDetail;
  confirming: DraftAction | undefined;
  busy: boolean;
  onConfirm: (action: DraftAction | undefined) => void;
  onDecide: (action: DraftAction) => void;
}) {
  const { draft, confirming, busy, onConfirm, onDecide } = props;
  if (draft.status !== "unsent") {
    return (
      <section aria-label="送ったあと">
        <h3>送ったあと</h3>
        <p>
          この下書きは「{draftStatusLabel[draft.status]}」にしてあります。未送信には戻せません。
        </p>
      </section>
    );
  }
  const question: Record<DraftAction, string> = {
    sent:
      draft.to === undefined
        ? "電話で伝えましたか？送信済みにすると、未送信の一覧から消え、未送信には戻せません。"
        : "Gmail から送りましたか？送信済みにすると、未送信の一覧から消え、未送信には戻せません。",
    skip: "送らないにすると、未送信の一覧から消え、未送信には戻せません。送らないにしますか？",
  };
  return (
    <section aria-label="送ったあと">
      <h3>送ったあと</h3>
      {confirming === undefined ? (
        <p>
          <button type="button" disabled={busy} onClick={() => onConfirm("sent")}>
            送信済みにする…
          </button>{" "}
          <button type="button" disabled={busy} onClick={() => onConfirm("skip")}>
            送らないにする…
          </button>
        </p>
      ) : (
        <div role="group" aria-label={`${actionLabel[confirming]}にする確認`}>
          <p>{question[confirming]}</p>
          <button type="button" disabled={busy} onClick={() => onDecide(confirming)}>
            {actionLabel[confirming]}にする
          </button>{" "}
          <button type="button" disabled={busy} onClick={() => onConfirm(undefined)}>
            やめる
          </button>
        </div>
      )}
    </section>
  );
}
