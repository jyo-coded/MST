import { ethers } from "ethers";
import { CHAIN_STATUS, haversineKm, requestCode, WORKER_FREE, type RequestStatus } from "@astra/shared";
import { runVerification, verifyCompletion, verifyFullness, type Sample } from "../ai";
import { ChainError, humanizeReason, idBytes, ledger, type DecodedEvent, type SignerKind, type TxMeta, type TxRow } from "../chain/ledger";
import { config, deviceWallet, normalizeUid, rfidHash } from "../config";
import { one, q } from "../db";
import { notify, record } from "../events";
import { queueCommand } from "../iot/commands";
import { publish } from "../realtime";
import { keccakJson, mstc, round1, sleep } from "../util";
import { rankWorkers } from "./assignment";
import { setBin, setPayment, setRequest, setWorker, TransitionError, withLock } from "./state";

export class WorkflowError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
  }
}

/** Who did something. Officers act through the server wallet or their own BridgeKey wallet. */
export type Actor = { kind: "officer" | "admin" | "system" | "worker" | "device" | "ai"; id?: string; name?: string };
const actorLabel = (a?: Actor) => (a ? (a.name ? `${a.kind}:${a.name}` : a.kind) : "system");

const unix = (d: Date | string) => BigInt(Math.floor(new Date(d).getTime() / 1000));
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// ===========================================================================
// Reads
// ===========================================================================

export async function getBin(id: string) {
  const b = await one(`SELECT * FROM bins WHERE id = $1`, [id]);
  if (!b) throw new WorkflowError(`Unknown bin ${id}`, 404);
  return b;
}

export async function getRequest(id: number) {
  const r = await one(`SELECT * FROM collection_requests WHERE id = $1`, [id]);
  if (!r) throw new WorkflowError(`Unknown request ${requestCode(id)}`, 404);
  return r;
}

export async function getWorker(id: string) {
  const w = await one(`SELECT * FROM workers WHERE id = $1`, [id]);
  if (!w) throw new WorkflowError(`Unknown worker ${id}`, 404);
  return w;
}

/** A bin is busy until its request is rejected or its worker has been paid. */
export async function activeRequestForBin(binId: string) {
  return one(
    `SELECT r.* FROM collection_requests r
       LEFT JOIN payments p ON p.request_id = r.id
      WHERE r.bin_id = $1
        AND r.status <> 'REJECTED'
        AND NOT (r.status = 'COMPLETED' AND p.status = 'PAID')
      ORDER BY r.id DESC LIMIT 1`,
    [binId],
  );
}

export async function activeAssignmentForWorker(workerId: string) {
  return one(
    `SELECT a.*, r.bin_id, r.status AS request_status FROM assignments a
       JOIN collection_requests r ON r.id = a.request_id
      WHERE a.worker_id = $1 AND a.status IN ('ASSIGNED','EN_ROUTE','AT_BIN','COLLECTING')
      ORDER BY a.id DESC LIMIT 1`,
    [workerId],
  );
}

async function telemetryWindow(binId: string, fromIso: string | null, limit = 90): Promise<Sample[]> {
  const rows = fromIso
    ? await q(`SELECT * FROM telemetry WHERE bin_id = $1 AND ts >= $2 ORDER BY ts ASC LIMIT $3`, [binId, fromIso, limit])
    : (await q(`SELECT * FROM telemetry WHERE bin_id = $1 ORDER BY ts DESC LIMIT $2`, [binId, limit])).reverse();
  return rows.map((t: any) => ({
    ts: new Date(t.ts).toISOString(),
    fill: t.fill_pct,
    fill2: t.fill2_pct,
    distanceCm: t.distance_cm,
    lid: t.lid_state,
    servo: t.servo_state,
    ir: t.ir_count,
    weightG: t.weight_g ?? null,
  }));
}

async function nextRequestId(): Promise<number> {
  const row = await one<{ max: number | null }>(`SELECT max(id) AS max FROM collection_requests`);
  let chainLatest = 0;
  try {
    chainLatest = Number(await ledger().contract.latestRequestId());
  } catch {
    /* chain unreachable: DB id is still unique for this ledger */
  }
  return Math.max(row?.max ?? 0, chainLatest) + 1;
}

/** Device nonces must strictly increase per bin (the contract checks this). */
async function nextDeviceNonce(binId: string): Promise<bigint> {
  const b = await one<{ device_nonce: string }>(`SELECT device_nonce FROM bins WHERE id = $1`, [binId]);
  const next = BigInt(Math.max(Date.now(), Number(b?.device_nonce ?? 0) + 1));
  await q(`UPDATE bins SET device_nonce = $2 WHERE id = $1`, [binId, next.toString()]);
  return next;
}

function officerLabel(address: string, actor?: Actor) {
  const server = ledger().signerAddress("officer");
  const who = actor?.name ? `${actor.name}` : "Municipal officer";
  return server && address.toLowerCase() === server.toLowerCase()
    ? `${who} (municipal wallet ${short(address)})`
    : `${who} (BridgeKey ${short(address)})`;
}

// ===========================================================================
// Chain plumbing
// ===========================================================================

async function send(kind: SignerKind, method: string, args: unknown[], meta: TxMeta, hooks?: Parameters<ReturnType<typeof ledger>["send"]>[4]) {
  try {
    return await ledger().send(kind, method, args, meta, hooks);
  } catch (err) {
    if (err instanceof ChainError) {
      const human = humanizeReason(err.reason);
      const refused = err.kind === "refused";
      await record({
        stage: "CHAIN_ERROR",
        message: refused ? `Ledger refused ${method}: ${human}` : `${method} failed on ${config.networkLabel}: ${human}`,
        actor: "system",
        tone: refused ? "warning" : "danger",
        requestId: meta.requestId ?? null,
        binId: meta.binId ?? null,
        data: { reason: err.reason },
      });
      await notify({
        type: refused ? "CHAIN_REFUSED" : "CHAIN_FAILED",
        severity: refused ? "warning" : "critical",
        title: refused ? "Action refused by the ledger" : "Blockchain transaction failed",
        body: human,
        requestId: meta.requestId ?? null,
        binId: meta.binId ?? null,
      });
      throw new WorkflowError(human, 409);
    }
    throw err;
  }
}

/** Only one lifecycle entry per (transaction, stage), however often events are replayed. */
async function once(tx: TxRow, stage: string) {
  return !(await one(`SELECT 1 FROM lifecycle_events WHERE tx_id = $1 AND stage = $2`, [tx.id, stage]));
}

/**
 * Applies confirmed contract events to the database. This is the single
 * place where on-chain facts become application state, whoever signed the
 * transaction (server wallet or an officer's BridgeKey).
 */
