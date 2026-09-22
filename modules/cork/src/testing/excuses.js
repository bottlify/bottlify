/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The divergences that are the pinned emulator's own, named so both sequence
 * corpora -- `emit/sequences.itest.js` (the translator as the subject) and
 * `interp.itest.js` (the interpreter) -- judge only what the two subjects can
 * be held to. The classes are the ones `emit/sequences.itest.js` documents:
 * the sign of the indefinite a masked fault leaves, the environment's pointer
 * fields, `fnclex` and the condition codes, and the NaN an MMX write and an
 * x87 read leave differently.
 *
 * Test support only.
 */

import { DATA, SPANS } from './sequences.js';

const INDEFINITE = [0x7ff8000000000000n, 0xfff8000000000000n];
/** The condition codes of the status word: C0, C1, C2 and C3. */
const CONDITION = 0x100 | 0x200 | 0x400 | 0x4000;
/** The invalid-operation exception bit. */
const IE = 0x1;
/** @param {number} address */
const word = address=>`mem[0x${address.toString(16)}]`;
/** The environment's own fields. */
const ENVIRONMENT_STATUS = word(DATA + 0x24);
const ENVIRONMENT_TAG = word(DATA + 0x28);
const POINTERS = [0x2c, 0x30, 0x34].map(at=>word(DATA + at));
/** The two qwords the pool's float and MMX stores write. */
const STORE_LO = DATA;
const STORE_HI = DATA + 16;

const bitView = new DataView(new ArrayBuffer(8));
/** @param {number} value @returns {bigint} the value's bit pattern */
const bitsOf = value=>{
    bitView.setFloat64(0, value, true);
    return bitView.getBigUint64(0, true);
};
/** @param {bigint} bits */
const indefinite = bits=>INDEFINITE.includes(bits);

/**
 * Whether either snapshot has a register that is not a finite number -- a NaN
 * or an infinity, held or already popped (a pop leaves the mantissa and a
 * snapshot decodes all eight). A non-finite value is where the two engines'
 * representations part: the subjects keep it as a double, the emulator as the
 * 80-bit encoding an MMX write or a masked fault left, and the mantissas of a
 * NaN or an infinity differ between the two forms while a finite double's do
 * not. So every field that reads a register's *mantissa* rather than its value
 * -- a qword stored from it, an SSE lane converted from it -- and every flag an
 * arithmetic or compare sets from it, differs where one is present. The value
 * itself (`st<k>`) and the structure (the top, the empty mask, the control
 * word) are judged regardless.
 *
 * @param {import('./snapshot.js').MachineState} oracle
 * @param {import('./snapshot.js').MachineState} subject
 */
function nonFiniteBetween(oracle, subject){
    return oracle.x87.registers.some(value=>!Number.isFinite(value))
        || subject.x87.registers.some(value=>!Number.isFinite(value));
}

/**
 * The forms that set a condition code or the invalid exception by reading a
 * register's value, so a register the two engines left differently shows up in
 * the flags rather than in the register itself.
 */
const FLAG_READERS = new Set(['fmul st0, st1', 'fcomp', 'faddp']);

/**
 * Whether the sequence ran a form that reads a register into the flags and a
 * form that could have left that register a value the two engines hold
 * differently: an exchange or any MMX form.
 *
 * @param {Set<string>} forms
 */
function flagsFromTransient(forms){
    let reader = false;
    let source = false;
    for (const name of forms)
    {
        if (FLAG_READERS.has(name))
        {
            reader = true;
        }
        if (name.startsWith('fxch') || name.includes('mm'))
        {
            source = true;
        }
    }
    return reader && source;
}

/**
 * Whether the qword a store target's dword falls in is a NaN or an infinity on
 * the given side, read as the double the store wrote.
 *
 * @param {import('./snapshot.js').MachineState} state @param {number} address
 */
