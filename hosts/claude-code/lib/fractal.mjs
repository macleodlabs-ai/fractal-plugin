#!/usr/bin/env node
import { createRequire } from "node:module";
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __toESM = (mod, isNodeMode, target) => {
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: () => mod[key],
        enumerable: true
      });
  return to;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: (newValue) => all[name] = () => newValue
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/config.ts
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
function fractalHome(env = process.env) {
  return env.FRACTAL_HOME || join(homedir(), ".fractal");
}
function loadConfig(home, env = process.env) {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  } catch {
  }
  const url = env.FRACTAL_URL || saved.url || DEFAULT_URL;
  const token = env.FRACTAL_TOKEN || (saved.url === url || !env.FRACTAL_URL ? saved.token : undefined);
  return token ? { url, token } : { url };
}
function saveConfig(home, c) {
  mkdirSync(home, { recursive: true, mode: 448 });
  const p = join(home, "config.json");
  writeFileSync(p, JSON.stringify(c, null, 1), { mode: 384 });
  chmodSync(p, 384);
}
var DEFAULT_URL = "https://fractal.macleodlabs.com";
var init_config = () => {
};

// src/protocol.ts
function needs(x) {
  if (x === undefined || x === null)
    return [];
  if (!Array.isArray(x))
    return;
  const out = [];
  for (const n of x) {
    if (!isObj(n) || !isStr(n.tool) || !(isStr(n.version) || n.version === null) || !isStr(n.eco))
      return;
    if (n.default !== undefined && !isStr(n.default))
      return;
    out.push({ tool: n.tool, version: n.version, eco: n.eco, ...isStr(n.default) ? { default: n.default } : {} });
  }
  return out;
}
function parseRequest(x) {
  if (!isObj(x) || !isStr(x.id))
    return;
  const kind = x.type;
  if (kind === "model" && isStr(x.op) && isStr(x.key) && isStr(x.system) && isStr(x.user))
    return { id: x.id, kind, op: x.op, key: x.key, system: x.system, user: x.user, json_schema: x.json_schema ?? undefined, max_tokens: typeof x.max_tokens === "number" ? x.max_tokens : undefined, ...isStr(x.model) && x.model ? { model: x.model } : {} };
  const need = needs(x.need);
  if (kind === "run" && Array.isArray(x.argv) && x.argv.every(isStr) && x.argv.length && need) {
    const files = {};
    if (isObj(x.files)) {
      for (const [k, v] of Object.entries(x.files))
        if (isStr(v) || v === null)
          files[k] = v;
    }
    return { id: x.id, kind, argv: x.argv, cwd: isStr(x.cwd) ? x.cwd : "", files, timeout_s: typeof x.timeout_s === "number" ? x.timeout_s : undefined, need };
  }
  if (kind === "question" && isStr(x.text))
    return { id: x.id, kind, text: x.text, options: strs(x.options), evidence: strs(x.evidence) };
  return;
}
function parsePoll(x, after) {
  const o = isObj(x) ? x : {};
  const events = [];
  let seq = after;
  for (const e of Array.isArray(o.events) ? o.events : []) {
    if (!isObj(e) || !isStr(e.type))
      continue;
    seq = typeof e.seq === "number" ? e.seq : seq + 1;
    events.push({ ...e, seq, type: e.type });
  }
  const next = typeof o.next === "number" ? o.next : seq;
  const requests = [];
  const bad = [];
  for (const r of Array.isArray(o.requests) ? o.requests : []) {
    if (!isObj(r) || !isStr(r.id))
      continue;
    const req = parseRequest(r);
    if (req)
      requests.push(req);
    else
      bad.push({ id: r.id, why: ["model", "run", "question"].includes(r.type) ? `this client does not understand this ${r.type} request: a field it needs is missing or of the wrong type` : `this client does not understand request type ${JSON.stringify(r.type) ?? "none"}` });
  }
  return { events, requests, bad, next, status: isStr(o.status) ? o.status : "running" };
}
async function retrying(call, forMs = RETRY_FOR_MS) {
  const since = Date.now();
  for (let n = 0;; n++) {
    try {
      return await call();
    } catch (e) {
      if (!retryable(e))
        throw e;
      if (Date.now() - since > forMs)
        throw new Error(`lost the Fractal service for ${Math.round(forMs / 60000)} minutes: ${e.message}`);
      await new Promise((r) => setTimeout(r, retryDelay(e, n)));
    }
  }
}

class Api {
  base;
  token;
  fetcher;
  constructor(base, token, fetcher = fetch) {
    this.base = base;
    this.token = token;
    this.fetcher = fetcher;
  }
  async call(method, path, body, o = {}) {
    const headers = { "content-type": "application/json" };
    if (this.token)
      headers.authorization = `Bearer ${this.token}`;
    const res = await this.fetcher(this.base.replace(/\/$/, "") + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: o.signal });
    const text = await res.text();
    let data = text;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
    }
    if (res.ok || o.ok?.includes(res.status))
      return { status: res.status, data };
    const said = isObj(data) && isStr(data.error) ? data.error : String(text).slice(0, 200);
    if (res.status === 401)
      throw new ApiError(401, NOT_CONNECTED);
    if (res.status === 402 || res.status === 403)
      throw new ApiError(res.status, `${NO_PLAN}${said ? ` (${said})` : ""}`);
    const after = Number(res.headers.get("retry-after") ?? NaN);
    throw new ApiError(res.status, `${method} ${path}: ${res.status} ${said}`, Number.isFinite(after) && after >= 0 ? after : undefined);
  }
  async connect(label) {
    const { data } = await this.call("POST", "/v1/connect", { label });
    const d = isObj(data) ? data : {};
    if (!isStr(d.code) || !isStr(d.device) || !isStr(d.url))
      throw new ApiError(502, "the sign-in service answered something unexpected");
    return { code: d.code, device: d.device, url: d.url, interval: typeof d.interval === "number" ? d.interval : 2, expiresIn: typeof d.expiresIn === "number" ? d.expiresIn : 600 };
  }
  async connectToken(device) {
    const { status, data } = await this.call("POST", "/v1/connect/token", { device }, { ok: [428] });
    if (status === 428)
      return;
    const d = isObj(data) ? data : {};
    if (!isStr(d.token))
      throw new ApiError(502, "the sign-in service answered without a token");
    return { token: d.token, account: isObj(d.account) ? d.account : {} };
  }
  async createJob(kind, args, files) {
    const { data } = await this.call("POST", "/v1/jobs", { kind, args, files });
    const d = isObj(data) ? data : {};
    if (!isStr(d.job))
      throw new ApiError(502, "the service answered without a job id");
    return { job: d.job, need: strs(d.need) };
  }
  async putFiles(job, blobs) {
    await this.call("PUT", `/v1/jobs/${encodeURIComponent(job)}/files`, blobs);
  }
  async start(job) {
    await this.call("POST", `/v1/jobs/${encodeURIComponent(job)}/start`, {});
  }
  async events(job, after, signal) {
    const { data } = await this.call("GET", `/v1/jobs/${encodeURIComponent(job)}/events?after=${after}`, undefined, { signal });
    return parsePoll(data, after);
  }
  async answer(job, id, result) {
    await this.call("POST", `/v1/jobs/${encodeURIComponent(job)}/answers`, { id, result });
  }
  async result(job) {
    const { data } = await this.call("GET", `/v1/jobs/${encodeURIComponent(job)}/result`);
    const d = isObj(data) ? data : {};
    return { status: isStr(d.status) ? d.status : "unknown", report: isObj(d.report) ? d.report : {}, patch: isStr(d.patch) ? d.patch : "", delta: d.delta ?? null, board: d.board ?? null };
  }
  async view(job) {
    const { status, data } = await this.call("POST", `/v1/jobs/${encodeURIComponent(job)}/view`, {}, { ok: [404, 405] });
    return status === 200 && isObj(data) && isStr(data.url) ? data.url : undefined;
  }
  async purge(job) {
    await this.call("DELETE", `/v1/jobs/${encodeURIComponent(job)}`);
  }
}
var TERMINAL, isStr = (x) => typeof x === "string", isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x), strs = (x) => Array.isArray(x) ? x.filter(isStr) : [], ApiError, RETRY_FOR_MS, retryable = (e) => !(e instanceof ApiError) || e.status >= 500 || e.status === 408 || e.status === 429, retryDelay = (e, n) => e instanceof ApiError && e.retryAfterS !== undefined ? e.retryAfterS * 1000 : Math.min(30000, 1000 * 2 ** n) * (0.5 + Math.random() / 2), NOT_CONNECTED = "Fractal did not accept this machine's sign-in: run `fractal connect`.", NO_PLAN = "Your Fractal trial or plan has ended, or your team has no seat for you: see your account page.";
var init_protocol = __esm(() => {
  TERMINAL = new Set(["done", "ready", "blocked", "failed", "stopped", "deleted", "expired"]);
  ApiError = class ApiError extends Error {
    status;
    retryAfterS;
    constructor(status, message, retryAfterS) {
      super(message);
      this.status = status;
      this.retryAfterS = retryAfterS;
    }
  };
  RETRY_FOR_MS = 9 * 60000;
});

// src/files.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync as existsSync2, lstatSync, readdirSync, readFileSync as readFileSync3, realpathSync } from "node:fs";
import { dirname as dirname2, isAbsolute, join as join3, relative, sep } from "node:path";
function notOwn(root, rel, skip = SKIP_DIRS) {
  const parts = rel.split(/[\\/]/);
  if (isAbsolute(rel) || /^[a-z]:/i.test(rel))
    return "an absolute path";
  if (parts.includes(".."))
    return "a path that climbs out with ..";
  const folder = parts.find((p) => skip.has(p.toLowerCase()));
  if (folder !== undefined)
    return `inside ${folder}`;
  let at = join3(root, rel);
  for (;; ) {
    try {
      lstatSync(at);
      break;
    } catch {
      at = dirname2(at);
    }
  }
  let real;
  try {
    real = realpathSync(at);
  } catch {
    return "through a link that leads nowhere";
  }
  const top = realpathSync(root);
  return real === top || real.startsWith(top + sep) ? undefined : "through a link that leads out";
}
function sha256(b) {
  return createHash("sha256").update(b).digest("hex");
}
function walk(root, dir, out) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && SKIP_DIRS.has(e.name))
      continue;
    const p = join3(dir, e.name);
    if (e.isDirectory())
      walk(root, p, out);
    else
      out.push(relative(root, p).split(sep).join("/"));
  }
}
function candidates(root) {
  if (existsSync2(join3(root, ".git"))) {
    try {
      const out2 = execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard"], { cwd: root, maxBuffer: 256 << 20, stdio: ["ignore", "pipe", "ignore"] }).toString();
      return out2.split("\x00").filter(Boolean);
    } catch {
    }
  }
  const out = [];
  walk(root, root, out);
  return out;
}
async function listRepo(root) {
  const res = { files: {}, sizes: {}, skipped: [], bytes: 0 };
  for (const path of candidates(root).sort()) {
    const parts = path.split("/");
    if (parts.some((p) => SKIP_DIRS.has(p)))
      continue;
    const full = join3(root, path);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue;
    }
    const skip = (why) => res.skipped.push({ path, why });
    if (st.isSymbolicLink()) {
      skip("a link");
      continue;
    }
    if (!st.isFile())
      continue;
    if (ENV_FILE.test(parts[parts.length - 1])) {
      skip("an env file");
      continue;
    }
    if (st.size > MAX_FILE) {
      skip("over 1 MB");
      continue;
    }
    const b = readFileSync3(full);
    if (b.includes(0)) {
      skip("binary");
      continue;
    }
    if (res.bytes + b.length > MAX_JOB) {
      skip("over the 50 MB a job may hold");
      continue;
    }
    res.files[path] = sha256(b);
    res.sizes[path] = b.length;
    res.bytes += b.length;
  }
  return res;
}
function batches(items, size, max = BATCH) {
  const out = [];
  let cur = [];
  let n = 0;
  for (const x of items) {
    const s = size(x);
    if (cur.length && n + s > max) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(x);
    n += s;
  }
  if (cur.length)
    out.push(cur);
  return out;
}
var MAX_FILE = 1e6, MAX_JOB = 50000000, BATCH = 4000000, SKIP_DIRS, ENV_FILE;
var init_files = __esm(() => {
  SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", ".fcg", ".fractal", "__pycache__", ".mypy_cache"]);
  ENV_FILE = /^\.env(\..*)?$/;
});

