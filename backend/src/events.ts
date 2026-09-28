import type { Response } from "express";

export type EventLevel = "info" | "success" | "warn" | "danger";

export type CivicEvent = {
  id: number;
  at: string;
  type: string;
  level: EventLevel;
  message: string;
  data?: unknown;
};

const clients = new Set<Response>();
const history: CivicEvent[] = [];
let nextId = 1;

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export function emit(type: string, level: EventLevel, message: string, data?: unknown): CivicEvent {
  const ev: CivicEvent = { id: nextId++, at: new Date().toISOString(), type, level, message, data };
  history.push(ev);
  if (history.length > 300) history.shift();
  const frame = `id: ${ev.id}\ndata: ${JSON.stringify(ev, replacer)}\n\n`;
  for (const res of clients) res.write(frame);
  const tag = level === "danger" ? "✗" : level === "warn" ? "!" : level === "success" ? "✓" : "·";
  console.log(`${tag} [${type}] ${message}`);
  return ev;
}

export function subscribe(res: Response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const ev of history) res.write(`id: ${ev.id}\ndata: ${JSON.stringify(ev, replacer)}\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  res.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export function recentEvents() {
  return history.slice();
}
