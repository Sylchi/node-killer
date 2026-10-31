/**
 * x86_64 code generator for the JavaScript C compiler.
 *
 * The generator targets GNU `as` syntax and follows the System V AMD64 ABI.
 * Integer arguments go in rdi/rsi/rdx/rcx/r8/r9, return values in rax. The
 * stack is kept 16-byte aligned at every call site.
 *
 * @module cc/codegen
 */
import * as T from './type.js';
import { CcError } from './tokenize.js';

const REG_ARGS = ['%rdi', '%rsi', '%rdx', '%rcx', '%r8', '%r9'];

/**
 * @param {import('./parse.js').Obj[]} globals
 * @param {import('./parse.js').Obj[]} functions
 * @returns {string}
 */
export function codegen(globals, functions) {
  const gen = new Codegen(globals, functions);
  return gen.emit();
}

class Codegen {
  /**
   * @param {import('./parse.js').Obj[]} globals
   * @param {import('./parse.js').Obj[]} functions
   */
  constructor(globals, functions) {
    this.globals = globals;
    this.functions = functions;
    /** @type {string[]} */
    this.out = [];
    this.depth = 0;
    /** @type {string[]} */
    this.breakStack = [];
    /** @type {string[]} */
    this.continueStack = [];
    this.returnLabel = '';
    this.unique = 0;
    this.functionId = 0;
    this.currentFunctionId = 0;
  }

  /**
   * Assembly label for a C label. C labels are function scoped, so the
   * function id keeps equally named labels in different functions distinct.
   * @param {string} name
   * @returns {string}
   */
  cLabel(name) {
    return `.L.label.${this.currentFunctionId}.${name}`;
  }

  /** @param {string} line */
  println(line) {
    this.out.push(line);
  }

  uniqueLabel(prefix) {
    this.unique += 1;
    return `.L.${prefix}.${this.unique}`;
  }

  emit() {
    this.println('\t.file\t"compiled.c"');
    this.println('\t.text');
    for (const fn of this.functions) this.emitFunction(fn);
    for (const obj of this.globals) {
      if (obj.isString) this.emitString(obj);
      else this.emitGlobal(obj);
    }
    return this.out.join('\n') + '\n';
  }

  // ---------------------------------------------------------- functions

  /** @param {import('./parse.js').Obj} fn */
  emitFunction(fn) {
    if (!fn.body) return;
    if (!fn.isStatic) this.println(`\t.globl\t${fn.label}`);
    this.println(`\t.align\t16`);
    this.println(`${fn.label}:`);
    this.println('\tpushq\t%rbp');
    this.println('\tmovq\t%rsp, %rbp');
    const frameSize = T.alignTo(fn.stackSize, 16);
    this.println(`\tsubq\t$${frameSize}, %rsp`);

    this.depth = 0;
    this.functionId += 1;
    this.currentFunctionId = this.functionId;
    this.returnLabel = this.uniqueLabel('return');
    this.currentFn = fn;

    // Preserve the incoming argument registers so that va_start can build a
    // SysV va_list from them.
    if (fn.vaArea) {
      const base = fn.vaArea.offset;
      for (let i = 0; i < 6; i += 1) {
        this.println(`\tmovq\t${REG_ARGS[i]}, ${base + i * 8}(%rbp)`);
      }
      for (let i = 0; i < 8; i += 1) {
        this.println(`\tmovups\t%xmm${i}, ${base + 48 + i * 16}(%rbp)`);
      }
    }

    // Spill incoming arguments into their stack slots.
    const types = fn.params.map((p) => p.ty);
    const abiTypes = fn.sretSlot ? [T.pointerTo(T.voidType), ...types] : types;
    const info = this.classifyArgs(abiTypes);
    // A large aggregate return consumes the first integer register for the
    // hidden destination pointer.
    const shift = fn.sretSlot ? 1 : 0;
    if (fn.sretSlot) this.storeEightByte(REG_ARGS[0], fn.sretSlot.offset, 8);
    for (let i = 0; i < fn.params.length; i += 1) {
      const param = fn.params[i];
      const ai = i + shift;
      const cls = info.classes[ai];
      if (!cls) {
        // Memory argument: copy from the caller's stack area.
        const src = 16 + info.stackSlots[ai] * 8;
        this.println(`\tleaq\t${src}(%rbp), %rsi`);
        this.println(`\tleaq\t${param.offset}(%rbp), %rdi`);
        this.println(`\tmovl\t$${param.ty.size}, %ecx`);
        this.println('\trep movsb');
        continue;
      }
      let ii = 0;
      let si = 0;
      let remaining = param.ty.size;
      for (let k = 0; k < cls.length; k += 1) {
        const chunk = Math.min(remaining, 8);
        if (cls[k] === 'INTEGER') {
          const reg = REG_ARGS[info.intRegs[ai][ii++]];
          this.storeEightByte(reg, param.offset + k * 8, chunk);
        } else if (param.ty.kind === 'float') {
          this.println(`\tmovd\t%xmm${info.sseRegs[ai][si++]}, %eax`);
          this.println(`\tmovl\t%eax, ${param.offset}(%rbp)`);
        } else if (param.ty.kind === 'double') {
          this.println(`\tmovq\t%xmm${info.sseRegs[ai][si++]}, %rax`);
          this.println(`\tmovq\t%rax, ${param.offset}(%rbp)`);
        } else {
          this.println(`\tmovq\t%xmm${info.sseRegs[ai][si++]}, %rax`);
          this.storeEightByte('%rax', param.offset + k * 8, chunk);
        }
        remaining -= chunk;
      }
    }

    this.genStmt(fn.body);
    // An implicit return for functions that fall through.
    this.println(`${this.returnLabel}:`);
    if (fn.sretSlot) {
      this.println(`\tmovq\t${fn.sretSlot.offset}(%rbp), %rax`);
    }
    this.println('\tleave');
    this.println('\tret');
  }

  /**
   * Classify a type into SysV AMD64 eightbyte classes, or null when the value
   * must be passed in memory (>16 bytes).
   * @param {T.CType} ty
   * @returns {('INTEGER'|'SSE')[] | null}
   */
  classifyType(ty) {
    if (T.isFloating(ty)) return ['SSE'];
    if (!T.isAggregate(ty)) return ['INTEGER'];
    if (ty.size > 16 || ty.size <= 0) return null;
    const count = Math.ceil(ty.size / 8);
    const classes = new Array(count).fill(null);
    this.markType(ty, 0, classes);
    for (let i = 0; i < count; i += 1) if (!classes[i]) classes[i] = 'SSE';
    return classes;
  }

  /**
   * @param {T.CType} ty
   * @param {number} offset
   * @param {('INTEGER'|'SSE'|null)[]} classes
   */
  markType(ty, offset, classes) {
    if (ty.kind === 'struct' || ty.kind === 'union') {
      for (const member of ty.members ?? []) this.markType(member.ty, offset + member.offset, classes);
      return;
    }
    if (ty.kind === 'array') {
      const count = ty.arrayLen < 0 ? 0 : ty.arrayLen;
      for (let i = 0; i < count; i += 1) this.markType(ty.base, offset + i * ty.base.size, classes);
      return;
    }
    const first = Math.floor(offset / 8);
    const last = Math.floor((offset + Math.max(ty.size, 1) - 1) / 8);
    for (let k = first; k <= last && k < classes.length; k += 1) {
      if (classes[k] === 'INTEGER') continue;
      if (T.isFloating(ty)) {
        if (!classes[k]) classes[k] = 'SSE';
      } else {
        classes[k] = 'INTEGER';
      }
    }
  }

