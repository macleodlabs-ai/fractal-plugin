// `fractal setup <host>`: the project files that point a host agent at the fractal MCP server, with the hands that
// host has (its own model CLI). No model key is ever written: Grok reads XAI_API_KEY from the environment.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const HOSTS = ['claude', 'codex', 'cursor', 'grok'] as const
export type Host = (typeof HOSTS)[number]

/** What every host is told: Fractal does the work; the host relays, and applies only on the person's word. */
export const RULES = `Fractal changes this repo in place, or maps it read-only, through the \`fractal\` MCP tools.
Fractal's hosted engine plans the change and checks it; your machine answers its model calls with your own
model, and runs the repo's type check and tests in a local copy. Nothing is written to the repo until the
person says so.

- To change code: call \`fractal_edit\` with the change in one or two plain sentences (what changes, what must
  hold after, what must stay as it is). Ask the person once whether the repo's own tests may run (they execute
  the repo's code, in a copy) and pass \`run_tests\` accordingly.
- To map the repo, or see what a change to one declaration reaches: call \`fractal_scan\` (with \`symbol\`).
- Follow a job with \`fractal_status\`. When it shows a question, relay it in the person's words and answer
  with their choice through \`fractal_answer\`. Never pick an option yourself.
- Relay the brief: READY, BLOCKED or FAILED, what was edited and why, the checks' results, the patch path.
  Show the patch when the person wants to see it. A BLOCKED job names the check that failed: report it; do not
  edit the code yourself to make it pass.
- Call \`fractal_apply\` only when the person approves the change in their own words. \`undo\` puts it back.
- Never answer Fractal's model prompts yourself and never edit the files a job changes.`

const MARK = '<!-- fractal -->'
const END = '<!-- /fractal -->'

function put(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** Replaces this file's fractal section, or appends one. */
function section(path: string, body: string) {
  const old = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const block = `${MARK}\n${body}\n${END}\n`
  const i = old.indexOf(MARK)
  const j = old.indexOf(END)
  put(path, i >= 0 && j > i ? old.slice(0, i) + block + old.slice(j + END.length + 1) : old + (old && !old.endsWith('\n\n') ? '\n' : '') + block)
}

function mcpJson(path: string, hands: string) {
  let cfg: { mcpServers?: Record<string, unknown> } = {}
  try { cfg = JSON.parse(readFileSync(path, 'utf8')) as typeof cfg } catch { /* none yet */ }
  cfg.mcpServers = { ...cfg.mcpServers, fractal: { command: 'fractal', args: ['mcp'], env: { FRACTAL_HANDS: hands } } }
  put(path, JSON.stringify(cfg, null, 2) + '\n')
}

/** Writes the host's files under `dir`; returns what was written and what the person still does. */
export function setup(host: Host, dir: string): string[] {
  if (host === 'codex') {
    section(join(dir, 'AGENTS.md'), `## Fractal\n\n${RULES}`)
    const toml = join(dir, '.codex', 'config.toml')
    const old = existsSync(toml) ? readFileSync(toml, 'utf8') : ''
    if (!old.includes('[mcp_servers.fractal]'))
      put(toml, old + (old && !old.endsWith('\n') ? '\n' : '') + '[mcp_servers.fractal]\ncommand = "fractal"\nargs = ["mcp"]\nenv = { FRACTAL_HANDS = "codex" }\ntool_timeout_sec = 120\n' +
        '# the job tools write nothing to the repo; writing the patch is asked each time\ndefault_tools_approval_mode = "approve"\n\n' +
        '[mcp_servers.fractal.tools.fractal_apply]\napproval_mode = "prompt"\n')
    return ['AGENTS.md (a Fractal section)', '.codex/config.toml (the fractal MCP server; Codex reads it in a trusted project, or run: codex mcp add fractal --env FRACTAL_HANDS=codex -- fractal mcp)']
  }
  if (host === 'cursor') {
    mcpJson(join(dir, '.cursor', 'mcp.json'), 'cursor')
    put(join(dir, '.cursor', 'rules', 'fractal.mdc'), `---\ndescription: Change or map this repo with Fractal (the fractal MCP tools)\nalwaysApply: false\n---\n\n${RULES}\n`)
    return ['.cursor/mcp.json (the fractal MCP server)', '.cursor/rules/fractal.mdc']
  }
  if (host === 'grok') {
    mcpJson(join(dir, '.grok', 'settings.json'), 'grok')
    section(join(dir, 'GROK.md'), `## Fractal\n\n${RULES}`)
    return ['.grok/settings.json (the fractal MCP server, model calls on Grok)', 'GROK.md', 'set XAI_API_KEY in your environment: model calls go from this machine to api.x.ai with your key; or run `fractal edit --hands grok` from any terminal']
  }
  return ['nothing to write: install the plugin with `claude plugin marketplace add <path to public/hosts/claude-code>` then `claude plugin install fractal`']
}
