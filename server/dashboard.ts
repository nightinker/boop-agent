import express from "express";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Serves the built dashboard (`npm run dashboard:build` → debug/dist) from
 * Boop itself, for servers where no Vite dev server runs. Requests only get
 * here after the access check in index.ts, so the dashboard is as private as
 * the API. On the Mac nothing is built, and the Vite dev server serves it.
 */
export function dashboardDir(root = process.cwd()): string | null {
  const dir = resolve(root, "debug", "dist");
  return existsSync(join(dir, "index.html")) ? dir : null;
}

export function mountDashboard(app: express.Express, dir = dashboardDir()): void {
  if (!dir) return;
  console.log(`[dashboard] serving ${dir}`);
  app.use(express.static(dir, { index: "index.html", maxAge: "1h" }));
  // Client-side routes: any other page request gets the app shell.
  app.use((req, res, next) => {
    // Page loads ask for text/html; API calls via fetch() don't, and keep
    // their 404 for unknown paths.
    if (req.method !== "GET" || !req.headers.accept?.includes("text/html")) {
      next();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(join(dir, "index.html"));
  });
}
