// Local hands for the engine's model requests: the host's own model answers each one, on the person's own
// subscription or key. Each call carries only the request's own prompt: the CLIs run with no tools to speak of,
// in an empty folder, so no project instructions (AGENTS.md, .cursor/rules, CLAUDE.md) reach them.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exec } from './proc'

/** `model`: a job's route for this kind of call; the claude hand answers with it, the other hands with their own. */
export type ModelRequest = { op: string; key: string; system: string; user: string; json_schema?: unknown; max_tokens?: number; model?: string }
export type Usage = { prompt_tokens: number; completion_tokens: number; cached_tokens: number }
export type Answer = { text: string; usage: Usage; model: string; latency_s: number; approx?: true }
export interface ModelHand { name: string; complete(r: ModelRequest): Promise<Answer> }

export const HANDS = ['claude', 'codex', 'cursor', 'grok', 'replay'] as const
const TIMEOUT_MS = 900_000
const approxTokens = (s: string) => Math.max(1, Math.round(s.length / 3.6))

type Opts = { exe?: string; env?: Record<string, string | undefined> }

function emptyDir(): string {
  return mkdtempSync(join(tmpdir(), 'fractal-model-'))
}

async function run(argv: string[], stdin: string, cwd?: string) {
  const r = await exec(argv, { stdin, cwd, timeoutMs: TIMEOUT_MS })
  if (r.timedOut) throw new Error(`${argv[0]} took over ${TIMEOUT_MS / 60_000} minutes`)
  return r
}

function claude(model: string | undefined, o: Opts): ModelHand {
  const exe = o.exe ?? 'claude'
  // `--flag=` for an empty value: Bun's spawn drops an empty argv entry
  const flags = ['--tools=', '--strict-mcp-config', '--setting-sources=', '--disable-slash-commands', '--no-session-persistence', '--output-format', 'json']
  return {
    name: `claude${model ? ':' + model : ''}`,
    async complete(r) {
      const t0 = Date.now()
      const m = r.model ?? model
      const res = await run([exe, '-p', ...(m ? ['--model', m] : []), '--system-prompt', r.system, ...flags], r.user, emptyDir())
      let data: { result?: unknown; is_error?: boolean; usage?: Record<string, number> }
      try {
        data = JSON.parse(res.stdout)
      } catch {
        throw new Error(`claude -p failed (${res.code}): ${(res.stderr || res.stdout).slice(-500)}`)
      }
      if (data.is_error) throw new Error(`claude -p: ${String(data.result).slice(0, 500)}`)
      const u = data.usage ?? {}
      const cached = u.cache_read_input_tokens ?? 0
      return {
        text: String(data.result ?? ''), model: r.model ? `claude:${r.model}` : this.name, latency_s: (Date.now() - t0) / 1000,
        usage: { prompt_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + cached, completion_tokens: u.output_tokens ?? 0, cached_tokens: cached },
      }
    },
  }
}

/** The request as one prompt, for CLIs with no system-prompt flag. */
const onePrompt = (r: ModelRequest) => `<instructions>\n${r.system}\n</instructions>\n\n${r.user}`

function codex(model: string | undefined, o: Opts): ModelHand {
  const exe = o.exe ?? 'codex'
  return {
    name: `codex${model ? ':' + model : ''}`,
    async complete(r) {
      const t0 = Date.now()
      const cwd = emptyDir()
      const res = await run([exe, 'exec', '--json', '--skip-git-repo-check', '--ephemeral', '--ignore-rules', '-s', 'read-only', '-C', cwd, ...(model ? ['-m', model] : []), '-'], onePrompt(r), cwd)
      let text: string | undefined
      let usage: Usage = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 }
      let failed: string | undefined
      for (const line of res.stdout.split('\n')) {
        let ev: { type?: string; item?: { type?: string; text?: string }; usage?: Record<string, number>; message?: string; error?: { message?: string } }
        try { ev = JSON.parse(line) } catch { continue }
        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') text = ev.item.text ?? ''
        if (ev.type === 'turn.completed' && ev.usage) usage = { prompt_tokens: ev.usage.input_tokens ?? 0, completion_tokens: ev.usage.output_tokens ?? 0, cached_tokens: ev.usage.cached_input_tokens ?? 0 }
        if (ev.type === 'error' || ev.type === 'turn.failed') failed = ev.message ?? ev.error?.message ?? 'failed'
      }
      if (text === undefined) throw new Error(`codex exec: ${failed ?? `no answer (${res.code}) ${res.stderr.slice(-500)}`}`)
      return { text, usage, model: this.name, latency_s: (Date.now() - t0) / 1000 }
    },
  }
}

