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
/** DLL_PROCESS_DETACH: the library is being unloaded. */
export const DLL_PROCESS_DETACH = 0;

/**
 * What DllMain's third argument says here: the library was linked against, not
 * loaded by name at run time.
 *
 * Windows passes NULL for a library brought in by LoadLibrary and something
 * that is not NULL for one the loader brought in because the image imports it.
 * A library reads this to tell the two apart and can do genuinely different
 * things in each case -- initialising state one way when it is part of a
 * process from the start and another when it arrives later. Passing zero for
 * both makes every statically-linked library take the branch meant for the
 * other case, which is not a subtle difference: one real library rebuilds a
 * table it had already built correctly, with a different seed, and every
 * lookup through that table fails from then on.
 *
 * The value itself is only ever compared against NULL. One is what the loader
 * is observed to pass.
 */
const LOADED_STATICALLY = 1;

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
 * @param {{ address: number, enter: number, leave: number }} [options.loaderLock]
 *        The loader lock -- a CRITICAL_SECTION, and the guest addresses of
 *        EnterCriticalSection and LeaveCriticalSection -- held from the first
 *        call to the last. A thread a DllMain makes is told of the libraries
 *        under the same lock, so it waits until every one is attached rather
 *        than being told of one whose DLL_PROCESS_ATTACH has not run: "new
 *        threads can be created, but they do not begin execution until DLL
 *        initialization is done for the process".
 * @param {boolean} [options.long]  The process is an x86-64 one: the same
 *        calls in x86-64 code and the x64 convention (`longProcessInit`).
 * @returns {{ bytes: Uint8Array, attached: string[], tlsImages: number }}
 */
export function synthesiseProcessInit({ libraries, entryPoint, tlsApi, loaderLock, long = false }){
    if (long)
    {
        return longProcessInit({ libraries, entryPoint, tlsApi, loaderLock });
    }
    /** @type {number[]} */
    const code = [];
    /** @type {string[]} */
    const attached = [];
    let tlsImages = 0;
    /** @param {number} routine EnterCriticalSection or LeaveCriticalSection */
    const locked = routine=>(loaderLock
        ? [
            0x68, ...u32(loaderLock.address), // push lock
            0xb8, ...u32(routine), //            mov eax, routine
            0xff, 0xd0, //                       call eax
        ]
        : []);
    code.push(...locked(loaderLock?.enter ?? 0));

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
                    0x6a, LOADED_STATICALLY, //        push 1
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
            0x6a, LOADED_STATICALLY, //    push 1            (lpvReserved)
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
        ...locked(loaderLock?.leave ?? 0),
        0xb8, ...u32(entryPoint), // mov eax, entry
        0xff, 0xe0, //               jmp eax
    );

    return { bytes: new Uint8Array(code), attached, tlsImages };
}

/**
 * The same start-up as `synthesiseProcessInit`'s, for an x86-64 process: the
 * first four arguments in RCX, RDX, R8 and R9, 32 bytes of home space above
 * the return address for the callee to spill them into, and RSP a multiple of
 * 16 at every call. The thread enters here as a function is entered, eight
 * past a multiple of 16, so 40 bytes below that are both; the program's entry
 * point is jumped to with RSP as it came, as though the thread had started
 * there. Every address lies below 4 GiB, so a 32-bit move zero-extends it
 * whole.
 *
 * @param {Object} options
 * @param {{ base: number, entryPoint: number, name: string, tls?: TlsSetup }[]}
 *        options.libraries
 * @param {number} options.entryPoint
 * @param {{ alloc: number, set: number }} [options.tlsApi]
 * @param {{ address: number, enter: number, leave: number }} [options.loaderLock]
 * @returns {{ bytes: Uint8Array, attached: string[], tlsImages: number }}
 */
function longProcessInit({ libraries, entryPoint, tlsApi, loaderLock }){
    /** @type {number[]} */
    const code = [0x48, 0x83, 0xec, 0x28]; //  sub rsp, 40
    /** @type {string[]} */
    const attached = [];
    let tlsImages = 0;
    /** @param {number} routine */
    const call = routine=>[
        0xb8, ...u32(routine), //               mov eax, routine
        0xff, 0xd0, //                          call rax
    ];
    /** DllMain's three arguments, and the call. @param {number} base @param {number} routine */
    const attach = (base, routine)=>[
        0xb9, ...u32(base), //                  mov ecx, hinstDLL
        0xba, ...u32(DLL_PROCESS_ATTACH), //    mov edx, fdwReason
        0x41, 0xb8, ...u32(LOADED_STATICALLY), // mov r8d, lpvReserved
        ...call(routine),
    ];
    /** @param {number} routine */
    const locked = routine=>(loaderLock
        ? [0xb9, ...u32(loaderLock.address), ...call(routine)] // mov ecx, lock
        : []);
    code.push(...locked(loaderLock?.enter ?? 0));

    for (const library of libraries)
    {
        if (library.tls && tlsApi)
        {
            code.push(
                ...call(tlsApi.alloc), //                    eax = slot
                0xb9, ...u32(library.tls.indexAddress), //   mov ecx, index
                0x89, 0x01, //                               mov [rcx], eax
                0x89, 0xc1, //                               mov ecx, eax
                0xba, ...u32(library.tls.blockAddress), //   mov edx, block
                ...call(tlsApi.set),
            );
            for (const callback of library.tls.callbacks)
            {
                code.push(...attach(library.base, callback));
            }
            tlsImages++;
        }
        if (!library.entryPoint || library.entryPoint === library.base)
        {
            continue;
        }
        code.push(...attach(library.base, library.entryPoint));
        attached.push(library.name);
    }

    code.push(
        ...locked(loaderLock?.leave ?? 0),
        0x48, 0x83, 0xc4, 0x28, //              add rsp, 40
        0xb8, ...u32(entryPoint), //            mov eax, entry
        0xff, 0xe0, //                          jmp rax
    );
    return { bytes: new Uint8Array(code), attached, tlsImages };
}
