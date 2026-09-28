import { ethers } from "ethers";
import { chain, ChainRevert, type TxResult } from "./chain";
import { config } from "./config";
import { requireDeviceWallet } from "./devices";
import {
  normaliseDeviceSignature,
  rawDataHash,
  rfidTagHash,
  signTyped,
  typedDigest,
  type CollectorClaim,
  type ServiceEvidence,
  type TypeName,
} from "./eip712";
import { emit } from "./events";
import { extractFeatures } from "./features";
import { decide, deterministicChecks, INCIDENT, nameOf, REASON, type Decision } from "./guardian";
import { readReport, saveReport } from "./reports";
import { downsample, parseBinCsv, parseCollectorCsv, type BinSample, type CollectorSample } from "./samples";
import {
  activeJobForBin,
  addTx,
  announce,
  jobsForBinSince,
  state,
  upsertJob,
  type ClaimJson,
  type EvidenceJson,
  type JobRecord,
} from "./store";
import { runVerifier } from "./verifier";

export class WorkflowError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

const nowSec = () => Math.floor(Date.now() / 1000);
const mstc = (wei: bigint | string) => `${ethers.formatEther(BigInt(wei))} MSTC`;
const txRef = (label: string, tx: TxResult) => ({ label, hash: tx.hash, url: tx.url });

/** Chain time, so checks agree with what the contract will see. */
async function chainNow(): Promise<number> {
  const block = await chain().provider.getBlock("latest");
  return block ? Number(block.timestamp) : nowSec();
}

/**
 * Returns a contract-ready signature for a machine message: the device's own
 * signature if it sent one (checked against the registered device key), or,
 * in gateway mode, one produced with the gateway-held device key.
 */
async function machineSignature(
  kind: "bin" | "collector",
  type: TypeName,
  value: Record<string, unknown>,
  provided: string | undefined,
  expectedDevice: string,
): Promise<string> {
  const c = chain();
  const digest = typedDigest(c.domain, type, value);
  if (provided) {
    const sig = normaliseDeviceSignature(digest, provided, expectedDevice);
    if (!sig) throw new WorkflowError(`${type} signature does not match the registered ${kind} device ${expectedDevice}`, 401);
    return sig;
  }
  if (config.server.deviceSigning !== "gateway") {
    throw new WorkflowError(`${type} must carry the ${kind} device's signature (DEVICE_SIGNING=device)`, 401);
  }
  const w = requireDeviceWallet(kind);
  if (w.address.toLowerCase() !== expectedDevice.toLowerCase()) {
    throw new WorkflowError(
      `Gateway ${kind} key ${w.address} is not the registered device ${expectedDevice}. Re-run \`npm run setup:*\`.`,
      500,
    );
  }
  return signTyped(w, c.domain, type, value);
}

function wrapRevert(err: unknown): never {
  if (err instanceof ChainRevert) throw new WorkflowError(`Contract refused: ${err.reason}`, 409);
  throw err;
}

// =========================================================================
// 1. The bin hires a collector
// =========================================================================

