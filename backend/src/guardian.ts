import { ethers } from "ethers";
import { config } from "./config";
import type { BinSample } from "./samples";
import type { VerifierResult } from "./verifier";

/** uint8 reason codes written on-chain by rejectJob(). */
export const REASON = {
  BAD_SIGNATURE: 1,
  LOG_TAMPERED: 2,
  RFID_MISMATCH: 3,
  INSUFFICIENT_WORK: 4,
  HOPPER_NOT_FILLED: 5,
  LID_NEVER_OPENED: 6,
  BAD_TIMING: 7,
  BUDGET_OR_CAP: 8,
  AI_VETO: 9,
  HUMAN_REJECTED: 10,
  RATE_LIMITED: 11,
  JOB_STATE: 12,
  NO_COLLECTOR_CLAIM: 13,
} as const;

/** uint8 kinds written on-chain by recordIncident(). */
export const INCIDENT = {
  UNAUTHORIZED_PAYMENT_INTENT: 1,
  SENSOR_TAMPER_SUSPECTED: 2,
  REPLAY_ATTEMPT: 3,
  RFID_MISMATCH: 4,
  GHOST_SERVICE: 5,
  FORGED_SIGNATURE: 6,
  EMERGENCY_STOP: 7,
  ILLEGAL_DUMPING_SUSPECTED: 8,
} as const;

export const nameOf = (table: Record<string, number>, code: number) =>
  Object.entries(table).find(([, v]) => v === code)?.[0] ?? `CODE_${code}`;

export type Check = { id: string; label: string; pass: boolean; detail: string; reasonCode: number };

/** How each failed rule reads on the dashboard / speaker. */
const FAIL_TEXT: Record<string, string> = {
  JOB_ACCEPTED: "job is not awaiting payment",
  WITHIN_DEADLINE: "service window has closed",
  BIN_SIGNATURE: "evidence was not signed by the bin",
  BIN_LOG_INTEGRITY: "bin sensor log was altered",
  COLLECTOR_CLAIM: "collector sent no signed hopper reading",
  COLLECTOR_SIGNATURE: "claim was not signed by the collector",
  COLLECTOR_LOG_INTEGRITY: "collector sensor log was altered",
  HOPPER_FILLED: "collector hopper gained nothing",
  PAYEE_REGISTERED: "contractor is not active in the registry",
  RFID_MATCH: "wrong RFID tag at the bin",
  MIN_WORK: "bin was not actually emptied",
  LID_OPENED: "lid never opened",
  SERVICE_TIMING: "implausible service timing",
  PER_JOB_CAP: "payout above per-job cap",
  DAILY_CAP: "ward daily cap reached",
  BUDGET: "ward budget exhausted",
  RATE_LIMIT: "bin is hiring suspiciously often",
};

export type GuardianInput = {
  jobStatus: string;
  now: number;
  deadline: number;
  acceptedAt: number;
  evidence: { tagHash: string; fillBefore: number; fillAfter: number; serviceStart: number; serviceEnd: number };
  binSignatureOk: boolean;
  binLogOk: boolean;
  claim: { hopperBefore: number; hopperAfter: number } | null;
  collectorSignatureOk: boolean;
  collectorLogOk: boolean;
  collectorTagHash: string;
  collectorActive: boolean;
  binSamples: BinSample[];
  minFillDelta: number;
  payout: bigint;
  maxPayoutPerJob: bigint;
  dailyRemaining: bigint;
  wardBalance: bigint;
  jobsForBinLastHour: number;
};

const mstc = (wei: bigint) => `${ethers.formatEther(wei)} MSTC`;

/**
 * Deterministic, explainable, non-negotiable. These mirror (and extend) what
 * the contract enforces, so a job that fails here never costs gas, and every
 * failure has a precise, reproducible reason.
 */
