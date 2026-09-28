import express, { type NextFunction, type Request, type Response } from "express";
import { ethers } from "ethers";
import { CHAIN_STATUS, haversineKm, LIFECYCLE } from "@astra/shared";
import { aiHealth } from "./ai";
import { authenticate, issueToken, requireRole, verifyPassword, type SessionUser } from "./auth";
import { ChainError, LEDGER_ABI, ledger, readDeployment } from "./chain/ledger";
import { config, deviceSecret, explorerAddress, loadCity, normalizeUid } from "./config";
import { dbKind, one, q } from "./db";
import { DeviceAuthError, ingest, verifyDeviceSignature, type TelemetryPacket } from "./iot/ingest";
import {
  iso,
  LIFECYCLE_SELECT,
  mst,
  PAYMENT_SELECT,
  presentAssignment,
  presentBin,
  presentLifecycle,
  presentNotification,
  presentPayment,
  presentRequest,
  presentRfid,
  presentTx,
  presentVerification,
  presentWorker,
  REQUEST_SELECT,
  TX_SELECT,
} from "./present";
import { clientCount, json, stream } from "./realtime";
import {
  autopilotState,
  directCollect,
  directTap,
  queueCard,
  runAutopilot,
  setBinOffline,
  setSimSettings,
  simSettings,
  simSnapshot,
  simulateFullBin,
  simulateObstruction,
  workerArriveNow,
} from "./sim/engine";
import { rankWorkers } from "./workflow/assignment";
import {
  abortWalletPayment,
  activeAssignmentForWorker,
  approveCompletion,
  approveRequest,
  assignWorker,
  beginWalletPayment,
  cancelAssignment,
  handleRfidTap,
  markEnRoute,
  observeWalletTx,
  openInvestigation,
  rejectCompletion,
  rejectRequest,
  releasePayment,
  updateWorkerLocation,
  WorkflowError,
  type Actor,
} from "./workflow/service";
import { TransitionError } from "./workflow/state";

export const api = express.Router();
api.use(authenticate);

type Handler = (req: Request, res: Response) => Promise<unknown>;
const h = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res)
    .then((body) => {
      if (!res.headersSent) res.type("application/json").send(json(body ?? { ok: true }));
    })
    .catch(next);

const officer = requireRole("officer", "admin");
const anyone = requireRole();
const actorOf = (u?: SessionUser): Actor => ({ kind: u?.role === "admin" ? "admin" : "officer", id: u?.id, name: u?.name });
const num = (v: string) => {
  const n = Number(String(v).replace(/\D/g, ""));
  if (!Number.isFinite(n) || n <= 0) throw new WorkflowError(`"${v}" is not a valid id`);
  return n;
};

// ===========================================================================
// Auth
// ===========================================================================

api.post(
  "/auth/login",
  h(async (req) => {
    const { email, password, workerId, pin } = req.body ?? {};
    if (workerId) {
      const u = await one(`SELECT * FROM users WHERE worker_id = $1`, [String(workerId).toUpperCase()]);
      if (!u || !verifyPassword(String(pin ?? ""), u.password_hash)) throw new WorkflowError("Worker ID or PIN is incorrect", 401);
      const user: SessionUser = { id: u.id, name: u.name, role: "worker", workerId: u.worker_id };
      return { token: issueToken(user), user };
    }
    const u = await one(`SELECT * FROM users WHERE lower(email) = lower($1) AND role IN ('officer','admin')`, [String(email ?? "")]);
    if (!u || !verifyPassword(String(password ?? ""), u.password_hash)) throw new WorkflowError("Email or password is incorrect", 401);
    const user: SessionUser = { id: u.id, name: u.name, role: u.role };
    return { token: issueToken(user), user };
  }),
);

api.get("/auth/me", anyone, h(async (req) => ({ user: req.user })));

/** Names for the worker sign-in picker. The PIN is still required. */
api.get("/auth/workers", h(async () => q(`SELECT id, name FROM workers ORDER BY id`)));

// ===========================================================================
// System
// ===========================================================================

api.get(
  "/system/config",
  h(async () => {
    const city = loadCity();
    const d = readDeployment();
    let policy = null;
    if (d) {
      try {
        const p = await ledger().contract.policy();
        policy = {
          minFillPct: Number(p.minFillPct),
          minFillRemoved: Number(p.minFillRemoved),
          minConfidence: Number(p.minConfidenceBps) / 100,
          maxPayoutMstc: ethers.formatEther(p.maxPayout),
        };
      } catch {
        /* chain offline */
      }
    }
    const L = d ? ledger() : null;
    return {
      productName: config.productName,
      network: config.network,
      networkLabel: config.networkLabel,
      isLocal: config.isLocal,
      chainId: config.chainId,
      chainIdHex: `0x${config.chainId.toString(16)}`,
      rpcUrl: config.rpcUrl,
      explorerUrl: config.explorerUrl || null,
      contract: d ? { address: d.address, url: explorerAddress(d.address), deployTx: d.deployTx || null, deployedAt: d.deployedAt || null } : null,
      municipality: city.municipality,
      simulation: simSettings(),
      payment: { defaultMstc: config.payment.defaultMstc, inrPerMstc: config.payment.inrPerMstc },
      ai: { provider: config.ai.provider, model: config.ai.provider === "qwen" ? config.ai.qwenModel : config.ai.provider === "http" ? config.ai.httpUrl : "astra-sensor-fusion-v1", minConfidence: config.ai.minConfidence },
      policy,
      wallets: L
        ? { officer: L.signerAddress("officer"), gateway: L.signerAddress("gateway"), admin: L.signerAddress("admin"), verifier: L.verifier?.address ?? null }
        : null,
      lifecycle: LIFECYCLE,
      allowRoleGrants: config.auth.allowRoleGrants,
      database: dbKind(),
    };
  }),
);