// src/patch.ts
function pathOf(header) {
  const p = header.slice(4).split("\t")[0].trim();
  if (p === "/dev/null")
    return null;
  return p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p;
}
function parsePatch(text) {
  const lines = text.split(`
`);
  const out = [];
  let file;
  let hunk;
  for (let i = 0;i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      file = { from: pathOf(l), to: pathOf(lines[i + 1]), hunks: [] };
      out.push(file);
      hunk = undefined;
      i++;
      continue;
    }
    const m = HUNK.exec(l);
    if (m && file) {
      hunk = { oldStart: +m[1], oldLen: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLen: m[4] === undefined ? 1 : +m[4], lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk)
      continue;
    if (l.startsWith("\\")) {
      const last = hunk.lines[hunk.lines.length - 1];
      if (last)
        last.text = last.text.replace(/\n$/, "");
      continue;
    }
    const op = l[0];
    if (op === " " || op === "-" || op === "+")
      hunk.lines.push({ op, text: l.slice(1) + `
` });
    else if (l === "" && i === lines.length - 1)
      continue;
    else
      throw new PatchError(`not a unified diff line: ${JSON.stringify(l.slice(0, 80))}`);
  }
  return out;
}
function patchedFiles(text) {
  return parsePatch(text).map((f) => f.to ?? f.from);
}
function splitKeep(s) {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
function applyOne(f, current) {
  const name = f.to ?? f.from;
  if (f.from === null && current !== undefined)
    throw new PatchError(`${name} exists already: a created file never overwrites one`);
  if (f.from !== null && current === undefined)
    throw new PatchError(`${name} is missing`);
  const old = splitKeep(current ?? "");
  const out = [];
  let at = 0;
  for (const h of f.hunks) {
    const start = h.oldLen === 0 ? h.oldStart : h.oldStart - 1;
    if (start < at)
      throw new PatchError(`${name}: hunks overlap`);
    out.push(...old.slice(at, start));
    let k = start;
    for (const l of h.lines) {
      if (l.op === "+") {
        out.push(l.text);
        continue;
      }
      if (old[k] !== l.text)
        throw new PatchError(`${name} changed since the job read it (line ${k + 1})`);
      if (l.op === " ")
        out.push(l.text);
      k++;
    }
    at = k;
  }
  out.push(...old.slice(at));
  if (f.to === null) {
    if (out.length)
      throw new PatchError(`${name} changed since the job read it`);
    return null;
  }
  return out.join("");
}
function applyPatch(read, text) {
  const res = {};
  for (const f of parsePatch(text)) {
    const name = f.to ?? f.from;
    res[name] = applyOne(f, name in res ? res[name] ?? undefined : read(name));
  }
  return res;
}
function render(f) {
  const head = (p, side) => p === null ? "/dev/null" : `${side}/${p}`;
  const out = [`--- ${head(f.from, "a")}`, `+++ ${head(f.to, "b")}`];
  for (const h of f.hunks) {
    out.push(`@@ -${h.oldStart},${h.oldLen} +${h.newStart},${h.newLen} @@`);
    for (const l of h.lines) {
      out.push(l.op + l.text.replace(/\n$/, ""));
      if (!l.text.endsWith(`
`))
        out.push("\\ No newline at end of file");
    }
  }
  return out.join(`
`) + `
`;
}
function reversePatch(text) {
  const swap = { " ": " ", "-": "+", "+": "-" };
  return parsePatch(text).map((f) => render({
    from: f.to,
    to: f.from,
    hunks: f.hunks.map((h) => ({ oldStart: h.newStart, oldLen: h.newLen, newStart: h.oldStart, newLen: h.oldLen, lines: h.lines.map((l) => ({ op: swap[l.op], text: l.text })) }))
  })).join("");
}
var PatchError, HUNK;
var init_patch = __esm(() => {
  PatchError = class PatchError extends Error {
  };
  HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
});

// src/proc.ts
import { spawn } from "node:child_process";
function exec(argv, o = {}) {
  const limit = o.limit ?? 8 << 20;
  return new Promise((resolve, reject) => {
    const p = spawn(argv[0], argv.slice(1), { cwd: o.cwd, env: o.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    let n = 0;
    let m = 0;
    let timedOut = false;
    const timer = o.timeoutMs ? setTimeout(() => {
      timedOut = true;
      p.kill("SIGKILL");
    }, o.timeoutMs) : undefined;
    p.stdout.on("data", (b) => {
      if (n < limit)
        out.push(b);
      n += b.length;
    });
    p.stderr.on("data", (b) => {
      if (m < limit)
        err.push(b);
      m += b.length;
    });
    p.on("error", (e) => {
      if (timer)
        clearTimeout(timer);
      reject(e);
    });
    p.on("close", (code) => {
      if (timer)
        clearTimeout(timer);
      resolve({ code: code ?? (timedOut ? 124 : 1), stdout: Buffer.concat(out).toString("utf8").slice(0, limit), stderr: Buffer.concat(err).toString("utf8").slice(0, limit), timedOut });
    });
    p.stdin.on("error", () => {
    });
    p.stdin.end(o.stdin ?? "");
  });
}
var SECRET_ENV, withoutSecrets = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !SECRET_ENV.test(k)));
var init_proc = __esm(() => {
  SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
});

// src/tools.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, mkdtempSync, readdirSync as readdirSync2, readFileSync as readFileSync4, realpathSync as realpathSync2, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join as join4, relative as relative2 } from "node:path";
function needRefusal(n) {
  if (!Object.hasOwn(TOOLS, n.eco))
    return `fractal installs tools from ${Object.keys(TOOLS).join(" or ")} only, not ${JSON.stringify(n.eco)}`;
  if (!TOOLS[n.eco].has(n.tool))
    return `${JSON.stringify(n.tool)} (${n.eco}) is not a type checker or test runner this client installs`;
  const v = n.version ?? n.default;
  if (v !== undefined && (!EXACT.test(v) || v.includes("..")))
    return `${n.tool} ${JSON.stringify(v)} is not an exact version`;
  return;
}
function sitePackages(venv) {
  const lib = join4(venv, "lib");
  const py = existsSync3(lib) ? readdirSync2(lib).find((x) => /^python\d/.test(x)) : undefined;
  return py && existsSync3(join4(lib, py, "site-packages")) ? join4(lib, py, "site-packages") : undefined;
}
function hasDist(site, tool, version) {
  if (!site)
    return false;
  const exact = `${norm(tool)}-${version}.dist-info`.toLowerCase();
  return readdirSync2(site).some((x) => {
    const l = x.toLowerCase();
    return version === undefined ? l.startsWith(`${norm(tool)}-`) && l.endsWith(".dist-info") : l === exact;
  });
}
function distVersion(site, tool) {
  const pre = `${norm(tool)}-`;
  const d = site ? readdirSync2(site).find((x) => x.toLowerCase().startsWith(pre) && x.endsWith(".dist-info")) : undefined;
  return d?.slice(pre.length, -".dist-info".length);
}
function pyMinor(python) {
  let m = minors.get(python);
  if (!m) {
    m = exec([python, "-I", "-c", 'import sys; print("%d.%d" % sys.version_info[:2])'], { env: withoutSecrets(process.env) }).then((r) => {
      if (r.code !== 0)
        throw new Error(`${python} did not say its version: ${r.stderr.trim()}`);
      return r.stdout.trim();
    });
    minors.set(python, m);
    m.catch(() => minors.delete(python));
  }
  return m;
}
function baseOf(python, w) {
  const base = realpathSync2(python);
  for (const d of [w.repo, w.shadow]) {
    const r = relative2(realpathSync2(d), base);
    if (!r.startsWith(".."))
      throw new Error(`${python} leads to ${base}, inside the repo, and fractal runs nothing of the repo outside the sandbox`);
  }
  return base;
}
async function step(argv, env) {
  const r = await exec(argv, { env, timeoutMs: INSTALL_MS });
  if (r.code !== 0 || r.timedOut)
    throw new Error(`${argv.slice(0, 3).join(" ")} ${r.timedOut ? "timed out" : `exited ${r.code}`}: ${(r.stderr || r.stdout).trim().split(`
`).slice(-3).join(" ")}`);
}
async function install(p) {
  mkdirSync3(join4(p.at, ".."), { recursive: true });
  const stage = mkdtempSync(join4(p.at, "..", ".stage-"));
  const scratch = mkdtempSync(join4(tmpdir(), "fractal-tools-"));
  try {
    await p.build(stage, { ...withoutSecrets(process.env), npm_config_cache: join4(scratch, "npm"), UV_CACHE_DIR: join4(scratch, "uv"), UV_PYTHON_DOWNLOADS: "never", PIP_NO_CACHE_DIR: "1" });
    if (!p.ready(stage))
      throw new Error("the install ended without the tool at that version");
    try {
      renameSync(stage, p.at);
    } catch (e) {
      if (!p.ready(p.at))
        throw e;
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}
function npmPlan(n, o, path) {
  const at = join4(o.dir, "npm", `${n.tool}@${n.version}`);
  const spec = o.from ? join4(o.from, `${n.tool}-${n.version}.tgz`) : `${n.tool}@${n.version}`;
  return {
    at,
    command: `npm install --prefix ${at} --ignore-scripts ${n.tool}@${n.version}`,
    ready: (dir) => {
      try {
        return JSON.parse(readFileSync4(join4(dir, "node_modules", n.tool, "package.json"), "utf8")).version === n.version;
      } catch {
        return false;
      }
    },
    build: async (stage, env) => {
      const npm = onPath("npm", path);
      if (!npm)
        throw new Error("npm is not on PATH");
      if (o.from && !existsSync3(spec))
        throw new Error(`${spec} is not in ${o.from}`);
      await step([npm, "install", "--prefix", stage, "--ignore-scripts", "--no-audit", "--no-fund", "--no-update-notifier", ...o.from ? ["--offline"] : [], spec], env);
    },
    env: (dir) => ({ path: [join4(dir, "node_modules", ".bin")], nodePath: [join4(dir, "node_modules")] })
  };
}
async function pypiPlan(n, o, path, python) {
  const at = join4(o.dir, "pypi", `${n.tool}@${n.version}-py${await pyMinor(python)}`);
  const uv = onPath("uv", path);
  const spec = `${n.tool}==${n.version}`;
  const src = o.from ? ["--no-index", "--find-links", o.from] : [];
  const py = (dir) => join4(dir, "bin", "python");
  return {
    at,
    command: uv ? `uv venv --python ${python} ${at} && uv pip install --python ${py(at)} ${spec}` : `${python} -m venv ${at} && ${py(at)} -m pip install ${spec}`,
    ready: (dir) => hasDist(sitePackages(dir), n.tool, n.version),
    build: async (stage, env) => {
      if (uv) {
        await step([uv, "venv", "--quiet", "--no-config", "--python", python, stage], env);
        await step([uv, "pip", "install", "--quiet", "--no-config", "--python", py(stage), "--only-binary", ":all:", ...src, spec], env);
      } else {
        await step([python, "-m", "venv", stage], env);
        await step([py(stage), "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--no-input", "--only-binary", ":all:", ...src, spec], env);
      }
    },
    env: (dir) => ({ pythonPath: [sitePackages(dir)] })
  };
}
async function resolveTools(need, w, o) {
  const env = { path: [], nodePath: [], pythonPath: [] };
  const used = [];
  const path = o.path ?? process.env.PATH ?? "";
  for (const want of need) {
    const own = (version2) => ({ tool: want.tool, version: want.version ?? version2 ?? "?", eco: want.eco, from: "repo" });
    const pkg = join4(w.shadow, "node_modules", want.tool, "package.json");
    if (want.eco === "npm" && existsSync3(pkg)) {
      let v;
      try {
        v = JSON.parse(readFileSync4(pkg, "utf8")).version;
      } catch {
      }
      used.push(own(v));
      env.path.push(join4(w.shadow, "node_modules", ".bin"));
      continue;
    }
    if (want.eco === "pypi" && w.venv && hasDist(sitePackages(w.venv), want.tool)) {
      used.push(own(distVersion(sitePackages(w.venv), want.tool)));
      continue;
    }
    const version = want.version ?? want.default;
    if (version === undefined)
      return { used, env, missing: `${want.tool}: the app pins no version, the repo has no copy of its own and the engine named no default, so this check did not run` };
    const n = { tool: want.tool, version, eco: want.eco };
    const said = n;
    let plan;
    try {
      if (n.eco === "pypi" && !w.python)
        throw new Error("no python3 on PATH");
      plan = n.eco === "npm" ? npmPlan(n, o, path) : await pypiPlan(n, o, path, baseOf(w.python, w));
    } catch (e) {
      return { used, env, missing: `${n.tool} ${n.version} has nowhere to run, so this check did not run: ${e.message}` };
    }
    let from = "cache";
    if (!plan.ready(plan.at)) {
      if (!o.install)
        return { used, env, missing: `${n.tool} ${n.version}, the app's version, is not installed here and tool installs are off (--no-install-tools or FRACTAL_INSTALL_TOOLS=off), so this check did not run; install it with: ${plan.command}` };
      try {
        await install(plan);
      } catch (e) {
        return { used, env, missing: `fractal could not install ${n.tool} ${n.version} (${n.eco}), so this check did not run: ${e.message}; to install it by hand: ${plan.command}` };
      }
      from = "installed";
    }
    used.push({ ...said, from, at: plan.at, pinned: "version" });
    const add = plan.env(plan.at);
    env.path.push(...add.path ?? []);
    env.nodePath.push(...add.nodePath ?? []);
    env.pythonPath.push(...add.pythonPath ?? []);
  }
  return { used, env };
}
var TOOLS, EXACT, INSTALL_MS = 600000, onPath = (name, path) => path.split(delimiter).filter(Boolean).map((d) => join4(d, name)).find((p) => existsSync3(p)), norm = (name) => name.toLowerCase().replace(/[-_.]+/g, "_"), minors;
var init_tools = __esm(() => {
  init_proc();
  TOOLS = { pypi: new Set(["mypy", "pytest"]), npm: new Set(["typescript", "pyright"]) };
  EXACT = /^\d[A-Za-z0-9.+-]{0,63}$/;
  minors = new Map;
});

// src/runner.ts
import { copyFileSync, existsSync as existsSync4, mkdirSync as mkdirSync4, mkdtempSync as mkdtempSync2, rmSync as rmSync2, symlinkSync, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir as homedir2, tmpdir as tmpdir2 } from "node:os";
import { basename, delimiter as delimiter2, dirname as dirname3, isAbsolute as isAbsolute2, join as join5, relative as relative3, resolve } from "node:path";
function which(name, path = process.env.PATH ?? "") {
  for (const d of path.split(delimiter2))
    if (d && existsSync4(join5(d, name)))
      return join5(d, name);
  return;
}
function srtSettings(shadow, tmp, home) {
  const h = (p) => isAbsolute2(p) ? p : join5(home, p);
  return {
    network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true, allowLocalBinding: false, allowUnixSockets: [tmp] },
    filesystem: { denyRead: [...SECRET_PLACES.map(h), "/Library/Keychains"], allowWrite: [shadow, tmp], denyWrite: UNLISTED_WRITES.map(h) }
  };
}

class Shadow {
  repo;
  dir;
  constructor(repo, dir) {
    this.repo = repo;
    this.dir = dir;
  }
  static async create(repo, dir, files) {
    mkdirSync4(dir, { recursive: true });
    const s = new Shadow(repo, dir);
    for (const f of files) {
      const to = s.inside(f);
      mkdirSync4(dirname3(to), { recursive: true });
      copyFileSync(join5(repo, f), to);
    }
    for (const l of LINKED)
      if (existsSync4(join5(repo, l)) && !existsSync4(join5(dir, l)))
        symlinkSync(join5(repo, l), join5(dir, l));
    return s;
  }
  inside(rel) {
    const why = notOwn(this.dir, rel, new Set(LINKED));
    if (why)
      throw new Error(`${JSON.stringify(rel)} is outside the shadow (${why})`);
    return resolve(this.dir, rel);
  }
  refusal(argv, cwd, testCmd) {
    if (testCmd.length && testCmd.every((w, i) => argv[i] === w))
      return;
    const [prog, a1, a2] = argv;
    const name = basename(prog);
    if (PYTHON.test(name))
      return a1 === "-m" && PY_MODULES.has(a2 ?? "") ? undefined : `${name} runs here only as -m mypy, pytest or unittest`;
    if (CHECKERS.has(name))
      return;
    if (name === "npm") {
      const rest = argv.slice(2);
      const own = rest.includes("--") ? rest.slice(0, rest.indexOf("--")) : rest;
      return a1 === "test" && own.every((w) => w === "--silent") ? undefined : "npm runs here only as npm test";
    }
    if (name === "node") {
      if (!a1 || a1.startsWith("-"))
        return "node runs here only on a script in the local copy, with no options";
      try {
        this.inside(relative3(this.dir, resolve(cwd, a1)));
      } catch (e) {
        return e.message;
      }
      return;
    }
    return `${name} is not a type checker or test runner this client runs`;
  }
  write(files) {
    const plan = Object.entries(files).map(([rel, b]) => [this.inside(rel), b]);
    for (const [p, b] of plan) {
      if (b === null) {
        rmSync2(p, { force: true });
        continue;
      }
      mkdirSync4(dirname3(p), { recursive: true });
      writeFileSync3(p, Buffer.from(b, "base64"));
    }
  }
  async run(req, o) {
    const refuse = (why2) => ({ code: 126, stdout: "", stderr: `fractal refused to run this: ${why2}` });
    let cwd;
    try {
      if (req.files)
        this.write(req.files);
      cwd = this.inside(req.cwd || ".");
    } catch (e) {
      return refuse(e.message);
    }
    const extra = {};
    let words = req.argv;
    if (words[0] === "env") {
      let i = 1;
      for (;i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]); i++) {
        const k = words[i].slice(0, words[i].indexOf("="));
        if (!ENGINE_ENV.has(k))
          return refuse(`env sets only ${[...ENGINE_ENV].join(", ")} here, not ${k}`);
        extra[k] = words[i].slice(k.length + 1);
      }
      words = words.slice(i);
    }
    const [prog, ...rest] = words;
    if (!prog)
      return refuse("no command");
    const name = basename(prog);
    const why = this.refusal(words, cwd, o.testCmd ?? []) ?? req.need?.map(needRefusal).find(Boolean);
    if (why)
      return refuse(why);
    const env = withoutSecrets(process.env);
    Object.assign(env, extra);
    const venv = [".venv", "venv"].map((v) => join5(this.dir, v)).find((v) => existsSync4(join5(v, "bin", "python")));
    if (venv)
      env.PATH = join5(venv, "bin") + delimiter2 + (env.PATH ?? "");
    let tools;
    let viaPython;
    if (req.need?.length) {
      const python = venv ? join5(venv, "bin", "python") : which(PYTHON.test(name) ? name : "python3", env.PATH);
      const got = await resolveTools(req.need, { shadow: this.dir, repo: this.repo, python, venv }, o.tools ?? { dir: join5(fractalHome(), "tools"), install: true });
      tools = got.used;
      if (got.missing)
        return { code: 127, stdout: "", stderr: `fractal: ${got.missing}`, tools };
      const paths = (...xs) => xs.filter(Boolean).join(delimiter2);
      env.PATH = paths(...got.env.path, env.PATH);
      const before = (k, add) => {
        if (add.length)
          env[k] = k in extra ? paths(extra[k], ...add) : paths(...add, env[k]);
      };
      before("NODE_PATH", got.env.nodePath);
      before("PYTHONPATH", got.env.pythonPath);
      if (prog === name && got.used.some((t) => t.eco === "pypi" && t.from !== "repo" && t.tool === name))
        viaPython = python;
    }
    const given = isAbsolute2(prog) && existsSync4(prog) && (!relative3(this.dir, prog).startsWith("..") || o.testCmd?.[0] === prog);
    const exe = viaPython ?? (given ? prog : which(name, name === "node" || name === "npm" ? process.env.PATH : env.PATH));
    if (!exe)
      return { code: 127, stdout: "", stderr: `${name}: not found on this machine's PATH`, tools };
    let argv = viaPython ? [exe, "-m", name, ...rest] : [exe, ...rest];
    let tmp;
    if (o.sandbox === "srt") {
      const srt = which("srt");
      if (!srt)
        return refuse("--sandbox srt needs srt on PATH (npm install -g @anthropic-ai/sandbox-runtime); nothing ran");
      tmp = mkdtempSync2(join5(tmpdir2(), "fractal-sbx-"));
      const cfg = join5(tmp, "srt-settings.json");
      writeFileSync3(cfg, JSON.stringify(srtSettings(this.dir, tmp, o.home ?? homedir2())));
      argv = [srt, "--settings", cfg, "--", "env", `TMPDIR=${tmp}`, ...argv];
    }
    try {
      const r = await exec(argv, { cwd, env, timeoutMs: (req.timeout_s ?? DEFAULT_TIMEOUT_S) * 1000, limit: OUTPUT_LIMIT });
      return { code: r.timedOut ? 124 : r.code, stdout: r.stdout, stderr: r.timedOut ? `${r.stderr}
fractal: stopped after ${req.timeout_s ?? DEFAULT_TIMEOUT_S} s` : r.stderr, ...tools ? { tools } : {} };
    } finally {
      if (tmp)
        rmSync2(tmp, { recursive: true, force: true });
    }
  }
}
var PYTHON, PY_MODULES, CHECKERS, LINKED, ENGINE_ENV, DEFAULT_TIMEOUT_S = 900, OUTPUT_LIMIT, SECRET_PLACES, UNLISTED_WRITES;
var init_runner = __esm(() => {
  init_config();
  init_files();
  init_proc();
  init_tools();
  PYTHON = /^python(3(\.\d+)?)?$/;
  PY_MODULES = new Set(["mypy", "pytest", "unittest"]);
  CHECKERS = new Set(["mypy", "pytest", "tsc", "pyright"]);
  LINKED = ["node_modules", ".venv", "venv"];
  ENGINE_ENV = new Set(["PYTHONPATH", "PYTHONDONTWRITEBYTECODE", "PYTHONHASHSEED", "PYTHONUNBUFFERED", "MYPYPATH", "NODE_PATH", "NODE_ENV", "CI", "TZ"]);
  OUTPUT_LIMIT = 4 << 20;
  SECRET_PLACES = [
    ".ssh",
    ".aws",
    ".config/gcloud",
    ".config/gh",
    ".git-credentials",
    ".docker/config.json",
    ".kube/config",
    ".netrc",
    ".npmrc",
    ".pypirc",
    ".gnupg",
    ".local/share/keyrings",
    ".fractal/config.json",
    ".codex/auth.json",
    ".claude",
    ".cursor",
    "Library/Keychains"
  ];
  UNLISTED_WRITES = ["/tmp/claude", ".npm/_logs", ".claude/debug"];
});

