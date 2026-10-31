/*
 * ttf.js - TrueType/OpenType parsing, text shaping and glyph rasterization.
 *
 * Everything here is implemented on top of the raw font tables: sfnt/WOFF
 * decoding, cmap lookup, glyf outlines (including composite glyphs), OpenType
 * GPOS mark attachment for Thai and other mark-heavy scripts, and an
 * antialiased scanline rasterizer with a per-size glyph cache.
 */

import { decodeWOFF } from "./woff.js";

function u8(b, o) { return b[o]; }
function u16(b, o) { return b[o] << 8 | b[o + 1]; }
function i16(b, o) { const v = u16(b, o); return v & 0x8000 ? v - 0x10000 : v; }
function u32(b, o) {
  return (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0;
}

function tagAt(b, o) {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

/* ---------------------------------------------------------------- cmap */

function parseCmap(bytes, base) {
  const count = u16(bytes, base + 2);
  let best = -1, bestScore = -1;
  for (let i = 0; i < count; i++) {
    const r = base + 4 + i * 8;
    const platform = u16(bytes, r);
    const encoding = u16(bytes, r + 2);
    const offset = u32(bytes, r + 4);
    let score = 0;
    if (platform === 3 && encoding === 10) score = 4;
    else if (platform === 3 && encoding === 1) score = 3;
    else if (platform === 0 && (encoding === 4 || encoding === 6)) score = 3;
    else if (platform === 0) score = 2;
    else if (platform === 3 && encoding === 0) score = 1;
    if (score > bestScore) { bestScore = score; best = base + offset; }
  }
  if (best < 0)
    return new Map();
  const format = u16(bytes, best);
  const map = new Map();
  if (format === 4) {
    const segX2 = u16(bytes, best + 6);
    const seg = segX2 / 2;
    const end = best + 14;
    const start = end + segX2 + 2;
    const delta = start + segX2;
    const rangeOffset = delta + segX2;
    for (let s = 0; s < seg; s++) {
      const last = u16(bytes, end + s * 2);
      const first = u16(bytes, start + s * 2);
      if (first === 0xffff)
        continue;
      const d = i16(bytes, delta + s * 2);
      const ro = u16(bytes, rangeOffset + s * 2);
      for (let cp = first; cp <= last; cp++) {
        let gid;
        if (ro === 0) {
          gid = (cp + d) & 0xffff;
        } else {
          const gi = rangeOffset + s * 2 + ro + (cp - first) * 2;
          if (gi + 1 >= bytes.length)
            continue;
          gid = u16(bytes, gi);
          if (gid !== 0)
            gid = (gid + d) & 0xffff;
        }
        if (gid !== 0)
          map.set(cp, gid);
      }
    }
  } else if (format === 12) {
    const groups = u32(bytes, best + 12);
    for (let i = 0; i < groups; i++) {
      const r = best + 16 + i * 12;
      const first = u32(bytes, r);
      const last = u32(bytes, r + 4);
      const gid = u32(bytes, r + 8);
      for (let cp = first; cp <= last; cp++)
        map.set(cp, gid + (cp - first));
    }
  } else if (format === 0) {
    for (let cp = 0; cp < 256; cp++)
      if (bytes[best + 6 + cp])
        map.set(cp, bytes[best + 6 + cp]);
  } else if (format === 6) {
    const first = u16(bytes, best + 6);
    const n = u16(bytes, best + 8);
    for (let i = 0; i < n; i++) {
      const gid = u16(bytes, best + 10 + i * 2);
      if (gid)
        map.set(first + i, gid);
    }
  }
  return map;
}

/* ---------------------------------------------------------------- glyf */

function buildContour(points) {
  const n = points.length;
  if (n === 0)
    return null;
  let firstOn = -1;
  for (let i = 0; i < n; i++)
    if (points[i].on) { firstOn = i; break; }

  let start;
  let order = [];
  if (firstOn < 0) {
    /* All off-curve: start at the midpoint between the last and first. */
    const a = points[n - 1], b = points[0];
    start = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    for (let i = 0; i < n; i++)
      order.push(points[i]);
  } else {
    start = { x: points[firstOn].x, y: points[firstOn].y };
    for (let i = 1; i <= n; i++)
      order.push(points[(firstOn + i) % n]);
  }

  const segs = [];
  let cur = start;
  let pending = null;
  for (const p of order) {
    if (p.on) {
      if (pending) {
        segs.push({ type: "Q", cx: pending.x, cy: pending.y, x: p.x, y: p.y });
        pending = null;
      } else {
        segs.push({ type: "L", x: p.x, y: p.y });
      }
      cur = p;
    } else {
      if (pending) {
        const mx = (pending.x + p.x) / 2, my = (pending.y + p.y) / 2;
        segs.push({ type: "Q", cx: pending.x, cy: pending.y, x: mx, y: my });
        cur = { x: mx, y: my };
      }
      pending = p;
    }
  }
  if (pending)
    segs.push({ type: "Q", cx: pending.x, cy: pending.y, x: start.x, y: start.y });
  else
    segs.push({ type: "L", x: start.x, y: start.y });
  return { x: start.x, y: start.y, segs };
}

function transformContours(contours, a, b, c, d, dx, dy) {
  const out = [];
  for (const ct of contours) {
    const segs = ct.segs.map((s) => {
      if (s.type === "Q") {
        return { type: "Q",
                 cx: a * s.cx + c * s.cy + dx,
                 cy: b * s.cx + d * s.cy + dy,
                 x: a * s.x + c * s.y + dx,
                 y: b * s.x + d * s.y + dy };
      }
      return { type: "L", x: a * s.x + c * s.y + dx,
               y: b * s.x + d * s.y + dy };
    });
    out.push({ x: a * ct.x + c * ct.y + dx, y: b * ct.x + d * ct.y + dy, segs });
  }
  return out;
}

/* ------------------------------------------------------------- coverage */

function coverageIndex(bytes, base) {
  const format = u16(bytes, base);
  if (format === 1) {
    const count = u16(bytes, base + 2);
    const map = new Map();
    for (let i = 0; i < count; i++)
      map.set(u16(bytes, base + 4 + i * 2), i);
    return (gid) => map.has(gid) ? map.get(gid) : -1;
  }
  if (format === 2) {
    const count = u16(bytes, base + 2);
    const ranges = [];
    for (let i = 0; i < count; i++) {
      const r = base + 4 + i * 6;
      ranges.push({ first: u16(bytes, r), last: u16(bytes, r + 2),
                    start: u16(bytes, r + 4) });
    }
    return (gid) => {
      let lo = 0, hi = ranges.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const r = ranges[mid];
        if (gid < r.first) hi = mid - 1;
        else if (gid > r.last) lo = mid + 1;
        else return r.start + gid - r.first;
      }
      return -1;
    };
  }
  return () => -1;
}

function readAnchor(bytes, base) {
  const format = u16(bytes, base);
  return { x: i16(bytes, base + 2), y: i16(bytes, base + 4) };
}

/* ---------------------------------------------------------------- GPOS */

function parseGpos(bytes, base) {
  const scriptList = base + u16(bytes, base + 4);
  const featureList = base + u16(bytes, base + 6);
  const lookupList = base + u16(bytes, base + 8);

  const featureTags = new Map();
  const featureCount = u16(bytes, featureList);
  for (let i = 0; i < featureCount; i++) {
    const r = featureList + 2 + i * 6;
    const tag = tagAt(bytes, r);
    const off = u16(bytes, r + 4);
    const f = featureList + off;
    const n = u16(bytes, f + 2);
    const list = [];
    for (let k = 0; k < n; k++)
      list.push(u16(bytes, f + 4 + k * 2));
    featureTags.set(tag, list);
  }

  /* Lookups referenced by the mark/mkmk features of the thai script, or of
   * every script when thai is not present. */
  const wanted = new Set(["mark", "mkmk"]);
  const lookupIndices = new Set();
  const scriptCount = u16(bytes, scriptList);
  let thaiFound = false;
  const addLangSys = (langSys) => {
    const req = u16(bytes, langSys + 2);
    if (req !== 0xffff) {
      const tag = [...featureTags.entries()].find(([, v]) => v.includes(req));
      if (tag) lookupIndices.add(req);
    }
    const n = u16(bytes, langSys + 4);
    for (let i = 0; i < n; i++) {
      const idx = u16(bytes, langSys + 6 + i * 2);
      for (const [tag, lookups] of featureTags) {
        if (wanted.has(tag) && lookups === featureTags.get(tag)) {
          /* feature order is by index, resolve by scanning records */
          const rec = featureList + 2 + idx * 6;
          if (tagAt(bytes, rec) === tag)
            for (const l of lookups) lookupIndices.add(l);
        }
      }
    }
  };
  for (let i = 0; i < scriptCount; i++) {
    const r = scriptList + 2 + i * 6;
    const tag = tagAt(bytes, r);
    const s = scriptList + u16(bytes, r + 4);
    const def = u16(bytes, s);
    if (tag === "thai" || tag === "THAI" || tag === "DFLT" || tag === "latn") {
      if (tag === "thai") thaiFound = true;
      if (def)
        addLangSys(s + def);
      const langs = u16(bytes, s + 2);
      for (let k = 0; k < langs; k++) {
        const lr = s + 4 + k * 4;
        addLangSys(s + u16(bytes, lr + 2));
      }
    }
  }
  if (!thaiFound) {
    for (const [tag, lookups] of featureTags)
      if (wanted.has(tag))
        for (const l of lookups) lookupIndices.add(l);
  }

  const lookupCount = u16(bytes, lookupList);
  const lookups = [];
  for (const idx of lookupIndices) {
    if (idx >= lookupCount)
      continue;
    const lo = lookupList + 2 + idx * 2;
    const l = lookupList + u16(bytes, lo);
    const type = u16(bytes, l);
    const flag = u16(bytes, l + 2);
    const subCount = u16(bytes, l + 4);
    const subtables = [];
    for (let s = 0; s < subCount; s++)
      subtables.push(l + u16(bytes, l + 6 + s * 2));
    lookups.push({ type, flag, subtables, order: idx });
  }
  lookups.sort((a, b) => a.order - b.order);
  return lookups;
}

function parseMarkArray(bytes, base) {
  const count = u16(bytes, base);
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = base + 2 + i * 4;
    const cls = u16(bytes, r);
    const anchor = readAnchor(bytes, base + u16(bytes, r + 2));
    out.push({ cls, anchor });
  }
  return out;
}

