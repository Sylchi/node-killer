/**
 * Minimal ELF64 static linker.
 *
 * Consumes relocatable objects produced by `object.js` (and ordinary
 * `ld -r`-style objects from other compilers), resolves global symbols, pulls
 * the required members out of static archives, lays out a single loadable
 * segment and applies the x86_64 relocations. No host linker is involved.
 *
 * @module cc/link
 */

const BASE_ADDR = 0x400000;
const CONTENT_OFF = 0x1000;
const PAGE = 0x1000;

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

const STT_SECTION = 3;
const STT_FILE = 4;

const SHN_UNDEF = 0;
const SHN_ABS = 0xfff1;
const SHN_COMMON = 0xfff2;

const R_X86_64_NONE = 0;
const R_X86_64_64 = 1;
const R_X86_64_PC32 = 2;
const R_X86_64_PLT32 = 4;
const R_X86_64_GOTPCREL = 9;
const R_X86_64_32 = 10;
const R_X86_64_32S = 11;
const R_X86_64_TPOFF32 = 23;
const R_X86_64_TLSLD = 20;
const R_X86_64_DTPOFF32 = 21;
const R_X86_64_PC64 = 24;
const R_X86_64_GOTPCRELX = 41;
const R_X86_64_REX_GOTPCRELX = 42;

export class LinkError extends Error {}

/** @param {number} n @param {number} a */
function alignUp(n, a) {
  if (a <= 1) return n;
  return Math.ceil(n / a) * a;
}

/** @param {Buffer} buf @param {number} off */
function cstr(buf, off) {
  let end = off;
  while (end < buf.length && buf[end] !== 0) end += 1;
  return buf.toString('utf8', off, end);
}

/** @param {string} name @param {number} shType @param {number} flags */
function bucketOf(name, shType, flags) {
  if (flags & SHF_TLS) return 'tls';
  if (name === '.text' || name.startsWith('.text.')) return 'text';
  if (name === '.rodata' || name.startsWith('.rodata.')) return 'rodata';
  if (name === '.data' || name.startsWith('.data.')) return 'data';
  if (name === '.bss' || name.startsWith('.bss.')) return 'bss';
  if (shType === SHT_NOBITS) return 'bss';
  return null;
}

/** @param {number} type */
function isGotReloc(type) {
  return type === R_X86_64_GOTPCREL || type === R_X86_64_GOTPCRELX || type === R_X86_64_REX_GOTPCRELX;
}

/**
 * Parse an ET_REL object into sections, symbols and relocations.
 *
 * @param {Buffer} buf
 * @param {string} [name]
 */
