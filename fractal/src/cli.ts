#!/usr/bin/env node
// fractal: Fractal's client. The hosted engine plans and checks; this machine's model and tools do the work.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DEFAULT_URL, fractalHome, loadConfig, saveConfig } from './config'
import { connect } from './connect'
import { HOSTS, setup, type Host } from './hosts'
import { answerQuestion, applyJob, drive, jobDir, jobState } from './job'
import { withTeam } from './library'
import { serveMcp, VERSION } from './mcp'
import { Api, type Kind } from './protocol'
import { apiFor, detectLang, handsFor, startJob, statusText, type HandOpts } from './run'

const USAGE = `fractal ${VERSION}: change or map a TypeScript or Python repo with Fractal's hosted engine,
your own Claude Code (claude -p, on your subscription) and your own machine.

  fractal connect [--url URL]                     sign in (GitHub or email, in the browser)
  fractal edit "<change>" [--repo .] [--lang ts|py] [--run-tests] [--test-cmd CMD] [--propagate]
               [--check-values] [--write-tests] [--speculate] [--route KIND=MODEL]... [--ask wait] [--detach]
  fractal edit --operator ID[@N] [...]            apply a learned operator from the team library (.fcg/library)
  fractal edit --offer MODULE --regions SCAN [...]  act on a refactor offer, as a dry run with its change proof
  fractal scan [--repo .] [--lang ts|py] [--lift] [--domains] [--hypotheses] [--offers] [--recall] [--detach]
  fractal impact NAME [--depth N]                 what a change to one declaration reaches (or scan --symbol NAME)
  fractal domains                                 the repo's modules organised into domains
  fractal offers --regions SCAN                   refactor offers, from a scan made with --lift
               SCAN: that scan's job id, or its report as a JSON file
  fractal status [JOB]                            where a job stands (no JOB: the recent ones)
  fractal answer JOB QUESTION "<option>"          answer a job's question
  fractal apply JOB [--undo]                      write a ready job's patch (or put back what it replaced)
  fractal delete JOB                              purge the job's files on the server now
  fractal mcp                                     the MCP server (the Claude Code plugin uses its skills instead)

  hands: --hands claude[:MODEL] | replay:DIR  (or $FRACTAL_HANDS; default claude)
         --sandbox srt|none   srt (the default when srt is installed) runs the repo's checks with the network off
                              and writes only in the local copy; none runs them without it
         --no-install-tools   a checker or test runner the repo uses, at its version, that this machine lacks is
                              not installed into ~/.fractal/tools (or FRACTAL_INSTALL_TOOLS=off): its check does not run
         --record DIR    keep every model answer, to replay later`

const BOOL = new Set(['run-tests', 'propagate', 'check-values', 'write-tests', 'speculate', 'lift', 'domains', 'hypotheses', 'offers', 'recall', 'detach', 'undo', 'no-open', 'no-install-tools', 'help'])
/** Flags that may be given more than once: their values, in order, joined by a newline. */
const MANY = new Set(['route'])

function parse(argv: string[]) {
  const pos: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (!a.startsWith('--')) { pos.push(a); continue }
    const [k, v] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined]
    const val = v ?? (BOOL.has(k) ? true : argv[++i] ?? '')
    flags[k] = MANY.has(k) && typeof flags[k] === 'string' && typeof val === 'string' ? `${flags[k]}\n${val}` : val
  }
  return { pos, flags }
}

const out = (s: string) => process.stdout.write(s + '\n')

/**
 * What an offer is read from: a scan made with --lift, by its job here (its result.json) or its report as a file. Only
 * the parts `fcg edit --offer` and `fcg offers` read go up: its patterns, domains and matches.
 */
function regionsOf(home: string, scan: string | undefined): Record<string, unknown> {
  if (!scan) throw new Error('--regions SCAN: the job id of a scan made with --lift, or its report as a JSON file')
  const file = existsSync(scan) ? scan : join(jobDir(home, scan), 'result.json')
  let report: Record<string, unknown> | undefined
  try {
    const got = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    report = (file === scan ? got : got.report) as Record<string, unknown> | undefined
  } catch { throw new Error(`--regions ${scan}: no scan job or report there`) }
  if (!report || typeof report.patterns !== 'object' || report.patterns === null) throw new Error(`--regions ${scan}: that scan has no pattern regions; make one with fractal scan --lift`)
  return Object.fromEntries(['patterns', 'domains', 'matches'].filter(k => k in report!).map(k => [k, report![k]]))
}

/** `--route KIND=MODEL`, each given: the kinds of call the job sends to another model. */
function routesOf(given: string): Record<string, string> {
  const routes: Record<string, string> = {}
  for (const r of given.split('\n')) {
    const i = r.indexOf('=')
    if (i < 1 || i === r.length - 1) throw new Error(`--route takes KIND=MODEL; got ${JSON.stringify(r)}`)
    routes[r.slice(0, i)] = r.slice(i + 1)
  }
  return routes
}

function open(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open'
  try { spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref() } catch { /* the line printed says where */ }
}

