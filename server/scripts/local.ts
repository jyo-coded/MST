import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "../src/config";

/**
 * One command for an offline rehearsal: starts a local EVM node (if none is
 * running), deploys + configures the ledger, then starts the server.
 * Everything is real (real transactions, real receipts) on a local chain.
 * For MST Testnet use: npm run deploy && npm run setup && npm start
 */
const env = { ...process.env, NETWORK: "localhost" };
const rpc = "http://127.0.0.1:8545";
// Windows needs a shell to run npx (npx.cmd).
const shell = process.platform === "win32";

async function rpcUp() {
  try {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
    return r.ok;
  } catch {
    return false;
  }
}

async function codeAt(address: string) {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }) });
  return ((await r.json()) as any).result as string;
}

async function main() {
  if (!(await rpcUp())) {
    console.log("Starting local EVM node (Hardhat) on :8545 …");
    const log = fs.openSync(path.join(ROOT_DIR, "server", "data", "chain.log"), "a");
    const node = spawn("npx", ["hardhat", "node"], { cwd: path.join(ROOT_DIR, "contracts"), stdio: ["ignore", log, log], env, shell });
    process.on("exit", () => node.kill());
    for (let i = 0; i < 60 && !(await rpcUp()); i++) await new Promise((r) => setTimeout(r, 500));
    if (!(await rpcUp())) throw new Error("local node did not start (see server/data/chain.log)");
  }
  const depFile = path.join(ROOT_DIR, "deployments", "localhost.json");
  const needsDeploy = !fs.existsSync(depFile) || (await codeAt(JSON.parse(fs.readFileSync(depFile, "utf8")).address)) === "0x";
  const tsx = (script: string) => {
    const r = spawnSync("npx", ["tsx", script], { cwd: path.join(ROOT_DIR, "server"), stdio: "inherit", env, shell });
    if (r.status !== 0) process.exit(r.status ?? 1);
  };
  if (needsDeploy) tsx("scripts/deploy.ts");
  tsx("scripts/setup.ts");
  if (!fs.existsSync(path.join(ROOT_DIR, "web", "dist", "index.html"))) {
    console.log("Building the dashboard …");
    const r = spawnSync("npm", ["run", "build", "-w", "web"], { cwd: ROOT_DIR, stdio: "inherit", env, shell });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  const server = spawn("npx", ["tsx", "src/main.ts"], { cwd: path.join(ROOT_DIR, "server"), stdio: "inherit", env, shell });
  server.on("exit", (code) => process.exit(code ?? 0));
}

fs.mkdirSync(path.join(ROOT_DIR, "server", "data"), { recursive: true });
main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
