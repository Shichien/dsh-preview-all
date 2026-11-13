/**
 * What the stress run does to each format group.
 *
 * A scenario drives real requests and states two things:
 *   - `expect(...)`: what must be true of the answers (functional outcome);
 *   - `budget`: how much the Host may cost while answering — `peakMiB` is the
 *     extra peak resident memory of the process (parser worker included),
 *     `stallMs` the longest time the Host's event loop was blocked. The Host
 *     shares that loop with the rest of DSH, so a long stall is the GUI freezing.
 *
 * Budgets follow from the limits the code enforces, not from what a run
 * happened to measure:
 *   - nothing may block the Host's loop for long: parsing runs on a worker,
 *     and everything else is streamed or reads a bounded piece;
 *   - streamed and ranged kinds cost a few read windows, whatever the file size;
 *   - a buffered archive costs its file (at most 192 MiB) plus its expanded
 *     form (at most 192 MiB), which a growing decoder briefly holds twice;
 *   - a raster costs a few full-size buffers at the 64-megapixel cap;
 *   - a document costs its parse tree, under the worker's heap ceiling.
 */
import { existsSync } from 'node:fs'
import { GIB, MIB, SYSTEM_FONTS } from './fixtures.mjs'

const kib = (bytes) => `${Math.round(bytes / 1024)} KiB`
const mib = (bytes) => `${(bytes / MIB).toFixed(1)} MiB`

/** The shared shape of the decompression-bomb scenarios. */
function bombScenario(name, fixture, title, budget) {
  return {
    name,
    title,
    needs: [fixture],
    budget,
    async run({ host, file, expect, note }) {
      const info = await host.get('info', file(fixture))
      expect(info.status === 200, `info answered ${info.status}`)
      const listed = info.json?.kind === 'archive'
      if (listed) {
        expect(info.json.archive.entries.some((entry) => entry.name === 'note.txt'), 'the listing names note.txt')
        const member = await host.get('entry', file(fixture), { query: { entry: 'note.txt' } })
        expect(member.status === 200 && member.text === 'the note after the zeros\n', `note.txt answered ${member.status}`)
        const zeros = await host.get('entry', file(fixture), { query: { entry: 'zeros.bin' } })
        expect(zeros.status === 413, `the 500 MiB member answered ${zeros.status}, expected 413`)
        note(`listed as ${info.json.archive.format}`)
      } else {
        // Declining is a valid outcome as long as it is cheap and says why.
        expect(info.json?.kind === 'binary' && typeof info.json?.notice === 'string', 'a refusal must explain itself')
        note(`declined: ${info.json?.notice}`)
      }
    },
  }
}

/** No scenario may hold the Host's event loop longer than this. */
const STALL_MS = 150
/** Streamed and ranged kinds. */
const STREAMED = { peakMiB: 64, stallMs: STALL_MS }
/** A tiny compressed file that expands up to the 192 MiB output cap, held twice while a buffer grows. */
const EXPANDED = { peakMiB: 2 * 192 + 64, stallMs: STALL_MS }
/** A buffered archive near the 192 MiB file cap: one request's bytes may outlive the previous one's. */
const BUFFERED = { peakMiB: 2 * 192 + 96, stallMs: STALL_MS }
/** Up to three full-size RGB buffers at the 64-megapixel cap, plus the file. */
const RASTER = { peakMiB: 3 * 192 + 64, stallMs: STALL_MS }
/** A document's parse tree; the worker's 768 MiB heap ceiling is the hard stop. */
const DOCUMENT = { peakMiB: 512, stallMs: STALL_MS }

