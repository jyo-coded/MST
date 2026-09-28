import fs from "node:fs";
import mst from "@mstblockchain/mst-sdk";
import { ethers } from "ethers";
import { deploymentFile, type Deployment } from "../src/chain/ledger";
import { config, explorerTx } from "../src/config";

const { Client } = mst;

export function adminClient() {
  if (!config.keys.admin) throw new Error("ADMIN_PRIVATE_KEY is not set. Run `npm run keys -- --write` and fund it from https://faucet.masterstroke.academy");
  return new Client(config.rpcUrl, config.keys.admin);
}

export function link(hash: string) {
  return explorerTx(hash) ?? hash;
}

export function readDeploymentFile(): (Deployment & { setupTxs?: { hash: string; action: string; method: string }[] }) | null {
  const f = deploymentFile();
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}

export function writeDeploymentFile(d: object) {
  const f = deploymentFile();
  fs.mkdirSync(f.replace(/[^/\\]+$/, ""), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
}

export const fmt = (wei: bigint) => `${Number(ethers.formatEther(wei)).toFixed(4)} MSTC`;
