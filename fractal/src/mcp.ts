// `fractal mcp`: the client as an MCP server on stdio (JSON-RPC 2.0, one message a line), for Codex, Cursor, Grok
// and Claude Code. A job runs in a detached process, so a tool call never outlives the host's tool timeout: the
// job tools wait up to `wait_s` and say where the job stands; `fractal_status` follows it.
import { createInterface } from 'node:readline'
import { resolve } from 'node:path'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { answerQuestion, applyJob, jobState } from './job'
import { withTeam } from './library'
import { apiFor, detectLang, startJob, statusText, waitFor } from './run'

export const VERSION = '0.1.0'
type Args = Record<string, unknown>
const str = (x: unknown) => (typeof x === 'string' && x ? x : undefined)
const num = (x: unknown, d: number) => (typeof x === 'number' && x >= 0 ? Math.min(x, 50) : d)

const repoProp = { repo: { type: 'string', description: 'the repo root (default: the folder the host runs in)' }, lang: { type: 'string', enum: ['ts', 'py'] }, wait_s: { type: 'number', description: 'seconds to wait for the job before answering (≤ 50)' } }
export const TOOLS = [
  {
    name: 'fractal_edit',
    description: 'Change an existing TypeScript or Python repo in place with Fractal: only the declarations the change needs are rewritten, and the repo\'s own type check (and tests, with run_tests) judge it in a local copy. Nothing is written to the repo until fractal_apply.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'the change in one or two plain sentences' }, ...repoProp,
        operator: { type: 'string', description: 'instead of a task: a learned operator of the team library (.fcg/library), ID or ID@N' },
        run_tests: { type: 'boolean', description: 'run the repo\'s own tests (they execute its code, in a copy): ask the person first' },
        test_cmd: { type: 'string' }, propagate: { type: 'boolean' }, check_values: { type: 'boolean' }, write_tests: { type: 'boolean' },
        ask: { type: 'string', enum: ['wait'], description: 'ask the person before deciding on their behalf' },
        sandbox: { type: 'string', enum: ['srt', 'none'], description: 'srt (the default when installed) runs the checks with the network off and writes only in the copy; none runs them without it' },
      },
    },
  },
  {
    name: 'fractal_scan',
    description: 'Map a TypeScript or Python repo read-only with Fractal: declarations, who calls what, which tests reach which code; with symbol, everything a change to that declaration can reach.',
    inputSchema: { type: 'object', properties: { ...repoProp, symbol: { type: 'string', description: 'file::Name or Name' }, depth: { type: 'number' } } },
  },
  {
    name: 'fractal_status',
    description: 'Where a Fractal job stands: its latest events, any question waiting for the person, the brief and the patch. With no job, the recent jobs.',
    inputSchema: { type: 'object', properties: { job: { type: 'string' }, wait_s: { type: 'number' } } },
  },
  {
    name: 'fractal_answer',
    description: 'Answer a Fractal job\'s question with the option the person chose, in their words. Never choose for them.',
    inputSchema: { type: 'object', required: ['job', 'question', 'option'], properties: { job: { type: 'string' }, question: { type: 'string' }, option: { type: 'string' } } },
  },
  {
    name: 'fractal_apply',
    description: 'Write a ready job\'s patch into the repo, only when the person has approved it in their own words; refused if a file changed since the job read it. undo puts back what it replaced.',
    inputSchema: { type: 'object', required: ['job'], properties: { job: { type: 'string' }, undo: { type: 'boolean' } } },
  },
]

function recent(home: string): string {
  let ids: string[] = []
  try { ids = readdirSync(join(home, 'jobs')) } catch { /* none yet */ }
  const rows = ids.map(id => ({ id, at: statSync(join(home, 'jobs', id)).mtimeMs })).sort((a, b) => b.at - a.at).slice(0, 10)
  return rows.length ? rows.map(r => `${r.id}: ${jobState(home, r.id).status}`).join('\n') : 'no Fractal jobs on this machine yet'
}

