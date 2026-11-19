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
- **Types**: `i32`/`u32` (a stack slot, EAX as a result), `ptr` (a pointer: a `u32` in the
  i386, a quadword at 64 bits), `f64`, `f32`, `f32bits` (a FLOAT by value that the source
  takes as its dword, as a handler's trap hands it: a stack slot in the i386, the XMM register
  of its place read bit for bit at 64 bits), `x87` (a double the caller left on the x87
  stack), `i64`, `void`.
- **A pointer**: a `ptr` parameter, or a variable declared with a pointer expression (a pointer
  with constants and integers added or taken away: `const end = text + count`; several integers
  are summed in 32 bits first, a signed index within 2 GiB of the pointer). It
  is taken whole where a pointer stands: the address of a load, a store, `copyUp`, `copyDown`
  or `fill`; a comparison with another pointer or a constant; `=`, `+=`, `-=`, `++` and `--`
  of a pointer variable; an argument of `call` or of a `@guestCode` function whose parameter
  is a `ptr`; the result of a `ptr` function. Its 32 bits are written as such - `p & 3`,
  `(q - p) | 0`, `p >>> 0` - and any other use of it as an integer is refused, because the
  x86-64 would take half of what the handler takes. Write a pointer the function walks as a
  pointer (`at++`, `at += 4`, `at < end`), not as `(at + 1) >>> 0`, which is its low half.
- **A 64-bit integer**: an `i64` parameter is two stack slots in the i386 and one argument at
  64 bits (a bigint in the JavaScript); `low64(x)` and `high64(x)` read its dwords where it
  lies, and nothing else reads it. An `i64` result is EDX:EAX, or RAX: a double truncated, an
  integer widened, or `return int64(low, high)` of two 32-bit integers. The arithmetic is the
  source's own on the halves in the 32-bit subset: a carry or a borrow an unsigned compare, a
  product of a half split into 16-bit parts (`msvcrt/inguest-int64.js`), the same code at both
  widths.
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
the i386 one: `inguest.js` into `inguest.x64.js` (and so `inguest-math.js`, `inguest-print.js`, `inguest-float.js`, `inguest-string.js` and `inguest-rtti.js`), whose `COMPILED` has the code and whose
`REFUSED` names each function with none and why.

- **Convention**: the arguments in RCX, RDX, R8 and R9 and the stack past the 32 bytes of home
  space, an integer read as its low half and a `ptr` whole; the result in RAX, an `i32`
  extended by its sign, a `u32` (a `size_t`, a `DWORD`) by zeros, a `ptr` whole - what a
  Win64 caller of a `size_t` or a pointer reads. The export carries the declared type to the
  bridge (`guestExport`: `returns`, and `addresses` for its `ptr` parameters), so the 64-bit
  trap hands the handler a pointer whole and leaves RAX as the code does:
  [`answers.test.js`](answers.test.js) holds the two to one quadword from 2^31 up. The tag's
  convention means nothing at 64 bits.
- **Registers**: the same 32-bit integers, over RAX..RDI and R8..R11 (named through a REX
  prefix). Variables take RDX and R8 to R11 first, which the callee may change, then the
  slots of the home space no argument holds, and only past those RBX, RSI, RDI or RBP, which
  the code keeps in a free register or home slot rather than pushing. A function that calls
  nothing and needs no more is a leaf (`leaf: true` in the module): it moves no stack and
  changes no register its caller keeps, which is what an unwinder takes code without unwind
  data to be. One that calls through a pointer or copies with `rep movs` is not.
- **Addresses**: an integer's register holds an address as a 32-bit operation leaves it,
  zero-extended; an address of two such registers is made into one by a 32-bit `lea` first,
  which wraps at 2^32 as the helpers' addresses do. A `ptr` is the quadword: its register or
  its slot whole, its index extended to 64 bits (an `i32` by its sign) and added there, its
  comparisons and its moves under REX.W, and `rep movs` and `rep stos` stepping RSI and RDI
  whole. A function whose pointers are `u32` reads the low half of a pointer past 4 GiB, as
  it always did; one whose pointers are `ptr` follows it
  ([`pointer.test.js`](pointer.test.js), on a wide window).
