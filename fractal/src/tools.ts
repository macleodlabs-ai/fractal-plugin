// The tools a run request needs (its `need`: the app's own type checker and test runner, at the version the app
// pins), found on this machine in order: the repo's own installed copy, used as it is; else Fractal's tool cache
// (~/.fractal/tools/<eco>/<tool>@<version>[-py<X.Y>]); else installed into that cache now, unless installs are off.
// Only the checkers and runners in TOOLS, at exact versions, with no package's install code run (npm
// --ignore-scripts, Python wheels only), and never into the repo, its virtualenv or the machine's own setup.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, relative } from 'node:path'
import { exec, withoutSecrets } from './proc'

/** `version` null: the app pins none, so the repo's own copy as it is, else `default` (the engine's version). */
export type Need = { tool: string; version: string | null; eco: string; default?: string }
/** `from`: a folder of wheels and npm tarballs to install from instead of the registries (an offline mirror);
 * `path`: where npm and uv are looked up (default: PATH). */
export type ToolOpts = { dir: string; install: boolean; from?: string; path?: string }
/** `pinned`: a tool from the cache or an install is pinned by its version only: no lockfile hash is checked. */
/** A tool at one exact version. */
export type Exact = { tool: string; version: string; eco: string }
export type Used = Exact & { from: 'repo' | 'cache' | 'installed'; at?: string; pinned?: 'version' }
/** What a run's environment needs for its tools: folders put before PATH, NODE_PATH and PYTHONPATH. */
export type ToolEnv = { path: string[]; nodePath: string[]; pythonPath: string[] }
/** `python`: the app's interpreter; `venv`: the repo's own virtualenv in the shadow, when it has one; `repo`: the repo. */
export type Where = { shadow: string; repo: string; python?: string; venv?: string }

export const TOOLS = { pypi: new Set(['mypy', 'pytest']), npm: new Set(['typescript', 'pyright']) }
type Eco = keyof typeof TOOLS
const EXACT = /^\d[A-Za-z0-9.+-]{0,63}$/
const INSTALL_MS = 600_000

/** Why `n` is not installed or run here (undefined: it may be). */
export function needRefusal(n: Need): string | undefined {
  if (!Object.hasOwn(TOOLS, n.eco)) return `fractal installs tools from ${Object.keys(TOOLS).join(' or ')} only, not ${JSON.stringify(n.eco)}`
  if (!TOOLS[n.eco as Eco].has(n.tool)) return `${JSON.stringify(n.tool)} (${n.eco}) is not a type checker or test runner this client installs`
  const v = n.version ?? n.default
  if (v !== undefined && (!EXACT.test(v) || v.includes('..'))) return `${n.tool} ${JSON.stringify(v)} is not an exact version`
  return undefined
}

const onPath = (name: string, path: string) => path.split(delimiter).filter(Boolean).map(d => join(d, name)).find(p => existsSync(p))
/** A Python distribution's name as its .dist-info folder spells it. */
const norm = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '_')

function sitePackages(venv: string): string | undefined {
  const lib = join(venv, 'lib')
  const py = existsSync(lib) ? readdirSync(lib).find(x => /^python\d/.test(x)) : undefined
  return py && existsSync(join(lib, py, 'site-packages')) ? join(lib, py, 'site-packages') : undefined
}

/** Whether `site` holds `tool` (at `version`, when given). */
function hasDist(site: string | undefined, tool: string, version?: string): boolean {
  if (!site) return false
  const exact = `${norm(tool)}-${version}.dist-info`.toLowerCase()
  return readdirSync(site).some(x => {
    const l = x.toLowerCase()
    return version === undefined ? l.startsWith(`${norm(tool)}-`) && l.endsWith('.dist-info') : l === exact
  })
}

/** The version of `tool` in `site`, read from its .dist-info folder's name. */
function distVersion(site: string | undefined, tool: string): string | undefined {
  const pre = `${norm(tool)}-`
  const d = site ? readdirSync(site).find(x => x.toLowerCase().startsWith(pre) && x.endsWith('.dist-info')) : undefined
  return d?.slice(pre.length, -'.dist-info'.length)
}

