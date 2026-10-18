import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// API を Node でそのまま起動できることの確認（pnpm dev:api と同じ動かし方）。
// Vitest は拡張子のない相対 import も解決するので、ほかのテストでは見つからない
// 「Node では import が見つからずに起動しない」を、ここで見つける（2026-10-19、harness-log）
const serverPath = path.resolve(import.meta.dirname, "server.ts");
let child: ChildProcess | undefined;

afterEach(() => {
  child?.kill();
  child = undefined;
});

function startServer(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes(`localhost:${port}`)) resolve();
    });
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("exit", (code) =>
      reject(new Error(`API が起動せずに終わった（code ${code}）\n${stderr}`)),
    );
  });
}

describe("API の起動", () => {
  it("Node で server.ts を起動でき、GET /health に答える", async () => {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    await startServer(port);
    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  }, 20_000);
});
