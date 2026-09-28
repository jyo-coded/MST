import fs from "node:fs";
import path from "node:path";
import cors from "cors";
import express from "express";
import { api } from "./api";
import { ledger, ledgerReady } from "./chain/ledger";
import { config, ROOT_DIR } from "./config";
import { initDb } from "./db";
import { bindLedger, seed } from "./db/seed";
import { startHeartbeatMonitor } from "./iot/ingest";
import { initSimulation, simSettings } from "./sim/engine";
import { reconcile } from "./workflow/service";

async function main() {
  const db = await initDb();
  await seed();

  let chainLine = "not deployed. Run `npm run deploy && npm run setup`";
  if (ledgerReady()) {
    try {
      await bindLedger();
      const L = ledger();
      const block = await L.reader.provider.getBlockNumber();
      chainLine = `${L.address} · block ${block}`;
    } catch (err) {
      chainLine = `${ledger().address} · UNREACHABLE (${(err as Error).message.slice(0, 80)})`;
    }
  }

  await initSimulation();
  startHeartbeatMonitor();
  setInterval(() => reconcile().catch(() => undefined), 20_000);

  const app = express();
  app.disable("x-powered-by");
  app.use(cors());
  // Keep the raw body: device packets are authenticated by HMAC over the exact bytes.
  app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => ((req as any).rawBody = buf) }));
  app.use("/api", api);

  const dist = path.join(ROOT_DIR, "web", "dist");
  if (fs.existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: "1h" }));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
  } else {
    app.get("/", (_req, res) => res.type("text").send("Web app not built. Run `npm run build`, or `npm run dev:web` for the Vite dev server."));
  }

  app.listen(config.port, "0.0.0.0", () => {
    console.log(`
  ${config.productName}
  ──────────────────────────────────────────────────────────
  network     ${config.networkLabel} (chain ${config.chainId}) ${config.rpcUrl}
  ledger      ${chainLine}
  database    ${db.kind === "pglite" ? `PGlite (embedded PostgreSQL) at ${path.relative(ROOT_DIR, config.db.dir)}` : "PostgreSQL"}
  AI          ${config.ai.provider}${config.ai.provider === "qwen" ? ` (${config.ai.qwenModel} @ ${config.ai.qwenBaseUrl})` : ""}
  mode        ${simSettings().mode.toUpperCase()}
  app         http://localhost:${config.port}
`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
