import { Router } from "express";
import {
  checkAdminPassword,
  issueAdminToken,
  verifyAdminToken,
  ADMIN_COOKIE_NAME,
  ADMIN_COOKIE_MAX_AGE_MS,
} from "../middlewares/admin-auth";

const router = Router();

const isProd = process.env["NODE_ENV"] === "production";

router.post("/admin/login", (req, res) => {
  const { password } = (req.body ?? {}) as { password?: string };
  if (!checkAdminPassword(password)) {
    res.status(401).json({ ok: false, error: "Invalid password" });
    return;
  }
  const token = issueAdminToken();
  res.cookie(ADMIN_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: "lax",
    maxAge: ADMIN_COOKIE_MAX_AGE_MS,
    path: "/",
  });
  res.json({ ok: true });
});

router.post("/admin/logout", (req, res) => {
  res.clearCookie(ADMIN_COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

router.get("/admin/me", (req, res) => {
  const token = (req as typeof req & { cookies?: Record<string, string> }).cookies?.[
    ADMIN_COOKIE_NAME
  ];
  res.json({ authed: verifyAdminToken(token) });
});

export default router;
