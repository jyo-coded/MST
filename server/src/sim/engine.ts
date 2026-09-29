import { haversineKm, requestCode } from "@astra/shared";
import { config, loadCity } from "../config";
import { getSetting, one, q, setSetting } from "../db";
import { onCommand } from "../iot/commands";
import { ingest } from "../iot/ingest";
import { publish } from "../realtime";
import { clamp, round1, sleep } from "../util";
import { rankWorkers } from "../workflow/assignment";
import {
  activeAssignmentForWorker,
  approveCompletion,
  approveRequest,
  assignWorker,
  handleRfidTap,
  markEnRoute,
  releasePayment,
  updateWorkerLocation,
  type Actor,
} from "../workflow/service";

/**
 * Simulation mode: synthetic sensors and workers that feed the SAME ingest,
 * AI, workflow and blockchain code as real hardware. Nothing downstream
 * knows (or cares) whether a packet came from an ESP32 or from here, except
 * the `source` label shown in the UI.
 */

type Outcome = "full" | "partial" | "none";
type SimBin = {
  id: string;
  depth: number;
  threshold: number;
  hardware: boolean;
  fill: number;
  trueFill: number; // what is really in the bin (differs while obstructed)
  bias2: number; // second sensor's calibration offset
  lid: "open" | "closed";
  servo: "locked" | "unlocked";
  mode: "idle" | "filling" | "obstructed" | "collecting";
  offline: boolean;
  target: number;
  drift: number;
  irPending: number;
  risen: number;
  obstructedUntil: number;
  collect: { outcome: Outcome; to: number; nextStepAt: number; closeAt: number | null } | null;
  lastSent: number;
  seq: number;
  scenario: string | null;
};
type SimWorker = {
  id: string;
  homeLat: number;
  homeLng: number;
  route: { fromLat: number; fromLng: number; toLat: number; toLng: number; start: number; ms: number; purpose: "job" | "home" } | null;
  arrivedAt: number | null;
  tapped: boolean;
};

export type SimSettings = { mode: "simulation" | "live"; workerAutopilot: boolean; organic: boolean };

const bins = new Map<string, SimBin>();
const workers = new Map<string, SimWorker>();
const pendingOutcome = new Map<string, Outcome>(); // binId -> outcome for the next collection
const pendingCard = new Map<string, "assigned" | "wrong" | "unknown">();
let settings: SimSettings = { mode: config.sim.mode, workerAutopilot: true, organic: config.sim.organic };
let tickCount = 0;
let autopilot: { binId: string; stage: string; running: boolean; autoApprove: boolean; requestId: number | null; error: string | null } | null = null;

const AUTOPILOT: Actor = { kind: "officer", name: "Autopilot" };
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pace = () => config.sim.pace;

export function simSettings() {
  return settings;
}
export function autopilotState() {
  return autopilot;
}

export async function setSimSettings(patch: Partial<SimSettings>) {
  settings = { ...settings, ...patch };
  await setSetting("simulation", settings);
  publish("system.mode", settings);
  return settings;
}

function simulated(b: SimBin) {
  return !(settings.mode === "live" && b.hardware);
}

