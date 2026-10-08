/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The answer a call gets when what it asks for is not on this machine: the
 * failure Windows itself gives in that case -- no printer, no network
 * connection, no IME, no debugger -- with the last error it sets, and a
 * divergence said once per call so a run's report names what was refused.
 *
 * One mechanism for every library, so a refused call looks the same
 * wherever it is: a documented failure, never a zero that reads as success
 * and never a missing export that ends the program.
 */

/**
 * @typedef {Object} Refusal
 * @property {number} argBytes  The stdcall argument bytes; 0 for cdecl.
 * @property {number | (() => number)} [answer]  What the call returns; 0 by default.
 * @property {number} [lastError]  The last error it leaves; untouched when absent.
 * @property {string} why  What is not here, for the divergence.
 */

/**
 * Builds refusing entry points for one library.
 *
 * @param {{ setLastError?: (code: number) => void,
 *     divergence?: (api: string, detail: string) => void }} host
 * @returns {(name: string, refusal: Refusal)
 *     => { argBytes: number, handler: () => number }}
 */
export function createRefusals(host){
    /** @type {Set<string>} */
    const said = new Set();
    return (name, { argBytes, answer = 0, lastError, why })=>({
        argBytes,
        handler: ()=>{
            if (!said.has(name))
            {
                said.add(name);
                host.divergence?.(name, why);
            }
            if (lastError !== undefined)
            {
                host.setLastError?.(lastError);
            }
            return typeof answer === 'function' ? answer() : answer;
        },
    });
}