api.get(
  "/system/health",
  h(async () => {
    const items: { key: string; label: string; status: "online" | "degraded" | "offline"; detail: string }[] = [];
    const hw = await q(`SELECT id, online, last_heartbeat FROM bins WHERE hardware = true`);
    const online = await one(`SELECT count(*)::int AS n, sum(CASE WHEN online THEN 1 ELSE 0 END)::int AS up FROM bins`);
    const mode = simSettings().mode;
    const liveHw = hw.filter((b: any) => b.online && Date.now() - new Date(b.last_heartbeat).getTime() < 30_000 && mode === "live");
    items.push({
      key: "iot",
      label: "IoT gateway",
      status: online.up > 0 ? "online" : "offline",
      detail:
        mode === "live"
          ? `${liveHw.length}/${hw.length} hardware bin${hw.length === 1 ? "" : "s"} reporting · ${online.up}/${online.n} bins online`
          : `${online.up}/${online.n} bins online (simulation)`,
    });
    const ai = await aiHealth();
    items.push({ key: "ai", label: "AI verification", status: ai.online ? "online" : "degraded", detail: ai.detail });
    try {
      const L = ledger();
      const block = await L.reader.provider.getBlockNumber();
      items.push({ key: "chain", label: config.networkLabel, status: "online", detail: `block ${block} · chain ${config.chainId}` });
      const officerAddr = L.signerAddress("officer");
      const bal = officerAddr ? await L.balanceOf(officerAddr) : 0n;
      const gw = L.signerAddress("gateway");
      const gwBal = gw ? await L.balanceOf(gw) : 0n;
      const low = bal < ethers.parseEther("0.01") || gwBal < ethers.parseEther("0.01");
      items.push({
        key: "wallet",
        label: "Payment wallet",
        status: officerAddr ? (low ? "degraded" : "online") : "offline",
        detail: officerAddr ? `officer ${Number(ethers.formatEther(bal)).toFixed(3)} MSTC · gateway ${Number(ethers.formatEther(gwBal)).toFixed(3)} MSTC` : "no officer key",
      });
    } catch (err) {
      items.push({ key: "chain", label: config.networkLabel, status: "offline", detail: (err as Error).message.slice(0, 120) });
      items.push({ key: "wallet", label: "Payment wallet", status: "offline", detail: "chain unreachable" });
    }
    try {
      await one(`SELECT 1`);
      items.push({ key: "db", label: "Database", status: "online", detail: dbKind() === "pglite" ? "PostgreSQL (embedded PGlite)" : "PostgreSQL" });
    } catch {
      items.push({ key: "db", label: "Database", status: "offline", detail: "query failed" });
    }
    const ap = autopilotState();
    items.push({
      key: "sim",
      label: "Simulation",
      status: mode === "simulation" ? "online" : "degraded",
      detail: mode === "simulation" ? (ap?.running ? `autopilot: ${ap.stage}` : "running") : "LIVE HARDWARE mode",
    });
    return { items, mode, clients: clientCount(), updatedAt: new Date().toISOString() };
  }),
);

// ===========================================================================
// Overview
// ===========================================================================