export async function applyEvents(events: DecodedEvent[], tx: TxRow, actor?: Actor) {
  for (const ev of events) {
    const a = ev.args as Record<string, any>;
    const id = a.requestId !== undefined ? Number(a.requestId) : null;
    const req = id ? await one(`SELECT * FROM collection_requests WHERE id = $1`, [id]) : null;
    if (id && !req && ev.name !== "IncidentRecorded") continue;

    switch (ev.name) {
      case "RequestCreated": {
        if (!(await once(tx, "COLLECTION_REQUEST_CREATED"))) break;
        await setRequest(id!, "AWAITING_APPROVAL", { chain_status: "Requested", created_tx_id: tx.id });
        await setBin(req.bin_id, "COLLECTION_REQUESTED");
        await record({
          stage: "COLLECTION_REQUEST_CREATED",
          message: `Collection request ${requestCode(id!)} recorded on ${config.networkLabel}`,
          actor: "gateway",
          tone: "success",
          requestId: id,
          binId: req.bin_id,
          txId: tx.id,
        });
        await notify({
          type: "NEW_REQUEST",
          severity: "info",
          title: `New collection request ${requestCode(id!)}`,
          body: `${req.bin_id} at ${Math.round(req.detected_fill)}% awaits municipal approval.`,
          requestId: id,
          binId: req.bin_id,
        });
        break;
      }
      case "RequestApproved": {
        if (!(await once(tx, "MUNICIPAL_APPROVAL"))) break;
        await setRequest(id!, "APPROVED", { chain_status: "Approved" });
        await record({
          stage: "MUNICIPAL_APPROVAL",
          message: `Request approved by ${officerLabel(a.officer, actor)}`,
          actor: actorLabel(actor),
          tone: "success",
          requestId: id,
          binId: req.bin_id,
          txId: tx.id,
        });
        break;
      }
      case "RequestRejected": {
        if (!(await once(tx, "REQUEST_REJECTED"))) break;
        await setRequest(id!, "REJECTED", { chain_status: "Rejected" });
        await setBin(req.bin_id, "NORMAL");
        await record({
          stage: "REQUEST_REJECTED",
          message: `Request rejected by ${officerLabel(a.officer, actor)}${req.rejection_reason ? `: ${req.rejection_reason}` : ""}`,
          actor: actorLabel(actor),
          tone: "danger",
          requestId: id,
          binId: req.bin_id,
          txId: tx.id,
        });
        break;
      }
      case "WorkerAssigned": {
        if (!(await once(tx, "WORKER_ASSIGNED"))) break;
        const workerId = String(a.workerId);
        const worker = await getWorker(workerId);
        const bin = await getBin(req.bin_id);
        const distanceKm = haversineKm({ lat: worker.lat, lng: worker.lng }, { lat: bin.lat, lng: bin.lng });
        const etaMin = Math.max(2, Math.round((distanceKm / 16) * 60 + 1));
        await q(
          `INSERT INTO assignments (request_id, worker_id, assigned_by, distance_km, eta_min, status, tx_id)
           VALUES ($1,$2,$3,$4,$5,'ASSIGNED',$6)`,
          [id, workerId, actor?.name ?? a.officer, round1(distanceKm), etaMin, tx.id],
        );
        const amountWei = BigInt(a.amount);
        await setRequest(id!, "ASSIGNED", { chain_status: "Assigned", assigned_worker_id: workerId, amount_wei: amountWei.toString() });
        await setWorker(workerId, "ASSIGNED");
        await setBin(req.bin_id, "ASSIGNED");
        await q(
          `INSERT INTO payments (request_id, worker_id, wallet_address, amount_wei, amount_inr, status)
           VALUES ($1,$2,$3,$4,$5,'PENDING')
           ON CONFLICT (request_id) DO UPDATE SET worker_id = EXCLUDED.worker_id, wallet_address = EXCLUDED.wallet_address,
             amount_wei = EXCLUDED.amount_wei, amount_inr = EXCLUDED.amount_inr, status = 'PENDING', tx_id = NULL, error = NULL, updated_at = now()`,
          [id, workerId, a.wallet, amountWei.toString(), round1(Number(mstc(amountWei)) * config.payment.inrPerMstc)],
        );
        publish("payment", await one(`SELECT * FROM payments WHERE request_id = $1`, [id]));
        await record({
          stage: "WORKER_ASSIGNED",
          message: `${worker.name} assigned (${round1(distanceKm)} km away) · ${mstc(amountWei)} MSTC escrowed`,
          actor: actorLabel(actor),
          tone: "success",
          requestId: id,
          binId: req.bin_id,
          workerId,
          txId: tx.id,
        });
        await notify({
          type: "WORKER_ASSIGNED",
          severity: "info",
          title: `${worker.name} assigned to ${req.bin_id}`,
          body: `${requestCode(id!)} · ${round1(distanceKm)} km away · ETA ${etaMin} min`,
          requestId: id,
          binId: req.bin_id,
          workerId,
        });
        break;
      }
      case "AssignmentCancelled": {
        if (!(await once(tx, "ASSIGNMENT_CANCELLED"))) break;
        const workerId = String(a.workerId);
        await q(`UPDATE assignments SET status = 'CANCELLED' WHERE request_id = $1 AND status <> 'CANCELLED'`, [id]);
        await setRequest(id!, "APPROVED", { chain_status: "Approved", assigned_worker_id: null });
        const w = await getWorker(workerId);
        if (w.status !== "AVAILABLE") await setWorker(workerId, "AVAILABLE");
        await setBin(req.bin_id, "COLLECTION_REQUESTED");
        await q(`DELETE FROM payments WHERE request_id = $1 AND status = 'PENDING'`, [id]);
        await record({
          stage: "ASSIGNMENT_CANCELLED",
          message: `Assignment of ${w.name} cancelled; escrow released`,
          actor: actorLabel(actor),
          tone: "warning",
          requestId: id,
          binId: req.bin_id,
          workerId,
          txId: tx.id,
        });
        break;
      }
      case "RfidVerified": {
        if (!(await once(tx, "RFID_VERIFIED"))) break;
        const workerId = String(a.workerId);
        const worker = await getWorker(workerId);
        await setRequest(id!, "COLLECTING", { chain_status: "InProgress" });
        await q(
          `UPDATE rfid_events SET result = 'RFID_VERIFIED', tx_id = $2
            WHERE id = (SELECT id FROM rfid_events WHERE request_id = $1 AND worker_id = $3 AND result = 'VERIFICATION_PENDING' ORDER BY id DESC LIMIT 1)`,
          [id, tx.id, workerId],
        );
        publish("rfid", { requestId: id, result: "RFID_VERIFIED", txHash: tx.hash });
        if ((await getBin(req.bin_id)).status === "ASSIGNED") await setBin(req.bin_id, "COLLECTION_IN_PROGRESS");
        await record({
          stage: "RFID_VERIFIED",
          message: `${worker.name}'s RFID card verified against the assignment on-chain`,
          actor: `device:${req.bin_id}`,
          tone: "success",
          requestId: id,
          binId: req.bin_id,
          workerId,
          txId: tx.id,
        });
        break;
      }
      case "RfidMismatch": {
        if (!(await once(tx, "RFID_MISMATCH"))) break;
        await setRequest(id!, null, { rfid_alert: true, investigation_reason: "RFID mismatch at the bin" });
        await q(
          `UPDATE rfid_events SET tx_id = $2
            WHERE id = (SELECT id FROM rfid_events WHERE request_id = $1 AND result = 'RFID_MISMATCH' AND tx_id IS NULL ORDER BY id DESC LIMIT 1)`,
          [id, tx.id],
        );
        await record({
          stage: "RFID_MISMATCH",
          message: `Wrong RFID card at ${req.bin_id}. Lid stayed locked; mismatch recorded on-chain`,
          actor: `device:${req.bin_id}`,
          tone: "danger",
          requestId: id,
          binId: req.bin_id,
          txId: tx.id,
        });
        break;
      }
      case "CollectionCompleted": {
        const verified = Boolean(a.verified);
        const stage = verified ? "AI_COMPLETION_VERIFIED" : "AI_COMPLETION_REJECTED";
        if (!(await once(tx, stage))) break;
        const conf = round1(Number(a.confidenceBps) / 100);
        await setRequest(id!, verified ? "AWAITING_FINAL_APPROVAL" : "INVESTIGATION", {
          chain_status: verified ? "AwaitingApproval" : "Investigation",
          fill_before: Number(a.fillBefore),
          fill_after: Number(a.fillAfter),
          investigation_reason: verified ? req.investigation_reason : "AI could not verify the collection",
        });
        await setBin(req.bin_id, verified ? "AWAITING_APPROVAL" : "INVESTIGATION");
        await q(`UPDATE assignments SET status = 'COMPLETED', finished_at = COALESCE(finished_at, now()) WHERE request_id = $1 AND status <> 'CANCELLED'`, [id]);
        await record({
          stage,
          message: verified
            ? `Collection verified (${a.fillBefore}% → ${a.fillAfter}%, ${conf}% confidence)`
            : `Collection NOT verified (${a.fillBefore}% → ${a.fillAfter}%, ${conf}% confidence). Investigation required`,
          actor: "ai",
          tone: verified ? "success" : "danger",
          requestId: id,
          binId: req.bin_id,
          workerId: req.assigned_worker_id,
          txId: tx.id,
        });
        await notify(
          verified
            ? {
                type: "COLLECTION_COMPLETED",
                severity: "warning",
                title: `Collection completed at ${req.bin_id}: awaiting approval`,
                body: `${requestCode(id!)} · ${a.fillBefore}% → ${a.fillAfter}% · AI ${conf}%`,
                requestId: id,
                binId: req.bin_id,
                workerId: req.assigned_worker_id,
              }
            : {
                type: "INVESTIGATION_REQUIRED",
                severity: "critical",
                title: `Investigation required: ${requestCode(id!)}`,
                body: `AI could not verify the collection at ${req.bin_id} (${a.fillBefore}% → ${a.fillAfter}%).`,
                requestId: id,
                binId: req.bin_id,
                workerId: req.assigned_worker_id,
              },
        );
        break;
      }
      case "InvestigationOpened": {
        if (!(await once(tx, "INVESTIGATION_OPENED"))) break;
        await setRequest(id!, "INVESTIGATION", { chain_status: "Investigation" });
        await setBin(req.bin_id, "INVESTIGATION");
        await record({
          stage: "INVESTIGATION_OPENED",
          message: `Investigation opened by ${officerLabel(a.officer, actor)}${req.investigation_reason ? `: ${req.investigation_reason}` : ""}`,
          actor: actorLabel(actor),
          tone: "warning",
          requestId: id,
          binId: req.bin_id,
          txId: tx.id,
        });
        break;
      }
      case "CompletionApproved": {
        if (!(await once(tx, "MUNICIPAL_COMPLETION_APPROVED"))) break;
        await setRequest(id!, "COMPLETED", { chain_status: "CompletionApproved", completed_at: new Date() });
        await setBin(req.bin_id, "COMPLETED");
        if (req.assigned_worker_id) {
          const w = await getWorker(req.assigned_worker_id);
          if (w.status === "AWAITING_VERIFICATION") await setWorker(w.id, "COMPLETED");
        }
        await setPayment(id!, "READY");
        await record({
          stage: "MUNICIPAL_COMPLETION_APPROVED",
          message: `Completion approved by ${officerLabel(a.officer, actor)}. Payment ready`,
          actor: actorLabel(actor),
          tone: "success",
          requestId: id,
          binId: req.bin_id,
          workerId: req.assigned_worker_id,
          txId: tx.id,
        });
        await notify({
          type: "PAYMENT_PENDING",
          severity: "warning",
          title: `Payment ready for ${requestCode(id!)}`,
          body: `Release ${mstc(req.amount_wei ?? "0")} MSTC to the worker.`,
          requestId: id,
          binId: req.bin_id,
          workerId: req.assigned_worker_id,
        });
        break;
      }
      case "CompletionRejected": {
        if (!(await once(tx, "COMPLETION_REJECTED"))) break;
        await setRequest(id!, "REJECTED", { chain_status: "Rejected" });
        await setBin(req.bin_id, "NORMAL");
        if (req.assigned_worker_id) {
          const w = await getWorker(req.assigned_worker_id);
          const free = ["AWAITING_VERIFICATION", "COMPLETED"].includes(w.status);
          await setWorker(w.id, free ? "AVAILABLE" : null, { rejected_count: w.rejected_count + 1 });
        }
        await q(`UPDATE payments SET status = 'CANCELLED', updated_at = now(), error = 'Collection rejected' WHERE request_id = $1`, [id]);
        publish("payment", await one(`SELECT * FROM payments WHERE request_id = $1`, [id]));
        await record({
          stage: "COMPLETION_REJECTED",
          message: `Collection rejected by ${officerLabel(a.officer, actor)}; escrow returned to the fund`,
          actor: actorLabel(actor),
          tone: "danger",
          requestId: id,
          binId: req.bin_id,
          workerId: req.assigned_worker_id,
          txId: tx.id,
        });
        break;
      }
      case "PaymentReleased": {
        if (!(await once(tx, "PAYMENT_CONFIRMED"))) break;
        const workerId = String(a.workerId);
        const w = await getWorker(workerId);
        await setPayment(id!, "PAID", { tx_id: tx.id, paid_at: new Date(), error: null });
        await setRequest(id!, null, { chain_status: "Paid" });
        // Only free the worker if they aren't already out on a newer job.
        const free = ["AWAITING_VERIFICATION", "COMPLETED"].includes(w.status);
        await setWorker(workerId, free ? "AVAILABLE" : null, { completed_count: w.completed_count + 1 });
        await record({
          stage: "PAYMENT_CONFIRMED",
          message: `${mstc(a.amount)} MSTC paid to ${w.name} (${short(String(a.wallet))})`,
          actor: actorLabel(actor),
          tone: "success",
          requestId: id,
          binId: req.bin_id,
          workerId,
          txId: tx.id,
        });
        await notify({
          type: "PAYMENT_CONFIRMED",
          severity: "success",
          title: `Payment confirmed: ${mstc(a.amount)} MSTC`,
          body: `${w.name} was paid for ${requestCode(id!)} on ${config.networkLabel}.`,
          requestId: id,
          binId: req.bin_id,
          workerId,
        });
        // The bin shows "completed" for a moment, then returns to service.
        setTimeout(async () => {
          const b = await one(`SELECT status FROM bins WHERE id = $1`, [req.bin_id]);
          if (b?.status === "COMPLETED") await setBin(req.bin_id, "NORMAL").catch(() => undefined);
        }, 20_000);
        break;
      }
      case "IncidentRecorded": {
        if (!(await once(tx, "INCIDENT_RECORDED"))) break;
        await record({
          stage: "INCIDENT_RECORDED",
          message: `Incident #${a.incidentId} recorded on-chain for ${a.binId}`,
          actor: "gateway",
          tone: "warning",
          requestId: Number(a.requestId) || null,
          binId: typeof a.binId === "string" && a.binId.startsWith("BIN-") ? a.binId : null,
          txId: tx.id,
        });
        break;
      }
    }
  }
}

