/*
 * css.js - stylesheet parsing, selector matching and the cascade.
 *
 * The implementation targets the CSS a real content page uses: rule lists,
 * class/id/tag/descendant/child selectors, a few structural pseudo-classes,
 * attribute selectors, media queries restricted by viewport width, inline
 * styles and the common shorthands (margin, padding, border, background,
 * font). Longhands are resolved to absolute px where the value allows it.
 */

/* ------------------------------------------------------------------ utils */

const NAMED_COLORS = {
  transparent: [0, 0, 0, 0], black: [0, 0, 0, 1], white: [255, 255, 255, 1],
  red: [255, 0, 0, 1], green: [0, 128, 0, 1], blue: [0, 0, 255, 1],
  yellow: [255, 255, 0, 1], gray: [128, 128, 128, 1], grey: [128, 128, 128, 1],
  silver: [192, 192, 192, 1], maroon: [128, 0, 0, 1], olive: [128, 128, 0, 1],
  lime: [0, 255, 0, 1], aqua: [0, 255, 255, 1], teal: [0, 128, 128, 1],
  navy: [0, 0, 128, 1], fuchsia: [255, 0, 255, 1], purple: [128, 0, 128, 1],
  orange: [255, 165, 0, 1], transparentblack: [0, 0, 0, 0],
  lightgray: [211, 211, 211, 1], lightgrey: [211, 211, 211, 1],
  darkgray: [169, 169, 169, 1], darkgrey: [169, 169, 169, 1],
  dimgray: [105, 105, 105, 1], whitesmoke: [245, 245, 245, 1],
  gainsboro: [220, 220, 220, 1], snow: [255, 250, 250, 1],
  royalblue: [65, 105, 225, 1], steelblue: [70, 130, 180, 1],
  dodgerblue: [30, 144, 255, 1], cornflowerblue: [100, 149, 237, 1],
  crimson: [220, 20, 60, 1], tomato: [255, 99, 71, 1],
  gold: [255, 215, 0, 1], khaki: [240, 230, 140, 1],
  beige: [245, 245, 220, 1], ivory: [255, 255, 240, 1],
  aliceblue: [240, 248, 255, 1], azure: [240, 255, 255, 1],
  lavender: [230, 230, 250, 1], pink: [255, 192, 203, 1],
  salmon: [250, 128, 114, 1], coral: [255, 127, 80, 1],
  brown: [165, 42, 42, 1], chocolate: [210, 105, 30, 1],
  tan: [210, 180, 140, 1], wheat: [245, 222, 179, 1],
};

/** Parse a CSS colour into {r,g,b,a} with a in 0..1. */
export function parseColor(value) {
  if (value == null)
    return null;
  const v = String(value).trim().toLowerCase();
  if (!v)
    return null;
  if (v[0] === "#") {
    let hex = v.slice(1);
    if (hex.length === 3 || hex.length === 4)
      hex = hex.split("").map((c) => c + c).join("");
    if (hex.length !== 6 && hex.length !== 8)
      return null;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }
  const fn = /^rgba?\(([^)]*)\)$/.exec(v);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter((s) => s.length);
    if (parts.length < 3)
      return null;
    const channel = (s) => s.endsWith("%") ?
      Math.round(parseFloat(s) * 2.55) : parseFloat(s);
    const alpha = parts.length > 3 ?
      (parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3])) : 1;
    return {
      r: Math.max(0, Math.min(255, channel(parts[0]))),
      g: Math.max(0, Math.min(255, channel(parts[1]))),
      b: Math.max(0, Math.min(255, channel(parts[2]))),
      a: Math.max(0, Math.min(1, alpha === alpha ? alpha : 1)),
    };
  }
  const named = NAMED_COLORS[v];
  if (named)
    return { r: named[0], g: named[1], b: named[2], a: named[3] };
  return null;
}

/**
 * Parse a CSS length. Returns a number of px, a percentage string like
 * "25%", or the keyword (auto/normal/none/inherit).
 */
export function parseLength(value, fontSize, rootFontSize) {
  if (value == null)
    return null;
  const v = String(value).trim().toLowerCase();
  if (!v)
    return null;
  if (v === "0")
    return 0;
  let m = /^(-?[\d.]+)px$/.exec(v);
  if (m) return parseFloat(m[1]);
  m = /^(-?[\d.]+)(pt|pc|in|cm|mm|q)$/.exec(v);
  if (m) {
    const n = parseFloat(m[1]);
    const factor = { pt: 4 / 3, pc: 16, in: 96, cm: 96 / 2.54,
                     mm: 96 / 25.4, q: 96 / 101.6 }[m[2]];
    return n * factor;
  }
  m = /^(-?[\d.]+)(em|rem|ex|ch)$/.exec(v);
  if (m) {
    const n = parseFloat(m[1]);
    const base = m[2] === "rem" ? (rootFontSize || 16) :
                 m[2] === "ex" || m[2] === "ch" ? (fontSize || 16) * 0.5 :
                 (fontSize || 16);
    return n * base;
  }
  m = /^(-?[\d.]+)%$/.exec(v);
  if (m) return parseFloat(m[1]) + "%";
  if (/^[\d.]+$/.test(v)) return parseFloat(v); /* unitless: treat as px */
  return v;
}

