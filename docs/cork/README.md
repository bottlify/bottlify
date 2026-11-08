# cork

Cork is a module that runs x86 programs, 32-bit and 64-bit (x86-64), in the browser. A browser cannot run x86
machine code, so cork translates it into WebAssembly, and the browser compiles that for its own
processor. That is why one build of Bottlify runs on x86 and on ARM alike. Translated code runs
over twenty times faster than decoding every instruction again, and on average only three times
slower than the real processor.

Cork translates hot loops and whole functions at once and keeps the finished translations, so a
program's second run is fast from the start. A program's threads can run in parallel, on separate
cores, over shared memory. The details are in [Why it is fast](#why-it-is-fast) and
[How it works](how-it-works.md).

In [Bottlify](../../README.md) cork is the processor. It knows nothing about Windows: a system
call, a port write or a fault stops it and hands control back to
[`@bottlify/core`](../../modules/core/README.md), home of the Windows API, DirectX and sound.

Cork is written in plain JavaScript and WebAssembly, with no dependencies, and runs in a browser
and in Node.

## What it runs

- 32-bit user-mode x86: integer instructions, the x87, MMX, SSE, SSE2, SSE3, SSSE3, SSE4.1 and
  SSE4.2 (the string compares and CRC32 among them), with POPCNT, MOVBE and RDRAND: the set
  cork reports through `cpuid`, MOVBE and RDRAND aside, which run unannounced.
- 64-bit user-mode x86-64, the same set with the sixteen 64-bit registers, by the same
  translator and runtime at a 64-bit width, its memory a 4 GiB window: an address at or past
  4 GiB faults, except where an access goes untested -- outside precise mode a read, and while
  stacks are loose (`looseStacks`) a push, pop, call or return through rsp -- which takes the
  address's low half ([`roadmap/x64.md`](../../roadmap/x64.md)).
- Code that rewrites itself. When the program writes over code that is already translated, the old
  translation is thrown away and a new one made. A page rewritten over and over (eight times within
  100 ms) is left to the interpreter for a while.
- Several threads over one memory. With the `atomic` setting, which Bottlify turns on when a
  process runs on several executors, `lock`-prefixed instructions and `xchg` with memory run as
  WebAssembly atomics, so threads do not lose each other's writes. With `ordered` as well (off
  unless a page asks for it), an integer operand's load and store not through esp are atomics
  too, so the threads see each other's plain stores in their order on an arm64 host, as on x86.
- Exact faults. A division by zero, an unknown instruction or a write to a closed page stops right
  at that instruction, with the registers a real processor would have.

## What it does not run

- 16-bit code, privileged instructions, segments other than the `fs` base in 32-bit code and
  the `gs` base in 64-bit code (another override adds nothing).
- AVX and anything newer (the VEX and EVEX encodings), and the SHA, AES and PCLMULQDQ
  instructions.
- The x87's 80-bit precision. The FPU registers are plain 64-bit doubles: single and double
  precision are honoured, extended is computed as double. Sine, logarithm and the rest come from
  `Math`. Exception masks are not honoured: every x87 exception behaves as masked.

## Why it is fast

cork runs a program at about a third of the real processor's speed on average, and at half of it on
tight loops. On the same programs it is 5 to 8 times faster than v86, the best-known x86 emulator in
a browser (numbers below). This is where the speed comes from:

- **It translates whole loops and functions, not single instructions.** A loop or a function,
  together with the small functions it calls, becomes one WebAssembly function. We call such a
  piece a region. The browser's compiler sees an ordinary loop in it and optimizes it like any
  other code.
- **Registers are local variables.** Inside a region the x86 registers are locals of the function,
  and the browser puts them in the processor's own registers. The program's memory is one
  `WebAssembly.Memory`, so `mov eax, [esi+8]` is a single load with no page tables in between.
- **Flags are worked out only where they are read.** Nearly every x86 instruction sets flags and
  hardly anything reads them. A `cmp` followed by a `jl` becomes one comparison.
- **Translated code stays in WebAssembly.** Regions go from one to another with plain calls between
  WebAssembly functions, never through JavaScript.
- **It guesses where virtual calls go.** cork watches where calls through a pointer actually land.
  When a call goes mostly to a few small functions (up to four, each taking at least an eighth of
  its calls), they are built right into the region and the call becomes a comparison.
- **The program never waits for the translator.** Translation runs in worker threads while the
  program keeps going in the interpreter. The main thread gives the translator a few milliseconds
  at a time at most, so a game does not freeze when it reaches new code.
- **The second run is fast from the start.** Finished translations are kept in the browser's
  storage (OPFS) and loaded from there the next time. A bundle can bring them along.
