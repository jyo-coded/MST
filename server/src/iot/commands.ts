import { q } from "../db";
import { publish } from "../realtime";

/**
 * Commands for the bin hardware (servo lock/unlock, speaker cues). Real
 * ESP32s receive them in the response to their next telemetry POST (or
 * immediately in the RFID response); simulated bins apply them at once.
 */
export type DeviceCommand = { id: number; type: "UNLOCK_LID" | "LOCK_LID" | "ANNOUNCE"; payload: Record<string, unknown> | null };

const pending = new Map<string, DeviceCommand[]>();
const listeners: ((binId: string, cmd: DeviceCommand) => void)[] = [];

export function onCommand(fn: (binId: string, cmd: DeviceCommand) => void) {
  listeners.push(fn);
}

export async function queueCommand(binId: string, type: DeviceCommand["type"], payload: Record<string, unknown> | null = null) {
  const [row] = await q<DeviceCommand>(
    `INSERT INTO device_commands (bin_id, type, payload) VALUES ($1, $2, $3) RETURNING id, type, payload`,
    [binId, type, payload ? JSON.stringify(payload) : null],
  );
  const list = pending.get(binId) ?? [];
  list.push(row);
  pending.set(binId, list);
  publish("device.command", { binId, ...row });
  for (const fn of listeners) fn(binId, row);
  return row;
}

export async function takeCommands(binId: string): Promise<DeviceCommand[]> {
  const list = pending.get(binId) ?? [];
  pending.delete(binId);
  if (list.length) {
    await q(`UPDATE device_commands SET status = 'delivered', delivered_at = now() WHERE id = ANY($1::int[])`, [list.map((c) => c.id)]);
  }
  return list;
}
