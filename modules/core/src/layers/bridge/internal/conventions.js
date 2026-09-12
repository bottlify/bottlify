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
    /**
     * MSVC's for C++ methods: `this` in ECX, the rest on the stack, callee
     * pops the rest.
     *
     * **Not what a COM interface method uses.** Those are STDMETHODCALLTYPE,
     * which is `__stdcall`, and the interface pointer is the first argument on
     * the stack -- which is what makes the C bindings binary-compatible with
     * the C++ call. Reading the name and reaching for this one put every COM
     * call in the engine four bytes out for a long time, and nothing could see
     * it because our own tests drove the vtables through a harness that agreed
     * with the mistake. A real compiled program pushes the interface pointer
     * even when it already holds it in ECX.
     *
     * Nothing in the tree uses this today. It stays because a C++ runtime --
     * one of the `msvcp` libraries -- exports real member functions that do.
     */
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
