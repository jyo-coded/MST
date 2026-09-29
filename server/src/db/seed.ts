import { ethers } from "ethers";
import { hashPassword } from "../auth";
import { idBytes, ledger, readDeployment, type DecodedEvent } from "../chain/ledger";
import { config, deviceWallet, loadCity, rfidHash, workerWallet } from "../config";
import { getSetting, one, q, setSetting } from "./index";

const SENSORS: [string, string][] = [
  ["ultrasonic_primary", "HC-SR04 ultrasonic (lid-mounted)"],
  ["ultrasonic_secondary", "HC-SR04 ultrasonic (side-mounted)"],
  ["ir_mouth", "IR obstacle sensor (deposit counter)"],
  ["lid_switch", "IR reflective sensor (lid position)"],
  ["servo", "SG90 servo lid lock"],
  ["rfid_reader", "MFRC522 13.56 MHz RFID reader"],
];

/** Inserts or refreshes the city: municipality, bins, sensors, workers and users. */
export async function seed() {
  const city = loadCity();
  const m = city.municipality;
  await q(
    `INSERT INTO municipalities (id, name, city, ward, center_lat, center_lng) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, city = EXCLUDED.city, ward = EXCLUDED.ward,
       center_lat = EXCLUDED.center_lat, center_lng = EXCLUDED.center_lng`,
    [m.id, m.name, m.city, m.ward, m.center.lat, m.center.lng],
  );

  for (const b of city.bins) {
    const device = deviceWallet(b.id).address;
    await q(
      `INSERT INTO bins (id, municipality_id, name, address, zone, lat, lng, capacity_litres, depth_cm, hardware, device_address, fill_pct, fill2_pct, distance_cm, last_heartbeat)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13, now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, address = EXCLUDED.address, zone = EXCLUDED.zone, lat = EXCLUDED.lat,
         lng = EXCLUDED.lng, capacity_litres = EXCLUDED.capacity_litres, depth_cm = EXCLUDED.depth_cm,
         hardware = EXCLUDED.hardware, device_address = EXCLUDED.device_address`,
      [b.id, m.id, b.name, b.address, b.zone, b.lat, b.lng, b.capacityLitres, b.depthCm, !!b.hardware, device, b.startFill, b.depthCm * (1 - b.startFill / 100)],
    );
    for (const [kind, model] of SENSORS) {
      await q(`INSERT INTO sensors (bin_id, kind, model) VALUES ($1,$2,$3) ON CONFLICT (bin_id, kind) DO NOTHING`, [b.id, kind, model]);
    }
  }

  for (const w of city.workers) {
    await q(
      `INSERT INTO workers (id, municipality_id, name, phone, zone, rfid_uid, rfid_hash, wallet_address, lat, lng, home_lat, home_lng, location_updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$9,$10, now())
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, zone = EXCLUDED.zone, rfid_uid = EXCLUDED.rfid_uid,
         rfid_hash = EXCLUDED.rfid_hash, wallet_address = EXCLUDED.wallet_address, home_lat = EXCLUDED.home_lat, home_lng = EXCLUDED.home_lng`,
      [w.id, m.id, w.name, w.phone, w.zone, w.rfidUid.toUpperCase(), rfidHash(w.rfidUid), workerWallet(w.id), w.lat, w.lng],
    );
    const userId = `USR-${w.id}`;
    if (!(await one(`SELECT id FROM users WHERE id = $1`, [userId]))) {
      await q(`INSERT INTO users (id, municipality_id, name, role, worker_id, password_hash) VALUES ($1,$2,$3,'worker',$4,$5)`, [
        userId,
        m.id,
        w.name,
        w.id,
        hashPassword(config.auth.workerPin),
      ]);
    }
  }

  for (const u of city.users) {
    if (!(await one(`SELECT id FROM users WHERE id = $1`, [u.id]))) {
      await q(`INSERT INTO users (id, municipality_id, name, email, role, password_hash) VALUES ($1,$2,$3,$4,$5,$6)`, [
        u.id,
        m.id,
        u.name,
        u.email,
        u.role,
        hashPassword(config.auth.officerPassword),
      ]);
    }
  }
}