/* -------------------------------------------------------------- selectors */

function parseCompound(text) {
  const part = { tag: null, id: null, classes: [], attrs: [], pseudos: [] };
  let i = 0;
  const s = text;
  const ident = () => {
    const start = i;
    while (i < s.length && /[\w-]/.test(s[i])) i++;
    return s.slice(start, i);
  };
  if (s[i] === "*") {
    i++;
  } else if (/[a-zA-Z]/.test(s[i] || "")) {
    part.tag = ident().toLowerCase();
  }
  while (i < s.length) {
    const ch = s[i];
    if (ch === "#") {
      i++;
      part.id = ident();
    } else if (ch === ".") {
      i++;
      const cls = ident();
      if (cls) part.classes.push(cls);
    } else if (ch === "[") {
      const end = s.indexOf("]", i);
      if (end < 0) break;
      const body = s.slice(i + 1, end).trim();
      const m = /^([\w-]+)\s*(?:([~|^$*]?=)\s*("?)(.*?)\3)?$/.exec(body);
      if (m)
        part.attrs.push({ name: m[1].toLowerCase(), op: m[2] || null,
                          value: m[4] || "" });
      i = end + 1;
    } else if (ch === ":") {
      i++;
      const pseudoElement = s[i] === ":";
      if (pseudoElement) i++;
      const name = ident().toLowerCase();
      let arg = null;
      if (s[i] === "(") {
        let depth = 1, j = i + 1, q = 0;
        while (j < s.length && depth) {
          if (s[j] === '"' || s[j] === "'") q = q ? 0 : s[j];
          else if (!q && s[j] === "(") depth++;
          else if (!q && s[j] === ")") depth--;
          j++;
        }
        arg = s.slice(i + 1, j - 1);
        i = j;
      }
      part.pseudos.push({ name, arg, element: pseudoElement });
    } else {
      i++;
    }
  }
  return part;
}

function parseSelector(text) {
  const tokens = [];
  let cur = "";
  let depth = 0;
  const pushCompound = () => {
    if (cur.trim()) tokens.push({ compound: cur.trim(), combinator: null });
    cur = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && /\s/.test(ch)) {
      pushCompound();
      continue;
    }
    if (depth === 0 && ch === ">") {
      pushCompound();
      if (tokens.length) tokens[tokens.length - 1].combinator = ">";
      continue;
    }
    if (depth === 0 && (ch === "+" || ch === "~")) {
      pushCompound();
      if (tokens.length) tokens[tokens.length - 1].combinator = ch;
      continue;
    }
    cur += ch;
  }
  pushCompound();
  if (!tokens.length)
    return null;
  /* Stored left-to-right; matching proceeds from the right. */
  return {
    parts: tokens.map((t) => parseCompound(t.compound)),
    combinators: tokens.map((t) => t.combinator),
  };
}

function specificityOf(sel) {
  let a = 0, b = 0, c = 0;
  for (const p of sel.parts) {
    if (p.id) a++;
    b += p.classes.length + p.attrs.length +
         p.pseudos.filter((x) => !x.element && x.name !== "not").length;
    if (p.tag) c++;
    for (const ps of p.pseudos) {
      if (ps.element) c++;
      if (ps.name === "not" && ps.arg) {
        const inner = parseSelectorList(ps.arg);
        let best = 0;
        for (const s of inner) {
          const sp = specificityOf(s);
          const v = sp[0] * 10000 + sp[1] * 100 + sp[2];
          if (v > best) best = v;
        }
        b += Math.floor(best / 100) % 100;
        a += Math.floor(best / 10000);
        c += best % 100;
      }
    }
  }
  return [a, b, c];
}

function parseSelectorList(text) {
  const out = [];
  let depth = 0, cur = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      const sel = parseSelector(cur);
      if (sel) out.push(sel);
      cur = "";
    } else {
      cur += ch;
    }
  }
  const sel = parseSelector(cur);
  if (sel) out.push(sel);
  return out;
}

function elementSiblings(el) {
  return el.parent && el.parent.type === "element" ? el.parent.children : [];
}

function elementIndex(el) {
  const sibs = elementSiblings(el).filter((c) => c.type === "element");
  return sibs.indexOf(el);
}

function matchNth(arg, index) {
  const a = String(arg || "").trim().toLowerCase();
  if (a === "odd") return index % 2 === 1;
  if (a === "even") return index % 2 === 0;
  let m = /^(-?\d+)$/.exec(a);
  if (m) return index === parseInt(m[1], 10);
  m = /^(-?\d*)n\s*([+-]\s*\d+)?$/.exec(a.replace(/\s+/g, ""));
  if (m) {
    const step = m[1] === "" || m[1] === "+" ? 1 :
                 m[1] === "-" ? -1 : parseInt(m[1], 10);
    let offset = m[2] ? parseInt(m[2], 10) : 0;
    if (step === 0)
      return index === offset;
    const k = (index - offset) / step;
    return k >= 0 && Number.isInteger(k);
  }
  return false;
}