export async function hire(
  binId: bigint,
  body: { fillLevel: number; nonce?: string | number; expiry?: string | number; signature?: string },
  opts: { autoAccept?: boolean } = {},
): Promise<JobRecord> {
  const c = chain();
  const bin = await c.getBin(binId);
  if (bin.device === ethers.ZeroAddress) throw new WorkflowError(`Bin ${binId} is not registered`, 404);
  if (bin.activeJobId !== 0n) throw new WorkflowError(`Bin ${binId} already has active job #${bin.activeJobId}`, 409);

  const now = await chainNow();
  const fill = Math.round(Number(body.fillLevel));
  if (!Number.isFinite(fill) || fill < 0 || fill > 100) throw new WorkflowError("fillLevel must be 0-100");
  const req = {
    binId,
    fillLevel: BigInt(fill),
    nonce: BigInt(body.nonce ?? Math.max(now, Number(bin.lastNonce) + 1)),
    expiry: BigInt(body.expiry ?? now + 600),
  };
  const sig = await machineSignature("bin", "HireRequest", req, body.signature, bin.device);

  emit("job:hire", "info", `Bin ${binId} is ${fill}% full and posts a collection job`, { binId, fill });
  announce(`bin:${binId}`, "Bin full. Hiring a collector.", "info");

  let tx: TxResult;
  try {
    tx = await c.send("openJob", [req, sig], { label: `openJob (bin ${binId} hires)` });
  } catch (err) {
    wrapRevert(err);
  }
  const opened = tx.events.find((e) => e.name === "JobOpened");
  const jobId = String(opened?.args.jobId);
  const job = upsertJob(jobId, {
    jobId,
    binId: String(binId),
    wardId: String(bin.wardId),
    status: "Open",
    fillAtHire: fill,
    openedAt: nowSec(),
    txs: [txRef("openJob", tx)],
  });
  emit("job:opened", "success", `Job #${jobId} opened on-chain by bin ${binId}`, { jobId, tx });

  if ((opts.autoAccept ?? config.server.autoAccept) && config.server.deviceSigning === "gateway") {
    setTimeout(() => {
      accept(config.registry.collectorId, BigInt(jobId), {}).catch((err) =>
        emit("job:accept-failed", "danger", `Auto-accept failed: ${err.message}`),
      );
    }, 600);
  }
  return job;
}

// =========================================================================
// 2. A collector robot accepts (escrow is reserved on-chain)
// =========================================================================

export async function accept(
  collectorId: bigint,
  jobId: bigint,
  body: { expiry?: string | number; signature?: string },
): Promise<JobRecord> {
  const c = chain();
  const job = state.jobs[String(jobId)];
  if (job && job.status !== "Open") return job; // idempotent
  const collector = await c.getCollector(collectorId);
  if (collector.device === ethers.ZeroAddress) throw new WorkflowError(`Collector ${collectorId} is not registered`, 404);

  const acc = { jobId, collectorId, expiry: BigInt(body.expiry ?? (await chainNow()) + 600) };
  const sig = await machineSignature("collector", "AcceptJob", acc, body.signature, collector.device);

  let tx: TxResult;
  try {
    tx = await c.send("acceptJob", [acc, sig], { label: `acceptJob #${jobId} (collector ${collectorId})` });
  } catch (err) {
    wrapRevert(err);
  }
  const onchain = await c.getJob(jobId);
  addTx(String(jobId), txRef("acceptJob", tx));
  const updated = upsertJob(String(jobId), {
    status: "Accepted",
    collectorId: String(collectorId),
    acceptedAt: onchain.acceptedAt,
    deadline: onchain.deadline,
  });
  emit(
    "job:accepted",
    "success",
    `Collector ${collectorId} accepted job #${jobId}; ${mstc(onchain.reserved)} escrowed`,
    { jobId: String(jobId), collectorId: String(collectorId), deadline: onchain.deadline, tx },
  );
  announce(`bin:${updated.binId}`, `Collector ${collectorId} is on the way.`, "info");
  announce(`collector:${collectorId}`, `Job ${jobId}: go to bin ${updated.binId}.`, "info");
  return updated;
}

// =========================================================================
// 3. RFID tap at the bin (lid gate + supervisor emergency card)
// =========================================================================