api.get(
  "/overview",
  anyone,
  h(async () => {
    const m = await one(`
      SELECT
        (SELECT count(*)::int FROM bins) AS total_bins,
        (SELECT count(*)::int FROM bins WHERE online) AS active_bins,
        (SELECT count(*)::int FROM bins WHERE status IN ('FULL','VERIFYING','COLLECTION_REQUESTED')) AS full_bins,
        (SELECT count(*)::int FROM collection_requests WHERE status IN ('AWAITING_APPROVAL','APPROVED')) AS pending_requests,
        (SELECT count(*)::int FROM collection_requests WHERE status IN ('ASSIGNED','EN_ROUTE','COLLECTING','REVERIFYING')) AS active_collections,
        (SELECT count(*)::int FROM collection_requests WHERE status IN ('AWAITING_FINAL_APPROVAL','INVESTIGATION')) AS awaiting_verification,
        (SELECT count(*)::int FROM collection_requests WHERE status = 'COMPLETED' AND completed_at >= date_trunc('day', now())) AS completed_today,
        (SELECT count(*)::int FROM payments WHERE status IN ('READY','SIGNING','SUBMITTED','CONFIRMING','FAILED')) AS payments_pending,
        (SELECT COALESCE(sum(amount_wei), 0)::text FROM payments WHERE status = 'PAID') AS paid_total_wei
    `);
    const attention = (
      await q(
        `${REQUEST_SELECT} WHERE r.status IN ('AWAITING_APPROVAL','APPROVED','AWAITING_FINAL_APPROVAL','INVESTIGATION')
            OR (r.status = 'COMPLETED' AND p.status IN ('READY','FAILED')) OR (r.rfid_alert AND r.status IN ('ASSIGNED','EN_ROUTE','COLLECTING'))
         ORDER BY r.updated_at DESC LIMIT 12`,
      )
    ).map(presentRequest);
    const spotlightRow = await one(
      `${REQUEST_SELECT} WHERE r.status NOT IN ('REJECTED') ORDER BY (r.status = 'COMPLETED' AND p.status = 'PAID') ASC, r.updated_at DESC LIMIT 1`,
    );
    const spotlight = spotlightRow
      ? {
          request: presentRequest(spotlightRow),
          lifecycle: (await q(`${LIFECYCLE_SELECT} WHERE e.request_id = $1 ORDER BY e.ts ASC, e.id ASC`, [spotlightRow.id])).map(presentLifecycle),
        }
      : null;
    const recentTx = (await q(`${TX_SELECT} ORDER BY t.id DESC LIMIT 8`)).map(presentTx);
    const feed = (await q(`${LIFECYCLE_SELECT} ORDER BY e.id DESC LIMIT 30`)).map(presentLifecycle);
    return {
      metrics: {
        totalBins: m.total_bins,
        activeBins: m.active_bins,
        fullBins: m.full_bins,
        pendingRequests: m.pending_requests,
        activeCollections: m.active_collections,
        awaitingVerification: m.awaiting_verification,
        completedToday: m.completed_today,
        paymentsPending: m.payments_pending,
        paidTotalMstc: mst(m.paid_total_wei),
      },
      attention,
      spotlight,
      recentTx,
      feed,
    };
  }),
);

api.get(
  "/feed",
  anyone,
  h(async (req) => (await q(`${LIFECYCLE_SELECT} ORDER BY e.id DESC LIMIT $1`, [Math.min(200, Number(req.query.limit ?? 50))])).map(presentLifecycle)),
);

// ===========================================================================
// Bins
// ===========================================================================

async function activeRequestsByBin() {
  const rows = await q(
    `SELECT DISTINCT ON (r.bin_id) r.* FROM collection_requests r LEFT JOIN payments p ON p.request_id = r.id
      WHERE r.status <> 'REJECTED' AND NOT (r.status = 'COMPLETED' AND p.status = 'PAID')
      ORDER BY r.bin_id, r.id DESC`,
  );
  return new Map(rows.map((r: any) => [r.bin_id, r]));
}

api.get(
  "/bins",
  anyone,
  h(async () => {
    const reqs = await activeRequestsByBin();
    return (await q(`SELECT * FROM bins ORDER BY id`)).map((b: any) => presentBin(b, { request: reqs.get(b.id) }));
  }),
);

api.get(
  "/bins/:id",
  anyone,
  h(async (req) => {
    const b = await one(`SELECT * FROM bins WHERE id = $1`, [req.params.id]);
    if (!b) throw new WorkflowError("Unknown bin", 404);
    const reqs = await activeRequestsByBin();
    const minutes = Math.min(24 * 60, Number(req.query.minutes ?? 30));
    const telemetry = await q(
      `SELECT ts, fill_pct, fill2_pct, distance_cm, lid_state, servo_state, ir_count, source FROM telemetry
        WHERE bin_id = $1 AND ts >= now() - ($2 || ' minutes')::interval ORDER BY ts ASC`,
      [b.id, String(minutes)],
    );
    const step = Math.max(1, Math.ceil(telemetry.length / 240));
    return {
      bin: presentBin(b, { request: reqs.get(b.id) }),
      sensors: await q(`SELECT kind, model, status, last_value, updated_at FROM sensors WHERE bin_id = $1 ORDER BY id`, [b.id]),
      telemetry: telemetry
        .filter((_: unknown, i: number) => i % step === 0 || i === telemetry.length - 1)
        .map((t: any) => ({ ts: iso(t.ts), fill: t.fill_pct, fill2: t.fill2_pct, distance: t.distance_cm, lid: t.lid_state, servo: t.servo_state, ir: t.ir_count, source: t.source })),
      requests: (await q(`${REQUEST_SELECT} WHERE r.bin_id = $1 ORDER BY r.id DESC LIMIT 12`, [b.id])).map(presentRequest),
      transactions: (await q(`${TX_SELECT} WHERE t.bin_id = $1 ORDER BY t.id DESC LIMIT 20`, [b.id])).map(presentTx),
      rfidEvents: (await q(`SELECT e.*, w.name AS worker_name, t.hash AS tx_hash, t.status AS tx_status FROM rfid_events e LEFT JOIN workers w ON w.id = e.worker_id LEFT JOIN blockchain_transactions t ON t.id = e.tx_id WHERE e.bin_id = $1 ORDER BY e.id DESC LIMIT 10`, [b.id])).map(presentRfid),
      lifecycle: (await q(`${LIFECYCLE_SELECT} WHERE e.bin_id = $1 ORDER BY e.id DESC LIMIT 25`, [b.id])).map(presentLifecycle),
    };
  }),
);