export function parseObject(buf, name = '<object>') {
  if (buf.length < 64) throw new LinkError(`${name}: file is too short to be ELF`);
  if (buf.readUInt32BE(0) !== 0x7f454c46) throw new LinkError(`${name}: not an ELF file`);
  if (buf[4] !== 2 || buf[5] !== 1) throw new LinkError(`${name}: only 64-bit little-endian ELF is supported`);
  const type = buf.readUInt16LE(16);
  if (type !== 1) throw new LinkError(`${name}: expected a relocatable object (ET_REL), got type ${type}`);
  if (buf.readUInt16LE(18) !== 62) throw new LinkError(`${name}: not an x86-64 object`);

  let shoff = Number(buf.readBigUInt64LE(40));
  let shentsize = buf.readUInt16LE(58);
  let shnum = buf.readUInt16LE(60);
  let shstrndx = buf.readUInt16LE(62);
  if (shentsize === 0) shentsize = 64;
  if (shoff === 0) throw new LinkError(`${name}: object has no section headers`);

  /** @param {number} index */
  const readShdr = (index) => {
    const base = shoff + index * shentsize;
    if (base + 64 > buf.length) throw new LinkError(`${name}: truncated section header table`);
    return {
      nameOff: buf.readUInt32LE(base),
      type: buf.readUInt32LE(base + 4),
      flags: Number(buf.readBigUInt64LE(base + 8)),
      addr: Number(buf.readBigUInt64LE(base + 16)),
      offset: Number(buf.readBigUInt64LE(base + 24)),
      size: Number(buf.readBigUInt64LE(base + 32)),
      link: buf.readUInt32LE(base + 40),
      info: buf.readUInt32LE(base + 44),
      align: Number(buf.readBigUInt64LE(base + 48)),
      entsize: Number(buf.readBigUInt64LE(base + 56)),
    };
  };

  const first = readShdr(0);
  if (shnum === 0) shnum = first.size;
  if (shstrndx === 0xffff) shstrndx = first.link;

  /** @type {any[]} */
  const sections = [];
  for (let i = 0; i < shnum; i += 1) sections.push(readShdr(i));

  let names = Buffer.alloc(0);
  if (shstrndx < sections.length) {
    const ns = sections[shstrndx];
    names = buf.subarray(ns.offset, ns.offset + ns.size);
  }
  for (const s of sections) s.name = cstr(names, s.nameOff);

  // Decode every symbol table so relocation links can be followed.
  /** @type {Map<number, any[]>} */
  const symtabs = new Map();
  for (let i = 0; i < sections.length; i += 1) {
    const s = sections[i];
    if (s.type !== SHT_SYMTAB) continue;
    const strsec = sections[s.link];
    const strs = strsec ? buf.subarray(strsec.offset, strsec.offset + strsec.size) : Buffer.alloc(0);
    const entsize = s.entsize || 24;
    const count = Math.floor(s.size / entsize);
    /** @type {any[]} */
    const syms = [];
    for (let j = 0; j < count; j += 1) {
      const base = s.offset + j * entsize;
      const info = buf[base + 4];
      syms.push({
        name: cstr(strs, buf.readUInt32LE(base)),
        bind: info >>> 4,
        type: info & 0xf,
        shndx: buf.readUInt16LE(base + 6),
        value: Number(buf.readBigUInt64LE(base + 8)),
        size: Number(buf.readBigUInt64LE(base + 16)),
      });
    }
    symtabs.set(i, syms);
  }

  // Collect relocations by the section they patch.
  /** @type {Map<number, any[]>} */
  const relocs = new Map();
  for (const s of sections) {
    if (s.type !== SHT_RELA) continue;
    const syms = symtabs.get(s.link);
    if (!syms) continue;
    const entsize = s.entsize || 24;
    const count = Math.floor(s.size / entsize);
    let list = relocs.get(s.info);
    if (!list) { list = []; relocs.set(s.info, list); }
    for (let j = 0; j < count; j += 1) {
      const base = s.offset + j * entsize;
      const info = buf.readBigUInt64LE(base + 8);
      list.push({
        offset: Number(buf.readBigUInt64LE(base)),
        symIndex: Number(info >> 32n),
        type: Number(info & 0xffffffffn),
        addend: buf.readBigInt64LE(base + 16),
        symtab: s.link,
      });
    }
  }

  // Mark allocatable sections that belong in the output image.
  for (const s of sections) {
    const bucket = (s.flags & SHF_ALLOC) ? bucketOf(s.name, s.type, s.flags) : null;
    s.bucket = bucket;
    if (s.type !== SHT_NOBITS) {
      s.data = buf.subarray(s.offset, s.offset + s.size);
    } else {
      s.data = Buffer.alloc(0);
    }
  }

  // The primary symbol table is used for definition discovery.
  let primary = null;
  for (const [i, syms] of symtabs) { primary = { index: i, syms }; break; }

  return { name, sections, symtabs, relocs, symbols: primary ? primary.syms : [] };
}

/**
 * Parse a Unix (GNU/BSD) static archive.
 *
 * @param {Buffer} buf
 * @param {string} [name]
 */