export async function rfidTap(binId: bigint, uid: string) {
  const tagHash = rfidTagHash(uid);
  if (config.registry.supervisorRfidUid && rfidTagHash(config.registry.supervisorRfidUid) === tagHash) {
    const paused = (await chain().status()).paused;
    const result = paused ? await resume("supervisor RFID card") : await emergencyStop("supervisor RFID card");
    return { allow: false, action: paused ? "resumed" : "emergency_stop", tagHash, result };
  }
  const job = activeJobForBin(String(binId));
  if (!job || job.status !== "Accepted" || !job.collectorId) {
    emit("rfid:deny", "warn", `RFID ${uid} at bin ${binId}: no collector is assigned right now`, { binId, uid });
    announce(`bin:${binId}`, "No collection booked. Lid stays locked.", "alert");
    return { allow: false, action: "deny", tagHash, reason: "no accepted job for this bin" };
  }
  const collector = await chain().getCollector(BigInt(job.collectorId));
  if (collector.tagHash.toLowerCase() !== tagHash.toLowerCase()) {
    emit("rfid:deny", "danger", `RFID ${uid} is NOT collector ${job.collectorId}'s tag; lid stays locked`, {
      binId,
      uid,
      jobId: job.jobId,
    });
    announce(`bin:${binId}`, "Unauthorised tag. Lid locked.", "alert");
    return { allow: false, action: "deny", tagHash, jobId: job.jobId, reason: "tag does not match assigned collector" };
  }
  emit("rfid:allow", "success", `Collector ${job.collectorId} verified by RFID at bin ${binId}; lid unlocked`, {
    binId,
    jobId: job.jobId,
  });
  announce(`bin:${binId}`, "Collector verified. Lid unlocked.", "ok");
  return { allow: true, action: "unlock", tagHash, jobId: job.jobId };
}

// =========================================================================
// 4. Signed measurements arrive from both machines
// =========================================================================

export async function submitEvidence(
  binId: bigint,
  body: {
    jobId: string | number;
    tagHash?: string;
    tagUid?: string;
    fillBefore: number;
    fillAfter: number;
    serviceStart: number;
    serviceEnd: number;
    samples: string;
    rawDataHash?: string;
    signature?: string;
  },
): Promise<JobRecord> {
  const jobId = String(body.jobId);
  const job = state.jobs[jobId];
  if (!job) throw new WorkflowError(`Unknown job #${jobId}`, 404);
  if (job.binId !== String(binId)) throw new WorkflowError(`Job #${jobId} belongs to bin ${job.binId}`, 403);
  if (typeof body.samples !== "string") throw new WorkflowError("samples (CSV string) is required");

  const tagHash = body.tagHash ?? (body.tagUid ? rfidTagHash(body.tagUid) : null);
  if (!tagHash) throw new WorkflowError("tagHash or tagUid is required");
  const evidence: ServiceEvidence = {
    jobId: BigInt(jobId),
    binId,
    tagHash,
    fillBefore: BigInt(Math.round(body.fillBefore)),
    fillAfter: BigInt(Math.round(body.fillAfter)),
    serviceStart: BigInt(body.serviceStart),
    serviceEnd: BigInt(body.serviceEnd),
    // In device mode the ESP32 signs its own hash of the log; a mismatch with
    // the uploaded log is caught (and rejected) during verification.
    rawDataHash: body.rawDataHash ?? rawDataHash(body.samples),
  };

  const bin = await chain().getBin(binId);
  let sig: string;
  try {
    sig = await machineSignature("bin", "ServiceEvidence", evidence, body.signature, bin.device);
  } catch (err) {
    if (!(err instanceof WorkflowError) || err.status !== 401 || !body.signature) throw err;
    // Keep the forged evidence: it gets rejected on-chain with a public reason.
    sig = body.signature;
    emit("evidence:forged", "danger", `Evidence for job #${jobId} is NOT signed by bin ${binId}'s device key`, { jobId });
  }

  const updated = upsertJob(jobId, { evidence: toJson(evidence), evidenceSig: sig, binCsv: body.samples });
  emit("evidence:received", "info", `Bin ${binId} signed its measurements: ${body.fillBefore}% → ${body.fillAfter}%`, {
    jobId,
  });
  scheduleVerification(jobId);
  return updated;
}

