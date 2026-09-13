# The crossing bench

What one call from the guest into the host costs, through the whole engine
and with nothing else going on. A hand-built executable loops a million times
over one import and exits; the same loop without the call is run first, so the
figure is the call alone.

Nothing here is a unit test and nothing here is imported by a package. Both
scripts serve `modules/core` from source and need the prebuilt emulator under
`modules/core/vendor/prebuilt/`.

| script | what it is | run it as |
|---|---|---|
| `crossing.mjs` | the loop in Node, one machine per process, best of the rounds | `node tools/bench/crossing.mjs [--kind id\|tick\|small\|args\|heap] [--calls N] [--rounds R] [--profile-calls] [--trace-strings] [--jit]` |
| `crossing-browser.mjs` | the same loop on a browser's page thread, with the browser's sampling profiler folded by function | `node tools/bench/crossing-browser.mjs [the same flags] [--top N]` |

| kind | what the loop calls | what it measures |
|---|---|---|
| `id` | `GetCurrentThreadId()` | the crossing with a handler of one property read |
| `tick` | `GetTickCount()` | a control: answered in guest code, so no crossing at all |
| `small` | `MulDiv(4, 5, 6)` | three arguments that cannot be pointers |
| `args` | `MulDiv(0x2300, 0x2200, 0x2100)` | three arguments that look like pointers and are not mapped -- the shape of most enumerated constants a program passes, and the case argument tracing pays for |
| `heap` | `HeapAlloc(heap, 0, 16)` then `HeapFree` of it | two crossings a turn with the allocator between them |

`--profile-calls` and `--trace-strings` switch on what `game.mjs` switches on, so
a figure can be compared with a report's. `--jit` prints the emulator's compiler
counters after the run: how much ran compiled, how much was interpreted and on
which pages.

The Node figure is a machine that runs compiled code -- the bench paces the
loop through `setImmediate` so the emulator's modules land -- but the figure
that matters is the browser's: the clocks, the wasm-to-JS boundary and the
collector all differ, and `crossing-browser.mjs` says where the browser's
thread went.
