/**
 * Raw sensor logs travel as small CSV strings so the ESP32 can hash exactly
 * the bytes it uploads (keccak256 over the UTF-8 text). The hash is inside the
 * device-signed evidence, so the log the AI analyses is provably the log the
 * device produced.
 *
 *   bin:        t,fill,lid,veh,snd     (unix s, %, 0/1, 0/1, 0-100)
 *   collector:  t,hopper,hatch         (unix s, %, 0/1)
 */

export type BinSample = { t: number; fill: number; lid: number; veh: number; snd: number };
export type CollectorSample = { t: number; hopper: number; hatch: number };

export const BIN_HEADER = "t,fill,lid,veh,snd";
export const COLLECTOR_HEADER = "t,hopper,hatch";
const MAX_ROWS = 5000;

function parse(csv: string, header: string): number[][] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines[0]?.trim() !== header) throw new Error(`sensor log must start with header "${header}"`);
  if (lines.length - 1 > MAX_ROWS) throw new Error(`sensor log too long (max ${MAX_ROWS} rows)`);
  const width = header.split(",").length;
  return lines.slice(1).map((line, i) => {
    const cols = line.split(",").map((c) => Number(c.trim()));
    if (cols.length !== width || cols.some((c) => !Number.isFinite(c))) {
      throw new Error(`bad sensor row ${i + 2}: "${line}"`);
    }
    return cols;
  });
}

export function parseBinCsv(csv: string): BinSample[] {
  return parse(csv, BIN_HEADER)
    .map(([t, fill, lid, veh, snd]) => ({ t, fill, lid, veh, snd }))
    .sort((a, b) => a.t - b.t);
}

export function parseCollectorCsv(csv: string): CollectorSample[] {
  return parse(csv, COLLECTOR_HEADER)
    .map(([t, hopper, hatch]) => ({ t, hopper, hatch }))
    .sort((a, b) => a.t - b.t);
}

export function binCsv(rows: BinSample[]): string {
  return [BIN_HEADER, ...rows.map((r) => `${r.t},${r.fill},${r.lid},${r.veh},${r.snd}`)].join("\n");
}

export function collectorCsv(rows: CollectorSample[]): string {
  return [COLLECTOR_HEADER, ...rows.map((r) => `${r.t},${r.hopper},${r.hatch}`)].join("\n");
}

/** Evenly downsample a series so an LLM prompt stays small. */
export function downsample<T>(rows: T[], max = 40): T[] {
  if (rows.length <= max) return rows;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(rows[Math.round((i * (rows.length - 1)) / (max - 1))]);
  return out;
}