export async function submitClaim(
  collectorId: bigint,
  body: {
    jobId: string | number;
    hopperBefore: number;
    hopperAfter: number;
    samples: string;
    rawDataHash?: string;
    signature?: string;
  },
): Promise<JobRecord> {
  const jobId = String(body.jobId);
  const job = state.jobs[jobId];
  if (!job) throw new WorkflowError(`Unknown job #${jobId}`, 404);
  if (job.collectorId !== String(collectorId)) throw new WorkflowError(`Job #${jobId} is not assigned to collector ${collectorId}`, 403);
  if (typeof body.samples !== "string") throw new WorkflowError("samples (CSV string) is required");

  const claim: CollectorClaim = {
    jobId: BigInt(jobId),
    collectorId,
    hopperBefore: BigInt(Math.round(body.hopperBefore)),
    hopperAfter: BigInt(Math.round(body.hopperAfter)),
    rawDataHash: body.rawDataHash ?? rawDataHash(body.samples),
  };
  const collector = await chain().getCollector(collectorId);
  let sig: string;
  try {
    sig = await machineSignature("collector", "CollectorClaim", claim, body.signature, collector.device);
  } catch (err) {
    if (!(err instanceof WorkflowError) || err.status !== 401 || !body.signature) throw err;
    sig = body.signature;
    emit("claim:forged", "danger", `Claim for job #${jobId} is NOT signed by collector ${collectorId}'s device key`, { jobId });
  }
  const updated = upsertJob(jobId, { claim: toJson(claim), claimSig: sig, collectorCsv: body.samples });
  emit("claim:received", "info", `Collector ${collectorId} signed its hopper reading: ${body.hopperBefore}% → ${body.hopperAfter}%`, {
    jobId,
  });
  scheduleVerification(jobId);
  return updated;
}

const pendingVerification = new Map<string, NodeJS.Timeout>();
const verifying = new Set<string>();

/** Verify as soon as both sides reported, or after CLAIM_WAIT_MS with whatever arrived. */
function scheduleVerification(jobId: string) {
  const job = state.jobs[jobId];
  if (!job?.evidence) return;
  const existing = pendingVerification.get(jobId);
  if (existing) clearTimeout(existing);
  const delay = job.claim ? 50 : config.server.claimWaitMs;
  pendingVerification.set(
    jobId,
    setTimeout(() => {
      pendingVerification.delete(jobId);
      verifyJob(jobId).catch((err) => emit("verify:error", "danger", `Verification of job #${jobId} failed: ${err.message}`));
    }, delay),
  );
}

// =========================================================================
// 5. Verify: deterministic rules + AI verifier -> Guardian decision
// =========================================================================

export async function verifyJob(jobId: string) {
  const job = state.jobs[jobId];
  if (!job?.evidence) throw new WorkflowError(`Job #${jobId} has no bin evidence yet`, 409);
  if (verifying.has(jobId)) return;
  verifying.add(jobId);
  try {
    return await verifyInner(job);
  } finally {
    verifying.delete(jobId);
  }
}