// ===========================================================================
// Workers
// ===========================================================================

async function workerExtras(w: any) {
  const job = await activeAssignmentForWorker(w.id);
  const pending = await one(`SELECT count(*)::int AS n, COALESCE(sum(amount_wei),0)::text AS wei FROM payments WHERE worker_id = $1 AND status NOT IN ('PAID','CANCELLED')`, [w.id]);
  const paid = await one(`SELECT COALESCE(sum(amount_wei),0)::text AS wei FROM payments WHERE worker_id = $1 AND status = 'PAID'`, [w.id]);
  return {
    activeJob: job ? { requestId: job.request_id, code: `REQ-${String(job.request_id).padStart(5, "0")}`, binId: job.bin_id, status: job.status } : null,
    pendingPayments: pending.n,
    pendingMstc: mst(pending.wei),
    earnedMstc: mst(paid.wei),
  };
}

api.get("/workers", anyone, h(async () => Promise.all((await q(`SELECT * FROM workers ORDER BY id`)).map(async (w: any) => presentWorker(w, await workerExtras(w))))));

api.get(
  "/workers/:id",
  anyone,
  h(async (req) => {
    const w = await one(`SELECT * FROM workers WHERE id = $1`, [req.params.id.toUpperCase()]);
    if (!w) throw new WorkflowError("Unknown worker", 404);
    let balance: string | null = null;
    try {
      balance = ethers.formatEther(await ledger().balanceOf(w.wallet_address));
    } catch {
      /* offline */
    }
    return {
      worker: presentWorker(w, await workerExtras(w)),
      balanceMstc: balance,
      jobs: (await q(`${REQUEST_SELECT} WHERE r.assigned_worker_id = $1 ORDER BY r.id DESC LIMIT 20`, [w.id])).map(presentRequest),
      payments: (await q(`${PAYMENT_SELECT} WHERE p.worker_id = $1 ORDER BY p.id DESC LIMIT 20`, [w.id])).map(presentPayment),
      transactions: (await q(`${TX_SELECT} WHERE t.worker_id = $1 ORDER BY t.id DESC LIMIT 20`, [w.id])).map(presentTx),
      track: (await q(`SELECT lat, lng, ts FROM worker_locations WHERE worker_id = $1 ORDER BY id DESC LIMIT 60`, [w.id])).reverse().map((p: any) => [p.lat, p.lng]),
    };
  }),
);

// ===========================================================================
// Collection requests
// ===========================================================================

const GROUPS: Record<string, string[]> = {
  approval: ["AWAITING_APPROVAL", "APPROVED"],
  active: ["ASSIGNED", "EN_ROUTE", "COLLECTING", "REVERIFYING"],
  final: ["AWAITING_FINAL_APPROVAL", "INVESTIGATION"],
  completed: ["COMPLETED"],
  closed: ["REJECTED"],
  early: ["DETECTED", "AI_VERIFIED"],
};

api.get(
  "/requests",
  anyone,
  h(async (req) => {
    const group = String(req.query.group ?? "");
    const statuses = GROUPS[group];
    const rows = statuses
      ? await q(`${REQUEST_SELECT} WHERE r.status = ANY($1::text[]) ORDER BY r.id DESC LIMIT 200`, [statuses])
      : await q(`${REQUEST_SELECT} ORDER BY r.id DESC LIMIT 200`);
    return rows.map(presentRequest);
  }),
);

