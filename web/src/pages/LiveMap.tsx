import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { MARKER, type MarkerState } from "@astra/shared";
import { BinVisual } from "../components/BinVisual";
import { MapView } from "../components/MapView";
import { Dot, Hash, Pill, Skeleton } from "../components/ui";
import { ago, pct, time } from "../lib/format";
import { useLiveBin, useLiveBins } from "../lib/live";
import { useBin, useBins, useWorkers } from "../lib/queries";
import { MARKER_STYLE } from "../lib/tone";

export function LiveMap() {
  const { data: raw } = useBins();
  const { data: workers } = useWorkers();
  const bins = useLiveBins(raw);
  const [selected, setSelected] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<MarkerState>>(new Set());
  const [showWorkers, setShowWorkers] = useState(true);

  const counts = useMemo(() => {
    const c: Partial<Record<MarkerState, number>> = {};
    for (const b of bins) c[b.marker] = (c[b.marker] ?? 0) + 1;
    return c;
  }, [bins]);
  const visible = bins.filter((b) => !hidden.has(b.marker));
  const sel = bins.find((b) => b.id === selected) ?? null;

  const routes = useMemo(() => {
    const out: { from: [number, number]; to: [number, number] }[] = [];
    for (const w of workers ?? []) {
      if (!w.activeJob || !["ASSIGNED", "EN_ROUTE"].includes(w.activeJob.status)) continue;
      const b = bins.find((x) => x.id === w.activeJob!.binId);
      if (b) out.push({ from: [w.lat, w.lng], to: [b.lat, b.lng] });
    }
    return out;
  }, [workers, bins]);

  return (
    <div className="-mx-5 -mb-16 -mt-7 sm:-mx-8">
      <div className="relative h-[calc(100vh-58px)]">
        <MapView
          bins={visible}
          workers={showWorkers ? (workers ?? []) : []}
          selectedBin={selected}
          onSelectBin={setSelected}
          routes={routes}
          focus={sel ? [sel.lat, sel.lng] : null}
          height="100%"
        />

        <div className="pointer-events-none absolute inset-y-0 left-0 z-[500] flex w-[300px] flex-col p-4">
          <div className="panel pointer-events-auto p-4">
            <div className="flex items-baseline justify-between">
              <h1 className="text-[17px] font-semibold tracking-[-0.01em]">Live bin map</h1>
              <span className="text-[12px] text-ink-3 num">{bins.length} bins</span>
            </div>
            <p className="mt-0.5 text-[12.5px] text-ink-3">Click a state to hide or show it.</p>
            <ul className="mt-3 space-y-0.5">
              {(Object.keys(MARKER) as MarkerState[]).map((m) => {
                const s = MARKER_STYLE[m];
                const off = hidden.has(m);
                return (
                  <li key={m}>
                    <button
                      onClick={() =>
                        setHidden((h) => {
                          const n = new Set(h);
                          if (n.has(m)) n.delete(m);
                          else n.add(m);
                          return n;
                        })
                      }
                      className={clsx("flex w-full items-center justify-between rounded-md px-2 py-1.5 text-[12.5px] transition-colors hover:bg-hover", off && "opacity-40")}
                    >
                      <span className="flex items-center gap-2 text-ink-2">
                        <span
                          className="flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-bold text-white"
                          style={{ background: s.hollow ? "#fff" : s.fill, border: `2px solid ${s.hollow ? s.ring : "#fff"}`, boxShadow: "0 0 0 1px rgba(23,24,27,.12)" }}
                        >
                          {s.glyph}
                        </span>
                        {MARKER[m].label}
                      </span>
                      <span className="text-ink-3 num">{counts[m] ?? 0}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <label className="mt-3 flex items-center gap-2 border-t border-line-2 pt-3 text-[12.5px] text-ink-2">
              <input type="checkbox" className="h-4 w-4 accent-[#17181b]" checked={showWorkers} onChange={(e) => setShowWorkers(e.target.checked)} />
              Show workers ({workers?.length ?? 0})
            </label>
          </div>
        </div>

        <AnimatePresence>
          {sel && (
            <motion.div
              key={sel.id}
              initial={{ x: 24, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 24, opacity: 0 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              className="absolute inset-y-0 right-0 z-[600] w-[420px] max-w-full p-4"
            >
              <BinPanel id={sel.id} onClose={() => setSelected(null)} />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

export function BinPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const { data } = useBin(id, 30);
  const b = useLiveBin(data?.bin);
  const latestAi = data?.requests.find((r) => r.aiConfidence !== null);
  return (
    <div className="panel flex h-full flex-col overflow-hidden shadow-pop">
      <header className="flex items-start justify-between gap-3 border-b border-line-2 px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12.5px] text-ink-3">{id}</span>
            {b?.hardware && <Pill tone="info">Hardware</Pill>}
          </div>
          <div className="mt-0.5 truncate text-[16px] font-semibold tracking-[-0.01em]">{b?.name ?? "…"}</div>
          <div className="truncate text-[12.5px] text-ink-3">
            {b?.address} · {b?.zone}
          </div>
        </div>
        <button onClick={onClose} className="rounded-md p-1.5 text-ink-3 hover:bg-hover hover:text-ink" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </header>
      {!b || !data ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto scroll-thin">
          <div className="flex items-center gap-4 px-5 py-4">
            <BinVisual fill={b.fillPct} lid={b.lidState} servo={b.servoState} ir={b.irStatus} rfid={b.rfidState} threshold={b.thresholdPct} monitor={b.monitorPct} online={b.online} size={128} />
            <div className="min-w-0 flex-1">
              <div className="text-[40px] font-semibold leading-none tracking-[-0.03em]">{Math.round(b.fillPct)}%</div>
              <div className="mt-1 text-[12.5px] text-ink-3">fill level · threshold {b.thresholdPct}%</div>
              <div className="mt-3">
                <Pill tone={MARKER[b.marker].tone}>{MARKER[b.marker].label}</Pill>
              </div>
              {b.request && (
                <Link to={`/app/requests/${b.request.id}`} className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-medium text-ink-2 hover:text-ink">
                  {b.request.code} · {b.request.statusLabel} <ArrowUpRight className="h-3.5 w-3.5" />
                </Link>
              )}
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line-2 px-5 py-4 text-[13px]">
            <Reading label="Ultrasonic distance" value={b.distanceCm !== null ? `${b.distanceCm.toFixed(1)} cm` : "–"} />
            <Reading label="Supporting sensor" value={pct(b.fill2Pct, 1)} />
            <Reading label="Lid" value={cap(b.lidState)} />
            <Reading label="Servo lock" value={cap(b.servoState)} />
            <Reading label="IR deposits" value={cap(b.irStatus)} />
            <Reading label="RFID reader" value={cap(b.rfidState)} />
            <Reading label="Connectivity" value={<span className="inline-flex items-center gap-1.5"><Dot tone={b.online ? "success" : "danger"} /> {b.online ? "Online" : "Offline"}</span>} />
            <Reading label="Last update" value={ago(b.lastHeartbeat)} />
            <Reading label="AI confidence (latest)" value={latestAi?.aiConfidence ? `${latestAi.aiConfidence.toFixed(1)}%` : "–"} />
            <Reading label="Assigned worker" value={data.requests.find((r) => r.id === b.request?.id)?.workerName ?? "–"} />
          </dl>
          <div className="border-t border-line-2 px-5 py-4">
            <div className="mb-2 text-[12px] font-medium text-ink-3">Collection history</div>
            {data.requests.length === 0 ? (
              <div className="text-[13px] text-ink-3">No collections yet.</div>
            ) : (
              <ul className="space-y-1.5">
                {data.requests.slice(0, 5).map((r) => (
                  <li key={r.id}>
                    <Link to={`/app/requests/${r.id}`} className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-hover">
                      <span className="font-mono text-[12px] text-ink-2">{r.code}</span>
                      <span className="flex-1 truncate text-ink-3">{time(r.detectedAt)} · {pct(r.detectedFill)}</span>
                      <Pill tone={r.tone}>{r.statusLabel}</Pill>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="border-t border-line-2 px-5 py-4">
            <div className="mb-2 text-[12px] font-medium text-ink-3">Transactions</div>
            {data.transactions.length === 0 ? (
              <div className="text-[13px] text-ink-3">None yet.</div>
            ) : (
              <ul className="space-y-2">
                {data.transactions.slice(0, 6).map((t) => (
                  <li key={t.hash} className="flex items-center justify-between gap-2 text-[12.5px]">
                    <span className="text-ink-2">{t.actionLabel}</span>
                    <Hash value={t.hash} url={t.url} copy={false} />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="border-t border-line-2 px-5 py-4">
            <Link to={`/app/bins/${id}`} className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-md border border-line text-[13px] font-medium hover:bg-raised">
              Open bin monitoring <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Reading({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 truncate font-medium text-ink">{value}</dd>
    </div>
  );
}
