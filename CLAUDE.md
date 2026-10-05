# Bottlify

Bottlify runs Win32 x86 programs in the browser: **cork**, our x86 → wasm translator
(`modules/cork`), in a Web Worker, under a from-scratch Win32/DirectX layer (`modules/core`) on
WebGPU, WebAudio and OPFS. Where this file and the tree disagree, the tree is right and this file
is the bug.

## Working rule: finish the step

A step ends in one of two ways: **solved** (implemented, tested, verified on what it was for) or
**a dead end** (every approach refuted by measurement, no next one known). The last message of the
step says which, with the evidence. A progress report is a line in the middle of the work, not the
end of a turn. Never end on "shall I start?" or a menu of options for a goal already set. Stop only
for a decision that is genuinely the user's (a direction not chosen, an irreversible or
outward-facing action) or for a wait a rule imposes, and say what waits on what.

## Priorities

1. **x86-64 and the multi-worker process runner** (`roadmap/v2/`). Work on the workers — the
   engine, graphics, translation and audio threads and what crosses between them — pays off for the
   whole application, not one title.
2. **Correctness, speed, reuse.** Optimisation and standardisation are part of the job, not
   extras: one shared mechanism over three similar ones, a contract written once and enforced by a
   test.
3. **No per-title hacks.** Never branch on a program's name, executable or hash, never hardcode an
   offset for one title. A title that misbehaves is a signal about a generic contract we got wrong
   (an FPU context switch, a `GetProcAddress` epoch, a DLU→px conversion, an mmap write-back gap);
   fix it there, once, for every title on that path.

## Where things are

- `docs/architecture.md` (`.ru.md`) — how the whole thing works: threads, startup, cork, Win32,
  graphics, sound, networking, storage.
- `docs/core/` — `@bottlify/core`'s public contract: API, configuration, current limits. Kept
  current as work lands; written for someone outside the project.
- `modules/cork/README.md` — the translator and its runtime.
- `roadmap/README.md` — the index of the plans: `v2/` (the plan), `bottles/`, `steam/`, and
  `decisions.md` (behaviour chosen rather than derived from a specification).
- `roadmap/00-*` — local working notes, not in git (`.gitignore` excludes exactly these): the TODO
  index, per-area open work and **pitfalls** (read the area's pitfalls before touching the kernel,
  bridge, graphics or audio layers), plans and reports. Everything else in `roadmap/` ships with
  the repo and is written for a reader who is not you.

## Code

- **Vanilla ES modules + JSDoc**, checked by `tsc --checkJs --noEmit`; a `.d.ts` only where JSDoc
  cannot say it. WASM only where it is already required (cork's output, the prebuilt FFmpeg and
  zstd decoders) or where a profile proves a hot path needs it.
- **Zero runtime dependencies** in `@bottlify/core`; nothing in the product fetches its own code.
- **Modules are standalone libraries.** Each `src/layers/<name>/module.js` declares `name`,
  `requires`, `create(config, host)`, `diagnostics()`, `dispose()`; a module reaches another only
  through `host.requireApi(name)` for a name in its own `requires` — no direct imports, no shared
  singletons. A disabled module something needs is installed as a stub, so pulling a module out
  degrades the system without breaking it. `npm run check:boundaries` enforces the graph:

  ```
  log → nothing          cpu, filesystem, media → log          memory → cpu, log
  kernel, loader → cpu, memory, log                 bridge → cpu, kernel, memory, log
  win32 → bridge, kernel, memory, loader, filesystem, log
  graphics, audio, input → win32, bridge, memory
  ```
- **Derived from the specification, not a reference implementation**: contract (ABI, signatures,
  struct layout, return codes, edge cases) → test → implementation. Wine is a source of knowledge
  (its conformance tests say what real Windows answers), never of code.
- **Someone else's work** — a component, an algorithm, a snippet — gets a `THIRD-PARTY-NOTICES.md`
  entry in the commit that brings it in.
- **Comments say why**, not what; no changelog comments, no tombstones, no claims about titles we
  did not measure, no earlier projects or local paths in anything committed.
- Lint has zero tolerance: `--max-warnings 0`.

## Tests

