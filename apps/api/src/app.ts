// 予約API の本体。ローカルでは server.ts（Node サーバー）、本番では lambda.ts（Lambda）から同じ app を動かす
import { currentPriceTable } from "@zebra/booking-core";
import { Hono } from "hono";
import { DateTime } from "luxon";
import { createDynamoClient } from "./db/client.ts";
import type { ReservationStore } from "./db/reservations.ts";
import { createPublicApplicationRoute } from "./public/applications.ts";
import { createPublicCalendarRoute } from "./public/calendar.ts";

/**
 * 現在時刻（INV-7）。本来は時計の部品（packages/clock）から取るが、まだ中身がないので、
 * API で現在時刻を取る所をこの1か所に決める。ルートには関数として渡し、テストでは固定した時刻を渡す。
 * packages/clock ができたら、ここだけを置き換える（lint が止める new Date()・Date.now() は使わない）
 */
const now = (): DateTime => DateTime.now();

/** API の本体を組み立てる。読み書きするテーブルは引数で受け取る（テストからは DynamoDB Local のテーブルを渡せる） */
export function createApp(store: ReservationStore): Hono {
  const app = new Hono();

  // 動作確認用。予約の内容や個人情報は返さない（INV-3）
  app.get("/health", (c) => c.json({ status: "ok" }));

  // 公開API（認証なし）：予約状況 GET /public/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD（INV-3）
  app.route("/public", createPublicCalendarRoute(store));

  // 公開API（認証なし）：申込 POST /public/applications（booking.md「申込フォーム」。INV-3、INV-4）
  app.route(
    "/public",
    createPublicApplicationRoute({ store, now, priceTable: currentPriceTable() }),
  );

  return app;
}

/**
 * 環境変数から、読み書きするテーブルを決める（server.ts の PORT と同じく、起動する環境が渡す）
 * - DYNAMODB_TABLE_NAME：テーブルの名前。必須。ないときは、テーブルを使うリクエストでエラーにする
 *   （起動のときには確かめない。テーブルを使わない /health は、ないままでも動く）
 * - DYNAMODB_ENDPOINT：ローカルの DynamoDB の URL。省略すると AWS の DynamoDB に接続する
 * - AWS_REGION：リージョン。Lambda では自動で入る。省略すると ap-northeast-1
 */
export function storeFromEnvironment(env: NodeJS.ProcessEnv): ReservationStore {
  const endpoint = env["DYNAMODB_ENDPOINT"];
  const client = createDynamoClient({
    region: env["AWS_REGION"] ?? "ap-northeast-1",
    ...(endpoint === undefined || endpoint === "" ? {} : { endpoint }),
  });
  return {
    client,
    get tableName(): string {
      const tableName = env["DYNAMODB_TABLE_NAME"];
      if (tableName === undefined || tableName === "") {
        throw new Error("環境変数 DYNAMODB_TABLE_NAME がない");
      }
      return tableName;
    },
  };
}

export const app = createApp(storeFromEnvironment(process.env));