  /**
   * Assign registers (or stack slots) to a parameter/argument list.
   * @param {T.CType[]} types
   * @returns {{classes: (string[]|null)[], intRegs: number[][], sseRegs: number[][], stackSlots: number[]}}
   */
  classifyArgs(types) {
    const classes = [];
    const intRegs = [];
    const sseRegs = [];
    const stackSlots = [];
    let intUsed = 0;
    let sseUsed = 0;
    let stackUsed = 0;
    for (const ty of types) {
      const cls = this.classifyType(ty);
      const needInt = cls ? cls.filter((c) => c === 'INTEGER').length : Infinity;
      const needSse = cls ? cls.length - needInt : Infinity;
      if (cls && intUsed + needInt <= 6 && sseUsed + needSse <= 8) {
        const ir = [];
        const sr = [];
        for (const c of cls) {
          if (c === 'INTEGER') ir.push(intUsed++);
          else sr.push(sseUsed++);
        }
        classes.push(cls);
        intRegs.push(ir);
        sseRegs.push(sr);
        stackSlots.push(-1);
      } else {
        classes.push(null);
        intRegs.push([]);
        sseRegs.push([]);
        stackSlots.push(stackUsed);
        stackUsed += Math.ceil(Math.max(ty.size, 1) / 8);
      }
    }
    return { classes, intRegs, sseRegs, stackSlots };
  }

  /**
   * Store a value eightbyte from `reg` to `base + offset`, writing only
   * `remaining` bytes.
   * @param {string} reg
   * @param {number} offset
   * @param {number} remaining
   */
  storeEightByte(reg, offset, remaining) {
    if (remaining >= 8) this.println(`\tmovq\t${reg}, ${offset}(%rbp)`);
    else if (remaining >= 4) this.println(`\tmovl\t${this.reg32(reg)}, ${offset}(%rbp)`);
    else if (remaining >= 2) this.println(`\tmovw\t${this.reg16(reg)}, ${offset}(%rbp)`);
    else this.println(`\tmovb\t${this.reg8(reg)}, ${offset}(%rbp)`);
  }

  /** @param {string} reg @returns {string} */
  reg32(reg) {
    return { '%rdi': '%edi', '%rsi': '%esi', '%rdx': '%edx', '%rcx': '%ecx', '%r8': '%r8d', '%r9': '%r9d', '%rax': '%eax', '%r10': '%r10d', '%r11': '%r11d' }[reg] ?? reg;
  }

  /** @param {string} reg @returns {string} */
  reg16(reg) {
    return { '%rdi': '%di', '%rsi': '%si', '%rdx': '%dx', '%rcx': '%cx', '%r8': '%r8w', '%r9': '%r9w', '%rax': '%ax', '%r10': '%r10w', '%r11': '%r11w' }[reg] ?? reg;
  }

  /** @param {string} reg @returns {string} */
  reg8(reg) {
    return { '%rdi': '%dil', '%rsi': '%sil', '%rdx': '%dl', '%rcx': '%cl', '%r8': '%r8b', '%r9': '%r9b', '%rax': '%al', '%r10': '%r10b', '%r11': '%r11b' }[reg] ?? reg;
  }

  // ------------------------------------------------------------- globals

  /** @param {import('./parse.js').Obj} obj */
  emitGlobal(obj) {
    if (obj.isExtern && !obj.isDefinition) return;
    const allZero =
      obj.initData && !obj.relocs.length && this.isZero(obj.initData);
    // Thread-local tentative definitions cannot use .comm: common symbols are
    // not TLS, and each thread needs its own copy.
    if (obj.isTentative && allZero && !obj.isStatic && !obj.isStaticLocal && !obj.isThreadLocal) {
      const align = obj.align || obj.ty.align || 1;
      this.println(`\t.comm\t${obj.label},${obj.ty.size},${align}`);
      return;
    }
    const section = obj.isThreadLocal ? '.tls' : allZero ? '.bss' : '.data';
    this.println(`\t${section}`);
    if (!obj.isStatic && !obj.isStaticLocal) this.println(`\t.globl\t${obj.label}`);
    this.println(`\t.align\t${obj.align || obj.ty.align}`);
    this.println(`${obj.label}:`);
    if (allZero) {
      this.println(`\t.zero\t${obj.ty.size}`);
      return;
    }
    this.emitDataBytes(obj);
  }

  /**
   * @param {import('./parse.js').Obj} obj
   * @returns {boolean}
   */
  isZero(buf) {
    for (let i = 0; i < buf.length; i += 1) if (buf[i] !== 0) return false;
    return true;
  }

  /** @param {import('./parse.js').Obj} obj */
  emitDataBytes(obj) {
    const buf = obj.initData;
    const relocs = obj.relocs.slice().sort((a, b) => a.offset - b.offset);
    let pos = 0;
    for (const rel of relocs) {
      if (rel.offset < pos) continue;
      const head = buf.subarray(pos, rel.offset);
      if (head.length) this.emitByteRun(head);
      this.println(`\t.quad\t${rel.symbol}${rel.addend === 0n ? '' : `+${rel.addend}`}`);
      pos = rel.offset + 8;
    }
    if (pos < buf.length) this.emitByteRun(buf.subarray(pos));
  }

  /** @param {Uint8Array} bytes */
  emitByteRun(bytes) {
    /** @type {string[]} */
    const parts = [];
    let i = 0;
    while (i < bytes.length) {
      // Collect a run of zeros as .zero.
      if (bytes[i] === 0) {
        let j = i;
        while (j < bytes.length && bytes[j] === 0) j += 1;
        parts.push(`\t.zero\t${j - i}`);
        i = j;
        continue;
      }
      const line = [];
      let j = i;
      while (j < bytes.length && bytes[j] !== 0 && line.length < 16) {
        line.push(`0x${bytes[j].toString(16).padStart(2, '0')}`);
        j += 1;
      }
      parts.push(`\t.byte\t${line.join(', ')}`);
      i = j;
    }
    for (const part of parts) this.println(part);
  }

  /** @param {import('./parse.js').Obj} obj */
  emitString(obj) {
    this.println('\t.section\t.rodata');
    this.println(`\t.align\t1`);
    this.println(`${obj.label}:`);
    const bytes = obj.initData;
    if (!bytes) return;
    /** @type {string[]} */
    const line = [];
    for (const byte of bytes) line.push(`0x${byte.toString(16).padStart(2, '0')}`);
    this.println(`\t.byte\t${line.join(', ')}`);
  }

  // ------------------------------------------------------------ statements

