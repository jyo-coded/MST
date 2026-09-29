import clsx from "clsx";
import { ClipboardList, Fingerprint } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Empty, Hash, PageHeader, Panel, Pill, Table, Tabs, Td, Th } from "../components/ui";
import { ago, pct, time } from "../lib/format";
import { useRequests } from "../lib/queries";
import type { Request } from "../lib/types";

const TABS = [
  { value: "all", label: "All", match: () => true },
  { value: "approval", label: "Needs approval", match: (r: Request) => ["AWAITING_APPROVAL", "APPROVED"].includes(r.status) },
  { value: "active", label: "In progress", match: (r: Request) => ["ASSIGNED", "EN_ROUTE", "COLLECTING", "REVERIFYING", "DETECTED", "AI_VERIFIED"].includes(r.status) },
  { value: "final", label: "Awaiting final approval", match: (r: Request) => ["AWAITING_FINAL_APPROVAL", "INVESTIGATION"].includes(r.status) },
  { value: "done", label: "Completed", match: (r: Request) => r.status === "COMPLETED" },
  { value: "rejected", label: "Rejected", match: (r: Request) => r.status === "REJECTED" },
] as const;

const PRIORITY: Record<string, { label: string; tone: "danger" | "warning" | "neutral" }> = {
  critical: { label: "Critical", tone: "danger" },
  high: { label: "High", tone: "warning" },
  normal: { label: "Normal", tone: "neutral" },
  low: { label: "Low", tone: "neutral" },
};

export function Requests() {
  const { data } = useRequests();
  const [tab, setTab] = useState<(typeof TABS)[number]["value"]>("all");
  const navigate = useNavigate();
  const rows = useMemo(() => (data ?? []).filter(TABS.find((t) => t.value === tab)!.match), [data, tab]);

  return (
    <>
      <PageHeader title="Collection requests" subtitle="Every request is born from an AI-verified sensor reading and recorded on MST before it reaches you." />
      <Panel flush>
        <div className="px-3 pt-1">
          <Tabs value={tab} onChange={setTab} items={TABS.map((t) => ({ value: t.value, label: t.label, count: (data ?? []).filter(t.match).length }))} />
        </div>
        {rows.length === 0 ? (
          <Empty icon={<ClipboardList className="h-8 w-8" />} title="No requests here" body="New requests appear the moment a bin's sensors cross the threshold and the AI agrees." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Request</Th>
                <Th>Bin · location</Th>
                <Th align="right">Detected fill</Th>
                <Th>Detected</Th>
                <Th align="right">AI confidence</Th>
                <Th>Priority</Th>
                <Th>Worker</Th>
                <Th>Status</Th>
                <Th>On-chain</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => navigate(`/app/requests/${r.id}`)} className="cursor-pointer transition-colors hover:bg-raised">
                  <Td>
                    <span className="font-mono text-[12.5px] font-medium">{r.code}</span>
                  </Td>
                  <Td>
                    <div className="font-medium">
                      {r.binId} <span className="font-normal text-ink-2">{r.binName}</span>
                    </div>
                    <div className="text-[12px] text-ink-3">{r.zone}</div>
                  </Td>
                  <Td align="right">{pct(r.detectedFill)}</Td>
                  <Td>
                    <div className="num">{time(r.detectedAt, true)}</div>
                    <div className="text-[12px] text-ink-3">{ago(r.detectedAt)}</div>
                  </Td>
                  <Td align="right">
                    <span className={clsx(r.aiConfidence !== null && r.aiConfidence < 80 && "text-bad")}>{r.aiConfidence !== null ? `${r.aiConfidence.toFixed(1)}%` : "–"}</span>
                  </Td>
                  <Td>
                    <Pill tone={PRIORITY[r.priority]?.tone ?? "neutral"} dot={false}>
                      {PRIORITY[r.priority]?.label ?? r.priority}
                    </Pill>
                  </Td>
                  <Td>{r.workerName ?? <span className="text-ink-4">–</span>}</Td>
                  <Td>
                    <div className="flex items-center gap-1.5">
                      <Pill tone={r.tone} pulse={["progress"].includes(r.tone)}>
                        {r.statusLabel}
                      </Pill>
                      {r.rfidAlert && <Fingerprint className="h-4 w-4 text-bad" aria-label="RFID alert" />}
                    </div>
                  </Td>
                  <Td>{r.createdTx ? <Hash value={r.createdTx.hash} url={r.createdTx.url} copy={false} /> : <span className="text-[12px] text-ink-4">not recorded</span>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </>
  );
}
