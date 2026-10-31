/*
 * render.js - fetch a live page and present it in a real window.
 *
 * This is the entry point that ties the whole pipeline together and is
 * deliberately written the way the requirement asks: fetch the root URL,
 * read the response as text, and hand the HTML to the renderer. Everything
 * after that - stylesheet parsing, font fetching, layout, rasterization -
 * happens inside qnode with no external tools.
 *
 * Usage:
 *   qnode web/render.js                 fetch, render, present, poll until closed
 *   qnode web/render.js --once          render and write a PNG, no window
 *   qnode web/render.js --save out.png  choose the PNG path (default below)
 *
 * Environment:
 *   RENDER_URL   page to fetch (default https://google.com)
 *   RENDER_W     viewport width  (default 800)
 *   RENDER_H     viewport height (default 600)
 */

import fs from "node:fs";
import { renderPage } from "./page.js";
import { encodePNG } from "./png.js";

const args = process.argv.slice(2);
const once = args.includes("--once");
const saveIndex = args.indexOf("--save");
const savePath = saveIndex >= 0 ? args[saveIndex + 1] :
  "/tmp/opencode/render.png";

const url = process.env.RENDER_URL || "https://google.com";
const width = parseInt(process.env.RENDER_W || "800", 10);
const height = parseInt(process.env.RENDER_H || "600", 10);

/**
 * Keep the event loop alive while a promise settles.
 *
 * qnode exits as soon as no handle is active; a pending fetch alone does not
 * count, so the process would silently terminate before the response lands.
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<T>}
 */
function keepAlive(promise) {
  const timer = setInterval(() => {}, 50);
  return promise.finally(() => clearInterval(timer));
}

function log(...parts) {
  console.log("[render]", ...parts);
}

/**
 * Render fetched HTML and present the result.
 * @param {string} html
 * @param {string} docURL URL of the document after redirects
 */
async function render(html, docURL) {
  log("html", html.length + " bytes");

  const result = await renderPage(html, {
    url: docURL,
    width,
    height,
    log,
  });

  log("fonts", result.fonts.faces.length,
      "images", result.images.size,
      "timings", JSON.stringify(result.timings));

  /* Always emit a PNG: it is the artifact that survives the process and the
   * only way to inspect the frame when the window is not visible. */
  const png = encodePNG(result.pixels, width, height);
  fs.writeFileSync(savePath, png);
  log("wrote", savePath, png.length + " bytes");

  const native = globalThis.__qnode_native;
  if (once || !native || typeof native.waylandOpen !== "function") {
    log(once ? "once: skipping window" : "no wayland bindings; skipping window");
    /* Background HTTP connections may still be pooled; the artifact is on
     * disk, so end the process deterministically. */
    process.exit(0);
  }

  /* Present the RGBA framebuffer as XRGB8888. The shm format stores bytes
   * B,G,R,X on little-endian hosts, which is exactly 0x00RRGGBB. */
  const open = native.waylandOpen(null, width, height);
  log("waylandOpen", open);
  if (open !== 0) {
    log("window failed to open");
    process.exit(1);
  }
  const info = native.waylandInfo();
  log("window", info.width + "x" + info.height,
      "monitor", info.monitor.make, info.monitor.model,
      info.monitor.width + "x" + info.monitor.height +
      "@" + info.monitor.refresh,
      "scale", info.monitor.scale);

  const frame = native.allocMemory(width * height * 4);
  const px = new Uint32Array(frame);
  const rgba = result.pixels;
  for (let i = 0, n = width * height; i < n; i++) {
    px[i] = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2];
  }

  const t0 = Date.now();
  const rendered = native.waylandRender(frame);
  log("waylandRender", rendered, "in", Date.now() - t0, "ms");

  /* Stay open until the compositor closes the window. */
  log("presenting; close the window to exit");
  for (;;) {
    const status = native.waylandPoll(250);
    if (status !== 0) {
      log("window closed", status);
      break;
    }
  }
  native.waylandClose();
  process.exit(0);
}

/* The requirement's shape: plain fetch of the root URL. Kernel sockets are
 * used because the userspace netstack cannot reach the public internet in
 * this environment, and a few retries absorb transient resolver failures. */
function fetchRoot() {
  return (async () => {
    let lastError = null;
    for (let i = 0; i < 6; i++) {
      try {
        return await fetch(url, { netstack: false });
      } catch (e) {
        lastError = e;
        log("fetch attempt", i + 1, "failed:", e.message);
        await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
    throw lastError;
  })();
}

keepAlive(
  fetchRoot()
    .then((res) => {
      log("fetch", url, res.status, res.headers.get("content-type") || "");
      if (res.status >= 400)
        throw new Error("HTTP " + res.status + " for " + url);
      return res.text().then((text) => ({ text, docURL: res.url || url }));
    })
    .then(({ text, docURL }) => render(text, docURL))
).catch((err) => {
  console.error("[render] failed:", err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
