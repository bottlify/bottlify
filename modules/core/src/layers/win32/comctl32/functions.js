/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * comctl32 — image lists (imagelist.js), the mouse-tracking request,
 * property sheets (propsheet.js), flat scroll bars (flatsb.js), and the
 * toolbar, mapped-bitmap and drag-list helpers (helpers.js), window
 * subclassing (subclass.js).
 */

import { DATA_ORDINALS, createDataStructureFunctions } from './dpa.js';
import { createFlatScrollBarFunctions } from './flatsb.js';
import { createHelperFunctions } from './helpers.js';
import { createImageListFunctions } from './imagelist-stream.js';
import { createPropertySheetFunctions } from './propsheet.js';
import { createSubclassFunctions } from './subclass.js';
import { UDM_SETBUDDY, UDM_SETPOS, UDM_SETRANGE, UPDOWN_CLASS } from './updown.js';
import { wholeAddress } from '../common/pointers.js';

/**
 * @typedef {Object} ComctlHost
 * @property {import('../common/guest.js').Guest} guest
 *           The guest's memory at the process's width: the arrays (DPA, DSA) take its layout.
 * @property {(bitmap: number) => { width: number, height: number } | null} [bitmapSize]
 *           How large a bitmap handle is, for counting the images in a strip.
 *           Absent in a build without gdi32 behind it, and then a strip counts
 *           as the single image it can be sure of.
 * @property {(api: string, detail: string) => void} [divergence]
 *           Where a call that does less than the real one says so.
 * @property {ReturnType<typeof import('./imagelist.js').createImageLists>} [imageLists]
 *           The image lists to export, built by the host to share with the
 *           tab control; without them this host's own are made.
 * @property {(name: string) => ({ handler: (args: number[]) => any } | undefined)} [gdi32]
 *           gdi32's exports, which CreateMappedBitmap reaches a bitmap's bits
 *           through. Absent, the bitmap is handed out with its colours as
 *           they were, and the call says so.
 * @property {(request: number) => number} [trackMouseEvent]
 *           user32's TrackMouseEvent, given the request's address. Absent in
 *           a build without user32 behind it, and then a request of the right
 *           size is accepted and nothing is tracked.
 * @property {(name: string) => ({ handler: (args: number[]) => any } | undefined)} [user32]
 *           user32's exports, which a property sheet is built with.
 * @property {(name: string) => ((args: number[]) => any) | undefined} [kernel32]
 *           kernel32's handlers, which the arrays and the allocator take their
 *           memory through (dpa.js).
 * @property {(bytes: number) => number} [allocate]
 * @property {(address: number) => void} [release]
 * @property {(entry: number, args: (number | bigint)[], thread?: unknown)
 *     => number | Promise<number>} [call]
 * @property {() => unknown} [callerThread]
 * @property {(name: string, handler: (args: number[]) => number | Promise<number>) => number}
 *     [procedure]
 * @property {(instance: number, type: number, name: number | string)
 *     => ({ rva: number } | null)} [findResource]
 * @property {(instance: number) => number} [moduleBase]
 * @property {(instance: number, id: number) => string | null} [loadString]
 * @property {(hwnd: number, options: { thread: unknown,
 *     first?: import('../user32/dialogs.js').ModalHook }) => number | Promise<number>} [modal]
 *           The rest of what a property sheet needs; see propsheet.js.
 */

const S_OK = 0;
const E_INVALIDARG = 0x80070057 | 0;

/**
 * The two libraries a program can be given (`commonControlsFaces`):
 * system32's 5.82, as on Windows XP SP3, and Common Controls 6 from the
 * assembly, the version the engine's store holds.
 */
const VERSION_5 = Object.freeze({ major: 5, minor: 82, build: 2900, qfe: 5512 });
const VERSION_6 = Object.freeze({ major: 6, minor: 0, build: 2600, qfe: 2180 });
const DLLVER_PLATFORM_NT = 2;
/** DLLVERSIONINFO and DLLVERSIONINFO2, told apart by their cbSize. */
const DLLVERSIONINFO_SIZE = 20;
const DLLVERSIONINFO2_SIZE = 32;

