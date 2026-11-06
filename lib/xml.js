/**
 * A small, tolerant XML reader.
 *
 * The plugin parses ODF containers (`.odt`, `.ods`, `.odp`) on the Host, and
 * Node has no DOM. This reader only needs to be good enough for XML that was
 * written by an application: elements, attributes, text, CDATA, comments,
 * processing instructions and the five predefined entities plus numeric
 * character references. Namespace prefixes are kept verbatim, so callers match
 * on `text:p` rather than resolving URIs.
 */

const ENTITIES = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })

/** Expand the entities an XML document may use without a DTD. */
export function decodeEntities(text) {
  if (!text.includes('&')) return text
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body] ?? whole
  })
}

/** @typedef {{ name: string, attrs: Record<string, string>, children: any[], text?: string }} XmlNode */

function element(name, attrs) {
  return { name, attrs, children: [] }
}

/**
 * Parse an XML document into a tree.
 * @param {string} source
 * @returns {XmlNode} a synthetic `#document` node whose children are the top-level nodes
 */
export function parseXml(source) {
  const root = element('#document', {})
  const stack = [root]
  const length = source.length
  let at = 0
  let textStart = 0

  const flushText = (end) => {
    if (end <= textStart) return
    const raw = source.slice(textStart, end)
    if (raw.trim() === '' && stack.length > 0) {
      // Whitespace between elements is not content in ODF.
      return
    }
    const parent = stack[stack.length - 1]
    parent.children.push({ name: '#text', attrs: {}, children: [], text: decodeEntities(raw) })
  }

  while (at < length) {
    const open = source.indexOf('<', at)
    if (open === -1) break
    if (open > textStart) flushText(open)
    if (source.startsWith('<!--', open)) {
      const close = source.indexOf('-->', open + 4)
      at = close === -1 ? length : close + 3
    } else if (source.startsWith('<![CDATA[', open)) {
      const close = source.indexOf(']]>', open + 9)
      const body = source.slice(open + 9, close === -1 ? length : close)
      const parent = stack[stack.length - 1]
      parent.children.push({ name: '#text', attrs: {}, children: [], text: body })
      at = close === -1 ? length : close + 3
    } else if (source.startsWith('<?', open)) {
      const close = source.indexOf('?>', open + 2)
      at = close === -1 ? length : close + 2
    } else if (source.startsWith('<!', open)) {
      const close = source.indexOf('>', open + 2)
      at = close === -1 ? length : close + 1
    } else if (source[open + 1] === '/') {
      const close = source.indexOf('>', open + 2)
      const name = source.slice(open + 2, close === -1 ? length : close).trim()
      // Pop to the matching element; a mismatched close tag is ignored.
      for (let index = stack.length - 1; index > 0; index--) {
        if (stack[index].name === name) {
          stack.length = index
          break
        }
      }
      at = close === -1 ? length : close + 1
    } else {
      const tag = readTag(source, open + 1)
      if (tag === undefined) break
      const node = element(tag.name, tag.attrs)
      stack[stack.length - 1].children.push(node)
      if (!tag.selfClosing) stack.push(node)
      at = tag.end
    }
    textStart = at
  }
  return root
}

/** Read one start tag; returns its name, attributes, and whether it self-closes. */
function readTag(source, start) {
  const length = source.length
  let at = start
  while (at < length && !/[\s/>]/.test(source[at])) at++
  if (at === start) return undefined
  const name = source.slice(start, at)
  const attrs = {}
  for (;;) {
    while (at < length && /\s/.test(source[at])) at++
    if (at >= length) return undefined
    if (source[at] === '>') return { name, attrs, selfClosing: false, end: at + 1 }
    if (source[at] === '/' && source[at + 1] === '>') return { name, attrs, selfClosing: true, end: at + 2 }
    const keyStart = at
    while (at < length && !/[\s=/>]/.test(source[at])) at++
    const key = source.slice(keyStart, at)
    while (at < length && /\s/.test(source[at])) at++
    if (source[at] !== '=') {
      if (key !== '') attrs[key] = ''
      continue
    }
    at++
    while (at < length && /\s/.test(source[at])) at++
    const quote = source[at]
    if (quote === '"' || quote === "'") {
      const close = source.indexOf(quote, at + 1)
      const value = source.slice(at + 1, close === -1 ? length : close)
      attrs[key] = decodeEntities(value)
      at = close === -1 ? length : close + 1
    } else {
      const valueStart = at
      while (at < length && !/[\s>]/.test(source[at])) at++
      attrs[key] = decodeEntities(source.slice(valueStart, at))
    }
  }
}

/** Direct child elements, optionally filtered by name. */
export function childElements(node, name) {
  if (node === undefined) return []
  return node.children.filter((child) => child.name !== '#text' && (name === undefined || child.name === name))
}

/** The first direct child element with this name. */
export function firstChild(node, name) {
  if (node === undefined) return undefined
  return node.children.find((child) => child.name === name)
}

/** All descendant elements with this name, depth-first. */
export function descendants(node, name, out = []) {
  if (node === undefined) return out
  for (const child of node.children) {
    if (child.name === '#text') continue
    if (child.name === name) out.push(child)
    descendants(child, name, out)
  }
  return out
}

/** Concatenated text of a node and its descendants. */
export function textOf(node) {
  if (node === undefined) return ''
  if (node.name === '#text') return node.text ?? ''
  let out = ''
  for (const child of node.children) out += textOf(child)
  return out
}