async function requestDetail(id: number) {
  const r = await one(`${REQUEST_SELECT} WHERE r.id = $1`, [id]);
  if (!r) throw new WorkflowError("Unknown request", 404);
  const bin = await one(`SELECT * FROM bins WHERE id = $1`, [r.bin_id]);
  const worker = r.assigned_worker_id ? await one(`SELECT * FROM workers WHERE id = $1`, [r.assigned_worker_id]) : null;
  const assignment = await one(
    `SELECT a.*, w.name AS worker_name, t.hash AS tx_hash, t.status AS tx_status FROM assignments a JOIN workers w ON w.id = a.worker_id
       LEFT JOIN blockchain_transactions t ON t.id = a.tx_id WHERE a.request_id = $1 ORDER BY a.id DESC LIMIT 1`,
    [id],
  );
  const from = new Date(new Date(r.detected_at).getTime() - 3 * 60_000).toISOString();
  const to = r.completed_at ?? new Date().toISOString();
  const telemetry = await q(
    `SELECT ts, fill_pct, fill2_pct, lid_state, servo_state, ir_count FROM telemetry WHERE bin_id = $1 AND ts BETWEEN $2 AND $3 ORDER BY ts ASC`,
    [r.bin_id, from, to],
  );
  const step = Math.max(1, Math.ceil(telemetry.length / 300));
  const payment = await one(`${PAYMENT_SELECT} WHERE p.request_id = $1`, [id]);
  let chainStatus = r.chain_status;
  try {
    chainStatus = await ledger().chainStatus(id);
  } catch {
    /* offline: keep mirror */
  }
  return {
    request: { ...presentRequest(r), chainStatus },
    bin: presentBin(bin, { request: r }),
    worker: worker ? presentWorker(worker) : null,
    distanceM: worker && bin ? Math.round(haversineKm({ lat: worker.lat, lng: worker.lng }, { lat: bin.lat, lng: bin.lng }) * 1000) : null,
    assignment: presentAssignment(assignment),
    lifecycle: (await q(`${LIFECYCLE_SELECT} WHERE e.request_id = $1 ORDER BY e.ts ASC, e.id ASC`, [id])).map(presentLifecycle),
    verifications: (await q(`SELECT * FROM ai_verifications WHERE request_id = $1 ORDER BY id ASC`, [id])).map(presentVerification),
    rfidEvents: (await q(`SELECT e.*, w.name AS worker_name, t.hash AS tx_hash, t.status AS tx_status FROM rfid_events e LEFT JOIN workers w ON w.id = e.worker_id LEFT JOIN blockchain_transactions t ON t.id = e.tx_id WHERE e.request_id = $1 ORDER BY e.id ASC`, [id])).map(presentRfid),
    collectionEvents: (await q(`SELECT * FROM collection_events WHERE request_id = $1 ORDER BY ts ASC`, [id])).map((c: any) => ({ type: c.type, data: c.data, ts: iso(c.ts) })),
    telemetry: telemetry
      .filter((_: unknown, i: number) => i % step === 0 || i === telemetry.length - 1)
      .map((t: any) => ({ ts: iso(t.ts), fill: t.fill_pct, fill2: t.fill2_pct, lid: t.lid_state, servo: t.servo_state, ir: t.ir_count })),
    payment: payment ? presentPayment(payment) : null,
    transactions: (await q(`${TX_SELECT} WHERE t.request_id = $1 ORDER BY t.id ASC`, [id])).map(presentTx),
  };
}

api.get("/requests/:id", anyone, h(async (req) => requestDetail(num(req.params.id))));
api.get("/requests/:id/candidates", anyone, h(async (req) => rankWorkers((await one(`SELECT bin_id FROM collection_requests WHERE id = $1`, [num(req.params.id)]))?.bin_id ?? "")));

const act = (fn: (id: number, req: Request) => Promise<unknown>) =>
  h(async (req) => {
    const id = num(req.params.id);
    await fn(id, req);
    return requestDetail(id);
  });

api.post("/requests/:id/approve", officer, act((id, req) => approveRequest(id, actorOf(req.user))));
api.post("/requests/:id/reject", officer, act((id, req) => rejectRequest(id, actorOf(req.user), String(req.body?.reason ?? ""))));
api.post("/requests/:id/assign", officer, act((id, req) => assignWorker(id, String(req.body?.workerId ?? ""), actorOf(req.user), req.body?.amountMstc)));
api.post("/requests/:id/cancel-assignment", officer, act((id, req) => cancelAssignment(id, actorOf(req.user), String(req.body?.reason ?? ""))));
api.post("/requests/:id/investigate", officer, act((id, req) => openInvestigation(id, actorOf(req.user), String(req.body?.reason ?? ""))));
api.post("/requests/:id/approve-completion", officer, act((id, req) => approveCompletion(id, actorOf(req.user), String(req.body?.note ?? ""))));
api.post("/requests/:id/reject-completion", officer, act((id, req) => rejectCompletion(id, actorOf(req.user), String(req.body?.reason ?? ""))));
api.post("/requests/:id/release-payment", officer, act((id, req) => releasePayment(id, actorOf(req.user))));
api.post("/requests/:id/payment/begin-wallet", officer, act((id) => beginWalletPayment(id)));
api.post("/requests/:id/payment/abort-wallet", officer, act((id, req) => abortWalletPayment(id, String(req.body?.reason ?? ""))));

// ===========================================================================
// AI verification
// ===========================================================================

api.get(
  "/verifications",
  anyone,
  h(async (req) => {
    const kind = req.query.kind ? String(req.query.kind) : null;
    const rows = kind
      ? await q(`SELECT * FROM ai_verifications WHERE kind = $1 ORDER BY id DESC LIMIT 100`, [kind])
      : await q(`SELECT * FROM ai_verifications ORDER BY id DESC LIMIT 100`);
    return rows.map(presentVerification);
  }),
);

api.get(
  "/verifications/:id",
  anyone,
  h(async (req) => {
    const v = await one(`SELECT * FROM ai_verifications WHERE id = $1`, [num(req.params.id)]);
    if (!v) throw new WorkflowError("Unknown verification", 404);
    const r = v.request_id ? await one(`${REQUEST_SELECT} WHERE r.id = $1`, [v.request_id]) : null;
    return { verification: presentVerification(v), request: r ? presentRequest(r) : null };
  }),
);