  /** @param {import('./parse.js').Node} node */
  genStmt(node) {
    if (!node) return;
    switch (node.kind) {
      case 'block':
        for (const s of node.body) this.genStmt(s);
        return;
      case 'exprStmt':
        if (node.expr) this.genExpr(node.expr);
        return;
      case 'null':
        return;
      case 'return': {
        if (node.expr) {
          this.genExpr(node.expr);
          if (this.currentFn && T.isAggregate(this.currentFn.ty.returnTy)) {
            this.emitAggregateReturn(this.currentFn.ty.returnTy);
          }
        } else {
          this.println('\tmovl\t$0, %eax');
        }
        this.println(`\tjmp\t${this.returnLabel}`);
        return;
      }
      case 'if': {
        const label = this.uniqueLabel('if');
        const end = this.uniqueLabel('endif');
        this.genExpr(node.cond);
        this.println('\ttestq\t%rax, %rax');
        this.println(`\tje\t${node.els ? label : end}`);
        this.genStmt(node.then);
        if (node.els) {
          this.println(`\tjmp\t${end}`);
          this.println(`${label}:`);
          this.genStmt(node.els);
        }
        this.println(`${end}:`);
        return;
      }
      case 'for': {
        const begin = this.uniqueLabel('for.begin');
        const end = this.uniqueLabel('for.end');
        const inc = this.uniqueLabel('for.inc');
        if (node.init) this.genStmt(node.init);
        this.println(`${begin}:`);
        if (node.cond) {
          this.genExpr(node.cond);
          this.println('\ttestq\t%rax, %rax');
          this.println(`\tje\t${end}`);
        }
        this.breakStack.push(end);
        this.continueStack.push(inc);
        this.genStmt(node.then);
        this.breakStack.pop();
        this.continueStack.pop();
        this.println(`${inc}:`);
        if (node.inc) this.genExpr(node.inc);
        this.println(`\tjmp\t${begin}`);
        this.println(`${end}:`);
        return;
      }
      case 'do': {
        const begin = this.uniqueLabel('do.begin');
        const end = this.uniqueLabel('do.end');
        const cond = this.uniqueLabel('do.cond');
        this.println(`${begin}:`);
        this.breakStack.push(end);
        this.continueStack.push(cond);
        this.genStmt(node.then);
        this.breakStack.pop();
        this.continueStack.pop();
        this.println(`${cond}:`);
        this.genExpr(node.cond);
        this.println('\ttestq\t%rax, %rax');
        this.println(`\tjne\t${begin}`);
        this.println(`${end}:`);
        return;
      }
      case 'switch': {
        const end = this.uniqueLabel('switch.end');
        this.genExpr(node.cond);
        for (const entry of node.cases) {
          const label = entry.label;
          const imm = this.signed32(entry.value);
          if (imm === null) {
            this.println(`\tmovabsq\t$${entry.value}, %rdi`);
            this.println('\tcmpq\t%rdi, %rax');
          } else {
            this.println(`\tcmpq\t$${imm}, %rax`);
          }
          this.println(`\tje\t${label}`);
        }
        if (node.defaultLabel) this.println(`\tjmp\t${node.defaultLabel}`);
        else this.println(`\tjmp\t${end}`);
        this.breakStack.push(end);
        this.genStmt(node.then);
        this.breakStack.pop();
        this.println(`${end}:`);
        return;
      }
      case 'case':
        this.println(`${node.label}:`);
        this.genStmt(node.stmt);
        return;
      case 'label':
        this.println(node.label.startsWith('.L.') ? `${node.label}:` : `${this.cLabel(node.label)}:`);
        this.genStmt(node.stmt);
        return;
      case 'goto':
        this.println(`\tjmp\t${this.cLabel(node.label)}`);
        return;
      case 'break': {
        const target = this.breakStack[this.breakStack.length - 1];
        if (!target) throw new CcError('break outside loop/switch');
        this.println(`\tjmp\t${target}`);
        return;
      }
      case 'continue': {
        const target = this.continueStack[this.continueStack.length - 1];
        if (!target) throw new CcError('continue outside loop');
        this.println(`\tjmp\t${target}`);
        return;
      }
      case 'memzero': {
        this.println(`\tleaq\t${node.var.offset}(%rbp), %rdi`);
        this.println(`\tmovl\t$${node.var.ty.size}, %ecx`);
        this.println('\txorl\t%eax, %eax');
        this.println('\trep stosb');
        return;
      }
      default:
        this.genExpr(node);
    }
  }

  // ----------------------------------------------------------- expressions

  /** @param {import('./parse.js').Node} node */
  genExpr(node) {
    switch (node.kind) {
      case 'null':
        return;
      case 'num':
        if (node.ty && T.isFloating(node.ty)) this.emitFloatImm(node.val, node.ty);
        else this.emitImm(node.val);
        return;
      case 'var':
        this.genAddr(node);
        if (node.var.isFunction) {
          // Function designator: %rax already holds the function address.
        } else if (!T.isAggregate(node.ty) && !T.isArray(node.ty)) {
          // Arrays decay to their address, so leave %rax as the address.
          this.loadFromAddr(node.ty);
        }
        return;
      case 'addr':
        this.genAddr(node.expr);
        return;
      case 'deref':
        this.genExpr(node.expr);
        this.loadVar(node);
        return;
      case 'member':
        this.genAddr(node);
        this.loadVar(node);
        return;
      case 'compound':
        this.genAddr(node);
        if (!T.isAggregate(node.ty)) this.loadFromAddr(node.ty);
        return;
      case 'cast':
        this.genExpr(node.expr);
        this.genCast(node.expr.ty, node.castTy);
        return;
      case 'assign': {
        this.genAddr(node.lhs);
        this.push();
        this.genExpr(node.rhs);
        this.pop('%rdi');
        this.storeLValue(node.lhs);
        return;
      }
      case 'assignOp': {
        // emitBinaryOp expects the left operand in %rax and the right operand
        // in %rdi. Evaluate the right-hand side first, then reload the lvalue
        // from the saved address so the operands are not swapped (which would
        // turn `x -= y` into `y - x`).
        this.genAddr(node.lhs);
        this.push(); // address of the lvalue
        this.genExpr(node.rhs);
        this.push(); // right-hand side
        this.println('\tmovq\t8(%rsp), %rax');
        this.loadVar(node.lhs);
        this.pop('%rdi'); // %rdi = right-hand side
        if (node.ptrScale && node.ptrScale > 1) {
          this.println(`\timulq\t$${node.ptrScale}, %rdi`);
        }
        if (node.opTy && T.isFloating(node.opTy)) {
          this.emitFloatBinary(node.op, node.opTy);
        } else {
          this.emitBinaryOp(node.op, node.opTy);
          // The value of a compound assignment is converted to the type of
          // the left operand, so wrap/truncate before it is used further.
          this.loadValue(node.lhs.ty);
        }
        this.pop('%rdi'); // address of the lvalue
        this.storeLValue(node.lhs);
        return;
      }
      case 'comma': {
        this.genExpr(node.lhs);
        this.genExpr(node.rhs);
        return;
      }
      case 'cond': {
        const label = this.uniqueLabel('cond');
        const end = this.uniqueLabel('cond.end');
        this.genExpr(node.cond);
        this.println('\ttestq\t%rax, %rax');
        this.println(`\tje\t${label}`);
        this.genExpr(node.then);
        this.println(`\tjmp\t${end}`);
        this.println(`${label}:`);
        this.genExpr(node.els);
        this.println(`${end}:`);
        return;
      }
      case 'logand':
      case 'logor': {
        const end = this.uniqueLabel(node.kind);
        this.genExpr(node.lhs);
        if (T.isFloating(node.lhs.ty)) this.emitFloatBoolize(node.lhs.ty);
        else this.emitBoolize();
        this.println('\ttestq\t%rax, %rax');
        this.println(node.kind === 'logand' ? `\tje\t${end}` : `\tjne\t${end}`);
        this.genExpr(node.rhs);
        if (T.isFloating(node.rhs.ty)) this.emitFloatBoolize(node.rhs.ty);
        else this.emitBoolize();
        this.println(`\tjmp\t${end}`);
        // Both paths leave a 0/1 result in %rax.
        this.println(`${end}:`);
        return;
      }
      case 'neg':
        this.genExpr(node.expr);
        if (node.ty && T.isFloating(node.ty)) {
          if (node.ty.kind === 'float') {
            this.println('\tmovl\t$-2147483648, %edi');
            this.println('\txorl\t%edi, %eax');
          } else {
            this.println('\tmovabsq\t$-9223372036854775808, %rdi');
            this.println('\txorq\t%rdi, %rax');
          }
        } else {
          this.println('\tnegq\t%rax');
        }
        return;
      case 'bitnot':
        this.genExpr(node.expr);
        this.println('\tnotq\t%rax');
        return;
      case 'not':
        this.genExpr(node.expr);
        this.emitBoolize();
        this.println('\txorq\t$1, %rax');
        return;
      case 'preinc':
      case 'predec':
      case 'postinc':
      case 'postdec':
        this.genIncDec(node);
        return;
      case 'funcall':
        this.genCall(node);
        return;
      case 'builtin':
        this.genBuiltin(node);
        return;
      case 'add':
      case 'sub':
      case 'mul':
      case 'div':
      case 'mod':
      case 'bitand':
      case 'bitor':
      case 'bitxor':
      case 'shl':
      case 'shr':
      case 'eq':
      case 'ne':
      case 'lt':
      case 'le':
      case 'gt':
      case 'ge':
        this.genBinary(node);
        return;
      default:
        throw new CcError(`codegen: unsupported node kind '${node.kind}'`);
    }
  }

