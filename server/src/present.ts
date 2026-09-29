import { ethers } from "ethers";
import { BIN, markerState, PAYMENT, REQUEST, stageLabel, TX_ACTION, WORKER, type BinStatus, type RequestStatus } from "@astra/shared";
import { config, explorerAddress, explorerTx } from "./config";

/** Database rows -> API shapes (camelCase, amounts in both wei and MSTC). */

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const mst = (wei: unknown) => (wei === null || wei === undefined ? null : ethers.formatEther(BigInt(String(wei))));
const inr = (wei: unknown) => (wei === null || wei === undefined ? null : Math.round(Number(ethers.formatEther(BigInt(String(wei)))) * config.payment.inrPerMstc * 100) / 100);

export function txLink(hash: string | null | undefined, status?: string | null) {
  return hash ? { hash, url: explorerTx(hash), status: status ?? null } : null;
}

export function presentBin(b: any, extra: { request?: any } = {}) {
  const requestStatus = (extra.request?.status ?? null) as RequestStatus | null;
  return {
    id: b.id,
    name: b.name,
    address: b.address,
    zone: b.zone,
    lat: b.lat,
    lng: b.lng,
    capacityLitres: b.capacity_litres,
    depthCm: b.depth_cm,
    thresholdPct: b.threshold_pct,
    monitorPct: b.monitor_pct,
    hardware: b.hardware,
    deviceAddress: b.device_address,
    deviceUrl: explorerAddress(b.device_address),
    status: b.status as BinStatus,
    statusLabel: BIN.labels[b.status as BinStatus] ?? b.status,
    marker: markerState({ status: b.status, online: b.online, fillPct: b.fill_pct, monitorPct: b.monitor_pct, requestStatus }),
    fillPct: b.fill_pct,
    fill2Pct: b.fill2_pct,
    distanceCm: b.distance_cm,
    distance2Cm: b.distance2_cm,
    lidState: b.lid_state,
    servoState: b.servo_state,
    irStatus: b.ir_status,
    rfidState: b.rfid_state,
    temperatureC: b.temperature_c,
    online: b.online,
    source: b.source,
    lastHeartbeat: iso(b.last_heartbeat),
    onChain: b.on_chain,
    request: extra.request
      ? {
          id: extra.request.id,
          code: extra.request.code,
          status: extra.request.status,
          statusLabel: REQUEST.labels[extra.request.status as RequestStatus],
          workerId: extra.request.assigned_worker_id,
        }
      : null,
  };
}

export function presentWorker(w: any, extra: Record<string, unknown> = {}) {
  const completed = w.completed_count || 0;
  const stakeDiscount = Math.min(0.04, completed * 0.005);
  const requiredStake = Math.max(0.01, 0.05 - stakeDiscount);

  return {
    id: w.id,
    name: w.name,
    phone: w.phone,
    zone: w.zone,
    rfidUid: w.rfid_uid,
    rfidHash: w.rfid_hash,
    wallet: w.wallet_address,
    walletUrl: explorerAddress(w.wallet_address),
    status: w.status,
    statusLabel: WORKER.labels[w.status as keyof typeof WORKER.labels] ?? w.status,
    lat: w.lat,
    lng: w.lng,
    locationSource: w.location_source,
    locationUpdatedAt: iso(w.location_updated_at),
    completed: w.completed_count,
    rejected: w.rejected_count,
    reputationScore: w.reputation_score ?? 100,
    slashedCount: w.slashed_count ?? 0,
    stakeLockedMstc: mst(w.stake_locked_wei),
    requiredStakeMstc: requiredStake.toFixed(3),
    onChain: w.on_chain,
    ...extra,
  };
}

export function presentRequest(r: any) {
  return {
    id: r.id,
    code: r.code,
    binId: r.bin_id,
    binName: r.bin_name ?? null,
    address: r.bin_address ?? null,
    zone: r.bin_zone ?? null,
    lat: r.bin_lat ?? null,
    lng: r.bin_lng ?? null,
    status: r.status as RequestStatus,
    statusLabel: REQUEST.labels[r.status as RequestStatus] ?? r.status,
    tone: REQUEST.tones[r.status as RequestStatus] ?? "neutral",
    chainStatus: r.chain_status,
    priority: r.priority,
    detectedFill: r.detected_fill,
    detectedAt: iso(r.detected_at),
    fillBefore: r.fill_before,
    fillAfter: r.fill_after,
    amountWei: r.amount_wei,
    amountMstc: mst(r.amount_wei),
    amountInr: inr(r.amount_wei),
    workerId: r.assigned_worker_id,
    workerName: r.worker_name ?? null,
    rfidAlert: r.rfid_alert,
    investigationReason: r.investigation_reason,
    rejectionReason: r.rejection_reason,
    aiConfidence: r.ai_confidence ?? null,
    completionConfidence: r.completion_confidence ?? null,
    createdTx: txLink(r.created_tx_hash, r.created_tx_status),
    paymentStatus: r.payment_status ?? null,
    paymentStatusLabel: r.payment_status ? PAYMENT.labels[r.payment_status as keyof typeof PAYMENT.labels] : null,
    scenario: r.scenario,
    transferVerified: !!r.transfer_verified,
    transferVerifiedAt: iso(r.transfer_verified_at),
    transferFacility: r.transfer_facility ?? null,
    challengeStatus: r.challenge_status ?? "OPEN",
    challengeWindowEndsAt: iso(r.challenge_window_ends_at),
    secondFactorVerified: !!r.second_factor_verified,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    completedAt: iso(r.completed_at),
  };
}

