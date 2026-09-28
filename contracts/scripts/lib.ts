import fs from "node:fs";
import path from "node:path";
import hre, { ethers } from "hardhat";

export const DEPLOYMENTS_DIR = path.resolve(__dirname, "../../deployments");

export type Deployment = {
  network: string;
  chainId: number;
  address: string;
  deployBlock: number;
  admin: string;
  treasury: string;
  relayer: string;
  guardian: string;
  deployedAt: string;
  abi: unknown;
};

export function deploymentPath(network: string) {
  return path.join(DEPLOYMENTS_DIR, `${network}.json`);
}

export function readDeployment(network: string): Deployment {
  const file = deploymentPath(network);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment at ${file}. Run \`npm run deploy:${network === "localhost" ? "local" : network}\` first.`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeDeployment(d: Deployment) {
  fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  fs.writeFileSync(deploymentPath(d.network), JSON.stringify(d, null, 2) + "\n");
}

export function env(name: string, fallback?: string): string {
  const v = process.env[name]?.trim();
  if (v) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing ${name} in .env (see .env.example)`);
}

/** Address for a key-or-address env pair, e.g. GUARDIAN_PRIVATE_KEY / GUARDIAN_ADDRESS. */
export function addressFromEnv(prefix: string, fallback?: string): string {
  const pk = process.env[`${prefix}_PRIVATE_KEY`]?.trim();
  if (pk) return new ethers.Wallet(pk).address;
  const addr = process.env[`${prefix}_ADDRESS`]?.trim();
  if (addr) return ethers.getAddress(addr);
  if (fallback) return fallback;
  throw new Error(`Set ${prefix}_PRIVATE_KEY or ${prefix}_ADDRESS in .env (run \`npm run keys\`)`);
}

/** RFID UIDs are hashed exactly like the ESP32 does: keccak256 of the uppercase hex string. */
export function rfidTagHash(uid: string) {
  return ethers.keccak256(ethers.toUtf8Bytes(uid.replace(/[^0-9a-fA-F]/g, "").toUpperCase()));
}

export function explorerTx(hash: string) {
  if (hre.network.name === "localhost" || hre.network.name === "hardhat") return hash;
  const base =
    process.env.MST_EXPLORER_URL || (hre.network.name === "mainnet" ? "https://mstscan.com" : "https://testnet.mstscan.com");
  return `${base.replace(/\/$/, "")}/tx/${hash}`;
}