function parseBaseArray(bytes, base, classCount) {
  const count = u16(bytes, base);
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = base + 2 + i * classCount * 2;
    const anchors = [];
    for (let c = 0; c < classCount; c++) {
      const off = u16(bytes, r + c * 2);
      anchors.push(off ? readAnchor(bytes, base + off) : null);
    }
    out.push(anchors);
  }
  return out;
}

function compileMarkLookup(bytes, table) {
  const format = u16(bytes, table);
  if (format !== 1)
    return null;
  if (tableType(bytes, table) === 4) {
    const markCov = coverageIndex(bytes, table + u16(bytes, table + 2));
    const baseCov = coverageIndex(bytes, table + u16(bytes, table + 4));
    const classCount = u16(bytes, table + 6);
    const marks = parseMarkArray(bytes, table + u16(bytes, table + 8));
    const bases = parseBaseArray(bytes, table + u16(bytes, table + 10),
                                 classCount);
    return { kind: "base", markCov, baseCov, marks, bases, classCount };
  }
  if (tableType(bytes, table) === 6) {
    const mark1Cov = coverageIndex(bytes, table + u16(bytes, table + 2));
    const mark2Cov = coverageIndex(bytes, table + u16(bytes, table + 4));
    const classCount = u16(bytes, table + 6);
    const marks1 = parseMarkArray(bytes, table + u16(bytes, table + 8));
    const marks2 = parseBaseArray(bytes, table + u16(bytes, table + 10),
                                  classCount);
    return { kind: "mark", mark1Cov, mark2Cov, marks1, marks2, classCount };
  }
  return null;
}

