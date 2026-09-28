import type { BinSample, CollectorSample } from "./samples";

/**
 * Numeric features describing the physical story of one collection. This is
 * the ONLY thing the verifier model sees: numbers from sensors, never free
 * text from a contractor, so there is nothing to prompt-inject.
 */
export type Features = {
  fillAtHire: number;
  fillBefore: number;
  fillAfter: number;
  fillDelta: number;
  serviceDurationSec: number;
  lidOpenSec: number;
  dropWhileLidOpenPct: number; // share of the fill drop that happened with the lid open
  dropSteps: number; // how many sample-to-sample decreases made up the emptying
  maxSingleStepDrop: number;
  maxSingleStepRise: number; // largest jump while the bin was filling up (before service)
  accumulationSpanSec: number; // time the bin took to go from <40% to its pre-service level
  soundPeakDuringService: number;
  soundBaseline: number;
  vehiclePresentPct: number;
  hopperBefore: number | null;
  hopperAfter: number | null;
  hopperDelta: number | null;
  expectedHopperDelta: number;
  conservationRatio: number | null; // hopper gain / expected gain from the bin's drop
  acceptToServiceSec: number;
  jobsForBinLastHour: number;
  collectorCompleted: number;
  collectorRejected: number;
};

export type FeatureInput = {
  fillAtHire: number;
  fillBefore: number;
  fillAfter: number;
  serviceStart: number;
  serviceEnd: number;
  acceptedAt: number;
  binSamples: BinSample[];
  collectorSamples: CollectorSample[] | null;
  hopperBefore: number | null;
  hopperAfter: number | null;
  binLitres: number;
  hopperLitres: number;
  jobsForBinLastHour: number;
  collectorCompleted: number;
  collectorRejected: number;
};

const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

export function extractFeatures(i: FeatureInput): Features {
  const inService = i.binSamples.filter((s) => s.t >= i.serviceStart && s.t <= i.serviceEnd);
  const beforeService = i.binSamples.filter((s) => s.t < i.serviceStart);
  const outside = i.binSamples.filter((s) => s.t < i.serviceStart || s.t > i.serviceEnd);

  // Include the last pre-service sample so the first drop is counted.
  const window = beforeService.length ? [beforeService[beforeService.length - 1], ...inService] : inService;

  let lidOpenSec = 0;
  let totalDrop = 0;
  let dropWithLidOpen = 0;
  let dropSteps = 0;
  let maxSingleStepDrop = 0;
  for (let k = 1; k < window.length; k++) {
    const prev = window[k - 1];
    const cur = window[k];
    if (cur.lid === 1 || prev.lid === 1) lidOpenSec += Math.max(0, cur.t - prev.t);
    const drop = prev.fill - cur.fill;
    if (drop > 1) {
      totalDrop += drop;
      dropSteps += 1;
      maxSingleStepDrop = Math.max(maxSingleStepDrop, drop);
      if (cur.lid === 1 || prev.lid === 1) dropWithLidOpen += drop;
    }
  }

  let maxSingleStepRise = 0;
  for (let k = 1; k < beforeService.length; k++) {
    maxSingleStepRise = Math.max(maxSingleStepRise, beforeService[k].fill - beforeService[k - 1].fill);
  }
  const lowPoint = [...beforeService].reverse().find((s) => s.fill < 40);
  const lastBefore = beforeService[beforeService.length - 1];
  const accumulationSpanSec = lowPoint && lastBefore ? lastBefore.t - lowPoint.t : 0;

  const soundPeakDuringService = inService.reduce((m, s) => Math.max(m, s.snd), 0);
  const soundBaseline = outside.length ? outside.reduce((a, s) => a + s.snd, 0) / outside.length : 0;
  const vehiclePresentPct = inService.length ? inService.filter((s) => s.veh === 1).length / inService.length : 0;

  const fillDelta = i.fillBefore - i.fillAfter;
  const expectedHopperDelta = (Math.max(0, fillDelta) * i.binLitres) / i.hopperLitres;
  const hopperDelta = i.hopperBefore !== null && i.hopperAfter !== null ? i.hopperAfter - i.hopperBefore : null;
  const conservationRatio =
    hopperDelta !== null && expectedHopperDelta > 0 ? round(hopperDelta / expectedHopperDelta) : null;

  return {
    fillAtHire: i.fillAtHire,
    fillBefore: i.fillBefore,
    fillAfter: i.fillAfter,
    fillDelta,
    serviceDurationSec: i.serviceEnd - i.serviceStart,
    lidOpenSec,
    dropWhileLidOpenPct: totalDrop > 0 ? round(dropWithLidOpen / totalDrop) : 0,
    dropSteps,
    maxSingleStepDrop,
    maxSingleStepRise,
    accumulationSpanSec,
    soundPeakDuringService,
    soundBaseline: round(soundBaseline),
    vehiclePresentPct: round(vehiclePresentPct),
    hopperBefore: i.hopperBefore,
    hopperAfter: i.hopperAfter,
    hopperDelta,
    expectedHopperDelta: round(expectedHopperDelta),
    conservationRatio,
    acceptToServiceSec: i.serviceStart - i.acceptedAt,
    jobsForBinLastHour: i.jobsForBinLastHour,
    collectorCompleted: i.collectorCompleted,
    collectorRejected: i.collectorRejected,
  };
}
