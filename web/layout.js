/*
 * layout.js - box tree construction and layout for the qnode renderer.
 *
 * Supported formatting contexts:
 *   - block flow with margin collapsing and line boxes
 *   - inline formatting with word wrapping, text-align, vertical-align
 *     and inline-block / replaced elements
 *   - shrink-to-fit sizing driven by intrinsic min/max content widths
 *   - tables (rows/cells, percentage columns, cellspacing/cellpadding)
 *   - flex rows with justify-content, align-items and grow/shrink
 *   - relative positioning, floats and absolute positioning
 *
 * Text is measured and shaped through FontBook, so every line records the
 * actual glyphs that paint.js will blit.
 */

import { computeStyle, resolveLength } from "./css.js";

/* ------------------------------------------------------------------ helpers */

const TEXT_SPLIT = /([ \t\n\r\f]+)|([^ \t\n\r\f]+)/g;

function hasBorder(side) {
  return side && side.style !== "none" && side.style !== "hidden" &&
         side.width > 0;
}

function borderWidth(style, side) {
  const b = style.border[side];
  return hasBorder(b) ? b.width : 0;
}

function paddingOf(style, ref) {
  return style.padding.map((v) => resolveLength(v, ref, 0));
}

function marginsOf(style, ref) {
  return style.margin.map((v) => resolveLength(v, ref, 0));
}

function borderBoxes(style) {
  return [borderWidth(style, 0), borderWidth(style, 1),
          borderWidth(style, 2), borderWidth(style, 3)];
}

function resolveSize(value, reference, fallback) {
  return resolveLength(value, reference, fallback);
}

