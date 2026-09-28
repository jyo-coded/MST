import crypto from "node:crypto";
import { ethers } from "ethers";
import { config } from "./config";

/**
 * Device keys held by the gateway. Used by the simulator, and by "gateway"
 * signing mode as a hackathon fallback when on-device ECDSA isn't ready.
 * In "device" mode the real keys live on the ESP32s and these can be unset.
 */
export const deviceWallets = {
  bin: config.keys.binDevice ? new ethers.Wallet(config.keys.binDevice) : null,
  collector: config.keys.collectorDevice ? new ethers.Wallet(config.keys.collectorDevice) : null,
  rogue: config.keys.rogueCollectorDevice ? new ethers.Wallet(config.keys.rogueCollectorDevice) : null,
};

export function requireDeviceWallet(kind: "bin" | "collector"): ethers.Wallet {
  const w = deviceWallets[kind];
  if (!w) {
    throw new Error(
      `${kind === "bin" ? "BIN_DEVICE_PRIVATE_KEY" : "COLLECTOR_DEVICE_PRIVATE_KEY"} is not set; ` +
        "gateway signing and the simulator need it (run `npm run keys`).",
    );
  }
  return w;
}

/** Shared-secret check for ESP32 HTTP calls (constant-time). */
export function deviceTokenOk(token: string | undefined): boolean {
  if (!token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(config.server.deviceToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