async function verifyInner(job: JobRecord) {
  const c = chain();
  const jobId = job.jobId;
  upsertJob(jobId, { status: "Verifying" });
  emit("verify:start", "info", `Guardian is verifying job #${jobId}`, { jobId });

  const onchain = await c.getJob(BigInt(jobId));
  const [ward, collector, bin, now] = await Promise.all([
    c.getWard(onchain.wardId),
    c.getCollector(onchain.collectorId),
    c.getBin(onchain.binId),
    chainNow(),
  ]);

  const evidence = fromEvidenceJson(job.evidence!);
  const evidenceDigest = typedDigest(c.domain, "ServiceEvidence", evidence);
  const binSig = normaliseDeviceSignature(evidenceDigest, job.evidenceSig ?? "0x", bin.device);
  let binSamples: BinSample[] = [];
  let binLogOk = rawDataHash(job.binCsv ?? "") === evidence.rawDataHash;
  try {
    binSamples = parseBinCsv(job.binCsv ?? "");
  } catch {
    binLogOk = false;
  }

  const claim = job.claim ? fromClaimJson(job.claim) : null;
  const claimDigest = claim ? typedDigest(c.domain, "CollectorClaim", claim) : ethers.ZeroHash;
  const claimSig = claim ? normaliseDeviceSignature(claimDigest, job.claimSig ?? "0x", collector.device) : null;
  let collectorSamples: CollectorSample[] | null = null;
  let collectorLogOk = !!claim && rawDataHash(job.collectorCsv ?? "") === claim.rawDataHash;
  if (claim) {
    try {
      collectorSamples = parseCollectorCsv(job.collectorCsv ?? "");
    } catch {
      collectorLogOk = false;
    }
  }

  const fillBefore = Number(evidence.fillBefore);
  const fillAfter = Number(evidence.fillAfter);
  const payout = await c.quotePayout(onchain.wardId, BigInt(Math.max(0, fillBefore - fillAfter)));
  const today = now - (now % 86400);
  const spent = ward.dayStart === today ? ward.spentToday : 0n;
  const dailyRemaining = ward.policy.dailyCap > spent ? ward.policy.dailyCap - spent : 0n;
  const jobsLastHour = jobsForBinSince(job.binId, nowSec() - 3600);

  const checks = deterministicChecks({
    jobStatus: onchain.status,
    now,
    deadline: onchain.deadline,
    acceptedAt: onchain.acceptedAt,
    evidence: {
      tagHash: evidence.tagHash,
      fillBefore,
      fillAfter,
      serviceStart: Number(evidence.serviceStart),
      serviceEnd: Number(evidence.serviceEnd),
    },
    binSignatureOk: !!binSig,
    binLogOk,
    claim: claim ? { hopperBefore: Number(claim.hopperBefore), hopperAfter: Number(claim.hopperAfter) } : null,
    collectorSignatureOk: !!claimSig,
    collectorLogOk,
    collectorTagHash: collector.tagHash,
    collectorActive: collector.active,
    binSamples,
    minFillDelta: ward.policy.minFillDelta,
    payout,
    maxPayoutPerJob: ward.policy.maxPayoutPerJob,
    dailyRemaining,
    wardBalance: ward.balance,
    jobsForBinLastHour: jobsLastHour,
  });
  const failed = checks.filter((x) => !x.pass);
  emit(
    "guardian:rules",
    failed.length ? "danger" : "success",
    failed.length
      ? `Deterministic rules FAILED: ${failed.map((x) => x.id).join(", ")}`
      : `All ${checks.length} deterministic rules passed`,
    { jobId, checks },
  );

  const features = extractFeatures({
    fillAtHire: job.fillAtHire,
    fillBefore,
    fillAfter,
    serviceStart: Number(evidence.serviceStart),
    serviceEnd: Number(evidence.serviceEnd),
    acceptedAt: onchain.acceptedAt,
    binSamples,
    collectorSamples,
    hopperBefore: claim ? Number(claim.hopperBefore) : null,
    hopperAfter: claim ? Number(claim.hopperAfter) : null,
    binLitres: config.registry.binLitres,
    hopperLitres: config.registry.hopperLitres,
    jobsForBinLastHour: jobsLastHour,
    collectorCompleted: collector.completedJobs,
    collectorRejected: collector.rejectedJobs,
  });

  emit("ai:start", "info", `AI verifier (${config.verifier.mode}) is reading the sensor story`, { jobId });
  const { primary: ai, baseline } = await runVerifier({
    jobId,
    features,
    binSeries: downsample(binSamples),
    collectorSeries: collectorSamples ? downsample(collectorSamples) : null,
  });
  emit(
    "ai:result",
    !ai.available ? "warn" : ai.verdict === "APPROVE" ? "success" : ai.verdict === "HOLD" ? "warn" : "danger",
    ai.available
      ? `AI verdict ${ai.verdict} (confidence ${ai.confidence})${ai.flags.length ? `: ${ai.flags.join(", ")}` : ""}`
      : `AI verifier unavailable: ${ai.error}`,
    { jobId, ai },
  );

  const decision = decide(checks, ai, payout, ward.policy.minConfidence);
  const report = {
    kind: "civicproof.verification.v1",
    network: config.network,
    contract: c.deployment.address,
    jobId,
    binId: job.binId,
    collectorId: String(onchain.collectorId),
    evidence: job.evidence,
    evidenceDigest,
    claim: job.claim ?? null,
    claimDigest: claim ? claimDigest : null,
    checks,
    features,
    verifier: ai,
    baseline: config.verifier.mode === "heuristic" ? undefined : baseline,
    decision,
    payoutWei: payout.toString(),
    decidedAt: new Date().toISOString(),
  };
  const { hash: reportHash } = saveReport(report);
  emit(
    "guardian:decision",
    decision.action === "SETTLE" ? "success" : "danger",
    decision.headline,
    { jobId, decision, reportHash, payoutWei: payout.toString(), checks, ai },
  );

  if (decision.action === "SETTLE") {
    return settleJob(job, evidence, binSig!, claim!, claimSig!, payout, decision, reportHash);
  }
  if (decision.action === "REJECT") {
    return rejectOnChain(jobId, decision.reasonCode, reportHash, decision.headline);
  }
  // HOLD: stays escrowed until a human reviewer decides or the window expires.
  upsertJob(jobId, { status: "Held", reportHash, headline: decision.headline, payoutWei: payout.toString() });
  announce(`bin:${job.binId}`, "Payment held for review.", "alert");
  announce(`collector:${onchain.collectorId}`, "Payment held for review.", "alert");
  const tamper = ai.flags.some((f) => ["STEP_ACCUMULATION", "INSTANT_EMPTYING", "DROP_WITH_LID_CLOSED"].includes(f));
  if (ai.flags.includes("POSSIBLE_ILLEGAL_DUMPING")) {
    await recordIncident(INCIDENT.ILLEGAL_DUMPING_SUSPECTED, jobId, `Job #${jobId}: bin emptied but waste did not reach the collector`, { reportHash });
  } else if (tamper) {
    await recordIncident(INCIDENT.SENSOR_TAMPER_SUSPECTED, jobId, `Job #${jobId}: sensor pattern looks staged (${ai.flags.join(", ")})`, { reportHash });
  }
  return { action: "HOLD", decision, reportHash };
}

