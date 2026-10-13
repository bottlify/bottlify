# cork — the hottest regions, Gothic 3 first

In Russian: [`README.ru.md`](README.ru.md).

**Status: a plan, no code. 2026-10-12.** Numbers marked *(estimate)* were not measured. The rest
come from the sources in section 1, under the conditions given there.

## 1. What was measured

Sources:

- **R** — the engine's report of a Gothic 3 run, 2026-10-12, 11:01 UTC. M4 Pro, a diagnostic build
  of the launcher. Bundle hash, browser and power plan: not recorded. The phase profile of the
  whole run; the phases' self time sums to 149.4 s.
- **T** — a Chrome trace the same day, the engine thread, 10.96 s.
- **S** — the top 40 regions of T by self time (1127 of 1263 ms covered), translated statically
  from the bundle's DLLs with `hash, callReturn, looseStacks, structure` and the `expansion` hook
  (`97d0f6b5`). In the game regions are formed from the block profile and with options S does not
  know (`wideFirst`, `x87Shapes`, the x87 stack's shape, `ramSize`), so S is an approximation; see
  step 0.
- **F** — a Chrome trace of the Far Cry demo, 2026-10-12, 20:35; conditions in 1.6.

**A correction to R and T.** Both were taken on a diagnostic build. On Far Cry the phase timers
took about a fifth of a frame: 42 FPS with diagnostics against 53+ without. So the shares of
`trap`/`turn`/`yield` in 1.1 (27%) may be much too high. They say where to look, not how much there
is to win. Decisions take their distribution from step 0b's counters on a plain build, not from
phases.

### 1.1 Where the game's thread goes (R, the whole run)

| Phase | Self share | Count | Each |
| --- | --- | --- | --- |
| guest (region wasm) | 47.0% | 3.86 M slices | 18.2 µs |
| trap (guest → host crossing, without the API body) | 13.8% | 14.47 M | 1.42 µs |
| idle-host + idle-host-wait + idle-deadline | 13.2% | — | — |
| turn (the scheduler, per slice) | 7.7% | 3.86 M | 2.97 µs |
| yield | 5.1% | 0.73 M | 10.5 µs |
| all APIs together | ~13% | — | — |

- Of 14.47 M crossings about 10 M are `WaitForSingleObject` (5.01 M) and `Sleep` (4.99 M). The body
  of each costs 0.12–0.13 µs; the rest is the crossing and the scheduler.
- 115.5 G guest instructions in 70.2 s of guest time: **1.65 G instructions/s** on average.
- `busyByThread`: the main thread is busy 94% of the time, all others together ~5%.
- On a diagnostic build the phase clock and the call journal cost time themselves. In T:
  - the clock — 14.7% of the thread;
  - the call journal (`onCall → journalCall`) — 8.2%.

  A plain build has neither, but the shares above were not measured on one.

### 1.2 Guest code by module (T)

| Module | Share of wasm time |
| --- | --- |
| Engine.dll | 40.7% |
| Game.dll | 16.6% |
| PhysXCore.dll | 15.3% |
| SharedBase.dll | 10.9% |
| CRT and the rest below 0x10000000 | 8.7% |
| fmodex.dll (UPX-packed, not read statically) | 7.3% |

PhysX and fmod together are 22.6% of guest code, and PhysX runs on the main thread. The numbers do
not justify a separate plan to "integrate" these libraries.

### 1.3 The profile by instructions (R, `samples.top`)

- One loop, `0x305FBF40` (Engine.dll, a linear search, 9 instructions an iteration), is **14.7%**
  of all guest instructions.
- The top 25 blocks are 56%.

### 1.4 What hot code becomes (S, weighted by trace time)

In all: **61 bytes of wasm an instruction**, ×17 the x86 bytes.

| Mechanism | Share of wasm bytes |
| --- | --- |
| call (rel / [m] / reg) | 48.6% |
| ret / ret imm | 11.4% |
| x87 | 13.5% *(too high: S without `wideFirst`/`x87Shapes`)* |
| memory accesses | 13.4% |
| push/pop | 6.3% |
| ALU | 4.8% |
| jumps, strings, SSE | 2.2% |

By form:

| Form | wasm bytes an instruction |
| --- | --- |
| `call rel` | 193 |
| `call [m]` | 360 |
| `call r32` | 315 |
| `ret` | 183 |
| `ret imm` | 198 |
| `mov r,[m]` | 22 |
| `mov [m],r` | 23 |
| `push r` | 24 |
| `lea` | 8 |
| `fmul [m]` | 85 |

The hottest region by time, `r3003693f` (315 ms, 7.5% of guest time), is 43 instructions, 7 of
them calls.

A `call rel` site (239 bytes) in WAT:

1. `push` of the return address.
2. The budget.
3. The shadow return stack: depth, the test `≥256 || budget≤0`, the store, `+1`.
4. `esp` and the 6 words of lazy flags written back.
5. `call $transfer`: a hash probe on a **constant** target, then `return_call_indirect`.
6. The status test `≠7`.
7. 12 words loaded again: the budget, the flags, eax..ebx, esp.

`ret` (131–183 bytes): `pop`, the comparison with the shadow stack, the registers and flags written
back, `return 7`.

### 1.5 Already tried and did not pay (the cork 1.7 round, [`negative-results.md`](../negative-results.md))

Node on x86-64, callgrind:

- All 8 registers as region parameters: ×0.83. V8 keeps parameters past the sixth on the stack.
- A direct call around `transfer`: ×0.985.
- Lazy flag writes after a call: ×1.02.
- A wasm call's return taken as an entry to a loop: ×0.997. A loop with a call as a wasm loop:
  slower.

1.7's diagnosis on call-heavy code: instruction-cache misses. 0.33 misses a guest instruction against
0.002 in a loop, about 1000 bytes of machine code per region entry.

`callTargets` (predicted virtual calls) gives ×4–5 on the benchmark and is slower in games. Why was
not found.

**What the plan takes from this.** cork's loops and arithmetic are already not far from native:
1.65 G instructions/s on average over a game. What costs is elsewhere:

- **a call** — about 20 ns against 1.4 native, ×14 on `vcall`;
- **the size of call-heavy code**: the instruction cache;
- **crossings to the host and the scheduler** — 27% of the thread.

The cure is fewer calls and fewer bytes per call, not one more optimisation of bodies.

### 1.6 Far Cry (F)

Conditions: Far Cry demo, map research, `gpu=sm2`, the scene of earlier measurements, Mac, Chrome,
a build without diagnostics and without minification (`BOTTLIFY_READABLE=1`). One trace, 12.3 s,
88 497 samples of the engine thread, ~53 FPS.

**How it was counted.** The interval between samples belongs to the sample that opens it (as
DevTools counts). Gaps over 5 ms are dropped. The other count (the interval before a sample) gave
one `account` sample a 713 ms gap and with it 6.7% instead of 1.0%, and `(program)` 6.8% instead of
1.5%. For Gothic (T) the difference is small: guest 39.2% against 38.3%; T's shares in 1.2 are by
the other count.

| Engine thread | Share |
| --- | --- |
| guest regions | 54.6% |
| host JS | 36.6% |
| the shared transfer function `wasm-function[19]` (hash probe, `return_call_indirect`) | 2.1% |
| `(program)` | 1.5% |
| js↔wasm | 1.1% |
| idle | 3.5% |
| `readTsc` (of these) | 1.3% |

- **The profile is flat:** 2171 regions; the top 10 are 11.5% of guest time, the top 50 27.7%, the
  top 100 39.1%, the top 500 74.1%.
- **Depth:** 43% of guest time runs 10 or more regions deep on the wasm stack. Nearly every guest
  call is a region boundary.
- **Exits to JS are cheap:** js↔wasm and the executor's loop together about 2%.
- **Translation is idle:** the translator worker is busy 80 ms in 11.8 s. A translation cache is
  no lever for a frame; it is one for loading.
- **What follows:** the boundary that costs is the call between regions inside wasm. The region
  size limits (128 blocks / 8 KB) are not what ends regions; calls are. "Larger regions" here means
  step 1 (callees formed in), not other limits. The visible part of a call's cost is the 2.1% of
  the thread in the transfer function. The write-back and reload of registers inside the regions
  themselves is not separable in a profile; step 0b measures it.
- **What the trace does not give:** region sizes, the share of boundaries by cause (call, `ret`,
  size limit, indirect jump), the region's module. That is 0a and 0b. Far Cry's hot regions'
  code was not found by hand: the loader moved its DLLs, and the hot pages of earlier reports did
  not match the installed DLLs.

## 2. Goals

Every goal is measured on a plain build. Shares come from 0b's counters, not from phases.

- **Gothic 3 on an M4 Pro, plain build, one scene:**
  - the `guest` share down by a third *(estimate)*;
  - `trap + turn + yield` from 27% to ≤10%.

  By Amdahl that is ≈×1.4 FPS *(estimate)*. ×2.5 needs the guest ×2.5 as well, which is possible
  only if step 0 shows calls taking more than half of guest time.
- **Code growth:** a hot region's wasm bytes at most ×2 today's. The top-40 average no higher than
  61 bytes an instruction, the goal 35 *(estimate)*. Measured with `tools/cork-expansion.mjs`.
- **cork-bench against a native i386 build of the same source:** `vcall` ≤ ×5 (×14 today), the rest
  no worse than today.
- **Far Cry, `sm2` profile, one scene, plain build:**
  - the baseline 53+ FPS (one measurement, conditions in its record);
  - the goal: steps 1–2 without regression, +10–20% *(estimate)*.
- **Nothing for one title:** every lever is checked on Far Cry, NFS and Doom 3 for regressions as
  well.

## 3. Steps

The order follows the size of the prize step 0 shows. Each step is a commit of its own with a test,
a gate and a measurement, as [`CLAUDE.md`](../../CLAUDE.md) asks. What is refuted goes to
[`negative-results.md`](../negative-results.md).

### Step 0 — the instruments without which decisions are blind

Everything in step 0 is measured on a plain build, with only the diagnostics that measurement
needs. For readable traces: `BOTTLIFY_READABLE=1 npm run build`, a build without minification
whose profile names the real functions.

**0a. A region's code as the game compiled it.**
- A diagnostic query `regionCode(address)` to the runtime: the wasm bytes, the options, the blocks,
  the entries and the region's **module** (image and offset).
- The report fills `guestByModule` (empty in Far Cry's report today): time and instructions by
  module, so the table in 1.2 can be built for any title, not only from DLLs read by hand.
- The report carries the top N regions' composition by form (the `expansion` hook stays off in a
  plain build).
- `cork-expansion --report` reads it instead of translating statically.
- Test: a region from the report, translated again with the same options, matches byte for byte.

*Done in part (`5ecd6a38`):* a run with `blockProfile` reports `forms` — its hottest regions (up
to 300, or 95% of the counted executions) formed again as their records were and emitted with the
run's options and without its counts, each instruction's wasm bytes weighted by how often its
block ran. Far Cry, the same conditions as 0b's first measurement: 283 regions held 95% of the
executions, **33.3 wasm bytes an executed instruction** (S's static 61 over-counted). The heaviest
forms by bytes run through: `fmul x87,[m]` 10.1% (56 B), `call [m]` 8.5% (360 B), `mov r32,[m]` 8.1%
(24 B), `fld x87,[m]` 5.7% (31 B), the API stub's `out` 4.8% (265 B), `fstp` 4.3%, `call rel` 4.2%
(167 B), `ret imm` 4.1% (142 B), `ret` 3.2% (171 B). The occlusion wait loop is in these numbers
(107 M turns: its `call [m]`, `out`, `fild`, three `fmul`, `fcomp`, `fnstsw` a turn); without it
calls and returns are ~13% of the bytes and x87 ~25%. An x87 operation in a region whose stack shape
is known is little more than its load and its arithmetic — bytes overstate its time; a call's bytes
are stores and loads of the state block, which they do not. The module of a region is still to come.

**0b. Counters of the mechanisms** (diagnostic builds only, behind a flag):
- region entries;
- calls out by kind (rel / [m] / reg);
- calls that went through the hash;
- `ret` past the shadow stack;
- region exits by cause.

These give "calls a second" and "the share of time in calls" — the size of steps 1–2's prize. Only
these counters can say it. A counter that cannot answer writes `not measured`, never zero.

*Done (`566b4fc1`):* a run with `blockProfile` counts, beside its blocks, how calls and returns went
(formed in, wasm call, way out), a call out by why its callee was not formed in, transfers through
the hash and `rdtsc`s; the report carries them as `mechanisms`. **First measurement**, Far Cry demo
(bundle `ec81f9c2…`), `tools/cdp_test/game.mjs` in this repository's container: headless Chromium
141.0.7390.37 on SwiftShader, 4 cores, power plan not recorded; one run of 420 s, counted from 340 s
to the end (~229 s in the level), 18.8 G guest instructions in the window:

| Count | In the window |
| --- | --- |
| calls formed in (direct and predicted) | 93.8 M |
| calls out as wasm calls (rel / indirect) | 78.6 M / 132.3 M |
| of which the occlusion wait loop below | 96.8 M |
| `ret` answering its wasm call / leaving | 206.7 M / 5.5 M |
| `rdtsc` | 96.8 M — all of them the wait loop's |

The hottest code of the run was not the game's work but a wait: XRenderD3D9.dll+0x15c50 reads
`rdtsc`, calls `IDirect3DQuery9::GetData(FLUSH)` and goes round while it answers `S_FALSE`, until a
deadline — 96.8 M turns, a host crossing each (126 k a second, 388 ms of host time a second). On a
software GPU the wait is long; it says nothing about cork's code, and it is taken out below.

Without the wait, a call out of a region came every ~160 guest instructions, and its callee stayed
apart because it was: an unpredicted indirect call 31%; a way out other than `ret` (an API call
among them) 22%; a call inside a callee already formed in 22%; a full region 11%; over the block
limit 8%; over the byte limit 6%.

**0c. Crossings by thread and API.**
- Who makes the 10 M `Wait`/`Sleep` calls: the thread and the timeout (0 or >0).
- How many of the main thread's slices go to `turn`/`yield` because of other threads.

**0d. A scenario in node.**
- Gothic's hot code as a test: the loop `0x305FBF40` and 5 call-heavy regions from 0a with recorded
  inputs.
- A cork-bench `calls` benchmark shaped as C++: a getter, a singleton with a static, a virtual
  call, AddRef/Release.
- A native i386 build of the same source beside it.
- The deterministic criterion is callgrind (Ir, I1 misses); time by alternation, ≥3 pairs.

Step 0 is done when the table in 1.4 is recounted from the game's code, 0b's counters give calls a
second and the share of time, and x87 and memory are recounted with the real options.

### Step 1 — fewer calls: forming more than leaves

*Corrected by reading the former:* a callee of ≤16 blocks / 512 bytes is already formed into its
caller, and one level of its own calls with it (`isLeaf` with `calls`); its callees' calls go out.
By 0b's Far Cry counts, forming could still take about half of the calls that go out today: nested
22%, full 11%, over the limits 14%.

- **1a.** A second level: the calls of a callee formed in are formed in as well when small, within
  a byte budget per region (nested, 22%). The limits and the region budget are re-measured against
  code growth (full and over the limits, 25%). Growth is bounded by a byte budget per region.
  *Tried:* `formDepth` 2 and 3 (a setting now, with its gate `src/runtime/forming.itest.js`) took
  the calls in and changed nothing measurable on cork-bench in Chromium (geomean 1.00x, noise 13%);
  left at 1, in `negative-results.md`, until a game on the person's machine says otherwise.
- **1b.** A singleton with a static (`test [guard]; jne; …; ret`) and thin wrappers (a `jmp`
  through an incremental-link thunk table, `r3003693f`) are a case of 1a. No code of their own,
  only a check that 1a takes them.
- **1c.** `callTargets`: find by 0b why games are slower with it (re-forming, code growth,
  mispredictions), fix it and turn it on by default if games speed up. `call [m]` is 19.6% of hot
  bytes, 360 bytes a call.

**Gate.** Differential: random programs with calls (leaves, non-leaves, recursion, an unbalanced
`ret`, a `ret` to another address, a store into the callee's code) run down the "formed" path and
the "called" path, and everything observable is compared: registers, flags, memory, x87.

### Step 2 — cheaper calls that remain

Only what 1.7 did not refute (1.5). Every register in wasm parameters was measured again on
call chains from the profiles (`modules/cork/bench/calls`, 2026-10-13) and is negative on x64
under a rule written before the runs; this step stays inside cork's state block.

- **2a. Register liveness at the continuation after a call.** A register the continuation writes
  before it reads is not loaded again after the return. For ecx/edx that is common by the ABI, but
  the rule is derived from the code, not the ABI. The same at a region's entry: what is dead on
  entry is not loaded.
- **2b. Dirty registers.** Before a call and at `ret` only the registers changed since the last
  write-back or load are written back. Untouched ebx/esi/edi are already in the state block. The
  rule is exact and does not depend on the ABI.
- **2c. The call site's tests.** The shadow stack's depth and the budget in one comparison.
- Goal: `call rel` ≤120 bytes, `ret` ≤80 *(estimate)*.
- Test: the call site in WAT. Gate: step 1's differential gate, and the corpus against hardware.

### Step 3 — memory

After 0a, looked at separately:

- the heads of store groups with `windowHit` (`cmp [m],r` 115 bytes, `mov [m],imm` 105);
- the read address mask (`& ramSize-1`) — whether it is there in the game.

Candidate: one test of the code pages' epoch at a region's entry instead of a test per group,
while the region's window holds no code. It is a second path beside today's, so it needs a gate
with stores into code.

### Step 4 — x87

After 0a, with the real `wideFirst`/`x87Shapes`. If tag tests on each operation and the precision
branch remain in PhysX's hot regions (`r291c8f10`: 75% of its bytes are x87), the stack's shape and
the precision are fixed at the region's entry and tested once. Gate: the x87 sequences against the
emulator, which exist.

### Step 5 — the hot loop `0x305FBF40` (14.7% of instructions)

- ns an iteration: cork against the native build (0d).
- If the gap is over ×2 — the iteration's WAT: local shuffles, masked loads, the budget on the back
  edge.

Goal: ≤×2 native an iteration.

### Step 6 — polls, crossings and the scheduler

The size of the prize by 0b/0c on a plain build: R's 27% is inflated by diagnostics.

*Corrected by 0b's Far Cry run:* a poll is usually a wait for something only the host, the graphics
worker or another thread can bring — a GPU's answer, another thread's progress. A poll answered
without crossing never lets that happen on a single executor: the answer comes later, not sooner.
Far Cry's occlusion loop is a timed spin; what it costs is how long the answer takes, not the price
of a turn. So for waits the lever is latency (answers sooner: counts beside answers, earlier
readback), and the mechanism below serves only answers that are already known and do not change
until the guest acts — a query already answered, a time read. Measure before building it.

**One mechanism for polls.** Some calls a program spins on until the answer is ready, and the host
knows the answer ahead. Guest code takes such an answer from a state word in shared memory, without
crossing to the host:
- the host writes the word when the answer changes;
- a stub in guest code reads it and crosses to the host only when the answer is not known;
- one mechanism, and the APIs are its clients.

First clients:
- `Sleep(0)`, `Wait(h,0)` — Gothic, ~10 M a run: nobody ready, the object not signalled;
- `IDirect3DQuery9::GetData` — Far Cry, 4.65 M a run, occlusion: the answer not there yet, or
  already in the word;
- the next ones by 0c's list, not by titles.

**Threads.** PhysX's and fmod's threads on executors of their own, so their polling does not take
the main thread's slices.

**Gates:**
- the fast-answer path against the path through the host: random sequences of polls with changing
  state (events, occlusion queries, thread readiness), comparing answers, out-structures and
  everything the guest sees;
- the existing one: synchronising programs, 1 executor against N.

### Step 7 — `rdtsc` without leaving for JS

Today `rdtsc` in a region is a call of the import `env.rdtsc`, the JS function `readTsc`:
`performance.now()`, the guest's clock, a `BigInt` on every call. On Far Cry that is 1.3% of the
thread plus the wasm→JS crossing.

**Answering inside wasm.** The value is computed from words in the state block the host writes at
the start of a slice:
- `base` — `readTsc()` at the slice's start, at least the last value given plus 1;
- `budget0` — the budget at the slice's start;
- `rate` — ticks an instruction over recent slices;
- `cap` — `base` plus `tscDriftMs` in ticks, the same ceiling as today;
- `last` — the last value given.

The region computes `min(base + (budget0 − p1) × rate, cap)`, takes the maximum with `last + 1` and
writes `last`. About 15 wasm instructions, no crossing.

**Properties:**
- the counter is monotonic;
- within a slice it moves by retired instructions; between slices it is tied to today's clock;
- the rate is the one `cpuid` 0x15/0x16 states, consistent with `QueryPerformanceCounter`;
- a loop waiting "N ticks" ends, because the budget is charged on the back edge.

The interpreter computes the same formula. The hybrid mode (the emulator) stays on the import.

**Fallback, if the formula fails its gate:** the import returns `f64` instead of `i64` (no
`BigInt`, exact up to 2^53 ticks), and the guest's clock is read once a slice.

**Gate.** Random programs reading `rdtsc` among loops and calls run down the "in wasm" path and the
"through the import" path with the same state words. The values match; monotonicity and the
ceiling hold. Plus a program that checks the rate of `rdtsc` against `QueryPerformanceCounter`
over 100 ms.

**Goal:** `readTsc` gone from the profile, about 1.5% of Far Cry's thread *(estimate: about 0.3 ms
of a frame, of the ~2 ms to 60 FPS)*.

*Corrected by 0b's Far Cry run:* every `rdtsc` of that run was the occlusion wait's (step 6): the
time `readTsc` takes there is time spent waiting anyway, so on Far Cry this step wins nothing until
the wait is shorter. It stays for programs that time their own work with `rdtsc`; 0b's count says
which those are.

## 4. Checking on games

- **Scenes:** one Gothic 3 scene (play, menu, load). Both arms alternate, ≥3 runs an arm. A plain
  build, not a diagnostic one.
- **What to record:** FPS, the phases `guest/trap/turn/yield/idle`, the bundle hash, the browser,
  the power plan.
- **Regressions:**
  - Far Cry — `sm2` profile, one scene, plain build, baseline 53+ FPS;
  - NFS and Doom 3 — under the same conditions.
- **Code growth:** `cork-expansion` on the report before and after, by form.
- **Refuted:** what showed no signal above the noise goes to
  [`negative-results.md`](../negative-results.md) with its conditions.
