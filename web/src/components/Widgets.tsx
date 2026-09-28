import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { Blocks, Cpu, Database, FlaskConical, Radio, Wallet } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { LIFECYCLE } from "@astra/shared";
import { time } from "../lib/format";
import { useHealth } from "../lib/queries";
import { useLive } from "../lib/store";
import { TONE } from "../lib/tone";
import type { LifecycleEvent } from "../lib/types";
import { AnimatedNumber, Dot, Skeleton } from "./ui";

/** A single band of stat tiles: numbers are the chart. */
export function MetricsStrip({ items }: { items: { label: string; value: number | undefined; href?: string; tone?: "warning" | "danger" | "progress" | "success" }[] }) {
  return (
    <div className="panel grid grid-cols-2 overflow-hidden sm:grid-cols-4 xl:grid-cols-8">
      {items.map((it, i) => {
        const body = (
          <div
            className={clsx(
              "flex h-full flex-col justify-between gap-2 px-4 py-4 transition-colors",
              it.href && "hover:bg-raised",
              i > 0 && "border-l border-line-2",
              i >= 4 && "max-xl:border-t max-xl:border-line-2",
              i === 4 && "sm:max-xl:border-l-0",
              i % 2 === 0 && "max-sm:border-l-0",
              i >= 2 && "max-sm:border-t max-sm:border-line-2",
            )}
          >
            <div className="flex items-start gap-1.5 text-[12px] leading-tight text-ink-3">
              {it.tone && (it.value ?? 0) > 0 && <Dot tone={it.tone} pulse={it.tone !== "success"} className="mt-[3px]" />}
              <span>{it.label}</span>
            </div>
            <div className="text-[28px] font-semibold leading-none tracking-[-0.025em] text-ink">{it.value === undefined ? <Skeleton className="h-7 w-10" /> : <AnimatedNumber value={it.value} />}</div>
          </div>
        );
        return it.href ? (
          <Link key={it.label} to={it.href} className="block">
            {body}
          </Link>
        ) : (
          <div key={it.label}>{body}</div>
        );
      })}
    </div>
  );
}

const HEALTH_ICON: Record<string, ReactNode> = {
  iot: <Radio className="h-4 w-4" />,
  ai: <Cpu className="h-4 w-4" />,
  chain: <Blocks className="h-4 w-4" />,
  wallet: <Wallet className="h-4 w-4" />,
  db: <Database className="h-4 w-4" />,
  sim: <FlaskConical className="h-4 w-4" />,
};

export function SystemHealth() {
  const { data } = useHealth();
  if (!data) return <Skeleton className="h-40 w-full" />;
  return (
    <ul className="divide-y divide-line-2">
      {data.items.map((i) => {
        const tone = i.status === "online" ? "success" : i.status === "degraded" ? "warning" : "danger";
        const word = i.key === "chain" ? (i.status === "online" ? "CONNECTED" : "OFFLINE") : i.key === "wallet" && i.status === "online" ? "CONNECTED" : i.key === "sim" && i.status === "degraded" ? "LIVE MODE" : i.status.toUpperCase();
        return (
          <li key={i.key} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
            <span className="mt-0.5 text-ink-3">{HEALTH_ICON[i.key]}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium">{i.label}</span>
                <span className={clsx("inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.04em]", TONE[tone].text)}>
                  <Dot tone={tone} pulse={tone === "success"} /> {word}
                </span>
              </div>
              <div className="truncate text-[12px] text-ink-3" title={i.detail}>
                {i.detail}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The live event feed: the system narrating itself. */
export function LiveFeed({ initial, limit = 14, filter }: { initial?: LifecycleEvent[]; limit?: number; filter?: (e: LifecycleEvent) => boolean }) {
  const live = useLive((s) => s.feed);
  const events = useMemo(() => {
    const seen = new Set<number>();
    const all = [...live, ...(initial ?? [])].filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
    return all
      .filter((e) => !filter || filter(e))
      .sort((a, b) => b.id - a.id)
      .slice(0, limit);
  }, [live, initial, limit, filter]);
  if (!events.length) return <div className="py-8 text-center text-[13px] text-ink-3">Waiting for events…</div>;
  return (
    <ul className="relative">
      <AnimatePresence initial={false}>
        {events.map((e) => {
          const stage = LIFECYCLE.some((s) => s.key === e.stage);
          return (
            <motion.li
              key={e.id}
              layout
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
              <Link to={e.requestId ? `/app/requests/${e.requestId}` : e.binId ? `/app/bins/${e.binId}` : "#"} className="grid grid-cols-[58px_1fr] gap-2 rounded-md px-1 py-1.5 hover:bg-raised">
                <span className="pt-[1px] text-[11.5px] text-ink-3 num">{time(e.ts, true)}</span>
                <span className="flex min-w-0 items-start gap-2">
                  <span className={clsx("mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full", stage ? "bg-ink" : TONE[e.tone]?.dot ?? "bg-ink-4")} />
                  <span className={clsx("text-[12.5px] leading-snug", stage ? "text-ink" : e.tone === "danger" ? "text-bad" : "text-ink-2")}>{e.message}</span>
                </span>
              </Link>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ul>
  );
}
