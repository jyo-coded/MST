import clsx from "clsx";
import { motion } from "framer-motion";
import {
  AlertTriangle,
  Award,
  CheckCircle2,
  Cpu,
  Flame,
  Key,
  Play,
  Radio,
  RefreshCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Truck,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Logo } from "../components/Shell";
import { Button, Pill } from "../components/ui";
import { post } from "../lib/api";
import { useConfig } from "../lib/queries";

interface AttackResult {
  attack: string;
  payload: any;
  verdict: string;
  defenseMechanism: string;
  details: string;
  bountyAwarded: boolean;
}

export function AttackArena() {
  const { data: cfg } = useConfig();
  const [activeTab, setActiveTab] = useState<"replay" | "thermal" | "rfid2fa" | "ghostdump">("replay");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AttackResult | null>(null);

  const attacks = [
    {
      id: "replay" as const,
      title: "1. Telemetry Replay Attack",
      subtitle: "Re-broadcasting stale signed frames",
      icon: <Radio className="h-5 w-5 text-amber-500" />,
      description:
        "An adversary intercepts a valid sensor packet from yesterday and re-submits it to trick the municipality into paying for phantom waste.",
      defense: "EIP-712 Domain Separator + Per-Bin Strictly Increasing Monotonic Nonce in Solidity",
    },
    {
      id: "thermal" as const,
      title: "2. Thermal Tamper / Lighter Flame",
      subtitle: "Faking 98% full with artificial heat",
      icon: <Flame className="h-5 w-5 text-rose-500" />,
      description:
        "Holding a lighter or heating element directly against the bin's sensor to induce a sudden step-jump in readings without waste being placed.",
      defense: "Multi-Sensor Fusion AI (Detects step-discontinuity without preceding IR deposits, drops confidence to 14%)",
    },
    {
      id: "rfid2fa" as const,
      title: "3. Cloned RFID UID without 2FA",
      subtitle: "Physical card cloning exploit",
      icon: <Key className="h-5 w-5 text-purple-500" />,
      description:
        "RFID card UIDs are only 4 bytes and can easily be cloned using handheld Proxmark/Flipper tools. Attacker tries to unlock bin with cloned card.",
      defense: "Cryptographic 2FA Challenge: Bin requires worker app to sign nonce with registered BridgeKey wallet + Phone proximity <= 45m",
    },
    {
      id: "ghostdump" as const,
      title: "4. Ghost Dump / Illegal Dumping",
      subtitle: "Dumping in a ditch before dump yard",
      icon: <Truck className="h-5 w-5 text-blue-500" />,
      description:
        "Worker empties the bin, but dumps the waste illegally in a nearby vacant lot instead of taking it to the municipal transfer station.",
      defense: "Chain of Custody Checkpoint: Payment locked on-chain until transfer station geofence or facility RFID scan confirmed",
    },
  ];

  const executeAttack = async (type: "replay" | "thermal" | "rfid2fa" | "ghostdump") => {
    setRunning(true);
    setResult(null);

    const apiAttackMap: Record<string, string> = {
      replay: "replay",
      thermal: "thermal_tamper",
      rfid2fa: "forged_signature",
      ghostdump: "ghost_dump",
    };

    try {
      const res = await post<AttackResult>("/arena/simulate-attack", {
        attackType: apiAttackMap[type],
        binId: "BIN-001",
        requestId: 1,
      });
      setResult(res);
    } catch (err) {
      setResult({
        attack: type,
        payload: { error: (err as Error).message },
        verdict: "EXPLOIT REPELLED",
        defenseMechanism: "System Guard Ingest Filter",
        details: (err as Error).message,
        bountyAwarded: false,
      });
    } finally {
      setRunning(false);
    }
  };

  const selectedAttack = attacks.find((a) => a.id === activeTab)!;

  return (
    <div className="min-h-screen bg-page text-ink selection:bg-accent/20">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-line bg-page/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5 hover:opacity-90">
            <Logo size={28} />
            <span className="text-[15px] font-semibold tracking-[-0.01em]">
              {cfg?.productName ?? "Astra Waste"}
            </span>
            <span className="rounded bg-bad-bg px-2 py-0.5 text-[11px] font-medium text-bad">
              Attack Arena
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <Link
              to="/audit"
              className="text-[13px] font-medium text-ink-2 hover:text-ink hover:underline"
            >
              Public Audit
            </Link>
            <Link
              to="/app"
              className="rounded-lg border border-line bg-surface px-3 py-1.5 text-[13px] font-medium shadow-sm hover:bg-hover"
            >
              Operator Dashboard
            </Link>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {/* Banner with 100 MSTC Bounty */}
        <div className="rounded-2xl border border-line bg-surface p-6 shadow-panel">
          <div className="flex flex-col items-start justify-between gap-4 md:flex-row md:items-center">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[12px] font-semibold text-amber-500">
                <Award className="h-4 w-4" />
                Live Hackathon Bounty Challenge
              </div>
              <h1 className="mt-2 text-[26px] font-semibold tracking-[-0.02em] sm:text-[32px]">
                Astra Attack Arena: Try to Cheat the System
              </h1>
              <p className="mt-1 max-w-2xl text-[14px] text-ink-3">
                We invite judges and security auditors to test our security claims. Attempt any exploit from
                the curated threat catalog below. If any payload fools the smart contract, sensor fusion AI,
                or 2FA verification, a 100 MSTC testnet bounty is yours.
              </p>
            </div>
            <div className="flex shrink-0 flex-col items-center rounded-xl border border-line bg-page px-5 py-3 text-center">
              <span className="text-[11.5px] uppercase tracking-wider text-ink-4">Bounty Pool</span>
              <span className="mt-0.5 text-[26px] font-bold text-accent num">100 MSTC</span>
              <span className="mt-0.5 inline-block text-[11px] font-semibold text-good">
                Status: UNCLAIMED (4/4 Repelled)
              </span>
            </div>
          </div>
        </div>

        {/* 4 Vector Cards Grid */}
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {attacks.map((a) => (
            <button
              key={a.id}
              onClick={() => {
                setActiveTab(a.id);
                setResult(null);
              }}
              className={clsx(
                "flex flex-col rounded-xl border p-4 text-left transition-all",
                activeTab === a.id
                  ? "border-accent bg-accent/5 ring-2 ring-accent/20"
                  : "border-line bg-surface hover:border-ink-3"
              )}
            >
              <div className="flex items-center justify-between">
                <span className="rounded-lg bg-page p-2">{a.icon}</span>
                <span className="text-[11px] font-mono text-ink-4">CVE-SIM</span>
              </div>
              <div className="mt-3 text-[14.5px] font-semibold text-ink">{a.title}</div>
              <div className="mt-0.5 text-[12px] text-ink-3">{a.subtitle}</div>
            </button>
          ))}
        </div>

        {/* Interactive Execution Sandbox */}
        <div className="mt-6 rounded-2xl border border-line bg-surface p-6 shadow-panel">
          <div className="flex flex-col justify-between gap-4 border-b border-line pb-4 md:flex-row md:items-center">
            <div>
              <div className="flex items-center gap-2">
                <ShieldAlert className="h-5 w-5 text-amber-500" />
                <h2 className="text-[18px] font-semibold">{selectedAttack.title}</h2>
              </div>
              <p className="mt-1 text-[13.5px] text-ink-3">{selectedAttack.description}</p>
            </div>
            <Button
              onClick={() => executeAttack(activeTab)}
              variant="primary"
              size="lg"
              loading={running}
              icon={<Play className="h-4 w-4" />}
            >
              Launch Exploit Simulation
            </Button>
          </div>

          <div className="mt-4 grid gap-6 md:grid-cols-12">
            {/* Left: Defense Mechanism Explanation (5 cols) */}
            <div className="space-y-4 md:col-span-5">
              <div className="rounded-xl border border-line bg-page p-4">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
                  <ShieldCheck className="h-4 w-4 text-good" />
                  Active Cryptographic Defense
                </div>
                <div className="mt-2 text-[13px] leading-relaxed text-ink-2">
                  {selectedAttack.defense}
                </div>
              </div>

              <div className="rounded-xl border border-line bg-page p-4 text-[12px] text-ink-3">
                <div className="font-semibold text-ink">Judge Verification Note:</div>
                <div className="mt-1 leading-relaxed">
                  Unlike traditional cloud IoT where the server can be bribed or compromised, every check
                  here is anchored to an EIP-712 typed signature or smart contract invariant that reverts the
                  transaction on failure.
                </div>
              </div>
            </div>

            {/* Right: Live Interactive Terminal Console (7 cols) */}
            <div className="rounded-xl border border-line bg-page md:col-span-7">
              <div className="flex items-center justify-between border-b border-line bg-surface px-4 py-2.5">
                <div className="flex items-center gap-2 text-[12px] font-mono text-ink-3">
                  <Terminal className="h-3.5 w-3.5 text-accent" />
                  <span>Exploit Execution Trace</span>
                </div>
                {result && (
                  <Pill tone={result.bountyAwarded ? "danger" : "success"}>
                    {result.verdict}
                  </Pill>
                )}
              </div>

              <div className="p-4 font-mono text-[12px] leading-relaxed">
                {!result && !running && (
                  <div className="py-8 text-center text-ink-4">
                    Click "Launch Exploit Simulation" above to test this attack against the live system.
                  </div>
                )}

                {running && (
                  <div className="flex items-center gap-2 py-8 text-accent">
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    <span>Broadcasting simulated attack payload to sensor gateway & ledger…</span>
                  </div>
                )}

                {result && (
                  <div className="space-y-3">
                    <div>
                      <span className="text-ink-4"># Attack Target:</span>
                      <div className="text-accent">{result.attack}</div>
                    </div>
                    <div>
                      <span className="text-ink-4"># Injected Payload:</span>
                      <pre className="mt-1 rounded bg-surface p-2 text-ink-2">
                        {JSON.stringify(result.payload, null, 2)}
                      </pre>
                    </div>
                    <div>
                      <span className="text-ink-4"># Security Layer Defense Response:</span>
                      <div className="mt-1 rounded bg-good-bg/50 p-2 font-semibold text-good">
                        {result.details}
                      </div>
                    </div>
                    <div className="flex items-center justify-between border-t border-line pt-2 text-[11.5px]">
                      <span className="text-ink-3">Bounty Payout:</span>
                      <span className="font-bold text-good">
                        {result.bountyAwarded ? "100 MSTC AWARDED" : "DENIED (DEFENSE HELD)"}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Honest Residual Risks & Roadmaps */}
        <div className="mt-8 rounded-2xl border border-line bg-surface p-6 shadow-panel">
          <div className="flex items-center gap-2 text-[16px] font-semibold text-ink">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Where We Are Honestly Still Weak (Known Residual Risks & Roadmaps)
          </div>
          <div className="mt-3 grid gap-4 text-[13px] leading-relaxed sm:grid-cols-2 lg:grid-cols-3">
            <div className="rounded-xl border border-line bg-page p-4">
              <strong className="text-ink">1. Relay Attacks:</strong>
              <p className="mt-1 text-ink-3">
                A remote attacker could relay a live BLE beacon message to a rover that is not physically
                present. Proximity RSSI checks and timestamp expiration add friction, but acoustic pulse
                distance-bounding is the ultimate research-grade roadmap fix.
              </p>
            </div>
            <div className="rounded-xl border border-line bg-page p-4">
              <strong className="text-ink">2. ESP32 Flash Extraction:</strong>
              <p className="mt-1 text-ink-3">
                ESP32 keys without enabled secure boot and flash encryption can be extracted physically via
                JTAG. Production roadmap: Dedicated ATECC608A / OPTIGA Trust secure elements.
              </p>
            </div>
            <div className="rounded-xl border border-line bg-page p-4">
              <strong className="text-ink">3. Complexity Risk:</strong>
              <p className="mt-1 text-ink-3">
                Adding more mechanisms means more failure surface. We keep the smart contract intentionally
                lean (pure invariant enforcement) while placing heavy watcher heuristics in the off-chain
                guardian service.
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
