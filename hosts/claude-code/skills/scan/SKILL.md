---
name: scan
description: Map an existing TypeScript or Python repo with Fractal, read-only - its declarations, who calls what, which tests reach which code, what could not be resolved - or show everything a change to one declaration can reach. Use when the user asks Fractal to look at, map or assess a repo, or asks what a change would affect.
argument-hint: "[a declaration to check the impact of]"
allowed-tools: Bash(fractal *), Read
---

# Map a repo, or check a change's reach, with Fractal

A scan makes no model call and writes nothing to the repo. The repo's text files are sent to Fractal's
engine by sha for the job's life only (24 hours at most, deleted when the job ends).

Pick the language: `ts` when the code is TypeScript, `py` when it is Python.

## Map the repo

```bash
fractal scan --repo . --lang <ts|py>
```

Relay the summary: size, how much of the code tests reach, the most depended-on declarations, and any
references Fractal could not resolve (places where callers may be missing).

## What would a change reach?

Argument: $ARGUMENTS

```bash
fractal scan --repo . --lang <ts|py> --symbol "<file::Name or Name>" [--depth N]
```

The output lists callers layer by layer, the files they sit in and the tests that reach the declaration.
If a name is declared more than once, Fractal lists the ids instead; ask the user which one, or pass the id.
To make the change itself, use `/fractal:edit`.
