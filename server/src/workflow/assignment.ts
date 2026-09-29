import { haversineKm, WORKER_FREE, type WorkerStatus } from "@astra/shared";
import { one, q } from "../db";

export type Candidate = {
  workerId: string;
  name: string;
  status: WorkerStatus;
  available: boolean;
  distanceKm: number;
  etaMin: number;
  activeJobs: number;
  completed: number;
  rejected: number;
  reliability: number; // 0-100
  zone: string | null;
  sameZone: boolean;
  score: number; // lower is better
  recommended: boolean;
  why: string;
  lat: number;
  lng: number;
  wallet: string;
};

const CITY_SPEED_KMH = 16; // a collection cart / two-wheeler in city traffic

/**
 * Ranks workers for a bin by proximity, availability, workload and track
 * record. Busy workers are listed (so the officer sees the whole picture)
 * but never recommended.
 */
export async function rankWorkers(binId: string): Promise<Candidate[]> {
  const bin = await one(`SELECT id, lat, lng, zone FROM bins WHERE id = $1`, [binId]);
  if (!bin) return [];
  const workers = await q(
    `SELECT w.*,
            (SELECT count(*)::int FROM assignments a WHERE a.worker_id = w.id AND a.status IN ('ASSIGNED','EN_ROUTE','AT_BIN','COLLECTING')) AS active_jobs
       FROM workers w ORDER BY w.id`,
  );
  const out: Candidate[] = workers.map((w: any) => {
    const distanceKm = haversineKm({ lat: w.lat, lng: w.lng }, { lat: bin.lat, lng: bin.lng });
    const available = WORKER_FREE.includes(w.status) && w.active_jobs === 0;
    const total = w.completed_count + w.rejected_count;
    const reliability = total === 0 ? 100 : Math.round((100 * w.completed_count) / total);
    const sameZone = w.zone === bin.zone;
    const score = distanceKm + w.active_jobs * 2.5 + (available ? 0 : 50) + (100 - reliability) / 25 - (sameZone ? 0.3 : 0);
    return {
      workerId: w.id,
      name: w.name,
      status: w.status,
      available,
      distanceKm: Math.round(distanceKm * 100) / 100,
      etaMin: Math.max(2, Math.round((distanceKm / CITY_SPEED_KMH) * 60 + 1)),
      activeJobs: w.active_jobs,
      completed: w.completed_count,
      rejected: w.rejected_count,
      reliability,
      zone: w.zone,
      sameZone,
      score,
      recommended: false,
      why: "",
      lat: w.lat,
      lng: w.lng,
      wallet: w.wallet_address,
    };
  });
  out.sort((a, b) => a.score - b.score);
  const best = out.find((c) => c.available);
  if (best) best.recommended = true;
  for (const c of out) {
    c.why = !c.available
      ? c.activeJobs > 0
        ? `Busy · ${c.activeJobs} active job${c.activeJobs > 1 ? "s" : ""}`
        : "Busy"
      : c.recommended
        ? `Closest available${c.sameZone ? " · same zone" : ""}`
        : c.sameZone
          ? "Available · same zone"
          : "Available";
  }
  return out;
}