/* The table type is needed while compiling a subtable; stash it on the
 * subtable itself through a small wrapper. */
function tableType(bytes, base) {
  return bytes.__gposType || 0;
}

/* GPOS application works in font units. `xy` holds the horizontal pen
 * position of each glyph and `ox`/`oy` the accumulated offsets. */
function applyGpos(glyphs, pens, ox, oy, lookups) {
  for (const lookup of lookups) {
    for (const sub of lookup.subtables) {
      const info = lookup.compiled && lookup.compiled.get(sub);
      if (!info)
        continue;
      if (info.kind === "base") {
        for (let i = 0; i < glyphs.length; i++) {
          const mi = info.markCov(glyphs[i]);
          if (mi < 0 || mi >= info.marks.length)
            continue;
          let b = i - 1;
          let bi = -1;
          while (b >= 0) {
            const cand = info.baseCov(glyphs[b]);
            if (cand >= 0) { bi = cand; break; }
            b--;
          }
          if (b < 0 || bi >= info.bases.length)
            continue;
          const mark = info.marks[mi];
          const anchor = info.bases[bi][mark.cls];
          if (!anchor)
            continue;
          ox[i] = pens[b] + ox[b] + anchor.x - pens[i] - mark.anchor.x;
          oy[i] = oy[b] + anchor.y - mark.anchor.y;
        }
      } else if (info.kind === "mark") {
        for (let i = 0; i < glyphs.length; i++) {
          const mi = info.mark1Cov(glyphs[i]);
          if (mi < 0 || mi >= info.marks1.length)
            continue;
          let m = i - 1;
          let m2 = -1;
          while (m >= 0) {
            const cand = info.mark2Cov(glyphs[m]);
            if (cand >= 0) { m2 = cand; break; }
            m--;
          }
          if (m < 0 || m2 >= info.marks2.length)
            continue;
          const mark = info.marks1[mi];
          const anchor = info.marks2[m2][mark.cls];
          if (!anchor)
            continue;
          ox[i] = pens[m] + ox[m] + anchor.x - pens[i] - mark.anchor.x;
          oy[i] = oy[m] + anchor.y - mark.anchor.y;
        }
      }
    }
  }
}

