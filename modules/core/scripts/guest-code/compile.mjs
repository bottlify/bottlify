/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * Compiles the functions a module marks `@guestCode` from JavaScript into
 * i386 code the guest runs itself: a runtime function that is pure -- no
 * state, no call into the host -- costs an instruction sequence in the
 * program's own translated code instead of a crossing into the host.
 *
 * The same source stays an ordinary JavaScript function, and both are held
 * to one meaning: the subset below is the part of JavaScript whose meaning
 * 32-bit integer and x87 code can reproduce exactly, and anything outside it
 * is refused with its place in the source rather than approximated.
 *
 *   /**
 *    * @guestCode cdecl
 *    * @param {Guest} guest @param {u32} left @param {u32} right @param {u32} count
 *    * @returns {i32}
 *    *\/
 *   export function strncmp({ u8 }, left, right, count){ ... }
 *
 * The tag names the calling convention (`cdecl`, `stdcall` or `thiscall`);
 * `@param` and `@returns` give each value's machine type. A thiscall
 * function's first parameter is `this`, which the caller passes in ECX: the
 * code begins `pop eax; push ecx; push eax`, putting it on the stack before
 * the others, and is a stdcall function from there, whose `ret` takes the
 * slot it pushed with the caller's arguments. The types:
 *
 *   i32, u32  a 32-bit stack slot, signed or unsigned; EAX as a result
 *   f64       a double: two stack slots; ST0 as a result
 *   f32       a float: one stack slot; ST0 as a result, a value a float holds
 *   x87       a double the caller left on the x87 stack (the last such
 *             parameter in ST0), which the function pops, as `_ftol` does
 *   i64       a result in EDX:EAX: a double truncated toward zero (NaN and
 *             out of range the integer indefinite, as `fisttp` answers), or
 *             an integer extended by its sign
 *   void      no result
 *
 * A function that touches guest memory or calls a guest function takes the
 * helpers it uses from its first parameter, destructured: `{ u8, setU8 }`.
 * The loads are u8, i8, u16, i16, u32, i32, f32 and f64 (address); the
 * stores setU8, setU16, setU32, setF32 and setF64 (address, value), a
 * float stored rounded to nearest as `fstp dword` stores it; `call(fn, ...)`
 * calls a cdecl function pointer and answers its EAX as an i32, and
 * `callStd(fn, ...)` a stdcall one, which pops its own arguments -- a COM
 * method, `this` the first; `copyUp`,
 * `copyDown` (dst, src, count) copy bytes ascending or descending, and
 * `fill` (dst, byte, count) sets them -- `rep movsd` and `rep stosd` for the
 * whole dwords, leaving the bytes as the byte forms do.
 *
 * `controlWord()` and `statusWord()` answer the x87's control word and its
 * status word (without the stack's top), `setControlWord(word)` loads the
 * control word and `clearExceptions()` clears the exception flags; `mxcsr()`
 * and `setMxcsr(word)` read and load SSE's control and status register: the
 * runtime's own business with the floating-point environment, whose
 * JavaScript reads and writes the words the host's FPU seam keeps.
 *
 * A call to another `@guestCode` function of the module is a call: its code
 * goes into the caller's after it, reached by `call rel32`, and its arguments
 * are pushed as its convention takes them. The first argument is the helpers
 * it takes, as the caller's own names -- `print({ u8, setU8 }, at, count)` --
 * which in JavaScript is the call; the rest are integers, and it answers an
 * integer or nothing. A callee that hands calls to the host has no host of its
 * own inside another function, and a function that calls itself has no end
 * of copies: both are refused.
 *
 * `return host()` hands the call to the host's handler of the same function
 * with the arguments it came with, for a case the function leaves to it --
 * errno to set, a base it does not take: the frame is taken down and the code
 * jumps to the handler's trap -- a `jmp rel32`, or `mov eax, trap; jmp eax`
 * in a function with x87 instructions, the four bytes at the offset `host`
 * names filled in when the export is bound -- so the handler finds the
 * stack, EBX, ESI, EDI and EBP as the caller left them.
 * A parameter such a function assigns is a variable of its own, copied from
 * the argument at entry, so the arguments are still the call's own. Nothing
 * the function wrote before is undone: it goes to the host before it writes.
 * A function with x87 parameters pushes them back as it goes, so the
 * handler finds the x87 stack as the call left it too.
 *
 * Integers are typed as asm.js types them: `|0`, `>>>0` and the bitwise
 * operators bring a value back to 32 bits; `+` and `-` leave a sum that may
 * have left them (an address may take one, as may another sum, a bitwise
 * operator, a table's index or a store), and a comparison, a variable or a
 * result takes it only once it is brought back. A comparison is of two
 * signed or two unsigned values, never one of each; a byte, a 16-bit table
 * entry or a constant below 2^31 compares either way. `*` multiplies by a
 * constant; anything else is `Math.imul`. There is no integer division: `/`
 * of two integers is a double.
 *
 * `++`, `--`, `+=` and `-=` on an integer variable are 32-bit arithmetic:
 * for a counter bounded by a comparison, and a pointer, that is exactly what
 * JavaScript computes; a value that may wrap is written `x = (x + y) | 0`.
 *
 * Doubles are the x87's: `+`, `-`, `*`, `/` and unary `-` are its
 * instructions, `%` its partial remainder until it is whole (JavaScript's
 * exact remainder), `Math.sqrt` `fsqrt`, `Math.sin`, `Math.cos` and
 * `Math.tan` `fsin`, `fcos` and `fptan` (for an argument below 2^63 in
 * magnitude, which the source keeps it to, as it keeps a table's index in
 * range: past it the instruction leaves the argument), `Math.atan2` and
 * `Math.atan` `fpatan`, `Math.log2` `fyl2x` of 1, `Math.abs` `fabs`,
 * `Math.floor`, `Math.ceil` and `Math.trunc` `frndint` under the rounding
 * control they name, `Math.fround` a store to a float and back, and
 * `Number.isNaN` a condition, a double compared with itself. Under
 * a double-precision control word each answers what JavaScript does, as
 * the engines compute the x87 in doubles and its transcendentals through
 * the host's `Math`; under the control word the program set, each rounds as
 * the x87 does -- the arithmetic and the square root to its precision
 * control -- which is how the runtime the program links computes: the
 * compiled code never changes the precision control, and changes the
 * rounding control only around the `frndint` that names one. `Math.exp`,
 * `Math.log`, `Math.log10` and `Math.pow` are no one instruction, and are
 * refused: the x87's sequence for each is not JavaScript's to the last bit
 * under an engine's f64 x87 -- a source writes it with the instructions it
 * is made of, through `X87` (`x87.js`: `X87.f2xm1`, `X87.yl2x`,
 * `X87.scale`, `X87.rint`, `X87.exponent`, `X87.significand` and the
 * constants `fldl2e` and its kin load), whose JavaScript is what the
 * engines compute for each. A constant other than 0 and 1 is read from a
 * table after the code, or pushed when the function has one or two.
 * Integers become doubles exactly, by `+x` or where a double is wanted, and
 * a double becomes an integer by `| 0` or `>>> 0`, JavaScript's modulo 2^32
 * (`fisttp`, and `fprem` by 2^32 past its range). A float is a double a
 * float holds: an `f32` parameter, `f32()`'s load, `Math.fround`'s answer,
 * or a variable given one.
 *
 * Integer variables and parameters live in registers where they pay: the
 * function is compiled twice, the first time to count each variable's uses
 * (a use inside a loop weighing eight times one outside it), the second with
 * the heaviest in registers -- EDX, which costs nothing to take, then EBX,
 * ESI, EDI and EBP, which are saved and put back. A register the code needs for
 * itself is not given: EDX to a variable in scope across a call of the
 * guest (the callee may change it) or in a function that copies, EBX where
 * the function reads a table (its base), ESI and EDI where it copies or
 * fills. EAX and ECX are the expressions' own; a load a variable is given
 * is made into the variable's register. The frame -- the variables left in
 * it, the parameters above it -- is addressed from ESP, the bytes an
 * expression has pushed counted in, so EBP is free to be given; its size and
 * the registers saved above it are what a second compilation found, and a
 * third emits the code. The one x87 parameter of a function that reads it
 * once, before anything else touches the x87 stack or jumps, stays where the
 * caller left it, in ST0, until that read. Doubles and floats live in the
 * frame; an operand there, read through registers alone, or in the table
 * of constants is the arithmetic instruction's memory operand.
 *
 * A module-level constant is folded in. A module-level `Uint8Array`,
 * `Int8Array`, `Uint16Array`, `Int16Array`, `Uint32Array` or `Int32Array`
 * the module exports is a table: its contents when the module is imported
 * are placed after the code and read by index, the index the source's to
 * keep in range. A module-level function of one `return` is inlined, its
 * arguments evaluated once each, in order.
 *
 * Compiled for a 64-bit process (`bits: 64`), a function is x86-64 code
 * under the x64 convention, whatever its tag names: the first four arguments
 * in RCX, RDX, R8 and R9, the rest on the stack past the 32 bytes of home
 * space the caller leaves, the caller taking them down; the result in RAX,
 * an i32 or u32 extended by its sign, as the bridge's trap answers one. The
 * code keeps to the same 32-bit integers, over R8 to R11 as well: an
 * operation on a low half zero-extends into the whole register, so a
 * register the code computed holds an address as it is, and an address of
 * two registers is made into one by a 32-bit `lea` first, which wraps at
 * 2^32 as the helpers' addresses do (a register and a displacement are
 * added in 64 bits, the same sum wherever it lands in the guest's 4 GiB).
 * An argument is read as its low half, whatever the caller left above it.
 *
 * Such code is a leaf where it can be -- no stack moved, nothing its caller
 * keeps changed, which is what an unwinder takes code with no unwind data
 * for. A variable takes EDX or R8 to R11 first, which the convention leaves
 * to the callee (`planLeaf`); then a slot of the home space whose argument
 * went to a register or that no argument has; and only a variable a loop
 * uses past those takes RBX, RSI, RDI or RBP, kept meanwhile in a free home
 * slot or one of R8 to R11 rather than pushed (`placement`). An argument in
 * the frame is read from its home slot, where the entry wrote it whole; and
 * a value an expression holds a while waits in a free register before it is
 * pushed (`hold`). A function that hands calls to the host keeps every
 * argument in its slot, which the hand-over takes them back from before it
 * jumps to the trap. One that calls -- through a pointer or another
 * `@guestCode` function -- is no leaf: it pushes what it keeps, a call
 * being free to change R8 to R11, and passes the arguments in the
 * convention's registers and slots, home space below them and RSP a
 * multiple of 16 at the call, reading the answer's low half.
 *
 * Doubles are SSE2's there, scalar, which is IEEE double's arithmetic to
 * the last bit as JavaScript's is: a double or float argument comes in the
 * XMM register of its place (or its slot past the fourth) and is read from
 * its home slot, the result goes in XMM0 (a float's rounded by `cvtsd2ss`),
 * and the expression's doubles are XMM0 to XMM3 as the x87's stack would be,
 * XMM4 and XMM5 scratch: `+ - * /`, unary `-`, `Math.sqrt` (`sqrtsd`),
 * `Math.abs`, `Math.fround`, `Math.floor`, `Math.ceil` and `Math.trunc`
 * (through a quadword under 2^52, the sign put back), the comparisons
 * (`ucomisd`), `| 0` and `>>> 0` (`cvttsd2si` into RAX, the significand
 * shifted from the bits past 2^63), and the loads and stores. A constant is
 * read RIP-relative from a table after the code. A function with a double
 * argument or result hands nothing to the host: the 64-bit trap carries no
 * XMM register.
 *
 * What only the x87 does -- `%`, `Math.sin` and the other transcendentals,
 * `X87`, x87 arguments, the control and status words, an i64 in EDX:EAX --
 * is refused at 64 bits with its reason (`onRefused`), and the function
 * stays a trap into its handler there.
 */

import * as espree from 'espree';
import {
    ALU, ARGUMENTS_64, Assembler, CC, EAX, EBP, EBX, ECX, EDI, EDX, ESI, ESP, LEGACY_PREFIXES,
    R10, R11, R8, R9, Rex, fitsByte, invert, le32, loadDword, loadQuad, memory, moveRegister,
    moveStack64, storeQuad,
} from './x86.mjs';

/**
 * @typedef {'i32' | 'u32' | 'nat' | 'intish' | 'f64' | 'f32'} Type
 *   nat: an integer the source can see only in [0, 2^31) -- a byte, a 16-bit
 *   table entry, a small constant -- which compares as signed or unsigned
 *   alike; intish: a sum not yet brought back to 32 bits; f32: a double a
 *   float holds exactly
 */

/** @typedef {'i32' | 'u32' | 'f64' | 'f32' | 'x87'} ParamType */
/** @typedef {'i32' | 'u32' | 'f64' | 'f32' | 'i64' | 'void'} ReturnType */

/**
 * @typedef {Object} CompiledFunction
 * @property {string} name
 * @property {'cdecl' | 'stdcall' | 'thiscall'} convention
 * @property {ParamType[]} params   Excluding the guest's helpers.
 * @property {ReturnType} returns
 * @property {string[]} uses        The helpers the first parameter takes, in order.
 * @property {Uint8Array} code
 * @property {number} [host]        Where in the code the jump to the host's handler's
 *                                  trap takes its target, when it returns host():
 *                                  a `jmp rel32`'s displacement, or the address
 *                                  `mov eax` loads for a `jmp eax`, as the byte
 *                                  before says (0xe9 or 0xb8).
 * @property {boolean} [leaf]       x86-64 code only: it moves no stack and changes
 *                                  no register its caller keeps.
 * @property {Record<string, number>} [tables]  Where in the code each table it
 *                                  reads is placed, by name: a binding that
 *                                  writes a table's word after placing the code
 *                                  (the address of something placed at run time)
 *                                  finds it there.
 */

/**
 * @typedef {Object} Variable
 * @property {string} name
 * @property {'i32' | 'u32' | 'nat' | 'f64' | 'f32'} type
 * @property {number} disp     From EBP, for one in the frame.
 * @property {number} [reg]    The register it lives in instead.
 * @property {boolean} mutable
 * @property {any} [key]       The node that declares it: what its uses are counted by.
 * @property {boolean} [onStack]  An x87 parameter left in ST0 until its one read.
 */

/**
 * What the first compilation of a function tells the second.
 *
 * @typedef {Object} Plan
 * @property {Map<any, number>} registers  Each variable given one, by the node declaring it.
 * @property {boolean} keepX87             The x87 parameter stays in ST0 until it is read.
 * @property {Set<any>} assigned           The parameters the body assigns.
 * @property {boolean} pool                Double constants are read from a table after
 *                                         the code (EBX its base), not pushed.
 * @property {boolean} calls               The function calls: x86-64 code keeps nothing
 *                                         a call may change in R8 to R11 then.
 * @property {boolean} tables              It reads a table after the code.
 * @property {boolean} bulk                It copies or fills.
 * @property {number} tableBase            The register a table is read through.
 * @property {Set<any>} homes              x86-64 code's variables kept in the home space.
 * @property {number[]} homeSaves          The home slots left, by argument place, where
 *                                         x86-64 code keeps a register its caller keeps.
 * @property {{ locals: number, saved: number, pushed: boolean }} [frame]
 *     The bytes of variables in the frame and the registers saved above it,
 *     once a compilation with the registers has found them -- pushed there,
 *     or, in x86-64 code that calls nothing, held in R8 to R11 instead.
 */

/**
 * @typedef {{ where: 'imm', type: Type, value: number }
 *     | { where: 'var', type: Type, v: Variable }
 *     | { where: 'eax', type: Type }
 *     | { where: 'st0', type: 'f64' | 'f32' }} Value
 *   imm and var are not yet emitted: an operand the instruction using it
 *   names directly
 */

/**
 * @typedef {Object} TableInfo
 * @property {string} name
 * @property {Uint8Array} bytes
 * @property {1 | 2 | 4 | 8} size
 * @property {boolean} signed
 */

export class GuestCodeError extends Error {
    /** @param {string} message */
    constructor(message){
        super(message);
        this.name = 'GuestCodeError';
    }
}

/** The loads, by helper name: the opcode and what the value is. */
const LOADS = /** @type {Record<string, { op: number[], type: Type }>} */ ({
    u8: { op: [0x0f, 0xb6], type: 'nat' },
    i8: { op: [0x0f, 0xbe], type: 'i32' },
    u16: { op: [0x0f, 0xb7], type: 'nat' },
    i16: { op: [0x0f, 0xbf], type: 'i32' },
    u32: { op: [0x8b], type: 'u32' },
    i32: { op: [0x8b], type: 'i32' },
    f32: { op: [0xd9], type: 'f32' },
    f64: { op: [0xdd], type: 'f64' },
});

/** The stores: the opcode, `mov [m], al/ax/eax` or `fstp dword/qword [m]`. */
const STORES = /** @type {Record<string, number[]>} */ ({
    setU8: [0x88],
    setU16: [0x66, 0x89],
    setU32: [0x89],
    setF32: [0xd9],
    setF64: [0xdd],
});

/** The stores of a double, whose value is popped from ST0. */
const FLOAT_STORES = new Set(['setF32', 'setF64']);

/**
 * The x87's control and status words: `controlWord()` and `statusWord()`
 * answer them (`fnstcw`, `fnstsw` -- the status word without the stack's
 * top, which a function cannot see from its source), `setControlWord(word)`
 * loads the control word (`fldcw`), `clearExceptions()` clears the
 * exception flags (`fnclex`); MXCSR, SSE's, is `mxcsr()` (`stmxcsr`) and
 * `setMxcsr(word)` (`ldmxcsr`).
 */
const X87_WORDS = new Set(['controlWord', 'statusWord', 'setControlWord', 'clearExceptions',
    'mxcsr', 'setMxcsr']);

const HELPERS = new Set([...Object.keys(LOADS), ...Object.keys(STORES),
    'call', 'callStd', 'copyUp', 'copyDown', 'fill', 'host', 'compareExchange', ...X87_WORDS]);

const TABLE_KINDS = /** @type {const} */ ([
    ['Uint8Array', 1, false], ['Int8Array', 1, true], ['Uint16Array', 2, false],
    ['Int16Array', 2, true], ['Uint32Array', 4, false], ['Int32Array', 4, true],
]);

const PARAM_TYPES = new Set(['i32', 'u32', 'f64', 'f32', 'x87']);
const RETURN_TYPES = new Set(['i32', 'u32', 'f64', 'f32', 'i64', 'void']);

/** Rounding control for Math.floor, Math.ceil and Math.trunc, in the control word's high byte. */
const ROUNDING = /** @type {Record<string, number>} */ ({ floor: 0x04, ceil: 0x08, trunc: 0x0c });

/** `Math` functions that are one x87 instruction or two: the bytes after the argument is pushed. */
const MATH_UNARY = /** @type {Record<string, number[]>} */ ({
    sqrt: [0xd9, 0xfa],                  // fsqrt
    sin: [0xd9, 0xfe],                   // fsin
    cos: [0xd9, 0xff],                   // fcos
    tan: [0xd9, 0xf2, 0xdd, 0xd8],       // fptan; fstp st0 (the 1 it pushes)
    atan: [0xd9, 0xe8, 0xd9, 0xf3],      // fld1; fpatan: atan2(x, 1)
});

/** The `Math` functions with no one instruction, and what a source writes instead. */
const MATH_REFUSED = /** @type {Record<string, string>} */ ({
    exp: 'X87.scale(X87.f2xm1(r) + 1, n), the power split at X87.rint',
    log: 'X87.yl2x(X87.LN2, x)',
    log10: 'X87.yl2x(X87.LG2, x)',
    pow: 'X87.yl2x and the power of two, or leaves it to the handler',
});

/** The constants the x87 loads by name, through `X87`: the instruction's second byte. */
const X87_CONSTANTS = /** @type {Record<string, number>} */ ({
    L2T: 0xe9, L2E: 0xea, PI: 0xeb, LG2: 0xec, LN2: 0xed,
});

/** The name of the table of double constants placed after the code. */
const POOL = '$f64';

/** How many x87 registers an expression may hold at once. */
const X87_DEPTH = 7;

/** How many XMM registers an expression may hold at once in x86-64 code: two more are scratch. */
const SSE_DEPTH = 4;

/** The name of the table of quadwords x86-64 code reads RIP-relative: doubles' bits, masks. */
const QUADS = '$q64';

/** A double's bits without the sign, and the sign alone. */
const ABS_MASK = 0x7fff_ffff_ffff_ffffn;
const SIGN_MASK = 0x8000_0000_0000_0000n;

/** A double's bits. @param {number} value */
function doubleBits(value){
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return view.getBigUint64(0, true);
}

/** The registers a callee keeps for its caller, and so saves to use. */
const CALLEE_SAVED = new Set([EBX, ESI, EDI, EBP]);

/**
 * The registers x86-64 code gives a variable for nothing: the x64 convention
 * leaves them to the callee, so a function that keeps to them moves no stack
 * and changes nothing its caller keeps -- what an unwinder takes code with no
 * unwind data for. A call may change them.
 */
const FREE_64 = Object.freeze([EDX, R8, R9, R10, R11]);

/** The registers a callee may change under the x64 convention, besides EAX and ECX. */
const VOLATILE_64 = new Set(FREE_64);

/** The registers that hold what x86-64 code keeps or pushes for a while: R8 to R11. */
const SPARE_64 = Object.freeze([R11, R10, R9, R8]);

/** How much more a use inside a loop weighs than one outside it, per level. */
const LOOP_WEIGHT = 8;

/** @param {number} value @returns {Type} */
function constType(value){
    if (!Number.isInteger(value) || Object.is(value, -0))
    {
        return 'f64';
    }
    if (value >= 0 && value < 2 ** 31)
    {
        return 'nat';
    }
    if (value < 0 && value >= -(2 ** 31))
    {
        return 'i32';
    }
    if (value >= 2 ** 31 && value < 2 ** 32)
    {
        return 'u32';
    }
    return Math.abs(value) < 2 ** 53 ? 'intish' : 'f64';
}

/** Brought back to 32 bits. @param {Type} type */
const isTyped = type=>type === 'i32' || type === 'u32' || type === 'nat';

/** A double or a float. @param {string} type */
const isFloat = type=>type === 'f64' || type === 'f32';

/** The load of a table's entry: `mov`, or `movzx`/`movsx` of its width. @param {TableInfo} table */
const tableOp = table=>(table.size === 4 ? [0x8b]
    : table.size === 2 ? [0x0f, table.signed ? 0xbf : 0xb7] : [0x0f, table.signed ? 0xbe : 0xb6]);

