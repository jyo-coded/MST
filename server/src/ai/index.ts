import { config } from "../config";
import { q } from "../db";
import { keccakJson, round1 } from "../util";
import type { FusionResult } from "./fusion";

export * from "./fusion";

type SecondOpinion = {
  provider: string;
  model: string;
  available: boolean;
  verified: boolean | null;
  confidence: number | null;
  reasons: string[];
  latencyMs: number;
  error?: string;
};

const SYSTEM_PROMPT = `You are the verification model of a municipal smart-waste system.
You receive sensor evidence from an IoT bin (two ultrasonic sensors, an IR deposit sensor, a lid sensor, a servo lock, an RFID reader)
and a list of rule checks already computed from it. Decide whether the claim is genuine:
- kind "fullness": is the bin really full and is the reading trustworthy (not an obstruction, not a faulty sensor)?
- kind "completion": was the bin really emptied by the assigned worker (not a fake, not partial)?
Payments depend on your answer, so be calibrated and conservative.
Reply with ONLY a JSON object: {"decision":"VERIFIED"|"REJECTED","confidence":<0-100>,"reasons":["short sentence", ...]}`;

function extractJson(text: string): any {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("no JSON object in model reply");
  return JSON.parse(cleaned.slice(a, b + 1));
}

function packet(r: FusionResult) {
  const samples = (r.evidence.samples as unknown[][]) ?? [];
  const step = Math.max(1, Math.ceil(samples.length / 30));
  return {
    kind: r.kind,
    summary: r.summary,
    checks: r.checks.map(({ id, observed, expected, pass, critical }) => ({ id, observed, expected, pass, critical })),
    samples: samples.filter((_, i) => i % step === 0).map(([ts, fill, fill2, lid, ir]) => ({ ts, fill, fill2, lid, ir })),
  };
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.ai.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return res.json();
}

function normalise(raw: any): { verified: boolean; confidence: number; reasons: string[] } {
  const d = String(raw?.decision ?? raw?.verdict ?? "").toUpperCase();
  const verified =
    typeof raw?.verified === "boolean" ? raw.verified : typeof raw?.verifiable === "boolean" ? raw.verifiable : d.includes("VERIFIED") && !d.includes("NOT");
  let confidence = Number(raw?.confidence ?? raw?.score);
  if (confidence > 0 && confidence <= 1) confidence *= 100;
  if (!Number.isFinite(confidence)) throw new Error("model reply has no confidence");
  const reasons = (Array.isArray(raw?.reasons) ? raw.reasons : Array.isArray(raw?.reason) ? raw.reason : raw?.reason ? [raw.reason] : [])
    .map((x: unknown) => String(x).slice(0, 200))
    .slice(0, 6);
  return { verified, confidence: round1(Math.max(0, Math.min(100, confidence))), reasons };
}

async function secondOpinion(r: FusionResult): Promise<SecondOpinion | null> {
  const provider = config.ai.provider;
  if (provider === "builtin") return null;
  const started = Date.now();
  const model = provider === "qwen" ? config.ai.qwenModel : config.ai.httpUrl;
  try {
    let raw: any;
    if (provider === "qwen") {
      const json = await postJson(
        `${config.ai.qwenBaseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          model: config.ai.qwenModel,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: JSON.stringify(packet(r)) },
          ],
        },
        config.ai.qwenApiKey ? { Authorization: `Bearer ${config.ai.qwenApiKey}` } : {},
      );
      raw = extractJson(json?.choices?.[0]?.message?.content ?? "");
    } else {
      if (!config.ai.httpUrl) throw new Error("AI_SERVICE_URL is not set");
      raw = await postJson(`${config.ai.httpUrl.replace(/\/$/, "")}/verify/${r.kind}`, packet(r));
    }
    const n = normalise(raw);
    return { provider, model, available: true, ...n, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      provider,
      model,
      available: false,
      verified: null,
      confidence: null,
      reasons: [],
      latencyMs: Date.now() - started,
      error: (err as Error).message,
    };
  }
}

export type StoredVerification = {
  id: number;
  decision: string;
  verified: boolean;
  confidence: number;
  report_hash: string;
  evidence_hash: string;
};

/**
 * Runs the fusion model, asks the configured second opinion, combines them
 * (a second opinion can only make the result stricter), hashes the complete
 * report and stores it. The hashes are what get signed onto MST.
 */
export async function runVerification(
  r: FusionResult,
  ctx: { requestId: number | null; binId: string; inputs: Record<string, unknown> },
): Promise<{ row: StoredVerification; result: FusionResult; second: SecondOpinion | null; reportHash: string }> {
  const started = Date.now();
  const second = await secondOpinion(r);
  let verified = r.verified;
  let confidence = r.confidence;
  if (second?.available) {
    verified = verified && !!second.verified;
    confidence = Math.min(confidence, second.confidence ?? confidence);
  }
  const decision =
    r.kind === "fullness" ? (verified ? "VERIFIED" : "REJECTED") : verified ? "COLLECTION_VERIFIED" : "COLLECTION_NOT_VERIFIED";
  const result: FusionResult = { ...r, verified, confidence, decision };
  const report = {
    kind: r.kind,
    requestId: ctx.requestId,
    binId: ctx.binId,
    model: "astra-sensor-fusion-v1",
    decision,
    confidence,
    checks: r.checks,
    summary: r.summary,
    evidenceHash: r.evidenceHash,
    secondOpinion: second,
  };
  const reportHash = keccakJson(report);
  const [row] = await q<StoredVerification>(
    `INSERT INTO ai_verifications
       (request_id, bin_id, kind, decision, verified, confidence, provider, model, latency_ms, inputs, checks, reasons, summary, second_opinion, evidence_hash, report_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [
      ctx.requestId,
      ctx.binId,
      r.kind,
      decision,
      verified,
      confidence,
      second ? `builtin+${second.provider}` : "builtin",
      second?.available ? `astra-sensor-fusion-v1 + ${second.model}` : "astra-sensor-fusion-v1",
      Date.now() - started,
      JSON.stringify({ ...ctx.inputs, evidence: r.evidence }),
      JSON.stringify(r.checks),
      JSON.stringify(second?.available && second.reasons.length ? [...r.reasons, ...second.reasons.map((x) => `Qwen: ${x}`)] : r.reasons),
      JSON.stringify(r.summary),
      second ? JSON.stringify(second) : null,
      r.evidenceHash,
      reportHash,
    ],
  );
  return { row, result, second, reportHash };
}

export async function aiHealth(): Promise<{ provider: string; online: boolean; detail: string }> {
  if (config.ai.provider === "builtin") return { provider: "builtin", online: true, detail: "astra-sensor-fusion-v1 (in-process)" };
  try {
    const url = config.ai.provider === "qwen" ? `${config.ai.qwenBaseUrl.replace(/\/$/, "")}/models` : `${config.ai.httpUrl.replace(/\/$/, "")}/health`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return { provider: config.ai.provider, online: res.ok, detail: res.ok ? `${config.ai.provider === "qwen" ? config.ai.qwenModel : config.ai.httpUrl} reachable` : `HTTP ${res.status}` };
  } catch (err) {
    return { provider: config.ai.provider, online: false, detail: `unreachable, sensor fusion only (${(err as Error).message})` };
  }
}
