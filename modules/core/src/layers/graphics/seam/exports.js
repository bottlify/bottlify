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
import { createGlu } from '../glu/exports.js';
import { createComObject } from '../../win32/ole32/objects.js';
import { createCountCells, createPublisher } from './com.js';
import { createDirect3D8Seam } from './d3d8.js';
import { createDirect3D9Seam } from './d3d9.js';
import { createDirect3D10Seam } from './d3d10.js';
import { createVulkanSeam } from './vulkan.js';
import { createDirectDrawSeam, readGuid } from './ddraw.js';
import { refreshOf } from '../../win32/user32/display.js';
import { createDirect3D7Seam } from './d3d7.js';
import { createLegacyDirect3DSeam } from './d3dlegacy.js';
import { IID_IDirectDraw7, IID_IDirectDrawClipper } from './iids.js';
import { createFields, D3DCAPS8 } from './structs.js';
import { GL_COMMANDS } from '../opengl/commands.js';
import { commandCode } from './shadow.js';

const DD_OK = 0;
/** DDERR_INVALIDPARAMS. */
const DDERR_INVALIDPARAMS = 0x80070057 | 0;
const CLASS_E_NOAGGREGATION = 0x80040110 | 0;
const S_OK = 0;
const E_FAIL = 0x80004005 | 0;
/**
 * The shader validator's class and interface, both ours: Windows publishes no
 * identifier for either.
 */
const SHADER_VALIDATOR = '{6c4b1bd5-2f36-4b9e-9a41-3d0b7f1e8c27}';
/**
 * gdi32's half of OpenGL in a bottle without OpenGL: the answers of a machine
 * with no OpenGL driver -- no pixel format, none set, no swap.
 */
const NO_OPENGL = Object.freeze({
    pixelFormat: Object.freeze({
        size: ()=>0, count: ()=>0, choose: ()=>0, describe: ()=>null, set: ()=>false, get: ()=>0,
    }),
    swapBuffers: ()=>false,
    entry: ()=>null,
});
/** The shader versions Direct3D 8 validates: vs_1_0-1_1 and ps_1_0-1_4. */
const VERTEX_SHADER_VERSIONS = [0xfffe0100, 0xfffe0101];
const PIXEL_SHADER_VERSIONS = [0xffff0100, 0xffff0101, 0xffff0102, 0xffff0103, 0xffff0104];
/** A shader's end token and comment opcode, a declaration's end, and a read of past them. */
const SHADER_END = 0x0000ffff;
const SHADER_COMMENT = 0xfffe;
const DECLARATION_END = 0xffffffff;
const SHADER_TOKEN_CAP = 0x10000;
/** D3DSPR_INPUT and D3DSPR_CONST, a parameter's register types. */
const REGISTER_INPUT = 1;
const REGISTER_CONSTANT = 2;
/** E_OUTOFMEMORY, which is what a create that cannot make an object reports. */
const E_OUTOFMEMORY = 0x8007000e | 0;

