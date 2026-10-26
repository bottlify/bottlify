/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The pure model of what an x86-64 instruction does, as `ir.js` is for
 * 32-bit code: registers in, registers out, every flag computed eagerly by
 * the architecture's definition. It is the reference the 64-bit interpreter
 * and translator are judged against, and is itself judged against the
 * processor (`x64-corpus.json.gz`, made by `tools/x64-corpus.mjs` on real
 * hardware).
 *
 * Values are BigInts throughout, so a 64-bit register, address or product is
 * exact; speed is not its job. What long mode changes from 32-bit code is
 * written once here: sixteen registers, a 32-bit result zero-extending its
 * register while an 8- or 16-bit one merges, 64-bit stack operations and
 * branches, RIP-relative addresses, the address-size prefix narrowing an
 * address to 32 bits, FS and GS as the only segments with a base. A fault
 * leaves the state as it was before the instruction: every memory access an
 * instruction makes is done before any register it changes is written.
 *
 * SSE goes to the 32-bit model's own (`ir-simd.js`) through a view of this
 * state, where the vector registers and memory are the same and a dword
 * general register is written zero-extended; the forms with a 64-bit general
 * operand, which 32-bit code has no encoding for, are modelled here. x87 and
 * MMX are not modelled yet.
 */

import { AF, CF, DF, OF, PF, SF, ZF } from './decode/table.js';
import { Fault, Unsupported, condition } from './ir.js';
import { cpuidLeaf, topologyOf } from './cpuid.js';
import { evaluateSimd, isSimdOp } from './ir-simd.js';

const ARITH = CF | PF | AF | ZF | SF | OF;
/** IF, set for a user-mode program and not its to change. */
const IF = 1 << 9;
/** What `popf` can change in user mode: the status flags, DF, NT, AC and ID. */
const WRITABLE = ARITH | DF | (1 << 14) | (1 << 18) | (1 << 21);

/** The SSE instructions whose 16-byte memory operand need not be aligned. */
const UNALIGNED = new Set(['movups', 'movupd', 'movdqu', 'lddqu', 'maskmovdqu']);

/** @param {number} size */
const maskOf = size=>(1n << BigInt(size * 8)) - 1n;
/** @param {number} size */
const signOf = size=>1n << BigInt(size * 8 - 1);

/**
 * @typedef {Object} Memory64
 * @property {(address: bigint, size: number) => bigint} read   unsigned, little-endian;
 *     throws a `Fault` where nothing is mapped
 * @property {(address: bigint, size: number, value: bigint) => void} write
 */

/**
 * @typedef {Object} State64
 * @property {BigUint64Array} r    the sixteen general registers, rax..r15
 * @property {bigint} rip
 * @property {number} rflags
 * @property {bigint} fsBase
 * @property {bigint} gsBase
 * @property {Uint32Array} xmm     the sixteen XMM registers, four words each
 * @property {number} mxcsr
 * @property {Memory64} memory
 * @property {boolean} halted
 * @property {number} retired
 * @property {number[]} trapped    the values written to the trap port, in order
 * @property {{ trapPort: number, read: (port: number, size: number) => number,
 *     write: (port: number, size: number, value: number) => void }} [ports]
 *     the machine's I/O ports; absent, every `out` is a trap-port write
 * @property {() => bigint} [rdtsc]
 * @property {{ processors?: number, processor?: number }} [layout]
 * @property {number} [processor]
 */

/**
 * A fresh state: registers clear, the flags as a user-mode program first
 * sees them (IF and the reserved bit 1 set).
 *
 * @param {Memory64} memory
 * @param {{ rip?: bigint, rsp?: bigint, fsBase?: bigint, gsBase?: bigint }} [start]
 * @returns {State64}
 */
export function createState64(memory, { rip = 0n, rsp = 0n, fsBase = 0n, gsBase = 0n } = {}){
    const r = new BigUint64Array(16);
    r[4] = rsp;
    return { r, rip, rflags: IF | 2, fsBase, gsBase, xmm: new Uint32Array(64), mxcsr: 0x1f80,
        memory, halted: false, retired: 0, trapped: [] };
}

/** @param {bigint} value */
function parity(value){
    let bits = Number(value & 0xffn);
    bits ^= bits >> 4;
    bits ^= bits >> 2;
    bits ^= bits >> 1;
    return (bits & 1) === 0 ? PF : 0;
}

/** ZF, SF and PF of a result already masked to `size`. @param {bigint} result @param {number} size */
function resultFlags(result, size){
    return (result === 0n ? ZF : 0) | ((result & signOf(size)) !== 0n ? SF : 0) | parity(result);
}

/**
 * `a + b + carry` at `size` bytes and its flags.
 *
 * @param {bigint} a @param {bigint} b @param {number} carry @param {number} size
 */
export function addFlags64(a, b, carry, size){
    const mask = maskOf(size);
    const sum = (a & mask) + (b & mask) + BigInt(carry);
    const result = sum & mask;
    const flags = (sum > mask ? CF : 0)
        | (((a ^ result) & (b ^ result) & signOf(size)) !== 0n ? OF : 0)
        | (((a ^ b ^ result) & 0x10n) !== 0n ? AF : 0)
        | resultFlags(result, size);
    return { result, flags };
}