export async function callTool(home: string, name: string, a: Args): Promise<string> {
  const lines: string[] = []
  const repo = resolve(str(a.repo) ?? process.cwd())
  const lang = str(a.lang) ?? detectLang(repo)
  const sandbox = a.sandbox === 'srt' || a.sandbox === 'none' ? (a.sandbox as 'srt' | 'none') : undefined
  const hands = { sandbox, testCmd: str(a.test_cmd) }
  const start = async (kind: 'edit' | 'scan', args: Args) => {
    const { job } = await startJob(home, kind, args, repo, hands, { detach: true, onLine: l => lines.push(l) })
    await waitFor(home, job, num(a.wait_s, 30))
    return `Fractal job ${job} started\n${lines.join('\n')}\n${statusText(home, job)}`
  }
  if (name === 'fractal_edit') {
    const task = str(a.task)
    const operator = str(a.operator)
    if (!task && !operator) throw new Error('task (or operator) is required')
    if (task && operator) throw new Error('give task or operator, not both')
    const args: Args = task ? { task, lang } : { lang }
    if (operator) args.operator = operator
    await withTeam(args, repo, home, l => lines.push(l))
    for (const k of ['run_tests', 'propagate', 'check_values', 'write_tests']) if (a[k] === true) args[k] = true
    for (const k of ['test_cmd', 'ask']) if (str(a[k])) args[k] = a[k]
    if (sandbox === 'srt') args.sandbox = sandbox
    return start('edit', args)
  }
  if (name === 'fractal_scan') {
    const args: Args = { lang }
    if (str(a.symbol)) args.symbol = a.symbol
    if (typeof a.depth === 'number') args.depth = a.depth
    return start('scan', args)
  }
  if (name === 'fractal_status') {
    const job = str(a.job)
    if (!job) return recent(home)
    await waitFor(home, job, num(a.wait_s, 0))
    return statusText(home, job)
  }
  if (name === 'fractal_answer') {
    const [job, q, option] = [str(a.job), str(a.question), str(a.option)]
    if (!job || !q || !option) throw new Error('job, question and option are required')
    await answerQuestion(apiFor(home), home, job, q, option)
    return `answered ${q}: ${option}`
  }
  if (name === 'fractal_apply') {
    const job = str(a.job)
    if (!job) throw new Error('job is required')
    const r = applyJob(home, job, { undo: a.undo === true })
    if (r.status === 'refused') throw new Error(`refused: ${r.reason}${r.stale ? ` (${r.stale.join(', ')})` : ''}`)
    return `${r.status}: ${(r.files ?? []).join(', ')}`
  }
  throw new Error(`no tool ${name}`)
}

export function serveMcp(home: string): void {
  const send = (m: unknown) => process.stdout.write(JSON.stringify(m) + '\n')
  createInterface({ input: process.stdin }).on('line', async line => {
    let m: { id?: number | string; method?: string; params?: Args }
    try { m = JSON.parse(line) } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return }
    const reply = (result: unknown) => m.id !== undefined && send({ jsonrpc: '2.0', id: m.id, result })
    if (m.method === 'initialize') {
      const v = str(m.params?.protocolVersion) ?? '2025-06-18'
      return reply({ protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: 'fractal', version: VERSION } })
    }
    if (m.method === 'ping') return reply({})
    if (m.method === 'tools/list') return reply({ tools: TOOLS })
    if (m.method === 'tools/call') {
      const p = m.params ?? {}
      try {
        return reply({ content: [{ type: 'text', text: await callTool(home, String(p.name), (p.arguments as Args) ?? {}) }] })
      } catch (e) {
        return reply({ content: [{ type: 'text', text: (e as Error).message }], isError: true })
      }
    }
    if (m.id === undefined) return   // a notification: nothing to answer
    send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no method ${m.method}` } })
  })
}
