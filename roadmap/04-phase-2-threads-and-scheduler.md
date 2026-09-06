# 04 — Phase 2: threads, scheduler, synchronization. Roadmap

> Working document for the phase. Source of truth is `00-bottlify-master-plan.md` (below: Master
> Plan). Phase 1 is closed — its plan is `03-phase-1-cpu-memory-loader.md`.

## 0. What Phase 2 is

Phase 2 = "execution core" from the Master Plan: threads, the scheduler, context switching, time
(real and virtual), the synchronization objects, and the handle table.

**Phase acceptance (Master Plan):** a multithreaded test program — producer/consumer, a race on a
critical section, a wait on several objects — produces a deterministic result a hundred runs in a
row. Plus the pitfalls in Master Plan §12 as executable assertions rather than comments.

This is the phase where the project's most expensive class of bug lives. Everything in §12 was paid
for once already, in weeks, and none of it is derivable from a specification: it is what actually
happens when several guest threads share one register file. The plan below is organised so that each
of those findings becomes a test before the code that could violate it exists.

## 1. Decisions fixed on entry

Grounded in the vendored v86 rather than recalled: every field named here was located in
`vendor/v86/src/cpu.js` before being written down.

| decision | value | evidence / consequence |
|---|---|---|
| what a context holds | GP registers, EIP, segment selectors **and** `segment_offsets`, materialised EFLAGS, the whole x87 stack **including its tag state**, MXCSR + XMM | v86 exposes `fpu_st` (8 registers), `fpu_stack_ptr`, `fpu_stack_empty`, `fpu_control_word`, `fpu_status_word`, `reg_xmm32s` (128 bytes = 8 XMM), `segment_offsets` (FS base at index 4), and `get_eflags()`. Everything §12.1 demands is reachable |
| x87 tag word | is `fpu_stack_empty` — there is no separate field | `fpu_set_tag_word` writes nothing else: it decodes the tag word into one bit per register in `fpu_stack_empty`, and `fpu_load_tag_word` reconstructs it. Saving the eight registers without it saves half the state |
| MMX aliases x87 | the same storage, and MMX rewrites the tag state constantly | MMX registers live in `fpu_st[r].mantissa`, and every MMX instruction calls `transition_fpu_to_mmx()` = `fpu_set_tag_word(0)` + `fpu_stack_ptr = 0` — 65 call sites in `instructions_0f.rs`. So a preempted MMX thread has already zeroed exactly what an x87 thread needs back |
| EFLAGS | saved through `get_eflags()`, restored with the lazy-flag machinery reset | v86 computes arithmetic flags lazily: `flags_changed` plus `last_op1`/`last_result`/`last_op_size`. The raw flags word is stale while `flags_changed` is non-zero, so saving it directly saves garbage |
| quantum | measured in **retired instructions**, never wall-clock — **and the mechanism has to be built first** | Measured, not assumed: today JS has one entry point, `main_loop()`, whose slice is bounded by wall clock (`TIME_PER_FRAME = 1.0 ms`) and quantised by `LOOP_COUNTER = 100_003`, both compile-time constants. Delivered per call: median 200 004 for a loop, 411 822 for straight-line code, one call at 16.8 ms. That is exactly the shape §12.2 forbids, so the fork patch is a prerequisite for the scheduler rather than a contingency (§3, P2.3) |
| blocking | park on `hlt`, never a bare `JMP $` | Measured: a guest parked on `hlt; jmp back` retires 18 instructions in a second of wall clock, because `do_many_cycles_native` exits on `in_hlt` and `main_loop` returns early. A bare jump is ordinary code and would burn the whole slice |
| switch points | exactly **one** primitive; every path routes through it | Two switch primitives drift apart, and then the FS base follows the thread on one path and not the other. Updating `segment_offsets[4]` is part of the primitive, not a duty of its callers (§12.5) |
| thread creation | never switches to the new thread | §12.4: the creator has not finished setting up shared state yet. The new thread is scheduled at the next quantum or an explicit yield |
| blocked threads | park on the existing park loop (`hlt`, jump back) | Phase 1 already writes that stub and uses it for process exit. A blocked thread must not be handed the CPU only to spin |
| scope | scheduler and synchronization only | The async-call contract (§12.3) is the bridge layer's, in Phase 3. Phase 2 provides the parking primitive it will use, and nothing more |

## 2. Structure at the end of the phase

```
modules/core/src/layers/kernel/
├── module.js              # BottlifyModule: no longer a stub
├── internal/
│   ├── context.js         # the CPU context record: capture and restore, exhaustively
│   ├── switch.js          # the single switch primitive; FS base moves here
│   ├── scheduler.js       # run queue, quantum accounting, preemption decision
│   ├── threads.js         # thread objects, lifecycle, TEB
│   ├── handles.js         # the handle table
│   ├── sync.js            # events, mutexes, semaphores, critical sections, waits
│   └── time.js            # real and virtual clocks, compensation
└── *.test.js
```