/* ---------------------------------------------------------------- Font */

let nextFaceId = 1;

export class FontFace {
  /**
   * @param {string} family
   * @param {number} weight 400 / 500 / 700
   * @param {string} style "normal" or "italic"
   * @param {Uint8Array} raw WOFF or sfnt bytes
   */
  constructor(family, weight, style, raw) {
    this.family = family;
    this.weight = weight;
    this.style = style || "normal";
    this.bytes = decodeWOFF(raw);
    this.id = nextFaceId++;
    this.nodes = new Set();
    this.contourCache = new Map();
    this.bitmapCache = new Map();
    this.gpos = null;
    this._parse();
  }

  _table(tag) {
    const n = u16(this.bytes, 4);
    for (let i = 0; i < n; i++) {
      const r = 12 + i * 16;
      if (tagAt(this.bytes, r) === tag) {
        return { offset: u32(this.bytes, r + 8),
                 length: u32(this.bytes, r + 12) };
      }
    }
    return null;
  }

  _parse() {
    const b = this.bytes;
    const head = this._table("head");
    const hhea = this._table("hhea");
    const maxp = this._table("maxp");
    const hmtx = this._table("hmtx");
    const cmap = this._table("cmap");
    const loca = this._table("loca");
    const glyf = this._table("glyf");
    if (!head || !hhea || !maxp)
      throw new Error("font: missing required tables");
    this.unitsPerEm = u16(b, head.offset + 18);
    this.indexToLocFormat = i16(b, head.offset + 50);
    this.ascent = i16(b, hhea.offset + 4);
    this.descent = i16(b, hhea.offset + 6);
    this.lineGap = i16(b, hhea.offset + 8);
    this.numGlyphs = u16(b, maxp.offset + 4);
    this.numHMetrics = u16(b, hhea.offset + 34);
    this.cmap = cmap ? parseCmap(b, cmap.offset) : new Map();
    this.locaTable = loca;
    this.glyfTable = glyf;
    this.hmtxTable = hmtx;

    const os2 = this._table("OS/2");
    if (os2) {
      this.typoAscent = i16(b, os2.offset + 68);
      this.typoDescent = i16(b, os2.offset + 70);
    }

    const gpos = this._table("GPOS");
    if (gpos) {
      try {
        this.gpos = parseGpos(b, gpos.offset);
        for (const lookup of this.gpos) {
          lookup.compiled = new Map();
          for (const sub of lookup.subtables) {
            b.__gposType = lookup.type;
            const info = compileMarkLookup(b, sub);
            if (info)
              lookup.compiled.set(sub, info);
          }
        }
      } catch (e) {
        this.gpos = null;
      }
    }
  }