export function deterministicChecks(i: GuardianInput): Check[] {
  const c: Check[] = [];
  const add = (id: string, label: string, pass: boolean, detail: string, reasonCode: number) =>
    c.push({ id, label, pass, detail, reasonCode });

  add("JOB_ACCEPTED", "Job is accepted and unpaid", i.jobStatus === "Accepted", `on-chain status: ${i.jobStatus}`, REASON.JOB_STATE);
  add(
    "WITHIN_DEADLINE",
    "Service window still open",
    i.now <= i.deadline,
    `deadline ${new Date(i.deadline * 1000).toISOString()}`,
    REASON.BAD_TIMING,
  );
  add("BIN_SIGNATURE", "Evidence signed by the registered bin", i.binSignatureOk, i.binSignatureOk ? "valid" : "signature does not recover to the bin's device key", REASON.BAD_SIGNATURE);
  add("BIN_LOG_INTEGRITY", "Bin sensor log matches the signed hash", i.binLogOk, i.binLogOk ? "keccak256 matches" : "uploaded log differs from what the bin signed", REASON.LOG_TAMPERED);
  add("COLLECTOR_CLAIM", "Collector submitted a signed hopper reading", i.claim !== null, i.claim ? "present" : "missing", REASON.NO_COLLECTOR_CLAIM);
  if (i.claim) {
    add("COLLECTOR_SIGNATURE", "Claim signed by the registered collector", i.collectorSignatureOk, i.collectorSignatureOk ? "valid" : "signature does not recover to the collector's device key", REASON.BAD_SIGNATURE);
    add("COLLECTOR_LOG_INTEGRITY", "Collector log matches the signed hash", i.collectorLogOk, i.collectorLogOk ? "keccak256 matches" : "uploaded log differs from what the collector signed", REASON.LOG_TAMPERED);
    add(
      "HOPPER_FILLED",
      "Collector hopper actually gained waste",
      i.claim.hopperAfter > i.claim.hopperBefore,
      `${i.claim.hopperBefore}% → ${i.claim.hopperAfter}%`,
      REASON.HOPPER_NOT_FILLED,
    );
  }
  add("PAYEE_REGISTERED", "Payee is the city-registered contractor wallet", i.collectorActive, "payee is read from the on-chain registry, never from a request", REASON.JOB_STATE);
  add(
    "RFID_MATCH",
    "RFID tag at the bin = assigned collector",
    i.evidence.tagHash.toLowerCase() === i.collectorTagHash.toLowerCase(),
    i.evidence.tagHash.toLowerCase() === i.collectorTagHash.toLowerCase() ? "tag matches" : "a different tag was presented",
    REASON.RFID_MISMATCH,
  );
  const delta = i.evidence.fillBefore - i.evidence.fillAfter;
  add(
    "MIN_WORK",
    `Bin emptied by at least ${i.minFillDelta} points`,
    delta >= i.minFillDelta,
    `${i.evidence.fillBefore}% → ${i.evidence.fillAfter}% (Δ ${delta})`,
    REASON.INSUFFICIENT_WORK,
  );
  const inService = i.binSamples.filter((s) => s.t >= i.evidence.serviceStart && s.t <= i.evidence.serviceEnd);
  const lidOpened = inService.some((s) => s.lid === 1);
  add("LID_OPENED", "Lid opened during the service", lidOpened, lidOpened ? "lid sensor saw it open" : "lid stayed closed", REASON.LID_NEVER_OPENED);
  const dur = i.evidence.serviceEnd - i.evidence.serviceStart;
  add(
    "SERVICE_TIMING",
    "Service happened after acceptance, plausible duration",
    dur >= config.guardian.minServiceSec &&
      dur <= config.guardian.maxServiceSec &&
      i.evidence.serviceStart + 300 >= i.acceptedAt,
    `${dur}s, started ${i.evidence.serviceStart - i.acceptedAt}s after acceptance`,
    REASON.BAD_TIMING,
  );
  add("PER_JOB_CAP", "Payout within per-job cap", i.payout <= i.maxPayoutPerJob, `${mstc(i.payout)} ≤ ${mstc(i.maxPayoutPerJob)}`, REASON.BUDGET_OR_CAP);
  add("DAILY_CAP", "Ward daily cap not exceeded", i.payout <= i.dailyRemaining, `${mstc(i.dailyRemaining)} left today`, REASON.BUDGET_OR_CAP);
  add("BUDGET", "Ward budget covers the payout", i.payout <= i.wardBalance, `ward holds ${mstc(i.wardBalance)} (escrow reserved on accept)`, REASON.BUDGET_OR_CAP);
  add(
    "RATE_LIMIT",
    "Bin is not hiring suspiciously often",
    i.jobsForBinLastHour <= config.guardian.maxJobsPerBinPerHour,
    `${i.jobsForBinLastHour} jobs in the last hour (max ${config.guardian.maxJobsPerBinPerHour})`,
    REASON.RATE_LIMITED,
  );
  return c;
}

export type Decision = {
  action: "SETTLE" | "REJECT" | "HOLD";
  reasonCode: number;
  headline: string;
  reasons: string[];
  confidence: number; // what the Guardian will attest on-chain if it settles
  decidedBy: "rules" | "rules+ai" | "rules-only (AI unavailable)";
};

/**
 * The decision matrix. The AI can make the outcome stricter, never looser:
 *
 *   rules FAIL                       -> REJECT (on-chain, with reason code)
 *   rules PASS + AI APPROVE ≥ min     -> SETTLE
 *   rules PASS + AI HOLD / low conf   -> HOLD for a human
 *   rules PASS + AI REJECT            -> HOLD ("blocked by AI veto"), human decides
 *   rules PASS + AI unavailable       -> HOLD (or rules-only settle for tiny payouts, if the city opted in)
 */