// ===========================================================================
// 1. Detection → AI fullness verification → on-chain collection request
// ===========================================================================

export async function onThresholdCrossed(binId: string, scenario?: string | null) {
  return withLock(`bin:${binId}`, async () => {
    const bin = await getBin(binId);
    if (bin.status !== "NORMAL" || !bin.online) return;
    if (await activeRequestForBin(binId)) return;

    const id = await nextRequestId();
    const fill = round1(bin.fill_pct);
    const priority = fill >= 97 ? "critical" : fill >= 92 || bin.capacity_litres >= 1000 ? "high" : "normal";
    await q(
      `INSERT INTO collection_requests (id, code, bin_id, municipality_id, status, priority, detected_fill, detected_at, scenario)
       VALUES ($1,$2,$3,$4,'DETECTED',$5,$6,now(),$7)`,
      [id, requestCode(id), binId, bin.municipality_id, priority, fill, scenario ?? null],
    );
    publish("request", await one(`SELECT * FROM collection_requests WHERE id = $1`, [id]));
    await setBin(binId, "FULL");
    await record({
      stage: "BIN_FULL_DETECTED",
      message: `${binId} crossed the ${bin.threshold_pct}% threshold (${fill}%)`,
      actor: `device:${binId}`,
      tone: "warning",
      requestId: id,
      binId,
      data: { fill, fill2: bin.fill2_pct },
    });

    await setBin(binId, "VERIFYING");
    await record({ stage: "AI_VERIFYING", message: "AI sensor-fusion verification started", actor: "ai", requestId: id, binId });

    const window = await telemetryWindow(binId, new Date(Date.now() - 5 * 60_000).toISOString(), 90);
    const fusion = verifyFullness({
      binId,
      thresholdPct: bin.threshold_pct,
      window,
      deviceAuthenticated: true, // ingest only accepts authenticated packets
      source: bin.source,
      minConfidence: config.ai.minConfidence,
    });
    const { row: ver, result, reportHash } = await runVerification(fusion, {
      requestId: id,
      binId,
      inputs: { binId, location: { lat: bin.lat, lng: bin.lng }, thresholdPct: bin.threshold_pct, source: bin.source },
    });
    publish("verification", ver);

    if (!result.verified) {
      const why = result.checks.find((c) => !c.pass)?.reason ?? "evidence inconsistent";
      await setRequest(id, "REJECTED", { rejection_reason: `AI rejected fullness: ${why}` });
      await setBin(binId, "NORMAL");
      await record({
        stage: "AI_FULLNESS_REJECTED",
        message: `AI rejected the fullness reading (${result.confidence}% confidence): ${why}`,
        actor: "ai",
        tone: "danger",
        requestId: id,
        binId,
        data: { verificationId: ver.id },
      });
      await notify({
        type: "AI_REJECTED",
        severity: "warning",
        title: `Fullness reading rejected at ${binId}`,
        body: why,
        requestId: id,
        binId,
      });
      // Public, tamper-evident record of the rejected detection.
      recordIncident(1, binId, id, reportHash).catch(() => undefined);
      return;
    }

    await setRequest(id, "AI_VERIFIED");
    await record({
      stage: "AI_FULLNESS_VERIFIED",
      message: `Bin fullness verified: ${result.confidence}% confidence`,
      actor: "ai",
      tone: "success",
      requestId: id,
      binId,
      data: { verificationId: ver.id, confidence: result.confidence },
    });

    const last = window[window.length - 1];
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const L = ledger();
        const report = {
          binId: idBytes(binId),
          fillPct: BigInt(Math.round(last.fill)),
          distanceMm: BigInt(Math.round((last.distanceCm ?? 0) * 10)),
          nonce: await nextDeviceNonce(binId),
          timestamp: unix(last.ts),
          evidenceHash: result.evidenceHash,
        };
        const verdict = {
          requestId: BigInt(id),
          binId: idBytes(binId),
          kind: 1,
          verified: true,
          confidenceBps: BigInt(Math.round(result.confidence * 100)),
          evidenceHash: result.evidenceHash,
          reportHash,
        };
        const binSig = await L.signTyped(deviceWallet(binId), "FullnessReport", report);
        const aiSig = await L.signTyped(L.verifier!, "AiVerdict", verdict);
        const { row, events } = await send("gateway", "createRequest", [id, report, binSig, verdict, aiSig], {
          action: "COLLECTION_REQUEST",
          requestId: id,
          binId,
        });
        await applyEvents(events, row);
        return;
      } catch (err) {
        lastErr = err;
        await sleep(4000);
      }
    }
    await setRequest(id, "REJECTED", { rejection_reason: `Could not record on ${config.networkLabel}: ${(lastErr as Error)?.message}` });
    await setBin(binId, "NORMAL");
  });
}