  glyphIndex(cp) {
    return this.cmap.get(cp) || 0;
  }

  hasGlyph(cp) {
    return this.cmap.has(cp);
  }

  advance(gid) {
    if (!this.hmtxTable || !this.numHMetrics)
      return 0;
    const idx = Math.min(gid, this.numHMetrics - 1);
    return u16(this.bytes, this.hmtxTable.offset + idx * 4);
  }

  _loca(gid) {
    const t = this.locaTable;
    if (!t || gid >= this.numGlyphs)
      return null;
    if (this.indexToLocFormat === 0) {
      return u16(this.bytes, t.offset + gid * 2) * 2;
    }
    return u32(this.bytes, t.offset + gid * 4);
  }

  /** Return glyph contours in font units (cached). */
  contours(gid) {
    if (this.contourCache.has(gid))
      return this.contourCache.get(gid);
    const out = this._glyf(gid, 0);
    this.contourCache.set(gid, out);
    return out;
  }

  _glyf(gid, depth) {
    if (depth > 8 || !this.glyfTable || gid >= this.numGlyphs)
      return [];
    const start = this._loca(gid);
    const end = this._loca(gid + 1);
    if (start == null || end == null || end <= start)
      return [];
    const o = this.glyfTable.offset + start;
    const b = this.bytes;
    const nContours = i16(b, o);
    if (nContours >= 0) {
      if (nContours === 0)
        return [];
      const endPts = [];
      for (let i = 0; i < nContours; i++)
        endPts.push(u16(b, o + 10 + i * 2));
      const numPoints = endPts[endPts.length - 1] + 1;
      let p = o + 10 + nContours * 2;
      const instrLen = u16(b, p);
      p += 2 + instrLen;

      const flags = new Uint8Array(numPoints);
      for (let i = 0; i < numPoints;) {
        const f = b[p++];
        flags[i++] = f;
        if (f & 8) {
          let rep = b[p++];
          while (rep-- > 0 && i < numPoints)
            flags[i++] = f;
        }
      }
      const xs = new Int16Array(numPoints);
      let x = 0;
      for (let i = 0; i < numPoints; i++) {
        const f = flags[i];
        if (f & 2) {
          const d = b[p++];
          x += (f & 16) ? d : -d;
        } else if (!(f & 16)) {
          x += i16(b, p); p += 2;
        }
        xs[i] = x;
      }
      const ys = new Int16Array(numPoints);
      let y = 0;
      for (let i = 0; i < numPoints; i++) {
        const f = flags[i];
        if (f & 4) {
          const d = b[p++];
          y += (f & 32) ? d : -d;
        } else if (!(f & 32)) {
          y += i16(b, p); p += 2;
        }
        ys[i] = y;
      }
      const pts = [];
      for (let i = 0; i < numPoints; i++)
        pts.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) });
      const contours = [];
      let first = 0;
      for (const last of endPts) {
        const ct = buildContour(pts.slice(first, last + 1));
        if (ct)
          contours.push(ct);
        first = last + 1;
      }
      return contours;
    }

    /* Composite glyph. */
    if (nContours !== -1)
      return [];
    let p = o + 10;
    let contours = [];
    for (;;) {
      const flags = u16(b, p);
      const comp = u16(b, p + 2);
      p += 4;
      let dx = 0, dy = 0;
      if (flags & 1) {
        dx = i16(b, p); dy = i16(b, p + 2); p += 4;
      } else {
        dx = (b[p] << 24) >> 24; dy = (b[p + 1] << 24) >> 24; p += 2;
      }
      let a = 1, bb = 0, c = 0, d = 1;
      if (flags & 8) {
        a = d = i16(b, p) / 16384; p += 2;
      } else if (flags & 0x40) {
        a = i16(b, p) / 16384;
        d = i16(b, p + 2) / 16384;
        p += 4;
      } else if (flags & 0x80) {
        a = i16(b, p) / 16384;
        bb = i16(b, p + 2) / 16384;
        c = i16(b, p + 4) / 16384;
        d = i16(b, p + 6) / 16384;
        p += 8;
      }
      const part = this._glyf(comp, depth + 1);
      contours = contours.concat(transformContours(part, a, bb, c, d, dx, dy));
      if (!(flags & 0x20))
        break;
    }
    return contours;
  }

  /**
   * Rasterize one glyph at `size` device pixels, at horizontal subpixel
   * phase `phase` (0, 0.25, 0.5, 0.75). Returns an alpha bitmap plus the
   * device offset from the pen/baseline.
   */
  bitmap(gid, size, phase) {
    const key = gid + "|" + size + "|" + phase;
    const cached = this.bitmapCache.get(key);
    if (cached)
      return cached;

    const contours = this.contours(gid);
    const scale = size / this.unitsPerEm;
    if (!contours.length) {
      const empty = { width: 0, height: 0, left: 0, top: 0,
                      alpha: new Uint8Array(0) };
      this.bitmapCache.set(key, empty);
      return empty;
    }

    /* Flatten the outline in device space, relative to the pen. */
    const edges = [];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const tx = (x) => phase + x * scale;
    const ty = (y) => -y * scale;
    for (const ct of contours) {
      let px = tx(ct.x), py = ty(ct.y);
      let sx = px, sy = py;
      const track = (x, y) => {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      };
      track(px, py);
      for (const seg of ct.segs) {
        if (seg.type === "Q") {
          const cx = tx(seg.cx), cy = ty(seg.cy);
          const ex = tx(seg.x), ey = ty(seg.y);
          flattenQuad(px, py, cx, cy, ex, ey, edges, track, 0);
          px = ex; py = ey;
        } else {
          const ex = tx(seg.x), ey = ty(seg.y);
          edges.push(px, py, ex, ey);
          track(ex, ey);
          px = ex; py = ey;
        }
        if (px === sx && py === sy)
          continue;
      }
      if (px !== sx || py !== sy) {
        edges.push(px, py, sx, sy);
        track(sx, sy);
      }
    }

    const pad = 1;
    const left = Math.floor(minX) - pad;
    const top = Math.floor(minY) - pad;
    const width = Math.max(0, Math.ceil(maxX) - left + pad);
    const height = Math.max(0, Math.ceil(maxY) - top + pad);
    const alpha = width && height
      ? rasterizeEdges(edges, width, height, -left, -top) : new Uint8Array(0);
    const out = { width, height, left, top, alpha };
    this.bitmapCache.set(key, out);
    return out;
  }

  ascentPx(size) { return this.ascent * size / this.unitsPerEm; }
  descentPx(size) { return -this.descent * size / this.unitsPerEm; }
  lineGapPx(size) { return this.lineGap * size / this.unitsPerEm; }
  advancePx(gid, size) { return this.advance(gid) * size / this.unitsPerEm; }
}