/**
 * Which ordinal is which export, for a program that links this library by
 * number: the numbers of the 5.82 library (Wine's comctl32.spec agrees).
 * Only the ones that are implemented and are imported that way: an ordinal
 * exported while pointing at nothing is a call that binds and then jumps
 * into nowhere.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const COMCTL32_ORDINALS = Object.freeze({
    ...DATA_ORDINALS,
    8: 'CreateMappedBitmap',
    13: 'MakeDragList',
    14: 'LBItemFromPt',
    17: 'InitCommonControls',
    // An image list's palette, exported by number alone.
    390: '#390',
    // Exported by number alone before Windows XP, and found so still.
    410: 'SetWindowSubclass',
    411: 'GetWindowSubclass',
    412: 'RemoveWindowSubclass',
    413: 'DefSubclassProc',
});

/**
 * The window classes the 5.82 library registers, by the lower-case names
 * RegisterClassNameW is asked for; version 6 adds SysLink and the user
 * controls, which it carries its own of.
 */
const CLASSES_5 = new Set(['comboboxex32', 'msctls_hotkey32', 'msctls_progress32',
    'msctls_statusbar32', 'msctls_trackbar32', 'msctls_updown32', 'nativefontctl',
    'rebarwindow32', 'sysanimate32', 'sysdatetimepick32', 'sysheader32', 'sysipaddress32',
    'syslistview32', 'sysmonthcal32', 'syspager', 'systabcontrol32', 'systreeview32',
    'toolbarwindow32', 'tooltips_class32']);
const CLASSES_6 = new Set([...CLASSES_5, 'button', 'combobox', 'combolbox', 'edit', 'listbox',
    'static', 'syslink']);

/**
 * The exports only Common Controls 6 has: the 5.82 library a program gets
 * without the assembly has none of them (Wine's misc test lists them).
 */
export const VERSION_6_EXPORTS = Object.freeze(['DllInstall', 'DrawShadowText', 'DPA_GetSize',
    'DSA_Clone', 'DSA_GetSize', 'GetWindowSubclass', 'HIMAGELIST_QueryInterface',
    'ImageList_CoCreateInstance', 'ImageList_WriteEx', 'LoadIconMetric',
    'LoadIconWithScaleDown', 'TaskDialog', 'TaskDialogIndirect']);

/**
 * One implementation, the two libraries it is to a program: `system`, the
 * 5.82 library in system32, and `assembly`, Common Controls 6, which the
 * loader binds where an activation context holds that assembly. They differ
 * in what is version 6's alone: its exports, its classes and its version.
 *
 * @param {ComctlHost} host
 * @returns {{ system: Record<string, any>, assembly: Record<string, any> }}
 */
export function commonControlsFaces(host){
    const table = createComctlFunctions(host);
    const system = Object.fromEntries(Object.entries(table)
        .filter(([name])=>!VERSION_6_EXPORTS.includes(name)));
    return {
        system: { ...system, DllGetVersion: dllGetVersion(host, VERSION_5),
            RegisterClassNameW: registerClassName(host, CLASSES_5) },
        assembly: { ...table, DllGetVersion: dllGetVersion(host, VERSION_6),
            RegisterClassNameW: registerClassName(host, CLASSES_6) },
    };
}

/**
 * @param {ComctlHost} host
 */
