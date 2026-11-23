/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The shell's helpers over menus, windows, counters and the machine: each is
 * a few of user32's, gdi32's, kernel32's or ole32's own calls, made with the
 * caller's handles, so what the program reads back through those libraries is
 * what these did.
 */

import { dword, u32 } from './text.js';
import { wholeAddress } from '../common/pointers.js';

const MF_BYPOSITION = 0x400;
const MF_ENABLED = 0x0;
const MF_GRAYED = 0x1;
const MF_CHECKED = 0x8;
const MF_UNCHECKED = 0x0;
const MIIM_SUBMENU = 0x4;
const MENUITEMINFO_SIZE = 48;
const GW_HWNDNEXT = 2;
const GW_CHILD = 5;
const ETO_OPAQUE = 0x2;
const BITSPIXEL = 12;
const PLANES = 14;
const HWND_BROADCAST = 0xffff;
const SMTO_ABORTIFHUNG = 0x2;
const WAIT_OBJECT_0 = 0;
const SEMAPHORE_MOST = 0x7fffffff;
const E_FAIL = 0x80004005 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const S_OK = 0;
/** WhichPlatform's answer for a shell integrated with the browser, every NT from 2000. */
const PLATFORM_INTEGRATED = 3;

/**
 * IsOS's questions a workstation says yes to, by the versions that do:
 * NT always, 2000 and later from 2000, a Professional (OS_PROFESSIONAL, and
 * OS_WIN2000PRO, which the documentation sends to it) from 2000. NT 4 and
 * later and XP and later are yes on XP and no from Vista on, where the
 * documentation has both always FALSE (decisions.md A262). The rest -
 * Windows 9x's, the servers', terminal and embedded editions, Home, a domain,
 * WOW64 - are no here.
 *
 * @type {ReadonlyMap<number, [number, number]>}  OS_* -> [from, before], each
 *     major * 0x100 + minor
 */
const OS_YES = new Map([[1, [0x400, Infinity]], [3, [0x400, 0x600]], [7, [0x500, Infinity]],
    [8, [0x500, Infinity]], [18, [0x501, 0x600]], [20, [0x500, Infinity]]]);

/**
 * @typedef {Object} UiHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} [readWideString]
 * @property {(bytes: number) => number} [allocate]
 * @property {(address: number) => void} [free]
 * @property {(library: string) => Record<string, { handler: (args: number[]) => any }> | undefined}
 *     [library]
 */

/**
 * @param {UiHost} host
 * @param {{ A: import('./text.js').Width, W: import('./text.js').Width }} widths
 */
