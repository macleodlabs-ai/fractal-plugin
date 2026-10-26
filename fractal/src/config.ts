// Where the client keeps its sign-in and jobs: $FRACTAL_HOME, else ~/.fractal. The token file is the person's
// only (0600). FRACTAL_URL and FRACTAL_TOKEN override it, for CI and for a local engine.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_URL = 'https://fractal.macleodlabs.com'
export type Config = { url: string; token?: string }
type Env = Record<string, string | undefined>

export function fractalHome(env: Env = process.env): string {
  return env.FRACTAL_HOME || join(homedir(), '.fractal')
}

export function loadConfig(home: string, env: Env = process.env): Config {
  let saved: Partial<Config> = {}
  try { saved = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as Partial<Config> } catch { /* not connected yet */ }
  const url = env.FRACTAL_URL || saved.url || DEFAULT_URL
  const token = env.FRACTAL_TOKEN || (saved.url === url || !env.FRACTAL_URL ? saved.token : undefined)
  return token ? { url, token } : { url }
}

export function saveConfig(home: string, c: Config): void {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const p = join(home, 'config.json')
  writeFileSync(p, JSON.stringify(c, null, 1), { mode: 0o600 })
  chmodSync(p, 0o600)
}