  // -------------------------------------------------------------- addressing

  /** @param {import('./parse.js').Node} node */
  genAddr(node) {
    switch (node.kind) {
      case 'compound':
        if (node.init) this.genStmt(node.init);
        this.println(`\tleaq\t${node.var.offset}(%rbp), %rax`);
        return;
      case 'var':
        if (node.var.isLocal) {
          this.println(`\tleaq\t${node.var.offset}(%rbp), %rax`);
          return;
        }
        if (node.var.isThreadLocal) {
          // Local-exec TLS: the thread pointer lives at %fs:0, and the linker
          // patches `@tpoff` to the variable's (negative) offset from it.
          this.println('\tmovq\t%fs:0, %rax');
          this.println(`\tleaq\t${node.var.label}@tpoff(%rax), %rax`);
          return;
        }
        this.println(`\tleaq\t${node.var.label}(%rip), %rax`);
        return;
      case 'deref':
        this.genExpr(node.expr);
        return;
      case 'member': {
        this.genAddr(node.lhs);
        if (node.member.offset) {
          this.println(`\taddq\t$${node.member.offset}, %rax`);
        }
        return;
      }
      default:
        throw new CcError(`codegen: not an lvalue (${node.kind})`);
    }
  }

  /** @param {import('./parse.js').Node} node */
  loadVar(node) {
    const ty = node.ty;
    // Aggregates and arrays are represented by their address, not by their
    // contents, so leave %rax untouched.
    if (T.isAggregate(ty) || T.isArray(ty)) return;
    if (node.kind === 'member' && this.isBitfieldMember(node.member)) {
      this.loadBitfield(node.member);
      return;
    }
    this.loadFromAddr(ty);
  }

  /**
   * @param {any} member
   * @returns {boolean}
   */
  isBitfieldMember(member) {
    return Boolean(member) && member.bitWidth !== undefined && member.bitWidth > 0;
  }

  /**
   * Load a bit-field from the storage unit addressed by %rax. The value is
   * shifted down, masked to its declared width and sign-extended when the
   * underlying type is signed.
   * @param {any} member
   */
  loadBitfield(member) {
    const ty = member.ty;
    if (ty.size === 1) this.println('\tmovzbq\t(%rax), %rax');
    else if (ty.size === 2) this.println('\tmovzwq\t(%rax), %rax');
    else if (ty.size === 4) this.println('\tmovl\t(%rax), %eax');
    else this.println('\tmovq\t(%rax), %rax');
    const width = member.bitWidth;
    if (member.bitOffset) this.println(`\tshrq\t$${member.bitOffset}, %rax`);
    if (width < 64) {
      const mask = (1n << BigInt(width)) - 1n;
      if (mask < 1n << 31n) {
        this.println(`\tandq\t$${mask}, %rax`);
      } else {
        this.println(`\tmovabsq\t$${mask}, %rcx`);
        this.println('\tandq\t%rcx, %rax');
      }
    }
    if (!ty.isUnsigned) {
      const shift = 64 - width;
      if (shift > 0) {
        this.println(`\tshlq\t$${shift}, %rax`);
        this.println(`\tsarq\t$${shift}, %rax`);
      }
    }
  }

  /**
   * Store %rax into the bit-field storage unit addressed by %rdi.
   * @param {any} member
   */
  storeBitfield(member) {
    const ty = member.ty;
    const width = member.bitWidth;
    const offset = member.bitOffset ?? 0;
    const mask = (1n << BigInt(width)) - 1n;
    const fieldMask = mask << BigInt(offset);
    const unitMask = (1n << BigInt(ty.size * 8)) - 1n;
    const clearMask = (~fieldMask) & unitMask;

    this.println('\tmovq\t%rax, %rcx');
    if (mask < 1n << 31n) this.println(`\tandq\t$${mask}, %rcx`);
    else {
      this.println(`\tmovabsq\t$${mask}, %rdx`);
      this.println('\tandq\t%rdx, %rcx');
    }
    if (offset) this.println(`\tshlq\t$${offset}, %rcx`);

    if (clearMask === 0n) {
      this.println('\tmovq\t%rcx, %rdx');
    } else {
      if (ty.size === 1) this.println('\tmovzbq\t(%rdi), %rdx');
      else if (ty.size === 2) this.println('\tmovzwq\t(%rdi), %rdx');
      else if (ty.size === 4) this.println('\tmovl\t(%rdi), %edx');
      else this.println('\tmovq\t(%rdi), %rdx');
      this.println(`\tmovabsq\t$${clearMask}, %r8`);
      this.println('\tandq\t%r8, %rdx');
      this.println('\torq\t%rcx, %rdx');
    }
    if (ty.size === 1) this.println('\tmovb\t%dl, (%rdi)');
    else if (ty.size === 2) this.println('\tmovw\t%dx, (%rdi)');
    else if (ty.size === 4) this.println('\tmovl\t%edx, (%rdi)');
    else this.println('\tmovq\t%rdx, (%rdi)');

    // The value of an assignment expression is the stored value converted
    // back to the bit-field type.
    this.println('\tmovq\t%rcx, %rax');
    if (offset) this.println(`\tshrq\t$${offset}, %rax`);
    if (!ty.isUnsigned && width < 64) {
      const shift = 64 - width;
      this.println(`\tshlq\t$${shift}, %rax`);
      this.println(`\tsarq\t$${shift}, %rax`);
    }
  }

  /**
   * Store %rax through the lvalue node whose address is in %rdi.
   * @param {import('./parse.js').Node} node
   */
  storeLValue(node) {
    if (node.kind === 'member' && this.isBitfieldMember(node.member)) {
      this.storeBitfield(node.member);
      return;
    }
    this.store(node.ty);
  }