// ===========================================================================
// Payments
// ===========================================================================

api.get(
  "/payments",
  anyone,
  h(async () => {
    const items = (await q(`${PAYMENT_SELECT} ORDER BY p.updated_at DESC LIMIT 200`)).map(presentPayment);
    const s = await one(`
      SELECT
        COALESCE(sum(amount_wei) FILTER (WHERE status IN ('PENDING')), 0)::text AS escrow_wei,
        COALESCE(sum(amount_wei) FILTER (WHERE status IN ('READY','SIGNING','SUBMITTED','CONFIRMING','FAILED')), 0)::text AS ready_wei,
        count(*) FILTER (WHERE status IN ('READY','FAILED'))::int AS ready_count,
        COALESCE(sum(amount_wei) FILTER (WHERE status = 'PAID' AND paid_at >= date_trunc('day', now())), 0)::text AS paid_today_wei,
        COALESCE(sum(amount_wei) FILTER (WHERE status = 'PAID'), 0)::text AS paid_wei
      FROM payments`);
    let fund = null;
    try {
      const f = await ledger().fundStatus();
      fund = { balanceMstc: ethers.formatEther(f.balance), reservedMstc: ethers.formatEther(f.reserved), freeMstc: ethers.formatEther(f.free), totalPaidMstc: ethers.formatEther(f.totalPaid) };
    } catch {
      /* offline */
    }
    return {
      summary: {
        escrowMstc: mst(s.escrow_wei),
        readyMstc: mst(s.ready_wei),
        readyCount: s.ready_count,
        paidTodayMstc: mst(s.paid_today_wei),
        paidTotalMstc: mst(s.paid_wei),
        inrPerMstc: config.payment.inrPerMstc,
      },
      fund,
      items,
    };
  }),
);

// ===========================================================================
// Blockchain
// ===========================================================================

api.get("/chain/abi", h(async () => ({ address: ledger().address, abi: LEDGER_ABI, chainId: config.chainId })));

api.get(
  "/chain/status",
  anyone,
  h(async () => {
    const L = ledger();
    const [block, fund, paused, latest] = await Promise.all([
      L.reader.provider.getBlockNumber(),
      L.fundStatus(),
      L.contract.paused() as Promise<boolean>,
      L.contract.latestRequestId() as Promise<bigint>,
    ]);
    const wallets = await Promise.all(
      (
        [
          ["Municipal officer", L.signerAddress("officer"), "Approves, assigns, releases payment"],
          ["IoT gateway", L.signerAddress("gateway"), "Relays bin-signed evidence"],
          ["Admin", L.signerAddress("admin"), "Deploys, registers, funds"],
          ["AI verifier", L.verifier?.address ?? null, "Signs AI verdicts (no funds needed)"],
        ] as [string, string | null, string][]
      ).map(async ([role, address, purpose]) => ({
        role,
        purpose,
        address,
        url: address ? explorerAddress(address) : null,
        balanceMstc: address ? ethers.formatEther(await L.balanceOf(address)) : null,
      })),
    );
    const counts = await one(`SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'CONFIRMED')::int AS confirmed FROM blockchain_transactions`);
    return {
      network: config.networkLabel,
      chainId: config.chainId,
      blockNumber: block,
      contract: { address: L.address, url: explorerAddress(L.address) },
      paused,
      latestRequestId: Number(latest),
      fund: {
        balanceMstc: ethers.formatEther(fund.balance),
        reservedMstc: ethers.formatEther(fund.reserved),
        freeMstc: ethers.formatEther(fund.free),
        totalPaidMstc: ethers.formatEther(fund.totalPaid),
      },
      wallets,
      txCount: counts.n,
      confirmedCount: counts.confirmed,
    };
  }),
);

api.get(
  "/chain/transactions",
  anyone,
  h(async (req) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (req.query.action) {
      params.push(String(req.query.action));
      where.push(`t.action = $${params.length}`);
    }
    if (req.query.requestId) {
      params.push(num(String(req.query.requestId)));
      where.push(`t.request_id = $${params.length}`);
    }
    if (req.query.status) {
      params.push(String(req.query.status));
      where.push(`t.status = $${params.length}`);
    }
    params.push(Math.min(500, Number(req.query.limit ?? 200)));
    const rows = await q(`${TX_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY t.id DESC LIMIT $${params.length}`, params);
    return rows.map(presentTx);
  }),
);

