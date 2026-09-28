import clsx from "clsx";
import { Ban, CircleOff, Fingerprint, MapPin, Play, Radio, ScanLine, ShieldAlert, Sparkles, Trash } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { post } from "../lib/api";
import { useBins, useConfig, useRequests, useSim } from "../lib/queries";
import { useLive } from "../lib/store";
import { Button, Drawer, Pill, Segmented } from "./ui";

/**
 * The demo director. Everything here pokes the SIMULATED physical world
 * (sensors, workers, cards). What happens next goes through the same
 * ingest → AI → workflow → MST path as real hardware.
 */
export function DemoDirector({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: cfg } = useConfig();
  const { data: sim } = useSim();
  const { data: bins } = useBins();
  const { data: requests } = useRequests();
  const autopilot = useLive((s) => s.autopilot) ?? sim?.autopilot ?? null;
  const toast = useLive((s) => s.toast);
  const [binId, setBinId] = useState("BIN-001");
  const [autoApprove, setAutoApprove] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const live = cfg?.simulation.mode === "live";
  const bin = bins?.find((b) => b.id === binId);
  const job = requests?.find((r) => r.binId === binId && ["APPROVED", "ASSIGNED", "EN_ROUTE", "COLLECTING", "REVERIFYING", "AWAITING_APPROVAL", "AWAITING_FINAL_APPROVAL", "INVESTIGATION"].includes(r.status));
  const hardwareLive = live && bin?.hardware;

  const run = async (label: string, path: string, body: object) => {
    setBusy(label);
    try {
      await post(path, body);
      toast({ tone: "info", title: label, body: "Watch the map, the timeline and the event feed." });
      qc.invalidateQueries({ queryKey: ["sim"] });
    } catch (err) {
      toast({ tone: "danger", title: `${label} failed`, body: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title="Demo director" subtitle="Drive the physical world. Everything downstream is real." width={460}>
      <div className="space-y-6 px-6 py-5">
        <section>
          <Label>Data source</Label>
          <Segmented
            value={cfg?.simulation.mode ?? "simulation"}
            onChange={async (m) => {
              await post("/sim/settings", { mode: m });
              qc.invalidateQueries({ queryKey: ["config"] });
            }}
            items={[
              { value: "simulation", label: "Simulation" },
              { value: "live", label: "Live hardware" },
            ]}
          />
          <p className="mt-2 text-[12.5px] text-ink-3">
            {live
              ? "Hardware bins report from their ESP32. The rest of the city stays simulated."
              : "Every bin and worker is simulated. Detections, AI checks and payments are real."}
          </p>
        </section>

        <section>
          <Label>Bin</Label>
          <select value={binId} onChange={(e) => setBinId(e.target.value)} className="h-10 w-full rounded-md border border-line bg-surface px-3 text-[14px]">
            {bins?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.id} · {b.name} {b.hardware ? "(hardware)" : ""} · {Math.round(b.fillPct)}%
              </option>
            ))}
          </select>
          {job && (
            <div className="mt-2 flex items-center gap-2 text-[12.5px] text-ink-2">
              Current job <span className="font-mono">{job.code}</span> <Pill tone={job.tone}>{job.statusLabel}</Pill>
            </div>
          )}
        </section>

        <section className="rounded-lg border border-line bg-raised p-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-md bg-ink text-white">
              <Sparkles className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-semibold">Run the full storyline</div>
              <p className="mt-0.5 text-[12.5px] text-ink-2">Bin fills → AI verifies → request on MST → approval → nearest worker → RFID → collection → AI re-verifies → approval → MST payment.</p>
              <label className="mt-3 flex items-center gap-2 text-[13px] text-ink-2">
                <input type="checkbox" checked={autoApprove} onChange={(e) => setAutoApprove(e.target.checked)} className="h-4 w-4 accent-[#17181b]" />
                Autopilot also acts as the municipal officer
              </label>
              <Button
                className="mt-3 w-full"
                variant="primary"
                loading={busy === "Full storyline"}
                disabled={autopilot?.running || !!job || hardwareLive}
                icon={<Play className="h-4 w-4" />}
                onClick={() => run("Full storyline", "/sim/autopilot", { binId, autoApprove })}
              >
                Simulate full bin · end to end
              </Button>
              {!autoApprove && <p className="mt-2 text-[12px] text-ink-3">You approve, assign, approve completion and release payment yourself.</p>}
            </div>
          </div>
          {autopilot && (
            <div className="mt-4 border-t border-line-2 pt-3 text-[12.5px]">
              <div className="flex items-center justify-between">
                <span className="text-ink-3">Autopilot · {autopilot.binId}</span>
                <Pill tone={autopilot.error ? "danger" : autopilot.running ? "progress" : "success"} pulse={autopilot.running}>
                  {autopilot.running ? "running" : autopilot.error ? "stopped" : "finished"}
                </Pill>
              </div>
              <div className="mt-1.5 font-medium text-ink">{autopilot.stage}</div>
            </div>
          )}
        </section>

        <section>
          <Label>Step by step</Label>
          <div className="grid grid-cols-2 gap-2">
            <Tile icon={<Radio className="h-4 w-4" />} label="Bin fills up" hint="IoT detects fullness" disabled={hardwareLive || !!job} onClick={() => run("Bin filling", "/sim/full-bin", { binId })} />
            <Tile icon={<MapPin className="h-4 w-4" />} label="Worker arrives now" hint="Skip the travel" disabled={!job?.workerId} onClick={() => run("Worker arriving", "/sim/arrive", { requestId: job?.id })} />
            <Tile icon={<Fingerprint className="h-4 w-4" />} label="Tap assigned card" hint="RFID at the bin" disabled={!job?.workerId || hardwareLive} onClick={() => run("RFID tapped", "/sim/tap", { requestId: job?.id, card: "assigned" })} />
            <Tile icon={<ScanLine className="h-4 w-4" />} label="Empty the bin" hint="After the lid unlocks" disabled={hardwareLive} onClick={() => run("Collection", "/sim/collect", { binId, outcome: "full" })} />
          </div>
        </section>

        <section>
          <Label>Fraud and failure scenarios</Label>
          <div className="grid grid-cols-2 gap-2">
            <Tile tone="danger" icon={<ShieldAlert className="h-4 w-4" />} label="Fake full reading" hint="Something blocks the sensor" disabled={hardwareLive || !!job} onClick={() => run("Sensor obstruction", "/sim/obstruction", { binId })} />
            <Tile tone="danger" icon={<Ban className="h-4 w-4" />} label="Wrong worker taps" hint="Unassigned RFID card" disabled={!job?.workerId || hardwareLive} onClick={() => run("Wrong card", job?.status === "EN_ROUTE" || job?.status === "ASSIGNED" ? "/sim/queue-card" : "/sim/tap", { binId, requestId: job?.id, card: "wrong" })} />
            <Tile tone="danger" icon={<Trash className="h-4 w-4" />} label="Partial collection" hint="Worker leaves waste" disabled={hardwareLive} onClick={() => run("Partial collection", "/sim/collect", { binId, outcome: "partial" })} />
            <Tile
              tone="danger"
              icon={<CircleOff className="h-4 w-4" />}
              label={sim?.bins.find((b) => b.id === binId)?.offline ? "Bring bin online" : "Bin goes offline"}
              hint="Heartbeat stops"
              disabled={hardwareLive}
              onClick={() => run("Connectivity", "/sim/offline", { binId, offline: !sim?.bins.find((b) => b.id === binId)?.offline })}
            />
          </div>
          <p className="mt-2 text-[12px] text-ink-3">Queue "Partial collection" or "Wrong worker" before the worker arrives for the cleanest story.</p>
        </section>

        <section>
          <Label>Worker behaviour</Label>
          <label className="flex items-center gap-2 text-[13px] text-ink-2">
            <input
              type="checkbox"
              checked={sim?.settings.workerAutopilot ?? true}
              onChange={async (e) => {
                await post("/sim/settings", { workerAutopilot: e.target.checked });
                qc.invalidateQueries({ queryKey: ["sim"] });
              }}
              className="h-4 w-4 accent-[#17181b]"
            />
            Simulated workers tap and collect on their own
          </label>
        </section>
      </div>
    </Drawer>
  );
}

function Label({ children }: { children: ReactNode }) {
  return <div className="mb-2 text-[12px] font-medium text-ink-3">{children}</div>;
}

function Tile({ icon, label, hint, onClick, disabled, tone }: { icon: ReactNode; label: string; hint: string; onClick: () => void; disabled?: boolean; tone?: "danger" }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={clsx(
        "flex flex-col items-start gap-1 rounded-lg border bg-surface p-3 text-left shadow-panel transition hover:-translate-y-px hover:shadow-float disabled:translate-y-0 disabled:opacity-45 disabled:shadow-none",
        tone === "danger" ? "border-bad-line" : "border-line",
      )}
    >
      <span className={clsx("flex h-7 w-7 items-center justify-center rounded-md", tone === "danger" ? "bg-bad-bg text-bad" : "bg-sunken text-ink-2")}>{icon}</span>
      <span className="text-[13px] font-medium text-ink">{label}</span>
      <span className="text-[11.5px] text-ink-3">{hint}</span>
    </button>
  );
}
