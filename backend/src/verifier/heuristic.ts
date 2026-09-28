import { config } from "../config";
import type { VerifierPacket, VerifierResult, Verdict } from "./types";

/**
 * Built-in baseline verifier. Same flags and output contract as the Qwen
 * model, so the system works (and is testable) with no model running, and so
 * the LLM's verdict can be compared against a transparent baseline.
 */
export function heuristicVerify(p: VerifierPacket): VerifierResult {
  const f = p.features;
  const started = Date.now();
  let confidence = 95;
  const flags: string[] = [];
  const reasons: string[] = [];
  const hit = (flag: string, penalty: number, reason: string) => {
    flags.push(flag);
    reasons.push(reason);
    confidence -= penalty;
  };

  if (f.fillDelta >= 10 && f.dropWhileLidOpenPct < 0.6) {
    hit("DROP_WITH_LID_CLOSED", 40, `Only ${Math.round(f.dropWhileLidOpenPct * 100)}% of the fill drop happened with the lid open.`);
  }
  if (f.fillDelta >= 40 && f.dropSteps <= 1) {
    hit("INSTANT_EMPTYING", 25, `A ${f.fillDelta}-point drop happened in a single sample; real emptying takes several scoops.`);
  }
  if (f.maxSingleStepRise >= 40) {
    hit("STEP_ACCUMULATION", 30, `Fill level jumped ${f.maxSingleStepRise} points in one sample before the job; waste accumulates gradually.`);
  }
  if (f.fillDelta >= 40 && f.soundPeakDuringService < 30) {
    hit("NO_SOUND", 15, `Peak sound during service was ${f.soundPeakDuringService}/100; emptying a bin is noisy.`);
  }
  if (f.conservationRatio === null) {
    hit("NO_COLLECTOR_CLAIM", 30, "The collector did not report a signed hopper measurement.");
  } else if (f.conservationRatio < 0.25) {
    hit(
      "POSSIBLE_ILLEGAL_DUMPING",
      50,
      `Bin lost ~${f.expectedHopperDelta.toFixed(1)} hopper-points of waste but the hopper gained only ${f.hopperDelta}.`,
    );
  } else if (f.conservationRatio < 0.5 || f.conservationRatio > 2.0) {
    hit("CONSERVATION_MISMATCH", 30, `Hopper gain is ${f.conservationRatio}x what the bin's drop predicts.`);
  }
  if (f.vehiclePresentPct < 0.5) {
    hit("NO_VEHICLE", 20, `Collector vehicle detected for only ${Math.round(f.vehiclePresentPct * 100)}% of the service.`);
  }
  if (Math.abs(f.fillAtHire - f.fillBefore) > 20) {
    hit("HIRE_FILL_MISMATCH", 20, `Bin hired at ${f.fillAtHire}% but was ${f.fillBefore}% when service began.`);
  }
  if (f.jobsForBinLastHour > config.guardian.maxJobsPerBinPerHour / 2) {
    hit("HIGH_JOB_FREQUENCY", 15, `${f.jobsForBinLastHour} jobs for this bin in the last hour.`);
  }
  const total = f.collectorCompleted + f.collectorRejected;
  if (total >= 3 && f.collectorRejected / total > 0.5) {
    hit("COLLECTOR_HISTORY", 10, `Collector has ${f.collectorRejected}/${total} rejected jobs.`);
  }

  confidence = Math.max(0, Math.min(100, confidence));
  const verdict: Verdict = confidence >= 70 ? "APPROVE" : confidence >= 40 ? "HOLD" : "REJECT";
  if (!reasons.length) reasons.push("Fill curve, lid, sound, vehicle presence and hopper gain tell a consistent story.");

  return {
    available: true,
    mode: "heuristic",
    model: "civicproof-heuristic-v1",
    verdict,
    confidence,
    flags,
    reasons,
    latencyMs: Date.now() - started,
  };
}
