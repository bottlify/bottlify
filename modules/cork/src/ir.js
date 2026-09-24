/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The pure model of what an instruction does: registers in, registers out,
 * every flag computed eagerly by the architecture's definition.
 *
 * Three things run on it. The emitter's tests compare the wasm they run
 * against this model on the same inputs, so a flag formula is written once
 * here and once in wasm and the two must agree; the interpreter tier runs
 * it instruction by instruction for code the translator has not translated;
 * and the region former's constant folding asks it what a constant operation
 * yields. It is deliberately slow and obvious -- one function per
 * instruction class, no laziness -- because it is the thing everything else
 * is checked against.
 *
 * Integer instructions in this step; x87 and SIMD follow with their own.
 */

import { AF, CF, DF, OF, PF, SF, ZF, conditionReads } from './decode/table.js';
import { cpuidLeaf } from './cpuid.js';
import { evaluateX87, fxrstor, fxsave, isX87Op } from './ir-x87.js';
import { evaluateSimd, isSimdOp, mmxState } from './ir-simd.js';

const ARITH = CF | PF | AF | ZF | SF | OF;

/** The width masks by operand size. @type {Readonly<Record<number, number>>} */
const MASK = Object.freeze({ 1: 0xff, 2: 0xffff, 4: 0xffffffff });
/** The sign bit by operand size. @type {Readonly<Record<number, number>>} */
const SIGN = Object.freeze({ 1: 0x80, 2: 0x8000, 4: 0x80000000 });

/** The eight general registers' names, by index. */
const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

/**
 * @typedef {Object} Memory
 * @property {(address: number, size: number) => number} read   unsigned, little-endian
 * @property {(address: number, size: number, value: number) => void} write
 * @property {(address: number, bytes: Uint8Array) => boolean} [same]  whether memory
 *     still holds `bytes` at `address`, faulting as reading them would: the
 *     interpreter's decode cache check, for a memory that answers it in place
 */

/**
 * @typedef {Object} EvalState
 * @property {Uint32Array} reg     the eight general registers
 * @property {number} eip
 * @property {number} faultEip     the address a fault raised this instruction names
 * @property {number} eflags       the eager word
 * @property {number} fsBase       what an `fs:` access adds
 * @property {Memory} memory
 * @property {boolean} halted
 * @property {number} retired
 * @property {number[]} trapped    the values written to the trap port, in order
 * @property {() => bigint} [rdtsc]  the host's time-stamp counter; absent, it reads zero
 * @property {number} top          the x87 stack's top, 0-7
 * @property {number} empty        the empty-register mask, bit k for physical k
 * @property {number} status       the x87 status word
 * @property {number} control      the x87 control word
 * @property {Float64Array} f80    the eight physical x87 registers, as doubles
 * @property {BigInt64Array} f80bits  the same bytes, for an MMX read or write
 * @property {Uint32Array} xmm     the eight XMM registers, four words each
 * @property {number} mxcsr
 */

/**
 * A fresh state: registers clear, flags at their reset value, the stack
 * wherever the caller puts it.
 *
 * @param {Memory} memory
 * @param {{ eip?: number, esp?: number, fsBase?: number }} [start]
 * @returns {EvalState}
 */
export function createState(memory, { eip = 0, esp = 0, fsBase = 0 } = {}){
    const reg = new Uint32Array(8);
    reg[4] = esp;
    const f80Bytes = new ArrayBuffer(64);
    return {
        reg, eip, faultEip: eip, eflags: 0x2, fsBase, memory,
        halted: false, retired: 0, trapped: [],
        top: 0, empty: 0xff, status: 0, control: 0x37f,
        f80: new Float64Array(f80Bytes),
        f80bits: new BigInt64Array(f80Bytes),
        xmm: new Uint32Array(32),
        mxcsr: 0x1f80,
    };
}

/** A processor exception the model raises, by vector. */
export class Fault extends Error {
    /** @param {number} vector @param {number} eip */
    constructor(vector, eip){
        super(`fault #${vector} at 0x${eip.toString(16)}`);
        this.vector = vector;
        this.eip = eip;
    }
}

/** An instruction the model has no case for yet. */
export class Unsupported extends Error {
    /** @param {string} op @param {number} [eip] the instruction's own address */
    constructor(op, eip){
        super(`ir: no model for ${op}`);
        this.op = op;
        if (eip !== undefined)
        {
            this.eip = eip;
        }
    }
}

/** Parity of the low byte: PF set when the number of one bits is even. @param {number} value */
function parity(value){
    let bits = value & 0xff;
    bits ^= bits >> 4;
    bits ^= bits >> 2;
    bits ^= bits >> 1;
    return (bits & 1) === 0 ? PF : 0;
}

/**
 * ZF, SF and PF of a result, the three every arithmetic instruction shares.
 *
 * @param {number} result  already masked
 * @param {number} size
 */
function resultFlags(result, size){
    return (result === 0 ? ZF : 0) | ((result & SIGN[size]) !== 0 ? SF : 0) | parity(result);
}

/**
 * The flags of an addition `a + b + carry`, by the definition: CF from the
 * unsigned overflow, OF from the sign of the operands against the result,
 * AF from bit 4 of the nibble carry.
 *
 * @param {number} a @param {number} b @param {number} carry @param {number} size
 * @returns {{ result: number, flags: number }}
 */