export function parseArchive(buf, name = '<archive>') {
  if (buf.length < 8 || buf.toString('latin1', 0, 8) !== '!<arch>\n') {
    throw new LinkError(`${name}: not an ar archive`);
  }
  /** @type {{offset: number, name: string, data: Buffer}[]} */
  const members = [];
  /** @type {Map<string, number>} */
  const symbols = new Map();
  let longNames = null;
  let off = 8;

  while (off + 60 <= buf.length) {
    const header = buf.toString('latin1', off, off + 60);
    const size = parseInt(header.slice(48, 58).trim(), 10);
    if (!Number.isFinite(size) || size < 0) throw new LinkError(`${name}: bad archive member header`);
    const dataStart = off + 60;
    if (dataStart + size > buf.length) throw new LinkError(`${name}: truncated archive member`);
    let rawName = header.slice(0, 16).trim();
    let data = buf.subarray(dataStart, dataStart + size);

    if (rawName === '/' || rawName === '/SYM64/') {
      if (size >= 4) {
        const count = buf.readUInt32BE(dataStart);
        let p = dataStart + 4 + count * 4;
        for (let i = 0; i < count && p < dataStart + size; i += 1) {
          const sym = cstr(buf, p);
          p += sym.length + 1;
          const memberOff = buf.readUInt32BE(dataStart + 4 + i * 4);
          if (!symbols.has(sym)) symbols.set(sym, memberOff);
        }
      }
    } else if (rawName === '//') {
      longNames = data;
    } else {
      if (rawName.startsWith('/') && /^\d+$/.test(rawName.slice(1))) {
        const idx = parseInt(rawName.slice(1), 10);
        if (longNames && idx < longNames.length) {
          let end = idx;
          while (end < longNames.length && longNames[end] !== 0 && longNames[end] !== 0x0a) end += 1;
          let n = longNames.toString('utf8', idx, end);
          if (n.endsWith('/')) n = n.slice(0, -1);
          rawName = n;
        }
      } else if (rawName.startsWith('#1/')) {
        const len = parseInt(rawName.slice(3), 10);
        if (Number.isFinite(len) && len <= data.length) {
          rawName = data.toString('utf8', 0, len);
          data = data.subarray(len);
        }
      } else if (rawName.endsWith('/')) {
        rawName = rawName.slice(0, -1);
      }
      members.push({ offset: off, name: rawName, data });
    }
    off = dataStart + size;
    if (off % 2 === 1) off += 1;
  }

  /** @type {Map<number, {offset: number, name: string, data: Buffer}>} */
  const byOffset = new Map();
  for (const m of members) byOffset.set(m.offset, m);

  return { name, members, byOffset, symbols, buffer: buf };
}

class Linker {
  constructor() {
    /** @type {any[]} */
    this.objects = [];
    /** @type {Map<string, {obj: any, objIndex: number, symIndex: number, sym: any, kind: string}>} */
    this.global = new Map();
    /** @type {Set<string>} */
    this.needed = new Set();
    /** @type {Map<string, {size: number, align: number, bind: number}>} */
    this.commons = new Map();
    /** @type {any[]} */
    this.archives = [];
    /** @type {Set<string>} */
    this.loadedArchiveMembers = new Set();
    /** @type {Map<string, number>} GOT key -> byte offset in the GOT */
    this.got = new Map();
    /** @type {any} */
    this.gotObject = null;
    /** @type {any} */
    this.tlsIndexObject = null;
  }

  /**
   * @param {any} obj
   * @param {boolean} explicit
   */
  addObject(obj, explicit = true) {
    const objIndex = this.objects.length;
    obj.index = objIndex;
    obj.explicit = explicit;
    obj.placements = new Map();
    this.objects.push(obj);

    for (let symIndex = 0; symIndex < obj.symbols.length; symIndex += 1) {
      const sym = obj.symbols[symIndex];
      if (sym.bind !== STB_GLOBAL && sym.bind !== STB_WEAK) continue;
      if (sym.type === STT_SECTION || sym.type === STT_FILE) continue;

      if (sym.shndx === SHN_UNDEF) {
        if (sym.bind !== STB_WEAK) this.needed.add(sym.name);
        continue;
      }
      if (sym.shndx === SHN_COMMON) {
        const cur = this.commons.get(sym.name);
        const align = sym.value || 1;
        if (!cur) this.commons.set(sym.name, { size: sym.size, align, bind: sym.bind });
        else {
          cur.size = Math.max(cur.size, sym.size);
          cur.align = Math.max(cur.align, align);
        }
        continue;
      }
      if (sym.shndx === SHN_ABS) {
        this.define(sym.name, {
          obj, objIndex, symIndex, sym, kind: 'absolute',
        });
        continue;
      }
      const sec = obj.sections[sym.shndx];
      if (!sec || !sec.bucket) continue;
      this.define(sym.name, {
        obj, objIndex, symIndex, sym, kind: 'section',
      });
    }
  }

  /** @param {string} name @param {any} def */
  define(name, def) {
    const cur = this.global.get(name);
    if (!cur) { this.global.set(name, def); return; }
    const oldWeak = cur.sym.bind === STB_WEAK;
    const newWeak = def.sym.bind === STB_WEAK;
    if (!oldWeak && !newWeak) {
      throw new LinkError(`multiple definition of '${name}' (in ${cur.obj.name} and ${def.obj.name})`);
    }
    if (oldWeak && !newWeak) this.global.set(name, def);
  }

  /**
   * @param {any} archive
   */
  addArchive(archive) {
    this.archives.push(archive);
  }