/**
 * Every entry point in one place.
 *
 * @param {Object} deps
 * @param {any} deps.graphics   The graphics api: create(name), available().
 * @param {readonly string[]} [deps.only]  The libraries this bottle has
 *        (`choice.js`); every library when absent. The others are neither in
 *        the table nor built.
 * @param {any} deps.memory     readMemory/writeMemory.
 * @param {(object: any, interfaceId: string) => number} deps.publishInterface
 * @param {(object: any, interfaceId: string) => boolean} [deps.unpublishInterface]
 *        The bridge's way to give back an interface the program has no
 *        Release for.
 * @param {() => any} deps.screen
 * @param {import('./ddraw.js').SurfaceDcServices} [deps.gdi]
 *        How a DirectDraw surface gets a device context GDI can draw through.
 * @param {(surface: import('./ddraw.js').PresentedSurface, window?: number,
 *     exclusive?: boolean) => void} [deps.present]
 *        Told whenever the DirectDraw primary surface may have changed.
 * @param {() => Promise<void> | null} [deps.flipQueued]
 *        A flip queued a frame of the primary: what the call waits on before
 *        it answers, or null (`webgpu/internal/latency.js`).
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
 *        Guest memory for the state a program sets without crossing into the host.
 * @param {(bytes: number, unbroken?: boolean) => number} [deps.allocateCode]  pages of
 *        their own for the guest code a seam writes, where a store beside it cannot
 *        invalidate it, and which no slice ends inside unless `unbroken` is false
 * @param {(address: number) => void} [deps.free]
 *        And the way to give it back, for a map a program has finished with.
 * @param {(bytes: number) => number} [deps.processHeapAllocate]
 *        A block of the process heap, for what a program frees with HeapFree.
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
 * @param {import('../webgpu/internal/presenter.js').DisplayGamma} [deps.gamma]
 *        The display's gamma ramp, which a DirectDraw primary's sets. The
 *        Direct3D 8 and 9 devices reach it through the objects `graphics`
 *        makes, which carry it from the layer.
 * @param {() => boolean} [deps.deactivated]
 *        Whether the application has been told it is not the active one,
 *        which is when a DirectDraw object loses exclusive mode.
 * @param {() => number} [deps.deactivations]
 *        How many times it has been, each of which loses an exclusive
 *        owner's video memory.
 * @param {() => number} [deps.now]
 *        The clock the display's raster runs on, in milliseconds; the host's
 *        when none is given.
 * @param {() => number} [deps.refresh]
 *        The display's rate, in hertz: what its raster and a beat-synced
 *        Present run at and its current mode reports. REFRESH_HZ when none
 *        is given.
 * @param {() => void} [deps.presented]  Told of every frame a Direct3D 8 or 9 device presents.
 * @param {(deadline: number, result: number) => any} [deps.waitUntil]
 *        Stops the calling thread until that time of `now`'s clock, where its
 *        call answers `result`: how a Direct3D 8 or 9 Present waits for the
 *        blank. Absent, a Present answers at once.
 * @param {(ms: number, run: () => void) => void} [deps.schedule]
 *        How a wait for the vertical blank is woken; a host timer when none is
 *        given.
 * @param {number} [deps.ringBytes]  A device's command ring's size (`shadow.js`).
 * @param {import('./shadow.js').ShadowPhases} [deps.phases]
 *        Where a Direct3D 8 or 9 device's entry work is timed (`shadow.js` `sync`).
 * @param {boolean} [deps.guestCode]
 *        Whether Direct3D 8 and 9 answer and record in the guest -- the state
 *        block, the command ring, the getters and the counts -- or trap every
 *        call; on unless false.
 * @param {string[]} [deps.guestTraps]
 *        With guest code on, the parts of it kept as traps all the same: methods
 *        by name, or the groups `getters`, `ring`, `locks`, `levels` and
 *        `counts`, and `moves`, a buffer's DISCARD under draws that the lock
 *        would answer by moving it onto a spare storage -- for finding which
 *        part a fault is in.
 * @returns {{ libraries: Record<string, Record<string, any>>,
 *             opengl: { pixelFormat: { size: () => number, count: () => number,
 *                                      choose: (bytes: Uint8Array) => number,
 *                                      describe: (index: number, bytes: number) =>
 *                                          Uint8Array | null,
 *                                      set: (hdc: number, index: number) => boolean,
 *                                      get: (hdc: number) => number },
 *                       swapBuffers: (hdc: number) => boolean | Promise<boolean>,
 *                       entry: (name: string) => ((args: number[]) => number) | null },
 *             diagnostics: () => any,
 *             shadow: () => any }}
 */
