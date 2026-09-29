import clsx from "clsx";
import { Check, Copy, Cpu, KeyRound, Radio, Wallet } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TxDrawer } from "../components/Chain";
import { Button, Dot, Hash, PageHeader, Panel, Pill, Segmented, Skeleton } from "../components/ui";
import { SystemHealth } from "../components/Widgets";
import { api, post } from "../lib/api";
import { ago, dateTime, shortHash } from "../lib/format";
import { useConfig, useSim } from "../lib/queries";
import { useLive, useSession, useSigning } from "../lib/store";
import type { Tx } from "../lib/types";
import { useWallet } from "../lib/wallet";

type Device = { binId: string; name: string; online: boolean; lastHeartbeat: string | null; source: string; deviceAddress: string; lastSeq: number };
type Provisioning = { binId: string; name: string; depthCm: number; deviceSecret: string; deviceAddress: string; endpoint: string; rfidEndpoint: string; port: number; network: string };

export function Settings() {
  const { data: cfg } = useConfig();
  const [tx, setTx] = useState<string | null>(null);
  return (
    <>
      <PageHeader title="Settings" subtitle="Where the data comes from, which chain it settles on, who signs, and how the hardware connects." />
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="min-w-0 space-y-6">
          <DataSource />
          <Chain />
          <BridgeKey onTx={setTx} />
        </div>
        <div className="min-w-0 space-y-6">
          <Panel title="System health" subtitle="Refreshes every 10 seconds">
            <SystemHealth />
          </Panel>
          <Ai />
          <Policy />
          <Hardware />
          <Panel title="Storage">
            <Row label="Database">{cfg?.database === "pglite" ? "PostgreSQL (embedded PGlite, zero-install)" : "PostgreSQL"}</Row>
            <Row label="Municipality">
              {cfg?.municipality.name} · {cfg?.municipality.city} · {cfg?.municipality.ward}
            </Row>
          </Panel>
        </div>
      </div>
      <TxDrawer hash={tx} onClose={() => setTx(null)} />
    </>
  );
}

function DataSource() {
  const { data: cfg } = useConfig();
  const { data: sim } = useSim();
  const qc = useQueryClient();
  const set = async (patch: object) => {
    await post("/sim/settings", patch);
    qc.invalidateQueries({ queryKey: ["config"] });
    qc.invalidateQueries({ queryKey: ["sim"] });
    qc.invalidateQueries({ queryKey: ["health"] });
  };
  const mode = cfg?.simulation.mode ?? "simulation";
  return (
    <Panel title="Data source" subtitle="Switch between the simulated city and real sensors" actions={<Radio className="h-4 w-4 text-ink-3" />}>
      <Segmented
        value={mode}
        onChange={(m) => set({ mode: m })}
        items={[
          { value: "simulation", label: "Simulation" },
          { value: "live", label: "Live hardware" },
        ]}
      />
      <p className="mt-3 text-[13px] text-ink-2">
        {mode === "live"
          ? "Bins marked as hardware read their ESP32; every packet must carry a valid HMAC signature and a fresh sequence number. The rest of the city stays simulated so the map is never empty."
          : "Every bin and worker is simulated with realistic sensor noise. Detection, AI verification, the workflow and every blockchain transaction are real."}
      </p>
      <div className="mt-4 space-y-3 border-t border-line-2 pt-4">
        <Toggle
          label="Simulated workers act on their own"
          hint="They head to the bin, tap their card and empty it without a click."
          checked={sim?.settings.workerAutopilot ?? true}
          onChange={(v) => set({ workerAutopilot: v })}
        />
        <Toggle
          label="Bins fill up on their own"
          hint="Organic detections across the city. Off keeps the demo under your control."
          checked={sim?.settings.organic ?? false}
          onChange={(v) => set({ organic: v })}
        />
      </div>
    </Panel>
  );
}