Nothing is done until it is tested: unit, contract (Wine's expectations), graphical (reference
frames) and end to end. Tests use `node:test`, colocated as `*.test.js` (unit) and `*.itest.js`
(integration and gates); no test dependencies.

**Every second path has a gate.** An optimisation that puts a fast path beside a slow one — guest
routines beside host traps, a command ring beside direct calls, a recording replayed in a worker
beside a device that draws itself, a device mixer beside the guest clock — lands with a
differential test in the same change: seeded random programs down both paths, comparing everything
a program can observe (answers, out-structures, guest memory, what the GPU or the mixer is given).
A benchmark shows the frame rate rose; only the gate shows nothing else changed. A new command,
getter or path without cases in its gate fails the gate.

**An invariant that cost something has a validator.** A bug whose cause was a broken rule of the
code — an argument count, a struct offset, a guest pointer used unchecked, one name with two
owners — leaves a small script in `tools/` that fails when that rule is broken, run with the other
gates; `check:boundaries` is the first of them. **An instrument that cannot answer says so** — an
error, "not measured" — and never returns zero.

**Run what the change touches; the full suite before main.**

| Changed | Run |
| --- | --- |
| cork | `npm test -w @bottlify/cork` and `npm run test:integration -w @bottlify/cork` — the x86 corpus with expected results (`npm run fetch:corpus` once) |
| a core layer (gdi32, d3d9, dsound, …) | that layer's unit tests by interface and its gates: `node --test "src/layers/<layer>/**/*.test.js" "src/layers/<layer>/**/*.itest.js"` in `modules/core` |
| anything, before it goes to main | `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:integration`, `npm run check:boundaries`, `npm run build` |

CI (`.github/workflows/ci.yml`) runs the full set plus `npm run cdp:probe` in a real headless
Chrome; both jobs must be green.

## Performance

Performance is part of correctness: a slow implementation does not reproduce how the program ran.
Bugs and costs are found by measurement — the harness, ring buffers, phase profiler and guest CPU
attribution are first-class.

- **An optimisation works on a test before it touches the engine**: a node test that reproduces a
  real scenario (a block profile, the bytes from the bundle), then the solution, then the engine,
  then the game run to confirm. A browser A/B of a guess is not a diagnosis — a frame varies by a
  quarter between runs.
- **Judge on more than one scenario** (play, menu, load).
- **The first lever is the translator** — caching, larger blocks and regions — because it speeds
  up every title at once. Small generic gains count.
- **A measurement carries its conditions**: the workload and the bundle's hash, both arms, every
  raw value and how many runs, the median and the spread, the noise floor, the browser, GPU, driver
  and power plan. A field not recorded is written `not recorded`, never reconstructed. A number is
  a share of something: say of what.
- **What did not pay is kept.** An idea measured without a positive signal goes into
  [`roadmap/negative-results.md`](roadmap/negative-results.md) as a dated entry with its
  conditions, appended and never rewritten; a later measurement is a new entry. A measurement found
  wrong is listed there as invalidated, with the reason, and is not cited again.
- **A plan says it is one**: its first lines give the status (plan, no code) and the date, and a
  number in it that was not measured is marked so.

## Bringing up a program

Audit before the first run: `node tools/import-audit.mjs <exe|dir|.btl|.iso> --dynamic --specs
<dir>` (`--fetch-specs <dir>` downloads the export lists once), and implement every missing entry
point it lists in one pass. A setup unpacks as it runs: run it once under
`tools/install-watch.mjs --copy` and audit what it left. Packed images and `GetProcAddress` lookups
are found only by running.

## Delegating

Independent work runs in parallel: an investigation that returns a conclusion, work confined to a
folder nobody else touches, anything whose output is a report. Two streams editing the same files
do not.

- Give each agent an exclusive area by name; shared files (`package.json`, `eslint.config.mjs`) are
  wired by the parent afterwards.
- An investigation writes only to the scratchpad.
- Brief the constraints (style, lint cap, no commits, no repo-wide autofix) and require it to say
  plainly what it could not verify.
- Verify a second-hand claim against the code before acting on it.
- A fork inherits the conversation and the parent's model — the default, since the briefing is the
  expensive part; a named agent type starts cold and needs the full briefing.