  /**
   * Load every symbol table in an archive that lacks a ranlib index.
   * @param {any} archive
   */
  buildFallbackIndex(archive) {
    if (archive.symbols.size > 0) return;
    for (const m of archive.members) {
      if (m.data.length < 4 || m.data.readUInt32BE(0) !== 0x7f454c46) continue;
      try {
        const obj = parseObject(m.data, `${archive.name}(${m.name})`);
        for (const sym of obj.symbols) {
          if (sym.bind !== STB_GLOBAL && sym.bind !== STB_WEAK) continue;
          if (sym.shndx === SHN_UNDEF) continue;
          if (!archive.symbols.has(sym.name)) archive.symbols.set(sym.name, m.offset);
        }
      } catch {
        // Ignore non-object members.
      }
    }
  }

  pullArchives() {
    for (const archive of this.archives) this.buildFallbackIndex(archive);

    let changed = true;
    while (changed) {
      changed = false;
      for (const name of [...this.needed]) {
        if (this.global.has(name) || this.commons.has(name)) continue;
        for (const archive of this.archives) {
          const offset = archive.symbols.get(name);
          if (offset === undefined) continue;
          const key = `${archive.name}:${offset}`;
          if (this.loadedArchiveMembers.has(key)) continue;
          const member = archive.byOffset.get(offset);
          if (!member) continue;
          try {
            const obj = parseObject(member.data, `${archive.name}(${member.name})`);
            this.loadedArchiveMembers.add(key);
            this.addObject(obj, false);
            changed = true;
          } catch (error) {
            if (error instanceof LinkError) throw error;
            throw new LinkError(`${archive.name}(${member.name}): ${error.message}`);
          }
        }
      }
    }
  }

  allocateCommons() {
    if (this.commons.size === 0) return;
    const names = [...this.commons.keys()].sort((a, b) => {
      const ca = this.commons.get(a);
      const cb = this.commons.get(b);
      const byAlign = cb.align - ca.align;
      return byAlign !== 0 ? byAlign : a.localeCompare(b);
    });
    let size = 0;
    /** @type {Map<string, number>} */
    const offsets = new Map();
    for (const name of names) {
      const c = this.commons.get(name);
      size = alignUp(size, c.align || 1);
      offsets.set(name, size);
      size += c.size;
    }
    const symbols = [{
      name: '', bind: STB_LOCAL, type: 0, shndx: 0, value: 0, size: 0,
    }];
    for (const name of names) {
      const c = this.commons.get(name);
      symbols.push({
        name, bind: c.bind, type: 1, shndx: 1, value: offsets.get(name), size: c.size,
      });
      this.global.set(name, {
        obj: { name: '<common>' }, objIndex: -1, symIndex: symbols.length - 1,
        sym: symbols[symbols.length - 1], kind: 'common',
      });
    }
    const sec = {
      name: '.bss', type: SHT_NOBITS, flags: SHF_ALLOC | SHF_WRITE, align: 16,
      size, data: Buffer.alloc(0), bucket: 'bss',
    };
    this.objects.push({
      name: '<common>', index: this.objects.length, explicit: false,
      sections: [null, sec], symtabs: new Map(), relocs: new Map(),
      symbols, placements: new Map(),
    });
  }

  /**
   * Key that identifies a GOT entry. Global symbols share one slot; local
   * definitions are per-object because their addresses differ.
   * @param {any} obj @param {any} rel @param {any} sym
   */
  gotKey(obj, rel, sym) {
    if (sym.bind === STB_LOCAL && sym.shndx !== SHN_UNDEF) {
      return `l:${obj.index}:${rel.symIndex}:${sym.name}`;
    }
    return `g:${sym.name}`;
  }

  /**
   * Allocate a slot for every GOT-relative reference so the relocation can
   * load an absolute address out of the .got section.
   */
  allocateGot() {
    /** @type {{key: string, sym: any}[]} */
    const entries = [];
    const seen = new Set();
    for (const obj of this.objects) {
      for (const [, list] of obj.relocs) {
        for (const rel of list) {
          if (!isGotReloc(rel.type)) continue;
          const tab = obj.symtabs.get(rel.symtab);
          const sym = tab && tab[rel.symIndex];
          if (!sym || sym.name === '_GLOBAL_OFFSET_TABLE_') continue;
          const key = this.gotKey(obj, rel, sym);
          if (seen.has(key)) continue;
          seen.add(key);
          entries.push({ key, sym });
        }
      }
    }
    if (entries.length === 0) return;

    entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (let i = 0; i < entries.length; i += 1) this.got.set(entries[i].key, i * 8);

    const size = entries.length * 8;
    const sec = {
      name: '.got', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_WRITE, align: 8, size, data: Buffer.alloc(size), bucket: 'data',
    };
    this.gotObject = {
      name: '<got>',
      index: this.objects.length,
      explicit: false,
      sections: [null, sec],
      symtabs: new Map(),
      relocs: new Map(),
      symbols: [],
      placements: new Map(),
    };
    this.objects.push(this.gotObject);
  }

