import { clamp, keccakJson, round1, stdev } from "../util";

/**
 * Sensor-fusion verification. Every decision is the product of named checks
 * with an observed value, an expected value, a weight and a score, so the
 * dashboard can show exactly why the model accepted or rejected an event.
 *
 * confidence = 100 x (sum of weight x score) / (sum of weights)
 * verified   = every critical check passes AND confidence >= threshold
 */

export type Sample = {
  ts: string; // ISO
  fill: number;
  fill2: number | null;
  distanceCm: number | null;
  lid: string;
  servo: string;
  ir: number; // IR deposits in this packet
};

export type Check = {
  id: string;
  label: string;
  observed: string;
  expected: string;
  pass: boolean;
  score: number; // 0..1
  weight: number;
  critical: boolean;
  reason: string; // plain-language line for the evidence panel
};

export type FusionResult = {
  kind: "fullness" | "completion";
  decision: "VERIFIED" | "REJECTED" | "COLLECTION_VERIFIED" | "COLLECTION_NOT_VERIFIED";
  verified: boolean;
  confidence: number; // 0-100, one decimal
  checks: Check[];
  reasons: string[];
  summary: Record<string, unknown>;
  evidence: Record<string, unknown>; // exactly what was hashed and signed
  evidenceHash: string;
};

/**
 * Ultrasonic sensors are good to about ±1 cm, so the model never claims
 * certainty: confidence carries a measurement-uncertainty discount driven by
 * how much the two sensors disagree and how noisy the readings were.
 */
function uncertainty(sensorGapPts: number | null, noisePts: number) {
  return 0.012 + Math.min(0.04, ((sensorGapPts ?? 10) + noisePts) / 250);
}

function finish(
  kind: FusionResult["kind"],
  checks: Check[],
  minConfidence: number,
  summary: Record<string, unknown>,
  evidence: Record<string, unknown>,
  u: number,
): FusionResult {
  const total = checks.reduce((a, c) => a + c.weight, 0);
  const got = checks.reduce((a, c) => a + c.weight * clamp(c.score, 0, 1), 0);
  const confidence = round1(((100 * got) / total) * (1 - u));
  summary = { ...summary, measurementUncertaintyPct: round1(u * 100) };
  const criticalOk = checks.every((c) => !c.critical || c.pass);
  const verified = criticalOk && confidence >= minConfidence;
  const decision = kind === "fullness" ? (verified ? "VERIFIED" : "REJECTED") : verified ? "COLLECTION_VERIFIED" : "COLLECTION_NOT_VERIFIED";
  // Failures first: that's what an officer needs to read.
  const reasons = [...checks.filter((c) => !c.pass), ...checks.filter((c) => c.pass)].map((c) => c.reason);
  return { kind, decision, verified, confidence, checks, reasons, summary, evidence, evidenceHash: keccakJson(evidence) };
}

const pct = (n: number) => `${Math.round(n)}%`;

// ===========================================================================
// 1. Is the bin genuinely full, and is the reading trustworthy?
// ===========================================================================

/** Standard deviation of residuals around a least-squares line. */
function detrendedStdev(ys: number[]): number {
  const n = ys.length;
  if (n < 3) return 0;
  const xs = ys.map((_, i) => i);
  const mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / sxx;
  return stdev(ys.map((y, i) => y - (my + slope * (i - mx))));
}