/**
 * `a - b - borrow` at `size` bytes and its flags.
 *
 * @param {bigint} a @param {bigint} b @param {number} borrow @param {number} size
 */
export function subFlags64(a, b, borrow, size){
    const mask = maskOf(size);
    const difference = (a & mask) - (b & mask) - BigInt(borrow);
    const result = difference & mask;
    const flags = (difference < 0n ? CF : 0)
        | (((a ^ b) & (a ^ result) & signOf(size)) !== 0n ? OF : 0)
        | (((a ^ b ^ result) & 0x10n) !== 0n ? AF : 0)
        | resultFlags(result, size);
    return { result, flags };
}

/**
 * The linear address of a memory operand: base, index and displacement at the
 * address size, then FS's or GS's base.
 *
 * @param {State64} state @param {import('./decode/decoder.js').Operand} operand
 */
export function operandAddress64(state, operand){
    let value;
    if (operand.rip)
    {
        value = BigInt(/** @type {number} */ (operand.disp));
    }
    else if (operand.upper !== undefined)
    {
        // A 64-bit offset: no registers, both halves given.
        value = BigInt(operand.upper) << 32n | BigInt(/** @type {number} */ (operand.disp) >>> 0);
    }
    else
    {
        value = BigInt(operand.disp ?? 0);
        if ((operand.base ?? -1) >= 0)
        {
            value += state.r[/** @type {number} */ (operand.base)];
        }
        if ((operand.index ?? -1) >= 0)
        {
            value += state.r[/** @type {number} */ (operand.index)] * BigInt(operand.scale ?? 1);
        }
    }
    value = BigInt.asUintN(operand.addressSize === 32 ? 32 : 64, value);
    if (operand.segment === 4)
    {
        value += state.fsBase;
    }
    else if (operand.segment === 5)
    {
        value += state.gsBase;
    }
    return BigInt.asUintN(64, value);
}

/**
 * Writes `value` to register `index` at `size` bytes by long mode's rule: a
 * dword zero-extends into the whole register, a byte or a word merges.
 *
 * @param {State64} state @param {number} index @param {number} size @param {bigint} value
 * @param {boolean} [high] the byte is AH..BH
 */
function setRegister(state, index, size, value, high = false){
    if (size >= 4)
    {
        state.r[index] = value & maskOf(size);
        return;
    }
    const shift = high ? 8n : 0n;
    const mask = maskOf(size) << shift;
    state.r[index] = state.r[index] & ~mask | (value << shift & mask);
}

/**
 * Runs one decoded instruction on the state.
 *
 * @param {import('./decode/decoder.js').Instruction} instruction
 * @param {State64} state
 */
