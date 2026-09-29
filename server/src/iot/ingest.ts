import crypto from "node:crypto";
import { config, deviceSecret } from "../config";
import { one, q } from "../db";
import { notify, record } from "../events";
import { publish } from "../realtime";
import { round1 } from "../util";
import { collectionSession, onCollectionTelemetry, onThresholdCrossed } from "../workflow/service";
import { setBin } from "../workflow/state";
import { takeCommands } from "./commands";

/**
 * The hardware contract. An ESP32 POSTs exactly this JSON (the spec's
 * telemetry model); the simulator produces the same shape.
 */
export type TelemetryPacket = {
  binId: string;
  ultrasonicDistance?: number; // cm, primary sensor
  fillPercentage?: number; // 0-100, primary
  secondaryDistance?: number; // cm, second ultrasonic
  secondaryFillPercentage?: number;
  lidState?: "open" | "closed";
  servoState?: "locked" | "unlocked";
  irStatus?: "normal" | "triggered";
  irCount?: number; // deposits seen since the previous packet
  rfidDetected?: boolean;
  temperature?: number;
  rssi?: number;
  seq?: number;
  timestamp?: number | string; // unix seconds/ms or ISO, device clock
};

export class DeviceAuthError extends Error {}

/** HMAC-SHA256(device secret, raw body), hex, in X-Signature. */
export function verifyDeviceSignature(binId: string, rawBody: Buffer | undefined, signature: string | undefined) {
  if (!rawBody || !signature) throw new DeviceAuthError("missing body or X-Signature");
  let secret: string;
  try {
    secret = deviceSecret(binId);
  } catch {
    throw new DeviceAuthError("device secrets are not configured");
  }
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const got = Buffer.from(signature.replace(/^0x/, ""), "hex");
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) throw new DeviceAuthError("bad signature");
}

function toMs(ts: TelemetryPacket["timestamp"]): number | null {
  if (ts === undefined || ts === null || ts === "") return null;
  if (typeof ts === "number") return ts > 1e12 ? ts : ts * 1000;
  const n = Number(ts);
  if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
  const p = Date.parse(ts);
  return Number.isFinite(p) ? p : null;
}

const fillFrom = (distance: number | undefined, depth: number) =>
  distance === undefined ? undefined : round1(Math.max(0, Math.min(100, ((depth - distance) / depth) * 100)));
const distanceFrom = (fill: number | undefined, depth: number) =>
  fill === undefined ? undefined : round1(depth * (1 - fill / 100));

const cooldown = new Map<string, number>();
/** Stops a rejected detection from immediately re-triggering on the next packet. */
export function coolDown(binId: string, ms: number) {
  cooldown.set(binId, Date.now() + ms);
}

const lastPublish = new Map<string, number>();

