// Typings for @mstblockchain/mst-sdk@1.0.0 (the package ships none).
declare module "@mstblockchain/mst-sdk" {
  import type { ethers } from "ethers";

  class Provider {
    constructor(rpcUrl: string);
    rpcUrl: string;
    ethersProvider: ethers.JsonRpcProvider;
    getBlockNumber(): Promise<number>;
    getBalance(address: string): Promise<bigint>;
    getTransactionReceipt(hash: string): Promise<ethers.TransactionReceipt | null>;
    waitForTransaction(hash: string): Promise<ethers.TransactionReceipt | null>;
    estimateGas(tx: ethers.TransactionRequest): Promise<number>;
  }

  class Signer {
    constructor(privateKey: string, provider: Provider);
    static createRandom(provider: Provider): Signer;
    provider: Provider;
    ethersWallet: ethers.Wallet;
    address: string;
    getPrivateKey(): string;
    getAddress(): Promise<string>;
    /** Signs and broadcasts; resolves to the transaction hash. */
    sendTransaction(tx: ethers.TransactionRequest): Promise<string>;
    sendNative(to: string, amount: string | bigint): Promise<string>;
    sendToken(tokenAddress: string, to: string, amount: string | bigint): Promise<string>;
    deploy(abi: unknown[], bytecode: string, args?: unknown[]): Promise<string>;
    estimateGas(method: "sendNative" | "sendToken" | "deploy", args: unknown[]): Promise<number>;
  }

  class Client {
    constructor(rpcUrl: string, privateKey?: string | null);
    static createRandom(rpcUrl: string): Client;
    provider: Provider;
    signer?: Signer;
  }

  const Constants: { CHAINS: { MAINNET: number; TESTNET: number }; DEFAULT_RPC_URL: string; GAS_LIMIT: number };

  const sdk: { Client: typeof Client; Provider: typeof Provider; Signer: typeof Signer; Constants: typeof Constants };
  export default sdk;
  export { Client, Provider, Signer, Constants };
}
