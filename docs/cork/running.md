# Running cork

From a terminal, with Node 22 or later (`npm ci` once at the repository's root):

```sh
node modules/cork/bin/cork.mjs run program.elf --linux
```

`cork run <file>` loads a 32-bit little-endian ELF at its own addresses, or a piece of flat code at
`--at` (default `0x1000`), runs it, and prints why it stopped, what is in the registers, and how
many instructions ran, and how many of those in translated code:

```
fib ok
stopped: exit 0 at 0x00401134
eax 0x00000001  ecx 0x00000000  edx 0x00000000  ebx 0x00000000  esp 0x00ffffe4  ...
6627675 instructions, 6626800 of them translated, 0.051 s
```

| Option | What it does |
| --- | --- |
| `--linux` | Answers `int 0x80` the way Linux i386 does for `exit` (1), `exit_group` (252) and `write` (4) to stdout and stderr; any other call gets `-ENOSYS`. Without it the first `int 0x80` stops the run. |
| `--at addr`, `--entry addr` | Where flat code is loaded, and where to start (default: the ELF's entry, or `--at`). |
| `--ram MiB` | Memory for the program (default 16, more if the image needs it). The stack starts at its top. |
| `--max n` | Stop after about `n` instructions. |
| `--set eax=1,ecx=2` | Registers before the start. |
| `--config '<json>'` | Settings ([settings](settings.md)). |
| `--json` | The report as one line of JSON. |

The exit status: the program's own with `--linux`, 0 after a `hlt`, 1 for any other stop, 2 for a
bad command line or an error.

The program from the example above, which needs no C library:

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

`cork translate <file> --entry addr -o out.wasm` saves the region cork forms from that address as a
WebAssembly module of its own, to study with `wasm2wat` or `wasm-objdump` (`--at` places flat code
as for `run`; `--precise` translates as the `precise` setting does). The module does not run on its
own: it takes its memory and helpers from cork.

From JavaScript:

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
        // The system call answered here: eip is already past the int.
        machine.setReg('eax', machine.reg('eax') * 2);
        continue;
    }
    console.log(stop.reason, machine.reg('edi'));   // halt 1001000
    break;
}
await machine.dispose();
```

`createMachine({ ramSize, config, trapPort, now })` gives memory, registers and `run`. `run` goes on
until the program needs something from outside:

| `stop.reason` | What happened | Where `eip` is |
| --- | --- | --- |
| `halt` | `hlt` | after it |
| `interrupt` | `int n`, `int3`, `into`; `n` in `stop.vector` | after it, as the processor leaves it |
| `fault` | a fault: `#DE` 0, `#UD` 6, `#GP` 13 and so on; its number in `stop.vector` | on it |
| `trap` | an `out` to the trap port (any `out` if `trapPort` is not set); the value in `stop.value` | after it |
| `unsupported` | an instruction cork has no model of; its name in `stop.op` | on it |
| `limit` | `run({ maxInstructions })` ran out (translated code may go a little past) | where it stopped |

`stop.retired` is how many instructions ran, `stop.translated` how many of them in translated code.
The machine's clock is its program's, a millisecond a million instructions retired: what it
translates (a page rewritten too often is left to the interpreter, `volatileWindowMs`) follows the
program alone, not how busy the host is; `createMachine({ now })` gives it another.
The machine also has `load`, `read`, `reg` and `setReg` (the eight general registers, `eip`,
`eflags`), `memory` (the `WebAssembly.Memory`), `layout` (where each register is in it), `runtime`
(the translator behind it), `diagnostics()` and `dispose()`. `regionModule({ code, at, entry })`
does what `cork translate` does, from code.

Every threshold and size cork works with can be set: the list is in [settings](settings.md).

`@bottlify/core` ships a built copy of cork, so this package is needed directly only to use cork on
its own, or to load another build with `createApp({ cork: { moduleUrl } })`
([API](../core/api.md)).