api.get(
  "/chain/transactions/:hash",
  anyone,
  h(async (req) => {
    const t = await one(`${TX_SELECT} WHERE t.hash = $1`, [req.params.hash]);
    if (!t) throw new WorkflowError("Transaction not recorded by this platform", 404);
    const L = ledger();
    let input: { method: string; args: Record<string, unknown> } | null = null;
    let confirmations: number | null = null;
    try {
      const tx = await L.provider.getTransaction(t.hash);
      if (tx) {
        const parsed = tx.data && tx.data !== "0x" ? L.iface.parseTransaction({ data: tx.data, value: tx.value }) : null;
        if (parsed) {
          const args: Record<string, unknown> = {};
          parsed.fragment.inputs.forEach((inp, i) => (args[inp.name] = JSON.parse(json(parsed.args[i]))));
          input = { method: parsed.name, args };
        }
        if (t.block_number) confirmations = (await L.reader.provider.getBlockNumber()) - Number(t.block_number) + 1;
      }
    } catch {
      /* offline */
    }
    return { ...presentTx(t), input, confirmations };
  }),
);

api.post(
  "/chain/observe",
  officer,
  h(async (req) => {
    const { hash, method, requestId, note } = req.body ?? {};
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(hash))) throw new WorkflowError("hash must be a transaction hash");
    const row = await observeWalletTx(String(hash), String(method), num(String(requestId)), actorOf(req.user), note ? String(note) : undefined);
    return { tx: presentTx(row), request: await requestDetail(num(String(requestId))) };
  }),
);

api.get(
  "/chain/role/:address",
  anyone,
  h(async (req) => {
    const address = ethers.getAddress(req.params.address);
    const L = ledger();
    const [isOfficer, isAdmin, balance] = await Promise.all([L.hasRole("OFFICER_ROLE", address), L.hasRole("DEFAULT_ADMIN_ROLE", address), L.balanceOf(address)]);
    return { address, officer: isOfficer, admin: isAdmin, balanceMstc: ethers.formatEther(balance) };
  }),
);

api.post(
  "/chain/grant-officer",
  officer,
  h(async (req) => {
    if (!config.auth.allowRoleGrants) throw new WorkflowError("Role grants are disabled (ALLOW_ROLE_GRANTS=false)", 403);
    const address = ethers.getAddress(String(req.body?.address ?? ""));
    const L = ledger();
    const { row } = await L.send("admin", "grantRole", [ethers.id("OFFICER_ROLE"), address], { action: "ROLE_GRANT", wallet: address });
    return presentTx(row);
  }),
);

api.post(
  "/chain/fund",
  officer,
  h(async (req) => {
    const amount = ethers.parseEther(String(req.body?.amountMstc ?? "0.1"));
    const L = ledger();
    const { row } = await L.send("admin", "fund", [], { action: "FUND_TOPUP", valueWei: amount }, { value: amount });
    return presentTx(row);
  }),
);

// ===========================================================================
// Notifications
// ===========================================================================

api.get("/notifications", anyone, h(async () => (await q(`SELECT * FROM notifications ORDER BY id DESC LIMIT 100`)).map(presentNotification)));
api.post(
  "/notifications/read",
  anyone,
  h(async (req) => {
    const ids: number[] | undefined = req.body?.ids;
    if (ids?.length) await q(`UPDATE notifications SET read = true WHERE id = ANY($1::int[])`, [ids]);
    else await q(`UPDATE notifications SET read = true WHERE read = false`);
    return { ok: true };
  }),
);

// ===========================================================================
// Worker app
// ===========================================================================

const workerOnly = requireRole("worker");

api.get(
  "/me/job",
  workerOnly,
  h(async (req) => {
    const w = await one(`SELECT * FROM workers WHERE id = $1`, [req.user!.workerId]);
    const job = await activeAssignmentForWorker(w.id);
    const recent = await one(`${REQUEST_SELECT} WHERE r.assigned_worker_id = $1 ORDER BY r.updated_at DESC LIMIT 1`, [w.id]);
    const focus = job ? job.request_id : recent?.id ?? null;
    let balance: string | null = null;
    try {
      balance = ethers.formatEther(await ledger().balanceOf(w.wallet_address));
    } catch {
      /* offline */
    }
    return {
      worker: presentWorker(w, await workerExtras(w)),
      balanceMstc: balance,
      job: focus ? await requestDetail(focus) : null,
      payments: (await q(`${PAYMENT_SELECT} WHERE p.worker_id = $1 ORDER BY p.id DESC LIMIT 10`, [w.id])).map(presentPayment),
    };
  }),
);

api.post(
  "/me/en-route",
  workerOnly,
  h(async (req) => {
    await markEnRoute(req.user!.workerId!);
    return { ok: true };
  }),
);

api.post(
  "/me/location",
  workerOnly,
  h(async (req) => {
    const { lat, lng, accuracy } = req.body ?? {};
    if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) throw new WorkflowError("lat/lng required");
    await updateWorkerLocation(req.user!.workerId!, Number(lat), Number(lng), "gps", accuracy ? Number(accuracy) : undefined);
    return { ok: true };
  }),
);

// ===========================================================================
// IoT devices (ESP32). Authenticated by HMAC-SHA256 of the raw body.
// ===========================================================================

api.get("/iot/time", (_req, res) => res.json({ now: Math.floor(Date.now() / 1000), nowMs: Date.now() }));

function deviceAuth(req: Request, binId: string) {
  verifyDeviceSignature(binId, req.rawBody, req.header("x-signature"));
}