  /**
   * Load a value from memory at (%rax) into %rax, with proper sign/zero extension.
   * @param {T.CType} ty
   */
  loadFromAddr(ty) {
    if (ty.kind === 'float') {
      this.println('\tmovl\t(%rax), %eax');
      return;
    }
    if (ty.kind === 'double') {
      this.println('\tmovq\t(%rax), %rax');
      return;
    }
    if (ty.size === 1) {
      this.println(ty.isUnsigned ? '\tmovzbq\t(%rax), %rax' : '\tmovsbq\t(%rax), %rax');
    } else if (ty.size === 2) {
      this.println(ty.isUnsigned ? '\tmovzwq\t(%rax), %eax' : '\tmovswq\t(%rax), %rax');
    } else if (ty.size === 4) {
      this.println(ty.isUnsigned ? '\tmovl\t(%rax), %eax' : '\tmovslq\t(%rax), %rax');
    } else if (ty.size === 8) {
      this.println('\tmovq\t(%rax), %rax');
    }
  }

  /**
   * Extend the lower bytes of %rax according to the type (used for casts).
   * @param {T.CType} ty
   */
  loadValue(ty) {
    if (ty.size === 1) {
      this.println(ty.isUnsigned ? '\tmovzbq\t%al, %rax' : '\tmovsbq\t%al, %rax');
    } else if (ty.size === 2) {
      this.println(ty.isUnsigned ? '\tmovzwq\t%ax, %eax' : '\tmovswq\t%ax, %rax');
    } else if (ty.size === 4) {
      this.println(ty.isUnsigned ? '\tmovl\t%eax, %eax' : '\tmovslq\t%eax, %rax');
    } else if (ty.size === 8) {
      // already in %rax
    }
  }

  /**
   * @param {T.CType} ty
   */
  store(ty) {
    // %rax = value, %rdi = destination address
    if (T.isAggregate(ty)) {
      this.copyAggregate('%rax', '%rdi', ty.size);
      return;
    }
    const dst = '(%rdi)';
    if (ty.kind === 'float') { this.println(`\tmovl\t%eax, ${dst}`); return; }
    if (ty.kind === 'double') { this.println(`\tmovq\t%rax, ${dst}`); return; }
    if (ty.size === 1) this.println(`\tmovb\t%al, ${dst}`);
    else if (ty.size === 2) this.println(`\tmovw\t%ax, ${dst}`);
    else if (ty.size === 4) this.println(`\tmovl\t%eax, ${dst}`);
    else if (ty.size === 8) this.println(`\tmovq\t%rax, ${dst}`);
  }

  /**
   * Copy an aggregate value from a memory pointer to a destination pointer.
   * @param {string} src
   * @param {string} dst
   * @param {number} size
   */
  copyAggregate(src, dst, size) {
    this.println(`\tmovq\t${src}, %rsi`);
    this.println(`\tmovq\t${dst}, %rdi`);
    this.println(`\tmovl\t$${size}, %ecx`);
    this.println('\trep movsb');
  }

  // --------------------------------------------------------- binary ops

  /** @param {import('./parse.js').Node} node */
  genBinary(node) {
    this.genExpr(node.lhs);
    this.push();
    this.genExpr(node.rhs);
    this.push();
    // stack top = rhs, below = lhs
    this.pop('%rdi'); // rdi = rhs
    this.pop('%rax'); // rax = lhs

    if (node.opTy && T.isFloating(node.opTy)) {
      this.emitFloatBinary(node.kind, node.opTy);
      return;
    }

    if (node.ptrDiff) {
      // (lhs - rhs) / base size
      this.println('\tsubq\t%rdi, %rax');
      const baseSize = node.ptrBase.size;
      if (baseSize > 1) {
        this.println(`\tmovq\t$${baseSize}, %rcx`);
        this.println('\tcqto');
        this.println('\tidivq\t%rcx');
      }
      return;
    }

    if (node.ptrScale && node.ptrScale > 1) {
      this.println(`\timulq\t$${node.ptrScale}, %rdi`);
    }

    this.emitBinaryOp(node.kind, node.opTy);
    // Narrow the result to the expression's C type so that comparisons and
    // further arithmetic observe the usual integer conversions (for example
    // `unsigned int` wraps at 32 bits).
    if (node.ty && !T.isFloating(node.ty) && T.isInteger(node.ty)) {
      this.loadValue(node.ty);
    }
  }

  /**
   * Floating-point binary operations. The backend keeps a floating value as
   * its raw bit pattern in %rax so it can share the stack-machine plumbing
   * with integers; SSE is only used for the operation itself.
   *
   * @param {string} kind
   * @param {T.CType} ty
   */
  emitFloatBinary(kind, ty) {
    const isFloat = ty.kind === 'float';
    const suffix = isFloat ? 'ss' : 'sd';
    const toXmm = isFloat ? 'movd' : 'movq';
    const lhsReg = isFloat ? '%eax' : '%rax';
    const rhsReg = isFloat ? '%edi' : '%rdi';
    this.println(`\t${toXmm}\t${lhsReg}, %xmm0`);
    this.println(`\t${toXmm}\t${rhsReg}, %xmm1`);
    switch (kind) {
      case 'add': this.println(`\tadd${suffix}\t%xmm1, %xmm0`); break;
      case 'sub': this.println(`\tsub${suffix}\t%xmm1, %xmm0`); break;
      case 'mul': this.println(`\tmul${suffix}\t%xmm1, %xmm0`); break;
      case 'div': this.println(`\tdiv${suffix}\t%xmm1, %xmm0`); break;
      case 'eq':
      case 'ne':
      case 'lt':
      case 'le':
      case 'gt':
      case 'ge': {
        this.println(`\tucomi${suffix}\t%xmm1, %xmm0`);
        const setcc = { eq: 'sete', ne: 'setne', lt: 'setb', le: 'setbe', gt: 'seta', ge: 'setae' }[kind];
        this.println(`\t${setcc}\t%al`);
        // Unordered (NaN) results must be false for eq/lt/le.
        if (kind === 'eq' || kind === 'lt' || kind === 'le') {
          this.println('\tsetnp\t%dl');
          this.println('\tandb\t%dl, %al');
        } else if (kind === 'ne') {
          this.println('\tsetp\t%dl');
          this.println('\torb\t%dl, %al');
        }
        this.println('\tmovzbq\t%al, %rax');
        return;
      }
      default:
        throw new CcError(`codegen: unsupported floating operator '${kind}'`);
    }
    this.println(`\t${toXmm}\t%xmm0, ${lhsReg}`);
  }