const minors = new Map<string, Promise<string>>()
/** The interpreter's X.Y: a Python tool's cache entry is per Python version, as compiled wheels are. */
function pyMinor(python: string): Promise<string> {
  let m = minors.get(python)
  if (!m) {
    m = exec([python, '-I', '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { env: withoutSecrets(process.env) }).then(r => {
      if (r.code !== 0) throw new Error(`${python} did not say its version: ${r.stderr.trim()}`)
      return r.stdout.trim()
    })
    minors.set(python, m)
    m.catch(() => minors.delete(python))
  }
  return m
}

/** The interpreter behind the app's `python` (a venv's python links to it), which builds the tool's venv and says
 * the Python version: never a file of the repo or the shadow, as nothing of the repo runs outside the sandbox. */
function baseOf(python: string, w: Where): string {
  const base = realpathSync(python)
  for (const d of [w.repo, w.shadow]) {
    const r = relative(realpathSync(d), base)
    if (!r.startsWith('..')) throw new Error(`${python} leads to ${base}, inside the repo, and fractal runs nothing of the repo outside the sandbox`)
  }
  return base
}

/** Runs one package-manager step, or throws with the end of what it said. */
async function step(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const r = await exec(argv, { env, timeoutMs: INSTALL_MS })
  if (r.code !== 0 || r.timedOut) throw new Error(`${argv.slice(0, 3).join(' ')} ${r.timedOut ? 'timed out' : `exited ${r.code}`}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`)
}

type Plan = { at: string; command: string; ready: (dir: string) => boolean; build: (stage: string, env: NodeJS.ProcessEnv) => Promise<void>; env: (at: string) => Partial<ToolEnv> }

