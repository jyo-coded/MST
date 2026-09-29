import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Link2, X } from "lucide-react";
import { LIFECYCLE, SIDE_EVENTS, stageLabel } from "@astra/shared";
import { time } from "../lib/format";
import { TONE } from "../lib/tone";
import type { LifecycleEvent, Request } from "../lib/types";
import { Hash } from "./ui";

type StageState = "done" | "current" | "upcoming" | "failed" | "warning";

/** Works out, for each storyline stage, whether it happened, is happening, or failed. */
export function stageStates(events: LifecycleEvent[], request?: Request | null, binOnChain = true) {
  const byStage = new Map<string, LifecycleEvent>();
  for (const e of events) if (!byStage.has(e.stage)) byStage.set(e.stage, e);
  const has = (s: string) => byStage.has(s);
  const states: { key: string; label: string; short: string; onChain: boolean; state: StageState; event?: LifecycleEvent }[] = LIFECYCLE.map((s) => ({
    key: s.key,
    label: s.label,
    short: s.short,
    onChain: s.onChain,
    state: (s.key === "BIN_REGISTERED" ? (binOnChain ? "done" : "upcoming") : has(s.key) ? "done" : "upcoming") as StageState,
    event: byStage.get(s.key),
  }));
  const terminal = request && (request.status === "REJECTED" || (request.status === "COMPLETED" && request.paymentStatus === "PAID"));
  const failAt = (stage: string) => {
    const st = states.find((s) => s.key === stage);
    if (st && st.state !== "done") st.state = "failed";
  };
  if (has("AI_FULLNESS_REJECTED")) failAt("AI_FULLNESS_VERIFIED");
  if (has("REQUEST_REJECTED")) failAt("MUNICIPAL_APPROVAL");
  if (has("AI_COMPLETION_REJECTED")) failAt("AI_COMPLETION_VERIFIED");
  if (has("COMPLETION_REJECTED")) failAt("MUNICIPAL_COMPLETION_APPROVED");
  if (has("PAYMENT_FAILED") && !has("PAYMENT_CONFIRMED")) failAt("PAYMENT_CONFIRMED");
  if (has("RFID_MISMATCH") && !has("RFID_VERIFIED")) {
    const st = states.find((s) => s.key === "RFID_VERIFIED");
    if (st) st.state = "warning";
  }
  if (!terminal && !states.some((s) => s.state === "failed")) {
    const next = states.find((s) => s.state === "upcoming" || s.state === "warning");
    if (next && next.state === "upcoming") next.state = "current";
  }
  return states;
}

export function LifecycleStepper({ events, request, binOnChain = true, compact }: { events: LifecycleEvent[]; request?: Request | null; binOnChain?: boolean; compact?: boolean }) {
  const states = stageStates(events, request, binOnChain);
  return (
    <div className="overflow-x-auto pb-1 scroll-thin">
      <ol className="flex min-w-[980px] items-start">
        {states.map((s, i) => {
          const last = i === states.length - 1;
          const doneLine = s.state === "done" && states[i + 1]?.state !== "upcoming";
          return (
            <li key={s.key} className="relative flex flex-1 flex-col items-center text-center">
              {!last && <span className={clsx("absolute left-1/2 top-[11px] h-px w-full", doneLine ? "bg-ink/70" : "bg-line")} />}
              <motion.span
                initial={false}
                animate={{ scale: s.state === "current" ? 1.08 : 1 }}
                className={clsx(
                  "relative z-[1] flex h-[23px] w-[23px] items-center justify-center rounded-full border text-[10.5px] font-semibold",
                  s.state === "done" && (s.key === "PAYMENT_CONFIRMED" ? "border-good bg-good text-white" : "border-ink bg-ink text-white"),
                  s.state === "current" && "border-prog-dot bg-surface text-prog",
                  s.state === "upcoming" && "border-line bg-surface text-ink-4",
                  s.state === "failed" && "border-bad-dot bg-bad-dot text-white",
                  s.state === "warning" && "border-warn-dot bg-warn-bg text-warn",
                )}
              >
                {s.state === "current" && <span className="pulse-ring absolute inset-0 rounded-full bg-prog-dot/40" />}
                {s.state === "done" ? <Check className="h-3 w-3" strokeWidth={3} /> : s.state === "failed" ? <X className="h-3 w-3" strokeWidth={3} /> : i + 1}
                {s.onChain && (
                  <span className={clsx("absolute -right-1.5 -top-1.5 flex h-3.5 w-3.5 items-center justify-center rounded-full border bg-surface", s.state === "done" ? "border-ink/30 text-ink" : "border-line text-ink-4")}>
                    <Link2 className="h-2 w-2" strokeWidth={2.5} />
                  </span>
                )}
              </motion.span>
              <span className={clsx("mt-2 px-1 text-[11.5px] leading-tight", s.state === "upcoming" ? "text-ink-3" : s.state === "failed" ? "font-medium text-bad" : "font-medium text-ink")}>
                {s.short}
              </span>
              {!compact && (
                <span className="mt-0.5 h-4 text-[10.5px] text-ink-3 num">
                  {s.event?.tx ? (
                    s.event.tx.url ? (
                      <a className="font-mono underline decoration-line underline-offset-2 hover:text-ink" href={s.event.tx.url} target="_blank" rel="noreferrer">
                        {s.event.tx.hash.slice(0, 6)}…
                      </a>
                    ) : (
                      <span className="font-mono" title={s.event.tx.hash}>
                        {s.event.tx.hash.slice(0, 6)}…
                      </span>
                    )
                  ) : s.event ? (
                    time(s.event.ts)
                  ) : (
                    ""
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Vertical lifecycle log, like a delivery tracker. */
export function Timeline({ events, empty = "Nothing has happened yet." }: { events: LifecycleEvent[]; empty?: string }) {
  if (!events.length) return <div className="py-6 text-center text-[13px] text-ink-3">{empty}</div>;
  return (
    <ol className="relative">
      <AnimatePresence initial={false}>
        {events.map((e, i) => {
          const tone = TONE[e.tone] ?? TONE.info;
          const side = SIDE_EVENTS[e.stage];
          const isStage = LIFECYCLE.some((s) => s.key === e.stage);
          return (
            <motion.li
              key={e.id}
              layout
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="relative grid grid-cols-[62px_18px_1fr] gap-x-2 pb-4 last:pb-0"
            >
              <span className="pt-[1px] text-right text-[12px] text-ink-3 num">{time(e.ts, true)}</span>
              <span className="relative flex justify-center">
                {i < events.length - 1 && <span className="absolute top-3 h-[calc(100%+4px)] w-px bg-line" />}
                <span className={clsx("relative mt-[5px] h-[9px] w-[9px] rounded-full ring-[3px] ring-surface", isStage ? "bg-ink" : tone.dot)} />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className={clsx("text-[13.5px]", isStage ? "font-medium text-ink" : side?.tone === "danger" ? "text-bad" : "text-ink-2")}>{e.message}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-ink-3">
                  <span>{stageLabel(e.stage)}</span>
                  {e.tx && (
                    <span className="inline-flex items-center gap-1 rounded border border-line bg-raised px-1.5 py-[1px]">
                      <Link2 className="h-3 w-3 text-ink-3" />
                      <Hash value={e.tx.hash} url={e.tx.url} copy={false} className="!text-[11.5px]" />
                    </span>
                  )}
                </div>
              </div>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ol>
  );
}
