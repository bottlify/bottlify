/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The libraries a program links against to reach any of this.
 *
 * Every drawing API in this layer is unreachable without these: a program does
 * not construct a Direct3D object, it calls `Direct3DCreate8` in `d3d8.dll` and
 * is handed one. So these tables are shaped exactly like a win32 library's --
 * `{ Name: { argBytes, handler } }` -- and the caller assembling the process
 * binds them the same way, with no special case for graphics.
 *
 * The COM entry points are thin by design. Each makes one object and publishes
 * one interface; everything a program does afterwards goes through the vtable
 * rather than through here, which is why this file is short and `d3d8.js` is
 * not.
 *
 * OpenGL has no COM at all -- its entry points are flat C functions, several
 * hundred of them -- so its table is built from the argument-size list that
 * `opengl/exports.js` keeps rather than written out here.
 */

import { ARGUMENT_WORDS } from '../opengl/exports.js';
import { createPublisher } from './com.js';
import { createDirect3D8Seam } from './d3d8.js';
import { createDirect3D9Seam } from './d3d9.js';
import { createDirect3D10Seam } from './d3d10.js';
import { createVulkanSeam } from './vulkan.js';
import { createDirectDrawSeam, readGuid } from './ddraw.js';
import { createDirect3D7Seam } from './d3d7.js';
import { createLegacyDirect3DSeam } from './d3dlegacy.js';
import { IID_IDirectDraw7, IID_IDirectDrawClipper } from './iids.js';
import { createFields } from './structs.js';

const DD_OK = 0;
/** DDERR_INVALIDPARAMS. */
const DDERR_INVALIDPARAMS = 0x80070057 | 0;
const CLASS_E_NOAGGREGATION = 0x80040110 | 0;
/** E_OUTOFMEMORY, which is what a create that cannot make an object reports. */
const E_OUTOFMEMORY = 0x8007000e | 0;

/**
 * Every entry point in one place.
 *
 * @param {Object} deps
 * @param {any} deps.graphics   The graphics api: create(name), available().
 * @param {any} deps.memory     readMemory/writeMemory.
 * @param {(object: any, interfaceId: string) => number} deps.publishInterface
 * @param {() => any} deps.screen
 * @param {import('./ddraw.js').SurfaceDcServices} [deps.gdi]
 *        How a DirectDraw surface gets a device context GDI can draw through.
 * @param {(surface: import('./ddraw.js').PresentedSurface, window?: number,
 *     exclusive?: boolean) => void} [deps.present]
 *        Told whenever the DirectDraw primary surface may have changed.
 * @param {any} [deps.publisher]
 *        The publisher to share, for a caller that needs the way back from a
 *        pointer to the object; one is made otherwise.
 * @param {(call: { entry: number, args: number[], thread?: any })
 *          => Promise<number>} [deps.callGuest]
 * @param {() => any} [deps.currentThread]
 *        The bridge's way into guest code, which the DirectDraw enumerations need.
 * @param {{ allocate: (bytes: number) => number }} [deps.scratch]
 *        Guest memory for what a callback is shown.
 * @param {() => import('../d3d7/device.js').RenderServices} [deps.render]
 *        What a Direct3D 7 device draws with, reached when one is first made.
 * @param {(bytes: number) => number} [deps.allocate]
 * @param {(bytes: number) => number} [deps.allocateCode]  pages of their own for the guest
 *        code a seam writes, where a store beside it cannot invalidate it
 *        Guest memory for the state a program sets without crossing into the host.
 * @param {(address: number) => void} [deps.free]
 *        And the way to give it back, for a map a program has finished with.
 * @param {(name: string) => number} [deps.exportAddress]
 *        The guest address of one of OPENGL32's own exports, which is what
 *        wglGetProcAddress answers for a core name.
 * @param {(api: string, detail: string) => void} [deps.divergence]
 * @param {(cursor: import('./d3d8.js').CursorNotice) => void} [deps.cursor]
 * @param {(width: number, height: number,
 *          where?: { window?: number, fullscreen?: boolean, announce?: boolean },
 *          ) => void} [deps.resolution]
 * @param {(window: number) => { width: number, height: number } | null}
 *     [deps.windowClientSize]
 *        A window's client area, which is the size a back buffer asked for as
 *        zero by zero takes.
 * @param {() => number} [deps.now]
 *        The clock the display's raster runs on, in milliseconds; the host's
 *        when none is given.
 * @param {(ms: number, run: () => void) => void} [deps.schedule]
 *        How a wait for the vertical blank is woken; a host timer when none is
 *        given.
 * @returns {{ libraries: Record<string, Record<string, any>>,
 *             opengl: { pixelFormat: { size: () => number, count: () => number,
 *                                      choose: (bytes: Uint8Array) => number,
 *                                      describe: (index: number, bytes: number) =>
 *                                          Uint8Array | null,
 *                                      set: (hdc: number, index: number) => boolean,
 *                                      get: (hdc: number) => number },
 *                       swapBuffers: (hdc: number) => boolean,
 *                       entry: (name: string) => ((args: number[]) => number) | null },
 *             diagnostics: () => any,
 *             shadow: () => any }}
 */
