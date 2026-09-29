import clsx from "clsx";
import { AlertTriangle, ArrowUpRight, ClipboardList, Fingerprint, SearchCheck, UserPlus, Wallet } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { RequestActions } from "../components/Actions";
import { TxDrawer, TxList } from "../components/Chain";
import { LifecycleStepper } from "../components/Lifecycle";
import { MapView } from "../components/MapView";
import { Hash, PageHeader, Panel, Pill, Skeleton } from "../components/ui";
import { LiveFeed, MetricsStrip, SystemHealth } from "../components/Widgets";
import { ago, inr, mstc, pct } from "../lib/format";
import { useLiveBins } from "../lib/live";
import { useBins, useConfig, useOverview, useWorkers } from "../lib/queries";
import type { Request } from "../lib/types";

export function Overview() {
  const { data: cfg } = useConfig();
  const { data: ov } = useOverview();
  const { data: binsRaw } = useBins();
  const { data: workers } = useWorkers();
  const bins = useLiveBins(binsRaw);
  const [tx, setTx] = useState<string | null>(null);
  const navigate = useNavigate();
  const m = ov?.metrics;
  const today = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  const spot = ov?.spotlight;

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
    <>
      <PageHeader
        eyebrow={`${today} · ${cfg?.municipality.ward ?? ""}, ${cfg?.municipality.city ?? ""}`}
        title="Operations overview"
        subtitle="Every bin, request, worker and payment in one place, with the proof behind each decision."
      />

      <MetricsStrip
        items={[
          { label: "Total bins", value: m?.totalBins, href: "/app/bins" },
          { label: "Active bins", value: m?.activeBins, href: "/app/bins" },
          { label: "Full bins", value: m?.fullBins, href: "/app/map", tone: "danger" },
          { label: "Pending requests", value: m?.pendingRequests, href: "/app/requests", tone: "warning" },
          { label: "Active collections", value: m?.activeCollections, href: "/app/active", tone: "progress" },
          { label: "Awaiting verification", value: m?.awaitingVerification, href: "/app/verification", tone: "warning" },
          { label: "Completed today", value: m?.completedToday, href: "/app/requests" },
          { label: "Payments pending", value: m?.paymentsPending, href: "/app/payments", tone: "warning" },
        ]}
      />

      <Panel
        className="mt-6"
        title={spot ? "Live collection" : "Collection lifecycle"}
        subtitle={spot ? `${spot.request.code} · ${spot.request.binId} ${spot.request.binName ?? ""}` : "Run a demo from the Demo button to watch a bin go from full to paid."}
        actions={spot && <Pill tone={spot.request.tone} pulse={["progress", "info"].includes(spot.request.tone)}>{spot.request.statusLabel}</Pill>}
      >
        {!ov ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <LifecycleStepper events={spot?.lifecycle ?? []} request={spot?.request} />
            {spot && (
              <div className="mt-5 flex flex-wrap items-end justify-between gap-4 border-t border-line-2 pt-4">
                <dl className="flex flex-wrap gap-x-8 gap-y-3 text-[13px]">
                  <Fact label="Fill level">
                    {pct(spot.request.detectedFill)}
                    {spot.request.fillAfter !== null && <span className="text-ink-3"> → {pct(spot.request.fillAfter)}</span>}
                  </Fact>
                  <Fact label="AI confidence">{spot.request.aiConfidence !== null ? `${spot.request.aiConfidence.toFixed(1)}%` : "–"}</Fact>
                  <Fact label="Worker">{spot.request.workerName ?? "Not assigned"}</Fact>
                  <Fact label="Payment">{spot.request.amountMstc ? `${inr(spot.request.amountInr)} · ${mstc(spot.request.amountMstc)}` : "–"}</Fact>
                  <Fact label="Request on-chain">{spot.request.createdTx ? <Hash value={spot.request.createdTx.hash} url={spot.request.createdTx.url} /> : "–"}</Fact>
                </dl>
                <div className="flex items-center gap-2">
                  <RequestActions r={spot.request} compact />
                  <Link to={`/app/requests/${spot.request.id}`} className="inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-[13px] font-medium text-ink-2 hover:bg-hover hover:text-ink">
                    Open <ArrowUpRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </div>
            )}
          </>
        )}
      </Panel>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-6">
          <Panel title="Needs your attention" subtitle="Decisions waiting on the municipality" flush>
            {!ov ? (
              <div className="p-5">
                <Skeleton className="h-16 w-full" />
              </div>
            ) : ov.attention.length === 0 ? (
              <div className="px-5 py-8 text-center text-[13px] text-ink-3">Nothing needs a decision right now.</div>
            ) : (
              <ul className="divide-y divide-line-2">
                {ov.attention.map((r) => (
                  <AttentionRow key={r.id} r={r} onOpen={() => navigate(`/app/requests/${r.id}`)} />
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="City map"
            subtitle={`${bins.length} bins · ${workers?.length ?? 0} workers`}
            actions={
              <Link to="/app/map" className="inline-flex items-center gap-1 text-[13px] font-medium text-ink-2 hover:text-ink">
                Open live map <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            }
            flush
          >
            <MapView bins={bins} workers={workers ?? []} routes={routes} height={360} className="overflow-hidden rounded-b-lg" onSelectBin={(id) => navigate(`/app/bins/${id}`)} />
          </Panel>

          <Panel
            title="Recent blockchain activity"
            subtitle={`Transactions sent by this platform on ${cfg?.networkLabel ?? "MST"}`}
            actions={
              <Link to="/app/audit" className="inline-flex items-center gap-1 text-[13px] font-medium text-ink-2 hover:text-ink">
                Blockchain audit <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            }
            flush
          >
            <TxList txs={ov?.recentTx ?? []} onOpen={setTx} />
          </Panel>
        </div>

        <div className="min-w-0 space-y-6">
          <Panel title="System health">
            <SystemHealth />
          </Panel>
          <Panel title="Live events" subtitle="Sensors, AI, people and the ledger" bodyClassName="px-3 py-3 max-h-[640px] overflow-y-auto scroll-thin">
            <LiveFeed initial={ov?.feed} limit={30} />
          </Panel>
        </div>
      </div>
      <TxDrawer hash={tx} onClose={() => setTx(null)} />
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 font-medium text-ink">{children}</dd>
    </div>
  );
}

function attentionKind(r: Request): { icon: ReactNode; title: string; tone: "warning" | "danger" | "progress" } {
  if (r.rfidAlert && ["ASSIGNED", "EN_ROUTE", "COLLECTING"].includes(r.status)) return { icon: <Fingerprint className="h-4 w-4" />, title: "RFID mismatch at the bin", tone: "danger" };
  switch (r.status) {
    case "AWAITING_APPROVAL":
      return { icon: <ClipboardList className="h-4 w-4" />, title: "New collection request", tone: "warning" };
    case "APPROVED":
      return { icon: <UserPlus className="h-4 w-4" />, title: "Assign a worker", tone: "warning" };
    case "AWAITING_FINAL_APPROVAL":
      return { icon: <SearchCheck className="h-4 w-4" />, title: "Collection completed: awaiting approval", tone: "warning" };
    case "INVESTIGATION":
      return { icon: <AlertTriangle className="h-4 w-4" />, title: "Investigation required", tone: "danger" };
    default:
      return { icon: <Wallet className="h-4 w-4" />, title: r.paymentStatus === "FAILED" ? "Payment failed: retry" : "Payment ready to release", tone: "progress" };
  }
}

function AttentionRow({ r, onOpen }: { r: Request; onOpen: () => void }) {
  const k = attentionKind(r);
  const detail =
    r.status === "AWAITING_FINAL_APPROVAL" || r.status === "INVESTIGATION"
      ? `${pct(r.fillBefore)} → ${pct(r.fillAfter)} · AI ${r.completionConfidence?.toFixed(1) ?? "–"}%`
      : r.status === "COMPLETED"
        ? `${inr(r.amountInr)} · ${mstc(r.amountMstc)} → ${r.workerName}`
        : `${pct(r.detectedFill)} full · AI ${r.aiConfidence?.toFixed(1) ?? "–"}%`;
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
      <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className={clsx("flex h-9 w-9 shrink-0 items-center justify-center rounded-md", k.tone === "danger" ? "bg-bad-bg text-bad" : k.tone === "warning" ? "bg-warn-bg text-warn" : "bg-prog-bg text-prog")}>{k.icon}</span>
        <span className="min-w-0">
          <span className="block truncate text-[13.5px] font-medium text-ink">{k.title}</span>
          <span className="block truncate text-[12.5px] text-ink-3">
            <span className="font-mono">{r.code}</span> · {r.binId} {r.binName} · {detail} · {ago(r.updatedAt)}
          </span>
        </span>
      </button>
      <RequestActions r={r} compact />
    </li>
  );
}
