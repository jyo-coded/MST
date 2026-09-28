import path from "node:path";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { ethers } from "ethers";
import { handleAgentMessage } from "./agent";
import { chain } from "./chain";
import { BACKEND_DIR, config, explorerAddress } from "./config";
import { deviceTokenOk } from "./devices";
import { TYPES, typeHash, rfidTagHash } from "./eip712";
import { emit, recentEvents, subscribe } from "./events";
import { readReport } from "./reports";
import { runScenario, SCENARIOS } from "./sim";
import { activeJobForBin, activeJobForCollector, persist, state } from "./store";
import {
  accept,
  emergencyStop,
  expireOverdue,
  hire,
  resume,
  review,
  rfidTap,
  submitClaim,
  submitEvidence,
  verifyJob,
  WorkflowError,
} from "./workflow";

const app = express();
app.use(cors());
app.use(express.json({ limit: "512kb" }));
app.use(express.static(path.join(BACKEND_DIR, "public")));

const json = (res: Response, body: unknown, status = 200) =>
  res
    .status(status)
    .type("application/json")
    .send(JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res)
    .then((body) => {
      if (!res.headersSent) json(res, body ?? { ok: true });
    })
    .catch(next);

const id = (v: string) => {
  if (!/^\d+$/.test(v)) throw new WorkflowError(`"${v}" is not a numeric id`);
  return BigInt(v);
};

// ======================================================================
// Device API: what the ESP32s call. Header: X-Device-Token: <DEVICE_TOKEN>
// ======================================================================

const device = express.Router();
device.use((req, res, next) => {
  if (!deviceTokenOk(req.header("x-device-token"))) return json(res, { error: "bad or missing X-Device-Token" }, 401);
  next();
});

/** Everything firmware needs to build EIP-712 digests itself. */
device.get(
  "/config",
  h(async () => {
    const c = chain();
    return {
      chainId: config.chainId,
      contract: c.deployment.address,
      domainSeparator: ethers.TypedDataEncoder.hashDomain(c.domain),
      typeHashes: Object.fromEntries(Object.keys(TYPES).map((t) => [t, typeHash(t as keyof typeof TYPES)])),
      binId: config.registry.binId,
      collectorId: config.registry.collectorId,
      deviceSigning: config.server.deviceSigning,
      serverTime: Math.floor(Date.now() / 1000),
    };
  }),
);

device.get("/time", (_req, res) => json(res, { now: Math.floor(Date.now() / 1000) }));

device.post(
  "/bins/:binId/telemetry",
  h(async (req) => {
    const binId = String(id(req.params.binId));
    const { fill, lid = 0, veh = 0, snd = 0 } = req.body ?? {};
    state.bins[binId] = { binId, fill: Number(fill), lid: Number(lid), veh: Number(veh), snd: Number(snd), at: Date.now() };
    persist();
    emit("telemetry:bin", "info", `bin ${binId}: ${fill}% lid=${lid} vehicle=${veh} sound=${snd}`, state.bins[binId]);
    return { ok: true };
  }),
);

device.post("/bins/:binId/hire", h(async (req) => hire(id(req.params.binId), req.body ?? {})));

device.get(
  "/bins/:binId/job",
  h(async (req) => {
    const binId = String(id(req.params.binId));
    const job = activeJobForBin(binId);
    let expectedTagHash: string | null = null;
    if (job?.collectorId) expectedTagHash = (await chain().getCollector(BigInt(job.collectorId))).tagHash;
    return {
      job: job
        ? { jobId: job.jobId, status: job.status, collectorId: job.collectorId ?? null, deadline: job.deadline ?? null, expectedTagHash }
        : null,
      announcement: state.announcements[`bin:${binId}`] ?? null,
      serverTime: Math.floor(Date.now() / 1000),
    };
  }),
);

device.post(
  "/bins/:binId/rfid",
  h(async (req) => {
    const uid = String(req.body?.uid ?? "");
    if (!uid) throw new WorkflowError("uid is required");
    return rfidTap(id(req.params.binId), uid);
  }),
);

device.post("/bins/:binId/evidence", h(async (req) => submitEvidence(id(req.params.binId), req.body ?? {})));

