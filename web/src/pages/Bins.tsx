import clsx from "clsx";
import { Cpu, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MARKER, type MarkerState } from "@astra/shared";
import { Dot, Empty, fillTone, inputClass, Meter, PageHeader, Panel, Pill, Segmented, Skeleton, Table, Td, Th } from "../components/ui";
import { ago, pct } from "../lib/format";
import { useLiveBins } from "../lib/live";
import { useBins } from "../lib/queries";
import { MARKER_STYLE } from "../lib/tone";
import type { Bin } from "../lib/types";

const FILTERS = {
  all: { label: "All", match: () => true },
  attention: { label: "Needs attention", match: (b: Bin) => b.fillPct >= b.monitorPct || !["NORMAL", "MONITORING", "COMPLETED"].includes(b.marker) },
  offline: { label: "Offline", match: (b: Bin) => !b.online },
  hardware: { label: "Hardware", match: (b: Bin) => b.hardware },
} as const;
type FilterKey = keyof typeof FILTERS;

export function Bins() {
  const { data: raw } = useBins();
  const bins = useLiveBins(raw);
  const navigate = useNavigate();
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sort, setSort] = useState<"fill" | "id" | "heartbeat">("fill");
  const [q, setQ] = useState("");

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = bins.filter(FILTERS[filter].match).filter((b) => !needle || `${b.id} ${b.name} ${b.address} ${b.zone}`.toLowerCase().includes(needle));
    return list.sort((a, b) =>
      sort === "fill" ? b.fillPct - a.fillPct : sort === "id" ? a.id.localeCompare(b.id) : new Date(b.lastHeartbeat ?? 0).getTime() - new Date(a.lastHeartbeat ?? 0).getTime(),
    );
  }, [bins, filter, sort, q]);

  const byState = useMemo(() => {
    const groups = [
      { label: "Normal", states: ["NORMAL", "COMPLETED"] as MarkerState[] },
      { label: "Filling", states: ["MONITORING"] as MarkerState[] },
      { label: "Full · verifying", states: ["FULL", "AI_VERIFICATION", "AWAITING_ASSIGNMENT"] as MarkerState[] },
      { label: "Collection underway", states: ["EN_ROUTE", "COLLECTING", "AWAITING_APPROVAL"] as MarkerState[] },
      { label: "Investigation", states: ["INVESTIGATION"] as MarkerState[] },
      { label: "Offline", states: ["OFFLINE"] as MarkerState[] },
    ];
    return groups.map((g) => ({ ...g, n: bins.filter((b) => g.states.includes(b.marker)).length, color: MARKER_STYLE[g.states[0]] }));
  }, [bins]);

  return (
    <>
      <PageHeader title="Bin monitoring" subtitle="Live readings from every smart bin: two ultrasonic sensors, the lid, the servo lock, the IR deposit counter and the RFID reader." />

      <div className="panel mb-6 grid grid-cols-2 overflow-hidden sm:grid-cols-3 xl:grid-cols-6">
        {byState.map((g, i) => (
          <div key={g.label} className={clsx("px-4 py-3.5", i > 0 && "border-l border-line-2", i >= 2 && "max-sm:border-t max-sm:border-line-2", i % 2 === 0 && "max-sm:border-l-0", i >= 3 && "sm:max-xl:border-t sm:max-xl:border-line-2", i === 3 && "sm:max-xl:border-l-0")}>
            <div className="flex items-center gap-1.5 text-[12px] text-ink-3">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: g.color.hollow ? "#fff" : g.color.fill, boxShadow: `inset 0 0 0 1.5px ${g.color.hollow ? g.color.ring : "transparent"}` }} />
              {g.label}
            </div>
            <div className="mt-1 text-[24px] font-semibold leading-none tracking-[-0.02em] num">{raw ? g.n : "–"}</div>
          </div>
        ))}
      </div>

      <Panel flush>
        <div className="flex flex-wrap items-center gap-3 border-b border-line-2 px-4 py-3">
          <Segmented value={filter} onChange={setFilter} size="sm" items={(Object.keys(FILTERS) as FilterKey[]).map((k) => ({ value: k, label: `${FILTERS[k].label} · ${bins.filter(FILTERS[k].match).length}` }))} />
          <div className="relative ml-auto w-full max-w-[260px]">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4" />
            <input className={clsx(inputClass, "h-8 pl-9 text-[13px]")} placeholder="Search bins, streets, zones" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select className={clsx(inputClass, "h-8 w-auto text-[13px]")} value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} aria-label="Sort">
            <option value="fill">Fullest first</option>
            <option value="id">Bin ID</option>
            <option value="heartbeat">Latest report</option>
          </select>
        </div>
        {!raw ? (
          <div className="space-y-2 p-5">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <Empty icon={<Cpu className="h-8 w-8" />} title="No bins match" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Bin</Th>
                <Th className="w-[240px]">Fill level</Th>
                <Th align="right">Supporting</Th>
                <Th>Lid · lock</Th>
                <Th>IR</Th>
                <Th>State</Th>
                <Th>Connectivity</Th>
                <Th>Request</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id} onClick={() => navigate(`/app/bins/${b.id}`)} className="cursor-pointer transition-colors hover:bg-raised">
                  <Td>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[12.5px] font-medium">{b.id}</span>
                      {b.hardware && <Pill tone="info" dot={false} className="!h-[18px] !px-1.5 !text-[10.5px]">ESP32</Pill>}
                    </div>
                    <div className="max-w-[240px] truncate text-[12.5px] text-ink-2">{b.name}</div>
                  </Td>
                  <Td>
                    <div className="flex items-center gap-3">
                      <Meter value={b.fillPct} tone={b.online ? fillTone(b.fillPct, b.thresholdPct, b.monitorPct) : "neutral"} threshold={b.thresholdPct} className="flex-1" />
                      <span className="w-10 text-right font-medium num">{Math.round(b.fillPct)}%</span>
                    </div>
                  </Td>
                  <Td align="right">
                    <span className="text-ink-2">{pct(b.fill2Pct)}</span>
                  </Td>
                  <Td>
                    <span className="capitalize text-ink-2">
                      {b.lidState} · {b.servoState}
                    </span>
                  </Td>
                  <Td>
                    <span className={clsx("capitalize", b.irStatus === "triggered" ? "text-prog" : "text-ink-3")}>{b.irStatus}</span>
                  </Td>
                  <Td>
                    <Pill tone={MARKER[b.marker].tone}>{MARKER[b.marker].label}</Pill>
                  </Td>
                  <Td>
                    <span className="inline-flex items-center gap-1.5 text-[12.5px]">
                      <Dot tone={b.online ? "success" : "danger"} />
                      <span className={b.online ? "text-ink-2" : "text-bad"}>{b.online ? ago(b.lastHeartbeat) : `offline · ${ago(b.lastHeartbeat)}`}</span>
                    </span>
                  </Td>
                  <Td>{b.request ? <span className="font-mono text-[12px] text-ink-2">{b.request.code}</span> : <span className="text-ink-4">–</span>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Panel>
    </>
  );
}
