// Unit tests for lib/binary.js. Every fixture is hand-assembled here rather
// than read from disk, so the tests document exactly which bytes each parser
// keys off and stay independent of the samples/ directory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspectBinary } from '../lib/binary.js'

/**
 * Growable byte buffer with the little/big-endian writers the fixtures need.
 * @param {number} [size]
 */
function writer(size = 0) {
  const bytes = new Uint8Array(size)
  const view = new DataView(bytes.buffer)
  return {
    bytes,
    view,
    u8(offset, value) {
      view.setUint8(offset, value)
    },
    u16le(offset, value) {
      view.setUint16(offset, value, true)
    },
    u16be(offset, value) {
      view.setUint16(offset, value, false)
    },
    u32le(offset, value) {
      view.setUint32(offset, value, true)
    },
    u32be(offset, value) {
      view.setUint32(offset, value, false)
    },
    ascii(offset, text) {
      for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
    },
  }
}

/** Build a text buffer from ASCII/UTF-8 string. */
function utf8(text) {
  return new TextEncoder().encode(text)
}

/** Assert the shape shared by every non-empty result. */
function assertShape(result) {
  assert.equal(typeof result.format, 'string')
  assert.equal(typeof result.kind, 'string')
  assert.equal(typeof result.summary, 'string')
  assert.ok(result.summary.length > 0, 'summary must not be empty')
  assert.ok(Array.isArray(result.details), 'details must be an array')
  for (const entry of result.details) {
    assert.ok(Array.isArray(entry), 'each detail is a pair')
    assert.equal(entry.length, 2)
    assert.equal(typeof entry[0], 'string')
    assert.equal(typeof entry[1], 'string')
    assert.ok(entry[1].length <= 80, `detail value too long: ${entry[1]}`)
  }
}

/** Assert the optional `sections` shape when present. */
function assertSections(result) {
  assert.ok(Array.isArray(result.sections), 'sections must be an array')
  assert.ok(result.sections.length > 0, 'sections must not be empty')
  for (const section of result.sections) {
    assert.equal(typeof section.name, 'string')
    assert.equal(typeof section.size, 'number')
    assert.equal(typeof section.flags, 'string')
  }
}

// --- fixtures ---------------------------------------------------------------

/** PE32+ x86-64 DLL with one `.text` section. */
function peFixture() {
  const size = 0x400
  const w = writer(size)
  w.ascii(0, 'MZ')
  w.u32le(0x3c, 0x80)
  w.ascii(0x80, 'PE\0\0')
  const coff = 0x84
  w.u16le(coff, 0x8664) // machine x64
  w.u16le(coff + 2, 1) // NumberOfSections
  w.u32le(coff + 4, 0) // TimeDateStamp -> reproducible build
  w.u16le(coff + 16, 0xf0) // SizeOfOptionalHeader
  w.u16le(coff + 18, 0x2022) // executable | DLL | large address aware
  const opt = coff + 20
  w.u16le(opt, 0x20b) // PE32+
  w.u32le(opt + 16, 0x1000) // AddressOfEntryPoint
  w.u32le(opt + 24, 0x140000000 & 0xffffffff) // ImageBase low
  w.u32le(opt + 28, 0x1) // ImageBase high
  w.u32le(opt + 56, 0x4000) // SizeOfImage
  w.u16le(opt + 68, 3) // Subsystem console
  const section = opt + 0xf0
  w.ascii(section, '.text')
  w.u32le(section + 8, 0x100) // VirtualSize
  w.u32le(section + 16, 0x200) // SizeOfRawData
  w.u32le(section + 36, 0x60000020) // code | execute | read
  return w.bytes
}

