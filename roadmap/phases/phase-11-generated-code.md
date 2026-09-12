# Phase 11 — The generated code, and the frame it has to fit in

Everything before this phase made the title run. This one makes it play. Half of a battle frame is
the emulator's generated code, a tenth is the emulator's own runtime around it, and a quarter is the
host answering fifteen hundred calls a frame; the frame is 60–120 ms where a game wants 16. This
plan is the ordered list of what changes that, with the measurement each step is held to.

Nothing here knows a game. Every patch is to our fork of the emulator or to the layers, and every
one is measured on a real title before it is kept.

## Where the time goes (measured, September 2026)

Browser profiler on a title in a match, shares of everything the page did:

| part | share | what it is |
|---|---|---|
| generated code (the program's own instructions) | 48% | vertex assembly, state-cache wrappers, fog, animation, pathing |
| host (JavaScript) | 18.5% | draw path ~8%, seam `sync` ~3%, scheduler ~4%, the rest small |
| emulator runtime | 11% | module dispatch 4.3%, code-page marking 2.3%, entry lookup 1.4% |
| x87 wrappers | 8.5% | a call per FPU operation; the arithmetic itself is 0.1% |
| browser internals, garbage collector | 10% | GC 4% from per-draw allocation |

The emulator retires about 184 M instructions a second on this machine; a battle frame is 9–26 M
instructions. Of the program's own time, a fifth is middleware it shipped: Storm's allocator 8%,
the sound mixer 6%, a reverb filter 1.4%, the C runtime 4%.

## The mix (measured with the profiler build, step 0)

Two windows of ten seconds on the profiler build, whose counting slows it to 69–76 M instructions
a second; the shares are what matter.

| | main menu | saved battle |
|---|---|---|
| compiled / interpreted | 99.6% / 0.4% | 99.5% / 0.5% |
| entries into generated code | 1.9 M/s, one per 37 instructions | 2.4 M/s, one per 31 |
| exits to a different page | 85% | 90% |
| exits by instruction: `call` / `ret n` / `ret` / `call [r]` | 28.5 / 22 / 16 / 5.7% | 33.7 / 23.7 / 16.1 / 5.5% |
| other exits: `rep movsd`, `fwait`, `jmp` | 3.9 / 5.0 / 3.4% | 3.1 / 2.6 / 1.5% |
| x87 share of instructions | 17.4% | 12.1% |
| SSE share (packed: `shufps`, `movaps`, `mulps`, `addps`) | 15.7% | 3.2% |
| MMX share | 0.5% | 0.6% |
| memory-operand forms | 42% | 40% |
| slow-path reads / writes | ~0 | ~0 |
| loop-head checks | 1.1 M/s | 7.0 M/s |

The top executed instructions in a battle: `mov r,[m]` 15%, `mov [m],r` 4%, `add/sub/cmp imm8` 8%,
`fld m32` 3.4%, `lea` 3.2%, `je/jne` 5%, `fstp m32` 2.6%, `movzx` 1.8%, `test` 1.8%, `call` 1.8%.

What the mix decides: three quarters of all exits are `call` and `ret` crossing a page, so step 1
is first by a wide margin; the memory slow paths are empty, so the flat-memory step 6 addresses
the fast path's own cost and nothing else; x87 and packed SSE together are a fifth to a third of
every instruction, each a call today, which orders steps 3 and 4 next; `fwait` and `rep movsd`
leaving generated code is a small fixed cost worth a small fix.

## What every patch carries

Four things, in the commit and in the register entry, or the patch is not done:

1. **The cause** — the measured cost it removes, as a share of a scene's frame, from the profile
   that found it. Not "this should be faster": which counter, which share.
2. **The effect** — what the numbers were expected to become, and what they became, on the three
   scenes below. A patch that moves nothing here is reported as moving nothing; a result seen
   elsewhere on another title is a prior, never a verdict — what did not pay there may pay here,
   and each step is measured on this machine regardless.
3. **The measurement** — the before and after, taken with the same tools on the same scenes, in
   the register with the commit.
4. **The tests** — as many as the change admits: a unit test of the mechanism where one is
   possible, an integration test that runs a guest program through the real emulator build
   (`v86-host.itest.js`) pinning what the program relies on, and a differential oracle where the
   patch changes how instructions execute — the same program run with the patch on and off through
   the knob, the guest state compared word for word. A knob per patch (`set_jit_config`) is what
   makes the oracle and the A/B possible, and stays.

## The measurement every step is held to

Three scenes, all driven by the CDP tools in `dbg/cdp_test/` and the launcher:

1. **The main menu, settled** — `stable.mjs`: frame ms, guest ms, host ms, instructions per
   frame, instructions per guest-second. Baseline: 19.0 ms = 13.6 guest + 5.6 host, 2.2 M
   instructions, 163–184 M/s.
2. **The saved battle scene** — the user's save `123` loaded through the game's own menu, first
   thirty seconds: fps on the canvas, frame split. Baseline: 16–19 fps, 51–67 ms = 49 guest + 18
   host, 9 M instructions.
3. **The browser profiler over fifteen seconds of play** — shares by group (generated code, host,
   runtime, x87, GC), and the emulator's own counters (`jitprobe.mjs`): entries per second,
   interpreted steps, code-page writes.

A step is kept when the scene it targets improves and the other two do not regress; the numbers go
into `roadmap/registers/decisions-and-optimisations.md` with the commit.

## Part I — the emulator

### 0. A profiler build, so the mix is measured rather than argued

The emulator's `with-profiler` build counts retired instructions by opcode, exits from generated
code by cause, and every slow path taken. Built by the fork's workflow as a second artifact and
loaded by a launcher knob, it says which of the steps below pays off first for a given title.
Deliverable: `v86-profiler.wasm` in the release, a launcher knob, a script that prints the mix.

### 1. Return prediction and direct chaining between modules

Generated code leaves its module every forty instructions or so, three to four million times a
second, and re-enters through the runtime. An exit whose target is compiled calls that module
without the runtime in between, by a tail call; a `ret` is the common case. Expected: the
runtime's 11% halved.

### 2. Dispatch metadata as flat arrays

The per-page code records are boxed and chased pointer by pointer on every dispatch. Flat arrays
instead. Small, mechanical, measured; ordered late because the dispatch left after step 1 is
under a percent of the page.

### 3. x87 inline

The arithmetic takes the double shortcut already (`52318d95`); what remains is a call per
operation with a ten-byte struct through memory. Emit `fadd/fsub/fmul/fdiv/fld/fst/fcom/fxch` and
the loads and stores inline, the eight registers as doubles, the tag word honoured. Expected: the
8.5% of wrappers.

### 4. MMX and SSE inline

Moves, packs, adds and logic on wasm's 64-bit and 128-bit lanes rather than through calls. The
vertex assembly every 3D title of the era runs is this. Measured after step 0 says how much of
the mix it is: a sixth of the menu's instructions, a hundredth of the battle's.

### 5. Flags that are never read are never computed

A liveness walk over the block, and the lazy-flag state in locals. Ordered after 1–4 because the
profiler build (step 0) says how many flag stores a frame carries; measured here whatever a
prior elsewhere found.

### 6. Flat memory when paging is off

A load as a range check and one wasm load; the has-code bitmap on writes alone. The broadest
change and the largest; last for that reason — a title whose frame is memory traffic gains here
what a title whose frame is not would not.

### Done

Step 0 (`50d621c7`, the profiler build), step 1 (`f1901d93`, chaining: entries into generated code
cut five- to tenfold, runtime share 11.3 to 7.5%), step 3 in its first form (`c99b50e8`: the x87
share 7.4 to 3.5%, menu frame 18.3 to 16.0 ms). Before the plan: the loop bound honoured for
multi-entry loops (`e267a598`), the double shortcut (`52318d95`), one-entry code-page marking
(`ddcb45d4`), the counters and knobs (`69b7651c`). Each is in the register with its numbers.

Part II, B8: the trap's per-call record, clock and region check (host code 22.8 to 19.9% of the
page in the saved battle, the collector 1.1 to 0.6%). In the register with its numbers.
Part II, B9's first piece: an unlocked buffer read through a window, the crossing timed one call in
eight (host 22.7 to 20.4% of the page in the saved battle).

