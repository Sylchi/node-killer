/**
 * Assemble the JavaScript C compiler's GNU `as` output into a Linux ELF64
 * executable image. First step of dropping the external assembler (`as`), the
 * linker (`ld`) and the system C compiler from the JS C compiler toolchain.
 *
 * The codegen emits a flat, position-independent x86_64 image (SysV AMD64 ABI,
 * integer-only for now); this module translates that text into bytes and wraps
 * it into ELF headers so a runnable executable can be produced without any
 * external tools.
 *
 * @module cc/elf
 */

const BASE_ADDR = 0x400000;

// x86 condition codes, shared by Jcc, SETcc and the synthetic cmp helpers.
const CC = {
  o: 0, no: 1, b: 2, c: 2, nae: 2, ae: 3, nb: 3, nc: 3,
  e: 4, z: 4, ne: 5, nz: 5, be: 6, na: 6, a: 7, nbe: 7,
  s: 8, ns: 9, p: 10, pe: 10, np: 11, po: 11,
  l: 12, nge: 12, ge: 13, nl: 13, le: 14, ng: 14, g: 15, nle: 15,
};

/** @param {string} name condition name without the j/set prefix */
function ccOf(name) {
  const cc = CC[name];
  if (cc === undefined) throw new Error(`elf: unknown condition code '${name}'`);
  return cc;
}
const ELF_HDR_SIZE = 64;
const PHDR_SIZE = 56;
const ELF_ALIGN = 0x1000;
const CONTENT_OFF = 0x1000;

const SEC_ORDER = ['text', 'rodata', 'data', 'bss'];

const REG_NAMES = {
  rax: 0, rcx: 1, rdx: 2, rbx: 3, rsp: 4, rbp: 5, rsi: 6, rdi: 7,
  r8: 8, r9: 9, r10: 10, r11: 11, r12: 12, r13: 13, r14: 14, r15: 15,
};

const REG_ALIAS = {
  rax: 0, rcx: 1, rdx: 2, rbx: 3, rsp: 4, rbp: 5, rsi: 6, rdi: 7,
  al: 0, bl: 3, cl: 1, dl: 2, sil: 6, dil: 7, bpl: 5,
  ax: 0, bx: 3, cx: 1, dx: 2, si: 6, di: 7, bp: 5,
  eax: 0, ebx: 3, ecx: 1, edx: 2, esi: 6, edi: 7, ebp: 5, esp: 4,
  r8: 8, r9: 9, r10: 10, r11: 11, r12: 12, r13: 13, r14: 14, r15: 15,
  r8d: 8, r9d: 9, r10d: 10, r11d: 11, r12d: 12, r13d: 13, r14d: 14, r15d: 15,
  r8w: 8, r9w: 9, r10w: 10, r11w: 11, r12w: 12, r13w: 13, r14w: 14, r15w: 15,
  r8b: 8, r9b: 9, r10b: 10, r11b: 11, r12b: 12, r13b: 13, r14b: 14, r15b: 15,
};

function rexByte(idx, w, r, b) {
  let v = 0x40;
  if (w) v |= 0x08;
  if (r) v |= 0x04;
  if (b) v |= 0x01;
  return v;
}

function modrm(mod, reg, rm) {
  return (mod << 6) | ((reg & 7) << 3) | (rm & 7);
}

function isReg(tok) {
  if (typeof tok !== 'string') return null;
  const m = /^%([a-zA-Z][a-zA-Z0-9]*)$/.exec(tok.trim());
  if (!m) return null;
  const idx = REG_ALIAS[m[1].toLowerCase()];
  return idx === undefined ? null : idx;
}

/** @param {string} tok @returns {number|null} */
function isXmm(tok) {
  if (typeof tok !== 'string') return null;
  const m = /^%xmm(\d+)$/.exec(tok.trim());
  return m ? Number(m[1]) : null;
}

const I32_MIN = BigInt(-2147483648);
const I32_MAX = BigInt(2147483647);

function isImm(tok) {
  if (typeof tok !== 'string') return null;
  const m = /^\$?(-?\d+)$/.exec(tok.trim());
  if (!m) return null;
  const v = BigInt(m[1]);
  if (v >= I32_MIN && v < I32_MAX) return { imm32: v };
  return { imm64: v };
}

// mem operand: "N(%reg)" or "label(%rip)"
function isMem(tok) {
  if (typeof tok !== 'string') return null;
  const seg = /^%fs:(\d+)$/.exec(tok.trim());
  if (seg) {
    return { seg: 'fs', base: null, disp: BigInt(seg[1]), reg: 5, rip: false };
  }
  const tp = /^([\w.$]+)@tpoff\((%[a-zA-Z][a-zA-Z0-9]*)\)$/.exec(tok.trim());
  if (tp) {
    const reg = isReg(tp[2]);
    if (reg === null) return null;
    return { base: tp[1], disp: 0n, reg, rip: false, tpoff: true };
  }
  const m = /^([\w.$]*)\((%rip|%[a-zA-Z][a-zA-Z0-9]*|[a-zA-Z][a-zA-Z0-9]*)\)$/.exec(tok.trim());
  if (!m) {
    const m2 = /^(-?\d+)\((%[a-zA-Z][a-zA-Z0-9]*)\)$/.exec(tok.trim());
    if (m2) {
      const reg = isReg(m2[2]);
      if (reg === null) return null;
      return { base: m2[1], disp: BigInt(m2[1]), reg };
    }
    return null;
  }
  const disp = /^\d/.test(m[1]) ? BigInt(m[1]) : 0n;
  const base = /^\d/.test(m[1]) ? null : m[1];
  const isRip = m[2] === '%rip';
  const reg = isRip ? 5 : isReg(m[2]);
  if (reg === null) return null;
  return { base, disp, reg, rip: isRip };
}