  /**
   * @param {string} kind
   * @param {T.CType} ty
   */
  emitBinaryOp(kind, ty) {
    const isUnsigned = Boolean(ty.isUnsigned);
    switch (kind) {
      case 'add':
        this.println('\taddq\t%rdi, %rax');
        return;
      case 'sub':
        this.println('\tsubq\t%rdi, %rax');
        return;
      case 'mul':
        this.println('\timulq\t%rdi, %rax');
        return;
      case 'div':
        if (isUnsigned) {
          this.println('\txorl\t%edx, %edx');
          this.println('\tdivq\t%rdi');
        } else {
          this.println('\tcqto');
          this.println('\tidivq\t%rdi');
        }
        return;
      case 'mod':
        if (isUnsigned) {
          this.println('\txorl\t%edx, %edx');
          this.println('\tdivq\t%rdi');
        } else {
          this.println('\tcqto');
          this.println('\tidivq\t%rdi');
        }
        this.println('\tmovq\t%rdx, %rax');
        return;
      case 'bitand':
        this.println('\tandq\t%rdi, %rax');
        return;
      case 'bitor':
        this.println('\torq\t%rdi, %rax');
        return;
      case 'bitxor':
        this.println('\txorq\t%rdi, %rax');
        return;
      case 'shl':
        this.println('\tmovq\t%rdi, %rcx');
        this.println('\tshlq\t%cl, %rax');
        return;
      case 'shr':
        this.println('\tmovq\t%rdi, %rcx');
        this.println(isUnsigned ? '\tshrq\t%cl, %rax' : '\tsarq\t%cl, %rax');
        return;
      case 'eq':
        this.println('\tcmpq\t%rdi, %rax');
        this.println('\tsete\t%al');
        this.println('\tmovzbq\t%al, %rax');
        return;
      case 'ne':
        this.println('\tcmpq\t%rdi, %rax');
        this.println('\tsetne\t%al');
        this.println('\tmovzbq\t%al, %rax');
        return;
      case 'lt':
        this.println('\tcmpq\t%rdi, %rax');
        this.println(isUnsigned ? '\tsetb\t%al' : '\tsetl\t%al');
        this.println('\tmovzbq\t%al, %rax');
        return;
      case 'le':
        this.println('\tcmpq\t%rdi, %rax');
        this.println(isUnsigned ? '\tsetbe\t%al' : '\tsetle\t%al');
        this.println('\tmovzbq\t%al, %rax');
        return;
      case 'gt':
        this.println('\tcmpq\t%rdi, %rax');
        this.println(isUnsigned ? '\tseta\t%al' : '\tsetg\t%al');
        this.println('\tmovzbq\t%al, %rax');
        return;
      case 'ge':
        this.println('\tcmpq\t%rdi, %rax');
        this.println(isUnsigned ? '\tsetae\t%al' : '\tsetge\t%al');
        this.println('\tmovzbq\t%al, %rax');
        return;
      default:
        throw new CcError(`codegen: unsupported operator '${kind}'`);
    }
  }

  /** @param {import('./parse.js').Node} node */
  genIncDec(node) {
    const isPost = node.kind === 'postinc' || node.kind === 'postdec';
    this.genAddr(node.expr);
    this.push(); // address
    this.loadVar(node.expr);
    // Keep the old value in a scratch register: the store below needs %rax
    // for the new value and %rdi for the destination address.
    this.println('\tmovq\t%rax, %r10');
    const step = node.expr.ty.kind === 'ptr' && node.expr.ty.base ? node.expr.ty.base.size : 1;
    const isInc = node.kind === 'preinc' || node.kind === 'postinc';
    // `--x` must be `old - 1`, not `1 - old`.
    this.println(isInc ? `\taddq\t$${step}, %rax` : `\tsubq\t$${step}, %rax`);
    if (!T.isFloating(node.expr.ty)) this.loadValue(node.expr.ty);
    this.pop('%rdi'); // address
    this.storeLValue(node.expr);
    if (isPost) this.println('\tmovq\t%r10, %rax');
  }

  // --------------------------------------------------------------- calls

  /** @param {import('./parse.js').Node} node */
  /** @param {import('./parse.js').Node} node */
  genBuiltin(node) {
    const args = node.args ?? [];
    switch (node.builtin) {
      case '__builtin_expect':
        if (args[0]) this.genExpr(args[0]);
        return;
      case '__builtin_constant_p':
        this.println('\tmovl\t$0, %eax');
        return;
      case '__builtin_prefetch':
        return;
      case '__builtin_unreachable':
        this.println('\tud2');
        return;
      case '__builtin_frame_address':
        this.println('\txorl\t%eax, %eax');
        return;
      case '__builtin_clz':
      case '__builtin_clzll': {
        this.genExpr(args[0]);
        this.println('\tbsrq\t%rax, %rdx');
        this.println(`\tmovl\t$${node.builtin === '__builtin_clz' ? 31 : 63}, %eax`);
        this.println('\tsubq\t%rdx, %rax');
        return;
      }
      case '__builtin_ctz':
      case '__builtin_ctzll': {
        this.genExpr(args[0]);
        this.println('\tbsfq\t%rax, %rdx');
        this.println('\tmovq\t%rdx, %rax');
        return;
      }
      case '__builtin_popcount':
      case '__builtin_popcountll': {
        // Portable bit count; quietjs only uses it on cold paths.
        const loop = this.uniqueLabel('popcount');
        const done = this.uniqueLabel('popcount.done');
        this.genExpr(args[0]);
        this.println('\txorl\t%edx, %edx');
        this.println(`${loop}:`);
        this.println('\ttestq\t%rax, %rax');
        this.println(`\tje\t${done}`);
        this.println('\tmovq\t%rax, %rcx');
        this.println('\tsubq\t$1, %rcx');
        this.println('\tandq\t%rcx, %rax');
        this.println('\taddl\t$1, %edx');
        this.println(`\tjmp\t${loop}`);
        this.println(`${done}:`);
        this.println('\tmovl\t%edx, %eax');
        return;
      }
      case '__builtin_bswap16':
        this.genExpr(args[0]);
        this.println('\trolw\t$8, %ax');
        this.println('\tmovzwq\t%ax, %rax');
        return;
      case '__builtin_bswap32':
        this.genExpr(args[0]);
        this.println('\tbswapl\t%eax');
        return;
      case '__builtin_bswap64':
        this.genExpr(args[0]);
        this.println('\tbswapq\t%rax');
        return;
      case '__builtin_va_start': {
        const fn = this.currentFn;
        if (!fn?.vaArea) throw new CcError('codegen: va_start outside a variadic function');
        const types = fn.params.map((p) => p.ty);
        const abiTypes = fn.sretSlot ? [T.pointerTo(T.voidType), ...types] : types;
        const info = this.classifyArgs(abiTypes);
        let gp = 0;
        let fp = 0;
        let stack = 0;
        for (let i = 0; i < abiTypes.length; i += 1) {
          const cls = info.classes[i];
          if (!cls) {
            stack = Math.max(stack, info.stackSlots[i] + Math.ceil(Math.max(abiTypes[i].size, 1) / 8));
            continue;
          }
          for (const c of cls) {
            if (c === 'INTEGER') gp += 1;
            else fp += 1;
          }
        }
        this.genAddr(args[0]);
        this.println(`\tmovq\t$${gp * 8}, %rcx`);
        this.println('\tmovl\t%ecx, 0(%rax)');
        this.println(`\tmovq\t$${48 + fp * 16}, %rcx`);
        this.println('\tmovl\t%ecx, 4(%rax)');
        this.println(`\tleaq\t${16 + stack * 8}(%rbp), %rcx`);
        this.println('\tmovq\t%rcx, 8(%rax)');
        this.println(`\tleaq\t${fn.vaArea.offset}(%rbp), %rcx`);
        this.println('\tmovq\t%rcx, 16(%rax)');
        return;
      }
      case '__builtin_va_end':
        this.println('\txorl\t%eax, %eax');
        return;
      case '__builtin_va_copy': {
        this.genAddr(args[1]);
        this.println('\tmovq\t%rax, %r10');
        this.genAddr(args[0]);
        for (let i = 0; i < 3; i += 1) {
          this.println(`\tmovq\t${i * 8}(%r10), %rcx`);
          this.println(`\tmovq\t%rcx, ${i * 8}(%rax)`);
        }
        return;
      }
      case '__builtin_va_arg': {
        // Fetch one argument from the SysV va_list. Floats are promoted to
        // double at the call site, so SSE values always occupy 16-byte slots.
        const ty = node.vaTy;
        const floating = T.isFloating(ty);
        const outLabel = this.uniqueLabel('vaarg.done');
        const overflow = this.uniqueLabel('vaarg.mem');
        this.genExpr(args[0]);
        this.println('\tmovq\t%rax, %r10');
        if (floating) {
          this.println('\tmovl\t4(%r10), %ecx');
          this.println('\tcmpq\t$160, %rcx');
          this.println(`\tja\t${overflow}`);
          this.println('\tmovq\t16(%r10), %rdx');
          this.println('\taddq\t%rcx, %rdx');
          this.println('\tmovq\t(%rdx), %rax');
          this.println('\taddq\t$16, %rcx');
          this.println('\tmovl\t%ecx, 4(%r10)');
        } else {
          this.println('\tmovl\t0(%r10), %ecx');
          this.println('\tcmpq\t$40, %rcx');
          this.println(`\tja\t${overflow}`);
          this.println('\tmovq\t16(%r10), %rdx');
          this.println('\taddq\t%rcx, %rdx');
          this.println('\tmovq\t(%rdx), %rax');
          this.println('\taddq\t$8, %rcx');
          this.println('\tmovl\t%ecx, 0(%r10)');
        }
        this.println(`\tjmp\t${outLabel}`);
        this.println(`${overflow}:`);
        this.println('\tmovq\t8(%r10), %rdx');
        this.println('\tmovq\t(%rdx), %rax');
        this.println('\taddq\t$8, %rdx');
        this.println('\tmovq\t%rdx, 8(%r10)');
        this.println(`${outLabel}:`);
        return;
      }
      default:
        throw new CcError(`codegen: unsupported builtin '${node.builtin}'`);
    }
  }

