/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * The kernel32 surface a console program needs to say something and exit.
 *
 * Each function is described by the contract the guest compiled against — its
 * stack footprint and return convention — rather than by what our one fixture
 * happens to call, because the guest pops those bytes itself on return and a
 * wrong count corrupts the stack silently.
 */

/** Values GetStdHandle is asked for. */
const STD_INPUT_HANDLE = -10;
const STD_OUTPUT_HANDLE = -11;
const STD_ERROR_HANDLE = -12;

/** Handles we hand out. Opaque to the guest; only ever compared, never dereferenced. */
export const HANDLE_STDIN = 1;
export const HANDLE_STDOUT = 2;
export const HANDLE_STDERR = 3;

/**
 * @typedef {Object} ConsoleHost
 * @property {(handle: number, text: string) => void} write   Where guest output goes.
 * @property {(code: number) => void} exit                    Ends the process.
 * @property {() => any} park                 Stops the caller; returns the parked token.
 */

/**
 * Builds the function table: name → { argBytes, handler }.
 *
 * `argBytes` is the size of the argument list the guest compiled against. Both
 * are stdcall, which is the bridge's default, so neither says so.
 *
 * Writing is not here. A standard handle and a file are written through the same
 * entry point, so it belongs with the one that knows about files -- two
 * WriteFiles would mean whichever was spread last silently won.
 *
 * @param {ConsoleHost} host
 */
export function createConsoleFunctions(host){
    /**
     * Where a standard handle has been pointed, when a program has moved one.
     *
     * A C runtime redirects its own streams during startup -- freopen on stdout
     * is the ordinary case -- and then expects GetStdHandle to report what it
     * set. Keeping the two in one place is what makes that true; a SetStdHandle
     * that recorded nothing would leave every later write going to the original
     * destination while the program believed otherwise.
     *
     * @type {Map<number, number>}
     */
    const redirected = new Map();

    /** @param {number} which @returns {number} the default for a standard handle */
    const standard = which=>{
        switch (which | 0){
            case STD_INPUT_HANDLE:
                return HANDLE_STDIN;
            case STD_OUTPUT_HANDLE:
                return HANDLE_STDOUT;
            case STD_ERROR_HANDLE:
                return HANDLE_STDERR;
            default:
                return 0xffffffff; // INVALID_HANDLE_VALUE
        }
    };

    return {
        /** HANDLE GetStdHandle(DWORD nStdHandle) */
        GetStdHandle: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([nStdHandle])=>
                redirected.get(nStdHandle | 0) ?? standard(nStdHandle),
        },

        /**
         * BOOL SetStdHandle(DWORD nStdHandle, HANDLE hHandle)
         *
         * Records the redirection and closes nothing. Windows does not close the
         * handle being replaced either -- the caller owns both and usually keeps
         * the old one to put back.
         */
        SetStdHandle: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([which, handle])=>{
                if (standard(which) === 0xffffffff)
                {
                    return 0;
                }
                redirected.set(which | 0, handle >>> 0);
                return 1;
            },
        },

        /** VOID ExitProcess(UINT uExitCode) — does not return */
        ExitProcess: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([code])=>{
                host.exit(code >>> 0);
                // It does not return, so there is no value to return: the stub's
                // own `ret` is redirected to the park loop instead.
                return host.park();
            },
        },
    };
}