export function createGraphicsLibraries(
    { graphics, memory, publishInterface, screen, gdi, present, publisher: shared, callGuest,
        free, exportAddress,
        currentThread,
        scratch, render, allocate, allocateCode, divergence, cursor, resolution, windowClientSize,
        now = ()=>performance.now(), schedule = (ms, run)=>{
            setTimeout(run, ms);
        } },
)
{
    const publisher = shared ?? createPublisher({ publishInterface });
    const fields = createFields(memory);
    const d3d8 = createDirect3D8Seam({
        publisher, memory, screen, allocate, allocateCode, divergence, cursor, resolution,
        windowClientSize, now,
        identity: ()=>graphics.adapter?.() ?? null,
    });
    const d3d9 = createDirect3D9Seam({
        publisher, memory, screen, divergence, cursor, resolution, windowClientSize, gdi, now,
        identity: ()=>graphics.adapter?.() ?? null,
    });
    const d3d10 = createDirect3D10Seam({
        publisher, memory, allocate, free,
        deviceOptions: ()=>graphics.create('d3d10'),
        factoryOptions: { windowClientSize: ()=>screen() },
    });
    const vulkan = createVulkanSeam({ graphics, memory, divergence, resolution });
    const d3d7 = createDirect3D7Seam({
        publisher, memory, render, callGuest, currentThread, scratch,
    });
    const d3dLegacy = createLegacyDirect3DSeam({
        publisher, memory, d3d7: d3d7.shared, callGuest, currentThread, scratch,
        // A first-generation device is asked of a surface, whose object the
        // DirectDraw seam knows; that seam is made next, beside these tables.
        ownerOf: surface=>ddraw.ownerOf(surface),
    });
    const ddraw = createDirectDrawSeam({
        publisher, memory, screen, gdi, present, callGuest, currentThread, scratch, now, schedule,
        extraInterfaces: [d3d7.interface, ...d3dLegacy.interfaces],
        extraSurfaceInterfaces: d3dLegacy.surfaceInterfaces,
        identity: ()=>graphics.adapter?.() ?? null,
    });

    /** What a program has actually asked us to make, for a report. */
    /** @type {string[]} */
    const created = [];

    /**
     * A DirectDraw object of one generation, published as that generation.
     *
     * @param {1 | 2 | 4 | 7} version
     * @param {number} out
     */
    const createDirectDrawInto = (version, out)=>{
        if ((out >>> 0) === 0)
        {
            return DDERR_INVALIDPARAMS;
        }
        const object = graphics.create('ddraw', ddraw.rootOptions(version));
        if (!object)
        {
            fields.writeU32(out >>> 0, 0);
            return E_OUTOFMEMORY;
        }
        created.push('ddraw');
        fields.writeU32(out >>> 0, ddraw.publishRoot(object, version));
        return DD_OK;
    };

    /**
     * OPENGL32's table, forwarding into a runtime that is not built until a
     * program calls one of these.
     *
     * Every export is bound, including the ones nothing implements yet: these
     * are stdcall, so an unbound name gets a stub that cleans the wrong number
     * of bytes off the caller's stack and the program dies far from the call.
     * The sizes come from `ARGUMENT_WORDS`, which is the one place they are
     * written down.
     */
    /** @type {any} */
    let opengl = null;
    const openglRuntime = ()=>{
        if (!opengl)
        {
            opengl = graphics.create('opengl', { scratch, present, exportAddress, divergence });
            created.push('opengl');
        }
        return opengl;
    };

    /** @type {Record<string, any>} */
    const openglTable = {};
    for (const [words, names] of Object.entries(ARGUMENT_WORDS))
    {
        for (const name of names)
        {
            openglTable[name] = {
                argBytes: Number(words) * 4,
                // GL reports through glGetError and touches nothing of
                // Win32's; only the wgl half of this library is a Windows
                // API and may set the thread's last error.
                ...(name.startsWith('gl') ? { lastError: false } : {}),
                /** @param {number[]} args */
                handler: args=>openglRuntime().table[name].handler(args),
            };
        }
    }

    const libraries = {
        'OPENGL32.dll': openglTable,

        'D3D8.dll': {
            /**
             * IDirect3D8* Direct3DCreate8(UINT SDKVersion)
             *
             * The only entry point in the library, and the odd one out among
             * these: it returns the interface pointer rather than writing it
             * through an out-parameter, and reports failure as null.
             */
            Direct3DCreate8: {
                argBytes: 4,
                handler: ()=>{
                    const root = graphics.create('d3d8');
                    if (!root)
                    {
                        return 0;
                    }
                    created.push('d3d8');
                    return d3d8.publishRoot(root);
                },
            },
        },

        'D3D9.dll': {
            /** IDirect3D9* Direct3DCreate9(UINT SDKVersion) */
            Direct3DCreate9: {
                argBytes: 4,
                handler: ()=>{
                    const root = graphics.create('d3d9');
                    if (!root)
                    {
                        return 0;
                    }
                    created.push('d3d9');
                    return d3d9.publishRoot(root);
                },
            },

            /** HRESULT Direct3DCreate9Ex(UINT SDKVersion, IDirect3D9Ex **out) */
            Direct3DCreate9Ex: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([, out])=>{
                    const root = graphics.create('d3d9');
                    if (root)
                    {
                        created.push('d3d9');
                    }
                    return d3d9.publishRootEx(root, out);
                },
            },
        },

        ...d3d10.libraries,

        'vulkan-1.dll': vulkan.library,

        'DDRAW.dll': {
            /**
             * HRESULT DirectDrawCreate(GUID*, LPDIRECTDRAW*, IUnknown*)
             *
             * The original entry point hands back the original interface; a
             * program that wants a newer one queries for it, and the counts
             * of the two are then separate, as the object model says.
             */
            DirectDrawCreate: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([, out, outer])=>((outer >>> 0) !== 0
                    ? CLASS_E_NOAGGREGATION
                    : createDirectDrawInto(1, out)),
            },

            /**
             * HRESULT DirectDrawCreateEx(GUID*, LPVOID*, REFIID, IUnknown*)
             *
             * The identifier the caller passes is which interface it wants, and
             * DirectDraw refuses anything but IDirectDraw7 here -- the whole
             * point of the Ex form is that it is the modern one.
             */
            DirectDrawCreateEx: {
                argBytes: 16,
                /** @param {number[]} args */
                handler: ([, out, riid, outer])=>{
                    if ((outer >>> 0) !== 0)
                    {
                        return CLASS_E_NOAGGREGATION;
                    }
                    if ((riid >>> 0) === 0 || readGuid(memory, riid) !== IID_IDirectDraw7)
                    {
                        return DDERR_INVALIDPARAMS;
                    }
                    return createDirectDrawInto(7, out);
                },
            },

            /**
             * HRESULT DirectDrawEnumerateA(LPDDENUMCALLBACKA, LPVOID), its Ex
             * form with flags and a monitor, and the two wide forms. Each
             * calls back into guest code once per device, so the answer is a
             * promise the bridge parks the caller on.
             */
            DirectDrawEnumerateA: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([callback, context])=>ddraw.enumerate.ansi(callback, context),
            },
            DirectDrawEnumerateExA: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([callback, context, flags])=>
                    ddraw.enumerate.ansiEx(callback, context, flags),
            },
            DirectDrawEnumerateW: {
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([callback])=>ddraw.enumerate.wide(callback),
            },
            DirectDrawEnumerateExW: { argBytes: 12, handler: ()=>ddraw.enumerate.wideEx() },

            /**
             * HRESULT DirectDrawCreateClipper(DWORD, LPDIRECTDRAWCLIPPER*, IUnknown*)
             *
             * A clipper with no ddraw object behind it, which the object model
             * allows: one is made on a ddraw object nothing else will see, and
             * takes no reference on it.
             */
            DirectDrawCreateClipper: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([flags, out, outer])=>{
                    if ((out >>> 0) === 0)
                    {
                        return DDERR_INVALIDPARAMS;
                    }
                    const object = graphics.create('ddraw', ddraw.rootOptions(7));
                    const made = object.createClipper(flags >>> 0, { outer: outer >>> 0 });
                    if (made.hr !== DD_OK)
                    {
                        return made.hr;
                    }
                    fields.writeU32(out >>> 0, publisher.publish(
                        made.clipper, ddraw.interfaces.clipper, IID_IDirectDrawClipper));
                    return DD_OK;
                },
            },
        },
    };

    return {
        libraries,

        /**
         * The half of OpenGL that gdi32 owns the entry points for.
         *
         * Through the same memoised runtime the OPENGL32 table uses: on Windows
         * choosing a format through GDI and creating a context through WGL is
         * one negotiation, and a second runtime here would give a program a
         * format from one list and a context from another.
         */
        opengl: {
            pixelFormat: {
                size: ()=>openglRuntime().pixelFormat.size(),
                count: ()=>openglRuntime().pixelFormat.count(),
                /** @param {Uint8Array} bytes */
                choose: bytes=>openglRuntime().pixelFormat.choose(bytes),
                /** @param {number} index @param {number} bytes */
                describe: (index, bytes)=>openglRuntime().pixelFormat.describe(index, bytes),
                /** @param {number} hdc @param {number} index */
                set: (hdc, index)=>openglRuntime().pixelFormat.set(hdc, index),
                /** @param {number} hdc */
                get: hdc=>openglRuntime().pixelFormat.get(hdc),
            },
            /** @param {number} hdc */
            swapBuffers: hdc=>openglRuntime().swapBuffers(hdc),
            /**
             * A named entry point for a caller already on this side of the
             * boundary (a bundle's site kernel): the handler the trap table
             * binds, on the one runtime, so a kernel's calls land in the
             * same context the program's own do.
             *
             * @param {string} name
             * @returns {((args: number[]) => number) | null}
             */
            entry: name=>openglRuntime().entry(name),
        },

        diagnostics: ()=>({
            created: [...created],
            interfaces: publisher.count(),
            // The device's own counters. Nothing else reaches the renderer, so
            // without this a run says which libraries a program opened and
            // nothing at all about what it drew through them. The OpenGL
            // runtime joins the answer when it is the one that drew: its
            // renderer is made lazily, so it is asked only if it exists.
            device: d3d8.diagnostics() ?? d3d9.diagnostics()
                ?? (opengl ? opengl.diagnostics().gpu : null),
            // Every compressed block the program handed OpenGL, as a digest.
            compressedTextures: opengl ? opengl.diagnostics().compressed : null,
            imageDigests: opengl ? opengl.diagnostics().images : [],
            keptImages: opengl ? opengl.diagnostics().kept : [],
            imageTimes: opengl ? opengl.diagnostics().imageTimes : [],
            vulkan: vulkan.diagnostics(),
        }),

        /**
         * What the guest set without crossing, and how much of it. Flat, so a
         * report prints it beside the crossings it stands in for.
         */
        shadow: ()=>d3d8.shadow(),
    };
}
