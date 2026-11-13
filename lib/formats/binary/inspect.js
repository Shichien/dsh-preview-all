/**
 * Binary format identification for the file preview panel.
 *
 * `inspectBinary` answers three questions about an opaque file from its leading
 * bytes: which format/container is it (`format`), what role does it play
 * (`kind`), and what can we tell a user about it (`summary` + `details`, plus
 * `sections` for object files).
 *
 * The caller passes roughly the first 256 KiB. Every read is bounds-checked and
 * every parser is wrapped in a try/catch, so a truncated or hostile buffer
 * yields the best partial answer instead of a throw. Nothing here allocates in
 * proportion to the file, and nothing reads beyond `head`.
 */

/** Bytes sampled for text detection and archive member counting. */
const SAMPLE_LIMIT = 1024 * 1024

/** Upper bound on displayed sections, so a pathological header cannot flood the panel. */
const SECTION_LIMIT = 96

/** Upper bound on walked constant-pool / load-command / section entries. */
const WALK_LIMIT = 8192

const utf8Decoder = new TextDecoder('utf-8', { fatal: false })

/**
 * Coerce whatever the caller passed into a byte view.
 * @param {unknown} input
 * @returns {Uint8Array}
 */
function toBytes(input) {
  if (input instanceof Uint8Array) return input
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  return new Uint8Array(0)
}

/**
 * Read one unsigned byte.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number | undefined}
 */
function u8(bytes, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset >= bytes.length) return undefined
  return bytes[offset]
}

/**
 * Read a little-endian 16-bit word.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number | undefined}
 */
function u16le(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.length) return undefined
  return bytes[offset] | (bytes[offset + 1] << 8)
}

/**
 * Read a big-endian 16-bit word.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number | undefined}
 */
function u16be(bytes, offset) {
  if (offset < 0 || offset + 2 > bytes.length) return undefined
  return (bytes[offset] << 8) | bytes[offset + 1]
}

/**
 * Read a little-endian 32-bit word.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number | undefined}
 */
function u32le(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return undefined
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}

/**
 * Read a big-endian 32-bit word.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number | undefined}
 */
function u32be(bytes, offset) {
  if (offset < 0 || offset + 4 > bytes.length) return undefined
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

/**
 * Read a 64-bit word as a JS number (exact up to 2^53, which covers every
 * offset and size we display).
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {'le' | 'be'} order
 * @returns {number | undefined}
 */
function u64(bytes, offset, order) {
  const lo = order === 'le' ? u32le(bytes, offset) : u32be(bytes, offset + 4)
  const hi = order === 'le' ? u32le(bytes, offset + 4) : u32be(bytes, offset)
  if (lo === undefined || hi === undefined) return undefined
  return hi * 0x100000000 + lo
}

/**
 * Read `count` bytes as a Latin-1 string (used for ASCII magic and field names).
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {number} count
 * @returns {string | undefined}
 */
function ascii(bytes, offset, count) {
  if (offset < 0 || offset + count > bytes.length) return undefined
  let text = ''
  for (let index = 0; index < count; index += 1) text += String.fromCharCode(bytes[offset + index])
  return text
}

/**
 * Read a NUL-terminated string, at most `max` bytes.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {number} [max]
 * @returns {string}
 */
function cString(bytes, offset, max = 256) {
  if (offset < 0 || offset >= bytes.length) return ''
  const end = Math.min(bytes.length, offset + max)
  let text = ''
  for (let index = offset; index < end; index += 1) {
    const byte = bytes[index]
    if (byte === 0) break
    text += String.fromCharCode(byte)
  }
  return text
}

/**
 * Decode a UTF-8 run.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @param {number} length
 * @returns {string}
 */
function decodeUtf8(bytes, offset, length) {
  if (offset < 0 || length < 0 || offset + length > bytes.length) return ''
  return utf8Decoder.decode(bytes.subarray(offset, offset + length))
}

/**
 * Format a number as hex.
 * @param {number | undefined} value
 * @param {number} [width]
 * @returns {string}
 */
function hex(value, width = 0) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'n/a'
  const text = Math.trunc(value).toString(16)
  return `0x${width > 0 ? text.padStart(width, '0') : text}`
}

/**
 * Format a byte count for humans.
 * @param {number | undefined} count
 * @returns {string}
 */