export function verifyFullness(input: {
  binId: string;
  thresholdPct: number;
  window: Sample[]; // ascending, the last few minutes
  deviceAuthenticated: boolean;
  source: string;
  minConfidence: number;
}): FusionResult {
  const w = input.window;
  const last = w[w.length - 1];
  const fill = last?.fill ?? 0;
  const fill2 = last?.fill2 ?? null;
  const checks: Check[] = [];

  checks.push({
    id: "PRIMARY_THRESHOLD",
    label: "Ultrasonic level above threshold",
    observed: pct(fill),
    expected: `≥ ${input.thresholdPct}%`,
    pass: fill >= input.thresholdPct,
    score: fill >= input.thresholdPct ? 1 : fill / input.thresholdPct,
    weight: 3,
    critical: true,
    reason:
      fill >= input.thresholdPct
        ? `Primary ultrasonic reads ${pct(fill)}, above the ${input.thresholdPct}% threshold`
        : `Primary ultrasonic reads only ${pct(fill)}, below the ${input.thresholdPct}% threshold`,
  });

  const diff = fill2 === null ? null : Math.abs(fill - fill2);
  checks.push({
    id: "SECONDARY_AGREES",
    label: "Supporting sensor agrees",
    observed: fill2 === null ? "no reading" : `${pct(fill2)} (Δ ${Math.round(diff!)} pts)`,
    expected: "within 10 pts of primary",
    pass: diff !== null && diff <= 10,
    score: diff === null ? 0.3 : clamp(1 - diff / 30, 0, 1),
    weight: 3,
    critical: true,
    reason:
      diff === null
        ? "Second ultrasonic sensor sent no reading"
        : diff <= 10
          ? `Second ultrasonic sensor agrees (${pct(fill2!)})`
          : `Second ultrasonic sensor disagrees: ${pct(fill2!)} vs ${pct(fill)}. Something may be blocking the primary sensor`,
  });

  // Scatter around the trend: a bin that is steadily filling is smooth, a
  // flickering or loose sensor is not.
  const recent = w.slice(-5).map((s) => s.fill);
  const sd = detrendedStdev(recent);
  checks.push({
    id: "STABLE_READING",
    label: "Stable reading",
    observed: `σ ${sd.toFixed(1)} pts around trend (${recent.length} samples)`,
    expected: "σ ≤ 4 pts",
    pass: sd <= 4,
    score: clamp(1 - Math.max(0, sd - 2) / 8, 0, 1),
    weight: 1,
    critical: false,
    reason: sd <= 4 ? "Last readings are stable, not sensor noise" : `Readings fluctuate (σ ${sd.toFixed(1)}), which suggests noise or movement`,
  });

  let maxRise = 0;
  let rise = 0;
  let ir = 0;
  for (let i = 1; i < w.length; i++) {
    const step = w[i].fill - w[i - 1].fill;
    if (step > maxRise) maxRise = step;
    if (step > 0) rise += step;
    ir += w[i].ir;
  }
  checks.push({
    id: "GRADUAL_FILL",
    label: "Gradual accumulation",
    observed: `largest jump ${Math.round(maxRise)} pts`,
    expected: "≤ 25 pts per reading",
    pass: maxRise <= 25,
    score: clamp(1 - Math.max(0, maxRise - 15) / 40, 0, 1),
    weight: 2,
    critical: false,
    reason:
      maxRise <= 25
        ? "Waste level rose gradually, as real waste does"
        : `Level jumped ${Math.round(maxRise)} points in one reading. Looks like an obstruction, not waste`,
  });

  const needIr = rise >= 20 ? 2 : 0;
  checks.push({
    id: "IR_ACTIVITY",
    label: "Deposits seen by IR sensor",
    observed: `${ir} deposit${ir === 1 ? "" : "s"} during a ${Math.round(rise)}-pt rise`,
    expected: needIr ? `≥ ${needIr} deposits` : "any",
    pass: ir >= needIr,
    score: needIr ? clamp(ir / needIr, 0, 1) : 1,
    weight: 2,
    critical: false,
    reason: ir >= needIr ? `IR sensor saw ${ir} deposits while the bin filled` : "IR sensor saw no deposits, yet the level rose",
  });

  const lidClosed = last?.lid === "closed";
  checks.push({
    id: "LID_CLOSED",
    label: "Lid closed during measurement",
    observed: last?.lid ?? "unknown",
    expected: "closed",
    pass: lidClosed,
    score: lidClosed ? 1 : 0.2,
    weight: 1,
    critical: false,
    reason: lidClosed ? "Lid was closed, so the ultrasonic reading is valid" : "Lid was open while measuring, so the reading may be unreliable",
  });

  const times = w.map((s) => Date.parse(s.ts));
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const monotonic = gaps.every((g) => g > 0);
  const maxGap = Math.max(0, ...gaps);
  const continuous = w.length >= 5 && monotonic && maxGap <= Math.max(3 * median, 15000);
  checks.push({
    id: "TELEMETRY_SEQUENCE",
    label: "Consistent telemetry sequence",
    observed: `${w.length} samples, max gap ${(maxGap / 1000).toFixed(0)}s${monotonic ? "" : ", out of order"}`,
    expected: "≥ 5 ordered samples, no long gaps",
    pass: continuous,
    score: continuous ? 1 : 0.4,
    weight: 1,
    critical: false,
    reason: continuous ? "Telemetry arrived in order with no gaps" : "Telemetry has gaps or out-of-order packets",
  });

  checks.push({
    id: "DEVICE_IDENTITY",
    label: "Expected device and location",
    observed: input.deviceAuthenticated ? `${input.binId} authenticated (${input.source})` : "unauthenticated",
    expected: "registered device key",
    pass: input.deviceAuthenticated,
    score: input.deviceAuthenticated ? 1 : 0,
    weight: 1,
    critical: true,
    reason: input.deviceAuthenticated
      ? `Packets authenticated as ${input.binId} at its registered location`
      : "Packets are not authenticated as this bin",
  });

  const evidence = {
    binId: input.binId,
    thresholdPct: input.thresholdPct,
    samples: w.map((s) => [s.ts, s.fill, s.fill2, s.lid, s.ir]),
  };
  return finish(
    "fullness",
    checks,
    input.minConfidence,
    { fillPct: round1(fill), fill2Pct: fill2 === null ? null : round1(fill2), distanceCm: last?.distanceCm ?? null, samples: w.length, irDeposits: ir },
    evidence,
    uncertainty(diff, sd),
  );
}

