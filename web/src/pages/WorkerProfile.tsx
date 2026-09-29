import clsx from "clsx";
import { ChevronRight, Fingerprint, MapPin, Phone, Wallet } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { TxDrawer, TxList } from "../components/Chain";
import { MapView } from "../components/MapView";
import { Avatar, Hash, Panel, Pill, Skeleton, Table, Td, Th } from "../components/ui";
import { ago, dateTime, inr, mstc, pct } from "../lib/format";
import { useLiveBins } from "../lib/live";
import { useBins, useConfig, useWorker } from "../lib/queries";
import { useLive } from "../lib/store";
import { reliability, workerTone } from "./Workers";

export function WorkerProfile() {
  const id = useParams().id!;
  const { data, isLoading } = useWorker(id);
  const { data: cfg } = useConfig();
  const { data: binsRaw } = useBins();
  const bins = useLiveBins(binsRaw);
  const live = useLive((s) => s.workers[id]);
  const [tx, setTx] = useState<string | null>(null);
  const jobBin = useMemo(() => bins.find((b) => b.id === data?.worker.activeJob?.binId), [bins, data]);

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-80" />
        <Skeleton className="h-[420px] w-full" />
      </div>
    );
  }

  const w = data.worker;
  const pos = live ?? { lat: w.lat, lng: w.lng };
  const rel = reliability(w);
  const rate = cfg?.payment.inrPerMstc ?? 0;
  const track = live ? [...data.track, [live.lat, live.lng] as [number, number]] : data.track;

  return (
    <>
      <nav className="mb-3 flex items-center gap-1 text-[12.5px] text-ink-3">
        <Link to="/app/workers" className="hover:text-ink">
          Workers
        </Link>
        <ChevronRight className="h-3.5 w-3.5" />
        <span className="text-ink-2">{w.name}</span>
      </nav>

      <div className="mb-6 flex flex-wrap items-center gap-4">
        <Avatar name={w.name} size={56} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[26px] font-semibold tracking-[-0.02em]">{w.name}</h1>
            <Pill tone={workerTone(w)} pulse={workerTone(w) === "progress"}>
              {w.statusLabel}
            </Pill>
            {w.onChain && <Pill tone="neutral">Registered on-chain</Pill>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13.5px] text-ink-2">
            <span className="font-mono">{w.id}</span>
            <span>{w.zone}</span>
            <span className="inline-flex items-center gap-1">
              <Phone className="h-3.5 w-3.5 text-ink-3" /> {w.phone}
            </span>
          </div>
        </div>
        {w.activeJob && (
          <Link to={`/app/active?request=${w.activeJob.requestId}`} className="inline-flex h-9 items-center gap-2 rounded-md border border-line bg-surface px-3.5 text-[13.5px] font-medium shadow-panel hover:bg-raised">
            Track {w.activeJob.code}
          </Link>
        )}
      </div>

      <div className="panel mb-6 grid grid-cols-2 overflow-hidden md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Collections completed" value={String(w.completed)} />
        <Stat label="Rejected" value={String(w.rejected)} tone={w.rejected > 0 ? "text-bad" : undefined} />
        <Stat label="Reliability" value={rel === null ? "–" : `${rel}%`} sub={rel === null ? "no history yet" : `${w.completed} of ${w.completed + w.rejected} approved`} />
        <Stat label="Earned" value={inr(Number(w.earnedMstc) * rate)} sub={mstc(w.earnedMstc)} />
        <Stat label="Pending" value={inr(Number(w.pendingMstc) * rate)} sub={`${w.pendingPayments} payment${w.pendingPayments === 1 ? "" : "s"} · ${mstc(w.pendingMstc)}`} />
        <Stat label="Wallet balance" value={data.balanceMstc !== null ? mstc(data.balanceMstc) : "–"} sub="read from the chain" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-6">
          <Panel title="Location" subtitle={`${w.locationSource === "gps" ? "Phone GPS" : "Simulated GPS"} · updated ${ago(w.locationUpdatedAt)} · last ${data.track.length} points`} flush>
            <MapView
              bins={jobBin ? [jobBin] : []}
              workers={[{ ...w, ...pos }]}
              highlightWorker={w.id}
              track={track}
              routes={jobBin && w.activeJob && ["ASSIGNED", "EN_ROUTE"].includes(w.activeJob.status) ? [{ from: [pos.lat, pos.lng], to: [jobBin.lat, jobBin.lng] }] : []}
              height={340}
              className="overflow-hidden rounded-b-lg"
            />
          </Panel>

          <Panel title="Jobs" subtitle="Collections assigned to this worker" flush>
            {data.jobs.length === 0 ? (
              <div className="px-5 py-8 text-center text-[13px] text-ink-3">No jobs yet.</div>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Request</Th>
                    <Th>Bin</Th>
                    <Th>Detected</Th>
                    <Th align="right">Before → after</Th>
                    <Th align="right">AI</Th>
                    <Th>Status</Th>
                    <Th>Payment</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.jobs.map((r) => (
                    <tr key={r.id} className="transition-colors hover:bg-raised">
                      <Td>
                        <Link to={`/app/requests/${r.id}`} className="font-mono text-[12.5px] font-medium hover:underline">
                          {r.code}
                        </Link>
                      </Td>
                      <Td>
                        {r.binId} <span className="text-ink-3">{r.binName}</span>
                      </Td>
                      <Td>
                        <span className="num text-ink-2">{dateTime(r.detectedAt)}</span>
                      </Td>
                      <Td align="right">
                        {pct(r.fillBefore)} → {pct(r.fillAfter)}
                      </Td>
                      <Td align="right">{r.completionConfidence !== null ? `${r.completionConfidence.toFixed(1)}%` : "–"}</Td>
                      <Td>
                        <Pill tone={r.tone}>{r.statusLabel}</Pill>
                      </Td>
                      <Td>{r.paymentStatusLabel ?? <span className="text-ink-4">–</span>}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>

          <Panel title="Payments" subtitle="Released only after the municipality approves a verified collection" flush>
            {data.payments.length === 0 ? (
              <div className="px-5 py-8 text-center text-[13px] text-ink-3">No payments yet.</div>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Request</Th>
                    <Th align="right">Amount</Th>
                    <Th>Status</Th>
                    <Th>Transaction</Th>
                    <Th>Paid</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.payments.map((p) => (
                    <tr key={p.requestId}>
                      <Td>
                        <span className="font-mono text-[12.5px]">{p.requestCode}</span>
                      </Td>
                      <Td align="right">
                        <div className="font-medium">{inr(p.amountInr)}</div>
                        <div className="text-[11.5px] text-ink-3">{mstc(p.amountMstc)}</div>
                      </Td>
                      <Td>
                        <Pill tone={p.status === "PAID" ? "success" : p.status === "FAILED" ? "danger" : p.status === "READY" ? "warning" : p.status === "CANCELLED" || p.status === "PENDING" ? "neutral" : "progress"}>{p.statusLabel}</Pill>
                      </Td>
                      <Td>{p.tx ? <Hash value={p.tx.hash} url={p.tx.url} /> : <span className="text-ink-4">–</span>}</Td>
                      <Td>
                        <span className="text-ink-2 num">{p.paidAt ? dateTime(p.paidAt) : "–"}</span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>
        </div>

        <div className="min-w-0 space-y-6">
          <Panel title="Identity" subtitle="What the bin and the ledger check">
            <div className="space-y-4 text-[13px]">
              <Row icon={<Fingerprint className="h-4 w-4" />} label="RFID card UID">
                <span className="font-mono">{w.rfidUid}</span>
              </Row>
              <Row icon={<Fingerprint className="h-4 w-4" />} label="Card hash (on-chain)">
                <Hash value={w.rfidHash} chars={[10, 6]} />
              </Row>
              <Row icon={<Wallet className="h-4 w-4" />} label="Payout wallet">
                <Hash value={w.wallet} url={w.walletUrl} chars={[10, 6]} />
              </Row>
              <Row icon={<MapPin className="h-4 w-4" />} label="Last position">
                <span className="num">
                  {pos.lat.toFixed(5)}, {pos.lng.toFixed(5)}
                </span>
              </Row>
            </div>
            <p className="mt-4 rounded-md bg-sunken px-3 py-2.5 text-[12.5px] text-ink-2">
              The ledger pays only the wallet registered for this worker, and only for a job assigned to them whose RFID tap and emptying were verified.
            </p>
          </Panel>

          <Panel title="On-chain history" subtitle={`${data.transactions.length} transaction${data.transactions.length === 1 ? "" : "s"}`} flush>
            <TxList txs={data.transactions} onOpen={setTx} compact />
          </Panel>
        </div>
      </div>
      <TxDrawer hash={tx} onClose={() => setTx(null)} />
    </>
  );
}

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="border-line-2 px-4 py-3.5 [&:not(:first-child)]:border-l max-md:[&:nth-child(odd)]:border-l-0 max-md:[&:nth-child(n+3)]:border-t md:max-xl:[&:nth-child(3n+1)]:border-l-0 md:max-xl:[&:nth-child(n+4)]:border-t">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className={clsx("mt-1 truncate text-[22px] font-semibold leading-none tracking-[-0.02em] num", tone)}>{value}</div>
      {sub && <div className="mt-1 truncate text-[11.5px] text-ink-3">{sub}</div>}
    </div>
  );
}

function Row({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 text-ink-3">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[11.5px] text-ink-3">{label}</div>
        <div className="mt-0.5 min-w-0">{children}</div>
      </div>
    </div>
  );
}