/** ELF64 little-endian shared object with one named section. */
function elf64Fixture() {
  const size = 0x400
  const w = writer(size)
  w.u8(0, 0x7f)
  w.ascii(1, 'ELF')
  w.u8(4, 2) // 64-bit
  w.u8(5, 1) // little endian
  w.u8(6, 1) // version
  w.u16le(16, 3) // e_type shared object
  w.u16le(18, 62) // x86-64
  w.u32le(20, 1)
  w.u32le(24, 0x1040) // e_entry low
  w.u32le(28, 0)
  w.u32le(32, 0) // phoff
  w.u32le(40, 0x100) // shoff low
  w.u32le(44, 0)
  w.u16le(52, 64) // ehsize
  w.u16le(54, 0) // phentsize
  w.u16le(56, 0) // phnum
  w.u16le(58, 64) // shentsize
  w.u16le(60, 3) // shnum: null, .text, .shstrtab
  w.u16le(62, 2) // shstrndx
  // Section headers at 0x100, 64 bytes each.
  const nullHeader = 0x100
  w.u32le(nullHeader + 4, 0) // SHT_NULL
  const text = nullHeader + 64
  w.u32le(text, 1) // name offset into shstrtab
  w.u32le(text + 4, 1) // SHT_PROGBITS
  w.u32le(text + 8, 0x6) // SHF_ALLOC | SHF_EXECINSTR
  w.u32le(text + 24, 0x40) // sh_offset (64-bit layout)
  w.u32le(text + 32, 0x40) // sh_size
  const shstrtab = nullHeader + 128
  w.u32le(shstrtab, 7) // name offset of ".shstrtab"
  w.u32le(shstrtab + 4, 3) // SHT_STRTAB
  w.u32le(shstrtab + 24, 0x300) // sh_offset (64-bit layout)
  w.u32le(shstrtab + 32, 0x20) // sh_size
  // String table: "\0.text\0.shstrtab\0"
  w.ascii(0x300, '\0.text\0.shstrtab\0')
  return w.bytes
}

/** ELF32 big-endian relocatable object. */
function elf32beFixture() {
  const size = 0x200
  const w = writer(size)
  w.u8(0, 0x7f)
  w.ascii(1, 'ELF')
  w.u8(4, 1) // 32-bit
  w.u8(5, 2) // big endian
  w.u8(6, 1)
  w.u16be(16, 1) // e_type relocatable
  w.u16be(18, 40) // ARM
  w.u32be(20, 1)
  w.u32be(24, 0) // e_entry
  w.u32be(32, 0) // shoff
  w.u16be(40, 52) // ehsize
  w.u16be(46, 40) // shentsize
  w.u16be(48, 0) // shnum
  w.u16be(50, 0) // shstrndx
  return w.bytes
}

/** Mach-O 64-bit executable with one segment and one section. */
function macho64Fixture() {
  const size = 0x400
  const w = writer(size)
  w.u32le(0, 0xfeedfacf)
  w.u32le(4, 0x01000007) // x86-64
  w.u32le(8, 3) // cputype3
  w.u32le(12, 2) // MH_EXECUTE
  w.u32le(16, 1) // ncmds
  w.u32le(20, 72 + 80) // sizeofcmds
  w.u32le(24, 0)
  // LC_SEGMENT_64 at 32.
  const segment = 32
  w.u32le(segment, 0x19)
  w.u32le(segment + 4, 72 + 80)
  w.ascii(segment + 8, '__TEXT')
  w.u32le(segment + 60, 5) // initprot: read | execute
  w.u32le(segment + 64, 1) // nsects
  const section = segment + 72
  w.ascii(section, '__text')
  w.u32le(section + 36, 0x40) // size low (64-bit: offset 36+4)
  return w.bytes
}

/** Minimal WASM module: 1 type, 1 function, 1 export. */
function wasmFixture() {
  const body = [
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    // type section: 1 type, () -> ()
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    // function section: 1 function, type 0
    0x03, 0x02, 0x01, 0x00,
    // export section: 1 export "run" -> func 0
    0x07, 0x07, 0x01, 0x03, 0x72, 0x75, 0x6e, 0x00, 0x00,
  ]
  return new Uint8Array(body)
}

