/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The WGL seam: where a GL context meets a GDI device context.
 *
 * This is the part of OpenGL on Windows with the surprises in it, and every
 * rule below was established by measurement rather than read off the
 * documentation.
 *
 * - **A pixel format belongs to the drawable, not to the DC.** Two device
 *   contexts obtained for the same window report the same format, and setting
 *   one sets both. A memory DC is its own drawable: its format survives the
 *   bitmap selected into it being swapped for another.
 * - **A format can be set once.** A second call naming the *same* format
 *   succeeds and changes nothing; any other format fails. That asymmetry is
 *   the rule, not "the second call fails".
 * - **A DC with no pixel format cannot make a context.** That is the failure a
 *   program hits when it forgets the call, and it has to be a failure rather
 *   than a default, because the default would be the wrong format.
 * - **A context is current on one thread at a time.** Making it current on the
 *   thread that already holds it is fine; on a second thread it fails, and it
 *   fails with ERROR_BUSY rather than ERROR_INVALID_HANDLE, which is how a
 *   program tells a race from a bug. So does deleting it from that second
 *   thread.
 * - **wglMakeCurrent(NULL, NULL) is not simply "release".** It releases when
 *   this thread holds a context and fails with ERROR_INVALID_HANDLE when it
 *   does not, because the null DC is the invalid handle. Passing a real DC
 *   with a null context always succeeds, whether or not anything was current.
 * - **Deleting a context makes it not current** on the thread that held it,
 *   there and then. Deleting it twice fails.
 * - **wglShareLists moves the destination into the source's group**, and only
 *   if the destination's own group has never held an object. It goes on
 *   refusing after every object in that group has been deleted, so the test is
 *   "was ever used" rather than "is empty".
 * - **wglGetProcAddress answers honestly.** A function opengl32 exports itself
 *   returns null, whether or not a context is current -- that is how a program
 *   tells a core entry point from an extension. An extension function returns
 *   null when no context is current, and a stable pointer otherwise. Names are
 *   not aliased: a vendor suffix is a different function and is present only
 *   if that vendor's extension is reported.
 *
 * The GDI half arrives injected. What this layer needs from a device context
 * is which drawable it names and how big it is, and nothing else -- so the
 * seam is one function, and the whole of WGL runs headless in a test.
 */

import { PFD, WIN32_ERROR } from './constants.js';
import { CORE_FUNCTIONS, createGlContext } from './context.js';
import { HIDDEN_GL_EXTENSIONS } from './extensions.js';
import { PIXEL_FORMATS, choosePixelFormat, writePixelFormatDescriptor } from './pixelformat.js';

/**
 * @typedef {Object} DrawableInfo
 * @property {string} key
 *           What the pixel format belongs to. A window DC names its window, so
 *           that every DC for that window shares one format; a memory DC names
 *           itself, so that its format outlives the bitmap it was set with.
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {Object} WglGdi
 * @property {(hdc: number) => DrawableInfo | null} describeDrawable
 *           Null for a handle that is not a device context at all.
 */

/**
 * @typedef {Object} WglOptions
 * @property {WglGdi} gdi
 * @property {() => number} currentThread
 * @property {(code: number) => void} [setLastError]
 *           Where the guest's last-error slot lives. A mirror is kept here
 *           either way, so a test never needs one.
 * @property {Readonly<Record<string, readonly string[]>>} [extensions]
 *           Extension name -> the functions it adds. What is not in here is
 *           not reported and is not obtainable, which is the honest answer.
 * @property {{ readMemory: (address: number, length: number) => Uint8Array,
 *              windowMemory?: (address: number, length: number) => Uint8Array,
 *              writeMemory: (address: number, bytes: Uint8Array) => void,
 *              allocate?: (bytes: number) => number }} [memory]
 *           DescribePixelFormat writes through it when given an address, and
 *           every context made here reads its pixels and arrays through it.
 * @property {(detail: string) => void} [divergence]
 *           Handed to every context, for the calls it accepts and cannot honour.
 * @property {ReturnType<typeof import('./gpu.js').createGpuRenderer>} [gpu]
 *           Handed to every context: where its draws go when this build has a
 *           device. Absent, a context draws on the processor.
 * @property {boolean} [raster]
 *           Handed to every context: `false` skips the processor's
 *           rasterisation of primitives (see `GlContextOptions.raster`).
 * @property {boolean} [keepPrimitives]
 *           Handed to every context: keep what each one draws for a test to
 *           read back (see `GlContextOptions.keepPrimitives`).
 */

/**
 * @param {WglOptions} options
 */
