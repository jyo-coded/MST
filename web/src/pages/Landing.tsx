import clsx from "clsx";
import { motion } from "framer-motion";
import { ArrowRight, Award, Blocks, Building2, Cpu, Radio, Search, ShieldAlert, Truck } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Logo } from "../components/Shell";
import { Button, Dot, Field, inputClass, Segmented } from "../components/ui";
import { api, post } from "../lib/api";
import { useConfig } from "../lib/queries";
import { useSession } from "../lib/store";
import type { SessionUser } from "../lib/types";

const STEPS = [
  { icon: <Radio className="h-[18px] w-[18px]" />, label: "Bin detects", sub: "Ultrasonic + IR" },
  { icon: <Cpu className="h-[18px] w-[18px]" />, label: "AI verifies", sub: "Sensor fusion" },
  { icon: <Building2 className="h-[18px] w-[18px]" />, label: "City approves", sub: "Officer decides" },
  { icon: <Truck className="h-[18px] w-[18px]" />, label: "Worker collects", sub: "RFID at the bin" },
  { icon: <Blocks className="h-[18px] w-[18px]" />, label: "MST settles", sub: "On-chain payment" },
];

export function Landing() {
  const { data: cfg } = useConfig();
  const session = useSession();
  const navigate = useNavigate();
  const [role, setRole] = useState<"municipality" | "worker">("municipality");
  const [email, setEmail] = useState("officer@municipal.demo");
  const [password, setPassword] = useState("demo1234");
  const [workers, setWorkers] = useState<{ id: string; name: string }[]>([]);
  const [workerId, setWorkerId] = useState("WRK-001");
  const [pin, setPin] = useState("1234");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (session.user) navigate(session.user.role === "worker" ? "/worker" : "/app", { replace: true });
  }, [session.user, navigate]);
  useEffect(() => {
    api<{ id: string; name: string }[]>("/auth/workers").then(setWorkers).catch(() => undefined);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setActive((a) => (a + 1) % STEPS.length), 1600);
    return () => clearInterval(t);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ token: string; user: SessionUser }>("/auth/login", role === "worker" ? { workerId, pin } : { email, password });
      session.login(r.token, r.user);
      navigate(r.user.role === "worker" ? "/worker" : "/app");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full lg:grid-cols-[1.15fr_1fr]">
      <section className="relative flex flex-col justify-between overflow-hidden px-6 py-8 sm:px-12 lg:px-16 lg:py-12">
        <div className="flex items-center gap-2.5">
          <Logo size={32} />
          <span className="text-[16px] font-semibold tracking-[-0.01em]">{cfg?.productName ?? "Astra Waste"}</span>
        </div>

        <div className="my-14 max-w-[620px]">
          <motion.h1 initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }} className="text-[40px] font-semibold leading-[1.05] tracking-[-0.035em] text-ink sm:text-[52px]">
            Intelligent Waste Collection.
            <span className="block text-ink-3">Verified by Data. Settled on Blockchain.</span>
          </motion.h1>
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2, duration: 0.6 }} className="mt-6 max-w-[520px] text-[16px] leading-relaxed text-ink-2">
            Smart bins report when they are full. Sensor fusion checks the reading is real. The municipality assigns the nearest worker, the bin checks their RFID card, the sensors prove the waste was removed, and the
            worker is paid on MST Blockchain.
          </motion.p>

          <div className="mt-12">
            <ol className="relative grid grid-cols-5">
              <span className="absolute left-[10%] right-[10%] top-[19px] h-px bg-line" />
              <motion.span
                className="absolute top-[16px] h-[7px] w-[7px] rounded-full bg-accent shadow-[0_0_0_4px_rgba(42,120,214,0.15)]"
                initial={false}
                animate={{ left: `calc(${10 + active * 20}% - 3px)` }}
                transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
              />
              {STEPS.map((s, i) => (
                <li key={s.label} className="relative flex flex-col items-center text-center">
                  <span
                    className={clsx(
                      "relative z-[1] flex h-10 w-10 items-center justify-center rounded-full border bg-surface transition-colors duration-500",
                      i <= active ? "border-ink/80 text-ink" : "border-line text-ink-3",
                    )}
                  >
                    {s.icon}
                  </span>
                  <span className={clsx("mt-3 text-[13px] font-medium transition-colors duration-500", i <= active ? "text-ink" : "text-ink-3")}>{s.label}</span>
                  <span className="mt-0.5 hidden text-[11.5px] text-ink-3 sm:block">{s.sub}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px] text-ink-3">
          <span className="inline-flex items-center gap-1.5">
            <Dot tone={cfg ? "success" : "neutral"} pulse={!!cfg} /> {cfg?.networkLabel ?? "Connecting…"}
          </span>
          {cfg?.contract && (
            <span className="font-mono" title={cfg.contract.address}>
              Ledger {cfg.contract.address.slice(0, 8)}…{cfg.contract.address.slice(-4)}
            </span>
          )}
          <span>
            {cfg?.municipality.name} · {cfg?.municipality.city}
          </span>
        </div>
      </section>

      <section className="flex items-center justify-center border-t border-line bg-surface px-6 py-12 lg:border-l lg:border-t-0">
        <motion.form initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.5, ease: [0.22, 1, 0.36, 1] }} onSubmit={submit} className="w-full max-w-[380px]">
          <h2 className="text-[22px] font-semibold tracking-[-0.02em]">Sign in</h2>
          <p className="mt-1 text-[14px] text-ink-3">Choose how you work with the platform.</p>
          <div className="mt-6">
            <Segmented
              value={role}
              onChange={setRole}
              items={[
                { value: "municipality", label: "Municipality" },
                { value: "worker", label: "Worker" },
              ]}
            />
          </div>
          <div className="mt-6 space-y-4">
            {role === "municipality" ? (
              <>
                <Field label="Work email">
                  <input className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
                </Field>
                <Field label="Password">
                  <input className={inputClass} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                </Field>
              </>
            ) : (
              <>
                <Field label="Worker">
                  <select className={inputClass} value={workerId} onChange={(e) => setWorkerId(e.target.value)}>
                    {workers.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name} · {w.id}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="PIN">
                  <input className={inputClass} inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} />
                </Field>
              </>
            )}
          </div>
          {error && <div className="mt-4 rounded-md border border-bad-line bg-bad-bg px-3 py-2 text-[13px] text-bad">{error}</div>}
          <Button type="submit" variant="primary" size="lg" className="mt-6 w-full" loading={busy}>
            Continue <ArrowRight className="h-4 w-4" />
          </Button>
          <p className="mt-4 text-center text-[12px] text-ink-3">
            Demo access: {role === "municipality" ? "officer@municipal.demo · demo1234" : "any worker · PIN 1234"}
          </p>

          <div className="mt-6 border-t border-line pt-4 space-y-2.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-3 text-center">
              Evaluator & Citizen Direct Access
            </div>
            <div className="grid grid-cols-3 gap-2">
              <Link
                to="/audit"
                className="flex flex-col items-center justify-center p-2 rounded-md border border-line bg-page hover:bg-hover text-center text-[11.5px] font-medium text-ink transition-colors shadow-panel"
              >
                <Search className="h-4 w-4 mb-1 text-prog" />
                <span>Public Audit</span>
              </Link>
              <Link
                to="/arena"
                className="flex flex-col items-center justify-center p-2 rounded-md border border-line bg-page hover:bg-hover text-center text-[11.5px] font-medium text-ink transition-colors shadow-panel"
              >
                <ShieldAlert className="h-4 w-4 mb-1 text-bad" />
                <span>Attack Arena</span>
              </Link>
              <Link
                to="/witness"
                className="flex flex-col items-center justify-center p-2 rounded-md border border-line bg-page hover:bg-hover text-center text-[11.5px] font-medium text-ink transition-colors shadow-panel"
              >
                <Award className="h-4 w-4 mb-1 text-good" />
                <span>Judge Witness</span>
              </Link>
            </div>
          </div>
        </motion.form>
      </section>
    </div>
  );
}