export function decide(checks: Check[], ai: VerifierResult, payout: bigint, minConfidence: number): Decision {
  const failed = checks.filter((c) => !c.pass);
  if (failed.length) {
    return {
      action: "REJECT",
      reasonCode: failed[0].reasonCode,
      headline: `PAYMENT BLOCKED: ${failed.map((c) => FAIL_TEXT[c.id] ?? c.label).join(" + ")}`,
      reasons: failed.map((c) => `${c.label}: ${c.detail}`),
      confidence: 0,
      decidedBy: "rules",
    };
  }
  if (!ai.available) {
    const small = payout <= ethers.parseEther(config.guardian.smallPayoutMstc);
    if (config.guardian.aiFailureMode === "rules" && small) {
      return {
        action: "SETTLE",
        reasonCode: 0,
        headline: "Rules passed; AI unavailable; small payout settled under rules-only policy",
        reasons: [`Verifier error: ${ai.error ?? "unavailable"}`],
        confidence: minConfidence,
        decidedBy: "rules-only (AI unavailable)",
      };
    }
    return {
      action: "HOLD",
      reasonCode: REASON.AI_VETO,
      headline: "HELD: AI verifier unavailable, needs human review",
      reasons: [`Verifier error: ${ai.error ?? "unavailable"}`],
      confidence: 0,
      decidedBy: "rules+ai",
    };
  }
  if (ai.verdict === "REJECT") {
    return {
      action: "HOLD",
      reasonCode: REASON.AI_VETO,
      headline: `PAYMENT BLOCKED by AI veto (${ai.flags.join(", ") || "implausible evidence"}); rules passed, human review required`,
      reasons: ai.reasons,
      confidence: ai.confidence,
      decidedBy: "rules+ai",
    };
  }
  if (ai.verdict === "HOLD" || ai.confidence < minConfidence) {
    return {
      action: "HOLD",
      reasonCode: REASON.AI_VETO,
      headline: `HELD: AI confidence ${ai.confidence} < ${minConfidence}, needs human review`,
      reasons: ai.reasons,
      confidence: ai.confidence,
      decidedBy: "rules+ai",
    };
  }
  return {
    action: "SETTLE",
    reasonCode: 0,
    headline: `VERIFIED: rules passed and AI confidence ${ai.confidence}`,
    reasons: ai.reasons,
    confidence: ai.confidence,
    decidedBy: "rules+ai",
  };
}

// -------------------------------------------------------------------------
// AI-agent payment intents (the prompt-injection surface)
// -------------------------------------------------------------------------

export type PaymentIntent = {
  action: "PAY" | "REPORT_BIN" | "QUERY" | "OTHER";
  to: string | null;
  amountMstc: number | null;
  jobId: string | null;
  summary: string;
};

export function evaluatePaymentIntent(
  intent: PaymentIntent,
  ctx: { registeredPayouts: string[]; maxPayoutPerJob: bigint; jobIsVerifiable: boolean },
): { allowed: false; checks: Check[]; headline: string } {
  const checks: Check[] = [];
  const add = (id: string, label: string, pass: boolean, detail: string) =>
    checks.push({ id, label, pass, detail, reasonCode: 0 });

  add(
    "AGENT_AUTHORITY",
    "Assistant has payment authority",
    false,
    "by design: the assistant holds no key, and the contract has no transfer(to, amount) function",
  );
  const registered = !!intent.to && ctx.registeredPayouts.some((a) => a.toLowerCase() === intent.to!.toLowerCase());
  add("RECIPIENT_REGISTERED", "Recipient is a registered city contractor", registered, intent.to ? `${intent.to}` : "no recipient");
  const amountWei = intent.amountMstc !== null ? ethers.parseEther(String(intent.amountMstc)) : null;
  add(
    "AMOUNT_WITHIN_CAP",
    "Amount within the per-job cap",
    amountWei !== null && amountWei <= ctx.maxPayoutPerJob,
    amountWei !== null
      ? `${intent.amountMstc} MSTC vs cap ${ethers.formatEther(ctx.maxPayoutPerJob)} MSTC`
      : "no amount",
  );
  add(
    "DEVICE_EVIDENCE",
    "Backed by device-signed service evidence",
    ctx.jobIsVerifiable,
    ctx.jobIsVerifiable ? "a job exists; it settles on its own once verified" : "no machine evidence behind this request",
  );
  const why: Record<string, string> = {
    AGENT_AUTHORITY: "AI assistant has no payment authority",
    RECIPIENT_REGISTERED: "recipient is not a registered contractor",
    AMOUNT_WITHIN_CAP: "amount exceeds the per-job cap",
    DEVICE_EVIDENCE: "no machine-signed evidence",
  };
  const failed = checks.filter((c) => !c.pass).map((c) => why[c.id]);
  return { allowed: false, checks, headline: `PAYMENT BLOCKED: ${failed.join(" + ")}` };
}