export function evaluate64(instruction, state){
    const { op, operands, size, prefixes } = instruction;
    const here = BigInt(instruction.eip);
    const next = here + BigInt(instruction.length);
    const fault = (/** @type {number} */ vector)=>new Fault(vector, instruction.eip);

    /** @param {import('./decode/decoder.js').Operand} operand */
    const address = operand=>operandAddress64(state, operand);
    /** @param {import('./decode/decoder.js').Operand} operand @returns {bigint} */
    const read = operand=>{
        switch (operand.kind)
        {
            case 'reg':
            {
                const word = state.r[/** @type {number} */ (operand.reg)];
                return operand.high ? word >> 8n & 0xffn : word & maskOf(operand.size);
            }
            case 'imm':
                return operand.upper !== undefined
                    ? BigInt(operand.upper) << 32n | BigInt(/** @type {number} */ (operand.value) >>> 0)
                    : BigInt.asUintN(operand.size * 8, BigInt(/** @type {number} */ (operand.value)));
            case 'mem':
                return state.memory.read(address(operand), operand.size);
            default:
                throw new Unsupported(`${op} ${operand.kind}`, instruction.eip);
        }
    };
    /** @param {import('./decode/decoder.js').Operand} operand @param {bigint} value */
    const write = (operand, value)=>{
        switch (operand.kind)
        {
            case 'reg':
                setRegister(state, /** @type {number} */ (operand.reg), operand.size, value, operand.high);
                return;
            case 'mem':
                state.memory.write(address(operand), operand.size, value & maskOf(operand.size));
                return;
            default:
                throw new Unsupported(`${op} ${operand.kind}`, instruction.eip);
        }
    };
    /**
     * Writes the flags the instruction defines, so an undefined one keeps its
     * value (the convention translated code follows too); a full writer passes
     * the mask it writes.
     *
     * @param {number} flags @param {number} [written]
     */
    const setFlags = (flags, written = instruction.flagsWritten & ~instruction.flagsUndefined)=>{
        state.rflags = (state.rflags & ~written | flags & written) >>> 0;
    };
    /** A memory operand pinned to the address it has now, for a write after a register changes. */
    const pinned = (/** @type {import('./decode/decoder.js').Operand} */ operand)=>(operand.kind === 'mem'
        ? { ...operand, rip: /** @type {true} */ (true), segment: -1, upper: undefined,
            addressSize: /** @type {64} */ (64), disp: Number(address(operand)) }
        : operand);
    /** Stores `value` below the stack pointer, then moves it: a store that faults moves nothing. */
    const push = (/** @type {bigint} */ value, /** @type {number} */ width)=>{
        const at = BigInt.asUintN(64, state.r[4] - BigInt(width));
        state.memory.write(at, width, value & maskOf(width));
        state.r[4] = at;
    };
    const cf = (state.rflags & CF) !== 0 ? 1 : 0;

    state.retired++;
    if (isSimdOp(instruction))
    {
        simd(instruction, state);
        state.rip = next;
        return;
    }
    switch (op)
    {
        case 'nop': case 'pause': case 'lfence': case 'mfence': case 'sfence': case 'prefetch':
        case 'prefetchw': case 'prefetchnta': case 'prefetcht0': case 'prefetcht1':
        case 'prefetcht2':
            break;
        case 'hlt':
            state.halted = true;
            break;
        case 'mov': case 'movzx': case 'movnti':
            write(operands[0], read(operands[1]));
            break;
        case 'movsx': case 'movsxd':
        {
            const bits = operands[1].size * 8;
            write(operands[0], BigInt.asUintN(64, BigInt.asIntN(bits, read(operands[1]))));
            break;
        }
        case 'lea':
            write(operands[0], address({ ...operands[1], segment: undefined }));
            break;
        case 'xchg':
        {
            const a = read(operands[0]);
            const b = read(operands[1]);
            // The memory side first: a store that faults exchanges nothing.
            const [first, second] = operands[1].kind === 'mem' ? [1, 0] : [0, 1];
            write(operands[first], first === 0 ? b : a);
            write(operands[second], second === 0 ? b : a);
            break;
        }
        case 'add': case 'adc': case 'sub': case 'sbb': case 'cmp':
        {
            const a = read(operands[0]);
            const b = read(operands[1]);
            const { result, flags } = op === 'add' ? addFlags64(a, b, 0, size)
                : op === 'adc' ? addFlags64(a, b, cf, size)
                    : op === 'sbb' ? subFlags64(a, b, cf, size)
                        : subFlags64(a, b, 0, size);
            if (op !== 'cmp')
            {
                write(operands[0], result);
            }
            setFlags(flags);
            break;
        }
        case 'xadd':
        {
            const a = read(operands[0]);
            const { result, flags } = addFlags64(a, read(operands[1]), 0, size);
            // The destination where it was before the source register changes.
            const destination = pinned(operands[0]);
            if (destination.kind === 'mem')
            {
                write(destination, result);
                write(operands[1], a);
            }
            else
            {
                write(operands[1], a);
                write(destination, result);
            }
            setFlags(flags);
            break;
        }
        case 'and': case 'or': case 'xor': case 'test':
        {
            const a = read(operands[0]);
            const b = read(operands[1]);
            const result = (op === 'and' || op === 'test' ? a & b : op === 'or' ? a | b : a ^ b)
                & maskOf(size);
            if (op !== 'test')
            {
                write(operands[0], result);
            }
            setFlags(resultFlags(result, size), ARITH);
            break;
        }
        case 'inc': case 'dec': case 'neg':
        {
            const a = read(operands[0]);
            const { result, flags } = op === 'inc' ? addFlags64(a, 1n, 0, size)
                : op === 'dec' ? subFlags64(a, 1n, 0, size) : subFlags64(0n, a, 0, size);
            write(operands[0], result);
            setFlags(flags);
            break;
        }
        case 'not':
            write(operands[0], ~read(operands[0]) & maskOf(size));
            break;
        case 'shl': case 'sal': case 'shr': case 'sar':
        case 'rol': case 'ror': case 'rcl': case 'rcr':
        {
            const value = read(operands[0]);
            const out = shift64(op, value, Number(read(operands[1])), state.rflags, size);
            // A count of zero changes no flag, but the register is still
            // written: a dword one zero-extends.
            write(operands[0], out === null ? value : out.result);
            if (out !== null)
            {
                setFlags(out.flags, out.written);
            }
            break;
        }
        case 'shld': case 'shrd':
        {
            const a = read(operands[0]);
            const b = read(operands[1]);
            const bits = size * 8;
            const count = Number(read(operands[2])) & (size === 8 ? 63 : 31);
            if (count === 0)
            {
                write(operands[0], a);
                break;
            }
            const mask = maskOf(size);
            const n = BigInt(count);
            const wide = BigInt(bits);
            let result;
            let carry;
            if (op === 'shld')
            {
                result = (a << n | b >> wide - n) & mask;
                carry = a >> wide - n & 1n;
            }
            else
            {
                result = (a >> n | b << wide - n) & mask;
                carry = a >> n - 1n & 1n;
            }
            write(operands[0], result);
            setFlags((carry !== 0n ? CF : 0) | (((a ^ result) & signOf(size)) !== 0n ? OF : 0)
                | resultFlags(result, size), ARITH);
            break;
        }
        case 'imul':
        {
            const bits = size * 8;
            if (operands.length === 1)
            {
                const product = BigInt.asIntN(bits, state.r[0] & maskOf(size))
                    * BigInt.asIntN(bits, read(operands[0]));
                writeWide(state, size, BigInt.asUintN(bits, product),
                    BigInt.asUintN(bits, product >> BigInt(bits)));
                setFlags(BigInt.asIntN(bits, product) === product ? 0 : CF | OF);
                break;
            }
            const a = read(operands[operands.length === 3 ? 1 : 0]);
            const b = read(operands[operands.length === 3 ? 2 : 1]);
            const product = BigInt.asIntN(bits, a) * BigInt.asIntN(bits, b);
            write(operands[0], BigInt.asUintN(bits, product));
            setFlags(BigInt.asIntN(bits, product) === product ? 0 : CF | OF);
            break;
        }
        case 'mul':
        {
            const bits = BigInt(size * 8);
            const product = (state.r[0] & maskOf(size)) * read(operands[0]);
            const high = product >> bits;
            writeWide(state, size, product & maskOf(size), high);
            setFlags(high !== 0n ? CF | OF : 0);
            break;
        }
        case 'div': case 'idiv':
        {
            const bits = size * 8;
            const divisor = read(operands[0]);
            if (divisor === 0n)
            {
                throw fault(0);
            }
            const dividend = size === 1 ? state.r[0] & 0xffffn
                : (state.r[2] & maskOf(size)) << BigInt(bits) | state.r[0] & maskOf(size);
            let quotient;
            let remainder;
            if (op === 'div')
            {
                quotient = dividend / divisor;
                remainder = dividend % divisor;
                if (quotient > maskOf(size))
                {
                    throw fault(0);
                }
            }
            else
            {
                const signed = BigInt.asIntN(bits * 2, dividend);
                const by = BigInt.asIntN(bits, divisor);
                quotient = signed / by;
                remainder = signed % by;
                if (BigInt.asIntN(bits, quotient) !== quotient)
                {
                    throw fault(0);
                }
            }
            // Every flag undefined: left as they were.
            writeWide(state, size, BigInt.asUintN(bits, quotient), BigInt.asUintN(bits, remainder));
            break;
        }
        case 'popcnt':
        {
            let value = read(operands[1]);
            let count = 0n;
            for (; value !== 0n; value >>= 1n)
            {
                count += value & 1n;
            }
            write(operands[0], count);
            setFlags(count === 0n ? ZF : 0, ARITH);
            break;
        }
        case 'bsf': case 'bsr':
        {
            const value = read(operands[1]);
            if (value === 0n)
            {
                // The destination is left whole, its upper half included.
                setFlags(ZF);
                break;
            }
            let index = op === 'bsf' ? 0 : size * 8 - 1;
            while ((value >> BigInt(index) & 1n) === 0n)
            {
                index += op === 'bsf' ? 1 : -1;
            }
            write(operands[0], BigInt(index));
            setFlags(0);
            break;
        }
        case 'bt': case 'bts': case 'btr': case 'btc':
        {
            const bits = size * 8;
            let holder = operands[0];
            let offset = read(operands[1]);
            if (holder.kind === 'mem' && operands[1].kind === 'reg')
            {
                // A register bit offset reaches past the operand: the word
                // holding the bit is at the signed offset.
                const signed = BigInt.asIntN(bits, offset);
                const words = signed >= 0n ? signed / BigInt(bits) : -((-signed + BigInt(bits) - 1n) / BigInt(bits));
                const at = address(holder) + words * BigInt(size);
                holder = { ...pinned(holder), disp: Number(at) };
                offset = signed - words * BigInt(bits);
            }
            else
            {
                offset &= BigInt(bits - 1);
            }
            const value = read(holder);
            const bit = 1n << offset;
            if (op !== 'bt')
            {
                write(holder, op === 'bts' ? value | bit
                    : op === 'btr' ? value & ~bit : value ^ bit);
            }
            setFlags((value & bit) !== 0n ? CF : 0);
            break;
        }
        case 'bswap':
        {
            let value = read(operands[0]);
            let swapped = 0n;
            for (let i = 0; i < size; i++)
            {
                swapped = swapped << 8n | value & 0xffn;
                value >>= 8n;
            }
            write(operands[0], swapped);
            break;
        }
        case 'cwde':
        {
            // cbw, cwde, cdqe: the lower half of the accumulator widened into it.
            const half = size * 4;
            setRegister(state, 0, size, BigInt.asUintN(size * 8, BigInt.asIntN(half, state.r[0])));
            break;
        }
        case 'cdq':
            // cwd, cdq, cqo: the accumulator's sign into rdx.
            setRegister(state, 2, size, (state.r[0] & signOf(size)) !== 0n ? maskOf(size) : 0n);
            break;
        case 'cmpxchg':
        {
            const accumulator = state.r[0] & maskOf(size);
            const destination = read(operands[0]);
            const { flags } = subFlags64(accumulator, destination, 0, size);
            if (accumulator === destination)
            {
                write(operands[0], read(operands[1]));
            }
            else
            {
                // A memory destination is written back with what it held (a
                // locked read always has its write); a register one is left
                // whole, a dword's upper half included, as the processor does.
                if (operands[0].kind === 'mem')
                {
                    write(operands[0], destination);
                }
                setRegister(state, 0, size, destination);
            }
            setFlags(flags);
            break;
        }
        case 'cmpxchg8b': case 'cmpxchg16b':
        {
            const half = op === 'cmpxchg8b' ? 4 : 8;
            const at = address(operands[0]);
            if (half === 8 && (at & 15n) !== 0n)
            {
                throw fault(13);
            }
            const low = state.memory.read(at, half);
            const high = state.memory.read(at + BigInt(half), half);
            if (low === (state.r[0] & maskOf(half)) && high === (state.r[2] & maskOf(half)))
            {
                state.memory.write(at, half, state.r[3] & maskOf(half));
                state.memory.write(at + BigInt(half), half, state.r[1] & maskOf(half));
                state.rflags |= ZF;
            }
            else
            {
                state.memory.write(at, half, low);
                state.memory.write(at + BigInt(half), half, high);
                setRegister(state, 0, half, low);
                setRegister(state, 2, half, high);
                state.rflags &= ~ZF;
            }
            break;
        }
        case 'push':
        {
            const width = operands[0].kind === 'imm' ? size : operands[0].size;
            push(read(operands[0]), width);
            break;
        }
        case 'pop':
        {
            const width = operands[0].size;
            const value = state.memory.read(state.r[4], width);
            const moved = BigInt.asUintN(64, state.r[4] + BigInt(width));
            if (operands[0].kind === 'mem')
            {
                // `pop [rsp+x]` addresses with the stack pointer moved.
                const before = state.r[4];
                state.r[4] = moved;
                const at = address(operands[0]);
                state.r[4] = before;
                state.memory.write(at, width, value);
                state.r[4] = moved;
                break;
            }
            state.r[4] = moved;
            write(operands[0], value);
            break;
        }
        case 'pushf':
            push(BigInt(state.rflags), size);
            break;
        case 'popf':
        {
            const value = Number(state.memory.read(state.r[4], size) & 0xffffffffn);
            state.r[4] = BigInt.asUintN(64, state.r[4] + BigInt(size));
            const writable = WRITABLE & (size === 2 ? 0xffff : -1);
            state.rflags = (state.rflags & ~writable | value & writable | 2) >>> 0;
            break;
        }
        case 'lahf':
            setRegister(state, 0, 1, BigInt(state.rflags & 0xd5 | 2), true);
            break;
        case 'sahf':
            state.rflags = (state.rflags & ~0xd5 | Number(state.r[0] >> 8n & 0xd5n)) >>> 0;
            break;
        case 'clc': state.rflags &= ~CF; break;
        case 'stc': state.rflags |= CF; break;
        case 'cmc': state.rflags ^= CF; break;
        case 'cld': state.rflags &= ~DF; break;
        case 'std': state.rflags |= DF; break;
        case 'jmp':
            state.rip = operands[0].kind === 'rel' ? target(operands[0]) : read(operands[0]);
            return;
        case 'call':
        {
            // The target is read before the return address goes on the stack.
            const to = operands[0].kind === 'rel' ? target(operands[0]) : read(operands[0]);
            push(next, 8);
            state.rip = to;
            return;
        }
        case 'ret':
        {
            const to = state.memory.read(state.r[4], 8);
            const release = operands.length === 1 ? read(operands[0]) : 0n;
            state.r[4] = BigInt.asUintN(64, state.r[4] + 8n + release);
            state.rip = to;
            return;
        }
        case 'leave':
        {
            const width = size === 2 ? 2 : 8;
            const value = state.memory.read(state.r[5], width);
            state.r[4] = BigInt.asUintN(64, state.r[5] + BigInt(width));
            setRegister(state, 5, width, value);
            break;
        }
        case 'enter':
        {
            if ((Number(read(operands[1])) & 31) !== 0)
            {
                throw new Unsupported('enter with a nesting level', instruction.eip);
            }
            const width = size === 2 ? 2 : 8;
            push(state.r[5] & maskOf(width), width);
            setRegister(state, 5, width, state.r[4]);
            state.r[4] = BigInt.asUintN(64, state.r[4] - read(operands[0]));
            break;
        }
        case 'loop': case 'loope': case 'loopne': case 'jecxz':
        {
            const width = prefixes.address ? 4 : 8;
            let count = state.r[1] & maskOf(width);
            if (op !== 'jecxz')
            {
                count = count - 1n & maskOf(width);
                setRegister(state, 1, width, count);
            }
            const zf = (state.rflags & ZF) !== 0;
            const taken = op === 'jecxz' ? count === 0n
                : count !== 0n && (op === 'loop' || (op === 'loope' ? zf : !zf));
            state.rip = taken ? target(operands[0]) : next;
            return;
        }
        case 'movs': case 'stos': case 'lods': case 'cmps': case 'scas':
            strings(instruction, state, read, write, setFlags);
            break;
        case 'xlat':
        {
            const width = prefixes.address ? 32 : 64;
            let at = BigInt.asUintN(width, state.r[3] + (state.r[0] & 0xffn));
            const segment = operands[0]?.segment;
            at += segment === 4 ? state.fsBase : segment === 5 ? state.gsBase : 0n;
            setRegister(state, 0, 1, state.memory.read(BigInt.asUintN(64, at), 1));
            break;
        }
        case 'int3':
            throw new Fault(3, Number(next));
        case 'int':
            throw new Fault(Number(read(operands[0])), Number(next));
        case 'ud2': case 'ud1':
            throw fault(6);
        case 'out':
        {
            // The trap port, as the 32-bit model sees it: the value is recorded
            // and whoever runs the model answers it. Any other port is a device's.
            const port = Number(read(operands[0]) & 0xffffn);
            const value = Number(read(operands[1]) & 0xffffffffn);
            if (state.ports === undefined || port === state.ports.trapPort)
            {
                state.trapped.push(value);
                break;
            }
            state.ports.write(port, operands[1].size, value);
            break;
        }
        case 'in':
        {
            const port = Number(read(operands[1]) & 0xffffn);
            write(operands[0], BigInt(state.ports
                ? state.ports.read(port, operands[0].size) >>> 0 : 0xffffffff));
            break;
        }
        case 'cpuid':
        {
            const answer = cpuidLeaf(Number(state.r[0] & 0xffffffffn),
                Number(state.r[1] & 0xffffffffn), topologyOf(state.layout, state.processor));
            setRegister(state, 0, 4, BigInt(answer.eax >>> 0));
            setRegister(state, 1, 4, BigInt(answer.ecx >>> 0));
            setRegister(state, 2, 4, BigInt(answer.edx >>> 0));
            setRegister(state, 3, 4, BigInt(answer.ebx >>> 0));
            break;
        }
        case 'rdtsc':
        {
            const value = state.rdtsc ? state.rdtsc() : 0n;
            setRegister(state, 0, 4, value & 0xffffffffn);
            setRegister(state, 2, 4, value >> 32n & 0xffffffffn);
            break;
        }
        default:
            if (instruction.cc !== undefined && op.startsWith('set'))
            {
                write(operands[0], condition(instruction.cc, state.rflags) ? 1n : 0n);
                break;
            }
            if (instruction.cc !== undefined && op.startsWith('cmov'))
            {
                // The source is read and the dword destination zero-extended
                // whether or not the move is made.
                const value = read(operands[1]);
                const moved = condition(instruction.cc, state.rflags);
                write(operands[0], moved ? value : read(operands[0]));
                break;
            }
            if (instruction.cc !== undefined && op.startsWith('j'))
            {
                state.rip = condition(instruction.cc, state.rflags) ? target(operands[0]) : next;
                return;
            }
            throw new Unsupported(op, instruction.eip);
    }
    state.rip = next;
}

