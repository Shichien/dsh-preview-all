/**
 * OpenDocument and RTF rendering.
 *
 * `.odt` / `.ods` / `.odp` are ZIP containers holding `content.xml`; DSH's
 * builtin preview has no renderer for them, so the Host converts them to the
 * same sanitized HTML the preview panel already shows for other text. The HTML
 * is rendered inside the Sidebar's own document area, so it must be static:
 * no scripts, no external resources, and every text node escaped.
 *
 * RTF is handled by a small parser that understands the subset Word and
 * LibreOffice actually emit: groups, destinations to skip, character sets,
 * `\uN` escapes, bold/italic/underline runs, and paragraph breaks.
 */
import { readZipMember } from './archive.js'
import { childElements, descendants, firstChild, parseXml, textOf } from './xml.js'
import { suffixOf } from './kinds.js'

const ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
})

/** Escape text for HTML. */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ESCAPES[char])
}

// ---- OpenDocument ---------------------------------------------------------

/** Attributes are namespaced (`text:style-name`); match on the local name. */
function attr(node, local) {
  if (node === undefined) return undefined
  if (node.attrs[local] !== undefined) return node.attrs[local]
  for (const [key, value] of Object.entries(node.attrs)) {
    if (key.slice(key.indexOf(':') + 1) === local) return value
  }
  return undefined
}

/** A paragraph or heading as HTML. */
function paragraphHtml(node, tag) {
  const parts = []
  const walk = (current) => {
    for (const child of current.children) {
      if (child.name === '#text') {
        parts.push(escapeHtml(child.text ?? ''))
        continue
      }
      const local = child.name.slice(child.name.indexOf(':') + 1)
      if (local === 's') {
        // `text:s` is a run of spaces; the count lives in `text:c`.
        const count = Number.parseInt(attr(child, 'c') ?? '1', 10)
        parts.push(' '.repeat(Number.isFinite(count) && count > 0 && count < 200 ? count : 1))
      } else if (local === 'tab') {
        parts.push(' ')
      } else if (local === 'line-break') {
        parts.push('<br>')
      } else if (local === 'a') {
        parts.push(`<span class="doc-link">${inlineHtml(child)}</span>`)
      } else if (local === 'span') {
        parts.push(inlineHtml(child))
      } else if (local === 'note' || local === 'annotation') {
        // Footnotes and comments are omitted from the rendered body.
        continue
      } else {
        walk(child)
      }
    }
  }
  walk(node)
  const body = parts.join('')
  return body.trim() === '' ? `<${tag} class="doc-empty"></${tag}>` : `<${tag}>${body}</${tag}>`
}

function inlineHtml(node) {
  let out = ''
  for (const child of node.children) {
    if (child.name === '#text') out += escapeHtml(child.text ?? '')
    else if (child.name.endsWith(':s')) out += ' '
    else if (child.name.endsWith(':tab')) out += ' '
    else if (child.name.endsWith(':line-break')) out += '<br>'
    else out += inlineHtml(child)
  }
  return out
}

/** `text:h` maps to `h1`–`h6` by its outline level. */
function headingTag(node) {
  const level = Number.parseInt(attr(node, 'outline-level') ?? '1', 10)
  const safe = Number.isFinite(level) ? Math.min(6, Math.max(1, level)) : 1
  return `h${safe}`
}

/** Render an ODF `office:text`-like body. */
function odfBodyHtml(body) {
  const out = []
  for (const node of childElements(body)) {
    const local = node.name.slice(node.name.indexOf(':') + 1)
    if (local === 'h') out.push(paragraphHtml(node, headingTag(node)))
    else if (local === 'p') out.push(paragraphHtml(node, 'p'))
    else if (local === 'list') out.push(listHtml(node))
    else if (local === 'section' || local === 'frame' || local === 'index-body') out.push(odfBodyHtml(node))
    else if (local === 'table') out.push(tableHtml(node))
  }
  return out.join('\n')
}

function listHtml(node) {
  const items = []
  for (const item of childElements(node)) {
    const local = item.name.slice(item.name.indexOf(':') + 1)
    if (local !== 'list-item') continue
    const inner = odfBodyHtml(item)
    items.push(`<li>${inner.replace(/^<p>/, '').replace(/<\/p>$/, '')}</li>`)
  }
  return `<ul>${items.join('')}</ul>`
}