export async function recordIncident(kind: number, binId: string, requestId: number, detailsHash: string) {
  const { row, events } = await send("gateway", "recordIncident", [kind, idBytes(binId), requestId, detailsHash], {
    action: "INCIDENT",
    requestId,
    binId,
  });
  await applyEvents(events, row);
}

// ===========================================================================
// 2. Municipal decisions (server officer wallet). BridgeKey uses observeWalletTx.
// ===========================================================================

function requireStatus(r: any, allowed: RequestStatus[], what: string) {
  if (!allowed.includes(r.status)) throw new WorkflowError(`${r.code} is ${r.status.replace(/_/g, " ").toLowerCase()}; cannot ${what}`, 409);
}

export async function approveRequest(id: number, actor: Actor) {
  const r = await getRequest(id);
  requireStatus(r, ["AWAITING_APPROVAL"], "approve");
  const { row, events } = await send("officer", "approveRequest", [id], { action: "MUNICIPAL_APPROVAL", requestId: id, binId: r.bin_id });
  await applyEvents(events, row, actor);
  return getRequest(id);
}

export async function rejectRequest(id: number, actor: Actor, reason: string) {
  const r = await getRequest(id);
  requireStatus(r, ["AWAITING_APPROVAL", "APPROVED"], "reject");
  await setRequest(id, null, { rejection_reason: reason || "Rejected by municipality" });
  const { row, events } = await send("officer", "rejectRequest", [id, ethers.id(reason || "rejected")], {
    action: "REQUEST_REJECTION",
    requestId: id,
    binId: r.bin_id,
  });
  await applyEvents(events, row, actor);
  return getRequest(id);
}

