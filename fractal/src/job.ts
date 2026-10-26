// One job, from this machine's side: the upload by sha, the long poll, the local hands answering the engine's
// requests, and the result kept under ~/.fractal/jobs/<job>/ (job.json, state.json, result.json, edit.patch).
// The repo is written only by `applyJob`, on the person's word, and only while each file is as it was uploaded.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { batches, listRepo, notOwn, sha256 } from './files'
import type { ModelHand } from './models'
import { ApiError, retrying, TERMINAL, type Api, type JobEvent, type Kind, type QuestionReq, type Req, type Result } from './protocol'
import { applyPatch, parsePatch, PatchError, patchedFiles, reversePatch } from './patch'
import { Shadow, type RunResult } from './runner'

/** `testCmd`: the person's own --test-cmd, as words, which runs as they gave it; `installTools`: false, a tool a run
 * needs that this machine lacks is not installed (the run reports it did not run). */
export type Hands = { model: ModelHand; testCmd?: string[]; sandbox?: 'srt'; concurrency?: number; installTools?: boolean }
type JobFile = { job: string; kind: Kind; repo: string; url: string; files: Record<string, string>; created: number }
export type State = {
  job: string; status: string; events: number; last: string[]
  questions: { id: string; text: string; options: string[]; evidence: string[] }[]
  answered: { model: number; run: number; failed: number }; usage: { prompt_tokens: number; completion_tokens: number }
  brief?: string; error?: string
}

const LAST = 12
const IDLE_MS = 1000

export const jobDir = (home: string, job: string) => join(home, 'jobs', job)

function writeJson(path: string, data: unknown) {
  writeFileSync(path + '.tmp', JSON.stringify(data, null, 1))
  renameSync(path + '.tmp', path)
}
const readJson = <T>(path: string): T | undefined => {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch { return undefined }
}

export function jobState(home: string, job: string): State {
  return readJson<State>(join(jobDir(home, job), 'state.json')) ?? { job, status: 'unknown', events: 0, last: [], questions: [], answered: { model: 0, run: 0, failed: 0 }, usage: { prompt_tokens: 0, completion_tokens: 0 } }
}

/** Creates the job, uploads what the server lacks, and starts it. */
export async function submit(api: Api, kind: Kind, args: Record<string, unknown>, repo: string, home: string) {
  const listing = await listRepo(repo)
  const { job, need } = await api.createJob(kind, args, listing.files)
  const dir = jobDir(home, job)
  mkdirSync(dir, { recursive: true })
  writeJson(join(dir, 'job.json'), { job, kind, repo, url: api.base, files: listing.files, created: Date.now() } satisfies JobFile)
  const bySha = new Map<string, string>()
  for (const [p, s] of Object.entries(listing.files)) bySha.set(s, p)
  const wanted = need.filter(s => bySha.has(s))
  for (const group of batches(wanted, s => listing.sizes[bySha.get(s)!]!)) {
    const blobs: Record<string, string> = {}
    for (const s of group) {
      const b = readFileSync(join(repo, bySha.get(s)!))
      if (sha256(b) !== s) throw new Error(`${bySha.get(s)} changed while it was being uploaded: run again`)
      blobs[s] = b.toString('base64')
    }
    await api.putFiles(job, blobs)
  }
  await api.start(job)
  writeJson(join(dir, 'state.json'), { ...jobState(home, job), status: 'running' })
  return { job, dir, skipped: listing.skipped, files: Object.keys(listing.files).length, bytes: listing.bytes }
}

/** One board event as one line: its type and the fact it carries most plainly. */
export function eventLine(e: JobEvent): string {
  for (const k of ['text', 'summary', 'status', 'reason', 'task', 'name', 'module']) {
    const v = e[k]
    if (typeof v === 'string' && v) return `${e.type}: ${v.replace(/\s+/g, ' ').slice(0, 140)}`
  }
  return e.type
}