function tableHtml(node) {
  const rows = []
  for (const row of descendants(node, 'table:table-row')) {
    const cells = []
    for (const cell of childElements(row)) {
      const local = cell.name.slice(cell.name.indexOf(':') + 1)
      if (local !== 'table-cell' && local !== 'covered-table-cell') continue
      const span = Number.parseInt(attr(cell, 'number-columns-spanned') ?? '1', 10)
      const inner = odfBodyHtml(cell).replace(/^<p>/, '').replace(/<\/p>$/, '')
      const attribute = Number.isFinite(span) && span > 1 ? ` colspan="${Math.min(span, 50)}"` : ''
      cells.push(`<td${attribute}>${inner}</td>`)
    }
    if (cells.length > 0) rows.push(`<tr>${cells.join('')}</tr>`)
  }
  return `<table class="doc-table">${rows.join('')}</table>`
}

/** Render an ODF `content.xml` for the requested kind. */
function odfContentHtml(xml, kind) {
  const root = parseXml(xml)
  const body = descendants(root, 'office:body')[0]
  if (body === undefined) return '<p class="doc-empty"></p>'
  if (kind === 'ods') {
    const sheet = descendants(body, 'table:table')[0]
    if (sheet === undefined) return '<p class="doc-empty"></p>'
    const name = attr(sheet, 'name')
    const head = name === undefined ? '' : `<h2>${escapeHtml(name)}</h2>`
    return head + tableHtml(sheet)
  }
  if (kind === 'odp') {
    const pages = []
    for (const page of descendants(body, 'draw:page')) {
      const title = attr(page, 'name') ?? ''
      const text = odfBodyHtml(page)
      pages.push(`<section class="doc-slide"><h2>${escapeHtml(title)}</h2>${text}</section>`)
    }
    return pages.join('\n')
  }
  const text = descendants(body, 'office:text')[0]
  if (text !== undefined) return odfBodyHtml(text)
  return odfBodyHtml(body)
}

/**
 * Convert an ODF document into preview HTML.
 * @param {Uint8Array} bytes the whole `.odt`/`.ods`/`.odp` file
 * @param {string} name filename, used for the kind and the title
 * @returns {{ title: string, html: string, note?: string }}
 */
export function odfToHtml(bytes, name) {
  const kind = suffixOf(name)
  const content = readZipMember(bytes, 'content.xml', { maxBytes: 64 * 1024 * 1024 })
  if (content === undefined) throw new Error('content.xml is missing; the file is not an OpenDocument package')
  const xml = new TextDecoder('utf-8').decode(content)
  const root = parseXml(xml)
  const meta = descendants(root, 'office:meta')[0]
  const title = (meta === undefined ? undefined : textOf(firstChild(meta, 'dc:title')))?.trim()
  return {
    title: title !== undefined && title !== '' ? title : name,
    html: odfContentHtml(xml, kind),
  }
}

// ---- RTF ------------------------------------------------------------------

/** Destinations whose groups are not document text. */
const SKIP = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'headerl',
  'headerr', 'footerl', 'footerr', 'listtable', 'listoverridetable', 'rsidtbl', 'generator',
  'xmlnstbl', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'filetbl',
  'revtbl', 'pgptbl', 'pnseclvl', 'field', 'fldinst', 'bkmkstart', 'bkmkend', 'xe', 'tc',
])

/** Codepages used by the `\ansicpg` control word. */
const CODEPAGES = { 1252: 'windows-1252', 1251: 'windows-1251', 1250: 'windows-1250', 1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258', 874: 'windows-874', 437: 'ibm437', 850: 'ibm850', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5' }

/**
 * Convert RTF into preview HTML.
 * @param {Uint8Array} bytes
 * @param {string} name
 * @returns {{ title: string, html: string }}
 */