  /**
   * Allocate the `struct tls_index` used by local-dynamic TLS code. The
   * executable is module 1 with offset 0; per-symbol `DTPOFF32` relocations
   * provide the offset within that module.
   */
  allocateTlsIndex() {
    let needsIndex = false;
    for (const obj of this.objects) {
      for (const [, list] of obj.relocs) {
        if (list.some((rel) => rel.type === R_X86_64_TLSLD)) { needsIndex = true; break; }
      }
      if (needsIndex) break;
    }
    if (!needsIndex) return;

    const data = Buffer.alloc(16);
    data.writeBigUInt64LE(1n, 0); // ti_module
    data.writeBigUInt64LE(0n, 8); // ti_offset
    const sec = {
      name: '.tls_index', type: SHT_PROGBITS, flags: SHF_ALLOC | SHF_WRITE, align: 8, size: 16, data, bucket: 'data',
    };
    this.tlsIndexObject = {
      name: '<tls_index>',
      index: this.objects.length,
      explicit: false,
      sections: [null, sec],
      symtabs: new Map(),
      relocs: new Map(),
      symbols: [],
      placements: new Map(),
    };
    this.objects.push(this.tlsIndexObject);
  }

  layout() {
    const buckets = {
      text: { name: '.text', flags: SHF_ALLOC | SHF_EXECINSTR, align: 16, size: 0, chunks: [], base: 0 },
      rodata: { name: '.rodata', flags: SHF_ALLOC, align: 16, size: 0, chunks: [], base: 0 },
      data: { name: '.data', flags: SHF_ALLOC | SHF_WRITE, align: 16, size: 0, chunks: [], base: 0 },
      tls: { name: '.tls', flags: SHF_ALLOC | SHF_WRITE | SHF_TLS, align: 16, size: 0, chunks: [], base: 0 },
      bss: { name: '.bss', flags: SHF_ALLOC | SHF_WRITE, align: 16, size: 0, chunks: [], base: 0 },
    };

    for (const obj of this.objects) {
      obj.placements = new Map();
      for (let i = 1; i < obj.sections.length; i += 1) {
        const sec = obj.sections[i];
        if (!sec || !sec.bucket) continue;
        const bucket = buckets[sec.bucket];
        const align = Math.max(1, sec.align || 1);
        const offset = alignUp(bucket.size, align);
        obj.placements.set(i, { bucket: sec.bucket, offset });
        bucket.size = offset + sec.size;
        if (sec.bucket !== 'bss' && sec.data && sec.data.length > 0) {
          bucket.chunks.push({ offset, data: sec.data });
        }
      }
    }

    let cursor = BASE_ADDR + CONTENT_OFF;
    for (const key of ['text', 'rodata', 'data', 'tls']) {
      const bucket = buckets[key];
      cursor = alignUp(cursor, PAGE);
      bucket.base = cursor;
      bucket.data = Buffer.alloc(bucket.size);
      for (const chunk of bucket.chunks) chunk.data.copy(bucket.data, chunk.offset);
      cursor += bucket.size;
    }
    cursor = alignUp(cursor, PAGE);
    buckets.bss.base = cursor;
    cursor += buckets.bss.size;

    const tlsBase = buckets.tls.base;
    const tlsSize = alignUp(buckets.tls.size, 16);
    const imageEnd = cursor;
    const filesz = buckets.tls.base + buckets.tls.size - (BASE_ADDR + CONTENT_OFF);
    const memsz = imageEnd - (BASE_ADDR + CONTENT_OFF);
    return {
      buckets, filesz, memsz, tlsBase, tlsSize, tlsTp: tlsBase + tlsSize,
    };
  }

