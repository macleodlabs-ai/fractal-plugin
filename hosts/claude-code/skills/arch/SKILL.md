---
name: arch
description: Map an existing TypeScript or Python repo's architecture risks with Fractal - events published apart from the write that caused them, consumers that repeat an effect on redelivery, the policies it breaks - each with its options ranked simplest first, then run the option the user picks as a dry-run change with its proof. Use when the user asks Fractal to assess a repo's architecture, its reliability or design risks, or to fix one of them.
argument-hint: "[what the user is worried about]"
allowed-tools: Bash(fractal *), Read
---

# Architecture risks, options and a planned change, with Fractal

Fractal finds the risks and plans the change. Its hosted engine reads the repo's code; every judgment it needs
(is this call a database write, a publish, a consumer?) is a model call that runs here, through `claude -p` on
this subscription, with only Fractal's own prompt. So **you never answer Fractal's prompts, you never pick an
option for the user, and you never edit the code it changes yourself**.

**One deployable by default.** Fractal's options keep the app a modular monolith: leave it and state the risk,
one local change, then new modules and in-process events inside the same deployable. A split into separately
deployed services, or a network broker between modules of one app, is proposed only when the user asks for one
in their own words (`--allow-split`), and then it comes with its cost: more deployables to observe, tracing
across them, more on-call and upkeep. Never offer a split the user did not ask for.

If `fractal status` says this machine is not connected, ask the user to run `fractal connect`.

Pick the language: `ts` when the code is TypeScript, `py` when it is Python.

## 1. Map the risks

Concern: $ARGUMENTS

```bash
fractal arch --repo . --lang <ts|py>
```

Read-only: nothing in the repo changes. Relay each finding in plain words: what can go wrong and where (the
declaration it names), then its options in the order Fractal ranks them, simplest first, each with its
verdict (applies, avoid, unknown). Say what is not proposed and why. A finding Fractal could not settle
(evidence or a judgment missing) is unknown: say so, never call it fine.

For the policies alone (twelve-factor, observability, module boundaries), use `/fractal:policy`.

## 2. The user picks

Ask which option they want for which finding. "Leave it" is a valid answer. Only on their choice:

```bash
fractal arch --repo . --lang <ts|py> --choose <finding>=<option> [--choose <finding>=<option> ...]
```

`<finding>` is its id, or its kind when only one finding has it. Add `--shape strangler_fig` or
`--shape branch_by_abstraction` only when the user wants the change laid out in phases. It prints the plan:
new modules, edits and wiring, each in a phase, and the command that runs it.

## 3. Run the plan, as a dry run

Ask the user once whether Fractal may run the repo's own tests: they execute the repo's code (in a copy).

```bash
fractal edit --plan <the plan's path, or the arch job's id> --repo . --lang <ts|py> --hands claude --detach [--run-tests]
```

Follow it with `fractal status <job>` until it ends. Relay the change proof: the evidence level, what was kept
(every route and signature, read again from the edited copy), what changes in behaviour and why (for example
delivery at most once -> at least once, duplicates deduplicated), and which checks are proven and which are
unknown. A hosted plan has no fault-injection flow, so its fault checks are unknown: say that plainly, never
as passed. Show the patch when the user wants to see it.

## 4. Apply, only on the user's word

When the user approves the change in their own words: `fractal apply <job>`. It refuses if a file changed
since the job read it. To undo: `fractal apply <job> --undo`.
