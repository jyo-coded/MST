import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { LifecycleEvent, Notification, SessionUser, SimSnapshot } from "./types";

type Session = {
  token: string | null;
  user: SessionUser | null;
  login: (token: string, user: SessionUser) => void;
  logout: () => void;
};

export const useSession = create<Session>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      login: (token, user) => set({ token, user }),
      logout: () => set({ token: null, user: null }),
    }),
    { name: "astra.session" },
  ),
);

export type LiveTelemetry = { fill: number; fill2: number | null; lid: string; servo: string; ir: string; irCount: number; ts: string; source: string };
export type Toast = { id: number; tone: "info" | "success" | "warning" | "danger"; title: string; body?: string; href?: string };
export type TxProgress = { stage: string; method: string; action: string; requestId: number | null; reason?: string; at: number };

type Live = {
  connected: boolean;
  telemetry: Record<string, LiveTelemetry>;
  workers: Record<string, { lat: number; lng: number; source: string }>;
  feed: LifecycleEvent[];
  toasts: Toast[];
  txProgress: TxProgress | null;
  autopilot: SimSnapshot["autopilot"];
  lastNotification: Notification | null;
  /** While an officer action runs here (and briefly after), its own toast speaks for it. */
  quietUntil: number;
  set: (patch: Partial<Live>) => void;
  pushFeed: (e: LifecycleEvent) => void;
  toast: (t: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
};

let toastId = 1;
export const useLive = create<Live>((set) => ({
  connected: false,
  telemetry: {},
  workers: {},
  feed: [],
  toasts: [],
  txProgress: null,
  autopilot: null,
  lastNotification: null,
  quietUntil: 0,
  set: (patch) => set(patch),
  pushFeed: (e) => set((s) => (s.feed.some((x) => x.id === e.id) ? s : { feed: [e, ...s.feed].slice(0, 120) })),
  toast: (t) => {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), 5200);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}));

/** Officer actions are signed by the municipal server wallet or the officer's BridgeKey. */
type Signing = { mode: "server" | "wallet"; setMode: (m: "server" | "wallet") => void };
export const useSigning = create<Signing>()(
  persist((set) => ({ mode: "server", setMode: (mode) => set({ mode }) }), { name: "astra.signing" }),
);