// src/job.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync5, readFileSync as readFileSync5, renameSync as renameSync2, rmSync as rmSync3, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join6 } from "node:path";
function writeJson(path, data) {
  writeFileSync4(path + ".tmp", JSON.stringify(data, null, 1));
  renameSync2(path + ".tmp", path);
}
function jobState(home, job) {
  return readJson(join6(jobDir(home, job), "state.json")) ?? { job, status: "unknown", events: 0, last: [], questions: [], answered: { model: 0, run: 0, failed: 0 }, usage: { prompt_tokens: 0, completion_tokens: 0 } };
}
async function submit(api, kind, args, repo, home) {
  const listing = await listRepo(repo);
  const { job, need } = await api.createJob(kind, args, listing.files);
  const dir = jobDir(home, job);
  mkdirSync5(dir, { recursive: true });
  writeJson(join6(dir, "job.json"), { job, kind, repo, url: api.base, files: listing.files, created: Date.now() });
  const bySha = new Map;
  for (const [p, s] of Object.entries(listing.files))
    bySha.set(s, p);
  const wanted = need.filter((s) => bySha.has(s));
  for (const group of batches(wanted, (s) => listing.sizes[bySha.get(s)])) {
    const blobs = {};
    for (const s of group) {
      const b = readFileSync5(join6(repo, bySha.get(s)));
      if (sha256(b) !== s)
        throw new Error(`${bySha.get(s)} changed while it was being uploaded: run again`);
      blobs[s] = b.toString("base64");
    }
    await api.putFiles(job, blobs);
  }
  await api.start(job);
  writeJson(join6(dir, "state.json"), { ...jobState(home, job), status: "running" });
  return { job, dir, skipped: listing.skipped, files: Object.keys(listing.files).length, bytes: listing.bytes };
}
function eventLine(e) {
  for (const k of ["text", "summary", "status", "reason", "task", "name", "module"]) {
    const v = e[k];
    if (typeof v === "string" && v)
      return `${e.type}: ${v.replace(/\s+/g, " ").slice(0, 140)}`;
  }
  return e.type;
}
async function drive(api, job, home, hands, o) {
  const dir = jobDir(home, job);
  const meta = readJson(join6(dir, "job.json"));
  if (!meta)
    throw new Error(`no job ${job} on this machine`);
  const say = o.onLine ?? (() => {
  });
  const st = jobState(home, job);
  const save = () => writeJson(join6(dir, "state.json"), st);
  const handled = new Set;
  let shadow;
  let runs = Promise.resolve();
  let active = 0;
  const queue = [];
  const limit = hands.concurrency ?? 4;
  const slot = async () => {
    if (active >= limit)
      await new Promise((r) => queue.push(r));
    active++;
  };
  const release = () => {
    active--;
    queue.shift()?.();
  };
  const pending = new Set;
  const post = async (id, result) => {
    try {
      await retrying(() => api.answer(job, id, result));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 409))
        throw e;
    }
  };
  const handle = async (r) => {
    if (r.kind === "model") {
      await slot();
      let answer;
      try {
        const a = await hands.model.complete(r);
        st.answered.model++;
        st.usage.prompt_tokens += a.usage.prompt_tokens;
        st.usage.completion_tokens += a.usage.completion_tokens;
        answer = a;
      } catch (e) {
        st.answered.failed++;
        say(`model call ${r.op} failed: ${e.message}`);
        answer = { error: e.message };
      } finally {
        release();
      }
      await post(r.id, answer);
      return;
    }
    const done = runs.then(async () => {
      let res2;
      try {
        shadow ??= await Shadow.create(meta.repo, join6(dir, "shadow"), Object.keys(meta.files));
        const tools = { dir: join6(home, "tools"), install: hands.installTools !== false, from: process.env.FRACTAL_TOOLS_FROM || undefined };
        res2 = await shadow.run(r, { testCmd: hands.testCmd, sandbox: hands.sandbox, tools });
        for (const t of res2.tools ?? [])
          if (t.from === "installed")
            say(`installed ${t.tool}@${t.version} (${t.eco}) into ${t.at}${t.pinned === "version" ? ", pinned by version: no lockfile hash checked" : ""}`);
        st.answered.run++;
      } catch (e) {
        const err = e;
        st.answered.failed++;
        res2 = { code: 126, stdout: "", stderr: `fractal could not run this: ${err.message}${err.path && !err.message.includes(err.path) ? ` (${err.path})` : ""}` };
      }
      say(`ran ${r.argv.slice(0, 3).join(" ")}${r.argv.length > 3 ? " …" : ""}: exit ${res2.code}${hands.sandbox ? " (srt: network off)" : ""}`);
      await post(r.id, res2);
    });
    runs = done.catch(() => {
    });
    await done;
  };
  const track = (id, p) => {
    const q = p.catch((e) => {
      st.error = e.message;
      say(`could not answer ${id}: ${st.error}`);
    });
    pending.add(q);
    q.finally(() => pending.delete(q));
  };
  let after = 0;
  for (;; ) {
    const poll = await retrying(() => api.events(job, after, AbortSignal.timeout(60000)));
    for (const e of poll.events) {
      const l = eventLine(e);
      st.last = [...st.last, l].slice(-LAST);
      say(l);
    }
    st.events += poll.events.length;
    after = poll.next;
    st.status = poll.status;
    st.questions = poll.requests.filter((r) => r.kind === "question").map(({ id, text, options, evidence }) => ({ id, text, options, evidence }));
    const fresh = [...poll.requests, ...poll.bad].filter((r) => !handled.has(r.id)).length;
    for (const r of poll.requests) {
      if (r.kind === "question" || handled.has(r.id))
        continue;
      handled.add(r.id);
      track(r.id, handle(r));
    }
    for (const b of poll.bad) {
      if (handled.has(b.id))
        continue;
      handled.add(b.id);
      st.answered.failed++;
      say(`request ${b.id}: ${b.why}; answered with that error`);
      track(b.id, post(b.id, { error: b.why }));
    }
    for (const q of st.questions)
      if (!handled.has(q.id)) {
        handled.add(q.id);
        say(`question ${q.id}: ${q.text} [${q.options.join(" | ")}] (answer: fractal answer ${job} ${q.id} "<option>")`);
      }
    save();
    if (TERMINAL.has(poll.status))
      break;
    if (!poll.events.length && !fresh)
      await new Promise((r) => setTimeout(r, IDLE_MS));
  }
  await Promise.all(pending);
  const res = await api.result(job);
  writeJson(join6(dir, "result.json"), res);
  if (res.patch)
    writeFileSync4(join6(dir, "edit.patch"), res.patch);
  rmSync3(join6(dir, "shadow"), { recursive: true, force: true });
  const brief = typeof res.report.brief === "string" ? res.report.brief : `${res.status}${typeof res.report.reason === "string" ? `: ${res.report.reason}` : ""}`;
  st.status = res.status;
  st.brief = brief;
  st.questions = [];
  save();
  say(brief);
  if (res.patch)
    say(`patch: ${join6(dir, "edit.patch")} (${patchedFiles(res.patch).join(", ")}) · apply with: fractal apply ${job}`);
  return res;
}
async function answerQuestion(api, home, job, id, option) {
  const q = jobState(home, job).questions.find((x) => x.id === id);
  if (q && !q.options.includes(option))
    throw new Error(`${JSON.stringify(option)} is not one of: ${q.options.join(", ")}`);
  await api.answer(job, id, { option });
}
function applyJob(home, job, o) {
  const dir = jobDir(home, job);
  const meta = readJson(join6(dir, "job.json"));
  if (!meta || !existsSync5(join6(dir, "edit.patch")))
    return { status: "refused", reason: `job ${job} has no patch on this machine` };
  const res = readJson(join6(dir, "result.json"));
  if (res && res.status !== "ready" && res.status !== "done")
    return { status: "refused", reason: `job ${job} is ${res.status}, not ready` };
  const appliedPath = join6(dir, "applied.json");
  const applied = readJson(appliedPath);
  if (!o.undo && applied)
    return { status: "refused", reason: `job ${job} is applied already (undo with fractal apply ${job} --undo)` };
  if (o.undo && !applied)
    return { status: "refused", reason: `job ${job} is not applied` };
  const patch = o.undo ? readFileSync5(join6(dir, "reverse.patch"), "utf8") : readFileSync5(join6(dir, "edit.patch"), "utf8");
  const named = [...new Set(parsePatch(patch).flatMap((f) => [f.from, f.to]).filter((p) => p !== null))];
  const outside = named.flatMap((p) => {
    const why = notOwn(meta.repo, p);
    return why ? [`${p} (${why})`] : [];
  });
  if (outside.length)
    return { status: "refused", reason: `the patch names paths outside the repo's own files, so nothing was written: ${outside.join(", ")}` };
  const files = patchedFiles(patch);
  const read = (p) => existsSync5(join6(meta.repo, p)) ? readFileSync5(join6(meta.repo, p), "utf8") : undefined;
  const expected = (p) => (o.undo ? applied.after[p] : meta.files[p]) ?? null;
  const stale = files.filter((p) => {
    const now = read(p);
    const want = expected(p);
    return want === null ? now !== undefined : now === undefined || sha256(Buffer.from(now)) !== want;
  });
  if (stale.length)
    return { status: "refused", stale, reason: "these files changed since the job read them: run the job again" };
  let out;
  try {
    out = applyPatch(read, patch);
  } catch (e) {
    if (e instanceof PatchError)
      return { status: "refused", reason: e.message };
    throw e;
  }
  for (const [p, text] of Object.entries(out)) {
    const full = join6(meta.repo, p);
    if (text === null) {
      rmSync3(full, { force: true });
      continue;
    }
    mkdirSync5(join6(full, ".."), { recursive: true });
    writeFileSync4(full, text);
  }
  if (o.undo) {
    rmSync3(appliedPath);
    return { status: "undone", files };
  }
  writeFileSync4(join6(dir, "reverse.patch"), reversePatch(patch));
  writeJson(appliedPath, { at: Date.now(), after: Object.fromEntries(Object.entries(out).map(([p, t]) => [p, t === null ? null : sha256(Buffer.from(t))])) });
  return { status: "applied", files };
}
var LAST = 12, IDLE_MS = 1000, jobDir = (home, job) => join6(home, "jobs", job), readJson = (path) => {
  try {
    return JSON.parse(readFileSync5(path, "utf8"));
  } catch {
    return;
  }
};
var init_job = __esm(() => {
  init_files();
  init_protocol();
  init_patch();
  init_runner();
});

