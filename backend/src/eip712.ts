import { ethers, type TypedDataDomain, type TypedDataField } from "ethers";

/**
 * Typed messages signed by the machines. These MUST match the typehashes in
 * contracts/contracts/CivicProofVault.sol and firmware/common/civicproof_sign.c.
 */
export const TYPES = {
  HireRequest: [
    { name: "binId", type: "uint256" },
    { name: "fillLevel", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
  AcceptJob: [
    { name: "jobId", type: "uint256" },
    { name: "collectorId", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
  ServiceEvidence: [
    { name: "jobId", type: "uint256" },
    { name: "binId", type: "uint256" },
    { name: "tagHash", type: "bytes32" },
    { name: "fillBefore", type: "uint256" },
    { name: "fillAfter", type: "uint256" },
    { name: "serviceStart", type: "uint256" },
    { name: "serviceEnd", type: "uint256" },
    { name: "rawDataHash", type: "bytes32" },
  ],
  CollectorClaim: [
    { name: "jobId", type: "uint256" },
    { name: "collectorId", type: "uint256" },
    { name: "hopperBefore", type: "uint256" },
    { name: "hopperAfter", type: "uint256" },
    { name: "rawDataHash", type: "bytes32" },
  ],
  GuardianApproval: [
    { name: "jobId", type: "uint256" },
    { name: "evidenceDigest", type: "bytes32" },
    { name: "claimDigest", type: "bytes32" },
    { name: "payout", type: "uint256" },
    { name: "confidence", type: "uint256" },
    { name: "reportHash", type: "bytes32" },
  ],
} satisfies Record<string, TypedDataField[]>;

export type TypeName = keyof typeof TYPES;

export type HireRequest = { binId: bigint; fillLevel: bigint; nonce: bigint; expiry: bigint };
export type AcceptJob = { jobId: bigint; collectorId: bigint; expiry: bigint };
export type ServiceEvidence = {
  jobId: bigint;
  binId: bigint;
  tagHash: string;
  fillBefore: bigint;
  fillAfter: bigint;
  serviceStart: bigint;
  serviceEnd: bigint;
  rawDataHash: string;
};
export type CollectorClaim = {
  jobId: bigint;
  collectorId: bigint;
  hopperBefore: bigint;
  hopperAfter: bigint;
  rawDataHash: string;
};
export type GuardianApproval = {
  jobId: bigint;
  evidenceDigest: string;
  claimDigest: string;
  payout: bigint;
  confidence: bigint;
  reportHash: string;
};

export function makeDomain(chainId: number | bigint, verifyingContract: string): TypedDataDomain {
  return { name: "CivicProof", version: "1", chainId, verifyingContract };
}

const single = (t: TypeName) => ({ [t]: TYPES[t] });

export function typedDigest(domain: TypedDataDomain, type: TypeName, value: Record<string, unknown>): string {
  return ethers.TypedDataEncoder.hash(domain, single(type), value);
}

export function signTyped(
  wallet: ethers.Wallet | ethers.HDNodeWallet,
  domain: TypedDataDomain,
  type: TypeName,
  value: Record<string, unknown>,
): Promise<string> {
  return wallet.signTypedData(domain, single(type), value);
}

export function typeHash(type: TypeName): string {
  return ethers.id(ethers.TypedDataEncoder.from(single(type)).encodeType(type));
}

const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");

/**
 * Accepts a signature from a device and returns a canonical 65-byte
 * Ethereum signature that recovers to `expected`, or null.
 *
 * Small ECDSA libraries on the ESP32 (micro-ecc) produce only r||s (64
 * bytes) with no recovery id and possibly a high s. Neither is a security
 * issue: we normalise s to the lower half-order (as OpenZeppelin requires)
 * and try both recovery ids. A wrong guess recovers a different address, so
 * the relayer cannot forge anything by picking v.
 */
export function normaliseDeviceSignature(digest: string, signature: string, expected: string): string | null {
  const bytes = ethers.getBytes(signature);
  if (bytes.length !== 64 && bytes.length !== 65) return null;
  const r = ethers.hexlify(bytes.slice(0, 32));
  let s = BigInt(ethers.hexlify(bytes.slice(32, 64)));
  if (s === 0n || s >= SECP256K1_N) return null;
  if (s > SECP256K1_N / 2n) s = SECP256K1_N - s;
  const sHex = ethers.toBeHex(s, 32);

  for (const v of [27, 28]) {
    try {
      const sig = ethers.Signature.from({ r, s: sHex, v });
      if (ethers.recoverAddress(digest, sig).toLowerCase() === expected.toLowerCase()) return sig.serialized;
    } catch {
      // try the other recovery id
    }
  }
  return null;
}

/** RFID UIDs are hashed exactly like the ESP32 does: keccak256 of the uppercase hex string. */
export function rfidTagHash(uid: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(uid.replace(/[^0-9a-fA-F]/g, "").toUpperCase()));
}

/** Raw sensor logs are committed to by keccak256 of their exact UTF-8 bytes. */
export function rawDataHash(csv: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(csv));
}
