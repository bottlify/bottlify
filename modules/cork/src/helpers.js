/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Compiler runtime helpers a region runs as instructions of its own.
 *
 * A compiler links the same few helpers into every program it builds, byte
 * for byte, and some are called in a program's hottest loops. MSVC's `_ftol2`
 * -- the float-to-integer conversion every `(int)f` compiles to -- is twenty
 * x87 instructions through a 16-byte aligned frame, where the conversion it
 * computes is one instruction the translator already has. A direct call whose
 * target is such a helper, recognised by the fingerprint of its exact bytes
 * (never by an address, which differs from program to program), is formed as
 * that instruction instead of a call: the same result in the same registers,
 * for every program built with that compiler.
 *
 * `_ftol2` rounds ST0 by the control word, subtracts the rounded value, and
 * moves the result one toward zero by the sign of that difference stored as a
 * single; an integer of 0 or the integer indefinite goes back as it is. With
 * the registers held as doubles that is truncation toward zero -- a difference
 * the single cannot hold would need a double within 2^-149 of an integer
 * other than zero, and a double near a nonzero integer is at least 2^-53 away
 * -- with NaN and anything out of range giving the indefinite, which is
 * `fisttp`: so the call is `fisttp qword [esp-8]` and the two dwords into
 * edx:eax. The helper's own frame lies below esp too, where the call has just
 * written its return address, so the eight bytes written there are bytes the
 * program already gave up. What differs is EFLAGS (the helper's last
 * arithmetic leaves them; a compiled caller never reads them after a call).
 */

import { decode, MODE_64 } from './decode/decoder.js';
import { ARITH_FLAGS } from './decode/table.js';
import { CRT_DICTIONARY } from './crt-dictionary.js';

/**
 * @typedef {Object} RuntimeHelper
 * @property {string} name
 * @property {number} length   the helper's bytes, from its entry to its `ret`; with `spans`,
 *     from the first span's start to the last one's end
 * @property {string} hash     their fingerprint (`fingerprint`, or `maskedFingerprint` with
 *     `spans`)
 * @property {readonly number[]} [body]   what a call to it is formed as, `esp`-relative
 *     (after `does`, when both are given)
 * @property {Crt} [does]      the operation a call to it is formed as (`emit/crt.js`):
 *     done whole, or, where it cannot be done here, the call made as it was
 * @property {32 | 64} [bits]  the code it is: 32-bit unless said
 * @property {readonly (readonly number[])[]} [spans]  where its code lies, `[offset,
 *     length]` from its entry: the code reachable from it, without the tables between
 * @property {readonly number[]} [masks]  the offsets read as zeroes: what differs
 *     between copies linked at two places (`tools/crt-dictionary.mjs`)
 * @property {string} [quick]  the fingerprint of its first `QUICK_BYTES` bytes, masked
 * @property {number} [word]   the offset in it of an absolute address the operation reads
 *     a dword at when it runs (a global the runtime set), taken as linked (`crtWord`)
 * @property {boolean} [wordRip]  `word` is a RIP-relative displacement, its instruction
 *     ending four bytes past it
 * @property {boolean} [shape]  the operation is what these bytes do whatever their masked
 *     ones hold: a short stub too few of whose bytes are its own for a signature to tell it
 *     apart, formed as the test it makes of a global and of its argument, its other way
 *     (where the masked jump goes) made as the call was
 */

/**
 * What a C runtime function a call is formed as does (`emit/crt.js`):
 *   memmove  copies, the source and destination as they may overlap
 *   memcpy   copies a source and destination that do not overlap; where they
 *            do the call is made as it was, the function's own way with them
 *            being its own
 *   memset   fills with the byte of its second argument
 *   strlen   counts the bytes before the first zero
 *   sqrt     no operation of its own: the call is made as it was unless its
 *            argument is a number not below zero, the `body` after it the square
 *            root (a negative or a NaN sets errno, which only the function does)
 * Each answers as the function does: its result in eax (rax), the source,
 * destination or string the arguments say, the callee-saved registers as
 * they were.
 *
 * And the compiler's own helpers of 32-bit code (`emit/crt.js`): `allmul`, `alldiv`,
 * `aulldiv`, `allrem`, `aullrem`, `alldvrm`, `aulldvrm` (quadwords off the stack,
 * popped), `allshl`, `allshr`, `aullshr` (edx:eax by cl) and `chkstk` (esp down
 * by eax).
 *
 * And `floor` and `ceil`: as `sqrt`, the call made as it was unless the argument is
 * finite, the `body` after it the rounding.
 *
 * @typedef {'memmove' | 'memcpy' | 'memset' | 'strlen' | 'sqrt' | 'floor' | 'ceil'
 *     | 'allmul' | 'alldiv'
 *     | 'aulldiv' | 'allrem' | 'aullrem' | 'alldvrm' | 'aulldvrm' | 'allshl' | 'allshr'
 *     | 'aullshr' | 'chkstk' | 'chkstk64' | 'memcmp' | 'strcmp' | 'memchr' | 'strchr'
 *     | 'ftol2sse' | 'gscookie' | 'gscookie64'} Crt
 */

