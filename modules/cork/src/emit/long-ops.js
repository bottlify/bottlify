/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Which long-mode instructions the shared emitter translates at the 64-bit
 * width (`integer.js`, `simd.js`): what `formRegion` ends a block before in
 * long mode, so the interpreter runs the rest. Apart from the emitter, as the
 * former takes it on every thread a region is formed on, a worker's included.
 */

/** @typedef {import('../decode/decoder.js').Instruction} Instruction */

/** The long-mode instructions this emitter translates so far, by mnemonic. */
const LONG_OPS = new Set([
    'nop', 'mov', 'movzx', 'movsx', 'movsxd', 'lea', 'add', 'adc', 'sub', 'sbb', 'cmp', 'and',
    'or', 'xor', 'test', 'inc', 'dec', 'neg', 'not', 'push', 'pop', 'jmp', 'call', 'ret', 'hlt',
    'shl', 'sal', 'shr', 'sar', 'rol', 'ror', 'rcl', 'rcr', 'imul', 'mul', 'div', 'idiv',
    'xchg', 'popcnt', 'cwde', 'cdq', 'leave', 'bsf', 'bsr', 'bswap', 'prefetch', 'prefetchw',
    'prefetchnta', 'prefetcht0', 'prefetcht1', 'prefetcht2', 'lfence', 'mfence', 'sfence', 'pause',
    'emms', 'ldmxcsr', 'stmxcsr', 'bt', 'bts', 'btr', 'btc',
    'clc', 'stc', 'cmc', 'cld', 'std', 'lahf', 'sahf', 'pushf', 'popf', 'xadd', 'cmpxchg',
    'cmpxchg8b', 'movnti',
]);

/** The string instructions, `rep` and DF either way. */
const STRING_OPS = new Set(['movs', 'stos', 'lods', 'cmps', 'scas']);

/**
 * What a `lock` prefix may stand on. A process in long mode runs on one
 * executor, so a locked instruction is its plain form.
 */
const LOCKABLE = new Set(['add', 'adc', 'and', 'btc', 'btr', 'bts', 'cmpxchg', 'cmpxchg8b',
    'dec', 'inc', 'neg', 'not', 'or', 'sbb', 'sub', 'xor', 'xadd', 'xchg']);

/**
 * The SIMD operations the long-mode emitter leaves to the interpreter: those
 * that address memory through a register of their own (edi).
 */
const LONG_SIMD_LEFT = new Set(['maskmovq', 'maskmovdqu']);

/** The SIMD operations whose general operand may be a quadword register. */
const LONG_SIMD_QUAD = new Set(['movd', 'cvtsi2ss', 'cvtsi2sd', 'cvttss2si', 'cvtss2si',
    'cvttsd2si', 'cvtsd2si']);

/**
 * Whether the emitter translates a long-mode instruction: its operation one
 * it has a quadword's case for, its operands general registers, immediates,
 * memory addressed at 64 bits and direct targets. Forming ends a block before
 * any other (`formRegion`'s `translates`, its default in long mode), which the
 * interpreter runs.
 *
 * @param {Instruction} instruction
 */
export function translatesLong(instruction){
    const { op, operands, prefixes, cc } = instruction;
    if (prefixes.lock && (!LOCKABLE.has(op) || instruction.memory !== true)
        || (op === 'jmp' || op === 'call') && operands[0].kind !== 'rel'
        && operands[0].size !== 8)
    {
        return false;
    }
    const simd = operands.some(operand=>operand.kind === 'xmm' || operand.kind === 'mm')
        || LONG_SIMD_QUAD.has(op);
    if (simd)
    {
        // A general register other SIMD operations read or write as a dword only.
        if (LONG_SIMD_LEFT.has(op) || operands.some(operand=>operand.kind === 'reg'
            && operand.size === 8 && !LONG_SIMD_QUAD.has(op)))
        {
            return false;
        }
    }
    else if (STRING_OPS.has(op))
    {
        // rsi, rdi and rcx as quadwords, and a source of a segment with no base.
        return operands.every(operand=>operand.kind !== 'mem'
            || operand.addressSize === 64 && operand.segment !== 4 && operand.segment !== 5);
    }
    else if (op === 'out')
    {
        // `out dx, eax`, the host's call channel where dx names the trap port.
        return operands[0].kind === 'reg' && operands[1].size === 4;
    }
    else if (!LONG_OPS.has(op) && !(cc !== undefined && (op.startsWith('j') && op !== 'jecxz'
        || op.startsWith('cmov') || op.startsWith('set'))))
    {
        return false;
    }
    return operands.every(operand=>(operand.kind === 'reg' && operand.size > 0)
        || operand.kind === 'xmm' || operand.kind === 'mm'
        || operand.kind === 'imm' || operand.kind === 'rel'
        || (operand.kind === 'mem' && operand.addressSize === 64));
}