// src/library.ts
import { createHash as createHash2 } from "node:crypto";
import { existsSync as existsSync7, mkdirSync as mkdirSync6, readFileSync as readFileSync7 } from "node:fs";
import { join as join8 } from "node:path";
function libraryRecord(repo) {
  const p = join8(repo, ".fcg", "library");
  if (!existsSync7(p))
    return;
  const rec = JSON.parse(readFileSync7(p, "utf8"));
  if (typeof rec.url !== "string" || !rec.url)
    throw new Error(`${p}: no library url in it`);
  return { url: rec.url, branch: typeof rec.branch === "string" && rec.branch ? rec.branch : "main" };
}
async function git(args, env, cwd) {
  const r = await exec(["git", ...args], { cwd, env });
  if (r.code !== 0)
    throw new Error(`the team library: git ${args[0]} failed: ${r.stderr.trim().slice(0, 300)}`);
  return r.stdout;
}
async function teamData(repo, home, env = process.env) {
  const rec = libraryRecord(repo);
  if (!rec)
    return;
  const dir = join8(home, "libraries", createHash2("sha256").update(rec.url).digest("hex").slice(0, 16));
  if (!existsSync7(join8(dir, ".git"))) {
    mkdirSync6(join8(dir, ".."), { recursive: true });
    await git(["clone", "-q", "--no-checkout", rec.url, dir], env);
  } else {
    await git(["fetch", "-q", "--prune", "origin"], env, dir);
  }
  const ref = `origin/${rec.branch}`;
  const names = (await git(["ls-tree", "-r", "--name-only", ref], env, dir)).split(`
`).filter(Boolean);
  const show = (name) => git(["show", `${ref}:${name}`], env, dir);
  const operators = {};
  for (const name of names) {
    const m = /^operators\/([^/]+)\/v(\d+)\.json$/.exec(name);
    if (!m)
      continue;
    const v = { ...JSON.parse(await show(name)), version: Number(m[2]) };
    (operators[m[1]] ??= []).push(v);
  }
  for (const vs of Object.values(operators))
    vs.sort((a, b) => Number(a.version) - Number(b.version));
  return {
    url: rec.url,
    operators,
    plugins: names.filter((n) => /^plugins\/[^_/][^/]*\.py$/.test(n)),
    ...names.includes("profile/fcg.toml") ? { profile: await show("profile/fcg.toml") } : {}
  };
}
async function withArchOperators(args, repo, home, say) {
  const team = await teamData(repo, home);
  if (!team)
    return;
  const operators = Object.fromEntries(Object.entries(team.operators).filter(([fam]) => fam.startsWith("arch/")).map(([fam, vs]) => [fam, vs.map(({ trials: _trials, ...v }) => v)]));
  args.library = { operators, ...team.profile !== undefined ? { profile: team.profile } : {} };
  if (team.plugins.length)
    say(`the team library's plugin modules stay on this machine (${team.plugins.join(", ")}): ` + "the hosted engine runs no team code, so this solve goes without them");
}
async function withTeam(args, repo, home, say) {
  const team = await teamData(repo, home);
  if (!team)
    return;
  const family = typeof args.operator === "string" ? args.operator.split("@")[0] : undefined;
  const operators = family && team.operators[family] ? { [family]: team.operators[family].map(({ trials: _trials, ...v }) => v) } : {};
  args.library = { operators, ...team.profile !== undefined ? { profile: team.profile } : {} };
  if (team.plugins.length)
    say(`the team library's plugin modules stay on this machine (${team.plugins.join(", ")}): ` + "the hosted engine runs no team code, so this edit goes without them");
}
var init_library = __esm(() => {
  init_proc();
});