/** Polls the job to its end, answering each request once. Returns the result, kept in the job's folder. */
export async function drive(api: Api, job: string, home: string, hands: Hands, o: { onLine?: (s: string) => void }): Promise<Result> {
  const dir = jobDir(home, job)
  const meta = readJson<JobFile>(join(dir, 'job.json'))
  if (!meta) throw new Error(`no job ${job} on this machine`)
  const say = o.onLine ?? (() => {})
  const st = jobState(home, job)
  const save = () => writeJson(join(dir, 'state.json'), st)
  const handled = new Set<string>()
  let shadow: Shadow | undefined
  let runs: Promise<void> = Promise.resolve()   // run requests share the shadow: one at a time
  let active = 0
  const queue: (() => void)[] = []
  const limit = hands.concurrency ?? 4
  const slot = async () => { if (active >= limit) await new Promise<void>(r => queue.push(r)); active++ }
  const release = () => { active--; queue.shift()?.() }
  const pending = new Set<Promise<void>>()

  // posting is retried through blips and rate limits, apart from computing the answer, so a good answer is never
  // replaced by an {error} for a failed post
  const post = async (id: string, result: unknown) => {
    try { await retrying(() => api.answer(job, id, result)) } catch (e) { if (!(e instanceof ApiError && e.status === 409)) throw e }   // 409: answered elsewhere
  }
  const handle = async (r: Exclude<Req, QuestionReq>) => {
    if (r.kind === 'model') {
      await slot()
      let answer: unknown
      try {
        const a = await hands.model.complete(r)
        st.answered.model++
        st.usage.prompt_tokens += a.usage.prompt_tokens
        st.usage.completion_tokens += a.usage.completion_tokens
        answer = a
      } catch (e) {
        st.answered.failed++
        say(`model call ${r.op} failed: ${(e as Error).message}`)
        answer = { error: (e as Error).message }
      } finally { release() }
      await post(r.id, answer)
      return
    }
    const done = runs.then(async () => {
      let res: RunResult
      try {
        shadow ??= await Shadow.create(meta.repo, join(dir, 'shadow'), Object.keys(meta.files))
        // FRACTAL_TOOLS_FROM: a folder of wheels and npm tarballs to install tools from (an offline mirror)
        const tools = { dir: join(home, 'tools'), install: hands.installTools !== false, from: process.env.FRACTAL_TOOLS_FROM || undefined }
        res = await shadow.run(r, { testCmd: hands.testCmd, sandbox: hands.sandbox, tools })
        for (const t of res.tools ?? []) if (t.from === 'installed') say(`installed ${t.tool}@${t.version} (${t.eco}) into ${t.at}${t.pinned === 'version' ? ', pinned by version: no lockfile hash checked' : ''}`)
        st.answered.run++
      } catch (e) {   // a copy that fails, a program that cannot start: said to the engine, never left open
        const err = e as NodeJS.ErrnoException
        st.answered.failed++
        res = { code: 126, stdout: '', stderr: `fractal could not run this: ${err.message}${err.path && !err.message.includes(err.path) ? ` (${err.path})` : ''}` }
      }
      say(`ran ${r.argv.slice(0, 3).join(' ')}${r.argv.length > 3 ? ' …' : ''}: exit ${res.code}${hands.sandbox ? ' (srt: network off)' : ''}`)
      await post(r.id, res)
    })
    runs = done.catch(() => {})
    await done
  }

  const track = (id: string, p: Promise<void>) => {
    const q = p.catch(e => { st.error = (e as Error).message; say(`could not answer ${id}: ${st.error}`) })
    pending.add(q)
    void q.finally(() => pending.delete(q))
  }

  let after = 0
  for (;;) {
    const poll = await retrying(() => api.events(job, after, AbortSignal.timeout(60_000)))
    for (const e of poll.events) {
      const l = eventLine(e)
      st.last = [...st.last, l].slice(-LAST)
      say(l)
    }
    st.events += poll.events.length
    after = poll.next
    st.status = poll.status
    st.questions = poll.requests.filter((r): r is QuestionReq => r.kind === 'question').map(({ id, text, options, evidence }) => ({ id, text, options, evidence }))
    const fresh = [...poll.requests, ...poll.bad].filter(r => !handled.has(r.id)).length
    for (const r of poll.requests) {
      if (r.kind === 'question' || handled.has(r.id)) continue
      handled.add(r.id)
      track(r.id, handle(r))
    }
    for (const b of poll.bad) {
      if (handled.has(b.id)) continue
      handled.add(b.id)
      st.answered.failed++
      say(`request ${b.id}: ${b.why}; answered with that error`)
      track(b.id, post(b.id, { error: b.why }))
    }
    for (const q of st.questions) if (!handled.has(q.id)) { handled.add(q.id); say(`question ${q.id}: ${q.text} [${q.options.join(' | ')}] (answer: fractal answer ${job} ${q.id} "<option>")`) }
    save()
    if (TERMINAL.has(poll.status)) break
    // a server that answers at once while requests are open (rather than holding the poll) is not polled hot
    if (!poll.events.length && !fresh) await new Promise(r => setTimeout(r, IDLE_MS))
  }
  await Promise.all(pending)
  const res = await api.result(job)
  writeJson(join(dir, 'result.json'), res)
  if (res.patch) writeFileSync(join(dir, 'edit.patch'), res.patch)
  rmSync(join(dir, 'shadow'), { recursive: true, force: true })
  const brief = typeof res.report.brief === 'string' ? res.report.brief : `${res.status}${typeof res.report.reason === 'string' ? `: ${res.report.reason}` : ''}`
  st.status = res.status
  st.brief = brief
  st.questions = []
  save()
  say(brief)
  if (res.patch) say(`patch: ${join(dir, 'edit.patch')} (${patchedFiles(res.patch).join(', ')}) · apply with: fractal apply ${job}`)
  return res
}

