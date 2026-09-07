/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * comdlg32 — the common dialogs, which need somebody to answer them.
 *
 * There is no person in front of a file dialog here, so both of these return
 * FALSE. That is not a failure: FALSE with an extended error of zero is exactly
 * how these report that the dialog was dismissed without choosing anything, and
 * every program that opens one handles being cancelled. Inventing a filename
 * would send it off to open a file nobody asked for.
 *
 * The distinction matters enough to keep the extended error separate: FALSE
 * with a non-zero code means the dialog itself went wrong, and a program may
 * report that to the user as a fault. Cancelled is not a fault.
 */

/**
 * @typedef {Object} CommonDialogHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 */

/** OPENFILENAME's first field, and the only one that has to be right here. */
const OFN_STRUCT_SIZE = 0;

/** @param {Uint8Array} bytes @param {number} at */
const u32 = (bytes, at)=>(bytes[at] | bytes[at + 1] << 8
    | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;

/**
 * The sizes OPENFILENAMEA has had. The older one predates three trailing
 * fields; a program built against either passes its own and a dialog that
 * refuses the one it does not recognise refuses half its callers.
 */
const OPENFILENAME_SIZES = Object.freeze([76, 88]);

/** CDERR_STRUCTSIZE: the structure was not a size this understands. */
const CDERR_STRUCTSIZE = 0x0001;

/**
 * @param {CommonDialogHost} host
 */
export function createCommonDialogFunctions(host){
    /** What the last dialog went wrong with, or zero for "nothing was chosen". */
    let extendedError = 0;

    /** @param {number} address */
    const cancelled = address=>{
        const size = u32(host.readMemory(address >>> 0, 4), OFN_STRUCT_SIZE);
        extendedError = OPENFILENAME_SIZES.includes(size) ? 0 : CDERR_STRUCTSIZE;
        return 0;
    };

    return {
        /** BOOL GetOpenFileNameA(LPOPENFILENAMEA) */
        GetOpenFileNameA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([openFileName])=>cancelled(openFileName),
        },

        /** BOOL GetSaveFileNameA(LPOPENFILENAMEA) */
        GetSaveFileNameA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([openFileName])=>cancelled(openFileName),
        },

        /**
         * DWORD CommDlgExtendedError(void)
         *
         * Zero after a cancelled dialog, which is what tells the caller apart
         * from a dialog that could not be shown at all.
         */
        CommDlgExtendedError: {
            argBytes: 0,
            handler: ()=>extendedError,
        },
    };
}
