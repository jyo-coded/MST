import clsx from "clsx";
import { Landmark, Send, Wallet } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { PaymentStatus, Tone } from "@astra/shared";
import { PaymentPanel, SigningNote, useAction } from "../components/Actions";
import { TxDrawer } from "../components/Chain";
import { Button, Drawer, Empty, Field, Hash, inputClass, PageHeader, Panel, Pill, Segmented, Skeleton, Table, Td, Th } from "../components/ui";
import { post } from "../lib/api";
import { dateTime, inr, mstc } from "../lib/format";
import { useConfig, usePayments, useRequest } from "../lib/queries";
import { useLive } from "../lib/store";
import type { Payment, Tx } from "../lib/types";

export function payTone(s: PaymentStatus): Tone {
  return s === "PAID" ? "success" : s === "FAILED" ? "danger" : s === "READY" ? "warning" : s === "PENDING" || s === "CANCELLED" ? "neutral" : "progress";
}

const FILTERS = {
  all: { label: "All", match: () => true },
  ready: { label: "Ready", match: (p: Payment) => ["READY", "FAILED", "SIGNING", "SUBMITTED", "CONFIRMING"].includes(p.status) },
  escrow: { label: "In escrow", match: (p: Payment) => p.status === "PENDING" },
  paid: { label: "Paid", match: (p: Payment) => p.status === "PAID" },
  cancelled: { label: "Cancelled", match: (p: Payment) => p.status === "CANCELLED" },
} as const;
type FilterKey = keyof typeof FILTERS;

