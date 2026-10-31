/**
 * Tokenizer and C preprocessor for the JavaScript C compiler.
 *
 * The tokenizer produces a flat token stream with `bol`/`space` markers that
 * the preprocessor uses to recognise directives and reproduce macro text.
 * The preprocessor then handles includes, object-like and function-like
 * macros, `#`/`##`, conditionals and the usual integer directives.
 *
 * @module cc/tokenize
 */
import fs from 'node:fs';
import path from 'node:path';

/** @typedef {{file: string, line: number, col: number}} Loc */

/** A single preprocessing token. */
export class Token {
  /**
   * @param {string} kind one of ident, punct, num, str, eof
   * @param {string} text source spelling (or decoded text for strings)
   * @param {Loc} loc source position
   */
  constructor(kind, text, loc) {
    this.kind = kind;
    this.text = text;
    this.loc = loc;
    /** @type {Set<string>} macros that must not expand again */
    this.hideset = new Set();
    /** true when this is the first token on a source line */
    this.bol = false;
    /** true when whitespace preceded this token */
    this.space = false;
    /** numeric value for `num` tokens */
    this.val = 0n;
    /** numeric type hint for int literals */
    this.numType = 'int';
    /** decoded bytes for string literals */
    this.strBytes = null;
  }

  /** @returns {Token} an independent copy */
  clone() {
    const copy = new Token(this.kind, this.text, this.loc);
    copy.hideset = new Set(this.hideset);
    copy.bol = this.bol;
    copy.space = this.space;
    copy.val = this.val;
    copy.numType = this.numType;
    copy.strBytes = this.strBytes ? this.strBytes.slice() : null;
    return copy;
  }
}

const PUNCTUATORS = [
  '<<=',
  '>>=',
  '...',
  '->',
  '++',
  '--',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '&&',
  '||',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '##',
  '::',
];

const SINGLE_PUNCT = '+-*/%&|^~!<>=?:;,.()[]{}#';

