import type { BinStatus, MarkerState, PaymentStatus, RequestStatus, Tone, WorkerStatus } from "@astra/shared";

export type TxLink = { hash: string; url: string | null; status: string | null } | null;

export type Config = {
  productName: string;
  network: string;
  networkLabel: string;
  isLocal: boolean;
  chainId: number;
  chainIdHex: string;
  rpcUrl: string;
  explorerUrl: string | null;
  contract: { address: string; url: string | null; deployTx: string | null; deployedAt: string | null } | null;
  municipality: { id: string; name: string; city: string; ward: string; center: { lat: number; lng: number } };
  simulation: { mode: "simulation" | "live"; workerAutopilot: boolean; organic: boolean };
  payment: { defaultMstc: string; inrPerMstc: number };
  ai: { provider: string; model: string; minConfidence: number };
  policy: { minFillPct: number; minFillRemoved: number; minConfidence: number; maxPayoutMstc: string } | null;
  wallets: { officer: string | null; gateway: string | null; admin: string | null; verifier: string | null } | null;
  allowRoleGrants: boolean;
  database: string;
};

export type HealthItem = { key: string; label: string; status: "online" | "degraded" | "offline"; detail: string };
export type Health = { items: HealthItem[]; mode: string; clients: number; updatedAt: string };

export type Bin = {
  id: string;
  name: string;
  address: string;
  zone: string;
  lat: number;
  lng: number;
  capacityLitres: number;
  depthCm: number;
  thresholdPct: number;
  monitorPct: number;
  hardware: boolean;
  deviceAddress: string;
  deviceUrl: string | null;
  status: BinStatus;
  statusLabel: string;
  marker: MarkerState;
  fillPct: number;
  fill2Pct: number | null;
  distanceCm: number | null;
  distance2Cm: number | null;
  lidState: string;
  servoState: string;
  irStatus: string;
  rfidState: string;
  temperatureC: number | null;
  online: boolean;
  source: string;
  lastHeartbeat: string | null;
  onChain: boolean;
  request: { id: number; code: string; status: RequestStatus; statusLabel: string; workerId: string | null } | null;
};

export type Worker = {
  id: string;
  name: string;
  phone: string;
  zone: string;
  rfidUid: string;
  rfidHash: string;
  wallet: string;
  walletUrl: string | null;
  status: WorkerStatus;
  statusLabel: string;
  lat: number;
  lng: number;
  locationSource: string;
  locationUpdatedAt: string | null;
  completed: number;
  rejected: number;
  onChain: boolean;
  activeJob: { requestId: number; code: string; binId: string; status: string } | null;
  pendingPayments: number;
  pendingMstc: string;
  earnedMstc: string;
};

