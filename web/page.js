/*
 * page.js - turn an HTML document into a rendered framebuffer.
 *
 * This mirrors what a browser does for a static page: parse markup, collect
 * author styles (inline <style> and linked stylesheets), download the fonts
 * the page asks for and the images it references, resolve the cascade, lay
 * out the box tree and rasterize it.
 *
 * Networking uses the engine's own fetch implementation with kernel sockets
 * (netstack: false), so the renderer works with the host's real network.
 */

import fs from "node:fs";
import { parseHTML, walkElements, textContent } from "./html.js";
import { parseStylesheet } from "./css.js";
import { buildBoxTree, layoutDocument } from "./layout.js";
import { paintDocument } from "./paint.js";
import { decodePNG } from "./png.js";
import { FontBook } from "./ttf.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * HTTP GET with a few retries. qnode's resolver occasionally comes up late,
 * and third-party hosts transiently refuse; retrying keeps the pipeline
 * deterministic in practice.
 */
async function fetchWithRetry(url, options, tries) {
  const attempts = tries || 6;
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, Object.assign({ netstack: false }, options));
      if (res.status >= 400)
        throw new Error("HTTP " + res.status + " for " + url);
      return res;
    } catch (e) {
      lastError = e;
      await sleep(250 * (i + 1));
    }
  }
  throw lastError || new Error("fetch failed: " + url);
}

async function fetchBytes(url, options, tries) {
  const res = await fetchWithRetry(url, options, tries);
  const buf = await res.arrayBuffer();
  return {
    status: res.status,
    url: res.url || url,
    headers: res.headers,
    bytes: new Uint8Array(buf),
  };
}

async function fetchText(url, options, tries) {
  const res = await fetchWithRetry(url, options, tries);
  return { text: await res.text(), url: res.url || url, status: res.status };
}

function mapSrc(src, baseURL) {
  if (!src)
    return src;
  if (/^[a-z]+:/i.test(src))
    return src;
  if (src.startsWith("//"))
    return "https:" + src;
  try {
    return new URL(src, baseURL).href;
  } catch (e) {
    return src;
  }
}

/* ------------------------------------------------------------- stylesheets */

function collectStyleSources(doc, baseURL) {
  const out = [];
  const visit = (node) => {
    for (const child of node.children) {
      if (child.type !== "element")
        continue;
      if (child.tag === "style") {
        out.push({ kind: "inline", text: textContent(child) });
      } else if (child.tag === "link") {
        const rel = (child.attrs.rel || "").toLowerCase();
        if (rel.split(/\s+/).includes("stylesheet") && child.attrs.href)
          out.push({ kind: "link", url: mapSrc(child.attrs.href, baseURL),
                     media: child.attrs.media || "" });
      }
      visit(child);
    }
  };
  visit(doc);
  return out;
}

/* ------------------------------------------------------------------ fonts */

const FONT_CSS_UA =
  "Mozilla/5.0 (Windows NT 6.1; rv:27.0) Gecko/20100101 Firefox/27.0";

function parseFontFaces(css) {
  const faces = [];
  const re = /@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const body = m[1];
    const family = (/font-family\s*:\s*(?:'([^']+)'|"([^"]+)"|([^;]+))/i
      .exec(body) || [])[0];
    const famMatch = /font-family\s*:\s*(?:'([^']+)'|"([^"]+)"|([^;]+))/i.exec(body);
    const weightMatch = /font-weight\s*:\s*(\d+)/i.exec(body);
    const styleMatch = /font-style\s*:\s*(\w+)/i.exec(body);
    const srcMatch = /src\s*:\s*url\(\s*(?:"([^"]+)"|'([^']+)'|([^)]+))\s*\)/i.exec(body);
    if (!famMatch || !srcMatch)
      continue;
    faces.push({
      family: famMatch[1] || famMatch[2] || famMatch[3].trim(),
      weight: weightMatch ? parseInt(weightMatch[1], 10) : 400,
      style: styleMatch ? styleMatch[1] : "normal",
      url: srcMatch[1] || srcMatch[2] || srcMatch[3].trim(),
    });
  }
  return faces;
}

async function loadWebFont(book, family, weights, log) {
  const query = family.replace(/ /g, "+") +
    (weights.length ? ":wght@" + weights.join(";") : "");
  const url = "https://fonts.googleapis.com/css2?family=" + query + "&display=swap";
  try {
    const css = await fetchText(url, {
      headers: { "user-agent": FONT_CSS_UA, accept: "text/css,*/*;q=0.1" },
    }, 8);
    const faces = parseFontFaces(css.text);
    let loaded = 0;
    for (const face of faces) {
      try {
        const bin = await fetchBytes(face.url, {
          headers: { "user-agent": FONT_CSS_UA, referer: "https://fonts.googleapis.com/" },
        }, 6);
        book.add(family, face.weight, face.style, bin.bytes);
        loaded++;
        log("font", family, face.weight, face.style, bin.bytes.length + " bytes");
      } catch (e) {
        log("font failed", family, face.weight, e.message);
      }
    }
    return loaded;
  } catch (e) {
    log("font css failed", family, e.message);
    return 0;
  }
}

function loadLocalFont(book, family, weight, style, paths, log) {
  for (const path of paths) {
    try {
      if (fs.existsSync(path)) {
        const bytes = fs.readFileSync(path);
        book.add(family, weight, style, new Uint8Array(bytes));
        log("font", family, weight, "local", bytes.length + " bytes");
        return true;
      }
    } catch (e) { /* try the next candidate */ }
  }
  return false;
}

/* ----------------------------------------------------------------- images */