export function createGraphicsLibraries(
    { graphics, only, memory, publishInterface, unpublishInterface, screen, gdi, present,
        flipQueued, publisher: shared, callGuest,
        free, exportAddress, processHeapAllocate,
        currentThread,
        scratch, render, allocate, allocateCode, divergence, cursor, resolution, windowClientSize,
        gamma, deactivated, deactivations, now = ()=>performance.now(), waitUntil, presented,
        refresh = ()=>refreshOf(screen()), guestCode = true, phases, ringBytes,
        guestTraps = [],
        schedule = (ms, run)=>{
            setTimeout(run, ms);
        } },
)
{
    const publisher = shared ?? createPublisher({
        publishInterface, unpublishInterface,
        cells: guestCode && !guestTraps.includes('counts') && allocate && memory?.readU32
            && memory.writeU32
            ? createCountCells({ allocate, memory }) : undefined,
    });
    const fields = createFields(memory);

    /**
     * What a Direct3D 8 shader is judged on: a version Direct3D 8 knows and
     * the caps, when given, run; for a vertex shader, constants within the
     * caps' count and inputs its declaration, when given, maps. The answer's
     * reason, or null when it is valid.
     *
     * @param {number} code @param {number} caps @param {number} declaration
     * @param {{ versions: number[], capsVersion: number, capsConstants?: number }} kind
     * @returns {string | null}
     */
    const shaderFault = (code, caps, declaration, kind)=>{
        if ((code >>> 0) === 0)
        {
            return 'No shader was given.';
        }
        const version = fields.readU32(code >>> 0) >>> 0;
        if (!kind.versions.includes(version))
        {
            return `Shader version ${version.toString(16)} is not valid.`;
        }
        if ((caps >>> 0) !== 0
            && (version & 0xffff) > (fields.readU32((caps >>> 0) + kind.capsVersion) & 0xffff))
        {
            return 'The shader version is higher than the device supports.';
        }
        // Every parameter token has its top bit set, an instruction token and
        // the end token do not; a comment is skipped by its length.
        let highestConstant = -1;
        /** @type {Set<number>} */
        const inputs = new Set();
        for (let at = (code >>> 0) + 4, count = 0; count < SHADER_TOKEN_CAP; at += 4, count++)
        {
            const token = fields.readU32(at) >>> 0;
            if (token === SHADER_END)
            {
                break;
            }
            if ((token & 0xffff) === SHADER_COMMENT && (token & 0x80000000) === 0)
            {
                at += (token >>> 16 & 0x7fff) * 4;
                continue;
            }
            if ((token & 0x80000000) === 0)
            {
                continue;
            }
            const type = (token >>> 28 & 7) | (token >>> 8 & 0x18);
            if (type === REGISTER_INPUT)
            {
                inputs.add(token & 0x7ff);
            }
            else if (type === REGISTER_CONSTANT)
            {
                highestConstant = Math.max(highestConstant, token & 0x7ff);
            }
        }
        if ((caps >>> 0) !== 0 && kind.capsConstants !== undefined
            && highestConstant >= fields.readU32((caps >>> 0) + kind.capsConstants))
        {
            return 'The shader uses more constants than the device has.';
        }
        if ((declaration >>> 0) !== 0)
        {
            /** @type {Set<number>} */
            const declared = new Set();
            for (let at = declaration >>> 0, count = 0; count < SHADER_TOKEN_CAP; at += 4, count++)
            {
                const token = fields.readU32(at) >>> 0;
                if (token === DECLARATION_END)
                {
                    break;
                }
                // D3DVSD_REG: a stream datum that is not a skip.
                if ((token >>> 29) === 2 && (token & 0x10000000) === 0)
                {
                    declared.add(token & 0x1f);
                }
            }
            if ([...inputs].some(register=>!declared.has(register)))
            {
                return 'The shader reads an input its declaration does not map.';
            }
        }
        return null;
    };

    /**
     * The answer of either Validate call. The messages are a string of the
     * process heap, which the program frees: empty unless the shader is
     * invalid and they were asked for.
     *
     * @param {string | null} fault @param {number} errorReturn @param {number} errors
     */
    const validated = (fault, errorReturn, errors)=>{
        if ((errors >>> 0) !== 0)
        {
            const text = fault !== null && errorReturn !== 0 ? fault : '';
            const block = processHeapAllocate?.(text.length + 1) ?? 0;
            if (block !== 0)
            {
                memory.writeMemory(block,
                    Uint8Array.from([...text].map(c=>c.charCodeAt(0)).concat(0)));
            }
            fields.writeU32(errors >>> 0, block);
        }
        return fault === null ? S_OK : E_FAIL;
    };
    /** @param {string} library */
    const has = library=>!only || only.includes(library);
    /**
     * What `make` builds, when the bottle has `library`; null otherwise, typed
     * as built because every handler that reaches it leaves with the library.
     *
     * @template T
     * @param {string} library @param {() => T} make
     * @returns {T}
     */
    function built(library, make){
        return has(library) ? make() : /** @type {T} */ (/** @type {unknown} */ (null));
    }
    // Without guest code, Direct3D 8 and 9 keep no block, ring or getters in
    // the guest: every call is a trap, which is what a regression in them is
    // told apart by.
    const guestAllocate = guestCode ? allocate : undefined;
    const guestAllocateCode = guestCode ? allocateCode : undefined;
    const d3d8 = built('D3D8.dll', ()=>createDirect3D8Seam({
        publisher, memory, screen, allocate: guestAllocate, allocateCode: guestAllocateCode,
        traps: new Set(guestTraps), divergence, cursor, resolution, ringBytes,
        windowClientSize, now, waitUntil, presented, refresh, phases,
        identity: ()=>graphics.adapter?.() ?? null,
    }));
    const d3d9 = built('D3D9.dll', ()=>createDirect3D9Seam({
        publisher, memory, screen, divergence, cursor, resolution, windowClientSize, gdi, now,
        waitUntil, presented, refresh, phases, allocate: guestAllocate,
        allocateCode: guestAllocateCode,
        traps: new Set(guestTraps), ringBytes,
        identity: ()=>graphics.adapter?.() ?? null,
    }));
    const d3d10 = built('D3D10.dll', ()=>createDirect3D10Seam({
        publisher, memory, allocate, free, screen, resolution, gdi,
        identity: ()=>graphics.adapter?.() ?? null,
        videoMemory: ()=>graphics.videoMemory?.() ?? null,
        deviceOptions: ()=>graphics.create('d3d10'),
        // A back buffer asked for at zero takes the window's client area; the
        // display stands in only for a window this layer cannot measure.
        factoryOptions: { windowClientSize: window=>windowClientSize?.(window) ?? screen() },
    }));
    const vulkan = built('vulkan-1.dll',
        ()=>createVulkanSeam({ graphics, memory, divergence, resolution }));
    const d3d7 = built('DDRAW.dll', ()=>createDirect3D7Seam({
        publisher, memory, render, callGuest, currentThread, scratch, divergence,
        allocate: guestAllocate, allocateCode: guestAllocateCode, traps: new Set(guestTraps),
        ringBytes,
    }));
    const d3dLegacy = built('DDRAW.dll', ()=>createLegacyDirect3DSeam({
        publisher, memory, d3d7: d3d7.shared, callGuest, currentThread, scratch,
        // A first-generation device is asked of a surface, whose object the
        // DirectDraw seam knows; that seam is made next, beside these tables.
        ownerOf: surface=>ddraw.ownerOf(surface),
    }));
    const ddraw = built('DDRAW.dll', ()=>createDirectDrawSeam({
        publisher, memory, screen, gdi, present, flipQueued, callGuest, currentThread, scratch,
        aroundCall: call=>d3d7.aroundDevices(call),
        now, schedule, refresh,
        extraInterfaces: [d3d7.interface, ...d3dLegacy.interfaces],
        extraSurfaceInterfaces: d3dLegacy.surfaceInterfaces,
        identity: ()=>graphics.adapter?.() ?? null,
        videoMemory: ()=>graphics.videoMemory?.() ?? null,
        divergence,
        gamma,
        deactivated,
        deactivations,
        resolution,
    }));

    /** What a program has actually asked us to make, for a report. */
    /** @type {string[]} */
    const created = [];

    /** How deep the profiler events D3DPERF_BeginEvent opened are nested. */
    let perfLevel = 0;

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
            // Resolved at the first call, not looked up by name on every one:
            // the runtime's table is fixed once it is built.
            /** @type {((args: number[]) => number) | null} */
            let resolved = null;
            openglTable[name] = {
                argBytes: Number(words) * 4,
                // GL reports through glGetError and touches nothing of
                // Win32's; only the wgl half of this library is a Windows
                // API and may set the thread's last error.
                ...(name.startsWith('gl') ? { lastError: false } : {}),
                /** @param {number[]} args */
                handler: args=>(resolved ??= openglRuntime().table[name].handler)(args),
            };
        }
    }
    // The calls the command ring carries are routines that write them into
    // the ring of the calling thread's context (`opengl/commands.js`),
    // falling back on the same handler when it has none or no room. They run
    // unbroken: another thread's entry into the host may read what they write.
    for (const [name, shape] of Object.entries(GL_COMMANDS.COMMANDS))
    {
        const entry = openglTable[name];
        Object.assign(entry, {
            unbroken: true,
            /** @param {import('../../win32/msvcrt/guest-code.js').CodeBuilder} builder */
            code: builder=>{
                const trap = builder.register({ convention: 'stdcall', argBytes: entry.argBytes,
                    lastError: false, handler: entry.handler });
                const code = commandCode(0, 0,
                    { ...shape, slot: GL_COMMANDS.commandSlot(name), thread: true });
                builder.jump(code.length - 4, trap);
                return code;
            },
        });
    }

    const table = {
        'OPENGL32.dll': openglTable,

        // After OPENGL32, so that where its exports are placed is known when
        // GLU32's code, which calls them, is placed.
        'GLU32.dll': has('GLU32.dll') && createGlu({
            memory,
            exportAddress,
            withContext: body=>openglRuntime().withContext(body),
            allocate,
            free,
            callGuest,
            currentThread,
            divergence,
        }),

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

            /**
             * HRESULT ValidateVertexShader(const DWORD *code, const DWORD *declaration,
             *                              const D3DCAPS8 *caps, BOOL errorReturn,
             *                              char **errors)
             *
             * Judged as `shaderFault` says; an errors pointer is handed a
             * string of the process heap for the program to free.
             */
            ValidateVertexShader: {
                argBytes: 20,
                /** @param {number[]} args */
                handler: ([code, declaration, caps, errorReturn, errors])=>validated(
                    shaderFault(code, caps, declaration, {
                        versions: VERTEX_SHADER_VERSIONS,
                        capsVersion: D3DCAPS8.VertexShaderVersion,
                        capsConstants: D3DCAPS8.MaxVertexShaderConst,
                    }), errorReturn, errors),
            },

            /**
             * HRESULT ValidatePixelShader(const DWORD *code, const D3DCAPS8 *caps,
             *                             BOOL errorReturn, char **errors)
             */
            ValidatePixelShader: {
                argBytes: 16,
                /** @param {number[]} args */
                handler: ([code, caps, errorReturn, errors])=>validated(
                    shaderFault(code, caps, 0, {
                        versions: PIXEL_SHADER_VERSIONS,
                        capsVersion: D3DCAPS8.PixelShaderVersion,
                    }), errorReturn, errors),
            },

            /**
             * void DebugSetMute(void)
             *
             * Silences the debug runtime's output; the retail runtime exports
             * it as a call that does nothing, and nothing here prints.
             */
            DebugSetMute: { argBytes: 0, handler: ()=>0 },
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

            /**
             * IDirect3DShaderValidator9 *Direct3DShaderValidatorCreate9(void)
             *
             * The validator a shader assembler drives a token stream through:
             * Begin, Instruction and End answer S_OK, judging nothing, but an
             * instruction of no tokens fails. Windows names no interface
             * identifier for it, so nothing can query its way to it.
             */
            Direct3DShaderValidatorCreate9: {
                argBytes: 0,
                handler: ()=>publishInterface(createComObject(SHADER_VALIDATOR, {
                    interfaces: [{
                        id: SHADER_VALIDATOR,
                        methods: [
                            { name: 'Begin', argBytes: 16, invoke: ()=>S_OK },
                            {
                                name: 'Instruction',
                                argBytes: 20,
                                invoke: (/** @type {any} */ _, /** @type {number[]} */ args)=>
                                    ((args[3] >>> 0) === 0 ? E_FAIL : S_OK),
                            },
                            { name: 'End', argBytes: 4, invoke: ()=>S_OK },
                        ],
                    }],
                }), SHADER_VALIDATOR),
            },

            /**
             * void DebugSetMute(void)
             *
             * Silences the debug runtime's output, which this build does not
             * print: D3DX asks for it by name around its locks.
             */
            DebugSetMute: { argBytes: 0, handler: ()=>0 },

            /**
             * int D3DPERF_BeginEvent(D3DCOLOR col, LPCWSTR wszName)
             * int D3DPERF_EndEvent(void)
             *
             * The profiler's nested events, which a program built with PIX
             * markers imports and calls whether a profiler is attached or not:
             * BeginEvent answers the zero-based level the event starts at,
             * EndEvent the level it ends, negative for one never begun.
             */
            D3DPERF_BeginEvent: {
                argBytes: 8,
                handler: ()=>perfLevel++,
            },
            D3DPERF_EndEvent: {
                argBytes: 0,
                handler: ()=>(perfLevel > 0 ? --perfLevel : -1),
            },

            /**
             * DWORD D3DPERF_GetStatus(void)
             * BOOL D3DPERF_QueryRepeatFrame(void)
             * void D3DPERF_SetMarker(D3DCOLOR col, LPCWSTR wszName)
             * void D3DPERF_SetOptions(DWORD dwOptions)
             * void D3DPERF_SetRegion(D3DCOLOR col, LPCWSTR wszName)
             *
             * No profiler is attached, and none asks for a frame again.
             */
            D3DPERF_GetStatus: { argBytes: 0, handler: ()=>0 },
            D3DPERF_QueryRepeatFrame: { argBytes: 0, handler: ()=>0 },
            D3DPERF_SetMarker: { argBytes: 8, handler: ()=>0 },
            D3DPERF_SetOptions: { argBytes: 4, handler: ()=>0 },
            D3DPERF_SetRegion: { argBytes: 8, handler: ()=>0 },

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

        ...d3d10?.libraries,

        'vulkan-1.dll': vulkan?.library,

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

            /** HRESULT DllGetClassObject(REFCLSID, REFIID, LPVOID *ppv) */
            DllGetClassObject: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([clsid, riid, out])=>ddraw.classObject(clsid, riid, out,
                    version=>{
                        const root = graphics.create('ddraw', ddraw.rootOptions(version));
                        if (root)
                        {
                            created.push('ddraw');
                        }
                        return root;
                    }),
            },
            /** HRESULT GetSurfaceFromDC(HDC, IDirectDrawSurface **, HDC *) */
            GetSurfaceFromDC: {
                argBytes: 12,
                /** @param {number[]} args */
                handler: ([hdc, out, deviceOut])=>ddraw.surfaceFromDc(hdc, out, deviceOut),
            },
            /** HRESULT DllCanUnloadNow(void), which COM asks for. */
            DllCanUnloadNow: { argBytes: 0, handler: ()=>S_OK },

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
    // The bottle's libraries alone: one it lacks is absent as a missing file
    // is, and nothing behind it was built.
    const libraries = /** @type {Record<string, Record<string, any>>} */ (Object.fromEntries(
        Object.entries(table).filter(([name, exports])=>exports && has(name))));

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
        opengl: has('OPENGL32.dll') ? {
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
        } : NO_OPENGL,

        diagnostics: ()=>({
            created: [...created],
            interfaces: publisher.count(),
            // The device's own counters. Nothing else reaches the renderer, so
            // without this a run says which libraries a program opened and
            // nothing at all about what it drew through them. The OpenGL
            // runtime joins the answer when it is the one that drew: its
            // renderer is made lazily, so it is asked only if it exists.
            device: d3d8?.diagnostics() ?? d3d9?.diagnostics() ?? d3d7?.diagnostics()
                ?? (opengl ? opengl.diagnostics().gpu : null),
            // Every compressed block the program handed OpenGL, as a digest.
            compressedTextures: opengl ? opengl.diagnostics().compressed : null,
            imageDigests: opengl ? opengl.diagnostics().images : [],
            keptImages: opengl ? opengl.diagnostics().kept : [],
            imageTimes: opengl ? opengl.diagnostics().imageTimes : [],
            // OpenGL calls the command ring carried past the bridge.
            openglCommandCalls: opengl ? opengl.diagnostics().commandCalls : 0,
            // Of the host time OpenGL's entry points took, what playing the
            // ring before each cost and what the calls themselves did.
            openglRingMs: opengl ? opengl.diagnostics().ringMs : 0,
            openglCallMs: opengl ? opengl.diagnostics().callMs : 0,
            vulkan: vulkan?.diagnostics() ?? null,
            // How the Presents of the version that presented were paced.
            presentPacing: [d3d9?.presentPacing(), d3d8?.presentPacing()]
                .find(pacing=>pacing && pacing.presents > 0) ?? null,
        }),

        /**
         * What the guest set without crossing, and how much of it. Flat, so a
         * report prints it beside the crossings it stands in for.
         */
        shadow: ()=>d3d9?.shadow() ?? d3d8?.shadow() ?? null,
    };
}