// src/models.ts
import { existsSync as existsSync8, mkdirSync as mkdirSync7, mkdtempSync as mkdtempSync3, readFileSync as readFileSync8, writeFileSync as writeFileSync6 } from "node:fs";
import { tmpdir as tmpdir3 } from "node:os";
import { join as join9 } from "node:path";
function emptyDir() {
  return mkdtempSync3(join9(tmpdir3(), "fractal-model-"));
}
async function run(argv, stdin, cwd) {
  const r = await exec(argv, { stdin, cwd, timeoutMs: TIMEOUT_MS });
  if (r.timedOut)
    throw new Error(`${argv[0]} took over ${TIMEOUT_MS / 60000} minutes`);
  return r;
}
function claude(model, o) {
  const exe = o.exe ?? "claude";
  const flags = ["--tools=", "--strict-mcp-config", "--setting-sources=", "--disable-slash-commands", "--no-session-persistence", "--output-format", "json"];
  return {
    name: `claude${model ? ":" + model : ""}`,
    async complete(r) {
      const t0 = Date.now();
      const m = r.model ?? model;
      const res = await run([exe, "-p", ...m ? ["--model", m] : [], "--system-prompt", r.system, ...flags], r.user, emptyDir());
      let data;
      try {
        data = JSON.parse(res.stdout);
      } catch {
        throw new Error(`claude -p failed (${res.code}): ${(res.stderr || res.stdout).slice(-500)}`);
      }
      if (data.is_error)
        throw new Error(`claude -p: ${String(data.result).slice(0, 500)}`);
      const u = data.usage ?? {};
      const cached = u.cache_read_input_tokens ?? 0;
      return {
        text: String(data.result ?? ""),
        model: r.model ? `claude:${r.model}` : this.name,
        latency_s: (Date.now() - t0) / 1000,
        usage: { prompt_tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + cached, completion_tokens: u.output_tokens ?? 0, cached_tokens: cached }
      };
    }
  };
}
function codex(model, o) {
  const exe = o.exe ?? "codex";
  return {
    name: `codex${model ? ":" + model : ""}`,
    async complete(r) {
      const t0 = Date.now();
      const cwd = emptyDir();
      const res = await run([exe, "exec", "--json", "--skip-git-repo-check", "--ephemeral", "--ignore-rules", "-s", "read-only", "-C", cwd, ...model ? ["-m", model] : [], "-"], onePrompt(r), cwd);
      let text;
      let usage = { prompt_tokens: 0, completion_tokens: 0, cached_tokens: 0 };
      let failed;
      for (const line of res.stdout.split(`
`)) {
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === "item.completed" && ev.item?.type === "agent_message")
          text = ev.item.text ?? "";
        if (ev.type === "turn.completed" && ev.usage)
          usage = { prompt_tokens: ev.usage.input_tokens ?? 0, completion_tokens: ev.usage.output_tokens ?? 0, cached_tokens: ev.usage.cached_input_tokens ?? 0 };
        if (ev.type === "error" || ev.type === "turn.failed")
          failed = ev.message ?? ev.error?.message ?? "failed";
      }
      if (text === undefined)
        throw new Error(`codex exec: ${failed ?? `no answer (${res.code}) ${res.stderr.slice(-500)}`}`);
      return { text, usage, model: this.name, latency_s: (Date.now() - t0) / 1000 };
    }
  };
}
function cursor(model, o) {
  const exe = o.exe ?? "cursor-agent";
  return {
    name: `cursor${model ? ":" + model : ""}`,
    async complete(r) {
      const t0 = Date.now();
      const cwd = emptyDir();
      const prompt = onePrompt(r);
      const res = await run([exe, "-p", "--output-format", "json", "--mode", "ask", "--trust", "--workspace", cwd, ...model ? ["--model", model] : [], prompt], "", cwd);
      let data;
      try {
        data = JSON.parse(res.stdout);
      } catch {
        throw new Error(`cursor-agent failed (${res.code}): ${(res.stderr || res.stdout).slice(-500)}`);
      }
      if (data.is_error)
        throw new Error(`cursor-agent: ${String(data.result).slice(0, 500)}`);
      const text = String(data.result ?? "");
      const u = data.usage;
      const base = { text, model: this.name, latency_s: (Date.now() - t0) / 1000 };
      if (u && typeof u.inputTokens === "number")
        return { ...base, usage: { prompt_tokens: u.inputTokens, completion_tokens: u.outputTokens ?? 0, cached_tokens: u.cacheReadTokens ?? 0 } };
      return { ...base, usage: { prompt_tokens: approxTokens(prompt), completion_tokens: approxTokens(text), cached_tokens: 0 }, approx: true };
    }
  };
}
function grok(model, o) {
  const env = o.env ?? process.env;
  const m = model ?? "grok-4";
  return {
    name: `grok:${m}`,
    async complete(r) {
      const key = env.XAI_API_KEY;
      if (!key)
        throw new Error("Grok needs your xAI key in XAI_API_KEY (it is sent only to api.x.ai)");
      const base = (env.XAI_BASE_URL ?? "https://api.x.ai/v1").replace(/\/$/, "");
      const body = { model: m, messages: [{ role: "system", content: r.system }, { role: "user", content: r.user }] };
      if (r.max_tokens)
        body.max_tokens = r.max_tokens;
      if (r.json_schema)
        body.response_format = { type: "json_schema", json_schema: { name: "fcg_output", schema: r.json_schema, strict: true } };
      const t0 = Date.now();
      const res = await fetch(`${base}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok)
        throw new Error(`xAI answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const data = await res.json();
      const u = data.usage ?? {};
      return {
        text: data.choices?.[0]?.message?.content ?? "",
        model: this.name,
        latency_s: (Date.now() - t0) / 1000,
        usage: { prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0, cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 }
      };
    }
  };
}
function replay(dir) {
  const attempts = new Map;
  return {
    name: `replay:${dir}`,
    async complete(r) {
      const n = attempts.get(`${r.op}:${r.key}`) ?? 0;
      attempts.set(`${r.op}:${r.key}`, n + 1);
      const p = join9(dir, `${r.op}_${r.key}.${n}.txt`);
      if (!existsSync8(p))
        throw new Error(`no recorded answer for ${r.op}:${r.key} attempt ${n} in ${dir}`);
      const text = readFileSync8(p, "utf8");
      return { text, model: this.name, latency_s: 0, usage: { prompt_tokens: approxTokens(r.system + r.user), completion_tokens: approxTokens(text), cached_tokens: 0 }, approx: true };
    }
  };
}
function modelHand(spec, o) {
  const i = spec.indexOf(":");
  const kind = i < 0 ? spec : spec.slice(0, i);
  const arg = i < 0 ? undefined : spec.slice(i + 1) || undefined;
  if (kind === "claude")
    return claude(arg, o);
  if (kind === "codex")
    return codex(arg, o);
  if (kind === "cursor")
    return cursor(arg, o);
  if (kind === "grok")
    return grok(arg, o);
  if (kind === "replay" && arg)
    return replay(arg);
  throw new Error(`unknown model hand ${JSON.stringify(spec)}: one of claude, codex, cursor, grok (each optionally :MODEL), or replay:DIR`);
}
function recording(inner, dir) {
  mkdirSync7(dir, { recursive: true });
  const attempts = new Map;
  return {
    name: inner.name,
    async complete(r) {
      const n = attempts.get(`${r.op}:${r.key}`) ?? 0;
      attempts.set(`${r.op}:${r.key}`, n + 1);
      const a = await inner.complete(r);
      writeFileSync6(join9(dir, `${r.op}_${r.key}.${n}.txt`), a.text);
      writeFileSync6(join9(dir, `${r.op}_${r.key}.${n}.meta.json`), JSON.stringify({ model: a.model, duration_s: a.latency_s, ...a.usage }));
      return a;
    }
  };
}
var TIMEOUT_MS = 900000, approxTokens = (s) => Math.max(1, Math.round(s.length / 3.6)), onePrompt = (r) => `<instructions>
${r.system}
</instructions>

${r.user}`;
var init_models = __esm(() => {
  init_proc();
});

// src/run.ts
import { spawn as spawn2 } from "node:child_process";
import { existsSync as existsSync9, openSync, readFileSync as readFileSync9 } from "node:fs";
import { join as join10, resolve as resolve3 } from "node:path";
function apiFor(home) {
  const c = loadConfig(home);
  if (!c.token)
    throw new Error(NOT_CONNECTED);
  return new Api(c.url, c.token);
}
function handsFor(o) {
  let model = modelHand(o.hands || process.env.FRACTAL_HANDS || "claude", {});
  if (o.record)
    model = recording(model, resolve3(o.record));
  const testCmd = o.testCmd === undefined ? undefined : words(o.testCmd);
  const sandbox = o.sandbox === "srt" || o.sandbox === undefined && which("srt") ? "srt" : undefined;
  const off = (v) => /^(off|0|false|no)$/i.test(v ?? "");
  const installTools = !o.noInstallTools && !off(process.env.FRACTAL_INSTALL_TOOLS) && !off(process.env.FCG_INSTALL_TOOLS);
  return { model, testCmd, sandbox, installTools };
}
function detectLang(repo) {
  return existsSync9(join10(repo, "tsconfig.json")) ? "ts" : "py";
}
async function startJob(home, kind, args, repo, h, o) {
  const api = apiFor(home);
  const hands = handsFor(h);
  const s = await submit(api, kind, typeof args.test_cmd === "string" ? { ...args, test_cmd: words(args.test_cmd) } : args, repo, home);
  o.onLine(`job ${s.job}: ${s.files} files uploaded by sha (${(s.bytes / 1e6).toFixed(1)} MB) · model calls on ${hands.model.name}`);
  const board = await api.view(s.job).catch(() => {
    return;
  });
  if (board)
    o.onLine(`board: ${board} (any screen, for 2 h)`);
  if (s.skipped.length)
    o.onLine(`not sent: ${s.skipped.slice(0, 5).map((x) => `${x.path} (${x.why})`).join(", ")}${s.skipped.length > 5 ? ` and ${s.skipped.length - 5} more` : ""}`);
  if (!o.detach)
    return { job: s.job, result: await drive(api, s.job, home, hands, { onLine: o.onLine }) };
  const flags = [...h.hands ? ["--hands", h.hands] : [], ...h.sandbox ? ["--sandbox", h.sandbox] : [], ...h.record ? ["--record", resolve3(h.record)] : [], ...h.testCmd ? ["--test-cmd", h.testCmd] : [], ...h.noInstallTools ? ["--no-install-tools"] : []];
  const log = openSync(join10(s.dir, "drive.log"), "a");
  const [exe, script] = self();
  spawn2(exe, [script, "_drive", s.job, ...flags], { detached: true, stdio: ["ignore", log, log], env: process.env }).unref();
  return { job: s.job };
}
function statusText(home, job) {
  const st = jobState(home, job);
  const out = [`job ${job}: ${st.status}`, ...st.last.map((l) => `  ${l}`)];
  for (const q of st.questions)
    out.push(`question ${q.id}: ${q.text} [${q.options.join(" | ")}]`);
  if (st.error)
    out.push(`error: ${st.error}`);
  if (st.brief)
    out.push(st.brief);
  const patch = join10(jobDir(home, job), "edit.patch");
  if (existsSync9(patch))
    out.push(`patch: ${patch}${existsSync9(join10(jobDir(home, job), "applied.json")) ? " (applied)" : ` · apply with: fractal apply ${job}`}`);
  const log = join10(jobDir(home, job), "drive.log");
  if (st.status !== "ready" && existsSync9(log)) {
    const tail = readFileSync9(log, "utf8").trim().split(`
`).filter((l) => /error|refused|lost/i.test(l)).slice(-2);
    out.push(...tail);
  }
  return out.join(`
`);
}
async function waitFor(home, job, seconds) {
  const until = Date.now() + seconds * 1000;
  const before = JSON.stringify(jobState(home, job).questions);
  while (Date.now() < until) {
    const st = jobState(home, job);
    if (st.brief !== undefined || st.error !== undefined || JSON.stringify(st.questions) !== before)
      return;
    await new Promise((r) => setTimeout(r, 250));
  }
}
var words = (s) => s.match(/'[^']*'|"[^"]*"|\S+/g)?.map((w) => w.replace(/^(['"])(.*)\1$/, "$2")) ?? [], self = () => [process.execPath, process.argv[1]];
var init_run = __esm(() => {
  init_config();
  init_job();
  init_models();
  init_protocol();
  init_runner();
});

// src/mcp.ts
var exports_mcp = {};
__export(exports_mcp, {
  serveMcp: () => serveMcp,
  callTool: () => callTool,
  VERSION: () => VERSION,
  TOOLS: () => TOOLS2
});
import { createInterface } from "node:readline";
import { resolve as resolve4 } from "node:path";
import { readdirSync as readdirSync3, statSync } from "node:fs";
import { join as join11 } from "node:path";
function recent(home) {
  let ids = [];
  try {
    ids = readdirSync3(join11(home, "jobs"));
  } catch {
  }
  const rows = ids.map((id) => ({ id, at: statSync(join11(home, "jobs", id)).mtimeMs })).sort((a, b) => b.at - a.at).slice(0, 10);
  return rows.length ? rows.map((r) => `${r.id}: ${jobState(home, r.id).status}`).join(`
`) : "no Fractal jobs on this machine yet";
}
async function callTool(home, name, a) {
  const lines = [];
  const repo = resolve4(str2(a.repo) ?? process.cwd());
  const lang = str2(a.lang) ?? detectLang(repo);
  const sandbox = a.sandbox === "srt" || a.sandbox === "none" ? a.sandbox : undefined;
  const hands = { sandbox, testCmd: str2(a.test_cmd) };
  const start = async (kind, args) => {
    const { job } = await startJob(home, kind, args, repo, hands, { detach: true, onLine: (l) => lines.push(l) });
    await waitFor(home, job, num(a.wait_s, 30));
    return `Fractal job ${job} started
${lines.join(`
`)}
${statusText(home, job)}`;
  };
  if (name === "fractal_edit") {
    const task = str2(a.task);
    const operator = str2(a.operator);
    if (!task && !operator)
      throw new Error("task (or operator) is required");
    if (task && operator)
      throw new Error("give task or operator, not both");
    const args = task ? { task, lang } : { lang };
    if (operator)
      args.operator = operator;
    await withTeam(args, repo, home, (l) => lines.push(l));
    for (const k of ["run_tests", "propagate", "check_values", "write_tests"])
      if (a[k] === true)
        args[k] = true;
    for (const k of ["test_cmd", "ask"])
      if (str2(a[k]))
        args[k] = a[k];
    if (sandbox === "srt")
      args.sandbox = sandbox;
    return start("edit", args);
  }
  if (name === "fractal_scan") {
    const args = { lang };
    if (str2(a.symbol))
      args.symbol = a.symbol;
    if (typeof a.depth === "number")
      args.depth = a.depth;
    return start("scan", args);
  }
  if (name === "fractal_status") {
    const job = str2(a.job);
    if (!job)
      return recent(home);
    await waitFor(home, job, num(a.wait_s, 0));
    return statusText(home, job);
  }
  if (name === "fractal_answer") {
    const [job, q, option] = [str2(a.job), str2(a.question), str2(a.option)];
    if (!job || !q || !option)
      throw new Error("job, question and option are required");
    await answerQuestion(apiFor(home), home, job, q, option);
    return `answered ${q}: ${option}`;
  }
  if (name === "fractal_apply") {
    const job = str2(a.job);
    if (!job)
      throw new Error("job is required");
    const r = applyJob(home, job, { undo: a.undo === true });
    if (r.status === "refused")
      throw new Error(`refused: ${r.reason}${r.stale ? ` (${r.stale.join(", ")})` : ""}`);
    return `${r.status}: ${(r.files ?? []).join(", ")}`;
  }
  throw new Error(`no tool ${name}`);
}
function serveMcp(home) {
  const send = (m) => process.stdout.write(JSON.stringify(m) + `
`);
  createInterface({ input: process.stdin }).on("line", async (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    const reply = (result) => m.id !== undefined && send({ jsonrpc: "2.0", id: m.id, result });
    if (m.method === "initialize") {
      const v = str2(m.params?.protocolVersion) ?? "2025-06-18";
      return reply({ protocolVersion: v, capabilities: { tools: {} }, serverInfo: { name: "fractal", version: VERSION } });
    }
    if (m.method === "ping")
      return reply({});
    if (m.method === "tools/list")
      return reply({ tools: TOOLS2 });
    if (m.method === "tools/call") {
      const p = m.params ?? {};
      try {
        return reply({ content: [{ type: "text", text: await callTool(home, String(p.name), p.arguments ?? {}) }] });
      } catch (e) {
        return reply({ content: [{ type: "text", text: e.message }], isError: true });
      }
    }
    if (m.id === undefined)
      return;
    send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `no method ${m.method}` } });
  });
}
var VERSION = "0.2.0", str2 = (x) => typeof x === "string" && x ? x : undefined, num = (x, d) => typeof x === "number" && x >= 0 ? Math.min(x, 50) : d, repoProp, TOOLS2;
var init_mcp = __esm(() => {
  init_job();
  init_library();
  init_run();
  repoProp = { repo: { type: "string", description: "the repo root (default: the folder the host runs in)" }, lang: { type: "string", enum: ["ts", "py"] }, wait_s: { type: "number", description: "seconds to wait for the job before answering (≤ 50)" } };
  TOOLS2 = [
    {
      name: "fractal_edit",
      description: "Change an existing TypeScript or Python repo in place with Fractal: only the declarations the change needs are rewritten, and the repo's own type check (and tests, with run_tests) judge it in a local copy. Nothing is written to the repo until fractal_apply.",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "the change in one or two plain sentences" },
          ...repoProp,
          operator: { type: "string", description: "instead of a task: a learned operator of the team library (.fcg/library), ID or ID@N" },
          run_tests: { type: "boolean", description: "run the repo's own tests (they execute its code, in a copy): ask the person first" },
          test_cmd: { type: "string" },
          propagate: { type: "boolean" },
          check_values: { type: "boolean" },
          write_tests: { type: "boolean" },
          ask: { type: "string", enum: ["wait"], description: "ask the person before deciding on their behalf" },
          sandbox: { type: "string", enum: ["srt", "none"], description: "srt (the default when installed) runs the checks with the network off and writes only in the copy; none runs them without it" }
        }
      }
    },
    {
      name: "fractal_scan",
      description: "Map a TypeScript or Python repo read-only with Fractal: declarations, who calls what, which tests reach which code; with symbol, everything a change to that declaration can reach.",
      inputSchema: { type: "object", properties: { ...repoProp, symbol: { type: "string", description: "file::Name or Name" }, depth: { type: "number" } } }
    },
    {
      name: "fractal_status",
      description: "Where a Fractal job stands: its latest events, any question waiting for the person, the brief and the patch. With no job, the recent jobs.",
      inputSchema: { type: "object", properties: { job: { type: "string" }, wait_s: { type: "number" } } }
    },
    {
      name: "fractal_answer",
      description: "Answer a Fractal job's question with the option the person chose, in their words. Never choose for them.",
      inputSchema: { type: "object", required: ["job", "question", "option"], properties: { job: { type: "string" }, question: { type: "string" }, option: { type: "string" } } }
    },
    {
      name: "fractal_apply",
      description: "Write a ready job's patch into the repo, only when the person has approved it in their own words; refused if a file changed since the job read it. undo puts back what it replaced.",
      inputSchema: { type: "object", required: ["job"], properties: { job: { type: "string" }, undo: { type: "boolean" } } }
    }
  ];
});

