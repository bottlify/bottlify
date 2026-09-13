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
    };
}