/**
 * What each operation leaves changed of the registers, as the forming's
 * register model (`emit/memory.js`) takes it: those it writes, and what it
 * moves esp by (`null`: by a count it reads).
 *
 * @type {Readonly<Record<Crt, { writes: readonly number[], esp: number | null }>>}
 */
export const CRT_EFFECTS = Object.freeze({
    memmove: { writes: [0], esp: 0 }, memcpy: { writes: [0], esp: 0 },
    memset: { writes: [0], esp: 0 }, strlen: { writes: [0], esp: 0 }, sqrt: { writes: [], esp: 0 },
    floor: { writes: [], esp: 0 }, ceil: { writes: [], esp: 0 },
    allmul: { writes: [0, 2], esp: 16 }, alldiv: { writes: [0, 2], esp: 16 },
    aulldiv: { writes: [0, 2], esp: 16 }, allrem: { writes: [0, 2], esp: 16 },
    aullrem: { writes: [0, 2], esp: 16 }, alldvrm: { writes: [0, 1, 2, 3], esp: 16 },
    aulldvrm: { writes: [0, 1, 2, 3], esp: 16 }, allshl: { writes: [0, 1, 2], esp: 0 },
    allshr: { writes: [0, 1, 2], esp: 0 }, aullshr: { writes: [0, 1, 2], esp: 0 },
    chkstk: { writes: [0], esp: null }, chkstk64: { writes: [], esp: 0 },
    memcmp: { writes: [0], esp: 0 }, strcmp: { writes: [0], esp: 0 },
    memchr: { writes: [0], esp: 0 }, strchr: { writes: [0], esp: 0 },
    ftol2sse: { writes: [], esp: 0 }, gscookie: { writes: [], esp: 0 },
    gscookie64: { writes: [1], esp: 0 },
});

/** @type {RuntimeHelper} MSVC 7.1 and 8's `_ftol2`. */
export const FTOL2 = Object.freeze({
    name: '_ftol2',
    length: 117,
    hash: '9e06322641c7a9f8',
    body: Object.freeze([
        0xdd, 0x4c, 0x24, 0xf8,             // fisttp qword [esp-8]
        0x8b, 0x44, 0x24, 0xf8,             // mov eax, [esp-8]
        0x8b, 0x54, 0x24, 0xfc,             // mov edx, [esp-4]
    ]),
});

/**
 * Every helper a call is looked up against: the compiler's own, and the C
 * runtime's functions of the dictionary (`crt-dictionary.js`).
 * @type {readonly RuntimeHelper[]}
 */
export const RUNTIME_HELPERS = Object.freeze([FTOL2, ...CRT_DICTIONARY]);

/**
 * The fingerprint of `length` bytes at `address`: the two FNV lanes a region's
 * hash takes, so a fingerprint collides no more often than a region does.
 *
 * @param {(address: number) => number} read
 * @param {number} address @param {number} length
 */
export function fingerprint(read, address, length){
    let low = 0x811c9dc5;
    let high = 0x050c5d1f;
    for (let at = 0; at < length; at++)
    {
        const byte = read(address + at);
        low = Math.imul(low ^ byte, 0x01000193);
        high = Math.imul(high ^ byte ^ at & 0xff, 0x01000193);
    }
    return (high >>> 0).toString(16).padStart(8, '0') + (low >>> 0).toString(16).padStart(8, '0');
}

/**
 * How many bytes of a function's first span its quick key covers: the look a
 * call's target is turned away by before its whole fingerprint is taken.
 */
export const QUICK_BYTES = 16;

/**
 * The fingerprint of a function's code by its spans -- `[offset, length]` from
 * `address`, in order -- with the bytes at `masks` (offsets, sorted) read as
 * zeroes: what differs between two copies of one function linked at two places
 * (`tools/crt-dictionary.mjs`). The same lanes as `fingerprint`, the position
 * a byte's offset in the spans taken together.
 *
 * @param {(address: number) => number} read
 * @param {number} address
 * @param {readonly (readonly number[])[]} spans
 * @param {readonly number[]} masks
 */
