// Centralised API base URL.
//
// In Replit (or any same-domain deploy) leave `VITE_API_BASE_URL` unset and
// the frontend falls back to the artifact's base path + `/api`, so all
// requests stay relative.
//
// When the frontend is hosted separately (e.g. Cloudflare Pages / Vercel /
// Netlify) and the API runs on its own host (Fly / Railway / VPS), set
// `VITE_API_BASE_URL=https://api.example.com` at *build time* on the frontend
// host. All `apiUrl()` callers will then issue cross-origin requests, which
// the API's CORS allowlist (see `CORS_ORIGIN` env on the server) must accept.
const RAW = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "";
const REMOTE = RAW.replace(/\/+$/, "");

export const API_BASE = REMOTE
  ? `${REMOTE}/api`
  : `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;

export function apiUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${p}`;
}
