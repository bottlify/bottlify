# Bottlify

Bottlify is a set of packages for running Win32 x86 and x86-64 programs in the browser: **cork**, our x86 → wasm translator
(`modules/cork`), in a Web Worker, under a from-scratch Win32/DirectX layer (`modules/core`) on
WebGPU, WebAudio and OPFS. Where this file and the tree disagree, the tree is right and this file
is the bug.

## Working rule: the next one picks it up

All of this code is written for ourselves. The next one to work on it - an agent first of all,
this one in a later session, or a person - has to recover the context fast from the tree itself
and add nothing worse than what is there. So: a change leaves its area clearer than it found it;
a patch that works around a symptom in one place is a hack, and the cause is fixed where every
caller goes through it; what is no longer used goes (git keeps it); a mechanism that has grown
by patches is redone once its shape is known. Decide as the owner of the project would: an idea
already taken, the owner's included, is followed or argued against with a reason, never kept
only because it is there.

## Working rule: finish the step

A step ends in one of two ways: **solved** (implemented, tested, verified on what it was for) or
**a dead end** (every approach refuted by measurement, no next one known). The last message of the
step says which, with the evidence. A progress report is a line in the middle of the work, not the
end of a turn. Never end on "shall I start?" or a menu of options for a goal already set. Stop only
for a decision that is genuinely the user's (a direction not chosen, an irreversible or
outward-facing action) or for a wait a rule imposes, and say what waits on what.

## Priorities

There is no single technical priority; these hold for every change:

1. **Clean, beautiful code.** One shared mechanism over three similar ones, a contract written
   once and enforced by a test. No per-title hacks: never branch on a program's name, executable
   or hash, never hardcode an offset for one title. A title that misbehaves is a signal about a
   generic contract we got wrong (an FPU context switch, a `GetProcAddress` epoch, a DLU→px
   conversion, an mmap write-back gap); fix it there, once, for every title on that path.
   A temporary exception is allowed as a bridge while the generic answer does not exist yet: it
   is an entry in `roadmap/decisions.md` marked temporary, naming the generic work it stands in
   for and the condition that removes it, and it goes in the change that lands that work (a
   managed program ran under Mono until a bottle could install .NET itself; then Mono went).
2. **Strict testing, nothing hollow.** A test that cannot fail, a gate that does not run, a check
   that passes on nothing is worse than none: it says something is covered that is not.
3. **We understand our own code and our runtime.** Every mechanism and every tool can be
   explained from the tree by the next one who reads it; what nobody can explain is redone or
   removed.
4. **A product we are not ashamed of**, good enough to be sold: it runs what it says it runs, says
   plainly what it does not, and is fast enough that a program plays as it did.

**The task now: less memory, more speed - for every program, none excepted.** No title is
hacked into running; a program that needs something is a contract we answer for all.

A protected title (an anti-tamper or copy protection) may be watched while it runs - a trace, a
hook, a counter, on only for a run under observation and changing nothing the program observes -
because what it checks (`CPUID`, timing, code hashes, self-modifying code) is the hardest work
for the translator. Where it trips over our inaccuracy, the inaccuracy is fixed for everyone, so
it runs as on Windows. The protection itself is never patched, bypassed or answered falsely.

## Where things are

- `docs/` — the documentation, one short page per question; `docs/README.md` lists every page
  and is the site's navigation (`tools/docs/check.mjs` fails on a page it does not list or a link
  that leads nowhere). `docs/architecture/` is how the whole thing works (threads, startup, cork,
  Win32, graphics, sound, networking, storage); `docs/core/` is `@bottlify/core`'s public
  contract (API, configuration, limits), written for someone outside the project;
  `docs/cork/` is the translator. A module's own `README.md` is its npm page and stays short.
- `roadmap/README.md` — the index of the plans, `decisions.md` (behaviour chosen rather than
  derived from a specification) and `negative-results.md` (what was measured and did not pay).
