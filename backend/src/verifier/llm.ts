import { config } from "../config";
import { FLAGS, type VerifierPacket, type VerifierResult, type Verdict } from "./types";

export const SYSTEM_PROMPT = `You are the evidence verifier for CivicProof, a city system that pays waste-collection contractors only for physically verified work.

You receive numeric sensor evidence for ONE collection job:
- a city-owned smart bin: fill level %, lid open (0/1), collector vehicle present (0/1), sound level 0-100
- a contractor-owned collector vehicle: hopper fill %, hatch open (0/1)
- derived features and history.

Decide whether the physical story is consistent with a genuine collection. You do NOT authorise payments. Deterministic rules and a smart contract do that. You can only raise doubt, so be calibrated: do not approve evidence you find implausible.

Genuine collection usually looks like: the bin filled gradually over time; the vehicle arrived; the lid opened; the fill level fell over several samples while the lid was open; there was noise; the hopper gained roughly the waste the bin lost (conservationRatio ~0.5-2.0).

Known flags (use these codes when they apply):
${Object.entries(FLAGS)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join("\n")}

Reply with ONLY a JSON object, no prose, in exactly this shape:
{"verdict":"APPROVE"|"HOLD"|"REJECT","confidence":<integer 0-100>,"flags":["FLAG_CODE",...],"reasons":["short sentence",...]}`;

/** Pulls the first JSON object out of a model reply (tolerates ```json fences). */
export function extractJson(text: string): any {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model reply contained no JSON object");
  return JSON.parse(cleaned.slice(start, end + 1));
}

/**
 * Normalises any reasonable model output into a VerifierResult. Accepts the
 * CivicProof shape, and also {verifiable: bool, confidence} from a simpler
 * custom Qwen service.
 */
export function normaliseModelOutput(raw: any, mode: string, model: string, latencyMs: number): VerifierResult {
  let verdict: Verdict | null = null;
  const v = String(raw?.verdict ?? raw?.decision ?? "").toUpperCase();
  if (v === "APPROVE" || v === "HOLD" || v === "REJECT") verdict = v;
  else if (typeof raw?.verifiable === "boolean") verdict = raw.verifiable ? "APPROVE" : "REJECT";

  let confidence = Number(raw?.confidence ?? raw?.score);
  if (Number.isFinite(confidence) && confidence > 0 && confidence <= 1) confidence *= 100; // 0-1 scale
  if (!verdict || !Number.isFinite(confidence)) {
    return {
      available: false,
      mode,
      model,
      verdict: null,
      confidence: 0,
      flags: [],
      reasons: [],
      latencyMs,
      error: `unusable model output: ${JSON.stringify(raw).slice(0, 200)}`,
    };
  }
  const flags = (Array.isArray(raw.flags) ? raw.flags : [])
    .map((x: unknown) => String(x).toUpperCase().replace(/[^A-Z_]/g, ""))
    .filter(Boolean)
    .slice(0, 12);
  const reasons = (Array.isArray(raw.reasons) ? raw.reasons : raw.reason ? [raw.reason] : [])
    .map((x: unknown) => String(x).slice(0, 240))
    .slice(0, 8);
  return {
    available: true,
    mode,
    model,
    verdict,
    confidence: Math.round(Math.max(0, Math.min(100, confidence))),
    flags,
    reasons,
    latencyMs,
  };
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.verifier.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Qwen behind any OpenAI-compatible server: Ollama, vLLM, LM Studio, DashScope. */
export async function qwenVerify(p: VerifierPacket): Promise<VerifierResult> {
  const started = Date.now();
  const { qwenBaseUrl, qwenModel, qwenApiKey } = config.verifier;
  const body = {
    model: qwenModel,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify(p) },
    ],
  };
  const json = await postJson(
    `${qwenBaseUrl.replace(/\/$/, "")}/chat/completions`,
    body,
    qwenApiKey ? { Authorization: `Bearer ${qwenApiKey}` } : {},
  );
  const text = json?.choices?.[0]?.message?.content ?? "";
  return normaliseModelOutput(extractJson(text), "openai", qwenModel, Date.now() - started);
}

/**
 * Your own Qwen decision service. POSTs the packet as JSON and expects
 * {verdict, confidence, flags?, reasons?} or {verifiable, confidence, reason?}.
 */
export async function httpVerify(p: VerifierPacket): Promise<VerifierResult> {
  const started = Date.now();
  if (!config.verifier.httpUrl) throw new Error("VERIFIER_URL is not set");
  const json = await postJson(config.verifier.httpUrl, p);
  return normaliseModelOutput(json, "http", config.verifier.httpUrl, Date.now() - started);
}