function formatBytes(count) {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return 'unknown'
  if (count < 1024) return `${Math.trunc(count)} B`
  const units = ['KiB', 'MiB', 'GiB', 'TiB']
  let value = count / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${units[unit]}`
}

/**
 * Format a Unix timestamp as an ISO date.
 * @param {number | undefined} seconds
 * @returns {string | undefined}
 */
function isoDate(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return undefined
  const date = new Date(seconds * 1000)
  if (Number.isNaN(date.getTime())) return undefined
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Hex dump of the leading bytes, used as the `magic` hint.
 * @param {Uint8Array} bytes
 * @param {number} [count]
 * @returns {string}
 */
function magicOf(bytes, count = 8) {
  const end = Math.min(bytes.length, count)
  const parts = []
  for (let index = 0; index < end; index += 1) parts.push(bytes[index].toString(16).padStart(2, '0'))
  return parts.join(' ')
}

/**
 * Build one details row, coercing and clamping the value.
 * @param {string} label
 * @param {string | number | undefined} value
 * @returns {[string, string] | undefined}
 */
function row(label, value) {
  if (value === undefined || value === null) return undefined
  const text = String(value).replace(/\s+/g, ' ').trim()
  if (text === '') return undefined
  return [label, text.length > 80 ? `${text.slice(0, 77)}...` : text]
}

/**
 * Drop undefined rows and keep the result a flat list of string pairs.
 * @param {Array<[string, string] | undefined>} rows
 * @returns {Array<[string, string]>}
 */
function rows(rows_) {
  const result = []
  for (const entry of rows_) {
    if (entry !== undefined) result.push(entry)
  }
  return result
}

/**
 * Assemble a result object, normalizing `sections` and `magic`.
 * @param {string} format
 * @param {string} kind
 * @param {string} summary
 * @param {Array<[string, string] | undefined>} detailRows
 * @param {object} [extra]
 * @returns {object}
 */
function result(format, kind, summary, detailRows, extra) {
  const output = { format, kind, summary, details: rows(detailRows) }
  if (extra?.sections !== undefined && extra.sections.length > 0) {
    output.sections = extra.sections.slice(0, SECTION_LIMIT).map((section) => ({
      name: section.name === '' ? '(unnamed)' : section.name,
      size: Number.isFinite(section.size) ? Math.max(0, Math.trunc(section.size)) : 0,
      flags: section.flags === '' ? 'none' : section.flags,
    }))
  }
  if (extra?.magic !== undefined) output.magic = extra.magic
  return output
}

/** Machine codes from the PE/COFF specification. */
const PE_MACHINES = {
  0x014c: 'x86',
  0x0162: 'MIPS R3000',
  0x0166: 'MIPS R4000',
  0x0169: 'MIPS WCE v2',
  0x01a2: 'SH3',
  0x01a6: 'SH4',
  0x01c0: 'ARM',
  0x01c2: 'ARM Thumb',
  0x01c4: 'ARMv7',
  0x0200: 'Itanium',
  0x0266: 'MIPS16',
  0x0366: 'MIPS FPU',
  0x0466: 'MIPS FPU16',
  0x5032: 'RISC-V 32',
  0x5064: 'RISC-V 64',
  0x8664: 'x86-64',
  0xaa64: 'ARM64',
  0x01f0: 'PowerPC',
  0x01f1: 'PowerPC FP',
}

/** Subsystem codes from the PE/COFF specification. */
const PE_SUBSYSTEMS = {
  0: 'unknown',
  1: 'native',
  2: 'GUI',
  3: 'console',
  5: 'OS/2 console',
  7: 'POSIX console',
  8: 'native Windows',
  9: 'Windows CE',
  10: 'EFI application',
  11: 'EFI boot driver',
  12: 'EFI runtime driver',
  13: 'Xbox',
  14: 'Windows boot',
  16: 'Windows boot (UEFI)',
}

/** Section characteristics bits worth naming. */
const PE_SECTION_FLAGS = [
  [0x00000020, 'code'],
  [0x00000040, 'initialized data'],
  [0x00000080, 'uninitialized data'],
  [0x02000000, 'discardable'],
  [0x20000000, 'execute'],
  [0x40000000, 'read'],
  [0x80000000, 'write'],
]

/**
 * Parse a Windows PE image (or a bare DOS stub).
 * @param {Uint8Array} bytes
 * @returns {object | undefined}
 */
function parsePe(bytes) {
  if (u8(bytes, 0) !== 0x4d || u8(bytes, 1) !== 0x5a) return undefined
  const peOffset = u32le(bytes, 0x3c)
  if (peOffset === undefined || ascii(bytes, peOffset, 4) !== 'PE\0\0') {
    return result('unknown', 'executable', 'DOS executable (MZ header, no PE signature)', [
      row('Signature', 'MZ'),
      row('PE header offset', peOffset === undefined ? 'beyond sampled bytes' : hex(peOffset)),
      row('Note', 'Either a DOS program or a PE file whose header lies past the sample'),
    ], { magic: magicOf(bytes) })
  }

  const coff = peOffset + 4
  const machine = u16le(bytes, coff)
  const sectionCount = u16le(bytes, coff + 2)
  const timestamp = u32le(bytes, coff + 4)
  const optionalSize = u16le(bytes, coff + 16)
  const characteristics = u16le(bytes, coff + 18)
  const optional = coff + 20
  const optMagic = u16le(bytes, optional)
  const pe32Plus = optMagic === 0x20b
  const entryPoint = u32le(bytes, optional + 16)
  const imageBase = pe32Plus ? u64(bytes, optional + 24, 'le') : u32le(bytes, optional + 28)
  const sizeOfImage = u32le(bytes, optional + 56)
  const subsystem = u16le(bytes, optional + 68)

  const isDll = typeof characteristics === 'number' && (characteristics & 0x2000) !== 0
  const isExe = typeof characteristics === 'number' && (characteristics & 0x0002) !== 0
  const kind = isDll ? 'library' : isExe ? 'executable' : 'object'
  const machineName = machine === undefined ? 'unknown machine' : (PE_MACHINES[machine] ?? `machine ${hex(machine)}`)
  const subsystemName = subsystem === undefined ? 'unknown subsystem' : (PE_SUBSYSTEMS[subsystem] ?? `subsystem ${subsystem}`)
  const role = isDll ? 'DLL' : isExe ? 'executable' : 'object'
  const summary = `Windows PE ${role} (${machineName}, ${subsystemName})`

  const sections = []
  if (typeof sectionCount === 'number' && typeof optionalSize === 'number') {
    let cursor = optional + optionalSize
    for (let index = 0; index < Math.min(sectionCount, SECTION_LIMIT); index += 1) {
      if (cursor + 40 > bytes.length) break
      const name = cString(bytes, cursor, 8)
      const virtualSize = u32le(bytes, cursor + 8)
      const rawSize = u32le(bytes, cursor + 16)
      const sectionCharacteristics = u32le(bytes, cursor + 36)
      const size = rawSize !== undefined && rawSize > 0 ? rawSize : (virtualSize ?? 0)
      const flags = []
      if (typeof sectionCharacteristics === 'number') {
        for (const [bit, label] of PE_SECTION_FLAGS) {
          if ((sectionCharacteristics & bit) !== 0) flags.push(label)
        }
      }
      sections.push({ name, size, flags: flags.join(', ') })
      cursor += 40
    }
  }

  const buildTime = isoDate(timestamp)
  const details = [
    row('Format', pe32Plus ? 'PE32+' : optMagic === 0x10b ? 'PE32' : 'PE (unknown optional header)'),
    row('Machine', machineName),
    row('Type', role),
    row('Subsystem', subsystemName),
    row('Entry point', entryPoint === undefined ? undefined : hex(entryPoint)),
    row('Image base', imageBase === undefined ? undefined : hex(imageBase)),
    row('Size of image', sizeOfImage === undefined ? undefined : `${formatBytes(sizeOfImage)} (${hex(sizeOfImage)})`),
    row('Sections', sectionCount),
    row('Characteristics', characteristics === undefined ? undefined : hex(characteristics, 4)),
    timestamp === 0
      ? row('Build time', 'reproducible build (TimeDateStamp is 0)')
      : row('Build time', buildTime ?? 'unknown'),
  ]

  return result('PE', kind, summary, details, { sections, magic: magicOf(bytes) })
}

/** ELF machine codes worth naming. */
const ELF_MACHINES = {
  2: 'SPARC',
  3: 'x86',
  8: 'MIPS',
  20: 'PowerPC',
  21: 'PowerPC64',
  22: 's390',
  40: 'ARM',
  43: 'SPARCv9',
  50: 'IA-64',
  62: 'x86-64',
  183: 'AArch64',
  243: 'RISC-V',
  247: 'BPF',
  258: 'LoongArch',
}

/** ELF object types. */
const ELF_TYPES = {
  1: ['relocatable object', 'object'],
  2: ['executable', 'executable'],
  3: ['shared object', 'library'],
  4: ['core dump', 'unknown'],
}

/**
 * Parse an ELF image, including its section table when the string table is inside `head`.
 * @param {Uint8Array} bytes
 * @returns {object | undefined}
 */
function parseElf(bytes) {
  if (u8(bytes, 0) !== 0x7f || u8(bytes, 1) !== 0x45 || u8(bytes, 2) !== 0x4c || u8(bytes, 3) !== 0x46) {
    return undefined
  }
  const elfClass = u8(bytes, 4)
  const elfData = u8(bytes, 5)
  if ((elfClass !== 1 && elfClass !== 2) || (elfData !== 1 && elfData !== 2)) return undefined
  const is64 = elfClass === 2
  const order = elfData === 1 ? 'le' : 'be'
  const read16 = order === 'le'
    ? (offset) => u16le(bytes, offset)
    : (offset) => u16be(bytes, offset)
  const read32 = order === 'le'
    ? (offset) => u32le(bytes, offset)
    : (offset) => u32be(bytes, offset)
  const read64 = (offset) => u64(bytes, offset, order)

  const type = read16(16)
  const machine = read16(18)
  const entry = is64 ? read64(24) : read32(24)
  const sectionOffset = is64 ? read64(40) : read32(32)
  const sectionEntrySize = read16(is64 ? 58 : 46)
  const sectionCount = read16(is64 ? 60 : 48)
  const stringIndex = read16(is64 ? 62 : 50)

  const [typeName, kind] = ELF_TYPES[type] ?? ['unknown type', 'unknown']
  const machineName = ELF_MACHINES[machine] ?? `machine ${machine ?? '?'}`
  const dataLabel = order === 'le' ? 'LSB' : 'MSB'
  const summary = `ELF ${is64 ? 64 : 32}-bit ${dataLabel} ${typeName} (${machineName})`

  const sections = []
  if (
    typeof sectionOffset === 'number' && sectionOffset > 0 &&
    typeof sectionEntrySize === 'number' && sectionEntrySize >= (is64 ? 64 : 40) &&
    typeof sectionCount === 'number' && sectionCount > 0 &&
    typeof stringIndex === 'number' && stringIndex < sectionCount
  ) {
    const headerAt = (index) => sectionOffset + index * sectionEntrySize
    const stringsHeader = headerAt(stringIndex)
    const stringsOffset = is64 ? read64(stringsHeader + 24) : read32(stringsHeader + 16)
    const stringsSize = is64 ? read64(stringsHeader + 32) : read32(stringsHeader + 20)
    if (typeof stringsOffset === 'number' && typeof stringsSize === 'number') {
      for (let index = 1; index < Math.min(sectionCount, SECTION_LIMIT); index += 1) {
        const base = headerAt(index)
        if (base + sectionEntrySize > bytes.length) break
        const nameOffset = read32(base)
        const size = is64 ? read64(base + 32) : read32(base + 20)
        const flagsWord = is64 ? read64(base + 8) : read32(base + 8)
        const flags = []
        if (typeof flagsWord === 'number') {
          if ((flagsWord & 0x4) !== 0) flags.push('code')
          if ((flagsWord & 0x2) !== 0) flags.push('alloc')
          if ((flagsWord & 0x1) !== 0) flags.push('write')
          if ((flagsWord & 0x4) !== 0) flags.push('execute')
        }
        const name = typeof nameOffset === 'number'
          ? cString(bytes, stringsOffset + nameOffset, 64)
          : ''
        sections.push({ name, size: size ?? 0, flags: flags.join(', ') })
      }
    }
  }

  const details = [
    row('Class', is64 ? '64-bit' : '32-bit'),
    row('Data', order === 'le' ? 'little endian (LSB)' : 'big endian (MSB)'),
    row('Type', typeName),
    row('Machine', machineName),
    row('Entry point', entry === undefined ? undefined : hex(entry)),
    row('Sections', sectionCount),
    row('Section headers', typeof sectionOffset === 'number' && sectionOffset > 0 ? hex(sectionOffset) : 'none'),
  ]

  return result('ELF', kind, summary, details, { sections, magic: magicOf(bytes) })
}

/** Mach-O CPU types. */
const MACHO_CPUS = {
  7: 'x86',
  12: 'ARM',
  18: 'PowerPC',
  0x01000007: 'x86-64',
  0x0100000c: 'ARM64',
  0x01000012: 'PowerPC64',
}

/** Mach-O file types. */
const MACHO_FILETYPES = {
  1: ['object', 'object'],
  2: ['executable', 'executable'],
  3: ['fixed VM library', 'library'],
  4: ['core dump', 'unknown'],
  5: ['preloaded executable', 'executable'],
  6: ['dynamic library', 'library'],
  7: ['dynamic linker', 'executable'],
  8: ['bundle', 'library'],
  9: ['dynamic library stub', 'library'],
  10: ['debug symbols', 'object'],
  11: ['kernel extension', 'library'],
}

/**
 * Describe a Mach-O or universal (fat) binary.
 * @param {Uint8Array} bytes
 * @returns {object | undefined}
 */
function parseMachO(bytes) {
  const magic = u32be(bytes, 0)
  if (magic === undefined) return undefined

  if (magic === 0xcafebabe || magic === 0xbebafeca) {
    const order = magic === 0xcafebabe ? 'be' : 'le'
    const read32 = order === 'be' ? u32be : u32le
    const archCount = read32(bytes, 4)
    if (archCount === undefined || archCount === 0 || archCount > 64) return undefined
    const architectures = []
    for (let index = 0; index < Math.min(archCount, 32); index += 1) {
      const base = 8 + index * 20
      const cpu = read32(bytes, base)
      const size = read32(bytes, base + 12)
      if (cpu === undefined) break
      architectures.push(`${MACHO_CPUS[cpu] ?? hex(cpu)} (${formatBytes(size)})`)
    }
    const details = [
      row('Format', 'universal (fat)'),
      row('Architectures', archCount),
      row('Contains', architectures.join(', ')),
    ]
    return result(
      'Mach-O',
      'executable',
      `Mach-O universal binary, ${archCount} architecture${archCount === 1 ? '' : 's'}`,
      details,
      { magic: magicOf(bytes) },
    )
  }

  let is64
  let order
  if (magic === 0xfeedfacf) {
    is64 = true
    order = 'be'
  } else if (magic === 0xcffaedfe) {
    is64 = true
    order = 'le'
  } else if (magic === 0xfeedface) {
    is64 = false
    order = 'be'
  } else if (magic === 0xcefaedfe) {
    is64 = false
    order = 'le'
  } else {
    return undefined
  }

  const read32 = order === 'be' ? u32be : u32le
  const cpu = read32(bytes, 4)
  const filetype = read32(bytes, 12)
  const commandCount = read32(bytes, 16)
  const commandBytes = read32(bytes, 20)
  const [typeName, kind] = MACHO_FILETYPES[filetype] ?? ['unknown type', 'unknown']
  const cpuName = cpu === undefined ? 'unknown CPU' : (MACHO_CPUS[cpu] ?? hex(cpu))
  const commandLabel = typeof commandCount === 'number'
    ? `${commandCount} load command${commandCount === 1 ? '' : 's'}`
    : 'unknown load commands'
  const summary = `Mach-O ${is64 ? 64 : 32}-bit ${typeName} (${cpuName}, ${commandLabel})`

  const sections = []
  const headerSize = is64 ? 32 : 28
  if (typeof commandCount === 'number' && typeof commandBytes === 'number') {
    let cursor = headerSize
    const end = Math.min(bytes.length, headerSize + commandBytes)
    for (let index = 0; index < Math.min(commandCount, WALK_LIMIT); index += 1) {
      if (cursor + 8 > end) break
      const command = read32(bytes, cursor)
      const commandSize = read32(bytes, cursor + 4)
      if (command === undefined || commandSize === undefined || commandSize < 8) break
      if (command === 0x1 || command === 0x19) {
        const segment64 = command === 0x19
        const initprot = read32(bytes, cursor + (segment64 ? 60 : 44))
        const sectionCount = read32(bytes, cursor + (segment64 ? 64 : 48))
        const sectionBase = cursor + (segment64 ? 72 : 56)
        const sectionSize = segment64 ? 80 : 68
        const flags = []
        if (typeof initprot === 'number') {
          if ((initprot & 0x2) !== 0) flags.push('write')
          if ((initprot & 0x4) !== 0) flags.push('execute')
          if ((initprot & 0x1) !== 0) flags.push('read')
        }
        for (let slot = 0; slot < Math.min(sectionCount ?? 0, SECTION_LIMIT); slot += 1) {
          const base = sectionBase + slot * sectionSize
          if (base + sectionSize > end) break
          const name = cString(bytes, base, 16)
          const size = segment64 ? u64(bytes, base + 40, order) : read32(bytes, base + 36)
          sections.push({ name, size: size ?? 0, flags: flags.join(', ') })
        }
      }
      cursor += commandSize
    }
  }

  const details = [
    row('Format', is64 ? 'Mach-O 64-bit' : 'Mach-O 32-bit'),
    row('CPU', cpuName),
    row('File type', typeName),
    row('Load commands', commandCount),
    row('Byte order', order === 'le' ? 'little endian' : 'big endian'),
  ]

  return result('Mach-O', kind, summary, details, { sections, magic: magicOf(bytes) })
}

/**
 * Read an unsigned LEB128 value.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {{ value: number, next: number } | undefined}
 */
function leb128(bytes, offset) {
  let value = 0
  let shift = 0
  let cursor = offset
  while (cursor < bytes.length && shift <= 35) {
    const byte = bytes[cursor]
    cursor += 1
    value += (byte & 0x7f) * 2 ** shift
    if ((byte & 0x80) === 0) return { value, next: cursor }
    shift += 7
  }
  return undefined
}

/**
 * Skip a WASM name (length-prefixed UTF-8).
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {{ value: string, next: number } | undefined}
 */
function wasmName(bytes, offset) {
  const size = leb128(bytes, offset)
  if (size === undefined) return undefined
  const next = size.next + size.value
  if (next > bytes.length) return undefined
  return { value: decodeUtf8(bytes, size.next, size.value), next }
}

/**
 * Skip a WASM limits structure.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number | undefined}
 */
function wasmLimits(bytes, offset) {
  const flags = leb128(bytes, offset)
  if (flags === undefined) return undefined
  const min = leb128(bytes, flags.next)
  if (min === undefined) return undefined
  if (flags.value === 0) return min.next
  const max = leb128(bytes, min.next)
  return max?.next
}

/**
 * Skip one WASM import descriptor.
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {number | undefined}
 */
function wasmImportDescriptor(bytes, offset) {
  const kind = u8(bytes, offset)
  if (kind === undefined) return undefined
  const base = offset + 1
  if (kind === 0x00) return leb128(bytes, base)?.next
  if (kind === 0x01) {
    const reference = u8(bytes, base)
    if (reference === undefined) return undefined
    return wasmLimits(bytes, base + 1)
  }
  if (kind === 0x02) return wasmLimits(bytes, base)
  if (kind === 0x03) {
    const valueType = u8(bytes, base)
    const mutable = u8(bytes, base + 1)
    if (valueType === undefined || mutable === undefined) return undefined
    return base + 2
  }
  return undefined
}

/**
 * Parse a WebAssembly module and summarize its sections.
 * @param {Uint8Array} bytes
 * @returns {object | undefined}
 */
function parseWasm(bytes) {
  if (ascii(bytes, 0, 4) !== '\0asm') return undefined
  const version = u32le(bytes, 4)
  const counts = { types: 0, imports: 0, functions: 0, exports: 0, tables: 0, memories: 0, globals: 0 }
  const exportNames = []
  let hasStart = false
  let cursor = 8
  let walked = 0

  while (cursor < bytes.length && walked < 64) {
    walked += 1
    const id = u8(bytes, cursor)
    const size = leb128(bytes, cursor + 1)
    if (id === undefined || size === undefined) break
    const start = size.next
    const end = start + size.value
    if (end > bytes.length) {
      // Truncated section: count what is visible, then stop.
      break
    }
    try {
      if (id === 1 || id === 2 || id === 3 || id === 7 || id === 4 || id === 5 || id === 6) {
        const count = leb128(bytes, start)
        if (count === undefined) break
        if (id === 1) counts.types = count.value
        if (id === 3) counts.functions = count.value
        if (id === 4) counts.tables = count.value
        if (id === 5) counts.memories = count.value
        if (id === 6) counts.globals = count.value
        if (id === 7) counts.exports = count.value
        if (id === 2) {
          counts.imports = count.value
          let position = count.next
          for (let index = 0; index < Math.min(count.value, WALK_LIMIT) && position < end; index += 1) {
            const module = wasmName(bytes, position)
            if (module === undefined) break
            const field = wasmName(bytes, module.next)
            if (field === undefined) break
            const next = wasmImportDescriptor(bytes, field.next)
            if (next === undefined || next <= position) break
            position = next
          }
        }
        if (id === 7) {
          let position = count.next
          for (let index = 0; index < Math.min(count.value, 8) && position < end; index += 1) {
            const name = wasmName(bytes, position)
            if (name === undefined) break
            if (exportNames.length < 6) exportNames.push(name.value)
            const exportKind = u8(bytes, name.next)
            const exportIndex = leb128(bytes, name.next + 1)
            if (exportKind === undefined || exportIndex === undefined) break
            position = exportIndex.next
          }
        }
      } else if (id === 8) {
        hasStart = true
      }
    } catch {
      // Ignore a malformed section and keep the counts gathered so far.
      break
    }
    cursor = end
  }

  const summary = `WebAssembly module, ${counts.exports} export${counts.exports === 1 ? '' : 's'}`
  const details = [
    row('Version', version === undefined ? 'unknown' : String(version)),
    row('Types', counts.types),
    row('Imports', counts.imports),
    row('Functions', counts.functions),
    row('Exports', counts.exports),
    row('Export names', exportNames.length > 0 ? exportNames.join(', ') : 'none'),
    row('Memory', counts.memories > 0 ? `yes (${counts.memories})` : 'no'),
    row('Table', counts.tables > 0 ? `yes (${counts.tables})` : 'no'),
    row('Globals', counts.globals),
    row('Start function', hasStart ? 'yes' : 'no'),
  ]

  return result('WASM', 'executable', summary, details, { magic: magicOf(bytes) })
}

/**
 * Parse a Unix `ar` archive (`.a`, and PE/COFF import libraries `.lib`).
 * @param {Uint8Array} bytes
 * @returns {object | undefined}
 */
function parseAr(bytes) {
  if (ascii(bytes, 0, 8) !== '!<arch>\n') return undefined
  const limit = Math.min(bytes.length, SAMPLE_LIMIT)
  let cursor = 8
  let members = 0
  let symbolTable
  let coffMember = false
  const sampleNames = []

  while (cursor + 60 <= limit && members < 200000) {
    const rawName = ascii(bytes, cursor, 16)
    const rawSize = ascii(bytes, cursor + 48, 10)
    const footer = ascii(bytes, cursor + 58, 2)
    if (rawName === undefined || rawSize === undefined || footer !== '`\n') break
    const size = Number.parseInt(rawSize.trim(), 10)
    if (!Number.isFinite(size) || size < 0) break
    const name = rawName.replace(/\0+$/, '').trimEnd()
    if (members === 0 && /^(?:\/|__\.SYMDEF|SYM64)/.test(name)) symbolTable = name
    // `/N` is an offset into the long-name table. GNU ar and PE import
    // libraries both use it, so the deciding signal is whether the member's
    // payload starts with a COFF machine word.
    if (/^\/\d+$/.test(name)) {
      const machine = u16le(bytes, cursor + 60)
      if (machine !== undefined && PE_MACHINES[machine] !== undefined) coffMember = true
    }
    if (sampleNames.length < 4 && name !== '' && name !== '/' && name !== '//' && !/^\/\d+$/.test(name)) {
      sampleNames.push(name)
    }
    members += 1
    cursor += 60 + size + (size % 2)
  }

  const importLibrary = coffMember

  const notes = []
  if (symbolTable !== undefined) notes.push('symbol table present')
  if (importLibrary) notes.push('PE/COFF import library')

  const summary = `ar archive, ${members} member${members === 1 ? '' : 's'}${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`
  const details = [
    row('Members', members),
    row('Symbol table', symbolTable === undefined ? 'none seen' : `${symbolTable} member`),
    row('Kind', importLibrary ? 'PE/COFF import library (members are COFF objects)' : 'Unix static archive'),
    row('First members', sampleNames.length > 0 ? sampleNames.join(', ') : undefined),
  ]

  return result('ar archive', 'library', summary, details, { magic: magicOf(bytes) })
}

