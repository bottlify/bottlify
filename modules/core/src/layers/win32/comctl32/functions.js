/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * comctl32 — image lists (imagelist.js), the mouse-tracking request,
 * property sheets (propsheet.js) and flat scroll bars (flatsb.js).
 */

import { createFlatScrollBarFunctions } from './flatsb.js';
import { createImageListFunctions } from './imagelist.js';
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

/**
 * Which ordinal is which export, for a program that links this library by
 * number. Only the one that is implemented and is imported that way: an
 * ordinal exported while pointing at nothing is a call that binds and then
 * jumps into nowhere.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const COMCTL32_ORDINALS = Object.freeze({
    17: 'InitCommonControls',
});

/**
 * @param {ComctlHost} host
 */
export function createComctlFunctions(host){
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

        ...createImageListFunctions(host),
        ...createPropertySheetFunctions(host),
        ...createFlatScrollBarFunctions(host),
    };
}