export const SCENARIOS = [
  // ---- archives -------------------------------------------------------------
  {
    name: 'zip64-5g',
    title: '5 GiB ZIP64: list, read a member stored past 4 GiB, refuse the 5 GiB member',
    needs: ['huge.zip'],
    budget: STREAMED,
    async run({ host, file, expect, note }) {
      const info = await host.get('info', file('huge.zip'))
      expect(info.status === 200 && info.json?.kind === 'archive', `info answered ${info.status} as ${info.json?.kind}: ${info.json?.notice ?? ''}`)
      const entries = info.json?.archive?.entries ?? []
      expect(entries.length === 2 && entries[0].size === 5 * GIB, `entries: ${JSON.stringify(entries.map((entry) => [entry.name, entry.size]))}`)
      const member = await host.get('entry', file('huge.zip'), { query: { entry: 'docs/readme.txt' } })
      expect(member.status === 200 && member.text?.includes('four gigabyte'), `member answered ${member.status}`)
      const big = await host.get('entry', file('huge.zip'), { query: { entry: 'big.bin' } })
      expect(big.status === 413, `the 5 GiB member answered ${big.status}, expected 413`)
      expect(host.reads.rangedBytes <= MIB, `read ${kib(host.reads.rangedBytes)} for a listing and one small member`)
      note(`read ${kib(host.reads.rangedBytes)} of 5 GiB`)
    },
  },
  {
    name: 'zip-200k',
    title: 'ZIP with 200,000 entries: list, then look up the last one',
    needs: ['many.zip'],
    budget: { peakMiB: 128, stallMs: STALL_MS },
    async run({ host, file, expect, note }) {
      const info = await host.get('info', file('many.zip'))
      expect(info.status === 200 && info.json?.kind === 'archive', `info answered ${info.status} as ${info.json?.kind}: ${info.json?.notice ?? ''}`)
      expect(info.json?.archive?.entries?.length === 5000, `listing carries ${info.json?.archive?.entries?.length} entries`)
      expect(/truncated/.test(info.json?.archive?.note ?? ''), 'a truncated listing says so')
      const last = await host.get('entry', file('many.zip'), { query: { entry: 'dir-499/entry-199999.txt' } })
      expect(last.status === 200 && last.bytes === 0, `the last entry answered ${last.status}`)
      // This file is almost nothing but directory; the lookup has to read all of it.
      note(`listing JSON ${kib(info.bytes)}; lookup ${last.ms} ms`)
    },
  },
  {
    name: 'tar-150k',
    title: '175 MiB TAR with 150,000 members: list, extract, refuse a 28 MiB member',
    needs: ['wide.tar'],
    budget: BUFFERED,
    async run({ host, file, expect, note }) {
      const info = await host.get('info', file('wide.tar'))
      expect(info.status === 200 && info.json?.kind === 'archive', `info answered ${info.status} as ${info.json?.kind}: ${info.json?.notice ?? ''}`)
      expect(info.json?.archive?.entries?.length === 5000, `listing carries ${info.json?.archive?.entries?.length} entries`)
      const member = await host.get('entry', file('wide.tar'), { query: { entry: 'dir-499/file-149999.txt' } })
      expect(member.status === 200 && member.text?.startsWith('member 149999'), `member answered ${member.status}`)
      const large = await host.get('entry', file('wide.tar'), { query: { entry: 'tail/large.bin' } })
      expect(large.status === 413, `the 28 MiB member answered ${large.status}, expected 413`)
      note(`list ${info.ms} ms, extract ${member.ms} ms`)
    },
  },
  {
    name: 'tar-x6',
    title: 'Six previews of a 175 MiB TAR at once (a restored session)',
    needs: ['wide.tar'],
    budget: BUFFERED,
    async run({ host, file, expect, note }) {
      const answers = await Promise.all(Array.from({ length: 6 }, () => host.get('info', file('wide.tar'))))
      expect(answers.every((answer) => answer.status === 200 && answer.json?.kind === 'archive'), `statuses ${answers.map((answer) => answer.status)}`)
      // Six files side by side would be over 1 GiB: the memory budget is the check.
      note(`slowest answer ${Math.max(...answers.map((answer) => answer.ms))} ms`)
    },
  },
  bombScenario('targz-bomb', 'zeros.tar.gz', '0.5 MiB .tar.gz that expands to 500 MiB', STREAMED),
  bombScenario('tarzst-bomb', 'zeros.tar.zst', 'Tiny .tar.zst that expands to 500 MiB', EXPANDED),
  bombScenario('tarbz2-bomb', 'zeros.tar.bz2', 'Tiny .tar.bz2 that expands to 500 MiB (pure-JS decoder)', EXPANDED),
  bombScenario('tarxz-bomb', 'zeros.tar.xz', 'Tiny .tar.xz that expands to 500 MiB (pure-JS decoder)', EXPANDED),
  {
    name: 'gz-bomb',
    title: 'Bare .gz that expands to 600 MiB',
    needs: ['bomb.gz'],
    budget: STREAMED,
    async run({ host, file, expect, note }) {
      const info = await host.get('info', file('bomb.gz'))
      expect(info.status === 200, `info answered ${info.status}`)
      if (info.json?.kind === 'archive') {
        const [entry] = info.json.archive.entries
        expect(entry?.size === 600 * MIB, `the stream's size is reported as ${entry?.size}`)
        note(`listed as ${info.json.archive.format}, ${mib(entry?.size ?? 0)} inside`)
      } else {
        expect(typeof info.json?.notice === 'string', 'a refusal must explain itself')
        note(`declined: ${info.json?.notice}`)
      }
    },
  },
  {
    name: 'tarbz2-text',
    title: '32 MiB of text as .tar.bz2 (pure-JS decoder): list and extract',
    needs: ['text.tar.bz2'],
    budget: { peakMiB: 200, stallMs: STALL_MS },
    async run({ host, file, expect, note }) {
      const info = await host.get('info', file('text.tar.bz2'))
      expect(info.status === 200 && info.json?.kind === 'archive' && info.json.archive.entries.length === 32, `info answered ${info.status} as ${info.json?.kind}: ${info.json?.notice ?? ''}`)
      const member = await host.get('entry', file('text.tar.bz2'), { query: { entry: 'chapter-31.txt' } })
      expect(member.status === 200 && member.bytes > MIB - 64, `member answered ${member.status} with ${member.bytes} bytes`)
      note(`list ${info.ms} ms, extract ${member.ms} ms`)
    },
  },
  {
    name: 'tarxz-text',
    title: '32 MiB of text as .tar.xz (pure-JS decoder): list and extract',
    needs: ['text.tar.xz'],
    budget: { peakMiB: 200, stallMs: STALL_MS },
    async run({ host, file, expect, note }) {
      const info = await host.get('info', file('text.tar.xz'))
      expect(info.status === 200 && info.json?.kind === 'archive' && info.json.archive.entries.length === 32, `info answered ${info.status} as ${info.json?.kind}: ${info.json?.notice ?? ''}`)
      const member = await host.get('entry', file('text.tar.xz'), { query: { entry: 'chapter-31.txt' } })
      expect(member.status === 200 && member.bytes > MIB - 64, `member answered ${member.status} with ${member.bytes} bytes`)
      note(`list ${info.ms} ms, extract ${member.ms} ms`)
    },
  },
  {
    name: '7z-100k',
    title: '7z with 100,000 entries: list',
    needs: ['names.7z'],
    budget: { peakMiB: 128, stallMs: STALL_MS },
    async run({ host, file, expect, note }) {
      const info = await host.get('info', file('names.7z'))
      expect(info.status === 200 && info.json?.kind === 'archive', `info answered ${info.status} as ${info.json?.kind}: ${info.json?.notice ?? ''}`)
      expect(info.json?.archive?.entries?.length === 5000, `listing carries ${info.json?.archive?.entries?.length} entries`)
      note(`list ${info.ms} ms, JSON ${kib(info.bytes)}`)
    },
  },

  // ---- rasters --------------------------------------------------------------
  {
    name: 'tiff-photo',
    title: '90 MiB uncompressed TIFF, 5600×5600: decode to PNG',
    needs: ['photo.tiff'],
    budget: RASTER,
    async run({ host, file, expect, note }) {
      const info = await host.get('info', file('photo.tiff'))
      expect(info.status === 200 && info.json?.kind === 'raster', `info answered ${info.status} as ${info.json?.kind}`)
      const png = await host.get('raster', file('photo.tiff'))
      expect(png.status === 200 && png.headers['content-type'] === 'image/png', `raster answered ${png.status}: ${png.text ?? png.json?.error ?? ''}`)
      note(`PNG ${mib(png.bytes)} in ${png.ms} ms`)
    },
  },
  {
    name: 'tiff-blank',
    title: '0.2 MiB deflated TIFF that is 8192×8192 (192 MiB of pixels)',
    needs: ['blank.tiff'],
    budget: RASTER,
    async run({ host, file, expect, note }) {
      const png = await host.get('raster', file('blank.tiff'))
      expect(png.status === 200 || png.status === 413 || png.status === 422, `raster answered ${png.status}`)
      note(png.status === 200 ? `PNG ${mib(png.bytes)} in ${png.ms} ms` : `declined ${png.status}: ${png.json?.error ?? png.text ?? ''}`)
    },
  },
  {
    name: 'psd-blank',
    title: '3 MiB RLE PSD that is 8192×8192 (192 MiB of pixels)',
    needs: ['blank.psd'],
    budget: RASTER,
    async run({ host, file, expect, note }) {
      const png = await host.get('raster', file('blank.psd'))
      expect(png.status === 200 || png.status === 413 || png.status === 422, `raster answered ${png.status}`)
      note(png.status === 200 ? `PNG ${mib(png.bytes)} in ${png.ms} ms` : `declined ${png.status}: ${png.json?.error ?? png.text ?? ''}`)
    },
  },

  // ---- documents ------------------------------------------------------------
  {
    name: 'rtf-long',
    title: '90 MiB RTF: render',
    needs: ['long.rtf'],
    budget: DOCUMENT,
    async run({ host, file, expect, note }) {
      const info = await host.get('info', file('long.rtf'))
      expect(info.status === 200, `info answered ${info.status}`)
      const kind = info.json?.kind ?? /"kind":"(\w+)"/.exec(info.head ?? '')?.[1]
      expect(kind === 'document', `rendered as ${kind}`)
      // The whole answer becomes one iframe document in the Sidebar.
      expect(info.bytes <= 4 * MIB, `the panel would receive ${mib(info.bytes)} of HTML`)
      expect(info.json?.document?.truncated === true, 'a shortened document must say so')
      note(`answer ${mib(info.bytes)} in ${info.ms} ms`)
    },
  },
  {
    name: 'odt-long',
    title: 'ODT whose content.xml is 60 MiB: render',
    needs: ['long.odt'],
    budget: DOCUMENT,
    async run({ host, file, expect, note }) {
      const info = await host.get('info', file('long.odt'))
      expect(info.status === 200, `info answered ${info.status}`)
      const kind = info.json?.kind ?? /"kind":"(\w+)"/.exec(info.head ?? '')?.[1]
      expect(kind === 'document', `rendered as ${kind}: ${info.json?.notice ?? ''}`)
      expect(info.bytes <= 4 * MIB, `the panel would receive ${mib(info.bytes)} of HTML`)
      expect(info.json?.document?.truncated === true, 'a shortened document must say so')
      note(`answer ${mib(info.bytes)} in ${info.ms} ms`)
    },
  },

  // ---- fonts ----------------------------------------------------------------
  {
    name: 'font-system',
    title: 'Real system fonts (up to 19 MiB collections): describe and serve',
    needs: [],
    available: () => SYSTEM_FONTS.some((font) => existsSync(font)),
    budget: { peakMiB: 96, stallMs: STALL_MS },
    async run({ host, expect, note }) {
      const seen = []
      for (const font of SYSTEM_FONTS.filter((candidate) => existsSync(candidate))) {
        const info = await host.get('info', font)
        expect(info.status === 200 && info.json?.kind === 'font' && typeof info.json.font?.family === 'string', `${font}: info answered ${info.status} as ${info.json?.kind}, family ${info.json?.font?.family}`)
        const bytes = await host.get('font', font)
        expect(bytes.status === 200 && bytes.bytes === info.json?.size, `${font}: served ${bytes.bytes} of ${info.json?.size} bytes`)
        seen.push(`${info.json?.font?.family} ${mib(bytes.bytes)} ${info.ms} ms`)
      }
      note(seen.join('; '))
    },
  },
  {
    name: 'font-padded',
    title: '63 MiB font file (just under the cap): describe and serve',
    needs: ['padded.ttf'],
    budget: { peakMiB: 160, stallMs: STALL_MS },
    async run({ host, file, expect, note }) {
      const info = await host.get('info', file('padded.ttf'))
      expect(info.status === 200 && info.json?.kind === 'font', `info answered ${info.status} as ${info.json?.kind}`)
      const bytes = await host.get('font', file('padded.ttf'))
      expect(bytes.status === 200 && bytes.bytes === 63 * MIB, `served ${bytes.bytes} bytes`)
      note(`describe ${info.ms} ms, serve ${bytes.ms} ms`)
    },
  },

  // ---- streamed kinds -------------------------------------------------------
  {
    name: 'binary-5g',
    title: '5 GiB disk image: describe',
    needs: ['huge.iso'],
    budget: STREAMED,
    async run({ host, file, expect, note }) {
      const info = await host.get('info', file('huge.iso'))
      expect(info.status === 200 && info.json?.kind === 'binary', `info answered ${info.status} as ${info.json?.kind}`)
      expect(host.reads.rangedBytes <= MIB, `read ${kib(host.reads.rangedBytes)}`)
      note(`read ${kib(host.reads.rangedBytes)} of 5 GiB`)
    },
  },
  {
    name: 'media-5g',
    title: '5 GiB video: seek near the end, then start a full read and close the tab',
    needs: ['huge.mp4'],
    budget: STREAMED,
    async run({ host, file, expect, note }) {
      const info = await host.get('info', file('huge.mp4'))
      expect(info.status === 200 && info.json?.kind === 'media', `info answered ${info.status} as ${info.json?.kind}`)
      const size = info.json?.size ?? 0
      const seek = await host.get('stream', file('huge.mp4'), { headers: { range: `bytes=${size - 8 * MIB}-` } })
      expect(seek.status === 206 && seek.bytes === 8 * MIB, `seek answered ${seek.status} with ${seek.bytes} bytes`)
      expect(seek.headers['content-range'] === `bytes ${size - 8 * MIB}-${size - 1}/${size}`, `content-range ${seek.headers['content-range']}`)
      const before = host.reads.rangedBytes
      const whole = await host.get('stream', file('huge.mp4'), { abortAfter: 16 * MIB })
      await host.settle()
      const read = host.reads.rangedBytes - before
      expect(whole.status === 200 && read <= 64 * MIB, `after the tab closed the Host had read ${mib(read)}`)
      await host.settle(300)
      expect(host.reads.rangedBytes - before === read, 'the read loop kept going after the connection closed')
      note(`closed after 16 MiB; Host read ${mib(read)} of 5 GiB`)
    },
  },
  {
    name: 'picture-5g',
    title: '5 GiB file with an image suffix: start loading, then close',
    needs: ['huge.heic'],
    budget: STREAMED,
    async run({ host, file, expect, note }) {
      const picture = await host.get('picture', file('huge.heic'), { abortAfter: 16 * MIB })
      await host.settle()
      const read = host.reads.rangedBytes
      expect(picture.status === 200 && read <= 64 * MIB, `picture answered ${picture.status}; Host read ${mib(read)}`)
      await host.settle(300)
      expect(host.reads.rangedBytes === read, 'the read loop kept going after the connection closed')
      note(`closed after 16 MiB; Host read ${mib(read)} of 5 GiB`)
    },
  },
  {
    name: 'download-5g',
    title: '5 GiB download: a ranged request, then one cancelled part-way',
    needs: ['huge.zip'],
    budget: STREAMED,
    async run({ host, file, expect, note }) {
      // A window that starts past the 32-bit offset line.
      const part = await host.get('download', file('huge.zip'), { headers: { range: `bytes=${4 * GIB + 1}-${4 * GIB + 4 * MIB}` } })
      expect(part.status === 206 && part.bytes === 4 * MIB, `range answered ${part.status} with ${part.bytes} bytes`)
      const before = host.reads.rangedBytes
      const whole = await host.get('download', file('huge.zip'), { abortAfter: 16 * MIB })
      await host.settle()
      const read = host.reads.rangedBytes - before
      expect(whole.status === 200 && read <= 64 * MIB, `download answered ${whole.status}; Host read ${mib(read)}`)
      note(`cancelled after 16 MiB; Host read ${mib(read)} of 5 GiB`)
    },
  },
]
