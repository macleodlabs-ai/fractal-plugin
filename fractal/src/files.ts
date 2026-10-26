// What the client uploads: the repo's own text files, by sha. In a git repo that is what git tracks or would track
// (.gitignore holds); elsewhere every file under the root. History, dependency folders, FCG's and Fractal's own
// outputs, env files, binaries, links and files over 1 MB never leave the machine, and each one skipped is said.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

export const MAX_FILE = 1_000_000
export const MAX_JOB = 50_000_000
/** Raw bytes per PUT /v1/jobs/{job}/files (base64 makes the body about a third larger). */
export const BATCH = 4_000_000

export const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '.fcg', '.fractal', '__pycache__', '.mypy_cache'])
const ENV_FILE = /^\.env(\..*)?$/

/** Why `rel` names no file of `root`'s own (undefined: it names one): it is absolute, climbs out with `..`, lies in a
 * folder in `skip` (in any case, since macOS ignores it), or reaches out of `root` through a link. */
export function notOwn(root: string, rel: string, skip: Set<string> = SKIP_DIRS): string | undefined {
  const parts = rel.split(/[\\/]/)
  if (isAbsolute(rel) || /^[a-z]:/i.test(rel)) return 'an absolute path'
  if (parts.includes('..')) return 'a path that climbs out with ..'
  const folder = parts.find(p => skip.has(p.toLowerCase()))
  if (folder !== undefined) return `inside ${folder}`
  let at = join(root, rel)
  for (;;) {
    try { lstatSync(at); break } catch { at = dirname(at) }   // the nearest part that exists
  }
  let real
  try { real = realpathSync(at) } catch { return 'through a link that leads nowhere' }
  const top = realpathSync(root)
  return real === top || real.startsWith(top + sep) ? undefined : 'through a link that leads out'
}

export type Listing = { files: Record<string, string>; sizes: Record<string, number>; skipped: { path: string; why: string }[]; bytes: number }

export function sha256(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex')
}

function walk(root: string, dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(root, p, out)
    else out.push(relative(root, p).split(sep).join('/'))
  }
}

function candidates(root: string): string[] {
  if (existsSync(join(root, '.git'))) {
    try {
      const out = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: root, maxBuffer: 256 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).toString()
      return out.split('\0').filter(Boolean)
    } catch {
      /* not a working tree git can read: walk it */
    }
  }
  const out: string[] = []
  walk(root, root, out)
  return out
}

/** The files to send, as {path: sha}, and why each other file was left out. */
export async function listRepo(root: string): Promise<Listing> {
  const res: Listing = { files: {}, sizes: {}, skipped: [], bytes: 0 }
  for (const path of candidates(root).sort()) {
    const parts = path.split('/')
    if (parts.some(p => SKIP_DIRS.has(p))) continue
    const full = join(root, path)
    let st
    try {
      st = lstatSync(full)
    } catch {
      continue // listed by git, deleted in the working tree
    }
    const skip = (why: string) => res.skipped.push({ path, why })
    if (st.isSymbolicLink()) { skip('a link'); continue }
    if (!st.isFile()) continue
    if (ENV_FILE.test(parts[parts.length - 1]!)) { skip('an env file'); continue }
    if (st.size > MAX_FILE) { skip('over 1 MB'); continue }
    const b = readFileSync(full)
    if (b.includes(0)) { skip('binary'); continue }
    if (res.bytes + b.length > MAX_JOB) { skip('over the 50 MB a job may hold'); continue }
    res.files[path] = sha256(b)
    res.sizes[path] = b.length
    res.bytes += b.length
  }
  return res
}

/** Groups items so each group's size stays at or under `max` (an item larger than `max` goes alone). */
export function batches<T>(items: T[], size: (x: T) => number, max = BATCH): T[][] {
  const out: T[][] = []
  let cur: T[] = []
  let n = 0
  for (const x of items) {
    const s = size(x)
    if (cur.length && n + s > max) { out.push(cur); cur = []; n = 0 }
    cur.push(x)
    n += s
  }
  if (cur.length) out.push(cur)
  return out
}
