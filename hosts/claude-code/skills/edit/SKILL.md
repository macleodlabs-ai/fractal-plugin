---
name: edit
description: Change an existing TypeScript or Python repo in place with Fractal - it first routes the request (a planned change for an architecture risk it finds, a plain edit of only the declarations the change needs, or no change), says the route and why, and the repo's own type check and tests judge the result in a local copy before anything is written. Use when the user asks Fractal to make a change to existing code.
argument-hint: "<the change, in words>"
allowed-tools: Bash(fractal *), Read
---

# Edit an existing repo with Fractal

Fractal does the editing. Its hosted engine reads the repo and its architecture findings, then one judgment
picks the route for the request: one finding's change plan, a plain edit (only the declarations the change
needs are rewritten, in a copy), or leaving the code as it is. Its model calls run here, through `claude -p`
on this subscription, each a bare call with only Fractal's own prompt; the repo's type check and tests run
here too, in a local copy. So **you never answer Fractal's prompts, you never pick the route for Fractal, and
you never edit the code it changes yourself**.

Your judgment is the task text, and the user's approval.

**One deployable by default.** A change plan keeps the app a modular monolith: one local change, or new
modules and in-process events inside the same deployable. A route never splits the app into separately
deployed services. When the user asks for a split in their own words, use `/fractal:arch` instead (its
`--allow-split` comes with the split's cost).

If `fractal status` says this machine is not connected, ask the user to run `fractal connect` (it opens a
sign-in page; a free trial, then a plan).

## 1. Write the task

Change: $ARGUMENTS

Turn it into one or two plain sentences Fractal can act on: what changes, what the API or behaviour must do
after, and what must stay as it is. Spell out status codes and defaults the user implies. Keep every
constraint the user states (for example "it stays one process with one database"): the route is judged
against them. Pick the language: `ts` when the code to change is TypeScript, `py` when it is Python.

## 2. Route it and run it

Ask the user once whether Fractal may run the repo's own tests: they execute the repo's code (in a copy).
Then start it:

```bash
fractal solve --task "<task>" --repo . --lang <ts|py> --hands claude --detach [--no-tests] [--test-cmd "<cmd>"] [--learned] [--sandbox srt]
```

`--task` also takes a file holding the task. `--no-tests` when the user said no to the tests. `--learned`
when the repo names a team library (`.fcg/library`): a change plan then uses the team's promoted operator
when its preconditions hold here (the result says whether it was used, and how many spans its templates
wrote); a trial of it is reported, never kept in the team's library. `--dry-run` routes only and runs
nothing: use it when the user wants to see the route before anything runs.

It prints the job id. Follow it with `fractal status <job>` until it ends. The repo's checks run under srt
(network off, writes only in the copy) whenever srt is installed. When it is not, tell the user once that
`npm install -g @anthropic-ai/sandbox-runtime` makes them run that way.

A plain edit with options the route does not take is `fractal edit "<task>"` (the same flags as above, no
`--learned` or `--dry-run`): `--propagate` when the user wants the same change made everywhere the code is
written the same way, `--ask wait` when they want to be asked before Fractal decides something on their
behalf (relay the question in `fractal status`, then `fractal answer <job> <question id> "<their option>"`;
never pick one yourself), `--check-values` and `--write-tests` when the change adds or removes a value of a
list, or touches untested code. Use it only when the user asks for one of these.

## 3. Show the route and why

The brief's first line is the route and Fractal's reason for it. Always relay both in plain words, before
anything else:

- a change plan (`<finding>=<proposal>`): which risk Fractal found and where (the declaration it names), what
  the plan changes, and the edit's result (the evidence level, each declaration edited and why, which
  contracts changed and which held, test results). A hosted plan has no fault-injection flow, so its fault
  checks are unknown: say that plainly, never as passed;
- `edit`: the plain edit's result, as above;
- `leave`: nothing was changed, and why the code is left as it is;
- `not judged`: no route could be judged, so nothing ran. Say so; never pick one yourself.

When the user disagrees with the route, say what they can do instead: `/fractal:arch` to pick a finding's
option themselves, or a narrower task. A BLOCKED edit means a check failed outside what Fractal was allowed to
change, often a test that relies on the old behaviour. Report the lines it names. Don't edit the code
yourself to make it pass. Show the patch when the user wants to see it.

## 4. Apply, only on the user's word

When the user approves the change in their own words: `fractal apply <job>`. It refuses if a file changed
since the job read it. To undo: `fractal apply <job> --undo`.
