import "@nomicfoundation/hardhat-toolbox";
import { HardhatUserConfig } from "hardhat/config";
import * as dotenv from "dotenv";
import path from "node:path";

// All secrets live in the repo-root .env (see .env.example).
dotenv.config({ path: process.env.ASTRA_ENV || path.resolve(__dirname, "../.env") });

const ADMIN_PRIVATE_KEY = process.env.ADMIN_PRIVATE_KEY;
const accounts = ADMIN_PRIVATE_KEY ? [ADMIN_PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // "paris" avoids the PUSH0 opcode so bytecode runs on EVM chains that
      // have not enabled Shanghai. Safe default for MST testnet/mainnet.
      evmVersion: "paris",
    },
  },
  networks: {
    // `npm run chain`: a local rehearsal chain. Interval mining keeps
    // block.timestamp moving like a live network, so device timestamps are
    // judged against the current time, not the last transaction.
    hardhat: {
      mining: { auto: true, interval: 3000 },
    },
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    testnet: {
      url: process.env.MST_RPC_URL || "https://testnetrpc.mstblockchain.com",
      chainId: 91562037,
      accounts,
    },
    mainnet: {
      url: "https://mariorpc.mstblockchain.com",
      chainId: 4646,
      accounts,
    },
  },
};

export default config;
