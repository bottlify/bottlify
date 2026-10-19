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
  `copyUp`/`copyDown`/`fill`, and `call(fn, ...)` for a cdecl function pointer.
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

## Files

| file | what |
| --- | --- |
| [`compile.mjs`](compile.mjs) | the compiler: the subset, register allocation, the code |
| [`x86.mjs`](x86.mjs) | the instructions it emits and the assembler that lays them out |
| [`equivalence.mjs`](equivalence.mjs) | runs a function both ways (JavaScript handler and x86 on cork's test machine) and compares results, x87 stack, memory and what a callee owes its caller |
| [`model.mjs`](model.mjs) | the x87's model of a module under single precision, the reference there |
| [`compile.test.js`](compile.test.js) | the compiler's own tests |
| `../build-guest-code.mjs` | compiles every `@guestCode` module under `src/` |

At run time `guestEntry` in `src/layers/win32/msvcrt/guest-code.js` binds the two: an export
whose code is the compiled bytes and whose handler is the JavaScript.

## Workflow

1. Write or change the `@guestCode` function.
2. `npm run build` (or `node scripts/build-guest-code.mjs` in [`modules/core`](../..)) rewrites the
   `*.x86.js` modules. `node scripts/build-guest-code.mjs --check` fails when one is stale.
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