function storedNonFinite(state, address){
    const at = (address & ~7) - SPANS[0].address;
    const bytes = state.memory[0].bytes;
    const high = (bytes[at + 4] | bytes[at + 5] << 8 | bytes[at + 6] << 16
        | bytes[at + 7] << 24) >>> 0;
    return (high & 0x7ff00000) === 0x7ff00000;
}

/**
 * Whether a divergence is the emulator's own rather than the subject's.
 *
 * @param {import('./snapshot.js').Divergence} one
 * @param {import('./snapshot.js').MachineState} oracle
 * @param {import('./snapshot.js').MachineState} subject
 * @param {Set<string>} forms  the sequence's own: a condition code is only
 *     the emulator's own where a form that can leave one there ran
 */
export function theEmulatorsOwn(one, oracle, subject, forms){
    const { expected, actual } = one;
    if (POINTERS.includes(one.name))
    {
        return true;
    }
    if (one.name === ENVIRONMENT_TAG && typeof expected === 'number'
        && typeof actual === 'number')
    {
        // The reserved half is the same on both, so what differs is the tag
        // the two derived from registers they left differently.
        return expected >>> 16 === 0xffff && actual >>> 16 === 0xffff;
    }
    // eax after `fnstsw ax` holds the status word; arithmetic after the store
    // (the pool's `add eax, ebx`) moves it, so the difference is no longer a
    // clean copy of a status difference -- but it stays in the low sixteen bits
    // the store wrote. Where a non-finite value is in play the status itself
    // differs by the representation gap, and eax carries that difference; an
    // `fnclex` in the sequence does the same for a condition code it clears.
    if (one.name === 'eax' && forms.has('fnstsw ax') && typeof expected === 'number'
        && typeof actual === 'number')
    {
        return ((expected ^ actual) & ~0xffff) === 0
            && (forms.has('fnclex') || nonFiniteBetween(oracle, subject)
                || flagsFromTransient(forms));
    }
    // The status word, and the copy of it `fnstenv` writes.
    const copy = one.name === 'x87.status' ? 0 : one.name === ENVIRONMENT_STATUS ? 0 : -1;
    if (copy >= 0 && typeof expected === 'number' && typeof actual === 'number')
    {
        const differs = expected ^ actual;
        // Nothing outside the copy, and inside it nothing but a condition code
        // or the invalid exception -- the flags an x87 arithmetic or compare
        // sets from a non-finite register, which the two engines derive by
        // their own arithmetic; a condition code only where a form that can
        // leave one there ran.
        return (differs & ~(0xffff << copy)) === 0
            && (differs & ~((CONDITION | IE) << copy)) === 0
            && (forms.has('fnclex') || nonFiniteBetween(oracle, subject)
                || flagsFromTransient(forms));
    }
    // A stored qword that is a NaN or an infinity, or one stored from a
    // register that is: its payload, or the mantissa the store read, is the
    // engine's own. Only the pool's two store targets, so an environment field
    // is not swept up.
    const stored = /^mem\[0x([0-9a-f]+)\]$/.exec(one.name);
    if (stored !== null)
    {
        const address = Number.parseInt(stored[1], 16);
        if (address < STORE_LO || address >= STORE_HI)
        {
            return false;
        }
        return storedNonFinite(oracle, address) || storedNonFinite(subject, address)
            || nonFiniteBetween(oracle, subject);
    }
    // An SSE lane a conversion wrote from an mm register: where a non-finite
    // value is in play the lane carries the mantissa the two engines apart.
    if (/^xmm\d\[\d\]$/.test(one.name))
    {
        return nonFiniteBetween(oracle, subject);
    }
    if (typeof expected !== 'number' || typeof actual !== 'number')
    {
        return false;
    }
    const register = /^st(\d)$/.exec(one.name);
    if (register === null)
    {
        return false;
    }
    // Read out of the snapshots rather than out of the divergence: a NaN's
    // sign is not in its value.
    const at = Number(register[1]);
    return indefinite(bitsOf(oracle.x87.registers[at]))
        || indefinite(bitsOf(subject.x87.registers[at]));
}