export const REQUEST_SELECT = `
  SELECT r.*, b.name AS bin_name, b.address AS bin_address, b.zone AS bin_zone, b.lat AS bin_lat, b.lng AS bin_lng,
         w.name AS worker_name, p.status AS payment_status, t.hash AS created_tx_hash, t.status AS created_tx_status,
         (SELECT confidence FROM ai_verifications v WHERE v.request_id = r.id AND v.kind = 'fullness' ORDER BY id DESC LIMIT 1) AS ai_confidence,
         (SELECT confidence FROM ai_verifications v WHERE v.request_id = r.id AND v.kind = 'completion' ORDER BY id DESC LIMIT 1) AS completion_confidence
    FROM collection_requests r
    JOIN bins b ON b.id = r.bin_id
    LEFT JOIN workers w ON w.id = r.assigned_worker_id
    LEFT JOIN payments p ON p.request_id = r.id
    LEFT JOIN blockchain_transactions t ON t.id = r.created_tx_id`;

export function presentTx(t: any) {
  return {
    id: t.id,
    hash: t.hash,
    url: explorerTx(t.hash),
    action: t.action,
    actionLabel: TX_ACTION[t.action] ?? t.action,
    method: t.method,
    requestId: t.request_id,
    requestCode: t.request_id ? `REQ-${String(t.request_id).padStart(5, "0")}` : null,
    binId: t.bin_id,
    workerId: t.worker_id,
    workerName: t.worker_name ?? null,
    from: t.from_address,
    fromUrl: t.from_address ? explorerAddress(t.from_address) : null,
    to: t.to_address,
    wallet: t.wallet,
    walletUrl: t.wallet ? explorerAddress(t.wallet) : null,
    valueWei: t.value_wei,
    valueMstc: mst(t.value_wei),
    status: t.status,
    signer: t.signer_kind,
    blockNumber: t.block_number === null ? null : Number(t.block_number),
    gasUsed: t.gas_used,
    feeWei: t.fee_wei,
    feeMstc: mst(t.fee_wei),
    network: t.network,
    chainId: t.chain_id,
    events: t.events ?? [],
    error: t.error,
    createdAt: iso(t.created_at),
    confirmedAt: iso(t.confirmed_at),
  };
}

export const TX_SELECT = `SELECT t.*, w.name AS worker_name FROM blockchain_transactions t LEFT JOIN workers w ON w.id = t.worker_id`;

export function presentPayment(p: any) {
  return {
    requestId: p.request_id,
    requestCode: `REQ-${String(p.request_id).padStart(5, "0")}`,
    binId: p.bin_id ?? null,
    workerId: p.worker_id,
    workerName: p.worker_name ?? null,
    wallet: p.wallet_address,
    walletUrl: explorerAddress(p.wallet_address),
    amountWei: p.amount_wei,
    amountMstc: mst(p.amount_wei),
    amountInr: p.amount_inr,
    status: p.status,
    statusLabel: PAYMENT.labels[p.status as keyof typeof PAYMENT.labels] ?? p.status,
    signer: p.signer,
    tx: p.tx_hash
      ? { hash: p.tx_hash, url: explorerTx(p.tx_hash), status: p.tx_status, feeMstc: mst(p.tx_fee), blockNumber: p.tx_block === null ? null : Number(p.tx_block) }
      : null,
    error: p.error,
    createdAt: iso(p.created_at),
    updatedAt: iso(p.updated_at),
    paidAt: iso(p.paid_at),
  };
}

export const PAYMENT_SELECT = `
  SELECT p.*, w.name AS worker_name, r.bin_id, t.hash AS tx_hash, t.status AS tx_status, t.fee_wei AS tx_fee, t.block_number AS tx_block
    FROM payments p
    JOIN workers w ON w.id = p.worker_id
    JOIN collection_requests r ON r.id = p.request_id
    LEFT JOIN blockchain_transactions t ON t.id = p.tx_id`;

