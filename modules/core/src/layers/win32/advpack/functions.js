/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * advpack — the Advanced INF installer's helper library.
 *
 * An installer loads it at run time and asks it questions before it installs
 * anything, the first of them whether the account may write where it is about
 * to: a library that is missing is taken for an account without the right.
 */

/**
 * @typedef {Object} AdvpackHost
 * @property {() => boolean} isAdministrator
 *           Whether the account's token holds BUILTIN\Administrators: the
 *           answer the token calls give, so the two cannot disagree.
 */

/**
 * @param {AdvpackHost} host
 */
export function createAdvpackFunctions(host){
    return {
        /** BOOL IsNTAdmin(DWORD dwReserved, LPDWORD lpdwReserved) */
        IsNTAdmin: {
            argBytes: 8,
            handler: ()=>(host.isAdministrator() ? 1 : 0),
        },
    };
}