function Chain() {
  const { data: cfg } = useConfig();
  if (!cfg) return <Skeleton className="h-64 w-full" />;
  return (
    <Panel
      title="Blockchain"
      subtitle="Where requests, decisions and payments are recorded"
      actions={cfg.isLocal ? <Pill tone="warning">Rehearsal chain</Pill> : <Pill tone="success">MST</Pill>}
    >
      <div className="space-y-2.5">
        <Row label="Network">{cfg.networkLabel}</Row>
        <Row label="Chain ID">
          <span className="num">
            {cfg.chainId} <span className="text-ink-3">({cfg.chainIdHex})</span>
          </span>
        </Row>
        <Row label="RPC">
          <span className="break-all font-mono text-[12.5px]">{cfg.rpcUrl}</span>
        </Row>
        <Row label="Explorer">
          {cfg.explorerUrl ? (
            <a href={cfg.explorerUrl} target="_blank" rel="noreferrer" className="underline decoration-line underline-offset-2">
              {cfg.explorerUrl}
            </a>
          ) : (
            <span className="text-ink-3">none on a local chain</span>
          )}
        </Row>
        <Row label="Ledger contract">{cfg.contract ? <Hash value={cfg.contract.address} url={cfg.contract.url} chars={[10, 6]} /> : <span className="text-bad">not deployed</span>}</Row>
        {cfg.contract?.deployTx && (
          <Row label="Deployed in">
            <Hash value={cfg.contract.deployTx} url={cfg.explorerUrl ? `${cfg.explorerUrl}/tx/${cfg.contract.deployTx}` : null} />
            {cfg.contract.deployedAt && <span className="ml-2 text-[12px] text-ink-3">{dateTime(cfg.contract.deployedAt)}</span>}
          </Row>
        )}
        <Row label="Server wallets">
          <span className="flex flex-col gap-1 text-[12.5px]">
            <span>
              Officer <span className="font-mono">{shortHash(cfg.wallets?.officer)}</span> · Gateway <span className="font-mono">{shortHash(cfg.wallets?.gateway)}</span>
            </span>
            <span>
              Admin <span className="font-mono">{shortHash(cfg.wallets?.admin)}</span> · AI verifier <span className="font-mono">{shortHash(cfg.wallets?.verifier)}</span>
            </span>
          </span>
        </Row>
      </div>
      {cfg.isLocal && (
        <div className="mt-4 rounded-md border border-warn-line bg-warn-bg px-3.5 py-3 text-[12.5px] text-ink-2">
          <div className="font-medium text-warn">Running on a local EVM node</div>
          To settle on MST Testnet, set <code className="font-mono">NETWORK=testnet</code>, run <code className="font-mono">npm run keys</code>, fund the printed addresses from the MST faucet, then{" "}
          <code className="font-mono">npm run deploy && npm run setup</code>. The same code then sends to chain 91562037.
        </div>
      )}
    </Panel>
  );
}

