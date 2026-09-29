import clsx from "clsx";
import { Check, CircleX, FileSearch, Loader2, Send, ShieldCheck, UserPlus, XCircle } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { runAction, type Action } from "../lib/actions";
import { inr, mstc, shortHash } from "../lib/format";
import { useConfig } from "../lib/queries";
import { useLive, useSigning } from "../lib/store";
import type { Payment, Request } from "../lib/types";
import { useWallet } from "../lib/wallet";
import { Button, Hash, inputClass, Modal, Pill } from "./ui";

export function useAction() {
  const { data: cfg } = useConfig();
  const qc = useQueryClient();
  const toast = useLive((s) => s.toast);
  const [busy, setBusy] = useState<Action["kind"] | null>(null);
  const run = async (requestId: number, a: Action) => {
    if (!cfg) return;
    setBusy(a.kind);
    useLive.setState({ quietUntil: Date.now() + 5 * 60_000 });
    try {
      const detail = await runAction(cfg, requestId, a);
      qc.setQueryData(["request", requestId], detail);
      qc.invalidateQueries({ queryKey: ["requests"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
      qc.invalidateQueries({ queryKey: ["payments"] });
      return detail;
    } catch (err) {
      toast({ tone: "danger", title: "Action not completed", body: (err as Error).message });
    } finally {
      setBusy(null);
      useLive.setState({ quietUntil: Date.now() + 10_000 });
    }
  };
  return { run, busy };
}

export function SigningNote() {
  const { data: cfg } = useConfig();
  const mode = useSigning((s) => s.mode);
  const w = useWallet();
  const viaWallet = mode === "wallet" && w.address && w.officer;
  return (
    <div className="flex items-center gap-1.5 text-[12px] text-ink-3">
      <ShieldCheck className="h-3.5 w-3.5" />
      {viaWallet ? (
        <span>
          You sign in BridgeKey <span className="font-mono">{shortHash(w.address)}</span>
        </span>
      ) : (
        <span>
          Signed by the municipal wallet <span className="font-mono">{shortHash(cfg?.wallets?.officer ?? "")}</span> on {cfg?.networkLabel}
        </span>
      )}
    </div>
  );
}

type ReasonKind = "reject" | "cancelAssignment" | "investigate" | "rejectCompletion" | "approveCompletion";
const REASON_COPY: Record<ReasonKind, { title: string; body: string; placeholder: string; cta: string; danger?: boolean }> = {
  reject: { title: "Reject collection request", body: "The rejection and a hash of your reason are recorded on MST.", placeholder: "e.g. Duplicate request, bin inspected and not full", cta: "Reject request", danger: true },
  cancelAssignment: { title: "Cancel assignment", body: "The escrowed payment returns to the fund and the request goes back to assignment.", placeholder: "e.g. Worker unreachable", cta: "Cancel assignment", danger: true },
  investigate: { title: "Open an investigation", body: "The collection stays unpaid until you approve or reject it.", placeholder: "e.g. Citizen reported bin still full", cta: "Open investigation" },
  rejectCompletion: { title: "Reject collection", body: "The worker is not paid and the escrow returns to the fund. Recorded on MST.", placeholder: "e.g. Bin not emptied, confirmed on site", cta: "Reject collection", danger: true },
  approveCompletion: { title: "Approve after investigation", body: "You override the AI's doubt. The ledger still refuses if the sensors show the bin was not emptied.", placeholder: "e.g. Inspected on site, bin empty", cta: "Approve collection" },
};

/** Contextual decisions for a request. `tracking` hides the link to the page you're already on. */
export function RequestActions({ r, compact, tracking }: { r: Request; compact?: boolean; tracking?: boolean }) {
  const navigate = useNavigate();
  const { run, busy } = useAction();
  const [modal, setModal] = useState<ReasonKind | null>(null);
  const [text, setText] = useState("");
  const size = compact ? "sm" : "md";

  const submitModal = async () => {
    if (!modal) return;
    const a: Action =
      modal === "approveCompletion"
        ? { kind: "approveCompletion", note: text }
        : modal === "investigate"
          ? { kind: "investigate", reason: text }
          : modal === "reject"
            ? { kind: "reject", reason: text }
            : modal === "cancelAssignment"
              ? { kind: "cancelAssignment", reason: text }
              : { kind: "rejectCompletion", reason: text };
    setModal(null);
    setText("");
    await run(r.id, a);
  };

  let buttons: JSX.Element | null = null;
  switch (r.status) {
    case "AWAITING_APPROVAL":
      buttons = (
        <>
          <Button size={size} variant="primary" loading={busy === "approve"} icon={<Check className="h-4 w-4" />} onClick={() => run(r.id, { kind: "approve" })}>
            Approve request
          </Button>
          <Button size={size} variant="ghost" onClick={() => setModal("reject")}>
            Reject
          </Button>
        </>
      );
      break;
    case "APPROVED":
      buttons = (
        <>
          <Button size={size} variant="primary" icon={<UserPlus className="h-4 w-4" />} onClick={() => navigate(`/app/assign/${r.id}`)}>
            Assign worker
          </Button>
          <Button size={size} variant="ghost" onClick={() => setModal("reject")}>
            Reject
          </Button>
        </>
      );
      break;
    case "ASSIGNED":
    case "EN_ROUTE":
      buttons = (
        <>
          {!tracking && (
            <Button size={size} variant="secondary" onClick={() => navigate(`/app/active?request=${r.id}`)}>
              Track collection
            </Button>
          )}
          <Button size={size} variant="ghost" onClick={() => setModal("cancelAssignment")}>
            Cancel assignment
          </Button>
        </>
      );
      break;
    case "COLLECTING":
    case "REVERIFYING":
      buttons = tracking ? null : (
        <Button size={size} variant="secondary" onClick={() => navigate(`/app/active?request=${r.id}`)}>
          Track collection
        </Button>
      );
      break;
    case "AWAITING_FINAL_APPROVAL":
      buttons = (
        <>
          <Button size={size} variant="success" loading={busy === "approveCompletion"} icon={<Check className="h-4 w-4" />} onClick={() => run(r.id, { kind: "approveCompletion", note: "Verified by sensors and AI" })}>
            Approve collection
          </Button>
          <Button size={size} variant="secondary" icon={<FileSearch className="h-4 w-4" />} onClick={() => setModal("investigate")}>
            Investigate
          </Button>
          <Button size={size} variant="ghost" onClick={() => setModal("rejectCompletion")}>
            Reject
          </Button>
        </>
      );
      break;
    case "INVESTIGATION":
      buttons = (
        <>
          <Button size={size} variant="secondary" loading={busy === "approveCompletion"} onClick={() => setModal("approveCompletion")}>
            Approve after review
          </Button>
          <Button size={size} variant="danger" loading={busy === "rejectCompletion"} icon={<CircleX className="h-4 w-4" />} onClick={() => setModal("rejectCompletion")}>
            Reject collection
          </Button>
        </>
      );
      break;
    case "COMPLETED":
      if (r.paymentStatus === "READY" || r.paymentStatus === "FAILED") {
        buttons = (
          <Button size={size} variant="primary" loading={busy === "releasePayment"} icon={<Send className="h-4 w-4" />} onClick={() => run(r.id, { kind: "releasePayment" })}>
            Release payment
          </Button>
        );
      }
      break;
  }
  if (!buttons) return null;
  const copy = modal ? REASON_COPY[modal] : null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">{buttons}</div>
      <Modal
        open={!!modal}
        onClose={() => setModal(null)}
        title={copy?.title}
        footer={
          <>
            <Button variant="ghost" onClick={() => setModal(null)}>
              Back
            </Button>
            <Button variant={copy?.danger ? "danger" : "primary"} onClick={submitModal}>
              {copy?.cta}
            </Button>
          </>
        }
      >
        <p className="mb-3">{copy?.body}</p>
        <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={copy?.placeholder} className={clsx(inputClass, "h-24 resize-none py-2")} />
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------- payment

const PAY_STEPS = [
  { key: "READY", label: "Ready" },
  { key: "SIGNING", label: "Signing" },
  { key: "SUBMITTED", label: "Broadcasting" },
  { key: "CONFIRMING", label: "Confirming" },
  { key: "PAID", label: "Paid" },
];

export function PaymentPanel({ payment, request, networkLabel }: { payment: Payment; request: Request; networkLabel: string }) {
  const { run, busy } = useAction();
  const idx = PAY_STEPS.findIndex((s) => s.key === payment.status);
  const pending = payment.status === "PENDING";
  const failed = payment.status === "FAILED";
  const cancelled = payment.status === "CANCELLED";
  const canRelease = request.status === "COMPLETED" && (payment.status === "READY" || failed);

  return (
    <div className="min-w-0">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-[12px] text-ink-3">Payment amount</div>
          <div className="mt-0.5 text-[28px] font-semibold leading-none tracking-[-0.02em]">{inr(payment.amountInr)}</div>
          <div className="mt-1 text-[13px] text-ink-2 num">{mstc(payment.amountMstc)}</div>
        </div>
        <Pill tone={payment.status === "PAID" ? "success" : failed ? "danger" : cancelled || pending ? "neutral" : payment.status === "READY" ? "warning" : "progress"} pulse={["SIGNING", "SUBMITTED", "CONFIRMING"].includes(payment.status)}>
          {payment.statusLabel}
        </Pill>
      </div>

      {!cancelled && (
        <ol className="mt-5 grid grid-cols-5 gap-1">
          {PAY_STEPS.map((s, i) => {
            const done = idx > i || payment.status === "PAID";
            const current = idx === i && payment.status !== "PAID";
            return (
              <li key={s.key} className="min-w-0">
                <div className={clsx("h-1 rounded-full", done ? "bg-good-dot" : current ? (failed ? "bg-bad-dot" : "bg-prog-dot") : "bg-line")} />
                <div className={clsx("mt-1.5 flex items-center gap-1 truncate text-[11.5px]", done ? "text-ink-2" : current ? "font-medium text-ink" : "text-ink-4")}>
                  {current && ["SIGNING", "SUBMITTED", "CONFIRMING"].includes(s.key) && <Loader2 className="h-3 w-3 animate-spin" />}
                  {s.label}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <dl className="mt-5 grid grid-cols-[130px_1fr] gap-x-3 gap-y-2.5 text-[13px]">
        <dt className="text-ink-3">Worker</dt>
        <dd>{payment.workerName}</dd>
        <dt className="text-ink-3">Worker wallet</dt>
        <dd>
          <Hash value={payment.wallet} url={payment.walletUrl} />
        </dd>
        <dt className="text-ink-3">Bin</dt>
        <dd>{payment.binId}</dd>
        <dt className="text-ink-3">Collection ID</dt>
        <dd className="font-mono text-[12.5px]">{payment.requestCode}</dd>
        <dt className="text-ink-3">Blockchain</dt>
        <dd>{networkLabel}</dd>
        <dt className="text-ink-3">Transaction fee</dt>
        <dd className="num">{payment.tx?.feeMstc ? `${Number(payment.tx.feeMstc).toFixed(8)} MSTC` : "paid by the municipal wallet on release"}</dd>
        {payment.tx && (
          <>
            <dt className="text-ink-3">Transaction</dt>
            <dd>
              <Hash value={payment.tx.hash} url={payment.tx.url} />
              {payment.tx.blockNumber !== null && <span className="ml-2 text-[12px] text-ink-3 num">block {payment.tx.blockNumber}</span>}
            </dd>
          </>
        )}
      </dl>

      {pending && <div className="mt-4 rounded-md bg-sunken px-3 py-2.5 text-[12.5px] text-ink-2">Escrowed on-chain at assignment. Becomes payable once the municipality approves the verified collection.</div>}
      {payment.error && (
        <div className="mt-4 flex gap-2 rounded-md border border-bad-line bg-bad-bg px-3 py-2.5 text-[12.5px] text-bad">
          <XCircle className="mt-[1px] h-4 w-4 shrink-0" /> {payment.error}
        </div>
      )}
      {payment.status === "PAID" && (
        <div className="mt-4 flex items-center gap-2 rounded-md border border-good-line bg-good-bg px-3 py-2.5 text-[13px] text-good">
          <Check className="h-4 w-4" /> Paid to the worker's registered wallet on {networkLabel}.
        </div>
      )}
      {canRelease && (
        <div className="mt-5">
          <Button className="w-full" size="lg" variant="primary" loading={busy === "releasePayment"} icon={<Send className="h-4 w-4" />} onClick={() => run(request.id, { kind: "releasePayment" })}>
            {failed ? "Retry payment" : "Release payment"}
          </Button>
          <div className="mt-2">
            <SigningNote />
          </div>
        </div>
      )}
    </div>
  );
}
