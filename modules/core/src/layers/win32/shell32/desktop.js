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
 * Windows XP profile has, which is what a program asking them expects. The
 * about box is the shell's own and needs no Explorer: it is shown.
 */

import { createRefusals } from '../common/refusal.js';

const E_FAIL = 0x80004005 | 0;

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
 * @property {(library: string) => Record<string, { handler: (args: number[]) => any }>
 *     | undefined} [library]
 * @property {(address: number, maxLength: number) => string} [readCString]
 * @property {(address: number, maxLength: number) => string} [readWideString]
 * @property {(bytes: number) => number} [allocate]
 * @property {(address: number) => void} [free]
 */

/** The most characters ShellAbout reads of each string it is given. */
const ABOUT_TEXT_LIMIT = 1024;
const MB_OK = 0;

/**
 * What ShellAbout shows: its caption, and its text - "Microsoft" and the
 * application's line, the version, then the program's own words. `app` is the
 * title bar's text, unless a `#` divides it: then the part before is the title
 * bar's and the part after the line's (ShellAbout's szApp, MSDN).
 *
 * @param {string} app @param {string} other
 * @param {{ major: number, minor: number, build: number }} version
 * @returns {{ caption: string, text: string }}
 */
export function aboutBox(app, other, version){
    const split = app.indexOf('#');
    const caption = split < 0 ? `About ${app}` : app.slice(0, split);
    const line = split < 0 ? app : app.slice(split + 1);
    const lines = [`Microsoft ${line}`.trimEnd(),
        `Version ${version.major}.${version.minor} (Build ${version.build})`];
    if (other !== '')
    {
        lines.push('', other);
    }
    return { caption, text: lines.join('\r\n') };
}

/** APPBARDATA: cbSize, hWnd, uCallbackMessage, uEdge, rc, lParam. */
const APPBARDATA = Object.freeze({ hWnd: 4, uCallbackMessage: 8, uEdge: 12, rc: 16 });
const ABM_NEW = 0;
const ABM_REMOVE = 1;
const ABM_QUERYPOS = 2;
const ABM_SETPOS = 3;
const ABM_ACTIVATE = 6;
const ABM_WINDOWPOSCHANGED = 9;
const ABE_LEFT = 0;
const ABE_TOP = 1;
const ABE_RIGHT = 2;
const ABE_BOTTOM = 3;
const ABN_POSCHANGED = 1;

/**
 * @typedef {Object} AppBar
 * @property {number} window
 * @property {number} message  What it is told its position changed with.
 * @property {number} edge
 * @property {[number, number, number, number] | null} space  left, top, right, bottom
 */

/** @param {number} value */
const dword = value=>Uint8Array.of(value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff,
    value >>> 24 & 0xff);

/**
 * @param {DesktopHost} host
 */
