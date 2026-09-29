import clsx from "clsx";
import { Check, Star, UserPlus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { SigningNote, useAction } from "../components/Actions";
import { MapView } from "../components/MapView";
import { Avatar, Button, Empty, Field, inputClass, PageHeader, Panel, Pill, Skeleton } from "../components/ui";
import { inr, km, pct } from "../lib/format";
import { useLiveBins } from "../lib/live";
import { useBins, useCandidates, useConfig, useRequest, useRequests, useWorkers } from "../lib/queries";

export function Assign() {
  const params = useParams();
  const navigate = useNavigate();
  const { data: queue } = useRequests("approval");
  const selectedId = params.id ? Number(params.id) : (queue?.find((r) => r.status === "APPROVED") ?? queue?.[0])?.id ?? null;
  const { data: d } = useRequest(selectedId);
  const { data: candidates } = useCandidates(selectedId);
  const { data: cfg } = useConfig();
  const { data: workers } = useWorkers();
  const { data: binsRaw } = useBins();
  const bins = useLiveBins(binsRaw);
  const { run, busy } = useAction();
  const [pick, setPick] = useState<string | null>(null);
  const [amount, setAmount] = useState<string>("");

  useEffect(() => {
    setPick(candidates?.find((c) => c.recommended)?.workerId ?? null);
  }, [candidates, selectedId]);
  useEffect(() => {
    if (cfg && !amount) setAmount(cfg.payment.defaultMstc);
  }, [cfg, amount]);

  const r = d?.request;
  const bin = bins.find((b) => b.id === r?.binId);
  const chosen = candidates?.find((c) => c.workerId === pick);
  const inrValue = Number(amount || 0) * (cfg?.payment.inrPerMstc ?? 0);
  const liveWorkers = useMemo(() => (workers ?? []).map((w) => ({ ...w })), [workers]);

  const assign = async () => {
    if (!r || !pick) return;
    const detail = await run(r.id, { kind: "assign", workerId: pick, amountMstc: amount });
    if (detail) navigate(`/app/active?request=${r.id}`);
  };

  return (
    <>
      <PageHeader title="Worker assignment" subtitle="Pick who goes. Workers are ranked by distance, availability, workload and their collection record." />
      <div className="grid gap-6 xl:grid-cols-[280px_1fr]">
        <Panel title="Waiting for a worker" flush className="self-start">
          {!queue ? (
            <div className="p-4">
              <Skeleton className="h-16 w-full" />
            </div>
          ) : queue.length === 0 ? (
            <div className="px-5 py-8 text-center text-[13px] text-ink-3">No approved requests. Approve a request to assign it.</div>
          ) : (
            <ul className="divide-y divide-line-2">
              {queue.map((q) => (
                <li key={q.id}>
                  <button onClick={() => navigate(`/app/assign/${q.id}`)} className={clsx("w-full px-5 py-3 text-left transition-colors hover:bg-raised", q.id === selectedId && "bg-raised")}>
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-[12.5px] font-medium">{q.code}</span>
                      <Pill tone={q.tone}>{q.status === "APPROVED" ? "Approved" : "Needs approval"}</Pill>
                    </div>
                    <div className="mt-1 truncate text-[13px] text-ink-2">
                      {q.binId} · {q.binName}
                    </div>
                    <div className="text-[12px] text-ink-3">
                      {pct(q.detectedFill)} full · AI {q.aiConfidence?.toFixed(1)}%
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {!r ? (
          <Panel>
            <Empty icon={<UserPlus className="h-8 w-8" />} title="Nothing to assign" body="When the municipality approves a collection request it appears here with nearby workers." />
          </Panel>
        ) : (
          <div className="min-w-0 space-y-6">
            <Panel
              title={`${r.code} · ${r.binId} ${r.binName ?? ""}`}
              subtitle={`${r.address} · ${pct(r.detectedFill)} full · ${r.zone}`}
              actions={<Pill tone={r.tone}>{r.statusLabel}</Pill>}
              flush
            >
              {r.status === "AWAITING_APPROVAL" && (
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-2 bg-warn-bg px-5 py-3 text-[13px] text-warn">
                  This request needs municipal approval before a worker can be assigned.
                  <Button size="sm" variant="primary" loading={busy === "approve"} onClick={() => run(r.id, { kind: "approve" })}>
                    Approve request
                  </Button>
                </div>
              )}
              <div className="grid lg:grid-cols-[1fr_380px]">
                <MapView
                  bins={bin ? [bin] : []}
                  workers={liveWorkers}
                  selectedBin={bin?.id}
                  highlightWorker={pick}
                  routes={chosen && bin ? [{ from: [chosen.lat, chosen.lng], to: [bin.lat, bin.lng] }] : []}
                  fit={bin ? (chosen ? [[bin.lat, bin.lng], [chosen.lat, chosen.lng]] : [[bin.lat, bin.lng]]) : null}
                  height={520}
                  className="overflow-hidden max-lg:rounded-none lg:rounded-bl-lg"
                />
                <div className="flex max-h-[520px] flex-col border-line-2 max-lg:border-t lg:border-l">
                  <div className="flex-1 overflow-y-auto scroll-thin">
                    {!candidates ? (
                      <div className="space-y-2 p-4">
                        <Skeleton className="h-16 w-full" />
                        <Skeleton className="h-16 w-full" />
                      </div>
                    ) : (
                      <ul className="divide-y divide-line-2">
                        {candidates.map((c) => (
                          <li key={c.workerId}>
                            <button
                              disabled={!c.available}
                              onClick={() => setPick(c.workerId)}
                              className={clsx(
                                "relative flex w-full items-start gap-3 px-4 py-3.5 text-left transition-colors",
                                c.available ? "hover:bg-raised" : "opacity-55",
                                pick === c.workerId && "bg-raised",
                              )}
                            >
                              {pick === c.workerId && <span className="absolute inset-y-0 left-0 w-[3px] bg-ink" />}
                              <Avatar name={c.name} size={36} tone={c.available ? "neutral" : "neutral"} />
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="truncate text-[13.5px] font-medium">{c.name}</span>
                                  {c.recommended && (
                                    <span className="inline-flex items-center gap-1 rounded-full bg-ink px-1.5 py-[1px] text-[10.5px] font-semibold text-white">
                                      <Star className="h-2.5 w-2.5" /> Best match
                                    </span>
                                  )}
                                </div>
                                <div className="mt-0.5 text-[12.5px] text-ink-2">
                                  <span className="font-medium text-ink num">{km(c.distanceKm)}</span> away · ETA {c.etaMin} min
                                </div>
                                <div className="mt-0.5 text-[12px] text-ink-3">
                                  {c.why} · {c.activeJobs} active job{c.activeJobs === 1 ? "" : "s"} · {c.completed} done · {c.reliability}% reliable
                                </div>
                              </div>
                              <Pill tone={c.available ? "success" : "neutral"} dot>
                                {c.available ? "Available" : "Busy"}
                              </Pill>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="border-t border-line-2 p-4">
                    <Field label="Payment on verified completion" hint={`≈ ${inr(inrValue)} at the demo rate of ${inr(cfg?.payment.inrPerMstc ?? 0)} per MSTC · escrowed on-chain now`}>
                      <div className="relative">
                        <input className={clsx(inputClass, "pr-16 num")} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
                        <span className="absolute inset-y-0 right-3 flex items-center text-[12.5px] text-ink-3">MSTC</span>
                      </div>
                    </Field>
                    <Button
                      className="mt-3 w-full"
                      size="lg"
                      variant="primary"
                      disabled={!pick || r.status !== "APPROVED" || !Number(amount)}
                      loading={busy === "assign"}
                      icon={<Check className="h-4 w-4" />}
                      onClick={assign}
                    >
                      Assign {chosen ? chosen.name.split(" ")[0] : "worker"}
                    </Button>
                    <div className="mt-2">
                      <SigningNote />
                    </div>
                  </div>
                </div>
              </div>
            </Panel>
          </div>
        )}
      </div>
    </>
  );
}
