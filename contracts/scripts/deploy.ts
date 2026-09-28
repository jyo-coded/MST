import hre, { ethers } from "hardhat";
import { addressFromEnv, explorerTx, writeDeployment } from "./lib";

async function main() {
  const network = hre.network.name;
  const [admin] = await ethers.getSigners();
  if (!admin) throw new Error("No deployer account. Set ADMIN_PRIVATE_KEY in .env (fund it at https://faucet.masterstroke.academy).");

  const { chainId } = await ethers.provider.getNetwork();
  const balance = await ethers.provider.getBalance(admin.address);
  console.log(`\nNetwork   ${network} (chainId ${chainId})`);
  console.log(`Admin     ${admin.address}  balance ${ethers.formatEther(balance)} MSTC`);
  if (balance === 0n) throw new Error("Admin wallet has 0 MSTC. Use the faucet first.");

  const treasury = process.env.TREASURY_ADDRESS?.trim() || admin.address;
  const local = network === "localhost" || network === "hardhat";
  // Locally the gateway relays with Hardhat account #0 (the deployer).
  const relayer = local ? admin.address : addressFromEnv("RELAYER", admin.address);
  const guardian = addressFromEnv("GUARDIAN");

  const Vault = await ethers.getContractFactory("CivicProofVault");
  const vault = await Vault.deploy(admin.address, treasury);
  const deployTx = vault.deploymentTransaction()!;
  console.log(`Deploying CivicProofVault… ${explorerTx(deployTx.hash)}`);
  const receipt = await deployTx.wait();
  const address = await vault.getAddress();
  console.log(`Deployed  ${address} (block ${receipt!.blockNumber})`);

  const operatorRole = await vault.OPERATOR_ROLE();
  const guardianRole = await vault.GUARDIAN_ROLE();
  await (await vault.grantRole(operatorRole, relayer)).wait();
  console.log(`OPERATOR_ROLE -> relayer  ${relayer}`);
  await (await vault.grantRole(guardianRole, guardian)).wait();
  console.log(`GUARDIAN_ROLE -> guardian ${guardian}`);

  const artifact = await hre.artifacts.readArtifact("CivicProofVault");
  writeDeployment({
    network,
    chainId: Number(chainId),
    address,
    deployBlock: receipt!.blockNumber,
    admin: admin.address,
    treasury,
    relayer,
    guardian,
    deployedAt: new Date().toISOString(),
    abi: artifact.abi,
  });
  console.log(`\nWrote deployments/${network}.json`);
  console.log(`Next: npm run setup:${network === "localhost" ? "local" : network}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
