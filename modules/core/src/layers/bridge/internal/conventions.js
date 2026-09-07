/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Calling conventions, as data.
 *
 * Two facts about a function are routinely confused because for stdcall they
 * happen to be the same number: how many bytes of arguments it has, and how many
 * of them it pops on return. They are different facts. A cdecl function has
 * arguments and pops nothing; a thiscall function has an argument that is never
 * on the stack at all. Keeping them one field works until the first cdecl import
 * with arguments, which then eats the caller's own stack cleanup.
 *
 * `argBytes` throughout this layer means the first fact -- the size of the
 * argument list the guest compiled against, counting every argument including
 * `this`. Where each argument comes from, and what the callee pops, follow from
 * the convention.
 */

/** @enum {string} */
export const Convention = {
    /** Win32's own: arguments on the stack, callee pops them. */
    STDCALL: 'stdcall',
    /** C's: arguments on the stack, caller pops them. Variadic functions must use it. */
    CDECL: 'cdecl',
    /** MSVC's for C++ methods: `this` in ECX, the rest on the stack, callee pops the rest. */
    THISCALL: 'thiscall',
};

/** @param {string} convention */
function assertKnown(convention){
    if (!Object.values(Convention).includes(convention))
    {
        throw new Error(`Unknown calling convention "${convention}"`);
    }
}

/**
 * @param {string} convention
 * @param {number} argBytes
 */
function assertArgBytes(convention, argBytes){
    if (!Number.isInteger(argBytes) || argBytes < 0 || argBytes % 4 !== 0)
    {
        throw new Error(`argBytes must be a non-negative multiple of 4, got ${argBytes}`);
    }
    if (convention === Convention.THISCALL && argBytes < 4)
    {
        throw new Error('a thiscall function has at least `this`, so argBytes is at least 4');
    }
}

/**
 * How many bytes the callee pops on return -- the operand of the stub's `ret`.
 *
 * @param {string} convention
 * @param {number} argBytes
 * @returns {number}
 */
export function calleeCleanup(convention, argBytes){
    assertKnown(convention);
    assertArgBytes(convention, argBytes);

    switch (convention){
        case Convention.CDECL:
            return 0;
        case Convention.THISCALL:
            // `this` arrived in ECX and was never pushed, so it is not popped.
            return argBytes - 4;
        default:
            return argBytes;
    }
}

/**
 * A guest call frame at the moment the stub traps.
 *
 * @typedef {Object} CallFrame
 * @property {number} esp   Points at the return address the CALL pushed.
 * @property {number} ecx   Where thiscall left `this`.
 * @property {(address: number) => number} read32
 */

/**
 * Reads a call's arguments in declaration order.
 *
 * The stub has pushed nothing of its own by the time it traps, so ESP still
 * points at the return address and the first stack argument sits just above it.
 *
 * @param {string} convention
 * @param {number} argBytes
 * @param {CallFrame} frame
 * @returns {number[]}
 */
export function readArguments(convention, argBytes, frame){
    assertKnown(convention);
    assertArgBytes(convention, argBytes);

    const args = [];
    if (convention === Convention.THISCALL)
    {
        args.push(frame.ecx | 0);
    }

    const stackBytes = convention === Convention.THISCALL ? argBytes - 4 : argBytes;
    for (let offset = 0; offset < stackBytes; offset += 4)
    {
        args.push(frame.read32(frame.esp + 4 + offset) | 0);
    }
    return args;
}
