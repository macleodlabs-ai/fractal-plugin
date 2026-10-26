// The job protocol, as the client speaks it (docs: the M7 design's "The job protocol"). Every call but the two
// sign-in ones carries `Authorization: Bearer fr1.<account>.<token id>.<hmac>`.
//
//   POST /v1/connect                {label}                         → {code, device, url, interval, expiresIn}
//   POST /v1/connect/token          {device}                        → 428 pending | 410 expired | {token, account}
//   POST /v1/jobs                   {kind, args, files: {path: sha}} → {job, need: [sha]}
//   PUT  /v1/jobs/{job}/files       {sha: base64}                   (≤ 1 MB a file, ≤ 50 MB a job)
//   POST /v1/jobs/{job}/start
//   GET  /v1/jobs/{job}/events?after=N  (long poll, 25 s)          → {events, requests, next, status}
//   POST /v1/jobs/{job}/answers     {id, result}
//   GET  /v1/jobs/{job}/result                                      → {status, report, patch, delta, board}
//   DELETE /v1/jobs/{job}
//   POST /v1/jobs/{job}/view                                        → {url}: the job's board on any screen for 2 h
//
// A request is {id, type: "model" | "run" | "question", ...} (as the engine sends it; read here into `kind`): model {op, key, system, user, json_schema, model?} answered
// {text, usage, model, latency_s} (or {error}); run {argv, cwd, files, need?} answered {code, stdout, stderr, tools?}; question
// {text, options, evidence} answered {option}. Shapes read from the server are checked here, never trusted.
import type { Need } from './tools'

/** The engine's job kinds: each is a local command of its, with that command's options as args. */
export const KINDS = ['edit', 'scan', 'domains', 'impact', 'offers'] as const
export type Kind = (typeof KINDS)[number]

export type JobEvent = { seq: number; type: string; [k: string]: unknown }
/** `model`: the job routes this kind of call to another model of the host's (its `routes`). */
export type ModelReq = { id: string; kind: 'model'; op: string; key: string; system: string; user: string; json_schema?: unknown; max_tokens?: number; model?: string }
/** `need`: the tools the run uses, the app's own at the app's version, which this machine resolves (src/tools.ts). */
export type RunReq = { id: string; kind: 'run'; argv: string[]; cwd: string; files: Record<string, string | null>; timeout_s?: number; need: Need[] }
export type QuestionReq = { id: string; kind: 'question'; text: string; options: string[]; evidence: string[] }
export type Req = ModelReq | RunReq | QuestionReq
/** A request this client cannot read: answered with `why` as its error, never left for the engine to time out. */
export type BadReq = { id: string; why: string }
export type Poll = { events: JobEvent[]; requests: Req[]; bad: BadReq[]; next: number; status: string }
export type Result = { status: string; report: Record<string, unknown>; patch: string; delta: unknown; board: unknown }

/** A job in one of these is over: no more events or requests come. */
export const TERMINAL = new Set(['done', 'ready', 'blocked', 'failed', 'stopped', 'deleted', 'expired'])

const isStr = (x: unknown): x is string => typeof x === 'string'
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.filter(isStr) : [])
/** A run's `need` as sent, or undefined when it is not a list of {tool, version, eco[, default]}: strings, but
 * `version` null when the app pins none (then `default`, if given, is the version to install). */
function needs(x: unknown): Need[] | undefined {
  if (x === undefined || x === null) return []
  if (!Array.isArray(x)) return undefined
  const out: Need[] = []
  for (const n of x) {
    if (!isObj(n) || !isStr(n.tool) || !(isStr(n.version) || n.version === null) || !isStr(n.eco)) return undefined
    if (n.default !== undefined && !isStr(n.default)) return undefined
    out.push({ tool: n.tool, version: n.version, eco: n.eco, ...(isStr(n.default) ? { default: n.default } : {}) })
  }
  return out
}

