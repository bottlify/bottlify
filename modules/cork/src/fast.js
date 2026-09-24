/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The interpreter's fast path: a decoded instruction of the common integer
 * kinds turned once into a function of the state, its operands resolved to
 * register indices, constants and address arithmetic, and kept with the
 * decoded instruction. `evaluate` builds its operand closures on every step
 * and classifies the instruction by a regular expression each time, which put
 * the interpreter at three hundred nanoseconds an instruction; a compiled one
 * runs the same arithmetic and flags (the same `addFlags`, `subFlags`,
 * `logicFlags`, `condition`, `shift` and `imulTruncated`) with none of that.
 * An x87 instruction goes straight to the x87 model, skipping `evaluate`'s
 * setup. Anything else -- SSE, strings, the rest -- answers null and runs
 * through `evaluate`.
 */

import { AF, CF, OF, PF, SF, ZF } from './decode/table.js';
import {
    MASK, Unsupported, addFlags, condition, imulTruncated, logicFlags, operandAddress, shift,
    subFlags,
} from './ir.js';
import { evaluateX87, isX87Op } from './ir-x87.js';

const ARITH = CF | PF | AF | ZF | SF | OF;

/** @typedef {import('./ir.js').EvalState} EvalState */
/** @typedef {import('./decode/decoder.js').Instruction} Instruction */
/** @typedef {import('./decode/decoder.js').Operand} Operand */
/** @typedef {(state: EvalState) => void} Step */

/**
 * The address of a memory operand, as a function of the state.
 *
 * @param {Operand} operand
 * @returns {((state: EvalState) => number) | null}
 */
function addressOf(operand){
    if (operand.addressSize === 16)
    {
        // The rare form keeps `evaluate`.
        return null;
    }
    if (operand.segment === 4)
    {
        // fs: adds the thread block's base to the offset.
        const offset = addressOf({ ...operand, segment: undefined });
        return offset && (state=>(offset(state) + state.fsBase) >>> 0);
    }
    const disp = operand.disp ?? 0;
    const base = operand.base ?? -1;
    const index = operand.index ?? -1;
    const scale = operand.scale ?? 1;
    if (base >= 0 && index >= 0)
    {
        return state=>(disp + state.reg[base] + state.reg[index] * scale) >>> 0;
    }
    if (base >= 0)
    {
        return state=>(disp + state.reg[base]) >>> 0;
    }
    if (index >= 0)
    {
        return state=>(disp + state.reg[index] * scale) >>> 0;
    }
    const at = disp >>> 0;
    return ()=>at;
}

/**
 * Reads an operand, as a function of the state.
 *
 * @param {Operand} operand
 * @returns {((state: EvalState) => number) | null}
 */
function reader(operand){
    switch (operand.kind)
    {
        case 'reg':
        {
            const r = /** @type {number} */ (operand.reg);
            if (operand.size === 4)
            {
                return state=>state.reg[r];
            }
            if (operand.size === 2)
            {
                return state=>state.reg[r] & 0xffff;
            }
            return operand.high ? state=>state.reg[r] >>> 8 & 0xff : state=>state.reg[r] & 0xff;
        }
        case 'imm':
        {
            const value = /** @type {number} */ (operand.value) >>> 0;
            return ()=>value;
        }
        case 'mem':
        {
            const address = addressOf(operand);
            if (address === null)
            {
                return null;
            }
            const size = operand.size;
            return state=>state.memory.read(address(state), size);
        }
        default:
            return null;
    }
}

/**
 * Writes an operand, as a function of the state and the value.
 *
 * @param {Operand} operand
 * @returns {((state: EvalState, value: number) => void) | null}
 */
function writer(operand){
    switch (operand.kind)
    {
        case 'reg':
        {
            const r = /** @type {number} */ (operand.reg);
            if (operand.size === 4)
            {
                return (state, value)=>{
                    state.reg[r] = value >>> 0;
                };
            }
            if (operand.size === 2)
            {
                return (state, value)=>{
                    state.reg[r] = (state.reg[r] & 0xffff0000 | value & 0xffff) >>> 0;
                };
            }
            return operand.high
                ? (state, value)=>{
                    state.reg[r] = (state.reg[r] & 0xffff00ff | (value & 0xff) << 8) >>> 0;
                }
                : (state, value)=>{
                    state.reg[r] = (state.reg[r] & 0xffffff00 | value & 0xff) >>> 0;
                };
        }
        case 'mem':
        {
            const address = addressOf(operand);
            if (address === null)
            {
                return null;
            }
            const size = operand.size;
            const mask = MASK[size];
            return (state, value)=>state.memory.write(address(state), size, value & mask);
        }
        default:
            return null;
    }
}

