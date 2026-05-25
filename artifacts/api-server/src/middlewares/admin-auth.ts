import type { Request, Response, NextFunction, RequestHandler } from "express";
import crypto from "node:crypto";

const SESSION_SECRET = process.env["SESSION_SECRET"] ?? "";
const ADMIN_PASSWORD = process.env["ADMIN_PASSWORD"] ?? "";
const COOKIE_NAME = "admin_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sign(payload: string): string {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("hex");
}

export function issueAdminToken(): string {
  const expires = Date.now() + SESSION_TTL_MS;
  const payload = `admin.${expires}`;
  return `${payload}.${sign(payload)}`;
}

export function verifyAdminToken(token: string | undefined): boolean {
  if (!token || !SESSION_SECRET) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [role, expiresStr, sig] = parts as [string, string, string];
  if (role !== "admin") return false;
  const expires = Number(expiresStr);
  if (!Number.isFinite(expires) || expires < Date.now()) return false;
  const expected = sign(`${role}.${expiresStr}`);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function checkAdminPassword(input: string | undefined): boolean {
  if (!input || !ADMIN_PASSWORD) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(ADMIN_PASSWORD);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export const requireAdmin: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME];
  if (verifyAdminToken(token)) {
    next();
    return;
  }
  res.status(401).json({ error: "unauthorized" });
};

export const ADMIN_COOKIE_NAME = COOKIE_NAME;
export const ADMIN_COOKIE_MAX_AGE_MS = SESSION_TTL_MS;