/** A relative operand's target as an address. @param {import('./decode/decoder.js').Operand} operand */
function target(operand){
    return BigInt.asUintN(64, BigInt(/** @type {number} */ (operand.target)));
}

/**
 * The wide result of mul, imul, div and idiv: AX for a byte, else the low half
 * to the accumulator and the high one to rdx, each at the operand size.
 *
 * @param {State64} state @param {number} size @param {bigint} low @param {bigint} high
 */
function writeWide(state, size, low, high){
    if (size === 1)
    {
        setRegister(state, 0, 2, high << 8n | low);
        return;
    }
    setRegister(state, 0, size, low);
    setRegister(state, 2, size, high);
}

/**
 * A shift or rotate of `value` by `count` (masked to six bits for a quadword,
 * five otherwise): its result, flags and the flags it writes, or null for a
 * count of zero, which writes no flag.
 *
 * @param {string} op @param {bigint} value @param {number} count
 * @param {number} rflags the flags before, for rcl/rcr's carry in
 * @param {number} size
 * @returns {{ result: bigint, flags: number, written: number } | null}
 */
export function shift64(op, value, count, rflags, size){
    const bits = size * 8;
    const mask = maskOf(size);
    const sign = signOf(size);
    count &= size === 8 ? 63 : 31;
    if (count === 0)
    {
        return null;
    }
    const n = BigInt(count);
    const wide = BigInt(bits);
    /** @param {bigint} v */
    const top = v=>((v & sign) !== 0n ? 1 : 0);
    let result;
    let carry;
    let overflow;
    switch (op)
    {
        case 'shl': case 'sal':
            result = value << n & mask;
            carry = count <= bits ? Number(value >> wide - n & 1n) : 0;
            overflow = top(result) ^ carry;
            break;
        case 'shr':
            result = value >> n & mask;
            carry = Number(value >> n - 1n & 1n);
            overflow = top(value);
            break;
        case 'sar':
        {
            const signed = BigInt.asIntN(bits, value);
            result = signed >> n & mask;
            carry = Number(signed >> n - 1n & 1n);
            overflow = 0;
            break;
        }
        case 'rol':
        {
            const by = BigInt(count % bits);
            result = by === 0n ? value : (value << by | value >> wide - by) & mask;
            carry = Number(result & 1n);
            overflow = top(result) ^ carry;
            break;
        }
        case 'ror':
        {
            const by = BigInt(count % bits);
            result = by === 0n ? value : (value >> by | value << wide - by) & mask;
            carry = top(result);
            overflow = carry ^ ((result & sign >> 1n) !== 0n ? 1 : 0);
            break;
        }
        case 'rcl':
        {
            let rotated = value;
            let c = (rflags & CF) !== 0 ? 1 : 0;
            for (let i = 0; i < count % (bits + 1); i++)
            {
                const out = top(rotated);
                rotated = (rotated << 1n | BigInt(c)) & mask;
                c = out;
            }
            result = rotated;
            carry = c;
            overflow = top(result) ^ carry;
            break;
        }
        default: // rcr
        {
            let rotated = value;
            let c = (rflags & CF) !== 0 ? 1 : 0;
            overflow = top(value) ^ c;
            for (let i = 0; i < count % (bits + 1); i++)
            {
                const low = Number(rotated & 1n);
                rotated = rotated >> 1n | BigInt(c) << wide - 1n;
                c = low;
            }
            result = rotated;
            carry = c;
        }
    }
    const flags = (carry ? CF : 0) | (overflow ? OF : 0);
    if (op === 'rol' || op === 'ror' || op === 'rcl' || op === 'rcr')
    {
        return { result, flags, written: CF | OF };
    }
    return { result, flags: flags | resultFlags(result, size), written: ARITH };
}

