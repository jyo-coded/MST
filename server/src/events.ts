import type { Tone } from "@astra/shared";
import { q } from "./db";
import { publish } from "./realtime";

/**
 * The lifecycle log. Every row is a moment in a collection's story (and the
 * live event feed on the dashboard), optionally tied to the MST transaction
 * that proves it.
 */
export async function record(e: {
  stage: string;
  message: string;
  actor: string;
  tone?: Tone;
  requestId?: number | null;
  binId?: string | null;
  workerId?: string | null;
  txId?: number | null;
  data?: unknown;
}) {
  const [row] = await q(
    `INSERT INTO lifecycle_events (request_id, bin_id, worker_id, stage, message, actor, tone, tx_id, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      e.requestId ?? null,
      e.binId ?? null,
      e.workerId ?? null,
      e.stage,
      e.message,
      e.actor,
      e.tone ?? "info",
      e.txId ?? null,
      e.data === undefined ? null : JSON.stringify(e.data),
    ],
  );
  publish("feed", row);
  return row;
}

export async function notify(n: {
  type: string;
  severity: "info" | "success" | "warning" | "critical";
  title: string;
  body?: string;
  requestId?: number | null;
  binId?: string | null;
  workerId?: string | null;
}) {
  const [row] = await q(
    `INSERT INTO notifications (municipality_id, type, severity, title, body, request_id, bin_id, worker_id)
     VALUES ((SELECT id FROM municipalities LIMIT 1), $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [n.type, n.severity, n.title, n.body ?? null, n.requestId ?? null, n.binId ?? null, n.workerId ?? null],
  );
  publish("notification", row);
  return row;
}