device.post(
  "/collectors/:collectorId/telemetry",
  h(async (req) => {
    const collectorId = String(id(req.params.collectorId));
    const { hopper, hatch = 0 } = req.body ?? {};
    state.collectors[collectorId] = { collectorId, hopper: Number(hopper), hatch: Number(hatch), at: Date.now() };
    persist();
    emit("telemetry:collector", "info", `collector ${collectorId}: hopper ${hopper}% hatch=${hatch}`, state.collectors[collectorId]);
    return { ok: true };
  }),
);

device.get(
  "/collectors/:collectorId/assignment",
  h(async (req) => {
    const collectorId = String(id(req.params.collectorId));
    const active = activeJobForCollector(collectorId);
    const offer = Object.values(state.jobs)
      .filter((j) => j.status === "Open")
      .sort((a, b) => Number(a.jobId) - Number(b.jobId))[0];
    return {
      active: active ? { jobId: active.jobId, binId: active.binId, status: active.status, deadline: active.deadline ?? null } : null,
      offer: !active && offer ? { jobId: offer.jobId, binId: offer.binId, fillAtHire: offer.fillAtHire } : null,
      announcement: state.announcements[`collector:${collectorId}`] ?? null,
      serverTime: Math.floor(Date.now() / 1000),
    };
  }),
);

device.post(
  "/collectors/:collectorId/accept",
  h(async (req) => accept(id(req.params.collectorId), id(String(req.body?.jobId ?? "")), req.body ?? {})),
);

device.post("/collectors/:collectorId/claim", h(async (req) => submitClaim(id(req.params.collectorId), req.body ?? {})));

app.use("/api/device", device);

// ======================================================================
// Operator / dashboard API
// ======================================================================

app.get("/api/health", (_req, res) => json(res, { ok: true, network: config.network }));

app.get(
  "/api/status",
  h(async () => {
    const c = chain();
    const r = config.registry;
    const [s, ward, bin, collector, rogue] = await Promise.all([
      c.status(),
      c.getWard(r.wardId),
      c.getBin(r.binId),
      c.getCollector(r.collectorId),
      c.getCollector(r.rogueCollectorId),
    ]);
    const payoutBalance = collector.payout !== ethers.ZeroAddress ? await c.balanceOf(collector.payout) : 0n;
    const scorecard = (cid: bigint, name: string, x: typeof collector) => ({
      id: cid,
      name,
      payout: x.payout,
      completedJobs: x.completedJobs,
      rejectedJobs: x.rejectedJobs,
      totalEarned: ethers.formatEther(x.totalEarned),
      telemetry: state.collectors[String(cid)] ?? null,
    });
    return {
      network: config.network,
      chainId: config.chainId,
      explorerUrl: config.explorerUrl,
      contract: { address: c.deployment.address, url: explorerAddress(c.deployment.address), paused: s.paused },
      blockNumber: s.blockNumber,
      relayer: { address: c.relayer.address, balance: ethers.formatEther(s.relayerBalance) },
      guardian: c.guardian?.address ?? null,
      deviceSigning: config.server.deviceSigning,
      verifier: {
        mode: config.verifier.mode,
        model: config.verifier.mode === "openai" ? config.verifier.qwenModel : config.verifier.mode === "http" ? config.verifier.httpUrl : "civicproof-heuristic-v1",
      },
      ward: {
        id: r.wardId,
        balance: ethers.formatEther(ward.balance),
        reserved: ethers.formatEther(ward.reserved),
        spentToday: ethers.formatEther(ward.spentToday),
        dailyCap: ethers.formatEther(ward.policy.dailyCap),
        maxPayoutPerJob: ethers.formatEther(ward.policy.maxPayoutPerJob),
        basePayout: ethers.formatEther(ward.policy.basePayout),
        ratePerPoint: ethers.formatEther(ward.policy.ratePerPoint),
        minFillToHire: ward.policy.minFillToHire,
        minFillDelta: ward.policy.minFillDelta,
        minConfidence: ward.policy.minConfidence,
      },
      bin: {
        id: r.binId,
        device: bin.device,
        activeJobId: bin.activeJobId,
        telemetry: state.bins[String(r.binId)] ?? null,
        announcement: state.announcements[`bin:${r.binId}`] ?? null,
      },
      collector: {
        id: r.collectorId,
        device: collector.device,
        payout: collector.payout,
        payoutUrl: explorerAddress(collector.payout),
        payoutBalance: ethers.formatEther(payoutBalance),
        rfidTagHash: collector.tagHash,
        completedJobs: collector.completedJobs,
        rejectedJobs: collector.rejectedJobs,
        totalEarned: ethers.formatEther(collector.totalEarned),
        telemetry: state.collectors[String(r.collectorId)] ?? null,
      },
      contractors: [
        scorecard(r.collectorId, "GreenCity Services (honest)", collector),
        ...(rogue.device !== ethers.ZeroAddress ? [scorecard(r.rogueCollectorId, "QuickCash Hauling (rogue)", rogue)] : []),
      ],
      supervisorCard: !!config.registry.supervisorRfidUid,
    };
  }),
);

