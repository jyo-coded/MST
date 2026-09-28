import { config } from "../config";
import { heuristicVerify } from "./heuristic";
import { httpVerify, qwenVerify } from "./llm";
import type { VerifierPacket, VerifierResult } from "./types";

export * from "./types";

/**
 * Runs the configured verifier. Never throws: an unreachable or confused
 * model returns available=false, and the Guardian treats that as "no
 * opinion" (hold for a human), never as approval.
 */
export async function runVerifier(packet: VerifierPacket): Promise<{ primary: VerifierResult; baseline: VerifierResult }> {
  const baseline = heuristicVerify(packet);
  const mode = config.verifier.mode;
  if (mode === "heuristic") return { primary: baseline, baseline };

  const started = Date.now();
  try {
    const primary = mode === "http" ? await httpVerify(packet) : await qwenVerify(packet);
    return { primary, baseline };
  } catch (err) {
    return {
      primary: {
        available: false,
        mode,
        model: mode === "http" ? config.verifier.httpUrl : config.verifier.qwenModel,
        verdict: null,
        confidence: 0,
        flags: [],
        reasons: [],
        latencyMs: Date.now() - started,
        error: (err as Error).message,
      },
      baseline,
    };
  }
}