export function addFlags(a, b, carry, size){
    const mask = MASK[size];
    const sum = ((a & mask) >>> 0) + ((b & mask) >>> 0) + carry;
    const result = (sum & mask) >>> 0;
    const flags = (sum > mask ? CF : 0)
        | ((((a ^ result) & (b ^ result)) & SIGN[size]) !== 0 ? OF : 0)
        | (((a ^ b ^ result) & 0x10) !== 0 ? AF : 0)
        | resultFlags(result, size);
    return { result: result >>> 0, flags };
}

/**
 * The flags of a subtraction `a - b - borrow`.
 *
 * @param {number} a @param {number} b @param {number} borrow @param {number} size
 * @returns {{ result: number, flags: number }}
 */
export function subFlags(a, b, borrow, size){
    const mask = MASK[size];
    const difference = ((a & mask) >>> 0) - ((b & mask) >>> 0) - borrow;
    const result = (difference & mask) >>> 0;
    const flags = (difference < 0 ? CF : 0)
        | ((((a ^ b) & (a ^ result)) & SIGN[size]) !== 0 ? OF : 0)
        | (((a ^ b ^ result) & 0x10) !== 0 ? AF : 0)
        | resultFlags(result, size);
    return { result: result >>> 0, flags };
}

/**
 * The flags of and/or/xor/test: CF and OF clear, AF left clear (undefined
 * by the architecture), the rest from the result.
 *
 * @param {number} result @param {number} size
 */
export function logicFlags(result, size){
    return resultFlags((result & MASK[size]) >>> 0, size);
}

/**
 * Whether a condition code holds under a flags word.
 *
 * @param {number} cc @param {number} flags
 */
export function condition(cc, flags){
    const cf = (flags & CF) !== 0;
    const zf = (flags & ZF) !== 0;
    const sf = (flags & SF) !== 0;
    const of = (flags & OF) !== 0;
    const pf = (flags & PF) !== 0;
    let holds;
    switch (cc >> 1)
    {
        case 0: holds = of; break;
        case 1: holds = cf; break;
        case 2: holds = zf; break;
        case 3: holds = cf || zf; break;
        case 4: holds = sf; break;
        case 5: holds = pf; break;
        case 6: holds = sf !== of; break;
        default: holds = zf || sf !== of;
    }
    return (cc & 1) === 0 ? holds : !holds;
}

/**
 * The linear address of a memory operand.
 *
 * @param {EvalState} state @param {import('./decode/decoder.js').Operand} operand
 */
export function operandAddress(state, operand){
    let value = operand.disp ?? 0;
    if ((operand.base ?? -1) >= 0)
    {
        value += state.reg[/** @type {number} */ (operand.base)];
    }
    if ((operand.index ?? -1) >= 0)
    {
        value += state.reg[/** @type {number} */ (operand.index)] * (operand.scale ?? 1);
    }
    if (operand.addressSize === 16)
    {
        value &= 0xffff;
    }
    if (operand.segment === 4)
    {
        value += state.fsBase;
    }
    return value >>> 0;
}

/**
 * Runs one decoded instruction on the state.
 *
 * @param {import('./decode/decoder.js').Instruction} instruction
 * @param {EvalState} state
 */