/** A request as the server sent it, or undefined when it is not one this client knows. */
export function parseRequest(x: unknown): Req | undefined {
  if (!isObj(x) || !isStr(x.id)) return undefined
  const kind = x.type
  if (kind === 'model' && isStr(x.op) && isStr(x.key) && isStr(x.system) && isStr(x.user))
    return { id: x.id, kind, op: x.op, key: x.key, system: x.system, user: x.user, json_schema: x.json_schema ?? undefined, max_tokens: typeof x.max_tokens === 'number' ? x.max_tokens : undefined, ...(isStr(x.model) && x.model ? { model: x.model } : {}) }
  const need = needs(x.need)
  if (kind === 'run' && Array.isArray(x.argv) && x.argv.every(isStr) && x.argv.length && need) {
    const files: Record<string, string | null> = {}
    if (isObj(x.files)) for (const [k, v] of Object.entries(x.files)) if (isStr(v) || v === null) files[k] = v
    return { id: x.id, kind, argv: x.argv as string[], cwd: isStr(x.cwd) ? x.cwd : '', files, timeout_s: typeof x.timeout_s === 'number' ? x.timeout_s : undefined, need }
  }
  if (kind === 'question' && isStr(x.text)) return { id: x.id, kind, text: x.text, options: strs(x.options), evidence: strs(x.evidence) }
  return undefined
}

export function parsePoll(x: unknown, after: number): Poll {
  const o = isObj(x) ? x : {}
  const events: JobEvent[] = []
  let seq = after
  for (const e of Array.isArray(o.events) ? o.events : []) {
    if (!isObj(e) || !isStr(e.type)) continue
    seq = typeof e.seq === 'number' ? e.seq : seq + 1
    events.push({ ...e, seq, type: e.type })
  }
  const next = typeof o.next === 'number' ? o.next : seq
  const requests: Req[] = []
  const bad: BadReq[] = []
  for (const r of Array.isArray(o.requests) ? o.requests : []) {
    if (!isObj(r) || !isStr(r.id)) continue   // no id: nothing to answer it by
    const req = parseRequest(r)
    if (req) requests.push(req)
    else bad.push({ id: r.id, why: ['model', 'run', 'question'].includes(r.type as string) ? `this client does not understand this ${r.type as string} request: a field it needs is missing or of the wrong type` : `this client does not understand request type ${JSON.stringify(r.type) ?? 'none'}` })
  }
  return { events, requests, bad, next, status: isStr(o.status) ? o.status : 'running' }
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfterS?: number) {
    super(message)
  }
}

/** How long the client keeps trying through retryable failures: the engine gives up on a silent client after 10 minutes. */
export const RETRY_FOR_MS = 9 * 60_000

/** A failure worth trying again: the network, the service's own errors, a timeout or a rate limit. */
export const retryable = (e: unknown) => !(e instanceof ApiError) || e.status >= 500 || e.status === 408 || e.status === 429

/** The wait before try `n` (from 0) of a retryable call: what the service asked for (Retry-After), else 1, 2, 4 … 30 s, jittered. */
export const retryDelay = (e: unknown, n: number) =>
  e instanceof ApiError && e.retryAfterS !== undefined ? e.retryAfterS * 1000 : Math.min(30_000, 1000 * 2 ** n) * (0.5 + Math.random() / 2)

/** `call`, tried again through retryable failures for up to `forMs`; any other failure is thrown as it is. */
export async function retrying<T>(call: () => Promise<T>, forMs = RETRY_FOR_MS): Promise<T> {
  const since = Date.now()
  for (let n = 0; ; n++) {
    try {
      return await call()
    } catch (e) {
      if (!retryable(e)) throw e
      if (Date.now() - since > forMs) throw new Error(`lost the Fractal service for ${Math.round(forMs / 60_000)} minutes: ${(e as Error).message}`)
      await new Promise(r => setTimeout(r, retryDelay(e, n)))
    }
  }
}

export const NOT_CONNECTED = 'Fractal did not accept this machine\'s sign-in: run `fractal connect`.'
export const NO_PLAN = 'Your Fractal trial or plan has ended, or your team has no seat for you: see your account page.'

export class Api {
  constructor(readonly base: string, readonly token: string | undefined, private readonly fetcher: typeof fetch = fetch) {}