function BridgeKey({ onTx }: { onTx: (hash: string) => void }) {
  const { data: cfg } = useConfig();
  const w = useWallet();
  const signing = useSigning();
  const user = useSession((s) => s.user);
  const toast = useLive((s) => s.toast);
  const [granting, setGranting] = useState(false);

  const grant = async () => {
    if (!w.address) return;
    setGranting(true);
    try {
      const t = await post<Tx>("/chain/grant-officer", { address: w.address });
      toast({ tone: t.status === "CONFIRMED" ? "success" : "info", title: t.status === "CONFIRMED" ? "Officer role granted on-chain" : "Role grant submitted", body: `tx ${t.hash.slice(0, 10)}…`, href: t.url ?? undefined });
      onTx(t.hash);
      await w.refresh();
    } catch (err) {
      toast({ tone: "danger", title: "Role grant failed", body: (err as Error).message });
    } finally {
      setGranting(false);
    }
  };

  return (
    <Panel title="BridgeKey wallet" subtitle="Sign municipal decisions yourself instead of the server wallet" actions={<Wallet className="h-4 w-4 text-ink-3" />}>
      {!w.address ? (
        <>
          <p className="text-[13px] text-ink-2">
            Connect BridgeKey, MST's browser wallet. Once your address holds the ledger's OFFICER role, approvals, assignments and payment releases are signed in your wallet and the server only observes the
            transaction.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button variant="primary" loading={w.connecting} icon={<Wallet className="h-4 w-4" />} onClick={() => cfg && w.connect(cfg)}>
              Connect BridgeKey
            </Button>
            <a className="text-[13px] font-medium text-ink-2 underline decoration-line underline-offset-4 hover:text-ink" href="https://chromewebstore.google.com/detail/bridgekey/bfjojdcfenehemjgjlepdjomkpginlkg" target="_blank" rel="noreferrer">
              Get the extension
            </a>
          </div>
          {w.error && <div className="mt-3 rounded-md border border-bad-line bg-bad-bg px-3 py-2 text-[12.5px] text-bad">{w.error}</div>}
        </>
      ) : (
        <>
          <div className="space-y-2.5">
            <Row label="Wallet">{w.name}</Row>
            <Row label="Address">
              <Hash value={w.address} url={cfg?.explorerUrl ? `${cfg.explorerUrl}/address/${w.address}` : null} chars={[10, 6]} />
            </Row>
            <Row label="Balance">
              <span className="num">{w.balanceMstc ? `${Number(w.balanceMstc).toFixed(4)} MSTC` : "–"}</span>
            </Row>
            <Row label="Ledger role">
              {w.officer ? (
                <span className="inline-flex items-center gap-1.5 text-good">
                  <Check className="h-4 w-4" /> OFFICER
                </span>
              ) : (
                <span className="text-warn">No officer role</span>
              )}
            </Row>
          </div>
          {!w.officer && (
            <div className="mt-4 rounded-md bg-sunken px-3.5 py-3 text-[12.5px] text-ink-2">
              {cfg?.allowRoleGrants ? (
                <>
                  The admin wallet can grant this address the OFFICER role with a real grantRole transaction.
                  <div className="mt-2">
                    <Button size="sm" variant="secondary" loading={granting} icon={<KeyRound className="h-3.5 w-3.5" />} onClick={grant} disabled={user?.role !== "admin" && user?.role !== "officer"}>
                      Grant officer role
                    </Button>
                  </div>
                </>
              ) : (
                <>Role grants from the dashboard are disabled. Add this address to EXTRA_OFFICERS and run npm run setup.</>
              )}
            </div>
          )}
          <div className="mt-4 border-t border-line-2 pt-4">
            <div className="mb-2 text-[12.5px] font-medium text-ink-2">Sign officer actions with</div>
            <Segmented
              value={signing.mode}
              onChange={signing.setMode}
              items={[
                { value: "server", label: "Municipal server wallet" },
                { value: "wallet", label: "My BridgeKey" },
              ]}
            />
            {signing.mode === "wallet" && !w.officer && <div className="mt-2 text-[12.5px] text-warn">Until the role is granted, actions fall back to the server wallet.</div>}
          </div>
        </>
      )}
    </Panel>
  );
}

function Ai() {
  const { data: cfg } = useConfig();
  return (
    <Panel title="AI verification" subtitle="Sensor fusion decides; an optional model can only make it stricter" actions={<Cpu className="h-4 w-4 text-ink-3" />}>
      <div className="space-y-2.5">
        <Row label="Provider">{cfg?.ai.provider === "qwen" ? "Qwen (OpenAI-compatible endpoint)" : cfg?.ai.provider === "http" ? "External AI service (HTTP)" : "Built-in sensor fusion"}</Row>
        <Row label="Model">
          <span className="font-mono text-[12.5px]">{cfg?.ai.model}</span>
        </Row>
        <Row label="Minimum confidence">
          <span className="num">{cfg?.ai.minConfidence}%</span>
        </Row>
      </div>
      <p className="mt-4 text-[12.5px] text-ink-3">
        Set AI_PROVIDER=qwen with QWEN_BASE_URL and QWEN_MODEL to add your Qwen model as a second opinion, or AI_PROVIDER=http to call the Python service in /ai-service.
      </p>
    </Panel>
  );
}

function Policy() {
  const { data: cfg } = useConfig();
  const p = cfg?.policy;
  return (
    <Panel title="On-chain policy" subtitle="Rules the ledger enforces, whatever the dashboard says">
      {!p ? (
        <div className="text-[13px] text-ink-3">Chain unreachable.</div>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <PolicyItem label="Minimum fill to request" value={`${p.minFillPct}%`} />
          <PolicyItem label="Minimum removed to approve" value={`${p.minFillRemoved} pts`} />
          <PolicyItem label="Minimum AI confidence" value={`${p.minConfidence}%`} />
          <PolicyItem label="Maximum payout per job" value={`${p.maxPayoutMstc} MSTC`} />
        </div>
      )}
    </Panel>
  );
}

