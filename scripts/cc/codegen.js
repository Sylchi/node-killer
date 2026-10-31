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
    this.println(`\tsubq\t$${fn.stackSize}, %rsp`);

    this.depth = 0;
    this.returnLabel = this.uniqueLabel('return');

    // Spill incoming register arguments into their stack slots.
    for (let i = 0; i < Math.min(fn.params.length, 6); i += 1) {
      const param = fn.params[i];
      this.storeParam(param, REG_ARGS[i]);
    }
    // Stack arguments start at 16(%rbp) (return address + saved rbp).
    for (let i = 6; i < fn.params.length; i += 1) {
      const param = fn.params[i];
      const src = 16 + (i - 6) * 8;
      this.println(`\tmovq\t${src}(%rbp), %rax`);
      this.storeParam(param, '%rax');
    }

    this.genStmt(fn.body);
    // An implicit return for functions that fall through.
    this.println(`${this.returnLabel}:`);
    this.println('\tleave');
    this.println('\tret');
  }

  /**
   * @param {import('./parse.js').Obj} param
   * @param {string} reg
   */
  storeParam(param, reg) {
    const ty = param.ty;
    const dst = `${param.offset}(%rbp)`;
    const regName = this.paramRegisterSize(reg, ty.size);
    if (ty.size === 1) this.println(`\tmovb\t${regName}, ${dst}`);
    else if (ty.size === 2) this.println(`\tmovw\t${regName}, ${dst}`);
    else if (ty.size === 4) this.println(`\tmovl\t${regName}, ${dst}`);
    else if (ty.size === 8) this.println(`\tmovq\t${regName}, ${dst}`);
    else this.copyMemory(regName, dst, ty.size);
  }

  /**
   * Get the register name matching a register and a value size.
   * @param {string} reg register like '%rdi'
   * @param {number} size value size in bytes (1, 2, 4, 8)
   * @returns {string}
   */
  paramRegisterSize(reg, size) {
    if (size === 8) return reg;
    const names = {
      '%rdi': { 4: '%edi', 2: '%di', 1: '%dil' },
      '%rsi': { 4: '%esi', 2: '%si', 1: '%sil' },
      '%rdx': { 4: '%edx', 2: '%dx', 1: '%dl' },
      '%rcx': { 4: '%ecx', 2: '%cx', 1: '%cl' },
      '%r8': { 4: '%r8d', 2: '%r8w', 1: '%r8b' },
      '%r9': { 4: '%r9d', 2: '%r9w', 1: '%r9b' },
    };
    const mapping = names[reg];
    if (!mapping) return reg;
    return mapping[size] ?? reg;
  }

  // ------------------------------------------------------------- globals

  /** @param {import('./parse.js').Obj} obj */
  emitGlobal(obj) {
    if (obj.isExtern && !obj.isDefinition) return;
    const allZero =
      obj.initData && !obj.relocs.length && this.isZero(obj.initData);
    const section = allZero ? '.bss' : '.data';
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
        this.println(node.label.startsWith('.L.') ? `${node.label}:` : `.L.label.${node.label}:`);
        this.genStmt(node.stmt);
        return;
      case 'goto':
        this.println(`\tjmp\t.L.label.${node.label}`);
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
        this.emitImm(node.val);
        return;
      case 'var':
        this.genAddr(node);
        if (node.var.isFunction) {
          // Function designator: %rax already holds the function address.
        } else if (!T.isAggregate(node.ty)) {
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
      case 'cast':
        this.genExpr(node.expr);
        this.genCast(node.expr.ty, node.castTy);
        return;
      case 'assign': {
        this.genAddr(node.lhs);
        this.push();
        this.genExpr(node.rhs);
        this.pop('%rdi');
        this.store(node.lhs.ty);
        return;
      }
      case 'assignOp': {
        this.genAddr(node.lhs);
        this.push();
        this.load(node.lhs.ty);
        this.push();
        this.genExpr(node.rhs);
        this.pop('%rdi');
        this.emitBinaryOp(node.op, node.lhs.ty);
        this.pop('%rdi');
        this.store(node.lhs.ty);
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
        this.println('\ttestq\t%rax, %rax');
        this.println(node.kind === 'logand' ? `\tje\t${end}` : `\tjne\t${end}`);
        this.genExpr(node.rhs);
        this.println(`\tjmp\t${end}`);
        // Reuse the same label: the result of the second operand is already in rax.
        this.println(`${end}:`);
        this.emitBoolize();
        return;
      }
      case 'neg':
        this.genExpr(node.expr);
        this.println('\tnegq\t%rax');
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
      case 'var':
        if (node.var.isLocal) {
          this.println(`\tleaq\t${node.var.offset}(%rbp), %rax`);
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
    if (T.isAggregate(ty)) return;
    this.loadFromAddr(ty);
  }

  /**
   * Load a value from memory at (%rax) into %rax, with proper sign/zero extension.
   * @param {T.CType} ty
   */
  loadFromAddr(ty) {
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
    this.genAddr(node.expr);
    this.push();
    this.loadFromAddr(node.expr.ty);
    const isPost = node.kind === 'postinc' || node.kind === 'postdec';
    if (isPost) {
      this.push(); // save old value
    }
    const step = node.expr.ty.kind === 'ptr' && node.expr.ty.base ? node.expr.ty.base.size : 1;
    this.emitImm(BigInt(step));
    const isInc = node.kind === 'preinc' || node.kind === 'postinc';
    if (isInc) {
      this.println('\taddq\t(%rsp), %rax');
    } else {
      this.println('\tsubq\t(%rsp), %rax');
    }
    if (isPost) {
      this.pop('%rdi'); // pop old value to make room
      this.push(); // push new value
    }
    this.pop('%rdi'); // pop address
    this.store(node.expr.ty);
    if (isPost) {
      this.pop('%rax'); // restore old value
    }
  }

  // --------------------------------------------------------------- calls

  /** @param {import('./parse.js').Node} node */
  genCall(node) {
    const args = node.args ?? [];
    const nReg = Math.min(args.length, 6);
    const nStack = Math.max(0, args.length - 6);

    // Evaluate stack args in reverse (so lower-numbered stack args are pushed later... )
    // Standard: arg #6 is at the lowest address of the arg area. Push in reverse order.
    for (let i = args.length - 1; i >= 6; i -= 1) {
      this.genExpr(args[i]);
      this.push();
    }
    // Evaluate register args directly into their registers.
    for (let i = 0; i < nReg; i += 1) {
      this.genExpr(args[i]);
      this.println(`\tmovq\t%rax, ${REG_ARGS[i]}`);
    }
    // Align the stack for the call.
    if (nStack > 0 && (this.depth % 2) !== 0) {
      this.println('\tpushq\t$0');
      this.depth += 1;
    }
    // Evaluate the function expression (may call other functions).
    this.genExpr(node.fn);
    this.println('\tmovq\t%rax, %r11');
    // Clean up stack args.
    if (nStack > 0) {
      this.println(`\taddq\t$${nStack * 8}, %rsp`);
      this.depth -= nStack;
    }
    this.println('\txorl\t%eax, %eax');
    if (node.fn.kind === 'var' && node.fn.var.isFunction) {
      this.println(`\tcall\t${node.fn.var.label}`);
    } else {
      this.println('\tcall\t*%r11');
    }
  }

  // --------------------------------------------------------------- casts

  /**
   * @param {T.CType} from
   * @param {T.CType} to
   */
  genCast(from, to) {
    if (to.kind === 'void') return;
    if (to.kind === 'bool') {
      this.emitBoolize();
      return;
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

  // ---------------------------------------------------------- helpers

  /** @param {bigint} value */
  emitImm(value) {
    // Normalize to 64-bit signed
    const u64 = value & 0xffffffffffffffffn;
    const s64 = u64 >= 1n << 63n ? u64 - (1n << 64n) : u64;
    if (s64 >= -(1n << 31n) && s64 < 1n << 31n) {
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