  private async call(method: string, path: string, body?: unknown, o: { signal?: AbortSignal; ok?: number[] } = {}): Promise<{ status: number; data: unknown }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.token) headers.authorization = `Bearer ${this.token}`
    const res = await this.fetcher(this.base.replace(/\/$/, '') + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: o.signal })
    const text = await res.text()
    let data: unknown = text
    try { data = text ? JSON.parse(text) : {} } catch { /* not JSON: kept as text */ }
    if (res.ok || o.ok?.includes(res.status)) return { status: res.status, data }
    const said = isObj(data) && isStr(data.error) ? data.error : String(text).slice(0, 200)
    if (res.status === 401) throw new ApiError(401, NOT_CONNECTED)
    if (res.status === 402 || res.status === 403) throw new ApiError(res.status, `${NO_PLAN}${said ? ` (${said})` : ''}`)
    const after = Number(res.headers.get('retry-after') ?? NaN)   // seconds; the HTTP-date form is left to the backoff
    throw new ApiError(res.status, `${method} ${path}: ${res.status} ${said}`, Number.isFinite(after) && after >= 0 ? after : undefined)
  }

  async connect(label: string) {
    const { data } = await this.call('POST', '/v1/connect', { label })
    const d = isObj(data) ? data : {}
    if (!isStr(d.code) || !isStr(d.device) || !isStr(d.url)) throw new ApiError(502, 'the sign-in service answered something unexpected')
    return { code: d.code, device: d.device, url: d.url, interval: typeof d.interval === 'number' ? d.interval : 2, expiresIn: typeof d.expiresIn === 'number' ? d.expiresIn : 600 }
  }

  /** The token once the person has signed in; undefined while they have not; ApiError 410 once the code expired. */
  async connectToken(device: string): Promise<{ token: string; account: Record<string, unknown> } | undefined> {
    const { status, data } = await this.call('POST', '/v1/connect/token', { device }, { ok: [428] })
    if (status === 428) return undefined
    const d = isObj(data) ? data : {}
    if (!isStr(d.token)) throw new ApiError(502, 'the sign-in service answered without a token')
    return { token: d.token, account: isObj(d.account) ? d.account : {} }
  }

  async createJob(kind: Kind, args: Record<string, unknown>, files: Record<string, string>): Promise<{ job: string; need: string[] }> {
    const { data } = await this.call('POST', '/v1/jobs', { kind, args, files })
    const d = isObj(data) ? data : {}
    if (!isStr(d.job)) throw new ApiError(502, 'the service answered without a job id')
    return { job: d.job, need: strs(d.need) }
  }

  async putFiles(job: string, blobs: Record<string, string>): Promise<void> {
    await this.call('PUT', `/v1/jobs/${encodeURIComponent(job)}/files`, blobs)
  }

  async start(job: string): Promise<void> {
    await this.call('POST', `/v1/jobs/${encodeURIComponent(job)}/start`, {})
  }

  async events(job: string, after: number, signal?: AbortSignal): Promise<Poll> {
    const { data } = await this.call('GET', `/v1/jobs/${encodeURIComponent(job)}/events?after=${after}`, undefined, { signal })
    return parsePoll(data, after)
  }

  async answer(job: string, id: string, result: unknown): Promise<void> {
    await this.call('POST', `/v1/jobs/${encodeURIComponent(job)}/answers`, { id, result })
  }

  async result(job: string): Promise<Result> {
    const { data } = await this.call('GET', `/v1/jobs/${encodeURIComponent(job)}/result`)
    const d = isObj(data) ? data : {}
    return { status: isStr(d.status) ? d.status : 'unknown', report: isObj(d.report) ? d.report : {}, patch: isStr(d.patch) ? d.patch : '', delta: d.delta ?? null, board: d.board ?? null }
  }

  /** The job's board for a browser on any screen (no token in the page), or undefined where none is served (a local engine). */
  async view(job: string): Promise<string | undefined> {
    const { status, data } = await this.call('POST', `/v1/jobs/${encodeURIComponent(job)}/view`, {}, { ok: [404, 405] })
    return status === 200 && isObj(data) && isStr(data.url) ? data.url : undefined
  }

  async purge(job: string): Promise<void> {
    await this.call('DELETE', `/v1/jobs/${encodeURIComponent(job)}`)
  }
}