`cpu` grows whatever is needed to stop the guest at an instruction count and to read/write the
state above; `win32/kernel32` grows the thread and synchronization entry points the fixture calls.

## 3. Steps

### P2.1 — the context record

Capture and restore every piece of shared CPU state (§12.1), exhaustively, with a test that fills
each field with a distinct pattern and proves it survives a round trip — including the x87 stack
pointer and empty-flags, MXCSR, and materialised EFLAGS.

**Done when:** a round trip over a fully populated context is bit-identical, and a deliberately
incomplete restore fails the test rather than passing quietly.

One case must be tested explicitly rather than left to chance: **a thread running MMX interleaved
with a thread running x87.** They share one register file, and MMX zeroes the tag state and the
stack pointer on every single instruction, so this is not an unlikely race — it is what happens the
first time a codec and a math routine run in the same process. A context that saves the eight
registers but not `fpu_stack_empty`/`fpu_stack_ptr` passes every single-threaded test and then wakes
the x87 thread onto someone else's stack. That is §12.1's failure mode, made certain.

### P2.2 — the single switch primitive

One function performs a switch: save the outgoing context, update the FS base to the incoming
thread's TEB, restore the incoming context. A same-thread switch is a no-op by construction rather
than by check.

**Done when:** a test asserts the FS base follows the resumed thread, and a switch to the current
thread leaves the CPU untouched.

### P2.3 — the instruction-counted quantum (fork patch first)

Measured before planning: the mechanism does not exist yet. `main_loop()` is the only way into
execution from JS, and it runs chunks until either `LOOP_COUNTER` (100 003) instructions or
`TIME_PER_FRAME` (1.0 ms) of wall clock — both compile-time constants. Delivered per call: median
200 004 for a tight loop, 411 822 for straight-line code, with one call observed at 16.8 ms because
the wall-clock check happens only between chunks. Disabling the JIT moved the median to 400 008, so
the figure tracks execution characteristics rather than any instruction budget.

So the patch is a prerequisite, in two parts, and the second is the one that is easy to skip:

1. **A runtime slice bound and a way to drive one slice.** `do_many_cycles_native` compares against
   the `LOOP_COUNTER` constant; make the bound a runtime value and export a slice runner that takes
   a maximum and returns the instructions actually retired. That gives the scheduler an
   instruction-counted quantum without `main_loop`'s wall-clock loop.
2. **The in-block check is compiled in.** The JIT emits the loop-safety comparison against the same
   constant, so a block containing a hot inner loop still runs up to 100 003 iterations regardless of
   any runtime limit. Making a small quantum real means emitting a load from a global instead, and
   flushing the code cache when that global changes.

**Part 1 is done and measured.** `run_slice(max)` is exported by our fork: it runs at most `max`
instructions and returns how many it retired, driving guest instructions only and ending early on
`in_hlt`. Against a real build:

| guest shape | requested | delivered |
|---|---|---|
| straight-line | 100 / 1 000 / 5 000 / 20 000 | 4 096 / 4 096 / 8 192 / 20 480 |
| tight loop in one block | any of the above | 100 002 |

So the achievable granularity today is **one page**: the JIT compiles per 4 KiB page, and a slice
rounds up to the end of the page it is in. A quantum below that is not obtainable, and a quantum
above it is honoured to within one page — for straight-line code.

A hot loop that fits in a single compiled block still runs to the in-block ceiling regardless, which
is what part 2 is for. Both numbers are asserted in `cpu/internal/quantum.itest.js`, the second one
deliberately encoding the current limitation so that fixing it makes the test fail and demand
tightening.

Two tests, and the second is the one that matters: that the declared quantum is used, and that the
quantum **actually delivered** stays within its budget. Write the second one first and expect it to
fail, since today it measures 200k-400k against whatever is requested.

`JIT_USE_LOOP_SAFETY` can be turned off entirely through the existing JIT config; that removes the
in-block check and makes overshoot unbounded, so it is a knob pointing the wrong way.
`MAX_EXTRA_BASIC_BLOCKS` bounds block merging and is worth measuring alongside the patch as a way to
shrink straight-line blocks without touching codegen.

**Done when:** actual quantum is measured in CI, not assumed, and a regression fails the build.

### P2.4 — threads and the handle table

Thread objects, lifecycle, TEB per thread, and the handle table the rest of Win32 will index into.
Creation does not switch (§12.4).

**Done when:** threads can be created, scheduled round-robin, and retired; creating one does not
move the CPU off the creator; handles are allocated, looked up and closed, and a stale handle is an
error rather than a wrong object.