export function maskedFingerprint(read, address, spans, masks){
    let low = 0x811c9dc5;
    let high = 0x050c5d1f;
    let at = 0;
    let mask = 0;
    for (const [offset, length] of spans)
    {
        for (let k = 0; k < length; k++, at++)
        {
            const where = offset + k;
            while (mask < masks.length && masks[mask] < where)
            {
                mask++;
            }
            const byte = mask < masks.length && masks[mask] === where ? 0 : read(address + where);
            low = Math.imul(low ^ byte, 0x01000193);
            high = Math.imul(high ^ byte ^ at & 0xff, 0x01000193);
        }
    }
    return (high >>> 0).toString(16).padStart(8, '0') + (low >>> 0).toString(16).padStart(8, '0');
}

/**
 * Whether `helper`'s code lies at `target`.
 *
 * @param {(address: number) => number} read
 * @param {number} target @param {RuntimeHelper} helper
 */
function isAt(read, target, helper){
    const { spans, masks = [], quick } = helper;
    if (spans === undefined)
    {
        return fingerprint(read, target, helper.length) === helper.hash;
    }
    return (quick === undefined
        || maskedFingerprint(read, target, [[0, Math.min(QUICK_BYTES, spans[0][1])]], masks)
            === quick)
        && maskedFingerprint(read, target, spans, masks) === helper.hash;
}

/**
 * The helper whose bytes lie at `target`, or null.
 *
 * @param {(address: number) => number} read
 * @param {number} target
 * @param {readonly RuntimeHelper[]} [helpers]
 * @param {32 | 64} [bits]  the code's: only helpers of that width are looked for
 * @returns {RuntimeHelper | null}
 */
export function helperAt(read, target, helpers = RUNTIME_HELPERS, bits = 32){
    for (const helper of helpers)
    {
        if ((helper.bits ?? 32) === bits && isAt(read, target, helper))
        {
            return helper;
        }
    }
    return null;
}

/**
 * Where a helper's bytes lie from its entry: `[first, end)` as offsets.
 *
 * @param {RuntimeHelper} helper
 * @returns {[number, number]}
 */
export function helperExtent(helper){
    const { spans } = helper;
    if (spans === undefined)
    {
        return [0, helper.length];
    }
    return [Math.min(...spans.map(([offset])=>offset)),
        Math.max(...spans.map(([offset, length])=>offset + length))];
}

/**
 * The address a helper's `word` names, as linked: the dword there, or past the
 * end of its instruction by the displacement there (`wordRip`).
 *
 * @param {RuntimeHelper} helper @param {number} target
 * @param {(address: number) => number} read
 */
function wordOf(helper, target, read){
    const at = target + /** @type {number} */ (helper.word);
    const word = [0, 1, 2, 3].reduce((sum, k)=>sum + read(at + k) * 2 ** (8 * k), 0);
    return helper.wordRip === true ? at + 4 + (word | 0) : word;
}

/**
 * The instructions a call to `helper` at `call` is formed as. Each carries the
 * call's own address, so an exit before any of them re-runs the call on the
 * host; the last carries the call's length, so what follows is the call's
 * return address; and each names the helper, whose bytes the region's hash
 * and pages take. A helper's operation (`does`) is one instruction of its own,
 * `crt`, which reads and writes no flag the code after a call may read, and
 * leaves them all undefined as a call does.
 *
 * @param {RuntimeHelper} helper
 * @param {import('./decode/decoder.js').Instruction} call
 * @param {number} target
 * @param {(address: number) => number} [read]  the guest's bytes, for a helper's `word`
 * @returns {import('./decode/decoder.js').Instruction[]}
 */
export function helperInstructions(helper, call, target, read){
    const [first, end] = helperExtent(helper);
    const named = { name: helper.name, address: target + first, length: end - first };
    const body = helper.body ?? [];
    /** @type {import('./decode/decoder.js').Instruction[]} */
    const out = [];
    if (helper.does !== undefined)
    {
        out.push({
            eip: call.eip, length: body.length === 0 ? call.length : 0, op: 'crt',
            crt: helper.does, operands: [], size: call.size,
            flagsRead: 0, flagsWritten: 0, flagsUndefined: ARITH_FLAGS, faults: 'none',
            memory: false, prefixes: call.prefixes, opcode: call.opcode, helper: named,
            ...helper.word === undefined || read === undefined ? {}
                : { crtWord: wordOf(helper, target, read),
                    ...helper.wordRip === true ? { crtWordInBlock: true } : {} },
        });
    }
    const mode = (helper.bits ?? 32) === 64 ? MODE_64 : undefined;
    for (let at = 0; at < body.length;)
    {
        const offset = at;
        const decoded = decode(address=>body[address - call.eip + offset] ?? 0, call.eip, mode);
        if ('refused' in decoded)
        {
            throw new Error(`cork: ${helper.name}'s body does not decode at byte ${offset}`);
        }
        at += decoded.length;
        out.push({ ...decoded, length: at === body.length ? call.length : 0, helper: named });
    }
    return out;
}
