/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * CRTDLL.DLL, the C runtime Windows NT 3.x and 95 shipped before msvcrt.dll:
 * the same functions, so the same entries rather than a second copy of each,
 * and a few names of its own. Its data exports carry a `_dll` suffix
 * (`_acmdln_dll`, `_fmode_dll`, `_commode_dll`), and its start-up call
 * `__GetMainArgs` is msvcrt's `__getmainargs` without the fifth argument, the
 * start-up information a later runtime added.
 *
 * @param {Record<string, any>} crt  msvcrt.dll's table.
 * @returns {Record<string, any>}
 */
export function createCrtdllFunctions(crt){
    return {
        ...crt,

        /** char *_acmdln_dll: msvcrt's `_acmdln` under its older name. */
        _acmdln_dll: crt._acmdln,

        /** int _fmode_dll, int _commode_dll: text mode and no commit, as a fresh runtime has. */
        _fmode_dll: { data: ()=>new Uint8Array(4) },
        _commode_dll: { data: ()=>new Uint8Array(4) },

        /** void __GetMainArgs(int *argc, char ***argv, char ***envp, int expand) */
        __GetMainArgs: {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([argc, argv, env, expand])=>
                crt.__getmainargs.handler([argc, argv, env, expand, 0]),
        },
    };
}