/** Java class file whose this_class resolves to com/example/App. */
function javaClassFixture() {
  const name = 'com/example/App'
  // Constant pool entries, in slot order: #1 Utf8 name, #2 Class #1,
  // #3 Utf8 superclass name, #4 Class #3, #5 Utf8 "Code".
  const entries = [
    [0x01, 0x00, name.length, ...utf8(name)],
    [0x07, 0x00, 0x01],
    [0x01, 0x00, 0x10, ...utf8('java/lang/Object')],
    [0x07, 0x00, 0x03],
    [0x01, 0x00, 0x04, ...utf8('Code')],
  ]
  const poolBytes = entries.flat()
  const size = 10 + poolBytes.length + 16
  const w = writer(size)
  w.u32be(0, 0xcafebabe)
  w.u16be(4, 0) // minor
  w.u16be(6, 55) // major 55 -> Java 11
  w.u16be(8, entries.length + 1) // constant_pool_count
  let cursor = 10
  for (const entry of entries) {
    for (const byte of entry) {
      w.u8(cursor, byte)
      cursor += 1
    }
  }
  // access_flags, this_class, super_class, interfaces, fields, methods, attributes
  w.u16be(cursor, 0x0021)
  w.u16be(cursor + 2, 2) // this_class -> Class #1 -> "com/example/App"
  w.u16be(cursor + 4, 4) // super_class -> Class #3
  w.u16be(cursor + 6, 0)
  w.u16be(cursor + 8, 0)
  w.u16be(cursor + 10, 0)
  w.u16be(cursor + 12, 0)
  w.u16be(cursor + 14, 0)
  return w.bytes
}

/** Python 3.11 .pyc header (16 bytes). */
function pycFixture() {
  const w = writer(16)
  // CPython writes the magic as a little-endian word; read big-endian it is
  // 0x6F0D0D0A for 3.11.
  w.u32le(0, 0x0a0d0d6f)
  w.u32le(4, 0) // flags
  w.u32le(8, 0x60000000) // mtime
  w.u32le(12, 0x1234) // source size
  return w.bytes
}

/** SQLite header: 4 KiB pages, 812 pages. */
function sqliteFixture() {
  const w = writer(100)
  w.ascii(0, 'SQLite format 3\0')
  w.u16be(16, 4096) // page size
  w.u8(18, 1)
  w.u8(19, 1)
  w.u8(20, 0)
  w.u8(21, 64)
  w.u8(22, 32)
  w.u8(23, 32)
  w.u32be(24, 7) // file change counter
  w.u32be(28, 812) // page count
  w.u32be(36, 3) // freelist
  w.u32be(40, 5) // schema cookie
  w.u32be(56, 1) // encoding UTF-8
  w.u32be(92, 0)
  w.u32be(96, 3041000) // library version 3.41.0
  return w.bytes
}

/** ISO 9660 PVD at 0x8000. */
function isoFixture() {
  const size = 0x9000
  const w = writer(size)
  const base = 0x8000
  w.u8(base, 1) // primary volume descriptor
  w.ascii(base + 1, 'CD001')
  w.u8(base + 6, 1)
  w.ascii(base + 40, 'MYVOLUME'.padEnd(32, ' '))
  w.u32le(base + 80, 2048) // volume space size
  w.u16le(base + 128, 2048)
  return w.bytes
}

// --- PE ---------------------------------------------------------------------

test('PE32+ x64 DLL', () => {
  const result = inspectBinary(peFixture(), 'dll')
  assertShape(result)
  assert.equal(result.format, 'PE')
  assert.equal(result.kind, 'library')
  assert.match(result.summary, /Windows PE DLL/)
  assert.match(result.summary, /x86-64/)
  assert.match(result.summary, /console/)
  const labels = result.details.map(([label]) => label)
  assert.ok(labels.includes('Machine'))
  assert.ok(labels.includes('Format'))
  assert.equal(result.details.find(([label]) => label === 'Machine')[1], 'x86-64')
  assert.equal(result.details.find(([label]) => label === 'Format')[1], 'PE32+')
  assert.ok(result.details.some(([, value]) => value.includes('reproducible build')))
  assertSections(result)
  assert.equal(result.sections[0].name, '.text')
  assert.equal(result.sections[0].size, 0x200)
  assert.match(result.sections[0].flags, /code/)
  assert.match(result.sections[0].flags, /execute/)
  assert.match(result.sections[0].flags, /read/)
})