/**
 * `[base + index * size]`'s SIB, of the registers' low three bits.
 *
 * @param {TableInfo} table @param {number} index @param {number} base
 */
const tableSib = (table, index, base)=>(table.size === 1 ? 0 : table.size === 2 ? 1 : 2) << 6
    | (index & 7) << 3 | base & 7;

/** What an entry is. @param {TableInfo} table @returns {Type} */
const tableType = table=>(table.signed ? 'i32' : table.size === 4 ? 'u32' : 'nat');

/**
 * The module's view the compiler needs: what each top-level name is.
 *
 * @typedef {Object} ModuleScope
 * @property {string} file
 * @property {string} text
 * @property {Map<string, number>} constants
 * @property {Map<string, TableInfo>} tables
 * @property {Map<string, any>} inline     name → a function node of one return
 * @property {Map<string, any>} declared   name → its declarator's init, for folding
 * @property {any[]} comments
 * @property {string | null} x87           The name `X87` is imported under, from `x87.js`.
 * @property {Map<any, Set<string>> | null} arithmetic
 *     Each arithmetic node and what it was compiled as: 'rounds' for a double's
 *     `+ - * /` and square root, which precision control rounds, 'integer' for
 *     an integer's -- what the tests' model of the x87 is made from.
 * @property {Map<string, { node: any, doc: string }>} guests  The `@guestCode` functions.
 * @property {(name: string, node: any) => CompiledFunction} compiledOf
 *     A `@guestCode` function compiled, once, for a call to it.
 * @property {32 | 64} bits  i386 code, or x86-64 code under the x64 convention.
 */

/**
 * Compiles every `@guestCode` function of a module.
 *
 * @param {string} text  The module's source.
 * @param {{ file: string, values?: Record<string, unknown>,
 *     arithmetic?: Map<any, Set<string>>, bits?: 32 | 64,
 *     onRefused?: (name: string, reason: string) => void,
 *     refuse?: Readonly<Record<string, string>> }} options
 *     file: named in errors; values: the module's exports as importing it
 *     gives them, where a table's contents come from; arithmetic: where each
 *     arithmetic node is noted (`ModuleScope`), for the tests' model; bits:
 *     the code's, 32 unless 64; onRefused: given, a function the compiler
 *     refuses is left out and named here with the reason, where without it
 *     the refusal is thrown; refuse: functions refused for the reason given,
 *     what the source's contract says and its subset cannot (a pointer laid
 *     out for 32 bits), and every function that calls one
 * @returns {CompiledFunction[]}
 */
export function compileModule(text, { file, values = {}, arithmetic, bits = 32, onRefused,
    refuse = {} })
{
    /** @type {any} */
    let ast;
    try
    {
        ast = espree.parse(text, {
            ecmaVersion: 2022, sourceType: 'module', loc: true, range: true, comment: true,
        });
    }
    catch (e){
        const error = /** @type {any} */ (e);
        throw new GuestCodeError(`${file}:${error.lineNumber}:${error.column}: ${error.message}`);
    }
    /** @type {ModuleScope} */
    const scope = {
        file, text, constants: new Map(), tables: new Map(), inline: new Map(),
        declared: new Map(), comments: ast.comments, x87: null, arithmetic: arithmetic ?? null,
        guests: new Map(), compiledOf: ()=>fail(scope, null, 'no function compiled yet'), bits,
    };
    /** @type {{ node: any, doc: string }[]} */
    const marked = [];
    for (const statement of ast.body)
    {
        const node = statement.type === 'ExportNamedDeclaration' && statement.declaration
            ? statement.declaration : statement;
        if (node.type === 'ImportDeclaration' && /(^|\/)x87\.js$/.test(node.source.value))
        {
            const named = node.specifiers.find((/** @type {any} */ specifier)=>
                specifier.type === 'ImportSpecifier' && specifier.imported.name === 'X87');
            scope.x87 = named?.local.name ?? null;
        }
        else if (node.type === 'VariableDeclaration' && node.kind === 'const')
        {
            for (const declarator of node.declarations)
            {
                if (declarator.id.type !== 'Identifier' || !declarator.init)
                {
                    continue;
                }
                const name = declarator.id.name;
                scope.declared.set(name, declarator.init);
                const init = declarator.init;
                if (init.type === 'ArrowFunctionExpression' && oneReturn(init))
                {
                    scope.inline.set(name, init);
                }
            }
        }
        else if (node.type === 'FunctionDeclaration' && node.id)
        {
            const doc = leadingDoc(scope, statement);
            if (/@guestCode\b/.test(doc))
            {
                marked.push({ node, doc });
            }
            else if (oneReturn(node))
            {
                scope.inline.set(node.id.name, node);
            }
        }
    }
    for (const [name, value] of Object.entries(values))
    {
        const kind = TABLE_KINDS.find(([constructor])=>
            value instanceof /** @type {any} */ (globalThis)[constructor]);
        if (kind && scope.declared.has(name))
        {
            const array = /** @type {ArrayLike<number>} */ (value);
            const [, size, signed] = kind;
            const bytes = new Uint8Array(array.length * size);
            const view = new DataView(bytes.buffer);
            for (let i = 0; i < array.length; i++)
            {
                if (size === 1)
                {
                    view.setUint8(i, array[i] & 0xff);
                }
                else if (size === 2)
                {
                    view.setUint16(i * 2, array[i] & 0xffff, true);
                }
                else
                {
                    view.setUint32(i * 4, array[i] >>> 0, true);
                }
            }
            scope.tables.set(name, { name, bytes, size, signed });
        }
    }
    for (const { node, doc } of marked)
    {
        scope.guests.set(node.id.name, { node, doc });
    }
    /** @type {Map<string, CompiledFunction>} */
    const compiled = new Map();
    /** @type {Set<string>} */
    const compiling = new Set();
    scope.compiledOf = (name, at)=>{
        const done = compiled.get(name);
        if (done)
        {
            return done;
        }
        if (compiling.has(name))
        {
            fail(scope, at, `${name} calls itself, through the functions it calls`);
        }
        const { node, doc } = /** @type {{ node: any, doc: string }} */ (scope.guests.get(name));
        if (Object.hasOwn(refuse, name))
        {
            fail(scope, node, `${name}: ${refuse[name]}`);
        }
        compiling.add(name);
        try
        {
            // Once to count the uses, once with the registers they earn to
            // find the frame that leaves, and once to address it.
            const first = new FunctionCompiler(scope, node, doc, null);
            first.compile();
            const plan = first.plan();
            const second = new FunctionCompiler(scope, node, doc, plan);
            second.compile();
            const made = new FunctionCompiler(scope, node, doc,
                { ...plan, frame: second.frame() }).compile();
            compiled.set(name, made);
            return made;
        }
        finally
        {
            // Refused or made, it is no longer being compiled: a caller met
            // after a refusal is refused for the callee, not for a cycle.
            compiling.delete(name);
        }
    };
    if (!onRefused)
    {
        return marked.map(({ node })=>scope.compiledOf(node.id.name, node));
    }
    /** @type {CompiledFunction[]} */
    const made = [];
    for (const { node } of marked)
    {
        try
        {
            made.push(scope.compiledOf(node.id.name, node));
        }
        catch (e){
            if (!(e instanceof GuestCodeError))
            {
                throw e;
            }
            onRefused(node.id.name, e.message);
        }
    }
    return made;
}

/** A function whose body is a single `return` of an expression, or an expression arrow. @param {any} node */
function oneReturn(node){
    if (node.type === 'ArrowFunctionExpression' && node.expression)
    {
        return true;
    }
    const body = node.body?.body;
    return Array.isArray(body) && body.length === 1 && body[0].type === 'ReturnStatement'
        && body[0].argument !== null;
}

/**
 * The module's tables a function's code holds and where, the constant pools
 * left out (their names are the compiler's own): `{ tables }` where there is
 * one, else nothing.
 *
 * @param {Map<string, number>} placed
 * @returns {{ tables?: Record<string, number> }}
 */
function placedTables(placed){
    const named = [...placed].filter(([name])=>name !== POOL && name !== QUADS);
    return named.length > 0 ? { tables: Object.fromEntries(named) } : {};
}

/**
 * The block comment right before a node, with nothing but white space
 * between, or ''.
 *
 * @param {ModuleScope} scope @param {any} node
 */
function leadingDoc(scope, node){
    const before = scope.comments.filter(comment=>comment.type === 'Block'
        && comment.range[1] <= node.range[0]).pop();
    if (!before || scope.text.slice(before.range[1], node.range[0]).trim() !== '')
    {
        return '';
    }
    return before.value;
}

/**
 * @param {ModuleScope} scope @param {any} node @param {string} message
 * @returns {never}
 */
function fail(scope, node, message){
    const where = node?.loc?.start;
    throw new GuestCodeError(where
        ? `${scope.file}:${where.line}:${where.column + 1}: ${message}`
        : `${scope.file}: ${message}`);
}

class FunctionCompiler {
    /**
     * @param {ModuleScope} scope @param {any} node @param {string} doc
     * @param {Plan | null} planned  Null for the first compilation, which counts.
     */
    constructor(scope, node, doc, planned){
        this.scope = scope;
        this.node = node;
        this.doc = doc;
        /** x86-64 code under the x64 convention. */
        this.long = scope.bits === 64;
        /** The bytes a push moves the stack by, and a stack slot holds. */
        this.word = this.long ? 8 : 4;
        /**
         * The register a table is read through: EBX, which the callee saves;
         * at 64 bits R11, which it need not -- unless the function calls,
         * which may change R11.
         */
        this.tableBase = this.long ? planned?.tableBase ?? R11 : EBX;
        /** The REX bits the instruction being made needs, gathered from its operands (`op`). */
        this.rexBits = 0;
        /**
         * Registers x86-64 code holds a value in for a while instead of
         * pushing it (`hold`): what R8 to R11 the plan left free. None in a
         * function that calls, where a call would change them.
         *
         * @type {number[]}
         */
        this.temps = [];
        /** What `hold` holds, a register or the stack for each, innermost last. @type {number[]} */
        this.held = [];
        /** Whether the code moved RSP for an expression: x86-64 code that does is no leaf. */
        this.pushedAny = false;
        /**
         * The slots of the home space x86-64 code may keep a variable in, by
         * the argument's place: none until the parameters are placed.
         *
         * @type {number[]}
         */
        this.homeFree = [];
        this.a = new Assembler();
        /** @type {Map<string, Variable | { constant: number }>[]} */
        this.scopes = [new Map()];
        this.locals = 0;
        /** @type {Set<number>} */
        this.saves = new Set();
        this.fpu = 0;
        /** Whether the code holds an x87 instruction. */
        this.x87Used = false;
        /** @type {{ breakTo: string, continueTo: string }[]} */
        this.loops = [];
        /** @type {Map<string, TableInfo>} */
        this.tables = new Map();
        /** @type {Set<string>} */
        this.helpers = new Set();
        /** @type {ReturnType} */
        this.returns = 'void';
        this.epilogue = this.a.fresh('epilogue');
        /** Where `return host()` goes: the frame taken down, then the jump. */
        this.toHost = this.a.fresh('host');
        this.hostUsed = false;
        /** @type {Variable[]} */
        this.x87 = [];
        this.inlining = 0;
        this.planned = planned;
        /** @type {Map<any, number>} Each variable's uses, weighed by the loops around them. */
        this.weights = new Map();
        /** @type {Set<any>} The parameters among them, which cost a load to put in a register. */
        this.params = new Set();
        this.depth = 0;
        this.peeking = 0;
        /** The bytes expression code has pushed where the next instruction goes. */
        this.pushed = 0;
        this.calls = false;
        /** @type {Set<string>} The module's `@guestCode` functions this one calls. */
        this.callees = new Set();
        this.bulkUsed = false;
        /** @type {Set<any>} The variables in scope, and those among them a call was made in. */
        this.live = new Set();
        /** @type {Set<any>} */
        this.acrossCalls = new Set();
        /** @type {Set<any>} The variables a byte is stored from, better in a register with one. */
        this.byteStored = new Set();
        /** @type {Set<any>} The parameters the body assigns. */
        this.assigned = new Set();
        /**
         * The load just emitted into EAX, while it is the last instruction:
         * what a store into a register variable can aim at the register.
         *
         * @type {{ item: { bytes: number[] }, at: number, modrm: number, length: number,
         *     count: number }
         *     | null}
         */
        this.loaded = null;
        this.frameUsed = false;
        // The x87 parameter's reads, and whether the one read found it in
        // ST0 with nothing done before -- no double pushed, no jump, no call.
        this.x87Reads = 0;
        this.x87Clean = true;
        this.x87ReadClean = false;
        this.x87Stored = false;
        this.x87Consumed = false;
        /** @type {Set<any>} Every parameter, the x87's among them. */
        this.paramKeys = new Set();
        /** @type {number[]} The double constants of the table after the code. */
        this.pool = [];
        /** @type {bigint[]} The quadwords x86-64 code reads after itself, RIP-relative. */
        this.quads = [];
        /** How many double constants the code loads, a load in a loop weighing more. */
        this.constantLoads = 0;
        /** @type {Map<any, Type>} Each node's type, once asked, outside an inlined body. */
        this.types = new Map();
        for (const reg of planned?.registers.values() ?? [])
        {
            if (CALLEE_SAVED.has(reg))
            {
                this.saves.add(reg);
            }
        }
        if (this.long && planned !== null)
        {
            this.temps = this.placement(planned).temps;
        }
    }

    /**
     * Where x86-64 code keeps what it must give back, by the plan: each
     * register the caller keeps that the code uses, in a slot of the home
     * space the variables left (`{ home }`, by the argument's place) or in
     * one of R8 to R11 they left (`{ reg }`) -- or, in a function that calls,
     * which may change R8 to R11, or where too few places are free, pushed
     * (`keptIn` null) -- and the registers left after that, EDX among them
     * where no variable has it and nothing copies, for the values an
     * expression holds a while (`temps`).
     *
     * @param {Plan} planned
     * @returns {{ kept: number[], keptIn: Map<number, { home?: number, reg?: number }> | null,
     *     temps: number[] }}
     */
    placement(planned){
        const used = new Set(planned.registers.values());
        const kept = [EBX, ESI, EDI, EBP].filter(reg=>used.has(reg)
            || planned.bulk && (reg === ESI || reg === EDI)
            || planned.tables && reg === planned.tableBase);
        const spare = SPARE_64.filter(reg=>!used.has(reg)
            && !(planned.tables && reg === planned.tableBase));
        if (planned.calls)
        {
            return { kept, keptIn: null, temps: [] };
        }
        const edx = used.has(EDX) || planned.bulk ? [] : [EDX];
        /** @type {{ home?: number, reg?: number }[]} */
        const places = [...planned.homeSaves.map(home=>({ home })),
            ...spare.map(reg=>({ reg }))];
        if (kept.length > places.length)
        {
            return { kept, keptIn: null, temps: [...edx, ...spare] };
        }
        const taken = places.slice(0, kept.length);
        return {
            kept,
            keptIn: new Map(kept.map((reg, i)=>[reg, taken[i]])),
            temps: [...edx, ...spare.filter(reg=>!taken.some(place=>place.reg === reg))],
        };
    }

    // --- x86-64 encoding ---------------------------------------------------

    /**
     * A register's low three bits for a field of an instruction, its fourth
     * noted as `bit` of the REX prefix `op` puts before the opcode.
     *
     * @param {number} reg @param {number} bit
     */
    low(reg, bit){
        if (reg >= 8)
        {
            this.rexBits |= bit;
        }
        return reg & 7;
    }

    /** The ModRM of two registers, `field` in its reg field. @param {number} field @param {number} reg */
    regs(field, reg){
        return 0xc0 | this.low(field, Rex.R) << 3 | this.low(reg, Rex.B);
    }

    /**
     * `memory`'s ModRM, SIB and displacement, of registers that may be past
     * the eighth.
     *
     * @param {number} field @param {import('./x86.mjs').Memory} operand
     * @returns {number[]}
     */
    mem(field, operand){
        const { base, index } = operand;
        return memory(this.low(field, Rex.R), { ...operand, base: this.low(base, Rex.B),
            ...index === undefined ? {} : { index: this.low(index, Rex.X) } });
    }

    /**
     * Emits one instruction whose operands were made by `low`, `regs`, `mem`
     * or `rm`: its REX prefix, where they named a register past the eighth,
     * after its legacy prefixes. The same bytes as `emit` at 32 bits.
     *
     * @param {...number} bytes
     */
    op(...bytes){
        const rex = this.rexBits;
        this.rexBits = 0;
        if (rex === 0)
        {
            return this.a.emit(...bytes);
        }
        let at = 0;
        while (LEGACY_PREFIXES.has(bytes[at]))
        {
            at++;
        }
        return this.a.emit(...bytes.slice(0, at), Rex.PREFIX | rex, ...bytes.slice(at));
    }

    /**
     * Keeps EAX while an expression is made: pushed, or in x86-64 code that
     * calls nothing, in a register no variable has, where one is free -- RSP
     * left where it is.
     */
    hold(){
        const reg = this.temps.find(temp=>!this.held.includes(temp));
        if (reg === undefined)
        {
            this.a.emit(0x50);                                             // push eax
            this.grew(this.word);
            this.pushedAny = true;
            this.held.push(-1);
            return;
        }
        this.op(0x89, this.regs(EAX, reg));                                // mov reg, eax
        this.held.push(reg);
    }

    /** What `hold` kept last, into EAX, ECX, ESI or EDI. @param {number} reg */
    unhold(reg){
        const from = /** @type {number} */ (this.held.pop());
        if (from < 0)
        {
            this.a.emit(0x58 | reg);                                       // pop reg
            this.grew(-this.word);
            return;
        }
        this.op(0x89, this.regs(from, reg));                               // mov reg, from
    }

    /** @param {any} node @param {string} message @returns {never} */
    fail(node, message){
        return fail(this.scope, node, message);
    }

