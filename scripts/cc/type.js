/**
 * C type objects for the JavaScript C compiler.
 *
 * Types are plain objects with a `kind` discriminator. Primitive types are
 * shared singletons; pointer, array and function types are allocated on
 * demand. Struct and union types are mutable while their body is parsed.
 *
 * @module cc/type
 */

/** @typedef {import('./type.js').CType} CType */

export class CType {
  /** @param {string} kind */
  constructor(kind) {
    this.kind = kind;
    /** size in bytes */
    this.size = 0;
    /** alignment in bytes */
    this.align = 1;
    this.isUnsigned = false;
    /** pointee / element type */
    this.base = null;
    /** element count, -1 when incomplete */
    this.arrayLen = -1;
    /** @type {{name: string, ty: CType, offset: number}[] | null} */
    this.members = null;
    /** @type {CType | null} */
    this.returnTy = null;
    /** @type {{name: string, ty: CType}[] | null} */
    this.params = null;
    this.isVariadic = false;
    this.name = null;
    this.tag = null;
    this.isIncomplete = false;
    /** @type {Map<string, CType> | null} */
    this.tagScope = null;
  }

  toString() {
    switch (this.kind) {
      case 'ptr':
        return `${this.base.toString()}*`;
      case 'array':
        return `${this.base.toString()}[${this.arrayLen < 0 ? '' : this.arrayLen}]`;
      case 'func': {
        const params = (this.params ?? []).map((p) => p.ty.toString()).join(', ');
        return `${this.returnTy?.toString() ?? '?'}(${params}${this.isVariadic ? ', ...' : ''})`;
      }
      case 'struct':
      case 'union':
        return `${this.kind} ${this.tag ?? '<anonymous>'}`;
      default:
        return this.isUnsigned ? `unsigned ${this.kind}` : this.kind;
    }
  }
}

/** @returns {CType} */
function primitive(kind, size, isUnsigned = false) {
  const ty = new CType(kind);
  ty.size = size;
  ty.align = size;
  ty.isUnsigned = isUnsigned;
  return ty;
}

export const voidType = primitive('void', 1);
export const boolType = primitive('bool', 1);
export const charType = primitive('char', 1);
export const ucharType = primitive('char', 1, true);
export const shortType = primitive('short', 2);
export const ushortType = primitive('short', 2, true);
export const intType = primitive('int', 4);
export const uintType = primitive('int', 4, true);
export const longType = primitive('long', 8);
export const ulongType = primitive('long', 8, true);
export const floatType = primitive('float', 4);
export const doubleType = primitive('double', 8);

/**
 * @param {CType} base
 * @returns {CType}
 */
export function pointerTo(base) {
  const ty = new CType('ptr');
  ty.base = base;
  ty.size = 8;
  ty.align = 8;
  return ty;
}

/**
 * @param {CType} base
 * @param {number} len -1 for an incomplete array
 * @returns {CType}
 */
export function arrayOf(base, len) {
  const ty = new CType('array');
  ty.base = base;
  ty.arrayLen = len;
  if (typeof base.size !== 'number' || isNaN(base.size)) {
    throw new Error(`arrayOf: base type has invalid size: ${base.size} (kind: ${base.kind})`);
  }
  ty.size = len < 0 ? 0 : base.size * len;
  ty.align = base.align;
  ty.isIncomplete = len < 0;
  return ty;
}

/**
 * @param {CType} returnTy
 * @param {{name: string, ty: CType}[]} params
 * @param {boolean} [isVariadic]
 * @returns {CType}
 */
export function funcType(returnTy, params, isVariadic = false) {
  const ty = new CType('func');
  ty.returnTy = returnTy;
  ty.params = params;
  ty.isVariadic = isVariadic;
  ty.size = 1;
  ty.align = 1;
  return ty;
}

/**
 * @param {'struct' | 'union'} kind
 * @param {string | null} tag
 * @returns {CType}
 */
export function aggregateType(kind, tag) {
  const ty = new CType(kind);
  ty.tag = tag;
  ty.members = [];
  ty.size = 0;
  ty.align = 1;
  ty.isIncomplete = true;
  return ty;
}

/** @param {number} n @param {number} align */
export function alignTo(n, align) {
  return Math.ceil(n / align) * align;
}

/**
 * Finish a struct or union layout.
 * @param {CType} ty
 * @param {boolean} isUnion
 */
