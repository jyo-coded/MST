import { ethers } from "ethers";
import { LEDGER_ABI } from "../src/chain/ledger";
import { config, deviceWallet, loadCity, rfidHash, workerWallet } from "../src/config";
import { adminClient, readDeploymentFile } from "./common";

/** Pre-demo checklist. `npm run doctor` before walking on stage. */
let problems = 0;
const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => {
  problems++;
  console.log(`  ✗ ${m}`);
};
const warn = (m: string) => console.log(`  ! ${m}`);

async function main() {
  console.log(`\nAstra Waste doctor · ${config.networkLabel} · ${config.rpcUrl}\n`);
  const d = readDeploymentFile();
  if (!d) return bad(`no deployments/${config.network}.json (npm run deploy && npm run setup)`);
  const client = adminClient();
  const provider = client.provider.ethersProvider;
  const net = await provider.getNetwork();
  Number(net.chainId) === config.chainId ? ok(`RPC reachable, chain ${net.chainId}, block ${await client.provider.getBlockNumber()}`) : bad(`chain ${net.chainId} ≠ ${config.chainId}`);
  (await provider.getCode(d.address)) !== "0x" ? ok(`ledger deployed at ${d.address}`) : bad(`no contract code at ${d.address} (redeploy)`);
  const ledger = new ethers.Contract(d.address, LEDGER_ABI, provider);

  for (const [role, key, who] of [
    ["GATEWAY_ROLE", config.keys.gateway, "gateway"],
    ["OFFICER_ROLE", config.keys.officer, "officer"],
    ["VERIFIER_ROLE", config.keys.verifier, "verifier"],
  ] as const) {
    if (!key) {
      bad(`${who} key missing`);
      continue;
    }
    const addr = new ethers.Wallet(key).address;
    (await ledger.hasRole(ethers.id(role), addr)) ? ok(`${who} ${addr} has ${role}`) : bad(`${who} lacks ${role} (npm run setup)`);
    if (who !== "verifier") {
      const bal = await client.provider.getBalance(addr);
      bal >= ethers.parseEther("0.02") ? ok(`${who} wallet ${Number(ethers.formatEther(bal)).toFixed(4)} MSTC for gas`) : bad(`${who} wallet low on gas (${ethers.formatEther(bal)} MSTC)`);
    }
  }
  const city = loadCity();
  let binsOk = 0;
  for (const b of city.bins) {
    const onchain = await ledger.getBin(ethers.encodeBytes32String(b.id));
    if (onchain.device.toLowerCase() === deviceWallet(b.id).address.toLowerCase()) binsOk++;
  }
  binsOk === city.bins.length ? ok(`all ${binsOk} bins registered with their device keys`) : bad(`${city.bins.length - binsOk} bins not registered (npm run setup)`);
  let workersOk = 0;
  for (const w of city.workers) {
    const onchain = await ledger.getWorker(ethers.encodeBytes32String(w.id));
    if (onchain.wallet.toLowerCase() === workerWallet(w.id).toLowerCase() && onchain.rfidHash === rfidHash(w.rfidUid)) workersOk++;
  }
  workersOk === city.workers.length ? ok(`all ${workersOk} workers registered (wallet + RFID)`) : bad(`${city.workers.length - workersOk} workers not registered or changed (npm run setup)`);
  const free = await ledger.freeFunds();
  free >= ethers.parseEther(config.payment.defaultMstc) ? ok(`municipal fund has ${ethers.formatEther(free)} MSTC free`) : bad(`municipal fund too low (${ethers.formatEther(free)} MSTC free)`);
  (await ledger.paused()) ? bad("ledger is paused") : ok("ledger not paused");

  if (config.ai.provider === "qwen") {
    try {
      const r = await fetch(`${config.ai.qwenBaseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(4000) });
      r.ok ? ok(`Qwen reachable at ${config.ai.qwenBaseUrl}`) : bad(`Qwen endpoint HTTP ${r.status}`);
    } catch (err) {
      warn(`Qwen unreachable (${(err as Error).message}); sensor fusion will run alone`);
    }
  } else if (config.ai.provider === "http") {
    config.ai.httpUrl ? ok(`AI service at ${config.ai.httpUrl}`) : bad("AI_PROVIDER=http but AI_SERVICE_URL is empty");
  } else ok("AI: built-in sensor fusion model");
  const hero = city.bins.find((b) => b.hardware);
  if (hero) ok(`hardware bin ${hero.id}: provision the ESP32 with \`npm run device -- ${hero.id}\``);
}

main()
  .catch((err) => bad(err.message ?? String(err)))
  .finally(() => {
    console.log(problems ? `\n${problems} problem(s).\n` : "\nAll good.\n");
    process.exit(problems ? 1 : 0);
  });