function cursor(model: string | undefined, o: Opts): ModelHand {
  const exe = o.exe ?? 'cursor-agent'
  return {
    name: `cursor${model ? ':' + model : ''}`,
    async complete(r) {
      const t0 = Date.now()
      const cwd = emptyDir()
      const prompt = onePrompt(r)
      const res = await run([exe, '-p', '--output-format', 'json', '--mode', 'ask', '--trust', '--workspace', cwd, ...(model ? ['--model', model] : []), prompt], '', cwd)
      let data: { result?: unknown; is_error?: boolean; usage?: Record<string, number> }
      try {
        data = JSON.parse(res.stdout)
      } catch {
        throw new Error(`cursor-agent failed (${res.code}): ${(res.stderr || res.stdout).slice(-500)}`)
      }
      if (data.is_error) throw new Error(`cursor-agent: ${String(data.result).slice(0, 500)}`)
      const text = String(data.result ?? '')
      const u = data.usage
      const base = { text, model: this.name, latency_s: (Date.now() - t0) / 1000 }
      if (u && typeof u.inputTokens === 'number') return { ...base, usage: { prompt_tokens: u.inputTokens, completion_tokens: u.outputTokens ?? 0, cached_tokens: u.cacheReadTokens ?? 0 } }
      return { ...base, usage: { prompt_tokens: approxTokens(prompt), completion_tokens: approxTokens(text), cached_tokens: 0 }, approx: true }
    },
  }
}

function grok(model: string | undefined, o: Opts): ModelHand {
  const env = o.env ?? process.env
  const m = model ?? 'grok-4'
  return {
    name: `grok:${m}`,
    async complete(r) {
      const key = env.XAI_API_KEY
      if (!key) throw new Error('Grok needs your xAI key in XAI_API_KEY (it is sent only to api.x.ai)')
      const base = (env.XAI_BASE_URL ?? 'https://api.x.ai/v1').replace(/\/$/, '')
      const body: Record<string, unknown> = { model: m, messages: [{ role: 'system', content: r.system }, { role: 'user', content: r.user }] }
      if (r.max_tokens) body.max_tokens = r.max_tokens
      if (r.json_schema) body.response_format = { type: 'json_schema', json_schema: { name: 'fcg_output', schema: r.json_schema, strict: true } }
      const t0 = Date.now()
      const res = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) })
      if (!res.ok) throw new Error(`xAI answered ${res.status}: ${(await res.text()).slice(0, 300)}`)
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } }
      const u = data.usage ?? {}
      return {
        text: data.choices?.[0]?.message?.content ?? '', model: this.name, latency_s: (Date.now() - t0) / 1000,
        usage: { prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0, cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 },
      }
    },
  }
}

/** Answers from a trace folder: `<op>_<key>.<attempt>.txt`, the attempt counting each time the same key is asked. */
function replay(dir: string): ModelHand {
  const attempts = new Map<string, number>()
  return {
    name: `replay:${dir}`,
    async complete(r) {
      const n = attempts.get(`${r.op}:${r.key}`) ?? 0
      attempts.set(`${r.op}:${r.key}`, n + 1)
      const p = join(dir, `${r.op}_${r.key}.${n}.txt`)
      if (!existsSync(p)) throw new Error(`no recorded answer for ${r.op}:${r.key} attempt ${n} in ${dir}`)
      const text = readFileSync(p, 'utf8')
      return { text, model: this.name, latency_s: 0, usage: { prompt_tokens: approxTokens(r.system + r.user), completion_tokens: approxTokens(text), cached_tokens: 0 }, approx: true }
    },
  }
}

/** A hand from its name: `claude[:model]`, `codex[:model]`, `cursor[:model]`, `grok[:model]` or `replay:DIR`. */
export function modelHand(spec: string, o: Opts): ModelHand {
  const i = spec.indexOf(':')
  const kind = i < 0 ? spec : spec.slice(0, i)
  const arg = i < 0 ? undefined : spec.slice(i + 1) || undefined
  if (kind === 'claude') return claude(arg, o)
  if (kind === 'codex') return codex(arg, o)
  if (kind === 'cursor') return cursor(arg, o)
  if (kind === 'grok') return grok(arg, o)
  if (kind === 'replay' && arg) return replay(arg)
  throw new Error(`unknown model hand ${JSON.stringify(spec)}: one of claude, codex, cursor, grok (each optionally :MODEL), or replay:DIR`)
}

/** Keeps every answer `inner` gives in `dir`, named as replay reads them. */
export function recording(inner: ModelHand, dir: string): ModelHand {
  mkdirSync(dir, { recursive: true })
  const attempts = new Map<string, number>()
  return {
    name: inner.name,
    async complete(r) {
      const n = attempts.get(`${r.op}:${r.key}`) ?? 0
      attempts.set(`${r.op}:${r.key}`, n + 1)
      const a = await inner.complete(r)
      writeFileSync(join(dir, `${r.op}_${r.key}.${n}.txt`), a.text)
      writeFileSync(join(dir, `${r.op}_${r.key}.${n}.meta.json`), JSON.stringify({ model: a.model, duration_s: a.latency_s, ...a.usage }))
      return a
    },
  }
}
