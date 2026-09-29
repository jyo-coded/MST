/**
 * Shared workflow definitions. The server enforces these transitions and the
 * web app renders them, so both always agree on what a state means.
 */

export type Tone = "neutral" | "info" | "progress" | "warning" | "success" | "danger";

// ---------------------------------------------------------------------------
// Lifecycle (the product storyline). onChain = recorded on MST Blockchain.
// ---------------------------------------------------------------------------

export const LIFECYCLE = [
  { key: "BIN_REGISTERED", label: "Bin registered", short: "Registered", onChain: true },
  { key: "BIN_FULL_DETECTED", label: "Bin full detected", short: "Full detected", onChain: false },
  { key: "AI_FULLNESS_VERIFIED", label: "AI verified fullness", short: "AI verified", onChain: false },
  { key: "COLLECTION_REQUEST_CREATED", label: "Collection request recorded", short: "Request on-chain", onChain: true },
  { key: "MUNICIPAL_APPROVAL", label: "Municipality approved request", short: "Approved", onChain: true },
  { key: "WORKER_ASSIGNED", label: "Worker assigned", short: "Assigned", onChain: true },
  { key: "WORKER_ARRIVED", label: "Worker arrived at bin", short: "Arrived", onChain: false },
  { key: "RFID_VERIFIED", label: "RFID identity verified", short: "RFID verified", onChain: true },
  { key: "COLLECTION_STARTED", label: "Lid unlocked, collection started", short: "Collecting", onChain: false },
  { key: "BIN_EMPTIED_DETECTED", label: "Bin emptied detected", short: "Emptied", onChain: false },
  { key: "AI_COMPLETION_VERIFIED", label: "AI verified collection", short: "AI re-verified", onChain: true },
  { key: "MUNICIPAL_COMPLETION_APPROVED", label: "Municipality approved completion", short: "Completion approved", onChain: true },
  { key: "PAYMENT_INITIATED", label: "Payment initiated", short: "Payment sent", onChain: false },
  { key: "PAYMENT_CONFIRMED", label: "Payment confirmed on MST", short: "Paid", onChain: true },
] as const;

export type LifecycleStage = (typeof LIFECYCLE)[number]["key"];

/** Events that sit outside the happy path but belong on the timeline. */
export const SIDE_EVENTS: Record<string, { label: string; tone: Tone }> = {
  THRESHOLD_CROSSED: { label: "Fill threshold crossed", tone: "warning" },
  AI_VERIFYING: { label: "AI verification started", tone: "info" },
  AI_REVERIFYING: { label: "AI re-verification started", tone: "info" },
  SERVO_UNLOCKED: { label: "Servo unlocked", tone: "info" },
  BIN_OFFLINE: { label: "Bin went offline", tone: "danger" },
  BIN_ONLINE: { label: "Bin back online", tone: "success" },
  CHAIN_ERROR: { label: "Blockchain transaction failed", tone: "danger" },
  AI_FULLNESS_REJECTED: { label: "AI rejected fullness reading", tone: "danger" },
  REQUEST_REJECTED: { label: "Request rejected", tone: "danger" },
  ASSIGNMENT_CANCELLED: { label: "Assignment cancelled", tone: "warning" },
  WORKER_EN_ROUTE: { label: "Worker en route", tone: "progress" },
  RFID_MISMATCH: { label: "RFID mismatch", tone: "danger" },
  RFID_REJECTED: { label: "RFID card refused", tone: "danger" },
  LID_OPENED: { label: "Lid opened", tone: "info" },
  LEVEL_DROPPING: { label: "Waste level dropping", tone: "progress" },
  LID_CLOSED: { label: "Lid closed and locked", tone: "info" },
  AI_COMPLETION_REJECTED: { label: "AI could not verify collection", tone: "danger" },
  INVESTIGATION_OPENED: { label: "Investigation opened", tone: "warning" },
  COMPLETION_REJECTED: { label: "Completion rejected", tone: "danger" },
  PAYMENT_FAILED: { label: "Payment failed", tone: "danger" },
  INCIDENT_RECORDED: { label: "Incident recorded on-chain", tone: "warning" },
  TRANSFER_STATION_VERIFIED: { label: "Transfer station / dump yard verified", tone: "progress" },
  CITIZEN_CHALLENGE_FILED: { label: "Citizen challenge filed", tone: "warning" },
  CHALLENGE_UPHELD: { label: "Challenge upheld by watcher", tone: "danger" },
  WORKER_STAKE_SLASHED: { label: "Worker stake slashed", tone: "danger" },
  SECOND_FACTOR_VERIFIED: { label: "Worker 2FA signed + proximity verified", tone: "success" },
  SECOND_FACTOR_FAILED: { label: "Worker 2FA failed / proximity out of bounds", tone: "danger" },
  JUDGE_WITNESS_ATTESTED: { label: "Judge witness attestation signed", tone: "info" },
  OFFLINE_QUEUE_FLUSHED: { label: "Offline telemetry queue synced", tone: "info" },
  INCIDENT_RECEIPT_COMMITTED: { label: "Tamper-proof incident receipt committed", tone: "warning" },
  ROBOT_M2M_SETTLED: { label: "Self-funding robot 4-wallet loop settled", tone: "success" },
};

