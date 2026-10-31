# The guest-code compiler

Every call a program makes into the host is a crossing: the guest stops, the host runs the
handler, the guest resumes, at a cost of microseconds. A runtime function or a COM method a
program calls thousands of times a frame is cheaper as code the guest runs itself. This compiler
writes that code from the same JavaScript that is the function's host handler, so there is one
source and one meaning.

## What it does

A function marked `@guestCode` in a module under `src/` is compiled to i386 code. The compiled
bytes are committed in a module beside the source: `inguest-vector.js` produces
`inguest-vector.x86.js`. The JavaScript function stays the export's handler and the reference
the x86 is checked against.

```js
/**
 * D3DXVECTOR2 *D3DXVec2Normalize(D3DXVECTOR2 *out, const D3DXVECTOR2 *v)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v
 * @returns {u32}
 */
export function D3DXVec2Normalize({ f32, setF32 }, out, v){ ... }
```

- **Convention**: the tag names `cdecl`, `stdcall` or `thiscall`. A thiscall function's first
  parameter is `this`, which arrives in ECX.
- **Types**: `i32`/`u32` (a stack slot, EAX as a result), `f64`, `f32`, `x87` (a double the
  caller left on the x87 stack), `i64` (EDX:EAX), `void`.
- **Guest memory**: through the helpers taken from the first parameter: the loads `u8` `i8`
  `u16` `i16` `u32` `i32` `f32` `f64`, the stores `setU8` `setU16` `setU32` `setF32` `setF64`,
  `copyUp`/`copyDown`/`fill`, `call(fn, ...)` for a cdecl function pointer, and
  `compareExchange(address, expected, value)`, `lock cmpxchg` answering what the dword held:
  the kernel's words that several executors change at once (i386 only).
