import {
  CreateTableCommand,
  DeleteTableCommand,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalDynamoClient } from "./client.ts";

// 統合テストの土台が動くことの確認。予約のテーブル設計（キー設計）とは関係ない
const client = createLocalDynamoClient();
const table = `int-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  await client.send(
    new CreateTableCommand({
      TableName: table,
      AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      BillingMode: "PAY_PER_REQUEST",
    }),
  );
});

afterAll(async () => {
  await client.send(new DeleteTableCommand({ TableName: table }));
});

describe("統合テストの土台（DynamoDB Local）", () => {
  it("書き込んだアイテムを読み出せる", async () => {
    await client.send(new PutItemCommand({ TableName: table, Item: { pk: { S: "a" } } }));
    const res = await client.send(
      new GetItemCommand({ TableName: table, Key: { pk: { S: "a" } } }),
    );
    expect(res.Item).toEqual({ pk: { S: "a" } });
  });

  it("TransactWriteItems は、条件が1つでも満たされなければ何も書き込まない", async () => {
    await client.send(new PutItemCommand({ TableName: table, Item: { pk: { S: "taken" } } }));
    const put = (pk: string) => ({
      Put: {
        TableName: table,
        Item: { pk: { S: pk } },
        ConditionExpression: "attribute_not_exists(pk)",
      },
    });

    await expect(
      client.send(new TransactWriteItemsCommand({ TransactItems: [put("new"), put("taken")] })),
    ).rejects.toBeInstanceOf(TransactionCanceledException);

    const res = await client.send(
      new GetItemCommand({ TableName: table, Key: { pk: { S: "new" } } }),
    );
    expect(res.Item).toBeUndefined();
  });
});