api.post(
  "/iot/telemetry",
  h(async (req) => {
    const p = req.body as TelemetryPacket;
    if (!p?.binId) throw new WorkflowError("binId is required");
    deviceAuth(req, p.binId);
    const bin = await one(`SELECT hardware FROM bins WHERE id = $1`, [p.binId]);
    if (simSettings().mode !== "live" && bin?.hardware) {
      return { ok: true, mode: "simulation", commands: [], note: "Switch the dashboard to LIVE HARDWARE to use this device" };
    }
    const commands = await ingest(p, { source: "hardware" });
    return { ok: true, mode: simSettings().mode, commands, serverTime: Date.now() };
  }),
);

api.post(
  "/iot/rfid",
  h(async (req) => {
    const { binId, uid } = req.body ?? {};
    if (!binId || !uid) throw new WorkflowError("binId and uid are required");
    deviceAuth(req, String(binId));
    const r = await handleRfidTap(String(binId), normalizeUid(String(uid)), "hardware");
    return { ok: true, ...r };
  }),
);

api.get(
  "/iot/devices",
  officer,
  h(async () =>
    (await q(`SELECT id, name, hardware, online, last_heartbeat, source, device_address, last_seq FROM bins WHERE hardware = true ORDER BY id`)).map((b: any) => ({
      binId: b.id,
      name: b.name,
      online: b.online,
      lastHeartbeat: iso(b.last_heartbeat),
      source: b.source,
      deviceAddress: b.device_address,
      lastSeq: Number(b.last_seq),
    })),
  ),
);

api.get(
  "/iot/devices/:binId/provisioning",
  requireRole("admin", "officer"),
  h(async (req) => {
    const b = await one(`SELECT id, name, depth_cm, device_address FROM bins WHERE id = $1`, [req.params.binId]);
    if (!b) throw new WorkflowError("Unknown bin", 404);
    return {
      binId: b.id,
      name: b.name,
      depthCm: Number(b.depth_cm),
      deviceSecret: deviceSecret(b.id),
      deviceAddress: b.device_address,
      endpoint: "/api/iot/telemetry",
      rfidEndpoint: "/api/iot/rfid",
      port: config.port,
      network: config.networkLabel,
    };
  }),
);

// ===========================================================================
// Simulation director
// ===========================================================================

api.get("/sim", anyone, h(async () => simSnapshot()));
api.post(
  "/sim/settings",
  officer,
  h(async (req) => {
    const { mode, workerAutopilot, organic } = req.body ?? {};
    return setSimSettings({
      ...(mode === "live" || mode === "simulation" ? { mode } : {}),
      ...(typeof workerAutopilot === "boolean" ? { workerAutopilot } : {}),
      ...(typeof organic === "boolean" ? { organic } : {}),
    });
  }),
);
const sim = (fn: (req: Request) => unknown) =>
  h(async (req) => {
    try {
      return await fn(req);
    } catch (err) {
      if (err instanceof WorkflowError) throw err;
      throw new WorkflowError((err as Error).message, 409);
    }
  });
api.post("/sim/full-bin", officer, sim((req) => simulateFullBin(String(req.body?.binId ?? "BIN-001"), "manual")));
api.post("/sim/obstruction", officer, sim((req) => simulateObstruction(String(req.body?.binId ?? "BIN-001"))));
api.post("/sim/offline", officer, sim((req) => setBinOffline(String(req.body?.binId), !!req.body?.offline)));
api.post(
  "/sim/autopilot",
  officer,
  sim((req) => runAutopilot(String(req.body?.binId ?? "BIN-001"), { autoApprove: req.body?.autoApprove !== false, outcome: req.body?.outcome })),
);
api.post("/sim/arrive", officer, sim((req) => workerArriveNow(num(String(req.body?.requestId)))));
api.post("/sim/tap", officer, sim((req) => directTap(num(String(req.body?.requestId)), req.body?.card ?? "assigned")));
api.post("/sim/queue-card", officer, sim((req) => (queueCard(String(req.body?.binId), req.body?.card ?? "wrong"), { ok: true })));
api.post("/sim/collect", officer, sim((req) => directCollect(String(req.body?.binId), req.body?.outcome ?? "full")));
api.post(
  "/sim/rfid",
  officer,
  sim(async (req) => handleRfidTap(String(req.body?.binId ?? "BIN-001"), String(req.body?.uid ?? ""), "dashboard")),
);

// ===========================================================================

api.get("/stream", anyone, (req, res) => stream(req, res));

api.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  let status = 500;
  let message = (err as Error)?.message ?? String(err);
  if (err instanceof WorkflowError) status = err.status;
  else if (err instanceof DeviceAuthError) status = 401;
  else if (err instanceof TransitionError) status = 409;
  else if (err instanceof ChainError) status = 409;
  else if ((err as any)?.type === "entity.parse.failed") status = 400;
  if (status >= 500) console.error(err);
  res.status(status).type("application/json").send(json({ error: message }));
});

void CHAIN_STATUS;
