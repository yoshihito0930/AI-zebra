// 本番（Lambda + API Gateway HTTP API）で API を動かす入口
import { handle } from "hono/aws-lambda";
import { app } from "./app.ts";

export const handler = handle(app);
