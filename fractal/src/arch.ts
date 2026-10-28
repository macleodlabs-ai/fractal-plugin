// The architecture jobs from this machine's side: `fractal policy` (the repo against the engine's policies),
// `fractal arch` (findings, each with its options simplest first; with --choose, a change plan), `fractal edit
// --plan` (that plan run as an edit), `fractal policy --fix` (one policy's remedy as an edit) and `fractal solve` (a
// request routed to a finding's change plan, a plain edit or no change). Read-only for the repo, as every job is: an
// edit's patch is written only by `fractal apply`.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { jobDir } from './job'

type Obj = Record<string, unknown>
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : [])
const str = (x: unknown): string => (typeof x === 'string' ? x : x === undefined || x === null ? '' : String(x))
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Whether the repo is under version control, as the engine cannot see it (no .git is uploaded): `repo` when the
 * folder is its own root, `above` when a folder above it is, else `none`. */
export function vcsOf(repo: string): 'repo' | 'above' | 'none' {
  if (existsSync(join(repo, '.git'))) return 'repo'
  for (let d = dirname(resolve(repo)); ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return 'above'
    if (dirname(d) === d) return 'none'
  }
}

/** A change plan to run: a plan.json file, or the job id of an arch job made with --choose. */
export function planOf(home: string, given: string | undefined): Obj {
  if (!given) throw new Error('--plan PLAN: a plan.json from fractal arch --choose, or that arch job\'s id')
  const dir = jobDir(home, given)
  let plan: unknown
  try {
    if (existsSync(given)) plan = JSON.parse(readFileSync(given, 'utf8'))
    else if (existsSync(join(dir, 'plan.json'))) plan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'))
    else plan = (JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as Obj).report   // a detached arch job
    if (isObj(plan) && isObj(plan.plan)) plan = plan.plan
  } catch { throw new Error(`--plan ${given}: no plan there; make one with fractal arch --choose FINDING=PROPOSAL`) }
  if (!isObj(plan) || !Array.isArray(plan.steps)) throw new Error(`--plan ${given}: that file is not a change plan`)
  return plan
}

/** An arch job's plan, kept beside its result: the file `fractal edit --plan` reads. */
export function keepPlan(home: string, job: string, report: Obj): string | undefined {
  if (!isObj(report.plan)) return undefined
  const file = join(jobDir(home, job), 'plan.json')
  writeFileSync(file, JSON.stringify(report.plan, null, 1))
  return file
}

function policyLines(r: Obj): string[] {
  const counts = isObj(r.counts) ? r.counts : {}
  const out = [`policies: ${Object.entries(counts).map(([k, n]) => `${str(n)} ${k}`).join(', ')}`]
  for (const f of list(r.findings).filter(isObj)) {
    if (f.status === 'compliant') continue
    const why = list(f.why).map(str).join('; ')
    const needs = list(f.needs).map(str)
    out.push(`${str(f.status)} ${str(f.policy)}: ${cut(why, 200)}${needs.length ? ` (would be settled by: ${needs.join(', ')} evidence)` : ''}`)
    const fix = isObj(f.remedy) ? f.remedy : undefined
    if (fix && f.status === 'violated') {
      out.push(fix.kind === 'edit' && fix.safe === true
        ? `  remedy, as an edit: fractal policy --fix ${str(f.policy)}`
        : `  remedy, by hand: ${cut(str(fix.task), 200)}`)
    }
  }
  return out
}

function archLines(r: Obj, plan: string | undefined): string[] {
  const a = isObj(r.arch) ? r.arch : {}
  const findings = list(a.findings).filter(isObj)
  const pol = isObj(a.policies) ? a.policies : {}
  const out = [`${findings.length} finding${findings.length === 1 ? '' : 's'} · policies ${Object.entries(pol).map(([k, n]) => `${str(n)} ${k}`).join(', ')}`]
  for (const f of findings) {
    out.push(`${str(f.id)} (${str(f.status)}): ${cut(str(f.risk), 160)}`)
    for (const p of list(f.proposals).filter(isObj)) {
      const v = isObj(p.verdict) ? str(p.verdict.status) : ''
      out.push(`  ${str(p.rank)}. ${str(p.id)}${p.pattern ? ` [${str(p.pattern)}]` : ''} (${v}): ${cut(str(p.change), 120)}`)
    }
    if (f.not_proposed) out.push(`  not proposed: ${cut(str(f.not_proposed), 160)}`)
  }
  const unjudged = list(a.not_judged).length
  if (unjudged) out.push(`${unjudged} not settled (evidence or a judgment missing): see the job's result.json`)
  if (isObj(r.plan)) {
    const steps = list(r.plan.steps).length
    out.push(`plan ${str(r.plan.id)}: ${steps} step${steps === 1 ? '' : 's'} · ${plan} · run it (a dry run, with its change proof): fractal edit --plan ${plan}`)
  } else if (findings.length) out.push('pick one: fractal arch --choose FINDING=PROPOSAL (the proposals are ranked simplest first)')
  return out
}

function fixLines(r: Obj): string[] {
  const before = isObj(r.before) ? str(r.before.status) : 'not applicable'
  const out = [`${str(r.policy)}: ${before}`]
  if (isObj(r.edit)) {
    const e = r.edit
    out.push(`edit: ${str(e.status)} (${str(e.evidence)})${e.reason ? `: ${str(e.reason)}` : ''}`)
    if (e.proof) out.push(`change proof: ${str(e.proof)}`)
  }
  if (isObj(r.after)) out.push(`after the edit, in the copy: ${str(r.after.status)}: ${list(r.after.why).map(str).join('; ')}`)
  if (r.reason) out.push(str(r.reason))
  return out
}

/** `--task FILE|TEXT`: a file's text when the path names one, else the words given. */
export function taskOf(given: string | undefined): string {
  const text = given && existsSync(given) ? readFileSync(given, 'utf8') : given ?? ''
  if (!text.trim()) throw new Error('fractal solve --task FILE|TEXT: the request, as a text file or in words')
  return text
}

/** The report of a policy, arch or fix job in a few lines (`plan`: where an arch job's plan was kept). A solve's is
 * the engine's own brief (its route and why), which every job's end prints. */
export function reportLines(kind: string, report: Obj, plan?: string): string[] {
  if (kind === 'policy') return policyLines(report)
  if (kind === 'arch') return archLines(report, plan)
  if (kind === 'fix') return fixLines(report)
  return []
}