    /** @returns {CompiledFunction} */
    compile(){
        const { node, doc } = this;
        const name = node.id.name;
        const convention = /@guestCode\s+(cdecl|stdcall|thiscall)\b/.exec(doc)?.[1];
        if (convention !== 'cdecl' && convention !== 'stdcall' && convention !== 'thiscall')
        {
            this.fail(node, `${name}: @guestCode names its convention, cdecl, stdcall or `
                + 'thiscall');
        }
        if (node.async || node.generator)
        {
            this.fail(node, `${name}: not an async function or a generator`);
        }
        /** @type {Map<string, string>} */
        const declared = new Map();
        for (const [, type, param] of doc.matchAll(/@param\s+\{(\w+)\}\s+(\w+)/g))
        {
            declared.set(param, type);
        }
        const returned = /@returns?\s+\{(\w+)\}/.exec(doc)?.[1] ?? 'void';
        if (!RETURN_TYPES.has(returned))
        {
            this.fail(node, `${name}: @returns {${returned}} is not i32, u32, f64, f32, i64 `
                + 'or void');
        }
        this.returns = /** @type {ReturnType} */ (returned);

        const params = [...node.params];
        /** @type {string[]} */
        const uses = [];
        if (params[0]?.type === 'ObjectPattern')
        {
            for (const property of params[0].properties)
            {
                if (property.type !== 'Property' || !property.shorthand
                    || property.key.type !== 'Identifier' || !HELPERS.has(property.key.name))
                {
                    this.fail(property, `the guest's helpers are ${[...HELPERS].join(', ')}, `
                        + 'taken by name');
                }
                uses.push(property.key.name);
                this.helpers.add(property.key.name);
                if (this.long && X87_WORDS.has(property.key.name))
                {
                    this.fail(property, `${property.key.name}: the x87's control and status `
                        + 'words are the 32-bit runtime\'s, refused at 64 bits');
                }
                if (this.long && property.key.name === 'compareExchange')
                {
                    this.fail(property, 'compareExchange: the 32-bit kernel\'s exchange of a '
                        + 'word, refused at 64 bits');
                }
            }
            params.shift();
        }
        if (this.long && this.returns === 'i64')
        {
            this.fail(node, `${name}: an i64 is EDX:EAX at 32 bits, refused at 64 bits`);
        }
        const doubleParam = params.some(param=>isFloat(declared.get(param.name) ?? ''));
        if (this.long && this.helpers.has('host') && (isFloat(this.returns) || doubleParam))
        {
            // The trap of a 64-bit process reads RCX, RDX, R8, R9 and the
            // stack, and answers RAX: a double's XMM register it neither reads
            // nor writes.
            this.fail(node, `${name}: a double in an XMM register is no argument or answer the `
                + '64-bit trap carries, so the function has no host to hand over to at 64 bits');
        }
        /** @type {ParamType[]} */
        const types = [];
        /** @type {Variable[]} */
        const x87 = [];
        /** @type {Variable[]} */
        const inRegisters = [];
        /**
         * The parameters copied into variables of their own at entry.
         *
         * @type {{ from: number, to: Variable, size: number }[]}
         */
        const copies = [];
        /** @type {Variable[]} The slots the x87 parameters are popped into, first first. */
        const x87Popped = [];
        /** @type {{ from: Variable, to: Variable }[]} */
        const x87Copies = [];
        // Each parameter's place as EBP (RBP) would name it: past the saved
        // frame pointer and the return address.
        let stack = this.word * 2;
        for (const param of params)
        {
            if (param.type !== 'Identifier')
            {
                this.fail(param, 'a parameter is a name');
            }
            const type = declared.get(param.name);
            if (type === undefined || !PARAM_TYPES.has(type))
            {
                this.fail(param, `@param {i32 | u32 | f64 | f32 | x87} ${param.name} is wanted`);
            }
            if (this.long && type === 'x87')
            {
                this.fail(param, `${param.name}: an x87 argument is the 32-bit convention's, `
                    + 'refused at 64 bits');
            }
            types.push(/** @type {ParamType} */ (type));
            this.paramKeys.add(param);
            if (type === 'x87')
            {
                /** @type {Variable} */
                const v = this.planned?.keepX87
                    ? { name: param.name, type: 'f64', disp: 0, mutable: true, key: param,
                        onStack: true }
                    : this.newVariable(param.name, 'f64', true, param);
                if (!v.onStack && this.helpers.has('host') && this.planned?.assigned.has(param))
                {
                    // Popped into a slot of its own, which a call handed to
                    // the host pushes back as it came.
                    const popped = this.newVariable(param.name, 'f64', false, {});
                    x87Copies.push({ from: popped, to: v });
                    x87Popped.push(popped);
                }
                else if (!v.onStack)
                {
                    x87Popped.push(v);
                }
                this.bind(param, v);
                x87.push(v);
                this.x87.push(v);
                continue;
            }
            /** @type {Variable} */
            const v = { name: param.name, type: /** @type {'i32' | 'u32' | 'f64' | 'f32'} */ (type),
                disp: stack, mutable: true, key: param };
            const reg = isFloat(type) ? undefined : this.planned?.registers.get(param);
            if (reg !== undefined)
            {
                v.reg = reg;
                inRegisters.push(v);
            }
            else if (this.helpers.has('host') && this.planned?.assigned.has(param))
            {
                // The trap hands the handler the arguments the call came
                // with: a parameter the body assigns is a variable of its
                // own, not the caller's slot. One in a register already is.
                this.params.add(param);
                const own = this.newVariable(param.name, v.type, true, param);
                copies.push({ from: stack, to: own, size: type === 'f64' ? 8 : 4 });
                this.bind(param, own);
                stack += this.long || type === 'f64' ? 8 : 4;
                continue;
            }
            this.params.add(param);
            this.live.add(param);
            this.bind(param, v);
            // A quadword a slot at 64 bits, whatever the value in its low half.
            stack += this.long || type === 'f64' ? 8 : 4;
        }
        if (x87.some(v=>v.onStack))
        {
            this.fpu = 1;
        }
        if (this.long)
        {
            // The home space the caller left for the register arguments is
            // the callee's: a slot whose argument went to a register, or that
            // no argument has, holds a variable above RSP, which stays put.
            // A hand-over takes the arguments back from their slots.
            const inRegister = new Set(inRegisters.map(v=>v.disp));
            this.homeFree = [0, 1, 2, 3].filter(i=>i >= params.length
                || !this.helpers.has('host') && inRegister.has(16 + 8 * i));
        }

        this.statements(node.body.body);
        if (this.returns !== 'void' && !ends(node.body))
        {
            this.fail(node.body, `${name} can reach its end without a return`);
        }
        const last = this.a.items[this.a.items.length - 1];
        if (last?.kind === 'jump' && last.cc < 0 && last.to === this.epilogue)
        {
            this.a.items.pop();
        }

        this.checkPlan();
        const out = new Assembler();
        const saved = [EBX, ESI, EDI, EBP].filter(reg=>this.saves.has(reg));
        const planned = this.planned?.frame;
        if (planned && (planned.locals !== this.locals || planned.saved !== saved.length
            || planned.pushed !== this.frame().pushed))
        {
            throw new Error(`guest code: ${name}'s frame is not the one it was addressed as`);
        }
        if (this.long)
        {
            return this.finishLong({ name, convention, types, uses, inRegisters, copies,
                count: (stack - 16) / 8, saved });
        }
        if (convention === 'thiscall')
        {
            out.emit(0x58, 0x51, 0x50);   // pop eax; push ecx; push eax: `this` the first argument
        }
        // The saved registers, then the variables below them: the frame from
        // ESP up, the parameters above the return address.
        for (const reg of saved)
        {
            out.emit(0x50 | reg);
        }
        if (this.locals > 0)
        {
            out.emit(...fitsByte(this.locals)
                ? [0x83, 0xec, this.locals] : [0x81, 0xec, ...le32(this.locals)]);
        }
        // A call to the next instruction pushes the address every table is
        // reached from. Where the x87 stack is deeper or shallower at the
        // return than at the call, the translator takes a call it cannot
        // follow back for one that returns there (it stops at the pop, every
        // time), and the address comes from a call to a routine that returns.
        const thunk = this.tables.size > 0
            && x87.length !== (isFloat(this.returns) ? 1 : 0);
        if (thunk)
        {
            out.call('pc').label('picBase');
        }
        else if (this.tables.size > 0)
        {
            out.emit(0xe8, 0, 0, 0, 0).label('picBase').emit(0x5b);
        }
        for (const v of inRegisters)
        {
            out.emit(0x8b, ...memory(/** @type {number} */ (v.reg), {    // mov reg, the parameter
                base: ESP, disp: this.locals + saved.length * 4 + v.disp - 4 }));
        }
        for (const { from, to, size } of copies)
        {
            for (let at = 0; at < size; at += 4)
            {
                // mov eax, the argument; mov the variable, eax
                out.emit(0x8b, ...memory(EAX, {
                    base: ESP, disp: this.locals + saved.length * 4 + from - 4 + at }));
                out.emit(0x89, ...memory(EAX, { base: ESP, disp: this.locals + to.disp + at }));
            }
        }
        // The last x87 parameter is ST0: each popped into its slot, but one
        // read where it is.
        for (const v of [...x87Popped].reverse())
        {
            out.emit(0xdd, ...memory(3, { base: ESP, disp: this.locals + v.disp }));
        }
        for (const { from, to } of x87Copies)
        {
            out.emit(0xdd, ...memory(0, { base: ESP, disp: this.locals + from.disp }));
            out.emit(0xdd, ...memory(3, { base: ESP, disp: this.locals + to.disp }));
        }
        out.append(this.a);
        /** The frame taken down: ESP and the saved registers as the caller left them. */
        const takeDown = ()=>{
            if (this.locals > 0)
            {
                out.emit(...fitsByte(this.locals)
                    ? [0x83, 0xc4, this.locals] : [0x81, 0xc4, ...le32(this.locals)]);
            }
            for (const reg of [...saved].reverse())
            {
                out.emit(0x58 | reg);
            }
        };
        out.label(this.epilogue);
        takeDown();
        const argBytes = stack - 8;
        if (convention !== 'cdecl' && argBytes > 0)
        {
            out.emit(0xc2, argBytes & 0xff, argBytes >>> 8);  // ret argBytes
        }
        else
        {
            out.emit(0xc3);
        }
        if (this.hostUsed)
        {
            out.label(this.toHost);
            // The x87 parameters back where the call left them, the last in ST0.
            for (const v of x87Popped)
            {
                out.emit(0xdd, ...memory(0, { base: ESP, disp: this.locals + v.disp }));
            }
            takeDown();
            if (this.x87Used || this.x87.length > 0)
            {
                // Through a register: cork follows a direct jump into the
                // trap's stub, and a region with x87 instructions leaves to
                // its host's loop for the trap; after `jmp eax` the stub is a
                // region of its own, which calls the trap from its code.
                out.emit(0xb8).label('hostJump').emit(0, 0, 0, 0);   // mov eax, the trap
                out.emit(0xff, 0xe0);                                // jmp eax
            }
            else
            {
                out.emit(0xe9).label('hostJump').emit(0, 0, 0, 0);   // jmp the handler's trap
            }
        }
        if (thunk)
        {
            out.label('pc').emit(0x8b, 0x1c, 0x24, 0xc3);        // mov ebx, [esp]; ret
        }
        // Each function called, whole -- its own tables after it, reached from
        // its own code -- where its calls reach it.
        for (const callee of this.callees)
        {
            out.label(`fn:${callee}`).emit(...this.scope.compiledOf(callee, node).code);
        }
        const tables = [...this.tables.values()].map(table=>({
            name: table.name,
            bytes: table.name === POOL
                ? new Uint8Array(Float64Array.from(this.pool).buffer) : table.bytes,
            align: table.size,
        }));
        const code = out.finish(tables);
        return {
            name, convention, params: types, returns: this.returns, uses, code,
            ...this.hostUsed ? { host: /** @type {number} */ (out.offsets.get('hostJump')) } : {},
            ...placedTables(out.placed),
        };
    }

    /**
     * The x86-64 function around the body this compilation made: the register
     * arguments written into their home space, the registers a callee keeps
     * saved, the frame below them, and the two ways out -- the return, and
     * the jump to the host's trap with everything back where the call left it.
     *
     * @param {{ name: string, convention: CompiledFunction['convention'],
     *     types: ParamType[], uses: string[], inRegisters: Variable[],
     *     copies: { from: number, to: Variable, size: number }[], count: number,
     *     saved: number[] }} parts
     *     count: the parameters; saved: the registers kept for the caller, in order
     * @returns {CompiledFunction}
     */
    finishLong({ name, convention, types, uses, inRegisters, copies, count, saved }){
        const out = new Assembler();
        const { pushed } = this.frame();
        // The first compilation, which only counts, has no plan to place by.
        const { kept, keptIn } = this.planned === null ? { kept: saved, keptIn: null }
            : this.placement(this.planned);
        if (kept.join() !== saved.join())
        {
            throw new Error(`guest code: ${name} keeps registers its plan did not place`);
        }
        const inRegisterArguments = Math.min(count, ARGUMENTS_64.length);
        /** The parameters given registers, by their place in the list. */
        const byIndex = new Map(inRegisters.map(v=>[(v.disp - 16) / 8, v]));
        // Whole into the home space, each register argument the frame reads
        // where it is, or a hand-over takes back as it came.
        // A double comes in the XMM register of its place, and is read from
        // its slot: movsd, or movss, a float's.
        for (let i = 0; i < inRegisterArguments; i++)
        {
            if (isFloat(types[i]))
            {
                out.emit(types[i] === 'f64' ? 0xf2 : 0xf3, 0x0f, 0x11,
                    ...memory(i, { base: ESP, disp: 8 + 8 * i }));
            }
            else if (this.hostUsed || !byIndex.has(i))
            {
                out.emit(...storeQuad(ARGUMENTS_64[i], 8 + 8 * i));       // mov [rsp+8+8i], arg
            }
        }
        if (pushed)
        {
            for (const reg of saved)
            {
                out.emit(0x50 | reg);                                      // push reg
            }
        }
        for (const [reg, { home }] of keptIn ?? [])
        {
            if (home !== undefined)
            {
                out.emit(...storeQuad(reg, 8 + 8 * home));                // mov [rsp+8+8i], reg
            }
        }
        // The register arguments into their variables' registers, and the
        // registers the caller keeps into the free ones that hold them, as one
        // move: R8 and R9 are arguments until they are read.
        /** @type {{ from: number, to: number, quad: boolean }[]} */
        const moves = [];
        for (const [i, v] of byIndex)
        {
            if (i < ARGUMENTS_64.length)
            {
                moves.push({ from: ARGUMENTS_64[i], to: /** @type {number} */ (v.reg), quad: false });
            }
        }
        for (const [reg, { reg: into }] of keptIn ?? [])
        {
            if (into !== undefined)
            {
                moves.push({ from: reg, to: into, quad: true });
            }
        }
        out.emit(...parallelMove(moves));
        if (this.locals > 0)
        {
            out.emit(...moveStack64(-this.locals));
        }
        if (this.tables.size > 0)
        {
            // lea r11, [rip]: the address every table is reached from.
            out.emit(0x48 | (this.tableBase >= 8 ? Rex.R : 0), 0x8d,
                0x05 | (this.tableBase & 7) << 3, 0, 0, 0, 0).label('picBase');
        }
        for (const [i, v] of byIndex)
        {
            if (i >= ARGUMENTS_64.length)
            {
                out.emit(...loadDword(/** @type {number} */ (v.reg), this.paramAt(v.disp)));
            }
        }
        for (const { from, to, size } of copies)
        {
            for (let at = 0; at < size; at += 4)
            {
                // mov eax, the argument; mov the variable, eax
                out.emit(0x8b, ...memory(EAX, { base: ESP, disp: this.paramAt(from) + at }));
                out.emit(0x89, ...memory(EAX, { base: ESP, disp: this.locals + to.disp + at }));
            }
        }
        out.append(this.a);
        /** RSP and the kept registers as the caller left them. */
        const takeDown = ()=>{
            if (this.locals > 0)
            {
                out.emit(...moveStack64(this.locals));
            }
            if (pushed)
            {
                for (const reg of [...saved].reverse())
                {
                    out.emit(0x58 | reg);                                  // pop reg
                }
            }
            for (const [reg, { home, reg: into }] of keptIn ?? [])
            {
                out.emit(...into !== undefined ? moveRegister(reg, into, true)
                    : loadQuad(reg, 8 + 8 * /** @type {number} */ (home)));
            }
        };
        out.label(this.epilogue);
        takeDown();
        if (this.returns === 'i32' || this.returns === 'u32')
        {
            // cdqe: the answer the trap gives, a dword extended by its sign.
            out.emit(0x48, 0x98);
        }
        out.emit(0xc3);
        if (this.hostUsed)
        {
            out.label(this.toHost);
            takeDown();
            for (let i = 0; i < inRegisterArguments; i++)
            {
                out.emit(...loadQuad(ARGUMENTS_64[i], 8 + 8 * i));        // mov arg, [rsp+8+8i]
            }
            out.emit(0xe9).label('hostJump').emit(0, 0, 0, 0);       // jmp the handler's trap
        }
        for (const callee of this.callees)
        {
            out.label(`fn:${callee}`).emit(...this.scope.compiledOf(callee, this.node).code);
        }
        const quads = new DataView(new ArrayBuffer(this.quads.length * 8));
        this.quads.forEach((bits, i)=>quads.setBigUint64(i * 8, bits, true));
        const code = out.finish([...this.tables.values()].map(table=>({
            name: table.name, bytes: table.bytes, align: table.size,
        })).concat(this.quads.length === 0 ? []
            : [{ name: QUADS, bytes: new Uint8Array(quads.buffer), align: 8 }]));
        if (this.rexBits !== 0)
        {
            throw new Error(`guest code: ${name} left a REX prefix unplaced`);
        }
        if (this.x87Used)
        {
            // Every use of a double at 64 bits is SSE2's or refused: an x87
            // instruction here would round under a control word no x64
            // caller sets for it.
            throw new Error(`guest code: ${name}'s x86-64 holds an x87 instruction`);
        }
        return {
            name, convention, params: types, returns: this.returns, uses, code,
            ...this.hostUsed ? { host: /** @type {number} */ (out.offsets.get('hostJump')) } : {},
            ...placedTables(out.placed),
            // No stack moved and nothing the caller keeps changed: what an
            // unwinder with no unwind data for the code takes it to be.
            leaf: saved.length === 0 && this.locals === 0 && !this.pushedAny && !this.calls,
        };
    }

    /**
     * A parameter's offset from ESP (RSP) once the frame is made, nothing
     * pushed below it: past the variables, the registers saved on the stack
     * and the return address.
     *
     * @param {number} disp  As EBP (RBP) names it.
     */
    paramAt(disp){
        const { locals, saved, pushed } = this.planned?.frame ?? this.frame();
        return locals + (pushed ? saved * this.word : 0) + disp - this.word;
    }

    // --- names -----------------------------------------------------------

    /** @param {any} node @param {Variable | { constant: number }} what */
    bind(node, what){
        if (this.lookupLocal(node.name) !== undefined)
        {
            this.fail(node, `${node.name} is declared twice`);
        }
        this.scopes[this.scopes.length - 1].set(node.name, what);
    }

    /**
     * A variable of this scope: in the register the plan gives it, or in the frame.
     *
     * @param {any} node @param {string} name @param {Variable['type']} type
     * @param {boolean} mutable
     */
    declare(node, name, type, mutable){
        const top = this.scopes[this.scopes.length - 1];
        if (this.lookupLocal(name) !== undefined)
        {
            this.fail(node, `${name} is declared twice`);
        }
        const v = this.newVariable(name, type, mutable, node);
        top.set(name, v);
        return v;
    }

    /**
     * A variable bound to no name yet, placed.
     *
     * @param {string} name @param {Variable['type']} type @param {boolean} mutable
     * @param {any} key  The node it is counted and planned by.
     * @returns {Variable}
     */
    newVariable(name, type, mutable, key){
        this.live.add(key);
        const reg = isFloat(type) ? undefined : this.planned?.registers.get(key);
        if (reg !== undefined)
        {
            return { name, type, disp: 0, reg, mutable, key };
        }
        const home = this.planned?.homes.has(key) ? this.homeFree.shift() : undefined;
        if (home !== undefined)
        {
            // Named as the argument in that slot would be.
            return { name, type, disp: 16 + 8 * home, mutable, key };
        }
        const size = type === 'f64' ? 8 : 4;
        this.locals = Math.ceil((this.locals + size) / size) * size;
        return { name, type, disp: -this.locals, mutable, key };
    }

    // --- registers -------------------------------------------------------

    /**
     * Counts a use of a variable, the first time through.
     *
     * @param {Variable} v
     */
    use(v){
        if (this.planned === null && this.peeking === 0 && v.key !== undefined)
        {
            this.weights.set(v.key, (this.weights.get(v.key) ?? 0)
                + LOOP_WEIGHT ** Math.min(this.depth, 6));
        }
    }

    /**
     * The ModRM (and displacement) naming a variable, with `field` in the reg
     * field: its register, or its slot in the frame.
     *
     * @param {number} field @param {Variable} v
     * @returns {number[]}
     */
    rm(field, v){
        this.use(v);
        return v.reg !== undefined ? [this.regs(field, v.reg)] : this.frameAt(field, v.disp);
    }

    /**
     * A variable or parameter in the frame, from ESP: `disp` below the frame's
     * top for a variable, above the return address (less a word) for a
     * parameter, as EBP would have named them.
     *
     * @param {number} field @param {number} disp
     */
    frameAt(field, disp){
        this.frameUsed = true;
        const { locals, saved, pushed } = this.planned?.frame
            ?? { locals: 0, saved: 0, pushed: true };
        const offset = disp < 0 ? locals + disp
            : locals + (pushed ? saved * this.word : 0) + disp - this.word;
        return this.mem(field, { base: ESP, disp: this.pushed + offset });
    }

    /**
     * What this compilation left in the frame, and saved above it: on the
     * stack, but in x86-64 code that calls nothing, whose registers to keep
     * wait in R8 to R11.
     */
    frame(){
        return {
            locals: this.locals,
            saved: [EBX, ESI, EDI, EBP].filter(reg=>this.saves.has(reg)).length,
            pushed: !this.long || this.planned === null
                || this.placement(this.planned).keptIn === null,
        };
    }

    /** Expression code pushed (or popped, negative) `bytes`. @param {number} bytes */
    grew(bytes){
        this.pushed += bytes;
    }

    /** The register a node names, when it is a variable that has one. @param {any} node */
    registerOf(node){
        const value = this.simple(node);
        return value?.where === 'var' ? value.v.reg : undefined;
    }

    /**
     * What the first compilation found: the variables that earn a register,
     * heaviest first, each given the cheapest one still free that its uses
     * pay for, and whether the x87 parameter can stay where it is.
     *
     * @returns {Plan}
     */
    plan(){
        /** @type {{ reg: number, cost: number }[]} */
        const free = [];
        const pool = this.constantLoads > 2;
        // A table is read through R11 at 64 bits, or EBX where a call may change R11.
        const tableBase = this.long && !this.calls ? R11 : EBX;
        const tables = this.tables.size > 0;
        if (this.long)
        {
            // The convention's volatile registers first, which cost nothing
            // to take; the kept ones after them, which cost their saving.
            for (const reg of FREE_64)
            {
                if (!(reg === EDX && this.bulkUsed) && !(reg === tableBase && tables))
                {
                    free.push({ reg, cost: 0 });
                }
            }
            if (!this.bulkUsed)
            {
                free.push({ reg: ESI, cost: 2 }, { reg: EDI, cost: 2 });
            }
            if (!(tableBase === EBX && tables))
            {
                free.push({ reg: EBX, cost: 2 });
            }
            free.push({ reg: EBP, cost: 2 });
        }
        else
        {
            if (!this.bulkUsed)
            {
                free.push({ reg: EDX, cost: 0 });
            }
            if (this.tables.size === 0 && !pool)
            {
                free.push({ reg: EBX, cost: 2 });
            }
            if (!this.bulkUsed)
            {
                free.push({ reg: ESI, cost: 2 }, { reg: EDI, cost: 2 });
            }
            free.push({ reg: EBP, cost: 2 });
        }
        /** @type {Map<any, number>} */
        const registers = new Map();
        const heaviest = [...this.weights].sort((left, right)=>right[1] - left[1]);
        const homes = this.long && !this.calls ? this.planLeaf(heaviest, free, registers)
            : new Set();
        for (const [key, weight] of this.long && !this.calls ? [] : heaviest)
        {
            const load = this.params.has(key) ? 1 : 0;
            const at = free.findIndex(({ reg, cost })=>weight > cost + load
                && (!this.volatile(reg) || !this.acrossCalls.has(key)));
            if (at >= 0)
            {
                registers.set(key, free[at].reg);
                free.splice(at, 1);
            }
        }
        return {
            registers: this.arrange(registers),
            keepX87: this.x87.length === 1 && this.x87Reads === 1 && this.x87ReadClean
                && !this.x87Stored && !this.hostUsed,
            assigned: this.assigned,
            pool,
            calls: this.calls,
            tables,
            bulk: this.bulkUsed,
            tableBase,
            homes,
            // The home slots the variables leave, where the kept registers wait.
            homeSaves: this.homeSlots(registers).slice(homes.size),
        };
    }

    /**
     * The registers of x86-64 code that calls nothing, dealt so that it
     * stays a leaf where it can: the variables that pay for one by weight
     * take the volatile registers; the rest are kept in the slots of the home
     * space no argument holds (`homeFree`), a parameter in its own; and only
     * the heaviest of those past that take a register the caller keeps.
     *
     * @param {[any, number][]} heaviest  Each variable's weight, heaviest first.
     * @param {{ reg: number, cost: number }[]} free  Volatile first, as `plan` lists them.
     * @param {Map<any, number>} registers  Filled.
     */
    planLeaf(heaviest, free, registers){
        const volatile = free.filter(({ reg })=>this.volatile(reg));
        const kept = free.filter(({ reg })=>!this.volatile(reg));
        for (const [key, weight] of heaviest)
        {
            if (volatile.length > 0 && weight > (this.params.has(key) ? 1 : 0))
            {
                registers.set(key, /** @type {{ reg: number }} */ (volatile.shift()).reg);
            }
        }
        // A variable a loop uses is worth a register the caller keeps, saved
        // once a call; one it does not, a slot of memory.
        for (const [key, weight] of heaviest)
        {
            const load = this.params.has(key) ? 1 : 0;
            if (!registers.has(key) && weight >= LOOP_WEIGHT && kept.length > 0
                && weight > kept[0].cost + load)
            {
                registers.set(key, /** @type {{ reg: number }} */ (kept.shift()).reg);
            }
        }
        const homes = new Set();
        const slots = this.homeSlots(registers);
        for (const [key, weight] of heaviest)
        {
            if (registers.has(key) || this.params.has(key))
            {
                continue;
            }
            if (homes.size < slots.length)
            {
                homes.add(key);
            }
            else if (kept.length > 0 && weight > kept[0].cost)
            {
                registers.set(key, /** @type {{ reg: number }} */ (kept.shift()).reg);
            }
        }
        return homes;
    }