- **`return host()`**: the frame taken down, RCX, RDX, R8 and R9 taken back from the home
  space where the entry wrote them, and a `jmp rel32` to the handler's trap.
- **Doubles**: scalar SSE2, exact as JavaScript's doubles are. A double or float argument comes
  in the XMM register of its place, the result goes in XMM0, and an expression's doubles are
  XMM0 to XMM3, XMM4 and XMM5 an operation's scratch; up to six deep, XMM6 and XMM7, which the
  caller keeps, are taken too and saved in the frame where the code writes them. `+ - * /`, unary `-`, `Math.sqrt`, `abs`, `fround`, `floor`, `ceil` and
  `trunc`, the comparisons, `| 0`, `>>> 0`, `f32`/`f64` loads and stores. `host()` in a function
  with a double or float argument reloads it into its XMM register from the home space, where
  the bridge's 64-bit trap reads it (the export declares `floats`).
- **A float's bits**: `floatBits(x)` is the IEEE single of a double as a `u32`, and
  `floatOfBits(n)` the double a `u32`'s single holds - what a libm routine splits an argument
  into exponent and mantissa with. `doubleLow(x)` and `doubleHigh(x)` are a double's two
  dwords bit for bit: `movq` at 64 bits, and at 32 the dword of a double variable where it
  lies in the frame (a parameter's slot), never through `fld`, which would quiet a signalling
  NaN and raise the invalid flag. All run in the handler as well, taken from the first
  parameter like the memory helpers; a JavaScript double may quiet a signalling NaN there.
- **The x87's one instruction for it**: `Math.sin`, `cos`, `tan`, `atan`, `atan2` and `log2`,
  and `X87`'s operations, store their doubles below RSP, load them onto the x87 (empty at a
  call, as the convention leaves it), run the instruction the i386 runs and take the answer
  back into its XMM register; a function that does so moves RSP and is no leaf. `X87`'s
  constants are the doubles the source's own `X87` holds, and `%` of doubles is the i386's
  loop of `fprem`.
- **The pointer's size**: `pointerBytes`, taken from the guest like the helpers, is 4 in the i386
  and 8 in the x86-64, a constant of each (and the process's in the handler): a pointer the source
  writes, or a slot it steps by, is laid out by it, and an `if` or a `?:` comparing it keeps only
  the way it takes: a source may take the x87's words and use them only where
  `pointerBytes === 4`, which the x86-64 never compiles. An offset that differs by width is
  arithmetic on it (`const atSize = pointerBytes + 16`) or a `?:` on it choosing between two
  constants (`pointerBytes === 8 ? 24 : 20`): both fold into the displacement as a literal does,
  so the i386 costs what it did.
- **An `i64` result**: the whole quadword in RAX - a double truncated by `cvttsd2si` (NaN and
  out of range the integer indefinite, as `fisttp` answers), an integer extended by its sign.
- **`compareExchange`**: the i386's `lock cmpxchg` of a dword, the address zero-extended by the
  32-bit operation that made it.
- **MXCSR**: `mxcsr()` and `setMxcsr()` are the x86-64's as they are the i386's (`stmxcsr`,
  `ldmxcsr` through the stack): the word a 64-bit runtime keeps its rounding and exception
  flags in.
- **Refused at 64 bits**: x87 arguments, a use of the x87's control and status words (a source
  keeps them to the way `pointerBytes === 4` takes, and works on MXCSR in the other, as
  `msvcrt/inguest-float.js` does), more than six doubles at once, and a function `LONG` names
  for a pointer its source lays out as four bytes. Each stays a trap into its handler there.

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
| [`pointer.test.js`](pointer.test.js) | the pointer type: below 4 GiB at both widths, past it on a wide window, and what is refused |
| [`answers.test.js`](answers.test.js) | RAX from 2^31 up, the x86-64 code against the handler through the bridge's 64-bit trap |
| [`shaped-inputs.mjs`](shaped-inputs.mjs) | the gate's inputs for a function whose arguments agree only in a shape of their own (a C++ object and the delta it is held by), which its random text, counts and pointers never meet |
| [`class-graph.mjs`](class-graph.mjs) | a class hierarchy laid out as Visual C++ lays out its RTTI, 32-bit or 64-bit, for what reads it |
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