/** Takes a person's answer to the job's open question. */
export async function answerQuestion(api: Api, home: string, job: string, id: string, option: string): Promise<void> {
  const q = jobState(home, job).questions.find(x => x.id === id)
  if (q && !q.options.includes(option)) throw new Error(`${JSON.stringify(option)} is not one of: ${q.options.join(', ')}`)
  await api.answer(job, id, { option })
}

type Applied = { status: 'applied' | 'undone' | 'refused'; files?: string[]; stale?: string[]; reason?: string }

/** Writes the job's patch into its repo (or, with `undo`, puts back what it replaced), only if every file is as expected. */
export function applyJob(home: string, job: string, o: { undo?: boolean }): Applied {
  const dir = jobDir(home, job)
  const meta = readJson<JobFile>(join(dir, 'job.json'))
  if (!meta || !existsSync(join(dir, 'edit.patch'))) return { status: 'refused', reason: `job ${job} has no patch on this machine` }
  const res = readJson<Result>(join(dir, 'result.json'))
  if (res && res.status !== 'ready' && res.status !== 'done') return { status: 'refused', reason: `job ${job} is ${res.status}, not ready` }
  const appliedPath = join(dir, 'applied.json')
  const applied = readJson<{ after: Record<string, string | null> }>(appliedPath)
  if (!o.undo && applied) return { status: 'refused', reason: `job ${job} is applied already (undo with fractal apply ${job} --undo)` }
  if (o.undo && !applied) return { status: 'refused', reason: `job ${job} is not applied` }
  const patch = o.undo ? readFileSync(join(dir, 'reverse.patch'), 'utf8') : readFileSync(join(dir, 'edit.patch'), 'utf8')
  // the patch is the server's: every path it names must be one of the repo's own files, or nothing is read or written
  const named = [...new Set(parsePatch(patch).flatMap(f => [f.from, f.to]).filter((p): p is string => p !== null))]
  const outside = named.flatMap(p => { const why = notOwn(meta.repo, p); return why ? [`${p} (${why})`] : [] })
  if (outside.length) return { status: 'refused', reason: `the patch names paths outside the repo's own files, so nothing was written: ${outside.join(', ')}` }
  const files = patchedFiles(patch)
  const read = (p: string) => (existsSync(join(meta.repo, p)) ? readFileSync(join(meta.repo, p), 'utf8') : undefined)
  const expected = (p: string) => (o.undo ? applied!.after[p] : meta.files[p]) ?? null
  const stale = files.filter(p => {
    const now = read(p)
    const want = expected(p)
    return want === null ? now !== undefined : now === undefined || sha256(Buffer.from(now)) !== want
  })
  if (stale.length) return { status: 'refused', stale, reason: 'these files changed since the job read them: run the job again' }
  let out: Record<string, string | null>
  try { out = applyPatch(read, patch) } catch (e) {
    if (e instanceof PatchError) return { status: 'refused', reason: e.message }
    throw e
  }
  for (const [p, text] of Object.entries(out)) {
    const full = join(meta.repo, p)
    if (text === null) { rmSync(full, { force: true }); continue }
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  if (o.undo) {
    rmSync(appliedPath)
    return { status: 'undone', files }
  }
  writeFileSync(join(dir, 'reverse.patch'), reversePatch(patch))
  writeJson(appliedPath, { at: Date.now(), after: Object.fromEntries(Object.entries(out).map(([p, t]) => [p, t === null ? null : sha256(Buffer.from(t))])) })
  return { status: 'applied', files }
}
