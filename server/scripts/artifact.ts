import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR, SERVER_DIR } from "../src/config";

/**
 * Copies the compiled ledger (ABI + bytecode) into the server so deployment
 * through the MST SDK needs no Solidity toolchain. Run after `npm run compile`.
 */
const src = path.join(ROOT_DIR, "contracts/artifacts/contracts/WasteCollectionLedger.sol/WasteCollectionLedger.json");
const dst = path.join(SERVER_DIR, "src/chain/WasteCollectionLedger.json");
const artifact = JSON.parse(fs.readFileSync(src, "utf8"));
fs.writeFileSync(dst, JSON.stringify({ contractName: artifact.contractName, abi: artifact.abi, bytecode: artifact.bytecode }, null, 1) + "\n");
console.log(`✓ wrote ${path.relative(ROOT_DIR, dst)} (${artifact.abi.length} ABI entries, ${(artifact.bytecode.length - 2) / 2} bytes)`);
