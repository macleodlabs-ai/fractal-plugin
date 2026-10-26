// Local hands for the engine's run requests: the repo's own type check and tests, run in a shadow (a copy of the
// uploaded files plus the files the engine changed), never in the repo. Only the command shapes a job needs run
// (`refusal`), argv is never given to a shell, and secrets in the environment are not passed on. The shapes stop
// a request for arbitrary code; isolation is srt (on when installed): network off, writes only in the shadow.
// The tools a request needs are the app's own, found or installed by ./tools; the repo's own virtualenv, when it has
// one, is the app's interpreter, first on the run's PATH as an activated venv would be.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fractalHome } from './config'
import { notOwn } from './files'
import { exec, withoutSecrets } from './proc'
import { needRefusal, resolveTools, type Need, type ToolOpts, type Used } from './tools'

export type RunRequest = { argv: string[]; cwd?: string; files?: Record<string, string | null>; timeout_s?: number; need?: Need[] }
/** `tools`: each tool of the request's `need`, and where it came from (an install is one the engine reports). */
export type RunResult = { code: number; stdout: string; stderr: string; tools?: Used[] }
/** `testCmd`: the person's own --test-cmd, as words; `tools`: the tool cache, and whether a missing tool is installed
 * into it (default: ~/.fractal/tools, installing). */
export type RunOpts = { testCmd?: string[]; sandbox?: 'srt'; home?: string; tools?: ToolOpts }

const PYTHON = /^python(3(\.\d+)?)?$/
const PY_MODULES = new Set(['mypy', 'pytest', 'unittest'])
const CHECKERS = new Set(['mypy', 'pytest', 'tsc', 'pyright'])
/** Dependency folders: linked into the shadow, never copied or uploaded. */
const LINKED = ['node_modules', '.venv', 'venv']
/** The variables the engine may set for a run, as a leading `env K=V` (fcg/remote/jobs.py): where the code and its
 * caches are, never what loads into a program (LD_PRELOAD, NODE_OPTIONS and the like). */
const ENGINE_ENV = new Set(['PYTHONPATH', 'PYTHONDONTWRITEBYTECODE', 'PYTHONHASHSEED', 'PYTHONUNBUFFERED', 'MYPYPATH', 'NODE_PATH', 'NODE_ENV', 'CI', 'TZ'])
const DEFAULT_TIMEOUT_S = 900
const OUTPUT_LIMIT = 4 << 20

/** Where secrets live, relative to HOME, and what srt does not list as writable but allows. */
const SECRET_PLACES = ['.ssh', '.aws', '.config/gcloud', '.config/gh', '.git-credentials', '.docker/config.json', '.kube/config', '.netrc', '.npmrc', '.pypirc', '.gnupg',
  '.local/share/keyrings', '.fractal/config.json', '.codex/auth.json', '.claude', '.cursor', 'Library/Keychains']
const UNLISTED_WRITES = ['/tmp/claude', '.npm/_logs', '.claude/debug']

export function which(name: string, path = process.env.PATH ?? ''): string | undefined {
  for (const d of path.split(delimiter)) if (d && existsSync(join(d, name))) return join(d, name)
  return undefined
}

export function srtSettings(shadow: string, tmp: string, home: string) {
  const h = (p: string) => (isAbsolute(p) ? p : join(home, p))
  return {
    network: { allowedDomains: [] as string[], deniedDomains: [] as string[], strictAllowlist: true, allowLocalBinding: false, allowUnixSockets: [tmp] },
    filesystem: { denyRead: [...SECRET_PLACES.map(h), '/Library/Keychains'], allowWrite: [shadow, tmp], denyWrite: UNLISTED_WRITES.map(h) },
  }
}

export class Shadow {
  private constructor(readonly repo: string, readonly dir: string) {}

  /** A shadow of `repo` holding `files` (the uploaded set) as they are now. */
  static async create(repo: string, dir: string, files: string[]): Promise<Shadow> {
    mkdirSync(dir, { recursive: true })
    const s = new Shadow(repo, dir)
    for (const f of files) {
      const to = s.inside(f)
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(join(repo, f), to)
    }
    for (const l of LINKED) if (existsSync(join(repo, l)) && !existsSync(join(dir, l))) symlinkSync(join(repo, l), join(dir, l))
    return s
  }

  private inside(rel: string): string {
    const why = notOwn(this.dir, rel, new Set(LINKED))   // a linked folder is the repo's own: outside the shadow
    if (why) throw new Error(`${JSON.stringify(rel)} is outside the shadow (${why})`)
    return resolve(this.dir, rel)
  }

  /** Why `argv` does not run here (undefined: it does): only `python -m mypy|pytest|unittest`, `mypy`, `pytest`,
   * `tsc`, `npm test`, `node <a script in the shadow>`, and the person's own --test-cmd with what follows it. */
  private refusal(argv: string[], cwd: string, testCmd: string[]): string | undefined {
    if (testCmd.length && testCmd.every((w, i) => argv[i] === w)) return undefined
    const [prog, a1, a2] = argv
    const name = basename(prog!)
    if (PYTHON.test(name)) return a1 === '-m' && PY_MODULES.has(a2 ?? '') ? undefined : `${name} runs here only as -m mypy, pytest or unittest`
    if (CHECKERS.has(name)) return undefined
    if (name === 'npm') {
      const rest = argv.slice(2)
      const own = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest   // what follows -- goes to the repo's test script
      return a1 === 'test' && own.every(w => w === '--silent') ? undefined : 'npm runs here only as npm test'
    }
    if (name === 'node') {
      if (!a1 || a1.startsWith('-')) return 'node runs here only on a script in the local copy, with no options'
      try { this.inside(relative(this.dir, resolve(cwd, a1))) } catch (e) { return (e as Error).message }
      return undefined
    }
    return `${name} is not a type checker or test runner this client runs`
  }

