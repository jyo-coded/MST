import assert from "node:assert/strict";
import { test } from "node:test";
import { BIN, PAYMENT, REQUEST, WORKER, markerState } from "@astra/shared";
import { verifyCompletion, verifyFullness, type Sample } from "../src/ai/fusion";

const t0 = Date.parse("2026-09-28T10:00:00Z");
const s = (i: number, fill: number, fill2: number | null, lid = "closed", ir = 0): Sample => ({
  ts: new Date(t0 + i * 3000).toISOString(),
  fill,
  fill2,
  distanceCm: 60 * (1 - fill / 100),
  lid,
  servo: "locked",
  ir,
});

test("a genuinely full bin is verified with high confidence", () => {
  const window = Array.from({ length: 12 }, (_, i) => s(i, 60 + i * 3, 60 + i * 3 + 1, "closed", 1));
  const r = verifyFullness({ binId: "BIN-001", thresholdPct: 85, window, deviceAuthenticated: true, source: "test", minConfidence: 80 });
  assert.equal(r.decision, "VERIFIED");
  assert.ok(r.confidence >= 90 && r.confidence < 100, `confidence ${r.confidence}`);
  assert.match(r.evidenceHash, /^0x[0-9a-f]{64}$/);
});

test("an obstructed sensor (second sensor disagrees, sudden jump, no deposits) is rejected", () => {
  const window = [...Array.from({ length: 8 }, (_, i) => s(i, 40, 41)), ...Array.from({ length: 5 }, (_, i) => s(8 + i, 97, 41))];
  const r = verifyFullness({ binId: "BIN-004", thresholdPct: 85, window, deviceAuthenticated: true, source: "test", minConfidence: 80 });
  assert.equal(r.decision, "REJECTED");
  const failed = r.checks.filter((c) => !c.pass).map((c) => c.id);
  assert.ok(failed.includes("SECONDARY_AGREES"));
  assert.ok(failed.includes("GRADUAL_FILL"));
  assert.ok(failed.includes("IR_ACTIVITY"));
});

test("unauthenticated packets can never verify", () => {
  const window = Array.from({ length: 12 }, (_, i) => s(i, 60 + i * 3, 60 + i * 3, "closed", 1));
  const r = verifyFullness({ binId: "BIN-001", thresholdPct: 85, window, deviceAuthenticated: false, source: "test", minConfidence: 80 });
  assert.equal(r.verified, false);
});

function collection(after: number, rfid = true, weights?: number[], extra: Record<string, unknown> = {}) {
  const steps = [94, 94, 80, 62, 44, 30, after, after];
  const window = steps.map((f, i) => ({
    ...s(i, Math.max(f, after), Math.max(f, after) + 1, i >= 1 && i <= 6 ? "open" : "closed"),
    ...(weights ? { weightG: weights[i] } : {}),
  }));
  return verifyCompletion({
    binId: "BIN-001",
    requestId: 1,
    before: 94,
    after,
    after2: after + 1,
    window,
    rfidVerified: rfid,
    rfidWorker: "Ramesh Yadav",
    assignedWorker: "Ramesh Yadav",
    assignedAt: new Date(t0 - 60_000).toISOString(),
    rfidAt: new Date(t0 - 2000).toISOString(),
    lidOpenedAt: new Date(t0 + 3000).toISOString(),
    lidClosedAt: new Date(t0 + 21000).toISOString(),
    workerDistanceM: 4,
    minConfidence: 80,
    ...extra,
  });
}

test("a real collection is verified and summarised", () => {
  const r = collection(17);
  assert.equal(r.decision, "COLLECTION_VERIFIED");
  assert.equal(r.summary.beforeLevel, 94);
  assert.equal(r.summary.afterLevel, 17);
  assert.equal(r.summary.rfidVerified, true);
});

test("a partial collection and a collection without RFID are not verified", () => {
  assert.equal(collection(75).decision, "COLLECTION_NOT_VERIFIED");
  assert.equal(collection(17, false).decision, "COLLECTION_NOT_VERIFIED");
});

const HEAVY_TO_EMPTY = [9000, 9000, 7800, 6200, 4300, 3000, 2100, 2100]; // grams: 6.9 kg left the bin
const NO_CHANGE = [9000, 9010, 8995, 9005, 9000, 9002, 8998, 9001]; // level "dropped", weight did not

test("load cell agreeing with the level drop keeps the collection verified", () => {
  const r = collection(17, true, HEAVY_TO_EMPTY);
  assert.equal(r.decision, "COLLECTION_VERIFIED");
  assert.equal(r.summary.weightSensor, "present");
  assert.ok((r.summary.weightRemovedG as number) > 6000);
});

test("ultrasonic says emptied but the load cell did not move: rejected (spoofed or blocked sensors)", () => {
  const r = collection(17, true, NO_CHANGE);
  assert.equal(r.decision, "COLLECTION_NOT_VERIFIED");
  assert.ok(r.checks.filter((c) => !c.pass).map((c) => c.id).includes("WEIGHT_DROPPED"));
  assert.match(r.reasons[0], /load cell/i);
});

test("a bin that must report weight cannot verify without it; bins without a load cell are unaffected", () => {
  const strict = collection(17, true, undefined, { requireWeight: true });
  assert.equal(strict.decision, "COLLECTION_NOT_VERIFIED");
  assert.ok(strict.checks.some((c) => c.id === "WEIGHT_PRESENT" && !c.pass));
  const legacy = collection(17, true);
  assert.equal(legacy.decision, "COLLECTION_VERIFIED");
  assert.equal(legacy.summary.weightSensor, "absent (not required)");
});

test("state machines refuse shortcuts", () => {
  assert.equal(REQUEST.can("AWAITING_APPROVAL", "COMPLETED"), false);
  assert.equal(REQUEST.can("COLLECTING", "COMPLETED"), false);
  assert.equal(REQUEST.can("AWAITING_FINAL_APPROVAL", "COMPLETED"), true);
  assert.equal(PAYMENT.can("PENDING", "PAID"), false);
  assert.equal(BIN.can("NORMAL", "COMPLETED"), false);
  assert.equal(WORKER.can("AVAILABLE", "COLLECTING"), false);
});

test("map markers reflect bin, request and connectivity", () => {
  assert.equal(markerState({ status: "NORMAL", online: false, fillPct: 50, monitorPct: 70 }), "OFFLINE");
  assert.equal(markerState({ status: "NORMAL", online: true, fillPct: 75, monitorPct: 70 }), "MONITORING");
  assert.equal(markerState({ status: "COLLECTION_REQUESTED", online: true, fillPct: 95, monitorPct: 70, requestStatus: "APPROVED" }), "AWAITING_ASSIGNMENT");
  assert.equal(markerState({ status: "COLLECTION_IN_PROGRESS", online: true, fillPct: 40, monitorPct: 70 }), "COLLECTING");
});