/**
 * movs, stos, lods, cmps and scas, with or without a repeat: one element at a
 * time, each one's accesses before its registers move, so a fault in the
 * middle leaves the count and pointers at the element that faulted.
 *
 * @param {import('./decode/decoder.js').Instruction} instruction
 * @param {State64} state
 * @param {(o: import('./decode/decoder.js').Operand) => bigint} read
 * @param {(o: import('./decode/decoder.js').Operand, v: bigint) => void} write
 * @param {(flags: number, written?: number) => void} setFlags
 */
function strings(instruction, state, read, write, setFlags){
    const { op, operands, size, prefixes } = instruction;
    const memory = operands.find(operand=>operand.kind === 'mem');
    const width = memory?.addressSize === 32 ? 4 : 8;
    const step = BigInt((state.rflags & DF) !== 0 ? -size : size);
    const repeat = prefixes.rep || prefixes.repne;
    /** @param {number} index @param {bigint} by */
    const advance = (index, by)=>setRegister(state, index, width,
        state.r[index] + by & maskOf(width));
    for (;;)
    {
        if (repeat && (state.r[1] & maskOf(width)) === 0n)
        {
            return;
        }
        let done = false;
        switch (op)
        {
            case 'movs':
                write(operands[0], read(operands[1]));
                advance(6, step);
                advance(7, step);
                break;
            case 'stos':
                write(operands[0], read(operands[1]));
                advance(7, step);
                break;
            case 'lods':
                write(operands[0], read(operands[1]));
                advance(6, step);
                break;
            default: // cmps, scas
            {
                const { flags } = subFlags64(read(operands[0]), read(operands[1]), 0, size);
                setFlags(flags);
                if (op === 'cmps')
                {
                    advance(6, step);
                }
                advance(7, step);
                done = repeat && ((flags & ZF) !== 0) !== prefixes.rep;
            }
        }
        if (!repeat)
        {
            return;
        }
        advance(1, -1n);
        if (done)
        {
            return;
        }
    }
}