export function createUiFunctions(host, { A, W }){
    /**
     * One of another library's calls, or null without it.
     *
     * @param {string} library @param {string} name @param {number[]} args
     * @returns {any}
     */
    const call = (library, name, args)=>{
        const entry = host.library?.(library)?.[name];
        return entry ? entry.handler(args) : null;
    };
    /** @param {string} name @param {number[]} args @returns {number} */
    const user32 = (name, args)=>/** @type {number} */ (call('USER32.dll', name, args) ?? 0);
    /** @param {string} name @param {number[]} args @returns {number} */
    const kernel32 = (name, args)=>/** @type {number} */ (call('KERNEL32.dll', name, args) ?? 0);

    /**
     * Scratch memory for one call's out parameters, freed after.
     *
     * @template T
     * @param {number} size @param {(at: number) => T} body @param {T} without
     * @returns {T}
     */
    const scratch = (size, body, without)=>{
        const at = host.allocate?.(size) ?? 0;
        if (!at || !host.readMemory)
        {
            return without;
        }
        try
        {
            return body(at);
        }
        finally
        {
            host.free?.(at);
        }
    };

    /** The position of the menu item with that command id, or -1. @param {number[]} args */
    const positionOf = ([menu, id])=>{
        const count = user32('GetMenuItemCount', [menu]) | 0;
        for (let at = 0; at < count; at++)
        {
            if ((user32('GetMenuItemID', [menu, at]) >>> 0) === (id >>> 0))
            {
                return at;
            }
        }
        return -1;
    };

    /**
     * The counter's value, by a semaphore's count: released by one to read
     * it, and taken back.
     *
     * @param {number} handle
     */
    const counterValue = handle=>scratch(4, at=>{
        host.writeMemory(at, dword(0));
        if (!kernel32('ReleaseSemaphore', [handle, 1, at]))
        {
            return 0;
        }
        kernel32('WaitForSingleObject', [handle, 0]);
        return u32(/** @type {(a: number, l: number) => Uint8Array} */ (host.readMemory)(at, 4));
    }, 0);

    /**
     * SHGlobalCounterCreateNamed for either width: a semaphore of that name
     * holding the initial count, made or opened.
     *
     * @param {import('./text.js').Width} width @param {string | null} name
     * @param {number} initial
     */
    const createCounter = (width, name, initial)=>scratch(((name?.length ?? 0) + 16) * 2, at=>{
        if (name !== null)
        {
            host.writeMemory(at, W.sz(`shell.${name}`));
        }
        return kernel32('CreateSemaphoreW', [0, initial >>> 0, SEMAPHORE_MOST,
            name === null ? 0 : at]);
    }, 0);

    /**
     * SHPropagateMessage's walk: every window beneath, children before their
     * own children, as EnumChildWindows walks them.
     *
     * @param {number} parent @param {(hwnd: number) => void} each
     */
    const eachDescendant = (parent, each)=>{
        for (let child = user32('GetWindow', [parent, GW_CHILD]); child !== 0;
            child = user32('GetWindow', [child, GW_HWNDNEXT]))
        {
            each(child);
            eachDescendant(child, each);
        }
    };

    return {
        /**
         * INT GetMenuPosFromID(HMENU hMenu, UINT wID)
         * UINT SHMenuIndexFromID(HMENU hMenu, UINT uID)
         *
         * The position of the item with that command id, or -1.
         */
        GetMenuPosFromID: { argBytes: 8, handler: positionOf },
        SHMenuIndexFromID: { argBytes: 8, handler: positionOf },

        /**
         * DWORD SHRemoveAllSubMenus(HMENU hMenu)
         *
         * Every item that opens a submenu deleted with its submenu; the count
         * the menu had is answered.
         */
        SHRemoveAllSubMenus: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([menu])=>{
                const count = user32('GetMenuItemCount', [menu]) | 0;
                for (let at = count - 1; at >= 0; at--)
                {
                    if (user32('GetSubMenu', [menu, at]) !== 0)
                    {
                        user32('DeleteMenu', [menu, at, MF_BYPOSITION]);
                    }
                }
                return count;
            },
        },

        /** UINT SHEnableMenuItem(HMENU hMenu, UINT wItemID, BOOL bEnable) */
        SHEnableMenuItem: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([menu, id, enable])=>user32('EnableMenuItem', [menu, id,
                (enable | 0) !== 0 ? MF_ENABLED : MF_GRAYED]),
        },

        /** DWORD SHCheckMenuItem(HMENU hMenu, UINT uID, BOOL bCheck) */
        SHCheckMenuItem: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([menu, id, check])=>user32('CheckMenuItem', [menu, id,
                (check | 0) !== 0 ? MF_CHECKED : MF_UNCHECKED]),
        },

        /**
         * HMENU SHGetMenuFromID(HMENU hMenu, UINT uID)
         *
         * The submenu the item with that command id opens, or NULL.
         */
        SHGetMenuFromID: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([menu, id])=>scratch(MENUITEMINFO_SIZE, at=>{
                host.writeMemory(at, new Uint8Array(MENUITEMINFO_SIZE));
                host.writeMemory(at, dword(MENUITEMINFO_SIZE));
                host.writeMemory(at + 4, dword(MIIM_SUBMENU));
                return user32('GetMenuItemInfoW', [menu, id, 0, at])
                    ? u32(/** @type {(a: number, l: number) => Uint8Array} */ (host.readMemory)(
                        at + 20, 4)) : 0;
            }, 0),
        },

        /**
         * BOOL SHLoadMenuPopup(HINSTANCE hInst, LPCWSTR szName)
         *
         * TRUE when the menu resource loads; its first popup is taken out of
         * it and the menu destroyed, as Windows does.
         */
        SHLoadMenuPopup: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([instance, name])=>{
                const menu = user32('LoadMenuW', [instance, name]);
                if (menu === 0)
                {
                    return 0;
                }
                if (user32('GetSubMenu', [menu, 0]) !== 0)
                {
                    user32('RemoveMenu', [menu, 0, MF_BYPOSITION]);
                }
                user32('DestroyMenu', [menu]);
                return 1;
            },
        },

        /**
         * BOOL SHIsChildOrSelf(HWND hParent, HWND hChild)
         *
         * FALSE when the child is the parent or beneath it, TRUE otherwise -
         * the sense Windows answers in.
         */
        SHIsChildOrSelf: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([parent, child])=>((parent >>> 0) !== 0 && ((parent >>> 0) === (child >>> 0)
                || user32('IsChild', [parent, child]) !== 0) ? 0 : 1),
        },

        /**
         * void SHPropagateMessage(HWND hWnd, UINT uiMsgId, WPARAM wParam, LPARAM lParam,
         *     BOOL bSend)
         *
         * The message sent, or posted, to every window beneath, in the
         * encoding each window's procedure reads.
         */
        SHPropagateMessage: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([window, message, wParam, lParam, send])=>{
                eachDescendant(window, child=>{
                    const wide = user32('IsWindowUnicode', [child]) !== 0;
                    const name = `${(send | 0) !== 0 ? 'SendMessage' : 'PostMessage'}${wide ? 'W'
                        : 'A'}`;
                    user32(name, [child, message, wParam, lParam]);
                });
                return 0;
            },
        },

        /**
         * LRESULT SHDefWindowProc(HWND hWnd, UINT uMessage, WPARAM wParam, LPARAM lParam)
         *
         * DefWindowProc in the encoding the window's procedure reads.
         */
        SHDefWindowProc: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: args=>user32(user32('IsWindowUnicode', [args[0]]) !== 0 ? 'DefWindowProcW'
                : 'DefWindowProcA', args),
        },

        /**
         * COLORREF SHFillRectClr(HDC hDC, LPCRECT pRect, COLORREF cRef)
         *
         * The rectangle filled with the colour as ExtTextOut's opaque
         * background, the context's own colour put back; that colour answered.
         */
        SHFillRectClr: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hdc, rect, colour])=>{
                const before = /** @type {number} */ (call('GDI32.dll', 'SetBkColor',
                    [hdc, colour]) ?? 0);
                call('GDI32.dll', 'ExtTextOutW', [hdc, 0, 0, ETO_OPAQUE, rect, 0, 0, 0]);
                call('GDI32.dll', 'SetBkColor', [hdc, before]);
                return wholeAddress(before);
            },
        },

        /** DWORD SHGetCurColorRes(void): the screen's bits a pixel. */
        SHGetCurColorRes: {
            argBytes: 0,
            handler: ()=>{
                const hdc = user32('GetDC', [0]);
                const bits = /** @type {number} */ (call('GDI32.dll', 'GetDeviceCaps',
                    [hdc, BITSPIXEL]) ?? 0) * /** @type {number} */ (call('GDI32.dll',
                    'GetDeviceCaps', [hdc, PLANES]) ?? 0);
                user32('ReleaseDC', [0, hdc]);
                return bits;
            },
        },

        /**
         * DWORD SHSendMessageBroadcastA(UINT uMsg, WPARAM wParam, LPARAM lParam)
         *
         * The message to every top-level window, one that hangs passed over.
         */
        ...['A', 'W'].reduce((all, suffix)=>({ ...all, [`SHSendMessageBroadcast${suffix}`]: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [message, wParam, lParam])=>scratch(4, at=>{
                host.writeMemory(at, dword(0));
                user32(`SendMessageTimeout${suffix}`, [HWND_BROADCAST, message, wParam, lParam,
                    SMTO_ABORTIFHUNG, 15000, at]);
                return u32(/** @type {(a: number, l: number) => Uint8Array} */ (
                    host.readMemory)(at, 4));
            }, 0),
        } }), {}),

        /**
         * ATOM SHRegisterClassA(WNDCLASSA *wndclass)
         *
         * The class registered unless the instance has it already.
         */
        ...['A', 'W'].reduce((all, suffix)=>({ ...all,
            [`SHRegisterClass${suffix}`]: {
                argBytes: 4,
                /** @param {number[]} args */
                handler: (/** @type {number[]} */ [wndclass])=>{
                    if ((wndclass >>> 0) === 0 || !host.readMemory)
                    {
                        return 0;
                    }
                    // WNDCLASS: hInstance at 16, lpszClassName at 36.
                    const fields = host.readMemory(wholeAddress(wndclass), 40);
                    const known = scratch(48, at=>user32(`GetClassInfo${suffix}`,
                        [u32(fields, 16), u32(fields, 36), at]), 0);
                    return known !== 0 ? 1 : user32(`RegisterClass${suffix}`, [wndclass]);
                },
            } }), {}),

        /**
         * void SHUnregisterClassesA(HINSTANCE hInst, LPCSTR *lppClasses, INT iCount)
         */
        ...['A', 'W'].reduce((all, suffix)=>({ ...all, [`SHUnregisterClasses${suffix}`]: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [instance, list, count])=>{
                const read = host.readMemory;
                if ((list >>> 0) === 0 || !read)
                {
                    return 0;
                }
                for (let at = 0; at < (count | 0); at++)
                {
                    user32(`UnregisterClass${suffix}`, [u32(read(wholeAddress(list) + at * 4, 4)),
                        instance]);
                }
                return 0;
            },
        } }), {}),

        /** DWORD WhichPlatform(void): a shell integrated with the browser. */
        WhichPlatform: { argBytes: 0, handler: ()=>PLATFORM_INTEGRATED },

        /**
         * DWORD GetUIVersion(void)
         *
         * The major version of the shell, shell32's DllGetVersion's.
         */
        GetUIVersion: {
            argBytes: 0,
            handler: ()=>scratch(20, at=>{
                host.writeMemory(at, new Uint8Array(20));
                host.writeMemory(at, dword(20));
                call('SHELL32.dll', 'DllGetVersion', [at]);
                return u32(/** @type {(a: number, l: number) => Uint8Array} */ (host.readMemory)(
                    at + 4, 4));
            }, 0),
        },

        /**
         * BOOL IsOS(DWORD feature)
         *
         * The questions an NT workstation of the machine's version says yes
         * to (`OS_YES`).
         */
        IsOS: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([feature])=>{
                const span = OS_YES.get(feature >>> 0);
                if (span === undefined)
                {
                    return 0;
                }
                const version = kernel32('GetVersion', []) >>> 0;
                const running = (version & 0xff) * 0x100 + (version >>> 8 & 0xff);
                return running >= span[0] && running < span[1] ? 1 : 0;
            },
        },

        /** HANDLE SHGlobalCounterCreate(REFGUID guid): a counter named by the GUID. */
        SHGlobalCounterCreate: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([guid])=>{
                if ((guid >>> 0) === 0 || !host.readMemory)
                {
                    return 0;
                }
                const bytes = host.readMemory(wholeAddress(guid), 16);
                const hex = [...bytes].map(byte=>byte.toString(16).padStart(2, '0')).join('');
                return createCounter(W, hex, 0);
            },
        },

        /** HANDLE SHGlobalCounterCreateNamedA(LPCSTR lpszName, DWORD iInitial) */
        SHGlobalCounterCreateNamedA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name, initial])=>createCounter(A, A.read(name), initial),
        },
        SHGlobalCounterCreateNamedW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name, initial])=>createCounter(W, W.read(name), initial),
        },

        /** LONG SHGlobalCounterGetValue(HANDLE hSem) */
        SHGlobalCounterGetValue: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>counterValue(handle),
        },

        /** LONG SHGlobalCounterIncrement(HANDLE hSem): the count after. */
        SHGlobalCounterIncrement: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>scratch(4, at=>{
                host.writeMemory(at, dword(0));
                kernel32('ReleaseSemaphore', [handle, 1, at]);
                return u32(/** @type {(a: number, l: number) => Uint8Array} */ (
                    host.readMemory)(at, 4)) + 1;
            }, 0),
        },

        /** DWORD SHGlobalCounterDecrement(HANDLE hSem): the count after, held at 0. */
        SHGlobalCounterDecrement: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>(kernel32('WaitForSingleObject', [handle, 0]) === WAIT_OBJECT_0
                ? counterValue(handle) : 0),
        },

        /**
         * PVOID SHInterlockedCompareExchange(PVOID *dest, PVOID xchg, PVOID compare)
         *
         * The pointer replaced when it is the one compared; the one it was
         * answered either way.
         */
        SHInterlockedCompareExchange: {
            returns: 'pointer',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, exchange, compare])=>{
                if (wholeAddress(destination) === 0 || !host.readMemory)
                {
                    return 0;
                }
                const before = u32(host.readMemory(wholeAddress(destination), 4));
                if (before === wholeAddress(compare))
                {
                    host.writeMemory(wholeAddress(destination), dword(wholeAddress(exchange)));
                }
                return before;
            },
        },

        /** DWORD GetPerfTime(void): milliseconds since the machine started. */
        GetPerfTime: { argBytes: 0, handler: ()=>kernel32('GetTickCount', []) >>> 0 },

        /** DWORD SHGetAppCompatFlags(DWORD dwUnknown): no compatibility flags for any program. */
        SHGetAppCompatFlags: { argBytes: 4, handler: ()=>0 },

        /** DWORD SHGetMachineInfo(DWORD dwFlags): not a docked laptop. */
        SHGetMachineInfo: { argBytes: 4, handler: ()=>0 },

        /**
         * HRESULT SHCoCreateInstanceAC(REFCLSID rclsid, LPUNKNOWN pUnkOuter,
         *     DWORD dwClsContext, REFIID iid, LPVOID *ppv)
         */
        SHCoCreateInstanceAC: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: args=>call('ole32.dll', 'CoCreateInstance', args) ?? E_FAIL,
        },

        /**
         * HMODULE MLLoadLibraryA(LPCSTR new_mod, HMODULE inst_hwnd, DWORD dwCrossCodePage)
         *
         * The resource library loaded by its name, as LoadLibrary finds it.
         */
        MLLoadLibraryA: {
            returns: 'pointer',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name])=>call('KERNEL32.dll', 'LoadLibraryA', [name]) ?? 0,
        },
        MLLoadLibraryW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([name])=>call('KERNEL32.dll', 'LoadLibraryW', [name]) ?? 0,
        },
        /** BOOL MLFreeLibrary(HMODULE hModule) */
        MLFreeLibrary: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: args=>call('KERNEL32.dll', 'FreeLibrary', args) ?? 0,
        },
        /** BOOL MLIsMLHInstance(HINSTANCE hInst): no instance is a language library here. */
        MLIsMLHInstance: { argBytes: 4, handler: ()=>0 },

        /**
         * HRESULT MLBuildResURLA(LPCSTR lpszLibName, HMODULE hMod, DWORD dwFlags,
         *     LPCSTR lpszRes, LPSTR lpszDest, DWORD dwDestLen)
         *
         * "res://", the library's path and "/", then the resource's name.
         */
        ...[['A', A], ['W', W]].reduce((all, [suffix, width])=>({ ...all,
            [`MLBuildResURL${suffix}`]: {
                argBytes: 24,
                /** @param {number[]} args */
                handler: (/** @type {number[]} */ [library, module, , resource, out, room])=>{
                    const w = /** @type {import('./text.js').Width} */ (width);
                    const name = w.read(resource);
                    if (name === null || (out >>> 0) === 0 || (room >>> 0) === 0)
                    {
                        return E_INVALIDARG;
                    }
                    const handle = (module >>> 0) !== 0 ? module >>> 0
                        : kernel32(`GetModuleHandle${suffix}`, [library]);
                    const path = handle === 0 ? null : scratch(520, at=>{
                        const length = kernel32('GetModuleFileNameW', [handle, at, 260]);
                        return length > 0 ? W.read(at) : null;
                    }, null);
                    if (path === null)
                    {
                        return E_INVALIDARG;
                    }
                    const url = `res://${path}/${name}`;
                    if (url.length >= (room >>> 0))
                    {
                        return E_INVALIDARG;
                    }
                    host.writeMemory(wholeAddress(out), w.sz(url));
                    return S_OK;
                },
            } }), {}),
    };
}