export async function initSimulation() {
  settings = await getSetting<SimSettings>("simulation", settings);
  const rows = await q(`SELECT * FROM bins ORDER BY id`);
  for (const b of rows) {
    const start = b.fill_pct as number;
    bins.set(b.id, {
      id: b.id,
      depth: b.depth_cm,
      threshold: b.threshold_pct,
      hardware: b.hardware,
      fill: start,
      trueFill: start,
      bias2: rnd(-1.5, 1.5),
      lid: "closed",
      servo: "locked",
      mode: "idle",
      offline: false,
      target: start,
      drift: rnd(0.004, 0.03),
      irPending: 0,
      risen: 0,
      obstructedUntil: 0,
      collect: null,
      lastSent: 0,
      seq: 0,
      scenario: null,
    });
  }
  const offline = await getSetting<string[]>(
    "sim.offline",
    loadCity().bins.filter((b) => b.offline).map((b) => b.id),
  );
  for (const id of offline) {
    const b = bins.get(id);
    if (b) b.offline = true;
  }
  for (const w of await q(`SELECT * FROM workers`)) {
    workers.set(w.id, { id: w.id, homeLat: w.home_lat ?? w.lat, homeLng: w.home_lng ?? w.lng, route: null, arrivedAt: null, tapped: false });
  }

  onCommand((binId, cmd) => {
    const b = bins.get(binId);
    if (!b || !simulated(b)) return;
    if (cmd.type === "UNLOCK_LID") {
      b.servo = "unlocked";
      // The worker opens the lid shortly after it unlocks.
      const outcome = pendingOutcome.get(binId) ?? (settings.workerAutopilot ? "full" : null);
      if (outcome) setTimeout(() => startCollection(binId, outcome), 1500 / pace());
    }
    if (cmd.type === "LOCK_LID") b.servo = "locked";
  });

  setInterval(() => tick().catch((err) => console.error("sim tick failed", err)), config.sim.tickMs / pace());
}

// ---------------------------------------------------------------------------
// Sensors
// ---------------------------------------------------------------------------

async function tick() {
  tickCount++;
  const now = Date.now();
  let i = 0;
  for (const b of bins.values()) {
    i++;
    if (!simulated(b) || b.offline) continue;
    step(b, now);
    const active = b.mode !== "idle" || b.lid === "open" || b.servo === "unlocked";
    if (active || (tickCount + i) % 5 === 0) {
      await send(b);
    }
  }
  await moveWorkers(now);
}

function step(b: SimBin, now: number) {
  switch (b.mode) {
    case "idle": {
      const cap = settings.organic ? 100 : b.threshold - 4;
      if (b.fill < cap && Math.random() < 0.6) {
        const inc = b.drift * rnd(0.3, 1.7);
        b.fill = Math.min(cap, b.fill + inc);
        b.trueFill = b.fill;
        b.risen += inc;
        if (b.risen >= 1.2) {
          b.irPending += 1;
          b.risen = 0;
        }
      }
      break;
    }
    case "filling": {
      const inc = rnd(2.4, 4.2);
      b.fill = Math.min(b.target, b.fill + inc);
      b.trueFill = b.fill;
      b.irPending += 1;
      if (b.fill >= b.target) b.mode = "idle";
      break;
    }
    case "obstructed": {
      if (now > b.obstructedUntil) {
        b.mode = "idle";
        b.fill = b.trueFill;
      }
      break;
    }
    case "collecting": {
      const c = b.collect!;
      if (b.lid === "closed" && now >= c.nextStepAt) {
        b.lid = "open";
        c.nextStepAt = now + 2200 / pace();
        break;
      }
      if (b.lid === "open" && c.closeAt === null && now >= c.nextStepAt) {
        if (b.fill > c.to + 0.5) {
          const chunk = Math.min(b.fill - c.to, rnd(11, 19));
          b.fill = round1(b.fill - chunk);
          b.trueFill = b.fill;
          c.nextStepAt = now + rnd(1800, 2600) / pace();
        } else {
          c.closeAt = now + 1500 / pace();
        }
      }
      if (c.closeAt !== null && now >= c.closeAt) {
        b.lid = "closed";
        b.mode = "idle";
        b.collect = null;
      }
      break;
    }
  }
}