function flattenQuad(x0, y0, cx, cy, x1, y1, edges, track, depth) {
  if (depth >= 8) {
    edges.push(x0, y0, x1, y1);
    track(x1, y1);
    return;
  }
  const dx = x1 - x0, dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const dist = Math.abs((cx - x0) * dy - (cy - y0) * dx) / len;
  if (dist <= 0.2) {
    edges.push(x0, y0, x1, y1);
    track(x1, y1);
    return;
  }
  const ax = (x0 + cx) / 2, ay = (y0 + cy) / 2;
  const bx = (cx + x1) / 2, by = (cy + y1) / 2;
  const mx = (ax + bx) / 2, my = (ay + by) / 2;
  flattenQuad(x0, y0, ax, ay, mx, my, edges, track, depth + 1);
  flattenQuad(mx, my, bx, by, x1, y1, edges, track, depth + 1);
}

const SAMPLES = 5;

function rasterizeEdges(edges, width, height, shiftX, shiftY) {
  const cov = new Float32Array(width * height);
  const xs = [];
  for (let y = 0; y < height; y++) {
    for (let s = 0; s < SAMPLES; s++) {
      const sy = y + (s + 0.5) / SAMPLES;
      xs.length = 0;
      for (let i = 0; i < edges.length; i += 4) {
        const x0 = edges[i] + shiftX, y0 = edges[i + 1] + shiftY;
        const x1 = edges[i + 2] + shiftX, y1 = edges[i + 3] + shiftY;
        if (y0 === y1)
          continue;
        const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
        if (sy < lo || sy >= hi)
          continue;
        const t = (sy - y0) / (y1 - y0);
        const x = x0 + (x1 - x0) * t;
        xs.push(x, y1 > y0 ? 1 : -1);
      }
      if (xs.length < 4)
        continue;
      /* Insertion sort by x (few crossings per scanline). */
      for (let i = 2; i < xs.length; i += 2) {
        const x = xs[i], d = xs[i + 1];
        let j = i - 2;
        while (j >= 0 && xs[j] > x) {
          xs[j + 2] = xs[j];
          xs[j + 3] = xs[j + 1];
          j -= 2;
        }
        xs[j + 2] = x;
        xs[j + 3] = d;
      }
      let wind = 0, spanStart = 0;
      for (let i = 0; i < xs.length; i += 2) {
        const prev = wind;
        wind += xs[i + 1];
        if (prev === 0 && wind !== 0) {
          spanStart = xs[i];
        } else if (prev !== 0 && wind === 0) {
          addSpan(cov, width, height, y, spanStart, xs[i], 1 / SAMPLES);
        }
      }
    }
  }
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) {
    let v = cov[i];
    if (v <= 0) continue;
    if (v > 1) v = 1;
    alpha[i] = Math.round(v * 255);
  }
  return alpha;
}