### P2.5 — synchronization objects

Events (auto and manual reset), mutexes, semaphores, critical sections, and waiting on one or many
objects. Behaviour comes from the documented contract — what a wait returns, what a timeout means,
who is woken and in what order — with Wine's conformance expectations as the reference for the edges.

**Done when:** contract tests cover each object's states and transitions, including the awkward ones:
recursive acquisition, abandoned mutexes, a wait that times out, and waking exactly one waiter versus
all of them.

### P2.6 — time, real and virtual

A virtual clock that is credited while our own code runs (§12.6): if the time spent inside a trap
handler is not accounted to the guest, the program concludes the frame took zero and speeds up.
Credit with a floor and a ceiling, so a long operation does not produce a jump.

**Done when:** a guest loop that measures elapsed time across a slow trap sees a plausible interval,
and the credited amount is bounded.

### P2.7 — acceptance

A multithreaded fixture, generated the way `hello.exe` is (`tools/make-pe.mjs`), exercising
producer/consumer, contention on a critical section, and a wait on several objects. Real Windows
runs it and its output is the expected result — the same oracle Phase 1 used.

**Done when:** the fixture produces a deterministic result 100 runs in a row under Bottlify, matching
what Windows produces, in CI. Plus every §12 assertion from the steps above, green.

## 4. Order and dependencies

P2.1 → P2.2 → P2.3; P2.4 needs P2.2; P2.5 needs P2.4; P2.6 is independent of the rest and can run
alongside. P2.7 closes the phase and depends on all of them plus the kernel32 surface the fixture
calls.

## 5. Deliberately NOT in Phase 2

- The async call contract and guest callbacks (§12.3) — bridge, Phase 3. Phase 2 only provides the
  parking primitive.
- The wide Win32 surface: only the thread and synchronization entry points the fixture needs.
- Fibers, thread pools, APCs, structured exception handling.
- Multi-core anything. One guest CPU, several guest threads.

## 5a. Properties of the vendored emulator worth knowing before writing kernel code

Read out of `vendor/v86`'s own source, not assumed. Where a claim is not verified it says so, and
verifying it is part of the step that depends on it.

| property | what the source says | why the kernel cares |
|---|---|---|
| the x87 is softfloat, and precision control is wired | `fpu_set_control_word` decodes the PC field and calls `F80::set_precision`, which sets `extF80_roundingPrecision` to 80/64/32 | The control word is not decorative: it changes arithmetic results. Restoring it as part of a context is load-bearing, not bookkeeping |
| the tag word is `fpu_stack_empty` | `fpu_set_tag_word` decodes into one bit per register there and `fpu_load_tag_word` reconstructs it; no separate field exists | A context that saves eight registers and omits it saves half the x87 state |
| MMX aliases x87 and rewrites its tag state | MMX registers are `fpu_st[r].mantissa`; every MMX instruction calls `transition_fpu_to_mmx()` = `fpu_set_tag_word(0)` + `fpu_stack_ptr = 0` — 65 call sites in `instructions_0f.rs` | Interleaving MMX and x87 threads is the case that breaks an incomplete context, and it is ordinary, not exotic |
| `hlt` is a first-class state, a spin loop is not | The cycle loop tracks `in_hlt` and leaves the slice on it; a `JMP $` stub, by contrast, is ordinary code the JIT will execute at full speed for the remainder of the quantum | Our park stub is `hlt` for this reason. If it ever becomes a bare jump, a blocked thread starts burning its whole quantum. Measure this rather than trusting the reasoning |
| MMX is a helper call per instruction | Every MMX instruction compiles to a wasm-to-Rust call, while SSE is inlined, and each helper redoes the FPU tag work: a run of 16 `movq` is 16 calls plus 16 rounds of bookkeeping instead of 16 stores | Not a Phase 2 concern, but it shapes one later: inlining MMX in the JIT is mechanical, since the registers are plain `u64` with no 80-bit conversion in the path. Some titles are likely to need it for acceptable video and audio throughput — to be established by our own measurement, not assumed |

When one of these turns into a patch, it is written here, for our fork, from the behaviour of the
code — not adapted from anyone else's tree.

## 6. Open questions

- ~~Can v86 be preempted inside a compiled block?~~ **Answered by measurement** (see P2.3): not from
  JS today, and not inside a block at all without changing what the JIT emits. The work is now a
  planned step rather than an unknown.
- **Where does the TEB live?** It needs an address-space home and a region kind; the memory layer's
  map should describe it like everything else rather than it being a magic address.
- **Does the scheduler own virtual time, or does the cpu layer?** Time is credited during traps,
  which the bridge will drive in Phase 3; deciding the owner now avoids moving it later.