export function rtfToHtml(bytes, name) {
  const source = new TextDecoder('latin1').decode(bytes)
  let at = 0
  const out = []
  const stack = []
  let state = { bold: false, italic: false, underline: false, skip: false }
  let pendingSkip = false
  let codepage = 'windows-1252'
  /** `\uc` — how many fallback characters follow a `\uN` escape. */
  let unicodeSkip = 1

  const push = (text) => {
    if (text === '' || state.skip) return
    let html = escapeHtml(text)
    if (state.bold) html = `<strong>${html}</strong>`
    if (state.italic) html = `<em>${html}</em>`
    if (state.underline) html = `<u>${html}</u>`
    out.push(html)
  }

  const decodeByte = (byte) => {
    try {
      return new TextDecoder(codepage).decode(new Uint8Array([byte]))
    } catch {
      return String.fromCharCode(byte)
    }
  }

  while (at < source.length) {
    const char = source[at]
    if (char === '{') {
      stack.push({ ...state, unicodeSkip })
      if (pendingSkip) {
        state.skip = true
        pendingSkip = false
      }
      at++
      continue
    }
    if (char === '}') {
      const previous = stack.pop()
      if (previous !== undefined) {
        unicodeSkip = previous.unicodeSkip
        state = { ...previous }
      }
      at++
      continue
    }
    if (char === '\\') {
      const next = source[at + 1]
      if (next === undefined) break
      if (next === "'") {
        // `\'hh` — one byte in the current codepage.
        const byte = Number.parseInt(source.slice(at + 2, at + 4), 16)
        if (Number.isFinite(byte)) push(decodeByte(byte))
        at += 4
        continue
      }
      if (next === '\\' || next === '{' || next === '}') {
        push(next)
        at += 2
        continue
      }
      if (next === '*') {
        // `\*` marks a destination to ignore.
        pendingSkip = true
        at += 2
        continue
      }
      if (next === '~') {
        push('\u00a0')
        at += 2
        continue
      }
      if (next === '-' || next === '_' || next === '|') {
        at += 2
        continue
      }
      // Control word: letters, optional signed parameter, optional space.
      let cursor = at + 1
      const wordStart = cursor
      while (cursor < source.length && /[a-zA-Z]/.test(source[cursor])) cursor++
      const word = source.slice(wordStart, cursor)
      let parameter
      const numberStart = cursor
      if (source[cursor] === '-') cursor++
      while (cursor < source.length && /[0-9]/.test(source[cursor])) cursor++
      if (cursor > numberStart) parameter = Number.parseInt(source.slice(numberStart, cursor), 10)
      if (source[cursor] === ' ') cursor++
      at = cursor
      if (word === '') continue
      if (SKIP.has(word)) {
        state.skip = true
        pendingSkip = false
        continue
      }
      switch (word) {
        case 'ansicpg':
          if (parameter !== undefined && CODEPAGES[parameter] !== undefined) codepage = CODEPAGES[parameter]
          break
        case 'uc':
          unicodeSkip = parameter !== undefined && parameter >= 0 ? Math.min(parameter, 4) : 1
          break
        case 'u': {
          if (parameter === undefined) break
          const code = parameter < 0 ? parameter + 65536 : parameter
          push(String.fromCharCode(code))
          // Skip the ANSI fallback that follows the escape.
          let skipped = 0
          while (skipped < unicodeSkip && at < source.length && source[at] !== '\\' && source[at] !== '{' && source[at] !== '}') {
            at++
            skipped++
          }
          break
        }
        case 'b':
          state.bold = parameter === undefined || parameter !== 0
          break
        case 'i':
          state.italic = parameter === undefined || parameter !== 0
          break
        case 'ul':
          state.underline = parameter === undefined || parameter !== 0
          break
        case 'ulnone':
          state.underline = false
          break
        case 'plain':
          state.bold = false
          state.italic = false
          state.underline = false
          break
        case 'par':
        case 'line':
        case 'sect':
        case 'page':
          if (!state.skip) out.push('</p>\n<p>')
          break
        case 'tab':
          push('\u00a0\u00a0\u00a0\u00a0')
          break
        case 'emdash':
          push('\u2014')
          break
        case 'endash':
          push('\u2013')
          break
        case 'lquote':
          push('\u2018')
          break
        case 'rquote':
          push('\u2019')
          break
        case 'ldblquote':
          push('\u201c')
          break
        case 'rdblquote':
          push('\u201d')
          break
        case 'bullet':
          push('\u2022')
          break
        case 'cell':
        case 'row':
          if (!state.skip) out.push(' ')
          break
        default:
          break
      }
      continue
    }
    if (char === '\r' || char === '\n') {
      at++
      continue
    }
    if (char === '\t') {
      push('\u00a0\u00a0\u00a0\u00a0')
      at++
      continue
    }
    // A run of plain characters.
    let end = at
    while (end < source.length && !'\\{}'.includes(source[end]) && source[end] !== '\r' && source[end] !== '\n') end++
    if (end === at) {
      at++
      continue
    }
    push(source.slice(at, end))
    at = end
  }

  const body = out.join('').replace(/(<p>\s*<\/p>\s*)+/g, '').trim()
  return { title: name, html: `<p>${body}</p>` }
}

/**
 * Convert a document this plugin owns into preview HTML.
 * @param {Uint8Array} bytes
 * @param {string} name
 * @returns {{ title: string, html: string }}
 */
export function documentToHtml(bytes, name) {
  const suffix = suffixOf(name)
  if (suffix === 'rtf') return rtfToHtml(bytes, name)
  return odfToHtml(bytes, name)
}
