import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { DATA_DIR } from "./config";

const REPORT_DIR = path.join(DATA_DIR, "reports");

/** Deterministic JSON: sorted keys, bigint as string. Anyone can re-hash it. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .filter((k) => (v as any)[k] !== undefined)
          .map((k) => [k, norm((v as any)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

/**
 * Stores a verification/incident report and returns its keccak256. The hash
 * goes on-chain (JobSettled / JobRejected / IncidentRecorded), so an auditor
 * can fetch the report and prove it is the one the Guardian acted on.
 */
export function saveReport(report: unknown): { hash: string; json: string } {
  const json = canonicalJson(report);
  const hash = ethers.keccak256(ethers.toUtf8Bytes(json));
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORT_DIR, `${hash}.json`), json);
  return { hash, json };
}

export function readReport(hash: string): unknown | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return null;
  const file = path.join(REPORT_DIR, `${hash.toLowerCase()}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}