function matchPseudo(el, ps) {
  if (ps.element)
    return false;
  const idx = elementIndex(el) + 1;
  switch (ps.name) {
    case "root": return el.tag === "html";
    case "link": return el.tag === "a" && el.attrs.href !== undefined;
    case "first-child": return idx === 1;
    case "last-child": {
      const sibs = elementSiblings(el).filter((c) => c.type === "element");
      return idx === sibs.length;
    }
    case "only-child": {
      const sibs = elementSiblings(el).filter((c) => c.type === "element");
      return sibs.length === 1;
    }
    case "empty":
      return el.children.every((c) => c.type === "text" && !c.text.trim());
    case "nth-child":
      return matchNth(ps.arg, idx);
    case "not": {
      const list = parseSelectorList(ps.arg || "");
      return !list.some((s) => matchSelector(el, s));
    }
    /* Interactive states never match a static render. */
    case "hover": case "active": case "focus": case "focus-within":
    case "focus-visible": case "visited": case "target": case "checked":
    case "disabled": case "enabled": case "invalid": case "valid":
      return false;
    default:
      return false;
  }
}

function matchCompound(el, part) {
  if (part.tag && el.tag !== part.tag)
    return false;
  if (part.id && el.attrs.id !== part.id)
    return false;
  for (const cls of part.classes) {
    const have = (el.attrs.class || "").split(/\s+/);
    if (!have.includes(cls))
      return false;
  }
  for (const a of part.attrs) {
    const v = el.attrs[a.name];
    if (v === undefined)
      return false;
    if (!a.op)
      continue;
    if (a.op === "=" && v !== a.value) return false;
    if (a.op === "~=" && !v.split(/\s+/).includes(a.value)) return false;
    if (a.op === "^=" && !v.startsWith(a.value)) return false;
    if (a.op === "$=" && !v.endsWith(a.value)) return false;
    if (a.op === "*=" && v.indexOf(a.value) < 0) return false;
    if (a.op === "|=" && v !== a.value && !v.startsWith(a.value + "-")) return false;
  }
  for (const ps of part.pseudos)
    if (!matchPseudo(el, ps))
      return false;
  return true;
}

/** Does `el` match the parsed selector? */
export function matchSelector(el, sel) {
  const last = sel.parts.length - 1;
  if (!matchCompound(el, sel.parts[last]))
    return false;
  let node = el;
  let index = last - 1;
  while (index >= 0) {
    const combinator = sel.combinators[index] || " ";
    const part = sel.parts[index];
    if (combinator === ">") {
      node = node.parent;
      if (!node || node.type !== "element" || !matchCompound(node, part))
        return false;
    } else if (combinator === "+") {
      const sibs = elementSiblings(node).filter((c) => c.type === "element");
      const i = sibs.indexOf(node);
      node = i > 0 ? sibs[i - 1] : null;
      if (!node || !matchCompound(node, part))
        return false;
    } else if (combinator === "~") {
      const sibs = elementSiblings(node).filter((c) => c.type === "element");
      const i = sibs.indexOf(node);
      let found = null;
      for (let k = i - 1; k >= 0; k--)
        if (matchCompound(sibs[k], part)) { found = sibs[k]; break; }
      if (!found)
        return false;
      node = found;
    } else {
      let found = null;
      for (let p = node.parent; p && p.type === "element"; p = p.parent) {
        if (matchCompound(p, part)) { found = p; break; }
      }
      if (!found)
        return false;
      node = found;
    }
    index--;
  }
  return true;
}

/* ----------------------------------------------------------- declarations */

/** Split a declaration block on top-level semicolons. */
export function splitDeclarations(text) {
  const out = [];
  let cur = "", depth = 0, quote = 0;
  for (const ch of text) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = 0;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "(") {
      depth++; cur += ch;
    } else if (ch === ")") {
      depth--; cur += ch;
    } else if (ch === ";" && depth === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim())
    out.push(cur.trim());
  return out;
}

function parseDeclarations(text) {
  const out = [];
  for (const part of splitDeclarations(text)) {
    const colon = part.indexOf(":");
    if (colon < 0)
      continue;
    const prop = part.slice(0, colon).trim().toLowerCase();
    let value = part.slice(colon + 1).trim();
    if (!prop || !value)
      continue;
    let important = false;
    if (/!\s*important$/i.test(value)) {
      important = true;
      value = value.replace(/!\s*important$/i, "").trim();
    }
    out.push({ prop, value, important });
  }
  return out;
}

/* --------------------------------------------------------------- stylesheet */

/**
 * Parse a stylesheet into rules. Media blocks are flattened and evaluated
 * lazily against the viewport width.
 */
