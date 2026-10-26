// Unified diffs as the engine writes them (difflib: `a/` and `b/` prefixes, /dev/null for a created or removed file,
// "\ No newline at end of file"). Applying is exact: every hunk must find its old lines where it says, or nothing
// is written. A patch never merges into a file that moved on.

export class PatchError extends Error {}

type Line = { op: ' ' | '-' | '+'; text: string }
type Hunk = { oldStart: number; oldLen: number; newStart: number; newLen: number; lines: Line[] }
type FilePatch = { from: string | null; to: string | null; hunks: Hunk[] }

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

function pathOf(header: string): string | null {
  const p = header.slice(4).split('\t')[0]!.trim()
  if (p === '/dev/null') return null
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p
}

export function parsePatch(text: string): FilePatch[] {
  const lines = text.split('\n')
  const out: FilePatch[] = []
  let file: FilePatch | undefined
  let hunk: Hunk | undefined
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (l.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      file = { from: pathOf(l), to: pathOf(lines[i + 1]!), hunks: [] }
      out.push(file)
      hunk = undefined
      i++
      continue
    }
    const m = HUNK.exec(l)
    if (m && file) {
      hunk = { oldStart: +m[1]!, oldLen: m[2] === undefined ? 1 : +m[2], newStart: +m[3]!, newLen: m[4] === undefined ? 1 : +m[4], lines: [] }
      file.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (l.startsWith('\\')) {
      const last = hunk.lines[hunk.lines.length - 1]
      if (last) last.text = last.text.replace(/\n$/, '')
      continue
    }
    const op = l[0]
    if (op === ' ' || op === '-' || op === '+') hunk.lines.push({ op, text: l.slice(1) + '\n' })
    else if (l === '' && i === lines.length - 1) continue
    else throw new PatchError(`not a unified diff line: ${JSON.stringify(l.slice(0, 80))}`)
  }
  return out
}

/** The files a patch writes, created, changed or removed. */
export function patchedFiles(text: string): string[] {
  return parsePatch(text).map(f => (f.to ?? f.from)!)
}

function splitKeep(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? []
}

function applyOne(f: FilePatch, current: string | undefined): string | null {
  const name = (f.to ?? f.from)!
  if (f.from === null && current !== undefined) throw new PatchError(`${name} exists already: a created file never overwrites one`)
  if (f.from !== null && current === undefined) throw new PatchError(`${name} is missing`)
  const old = splitKeep(current ?? '')
  const out: string[] = []
  let at = 0
  for (const h of f.hunks) {
    const start = h.oldLen === 0 ? h.oldStart : h.oldStart - 1
    if (start < at) throw new PatchError(`${name}: hunks overlap`)
    out.push(...old.slice(at, start))
    let k = start
    for (const l of h.lines) {
      if (l.op === '+') { out.push(l.text); continue }
      if (old[k] !== l.text) throw new PatchError(`${name} changed since the job read it (line ${k + 1})`)
      if (l.op === ' ') out.push(l.text)
      k++
    }
    at = k
  }
  out.push(...old.slice(at))
  if (f.to === null) {
    if (out.length) throw new PatchError(`${name} changed since the job read it`)
    return null
  }
  return out.join('')
}

/** Every file the patch writes, as it would be (null: removed). Throws PatchError, and nothing is meant to be written, if any file does not match. */
export function applyPatch(read: (path: string) => string | undefined, text: string): Record<string, string | null> {
  const res: Record<string, string | null> = {}
  for (const f of parsePatch(text)) {
    const name = (f.to ?? f.from)!
    res[name] = applyOne(f, name in res ? (res[name] ?? undefined) : read(name))
  }
  return res
}

function render(f: FilePatch): string {
  const head = (p: string | null, side: 'a' | 'b') => (p === null ? '/dev/null' : `${side}/${p}`)
  const out = [`--- ${head(f.from, 'a')}`, `+++ ${head(f.to, 'b')}`]
  for (const h of f.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLen} +${h.newStart},${h.newLen} @@`)
    for (const l of h.lines) {
      out.push(l.op + l.text.replace(/\n$/, ''))
      if (!l.text.endsWith('\n')) out.push('\\ No newline at end of file')
    }
  }
  return out.join('\n') + '\n'
}

/** The patch that undoes `text` on the files it produced. */
export function reversePatch(text: string): string {
  const swap = { ' ': ' ', '-': '+', '+': '-' } as const
  return parsePatch(text)
    .map(f => render({
      from: f.to, to: f.from,
      hunks: f.hunks.map(h => ({ oldStart: h.newStart, oldLen: h.newLen, newStart: h.oldStart, newLen: h.oldLen, lines: h.lines.map(l => ({ op: swap[l.op], text: l.text })) })),
    }))
    .join('')
}
