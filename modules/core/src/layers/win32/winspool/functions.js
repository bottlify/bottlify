/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * winspool — the print spooler, of which this machine has none.
 *
 * A program built on an application framework imports these whether or not it
 * ever prints, and the library has to be there for it to load at all. A
 * machine with no printer installed answers the same way a real one does:
 * there is no printer by that name, so nothing opens and nothing has
 * properties. Each is declared so it pops what it was pushed.
 */

/** ERROR_INVALID_PRINTER_NAME: what opening a printer that is not there says. */
const ERROR_INVALID_PRINTER_NAME = 1801;

/**
 * @typedef {Object} SpoolerHost
 * @property {(code: number) => void} [setLastError]
 * @property {(address: number, bytes: Uint8Array) => void} [writeMemory]
 */

/**
 * @param {SpoolerHost} host
 */
export function createSpoolerFunctions(host){
    return {
        /** BOOL OpenPrinterA(LPSTR pPrinterName, LPHANDLE phPrinter, LPPRINTER_DEFAULTSA) */
        OpenPrinterA: {
            argBytes: 12,
            handler: ()=>{
                host.setLastError?.(ERROR_INVALID_PRINTER_NAME);
                return 0;
            },
        },

        /** BOOL OpenPrinterW(LPWSTR, LPHANDLE, LPPRINTER_DEFAULTSW): OpenPrinterA */
        OpenPrinterW: {
            argBytes: 12,
            handler: ()=>{
                host.setLastError?.(ERROR_INVALID_PRINTER_NAME);
                return 0;
            },
        },

        /** BOOL ClosePrinter(HANDLE hPrinter) */
        ClosePrinter: {
            argBytes: 4,
            handler: ()=>0,
        },

        /**
         * LONG DocumentPropertiesA(HWND, HANDLE hPrinter, LPSTR pDeviceName,
         *                          PDEVMODEA out, PDEVMODEA in, DWORD fMode)
         *
         * Negative is the documented failure, since zero and above are sizes.
         */
        DocumentPropertiesA: {
            argBytes: 24,
            handler: ()=>-1,
        },
        DocumentPropertiesW: {
            argBytes: 24,
            handler: ()=>-1,
        },

        /**
         * BOOL EnumPortsA(LPSTR pName, DWORD Level, LPBYTE pPort, DWORD cbBuf,
         *                 LPDWORD pcbNeeded, LPDWORD pcReturned)
         *
         * Nothing to print to, so no port to list: none needed, none returned.
         */
        EnumPortsA: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([, , , , needed, returned])=>{
                for (const slot of [needed >>> 0, returned >>> 0].filter(at=>at !== 0))
                {
                    host.writeMemory?.(slot, new Uint8Array(4));
                }
                return 1;
            },
        },
    };
}