// ===========================================================================
// 2. Was the bin actually emptied, by the right person, in the right way?
// ===========================================================================

export function verifyCompletion(input: {
  binId: string;
  requestId: number;
  before: number;
  after: number;
  after2: number | null;
  window: Sample[]; // ascending, from RFID tap to lid closed (+ a few samples)
  rfidVerified: boolean;
  rfidWorker: string | null;
  assignedWorker: string | null;
  rfidAt: string | null;
  lidOpenedAt: string | null;
  lidClosedAt: string | null;
  assignedAt: string | null;
  workerDistanceM: number | null;
  minConfidence: number;
}): FusionResult {
  const checks: Check[] = [];
  const drop = input.before - input.after;
  const t = (s: string | null) => (s ? Date.parse(s) : NaN);

  checks.push({
    id: "RFID_VERIFIED",
    label: "RFID verified",
    observed: input.rfidVerified ? `${input.rfidWorker} card` : input.rfidWorker ? `${input.rfidWorker} card (not assigned)` : "no valid card",
    expected: `${input.assignedWorker ?? "assigned worker"} card`,
    pass: input.rfidVerified,
    score: input.rfidVerified ? 1 : 0,
    weight: 3,
    critical: true,
    reason: input.rfidVerified ? `Assigned worker ${input.rfidWorker} authenticated with RFID` : "No RFID authentication from the assigned worker",
  });

  const opened = !!input.lidOpenedAt;
  checks.push({
    id: "LID_OPENED",
    label: "Lid opened",
    observed: opened ? `opened ${new Date(input.lidOpenedAt!).toLocaleTimeString("en-GB")}` : "never opened",
    expected: "opened after RFID",
    pass: opened,
    score: opened ? 1 : 0,
    weight: 2,
    critical: true,
    reason: opened ? "Servo unlocked and the lid opened after authentication" : "The lid never opened",
  });

  checks.push({
    id: "LEVEL_DROPPED",
    label: "Sensor change detected",
    observed: `${pct(input.before)} → ${pct(input.after)} (−${Math.max(0, Math.round(drop))} pts)`,
    expected: "≥ 50 pts removed",
    pass: drop >= 50,
    score: clamp(drop / 50, 0, 1),
    weight: 3,
    critical: true,
    reason:
      drop >= 50
        ? `Waste level fell from ${pct(input.before)} to ${pct(input.after)}`
        : `Waste level only fell from ${pct(input.before)} to ${pct(input.after)}`,
  });

  checks.push({
    id: "AFTER_LEVEL_LOW",
    label: "Bin left near empty",
    observed: pct(input.after),
    expected: "≤ 30%",
    pass: input.after <= 30,
    score: clamp(1 - Math.max(0, input.after - 30) / 40, 0, 1),
    weight: 2,
    critical: false,
    reason: input.after <= 30 ? `Bin left at ${pct(input.after)}` : `Bin still ${pct(input.after)} full after collection`,
  });

  // How much of the drop happened while the lid was open?
  let totalDrop = 0;
  let openDrop = 0;
  let steps = 0;
  for (let i = 1; i < input.window.length; i++) {
    const a = input.window[i - 1];
    const b = input.window[i];
    const d = a.fill - b.fill;
    if (d > 1) {
      totalDrop += d;
      steps += 1;
      if (a.lid === "open" || b.lid === "open") openDrop += d;
    }
  }
  const openShare = totalDrop > 0 ? openDrop / totalDrop : 0;
  checks.push({
    id: "DROP_WHILE_OPEN",
    label: "Level fell while lid was open",
    observed: totalDrop > 0 ? `${Math.round(openShare * 100)}% of the drop` : "no drop observed",
    expected: "≥ 80%",
    pass: openShare >= 0.8,
    score: clamp(openShare / 0.8, 0, 1),
    weight: 2,
    critical: false,
    reason:
      openShare >= 0.8
        ? "The level fell while the lid was open, consistent with manual emptying"
        : totalDrop > 0
          ? "Part of the level change happened with the lid closed (sensor tampering?)"
          : "No level change was recorded during the lid window",
  });

  checks.push({
    id: "GRADUAL_REMOVAL",
    label: "Removed in several loads",
    observed: `${steps} decreasing step${steps === 1 ? "" : "s"}`,
    expected: "≥ 3 steps",
    pass: steps >= 3 || drop < 20,
    score: drop < 20 ? 0.5 : clamp(steps / 3, 0, 1),
    weight: 1,
    critical: false,
    reason: steps >= 3 ? `Waste removed in ${steps} loads, like real collection` : "Level changed in a single step, like an obstruction being removed",
  });

  const agree = input.after2 === null ? null : Math.abs(input.after - input.after2);
  checks.push({
    id: "SENSORS_AGREE_AFTER",
    label: "Both sensors confirm empty",
    observed: input.after2 === null ? "no second reading" : `${pct(input.after2)} (Δ ${Math.round(agree!)} pts)`,
    expected: "within 10 pts",
    pass: agree !== null && agree <= 10,
    score: agree === null ? 0.3 : clamp(1 - agree / 30, 0, 1),
    weight: 2,
    critical: false,
    reason: agree !== null && agree <= 10 ? "Second ultrasonic sensor confirms the new level" : "Second sensor does not confirm the new level",
  });

  const durSec = (t(input.lidClosedAt) - t(input.lidOpenedAt)) / 1000;
  const durOk = Number.isFinite(durSec) && durSec >= 8 && durSec <= 1800;
  checks.push({
    id: "DURATION_VALID",
    label: "Collection duration valid",
    observed: Number.isFinite(durSec) ? `${Math.round(durSec)} s` : "unknown",
    expected: "8 s – 30 min",
    pass: durOk,
    score: durOk ? 1 : 0.3,
    weight: 1,
    critical: false,
    reason: durOk ? `Lid was open for ${Math.round(durSec)} s, a plausible collection time` : "Collection time is implausible",
  });

  const closed = !!input.lidClosedAt;
  checks.push({
    id: "LID_CLOSED",
    label: "Lid closed",
    observed: closed ? `closed ${new Date(input.lidClosedAt!).toLocaleTimeString("en-GB")}` : "still open",
    expected: "closed and locked",
    pass: closed,
    score: closed ? 1 : 0,
    weight: 2,
    critical: true,
    reason: closed ? "Lid closed and servo re-locked" : "Lid was left open",
  });

  const nearOk = input.workerDistanceM === null ? null : input.workerDistanceM <= 150;
  checks.push({
    id: "LOCATION_CONSISTENT",
    label: "Location consistent",
    observed: input.workerDistanceM === null ? "no worker GPS" : `worker ${Math.round(input.workerDistanceM)} m from bin`,
    expected: "≤ 150 m",
    pass: nearOk !== false,
    score: nearOk === null ? 0.6 : nearOk ? 1 : 0,
    weight: 1,
    critical: false,
    reason:
      nearOk === null
        ? "Worker location unavailable, relying on RFID proximity"
        : nearOk
          ? "Worker's GPS places them at the bin"
          : "Worker's GPS is far from the bin at tap time",
  });

  const seq = [t(input.assignedAt), t(input.rfidAt), t(input.lidOpenedAt), t(input.lidClosedAt)];
  const ordered = seq.every((x) => Number.isFinite(x)) && seq.every((x, i) => i === 0 || x >= seq[i - 1] - 5000);
  checks.push({
    id: "SEQUENCE_CONSISTENT",
    label: "Event sequence consistent",
    observed: ordered ? "assign → RFID → lid open → lid close" : "out of order or incomplete",
    expected: "assign → RFID → open → close",
    pass: ordered,
    score: ordered ? 1 : 0.2,
    weight: 1,
    critical: false,
    reason: ordered ? "Events happened in the expected order" : "Hardware events are out of order or missing",
  });

  const evidence = {
    binId: input.binId,
    requestId: input.requestId,
    before: input.before,
    after: input.after,
    after2: input.after2,
    rfidAt: input.rfidAt,
    lidOpenedAt: input.lidOpenedAt,
    lidClosedAt: input.lidClosedAt,
    samples: input.window.map((s) => [s.ts, s.fill, s.fill2, s.lid, s.ir]),
  };
  return finish(
    "completion",
    checks,
    input.minConfidence,
    {
      beforeLevel: round1(input.before),
      afterLevel: round1(input.after),
      removedPct: round1(Math.max(0, drop)),
      lidOpened: opened,
      lidClosed: closed,
      rfidVerified: input.rfidVerified,
      durationSec: Number.isFinite(durSec) ? Math.round(durSec) : null,
    },
    evidence,
    uncertainty(agree, detrendedStdev(input.window.slice(-3).map((s) => s.fill))),
  );
}