// src/cli.ts
init_config();
import { spawn as spawn3 } from "node:child_process";
import { appendFileSync, existsSync as existsSync10, readFileSync as readFileSync10 } from "node:fs";
import { join as join12, resolve as resolve5 } from "node:path";

// src/connect.ts
init_protocol();
async function connect(api, o) {
  const c = await api.connect(o.label);
  const say = o.onLine ?? (() => {
  });
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  say(`Open ${c.url}, check it shows ${c.code}, then sign in with GitHub or email.`);
  o.open?.(c.url);
  const until = Date.now() + c.expiresIn * 1000;
  let blips = 0;
  while (Date.now() < until) {
    await sleep(c.interval * 1000);
    let got;
    try {
      got = await api.connectToken(c.device);
    } catch (e) {
      if (e instanceof ApiError && e.status === 410)
        break;
      if (!retryable(e))
        throw e;
      await sleep(retryDelay(e, blips++));
      continue;
    }
    if (got)
      return got;
  }
  throw new Error("the sign-in code expired: run `fractal connect` again");
}

// src/hosts.ts
import { existsSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname, join as join2 } from "node:path";
var HOSTS = ["claude", "codex", "cursor", "grok"];
var RULES = `Fractal changes this repo in place, or maps it read-only, through the \`fractal\` MCP tools.
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
- Never answer Fractal's model prompts yourself and never edit the files a job changes.`;
var MARK = "<!-- fractal -->";
var END = "<!-- /fractal -->";
function put(path, text) {
  mkdirSync2(dirname(path), { recursive: true });
  writeFileSync2(path, text);
}
function section(path, body) {
  const old = existsSync(path) ? readFileSync2(path, "utf8") : "";
  const block = `${MARK}
${body}
${END}
`;
  const i = old.indexOf(MARK);
  const j = old.indexOf(END);
  put(path, i >= 0 && j > i ? old.slice(0, i) + block + old.slice(j + END.length + 1) : old + (old && !old.endsWith(`

`) ? `
` : "") + block);
}
function mcpJson(path, hands) {
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync2(path, "utf8"));
  } catch {
  }
  cfg.mcpServers = { ...cfg.mcpServers, fractal: { command: "fractal", args: ["mcp"], env: { FRACTAL_HANDS: hands } } };
  put(path, JSON.stringify(cfg, null, 2) + `
`);
}
function setup(host, dir) {
  if (host === "codex") {
    section(join2(dir, "AGENTS.md"), `## Fractal

${RULES}`);
    const toml = join2(dir, ".codex", "config.toml");
    const old = existsSync(toml) ? readFileSync2(toml, "utf8") : "";
    if (!old.includes("[mcp_servers.fractal]"))
      put(toml, old + (old && !old.endsWith(`
`) ? `
` : "") + `[mcp_servers.fractal]
command = "fractal"
args = ["mcp"]
env = { FRACTAL_HANDS = "codex" }
tool_timeout_sec = 120
` + `# the job tools write nothing to the repo; writing the patch is asked each time
default_tools_approval_mode = "approve"

` + `[mcp_servers.fractal.tools.fractal_apply]
approval_mode = "prompt"
`);
    return ["AGENTS.md (a Fractal section)", ".codex/config.toml (the fractal MCP server; Codex reads it in a trusted project, or run: codex mcp add fractal --env FRACTAL_HANDS=codex -- fractal mcp)"];
  }
  if (host === "cursor") {
    mcpJson(join2(dir, ".cursor", "mcp.json"), "cursor");
    put(join2(dir, ".cursor", "rules", "fractal.mdc"), `---
description: Change or map this repo with Fractal (the fractal MCP tools)
alwaysApply: false
---

${RULES}
`);
    return [".cursor/mcp.json (the fractal MCP server)", ".cursor/rules/fractal.mdc"];
  }
  if (host === "grok") {
    mcpJson(join2(dir, ".grok", "settings.json"), "grok");
    section(join2(dir, "GROK.md"), `## Fractal

${RULES}`);
    return [".grok/settings.json (the fractal MCP server, model calls on Grok)", "GROK.md", "set XAI_API_KEY in your environment: model calls go from this machine to api.x.ai with your key; or run `fractal edit --hands grok` from any terminal"];
  }
  return ["nothing to write: install the plugin with `claude plugin marketplace add <path to public/hosts/claude-code>` then `claude plugin install fractal`"];
}

