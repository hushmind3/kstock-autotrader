import { mkdir } from "node:fs/promises";
import path from "node:path";
import { openTradingRepository } from "@kstock/database";
import { createApiServer } from "./api/server.js";
import { TradingEngine } from "./core/trading-engine.js";
import { ensureAdminToken } from "./security/admin-token.js";
import { resolveDataDirectory } from "./utils/project-root.js";

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  const dataDirectory = await resolveDataDirectory();
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const databasePath = process.env.KSTOCK_DB_PATH
    ? path.resolve(process.env.KSTOCK_DB_PATH)
    : path.join(dataDirectory, "kstock.sqlite3");
  const repository = openTradingRepository(databasePath);
  const adminToken = await ensureAdminToken(dataDirectory);
  const engine = new TradingEngine({
    repository,
    dataDirectory,
    externalStrategyDirectory: process.env.KSTOCK_STRATEGY_DIR,
  });
  const api = await createApiServer(engine, adminToken);
  try {
    await engine.start();

    const host = process.env.ENGINE_HOST ?? "127.0.0.1";
    const port = positiveInteger(process.env.ENGINE_PORT, 3210);
    await api.listen({ host, port });
  } catch (error) {
    // A bind/configuration failure must not leave the durable engine lease behind.
    // Container supervisors can then restart this same process immediately.
    await api.close().catch(() => undefined);
    await engine.stop().catch(() => undefined);
    repository.close();
    throw error;
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    api.log.info({ signal }, "Shutting down trading engine");
    await api.close().catch(() => undefined);
    await engine.stop().catch(() => undefined);
    repository.close();
  };
  process.once("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));
  process.on("uncaughtException", (error) => {
    api.log.fatal({ err: error }, "Uncaught exception; fail-closing engine");
    void engine.control("halt-all").finally(() => shutdown("uncaughtException").then(() => process.exit(1)));
  });
  process.on("unhandledRejection", (error) => {
    api.log.fatal({ err: error }, "Unhandled rejection; fail-closing engine");
    void engine.control("halt-all").finally(() => shutdown("unhandledRejection").then(() => process.exit(1)));
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
