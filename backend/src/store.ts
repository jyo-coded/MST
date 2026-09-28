import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config";

export type TxRef = { label: string; hash: string; url: string | null };

/** JSON-safe (strings for uint256) copies of the signed structs. */
export type EvidenceJson = {
  jobId: string;
  binId: string;
  tagHash: string;
  fillBefore: string;
  fillAfter: string;
  serviceStart: string;
  serviceEnd: string;
  rawDataHash: string;
};
export type ClaimJson = {
  jobId: string;
  collectorId: string;
  hopperBefore: string;
  hopperAfter: string;
  rawDataHash: string;
};

export type JobRecord = {
  jobId: string;
  binId: string;
  wardId: string;
  status: "Open" | "Accepted" | "Verifying" | "Held" | "Settled" | "Rejected" | "Expired";
  fillAtHire: number;
  collectorId?: string;
  openedAt: number;
  acceptedAt?: number;
  deadline?: number;
  scenario?: string;
  txs: TxRef[];
  evidence?: EvidenceJson;
  evidenceSig?: string;
  binCsv?: string;
  claim?: ClaimJson;
  claimSig?: string;
  collectorCsv?: string;
  reportHash?: string;
  headline?: string;
  payoutWei?: string;
  settlement?: unknown; // the exact settle() bundle, kept for the replay demo
};

export type BinTelemetry = { binId: string; fill: number; lid: number; veh: number; snd: number; at: number };
export type CollectorTelemetry = { collectorId: string; hopper: number; hatch: number; at: number };
export type Incident = { id: string; kind: string; jobId: string | null; summary: string; detailsHash: string; tx?: TxRef; at: string };

type State = {
  jobs: Record<string, JobRecord>;
  bins: Record<string, BinTelemetry>;
  collectors: Record<string, CollectorTelemetry>;
  incidents: Incident[];
  announcements: Record<string, { text: string; tone: "ok" | "alert" | "info"; at: number }>;
};

const FILE = path.join(DATA_DIR, "state.json");

function load(): State {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return { jobs: {}, bins: {}, collectors: {}, incidents: [], announcements: {} };
  }
}

export const state: State = load();

let timer: NodeJS.Timeout | null = null;
export function persist() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
  }, 200);
}

export function upsertJob(jobId: string, patch: Partial<JobRecord>): JobRecord {
  const existing = state.jobs[jobId];
  const next = { ...(existing ?? ({ jobId, txs: [] } as unknown as JobRecord)), ...patch } as JobRecord;
  state.jobs[jobId] = next;
  persist();
  return next;
}

export function addTx(jobId: string, tx: TxRef) {
  const job = state.jobs[jobId];
  if (job) {
    job.txs.push(tx);
    persist();
  }
}

export function announce(target: string, text: string, tone: "ok" | "alert" | "info") {
  state.announcements[target] = { text, tone, at: Date.now() };
  persist();
}

export function jobsForBinSince(binId: string, sinceSec: number) {
  return Object.values(state.jobs).filter((j) => j.binId === binId && j.openedAt >= sinceSec).length;
}

export function activeJobForBin(binId: string): JobRecord | undefined {
  return Object.values(state.jobs)
    .filter((j) => j.binId === binId && ["Open", "Accepted", "Verifying", "Held"].includes(j.status))
    .sort((a, b) => Number(b.jobId) - Number(a.jobId))[0];
}

export function activeJobForCollector(collectorId: string): JobRecord | undefined {
  return Object.values(state.jobs)
    .filter((j) => j.collectorId === collectorId && ["Accepted", "Verifying", "Held"].includes(j.status))
    .sort((a, b) => Number(b.jobId) - Number(a.jobId))[0];
}