  /** @param {any} layout */
  resolveAddresses(layout) {
    const { buckets } = layout;
    for (const obj of this.objects) {
      for (const [secIndex, place] of obj.placements) {
        const syms = obj.symbols;
        for (const sym of syms) {
          if (sym.shndx !== secIndex) continue;
          sym.address = buckets[place.bucket].base + place.offset + sym.value;
        }
      }
    }
    for (const [name, def] of this.global) {
      if (def.kind === 'section') {
        def.address = def.sym.address;
      } else if (def.kind === 'absolute') {
        def.address = def.sym.value;
      } else if (def.kind === 'common') {
        // The common object's symbols were assigned addresses above.
        def.address = def.sym.address;
      }
    }
  }

  /** @param {any} layout */
  applyRelocations(layout) {
    const { buckets } = layout;

    /** @param {any} obj @param {number} symtabIndex @param {number} symIndex */
    const symbolOf = (obj, symtabIndex, symIndex) => {
      const tab = obj.symtabs.get(symtabIndex);
      if (!tab || symIndex >= tab.length) throw new LinkError(`${obj.name}: bad relocation symbol index`);
      return tab[symIndex];
    };

    for (const obj of this.objects) {
      for (const [targetIndex, list] of obj.relocs) {
        const targetSec = obj.sections[targetIndex];
        if (!targetSec || !targetSec.bucket) continue;
        const targetPlace = obj.placements.get(targetIndex);
        if (!targetPlace) continue;
        const target = buckets[targetPlace.bucket];
        for (const rel of list) {
          const sym = symbolOf(obj, rel.symtab, rel.symIndex);
          let S;
          if (sym.shndx === SHN_UNDEF) {
            const def = this.global.get(sym.name);
            if (!def) {
              if (sym.bind === STB_WEAK) S = 0n;
              else throw new LinkError(`undefined reference to '${sym.name}' (in ${obj.name})`);
            } else {
              S = BigInt(def.address ?? 0);
            }
          } else if (sym.shndx === SHN_ABS) {
            S = BigInt(sym.value);
          } else if (sym.shndx === SHN_COMMON) {
            const def = this.global.get(sym.name);
            if (!def) throw new LinkError(`unallocated common symbol '${sym.name}'`);
            S = BigInt(def.address);
          } else {
            const place = obj.placements.get(sym.shndx);
            if (place) {
              S = BigInt(buckets[place.bucket].base + place.offset + sym.value);
            }
            // ELF binds every reference by name, not by the definition in the
            // referring object: a strong definition elsewhere overrides a
            // weak one here (musl's lite_malloc `malloc` -> strong mallocng
            // `__libc_malloc_impl`).
            if (sym.bind === STB_GLOBAL || sym.bind === STB_WEAK) {
              const def = this.global.get(sym.name);
              if (def && def.address !== undefined) S = BigInt(def.address);
            }
            if (!place) throw new LinkError(`${obj.name}: relocation targets a discarded section`);
          }
          const P = BigInt(target.base + targetPlace.offset + rel.offset);
          const A = rel.addend;
          const value = S + A;

          const patch = (bytes) => {
            for (let i = 0; i < bytes.length; i += 1) target.data[targetPlace.offset + rel.offset + i] = bytes[i];
          };
          const u32 = (v) => {
            const x = BigInt.asUintN(32, v);
            return [Number(x & 0xffn), Number((x >> 8n) & 0xffn), Number((x >> 16n) & 0xffn), Number((x >> 24n) & 0xffn)];
          };
          const u64 = (v) => {
            const x = BigInt.asUintN(64, v);
            const out = [];
            for (let i = 0; i < 8; i += 1) out.push(Number((x >> BigInt(8 * i)) & 0xffn));
            return out;
          };
          /**
           * GOT slot address, creating the absolute-address entry on first use.
           * @returns {bigint}
           */
          const gotSlot = () => {
            if (!this.gotObject) throw new LinkError(`${obj.name}: GOT reference without a GOT`);
            const key = this.gotKey(obj, rel, sym);
            const slot = this.got.get(key);
            if (slot === undefined) throw new LinkError(`${obj.name}: missing GOT entry for '${sym.name}'`);
            const place = this.gotObject.placements.get(1);
            if (!place) throw new LinkError('GOT section was discarded');
            const bucket = buckets[place.bucket];
            const at = place.offset + slot;
            const bytes = u64(S);
            for (let i = 0; i < 8; i += 1) bucket.data[at + i] = bytes[i];
            return BigInt(bucket.base + at);
          };

          switch (rel.type) {
            case R_X86_64_NONE:
              break;
            case R_X86_64_64:
              patch(u64(value));
              break;
            case R_X86_64_PC32:
            case R_X86_64_PLT32: {
              const d = value - P;
              if (d < -2147483648n || d > 2147483647n) {
                throw new LinkError(`${obj.name}: PC-relative relocation overflow for '${sym.name}'`);
              }
              patch(u32(d));
              break;
            }
            case R_X86_64_GOTPCREL:
            case R_X86_64_GOTPCRELX:
            case R_X86_64_REX_GOTPCRELX: {
              const G = gotSlot();
              patch(u32(G + A - P));
              break;
            }
            case R_X86_64_32:
              patch(u32(value));
              break;
            case R_X86_64_32S:
              if (value < -2147483648n || value > 2147483647n) {
                throw new LinkError(`${obj.name}: 32-bit relocation overflow for '${sym.name}'`);
              }
              patch(u32(value));
              break;
            case R_X86_64_PC64:
              patch(u64(value - P));
              break;
            case R_X86_64_TPOFF32: {
              // Variant II static TLS: the thread pointer sits just past the
              // end of the executable's TLS block, so offsets are negative.
              const d = value - BigInt(layout.tlsTp);
              if (d < -2147483648n || d > 2147483647n) {
                throw new LinkError(`${obj.name}: TLS offset overflow for '${sym.name}'`);
              }
              patch(u32(d));
              break;
            }
            case R_X86_64_DTPOFF32: {
              const d = value - BigInt(layout.tlsBase);
              patch(u32(d));
              break;
            }
            case R_X86_64_TLSLD: {
              // Local-dynamic model: point the lea at a tls_index pair that
              // names the executable's own TLS module (index 1).
              const place = this.tlsIndexObject.placements.get(1);
              if (!place) throw new LinkError('TLS index section was discarded');
              const bucket = buckets[place.bucket];
              const at = BigInt(bucket.base + place.offset);
              patch(u32(at - P));
              break;
            }
            default:
              throw new LinkError(`${obj.name}: unsupported relocation type ${rel.type} for '${sym.name}'`);
          }
        }
      }
    }
  }