export function createComctlFunctions(host){
    const { guest } = host;
    const sheets = createPropertySheetFunctions(host);
    const images = createImageListFunctions(host);
    return {
        ...createDataStructureFunctions(host),
        /**
         * void InitCommonControls(void)
         *
         * The older form, which registers every class at once and reports
         * nothing. Imported by ordinal 17 as often as by name.
         */
        InitCommonControls: {
            argBytes: 0,
            handler: ()=>0,
        },

        /**
         * BOOL InitCommonControlsEx(const INITCOMMONCONTROLSEX *picce)
         *
         * The structure names which control classes to register. There are no
         * common controls here to register, but the size check is what a caller
         * of the wrong vintage trips on, and reporting that honestly is better
         * than accepting a structure we did not understand.
         */
        InitCommonControlsEx: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([controls])=>{
                const size = guest.u32(controls);
                return size === 8 ? 1 : 0;
            },
        },

        /**
         * BOOL _TrackMouseEvent(LPTRACKMOUSEEVENT lpEventTrack)
         *
         * A request to be sent WM_MOUSELEAVE or WM_MOUSEHOVER later, which
         * is documented as TrackMouseEvent's where the system has one, and is
         * handed to user32's. Without user32 behind it the request is
         * accepted and the messages never come: a program treats them as a
         * nicety and a refusal here as an error, so the honest failure is the
         * worse of the two.
         */
        _TrackMouseEvent: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([track])=>{
                if (host.trackMouseEvent)
                {
                    return host.trackMouseEvent(wholeAddress(track));
                }
                const size = guest.u32(track);
                return size === 16 ? 1 : 0;
            },
        },

        /**
         * HWND CreateUpDownControl(DWORD dwStyle, int x, int y, int cx, int cy,
         *     HWND hParent, int nID, HINSTANCE hInst, HWND hBuddy, int nUpper,
         *     int nLower, int nPos)
         *
         * An up-down control made and set up in one call: its buddy, its range
         * and its position, each as its message sets it.
         */
        CreateUpDownControl: {
            argBytes: 48,
            /** @param {number[]} args */
            handler: ([style, x, y, cx, cy, parent, id, instance, buddy, upper, lower, pos])=>{
                const create = host.user32?.('CreateWindowExA');
                const send = host.user32?.('SendMessageA');
                const name = host.allocate?.(UPDOWN_CLASS.length + 1) ?? 0;
                if (!create || !send || name === 0)
                {
                    return 0;
                }
                guest.writeAnsi(name, UPDOWN_CLASS);
                /** @param {unknown} value @param {(answer: any) => any} then */
                const andThen = (value, then)=>(typeof (/** @type {any} */ (value))?.then
                    === 'function' ? /** @type {Promise<unknown>} */ (value).then(then)
                    : then(value));
                return andThen(create.handler([0, name, 0, style, x, y, cx, cy, parent, id,
                    instance, 0]), hwnd=>{
                    host.release?.(name);
                    if ((hwnd >>> 0) === 0)
                    {
                        return 0;
                    }
                    return andThen(send.handler([hwnd, UDM_SETBUDDY, buddy, 0]),
                        ()=>andThen(send.handler([hwnd, UDM_SETRANGE, 0,
                            ((lower & 0xffff) << 16 | upper & 0xffff) >>> 0]),
                        ()=>andThen(send.handler([hwnd, UDM_SETPOS, 0, pos & 0xffff]),
                            ()=>hwnd >>> 0)));
                });
            },
        },

        ...images,
        ...sheets,
        ...createFlatScrollBarFunctions(host),
        ...createHelperFunctions(host),
        ...createSubclassFunctions(host),

        // The undecorated names the library exports for the ANSI forms, which
        // a program that looks a call up by hand may ask for.
        PropertySheet: sheets.PropertySheetA,
        CreatePropertySheetPage: sheets.CreatePropertySheetPageA,
        ImageList_LoadImage: images.ImageList_LoadImageA,
    };
}

/**
 * HRESULT DllGetVersion(DLLVERSIONINFO *pdvi)
 *
 * The version of the library the program is talking to, on the NT
 * platform: 5.82.2900.5512 for system32's, as on Windows XP SP3, and
 * 6.0.2600.2180 for Common Controls 6. A program reads the major version
 * to decide which control messages and structure sizes it may use. The
 * caller says which structure it passed by its first field -
 * DLLVERSIONINFO, 20 bytes, or DLLVERSIONINFO2, 32, which adds flags and
 * the version as one 64-bit number - and any other size is refused.
 *
 * @param {ComctlHost} host
 * @param {{ major: number, minor: number, build: number, qfe: number }} version
 */
function dllGetVersion(host, version){
    const { guest } = host;
    return {
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([info])=>{
            if ((info >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const size = guest.u32(info);
            if (size !== DLLVERSIONINFO_SIZE && size !== DLLVERSIONINFO2_SIZE)
            {
                return E_INVALIDARG;
            }
            guest.set32s(info + 4, [version.major, version.minor, version.build,
                DLLVER_PLATFORM_NT]);
            if (size === DLLVERSIONINFO2_SIZE)
            {
                // dwFlags is zero; ullVersion is major.minor.build.qfe,
                // a word each, the major in the top word.
                guest.set32s(info + 20, [0, version.build << 16 | version.qfe,
                    version.major << 16 | version.minor]);
            }
            return S_OK;
        },
    };
}

/**
 * BOOL RegisterClassNameW(LPCWSTR className)
 *
 * What user32 asks comctl32 for from Vista on when a window is made of
 * a class nobody registered: the library registers that one of its
 * own classes. Here the common controls are classes of the window
 * manager from the start, so the call answers whether the name is one
 * of comctl32's and is there; a name of another library's, or one
 * this machine has no control for, is refused.
 *
 * @param {ComctlHost} host
 * @param {Set<string>} classes  the library's own, lower case
 */
function registerClassName(host, classes){
    const { guest } = host;
    return {
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([name])=>{
            if (name >>> 0 === 0)
            {
                return 0;
            }
            const text = guest.wstr(name, 512);
            if (!classes.has(text.toLowerCase()) || !host.allocate || !host.user32)
            {
                return 0;
            }
            const info = host.allocate(40);
            try
            {
                return host.user32('GetClassInfoW')?.handler([0, name >>> 0, info]) ? 1 : 0;
            }
            finally
            {
                host.release?.(info);
            }
        },
    };
}