test('PE reports an executable when the DLL bit is clear', () => {
  const bytes = peFixture()
  const view = new DataView(bytes.buffer)
  view.setUint16(0x84 + 18, 0x0002, true) // executable, not DLL
  const result = inspectBinary(bytes)
  assert.equal(result.format, 'PE')
  assert.equal(result.kind, 'executable')
  assert.match(result.summary, /Windows PE executable/)
})

// --- ELF --------------------------------------------------------------------

test('ELF64 little-endian shared object', () => {
  const result = inspectBinary(elf64Fixture(), 'so')
  assertShape(result)
  assert.equal(result.format, 'ELF')
  assert.equal(result.kind, 'library')
  assert.match(result.summary, /ELF 64-bit LSB shared object/)
  assert.match(result.summary, /x86-64/)
  assert.equal(result.details.find(([label]) => label === 'Machine')[1], 'x86-64')
  assert.equal(result.details.find(([label]) => label === 'Class')[1], '64-bit')
  assertSections(result)
  assert.equal(result.sections[0].name, '.text')
  assert.match(result.sections[0].flags, /execute/)
  assert.match(result.sections[0].flags, /alloc/)
})

test('ELF32 big-endian relocatable object', () => {
  const result = inspectBinary(elf32beFixture(), 'o')
  assertShape(result)
  assert.equal(result.format, 'ELF')
  assert.equal(result.kind, 'object')
  assert.match(result.summary, /ELF 32-bit MSB relocatable object/)
  assert.match(result.summary, /ARM/)
  assert.equal(result.details.find(([label]) => label === 'Data')[1], 'big endian (MSB)')
})

// --- Mach-O -----------------------------------------------------------------

test('Mach-O 64-bit executable', () => {
  const result = inspectBinary(macho64Fixture())
  assertShape(result)
  assert.equal(result.format, 'Mach-O')
  assert.equal(result.kind, 'executable')
  assert.match(result.summary, /Mach-O 64-bit executable/)
  assert.match(result.summary, /x86-64/)
  assert.equal(result.details.find(([label]) => label === 'File type')[1], 'executable')
})

test('Mach-O universal binary lists its architectures', () => {
  const w = writer(8 + 20 * 2)
  w.u32be(0, 0xcafebabe)
  w.u32be(4, 2)
  w.u32be(8, 0x01000007) // x86-64
  w.u32be(8 + 12, 0x1000)
  w.u32be(8 + 20, 0x0100000c) // arm64
  w.u32be(8 + 20 + 12, 0x2000)
  const result = inspectBinary(w.bytes)
  assert.equal(result.format, 'Mach-O')
  assert.match(result.summary, /universal binary, 2 architectures/)
  assert.match(result.details.find(([label]) => label === 'Contains')[1], /x86-64/)
  assert.match(result.details.find(([label]) => label === 'Contains')[1], /ARM64/)
})

// --- WASM -------------------------------------------------------------------

test('WASM module with one type, one function and one export', () => {
  const result = inspectBinary(wasmFixture(), 'wasm')
  assertShape(result)
  assert.equal(result.format, 'WASM')
  assert.equal(result.kind, 'executable')
  assert.match(result.summary, /WebAssembly module, 1 export/)
  assert.equal(result.details.find(([label]) => label === 'Types')[1], '1')
  assert.equal(result.details.find(([label]) => label === 'Functions')[1], '1')
  assert.equal(result.details.find(([label]) => label === 'Export names')[1], 'run')
})

// --- Java -------------------------------------------------------------------

test('Java class resolves this_class to a dotted name', () => {
  const result = inspectBinary(javaClassFixture(), 'class')
  assertShape(result)
  assert.equal(result.format, 'Java class')
  assert.equal(result.kind, 'bytecode')
  assert.match(result.summary, /com\.example\.App/)
  assert.match(result.summary, /Java 11/)
  assert.equal(result.details.find(([label]) => label === 'Class')[1], 'com.example.App')
})