  /** @param {any} layout */
  emit(layout) {
    const { buckets, filesz, memsz } = layout;
    const entryDef = this.global.get('_start') || this.global.get('main');
    if (!entryDef) throw new LinkError('no entry point: neither _start nor main is defined');
    const entry = BigInt(entryDef.address);

    const total = CONTENT_OFF + Math.max(0, filesz);
    const hasTls = buckets.tls.size > 0;
    const phnum = hasTls ? 2 : 1;
    const img = Buffer.alloc(total);
    img.writeUInt8(0x7f, 0); img.writeUInt8(0x45, 1); img.writeUInt8(0x4c, 2); img.writeUInt8(0x46, 3);
    img.writeUInt8(2, 4); img.writeUInt8(1, 5); img.writeUInt8(1, 6); img.writeUInt8(0, 7);
    img.writeUInt16LE(2, 16); // ET_EXEC
    img.writeUInt16LE(62, 18);
    img.writeUInt32LE(1, 20);
    img.writeBigUInt64LE(entry, 24);
    img.writeBigUInt64LE(64n, 32); // e_phoff
    img.writeBigUInt64LE(0n, 40); // e_shoff
    img.writeUInt32LE(0, 48);
    img.writeUInt16LE(64, 52);
    img.writeUInt16LE(56, 54);
    img.writeUInt16LE(phnum, 56);
    img.writeUInt16LE(64, 58);
    img.writeUInt16LE(0, 60);
    img.writeUInt16LE(0, 62);

    img.writeUInt32LE(1, 64); // PT_LOAD
    img.writeUInt32LE(7, 68); // R+W+X
    // Cover the ELF header and program headers too: the kernel only reports a
    // non-zero AT_PHDR when the first load segment starts at file offset 0.
    img.writeBigUInt64LE(0n, 72);
    img.writeBigUInt64LE(BigInt(BASE_ADDR), 80);
    img.writeBigUInt64LE(BigInt(BASE_ADDR), 88);
    img.writeBigUInt64LE(BigInt(CONTENT_OFF + filesz), 96);
    img.writeBigUInt64LE(BigInt(CONTENT_OFF + memsz), 104);
    img.writeBigUInt64LE(BigInt(PAGE), 112);

    if (hasTls) {
      // PT_TLS: musl's static __init_tls copies this image into the thread
      // block and installs %fs, so TP = tlsBase + tlsSize matches the
      // negative TPOFF32 offsets used by the rest of the image.
      img.writeUInt32LE(7, 120); // PT_TLS
      img.writeUInt32LE(4, 124); // R
      img.writeBigUInt64LE(BigInt(layout.tlsBase - BASE_ADDR), 128);
      img.writeBigUInt64LE(BigInt(layout.tlsBase), 136);
      img.writeBigUInt64LE(BigInt(layout.tlsBase), 144);
      img.writeBigUInt64LE(BigInt(buckets.tls.size), 152);
      img.writeBigUInt64LE(BigInt(layout.tlsSize), 160);
      img.writeBigUInt64LE(16n, 168);
    }

    for (const key of ['text', 'rodata', 'data', 'tls']) {
      const bucket = buckets[key];
      if (!bucket.data || bucket.data.length === 0) continue;
      const dest = bucket.base - BASE_ADDR;
      bucket.data.copy(img, dest);
    }
    return { bytes: img, entry };
  }
}

