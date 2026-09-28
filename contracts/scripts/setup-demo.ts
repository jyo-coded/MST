import hre, { ethers } from "hardhat";
import { addressFromEnv, env, explorerTx, readDeployment, rfidTagHash } from "./lib";

/**
 * Configures one ward, one smart bin and one collector, then funds the ward's
 * budget. Idempotent: re-running just re-applies the config and tops up.
 */
async function main() {
  const network = hre.network.name;
  const d = readDeployment(network);
  const [admin] = await ethers.getSigners();
  const vault = await ethers.getContractAt("CivicProofVault", d.address, admin);

  const wardId = BigInt(env("WARD_ID", "12"));
  const binId = BigInt(env("BIN_ID", "7"));
  const collectorId = BigInt(env("COLLECTOR_ID", "1"));

  const policy = {
    basePayout: ethers.parseEther(env("BASE_PAYOUT_MSTC", "0.01")),
    ratePerPoint: ethers.parseEther(env("RATE_PER_POINT_MSTC", "0.001")),
    maxPayoutPerJob: ethers.parseEther(env("MAX_PAYOUT_MSTC", "0.1")),
    dailyCap: ethers.parseEther(env("DAILY_CAP_MSTC", "0.3")),
    serviceWindow: Number(env("SERVICE_WINDOW_SEC", "900")),
    minFillToHire: Number(env("MIN_FILL_TO_HIRE", "75")),
    minFillDelta: Number(env("MIN_FILL_DELTA", "25")),
    minConfidence: Number(env("MIN_CONFIDENCE", "70")),
  };

  const binDevice = addressFromEnv("BIN_DEVICE");
  const collectorDevice = addressFromEnv("COLLECTOR_DEVICE");
  const payout = ethers.getAddress(env("COLLECTOR_PAYOUT_ADDRESS"));
  const tagHash = rfidTagHash(env("COLLECTOR_RFID_UID", "A1B2C3D4"));
  const fund = ethers.parseEther(env("WARD_FUND_MSTC", "0.5"));

  const send = async (label: string, p: Promise<any>) => {
    const tx = await p;
    await tx.wait();
    console.log(`✓ ${label.padEnd(28)} ${explorerTx(tx.hash)}`);
  };

  console.log(`\nConfiguring CivicProofVault ${d.address} on ${network}\n`);
  await send(`configureWard(${wardId})`, vault.configureWard(wardId, policy));
  await send(`registerBin(${binId})`, vault.registerBin(binId, wardId, binDevice, true));
  await send(`registerCollector(${collectorId})`, vault.registerCollector(collectorId, collectorDevice, payout, tagHash, true));
  // Optional second contractor that the attack scenarios play as, so the
  // honest contractor's on-chain track record stays clean.
  const rogueKey = process.env.ROGUE_COLLECTOR_DEVICE_PRIVATE_KEY?.trim();
  if (rogueKey) {
    const rogueId = BigInt(env("ROGUE_COLLECTOR_ID", "2"));
    const rogueDevice = new ethers.Wallet(rogueKey).address;
    const roguePayout = ethers.getAddress(process.env.ROGUE_COLLECTOR_PAYOUT_ADDRESS?.trim() || rogueDevice);
    const rogueTag = rfidTagHash(env("ROGUE_COLLECTOR_RFID_UID", "BADC0DE5"));
    await send(`registerCollector(${rogueId}) rogue`, vault.registerCollector(rogueId, rogueDevice, roguePayout, rogueTag, true));
  }
  await send(`fundWard(${ethers.formatEther(fund)} MSTC)`, vault.fundWard(wardId, { value: fund }));

  const ward = await vault.getWard(wardId);
  console.log(`\nWard ${wardId} budget: ${ethers.formatEther(ward.balance)} MSTC`);
  console.log(`Bin ${binId} device:        ${binDevice}`);
  console.log(`Collector ${collectorId} device:  ${collectorDevice}`);
  console.log(`Collector payout wallet: ${payout}`);
  console.log(`Collector RFID tag hash: ${tagHash}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
