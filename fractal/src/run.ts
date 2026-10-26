// What the CLI and the MCP server share: starting a job with the chosen hands, driving it here or in a detached
// process, and saying where it stands.
import { spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { loadConfig } from './config'
import { drive, jobDir, jobState, submit, type Hands } from './job'
import { modelHand, recording } from './models'
import { Api, NOT_CONNECTED, type Kind } from './protocol'
import { which } from './runner'

/** `sandbox`: srt, or none; unset, srt when it is installed. `noInstallTools`: a tool a run needs is never installed
 * (also FRACTAL_INSTALL_TOOLS=off, or FCG_INSTALL_TOOLS=off as for fcg itself). */
export type HandOpts = { hands?: string; sandbox?: 'srt' | 'none'; record?: string; testCmd?: string; noInstallTools?: boolean }

export function apiFor(home: string): Api {
  const c = loadConfig(home)
  if (!c.token) throw new Error(NOT_CONNECTED)
  return new Api(c.url, c.token)
}

export function handsFor(o: HandOpts): Hands {
  let model = modelHand(o.hands || process.env.FRACTAL_HANDS || 'claude', {})
  if (o.record) model = recording(model, resolve(o.record))
  const testCmd = o.testCmd === undefined ? undefined : words(o.testCmd)
  const sandbox = o.sandbox === 'srt' || (o.sandbox === undefined && which('srt')) ? ('srt' as const) : undefined
  const off = (v: string | undefined) => /^(off|0|false|no)$/i.test(v ?? '')
  const installTools = !o.noInstallTools && !off(process.env.FRACTAL_INSTALL_TOOLS) && !off(process.env.FCG_INSTALL_TOOLS)
  return { model, testCmd, sandbox, installTools }
}

/** A command line as words: quotes group, nothing else is a shell's. */
export const words = (s: string) => s.match(/'[^']*'|"[^"]*"|\S+/g)?.map(w => w.replace(/^(['"])(.*)\1$/, '$2')) ?? []

/** `ts` when the repo has a tsconfig, else `py`. */
export function detectLang(repo: string): 'ts' | 'py' {
  return existsSync(join(repo, 'tsconfig.json')) ? 'ts' : 'py'
}

/** The CLI script that is running (dist/fractal.mjs, or src/cli.ts under bun). */
const self = () => [process.execPath, process.argv[1]!]

export async function startJob(home: string, kind: Kind, args: Record<string, unknown>, repo: string, h: HandOpts, o: { detach: boolean; onLine: (s: string) => void }) {
  const api = apiFor(home)
  const hands = handsFor(h)   // a hand that cannot be built is said before anything is uploaded
  // the engine takes the person's test command as argv, split as the runner splits it
  const s = await submit(api, kind, typeof args.test_cmd === 'string' ? { ...args, test_cmd: words(args.test_cmd) } : args, repo, home)
  o.onLine(`job ${s.job}: ${s.files} files uploaded by sha (${(s.bytes / 1e6).toFixed(1)} MB) · model calls on ${hands.model.name}`)
  const board = await api.view(s.job).catch(() => undefined)
  if (board) o.onLine(`board: ${board} (any screen, for 2 h)`)
  if (s.skipped.length) o.onLine(`not sent: ${s.skipped.slice(0, 5).map(x => `${x.path} (${x.why})`).join(', ')}${s.skipped.length > 5 ? ` and ${s.skipped.length - 5} more` : ''}`)
  if (!o.detach) return { job: s.job, result: await drive(api, s.job, home, hands, { onLine: o.onLine }) }
  const flags = [...(h.hands ? ['--hands', h.hands] : []), ...(h.sandbox ? ['--sandbox', h.sandbox] : []), ...(h.record ? ['--record', resolve(h.record)] : []), ...(h.testCmd ? ['--test-cmd', h.testCmd] : []), ...(h.noInstallTools ? ['--no-install-tools'] : [])]
  const log = openSync(join(s.dir, 'drive.log'), 'a')
  const [exe, script] = self()
  spawn(exe!, [script!, '_drive', s.job, ...flags], { detached: true, stdio: ['ignore', log, log], env: process.env }).unref()
  return { job: s.job }
}

/** The job's state in a few lines: status, the latest events, open questions, the brief and the patch. */
export function statusText(home: string, job: string): string {
  const st = jobState(home, job)
  const out = [`job ${job}: ${st.status}`, ...st.last.map(l => `  ${l}`)]
  for (const q of st.questions) out.push(`question ${q.id}: ${q.text} [${q.options.join(' | ')}]`)
  if (st.error) out.push(`error: ${st.error}`)
  if (st.brief) out.push(st.brief)
  const patch = join(jobDir(home, job), 'edit.patch')
  if (existsSync(patch)) out.push(`patch: ${patch}${existsSync(join(jobDir(home, job), 'applied.json')) ? ' (applied)' : ` · apply with: fractal apply ${job}`}`)
  const log = join(jobDir(home, job), 'drive.log')
  if (st.status !== 'ready' && existsSync(log)) {
    const tail = readFileSync(log, 'utf8').trim().split('\n').filter(l => /error|refused|lost/i.test(l)).slice(-2)
    out.push(...tail)
  }
  return out.join('\n')
}

/** Waits up to `seconds` for the job to end, fail, or ask something new. */
export async function waitFor(home: string, job: string, seconds: number): Promise<void> {
  const until = Date.now() + seconds * 1000
  const before = JSON.stringify(jobState(home, job).questions)
  while (Date.now() < until) {
    const st = jobState(home, job)
    if (st.brief !== undefined || st.error !== undefined || JSON.stringify(st.questions) !== before) return
    await new Promise(r => setTimeout(r, 250))
  }
}