- `roadmap/00-*` — local working notes, not in git (`.gitignore` excludes exactly these):
  per-area notes and **pitfalls** (read the area's pitfalls before touching the kernel,
  bridge, graphics or audio layers), plans and reports. Open work is tracked on the owner's task
  board, outside the repository; a gap noticed on the way (a path no test covers, a benchmark that
  misses x64, a gate that runs nowhere) goes into its open questions when it is found. Everything else in `roadmap/` ships with the repo and is written
  for a reader who is not you.

## Code

- **Vanilla ES modules + JSDoc**, checked by `tsc --checkJs --noEmit`; a `.d.ts` only where JSDoc
  cannot say it. WASM only where it is already required (cork's output, the prebuilt FFmpeg
  decoder) or where a profile proves a hot path needs it.
- **A hot call stays in the guest.** Every crossing into the host costs microseconds; a function
  or COM method a program calls thousands of times a frame runs as guest code. Write it once in
  JS marked `@guestCode` (`modules/core/scripts/guest-code/`, its README: the subset of JS that
  32-bit integer and x87 code reproduce exactly, guest memory through `{ u32, setU32, ... }`,
  `return host()` handing a rare case to the same function's host handler). `npm run build`
  writes the i386 beside it (`*.x86.js`), a test fails when the two differ, and the JS stays
  the handler and the reference. A COM method takes it through its `guest`
  slot (`bridge/internal/vtable.js`). Measure crossings first (`trap`, `drive` in the phase
  profile), and gate the guest path against the host one.
- **Zero runtime dependencies** in `@bottlify/core`; nothing in the product fetches its own code.
- **Modules are standalone libraries.** Each `src/layers/<name>/module.js` declares `name`,
  `requires`, `create(config, host)`, `diagnostics()`, `dispose()`; a module reaches another only
  through `host.requireApi(name)` for a name in its own `requires` — no direct imports, no shared
  singletons. A disabled module something needs is installed as a stub, so pulling a module out
  degrades the system without breaking it. `npm run check:boundaries` enforces the graph:

  ```
  log → nothing          cpu, filesystem, media → log          memory → cpu, log
  kernel, loader → cpu, memory, log                 bridge → cpu, kernel, memory, log
  win32 → bridge, kernel, memory, loader, filesystem, media, log
  graphics, audio, input → win32, bridge, memory
  ```
- **Derived from the specification, not a reference implementation**: contract (ABI, signatures,
  struct layout, return codes, edge cases) → test → implementation. Wine is a source of knowledge
  (its conformance tests say what real Windows answers), never of code.
- **Someone else's work** — a component, an algorithm, a snippet — gets a `THIRD-PARTY-NOTICES.md`
  entry in the commit that brings it in.
- **Nothing fails quietly.** A call accepted and not all of it done is a `divergence` (a
  warning, said once); something the program made that did not happen at all - a draw, a frame,
  an object the GPU refused, data not written - is a loss: `divergence(api, detail, 'loss')`, an
  error in the journal, counted and kept in `report()`, and the program goes on. A counter alone
  is not saying it. A departure from the specification made on purpose is an entry in
  `roadmap/decisions.md`; anything else is a bug to fix.
- **A contract change updates its docs in the same commit.** A contract is what someone outside
  sees: a public API or option, a module's `requires`, a Win32 function's behaviour, a limit, a
  decision. A docs page covers the code it links to and what its `<!-- covers: ... -->` line
  names; `node tools/docs/check.mjs --staged` (run by a hook before `git commit`) lists the pages
  whose code is staged and they are not. Each one it names is updated, or is left because the
  change is not a contract change. What can be read off the code is not written by hand: the
  module graph and each layer's summary come from its `module.js` when `npm run docs` builds the
  site, so a layer's opening comment (`<name> — what it is`) is its documentation.
- **Comments say why**, not what; no changelog comments, no tombstones, no claims about titles we
  did not measure, no earlier projects or local paths in anything committed.
- **A dash is a single hyphen** (` - `) in comments, commit messages and docs; never a double
  hyphen (` -- `) or an em dash (`—`). Text written before keeps its own.
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

**Debugging live with the user** (only then) runs in this order: build both dists, the user tries
the build; if the defect is gone, run the tests and push after they pass; if it is not, revert the
change or fix further and build again. Not push first, and not tests before the user has seen the
build.

**Run what the change touches; the full suite before main.**

| Changed | Run |
| --- | --- |
| cork | `npm test -w @bottlify/cork` and `npm run test:integration -w @bottlify/cork` — the x86 corpus a real processor answered, kept in the repository (`modules/cork/src/x86-corpus.json.gz`, made by `tools/generators/x86-corpus.mjs`) |
| a core layer (gdi32, d3d9, dsound, …) | that layer's unit tests by interface and its gates: `node --test "src/layers/<layer>/**/*.test.js" "src/layers/<layer>/**/*.itest.js"` in `modules/core` |
| anything, before it goes to main | `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:integration`, `npm run check:boundaries`, `npm run build` |

CI (`.github/workflows/ci.yml`) runs the full set, the tools' tests and the `npm run cdp:*` gates
in a real headless Chrome; every job must be green. It runs on a push to main and by hand (`gh
workflow run ci.yml`) - not on another branch, a pull request or a schedule: the repository's
minutes are metered. So the full set above runs locally before anything goes to main; CI is that same set on a
clean machine.

## Performance

Performance is part of correctness: a slow implementation does not reproduce how the program ran.
Bugs and costs are found by measurement — the harness, ring buffers, phase profiler and guest CPU
attribution are first-class.

- **Look in the tools before debugging or searching.** `tools/README.md` is every tool by the
  question it answers, each with a real output and how to read it, written from `tools/catalog.json`;
  read it first and use what is there; `tools/live/DIAGNOSING.md` is the order to look in when a run
  is slow, flickers or stops. A tool goes into the folder of its category with a catalog entry (and,
  for an instrument, a sample from real data) in the same change, not into a scratch folder:
  `tools/checks/check-catalog.mjs` fails one that has none.
- **One restart carries the whole hunt.** Before asking a person to restart a game, put every
  switch, counter and dump the hunt could need into that one build, and check on the running
  game that each one answers (a live switch returns data, a counter moves). A restart per readout
  is the person's time spent on our missing instrument.

- **An optimisation works on a test before it touches the engine**: a node test that reproduces a
  real scenario (a block profile, the bytes from the bundle), then the solution, then the engine,
  then the game run to confirm. A browser A/B of a guess is not a diagnosis — a frame varies by a
  quarter between runs.
- **Judge on more than one scenario** (play, menu, load).
- **The first lever is the translator** — caching, larger blocks and regions — because it speeds
  up every title at once. Small generic gains count.
- **A translator change is judged on a 32-bit and a 64-bit workload alike**: cork's emitter and
  runtime serve both widths.
- **A measurement carries its conditions**: the workload and the bundle's hash, both arms, every
  raw value and how many runs, the median and the spread, the noise floor, the browser, GPU, driver
  and power plan. A field not recorded is written `not recorded`, never reconstructed. A number is
  a share of something: say of what.
- **What did not pay is kept.** An idea measured without a positive signal goes into
  [`roadmap/negative-results.md`](roadmap/negative-results.md) as one dated line: the idea, one
  number with its conditions, its status, and when it is worth trying again; the full write-up is
  the commit. A no under those conditions is not a no for ever: an entry whose code or conditions
  changed is marked stale, and one inside its own noise disputed, until measured again. A
  measurement found wrong is marked invalidated, with the reason, and is not cited again.
- **A plan says it is one**: its first lines give the status (plan, no code) and the date, and a
  number in it that was not measured is marked so.

## Bringing up a program

Audit before the first run: `node tools/bundles/import-audit.mjs <exe|dir|.btl|.iso> --dynamic --specs
<dir>` (`--fetch-specs <dir>` downloads the export lists once), and implement every missing entry
point it lists in one pass. A setup unpacks as it runs: run it once under
`tools/run/install-watch.mjs --copy` and audit what it left. Packed images and `GetProcAddress` lookups
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