    /**
     * The slots of the home space that x86-64 code may use, by the
     * argument's place: those that no argument has, and those whose argument
     * is in a register by the plan -- unless a hand-over takes the arguments
     * back from there.
     *
     * @param {Map<any, number>} registers
     */
    homeSlots(registers){
        if (!this.long)
        {
            return [];
        }
        const params = [...this.paramKeys];
        return [0, 1, 2, 3].filter(i=>i >= params.length
            || !this.helpers.has('host') && registers.has(params[i]));
    }

    /**
     * Whether a call may change a register: EDX among those a variable is
     * given, and at 64 bits R8 to R11 too.
     *
     * @param {number} reg
     */
    volatile(reg){
        return this.long ? VOLATILE_64.has(reg) : reg === EDX;
    }

    /**
     * The same registers dealt again so that a variable a byte is stored from
     * has one with a low byte (EDX or EBX; ESI, EDI and EBP have none -- at 64
     * bits R8 to R11 have theirs too), the others taking ESI, EDI and EBP
     * first -- R8 to R11 at 64 bits -- and no register a call may change to a
     * variable in scope across a call. As they were, when that cannot be done.
     *
     * @param {Map<any, number>} registers
     */
    arrange(registers){
        const pool = new Set(registers.values());
        const order = [...registers.keys()].sort((left, right)=>
            Number(this.acrossCalls.has(right)) - Number(this.acrossCalls.has(left)));
        /** @type {Map<any, number>} */
        const dealt = new Map();
        for (const key of order)
        {
            const preference = this.long
                ? this.byteStored.has(key) ? [EDX, R8, R9, R10, R11, EBX, ESI, EDI, EBP]
                    : [R8, R9, R10, R11, EDX, ESI, EDI, EBP, EBX]
                : this.byteStored.has(key) ? [EDX, EBX, ESI, EDI, EBP]
                    : [ESI, EDI, EBP, EBX, EDX];
            const reg = preference.find(candidate=>pool.has(candidate)
                && (!this.volatile(candidate) || !this.acrossCalls.has(key)));
            if (reg === undefined)
            {
                return registers;
            }
            dealt.set(key, reg);
            pool.delete(reg);
        }
        return dealt;
    }

    /** The second compilation keeps the registers it was planned with to itself. */
    checkPlan(){
        const registers = this.planned?.registers ?? new Map();
        const used = new Set(registers.values());
        const clash = this.bulkUsed && used.has(EDX)
            || [...registers].some(([key, reg])=>this.volatile(reg) && this.acrossCalls.has(key))
            || this.tables.size > 0 && used.has(this.tableBase)
            || this.bulkUsed && (used.has(ESI) || used.has(EDI));
        if (clash)
        {
            throw new Error(`guest code: ${this.node.id.name} was planned a register its code `
                + 'needs for itself');
        }
    }

    /** @param {string} name */
    lookupLocal(name){
        for (let i = this.scopes.length - 1; i >= 0; i--)
        {
            const found = this.scopes[i].get(name);
            if (found !== undefined)
            {
                return found;
            }
        }
        return undefined;
    }

    /**
     * A module-level constant's value, folded from its declaration.
     *
     * @param {string} name @param {Set<string>} [seen]
     * @returns {number | undefined}
     */
    moduleConstant(name, seen = new Set()){
        if (this.scope.constants.has(name))
        {
            return this.scope.constants.get(name);
        }
        const init = this.scope.declared.get(name);
        if (init === undefined || seen.has(name))
        {
            return undefined;
        }
        seen.add(name);
        const value = this.fold(init, seen);
        if (value !== undefined)
        {
            this.scope.constants.set(name, value);
        }
        return value;
    }

    /**
     * A constant expression's value, or undefined when it is not one.
     *
     * @param {any} node @param {Set<string>} [seen]
     * @returns {number | undefined}
     */
    fold(node, seen = new Set()){
        switch (node.type)
        {
            case 'Literal':
                return typeof node.value === 'number' ? node.value : undefined;
            case 'Identifier':
            {
                const local = this.lookupLocal(node.name);
                if (local !== undefined)
                {
                    return 'constant' in local ? local.constant : undefined;
                }
                return this.moduleConstant(node.name, seen);
            }
            case 'UnaryExpression':
            {
                const value = this.fold(node.argument, seen);
                if (value === undefined)
                {
                    return undefined;
                }
                switch (node.operator)
                {
                    case '-': return -value;
                    case '+': return value;
                    case '~': return ~value;
                    default: return undefined;
                }
            }
            case 'BinaryExpression':
            {
                const left = this.fold(node.left, seen);
                const right = left === undefined ? undefined : this.fold(node.right, seen);
                if (left === undefined || right === undefined)
                {
                    return undefined;
                }
                switch (node.operator)
                {
                    case '+': return left + right;
                    case '-': return left - right;
                    case '*': return left * right;
                    case '/': return left / right;
                    case '%': return left % right;
                    case '**': return left ** right;
                    case '|': return left | right;
                    case '&': return left & right;
                    case '^': return left ^ right;
                    case '<<': return left << right;
                    case '>>': return left >> right;
                    case '>>>': return left >>> right;
                    default: return undefined;
                }
            }
            default:
                return undefined;
        }
    }

    // --- statements ------------------------------------------------------

    /** @param {any[]} list */
    statements(list){
        for (const statement of list)
        {
            this.statement(statement);
        }
    }

    /** @param {any} node */
    statement(node){
        const a = this.a;
        if (this.pushed !== 0)
        {
            throw new Error(`guest code: ${this.pushed} bytes left pushed between statements`);
        }
        switch (node.type)
        {
            case 'EmptyStatement':
                return;
            case 'BlockStatement':
                this.scopes.push(new Map());
                this.statements(node.body);
                this.popScope();
                return;
            case 'VariableDeclaration':
                this.variables(node);
                return;
            case 'ExpressionStatement':
                this.effect(node.expression);
                return;
            case 'ReturnStatement':
                this.returnStatement(node);
                return;
            case 'IfStatement':
            {
                const only = node.alternate ? null : this.jumpOnly(node.consequent);
                if (only !== null)
                {
                    // `if (c) break;` and its kin: one conditional jump, not
                    // a jump around a jump.
                    this.branch(node.test, only, true);
                    return;
                }
                const otherwise = a.fresh('else');
                this.branch(node.test, otherwise, false);
                this.statement(node.consequent);
                if (node.alternate)
                {
                    const end = a.fresh('endif');
                    if (!ends(node.consequent))
                    {
                        a.jump(-1, end);
                    }
                    a.label(otherwise);
                    this.statement(node.alternate);
                    a.label(end);
                }
                else
                {
                    a.label(otherwise);
                }
                return;
            }
            case 'WhileStatement':
            case 'DoWhileStatement':
            case 'ForStatement':
                this.loop(node);
                return;
            case 'BreakStatement':
            case 'ContinueStatement':
            {
                if (node.label)
                {
                    this.fail(node, 'a labelled jump is not in the subset');
                }
                const loop = this.loops[this.loops.length - 1];
                if (!loop)
                {
                    this.fail(node, `${node.type === 'BreakStatement' ? 'break' : 'continue'} `
                        + 'outside a loop');
                }
                a.jump(-1, node.type === 'BreakStatement' ? loop.breakTo : loop.continueTo);
                return;
            }
            default:
                this.fail(node, `${describe(node)} is not in the subset`);
        }
    }

    /**
     * Where a statement that is nothing but a jump goes: a `break`, a
     * `continue`, or a void function's `return`; null for anything else.
     *
     * @param {any} node @returns {string | null}
     */
    jumpOnly(node){
        const statement = node.type === 'BlockStatement' && node.body.length === 1
            ? node.body[0] : node;
        const loop = this.loops[this.loops.length - 1];
        if (loop && !statement.label && statement.type === 'BreakStatement')
        {
            return loop.breakTo;
        }
        if (loop && !statement.label && statement.type === 'ContinueStatement')
        {
            return loop.continueTo;
        }
        if (statement.type === 'ReturnStatement' && !statement.argument
            && this.returns === 'void' && this.fpu === 0 && this.inlining === 0)
        {
            return this.epilogue;
        }
        if (statement.type === 'ReturnStatement' && this.isHost(statement.argument)
            && this.fpu === 0 && this.inlining === 0)
        {
            this.hostReturn(statement.argument);
            return this.toHost;
        }
        return null;
    }

    /** Whether an expression is `host()`. @param {any} node */
    isHost(node){
        return node?.type === 'CallExpression' && node.callee.type === 'Identifier'
            && node.callee.name === 'host' && this.helpers.has('host');
    }

    /**
     * Checks a `return host()` and marks the function as having one.
     *
     * @param {any} node  The call.
     */
    hostReturn(node){
        if (node.arguments.length > 0)
        {
            this.fail(node, 'host() takes no arguments: the handler is handed the call\'s own');
        }
        this.hostUsed = true;
    }

    /** @param {any} node */
    loop(node){
        const a = this.a;
        const top = a.fresh('loop');
        const test = a.fresh('test');
        const next = a.fresh('next');
        const end = a.fresh('end');
        this.scopes.push(new Map());
        if (node.type === 'ForStatement' && node.init)
        {
            if (node.init.type === 'VariableDeclaration')
            {
                this.variables(node.init);
            }
            else
            {
                this.effect(node.init);
            }
        }
        const always = !node.test || node.test.type === 'Literal' && node.test.value === true;
        this.depth++;
        if (node.type !== 'DoWhileStatement' && !always)
        {
            a.jump(-1, test);
        }
        a.label(top);
        this.loops.push({ breakTo: end, continueTo: next });
        this.statement(node.body);
        this.loops.pop();
        a.label(next);
        if (node.type === 'ForStatement' && node.update)
        {
            this.effect(node.update);
        }
        a.label(test);
        if (always)
        {
            a.jump(-1, top);
        }
        else
        {
            this.branch(node.test, top, true);
        }
        a.label(end);
        this.depth--;
        this.popScope();
    }

    /** Leaves a block: its variables go out of scope. */
    popScope(){
        for (const what of /** @type {Map<string, any>} */ (this.scopes.pop()).values())
        {
            this.live.delete(what.key);
        }
    }

    /** @param {any} node */
    variables(node){
        if (node.kind !== 'let' && node.kind !== 'const')
        {
            this.fail(node, 'a variable is let or const');
        }
        const annotated = /@type\s+\{(\w+)\}/.exec(leadingDoc(this.scope, node))?.[1];
        if (annotated !== undefined && !['i32', 'u32', 'f64', 'f32'].includes(annotated))
        {
            this.fail(node, `@type {${annotated}}: a variable is i32, u32, f64 or f32`);
        }
        for (const declarator of node.declarations)
        {
            if (declarator.id.type !== 'Identifier')
            {
                this.fail(declarator.id, 'a variable is a name');
            }
            if (!declarator.init)
            {
                this.fail(declarator, `${declarator.id.name} is given a value where it is `
                    + 'declared');
            }
            const name = declarator.id.name;
            const constant = node.kind === 'const' && annotated === undefined
                ? this.fold(declarator.init) : undefined;
            if (constant !== undefined)
            {
                this.bind(declarator.id, { constant });
                continue;
            }
            const value = this.expr(declarator.init);
            /** @type {Variable['type']} */
            let type;
            if (annotated !== undefined)
            {
                type = /** @type {'i32' | 'u32' | 'f64' | 'f32'} */ (annotated);
            }
            else if (isFloat(value.type))
            {
                type = /** @type {'f64' | 'f32'} */ (value.type);
            }
            else if (value.type === 'intish')
            {
                this.fail(declarator.init, `${name} is given a sum: bring it back to 32 bits `
                    + 'with | 0 or >>> 0');
            }
            else if (value.type === 'nat')
            {
                type = node.kind === 'const' ? 'nat' : 'i32';
            }
            else
            {
                type = value.type;
            }
            const v = this.declare(declarator.id, name, type, node.kind === 'let');
            this.store(v, value, declarator.init);
        }
    }

    /**
     * Writes a value into a variable of its type.
     *
     * @param {Variable} v @param {Value} value @param {any} node
     */
    store(v, value, node){
        if (isFloat(v.type))
        {
            this.assignable(v, value.type, node);
            if (this.x87.includes(v))
            {
                this.x87Stored = true;
            }
            this.spill(v, value, node);
            return;
        }
        this.assignable(v, value.type, node);
        if (value.where === 'imm' && v.reg !== undefined)
        {
            this.op(...value.value === 0 ? [0x31, this.regs(v.reg, v.reg)]   // xor reg, reg
                : [0xb8 | this.low(v.reg, Rex.B), ...le32(value.value)]);     // mov reg, imm
            return;
        }
        if (value.where === 'imm')
        {
            this.op(0xc7, ...this.rm(0, v), ...le32(value.value));
            return;
        }
        if (value.where === 'var' && v.reg !== undefined)
        {
            this.op(0x8b, ...this.rm(v.reg, value.v));                    // mov reg, [value]
            return;
        }
        if (value.where === 'var' && value.v.reg !== undefined)
        {
            this.op(0x89, ...this.rm(value.v.reg, v));                    // mov [v], reg
            return;
        }
        if (value.where === 'eax' && v.reg !== undefined && this.retarget(v.reg))
        {
            return;
        }
        this.toEax(value, node);
        this.op(0x89, ...this.rm(EAX, v));
    }

    /**
     * Notes the load just emitted into EAX, whose ModRM ends `bytes` less
     * `after` bytes from the end of what has been emitted.
     *
     * @param {number} tail  The bytes after its ModRM: SIB and displacement.
     */
    noteLoad(tail){
        const items = this.a.items;
        const at = items.length - 1 - (items[items.length - 1].kind === 'ref' ? 1 : 0);
        const item = /** @type {{ kind: 'bytes', bytes: number[] }} */ (items[at]);
        this.loaded = {
            item, at, modrm: item.bytes.length - 1 - tail, length: item.bytes.length,
            count: items.length,
        };
    }

    /**
     * Makes the load just emitted into EAX a load into `reg`, when it is still
     * the last instruction.
     *
     * @param {number} reg
     */
    retarget(reg){
        const loaded = this.loaded;
        this.loaded = null;
        // The load noted must be the last thing emitted, in the assembler in
        // hand: a count and a length that only match a stale note -- of another
        // pass, of another expression -- would retarget an instruction long gone.
        // A register past the eighth wants a REX bit the load was made
        // without: the value is moved there instead.
        if (!loaded || this.a.items.length !== loaded.count
            || this.a.items[loaded.at] !== loaded.item
            || loaded.item.bytes.length !== loaded.length || reg >= 8)
        {
            return false;
        }
        loaded.item.bytes[loaded.modrm] |= reg << 3;
        return true;
    }

    /** @param {Variable} v @param {Type} type @param {any} node */
    assignable(v, type, node){
        const fits = type === v.type || type === 'nat' && !isFloat(v.type)
            || v.type === 'f64' && (isTyped(type) || type === 'f32');
        if (!fits)
        {
            this.fail(node, type === 'intish'
                ? `${v.name} is given a sum: bring it back to 32 bits with | 0 or >>> 0`
                : v.type === 'f32'
                    ? `${v.name} is f32, and this is ${type}: a float is Math.fround's`
                    : `${v.name} is ${v.type}, and this is ${type}`);
        }
    }

    /** An expression evaluated for what it does. @param {any} node */
    effect(node){
        const a = this.a;
        switch (node.type)
        {
            case 'AssignmentExpression':
            {
                const v = this.variable(node.left);
                const inPlace = node.operator === '=' ? this.inPlace(v, node.right) : null;
                if (inPlace !== null)
                {
                    this.effect(inPlace);
                    return;
                }
                if (node.operator === '=')
                {
                    this.store(v, this.expr(node.right), node.right);
                    return;
                }
                if (isFloat(v.type))
                {
                    this.fail(node, `${node.operator} on a double is written ${v.name} = `
                        + `${v.name} ${node.operator.slice(0, -1)} ...`);
                }
                const op = node.operator.slice(0, -1);
                const result = /** @type {Record<string, string>} */ ({ '+': 'same', '-': 'same',
                    '|': 'i32', '&': 'i32', '^': 'i32', '<<': 'i32', '>>': 'i32',
                    '>>>': 'u32' })[op];
                if (result === undefined)
                {
                    this.fail(node, `${node.operator} is not in the subset`);
                }
                if (result !== 'same' && result !== v.type)
                {
                    this.fail(node, `${node.operator} makes an ${result} of ${v.name}, `
                        + `an ${v.type}`);
                }
                const value = this.expr(node.right);
                this.integer(value, node.right, op === '+' || op === '-' ? 'intish' : 'any');
                const shift = /** @type {Record<string, number>} */ ({ '<<': 4, '>>': 7,
                    '>>>': 5 })[op];
                if (shift !== undefined)
                {
                    if (value.where === 'imm')
                    {
                        this.op(0xc1, ...this.rm(shift, v), value.value & 31);
                        return;
                    }
                    if (value.where === 'var')
                    {
                        this.op(0x8b, ...this.rm(ECX, value.v));  // mov ecx, [count]
                    }
                    else
                    {
                        this.toEax(value, node.right);
                        a.emit(0x89, 0xc1);                       // mov ecx, eax
                    }
                    this.op(0xd3, ...this.rm(shift, v));          // shl/sar/shr [v], cl
                    return;
                }
                const alu = { '+': ALU.add, '-': ALU.sub, '|': ALU.or, '&': ALU.and,
                    '^': ALU.xor }[/** @type {'+'} */ (op)];
                if (value.where === 'imm')
                {
                    const imm = value.value | 0;
                    this.op(...fitsByte(imm) ? [0x83, ...this.rm(alu, v), imm & 0xff]
                        : [0x81, ...this.rm(alu, v), ...le32(imm)]);
                    return;
                }
                if (value.where === 'var' && value.v.reg !== undefined)
                {
                    this.op(alu << 3 | 1, ...this.rm(value.v.reg, v));  // op [v], reg
                    return;
                }
                if (value.where === 'var' && v.reg !== undefined)
                {
                    this.op(alu << 3 | 3, ...this.rm(v.reg, value.v));  // op reg, [value]
                    return;
                }
                this.toEax(value, node.right);
                this.op(alu << 3 | 1, ...this.rm(EAX, v));         // op [v], eax
                return;
            }
            case 'UpdateExpression':
            {
                const v = this.variable(node.argument);
                if (isFloat(v.type))
                {
                    this.fail(node, `${node.operator} on a double is written ${v.name} = `
                        + `${v.name} ${node.operator[0]} 1`);
                }
                this.op(0xff, ...this.rm(node.operator === '++' ? 0 : 1, v));
                return;
            }
            case 'CallExpression':
            {
                const name = node.callee.type === 'Identifier' ? node.callee.name : '';
                if (Object.hasOwn(STORES, name) && this.helpers.has(name))
                {
                    this.storeCall(node, name);
                    return;
                }
                if ((name === 'copyUp' || name === 'copyDown' || name === 'fill')
                    && this.helpers.has(name))
                {
                    this.bulk(node, name);
                    return;
                }
                if ((name === 'call' || name === 'callStd') && this.helpers.has(name))
                {
                    this.guestCall(node, name === 'callStd');
                    return;
                }
                if (name === 'setControlWord' && this.helpers.has(name))
                {
                    this.arity(node, 1);
                    const value = this.expr(node.arguments[0]);
                    this.integer(value, node.arguments[0], 'typed');
                    this.toEax(value, node.arguments[0]);
                    a.emit(0x50, 0xd9, 0x2c, 0x24, 0x58);               // push; fldcw [esp]; pop
                    this.x87Used = true;
                    return;
                }
                if (name === 'setMxcsr' && this.helpers.has(name))
                {
                    this.arity(node, 1);
                    const value = this.expr(node.arguments[0]);
                    this.integer(value, node.arguments[0], 'typed');
                    this.toEax(value, node.arguments[0]);
                    a.emit(0x50, 0x0f, 0xae, 0x14, 0x24, 0x58);         // push; ldmxcsr [esp]; pop
                    return;
                }
                if (name === 'clearExceptions' && this.helpers.has(name))
                {
                    this.arity(node, 0);
                    a.emit(0xdb, 0xe2);                                    // fnclex
                    this.x87Used = true;
                    return;
                }
                if (name === 'host' && this.helpers.has(name))
                {
                    this.fail(node, 'host() is only returned: return host()');
                }
                if (this.scope.guests.has(name) && this.lookupLocal(name) === undefined)
                {
                    this.moduleCall(node, name);
                    return;
                }
                return this.fail(node, 'a call made for what it does is a store, a copy, a '
                    + 'fill or call()');
            }
            default:
                this.fail(node, `${describe(node)} as a statement is not in the subset`);
        }
    }

    /**
     * `x = (x + y) | 0` and its kin -- `+` or `-` of the variable itself,
     * brought back to the variable's own type -- as the `x += y` it is in 32
     * bits, done in place; null for anything else.
     *
     * @param {Variable} v @param {any} right @returns {any}
     */
    inPlace(v, right){
        const back = right.type === 'BinaryExpression' && (right.operator === '|'
            || right.operator === '>>>') && this.fold(right.right) === 0;
        const sum = back ? right.left : null;
        if (isFloat(v.type) || v.type !== (right.operator === '|' ? 'i32' : 'u32')
            || sum?.type !== 'BinaryExpression' || sum.operator !== '+' && sum.operator !== '-'
            || sum.left.type !== 'Identifier' || this.lookupLocal(sum.left.name) !== v)
        {
            return null;
        }
        return {
            type: 'AssignmentExpression', operator: `${sum.operator}=`, left: sum.left,
            right: sum.right, loc: right.loc,
        };
    }

    /** @param {any} node @returns {Variable} */
    variable(node){
        if (node.type !== 'Identifier')
        {
            this.fail(node, 'only a variable is assigned');
        }
        const v = this.lookupLocal(node.name);
        if (v === undefined || 'constant' in v)
        {
            this.fail(node, `${node.name} is not a variable of this function`);
        }
        if (!v.mutable)
        {
            this.fail(node, `${node.name} is a const`);
        }
        if (this.paramKeys.has(v.key))
        {
            this.assigned.add(v.key);
        }
        return v;
    }

