import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config";

export type SessionUser = { id: string; name: string; role: "officer" | "admin" | "worker"; workerId?: string | null };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const got = crypto.scryptSync(password, salt, 32);
  const want = Buffer.from(hash, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const sign = (payload: string) => crypto.createHmac("sha256", config.auth.secret).update(payload).digest("base64url");

export function issueToken(user: SessionUser, ttlHours = 24): string {
  const payload = b64(JSON.stringify({ ...user, exp: Date.now() + ttlHours * 3600_000 }));
  return `${payload}.${sign(payload)}`;
}

export function readToken(token: string | undefined): SessionUser | null {
  if (!token) return null;
  const [payload, mac] = token.split(".");
  if (!payload || !mac) return null;
  const expected = sign(payload);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const data = JSON.parse(Buffer.from(payload, "base64url").toString());
  if (data.exp < Date.now()) return null;
  return { id: data.id, name: data.name, role: data.role, workerId: data.workerId ?? null };
}

declare module "express-serve-static-core" {
  interface Request {
    user?: SessionUser;
    rawBody?: Buffer;
  }
}

export function authenticate(req: Request, _res: Response, next: NextFunction) {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : (req.query.token as string | undefined);
  req.user = readToken(token) ?? undefined;
  next();
}

export function requireRole(...roles: SessionUser["role"][]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required" });
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: `Requires ${roles.join(" or ")}` });
    next();
  };
}
