// DynamoDB のクライアントを作る。ローカル（DynamoDB Local）と本番で同じコードを使い、接続先だけを変える
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";

export type DynamoConfig = {
  /** ローカルの DynamoDB の URL。省略すると本番（AWS）の DynamoDB に接続する */
  endpoint?: string;
  region: string;
};

export function createDynamoClient(config: DynamoConfig): DynamoDBClient {
  if (config.endpoint === undefined) return new DynamoDBClient({ region: config.region });
  return new DynamoDBClient({
    endpoint: config.endpoint,
    region: config.region,
    // ローカルの DynamoDB は認証情報を確かめないので、ダミーの値を使う（本物の秘密情報ではない）
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
  });
}

/** 統合テスト用：環境変数 DYNAMODB_ENDPOINT（既定は手元の DynamoDB Local）に接続する */
export function createLocalDynamoClient(): DynamoDBClient {
  return createDynamoClient({
    endpoint: process.env["DYNAMODB_ENDPOINT"] ?? "http://127.0.0.1:8000",
    region: "ap-northeast-1",
  });
}
