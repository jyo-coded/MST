import clsx from "clsx";
import { ArrowUpRight, Check, CircleAlert, Fingerprint, Lock, LockOpen, Truck, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { haversineKm } from "@astra/shared";
import { RequestActions } from "../components/Actions";
import { BinVisual } from "../components/BinVisual";
import { ConfidenceRing } from "../components/Evidence";
import { Timeline } from "../components/Lifecycle";
import { MapView } from "../components/MapView";
import { Avatar, Empty, PageHeader, Panel, Pill, Skeleton } from "../components/ui";
import { ago, duration, km, pct, time } from "../lib/format";
import { useLiveBin } from "../lib/live";
import { useActive, useRequest, useRequests } from "../lib/queries";
import { useLive } from "../lib/store";
import type { RequestDetail } from "../lib/types";

type StepState = "done" | "current" | "upcoming" | "failed" | "warning";
type Step = { key: string; label: string; ts: string | null; state: StepState; note?: string };

const last = <T,>(xs: T[], pred: (x: T) => boolean) => [...xs].reverse().find(pred);

/** Works out the field logistics of one collection from its recorded events. */
function logistics(d: RequestDetail): Step[] {
  const at = (stage: string) => last(d.lifecycle, (e) => e.stage === stage)?.ts ?? null;
  const has = (stage: string) => d.lifecycle.some((e) => e.stage === stage);
  const lidClosed = last(d.collectionEvents, (c) => c.type === "LID_CLOSED")?.ts ?? null;
  const steps: Step[] = [
    { key: "assigned", label: "Assigned", ts: at("WORKER_ASSIGNED"), state: "upcoming" },
    { key: "enroute", label: "En route", ts: at("WORKER_EN_ROUTE"), state: "upcoming" },
    { key: "arrived", label: "At the bin", ts: at("WORKER_ARRIVED"), state: "upcoming" },
    { key: "rfid", label: "RFID verified", ts: at("RFID_VERIFIED"), state: "upcoming" },
    { key: "unlock", label: "Lid unlocked", ts: at("SERVO_UNLOCKED") ?? at("COLLECTION_STARTED"), state: "upcoming" },
    { key: "removing", label: "Waste removed", ts: at("LEVEL_DROPPING"), state: "upcoming" },
    { key: "closed", label: "Lid closed", ts: lidClosed, state: "upcoming" },
    { key: "ai", label: "AI re-verified", ts: at("AI_COMPLETION_VERIFIED"), state: "upcoming" },
  ];
  for (const s of steps) if (s.ts) s.state = "done";
  // A later step happening means the earlier one did too (e.g. travel skipped in a demo).
  const lastDone = steps.map((s) => s.state).lastIndexOf("done");
  for (let i = 0; i < lastDone; i++) if (steps[i].state === "upcoming") steps[i].state = "done";

  const rfid = steps[3];
  if (rfid.state !== "done" && (has("RFID_MISMATCH") || has("RFID_REJECTED"))) {
    rfid.state = "warning";
    rfid.note = "Wrong card tapped";
  }
  const removing = steps[5];
  if (removing.state !== "done" && lidClosed) {
    removing.state = "warning";
    removing.note = "Little change";
  }
  const ai = steps[7];
  if (has("AI_COMPLETION_REJECTED")) {
    ai.state = "failed";
    ai.ts = at("AI_COMPLETION_REJECTED");
    ai.note = "Not verified";
  }
  const active = ["ASSIGNED", "EN_ROUTE", "COLLECTING", "REVERIFYING"].includes(d.request.status);
  if (active) {
    const next = steps.find((s) => s.state === "upcoming");
    if (next) next.state = "current";
  }
  return steps;
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function Active() {
  const [params, setParams] = useSearchParams();
  const { data: active } = useActive();
  const { data: finished } = useRequests("final");
  const paramId = params.get("request") ? Number(params.get("request")) : null;
  const selectedId = paramId ?? active?.[0]?.id ?? null;

  return (
    <>
      <PageHeader title="Active collections" subtitle="Workers on the move and bins being emptied, with the sensors watching every step." />
      <div className="grid gap-6 xl:grid-cols-[290px_1fr]">
        <div className="min-w-0 space-y-6 self-start">
          <Panel title="In the field" subtitle={active ? `${active.length} collection${active.length === 1 ? "" : "s"}` : undefined} flush>
            {!active ? (
              <div className="p-4">
                <Skeleton className="h-16 w-full" />
              </div>
            ) : active.length === 0 ? (
              <div className="px-5 py-8 text-center text-[13px] text-ink-3">No worker is out right now.</div>
            ) : (
              <ul className="divide-y divide-line-2">
                {active.map((r) => (
                  <li key={r.id}>
                    <button onClick={() => setParams({ request: String(r.id) })} className={clsx("relative w-full px-5 py-3 text-left transition-colors hover:bg-raised", r.id === selectedId && "bg-raised")}>
                      {r.id === selectedId && <span className="absolute inset-y-0 left-0 w-[3px] bg-ink" />}
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[12.5px] font-medium">{r.code}</span>
                        <Pill tone={r.tone} pulse>
                          {r.statusLabel}
                        </Pill>
                      </div>
                      <div className="mt-1 truncate text-[13px] text-ink-2">
                        {r.workerName} → {r.binId}
                      </div>
                      <div className="truncate text-[12px] text-ink-3">
                        {r.binName} · {ago(r.updatedAt)}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          {finished && finished.length > 0 && (
            <Panel title="Handed to verification" subtitle="Collected; waiting on the municipality" flush>
              <ul className="divide-y divide-line-2">
                {finished.slice(0, 6).map((r) => (
                  <li key={r.id}>
                    <button onClick={() => setParams({ request: String(r.id) })} className={clsx("w-full px-5 py-2.5 text-left transition-colors hover:bg-raised", r.id === selectedId && "bg-raised")}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[12.5px]">{r.code}</span>
                        <Pill tone={r.tone}>{r.statusLabel}</Pill>
                      </div>
                      <div className="mt-0.5 text-[12px] text-ink-3">
                        {pct(r.fillBefore)} → {pct(r.fillAfter)} · AI {r.completionConfidence?.toFixed(1) ?? "–"}%
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>

        {selectedId ? (
          <Tracking id={selectedId} />
        ) : (
          <Panel>
            <Empty
              icon={<Truck className="h-8 w-8" />}
              title="No active collections"
              body="When the municipality assigns a worker, their trip, the RFID check at the bin and the emptying appear here live."
              action={
                <Link to="/app/assign" className="text-[13px] font-medium text-ink-2 underline decoration-line underline-offset-4 hover:text-ink">
                  Go to worker assignment
                </Link>
              }
            />
          </Panel>
        )}
      </div>
    </>
  );
}

function Tracking({ id }: { id: number }) {
  const { data: d } = useRequest(id);
  const bin = useLiveBin(d?.bin);
  const live = useLive((s) => s.workers);
  const now = useNow();
  const navigate = useNavigate();
  const steps = useMemo(() => (d ? logistics(d) : []), [d]);
  // Frame the worker's starting point and the bin once per request; live GPS then moves inside it.
  const frame = useRef<{ id: number; pts: [number, number][] } | null>(null);
  const events = useMemo(() => [...(d?.lifecycle ?? [])].reverse().filter((e) => !["BIN_FULL_DETECTED", "AI_VERIFYING", "THRESHOLD_CROSSED"].includes(e.stage)), [d?.lifecycle]);

  if (!d || !bin) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-28 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const r = d.request;
  const w = d.worker;
  const pos = w ? (live[w.id] ?? { lat: w.lat, lng: w.lng }) : null;
  const distM = pos ? Math.round(haversineKm(pos, { lat: bin.lat, lng: bin.lng }) * 1000) : null;
  const opened = d.collectionEvents.find((c) => c.type === "LID_OPENED");
  const closed = last(d.collectionEvents, (c) => c.type === "LID_CLOSED");
  const started = opened?.ts ?? d.assignment?.startedAt ?? null;
  const ended = closed?.ts ?? d.assignment?.finishedAt ?? null;
  const before = r.fillBefore ?? opened?.data?.fill ?? r.detectedFill;
  const completion = d.verifications.filter((v) => v.kind === "completion").at(-1);
  const fullness = d.verifications.filter((v) => v.kind === "fullness").at(-1);
  const lastRfid = d.rfidEvents.at(-1);
  const travelling = ["ASSIGNED", "EN_ROUTE"].includes(r.status);
  const done = !["ASSIGNED", "EN_ROUTE", "COLLECTING", "REVERIFYING"].includes(r.status);
  if (pos && frame.current?.id !== r.id) frame.current = { id: r.id, pts: [[pos.lat, pos.lng], [bin.lat, bin.lng]] };

  return (
    <div className="min-w-0 space-y-6">
      <Panel flush>
        <div className="flex flex-wrap items-start justify-between gap-4 px-5 pb-4 pt-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <Link to={`/app/requests/${r.id}`} className="font-mono text-[15px] font-semibold hover:underline">
                {r.code}
              </Link>
              <Pill tone={r.tone} pulse={!done}>
                {r.statusLabel}
              </Pill>
              {r.rfidAlert && (
                <Pill tone="danger" icon={<Fingerprint className="h-3.5 w-3.5" />}>
                  RFID alert
                </Pill>
              )}
            </div>
            <div className="mt-1 text-[13.5px] text-ink-2">
              {w?.name ?? "Unassigned"} → {bin.id} · {bin.name} · {bin.address}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <RequestActions r={r} compact tracking />
            <Link to={`/app/requests/${r.id}`} className="inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-[13px] font-medium text-ink-2 hover:bg-hover hover:text-ink">
              Full record <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
        {done && (
          <div className="mx-5 mb-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-raised px-3.5 py-2.5 text-[13px] text-ink-2">
            This collection has left the field: {r.statusLabel.toLowerCase()}.
            {["AWAITING_FINAL_APPROVAL", "INVESTIGATION"].includes(r.status) && (
              <button onClick={() => navigate(`/app/verification?request=${r.id}`)} className="inline-flex items-center gap-1 font-medium text-ink hover:underline">
                Open in verification center <ArrowUpRight className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
        <Tracker steps={steps} />
      </Panel>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Panel title="Live position" subtitle={pos ? `${w?.name} · ${live[w!.id]?.source === "gps" || w?.locationSource === "gps" ? "phone GPS" : "simulated GPS"} · updated ${ago(w?.locationUpdatedAt)}` : "No worker assigned"} flush>
          <MapView
            bins={[bin]}
            workers={w ? [{ ...w, ...(pos ?? {}) }] : []}
            highlightWorker={w?.id}
            routes={pos && travelling ? [{ from: [pos.lat, pos.lng], to: [bin.lat, bin.lng] }] : []}
            fit={frame.current?.pts ?? null}
            height={400}
            className="overflow-hidden rounded-b-lg"
          />
        </Panel>

        <Panel title="Collection facts">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-[13px]">
            <Fact label="Worker">
              {w ? (
                <Link to={`/app/workers/${w.id}`} className="inline-flex items-center gap-2 hover:underline">
                  <Avatar name={w.name} size={22} /> {w.name}
                </Link>
              ) : (
                "–"
              )}
            </Fact>
            <Fact label="Distance to bin">
              <span className="num">{distM === null ? "–" : distM <= 40 ? "At the bin" : km(distM / 1000)}</span>
            </Fact>
            <Fact label="RFID">
              {lastRfid ? (
                <span className={clsx("inline-flex items-center gap-1.5", lastRfid.result === "RFID_VERIFIED" ? "text-good" : lastRfid.result === "VERIFICATION_PENDING" ? "text-prog" : "text-bad")}>
                  {lastRfid.result === "RFID_VERIFIED" ? <Check className="h-4 w-4" /> : lastRfid.result === "VERIFICATION_PENDING" ? <Fingerprint className="h-4 w-4" /> : <X className="h-4 w-4" />}
                  {lastRfid.result === "RFID_VERIFIED" ? "Verified" : lastRfid.result === "VERIFICATION_PENDING" ? "Checking" : "Refused"}
                </span>
              ) : (
                <span className="text-ink-3">Not tapped</span>
              )}
            </Fact>
            <Fact label="Lid">
              <span className="inline-flex items-center gap-1.5 capitalize">
                {bin.servoState === "unlocked" ? <LockOpen className="h-4 w-4 text-good" /> : <Lock className="h-4 w-4 text-ink-3" />}
                {bin.lidState} · {bin.servoState}
              </span>
            </Fact>
            <Fact label="Collection started">{started ? time(started, true) : "–"}</Fact>
            <Fact label="Duration">
              <span className="num">{started ? duration(started, ended ?? new Date(now).toISOString()) : "–"}</span>
            </Fact>
          </dl>

          <div className="mt-5 grid grid-cols-3 gap-2 border-t border-line-2 pt-4">
            <Level label="Before" value={before} />
            <Level label="Now" value={bin.fillPct} live={!done} />
            <Level label="After" value={r.fillAfter} />
          </div>

          <div className="mt-5 flex items-center gap-3 border-t border-line-2 pt-4">
            {completion ? (
              <>
                <ConfidenceRing value={completion.confidence} verified={completion.verified} size={52} />
                <div className="min-w-0">
                  <div className="text-[12px] text-ink-3">AI completion check</div>
                  <div className={clsx("text-[14px] font-semibold", completion.verified ? "text-good" : "text-bad")}>{completion.verified ? "Collection verified" : "Not verified"}</div>
                  <div className="truncate text-[12px] text-ink-3">{completion.reasons[0]}</div>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2 text-[13px] text-ink-3">
                <CircleAlert className="h-4 w-4" />
                {r.status === "REVERIFYING" ? "AI is re-verifying the collection…" : `The AI re-verifies once the lid closes${fullness ? ` · fullness was ${fullness.confidence.toFixed(1)}%` : ""}.`}
              </div>
            )}
          </div>
        </Panel>
      </div>

      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <Panel title="Bin, live" subtitle={`${bin.id} · telemetry ${ago(bin.lastHeartbeat)}`}>
          <div className="flex justify-center">
            <BinVisual fill={bin.fillPct} lid={bin.lidState} servo={bin.servoState} ir={bin.irStatus} rfid={bin.rfidState} threshold={bin.thresholdPct} monitor={bin.monitorPct} online={bin.online} size={170} />
          </div>
          <div className="mt-2 text-center text-[28px] font-semibold tracking-[-0.02em] num">{Math.round(bin.fillPct)}%</div>
          <div className="text-center text-[12px] text-ink-3">
            primary {pct(bin.fillPct, 1)} · supporting {pct(bin.fill2Pct, 1)}
          </div>
        </Panel>
        <Panel title="Event log" subtitle="Newest first" bodyClassName="max-h-[420px] overflow-y-auto scroll-thin">
          <Timeline events={events} />
        </Panel>
      </div>
    </div>
  );
}

function Tracker({ steps }: { steps: Step[] }) {
  return (
    <div className="overflow-x-auto border-t border-line-2 px-5 py-4 scroll-thin">
      <ol className="flex min-w-[720px]">
        {steps.map((s, i) => (
          <li key={s.key} className="relative flex flex-1 flex-col">
            {i < steps.length - 1 && <span className={clsx("absolute left-[11px] right-0 top-[11px] h-[2px]", s.state === "done" && steps[i + 1].state !== "upcoming" ? "bg-ink/80" : "bg-line")} />}
            <span
              className={clsx(
                "relative z-[1] flex h-[23px] w-[23px] items-center justify-center rounded-full border",
                s.state === "done" && "border-ink bg-ink text-white",
                s.state === "current" && "border-prog-dot bg-surface text-prog",
                s.state === "upcoming" && "border-line bg-surface text-ink-4",
                s.state === "warning" && "border-warn-dot bg-warn-bg text-warn",
                s.state === "failed" && "border-bad-dot bg-bad-dot text-white",
              )}
            >
              {s.state === "current" && <span className="pulse-ring absolute inset-0 rounded-full bg-prog-dot/40" />}
              {s.state === "done" ? <Check className="h-3 w-3" strokeWidth={3} /> : s.state === "failed" ? <X className="h-3 w-3" strokeWidth={3} /> : s.state === "warning" ? "!" : <span className="h-1.5 w-1.5 rounded-full bg-current" />}
            </span>
            <span className={clsx("mt-2 pr-2 text-[12.5px] leading-tight", s.state === "upcoming" ? "text-ink-3" : s.state === "failed" ? "font-medium text-bad" : s.state === "warning" ? "font-medium text-warn" : "font-medium text-ink")}>{s.label}</span>
            <span className="mt-0.5 text-[11.5px] text-ink-3 num">{s.note ?? (s.ts ? time(s.ts, true) : s.state === "current" ? "in progress" : "")}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 truncate font-medium text-ink">{children}</dd>
    </div>
  );
}

function Level({ label, value, live }: { label: string; value: number | null | undefined; live?: boolean }) {
  return (
    <div className="rounded-md bg-raised px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
        {live && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-prog-dot" />}
        {label}
      </div>
      <div className="mt-0.5 text-[20px] font-semibold tracking-[-0.02em] num">{value === null || value === undefined ? "–" : `${Math.round(value)}%`}</div>
    </div>
  );
}
