/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * gdiplus - GDI+'s flat API: starting it, its allocator, and its families,
 * each a model of its objects behind the handles a program holds -
 * matrices, paths and their iterators, brushes, pens and caps, regions,
 * images and their attributes, graphics, fonts, string formats and text.
 * One table of handles serves them all (`kit.js`), so a handle names one
 * object of one family, and one family reaches another's objects only
 * through what that family hands it here.
 *
 * Drawing is GDI+'s own rasteriser over a bitmap's pixels or a DC's
 * (`graphics.js`, `raster.js`); images decode through Windows' imaging
 * component's codecs (`image.js`); a face is gdi32's (`fonts.js`,
 * `text.js`). What this build does not do - metafiles, effects, a path of
 * a string's outlines - answers NotImplemented, said once as a divergence.
 */

import { pointerWidth, wholeAddress } from '../common/pointers.js';
import { createFontFunctions } from './fonts.js';
import { createKit } from './kit.js';
import { createMatrixFunctions } from './matrix.js';
import { createPathFunctions } from './path.js';
import { createBrushFunctions } from './brush.js';
import { createPenFunctions } from './pen.js';
import { createPathIteratorFunctions } from './pathiterator.js';
import { createImageFunctions } from './image.js';
import { createRegionFunctions } from './region.js';
import { createGraphicsFunctions } from './graphics.js';
import { createStringFormatFunctions } from './stringformat.js';
import { createTextFunctions } from './text.js';
import { createImageAttributesFunctions } from './imageattributes.js';
import { createGuestStreams } from './stream.js';
import { createUnsupportedFunctions } from './unsupported.js';

/** GpStatus (gdiplustypes.h). */
const Ok = 0;
const InvalidParameter = 2;
const UnsupportedGdiplusVersion = 17;

/**
 * @typedef {Object} GdiplusHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(bytes: number) => number} allocate  zero when none is left
 * @property {(address: number) => void} free
 * @property {4 | 8} [pointerSize]
 * @property {(api: string, detail: string, kind?: string) => void} [divergence]
 * @property {(address: number) => string} [readWideString]
 * @property {(path: string) => Promise<Uint8Array | null> | Uint8Array | null} [readFile]
 *     a file of the volume, whole; null for none
 * @property {(path: string, bytes: Uint8Array) => boolean} [writeFile]  a file of the
 *     volume made or replaced whole; false where it could not be
 * @property {(name: string, args: number[]) => number} [gdi32]  a GDI32 export, called
 * @property {(name: string, args: number[]) => number} [user32]  a USER32 export, called
 * @property {(entry: number, args: number[]) => Promise<number>} [callGuest]  guest code
 *     called on the calling thread: a program's IStream
 * @property {(name: string) => Promise<number> | number} [procAddress]  where an export of
 *     this library is, for a pointer to it handed out
 */

