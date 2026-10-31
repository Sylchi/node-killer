/**
 * Relocatable ELF64 object writer.
 *
 * The assembler in `elf.js` produces a complete executable image by resolving
 * every symbol against a fixed load address. Linking multiple objects (and
 * prebuilt static archives) needs the intermediate representation instead: an
 * ET_REL object with sections, a symbol table and relocation entries. This
 * module reuses the instruction/fixup machinery from `elf.js` and serializes
 * the result as a standard x86_64 relocatable object that `ld` or the
 * JavaScript linker in `ld.js` can consume.
 *
 * @module cc/object
 */
import { Assembler } from './elf.js';

const SHT_NULL = 0;
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_NOBITS = 8;

const SHF_WRITE = 0x1;
const SHF_ALLOC = 0x2;
const SHF_EXECINSTR = 0x4;
const SHF_TLS = 0x400;

const STB_LOCAL = 0;
const STB_GLOBAL = 1;
const STB_WEAK = 2;

const SHN_COMMON = 0xfff2;

const STT_NOTYPE = 0;
const STT_OBJECT = 1;
const STT_FUNC = 2;

const R_X86_64_NONE = 0;
const R_X86_64_64 = 1;
const R_X86_64_PC32 = 2;
const R_X86_64_TPOFF32 = 23;

const EHDR_SIZE = 64;
const SHDR_SIZE = 64;
const SYM_SIZE = 24;
const RELA_SIZE = 24;

/** @param {number} n @param {number} a */
function alignUp(n, a) {
  if (a <= 1) return n;
  return Math.ceil(n / a) * a;
}

/** @param {string} key section key from the assembler */
function sectionName(key) {
  if (key === 'text') return '.text';
  if (key === 'rodata') return '.rodata';
  if (key === 'data') return '.data';
  if (key === 'bss') return '.bss';
  return key.startsWith('.') ? key : `.${key}`;
}

/** @param {string} key */
function sectionFlags(key) {
  if (key === 'text' || key.startsWith('text.') || key.startsWith('.text')) {
    return SHF_ALLOC | SHF_EXECINSTR;
  }
  if (key === 'tls' || key.startsWith('tls.') || key.startsWith('.tls')) {
    return SHF_ALLOC | SHF_WRITE | SHF_TLS;
  }
  if (key === 'data' || key.startsWith('data.') || key.startsWith('.data')) {
    return SHF_ALLOC | SHF_WRITE;
  }
  if (key === 'bss' || key.startsWith('bss.') || key.startsWith('.bss')) {
    return SHF_ALLOC | SHF_WRITE;
  }
  return SHF_ALLOC;
}

/** @param {string} name @param {Map<string, number>} map @param {number[]} bytes */
function intern(name, map, bytes) {
  let off = map.get(name);
  if (off !== undefined) return off;
  off = bytes.length;
  map.set(name, off);
  for (let i = 0; i < name.length; i += 1) bytes.push(name.charCodeAt(i) & 0xff);
  bytes.push(0);
  return off;
}

/** @param {number} n @param {number} a */
function cmpKey(a, b) {
  /** @param {string} key assembler section key, with or without a leading dot */
  const rank = (raw) => {
    const key = raw.startsWith('.') ? raw.slice(1) : raw;
    if (key === 'text' || key.startsWith('text.')) return 0;
    if (key === 'rodata' || key.startsWith('rodata.')) return 1;
    if (key === 'data' || key.startsWith('data.')) return 2;
    if (key === 'bss' || key.startsWith('bss.')) return 3;
    if (key === 'tls' || key.startsWith('tls.')) return 4;
    return 5;
  };
  const r = rank(a.sec.name) - rank(b.sec.name);
  return r !== 0 ? r : a.index - b.index;
}

/**
 * Assemble GNU `as` source into an ET_REL object.
 *
 * @param {string} asmText
 * @param {{name?: string, weak?: boolean}} [options]
 * @returns {Buffer}
 */
