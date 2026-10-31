/**
 * Recursive-descent C parser.
 *
 * The parser follows the structure of chibicc but is written from scratch in
 * JavaScript. It handles the subset needed by the tests and grows towards the
 * full C11 surface: declarations, structs/unions/enums, typedefs, pointers,
 * arrays, functions, control flow and initializers. Unsupported constructs
 * raise a diagnostic instead of silently miscompiling.
 *
 * @module cc/parse
 */
import { CcError } from './tokenize.js';
import * as T from './type.js';

/** Vanilla AST node. Extra members are set by the constructor helpers. */
export class Node {
  /** @param {string} kind @param {import('./tokenize.js').Token} tok */
  constructor(kind, tok) {
    this.kind = kind;
    this.tok = tok;
    this.ty = null;
  }
}

/** A global variable, local variable or function. */
export class Obj {
  /**
   * @param {string} name
   * @param {T.CType} ty
   */
  constructor(name, ty) {
    this.name = name;
    this.ty = ty;
    this.label = name;
    this.isLocal = false;
    this.isFunction = false;
    this.isDefinition = false;
    this.isStatic = false;
    this.isExtern = false;
    this.isThreadLocal = false;
    this.isTentative = false;
    this.isString = false;
    this.isInline = false;
    this.offset = 0;
    this.initData = null;
    /** @type {{offset: number, symbol: string, addend: bigint}[]} */
    this.relocs = [];
    this.params = [];
    this.body = null;
    this.locals = [];
    this.stackSize = 0;
  }
}

const KEYWORDS = new Set([
  'void',
  '_Bool',
  'char',
  'short',
  'int',
  'long',
  'float',
  'double',
  'signed',
  'unsigned',
  'struct',
  'union',
  'enum',
  'typedef',
  'static',
  'extern',
  'inline',
  'auto',
  'register',
  'const',
  'volatile',
  'restrict',
  '__restrict',
  '__restrict__',
  'sizeof',
  '_Alignof',
  'return',
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'goto',
  '_Noreturn',
  '_Thread_local',
  '__thread',
  '_Atomic',
  '__extension__',
  '__inline',
  '__inline__',
  '__attribute__',
  '__attribute',
  'typeof',
  '__typeof__',
  '__builtin_va_list',
]);

const STORAGE = new Set(['typedef', 'static', 'extern', 'inline', '__inline', '__inline__', '_Thread_local', '__thread']);
const QUALIFIERS = new Set([
  'const',
  'volatile',
  'restrict',
  '__restrict',
  '__restrict__',
  '_Noreturn',
  '_Atomic',
  'auto',
  'register',
  '__extension__',
]);

/**
 * @param {T.CType} ty
 * @param {string | null} name
 * @returns {T.CType}
 */
function withName(ty, name) {
  if (name === null) return ty;
  // Delegate to the underlying type instead of copying it: typedefs can be
  // created from an incomplete tag that is completed later, and a shallow
  // copy would freeze the empty member list.
  const copy = Object.create(ty);
  copy.name = name;
  return copy;
}

/** @param {T.CType} ty */
function isCharType(ty) {
  return ty.kind === 'char';
}

/** @param {T.CType} ty */
function isVoidType(ty) {
  return ty.kind === 'void';
}