/** Error carrying a source location. */
export class CcError extends Error {
  /**
   * @param {string} message
   * @param {Loc | null} [loc]
   */
  constructor(message, loc = null) {
    super(loc ? `${loc.file}:${loc.line}:${loc.col}: ${message}` : message);
    this.name = 'CcError';
    this.loc = loc;
  }
}

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isIdentStart(ch) {
  return ch === '_' || (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
}

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isIdentChar(ch) {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

/**
 * @param {string} ch
 * @returns {boolean}
 */
function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

/**
 * Decode one C escape sequence.
 * @param {string} src
 * @param {number} index index of the backslash
 * @returns {{value: number, next: number}}
 */
function readEscape(src, index) {
  const ch = src[index + 1];
  const simple = {
    n: 10,
    t: 9,
    r: 13,
    '0': 0,
    '\\': 92,
    "'": 39,
    '"': 34,
    a: 7,
    b: 8,
    f: 12,
    v: 11,
    e: 27,
  };
  if (ch === undefined) throw new CcError('unterminated escape sequence');
  if (ch === 'x') {
    let value = 0;
    let i = index + 2;
    while (i < src.length && /[0-9a-fA-F]/.test(src[i])) {
      value = value * 16 + parseInt(src[i], 16);
      i += 1;
    }
    return { value: value & 0xff, next: i };
  }
  if (ch >= '0' && ch <= '7') {
    let value = 0;
    let i = index + 1;
    let count = 0;
    while (i < src.length && count < 3 && src[i] >= '0' && src[i] <= '7') {
      value = value * 8 + (src.charCodeAt(i) - 48);
      i += 1;
      count += 1;
    }
    return { value: value & 0xff, next: i };
  }
  if (ch in simple) return { value: simple[ch], next: index + 2 };
  // Unknown escapes keep the escaped character, matching most compilers.
  return { value: ch.charCodeAt(0), next: index + 2 };
}

/**
 * Turn the body of a string or character literal into bytes.
 * @param {string} src
 * @param {number} start index just after the opening quote
 * @param {string} quote closing quote character
 * @returns {{bytes: number[], next: number}}
 */
function readQuoted(src, start, quote) {
  const bytes = [];
  let i = start;
  while (i < src.length && src[i] !== quote) {
    if (src[i] === '\n') throw new CcError('unterminated literal');
    if (src[i] === '\\') {
      const esc = readEscape(src, i);
      bytes.push(esc.value);
      i = esc.next;
      continue;
    }
    const code = src.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
      i += 1;
    } else {
      // Encode the rest of the code point as UTF-8 so string literals keep
      // their byte representation.
      const cp = src.codePointAt(i);
      const encoded = Buffer.from(String.fromCodePoint(cp), 'utf8');
      for (const byte of encoded) bytes.push(byte);
      i += cp > 0xffff ? 2 : 1;
    }
  }
  if (i >= src.length) throw new CcError('unterminated literal');
  return { bytes, next: i + 1 };
}

/**
 * Parse a C integer literal.
 * @param {string} text
 * @param {Loc} loc
 * @returns {{val: bigint, numType: string}}
 */
export function parseIntegerLiteral(text, loc) {
  let body = text.replace(/[']/g, '');
  let unsigned = false;
  let longs = 0;
  for (;;) {
    const last = body[body.length - 1];
    if (last === 'u' || last === 'U') {
      unsigned = true;
      body = body.slice(0, -1);
    } else if (last === 'l' || last === 'L') {
      longs += 1;
      body = body.slice(0, -1);
    } else {
      break;
    }
  }
  let value;
  if (/^0[xX]/.test(body)) {
    if (!/^0[xX][0-9a-fA-F]+$/.test(body)) throw new CcError(`invalid number '${text}'`, loc);
    value = BigInt(body);
    if (value >= 1n << 64n) throw new CcError(`integer literal too large '${text}'`, loc);
  } else if (/^0[bB]/.test(body)) {
    if (!/^0[bB][01]+$/.test(body)) throw new CcError(`invalid number '${text}'`, loc);
    value = BigInt(`0b${body.slice(2)}`);
  } else if (/^0[0-7]*$/.test(body)) {
    value = body === '0' ? 0n : BigInt(`0o${body.slice(1)}`);
  } else if (/^[1-9][0-9]*$/.test(body)) {
    value = BigInt(body);
  } else {
    throw new CcError(`invalid number '${text}'`, loc);
  }

  const fitsInt = value <= 0x7fffffffn;
  const fitsUint = value <= 0xffffffffn;
  const fitsLong = value <= 0x7fffffffffffffffn;
  let numType;
  if (unsigned) {
    if (longs > 0 || !fitsUint) numType = fitsLong || !fitsUint ? 'ulong' : 'ulong';
    else numType = 'uint';
    if (!fitsLong && value > 0xffffffffn) numType = 'ulong';
  } else if (longs > 0 || !fitsInt) {
    if (fitsLong) numType = 'long';
    else numType = 'ulong';
  } else {
    numType = 'int';
  }
  return { val: value, numType };
}

/**
 * Parse a floating-point literal, including the C99 hexadecimal form and the
 * `f`/`l` suffixes used throughout system headers.
 *
 * @param {string} text
 * @param {Loc} loc
 * @returns {{val: number, numType: string}}
 */
export function parseFloatLiteral(text, loc) {
  let body = text.replace(/[']/g, '');
  let numType = 'double';
  const suffix = body[body.length - 1];
  if (suffix === 'f' || suffix === 'F') {
    numType = 'float';
    body = body.slice(0, -1);
  } else if (suffix === 'l' || suffix === 'L') {
    numType = 'double';
    body = body.slice(0, -1);
  }

  let value;
  if (/^0[xX]/.test(body)) {
    const m = /^0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?[pP]([+-]?\d+)$/.exec(body);
    if (!m || (!m[1] && !m[2])) throw new CcError(`invalid floating point literal '${text}'`, loc);
    const intPart = m[1] ? parseInt(m[1], 16) : 0;
    let frac = 0;
    if (m[2]) {
      for (let i = 0; i < m[2].length; i += 1) {
        frac += parseInt(m[2][i], 16) / 16 ** (i + 1);
      }
    }
    value = (intPart + frac) * 2 ** Number(m[3]);
  } else {
    if (!/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(body)) {
      throw new CcError(`invalid floating point literal '${text}'`, loc);
    }
    value = Number(body);
  }
  // Overflow to infinity is valid C (e.g. `1e5000f` in <math.h>); NaN is not.
  if (Number.isNaN(value)) throw new CcError(`invalid floating point literal '${text}'`, loc);
  return { val: value, numType };
}

/**
 * Tokenize a single source string.
 * @param {string} source
 * @param {string} file used for diagnostics
 * @returns {Token[]} tokens terminated by an eof token
 */
export function tokenizeString(source, file) {
  // Line splicing happens before tokenization in C: `\` + newline disappears
  // entirely. This matters for multi-line preprocessor directives, which are
  // common in libc headers.
  const src = source.replace(/\\\r?\n/g, '');
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  let bol = true;
  let space = false;

  /** @returns {Loc} */
  const loc = () => ({ file, line, col });

  /** Advance one character, tracking line/column. */
  const advance = () => {
    if (src[i] === '\n') {
      line += 1;
      col = 1;
      bol = true;
    } else {
      col += 1;
    }
    i += 1;
  };

  while (i < src.length) {
    const ch = src[i];

    if (ch === '\n') {
      advance();
      space = false;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
      advance();
      space = true;
      continue;
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') advance();
      space = true;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const start = loc();
      advance();
      advance();
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) advance();
      if (i >= src.length) throw new CcError('unterminated block comment', start);
      advance();
      advance();
      space = true;
      continue;
    }

    const start = loc();
    let token;

    if (isIdentStart(ch)) {
      let text = '';
      while (i < src.length && isIdentChar(src[i])) {
        text += src[i];
        advance();
      }
      token = new Token('ident', text, start);
    } else if (isDigit(ch) || (ch === '.' && isDigit(src[i + 1]))) {
      let text = '';
      while (i < src.length) {
        const c = src[i];
        if (/[0-9a-zA-Z_.]/.test(c)) {
          text += c;
          advance();
          continue;
        }
        if ((c === '+' || c === '-') && /[eEpP]/.test(text[text.length - 1] ?? '')) {
          text += c;
          advance();
          continue;
        }
        break;
      }
      const isHex = /^0[xX]/.test(text);
      const isFP = isHex ? /[pP]/.test(text) : /[.eE]/.test(text);
      if (isFP) {
        const parsed = parseFloatLiteral(text, start);
        token = new Token('num', text, start);
        token.val = parsed.val;
        token.numType = parsed.numType;
      } else {
        const parsed = parseIntegerLiteral(text, start);
        token = new Token('num', text, start);
        token.val = parsed.val;
        token.numType = parsed.numType;
      }
    } else if (ch === '"' || ch === "'") {
      const begin = i;
      const { bytes, next } = readQuoted(src, i + 1, ch);
      while (i < next) advance();
      if (ch === '"') {
        // Keep the quoted source spelling in `text` so that syntactic
        // comparisons against punctuators cannot accidentally match the
        // decoded contents (e.g. the string "--").
        token = new Token('str', src.slice(begin, i), start);
        token.strBytes = bytes;
      } else {
        let value = 0n;
        for (const byte of bytes) value = (value << 8n) | BigInt(byte);
        token = new Token('num', src.slice(startCol(src, i), i), start);
        // Recompute a compact spelling-free numeric token.
        token.text = String(value);
        token.val = value;
        token.numType = 'int';
      }
    } else {
      let matched = null;
      for (const p of PUNCTUATORS) {
        if (src.startsWith(p, i)) {
          matched = p;
          break;
        }
      }
      if (!matched && SINGLE_PUNCT.includes(ch)) matched = ch;
      if (!matched) throw new CcError(`unexpected character '${ch}'`, start);
      for (let k = 0; k < matched.length; k += 1) advance();
      token = new Token('punct', matched, start);
    }

    token.bol = bol;
    token.space = space;
    bol = false;
    space = false;
    tokens.push(token);
  }

  const eof = new Token('eof', '', { file, line, col });
  eof.bol = true;
  tokens.push(eof);
  return tokens;
}

/**
 * Compute the source offset for diagnostics. Kept tiny because only the
 * multi-character literal spelling needs it.
 * @param {string} src
 * @param {number} index
 * @returns {number}
 */
function startCol(src, index) {
  return index;
}

/**
 * Tokenize a file.
 * @param {string} file
 * @returns {Token[]}
 */
export function tokenizeFile(file) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new CcError(`cannot read '${file}': ${error.message}`);
  }
  return tokenizeString(source, file);
}

/** @typedef {{name: string, isFunc: boolean, params: string[], variadic: boolean, body: Token[]}} Macro */

/** Preprocessor state shared across included files. */
export class Preprocessor {
  /**
   * @param {{includeDirs?: string[], defines?: Record<string, string>, undefs?: string[]}} [options]
   */
  constructor(options = {}) {
    /** @type {Map<string, Macro>} */
    this.macros = new Map();
    this.includeDirs = options.includeDirs ? options.includeDirs.slice() : [];
    this.includeDepth = 0;
    this.pragmaOnce = new Set();
    this.counter = 0;
    this.counterMacro = 0;

    const predefined = {
      __STDC__: '1',
      __STDC_VERSION__: '201112L',
      __STDC_HOSTED__: '1',
      __x86_64__: '1',
      __x86_64: '1',
      __amd64__: '1',
      __linux__: '1',
      __linux: '1',
      __unix__: '1',
      __LP64__: '1',
      _LP64: '1',
      __ELF__: '1',
    };
    for (const [name, value] of Object.entries(predefined)) {
      this.define(name, value);
    }
    for (const [name, value] of Object.entries(options.defines ?? {})) {
      this.define(name, value);
    }
    for (const name of options.undefs ?? []) this.macros.delete(name);
  }

  /**
   * Install an object-like macro from its command-line spelling.
   * @param {string} name
   * @param {string} value
   */
  define(name, value) {
    const body = value === '' ? [] : this.expandForDefine(tokenizeString(value, '<command line>'));
    this.macros.set(name, {
      name,
      isFunc: false,
      params: [],
      variadic: false,
      body,
    });
  }

  /**
   * Expand a command-line define fully so `-DFOO=BAR` works even when BAR is
   * another define that was installed earlier.
   * @param {Token[]} tokens
   * @returns {Token[]}
   */
  expandForDefine(tokens) {
    const clean = tokens.filter((t) => t.kind !== 'eof');
    return this.expandTokens(clean);
  }

  /**
   * Preprocess a token stream.
   * @param {Token[]} tokens
   * @returns {Token[]}
   */
  run(tokens) {
    const out = this.processStream(tokens);
    const eof = new Token('eof', '', tokens[tokens.length - 1]?.loc ?? { file: '<input>', line: 1, col: 1 });
    out.push(eof);
    return out;
  }

  /**
   * Process directives and expand macros for one file.
   * @param {Token[]} tokens
   * @returns {Token[]}
   */
  processStream(tokens) {
    /** @type {Token[]} */
    const out = [];
    /** @type {{parentActive: boolean, active: boolean, taken: boolean, seenElse: boolean}[]} */
    const conds = [];
    let i = 0;

    const active = () => conds.length === 0 || (conds[conds.length - 1].active);
    const lineStart = (index) => {
      let j = index;
      while (j < tokens.length && tokens[j].kind !== 'eof') {
        if (j > index && tokens[j].bol) break;
        // A directive starts at a token with bol and text '#'.
        if (j > index && tokens[j].bol && tokens[j].text === '#') break;
        j += 1;
      }
      return j;
    };

    while (i < tokens.length) {
      const tok = tokens[i];
      if (tok.kind === 'eof') break;

      if (tok.bol && tok.text === '#') {
        const end = lineStart(i + 1);
        const directive = tokens.slice(i + 1, end);
        i = end;
        this.handleDirective(directive, conds, (produced) => {
          for (const t of produced) out.push(t);
        }, active);
        continue;
      }

      if (!active()) {
        i = lineStart(i);
        continue;
      }

      const segment = this.expandSegment(tokens, i);
      for (const t of segment.tokens) out.push(t);
      i = segment.next;
    }

    if (conds.length !== 0) {
      throw new CcError('unterminated conditional directive', tokens[tokens.length - 1]?.loc);
    }
    return out;
  }

  /**
   * Expand all macros from `start` until the next directive or EOF.
   * @param {Token[]} tokens
   * @param {number} start
   * @returns {{tokens: Token[], next: number}}
   */
  expandSegment(tokens, start) {
    /** @type {Token[]} */
    const out = [];
    /** @type {Token[]} */
    const stack = [];
    let i = start;

    /** @returns {Token | null} */
    const pull = () => {
      if (stack.length > 0) return stack.pop();
      if (i >= tokens.length) return null;
      const tok = tokens[i];
      if (tok.kind === 'eof') return null;
      if (tok.bol && tok.text === '#') return null;
      i += 1;
      return tok;
    };
    /** @param {Token} tok */
    const pushBack = (tok) => {
      stack.push(tok);
    };

    for (;;) {
      const tok = pull();
      if (!tok) break;
      const expanded = this.expandOne(tok, pull, pushBack);
      if (!expanded) {
        out.push(tok);
        continue;
      }
      for (let k = expanded.length - 1; k >= 0; k -= 1) stack.push(expanded[k]);
    }
    return { tokens: out, next: i };
  }

  /**
   * Expand a token if it names an active macro.
   * @param {Token} tok
   * @param {() => Token | null} pull
   * @param {(tok: Token) => void} pushBack
   * @returns {Token[] | null}
   */
  expandOne(tok, pull, pushBack) {
    if (tok.kind !== 'ident') return null;
    // Predefined dynamic macros expand from the token's own location.
    if (tok.text === '__LINE__' || tok.text === '__COUNTER__') {
      const value = tok.text === '__LINE__' ? tok.loc.line : this.counterMacro++;
      const num = new Token('num', String(value), tok.loc);
      num.val = BigInt(value);
      num.numType = 'int';
      return [num];
    }
    if (tok.text === '__FILE__') {
      const str = new Token('str', JSON.stringify(tok.loc.file), tok.loc);
      str.strBytes = [...Buffer.from(tok.loc.file, 'utf8')];
      return [str];
    }
    const macro = this.macros.get(tok.text);
    if (!macro) return null;
    if (tok.hideset.has(tok.text)) return null;

    if (!macro.isFunc) {
      return this.substitute(macro, [], tok);
    }

    const next = pull();
    if (!next) return null;
    if (next.text !== '(') {
      pushBack(next);
      return null;
    }

    /** @type {Token[][]} */
    const args = [];
    /** @type {Token[]} */
    let current = [];
    let depth = 1;
    let sawAny = false;
    for (;;) {
      const arg = pull();
      if (!arg) throw new CcError(`unterminated invocation of macro '${macro.name}'`, tok.loc);
      if (arg.text === '(') depth += 1;
      if (arg.text === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
      if (arg.text === ',' && depth === 1) {
        args.push(current);
        current = [];
        sawAny = true;
        continue;
      }
      current.push(arg);
      sawAny = true;
    }
    if (sawAny || current.length > 0) args.push(current);
    // A zero-parameter macro invoked as `M()` yields one empty argument; drop it.
    if (macro.params.length === 0 && !macro.variadic && args.length === 1 && args[0].length === 0) {
      args.length = 0;
    }

    if (macro.variadic) {
      const fixed = macro.params.length;
      if (args.length < fixed) args.length = fixed;
      for (let k = 0; k < fixed; k += 1) if (!args[k]) args[k] = [];
      const rest = args.slice(fixed);
      /** @type {Token[]} */
      const va = [];
      rest.forEach((arg, index) => {
        if (index > 0) {
          const comma = new Token('punct', ',', tok.loc);
          comma.space = false;
          va.push(comma);
        }
        va.push(...arg);
      });
      args.length = fixed;
      args.push(va);
    }

    return this.substitute(macro, args, tok);
  }

  /**
   * Replace parameters in a macro body.
   * @param {Macro} macro
   * @param {Token[][]} args
   * @param {Token} invocation
   * @returns {Token[]}
   */
  substitute(macro, args, invocation) {
    /** @type {Map<string, Token[]>} */
    const raw = new Map();
    /** @type {Map<string, Token[]>} */
    const expanded = new Map();
    macro.params.forEach((param, index) => {
      raw.set(param, args[index] ?? []);
    });
    if (macro.variadic) {
      const vaTokens = args[macro.params.length] ?? [];
      raw.set('__VA_ARGS__', vaTokens);
      if (macro.vaName) raw.set(macro.vaName, vaTokens);
    }

    const getExpanded = (name) => {
      if (!expanded.has(name)) expanded.set(name, this.expandTokens(raw.get(name) ?? []));
      return expanded.get(name);
    };

    /** @type {Token[]} */
    const replaced = [];
    const body = macro.body;
    for (let i = 0; i < body.length; i += 1) {
      const tok = body[i];
      if (tok.text === '#' && body[i + 1] && raw.has(body[i + 1].text)) {
        const param = body[i + 1].text;
        replaced.push(this.stringify(raw.get(param) ?? [], invocation.loc));
        i += 1;
        continue;
      }
      if (raw.has(tok.text)) {
        const pastes = tok.text === '##' || body[i + 1]?.text === '##' || body[i - 1]?.text === '##';
        const source = pastes ? raw.get(tok.text) : getExpanded(tok.text);
        for (const argTok of source) {
          const copy = argTok.clone();
          copy.bol = false;
          replaced.push(copy);
        }
        continue;
      }
      const copy = tok.clone();
      copy.bol = false;
      replaced.push(copy);
    }

    // Paste adjacent tokens around `##`.
    /** @type {Token[]} */
    const pasted = [];
    for (let i = 0; i < replaced.length; i += 1) {
      const tok = replaced[i];
      if (tok.text === '##' && pasted.length > 0 && replaced[i + 1]) {
        const left = pasted.pop();
        const right = replaced[i + 1];
        const joined = this.paste(left, right, invocation.loc);
        pasted.push(...joined);
        i += 1;
        continue;
      }
      pasted.push(tok);
    }

    const hide = new Set(invocation.hideset);
    hide.add(macro.name);
    for (const tok of pasted) for (const name of hide) tok.hideset.add(name);
    return pasted;
  }

  /**
   * Paste two tokens together, retokenizing the result.
   * @param {Token} left
   * @param {Token} right
   * @param {Loc} loc
   * @returns {Token[]}
   */
  paste(left, right, loc) {
    const text = left.text + right.text;
    if (text === '') return [];
    const tokens = tokenizeString(text, loc.file).filter((t) => t.kind !== 'eof');
    if (tokens.length !== 1) {
      throw new CcError(`pasting '${left.text}' and '${right.text}' does not form a token`, loc);
    }
    const tok = tokens[0];
    tok.bol = false;
    tok.space = left.space;
    tok.loc = loc;
    return [tok];
  }

  /**
   * Turn macro argument tokens into a string literal token.
   * @param {Token[]} tokens
   * @param {Loc} loc
   * @returns {Token}
   */
  stringify(tokens, loc) {
    let text = '';
    tokens.forEach((tok, index) => {
      if (index > 0 && tok.space) text += ' ';
      text += tok.text;
    });
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const tok = new Token('str', `"${escaped}"`, loc);
    tok.strBytes = [...Buffer.from(escaped, 'latin1')];
    return tok;
  }

  /**
   * Fully expand a token list with no directive handling.
   * @param {Token[]} tokens
   * @returns {Token[]}
   */
  expandTokens(tokens) {
    /** @type {Token[]} */
    const out = [];
    /** @type {Token[]} */
    const stack = tokens.slice().reverse();
    const pull = () => (stack.length > 0 ? stack.pop() : null);
    const pushBack = (tok) => stack.push(tok);
    for (;;) {
      const tok = pull();
      if (!tok) break;
      const expansion = this.expandOne(tok, pull, pushBack);
      if (!expansion) {
        out.push(tok);
      } else {
        for (let k = expansion.length - 1; k >= 0; k -= 1) stack.push(expansion[k]);
      }
    }
    return out;
  }

  /**
   * Handle one directive line.
   * @param {Token[]} line tokens after `#`
   * @param {{parentActive: boolean, active: boolean, taken: boolean, seenElse: boolean}[]} conds
   * @param {(tokens: Token[]) => void} emit
   * @param {() => boolean} active
   */
  handleDirective(line, conds, emit, active) {
    if (line.length === 0) return;
    const name = line[0].text;
    const rest = line.slice(1);
    const parentActive = conds.length === 0 ? true : conds[conds.length - 1].active;

    switch (name) {
      case 'include': {
        if (!active()) return;
        const quoted = rest[0]?.kind === 'str';
        const file = this.parseIncludeName(rest);
        const resolved = this.resolveInclude(file, line[0].loc.file, quoted);
        const included = this.include(resolved);
        emit(included);
        return;
      }
      case 'define': {
        if (!active()) return;
        this.handleDefine(rest);
        return;
      }
      case 'undef': {
        if (!active()) return;
        if (rest[0]) this.macros.delete(rest[0].text);
        return;
      }
      case 'ifdef':
      case 'ifndef': {
        if (!rest[0]) throw new CcError(`#${name} needs a macro name`, line[0].loc);
        const defined = this.macros.has(rest[0].text);
        const condition = name === 'ifdef' ? defined : !defined;
        const isActive = parentActive && condition;
        conds.push({ parentActive, active: isActive, taken: condition, seenElse: false });
        return;
      }
      case 'if': {
        let condition = false;
        if (parentActive) condition = this.evalCondition(rest);
        const isActive = parentActive && condition;
        conds.push({ parentActive, active: isActive, taken: condition, seenElse: false });
        return;
      }
      case 'elif': {
        if (conds.length === 0) throw new CcError('#elif without #if', line[0].loc);
        const top = conds[conds.length - 1];
        if (top.seenElse) throw new CcError('#elif after #else', line[0].loc);
        if (!top.parentActive || top.taken) {
          top.active = false;
        } else {
          const condition = this.evalCondition(rest);
          top.active = condition;
          top.taken = condition;
        }
        return;
      }
      case 'else': {
        if (conds.length === 0) throw new CcError('#else without #if', line[0].loc);
        const top = conds[conds.length - 1];
        if (top.seenElse) throw new CcError('duplicate #else', line[0].loc);
        top.seenElse = true;
        top.active = top.parentActive && !top.taken;
        top.taken = true;
        return;
      }
      case 'endif': {
        if (conds.length === 0) throw new CcError('#endif without #if', line[0].loc);
        conds.pop();
        return;
      }
      case 'error': {
        if (!active()) return;
        throw new CcError(`#error ${rest.map((t) => t.text).join(' ')}`, line[0].loc);
      }
      case 'warning': {
        if (!active()) return;
        process.stderr.write(`warning: ${rest.map((t) => t.text).join(' ')}\n`);
        return;
      }
      case 'pragma': {
        if (!active()) return;
        if (rest[0]?.text === 'once') this.pragmaOnce.add(path.resolve(line[0].loc.file));
        return;
      }
      case 'line':
      case '':
        return;
      default:
        // Unknown directives are ignored when skipped, and treated as errors
        // when active so silent miscompiles are impossible.
        if (active()) throw new CcError(`unknown directive '#${name}'`, line[0].loc);
    }
  }

  /**
   * Parse `#define` body.
   * @param {Token[]} rest
   */
  handleDefine(rest) {
    if (rest.length === 0) throw new CcError('#define needs a macro name');
    const nameTok = rest[0];
    if (nameTok.kind !== 'ident') throw new CcError('macro name must be an identifier', nameTok.loc);
    const name = nameTok.text;
    let index = 1;
    const params = [];
    let variadic = false;
    /** GNU named variadic parameter, e.g. `#define M(a, rest...)`. */
    let vaName = null;

    if (rest[index]?.text === '(' && !rest[index].space) {
      index += 1;
      if (rest[index]?.text === ')') {
        index += 1;
      } else {
        for (;;) {
          if (rest[index]?.text === '...') {
            variadic = true;
            index += 1;
            if (rest[index]?.text !== ')') throw new CcError('expected ) after ...', rest[index]?.loc);
            index += 1;
            break;
          }
          if (rest[index]?.kind !== 'ident') throw new CcError('expected macro parameter', rest[index]?.loc);
          params.push(rest[index].text);
          index += 1;
          // GNU named variadic parameter: `name...` acts like `...` but the
          // collected arguments are bound to `name` instead of `__VA_ARGS__`.
          if (rest[index]?.text === '...') {
            variadic = true;
            vaName = params.pop();
            index += 1;
            if (rest[index]?.text !== ')') throw new CcError('expected ) after ...', rest[index]?.loc);
            index += 1;
            break;
          }
          if (rest[index]?.text === ',') {
            index += 1;
            continue;
          }
          if (rest[index]?.text === ')') {
            index += 1;
            break;
          }
          throw new CcError('expected , or ) in macro parameter list', rest[index]?.loc);
        }
      }
    }

    const body = rest.slice(index).map((t) => {
      const copy = t.clone();
      copy.bol = false;
      return copy;
    });
    if (body.length > 0) body[0].space = false;
    this.macros.set(name, { name, isFunc: rest[1]?.text === '(' && !rest[1].space, params, variadic, vaName, body });
  }

  /**
   * @param {Token[]} rest tokens after `#include`
   * @returns {string}
   */
  parseIncludeName(rest) {
    if (rest.length === 0) throw new CcError('#include needs a file name');
    if (rest[0].kind === 'str') return Buffer.from(rest[0].strBytes ?? []).toString('latin1');
    const text = rest.map((t) => t.text).join('');
    const match = text.match(/^<(.+)>$/);
    if (!match) throw new CcError(`invalid #include '${text}'`, rest[0].loc);
    return match[1];
  }

  /**
   * Resolve an include name against the including file and `-I` paths.
   * @param {string} name
   * @param {string} fromFile
   * @param {boolean} [quoted] quoted includes also search the including directory
   * @returns {string}
   */
  resolveInclude(name, fromFile, quoted = true) {
    const candidates = [];
    if (path.isAbsolute(name)) {
      candidates.push(name);
    } else {
      if (quoted) candidates.push(path.join(path.dirname(fromFile), name));
      for (const dir of this.includeDirs) candidates.push(path.join(dir, name));
    }
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return path.resolve(candidate);
    }
    throw new CcError(`include file not found: ${name}`);
  }

  /**
   * Preprocess an included file with the shared macro table.
   * @param {string} file
   * @returns {Token[]}
   */
  include(file) {
    if (process.env.CC_TRACE_INCLUDES) console.error('include', this.includeDepth, file);
    if (this.pragmaOnce.has(file)) return [];
    this.includeDepth += 1;
    if (this.includeDepth > 64) throw new CcError(`#include nesting too deep at '${file}'`);
    const tokens = tokenizeFile(file);
    const result = this.processStream(tokens);
    this.includeDepth -= 1;
    return result;
  }

  /**
   * Evaluate a `#if` expression.
   * @param {Token[]} tokens
   * @returns {boolean}
   */
  evalCondition(tokens) {
    // Handle `defined X` and `defined(X)` before macro expansion.
    /** @type {Token[]} */
    const cooked = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const tok = tokens[i];
      if (tok.kind === 'ident' && tok.text === 'defined') {
        let name;
        if (tokens[i + 1]?.text === '(') {
          name = tokens[i + 2]?.text;
          i += 3;
        } else {
          name = tokens[i + 1]?.text;
          i += 1;
        }
        const value = name && this.macros.has(name) ? 1n : 0n;
        const num = new Token('num', String(value), tok.loc);
        num.val = value;
        cooked.push(num);
      } else {
        cooked.push(tok);
      }
    }
    const expanded = this.expandTokens(cooked).map((tok) => {
      if (tok.kind === 'ident') {
        const num = new Token('num', '0', tok.loc);
        num.val = 0n;
        return num;
      }
      return tok;
    });
    const parser = new PpExpression(expanded);
    const value = parser.parse();
    return value !== 0n;
  }
}

/** Small recursive-descent evaluator for `#if` expressions. */
class PpExpression {
  /** @param {Token[]} tokens */
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos] ?? null;
  }

  consume(text) {
    if (this.peek()?.text === text) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parse() {
    const value = this.conditional();
    return value;
  }

  conditional() {
    const cond = this.logOr();
    if (this.consume('?')) {
      const thenValue = this.conditional();
      if (!this.consume(':')) throw new CcError('expected : in #if expression');
      const elseValue = this.conditional();
      return cond !== 0n ? thenValue : elseValue;
    }
    return cond;
  }

  logOr() {
    let value = this.logAnd();
    while (this.consume('||')) {
      const rhs = this.logAnd();
      value = value !== 0n || rhs !== 0n ? 1n : 0n;
    }
    return value;
  }

  logAnd() {
    let value = this.bitOr();
    while (this.consume('&&')) {
      const rhs = this.bitOr();
      value = value !== 0n && rhs !== 0n ? 1n : 0n;
    }
    return value;
  }

  bitOr() {
    let value = this.bitXor();
    while (this.consume('|')) value |= this.bitXor();
    return value;
  }

  bitXor() {
    let value = this.bitAnd();
    while (this.consume('^')) value ^= this.bitAnd();
    return value;
  }

  bitAnd() {
    let value = this.equality();
    while (this.consume('&')) value &= this.equality();
    return value;
  }

  equality() {
    let value = this.relational();
    for (;;) {
      if (this.consume('==')) value = value === this.relational() ? 1n : 0n;
      else if (this.consume('!=')) value = value !== this.relational() ? 1n : 0n;
      else return value;
    }
  }

  relational() {
    let value = this.shift();
    for (;;) {
      if (this.consume('<')) value = value < this.shift() ? 1n : 0n;
      else if (this.consume('<=')) value = value <= this.shift() ? 1n : 0n;
      else if (this.consume('>')) value = value > this.shift() ? 1n : 0n;
      else if (this.consume('>=')) value = value >= this.shift() ? 1n : 0n;
      else return value;
    }
  }

  shift() {
    let value = this.additive();
    for (;;) {
      if (this.consume('<<')) value <<= this.additive();
      else if (this.consume('>>')) value >>= this.additive();
      else return value;
    }
  }

  additive() {
    let value = this.multiplicative();
    for (;;) {
      if (this.consume('+')) value += this.multiplicative();
      else if (this.consume('-')) value -= this.multiplicative();
      else return value;
    }
  }

  multiplicative() {
    let value = this.unary();
    for (;;) {
      if (this.consume('*')) value *= this.unary();
      else if (this.consume('/')) {
        const rhs = this.unary();
        value = rhs === 0n ? 0n : value / rhs;
      } else if (this.consume('%')) {
        const rhs = this.unary();
        value = rhs === 0n ? 0n : value % rhs;
      } else {
        return value;
      }
    }
  }

  unary() {
    if (this.consume('+')) return this.unary();
    if (this.consume('-')) return -this.unary();
    if (this.consume('!')) return this.unary() === 0n ? 1n : 0n;
    if (this.consume('~')) return ~this.unary();
    if (this.consume('(')) {
      const value = this.conditional();
      if (!this.consume(')')) throw new CcError('expected ) in #if expression');
      return value;
    }
    const tok = this.peek();
    if (!tok) throw new CcError('unexpected end of #if expression');
    if (tok.kind === 'num') {
      this.pos += 1;
      return tok.val;
    }
    throw new CcError(`unexpected token '${tok.text}' in #if expression`, tok.loc);
  }
}

/**
 * Convenience entry point: read, tokenize and preprocess one translation unit.
 * @param {string} file
 * @param {{includeDirs?: string[], defines?: Record<string, string>, undefs?: string[]}} [options]
 * @returns {Token[]}
 */
export function preprocessFile(file, options = {}) {
  const pp = new Preprocessor(options);
  const tokens = tokenizeFile(path.resolve(file));
  return pp.run(tokens);
}
