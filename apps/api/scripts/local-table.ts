// 手元で API を動かすためのテーブルを、ローカルの DynamoDB（pnpm db:up）に作る。使い方：pnpm db:table
// テーブルはキー設計（docs/design-docs/dynamodb-keys.md）どおり：pk・sk と、GSI の gsi1（gsi1pk・gsi1sk）。
// AWS の DynamoDB には作らない（接続先が手元でなければ止める）
import {
  CreateTableCommand,
  type CreateTableCommandInput,
  DescribeTableCommand,
  type DynamoDBClient,
  ResourceNotFoundException,
} from "@aws-sdk/client-dynamodb";
import { createDynamoClient } from "../src/db/client.ts";

/** 手元のテーブルの既定の名前 */
export const DEFAULT_LOCAL_TABLE_NAME = "zebra-local";
/** 手元の DynamoDB の既定の URL（compose.yaml のポート） */
export const DEFAULT_LOCAL_ENDPOINT = "http://127.0.0.1:8000";

/** キー設計どおりのテーブルの定義 */
export function tableDefinition(tableName: string): CreateTableCommandInput {
  return {
    TableName: tableName,
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
      { AttributeName: "gsi1pk", AttributeType: "S" },
      { AttributeName: "gsi1sk", AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    GlobalSecondaryIndexes: [
      {
        IndexName: "gsi1",
        KeySchema: [
          { AttributeName: "gsi1pk", KeyType: "HASH" },
          { AttributeName: "gsi1sk", KeyType: "RANGE" },
        ],
        Projection: { ProjectionType: "ALL" },
      },
    ],
    BillingMode: "PAY_PER_REQUEST",
  };
}

/** 接続先が手元（localhost・127.0.0.1）か。手元でなければテーブルを作らない */
export function isLocalEndpoint(endpoint: string): boolean {
  try {
    const { hostname } = new URL(endpoint);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/** テーブルを作る。もうあれば作らない（何度動かしてもよい） */
export async function createLocalTable(
  client: DynamoDBClient,
  tableName: string,
): Promise<"created" | "exists"> {
  try {
    await client.send(new DescribeTableCommand({ TableName: tableName }));
    return "exists";
  } catch (error) {
    if (!(error instanceof ResourceNotFoundException)) throw error;
  }
  await client.send(new CreateTableCommand(tableDefinition(tableName)));
  return "created";
}

/** 環境変数 DYNAMODB_ENDPOINT・DYNAMODB_TABLE_NAME（pnpm dev:api と同じ）を読み、省略なら既定の値を使う */
async function main(env: NodeJS.ProcessEnv): Promise<void> {
  const endpoint = env["DYNAMODB_ENDPOINT"] || DEFAULT_LOCAL_ENDPOINT;
  const tableName = env["DYNAMODB_TABLE_NAME"] || DEFAULT_LOCAL_TABLE_NAME;
  if (!isLocalEndpoint(endpoint)) {
    console.error(`接続先 ${endpoint} は手元の DynamoDB ではないので、テーブルを作らない`);
    process.exit(1);
  }
  const client = createDynamoClient({ endpoint, region: "ap-northeast-1" });
  const result = await createLocalTable(client, tableName);
  console.log(
    result === "created"
      ? `テーブル ${tableName} を作った（${endpoint}）`
      : `テーブル ${tableName} はもうある（${endpoint}）`,
  );
}

if (import.meta.main) {
  await main(process.env);
}