export function evaluate(instruction, state){
    const { op, operands, size } = instruction;
    const mask = MASK[size] ?? 0xffffffff;
    const next = (instruction.eip + instruction.length) >>> 0;
    state.eip = next;
    state.retired++;

    /** @param {import('./decode/decoder.js').Operand} operand */
    const address = operand=>operandAddress(state, operand);
    /** @param {import('./decode/decoder.js').Operand} operand @returns {number} */
    const read = operand=>{
        switch (operand.kind)
        {
            case 'reg':
                if (operand.size === 1)
                {
                    const word = state.reg[/** @type {number} */ (operand.reg)];
                    return operand.high ? word >>> 8 & 0xff : word & 0xff;
                }
                return state.reg[/** @type {number} */ (operand.reg)] & MASK[operand.size];
            case 'imm':
                return /** @type {number} */ (operand.value) >>> 0;
            case 'mem':
                return state.memory.read(address(operand), operand.size);
            case 'seg':
                // Flat segments: the selector values the ROM loaded, so a
                // program that reads and compares them sees consistent ones.
                return [0x10, 0x08, 0x10, 0x10, 0x18, 0x10][/** @type {number} */ (operand.reg)];
            default:
                throw new Unsupported(`${op} ${operand.kind}`);
        }
    };
    /** @param {import('./decode/decoder.js').Operand} operand @param {number} value */
    const write = (operand, value)=>{
        switch (operand.kind)
        {
            case 'reg':
            {
                const index = /** @type {number} */ (operand.reg);
                if (operand.size === 1)
                {
                    const word = state.reg[index];
                    state.reg[index] = operand.high
                        ? (word & 0xffff00ff | (value & 0xff) << 8) >>> 0
                        : (word & 0xffffff00 | value & 0xff) >>> 0;
                }
                else if (operand.size === 2)
                {
                    state.reg[index] = (state.reg[index] & 0xffff0000 | value & 0xffff) >>> 0;
                }
                else
                {
                    state.reg[index] = value >>> 0;
                }
                return;
            }
            case 'mem':
                state.memory.write(address(operand), operand.size, value & MASK[operand.size]);
                return;
            case 'seg':
                return;
            default:
                throw new Unsupported(`${op} ${operand.kind}`);
        }
    };
    /**
     * Writes flags: by default only the ones the instruction defines, so an
     * undefined flag keeps its value -- the convention translated code follows
     * too. A full writer passes the mask it clears explicitly.
     *
     * @param {number} flags @param {number} [written]
     */
    const setFlags = (flags, written = instruction.flagsWritten & ~instruction.flagsUndefined)=>{
        state.eflags = (state.eflags & ~written | flags & written) >>> 0;
    };
    const push = (/** @type {number} */ value, width = size)=>{
        state.reg[4] = (state.reg[4] - width) >>> 0;
        state.memory.write(state.reg[4], width, value & MASK[width]);
    };
    const pop = (width = size)=>{
        const value = state.memory.read(state.reg[4], width);
        state.reg[4] = (state.reg[4] + width) >>> 0;
        return value;
    };
    const cf = (state.eflags & CF) !== 0 ? 1 : 0;

    if (isX87Op(instruction))
    {
        if (!evaluateX87(instruction, state, address))
        {
            throw new Unsupported(op);
        }
        return;
    }
    if (isSimdOp(instruction))
    {
        if (!evaluateSimd(instruction, state, address))
        {
            throw new Unsupported(op);
        }
        // An MMX instruction leaves the stack in the MMX state: top zero,
        // every register held.
        if (instruction.operands.some(operand=>operand.kind === 'mm'))
        {
            mmxState(state);
        }
        return;
    }

    switch (op)
    {
        case 'nop': case 'fwait': case 'prefetch': case 'prefetchw': case 'prefetchnta':
        case 'prefetcht0': case 'prefetcht1': case 'prefetcht2': case 'lfence': case 'mfence':
        case 'sfence': case 'pause':
            return;
        // BOUND is a no-op here because it is one to the emulator: its
        // decoder consumes the instruction and neither reads the memory
        // operand nor raises #BR, so a guest that runs data containing 0x62
        // continues under the emulator and must continue here. A program
        // returned to the entry vector is the shape that reached it.
        case 'bound':
            return;
        case 'hlt':
            state.halted = true;
            return;
        case 'mov':
            if (operands[1].kind === 'seg' && operands[0].kind === 'reg'
                && !instruction.prefixes.operand)
            {
                // A segment register read into a dword register clears the upper half.
                write({ ...operands[0], size: 4 }, read(operands[1]));
                return;
            }
            write(operands[0], read(operands[1]));
            return;
        case 'movnti':
            // A non-temporal store is a store, with no flags to leave.
            write(operands[0], read(operands[1]));
            return;
        case 'movzx':
            write(operands[0], read(operands[1]));
            return;
        case 'movsx':
        {
            const value = read(operands[1]);
            const bits = operands[1].size * 8;
            write(operands[0], (value << (32 - bits) >> (32 - bits)) >>> 0);
            return;
        }
        case 'lea':
            write(operands[0], address(operands[1]) & mask);
            return;
        case 'xchg':
        {
            const a = read(operands[0]);
            const b = read(operands[1]);
            write(operands[0], b);
            write(operands[1], a);
            return;
        }
        case 'add': case 'adc': case 'sub': case 'sbb': case 'cmp': case 'xadd':
        {
            const a = read(operands[0]);
            const b = read(operands[1]);
            const { result, flags } = op === 'add' || op === 'xadd' ? addFlags(a, b, 0, size)
                : op === 'adc' ? addFlags(a, b, cf, size)
                    : op === 'sbb' ? subFlags(a, b, cf, size)
                        : subFlags(a, b, 0, size);
            if (op === 'xadd')
            {
                write(operands[1], a);
            }
            if (op !== 'cmp')
            {
                write(operands[0], result);
            }
            setFlags(flags);
            return;
        }
        case 'and': case 'or': case 'xor': case 'test':
        {
            const a = read(operands[0]);
            const b = read(operands[1]);
            const mixed = op === 'and' || op === 'test' ? a & b : op === 'or' ? a | b : a ^ b;
            const result = (mixed & mask) >>> 0;
            if (op !== 'test')
            {
                write(operands[0], result);
            }
            setFlags(logicFlags(result, size), ARITH);
            return;
        }
        case 'inc': case 'dec':
        {
            const a = read(operands[0]);
            const { result, flags } = op === 'inc'
                ? addFlags(a, 1, 0, size)
                : subFlags(a, 1, 0, size);
            write(operands[0], result);
            setFlags(flags);
            return;
        }
        case 'neg':
        {
            const a = read(operands[0]);
            const { result, flags } = subFlags(0, a, 0, size);
            write(operands[0], result);
            setFlags(flags);
            return;
        }
        case 'not':
            write(operands[0], (~read(operands[0]) & mask) >>> 0);
            return;
        case 'shl': case 'sal': case 'shr': case 'sar':
        case 'rol': case 'ror': case 'rcl': case 'rcr':
            shiftOrRotate(op, operands, size, state, read, write, setFlags);
            return;
        case 'shld': case 'shrd':
        {
            const count = read(operands[2]) & 31;
            if (count === 0)
            {
                return;
            }
            const bits = size * 8;
            const a = read(operands[0]);
            const b = read(operands[1]);
            let result;
            let carry;
            if (op === 'shld')
            {
                result = count < bits
                    ? ((a << count) | (b >>> (bits - count))) & mask
                    : (b << (count - bits)) & mask;
                carry = count <= bits ? (a >>> (bits - count)) & 1 : (b >>> (2 * bits - count)) & 1;
            }
            else
            {
                result = count < bits
                    ? ((a >>> count) | (b << (bits - count))) & mask
                    : (b >>> (count - bits)) & mask;
                carry = count <= bits ? (a >>> (count - 1)) & 1 : (b >>> (count - bits - 1)) & 1;
            }
            const overflow = ((a ^ result) & SIGN[size]) !== 0 ? OF : 0;
            write(operands[0], result);
            setFlags((carry ? CF : 0) | overflow | resultFlags(result, size), ARITH);
            return;
        }
        case 'imul':
            imul(operands, size, state, read, write, setFlags);
            return;
        case 'popcnt':
        {
            let value = read(operands[1]);
            let count = 0;
            for (; value !== 0; value >>>= 1)
            {
                count += value & 1;
            }
            write(operands[0], count);
            setFlags(count === 0 ? ZF : 0, ARITH);
            return;
        }
        case 'mul':
        {
            const a = (state.reg[0] & mask) >>> 0;
            const b = read(operands[0]) >>> 0;
            const product = BigInt(a) * BigInt(b);
            const low = Number(product & BigInt(mask));
            const high = Number(product >> BigInt(size * 8));
            writeWide(size, state, low, high);
            setFlags(high !== 0 ? CF | OF : 0);
            return;
        }
        case 'div': case 'idiv':
            divide(op, operands, size, state, read, instruction);
            return;
        case 'cwde':
            if (size === 2)
            {
                const widened = (state.reg[0] << 24 >> 24) & 0xffff;
                state.reg[0] = (state.reg[0] & 0xffff0000 | widened) >>> 0;
            }
            else
            {
                state.reg[0] = (state.reg[0] << 16 >> 16) >>> 0;
            }
            return;
        case 'cdq':
            if (size === 2)
            {
                const sign = (state.reg[0] & 0x8000) ? 0xffff : 0;
                state.reg[2] = (state.reg[2] & 0xffff0000 | sign) >>> 0;
            }
            else
            {
                state.reg[2] = (state.reg[0] & 0x80000000) ? 0xffffffff : 0;
            }
            return;
        case 'push':
        {
            const width = operands[0].kind === 'seg' ? size : operands[0].size;
            // `push esp` pushes the value before the decrement.
            const value = read(operands[0]);
            push(value, width === 1 ? size : width);
            return;
        }
        case 'pop':
        {
            const width = operands[0].kind === 'seg' ? size : operands[0].size;
            const value = pop(width);
            write(operands[0], value);
            return;
        }
        case 'pushad':
        {
            const esp = state.reg[4];
            for (let index = 0; index < 8; index++)
            {
                push(index === 4 ? esp : state.reg[index], size);
            }
            return;
        }
        case 'popad':
        {
            for (let index = 7; index >= 0; index--)
            {
                const value = pop(size);
                if (index !== 4)
                {
                    state.reg[index] = size === 2
                        ? (state.reg[index] & 0xffff0000 | value) >>> 0 : value;
                }
            }
            return;
        }
        case 'pushf':
            push(state.eflags, size);
            return;
        case 'popf':
        {
            const value = pop(size);
            // The reserved bit 1 always reads set; IF, IOPL and the rest of
            // the system bits are not a user program's to change here. AC
            // and ID are: a program finds CPUID by flipping ID, and one that
            // cannot sees no CPUID and takes its generic code.
            const writable = 0xcd5 | DF | (1 << 11) | (1 << 18) | (1 << 21);
            state.eflags = ((state.eflags & ~writable) | (value & writable) | 2) >>> 0;
            return;
        }
        case 'lahf':
            state.reg[0] = (state.reg[0] & 0xffff00ff | ((state.eflags & 0xd5) | 2) << 8) >>> 0;
            return;
        case 'sahf':
            state.eflags = (state.eflags & ~0xd5 | (state.reg[0] >>> 8) & 0xd5) >>> 0;
            return;
        case 'clc': state.eflags &= ~CF; return;
        case 'stc': state.eflags |= CF; return;
        case 'cmc': state.eflags ^= CF; return;
        case 'cld': state.eflags &= ~DF; return;
        case 'std': state.eflags |= DF; return;
        case 'jmp':
            state.eip = operands[0].kind === 'rel'
                ? /** @type {number} */ (operands[0].target)
                : read(operands[0]);
            return;
        case 'call':
        {
            // The target is read before the return address is pushed: a
            // memory operand relative to ESP names the caller's slot, not the
            // one below it -- read after the push, [esp+0x128] was [esp+0x124].
            const target = operands[0].kind === 'rel'
                ? /** @type {number} */ (operands[0].target)
                : read(operands[0]);
            push(next, 4);
            state.eip = target;
            return;
        }
        case 'ret':
            state.eip = pop(4);
            if (operands.length === 1)
            {
                state.reg[4] = (state.reg[4] + /** @type {number} */ (operands[0].value)) >>> 0;
            }
            return;
        case 'leave':
            // A 16-bit leave moves SP (clearing the upper half) and pops BP;
            // the default moves ESP and pops EBP.
            if (size === 2)
            {
                state.reg[4] = (state.reg[4] & 0xffff0000 | state.reg[5] & 0xffff) >>> 0;
                state.reg[5] = (state.reg[5] & 0xffff0000 | pop(2)) >>> 0;
            }
            else
            {
                state.reg[4] = state.reg[5];
                state.reg[5] = pop(4);
            }
            return;
        case 'enter':
        {
            const frame = /** @type {number} */ (operands[0].value);
            const width = instruction.prefixes.operand ? 2 : 4;
            push(state.reg[5], width);
            state.reg[5] = width === 2
                ? (state.reg[5] & 0xffff0000 | state.reg[4] & 0xffff) >>> 0 : state.reg[4];
            state.reg[4] = (state.reg[4] - frame) >>> 0;
            return;
        }
        case 'loop': case 'loope': case 'loopne': case 'jecxz':
        {
            if (op !== 'jecxz')
            {
                state.reg[1] = (state.reg[1] - 1) >>> 0;
            }
            const count = instruction.prefixes.address ? state.reg[1] & 0xffff : state.reg[1];
            const zf = (state.eflags & ZF) !== 0;
            const taken = op === 'jecxz' ? count === 0
                : count !== 0 && (op === 'loop' || (op === 'loope' ? zf : !zf));
            if (taken)
            {
                state.eip = /** @type {number} */ (operands[0].target);
            }
            return;
        }
        case 'bt': case 'bts': case 'btr': case 'btc':
            bitTest(op, operands, size, state, read, write, setFlags, address);
            return;
        case 'bsf': case 'bsr':
        {
            const value = read(operands[1]);
            if (value === 0)
            {
                setFlags(ZF);
                return;
            }
            let index = op === 'bsf' ? 0 : size * 8 - 1;
            while (((value >>> index) & 1) === 0)
            {
                index += op === 'bsf' ? 1 : -1;
            }
            write(operands[0], index);
            setFlags(0);
            return;
        }
        case 'bswap':
        {
            const value = read(operands[0]);
            write(operands[0], ((value >>> 24) | (value >>> 8 & 0xff00) | (value << 8 & 0xff0000)
                | (value << 24)) >>> 0);
            return;
        }
        case 'cmpxchg':
        {
            const accumulator = (state.reg[0] & mask) >>> 0;
            const destination = read(operands[0]) >>> 0;
            const { flags } = subFlags(accumulator, destination, 0, size);
            if (accumulator === destination)
            {
                write(operands[0], read(operands[1]));
            }
            else
            {
                write({ kind: 'reg', size, reg: 0, high: false }, destination);
            }
            setFlags(flags);
            return;
        }
        case 'cmpxchg8b':
        {
            const at = address(operands[0]);
            const low = state.memory.read(at, 4);
            const high = state.memory.read(at + 4, 4);
            if (low === state.reg[0] && high === state.reg[2])
            {
                state.memory.write(at, 4, state.reg[3]);
                state.memory.write(at + 4, 4, state.reg[1]);
                state.eflags |= ZF;
            }
            else
            {
                state.reg[0] = low;
                state.reg[2] = high;
                state.eflags &= ~ZF;
            }
            return;
        }
        case 'movs': case 'stos': case 'lods': case 'cmps': case 'scas':
            stringInstruction(op, instruction, state, read, write, setFlags, address);
            return;
        case 'int3':
            throw new Fault(3, next);
        case 'int':
            throw new Fault(/** @type {number} */ (operands[0].value), next);
        case 'into':
            if ((state.eflags & OF) !== 0)
            {
                throw new Fault(4, next);
            }
            return;
        case 'ud2': case 'ud1':
            throw new Fault(6, instruction.eip);
        case 'out':
            // The trap port, as the model sees it: the value is recorded and
            // whoever runs the model answers it.
            state.trapped.push(read(operands[1]));
            return;
        case 'salc':
            write({ kind: 'reg', size: 1, reg: 0, high: false }, cf ? 0xff : 0);
            return;
        case 'arpl':
        {
            const selector = read(operands[0]) & 0xffff;
            const requested = read(operands[1]) & 3;
            if ((selector & 3) < requested)
            {
                write(operands[0], (selector & ~3 | requested) & 0xffff);
                state.eflags |= ZF;
            }
            else
            {
                state.eflags &= ~ZF;
            }
            return;
        }
        case 'daa': case 'das':
        {
            const add = op === 'daa';
            const al = state.reg[0] & 0xff;
            const oldCf = (state.eflags & CF) !== 0;
            let carry = oldCf;
            let aux = (state.eflags & AF) !== 0;
            let value = al;
            if ((al & 0xf) > 9 || aux)
            {
                if (add)
                {
                    value += 6;
                    if (value > 0xff)
                    {
                        carry = true;
                    }
                }
                else
                {
                    value -= 6;
                    if (al < 6)
                    {
                        carry = true;
                    }
                }
                aux = true;
            }
            if (al > 0x99 || oldCf)
            {
                value += add ? 0x60 : -0x60;
                carry = true;
            }
            const result = value & 0xff;
            state.reg[0] = (state.reg[0] & 0xffffff00 | result) >>> 0;
            state.eflags = logicFlags(result, 1) | (carry ? CF : 0) | (aux ? AF : 0);
            return;
        }
        case 'aaa': case 'aas':
        {
            const ax = state.reg[0] & 0xffff;
            let value = ax;
            let adjusted = false;
            if ((ax & 0xf) > 9 || (state.eflags & AF) !== 0)
            {
                value = (ax + (op === 'aaa' ? 0x106 : -0x106)) & 0xffff;
                adjusted = true;
            }
            value &= 0xff0f;
            state.reg[0] = (state.reg[0] & 0xffff0000 | value) >>> 0;
            state.eflags = logicFlags(value & 0xff, 1)
                | (adjusted ? CF | AF : 0);
            return;
        }
        case 'aam': case 'aad':
        {
            const base = /** @type {number} */ (operands[0].value);
            const al = state.reg[0] & 0xff;
            let result;
            if (op === 'aam')
            {
                if (base === 0)
                {
                    throw new Fault(0, instruction.eip);
                }
                result = (Math.floor(al / base) << 8 | al % base) & 0xffff;
                state.reg[0] = (state.reg[0] & 0xffff0000 | result) >>> 0;
            }
            else
            {
                const ah = state.reg[0] >>> 8 & 0xff;
                result = (al + ah * base) & 0xff;
                // AH is cleared: the whole low word is the new AL.
                state.reg[0] = (state.reg[0] & 0xffff0000 | result) >>> 0;
            }
            state.eflags = logicFlags(result & 0xff, 1);
            return;
        }
        case 'xlat':
        {
            const base = state.reg[3];
            let at = (base + (state.reg[0] & 0xff)) >>> 0;
            if (operands[0].addressSize === 16)
            {
                at &= 0xffff;
            }
            if (operands[0].segment === 4)
            {
                at = (at + state.fsBase) >>> 0;
            }
            state.reg[0] = (state.reg[0] & 0xffffff00 | state.memory.read(at, 1)) >>> 0;
            return;
        }
        case 'fxsave':
            fxsave(state, address(instruction.operands[0]));
            return;
        case 'fxrstor':
            fxrstor(state, address(instruction.operands[0]));
            return;
        case 'cpuid':
        {
            const answer = cpuidLeaf(state.reg[0]);
            state.reg[0] = answer.eax;
            state.reg[1] = answer.ecx;
            state.reg[2] = answer.edx;
            state.reg[3] = answer.ebx;
            return;
        }
        case 'rdtsc':
        {
            // The time-stamp counter is the host's (the emulator's own under
            // hybrid, cork's clock under cork): the low word to eax, the high
            // word to edx.
            const value = state.rdtsc ? state.rdtsc() : 0n;
            state.reg[0] = Number(value & 0xffffffffn);
            state.reg[2] = Number((value >> 32n) & 0xffffffffn);
            return;
        }
        default:
            if (op.startsWith('set') && instruction.cc !== undefined)
            {
                write(operands[0], condition(instruction.cc, state.eflags) ? 1 : 0);
                return;
            }
            if (op.startsWith('cmov') && instruction.cc !== undefined)
            {
                // The source is read even when the move is not made, as the
                // processor does (a bad address faults either way).
                const value = read(operands[1]);
                if (condition(instruction.cc, state.eflags))
                {
                    write(operands[0], value);
                }
                return;
            }
            if (op.startsWith('j') && instruction.cc !== undefined)
            {
                if (condition(instruction.cc, state.eflags))
                {
                    state.eip = /** @type {number} */ (operands[0].target);
                }
                return;
            }
            throw new Unsupported(op);
    }
}