app.get(
  "/api/jobs",
  h(async () =>
    Object.values(state.jobs)
      .sort((a, b) => Number(b.jobId) - Number(a.jobId))
      .map(({ binCsv: _b, collectorCsv: _c, settlement: _s, ...rest }) => rest),
  ),
);

app.get(
  "/api/jobs/:id",
  h(async (req) => {
    const job = state.jobs[req.params.id];
    if (!job) throw new WorkflowError("unknown job", 404);
    const onchain = await chain().getJob(BigInt(job.jobId));
    return { ...job, onchain, report: job.reportHash ? readReport(job.reportHash) : null };
  }),
);

app.post("/api/jobs/:id/verify", h(async (req) => verifyJob(req.params.id)));
app.post(
  "/api/jobs/:id/review",
  h(async (req) => review(req.params.id, !!req.body?.approve, String(req.body?.reviewer ?? ""), String(req.body?.note ?? ""))),
);
app.post("/api/jobs/expire-overdue", h(async () => expireOverdue()));

app.get(
  "/api/reports/:hash",
  h(async (req) => {
    const r = readReport(req.params.hash);
    if (!r) throw new WorkflowError("report not found", 404);
    return r;
  }),
);

app.get("/api/incidents", h(async () => state.incidents.slice().reverse()));
app.get("/api/events/history", h(async () => recentEvents()));
app.get("/api/events", (_req, res) => subscribe(res));

app.post(
  "/api/agent",
  h(async (req) => {
    const text = String(req.body?.text ?? "").slice(0, 2000);
    if (!text.trim()) throw new WorkflowError("text is required");
    return handleAgentMessage(text);
  }),
);

app.post("/api/admin/pause", h(async () => emergencyStop("dashboard")));
app.post("/api/admin/unpause", h(async () => resume("dashboard")));

app.get(
  "/api/scenarios",
  h(async () => Object.values(SCENARIOS).map(({ name, title, story, expect }) => ({ name, title, story, expect }))),
);
app.post(
  "/api/sim/:name",
  h(async (req) => runScenario(req.params.name, { paceMs: req.body?.paceMs !== undefined ? Number(req.body.paceMs) : undefined })),
);

/** Manual RFID from the dashboard (handy when the reader is flaky on stage). */
app.post(
  "/api/rfid",
  h(async (req) => rfidTap(config.registry.binId, String(req.body?.uid ?? config.registry.collectorRfidUid))),
);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof WorkflowError ? err.status : 500;
  const message = (err as Error)?.message ?? String(err);
  if (status >= 500) console.error(err);
  json(res, { error: message }, status);
});

// ======================================================================

async function main() {
  const c = chain();
  console.log(`
  CivicProof gateway
  ──────────────────────────────────────────────
  network        ${config.network} (chainId ${config.chainId})
  rpc            ${config.rpcUrl}
  contract       ${c.deployment.address}
  relayer        ${c.relayer.address}
  guardian       ${c.guardian?.address ?? "NOT SET (settlements disabled)"}
  device signing ${config.server.deviceSigning}
  verifier       ${config.verifier.mode}${config.verifier.mode === "openai" ? ` (${config.verifier.qwenModel} @ ${config.verifier.qwenBaseUrl})` : ""}
  collector tag  ${config.registry.collectorRfidUid} → ${rfidTagHash(config.registry.collectorRfidUid)}
  dashboard      http://localhost:${config.server.port}
  `);
  try {
    const s = await c.status();
    console.log(`  chain OK: block ${s.blockNumber}, relayer balance ${ethers.formatEther(s.relayerBalance)}, paused=${s.paused}\n`);
  } catch (err) {
    console.error(`  ! chain not reachable yet: ${(err as Error).message}\n`);
  }
  app.listen(config.server.port, "0.0.0.0");
  setInterval(() => expireOverdue().catch(() => undefined), 30_000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
