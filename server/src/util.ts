import { ethers } from "ethers";

/** Deterministic JSON (sorted keys, bigint as string) so anyone can re-hash a report. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (v instanceof Date) return v.toISOString();
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

export const keccakJson = (v: unknown) => ethers.keccak256(ethers.toUtf8Bytes(canonicalJson(v)));

export const round1 = (n: number) => Math.round(n * 10) / 10;
export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

export const mstc = (wei: bigint | string) => ethers.formatEther(BigInt(wei));