  /**
   * Convert an aggregate value (address in %rax) into the ABI return
   * registers.
   * @param {T.CType} ty
   */
  emitAggregateReturn(ty) {
    const classes = this.classifyType(ty);
    if (!classes) {
      // Large aggregates: the caller passed a hidden destination pointer.
      const slot = this.currentFn?.sretSlot;
      if (!slot) throw new CcError(`codegen: no hidden return slot for ${ty.size}-byte aggregate`);
      this.println('\tmovq\t%rax, %rsi');
      this.println(`\tmovq\t${slot.offset}(%rbp), %rdi`);
      this.println(`\tmovl\t$${ty.size}, %ecx`);
      this.println('\trep movsb');
      this.println(`\tmovq\t${slot.offset}(%rbp), %rax`);
      return;
    }
    const intRegs = ['%rax', '%rdx'];
    const sseRegs = ['%xmm0', '%xmm1'];
    this.println('\tmovq\t%rax, %r10');
    let ii = 0;
    let si = 0;
    for (let k = 0; k < classes.length; k += 1) {
      if (classes[k] === 'INTEGER') this.println(`\tmovq\t${k * 8}(%r10), ${intRegs[ii++]}`);
      else {
        this.println(`\tmovq\t${k * 8}(%r10), %r11`);
        this.println(`\tmovq\t%r11, ${sseRegs[si++]}`);
      }
    }
  }

  genCall(node) {
    const args = node.args ?? [];
    const types = args.map((a) => (T.isAggregate(a.ty) ? a.ty : T.decay(a.ty)));
    // Large aggregate results travel through a hidden pointer which occupies
    // the first integer argument slot.
    const sret = T.isAggregate(node.ty) && node.ty.size > 16;
    const abiTypes = sret ? [T.pointerTo(T.voidType), ...types] : types;
    const shift = sret ? 1 : 0;
    const info = this.classifyArgs(abiTypes);
    const n = args.length;
    const slots = n + shift;
    // Count the outgoing stack slots (each argument contributes its own span).
    let stackCount = 0;
    for (let i = 0; i < n; i += 1) {
      const ai = i + shift;
      if (info.stackSlots[ai] < 0) continue;
      stackCount = Math.max(stackCount, info.stackSlots[ai] + Math.ceil(Math.max(types[i].size, 1) / 8));
    }

    // Scratch area holds one slot per evaluated argument; the outgoing stack
    // argument area sits below it so that %rsp points at the first stack arg
    // when the call executes.
    const pad = (this.depth + slots + stackCount) % 2;
    const units = slots + stackCount + pad;
    const alloc = units * 8;
    if (alloc > 0) {
      this.println(`\tsubq\t$${alloc}, %rsp`);
      this.depth += units;
    }
    const scratchBase = stackCount * 8;
    const slotAt = (index) => `${scratchBase + index * 8}(%rsp)`;
    const slotOf = (i) => slotAt(i + shift);

    if (sret) {
      this.println(`\tleaq\t${node.retTemp.offset}(%rbp), %rax`);
      this.println(`\tmovq\t%rax, ${slotAt(0)}`);
    }

    // Evaluate every argument once and park it in the scratch area.
    for (let i = 0; i < n; i += 1) {
      this.genExpr(args[i]);
      this.println(`\tmovq\t%rax, ${slotOf(i)}`);
    }

    // Move memory-class arguments into the outgoing area.
    for (let i = 0; i < n; i += 1) {
      const ai = i + shift;
      if (info.stackSlots[ai] < 0) continue;
      const dst = info.stackSlots[ai] * 8;
      if (T.isAggregate(types[i])) {
        this.println(`\tmovq\t${slotOf(i)}, %rsi`);
        this.println(`\tleaq\t${dst}(%rsp), %rdi`);
        this.println(`\tmovl\t$${types[i].size}, %ecx`);
        this.println('\trep movsb');
      } else {
        this.println(`\tmovq\t${slotOf(i)}, %rax`);
        this.println(`\tmovq\t%rax, ${dst}(%rsp)`);
      }
    }

    const direct = node.fn.kind === 'var' && node.fn.var.isFunction;
    if (!direct) {
      this.genExpr(node.fn);
      this.println('\tmovq\t%rax, %r11');
    }

    // Load register-class arguments.
    for (let i = 0; i < n; i += 1) {
      const ai = i + shift;
      const cls = info.classes[ai];
      if (!cls) continue;
      let ii = 0;
      let si = 0;
      if (T.isAggregate(types[i])) {
        this.println(`\tmovq\t${slotOf(i)}, %rax`);
        for (let k = 0; k < cls.length; k += 1) {
          if (cls[k] === 'INTEGER') {
            this.println(`\tmovq\t${k * 8}(%rax), ${REG_ARGS[info.intRegs[ai][ii++]]}`);
          } else {
            this.println(`\tmovq\t${k * 8}(%rax), %r10`);
            this.println(`\tmovq\t%r10, %xmm${info.sseRegs[ai][si++]}`);
          }
        }
      } else if (types[i].kind === 'float') {
        this.println(`\tmovl\t${slotOf(i)}, %eax`);
        this.println(`\tmovd\t%eax, %xmm${info.sseRegs[ai][si++]}`);
      } else if (types[i].kind === 'double') {
        this.println(`\tmovq\t${slotOf(i)}, %rax`);
        this.println(`\tmovq\t%rax, %xmm${info.sseRegs[ai][si++]}`);
      } else {
        this.println(`\tmovq\t${slotOf(i)}, ${REG_ARGS[info.intRegs[ai][ii++]]}`);
      }
    }
    if (sret) this.println('\tmovq\t0(%rsp), %rdi');

    // %al carries the number of vector registers used for variadic calls.
    this.println(`\tmovl\t$${info.sseRegs.flat().length}, %eax`);
    if (direct) {
      this.println(`\tcall\t${node.fn.var.label}`);
    } else {
      this.println('\tcall\t*%r11');
    }
    if (alloc > 0) {
      this.println(`\taddq\t$${alloc}, %rsp`);
      this.depth -= units;
    }

    this.emitCallResult(node);
  }