export function createWgl(options){
    const gdi = options.gdi;
    const extensions = options.extensions ?? {};

    /** @type {Map<string, string>} function name -> the extension that provides it */
    const providedBy = new Map();
    for (const [extension, functions] of Object.entries(extensions))
    {
        for (const name of functions)
        {
            providedBy.set(name, extension);
        }
    }

    /** @type {Map<string, any>} so that a repeated lookup returns the same pointer */
    const procAddresses = new Map();

    /** @type {Map<string, number>} drawable key -> the one-based format index */
    const formats = new Map();
    /** @type {Map<string, number>} drawable key -> how many times it was presented */
    const swaps = new Map();

    /**
     * @type {Map<any, { key: string, formatIndex: number, doubleBuffered: boolean,
     *                   depthBits: number }>}
     */
    const live = new Map();

    /** @type {import('./kernel.js').ContextMemory | undefined} */
    const contextMemory = options.memory
        ? {
            read: options.memory.readMemory,
            window: options.memory.windowMemory,
            write: options.memory.writeMemory,
            allocate: options.memory.allocate,
        }
        : undefined;

    /** @type {Map<number, { context: any, hdc: number }>} thread -> what it holds */
    const current = new Map();

    /** @type {number} */
    let lastError = WIN32_ERROR.SUCCESS;

    /** @param {number} code */
    const fail = code=>{
        lastError = code;
        options.setLastError?.(code);
    };

    /** @param {any} context @returns {number | null} the thread holding it */
    const holderOf = context=>{
        for (const [thread, held] of current)
        {
            if (held.context === context)
            {
                return thread;
            }
        }
        return null;
    };

    const wgl = {
        getLastError: ()=>lastError,

        /** @param {number} hdc @returns {number} how many times it was presented */
        swapCount(hdc){
            const drawable = gdi.describeDrawable(hdc);
            return drawable ? (swaps.get(drawable.key) ?? 0) : 0;
        },

        // --- pixel formats ---

        /**
         * @param {number} hdc
         * @param {import('./pixelformat.js').PixelFormat} request
         * @returns {number} the one-based index, or zero
         */
        ChoosePixelFormat(hdc, request){
            if (!gdi.describeDrawable(hdc))
            {
                fail(WIN32_ERROR.INVALID_HANDLE);
                return 0;
            }
            return choosePixelFormat(request);
        },

        /**
         * Returns the number of formats regardless of which one was asked
         * about, so that the count can be obtained with an index of zero and
         * no buffer at all.
         *
         * @param {number} hdc
         * @param {number} index
         * @param {number} bytes
         * @param {number} [address]
         * @returns {number}
         */
        DescribePixelFormat(hdc, index, bytes, address){
            if (!gdi.describeDrawable(hdc))
            {
                fail(WIN32_ERROR.INVALID_HANDLE);
                return 0;
            }
            if (index < 0 || index > PIXEL_FORMATS.length)
            {
                fail(WIN32_ERROR.INVALID_PIXEL_FORMAT);
                return 0;
            }
            if (index > 0 && address !== undefined && options.memory && bytes > 0)
            {
                writePixelFormatDescriptor(
                    options.memory, address, PIXEL_FORMATS[index - 1], bytes);
            }
            return PIXEL_FORMATS.length;
        },

        /**
         * @param {number} hdc
         * @param {number} index
         * @returns {boolean}
         */
        SetPixelFormat(hdc, index){
            const drawable = gdi.describeDrawable(hdc);
            if (!drawable)
            {
                fail(WIN32_ERROR.INVALID_HANDLE);
                return false;
            }
            if (index < 1 || index > PIXEL_FORMATS.length)
            {
                fail(WIN32_ERROR.INVALID_PIXEL_FORMAT);
                return false;
            }
            const existing = formats.get(drawable.key);
            if (existing !== undefined)
            {
                // Naming the format the drawable already has is not a second
                // attempt at anything, so it succeeds and changes nothing.
                if (existing === index)
                {
                    return true;
                }
                fail(WIN32_ERROR.INVALID_PIXEL_FORMAT);
                return false;
            }
            formats.set(drawable.key, index);
            return true;
        },

        /**
         * @param {number} hdc
         * @returns {number} the index, or zero. The failure code is the pixel
         *          format one even when the handle is what was wrong.
         */
        GetPixelFormat(hdc){
            const drawable = gdi.describeDrawable(hdc);
            const index = drawable ? formats.get(drawable.key) : undefined;
            if (index === undefined)
            {
                fail(WIN32_ERROR.INVALID_PIXEL_FORMAT);
                return 0;
            }
            return index;
        },

        // --- contexts ---

        /** @param {number} hdc @returns {any | null} */
        wglCreateContext(hdc){
            const drawable = gdi.describeDrawable(hdc);
            if (!drawable)
            {
                fail(WIN32_ERROR.INVALID_HANDLE);
                return null;
            }
            const index = formats.get(drawable.key);
            if (index === undefined)
            {
                fail(WIN32_ERROR.INVALID_PIXEL_FORMAT);
                return null;
            }
            const format = PIXEL_FORMATS[index - 1];
            // The WGL extensions are looked up here and reported through
            // their own string; the GL string names only GL extensions, and
            // not the hidden ones, which stay obtainable but unannounced.
            const context = createGlContext({
                extensions: Object.keys(extensions).filter(name=>!name.startsWith('WGL_')
                    && !HIDDEN_GL_EXTENSIONS.has(name)),
                memory: contextMemory,
                divergence: options.divergence,
                gpu: options.gpu,
                raster: options.raster,
                keepPrimitives: options.keepPrimitives,
            });
            live.set(context, {
                key: drawable.key,
                formatIndex: index,
                doubleBuffered: (format.dwFlags & PFD.DOUBLEBUFFER) !== 0,
                depthBits: format.cDepthBits,
            });
            return context;
        },

        /** @param {any} context @returns {boolean} */
        wglDeleteContext(context){
            if (!context || !live.has(context))
            {
                fail(WIN32_ERROR.INVALID_HANDLE);
                return false;
            }
            const holder = holderOf(context);
            if (holder !== null && holder !== options.currentThread())
            {
                fail(WIN32_ERROR.BUSY);
                return false;
            }
            if (holder !== null)
            {
                // Deletion releases it here and now, rather than waiting for
                // the thread to drop it.
                current.delete(holder);
            }
            live.delete(context);
            context.destroy();
            return true;
        },

        /**
         * @param {number} hdc
         * @param {any | null} context
         * @returns {boolean}
         */
        wglMakeCurrent(hdc, context){
            const thread = options.currentThread();
            const drawable = gdi.describeDrawable(hdc);
            if (!context)
            {
                if (drawable)
                {
                    current.delete(thread);
                    return true;
                }
                // A null DC is an invalid handle, so releasing through it only
                // works when there was something to release.
                if (current.has(thread))
                {
                    current.delete(thread);
                    return true;
                }
                fail(WIN32_ERROR.INVALID_HANDLE);
                return false;
            }
            const record = live.get(context);
            if (!record || !drawable)
            {
                fail(WIN32_ERROR.INVALID_HANDLE);
                return false;
            }
            // The DC has to carry the format the context was made for. Another
            // DC onto the same window does; one onto a different drawable that
            // happens to be set up differently does not, and letting that
            // through gives the context a framebuffer it cannot describe.
            if (formats.get(drawable.key) !== record.formatIndex)
            {
                fail(WIN32_ERROR.INVALID_PIXEL_FORMAT);
                return false;
            }
            const holder = holderOf(context);
            if (holder !== null && holder !== thread)
            {
                fail(WIN32_ERROR.BUSY);
                return false;
            }
            context.attach({
                width: drawable.width,
                height: drawable.height,
                doubleBuffered: record.doubleBuffered,
                depthBits: record.depthBits,
            });
            current.set(thread, { context, hdc });
            return true;
        },

        /** @returns {any | null} */
        wglGetCurrentContext(){
            return current.get(options.currentThread())?.context ?? null;
        },

        /** @returns {number} the DC of the last successful make-current, or zero */
        wglGetCurrentDC(){
            return current.get(options.currentThread())?.hdc ?? 0;
        },

        /**
         * @param {any} source
         * @param {any} destination
         * @returns {boolean}
         */
        wglShareLists(source, destination){
            if (!source || !destination || !live.has(source) || !live.has(destination))
            {
                fail(WIN32_ERROR.INVALID_HANDLE);
                return false;
            }
            if (source === destination)
            {
                return false;
            }
            if (destination.shareGroup.used || destination.shareGroup === source.shareGroup)
            {
                return false;
            }
            destination.adoptShareGroup(source.shareGroup);
            return true;
        },

        /**
         * @param {string} name
         * @returns {any | null} a stable pointer, or null
         */
        wglGetProcAddress(name){
            if (CORE_FUNCTIONS.has(name))
            {
                return null;
            }
            if (!current.has(options.currentThread()))
            {
                return null;
            }
            const extension = providedBy.get(name);
            if (!extension)
            {
                return null;
            }
            const existing = procAddresses.get(name);
            if (existing)
            {
                return existing;
            }
            const address = { name, extension };
            procAddresses.set(name, address);
            return address;
        },

        /** @param {number} hdc @returns {boolean} */
        SwapBuffers(hdc){
            const drawable = gdi.describeDrawable(hdc);
            if (!drawable)
            {
                fail(WIN32_ERROR.INVALID_HANDLE);
                return false;
            }
            swaps.set(drawable.key, (swaps.get(drawable.key) ?? 0) + 1);
            return true;
        },
    };

    return wgl;
}