export function payoutWei(amountMstc?: string | number | null) {
  const v = amountMstc === undefined || amountMstc === null || amountMstc === "" ? config.payment.defaultMstc : String(amountMstc);
  return ethers.parseEther(v);
}

export async function assignWorker(id: number, workerId: string, actor: Actor, amountMstc?: string | number | null) {
  const r = await getRequest(id);
  requireStatus(r, ["APPROVED"], "assign a worker");
  const worker = await getWorker(workerId);
  if (!WORKER_FREE.includes(worker.status) || (await activeAssignmentForWorker(workerId))) {
    throw new WorkflowError(`${worker.name} is busy (${worker.status.toLowerCase().replace(/_/g, " ")})`, 409);
  }
  const amount = payoutWei(amountMstc);
  const { row, events } = await send("officer", "assignWorker", [id, idBytes(workerId), amount], {
    action: "WORKER_ASSIGNMENT",
    requestId: id,
    binId: r.bin_id,
    workerId,
    wallet: worker.wallet_address,
    valueWei: amount,
  });
  await applyEvents(events, row, actor);
  return getRequest(id);
}

export async function cancelAssignment(id: number, actor: Actor, reason: string) {
  const r = await getRequest(id);
  requireStatus(r, ["ASSIGNED", "EN_ROUTE"], "cancel the assignment");
  const { row, events } = await send("officer", "cancelAssignment", [id, ethers.id(reason || "cancelled")], {
    action: "ASSIGNMENT_CANCELLED",
    requestId: id,
    binId: r.bin_id,
    workerId: r.assigned_worker_id,
  });
  await applyEvents(events, row, actor);
  return getRequest(id);
}

export async function openInvestigation(id: number, actor: Actor, reason: string) {
  const r = await getRequest(id);
  requireStatus(r, ["AWAITING_FINAL_APPROVAL"], "open an investigation");
  await setRequest(id, null, { investigation_reason: reason || "Opened by municipal officer" });
  const { row, events } = await send("officer", "openInvestigation", [id, ethers.id(reason || "investigate")], {
    action: "INVESTIGATION",
    requestId: id,
    binId: r.bin_id,
    workerId: r.assigned_worker_id,
  });
  await applyEvents(events, row, actor);
  return getRequest(id);
}

export async function approveCompletion(id: number, actor: Actor, note: string) {
  const r = await getRequest(id);
  requireStatus(r, ["AWAITING_FINAL_APPROVAL", "INVESTIGATION"], "approve the collection");
  const { row, events } = await send("officer", "approveCompletion", [id, ethers.id(note || "approved")], {
    action: "COMPLETION_APPROVAL",
    requestId: id,
    binId: r.bin_id,
    workerId: r.assigned_worker_id,
  });
  await applyEvents(events, row, actor);
  return getRequest(id);
}

export async function rejectCompletion(id: number, actor: Actor, reason: string) {
  const r = await getRequest(id);
  requireStatus(r, ["AWAITING_FINAL_APPROVAL", "INVESTIGATION"], "reject the collection");
  await setRequest(id, null, { rejection_reason: reason || "Collection rejected" });
  const { row, events } = await send("officer", "rejectCompletion", [id, ethers.id(reason || "rejected")], {
    action: "COMPLETION_REJECTION",
    requestId: id,
    binId: r.bin_id,
    workerId: r.assigned_worker_id,
  });
  await applyEvents(events, row, actor);
  return getRequest(id);
}

export async function releasePayment(id: number, actor: Actor) {
  const r = await getRequest(id);
  requireStatus(r, ["COMPLETED"], "release payment");
  const p = await one(`SELECT * FROM payments WHERE request_id = $1`, [id]);
  if (!p || !["READY", "FAILED"].includes(p.status)) throw new WorkflowError(`Payment is ${p?.status ?? "missing"}`, 409);
  await setPayment(id, "SIGNING", { signer: "municipal-wallet", error: null });
  try {
    const { row, events } = await ledger().send(
      "officer",
      "releasePayment",
      [id],
      { action: "WORKER_PAYMENT", requestId: id, binId: r.bin_id, workerId: p.worker_id, wallet: p.wallet_address, valueWei: p.amount_wei },
      {
        onSubmitted: async (tx) => {
          await setPayment(id, "SUBMITTED", { tx_id: tx.id });
          await record({
            stage: "PAYMENT_INITIATED",
            message: `Payment of ${mstc(p.amount_wei)} MSTC broadcast to ${config.networkLabel}`,
            actor: actorLabel(actor),
            tone: "progress",
            requestId: id,
            binId: r.bin_id,
            workerId: p.worker_id,
            txId: tx.id,
          });
          await setPayment(id, "CONFIRMING");
        },
      },
    );
    await applyEvents(events, row, actor);
  } catch (err) {
    const reason = err instanceof ChainError ? humanizeReason(err.reason) : (err as Error).message;
    await setPayment(id, "FAILED", { error: reason });
    await record({ stage: "PAYMENT_FAILED", message: `Payment failed: ${reason}`, actor: actorLabel(actor), tone: "danger", requestId: id, binId: r.bin_id });
    await notify({ type: "CHAIN_FAILED", severity: "critical", title: "Payment transaction failed", body: reason, requestId: id, workerId: p.worker_id });
    throw new WorkflowError(`Payment failed: ${reason}`, 409);
  }
  return one(`SELECT * FROM payments WHERE request_id = $1`, [id]);
}

/** BridgeKey: the officer signs in the browser; the server observes and applies the result. */
export async function beginWalletPayment(id: number) {
  const p = await one(`SELECT * FROM payments WHERE request_id = $1`, [id]);
  if (!p || !["READY", "FAILED"].includes(p.status)) throw new WorkflowError(`Payment is ${p?.status ?? "missing"}`, 409);
  return setPayment(id, "SIGNING", { signer: "bridgekey", error: null });
}

export async function abortWalletPayment(id: number, reason: string) {
  const p = await one(`SELECT * FROM payments WHERE request_id = $1`, [id]);
  if (p?.status === "SIGNING") return setPayment(id, "READY", { error: reason || "Signature request cancelled" });
  return p;
}

const WALLET_ACTIONS: Record<string, { method: string; action: string }> = {
  approveRequest: { method: "approveRequest", action: "MUNICIPAL_APPROVAL" },
  rejectRequest: { method: "rejectRequest", action: "REQUEST_REJECTION" },
  assignWorker: { method: "assignWorker", action: "WORKER_ASSIGNMENT" },
  cancelAssignment: { method: "cancelAssignment", action: "ASSIGNMENT_CANCELLED" },
  openInvestigation: { method: "openInvestigation", action: "INVESTIGATION" },
  approveCompletion: { method: "approveCompletion", action: "COMPLETION_APPROVAL" },
  rejectCompletion: { method: "rejectCompletion", action: "COMPLETION_REJECTION" },
  releasePayment: { method: "releasePayment", action: "WORKER_PAYMENT" },
};

