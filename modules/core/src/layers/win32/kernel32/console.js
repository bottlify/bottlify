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
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(handle: number, text: string) => void} write   Where guest output goes.
 * @property {(code: number) => void} exit                    Ends the process.
 * @property {() => any} park                 Stops the caller; returns the parked token.
 */

/**
 * Builds the function table: name → { argBytes, handler }.
 *
 * `argBytes` is the size of the argument list the guest compiled against: one
 * argument is 4 bytes, five are 20. All three are stdcall, which is the bridge's
 * default, so none of them says so.
 *
 * @param {ConsoleHost} host
 */
export function createConsoleFunctions(host){
    return {
        /** HANDLE GetStdHandle(DWORD nStdHandle) */
        GetStdHandle: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([nStdHandle])=>{
                switch (nStdHandle | 0){
                    case STD_INPUT_HANDLE:
                        return HANDLE_STDIN;
                    case STD_OUTPUT_HANDLE:
                        return HANDLE_STDOUT;
                    case STD_ERROR_HANDLE:
                        return HANDLE_STDERR;
                    default:
                        return 0xffffffff; // INVALID_HANDLE_VALUE
                }
            },
        },

        /** BOOL WriteFile(HANDLE, LPCVOID, DWORD, LPDWORD, LPOVERLAPPED) */
        WriteFile: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([handle, buffer, length, written])=>{
                const bytes = host.readMemory(buffer, length);
                host.write(handle, new TextDecoder('latin1').decode(bytes));

                // lpNumberOfBytesWritten is optional, but when it is supplied the guest
                // reads it back: a program that checks it and sees zero concludes the
                // write failed.
                if (written !== 0)
                {
                    host.writeMemory(written, new Uint8Array([
                        length & 0xff, (length >>> 8) & 0xff,
                        (length >>> 16) & 0xff, (length >>> 24) & 0xff,
                    ]));
                }
                return 1; // TRUE
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