async function main(argv: string[]): Promise<number> {
  const { pos, flags } = parse(argv)
  const cmd = pos.shift()
  const home = fractalHome()
  const f = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined)
  const sandbox = f('sandbox')
  if (sandbox !== undefined && sandbox !== 'srt' && sandbox !== 'none') throw new Error('--sandbox takes srt or none')
  const hands: HandOpts = { hands: f('hands'), sandbox, record: f('record'), testCmd: f('test-cmd'), noInstallTools: flags['no-install-tools'] === true }
  const repo = resolve(f('repo') ?? '.')
  const lang = f('lang') ?? detectLang(repo)

  if (!cmd || flags.help) { out(USAGE); return cmd ? 0 : 2 }
  if (cmd === 'connect') {
    const url = f('url') ?? loadConfig(home).url ?? DEFAULT_URL
    const got = await connect(new Api(url, undefined), { label: f('label') ?? 'fractal CLI', open: flags['no-open'] ? undefined : open, onLine: out })
    saveConfig(home, { url, token: got.token })
    out(`connected${typeof got.account.email === 'string' ? ` as ${got.account.email}` : ''}`)
    return 0
  }
  if (cmd === 'edit' || cmd === 'scan' || cmd === 'impact' || cmd === 'domains' || cmd === 'offers') {
    const args: Record<string, unknown> = { lang }
    const on = (...ks: string[]) => { for (const k of ks) if (flags[k] === true) args[k.replace(/-/g, '_')] = true }
    // `scan --symbol` is what `fcg impact` answers
    const kind: Kind = cmd === 'scan' && f('symbol') ? 'impact' : cmd
    if (cmd === 'edit') {
      const task = pos.join(' ').trim()
      const operator = f('operator')
      if (f('offer')) Object.assign(args, { offer: f('offer'), pattern_regions: regionsOf(home, f('regions')) })
      else if (!task && !operator) throw new Error('fractal edit "<the change, in words>" (or --offer MODULE --regions SCAN, or --operator ID[@N])')
      if (task && operator) throw new Error('fractal edit takes the change in words or --operator ID[@N], not both')
      if (task) args.task = task
      if (operator) args.operator = operator
      await withTeam(args, repo, home, out)
      on('run-tests', 'propagate', 'check-values', 'write-tests', 'speculate')
      if (f('test-cmd')) args.test_cmd = f('test-cmd')
      if (f('ask')) args.ask = f('ask')
      if (f('route')) args.routes = routesOf(f('route')!)
    } else if (kind === 'impact') {
      const symbol = f('symbol') ?? pos.join(' ').trim()
      if (!symbol) throw new Error('fractal impact NAME (an id, file::Name, or a name)')
      args.symbol = symbol
      if (f('depth')) args.depth = Number(f('depth'))
    } else if (cmd === 'offers') args.pattern_regions = regionsOf(home, f('regions'))
    else if (cmd === 'scan') on('lift', 'domains', 'hypotheses', 'offers', 'recall')
    if (hands.sandbox === 'srt') args.sandbox = hands.sandbox
    const r = await startJob(home, kind, args, repo, hands, { detach: flags.detach === true, onLine: out })
    if (flags.detach) { out(`follow it with: fractal status ${r.job}`); return 0 }
    return r.result && ['ready', 'done'].includes(r.result.status) ? 0 : 1
  }
  if (cmd === '_drive') {   // the detached driver of a job started with --detach or from the MCP server
    const job = pos[0]!
    try {
      await drive(apiFor(home), job, home, handsFor(hands), { onLine: out })
    } catch (e) {
      const st = jobState(home, job)
      st.error = (e as Error).message
      appendFileSync(join(jobDir(home, job), 'drive.log'), `error: ${st.error}\n`)
      const { writeFileSync } = await import('node:fs')
      writeFileSync(join(jobDir(home, job), 'state.json'), JSON.stringify(st, null, 1))
      return 1
    }
    return 0
  }
  if (cmd === 'status') {
    if (pos[0]) { out(statusText(home, pos[0])); return 0 }
    const { callTool } = await import('./mcp')
    out(await callTool(home, 'fractal_status', {}))
    return 0
  }
  if (cmd === 'answer') {
    const [job, q, ...rest] = pos
    if (!job || !q || !rest.length) throw new Error('fractal answer JOB QUESTION "<option>"')
    await answerQuestion(apiFor(home), home, job, q, rest.join(' '))
    out(`answered ${q}: ${rest.join(' ')}`)
    return 0
  }
  if (cmd === 'apply') {
    const job = pos[0]
    if (!job) throw new Error('fractal apply JOB [--undo]')
    const r = applyJob(home, job, { undo: flags.undo === true })
    if (r.status === 'refused') throw new Error(`refused: ${r.reason}${r.stale ? ` (${r.stale.join(', ')})` : ''}`)
    out(`${r.status}: ${(r.files ?? []).join(', ')}${r.status === 'applied' ? ` · undo with: fractal apply ${job} --undo` : ''}`)
    return 0
  }
  if (cmd === 'delete') {
    if (!pos[0]) throw new Error('fractal delete JOB')
    await apiFor(home).purge(pos[0])
    out(`job ${pos[0]}: deleted on the server`)
    return 0
  }
  if (cmd === 'mcp') { serveMcp(home); return -1 }
  if (cmd === 'setup') {
    const host = pos[0] as Host
    if (!HOSTS.includes(host)) throw new Error(`fractal setup ${HOSTS.join('|')}`)
    for (const l of setup(host, resolve(f('dir') ?? '.'))) out(l)
    return 0
  }
  out(USAGE)
  return 2
}

main(process.argv.slice(2)).then(
  code => { if (code >= 0) process.exitCode = code },
  e => { process.stderr.write(`fractal: ${(e as Error).message}\n`); process.exitCode = 1 },
)
