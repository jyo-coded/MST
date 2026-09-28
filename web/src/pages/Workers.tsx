import clsx from "clsx";
import { Users } from "lucide-react";
import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { MapView } from "../components/MapView";
import { Avatar, Empty, Hash, PageHeader, Panel, Pill, Skeleton, Table, Td, Th } from "../components/ui";
import { AnimatedNumber } from "../components/ui";
import { ago, inr, mstc } from "../lib/format";
import { useLiveBins } from "../lib/live";
import { useBins, useConfig, useWorkers } from "../lib/queries";
import type { Worker } from "../lib/types";

const BUSY = ["ASSIGNED", "EN_ROUTE", "AT_BIN", "COLLECTING"];

export function workerTone(w: Pick<Worker, "status">) {
  return BUSY.includes(w.status) ? ("progress" as const) : w.status === "AWAITING_VERIFICATION" ? ("warning" as const) : ("success" as const);
}

export function reliability(w: Pick<Worker, "completed" | "rejected">) {
  const total = w.completed + w.rejected;
  return total === 0 ? null : Math.round((w.completed / total) * 100);
}

export function Workers() {
  const { data: workers } = useWorkers();
  const { data: binsRaw } = useBins();
  const { data: cfg } = useConfig();
  const bins = useLiveBins(binsRaw);
  const navigate = useNavigate();

  const stats = useMemo(() => {
    const ws = workers ?? [];
    return {
      available: ws.filter((w) => !BUSY.includes(w.status) && w.status !== "AWAITING_VERIFICATION").length,
      busy: ws.filter((w) => BUSY.includes(w.status)).length,
      verifying: ws.filter((w) => w.status === "AWAITING_VERIFICATION").length,
      completed: ws.reduce((s, w) => s + w.completed, 0),
      earned: ws.reduce((s, w) => s + Number(w.earnedMstc), 0),
    };
  }, [workers]);

  const jobBins = useMemo(() => bins.filter((b) => workers?.some((w) => w.activeJob?.binId === b.id)), [bins, workers]);
  const routes = useMemo(() => {
    const out: { from: [number, number]; to: [number, number] }[] = [];
    for (const w of workers ?? []) {
      const b = w.activeJob && ["ASSIGNED", "EN_ROUTE"].includes(w.activeJob.status) ? bins.find((x) => x.id === w.activeJob!.binId) : null;
      if (b) out.push({ from: [w.lat, w.lng], to: [b.lat, b.lng] });
    }
    return out;
  }, [workers, bins]);

  return (
    <>
      <PageHeader title="Workers" subtitle="Field staff, their RFID cards and the wallets they are paid to. Nobody can collect, or be paid for, a job that wasn't assigned to them." />

      <div className="panel mb-6 grid grid-cols-2 overflow-hidden md:grid-cols-5">
        {[
          { label: "Available", value: stats.available },
          { label: "On a job", value: stats.busy },
          { label: "Awaiting verification", value: stats.verifying },
          { label: "Collections completed", value: stats.completed },
        ].map((s, i) => (
          <div key={s.label} className={clsx("px-4 py-3.5", i > 0 && "border-l border-line-2", i === 2 && "max-md:border-l-0 max-md:border-t", i === 3 && "max-md:border-t")}>
            <div className="text-[12px] text-ink-3">{s.label}</div>
            <div className="mt-1 text-[24px] font-semibold leading-none tracking-[-0.02em]">{workers ? <AnimatedNumber value={s.value} /> : "–"}</div>
          </div>
        ))}
        <div className="col-span-2 border-line-2 px-4 py-3.5 max-md:border-t md:col-span-1 md:border-l">
          <div className="text-[12px] text-ink-3">Paid to workers</div>
          <div className="mt-1 text-[24px] font-semibold leading-none tracking-[-0.02em] num">{workers ? inr(stats.earned * (cfg?.payment.inrPerMstc ?? 0)) : "–"}</div>
          <div className="mt-1 text-[11.5px] text-ink-3 num">{workers ? mstc(stats.earned) : ""}</div>
        </div>
      </div>

      <Panel flush>
        {!workers ? (
          <div className="space-y-2 p-5">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : workers.length === 0 ? (
          <Empty icon={<Users className="h-8 w-8" />} title="No workers registered" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Worker</Th>
                <Th>Zone</Th>
                <Th>Status</Th>
                <Th>Current job</Th>
                <Th>RFID card</Th>
                <Th>Wallet</Th>
                <Th align="right">Done</Th>
                <Th align="right">Rejected</Th>
                <Th align="right">Reliability</Th>
                <Th align="right">Earned</Th>
                <Th>Location</Th>
              </tr>
            </thead>
            <tbody>
              {workers.map((w) => {
                const rel = reliability(w);
                return (
                  <tr key={w.id} onClick={() => navigate(`/app/workers/${w.id}`)} className="cursor-pointer transition-colors hover:bg-raised">
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <Avatar name={w.name} size={30} />
                        <div className="min-w-0">
                          <div className="truncate font-medium">{w.name}</div>
                          <div className="font-mono text-[11.5px] text-ink-3">{w.id}</div>
                        </div>
                      </div>
                    </Td>
                    <Td>
                      <span className="text-ink-2">{w.zone}</span>
                    </Td>
                    <Td>
                      <Pill tone={workerTone(w)} pulse={BUSY.includes(w.status)}>
                        {w.statusLabel}
                      </Pill>
                    </Td>
                    <Td>
                      {w.activeJob ? (
                        <Link to={`/app/requests/${w.activeJob.requestId}`} onClick={(e) => e.stopPropagation()} className="hover:underline">
                          <span className="font-mono text-[12px]">{w.activeJob.code}</span> <span className="text-ink-3">· {w.activeJob.binId}</span>
                        </Link>
                      ) : (
                        <span className="text-ink-4">–</span>
                      )}
                    </Td>
                    <Td>
                      <span className="font-mono text-[12.5px] text-ink-2">{w.rfidUid}</span>
                    </Td>
                    <Td>
                      <Hash value={w.wallet} url={w.walletUrl} copy={false} />
                    </Td>
                    <Td align="right">{w.completed}</Td>
                    <Td align="right">
                      <span className={clsx(w.rejected > 0 && "text-bad")}>{w.rejected}</span>
                    </Td>
                    <Td align="right">{rel === null ? <span className="text-ink-4">new</span> : `${rel}%`}</Td>
                    <Td align="right">{mstc(w.earnedMstc)}</Td>
                    <Td>
                      <span className="text-[12px] text-ink-3">
                        {w.locationSource === "gps" ? "Phone GPS" : "Simulated"} · {ago(w.locationUpdatedAt)}
                      </span>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Panel>

      <Panel className="mt-6" title="Where everyone is" subtitle="Worker positions and the bins they are heading to" flush>
        <MapView bins={jobBins} workers={workers ?? []} routes={routes} height={380} className="overflow-hidden rounded-b-lg" />
      </Panel>
    </>
  );
}
