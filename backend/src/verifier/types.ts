import type { Features } from "../features";
import type { BinSample, CollectorSample } from "../samples";

export type Verdict = "APPROVE" | "HOLD" | "REJECT";

/** What the verifier model receives. Numbers only: no free text from any party. */
export type VerifierPacket = {
  jobId: string;
  features: Features;
  binSeries: BinSample[]; // downsampled
  collectorSeries: CollectorSample[] | null; // downsampled
};

export type VerifierResult = {
  available: boolean; // false when the model timed out / errored / returned junk
  mode: string;
  model: string;
  verdict: Verdict | null;
  confidence: number; // 0-100
  flags: string[];
  reasons: string[];
  latencyMs: number;
  error?: string;
};

/** Flag vocabulary shared by the heuristic model, the Qwen prompt and the dashboard. */
export const FLAGS: Record<string, string> = {
  DROP_WITH_LID_CLOSED: "Fill level fell while the lid was closed (sensor tampering?)",
  INSTANT_EMPTYING: "Bin went from full to empty in a single step (obstruction removed, not waste)",
  STEP_ACCUMULATION: "Bin jumped to 'full' in one step instead of filling gradually (sensor blocked?)",
  NO_SOUND: "No emptying noise was heard while the bin was supposedly emptied",
  CONSERVATION_MISMATCH: "Waste that left the bin does not match what arrived in the collector",
  POSSIBLE_ILLEGAL_DUMPING: "Bin was emptied but the waste never reached the collector hopper",
  NO_VEHICLE: "No collector vehicle was detected at the bin during service",
  HIRE_FILL_MISMATCH: "Fill level when hiring does not match fill level at service start",
  HIGH_JOB_FREQUENCY: "This bin is hiring collectors unusually often (bounty farming?)",
  COLLECTOR_HISTORY: "This collector has a high rejection rate",
  NO_COLLECTOR_CLAIM: "Collector sent no signed hopper measurement",
};