export function Payments() {
  const { data } = usePayments();
  const { data: cfg } = useConfig();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [open, setOpen] = useState<number | null>(null);
  const [tx, setTx] = useState<string | null>(null);
  const [releasing, setReleasing] = useState<number | null>(null);
  const { run } = useAction();
  const s = data?.summary;
  const rate = s?.inrPerMstc ?? cfg?.payment.inrPerMstc ?? 0;
  const ready = useMemo(() => (data?.items ?? []).filter((p) => p.status === "READY" || p.status === "FAILED"), [data]);
  const inFlight = useMemo(() => (data?.items ?? []).filter((p) => ["SIGNING", "SUBMITTED", "CONFIRMING"].includes(p.status)), [data]);
  const rows = useMemo(() => (data?.items ?? []).filter(FILTERS[filter].match), [data, filter]);

  return (
    <>
      <PageHeader
        title="Payments"
        subtitle={`Workers are paid in MSTC on ${cfg?.networkLabel ?? "MST"}. The amount is escrowed in the ledger when a job is assigned and can only be released to the assigned worker's wallet after the municipality approves a verified collection.`}
      />

      <div className="panel mb-6 grid grid-cols-2 overflow-hidden lg:grid-cols-4">
        <Summary label="Ready to release" value={s ? inr(Number(s.readyMstc) * rate) : undefined} sub={s ? `${s.readyCount} payment${s.readyCount === 1 ? "" : "s"} · ${mstc(s.readyMstc)}` : ""} highlight={!!s && s.readyCount > 0} />
        <Summary label="Held in escrow" value={s ? inr(Number(s.escrowMstc) * rate) : undefined} sub={s ? `${mstc(s.escrowMstc)} for jobs in progress` : ""} />
        <Summary label="Paid today" value={s ? inr(Number(s.paidTodayMstc) * rate) : undefined} sub={s ? mstc(s.paidTodayMstc) : ""} />
        <Summary label="Paid in total" value={s ? inr(Number(s.paidTotalMstc) * rate) : undefined} sub={s ? mstc(s.paidTotalMstc) : ""} />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="min-w-0 space-y-6">
          <Panel title="Release payments" subtitle="Approved, verified collections waiting for payout" flush>
            {!data ? (
              <div className="p-5">
                <Skeleton className="h-16 w-full" />
              </div>
            ) : ready.length === 0 && inFlight.length === 0 ? (
              <div className="px-5 py-8 text-center text-[13px] text-ink-3">Nothing to release. Payments appear here once the municipality approves a verified collection.</div>
            ) : (
              <ul className="divide-y divide-line-2">
                {[...inFlight, ...ready].map((p) => (
                  <li key={p.requestId} className="flex flex-wrap items-center gap-x-5 gap-y-3 px-5 py-4">
                    <button onClick={() => setOpen(p.requestId)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                      <span className={clsx("flex h-10 w-10 shrink-0 items-center justify-center rounded-md", p.status === "FAILED" ? "bg-bad-bg text-bad" : "bg-warn-bg text-warn")}>
                        <Wallet className="h-[18px] w-[18px]" />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[14px] font-medium">
                          {inr(p.amountInr)} <span className="font-normal text-ink-3">· {mstc(p.amountMstc)}</span>
                        </span>
                        <span className="block truncate text-[12.5px] text-ink-3">
                          {p.workerName} · <span className="font-mono">{p.requestCode}</span> · {p.binId}
                        </span>
                        {p.error && <span className="block truncate text-[12px] text-bad">{p.error}</span>}
                      </span>
                    </button>
                    <Pill tone={payTone(p.status)} pulse={["SIGNING", "SUBMITTED", "CONFIRMING"].includes(p.status)}>
                      {p.statusLabel}
                    </Pill>
                    {(p.status === "READY" || p.status === "FAILED") && (
                      <Button
                        size="sm"
                        variant="primary"
                        icon={<Send className="h-3.5 w-3.5" />}
                        loading={releasing === p.requestId}
                        disabled={releasing !== null}
                        onClick={async () => {
                          setReleasing(p.requestId);
                          await run(p.requestId, { kind: "releasePayment" });
                          setReleasing(null);
                        }}
                      >
                        {p.status === "FAILED" ? "Retry" : "Release"}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {ready.length > 0 && (
              <div className="border-t border-line-2 px-5 py-3">
                <SigningNote />
              </div>
            )}
          </Panel>

          <Panel
            title="All payments"
            flush
            actions={<Segmented size="sm" value={filter} onChange={setFilter} items={(Object.keys(FILTERS) as FilterKey[]).map((k) => ({ value: k, label: FILTERS[k].label }))} />}
          >
            {!data ? (
              <div className="p-5">
                <Skeleton className="h-24 w-full" />
              </div>
            ) : rows.length === 0 ? (
              <Empty icon={<Wallet className="h-8 w-8" />} title="No payments here" />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Request</Th>
                    <Th>Worker</Th>
                    <Th>Wallet</Th>
                    <Th align="right">Amount</Th>
                    <Th>Status</Th>
                    <Th>Transaction</Th>
                    <Th>Updated</Th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.requestId} onClick={() => setOpen(p.requestId)} className="cursor-pointer transition-colors hover:bg-raised">
                      <Td>
                        <div className="font-mono text-[12.5px] font-medium">{p.requestCode}</div>
                        <div className="text-[12px] text-ink-3">{p.binId}</div>
                      </Td>
                      <Td>{p.workerName}</Td>
                      <Td>
                        <Hash value={p.wallet} url={p.walletUrl} copy={false} />
                      </Td>
                      <Td align="right">
                        <div className="font-medium">{inr(p.amountInr)}</div>
                        <div className="text-[11.5px] text-ink-3">{mstc(p.amountMstc)}</div>
                      </Td>
                      <Td>
                        <Pill tone={payTone(p.status)}>{p.statusLabel}</Pill>
                      </Td>
                      <Td>
                        {p.tx ? (
                          <button
                            className="font-mono text-[12.5px] underline decoration-line underline-offset-2 hover:decoration-ink-3"
                            onClick={(e) => {
                              e.stopPropagation();
                              setTx(p.tx!.hash);
                            }}
                          >
                            {p.tx.hash.slice(0, 10)}…{p.tx.hash.slice(-4)}
                          </button>
                        ) : (
                          <span className="text-ink-4">–</span>
                        )}
                      </Td>
                      <Td>
                        <span className="text-ink-3 num">{dateTime(p.paidAt ?? p.updatedAt)}</span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>
        </div>

        <div className="min-w-0 space-y-6">
          <FundPanel fund={data?.fund ?? null} onTx={setTx} />
          <Panel title="How a payment moves">
            <ol className="space-y-3 text-[13px]">
              {[
                ["Assignment", "The officer assigns a worker; the amount is reserved in the ledger."],
                ["Verification", "RFID, both ultrasonic sensors and the AI must agree the bin was emptied."],
                ["Approval", "The officer approves on-chain. The ledger rechecks the sensor numbers."],
                ["Release", "releasePayment() sends MSTC to the worker's registered wallet. Paid once, never twice."],
              ].map(([t, b], i) => (
                <li key={t} className="grid grid-cols-[22px_1fr] gap-2">
                  <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full bg-sunken text-[11px] font-semibold text-ink-2">{i + 1}</span>
                  <span>
                    <span className="font-medium text-ink">{t}.</span> <span className="text-ink-2">{b}</span>
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
        </div>
      </div>

      <PaymentDrawer requestId={open} onClose={() => setOpen(null)} />
      <TxDrawer hash={tx} onClose={() => setTx(null)} />
    </>
  );
}

function Summary({ label, value, sub, highlight }: { label: string; value?: string; sub: string; highlight?: boolean }) {
  return (
    <div className="border-line-2 px-5 py-4 [&:not(:first-child)]:border-l max-lg:[&:nth-child(3)]:border-l-0 max-lg:[&:nth-child(n+3)]:border-t">
      <div className="flex items-center gap-1.5 text-[12px] text-ink-3">
        {highlight && <span className="h-1.5 w-1.5 rounded-full bg-warn-dot" />}
        {label}
      </div>
      <div className="mt-1.5 text-[26px] font-semibold leading-none tracking-[-0.025em] num">{value ?? <Skeleton className="h-7 w-20" />}</div>
      <div className="mt-1.5 truncate text-[12px] text-ink-3 num">{sub}</div>
    </div>
  );
}

function FundPanel({ fund, onTx }: { fund: { balanceMstc: string; reservedMstc: string; freeMstc: string; totalPaidMstc: string } | null; onTx: (h: string) => void }) {
  const { data: cfg } = useConfig();
  const qc = useQueryClient();
  const toast = useLive((s) => s.toast);
  const [amount, setAmount] = useState("0.5");
  const [busy, setBusy] = useState(false);
  const balance = Number(fund?.balanceMstc ?? 0);
  const reserved = Number(fund?.reservedMstc ?? 0);
  const reservedPct = balance > 0 ? Math.min(100, (reserved / balance) * 100) : 0;

  const topUp = async () => {
    setBusy(true);
    try {
      const t = await post<Tx>("/chain/fund", { amountMstc: amount });
      toast({ tone: t.status === "CONFIRMED" ? "success" : "info", title: t.status === "CONFIRMED" ? `Fund topped up on ${cfg?.networkLabel}` : "Top-up submitted", body: `${mstc(amount)} · tx ${t.hash.slice(0, 10)}…`, href: t.url ?? undefined });
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["chain-status"] });
      onTx(t.hash);
    } catch (err) {
      toast({ tone: "danger", title: "Top-up failed", body: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title="Ledger fund" subtitle="MSTC held by the contract for worker payouts" actions={<Landmark className="h-4 w-4 text-ink-3" />}>
      {!fund ? (
        <div className="text-[13px] text-ink-3">Chain unreachable; fund balance unavailable.</div>
      ) : (
        <>
          <div className="text-[30px] font-semibold leading-none tracking-[-0.025em] num">{mstc(fund.balanceMstc)}</div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-sunken">
            <div className="h-full rounded-full bg-warn-dot" style={{ width: `${reservedPct}%` }} />
          </div>
          <dl className="mt-3 grid grid-cols-2 gap-3 text-[13px]">
            <div>
              <dt className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
                <span className="h-2 w-2 rounded-full bg-warn-dot" /> Reserved (escrow)
              </dt>
              <dd className="mt-0.5 font-medium num">{mstc(fund.reservedMstc)}</dd>
            </div>
            <div>
              <dt className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
                <span className="h-2 w-2 rounded-full bg-sunken ring-1 ring-line" /> Free to assign
              </dt>
              <dd className="mt-0.5 font-medium num">{mstc(fund.freeMstc)}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-[11.5px] text-ink-3">Paid out by the ledger, all time</dt>
              <dd className="mt-0.5 font-medium num">{mstc(fund.totalPaidMstc)}</dd>
            </div>
          </dl>
          <div className="mt-4 border-t border-line-2 pt-4">
            <Field label="Top up from the admin wallet">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <input className={clsx(inputClass, "pr-14 num")} value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
                  <span className="absolute inset-y-0 right-3 flex items-center text-[12.5px] text-ink-3">MSTC</span>
                </div>
                <Button variant="secondary" loading={busy} disabled={!Number(amount)} onClick={topUp}>
                  Fund
                </Button>
              </div>
            </Field>
            <p className="mt-2 text-[12px] text-ink-3">Sends a real fund() transaction. Assignments are refused once free funds run out.</p>
          </div>
        </>
      )}
    </Panel>
  );
}

function PaymentDrawer({ requestId, onClose }: { requestId: number | null; onClose: () => void }) {
  const { data: d } = useRequest(requestId);
  const { data: cfg } = useConfig();
  return (
    <Drawer
      open={requestId !== null}
      onClose={onClose}
      title="Payment"
      subtitle={d ? `${d.request.code} · ${d.request.binId} ${d.request.binName ?? ""}` : undefined}
      footer={
        d ? (
          <Link to={`/app/requests/${d.request.id}`} className="text-[13px] font-medium text-ink-2 hover:text-ink">
            Open the full collection record →
          </Link>
        ) : undefined
      }
    >
      <div className="px-6 py-5">
        {!d ? (
          <Skeleton className="h-64 w-full" />
        ) : d.payment ? (
          <PaymentPanel payment={d.payment} request={d.request} networkLabel={cfg?.networkLabel ?? "MST"} />
        ) : (
          <div className="text-[13px] text-ink-3">No payment for this request.</div>
        )}
      </div>
    </Drawer>
  );
}