/** Builds the cache entry in a staging folder beside it, moved into place only once it holds the tool. */
async function install(p: Plan): Promise<void> {
  mkdirSync(join(p.at, '..'), { recursive: true })
  const stage = mkdtempSync(join(p.at, '..', '.stage-'))
  const scratch = mkdtempSync(join(tmpdir(), 'fractal-tools-'))   // the package managers' own caches: not the person's
  try {
    await p.build(stage, { ...withoutSecrets(process.env), npm_config_cache: join(scratch, 'npm'), UV_CACHE_DIR: join(scratch, 'uv'), UV_PYTHON_DOWNLOADS: 'never', PIP_NO_CACHE_DIR: '1' })
    if (!p.ready(stage)) throw new Error('the install ended without the tool at that version')
    try { renameSync(stage, p.at) } catch (e) { if (!p.ready(p.at)) throw e }   // another job put it there first
  } finally {
    rmSync(stage, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
}

function npmPlan(n: Exact, o: ToolOpts, path: string): Plan {
  const at = join(o.dir, 'npm', `${n.tool}@${n.version}`)
  const spec = o.from ? join(o.from, `${n.tool}-${n.version}.tgz`) : `${n.tool}@${n.version}`
  return {
    at,
    command: `npm install --prefix ${at} --ignore-scripts ${n.tool}@${n.version}`,
    ready: dir => {
      try { return (JSON.parse(readFileSync(join(dir, 'node_modules', n.tool, 'package.json'), 'utf8')) as { version?: unknown }).version === n.version } catch { return false }
    },
    build: async (stage, env) => {
      const npm = onPath('npm', path)
      if (!npm) throw new Error('npm is not on PATH')
      if (o.from && !existsSync(spec)) throw new Error(`${spec} is not in ${o.from}`)
      await step([npm, 'install', '--prefix', stage, '--ignore-scripts', '--no-audit', '--no-fund', '--no-update-notifier', ...(o.from ? ['--offline'] : []), spec], env)
    },
    env: dir => ({ path: [join(dir, 'node_modules', '.bin')], nodePath: [join(dir, 'node_modules')] }),
  }
}

async function pypiPlan(n: Exact, o: ToolOpts, path: string, python: string): Promise<Plan> {
  const at = join(o.dir, 'pypi', `${n.tool}@${n.version}-py${await pyMinor(python)}`)
  const uv = onPath('uv', path)
  const spec = `${n.tool}==${n.version}`
  const src = o.from ? ['--no-index', '--find-links', o.from] : []
  const py = (dir: string) => join(dir, 'bin', 'python')
  return {
    at,
    command: uv ? `uv venv --python ${python} ${at} && uv pip install --python ${py(at)} ${spec}` : `${python} -m venv ${at} && ${py(at)} -m pip install ${spec}`,
    ready: dir => hasDist(sitePackages(dir), n.tool, n.version),
    build: async (stage, env) => {
      if (uv) {
        await step([uv, 'venv', '--quiet', '--no-config', '--python', python, stage], env)
        await step([uv, 'pip', 'install', '--quiet', '--no-config', '--python', py(stage), '--only-binary', ':all:', ...src, spec], env)
      } else {
        await step([python, '-m', 'venv', stage], env)
        await step([py(stage), '-m', 'pip', 'install', '--quiet', '--disable-pip-version-check', '--no-input', '--only-binary', ':all:', ...src, spec], env)
      }
    },
    // the tool runs on the app's own interpreter, so it sees the app's packages, with the tool's on PYTHONPATH
    env: dir => ({ pythonPath: [sitePackages(dir)!] }),
  }
}

/** Every tool of `need` for a run at `w`: what each is and where it came from, and what the run's environment needs
 * for them; or `missing`: why the run cannot be the app's own check here, so it should not run. */
export async function resolveTools(need: Need[], w: Where, o: ToolOpts): Promise<{ used: Used[]; env: ToolEnv; missing?: string }> {
  const env: ToolEnv = { path: [], nodePath: [], pythonPath: [] }
  const used: Used[] = []
  const path = o.path ?? process.env.PATH ?? ''
  for (const want of need) {
    const own = (version: string | undefined) => ({ tool: want.tool, version: want.version ?? version ?? '?', eco: want.eco, from: 'repo' as const })
    const pkg = join(w.shadow, 'node_modules', want.tool, 'package.json')
    if (want.eco === 'npm' && existsSync(pkg)) {
      let v: string | undefined
      try { v = (JSON.parse(readFileSync(pkg, 'utf8')) as { version?: string }).version } catch { /* said as '?' */ }
      used.push(own(v))
      env.path.push(join(w.shadow, 'node_modules', '.bin'))
      continue
    }
    if (want.eco === 'pypi' && w.venv && hasDist(sitePackages(w.venv), want.tool)) {
      used.push(own(distVersion(sitePackages(w.venv), want.tool)))
      continue
    }
    const version = want.version ?? want.default
    if (version === undefined)
      return { used, env, missing: `${want.tool}: the app pins no version, the repo has no copy of its own and the engine named no default, so this check did not run` }
    const n = { tool: want.tool, version, eco: want.eco }
    const said = n
    let plan: Plan
    try {
      if (n.eco === 'pypi' && !w.python) throw new Error('no python3 on PATH')
      plan = n.eco === 'npm' ? npmPlan(n, o, path) : await pypiPlan(n, o, path, baseOf(w.python!, w))
    } catch (e) {
      return { used, env, missing: `${n.tool} ${n.version} has nowhere to run, so this check did not run: ${(e as Error).message}` }
    }
    let from: Used['from'] = 'cache'
    if (!plan.ready(plan.at)) {
      if (!o.install)
        return { used, env, missing: `${n.tool} ${n.version}, the app's version, is not installed here and tool installs are off (--no-install-tools or FRACTAL_INSTALL_TOOLS=off), so this check did not run; install it with: ${plan.command}` }
      try {
        await install(plan)
      } catch (e) {
        return { used, env, missing: `fractal could not install ${n.tool} ${n.version} (${n.eco}), so this check did not run: ${(e as Error).message}; to install it by hand: ${plan.command}` }
      }
      from = 'installed'
    }
    used.push({ ...said, from, at: plan.at, pinned: 'version' })
    const add = plan.env(plan.at)
    env.path.push(...(add.path ?? []))
    env.nodePath.push(...(add.nodePath ?? []))
    env.pythonPath.push(...(add.pythonPath ?? []))
  }
  return { used, env }
}
