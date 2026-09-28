import clsx from "clsx";
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from "framer-motion";
import { Check, Copy, ExternalLink, Loader2, X } from "lucide-react";
import { forwardRef, useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { Tone } from "@astra/shared";
import { shortHash } from "../../lib/format";
import { TONE } from "../../lib/tone";

// ---------------------------------------------------------------- buttons

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "success";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  icon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className, children, disabled, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={clsx(
        "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap font-medium transition-[background,box-shadow,color,transform] duration-150 active:translate-y-px disabled:opacity-50",
        size === "sm" && "h-8 rounded-md px-3 text-[13px]",
        size === "md" && "h-9 rounded-md px-3.5 text-[13.5px]",
        size === "lg" && "h-11 rounded-lg px-5 text-[14.5px]",
        variant === "primary" && "bg-ink text-white shadow-[0_1px_0_rgb(255_255_255/0.08)_inset,0_1px_2px_rgb(0_0_0/0.18)] hover:bg-[#2a2b30]",
        variant === "secondary" && "border border-line bg-surface text-ink shadow-panel hover:border-[#d9d7d0] hover:bg-raised",
        variant === "ghost" && "text-ink-2 hover:bg-hover hover:text-ink",
        variant === "danger" && "border border-bad-line bg-surface text-bad hover:bg-bad-bg",
        variant === "success" && "bg-good text-white hover:bg-[#276843]",
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

// ------------------------------------------------------------- status bits

export function Dot({ tone = "neutral", pulse, className }: { tone?: Tone; pulse?: boolean; className?: string }) {
  return (
    <span className={clsx("relative inline-flex h-2 w-2 shrink-0", className)}>
      {pulse && <span className={clsx("pulse-ring absolute inset-0 rounded-full", TONE[tone].dot)} />}
      <span className={clsx("relative inline-flex h-2 w-2 rounded-full", TONE[tone].dot)} />
    </span>
  );
}

export function Pill({ tone = "neutral", children, dot = true, pulse, className, icon }: { tone?: Tone; children: ReactNode; dot?: boolean; pulse?: boolean; className?: string; icon?: ReactNode }) {
  return (
    <span className={clsx("inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-[12px] font-medium", TONE[tone].bg, TONE[tone].text, TONE[tone].line, className)}>
      {icon ?? (dot && <Dot tone={tone} pulse={pulse} />)}
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx("h-4 w-4 animate-spin text-ink-3", className)} />;
}

// ------------------------------------------------------------------ panels

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
  flush,
  id,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  flush?: boolean;
  id?: string;
}) {
  return (
    <section id={id} className={clsx("panel min-w-0", className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-line-2 px-5 py-3.5">
          <div className="min-w-0">
            {title && <h2 className="text-[14px] font-semibold tracking-[-0.005em] text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[12.5px] text-ink-3">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={clsx(!flush && "p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="eyebrow mb-2">{eyebrow}</div>}
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] text-ink">{title}</h1>
        {subtitle && <p className="mt-1.5 max-w-2xl text-[14px] text-ink-2">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Empty({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon && <div className="mb-3 text-ink-4">{icon}</div>}
      <div className="text-[14px] font-medium text-ink">{title}</div>
      {body && <div className="mt-1 max-w-sm text-[13px] text-ink-3">{body}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("skeleton", className)} />;
}

export function KV({ items, cols = 1 }: { items: [ReactNode, ReactNode][]; cols?: 1 | 2 | 3 }) {
  return (
    <dl className={clsx("grid gap-x-6 gap-y-3", cols === 2 && "sm:grid-cols-2", cols === 3 && "sm:grid-cols-3")}>
      {items.map(([k, v], i) => (
        <div key={i} className="min-w-0">
          <dt className="text-[12px] text-ink-3">{k}</dt>
          <dd className="mt-0.5 truncate text-[13.5px] text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// -------------------------------------------------------------- hashes

export function Hash({ value, url, chars = [6, 4], copy = true, className }: { value?: string | null; url?: string | null; chars?: [number, number]; copy?: boolean; className?: string }) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-ink-4">–</span>;
  return (
    <span className={clsx("inline-flex min-w-0 items-center gap-1 font-mono text-[12.5px] text-ink", className)}>
      {url ? (
        <a href={url} target="_blank" rel="noreferrer" className="truncate underline decoration-line underline-offset-2 hover:decoration-ink-3" title={value}>
          {shortHash(value, chars[0], chars[1])}
        </a>
      ) : (
        <span className="truncate" title={value}>
          {shortHash(value, chars[0], chars[1])}
        </span>
      )}
      {copy && (
        <button
          type="button"
          aria-label="Copy"
          className="rounded p-0.5 text-ink-4 hover:bg-hover hover:text-ink-2"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            navigator.clipboard?.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5 text-good" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      )}
      {url && (
        <a href={url} target="_blank" rel="noreferrer" aria-label="View on explorer" className="rounded p-0.5 text-ink-4 hover:bg-hover hover:text-ink-2">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
    </span>
  );
}

// ----------------------------------------------------------- navigation

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode; count?: number }[] }) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b border-line scroll-thin">
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          onClick={() => onChange(it.value)}
          className={clsx(
            "relative -mb-px flex h-10 items-center gap-2 whitespace-nowrap px-3 text-[13.5px] transition-colors",
            value === it.value ? "font-medium text-ink" : "text-ink-3 hover:text-ink-2",
          )}
        >
          {it.label}
          {it.count !== undefined && (
            <span className={clsx("num rounded-full px-1.5 text-[11px] font-semibold", value === it.value ? "bg-ink text-white" : "bg-sunken text-ink-3")}>{it.count}</span>
          )}
          {value === it.value && <motion.span layoutId="tab-underline" className="absolute inset-x-2 -bottom-px h-[2px] rounded-full bg-ink" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ value, onChange, items, size = "md" }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode }[]; size?: "sm" | "md" }) {
  return (
    <div role="radiogroup" className={clsx("inline-flex rounded-lg bg-sunken p-0.5", size === "sm" ? "text-[12px]" : "text-[13px]")}>
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="radio"
          aria-checked={value === it.value}
          onClick={() => onChange(it.value)}
          className={clsx(
            "relative rounded-md px-3 font-medium transition-colors",
            size === "sm" ? "h-7" : "h-8",
            value === it.value ? "text-ink" : "text-ink-3 hover:text-ink-2",
          )}
        >
          {value === it.value && <motion.span layoutId={`seg-${items.map((i) => i.value).join("")}`} className="absolute inset-0 rounded-md bg-surface shadow-panel" transition={{ type: "spring", stiffness: 500, damping: 40 }} />}
          <span className="relative">{it.label}</span>
        </button>
      ))}
    </div>
  );
}

// -------------------------------------------------------------- overlays

export function Drawer({ open, onClose, title, subtitle, children, width = 520, footer }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; width?: number; footer?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[1200]">
          <motion.div className="absolute inset-0 bg-ink/15" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.aside
            role="dialog"
            aria-modal
            className="absolute inset-y-0 right-0 flex max-w-full flex-col border-l border-line bg-surface shadow-pop"
            style={{ width }}
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
          >
            <header className="flex items-start justify-between gap-4 border-b border-line-2 px-6 py-4">
              <div className="min-w-0">
                <div className="text-[16px] font-semibold tracking-[-0.01em]">{title}</div>
                {subtitle && <div className="mt-0.5 text-[12.5px] text-ink-3">{subtitle}</div>}
              </div>
              <button onClick={onClose} className="rounded-md p-1.5 text-ink-3 hover:bg-hover hover:text-ink" aria-label="Close">
                <X className="h-4 w-4" />
              </button>
            </header>
            <div className="flex-1 overflow-y-auto scroll-thin">{children}</div>
            {footer && <footer className="border-t border-line-2 px-6 py-4">{footer}</footer>}
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}

export function Modal({ open, onClose, title, children, footer, width = 440 }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number }) {
  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[1300] flex items-center justify-center p-4">
          <motion.div className="absolute inset-0 bg-ink/20" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.div
            role="dialog"
            aria-modal
            className="relative w-full rounded-xl border border-line bg-surface shadow-pop"
            style={{ maxWidth: width }}
            initial={{ y: 8, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 4, opacity: 0, scale: 0.99 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="px-6 pb-2 pt-5 text-[16px] font-semibold tracking-[-0.01em]">{title}</div>
            <div className="px-6 pb-5 text-[13.5px] text-ink-2">{children}</div>
            {footer && <div className="flex justify-end gap-2 rounded-b-xl border-t border-line-2 bg-raised px-6 py-3.5">{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

// ------------------------------------------------------------ numbers

/** Numbers that glide to their new value instead of jumping. */
export function AnimatedNumber({ value, decimals = 0, suffix = "", className }: { value: number | null | undefined; decimals?: number; suffix?: string; className?: string }) {
  const mv = useMotionValue(value ?? 0);
  const text = useTransform(mv, (v) => `${v.toFixed(decimals)}${suffix}`);
  useEffect(() => {
    if (value === null || value === undefined) return;
    const c = animate(mv, value, { duration: 0.6, ease: [0.22, 1, 0.36, 1] });
    return c.stop;
  }, [value, mv]);
  if (value === null || value === undefined) return <span className={className}>–</span>;
  return <motion.span className={className}>{text}</motion.span>;
}

/** A number that animates toward `target` (tween or spring) and re-renders each frame. */
export function useTween(target: number, opts: { duration?: number; spring?: { stiffness: number; damping: number } } = {}) {
  const [v, setV] = useState(target);
  const current = useRef(target);
  useEffect(() => {
    const c = animate(current.current, target, {
      ...(opts.spring ? { type: "spring", ...opts.spring } : { duration: opts.duration ?? 0.8, ease: [0.22, 1, 0.36, 1] }),
      onUpdate: (x: number) => {
        current.current = x;
        setV(x);
      },
    });
    return () => c.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return v;
}

/** Same-ramp meter: the track is a lighter step of the fill's own hue. */
export function Meter({ value, max = 100, tone = "progress", threshold, className, height = 6 }: { value: number; max?: number; tone?: Tone; threshold?: number; className?: string; height?: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className={clsx("relative w-full overflow-hidden rounded-full", TONE[tone].bg, className)} style={{ height }}>
      <motion.div
        className={clsx("absolute inset-y-0 left-0 rounded-full", TONE[tone].dot)}
        initial={false}
        animate={{ width: `${pct}%` }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
      />
      {threshold !== undefined && <div className="absolute inset-y-0 w-px bg-ink/40" style={{ left: `${(threshold / max) * 100}%` }} />}
    </div>
  );
}

export const fillTone = (fill: number, threshold = 85, monitor = 70): Tone => (fill >= threshold ? "danger" : fill >= monitor ? "warning" : "neutral");

export function Avatar({ name, size = 32, tone = "neutral", className }: { name: string; size?: number; tone?: Tone; className?: string }) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <span
      className={clsx("inline-flex shrink-0 items-center justify-center rounded-full font-semibold", tone === "neutral" ? "bg-sunken text-ink-2" : clsx(TONE[tone].bg, TONE[tone].text), className)}
      style={{ width: size, height: size, fontSize: size * 0.36 }}
    >
      {initials}
    </span>
  );
}

// ---------------------------------------------------------------- tables

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={clsx("overflow-x-auto scroll-thin", className)}>
      <table className="w-full border-collapse text-left text-[13.5px]">{children}</table>
    </div>
  );
}
export function Th({ children, className, align }: { children?: ReactNode; className?: string; align?: "right" | "left" }) {
  return (
    <th className={clsx("sticky top-0 z-[1] whitespace-nowrap border-b border-line bg-raised px-4 py-2.5 text-[12px] font-medium text-ink-3", align === "right" && "text-right", className)}>
      {children}
    </th>
  );
}
export function Td({ children, className, align }: { children?: ReactNode; className?: string; align?: "right" | "left" }) {
  return <td className={clsx("whitespace-nowrap border-b border-line-2 px-4 py-3 align-middle", align === "right" && "num text-right", className)}>{children}</td>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12.5px] font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-ink-3">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "h-10 w-full rounded-md border border-line bg-surface px-3 text-[14px] text-ink shadow-[0_1px_1px_rgb(0_0_0/0.02)] outline-none transition placeholder:text-ink-4 focus:border-ink-3 focus:ring-2 focus:ring-[#dbe7f6]";