function u32Bytes(n) {
  const v = BigInt(n) & 0xffffffffn;
  const out = [];
  for (let i = 0; i < 4; i += 1) out.push(Number((v >> BigInt(8 * i)) & 0xffn));
  return out;
}

function u64Bytes(n) {
  const v = BigInt(n) & 0xffffffffffffffffn;
  const out = [];
  for (let i = 0; i < 8; i += 1) out.push(Number((v >> BigInt(8 * i)) & 0xffn));
  return out;
}

class Section {
  constructor(name) { this.name = name; this.bytes = []; this.labels = new Map(); this.globs = new Set(); }
  get size() { return this.bytes.length; }
}

class Assembler {
  constructor() {
    this.sections = [];
    this.byKey = new Map();
    this.fixups = [];
    /** @type {{name: string, size: number, align: number, local: boolean}[]} */
    this.commons = [];
    this.entryLabel = null;
    this.curSec = null;
    this.curOff = 0;
  }

  getSec(key) {
    let s = this.byKey.get(key);
    if (!s) {
      s = new Section(key);
      this.byKey.set(key, s);
      this.sections.push(s);
    }
    return s;
  }

  /**
   * Append the ModR/M + displacement bytes for a memory operand.
   * RIP-relative operands get a 4-byte placeholder and a fixup.
   * @param {number[]} b byte buffer for the current instruction
   * @param {{base: string|null, disp: bigint, reg: number, rip: boolean}} mem
   * @param {number} regField ModR/M reg field
   */
  appendMem(b, mem, regField) {
    if (mem.seg) {
      // Absolute disp32 addressed through a segment override. The segment
      // prefix itself is prepended by the instruction encoder.
      b.push(modrm(0, regField, 4), 0x25, ...u32Bytes(mem.disp));
      return;
    }
    if (mem.tpoff) {
      // Symbolic thread-pointer offset: `symbol@tpoff(%reg)`. The linker
      // patches the disp32 with R_X86_64_TPOFF32.
      b.push(modrm(2, regField, mem.reg));
      if ((mem.reg & 7) === 4) b.push(0x24); // SIB for %rsp/%r12 bases
      const dispOff = this.curOff + b.length;
      b.push(0, 0, 0, 0);
      this.fixups.push({ kind: 'tpoff', sec: this.curSec, off: dispOff, label: mem.base });
      return;
    }
    if (mem.rip) {
      b.push(modrm(0, regField, 5));
      const dispOff = this.curOff + b.length;
      b.push(0, 0, 0, 0);
      this.fixups.push({ kind: 'rel', sec: this.curSec, off: dispOff, label: mem.base });
      return;
    }
    const base = mem.reg;
    if ((base & 7) === 4) {
      // Base %rsp/%r12 forces a SIB byte with no index register.
      const sib = 0x24;
      if (mem.disp === 0n) {
        b.push(modrm(0, regField, 4), sib);
      } else if (mem.disp >= -128n && mem.disp <= 127n) {
        b.push(modrm(1, regField, 4), sib, Number(mem.disp & 0xffn));
      } else {
        b.push(modrm(2, regField, 4), sib, ...u32Bytes(mem.disp));
      }
      return;
    }
    if (mem.disp === 0n && (base & 7) !== 5) {
      b.push(modrm(0, regField, base));
    } else if (mem.disp >= -128n && mem.disp <= 127n) {
      b.push(modrm(1, regField, base));
      b.push(Number(mem.disp & 0xffn));
    } else {
      b.push(modrm(2, regField, base));
      b.push(...u32Bytes(mem.disp));
    }
  }