/** Java class file major versions. */
const JAVA_RELEASES = {
  45: '1.1',
  46: '1.2',
  47: '1.3',
  48: '1.4',
  49: '5',
  50: '6',
  51: '7',
  52: '8',
  53: '9',
  54: '10',
  55: '11',
  56: '12',
  57: '13',
  58: '14',
  59: '15',
  60: '16',
  61: '17',
  62: '18',
  63: '19',
  64: '20',
  65: '21',
  66: '22',
  67: '23',
  68: '24',
  69: '25',
  70: '26',
}

/**
 * Parse a JVM class file and resolve the name behind `this_class`.
 * @param {Uint8Array} bytes
 * @returns {object | undefined}
 */
function parseJavaClass(bytes) {
  if (u32be(bytes, 0) !== 0xcafebabe) return undefined
  const minor = u16be(bytes, 4)
  const major = u16be(bytes, 6)
  // A Java class always has a plausible major version here; this is what
  // separates it from a universal (fat) Mach-O, which shares 0xCAFEBABE.
  if (major === undefined || major < 45 || major > 80) return undefined
  const poolCount = u16be(bytes, 8)
  if (poolCount === undefined) return undefined

  const strings = new Map()
  const classNames = new Map()
  let cursor = 10
  let entries = 0
  // Slot 0 is not a real entry, so at most `poolCount - 1` entries exist.
  const stop = Math.min(Math.max(0, poolCount - 1), WALK_LIMIT)

  while (cursor < bytes.length && entries < stop) {
    const tag = bytes[cursor]
    cursor += 1
    entries += 1
    if (tag === 1) {
      const length = u16be(bytes, cursor)
      if (length === undefined || cursor + 2 + length > bytes.length) {
        cursor = bytes.length
        break
      }
      strings.set(entries, decodeUtf8(bytes, cursor + 2, length))
      cursor += 2 + length
    } else if (tag === 3 || tag === 4 || tag === 9 || tag === 10 || tag === 11 || tag === 12 || tag === 17 || tag === 18) {
      cursor += 4
    } else if (tag === 5 || tag === 6) {
      cursor += 8
      entries += 1
    } else if (tag === 7) {
      const nameIndex = u16be(bytes, cursor)
      if (nameIndex !== undefined) classNames.set(entries, nameIndex)
      cursor += 2
    } else if (tag === 8 || tag === 16 || tag === 19 || tag === 20) {
      cursor += 2
    } else if (tag === 15) {
      cursor += 3
    } else {
      cursor = bytes.length
      break
    }
  }

  let className
  if (cursor + 6 <= bytes.length) {
    const thisClass = u16be(bytes, cursor + 2)
    const nameIndex = thisClass === undefined ? undefined : classNames.get(thisClass)
    const raw = nameIndex === undefined ? undefined : strings.get(nameIndex)
    if (typeof raw === 'string') className = raw.replace(/\//g, '.')
  }

  const release = JAVA_RELEASES[major] ?? 'unknown'
  const summary = className === undefined
    ? `Java class file (Java ${release}, major ${major})`
    : `Java class ${className} (Java ${release}, major ${major})`

  const details = [
    row('Class', className ?? 'unresolved'),
    row('Java release', `${release} (major ${major})`),
    row('Minor version', minor),
    row('Constant pool', `${poolCount} slots`),
  ]

  return result('Java class', 'bytecode', summary, details, { magic: magicOf(bytes) })
}

/** Python bytecode magics, keyed by the big-endian word at offset 0. */
const PYC_MAGICS = {
  0xcb0d0d0a: '3.13',
  0xa70d0d0a: '3.12',
  0x6f0d0d0a: '3.11',
  0x550d0d0a: '3.10',
  0x610d0d0a: '3.9',
  0x420d0d0a: '3.8',
}

/**
 * Describe a Python `.pyc` file.
 * @param {Uint8Array} bytes
 * @param {string | undefined} extension
 * @returns {object | undefined}
 */
function parsePyc(bytes, extension) {
  if (bytes.length < 4) return undefined
  // Every CPython magic ends with CR LF; that is the cheap structural test.
  if (bytes[2] !== 0x0d || bytes[3] !== 0x0a) return undefined
  const word = u32be(bytes, 0)
  const version = PYC_MAGICS[word]
  if (version === undefined && extension !== 'pyc') return undefined

  const flags = bytes.length >= 8 ? u32le(bytes, 4) : undefined
  const mtime = bytes.length >= 12 ? u32le(bytes, 8) : undefined
  const sourceSize = bytes.length >= 16 ? u32le(bytes, 12) : undefined

  const flagNotes = []
  if (typeof flags === 'number') {
    if ((flags & 0x1) !== 0) flagNotes.push('hash-based (PEP 552)')
    if ((flags & 0x2) !== 0) flagNotes.push('check source')
    if ((flags & 0x4) !== 0) flagNotes.push('free-threaded build')
  }

  const summary = version === undefined
    ? `Python bytecode (unknown version, magic ${hex(word, 8)})`
    : `Python ${version} bytecode`

  const details = [
    row('Magic', hex(word, 8)),
    row('Python', version ?? 'unknown'),
    row('Flags', flags === undefined ? 'header truncated' : `${hex(flags, 4)}${flagNotes.length > 0 ? ` (${flagNotes.join(', ')})` : ''}`),
    row('Source mtime', mtime === undefined ? 'header truncated' : (isoDate(mtime) ?? 'unknown')),
    row('Source size', sourceSize === undefined ? 'header truncated' : `${formatBytes(sourceSize)} (${sourceSize} bytes)`),
  ]

  return result('Python bytecode', 'bytecode', summary, details, { magic: magicOf(bytes) })
}

/**
 * Parse the 100-byte SQLite database header.
 * @param {Uint8Array} bytes
 * @returns {object | undefined}
 */
function parseSqlite(bytes) {
  if (ascii(bytes, 0, 16) !== 'SQLite format 3\0') return undefined
  const rawPageSize = u16be(bytes, 16)
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize
  const changeCounter = u32be(bytes, 24)
  const pageCount = u32be(bytes, 28)
  const freelistPages = u32be(bytes, 36)
  const schemaCookie = u32be(bytes, 40)
  const encodingWord = u32be(bytes, 56)
  const encoding = encodingWord === 2 ? 'UTF-16le' : encodingWord === 3 ? 'UTF-16be' : 'UTF-8'
  const libraryVersion = u32be(bytes, 96)

  const pageLabel = typeof pageSize === 'number' && pageSize >= 512
    ? `${formatBytes(pageSize)} pages`
    : 'unknown page size'
  const summary = typeof pageCount === 'number'
    ? `SQLite 3 database, ${pageLabel}, ${pageCount} page${pageCount === 1 ? '' : 's'}`
    : `SQLite 3 database, ${pageLabel}`

  const version = typeof libraryVersion === 'number' && libraryVersion > 0
    ? `${Math.floor(libraryVersion / 1000000)}.${Math.floor(libraryVersion / 1000) % 1000}.${libraryVersion % 1000}`
    : undefined

  const details = [
    row('Page size', typeof pageSize === 'number' ? `${pageSize} bytes` : 'unknown'),
    row('Pages', pageCount),
    row('Change counter', changeCounter),
    row('Schema cookie', schemaCookie),
    row('Encoding', encodingWord === undefined ? undefined : encoding),
    row('Freelist pages', freelistPages),
    row('Library version', version),
  ]

  return result('SQLite', 'database', summary, details, { magic: magicOf(bytes) })
}

/**
 * Parse an ISO 9660 volume descriptor.
 * @param {Uint8Array} bytes
 * @returns {object | undefined}
 */
function parseIso(bytes) {
  for (const base of [0x8000, 0x8800]) {
    if (ascii(bytes, base + 1, 5) !== 'CD001') continue
    const descriptorType = u8(bytes, base)
    const version = u8(bytes, base + 6)
    const label = ascii(bytes, base + 40, 32)?.replace(/ +$/, '') ?? ''
    const spaceSize = u32le(bytes, base + 80)
    const blockSize = u16le(bytes, base + 128)
    const typeName = descriptorType === 1
      ? 'primary volume descriptor'
      : descriptorType === 2
        ? 'supplementary volume descriptor'
        : descriptorType === 0
          ? 'boot record'
          : `descriptor ${descriptorType}`

    const summary = label === ''
      ? `ISO 9660 image (${typeName})`
      : `ISO 9660 image, volume "${label}"`

    const details = [
      row('Volume label', label === '' ? '(none)' : label),
      row('Descriptor', typeName),
      row('Volume space', spaceSize === undefined ? undefined : `${spaceSize} blocks (${formatBytes(spaceSize * 2048)})`),
      row('Logical block size', blockSize === undefined ? undefined : `${blockSize} bytes`),
      row('Version', version),
    ]

    return result('ISO 9660', 'diskimage', summary, details, { magic: magicOf(bytes) })
  }
  return undefined
}

/**
 * Recognize an Apple UDIF disk image by its `koly` trailer.
 *
 * The trailer sits at the very end of the file, so the caller's head almost
 * never contains it; `koly` inside the first 512 bytes is accepted only as a
 * hint, and the summary says so rather than claiming a full parse.
 * @param {Uint8Array} bytes
 * @returns {object | undefined}
 */
function parseDmg(bytes) {
  let offset = -1
  if (bytes.length >= 512 && ascii(bytes, bytes.length - 512, 4) === 'koly') {
    offset = bytes.length - 512
  } else {
    const scanEnd = Math.min(bytes.length - 4, 512)
    for (let index = 0; index <= scanEnd; index += 1) {
      if (bytes[index] === 0x6b && bytes[index + 1] === 0x6f && bytes[index + 2] === 0x6c && bytes[index + 3] === 0x79) {
        offset = index
        break
      }
    }
    // A stray "koly" in a plain-text file is far more likely than a text DMG,
    // so the loose in-sample scan demands at least one NUL byte nearby.
    if (offset > 0) {
      let hasNul = false
      for (let index = 0; index < Math.min(bytes.length, 512); index += 1) {
        if (bytes[index] === 0) {
          hasNul = true
          break
        }
      }
      if (!hasNul) return undefined
    }
  }
  if (offset < 0) return undefined

  const atEnd = offset === bytes.length - 512
  const summary = atEnd
    ? 'Apple disk image (UDIF), koly trailer in sample'
    : 'Apple disk image (UDIF), koly marker near start'
  const details = [
    row('Container', 'UDIF (koly trailer)'),
    row('Trailer offset', atEnd ? 'end of sample' : hex(offset)),
    row('Note', atEnd
      ? 'Trailer found inside the sampled head only; sizes are not parsed'
      : 'Magic seen near the start of the sample; the real trailer is at EOF'),
  ]

  return result('DMG', 'diskimage', summary, details, { magic: magicOf(bytes) })
}

/** Archive and document extensions that legitimately carry ZIP data. */
const ZIP_FAMILIES = {
  zip: 'ZIP archive',
  jar: 'ZIP archive (Java JAR)',
  war: 'ZIP archive (Java WAR)',
  apk: 'ZIP archive (Android APK)',
  aab: 'ZIP archive (Android App Bundle)',
  docx: 'ZIP archive (Office Open XML document)',
  xlsx: 'ZIP archive (Office Open XML spreadsheet)',
  pptx: 'ZIP archive (Office Open XML presentation)',
  odt: 'ZIP archive (OpenDocument text)',
  ods: 'ZIP archive (OpenDocument spreadsheet)',
  epub: 'ZIP archive (EPUB book)',
  sketch: 'ZIP archive (Sketch document)',
  ipa: 'ZIP archive (iOS app)',
  nupkg: 'ZIP archive (NuGet package)',
  vsix: 'ZIP archive (VS Code extension)',
  whl: 'ZIP archive (Python wheel)',
}

/** Brands found in an ISO base media `ftyp` box. */
const MP4_BRANDS = {
  isom: 'MP4 (ISO base media)',
  iso2: 'MP4 (ISO base media)',
  mp41: 'MP4 (ISO base media)',
  mp42: 'MP4 (ISO base media)',
  avc1: 'MP4 (H.264)',
  dash: 'MP4 (DASH segment)',
  M4V: 'MP4 (Apple video)',
  M4A: 'MP4 (Apple audio)',
  qt: 'QuickTime movie',
  crx: 'MP4 (Canon)',
  '3gp4': '3GPP video',
  heic: 'HEIF image',
  heix: 'HEIF image',
  mif1: 'HEIF image',
  avif: 'AVIF image',
}

/**
 * Recognize the common container, media and document magics.
 * @param {Uint8Array} bytes
 * @param {string | undefined} extension
 * @returns {object | undefined}
 */
function parseGeneric(bytes, extension) {
  const magic = magicOf(bytes)
  const zipFamily = extension === undefined ? undefined : ZIP_FAMILIES[extension]

  // ZIP family: local file header, empty archive, or spanned marker.
  const zipHeader = ascii(bytes, 0, 4)
  if (zipHeader === 'PK\x03\x04' || zipHeader === 'PK\x05\x06' || zipHeader === 'PK\x07\x08') {
    const summary = zipFamily ?? (extension === undefined
      ? 'ZIP archive'
      : `ZIP archive (file has a .${extension} extension)`)
    const empty = zipHeader === 'PK\x05\x06'
    return result('ZIP', 'container', empty ? 'ZIP archive (empty)' : summary, [
      row('Compression', 'deflate / store (per entry)'),
      row('Entries', empty ? '0' : 'not parsed'),
      row('Extension', extension === undefined ? undefined : `.${extension}`),
    ], { magic })
  }

  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const method = u8(bytes, 2)
    const flags = u8(bytes, 3)
    const mtime = u32le(bytes, 4)
    const originalName = typeof flags === 'number' && (flags & 0x08) !== 0 ? cString(bytes, 10, 128) : undefined
    const details = [
      row('Compression', method === 8 ? 'deflate' : method === 0 ? 'stored' : `method ${method ?? '?'}`),
      row('Original name', originalName === '' || originalName === undefined ? undefined : originalName),
      row('Modified', isoDate(mtime) ?? 'not recorded'),
    ]
    return result('GZIP', 'container', 'gzip compressed data', details, { magic })
  }

  if (ascii(bytes, 0, 5) === '%PDF-') {
    const version = ascii(bytes, 5, 3)
    const header = cString(bytes, 0, 64)
    return result('PDF', 'container', `PDF document ${version ?? ''}`.trim(), [
      row('Version', version),
      row('Header', header.replace(/[\r\n]+/g, ' ')),
    ], { magic })
  }

  if (
    bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    const width = u32be(bytes, 16)
    const height = u32be(bytes, 20)
    const bitDepth = u8(bytes, 24)
    const colorType = u8(bytes, 25)
    const colorNames = { 0: 'grayscale', 2: 'RGB', 3: 'indexed', 4: 'grayscale + alpha', 6: 'RGBA' }
    const summary = width !== undefined && height !== undefined ? `PNG image, ${width}x${height}` : 'PNG image'
    return result('PNG', 'media', summary, [
      row('Width', width),
      row('Height', height),
      row('Bit depth', bitDepth),
      row('Color type', colorType === undefined ? undefined : (colorNames[colorType] ?? `type ${colorType}`)),
    ], { magic })
  }

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let width
    let height
    let cursor = 2
    while (cursor + 9 < bytes.length) {
      if (bytes[cursor] !== 0xff) {
        cursor += 1
        continue
      }
      const marker = bytes[cursor + 1]
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        height = u16be(bytes, cursor + 5)
        width = u16be(bytes, cursor + 7)
        break
      }
      const length = u16be(bytes, cursor + 2)
      if (length === undefined || length < 2) break
      cursor += 2 + length
    }
    const summary = width !== undefined && height !== undefined ? `JPEG image, ${width}x${height}` : 'JPEG image'
    return result('JPEG', 'media', summary, [row('Width', width), row('Height', height)], { magic })
  }

  const gif = ascii(bytes, 0, 6)
  if (gif === 'GIF87a' || gif === 'GIF89a') {
    const width = u16le(bytes, 6)
    const height = u16le(bytes, 8)
    const summary = width !== undefined && height !== undefined ? `GIF image, ${width}x${height}` : 'GIF image'
    return result('GIF', 'media', summary, [
      row('Version', gif === 'GIF89a' ? '89a' : '87a'),
      row('Width', width),
      row('Height', height),
    ], { magic })
  }

  if (ascii(bytes, 0, 4) === 'RIFF') {
    const form = ascii(bytes, 8, 4)
    const riffSize = u32le(bytes, 4)
    if (form === 'WAVE') {
      let sampleRate
      let channels
      let bitsPerSample
      const fmt = ascii(bytes, 12, 4)
      if (fmt === 'fmt ') {
        channels = u16le(bytes, 22)
        sampleRate = u32le(bytes, 24)
        bitsPerSample = u16le(bytes, 34)
      }
      const summary = channels !== undefined && sampleRate !== undefined
        ? `WAV audio, ${channels} channel${channels === 1 ? '' : 's'}, ${sampleRate} Hz`
        : 'WAV audio'
      return result('RIFF/WAVE', 'media', summary, [
        row('Channels', channels),
        row('Sample rate', sampleRate === undefined ? undefined : `${sampleRate} Hz`),
        row('Bits per sample', bitsPerSample),
        row('Data size', riffSize === undefined ? undefined : formatBytes(riffSize)),
      ], { magic })
    }
    if (form === 'AVI ') {
      return result('RIFF/AVI', 'media', 'AVI video', [
        row('RIFF size', riffSize === undefined ? undefined : formatBytes(riffSize)),
      ], { magic })
    }
    return result('unknown', 'media', `RIFF container (${(form ?? '?').trim()} form)`, [
      row('RIFF form', (form ?? '?').trim()),
      row('RIFF size', riffSize === undefined ? undefined : formatBytes(riffSize)),
    ], { magic })
  }

  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4)
    const summary = MP4_BRANDS[brand ?? ''] ?? 'MP4 (ISO base media)'
    const compatible = []
    for (let offset = 16; offset + 4 <= Math.min(bytes.length, 64); offset += 4) {
      const entry = ascii(bytes, offset, 4)
      if (entry !== undefined && entry.trim() !== '') compatible.push(entry.trim())
    }
    return result('MP4', 'media', summary, [
      row('Major brand', brand?.trim()),
      row('Compatible brands', compatible.length > 0 ? compatible.slice(0, 6).join(', ') : undefined),
      row('Box size', u32be(bytes, 0)),
    ], { magic })
  }

  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    const probe = decodeUtf8(bytes, 0, Math.min(bytes.length, 256))
    const doctype = probe.includes('webm') ? 'WebM' : probe.includes('matroska') ? 'Matroska' : 'Matroska/WebM'
    return result('Matroska', 'media', `${doctype} video container`, [
      row('DocType', doctype),
      row('EBML header', 'present'),
    ], { magic })
  }

  if (ascii(bytes, 0, 4) === 'OggS') {
    const probe = decodeUtf8(bytes, 0, Math.min(bytes.length, 512))
    const codec = probe.includes('OpusHead')
      ? 'Opus'
      : probe.includes('vorbis')
        ? 'Vorbis'
        : probe.includes('Theora')
          ? 'Theora'
          : probe.includes('FLAC')
            ? 'FLAC'
            : undefined
    return result('Ogg', 'media', codec === undefined ? 'Ogg container' : `Ogg container (${codec})`, [
      row('Codec', codec),
      row('Page version', u8(bytes, 4)),
    ], { magic })
  }

  if (ascii(bytes, 0, 4) === 'fLaC') {
    const blockType = u8(bytes, 4)
    const blockLength = (u8(bytes, 5) ?? 0) * 65536 + ((u8(bytes, 6) ?? 0) << 8) + (u8(bytes, 7) ?? 0)
    let sampleRate
    let channels
    let bitsPerSample
    let totalSamples
    if (blockType === 0 && blockLength >= 34 && bytes.length >= 8 + 34) {
      const base = 8 + 10
      sampleRate = ((bytes[base] << 12) | (bytes[base + 1] << 4) | (bytes[base + 2] >> 4)) >>> 0
      channels = ((bytes[base + 2] >> 1) & 0x07) + 1
      bitsPerSample = (((bytes[base + 2] & 0x01) << 4) | (bytes[base + 3] >> 4)) + 1
      const high = bytes[base + 3] & 0x0f
      totalSamples = high * 2 ** 32 + ((bytes[base + 4] << 24) | (bytes[base + 5] << 16) | (bytes[base + 6] << 8) | bytes[base + 7]) >>> 0
    }
    const summary = sampleRate !== undefined && channels !== undefined
      ? `FLAC audio, ${channels} channel${channels === 1 ? '' : 's'}, ${sampleRate} Hz`
      : 'FLAC audio'
    return result('FLAC', 'media', summary, [
      row('Sample rate', sampleRate === undefined ? undefined : `${sampleRate} Hz`),
      row('Channels', channels),
      row('Bits per sample', bitsPerSample),
      row('Total samples', totalSamples),
    ], { magic })
  }

  if (ascii(bytes, 0, 6) === '7z\xbc\xaf\x27\x1c') {
    const major = u8(bytes, 6)
    const minor = u8(bytes, 7)
    return result('7z', 'container', `7-Zip archive (format ${major ?? '?'}.${minor ?? '?'})`, [
      row('Version', `${major ?? '?'}.${minor ?? '?'}`),
    ], { magic })
  }

  if (ascii(bytes, 0, 6) === 'Rar!\x1a\x07') {
    const versionByte = u8(bytes, 6)
    const label = versionByte === 0x01 ? 'RAR5' : versionByte === 0x00 ? 'RAR 1.5-4.x' : 'RAR (unknown generation)'
    return result('RAR', 'container', `${label} archive`, [row('Generation', label)], { magic })
  }

  if (ascii(bytes, 257, 5) === 'ustar') {
    const variant = ascii(bytes, 262, 3)
    const name = cString(bytes, 0, 100)
    const sizeField = cString(bytes, 124, 12).trim()
    const octalSize = /^[0-7]+$/.test(sizeField) ? Number.parseInt(sizeField, 8) : undefined
    return result('TAR', 'container', 'tar archive', [
      row('Variant', variant === '  \0' ? 'GNU tar' : 'POSIX ustar'),
      row('First entry', name === '' ? '(unnamed)' : name),
      row('First entry size', octalSize === undefined ? undefined : `${formatBytes(octalSize)}`),
    ], { magic })
  }

  return undefined
}

