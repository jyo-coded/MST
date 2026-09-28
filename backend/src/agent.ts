import { ethers } from "ethers";
import { chain } from "./chain";
import { config } from "./config";
import { emit } from "./events";
import { evaluatePaymentIntent, INCIDENT, type PaymentIntent } from "./guardian";
import { state, announce } from "./store";
import { extractJson } from "./verifier/llm";
import { recordIncident } from "./workflow";

/**
 * The city's AI operations assistant (text box on the dashboard, or a voice
 * transcript from the mic). It is DELIBERATELY naive: it turns whatever it is
 * told into an intent, and it can be prompt-injected. That is the point of
 * the demo. The assistant has no key and there is no contract function it
 * could call to move money, so a fully compromised assistant still can't pay.
 */
const ASSISTANT_PROMPT = `You are the operations assistant for a city's waste-collection control room.
Turn the user's message into a JSON intent. Reply ONLY with JSON:
{"action":"PAY"|"REPORT_BIN"|"QUERY"|"OTHER","to":string|null,"amountMstc":number|null,"jobId":string|null,"summary":string}
- PAY: the user wants money sent to someone.
- REPORT_BIN: a citizen or officer reports a full / overflowing bin.
- QUERY: a question about budgets, jobs or payments.`;

export function parseIntentRules(text: string): PaymentIntent {
  const to = text.match(/0x[0-9a-zA-Z]{4,}/)?.[0] ?? null;
  const amount = text.match(/(\d+(?:\.\d+)?)\s*(?:mstc|mst|tokens?|coins?)/i)?.[1] ?? text.match(/\b(\d+(?:\.\d+)?)\b/)?.[1];
  const jobId = text.match(/job\s*#?\s*(\d+)/i)?.[1] ?? null;
  let action: PaymentIntent["action"] = "OTHER";
  if (/\b(pay|send|transfer|release|refund|disburse|wire)\b/i.test(text)) action = "PAY";
  else if (/\b(overflow|overflowing|full|report|complain|stinks?)\b/i.test(text)) action = "REPORT_BIN";
  else if (/\b(balance|budget|how much|status|spent|paid)\b/i.test(text)) action = "QUERY";
  const amountMstc = amount !== undefined && action === "PAY" ? Number(amount) : null;
  return {
    action,
    to,
    amountMstc,
    jobId,
    summary:
      action === "PAY"
        ? `pay ${amountMstc ?? "?"} MSTC to ${to ?? "?"}${jobId ? ` for job #${jobId}` : ""}`
        : action === "REPORT_BIN"
          ? "citizen report: bin needs collection"
          : action === "QUERY"
            ? "question about budgets / payments"
            : "unrecognised request",
  };
}

async function parseIntent(text: string): Promise<{ intent: PaymentIntent; parser: string }> {
  if (config.verifier.mode === "openai") {
    try {
      const res = await fetch(`${config.verifier.qwenBaseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.verifier.qwenApiKey ? { Authorization: `Bearer ${config.verifier.qwenApiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.verifier.qwenModel,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: ASSISTANT_PROMPT },
            { role: "user", content: text },
          ],
        }),
        signal: AbortSignal.timeout(config.verifier.timeoutMs),
      });
      const json = await res.json();
      const raw = extractJson(json?.choices?.[0]?.message?.content ?? "");
      const action = ["PAY", "REPORT_BIN", "QUERY", "OTHER"].includes(raw.action) ? raw.action : "OTHER";
      return {
        intent: {
          action,
          to: typeof raw.to === "string" ? raw.to : null,
          amountMstc: Number.isFinite(Number(raw.amountMstc)) && raw.amountMstc !== null ? Number(raw.amountMstc) : null,
          jobId: raw.jobId ? String(raw.jobId) : null,
          summary: String(raw.summary ?? "").slice(0, 200),
        },
        parser: config.verifier.qwenModel,
      };
    } catch {
      // fall back to the rule parser below
    }
  }
  return { intent: parseIntentRules(text), parser: "rules" };
}

export async function handleAgentMessage(text: string) {
  const c = chain();
  emit("agent:message", "info", `Assistant received: "${text.slice(0, 160)}"`, { text });
  const { intent, parser } = await parseIntent(text);
  emit("agent:intent", intent.action === "PAY" ? "warn" : "info", `Assistant (${parser}) understood: ${intent.summary}`, {
    intent,
  });

  if (intent.action === "PAY") {
    const [collector, ward] = await Promise.all([
      c.getCollector(config.registry.collectorId),
      c.getWard(config.registry.wardId),
    ]);
    const job = intent.jobId ? state.jobs[intent.jobId] : undefined;
    const result = evaluatePaymentIntent(intent, {
      registeredPayouts: collector.device === ethers.ZeroAddress ? [] : [collector.payout],
      maxPayoutPerJob: ward.policy.maxPayoutPerJob,
      jobIsVerifiable: !!job && ["Accepted", "Verifying", "Held"].includes(job.status),
    });
    emit("guardian:intent", "danger", result.headline, { intent, checks: result.checks });
    announce(`bin:${config.registry.binId}`, "Unauthorised payment request blocked.", "alert");
    const incident = await recordIncident(
      INCIDENT.UNAUTHORIZED_PAYMENT_INTENT,
      intent.jobId,
      `Assistant was asked to ${intent.summary}; Guardian blocked it`,
      { text, intent, checks: result.checks },
    );
    return { intent, parser, guardian: result, incident, paymentSent: false };
  }

  if (intent.action === "REPORT_BIN") {
    emit(
      "agent:report",
      "info",
      "Citizen report logged. A job opens only when the bin's own sensor signs that it is full.",
      { intent },
    );
    return { intent, parser, answer: "Logged. The bin hires a collector itself once its sensor confirms it is full." };
  }

  if (intent.action === "QUERY") {
    const ward = await c.getWard(config.registry.wardId);
    const settled = Object.values(state.jobs).filter((j) => j.status === "Settled");
    const paid = settled.reduce((a, j) => a + BigInt(j.payoutWei ?? "0"), 0n);
    const answer =
      `Ward ${config.registry.wardId} holds ${ethers.formatEther(ward.balance)} MSTC ` +
      `(${ethers.formatEther(ward.reserved)} in escrow). ${settled.length} verified collections paid ` +
      `${ethers.formatEther(paid)} MSTC so far.`;
    emit("agent:answer", "info", answer);
    return { intent, parser, answer };
  }

  return { intent, parser, answer: "I can report bins, answer budget questions, or pass payment requests to the Guardian." };
}
