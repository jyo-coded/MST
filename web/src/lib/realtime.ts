import type { QueryClient } from "@tanstack/react-query";
import { useLive, useSession } from "./store";
import type { LifecycleEvent } from "./types";

/**
 * One EventSource per tab. Telemetry and worker positions go straight into the
 * live store (no refetch); state changes invalidate the queries that show
 * them, batched so a burst of events costs one refetch.
 */
export function startRealtime(qc: QueryClient) {
  let es: EventSource | null = null;
  let token: string | null = null;
  const pending = new Set<string>();
  let timer: number | null = null;

  const invalidate = (...keys: unknown[][]) => {
    for (const k of keys) pending.add(JSON.stringify(k));
    if (timer === null) {
      timer = window.setTimeout(() => {
        timer = null;
        for (const k of pending) qc.invalidateQueries({ queryKey: JSON.parse(k) });
        pending.clear();
      }, 250);
    }
  };

  const live = useLive.getState;

  const onMessage = (m: MessageEvent) => {
    const { type, data } = JSON.parse(m.data);
    switch (type) {
      case "telemetry":
        useLive.setState((s) => ({
          telemetry: {
            ...s.telemetry,
            [data.binId]: { fill: data.fill, fill2: data.fill2, lid: data.lid, servo: data.servo, ir: data.ir, irCount: data.irCount, ts: data.ts, source: data.source },
          },
        }));
        break;
      case "worker.location":
        useLive.setState((s) => ({ workers: { ...s.workers, [data.workerId]: { lat: data.lat, lng: data.lng, source: data.source } } }));
        break;
      case "feed": {
        const e = present(data);
        live().pushFeed(e);
        invalidate(["overview"], ["requests"], ["active"], ["bins"], ["me-job"]);
        if (e.requestId) invalidate(["request", e.requestId]);
        if (e.binId) invalidate(["bin", e.binId]);
        if (e.workerId) invalidate(["worker", e.workerId]);
        break;
      }
      case "notification":
        invalidate(["notifications"]);
        useLive.setState({ lastNotification: data });
        const echo = data.severity === "success" && Date.now() < live().quietUntil;
        if (data.severity !== "info" && !echo) {
          live().toast({
            tone: data.severity === "critical" ? "danger" : data.severity === "success" ? "success" : "warning",
            title: data.title,
            body: data.body ?? undefined,
            href: data.request_id ? `/app/requests/${data.request_id}` : undefined,
          });
        }
        break;
      case "request":
        invalidate(["requests"], ["request", data.id], ["overview"], ["bins"], ["active"]);
        break;
      case "bin":
        invalidate(["bins"], ["bin", data.id]);
        break;
      case "worker":
        invalidate(["workers"], ["worker", data.id], ["candidates"], ["me-job"]);
        break;
      case "payment":
        invalidate(["payments"], ["request", data.request_id], ["overview"], ["me-job"], ["workers"]);
        break;
      case "tx":
        invalidate(["txs"], ["chain-status"], ["health"]);
        if (data.request_id) invalidate(["request", data.request_id]);
        break;
      case "tx.progress":
        useLive.setState({ txProgress: { ...data, at: Date.now() } });
        break;
      case "verification":
        invalidate(["verifications"]);
        break;
      case "rfid":
        if (data.requestId || data.request_id) invalidate(["request", data.requestId ?? data.request_id]);
        break;
      case "sim.autopilot":
        useLive.setState({ autopilot: data });
        invalidate(["sim"]);
        break;
      case "system.mode":
        invalidate(["config"], ["sim"], ["health"]);
        break;
    }
  };

  const connect = () => {
    const t = useSession.getState().token;
    if (t === token && es) return;
    es?.close();
    es = null;
    token = t;
    if (!t) return;
    es = new EventSource(`/api/stream?token=${encodeURIComponent(t)}`);
    es.onopen = () => useLive.setState({ connected: true });
    es.onerror = () => useLive.setState({ connected: false });
    es.onmessage = onMessage;
  };

  connect();
  useSession.subscribe(connect);
}

/** Server rows (snake_case) → the LifecycleEvent shape used by the feed. */
function present(e: any): LifecycleEvent {
  return {
    id: Number(e.id),
    stage: e.stage,
    label: e.stage,
    message: e.message,
    actor: e.actor,
    tone: e.tone,
    requestId: e.request_id,
    binId: e.bin_id,
    workerId: e.worker_id,
    ts: e.ts,
    tx: null,
    data: e.data,
  };
}
