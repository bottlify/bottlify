/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * comctl32 — image lists (imagelist.js), the mouse-tracking request,
 * property sheets (propsheet.js), flat scroll bars (flatsb.js), and the
 * toolbar, mapped-bitmap and drag-list helpers (helpers.js).
 */

import { createFlatScrollBarFunctions } from './flatsb.js';
import { createHelperFunctions } from './helpers.js';
import { createImageListFunctions } from './imagelist-stream.js';
import { createPropertySheetFunctions } from './propsheet.js';

/**
 * @typedef {Object} ComctlHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
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
 * @property {(bytes: number) => number} [allocate]
 * @property {(address: number) => void} [release]
 * @property {(entry: number, args: number[], thread?: unknown) => number | Promise<number>} [call]
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

/** @param {Uint8Array} bytes @param {number} at */
const u32 = (bytes, at)=>(bytes[at] | bytes[at + 1] << 8
    | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;

const S_OK = 0;
const E_INVALIDARG = 0x80070057 | 0;

/** comctl32.dll's own version on Windows XP SP3, the 5.82 library. */
const VERSION = Object.freeze({ major: 5, minor: 82, build: 2900, qfe: 5512 });
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
    8: 'CreateMappedBitmap',
    13: 'MakeDragList',
    14: 'LBItemFromPt',
    17: 'InitCommonControls',
});

/**
 * @param {ComctlHost} host
 */
export function createComctlFunctions(host){
    const sheets = createPropertySheetFunctions(host);
    const images = createImageListFunctions(host);
    return {
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
                const size = u32(host.readMemory(controls >>> 0, 4), 0);
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
                    return host.trackMouseEvent(track >>> 0);
                }
                const size = u32(host.readMemory(track >>> 0, 4), 0);
                return size === 16 ? 1 : 0;
            },
        },

        /**
         * HRESULT DllGetVersion(DLLVERSIONINFO *pdvi)
         *
         * The common controls a program gets without asking for version 6
         * in a manifest: Windows XP Service Pack 3's 5.82.2900.5512, on the
         * NT platform. A program reads the major version to decide which
         * control messages and structure sizes it may use, so this has to be
         * the library it is actually talking to. The caller says which
         * structure it passed by its first field -- DLLVERSIONINFO, 20 bytes,
         * or DLLVERSIONINFO2, 32, which adds flags and the version as one
         * 64-bit number -- and any other size is refused.
         */
        DllGetVersion: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([info])=>{
                if ((info >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const size = u32(host.readMemory(info >>> 0, 4), 0);
                if (size !== DLLVERSIONINFO_SIZE && size !== DLLVERSIONINFO2_SIZE)
                {
                    return E_INVALIDARG;
                }
                const fields = new DataView(new ArrayBuffer(size - 4));
                fields.setUint32(0, VERSION.major, true);
                fields.setUint32(4, VERSION.minor, true);
                fields.setUint32(8, VERSION.build, true);
                fields.setUint32(12, DLLVER_PLATFORM_NT, true);
                if (size === DLLVERSIONINFO2_SIZE)
                {
                    // dwFlags stays zero; ullVersion is major.minor.build.qfe,
                    // a word each, the major in the top word.
                    fields.setUint32(20, (VERSION.build << 16 | VERSION.qfe) >>> 0, true);
                    fields.setUint32(24, (VERSION.major << 16 | VERSION.minor) >>> 0, true);
                }
                host.writeMemory((info >>> 0) + 4, new Uint8Array(fields.buffer));
                return S_OK;
            },
        },

        ...images,
        ...sheets,
        ...createFlatScrollBarFunctions(host),
        ...createHelperFunctions(host),

        // The undecorated names the library exports for the ANSI forms, which
        // a program that looks a call up by hand may ask for.
        PropertySheet: sheets.PropertySheetA,
        CreatePropertySheetPage: sheets.CreatePropertySheetPageA,
        ImageList_LoadImage: images.ImageList_LoadImageA,
    };
}
