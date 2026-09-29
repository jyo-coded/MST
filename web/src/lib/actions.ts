import { ethers } from "ethers";
import { post } from "./api";
import { useLive, useSigning } from "./store";
import type { Config, RequestDetail } from "./types";
import { sendLedgerTx, useWallet } from "./wallet";

export type Action =
  | { kind: "approve" }
  | { kind: "reject"; reason: string }
  | { kind: "assign"; workerId: string; amountMstc: string }
  | { kind: "cancelAssignment"; reason: string }
  | { kind: "investigate"; reason: string }
  | { kind: "approveCompletion"; note: string }
  | { kind: "rejectCompletion"; reason: string }
  | { kind: "releasePayment" };

const SERVER: Record<Action["kind"], string> = {
  approve: "approve",
  reject: "reject",
  assign: "assign",
  cancelAssignment: "cancel-assignment",
  investigate: "investigate",
  approveCompletion: "approve-completion",
  rejectCompletion: "reject-completion",
  releasePayment: "release-payment",
};

const CONFIRM_TEXT: Record<Action["kind"], string> = {
  approve: "Approval recorded on",
  reject: "Rejection recorded on",
  assign: "Assignment recorded on",
  cancelAssignment: "Cancellation recorded on",
  investigate: "Investigation recorded on",
  approveCompletion: "Completion approval recorded on",
  rejectCompletion: "Rejection recorded on",
  releasePayment: "Payment confirmed on",
};

const ACTION_TX: Record<Action["kind"], string> = {
  approve: "MUNICIPAL_APPROVAL",
  reject: "REQUEST_REJECTION",
  assign: "WORKER_ASSIGNMENT",
  cancelAssignment: "ASSIGNMENT_CANCELLED",
  investigate: "INVESTIGATION",
  approveCompletion: "COMPLETION_APPROVAL",
  rejectCompletion: "COMPLETION_REJECTION",
  releasePayment: "WORKER_PAYMENT",
};

function walletCall(a: Action, id: number): { method: string; args: unknown[]; note?: string } {
  switch (a.kind) {
    case "approve":
      return { method: "approveRequest", args: [id] };
    case "reject":
      return { method: "rejectRequest", args: [id, ethers.id(a.reason || "rejected")], note: a.reason };
    case "assign":
      return { method: "assignWorker", args: [id, ethers.encodeBytes32String(a.workerId), ethers.parseEther(a.amountMstc)] };
    case "cancelAssignment":
      return { method: "cancelAssignment", args: [id, ethers.id(a.reason || "cancelled")], note: a.reason };
    case "investigate":
      return { method: "openInvestigation", args: [id, ethers.id(a.reason || "investigate")], note: a.reason };
    case "approveCompletion":
      return { method: "approveCompletion", args: [id, ethers.id(a.note || "approved")], note: a.note };
    case "rejectCompletion":
      return { method: "rejectCompletion", args: [id, ethers.id(a.reason || "rejected")], note: a.reason };
    case "releasePayment":
      return { method: "releasePayment", args: [id] };
  }
}

/**
 * Runs an officer decision. With BridgeKey connected (and holding the officer
 * role) the officer signs in the browser and the server only observes the
 * transaction; otherwise the municipal server wallet signs. Either way the
 * state only changes once the MST transaction is confirmed.
 */
export async function runAction(cfg: Config, requestId: number, a: Action): Promise<RequestDetail> {
  const wallet = useWallet.getState();
  const useBridgeKey = useSigning.getState().mode === "wallet" && wallet.address && wallet.officer;
  const toast = useLive.getState().toast;
  let detail: RequestDetail;

  if (useBridgeKey) {
    const call = walletCall(a, requestId);
    if (a.kind === "releasePayment") await post(`/requests/${requestId}/payment/begin-wallet`);
    let hash: string;
    try {
      toast({ tone: "info", title: "Confirm in BridgeKey", body: `Sign ${call.method} for ${cfg.networkLabel}` });
      hash = await sendLedgerTx(cfg, call.method, call.args);
    } catch (err: any) {
      if (a.kind === "releasePayment") await post(`/requests/${requestId}/payment/abort-wallet`, { reason: err?.shortMessage ?? err?.message });
      throw new Error(err?.shortMessage ?? err?.info?.error?.message ?? err?.message ?? "Signature rejected");
    }
    const res = await post<{ request: RequestDetail }>("/chain/observe", { hash, method: call.method, requestId, note: call.note });
    detail = res.request;
  } else {
    const body =
      a.kind === "assign"
        ? { workerId: a.workerId, amountMstc: a.amountMstc }
        : a.kind === "approveCompletion"
          ? { note: a.note }
          : "reason" in a
            ? { reason: a.reason }
            : {};
    detail = await post<RequestDetail>(`/requests/${requestId}/${SERVER[a.kind]}`, body);
  }

  const tx = [...detail.transactions].reverse().find((t) => t.action === ACTION_TX[a.kind]);
  if (tx) {
    const confirmed = tx.status === "CONFIRMED";
    toast({
      tone: confirmed ? "success" : tx.status === "FAILED" ? "danger" : "info",
      title: confirmed ? `${CONFIRM_TEXT[a.kind]} ${cfg.networkLabel}` : tx.status === "FAILED" ? "Transaction failed on-chain" : `Submitted to ${cfg.networkLabel}, awaiting confirmation`,
      body: `Tx ${tx.hash.slice(0, 10)}…${tx.hash.slice(-6)}${confirmed ? ` · block ${tx.blockNumber}` : ""}`,
      href: tx.url ?? undefined,
    });
  }
  wallet.refresh();
  return detail;
}