export function parseStylesheet(text, orderStart) {
  const rules = [];
  let order = orderStart || 0;

  const parseBlock = (src, media) => {
    let i = 0;
    while (i < src.length) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (i >= src.length) break;
      if (src.startsWith("/*", i)) {
        const end = src.indexOf("*/", i + 2);
        i = end < 0 ? src.length : end + 2;
        continue;
      }
      if (src[i] === "@") {
        const brace = src.indexOf("{", i);
        if (brace < 0) break;
        const prelude = src.slice(i + 1, brace).trim();
        let depth = 1, j = brace + 1;
        while (j < src.length && depth) {
          if (src[j] === "{") depth++;
          else if (src[j] === "}") depth--;
          j++;
        }
        const inner = src.slice(brace + 1, j - 1);
        const lower = prelude.toLowerCase();
        if (lower.startsWith("media")) {
          parseBlock(inner, lower.slice(5).trim());
        } else if (lower.startsWith("supports")) {
          parseBlock(inner, media);
        }
        /* @font-face, @keyframes and friends are not needed for layout. */
        i = j;
        continue;
      }
      const brace = src.indexOf("{", i);
      if (brace < 0) break;
      const selectorText = src.slice(i, brace).trim();
      let depth = 1, j = brace + 1;
      while (j < src.length && depth) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
        j++;
      }
      const body = src.slice(brace + 1, j - 1);
      const decls = parseDeclarations(body);
      if (decls.length && selectorText && !selectorText.includes("{")) {
        for (const sel of parseSelectorList(selectorText)) {
          rules.push({ selector: sel, decls, media: media || null,
                       order: order++, specificity: specificityOf(sel) });
        }
      }
      i = j;
    }
  };

  parseBlock(text, null);
  return rules;
}

/* -------------------------------------------------------- media queries */

export function mediaMatches(media, viewportWidth) {
  if (!media)
    return true;
  const m = media.toLowerCase().trim();
  if (m === "all" || m === "screen")
    return true;
  if (m.startsWith("print"))
    return false;
  let ok = true;
  const max = /max-width\s*:\s*([\d.]+)px/.exec(m);
  if (max && viewportWidth > parseFloat(max[1])) ok = false;
  const min = /min-width\s*:\s*([\d.]+)px/.exec(m);
  if (min && viewportWidth < parseFloat(min[1])) ok = false;
  return ok;
}

/* ------------------------------------------------------------------ values */

const INHERITED = [
  ["color", "color"],
  ["font-family", "fontFamily"],
  ["font-size", "fontSize"],
  ["font-style", "fontStyle"],
  ["font-weight", "fontWeight"],
  ["line-height", "lineHeight"],
  ["text-align", "textAlign"],
  ["white-space", "whiteSpace"],
  ["letter-spacing", "letterSpacing"],
  ["visibility", "visibility"],
  ["list-style-type", "listStyleType"],
  ["text-indent", "textIndent"],
];

const DEFAULT_FONT_SIZE = 16;

function splitTopLevel(value, sep) {
  const out = [];
  let cur = "", depth = 0, quote = 0;
  for (const ch of value) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = 0;
    } else if (ch === '"' || ch === "'") {
      quote = ch; cur += ch;
    } else if (ch === "(") { depth++; cur += ch; }
    else if (ch === ")") { depth--; cur += ch; }
    else if (ch === sep && depth === 0) { out.push(cur.trim()); cur = ""; }
    else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function fourSides(values, fontSize, root) {
  const v = values.map((x) => parseLength(x, fontSize, root));
  if (v.length === 1) return [v[0], v[0], v[0], v[0]];
  if (v.length === 2) return [v[0], v[1], v[0], v[1]];
  if (v.length === 3) return [v[0], v[1], v[2], v[1]];
  return [v[0], v[1], v[2], v[3]];
}

function emptyBorder() {
  return { width: 0, style: "none", color: { r: 0, g: 0, b: 0, a: 1 } };
}

function parseBorderShorthand(value, fontSize, root) {
  const border = emptyBorder();
  for (const token of splitTopLevel(value, " ")) {
    const low = token.toLowerCase();
    const len = parseLength(low, fontSize, root);
    if (typeof len === "number") {
      border.width = len;
    } else if (["none", "hidden", "solid", "dashed", "dotted", "double",
                "groove", "ridge", "inset", "outset"].includes(low)) {
      border.style = low;
    } else {
      const c = parseColor(low);
      if (c) border.color = c;
    }
  }
  if (border.style !== "none" && border.width === 0)
    border.width = 3;
  return border;
}

function parseFontShorthand(value, parentStyle) {
  const out = {};
  const parts = splitTopLevel(value, " ");
  let sizeIndex = -1;
  for (let i = 0; i < parts.length; i++) {
    if (/^[\d.]+(px|pt|em|rem|%|pc|in|cm|mm)?(\/|$)/i.test(parts[i])) {
      sizeIndex = i;
      break;
    }
  }
  if (sizeIndex < 0)
    return out;
  for (let i = 0; i < sizeIndex; i++) {
    const low = parts[i].toLowerCase();
    if (low === "italic" || low === "oblique") out["font-style"] = "italic";
    else if (low === "bold") out["font-weight"] = 700;
    else if (low === "normal") { /* default */ }
    else if (/^\d+$/.test(low)) out["font-weight"] = parseInt(low, 10);
  }
  let sizePart = parts[sizeIndex];
  let lineHeight = null;
  const slash = sizePart.indexOf("/");
  if (slash >= 0) {
    lineHeight = sizePart.slice(slash + 1);
    sizePart = sizePart.slice(0, slash);
    if (!lineHeight && parts[sizeIndex + 1]) {
      lineHeight = parts[sizeIndex + 1];
      sizeIndex++;
    }
  } else if (parts[sizeIndex + 1] && parts[sizeIndex + 1].startsWith("/")) {
    lineHeight = parts[sizeIndex + 1].slice(1);
    sizeIndex++;
  }
  out["font-size"] = parseLength(sizePart, parentStyle.fontSize,
                                 parentStyle.rootFontSize);
  if (lineHeight)
    out["line-height"] = lineHeight;
  const family = parts.slice(sizeIndex + 1).join(" ").trim();
  if (family)
    out["font-family"] = family;
  return out;
}

