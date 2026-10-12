// 統合テストの前に、ローカルの DynamoDB が起動しているかを確かめる
import { DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";

const endpoint = process.env["DYNAMODB_ENDPOINT"] ?? "http://127.0.0.1:8000";

export default async function setup() {
  const client = new DynamoDBClient({
    endpoint,
    region: "ap-northeast-1",
    // ローカルの DynamoDB は認証情報を確かめないので、ダミーの値を使う（本物の秘密情報ではない）
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
  for (let i = 0; i < 30; i++) {
    try {
      await client.send(new ListTablesCommand({}));
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(
    `ローカルの DynamoDB（${endpoint}）に接続できない。先に pnpm db:up を実行する（Docker が必要）`,
  );
}
