/**
 * Runs scenarios against a running gateway (npm run backend):
 *   npm run demo                         the judge-facing sequence
 *   npm run demo -- normal spoof replay  specific scenarios
 *   npm run demo -- --all                every scenario
 * HELD jobs are auto-rejected by a "reviewer" so the bin is free for the next one.
 */
import { config } from "../src/config";

const BASE = process.env.GATEWAY_URL || `http://localhost:${config.server.port}`;
const DEFAULT = ["normal", "ghost", "spoof", "injection", "replay"];
const ALL = ["normal", "partial", "ghost", "dumping", "spoof", "wrongtag", "forged", "injection", "replay"];

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

async function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const names = process.argv.includes("--all") ? ALL : args.length ? args : DEFAULT;
  const pace = Number(process.env.PACE_MS ?? 400);
  let mismatches = 0;
  for (const name of names) {
    process.stdout.write(`\n▶ ${name.padEnd(10)} `);
    try {
      const r = await call("POST", `/api/sim/${name}`, { paceMs: pace });
      if (r.outcome) {
        const good = r.outcome === r.expected;
        if (!good) mismatches++;
        console.log(`${good ? "✓" : "✗"} ${r.outcome} (expected ${r.expected}) job #${r.jobId}\n  ${r.headline ?? ""}`);
        for (const tx of r.txs ?? []) console.log(`    ${tx.label.padEnd(10)} ${tx.url ?? tx.hash}`);
        if (r.outcome === "HOLD") {
          await call("POST", `/api/jobs/${r.jobId}/review`, { approve: false, reviewer: "demo-script", note: "auto-rejected by demo runner" });
          console.log(`    (demo reviewer rejected held job #${r.jobId})`);
        }
      } else if (r.guardian) {
        console.log(`✓ BLOCKED  ${r.guardian.headline}`);
        if (r.incident?.tx) console.log(`    incident   ${r.incident.tx.url ?? r.incident.tx.hash}`);
      } else if (r.blocked) {
        console.log(`✓ BLOCKED  contract refused replay of job #${r.jobId}: ${r.reason}`);
        if (r.incident?.tx) console.log(`    incident   ${r.incident.tx.url ?? r.incident.tx.hash}`);
      } else {
        console.log(JSON.stringify(r));
      }
    } catch (err) {
      mismatches++;
      console.log(`✗ ${(err as Error).message}`);
    }
  }
  console.log(mismatches ? `\n${mismatches} scenario(s) did not behave as expected.\n` : "\nAll scenarios behaved as expected.\n");
  process.exit(mismatches ? 1 : 0);
}

main();
