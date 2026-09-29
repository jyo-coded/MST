import { BIN, PAYMENT, REQUEST, WORKER, type BinStatus, type PaymentStatus, type RequestStatus, type WorkerStatus } from "@astra/shared";
import { one, q, setClause } from "../db";
import { publish } from "../realtime";

/**
 * All status changes go through these setters, which enforce the shared state
 * machines. An illegal transition is a bug (or an attack) and is refused.
 */
export class TransitionError extends Error {}

export async function setRequest(id: number, to: RequestStatus | null, patch: Record<string, unknown> = {}) {
  const cur = await one<{ status: RequestStatus }>(`SELECT status FROM collection_requests WHERE id = $1`, [id]);
  if (!cur) throw new TransitionError(`request ${id} not found`);
  if (to && !REQUEST.can(cur.status, to)) throw new TransitionError(`request ${id}: ${cur.status} → ${to} is not allowed`);
  const { sql, values } = setClause({ ...patch, ...(to ? { status: to } : {}), updated_at: new Date() }, 2);
  const [row] = await q(`UPDATE collection_requests SET ${sql} WHERE id = $1 RETURNING *`, [id, ...values]);
  publish("request", row);
  return row;
}

export async function setBin(id: string, to: BinStatus | null, patch: Record<string, unknown> = {}) {
  const cur = await one<{ status: BinStatus }>(`SELECT status FROM bins WHERE id = $1`, [id]);
  if (!cur) throw new TransitionError(`bin ${id} not found`);
  if (to && !BIN.can(cur.status, to)) throw new TransitionError(`bin ${id}: ${cur.status} → ${to} is not allowed`);
  const { sql, values } = setClause({ ...patch, ...(to ? { status: to } : {}) }, 2);
  const [row] = await q(`UPDATE bins SET ${sql} WHERE id = $1 RETURNING *`, [id, ...values]);
  publish("bin", row);
  return row;
}

export async function setWorker(id: string, to: WorkerStatus | null, patch: Record<string, unknown> = {}) {
  const cur = await one<{ status: WorkerStatus }>(`SELECT status FROM workers WHERE id = $1`, [id]);
  if (!cur) throw new TransitionError(`worker ${id} not found`);
  if (to && !WORKER.can(cur.status, to)) throw new TransitionError(`worker ${id}: ${cur.status} → ${to} is not allowed`);
  const { sql, values } = setClause({ ...patch, ...(to ? { status: to } : {}) }, 2);
  const [row] = await q(`UPDATE workers SET ${sql} WHERE id = $1 RETURNING *`, [id, ...values]);
  publish("worker", row);
  return row;
}

export async function setPayment(requestId: number, to: PaymentStatus, patch: Record<string, unknown> = {}) {
  const cur = await one<{ status: PaymentStatus }>(`SELECT status FROM payments WHERE request_id = $1`, [requestId]);
  if (!cur) throw new TransitionError(`payment for request ${requestId} not found`);
  if (!PAYMENT.can(cur.status, to)) throw new TransitionError(`payment ${requestId}: ${cur.status} → ${to} is not allowed`);
  const { sql, values } = setClause({ ...patch, status: to, updated_at: new Date() }, 2);
  const [row] = await q(`UPDATE payments SET ${sql} WHERE request_id = $1 RETURNING *`, [requestId, ...values]);
  publish("payment", row);
  return row;
}

/** Serialises workflow steps per key (bin id), so telemetry bursts can't race. */
const locks = new Map<string, Promise<unknown>>();
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}
