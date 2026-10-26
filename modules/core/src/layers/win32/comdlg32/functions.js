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
 *
 * The colour and font pickers are cancelled the same way. The print dialogs
 * answer what Windows answers on a machine with no printer installed: there
 * is no default printer (PDERR_NODEFAULTPRN), whether the program asked for
 * the dialog or only for the default's settings. Every one of them checks its
 * structure first, as Windows does, so a program handed CDERR_STRUCTSIZE
 * finds its own mistake rather than a cancel.
 *
 * Find and Replace are modeless: they answer a dialog window at once and talk
 * to their owner through FINDMSGSTRING for as long as the window is up. No
 * such window is made here, and both answer the failure they document for a
 * dialog that could not be created -- after the checks of their structure, so
 * a program's own mistake is still reported as its own.
 */

import { encodeAnsi } from '../kernel32/locale.js';
import { createRefusals } from '../common/refusal.js';
import { charactersOf, readToTerminator } from '../common/scan-windows.js';

/**
 * How far a name a program hands these is read: whole, as Windows reads it, up to
 * the 32 767 characters a path may have. A name cut shorter names another file.
 */
const WHOLE_NAME = 32767;

/**
 * @typedef {Object} CommonDialogHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, maxLength: number) => string} [readCString]
 * @property {(address: number, bytes: Uint8Array) => void} [writeMemory]
 * @property {(hwnd: number) => boolean} [isWindow]
 *           Whether a handle names a window, which a dialog's owner has to.
 *           Absent, any non-zero owner is taken.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/** As long as a path a program hands GetFileTitle may be. */
const MAX_PATH = 0x1000;

/** OPENFILENAME's first field, and the only one that has to be right here. */
const OFN_STRUCT_SIZE = 0;