function parseBackgroundShorthand(value, fontSize, root) {
  const out = {};
  let rest = value.trim();
  let repeat = null, position = [], size = null;

  rest = rest.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi,
    (whole, a, b, c) => {
      out.backgroundImage = "url(" + (a || b || c || "").trim() + ")";
      return " ";
    });
  const tokens = [];
  let cur = "", depth = 0;
  for (const ch of rest + " ") {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) tokens.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  for (const token of tokens) {
    const low = token.toLowerCase();
    const color = parseColor(low);
    if (color && !/^(left|right|top|bottom|center)$/.test(low)) {
      out.backgroundColor = low;
      continue;
    }
    if (["repeat", "repeat-x", "repeat-y", "no-repeat", "space", "round"]
        .includes(low)) {
      repeat = low;
      continue;
    }
    if (["left", "right", "top", "bottom", "center"].includes(low) ||
        /^-?[\d.]+(px|%|em|pt)?$/.test(low)) {
      position.push(low);
      continue;
    }
    if (low === "/") continue;
    if (/^(auto|cover|contain)$/.test(low) || /^[\d.]+(px|%)$/.test(low)) {
      size = low;
      continue;
    }
    if (low.startsWith("linear-gradient") || low.startsWith("radial-gradient")) {
      out.backgroundImage = token;
    }
  }
  if (repeat) out.backgroundRepeat = repeat;
  if (position.length) out.backgroundPosition = position.join(" ");
  if (size) out.backgroundSize = size;
  /* The shorthand resets every longhand it does not mention. */
  out.backgroundColor = out.backgroundColor === undefined ?
    "transparent" : out.backgroundColor;
  return out;
}

/* ---------------------------------------------------------------- computed */

const DEFAULT_STYLE = {
  display: "inline",
  position: "static",
  float: "none",
  width: "auto",
  height: "auto",
  minWidth: 0,
  minHeight: 0,
  maxWidth: "none",
  maxHeight: "none",
  margin: [0, 0, 0, 0],
  padding: [0, 0, 0, 0],
  border: [emptyBorder(), emptyBorder(), emptyBorder(), emptyBorder()],
  borderRadius: 0,
  backgroundColor: null,
  backgroundImage: null,
  backgroundRepeat: "repeat",
  backgroundPosition: "0% 0%",
  backgroundSize: "auto",
  color: { r: 0, g: 0, b: 0, a: 1 },
  fontFamily: "sans-serif",
  fontSize: DEFAULT_FONT_SIZE,
  fontWeight: 400,
  fontStyle: "normal",
  lineHeight: "normal",
  textAlign: "start",
  verticalAlign: "baseline",
  whiteSpace: "normal",
  textDecoration: "none",
  letterSpacing: 0,
  textIndent: 0,
  boxSizing: "content-box",
  overflow: "visible",
  opacity: 1,
  flexDirection: "row",
  flexGrow: 0,
  flexShrink: 1,
  flexBasis: "auto",
  justifyContent: "flex-start",
  alignItems: "stretch",
  top: "auto", right: "auto", bottom: "auto", left: "auto",
  visibility: "visible",
  listStyleType: "disc",
  rootFontSize: DEFAULT_FONT_SIZE,
};

function cloneStyle(s) {
  const out = {};
  for (const k in s) {
    const v = s[k];
    if (Array.isArray(v))
      out[k] = v.map((x) => typeof x === "object" && x ? { ...x } : x);
    else if (v && typeof v === "object")
      out[k] = { ...v };
    else
      out[k] = v;
  }
  return out;
}