function addSpan(cov, width, height, row, xa, xb, weight) {
  if (xb <= xa)
    return;
  if (xa < 0) xa = 0;
  if (xb > width) xb = width;
  if (xb <= xa)
    return;
  const base = row * width;
  let ia = Math.floor(xa), ib = Math.floor(xb - 1e-9);
  if (ia === ib) {
    cov[base + ia] += (xb - xa) * weight;
    return;
  }
  cov[base + ia] += (ia + 1 - xa) * weight;
  for (let x = ia + 1; x < ib; x++)
    cov[base + x] += weight;
  if (ib < width)
    cov[base + ib] += (xb - ib) * weight;
}

/* ----------------------------------------------------------- font book */

function familyList(spec) {
  const out = [];
  let cur = "";
  let quote = 0;
  for (const ch of String(spec || "")) {
    if (ch === "'" || ch === '"') {
      quote = quote ? 0 : ch;
      continue;
    }
    if (ch === "," && !quote) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim())
    out.push(cur.trim());
  return out;
}

const GENERIC = new Set(["sans-serif", "serif", "monospace", "cursive",
                         "fantasy", "system-ui", "-apple-system"]);

export class FontBook {
  constructor() {
    this.faces = [];
  }

  add(family, weight, style, raw) {
    const face = new FontFace(family, weight, style || "normal", raw);
    this.faces.push(face);
    return face;
  }

  byFamily(family) {
    const key = family.toLowerCase();
    return this.faces.filter((f) => f.family.toLowerCase() === key);
  }

  /**
   * Resolve a CSS font-family stack to an ordered list of faces, falling back
   * to the generic sans-serif stack (Arial then Noto Sans Thai).
   */
  resolve(spec, weight, style) {
    const list = familyList(spec);
    const out = [];
    const add = (faces) => {
      for (const f of faces)
        if (!out.includes(f))
          out.push(f);
    };
    for (const name of list) {
      if (GENERIC.has(name.toLowerCase()))
        continue;
      const faces = this.byFamily(name);
      if (faces.length)
        add(chooseWeight(faces, weight, style));
    }
    /* Browser-generic fallback. */
    for (const name of ["Arial", "Roboto", "Noto Sans Thai"]) {
      const faces = this.byFamily(name);
      if (faces.length)
        add(chooseWeight(faces, weight, style));
    }
    /* Anything that covers the missing glyphs. */
    add(this.faces);
    return out;
  }

  /**
   * Shape a text run.
   * @returns {{glyphs:Array, width:number, ascent:number, descent:number,
   *            lineHeight:number}}
   */
  shape(text, spec, weight, style, size) {
    const candidates = this.resolve(spec, weight, style);
    const clusters = [];
    let cluster = null;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      const mark = isCombiningMark(cp);
      if (!cluster || !mark) {
        cluster = { base: cp, cps: [cp] };
        clusters.push(cluster);
      } else {
        cluster.cps.push(cp);
      }
    }

