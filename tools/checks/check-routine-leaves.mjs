/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when a guest routine the graphics seam builds for a 64-bit process
 * is not what an unwinder takes code without unwind data to be: a leaf, its
 * return address at RSP and RBX, RBP, RSI, RDI and R12 to R15 the caller's.
 *
 * The routines live outside every image's function table. A 64-bit program's
 * exception - a fault through a pointer it passed, a C++ throw on another
 * thread while this one is suspended and walked - unwinds through whatever
 * instruction the thread is at; in a routine that had moved RSP or held its
 * own value in RBX, the walk would hand the caller's frame a wrong register
 * and go on from a wrong return address.
 *
 * The rule read off the bytes is stricter than "writes none of them" and has
 * no cases to argue: a routine names no non-volatile register at all, as an
 * operand or in an address (XMM6 to XMM15 among them), names RSP only as the
 * base of an address (its arguments' slots), and has no instruction that
 * uses one without naming it - a push or pop, a string instruction (RSI,
 * RDI), `cmpxchg8b` (RBX), `enter`, `leave`. `call` and `ret` are a leaf's
 * own: the routine called is held to the same rule.
 *
 *     node tools/checks/check-routine-leaves.mjs
 */

import { MODE_64, decode } from '../../modules/cork/src/decode/decoder.js';
import { X64 } from '../../modules/core/src/layers/graphics/seam/routines/assemble.js';
import { ROUTINE_AT, routinesFor }
    from '../../modules/core/src/layers/graphics/seam/routines/catalog.fixture.js';
import { isMain } from '../lib/common.mjs';

const RSP = 4;
/** RBX, RBP, RSI, RDI, R12 to R15: what a callee gives back as it found them. */
const KEPT = new Set([3, 5, 6, 7, 12, 13, 14, 15]);
const NAMES = ['rax', 'rcx', 'rdx', 'rbx', 'rsp', 'rbp', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11',
    'r12', 'r13', 'r14', 'r15'];
/** Operations that change RSP or use a kept register without an operand that names it. */
const IMPLICIT = new Set(['push', 'pop', 'pushf', 'popf', 'enter', 'leave', 'movs', 'stos', 'lods',
    'cmps', 'scas', 'ins', 'outs', 'cmpxchg8b', 'cmpxchg16b', 'xlat', 'cpuid']);

/**
 * What in `code` (x86-64, placed at `at`) an unwinder would not take for a
 * leaf's: each as `+offset: what`.
 *
 * @param {Uint8Array} code @param {number} [at]
 * @returns {string[]}
 */
export function leafFaults(code, at = ROUTINE_AT){
    /** @type {string[]} */
    const faults = [];
    for (let offset = 0; offset < code.length;)
    {
        const decoded = /** @type {any} */ (decode(address=>code[address - at] ?? 0, at + offset,
            MODE_64));
        if ('reason' in decoded || !(decoded.length > 0))
        {
            // What the check cannot read it cannot pass.
            faults.push(`+${offset}: not an instruction the decoder reads (${decoded.reason})`);
            break;
        }
        if (IMPLICIT.has(decoded.op))
        {
            faults.push(`+${offset}: ${decoded.op}`);
        }
        for (const operand of decoded.operands ?? [])
        {
            if (operand?.kind === 'reg')
            {
                // AH to BH come as registers 0 to 3 marked `high`: BH is RBX's.
                if (KEPT.has(operand.reg) || operand.reg === RSP && !operand.high)
                {
                    faults.push(`+${offset}: ${decoded.op} names ${NAMES[operand.reg]}`);
                }
            }
            else if (operand?.kind === 'xmm' && operand.reg >= 6)
            {
                faults.push(`+${offset}: ${decoded.op} names xmm${operand.reg}`);
            }
            else if (operand?.kind === 'mem')
            {
                for (const reg of [operand.base, operand.index])
                {
                    if (KEPT.has(reg))
                    {
                        faults.push(`+${offset}: ${decoded.op} addresses through ${NAMES[reg]}`);
                    }
                }
                if (operand.index === RSP)
                {
                    faults.push(`+${offset}: ${decoded.op} addresses through rsp as an index`);
                }
            }
        }
        offset += decoded.length;
    }
    return faults;
}

if (isMain(import.meta.url))
{
    const routines = routinesFor(X64);
    let failed = 0;
    for (const { name, code } of routines)
    {
        for (const fault of leafFaults(code))
        {
            console.error(`${name} ${fault}: a 64-bit process's routine is a leaf to the`
                + ' unwinder (seam/routines/volatile.js)');
            failed++;
        }
    }
    if (failed > 0 || routines.length === 0)
    {
        console.error(`check-routine-leaves: ${failed} faults in ${routines.length} routines`);
        process.exit(1);
    }
    console.log(`check-routine-leaves: ${routines.length} x86-64 routines, each a leaf`);
}