export function layoutAggregate(ty, isUnion) {
  let align = 1;
  let size = 0;
  // Bit cursor for struct layout; bit-fields share storage units.
  let bitCursor = 0;
  for (const member of ty.members ?? []) {
    align = Math.max(align, member.ty.align);
    if (isUnion) {
      member.offset = 0;
      if (member.bitWidth === undefined) member.bitOffset = 0;
      else member.bitOffset = 0;
      size = Math.max(size, member.ty.size);
      continue;
    }
    if (member.bitWidth !== undefined) {
      const unitBits = Math.max(member.ty.size, 1) * 8;
      if (member.bitWidth === 0) {
        // A zero-width field rounds the cursor up to the next storage unit.
        bitCursor = Math.ceil(bitCursor / unitBits) * unitBits;
        continue;
      }
      const width = member.bitWidth;
      if (width > unitBits) throw new Error('elf: bit-field wider than its type');
      if (Math.floor(bitCursor / unitBits) !== Math.floor((bitCursor + width - 1) / unitBits)) {
        bitCursor = Math.ceil(bitCursor / unitBits) * unitBits;
      }
      const unitStart = Math.floor(bitCursor / unitBits) * unitBits;
      member.offset = unitStart / 8;
      member.bitOffset = bitCursor - unitStart;
      bitCursor += width;
      size = Math.max(size, Math.ceil(bitCursor / 8));
    } else {
      const offset = alignTo(Math.ceil(bitCursor / 8), member.ty.align);
      member.offset = offset;
      member.bitOffset = 0;
      bitCursor = (offset + member.ty.size) * 8;
      size = Math.max(size, offset + member.ty.size);
    }
  }
  ty.align = align;
  ty.size = alignTo(size, align);
  ty.isIncomplete = false;
}

/** @param {CType} ty */
export function isInteger(ty) {
  return ['bool', 'char', 'short', 'int', 'long', 'enum'].includes(ty.kind);
}

/** @param {CType} ty */
export function isPointer(ty) {
  return ty.kind === 'ptr';
}

/** @param {CType} ty */
export function isArray(ty) {
  return ty.kind === 'array';
}

/** @param {CType} ty */
export function isFunc(ty) {
  return ty.kind === 'func';
}

/** @param {CType} ty */
export function isAggregate(ty) {
  return ty.kind === 'struct' || ty.kind === 'union';
}

/** @param {CType} ty */
export function isFloating(ty) {
  return ty.kind === 'float' || ty.kind === 'double';
}

/** @param {CType} ty */
export function isScalar(ty) {
  return isInteger(ty) || isFloating(ty) || isPointer(ty) || ty.kind === 'func';
}

/**
 * Integer promotion: everything narrower than int becomes int.
 * @param {CType} ty
 * @returns {CType}
 */
export function promote(ty) {
  if (!isInteger(ty)) return ty;
  if (ty.size < 4) return intType;
  if (ty.kind === 'long') return ty;
  return ty.kind === 'enum' ? intType : ty;
}

/**
 * Usual arithmetic conversions shared by binary operators.
 * @param {CType} a
 * @param {CType} b
 * @returns {CType}
 */
export function commonType(a, b) {
  if (a.kind === 'ptr') return a;
  if (b.kind === 'ptr') return b;
  if (isFloating(a) || isFloating(b)) {
    if (a.kind === 'double' || b.kind === 'double') return doubleType;
    return floatType;
  }
  a = promote(a);
  b = promote(b);
  if (a.kind === 'long' || b.kind === 'long') {
    return a.isUnsigned || b.isUnsigned ? ulongType : longType;
  }
  return a.isUnsigned || b.isUnsigned ? uintType : intType;
}

/**
 * Structural type equality, used for redeclarations and assignment checks.
 * @param {CType} a
 * @param {CType} b
 * @returns {boolean}
 */
export function sameType(a, b) {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'ptr') return sameType(a.base, b.base);
  if (a.kind === 'array') {
    return sameType(a.base, b.base) && (a.arrayLen < 0 || b.arrayLen < 0 || a.arrayLen === b.arrayLen);
  }
  if (a.kind === 'func') {
    if (!sameType(a.returnTy, b.returnTy)) return false;
    const ap = a.params ?? [];
    const bp = b.params ?? [];
    if (ap.length !== bp.length) return false;
    for (let i = 0; i < ap.length; i += 1) if (!sameType(ap[i].ty, bp[i].ty)) return false;
    return a.isVariadic === b.isVariadic;
  }
  if (a.kind === 'struct' || a.kind === 'union') {
    if (a === b) return true;
    // Named tags are unique; distinct anonymous types declared separately are
    // different even if they look alike, so only fall back to a structural
    // comparison when one side is an anonymous copy (declarators copy types).
    if (a.tag !== null || b.tag !== null) return a.tag === b.tag;
    const am = a.members ?? [];
    const bm = b.members ?? [];
    if (am.length !== bm.length) return false;
    for (let i = 0; i < am.length; i += 1) {
      if (am[i].name !== bm[i].name) return false;
      if (!sameType(am[i].ty, bm[i].ty)) return false;
    }
    return true;
  }
  return a.isUnsigned === b.isUnsigned;
}

/**
 * Convert array and function values to pointers for expression use.
 * @param {CType} ty
 * @returns {CType}
 */
export function decay(ty) {
  if (ty.kind === 'array') return pointerTo(ty.base);
  if (ty.kind === 'func') return pointerTo(ty);
  return ty;
}

/**
 * Choose an integer type from a numeric literal suffix hint.
 * @param {string} hint
 * @returns {CType}
 */
export function typeFromHint(hint) {
  switch (hint) {
    case 'uint':
      return uintType;
    case 'long':
      return longType;
    case 'ulong':
      return ulongType;
    case 'float':
      return floatType;
    case 'double':
    case 'long double':
      return doubleType;
    default:
      return intType;
  }
}