  parse(asmText) {
    const lines = asmText.split(/\r?\n/);
    let cur = this.getSec('text');
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const colon = line.indexOf(':');
      if (colon > 0 && /^[\w.$]+$/.test(line.slice(0, colon))) {
        const name = line.slice(0, colon);
        cur.labels.set(name, cur.bytes.length);
        if (cur.globs.has(name)) this.entryLabel = name;
        continue;
      }
      if (line.startsWith('.')) {
        const parts = line.split(/\s+/);
        const head = parts[0];
        const args = parts.slice(1).join(' ');
        if (head === '.text') { cur = this.getSec('text'); }
        else if (head === '.section') { cur = this.getSec(secKey(args)); }
        else if (head === '.file') { /* ignore */ }
        else if (head === '.globl') { cur.globs.add(args.trim()); if (args.trim() === 'main') this.entryLabel = 'main'; }
        else if (head === '.byte') {
          const sec = cur;
          for (const p of args.split(',').map((s) => s.trim()).filter(Boolean)) {
            const hex = /^0x([0-9a-f]+)$/i.exec(p);
            sec.bytes.push((hex ? parseInt(hex[1], 16) : Number(p)) & 0xff);
          }
        }
        else if (head === '.zero') {
          const sec = cur;
          const n = Number(args);
          for (let i = 0; i < n; i += 1) sec.bytes.push(0);
        }
        else if (head === '.comm' || head === '.lcomm') {
          const parts = args.split(',').map((s) => s.trim());
          const name = parts[0];
          const size = Number(parts[1]);
          const align = Number(parts[2] ?? 1) || 1;
          if (!name || !Number.isFinite(size) || size < 0) {
            throw new Error(`elf: bad ${head} '${args}'`);
          }
          const local = head === '.lcomm';
          this.commons.push({ name, size, align, local });
          if (!local) cur.globs.add(name);
        }
        else if (head === '.quad') {
          const sec = cur;
          const spec = args.trim();
          const plus = spec.indexOf('+');
          const label = plus >= 0 ? spec.slice(0, plus).trim() : spec.trim();
          const addend = plus >= 0 ? BigInt(spec.slice(plus + 1)) : 0n;
          this.fixups.push({ sec, off: sec.bytes.length, kind: 'abs', label, addend });
          sec.bytes.push(0, 0, 0, 0, 0, 0, 0, 0);
        }
        else if (head === '.align' || head === '.p2align') {
          const sec = cur;
          const n = Number(args);
          if (!Number.isFinite(n) || n <= 0) throw new Error(`elf: bad ${head} '${args}'`);
          const align = head === '.p2align' ? 2 ** n : n;
          while (sec.bytes.length % align !== 0) sec.bytes.push(0);
        }
        else if (head === '.rodata') { cur = this.getSec('rodata'); }
        else if (head === '.data') { cur = this.getSec('data'); }
        else if (head === '.bss') { cur = this.getSec('bss'); }
        else if (head === '.tls') { cur = this.getSec('tls'); }
        else { throw new Error(`elf: unsupported directive '${head}'`); }
        continue;
      }
      const head = line.split(/\s+/)[0];
      const rest = line.slice(head.length).trim();
      const ops = rest ? rest.split(',').map((s) => s.trim()).filter((s) => s.length > 0) : [];
      this.curSec = cur;
      this.curOff = cur.bytes.length;
      const bytes = this.encode(head, ops);
      for (const b of bytes) cur.bytes.push(b);
    }
  }

  /**
   * Encode the register-register SSE move forms (`movd`/`movq` GPR <-> XMM
   * and `movss`/`movsd` XMM <-> XMM).
   * @param {string} m
   * @param {string[]} ops
   * @returns {number[] | null}
   */
  sseMove(m, ops) {
    const srcG = isReg(ops[0]);
    const dstX = isXmm(ops[1]);
    if (srcG !== null && dstX !== null) {
      const rex = rexByte(0, m === 'movq', dstX >= 8, srcG >= 8);
      return [0x66, rex, 0x0f, 0x6e, modrm(3, dstX, srcG)];
    }
    const srcX = isXmm(ops[0]);
    const dstG = isReg(ops[1]);
    if (srcX !== null && dstG !== null) {
      const rex = rexByte(0, m === 'movq', srcX >= 8, dstG >= 8);
      return [0x66, rex, 0x0f, 0x7e, modrm(3, srcX, dstG)];
    }
    const sX = isXmm(ops[0]);
    const dX = isXmm(ops[1]);
    if (sX !== null && dX !== null) {
      const b = [];
      if (m === 'movss') b.push(0xf3);
      else if (m === 'movsd') b.push(0xf2);
      if (sX >= 8 || dX >= 8) b.push(rexByte(0, false, dX >= 8, sX >= 8));
      b.push(0x0f, 0x10, modrm(3, dX, sX));
      return b;
    }
    return null;
  }

  encode(mnemonic, ops) {
    const m = mnemonic.toLowerCase();
    switch (m) {
      case 'pushq': {
        const r = isReg(ops[0]);
        if (r === null) throw new Error(`elf: bad pushq '${ops[0]}'`);
        if (r >= 8) return [0x41, 0x50 + (r % 8)];
        return [0x50 + (r % 8)];
      }
      case 'popq': {
        const r = isReg(ops[0]);
        if (r === null) throw new Error(`elf: bad popq '${ops[0]}'`);
        if (r >= 8) return [0x41, 0x58 + (r % 8)];
        return [0x58 + (r % 8)];
      }
      case 'ret': return [0xc3];
      case 'leave': return [0xc9];
      case 'cqto': return [0x48, 0x99];
      case 'cdq': return [0x99];
      case 'rep':
        if (ops[0] === 'stosb') return [0xf3, 0xaa];
        if (ops[0] === 'movsb') return [0xf3, 0xa4];
        throw new Error(`elf: unsupported rep op '${ops[0]}'`);
      case 'syscall': return [0x0f, 0x05];
      case 'hlt': return [0xf4];
      case 'movabsq': {
        const dst = isReg(ops[1]);
        const imm = isImm(ops[0]);
        if (dst === null || !imm) throw new Error(`elf: bad movabsq '${ops.join(' ')}'`);
        const b = [rexByte(0, true, false, dst >= 8), 0xb8 + (dst % 8)];
        b.push(...u64Bytes(imm.imm64 ?? imm.imm32));
        return b;
      }
      case 'movd':
      case 'movss':
      case 'movsd': {
        const encoded = this.sseMove(m, ops);
        if (encoded) return encoded;
        throw new Error(`elf: unsupported ${m} '${ops.join(' ')}'`);
      }
      case 'movaps':
      case 'movups': {
        // Zero-length SSE moves (no prefix); load form is 0F 28, store 0F 29.
        const loadMem = isMem(ops[0]);
        const loadX = isXmm(ops[1]);
        if (loadMem && loadX !== null) {
          const b = [];
          if (loadX >= 8) b.push(rexByte(0, false, true, false));
          b.push(0x0f, 0x28);
          this.appendMem(b, loadMem, loadX);
          return b;
        }
        const storeX = isXmm(ops[0]);
        const storeMem = isMem(ops[1]);
        if (storeX !== null && storeMem) {
          const b = [];
          if (storeX >= 8) b.push(rexByte(0, false, true, false));
          b.push(0x0f, 0x29);
          this.appendMem(b, storeMem, storeX);
          return b;
        }
        throw new Error(`elf: bad ${m} '${ops.join(' ')}'`);
      }
      case 'addsd': case 'addss':
      case 'subsd': case 'subss':
      case 'mulsd': case 'mulss':
      case 'divsd': case 'divss': {
        const dX = isXmm(ops[1]);
        const sX = isXmm(ops[0]);
        if (dX === null || sX === null) throw new Error(`elf: bad ${m} '${ops.join(' ')}'`);
        const op = m.startsWith('add') ? 0x58
          : m.startsWith('sub') ? 0x5c
            : m.startsWith('mul') ? 0x59 : 0x5e;
        const b = [m.endsWith('ss') ? 0xf3 : 0xf2];
        if (dX >= 8 || sX >= 8) b.push(rexByte(0, false, dX >= 8, sX >= 8));
        b.push(0x0f, op, modrm(3, dX, sX));
        return b;
      }
      case 'xorpd':
      case 'xorps': {
        const a = isXmm(ops[0]);
        const b = isXmm(ops[1]);
        if (a === null || b === null) throw new Error(`elf: bad ${m} '${ops.join(' ')}'`);
        const out = [];
        if (m === 'xorpd') out.push(0x66);
        if (a >= 8 || b >= 8) out.push(rexByte(0, false, a >= 8, b >= 8));
        out.push(0x0f, 0x57, modrm(3, a, b));
        return out;
      }
      case 'ucomisd':
      case 'ucomiss': {
        const a = isXmm(ops[0]);
        const b = isXmm(ops[1]);
        if (a === null || b === null) throw new Error(`elf: bad ${m} '${ops.join(' ')}'`);
        const out = [];
        if (m === 'ucomisd') out.push(0x66);
        if (a >= 8 || b >= 8) out.push(rexByte(0, false, b >= 8, a >= 8));
        out.push(0x0f, 0x2e, modrm(3, b, a));
        return out;
      }
      case 'cvtsi2sd':
      case 'cvtsi2ss': {
        const g = isReg(ops[0]);
        const x = isXmm(ops[1]);
        if (g === null || x === null) throw new Error(`elf: bad ${m} '${ops.join(' ')}'`);
        return [m.endsWith('ss') ? 0xf3 : 0xf2, rexByte(0, true, x >= 8, g >= 8), 0x0f, 0x2a, modrm(3, x, g)];
      }
      case 'cvttsd2si':
      case 'cvttss2si': {
        const x = isXmm(ops[0]);
        const g = isReg(ops[1]);
        if (x === null || g === null) throw new Error(`elf: bad ${m} '${ops.join(' ')}'`);
        return [m.endsWith('ss') ? 0xf3 : 0xf2, rexByte(0, true, g >= 8, x >= 8), 0x0f, 0x2c, modrm(3, g, x)];
      }
      case 'cvtsd2ss':
      case 'cvtss2sd': {
        const s = isXmm(ops[0]);
        const d = isXmm(ops[1]);
        if (s === null || d === null) throw new Error(`elf: bad ${m} '${ops.join(' ')}'`);
        const out = [m === 'cvtsd2ss' ? 0xf2 : 0xf3];
        if (s >= 8 || d >= 8) out.push(rexByte(0, false, d >= 8, s >= 8));
        out.push(0x0f, 0x5a, modrm(3, d, s));
        return out;
      }
      case 'movq':
      case 'movl':
      case 'movw':
      case 'movb':
      case 'movsbq':
      case 'movswq':
      case 'movslq':
      case 'movzbq':
      case 'movzwq': {
        const kind = mnemonic.toLowerCase();
        if (isXmm(ops[0]) !== null || isXmm(ops[1]) !== null) {
          if (kind === 'movq') {
            const encoded = this.sseMove('movq', ops);
            if (encoded) return encoded;
          }
          throw new Error(`elf: unsupported SSE ${kind} '${ops.join(' ')}'`);
        }
        if (kind === 'movsbq' || kind === 'movswq' || kind === 'movslq' || kind === 'movzbq' || kind === 'movzwq') {
          return this.movExt(kind, ops);
        }
        const is64 = kind === 'movq';
        const is16 = kind === 'movw';
        const is8 = kind === 'movb';

        // Operand-size / REX prefix for a register or memory operand pair.
        const prefix = (regField, rmField) => {
          const b = [];
          if (is16) b.push(0x66);
          const needRex = is64 || regField >= 8 || rmField >= 8 || (is8 && (regField >= 4 || rmField >= 4));
          if (needRex) b.push(rexByte(rmField, is64, regField >= 8, rmField >= 8));
          return b;
        };

        const immSrc = isImm(ops[0]);
        if (ops.length === 2 && immSrc && isReg(ops[1]) !== null) {
          const r = isReg(ops[1]);
          const b = [];
          if (is64 && immSrc.imm64 !== undefined) {
            b.push(rexByte(0, true, false, r >= 8), 0xb8 + (r % 8));
            b.push(...u64Bytes(immSrc.imm64));
            return b;
          }
          const imm32 = immSrc.imm32 ?? immSrc.imm64;
          b.push(...prefix(0, r));
          if (is8) {
            b.push(0xc6, modrm(3, 0, r), Number(imm32 & 0xffn));
          } else if (is16) {
            b.push(0xc7, modrm(3, 0, r));
            b.push(Number(imm32 & 0xffn), Number((imm32 >> 8n) & 0xffn));
          } else {
            b.push(0xc7, modrm(3, 0, r));
            b.push(...u32Bytes(imm32));
          }
          return b;
        }
        if (ops.length === 2 && isImm(ops[1]) && isReg(ops[0]) !== null) {
          return this.encode(kind, [ops[1], ops[0]]);
        }
        if (ops.length === 2 && isReg(ops[0]) !== null && isReg(ops[1]) !== null) {
          const src = isReg(ops[0]);
          const dst = isReg(ops[1]);
          const b = prefix(src, dst);
          b.push(is8 ? 0x88 : 0x89, modrm(3, src, dst));
          return b;
        }
        if (ops.length === 2 && isMem(ops[0]) && isReg(ops[1]) !== null) {
          const mem = isMem(ops[0]);
          const dst = isReg(ops[1]);
          const b = prefix(dst, mem.reg);
          b.push(is8 ? 0x8a : 0x8b);
          this.appendMem(b, mem, dst);
          if (mem.seg) b.unshift(0x64); // %fs segment override
          return b;
        }
        if (ops.length === 2 && isReg(ops[0]) !== null && isMem(ops[1])) {
          const src = isReg(ops[0]);
          const mem = isMem(ops[1]);
          const b = prefix(src, mem.reg);
          b.push(is8 ? 0x88 : 0x89);
          this.appendMem(b, mem, src);
          if (mem.seg) b.unshift(0x64); // %fs segment override
          return b;
        }
        throw new Error(`elf: unsupported mov pattern '${ops.join(' ')}'`);
      }
      case 'lea':
      case 'leaq': {
        const mem = isMem(ops[0]);
        const r = isReg(ops[1]);
        if (!mem || r === null) throw new Error(`elf: bad lea '${ops.join(' ')}'`);
        const b = [rexByte(0, true, r >= 8, mem.reg >= 8), 0x8d];
        this.appendMem(b, mem, r);
        if (mem.seg) b.unshift(0x64); // %fs segment override
        return b;
      }
      case 'bsrq':
      case 'bsfq': {
        const src = isReg(ops[0]);
        const dst = isReg(ops[1]);
        if (src === null || dst === null) throw new Error(`elf: bad ${mnemonic} '${ops.join(' ')}'`);
        return [rexByte(0, true, dst >= 8, src >= 8), 0x0f, mnemonic === 'bsrq' ? 0xbd : 0xbc, modrm(3, dst, src)];
      }
      case 'ud2': return [0x0f, 0x0b];
      case 'bswapl':
      case 'bswapq': {
        const r = isReg(ops[0]);
        if (r === null) throw new Error(`elf: bad ${mnemonic} '${ops.join(' ')}'`);
        return [rexByte(0, mnemonic === 'bswapq', false, r >= 8), 0x0f, 0xc8 + (r % 8)];
      }
      case 'rolw': {
        const imm = isImm(ops[0]);
        const dst = isReg(ops[1]);
        if (!imm || dst === null) throw new Error(`elf: bad rolw '${ops.join(' ')}'`);
        const b = [];
        if (dst >= 8) b.push(rexByte(0, false, false, true));
        b.push(0x66, 0xc1, modrm(3, 0, dst), Number(imm.imm32 ?? imm.imm64) & 0xff);
        return b;
      }
      case 'addq': return this.binop(m, ops);
      case 'subq': return this.binop(m, ops);
      case 'imulq': return this.binop(m, ops);
      case 'divq': return this.binop(m, ops);
      case 'idivq': return this.binop(m, ops);
      case 'modq': return this.binop(m, ops);
      case 'mulq': return this.binop(m, ops);
      case 'andq': return this.binop(m, ops);
      case 'orq': return this.binop(m, ops);
      case 'xorq': return this.binop(m, ops);
      case 'xorl': return this.binop(m, ops);
      case 'cmpq': {
        const imm = isImm(ops[0]);
        const dst = isReg(ops[1]);
        if (imm && dst !== null) {
          return [rexByte(0, true, false, dst >= 8), 0x81, modrm(3, 7, dst), ...u32Bytes(imm.imm32 ?? imm.imm64)];
        }
        const src = isReg(ops[0]);
        if (src === null) {
          if (dst !== null && isMem(ops[0])) {
            const mem = isMem(ops[0]);
            const b = [rexByte(0, true, dst >= 8, mem.reg >= 8), 0x3b];
            this.appendMem(b, mem, dst);
            return b;
          }
          throw new Error(`elf: bad cmpq '${ops.join(' ')}'`);
        }
        if (dst === null) throw new Error(`elf: bad cmpq '${ops.join(' ')}'`);
        return [rexByte(0, true, src >= 8, dst >= 8), 0x39, modrm(3, src, dst)];
      }
      case 'testq': {
        const src = isReg(ops[0]);
        const dst = isReg(ops[1]);
        if (src === null || dst === null) throw new Error(`elf: bad test '${ops.join(' ')}'`);
        return [rexByte(0, true, src >= 8, dst >= 8), 0x85, modrm(3, src, dst)];
      }
      case 'eq': return this.cmpCond(ccOf('e'), ops);
      case 'ne': return this.cmpCond(ccOf('ne'), ops);
      case 'lt': return this.cmpCond(ccOf('l'), ops);
      case 'le': return this.cmpCond(ccOf('le'), ops);
      case 'gt': return this.cmpCond(ccOf('g'), ops);
      case 'ge': return this.cmpCond(ccOf('ge'), ops);
      case 'b': return this.cmpCond(ccOf('b'), ops);
      case 'be': return this.cmpCond(ccOf('be'), ops);
      case 'ae': return this.cmpCond(ccOf('ae'), ops);
      case 'shl':
      case 'shlq':
      case 'shr':
      case 'shrq':
      case 'sar':
      case 'sarq':
        return this.shift(m.replace(/q$/, ''), ops);
      case 'neg':
      case 'negq': {
        const r = isReg(ops[0]);
        if (r === null) throw new Error(`elf: bad neg '${ops[0]}'`);
        return [rexByte(0, true, false, r >= 8), 0xf7, modrm(3, 3, r)];
      }
      case 'not':
      case 'notq': {
        const r = isReg(ops[0]);
        if (r === null) throw new Error(`elf: bad not '${ops[0]}'`);
        return [rexByte(0, true, false, r >= 8), 0xf7, modrm(3, 2, r)];
      }
      case 'xor': {
        const a = isReg(ops[0]);
        const b = isReg(ops[1]);
        if (a === null || b === null) throw new Error(`elf: bad xor '${ops.join(' ')}'`);
        return a >= 8 || b >= 8
          ? [rexByte(0, false, a >= 8, b >= 8), 0x31, modrm(3, a, b)]
          : [0x31, modrm(3, a, b)];
      }
      case 'and': {
        const a = isReg(ops[0]);
        const b = isReg(ops[1]);
        if (a === null || b === null) throw new Error(`elf: bad and '${ops.join(' ')}'`);
        return [rexByte(0, true, a >= 8, b >= 8), 0x21, modrm(3, a, b)];
      }
      case 'andb': {
        const a = isReg(ops[0]);
        const b = isReg(ops[1]);
        if (a === null || b === null) throw new Error(`elf: bad andb '${ops.join(' ')}'`);
        return [0x20, modrm(3, a, b)];
      }
      case 'orb': {
        const a = isReg(ops[0]);
        const b = isReg(ops[1]);
        if (a === null || b === null) throw new Error(`elf: bad orb '${ops.join(' ')}'`);
        return [0x08, modrm(3, a, b)];
      }
      case 'or': {
        const a = isReg(ops[0]);
        const b = isReg(ops[1]);
        if (a === null || b === null) throw new Error(`elf: bad or '${ops.join(' ')}'`);
        return [rexByte(0, true, a >= 8, b >= 8), 0x09, modrm(3, a, b)];
      }
      case 'jmp': return this.jump(m, ops, true);
      case 'je': case 'jz': return this.jump(m, ops, true);
      case 'jne': case 'jnz': return this.jump(m, ops, true);
      case 'ja': return this.jump(m, ops, true);
      case 'jae': case 'jnb': case 'jnc': return this.jump(m, ops, true);
      case 'jb': case 'jc': case 'jnae': return this.jump(m, ops, true);
      case 'jbe': case 'jna': return this.jump(m, ops, true);
      case 'jg': case 'jnle': return this.jump(m, ops, true);
      case 'jge': case 'jnl': return this.jump(m, ops, true);
      case 'jl': case 'jnge': return this.jump(m, ops, true);
      case 'jle': case 'jng': return this.jump(m, ops, true);
      case 'js': return this.jump(m, ops, true);
      case 'jns': return this.jump(m, ops, true);
      case 'jp': case 'jpe': return this.jump(m, ops, true);
      case 'jnp': case 'jpo': return this.jump(m, ops, true);
      case 'call': return this.call(m, ops);
      case 'sete': case 'setz': return this.setcc(m, ops);
      case 'setne': case 'setnz': return this.setcc(m, ops);
      case 'setl': return this.setcc(m, ops);
      case 'setle': return this.setcc(m, ops);
      case 'setg': return this.setcc(m, ops);
      case 'setge': return this.setcc(m, ops);
      case 'setb': case 'setc': return this.setcc(m, ops);
      case 'setbe': return this.setcc(m, ops);
      case 'seta': return this.setcc(m, ops);
      case 'setae': return this.setcc(m, ops);
      case 'sets': return this.setcc(m, ops);
      case 'setns': return this.setcc(m, ops);
      case 'setp': return this.setcc(m, ops);
      case 'setnp': return this.setcc(m, ops);
      default:
        throw new Error(`elf: unsupported instruction '${mnemonic}'`);
    }
  }

  binop(m, ops) {
    const src = isReg(ops[0]);
    const dst = isReg(ops[1]);
    const imm = isImm(ops[0]);
    const rex = (r, b) => rexByte(0, true, r, b);
    if (imm) {
      // op r/m64, imm32  ->  81 /0..7 id; imul -> 69 /0 id
      const r = isReg(ops[1]);
      if (r === null) throw new Error(`elf: bad ${m} '${ops.join(' ')}'`);
      const base = m.replace(/q$/, '');
      const imm32 = imm.imm32 ?? imm.imm64;
      const prefix = rex(false, r >= 8);
      if (base === 'add') return [prefix, 0x81, modrm(3, 0, r), ...u32Bytes(imm32)];
      if (base === 'sub') return [prefix, 0x81, modrm(3, 5, r), ...u32Bytes(imm32)];
      if (base === 'imul') return [prefix, 0x69, modrm(3, r, r), ...u32Bytes(imm32)];
      if (base === 'and') return [prefix, 0x81, modrm(3, 4, r), ...u32Bytes(imm32)];
      if (base === 'or') return [prefix, 0x81, modrm(3, 1, r), ...u32Bytes(imm32)];
      if (base === 'xor') return [prefix, 0x81, modrm(3, 6, r), ...u32Bytes(imm32)];
      throw new Error(`elf: unsupported immediate binop '${m}'`);
    }
    if (src === null || dst === null) {
      // Memory-source forms: `addq (%rsp), %rax` etc.
      if (dst !== null && ops.length === 2 && isMem(ops[0])) {
        const mem = isMem(ops[0]);
        const base = m.replace(/q$/, '');
        const opcodes = { add: 0x03, sub: 0x2b, and: 0x23, or: 0x0b, xor: 0x33, cmp: 0x3b };
        if (opcodes[base]) {
          const b = [rexByte(0, true, dst >= 8, mem.reg >= 8), opcodes[base]];
          this.appendMem(b, mem, dst);
          return b;
        }
        if (base === 'imul') {
          const b = [rexByte(0, true, dst >= 8, mem.reg >= 8), 0x0f, 0xaf];
          this.appendMem(b, mem, dst);
          return b;
        }
      }
      // One-operand forms: divq/idivq/mulq %reg.
      const u = isReg(ops[0]);
      const base = m.replace(/q$/, '');
      if (u !== null && ops.length === 1) {
        if (base === 'div') return [0x48, 0xf7, modrm(3, 6, u)];
        if (base === 'idiv') return [0x48, 0xf7, modrm(3, 7, u)];
        if (base === 'mul') return [0x48, 0xf7, modrm(3, 4, u)];
        if (base === 'neg') return [0x48, 0xf7, modrm(3, 3, u)];
        if (base === 'not') return [0x48, 0xf7, modrm(3, 2, u)];
      }
      throw new Error(`elf: bad ${m} '${ops.join(' ')}'`);
    }
    switch (m) {
      case 'addq': case 'add':
        return [rex(src >= 8, dst >= 8), 0x01, modrm(3, src, dst)];
      case 'subq': case 'sub':
        return [rex(src >= 8, dst >= 8), 0x29, modrm(3, src, dst)];
      case 'imulq': case 'imul':
        return [rex(dst >= 8, src >= 8), 0x0f, 0xaf, modrm(3, dst, src)];
      case 'mulq': case 'mul':
        return [rex(false, src >= 8), 0xf7, modrm(3, 4, src)];
      case 'divq': case 'div':
        return [rex(false, src >= 8), 0xf7, modrm(3, 6, src)];
      case 'idivq': case 'idiv':
        return [rex(false, src >= 8), 0xf7, modrm(3, 7, src)];
      case 'modq': case 'mod': {
        const a = isReg(ops[1]);
        return [rex(a >= 8, dst >= 8), 0x89, modrm(3, a, dst)];
      }
      case 'andq': case 'and':
        return [rex(src >= 8, dst >= 8), 0x21, modrm(3, src, dst)];
      case 'orq': case 'or':
        return [rex(src >= 8, dst >= 8), 0x09, modrm(3, src, dst)];
      case 'xorq': case 'xor':
        return [rex(src >= 8, dst >= 8), 0x31, modrm(3, src, dst)];
      case 'xorl':
        return (src >= 8 || dst >= 8)
          ? [rexByte(0, false, src >= 8, dst >= 8), 0x31, modrm(3, src, dst)]
          : [0x31, modrm(3, src, dst)];
    }
    throw new Error(`elf: unsupported binop '${m}'`);
  }

  cmp(m, ops) {
    const src = isReg(ops[0]);
    const dst = isReg(ops[1]);
    if (src === null || dst === null) throw new Error(`elf: bad ${m} '${ops.join(' ')}'`);
    const cc = ccOf(m.replace(/q$/, ''));
    return [rexByte(0, true, src >= 8, dst >= 8), 0x39, modrm(3, src, dst), 0x0f, 0x90 + cc, modrm(3, 0, 0)];
  }

  cmpCond(cc, ops) {
    const src = isReg(ops[0]);
    const dst = isReg(ops[1]);
    if (src === null || dst === null) throw new Error(`elf: bad cmp '${ops.join(' ')}'`);
    return [rexByte(0, true, src >= 8, dst >= 8), 0x39, modrm(3, src, dst), 0x0f, 0x90 + cc, modrm(3, 0, 0)];
  }

  setcc(m, ops) {
    const r = isReg(ops[0]);
    if (r === null) throw new Error(`elf: bad ${m} '${ops.join(' ')}'`);
    const cc = ccOf(m.slice(3));
    return [0x0f, 0x90 + cc, modrm(3, 0, r)];
  }

  shift(m, ops) {
    const dst = isReg(ops[1]);
    if (dst === null) throw new Error(`elf: bad shift '${ops.join(' ')}'`);
    // shl/sal = /4, shr = /5, sar = /7
    const digit = m === 'shl' || m === 'sal' ? 4 : m === 'shr' ? 5 : 7;
    const rex = rexByte(0, true, false, dst >= 8);
    const src = String(ops[0]);
    if (src.startsWith('$')) {
      const count = Number(src.slice(1)) & 0xff;
      if (count === 1) return [rex, 0xd1, modrm(3, digit, dst)];
      return [rex, 0xc1, modrm(3, digit, dst), count];
    }
    if (src !== '%cl') throw new Error(`elf: shift count must be $imm or %cl in '${ops.join(' ')}'`);
    return [rex, 0xd3, modrm(3, digit, dst)];
  }

  movExt(kind, ops) {
    const op2 = kind === 'movzbq' ? 0xb6
      : kind === 'movzwq' ? 0xb7
        : kind === 'movsbq' ? 0xbe
          : kind === 'movswq' ? 0xbf
            : 0x63; // movslq -> movsxd
    const twoByte = kind === 'movslq' ? [] : [0x0f];
    const mem = isMem(ops[0]);
    const r = isReg(ops[1]);
    if (mem && r !== null) {
      const b = [rexByte(0, true, r >= 8, mem.reg >= 8), ...twoByte, op2];
      this.appendMem(b, mem, r);
      return b;
    }
    const src = isReg(ops[0]);
    const dst = isReg(ops[1]);
    if (src === null || dst === null) throw new Error(`elf: bad ${kind} '${ops.join(' ')}'`);
    return [rexByte(0, true, src >= 8, dst >= 8), ...twoByte, op2, modrm(3, src, dst)];
  }

  jump(m, ops, wide) {
    const label = ops[0];
    const b = m === 'jmp' ? [0xe9, 0, 0, 0, 0] : [0x0f, 0x80 + this.ccNum(m), 0, 0, 0, 0];
    const relAt = m === 'jmp' ? this.curOff + 1 : this.curOff + 2;
    this.fixups.push({ kind: 'rel', sec: this.curSec, off: relAt, label });
    return b;
  }

  call(m, ops) {
    const target = String(ops[0]).replace(/^\*/, '');
    if (ops[0].startsWith('*')) {
      const reg = isReg(String(ops[0]).slice(1));
      if (reg === null) throw new Error(`elf: bad indirect call '${ops[0]}'`);
      return [rexByte(0, false, false, reg >= 8), 0xff, modrm(3, 2, reg)];
    }
    const b = [0xe8, 0, 0, 0, 0];
    this.fixups.push({ kind: 'rel', sec: this.curSec, off: this.curOff + 1, label: target });
    return b;
  }

  ccNum(m) {
    return ccOf(m.replace(/^j/, ''));
  }
}

