import clsx from "clsx";
import { AlertTriangle, ChevronRight, Fingerprint, MapPin } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { PaymentPanel, RequestActions, SigningNote } from "../components/Actions";
import { BinVisual } from "../components/BinVisual";
import { TxDrawer, TxList } from "../components/Chain";
import { BeforeAfter, EvidencePanel, RfidChain } from "../components/Evidence";
import { FillChart } from "../components/FillChart";
import { LifecycleStepper, Timeline } from "../components/Lifecycle";
import { MapView } from "../components/MapView";
import { Avatar, Hash, KV, Panel, Pill, Skeleton } from "../components/ui";
import { ago, dateTime, duration, km, pct, time } from "../lib/format";
import { useLiveBin } from "../lib/live";
import { useConfig, useRequest } from "../lib/queries";
import { useLive } from "../lib/store";

export function RequestDetail() {
  const id = Number(useParams().id);
  const { data: d, isLoading } = useRequest(id);
  const { data: cfg } = useConfig();
  const bin = useLiveBin(d?.bin);
  const liveWorkers = useLive((s) => s.workers);
  const [tx, setTx] = useState<string | null>(null);

  const fullness = d?.verifications.filter((v) => v.kind === "fullness").at(-1);
  const completion = d?.verifications.filter((v) => v.kind === "completion").at(-1);
  const rfid = d?.rfidEvents ?? [];
  const lifecycleDesc = useMemo(() => [...(d?.lifecycle ?? [])].reverse(), [d?.lifecycle]);

  if (isLoading || !d || !bin) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  const r = d.request;
  const late = ["AWAITING_FINAL_APPROVAL", "INVESTIGATION", "COMPLETED", "REVERIFYING"].includes(r.status) || !!completion;
  const workerPos = d.worker ? (liveWorkers[d.worker.id] ?? { lat: d.worker.lat, lng: d.worker.lng }) : null;
  const lidEvents = d.collectionEvents.filter((c) => c.type.startsWith("LID"));
  const lidOpened = lidEvents.find((c) => c.type === "LID_OPENED")?.ts ?? null;
  const lidClosed = [...lidEvents].reverse().find((c) => c.type === "LID_CLOSED")?.ts ?? null;

  const sections: { key: string; node: ReactNode }[] = [];
  if (completion)
    sections.push({
      key: "emptying",
      node: (
        <Panel title="Bin emptying verification" subtitle="Before and after readings from both ultrasonic sensors, cross-checked by the AI">
          <BeforeAfter before={completion.summary.beforeLevel ?? r.fillBefore ?? r.detectedFill} after={completion.summary.afterLevel ?? r.fillAfter ?? 0} verification={completion} />
        </Panel>
      ),
    });
  if (fullness)
    sections.push({
      key: "fullness",
      node: (
        <Panel title="Fullness verification" subtitle="Is the bin genuinely full, and is the reading trustworthy?">
          <EvidencePanel v={fullness} />
        </Panel>
      ),
    });
  if (completion)
    sections.push({
      key: "completion",
      node: (
        <Panel title="Completion verification" subtitle="Was the bin actually emptied, by the right person, in the right way?">
          <EvidencePanel v={completion} />
        </Panel>
      ),
    });
  if (rfid.length)
    sections.push({
      key: "rfid",
      node: (
        <Panel title="RFID verification" subtitle="Card → worker → wallet → assignment → bin → location → time" actions={r.rfidAlert && <Pill tone="danger">Mismatch recorded</Pill>}>
          <div className={clsx("grid gap-6", rfid.length > 1 && "md:grid-cols-2")}>
            {rfid.slice(-2).map((e) => (
              <RfidChain key={e.id} event={e} />
            ))}
          </div>
        </Panel>
      ),
    });
  sections.push({
    key: "sensors",
    node: (
      <Panel title="Sensor readings" subtitle="Raw telemetry around this request · switch to the table for every reading">
        <FillChart data={d.telemetry} threshold={bin.thresholdPct} height={230} />
        {lidEvents.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 border-t border-line-2 pt-3 text-[12.5px] text-ink-2">
            {d.collectionEvents.map((c, i) => (
              <span key={i}>
                <span className="text-ink-3 num">{time(c.ts, true)}</span> {c.type.replace(/_/g, " ").toLowerCase()} {c.data?.fill !== undefined && <span className="text-ink-3">at {Math.round(c.data.fill)}%</span>}
              </span>
            ))}
          </div>
        )}
      </Panel>
    ),
  });
  const order = late ? ["emptying", "completion", "rfid", "fullness", "sensors"] : ["fullness", "rfid", "sensors"];
  sections.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

  return (
    <>
      <nav className="mb-3 flex items-center gap-1 text-[12.5px] text-ink-3">
        <Link to="/app/requests" className="hover:text-ink">
          Collection requests
        </Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="font-mono text-ink-2">{r.code}</span>
      </nav>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[26px] font-semibold tracking-[-0.02em]">{r.code}</h1>
            <Pill tone={r.tone} pulse={r.tone === "progress"}>
              {r.statusLabel}
            </Pill>
            {r.priority !== "normal" && <Pill tone={r.priority === "critical" ? "danger" : "warning"} dot={false}>{r.priority} priority</Pill>}
            {r.rfidAlert && (
              <Pill tone="danger" icon={<Fingerprint className="h-3.5 w-3.5" />}>
                RFID alert
              </Pill>
            )}
          </div>
          <p className="mt-1.5 text-[14px] text-ink-2">
            {bin.id} · {bin.name} · {bin.address} · detected {dateTime(r.detectedAt)} at {pct(r.detectedFill)}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <RequestActions r={r} />
          {["AWAITING_APPROVAL", "APPROVED", "AWAITING_FINAL_APPROVAL", "INVESTIGATION", "COMPLETED"].includes(r.status) && <SigningNote />}
        </div>
      </div>

      {(r.status === "INVESTIGATION" || r.rejectionReason) && (
        <div className={clsx("mb-6 flex gap-3 rounded-lg border px-4 py-3 text-[13.5px]", r.status === "INVESTIGATION" ? "border-warn-line bg-warn-bg text-warn" : "border-bad-line bg-bad-bg text-bad")}>
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">{r.status === "INVESTIGATION" ? "Investigation required" : "Rejected"}</div>
            <div className="text-ink-2">{r.status === "INVESTIGATION" ? r.investigationReason : r.rejectionReason} The evidence below (raw sensor readings, AI reasoning, RFID events, lid events and on-chain records) is everything the system knows.</div>
          </div>
        </div>
      )}

      <Panel className="mb-6" title="Lifecycle" subtitle={`On-chain stages carry a link mark · ledger status: ${r.chainStatus}`}>
        <LifecycleStepper events={d.lifecycle} request={r} binOnChain={bin.onChain} />
      </Panel>

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-6">
          {sections.map((s) => (
            <div key={s.key}>{s.node}</div>
          ))}
        </div>

        <div className="min-w-0 space-y-6">
          {d.payment && (
            <Panel title="Payment" subtitle="Escrowed on assignment, released on approval">
              <PaymentPanel payment={d.payment} request={r} networkLabel={cfg?.networkLabel ?? "MST"} />
            </Panel>
          )}

          <Panel title="Bin" subtitle={`${bin.zone} · ${bin.capacityLitres} L`} actions={<Link className="text-[12.5px] font-medium text-ink-2 hover:text-ink" to={`/app/bins/${bin.id}`}>Monitor</Link>}>
            <div className="flex items-center gap-4">
              <BinVisual fill={bin.fillPct} lid={bin.lidState} servo={bin.servoState} ir={bin.irStatus} rfid={bin.rfidState} threshold={bin.thresholdPct} monitor={bin.monitorPct} online={bin.online} size={112} />
              <KV
                items={[
                  ["Current fill", <span className="text-[20px] font-semibold tracking-[-0.02em]">{Math.round(bin.fillPct)}%</span>],
                  ["Lid · servo", `${bin.lidState} · ${bin.servoState}`],
                  ["Last heartbeat", ago(bin.lastHeartbeat)],
                ]}
              />
            </div>
          </Panel>

          <Panel title="Assignment" subtitle={d.assignment ? `Assigned ${ago(d.assignment.assignedAt)} by ${d.assignment.assignedBy ?? "officer"}` : "No worker assigned yet"}>
            {d.worker && d.assignment ? (
              <>
                <div className="flex items-center gap-3">
                  <Avatar name={d.worker.name} size={40} />
                  <div className="min-w-0 flex-1">
                    <Link to={`/app/workers/${d.worker.id}`} className="font-medium hover:underline">
                      {d.worker.name}
                    </Link>
                    <div className="text-[12.5px] text-ink-3">
                      {d.worker.id} · card {d.worker.rfidUid}
                    </div>
                  </div>
                  <Pill tone={["EN_ROUTE", "ASSIGNED", "AT_BIN", "COLLECTING"].includes(d.worker.status) ? "progress" : "success"}>{d.worker.statusLabel}</Pill>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-3 text-[13px]">
                  <Info label="Distance now" value={d.distanceM !== null ? km(d.distanceM / 1000) : "–"} />
                  <Info label="ETA at assignment" value={d.assignment.etaMin ? `${d.assignment.etaMin} min` : "–"} />
                  <Info label="Collection duration" value={lidOpened ? duration(lidOpened, lidClosed) : "–"} />
                  <Info label="Wallet" value={<Hash value={d.worker.wallet} url={d.worker.walletUrl} />} />
                </dl>
                {workerPos && (
                  <MapView
                    bins={[bin]}
                    workers={[{ ...d.worker, ...workerPos }]}
                    routes={["ASSIGNED", "EN_ROUTE"].includes(r.status) ? [{ from: [workerPos.lat, workerPos.lng], to: [bin.lat, bin.lng] }] : []}
                    height={190}
                    className="mt-4 overflow-hidden rounded-md border border-line"
                    zoomControl={false}
                  />
                )}
              </>
            ) : (
              <div className="flex items-center gap-2 text-[13px] text-ink-3">
                <MapPin className="h-4 w-4" /> The municipality assigns the nearest available worker after approving the request.
              </div>
            )}
          </Panel>

          <Panel title="Timeline" subtitle="Every step, newest first" bodyClassName="max-h-[520px] overflow-y-auto scroll-thin">
            <Timeline events={lifecycleDesc} />
          </Panel>

          <Panel title="On-chain records" subtitle={`${d.transactions.length} transaction${d.transactions.length === 1 ? "" : "s"} on ${cfg?.networkLabel ?? "MST"}`} flush>
            <TxList txs={[...d.transactions].reverse()} onOpen={setTx} compact />
          </Panel>
        </div>
      </div>
      <TxDrawer hash={tx} onClose={() => setTx(null)} />
    </>
  );
}

function Info({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 truncate font-medium">{value}</dd>
    </div>
  );
}
