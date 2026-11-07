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
 *   if that vendor's extension is reported -- or if it is implemented
 *   (`unannounced`), as a driver hands out every function it has whatever it
 *   reports: the version and extension strings are the promise, the pointer
 *   is not (decision A111).
 *
 * The GDI half arrives injected. What this layer needs from a device context
 * is which drawable it names and how big it is, and nothing else -- so the
 * seam is one function, and the whole of WGL runs headless in a test.
 */

import { MAX_PBUFFER_SIZE, PFD, WGL, WIN32_ERROR } from './constants.js';
import { CORE_FUNCTIONS, createGlContext } from './context.js';
import { HIDDEN_GL_EXTENSIONS } from './extensions.js';
import { chooseContextVersion } from './version.js';
import {
    PIXEL_FORMATS, choosePixelFormat, drawsToPbuffer, writePixelFormatDescriptor,
} from './pixelformat.js';
import { createBitmapDrawables } from './wgl-bitmap.js';

/**
 * @typedef {Object} DrawableInfo
 * @property {string} key
 *           What the pixel format belongs to. A window DC names its window, so
 *           that every DC for that window shares one format; a memory DC names
 *           itself, so that its format outlives the bitmap it was set with.
 * @property {number} [window]  The window a window DC draws on; zero or absent for
 *           any other.
 * @property {number} width
 * @property {number} height
 * @property {boolean} [memory]  A memory DC: its pixels are the selected bitmap's.
 */

/** The first pbuffer handle: past every context handle and DC there is. */
const PBUFFER_BASE = 0x7e000000;
/** The first DC numbered here for a pbuffer when no GDI makes one. */
const OWN_DC_BASE = 0x7f000002;
/** WGL_ARB_render_texture's texture formats and targets, none among them. */
const TEXTURE_FORMATS = new Set(/** @type {number[]} */ ([WGL.NO_TEXTURE_ARB, WGL.TEXTURE_RGB_ARB,
    WGL.TEXTURE_RGBA_ARB]));
const TEXTURE_TARGETS = new Set(/** @type {number[]} */ ([WGL.NO_TEXTURE_ARB, WGL.TEXTURE_1D_ARB,
    WGL.TEXTURE_2D_ARB, WGL.TEXTURE_CUBE_MAP_ARB]));

/**
 * @typedef {Object} Pbuffer
 * @property {number} format  its one-based pixel format
 * @property {number} width @property {number} height
 * @property {number} textureFormat  WGL_TEXTURE_RGB_ARB, _RGBA_ARB or WGL_NO_TEXTURE_ARB
 * @property {number} textureTarget  WGL_TEXTURE_1D_ARB, _2D_ARB, _CUBE_MAP_ARB or none
 * @property {number} mipmap  1 when it was asked to have its mipmaps
 * @property {number} level @property {number} face
 * @property {number} dc  its DC once one was asked for, zero before
 * @property {number} bound  the buffer bound as a texture (WGL_FRONT_LEFT_ARB...), zero for none
 */

/**
 * @typedef {Object} WglGdi
 * @property {(hdc: number) => DrawableInfo | null} describeDrawable
 *           Null for a handle that is not a device context at all.
 * @property {(hdc: number) => import('./wgl-bitmap.js').BitmapSurface | null} [bitmapSurface]
 *           The bitmap a memory DC has selected, and its pixels.
 * @property {(width: number, height: number) => number} [createPbufferDc]
 *           A DC of a pbuffer of this size, which `describeDrawable` then names;
 *           absent, the pbuffers' DCs are numbered and described here
 * @property {(hdc: number) => void} [deleteDc]  a pbuffer's DC, gone with it
 */

