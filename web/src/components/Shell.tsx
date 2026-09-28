import clsx from "clsx";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  Bell,
  Blocks,
  ClipboardList,
  Cpu,
  FlaskConical,
  LayoutGrid,
  LogOut,
  Map as MapIcon,
  Settings,
  Trash2,
  Truck,
  Users,
  Wallet,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "../lib/api";
import { shortHash } from "../lib/format";
import { useConfig, useHealth, useNotifications, useChainStatus } from "../lib/queries";
import { useLive, useSession, useSigning } from "../lib/store";
import { useWallet } from "../lib/wallet";
import { DemoDirector } from "./Director";
import { Button, Dot, Segmented } from "./ui";

const NAV: { group: string; items: { to: string; label: string; icon: ReactNode; badge?: "attention" | "active" | "final" | "payments" | "notifications" }[] }[] = [
  {
    group: "Operations",
    items: [
      { to: "/app", label: "Overview", icon: <LayoutGrid className="h-[17px] w-[17px]" /> },
      { to: "/app/map", label: "Live map", icon: <MapIcon className="h-[17px] w-[17px]" /> },
      { to: "/app/requests", label: "Collection requests", icon: <ClipboardList className="h-[17px] w-[17px]" />, badge: "attention" },
      { to: "/app/assign", label: "Worker assignment", icon: <Users className="h-[17px] w-[17px]" /> },
      { to: "/app/active", label: "Active collections", icon: <Truck className="h-[17px] w-[17px]" />, badge: "active" },
      { to: "/app/verification", label: "Verification center", icon: <Cpu className="h-[17px] w-[17px]" />, badge: "final" },
    ],
  },
  {
    group: "Assets",
    items: [
      { to: "/app/bins", label: "Bin monitoring", icon: <Trash2 className="h-[17px] w-[17px]" /> },
      { to: "/app/workers", label: "Workers", icon: <Users className="h-[17px] w-[17px]" /> },
    ],
  },
  {
    group: "Finance & audit",
    items: [
      { to: "/app/payments", label: "Payments", icon: <Wallet className="h-[17px] w-[17px]" />, badge: "payments" },
      { to: "/app/audit", label: "Blockchain audit", icon: <Blocks className="h-[17px] w-[17px]" /> },
    ],
  },
  {
    group: "System",
    items: [
      { to: "/app/notifications", label: "Notifications", icon: <Bell className="h-[17px] w-[17px]" />, badge: "notifications" },
      { to: "/app/settings", label: "Settings", icon: <Settings className="h-[17px] w-[17px]" /> },
    ],
  },
];

export function AppShell({ children, badges }: { children: ReactNode; badges: Record<string, number> }) {
  const [directorOpen, setDirectorOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setNavOpen(false), [location.pathname]);
  return (
    <div className="flex h-full">
      <aside className={clsx("fixed inset-y-0 left-0 z-[1100] w-[252px] shrink-0 border-r border-line bg-page transition-transform lg:static lg:translate-x-0", navOpen ? "translate-x-0 shadow-pop" : "-translate-x-full")}>
        <Sidebar badges={badges} />
      </aside>
      {navOpen && <div className="fixed inset-0 z-[1050] bg-ink/10 lg:hidden" onClick={() => setNavOpen(false)} />}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onDemo={() => setDirectorOpen(true)} onMenu={() => setNavOpen(true)} />
        <main className="min-h-0 flex-1 overflow-y-auto scroll-thin">
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="mx-auto w-full max-w-[1480px] px-5 pb-16 pt-7 sm:px-8"
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <DemoDirector open={directorOpen} onClose={() => setDirectorOpen(false)} />
      <Toaster />
    </div>
  );
}

