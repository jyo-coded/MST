import clsx from "clsx";
import { motion } from "framer-motion";
import { ethers } from "ethers";
import {
  Award,
  CheckCircle2,
  ExternalLink,
  Fingerprint,
  QrCode,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Logo } from "../components/Shell";
import { Button, Field, inputClass, Pill } from "../components/ui";
import { post } from "../lib/api";
import { useConfig, useRequest } from "../lib/queries";

export function JudgeWitness() {
  const [params] = useSearchParams();
  const requestIdParam = params.get("requestId") ? Number(params.get("requestId")) : 1;
  const binIdParam = params.get("binId") ?? "BIN-001";

  const { data: cfg } = useConfig();
  const { data: reqDetail } = useRequest(requestIdParam);

  const [witnessName, setWitnessName] = useState("Judge Alex");
  const [role, setRole] = useState("Hackathon Evaluator / Judge");
  const [statement, setStatement] = useState(
    "I personally evaluated and witnessed the physical collection, sensor validation, and lid state at this bin."
  );
  const [submitting, setSubmitting] = useState(false);
  const [attestationResult, setAttestationResult] = useState<any>(null);
  const [wallet, setWallet] = useState<ethers.HDNodeWallet | null>(null);

  // Generate or retrieve an ephemeral evaluator keypair stored in session
  useEffect(() => {
    let key = sessionStorage.getItem("astra_judge_key");
    let w: ethers.HDNodeWallet;
    if (key) {
      w = new ethers.Wallet(key) as unknown as ethers.HDNodeWallet;
    } else {
      w = ethers.Wallet.createRandom();
      sessionStorage.setItem("astra_judge_key", w.privateKey);
    }
    setWallet(w);
  }, []);

  const handleAttest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wallet) return;
    setSubmitting(true);

    try {
      // Sign statement with evaluator's key
      const sig = await wallet.signMessage(statement);

      const res = await post<{ ok: boolean; attestation: any }>("/witness/attest", {
        requestId: requestIdParam,
        witnessName,
        witnessAddress: wallet.address,
        statement,
        signature: sig,
        role,
      });

      setAttestationResult(res.attestation);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-page text-ink selection:bg-accent/20">
      <header className="sticky top-0 z-50 border-b border-line bg-page/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-xl items-center justify-between px-4">
          <Link to="/" className="flex items-center gap-2">
            <Logo size={24} />
            <span className="text-[14px] font-semibold">{cfg?.productName ?? "Astra Waste"}</span>
          </Link>
          <span className="rounded bg-accent/10 px-2 py-0.5 text-[11px] font-medium text-accent">
            Judge-as-Witness
          </span>
        </div>
      </header>

      <main className="mx-auto max-w-xl px-4 py-8">
        <div className="text-center">
          <div className="inline-flex items-center gap-1.5 rounded-full border border-accent/20 bg-accent/10 px-3 py-1 text-[12px] font-medium text-accent">
            <Sparkles className="h-3.5 w-3.5" />
            Decentralized Observer Attestation
          </div>
          <h1 className="mt-3 text-[24px] font-bold tracking-tight sm:text-[28px]">
            Judge Attestation Witness
          </h1>
          <p className="mt-1 text-[13.5px] text-ink-3">
            Sign a cryptographic witness statement for collection{" "}
            <strong className="text-ink">REQ-{String(requestIdParam).padStart(5, "0")}</strong>. Your signature
            will be committed on-chain and permanently attached to the public evidence bundle.
          </p>
        </div>

        {/* Request Context Card */}
        <div className="mt-6 rounded-xl border border-line bg-surface p-4 shadow-sm">
          <div className="flex items-center justify-between border-b border-line pb-2.5">
            <span className="text-[12px] text-ink-3">Target Collection Request</span>
            <Pill tone="info">REQ-{String(requestIdParam).padStart(5, "0")}</Pill>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-[12.5px]">
            <div>
              <span className="text-ink-4">Bin Location:</span>
              <div className="font-medium text-ink">{reqDetail?.bin.name ?? binIdParam}</div>
            </div>
            <div>
              <span className="text-ink-4">Ledger Status:</span>
              <div className="font-medium text-ink">{reqDetail?.request.statusLabel ?? "Active"}</div>
            </div>
          </div>
        </div>

        {attestationResult ? (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="mt-6 rounded-2xl border border-good-line bg-good-bg/40 p-6 text-center text-good shadow-panel"
          >
            <CheckCircle2 className="mx-auto h-12 w-12 text-good" />
            <h2 className="mt-3 text-[19px] font-bold text-ink">Witness Attestation Committed!</h2>
            <p className="mt-1.5 text-[13px] text-ink-2">
              Your signature has been cryptographically merged into the Evidence Bundle and submitted to the MST
              blockchain.
            </p>

            <div className="mt-4 rounded-xl border border-good-line/60 bg-surface p-3 text-left font-mono text-[11.5px] text-ink-2">
              <div>
                <span className="text-ink-4">Signer: </span>
                <span className="break-all">{attestationResult.witnessAddress}</span>
              </div>
              <div className="mt-1">
                <span className="text-ink-4">Evidence Hash: </span>
                <span className="break-all text-accent">{attestationResult.evidenceHash}</span>
              </div>
            </div>

            <div className="mt-5 flex flex-col gap-2 sm:flex-row">
              <Link
                to={`/audit`}
                className="flex-1 rounded-lg border border-line bg-surface py-2 text-[13px] font-medium text-ink shadow-sm hover:bg-hover"
              >
                View on Public Audit Page
              </Link>
              <Link
                to={`/app/requests/${requestIdParam}`}
                className="flex-1 rounded-lg bg-good py-2 text-[13px] font-medium text-white shadow-sm hover:opacity-90"
              >
                Back to Request Detail
              </Link>
            </div>
          </motion.div>
        ) : (
          <form onSubmit={handleAttest} className="mt-6 space-y-4 rounded-2xl border border-line bg-surface p-5 shadow-panel">
            <Field label="Your Name (Judge / Evaluator)">
              <input
                className={inputClass}
                value={witnessName}
                onChange={(e) => setWitnessName(e.target.value)}
                placeholder="e.g. Judge Alex"
                required
              />
            </Field>

            <Field label="Your Role / Affiliation">
              <input
                className={inputClass}
                value={role}
                onChange={(e) => setRole(e.target.value)}
                placeholder="e.g. Hackathon Track Judge"
              />
            </Field>

            <Field label="Witness Attestation Statement">
              <textarea
                className={clsx(inputClass, "h-20 resize-none py-2")}
                value={statement}
                onChange={(e) => setStatement(e.target.value)}
                required
              />
            </Field>

            <div className="rounded-lg border border-line bg-page p-3 text-[12px] text-ink-3">
              <div className="flex items-center gap-1.5 font-medium text-ink">
                <Fingerprint className="h-4 w-4 text-accent" />
                <span>Observer Signing Key (secp256k1)</span>
              </div>
              <div className="mt-1 break-all font-mono text-[11px] text-ink-2">
                {wallet?.address ?? "Generating ephemeral evaluator keypair…"}
              </div>
            </div>

            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full"
              loading={submitting}
              icon={<ShieldCheck className="h-4 w-4" />}
            >
              Sign & Commit Attestation On-Chain
            </Button>
          </form>
        )}
      </main>
    </div>
  );
}