const UA_STYLESHEET = `
html, body, div, p, form, center, table, thead, tbody, tfoot, tr, td, th,
ul, ol, li, dl, dt, dd, h1, h2, h3, h4, h5, h6, header, footer, section,
nav, article, aside, main, figure, figcaption, blockquote, fieldset, address,
pre, hr, dir, menu { display: block }
head, script, style, link, meta, title, base, param, template { display: none }
span, a, em, b, i, strong, small, label, sub, sup, code, abbr, cite, u, s,
big, tt, font, time, mark, input, img, br, wbr, select, textarea, button {
  display: inline
}
table { display: table; border-collapse: separate; border-spacing: 2px }
tr { display: table-row }
td, th { display: table-cell; padding: 1px; vertical-align: middle }
th { font-weight: bold; text-align: center }
body { margin: 8px }
p { margin: 1em 0 }
h1 { font-size: 2em; margin: 0.67em 0; font-weight: bold }
h2 { font-size: 1.5em; margin: 0.83em 0; font-weight: bold }
h3 { font-size: 1.17em; margin: 1em 0; font-weight: bold }
h4 { margin: 1.33em 0; font-weight: bold }
h5 { font-size: 0.83em; margin: 1.67em 0; font-weight: bold }
h6 { font-size: 0.67em; margin: 2.33em 0; font-weight: bold }
b, strong { font-weight: bold }
i, em, cite, var, address { font-style: italic }
u, ins { text-decoration: underline }
s, strike, del { text-decoration: line-through }
small { font-size: 0.83em }
big { font-size: 1.17em }
center { text-align: center }
pre, code, kbd, samp, tt { font-family: monospace }
pre { white-space: pre }
hr { border: 0; border-top: 1px solid #999; margin: 0.5em auto }
ul, ol { margin: 1em 0; padding-left: 40px }
li { display: list-item }
img { display: inline }
input { display: inline-block; border: 1px solid #767676; background-color: #fff;
        color: #000; padding: 1px 2px; font-size: 13.333px; line-height: normal }
input[type=hidden] { display: none }
input[type=submit], input[type=button], input[type=reset] {
  background-color: #efefef; padding: 1px 6px; text-align: center
}
button { display: inline-block; border: 1px solid #767676;
         background-color: #efefef; padding: 1px 6px }
textarea { white-space: pre }
`;

let uaRules = null;
function getUARules() {
  if (!uaRules)
    uaRules = parseStylesheet(UA_STYLESHEET, 0);
  return uaRules;
}

function resolveVars(value, vars) {
  let out = value;
  for (let guard = 0; guard < 8 && out.includes("var("); guard++) {
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g,
      (whole, name, fallback) => {
        if (vars && Object.prototype.hasOwnProperty.call(vars, name))
          return vars[name];
        return fallback !== undefined ? fallback.trim() : "";
      });
  }
  return out;
}