    /** @param {any} node */
    returnStatement(node){
        const returns = this.returns;
        if (this.inlining > 0)
        {
            this.fail(node, 'an inlined function returns only by its one return');
        }
        if (this.isHost(node.argument))
        {
            this.hostReturn(node.argument);
            if (this.fpu !== 0)
            {
                this.fail(node, 'the x87 stack is not empty at a return');
            }
            this.a.jump(-1, this.toHost);
            return;
        }
        if (returns === 'void')
        {
            if (node.argument)
            {
                this.fail(node, 'a void function returns nothing');
            }
        }
        else
        {
            if (!node.argument)
            {
                this.fail(node, `the function returns an ${returns}`);
            }
            const value = this.expr(node.argument);
            if (returns === 'f32' && value.type !== 'f32')
            {
                this.fail(node.argument, `the function returns an f32, and this is ${value.type}: `
                    + 'a float is Math.fround\'s');
            }
            if (isFloat(returns))
            {
                this.toFloat(value, node.argument);
                if (this.long && returns === 'f32')
                {
                    this.sse(0xf2, 0x5a, 0, 0);                            // cvtsd2ss xmm0, xmm0
                }
                this.fpu--;
            }
            else if (returns === 'i64' && isFloat(value.type))
            {
                this.toSt0(value, node.argument);
                this.fpu--;
                // fisttp qword [esp]: truncated whatever the rounding control says.
                this.a.emit(0x83, 0xec, 0x08, 0xdd, 0x0c, 0x24, 0x58, 0x5a);
            }
            else
            {
                if (!isTyped(value.type))
                {
                    this.fail(node.argument, value.type === 'intish'
                        ? 'a sum is returned once it is brought back to 32 bits'
                        : `the function returns an ${returns}, not an ${value.type}`);
                }
                if (returns === 'u32' && value.type === 'i32'
                    || returns === 'i32' && value.type === 'u32')
                {
                    this.fail(node.argument, `the function returns an ${returns}, and this `
                        + `is an ${value.type}`);
                }
                this.toEax(value, node.argument);
                if (returns === 'i64')
                {
                    this.a.emit(...value.type === 'u32' ? [0x31, 0xd2] : [0x99]); // xor edx / cdq
                }
            }
        }
        if (this.fpu !== 0)
        {
            this.fail(node, 'the x87 stack is not empty at a return');
        }
        this.a.jump(-1, this.epilogue);
    }

    // --- conditions ------------------------------------------------------