// src/arch.ts
init_job();
import { existsSync as existsSync6, readFileSync as readFileSync6, writeFileSync as writeFileSync5 } from "node:fs";
import { dirname as dirname4, join as join7, resolve as resolve2 } from "node:path";
var isObj2 = (x) => typeof x === "object" && x !== null && !Array.isArray(x);
var list = (x) => Array.isArray(x) ? x : [];
var str = (x) => typeof x === "string" ? x : x === undefined || x === null ? "" : String(x);
var cut = (s, n) => s.length > n ? `${s.slice(0, n - 1)}…` : s;
function vcsOf(repo) {
  if (existsSync6(join7(repo, ".git")))
    return "repo";
  for (let d = dirname4(resolve2(repo));; d = dirname4(d)) {
    if (existsSync6(join7(d, ".git")))
      return "above";
    if (dirname4(d) === d)
      return "none";
  }
}
function planOf(home, given) {
  if (!given)
    throw new Error("--plan PLAN: a plan.json from fractal arch --choose, or that arch job's id");
  const dir = jobDir(home, given);
  let plan;
  try {
    if (existsSync6(given))
      plan = JSON.parse(readFileSync6(given, "utf8"));
    else if (existsSync6(join7(dir, "plan.json")))
      plan = JSON.parse(readFileSync6(join7(dir, "plan.json"), "utf8"));
    else
      plan = JSON.parse(readFileSync6(join7(dir, "result.json"), "utf8")).report;
    if (isObj2(plan) && isObj2(plan.plan))
      plan = plan.plan;
  } catch {
    throw new Error(`--plan ${given}: no plan there; make one with fractal arch --choose FINDING=PROPOSAL`);
  }
  if (!isObj2(plan) || !Array.isArray(plan.steps))
    throw new Error(`--plan ${given}: that file is not a change plan`);
  return plan;
}
function keepPlan(home, job, report) {
  if (!isObj2(report.plan))
    return;
  const file = join7(jobDir(home, job), "plan.json");
  writeFileSync5(file, JSON.stringify(report.plan, null, 1));
  return file;
}
function policyLines(r) {
  const counts = isObj2(r.counts) ? r.counts : {};
  const out = [`policies: ${Object.entries(counts).map(([k, n]) => `${str(n)} ${k}`).join(", ")}`];
  for (const f of list(r.findings).filter(isObj2)) {
    if (f.status === "compliant")
      continue;
    const why = list(f.why).map(str).join("; ");
    const needs2 = list(f.needs).map(str);
    out.push(`${str(f.status)} ${str(f.policy)}: ${cut(why, 200)}${needs2.length ? ` (would be settled by: ${needs2.join(", ")} evidence)` : ""}`);
    const fix = isObj2(f.remedy) ? f.remedy : undefined;
    if (fix && f.status === "violated") {
      out.push(fix.kind === "edit" && fix.safe === true ? `  remedy, as an edit: fractal policy --fix ${str(f.policy)}` : `  remedy, by hand: ${cut(str(fix.task), 200)}`);
    }
  }
  return out;
}
function archLines(r, plan) {
  const a = isObj2(r.arch) ? r.arch : {};
  const findings = list(a.findings).filter(isObj2);
  const pol = isObj2(a.policies) ? a.policies : {};
  const out = [`${findings.length} finding${findings.length === 1 ? "" : "s"} · policies ${Object.entries(pol).map(([k, n]) => `${str(n)} ${k}`).join(", ")}`];
  for (const f of findings) {
    out.push(`${str(f.id)} (${str(f.status)}): ${cut(str(f.risk), 160)}`);
    for (const p of list(f.proposals).filter(isObj2)) {
      const v = isObj2(p.verdict) ? str(p.verdict.status) : "";
      out.push(`  ${str(p.rank)}. ${str(p.id)}${p.pattern ? ` [${str(p.pattern)}]` : ""} (${v}): ${cut(str(p.change), 120)}`);
    }
    if (f.not_proposed)
      out.push(`  not proposed: ${cut(str(f.not_proposed), 160)}`);
  }
  const unjudged = list(a.not_judged).length;
  if (unjudged)
    out.push(`${unjudged} not settled (evidence or a judgment missing): see the job's result.json`);
  if (isObj2(r.plan)) {
    const steps = list(r.plan.steps).length;
    out.push(`plan ${str(r.plan.id)}: ${steps} step${steps === 1 ? "" : "s"} · ${plan} · run it (a dry run, with its change proof): fractal edit --plan ${plan}`);
  } else if (findings.length)
    out.push("pick one: fractal arch --choose FINDING=PROPOSAL (the proposals are ranked simplest first)");
  return out;
}
function fixLines(r) {
  const before = isObj2(r.before) ? str(r.before.status) : "not applicable";
  const out = [`${str(r.policy)}: ${before}`];
  if (isObj2(r.edit)) {
    const e = r.edit;
    out.push(`edit: ${str(e.status)} (${str(e.evidence)})${e.reason ? `: ${str(e.reason)}` : ""}`);
    if (e.proof)
      out.push(`change proof: ${str(e.proof)}`);
  }
  if (isObj2(r.after))
    out.push(`after the edit, in the copy: ${str(r.after.status)}: ${list(r.after.why).map(str).join("; ")}`);
  if (r.reason)
    out.push(str(r.reason));
  return out;
}
function taskOf(given) {
  const text = given && existsSync6(given) ? readFileSync6(given, "utf8") : given ?? "";
  if (!text.trim())
    throw new Error("fractal solve --task FILE|TEXT: the request, as a text file or in words");
  return text;
}
function reportLines(kind, report, plan) {
  if (kind === "policy")
    return policyLines(report);
  if (kind === "arch")
    return archLines(report, plan);
  if (kind === "fix")
    return fixLines(report);
  return [];
}

// src/cli.ts
init_job();
init_library();
init_mcp();
init_protocol();
init_run();
var USAGE = `fractal ${VERSION}: change or map a TypeScript or Python repo with Fractal's hosted engine,
your own Claude Code (claude -p, on your subscription) and your own machine.

  fractal connect [--url URL]                     sign in (GitHub or email, in the browser)
  fractal edit "<change>" [--repo .] [--lang ts|py] [--run-tests] [--test-cmd CMD] [--propagate]
               [--check-values] [--write-tests] [--speculate] [--route KIND=MODEL]... [--ask wait] [--detach]
  fractal edit --operator ID[@N] [...]            apply a learned operator from the team library (.fcg/library)
  fractal edit --offer MODULE --regions SCAN [...]  act on a refactor offer, as a dry run with its change proof
  fractal scan [--repo .] [--lang ts|py] [--lift] [--domains] [--hypotheses] [--offers] [--recall] [--detach]
  fractal edit --plan PLAN [--run-tests] [...]    run a change plan from fractal arch --choose (its plan.json or job id)
  fractal policy [--pack P] [--policy ID]... [--runtime FILE] [--detect]
                                                  check the repo against the architecture policies, read-only
  fractal policy --fix ID [--run-tests] [--test-cmd CMD]   one violated policy's remedy, as an edit (dry run)
  fractal arch [--pack P] [--choose FINDING=PROPOSAL]... [--shape strangler_fig|branch_by_abstraction] [--allow-split]
                                                  architecture findings, each with its options simplest first
                                                  (one deployable; a service split only with --allow-split);
                                                  --choose makes the change plan
  fractal solve --task FILE|TEXT [--learned] [--dry-run] [--no-tests] [--test-cmd CMD]
                                                  a request routed: a finding's change plan, a plain edit, or no
                                                  change, with the route and why (--learned: the team library's
                                                  architecture operators; --dry-run: the route only)
  fractal impact NAME [--depth N]                 what a change to one declaration reaches (or scan --symbol NAME)
  fractal domains                                 the repo's modules organised into domains
  fractal offers --regions SCAN                   refactor offers, from a scan made with --lift
               SCAN: that scan's job id, or its report as a JSON file
  fractal status [JOB]                            where a job stands (no JOB: the recent ones)
  fractal answer JOB QUESTION "<option>"          answer a job's question
  fractal apply JOB [--undo]                      write a ready job's patch (or put back what it replaced)
  fractal delete JOB                              purge the job's files on the server now
  fractal mcp                                     the MCP server (the Claude Code plugin uses its skills instead)

  hands: --hands claude[:MODEL] | replay:DIR  (or $FRACTAL_HANDS; default claude)
         --sandbox srt|none   srt (the default when srt is installed) runs the repo's checks with the network off
                              and writes only in the local copy; none runs them without it
         --no-install-tools   a checker or test runner the repo uses, at its version, that this machine lacks is
                              not installed into ~/.fractal/tools (or FRACTAL_INSTALL_TOOLS=off): its check does not run
         --record DIR    keep every model answer, to replay later`;