/**
 * An SSE instruction. One with a 64-bit general or memory operand where 32-bit
 * code has a dword (REX.W `movd`, the conversions to and from a quadword
 * integer) is done here; every other runs on the 32-bit model over a view of
 * this state.
 *
 * @param {import('./decode/decoder.js').Instruction} instruction
 * @param {State64} state
 */
function simd(instruction, state){
    const { op, operands } = instruction;
    if (operands.some(operand=>operand.kind === 'mm'))
    {
        throw new Unsupported(`${op} on an MMX register`, instruction.eip);
    }
    const [dst, src] = operands;
    // A 16-byte memory operand of a legacy SSE instruction must be aligned,
    // but for the unaligned moves.
    const wide = operands.find(operand=>operand.kind === 'mem' && operand.size === 16);
    if (wide !== undefined && !UNALIGNED.has(op) && (operandAddress64(state, wide) & 15n) !== 0n)
    {
        throw new Fault(13, instruction.eip);
    }
    /** @param {import('./decode/decoder.js').Operand} operand */
    const quadword = operand=>operand.kind !== 'xmm' && operand.size === 8;
    /** @param {import('./decode/decoder.js').Operand} operand */
    const readGeneral = operand=>(operand.kind === 'reg'
        ? state.r[/** @type {number} */ (operand.reg)]
        : state.memory.read(operandAddress64(state, operand), 8));
    /** The register's low quadword. @param {number} reg */
    const low = reg=>BigInt(state.xmm[reg * 4 + 1]) << 32n | BigInt(state.xmm[reg * 4]);
    /** @param {number} reg @param {bigint} value */
    const setLow = (reg, value)=>{
        state.xmm[reg * 4] = Number(value & 0xffffffffn);
        state.xmm[reg * 4 + 1] = Number(value >> 32n & 0xffffffffn);
    };
    if (op === 'movd' && (quadword(dst) || quadword(src)))
    {
        if (dst.kind === 'xmm')
        {
            const reg = /** @type {number} */ (dst.reg);
            setLow(reg, readGeneral(src));
            state.xmm[reg * 4 + 2] = 0;
            state.xmm[reg * 4 + 3] = 0;
        }
        else if (dst.kind === 'reg')
        {
            state.r[/** @type {number} */ (dst.reg)] = low(/** @type {number} */ (src.reg));
        }
        else
        {
            state.memory.write(operandAddress64(state, dst), 8,
                low(/** @type {number} */ (src.reg)));
        }
        return;
    }
    if ((op === 'cvtsi2sd' || op === 'cvtsi2ss') && quadword(src))
    {
        const value = BigInt.asIntN(64, readGeneral(src));
        const reg = /** @type {number} */ (dst.reg);
        if (op === 'cvtsi2sd')
        {
            setLow(reg, doubleBits(roundToBits(value, 53, state.mxcsr)));
        }
        else
        {
            const view = new DataView(new ArrayBuffer(4));
            view.setFloat32(0, roundToBits(value, 24, state.mxcsr), true);
            state.xmm[reg * 4] = view.getUint32(0, true);
        }
        return;
    }
    if (/^cvtt?s[sd]2si$/.test(op) && dst.size === 8)
    {
        const double = op.endsWith('sd2si');
        const view = new DataView(new ArrayBuffer(8));
        if (src.kind === 'xmm')
        {
            view.setUint32(0, state.xmm[/** @type {number} */ (src.reg) * 4], true);
            view.setUint32(4, state.xmm[/** @type {number} */ (src.reg) * 4 + 1], true);
        }
        else
        {
            const at = operandAddress64(state, src);
            view.setBigUint64(0, state.memory.read(at, double ? 8 : 4), true);
        }
        const value = double ? view.getFloat64(0, true) : view.getFloat32(0, true);
        const mode = op.startsWith('cvtt') ? 3 : state.mxcsr >>> 13 & 3;
        state.r[/** @type {number} */ (dst.reg)] = BigInt.asUintN(64, floatToQuadword(value, mode));
        return;
    }
    // The 32-bit model over a view: the same vector registers, MXCSR, flags
    // and memory, the general registers' low halves.
    const view = /** @type {import('./ir.js').EvalState} */ (/** @type {unknown} */ ({
        reg: Uint32Array.from(state.r, value=>Number(value & 0xffffffffn)),
        xmm: state.xmm,
        mxcsr: state.mxcsr,
        eflags: state.rflags,
        memory: {
            read: (/** @type {number} */ at, /** @type {number} */ size)=>
                Number(state.memory.read(BigInt(at), size)),
            write: (/** @type {number} */ at, /** @type {number} */ size, /** @type {number} */ value)=>
                state.memory.write(BigInt(at), size, BigInt(value >>> 0)),
        },
    }));
    if (!evaluateSimd(instruction, view, operand=>Number(operandAddress64(state, operand))))
    {
        throw new Unsupported(op, instruction.eip);
    }
    state.mxcsr = view.mxcsr;
    state.rflags = view.eflags;
    if (dst?.kind === 'reg')
    {
        const reg = /** @type {number} */ (dst.reg);
        setRegister(state, reg, Math.max(dst.size, 4), BigInt(view.reg[reg]));
    }
}