function Hardware() {
  const { data: devices } = useQuery({ queryKey: ["iot-devices"], queryFn: () => api<Device[]>("/iot/devices"), refetchInterval: 10_000 });
  const [prov, setProv] = useState<Provisioning | null>(null);
  const [copied, setCopied] = useState(false);
  const snippet = prov
    ? `// firmware/smart_bin/secrets.h — ${prov.name}
#pragma once
#define WIFI_SSID      "your-wifi"
#define WIFI_PASSWORD  "your-password"
#define SERVER_URL     "http://<this-laptop-lan-ip>:${prov.port}"
#define BIN_ID         "${prov.binId}"
#define DEVICE_SECRET  "${prov.deviceSecret}"
#define BIN_DEPTH_CM   ${prov.depthCm}`
    : "";

  return (
    <Panel title="Hardware" subtitle="ESP32 smart bins" actions={<Radio className="h-4 w-4 text-ink-3" />}>
      {!devices ? (
        <Skeleton className="h-16 w-full" />
      ) : devices.length === 0 ? (
        <div className="text-[13px] text-ink-3">No bin is marked as hardware. Set "hardware": true on a bin in config/city.json.</div>
      ) : (
        <ul className="space-y-2">
          {devices.map((d) => {
            const fresh = d.online && d.source === "hardware" && d.lastHeartbeat && Date.now() - new Date(d.lastHeartbeat).getTime() < 30_000;
            return (
              <li key={d.binId} className="flex flex-wrap items-center gap-3 rounded-md border border-line-2 px-3.5 py-3">
                <Dot tone={fresh ? "success" : "neutral"} pulse={!!fresh} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium">
                    {d.binId} · {d.name}
                  </div>
                  <div className="text-[12px] text-ink-3">
                    {fresh ? `ESP32 reporting · packet #${d.lastSeq} · ${ago(d.lastHeartbeat)}` : d.source === "hardware" ? `Last ESP32 packet ${ago(d.lastHeartbeat)}` : "Waiting for the ESP32 (switch to Live hardware)"}
                  </div>
                </div>
                <Button size="sm" variant="secondary" icon={<KeyRound className="h-3.5 w-3.5" />} onClick={async () => setProv(await api<Provisioning>(`/iot/devices/${d.binId}/provisioning`))}>
                  Provision
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {prov && (
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[12.5px] font-medium text-ink-2">secrets.h for {prov.binId}</span>
            <button
              className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-[12px] text-ink-3 hover:bg-hover hover:text-ink"
              onClick={() => {
                navigator.clipboard?.writeText(snippet);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} Copy
            </button>
          </div>
          <pre className="overflow-x-auto rounded-md border border-line-2 bg-raised p-3 font-mono text-[11.5px] leading-relaxed text-ink-2 scroll-thin">{snippet}</pre>
          <p className="mt-2 text-[12px] text-ink-3">
            The device secret authenticates every packet (HMAC-SHA256). Treat it like a password. Flash firmware/smart_bin with the Arduino IDE; the dashboard shows the bin as reporting within seconds.
          </p>
        </div>
      )}
    </Panel>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="block text-[13.5px] font-medium text-ink">{label}</span>
        <span className="block text-[12.5px] text-ink-3">{hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={clsx("relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors", checked ? "bg-ink" : "bg-line")}
      >
        <span className={clsx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-[left]", checked ? "left-[18px]" : "left-0.5")} />
      </button>
    </label>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] gap-3 text-[13px]">
      <span className="text-ink-3">{label}</span>
      <span className="min-w-0 text-ink">{children}</span>
    </div>
  );
}

function PolicyItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-raised px-3 py-2.5">
      <div className="text-[11.5px] text-ink-3">{label}</div>
      <div className="mt-0.5 text-[16px] font-semibold tracking-[-0.01em] num">{value}</div>
    </div>
  );
}