var BOOL = new Set(["run-tests", "propagate", "check-values", "write-tests", "speculate", "lift", "domains", "hypotheses", "offers", "recall", "detach", "undo", "no-open", "no-install-tools", "help", "detect", "allow-split", "learned", "dry-run", "no-tests"]);
var MANY = new Set(["route", "choose", "policy"]);
function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0;i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const [k, v] = a.slice(2).split(/=(.*)/s, 2);
    const val = v ?? (BOOL.has(k) ? true : argv[++i] ?? "");
    flags[k] = MANY.has(k) && typeof flags[k] === "string" && typeof val === "string" ? `${flags[k]}
${val}` : val;
  }
  return { pos, flags };
}
var out = (s) => process.stdout.write(s + `
`);
function regionsOf(home, scan) {
  if (!scan)
    throw new Error("--regions SCAN: the job id of a scan made with --lift, or its report as a JSON file");
  const file = existsSync10(scan) ? scan : join12(jobDir(home, scan), "result.json");
  let report;
  try {
    const got = JSON.parse(readFileSync10(file, "utf8"));
    report = file === scan ? got : got.report;
  } catch {
    throw new Error(`--regions ${scan}: no scan job or report there`);
  }
  if (!report || typeof report.patterns !== "object" || report.patterns === null)
    throw new Error(`--regions ${scan}: that scan has no pattern regions; make one with fractal scan --lift`);
  return Object.fromEntries(["patterns", "domains", "matches"].filter((k) => (k in report)).map((k) => [k, report[k]]));
}
function routesOf(given) {
  const routes = {};
  for (const r of given.split(`
`)) {
    const i = r.indexOf("=");
    if (i < 1 || i === r.length - 1)
      throw new Error(`--route takes KIND=MODEL; got ${JSON.stringify(r)}`);
    routes[r.slice(0, i)] = r.slice(i + 1);
  }
  return routes;
}
function archArgs(kind, args, f, flags, repo) {
  const lines = (k) => f(k) ? f(k).split(`
`) : [];
  if (f("pack"))
    args.pack = f("pack");
  args.vcs = vcsOf(repo);
  if (kind === "arch") {
    if (flags["allow-split"] === true)
      args.allow_split = true;
    for (const c of lines("choose"))
      if (!/^[^=]+=[^=]+$/.test(c))
        throw new Error(`--choose takes FINDING=PROPOSAL; got ${JSON.stringify(c)}`);
    if (f("choose"))
      args.choose = lines("choose");
    if (f("shape"))
      args.shape = f("shape");
    return;
  }
  if (f("runtime")) {
    try {
      args.runtime = JSON.parse(readFileSync10(f("runtime"), "utf8"));
    } catch {
      throw new Error(`--runtime ${f("runtime")}: not a JSON file of runtime observations (name -> value)`);
    }
  }
  if (flags.detect === true)
    args.detect = true;
  if (kind === "fix") {
    if (!f("fix"))
      throw new Error("fractal policy --fix POLICY_ID: the policy whose remedy runs (fractal policy lists the violated ones)");
    args.policy = f("fix");
    if (flags["run-tests"] === true)
      args.run_tests = true;
    if (f("test-cmd"))
      args.test_cmd = f("test-cmd");
  } else if (f("policy"))
    args.policy = lines("policy");
}
function open(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    spawn3(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
  }
}
async function main(argv) {
  const { pos, flags } = parse(argv);
  const cmd = pos.shift();
  const home = fractalHome();
  const f = (k) => typeof flags[k] === "string" ? flags[k] : undefined;
  const sandbox = f("sandbox");
  if (sandbox !== undefined && sandbox !== "srt" && sandbox !== "none")
    throw new Error("--sandbox takes srt or none");
  const hands = { hands: f("hands"), sandbox, record: f("record"), testCmd: f("test-cmd"), noInstallTools: flags["no-install-tools"] === true };
  const repo = resolve5(f("repo") ?? ".");
  const lang = f("lang") ?? detectLang(repo);
  if (!cmd || flags.help) {
    out(USAGE);
    return cmd ? 0 : 2;
  }
  if (cmd === "connect") {
    const url = f("url") ?? loadConfig(home).url ?? DEFAULT_URL;
    const got = await connect(new Api(url, undefined), { label: f("label") ?? "fractal CLI", open: flags["no-open"] ? undefined : open, onLine: out });
    saveConfig(home, { url, token: got.token });
    out(`connected${typeof got.account.email === "string" ? ` as ${got.account.email}` : ""}`);
    return 0;
  }
  if (cmd === "edit" || cmd === "scan" || cmd === "impact" || cmd === "domains" || cmd === "offers" || cmd === "policy" || cmd === "arch" || cmd === "solve") {
    const args = { lang };
    const on = (...ks) => {
      for (const k of ks)
        if (flags[k] === true)
          args[k.replace(/-/g, "_")] = true;
    };
    const kind = cmd === "scan" && f("symbol") ? "impact" : cmd === "policy" && flags.fix !== undefined ? "fix" : cmd;
    if (cmd === "edit") {
      const task = pos.join(" ").trim();
      const operator = f("operator");
      if (flags.plan !== undefined) {
        if (task || operator || f("offer"))
          throw new Error("fractal edit --plan is the edit: it takes no change in words, --offer or --operator");
        args.plan = planOf(home, f("plan"));
      } else if (f("offer"))
        Object.assign(args, { offer: f("offer"), pattern_regions: regionsOf(home, f("regions")) });
      else if (!task && !operator)
        throw new Error('fractal edit "<the change, in words>" (or --offer MODULE --regions SCAN, --operator ID[@N], or --plan PLAN)');
      if (task && operator)
        throw new Error("fractal edit takes the change in words or --operator ID[@N], not both");
      if (task)
        args.task = task;
      if (operator)
        args.operator = operator;
      await withTeam(args, repo, home, out);
      on("run-tests", "propagate", "check-values", "write-tests", "speculate");
      if (f("test-cmd"))
        args.test_cmd = f("test-cmd");
      if (f("ask"))
        args.ask = f("ask");
      if (f("route"))
        args.routes = routesOf(f("route"));
    } else if (kind === "impact") {
      const symbol = f("symbol") ?? pos.join(" ").trim();
      if (!symbol)
        throw new Error("fractal impact NAME (an id, file::Name, or a name)");
      args.symbol = symbol;
      if (f("depth"))
        args.depth = Number(f("depth"));
    } else if (cmd === "offers")
      args.pattern_regions = regionsOf(home, f("regions"));
    else if (cmd === "scan")
      on("lift", "domains", "hypotheses", "offers", "recall");
    else if (cmd === "policy" || cmd === "arch")
      archArgs(kind, args, f, flags, repo);
    else if (cmd === "solve") {
      if (pos.length)
        throw new Error("fractal solve takes the request as --task FILE|TEXT");
      args.task = taskOf(f("task"));
      if (flags.learned === true) {
        args.learned = true;
        await withArchOperators(args, repo, home, out);
      }
      if (flags["dry-run"] === true)
        args.dry_run = true;
      if (flags["no-tests"] === true)
        args.run_tests = false;
      if (f("test-cmd"))
        args.test_cmd = f("test-cmd");
    }
    if (hands.sandbox === "srt")
      args.sandbox = hands.sandbox;
    const r = await startJob(home, kind, args, repo, hands, { detach: flags.detach === true, onLine: out });
    if (flags.detach) {
      out(`follow it with: fractal status ${r.job}`);
      return 0;
    }
    if (r.result && ["policy", "arch", "fix"].includes(kind))
      for (const l of reportLines(kind, r.result.report, kind === "arch" ? keepPlan(home, r.job, r.result.report) : undefined))
        out(l);
    return r.result && ["ready", "done"].includes(r.result.status) ? 0 : 1;
  }
  if (cmd === "_drive") {
    const job = pos[0];
    try {
      await drive(apiFor(home), job, home, handsFor(hands), { onLine: out });
    } catch (e) {
      const st = jobState(home, job);
      st.error = e.message;
      appendFileSync(join12(jobDir(home, job), "drive.log"), `error: ${st.error}
`);
      const { writeFileSync: writeFileSync7 } = await import("node:fs");
      writeFileSync7(join12(jobDir(home, job), "state.json"), JSON.stringify(st, null, 1));
      return 1;
    }
    return 0;
  }
  if (cmd === "status") {
    if (pos[0]) {
      out(statusText(home, pos[0]));
      return 0;
    }
    const { callTool: callTool2 } = await Promise.resolve().then(() => (init_mcp(), exports_mcp));
    out(await callTool2(home, "fractal_status", {}));
    return 0;
  }
  if (cmd === "answer") {
    const [job, q, ...rest] = pos;
    if (!job || !q || !rest.length)
      throw new Error('fractal answer JOB QUESTION "<option>"');
    await answerQuestion(apiFor(home), home, job, q, rest.join(" "));
    out(`answered ${q}: ${rest.join(" ")}`);
    return 0;
  }
  if (cmd === "apply") {
    const job = pos[0];
    if (!job)
      throw new Error("fractal apply JOB [--undo]");
    const r = applyJob(home, job, { undo: flags.undo === true });
    if (r.status === "refused")
      throw new Error(`refused: ${r.reason}${r.stale ? ` (${r.stale.join(", ")})` : ""}`);
    out(`${r.status}: ${(r.files ?? []).join(", ")}${r.status === "applied" ? ` · undo with: fractal apply ${job} --undo` : ""}`);
    return 0;
  }
  if (cmd === "delete") {
    if (!pos[0])
      throw new Error("fractal delete JOB");
    await apiFor(home).purge(pos[0]);
    out(`job ${pos[0]}: deleted on the server`);
    return 0;
  }
  if (cmd === "mcp") {
    serveMcp(home);
    return -1;
  }
  if (cmd === "setup") {
    const host = pos[0];
    if (!HOSTS.includes(host))
      throw new Error(`fractal setup ${HOSTS.join("|")}`);
    for (const l of setup(host, resolve5(f("dir") ?? ".")))
      out(l);
    return 0;
  }
  out(USAGE);
  return 2;
}
main(process.argv.slice(2)).then((code) => {
  if (code >= 0)
    process.exitCode = code;
}, (e) => {
  process.stderr.write(`fractal: ${e.message}
`);
  process.exitCode = 1;
});
