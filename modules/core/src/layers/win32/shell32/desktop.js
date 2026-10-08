/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The shell calls that speak to Explorer: its taskbar, its about box, its
 * process, its list of recent documents and the folder-view settings it keeps.
 *
 * There is no Explorer here -- no taskbar window, no shell process, no Start
 * menu -- and each call answers as it does on a machine where Explorer is not
 * running, which is a state Windows itself documents and a program is written
 * to meet. The settings are the exception: they are the values a fresh
 * Windows XP profile has, which is what a program asking them expects.
 */

import { createRefusals } from '../common/refusal.js';

const E_FAIL = 0x80004005 | 0;
const E_INVALIDARG = 0x80070057 | 0;

/**
 * SHGetSettings' mask bits, each naming one bit of the SHELLFLAGSTATE it
 * fills, and that bit's value on a fresh Windows XP profile: hidden and
 * system files hidden, known extensions hidden, compressed files in colour,
 * a double click to open, tips shown, the rest off.
 *
 * @type {readonly [mask: number, bit: number, on: boolean][]}
 */
const SETTINGS = Object.freeze([
    [0x00000001, 0, false], // SSF_SHOWALLOBJECTS: fShowAllObjects
    [0x00000002, 1, false], // SSF_SHOWEXTENSIONS: fShowExtensions
    [0x00008000, 2, false], // SSF_NOCONFIRMRECYCLE: fNoConfirmRecycle
    [0x00000020, 3, false], // SSF_SHOWSYSFILES: fShowSysFiles
    [0x00000008, 4, true], // SSF_SHOWCOMPCOLOR: fShowCompColor
    [0x00000080, 5, true], // SSF_DOUBLECLICKINWEBVIEW: fDoubleClickInWebView
    [0x00000200, 6, false], // SSF_DESKTOPHTML: fDesktopHTML
    [0x00000400, 7, false], // SSF_WIN95CLASSIC: fWin95Classic
    [0x00000800, 8, false], // SSF_DONTPRETTYPATH: fDontPrettyPath
    [0x00000100, 9, false], // SSF_SHOWATTRIBCOL: fShowAttribCol
    [0x00001000, 10, false], // SSF_MAPNETDRVBUTTON: fMapNetDrvBtn
    [0x00002000, 11, true], // SSF_SHOWINFOTIP: fShowInfoTip
    [0x00004000, 12, false], // SSF_HIDEICONS: fHideIcons
]);

/**
 * @typedef {Object} DesktopHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(code: number) => void} [setLastError]
 */

/** @param {number} value */
const dword = value=>Uint8Array.of(value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff,
    value >>> 24 & 0xff);

/**
 * @param {DesktopHost} host
 */
export function createDesktopFunctions(host){
    const refuse = createRefusals(host);

    /** Explorer's about box, answered as a person who closed it at once. */
    const about = refuse('ShellAbout', { argBytes: 16, answer: 1,
        why: 'the about box is not shown: answered as dismissed' });
    const noExplorer = refuse('SHGetInstanceExplorer', { argBytes: 4, answer: E_FAIL,
        why: 'no Explorer process to hold a reference on' });

    return {
        /**
         * UINT_PTR SHAppBarMessage(DWORD dwMessage, PAPPBARDATA pData)
         *
         * Every message goes to the taskbar's window, and there is none: the
         * work area is the whole screen, as SystemParametersInfo reports it.
         * Without the tray to send to, the call answers FALSE whatever was
         * asked -- ABM_NEW registers no bar, ABM_GETTASKBARPOS has no taskbar
         * to place, ABM_GETSTATE reports neither auto-hide nor always-on-top,
         * ABM_GETAUTOHIDEBAR names no bar -- and the record is not written.
         */
        SHAppBarMessage: refuse('SHAppBarMessage', { argBytes: 8, answer: 0,
            why: 'no taskbar: every application-bar message answers FALSE' }),

        /**
         * void SHGetSettings(LPSHELLFLAGSTATE lpsfs, DWORD dwMask)
         *
         * The bits the mask names, each as a fresh profile has it; the bits it
         * does not name are left as the caller had them.
         */
        SHGetSettings: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([state, mask])=>{
                if ((state >>> 0) === 0 || !host.readMemory)
                {
                    return 0;
                }
                const held = host.readMemory(state >>> 0, 4);
                let bits = (held[0] | held[1] << 8 | held[2] << 16 | held[3] << 24) >>> 0;
                for (const [flag, bit, on] of SETTINGS)
                {
                    if (((mask >>> 0) & flag) !== 0)
                    {
                        bits = on ? (bits | 1 << bit) >>> 0 : (bits & ~(1 << bit)) >>> 0;
                    }
                }
                host.writeMemory(state >>> 0, dword(bits));
                return 0;
            },
        },

        /**
         * int ShellAboutA(HWND hWnd, LPCSTR szApp, LPCSTR szOtherStuff, HICON hIcon)
         * int ShellAboutW(HWND, LPCWSTR, LPCWSTR, HICON)
         *
         * A modal box that returns TRUE once it is closed; it is not drawn,
         * and is answered as closed straight away.
         */
        ShellAboutA: about,
        ShellAboutW: about,

        /**
         * HRESULT SHGetInstanceExplorer(IUnknown **ppunk)
         *
         * The reference a thread holds on Explorer's process to keep it alive.
         * Called from a process that is not Explorer it answers E_FAIL with a
         * null interface, which is every process here.
         */
        SHGetInstanceExplorer: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                host.writeMemory(out >>> 0, dword(0));
                return noExplorer.handler();
            },
        },

        /**
         * HRESULT SHLoadInProc(REFCLSID rclsid)
         *
         * Makes an object inside Explorer's process, to live as long as the
         * shell does. There is no shell process to make it in: E_FAIL, and
         * the object's server is not loaded into this one in its place, since
         * the object would then run where the program does not expect it.
         */
        SHLoadInProc: refuse('SHLoadInProc', { argBytes: 4, answer: E_FAIL,
            why: 'no shell process to load an object into' }),

        /**
         * void SHAddToRecentDocs(UINT uFlags, LPCVOID pv)
         *
         * A document noted in the Start menu's recent list. There is no Start
         * menu and nothing is kept; the call has no answer to give.
         */
        SHAddToRecentDocs: refuse('SHAddToRecentDocs', { argBytes: 8, answer: 0,
            why: 'no recent-documents list: nothing is kept' }),
    };
}