/** A double's bits. @param {number} value */
function doubleBits(value){
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return view.getBigUint64(0, true);
}

/**
 * A quadword integer rounded to `bits` significant bits by MXCSR's rounding
 * mode, as a number: exact for a double (53) and, being exact at 24, for a
 * float without the double rounding a conversion through a double would add.
 *
 * @param {bigint} value @param {number} bits @param {number} mxcsr
 */
function roundToBits(value, bits, mxcsr){
    const negative = value < 0n;
    let magnitude = negative ? -value : value;
    const length = magnitude.toString(2).length;
    if (length > bits)
    {
        const drop = BigInt(length - bits);
        const kept = magnitude >> drop;
        const rest = magnitude - (kept << drop);
        const half = 1n << drop - 1n;
        const mode = mxcsr >>> 13 & 3;
        let up;
        switch (mode)
        {
            case 0: up = rest > half || rest === half && (kept & 1n) === 1n; break;
            case 1: up = negative && rest !== 0n; break; // toward -infinity
            case 2: up = !negative && rest !== 0n; break; // toward +infinity
            default: up = false;
        }
        magnitude = kept + (up ? 1n : 0n) << drop;
    }
    const number = Number(magnitude);
    return negative ? -number : number;
}

/**
 * A float to a signed quadword by a rounding mode (MXCSR's encoding, 3 for
 * truncation); NaN and out of range give the integer indefinite.
 *
 * @param {number} value @param {number} mode
 */
function floatToQuadword(value, mode){
    let whole;
    switch (mode)
    {
        case 1: whole = Math.floor(value); break;
        case 2: whole = Math.ceil(value); break;
        case 3: whole = Math.trunc(value); break;
        default:
        {
            const floor = Math.floor(value);
            const diff = value - floor;
            whole = diff > 0.5 || diff === 0.5 && floor % 2 !== 0 ? floor + 1 : floor;
        }
    }
    if (Number.isNaN(whole) || whole >= 2 ** 63 || whole < -(2 ** 63))
    {
        return -(1n << 63n);
    }
    return BigInt(whole);
}