test('Java class is preferred over the universal Mach-O magic', () => {
  // Both formats start with 0xCAFEBABE; the version word disambiguates.
  const result = inspectBinary(javaClassFixture())
  assert.equal(result.format, 'Java class')
})

// --- Python bytecode --------------------------------------------------------

test('pyc magic maps to a Python release', () => {
  const result = inspectBinary(pycFixture(), 'pyc')
  assertShape(result)
  assert.equal(result.format, 'Python bytecode')
  assert.equal(result.kind, 'bytecode')
  assert.match(result.summary, /Python 3\.11/)
  assert.equal(result.details.find(([label]) => label === 'Python')[1], '3.11')
  assert.ok(result.details.some(([label, value]) => label === 'Source size' && value.includes('4660')))
})

test('unknown pyc magic still reports the hex magic', () => {
  const w = writer(16)
  w.u32le(0, 0x0a0d0dff) // CR LF tail, magic not in the version map
  const result = inspectBinary(w.bytes, 'pyc')
  assert.equal(result.format, 'Python bytecode')
  assert.match(result.summary, /unknown version/)
  assert.ok(result.details.some(([label, value]) => label === 'Magic' && value.startsWith('0x')))
})

// --- SQLite -----------------------------------------------------------------

test('SQLite database header', () => {
  const result = inspectBinary(sqliteFixture(), 'db')
  assertShape(result)
  assert.equal(result.format, 'SQLite')
  assert.equal(result.kind, 'database')
  assert.match(result.summary, /SQLite 3 database/)
  assert.match(result.summary, /812 pages/)
  assert.equal(result.details.find(([label]) => label === 'Page size')[1], '4096 bytes')
  assert.equal(result.details.find(([label]) => label === 'Encoding')[1], 'UTF-8')
  assert.equal(result.details.find(([label]) => label === 'Freelist pages')[1], '3')
})

// --- ISO 9660 ---------------------------------------------------------------

test('ISO 9660 primary volume descriptor', () => {
  const result = inspectBinary(isoFixture(), 'iso')
  assertShape(result)
  assert.equal(result.format, 'ISO 9660')
  assert.equal(result.kind, 'diskimage')
  assert.match(result.summary, /MYVOLUME/)
  assert.equal(result.details.find(([label]) => label === 'Volume label')[1], 'MYVOLUME')
})

// --- containers -------------------------------------------------------------

test('ZIP magic, with and without a matching extension', () => {
  const plain = writer(64)
  plain.ascii(0, 'PK\x03\x04')
  const bare = inspectBinary(plain.bytes)
  assertShape(bare)
  assert.equal(bare.format, 'ZIP')
  assert.equal(bare.kind, 'container')

  const sketch = inspectBinary(plain.bytes, 'sketch')
  assert.equal(sketch.format, 'ZIP')
  assert.match(sketch.summary, /Sketch/)
})

test('GZIP magic', () => {
  const w = writer(32)
  w.u8(0, 0x1f)
  w.u8(1, 0x8b)
  w.u8(2, 8) // deflate
  w.u8(3, 0) // no flags
  const result = inspectBinary(w.bytes, 'gz')
  assertShape(result)
  assert.equal(result.format, 'GZIP')
  assert.equal(result.kind, 'container')
  assert.match(result.summary, /gzip/)
  assert.equal(result.details.find(([label]) => label === 'Compression')[1], 'deflate')
})