/** Free-text reasons stay off-chain; the ledger holds their keccak hash. */
const REASON_FIELDS: Record<string, { event: string; column: "rejection_reason" | "investigation_reason" }> = {
  rejectRequest: { event: "RequestRejected", column: "rejection_reason" },
  rejectCompletion: { event: "CompletionRejected", column: "rejection_reason" },
  openInvestigation: { event: "InvestigationOpened", column: "investigation_reason" },
};

export async function observeWalletTx(hash: string, method: string, requestId: number, actor: Actor, note?: string) {
  const spec = WALLET_ACTIONS[method];
  if (!spec) throw new WorkflowError(`Unsupported wallet action ${method}`);
  const r = await getRequest(requestId);
  const p = await one(`SELECT * FROM payments WHERE request_id = $1`, [requestId]);
  const meta: TxMeta = {
    action: spec.action,
    requestId,
    binId: r.bin_id,
    workerId: r.assigned_worker_id,
    wallet: method === "releasePayment" ? p?.wallet_address : null,
    valueWei: method === "releasePayment" ? p?.amount_wei : null,
  };
  if (method === "releasePayment" && p && ["SIGNING", "READY", "FAILED"].includes(p.status)) {
    await setPayment(requestId, "SUBMITTED", { signer: "bridgekey" });
    await setPayment(requestId, "CONFIRMING");
  }
  try {
    const { row, events } = await ledger().observe(hash, meta);
    if (method === "releasePayment") await q(`UPDATE payments SET tx_id = $2 WHERE request_id = $1`, [requestId, row.id]);
    if (row.method !== spec.method) throw new WorkflowError(`Transaction called ${row.method}, expected ${spec.method}`);
    const rf = REASON_FIELDS[method];
    const ev = rf && note ? events.find((e) => e.name === rf.event && Number(e.args.requestId) === requestId) : null;
    // Only keep the text if it hashes to what the officer actually signed.
    if (rf && ev && String(ev.args.reasonHash).toLowerCase() === ethers.id(note!).toLowerCase()) {
      await setRequest(requestId, null, { [rf.column]: note });
    }
    await applyEvents(events, row, actor);
    return row;
  } catch (err) {
    if (method === "releasePayment") await setPayment(requestId, "FAILED", { error: (err as Error).message }).catch(() => undefined);
    throw err instanceof WorkflowError ? err : new WorkflowError((err as Error).message, 409);
  }
}

// ===========================================================================
// 3. Worker movement
// ===========================================================================

export async function updateWorkerLocation(workerId: string, lat: number, lng: number, source: "simulation" | "gps", accuracyM?: number) {
  const w = await getWorker(workerId);
  if (source === "simulation" && w.location_source === "gps" && Date.now() - new Date(w.location_updated_at).getTime() < 60_000) {
    return; // a real phone is reporting; don't fight it
  }
  await q(
    `UPDATE workers SET lat = $2, lng = $3, location_source = $4, location_updated_at = now() WHERE id = $1`,
    [workerId, lat, lng, source],
  );
  await q(`INSERT INTO worker_locations (worker_id, ts, lat, lng, accuracy_m, source) VALUES ($1, now(), $2, $3, $4, $5)`, [
    workerId,
    lat,
    lng,
    accuracyM ?? null,
    source,
  ]);
  publish("worker.location", { workerId, lat, lng, source });

  const job = await activeAssignmentForWorker(workerId);
  if (job && ["ASSIGNED", "EN_ROUTE"].includes(job.status)) {
    const bin = await getBin(job.bin_id);
    const d = haversineKm({ lat, lng }, { lat: bin.lat, lng: bin.lng }) * 1000;
    if (d <= 40) await markArrived(workerId);
  }
}

export async function markEnRoute(workerId: string) {
  const w = await getWorker(workerId);
  const job = await activeAssignmentForWorker(workerId);
  if (!job || job.status !== "ASSIGNED") return;
  await q(`UPDATE assignments SET status = 'EN_ROUTE', en_route_at = now() WHERE id = $1`, [job.id]);
  await setWorker(workerId, "EN_ROUTE");
  await setRequest(job.request_id, "EN_ROUTE");
  await record({
    stage: "WORKER_EN_ROUTE",
    message: `${w.name} is on the way to ${job.bin_id} (${job.distance_km} km, ETA ${job.eta_min} min)`,
    actor: `worker:${w.name}`,
    tone: "progress",
    requestId: job.request_id,
    binId: job.bin_id,
    workerId,
  });
}

export async function markArrived(workerId: string) {
  const w = await getWorker(workerId);
  const job = await activeAssignmentForWorker(workerId);
  if (!job || !["ASSIGNED", "EN_ROUTE"].includes(job.status)) return;
  if (job.status === "ASSIGNED") await markEnRoute(workerId);
  await q(`UPDATE assignments SET status = 'AT_BIN', arrived_at = now() WHERE id = $1`, [job.id]);
  await setWorker(workerId, "AT_BIN");
  await record({
    stage: "WORKER_ARRIVED",
    message: `${w.name} arrived at ${job.bin_id}`,
    actor: `worker:${w.name}`,
    tone: "info",
    requestId: job.request_id,
    binId: job.bin_id,
    workerId,
  });
  await notify({ type: "WORKER_ARRIVED", severity: "info", title: `${w.name} arrived at ${job.bin_id}`, body: "Waiting for RFID authentication.", requestId: job.request_id, binId: job.bin_id, workerId });
}

// ===========================================================================
// 4. RFID at the bin
// ===========================================================================

type Session = {
  requestId: number;
  workerId: string;
  rfidAt: string;
  beforeFill: number;
  lidOpenedAt: string | null;
  lidClosedAt: string | null;
  dropRecorded: boolean;
  finalizeTimer: NodeJS.Timeout | null;
};
const sessions = new Map<string, Session>();

export function collectionSession(binId: string) {
  return sessions.get(binId) ?? null;
}