const STARTUP_ASM = [
  '\t.text',
  '\t.globl\t_start',
  '_start:',
  // crt1-style entry: musl's __libc_start_main runs __init_libc (page size,
  // environ, TLS, stack canary) before calling main.
  '\txorl\t%ebp, %ebp',
  '\tmovq\t%rdx, %r9', // rtld_fini
  '\tpopq\t%rsi', // argc
  '\tmovq\t%rsp, %rdx', // argv
  '\tandq\t$-16, %rsp',
  '\tpushq\t%rax', // padding
  '\tpushq\t%rsp', // stack_end (unused by musl)
  '\txorl\t%r8d, %r8d', // fini
  '\txorl\t%ecx, %ecx', // init
  '\tleaq\tmain(%rip), %rdi',
  '\tcall\t__libc_start_main',
  '\thlt',
  '',
].join('\n');

/**
 * Link objects and static archives into a runnable ELF executable.
 *
 * @param {{objects?: {name: string, data: Buffer}[], archives?: {name: string, data: Buffer}[], startup?: boolean}} input
 * @returns {{bytes: Buffer, entry: bigint, linker: Linker}}
 */
export function link({ objects = [], archives = [], startup = true }) {
  const linker = new Linker();
  /** @type {any[]} */
  const parsedObjects = [];

  for (const input of archives) {
    linker.addArchive(parseArchive(input.data, input.name));
  }
  for (const input of objects) {
    parsedObjects.push(parseObject(input.data, input.name));
  }

  const explicitlyDefinesStart = parsedObjects.some((obj) =>
    obj.symbols.some((s) => s.name === '_start' && s.shndx !== SHN_UNDEF && (s.bind === STB_GLOBAL || s.bind === STB_WEAK)));

  if (startup && !explicitlyDefinesStart) {
    // Lazily import to avoid a module cycle at load time.
    const { assembleObject } = requireObjectModule();
    const startupObj = parseObject(assembleObject(STARTUP_ASM), '<startup>');
    parsedObjects.unshift(startupObj);
  }

  for (const obj of parsedObjects) linker.addObject(obj, true);

  linker.pullArchives();
  linker.allocateCommons();
  linker.allocateGot();
  linker.allocateTlsIndex();

  const layout = linker.layout();

  const missing = [...linker.needed]
    .filter((name) => !linker.global.has(name))
    // GCC emits this symbol for position-independent code; all GOT references
    // are relaxed to direct addresses in a static executable.
    .filter((name) => name !== '_GLOBAL_OFFSET_TABLE_');
  if (missing.length > 0) {
    throw new LinkError(`undefined symbols: ${missing.join(', ')}`);
  }

  linker.resolveAddresses(layout);
  linker.applyRelocations(layout);
  if (process.env.CC_SYMS) {
    for (const [name, def] of linker.global) console.error(`${name} 0x${(def.address ?? 0).toString(16)}`);
    if (process.env.CC_SYMS === 'all') {
      for (const obj of linker.objects) {
        for (const sym of obj.symbols || []) {
          if (sym.address !== undefined && sym.name) console.error(`${sym.name} 0x${sym.address.toString(16)} ${sym.type} ${sym.bind}`);
        }
      }
    }
  }
  const out = linker.emit(layout);
  return { ...out, linker };
}

/**
 * `object.js` imports `elf.js`; importing it directly here is fine, but the
 * dynamic import keeps the linker usable from environments that only need
 * parsing. The synchronous helper below mirrors that tiny wrapper.
 * @returns {{assembleObject: Function}}
 */
function requireObjectModule() {
  // eslint-disable-next-line global-require
  return objectModule;
}

import * as objectModule from './object.js';

export default link;