function applyDeclaration(style, decl, parentStyle, rootSize, vars) {
  const prop = decl.prop;
  const value = resolveVars(decl.value, vars).trim();
  if (!value || value.startsWith("--"))
    return;

  const fs = style.fontSize;
  const root = rootSize || DEFAULT_FONT_SIZE;

  switch (prop) {
    case "display": {
      let d = value.toLowerCase();
      if (d === "-webkit-box" || d === "-webkit-flex" || d === "flex")
        d = "flex";
      else if (d === "inline-flex")
        d = "inline-flex";
      else if (d === "inline-box")
        d = "inline-block";
      else if (d === "list-item")
        d = "list-item";
      style.display = d;
      return;
    }
    case "position": style.position = value.toLowerCase(); return;
    case "float": style.float = value.toLowerCase(); return;
    case "width": style.width = parseLength(value, fs, root); return;
    case "height": style.height = parseLength(value, fs, root); return;
    case "min-width": style.minWidth = parseLength(value, fs, root); return;
    case "min-height": style.minHeight = parseLength(value, fs, root); return;
    case "max-width":
      style.maxWidth = value === "none" ? "none" : parseLength(value, fs, root);
      return;
    case "max-height":
      style.maxHeight = value === "none" ? "none" : parseLength(value, fs, root);
      return;
    case "margin":
      style.margin = fourSides(splitTopLevel(value, " "), fs, root); return;
    case "margin-top": style.margin[0] = parseLength(value, fs, root); return;
    case "margin-right": style.margin[1] = parseLength(value, fs, root); return;
    case "margin-bottom": style.margin[2] = parseLength(value, fs, root); return;
    case "margin-left": style.margin[3] = parseLength(value, fs, root); return;
    case "padding":
      style.padding = fourSides(splitTopLevel(value, " "), fs, root); return;
    case "padding-top": style.padding[0] = parseLength(value, fs, root); return;
    case "padding-right": style.padding[1] = parseLength(value, fs, root); return;
    case "padding-bottom": style.padding[2] = parseLength(value, fs, root); return;
    case "padding-left": style.padding[3] = parseLength(value, fs, root); return;
    case "border":
      style.border = [parseBorderShorthand(value, fs, root),
                      parseBorderShorthand(value, fs, root),
                      parseBorderShorthand(value, fs, root),
                      parseBorderShorthand(value, fs, root)];
      return;
    case "border-top":
      style.border[0] = parseBorderShorthand(value, fs, root); return;
    case "border-right":
      style.border[1] = parseBorderShorthand(value, fs, root); return;
    case "border-bottom":
      style.border[2] = parseBorderShorthand(value, fs, root); return;
    case "border-left":
      style.border[3] = parseBorderShorthand(value, fs, root); return;
    case "border-width": {
      const w = fourSides(splitTopLevel(value, " "), fs, root);
      for (let i = 0; i < 4; i++) if (typeof w[i] === "number") style.border[i].width = w[i];
      return;
    }
    case "border-style": {
      const s = splitTopLevel(value, " ");
      for (let i = 0; i < 4; i++) {
        const v = s.length === 1 ? s[0] : s[Math.min(i, s.length - 1)];
        style.border[i].style = v;
        if (v !== "none" && style.border[i].width === 0) style.border[i].width = 1;
      }
      return;
    }
    case "border-color": {
      const c = splitTopLevel(value, " ");
      for (let i = 0; i < 4; i++) {
        const v = parseColor(c.length === 1 ? c[0] : c[Math.min(i, c.length - 1)]);
        if (v) style.border[i].color = v;
      }
      return;
    }
    case "border-radius": {
      const first = splitTopLevel(value, "/")[0].trim().split(/\s+/)[0];
      const len = parseLength(first, fs, root);
      style.borderRadius = typeof len === "number" ? len : 0;
      return;
    }
    case "border-collapse": style.borderCollapse = value; return;
    case "border-spacing": {
      const parts = splitTopLevel(value, " ");
      style.borderSpacing = parseFloat(parts[0]) || 0;
      return;
    }
    case "background":
      Object.assign(style, parseBackgroundShorthand(value, fs, root));
      return;
    case "background-color": {
      const c = parseColor(value);
      if (c) style.backgroundColor = c;
      return;
    }
    case "background-image":
      style.backgroundImage = value === "none" ? null : value;
      return;
    case "background-repeat": style.backgroundRepeat = value; return;
    case "background-position": style.backgroundPosition = value; return;
    case "background-size": style.backgroundSize = value; return;
    case "color": {
      const c = parseColor(value);
      if (c) style.color = c;
      return;
    }
    case "font":
      for (const [k, v] of Object.entries(parseFontShorthand(value, parentStyle))) {
        if (k === "font-size")
          style.fontSize = typeof v === "number" ? v : parseLength(v, fs, root);
        else if (k === "line-height")
          style.lineHeight = parseLineHeight(v, style.fontSize);
        else if (k === "font-family")
          style.fontFamily = v;
        else
          style[k] = v;
      }
      return;
    case "font-family": style.fontFamily = value; return;
    case "font-size": {
      const size = parseLength(value, fs, root);
      if (typeof size === "number") style.fontSize = size;
      return;
    }
    case "font-weight": {
      const low = value.toLowerCase();
      if (low === "bold" || low === "bolder") style.fontWeight = 700;
      else if (low === "normal" || low === "lighter") style.fontWeight = 400;
      else if (/^\d+$/.test(low)) style.fontWeight = parseInt(low, 10);
      return;
    }
    case "font-style": style.fontStyle = value.toLowerCase(); return;
    case "line-height": style.lineHeight = parseLineHeight(value, style.fontSize); return;
    case "text-align": {
      const t = value.toLowerCase();
      if (t === "start") style.textAlign = "left";
      else if (t === "end") style.textAlign = "right";
      else if (t === "-webkit-center") style.textAlign = "center";
      else style.textAlign = t;
      return;
    }
    case "vertical-align": style.verticalAlign = value.toLowerCase(); return;
    case "white-space": style.whiteSpace = value.toLowerCase(); return;
    case "text-decoration":
      style.textDecoration = value.toLowerCase().includes("underline") ?
        "underline" : value.toLowerCase();
      return;
    case "text-decoration-line": style.textDecoration = value.toLowerCase(); return;
    case "letter-spacing": {
      const len = parseLength(value, fs, root);
      style.letterSpacing = typeof len === "number" ? len : 0;
      return;
    }
    case "text-indent": {
      const len = parseLength(value, fs, root);
      style.textIndent = typeof len === "number" ? len : 0;
      return;
    }
    case "box-sizing": style.boxSizing = value.toLowerCase(); return;
    case "overflow": case "overflow-x": case "overflow-y":
      style.overflow = value.toLowerCase();
      return;
    case "opacity": {
      const n = parseFloat(value);
      style.opacity = n === n ? Math.max(0, Math.min(1, n)) : 1;
      return;
    }
    case "flex": {
      const parts = value.split(/\s+/);
      if (parts.length === 1) {
        const n = parseFloat(parts[0]);
        if (parts[0] === "none") { style.flexGrow = 0; style.flexShrink = 0; }
        else if (!isNaN(n)) { style.flexGrow = n; style.flexShrink = 1; style.flexBasis = 0; }
      } else {
        style.flexGrow = parseFloat(parts[0]) || 0;
        style.flexShrink = parseFloat(parts[1]) || 0;
        style.flexBasis = parts[2] || "auto";
      }
      return;
    }
    case "flex-grow": style.flexGrow = parseFloat(value) || 0; return;
    case "flex-shrink": style.flexShrink = parseFloat(value) || 0; return;
    case "flex-basis": style.flexBasis = parseLength(value, fs, root); return;
    case "flex-direction": style.flexDirection = value.toLowerCase(); return;
    case "justify-content": style.justifyContent = value.toLowerCase(); return;
    case "align-items": style.alignItems = value.toLowerCase(); return;
    case "top": style.top = parseLength(value, fs, root); return;
    case "right": style.right = parseLength(value, fs, root); return;
    case "bottom": style.bottom = parseLength(value, fs, root); return;
    case "left": style.left = parseLength(value, fs, root); return;
    case "visibility": style.visibility = value.toLowerCase(); return;
    case "list-style-type": style.listStyleType = value.toLowerCase(); return;
    default:
      return;
  }
}

