---
name: edit
description: Change an existing TypeScript or Python repo in place with Fractal - only the declarations the change needs are rewritten, nothing else moves, and the repo's own type check and tests judge the result in a local copy before anything is written. Use when the user asks Fractal to make a change to existing code.
argument-hint: "<the change, in words>"
allowed-tools: Bash(fractal *), Read
---

# Edit an existing repo with Fractal

Fractal does the editing. Its hosted engine indexes the repo, picks the declarations the change needs and
rewrites only those, in a copy. Its model calls run here, through `claude -p` on this subscription, each a
bare call with only Fractal's own prompt; the repo's type check and tests run here too, in a local copy.
So **you never answer Fractal's prompts, and you never edit the code it changes yourself**.

Your judgment is the task text, and the user's approval.

If `fractal status` says this machine is not connected, ask the user to run `fractal connect` (it opens a
sign-in page; a free trial, then a plan).

## 1. Write the task

Change: $ARGUMENTS

Turn it into one or two plain sentences Fractal can act on: what changes, what the API or behaviour must do
after, and what must stay as it is. Spell out status codes and defaults the user implies. Pick the language:
`ts` when the code to change is TypeScript, `py` when it is Python.

## 2. Run the edit

Ask the user once whether Fractal may run the repo's own tests: they execute the repo's code (in a copy).
Then start it:

```bash
fractal edit "<task>" --repo . --lang <ts|py> --hands claude --detach [--run-tests] [--test-cmd "<cmd>"] [--sandbox srt]
```

It prints the job id. Follow it with `fractal status <job>` until it ends. The repo's checks run under srt
(network off, writes only in the copy) whenever srt is installed. When it is not, tell the user once that
`npm install -g @anthropic-ai/sandbox-runtime` makes them run that way.

- `--propagate` when the user wants the same change made everywhere the code is written the same way.
- `--ask wait` when the user wants to be asked before Fractal decides something on their behalf. A question
  shows in `fractal status` (`question <id>: …`). Relay it in their words, then answer with their choice:
  `fractal answer <job> <question id> "<option>"`. Never pick an option yourself.
- `--check-values` and `--write-tests` are opt-in. Offer them when the change adds or removes a value of a
  list, or touches untested code.

The brief says READY, BLOCKED or FAILED, the evidence level, each declaration edited and why, which contracts
changed and which held, test results, and the patch path. Relay it. Show the patch when the user wants to see
it. A BLOCKED edit means a check failed outside what Fractal was allowed to change, often a test that relies
on the old behaviour. Report the lines it names. Don't edit the code yourself to make it pass.

## 3. Apply, only on the user's word

When the user approves the change in their own words: `fractal apply <job>`. It refuses if a file changed
since the job read it. To undo: `fractal apply <job> --undo`.