export function stageLabel(stage: string): string {
  return LIFECYCLE.find((s) => s.key === stage)?.label ?? SIDE_EVENTS[stage]?.label ?? stage;
}

// ---------------------------------------------------------------------------
// State machines
// ---------------------------------------------------------------------------

type Machine<S extends string> = {
  states: readonly S[];
  labels: Record<S, string>;
  tones: Record<S, Tone>;
  transitions: Record<S, readonly S[]>;
};

function machine<S extends string>(m: Machine<S>) {
  return {
    ...m,
    can(from: S, to: S): boolean {
      return from === to || (m.transitions[from] ?? []).includes(to);
    },
  };
}

export const REQUEST = machine({
  states: [
    "DETECTED",
    "AI_VERIFIED",
    "AWAITING_APPROVAL",
    "APPROVED",
    "ASSIGNED",
    "EN_ROUTE",
    "COLLECTING",
    "REVERIFYING",
    "AWAITING_FINAL_APPROVAL",
    "COMPLETED",
    "REJECTED",
    "INVESTIGATION",
  ] as const,
  labels: {
    DETECTED: "Detected",
    AI_VERIFIED: "AI Verified",
    AWAITING_APPROVAL: "Awaiting Municipal Approval",
    APPROVED: "Approved",
    ASSIGNED: "Worker Assigned",
    EN_ROUTE: "Worker En Route",
    COLLECTING: "Collection Started",
    REVERIFYING: "AI Re-Verification",
    AWAITING_FINAL_APPROVAL: "Awaiting Final Approval",
    COMPLETED: "Completed",
    REJECTED: "Rejected",
    INVESTIGATION: "Investigation Required",
  },
  tones: {
    DETECTED: "info",
    AI_VERIFIED: "info",
    AWAITING_APPROVAL: "warning",
    APPROVED: "info",
    ASSIGNED: "progress",
    EN_ROUTE: "progress",
    COLLECTING: "progress",
    REVERIFYING: "info",
    AWAITING_FINAL_APPROVAL: "warning",
    COMPLETED: "success",
    REJECTED: "danger",
    INVESTIGATION: "danger",
  },
  transitions: {
    DETECTED: ["AI_VERIFIED", "REJECTED"],
    AI_VERIFIED: ["AWAITING_APPROVAL", "REJECTED"],
    AWAITING_APPROVAL: ["APPROVED", "REJECTED"],
    APPROVED: ["ASSIGNED", "REJECTED"],
    ASSIGNED: ["EN_ROUTE", "COLLECTING", "APPROVED"],
    EN_ROUTE: ["COLLECTING", "APPROVED"],
    COLLECTING: ["REVERIFYING"],
    REVERIFYING: ["AWAITING_FINAL_APPROVAL", "INVESTIGATION"],
    AWAITING_FINAL_APPROVAL: ["COMPLETED", "REJECTED", "INVESTIGATION"],
    INVESTIGATION: ["COMPLETED", "REJECTED"],
    COMPLETED: [],
    REJECTED: [],
  },
});
export type RequestStatus = (typeof REQUEST.states)[number];

export const BIN = machine({
  states: [
    "NORMAL",
    "FULL",
    "VERIFYING",
    "COLLECTION_REQUESTED",
    "ASSIGNED",
    "COLLECTION_IN_PROGRESS",
    "VERIFYING_EMPTY",
    "AWAITING_APPROVAL",
    "COMPLETED",
    "INVESTIGATION",
  ] as const,
  labels: {
    NORMAL: "Normal",
    FULL: "Full",
    VERIFYING: "AI verifying",
    COLLECTION_REQUESTED: "Collection requested",
    ASSIGNED: "Worker assigned",
    COLLECTION_IN_PROGRESS: "Collecting",
    VERIFYING_EMPTY: "Verifying empty",
    AWAITING_APPROVAL: "Awaiting approval",
    COMPLETED: "Completed",
    INVESTIGATION: "Investigation",
  },
  tones: {
    NORMAL: "neutral",
    FULL: "danger",
    VERIFYING: "info",
    COLLECTION_REQUESTED: "warning",
    ASSIGNED: "progress",
    COLLECTION_IN_PROGRESS: "progress",
    VERIFYING_EMPTY: "info",
    AWAITING_APPROVAL: "warning",
    COMPLETED: "success",
    INVESTIGATION: "danger",
  },
  transitions: {
    NORMAL: ["FULL"],
    FULL: ["VERIFYING", "NORMAL"],
    VERIFYING: ["COLLECTION_REQUESTED", "NORMAL"],
    COLLECTION_REQUESTED: ["ASSIGNED", "NORMAL"],
    ASSIGNED: ["COLLECTION_IN_PROGRESS", "COLLECTION_REQUESTED"],
    COLLECTION_IN_PROGRESS: ["VERIFYING_EMPTY"],
    VERIFYING_EMPTY: ["AWAITING_APPROVAL", "INVESTIGATION"],
    AWAITING_APPROVAL: ["COMPLETED", "INVESTIGATION", "NORMAL"],
    INVESTIGATION: ["COMPLETED", "NORMAL"],
    COMPLETED: ["NORMAL"],
  },
});
export type BinStatus = (typeof BIN.states)[number];