function parseLineHeight(value, fontSize) {
  const v = String(value).trim().toLowerCase();
  if (v === "normal" || !v) return "normal";
  if (/^[\d.]+$/.test(v)) return parseFloat(v) * fontSize;
  const len = parseLength(v, fontSize, DEFAULT_FONT_SIZE);
  return typeof len === "number" ? len : "normal";
}

function applyDeclarations(style, decls, parentStyle, rootSize, vars) {
  for (const decl of decls)
    applyDeclaration(style, decl, parentStyle, rootSize, vars);
}

/**
 * Compute the style of one element.
 * @param {Object} el parsed element
 * @param {Object} parent computed style of the parent element
 * @param {Array} rules author rules from all stylesheets
 * @param {number} viewportWidth
 */
export function computeStyle(el, parent, rules, viewportWidth) {
  const style = cloneStyle(DEFAULT_STYLE);

  /* Inheritance. */
  if (parent) {
    for (const [prop, key] of INHERITED)
      style[key] = parent[key];
    style.rootFontSize = parent.rootFontSize;
    /* Inherited custom properties. */
    if (parent.__vars) style.__vars = { ...parent.__vars };
    else style.__vars = {};
  } else {
    style.__vars = {};
  }

  const rootSize = style.rootFontSize || DEFAULT_FONT_SIZE;

  /* User-agent rules first. */
  const uaMatched = [];
  for (const rule of getUARules()) {
    if (mediaMatches(rule.media, viewportWidth) && matchSelector(el, rule.selector))
      uaMatched.push(rule);
  }
  uaMatched.sort((a, b) => compareRules(a, b));
  for (const rule of uaMatched)
    applyDeclarations(style, rule.decls, parent || style, rootSize, style.__vars);

  /* Author rules. */
  const matched = [];
  for (const rule of rules) {
    if (mediaMatches(rule.media, viewportWidth) && matchSelector(el, rule.selector))
      matched.push(rule);
  }
  matched.sort((a, b) => compareRules(a, b));

  /* Collect custom properties in cascade order first. */
  for (const rule of matched) {
    for (const decl of rule.decls) {
      if (decl.prop.startsWith("--"))
        style.__vars[decl.prop] = resolveVars(decl.value, style.__vars).trim();
    }
  }

  for (const rule of matched)
    applyDeclarations(style, rule.decls, parent || style, rootSize, style.__vars);

  /* Presentation attributes that behave like CSS. */
  const attrs = el.attrs || {};
  if (attrs.bgcolor) {
    const c = parseColor(attrs.bgcolor);
    if (c) style.backgroundColor = c;
  }
  if (attrs.width && style.width === "auto") {
    const len = parseLength(attrs.width, style.fontSize, rootSize);
    if (typeof len === "number" || (typeof len === "string" && len.endsWith("%")))
      style.width = len;
  }
  if (attrs.height && style.height === "auto") {
    const len = parseLength(attrs.height, style.fontSize, rootSize);
    if (typeof len === "number" || (typeof len === "string" && len.endsWith("%")))
      style.height = len;
  }
  if (attrs.align) {
    const a = attrs.align.toLowerCase();
    if (a === "center") style.textAlign = "center";
    else if (a === "right") style.textAlign = "right";
    else if (a === "left") style.textAlign = "left";
  }
  if (attrs.valign) style.verticalAlign = attrs.valign.toLowerCase();

  /* Inline style declarations always win. */
  if (attrs.style) {
    const inline = parseDeclarations(attrs.style);
    for (const decl of inline) {
      if (decl.prop.startsWith("--"))
        style.__vars[decl.prop] = resolveVars(decl.value, style.__vars).trim();
    }
    applyDeclarations(style, inline, parent || style, rootSize, style.__vars);
  }

  /* Line-height "normal" resolves against the final font size. */
  if (style.lineHeight === "normal")
    style.lineHeight = Math.round(style.fontSize * 1.2 * 100) / 100;

  return style;
}

function compareRules(a, b) {
  const sa = a.specificity, sb = b.specificity;
  if (sa[0] !== sb[0]) return sa[0] - sb[0];
  if (sa[1] !== sb[1]) return sa[1] - sb[1];
  if (sa[2] !== sb[2]) return sa[2] - sb[2];
  return a.order - b.order;
}

/** Resolve a length value against a reference length. */
export function resolveLength(value, reference, fallback) {
  if (typeof value === "number")
    return value;
  if (typeof value === "string" && value.endsWith("%"))
    return parseFloat(value) * reference / 100;
  if (value === "auto")
    return fallback === undefined ? 0 : fallback;
  if (typeof value === "string") {
    const n = parseFloat(value);
    return isNaN(n) ? (fallback === undefined ? 0 : fallback) : n;
  }
  return fallback === undefined ? 0 : fallback;
}

export { parseDeclarations, splitTopLevel };
