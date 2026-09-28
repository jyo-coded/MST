import { config, deviceSecret, deviceWallet, loadCity } from "../src/config";

/**
 * Prints the values to paste into firmware/smart_bin/secrets.h for one bin.
 *   npm run device -- BIN-001 [http://192.168.1.20:8080]
 */
const binId = (process.argv[2] ?? "BIN-001").toUpperCase();
const server = process.argv[3] ?? `http://<your-laptop-ip>:${config.port}`;
const bin = loadCity().bins.find((b) => b.id === binId);
if (!bin) {
  console.error(`Unknown bin ${binId}`);
  process.exit(1);
}
console.log(`
// firmware/smart_bin/secrets.h — ${bin.name}
#pragma once
#define WIFI_SSID      "your-wifi"
#define WIFI_PASSWORD  "your-password"
#define SERVER_URL     "${server}"
#define BIN_ID         "${binId}"
#define DEVICE_SECRET  "${deviceSecret(binId)}"
#define BIN_DEPTH_CM   ${bin.depthCm}

// On-chain identity of this bin (gateway-custodied key): ${deviceWallet(binId).address}
// Network: ${config.networkLabel} · chain ${config.chainId}
`);