export type Request = {
  id: number;
  code: string;
  binId: string;
  binName: string | null;
  address: string | null;
  zone: string | null;
  lat: number | null;
  lng: number | null;
  status: RequestStatus;
  statusLabel: string;
  tone: Tone;
  chainStatus: string;
  priority: "low" | "normal" | "high" | "critical";
  detectedFill: number;
  detectedAt: string;
  fillBefore: number | null;
  fillAfter: number | null;
  amountWei: string | null;
  amountMstc: string | null;
  amountInr: number | null;
  workerId: string | null;
  workerName: string | null;
  rfidAlert: boolean;
  investigationReason: string | null;
  rejectionReason: string | null;
  aiConfidence: number | null;
  completionConfidence: number | null;
  createdTx: TxLink;
  paymentStatus: PaymentStatus | null;
  paymentStatusLabel: string | null;
  scenario: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type LifecycleEvent = {
  id: number;
  stage: string;
  label: string;
  message: string;
  actor: string;
  tone: Tone;
  requestId: number | null;
  binId: string | null;
  workerId: string | null;
  ts: string;
  tx: TxLink;
  data: any;
};

export type Check = {
  id: string;
  label: string;
  observed: string;
  expected: string;
  pass: boolean;
  score: number;
  weight: number;
  critical: boolean;
  reason: string;
};

export type Verification = {
  id: number;
  requestId: number | null;
  requestCode: string | null;
  binId: string;
  kind: "fullness" | "completion";
  decision: string;
  verified: boolean;
  confidence: number;
  provider: string;
  model: string;
  latencyMs: number | null;
  checks: Check[];
  reasons: string[];
  summary: Record<string, any>;
  secondOpinion: any;
  inputs: any;
  evidenceHash: string;
  reportHash: string;
  createdAt: string;
};

export type RfidEvent = {
  id: number;
  binId: string;
  requestId: number | null;
  workerId: string | null;
  workerName: string | null;
  tagUid: string;
  tagHash: string;
  result: string;
  checks: { id: string; label: string; pass: boolean; observed: string }[];
  distanceM: number | null;
  source: string;
  tx: TxLink;
  ts: string;
};

export type Assignment = {
  id: number;
  requestId: number;
  workerId: string;
  workerName: string | null;
  assignedBy: string | null;
  distanceKm: number | null;
  etaMin: number | null;
  status: string;
  tx: TxLink;
  assignedAt: string | null;
  enRouteAt: string | null;
  arrivedAt: string | null;
  rfidAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type Payment = {
  requestId: number;
  requestCode: string;
  binId: string | null;
  workerId: string;
  workerName: string | null;
  wallet: string;
  walletUrl: string | null;
  amountWei: string;
  amountMstc: string;
  amountInr: number | null;
  status: PaymentStatus;
  statusLabel: string;
  signer: string | null;
  tx: { hash: string; url: string | null; status: string; feeMstc: string | null; blockNumber: number | null } | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  paidAt: string | null;
};

export type Tx = {
  id: number;
  hash: string;
  url: string | null;
  action: string;
  actionLabel: string;
  method: string;
  requestId: number | null;
  requestCode: string | null;
  binId: string | null;
  workerId: string | null;
  workerName: string | null;
  from: string;
  fromUrl: string | null;
  to: string;
  wallet: string | null;
  walletUrl: string | null;
  valueWei: string | null;
  valueMstc: string | null;
  status: "SUBMITTED" | "CONFIRMED" | "FAILED";
  signer: string;
  blockNumber: number | null;
  gasUsed: string | null;
  feeWei: string | null;
  feeMstc: string | null;
  network: string;
  chainId: number;
  events: { name: string; args: Record<string, any> }[];
  error: string | null;
  createdAt: string;
  confirmedAt: string | null;
  input?: { method: string; args: Record<string, any> } | null;
  confirmations?: number | null;
};

export type Telemetry = { ts: string; fill: number; fill2: number | null; lid: string; servo: string; ir: number; distance?: number | null; source?: string };

export type RequestDetail = {
  request: Request;
  bin: Bin;
  worker: Worker | null;
  distanceM: number | null;
  assignment: Assignment | null;
  lifecycle: LifecycleEvent[];
  verifications: Verification[];
  rfidEvents: RfidEvent[];
  collectionEvents: { type: string; data: any; ts: string }[];
  telemetry: Telemetry[];
  payment: Payment | null;
  transactions: Tx[];
};

export type Candidate = {
  workerId: string;
  name: string;
  status: WorkerStatus;
  available: boolean;
  distanceKm: number;
  etaMin: number;
  activeJobs: number;
  completed: number;
  rejected: number;
  reliability: number;
  zone: string | null;
  sameZone: boolean;
  score: number;
  recommended: boolean;
  why: string;
  lat: number;
  lng: number;
  wallet: string;
};

export type Overview = {
  metrics: {
    totalBins: number;
    activeBins: number;
    fullBins: number;
    pendingRequests: number;
    activeCollections: number;
    awaitingVerification: number;
    completedToday: number;
    paymentsPending: number;
    paidTotalMstc: string;
  };
  attention: Request[];
  spotlight: { request: Request; lifecycle: LifecycleEvent[] } | null;
  recentTx: Tx[];
  feed: LifecycleEvent[];
};

export type ChainStatus = {
  network: string;
  chainId: number;
  blockNumber: number;
  contract: { address: string; url: string | null };
  paused: boolean;
  latestRequestId: number;
  fund: { balanceMstc: string; reservedMstc: string; freeMstc: string; totalPaidMstc: string };
  wallets: { role: string; purpose: string; address: string | null; url: string | null; balanceMstc: string | null }[];
  txCount: number;
  confirmedCount: number;
};

export type Notification = {
  id: number;
  type: string;
  severity: "info" | "success" | "warning" | "critical";
  title: string;
  body: string | null;
  requestId: number | null;
  binId: string | null;
  workerId: string | null;
  read: boolean;
  createdAt: string;
};

export type BinDetail = {
  bin: Bin;
  sensors: { kind: string; model: string; status: string; last_value: string | null; updated_at: string | null }[];
  telemetry: Telemetry[];
  requests: Request[];
  transactions: Tx[];
  rfidEvents: RfidEvent[];
  lifecycle: LifecycleEvent[];
};

export type WorkerDetail = {
  worker: Worker;
  balanceMstc: string | null;
  jobs: Request[];
  payments: Payment[];
  transactions: Tx[];
  track: [number, number][];
};

export type PaymentsView = {
  summary: { escrowMstc: string; readyMstc: string; readyCount: number; paidTodayMstc: string; paidTotalMstc: string; inrPerMstc: number };
  fund: { balanceMstc: string; reservedMstc: string; freeMstc: string; totalPaidMstc: string } | null;
  items: Payment[];
};

export type SimSnapshot = {
  settings: { mode: "simulation" | "live"; workerAutopilot: boolean; organic: boolean };
  autopilot: { binId: string; stage: string; running: boolean; autoApprove: boolean; requestId: number | null; error: string | null } | null;
  bins: { id: string; mode: string; offline: boolean; simulated: boolean; fill: number }[];
};

export type SessionUser = { id: string; name: string; role: "officer" | "admin" | "worker"; workerId?: string | null };

export type MeJob = { worker: Worker; balanceMstc: string | null; job: RequestDetail | null; payments: Payment[] };