function mapDisplay(display) {
  if (display === "block" || display === "list-item")
    return "block";
  if (display === "flex" || display === "inline-flex")
    return "flex";
  if (display === "table")
    return "table";
  if (display === "table-row")
    return "row";
  if (display === "table-cell")
    return "cell";
  if (display === "inline-block")
    return "inline-block";
  return "inline";
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

/* ------------------------------------------------------------------- build */

/**
 * Build the box tree for a parsed document.
 * @param {Object} doc
 * @param {Object} options {rules, viewportWidth, fontBook, images, baseURL}
 */
export function buildBoxTree(doc, options) {
  const ctx = {
    rules: options.rules || [],
    viewportWidth: options.viewportWidth || 800,
    fontBook: options.fontBook,
    images: options.images || new Map(),
    baseURL: options.baseURL || "https://www.google.com/",
    shapeCache: new Map(),
    intrinsicCache: new Map(),
  };

  const html = doc.children.find((c) => c.type === "element" && c.tag === "html") ||
               doc;
  const rootStyle = computeStyle(html.type === "element" ? html : { tag: "html",
    attrs: {}, children: [], parent: null }, null, ctx.rules, ctx.viewportWidth);
  const rootBox = {
    kind: "block", tag: "html", el: html, style: rootStyle, children: [],
    lines: [], x: 0, y: 0, w: 0, h: 0,
    contentX: 0, contentY: 0, contentW: 0, contentH: 0,
  };

  if (html.type === "element") {
    /* Find body and treat it as the root block, as browsers do. */
    const body = findElement(html, "body");
    if (body) {
      const bodyStyle = computeStyle(body, rootStyle, ctx.rules,
                                     ctx.viewportWidth);
      const bodyBox = makeBox(body, bodyStyle, ctx);
      rootBox.children.push(bodyBox);
      rootBox.body = bodyBox;
    } else {
      rootBox.children = buildChildren(html, rootStyle, ctx);
    }
  }
  return { root: rootBox, ctx };
}

function findElement(node, tag) {
  for (const child of node.children) {
    if (child.type === "element") {
      if (child.tag === tag)
        return child;
      const found = findElement(child, tag);
      if (found)
        return found;
    }
  }
  return null;
}

function makeBox(el, style, ctx) {
  const box = {
    kind: mapDisplay(style.display),
    tag: el.tag,
    el,
    style,
    children: [],
    lines: [],
    x: 0, y: 0, w: 0, h: 0,
    contentX: 0, contentY: 0, contentW: 0, contentH: 0,
    baseline: 0,
  };

  if (el.tag === "img") {
    box.kind = "replaced";
    const src = mapSrc(el.attrs.src, ctx.baseURL);
    const image = src ? ctx.images.get(src) : null;
    box.image = image || null;
    let iw = image ? image.width : 0;
    let ih = image ? image.height : 0;
    if (el.attrs.width && /^\d+$/.test(el.attrs.width))
      iw = parseInt(el.attrs.width, 10);
    if (el.attrs.height && /^\d+$/.test(el.attrs.height))
      ih = parseInt(el.attrs.height, 10);
    box.intrinsicW = iw;
    box.intrinsicH = ih;
  } else if (el.tag === "input") {
    box.kind = "input";
    box.inputType = (el.attrs.type || "text").toLowerCase();
    box.value = el.attrs.value || "";
    const size = parseInt(el.attrs.size || "20", 10) || 20;
    box.sizeAttr = size;
  } else if (el.tag === "br") {
    box.kind = "br";
  }

  box.children = buildChildren(el, style, ctx);
  return box;
}

function buildChildren(el, parentStyle, ctx) {
  const out = [];
  for (const child of el.children) {
    if (child.type === "text") {
      out.push({ kind: "text", text: child.text, style: parentStyle,
                 children: [] });
      continue;
    }
    const style = computeStyle(child, parentStyle, ctx.rules,
                               ctx.viewportWidth);
    if (style.display === "none")
      continue;
    out.push(makeBox(child, style, ctx));
  }
  return out;
}

/* ------------------------------------------------------------------ shapes */

function shapeText(ctx, text, style) {
  const key = style.fontFamily + "|" + style.fontWeight + "|" +
              style.fontStyle + "|" + style.fontSize + "|" + text;
  let shape = ctx.shapeCache.get(key);
  if (!shape) {
    shape = ctx.fontBook.shape(text, style.fontFamily, style.fontWeight,
                               style.fontStyle, style.fontSize);
    ctx.shapeCache.set(key, shape);
  }
  return shape;
}

function spaceWidth(ctx, style) {
  return shapeText(ctx, " ", style).width;
}

function textWidth(ctx, text, style) {
  return shapeText(ctx, text, style).width +
         (style.letterSpacing || 0) * text.length;
}

/* ------------------------------------------------------------- intrinsic */

function intrinsicWidth(box, mode, ctx) {
  if (box.kind === "text")
    return textIntrinsic(box.text, box.style, mode, ctx);
  if (box.kind === "br")
    return 0;

  const cacheKey = box;
  let cache = ctx.intrinsicCache.get(cacheKey);
  if (!cache) {
    cache = {};
    ctx.intrinsicCache.set(cacheKey, cache);
  }
  if (cache[mode] !== undefined)
    return cache[mode];

  const style = box.style;
  const pad = paddingOf(style, 0);
  const bord = borderBoxes(style);
  const extra = pad[1] + pad[3] + bord[1] + bord[3];

  let width;
  if (box.kind === "replaced") {
    width = resolveReplacedWidth(box, 0);
  } else if (box.kind === "input") {
    width = inputWidth(box, ctx);
  } else if (box.kind === "inline" || box.kind === "inline-block") {
    width = inlineContentIntrinsic(box, mode, ctx) + extra;
  } else if (box.kind === "table") {
    width = tableIntrinsic(box, mode, ctx);
  } else if (box.kind === "flex") {
    width = flexIntrinsic(box, mode, ctx);
  } else {
    width = blockContentIntrinsic(box, mode, ctx) + extra;
  }

  /* Explicit width wins for shrink-to-fit purposes. */
  if (style.width !== "auto" && box.kind !== "replaced" &&
      box.kind !== "input") {
    const w = resolveLength(style.width, 1, 0);
    if (typeof w === "number" && !String(style.width).endsWith("%")) {
      width = style.boxSizing === "border-box" ? w : w + extra;
    }
  }
  cache[mode] = width;
  return width;
}

function textIntrinsic(text, style, mode, ctx) {
  if (!text)
    return 0;
  if (mode === "max")
    return textWidth(ctx, text.trim(), style);
  /* min-content: longest unbreakable run. */
  let best = 0;
  const re = /[^ \t\n\r\f]+/g;
  let m;
  while ((m = re.exec(text)))
    best = Math.max(best, textWidth(ctx, m[0], style));
  return best;
}

function inlineContentIntrinsic(box, mode, ctx) {
  let total = 0, best = 0, sawText = false;
  for (const child of box.children) {
    if (child.kind === "text") {
      if (!child.text.trim())
        continue;
      const w = textIntrinsic(child.text, child.style, mode, ctx);
      if (mode === "max") total += w;
      best = Math.max(best, w);
      sawText = true;
    } else if (child.kind === "block" || child.kind === "flex" ||
               child.kind === "table") {
      best = Math.max(best, intrinsicWidth(child, mode, ctx));
    } else {
      const w = intrinsicWidth(child, mode, ctx);
      if (mode === "max") total += w;
      best = Math.max(best, w);
      sawText = true;
    }
  }
  return mode === "max" ? Math.max(total, best) : best;
}

function blockContentIntrinsic(box, mode, ctx) {
  let total = 0, best = 0;
  const flush = () => { best = Math.max(best, total); total = 0; };
  for (const child of box.children) {
    if (child.kind === "text") {
      if (!child.text.trim())
        continue;
      const w = textIntrinsic(child.text, child.style, mode, ctx);
      if (mode === "max") total += w;
      else best = Math.max(best, w);
    } else if (child.style.display === "none") {
      continue;
    } else if (child.style.float !== "none" ||
               child.style.position === "absolute" ||
               child.style.position === "fixed") {
      continue;
    } else if (child.kind === "inline" || child.kind === "inline-block" ||
               child.kind === "replaced" || child.kind === "input" ||
               child.kind === "br") {
      if (child.kind === "br") {
        flush();
        continue;
      }
      const w = intrinsicWidth(child, mode, ctx);
      if (mode === "max") total += w;
      else best = Math.max(best, w);
    } else {
      flush();
      best = Math.max(best, intrinsicWidth(child, mode, ctx));
    }
  }
  flush();
  return best;
}

function flexIntrinsic(box, mode, ctx) {
  let total = 0;
  let best = 0;
  for (const child of box.children) {
    if (child.kind === "text" && !child.text.trim())
      continue;
    const w = intrinsicWidth(child, mode, ctx);
    total += w;
    best = Math.max(best, w);
  }
  return mode === "max" ? total : best;
}

function tableIntrinsic(box, mode, ctx) {
  let total = 0, rows = 0;
  for (const child of box.children) {
    if (child.kind !== "row")
      continue;
    rows++;
    let rowWidth = 0;
    for (const cell of child.children) {
      if (cell.kind !== "cell")
        continue;
      rowWidth += intrinsicWidth(cell, mode, ctx);
    }
    total = Math.max(total, rowWidth);
  }
  return total;
}

function resolveReplacedWidth(box, reference) {
  if (box.style.width !== "auto") {
    const w = resolveLength(box.style.width, reference, 0);
    if (typeof w === "number")
      return box.style.boxSizing === "border-box" ? w :
             w + paddingOf(box.style, reference)[1] +
             paddingOf(box.style, reference)[3] +
             borderBoxes(box.style)[1] + borderBoxes(box.style)[3];
  }
  const pad = paddingOf(box.style, reference);
  return box.intrinsicW + pad[1] + pad[3] +
         borderBoxes(box.style)[1] + borderBoxes(box.style)[3];
}

function inputWidth(box, ctx) {
  const style = box.style;
  const pad = paddingOf(style, 0);
  const bord = borderBoxes(style);
  const extra = pad[1] + pad[3] + bord[1] + bord[3];
  if (style.width !== "auto") {
    const w = resolveLength(style.width, 0, 0);
    if (typeof w === "number")
      return style.boxSizing === "border-box" ? w : w + extra;
  }
  const type = box.inputType;
  if (type === "submit" || type === "button" || type === "reset") {
    return textWidth(ctx, box.value, style) + extra + 12;
  }
  const chars = "0".repeat(box.sizeAttr || 20);
  return textWidth(ctx, chars, style) + extra + 2;
}

function inputHeight(box, ctx) {
  const style = box.style;
  const pad = paddingOf(style, 0);
  const bord = borderBoxes(style);
  const extra = pad[0] + pad[2] + bord[0] + bord[2];
  if (style.height !== "auto") {
    const h = resolveLength(style.height, 0, 0);
    if (typeof h === "number")
      return style.boxSizing === "border-box" ? h : h + extra;
  }
  return Math.max(style.fontSize * 1.2, 16) + extra;
}

/* ------------------------------------------------------------------ layout */

/**
 * Lay out the document box tree.
 * @param {Object} built result of buildBoxTree
 * @param {Object} options {viewportWidth, viewportHeight}
 * @returns {Object} root box
 */
export function layoutDocument(built, options) {
  const ctx = built.ctx;
  const root = built.root;
  const vw = options.viewportWidth || 800;
  const vh = options.viewportHeight || 600;

  /* The html box fills the viewport. */
  root.x = 0;
  root.y = 0;
  root.w = vw;
  root.h = vh;
  root.contentX = 0;
  root.contentY = 0;
  root.contentW = vw;
  root.contentH = vh;

  const body = root.body;
  if (body) {
    layoutBox(body, 0, 0, vw, ctx, { root: true });
    root.body = body;
  }
  return root;
}

function layoutBox(box, x, y, availW, ctx, opts) {
  opts = opts || {};
  const style = box.style;
  const ref = availW;
  const margin = marginsOf(style, ref);
  const pad = paddingOf(style, ref);
  const bord = borderBoxes(style);
  const extraX = pad[1] + pad[3] + bord[1] + bord[3];
  const extraY = pad[0] + pad[2] + bord[0] + bord[2];

  let borderW;
  let contentW;
  if (opts.forceWidth !== undefined) {
    borderW = opts.forceWidth;
  } else if (style.width !== "auto" && box.kind !== "replaced" &&
             box.kind !== "input") {
    const w = resolveLength(style.width, ref, 0);
    borderW = style.boxSizing === "border-box" ? w : w + extraX;
  } else if (box.kind === "replaced") {
    borderW = resolveReplacedWidth(box, ref);
  } else if (box.kind === "input") {
    borderW = inputWidth(box, ctx);
  } else if (box.kind === "inline-block") {
    const max = intrinsicWidth(box, "max", ctx);
    const min = intrinsicWidth(box, "min", ctx);
    borderW = Math.max(min, Math.min(max, availW - margin[3] - margin[1]));
  } else {
    borderW = availW - margin[3] - margin[1];
  }
  if (borderW < 0)
    borderW = 0;

  /* min/max width (border-box). */
  if (typeof style.minWidth === "number")
    borderW = Math.max(borderW, style.minWidth);
  if (typeof style.maxWidth === "number")
    borderW = Math.min(borderW, style.maxWidth);

  box.x = x;
  box.y = y;
  box.w = borderW;
  box.contentX = x + bord[3] + pad[3];
  box.contentY = y + bord[0] + pad[0];
  box.contentW = Math.max(0, borderW - extraX);

  let explicitContentH = null;
  if (style.height !== "auto" && box.kind !== "replaced" &&
      box.kind !== "input") {
    const h = resolveLength(style.height, 0, 0);
    if (typeof h === "number")
      explicitContentH = style.boxSizing === "border-box" ?
        Math.max(0, h - extraY) : h;
  }

  let contentH;
  switch (box.kind) {
    case "replaced": {
      const padH = pad[0] + pad[2] + bord[0] + bord[2];
      let h;
      if (style.height !== "auto" &&
          typeof resolveLength(style.height, 0, null) === "number") {
        const v = resolveLength(style.height, 0, 0);
        h = style.boxSizing === "border-box" ? v : v + padH;
      } else {
        h = box.intrinsicH + padH;
      }
      /* Scale by the width actually chosen. */
      if (box.intrinsicW > 0 && box.intrinsicH > 0 && box.contentW > 0) {
        const contentBoxW = Math.max(0, borderW - pad[1] - pad[3] -
                                     bord[1] - bord[3]);
        const scale = contentBoxW / box.intrinsicW;
        if (opts.forceWidth === undefined &&
            (style.width === "auto" || opts.scaleReplaced)) {
          const contentH = box.intrinsicH * scale;
          const wantH = style.height === "auto" ? null :
            resolveLength(style.height, 0, null);
          if (wantH === null)
            h = contentH + pad[0] + pad[2] + bord[0] + bord[2];
          else
            h = wantH + pad[0] + pad[2] + bord[0] + bord[2];
        }
      }
      box.contentH = Math.max(0, h - pad[0] - pad[2] - bord[0] - bord[2]);
      contentH = box.contentH;
      break;
    }
    case "input": {
      const h = inputHeight(box, ctx);
      box.contentH = Math.max(0, h - pad[0] - pad[2] - bord[0] - bord[2]);
      contentH = box.contentH;
      break;
    }
    case "table":
      contentH = layoutTable(box, ctx);
      break;
    case "flex":
      contentH = layoutFlex(box, ctx, explicitContentH);
      break;
    case "inline-block": {
      const res = layoutBlockChildren(box, ctx);
      contentH = res.height;
      box.baseline = res.baseline || (contentH > 0 ? contentH : 0) +
                     pad[0] + bord[0];
      break;
    }
    case "cell": {
      const res = layoutBlockChildren(box, ctx);
      contentH = res.height;
      break;
    }
    default:
      contentH = layoutBlockChildren(box, ctx).height;
      break;
  }

  if (explicitContentH !== null)
    box.contentH = explicitContentH;
  else
    box.contentH = contentH;

  box.h = box.contentH + extraY;

  /* Absolute descendants are laid out once the containing block is known. */
  if (box.absolutes && box.absolutes.length) {
    const cb = {
      x: box.contentX, y: box.contentY,
      w: box.contentW, h: box.contentH,
    };
    for (const item of box.absolutes)
      layoutAbsolute(item, cb, ctx);
  }

  return box;
}

function translate(box, dx, dy) {
  if (!dx && !dy)
    return;
  box.x += dx;
  box.y += dy;
  box.contentX += dx;
  box.contentY += dy;
  for (const line of box.lines) {
    line.y += dy;
    line.baseline += dy;
    for (const item of line.items) {
      item.x += dx;
      if (item.type === "box") {
        /* child translated below */
      } else {
        item.baseline += dy;
      }
    }
  }
  for (const child of box.children) {
    if (child.kind !== "text")
      translate(child, dx, dy);
  }
}

/* ----------------------------------------------------------- block content */

function layoutBlockChildren(box, ctx) {
  const style = box.style;
  const contentX = box.contentX;
  const contentW = box.contentW;
  let y = box.contentY;
  const lines = box.lines;
  let prevBottom = 0;
  let hasContent = false;
  const floats = { left: [], right: [] };
  const absolutes = [];
  box.floats = floats;

  const builder = new LineBuilder(box, ctx, floats);
  builder.y = y;

  const flushInline = () => {
    const had = builder.hasItems();
    if (had)
      builder.flush();
    /* A <br> or an empty line can advance the builder without producing
     * items, so take its position when it moved past the block flow. */
    if (builder.y > y)
      y = builder.y;
    if (had || y > box.contentY)
      hasContent = true;
    prevBottom = 0;
  };

  for (const child of box.children) {
    if (child.kind === "text") {
      if (!child.text)
        continue;
      builder.addText(child.text, child.style);
      continue;
    }
    const cs = child.style;
    if (cs.display === "none")
      continue;

    /* Absolute / fixed positioning is deferred. */
    if (cs.position === "absolute" || cs.position === "fixed") {
      absolutes.push({
        box: child,
        staticX: builder.currentX(),
        staticY: builder.y,
      });
      continue;
    }

    /* Floats. */
    if (cs.float === "left" || cs.float === "right") {
      flushInline();
      const side = cs.float;
      const max = intrinsicWidth(child, "max", ctx);
      const min = intrinsicWidth(child, "min", ctx);
      const w = Math.max(min, Math.min(max, contentW));
      const margin = marginsOf(cs, contentW);
      const list = floats[side];
      let fy = y;
      for (const f of list)
        fy = Math.max(fy, f.y + f.h);
      const fx = side === "right" ?
        contentX + contentW - w - margin[3] - margin[1] :
        contentX + margin[3];
      layoutBox(child, fx, fy, w, ctx, { forceWidth: w });
      const outerH = child.h + margin[0] + margin[2];
      list.push({ x: fx, y: fy, w: w, h: outerH });
      if (fy + outerH > y)
        y = fy + outerH;
      builder.y = y;
      builder.beginLine();
      continue;
    }

    const isBlock = child.kind === "block" || child.kind === "flex" ||
                    child.kind === "table" || child.kind === "row" ||
                    child.kind === "cell";

    if (isBlock) {
      flushInline();
      const margin = marginsOf(cs, contentW);
      let gap = hasContent ? Math.max(prevBottom, margin[0]) : margin[0];
      if (!hasContent && margin[0] < 0)
        gap = margin[0];
      y += gap;
      layoutBox(child, contentX + margin[3], y, contentW, ctx, {});
      y = child.y + child.h;
      prevBottom = margin[2];
      hasContent = true;
      /* Inline content after this block starts below it. */
      builder.y = y;
      builder.beginLine();
    } else {
      builder.addBox(child);
    }
  }

  flushInline();

  /* Floats may extend the content height. */
  for (const side of ["left", "right"]) {
    for (const f of floats[side]) {
      if (f.y + f.h > y)
        y = f.y + f.h;
    }
  }

  if (absolutes.length)
    box.absolutes = absolutes;

  return { height: Math.max(0, y - box.contentY),
           baseline: builder.lastBaseline - box.contentY };
}

/* ------------------------------------------------------------- line boxes */

class LineBuilder {
  constructor(box, ctx, floats) {
    this.box = box;
    this.ctx = ctx;
    this.floats = floats || { left: [], right: [] };
    this.y = box.contentY;
    this.items = [];
    this.x = box.contentX;
    this.startX = box.contentX;
    this.right = box.contentX + box.contentW;
    this.availWidth = box.contentW;
    this.maxAscent = 0;
    this.maxDescent = 0;
    this.lineHeight = 0;
    this.lastBaseline = box.contentY;
    this.allowBreak = box.style.whiteSpace !== "nowrap";
    this.textIndent = box.style.textIndent || 0;
    this.firstLine = true;
    this.blockBox = box;
  }

  hasItems() { return this.items.length > 0; }

  currentX() {
    return this.items.length ? this.x : this.startX;
  }

  beginLine() {
    const b = this.box;
    let left = b.contentX;
    let right = b.contentX + b.contentW;
    const band = this.y;
    for (const f of this.floats.left) {
      if (band >= f.y && band < f.y + f.h)
        left = Math.max(left, f.x + f.w);
    }
    for (const f of this.floats.right) {
      if (band >= f.y && band < f.y + f.h)
        right = Math.min(right, f.x);
    }
    if (right < left)
      right = left;
    this.startX = left + (this.firstLine ? this.textIndent : 0);
    this.x = this.startX;
    this.right = right;
    this.availWidth = Math.max(0, right - this.startX);
    this.items = [];
    this.maxAscent = 0;
    this.maxDescent = 0;
    this.lineHeight = 0;
  }

  addText(text, style) {
    if (!text)
      return;
    if (style.whiteSpace === "pre" || style.whiteSpace === "pre-wrap") {
      const parts = text.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) this.newline(style.lineHeight);
        if (parts[i])
          this.pushWord(parts[i], style, false);
      }
      return;
    }
    const re = new RegExp(TEXT_SPLIT.source, "g");
    let m;
    while ((m = re.exec(text))) {
      if (m[1]) {
        this.pushSpace(style);
      } else if (m[2]) {
        this.pushWord(m[2], style, this.allowBreak);
      }
    }
  }

  pushSpace(style) {
    /* Collapse runs of whitespace and drop leading spaces. */
    if (!this.items.length)
      return;
    const last = this.items[this.items.length - 1];
    if (last.type === "space")
      return;
    this.items.push({ type: "space", width: spaceWidth(this.ctx, style),
                      style });
  }

  pushWord(text, style, breakable) {
    const shape = shapeText(this.ctx, text, style);
    const ls = style.letterSpacing || 0;
    const width = shape.width + ls * text.length;
    if (!this.items.length)
      this.beginLine();
    if (breakable && this.x + width > this.right && this.items.length &&
        this.x > this.startX) {
      this.flush();
      this.beginLine();
    }
    const item = {
      type: "text", text, style, shape, width,
      letterSpacing: ls,
      x: this.x,
      ascent: shape.ascent,
      descent: shape.descent,
      lineHeight: style.lineHeight,
    };
    this.items.push(item);
    this.x += width;
    this.maxAscent = Math.max(this.maxAscent, shape.ascent);
    this.maxDescent = Math.max(this.maxDescent, shape.descent);
    this.lineHeight = Math.max(this.lineHeight, style.lineHeight);
    /* A word longer than the line still occupies it. */
  }

  addBox(box) {
    if (box.kind === "br") {
      this.newline(box.style.lineHeight);
      return;
    }
    if (!this.items.length)
      this.beginLine();

    if (box.kind === "inline-block") {
      const max = intrinsicWidth(box, "max", this.ctx);
      const min = intrinsicWidth(box, "min", this.ctx);
      const avail = Math.max(0, this.right - this.x);
      let w = Math.max(min, Math.min(max, avail));
      /* Explicit CSS width overrides shrink-to-fit. */
      if (box.style.width !== "auto") {
        const v = resolveLength(box.style.width, this.box.contentW, 0);
        if (typeof v === "number") {
          const extra = paddingOf(box.style, 0)[1] +
                        paddingOf(box.style, 0)[3] +
                        borderBoxes(box.style)[1] + borderBoxes(box.style)[3];
          w = box.style.boxSizing === "border-box" ? v : v + extra;
        }
      }
      layoutBox(box, 0, 0, Math.max(w, min), this.ctx,
                { forceWidth: w });
      const margin = marginsOf(box.style, this.box.contentW);
      const outerW = box.w + margin[1] + margin[3];
      if (this.allowBreak && this.x + outerW > this.right &&
          this.items.length && this.x > this.startX) {
        this.flush();
        this.beginLine();
      }
      /* Lay the inline-block out relative to the line origin, then shift it
       * into place; translate keeps children coordinates consistent. */
      const bx = box.x;
      const by = box.y;
      translate(box, this.x + margin[3] - bx, 0 - by);
      const ascent = box.baseline || box.h;
      const descent = Math.max(0, box.h - ascent);
      this.items.push({ type: "box", box, x: box.x, width: outerW, ascent,
                        descent,
                        lineHeight: Math.max(box.h, box.style.lineHeight || 0),
                        margin });
      this.x += outerW;
      this.maxAscent = Math.max(this.maxAscent, ascent);
      this.maxDescent = Math.max(this.maxDescent, descent);
      this.lineHeight = Math.max(this.lineHeight,
        Math.max(box.h, box.style.lineHeight || 0));
      return;
    }

    if (box.kind === "replaced" || box.kind === "input") {
      const margin = marginsOf(box.style, this.box.contentW);
      const max = intrinsicWidth(box, "max", this.ctx);
      const avail = Math.max(0, this.right - this.x);
      let w = max;
      if (box.style.width !== "auto") {
        const v = resolveLength(box.style.width, this.box.contentW, 0);
        if (typeof v === "number")
          w = box.style.boxSizing === "border-box" ? v :
              v + paddingOf(box.style, 0)[1] + paddingOf(box.style, 0)[3] +
              borderBoxes(box.style)[1] + borderBoxes(box.style)[3];
      }
      layoutBox(box, 0, 0, Math.min(w, Math.max(avail, 0)), this.ctx,
                { forceWidth: w });
      const outerW = box.w + margin[1] + margin[3];
      if (this.allowBreak && this.x + outerW > this.right &&
          this.items.length && this.x > this.startX) {
        this.flush();
        this.beginLine();
      }
      const ascent = box.h;
      this.items.push({ type: "box", box, x: this.x + margin[3], width: outerW,
                        ascent, descent: 0,
                        lineHeight: box.h, margin });
      this.x += outerW;
      this.maxAscent = Math.max(this.maxAscent, ascent);
      this.lineHeight = Math.max(this.lineHeight, box.h);
      return;
    }

    /* Inline element: flatten its children into this line. */
    const prevStyle = this.box.style;
    for (const child of box.children) {
      if (child.kind === "text") {
        this.addText(child.text, child.style);
      } else if (child.kind === "block" || child.kind === "flex" ||
                 child.kind === "table") {
        /* Invalid block inside inline: end the line and lay it out. */
        this.flush();
        layoutBox(child, this.box.contentX, this.y, this.box.contentW,
                  this.ctx, {});
        this.y = child.y + child.h;
        this.beginLine();
      } else {
        this.addBox(child);
      }
    }
    this.box.style = prevStyle;
  }

  newline(lineHeight) {
    if (this.items.length) {
      this.flush();
    } else {
      this.y += Math.max(0, lineHeight || 0);
      this.beginLine();
    }
    this.firstLine = false;
  }

  flush() {
    if (!this.items.length) {
      this.beginLine();
      return;
    }
    const lineHeight = Math.max(0, this.lineHeight ||
                                this.maxAscent + this.maxDescent);
    const align = this.box.style.textAlign;
    let penWidth = this.x - this.startX;
    if (this.items[this.items.length - 1].type === "space") {
      const sp = this.items.pop();
      penWidth -= sp.width;
    }
    let shift = 0;
    if (align === "center")
      shift = (this.availWidth - penWidth) / 2;
    else if (align === "right" || align === "end")
      shift = this.availWidth - penWidth;
    if (shift < 0) shift = 0;

    /* Baseline from half-leading of every inline box. Spaces carry no ink
     * and have no ascent/descent; skip them. */
    let baseline = 0;
    for (const item of this.items) {
      if (item.type === "space")
        continue;
      const lh = item.lineHeight || lineHeight;
      const half = (lh - item.ascent - item.descent) / 2;
      baseline = Math.max(baseline, item.ascent + Math.max(0, half));
    }
    const lineTop = this.y;
    const out = [];
    for (const item of this.items) {
      if (item.type === "text") {
        out.push({
          type: "text", text: item.text, style: item.style,
          shape: item.shape, letterSpacing: item.letterSpacing,
          x: item.x + shift,
          baseline: lineTop + baseline,
        });
      } else if (item.type === "space") {
        /* Spaces need no glyph. */
      } else {
        const box = item.box;
        let dy;
        const va = box.style.verticalAlign;
        if (va === "middle") {
          dy = lineTop + (lineHeight - box.h) / 2 - box.y;
        } else if (va === "top" || va === "text-top") {
          dy = lineTop - box.y;
        } else if (va === "bottom" || va === "text-bottom") {
          dy = lineTop + lineHeight - box.h - box.y;
        } else {
          dy = lineTop + baseline - item.ascent - box.y;
        }
        translate(box, item.x + shift - box.x, dy);
        out.push({ type: "box", box });
      }
    }

    this.box.lines.push({
      y: lineTop,
      height: lineHeight,
      baseline: lineTop + baseline,
      width: penWidth,
      items: out,
    });
    this.lastBaseline = lineTop + baseline;
    this.y = lineTop + lineHeight;
    this.items = [];
    this.maxAscent = 0;
    this.maxDescent = 0;
    this.lineHeight = 0;
    this.firstLine = false;
    this.beginLine();
  }
}