/** @param {GdiplusHost} host */
export function createGdiplusFunctions(host){
    const pointer = pointerWidth(host.pointerSize ?? 4);
    const kit = createKit(host);
    const handle = kit.handle;
    const putPointer = kit.putPointer;
    const callGuest = host.callGuest;
    const streams = callGuest ? createGuestStreams({ ...host, callGuest }) : undefined;
    const images = createImageFunctions(kit, { ...host, streams });
    const matrices = createMatrixFunctions(kit);
    const paths = createPathFunctions(kit, matrices);
    const brushes = createBrushFunctions(kit, { matrices, paths, images });
    const pens = createPenFunctions(kit, { matrices, paths, brushes });
    /** @type {{ isGraphics: (at: number) => boolean }} */
    const late = { isGraphics: ()=>false };
    const regions = createRegionFunctions(kit, { matrices, paths,
        isGraphics: at=>late.isGraphics(at), gdi32: host.gdi32, allocate: host.allocate,
        free: host.free });
    const attributes = createImageAttributesFunctions(kit);
    const graphics = createGraphicsFunctions(kit, { host, matrices, paths, brushes, pens,
        regions, images, attributes: at=>attributes.forImages(at) });
    late.isGraphics = graphics.isGraphics;
    const fonts = createFontFunctions({ host, handle, putPointer,
        isGraphics: graphics.isGraphics });
    const formats = createStringFormatFunctions(kit);
    const text = createTextFunctions(kit, { host, fonts, graphics, brushes, formats, regions });

    const families = {
        ...matrices.functions,
        ...paths.functions,
        ...brushes.functions,
        ...pens.functions,
        ...createPathIteratorFunctions(kit, paths).functions,
        ...images.functions,
        ...regions.functions,
        ...attributes.functions,
        ...graphics.functions,
        ...fonts.functions,
        ...formats.functions,
        ...text.functions,

        /**
         * Status GdiplusStartup(ULONG_PTR *token, const GdiplusStartupInput *input,
         *   GdiplusStartupOutput *output)
         *
         * Versions 1 and 2 start (GDI+ 1.0 and 1.1); another is
         * UnsupportedGdiplusVersion. A caller that suppressed the background
         * thread is handed the hook and unhook it must call itself in the
         * output, as GDI+ hands them - the library's own GdiplusNotificationHook
         * and GdiplusNotificationUnhook - and must call: left null, its first
         * call went to address zero.
         */
        GdiplusStartup: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: async([token, input, output])=>{
                if (wholeAddress(token) === 0 || wholeAddress(input) === 0)
                {
                    return InvalidParameter;
                }
                // GdiplusStartupInput: the version, the debug callback, then
                // SuppressBackgroundThread.
                const fields = new DataView(host.readMemory(wholeAddress(input),
                    pointer.size * 2 + 4)
                    .slice().buffer);
                const version = fields.getUint32(0, true);
                if (version < 1 || version > 2)
                {
                    return UnsupportedGdiplusVersion;
                }
                putPointer(token, handle());
                if (wholeAddress(output) !== 0)
                {
                    const suppressed = fields.getUint32(pointer.size * 2, true) !== 0;
                    const hook = suppressed
                        ? await host.procAddress?.('GdiplusNotificationHook') ?? 0 : 0;
                    const unhook = suppressed
                        ? await host.procAddress?.('GdiplusNotificationUnhook') ?? 0 : 0;
                    putPointer(output, hook);
                    putPointer(wholeAddress(output) + pointer.size, unhook);
                }
                return Ok;
            },
        },

        /**
         * Status GdiplusNotificationHook(ULONG_PTR *token): the work the background
         * thread would do on the caller's message loop. There is none here; a
         * token for the unhook.
         */
        GdiplusNotificationHook: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([token])=>{
                if (wholeAddress(token) === 0)
                {
                    return InvalidParameter;
                }
                putPointer(token, handle());
                return Ok;
            },
        },

        /** void GdiplusNotificationUnhook(ULONG_PTR token) */
        GdiplusNotificationUnhook: {
            argBytes: 4,
            handler: ()=>0,
        },

        /** void GdiplusShutdown(ULONG_PTR token) */
        GdiplusShutdown: {
            argBytes: 4,
            handler: ()=>0,
        },

        /** void *GdipAlloc(size_t size): memory GdipFree gives back, zero when none is left. */
        GdipAlloc: {
            returns: 'pointer',
            argBytes: 4,
            sizes: [0],
            /** @param {number[]} args */
            handler: ([size])=>host.allocate(Math.max(1, size >>> 0)),
        },

        /** void GdipFree(void *ptr) */
        GdipFree: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([address])=>{
                if (wholeAddress(address) !== 0)
                {
                    host.free(wholeAddress(address));
                }
                return 0;
            },
        },

        /**
         * HPALETTE GdipCreateHalftonePalette(void)
         *
         * GDI's halftone palette, which WinForms selects into a DC at every
         * WM_PAINT of a control (Control.SetUpPalette); the caller owns it.
         */
        GdipCreateHalftonePalette: {
            argBytes: 0,
            handler: ()=>(host.gdi32 ? host.gdi32('CreateHalftonePalette', [0]) >>> 0 : 0),
        },
    };
    return { ...createUnsupportedFunctions(host, families), ...families };
}