function Sidebar({ badges }: { badges: Record<string, number> }) {
  const { data: cfg } = useConfig();
  const user = useSession((s) => s.user);
  const logout = useSession((s) => s.logout);
  const navigate = useNavigate();
  return (
    <div className="flex h-full flex-col">
      <div className="px-5 pb-4 pt-5">
        <Link to="/app" className="flex items-center gap-2.5">
          <Logo />
          <div className="leading-tight">
            <div className="text-[15px] font-semibold tracking-[-0.01em]">{cfg?.productName ?? "Astra Waste"}</div>
            <div className="text-[12px] text-ink-3">
              {cfg?.municipality.city ?? "…"} · {cfg?.municipality.ward ?? ""}
            </div>
          </div>
        </Link>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 scroll-thin">
        {NAV.map((g) => (
          <div key={g.group} className="mb-4">
            <div className="px-2.5 pb-1.5 text-[11px] font-medium text-ink-3">{g.group}</div>
            {g.items.map((it) => (
              <NavLink
                key={it.to}
                to={it.to}
                end={it.to === "/app"}
                className={({ isActive }) =>
                  clsx(
                    "group relative mb-0.5 flex h-9 items-center gap-2.5 rounded-md px-2.5 text-[13.5px] transition-colors",
                    isActive ? "bg-surface font-medium text-ink shadow-panel ring-1 ring-line" : "text-ink-2 hover:bg-hover hover:text-ink",
                  )
                }
              >
                <span className="text-ink-3 group-[.active]:text-ink">{it.icon}</span>
                <span className="flex-1 truncate">{it.label}</span>
                {it.badge && badges[it.badge] > 0 && (
                  <span className={clsx("num rounded-full px-1.5 text-[11px] font-semibold", it.badge === "notifications" || it.badge === "attention" ? "bg-ink text-white" : "bg-sunken text-ink-2")}>
                    {badges[it.badge]}
                  </span>
                )}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="border-t border-line p-3">
        <ModeSwitch />
        <HealthMini />
        {user && (
          <div className="mt-2 flex items-center gap-2.5 rounded-md px-2 py-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-ink text-[12px] font-semibold text-white">
              {user.name
                .split(" ")
                .map((p) => p[0])
                .join("")
                .slice(0, 2)}
            </span>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-[13px] font-medium">{user.name}</div>
              <div className="text-[11.5px] capitalize text-ink-3">Municipal {user.role}</div>
            </div>
            <button
              className="rounded-md p-1.5 text-ink-3 hover:bg-hover hover:text-ink"
              aria-label="Sign out"
              onClick={() => {
                logout();
                navigate("/");
              }}
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="8" fill="#17181b" />
      <path d="M10 11h12l-1.4 13.2a2 2 0 0 1-2 1.8h-5.2a2 2 0 0 1-2-1.8L10 11z" fill="none" stroke="#f7f6f2" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M8.5 8.5h15" stroke="#f7f6f2" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M13 20.5l2.2 2L19.5 17" fill="none" stroke="#7fd19e" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ModeSwitch() {
  const { data: cfg } = useConfig();
  const qc = useQueryClient();
  const mode = cfg?.simulation.mode ?? "simulation";
  return (
    <div className="mb-2">
      <div className="mb-1.5 px-1 text-[11px] font-medium text-ink-3">Data source</div>
      <Segmented
        size="sm"
        value={mode}
        onChange={async (m) => {
          await post("/sim/settings", { mode: m });
          qc.invalidateQueries({ queryKey: ["config"] });
        }}
        items={[
          { value: "simulation", label: "Simulation" },
          { value: "live", label: "Live hardware" },
        ]}
      />
    </div>
  );
}

function HealthMini() {
  const { data } = useHealth();
  const connected = useLive((s) => s.connected);
  if (!data) return null;
  return (
    <Link to="/app/settings" className="mt-1 grid grid-cols-2 gap-x-2 gap-y-1 rounded-md px-1.5 py-1.5 hover:bg-hover">
      {data.items.slice(0, 4).map((i) => (
        <span key={i.key} className="flex items-center gap-1.5 truncate text-[11.5px] text-ink-2" title={i.detail}>
          <Dot tone={i.status === "online" ? "success" : i.status === "degraded" ? "warning" : "danger"} />
          <span className="truncate">{i.key === "chain" ? "Blockchain" : i.label}</span>
        </span>
      ))}
      <span className="col-span-2 flex items-center gap-1.5 text-[11.5px] text-ink-3">
        <Dot tone={connected ? "success" : "danger"} pulse={connected} /> {connected ? "Live stream connected" : "Reconnecting…"}
      </span>
    </Link>
  );
}

function TopBar({ onDemo, onMenu }: { onDemo: () => void; onMenu: () => void }) {
  const { data: cfg } = useConfig();
  const { data: chain } = useChainStatus();
  const { data: notes } = useNotifications();
  const unread = notes?.filter((n) => !n.read).length ?? 0;
  const autopilot = useLive((s) => s.autopilot);
  return (
    <header className="flex h-[58px] shrink-0 items-center gap-3 border-b border-line bg-page/80 px-5 backdrop-blur sm:px-8">
      <button className="rounded-md p-2 text-ink-2 hover:bg-hover lg:hidden" onClick={onMenu} aria-label="Menu">
        <LayoutGrid className="h-4 w-4" />
      </button>
      <div className="flex min-w-0 items-center gap-2 text-[12.5px] text-ink-2">
        <span className={clsx("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1", cfg?.isLocal ? "border-warn-line bg-warn-bg text-warn" : "border-line bg-surface")}>
          <Dot tone={chain ? "success" : "warning"} pulse={!!chain} />
          <span className="font-medium">{cfg?.networkLabel ?? "…"}</span>
          {chain && <span className="hidden text-ink-3 sm:inline num">· block {chain.blockNumber.toLocaleString()}</span>}
        </span>
        {cfg?.isLocal && <span className="hidden text-ink-3 md:inline">Rehearsal chain, not MST</span>}
        {autopilot?.running && (
          <span className="hidden items-center gap-1.5 rounded-full border border-prog-line bg-prog-bg px-2.5 py-1 text-prog md:inline-flex">
            <Activity className="h-3.5 w-3.5" /> Autopilot · {autopilot.stage}
          </span>
        )}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <WalletButton />
        <Link to="/app/notifications" className="relative rounded-md p-2 text-ink-2 hover:bg-hover hover:text-ink" aria-label="Notifications">
          <Bell className="h-[18px] w-[18px]" />
          {unread > 0 && <span className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-bad-dot px-1 text-[10px] font-semibold text-white num">{unread}</span>}
        </Link>
        <Button variant="primary" size="sm" icon={<FlaskConical className="h-4 w-4" />} onClick={onDemo}>
          Demo
        </Button>
      </div>
    </header>
  );
}

export function WalletButton() {
  const { data: cfg } = useConfig();
  const w = useWallet();
  const signing = useSigning();
  const [open, setOpen] = useState(false);
  if (!w.address) {
    return (
      <div className="relative">
        <Button variant="secondary" size="sm" loading={w.connecting} icon={<Wallet className="h-4 w-4" />} onClick={() => cfg && w.connect(cfg)}>
          Connect BridgeKey
        </Button>
        {w.error && (
          <div className="absolute right-0 top-10 z-50 w-72 rounded-md border border-line bg-surface p-3 text-[12.5px] text-ink-2 shadow-float">
            {w.error}
            <a className="mt-1 block text-prog underline" href="https://chromewebstore.google.com/detail/bridgekey/bfjojdcfenehemjgjlepdjomkpginlkg" target="_blank" rel="noreferrer">
              Get BridgeKey
            </a>
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex h-8 items-center gap-2 rounded-md border border-line bg-surface px-2.5 text-[12.5px] shadow-panel hover:bg-raised">
        <Dot tone={w.officer ? "success" : "warning"} />
        <span className="font-mono">{shortHash(w.address)}</span>
        {w.balanceMstc && <span className="hidden text-ink-3 sm:inline num">{Number(w.balanceMstc).toFixed(3)} MSTC</span>}
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-50 w-80 rounded-lg border border-line bg-surface p-4 text-[13px] shadow-float">
          <div className="text-[12px] text-ink-3">{w.name}</div>
          <div className="mt-0.5 break-all font-mono text-[12.5px]">{w.address}</div>
          <div className="mt-3 flex items-center gap-2">
            <Dot tone={w.officer ? "success" : "warning"} />
            {w.officer ? "Holds the OFFICER role on the ledger" : "No officer role yet (grant it in Settings)"}
          </div>
          <div className="mt-3 border-t border-line-2 pt-3">
            <div className="mb-1.5 text-[12px] text-ink-3">Sign officer actions with</div>
            <Segmented
              size="sm"
              value={signing.mode}
              onChange={signing.setMode}
              items={[
                { value: "server", label: "Municipal wallet" },
                { value: "wallet", label: "BridgeKey" },
              ]}
            />
            {signing.mode === "wallet" && !w.officer && <div className="mt-2 text-[12px] text-warn">BridgeKey signing needs the officer role.</div>}
          </div>
          <div className="mt-3 flex justify-between">
            <Button variant="ghost" size="sm" onClick={() => w.refresh()}>
              Refresh
            </Button>
            <Button variant="ghost" size="sm" onClick={() => w.disconnect()}>
              Disconnect
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Toaster() {
  const toasts = useLive((s) => s.toasts);
  const dismiss = useLive((s) => s.dismiss);
  const navigate = useNavigate();
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[1400] flex w-[360px] max-w-[calc(100vw-40px)] flex-col gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 24 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-auto relative overflow-hidden rounded-lg border border-line bg-surface py-3 pl-4 pr-9 shadow-float"
          >
            <span className={clsx("absolute inset-y-0 left-0 w-[3px]", t.tone === "success" ? "bg-good-dot" : t.tone === "danger" ? "bg-bad-dot" : t.tone === "warning" ? "bg-warn-dot" : "bg-prog-dot")} />
            <button
              className="block w-full text-left"
              onClick={() => {
                if (!t.href) return;
                if (t.href.startsWith("http")) window.open(t.href, "_blank");
                else navigate(t.href);
              }}
            >
              <div className="text-[13.5px] font-medium text-ink">{t.title}</div>
              {t.body && <div className="mt-0.5 text-[12.5px] text-ink-2">{t.body}</div>}
            </button>
            <button className="absolute right-2 top-2 rounded p-1 text-ink-4 hover:bg-hover hover:text-ink-2" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              <X className="h-3.5 w-3.5" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
