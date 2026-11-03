import { DeleteTableCommand, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalDynamoClient } from "../src/db/client.ts";
import { createLocalTable, isLocalEndpoint } from "./local-table.ts";

const client = createLocalDynamoClient();
const created: string[] = [];

afterEach(async () => {
  for (const tableName of created.splice(0)) {
    await client.send(new DeleteTableCommand({ TableName: tableName }));
  }
});

function newTableName(): string {
  const tableName = `int-test-local-table-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  created.push(tableName);
  return tableName;
}

describe("手元のテーブルを作るスクリプト", () => {
  it("キー設計どおり（pk・sk、GSI の gsi1）のテーブルを作る", async () => {
    const tableName = newTableName();
    expect(await createLocalTable(client, tableName)).toBe("created");

    const { Table } = await client.send(new DescribeTableCommand({ TableName: tableName }));
    expect(Table?.KeySchema).toEqual([
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ]);
    expect(
      Table?.GlobalSecondaryIndexes?.map((index) => [index.IndexName, index.KeySchema]),
    ).toEqual([
      [
        "gsi1",
        [
          { AttributeName: "gsi1pk", KeyType: "HASH" },
          { AttributeName: "gsi1sk", KeyType: "RANGE" },
        ],
      ],
    ]);
  });

  it("もうあれば作らない（何度動かしてもよい）", async () => {
    const tableName = newTableName();
    await createLocalTable(client, tableName);
    expect(await createLocalTable(client, tableName)).toBe("exists");
  });

  it.each([
    ["http://localhost:8000", true],
    ["http://127.0.0.1:8000", true],
    ["https://dynamodb.ap-northeast-1.amazonaws.com", false],
    ["not a url", false],
  ])("接続先 %s が手元か：%s（手元でなければテーブルを作らない）", (endpoint, local) => {
    expect(isLocalEndpoint(endpoint)).toBe(local);
  });
});