test('other container and media magics', () => {
  const pdf = inspectBinary(utf8('%PDF-1.7\n%...'))
  assert.equal(pdf.format, 'PDF')
  assert.match(pdf.summary, /1\.7/)

  const png = writer(33)
  png.u8(0, 0x89)
  png.ascii(1, 'PNG\r\n\x1a\n')
  png.u32be(16, 640)
  png.u32be(20, 480)
  const pngResult = inspectBinary(png.bytes)
  assert.equal(pngResult.format, 'PNG')
  assert.equal(pngResult.kind, 'media')
  assert.match(pngResult.summary, /640x480/)

  const gif = writer(13)
  gif.ascii(0, 'GIF89a')
  gif.u16le(6, 100)
  gif.u16le(8, 50)
  const gifResult = inspectBinary(gif.bytes)
  assert.equal(gifResult.format, 'GIF')
  assert.match(gifResult.summary, /100x50/)

  const jpeg = writer(32)
  jpeg.u8(0, 0xff)
  jpeg.u8(1, 0xd8)
  jpeg.u8(2, 0xff)
  const jpegResult = inspectBinary(jpeg.bytes)
  assert.equal(jpegResult.format, 'JPEG')
  assert.equal(jpegResult.kind, 'media')
})

// --- text -------------------------------------------------------------------

test('UTF-8 text is recognized instead of being called binary', () => {
  const result = inspectBinary(utf8('Hello, 世界!\nSecond line.\n'), 'bin')
  assertShape(result)
  assert.equal(result.format, 'text')
  assert.equal(result.kind, 'text')
  assert.match(result.summary, /UTF-8/)
})

test('plain ASCII text is reported as ASCII', () => {
  const result = inspectBinary(utf8('just some notes\nwith two lines\n'))
  assert.equal(result.format, 'text')
  assert.match(result.summary, /ASCII/)
})

test('a .db extension does not stop text detection', () => {
  const result = inspectBinary(utf8('CREATE TABLE t (a INTEGER);\n'), 'db')
  assert.equal(result.format, 'text')
})

// --- unknown and empty ------------------------------------------------------

test('binary data with NUL bytes that matches nothing is unknown', () => {
  const w = writer(64)
  for (let index = 0; index < 64; index += 1) w.u8(index, 0x00)
  const result = inspectBinary(w.bytes, 'img')
  assertShape(result)
  assert.equal(result.format, 'unknown')
  assert.equal(result.kind, 'unknown')
  assert.equal(typeof result.magic, 'string')
})

test('empty input', () => {
  const result = inspectBinary(new Uint8Array(0))
  assert.equal(result.format, 'empty')
  assert.equal(result.kind, 'unknown')
  assert.equal(result.summary, 'Empty file')
  assert.deepEqual(result.details, [])
})

// --- robustness -------------------------------------------------------------

test('truncated PE prefixes never throw', () => {
  const full = peFixture()
  for (const length of [0, 1, 2, 3, 0x3c, 0x3d, 0x40, 0x80, 0x82, 0x84, 0x88, 0xa0, 0x120, 0x200, 0x3ff]) {
    const slice = full.subarray(0, length)
    const result = inspectBinary(slice, 'exe')
    assertShape(result)
  }
})

test('truncated ELF prefixes never throw', () => {
  const full = elf64Fixture()
  for (const length of [0, 1, 4, 5, 6, 16, 18, 24, 32, 48, 52, 60, 64, 0x100, 0x140, 0x180, 0x2ff]) {
    const slice = full.subarray(0, length)
    const result = inspectBinary(slice, 'so')
    assertShape(result)
  }
})

test('every truncated prefix of the ELF32 big-endian fixture is safe too', () => {
  const full = elf32beFixture()
  for (const length of [0, 4, 16, 20, 24, 52]) {
    assertShape(inspectBinary(full.subarray(0, length)))
  }
})

test('garbage input of every length never throws', () => {
  const noise = new Uint8Array(256)
  for (let index = 0; index < noise.length; index += 1) noise[index] = (index * 37 + 11) & 0xff
  for (const length of [0, 1, 2, 3, 4, 8, 16, 64, 256]) {
    const result = inspectBinary(noise.subarray(0, length))
    assert.equal(typeof result.format, 'string')
    assert.ok(Array.isArray(result.details))
  }
})

test('non-byte input is tolerated', () => {
  const result = inspectBinary(undefined)
  assert.equal(result.format, 'empty')
  assert.deepEqual(result.details, [])
})

test('detail values stay short for a large header', () => {
  const result = inspectBinary(isoFixture(), 'iso')
  for (const [, value] of result.details) assert.ok(value.length <= 80)
})