/** @param {Uint8Array} bytes @param {number} at */
const u32 = (bytes, at)=>(bytes[at] | bytes[at + 1] << 8
    | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;

/**
 * The sizes OPENFILENAME has had, in either spelling: OPENFILENAMEW is
 * OPENFILENAMEA field for field, its strings pointers to wide ones. The
 * older size predates three trailing fields; a program built against either
 * passes its own and a dialog that refuses the one it does not recognise
 * refuses half its callers.
 */
const OPENFILENAME_SIZES = Object.freeze([76, 88]);

/** CDERR_STRUCTSIZE: the structure was not a size this understands. */
const CDERR_STRUCTSIZE = 0x0001;
/** CDERR_INITIALIZATION: no structure at all. */
const CDERR_INITIALIZATION = 0x0002;
/** CDERR_NOHINSTANCE: a template named in an instance that was not given. */
const CDERR_NOHINSTANCE = 0x0004;
/** CDERR_DIALOGFAILURE: the dialog window could not be made, or has no owner. */
const CDERR_DIALOGFAILURE = 0xffff;
/** PDERR_NODEFAULTPRN: there is no default printer, there being no printer. */
const PDERR_NODEFAULTPRN = 0x1008;
/** PDERR_RETDEFFAILURE: the default asked for with settings already handed in. */
const PDERR_RETDEFFAILURE = 0x1009;
/** FRERR_BUFFERLENGTHZERO: no buffer to hold what to find, or what to put instead. */
const FRERR_BUFFERLENGTHZERO = 0x4001;

/**
 * The sizes of the other dialogs' structures, the same in either spelling:
 * their strings are pointers. PRINTDLG is packed, hence 66.
 */
const CHOOSECOLOR_SIZE = 36;
const CHOOSEFONT_SIZE = 60;
const PRINTDLG_SIZE = 66;
const PRINTDLGEX_SIZE = 84;
const PAGESETUPDLG_SIZE = 84;
const FINDREPLACE_SIZE = 40;

/** Where PRINTDLG and PAGESETUPDLG keep their flags and the settings handed in. */
const PRINTDLG = Object.freeze({ hwndOwner: 4, hDevMode: 8, hDevNames: 12, Flags: 20 });
const PAGESETUPDLG = Object.freeze({ hwndOwner: 4, hDevMode: 8, hDevNames: 12, Flags: 16 });
const PRINTDLGEX = Object.freeze({ hwndOwner: 4, hDevMode: 8, hDevNames: 12, Flags: 20 });
/** PD_RETURNDEFAULT and PSD_RETURNDEFAULT: the default's settings, no dialog. */
const RETURNDEFAULT = 0x0400;

/** FINDREPLACE, and the flags that name a template in its instance. */
const FINDREPLACE = Object.freeze({ hwndOwner: 4, hInstance: 8, Flags: 12, lpstrFindWhat: 16,
    lpstrReplaceWith: 20, wFindWhatLen: 24 });
const FR_ENABLETEMPLATE = 0x0020;
const FR_ENABLETEMPLATEHANDLE = 0x2000;

/** PrintDlgEx's answers: an HRESULT, the extended error kept for E_FAIL. */
const E_INVALIDARG = 0x80070057;
const E_HANDLE = 0x80070006;
const E_FAIL = 0x80004005;

/**
 * The file's name out of a path, or null for a name that is not a file's --
 * empty, ending in a separator, or a pattern.
 *
 * @param {string} path
 */
const fileTitle = path=>{
    const cut = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'), path.lastIndexOf(':'));
    const name = path.slice(cut + 1);
    return name.length === 0 || /[*?]/.test(name) ? null : name;
};

/**
 * @param {CommonDialogHost} host
 */
export function createCommonDialogFunctions(host){
    /** What the last dialog went wrong with, or zero for "nothing was chosen". */
    let extendedError = 0;
    const refuse = createRefusals(host);

    /** @param {number} address @param {number} at */
    const field = (address, at)=>u32(host.readMemory((address + at) >>> 0, 4), 0);

    /**
     * The checks every dialog makes of its structure before anything else:
     * one is there, and it is the size this version has. Answers the
     * extended error they leave, zero when both pass.
     *
     * @param {number} address @param {number} size
     */
    const checked = (address, size)=>{
        if ((address >>> 0) === 0)
        {
            return CDERR_INITIALIZATION;
        }
        return field(address, 0) === size ? 0 : CDERR_STRUCTSIZE;
    };

    /**
     * A modal picker dismissed by nobody: cancelled, after its checks.
     *
     * @param {number} size
     */
    const picker = size=>({
        argBytes: 4,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [address])=>{
            extendedError = checked(address, size);
            return 0;
        },
    });

    /**
     * PrintDlg and PageSetupDlg on a machine with no printer: no default to
     * return or to set up. The default asked for by a caller that also
     * handed in settings is refused for that first, as Windows refuses it.
     *
     * @param {string} name @param {number} size
     * @param {{ hDevMode: number, hDevNames: number, Flags: number }} at
     */
    const noPrinter = (name, size, at)=>{
        const refused = refuse(name, { argBytes: 4, why: 'no printer is installed' });
        return {
            argBytes: 4,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [address])=>{
                extendedError = checked(address, size);
                if (extendedError !== 0)
                {
                    return 0;
                }
                extendedError = defaultFailure(address, at);
                return refused.handler();
            },
        };
    };

    /**
     * Why there is no default printer to answer with: settings handed in
     * beside a request for the default's own, or no printer at all.
     *
     * @param {number} address @param {{ hDevMode: number, hDevNames: number, Flags: number }} at
     */
    const defaultFailure = (address, at)=>((field(address, at.Flags) & RETURNDEFAULT) !== 0
        && (field(address, at.hDevMode) !== 0 || field(address, at.hDevNames) !== 0)
        ? PDERR_RETDEFFAILURE : PDERR_NODEFAULTPRN);

    /** @param {number} hwnd */
    const isOwner = hwnd=>(hwnd >>> 0) !== 0 && (host.isWindow?.(hwnd >>> 0) ?? true);

    /**
     * FindText and ReplaceText: the structure checked as Windows checks it,
     * then the window refused (the module comment says why).
     *
     * @param {string} name @param {boolean} replace
     */
    const findDialog = (name, replace)=>{
        const refused = refuse(name, {
            argBytes: 4,
            answer: ()=>{
                extendedError = CDERR_DIALOGFAILURE;
                return 0;
            },
            why: 'no modeless Find or Replace window is made',
        });
        return {
            argBytes: 4,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [address])=>{
                extendedError = checked(address, FINDREPLACE_SIZE);
                if (extendedError !== 0)
                {
                    return 0;
                }
                const flags = field(address, FINDREPLACE.Flags);
                const findLength = field(address, FINDREPLACE.wFindWhatLen) & 0xffff;
                if (!isOwner(field(address, FINDREPLACE.hwndOwner)))
                {
                    extendedError = CDERR_DIALOGFAILURE;
                }
                else if (findLength < 1 || field(address, FINDREPLACE.lpstrFindWhat) === 0
                    || (replace && field(address, FINDREPLACE.lpstrReplaceWith) === 0))
                {
                    extendedError = FRERR_BUFFERLENGTHZERO;
                }
                else if ((flags & (FR_ENABLETEMPLATE | FR_ENABLETEMPLATEHANDLE)) !== 0
                    && field(address, FINDREPLACE.hInstance) === 0)
                {
                    extendedError = CDERR_NOHINSTANCE;
                }
                return extendedError !== 0 ? 0 : refused.handler();
            },
        };
    };

    /**
     * PrintDlgEx, whose answer is an HRESULT: a bad argument or owner is
     * said so at once; no printer is E_FAIL with the extended error.
     *
     * @param {string} name
     */
    const printDlgEx = name=>{
        const refused = refuse(name,
            { argBytes: 4, answer: E_FAIL, why: 'no printer is installed' });
        return {
            argBytes: 4,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [address])=>{
                if ((address >>> 0) === 0 || field(address, 0) !== PRINTDLGEX_SIZE)
                {
                    return E_INVALIDARG;
                }
                if (!isOwner(field(address, PRINTDLGEX.hwndOwner)))
                {
                    return E_HANDLE;
                }
                extendedError = defaultFailure(address, PRINTDLGEX);
                return refused.handler();
            },
        };
    };

    /**
     * GetFileTitle in either spelling: zero on success, the room needed
     * (terminator included) when the buffer is too small, and negative for
     * a name that is not a file's.
     *
     * @param {string | null} path @param {number} title @param {number} size
     * @param {boolean} wide
     */
    const getFileTitle = (path, title, size, wide)=>{
        const name = path === null ? null : fileTitle(path);
        if (name === null)
        {
            return -1;
        }
        const room = size & 0xffff;
        if ((title >>> 0) === 0 || room < name.length + 1)
        {
            return name.length + 1;
        }
        host.writeMemory?.(title >>> 0, wide
            ? new Uint8Array(Uint16Array.from(`${name}\0`, c=>c.charCodeAt(0)).buffer)
            : encodeAnsi(`${name}\0`));
        return 0;
    };

    /**
     * A UTF-16 path up to its terminator, read a window at a time so one at
     * the end of what the program allocated is not read past.
     *
     * @param {number} address
     */
    const readWidePath = address=>charactersOf(
        readToTerminator(host, address, 2, MAX_PATH).bytes, 2);

    /** @param {number} address */
    const cancelled = address=>{
        const size = u32(host.readMemory(address >>> 0, 4), OFN_STRUCT_SIZE);
        extendedError = OPENFILENAME_SIZES.includes(size) ? 0 : CDERR_STRUCTSIZE;
        return 0;
    };

    /**
     * A file dialog in either direction and either spelling: nothing in the
     * record is read past its size, and nothing is written into it.
     */
    const fileDialog = {
        argBytes: 4,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [openFileName])=>cancelled(openFileName),
    };

    return {
        /**
         * short GetFileTitleA(LPCSTR lpszFile, LPSTR lpszTitle, WORD cbBuf)
         *
         * The file's name out of its path. Zero on success, the room needed
         * (terminator included) when the buffer is too small, and negative
         * for a name that is not a file's -- empty, or ending in a separator.
         */
        GetFileTitleA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([file, title, size])=>getFileTitle(
                !host.readCString || (file >>> 0) === 0 ? null
                    : host.readCString(file >>> 0, WHOLE_NAME), title, size, false),
        },

        /** short GetFileTitleW(LPCWSTR lpszFile, LPWSTR lpszTitle, WORD cchSize): the same, wide. */
        GetFileTitleW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([file, title, size])=>getFileTitle(
                (file >>> 0) === 0 ? null : readWidePath(file), title, size, true),
        },

        /**
         * BOOL ChooseColorA(LPCHOOSECOLORA), ChooseColorW(LPCHOOSECOLORW)
         * BOOL ChooseFontA(LPCHOOSEFONTA), ChooseFontW(LPCHOOSEFONTW)
         *
         * Cancelled: FALSE, an extended error of zero, the colour and the
         * font the program had left as they were.
         */
        ChooseColorA: picker(CHOOSECOLOR_SIZE),
        ChooseColorW: picker(CHOOSECOLOR_SIZE),
        ChooseFontA: picker(CHOOSEFONT_SIZE),
        ChooseFontW: picker(CHOOSEFONT_SIZE),

        /**
         * BOOL PrintDlgA(LPPRINTDLGA), PrintDlgW(LPPRINTDLGW)
         * BOOL PageSetupDlgA(LPPAGESETUPDLGA), PageSetupDlgW(LPPAGESETUPDLGW)
         */
        PrintDlgA: noPrinter('PrintDlgA', PRINTDLG_SIZE, PRINTDLG),
        PrintDlgW: noPrinter('PrintDlgW', PRINTDLG_SIZE, PRINTDLG),
        PageSetupDlgA: noPrinter('PageSetupDlgA', PAGESETUPDLG_SIZE, PAGESETUPDLG),
        PageSetupDlgW: noPrinter('PageSetupDlgW', PAGESETUPDLG_SIZE, PAGESETUPDLG),

        /** HRESULT PrintDlgExA(LPPRINTDLGEXA), PrintDlgExW(LPPRINTDLGEXW) */
        PrintDlgExA: printDlgEx('PrintDlgExA'),
        PrintDlgExW: printDlgEx('PrintDlgExW'),

        /**
         * HWND FindTextA(LPFINDREPLACEA), FindTextW(LPFINDREPLACEW)
         * HWND ReplaceTextA(LPFINDREPLACEA), ReplaceTextW(LPFINDREPLACEW)
         */
        FindTextA: findDialog('FindTextA', false),
        FindTextW: findDialog('FindTextW', false),
        ReplaceTextA: findDialog('ReplaceTextA', true),
        ReplaceTextW: findDialog('ReplaceTextW', true),

        /**
         * BOOL GetOpenFileNameA(LPOPENFILENAMEA), GetOpenFileNameW(LPOPENFILENAMEW)
         * BOOL GetSaveFileNameA(LPOPENFILENAMEA), GetSaveFileNameW(LPOPENFILENAMEW)
         */
        GetOpenFileNameA: fileDialog,
        GetOpenFileNameW: fileDialog,
        GetSaveFileNameA: fileDialog,
        GetSaveFileNameW: fileDialog,

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