export async function handleRfidTap(binId: string, uidRaw: string, source: "hardware" | "simulation" | "dashboard") {
  return withLock(`bin:${binId}`, async () => {
    const bin = await getBin(binId);
    const uid = normalizeUid(uidRaw);
    const tagHash = rfidHash(uid);
    const worker = await one(`SELECT * FROM workers WHERE rfid_uid = $1`, [uid]);
    const req = await one(
      `SELECT * FROM collection_requests WHERE bin_id = $1 AND status IN ('ASSIGNED','EN_ROUTE','COLLECTING') ORDER BY id DESC LIMIT 1`,
      [binId],
    );
    const distanceM = worker?.lat != null ? Math.round(haversineKm({ lat: worker.lat, lng: worker.lng }, { lat: bin.lat, lng: bin.lng }) * 1000) : null;
    const assignment = req ? await one(`SELECT * FROM assignments WHERE request_id = $1 AND status <> 'CANCELLED' ORDER BY id DESC LIMIT 1`, [req.id]) : null;

    const checks = [
      { id: "CARD", label: "Worker identity", pass: !!worker, observed: worker ? `${worker.name} (${worker.id})` : `unknown card ${uid}` },
      { id: "WALLET", label: "Worker wallet", pass: !!worker?.wallet_address, observed: worker ? short(worker.wallet_address) : "none" },
      {
        id: "ASSIGNMENT",
        label: "Assigned request",
        pass: !!req && !!worker && req.assigned_worker_id === worker.id,
        observed: req ? `${req.code} → ${req.assigned_worker_id}` : "no active assignment at this bin",
      },
      { id: "BIN", label: "Bin ID", pass: !!req && req.bin_id === binId, observed: binId },
      {
        id: "LOCATION",
        label: "Location",
        pass: distanceM === null || distanceM <= 150,
        observed: distanceM === null ? "no GPS" : `${distanceM} m from bin`,
      },
      {
        id: "TIMESTAMP",
        label: "Timestamp",
        pass: !assignment || Date.now() >= new Date(assignment.assigned_at).getTime(),
        observed: new Date().toISOString(),
      },
    ];

    let result: "RFID_VERIFIED" | "RFID_MISMATCH" | "UNASSIGNED_WORKER" | "INVALID_CARD" | "VERIFICATION_PENDING";
    if (!worker) result = "INVALID_CARD";
    else if (!req) result = "UNASSIGNED_WORKER";
    else if (req.assigned_worker_id !== worker.id) result = "RFID_MISMATCH";
    else if (req.status === "COLLECTING") result = "RFID_VERIFIED";
    else result = "VERIFICATION_PENDING";

    const [ev] = await q(
      `INSERT INTO rfid_events (bin_id, request_id, worker_id, tag_uid, tag_hash, result, checks, distance_m, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [binId, req?.id ?? null, worker?.id ?? null, uid, tagHash, result, JSON.stringify(checks), distanceM, source],
    );
    publish("rfid", ev);

    if (result === "INVALID_CARD" || result === "UNASSIGNED_WORKER") {
      await setBin(binId, null, { rfid_state: result === "INVALID_CARD" ? "invalid" : "unassigned" });
      await record({
        stage: "RFID_REJECTED",
        message:
          result === "INVALID_CARD"
            ? `Unknown RFID card ${uid} at ${binId}; lid stays locked`
            : `${worker.name} tapped ${binId} without an assignment; lid stays locked`,
        actor: `device:${binId}`,
        tone: "danger",
        requestId: req?.id ?? null,
        binId,
        workerId: worker?.id ?? null,
      });
      await notify({
        type: "RFID_MISMATCH",
        severity: "critical",
        title: result === "INVALID_CARD" ? `Invalid RFID card at ${binId}` : `Unassigned worker at ${binId}`,
        body: result === "INVALID_CARD" ? `Card ${uid} is not registered.` : `${worker.name} has no assignment at this bin.`,
        binId,
        workerId: worker?.id ?? null,
      });
      return { result, action: "deny" as const, message: result === "INVALID_CARD" ? "Card not registered" : "No job at this bin", checks };
    }

    if (result === "RFID_MISMATCH") {
      await setBin(binId, null, { rfid_state: "mismatch" });
      await notify({
        type: "RFID_MISMATCH",
        severity: "critical",
        title: `RFID mismatch at ${binId}`,
        body: `${worker.name} tapped, but ${req.code} is assigned to ${req.assigned_worker_id}.`,
        requestId: req.id,
        binId,
        workerId: worker.id,
      });
      submitRfidOnChain(binId, req.id, tagHash).catch(() => undefined);
      return { result, action: "deny" as const, message: "Not your assignment", checks };
    }

    if (result === "RFID_VERIFIED") {
      return { result, action: "unlock" as const, message: "Already verified", checks };
    }

    // Off-chain checks passed: unlock now, prove it on-chain in the background.
    if (worker.status === "ASSIGNED" || worker.status === "EN_ROUTE") await markArrived(worker.id);
    await q(`UPDATE assignments SET rfid_at = now() WHERE id = $1`, [assignment?.id ?? 0]);
    const beforeFill = round1(bin.fill_pct);
    sessions.set(binId, {
      requestId: req.id,
      workerId: worker.id,
      rfidAt: new Date().toISOString(),
      beforeFill,
      lidOpenedAt: null,
      lidClosedAt: null,
      dropRecorded: false,
      finalizeTimer: null,
    });
    await setBin(binId, null, { rfid_state: "verified", servo_state: "unlocked" });
    await queueCommand(binId, "UNLOCK_LID", { requestId: req.id, workerId: worker.id });
    await record({
      stage: "SERVO_UNLOCKED",
      message: `RFID accepted for ${worker.name}; servo unlocked the lid`,
      actor: `device:${binId}`,
      tone: "info",
      requestId: req.id,
      binId,
      workerId: worker.id,
    });
    submitRfidOnChain(binId, req.id, tagHash).catch(() => undefined);
    return { result: "RFID_VERIFIED" as const, action: "unlock" as const, message: `Welcome ${worker.name.split(" ")[0]}`, checks };
  });
}

async function submitRfidOnChain(binId: string, requestId: number, tagHash: string) {
  const L = ledger();
  const scan = { requestId: BigInt(requestId), binId: idBytes(binId), tagHash, nonce: await nextDeviceNonce(binId), timestamp: unix(new Date()) };
  const sig = await L.signTyped(deviceWallet(binId), "RfidScan", scan);
  const r = await getRequest(requestId);
  const { row, events } = await send("gateway", "recordRfid", [scan, sig], {
    action: "RFID_VERIFICATION",
    requestId,
    binId,
    workerId: r.assigned_worker_id,
  });
  await applyEvents(events, row);
}

// ===========================================================================
// 5. Collection monitoring → AI completion verification → on-chain evidence
// ===========================================================================

/** Called by telemetry ingest for every packet from a bin with an open session. */
export async function onCollectionTelemetry(binId: string, prevLid: string, sample: { fill: number; lid: string; ts: string }) {
  const s = sessions.get(binId);
  if (!s) return;
  const req = await getRequest(s.requestId);

  if (prevLid !== "open" && sample.lid === "open") {
    if (s.finalizeTimer) {
      clearTimeout(s.finalizeTimer); // lid re-opened: keep collecting
      s.finalizeTimer = null;
    }
    await q(`INSERT INTO collection_events (request_id, bin_id, type, data, ts) VALUES ($1,$2,'LID_OPENED',$3,$4)`, [
      s.requestId,
      binId,
      JSON.stringify({ fill: sample.fill }),
      sample.ts,
    ]);
    await setBin(binId, null, { lid_state: "open" });
    if (!s.lidOpenedAt) {
      s.lidOpenedAt = sample.ts;
      await q(`UPDATE assignments SET status = 'COLLECTING', started_at = $2 WHERE request_id = $1 AND status <> 'CANCELLED'`, [s.requestId, sample.ts]);
      const w = await getWorker(s.workerId);
      if (w.status === "AT_BIN") await setWorker(s.workerId, "COLLECTING");
      await record({
        stage: "COLLECTION_STARTED",
        message: `Lid opened. ${w.name} started collecting (${Math.round(s.beforeFill)}% full)`,
        actor: `device:${binId}`,
        tone: "progress",
        requestId: s.requestId,
        binId,
        workerId: s.workerId,
      });
    }
  }

  if (!s.dropRecorded && s.beforeFill - sample.fill >= 15) {
    s.dropRecorded = true;
    await record({
      stage: "LEVEL_DROPPING",
      message: `Waste level dropping: ${Math.round(s.beforeFill)}% → ${Math.round(sample.fill)}%`,
      actor: `device:${binId}`,
      tone: "progress",
      requestId: s.requestId,
      binId,
      workerId: s.workerId,
    });
  }

  if (prevLid === "open" && sample.lid !== "open") {
    s.lidClosedAt = sample.ts;
    await q(`INSERT INTO collection_events (request_id, bin_id, type, data, ts) VALUES ($1,$2,'LID_CLOSED',$3,$4)`, [
      s.requestId,
      binId,
      JSON.stringify({ fill: sample.fill }),
      sample.ts,
    ]);
    // Give the reading a few seconds to settle, unless the lid opens again.
    if (s.finalizeTimer) clearTimeout(s.finalizeTimer);
    s.finalizeTimer = setTimeout(() => {
      finalizeCollection(binId).catch((err) => console.error("finalize failed", err));
    }, 4000 / config.sim.pace);
  }
  void req;
}

async function finalizeCollection(binId: string) {
  const s = sessions.get(binId);
  if (!s) return;
  sessions.delete(binId);

  // The on-chain RFID proof must be in before completion evidence can be.
  for (let i = 0; i < 60; i++) {
    const r = await getRequest(s.requestId);
    if (r.status === "COLLECTING") break;
    await sleep(1000);
  }
  const req = await getRequest(s.requestId);
  if (req.status !== "COLLECTING") {
    await record({ stage: "CHAIN_ERROR", message: `RFID proof for ${req.code} never confirmed; completion not submitted`, actor: "system", tone: "danger", requestId: req.id, binId });
    return;
  }

  const recent = await telemetryWindow(binId, null, 3);
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const after = round1(median(recent.map((x) => x.fill)));
  const f2 = recent.map((x) => x.fill2).filter((x): x is number => x !== null);
  const after2 = f2.length ? round1(median(f2)) : null;
  const before = s.beforeFill;

  await setRequest(req.id, "REVERIFYING", { fill_before: before, fill_after: after });
  await setBin(binId, "VERIFYING_EMPTY", { lid_state: "closed", servo_state: "locked", rfid_state: "idle" });
  await queueCommand(binId, "LOCK_LID", { requestId: req.id });
  const w = await getWorker(s.workerId);
  if (["COLLECTING", "AT_BIN"].includes(w.status)) {
    if (w.status === "AT_BIN") await setWorker(w.id, "COLLECTING");
    await setWorker(w.id, "AWAITING_VERIFICATION");
  }
  await record({
    stage: "BIN_EMPTIED_DETECTED",
    message: before - after >= 5 ? `Waste level reduced from ${Math.round(before)}% → ${Math.round(after)}%; lid closed` : `Lid closed; level unchanged at ${Math.round(after)}%`,
    actor: `device:${binId}`,
    tone: before - after >= 50 ? "success" : "warning",
    requestId: req.id,
    binId,
    workerId: w.id,
    data: { before, after, after2 },
  });
  await record({ stage: "AI_REVERIFYING", message: "AI completion verification started", actor: "ai", requestId: req.id, binId });

  const assignment = await one(`SELECT * FROM assignments WHERE request_id = $1 AND status <> 'CANCELLED' ORDER BY id DESC LIMIT 1`, [req.id]);
  const rfid = await one(`SELECT * FROM rfid_events WHERE request_id = $1 AND worker_id = $2 AND result IN ('RFID_VERIFIED','VERIFICATION_PENDING') ORDER BY id DESC LIMIT 1`, [req.id, w.id]);
  const window = await telemetryWindow(binId, new Date(Date.parse(s.rfidAt) - 10_000).toISOString(), 200);
  const bin = await getBin(binId);
  const distanceM = w.lat != null ? haversineKm({ lat: w.lat, lng: w.lng }, { lat: bin.lat, lng: bin.lng }) * 1000 : null;

  const fusion = verifyCompletion({
    binId,
    requestId: req.id,
    before,
    after,
    after2,
    window,
    rfidVerified: !!rfid,
    rfidWorker: w.name,
    assignedWorker: w.name,
    rfidAt: s.rfidAt,
    lidOpenedAt: s.lidOpenedAt,
    lidClosedAt: s.lidClosedAt,
    assignedAt: assignment ? new Date(assignment.assigned_at).toISOString() : null,
    workerDistanceM: distanceM,
    minConfidence: config.ai.minConfidence,
    requireWeight: config.verify.requireWeight && bin.source === "hardware",
    minWeightRemovedG: config.verify.minWeightRemovedG,
  });
  const { row: ver, result, reportHash } = await runVerification(fusion, {
    requestId: req.id,
    binId,
    inputs: { binId, workerId: w.id, assignmentId: assignment?.id ?? null, before, after, after2 },
  });
  publish("verification", ver);

  const L = ledger();
  const opened = s.lidOpenedAt ?? s.rfidAt;
  const closed = s.lidClosedAt ?? new Date().toISOString();
  const evidence = {
    requestId: BigInt(req.id),
    binId: idBytes(binId),
    fillBefore: BigInt(Math.round(before)),
    fillAfter: BigInt(Math.round(after)),
    lidOpenedAt: unix(opened),
    lidClosedAt: unix(closed),
    nonce: await nextDeviceNonce(binId),
    evidenceHash: result.evidenceHash,
  };
  const verdict = {
    requestId: BigInt(req.id),
    binId: idBytes(binId),
    kind: 2,
    verified: result.verified,
    confidenceBps: BigInt(Math.round(result.confidence * 100)),
    evidenceHash: result.evidenceHash,
    reportHash,
  };
  const binSig = await L.signTyped(deviceWallet(binId), "CollectionEvidence", evidence);
  const aiSig = await L.signTyped(L.verifier!, "AiVerdict", verdict);
  const { row, events } = await send("gateway", "submitCompletion", [evidence, binSig, verdict, aiSig], {
    action: "COLLECTION_COMPLETION",
    requestId: req.id,
    binId,
    workerId: w.id,
  });
  await applyEvents(events, row);
}

// ===========================================================================
// 6. Recovery
// ===========================================================================

/** Replays confirmed events for transactions that were still pending. */
export async function reconcile() {
  for (const { row, events } of await ledger().reconcilePending()) await applyEvents(events, row);
}

export async function candidates(requestId: number) {
  const r = await getRequest(requestId);
  return rankWorkers(r.bin_id);
}

export { TransitionError, CHAIN_STATUS };