/* -------------------------------------------------------------- flexboxes */

function layoutFlex(box, ctx, explicitContentH) {
  const contentX = box.contentX;
  const contentY = box.contentY;
  const contentW = box.contentW;
  const items = [];
  for (const child of box.children) {
    if (child.kind === "text") {
      if (child.text.trim())
        items.push({ box: child, text: true });
      continue;
    }
    if (child.style.display === "none")
      continue;
    items.push({ box: child });
  }

  let total = 0;
  for (const item of items) {
    const box2 = item.box;
    const margin = marginsOf(box2.style, contentW);
    let base;
    if (item.text) {
      base = intrinsicWidth(box2, "max", ctx);
    } else if (box2.style.flexBasis !== "auto" &&
               typeof box2.style.flexBasis === "number") {
      base = box2.style.flexBasis;
    } else if (box2.style.width !== "auto") {
      const v = resolveLength(box2.style.width, contentW, 0);
      const extra = paddingOf(box2.style, contentW)[1] +
                    paddingOf(box2.style, contentW)[3] +
                    borderBoxes(box2.style)[1] + borderBoxes(box2.style)[3];
      base = typeof v === "number" ?
        (box2.style.boxSizing === "border-box" ? v : v + extra) : 0;
    } else {
      base = intrinsicWidth(box2, "max", ctx);
    }
    item.base = base;
    item.margin = margin;
    total += base + margin[1] + margin[3];
  }

  let extra = contentW - total;
  if (extra > 0) {
    let grow = 0;
    for (const item of items)
      grow += item.box.style.flexGrow || 0;
    if (grow > 0) {
      for (const item of items)
        item.base += extra * (item.box.style.flexGrow || 0) / grow;
      extra = 0;
    }
  } else if (extra < 0) {
    let weight = 0;
    for (const item of items)
      weight += (item.box.style.flexShrink !== undefined ?
                 item.box.style.flexShrink : 1) * item.base;
    if (weight > 0) {
      for (const item of items) {
        const shrink = (item.box.style.flexShrink !== undefined ?
                        item.box.style.flexShrink : 1) * item.base;
        item.base = Math.max(0, item.base + extra * shrink / weight);
      }
    }
    extra = 0;
  }

  const justify = box.style.justifyContent;
  let x = contentX;
  if (justify === "flex-end" || justify === "end")
    x += extra;
  else if (justify === "center")
    x += extra / 2;

  const laid = [];
  for (const item of items) {
    const b = item.box;
    x += item.margin[3];
    if (item.text) {
      b.x = x;
      b.y = contentY;
    } else {
      layoutBox(b, x, contentY, item.base, ctx, { forceWidth: item.base });
    }
    laid.push({ item, x, h: b.h });
    x += item.base + item.margin[1];
  }

  let lineH = 0;
  for (const l of laid)
    lineH = Math.max(lineH, l.h + l.item.margin[0] + l.item.margin[2]);

  const align = box.style.alignItems;
  for (const l of laid) {
    const margin = l.item.margin;
    let dy = margin[0];
    if (align === "center")
      dy += (lineH - l.h - margin[0] - margin[2]) / 2;
    else if (align === "flex-end" || align === "end")
      dy += lineH - l.h - margin[0] - margin[2];
    if (!l.item.text)
      translate(l.item.box, 0, dy);
  }
  return explicitContentH !== null ? explicitContentH : lineH;
}