    /**
     * Jumps to `target` when the condition is `when`, and falls through
     * otherwise.
     *
     * @param {any} node @param {string} target @param {boolean} when
     */
    branch(node, target, when){
        const a = this.a;
        if (node.type === 'LogicalExpression' && (node.operator === '&&' || node.operator === '||'))
        {
            const and = node.operator === '&&';
            if (and !== when)
            {
                // a && b false: either is; a || b true: either is.
                this.branch(node.left, target, when);
                this.branch(node.right, target, when);
                return;
            }
            const skip = a.fresh('skip');
            this.branch(node.left, skip, !when);
            this.branch(node.right, target, when);
            a.label(skip);
            return;
        }
        if (node.type === 'UnaryExpression' && node.operator === '!')
        {
            this.branch(node.argument, target, !when);
            return;
        }
        if (node.type === 'Literal' && typeof node.value === 'boolean')
        {
            if (node.value === when)
            {
                a.jump(-1, target);
            }
            return;
        }
        if (node.type === 'BinaryExpression'
            && ['<', '<=', '>', '>=', '===', '!=='].includes(node.operator))
        {
            this.compare(node, target, when);
            return;
        }
        if (node.type === 'BinaryExpression' && (node.operator === '==' || node.operator === '!='))
        {
            this.fail(node, `${node.operator} is written ${node.operator}=`);
        }
        if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
            && !node.callee.computed && node.callee.object.type === 'Identifier'
            && node.callee.object.name === 'Number' && node.callee.property.name === 'isNaN'
            && this.lookupLocal('Number') === undefined)
        {
            // A double compared with itself is unordered, PF set, only as a NaN.
            this.arity(node, 1);
            this.toFloat(this.expr(node.arguments[0]), node.arguments[0]);
            if (this.long)
            {
                this.sse(0x66, 0x2e, this.fpu - 1, this.fpu - 1);      // ucomisd x, x
            }
            else
            {
                a.emit(0xdf, 0xe8);                                // fucomip st0: popped
            }
            this.fpu--;
            a.jump(when ? CC.p : CC.np, target);
            return;
        }
        const value = this.expr(node);
        if (!isTyped(value.type))
        {
            this.fail(node, isFloat(value.type)
                ? 'a double is tested by a comparison'
                : 'a sum is tested once it is brought back to 32 bits');
        }
        if (value.where === 'var' && value.v.reg !== undefined)
        {
            this.op(0x85, this.regs(value.v.reg, value.v.reg));    // test reg, reg
        }
        else
        {
            this.toEax(value, node);
            a.emit(0x85, 0xc0);                                    // test eax, eax
        }
        a.jump(when ? CC.ne : CC.e, target);
    }

    /** @param {any} node @param {string} target @param {boolean} when */
    compare(node, target, when){
        const a = this.a;
        const op = node.operator;
        const leftType = this.peekType(node.left);
        const rightType = this.peekType(node.right);
        if (isFloat(leftType) || isFloat(rightType))
        {
            this.toFloat(this.expr(node.left), node.left);
            this.toFloat(this.expr(node.right), node.right);
            // ST0 the right, ST1 the left; fucomip compares ST0 with ST1, so
            // `>` and `>=` exchange them first and every test is `a`/`ae`,
            // which an unordered comparison (CF set) fails. `ucomisd` sets
            // the flags as `fucomip` does, its first operand compared.
            const greater = op === '>' || op === '>=';
            if (this.long)
            {
                const [left, right] = [this.fpu - 2, this.fpu - 1];
                this.sse(0x66, 0x2e, greater ? left : right, greater ? right : left);  // ucomisd
            }
            else
            {
                if (greater)
                {
                    a.emit(0xd9, 0xc9);                            // fxch st1
                }
                a.emit(0xdf, 0xe9, 0xdd, 0xd8);                    // fucomip st1; fstp st0
            }
            this.fpu -= 2;
            if (op === '===' || op === '!==')
            {
                // Equal is ZF set with PF clear; unordered sets both.
                if (op === '===' === when)
                {
                    const skip = a.fresh('unordered');
                    a.jump(CC.p, skip);
                    a.jump(CC.e, target);
                    a.label(skip);
                }
                else
                {
                    a.jump(CC.ne, target);
                    a.jump(CC.p, target);
                }
                return;
            }
            const cc = op === '<' || op === '>' ? CC.a : CC.ae;
            a.jump(when ? cc : invert(cc), target);
            return;
        }
        const signed = this.signedness(node, leftType, rightType);
        const left = this.simple(node.left);
        const right = this.simple(node.right);
        if (left?.where === 'var' && left.v.reg !== undefined && right !== null)
        {
            // A register compared as it stands, with no load into EAX.
            const reg = left.v.reg;
            this.integer(right, node.right, 'intish');
            if (right.where === 'imm' && right.value === 0)
            {
                this.op(0x85, this.regs(reg, reg));                        // test reg, reg
            }
            else if (right.where === 'imm')
            {
                const imm = right.value | 0;
                this.op(...fitsByte(imm) ? [0x83, this.regs(ALU.cmp, reg), imm & 0xff]
                    : [0x81, this.regs(ALU.cmp, reg), ...le32(imm)]);      // cmp reg, imm
            }
            else
            {
                this.op(0x3b, ...this.rm(reg, /** @type {{ v: Variable }} */ (right).v)); // cmp
            }
        }
        else if (left?.where === 'var' && right?.where === 'var' && right.v.reg !== undefined)
        {
            this.op(0x39, ...this.rm(right.v.reg, left.v));                  // cmp [left], reg
        }
        else
        {
            this.alu(ALU.cmp, this.pair(node.left, node.right));
        }
        /** @type {Record<string, number>} */
        const codes = signed
            ? { '<': CC.l, '<=': CC.le, '>': CC.g, '>=': CC.ge, '===': CC.e, '!==': CC.ne }
            : { '<': CC.b, '<=': CC.be, '>': CC.a, '>=': CC.ae, '===': CC.e, '!==': CC.ne };
        const cc = codes[op];
        a.jump(when ? cc : invert(cc), target);
    }

    /**
     * Whether two integers compare signed: both the same signedness, or a
     * value either way beside one of them.
     *
     * @param {any} node @param {Type} left @param {Type} right
     */
    signedness(node, left, right){
        if (left === 'intish' || right === 'intish')
        {
            this.fail(node, 'a sum is compared once it is brought back to 32 bits (| 0 or >>> 0)');
        }
        if (left === 'i32' && right === 'u32' || left === 'u32' && right === 'i32')
        {
            this.fail(node, 'a signed value compared with an unsigned one: JavaScript compares '
                + 'their values, and no one x86 comparison does');
        }
        return left !== 'u32' && right !== 'u32';
    }

    // --- expressions -----------------------------------------------------

    /**
     * The type an expression has, without emitting it: what a comparison
     * needs before it chooses its instructions.
     *
     * @param {any} node @returns {Type}
     */
    peekType(node){
        const known = this.inlining === 0 ? this.types.get(node) : undefined;
        if (known !== undefined)
        {
            return known;
        }
        const mark = this.a.items.length;
        const last = this.a.items[mark - 1];
        const lastLength = last?.kind === 'bytes' ? last.bytes.length : 0;
        const fpu = this.fpu;
        const labels = this.a.labels;
        const locals = this.locals;
        const tables = new Map(this.tables);
        const saves = new Set(this.saves);
        const scopes = this.scopes.map(scope=>new Map(scope));
        const { x87Consumed, x87Reads, x87ReadClean, x87Clean, frameUsed, constantLoads,
            pushedAny } = this;
        const homeFree = [...this.homeFree];
        const pooled = this.pool.length;
        const quads = this.quads.length;
        this.peeking++;
        /** @type {Value} */
        let value;
        try
        {
            value = this.expr(node);
        }
        finally
        {
            this.peeking--;
        }
        Object.assign(this, {
            x87Consumed, x87Reads, x87ReadClean, x87Clean, frameUsed, constantLoads, pushedAny,
            homeFree,
        });
        this.pool.length = pooled;
        this.quads.length = quads;
        this.a.items.length = mark;
        if (last?.kind === 'bytes')
        {
            last.bytes.length = lastLength;
        }
        this.fpu = fpu;
        this.a.labels = labels;
        this.locals = locals;
        this.tables = tables;
        this.saves = saves;
        this.scopes = scopes;
        if (this.inlining === 0)
        {
            this.types.set(node, value.type);
        }
        return value.type;
    }

    /**
     * An operand an instruction can name without code before it: a constant
     * or an integer variable.
     *
     * @param {any} node @returns {Value | null}
     */
    simple(node){
        const constant = this.fold(node);
        if (constant !== undefined)
        {
            return { where: 'imm', type: constType(constant), value: constant };
        }
        if (node.type === 'Identifier')
        {
            const v = this.lookupLocal(node.name);
            if (v !== undefined && !('constant' in v) && !isFloat(v.type))
            {
                return { where: 'var', type: v.type, v };
            }
        }
        return null;
    }

    /**
     * Emits the left operand into EAX and answers the right as an operand:
     * a constant or a variable as it is, anything else in ECX. JavaScript's
     * order holds: the left is read first unless it is a constant or a
     * variable, which nothing on the right can change. For an operation
     * that commutes, a left constant or variable is the operand as it is.
     *
     * @param {any} left @param {any} right @param {boolean} [commutes]
     * @returns {{ right: Value | { where: 'ecx', type: Type }, leftType: Type }}
     */
    pair(left, right, commutes = false){
        const a = this.a;
        const r = this.simple(right);
        if (r !== null)
        {
            const l = this.expr(left);
            this.integer(l, left, 'intish');
            this.integer(r, right, 'intish');
            this.toEax(l, left);
            return { right: r, leftType: l.type };
        }
        const l = this.simple(left);
        if (l !== null)
        {
            const value = this.expr(right);
            this.integer(value, right, 'intish');
            this.integer(l, left, 'intish');
            this.toEax(value, right);
            if (commutes)
            {
                return { right: l, leftType: value.type };
            }
            a.emit(0x89, 0xc1);                                        // mov ecx, eax
            this.toEax(l, left);
            return { right: { where: 'ecx', type: value.type }, leftType: l.type };
        }
        const lv = this.expr(left);
        this.integer(lv, left, 'intish');
        this.toEax(lv, left);
        const load = this.registerLoad(right);
        if (load !== null)
        {
            // Nothing to make first: EAX stands while ECX is loaded.
            load.emit(ECX);
            return { right: { where: 'ecx', type: load.type }, leftType: lv.type };
        }
        this.hold();                                                   // push eax
        const rv = this.expr(right);
        this.integer(rv, right, 'intish');
        if (rv.where !== 'eax' || !this.retarget(ECX))
        {
            this.toEax(rv, right);
            a.emit(0x89, 0xc1);                                        // mov ecx, eax
        }
        this.unhold(EAX);                                              // pop eax
        return { right: { where: 'ecx', type: rv.type }, leftType: lv.type };
    }

    /**
     * `op eax, operand`.
     *
     * @param {number} op @param {{ right: Value | { where: 'ecx', type: Type } }} pair
     */
    alu(op, { right }){
        const a = this.a;
        if (right.where === 'imm' && op === ALU.cmp && right.value === 0)
        {
            a.emit(0x85, 0xc0);                                        // test eax, eax
        }
        else if (right.where === 'imm')
        {
            const imm = right.value | 0;
            a.emit(...fitsByte(imm) ? [0x83, 0xc0 | op << 3, imm & 0xff]
                : [0x81, 0xc0 | op << 3, ...le32(imm)]);
        }
        else if (right.where === 'var')
        {
            this.op(op << 3 | 3, ...this.rm(EAX, right.v));
        }
        else
        {
            a.emit(op << 3 | 1, 0xc8);                                  // op eax, ecx
        }
    }

    /**
     * Holds a value to be an integer: brought back to 32 bits unless `allow`
     * is 'intish'.
     *
     * @param {Value} value @param {any} node @param {'intish' | 'typed' | 'any'} allow
     */
    integer(value, node, allow){
        if (isFloat(value.type))
        {
            this.fail(node, 'a double where an integer is wanted: it becomes one by | 0 or >>> 0');
        }
        if (allow === 'typed' && value.type === 'intish')
        {
            this.fail(node, 'a sum is used here once it is brought back to 32 bits');
        }
    }

    /**
     * Brings a value into EAX.
     *
     * @param {Value} value @param {any} node
     */
    toEax(value, node){
        const a = this.a;
        if (isFloat(value.type))
        {
            this.fail(node, 'a double where an integer is wanted: it becomes one by | 0 or >>> 0');
        }
        switch (value.where)
        {
            case 'imm':
                if (value.value === 0)
                {
                    a.emit(0x31, 0xc0);                                    // xor eax, eax
                }
                else
                {
                    a.emit(0xb8, ...le32(value.value));
                }
                return;
            case 'var':
                this.op(0x8b, ...this.rm(EAX, value.v));
                return;
            default:
                return;
        }
    }

    /**
     * Brings a value onto the x87 stack as a double: an integer converted
     * exactly.
     *
     * @param {Value} value @param {any} node
     */
    toSt0(value, node){
        const a = this.a;
        this.x87Only(node, 'this use of a double');
        if (value.where === 'st0')
        {
            return;
        }
        if (value.where === 'var' && value.v.onStack)
        {
            // In ST0 since the call, and counted there: this is its one read.
            if (this.x87Consumed)
            {
                throw new Error(`guest code: ${value.v.name}, left in ST0, is read twice`);
            }
            this.x87Consumed = true;
            return;
        }
        if (value.where === 'var' && this.x87.includes(value.v))
        {
            this.x87Reads++;
            this.x87ReadClean = this.x87Reads === 1 && this.x87Clean && this.fpu === 0
                && !this.a.items.some(item=>item.kind !== 'bytes');
        }
        this.x87Clean = false;
        this.x87Used = true;
        if (++this.fpu > X87_DEPTH)
        {
            this.fail(node, 'the expression holds more doubles at once than the x87 has room for');
        }
        if (value.where === 'var' && isFloat(value.type))
        {
            // fld qword [v], or dword, a float's
            a.emit(value.type === 'f64' ? 0xdd : 0xd9, ...this.frameAt(0, value.v.disp));
            return;
        }
        if (value.where === 'imm')
        {
            this.loadConstant(value.value);
            return;
        }
        if (value.type === 'intish')
        {
            this.fail(node, 'a sum becomes a double once it is brought back to 32 bits');
        }
        if (value.where === 'var' && value.v.reg === undefined && value.type !== 'u32')
        {
            a.emit(0xdb, ...this.rm(0, value.v));                        // fild dword [v]
            return;
        }
        this.toEax(value, node);
        if (value.type === 'u32')
        {
            // push 0; push eax; fild qword [esp]; add esp, 8
            a.emit(0x6a, 0x00, 0x50, 0xdf, 0x2c, 0x24, 0x83, 0xc4, 0x08);
        }
        else
        {
            // push eax; fild dword [esp]; pop eax
            a.emit(0x50, 0xdb, 0x04, 0x24, 0x58);
        }
    }

    /**
     * Brings a value onto the stack of doubles: the x87's, or at 64 bits the
     * XMM registers'. For a use whose next instructions are the same for both.
     *
     * @param {Value} value @param {any} node
     */
    toFloat(value, node){
        if (this.long)
        {
            this.toXmm(value, node);
            return;
        }
        this.toSt0(value, node);
    }

    /**
     * Writes a double into a variable in the frame: `fstp`, or at 64 bits
     * `movsd`, a float's rounded to nearest by either.
     *
     * @param {Variable} v @param {Value} value @param {any} node
     */
    spill(v, value, node){
        if (this.long)
        {
            this.toXmm(value, node);
            this.storeXmm(v.type === 'f64', field=>this.frameAt(field, v.disp));
            return;
        }
        this.toSt0(value, node);
        // fstp qword [v], or dword, a float's
        this.a.emit(v.type === 'f64' ? 0xdd : 0xd9, ...this.frameAt(3, v.disp));
        this.fpu--;
    }

    /**
     * Refuses at 64 bits what only the x87 does: its doubles are SSE2's
     * there, which has no instruction for it.
     *
     * @param {any} node @param {string} what
     */
    x87Only(node, what){
        if (this.long)
        {
            this.fail(node, `${what} is the x87's, with no SSE2 instruction: refused at 64 bits`);
        }
    }

    // --- doubles at 64 bits: SSE2 --------------------------------------------
    //
    // The x87's stack of doubles, as XMM registers: the value `fpu` deep in
    // XMM(fpu - 1), the next pushed into the register past it. Scalar SSE2
    // arithmetic is IEEE double's to the last bit, as JavaScript's is, under
    // the convention's MXCSR (round to nearest, no exception unmasked). XMM0
    // to XMM5 are the callee's to change: four deep at most, two past them
    // for an operation's own use.

    /** The next XMM register an expression takes. @param {any} node */
    pushXmm(node){
        if (++this.fpu > SSE_DEPTH)
        {
            this.fail(node, 'the expression holds more doubles at once than x86-64 code keeps '
                + 'in registers');
        }
        return this.fpu - 1;
    }

    /**
     * A scalar SSE2 instruction of two XMM registers.
     *
     * @param {number} prefix  0xf2 (double), 0xf3 (float) or 0x66.
     * @param {number} opcode  The byte after 0x0f. @param {number} reg @param {number} rm
     */
    sse(prefix, opcode, reg, rm){
        this.a.emit(prefix, 0x0f, opcode, 0xc0 | reg << 3 | rm);
    }

    /**
     * A scalar SSE2 instruction reading the table of quadwords after the
     * code, RIP-relative: a constant's bits.
     *
     * @param {number} prefix @param {number} opcode @param {number} reg @param {bigint} bits
     */
    sseConstant(prefix, opcode, reg, bits){
        let at = this.quads.indexOf(bits);
        if (at < 0)
        {
            at = this.quads.push(bits) - 1;
        }
        this.a.emit(prefix, 0x0f, opcode, 0x05 | reg << 3).rip(QUADS, at * 8);
    }

    /**
     * The double on top of the XMM stack and a mask of its bits, by a packed
     * logical instruction of two registers: the mask is read into the
     * scratch register with `movsd`, which, unlike `andpd` of memory, asks
     * for no 16-byte alignment.
     *
     * @param {number} opcode  0x54 `andpd`, 0x57 `xorpd`. @param {bigint} bits
     */
    masked(opcode, bits){
        const x = this.fpu - 1;
        this.sseConstant(0xf2, 0x10, x + 1, bits);                         // movsd scratch, [mask]
        this.sse(0x66, opcode, x, x + 1);
    }

    /**
     * A double onto the XMM stack: an integer converted exactly, a float
     * widened, a constant from the table after the code (zero made).
     *
     * @param {Value} value @param {any} node
     */
    toXmm(value, node){
        if (value.where === 'st0')
        {
            return;
        }
        if (value.where === 'var' && isFloat(value.type))
        {
            const x = this.pushXmm(node);
            if (value.type === 'f64')
            {
                this.op(0xf2, 0x0f, 0x10, ...this.frameAt(x, value.v.disp));  // movsd xmm, [v]
                return;
            }
            this.op(0xf3, 0x0f, 0x10, ...this.frameAt(x, value.v.disp));      // movss xmm, [v]
            this.sse(0xf3, 0x5a, x, x);                                        // cvtss2sd
            return;
        }
        if (value.where === 'imm')
        {
            const x = this.pushXmm(node);
            if (Object.is(value.value, 0))
            {
                this.sse(0x66, 0x57, x, x);                                    // xorpd xmm, xmm
                return;
            }
            this.sseConstant(0xf2, 0x10, x, doubleBits(value.value));          // movsd xmm, [c]
            return;
        }
        if (value.type === 'intish')
        {
            this.fail(node, 'a sum becomes a double once it is brought back to 32 bits');
        }
        if (value.type === 'u32')
        {
            // Zero-extended in RAX: the 64-bit conversion takes it exactly.
            this.toEax(value, node);
            const x = this.pushXmm(node);
            this.a.emit(0xf2, 0x48, 0x0f, 0x2a, 0xc0 | x << 3);                // cvtsi2sd xmm, rax
            return;
        }
        if (value.where === 'var')
        {
            const x = this.pushXmm(node);
            this.op(0xf2, 0x0f, 0x2a, ...this.rm(x, value.v));                 // cvtsi2sd xmm, r/m32
            return;
        }
        this.a.emit(0xf2, 0x0f, 0x2a, 0xc0 | this.pushXmm(node) << 3);         // cvtsi2sd xmm, eax
    }

    /**
     * The double on top of the XMM stack stored, a float's rounded to
     * nearest as `cvtsd2ss` rounds it, and popped.
     *
     * @param {boolean} double @param {(field: number) => number[]} operand
     *     The memory operand's ModRM and the rest, with `field` in the reg field.
     */
    storeXmm(double, operand){
        const x = this.fpu - 1;
        if (double)
        {
            this.op(0xf2, 0x0f, 0x11, ...operand(x));                         // movsd [m], xmm
        }
        else
        {
            this.sse(0xf2, 0x5a, x, x);                                        // cvtsd2ss
            this.op(0xf3, 0x0f, 0x11, ...operand(x));                         // movss [m], xmm
        }
        this.fpu--;
    }

    /**
     * `+ - * /` of two doubles: each onto the stack, JavaScript's order, and
     * the operation's scalar instruction.
     *
     * @param {any} node @returns {Value}
     */
    floatBinaryXmm(node){
        if (node.operator === '%')
        {
            this.x87Only(node, '% of a double, the exact remainder of `fprem`,');
        }
        this.note(node, 'rounds');
        this.toXmm(this.expr(node.left), node.left);
        this.toXmm(this.expr(node.right), node.right);
        const opcode = /** @type {Record<string, number>} */ ({ '+': 0x58, '*': 0x59, '-': 0x5c,
            '/': 0x5e })[node.operator];
        this.sse(0xf2, opcode, this.fpu - 2, this.fpu - 1);
        this.fpu--;
        return { where: 'st0', type: 'f64' };
    }

    /**
     * `Math.trunc`, `Math.floor` and `Math.ceil` of the double on top of the
     * stack, with no SSE4.1: a value 2^52 or more in magnitude -- and an
     * infinity, and NaN -- is whole already; any other is truncated through a
     * quadword (`cvttsd2si`), given the argument's sign back -- the sign of a
     * zero it rounds to -- and moved by one where it went the wrong way.
     *
     * @param {string} name
     */
    roundXmm(name){
        const a = this.a;
        const x = this.fpu - 1;
        const s = x + 1;
        const t = x + 2;
        const done = a.fresh('whole');
        this.sseConstant(0xf2, 0x10, s, ABS_MASK);                             // movsd s, [abs]
        this.sse(0x66, 0x54, s, x);                                            // andpd s, x
        this.sseConstant(0xf2, 0x10, t, doubleBits(2 ** 52));                  // movsd t, [2^52]
        this.sse(0x66, 0x2e, t, s);                                            // ucomisd t, s
        a.jump(CC.be, done);
        a.emit(0xf2, 0x48, 0x0f, 0x2c, 0xc0 | x);                              // cvttsd2si rax, x
        a.emit(0xf2, 0x48, 0x0f, 0x2a, 0xc0 | s << 3);                         // cvtsi2sd s, rax
        this.sseConstant(0xf2, 0x10, t, SIGN_MASK);                            // movsd t, [sign]
        this.sse(0x66, 0x54, t, x);                                            // andpd t, x
        this.sse(0x66, 0x56, s, t);                                            // orpd s, t
        if (name !== 'trunc')
        {
            // Floor: one less where truncation went up; ceil: one more where it went down.
            const kept = a.fresh('kept');
            if (name === 'floor')
            {
                this.sse(0x66, 0x2e, s, x);                                    // ucomisd s, x
            }
            else
            {
                this.sse(0x66, 0x2e, x, s);                                    // ucomisd x, s
            }
            a.jump(CC.be, kept);
            this.sseConstant(0xf2, 0x10, t, doubleBits(1));                    // movsd t, [1]
            this.sse(0xf2, name === 'floor' ? 0x5c : 0x58, s, t);              // subsd/addsd s, t
            a.label(kept);
        }
        this.sse(0xf2, 0x10, x, s);                                            // movsd x, s
        a.label(done);
    }

    /**
     * A double brought to an integer as `| 0` and `>>> 0` bring one, modulo
     * 2^32 after truncation: `cvttsd2si` of the whole into RAX, its low half
     * -- and where that answers the integer indefinite, a magnitude of 2^63
     * or more, an infinity or NaN, the double's bits moved left by its
     * exponent less 1075: the low 32 bits of the whole number it is, negated
     * for a negative value. Such a shift is 11 or more, which puts the
     * implicit bit, the exponent and the sign past bit 31; one of 32 or more,
     * an infinity's and NaN's among them, leaves none of the significand there.
     *
     * @param {any} node @param {string} op @returns {Value}
     */
    toIntegerXmm(node, op){
        const a = this.a;
        this.toXmm(this.expr(node), node);
        const x = this.fpu - 1;
        const done = a.fresh('converted');
        const slow = a.fresh('indefinite');
        const zero = a.fresh('none');
        const positive = a.fresh('positive');
        a.emit(0xf2, 0x48, 0x0f, 0x2c, 0xc0 | x);                      // cvttsd2si rax, x
        a.emit(0x48, 0x89, 0xc1, 0x48, 0xf7, 0xd9);                    // mov rcx, rax; neg rcx
        a.jump(CC.o, slow);                                            // only -2^63 overflows
        a.emit(0x89, 0xc0);                                            // mov eax, eax
        a.jump(-1, done);
        a.label(slow);
        a.emit(0x66, 0x48, 0x0f, 0x7e, 0xc0 | x << 3);                 // movq rax, x
        a.emit(0x48, 0xd1, 0xe0, 0x48, 0xc1, 0xe8, 0x35);              // shl rax, 1; shr rax, 53
        a.emit(0x8d, 0x88, ...le32(-1075 >>> 0));                      // lea ecx, [rax - 1075]
        a.emit(0x83, 0xf9, 0x20);                                      // cmp ecx, 32
        a.jump(CC.ae, zero);
        a.emit(0x66, 0x48, 0x0f, 0x7e, 0xc0 | x << 3);                 // movq rax, x
        a.emit(0x48, 0xd3, 0xe0);                                      // shl rax, cl
        a.emit(0x66, 0x48, 0x0f, 0x7e, 0xc1 | x << 3);                 // movq rcx, x
        a.emit(0x48, 0x85, 0xc9);                                      // test rcx, rcx
        a.jump(CC.ge, positive);
        a.emit(0xf7, 0xd8);                                            // neg eax
        a.label(positive);
        a.emit(0x89, 0xc0);                                            // mov eax, eax
        a.jump(-1, done);
        a.label(zero);
        a.emit(0x31, 0xc0);                                            // xor eax, eax
        a.label(done);
        this.fpu--;
        return { where: 'eax', type: op === '|' ? 'i32' : 'u32' };
    }

    /**
     * Evaluates an expression: a constant or a variable is answered as an
     * operand, anything else emitted into EAX or onto the x87 stack.
     *
     * @param {any} node @returns {Value}
     */
    expr(node){
        const simple = this.simple(node);
        if (simple !== null)
        {
            return simple;
        }
        const a = this.a;
        switch (node.type)
        {
            case 'Identifier':
            {
                const v = this.lookupLocal(node.name);
                if (v !== undefined && !('constant' in v))
                {
                    return { where: 'var', type: v.type, v };
                }
                return this.fail(node, `${node.name} is not a variable, a constant or a `
                    + 'parameter here');
            }
            case 'Literal':
                return this.fail(node, typeof node.value === 'boolean'
                    ? 'a boolean is a condition, not a value: write c ? 1 : 0'
                    : `${JSON.stringify(node.value)} is not a number`);
            case 'UnaryExpression':
                return this.unary(node);
            case 'BinaryExpression':
                return this.binary(node);
            case 'LogicalExpression':
                return this.fail(node, `${node.operator} makes a condition, not a value: `
                    + 'write c ? 1 : 0');
            case 'ConditionalExpression':
            {
                const otherwise = a.fresh('else');
                const end = a.fresh('end');
                this.branch(node.test, otherwise, false);
                const yes = this.expr(node.consequent);
                const no = this.peekType(node.alternate);
                if (isFloat(yes.type) || isFloat(no))
                {
                    this.toFloat(yes, node.consequent);
                    this.fpu--;
                    a.jump(-1, end).label(otherwise);
                    this.toFloat(this.expr(node.alternate), node.alternate);
                    a.label(end);
                    return { where: 'st0',
                        type: yes.type === 'f32' && no === 'f32' ? 'f32' : 'f64' };
                }
                const type = this.join(node, yes.type, no);
                this.toEax(yes, node.consequent);
                a.jump(-1, end).label(otherwise);
                this.toEax(this.expr(node.alternate), node.alternate);
                a.label(end);
                return { where: 'eax', type };
            }
            case 'CallExpression':
                return this.callExpression(node);
            case 'MemberExpression':
                if (!node.computed && node.object.type === 'Identifier'
                    && node.object.name === this.scope.x87
                    && this.lookupLocal(node.object.name) === undefined)
                {
                    const load = X87_CONSTANTS[node.property.name];
                    if (load === undefined)
                    {
                        this.fail(node, `X87.${node.property.name} is not a constant the x87 `
                            + `loads: ${Object.keys(X87_CONSTANTS).join(', ')}`);
                    }
                    this.x87Only(node, `X87.${node.property.name}`);
                    this.x87Used = true;
                    if (++this.fpu > X87_DEPTH)
                    {
                        this.fail(node, 'the expression holds more doubles at once than the x87 '
                            + 'has room for');
                    }
                    this.x87Clean = false;
                    this.a.emit(0xd9, load);                               // fldl2e and its kin
                    return { where: 'st0', type: 'f64' };
                }
                return this.tableLoad(node);
            default:
                this.fail(node, `${describe(node)} is not in the subset`);
        }
    }

    /**
     * The one type both arms of a conditional have.
     *
     * @param {any} node @param {Type} yes @param {Type} no @returns {Type}
     */
    join(node, yes, no){
        if (!isTyped(yes) || !isTyped(no))
        {
            this.fail(node, 'each arm of a conditional is brought back to 32 bits');
        }
        if (yes === no)
        {
            return yes;
        }
        if (yes === 'nat' || no === 'nat')
        {
            return yes === 'nat' ? no : yes;
        }
        this.fail(node, `one arm is an ${yes} and the other an ${no}`);
    }

    /** @param {any} node @returns {Value} */
    unary(node){
        const a = this.a;
        switch (node.operator)
        {
            case '-':
            {
                const value = this.expr(node.argument);
                if (isFloat(value.type) && this.long)
                {
                    // The sign flipped, as `fchs` flips it: NaN's and zero's too.
                    this.toXmm(value, node.argument);
                    this.masked(0x57, SIGN_MASK);                          // xorpd: the sign
                    return { where: 'st0', type: 'f64' };
                }
                if (isFloat(value.type))
                {
                    this.toSt0(value, node.argument);
                    a.emit(0xd9, 0xe0);                                   // fchs
                    return { where: 'st0', type: 'f64' };
                }
                this.toEax(value, node.argument);
                a.emit(0xf7, 0xd8);                                        // neg eax
                return { where: 'eax', type: 'intish' };
            }
            case '~':
            {
                const value = this.expr(node.argument);
                this.integer(value, node.argument, 'intish');
                this.toEax(value, node.argument);
                a.emit(0xf7, 0xd0);                                        // not eax
                return { where: 'eax', type: 'i32' };
            }
            case '+':
            {
                const value = this.expr(node.argument);
                this.toFloat(value, node.argument);
                return { where: 'st0', type: 'f64' };
            }
            case '!':
                return this.fail(node, '! makes a condition, not a value: write c ? 0 : 1');
            default:
                this.fail(node, `unary ${node.operator} is not in the subset`);
        }
    }

    /** @param {any} node @returns {Value} */
    binary(node){
        const a = this.a;
        const op = node.operator;
        if (['<', '<=', '>', '>=', '===', '!==', '==', '!='].includes(op))
        {
            this.fail(node, 'a comparison is a condition, not a value: write c ? 1 : 0');
        }
        // x | 0 and x >>> 0 bring a value back and emit nothing; a double's
        // are JavaScript's conversions.
        const zero = this.fold(node.right) === 0;
        if (zero && (op === '|' || op === '>>>') && isFloat(this.peekType(node.left)))
        {
            return this.long ? this.toIntegerXmm(node.left, op) : this.toInteger(node.left, op);
        }
        if (['+', '-', '*', '/', '%'].includes(op) && (op === '/' || isFloat(this.peekType(node.left))
            || isFloat(this.peekType(node.right))))
        {
            return this.long ? this.floatBinaryXmm(node) : this.floatBinary(node);
        }
        if (op === '+' || op === '-' || op === '*')
        {
            this.note(node, 'integer');
        }
        if (zero && (op === '|' || op === '>>>'))
        {
            const value = this.expr(node.left);
            this.integer(value, node.left, 'intish');
            if (value.where === 'imm')
            {
                const folded = op === '|' ? value.value | 0 : value.value >>> 0;
                return { where: 'imm', type: constType(folded), value: folded };
            }
            if (value.where === 'var')
            {
                return { where: 'var', type: op === '|' ? 'i32' : 'u32', v: value.v };
            }
            this.toEax(value, node.left);
            return { where: 'eax', type: op === '|' ? 'i32' : 'u32' };
        }
        switch (op)
        {
            case '+':
            case '-':
            {
                const pair = this.pair(node.left, node.right, op === '+');
                this.alu(op === '+' ? ALU.add : ALU.sub, pair);
                return { where: 'eax', type: 'intish' };
            }
            case '&':
            case '|':
            case '^':
            {
                const pair = this.pair(node.left, node.right, true);
                this.alu(op === '&' ? ALU.and : op === '|' ? ALU.or : ALU.xor, pair);
                return { where: 'eax', type: 'i32' };
            }
            case '<<':
            case '>>':
            case '>>>':
            {
                const digit = op === '<<' ? 4 : op === '>>' ? 7 : 5;
                const count = this.fold(node.right);
                if (count !== undefined)
                {
                    const value = this.expr(node.left);
                    this.integer(value, node.left, 'intish');
                    this.toEax(value, node.left);
                    a.emit(0xc1, 0xc0 | digit << 3, count & 31);
                }
                else
                {
                    const { right } = this.pair(node.left, node.right);
                    if (right.where === 'var')
                    {
                        this.op(0x8b, ...this.rm(ECX, right.v));         // mov ecx, [count]
                    }
                    a.emit(0xd3, 0xc0 | digit << 3);                     // shl/sar/shr eax, cl
                }
                return { where: 'eax', type: op === '>>>' ? 'u32' : 'i32' };
            }
            case '*':
            {
                const leftConstant = this.fold(node.left);
                const rightConstant = this.fold(node.right);
                const constant = rightConstant ?? leftConstant;
                const other = rightConstant !== undefined ? node.left : node.right;
                if (constant === undefined || !Number.isInteger(constant)
                    || Math.abs(constant) > 2 ** 20)
                {
                    this.fail(node, '* multiplies by an integer constant up to 2^20; anything '
                        + 'else is Math.imul');
                }
                const value = this.expr(other);
                this.integer(value, other, 'typed');
                this.toEax(value, other);
                a.emit(...fitsByte(constant) ? [0x6b, 0xc0, constant & 0xff]
                    : [0x69, 0xc0, ...le32(constant)]);                 // imul eax, eax, c
                return { where: 'eax', type: 'intish' };
            }
            default:
                this.fail(node, `${op} is not in the subset${op === '%'
                    ? ': there is no integer division' : ''}`);
        }
    }

    /**
     * Notes what an arithmetic node was compiled as, for the tests' model.
     *
     * @param {any} node @param {'rounds' | 'integer'} kind
     */
    note(node, kind){
        const arithmetic = this.scope.arithmetic;
        if (arithmetic === null)
        {
            return;
        }
        const kinds = arithmetic.get(node) ?? new Set();
        kinds.add(kind);
        arithmetic.set(node, kinds);
    }

    /**
     * A double's `+`, `-`, `*`, `/` or `%`, an integer operand converted
     * exactly: the left onto the x87 stack and the right as the memory
     * operand it is (`floatOperand`), or onto the stack too; or, when the
     * right calls nothing, the right onto the stack and the left the operand
     * of the reversed form.
     *
     * @param {any} node @returns {Value}
     */
    floatBinary(node){
        const a = this.a;
        const op = node.operator;
        if (op === '%')
        {
            // fprem is exact, and repeated until C2 says the remainder is whole:
            // the dividend's sign, as JavaScript's remainder has it.
            this.toSt0(this.expr(node.left), node.left);
            this.toSt0(this.expr(node.right), node.right);
            const again = a.fresh('fprem');
            a.emit(0xd9, 0xc9).label(again);                           // fxch
            a.emit(0xd9, 0xf8, 0xdf, 0xe0, 0xf6, 0xc4, 0x04);          // fprem; fnstsw; test ah, 4
            a.jump(CC.ne, again);
            a.emit(0xdd, 0xd9);                                        // fstp st1
            this.fpu--;
            return { where: 'st0', type: 'f64' };
        }
        this.note(node, 'rounds');
        const digit = /** @type {Record<string, number>} */ ({ '+': 0, '*': 1, '-': 4, '/': 6 })[op];
        const right = this.floatOperand(node.right);
        if (right !== null)
        {
            this.toSt0(this.expr(node.left), node.left);
            right(digit);
            return { where: 'st0', type: 'f64' };
        }
        const left = this.callsGuest(node.right) ? null : this.floatOperand(node.left);
        if (left !== null)
        {
            this.toSt0(this.expr(node.right), node.right);
            // fsubr and fdivr: the memory operand on the left.
            left(digit === 4 || digit === 6 ? digit + 1 : digit);
            return { where: 'st0', type: 'f64' };
        }
        this.toSt0(this.expr(node.left), node.left);
        this.toSt0(this.expr(node.right), node.right);
        // faddp, fmulp, fsubp, fdivp st1: ST1 op ST0 into ST1, popped.
        a.emit(0xde, 0xc1 | (digit === 4 ? 5 : digit === 6 ? 7 : digit) << 3);
        this.fpu--;
        return { where: 'st0', type: 'f64' };
    }

    /**
     * An arithmetic instruction's memory operand, when a node is one with
     * nothing to emit first: a double or a float in the frame, an integer
     * in the frame (the `fi` forms, exact), a double or float read through
     * registers alone, a constant of the table. Answers the emitter of the
     * instruction by its digit; null for anything else.
     *
     * @param {any} node @returns {((digit: number) => void) | null}
     */
    floatOperand(node){
        const a = this.a;
        const constant = this.fold(node);
        if (constant !== undefined)
        {
            if (!this.planned?.pool || this.special(constant))
            {
                return null;
            }
            return digit=>{
                this.countConstant();
                a.emit(0xdc, 0x83 | digit << 3).ref(POOL, this.pooled(constant));
            };
        }
        if (node.type === 'Identifier')
        {
            const v = this.lookupLocal(node.name);
            if (v === undefined || 'constant' in v || v.onStack || this.x87.includes(v))
            {
                return null;
            }
            if (isFloat(v.type))
            {
                return digit=>void a.emit(v.type === 'f64' ? 0xdc : 0xd8,
                    ...this.frameAt(digit, v.disp));
            }
            if ((v.type === 'i32' || v.type === 'nat') && v.reg === undefined)
            {
                return digit=>void a.emit(0xda, ...this.rm(digit, v));
            }
            return null;
        }
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier'
            && (node.callee.name === 'f32' || node.callee.name === 'f64')
            && this.helpers.has(node.callee.name) && node.arguments.length === 1)
        {
            const operand = this.registerAddress(node.arguments[0]);
            if (operand === null)
            {
                return null;
            }
            return digit=>void a.emit(node.callee.name === 'f64' ? 0xdc : 0xd8,
                ...memory(digit, operand));
        }
        return null;
    }

    /**
     * Whether an expression calls the guest, which may write what a memory
     * operand read after it would find.
     *
     * @param {any} node @param {Set<any>} [seen]  The inlined functions walked.
     * @returns {boolean}
     */
    callsGuest(node, seen = new Set()){
        if (node === null || typeof node !== 'object')
        {
            return false;
        }
        if (Array.isArray(node))
        {
            return node.some(item=>this.callsGuest(item, seen));
        }
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier')
        {
            const name = node.callee.name;
            if ((name === 'call' || name === 'callStd') && this.helpers.has(name)
                || this.scope.guests.has(name))
            {
                return true;
            }
            const inline = this.scope.inline.get(name);
            if (inline && !seen.has(inline))
            {
                seen.add(inline);
                if (this.callsGuest(inline.body, seen))
                {
                    return true;
                }
            }
        }
        return Object.entries(node).some(([key, child])=>key !== 'loc' && key !== 'range'
            && child !== null && typeof child === 'object' && this.callsGuest(child, seen));
    }

    /** A constant `fldz` or `fld1` loads, with `fchs` for its negative. @param {number} value */
    special(value){
        return value === 0 || value === 1 || value === -1;
    }

    /** Counts a constant read from the table or pushed, a read in a loop weighing more. */
    countConstant(){
        this.constantLoads += LOOP_WEIGHT ** Math.min(this.depth, 6);
    }

    /**
     * A constant's place in the table after the code, which this makes the
     * function's: EBX its base, reached from the pop of `call $+5`.
     *
     * @param {number} value @returns {number}  The byte offset.
     */
    pooled(value){
        let at = this.pool.findIndex(known=>Object.is(known, value)
            || Number.isNaN(known) && Number.isNaN(value));
        if (at < 0)
        {
            at = this.pool.push(value) - 1;
        }
        this.tables.set(POOL, { name: POOL, bytes: new Uint8Array(0), size: 8, signed: false });
        this.saves.add(EBX);
        return at * 8;
    }

    /**
     * Pushes a double constant onto the x87 stack: `fldz` and `fld1` (and
     * their negatives), a read of the table after the code, or pushed
     * through the stack -- as a float when a float holds it.
     *
     * @param {number} value
     */
    loadConstant(value){
        const a = this.a;
        if (this.special(value))
        {
            a.emit(0xd9, value === 0 ? 0xee : 0xe8);                       // fldz; fld1
            if (Object.is(value, -0) || value === -1)
            {
                a.emit(0xd9, 0xe0);                                        // fchs
            }
            return;
        }
        this.countConstant();
        if (this.planned?.pool)
        {
            a.emit(0xdd, 0x83).ref(POOL, this.pooled(value));             // fld qword [ebx+c]
            return;
        }
        const bits = new DataView(new ArrayBuffer(8));
        if (Math.fround(value) === value)
        {
            // push the float; fld dword [esp]; add esp, 4
            bits.setFloat32(0, value, true);
            a.emit(0x68, ...le32(bits.getUint32(0, true)), 0xd9, 0x04, 0x24, 0x83, 0xc4, 0x04);
            return;
        }
        bits.setFloat64(0, value, true);
        // push the two halves; fld qword [esp]; add esp, 8
        a.emit(0x68, ...le32(bits.getUint32(4, true)), 0x68, ...le32(bits.getUint32(0, true)));
        a.emit(0xdd, 0x04, 0x24, 0x83, 0xc4, 0x08);
    }

    /**
     * A double brought to an integer as `| 0` and `>>> 0` bring one, modulo
     * 2^32 after truncation: `fisttp` of the whole, and where that answers
     * the integer indefinite -- past 2^63, an infinity, a NaN -- the value's
     * remainder by 2^32 (`fprem`, exact) truncated instead.
     *
     * @param {any} node @param {string} op @returns {Value}
     */
    toInteger(node, op){
        const a = this.a;
        this.toSt0(this.expr(node), node);
        if (this.fpu + 1 > 8)
        {
            this.fail(node, 'the expression holds more doubles at once than the x87 has room for');
        }
        const fast = a.fresh('whole');
        const done = a.fresh('converted');
        const again = a.fresh('fprem');
        a.emit(0x83, 0xec, 0x08);                                          // sub esp, 8
        a.emit(0xd9, 0xc0, 0xdd, 0x0c, 0x24);                              // fld st0; fisttp [esp]
        a.emit(0x8b, 0x04, 0x24);                                          // mov eax, [esp]
        a.emit(0x81, 0x7c, 0x24, 0x04, ...le32(0x80000000));               // cmp dword [esp+4], hi
        a.jump(CC.ne, fast);
        a.emit(0x85, 0xc0);                                                // test eax, eax
        a.jump(CC.ne, fast);
        a.emit(0x68, ...le32(0x41f00000), 0x6a, 0x00);                     // push 2^32
        a.emit(0xdd, 0x04, 0x24, 0x83, 0xc4, 0x08);                        // fld qword [esp]; add
        a.emit(0xd9, 0xc9).label(again);                                   // fxch
        a.emit(0xd9, 0xf8, 0xdf, 0xe0, 0xf6, 0xc4, 0x04);                  // fprem; fnstsw; test
        a.jump(CC.ne, again);
        a.emit(0xdd, 0xd9, 0xdd, 0x0c, 0x24, 0x8b, 0x04, 0x24);            // fstp st1; fisttp; mov
        a.jump(-1, done);
        a.label(fast);
        a.emit(0xdd, 0xd8);                                                // fstp st0
        a.label(done);
        a.emit(0x83, 0xc4, 0x08);                                          // add esp, 8
        this.fpu--;
        return { where: 'eax', type: op === '|' ? 'i32' : 'u32' };
    }

    /**
     * `X87.name(...)`: the one instruction the name is, its arguments pushed
     * in order.
     *
     * @param {any} node @param {string} name @returns {Value}
     */
    x87Intrinsic(node, name){
        const a = this.a;
        this.x87Only(node, `X87.${name}`);
        /** @param {number} count */
        const pushed = count=>node.arguments.slice(0, count).forEach((/** @type {any} */ arg)=>
            this.toSt0(this.expr(arg), arg));
        /** Room for what an instruction pushes of its own. */
        const room = ()=>{
            if (this.fpu + 1 > 8)
            {
                this.fail(node, 'the expression holds more doubles at once than the x87 has '
                    + 'room for');
            }
        };
        switch (name)
        {
            case 'rint':
                this.arity(node, 1);
                pushed(1);
                this.round(0);
                return { where: 'st0', type: 'f64' };
            case 'f2xm1':
                this.arity(node, 1);
                pushed(1);
                a.emit(0xd9, 0xf0);                                        // f2xm1
                return { where: 'st0', type: 'f64' };
            case 'yl2x':
                this.arity(node, 2);
                pushed(2);
                a.emit(0xd9, 0xf1);                                        // fyl2x
                this.fpu--;
                return { where: 'st0', type: 'f64' };
            case 'scale':
                this.arity(node, 2);
                pushed(2);
                a.emit(0xd9, 0xc9, 0xd9, 0xfd, 0xdd, 0xd9);                // fxch; fscale; fstp st1
                this.fpu--;
                return { where: 'st0', type: 'f64' };
            case 'exponent':
            case 'significand':
                this.arity(node, 1);
                pushed(1);
                room();
                // fxtract: ST0 the significand, ST1 the exponent; one popped.
                a.emit(0xd9, 0xf4, 0xdd, name === 'exponent' ? 0xd8 : 0xd9);
                return { where: 'st0', type: 'f64' };
            default:
                return this.fail(node, `X87.${name} is not one of the x87's here: rint, f2xm1, `
                    + 'yl2x, scale, exponent, significand');
        }
    }

    /**
     * `frndint` under the rounding control given, in the control word's high
     * byte -- the word with only that changed, and put back: the program's
     * precision control and masks stand.
     *
     * @param {number} rc
     */
    round(rc){
        const a = this.a;
        a.emit(0x83, 0xec, 0x04);                                          // sub esp, 4
        a.emit(0xd9, 0x3c, 0x24);                                          // fnstcw [esp]
        a.emit(0x0f, 0xb7, 0x04, 0x24);                                    // movzx eax, word [esp]
        a.emit(0x80, 0xe4, 0xf3);                                          // and ah, 0xf3
        if (rc !== 0)
        {
            a.emit(0x80, 0xcc, rc);                                        // or ah, rc
        }
        a.emit(0x66, 0x89, 0x44, 0x24, 0x02);                              // mov [esp+2], ax
        a.emit(0xd9, 0x6c, 0x24, 0x02);                                    // fldcw [esp+2]
        a.emit(0xd9, 0xfc);                                                // frndint
        a.emit(0xd9, 0x2c, 0x24);                                          // fldcw [esp]
        a.emit(0x83, 0xc4, 0x04);                                          // add esp, 4
    }

    /** @param {any} node @returns {Value} */
    callExpression(node){
        const a = this.a;
        const callee = node.callee;
        if (callee.type === 'MemberExpression' && !callee.computed
            && callee.object.type === 'Identifier' && callee.object.name === 'Math')
        {
            const name = callee.property.name;
            if (name === 'imul')
            {
                this.arity(node, 2);
                const pair = this.pair(node.arguments[0], node.arguments[1], true);
                const right = pair.right;
                if (right.where === 'imm')
                {
                    const imm = right.value | 0;
                    a.emit(...fitsByte(imm) ? [0x6b, 0xc0, imm & 0xff]
                        : [0x69, 0xc0, ...le32(imm)]);
                }
                else if (right.where === 'var')
                {
                    this.op(0x0f, 0xaf, ...this.rm(EAX, right.v));
                }
                else
                {
                    a.emit(0x0f, 0xaf, 0xc1);                          // imul eax, ecx
                }
                return { where: 'eax', type: 'i32' };
            }
            if (this.long && (Object.hasOwn(ROUNDING, name) || name === 'abs' || name === 'sqrt'
                || name === 'fround'))
            {
                this.arity(node, 1);
                this.toXmm(this.expr(node.arguments[0]), node.arguments[0]);
                const x = this.fpu - 1;
                if (name === 'abs')
                {
                    this.masked(0x54, ABS_MASK);                           // andpd: no sign
                }
                else if (name === 'sqrt')
                {
                    this.note(node, 'rounds');
                    this.sse(0xf2, 0x51, x, x);                            // sqrtsd
                }
                else if (name === 'fround')
                {
                    this.sse(0xf2, 0x5a, x, x);                            // cvtsd2ss
                    this.sse(0xf3, 0x5a, x, x);                            // cvtss2sd
                    return { where: 'st0', type: 'f32' };
                }
                else
                {
                    this.roundXmm(name);
                }
                return { where: 'st0', type: 'f64' };
            }
            if (this.long && (Object.hasOwn(MATH_UNARY, name) || name === 'atan2'
                || name === 'log2'))
            {
                this.x87Only(node, `Math.${name}`);
            }
            if (Object.hasOwn(ROUNDING, name) || name === 'abs')
            {
                this.arity(node, 1);
                this.toSt0(this.expr(node.arguments[0]), node.arguments[0]);
                if (name === 'abs')
                {
                    a.emit(0xd9, 0xe1);                                    // fabs
                    return { where: 'st0', type: 'f64' };
                }
                this.round(ROUNDING[name]);
                return { where: 'st0', type: 'f64' };
            }
            if (Object.hasOwn(MATH_UNARY, name))
            {
                this.arity(node, 1);
                this.toSt0(this.expr(node.arguments[0]), node.arguments[0]);
                if (name === 'sqrt')
                {
                    this.note(node, 'rounds');
                }
                if ((name === 'tan' || name === 'atan') && this.fpu + 1 > 8)
                {
                    this.fail(node, 'the expression holds more doubles at once than the x87 has '
                        + 'room for');
                }
                a.emit(...MATH_UNARY[name]);
                return { where: 'st0', type: 'f64' };
            }
            if (name === 'atan2')
            {
                this.arity(node, 2);
                this.toSt0(this.expr(node.arguments[0]), node.arguments[0]);
                this.toSt0(this.expr(node.arguments[1]), node.arguments[1]);
                a.emit(0xd9, 0xf3);                                        // fpatan
                this.fpu--;
                return { where: 'st0', type: 'f64' };
            }
            if (name === 'log2')
            {
                // fld1, the argument, fyl2x: 1 times log2 of it.
                this.arity(node, 1);
                this.toSt0({ where: 'imm', type: 'nat', value: 1 }, node);
                this.toSt0(this.expr(node.arguments[0]), node.arguments[0]);
                a.emit(0xd9, 0xf1);                                        // fyl2x
                this.fpu--;
                return { where: 'st0', type: 'f64' };
            }
            if (name === 'fround')
            {
                this.arity(node, 1);
                this.toSt0(this.expr(node.arguments[0]), node.arguments[0]);
                // sub esp, 4; fstp dword [esp]; fld dword [esp]; add esp, 4
                a.emit(0x83, 0xec, 0x04, 0xd9, 0x1c, 0x24, 0xd9, 0x04, 0x24, 0x83, 0xc4, 0x04);
                return { where: 'st0', type: 'f32' };
            }
            if (Object.hasOwn(MATH_REFUSED, name))
            {
                this.fail(node, `Math.${name} is no one x87 instruction, and its sequence is not `
                    + `JavaScript's to the last bit: write ${MATH_REFUSED[name]}`);
            }
            this.fail(node, `Math.${name} is not in the subset`);
        }
        if (callee.type === 'MemberExpression' && !callee.computed
            && callee.object.type === 'Identifier' && callee.object.name === this.scope.x87
            && this.lookupLocal(callee.object.name) === undefined)
        {
            return this.x87Intrinsic(node, callee.property.name);
        }
        if (callee.type !== 'Identifier')
        {
            this.fail(node, 'only a helper, a Math function, X87\'s or a module-level function '
                + 'of one return is called');
        }
        const name = callee.name;
        if (this.helpers.has(name))
        {
            if (Object.hasOwn(LOADS, name))
            {
                this.arity(node, 1);
                const load = LOADS[name];
                const operand = this.address(node.arguments[0]);
                if (isFloat(load.type) && this.long)
                {
                    // movsd, or movss and widened: a float's every value a double holds.
                    const one = this.wrapped(operand, EAX);
                    const x = this.pushXmm(node);
                    this.op(load.type === 'f64' ? 0xf2 : 0xf3, 0x0f, 0x10, ...this.mem(x, one));
                    if (load.type === 'f32')
                    {
                        this.sse(0xf3, 0x5a, x, x);                        // cvtss2sd
                    }
                    return { where: 'st0', type: /** @type {'f64' | 'f32'} */ (load.type) };
                }
                if (isFloat(load.type))
                {
                    this.x87Clean = false;
                    this.x87Used = true;
                    if (++this.fpu > X87_DEPTH)
                    {
                        this.fail(node, 'the expression holds more doubles at once than the x87 '
                            + 'has room for');
                    }
                    a.emit(...load.op, ...memory(0, operand));
                    return { where: 'st0', type: /** @type {'f64' | 'f32'} */ (load.type) };
                }
                const one = this.wrapped(operand, EAX);
                const modrm = this.mem(EAX, one);
                this.op(...load.op, ...modrm);
                this.noteLoad(modrm.length - 1);
                return { where: 'eax', type: load.type };
            }
            if (name === 'call' || name === 'callStd')
            {
                this.guestCall(node, name === 'callStd');
                return { where: 'eax', type: 'i32' };
            }
            if (name === 'compareExchange')
            {
                return this.compareExchange(node);
            }
            if (name === 'mxcsr')
            {
                this.arity(node, 0);
                a.emit(0x83, 0xec, 0x04);                                  // sub esp, 4
                a.emit(0x0f, 0xae, 0x1c, 0x24);                            // stmxcsr [esp]
                a.emit(0x8b, 0x04, 0x24);                                  // mov eax, [esp]
                a.emit(0x83, 0xc4, 0x04);                                  // add esp, 4
                return { where: 'eax', type: 'nat' };
            }
            if (name === 'controlWord' || name === 'statusWord')
            {
                this.arity(node, 0);
                this.x87Used = true;
                if (name === 'controlWord')
                {
                    a.emit(0x83, 0xec, 0x04);                              // sub esp, 4
                    a.emit(0xd9, 0x3c, 0x24);                              // fnstcw [esp]
                    a.emit(0x0f, 0xb7, 0x04, 0x24);                        // movzx eax, word [esp]
                    a.emit(0x83, 0xc4, 0x04);                              // add esp, 4
                }
                else
                {
                    a.emit(0xdf, 0xe0);                                    // fnstsw ax
                    a.emit(0x25, ...le32(0xc7ff));                         // and eax, ~top
                }
                return { where: 'eax', type: 'nat' };
            }
            if (name === 'host')
            {
                this.fail(node, 'host() is only returned: return host()');
            }
            this.fail(node, `${name} is a statement: it answers nothing`);
        }
        if (HELPERS.has(name))
        {
            this.fail(node, `${name} is taken from the guest in the first parameter: { ${name} }`);
        }
        if (this.scope.guests.has(name) && this.lookupLocal(name) === undefined)
        {
            return this.moduleCall(node, name);
        }
        const inline = this.scope.inline.get(name);
        if (inline && this.lookupLocal(name) === undefined)
        {
            return this.inline(node, inline);
        }
        this.fail(node, `${name} is not a helper, nor a module-level function of one return`);
    }

    /**
     * A call to another `@guestCode` function of the module: the helpers it
     * takes named first, then its integers pushed as its convention takes them,
     * and `call rel32` to its code, which goes after this function's.
     *
     * @param {any} node @param {string} name @returns {Value}
     */
    moduleCall(node, name){
        const a = this.a;
        if (name === this.node.id.name)
        {
            this.fail(node, `${name} calls itself`);
        }
        const callee = this.scope.compiledOf(name, node);
        if (callee.host !== undefined)
        {
            this.fail(node, `${name} hands calls to the host, which it has none of here`);
        }
        if (callee.convention === 'thiscall' || callee.params.some(type=>type !== 'i32'
            && type !== 'u32') || (callee.returns !== 'i32' && callee.returns !== 'u32'
            && callee.returns !== 'void'))
        {
            this.fail(node, `${name} takes and answers integers, cdecl or stdcall`);
        }
        const [helpers, ...args] = node.arguments;
        const named = new Set(helpers?.type === 'ObjectExpression'
            ? helpers.properties.map((/** @type {any} */ property)=>(property.type === 'Property'
                && property.shorthand && this.helpers.has(property.key.name)
                ? property.key.name : '')) : []);
        if (callee.uses.length > 0 && (helpers?.type !== 'ObjectExpression'
            || named.has('') || callee.uses.some(use=>!named.has(use))))
        {
            this.fail(helpers ?? node, `${name} is given the helpers it takes, by this `
                + `function's names: { ${callee.uses.join(', ')} }`);
        }
        const given = callee.uses.length > 0 || helpers?.type === 'ObjectExpression'
            ? args : node.arguments;
        if (given.length !== callee.params.length)
        {
            this.fail(node, `${name} takes ${callee.params.length} arguments after its helpers`);
        }
        if (this.fpu !== 0)
        {
            this.fail(node, 'a call is made with the x87 stack empty, as cdecl has it');
        }
        this.calls = true;
        this.x87Clean = false;
        for (const key of this.live)
        {
            this.acrossCalls.add(key);
        }
        if (this.long)
        {
            this.longCall(given, null, ()=>void a.call(`fn:${name}`));
            this.callees.add(name);
            return { where: 'eax', type: callee.returns === 'u32' ? 'u32' : 'i32' };
        }
        const bytes = given.length * 4;
        if (bytes > 0)
        {
            a.emit(...fitsByte(bytes) ? [0x83, 0xec, bytes] : [0x81, 0xec, ...le32(bytes)]);
        }
        this.grew(bytes);
        given.forEach((/** @type {any} */ argument, /** @type {number} */ i)=>{
            const value = this.expr(argument);
            this.integer(value, argument, 'typed');
            this.toEax(value, argument);
            a.emit(0x89, ...memory(EAX, { base: ESP, disp: i * 4 }));       // mov [esp+4i], eax
        });
        a.call(`fn:${name}`);
        // A stdcall callee has popped its arguments itself.
        if (bytes > 0 && callee.convention === 'cdecl')
        {
            a.emit(...fitsByte(bytes) ? [0x83, 0xc4, bytes] : [0x81, 0xc4, ...le32(bytes)]);
        }
        this.grew(-bytes);
        this.callees.add(name);
        return { where: 'eax', type: callee.returns === 'u32' ? 'u32' : 'i32' };
    }

    /** @param {any} node @param {number} count */
    arity(node, count){
        if (node.arguments.length !== count)
        {
            this.fail(node, `takes ${count} argument${count === 1 ? '' : 's'}`);
        }
        const spread = node.arguments.find((/** @type {any} */ arg)=>arg.type === 'SpreadElement');
        if (spread)
        {
            this.fail(spread, 'no spread');
        }
    }

    /**
     * A module-level function of one return, inlined: each argument into a
     * variable of its own, in order, then the expression.
     *
     * @param {any} node @param {any} fn @returns {Value}
     */
    inline(node, fn){
        if (this.inlining > 8)
        {
            this.fail(node, 'inlined too deep: a function calls itself');
        }
        this.arity(node, fn.params.length);
        /** @type {Map<string, Variable | { constant: number }>} */
        const bound = new Map();
        fn.params.forEach((/** @type {any} */ param, /** @type {number} */ i)=>{
            if (param.type !== 'Identifier')
            {
                this.fail(param, 'an inlined function\'s parameter is a name');
            }
            const argument = node.arguments[i];
            const constant = this.fold(argument);
            if (constant !== undefined)
            {
                bound.set(param.name, { constant });
                return;
            }
            // A variable is read where it is: nothing in an expression assigns.
            const simple = this.simple(argument);
            if (simple?.where === 'var')
            {
                bound.set(param.name, { ...simple.v, mutable: false });
                return;
            }
            // A double's too, as itself: an x87 parameter's reads are counted by it.
            const local = argument.type === 'Identifier' ? this.lookupLocal(argument.name)
                : undefined;
            if (local !== undefined && !('constant' in local) && isFloat(local.type)
                && !local.onStack)
            {
                bound.set(param.name, local);
                return;
            }
            const value = this.expr(argument);
            if (value.type === 'intish')
            {
                this.fail(argument, 'an argument is brought back to 32 bits');
            }
            // Keyed by the argument: each place a function is inlined has its own.
            const v = this.newVariable(param.name,
                /** @type {Variable['type']} */ (value.type), false, argument);
            if (isFloat(v.type))
            {
                this.spill(v, value, argument);
            }
            else
            {
                this.store(v, value, argument);
            }
            bound.set(param.name, v);
        });
        const saved = this.scopes;
        this.scopes = [bound];
        this.inlining++;
        const body = fn.body.type === 'BlockStatement' ? fn.body.body[0].argument : fn.body;
        try
        {
            return this.expr(body);
        }
        finally
        {
            this.inlining--;
            this.scopes = saved;
            for (const argument of node.arguments)
            {
                this.live.delete(argument);
            }
        }
    }

    /**
     * The memory operand of an address made of variables in registers and a
     * constant, with nothing to emit first; null for any other.
     *
     * @param {any} node @returns {import('./x86.mjs').Memory | null}
     */
    registerAddress(node){
        let disp = 0;
        let inner = node;
        while (inner.type === 'BinaryExpression' && (inner.operator === '+'
            || inner.operator === '-'))
        {
            const constant = this.fold(inner.right);
            if (constant === undefined || !Number.isInteger(constant)
                || Math.abs(constant) >= 2 ** 31)
            {
                break;
            }
            disp = disp + (inner.operator === '+' ? constant : -constant) | 0;
            inner = inner.left;
        }
        if (inner.type === 'BinaryExpression' && inner.operator === '+')
        {
            const left = this.registerOf(inner.left);
            const right = this.registerOf(inner.right);
            return left !== undefined && right !== undefined
                ? { base: left, index: right, disp } : null;
        }
        const reg = this.registerOf(inner);
        return reg === undefined ? null : { base: reg, disp };
    }

    /**
     * An integer load -- a helper's, or a table's by an index in a register
     * -- that can be made into any register with nothing emitted before it:
     * its opcode, the ModRM for a destination, and its type. Null for anything
     * else.
     *
     * @param {any} node
     * @returns {{ emit: (reg: number) => void, type: Type } | null}
     */
    registerLoad(node){
        if (node.type === 'CallExpression' && node.callee.type === 'Identifier'
            && this.helpers.has(node.callee.name) && Object.hasOwn(LOADS, node.callee.name)
            && !isFloat(LOADS[node.callee.name].type) && node.arguments.length === 1)
        {
            const operand = this.registerAddress(node.arguments[0]);
            const load = LOADS[node.callee.name];
            return operand === null ? null : {
                emit: reg=>{
                    const one = this.wrapped(operand, reg);
                    this.op(...load.op, ...this.mem(reg, one));
                },
                type: load.type,
            };
        }
        const table = node.type === 'MemberExpression' && node.computed
            && node.object.type === 'Identifier' && this.lookupLocal(node.object.name) === undefined
            ? this.scope.tables.get(node.object.name) : undefined;
        if (table === undefined)
        {
            return null;
        }
        const { index, addend } = this.tableIndex(node, table);
        const at = this.registerOf(index);
        if (at === undefined)
        {
            return null;
        }
        this.tables.set(table.name, table);
        this.saves.add(this.tableBase);
        return {
            emit: reg=>void this.tableOperand(tableOp(table), reg, table, at).ref(table.name,
                addend),
            type: tableType(table),
        };
    }

    /**
     * `op reg, [base + index * size + disp32]` of a table, the displacement
     * left for the reference that follows.
     *
     * @param {number[]} opcode @param {number} reg @param {TableInfo} table
     * @param {number} index
     */
    tableOperand(opcode, reg, table, index){
        return this.op(...opcode, 0x84 | this.low(reg, Rex.R) << 3,
            tableSib(table, this.low(index, Rex.X), this.low(this.tableBase, Rex.B)));
    }

    /**
     * Answers the memory operand that names an address: the variables that
     * are in registers named as they are, the rest emitted into EAX (and
     * ECX), and the constants added or taken away the displacement.
     *
     * @param {any} node @returns {import('./x86.mjs').Memory}
     */
    address(node){
        let disp = 0;
        let inner = node;
        while (inner.type === 'BinaryExpression' && (inner.operator === '+'
            || inner.operator === '-'))
        {
            const constant = this.fold(inner.right);
            if (constant === undefined || !Number.isInteger(constant)
                || Math.abs(constant) >= 2 ** 31)
            {
                break;
            }
            // An address wraps at 2^32, as the helpers' does.
            disp = disp + (inner.operator === '+' ? constant : -constant) | 0;
            inner = inner.left;
        }
        if (inner.type === 'BinaryExpression' && inner.operator === '+')
        {
            const left = this.registerOf(inner.left);
            const right = this.registerOf(inner.right);
            if (left !== undefined && right !== undefined)
            {
                return { base: left, index: right, disp };
            }
            if (left !== undefined || right !== undefined)
            {
                // The other part into EAX: nothing in it can change a register.
                const other = left !== undefined ? inner.right : inner.left;
                const value = this.expr(other);
                this.integer(value, other, 'intish');
                this.toEax(value, other);
                return { base: EAX, index: /** @type {number} */ (left ?? right), disp };
            }
            const { right: operand } = this.pair(inner.left, inner.right);
            if (operand.where === 'imm')
            {
                return { base: EAX, disp: disp + operand.value | 0 };
            }
            if (operand.where === 'var')
            {
                this.op(0x8b, ...this.rm(ECX, operand.v));                 // mov ecx, [right]
            }
            return { base: EAX, index: ECX, disp };
        }
        const reg = this.registerOf(inner);
        if (reg !== undefined)
        {
            return { base: reg, disp };
        }
        const value = this.expr(inner);
        this.integer(value, inner, 'intish');
        this.toEax(value, inner);
        return { base: EAX, disp };
    }

    /**
     * An address of two registers as long mode reaches it: made into one by a
     * 32-bit `lea` into `scratch`, which wraps at 2^32 as the i386's address
     * and the helpers' do, where the 64-bit sum of a pointer and an index
     * holding a negative i32 would land 4 GiB past it. As it is at 32 bits,
     * and for one register.
     *
     * @param {import('./x86.mjs').Memory} operand @param {number} scratch
     * @returns {import('./x86.mjs').Memory}
     */
    wrapped(operand, scratch){
        if (!this.long || operand.index === undefined)
        {
            return operand;
        }
        this.op(0x8d, ...this.mem(scratch, operand));                      // lea scratch, [..]
        return { base: scratch };
    }

    /** @param {any} node @returns {Value} */
    tableLoad(node){
        this.saves.add(this.tableBase);
        if (!node.computed || node.object.type !== 'Identifier')
        {
            this.fail(node, 'a member is read only from a table, by index');
        }
        const table = this.scope.tables.get(node.object.name);
        if (!table || this.lookupLocal(node.object.name) !== undefined)
        {
            this.fail(node.object, `${node.object.name} is not an exported module-level typed `
                + 'array');
        }
        this.tables.set(table.name, table);
        const { index, addend } = this.tableIndex(node, table);
        const value = this.expr(index);
        this.integer(value, index, 'intish');
        const at = value.where === 'var' && value.v.reg !== undefined ? value.v.reg : EAX;
        if (at === EAX)
        {
            this.toEax(value, index);
        }
        // op eax, [ebx + index*scale + disp32]
        this.tableOperand(tableOp(table), EAX, table, at).ref(table.name, addend);
        this.noteLoad(1);
        return { where: 'eax', type: tableType(table) };
    }

    /**
     * A table read's index, and a constant added to it as the bytes it moves.
     *
     * @param {any} node @param {TableInfo} table
     */
    tableIndex(node, table){
        let index = node.property;
        let addend = 0;
        if (index.type === 'BinaryExpression' && (index.operator === '+' || index.operator === '-'))
        {
            const constant = this.fold(index.right);
            if (constant !== undefined && Math.abs(constant) < 2 ** 20)
            {
                addend = (index.operator === '+' ? constant : -constant) * table.size;
                index = index.left;
            }
        }
        return { index, addend };
    }

    /**
     * compareExchange(address, expected, value): `lock cmpxchg` of the dword
     * at the address, answering what it held -- `expected` where the value
     * was stored. The value and the address are held while the expected
     * value is made in EAX, where the instruction takes it; EDX, which a
     * variable may have, carries the value and is put back.
     *
     * @param {any} node @returns {Value}
     */
    compareExchange(node){
        const a = this.a;
        this.arity(node, 3);
        const [address, expected, value] = node.arguments;
        for (const argument of [value, address])
        {
            const made = this.expr(argument);
            this.integer(made, argument, 'intish');
            this.toEax(made, argument);
            this.hold();                                                   // push eax
        }
        const made = this.expr(expected);
        this.integer(made, expected, 'intish');
        this.toEax(made, expected);
        this.unhold(ECX);                                                  // pop ecx: the address
        a.emit(0x52);                                                      // push edx
        this.grew(4);
        a.emit(0x8b, 0x54, 0x24, 0x04);                                    // mov edx, [esp+4]
        a.emit(0xf0, 0x0f, 0xb1, 0x11);                                    // lock cmpxchg [ecx],edx
        a.emit(0x5a);                                                      // pop edx
        this.grew(-4);
        this.unhold(ECX);                                                  // pop ecx: the value
        return { where: 'eax', type: 'u32' };
    }

    /** @param {any} node @param {string} name */
    storeCall(node, name){
        const a = this.a;
        this.arity(node, 2);
        const stored = this.simple(node.arguments[1]);
        if (name === 'setU8' && stored?.where === 'var')
        {
            this.byteStored.add(stored.v.key);
        }
        const operand = this.address(node.arguments[0]);
        const scratch = [operand.base, operand.index].some(reg=>reg === EAX || reg === ECX);
        if (!scratch)
        {
            // Named by registers the value cannot change: stored where it is.
            this.storeTo(operand, node.arguments[1], name);
            return;
        }
        if (operand.index !== undefined)
        {
            // A 32-bit lea, whose sum wraps as the address does in long mode too.
            this.op(0x8d, ...this.mem(EAX, { base: operand.base, index: operand.index })); // lea
        }
        this.hold();                                                       // push eax
        const value = this.expr(node.arguments[1]);
        if (FLOAT_STORES.has(name) && this.long)
        {
            this.toXmm(value, node.arguments[1]);
            this.unhold(ECX);
            this.storeXmm(name === 'setF64',
                field=>this.mem(field, { base: ECX, disp: operand.disp ?? 0 }));
            return;
        }
        if (FLOAT_STORES.has(name))
        {
            this.toSt0(value, node.arguments[1]);
            this.unhold(ECX);                                              // pop ecx
            a.emit(...STORES[name], ...memory(3, { base: ECX, disp: operand.disp ?? 0 }));
            this.fpu--;
            return;
        }
        this.integer(value, node.arguments[1], 'intish');
        this.toEax(value, node.arguments[1]);
        this.unhold(ECX);                                                  // pop ecx
        a.emit(...STORES[name], ...memory(EAX, { base: ECX, disp: operand.disp ?? 0 }));
    }

    /**
     * A store to an operand no expression changes: a constant as it is, any
     * other value from EAX or ST0.
     *
     * @param {import('./x86.mjs').Memory} given @param {any} node @param {string} name
     */
    storeTo(given, node, name){
        const a = this.a;
        const value = this.expr(node);
        if (FLOAT_STORES.has(name) && this.long)
        {
            this.toXmm(value, node);
            const operand = this.wrapped(given, ECX);
            this.storeXmm(name === 'setF64', field=>this.mem(field, operand));
            return;
        }
        if (FLOAT_STORES.has(name))
        {
            this.toSt0(value, node);
            a.emit(...STORES[name], ...memory(3, given));                  // fstp dword/qword
            this.fpu--;
            return;
        }
        this.integer(value, node, 'intish');
        // ECX holds nothing now: the value is a constant, a variable, or in EAX.
        const operand = this.wrapped(given, ECX);
        if (value.where === 'var' && value.v.reg !== undefined
            && (name !== 'setU8' || value.v.reg === EDX || value.v.reg === EBX
                || value.v.reg >= 8))
        {
            // ESI, EDI and EBP have no low byte of their own without a REX
            // prefix (R8 to R11 have theirs with the one they need anyway).
            this.op(...STORES[name], ...this.mem(value.v.reg, operand));
            return;
        }
        if (value.where === 'imm')
        {
            const imm = value.value;
            this.op(...name === 'setU8' ? [0xc6, ...this.mem(0, operand), imm & 0xff]
                : name === 'setU16' ? [0x66, 0xc7, ...this.mem(0, operand), imm & 0xff,
                    imm >>> 8 & 0xff]
                    : [0xc7, ...this.mem(0, operand), ...le32(imm)]);
            return;
        }
        this.toEax(value, node);
        this.op(...STORES[name], ...this.mem(EAX, operand));
    }

    /**
     * copyUp, copyDown and fill: `rep movsd` or `rep stosd` for the whole
     * dwords and the byte forms for the rest. Each turn of a `rep` translated
     * code takes one element at a time (a page holding code, an element
     * across a page) counts as an instruction, so a dword a turn is a quarter of the turns
     * (one it moves in bulk counts by its bytes either way), and the
     * bytes land as the byte form leaves them -- except where a copy's two
     * ends are one to three bytes apart, and a dword read would take bytes
     * the byte form had already overwritten: that copy is bytes throughout.
     *
     * @param {any} node @param {string} name
     */
    bulk(node, name){
        const a = this.a;
        this.arity(node, 3);
        this.bulkUsed = true;
        this.saves.add(ESI);
        this.saves.add(EDI);
        // Where each argument goes: the destination, the source or the byte, the count.
        const into = name === 'fill' ? [EDI, EAX, ECX] : [EDI, ESI, ECX];
        if (this.long)
        {
            // Each straight into its register, in order: no expression
            // writes ESI or EDI, which no variable here has either. A fill's
            // byte waits in ESI while the count is made in EAX.
            node.arguments.forEach((/** @type {any} */ argument, /** @type {number} */ i)=>{
                const value = this.expr(argument);
                this.integer(value, argument, 'intish');
                const reg = i === 1 ? ESI : into[i];
                if (value.where === 'eax')
                {
                    this.op(0x89, this.regs(EAX, reg));                    // mov reg, eax
                }
                else
                {
                    this.into(value, reg);
                }
            });
            if (name === 'fill')
            {
                a.emit(0x89, 0xf0);                                        // mov eax, esi
            }
        }
        else
        {
            for (const argument of node.arguments)
            {
                const value = this.expr(argument);
                this.integer(value, argument, 'intish');
                this.toEax(value, argument);
                this.hold();                                               // push eax
            }
            for (const reg of [...into].reverse())
            {
                this.unhold(reg);                                          // pop ecx; pop esi; ...
            }
        }
        // In long mode 0x48 is a REX prefix, not `dec eax`.
        const decEax = this.long ? [0xff, 0xc8] : [0x48];
        if (name === 'fill')
        {
            a.emit(0x0f, 0xb6, 0xc0, 0x69, 0xc0, ...le32(0x01010101));    // the byte, four times
            a.emit(0x89, 0xca, 0xc1, 0xe9, 0x02, 0xf3, 0xab);          // edx = n; rep stosd
            a.emit(0x89, 0xd1, 0x83, 0xe1, 0x03, 0xf3, 0xaa);          // n & 3; rep stosb
            return;
        }
        const bytes = a.fresh('bytes');
        if (name === 'copyUp')
        {
            // One to three bytes ahead of the source: bytes throughout.
            a.emit(0x89, 0xf8, 0x29, 0xf0, ...decEax, 0x83, 0xf8, 0x03); // eax = edi - esi - 1
            a.jump(CC.b, bytes);
            a.emit(0x89, 0xca, 0xc1, 0xe9, 0x02, 0xf3, 0xa5);          // edx = n; rep movsd
            a.emit(0x89, 0xd1, 0x83, 0xe1, 0x03);                      // ecx = n & 3
            a.label(bytes);
            a.emit(0xf3, 0xa4);                                            // rep movsb
            return;
        }
        // From the last byte of each, with the direction flag set and cleared
        // again: the top n & 3 bytes, then the dwords below them.
        const done = a.fresh('done');
        a.emit(0x89, 0xf0, 0x29, 0xf8, ...decEax, 0x83, 0xf8, 0x03);   // eax = esi - edi - 1
        a.emit(0x8d, 0x74, 0x0e, 0xff, 0x8d, 0x7c, 0x0f, 0xff, 0xfd);  // lea esi/edi, ...; std
        a.jump(CC.b, bytes);
        a.emit(0x89, 0xca, 0x83, 0xe1, 0x03, 0xf3, 0xa4);              // edx = n; rep movsb
        a.emit(0x83, 0xee, 0x03, 0x83, 0xef, 0x03);                    // esi, edi at a dword
        a.emit(0x89, 0xd1, 0xc1, 0xe9, 0x02, 0xf3, 0xa5);              // n >> 2; rep movsd
        a.jump(-1, done);
        a.label(bytes);
        a.emit(0xf3, 0xa4);                                                // rep movsb
        a.label(done);
        a.emit(0xfc);                                                      // cld
    }

    /** A constant or a variable into a register. @param {Value} value @param {number} reg */
    into(value, reg){
        if (value.where === 'imm')
        {
            this.op(...value.value === 0 ? [0x31, this.regs(reg, reg)]          // xor reg, reg
                : [0xb8 | this.low(reg, Rex.B), ...le32(value.value)]);         // mov reg, imm
            return;
        }
        this.op(0x8b, ...this.rm(reg, /** @type {{ v: Variable }} */ (value).v)); // mov reg, [v]
    }

    /** `push` a constant or a variable. @param {Value} value */
    pushOperand(value){
        if (value.where === 'imm')
        {
            const imm = value.value | 0;
            this.a.emit(...fitsByte(imm) ? [0x6a, imm & 0xff] : [0x68, ...le32(imm)]);
        }
        else if (value.where === 'var' && value.v.reg !== undefined)
        {
            this.use(value.v);
            this.a.emit(0x50 | value.v.reg);                                // push reg
        }
        else if (value.where === 'var')
        {
            this.a.emit(0xff, ...this.rm(6, value.v));                      // push [v]
        }
    }

    /**
     * call(fn, ...args): a cdecl call through a pointer, the arguments
     * evaluated in order into the space they are passed in.
     *
     * @param {any} node
     */
    guestCall(node, stdcall = false){
        const a = this.a;
        const [target, ...args] = node.arguments;
        if (!target)
        {
            this.fail(node, 'call(fn, ...args) names the function');
        }
        if (this.fpu !== 0)
        {
            this.fail(node, 'a call is made with the x87 stack empty, as cdecl has it');
        }
        if (args.length > 30)
        {
            this.fail(node, 'call() passes at most thirty arguments');
        }
        this.calls = true;
        this.x87Clean = false;
        for (const key of this.live)
        {
            this.acrossCalls.add(key);
        }
        if (this.long)
        {
            // call qword [rsp + the target's slot]: one convention at 64 bits.
            this.longCall(args, target, at=>void a.emit(0xff,
                ...memory(2, { base: ESP, disp: at })));
            return;
        }
        const bytes = args.length * 4;
        const simple = [target, ...args].map(arg=>this.simple(arg));
        if (simple.every(value=>value !== null))
        {
            // Constants and variables: nothing to evaluate in order, so each
            // is pushed where it goes, the last first.
            for (const [i, value] of [...simple].entries())
            {
                this.integer(/** @type {Value} */ (value), [target, ...args][i], 'typed');
            }
            for (const value of simple.slice(1).reverse())
            {
                // The operand's address is taken before ESP moves.
                this.pushOperand(/** @type {Value} */ (value));
                this.grew(4);
            }
            const fn = /** @type {Value} */ (simple[0]);
            if (fn.where === 'var')
            {
                a.emit(0xff, ...this.rm(2, fn.v));                         // call [fn]
            }
            else
            {
                this.toEax(fn, target);
                a.emit(0xff, 0xd0);                                        // call eax
            }
            // A stdcall callee has popped its arguments itself.
            if (bytes > 0 && !stdcall)
            {
                a.emit(0x83, 0xc4, bytes);                                 // add esp, 4n
            }
            this.grew(-bytes);
            return;
        }
        const fn = this.expr(target);
        this.integer(fn, target, 'typed');
        this.toEax(fn, target);
        a.emit(0x50);                                                      // push eax
        if (bytes > 0)
        {
            a.emit(0x83, 0xec, bytes);                                     // sub esp, 4n
        }
        this.grew(bytes + 4);
        args.forEach((/** @type {any} */ argument, /** @type {number} */ i)=>{
            const value = this.expr(argument);
            this.integer(value, argument, 'typed');
            this.toEax(value, argument);
            a.emit(0x89, ...memory(EAX, { base: ESP, disp: i * 4 }));       // mov [esp+4i], eax
        });
        a.emit(0xff, ...memory(2, { base: ESP, disp: bytes }));            // call [esp+4n]
        a.emit(0x83, 0xc4, stdcall ? 4 : bytes + 4);                       // add esp, (4n+)4
        this.grew(-(bytes + 4));
    }

    /**
     * A call under the x64 convention: the target, when it is a pointer, and
     * the arguments evaluated in order into an area made below RSP -- each
     * argument in its slot, the first four the home space the callee may
     * write, the target past them -- the first four then loaded into RCX,
     * RDX, R8 and R9, and RSP a multiple of 16 at the call. Each slot is
     * written whole, the integer zero-extended, so a callee reading a pointer
     * from it reads the address. The answer is the low half of RAX, made
     * whole again: an address the code reaches through RAX next is the
     * callee's 32 bits, not what it left above them.
     *
     * @param {any[]} args  The argument nodes.
     * @param {any} target  The pointer's node, or null.
     * @param {(at: number) => void} emitCall  Emits the call, the target's
     *     slot `at` bytes above RSP.
     */
    longCall(args, target, emitCall){
        const a = this.a;
        const slots = Math.max(args.length, ARGUMENTS_64.length);
        const area = slots * 8 + (target === null ? 0 : 8);
        // Below RSP as the call found it: the return address, the registers
        // saved on the stack, the variables and what expressions pushed; the
        // area makes it a multiple of 16, as RSP was before the caller's call.
        const { locals, saved, pushed } = this.planned?.frame ?? this.frame();
        const below = 8 + (pushed ? saved * 8 : 0) + locals + this.pushed;
        const size = area + (16 - (below + area) % 16) % 16;
        a.emit(...moveStack64(-size));
        this.grew(size);
        const operands = [...target === null ? [] : [{ node: target, at: slots * 8 }],
            ...args.map((/** @type {any} */ node, /** @type {number} */ i)=>({ node, at: i * 8 }))];
        for (const { node, at } of operands)
        {
            const value = this.expr(node);
            this.integer(value, node, 'typed');
            this.toEax(value, node);
            a.emit(...storeQuad(EAX, at));                                 // mov [rsp+at], rax
        }
        for (let i = 0; i < Math.min(args.length, ARGUMENTS_64.length); i++)
        {
            a.emit(...loadQuad(ARGUMENTS_64[i], i * 8));                   // mov arg, [rsp+8i]
        }
        emitCall(slots * 8);
        a.emit(...moveStack64(size));
        this.grew(-size);
        a.emit(0x89, 0xc0);                                                // mov eax, eax
    }
}