async function send(b: SimBin) {
  const noise = () => rnd(-0.6, 0.6);
  const primary = clamp(b.fill + noise(), 0, 100);
  // While obstructed, the second sensor still sees the real waste level.
  const secondary = clamp((b.mode === "obstructed" ? b.trueFill : b.fill) + b.bias2 + noise(), 0, 100);
  const packet = {
    binId: b.id,
    fillPercentage: round1(primary),
    ultrasonicDistance: round1(b.depth * (1 - primary / 100)),
    secondaryFillPercentage: round1(secondary),
    secondaryDistance: round1(b.depth * (1 - secondary / 100)),
    lidState: b.lid,
    servoState: b.servo,
    irStatus: (b.irPending > 0 ? "triggered" : "normal") as "triggered" | "normal",
    irCount: b.irPending,
    rfidDetected: false,
    temperature: round1(29 + Math.sin(Date.now() / 3.6e6) * 2 + rnd(-0.2, 0.2)),
    rssi: Math.round(rnd(-72, -55)),
    seq: ++b.seq,
    timestamp: Date.now(),
  };
  b.irPending = 0;
  b.lastSent = Date.now();
  await ingest(packet, { source: "simulation", scenario: b.scenario });
}

function startCollection(binId: string, outcome: Outcome) {
  const b = bins.get(binId);
  if (!b || b.mode === "collecting") return;
  pendingOutcome.delete(binId);
  const to = outcome === "full" ? rnd(8, 18) : outcome === "partial" ? b.fill - rnd(18, 28) : b.fill - rnd(0.5, 1.5);
  b.mode = "collecting";
  b.collect = { outcome, to: round1(Math.max(2, to)), nextStepAt: Date.now() + 600 / pace(), closeAt: outcome === "none" ? Date.now() + 7000 / pace() : null };
  if (outcome === "none") {
    // Lid is opened and closed, nothing is removed.
    b.collect.nextStepAt = Date.now() + 500 / pace();
  }
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

async function moveWorkers(now: number) {
  for (const w of workers.values()) {
    const row = await one(`SELECT * FROM workers WHERE id = $1`, [w.id]);
    if (!row || (row.location_source === "gps" && now - new Date(row.location_updated_at).getTime() < 60_000)) continue;
    const job = await activeAssignmentForWorker(w.id);

    if (job && ["ASSIGNED", "EN_ROUTE"].includes(job.status)) {
      const bin = await one(`SELECT * FROM bins WHERE id = $1`, [job.bin_id]);
      if (!w.route || w.route.purpose !== "job") {
        const km = haversineKm({ lat: row.lat, lng: row.lng }, { lat: bin.lat, lng: bin.lng });
        // Time-compressed travel so a demo takes minutes, not an afternoon.
        w.route = { fromLat: row.lat, fromLng: row.lng, toLat: bin.lat, toLng: bin.lng, start: now, ms: clamp(km * 5000, 7000, 16000) / pace(), purpose: "job" };
        w.arrivedAt = null;
        w.tapped = false;
        if (job.status === "ASSIGNED") await markEnRoute(w.id);
      }
    }

    if (w.route) {
      const t = clamp((now - w.route.start) / w.route.ms, 0, 1);
      const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      // A gentle bend so paths don't look like ruler lines.
      const bend = Math.sin(t * Math.PI) * 0.0012;
      const lat = w.route.fromLat + (w.route.toLat - w.route.fromLat) * ease + bend;
      const lng = w.route.fromLng + (w.route.toLng - w.route.fromLng) * ease - bend * 0.6;
      await updateWorkerLocation(w.id, t >= 1 ? w.route.toLat : lat, t >= 1 ? w.route.toLng : lng, "simulation");
      if (t >= 1) {
        if (w.route.purpose === "job") w.arrivedAt = now;
        w.route = null;
      }
      continue;
    }

    // At the bin: tap the card (autopilot, or when the director asks).
    if (job && job.status === "AT_BIN" && !w.tapped) {
      const card = pendingCard.get(job.bin_id) ?? (settings.workerAutopilot ? "assigned" : null);
      if (card && now - (w.arrivedAt ?? 0) > 2500 / pace()) {
        w.tapped = card === "assigned";
        pendingCard.delete(job.bin_id);
        // After a refused card, the real worker steps up a few seconds later.
        if (!w.tapped) w.arrivedAt = now + 4000 / pace();
        await tapCard(job.request_id, card);
      }
      continue;
    }

    // Idle and far from home: wander back to the depot area.
    if (!job && ["AVAILABLE", "COMPLETED", "AWAITING_VERIFICATION"].includes(row.status)) {
      const d = haversineKm({ lat: row.lat, lng: row.lng }, { lat: w.homeLat, lng: w.homeLng });
      if (d > 0.3 && Math.random() < 0.05) {
        w.route = { fromLat: row.lat, fromLng: row.lng, toLat: w.homeLat, toLng: w.homeLng, start: now, ms: clamp(d * 12000, 15000, 40000) / pace(), purpose: "home" };
      }
    }
  }
}

async function tapCard(requestId: number, card: "assigned" | "wrong" | "unknown") {
  const r = await one(`SELECT * FROM collection_requests WHERE id = $1`, [requestId]);
  if (!r) return;
  let uid = "DEADBEEF";
  if (card === "assigned") uid = (await one(`SELECT rfid_uid FROM workers WHERE id = $1`, [r.assigned_worker_id]))?.rfid_uid ?? uid;
  if (card === "wrong") uid = (await one(`SELECT rfid_uid FROM workers WHERE id <> $1 ORDER BY id LIMIT 1`, [r.assigned_worker_id]))?.rfid_uid ?? uid;
  await handleRfidTap(r.bin_id, uid, "simulation");
}

// ---------------------------------------------------------------------------
// Director controls (the demo panel)
// ---------------------------------------------------------------------------

function simBin(binId: string) {
  const b = bins.get(binId);
  if (!b) throw new Error(`Unknown bin ${binId}`);
  if (!simulated(b)) throw new Error(`${binId} is driven by real hardware in LIVE mode`);
  return b;
}

export function simulateFullBin(binId: string, scenario = "full-bin") {
  const b = simBin(binId);
  b.offline = false;
  b.mode = "filling";
  b.target = round1(rnd(93, 96.5));
  b.scenario = scenario;
  return { binId, target: b.target };
}

export function simulateObstruction(binId: string) {
  const b = simBin(binId);
  b.mode = "obstructed";
  b.trueFill = Math.min(b.fill, 45);
  b.fill = 97;
  b.obstructedUntil = Date.now() + 25_000 / pace();
  b.scenario = "sensor-obstruction";
  return { binId };
}

export async function setBinOffline(binId: string, offline: boolean) {
  const b = simBin(binId);
  b.offline = offline;
  const list = [...bins.values()].filter((x) => x.offline).map((x) => x.id);
  await setSetting("sim.offline", list);
  return { binId, offline };
}

export async function workerArriveNow(requestId: number) {
  const r = await one(`SELECT * FROM collection_requests WHERE id = $1`, [requestId]);
  if (!r?.assigned_worker_id) throw new Error("No worker assigned");
  const w = workers.get(r.assigned_worker_id);
  const row = await one(`SELECT * FROM workers WHERE id = $1`, [r.assigned_worker_id]);
  const bin = await one(`SELECT * FROM bins WHERE id = $1`, [r.bin_id]);
  if (w) w.route = { fromLat: row.lat, fromLng: row.lng, toLat: bin.lat, toLng: bin.lng, start: Date.now(), ms: 2500, purpose: "job" };
  if (row.status === "ASSIGNED") await markEnRoute(row.id);
  return { requestId };
}

export async function directTap(requestId: number, card: "assigned" | "wrong" | "unknown") {
  const r = await one(`SELECT * FROM collection_requests WHERE id = $1`, [requestId]);
  if (!r) throw new Error("Unknown request");
  await tapCard(requestId, card);
  return { requestId, card };
}

export function directCollect(binId: string, outcome: Outcome) {
  const b = simBin(binId);
  if (b.servo === "unlocked") startCollection(binId, outcome);
  else pendingOutcome.set(binId, outcome);
  return { binId, outcome };
}

export function queueCard(binId: string, card: "assigned" | "wrong" | "unknown") {
  pendingCard.set(binId, card);
}

/**
 * Runs the whole storyline for one bin. With autoApprove the autopilot acts
 * as the municipal officer; without it, it waits for a human to click.
 */
export async function runAutopilot(binId: string, opts: { autoApprove: boolean; outcome?: Outcome }) {
  if (autopilot?.running) throw new Error(`Autopilot is already running for ${autopilot.binId}`);
  const busy = await one(`SELECT id FROM collection_requests WHERE bin_id = $1 AND status NOT IN ('REJECTED','COMPLETED') LIMIT 1`, [binId]);
  if (busy) throw new Error(`${binId} already has an open request`);
  autopilot = { binId, stage: "Filling the bin", running: true, autoApprove: opts.autoApprove, requestId: null, error: null };
  const stage = (s: string) => {
    autopilot!.stage = s;
    publish("sim.autopilot", autopilot);
  };
  stage("Filling the bin");
  if (opts.outcome) pendingOutcome.set(binId, opts.outcome);
  (async () => {
    const started = Date.now();
    const since = new Date(started - 1000).toISOString();
    simulateFullBin(binId, "autopilot");
    const waitFor = async (pred: (r: any) => boolean, label: string, ms = 180_000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const r = await one(`SELECT * FROM collection_requests WHERE bin_id = $1 AND created_at >= $2 ORDER BY id DESC LIMIT 1`, [binId, since]);
        if (r) autopilot!.requestId = r.id;
        if (r && r.status === "REJECTED") throw new Error(`${requestCode(r.id)} was rejected`);
        if (r && pred(r)) return r;
        await sleep(400);
      }
      throw new Error(`Timed out waiting for: ${label}`);
    };
    try {
      let r = await waitFor((x) => x.status === "AWAITING_APPROVAL", "request on-chain");
      if (opts.autoApprove) {
        stage("Municipality approving");
        await sleep(1800 / pace());
        await approveRequest(r.id, AUTOPILOT);
        stage("Assigning nearest worker");
        await sleep(1200 / pace());
        const best = (await rankWorkers(binId)).find((c) => c.recommended);
        if (!best) throw new Error("No available worker");
        await assignWorker(r.id, best.workerId, AUTOPILOT);
      } else {
        stage("Waiting for officer to approve and assign");
        r = await waitFor((x) => ["ASSIGNED", "EN_ROUTE", "COLLECTING"].includes(x.status), "officer assignment", 600_000);
      }
      stage("Worker travelling to the bin");
      r = await waitFor((x) => x.status === "COLLECTING", "RFID verification");
      stage("Collecting");
      r = await waitFor((x) => ["AWAITING_FINAL_APPROVAL", "INVESTIGATION"].includes(x.status), "AI completion verification");
      if (r.status === "INVESTIGATION") {
        stage("Investigation required: waiting for officer");
      } else if (opts.autoApprove) {
        stage("Municipality approving completion");
        await sleep(1800 / pace());
        await approveCompletion(r.id, AUTOPILOT, "Verified by sensors and AI");
        stage("Releasing payment on MST");
        await sleep(1200 / pace());
        await releasePayment(r.id, AUTOPILOT);
        stage("Paid");
      } else {
        stage("Waiting for officer to approve and pay");
        await waitFor((x) => x.status === "COMPLETED", "completion approval", 600_000);
        stage("Completion approved");
      }
    } catch (err) {
      autopilot!.error = (err as Error).message;
      stage(`Stopped: ${(err as Error).message}`);
    } finally {
      autopilot!.running = false;
      publish("sim.autopilot", autopilot);
    }
  })();
  return autopilot;
}

export function simSnapshot() {
  return {
    settings,
    autopilot,
    bins: [...bins.values()].map((b) => ({ id: b.id, mode: b.mode, offline: b.offline, simulated: simulated(b), fill: round1(b.fill) })),
  };
}
