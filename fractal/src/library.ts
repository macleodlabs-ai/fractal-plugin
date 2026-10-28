// A team library: a git repo the team owns, named for a repo in its .fcg/library file ({url, branch}). Only what
// is merged into that branch counts. A hosted edit carries its data (operators, the profile's values); its plugin
// modules are code, and code from a team never runs on the hosted engine, so they are only named, never read.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { exec } from './proc'

export type TeamData = { url: string; operators: Record<string, Record<string, unknown>[]>; profile?: string; plugins: string[] }

export function libraryRecord(repo: string): { url: string; branch: string } | undefined {
  const p = join(repo, '.fcg', 'library')
  if (!existsSync(p)) return undefined
  const rec = JSON.parse(readFileSync(p, 'utf8')) as { url?: unknown; branch?: unknown }
  if (typeof rec.url !== 'string' || !rec.url) throw new Error(`${p}: no library url in it`)
  return { url: rec.url, branch: typeof rec.branch === 'string' && rec.branch ? rec.branch : 'main' }
}

async function git(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<string> {
  const r = await exec(['git', ...args], { cwd, env })
  if (r.code !== 0) throw new Error(`the team library: git ${args[0]} failed: ${r.stderr.trim().slice(0, 300)}`)
  return r.stdout
}

/** The library this repo names, fetched into the client's home and read at its default branch; none: undefined. */
export async function teamData(repo: string, home: string, env: NodeJS.ProcessEnv = process.env): Promise<TeamData | undefined> {
  const rec = libraryRecord(repo)
  if (!rec) return undefined
  const dir = join(home, 'libraries', createHash('sha256').update(rec.url).digest('hex').slice(0, 16))
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(join(dir, '..'), { recursive: true })
    await git(['clone', '-q', '--no-checkout', rec.url, dir], env)
  } else {
    await git(['fetch', '-q', '--prune', 'origin'], env, dir)
  }
  const ref = `origin/${rec.branch}`
  const names = (await git(['ls-tree', '-r', '--name-only', ref], env, dir)).split('\n').filter(Boolean)
  const show = (name: string) => git(['show', `${ref}:${name}`], env, dir)
  const operators: TeamData['operators'] = {}
  for (const name of names) {
    const m = /^operators\/([^/]+)\/v(\d+)\.json$/.exec(name)
    if (!m) continue
    const v = { ...(JSON.parse(await show(name)) as Record<string, unknown>), version: Number(m[2]) }
    ;(operators[m[1]!] ??= []).push(v)
  }
  for (const vs of Object.values(operators)) vs.sort((a, b) => Number(a.version) - Number(b.version))
  return {
    url: rec.url, operators, plugins: names.filter(n => /^plugins\/[^_/][^/]*\.py$/.test(n)),
    ...(names.includes('profile/fcg.toml') ? { profile: await show('profile/fcg.toml') } : {}),
  }
}

/** A solve's args with the team library's architecture operators (family `arch/...`, no trial history: a job's args
 *  are capped at 64 KB), the ones `learned` looks in, and its profile. None: the solve says "not available". */
export async function withArchOperators(args: Record<string, unknown>, repo: string, home: string, say: (s: string) => void): Promise<void> {
  const team = await teamData(repo, home)
  if (!team) return
  const operators = Object.fromEntries(Object.entries(team.operators).filter(([fam]) => fam.startsWith('arch/'))
    .map(([fam, vs]) => [fam, vs.map(({ trials: _trials, ...v }) => v)]))
  args.library = { operators, ...(team.profile !== undefined ? { profile: team.profile } : {}) }
  if (team.plugins.length) say(`the team library's plugin modules stay on this machine (${team.plugins.join(', ')}): `
    + 'the hosted engine runs no team code, so this solve goes without them')
}

/** A hosted edit's args with the team library's data added: its profile, and the family `args.operator` names (a
 *  job's args are capped at 64 KB, so no other family and no trial history go). The plugins left behind are said. */
export async function withTeam(args: Record<string, unknown>, repo: string, home: string, say: (s: string) => void): Promise<void> {
  const team = await teamData(repo, home)
  if (!team) return
  const family = typeof args.operator === 'string' ? args.operator.split('@')[0]! : undefined
  const operators = family && team.operators[family]
    ? { [family]: team.operators[family]!.map(({ trials: _trials, ...v }) => v) } : {}
  args.library = { operators, ...(team.profile !== undefined ? { profile: team.profile } : {}) }
  if (team.plugins.length) say(`the team library's plugin modules stay on this machine (${team.plugins.join(', ')}): `
    + 'the hosted engine runs no team code, so this edit goes without them')
}
