import clsx from "clsx";
import { Table2, LineChart } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { time } from "../lib/format";
import type { Telemetry } from "../lib/types";

const C = {
  primary: "#2a78d6",
  secondary: "#a9a79f",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  muted: "#898781",
  ink: "#17181b",
  lidWash: "rgba(42,120,214,0.08)",
  surface: "#ffffff",
};

/**
 * Fill level over time. Emphasis form: the primary ultrasonic sensor is the
 * story (accent), the supporting sensor is context (gray). Lid-open windows
 * are a faint wash; the threshold is a hairline. Crosshair tooltip + a table
 * view carry every value, so nothing depends on hovering.
 */
export function FillChart({ data, threshold, height = 220, className }: { data: Telemetry[]; threshold?: number; height?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const [view, setView] = useState<"chart" | "table">("chart");

  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const m = { l: 38, r: 52, t: 12, b: 26 };
  const pts = useMemo(() => data.map((d) => ({ ...d, t: new Date(d.ts).getTime() })), [data]);
  const t0 = pts[0]?.t ?? Date.now() - 60_000;
  const t1 = Math.max(pts[pts.length - 1]?.t ?? Date.now(), t0 + 1000);
  const x = (t: number) => m.l + ((t - t0) / (t1 - t0)) * (width - m.l - m.r);
  const y = (v: number) => m.t + (1 - v / 100) * (height - m.t - m.b);

  const line = (key: "fill" | "fill2") => {
    let d = "";
    let pen = false;
    for (const p of pts) {
      const v = p[key];
      if (v === null || v === undefined) {
        pen = false;
        continue;
      }
      d += `${pen ? "L" : "M"}${x(p.t).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  const bands: [number, number][] = [];
  for (let i = 0; i < pts.length; i++) {
    if (pts[i].lid !== "open") continue;
    let j = i;
    while (j + 1 < pts.length && pts[j + 1].lid === "open") j++;
    bands.push([pts[i].t, pts[Math.min(j + 1, pts.length - 1)].t]);
    i = j;
  }

  const xticks = useMemo(() => {
    const n = Math.max(2, Math.min(5, Math.floor((width - m.l - m.r) / 120)));
    return Array.from({ length: n + 1 }, (_, i) => t0 + ((t1 - t0) * i) / n);
  }, [t0, t1, width]);

  const last = pts[pts.length - 1];
  const hp = hover !== null ? pts[hover] : null;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = t0 + ((px - m.l) / (width - m.l - m.r)) * (t1 - t0);
    let best = 0;
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].t - t) < Math.abs(pts[best].t - t)) best = i;
    setHover(pts.length ? best : null);
  };

  return (
    <div className={clsx("min-w-0", className)}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-4 text-[12px] text-ink-2">
          <Key color={C.primary} label="Primary ultrasonic" />
          <Key color={C.secondary} label="Supporting sensor" thin />
          <span className="inline-flex items-center gap-1.5">
            <span className="h-3 w-3 rounded-[2px]" style={{ background: C.lidWash, boxShadow: "inset 0 0 0 1px rgba(42,120,214,0.25)" }} />
            Lid open
          </span>
          {threshold !== undefined && <Key color={C.muted} label={`Threshold ${threshold}%`} thin />}
        </div>
        <div className="inline-flex rounded-md border border-line p-0.5">
          <button onClick={() => setView("chart")} className={clsx("rounded px-2 py-1 text-[12px]", view === "chart" ? "bg-sunken text-ink" : "text-ink-3")} aria-label="Chart view">
            <LineChart className="h-3.5 w-3.5" />
          </button>
          <button onClick={() => setView("table")} className={clsx("rounded px-2 py-1 text-[12px]", view === "table" ? "bg-sunken text-ink" : "text-ink-3")} aria-label="Table view">
            <Table2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {view === "table" ? (
        <div className="max-h-[260px] overflow-auto rounded-md border border-line-2 scroll-thin">
          <table className="w-full text-[12.5px]">
            <thead className="sticky top-0 bg-raised text-ink-3">
              <tr>
                {["Time", "Primary", "Supporting", "Lid", "Servo", "IR deposits"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="num">
              {[...pts].reverse().map((p, i) => (
                <tr key={i} className="border-t border-line-2">
                  <td className="px-3 py-1.5 text-ink-2">{time(p.ts, true)}</td>
                  <td className="px-3 py-1.5">{p.fill.toFixed(1)}%</td>
                  <td className="px-3 py-1.5 text-ink-2">{p.fill2 === null ? "–" : `${p.fill2.toFixed(1)}%`}</td>
                  <td className={clsx("px-3 py-1.5", p.lid === "open" ? "text-prog" : "text-ink-3")}>{p.lid}</td>
                  <td className="px-3 py-1.5 text-ink-3">{p.servo}</td>
                  <td className="px-3 py-1.5 text-ink-3">{p.ir || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} className="relative">
          <svg width={width} height={height} className="block touch-none select-none" onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Fill level over time">
            {bands.map(([a, b], i) => (
              <rect key={i} x={x(a)} y={m.t} width={Math.max(2, x(b) - x(a))} height={height - m.t - m.b} fill={C.lidWash} />
            ))}
            {[0, 25, 50, 75, 100].map((v) => (
              <g key={v}>
                <line x1={m.l} x2={width - m.r} y1={y(v)} y2={y(v)} stroke={v === 0 ? C.axis : C.grid} strokeWidth={1} />
                <text x={m.l - 8} y={y(v) + 3.5} textAnchor="end" fontSize={11} fill={C.muted} className="num">
                  {v}%
                </text>
              </g>
            ))}
            {threshold !== undefined && (
              <line x1={m.l} x2={width - m.r} y1={y(threshold)} y2={y(threshold)} stroke={C.muted} strokeWidth={1} opacity={0.7} />
            )}
            {xticks.map((t, i) => (
              <text key={i} x={x(t)} y={height - 7} textAnchor={i === 0 ? "start" : i === xticks.length - 1 ? "end" : "middle"} fontSize={11} fill={C.muted} className="num">
                {time(new Date(t).toISOString(), true)}
              </text>
            ))}
            <path d={line("fill2")} fill="none" stroke={C.secondary} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
            <path d={line("fill")} fill="none" stroke={C.primary} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {last && (
              <g>
                <circle cx={x(last.t)} cy={y(last.fill)} r={4} fill={C.primary} stroke={C.surface} strokeWidth={2} />
                <text x={x(last.t) + 8} y={y(last.fill) + 4} fontSize={12} fontWeight={600} fill={C.ink} className="num">
                  {last.fill.toFixed(0)}%
                </text>
              </g>
            )}
            {hp && (
              <g pointerEvents="none">
                <line x1={x(hp.t)} x2={x(hp.t)} y1={m.t} y2={height - m.b} stroke={C.ink} strokeOpacity={0.25} strokeWidth={1} />
                {hp.fill2 !== null && <circle cx={x(hp.t)} cy={y(hp.fill2)} r={4} fill={C.secondary} stroke={C.surface} strokeWidth={2} />}
                <circle cx={x(hp.t)} cy={y(hp.fill)} r={4} fill={C.primary} stroke={C.surface} strokeWidth={2} />
              </g>
            )}
            {pts.length === 0 && (
              <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={12} fill={C.muted}>
                No readings in this window
              </text>
            )}
          </svg>
          {hp && (
            <div
              className="pointer-events-none absolute top-2 z-10 min-w-[150px] rounded-md border border-line bg-surface px-3 py-2 text-[12px] shadow-float"
              style={{ left: Math.min(Math.max(0, x(hp.t) + 12), width - 170) }}
            >
              <div className="mb-1 text-ink-3 num">{time(hp.ts, true)}</div>
              <Row color={C.primary} value={`${hp.fill.toFixed(1)}%`} label="Primary" />
              {hp.fill2 !== null && <Row color={C.secondary} value={`${hp.fill2.toFixed(1)}%`} label="Supporting" />}
              <div className="mt-1 text-ink-3">
                Lid {hp.lid} · servo {hp.servo}
                {hp.ir ? ` · ${hp.ir} deposit${hp.ir > 1 ? "s" : ""}` : ""}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Key({ color, label, thin }: { color: string; label: string; thin?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block w-4 rounded-full" style={{ height: thin ? 1.5 : 2, background: color }} />
      {label}
    </span>
  );
}

function Row({ color, value, label }: { color: string; value: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-block h-[2px] w-3 rounded-full" style={{ background: color }} />
      <span className="num font-semibold text-ink">{value}</span>
      <span className="text-ink-3">{label}</span>
    </div>
  );
}