/* ----------------------------------------------------------------- tables */

function layoutTable(box, ctx) {
  const style = box.style;
  const contentX = box.contentX;
  let contentY = box.contentY;
  const contentW = box.contentW;
  const spacing = box.el && box.el.attrs.cellspacing !== undefined
    ? parseFloat(box.el.attrs.cellspacing) || 0
    : (typeof style.borderSpacing === "number" ? style.borderSpacing : 0);
  const cellpadding = box.el && box.el.attrs.cellpadding !== undefined ?
    parseFloat(box.el.attrs.cellpadding) : null;
  const rows = box.children.filter((c) => c.kind === "row");
  if (!rows.length)
    return 0;

  let cols = 0;
  for (const row of rows)
    cols = Math.max(cols, row.children.filter((c) => c.kind === "cell").length);

  const widths = new Array(cols).fill(null);
  for (const row of rows) {
    const cells = row.children.filter((c) => c.kind === "cell");
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      if (widths[i] !== null)
        continue;
      if (cell.style.width !== "auto") {
        const v = resolveLength(cell.style.width, contentW, null);
        if (typeof v === "number")
          widths[i] = v;
      }
    }
  }
  let fixed = 0, autoCount = 0;
  for (let i = 0; i < cols; i++) {
    if (widths[i] === null) autoCount++;
    else fixed += widths[i];
  }
  const remaining = contentW - fixed - spacing * (cols + 1);
  const autoWidth = autoCount > 0 ? Math.max(0, remaining / autoCount) : 0;
  for (let i = 0; i < cols; i++)
    if (widths[i] === null)
      widths[i] = autoWidth;

  let y = contentY + spacing;
  for (const row of rows) {
    const cells = row.children.filter((c) => c.kind === "cell");
    row.x = contentX + spacing;
    row.y = y;
    row.w = contentW - spacing * 2;
    let x = contentX + spacing;
    let rowH = 0;
    const valign = (row.el && row.el.attrs.valign) ||
                   (row.style.verticalAlign === "middle" ? "middle" : "top");
    const placed = [];
    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const w = widths[i] || autoWidth;
      if (cellpadding !== null) {
        cell.style.padding = [cellpadding, cellpadding, cellpadding, cellpadding];
        cell.style.border = cell.style.border.map((b) => ({ ...b }));
      }
      layoutBox(cell, x, y, w, ctx, { forceWidth: w });
      placed.push(cell);
      rowH = Math.max(rowH, cell.h);
      x += w + spacing;
    }
    for (const cell of placed) {
      let dy = 0;
      if (valign === "middle")
        dy = (rowH - cell.h) / 2;
      else if (valign === "bottom")
        dy = rowH - cell.h;
      if (dy)
        translate(cell, 0, dy);
    }
    row.h = rowH;
    y += rowH + spacing;
  }
  return Math.max(0, y - contentY);
}