export const WORKER = machine({
  states: ["AVAILABLE", "ASSIGNED", "EN_ROUTE", "AT_BIN", "COLLECTING", "AWAITING_VERIFICATION", "COMPLETED"] as const,
  labels: {
    AVAILABLE: "Available",
    ASSIGNED: "Assigned",
    EN_ROUTE: "En route",
    AT_BIN: "At bin",
    COLLECTING: "Collecting",
    AWAITING_VERIFICATION: "Awaiting verification",
    COMPLETED: "Completed",
  },
  tones: {
    AVAILABLE: "success",
    ASSIGNED: "progress",
    EN_ROUTE: "progress",
    AT_BIN: "progress",
    COLLECTING: "progress",
    AWAITING_VERIFICATION: "info",
    COMPLETED: "success",
  },
  transitions: {
    AVAILABLE: ["ASSIGNED"],
    ASSIGNED: ["EN_ROUTE", "AT_BIN", "AVAILABLE"],
    EN_ROUTE: ["AT_BIN", "AVAILABLE"],
    AT_BIN: ["COLLECTING", "AVAILABLE"],
    COLLECTING: ["AWAITING_VERIFICATION"],
    AWAITING_VERIFICATION: ["COMPLETED", "AVAILABLE", "ASSIGNED"],
    COMPLETED: ["AVAILABLE", "ASSIGNED"],
  },
});
export type WorkerStatus = (typeof WORKER.states)[number];

/** Workers in these states can take a new job. */
export const WORKER_FREE: readonly WorkerStatus[] = ["AVAILABLE", "AWAITING_VERIFICATION", "COMPLETED"];

export const PAYMENT = machine({
  states: ["PENDING", "READY", "SIGNING", "SUBMITTED", "CONFIRMING", "PAID", "FAILED", "CANCELLED"] as const,
  labels: {
    PENDING: "Awaiting approval",
    READY: "Payment ready",
    SIGNING: "Signing",
    SUBMITTED: "Broadcasting",
    CONFIRMING: "Confirming",
    PAID: "Paid",
    FAILED: "Failed",
    CANCELLED: "Not payable",
  },
  tones: {
    PENDING: "neutral",
    READY: "warning",
    SIGNING: "progress",
    SUBMITTED: "progress",
    CONFIRMING: "progress",
    PAID: "success",
    FAILED: "danger",
    CANCELLED: "neutral",
  },
  transitions: {
    PENDING: ["READY", "CANCELLED"],
    READY: ["SIGNING", "SUBMITTED", "CANCELLED", "PAID"],
    SIGNING: ["SUBMITTED", "FAILED", "READY"],
    SUBMITTED: ["CONFIRMING", "PAID", "FAILED"],
    CONFIRMING: ["PAID", "FAILED"],
    PAID: [],
    FAILED: ["SIGNING", "SUBMITTED", "READY", "PAID"],
    CANCELLED: [],
  },
});
export type PaymentStatus = (typeof PAYMENT.states)[number];

/** Mirror of WasteCollectionLedger.Status. */
export const CHAIN_STATUS = [
  "None",
  "Requested",
  "Approved",
  "Assigned",
  "InProgress",
  "AwaitingApproval",
  "Investigation",
  "CompletionApproved",
  "Paid",
  "Rejected",
] as const;
export type ChainStatus = (typeof CHAIN_STATUS)[number];

// ---------------------------------------------------------------------------
// Map markers (derived from bin + request + connectivity)
// ---------------------------------------------------------------------------

