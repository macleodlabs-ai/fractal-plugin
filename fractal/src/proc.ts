import { spawn } from 'node:child_process'

/** Environment variables that hold secrets: never passed to a run or an install. */
export const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i
/** The environment without its secrets. */
export const withoutSecrets = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_ENV.test(k)))

export type Ran = { code: number; stdout: string; stderr: string; timedOut: boolean }

/** Runs argv (never through a shell), feeding `stdin`, keeping at most `limit` bytes of each stream. */
export function exec(argv: string[], o: { cwd?: string; stdin?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; limit?: number } = {}): Promise<Ran> {
  const limit = o.limit ?? 8 << 20
  return new Promise((resolve, reject) => {
    const p = spawn(argv[0]!, argv.slice(1), { cwd: o.cwd, env: o.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let n = 0
    let m = 0
    let timedOut = false
    const timer = o.timeoutMs ? setTimeout(() => { timedOut = true; p.kill('SIGKILL') }, o.timeoutMs) : undefined
    p.stdout.on('data', (b: Buffer) => { if (n < limit) out.push(b); n += b.length })
    p.stderr.on('data', (b: Buffer) => { if (m < limit) err.push(b); m += b.length })
    p.on('error', e => { if (timer) clearTimeout(timer); reject(e) })
    p.on('close', code => {
      if (timer) clearTimeout(timer)
      resolve({ code: code ?? (timedOut ? 124 : 1), stdout: Buffer.concat(out).toString('utf8').slice(0, limit), stderr: Buffer.concat(err).toString('utf8').slice(0, limit), timedOut })
    })
    p.stdin.on('error', () => {})
    p.stdin.end(o.stdin ?? '')
  })
}