class Parser {
  /** @param {import('./tokenize.js').Token[]} tokens */
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
    /** @type {{vars: Map<string, any>, tags: Map<string, T.CType>}[]} */
    this.scopes = [{ vars: new Map(), tags: new Map() }];
    /** @type {Obj[]} */
    this.globals = [];
    /** @type {Obj[]} */
    this.functions = [];
    /** @type {Obj | null} */
    this.currentFn = null;
    this.localBottom = 0;
    this.unique = 0;
    /** @type {{cases: Node[], defaultLabel: string | null}[]} */
    this.switchStack = [];
    /** @type {T.CType | null} */
    this._vaListType = null;
  }

  /**
   * SysV x86-64 va_list: an array of one tag struct holding the register save
   * area offsets and the overflow argument pointer.
   * @returns {T.CType}
   */
  vaListType() {
    if (!this._vaListType) {
      const tag = T.aggregateType('struct', '__va_list_tag');
      tag.members = [
        { name: 'gp_offset', ty: T.uintType, offset: 0 },
        { name: 'fp_offset', ty: T.uintType, offset: 0 },
        { name: 'overflow_arg_area', ty: T.pointerTo(T.voidType), offset: 0 },
        { name: 'reg_save_area', ty: T.pointerTo(T.voidType), offset: 0 },
      ];
      T.layoutAggregate(tag, false);
      this._vaListType = T.arrayOf(tag, 1);
    }
    return this._vaListType;
  }

  // ---------------------------------------------------------------- tokens

  /** @param {number} [offset] @returns {import('./tokenize.js').Token} */
  tok(offset = 0) {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  /** @param {string} text */
  at(text) {
    return this.tok().text === text;
  }

  /** @param {string} text */
  consume(text) {
    if (this.at(text)) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  /** @param {string} text */
  expect(text) {
    if (!this.at(text)) {
      throw new CcError(`expected '${text}', got '${this.tok().text || 'end of file'}'`, this.tok().loc);
    }
    this.pos += 1;
  }

  next() {
    return this.tokens[this.pos++];
  }

  /** @param {string} message @returns {never} */
  error(message, tok = this.tok()) {
    throw new CcError(message, tok.loc);
  }

  uniqueLabel(prefix) {
    this.unique += 1;
    return `.L.${prefix}.${this.unique}`;
  }

  // ---------------------------------------------------------------- scopes

  pushScope() {
    this.scopes.push({ vars: new Map(), tags: new Map() });
  }

  popScope() {
    this.scopes.pop();
  }

  /**
   * @param {string} name
   * @returns {{kind: string, obj?: Obj, ty?: T.CType, value?: bigint} | null}
   */
  lookup(name) {
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
      const entry = this.scopes[i].vars.get(name);
      if (entry) return entry;
    }
    return null;
  }

  /**
   * @param {string} name
   * @returns {T.CType | null}
   */
  findTypedef(name) {
    const entry = this.lookup(name);
    return entry && entry.kind === 'typedef' ? entry.ty : null;
  }

  /**
   * @param {string} name
   * @param {any} entry
   */
  declare(name, entry) {
    this.scopes[this.scopes.length - 1].vars.set(name, entry);
  }

  /**
   * @param {string} name
   * @returns {T.CType | null}
   */
  findTag(name) {
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
      const tag = this.scopes[i].tags.get(name);
      if (tag) return tag;
    }
    return null;
  }

  /**
   * @param {string} name
   * @returns {T.CType | null}
   */
  findTagCurrent(name) {
    return this.scopes[this.scopes.length - 1].tags.get(name) ?? null;
  }

  /**
   * @param {string} name
   * @param {T.CType} ty
   */
  declareTag(name, ty) {
    this.scopes[this.scopes.length - 1].tags.set(name, ty);
  }

  // ------------------------------------------------------------ type names

  /** @returns {boolean} */
  isTypenameStart() {
    const tok = this.tok();
    if (tok.kind !== 'ident') return false;
    if (KEYWORDS.has(tok.text)) {
      if (tok.text === 'sizeof' || tok.text === '_Alignof') return false;
      if (tok.text === 'return' || tok.text === 'if' || tok.text === 'else') return false;
      if (tok.text === 'for' || tok.text === 'while' || tok.text === 'do') return false;
      if (tok.text === 'switch' || tok.text === 'case' || tok.text === 'default') return false;
      if (tok.text === 'break' || tok.text === 'continue' || tok.text === 'goto') return false;
      return true;
    }
    return this.findTypedef(tok.text) !== null;
  }

  /**
   * Parse declaration specifiers.
   * @param {{isTypedef?: boolean, isStatic?: boolean, isExtern?: boolean, isInline?: boolean}} [attr]
   * @returns {T.CType}
   */
  declspec(attr = {}) {
    let longCount = 0;
    let shortCount = 0;
    let charCount = 0;
    let intCount = 0;
    let voidCount = 0;
    let boolCount = 0;
    let signedCount = 0;
    let unsignedCount = 0;
    let floatCount = 0;
    let doubleCount = 0;
    /** @type {T.CType | null} */
    let explicit = null;
    let sawType = false;

    for (;;) {
      const tok = this.tok();
      if (tok.kind !== 'ident') break;
      const text = tok.text;
      if (text === '__attribute__' || text === '__attribute') {
        this.next();
        this.skipAttributeArgs();
        continue;
      }
      if (STORAGE.has(text)) {
        if (text === 'typedef') attr.isTypedef = true;
        else if (text === 'static') attr.isStatic = true;
        else if (text === 'extern') attr.isExtern = true;
        else if (text === 'inline' || text === '__inline' || text === '__inline__') attr.isInline = true;
        else if (text === '_Thread_local' || text === '__thread') attr.isThreadLocal = true;
        this.next();
        continue;
      }
      if (QUALIFIERS.has(text)) {
        this.next();
        continue;
      }
      if (text === 'struct' || text === 'union') {
        if (explicit || sawType) this.error(`unexpected '${text}'`);
        explicit = this.structUnion(text);
        sawType = true;
        continue;
      }
      if (text === 'enum') {
        if (explicit || sawType) this.error("unexpected 'enum'");
        explicit = this.enumSpecifier();
        sawType = true;
        continue;
      }
      if (text === 'void') {
        voidCount += 1;
        sawType = true;
        this.next();
        continue;
      }
      if (text === '_Bool') {
        boolCount += 1;
        sawType = true;
        this.next();
        continue;
      }
      if (text === 'char') {
        charCount += 1;
        sawType = true;
        this.next();
        continue;
      }
      if (text === 'short') {
        shortCount += 1;
        sawType = true;
        this.next();
        continue;
      }
      if (text === 'int') {
        intCount += 1;
        sawType = true;
        this.next();
        continue;
      }
      if (text === 'long') {
        longCount += 1;
        sawType = true;
        this.next();
        continue;
      }
      if (text === 'signed' || text === '__signed__' || text === '__signed') {
        signedCount += 1;
        sawType = true;
        this.next();
        continue;
      }
      if (text === 'unsigned' || text === '__unsigned__' || text === '__unsigned') {
        unsignedCount += 1;
        sawType = true;
        this.next();
        continue;
      }
      if (text === 'float' || text === 'double') {
        if (text === 'float') floatCount += 1;
        else doubleCount += 1;
        sawType = true;
        this.next();
        continue;
      }
      if (text === '__builtin_va_list') {
        if (explicit || sawType) break;
        explicit = this.vaListType();
        sawType = true;
        this.next();
        continue;
      }
      if (text === 'typeof' || text === '__typeof__') {
        this.error('typeof is not supported yet');
      }
      const typedef = this.findTypedef(text);
      if (typedef) {
        // Once a type specifier has been seen, another typedef name can only
        // be a declarator (C allows a member/variable to shadow a typedef).
        if (explicit || sawType) break;
        explicit = typedef;
        sawType = true;
        this.next();
        continue;
      }
      break;
    }

    if (!sawType && explicit === null) {
      this.error(`expected a type, got '${this.tok().text || 'end of file'}'`);
    }
    if (explicit) {
      if (unsignedCount || signedCount || longCount || shortCount || intCount || charCount || voidCount || boolCount) {
        // `unsigned typedefname` is legal; apply signedness to integer types.
        if (T.isInteger(explicit)) {
          const copy = Object.assign(Object.create(Object.getPrototypeOf(explicit)), explicit);
          if (unsignedCount) copy.isUnsigned = true;
          if (signedCount) copy.isUnsigned = false;
          return copy;
        }
        this.error('type specifier cannot be combined with a typedef');
      }
      return explicit;
    }
    if (voidCount) return T.voidType;
    if (boolCount) return T.boolType;
    if (charCount) return unsignedCount ? T.ucharType : T.charType;
    if (shortCount) return unsignedCount ? T.ushortType : T.shortType;
    if (longCount) return unsignedCount ? T.ulongType : T.longType;
    if (floatCount) return T.floatType;
    if (doubleCount) return T.doubleType;
    return unsignedCount ? T.uintType : T.intType;
  }

  /** Skip `((...))` after `__attribute__`. */
  skipAttributeArgs() {
    if (!this.consume('(')) return;
    let depth = 1;
    while (depth > 0) {
      const tok = this.next();
      if (tok.kind === 'eof') this.error('unterminated __attribute__');
      if (tok.text === '(') depth += 1;
      if (tok.text === ')') depth -= 1;
    }
  }

  /**
   * @param {'struct' | 'union'} kind
   * @returns {T.CType}
   */
  structUnion(kind) {
    this.next(); // struct / union
    let tag = null;
    if (this.tok().kind === 'ident' && !KEYWORDS.has(this.tok().text)) {
      tag = this.next().text;
    }

    if (this.consume('{')) {
      let ty = tag ? this.findTagCurrent(tag) : null;
      if (ty && !ty.isIncomplete) {
        this.error(`redefinition of ${kind} '${tag}'`);
      }
      if (!ty) {
        ty = T.aggregateType(kind, tag);
        if (tag) this.declareTag(tag, ty);
      }
      const members = [];
      while (!this.consume('}')) {
        const base = this.declspec();
        if (this.consume(';')) {
          // An anonymous struct/union member promotes its fields into the
          // enclosing aggregate, e.g. `struct { int x; };`.
          if (T.isAggregate(base) && !base.name) {
            members.push({ name: null, ty: base, offset: 0, anonymous: true });
          }
          continue;
        }
        for (;;) {
          if (this.at(':')) {
            // Unnamed bit-field, commonly zero-width padding in libc headers.
            this.next();
            const width = Number(this.constExpr().value);
            members.push({ name: null, ty: base, offset: 0, bitWidth: width, anonymous: true });
          } else {
            const mty = this.declarator(base, true);
            if (mty.kind === 'func') this.error('struct member cannot be a function');
            if (this.consume(':')) {
              const width = Number(this.constExpr().value);
              if (mty.name) {
                members.push({ name: mty.name, ty: mty, offset: 0, bitWidth: width });
              } else {
                members.push({ name: null, ty: mty, offset: 0, bitWidth: width, anonymous: true });
              }
            } else if (mty.name) {
              members.push({ name: mty.name, ty: mty, offset: 0 });
            } else {
              this.error('struct member needs a name');
            }
          }
          if (!this.consume(',')) break;
        }
        this.expect(';');
      }
      ty.members = members;
      T.layoutAggregate(ty, kind === 'union');
      return ty;
    }

    if (!tag) this.error(`anonymous ${kind} needs a body`);
    const existing = this.findTag(tag);
    if (existing) return existing;
    const ty = T.aggregateType(kind, tag);
    this.declareTag(tag, ty);
    return ty;
  }

  /** @returns {T.CType} */
  enumSpecifier() {
    this.next(); // enum
    let tag = null;
    if (this.tok().kind === 'ident' && !KEYWORDS.has(this.tok().text)) tag = this.next().text;

    if (this.consume('{')) {
      const ty = new T.CType('enum');
      ty.size = 4;
      ty.align = 4;
      ty.tag = tag;
      let value = 0n;
      while (!this.consume('}')) {
        const nameTok = this.next();
        if (nameTok.kind !== 'ident') this.error('expected enumerator name', nameTok);
        if (this.consume('=')) value = this.constExpr().value;
        this.declare(nameTok.text, { kind: 'enum', value, ty: T.intType });
        value += 1n;
        if (!this.consume(',')) {
          this.expect('}');
          break;
        }
        if (this.consume('}')) break;
      }
      if (tag) this.declareTag(tag, ty);
      return ty;
    }

    if (tag) {
      const existing = this.findTag(tag);
      if (existing && existing.kind === 'enum') return existing;
    }
    const ty = new T.CType('enum');
    ty.size = 4;
    ty.align = 4;
    ty.tag = tag;
    if (tag) this.declareTag(tag, ty);
    return ty;
  }

  /**
   * @param {T.CType} ty
   * @returns {T.CType}
   */
  pointers(ty) {
    while (this.consume('*')) {
      ty = T.pointerTo(ty);
      while (
        this.at('const') ||
        this.at('volatile') ||
        this.at('restrict') ||
        this.at('__restrict') ||
        this.at('__restrict__') ||
        this.at('_Atomic')
      ) {
        this.next();
      }
    }
    return ty;
  }

  /**
   * @param {T.CType} ty
   * @returns {T.CType}
   */
  typeSuffix(ty) {
    if (this.consume('(')) {
      if (this.consume(')')) return T.funcType(ty, [], true);
      if (this.at('void') && this.tok(1).text === ')') {
        this.next();
        this.next();
        return T.funcType(ty, []);
      }
      /** @type {{name: string, ty: T.CType}[]} */
      const params = [];
      let variadic = false;
      for (;;) {
        if (this.consume('...')) {
          variadic = true;
          this.expect(')');
          break;
        }
        const base = this.declspec();
        let pty = this.declarator(base, true);
        const name = pty.name;
        if (pty.kind === 'array') pty = withName(T.pointerTo(pty.base), name);
        else if (pty.kind === 'func') pty = withName(T.pointerTo(pty), name);
        params.push({ name, ty: pty });
        if (this.consume(',')) continue;
        this.expect(')');
        break;
      }
      return T.funcType(ty, params, variadic);
    }
    if (this.consume('[')) {
      // C99 array parameter qualifiers: `[static 4]`, `[const]`, ...
      while (this.at('static') || this.at('const') || this.at('volatile') || this.at('restrict') || this.at('__restrict') || this.at('__restrict__')) this.next();
      let len = -1;
      if (!this.consume(']')) {
        const value = this.constExpr().value;
        this.expect(']');
        len = Number(value);
        if (typeof len !== 'number' || isNaN(len) || len < 0) {
          this.error(`invalid array size: ${value}`);
        }
      }
      const inner = this.typeSuffix(ty);
      return T.arrayOf(inner, len);
    }
    if (this.consume('...')) {
      return ty;
    }
    return ty;
  }

  /**
   * Parse a declarator and attach its identifier to the resulting type.
   * @param {T.CType} ty
   * @param {boolean} [allowAbstract]
   * @returns {T.CType}
   */
  declarator(ty, allowAbstract = false) {
    ty = this.pointers(ty);

    if (this.at('(') && this.isDeclaratorParen()) {
      const innerStart = this.pos + 1;
      this.next();
      this.declarator(T.intType, true); // skip to matching ')'
      this.expect(')');
      const suffixed = this.typeSuffix(ty);
      const after = this.pos;
      this.pos = innerStart;
      const result = this.declarator(suffixed, allowAbstract);
      this.pos = after;
      return result;
    }

    let name = null;
    // Read a name when present; typename parsing relies on the fact that
    // typename tokens never have a bare identifier to consume.
    if (this.tok().kind === 'ident' && !KEYWORDS.has(this.tok().text)) {
      name = this.next().text;
    }
    ty = this.typeSuffix(ty);
    return withName(ty, name);
  }

  /**
   * Distinguish a parenthesized declarator `(*name)` from a function
   * parameter list `(int)` in a declaration like `int (*fp)(void)`.
   * @returns {boolean}
   */
  isDeclaratorParen() {
    const next = this.tok(1);
    return (
      next.text === '*' ||
      next.text === '(' ||
      (next.kind === 'ident' && !KEYWORDS.has(next.text))
    );
  }

  /** @returns {T.CType} */
  typename() {
    const base = this.declspec();
    return this.declarator(base, true);
  }

  // --------------------------------------------------------- expressions

  /**
   * @param {string} kind
   * @returns {Node}
   */
  node(kind) {
    return new Node(kind, this.tok());
  }

  /** @param {bigint} value @param {T.CType} [ty] @returns {Node} */
  num(value, ty = T.intType) {
    const node = new Node('num', this.tok());
    node.val = value;
    node.ty = ty;
    return node;
  }

  /**
   * @param {Node} lhs
   * @param {Node} rhs
   * @param {string} kind
   * @returns {Node}
   */
  newBinary(kind, lhs, rhs) {
    this.addType(lhs);
    this.addType(rhs);
    let lt = T.decay(lhs.ty);
    let rt = T.decay(rhs.ty);

    if (kind === 'add' && T.isInteger(lt) && T.isPointer(rt)) {
      [lhs, rhs] = [rhs, lhs];
      [lt, rt] = [rt, lt];
    }

    if ((kind === 'add' || kind === 'sub') && T.isPointer(lt)) {
      if (kind === 'sub' && T.isPointer(rt)) {
        const node = new Node(kind, this.tok());
        node.lhs = lhs;
        node.rhs = rhs;
        node.ty = T.longType;
        node.opTy = T.longType;
        node.ptrDiff = true;
        node.ptrBase = lt.base;
        return node;
      }
      if (!T.isInteger(rt)) this.error('pointer arithmetic needs an integer operand');
      const node = new Node(kind, this.tok());
      node.lhs = lhs;
      node.rhs = this.castTo(rhs, T.longType);
      node.ty = lt;
      node.opTy = T.longType;
      node.ptrScale = lt.base.size > 0 ? lt.base.size : 1;
      return node;
    }

    if (['eq', 'ne', 'lt', 'le', 'gt', 'ge'].includes(kind) && (T.isPointer(lt) || T.isPointer(rt))) {
      const node = new Node(kind, this.tok());
      node.lhs = lhs;
      node.rhs = rhs;
      node.ty = T.intType;
      node.opTy = T.ulongType;
      node.ptrCmp = true;
      return node;
    }

    if ((T.isFloating(lt) || T.isFloating(rt)) && kind !== 'logand' && kind !== 'logor') {
      const allowed = ['add', 'sub', 'mul', 'div', 'eq', 'ne', 'lt', 'le', 'gt', 'ge'];
      const arith = (ty) => T.isInteger(ty) || T.isFloating(ty);
      if (!arith(lt) || !arith(rt) || !allowed.includes(kind)) {
        this.error(`invalid operands to '${kind}' (${lt.toString()} and ${rt.toString()})`);
      }
      const common = T.commonType(lt, rt);
      const node = new Node(kind, this.tok());
      node.lhs = this.castTo(lhs, common);
      node.rhs = this.castTo(rhs, common);
      node.opTy = common;
      node.ty = ['eq', 'ne', 'lt', 'le', 'gt', 'ge'].includes(kind) ? T.intType : common;
      return node;
    }

    if (kind === 'logand' || kind === 'logor') {
      const scalar = (ty) => T.isInteger(ty) || T.isPointer(ty) || T.isFloating(ty);
      if (!scalar(lt) || !scalar(rt)) {
        this.error(`invalid operands to '${kind}' (${lt.toString()} and ${rt.toString()})`);
      }
      const node = new Node(kind, this.tok());
      node.lhs = lhs;
      node.rhs = rhs;
      node.ty = T.intType;
      node.opTy = T.intType;
      return node;
    }

    if (!T.isInteger(lt) || !T.isInteger(rt)) {
      this.error(`invalid operands to '${kind}' (${lt.toString()} and ${rt.toString()})`);
    }

    if (kind === 'shl' || kind === 'shr') {
      const promoted = T.promote(lt);
      const node = new Node(kind, this.tok());
      node.lhs = this.castTo(lhs, promoted);
      node.rhs = this.castTo(rhs, T.intType);
      node.ty = promoted;
      node.opTy = promoted;
      return node;
    }

    const common = T.commonType(lt, rt);
    const node = new Node(kind, this.tok());
    if (kind !== 'logand' && kind !== 'logor') {
      node.lhs = this.castTo(lhs, common);
      node.rhs = this.castTo(rhs, common);
    } else {
      node.lhs = lhs;
      node.rhs = rhs;
    }
    node.opTy = common;
    node.ty = ['eq', 'ne', 'lt', 'le', 'gt', 'ge', 'logand', 'logor'].includes(kind) ? T.intType : common;
    return node;
  }

  /**
   * @param {Node} expr
   * @param {T.CType} ty
   * @returns {Node}
   */
  castTo(expr, ty) {
    this.addType(expr);
    if (T.sameType(expr.ty, ty)) return expr;
    if (expr.ty.kind === 'array' && T.isPointer(ty)) return expr;
    if (expr.ty.kind === 'func' && T.isPointer(ty)) return expr;
    if (T.isAggregate(expr.ty) && T.isAggregate(ty)) return expr;
    const node = new Node('cast', expr.tok);
    node.expr = expr;
    node.castTy = ty;
    node.ty = ty;
    return node;
  }

  /**
   * Attach a type to a node, recursing as needed.
   * @param {Node} node
   */
  addType(node) {
    if (!node || node.ty) return;
    switch (node.kind) {
      case 'num':
        node.ty = T.intType;
        return;
      case 'var':
        node.ty = node.var.ty;
        return;
      case 'cast':
        this.addType(node.expr);
        node.ty = node.castTy;
        return;
      case 'addr':
        this.addType(node.expr);
        node.ty = T.pointerTo(node.expr.ty);
        return;
      case 'deref': {
        this.addType(node.expr);
        const ty = T.decay(node.expr.ty);
        if (!ty.base) this.error('dereference of a non-pointer');
        node.ty = ty.base;
        return;
      }
      case 'member':
        this.addType(node.lhs);
        node.ty = node.member.ty;
        return;
      case 'neg':
      case 'bitnot':
        this.addType(node.expr);
        node.ty = T.promote(node.expr.ty);
        return;
      case 'not':
        this.addType(node.expr);
        node.ty = T.intType;
        return;
      case 'preinc':
      case 'predec':
      case 'postinc':
      case 'postdec':
        this.addType(node.expr);
        node.ty = node.expr.ty;
        return;
      case 'assign':
        this.addType(node.lhs);
        this.addType(node.rhs);
        node.ty = node.lhs.ty;
        return;
      case 'comma':
        this.addType(node.rhs);
        node.ty = node.rhs.ty;
        return;
      case 'cond': {
        this.addType(node.then);
        if (!node.then.ty) this.error('invalid conditional expression');
        this.addType(node.els);
        if (!node.els.ty) this.error('invalid conditional expression');
        if (T.isAggregate(node.then.ty) && T.isAggregate(node.els.ty)) {
          node.ty = node.then.ty;
        } else if (node.then.ty.kind === 'void' || node.els.ty.kind === 'void') {
          node.ty = T.voidType;
        } else {
          node.ty = T.commonType(T.decay(node.then.ty), T.decay(node.els.ty));
        }
        return;
      }
      case 'funcall': {
        this.addType(node.fn);
        const fty = node.fn.ty.kind === 'ptr' ? node.fn.ty.base : node.fn.ty;
        if (!fty || fty.kind !== 'func') this.error('called object is not a function');
        node.funcTy = fty;
        node.ty = fty.returnTy;
        return;
      }
      case 'memzero':
        return;
      case 'null':
        node.ty = T.voidType;
        return;
      default:
        break;
    }

    // Binary operators.
    this.addType(node.lhs);
    this.addType(node.rhs);
    if (!node.opTy) node.opTy = T.commonType(T.decay(node.lhs.ty), T.decay(node.rhs.ty));
    node.ty = T.intType;
  }

  /**
   * @param {Node} lhs
   * @param {Node} rhs
   * @returns {Node}
   */
  newAssign(lhs, rhs) {
    this.addType(lhs);
    this.addType(rhs);
    if (!this.isLvalue(lhs)) this.error('left side of assignment is not an lvalue');
    if (T.isArray(lhs.ty) || T.isFunc(lhs.ty)) this.error('cannot assign to an array or function');
    let converted = rhs;
    if (T.isAggregate(lhs.ty)) {
      if (!T.sameType(lhs.ty, rhs.ty)) this.error('incompatible struct assignment');
    } else {
      converted = this.castTo(rhs, lhs.ty);
    }
    const node = new Node('assign', lhs.tok);
    node.lhs = lhs;
    node.rhs = converted;
    node.ty = lhs.ty;
    return node;
  }

  /** @param {Node} node @returns {boolean} */
  isLvalue(node) {
    this.addType(node);
    return node.kind === 'var' || node.kind === 'deref' || node.kind === 'member';
  }

  /** @returns {Node} */
  expr() {
    let node = this.assign();
    while (this.consume(',')) {
      const rhs = this.assign();
      const comma = new Node('comma', node.tok);
      comma.lhs = node;
      comma.rhs = rhs;
      this.addType(comma);
      node = comma;
    }
    return node;
  }

  /** @returns {Node} */
  assign() {
    const lhs = this.conditional();
    const op = this.tok().text;
    const compound = {
      '+=': 'add',
      '-=': 'sub',
      '*=': 'mul',
      '/=': 'div',
      '%=': 'mod',
      '&=': 'bitand',
      '|=': 'bitor',
      '^=': 'bitxor',
      '<<=': 'shl',
      '>>=': 'shr',
    };
    if (op in compound) {
      this.next();
      const rhs = this.assign();
      return this.newAssignOp(lhs, compound[op], rhs);
    }
    if (this.consume('=')) {
      const rhs = this.assign();
      return this.newAssign(lhs, rhs);
    }
    return lhs;
  }

  /**
   * @param {Node} lhs
   * @param {string} op
   * @param {Node} rhs
   * @returns {Node}
   */
  newAssignOp(lhs, op, rhs) {
    this.addType(lhs);
    this.addType(rhs);
    if (!this.isLvalue(lhs)) this.error('left side of assignment is not an lvalue');
    const node = new Node('assignOp', lhs.tok);
    node.lhs = lhs;
    node.rhs = rhs;
    node.op = op;
    node.ty = lhs.ty;
    node.opTy = lhs.ty;
    if (T.isPointer(lhs.ty) && (op === 'add' || op === 'sub')) {
      // `p += n` / `p -= n` scales n by the pointed-to type, exactly like the
      // non-assignment form handled by newBinary().
      if (!T.isInteger(T.decay(rhs.ty))) this.error('pointer arithmetic needs an integer operand');
      node.rhs = this.castTo(rhs, T.longType);
      node.opTy = T.longType;
      node.ptrScale = lhs.ty.base && lhs.ty.base.size > 0 ? lhs.ty.base.size : 1;
    }
    return node;
  }

  /** @returns {Node} */
  conditional() {
    const cond = this.logOr();
    if (!this.consume('?')) return cond;
    const thenExpr = this.expr();
    this.expect(':');
    const elseExpr = this.conditional();
    const node = new Node('cond', cond.tok);
    node.cond = cond;
    node.then = thenExpr;
    node.els = elseExpr;
    this.addType(node);
    return node;
  }

  /** @param {string} kind @param {() => Node} next */
  binaryLevel(kind, next) {
    let node = next();
    while (this.at(kind)) {
      const tok = this.next();
      const rhs = next();
      node = this.newBinary(kind, node, rhs);
      node.tok = tok;
    }
    return node;
  }

  logOr() {
    let node = this.logAnd();
    while (this.at('||')) {
      const tok = this.next();
      node = this.newBinary('logor', node, this.logAnd());
      node.tok = tok;
    }
    return node;
  }

  logAnd() {
    let node = this.bitOr();
    while (this.at('&&')) {
      const tok = this.next();
      node = this.newBinary('logand', node, this.bitOr());
      node.tok = tok;
    }
    return node;
  }

  bitOr() {
    let node = this.bitXor();
    while (this.at('|')) {
      const tok = this.next();
      node = this.newBinary('bitor', node, this.bitXor());
      node.tok = tok;
    }
    return node;
  }

  bitXor() {
    let node = this.bitAnd();
    while (this.at('^')) {
      const tok = this.next();
      node = this.newBinary('bitxor', node, this.bitAnd());
      node.tok = tok;
    }
    return node;
  }

  bitAnd() {
    let node = this.equality();
    while (this.at('&')) {
      const tok = this.next();
      node = this.newBinary('bitand', node, this.equality());
      node.tok = tok;
    }
    return node;
  }

  equality() {
    let node = this.relational();
    for (;;) {
      if (this.at('==')) {
        const tok = this.next();
        node = this.newBinary('eq', node, this.relational());
        node.tok = tok;
      } else if (this.at('!=')) {
        const tok = this.next();
        node = this.newBinary('ne', node, this.relational());
        node.tok = tok;
      } else {
        return node;
      }
    }
  }

  relational() {
    let node = this.shift();
    for (;;) {
      if (this.at('<')) {
        const tok = this.next();
        node = this.newBinary('lt', node, this.shift());
        node.tok = tok;
      } else if (this.at('<=')) {
        const tok = this.next();
        node = this.newBinary('le', node, this.shift());
        node.tok = tok;
      } else if (this.at('>')) {
        const tok = this.next();
        node = this.newBinary('gt', node, this.shift());
        node.tok = tok;
      } else if (this.at('>=')) {
        const tok = this.next();
        node = this.newBinary('ge', node, this.shift());
        node.tok = tok;
      } else {
        return node;
      }
    }
  }

  shift() {
    let node = this.add();
    for (;;) {
      if (this.at('<<')) {
        const tok = this.next();
        node = this.newBinary('shl', node, this.add());
        node.tok = tok;
      } else if (this.at('>>')) {
        const tok = this.next();
        node = this.newBinary('shr', node, this.add());
        node.tok = tok;
      } else {
        return node;
      }
    }
  }

  add() {
    let node = this.mul();
    for (;;) {
      if (this.at('+')) {
        const tok = this.next();
        node = this.newBinary('add', node, this.mul());
        node.tok = tok;
      } else if (this.at('-')) {
        const tok = this.next();
        node = this.newBinary('sub', node, this.mul());
        node.tok = tok;
      } else {
        return node;
      }
    }
  }

  mul() {
    let node = this.cast();
    for (;;) {
      if (this.at('*')) {
        const tok = this.next();
        node = this.newBinary('mul', node, this.cast());
        node.tok = tok;
      } else if (this.at('/')) {
        const tok = this.next();
        node = this.newBinary('div', node, this.cast());
        node.tok = tok;
      } else if (this.at('%')) {
        const tok = this.next();
        node = this.newBinary('mod', node, this.cast());
        node.tok = tok;
      } else {
        return node;
      }
    }
  }

  cast() {
    const tok = this.tok();
    if (this.at('(') && this.isTypenameStartAt(1)) {
      this.next();
      const ty = this.typename();
      this.expect(')');
      if (this.at('{')) {
        // Compound literal: allocate a hidden local object, then leave its
        // address in %rax. The initializer runs every time the expression is
        // evaluated, matching C semantics for block-scope compound literals.
        if (!this.currentFn) this.error('compound literals at file scope are not supported yet');
        const init = this.parseInitializer(ty);
        const obj = new Obj(this.uniqueLabel('compound'), init.ty);
        obj.isLocal = true;
        this.currentFn.locals.push(obj);
        this.assignLocalOffset(obj);
        const node = new Node('compound', tok);
        node.var = obj;
        node.ty = init.ty;
        node.init = this.localInitializer(obj, init, tok);
        return node;
      }
      const expr = this.cast();
      const node = new Node('cast', expr.tok);
      node.expr = expr;
      node.castTy = ty;
      this.addType(node);
      return node;
    }
    return this.unary();
  }

  /** @param {number} offset @returns {boolean} */
  isTypenameStartAt(offset) {
    const saved = this.pos;
    this.pos += offset;
    const result = this.isTypenameStart();
    this.pos = saved;
    return result;
  }

  /** @returns {Node} */
  unary() {
    const tok = this.tok();
    if (this.consume('+')) {
      const expr = this.cast();
      this.addType(expr);
      return this.castTo(expr, T.promote(expr.ty));
    }
    if (this.consume('-')) {
      const expr = this.cast();
      const node = new Node('neg', tok);
      node.expr = expr;
      this.addType(node);
      return node;
    }
    if (this.consume('*')) {
      const expr = this.cast();
      const node = new Node('deref', tok);
      node.expr = expr;
      this.addType(node);
      return node;
    }
    if (this.consume('&')) {
      const expr = this.cast();
      this.addType(expr);
      if (!this.isLvalue(expr) && expr.ty.kind !== 'func') this.error('cannot take the address of an rvalue');
      const node = new Node('addr', tok);
      node.expr = expr;
      this.addType(node);
      return node;
    }
    if (this.consume('!')) {
      const expr = this.cast();
      const node = new Node('not', tok);
      node.expr = expr;
      this.addType(node);
      return node;
    }
    if (this.consume('~')) {
      const expr = this.cast();
      const node = new Node('bitnot', tok);
      node.expr = expr;
      this.addType(node);
      return node;
    }
    if (this.at('++') || this.at('--')) {
      const kind = this.next().text === '++' ? 'preinc' : 'predec';
      const expr = this.unary();
      const node = new Node(kind, tok);
      node.expr = expr;
      this.addType(node);
      return node;
    }
    if (this.at('sizeof')) {
      this.next();
      let ty;
      if (this.at('(') && this.isTypenameStartAt(1)) {
        this.next();
        ty = this.typename();
        this.expect(')');
      } else {
        const expr = this.unary();
        this.addType(expr);
        ty = expr.ty;
      }
      if (ty.kind === 'array' && ty.arrayLen < 0) this.error('sizeof of an incomplete type');
      return this.num(BigInt(ty.size), T.ulongType);
    }
    if (this.at('_Alignof')) {
      this.next();
      let ty;
      if (this.consume('(') && this.isTypenameStart()) {
        ty = this.typename();
        this.expect(')');
      } else {
        const expr = this.unary();
        this.addType(expr);
        ty = expr.ty;
      }
      return this.num(BigInt(ty.align), T.ulongType);
    }
    return this.postfix();
  }

  /** @returns {Node} */
  postfix() {
    let node = this.primary();
    for (;;) {
      if (this.consume('[')) {
        const index = this.expr();
        this.expect(']');
        const added = this.newBinary('add', node, index);
        const deref = new Node('deref', added.tok);
        deref.expr = added;
        this.addType(deref);
        node = deref;
        continue;
      }
      if (node.kind === 'builtin' && node.builtin === '__builtin_va_arg' && this.at('(')) {
        // GCC's va_arg macro passes a type name as its second operand, which
        // is not a normal expression.
        this.next();
        const ap = this.assign();
        this.expect(',');
        const ty = this.typename();
        this.expect(')');
        const arg = new Node('builtin', node.tok);
        arg.builtin = '__builtin_va_arg';
        arg.args = [ap];
        arg.vaTy = ty;
        arg.ty = T.decay(ty);
        node = arg;
        continue;
      }
      if (this.consume('(')) {
        /** @type {Node[]} */
        const args = [];
        if (!this.at(')')) {
          for (;;) {
            args.push(this.assign());
            if (!this.consume(',')) break;
          }
        }
        this.expect(')');
        node = this.newFuncall(node, args);
        continue;
      }
      if (this.at('.') || this.at('->')) {
        const arrow = this.next().text === '->';
        if (arrow) {
          const deref = new Node('deref', this.tok());
          deref.expr = node;
          this.addType(deref);
          node = deref;
        }
        const nameTok = this.next();
        if (nameTok.kind !== 'ident') this.error('expected member name', nameTok);
        node = this.memberAccess(node, nameTok.text, nameTok);
        continue;
      }
      if (this.at('++') || this.at('--')) {
        const kind = this.next().text === '++' ? 'postinc' : 'postdec';
        const inc = new Node(kind, node.tok);
        inc.expr = node;
        this.addType(inc);
        node = inc;
        continue;
      }
      return node;
    }
  }

  /**
   * @param {Node} base
   * @param {string} name
   * @param {import('./tokenize.js').Token} tok
   * @returns {Node}
   */
  memberAccess(base, name, tok) {
    this.addType(base);
    const ty = base.ty;
    if (!T.isAggregate(ty)) this.error(`member access on non-aggregate type '${ty.toString()}'`, tok);
    const found = this.findMember(ty, name, 0);
    if (!found) this.error(`no member named '${name}'`, tok);
    const node = new Node('member', tok);
    node.lhs = base;
    // Anonymous struct/union members add their own offset to the enclosing
    // aggregate, so keep a flattened copy for the backend.
    node.member = { ...found.member, offset: found.offset };
    node.ty = found.member.ty;
    return node;
  }

  /**
   * Find a member, descending into anonymous aggregates.
   * @param {T.CType} ty
   * @param {string} name
   * @param {number} baseOffset
   * @returns {{member: any, offset: number} | null}
   */
  findMember(ty, name, baseOffset) {
    for (const member of ty.members ?? []) {
      if (member.name === name) return { member, offset: baseOffset + member.offset };
      if ((!member.name || member.anonymous) && T.isAggregate(member.ty)) {
        const inner = this.findMember(member.ty, name, baseOffset + member.offset);
        if (inner) return inner;
      }
    }
    return null;
  }

  /**
   * @param {Node} fn
   * @param {Node[]} args
   * @returns {Node}
   */
  newFuncall(fn, args) {
    if (fn.kind === 'builtin') return this.newBuiltin(fn, args);
    this.addType(fn);
    const fty = fn.ty.kind === 'ptr' ? fn.ty.base : fn.ty;
    if (!fty || fty.kind !== 'func') this.error('called object is not a function');
    const params = fty.params ?? [];
    for (let i = 0; i < args.length; i += 1) {
      this.addType(args[i]);
      if (i < params.length) {
        args[i] = this.castTo(args[i], params[i].ty);
      } else {
        let ty = T.decay(args[i].ty);
        // Default argument promotions for variadic arguments.
        if (ty.kind === 'float') ty = T.doubleType;
        if (T.isInteger(ty) && ty.size < 4) args[i] = this.castTo(args[i], T.intType);
        else if (ty.kind !== args[i].ty.kind) args[i] = this.castTo(args[i], ty);
      }
    }
    if (!fty.isVariadic && fty.params && args.length !== params.length) {
      this.error(`expected ${params.length} arguments, got ${args.length}`);
    }
    const node = new Node('funcall', fn.tok);
    node.fn = fn;
    node.args = args;
    node.ty = fty.returnTy;
    node.funcTy = fty;
    if (T.isAggregate(fty.returnTy) && this.currentFn) {
      // Aggregates are returned in registers; reserve a slot to materialize
      // the value so that the result can be used as an address.
      const obj = new Obj(this.uniqueLabel('ret'), fty.returnTy);
      obj.isLocal = true;
      this.currentFn.locals.push(obj);
      this.assignLocalOffset(obj);
      node.retTemp = obj;
    }
    return node;
  }

  /**
   * Build a node for one of the GCC builtins the compiler implements.
   * @param {Node} fn
   * @param {Node[]} args
   * @returns {Node}
   */
  newBuiltin(fn, args) {
    for (const arg of args) this.addType(arg);
    const node = new Node('builtin', fn.tok);
    node.builtin = fn.builtin;
    node.args = args;
    switch (fn.builtin) {
      case '__builtin_expect':
        node.ty = args[0]?.ty ?? T.intType;
        break;
      case '__builtin_clz':
      case '__builtin_clzll':
      case '__builtin_ctz':
      case '__builtin_ctzll':
      case '__builtin_popcount':
      case '__builtin_popcountll':
      case '__builtin_constant_p':
        node.ty = T.intType;
        break;
      case '__builtin_bswap16':
        node.ty = T.ushortType;
        break;
      case '__builtin_bswap32':
        node.ty = T.uintType;
        break;
      case '__builtin_bswap64':
        node.ty = T.ulongType;
        break;
      case '__builtin_frame_address':
        node.ty = T.pointerTo(T.voidType);
        break;
      default:
        node.ty = T.voidType;
        break;
    }
    return node;
  }

  /** @returns {Node} */
  primary() {
    const tok = this.tok();
    if (tok.kind === 'num') {
      this.next();
      return this.num(tok.val, T.typeFromHint(tok.numType));
    }
    if (tok.kind === 'str') {
      return this.stringLiteral();
    }
    if (tok.kind === 'ident') {
      if (tok.text === '(') this.error('unexpected ('); // unreachable, keeps linters calm
      if (tok.text === '__func__' && this.currentFn && !this.lookup('__func__')) {
        this.next();
        const bytes = [...Buffer.from(this.currentFn.name, 'utf8'), 0];
        return this.makeString(bytes, tok);
      }
      if (tok.text.startsWith('__builtin_') && !this.lookup(tok.text)) {
        this.next();
        const node = new Node('builtin', tok);
        node.builtin = tok.text;
        node.ty = T.funcType(T.intType, [], true);
        return node;
      }
      const entry = this.lookup(tok.text);
      if (!entry) this.error(`undefined variable '${tok.text}'`);
      if (entry.kind === 'enum') {
        this.next();
        return this.num(entry.value);
      }
      if (entry.kind === 'typedef') this.error(`unexpected type name '${tok.text}'`);
      this.next();
      const node = new Node('var', tok);
      node.var = entry.obj;
      node.ty = entry.obj.ty;
      return node;
    }
    if (this.consume('(')) {
      if (this.at('{')) this.error('statement expressions are not supported');
      const node = this.expr();
      this.expect(')');
      return node;
    }
    this.error(`expected an expression, got '${tok.text || 'end of file'}'`);
  }

  /** @returns {Node} */
  stringLiteral() {
    /** @type {number[]} */
    const bytes = [];
    while (this.tok().kind === 'str') {
      const tok = this.next();
      bytes.push(...(tok.strBytes ?? [...Buffer.from(tok.text, 'latin1')]));
    }
    bytes.push(0);
    return this.makeString(bytes, this.tok());
  }

  /**
   * Create a static string object and return a node that names it.
   * @param {number[]} bytes
   * @param {import('./tokenize.js').Token} tok
   * @returns {Node}
   */
  makeString(bytes, tok) {
    const label = this.uniqueLabel('str');
    const obj = new Obj(label, T.arrayOf(T.charType, bytes.length));
    obj.isStatic = true;
    obj.isDefinition = true;
    obj.isString = true;
    obj.initData = Buffer.from(bytes);
    this.globals.push(obj);
    const node = new Node('var', tok);
    node.var = obj;
    node.ty = obj.ty;
    return node;
  }

  // ------------------------------------------------------------ constants

  /** @returns {{value: bigint, symbol?: string, addend?: bigint}} */
  constExpr() {
    const expr = this.conditional();
    const value = this.evalConst(expr);
    return { value };
  }

  /**
   * Evaluate an integer constant expression.
   * @param {Node} node
   * @returns {bigint}
   */
  evalConst(node) {
    this.addType(node);
    switch (node.kind) {
      case 'num':
        return node.val;
      case 'var':
        if (node.var.isEnumConst) return node.var.value;
        if (node.var.isLocal) this.error('not a constant expression');
        return 0n;
      case 'cast':
        return this.truncate(this.evalConst(node.expr), node.ty);
      case 'neg':
        return -this.evalConst(node.expr);
      case 'bitnot':
        return ~this.evalConst(node.expr);
      case 'not':
        return this.evalConst(node.expr) === 0n ? 1n : 0n;
      case 'cond':
        return this.evalConst(node.cond) !== 0n ? this.evalConst(node.then) : this.evalConst(node.els);
      case 'comma':
        return this.evalConst(node.rhs);
      case 'assignOp':
        this.error('not a constant expression');
        break;
      default:
        break;
    }

    const lhs = this.evalConst(node.lhs);
    const rhs = this.evalConst(node.rhs);
    switch (node.kind) {
      case 'add':
        return lhs + rhs;
      case 'sub':
        return lhs - rhs;
      case 'mul':
        return lhs * rhs;
      case 'div':
        if (rhs === 0n) this.error('division by zero in constant expression');
        return lhs / rhs;
      case 'mod':
        if (rhs === 0n) this.error('division by zero in constant expression');
        return lhs % rhs;
      case 'bitand':
        return lhs & rhs;
      case 'bitor':
        return lhs | rhs;
      case 'bitxor':
        return lhs ^ rhs;
      case 'shl':
        return lhs << rhs;
      case 'shr':
        return lhs >> rhs;
      case 'eq':
        return lhs === rhs ? 1n : 0n;
      case 'ne':
        return lhs !== rhs ? 1n : 0n;
      case 'lt':
        return lhs < rhs ? 1n : 0n;
      case 'le':
        return lhs <= rhs ? 1n : 0n;
      case 'gt':
        return lhs > rhs ? 1n : 0n;
      case 'ge':
        return lhs >= rhs ? 1n : 0n;
      case 'logand':
        return lhs !== 0n && rhs !== 0n ? 1n : 0n;
      case 'logor':
        return lhs !== 0n || rhs !== 0n ? 1n : 0n;
      default:
        this.error(`not a constant expression (${node.kind})`);
    }
    return 0n;
  }

  /**
   * Truncate a value to a C type.
   * @param {bigint} value
   * @param {T.CType} ty
   * @returns {bigint}
   */
  truncate(value, ty) {
    if (ty.kind === 'bool') return value === 0n ? 0n : 1n;
    if (!T.isInteger(ty)) return value;
    const bits = BigInt(ty.size * 8);
    const mask = (1n << bits) - 1n;
    let v = value & mask;
    if (!ty.isUnsigned && ty.size < 8) {
      const sign = 1n << (bits - 1n);
      if (v & sign) v -= 1n << bits;
    }
    return v;
  }

  // ----------------------------------------------------------- statements

  /** @returns {Node} */
  compoundStmt() {
    this.expect('{');
    this.pushScope();
    /** @type {Node[]} */
    const body = [];
    while (!this.consume('}')) {
      if (this.at('{')) {
        body.push(this.compoundStmt());
        continue;
      }
      if (this.isTypenameStart()) {
        const decl = this.declaration();
        if (decl) body.push(decl);
        continue;
      }
      body.push(this.stmt());
    }
    this.popScope();
    const node = new Node('block', this.tok());
    node.body = body;
    return node;
  }

  /** @returns {Node} */
  stmt() {
    const tok = this.tok();
    if (this.consume('return')) {
      const node = new Node('return', tok);
      if (this.consume(';')) {
        node.expr = null;
        return node;
      }
      let expr = this.expr();
      this.expect(';');
      if (this.currentFn) {
        const retTy = this.currentFn.ty.returnTy;
        if (!T.isAggregate(retTy)) expr = this.castTo(expr, retTy);
      }
      node.expr = expr;
      return node;
    }
    if (this.consume('if')) {
      this.expect('(');
      const cond = this.expr();
      this.expect(')');
      const thenStmt = this.stmt();
      const node = new Node('if', tok);
      node.cond = cond;
      node.then = thenStmt;
      node.els = this.consume('else') ? this.stmt() : null;
      return node;
    }
    if (this.consume('while')) {
      this.expect('(');
      const cond = this.expr();
      this.expect(')');
      const body = this.stmt();
      const node = new Node('for', tok);
      node.init = null;
      node.cond = cond;
      node.inc = null;
      node.then = body;
      return node;
    }
    if (this.consume('do')) {
      const body = this.stmt();
      this.expect('while');
      this.expect('(');
      const cond = this.expr();
      this.expect(')');
      this.expect(';');
      const node = new Node('do', tok);
      node.then = body;
      node.cond = cond;
      return node;
    }
    if (this.consume('for')) {
      this.expect('(');
      let init = null;
      if (this.isTypenameStart()) {
        init = this.declaration();
      } else if (!this.consume(';')) {
        const expr = this.expr();
        this.expect(';');
        init = new Node('exprStmt', expr.tok);
        init.expr = expr;
      }
      let cond = null;
      if (!this.consume(';')) {
        cond = this.expr();
        this.expect(';');
      }
      let inc = null;
      if (!this.consume(')')) {
        inc = this.expr();
        this.expect(')');
      }
      const body = this.stmt();
      const node = new Node('for', tok);
      node.init = init;
      node.cond = cond;
      node.inc = inc;
      node.then = body;
      return node;
    }
    if (this.consume('switch')) {
      this.expect('(');
      const cond = this.expr();
      this.expect(')');
      const context = { cases: [], defaultLabel: null };
      this.switchStack.push(context);
      const body = this.stmt();
      this.switchStack.pop();
      const node = new Node('switch', tok);
      node.cond = cond;
      node.then = body;
      node.cases = context.cases;
      node.defaultLabel = context.defaultLabel;
      return node;
    }
    if (this.consume('case')) {
      const value = this.constExpr().value;
      this.expect(':');
      const label = this.uniqueLabel('case');
      const node = new Node('case', tok);
      node.value = value;
      node.label = label;
      node.stmt = this.stmt();
      const context = this.switchStack[this.switchStack.length - 1];
      if (!context) this.error('case label outside a switch');
      context.cases.push({ value, label });
      return node;
    }
    if (this.consume('default')) {
      this.expect(':');
      const label = this.uniqueLabel('default');
      const context = this.switchStack[this.switchStack.length - 1];
      if (!context) this.error('default label outside a switch');
      context.defaultLabel = label;
      const node = new Node('block', tok);
      node.body = [{ kind: 'label', label, stmt: this.stmt(), tok }];
      return node;
    }
    if (this.consume('break')) {
      this.expect(';');
      return new Node('break', tok);
    }
    if (this.consume('continue')) {
      this.expect(';');
      return new Node('continue', tok);
    }
    if (this.consume('goto')) {
      const nameTok = this.next();
      if (nameTok.kind !== 'ident') this.error('expected label name', nameTok);
      this.expect(';');
      const node = new Node('goto', tok);
      node.label = nameTok.text;
      return node;
    }
    if (this.consume(';')) return new Node('null', tok);
    if (this.at('{')) return this.compoundStmt();
    if (tok.kind === 'ident' && this.tok(1).text === ':') {
      this.next();
      this.next();
      const node = new Node('label', tok);
      node.label = tok.text;
      node.stmt = this.stmt();
      return node;
    }
    const expr = this.expr();
    this.expect(';');
    const node = new Node('exprStmt', expr.tok);
    node.expr = expr;
    return node;
  }

  // --------------------------------------------------------- declarations

  /** @returns {Node | null} */
  declaration() {
    const tok = this.tok();
    const attr = {};
    const base = this.declspec(attr);
    if (this.consume(';')) return null;

    /** @type {Node[]} */
    const stmts = [];
    let first = true;
    for (;;) {
      if (first && attr.isTypedef) {
        const ty = this.declarator(base, false);
        if (!ty.name) this.error('typedef needs a name');
        this.declare(ty.name, { kind: 'typedef', ty });
        if (this.consume('=')) this.error('typedef cannot have an initializer');
      } else if (first && attr.isStatic && this.currentFn) {
        const ty = this.declarator(base, false);
        if (!ty.name) this.error('static local needs a name');
        if (ty.kind === 'func') this.error('static local function is invalid');
        this.localStatic(ty, tok, stmts, attr);
      } else if (!attr.isTypedef) {
        const ty = this.declarator(base, false);
        if (!ty.name) this.error('declaration needs a name');
        if (ty.kind === 'func') {
          const fn = this.declareFunction(ty, attr);
          this.declare(ty.name, { kind: 'var', obj: fn });
          if (this.at('{')) this.error('nested function definitions are not supported');
        } else if (this.currentFn) {
          this.localVar(ty, tok, stmts, attr);
        } else {
          this.globalVar(ty, attr, tok);
        }
      } else {
        this.error('typedef may not be combined with other declarators');
      }
      first = false;
      if (this.consume(',')) continue;
      this.expect(';');
      break;
    }
    if (stmts.length === 0) return null;
    const block = new Node('block', tok);
    block.body = stmts;
    return block;
  }

  /**
   * @param {T.CType} ty
   * @param {import('./tokenize.js').Token} tok
   * @param {Node[]} stmts
   * @param {{isStatic?: boolean, isExtern?: boolean}} attr
   */
  localVar(ty, tok, stmts, attr) {
    if (!ty.name) this.error('local variable needs a name');
    if (ty.kind === 'void') this.error('variable has incomplete type void');
    if (T.isArray(ty) && ty.arrayLen < 0 && !this.at('=')) {
      this.error('array size is missing');
    }
    const obj = new Obj(ty.name, ty);
    obj.isLocal = true;
    obj.label = ty.name;
    this.declare(ty.name, { kind: 'var', obj });
    this.currentFn.locals.push(obj);

    if (this.consume('=')) {
      const init = this.parseInitializer(ty);
      ty = init.ty;
      obj.ty = ty;
      if (T.isArray(ty) && ty.arrayLen < 0) this.error('cannot infer array size');
      this.assignLocalOffset(obj);
      const initNode = this.localInitializer(obj, init, tok);
      if (initNode) stmts.push(initNode);
    } else {
      this.assignLocalOffset(obj);
    }
  }

  /**
   * @param {T.CType} ty
   * @param {import('./tokenize.js').Token} tok
   * @param {Node[]} stmts
   */
  localStatic(ty, tok, stmts, attr = {}) {
    if (!ty.name) this.error('static local needs a name');
    if (ty.kind === 'func') this.error('static local cannot be a function');
    const obj = new Obj(ty.name, ty);
    obj.isStatic = true;
    obj.isThreadLocal = Boolean(attr.isThreadLocal);
    obj.isDefinition = true;
    obj.label = this.uniqueLabel('static');
    this.declare(ty.name, { kind: 'var', obj });
    if (this.consume('=')) {
      const init = this.parseInitializer(ty);
      obj.ty = init.ty;
      obj.ty.name = ty.name;
      this.globalInitializer(obj, init, tok);
    } else {
      obj.initData = Buffer.alloc(ty.size);
    }
    this.globals.push(obj);
  }

  /**
   * Assign a stack slot to a local.
   * @param {Obj} obj
   */
  assignLocalOffset(obj) {
    if (typeof obj.ty.size !== 'number' || isNaN(obj.ty.size)) {
      this.error(`invalid type size for '${obj.name}': ${obj.ty.size}`);
    }
    if (typeof obj.ty.align !== 'number' || isNaN(obj.ty.align)) {
      this.error(`invalid type alignment for '${obj.name}': ${obj.ty.align}`);
    }
    this.localBottom += obj.ty.size;
    this.localBottom = T.alignTo(this.localBottom, obj.ty.align);
    obj.offset = -this.localBottom;
    if (this.currentFn) {
      this.currentFn.stackSize = Math.max(this.currentFn.stackSize, this.localBottom);
    }
  }

  /**
   * @param {T.CType} ty
   * @param {{isStatic?: boolean, isExtern?: boolean, isInline?: boolean}} attr
   * @param {import('./tokenize.js').Token} tok
   */
  globalVar(ty, attr, tok) {
    if (!ty.name) this.error('global variable needs a name');
    if (ty.kind === 'void') this.error('variable has incomplete type void');
    const name = ty.name;
    let obj = this.scopes[0].vars.get(name)?.kind === 'var' ? this.scopes[0].vars.get(name).obj : null;
    if (obj && (obj.isFunction || !T.sameType(obj.ty, ty))) this.error(`redefinition of '${name}'`);

    if (!obj) {
      obj = new Obj(name, ty);
      obj.isStatic = Boolean(attr.isStatic);
      obj.isExtern = Boolean(attr.isExtern);
      obj.isThreadLocal = Boolean(attr.isThreadLocal);
      if (obj.isStatic && !this.currentFn) obj.label = this.uniqueLabel('static');
      this.scopes[0].vars.set(name, { kind: 'var', obj });
      this.globals.push(obj);
    } else {
      obj.isStatic = obj.isStatic || Boolean(attr.isStatic);
      obj.isExtern = obj.isExtern && Boolean(attr.isExtern);
      obj.isThreadLocal = obj.isThreadLocal || Boolean(attr.isThreadLocal);
    }

    if (this.consume('=')) {
      const init = this.parseInitializer(ty);
      obj.ty = init.ty;
      obj.ty.name = name;
      obj.isExtern = false;
      obj.isDefinition = true;
      this.globalInitializer(obj, init, tok);
      return;
    }

    if (!attr.isExtern && !obj.isDefinition) {
      obj.isTentative = true;
      obj.isDefinition = true;
      if (!obj.initData) obj.initData = Buffer.alloc(obj.ty.size);
    }
  }

  /**
   * @param {T.CType} ty
   * @param {{isStatic?: boolean, isExtern?: boolean, isInline?: boolean}} attr
   * @returns {Obj}
   */
  declareFunction(ty, attr) {
    const name = ty.name;
    if (!name) this.error('function needs a name');
    let obj = this.scopes[0].vars.get(name)?.kind === 'var' ? this.scopes[0].vars.get(name).obj : null;
    if (obj) {
      if (!obj.isFunction) this.error(`redefinition of '${name}' as a function`);
      // Prefer the definition's prototype when a later declaration provides
      // full type information (including parameter names).
      const oldParams = obj.ty.params ?? [];
      const newParams = ty.params ?? [];
      const named = newParams.length > 0 && newParams.every((p) => p.name);
      if (named || oldParams.length === 0) obj.ty = ty;
    } else {
      obj = new Obj(name, ty);
      obj.isFunction = true;
      obj.isStatic = Boolean(attr.isStatic);
      obj.isExtern = Boolean(attr.isExtern);
      obj.isInline = Boolean(attr.isInline);
      if (obj.isStatic) obj.label = this.uniqueLabel('static');
      this.scopes[0].vars.set(name, { kind: 'var', obj });
    }
    obj.isStatic = obj.isStatic || Boolean(attr.isStatic);
    return obj;
  }

  // -------------------------------------------------- function definition

  /** @param {Obj} fn */
  functionDefinition(fn) {
    if (fn.isDefinition) this.error(`redefinition of function '${fn.name}'`);
    fn.isDefinition = true;
    fn.isExtern = false;
    const previousFn = this.currentFn;
    const previousBottom = this.localBottom;
    this.currentFn = fn;
    this.localBottom = 0;
    this.pushScope();

    // Large aggregates are returned through a hidden pointer passed by the
    // caller in the first integer register. Reserve a slot for it.
    if (T.isAggregate(fn.ty.returnTy) && fn.ty.returnTy.size > 16) {
      const slot = new Obj(this.uniqueLabel('sret'), T.pointerTo(T.voidType));
      slot.isLocal = true;
      this.currentFn.locals.push(slot);
      this.assignLocalOffset(slot);
      fn.sretSlot = slot;
    }

    // Variadic functions need a register save area for the incoming argument
    // registers (6 GP + 8 SSE, laid out as the SysV va_list expects).
    if (fn.ty.isVariadic) {
      const area = new Obj(this.uniqueLabel('vaarea'), T.arrayOf(T.charType, 176));
      area.isLocal = true;
      fn.locals.push(area);
      this.assignLocalOffset(area);
      fn.vaArea = area;
    }

    for (const param of fn.ty.params ?? []) {
      if (!param.name) this.error(`parameter name omitted in definition of '${fn.name}'`);
      const obj = new Obj(param.name, param.ty);
      obj.isLocal = true;
      obj.param = true;
      this.declare(param.name, { kind: 'var', obj });
      fn.locals.push(obj);
      fn.params.push(obj);
      this.assignLocalOffset(obj);
    }

    const bodyTok = this.tok();
    const body = this.compoundStmt();
    fn.body = body;
    void bodyTok;
    fn.stackSize = T.alignTo(this.localBottom, 16);
    this.popScope();
    this.currentFn = previousFn;
    this.localBottom = previousBottom;
    this.functions.push(fn);
  }

  // --------------------------------------------------------- initializers

  /**
   * @param {T.CType} ty
   * @returns {{ty: T.CType, expr: Node | null, children: any[] | null, flexible: boolean, mem: any}}
   */
  newInitializer(ty) {
    const init = { ty, expr: null, children: null, flexible: false, mem: null };
    if (ty.kind === 'array') {
      init.children = [];
      init.flexible = ty.arrayLen < 0;
      if (!init.flexible) {
        for (let i = 0; i < ty.arrayLen; i += 1) init.children.push(this.newInitializer(ty.base));
      }
    } else if (ty.kind === 'struct' || ty.kind === 'union') {
      init.children = (ty.members ?? []).map((m) => this.newInitializer(m.ty));
    }
    return init;
  }

  /**
   * @param {T.CType} ty
   * @returns {{ty: T.CType, expr: Node | null, children: any[] | null, flexible: boolean, mem: any}}
   */
  parseInitializer(ty) {
    const init = this.newInitializer(ty);
    this.initializer2(init);
    return init;
  }

  /**
   * @param {any} init
   */
  initializer2(init) {
    const ty = init.ty;
    if (ty.kind === 'array' && this.tok().kind === 'str' && isCharType(ty.base)) {
      this.stringArrayInitializer(init);
      return;
    }

    if (ty.kind === 'array') {
      if (this.at('{')) {
        this.arrayInitializer(init);
      } else {
        // Unbraced arrays only appear nested in another braced initializer.
        const len = ty.arrayLen < 0 ? 0 : ty.arrayLen;
        if (init.flexible) this.error('array size cannot be inferred from an unbraced initializer');
        for (let i = 0; i < len; i += 1) {
          if (i > 0 && !this.consume(',')) break;
          if (this.at('}')) break;
          this.initializer2(init.children[i]);
        }
      }
      return;
    }

    if (ty.kind === 'struct') {
      if (this.at('{')) {
        this.structInitializer(init);
        return;
      }
      // `struct T x = y;`
      const save = this.pos;
      const expr = this.assign();
      this.addType(expr);
      if (expr.ty.kind === 'struct' || expr.ty.kind === 'union') {
        if (!T.sameType(expr.ty, ty)) this.error('incompatible struct initializer');
        init.expr = expr;
        return;
      }
      // Unbraced member list, nested inside another braced initializer.
      this.pos = save;
      this.structInitializerUnbraced(init, 0);
      return;
    }

    if (ty.kind === 'union') {
      this.unionInitializer(init);
      return;
    }

    if (this.consume('{')) {
      this.initializer2(init);
      this.expect('}');
      return;
    }
    init.expr = this.assign();
  }

  /** @param {any} init */
  stringArrayInitializer(init) {
    /** @type {number[]} */
    const bytes = [];
    while (this.tok().kind === 'str') {
      const tok = this.next();
      bytes.push(...(tok.strBytes ?? [...Buffer.from(tok.text, 'latin1')]));
    }
    bytes.push(0);
    const base = init.ty.base;
    const len = init.ty.arrayLen >= 0 ? init.ty.arrayLen : bytes.length;
    init.ty = T.arrayOf(base, len);
    init.children = [];
    for (let i = 0; i < len; i += 1) {
      const child = this.newInitializer(base);
      child.expr = this.num(BigInt(bytes[i] ?? 0), T.intType);
      init.children.push(child);
    }
  }

  /** @param {any} init */
  arrayInitializer(init) {
    this.expect('{');
    /** @type {any[]} */
    const children = init.children;
    const fixedLen = init.ty.arrayLen;
    let i = 0;
    let first = true;
    while (!this.at('}')) {
      if (!first) this.expect(',');
      if (this.at('}')) break;
      first = false;
      if (this.at('[')) {
        // Designated initializer: `[index] = value`.
        this.next();
        i = Number(this.constExpr().value);
        this.expect(']');
        this.expect('=');
      }
      let child;
      if (fixedLen < 0) {
        while (children.length <= i) children.push(this.newInitializer(init.ty.base));
        child = children[i];
      } else if (i < fixedLen) {
        child = children[i];
      } else {
        // Excess elements are diagnosed to avoid silent data loss.
        this.error(`excess elements in array initializer (size ${fixedLen})`);
      }
      this.initializer2(child);
      i += 1;
    }
    this.expect('}');
    if (fixedLen < 0) init.ty = T.arrayOf(init.ty.base, children.length);
    init.flexible = false;
  }

  /** @param {any} init */
  structInitializer(init) {
    this.expect('{');
    const members = init.ty.members ?? [];
    let m = 0;
    let first = true;
    while (!this.at('}')) {
      if (!first) this.expect(',');
      if (this.at('}')) break;
      first = false;
      if (this.at('.')) {
        // Designated initializer: `.member = value`.
        this.next();
        const name = this.tok();
        if (name.kind !== 'ident') this.error('expected a member name');
        this.next();
        m = members.findIndex((member) => member.name === name.text);
        if (m < 0) this.error(`unknown member '${name.text}' in struct initializer`, name);
        this.expect('=');
      }
      if (m >= members.length) this.error('excess elements in struct initializer');
      this.initializer2(init.children[m]);
      m += 1;
    }
    this.expect('}');
  }

  /**
   * @param {any} init
   * @param {number} start
   */
  structInitializerUnbraced(init, start) {
    const members = init.ty.members ?? [];
    for (let m = start; m < members.length; m += 1) {
      if (m > start && !this.consume(',')) break;
      if (this.at('}') || this.at(']')) break;
      this.initializer2(init.children[m]);
    }
  }

  /** @param {any} init */
  unionInitializer(init) {
    const members = init.ty.members ?? [];
    init.mem = members[0] ?? null;
    if (this.at('{')) {
      this.next();
      let m = 0;
      if (this.at('.')) {
        this.next();
        const name = this.tok();
        if (name.kind !== 'ident') this.error('expected a member name');
        this.next();
        m = members.findIndex((member) => member.name === name.text);
        if (m < 0) this.error(`unknown member '${name.text}' in union initializer`, name);
        this.expect('=');
      }
      init.mem = members[m] ?? init.mem;
      if (!this.at('}')) this.initializer2(init.children[m]);
      this.consume(',');
      this.expect('}');
      return;
    }
    // A struct/union expression, e.g. a compound literal.
    const save = this.pos;
    const expr = this.assign();
    this.addType(expr);
    if (expr.ty.kind === 'struct' || expr.ty.kind === 'union') {
      if (!T.sameType(expr.ty, init.ty)) this.error('incompatible union initializer');
      init.expr = expr;
      return;
    }
    // Unbraced member initializer: rewind and initialize the first member.
    this.pos = save;
    if (init.children[0]) this.initializer2(init.children[0]);
  }

  /**
   * Build the expression sequence that initializes a local variable.
   * @param {Obj} var
   * @param {any} init
   * @param {import('./tokenize.js').Token} tok
   * @returns {Node}
   */
  localInitializer(varObj, init, tok) {
    const memzero = new Node('memzero', tok);
    memzero.var = varObj;
    const desg = { var: varObj, member: null, idx: 0, next: null };
    const assign = this.createLvarInit(init, init.ty, desg, tok);
    
    // Create a block with memzero as a statement, then the assignments
    const block = new Node('block', tok);
    block.body = [];
    if (memzero) block.body.push(memzero);
    if (assign) {
      // Flatten comma expressions into separate statements
      this.flattenComma(assign, block.body);
    }
    return block;
  }

  /**
   * Flatten comma expressions into a list of statements.
   * @param {Node} node
   * @param {Node[]} stmts
   */
  flattenComma(node, stmts) {
    if (node.kind === 'comma') {
      this.flattenComma(node.lhs, stmts);
      this.flattenComma(node.rhs, stmts);
    } else if (node.kind !== 'null') {
      stmts.push(node);
    }
  }

  /**
   * @param {any} init
   * @param {T.CType} ty
   * @param {any} desg
   * @param {import('./tokenize.js').Token} tok
   * @returns {Node}
   */
  createLvarInit(init, ty, desg, tok) {
    if (ty.kind === 'array') {
      let node = new Node('null', tok);
      const len = ty.arrayLen < 0 ? 0 : ty.arrayLen;
      for (let i = 0; i < len; i += 1) {
        const childDesg = { var: null, member: null, idx: i, next: desg };
        const rhs = this.createLvarInit(init.children[i], ty.base, childDesg, tok);
        const comma = new Node('comma', tok);
        comma.lhs = node;
        comma.rhs = rhs;
        this.addType(comma);
        node = comma;
      }
      return node;
    }

    if (ty.kind === 'struct' && !init.expr) {
      let node = new Node('null', tok);
      for (const member of ty.members ?? []) {
        const childDesg = { var: null, member, idx: 0, next: desg };
        const rhs = this.createLvarInit(
          init.children[ty.members.indexOf(member)],
          member.ty,
          childDesg,
          tok,
        );
        const comma = new Node('comma', tok);
        comma.lhs = node;
        comma.rhs = rhs;
        this.addType(comma);
        node = comma;
      }
      return node;
    }

    if (ty.kind === 'union' && !init.expr) {
      const member = init.mem ?? (ty.members ?? [])[0];
      if (!member) return new Node('null', tok);
      const idx = (ty.members ?? []).indexOf(member);
      const childDesg = { var: null, member, idx: 0, next: desg };
      return this.createLvarInit(init.children[idx], member.ty, childDesg, tok);
    }

    if (!init.expr) return new Node('null', tok);
    const lhs = this.initDesgExpr(desg, tok);
    return this.newAssign(lhs, init.expr);
  }

  /**
   * @param {any} desg
   * @param {import('./tokenize.js').Token} tok
   * @returns {Node}
   */
  initDesgExpr(desg, tok) {
    if (desg.var) {
      const node = new Node('var', tok);
      node.var = desg.var;
      node.ty = desg.var.ty;
      return node;
    }
    if (desg.member) {
      const lhs = this.initDesgExpr(desg.next, tok);
      const node = new Node('member', tok);
      node.lhs = lhs;
      node.member = desg.member;
      node.ty = desg.member.ty;
      return node;
    }
    const lhs = this.initDesgExpr(desg.next, tok);
    const index = new Node('num', tok);
    index.val = BigInt(desg.idx);
    index.ty = T.intType;
    const add = this.newBinary('add', lhs, index);
    const node = new Node('deref', tok);
    node.expr = add;
    this.addType(node);
    return node;
  }

  /**
   * Serialize a global initializer into bytes and relocations.
   * @param {Obj} obj
   * @param {any} init
   * @param {import('./tokenize.js').Token} tok
   */
  globalInitializer(obj, init, tok) {
    const buf = Buffer.alloc(obj.ty.size);
    obj.initData = buf;
    obj.relocs = [];
    this.writeGlobalInit(obj, init, obj.ty, 0);
    void tok;
  }

  /**
   * @param {Obj} obj
   * @param {any} init
   * @param {T.CType} ty
   * @param {number} offset
   */
  writeGlobalInit(obj, init, ty, offset) {
    if (ty.kind === 'array') {
      const len = ty.arrayLen < 0 ? 0 : ty.arrayLen;
      for (let i = 0; i < len; i += 1) {
        this.writeGlobalInit(obj, init.children[i], ty.base, offset + ty.base.size * i);
      }
      return;
    }
    if (ty.kind === 'struct') {
      for (const member of ty.members ?? []) {
        const child = init.children[ty.members.indexOf(member)];
        this.writeGlobalInit(obj, child, member.ty, offset + member.offset);
      }
      return;
    }
    if (ty.kind === 'union') {
      const members = ty.members ?? [];
      const member = init.mem ?? members[0];
      if (member) {
        const idx = members.indexOf(member);
        const child = init.children?.[idx];
        if (child) this.writeGlobalInit(obj, child, member.ty, offset);
      }
      return;
    }
    if (!init.expr) return;
    const result = this.evalGlobal(init.expr);
    if (result.symbol) {
      obj.relocs.push({ offset, symbol: result.symbol, addend: result.value });
      return;
    }
    const value = this.truncate(result.value, ty);
    const size = ty.size;
    if (size === 1) obj.initData.writeUInt8(Number(value & 0xffn), offset);
    else if (size === 2) obj.initData.writeUInt16LE(Number(value & 0xffffn), offset);
    else if (size === 4) obj.initData.writeUInt32LE(Number(value & 0xffffffffn), offset);
    else if (size === 8) obj.initData.writeBigUInt64LE(value & 0xffffffffffffffffn, offset);
    else this.error(`unsupported global initializer size ${size}`);
  }

  /**
   * Evaluate a global initializer which may be an address.
   * @param {Node} node
   * @returns {{value: bigint, symbol?: string}}
   */
  evalGlobal(node) {
    this.addType(node);
    if (node.kind === 'num') return { value: node.val };
    if (node.kind === 'var') {
      if (node.var.isEnumConst) return { value: node.var.value };
      if (node.var.isLocal) this.error('local variable in a global initializer');
      return { value: 0n, symbol: node.var.label };
    }
    if (node.kind === 'cast') {
      const inner = this.evalGlobal(node.expr);
      if (inner.symbol) return inner;
      return { value: this.truncate(inner.value, node.ty) };
    }
    if (node.kind === 'addr') {
      return this.evalLvalueAddress(node.expr);
    }
    if (node.kind === 'add' || node.kind === 'sub') {
      const lhs = this.evalGlobal(node.lhs);
      const rhs = this.evalGlobal(node.rhs);
      if (lhs.symbol && !rhs.symbol) {
        return { value: lhs.value + (node.kind === 'add' ? rhs.value : -rhs.value), symbol: lhs.symbol };
      }
      if (!lhs.symbol && rhs.symbol && node.kind === 'add') {
        return { value: lhs.value + rhs.value, symbol: rhs.symbol };
      }
      if (lhs.symbol && rhs.symbol) this.error('cannot subtract two addresses in a global initializer');
    }
    const value = this.evalConst(node);
    return { value };
  }

  /**
   * @param {Node} node
   * @returns {{value: bigint, symbol?: string}}
   */
  evalLvalueAddress(node) {
    this.addType(node);
    if (node.kind === 'var') {
      if (node.var.isLocal) this.error('local variable in a global initializer');
      return { value: 0n, symbol: node.var.label };
    }
    if (node.kind === 'member') {
      const base = this.evalLvalueAddress(node.lhs);
      return { value: base.value + BigInt(node.member.offset), symbol: base.symbol };
    }
    if (node.kind === 'deref') {
      return this.evalGlobal(node.expr);
    }
    this.error('unsupported address in a global initializer');
    return { value: 0n };
  }

  // ---------------------------------------------------------------- entry

  /** @returns {{globals: Obj[], functions: Obj[]}} */
  parseProgram() {
    while (this.tok().kind !== 'eof') {
      const tok = this.tok();
      const attr = {};
      const base = this.declspec(attr);
      if (this.consume(';')) continue;
      let first = true;
      for (;;) {
        const ty = this.declarator(base, false);
        if (!ty.name) this.error('declaration needs a name');
        if (attr.isTypedef) {
          this.declare(ty.name, { kind: 'typedef', ty });
          if (this.consume('=')) this.error('typedef cannot have an initializer');
        } else if (ty.kind === 'func') {
          const fn = this.declareFunction(ty, attr);
          if (first && this.at('{')) {
            this.functionDefinition(fn);
            first = false;
            break;
          }
        } else {
          this.globalVar(ty, attr, tok);
        }
        first = false;
        if (this.consume(',')) continue;
        this.expect(';');
        break;
      }
    }
    return { globals: this.globals, functions: this.functions };
  }
}

/**
 * Parse a preprocessed token stream.
 * @param {import('./tokenize.js').Token[]} tokens
 * @returns {{globals: Obj[], functions: Obj[]}}
 */
export function parse(tokens) {
  const parser = new Parser(tokens);
  return parser.parseProgram();
}