Step 1, second form (`a42a6804`): one lookup per exit instead of two (the lookups 3.9 to 2.8% of
the page in the saved battle, the runtime 8.2 to 6.9%).

Step 5 (`71c38215`): flags nobody reads go unrecorded. Measured no difference on the menu or in
the saved battle; off by default, behind knob 8. In the register with its numbers.

From the exit mix (`59460919`): `fwait` compiled instead of ending its block (entries into
generated code 602k to 401k a second on the menu, 431k to 347k in the saved battle); string
instructions looping inside their block (`1211df9b`, `38d0d5d6`: entries 401k to 206k on the
menu, 347k to 254k in the battle).

Step 6, reads (`2602314c`): a range check in place of the TLB while paging is off (menu frame 16.0
to 14.0 ms, guest 10.6 to 9.2; battle guest speed 221 to 248 M/s). Left in the exit mix after
these: blocks ending near a page end (half of what remains), the interpreter fallback for the
x87 and SSE instructions the compiler does not emit (`fild`, `fnstsw m16`, `ldmxcsr`), and the
traps themselves. The fallback is done (`5b214566`: entries 230k to 188k a second on the menu), and
so is the page end (`2838382a`, `18c37ee5`: entries 173k to 70k on the menu, 245k to 83k in the battle;
interpreted instructions 9k to 2k and 33k to 4k a frame).

Still to try: a countdown in place of the loop-safety counter load at every loop head, a stack
fast path for push and pop, the x87 helpers that still canonicalise a tagged register, and the
cheap traps answered inside generated code.

## Part II — the host's share of the frame

Ordered as in the register (B8–B10): the per-call cost of a trap, the draw prepared once per state
change rather than once per draw, and a command ring in guest memory drained once a frame. Together
these take the draw path from a quarter of a battle frame to a tenth.

GetLastError, SetLastError and the TLS read are guest code now (menu entries into generated code
230k to 173k a second); QueryPerformanceCounter and timeGetTime are next of that kind.

Then the calls that need no host at all — `Interlocked*`, `QueryPerformanceCounter`,
`GetTickCount` — emitted as guest code reading the TEB and the counter, so they stop being traps.
Only what reads a block or a clock is obvious; a wider guest-side band for the C runtime is not
taken.

## Part III — the program's middleware

A fifth of the program's own time is libraries it shipped: the allocator and archive reader
(Storm), the sound mixer and its filters (Miles). Hosting a codec by its export contract has
worked twice (`Mp3dec.asi`, `ijl15.dll`); a mixer is the next candidate by the same rule, an
allocator is not (no clean contract). Decided after Part I has landed, from a fresh profile.

## Not in this plan

Anything that reads a program's name, a hash, or an address of one title. A new code generator for
the emulator: the steps above are patches to the one there is; if they land and a battle frame is
still not playable, that is the next plan, not this one.
