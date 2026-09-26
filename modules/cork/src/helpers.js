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

import { decode } from './decode/decoder.js';

/**
 * @typedef {Object} RuntimeHelper
 * @property {string} name
 * @property {number} length   the helper's bytes, from its entry to its `ret`
 * @property {string} hash     their fingerprint (`fingerprint`)
 * @property {readonly number[]} body   what a call to it is formed as, `esp`-relative
 */

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

/** Every helper a call is looked up against. @type {readonly RuntimeHelper[]} */
export const RUNTIME_HELPERS = Object.freeze([FTOL2]);

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
 * The helper whose bytes lie at `target`, or null.
 *
 * @param {(address: number) => number} read
 * @param {number} target
 * @param {readonly RuntimeHelper[]} [helpers]
 * @returns {RuntimeHelper | null}
 */
export function helperAt(read, target, helpers = RUNTIME_HELPERS){
    for (const helper of helpers)
    {
        if (fingerprint(read, target, helper.length) === helper.hash)
        {
            return helper;
        }
    }
    return null;
}

/**
 * The instructions a call to `helper` at `call` is formed as. Each carries the
 * call's own address, so an exit before any of them re-runs the call on the
 * host; the last carries the call's length, so what follows is the call's
 * return address; and each names the helper, whose bytes the region's hash
 * and pages take.
 *
 * @param {RuntimeHelper} helper
 * @param {import('./decode/decoder.js').Instruction} call
 * @param {number} target
 * @returns {import('./decode/decoder.js').Instruction[]}
 */
export function helperInstructions(helper, call, target){
    /** @type {import('./decode/decoder.js').Instruction[]} */
    const out = [];
    for (let at = 0; at < helper.body.length;)
    {
        const offset = at;
        const decoded = decode(address=>helper.body[address - call.eip + offset] ?? 0, call.eip);
        if ('refused' in decoded)
        {
            throw new Error(`cork: ${helper.name}'s body does not decode at byte ${offset}`);
        }
        at += decoded.length;
        out.push({ ...decoded, length: at === helper.body.length ? call.length : 0,
            helper: { name: helper.name, address: target, length: helper.length } });
    }
    return out;
}
