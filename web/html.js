/*
 * html.js - small, forgiving HTML parser for the qnode renderer.
 *
 * It produces the usual element/text tree and is deliberately lenient: the
 * goal is to lay out a real page, not to validate markup. Raw-text elements
 * (script/style/title/textarea) keep their contents verbatim, void elements
 * never take children, and a handful of implied end tags are handled so the
 * result resembles a browser's DOM.
 */

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
  "meta", "param", "source", "track", "wbr",
]);

const RAW = new Set(["script", "style", "title", "textarea", "xmp"]);

/* Elements that close an open <p> when they start. */
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "center", "details", "dialog",
  "dir", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu",
  "nav", "ol", "p", "pre", "section", "table", "ul",
]);

const IMPLIED = {
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  tr: ["tr"],
  td: ["td", "th"],
  th: ["td", "th"],
  option: ["option"],
  optgroup: ["optgroup"],
  thead: ["tbody", "tfoot"],
  tbody: ["thead", "tfoot"],
  tfoot: ["thead", "tbody"],
};

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  copy: "\u00a9", reg: "\u00ae", trade: "\u2122", hellip: "\u2026",
  mdash: "\u2014", ndash: "\u2013", times: "\u00d7", divide: "\u00f7",
  laquo: "\u00ab", raquo: "\u00bb", ldquo: "\u201c", rdquo: "\u201d",
  lsquo: "\u2018", rsquo: "\u2019", bull: "\u2022", middot: "\u00b7",
  deg: "\u00b0", plusmn: "\u00b1", frac12: "\u00bd", frac14: "\u00bc",
  sect: "\u00a7", para: "\u00b6", dagger: "\u2020", Dagger: "\u2021",
  euro: "\u20ac", pound: "\u00a3", yen: "\u00a5", cent: "\u00a2",
  larr: "\u2190", uarr: "\u2191", rarr: "\u2192", darr: "\u2193",
  harr: "\u2194", crarr: "\u21b5", spades: "\u2660", clubs: "\u2663",
  hearts: "\u2665", diams: "\u2666", ensp: "\u2002", emsp: "\u2003",
  thinsp: "\u2009", zwnj: "\u200c", zwj: "\u200d", shy: "\u00ad",
  aacute: "\u00e1", eacute: "\u00e9", iacute: "\u00ed", oacute: "\u00f3",
  uacute: "\u00fa", agrave: "\u00e0", egrave: "\u00e8", igrave: "\u00ec",
  ograve: "\u00f2", ugrave: "\u00f9", acirc: "\u00e2", ecirc: "\u00ea",
  icirc: "\u00ee", ocirc: "\u00f4", ucirc: "\u00fb", auml: "\u00e4",
  euml: "\u00eb", iuml: "\u00ef", ouml: "\u00f6", uuml: "\u00fc",
  ccedil: "\u00e7", ntilde: "\u00f1", szlig: "\u00df", aring: "\u00e5",
  oslash: "\u00f8", aelig: "\u00e6", thorn: "\u00fe", eth: "\u00f0",
};

/**
 * Decode the HTML character references used by real-world pages.
 * @param {string} s
 * @returns {string}
 */
export function decodeEntities(s) {
  if (s.indexOf("&") < 0)
    return s;
  return s.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?/g,
    (whole, body) => {
      if (body[0] === "#") {
        const hex = body[1] === "x" || body[1] === "X";
        const cp = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
        if (!cp || cp > 0x10ffff)
          return whole;
        return String.fromCodePoint(cp);
      }
      if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body))
        return NAMED_ENTITIES[body];
      return whole;
    });
}

/**
 * @typedef {{type:"element", tag:string, attrs:Object<string,string>,
 *            children:Array, parent:Object|null}} ElementNode
 * @typedef {{type:"text", text:string, parent:Object|null}} TextNode
 * @typedef {{type:"document", children:Array, parent:null}} DocumentNode
 */

function makeElement(tag, attrs, parent) {
  return { type: "element", tag, attrs, children: [], parent };
}

function makeText(text, parent) {
  return { type: "text", text, parent };
}

function findOpen(stack, names) {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (names.has(stack[i].tag))
      return i;
  }
  return -1;
}

