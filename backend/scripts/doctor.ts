import { ethers } from "ethers";
import { chain } from "../src/chain";
import { config, loadDeployment } from "../src/config";
import { deviceWallets } from "../src/devices";
import { rfidTagHash } from "../src/eip712";

/** Pre-demo checklist: run `npm run doctor` before walking on stage. */
let failures = 0;
const ok = (msg: string) => console.log(`  ✓ ${msg}`);
const bad = (msg: string) => {
  failures++;
  console.log(`  ✗ ${msg}`);
};
const warn = (msg: string) => console.log(`  ! ${msg}`);

async function main() {
  console.log(`\nCivicProof doctor: network=${config.network} rpc=${config.rpcUrl}\n`);
  const d = loadDeployment();
  if (!d && !config.contractAddress) {
    bad(`no deployments/${config.network}.json. Run npm run deploy:${config.network === "localhost" ? "local" : config.network}`);
    return;
  }
  const c = chain();
  const net = await c.provider.getNetwork();
  Number(net.chainId) === config.chainId ? ok(`RPC reachable, chainId ${net.chainId}`) : bad(`chainId ${net.chainId} != expected ${config.chainId}`);
  const code = await c.provider.getCode(c.deployment.address);
  code !== "0x" ? ok(`contract deployed at ${c.deployment.address}`) : bad(`no contract code at ${c.deployment.address}`);

  const bal = await c.balanceOf(c.relayer.address);
  bal > ethers.parseEther("0.01") ? ok(`relayer ${c.relayer.address} has ${ethers.formatEther(bal)} MSTC for gas`) : bad(`relayer ${c.relayer.address} is low on gas: ${ethers.formatEther(bal)} MSTC (faucet!)`);

  const [opRole, gRole] = await Promise.all([c.vault.OPERATOR_ROLE(), c.vault.GUARDIAN_ROLE()]);
  (await c.vault.hasRole(opRole, c.relayer.address)) ? ok("relayer has OPERATOR_ROLE") : bad("relayer lacks OPERATOR_ROLE (re-deploy or grantRole)");
  if (!c.guardian) bad("GUARDIAN_PRIVATE_KEY not set");
  else (await c.vault.hasRole(gRole, c.guardian.address)) ? ok(`guardian ${c.guardian.address} has GUARDIAN_ROLE`) : bad("guardian key lacks GUARDIAN_ROLE");
  if (c.admin) ok(`admin key present (${c.admin.address}) for emergency stop`);
  else warn("ADMIN_PRIVATE_KEY not set: emergency stop from the dashboard won't work");

  const r = config.registry;
  const ward = await c.getWard(r.wardId);
  ward.exists ? ok(`ward ${r.wardId} configured, budget ${ethers.formatEther(ward.balance)} MSTC (${ethers.formatEther(ward.reserved)} reserved)`) : bad(`ward ${r.wardId} not configured (npm run setup:*)`);
  if (ward.exists && ward.balance - ward.reserved < ward.policy.maxPayoutPerJob) bad("ward budget below one job's escrow: fund it");

  const bin = await c.getBin(r.binId);
  if (bin.device === ethers.ZeroAddress) bad(`bin ${r.binId} not registered`);
  else {
    ok(`bin ${r.binId} registered to device ${bin.device}`);
    if (bin.activeJobId !== 0n) warn(`bin ${r.binId} is busy with job #${bin.activeJobId} (review/expire it before the demo)`);
    if (deviceWallets.bin && deviceWallets.bin.address !== bin.device) bad("BIN_DEVICE_PRIVATE_KEY does not match the registered bin device");
  }
  const col = await c.getCollector(r.collectorId);
  if (col.device === ethers.ZeroAddress) bad(`collector ${r.collectorId} not registered`);
  else {
    ok(`collector ${r.collectorId} registered; payout wallet ${col.payout}`);
    col.tagHash === rfidTagHash(r.collectorRfidUid) ? ok(`collector RFID tag matches COLLECTOR_RFID_UID=${r.collectorRfidUid}`) : bad("COLLECTOR_RFID_UID does not match the on-chain tag hash");
    if (deviceWallets.collector && deviceWallets.collector.address !== col.device) bad("COLLECTOR_DEVICE_PRIVATE_KEY does not match the registered collector device");
  }
  if (deviceWallets.rogue) {
    const rogue = await c.getCollector(r.rogueCollectorId);
    rogue.device === deviceWallets.rogue.address
      ? ok(`rogue contractor ${r.rogueCollectorId} registered for attack scenarios`)
      : bad(`ROGUE_COLLECTOR_DEVICE_PRIVATE_KEY set but collector ${r.rogueCollectorId} is not registered with it (re-run setup)`);
  } else {
    warn("no rogue contractor: attack scenarios will dent the honest contractor's on-chain record");
  }
  (await c.vault.paused()) ? bad("contract is PAUSED (dashboard → resume)") : ok("contract not paused");

  if (config.verifier.mode === "openai") {
    try {
      const res = await fetch(`${config.verifier.qwenBaseUrl.replace(/\/$/, "")}/models`, { signal: AbortSignal.timeout(5000) });
      res.ok ? ok(`Qwen endpoint reachable at ${config.verifier.qwenBaseUrl}`) : bad(`Qwen endpoint returned HTTP ${res.status}`);
    } catch (err) {
      bad(`Qwen endpoint unreachable: ${(err as Error).message} (jobs will be HELD, not paid)`);
    }
  } else if (config.verifier.mode === "http") {
    config.verifier.httpUrl ? ok(`custom verifier at ${config.verifier.httpUrl}`) : bad("VERIFIER_MODE=http but VERIFIER_URL is empty");
  } else {
    warn("VERIFIER_MODE=heuristic: using the built-in baseline, not Qwen");
  }
  if (config.server.deviceToken === "change-me") warn("DEVICE_TOKEN is still 'change-me'");
}

main()
  .catch((err) => bad((err as Error).message))
  .finally(() => {
    console.log(failures ? `\n${failures} problem(s) found.\n` : "\nAll good. Break a leg.\n");
    process.exit(failures ? 1 : 0);
  });
