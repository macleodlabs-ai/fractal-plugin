# Fractal for Claude Code

Fractal changes existing TypeScript and Python repos in place, only where a change needs, and judges the result
with the repo's own type check and tests. Or it maps a repo read-only. Its engine is hosted. This plugin and its
client are free and hold none of it: they speak the job protocol only.

- **Your model, not ours.** Every model call the engine needs comes back to this machine and is answered by your
  own Claude Code (`claude -p`, a bare call on your Claude subscription). We never hold a model key and never pay
  for, or see the bill of, a model call.
- **Your machine runs the code.** The repo's type check and tests run here, in a local copy (`~/.fractal/jobs/<job>/shadow`),
  never in the repo and never on our servers. Only the checks a job needs run (`python -m mypy|pytest|unittest`,
  `mypy`, `pytest`, `tsc`, `npm test`, `node` on a script in the copy, and your own `--test-cmd`), never through a
  shell, without the secrets in your environment. When srt is installed they run under it: network off, writes
  only in the copy, no reads of your keys and tokens (`--sandbox none` turns it off).
- **The repo's own tools.** A check runs with the checker and test runner the repo itself uses, at the version it
  pins, with its own settings: the repo's installed copy (`node_modules`, its `.venv`, which is also its Python),
  else `~/.fractal/tools/<npm|pypi>/<tool>@<version>`, else installed there on first need (npm `--ignore-scripts`,
  Python wheels only, into a venv of the repo's Python), never into the repo or your global setup. Only mypy,
  pytest, TypeScript and pyright, at exact versions. `--no-install-tools` (or `FRACTAL_INSTALL_TOOLS=off`) turns
  installs off: the check then does not run and says the command that installs it. `FRACTAL_TOOLS_FROM=DIR`
  installs from a folder of wheels and npm tarballs instead of the registries.
  Finding or installing a tool runs nothing of the repo (a Python tool's venv is made from the interpreter the
  repo's venv links to, outside the repo), and the cache copy comes first on PATH, NODE_PATH and PYTHONPATH. A tool
  from the cache or an install is pinned by its version only, no lockfile hash checked, and the run's answer says so.
- **What our servers see.** The repo's text files, sent by sha, for the job's life only: 24 hours at most and
  deleted when the job ends. Never `.git`, dependency folders, `.env` files, binaries, links or files over 1 MB,
  and in a git repo nothing `.gitignore` excludes. They are never logged and never used for anything else.
- **Nothing is written to the repo** until you say so: `fractal apply <job>` writes the patch only while every file
  is as it was uploaded, and `--undo` puts back exactly what it replaced.

## Install

In Claude Code (the client needs Node 20 or later; macOS, Linux, Windows):

```
/plugin marketplace add macleodlabs-ai/fractal-plugin
/plugin install fractal@fractal
/fractal:connect            # sign in with GitHub or email; free while Fractal is in preview
```

Then `/fractal:edit <the change, in words>` or `/fractal:scan`. The plugin carries the client
(`hosts/claude-code/lib/fractal.mjs`, built from `fractal/`); its model calls run on your Claude subscription.

## Use

```bash
fractal edit "node_state reports a paused issue as paused" [--run-tests] [--sandbox srt] [--ask wait]
fractal status <job>                    # the latest events, a waiting question, the brief, the patch
fractal answer <job> <question> "<option>"
fractal apply <job> [--undo]
fractal scan [--lift] [--domains] [--hypotheses] [--offers]   # read-only; the options ask your model
fractal impact file::Name [--depth N]  # what a change reaches (also: fractal scan --symbol); no model call
fractal domains                         # the modules organised into domains
fractal offers --regions <scan job>     # refactor offers, from a scan made with --lift
fractal edit --offer <module> --regions <scan job>   # act on one, as a dry run with its change proof
```

`--hands claude[:MODEL]` picks the Claude model (default `$FRACTAL_HANDS`, else claude). `--record DIR` keeps every
answer for a later `--hands replay:DIR`.

The client also serves MCP (`fractal mcp`), with the same as tools: `fractal_edit`, `fractal_scan`, `fractal_status`,
`fractal_answer`, `fractal_apply`. A job runs in a detached process, so no tool call outlives a host's timeout.

## Develop

`fractal/`: TypeScript, `bun test`, `bun run typecheck` (strict), `bun run build` (one file for Node, copied to
`hosts/claude-code/lib/fractal.mjs` for the plugin). The tests
play the service with `test/fake-engine.ts`, which speaks the job protocol and nothing else.

## Licence

Proprietary to Macleod Labs: see [LICENSE](LICENSE). Installing and running the plugin to use the Fractal service is
permitted; the source is published for transparency only.
