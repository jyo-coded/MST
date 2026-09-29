import clsx from "clsx";
import { Blocks, ExternalLink, Search } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { TX_ACTION } from "@astra/shared";
import { TxDrawer, TxStatus } from "../components/Chain";
import { Dot, Empty, Hash, inputClass, PageHeader, Panel, Pill, Segmented, Skeleton, Table, Td, Th } from "../components/ui";
import { dateTime, mstc } from "../lib/format";
import { useChainStatus, useConfig, useTxs } from "../lib/queries";

const SIGNER: Record<string, string> = {
  gateway: "IoT gateway",
  officer: "Municipal wallet",
  "officer-bridgekey": "Officer · BridgeKey",
  admin: "Admin",
};

export function Audit() {
  const { data: cfg } = useConfig();
  const { data: chain, error } = useChainStatus();
  const [action, setAction] = useState("");
  const [status, setStatus] = useState<"" | "CONFIRMED" | "SUBMITTED" | "FAILED">("");
  const [search, setSearch] = useState("");
  const { data: txs } = useTxs({ action, status });
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return txs ?? [];
    return (txs ?? []).filter((t) => `${t.hash} ${t.requestCode ?? ""} ${t.binId ?? ""} ${t.workerName ?? ""} ${t.method} ${t.from}`.toLowerCase().includes(needle));
  }, [txs, search]);

  return (
    <>
      <PageHeader
        title="Blockchain audit"
        subtitle={`Every state change this platform made on ${cfg?.networkLabel ?? "MST"}. Each row is a real transaction hash, verifiable on the explorer without trusting this dashboard.`}
      />

      <div className="panel mb-6 grid grid-cols-2 overflow-hidden md:grid-cols-3 xl:grid-cols-6">
        <Cell label="Network">
          <span className="inline-flex items-center gap-1.5">
            <Dot tone={chain ? "success" : error ? "danger" : "neutral"} pulse={!!chain} />
            {cfg?.networkLabel ?? "…"}
          </span>
        </Cell>
        <Cell label="Chain ID">
          <span className="num">{cfg?.chainId ?? "–"}</span>
        </Cell>
        <Cell label="Latest block">
          <span className="num">{chain ? chain.blockNumber.toLocaleString() : "–"}</span>
        </Cell>
        <Cell label="Ledger contract">{chain ? <Hash value={chain.contract.address} url={chain.contract.url} /> : "–"}</Cell>
        <Cell label="Transactions">
          <span className="num">{chain ? `${chain.confirmedCount} confirmed` : "–"}</span>
          {chain && chain.txCount !== chain.confirmedCount && <span className="ml-1 text-[12px] text-ink-3">/ {chain.txCount}</span>}
        </Cell>
        <Cell label="Ledger state">
          {chain ? (
            chain.paused ? (
              <Pill tone="danger">Paused</Pill>
            ) : (
              <span className="text-ink">
                Active · <span className="num">{chain.latestRequestId}</span> requests
              </span>
            )
          ) : (
            "–"
          )}
        </Cell>
      </div>

      {cfg?.isLocal && (
        <div className="mb-6 flex flex-wrap items-center gap-2 rounded-lg border border-warn-line bg-warn-bg px-4 py-3 text-[13px] text-warn">
          <span className="font-medium">Rehearsal chain.</span>
          <span className="text-ink-2">
            These are real transactions on a local EVM node (chain {cfg.chainId}), not MST. Point the server at MST Testnet (chain 91562037) and every hash here links to MSTScan.
          </span>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <Panel flush className="min-w-0">
          <div className="flex flex-wrap items-center gap-3 border-b border-line-2 px-4 py-3">
            <select className={clsx(inputClass, "h-8 w-auto text-[13px]")} value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action">
              <option value="">All actions</option>
              {Object.entries(TX_ACTION).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <Segmented
              size="sm"
              value={status}
              onChange={setStatus}
              items={[
                { value: "", label: "All" },
                { value: "CONFIRMED", label: "Confirmed" },
                { value: "SUBMITTED", label: "Pending" },
                { value: "FAILED", label: "Failed" },
              ]}
            />
            <div className="relative ml-auto w-full max-w-[280px]">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4" />
              <input className={clsx(inputClass, "h-8 pl-9 text-[13px]")} placeholder="Hash, request, bin, worker" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
          </div>
          {!txs ? (
            <div className="space-y-2 p-5">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <Empty icon={<Blocks className="h-8 w-8" />} title="No transactions match" body="Run the demo or act on a request; each decision lands here with its hash." />
          ) : (
            <Table className="max-h-[720px]">
              <thead>
                <tr>
                  <Th>Transaction</Th>
                  <Th>Action</Th>
                  <Th>Subject</Th>
                  <Th>Signed by</Th>
                  <Th align="right">Block</Th>
                  <Th align="right">Value</Th>
                  <Th align="right">Fee</Th>
                  <Th>Status</Th>
                  <Th>Time</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.hash} onClick={() => setOpen(t.hash)} className="cursor-pointer transition-colors hover:bg-raised">
                    <Td>
                      <span className="font-mono text-[12.5px]">
                        {t.hash.slice(0, 10)}…{t.hash.slice(-6)}
                      </span>
                    </Td>
                    <Td>
                      <div className="font-medium">{t.actionLabel}</div>
                      <div className="font-mono text-[11.5px] text-ink-3">{t.method}()</div>
                    </Td>
                    <Td>
                      <div className="text-[13px]">
                        {t.requestCode && <span className="font-mono text-[12px]">{t.requestCode}</span>}
                        {t.requestCode && t.binId && <span className="text-ink-3"> · </span>}
                        {t.binId}
                        {!t.requestCode && !t.binId && <span className="text-ink-4">–</span>}
                      </div>
                      {t.workerName && <div className="text-[12px] text-ink-3">{t.workerName}</div>}
                    </Td>
                    <Td>
                      <span className="text-ink-2">{SIGNER[t.signer] ?? t.signer}</span>
                    </Td>
                    <Td align="right">{t.blockNumber ?? <span className="text-ink-4">–</span>}</Td>
                    <Td align="right">{t.valueMstc && Number(t.valueMstc) > 0 ? mstc(t.valueMstc) : <span className="text-ink-4">–</span>}</Td>
                    <Td align="right">{t.feeMstc ? <span className="text-ink-3">{Number(t.feeMstc).toFixed(6)}</span> : <span className="text-ink-4">–</span>}</Td>
                    <Td>
                      <TxStatus status={t.status} />
                    </Td>
                    <Td>
                      <span className="whitespace-nowrap text-ink-3 num">{dateTime(t.createdAt)}</span>
                    </Td>
                    <Td>
                      {t.url && (
                        <a href={t.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 whitespace-nowrap text-[12.5px] font-medium text-ink-2 hover:text-ink">
                          Explorer <ExternalLink className="h-3.5 w-3.5" />
                        </a>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>

        <div className="min-w-0 space-y-6">
          <Panel title="Platform wallets" subtitle="Each role signs only what it is allowed to" flush>
            {!chain ? (
              <div className="p-5">
                <Skeleton className="h-24 w-full" />
              </div>
            ) : (
              <ul className="divide-y divide-line-2">
                {chain.wallets.map((w) => (
                  <li key={w.role} className="px-5 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13.5px] font-medium">{w.role}</span>
                      <span className="text-[12.5px] text-ink-2 num">{w.balanceMstc !== null ? mstc(w.balanceMstc) : "–"}</span>
                    </div>
                    <div className="mt-0.5 text-[12px] text-ink-3">{w.purpose}</div>
                    <div className="mt-1">
                      <Hash value={w.address} url={w.url} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Ledger fund">
            {!chain ? (
              <Skeleton className="h-16 w-full" />
            ) : (
              <dl className="grid grid-cols-2 gap-3 text-[13px]">
                <Fact label="Balance">{mstc(chain.fund.balanceMstc)}</Fact>
                <Fact label="Reserved">{mstc(chain.fund.reservedMstc)}</Fact>
                <Fact label="Free">{mstc(chain.fund.freeMstc)}</Fact>
                <Fact label="Paid out">{mstc(chain.fund.totalPaidMstc)}</Fact>
              </dl>
            )}
          </Panel>

          <Panel title="Verify it yourself">
            <ol className="list-decimal space-y-2 pl-4 text-[13px] text-ink-2">
              <li>
                Open {cfg?.explorerUrl ? <a className="font-medium text-ink underline decoration-line underline-offset-2" href={cfg.explorerUrl} target="_blank" rel="noreferrer">MSTScan</a> : "MSTScan (testnet.mstscan.com)"} and search the ledger contract address above.
              </li>
              <li>Every transaction there should appear in this list, and nothing here should be missing there.</li>
              <li>Open a payment: the value goes from the contract to the worker's registered wallet, emitting PaymentReleased.</li>
              <li>Decoded inputs and events are in each transaction's detail drawer.</li>
            </ol>
          </Panel>
        </div>
      </div>
      <TxDrawer hash={open} onClose={() => setOpen(null)} />
    </>
  );
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 border-line-2 px-4 py-3.5 [&:not(:first-child)]:border-l max-md:[&:nth-child(odd)]:border-l-0 max-md:[&:nth-child(n+3)]:border-t md:max-xl:[&:nth-child(3n+1)]:border-l-0 md:max-xl:[&:nth-child(n+4)]:border-t">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className="mt-1 truncate text-[14px] font-medium text-ink">{children}</div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[11.5px] text-ink-3">{label}</dt>
      <dd className="mt-0.5 font-medium num">{children}</dd>
    </div>
  );
}