  /**
   * Convert the ABI return registers into the internal representation used by
   * the code generator: scalars (including float bits) in %rax, aggregates as
   * an address in %rax.
   * @param {import('./parse.js').Node} node
   */
  emitCallResult(node) {
    const ty = node.ty;
    if (!ty || ty.kind === 'void') return;
    if (ty.kind === 'float') {
      this.println('\tmovd\t%xmm0, %eax');
      return;
    }
    if (ty.kind === 'double') {
      this.println('\tmovq\t%xmm0, %rax');
      return;
    }
    if (!T.isAggregate(ty)) {
      // ABI leaves narrower integer results in %eax; normalize to 64 bits.
      this.loadValue(ty);
      return;
    }
    const classes = this.classifyType(ty);
    if (!classes) {
      // Large aggregate: the callee copied into the hidden destination slot and
      // returned its address in %rax, which is already what the backend wants.
      return;
    }
    if (!node.retTemp) throw new CcError('codegen: missing temporary for aggregate return value');
    const intRegs = ['%rax', '%rdx'];
    const sseRegs = ['%xmm0', '%xmm1'];
    let ii = 0;
    let si = 0;
    let remaining = ty.size;
    for (let k = 0; k < classes.length; k += 1) {
      const chunk = Math.min(remaining, 8);
      if (classes[k] === 'INTEGER') {
        this.storeEightByte(intRegs[ii++], node.retTemp.offset + k * 8, chunk);
      } else {
        this.println(`\tmovq\t${sseRegs[si++]}, %r10`);
        this.storeEightByte('%r10', node.retTemp.offset + k * 8, chunk);
      }
      remaining -= chunk;
    }
    this.println(`\tleaq\t${node.retTemp.offset}(%rbp), %rax`);
  }

  // --------------------------------------------------------------- casts

  /**
   * @param {T.CType} from
   * @param {T.CType} to
   */
  genCast(from, to) {
    if (to.kind === 'void') return;
    if (to.kind === 'bool') {
      if (T.isFloating(from)) this.emitFloatBoolize(from);
      else this.emitBoolize();
      return;
    }
    if (T.isFloating(to)) {
      if (to.kind === from.kind) return;
      if (T.isFloating(from)) {
        if (to.kind === 'float') {
          this.println('\tmovq\t%rax, %xmm0');
          this.println('\tcvtsd2ss\t%xmm0, %xmm0');
          this.println('\tmovd\t%xmm0, %eax');
        } else {
          this.println('\tmovd\t%eax, %xmm0');
          this.println('\tcvtss2sd\t%xmm0, %xmm0');
          this.println('\tmovq\t%xmm0, %rax');
        }
      } else {
        this.println('\tcvtsi2sd\t%rax, %xmm0');
        if (to.kind === 'float') {
          this.println('\tcvtsd2ss\t%xmm0, %xmm0');
          this.println('\tmovd\t%xmm0, %eax');
        } else {
          this.println('\tmovq\t%xmm0, %rax');
        }
      }
      return;
    }
    if (T.isFloating(from)) {
      this.println(from.kind === 'float' ? '\tmovd\t%eax, %xmm0' : '\tmovq\t%rax, %xmm0');
      this.println(`\tcvtt${from.kind === 'float' ? 'ss' : 'sd'}2si\t%xmm0, %rax`);
      // Truncation to the destination integer width happens below.
    }
    if (to.kind === 'char') {
      this.println(to.isUnsigned ? '\tmovzbq\t%al, %rax' : '\tmovsbq\t%al, %rax');
      return;
    }
    if (to.kind === 'short') {
      this.println(to.isUnsigned ? '\tmovzwq\t%ax, %eax' : '\tmovswq\t%ax, %rax');
      return;
    }
    if (to.kind === 'int') {
      this.println(to.isUnsigned ? '\tmovl\t%eax, %eax' : '\tmovslq\t%eax, %rax');
      return;
    }
    if (to.kind === 'long') return;
    if (T.isPointer(to)) {
      // Pointer truncation is a no-op on x86_64.
      return;
    }
    if (T.isInteger(to)) return;
    throw new CcError(`codegen: cast to '${to.toString()}' is not supported`);
  }

  emitBoolize() {
    this.println('\ttestq\t%rax, %rax');
    this.println('\tsetne\t%al');
    this.println('\tmovzbq\t%al, %rax');
  }

  /** Truthiness of a floating value whose raw bits are in %rax. */
  emitFloatBoolize(ty) {
    const isFloat = ty.kind === 'float';
    const suffix = isFloat ? 'ss' : 'sd';
    this.println(`\t${isFloat ? 'movd' : 'movq'}\t${isFloat ? '%eax' : '%rax'}, %xmm0`);
    this.println('\txorpd\t%xmm1, %xmm1');
    this.println(`\tucomi${suffix}\t%xmm1, %xmm0`);
    this.println('\tsetne\t%al');
    // NaN is truthy in C, and ucomisd reports unordered as "equal".
    this.println('\tsetp\t%dl');
    this.println('\torb\t%dl, %al');
    this.println('\tmovzbq\t%al, %rax');
  }

  // ---------------------------------------------------------- helpers

  /**
   * Materialize a floating literal as its raw bit pattern in %rax/%eax.
   * @param {number} value
   * @param {T.CType} ty
   */
  emitFloatImm(value, ty) {
    const buf = Buffer.alloc(8);
    if (ty.kind === 'float') {
      buf.writeFloatLE(value, 0);
      const bits = BigInt.asIntN(32, BigInt(buf.readUInt32LE(0)));
      this.println(`\tmovl\t$${bits}, %eax`);
    } else {
      buf.writeDoubleLE(value, 0);
      const bits = BigInt.asIntN(64, buf.readBigUInt64LE(0));
      this.println(`\tmovabsq\t$${bits}, %rax`);
    }
  }

  /** @param {bigint} value */
  emitImm(value) {
    // Normalize to 64-bit signed
    const u64 = value & 0xffffffffffffffffn;
    const s64 = u64 >= 1n << 63n ? u64 - (1n << 64n) : u64;
    // `movl $imm32, %eax` zero-extends, so it is only correct for values in
    // [0, 2^32). Negative (and larger) constants must be materialized with a
    // full 64-bit move or 64-bit consumers see a zero-extended value (e.g.
    // JS_TAG_MODULE = -3 turning into 0x00000000fffffffd).
    if (s64 >= 0n && s64 < 1n << 32n) {
      this.println(`\tmovl\t$${s64}, %eax`);
    } else {
      this.println(`\tmovabsq\t$${s64}, %rax`);
    }
  }

  /**
   * @param {bigint} value
   * @returns {string | null}
   */
  signed32(value) {
    const u64 = value & 0xffffffffffffffffn;
    const s64 = u64 >= 1n << 63n ? u64 - (1n << 64n) : u64;
    if (s64 >= -(1n << 31n) && s64 < 1n << 31n) return s64.toString();
    return null;
  }

  /** Emit a push and keep the depth tracker in sync. */
  push() {
    this.println('\tpushq\t%rax');
    this.depth += 1;
  }

  /**
   * @param {string} reg
   */
  pop(reg) {
    this.println(`\tpopq\t${reg}`);
    this.depth -= 1;
  }
}
