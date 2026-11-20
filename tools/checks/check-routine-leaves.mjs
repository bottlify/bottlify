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
 * The guest-code compiler's x86-64 (`*.x64.js`, from `@guestCode` sources) is
 * outside every function table too. A function it marks `leaf` is held to
 * the same rule, over the instructions its entry reaches (tables and
 * constants lie after them); the rest - a function that calls, pushes what an
 * expression holds or keeps a register for a loop - are counted and said, by
 * module: an unwind through one of those is wrong until they carry unwind
 * data, and the count is what that work is owed for. `--list` names them.
 *
 *     node tools/checks/check-routine-leaves.mjs [--list]
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
        faults.push(...instructionFaults(decoded, offset));
        offset += decoded.length;
    }
    return faults;
}

/**
 * What one instruction does that a leaf's does not.
 *
 * @param {any} decoded @param {number} offset
 * @returns {string[]}
 */
function instructionFaults(decoded, offset){
    /** @type {string[]} */
    const faults = [];
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
    return faults;
}

/**
 * `leafFaults` over the instructions the entry reaches - each branch both
 * ways, a call's target and its return - for code with tables or constants
 * after its instructions, which a walk from first byte to last would read
 * as instructions.
 *
 * @param {Uint8Array} code @param {number} [at]
 * @param {number} [host]  Where a hand-over's `jmp rel32` keeps its displacement.
 * @returns {string[]}
 */
export function reachedLeafFaults(code, at = ROUTINE_AT, host = undefined){
    /** @type {[number, string][]} */
    const faults = [];
    const seen = new Set();
    const pending = [0];
    while (pending.length > 0)
    {
        const offset = /** @type {number} */ (pending.pop());
        if (seen.has(offset) || offset < 0 || offset >= code.length)
        {
            continue;
        }
        seen.add(offset);
        const decoded = /** @type {any} */ (decode(address=>code[address - at] ?? 0, at + offset,
            MODE_64));
        if ('reason' in decoded || !(decoded.length > 0))
        {
            faults.push([offset, `+${offset}: not an instruction the decoder reads `
                + `(${decoded.reason})`]);
            continue;
        }
        faults.push(...instructionFaults(decoded, offset).map(fault=>
            /** @type {[number, string]} */ ([offset, fault])));
        // The hand-over's jump leaves the code: its displacement is the binding's to write.
        if (decoded.operands?.[0]?.kind === 'rel' && offset + 1 !== host)
        {
            pending.push(decoded.operands[0].target - at);
        }
        if (decoded.op !== 'ret' && decoded.op !== 'jmp')
        {
            pending.push(offset + decoded.length);
        }
    }
    return faults.sort((left, right)=>left[0] - right[0]).map(([, fault])=>fault);
}

/** Core's sources, where the compiled modules lie beside theirs. */
const SRC = fileURLToPath(new URL('../../modules/core/src', import.meta.url));

/** @param {string} dir @param {string[]} [found] @returns {Promise<string[]>} */
async function compiledModules(dir, found = []){
    for (const entry of await readdir(dir, { withFileTypes: true }))
    {
        const path = join(dir, entry.name);
        if (entry.isDirectory())
        {
            await compiledModules(path, found);
        }
        else if (entry.name.endsWith('.x64.js'))
        {
            found.push(path);
        }
    }
    return found.sort();
}

/**
 * The compiler's x86-64 by what it is to an unwinder: the functions marked
 * `leaf` with what is no leaf's in them (none, or the mark is wrong), and
 * the others by module.
 *
 * @returns {Promise<{ leaves: number, faults: string[], others: Map<string, string[]> }>}
 */
export async function compiledLeaves(){
    let leaves = 0;
    /** @type {string[]} */
    const faults = [];
    /** @type {Map<string, string[]>} */
    const others = new Map();
    for (const path of await compiledModules(SRC))
    {
        const name = path.slice(SRC.length + 1);
        const { COMPILED } = await import(pathToFileURL(path).href);
        for (const [fn, record] of Object.entries(/** @type {Record<string, any>} */ (COMPILED)))
        {
            if (record.leaf !== true)
            {
                others.set(name, [...others.get(name) ?? [], fn]);
                continue;
            }
            leaves++;
            for (const fault of reachedLeafFaults(record.code, ROUTINE_AT, record.host))
            {
                faults.push(`${name}: ${fn} ${fault}`);
            }
        }
    }
    return { leaves, faults, others };
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
    const compiled = await compiledLeaves();
    for (const fault of compiled.faults)
    {
        console.error(`${fault}: the build marks it a leaf (scripts/guest-code/compile.mjs)`);
        failed++;
    }
    if (failed > 0 || routines.length === 0 || compiled.leaves === 0)
    {
        console.error(`check-routine-leaves: ${failed} faults in ${routines.length} routines and `
            + `${compiled.leaves} compiled leaves`);
        process.exit(1);
    }
    const others = [...compiled.others.values()].reduce((sum, names)=>sum + names.length, 0);
    console.log(`check-routine-leaves: ${routines.length} x86-64 routines and ${compiled.leaves} `
        + `compiled functions, each a leaf; ${others} compiled functions in `
        + `${compiled.others.size} modules are no leaves and carry no unwind data`);
    if (process.argv.includes('--list'))
    {
        for (const [name, names] of compiled.others)
        {
            console.log(`  ${name} (${names.length}): ${names.join(', ')}`);
        }
    }
}