/**
 * @param {string} op
 * @param {import('./decode/decoder.js').Operand[]} operands
 * @param {number} size
 * @param {EvalState} state
 * @param {(o: import('./decode/decoder.js').Operand) => number} read
 * @param {(o: import('./decode/decoder.js').Operand, v: number) => void} write
 * @param {(flags: number, keep?: number) => void} setFlags
 */
function shiftOrRotate(op, operands, size, state, read, write, setFlags){
    const count = read(operands[1]);
    const value = read(operands[0]);
    const out = shift(op, value, count, state.eflags, size);
    if (out !== null)
    {
        write(operands[0], out.result);
        setFlags(out.flags, out.written);
    }
}

/**
 * A shift or rotate of `value` by `count` (masked to five bits here): the
 * result, its flags and the flags it writes, or null for a count of zero, which
 * writes nothing and leaves the flags.
 *
 * @param {string} op @param {number} value @param {number} count
 * @param {number} eflags the flags before, for rcl/rcr's carry in
 * @param {number} size
 * @returns {{ result: number, flags: number, written: number } | null}
 */
export function shift(op, value, count, eflags, size){
    const bits = size * 8;
    const mask = MASK[size];
    count &= 31;
    const cf = (eflags & CF) !== 0 ? 1 : 0;
    if (count === 0)
    {
        return null;
    }
    let result;
    let carry;
    let overflow;
    switch (op)
    {
        case 'shl': case 'sal':
            result = count < bits ? (value << count) & mask : 0;
            carry = count <= bits ? (value >>> (bits - count)) & 1 : 0;
            overflow = ((result & SIGN[size]) !== 0 ? 1 : 0) ^ carry;
            break;
        case 'shr':
            result = count < bits ? (value >>> count) & mask : 0;
            carry = count <= bits ? (value >>> (count - 1)) & 1 : 0;
            overflow = (value & SIGN[size]) !== 0 ? 1 : 0;
            break;
        case 'sar':
        {
            const signed = value << (32 - bits) >> (32 - bits);
            result = (count < bits ? signed >> count : signed >> (bits - 1)) & mask;
            carry = count <= bits ? (signed >> (count - 1)) & 1 : (signed >> (bits - 1)) & 1;
            overflow = 0;
            break;
        }
        case 'rol':
            count %= bits;
            result = count === 0 ? value : ((value << count) | (value >>> (bits - count))) & mask;
            carry = result & 1;
            overflow = ((result & SIGN[size]) !== 0 ? 1 : 0) ^ carry;
            break;
        case 'ror':
            count %= bits;
            result = count === 0 ? value : ((value >>> count) | (value << (bits - count))) & mask;
            carry = (result & SIGN[size]) !== 0 ? 1 : 0;
            overflow = carry ^ ((result & (SIGN[size] >>> 1)) !== 0 ? 1 : 0);
            break;
        case 'rcl':
        {
            count %= bits + 1;
            let rotated = value;
            let c = cf;
            for (let i = 0; i < count; i++)
            {
                const top = (rotated & SIGN[size]) !== 0 ? 1 : 0;
                rotated = ((rotated << 1) | c) & mask;
                c = top;
            }
            result = rotated;
            carry = c;
            overflow = ((result & SIGN[size]) !== 0 ? 1 : 0) ^ carry;
            break;
        }
        default: // rcr
        {
            count %= bits + 1;
            let rotated = value;
            let c = cf;
            overflow = ((value & SIGN[size]) !== 0 ? 1 : 0) ^ cf;
            for (let i = 0; i < count; i++)
            {
                const low = rotated & 1;
                rotated = ((rotated >>> 1) | (c << (bits - 1))) & mask;
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
 * @param {import('./decode/decoder.js').Operand[]} operands
 * @param {number} size
 * @param {EvalState} state
 * @param {(o: import('./decode/decoder.js').Operand) => number} read
 * @param {(o: import('./decode/decoder.js').Operand, v: number) => void} write
 * @param {(flags: number, keep?: number) => void} setFlags
 */
function imul(operands, size, state, read, write, setFlags){
    const bits = size * 8;
    /** @param {number} value */
    const signed = value=>BigInt.asIntN(bits, BigInt(value));
    if (operands.length === 1)
    {
        const product = signed(state.reg[0] & MASK[size]) * signed(read(operands[0]));
        const low = Number(BigInt.asUintN(bits, product));
        const high = Number(BigInt.asUintN(bits, product >> BigInt(bits)));
        writeWide(size, state, low, high);
        const fits = BigInt.asIntN(bits, product) === product;
        setFlags(fits ? 0 : CF | OF);
        return;
    }
    const a = read(operands[operands.length === 3 ? 1 : 0]);
    const b = read(operands[operands.length === 3 ? 2 : 1]);
    const { result, flags } = imulTruncated(a, b, size);
    write(operands[0], result);
    setFlags(flags);
}

/**
 * The two- and three-operand imul: the product of `a` and `b` as signed
 * values of `size` bytes, truncated to that size, with CF and OF set when it
 * did not fit. The double product is exact below 2^53 and on the right side of
 * the limit above it, so the fit test needs no BigInt.
 *
 * @param {number} a @param {number} b @param {number} size
 */
export function imulTruncated(a, b, size){
    const extend = 32 - size * 8;
    const x = a << extend >> extend;
    const y = b << extend >> extend;
    const product = x * y;
    const limit = 2 ** (size * 8 - 1);
    return {
        result: (Math.imul(x, y) & MASK[size]) >>> 0,
        flags: product >= -limit && product < limit ? 0 : CF | OF,
    };
}

/**
 * The wide result of mul/imul: al/ax, dx:ax or edx:eax.
 * @param {number} size @param {EvalState} state @param {number} low @param {number} high
 */
function writeWide(size, state, low, high){
    if (size === 1)
    {
        state.reg[0] = (state.reg[0] & 0xffff0000 | low | high << 8) >>> 0;
    }
    else if (size === 2)
    {
        state.reg[0] = (state.reg[0] & 0xffff0000 | low) >>> 0;
        state.reg[2] = (state.reg[2] & 0xffff0000 | high) >>> 0;
    }
    else
    {
        state.reg[0] = low >>> 0;
        state.reg[2] = high >>> 0;
    }
}

/**
 * @param {string} op
 * @param {import('./decode/decoder.js').Operand[]} operands
 * @param {number} size
 * @param {EvalState} state
 * @param {(o: import('./decode/decoder.js').Operand) => number} read
 * @param {import('./decode/decoder.js').Instruction} instruction
 */
function divide(op, operands, size, state, read, instruction){
    const bits = size * 8;
    const operand = read(operands[0]);
    const divisor = op === 'idiv' ? operand : operand >>> 0;
    if (divisor === 0)
    {
        throw new Fault(0, instruction.eip);
    }
    let dividend;
    if (size === 1)
    {
        dividend = BigInt(state.reg[0] & 0xffff);
    }
    else if (size === 2)
    {
        dividend = BigInt((state.reg[2] & 0xffff) << 16 | (state.reg[0] & 0xffff)) & 0xffffffffn;
    }
    else
    {
        dividend = (BigInt(state.reg[2]) << 32n) | BigInt(state.reg[0]);
    }
    let quotient;
    let remainder;
    if (op === 'div')
    {
        quotient = dividend / BigInt(divisor);
        remainder = dividend % BigInt(divisor);
        if (quotient > BigInt(MASK[size]))
        {
            throw new Fault(0, instruction.eip);
        }
    }
    else
    {
        const signedDividend = BigInt.asIntN(bits * 2, dividend);
        const signedDivisor = BigInt.asIntN(bits, BigInt(divisor));
        quotient = signedDividend / signedDivisor;
        remainder = signedDividend % signedDivisor;
        if (BigInt.asIntN(bits, quotient) !== quotient)
        {
            throw new Fault(0, instruction.eip);
        }
    }
    writeWide(size, state,
        Number(BigInt.asUintN(bits, quotient)), Number(BigInt.asUintN(bits, remainder)));
    // Every flag undefined: left as they were.
}

/**
 * @param {string} op
 * @param {import('./decode/decoder.js').Operand[]} operands
 * @param {number} size
 * @param {EvalState} state
 * @param {(o: import('./decode/decoder.js').Operand) => number} read
 * @param {(o: import('./decode/decoder.js').Operand, v: number) => void} write
 * @param {(flags: number, keep?: number) => void} setFlags
 * @param {(o: import('./decode/decoder.js').Operand) => number} address
 */
function bitTest(op, operands, size, state, read, write, setFlags, address){
    const bits = size * 8;
    let offset = read(operands[1]);
    /** @type {import('./decode/decoder.js').Operand} */
    let target = operands[0];
    if (target.kind === 'mem' && operands[1].kind === 'reg')
    {
        // A register bit offset addresses memory beyond the operand: the
        // word that holds the bit is the one at the signed offset.
        const signedOffset = offset << (32 - bits) >> (32 - bits);
        const byteOffset = Math.floor(signedOffset / bits) * size;
        target = { ...target, disp: ((target.disp ?? 0) + byteOffset) | 0 };
        offset = ((signedOffset % bits) + bits) % bits;
    }
    else
    {
        offset &= bits - 1;
    }
    const value = read(target);
    const bit = (value >>> offset) & 1;
    if (op === 'bts')
    {
        write(target, value | (1 << offset));
    }
    else if (op === 'btr')
    {
        write(target, value & ~(1 << offset));
    }
    else if (op === 'btc')
    {
        write(target, value ^ (1 << offset));
    }
    void address;
    setFlags(bit ? CF : 0);
}

/**
 * @param {string} op
 * @param {import('./decode/decoder.js').Instruction} instruction
 * @param {EvalState} state
 * @param {(o: import('./decode/decoder.js').Operand) => number} read
 * @param {(o: import('./decode/decoder.js').Operand, v: number) => void} write
 * @param {(flags: number, keep?: number) => void} setFlags
 * @param {(o: import('./decode/decoder.js').Operand) => number} address
 */
function stringInstruction(op, instruction, state, read, write, setFlags, address){
    void address;
    const { operands, size, prefixes } = instruction;
    const step = (state.eflags & DF) !== 0 ? -size : size;
    const repeat = prefixes.rep || prefixes.repne;
    const countMask = prefixes.address ? 0xffff : 0xffffffff;
    /** @param {number} index @param {number} by */
    const advance = (index, by)=>{
        state.reg[index] = prefixes.address
            ? (state.reg[index] & 0xffff0000 | (state.reg[index] + by) & 0xffff) >>> 0
            : (state.reg[index] + by) >>> 0;
    };
    for (;;)
    {
        if (repeat && (state.reg[1] & countMask) === 0)
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
            case 'cmps':
            {
                const { flags } = subFlags(read(operands[0]), read(operands[1]), 0, size);
                setFlags(flags);
                advance(6, step);
                advance(7, step);
                done = repeat && ((flags & ZF) !== 0) !== prefixes.rep;
                break;
            }
            default: // scas
            {
                const { flags } = subFlags(read(operands[0]), read(operands[1]), 0, size);
                setFlags(flags);
                advance(7, step);
                done = repeat && ((flags & ZF) !== 0) !== prefixes.rep;
            }
        }
        if (!repeat)
        {
            return;
        }
        advance(1, -1);
        if (done)
        {
            return;
        }
    }
}

export { REGISTERS, MASK, conditionReads };
