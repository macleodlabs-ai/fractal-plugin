---
name: connect
description: Connect this machine's Fractal client to a Fractal account - it opens a sign-in page (GitHub or email) and waits until the person confirms. Use when the user asks to connect or sign in to Fractal, or when another Fractal command says this machine is not connected.
allowed-tools: Bash(fractal *)
---

# Connect Fractal to your account

Run, with a 10-minute timeout (it waits for the person to finish signing in):

```bash
fractal connect
```

It opens a page in the browser and prints its address and a code. Tell the user the address and the code, and
that the page asks them to sign in with GitHub or email and confirm the code. Do not open or fill in the page
yourself: the sign-in is theirs.

When it prints `connected`, say so in one line. If it timed out, tell the user to run `/fractal:connect` again
when they are ready. Never print or repeat the token it saves.