export function createDesktopFunctions(host){
    const refuse = createRefusals(host);

    /**
     * The about box: a modal box of user32's (MessageBox), owned by `owner`,
     * TRUE once it is closed. Its icon is the box's own, not `hIcon`, which
     * is said.
     *
     * @param {(address: number) => string} read  a string of the call's width
     */
    const about = read=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([owner, app, other, icon])=>{
            const user32 = host.library?.('USER32.dll');
            const kernel32 = host.library?.('KERNEL32.dll');
            if (!user32?.MessageBoxW || !host.allocate || !host.free)
            {
                host.divergence?.('ShellAbout', 'no box can be shown here: answered as closed');
                return 1;
            }
            if ((icon >>> 0) !== 0)
            {
                host.divergence?.('ShellAbout', 'the icon given is not shown');
            }
            const packed = (kernel32?.GetVersion?.handler([]) ?? 0) >>> 0;
            const { caption, text } = aboutBox(
                (app >>> 0) === 0 ? '' : read(app >>> 0),
                (other >>> 0) === 0 ? '' : read(other >>> 0),
                { major: packed & 0xff, minor: packed >>> 8 & 0xff, build: packed >>> 16 });
            const allocate = /** @type {(bytes: number) => number} */ (host.allocate);
            const free = /** @type {(address: number) => void} */ (host.free);
            /** @param {string} value */
            const wide = value=>{
                const at = allocate(value.length * 2 + 2);
                const bytes = new Uint8Array(value.length * 2 + 2);
                for (let index = 0; index < value.length; index++)
                {
                    bytes[index * 2] = value.charCodeAt(index) & 0xff;
                    bytes[index * 2 + 1] = value.charCodeAt(index) >>> 8;
                }
                host.writeMemory(at, bytes);
                return at;
            };
            const textAt = wide(text);
            const captionAt = wide(caption);
            const release = ()=>{
                free(textAt);
                free(captionAt);
                return 1;
            };
            const shown = user32.MessageBoxW.handler([owner, textAt, captionAt, MB_OK]);
            return shown instanceof Promise ? shown.then(release, error=>{
                release();
                throw error;
            }) : release();
        },
    });

    /** @type {AppBar[]} The bars, in the order they were registered. */
    const bars = [];

    /** @param {number} at */
    const readInt = at=>{
        const bytes = host.readMemory?.(at >>> 0, 4) ?? new Uint8Array(4);
        return bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24;
    };

    /**
     * A bar's rectangle where the bars registered before it leave room: each
     * keeps the strip along its own edge, whatever this one's edge is.
     *
     * @param {AppBar} bar @param {[number, number, number, number]} rect
     * @returns {[number, number, number, number]}
     */
    const clipped = (bar, rect)=>{
        let [left, top, right, bottom] = rect;
        for (const other of bars.slice(0, bars.indexOf(bar)))
        {
            const space = other.space;
            if (space === null)
            {
                continue;
            }
            switch (other.edge)
            {
                case ABE_LEFT: left = Math.max(left, space[2]); break;
                case ABE_TOP: top = Math.max(top, space[3]); break;
                case ABE_RIGHT: right = Math.min(right, space[0]); break;
                case ABE_BOTTOM: bottom = Math.min(bottom, space[1]); break;
                default: break;
            }
        }
        return [left, top, right, bottom];
    };

    /**
     * The bars after one whose space changed are told to ask for theirs
     * again, through the message each registered with.
     *
     * @param {number} from  The first bar to tell.
     */
    const tellFrom = from=>{
        const post = host.library?.('USER32.dll')?.PostMessageA;
        for (const bar of bars.slice(from))
        {
            post?.handler([bar.window, bar.message, ABN_POSCHANGED, 0]);
        }
    };

    /**
     * SHAppBarMessage: the bars the shell keeps on the screen's edges, each
     * given the strip it asks for less the strips of the bars registered
     * before it (Wine's test_setpos, against Windows). There is no taskbar:
     * ABM_GETTASKBARPOS, ABM_GETSTATE and ABM_GETAUTOHIDEBAR answer none, and
     * no bar can hide itself.
     *
     * @param {number} message @param {number} data
     * @returns {number}
     */
    const appBarMessage = (message, data)=>{
        if (data === 0 || !host.readMemory)
        {
            return 0;
        }
        const window = readInt(data + APPBARDATA.hWnd) >>> 0;
        const index = bars.findIndex(bar=>bar.window === window);
        const bar = bars[index];
        /** @returns {[number, number, number, number]} */
        const rect = ()=>/** @type {[number, number, number, number]} */ (
            [0, 4, 8, 12].map(at=>readInt(data + APPBARDATA.rc + at)));
        /** @param {[number, number, number, number]} values */
        const writeRect = values=>values.forEach((value, at)=>
            host.writeMemory(data + APPBARDATA.rc + at * 4, dword(value)));
        switch (message)
        {
            case ABM_NEW:
                if (bar || window === 0)
                {
                    return 0;
                }
                bars.push({ window, message: readInt(data + APPBARDATA.uCallbackMessage) >>> 0,
                    edge: ABE_BOTTOM, space: null });
                return 1;
            case ABM_REMOVE:
                if (!bar)
                {
                    return 0;
                }
                bars.splice(index, 1);
                tellFrom(index);
                return 1;
            case ABM_QUERYPOS:
            case ABM_SETPOS:
            {
                if (!bar)
                {
                    return 0;
                }
                const edge = readInt(data + APPBARDATA.uEdge) >>> 0;
                const space = clipped(bar, rect());
                writeRect(space);
                if (message === ABM_SETPOS)
                {
                    bar.edge = edge;
                    bar.space = space;
                    tellFrom(index + 1);
                }
                return 1;
            }
            case ABM_ACTIVATE:
            case ABM_WINDOWPOSCHANGED:
                return bar ? 1 : 0;
            default:
                return 0;
        }
    };

    return {
        /**
         * UINT_PTR SHAppBarMessage(DWORD dwMessage, PAPPBARDATA pData)
         */
        SHAppBarMessage: {
            returns: 'pointer',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([message, data])=>appBarMessage(message >>> 0, data >>> 0),
        },

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
         * A modal box that returns TRUE once it is closed (`aboutBox`).
         */
        ShellAboutA: about(address=>host.readCString?.(address, ABOUT_TEXT_LIMIT) ?? ''),
        ShellAboutW: about(address=>host.readWideString?.(address, ABOUT_TEXT_LIMIT * 2) ?? ''),

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