function decodeImage(bytes) {
  if (bytes.length < 8)
    return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e)
    return decodePNG(bytes);
  return null;
}

function collectImageURLs(doc, baseURL) {
  const urls = new Set();
  walkElements(doc, (el) => {
    if (el.tag === "img" && el.attrs.src)
      urls.add(mapSrc(el.attrs.src, baseURL));
  });
  return urls;
}

function normalizeBackgroundImages(box, baseURL, urls) {
  const style = box.style;
  if (style.backgroundImage) {
    const m = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/i
      .exec(style.backgroundImage);
    if (m) {
      const raw = (m[1] || m[2] || m[3] || "").trim();
      const abs = mapSrc(raw, baseURL);
      style.backgroundImage = "url(" + abs + ")";
      urls.add(abs);
    }
  }
  for (const child of box.children) {
    if (child.kind !== "text")
      normalizeBackgroundImages(child, baseURL, urls);
  }
}

async function fetchImages(urls, images, log) {
  for (const url of urls) {
    try {
      const bin = await fetchBytes(url, { headers: { accept: "image/png,image/*;q=0.8" } }, 5);
      const img = decodeImage(bin.bytes);
      if (img) {
        images.set(url, img);
        log("image", url.split("/").pop(), img.width + "x" + img.height,
            bin.bytes.length + " bytes");
      } else {
        log("image skipped (not PNG)", url);
      }
    } catch (e) {
      log("image failed", url, e.message);
    }
  }
}

/* ------------------------------------------------------------------ render */

/**
 * @param {string} html
 * @param {Object} options
 *   url        - document URL used for relative resource resolution
 *   width      - viewport width in CSS px
 *   height     - viewport height in CSS px
 *   repoRoot   - checkout root, used for the bundled Arial fallback
 *   log        - function(...args) for progress output
 * @returns {Promise<{root:Object, pixels:Uint8Array, width:number,
 *                    height:number, images:Map, fonts:Object, timings:Object}>}
 */
export async function renderPage(html, options) {
  options = options || {};
  const width = options.width || 800;
  const height = options.height || 600;
  const log = options.log || (() => {});
  const timings = {};
  const t0 = Date.now();

  const doc = parseHTML(html);
  timings.parse = Date.now() - t0;

  /* Determine the document URL from the <base> element or the caller. */
  let baseURL = options.url || "https://www.google.com/";
  const baseEl = findTag(doc, "base");
  if (baseEl && baseEl.attrs.href)
    baseURL = mapSrc(baseEl.attrs.href, baseURL);

  /* Fonts: the page's declared families plus the browser-generic stack. */
  const t1 = Date.now();
  const book = new FontBook();
  const repoRoot = options.repoRoot || process.cwd();
  loadLocalFont(book, "Arial", 400, "normal", [
    repoRoot + "/lvgl/src/libs/freetype/arial.ttf",
    "lvgl/src/libs/freetype/arial.ttf",
  ], log);
  await loadWebFont(book, "Roboto", [400, 500, 700], log);
  await loadWebFont(book, "Noto Sans Thai", [400, 700], log);
  if (!book.faces.length)
    throw new Error("no usable fonts");
  timings.fonts = Date.now() - t1;

  /* Author stylesheets, in document order. */
  const t2 = Date.now();
  const rules = [];
  let order = 0;
  for (const src of collectStyleSources(doc, baseURL)) {
    if (src.kind === "inline") {
      const parsed = parseStylesheet(src.text, order);
      order += parsed.length;
      for (const rule of parsed) rules.push(rule);
    } else {
      if (src.media && !/^(all|screen)?$/i.test(src.media.trim()))
        continue;
      try {
        const css = await fetchText(src.url, {
          headers: {
            accept: "text/css,*/*;q=0.1",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                          "AppleWebKit/537.36 (KHTML, like Gecko) " +
                          "Chrome/120.0 Safari/537.36",
          },
        }, 5);
        log("stylesheet", src.url.split("/").pop(), css.text.length + " bytes");
        if (css.text.trim()) {
          const parsed = parseStylesheet(css.text, order);
          order += parsed.length;
          for (const rule of parsed) rules.push(rule);
        }
      } catch (e) {
        log("stylesheet failed", src.url, e.message);
      }
    }
  }
  timings.styles = Date.now() - t2;

  /* Images referenced by markup. */
  const t3 = Date.now();
  const images = new Map();
  await fetchImages(collectImageURLs(doc, baseURL), images, log);

  const built = buildBoxTree(doc, {
    rules, viewportWidth: width, fontBook: book, images, baseURL,
  });

  /* Background images only become known after the cascade. */
  const bgUrls = new Set();
  normalizeBackgroundImages(built.root, baseURL, bgUrls);
  await fetchImages(bgUrls, images, log);
  timings.images = Date.now() - t3;

  const t4 = Date.now();
  const root = layoutDocument(built, { viewportWidth: width, viewportHeight: height });
  timings.layout = Date.now() - t4;

  const t5 = Date.now();
  const pixels = paintDocument(root, {
    fontBook: book, images, width, height,
  });
  timings.paint = Date.now() - t5;
  timings.total = Date.now() - t0;

  return {
    root, pixels, width, height, images,
    fonts: { faces: book.faces.map((f) => ({
      family: f.family, weight: f.weight, style: f.style,
      glyphs: f.cmap.size,
    })) },
    timings,
  };
}

function findTag(node, tag) {
  for (const child of node.children) {
    if (child.type === "element") {
      if (child.tag === tag)
        return child;
      const found = findTag(child, tag);
      if (found)
        return found;
    }
  }
  return null;
}