/**
 * Decide whether the sample looks like text, and which encoding.
 * @param {Uint8Array} bytes
 * @returns {object | undefined}
 */
function parseText(bytes) {
  if (bytes.length === 0) return undefined

  // Byte order marks settle the encoding before the NUL test, since UTF-16
  // text is full of NUL bytes.
  const bomUtf8 = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  const bomUtf16le = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe
  const bomUtf16be = bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff

  if (bomUtf16le || bomUtf16be) {
    const encoding = bomUtf16be ? 'UTF-16BE' : 'UTF-16LE'
    return result('text', 'text', `Text file (${encoding} with BOM)`, [
      row('Encoding', `${encoding} (byte order mark present)`),
    ])
  }

  const sample = bytes.subarray(0, Math.min(bytes.length, SAMPLE_LIMIT))
  let printable = 0
  let nul = 0
  let high = 0
  for (let index = 0; index < sample.length; index += 1) {
    const byte = sample[index]
    if (byte === 0) {
      nul += 1
      continue
    }
    if (byte === 0x09 || byte === 0x0a || byte === 0x0b || byte === 0x0c || byte === 0x0d) {
      printable += 1
      continue
    }
    if (byte >= 0x20 && byte <= 0x7e) {
      printable += 1
      continue
    }
    if (byte >= 0x80) {
      printable += 1
      high += 1
    }
  }

  if (nul > 0) return undefined
  if (printable / sample.length < 0.9) return undefined

  let encoding = 'ASCII'
  if (bomUtf8) {
    encoding = 'UTF-8 with BOM'
  } else if (high > 0) {
    // A successful strict decode is the cheapest way to tell UTF-8 from Latin-1.
    encoding = 'UTF-8'
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample.subarray(0, Math.min(sample.length, 8192)))
    } catch {
      encoding = '8-bit (Latin-1 or similar)'
    }
  }

  let lines = 1
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] === 0x0a) lines += 1
  }

  const summary = encoding === 'ASCII'
    ? 'Plain text (ASCII)'
    : `Text file (${encoding})`

  return result('text', 'text', summary, [
    row('Encoding', encoding),
    row('Lines in sample', lines),
    row('Sampled', formatBytes(sample.length)),
  ])
}