export function assembleObject(asmText, options = {}) {
  const asm = new Assembler();
  asm.parse(asmText);

  const secList = asm.sections.map((sec, index) => ({ sec, index, name: sectionName(sec.name) }));
  secList.sort(cmpKey);

  const globs = new Set();
  for (const { sec } of secList) for (const g of sec.globs) globs.add(g);

  /** @type {Map<string, {sec: object, off: number, global: boolean}>} */
  const defined = new Map();
  for (const { sec } of secList) {
    for (const [label, off] of sec.labels) {
      if (defined.has(label)) throw new Error(`object: duplicate label '${label}'`);
      defined.set(label, { sec, off, global: globs.has(label), common: false });
    }
  }
  for (const c of asm.commons) {
    if (defined.has(c.name)) throw new Error(`object: duplicate symbol '${c.name}'`);
    defined.set(c.name, {
      sec: null, off: 0, global: true, common: true, align: c.align, size: c.size,
    });
  }

  // Every reference that does not resolve inside its own section needs a
  // relocation. Names that have no definition at all become global undefined
  // symbols, which is how calls into libc/prebuilt archives are represented.
  for (const { sec } of secList) {
    for (const fix of asm.fixups) {
      if (fix.sec !== sec) continue;
      const def = defined.get(fix.label);
      if (fix.kind === 'rel' && def && def.sec === sec) {
        const delta = def.off - (fix.off + 4);
        const v = delta >>> 0;
        sec.bytes[fix.off] = v & 0xff;
        sec.bytes[fix.off + 1] = (v >>> 8) & 0xff;
        sec.bytes[fix.off + 2] = (v >>> 16) & 0xff;
        sec.bytes[fix.off + 3] = (v >>> 24) & 0xff;
      }
    }
  }

  const undef = new Set();
  for (const { sec } of secList) {
    for (const fix of asm.fixups) {
      if (fix.sec !== sec) continue;
      if (!defined.has(fix.label)) undef.add(fix.label);
    }
  }
  for (const name of globs) if (!defined.has(name)) undef.add(name);

  // Symbol table: locals first, then globals, then undefined globals.
  /** @type {{name: string, bind: number, type: number, shndx: number, value: number, size: number}[]} */
  const symbols = [{ name: '', bind: STB_LOCAL, type: STT_NOTYPE, shndx: 0, value: 0, size: 0 }];
  /** @type {Map<string, number>} */
  const symIndex = new Map();

  const definedEntries = [...defined.entries()];
  for (const [name, info] of definedEntries) {
    if (info.global || info.common) continue;
    const secIndex = secList.findIndex((e) => e.sec === info.sec) + 1;
    const type = info.sec.name === 'text' && !name.startsWith('.L') ? STT_FUNC : STT_NOTYPE;
    symIndex.set(name, symbols.length);
    symbols.push({ name, bind: STB_LOCAL, type, shndx: secIndex, value: info.off, size: 0 });
  }
  const firstGlobal = symbols.length;
  for (const [name, info] of definedEntries) {
    if (!info.global) continue;
    if (info.common) {
      symIndex.set(name, symbols.length);
      symbols.push({
        name, bind: STB_GLOBAL, type: STT_OBJECT, shndx: SHN_COMMON,
        value: info.align ?? 1, size: info.size ?? 0,
      });
      continue;
    }
    const secIndex = secList.findIndex((e) => e.sec === info.sec) + 1;
    const type = info.sec.name === 'text' ? STT_FUNC : STT_OBJECT;
    const weak = options.weak === true;
    symIndex.set(name, symbols.length);
    symbols.push({ name, bind: weak ? STB_WEAK : STB_GLOBAL, type, shndx: secIndex, value: info.off, size: 0 });
  }
  for (const name of undef) {
    symIndex.set(name, symbols.length);
    symbols.push({ name, bind: STB_GLOBAL, type: STT_NOTYPE, shndx: 0, value: 0, size: 0 });
  }

  // Relocations grouped by the section they patch.
  /** @type {Map<object, {off: number, type: number, sym: number, addend: bigint}[]>} */
  const relocs = new Map();
  for (const { sec } of secList) {
    for (const fix of asm.fixups) {
      if (fix.sec !== sec) continue;
      const def = defined.get(fix.label);
      if (fix.kind === 'rel' && def && def.sec === sec) continue;
      let list = relocs.get(sec);
      if (!list) { list = []; relocs.set(sec, list); }
      const idx = symIndex.get(fix.label);
      if (idx === undefined) throw new Error(`object: missing symbol '${fix.label}'`);
      list.push({
        off: fix.off,
        type: fix.kind === 'rel' ? R_X86_64_PC32
          : fix.kind === 'tpoff' ? R_X86_64_TPOFF32
            : R_X86_64_64,
        sym: idx,
        addend: fix.kind === 'rel' ? -4n : fix.kind === 'tpoff' ? 0n : BigInt(fix.addend ?? 0),
      });
    }
  }

  // Build output section list. Index 0 is the mandatory null section.
  /** @type {any[]} */
  const out = [{ name: '', type: SHT_NULL, flags: 0, align: 0, data: Buffer.alloc(0), size: 0, link: 0, info: 0, entsize: 0 }];
  /** @type {Map<object, {index: number, offset: number}>} */
  const secPlace = new Map();
  for (const entry of secList) {
    const key = entry.sec.name;
    const isBss = key === 'bss' || key.startsWith('bss.') || key.startsWith('.bss');
    const data = isBss ? Buffer.alloc(0) : Buffer.from(entry.sec.bytes);
    const index = out.length;
    out.push({
      name: entry.name,
      type: isBss ? SHT_NOBITS : SHT_PROGBITS,
      flags: sectionFlags(key),
      align: 16,
      data,
      size: entry.sec.bytes.length,
      link: 0,
      info: 0,
      entsize: 0,
    });
    secPlace.set(entry.sec, { index, offset: 0 });
  }

  // String tables.
  /** @type {Map<string, number>} */
  const strMap = new Map([['', 0]]);
  const strtab = [0];
  for (const sym of symbols) sym.name ? intern(sym.name, strMap, strtab) : null;

  const symtabIdx = out.length;
  out.push({
    name: '.symtab', type: SHT_SYMTAB, flags: 0, align: 8,
    data: Buffer.alloc(0), size: symbols.length * SYM_SIZE,
    link: symtabIdx + 1, info: firstGlobal, entsize: SYM_SIZE,
  });
  const strtabIdx = out.length;
  out.push({
    name: '.strtab', type: SHT_STRTAB, flags: 0, align: 1,
    data: Buffer.from(strtab), size: strtab.length, link: 0, info: 0, entsize: 0,
  });

  // One .rela.<section> for every section that needs patching.
  for (const entry of secList) {
    const list = relocs.get(entry.sec);
    if (!list || list.length === 0) continue;
    const bubble = Buffer.alloc(list.length * RELA_SIZE);
    list.forEach((rel, i) => {
      const base = i * RELA_SIZE;
      bubble.writeBigUInt64LE(BigInt(rel.off), base);
      bubble.writeBigUInt64LE((BigInt(rel.sym) << 32n) | BigInt(rel.type), base + 8);
      bubble.writeBigInt64LE(rel.addend, base + 16);
    });
    const target = secPlace.get(entry.sec).index;
    out.push({
      name: `.rela${entry.name}`, type: SHT_RELA, flags: 0, align: 8,
      data: bubble, size: bubble.length, link: symtabIdx, info: target, entsize: RELA_SIZE,
    });
  }

  // Build the section-name string table after every section (including the
  // relocation and symbol sections) is known, then append it as the final
  // section so its own name is part of the table too.
  /** @type {Map<string, number>} */
  const shstrMap = new Map([['', 0]]);
  const shstrtab = [0];
  for (const s of out) intern(s.name, shstrMap, shstrtab);
  const shstrIdx = out.length;
  intern('.shstrtab', shstrMap, shstrtab);
  out.push({
    name: '.shstrtab', type: SHT_STRTAB, flags: 0, align: 1,
    data: Buffer.from(shstrtab), size: shstrtab.length, link: 0, info: 0, entsize: 0,
  });

  // Patch the section names now that every section exists.
  for (const s of out) s.nameOff = shstrMap.get(s.name) ?? 0;

  // Lay the sections out in the file.
  let fileOff = EHDR_SIZE;
  for (const s of out) {
    if (s.type === SHT_NULL) continue;
    fileOff = alignUp(fileOff, Math.max(1, s.align));
    s.offset = fileOff;
    if (s.type !== SHT_NOBITS) fileOff += s.size;
  }
  const shoff = alignUp(fileOff, 8);
  const total = shoff + out.length * SHDR_SIZE;

  const img = Buffer.alloc(total);
  img.writeUInt8(0x7f, 0); img.writeUInt8(0x45, 1); img.writeUInt8(0x4c, 2); img.writeUInt8(0x46, 3);
  img.writeUInt8(2, 4); // ELFCLASS64
  img.writeUInt8(1, 5); // ELFDATA2LSB
  img.writeUInt8(1, 6); // EV_CURRENT
  img.writeUInt8(0, 7);
  img.writeUInt16LE(1, 16); // ET_REL
  img.writeUInt16LE(62, 18); // EM_X86_64
  img.writeUInt32LE(1, 20);
  img.writeBigUInt64LE(0n, 24); // e_entry
  img.writeBigUInt64LE(0n, 32); // e_phoff
  img.writeBigUInt64LE(BigInt(shoff), 40); // e_shoff
  img.writeUInt32LE(0, 48);
  img.writeUInt16LE(EHDR_SIZE, 52);
  img.writeUInt16LE(0, 54);
  img.writeUInt16LE(0, 56);
  img.writeUInt16LE(SHDR_SIZE, 58);
  img.writeUInt16LE(out.length, 60);
  img.writeUInt16LE(shstrIdx, 62);

  // Serialize the symbol table.
  const symtabData = Buffer.alloc(symbols.length * SYM_SIZE);
  symbols.forEach((sym, i) => {
    const base = i * SYM_SIZE;
    symtabData.writeUInt32LE(strMap.get(sym.name) ?? 0, base);
    symtabData.writeUInt8((sym.bind << 4) | sym.type, base + 4);
    symtabData.writeUInt8(0, base + 5);
    symtabData.writeUInt16LE(sym.shndx, base + 6);
    symtabData.writeBigUInt64LE(BigInt(sym.value), base + 8);
    symtabData.writeBigUInt64LE(BigInt(sym.size), base + 16);
  });
  out[symtabIdx].data = symtabData;

  for (const s of out) {
    if (s.type === SHT_NULL || s.type === SHT_NOBITS) continue;
    if (s.size > 0) s.data.copy(img, s.offset);
  }

  // Section header table.
  out.forEach((s, i) => {
    const base = shoff + i * SHDR_SIZE;
    img.writeUInt32LE(s.nameOff, base);
    img.writeUInt32LE(s.type, base + 4);
    img.writeBigUInt64LE(BigInt(s.flags), base + 8);
    img.writeBigUInt64LE(0n, base + 16);
    img.writeBigUInt64LE(BigInt(s.offset ?? 0), base + 24);
    img.writeBigUInt64LE(BigInt(s.size), base + 32);
    img.writeUInt32LE(s.link, base + 40);
    img.writeUInt32LE(s.info, base + 44);
    img.writeBigUInt64LE(BigInt(s.align), base + 48);
    img.writeBigUInt64LE(BigInt(s.entsize), base + 56);
  });

  return img;
}

export { R_X86_64_NONE, R_X86_64_64, R_X86_64_PC32 };
export default assembleObject;