/* ------------------------------------------------------ absolute positioning */

function layoutAbsolute(item, cb, ctx) {
  const box = item.box;
  const style = box.style;
  let w;
  let forceWidth;
  const left = style.left !== "auto" ? resolveLength(style.left, cb.w, null) : null;
  const right = style.right !== "auto" ? resolveLength(style.right, cb.w, null) : null;
  const top = style.top !== "auto" ? resolveLength(style.top, cb.h, null) : null;
  const bottom = style.bottom !== "auto" ? resolveLength(style.bottom, cb.h, null) : null;

  if (style.width !== "auto") {
    const v = resolveLength(style.width, cb.w, 0);
    const extra = paddingOf(style, cb.w)[1] + paddingOf(style, cb.w)[3] +
                  borderBoxes(style)[1] + borderBoxes(style)[3];
    w = typeof v === "number" ?
      (style.boxSizing === "border-box" ? v : v + extra) : 0;
    forceWidth = w;
  } else if (left !== null && right !== null) {
    w = Math.max(0, cb.w - left - right);
    forceWidth = w;
  } else {
    w = Math.min(intrinsicWidth(box, "max", ctx), cb.w);
    forceWidth = undefined;
  }

  layoutBox(box, 0, 0, w, ctx,
            forceWidth !== undefined ? { forceWidth } : {});
  let x;
  if (left !== null)
    x = cb.x + left;
  else if (right !== null)
    x = cb.x + cb.w - right - box.w;
  else
    x = item.staticX;
  let y;
  if (top !== null)
    y = cb.y + top;
  else if (bottom !== null)
    y = cb.y + cb.h - bottom - box.h;
  else
    y = item.staticY;
  translate(box, x - box.x, y - box.y);
}