    const glyphs = [];
    let face = null;
    for (const c of clusters) {
      let chosen = null;
      for (const f of candidates) {
        if (f.hasGlyph(c.base)) { chosen = f; break; }
      }
      if (!chosen) {
        for (const f of candidates) {
          if (c.cps.some((cp) => f.hasGlyph(cp))) { chosen = f; break; }
        }
      }
      if (!chosen)
        chosen = candidates[0];
      if (!face)
        face = chosen;
      for (const cp of c.cps) {
        let f = chosen;
        if (!f.hasGlyph(cp)) {
          for (const alt of candidates) {
            if (alt.hasGlyph(cp)) { f = alt; break; }
          }
        }
        const gid = f.glyphIndex(cp);
        glyphs.push({ face: f, gid, cp, advance: f.advance(gid) });
        if (!face)
          face = f;
      }
    }
    if (!face)
      face = this.faces[0];

    const pens = new Array(glyphs.length);
    let pen = 0;
    for (let i = 0; i < glyphs.length; i++) {
      pens[i] = pen;
      pen += glyphs[i].advance;
    }
    const ox = new Array(glyphs.length).fill(0);
    const oy = new Array(glyphs.length).fill(0);

    /* Apply mark attachment per face run. */
    let i = 0;
    while (i < glyphs.length) {
      const f = glyphs[i].face;
      let j = i;
      while (j < glyphs.length && glyphs[j].face === f)
        j++;
      if (f.gpos && f.gpos.length) {
        const gids = [];
        const gp = [];
        let p = 0;
        const base = pens[i];
        for (let k = i; k < j; k++) {
          gids.push(glyphs[k].gid);
          gp.push(p);
          p += glyphs[k].advance;
        }
        const gox = new Array(gids.length).fill(0);
        const goy = new Array(gids.length).fill(0);
        applyGpos(gids, gp, gox, goy, f.gpos);
        for (let k = i; k < j; k++) {
          ox[k] = gox[k - i];
          oy[k] = goy[k - i];
        }
      }
      i = j;
    }

    /* Convert to device pixels. */
    let x = 0;
    let ascent = 0, descent = 0;
    for (let k = 0; k < glyphs.length; k++) {
      const g = glyphs[k];
      const scale = size / g.face.unitsPerEm;
      g.x = x + ox[k] * scale;
      g.y = -oy[k] * scale;
      g.xAdvance = g.advance * scale;
      x += g.xAdvance;
      ascent = Math.max(ascent, g.face.ascentPx(size));
      descent = Math.max(descent, g.face.descentPx(size));
    }
    return { glyphs, width: x, ascent, descent,
             lineHeight: ascent + descent + face.lineGapPx(size) };
  }
}

function chooseWeight(faces, weight, style) {
  const styleMatch = faces.filter((f) => f.style === (style || "normal"));
  const pool = styleMatch.length ? styleMatch : faces;
  let best = pool[0], bestScore = Infinity;
  for (const f of pool) {
    const distance = Math.abs(f.weight - (weight || 400));
    if (distance < bestScore) { best = f; bestScore = distance; }
  }
  return [best];
}

const MARK_RANGES = [
  [0x0300, 0x036f], [0x0591, 0x05c7], [0x0610, 0x061a],
  [0x064b, 0x065f], [0x0670, 0x0670], [0x06d6, 0x06ed],
  [0x0900, 0x0903], [0x093a, 0x094f], [0x0951, 0x0957],
  [0x0e31, 0x0e31], [0x0e34, 0x0e3a], [0x0e47, 0x0e4e],
  [0x0eb1, 0x0eb1], [0x0eb4, 0x0ebc], [0x0ec8, 0x0ecd],
  [0x1ab0, 0x1aff], [0x20d0, 0x20ff], [0xfe20, 0xfe2f],
];

function isCombiningMark(cp) {
  for (const [a, b] of MARK_RANGES)
    if (cp >= a && cp <= b)
      return true;
  return false;
}

export { isCombiningMark, familyList };
