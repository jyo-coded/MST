import clsx from "clsx";
import { CircleCheck, CircleX, ExternalLink, Link2, Loader2 } from "lucide-react";
import { useConfig, useTx } from "../lib/queries";
import { dateTime, mstc, time } from "../lib/format";
import type { Tx } from "../lib/types";
import { Drawer, Hash, KV, Pill, Skeleton } from "./ui";

export function TxStatus({ status, confirmations }: { status: Tx["status"]; confirmations?: number | null }) {
  if (status === "CONFIRMED")
    return (
      <Pill tone="success" icon={<CircleCheck className="h-3.5 w-3.5" />}>
        Confirmed{confirmations ? ` · ${confirmations}` : ""}
      </Pill>
    );
  if (status === "FAILED")
    return (
      <Pill tone="danger" icon={<CircleX className="h-3.5 w-3.5" />}>
        Failed
      </Pill>
    );
  return (
    <Pill tone="progress" icon={<Loader2 className="h-3.5 w-3.5 animate-spin" />}>
      Submitted
    </Pill>
  );
}

const SIGNER: Record<string, string> = {
  gateway: "IoT gateway",
  officer: "Municipal wallet",
  "officer-bridgekey": "Officer · BridgeKey",
  admin: "Admin",
};

/** Explorer-style rows for a list of transactions. */
export function TxList({ txs, onOpen, compact }: { txs: Tx[]; onOpen: (hash: string) => void; compact?: boolean }) {
  if (!txs.length) return <div className="px-5 py-8 text-center text-[13px] text-ink-3">No transactions yet.</div>;
  return (
    <ul className="divide-y divide-line-2">
      {txs.map((t) => (
        <li key={t.hash}>
          <button onClick={() => onOpen(t.hash)} className="flex w-full items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-raised">
            <span className={clsx("flex h-8 w-8 shrink-0 items-center justify-center rounded-md", t.status === "CONFIRMED" ? "bg-sunken text-ink-2" : t.status === "FAILED" ? "bg-bad-bg text-bad" : "bg-prog-bg text-prog")}>
              {t.status === "SUBMITTED" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13.5px] font-medium text-ink">{t.actionLabel}</span>
                {t.requestCode && <span className="font-mono text-[11.5px] text-ink-3">{t.requestCode}</span>}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[12px] text-ink-3">
                <span className="font-mono">{t.hash.slice(0, 10)}…{t.hash.slice(-6)}</span>
                {!compact && t.blockNumber !== null && <span className="num">block {t.blockNumber}</span>}
              </div>
            </div>
            <div className="shrink-0 text-right">
              {t.valueMstc && t.action === "WORKER_PAYMENT" ? <div className="text-[13px] font-medium num">{mstc(t.valueMstc)}</div> : null}
              <div className="text-[11.5px] text-ink-3 num">{time(t.createdAt, true)}</div>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function TxDrawer({ hash, onClose }: { hash: string | null; onClose: () => void }) {
  const { data: t, isLoading } = useTx(hash);
  const { data: cfg } = useConfig();
  return (
    <Drawer
      open={!!hash}
      onClose={onClose}
      title={t ? t.actionLabel : "Transaction"}
      subtitle={t ? `${t.network} · chain ${t.chainId}` : undefined}
      width={560}
      footer={
        t?.url ? (
          <a href={t.url} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-md bg-ink px-3.5 text-[13.5px] font-medium text-white hover:bg-[#2a2b30]">
            View on MSTScan <ExternalLink className="h-4 w-4" />
          </a>
        ) : cfg?.isLocal ? (
          <span className="text-[12.5px] text-ink-3">Local rehearsal chain: no public explorer. On MST Testnet this opens MSTScan.</span>
        ) : null
      }
    >
      {isLoading || !t ? (
        <div className="space-y-3 p-6">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        <div className="space-y-6 px-6 py-5">
          <div className="flex flex-wrap items-center gap-2">
            <TxStatus status={t.status} confirmations={t.confirmations} />
            <span className="text-[12.5px] text-ink-3">{dateTime(t.confirmedAt ?? t.createdAt)}</span>
          </div>
          <div>
            <div className="text-[12px] text-ink-3">Transaction hash</div>
            <div className="mt-1 break-all font-mono text-[12.5px] text-ink">{t.hash}</div>
          </div>
          <KV
            cols={2}
            items={[
              ["Block", t.blockNumber !== null ? <span className="num">{t.blockNumber.toLocaleString()}</span> : "pending"],
              ["Contract call", <span className="font-mono">{t.method}()</span>],
              ["From", <Hash value={t.from} url={t.fromUrl} />],
              ["Signed by", SIGNER[t.signer] ?? t.signer],
              ["To (ledger)", <Hash value={t.to} />],
              ["Network fee", t.feeMstc ? <span className="num">{Number(t.feeMstc).toFixed(8)} MSTC</span> : "–"],
              ...(t.wallet ? ([["Wallet involved", <Hash value={t.wallet} url={t.walletUrl} />]] as [string, JSX.Element][]) : []),
              ...(t.valueMstc ? ([[t.action === "WORKER_PAYMENT" ? "Amount paid" : "Amount", <span className="num font-medium">{mstc(t.valueMstc)}</span>]] as [string, JSX.Element][]) : []),
              ...(t.requestCode ? ([["Request", <span className="font-mono">{t.requestCode}</span>]] as [string, JSX.Element][]) : []),
              ...(t.binId ? ([["Bin", t.binId]] as [string, string][]) : []),
              ...(t.workerName ? ([["Worker", t.workerName]] as [string, string][]) : []),
              ["Gas used", t.gasUsed ? <span className="num">{Number(t.gasUsed).toLocaleString()}</span> : "–"],
            ]}
          />
          {t.input && (
            <div>
              <div className="mb-2 text-[12px] font-medium text-ink-3">Decoded input</div>
              <pre className="max-h-60 overflow-auto rounded-md border border-line-2 bg-raised p-3 font-mono text-[11.5px] leading-relaxed text-ink-2 scroll-thin">
                {t.input.method}({JSON.stringify(t.input.args, null, 2)})
              </pre>
            </div>
          )}
          <div>
            <div className="mb-2 text-[12px] font-medium text-ink-3">Events emitted</div>
            {t.events.length === 0 ? (
              <div className="text-[13px] text-ink-3">None</div>
            ) : (
              <div className="space-y-2">
                {t.events.map((e, i) => (
                  <div key={i} className="rounded-md border border-line-2 p-3">
                    <div className="text-[13px] font-medium">{e.name}</div>
                    <dl className="mt-1.5 grid grid-cols-[120px_1fr] gap-x-3 gap-y-1 text-[12px]">
                      {Object.entries(e.args).map(([k, v]) => (
                        <div key={k} className="contents">
                          <dt className="text-ink-3">{k}</dt>
                          <dd className="min-w-0 break-all font-mono text-ink-2">{String(v)}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}
              </div>
            )}
          </div>
          {t.error && <div className="rounded-md border border-bad-line bg-bad-bg p-3 text-[13px] text-bad">{t.error}</div>}
        </div>
      )}
    </Drawer>
  );
}
