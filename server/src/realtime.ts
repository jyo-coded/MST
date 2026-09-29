import type { Request, Response } from "express";

/**
 * Server-sent events: one stream per browser tab. Every state change in the
 * system is published here, so dashboards update the moment a sensor, a
 * worker or a block does something.
 */
const clients = new Set<Response>();
let seq = 0;

export const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export function publish(type: string, data: unknown) {
  const frame = `id: ${++seq}\nevent: message\ndata: ${json({ type, data, at: new Date().toISOString() })}\n\n`;
  for (const res of clients) res.write(frame);
}

export function stream(req: Request, res: Response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(`retry: 2000\n\n`);
  clients.add(res);
  const ping = setInterval(() => res.write(`: ping\n\n`), 15000);
  req.on("close", () => {
    clearInterval(ping);
    clients.delete(res);
  });
}

export function clientCount() {
  return clients.size;
}