/**
 * Binds the database to the deployed ledger. A new deployment means a fresh
 * workflow history (old rows would reference transactions on another
 * contract), so workflow tables are cleared while the city stays.
 */
export async function bindLedger() {
  const d = readDeployment();
  if (!d) return;
  const bound = await getSetting<string | null>("ledger.address", null);
  const key = `${config.network}:${d.address}`;
  if (bound && bound !== key) {
    console.log(`  ! ledger changed (${bound} → ${key}); clearing workflow history`);
    await clearWorkflow();
  }
  await setSetting("ledger.address", key);
  await importSetupTransactions();
  await refreshRegistration();
}

export async function clearWorkflow() {
  for (const t of [
    "lifecycle_events",
    "notifications",
    "payments",
    "rfid_events",
    "collection_events",
    "assignments",
    "ai_verifications",
    "device_commands",
  ]) {
    await q(`DELETE FROM ${t}`);
  }
  await q(`DELETE FROM collection_requests`);
  await q(`DELETE FROM blockchain_transactions`);
  await q(`UPDATE bins SET status = 'NORMAL', rfid_state = 'idle', servo_state = 'locked', lid_state = 'closed', device_nonce = 0`);
  await q(`UPDATE workers SET status = 'AVAILABLE', completed_count = 0, rejected_count = 0, lat = home_lat, lng = home_lng`);
}

/** Pulls the setup script's transactions (deploy, roles, registration, funding) into the audit log. */
async function importSetupTransactions() {
  const d = readDeployment() as any;
  const txs: { hash: string; action: string; method: string }[] = [
    ...(d.deployTx ? [{ hash: d.deployTx, action: "DEPLOYMENT", method: "constructor" }] : []),
    ...(d.setupTxs ?? []),
  ];
  const L = ledger();
  for (const t of txs) {
    if (await one(`SELECT id FROM blockchain_transactions WHERE hash = $1`, [t.hash])) continue;
    try {
      const [tx, receipt] = await Promise.all([L.provider.getTransaction(t.hash), L.provider.getTransactionReceipt(t.hash)]);
      if (!tx || !receipt) continue;
      const events: DecodedEvent[] = L.parseLogs(receipt.logs);
      const block = await L.provider.getBlock(receipt.blockNumber);
      await q(
        `INSERT INTO blockchain_transactions (hash, action, method, from_address, to_address, value_wei, status, signer_kind, block_number,
           gas_used, effective_gas_price, fee_wei, network, chain_id, events, created_at, confirmed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'admin',$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
        [
          t.hash,
          t.action,
          t.method,
          tx.from,
          tx.to ?? receipt.contractAddress,
          tx.value > 0n ? tx.value.toString() : null,
          receipt.status === 1 ? "CONFIRMED" : "FAILED",
          receipt.blockNumber,
          receipt.gasUsed.toString(),
          receipt.gasPrice.toString(),
          receipt.fee.toString(),
          config.networkLabel,
          config.chainId,
          JSON.stringify(events),
          new Date(Number(block?.timestamp ?? Math.floor(Date.now() / 1000)) * 1000),
        ],
      );
    } catch (err) {
      console.warn(`  ! could not import setup tx ${t.hash}: ${(err as Error).message}`);
    }
  }
}

/** Marks which bins and workers the ledger actually knows about. */
export async function refreshRegistration() {
  const L = ledger();
  for (const b of await q(`SELECT id, device_address FROM bins`)) {
    try {
      const onchain = await L.contract.getBin(idBytes(b.id));
      await q(`UPDATE bins SET on_chain = $2 WHERE id = $1`, [b.id, onchain.device.toLowerCase() === b.device_address.toLowerCase()]);
    } catch {
      /* chain unreachable */
    }
  }
  for (const w of await q(`SELECT id, wallet_address FROM workers`)) {
    try {
      const onchain = await L.contract.getWorker(idBytes(w.id));
      await q(`UPDATE workers SET on_chain = $2 WHERE id = $1`, [w.id, onchain.wallet.toLowerCase() === w.wallet_address.toLowerCase()]);
    } catch {
      /* chain unreachable */
    }
  }
  void ethers;
}