- **A table placed at run time**: an exported typed array is placed after the code, and the
  compiled record says where (`tables`); a binding that writes the address of something it
  placed into that copy of the table (`semaphore-guest.js`'s `HANDLE_WORDS`) finds it there.
- **The host as a fallback**: `return host()` hands the call, arguments untouched, to the
  host's handler of the same function. Use it for the rare case the guest code does not take,
  such as errno to set or a handle it does not know. Nothing written before the hand-over is
  undone, so the code goes to the host before it writes.
- **The x87 environment**: `controlWord()`, `statusWord()`, `setControlWord()` and
  `clearExceptions()`.

The subset of JavaScript is the part whose meaning 32-bit integer and x87 code reproduce
exactly: asm.js-style integers (`|0`, `>>>0`), doubles as the x87's arithmetic, `Math.*`
functions that are one x87 instruction, loops, module-level constants, exported typed-array
tables, and one-`return` helpers that are inlined. Anything outside the subset is refused with
its place in the source rather than approximated. The full rules are in the header of
[`compile.mjs`](compile.mjs).

## x86-64

A 64-bit process runs no i386. For the modules `LONG` names in
[`../build-guest-code.mjs`](../build-guest-code.mjs), the same source is also compiled to
x86-64 under the x64 convention (`compileModule(text, { bits: 64 })`), into a module beside
the i386 one: `inguest.js` into `inguest.x64.js`, whose `COMPILED` has the code and whose
`REFUSED` names each function with none and why.

- **Convention**: the arguments in RCX, RDX, R8 and R9 and the stack past the 32 bytes of home
  space, read as their low halves; the result in RAX, an `i32` or `u32` extended by its sign as
  the bridge's 64-bit trap answers one. The tag's convention means nothing at 64 bits.
- **Registers**: the same 32-bit integers, over RAX..RDI and R8..R11 (named through a REX
  prefix). Variables take RDX and R8 to R11 first, which the callee may change, then the
  slots of the home space no argument holds, and only past those RBX, RSI, RDI or RBP, which
  the code keeps in a free register or home slot rather than pushing. A function that calls
  nothing and needs no more is a leaf (`leaf: true` in the module): it moves no stack and
  changes no register its caller keeps, which is what an unwinder takes code without unwind
  data to be. One that calls through a pointer or copies with `rep movs` is not.
- **Addresses**: a register holds an address as a 32-bit operation leaves it, zero-extended;
  an address of two registers is made into one by a 32-bit `lea` first, which wraps at 2^32 as
  the helpers' addresses do.
- **`return host()`**: the frame taken down, RCX, RDX, R8 and R9 taken back from the home
  space where the entry wrote them, and a `jmp rel32` to the handler's trap.
- **Doubles**: scalar SSE2, exact as JavaScript's doubles are. A double or float argument comes
  in the XMM register of its place, the result goes in XMM0, and an expression's doubles are
  XMM0 to XMM3. `+ - * /`, unary `-`, `Math.sqrt`, `abs`, `fround`, `floor`, `ceil` and
  `trunc`, the comparisons, `| 0`, `>>> 0`, `f32`/`f64` loads and stores. A function with a
  double argument or result has no `host()`: the 64-bit trap carries no XMM register.
- **Refused at 64 bits**: what only the x87 does (`%` of doubles, `Math.sin` and the other
  transcendentals, `X87`), x87 arguments, the x87's control and status words, an `i64`
  result, more than four doubles at once, and a function `LONG` names for a pointer its
  source lays out as four bytes. Each stays a trap into its handler there.

`guestEntry` and `guestExport` carry the x86-64 as the export's `long`, bound as `code` is;
`longCodeOf` finds it by the i386 record. [`long.mjs`](long.mjs) is cork's long-mode machine
for the tests: `equivalence` runs every case through the x86-64 too where there is any, and
[`long.test.js`](long.test.js) holds every function of every 64-bit module to its JavaScript.

## Files

| file | what |
| --- | --- |
| [`compile.mjs`](compile.mjs) | the compiler: the subset, register allocation, the code, i386 and x86-64 |
| [`x86.mjs`](x86.mjs) | the instructions it emits and the assembler that lays them out |
| [`equivalence.mjs`](equivalence.mjs) | runs a function both ways (JavaScript handler and x86 on cork's test machine, and its x86-64 on the long-mode one) and compares results, x87 stack, memory and what a callee owes its caller |
| [`long.mjs`](long.mjs) | cork's long-mode machine for the tests, called as the x64 convention calls |
| [`model.mjs`](model.mjs) | the x87's model of a module under single precision, the reference there |
| [`compile.test.js`](compile.test.js) | the compiler's own tests |
| [`long.test.js`](long.test.js) | the gate of the committed x86-64: every function against its JavaScript |
| `../build-guest-code.mjs` | compiles every `@guestCode` module under `src/` |

At run time `guestEntry` in `src/layers/win32/msvcrt/guest-code.js` binds the two: an export
whose code is the compiled bytes and whose handler is the JavaScript.

## Workflow

1. Write or change the `@guestCode` function.
2. `npm run build` (or `node scripts/build-guest-code.mjs` in [`modules/core`](../..)) rewrites the
   `*.x86.js` modules, and the `*.x64.js` ones. `node scripts/build-guest-code.mjs --check` fails
   when one is stale.
3. The module's test compiles the source again, fails when the committed bytes differ, and runs
   `equivalence` over random inputs and edge cases under several control words. See
   `src/layers/win32/d3dx9/inguest-vector.test.js` for the pattern.
4. Wire it in: an export goes through `guestEntry`. A COM method takes code through the
   `guest` slot of its method (`src/layers/bridge/internal/vtable.js`): given its own trap to
   fall back to, it answers the address the vtable slot holds.

## When to use it

When a profile shows the crossings (`trap`, `drive` in the phase profile, the bridge's calls
by function) and the function is guest-memory work with no state the host must keep. A path
that runs in the guest beside a host path gets a differential gate in the same change
(CLAUDE.md, "Every second path has a gate").