export async function ingest(p: TelemetryPacket, opts: { source: "hardware" | "simulation"; scenario?: string | null }) {
  const bin = await one(`SELECT * FROM bins WHERE id = $1`, [p.binId]);
  if (!bin) throw new DeviceAuthError(`unknown bin ${p.binId}`);

  if (opts.source === "hardware") {
    const devMs = toMs(p.timestamp);
    if (devMs !== null && devMs > 1.6e12 && Math.abs(devMs - Date.now()) > 5 * 60_000) {
      throw new DeviceAuthError("stale or future timestamp (sync the device clock via /api/iot/time)");
    }
    const lastBeat = bin.last_heartbeat ? new Date(bin.last_heartbeat).getTime() : 0;
    if (p.seq !== undefined && p.seq <= Number(bin.last_seq) && Date.now() - lastBeat < 15_000) {
      throw new DeviceAuthError(`replayed packet (seq ${p.seq} ≤ ${bin.last_seq})`);
    }
  }

  const depth = bin.depth_cm as number;
  const fill = p.fillPercentage ?? fillFrom(p.ultrasonicDistance, depth) ?? bin.fill_pct;
  const fill2 = p.secondaryFillPercentage ?? fillFrom(p.secondaryDistance, depth) ?? null;
  const distance = p.ultrasonicDistance ?? distanceFrom(fill, depth) ?? null;
  const distance2 = p.secondaryDistance ?? (fill2 !== null ? distanceFrom(fill2, depth) : null) ?? null;
  const lid = p.lidState ?? "closed";
  const servo = p.servoState ?? bin.servo_state;
  const ir = p.irStatus ?? ((p.irCount ?? 0) > 0 ? "triggered" : "normal");
  const ts = new Date().toISOString();

  await q(
    `INSERT INTO telemetry (bin_id, ts, seq, distance_cm, distance2_cm, fill_pct, fill2_pct, lid_state, servo_state, ir_status, ir_count, rfid_detected, temperature_c, rssi, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [p.binId, ts, p.seq ?? null, distance, distance2, fill, fill2, lid, servo, ir, p.irCount ?? 0, !!p.rfidDetected, p.temperature ?? null, p.rssi ?? null, opts.source],
  );
  const prevLid = bin.lid_state as string;
  const wasOffline = !bin.online;
  await q(
    `UPDATE bins SET fill_pct = $2, fill2_pct = $3, distance_cm = $4, distance2_cm = $5, lid_state = $6, servo_state = $7,
            ir_status = $8, temperature_c = COALESCE($9, temperature_c), online = true, source = $10, last_heartbeat = now(),
            last_seq = GREATEST(last_seq, $11)
      WHERE id = $1`,
    [p.binId, fill, fill2, distance, distance2, lid, servo, ir, p.temperature ?? null, opts.source, p.seq ?? 0],
  );

  if (wasOffline) {
    await record({ stage: "BIN_ONLINE", message: `${p.binId} is back online`, actor: `device:${p.binId}`, tone: "success", binId: p.binId });
  }

  // Keep the per-sensor view (bin detail page) current.
  if (opts.source === "hardware" || Math.random() < 0.2) {
    const values: [string, string][] = [
      ["ultrasonic_primary", `${distance ?? "–"} cm · ${fill}%`],
      ["ultrasonic_secondary", fill2 === null ? "no reading" : `${distance2} cm · ${fill2}%`],
      ["ir_mouth", ir],
      ["lid_switch", lid],
      ["servo", servo],
      ["rfid_reader", p.rfidDetected ? "card present" : "idle"],
    ];
    for (const [kind, v] of values) {
      await q(`UPDATE sensors SET last_value = $3, updated_at = now(), status = 'ok' WHERE bin_id = $1 AND kind = $2`, [p.binId, kind, v]);
    }
  }

  const now = Date.now();
  if (lid !== prevLid || now - (lastPublish.get(p.binId) ?? 0) > 400) {
    lastPublish.set(p.binId, now);
    publish("telemetry", { binId: p.binId, fill, fill2, distance, distance2, lid, servo, ir, irCount: p.irCount ?? 0, ts, source: opts.source });
  }

  if (collectionSession(p.binId)) {
    await onCollectionTelemetry(p.binId, prevLid, { fill, lid, ts });
  }

  if (bin.status === "NORMAL" && fill >= bin.threshold_pct && (cooldown.get(p.binId) ?? 0) < now) {
    coolDown(p.binId, 15_000); // debounce while detection runs
    onThresholdCrossed(p.binId, opts.scenario ?? null)
      .then(async () => {
        const r = await one(`SELECT status FROM collection_requests WHERE bin_id = $1 ORDER BY id DESC LIMIT 1`, [p.binId]);
        if (r?.status === "REJECTED") coolDown(p.binId, 3 * 60_000);
      })
      .catch((err) => console.error(`detection failed for ${p.binId}:`, err));
  }

  return takeCommands(p.binId);
}

/** Marks bins offline when their heartbeat stops. */
export function startHeartbeatMonitor() {
  setInterval(async () => {
    const stale = await q(`SELECT id, name FROM bins WHERE online = true AND last_heartbeat < now() - interval '30 seconds'`);
    for (const b of stale) {
      await setBin(b.id, null, { online: false });
      await record({ stage: "BIN_OFFLINE", message: `${b.id} stopped reporting (no heartbeat for 30 s)`, actor: "system", tone: "danger", binId: b.id });
      await notify({ type: "BIN_OFFLINE", severity: "critical", title: `${b.id} is offline`, body: `${b.name} has not reported for 30 seconds.`, binId: b.id });
    }
  }, 5000);
}

export function hardwareMode() {
  return config.sim.mode;
}