/**
 * @typedef {Object} WglOptions
 * @property {WglGdi} gdi
 * @property {() => number} currentThread
 * @property {(code: number) => void} [setLastError]
 *           Where the guest's last-error slot lives. A mirror is kept here
 *           either way, so a test never needs one.
 * @property {(name: string) => boolean} [unannounced]  whether a function of a
 *           version or extension not reported is implemented, and so obtainable
 * @property {Readonly<Record<string, readonly string[]>>} [extensions]
 *           Extension name -> the functions it adds. What is not in here is
 *           not reported and is not obtainable, which is the honest answer.
 * @property {{ readMemory: (address: number, length: number) => Uint8Array,
 *              windowMemory?: (address: number, length: number) => Uint8Array,
 *              writeMemory: (address: number, bytes: Uint8Array) => void,
 *              allocate?: (bytes: number) => number,
 *              free?: (address: number) => void }} [memory]
 *           DescribePixelFormat writes through it when given an address, and
 *           every context made here reads its pixels and arrays through it.
 * @property {(detail: string, severity?: 'loss') => void} [divergence]
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
 * @property {(options: { extensions: string[], processor?: boolean,
 *     version?: import('./version.js').ContextVersion }) => any} [createContext]
 *           Makes a context in place of this module, which then hands it none of
 *           the above but the extensions: a root's (`root.js`), whose memory and
 *           renderer are its own.
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

    /**
     * WGL_ARB_pbuffer's pbuffers, by handle (`PBUFFER_BASE` on, a number no
     * other WGL object has), each with its DC once one was asked for.
     *
     * @type {Map<number, Pbuffer>}
     */
    const pbuffers = new Map();
    let nextPbuffer = PBUFFER_BASE;
    /** The pbuffers' DCs numbered here, with no GDI behind this. @type {Map<number, DrawableInfo>} */
    const ownDcs = new Map();
    let nextOwnDc = OWN_DC_BASE;
    /** @param {number} hdc @returns {DrawableInfo | null} */
    const describe = hdc=>ownDcs.get(hdc >>> 0) ?? gdi.describeDrawable(hdc);
    /** @type {Map<string, number>} drawable key -> how many times it was presented */
    const swaps = new Map();

    /**
     * `size` for a context on a memory DC: the bitmap's selected when it was
     * made, which it keeps whatever is selected later.
     *
     * @type {Map<any, { key: string, formatIndex: number, doubleBuffered: boolean,
     *                   depthBits: number, size: { width: number, height: number } | null,
     *                   colorBits: number, depth: number }>}
     */
    const live = new Map();
    const bitmaps = createBitmapDrawables({
        bitmapSurface: hdc=>gdi.bitmapSurface?.(hdc) ?? null,
    });

    /** @type {import('./kernel.js').ContextMemory | undefined} */
    const contextMemory = options.memory
        ? {
            read: options.memory.readMemory,
            window: options.memory.windowMemory,
            write: options.memory.writeMemory,
            allocate: options.memory.allocate,
            free: options.memory.free,
        }
        : undefined;

    /** @type {Map<number, { context: any, hdc: number, readHdc: number }>} thread -> what it holds */
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
            const drawable = describe(hdc);
            return drawable ? (swaps.get(drawable.key) ?? 0) : 0;
        },

        // --- pixel formats ---

        /**
         * @param {number} hdc
         * @param {import('./pixelformat.js').PixelFormat} request
         * @returns {number} the one-based index, or zero
         */
        ChoosePixelFormat(hdc, request){
            if (!describe(hdc))
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
            if (!describe(hdc))
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
            const drawable = describe(hdc);
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
            const drawable = describe(hdc);
            const index = drawable ? formats.get(drawable.key) : undefined;
            if (index === undefined)
            {
                fail(WIN32_ERROR.INVALID_PIXEL_FORMAT);
                return 0;
            }
            return index;
        },

        // --- contexts ---

        /**
         * @param {number} hdc
         * @param {import('./version.js').ContextVersion} [version]  what
         *     wglCreateContextAttribsARB chose; wglCreateContext's otherwise
         * @returns {any | null}
         */
        wglCreateContext(hdc, version){
            const drawable = describe(hdc);
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
            const contextExtensions = Object.keys(extensions).filter(name=>!name.startsWith('WGL_')
                && !name.startsWith('GL_VERSION_') && !HIDDEN_GL_EXTENSIONS.has(name));
            // A memory DC's is the generic renderer's context: it draws on the
            // processor, into a buffer the bitmap meets (`wgl-bitmap.js`).
            const processor = drawable.memory === true;
            const context = options.createContext
                ? options.createContext({ extensions: contextExtensions, processor, version })
                : createGlContext({
                    extensions: contextExtensions,
                    version,
                    memory: contextMemory,
                    divergence: options.divergence,
                    gpu: processor ? undefined : options.gpu,
                    raster: options.raster,
                    keepPrimitives: options.keepPrimitives,
                });
            live.set(context, {
                key: drawable.key,
                formatIndex: index,
                doubleBuffered: (format.dwFlags & PFD.DOUBLEBUFFER) !== 0,
                depthBits: format.cDepthBits,
                size: processor ? { width: drawable.width, height: drawable.height } : null,
                colorBits: format.cColorBits,
                depth: processor ? bitmaps.depthAt(hdc) : format.cColorBits,
            });
            return context;
        },

        /**
         * WGL_ARB_create_context: a context of the version, profile and flags
         * the attributes ask for, sharing the objects of `share` if one is
         * given. An HDC that is no drawable fails as wglCreateContext's does;
         * a share context that is none, with ERROR_INVALID_OPERATION.
         *
         * @param {number} hdc
         * @param {any | null | undefined} share  null for none; undefined for
         *     a handle that names no context
         * @param {readonly number[]} attributes  name and value pairs
         * @returns {any | null}
         */
        wglCreateContextAttribsARB(hdc, share, attributes){
            if (!describe(hdc))
            {
                fail(WIN32_ERROR.INVALID_HANDLE);
                return null;
            }
            if (share === undefined || (share !== null && !live.has(share)))
            {
                fail(WIN32_ERROR.INVALID_OPERATION);
                return null;
            }
            const chosen = chooseContextVersion(attributes);
            if ('error' in chosen)
            {
                fail(chosen.error);
                return null;
            }
            const context = wgl.wglCreateContext(hdc, chosen.version);
            if (context && share)
            {
                context.shareLists(share);
            }
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
            context.flushDevice?.();
            context.destroy();
            return true;
        },

        /**
         * wglMakeCurrent, and WGL_ARB_make_current_read's
         * wglMakeContextCurrentARB, whose second DC is the one the default
         * framebuffer is read from: it carries the context's format too.
         *
         * @param {number} hdc
         * @param {any | null} context
         * @param {number} [readHdc]  the DC read from; `hdc` unless given
         * @returns {boolean}
         */
        wglMakeCurrent(hdc, context, readHdc = hdc){
            const thread = options.currentThread();
            const drawable = describe(hdc);
            const readDrawable = readHdc === hdc ? drawable : describe(readHdc);
            if (!context)
            {
                if (drawable)
                {
                    current.get(thread)?.context.flushDevice?.();
                    current.delete(thread);
                    return true;
                }
                // A null DC is an invalid handle, so releasing through it only
                // works when there was something to release.
                if (current.has(thread))
                {
                    current.get(thread)?.context.flushDevice?.();
                    current.delete(thread);
                    return true;
                }
                fail(WIN32_ERROR.INVALID_HANDLE);
                return false;
            }
            const record = live.get(context);
            if (!record || !drawable || !readDrawable)
            {
                fail(WIN32_ERROR.INVALID_HANDLE);
                return false;
            }
            // The DC has to carry the format the context was made for. Another
            // DC onto the same window does; one onto a different drawable that
            // happens to be set up differently does not, and letting that
            // through gives the context a framebuffer it cannot describe.
            if (formats.get(drawable.key) !== record.formatIndex
                || formats.get(readDrawable.key) !== record.formatIndex)
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
                width: record.size?.width ?? drawable.width,
                height: record.size?.height ?? drawable.height,
                doubleBuffered: record.doubleBuffered,
                depthBits: record.depthBits,
                // A window's buffers are the window's (`gpu.js` attach); a
                // bitmap's context draws on the processor, into its own.
                key: record.size ? undefined : drawable.key,
                read: readDrawable === drawable || record.size ? null
                    : { width: readDrawable.width, height: readDrawable.height,
                        key: readDrawable.key },
            });
            // The context left is flushed, as wglMakeCurrent does before it
            // switches.
            const left = current.get(thread)?.context;
            if (left && left !== context)
            {
                left.flushDevice?.();
            }
            current.set(thread, { context, hdc, readHdc });
            if (record.size)
            {
                bitmaps.made(context, hdc, record);
            }
            return true;
        },

        /**
         * glFlush, glFinish and glReadPixels on a context over a memory DC:
         * its buffer and the bitmap selected now meet (`wgl-bitmap.js`).
         * Nothing for any other.
         *
         * @param {any} context
         */
        meetBitmap(context){
            bitmaps.meet(context);
        },

        /**
         * The attribute groups of `mask` copied from one context to another,
         * as glPushAttrib saves and glPopAttrib restores them. The source may
         * be current anywhere; a destination current on any thread is
         * ERROR_INVALID_HANDLE (Wine's opengl32 test_copy_context).
         *
         * @param {any} source @param {any} destination @param {number} mask
         * @returns {boolean}
         */
        wglCopyContext(source, destination, mask){
            if (!source || !destination || !live.has(source) || !live.has(destination)
                || holderOf(destination) !== null)
            {
                fail(WIN32_ERROR.INVALID_HANDLE);
                return false;
            }
            destination.pasteAttribs(source.copyAttribs(mask >>> 0));
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

        /** @returns {number} the DC the current context reads from, or zero */
        wglGetCurrentReadDCARB(){
            return current.get(options.currentThread())?.readHdc ?? 0;
        },

        // --- WGL_ARB_pbuffer ---

        /**
         * A pbuffer of `format` and this size: an off-screen drawable OpenGL
         * draws on the device. `attributes` are WGL_PBUFFER_LARGEST_ARB and
         * WGL_ARB_render_texture's texture format, target and mipmap flag.
         *
         * @param {number} hdc @param {number} format @param {number} width
         * @param {number} height @param {readonly number[]} attributes  name and value pairs
         * @returns {number} its handle, or zero
         */
        wglCreatePbufferARB(hdc, format, width, height, attributes){
            if (!describe(hdc))
            {
                fail(WIN32_ERROR.INVALID_HANDLE);
                return 0;
            }
            const described = PIXEL_FORMATS[format - 1];
            if (!described || !drawsToPbuffer(described))
            {
                fail(WIN32_ERROR.INVALID_PIXEL_FORMAT);
                return 0;
            }
            if (width <= 0 || height <= 0)
            {
                fail(WIN32_ERROR.INVALID_DATA);
                return 0;
            }
            let largest = false;
            let textureFormat = /** @type {number} */ (WGL.NO_TEXTURE_ARB);
            let textureTarget = /** @type {number} */ (WGL.NO_TEXTURE_ARB);
            let mipmap = 0;
            for (let at = 0; at + 1 < attributes.length; at += 2)
            {
                const value = attributes[at + 1];
                switch (attributes[at])
                {
                    case WGL.PBUFFER_LARGEST_ARB: largest = value !== 0; break;
                    case WGL.TEXTURE_FORMAT_ARB: textureFormat = value; break;
                    case WGL.TEXTURE_TARGET_ARB: textureTarget = value; break;
                    case WGL.MIPMAP_TEXTURE_ARB: mipmap = value !== 0 ? 1 : 0; break;
                    default:
                        fail(WIN32_ERROR.INVALID_DATA);
                        return 0;
                }
            }
            if (!TEXTURE_FORMATS.has(textureFormat) || !TEXTURE_TARGETS.has(textureTarget))
            {
                fail(WIN32_ERROR.INVALID_DATA);
                return 0;
            }
            // Past the largest, only for a program that said it takes the largest.
            if ((width > MAX_PBUFFER_SIZE || height > MAX_PBUFFER_SIZE) && !largest)
            {
                fail(WIN32_ERROR.NO_SYSTEM_RESOURCES);
                return 0;
            }
            const handle = nextPbuffer++;
            pbuffers.set(handle, { format, width: Math.min(width, MAX_PBUFFER_SIZE),
                height: Math.min(height, MAX_PBUFFER_SIZE), textureFormat, textureTarget,
                mipmap, level: 0, face: WGL.TEXTURE_CUBE_MAP_POSITIVE_X_ARB, dc: 0,
                bound: 0 });
            return handle;
        },

        /**
         * The pbuffer's DC: the same one every time, until the pbuffer goes.
         *
         * @param {number} handle @returns {number}
         */
        wglGetPbufferDCARB(handle){
            const pbuffer = pbuffers.get(handle);
            if (!pbuffer)
            {
                fail(WIN32_ERROR.INVALID_HANDLE);
                return 0;
            }
            if (pbuffer.dc === 0)
            {
                const { width, height } = pbuffer;
                if (gdi.createPbufferDc)
                {
                    pbuffer.dc = gdi.createPbufferDc(width, height);
                }
                else
                {
                    pbuffer.dc = nextOwnDc;
                    nextOwnDc += 4;
                    ownDcs.set(pbuffer.dc, { key: `pbuffer:${pbuffer.dc}`, window: 0, width,
                        height, memory: false });
                }
                const drawable = describe(pbuffer.dc);
                if (drawable)
                {
                    formats.set(drawable.key, pbuffer.format);
                }
            }
            return pbuffer.dc;
        },

        /**
         * Done with the DC: one that is not the pbuffer's is ERROR_DC_NOT_FOUND.
         * The DC stays the pbuffer's and is handed out again, as the drivers
         * Wine's test measured keep it.
         *
         * @param {number} handle @param {number} hdc @returns {boolean}
         */
        wglReleasePbufferDCARB(handle, hdc){
            const pbuffer = pbuffers.get(handle);
            if (!pbuffer)
            {
                fail(WIN32_ERROR.INVALID_HANDLE);
                return false;
            }
            if (pbuffer.dc === 0 || pbuffer.dc !== (hdc >>> 0))
            {
                fail(WIN32_ERROR.DC_NOT_FOUND);
                return false;
            }
            return true;
        },

        /** @param {number} handle @returns {boolean} */
        wglDestroyPbufferARB(handle){
            const pbuffer = pbuffers.get(handle);
            if (!pbuffer)
            {
                fail(WIN32_ERROR.INVALID_HANDLE);
                return false;
            }
            if (pbuffer.dc !== 0)
            {
                const drawable = describe(pbuffer.dc);
                if (drawable)
                {
                    formats.delete(drawable.key);
                }
                if (!ownDcs.delete(pbuffer.dc))
                {
                    gdi.deleteDc?.(pbuffer.dc);
                }
            }
            pbuffers.delete(handle);
            return true;
        },

        /**
         * @param {number} handle @param {number} attribute
         * @returns {number | null} the value, or null with the error set
         */
        wglQueryPbufferARB(handle, attribute){
            const pbuffer = pbuffers.get(handle);
            if (!pbuffer)
            {
                fail(WIN32_ERROR.INVALID_HANDLE);
                return null;
            }
            switch (attribute)
            {
                case WGL.PBUFFER_WIDTH_ARB: return pbuffer.width;
                case WGL.PBUFFER_HEIGHT_ARB: return pbuffer.height;
                // A device here never loses one.
                case WGL.PBUFFER_LOST_ARB: return 0;
                case WGL.TEXTURE_FORMAT_ARB: return pbuffer.textureFormat;
                case WGL.TEXTURE_TARGET_ARB: return pbuffer.textureTarget;
                case WGL.MIPMAP_TEXTURE_ARB: return pbuffer.mipmap;
                case WGL.MIPMAP_LEVEL_ARB: return pbuffer.level;
                case WGL.CUBE_MAP_FACE_ARB: return pbuffer.face;
                default:
                    fail(WIN32_ERROR.INVALID_DATA);
                    return null;
            }
        },

        /**
         * WGL_ARB_render_texture's level and face to draw: taken only where they
         * change nothing, as the drivers Wine's test measured answer; any
         * other attribute is none to set.
         *
         * @param {number} handle @param {readonly number[]} attributes  name and value pairs
         * @returns {boolean}
         */
        wglSetPbufferAttribARB(handle, attributes){
            const pbuffer = pbuffers.get(handle);
            if (!pbuffer)
            {
                fail(WIN32_ERROR.INVALID_HANDLE);
                return false;
            }
            for (let at = 0; at + 1 < attributes.length; at += 2)
            {
                const name = attributes[at];
                const value = attributes[at + 1];
                const same = (name === WGL.MIPMAP_LEVEL_ARB && value === pbuffer.level)
                    || (name === WGL.CUBE_MAP_FACE_ARB && value === pbuffer.face);
                if (!same)
                {
                    fail(WIN32_ERROR.INVALID_DATA);
                    return false;
                }
            }
            return true;
        },

        /**
         * A pbuffer by its handle, for WGL_ARB_render_texture's binds, which
         * the current context carries out; null for none.
         *
         * @param {number} handle @returns {Pbuffer | null}
         */
        pbufferOf: handle=>pbuffers.get(handle) ?? null,

        /**
         * The drawable a pbuffer's DC names, for a bind to read: null before
         * the pbuffer has one.
         *
         * @param {Pbuffer} pbuffer @returns {DrawableInfo | null}
         */
        pbufferDrawable: pbuffer=>(pbuffer.dc === 0 ? null : describe(pbuffer.dc)),

        /** @param {number} error */
        fail: error=>fail(error),

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
            // Two contexts already sharing share again (Wine's opengl32
            // test_sharelists: both joined a third first).
            if (destination.shareGroup === source.shareGroup)
            {
                return true;
            }
            if (destination.shareGroup.used)
            {
                return false;
            }
            destination.shareLists(source);
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
            const held = current.get(options.currentThread());
            if (!held)
            {
                return null;
            }
            const extension = providedBy.get(name)
                ?? (options.unannounced?.(name) ? 'unannounced' : undefined);
            if (!extension)
            {
                return null;
            }
            // The generic renderer of a memory DC is no driver's: it has no
            // WGL extensions (Wine's opengl32 test_bitmap_rendering).
            if (extension.startsWith('WGL_') && live.get(held.context)?.size)
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
            const drawable = describe(hdc);
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