  /** The engine's changes since the last run: base64 contents, null for a removed file. */
  write(files: Record<string, string | null>): void {
    const plan = Object.entries(files).map(([rel, b]) => [this.inside(rel), b] as const)   // all checked before any write
    for (const [p, b] of plan) {
      if (b === null) { rmSync(p, { force: true }); continue }
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, Buffer.from(b, 'base64'))
    }
  }

  async run(req: RunRequest, o: RunOpts): Promise<RunResult> {
    const refuse = (why: string): RunResult => ({ code: 126, stdout: '', stderr: `fractal refused to run this: ${why}` })
    let cwd: string
    try {
      if (req.files) this.write(req.files)
      cwd = this.inside(req.cwd || '.')
    } catch (e) {
      return refuse((e as Error).message)
    }
    // the engine's `env K=V …` prefix: the variables are set for the run below, and the command after them is checked
    const extra: Record<string, string> = {}
    let words = req.argv
    if (words[0] === 'env') {
      let i = 1
      for (; i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!); i++) {
        const k = words[i]!.slice(0, words[i]!.indexOf('='))
        if (!ENGINE_ENV.has(k)) return refuse(`env sets only ${[...ENGINE_ENV].join(', ')} here, not ${k}`)
        extra[k] = words[i]!.slice(k.length + 1)
      }
      words = words.slice(i)
    }
    const [prog, ...rest] = words
    if (!prog) return refuse('no command')
    const name = basename(prog)
    const why = this.refusal(words, cwd, o.testCmd ?? []) ?? req.need?.map(needRefusal).find(Boolean)
    if (why) return refuse(why)
    const env = withoutSecrets(process.env)
    Object.assign(env, extra)
    const venv = ['.venv', 'venv'].map(v => join(this.dir, v)).find(v => existsSync(join(v, 'bin', 'python')))
    if (venv) env.PATH = join(venv, 'bin') + delimiter + (env.PATH ?? '')
    let tools: Used[] | undefined
    let viaPython: string | undefined   // a bare mypy or pytest from the cache runs as <the app's python> -m <tool>
    if (req.need?.length) {
      const python = venv ? join(venv, 'bin', 'python') : which(PYTHON.test(name) ? name : 'python3', env.PATH)
      const got = await resolveTools(req.need, { shadow: this.dir, repo: this.repo, python, venv }, o.tools ?? { dir: join(fractalHome(), 'tools'), install: true })
      tools = got.used
      if (got.missing) return { code: 127, stdout: '', stderr: `fractal: ${got.missing}`, tools }
      const paths = (...xs: (string | undefined)[]) => xs.filter(Boolean).join(delimiter)
      env.PATH = paths(...got.env.path, env.PATH)
      // the tool's folders come before the person's own NODE_PATH and PYTHONPATH, after only the engine's `env K=V`
      const before = (k: 'NODE_PATH' | 'PYTHONPATH', add: string[]) => { if (add.length) env[k] = k in extra ? paths(extra[k], ...add) : paths(...add, env[k]) }
      before('NODE_PATH', got.env.nodePath)
      before('PYTHONPATH', got.env.pythonPath)
      if (prog === name && got.used.some(t => t.eco === 'pypi' && t.from !== 'repo' && t.tool === name)) viaPython = python
    }
    // an absolute program runs as given only inside the shadow or as the person wrote it; else it is looked up by name,
    // node and npm on this machine's PATH, the rest where the app's own come first
    const given = isAbsolute(prog) && existsSync(prog) && (!relative(this.dir, prog).startsWith('..') || o.testCmd?.[0] === prog)
    const exe = viaPython ?? (given ? prog : which(name, name === 'node' || name === 'npm' ? process.env.PATH : env.PATH))
    if (!exe) return { code: 127, stdout: '', stderr: `${name}: not found on this machine's PATH`, tools }
    let argv = viaPython ? [exe, '-m', name, ...rest] : [exe, ...rest]
    let tmp: string | undefined
    if (o.sandbox === 'srt') {
      const srt = which('srt')
      if (!srt) return refuse('--sandbox srt needs srt on PATH (npm install -g @anthropic-ai/sandbox-runtime); nothing ran')
      tmp = mkdtempSync(join(tmpdir(), 'fractal-sbx-'))
      const cfg = join(tmp, 'srt-settings.json')
      writeFileSync(cfg, JSON.stringify(srtSettings(this.dir, tmp, o.home ?? homedir())))
      argv = [srt, '--settings', cfg, '--', 'env', `TMPDIR=${tmp}`, ...argv]
    }
    try {
      const r = await exec(argv, { cwd, env, timeoutMs: (req.timeout_s ?? DEFAULT_TIMEOUT_S) * 1000, limit: OUTPUT_LIMIT })
      return { code: r.timedOut ? 124 : r.code, stdout: r.stdout, stderr: r.timedOut ? `${r.stderr}\nfractal: stopped after ${req.timeout_s ?? DEFAULT_TIMEOUT_S} s` : r.stderr, ...(tools ? { tools } : {}) }
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true })
    }
  }
}
