---
name: policy
description: Check an existing TypeScript or Python repo against architecture policies with Fractal, read-only - the twelve factors (config in the environment, logs to stdout, graceful shutdown, ...), observability (structured logs, correlation, metrics, health) and module boundaries - each compliant, violated, unknown or exempt, with the evidence; then fix one violated policy as a dry-run edit. Use when the user asks whether a repo follows twelve-factor, is observable, keeps its module boundaries, or to fix one of those.
argument-hint: "[a pack or policy the user cares about]"
allowed-tools: Bash(fractal *), Read
---

# Check a repo's architecture policies, and fix one, with Fractal

Fractal checks; its judgments (is this value environment-specific, does this handler log or swallow?) are
model calls that run here, through `claude -p` on this subscription. So **you never answer Fractal's prompts,
and you never edit the code it changes yourself**.

**One deployable by default.** A remedy keeps the app a modular monolith: a local change inside the repo.
Fractal never proposes splitting the app into separately deployed services unless the user asks for that in
their own words; if they do, use `/fractal:arch` with `--allow-split`, which states the cost of the split.

If `fractal status` says this machine is not connected, ask the user to run `fractal connect`.

Pick the language: `ts` when the code is TypeScript, `py` when it is Python.

## 1. Check

Focus: $ARGUMENTS

```bash
fractal policy --repo . --lang <ts|py> [--pack twelve_factor|observability|architecture] [--policy <id> ...] [--runtime <observations.json>]
```

Read-only. Relay the counts, then each policy that is not compliant: what the evidence shows, file and line.

- **Unknown is not compliant.** When Fractal says unknown, say which evidence would settle it (deploy files,
  a build, runtime observations). Never round it up to a pass.
- **Exempt** comes only from the repo's own `fcg.toml` (`[policy.exempt]`, each with its reason). Never
  exempt a policy yourself.
- `--runtime` takes a JSON file of observations the user gives (name -> value). Never invent one.
- Module boundaries read what each module declares public; a repo whose modules declare nothing has no
  boundary violations, and that is what Fractal reports.

## 2. Fix one, only on the user's choice

A violated policy whose remedy is a safe edit says `fractal policy --fix <id>`; one whose remedy is by hand says
what to do, in the simplest local form first. Ask the user which, if any, to fix, and once whether Fractal may
run the repo's own tests (they execute the repo's code, in a copy). Then:

```bash
fractal policy --fix <policy id> --repo . --lang <ts|py> --hands claude --detach [--run-tests] [--test-cmd "<cmd>"]
```

Follow it with `fractal status <job>`. Relay the result: the edit's evidence level, its change proof, and the
policy's status checked again in the edited copy. Show the patch when the user wants to see it.

## 3. Apply, only on the user's word

When the user approves in their own words: `fractal apply <job>`. To undo: `fractal apply <job> --undo`.
