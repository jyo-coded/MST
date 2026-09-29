import assert from "node:assert/strict";
import { test } from "node:test";
import { ethers } from "ethers";
import { normalizeUid, rfidHash } from "../src/config";

test("rfid hash is keyed: it is not the plain keccak of the UID, so 4-byte UIDs can't be brute-forced from chain data", () => {
  const plain = ethers.keccak256(ethers.toUtf8Bytes("A1B2C3D4"));
  assert.notEqual(rfidHash("A1B2C3D4"), plain);
  assert.match(rfidHash("A1B2C3D4"), /^0x[0-9a-f]{64}$/);
});

test("rfid hash is stable, UID-format independent, and distinct per card", () => {
  assert.equal(rfidHash("A1B2C3D4"), rfidHash("a1:b2:c3:d4"));
  assert.equal(normalizeUid("a1 b2-c3:d4"), "A1B2C3D4");
  assert.notEqual(rfidHash("A1B2C3D4"), rfidHash("A1B2C3D5"));
});
