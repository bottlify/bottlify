# @bottlify/cork

An x86 (32-bit, user mode) to WebAssembly translator with its runtime. It runs machine code in
JavaScript hosts — a browser or Node — by translating the hot parts of a program into wasm
functions the host compiles to native code, and interpreting the rest. Nothing else is needed: no
emulator, no operating system, no runtime dependencies.

It is the engine [`@bottlify/core`](../core/README.md) runs Windows programs on, but it does not
know about Windows. What a program asks of the outside world — a system call, an I/O port, a
fault — stops the run and is handed to you.

- Integer code, x87, MMX, SSE, SSE2 and SSE3 (what its `cpuid` reports), self-modifying code,
  `lock`-prefixed instructions (as wasm atomics when several threads share memory).
- Flat 32-bit memory up to what wasm allows; no segmentation beyond `fs`/`gs` bases, no
  privileged instructions.

## Try it from a terminal

Node 22 or later. From this repository (`npm ci` once at the root):

```sh
node modules/cork/bin/cork.mjs run program.elf --linux
```

In a project that has the package installed (`npm install <checkout>/modules/cork`), the same
command is `npx cork`.

`cork run <file>` loads a 32-bit little-endian ELF at its own addresses, or flat code at `--at`
(default `0x1000`), and runs it from its entry until it stops. It prints why it stopped, the
registers, and how many instructions ran and how many of them in translated code:

```
fib ok
stopped: exit 0 at 0x00401134
eax 0x00000001  ecx 0x00000000  edx 0x00000000  ebx 0x00000000  esp 0x00ffffe4  ...
6627675 instructions, 6626800 of them translated, 0.051 s
```

