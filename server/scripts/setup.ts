import { ethers } from "ethers";
import { LEDGER_ABI } from "../src/chain/ledger";
import { config, deviceWallet, loadCity, rfidHash, workerWallet } from "../src/config";
import { adminClient, fmt, link, readDeploymentFile, writeDeploymentFile } from "./common";

/**
 * Configures the deployed ledger: roles, bins (device keys + location),
 * workers (wallet + RFID hash), the municipal fund, and gas for the
 * gateway/officer wallets. Idempotent: re-running only does what's missing.
 */
async function main() {
  const d = readDeploymentFile();
  if (!d) throw new Error("No deployment. Run `npm run deploy` first.");
  const client = adminClient();
  const signer = client.signer!;
  const iface = new ethers.Interface(LEDGER_ABI);
  const ledger = new ethers.Contract(d.address, LEDGER_ABI, client.provider.ethersProvider);
  const city = loadCity();
  const setupTxs = d.setupTxs ?? [];

  const send = async (label: string, action: string, method: string, args: unknown[], value = 0n) => {
    // MST SDK signer: encode with ethers, sign + broadcast with the SDK.
    const hash = await signer.sendTransaction({ to: d.address, data: iface.encodeFunctionData(method, args), value });
    const receipt = await client.provider.waitForTransaction(hash);
    if (receipt?.status !== 1) throw new Error(`${label} failed: ${hash}`);
    setupTxs.push({ hash, action, method });
    writeDeploymentFile({ ...d, setupTxs });
    console.log(`✓ ${label.padEnd(34)} ${link(hash)}`);
  };

  console.log(`\nConfiguring ledger ${d.address} on ${config.networkLabel}\n`);

  const roles: [string, string | null, string][] = [
    ["GATEWAY_ROLE", config.keys.gateway ? new ethers.Wallet(config.keys.gateway).address : null, "IoT gateway"],
    ["OFFICER_ROLE", config.keys.officer ? new ethers.Wallet(config.keys.officer).address : null, "municipal officer"],
    ["VERIFIER_ROLE", config.keys.verifier ? new ethers.Wallet(config.keys.verifier).address : null, "AI verifier"],
  ];
  for (const extra of (process.env.EXTRA_OFFICERS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    roles.push(["OFFICER_ROLE", ethers.getAddress(extra), "extra officer (BridgeKey)"]);
  }
  for (const [role, address, who] of roles) {
    if (!address) throw new Error(`Missing key for ${who}. Run \`npm run keys -- --write\``);
    if (await ledger.hasRole(ethers.id(role), address)) {
      console.log(`· ${role} already granted to ${who}`);
      continue;
    }
    await send(`grant ${role} → ${who}`, "ROLE_GRANT", "grantRole", [ethers.id(role), address]);
  }

  const bins = [];
  for (const b of city.bins) {
    const device = deviceWallet(b.id).address;
    const onchain = await ledger.getBin(ethers.encodeBytes32String(b.id));
    if (onchain.device.toLowerCase() !== device.toLowerCase()) {
      bins.push({ id: ethers.encodeBytes32String(b.id), device, latE6: Math.round(b.lat * 1e6), lngE6: Math.round(b.lng * 1e6), active: true });
    }
  }
  if (bins.length) await send(`register ${bins.length} bins`, "BIN_REGISTRATION", "registerBins", [bins]);
  else console.log("· all bins registered");

  const workers = [];
  for (const w of city.workers) {
    const wallet = workerWallet(w.id);
    const onchain = await ledger.getWorker(ethers.encodeBytes32String(w.id));
    if (onchain.wallet.toLowerCase() !== wallet.toLowerCase() || onchain.rfidHash !== rfidHash(w.rfidUid)) {
      workers.push({ id: ethers.encodeBytes32String(w.id), wallet, rfidHash: rfidHash(w.rfidUid), active: true });
    }
  }
  if (workers.length) await send(`register ${workers.length} workers`, "WORKER_REGISTRATION", "registerWorkers", [workers]);
  else console.log("· all workers registered");

  const target = ethers.parseEther(process.env.FUND_MSTC ?? (config.isLocal ? "5" : "0.5"));
  const funded = await client.provider.getBalance(d.address);
  if (funded < target) await send(`fund municipal pool (+${fmt(target - funded)})`, "FUND_TOPUP", "fund", [], target - funded);
  else console.log(`· municipal fund holds ${fmt(funded)}`);

  // Gas for the wallets that sign day-to-day transactions (MST SDK sendNative).
  const gasMin = ethers.parseEther(process.env.GAS_MIN_MSTC ?? "0.05");
  const gasTop = ethers.parseEther(process.env.GAS_TOPUP_MSTC ?? "0.2");
  for (const [who, key] of [
    ["gateway", config.keys.gateway],
    ["officer", config.keys.officer],
  ] as const) {
    const address = new ethers.Wallet(key).address;
    const bal = await client.provider.getBalance(address);
    if (bal >= gasMin) {
      console.log(`· ${who} wallet has ${fmt(bal)} for gas`);
      continue;
    }
    const hash = await signer.sendNative(address, gasTop.toString());
    await client.provider.waitForTransaction(hash);
    setupTxs.push({ hash, action: "GAS_FUNDING", method: "transfer" });
    writeDeploymentFile({ ...d, setupTxs });
    console.log(`✓ ${`gas → ${who} (${fmt(gasTop)})`.padEnd(34)} ${link(hash)}`);
  }

  const admin = await client.provider.getBalance(signer.address);
  console.log(`\nAdmin wallet left with ${fmt(admin)}. Next: npm run doctor, then npm start\n`);
}

main().catch((err) => {
  console.error(err.shortMessage ?? err.message ?? err);
  process.exit(1);
});
