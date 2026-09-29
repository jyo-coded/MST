import { ethers } from "ethers";
import { LEDGER_ABI, LEDGER_BYTECODE } from "../src/chain/ledger";
import { config } from "../src/config";
import { adminClient, fmt, link, writeDeploymentFile } from "./common";

/** Deploys WasteCollectionLedger through the MST SDK (Signer.deploy). */
async function main() {
  const client = adminClient();
  const admin = client.signer!.address;
  const [chainId, balance] = await Promise.all([client.provider.ethersProvider.getNetwork().then((n) => Number(n.chainId)), client.provider.getBalance(admin)]);
  console.log(`\nNetwork   ${config.networkLabel} (chain ${chainId}) ${config.rpcUrl}`);
  console.log(`Admin     ${admin}  ${fmt(balance)}`);
  if (chainId !== config.chainId) throw new Error(`RPC reports chain ${chainId}, expected ${config.chainId}`);
  if (balance === 0n) throw new Error("Admin wallet has no MSTC. Use https://faucet.masterstroke.academy");

  const policy = {
    minFillPct: Number(process.env.MIN_FILL_PCT ?? 80),
    minFillRemoved: Number(process.env.MIN_FILL_REMOVED ?? 50),
    minConfidenceBps: Math.round(config.ai.minConfidence * 100),
    maxClockSkew: 300,
    maxReportAge: 3600,
    maxPayout: ethers.parseEther(process.env.MAX_PAYOUT_MSTC ?? "0.2"),
  };

  const hash = await client.signer!.deploy(LEDGER_ABI, LEDGER_BYTECODE, [admin, policy]);
  console.log(`Deploying WasteCollectionLedger… ${link(hash)}`);
  const receipt = await client.provider.waitForTransaction(hash);
  if (!receipt?.contractAddress) throw new Error("Deployment failed");
  console.log(`Deployed  ${receipt.contractAddress} (block ${receipt.blockNumber})`);

  writeDeploymentFile({
    network: config.network,
    chainId,
    address: receipt.contractAddress,
    deployBlock: receipt.blockNumber,
    deployTx: hash,
    deployer: admin,
    deployedAt: new Date().toISOString(),
    setupTxs: [],
  });
  console.log(`\nWrote deployments/${config.network}.json. Next: npm run setup\n`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
