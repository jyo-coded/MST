import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const BACKEND_DIR = path.join(ROOT_DIR, "backend");
export const DATA_DIR = path.join(BACKEND_DIR, "data");

// CIVICPROOF_ENV lets you keep e.g. .env.local-demo and .env (testnet) side by side.
dotenv.config({ path: process.env.CIVICPROOF_ENV || path.join(ROOT_DIR, ".env") });

type NetworkName = "localhost" | "testnet" | "mainnet";

const NETWORKS: Record<NetworkName, { rpcUrl: string; chainId: number; explorerUrl: string }> = {
  localhost: { rpcUrl: "http://127.0.0.1:8545", chainId: 31337, explorerUrl: "" },
  testnet: {
    rpcUrl: "https://testnetrpc.mstblockchain.com",
    chainId: 91562037,
    explorerUrl: "https://testnet.mstscan.com",
  },
  mainnet: { rpcUrl: "https://mariorpc.mstblockchain.com", chainId: 4646, explorerUrl: "https://mstscan.com" },
};

// Hardhat's well-known dev account #0. Only ever used on a local node.
const HARDHAT_DEV_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

function str(name: string, fallback = ""): string {
  return process.env[name]?.trim() || fallback;
}
function num(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  return v ? Number(v) : fallback;
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v ? v === "true" || v === "1" || v === "yes" : fallback;
}

const requestedNetwork = str("NETWORK", "testnet");
const network: NetworkName = requestedNetwork in NETWORKS ? (requestedNetwork as NetworkName) : "testnet";
const net = NETWORKS[network];

export type Deployment = { network: string; chainId: number; address: string; deployBlock: number; abi: any[] };

export function loadDeployment(): Deployment | null {
  const file = path.join(ROOT_DIR, "deployments", `${network}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export const config = {
  network,
  rpcUrl: network === "localhost" ? net.rpcUrl : str("MST_RPC_URL", net.rpcUrl),
  chainId: network === "localhost" ? net.chainId : num("MST_CHAIN_ID", net.chainId),
  explorerUrl: network === "localhost" ? net.explorerUrl : str("MST_EXPLORER_URL", net.explorerUrl),
  contractAddress: str("CONTRACT_ADDRESS"),

  keys: {
    // On a local node the deployer is always Hardhat account #0, whatever testnet keys .env holds.
    relayer: network === "localhost" ? HARDHAT_DEV_KEY : str("RELAYER_PRIVATE_KEY") || str("ADMIN_PRIVATE_KEY"),
    admin: network === "localhost" ? HARDHAT_DEV_KEY : str("ADMIN_PRIVATE_KEY"),
    guardian: str("GUARDIAN_PRIVATE_KEY"),
    // Device keys are only needed here in "gateway" signing mode and for the simulator.
    // In "device" mode they live on the ESP32s and never touch this server.
    binDevice: str("BIN_DEVICE_PRIVATE_KEY"),
    collectorDevice: str("COLLECTOR_DEVICE_PRIVATE_KEY"),
    // A second, dishonest contractor used by the attack scenarios, so the honest
    // contractor's on-chain track record stays clean across rehearsals.
    rogueCollectorDevice: str("ROGUE_COLLECTOR_DEVICE_PRIVATE_KEY"),
  },

  registry: {
    wardId: BigInt(str("WARD_ID", "12")),
    binId: BigInt(str("BIN_ID", "7")),
    collectorId: BigInt(str("COLLECTOR_ID", "1")),
    collectorRfidUid: str("COLLECTOR_RFID_UID", "A1B2C3D4"),
    rogueCollectorId: BigInt(str("ROGUE_COLLECTOR_ID", "2")),
    rogueCollectorRfidUid: str("ROGUE_COLLECTOR_RFID_UID", "BADC0DE5"),
    supervisorRfidUid: str("SUPERVISOR_RFID_UID"),
    binLitres: num("BIN_LITRES", 10),
    hopperLitres: num("HOPPER_LITRES", 20),
  },

  server: {
    port: num("PORT", 8080),
    deviceSigning: (str("DEVICE_SIGNING", "gateway") === "device" ? "device" : "gateway") as "device" | "gateway",
    deviceToken: str("DEVICE_TOKEN", "change-me"),
    autoAccept: bool("AUTO_ACCEPT", true),
    logIncidentsOnchain: bool("LOG_INCIDENTS_ONCHAIN", true),
    claimWaitMs: num("CLAIM_WAIT_MS", 20000),
  },

  guardian: {
    maxJobsPerBinPerHour: num("MAX_JOBS_PER_BIN_PER_HOUR", 20),
    minServiceSec: num("MIN_SERVICE_SEC", 3),
    maxServiceSec: num("MAX_SERVICE_SEC", 600),
    // AI failure policy: "hold" sends the job to a human; "rules" lets the
    // deterministic rules settle alone but only below smallPayoutMstc.
    aiFailureMode: (str("AI_FAILURE_MODE", "hold") === "rules" ? "rules" : "hold") as "hold" | "rules",
    smallPayoutMstc: str("SMALL_PAYOUT_MSTC", "0.02"),
  },

  verifier: {
    mode: str("VERIFIER_MODE", "heuristic") as "heuristic" | "openai" | "http",
    qwenBaseUrl: str("QWEN_BASE_URL", "http://127.0.0.1:11434/v1"),
    qwenModel: str("QWEN_MODEL", "qwen2.5:7b-instruct"),
    qwenApiKey: str("QWEN_API_KEY"),
    httpUrl: str("VERIFIER_URL"),
    timeoutMs: num("VERIFIER_TIMEOUT_MS", 20000),
  },
};

export type Config = typeof config;

export function explorerTx(hash: string): string | null {
  return config.explorerUrl ? `${config.explorerUrl.replace(/\/$/, "")}/tx/${hash}` : null;
}
export function explorerAddress(address: string): string | null {
  return config.explorerUrl ? `${config.explorerUrl.replace(/\/$/, "")}/address/${address}` : null;
}
