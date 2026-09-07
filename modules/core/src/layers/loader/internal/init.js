/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The code that runs before a program's first instruction.
 *
 * Every library a program brought with it has an entry point, and it has to be
 * called with DLL_PROCESS_ATTACH before anything calls into that library --
 * that is where it builds the state its exports assume. A sound engine that has
 * not been attached is a sound engine whose every function reads uninitialised
 * globals.
 *
 * This is guest code rather than host machinery, and deliberately so. Calling a
 * guest function from the host means parking a thread, marshalling a frame and
 * unwinding it, and none of that is needed here: the calls happen on the
 * process's first thread, in order, on a real stack, before anything else runs.
 * A real loader does the same thing on the same thread. So the thread is
 * started here instead of at the executable's entry point, and the last thing
 * this stub does is jump there.
 *
 * The order is the dependency order the caller worked out. A library
 * initialising against another library's state needs that other one attached
 * first, which is the same reason the images were mapped in that order.
 */

/** DLL_PROCESS_ATTACH. The other three reasons are per-thread and per-detach. */
export const DLL_PROCESS_ATTACH = 1;

/** @param {number} value */
const u32 = value=>[
    value & 0xff,
    value >>> 8 & 0xff,
    value >>> 16 & 0xff,
    value >>> 24 & 0xff,
];

/**
 * @typedef {Object} TlsSetup
 * @property {number} indexAddress  The dword to write the slot number into.
 * @property {number} blockAddress  This image's thread-local block, already filled.
 * @property {number[]} callbacks   Addresses to call, in order, before DllMain.
 */

/**
 * @param {Object} options
 * @param {{ base: number, entryPoint: number, name: string, tls?: TlsSetup }[]}
 *        options.libraries
 *        In dependency order. One with no entry point is skipped: a library
 *        without DllMain is ordinary, not an error.
 * @param {number} options.entryPoint  Where the program itself starts.
 * @param {{ alloc: number, set: number }} [options.tlsApi]
 *        Guest addresses of TlsAlloc and TlsSetValue. Required if any image
 *        carries thread-local storage; the slot has to come from the same pool
 *        the program's own calls draw on, and only the guest can ask for one.
 * @returns {{ bytes: Uint8Array, attached: string[], tlsImages: number }}
 */
export function synthesiseProcessInit({ libraries, entryPoint, tlsApi }){
    /** @type {number[]} */
    const code = [];
    /** @type {string[]} */
    const attached = [];
    let tlsImages = 0;

    for (const library of libraries)
    {
        // Thread-local storage first: a library's initialisers and its DllMain
        // both expect to be able to reach it, and a runtime whose slot was
        // never written reads slot zero -- a wrong answer rather than a
        // missing one, and one that surfaces far from here.
        if (library.tls && tlsApi)
        {
            code.push(
                0xb8, ...u32(tlsApi.alloc), // mov eax, TlsAlloc
                0xff, 0xd0, //                 call eax        -> eax = slot
                0xa3, ...u32(library.tls.indexAddress), // mov [index], eax
                0x68, ...u32(library.tls.blockAddress), // push block
                0x50, //                                   push eax  (the slot)
                0xb8, ...u32(tlsApi.set), // mov eax, TlsSetValue
                0xff, 0xd0, //               call eax
            );
            for (const callback of library.tls.callbacks)
            {
                // A TLS callback takes exactly DllMain's three arguments.
                code.push(
                    0x6a, 0x00, //                     push 0
                    0x6a, DLL_PROCESS_ATTACH, //       push 1
                    0x68, ...u32(library.base), //     push hinstDLL
                    0xb8, ...u32(callback), //         mov eax, callback
                    0xff, 0xd0, //                     call eax
                );
            }
            tlsImages++;
        }

        if (!library.entryPoint || library.entryPoint === library.base)
        {
            continue;
        }
        // BOOL WINAPI DllMain(HINSTANCE, DWORD, LPVOID) -- stdcall, so it pops
        // its own three arguments and nothing is cleaned up here.
        code.push(
            0x6a, 0x00, //                  push 0            (lpvReserved)
            0x6a, DLL_PROCESS_ATTACH, //    push 1            (fdwReason)
            0x68, ...u32(library.base), //  push hinstDLL
            // Through a register rather than a relative call: the stub is
            // placed after the libraries are, so a relative displacement would
            // have to be computed against an address this function is not told.
            0xb8, ...u32(library.entryPoint), // mov eax, DllMain
            0xff, 0xd0, //                       call eax
        );
        attached.push(library.name);
    }

    code.push(
        0xb8, ...u32(entryPoint), // mov eax, entry
        0xff, 0xe0, //               jmp eax
    );

    return { bytes: new Uint8Array(code), attached, tlsImages };
}