/**
 * Identify an opaque binary file from its leading bytes.
 *
 * Parsers run in a fixed order chosen so ambiguous magics resolve correctly:
 * `0xCAFEBABE` is claimed by Java class files before universal Mach-O binaries,
 * and structured formats are checked before the text fallback so a text-looking
 * header inside a real container cannot win.
 * @param {Uint8Array} head the first N bytes of the file (caller passes ~256 KiB; may be shorter)
 * @param {string} [extension] lowercase extension without the dot, for hints only
 * @returns {{ format: string, kind: string, summary: string,
 *   details: Array<[string, string]>,
 *   sections?: Array<{ name: string, size: number, flags: string }>,
 *   magic?: string }}
 */
export function inspectBinary(head, extension) {
  const bytes = toBytes(head)
  if (bytes.length === 0) {
    return { format: 'empty', kind: 'unknown', summary: 'Empty file', details: [] }
  }

  const ext = typeof extension === 'string' && extension !== ''
    ? extension.toLowerCase().replace(/^\./, '')
    : undefined

  const parsers = [
    (view) => parsePe(view),
    (view) => parseElf(view),
    (view) => parseJavaClass(view),
    (view) => parseMachO(view),
    (view) => parseWasm(view),
    (view) => parseAr(view),
    (view, hint) => parsePyc(view, hint),
    (view) => parseSqlite(view),
    (view) => parseIso(view),
    (view, hint) => parseGeneric(view, hint),
    (view) => parseDmg(view),
  ]

  for (const parser of parsers) {
    let found
    try {
      found = parser(bytes, ext)
    } catch {
      found = undefined
    }
    if (found !== undefined) return found
  }

  let text
  try {
    text = parseText(bytes)
  } catch {
    text = undefined
  }
  if (text !== undefined) return text

  return result('unknown', 'unknown', `Unrecognized binary data (starts with ${magicOf(bytes, 4)})`, [
    row('Leading bytes', magicOf(bytes, 8)),
    row('Sampled', formatBytes(bytes.length)),
    row('Extension', ext === undefined ? 'none' : `.${ext}`),
  ], { magic: magicOf(bytes) })
}