export const MARKER = {
  NORMAL: { label: "Normal", tone: "neutral" },
  MONITORING: { label: "Needs monitoring", tone: "warning" },
  FULL: { label: "Full", tone: "danger" },
  AI_VERIFICATION: { label: "AI verification", tone: "info" },
  AWAITING_ASSIGNMENT: { label: "Awaiting assignment", tone: "warning" },
  EN_ROUTE: { label: "Worker en route", tone: "progress" },
  COLLECTING: { label: "Collecting", tone: "progress" },
  AWAITING_APPROVAL: { label: "Awaiting approval", tone: "warning" },
  INVESTIGATION: { label: "Investigation", tone: "danger" },
  COMPLETED: { label: "Completed", tone: "success" },
  OFFLINE: { label: "Offline", tone: "neutral" },
} as const satisfies Record<string, { label: string; tone: Tone }>;
export type MarkerState = keyof typeof MARKER;

export function markerState(bin: {
  status: BinStatus;
  online: boolean;
  fillPct: number;
  monitorPct: number;
  requestStatus?: RequestStatus | null;
}): MarkerState {
  if (!bin.online) return "OFFLINE";
  switch (bin.status) {
    case "FULL":
      return "FULL";
    case "VERIFYING":
    case "VERIFYING_EMPTY":
      return "AI_VERIFICATION";
    case "COLLECTION_REQUESTED":
      return bin.requestStatus === "AWAITING_APPROVAL" ? "FULL" : "AWAITING_ASSIGNMENT";
    case "ASSIGNED":
      return "EN_ROUTE";
    case "COLLECTION_IN_PROGRESS":
      return "COLLECTING";
    case "AWAITING_APPROVAL":
      return "AWAITING_APPROVAL";
    case "INVESTIGATION":
      return "INVESTIGATION";
    case "COMPLETED":
      return "COMPLETED";
    default:
      return bin.fillPct >= bin.monitorPct ? "MONITORING" : "NORMAL";
  }
}

// ---------------------------------------------------------------------------
// RFID + blockchain vocabulary
// ---------------------------------------------------------------------------

export const RFID_RESULT = {
  RFID_VERIFIED: { label: "RFID verified", tone: "success" },
  RFID_MISMATCH: { label: "RFID mismatch", tone: "danger" },
  UNASSIGNED_WORKER: { label: "Unassigned worker", tone: "danger" },
  INVALID_CARD: { label: "Invalid card", tone: "danger" },
  VERIFICATION_PENDING: { label: "Verification pending", tone: "progress" },
} as const satisfies Record<string, { label: string; tone: Tone }>;
export type RfidResult = keyof typeof RFID_RESULT;

export const TX_ACTION: Record<string, string> = {
  DEPLOYMENT: "Ledger Deployment",
  ROLE_GRANT: "Role Grant",
  BIN_REGISTRATION: "Bin Registration",
  WORKER_REGISTRATION: "Worker Registration",
  FUND_TOPUP: "Fund Top-up",
  GAS_FUNDING: "Gas Funding",
  COLLECTION_REQUEST: "Collection Request",
  MUNICIPAL_APPROVAL: "Municipal Approval",
  REQUEST_REJECTION: "Request Rejection",
  WORKER_ASSIGNMENT: "Worker Assignment",
  ASSIGNMENT_CANCELLED: "Assignment Cancelled",
  RFID_VERIFICATION: "RFID Verification",
  COLLECTION_COMPLETION: "Collection Completion",
  INVESTIGATION: "Investigation",
  COMPLETION_APPROVAL: "Completion Approval",
  COMPLETION_REJECTION: "Completion Rejection",
  WORKER_PAYMENT: "Worker Payment",
  INCIDENT: "Incident Record",
  POLICY_UPDATE: "Policy Update",
  TRANSFER_CHECKPOINT: "Transfer Checkpoint",
  CITIZEN_BOUNTY: "Citizen Bounty Payout",
  WORKER_SLASH: "Worker Stake Slashing",
  INCIDENT_RECEIPT: "Incident Insurance Receipt",
  WITNESS_ATTESTATION: "Witness Attestation",
  ROBOT_LOOP: "Robot M2M Value Loop",
};

export const TX_STATUS = {
  SUBMITTED: { label: "Submitted", tone: "progress" },
  CONFIRMED: { label: "Confirmed", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
} as const satisfies Record<string, { label: string; tone: Tone }>;
export type TxStatus = keyof typeof TX_STATUS;

export const INCIDENT_KIND: Record<number, string> = {
  1: "FULLNESS_REJECTED",
  2: "RFID_ABUSE",
  3: "BIN_OFFLINE",
  4: "TELEMETRY_TAMPER",
  5: "FIRE_HAZARD",
  6: "CITIZEN_CHALLENGE",
  7: "TRANSFER_CHECKPOINT",
  8: "WITNESS_ATTESTATION",
};

// ---------------------------------------------------------------------------
// Formatting helpers used on both sides
// ---------------------------------------------------------------------------

export function requestCode(id: number): string {
  return `REQ-${String(id).padStart(5, "0")}`;
}

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