export function presentVerification(v: any) {
  return {
    id: v.id,
    requestId: v.request_id,
    requestCode: v.request_id ? `REQ-${String(v.request_id).padStart(5, "0")}` : null,
    binId: v.bin_id,
    kind: v.kind,
    decision: v.decision,
    verified: v.verified,
    confidence: v.confidence,
    provider: v.provider,
    model: v.model,
    latencyMs: v.latency_ms,
    checks: v.checks,
    reasons: v.reasons,
    summary: v.summary,
    secondOpinion: v.second_opinion,
    inputs: v.inputs,
    evidenceHash: v.evidence_hash,
    reportHash: v.report_hash,
    createdAt: iso(v.created_at),
  };
}

export function presentLifecycle(e: any) {
  return {
    id: Number(e.id),
    stage: e.stage,
    label: stageLabel(e.stage),
    message: e.message,
    actor: e.actor,
    tone: e.tone,
    requestId: e.request_id,
    binId: e.bin_id,
    workerId: e.worker_id,
    ts: iso(e.ts),
    tx: txLink(e.tx_hash, e.tx_status),
    data: e.data,
  };
}

export const LIFECYCLE_SELECT = `SELECT e.*, t.hash AS tx_hash, t.status AS tx_status FROM lifecycle_events e LEFT JOIN blockchain_transactions t ON t.id = e.tx_id`;

export function presentNotification(n: any) {
  return {
    id: n.id,
    type: n.type,
    severity: n.severity,
    title: n.title,
    body: n.body,
    requestId: n.request_id,
    binId: n.bin_id,
    workerId: n.worker_id,
    read: n.read,
    createdAt: iso(n.created_at),
  };
}

export function presentRfid(e: any) {
  return {
    id: e.id,
    binId: e.bin_id,
    requestId: e.request_id,
    workerId: e.worker_id,
    workerName: e.worker_name ?? null,
    tagUid: e.tag_uid,
    tagHash: e.tag_hash,
    result: e.result,
    checks: e.checks,
    distanceM: e.distance_m,
    source: e.source,
    tx: txLink(e.tx_hash, e.tx_status),
    ts: iso(e.ts),
  };
}

export function presentAssignment(a: any) {
  if (!a) return null;
  return {
    id: a.id,
    requestId: a.request_id,
    workerId: a.worker_id,
    workerName: a.worker_name ?? null,
    assignedBy: a.assigned_by,
    distanceKm: a.distance_km,
    etaMin: a.eta_min,
    status: a.status,
    tx: txLink(a.tx_hash, a.tx_status),
    assignedAt: iso(a.assigned_at),
    enRouteAt: iso(a.en_route_at),
    arrivedAt: iso(a.arrived_at),
    rfidAt: iso(a.rfid_at),
    startedAt: iso(a.started_at),
    finishedAt: iso(a.finished_at),
  };
}

export function presentChallenge(c: any) {
  return {
    id: c.id,
    requestId: c.request_id,
    binId: c.bin_id,
    citizenAddress: c.citizen_address,
    citizenName: c.citizen_name ?? null,
    lat: c.lat,
    lng: c.lng,
    distanceToBinM: c.distance_to_bin_m !== null ? Math.round(Number(c.distance_to_bin_m)) : null,
    note: c.note,
    photoUrl: c.photo_url ?? null,
    bountyMstc: c.bounty_mstc,
    status: c.status,
    watcherVerified: !!c.watcher_verified,
    createdAt: iso(c.created_at),
    resolvedAt: iso(c.resolved_at),
  };
}

export function presentWitness(w: any) {
  return {
    id: w.id,
    requestId: w.request_id,
    binId: w.bin_id,
    witnessName: w.witness_name,
    witnessAddress: w.witness_address,
    role: w.role,
    statement: w.statement,
    signature: w.signature,
    evidenceHash: w.evidence_hash,
    createdAt: iso(w.created_at),
  };
}

export function presentIncidentReceipt(r: any) {
  return {
    id: r.id,
    incidentId: r.incident_id,
    kind: r.kind,
    binId: r.bin_id,
    requestId: r.request_id,
    temperatureC: r.temperature_c,
    detailsHash: r.details_hash,
    txHash: r.tx_hash,
    blockNumber: r.block_number ? Number(r.block_number) : null,
    insurancePolicy: r.insurance_policy,
    claimStatus: r.claim_status,
    rawBundle: r.raw_bundle,
    createdAt: iso(r.created_at),
  };
}

export { iso, mst, inr };