/**
 * The compiled step of an instruction, or null to leave it to `evaluate`. The
 * step is the instruction's own work: the caller moves EIP to the next
 * instruction and counts it first, as `evaluate` does before its work.
 *
 * @param {Instruction} instruction
 * @returns {Step | null}
 */
export function compileFast(instruction){
    const { op, operands, size } = instruction;
    if (isX87Op(instruction))
    {
        // The x87 model itself, without `evaluate`'s integer closures and its
        // classification of the instruction on every step.
        return state=>{
            if (!evaluateX87(instruction, state, operand=>operandAddress(state, operand)))
            {
                throw new Unsupported(op);
            }
        };
    }
    const mask = MASK[size] ?? 0xffffffff;
    const written = (instruction.flagsWritten & ~instruction.flagsUndefined) >>> 0;
    /** @param {EvalState} state @param {number} flags @param {number} bits */
    const setFlags = (state, flags, bits)=>{
        state.eflags = (state.eflags & ~bits | flags & bits) >>> 0;
    };
    const [dst, src] = operands;
    switch (op)
    {
        case 'nop':
            return ()=>{};
        case 'mov':
        case 'movzx':
        {
            if (op === 'mov' && (dst.kind === 'seg' || src.kind === 'seg'))
            {
                return null;
            }
            const read = reader(src);
            const write = writer(dst);
            return read && write && (state=>write(state, read(state)));
        }
        case 'movsx':
        {
            const read = reader(src);
            const write = writer(dst);
            const extend = 32 - src.size * 8;
            return read && write && (state=>write(state, (read(state) << extend >> extend) >>> 0));
        }
        case 'lea':
        {
            const address = src.kind === 'mem' ? addressOf(src) : null;
            const write = writer(dst);
            return address && write && (state=>write(state, address(state) & mask));
        }
        case 'add': case 'sub': case 'cmp': case 'adc': case 'sbb':
        {
            const readA = reader(dst);
            const readB = reader(src);
            const write = op === 'cmp' ? null : writer(dst);
            if (!readA || !readB || (op !== 'cmp' && !write))
            {
                return null;
            }
            const carrying = op === 'adc' || op === 'sbb';
            const adding = op === 'add' || op === 'adc';
            return state=>{
                const carry = carrying ? state.eflags & CF : 0;
                const { result, flags } = adding
                    ? addFlags(readA(state), readB(state), carry, size)
                    : subFlags(readA(state), readB(state), carry, size);
                if (write)
                {
                    write(state, result);
                }
                setFlags(state, flags, written);
            };
        }
        case 'and': case 'or': case 'xor': case 'test':
        {
            const readA = reader(dst);
            const readB = reader(src);
            const write = op === 'test' ? null : writer(dst);
            if (!readA || !readB || (op !== 'test' && !write))
            {
                return null;
            }
            return state=>{
                const a = readA(state);
                const b = readB(state);
                const mixed = op === 'and' || op === 'test' ? a & b : op === 'or' ? a | b : a ^ b;
                const result = (mixed & mask) >>> 0;
                if (write)
                {
                    write(state, result);
                }
                setFlags(state, logicFlags(result, size), ARITH);
            };
        }
        case 'inc': case 'dec':
        {
            const read = reader(dst);
            const write = writer(dst);
            if (!read || !write)
            {
                return null;
            }
            const adding = op === 'inc';
            return state=>{
                const { result, flags } = adding
                    ? addFlags(read(state), 1, 0, size)
                    : subFlags(read(state), 1, 0, size);
                write(state, result);
                setFlags(state, flags, written);
            };
        }
        case 'not':
        {
            const read = reader(dst);
            const write = writer(dst);
            return read && write && (state=>write(state, (~read(state) & mask) >>> 0));
        }
        case 'neg':
        {
            const read = reader(dst);
            const write = writer(dst);
            if (!read || !write)
            {
                return null;
            }
            return state=>{
                const { result, flags } = subFlags(0, read(state), 0, size);
                write(state, result);
                setFlags(state, flags, written);
            };
        }
        case 'shl': case 'sal': case 'shr': case 'sar': case 'rol': case 'ror':
        case 'rcl': case 'rcr':
        {
            const read = reader(dst);
            const readCount = reader(src);
            const write = writer(dst);
            if (!read || !readCount || !write)
            {
                return null;
            }
            return state=>{
                // The count is read first, as `evaluate` reads it.
                const count = readCount(state);
                const out = shift(op, read(state), count, state.eflags, size);
                if (out !== null)
                {
                    write(state, out.result);
                    setFlags(state, out.flags, out.written);
                }
            };
        }
        case 'imul':
        {
            if (operands.length === 1)
            {
                return null;
            }
            const three = operands.length === 3;
            const readA = reader(three ? src : dst);
            const readB = reader(three ? operands[2] : src);
            const write = writer(dst);
            if (!readA || !readB || !write)
            {
                return null;
            }
            return state=>{
                const { result, flags } = imulTruncated(readA(state), readB(state), size);
                write(state, result);
                setFlags(state, flags, written);
            };
        }
        case 'cdq':
            return size === 4
                ? state=>{
                    state.reg[2] = (state.reg[0] & 0x80000000) !== 0 ? 0xffffffff : 0;
                }
                : null;
        case 'xchg':
        {
            const readA = reader(dst);
            const readB = reader(src);
            const writeA = writer(dst);
            const writeB = writer(src);
            if (!readA || !readB || !writeA || !writeB)
            {
                return null;
            }
            return state=>{
                const a = readA(state);
                const b = readB(state);
                writeA(state, b);
                writeB(state, a);
            };
        }
        case 'push':
        {
            // Four-byte pushes; `push esp` pushes the value before the decrement.
            if (dst.kind === 'seg' || (dst.kind !== 'imm' && dst.size !== 4) || size !== 4)
            {
                return null;
            }
            const read = reader(dst);
            return read && (state=>{
                const value = read(state);
                // The write first: one that faults leaves esp as it was.
                const at = (state.reg[4] - 4) >>> 0;
                state.memory.write(at, 4, value >>> 0);
                state.reg[4] = at;
            });
        }
        case 'pop':
        {
            if (dst.kind !== 'reg' || dst.size !== 4)
            {
                return null;
            }
            const r = /** @type {number} */ (dst.reg);
            return state=>{
                const value = state.memory.read(state.reg[4], 4);
                state.reg[4] = (state.reg[4] + 4) >>> 0;
                state.reg[r] = value >>> 0;
            };
        }
        case 'jmp':
        {
            if (dst.kind === 'rel')
            {
                const target = /** @type {number} */ (dst.target);
                return state=>{
                    state.eip = target;
                };
            }
            const read = reader(dst);
            return read && (state=>{
                state.eip = read(state);
            });
        }
        case 'call':
        {
            const next = (instruction.eip + instruction.length) >>> 0;
            // The target is read before the return address is pushed (a
            // memory operand relative to ESP names the caller's slot).
            const read = dst.kind === 'rel' ? null : reader(dst);
            if (dst.kind !== 'rel' && !read)
            {
                return null;
            }
            const fixed = dst.kind === 'rel' ? /** @type {number} */ (dst.target) : 0;
            return state=>{
                const target = read ? read(state) : fixed;
                const at = (state.reg[4] - 4) >>> 0;
                state.memory.write(at, 4, next);
                state.reg[4] = at;
                state.eip = target;
            };
        }
        case 'ret':
        {
            const extra = operands.length === 1 ? /** @type {number} */ (dst.value) : 0;
            return state=>{
                state.eip = state.memory.read(state.reg[4], 4);
                state.reg[4] = (state.reg[4] + 4 + extra) >>> 0;
            };
        }
        case 'leave':
            if (size !== 4)
            {
                return null;
            }
            return state=>{
                // The read first: one that faults leaves esp as it was.
                const value = state.memory.read(state.reg[5], 4);
                state.reg[4] = (state.reg[5] + 4) >>> 0;
                state.reg[5] = value >>> 0;
            };
        default:
        {
            const cc = instruction.cc;
            if (cc === undefined)
            {
                return null;
            }
            if (op.startsWith('j') && dst.kind === 'rel')
            {
                const target = /** @type {number} */ (dst.target);
                return state=>{
                    if (condition(cc, state.eflags))
                    {
                        state.eip = target;
                    }
                };
            }
            if (op.startsWith('set'))
            {
                const write = writer(dst);
                return write && (state=>write(state, condition(cc, state.eflags) ? 1 : 0));
            }
            if (op.startsWith('cmov'))
            {
                const read = reader(src);
                const write = writer(dst);
                return read && write && (state=>{
                    // The source is read even when the move is not made.
                    const value = read(state);
                    if (condition(cc, state.eflags))
                    {
                        write(state, value);
                    }
                });
            }
            return null;
        }
    }
}