/**
 * Register-to-register moves made as if all at once: each destination
 * written once every move that reads it has, a cycle broken through RAX,
 * which none of them names.
 *
 * @param {{ from: number, to: number, quad: boolean }[]} moves  Each `to` once.
 * @returns {number[]}
 */
function parallelMove(moves){
    const pending = moves.filter(({ from, to })=>from !== to).map(move=>({ ...move }));
    /** @type {number[]} */
    const bytes = [];
    while (pending.length > 0)
    {
        const ready = pending.findIndex(({ to })=>!pending.some(({ from })=>from === to));
        if (ready >= 0)
        {
            const [{ from, to, quad }] = pending.splice(ready, 1);
            bytes.push(...moveRegister(to, from, quad));
            continue;
        }
        const aside = pending[0].from;
        bytes.push(...moveRegister(EAX, aside, true));
        for (const move of pending)
        {
            if (move.from === aside)
            {
                move.from = EAX;
            }
        }
    }
    return bytes;
}

/**
 * Whether control cannot fall out of the end of a statement.
 *
 * @param {any} node @returns {boolean}
 */
function ends(node){
    switch (node.type)
    {
        case 'ReturnStatement':
            return true;
        case 'BlockStatement':
            return node.body.length > 0 && ends(node.body[node.body.length - 1]);
        case 'IfStatement':
            return !!node.alternate && ends(node.consequent) && ends(node.alternate);
        case 'ForStatement':
        case 'WhileStatement':
            // A loop with no test, and no break of its own, is left only by a return.
            return (!node.test || node.test.type === 'Literal' && node.test.value === true)
                && !breaks(node.body);
        default:
            return false;
    }
}

/**
 * Whether a loop's body breaks out of it: a `break` not inside a loop of its own.
 *
 * @param {any} node @returns {boolean}
 */
function breaks(node){
    switch (node?.type)
    {
        case 'BreakStatement':
            return true;
        case 'BlockStatement':
            return node.body.some(breaks);
        case 'IfStatement':
            return breaks(node.consequent) || !!node.alternate && breaks(node.alternate);
        default:
            return false;
    }
}

/** @param {any} node */
function describe(node){
    return {
        FunctionExpression: 'a function', ArrowFunctionExpression: 'a closure',
        ObjectExpression: 'an object', ArrayExpression: 'an array', TemplateLiteral: 'a string',
        AwaitExpression: 'await', NewExpression: 'new', ThisExpression: 'this',
        SwitchStatement: 'switch', TryStatement: 'try', ThrowStatement: 'throw',
        ForOfStatement: 'for...of', ForInStatement: 'for...in', SequenceExpression: 'a comma',
    }[/** @type {string} */ (node.type)] ?? node.type;
}