| Option | What it does |
| --- | --- |
| `--linux` | Answers `int 0x80` as Linux i386 does for `exit` (1), `exit_group` (252) and `write` (4) to stdout and stderr; every other call gets `-ENOSYS`. Without it, the first `int 0x80` stops the run. |
| `--at addr`, `--entry addr` | Where flat code is loaded; where to start (default: the ELF's entry, or `--at`). |
| `--ram MiB` | Guest memory (default 16, more if the image needs it). The stack starts at its top. |
| `--max n` | Stop after about `n` instructions. |
| `--set eax=1,ecx=2` | Registers before the start. |
| `--config '<json>'` | The translator's settings (below). |
| `--json` | The report as one JSON line on stdout. |

The exit status is the program's under `--linux`, 0 for a `hlt`, 1 for any other stop.

That is the program below, which needs no C library:

```c
// fib.c -- clang --target=i386-linux-gnu -O2 -nostdlib -static -ffreestanding -fno-pic
//          -fuse-ld=lld fib.c -o fib.elf
static int sys(int n, int a, int b, int c){
    int r;
    __asm__ volatile("int $0x80" : "=a"(r) : "a"(n), "b"(a), "c"(b), "d"(c) : "memory");
    return r;
}
static unsigned fib(unsigned n){ return n < 2 ? n : fib(n - 1) + fib(n - 2); }
void _start(void){
    char text[] = "fib ok\n";
    if (fib(27) == 196418) sys(4, 1, (int)text, 7);
    sys(1, 0, 0, 0);
}
```

`cork translate <file> --entry addr -o out.wasm` writes what the translator makes of the code at
an address: one region as a wasm module, to read with `wasm2wat` or `wasm-objdump`. It imports the
memory with cork's register block in it and the runtime's helpers, so it is for reading, not for
running alone.

## Use it from JavaScript

```js
import { createMachine } from '@bottlify/cork';

const machine = createMachine({ ramSize: 16 << 20 });
// mov ecx, 1000; L: mov eax, ecx; int 0x80; add edi, eax; dec ecx; jnz L; hlt
machine.load(0x1000, [0xb9, 0xe8, 3, 0, 0, 0x89, 0xc8, 0xcd, 0x80, 0x01, 0xc7, 0x49, 0x75, 0xf7,
    0xf4]);
machine.setReg('eip', 0x1000);
machine.setReg('esp', (16 << 20) - 16);

for (;;)
{
    const stop = await machine.run();
    if (stop.reason === 'interrupt' && stop.vector === 0x80)
    {
        // Your system call: eip is already past the int.
        machine.setReg('eax', machine.reg('eax') * 2);
        continue;
    }
    console.log(stop.reason, machine.reg('edi'));   // halt 1001000
    break;
}
await machine.dispose();
```

`createMachine({ ramSize, config, trapPort })` gives you guest memory and registers and a `run`
that interprets cold code, translates what gets hot (in a worker in a browser, inline in Node) and
runs it, until the program needs you:

| `stop.reason` | What happened | Where `eip` is |
| --- | --- | --- |
| `halt` | `hlt` | after it |
| `interrupt` | `int n`, `int3`, `into`; `stop.vector` is `n` | after it, as the processor pushes it |
| `fault` | an exception: `#DE` 0, `#UD` 6, `#GP` 13, …; `stop.vector` | at the instruction |
| `trap` | an `out` to the trap port (every `out` when no `trapPort` is given); `stop.value` | after it |
| `unsupported` | an instruction neither tier has a model for; `stop.op` | at it |
| `limit` | `run({ maxInstructions })` ran out (translated code may run a few past it) | wherever it was |

`stop.retired` and `stop.translated` count the instructions the run retired and how many of them
ran as translated code. The machine also has `load`, `read`, `reg`/`setReg` (the eight general
registers, `eip`, `eflags`), `memory` (the `WebAssembly.Memory`), `layout` (where each register
lives in it), `diagnostics()` and `dispose()`.

`regionModule({ code, at, entry })` is `cork translate` as a function: the wasm bytes of one region
and the blocks it formed.

### Settings

`config` is the translator's configuration. The ones worth knowing:

| Setting | Default | What it does |
| --- | --- | --- |
| `precise` | `false` | x87 exception flags, signalling NaNs and the flags an instruction leaves undefined exactly as the processor leaves them, at some cost. Off is how games run. |
| `atomic` | `false` | `lock` instructions and `xchg` with memory as wasm atomics, for several threads on one shared memory. |
| `hotThreshold` | 2000 | How much a piece of code must run before it is translated. |
| `worker`, `translators` | on in a browser, 1 | Translate in workers, and how many. |
| `translate` | `true` | `false` interprets everything: a reference to compare translated runs against. |

Every setting, with what it trades, is the `EngineConfig` typedef in
[`modules/core/src/layers/cpu/engine.js`](../core/src/layers/cpu/engine.js).

## As an engine of `@bottlify/core`

The core loads this package by URL and never imports it: `createEngine` implements the executor
contract in [`engine.js`](../core/src/layers/cpu/engine.js), and the core's own host adds Win32,
threads and the scheduler on top. `@bottlify/core` ships a built copy of it; you only need this
package directly to use the translator on its own, or to load a build of your own with
`createApp({ cork: { moduleUrl } })`.

## Development

```sh
npm test -w @bottlify/cork                  # unit tests and gates, a minute or two
npm run fetch:corpus                        # once: the instruction corpus
npm run test:integration -w @bottlify/cork  # the corpus suites
node modules/cork/bench/run.mjs             # the benchmark (bench/README.md)
```

How the translator is judged:

- **The instruction corpus** (`npm run fetch:corpus`, pinned by `corpus-lock.json`) runs every
  case through the decoder, both interpreters and translated code, against the state real hardware
  recorded.
- **The sequence corpus** (`testing/sequences-judge.js`) runs generated sequences of instructions on
  cork's own instruction model and on translated code, and compares the two bit for bit.
- **Gates** compare every fast path with the slow one beside it on seeded programs: the machine's
  translated runs against interpreted ones (`machine.test.js`), translation workers against inline
  translation (`runtime/translators.test.js`), the shared translation arena
  (`runtime/arena.test.js`), the atomic variant's locked forms against the model
  (`emit/locked.test.js`).

Translation runs in workers (`runtime/translator.worker.js`); what they emit is kept in an arena of
shared memory every translator of a process reads and adds to. How it all fits together:
[`docs/architecture.md`](../../docs/architecture.md); where it goes next: `roadmap/v2/`.

Vanilla ES modules with JSDoc, no runtime dependencies, tests on `node:test`. MPL-2.0.