function secKey(name) {
  const n = name.trim().toLowerCase();
  if (n === '.text') return 'text';
  if (n === '.rodata') return 'rodata';
  if (n === '.data') return 'data';
  if (n === '.bss') return 'bss';
  return n;
}

export function assembleAsm(asmText) {
  const asm = new Assembler();

  // A C program has no C runtime here, so provide the process entry point:
  // call main(), then exit with its return value via the exit_group syscall.
  const hasMain = /^\s*main\s*:/m.test(asmText);
  const hasStart = /^\s*_start\s*:/m.test(asmText);
  const prelude = hasMain && !hasStart
    ? [
      '\t.text',
      '\t.globl\t_start',
      '_start:',
      '\tcall\tmain',
      '\tmovq\t%rax, %rdi',
      '\tmovl\t$60, %eax',
      '\tsyscall',
      '',
    ].join('\n')
    : '';
  asm.parse(prelude + asmText);

  // Common symbols (C tentative definitions) become zero-filled .bss slots in
  // the single-file executable path.
  for (const c of asm.commons) {
    const bss = asm.getSec('bss');
    while (bss.bytes.length % c.align !== 0) bss.bytes.push(0);
    bss.labels.set(c.name, bss.bytes.length);
    for (let i = 0; i < c.size; i += 1) bss.bytes.push(0);
  }

  // Place sections in a deterministic order, aligning each one.
  const ordered = asm.sections.slice().sort((a, b) => {
    const ia = SEC_ORDER.indexOf(a.name);
    const ib = SEC_ORDER.indexOf(b.name);
    return (ia < 0 ? SEC_ORDER.length : ia) - (ib < 0 ? SEC_ORDER.length : ib);
  });
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1];
    while (prev.bytes.length % 16 !== 0) prev.bytes.push(0);
  }

  const placed = [];
  let off = 0;
  for (const s of ordered) {
    placed.push({ sec: s, addr: BASE_ADDR + CONTENT_OFF + off, fileOff: CONTENT_OFF + off });
    off += s.size;
  }
  const addrOf = (s) => placed.find((p) => p.sec === s).addr;

  // Resolve fixups (little-endian).
  for (const f of asm.fixups) {
    const targetSec = ordered.find((s) => s.labels.has(f.label));
    if (!targetSec) throw new Error(`elf: unresolved symbol '${f.label}'`);
    const targetAddr = BigInt(addrOf(targetSec) + targetSec.labels.get(f.label));
    if (f.kind === 'rel') {
      const refAddr = BigInt(addrOf(f.sec) + f.off + 4);
      const rel = targetAddr - refAddr;
      const b = u32Bytes(rel);
      for (let i = 0; i < 4; i += 1) f.sec.bytes[f.off + i] = b[i];
    } else {
      const b = u64Bytes(targetAddr + BigInt(f.addend));
      for (let i = 0; i < 8; i += 1) f.sec.bytes[f.off + i] = b[i];
    }
  }

  // Build the final image: ELF header + program header + section content.
  let contentLen = 0;
  for (const p of placed) contentLen += p.sec.size;
  const total = CONTENT_OFF + contentLen;
  const img = new Uint8Array(total);
  const buf = new DataView(img.buffer, img.byteOffset, img.byteLength);
  buf.setUint8(0, 0x7f); buf.setUint8(1, 0x45); buf.setUint8(2, 0x4c); buf.setUint8(3, 0x46);
  buf.setUint8(4, 2); buf.setUint8(5, 1); buf.setUint8(6, 1); buf.setUint8(7, 0);
  buf.setUint16(16, 2, true);   // e_type = ET_EXEC
  buf.setUint16(18, 62, true);  // e_machine = EM_X86_64
  buf.setUint32(20, 1, true);   // e_version
  let entryAddr = BASE_ADDR + CONTENT_OFF;
  const entryName = ordered.some((s) => s.labels.has('_start')) ? '_start' : asm.entryLabel;
  if (entryName) {
    const entrySec = ordered.find((s) => s.labels.has(entryName));
    if (entrySec) entryAddr = addrOf(entrySec) + (entrySec.labels.get(entryName) ?? 0);
  }
  buf.setBigUint64(24, BigInt(entryAddr), true); // e_entry
  buf.setUint32(32, 64, true); // e_phoff (phdr directly follows ELF header)
  buf.setUint32(40, 0, true); // e_shoff
  buf.setUint32(48, 0, true); // e_flags
  buf.setUint16(52, 64, true); // e_ehsize
  buf.setUint16(54, 56, true); // e_phentsize
  buf.setUint16(56, 1, true); // e_phnum
  buf.setUint16(58, 64, true); // e_shentsize
  buf.setUint16(60, 0, true); // e_shnum
  buf.setUint16(62, 0, true); // e_shstrndx
  buf.setUint32(64, 1, true); // p_type = PT_LOAD
  buf.setUint32(68, 7, true); // p_flags = R+W+X (single segment)
  buf.setUint32(72, CONTENT_OFF, true); // p_offset
  buf.setBigUint64(80, BigInt(BASE_ADDR + CONTENT_OFF), true); // p_vaddr
  buf.setBigUint64(88, BigInt(BASE_ADDR + CONTENT_OFF), true); // p_paddr
  buf.setBigUint64(96, BigInt(contentLen), true); // p_filesz
  buf.setBigUint64(104, BigInt(contentLen), true); // p_memsz
  buf.setBigUint64(112, BigInt(ELF_ALIGN), true); // p_align
  let off2 = CONTENT_OFF;
  for (const p of placed) {
    const arr = p.sec.bytes;
    for (let i = 0; i < arr.length; i += 1) img[off2 + i] = arr[i] & 0xff;
    off2 += arr.length;
  }
  return { bytes: img, entry: BigInt(entryAddr) };
}

export { Assembler, secKey };
export default assembleAsm;
