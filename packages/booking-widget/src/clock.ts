// 現在時刻（INV-7）。本来は時計の部品（packages/clock）から取るが、まだ中身がなく、
// ウィジェットは依存の決まり（.dependency-cruiser.cjs）で packages/clock に依存できない。
// そこで、ウィジェットで現在時刻を取る所をこの1か所に決める（apps/api の app.ts、apps/admin の main.tsx と同じ考え）。
// 部品には関数として渡し、テストでは固定した時刻を渡す（lint が止める new Date()・Date.now() は使わない）
import { DateTime } from "luxon";

export type Now = () => DateTime;

export const systemNow: Now = () => DateTime.now();