/**
 * Parse an HTML document.
 * @param {string} src
 * @returns {DocumentNode}
 */
export function parseHTML(src) {
  const doc = { type: "document", children: [], parent: null };
  const stack = [doc];
  const top = () => stack[stack.length - 1];
  let i = 0;
  const n = src.length;

  const pushText = (text) => {
    if (!text)
      return;
    const parent = top();
    const last = parent.children[parent.children.length - 1];
    if (last && last.type === "text")
      last.text += text;
    else
      parent.children.push(makeText(text, parent));
  };

  const closeTag = (tag) => {
    for (let k = stack.length - 1; k > 0; k--) {
      if (stack[k].tag === tag) {
        stack.length = k;
        return;
      }
    }
  };

  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      pushText(decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i)
      pushText(decodeEntities(src.slice(i, lt)));

    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith("<!", lt) || src.startsWith("<?", lt)) {
      const end = src.indexOf(">", lt);
      i = end < 0 ? n : end + 1;
      continue;
    }
    if (src.startsWith("</", lt)) {
      const end = src.indexOf(">", lt);
      if (end < 0) { i = n; break; }
      const name = src.slice(lt + 2, end).trim().toLowerCase().split(/\s/)[0];
      closeTag(name);
      i = end + 1;
      continue;
    }

    /* Start tag. Find the '>' while respecting quoted attribute values. */
    let p = lt + 1;
    let quote = 0;
    while (p < n) {
      const ch = src[p];
      if (quote) {
        if (ch === quote) quote = 0;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        break;
      }
      p++;
    }
    if (p >= n) {
      pushText(src.slice(lt));
      break;
    }

    const rawTag = src.slice(lt + 1, p);
    const selfClosing = rawTag.trimEnd().endsWith("/");
    const body = selfClosing ? rawTag.trimEnd().slice(0, -1) : rawTag;
    const nameMatch = /^([a-zA-Z][^\s/>]*)/.exec(body);
    if (!nameMatch) {
      pushText(src.slice(lt, p + 1));
      i = p + 1;
      continue;
    }
    const tag = nameMatch[1].toLowerCase();
    const attrs = parseAttrs(body.slice(nameMatch[1].length));

    /* Implied end tags. */
    if (CLOSES_P.has(tag) && tag !== "p") {
      const idx = findOpen(stack, new Set(["p"]));
      if (idx > 0) stack.length = idx;
    }
    if (IMPLIED[tag]) {
      const closes = new Set(IMPLIED[tag]);
      const idx = findOpen(stack, closes);
      if (idx > 0) stack.length = idx;
    }
    if (tag === "p") {
      const idx = findOpen(stack, new Set(["p"]));
      if (idx > 0) stack.length = idx;
    }

    const el = makeElement(tag, attrs, top());
    top().children.push(el);
    i = p + 1;

    if (VOID.has(tag) || selfClosing)
      continue;

    if (RAW.has(tag)) {
      const re = new RegExp("</" + tag + "\\s*>", "i");
      const rest = src.slice(i);
      const m = re.exec(rest);
      const content = m ? rest.slice(0, m.index) : rest;
      if (content)
        el.children.push(makeText(tag === "title" || tag === "textarea" ?
          decodeEntities(content) : content, el));
      i += m ? m.index + m[0].length : rest.length;
      continue;
    }

    stack.push(el);
  }

  return doc;
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    const name = m[1].toLowerCase();
    if (name === "/")
      continue;
    const value = m[2] !== undefined ? m[2] :
                  m[3] !== undefined ? m[3] :
                  m[4] !== undefined ? m[4] : "";
    attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/** @param {Object} node @returns {Array} */
export function elementChildren(node) {
  return node.children.filter((c) => c.type === "element");
}

/** Depth-first walk over element nodes. */
export function walkElements(node, fn) {
  for (const child of node.children) {
    if (child.type === "element") {
      fn(child);
      walkElements(child, fn);
    }
  }
}

/** Concatenated textContent of a node. */
export function textContent(node) {
  if (node.type === "text")
    return node.text;
  let out = "";
  for (const child of node.children)
    out += textContent(child);
  return out;
}