async function settleJob(
  job: JobRecord,
  evidence: ServiceEvidence,
  binSig: string,
  claim: CollectorClaim,
  collectorSig: string,
  payout: bigint,
  decision: Decision,
  reportHash: string,
) {
  const c = chain();
  if (!c.guardian) throw new WorkflowError("GUARDIAN_PRIVATE_KEY is not set", 500);
  const approval = {
    jobId: evidence.jobId,
    evidenceDigest: typedDigest(c.domain, "ServiceEvidence", evidence),
    claimDigest: typedDigest(c.domain, "CollectorClaim", claim),
    payout,
    confidence: BigInt(decision.confidence),
    reportHash,
  };
  const guardianSig = await signTyped(c.guardian, c.domain, "GuardianApproval", approval);
  const bundle = { evidence, binSig, claim, collectorSig, approval, guardianSig };

  let tx: TxResult;
  try {
    tx = await c.send("settle", [bundle], { label: `settle job #${job.jobId}` });
  } catch (err) {
    const reason = err instanceof ChainRevert ? err.reason : (err as Error).message;
    upsertJob(job.jobId, { status: "Held", reportHash, headline: `Contract refused settlement: ${reason}` });
    emit("job:settle-refused", "danger", `Contract refused to pay job #${job.jobId}: ${reason}`, { jobId: job.jobId });
    return { action: "HOLD", decision, reportHash, contractRefused: reason };
  }
  const settled = tx.events.find((e) => e.name === "JobSettled");
  addTx(job.jobId, txRef("settle", tx));
  upsertJob(job.jobId, {
    status: "Settled",
    reportHash,
    headline: decision.headline,
    payoutWei: payout.toString(),
    settlement: JSON.parse(JSON.stringify(bundle, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
  });
  emit("job:settled", "success", `PAID ${mstc(payout)} to collector wallet ${settled?.args.payout} for job #${job.jobId}`, {
    jobId: job.jobId,
    tx,
    payoutWei: payout.toString(),
  });
  announce(`bin:${job.binId}`, `Verified. Paid ${ethers.formatEther(payout)} MSTC.`, "ok");
  announce(`collector:${claim.collectorId}`, `Payment received: ${ethers.formatEther(payout)} MSTC.`, "ok");
  return { action: "SETTLE", decision, reportHash, tx };
}

async function rejectOnChain(jobId: string, reasonCode: number, reportHash: string, headline: string) {
  let tx: TxResult;
  try {
    tx = await chain().send("rejectJob", [BigInt(jobId), reasonCode, reportHash], {
      label: `rejectJob #${jobId} (${nameOf(REASON, reasonCode)})`,
    });
  } catch (err) {
    wrapRevert(err);
  }
  addTx(jobId, txRef("rejectJob", tx));
  const job = upsertJob(jobId, { status: "Rejected", reportHash, headline });
  emit("job:rejected", "danger", `Job #${jobId} rejected on-chain: ${nameOf(REASON, reasonCode)}. No payment.`, {
    jobId,
    tx,
    reasonCode,
  });
  announce(`bin:${job.binId}`, "Payment blocked. Evidence failed.", "alert");
  if (job.collectorId) announce(`collector:${job.collectorId}`, "Payment blocked.", "alert");
  return { action: "REJECT", reasonCode, reportHash, tx };
}

// =========================================================================
// 6. Human review for HELD jobs
// =========================================================================

export async function review(jobId: string, approve: boolean, reviewer: string, note: string) {
  const job = state.jobs[jobId];
  if (!job) throw new WorkflowError(`Unknown job #${jobId}`, 404);
  if (job.status !== "Held") throw new WorkflowError(`Job #${jobId} is ${job.status}, not Held`, 409);
  const previous = job.reportHash ? readReport(job.reportHash) : null;
  const humanReview = { reviewer: reviewer || "city-officer", note: note || "", approved: approve, at: new Date().toISOString() };
  const { hash: reportHash } = saveReport({ kind: "civicproof.review.v1", previousReportHash: job.reportHash, previous, humanReview });
  emit("review", approve ? "warn" : "info", `${humanReview.reviewer} ${approve ? "APPROVED" : "REJECTED"} held job #${jobId}`, {
    jobId,
    humanReview,
    reportHash,
  });

  if (!approve) return rejectOnChain(jobId, REASON.HUMAN_REJECTED, reportHash, `Rejected by ${humanReview.reviewer}`);

  const c = chain();
  const evidence = fromEvidenceJson(job.evidence!);
  const claim = fromClaimJson(job.claim!);
  const [bin, collector] = await Promise.all([c.getBin(evidence.binId), c.getCollector(claim.collectorId)]);
  const binSig = normaliseDeviceSignature(typedDigest(c.domain, "ServiceEvidence", evidence), job.evidenceSig!, bin.device);
  const claimSig = normaliseDeviceSignature(typedDigest(c.domain, "CollectorClaim", claim), job.claimSig!, collector.device);
  if (!binSig || !claimSig) throw new WorkflowError("Machine signatures are invalid; a human cannot override that", 409);
  const payout = BigInt(job.payoutWei ?? "0");
  const decision: Decision = {
    action: "SETTLE",
    reasonCode: 0,
    headline: `Approved by ${humanReview.reviewer} after AI hold`,
    reasons: [humanReview.note],
    confidence: 100,
    decidedBy: "rules+ai",
  };
  return settleJob(job, evidence, binSig, claim, claimSig, payout, decision, reportHash);
}

// =========================================================================
// 7. Incidents, emergency stop, replay, expiry
// =========================================================================

export async function recordIncident(kind: number, jobId: string | null, summary: string, details: unknown) {
  const { hash } = saveReport({ kind: "civicproof.incident.v1", incident: nameOf(INCIDENT, kind), jobId, summary, details, at: new Date().toISOString() });
  const incident = {
    id: String(state.incidents.length + 1),
    kind: nameOf(INCIDENT, kind),
    jobId,
    summary,
    detailsHash: hash,
    at: new Date().toISOString(),
  } as (typeof state.incidents)[number];
  state.incidents.push(incident);
  if (config.server.logIncidentsOnchain) {
    try {
      const tx = await chain().send("recordIncident", [kind, BigInt(jobId ?? 0), hash], {
        label: `recordIncident ${incident.kind}`,
      });
      incident.tx = txRef("recordIncident", tx);
    } catch (err) {
      emit("incident:error", "warn", `Could not log incident on-chain: ${(err as Error).message}`);
    }
  }
  emit("incident", "danger", `INCIDENT ${incident.kind}: ${summary}`, incident);
  return incident;
}

export async function emergencyStop(source: string) {
  const c = chain();
  if (!c.admin) throw new WorkflowError("ADMIN_PRIVATE_KEY is required for emergency stop", 500);
  const tx = await c.send("pause", [], { signer: c.admin, label: "EMERGENCY STOP" });
  emit("emergency", "danger", `EMERGENCY STOP by ${source}: all machine payments frozen on-chain`, { tx });
  await recordIncident(INCIDENT.EMERGENCY_STOP, null, `Emergency stop triggered by ${source}`, { tx: tx.hash });
  return { tx };
}

export async function resume(source: string) {
  const c = chain();
  if (!c.admin) throw new WorkflowError("ADMIN_PRIVATE_KEY is required to resume", 500);
  const tx = await c.send("unpause", [], { signer: c.admin, label: "resume payments" });
  emit("emergency", "success", `Payments resumed by ${source}`, { tx });
  return { tx };
}

/** Re-submits an already-paid settlement bundle. The contract must refuse. */
export async function replayLastSettlement() {
  const job = Object.values(state.jobs)
    .filter((j) => j.status === "Settled" && j.settlement)
    .sort((a, b) => Number(b.jobId) - Number(a.jobId))[0];
  if (!job) throw new WorkflowError("No settled job to replay yet. Run the normal scenario first.", 409);
  emit("attack:replay", "warn", `Attacker re-submits the signed settlement for job #${job.jobId} to get paid twice`, {
    jobId: job.jobId,
  });
  const reason = await chain().preflight("settle", [job.settlement]);
  if (!reason) throw new WorkflowError("Replay would succeed. This should never happen.", 500);
  emit("attack:replay-blocked", "success", `Contract refused the replay: ${reason}`, { jobId: job.jobId, reason });
  const incident = await recordIncident(INCIDENT.REPLAY_ATTEMPT, job.jobId, `Replay of job #${job.jobId} settlement refused (${reason})`, {
    reason,
  });
  return { jobId: job.jobId, blocked: true, reason, incident };
}

export async function expireOverdue() {
  const c = chain();
  const now = await chainNow();
  for (const job of Object.values(state.jobs)) {
    if (!["Accepted", "Held"].includes(job.status) || !job.deadline || job.deadline >= now) continue;
    try {
      const tx = await c.send("expireJob", [BigInt(job.jobId)], { label: `expireJob #${job.jobId}` });
      addTx(job.jobId, txRef("expireJob", tx));
      upsertJob(job.jobId, { status: "Expired", headline: "Service window closed. Nobody can be paid for this job." });
      emit("job:expired", "warn", `Job #${job.jobId} expired; escrow released, no payment`, { jobId: job.jobId });
    } catch (err) {
      const onchain = await c.getJob(BigInt(job.jobId)).catch(() => null);
      if (onchain && onchain.status !== "Accepted") upsertJob(job.jobId, { status: onchain.status as JobRecord["status"] });
    }
  }
}

// =========================================================================
// JSON <-> struct helpers
// =========================================================================

function toJson<T extends Record<string, unknown>>(v: T): any {
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === "bigint" ? x.toString() : x]));
}

function fromEvidenceJson(e: EvidenceJson): ServiceEvidence {
  return {
    jobId: BigInt(e.jobId),
    binId: BigInt(e.binId),
    tagHash: e.tagHash,
    fillBefore: BigInt(e.fillBefore),
    fillAfter: BigInt(e.fillAfter),
    serviceStart: BigInt(e.serviceStart),
    serviceEnd: BigInt(e.serviceEnd),
    rawDataHash: e.rawDataHash,
  };
}

function fromClaimJson(c: ClaimJson): CollectorClaim {
  return {
    jobId: BigInt(c.jobId),
    collectorId: BigInt(c.collectorId),
    hopperBefore: BigInt(c.hopperBefore),
    hopperAfter: BigInt(c.hopperAfter),
    rawDataHash: c.rawDataHash,
  };
}
