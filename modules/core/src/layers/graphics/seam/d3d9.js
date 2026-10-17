/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 9, between a guest call and the object that implements it.
 *
 * Everything here is translation and nothing is behaviour: a slot reads the
 * arguments the guest pushed, turns pointers into structures and interface
 * pointers into objects, calls the method that already exists in `d3d9/`, and
 * writes back whatever the caller left room for. A slot with no method in the
 * tables below answers E_NOTIMPL, which a program handles; a slot that answers
 * a failure code rather than doing what was asked is making the same point
 * more loudly, and says so where it stands.
 *
 * Out-parameters are where this is easy to get wrong in a way nothing reports.
 * A method that hands back an interface writes a pointer *and* takes a
 * reference; one that hands back a number writes it only if the caller passed
 * somewhere to put it. Both are done here rather than in the API objects,
 * because both are facts about the ABI rather than about Direct3D.
 *
 * Two things this version's ABI does that 8's did not, and that decide the
 * shape of several slots: nearly every create ends in a shared-handle pointer
 * that has to be null, and a handful of methods return something other than
 * an HRESULT -- a count, a boolean, a float -- which the caller reads as that.
 */

import { IDIRECT3D9_SLOTS, describe } from './vtables.js';
import { fpuSetupCode } from './fpu.js';
import {
    D3DBOX, D3DDISPLAYMODE, D3DLIGHT7, D3DLOCKED_BOX, lockRectInto, D3DPRESENT_PARAMETERS9,
    POINT, RECT, createFields, createLightReader, dwordsOf, floatsOf, intsOf, putLight, putMaterial,
} from './structs.js';
import {
    IDIRECT3DBASETEXTURE9_SLOTS, IDIRECT3DCUBETEXTURE9_SLOTS, IDIRECT3DDEVICE9_SLOTS,
    IDIRECT3DINDEXBUFFER9_SLOTS, IDIRECT3DQUERY9_SLOTS, IDIRECT3DRESOURCE9_SLOTS,
    IDIRECT3DSHADER9_SLOTS, IDIRECT3DSTATEBLOCK9_SLOTS,
    IDIRECT3DSURFACE9_SLOTS, IDIRECT3DSWAPCHAIN9_SLOTS, IDIRECT3DTEXTURE9_SLOTS,
    IDIRECT3DVERTEXBUFFER9_SLOTS, IDIRECT3DVERTEXDECLARATION9_SLOTS, IDIRECT3DVOLUME9_SLOTS,
    IDIRECT3DVOLUMETEXTURE9_SLOTS, IID_IDirect3D9, IID_IDirect3DVolume9,
    IID_IDirect3DVolumeTexture9, IDIRECT3D9EX_SLOTS, IDIRECT3DDEVICE9EX_SLOTS,
    IDIRECT3DSWAPCHAIN9EX_SLOTS, IID_IDirect3D9Ex, IID_IDirect3DDevice9Ex,
    IID_IDirect3DSwapChain9Ex,
    IID_IDirect3DBaseTexture9, IID_IDirect3DCubeTexture9, IID_IDirect3DDevice9,
    IID_IDirect3DIndexBuffer9, IID_IDirect3DResource9,
    IID_IDirect3DPixelShader9, IID_IDirect3DQuery9, IID_IDirect3DStateBlock9,
    IID_IDirect3DSurface9, IID_IDirect3DSwapChain9, IID_IDirect3DTexture9,
    IID_IDirect3DVertexBuffer9, IID_IDirect3DVertexDeclaration9, IID_IDirect3DVertexShader9,
} from '../d3d9/interfaces.js';
import {
    D3DADAPTER_IDENTIFIER9, D3DCAPS9, D3DCAPS9_FLOATS, D3DCLIPSTATUS9, D3DDECL_END_STREAM,
    D3DDISPLAYMODEEX, D3DDISPLAYMODEFILTER,
    D3DINDEXBUFFER_DESC9, D3DSURFACE_DESC9, D3DVERTEXBUFFER_DESC9, D3DVERTEXELEMENT9,
    D3DVIEWPORT9, D3DVOLUME_DESC9,
} from '../d3d9/structs.js';
import {
    ADAPTER_STRING_LENGTH, D3DDEVICE_CREATION_PARAMETERS, D3DGAMMARAMP, D3DRASTER_STATUS,
    GAMMA_RAMP_ENTRIES,
} from '../d3d8/structs.js';
import { D3DFMT_INDEX, D3DFMT, D3DPOOL, D3DRTYPE, PRIMARY_MONITOR } from '../d3d8/constants.js';
import { vertexCountOf } from '../d3d8/render.js';
import { createCursorTeller } from './cursor.js';
import { ADAPTER_GUID, describeAdapter } from './adapter.js';
import { capabilityWords } from '../d3d9/caps.js';
import { D3DCREATE, D3DDEVTYPE, PALETTE_BYTES } from '../d3d9/device.js';
import { MAX_DECLARATION_LENGTH } from '../d3d9/declaration.js';
import { END_TOKEN } from '../d3d9/shader.js';
import { REFRESH_HZ, displayModes, refreshRatesOf } from '../../win32/user32/display.js';
import { createPresentQueue, createRaster, rasterStatus } from './raster.js';
import { queryAs, readGuid } from './guid.js';
import { D3D_PRIVATE_DATA, createPrivateData } from './privatedata.js';
import {
    DRAWABLE_MIRRORS, RENDER_STATE_MIRROR, SAMPLER_STATE_MIRROR, TRANSFORM_MIRROR,
    DEPTH_STENCIL_MIRROR, RENDER_TARGET_MIRROR, VIEWPORT_GUARD_9, VIEWPORT_MIRROR, commandCode,
    STRETCH_GUARD, compiledAt, createShadow, getRenderStateCode,
    getSamplerStateCode, getSurfaceDescCode, getSurfaceLevelCode, getTextureStageStateCode,
    getTransformCode, getViewportCode, lockCode, settledAfter, stageStateMirror,
    unlockCode, HOST_MIRRORS, QUERY, appendCommand, guestWords,
} from './shadow.js';
import { COMPILED as IN_GUEST } from './inguest.x86.js';
import { D3DTSS9 } from '../d3d9/samplerstates.js';
import { COMMANDS, commandObjects, commandSlot } from '../d3d9/commands.js';
import { loudRefusals } from './refusals.js';


/** Direct3D 9's stage state types below 32, a bit each: what the guest routine takes. */
const STAGE_STATE_TYPES_9 = Object.values(D3DTSS9)
    .reduce((mask, type)=>(type < 32 ? mask | (1 << type) : mask), 0) >>> 0;

/**
 * What the command routines keep in the block beside the record (`shadow.js`):
 * the values the getters in the guest read, and the state the routines of
 * later calls check theirs against -- a viewport's own checks first.
 *
 * @type {Record<string, any[]>}
 */
export const COMMAND_MIRRORS = {
    SetRenderState: [...RENDER_STATE_MIRROR],
    SetTransform: [...TRANSFORM_MIRROR],
    SetTextureStageState: stageStateMirror(STAGE_STATE_TYPES_9),
    SetViewport: [...VIEWPORT_GUARD_9, ...VIEWPORT_MIRROR],
    SetSamplerState: [...SAMPLER_STATE_MIRROR],
    BeginScene: [...DRAWABLE_MIRRORS.BeginScene],
    EndScene: [...DRAWABLE_MIRRORS.EndScene],
    SetFVF: [...DRAWABLE_MIRRORS.SetFVF],
    SetVertexDeclaration: [...DRAWABLE_MIRRORS.SetVertexDeclaration],
    SetStreamSource: [...DRAWABLE_MIRRORS.SetStreamSource9],
    SetIndices: [...DRAWABLE_MIRRORS.SetIndices],
    DrawPrimitiveUP: [...DRAWABLE_MIRRORS.DrawPrimitiveUP],
    SetRenderTarget: [...RENDER_TARGET_MIRROR],
    SetDepthStencilSurface: [...DEPTH_STENCIL_MIRROR],
    StretchRect: [...STRETCH_GUARD],
};

/**
 * The same mirrors as the host keeps them (`HOST_MIRRORS`), for the setters
 * whose records it writes itself (`appendCommand`); a method with a mirror
 * not here goes into the guest.
 */
export const HOST_COMMAND_MIRRORS = {
    SetRenderState: HOST_MIRRORS.renderState,
    SetTransform: HOST_MIRRORS.transform,
    SetTextureStageState: HOST_MIRRORS.stageState(STAGE_STATE_TYPES_9),
    SetViewport: HOST_MIRRORS.viewport9,
    SetSamplerState: HOST_MIRRORS.samplerState,
    BeginScene: HOST_MIRRORS.beginScene,
    EndScene: HOST_MIRRORS.endScene,
    SetFVF: HOST_MIRRORS.fvf,
    SetVertexDeclaration: HOST_MIRRORS.declaration,
    SetStreamSource: HOST_MIRRORS.streamSource9,
    SetIndices: HOST_MIRRORS.indices,
    SetRenderTarget: HOST_MIRRORS.renderTarget,
    SetDepthStencilSurface: HOST_MIRRORS.depthStencil,
    StretchRect: HOST_MIRRORS.stretch,
};

const D3D_OK = 0;
const S_FALSE = 1;
const D3DERR_INVALIDCALL = 0x8876086c | 0;
/** D3DQUERYTYPE_OCCLUSION. */
const D3DQUERYTYPE_OCCLUSION = 9;
const D3DERR_NOTAVAILABLE = 0x8876086a | 0;
const D3DSCANLINEORDERING_PROGRESSIVE = 1;
const D3DSCANLINEORDERING_INTERLACED = 2;
const D3DDISPLAYROTATION_IDENTITY = 1;
/** The adapter's LUID, low part; the high part is zero. */
const ADAPTER_LUID = 0x00000001;
const D3DERR_OUTOFVIDEOMEMORY = 0x8876017c | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
/** D3DENUM_NO_WHQL_LEVEL: skip the certification lookup, which took seconds on real Windows. */
const D3DENUM_NO_WHQL_LEVEL = 0x00000002;
/** D3DPRESENTFLAG_LOCKABLE_BACKBUFFER. */
const LOCKABLE_BACKBUFFER = 0x00000001;

/**
 * The adapter formats a display mode is listed in: 32-bit and 16-bit.
 *
 * @type {ReadonlySet<number>}
 */
const ADAPTER_FORMATS = new Set([D3DFMT.X8R8G8B8, D3DFMT.R5G6B5]);

/** The most dwords a shader read from guest memory may run to before it is given up on. */
const MAX_SHADER_DWORDS = 1 << 16;

/**
 * @param {Object} deps
 * @param {any} deps.publisher   From createPublisher.
 * @param {any} deps.memory      readMemory/writeMemory.
 * @param {() => any} deps.screen  The display this build is configured for.
 * @param {(api: string, detail: string) => void} [deps.divergence]
 * @param {(cursor: import('./d3d8.js').CursorNotice) => void} [deps.cursor]
 *     Where the program's cursor goes; without a taker the call is refused.
 * @param {(width: number, height: number,
 *          where?: { window?: number, fullscreen?: boolean, announce?: boolean },
 *          ) => void} [deps.resolution]
 *     Told the resolution a device is created or reset at, to report as the
 *     screen -- and which window it presents into, so a fullscreen one can be
 *     placed. `announce` asks that the window be told its size even if it
 *     did not change.
 * @param {() => import('./adapter.js').AdapterIdentity | null} [deps.identity]
 * @param {(window: number) => { width: number, height: number } | null} [deps.windowClientSize]
 *     The client area of a window, which is the size a back buffer asked for
 *     as zero by zero takes. Without it the configured display is the nearest
 *     size this layer knows.
 * @param {import('../d3d9/resources.js').SurfaceGdi} [deps.gdi]
 *     Device contexts over a surface's pixels, for GetDC; absent, none is handed out.
 * @param {() => number} [deps.now]  The clock the display's raster runs on, in milliseconds.
 * @param {() => number} [deps.refresh]  The display's rate, in hertz: its raster's and its
 *     current mode's. REFRESH_HZ when none is given.
 * @param {(deadline: number, result: number) => any} [deps.waitUntil]  Stops the calling
 *     thread until that time of `now`'s clock, where its call answers `result`: how a
 *     Present waits for the blank its interval names. Absent, a Present answers at once.
 * @param {Set<string>} [deps.traps]  Guest routines kept as traps, by name or group
 *     (`guestsBut`).
 * @param {(bytes: number) => number} [deps.allocate]  Guest memory, for a device's
 *     block of the state its setters write without leaving the guest.
 * @param {number} [deps.ringBytes]  A device's command ring's size (`shadow.js`).
 * @param {(bytes: number) => number} [deps.allocateCode]  Pages of their own for
 *     those setters' code.
 * @param {import('./shadow.js').ShadowPhases} [deps.phases]  Where a device's entry work is timed.
 */
export function createDirect3D9Seam(
    { publisher, memory, screen, divergence, cursor, resolution, identity,
        windowClientSize, gdi, now = ()=>performance.now(), waitUntil, refresh = ()=>REFRESH_HZ,
        allocate, allocateCode, ringBytes,
        traps = new Set(), phases },
)
{
    /** The getters a device answers in the guest, as against the calls its ring carries. */
    const GUEST_GETTERS = new Set(['GetRenderState', 'GetTransform', 'GetTextureStageState',
        'GetViewport', 'GetSamplerState']);
    /**
     * The guest routines a table offers, less those `traps` keeps as traps: by
     * method name, or by the group a routine belongs to -- `getters`, `ring`,
     * `locks`, `levels`, `queries`.
     *
     * @param {string | ((name: string) => string)} group
     * @param {Record<string, (builder: { trap: number }) => number>} guests
     * @returns {Record<string, (builder: { trap: number }) => number>}
     */
    const guestsBut = (group, guests)=>(traps.size === 0 ? guests
        : Object.fromEntries(Object.entries(guests).filter(([name])=>!traps.has(name)
            && !traps.has(typeof group === 'string' ? group : group(name)))));
    /** @param {string} name */
    const deviceGroup = name=>(GUEST_GETTERS.has(name) ? 'getters' : 'ring');
    const fields = createFields(memory);
    const privateData = createPrivateData({ memory, publisher, rules: D3D_PRIVATE_DATA });
    /**
     * The rate of the mode the device runs in: the one a full-screen device
     * asked for, when the display lists it, else the display's own. A program
     * that steps its world once a frame is paced by this rate, not by how
     * often the page shows a frame.
     */
    const modeRefresh = ()=>{
        const asked = lastParameters && !lastParameters.windowed
            ? lastParameters.fullScreenRefreshRateInHz >>> 0 : 0;
        return refreshRatesOf(screen()).includes(asked) ? asked : refresh();
    };
    const raster = createRaster({
        now, refresh: modeRefresh, height: ()=>screen().height,
    });
    const presents = createPresentQueue(raster);
    /**
     * A Present's answer, once its frame has room in the queue of frames
     * waiting for their blanks (`createPresentQueue`): Direct3D beat-syncs
     * presentation to the retrace for every interval but IMMEDIATE, and a
     * program that steps its world once a frame keeps the display's time only
     * under that queue. An answer still to come -- the device holding the call
     * while the GPU catches up -- already waited.
     *
     * @param {number | Promise<number>} hr
     * @returns {any}
     */
    const pacedPresent = hr=>{
        if (!waitUntil || typeof hr !== 'number' || hr !== D3D_OK)
        {
            return hr;
        }
        const wait = presents.present(now(), lastParameters?.presentationInterval ?? 0);
        return wait > 0 ? waitUntil(now() + wait, hr) : hr;
    };

    /**
     * The device each resource was made by, for GetDevice. Weak, so this map
     * keeps nothing alive.
     *
     * @type {WeakMap<object, any>}
     */
    const owners = new WeakMap();

    /**
     * A resource's interface, whose methods the host makes after the calls
     * the program made before them: those its device's command ring still
     * holds are made first, as the device's own methods make them (`synced`).
     * A draw in the ring that samples a texture, or reads a buffer, then
     * meets it as it was rather than as the lock about to be taken leaves it.
     *
     * @type {typeof describe}
     */
    const describeResource = (id, slots, methods, ...rest)=>describe(id, slots,
        Object.fromEntries(Object.entries(methods ?? {}).map(([name, method])=>[name,
            (/** @type {any} */ object, /** @type {number[]} */ args)=>{
                shadowOf(owners.get(object)
                    ?? (object.container ? owners.get(object.container) : undefined))?.sync();
                return method(object, args);
            }])), ...rest);

    /**
     * A create that failed leaves a null where its interface would have gone,
     * as Direct3D does.
     *
     * @param {number} out @param {number} hr
     */
    const clearAndRefuse = (out, hr)=>{
        if ((out >>> 0) !== 0)
        {
            fields.writeU32(out >>> 0, 0);
        }
        return hr;
    };

    /**
     * A resource, published as whichever interface it is, with the reference
     * the out-parameter owes taken. Publishing can fail -- guest memory for a
     * vtable is finite -- and the failure is the whole call's: the pointer
     * written is the zero the publisher answered.
     *
     * @param {any} object
     * @param {import('./com.js').InterfaceDescriptor[]} interfaces
     * @param {string} id
     * @param {number} out
     * @param {number} [failure]
     * @param {any} [owner]
     */
    const handBack = (object, interfaces, id, out, failure = E_OUTOFMEMORY, owner = null)=>{
        if (owner)
        {
            owners.set(object, owner);
            // A record in the device's ring may name it: the ring is played
            // before its count is touched on the host, which the last
            // reference's Release always is.
            object.settleGuestRefs ??= ()=>shadowOf(owner)?.sync();
            if (interfaces === surfaceInterfaces)
            {
                // Its description in a block of its own, for the guest's
                // GetDesc: nothing changes it while the surface lives.
                object.guestState ??= ()=>shadowOf(owner)?.attachSurface(object, at=>{
                    /** @type {{ desc?: any }} */
                    const held = {};
                    if (object.GetDesc(held) === D3D_OK && held.desc)
                    {
                        fields.writeStruct(at, D3DSURFACE_DESC9,
                            { ...held.desc, MultiSampleType: 0, MultiSampleQuality: 0 });
                    }
                }) ?? 0;
            }
        }
        const pointer = publisher.publish(object, interfaces, id);
        fields.writeU32(out, pointer);
        return pointer === 0 ? failure : D3D_OK;
    };

    /**
     * The window each additional swap chain presents into. The display shows
     * the device's window; a chain presenting anywhere else has its frame
     * drawn and not shown.
     *
     * @type {WeakMap<object, number>}
     */
    const chainWindows = new WeakMap();
    /** @param {any} chain @param {number} override  The window a present named, or 0. */
    const shownIn = (chain, override)=>
        ((override >>> 0) || chainWindows.get(chain) || deviceWindow) === deviceWindow;

    /**
     * Each device's block (`shadow.js`): its command ring, the buffers its
     * guest unlocked, and the render states, transforms and stage states the
     * getters in the guest read, laid out as Direct3D 8's are.
     *
     * @type {WeakMap<any, ReturnType<typeof createShadow>>}
     */
    const shadows = new WeakMap();
    /** @param {any} device */
    const shadowOf = device=>shadows.get(device) ?? null;
    /**
     * The program let go of a resource. A call in the command ring that names
     * it is made now, while its pointer still resolves; after this the pointer
     * is nobody's.
     *
     * @param {any} resource
     */
    const retire = resource=>{
        privateData.released(resource);
        shadowOf(owners.get(resource))?.sync();
    };
    /** @param {(at: number) => Uint8Array} code */
    const placeCode = code=>{
        // Sized by a throwaway rendering: the bytes depend on where they
        // land only through relative jumps, never in length.
        const at = (allocateCode ?? /** @type {(bytes: number) => number} */ (allocate))(
            code(0).length);
        memory.writeMemory(at, code(at));
        return at;
    };

    /**
     * The method that hands a resource its device: the same pointer the
     * program already holds, with the reference the call owes.
     *
     * @param {any} resource @param {number[]} args
     */
    const getDevice = (resource, [out])=>{
        const device = owners.get(resource);
        if ((out >>> 0) === 0 || !device)
        {
            return D3DERR_INVALIDCALL;
        }
        device.addRef();
        fields.writeU32(out >>> 0,
            publisher.publish(device, deviceInterfaces, IID_IDirect3DDevice9));
        return D3D_OK;
    };

    /**
     * What every resource interface answers in its first eight slots. A
     * priority is the resource's own, and only a managed one keeps it; a
     * surface has none to keep and reads back zero whatever it was told.
     *
     * @param {number} type  D3DRTYPE, or a function of the object for a texture.
     */
    const resourceMethods = (/** @type {number | ((object: any) => number)} */ type)=>({
        ...privateData.methods,
        GetDevice: getDevice,
        /** @param {any} resource @param {number[]} args */
        SetPriority: (resource, [priority])=>resource.SetPriority?.(priority >>> 0) ?? 0,
        /** @param {any} resource */
        GetPriority: resource=>resource.GetPriority?.() ?? 0,
        PreLoad: ()=>0,
        /** @param {any} object */
        GetType: object=>(typeof type === 'function' ? type(object) : type),
    });

    /** @param {number} pointer @returns {any} */
    const readRect = pointer=>((pointer >>> 0) === 0
        ? null
        : fields.readStruct(pointer >>> 0, RECT));

    /** @param {number} pointer @param {number} count @returns {Float32Array} */
    const readFloats = (pointer, count)=>{
        const read = memory.windowMemory ?? memory.readMemory;
        return floatsOf(read(pointer >>> 0, count * 4), count);
    };

    /** @param {number} pointer @param {number} count @returns {Int32Array} */
    const readInts = (pointer, count)=>{
        const read = memory.windowMemory ?? memory.readMemory;
        return intsOf(read(pointer >>> 0, count * 4), count);
    };

    /** @param {number} pointer @param {number} count @returns {Uint32Array} */
    const readDwords = (pointer, count)=>{
        const read = memory.windowMemory ?? memory.readMemory;
        return dwordsOf(read(pointer >>> 0, count * 4), count);
    };

    // An answer of several dwords is put together in the fields' own buffer
    // and written as one block, not made into an array of its own first:
    // asking a small array for its buffer moves it off the heap.
    /** @param {number} address @param {ArrayLike<number>} values */
    const writeDwords = (address, values)=>fields.writeDwords(address, values);

    /** @param {number} address @param {ArrayLike<number>} values */
    const writeFloats = (address, values)=>fields.writeFloats(address, values);

    /**
     * Bytes a drawing call reads straight out of the program's own arrays.
     * Nothing is copied when the count comes out empty or the pointer is null.
     *
     * @param {number} pointer @param {number} length @returns {Uint8Array | null}
     */
    const readArray = (pointer, length)=>((pointer >>> 0) === 0 || !(length > 0)
        ? null
        : memory.readMemory(pointer >>> 0, length));

    /** A colour in a material is four floats, and a material is four of those plus a power. */
    const readMaterial = (/** @type {number} */ pointer)=>{
        const f = readFloats(pointer, 17);
        const colour = (/** @type {number} */ at)=>(
            { r: f[at], g: f[at + 1], b: f[at + 2], a: f[at + 3] });
        return {
            Diffuse: colour(0),
            Ambient: colour(4),
            Specular: colour(8),
            Emissive: colour(12),
            Power: f[16],
        };
    };

    /** @param {number} address @param {any} material */
    const writeMaterial = (address, material)=>{
        putMaterial(fields.staged(17).floats, material);
        fields.writeStaged(address, 17);
    };

    /** D3DLIGHT9 is D3DLIGHT7's layout under this version's names. */
    const readLight = createLightReader(fields);

    /** @param {number} address @param {any} light */
    const writeLight = (address, light)=>{
        const { floats, dwords } = fields.staged(D3DLIGHT7.SIZE >>> 2);
        putLight(floats, dwords, light);
        fields.writeStaged(address, D3DLIGHT7.SIZE >>> 2);
    };

    /** @param {number} pointer */
    const readGammaRamp = pointer=>{
        const words = new Uint16Array(
            memory.readMemory(pointer, D3DGAMMARAMP.SIZE).slice().buffer);
        return {
            red: words.slice(0, GAMMA_RAMP_ENTRIES),
            green: words.slice(GAMMA_RAMP_ENTRIES, GAMMA_RAMP_ENTRIES * 2),
            blue: words.slice(GAMMA_RAMP_ENTRIES * 2),
        };
    };

    /** @param {number} address @param {any} ramp */
    const writeGammaRamp = (address, ramp)=>{
        const words = new Uint16Array(GAMMA_RAMP_ENTRIES * 3);
        words.set(ramp.red, 0);
        words.set(ramp.green, GAMMA_RAMP_ENTRIES);
        words.set(ramp.blue, GAMMA_RAMP_ENTRIES * 2);
        memory.writeMemory(address, new Uint8Array(words.buffer));
    };

    /**
     * A declaration's elements up to the sentinel, which is not returned.
     * Reading stops one past the most a declaration may hold, so a caller
     * that forgot the sentinel is refused rather than read to the end of
     * memory.
     *
     * @param {number} pointer
     * @returns {import('../d3d9/declaration.js').VertexElement[] | null}
     */
    const readElements = pointer=>{
        /** @type {import('../d3d9/declaration.js').VertexElement[]} */
        const elements = [];
        for (let index = 0; index <= MAX_DECLARATION_LENGTH; index++)
        {
            const at = (pointer >>> 0) + index * D3DVERTEXELEMENT9.SIZE;
            const bytes = memory.readMemory(at, D3DVERTEXELEMENT9.SIZE);
            const stream = bytes[0] | (bytes[1] << 8);
            if (stream === D3DDECL_END_STREAM)
            {
                return elements;
            }
            elements.push({
                Stream: stream,
                Offset: bytes[2] | (bytes[3] << 8),
                Type: bytes[4],
                Method: bytes[5],
                Usage: bytes[6],
                UsageIndex: bytes[7],
            });
        }
        return null;
    };

    /**
     * @param {number} address
     * @param {readonly import('../d3d9/declaration.js').VertexElement[]} elements
     *        Sentinel included.
     */
    const writeElements = (address, elements)=>{
        const bytes = new Uint8Array(elements.length * D3DVERTEXELEMENT9.SIZE);
        elements.forEach((element, index)=>{
            const at = index * D3DVERTEXELEMENT9.SIZE;
            bytes[at] = element.Stream & 0xff;
            bytes[at + 1] = (element.Stream >>> 8) & 0xff;
            bytes[at + 2] = element.Offset & 0xff;
            bytes[at + 3] = (element.Offset >>> 8) & 0xff;
            bytes[at + 4] = element.Type & 0xff;
            bytes[at + 5] = element.Method & 0xff;
            bytes[at + 6] = element.Usage & 0xff;
            bytes[at + 7] = element.UsageIndex & 0xff;
        });
        memory.writeMemory(address >>> 0, bytes);
    };

    /**
     * A shader's tokens, read up to its end token. The stream carries no
     * length, so it is read a page at a time and scanned for the end; a
     * comment's own length is honoured, since one may contain anything.
     *
     * @param {number} pointer
     * @returns {Uint32Array | null}
     */
    const readTokens = pointer=>{
        const page = 64;
        /** @type {number[]} */
        const tokens = [];
        let skip = 0;
        while (tokens.length < MAX_SHADER_DWORDS)
        {
            const chunk = readDwords((pointer >>> 0) + tokens.length * 4, page);
            for (const token of chunk)
            {
                tokens.push(token);
                if (skip > 0)
                {
                    skip--;
                    continue;
                }
                if (tokens.length > 1 && (token & 0xffff) === 0xfffe)
                {
                    skip = (token >>> 16) & 0x7fff;
                    continue;
                }
                if (token === END_TOKEN)
                {
                    return Uint32Array.from(tokens);
                }
            }
        }
        return null;
    };

    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const surfaceInterfaces = [describeResource(IID_IDirect3DSurface9, IDIRECT3DSURFACE9_SLOTS, {
        ...resourceMethods(D3DRTYPE.SURFACE),
        /** @param {any} surface @param {number[]} args */
        GetDesc: (surface, [out])=>{
            /** @type {{ desc?: any }} */
            const held = {};
            const hr = surface.GetDesc(held);
            if (hr === D3D_OK && (out >>> 0) !== 0 && held.desc)
            {
                fields.writeStruct(out >>> 0, D3DSURFACE_DESC9,
                    { ...held.desc, MultiSampleType: 0, MultiSampleQuality: 0 });
            }
            return hr;
        },
        /** @param {any} surface @param {number[]} args */
        LockRect: (surface, [out, rect, flags])=>lockRectInto(fields, out,
            locked=>surface.LockRect(locked, readRect(rect), flags >>> 0)),
        /** @param {any} surface */
        UnlockRect: surface=>surface.UnlockRect(),
        /** @param {any} surface @param {number[]} args */
        GetDC: (surface, [out])=>{
            if ((out >>> 0) === 0 || !gdi)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ dc?: number }} */
            const held = {};
            /** @param {number} hr */
            const answer = hr=>{
                if (hr === D3D_OK)
                {
                    fields.writeU32(out >>> 0, held.dc ?? 0);
                }
                return hr;
            };
            const hr = surface.GetDC(gdi, held);
            return hr instanceof Promise ? hr.then(answer) : answer(hr);
        },
        /** @param {any} surface @param {number[]} args */
        ReleaseDC: (surface, [dc])=>(gdi ? surface.ReleaseDC(dc >>> 0, gdi) : D3DERR_INVALIDCALL),

        /**
         * QueryInterface on what holds the surface: the texture a level
         * belongs to, the swap chain a back buffer belongs to, and the device
         * for a surface of its own (Wine's d3d9 test_surface_get_container and
         * test_refcount).
         *
         * @param {any} surface @param {number[]} args
         * @returns {number}
         */
        GetContainer: (surface, [riid, out])=>{
            if ((riid >>> 0) === 0 || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            const id = readGuid(memory, riid);
            const container = surface.container ?? null;
            if (container?.GetBackBuffer)
            {
                return queryAs(publisher, fields, container,
                    chainInterfacesOf(owners.get(surface)), id, out);
            }
            if (container)
            {
                return queryAs(publisher, fields, container, textureInterfacesFor(container), id,
                    out);
            }
            const device = owners.get(surface);
            if (!device)
            {
                return D3DERR_INVALIDCALL;
            }
            return queryAs(publisher, fields, device, deviceInterfacesOf(device), id, out);
        },
    }, guestsBut('levels', allocate
        ? { GetDesc: (/** @type {{ trap: number }} */ { trap })=>
            placeCode(at=>getSurfaceDescCode(at, trap)) }
        : {}), privateData.released)];

    /**
     * The six every texture kind shares, over the resource eight.
     *
     * @param {any} texture
     */
    const baseTextureMethods = {
        /** @param {any} texture @param {number[]} args */
        SetLOD: (texture, [lod])=>texture.SetLOD(lod >>> 0),
        /** @param {any} texture */
        GetLOD: texture=>texture.GetLOD(),
        /** @param {any} texture */
        GetLevelCount: texture=>texture.levels ?? 1,
        /** @param {any} texture @param {number[]} args */
        SetAutoGenFilterType: (texture, [filter])=>texture.SetAutoGenFilterType(filter >>> 0),
        // Answers the filter rather than an HRESULT, and GenerateMipSubLevels
        // nothing at all.
        /** @param {any} texture */
        GetAutoGenFilterType: texture=>texture.GetAutoGenFilterType(),
        /** @param {any} texture */
        GenerateMipSubLevels: texture=>{
            texture.GenerateMipSubLevels();
            return 0;
        },
    };

    /**
     * A level's description is the description of its surface, which is also
     * the only way to reach one; the reference that reaching it took is given
     * straight back.
     *
     * @param {any} texture @param {number} level @param {number} out
     */
    const writeLevelDesc = (texture, level, out)=>{
        /** @type {{ surface?: any }} */
        const held = {};
        // Every face of a cube's level has one description: the first's.
        const hr = texture.cube
            ? texture.GetCubeMapSurface(0, level, held)
            : texture.GetSurfaceLevel(level, held);
        if (hr !== D3D_OK || !held.surface)
        {
            return hr;
        }
        /** @type {{ desc?: any }} */
        const described = {};
        held.surface.GetDesc(described);
        held.surface.release();
        if ((out >>> 0) !== 0 && described.desc)
        {
            fields.writeStruct(out >>> 0, D3DSURFACE_DESC9,
                { ...described.desc, MultiSampleType: 0, MultiSampleQuality: 0 });
        }
        return D3D_OK;
    };

    const textureMethods = {
        ...resourceMethods(D3DRTYPE.TEXTURE),
        ...baseTextureMethods,
        /** @param {any} texture @param {number[]} args */
        GetLevelDesc: (texture, [level, out])=>writeLevelDesc(texture, level >>> 0, out),
        /** @param {any} texture @param {number[]} args */
        GetSurfaceLevel: (texture, [level, out])=>{
            // Refused before the level is taken: a reference taken for nowhere
            // to go would keep the texture alive after its last Release.
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = texture.GetSurfaceLevel(level >>> 0, held);
            if (hr === D3D_OK && held.surface && (out >>> 0) !== 0)
            {
                const answer = handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface9,
                    out >>> 0, E_OUTOFMEMORY, owners.get(texture));
                // Published, so the guest may hand the level out itself from
                // now on: publishing is memoised, and this is its pointer --
                // the publisher's, not read back from the program's variable,
                // which another thread may have written meanwhile.
                shadowOf(owners.get(texture))?.noteLevel(texture, level >>> 0,
                    publisher.publish(held.surface, surfaceInterfaces, IID_IDirect3DSurface9));
                return answer;
            }
            return hr;
        },
        /** @param {any} texture @param {number[]} args */
        LockRect: (texture, [level, out, rect, flags])=>lockRectInto(fields, out,
            locked=>texture.LockRect(level >>> 0, locked, readRect(rect), flags >>> 0)),
        /** @param {any} texture @param {number[]} args */
        UnlockRect: (texture, [level])=>texture.UnlockRect(level >>> 0),
        /** @param {any} texture @param {number[]} args */
        AddDirtyRect: (texture, [rect])=>texture.AddDirtyRect(readRect(rect)),
    };
    // A cube map's own methods name a face before the level.
    const cubeTextureMethods = {
        ...resourceMethods(D3DRTYPE.CUBETEXTURE),
        ...baseTextureMethods,
        GetLevelDesc: textureMethods.GetLevelDesc,
        /** @param {any} texture @param {number[]} args */
        GetCubeMapSurface: (texture, [face, level, out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = texture.GetCubeMapSurface(face >>> 0, level >>> 0, held);
            if (hr === D3D_OK && held.surface && (out >>> 0) !== 0)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface9,
                    out >>> 0, E_OUTOFMEMORY, owners.get(texture));
            }
            return hr;
        },
        /** @param {any} texture @param {number[]} args */
        LockRect: (texture, [face, level, out, rect, flags])=>lockRectInto(fields, out,
            locked=>texture.LockCubeRect(face >>> 0, level >>> 0, locked, readRect(rect),
                flags >>> 0)),
        /** @param {any} texture @param {number[]} args */
        UnlockRect: (texture, [face, level])=>texture.UnlockCubeRect(face >>> 0, level >>> 0),
        /** @param {any} texture @param {number[]} args */
        AddDirtyRect: (texture, [face, rect])=>texture.AddDirtyRect(readRect(rect), face >>> 0),
    };

    /**
     * A texture kind's own interface, and the two it derives from over the
     * same methods: their slots are the front of its own.
     *
     * @param {string} id @param {[string, number][]} slots @param {any} methods
     */
    const textureFamily = (id, slots, methods, guests = {})=>[
        describeResource(id, slots, methods, guests, retire),
        { ...describeResource(IID_IDirect3DBaseTexture9, IDIRECT3DBASETEXTURE9_SLOTS, methods),
            sharedWith: id },
        { ...describeResource(IID_IDirect3DResource9, IDIRECT3DRESOURCE9_SLOTS, methods),
            sharedWith: id },
    ];
    const textureInterfaces = textureFamily(IID_IDirect3DTexture9, IDIRECT3DTEXTURE9_SLOTS,
        textureMethods, guestsBut('levels', allocate
            ? { GetSurfaceLevel: (/** @type {{ trap: number }} */ { trap })=>
                placeCode(at=>getSurfaceLevelCode(at, trap)) }
            : {}));
    const cubeTextureInterfaces = textureFamily(IID_IDirect3DCubeTexture9,
        IDIRECT3DCUBETEXTURE9_SLOTS, cubeTextureMethods);

    /**
     * A box as the guest passed it, or null for none -- the whole volume.
     *
     * @param {number} pointer
     */
    const readBox = pointer=>{
        if ((pointer >>> 0) === 0)
        {
            return null;
        }
        const box = fields.readStruct(pointer >>> 0, D3DBOX);
        return {
            left: box.Left, top: box.Top, right: box.Right, bottom: box.Bottom,
            front: box.Front, back: box.Back,
        };
    };
    /**
     * A lock of a volume: the two pitches and the address on success, and on
     * a refusal a null address -- the pointer a program would otherwise write
     * through (Wine's d3d9 test_volume_locking).
     *
     * @param {number} out @param {(locked: any) => number} lock
     */
    const lockBox = (out, lock)=>{
        /** @type {any} */
        const locked = {};
        const hr = lock(locked);
        if ((out >>> 0) === 0)
        {
            return hr;
        }
        if (hr === D3D_OK)
        {
            fields.writeStruct(out >>> 0, D3DLOCKED_BOX, locked);
        }
        else
        {
            fields.writeU32((out >>> 0) + D3DLOCKED_BOX.pBits, 0);
        }
        return hr;
    };
    /** @param {any} volume @param {number} out */
    const writeVolumeDesc = (volume, out)=>{
        /** @type {{ desc?: any }} */
        const described = {};
        volume.GetDesc(described);
        if ((out >>> 0) !== 0 && described.desc)
        {
            fields.writeStruct(out >>> 0, D3DVOLUME_DESC9, described.desc);
        }
        return D3D_OK;
    };

    // A volume texture's level is not a resource (Wine's d3d9
    // test_volume_resource): it answers for itself and IUnknown alone, and
    // names its texture as its container (test_volume_get_container).
    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const volumeInterfaces = [describeResource(IID_IDirect3DVolume9, IDIRECT3DVOLUME9_SLOTS, {
        ...privateData.methods,
        /** @param {any} volume @param {number[]} args */
        GetDevice: (volume, args)=>getDevice(volume.container, args),
        /** @param {any} volume @param {number[]} args @returns {number} */
        GetContainer: (volume, [riid, out])=>{
            if ((riid >>> 0) === 0 || (out >>> 0) === 0 || !volume.container)
            {
                return D3DERR_INVALIDCALL;
            }
            return queryAs(publisher, fields, volume.container, volumeTextureInterfaces,
                readGuid(memory, riid), out);
        },
        /** @param {any} volume @param {number[]} args */
        GetDesc: (volume, [out])=>writeVolumeDesc(volume, out),
        /** @param {any} volume @param {number[]} args */
        LockBox: (volume, [out, box, flags])=>lockBox(out,
            locked=>volume.LockBox(locked, readBox(box), flags >>> 0)),
        /** @param {any} volume */
        UnlockBox: volume=>volume.UnlockBox(),
    }, {}, privateData.released)];

    const volumeTextureMethods = {
        ...resourceMethods(D3DRTYPE.VOLUMETEXTURE),
        ...baseTextureMethods,
        /** @param {any} texture @param {number[]} args */
        GetLevelDesc: (texture, [level, out])=>{
            /** @type {{ volume?: any }} */
            const held = {};
            const hr = texture.GetVolumeLevel(level >>> 0, held);
            if (hr !== D3D_OK || !held.volume)
            {
                return hr;
            }
            held.volume.release();
            return writeVolumeDesc(held.volume, out);
        },
        /** @param {any} texture @param {number[]} args @returns {number} */
        GetVolumeLevel: (texture, [level, out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ volume?: any }} */
            const held = {};
            const hr = texture.GetVolumeLevel(level >>> 0, held);
            if (hr !== D3D_OK || !held.volume || (out >>> 0) === 0)
            {
                return hr;
            }
            return handBack(held.volume, volumeInterfaces, IID_IDirect3DVolume9, out >>> 0,
                E_OUTOFMEMORY, owners.get(texture));
        },
        /** @param {any} texture @param {number[]} args */
        LockBox: (texture, [level, out, box, flags])=>lockBox(out,
            locked=>texture.LockBox(level >>> 0, locked, readBox(box), flags >>> 0)),
        /** @param {any} texture @param {number[]} args */
        UnlockBox: (texture, [level])=>texture.UnlockBox(level >>> 0),
        /** @param {any} texture @param {number[]} args */
        AddDirtyBox: (texture, [box])=>texture.AddDirtyBox(readBox(box)),
    };
    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const volumeTextureInterfaces = textureFamily(IID_IDirect3DVolumeTexture9,
        IDIRECT3DVOLUMETEXTURE9_SLOTS, volumeTextureMethods);

    /**
     * A buffer hands back an address in the guest's own memory, so locking is
     * one out-parameter and nothing else: the program writes there itself, and
     * the unlock is what tells this engine to look.
     *
     * Both usually run in the guest, as Direct3D 8's do (`shadow.js`); the
     * host's path is the one the guest routine leaves for it -- a lock already
     * held, a read-only lock, a full ring -- and it settles what the guest did
     * to the buffer first, then tells the block what it did, so the two paths
     * see one lock.
     */
    const bufferMethods = {
        /** @param {any} buffer @param {number[]} args */
        Lock: (buffer, [offset, size, out, flags])=>{
            const shadow = shadowOf(owners.get(buffer));
            shadow?.settleBuffer(buffer);
            /** @type {{ pBits?: number }} */
            const locked = {};
            const hr = buffer.Lock(offset >>> 0, size >>> 0, locked, flags >>> 0);
            if (hr === D3D_OK)
            {
                shadow?.noteLocked(buffer, true);
            }
            if ((out >>> 0) !== 0)
            {
                // Cleared on a refusal: a program that reads the pointer
                // rather than the result writes through whatever was there.
                fields.writeU32(out >>> 0, hr === D3D_OK ? locked.pBits ?? 0 : 0);
            }
            return hr;
        },
        /** @param {any} buffer */
        Unlock: (/** @type {any} */ buffer)=>{
            const shadow = shadowOf(owners.get(buffer));
            shadow?.settleBuffer(buffer);
            const hr = buffer.Unlock();
            if (hr === D3D_OK)
            {
                shadow?.noteLocked(buffer, false);
            }
            return hr;
        },
    };
    /** @type {Record<string, (builder: { trap: number }) => number>} */
    const bufferGuests = guestsBut('locks', allocate
        ? {
            Lock: ({ trap })=>placeCode(at=>lockCode(at, trap)),
            Unlock: ({ trap })=>placeCode(at=>unlockCode(at, trap)),
        }
        : {});
    /**
     * A buffer the device just made gets its block before it is handed out:
     * the block's address is written when the interface is published.
     *
     * @param {any} device @param {any} buffer
     */
    const attachBuffer = (device, buffer)=>{
        const shadow = shadowOf(device);
        if (shadow)
        {
            buffer.guestState = ()=>shadow.attachBuffer(buffer);
            // A binding the guest made in the command ring and the host has
            // not made yet is made before the buffer's count is touched: the
            // device holds what is bound, and a Release of the last reference
            // must find it held.
            buffer.settleGuestRefs = ()=>shadow.sync();
        }
    };

    const vertexBufferInterfaces = [
        describeResource(IID_IDirect3DVertexBuffer9, IDIRECT3DVERTEXBUFFER9_SLOTS, {
            ...resourceMethods(D3DRTYPE.VERTEXBUFFER),
            ...bufferMethods,
            /** @param {any} buffer @param {number[]} args */
            GetDesc: (buffer, [out])=>{
                /** @type {{ desc?: any }} */
                const held = {};
                const hr = buffer.GetDesc(held);
                if (hr === D3D_OK && (out >>> 0) !== 0 && held.desc)
                {
                    fields.writeStruct(out >>> 0, D3DVERTEXBUFFER_DESC9, held.desc);
                }
                return hr;
            },
        }, bufferGuests, retire),
    ];
    const indexBufferInterfaces = [
        describeResource(IID_IDirect3DIndexBuffer9, IDIRECT3DINDEXBUFFER9_SLOTS, {
            ...resourceMethods(D3DRTYPE.INDEXBUFFER),
            ...bufferMethods,
            /** @param {any} buffer @param {number[]} args */
            GetDesc: (buffer, [out])=>{
                /** @type {{ desc?: any }} */
                const held = {};
                const hr = buffer.GetDesc(held);
                if (hr === D3D_OK && (out >>> 0) !== 0 && held.desc)
                {
                    fields.writeStruct(out >>> 0, D3DINDEXBUFFER_DESC9, held.desc);
                }
                return hr;
            },
        }, bufferGuests, retire),
    ];

    const declarationInterfaces = [
        describe(IID_IDirect3DVertexDeclaration9, IDIRECT3DVERTEXDECLARATION9_SLOTS, {
            GetDevice: getDevice,
            /**
             * The count pointer is required; the element pointer is optional,
             * and when given it takes every element, whatever count was there.
             *
             * @param {any} declaration @param {number[]} args
             */
            GetDeclaration: (declaration, [elements, count])=>{
                if ((count >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                /** @type {{ elements?: any[], count?: number }} */
                const held = {};
                const hr = declaration.GetDeclaration(held, (elements >>> 0) !== 0);
                fields.writeU32(count >>> 0, held.count ?? 0);
                if (hr === D3D_OK && held.elements)
                {
                    writeElements(elements >>> 0, held.elements);
                }
                return hr;
            },
        }, {}, retire),
    ];

    const shaderMethods = {
        GetDevice: getDevice,
        /**
         * The size pointer is required; the buffer is optional and, when
         * given, its size is what the caller wrote there.
         *
         * @param {any} shader @param {number[]} args
         */
        GetFunction: (shader, [data, size])=>{
            if ((size >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ bytes?: number, tokens?: Uint32Array }} */
            const held = {};
            const hr = shader.GetFunction(held,
                (data >>> 0) === 0 ? null : fields.readU32(size >>> 0));
            fields.writeU32(size >>> 0, held.bytes ?? 0);
            if (hr === D3D_OK && held.tokens)
            {
                writeDwords(data >>> 0, held.tokens);
            }
            return hr;
        },
    };
    const vertexShaderInterfaces = [
        describe(IID_IDirect3DVertexShader9, IDIRECT3DSHADER9_SLOTS, shaderMethods, {}, retire),
    ];
    const pixelShaderInterfaces = [
        describe(IID_IDirect3DPixelShader9, IDIRECT3DSHADER9_SLOTS, shaderMethods, {}, retire),
    ];

    /**
     * What a state block's apply changed of what the device's block mirrors:
     * what the state block holds, and nothing else.
     *
     * @param {any} record
     */
    const touchedBy = record=>({
        renderStates: record.renderStates.keys(),
        transforms: record.transforms.keys(),
        stageStates: record.stageStates.keys(),
        viewport: Boolean(record.viewport),
        samplerStates: record.samplerStates.keys(),
    });
    /** The state blocks this seam handed out, which a run of records may name. */
    const stateBlocks = new WeakSet();
    /**
     * Whether a block holds what a draw's checks read (`FLAG_DRAW_STALE`):
     * which states a block holds is fixed when it is made.
     *
     * @param {any} record
     */
    const touchesDraws = record=>record.vertexDeclaration !== undefined
        || record.indices !== undefined || record.streams.size > 0;
    /** @param {string} name @param {boolean} [staleDraws] */
    const stateBlockGuest = (name, staleDraws = false)=>(/** @type {{ trap: number }} */ { trap })=>
        placeCode(at=>commandCode(at, trap, { ...COMMANDS[`StateBlock.${name}`],
            slot: commandSlot(`StateBlock.${name}`), staleDraws }));
    /** @param {boolean} staleDraws */
    const stateBlockDescriptors = staleDraws=>[
        describeResource(IID_IDirect3DStateBlock9, IDIRECT3DSTATEBLOCK9_SLOTS, {
            GetDevice: getDevice,
            // A block reads and writes the device's state, which the guest
            // may have set since the device last looked.
            /** @param {any} block */
            Capture: block=>{
                shadowOf(owners.get(block))?.sync();
                return block.Capture();
            },
            /** @param {any} block */
            Apply: block=>{
                const shadow = shadowOf(owners.get(block));
                shadow?.sync();
                const hr = block.Apply();
                // What the block holds is all it changed, and the getters in
                // the guest read only these of it.
                shadow?.remirror(touchedBy(block.record));
                return hr;
            },
        }, allocate
            ? { Capture: stateBlockGuest('Capture'), Apply: stateBlockGuest('Apply', staleDraws) }
            : {}),
    ];
    // Two tables, one for each kind of block: the Apply each runs in the guest
    // differs in whether the draws after it wait for the host.
    const stateBlockInterfaces = stateBlockDescriptors(false);
    const drawingStateBlockInterfaces = stateBlockDescriptors(true);

    /**
     * A state block, handed out as its interface: its methods in the guest
     * write into its device's ring, found through the device's block.
     *
     * @param {any} block @param {any} device @param {number} out
     */
    const handBackStateBlock = (block, device, out)=>{
        stateBlocks.add(block);
        block.guestState = ()=>shadowOf(device)?.address() ?? 0;
        return handBack(block, touchesDraws(block.record) ? drawingStateBlockInterfaces
            : stateBlockInterfaces, IID_IDirect3DStateBlock9, out, E_OUTOFMEMORY, device);
    };

    /**
     * The blocks of the queries that have one (`QUERY`), by query.
     *
     * @type {WeakMap<object, number>}
     */
    const queryBlocks = new WeakMap();
    /**
     * An occlusion query's count as its block tells the guest's GetData
     * (`QUERY.STATE`): 0 the host's, 1 asked for, 2 back with `count`.
     *
     * @param {any} query @param {number} state @param {number} [count]
     */
    const countState = (query, state, count = 0)=>{
        const block = queryBlocks.get(query);
        if (block)
        {
            fields.writeU32(block + QUERY.COUNT, count >>> 0);
            fields.writeU32(block + QUERY.STATE, state);
        }
    };

    const queryInterfaces = [describeResource(IID_IDirect3DQuery9, IDIRECT3DQUERY9_SLOTS, {
        GetDevice: getDevice,
        /** @param {any} query */
        GetType: query=>query.GetType(),
        /** @param {any} query */
        GetDataSize: query=>query.GetDataSize(),
        /** @param {any} query @param {number[]} args */
        Issue: (query, [flags])=>{
            // A new measurement: its count is the host's to ask for again.
            countState(query, 0);
            return query.Issue(flags >>> 0);
        },
        // A count is written in as many of its four bytes as the caller has
        // room for, and the caller of a flush waits while it comes back.
        /** @param {any} query @param {number[]} args */
        GetData: (query, [data, size, flags])=>{
            /** @type {{ value?: number }} */
            const held = {};
            /** @param {number} hr */
            const write = hr=>{
                if (hr === D3D_OK && (data >>> 0) !== 0 && held.value !== undefined)
                {
                    const bytes = new Uint8Array(new Uint32Array([held.value >>> 0]).buffer);
                    memory.writeMemory(data >>> 0, bytes.subarray(0, Math.min(4, size >>> 0)));
                }
                return hr;
            };
            const hr = query.GetData((data >>> 0) === 0 ? null : held, size >>> 0, flags >>> 0);
            // An occlusion count asked for, whose answer will be told as it
            // comes (`whenCounted`): the guest answers the polls till then.
            if (hr === S_FALSE && query.type === D3DQUERYTYPE_OCCLUSION && query.countsLater)
            {
                query.whenCounted ??= (/** @type {number | null} */ count)=>(count === null
                    ? countState(query, 0) : countState(query, 2, count));
                countState(query, 1);
            }
            return hr instanceof Promise ? hr.then(write) : write(hr);
        },
    }, guestsBut('queries', allocate
        ? Object.fromEntries(['GetType', 'GetDataSize', 'Issue', 'GetData'].map(name=>[name,
            (/** @type {{ trap: number }} */ { trap })=>placeCode(at=>compiledAt(
                IN_GUEST[/** @type {keyof typeof IN_GUEST} */ (`Query${name}`)], at, trap))]))
        : {}))];

    /** @param {number} address */
    const writeDisplayMode = address=>{
        const display = screen();
        // The rate the enumerated modes carry: a program that lists the
        // rates of a size and picks the current one finds it among them.
        fields.writeStruct(address, D3DDISPLAYMODE, {
            Width: display.width,
            Height: display.height,
            RefreshRate: modeRefresh(),
            Format: D3DFMT.X8R8G8B8,
        });
    };

    /** @param {number} address */
    const writeRasterStatus = address=>{
        fields.writeStruct(address, D3DRASTER_STATUS, rasterStatus(raster));
    };

    const swapChainMethods = {
        // The rectangles and the dirty region are not honoured; the window,
        // the chain's own or the override, decides whether the display
        // shows the picture.
        /** @param {any} chain @param {number[]} args */
        Present: (chain, [, , window])=>{
            showScreen(chainOwners.get(chain));
            return pacedPresent(chain.Present(shownIn(chain, window)));
        },
        // The caller waits while the picture comes back from the GPU.
        /** @param {any} chain @param {number[]} args */
        GetFrontBufferData: (chain, [destination])=>
            chain.GetFrontBufferData(publisher.objectAt(destination)),
        /** @param {any} chain @param {number[]} args */
        GetBackBuffer: (chain, [index, type, out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = chain.GetBackBuffer(index >>> 0, type >>> 0, held);
            if (hr === D3D_OK && held.surface)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface9,
                    out >>> 0, E_OUTOFMEMORY, owners.get(chain));
            }
            return hr;
        },
        /** @param {any} chain @param {number[]} args */
        GetRasterStatus: (chain, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            writeRasterStatus(out >>> 0);
            return D3D_OK;
        },
        /** @param {any} chain @param {number[]} args */
        GetDisplayMode: (chain, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            writeDisplayMode(out >>> 0);
            return D3D_OK;
        },
        GetDevice: getDevice,
        /** @param {any} chain @param {number[]} args */
        GetPresentParameters: (chain, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ parameters?: any }} */
            const held = {};
            const hr = chain.GetPresentParameters(held);
            if (hr === D3D_OK && held.parameters)
            {
                writeAllPresentParameters(out >>> 0, held.parameters);
            }
            return hr;
        },
    };

    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const swapChainInterfaces = [
        describeResource(IID_IDirect3DSwapChain9, IDIRECT3DSWAPCHAIN9_SLOTS, swapChainMethods),
    ];

    /**
     * D3DDISPLAYMODEEX, into a structure whose Size the caller set: anything
     * else is refused (Wine's d3d9ex.c test_get_adapter_displaymode_ex). The
     * display's scan lines are progressive and it is not rotated.
     *
     * @param {number} address @param {number} rotation  Where the rotation goes, or 0.
     */
    const writeDisplayModeEx = (address, rotation)=>{
        if ((address >>> 0) === 0 || fields.readU32(address >>> 0) !== D3DDISPLAYMODEEX.SIZE)
        {
            return D3DERR_INVALIDCALL;
        }
        const display = screen();
        fields.writeStruct(address >>> 0, D3DDISPLAYMODEEX, {
            Width: display.width,
            Height: display.height,
            RefreshRate: modeRefresh(),
            Format: D3DFMT.X8R8G8B8,
            ScanLineOrdering: D3DSCANLINEORDERING_PROGRESSIVE,
        });
        if ((rotation >>> 0) !== 0)
        {
            fields.writeU32(rotation >>> 0, D3DDISPLAYROTATION_IDENTITY);
        }
        return D3D_OK;
    };

    /**
     * A chain of a device made through IDirect3D9Ex, which answers
     * IDirect3DSwapChain9Ex as well (Wine's d3d9ex.c test_qi_ex_to_base).
     *
     * @type {import('./com.js').InterfaceDescriptor[]}
     */
    const exSwapChainInterfaces = [
        describeResource(IID_IDirect3DSwapChain9Ex,
            [...IDIRECT3DSWAPCHAIN9_SLOTS, ...IDIRECT3DSWAPCHAIN9EX_SLOTS], {
                ...swapChainMethods,
                /** @param {any} chain @param {number[]} args */
                GetLastPresentCount: (chain, [out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return D3DERR_INVALIDCALL;
                    }
                    fields.writeU32(out >>> 0, chain.presentCount ?? 0);
                    return D3D_OK;
                },
                // The statistics are the display's refreshes, which nothing
                // here sees: a FLIPEX chain is refused them as any other is.
                GetPresentStats: ()=>D3DERR_INVALIDCALL,
                /** @param {any} chain @param {number[]} args */
                GetDisplayModeEx: (chain, [mode, rotation])=>writeDisplayModeEx(mode, rotation),
            }),
        ...swapChainInterfaces,
    ];

    /**
     * The interfaces a device's chain answers.
     *
     * @param {any} device
     */
    const chainInterfacesOf = device=>(device?.extended
        ? exSwapChainInterfaces
        : swapChainInterfaces);

    /**
     * A create that ends in a shared-handle pointer, which the plain interface
     * requires to be null. Sharing is the extended interface's, and nothing
     * here shares a resource between devices, so it is refused there too.
     *
     * @param {number} shared
     */
    const sharedHandleRefused = shared=>(shared >>> 0) !== 0;

    /**
     * What a create's shared-handle pointer asks of an extended device for a
     * resource in the system-memory pool: the handle it holds is the address
     * of memory of the program's own to keep the resource in. Any other use of
     * one is refused, as above.
     *
     * @param {any} device @param {number} shared @param {number} pool
     * @returns {number | null} the memory, 0 for none, null for a refusal
     */
    const userMemoryOf = (device, shared, pool)=>{
        if ((shared >>> 0) === 0)
        {
            return 0;
        }
        return device?.extended && (pool >>> 0) === D3DPOOL.SYSTEMMEM
            ? fields.readU32(shared >>> 0) >>> 0 : null;
    };

    /** How wide each index a draw reads is. */
    const indexWidth = (/** @type {number} */ format)=>(format >>> 0) === D3DFMT_INDEX.INDEX32
        ? 4
        : 2;

    /**
     * The six constant setters and their readers, which differ only in the
     * method they reach and how the values are read or written: floats and
     * integers four to a register, booleans one.
     *
     * @param {string} method
     * @param {(pointer: number, count: number) => ArrayLike<number>} read
     * @param {number} width
     */
    const constantSetter = (method, read, width)=>
        (/** @type {any} */ device, /** @type {number[]} */ [start, data, count])=>(
            (data >>> 0) === 0
                ? D3DERR_INVALIDCALL
                : device[method](start >>> 0, read(data, (count >>> 0) * width), count >>> 0));

    /**
     * @param {string} method
     * @param {(address: number, values: ArrayLike<number>) => void} write
     */
    const constantGetter = (method, write)=>
        (/** @type {any} */ device, /** @type {number[]} */ [start, data, count])=>{
            if ((data >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ values?: ArrayLike<number> }} */
            const held = {};
            const hr = device[method](start >>> 0, count >>> 0, held);
            if (hr === D3D_OK && held.values)
            {
                write(data, held.values);
            }
            return hr;
        };

    /**
     * The device's slots. Written out rather than generated because each one
     * differs in which arguments are pointers.
     */
    const deviceMethods = {
        /** @param {any} device */
        TestCooperativeLevel: (/** @type {any} */ device)=>device.TestCooperativeLevel(),
        /** @param {any} device */
        GetAvailableTextureMem: (/** @type {any} */ device)=>device.GetAvailableTextureMem(),
        /** @param {any} device */
        EvictManagedResources: (/** @type {any} */ device)=>device.EvictManagedResources(),

        /** @param {any} device @param {number[]} args */
        GetDirect3D: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ direct3D?: any }} */
            const held = {};
            const hr = device.GetDirect3D(held);
            if (hr === D3D_OK && held.direct3D)
            {
                // The object that made the device, as it was made: one made by
                // Direct3DCreate9Ex is handed back as its IDirect3D9Ex, whose
                // table begins with IDirect3D9's, as Windows hands it back.
                fields.writeU32(out >>> 0, exRoots.has(held.direct3D)
                    ? publisher.publish(held.direct3D, rootExInterfaces, IID_IDirect3D9Ex)
                    : publisher.publish(held.direct3D, rootInterfaces, IID_IDirect3D9));
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        GetDeviceCaps: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ parameters?: any }} */
            const held = {};
            device.GetCreationParameters(held);
            writeCaps(out >>> 0, device.caps, {
                deviceType: held.parameters?.DeviceType,
                adapterOrdinal: held.parameters?.AdapterOrdinal,
            });
            return D3D_OK;
        },

        /** @param {any} device @param {number[]} args */
        GetDisplayMode: (device, [chain, out])=>{
            if ((chain >>> 0) !== 0 || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            writeDisplayMode(out >>> 0);
            return D3D_OK;
        },

        /** @param {any} device @param {number[]} args */
        GetCreationParameters: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ parameters?: any }} */
            const held = {};
            const hr = device.GetCreationParameters(held);
            if (hr === D3D_OK && held.parameters)
            {
                fields.writeStruct(out >>> 0, D3DDEVICE_CREATION_PARAMETERS, held.parameters);
            }
            return hr;
        },

        // Nothing composites a bitmap over the presented frame; the cursor is
        // handed to whoever shows the frame. Without such a taker the call is
        // refused, which is the one answer that says so.
        /** @param {any} device @param {number[]} args */
        SetCursorProperties: (device, [x, y, surface])=>{
            if (!cursor)
            {
                return D3DERR_INVALIDCALL;
            }
            const hr = device.SetCursorProperties(x >>> 0, y >>> 0, publisher.objectAt(surface));
            if (hr === D3D_OK)
            {
                tellCursor(device);
            }
            return hr;
        },
        // Declared void. The position is the host's own pointer.
        SetCursorPosition: ()=>0,
        /** @param {any} device @param {number[]} args */
        ShowCursor: (device, [show])=>{
            const was = device.ShowCursor((show >>> 0) !== 0);
            if (cursor)
            {
                tellCursor(device);
            }
            return was ? 1 : 0;
        },

        /** @param {any} device @param {number[]} args */
        CreateAdditionalSwapChain: (device, [parameters, out])=>{
            if ((parameters >>> 0) === 0 || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            // A chain naming no window presents into the device's, measured
            // for a size asked for as zero, and says so when asked for its
            // parameters; what is written back leaves the window as it was.
            const wanted = readPresentParameters(parameters >>> 0, deviceWindow);
            const window = (wanted.hDeviceWindow >>> 0) || deviceWindow;
            /** @type {{ swapChain?: any }} */
            const held = {};
            const hr = device.CreateAdditionalSwapChain({ ...wanted, hDeviceWindow: window },
                held);
            if (hr !== D3D_OK || !held.swapChain)
            {
                fields.writeU32(out >>> 0, 0);
                return hr;
            }
            writePresentParameters(parameters >>> 0, wanted);
            chainWindows.set(held.swapChain, window);
            return handBack(held.swapChain, chainInterfacesOf(device), IID_IDirect3DSwapChain9,
                out >>> 0, D3DERR_OUTOFVIDEOMEMORY, device);
        },

        /** @param {any} device @param {number[]} args */
        GetSwapChain: (device, [index, out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ swapChain?: any }} */
            const held = {};
            const hr = device.GetSwapChain(index >>> 0, held);
            if (hr === D3D_OK && held.swapChain)
            {
                chainOwners.set(held.swapChain, device);
                return handBack(held.swapChain, chainInterfacesOf(device), IID_IDirect3DSwapChain9,
                    out >>> 0, E_OUTOFMEMORY, device);
            }
            fields.writeU32(out >>> 0, 0);
            return hr;
        },
        /** @param {any} device */
        GetNumberOfSwapChains: (/** @type {any} */ device)=>device.GetNumberOfSwapChains(),

        /** @param {any} device @param {number[]} args */
        Reset: (device, [parameters])=>{
            if ((parameters >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            if (fullScreenUnlikeAnyMode(parameters >>> 0))
            {
                return D3DERR_INVALIDCALL;
            }
            const next = readPresentParameters(parameters >>> 0, deviceWindow);
            const hr = device.Reset(next);
            if (hr === D3D_OK)
            {
                writePresentParameters(parameters >>> 0, next);
                lastParameters = next;
                // The window is this resolution now, and a fullscreen reset has
                // to take it with it the way a created one does; a window left
                // at the old size has the program clipping its cursor to a
                // rectangle the picture no longer fills.
                takeScreen(device, next, (next.hDeviceWindow >>> 0) || deviceWindow);
            }
            // A reset puts the state back to its defaults, which the block
            // has to say before the guest reads or writes it again.
            shadowOf(device)?.remirror();
            return hr;
        },

        // Present's four arguments are all optional and all ignored: there
        // are no rectangles to honour, and the window is the browser's.
        /** @param {any} device */
        Present: (/** @type {any} */ device)=>{
            showScreen(device);
            // A mode switch resizes the window a fullscreen device presents
            // into, and the program hears WM_SIZE for it after its device
            // exists, since the switch is the device's creation. A program
            // of this era configures itself on that message: its viewport,
            // and whether it may run at full speed or is in the background.
            // A window already at the mode's size hears nothing from the
            // placement at creation, so it is told once, at the device's
            // first frame, when both it and the device are there to hear it.
            if (!announced.has(device) && lastParameters && !lastParameters.windowed)
            {
                announced.add(device);
                resolution?.(lastParameters.backBufferWidth >>> 0,
                    lastParameters.backBufferHeight >>> 0, {
                        window: deviceWindow, fullscreen: true, announce: true,
                    });
            }
            return pacedPresent(device.Present());
        },

        /** @param {any} device @param {number[]} args */
        GetBackBuffer: (device, [chain, index, type, out])=>{
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = device.GetBackBuffer(chain >>> 0, index >>> 0, type >>> 0, held);
            if (hr === D3D_OK && held.surface && (out >>> 0) !== 0)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface9,
                    out >>> 0, E_OUTOFMEMORY, device);
            }
            // A refusal clears the pointer (Wine's d3d9 test_swapchain).
            if (hr !== D3D_OK && (out >>> 0) !== 0)
            {
                fields.writeU32(out >>> 0, 0);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        GetRasterStatus: (device, [chain, out])=>{
            if ((chain >>> 0) !== 0 || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            writeRasterStatus(out >>> 0);
            return D3D_OK;
        },

        /** @param {any} device @param {number[]} args */
        SetDialogBoxMode: (device, [enable])=>device.SetDialogBoxMode((enable >>> 0) !== 0),

        // Both gamma calls are declared void. The swap chain and the
        // calibration flag are not read: a device's one ramp is its implicit
        // chain's, and nothing here calibrates.
        /** @param {any} device @param {number[]} args */
        SetGammaRamp: (device, [, , ramp])=>{
            if ((ramp >>> 0) !== 0)
            {
                device.SetGammaRamp(readGammaRamp(ramp >>> 0));
            }
            return 0;
        },
        /** @param {any} device @param {number[]} args */
        GetGammaRamp: (device, [, out])=>{
            if ((out >>> 0) !== 0)
            {
                /** @type {{ ramp?: any }} */
                const held = {};
                device.GetGammaRamp(held);
                writeGammaRamp(out >>> 0, held.ramp);
            }
            return 0;
        },

        // --- resources ---

        /** @param {any} device @param {number[]} args */
        CreateTexture: (device, [width, height, levels, usage, format, pool, out, shared])=>{
            const userMemory = userMemoryOf(device, shared, pool);
            if (userMemory === null || (out >>> 0) === 0)
            {
                return clearAndRefuse(out, D3DERR_INVALIDCALL);
            }
            /** @type {{ texture?: any }} */
            const held = {};
            const hr = device.CreateTexture(
                width >>> 0, height >>> 0, levels >>> 0, usage >>> 0,
                format >>> 0, pool >>> 0, held, userMemory);
            if (hr === D3D_OK && held.texture)
            {
                // Its block, where the guest's GetSurfaceLevel finds the
                // levels, is written as the interface is published.
                const shadow = shadowOf(device);
                const texture = held.texture;
                if (shadow)
                {
                    texture.guestState = ()=>shadow.attachTexture(texture,
                        publisher.countCell(texture));
                }
                return handBack(held.texture, textureInterfaces, IID_IDirect3DTexture9,
                    out >>> 0, D3DERR_OUTOFVIDEOMEMORY, device);
            }
            return clearAndRefuse(out, hr);
        },

        /** @param {any} device @param {number[]} args */
        CreateVolumeTexture: (device, args)=>{
            const [width, height, depth, levels, usage, format, pool, out, shared] = args;
            if (sharedHandleRefused(shared) || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ texture?: any }} */
            const held = {};
            const hr = device.CreateVolumeTexture(width >>> 0, height >>> 0, depth >>> 0,
                levels >>> 0, usage >>> 0, format >>> 0, pool >>> 0, held);
            if (hr === D3D_OK && held.texture)
            {
                return handBack(held.texture, volumeTextureInterfaces,
                    IID_IDirect3DVolumeTexture9, out >>> 0, D3DERR_OUTOFVIDEOMEMORY, device);
            }
            return clearAndRefuse(out, hr);
        },
        /** @param {any} device @param {number[]} args */
        CreateCubeTexture: (device, [edgeLength, levels, usage, format, pool, out, shared])=>{
            if (sharedHandleRefused(shared) || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ texture?: any }} */
            const held = {};
            const hr = device.CreateCubeTexture(edgeLength >>> 0, levels >>> 0, usage >>> 0,
                format >>> 0, pool >>> 0, held);
            if (hr === D3D_OK && held.texture)
            {
                return handBack(held.texture, cubeTextureInterfaces, IID_IDirect3DCubeTexture9,
                    out >>> 0, D3DERR_OUTOFVIDEOMEMORY, device);
            }
            return clearAndRefuse(out, hr);
        },

        /** @param {any} device @param {number[]} args */
        CreateVertexBuffer: (device, [length, usage, fvf, pool, out, shared])=>{
            if (sharedHandleRefused(shared) || (out >>> 0) === 0)
            {
                // A buffer is never kept in the program's own memory.
                return clearAndRefuse(out, userMemoryOf(device, shared, pool) === null
                    || (out >>> 0) === 0 ? D3DERR_INVALIDCALL : D3DERR_NOTAVAILABLE);
            }
            /** @type {{ buffer?: any }} */
            const held = {};
            const hr = device.CreateVertexBuffer(
                length >>> 0, usage >>> 0, fvf >>> 0, pool >>> 0, held);
            if (hr === D3D_OK && held.buffer)
            {
                attachBuffer(device, held.buffer);
                return handBack(held.buffer, vertexBufferInterfaces,
                    IID_IDirect3DVertexBuffer9, out >>> 0, D3DERR_OUTOFVIDEOMEMORY, device);
            }
            return clearAndRefuse(out, hr);
        },

        /** @param {any} device @param {number[]} args */
        CreateIndexBuffer: (device, [length, usage, format, pool, out, shared])=>{
            if (sharedHandleRefused(shared) || (out >>> 0) === 0)
            {
                // A buffer is never kept in the program's own memory.
                return clearAndRefuse(out, userMemoryOf(device, shared, pool) === null
                    || (out >>> 0) === 0 ? D3DERR_INVALIDCALL : D3DERR_NOTAVAILABLE);
            }
            /** @type {{ buffer?: any }} */
            const held = {};
            const hr = device.CreateIndexBuffer(
                length >>> 0, usage >>> 0, format >>> 0, pool >>> 0, held);
            if (hr === D3D_OK && held.buffer)
            {
                attachBuffer(device, held.buffer);
                return handBack(held.buffer, indexBufferInterfaces,
                    IID_IDirect3DIndexBuffer9, out >>> 0, D3DERR_OUTOFVIDEOMEMORY, device);
            }
            return clearAndRefuse(out, hr);
        },

        // The multisample type and quality are dropped: this device renders
        // one sample per pixel whatever it is asked for.
        /** @param {any} device @param {number[]} args */
        CreateRenderTarget: (device, [width, height, format, , , lockable, out, shared])=>{
            if (sharedHandleRefused(shared) || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = device.CreateRenderTarget(
                width >>> 0, height >>> 0, format >>> 0, lockable !== 0, held);
            if (hr === D3D_OK && held.surface)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface9,
                    out >>> 0, D3DERR_OUTOFVIDEOMEMORY, device);
            }
            return clearAndRefuse(out, hr);
        },

        /** @param {any} device @param {number[]} args */
        CreateDepthStencilSurface: (device, [width, height, format, , , , out, shared])=>{
            if (sharedHandleRefused(shared) || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = device.CreateDepthStencilSurface(
                width >>> 0, height >>> 0, format >>> 0, held);
            if (hr === D3D_OK && held.surface)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface9,
                    out >>> 0, D3DERR_OUTOFVIDEOMEMORY, device);
            }
            return clearAndRefuse(out, hr);
        },

        /** @param {any} device @param {number[]} args */
        CreateOffscreenPlainSurface: (device, [width, height, format, pool, out, shared])=>{
            const userMemory = userMemoryOf(device, shared, pool);
            if (userMemory === null || (out >>> 0) === 0)
            {
                return clearAndRefuse(out, D3DERR_INVALIDCALL);
            }
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = device.CreateOffscreenPlainSurface(
                width >>> 0, height >>> 0, format >>> 0, pool >>> 0, held, 0, userMemory);
            if (hr === D3D_OK && held.surface)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface9,
                    out >>> 0, E_OUTOFMEMORY, device);
            }
            return clearAndRefuse(out, hr);
        },

        // --- copies between surfaces: the device describes the moves and,
        // given a way to write guest memory, makes them ---

        /** @param {any} device @param {number[]} args */
        UpdateSurface: (device, [source, rect, destination, point])=>device.UpdateSurface(
            publisher.objectAt(source), readRect(rect), publisher.objectAt(destination),
            (point >>> 0) === 0 ? null : fields.readStruct(point >>> 0, POINT)),

        /** @param {any} device @param {number[]} args */
        UpdateTexture: (device, [source, destination])=>device.UpdateTexture(
            publisher.objectAt(source), publisher.objectAt(destination)),

        /** @param {any} device @param {number[]} args */
        GetRenderTargetData: (device, [target, destination])=>device.GetRenderTargetData(
            publisher.objectAt(target), publisher.objectAt(destination)),

        /** @param {any} device */
        /** @param {any} device @param {number[]} args */
        GetFrontBufferData: (device, [chain, destination])=>
            device.GetFrontBufferData(chain >>> 0, publisher.objectAt(destination)),

        /** @param {any} device @param {number[]} args */
        StretchRect: (device, [source, sourceRect, destination, destinationRect, filter])=>
            device.StretchRect(publisher.objectAt(source), readRect(sourceRect),
                publisher.objectAt(destination), readRect(destinationRect), filter >>> 0),

        /** @param {any} device @param {number[]} args */
        ColorFill: (device, [surface, rect, colour])=>device.ColorFill(
            publisher.objectAt(surface), readRect(rect), colour >>> 0),

        // --- targets ---

        /** @param {any} device @param {number[]} args */
        SetRenderTarget: (device, [index, surface])=>{
            const hr = device.SetRenderTarget(index >>> 0, publisher.objectAt(surface));
            // A new target is a new viewport, which the guest's GetViewport reads.
            shadowOf(device)?.remirror({ viewport: true });
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        GetRenderTarget: (device, [index, out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = device.GetRenderTarget(index >>> 0, held);
            if (hr === D3D_OK && held.surface)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface9,
                    out >>> 0, E_OUTOFMEMORY, device);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetDepthStencilSurface: (device, [surface])=>
            device.SetDepthStencilSurface(publisher.objectAt(surface)),

        /** @param {any} device @param {number[]} args */
        GetDepthStencilSurface: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = device.GetDepthStencilSurface(held);
            if (hr === D3D_OK && held.surface)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface9,
                    out >>> 0, E_OUTOFMEMORY, device);
            }
            // Cleared when there is nothing to hand back: this call is how a
            // program asks whether the device has a depth buffer, and it
            // tests the pointer rather than the HRESULT.
            fields.writeU32(out >>> 0, 0);
            return hr;
        },

        // --- the scene ---

        /** @param {any} device */
        BeginScene: (/** @type {any} */ device)=>device.BeginScene(),
        /** @param {any} device */
        EndScene: (/** @type {any} */ device)=>device.EndScene(),

        // Z arrives as a float in a slot this seam otherwise reads as a dword.
        /** @param {any} device @param {number[]} args */
        Clear: (device, [count, rects, flags, colour, z, stencil])=>device.Clear(
            count >>> 0,
            (rects >>> 0) === 0
                ? null
                : Array.from({ length: count >>> 0 }, (_, index)=>fields.readStruct(
                    (rects >>> 0) + index * 16, { x1: 0, y1: 4, x2: 8, y2: 12 })),
            flags >>> 0, colour >>> 0, fields.asFloat(z), stencil >>> 0),

        /** @param {any} device @param {number[]} args */
        SetTransform: (device, [type, matrix])=>{
            if ((matrix >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            const hr = device.SetTransform(type >>> 0, readFloats(matrix, 16));
            // A set the host makes -- the routine kept as a trap, or the slow
            // path up -- is one the guest's GetTransform reads too.
            shadowOf(device)?.refreshTransform(type >>> 0);
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        GetTransform: (device, [type, out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ matrix?: Float32Array }} */
            const held = {};
            const hr = device.GetTransform(type >>> 0, held);
            if (hr === D3D_OK && held.matrix)
            {
                writeFloats(out >>> 0, held.matrix);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        MultiplyTransform: (device, [type, matrix])=>{
            if ((matrix >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            const hr = device.MultiplyTransform(type >>> 0, readFloats(matrix, 16));
            shadowOf(device)?.refreshTransform(type >>> 0);
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetViewport: (device, [pointer])=>{
            if ((pointer >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            const hr = device.SetViewport({
                ...fields.readStruct(pointer >>> 0, D3DVIEWPORT9, ['MinZ', 'MaxZ']),
                MinZWord: fields.readU32((pointer >>> 0) + 16),
                MaxZWord: fields.readU32((pointer >>> 0) + 20),
            });
            shadowOf(device)?.remirror({ viewport: true });
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        GetViewport: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ viewport?: any, depthWords?: [number, number] }} */
            const held = {};
            const hr = device.GetViewport(held);
            if (hr === D3D_OK && held.viewport)
            {
                // The depth range as the words the program set: a float
                // written from a number would quiet a signalling NaN.
                fields.writeStruct(out >>> 0, D3DVIEWPORT9, held.depthWords
                    ? { ...held.viewport, MinZ: held.depthWords[0], MaxZ: held.depthWords[1] }
                    : held.viewport, held.depthWords ? [] : ['MinZ', 'MaxZ']);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetMaterial: (device, [pointer])=>((pointer >>> 0) === 0
            ? D3DERR_INVALIDCALL
            : device.SetMaterial(readMaterial(pointer))),

        /** @param {any} device @param {number[]} args */
        GetMaterial: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ material?: any }} */
            const held = {};
            const hr = device.GetMaterial(held);
            if (hr === D3D_OK && held.material)
            {
                writeMaterial(out >>> 0, held.material);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetLight: (device, [index, pointer])=>((pointer >>> 0) === 0
            ? D3DERR_INVALIDCALL
            : device.SetLight(index >>> 0, readLight(device, index >>> 0, pointer >>> 0))),

        /** @param {any} device @param {number[]} args */
        GetLight: (device, [index, out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ light?: any }} */
            const held = {};
            const hr = device.GetLight(index >>> 0, held);
            if (hr === D3D_OK && held.light)
            {
                writeLight(out >>> 0, held.light);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        LightEnable: (device, [index, enable])=>device.LightEnable(index >>> 0, enable !== 0),

        /** @param {any} device @param {number[]} args */
        GetLightEnable: (device, [index, out])=>{
            /** @type {{ enabled?: number }} */
            const held = {};
            const hr = device.GetLightEnable(index >>> 0, held);
            if (hr === D3D_OK && (out >>> 0) !== 0)
            {
                fields.writeU32(out >>> 0, held.enabled ?? 0);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetClipPlane: (device, [index, pointer])=>((pointer >>> 0) === 0
            ? D3DERR_INVALIDCALL
            : device.SetClipPlane(index >>> 0, readFloats(pointer >>> 0, 4))),

        /** @param {any} device @param {number[]} args */
        GetClipPlane: (device, [index, out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ plane?: Float32Array }} */
            const held = {};
            const hr = device.GetClipPlane(index >>> 0, held);
            if (hr === D3D_OK && held.plane)
            {
                writeFloats(out >>> 0, held.plane);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetRenderState: (device, [state, value])=>{
            const hr = device.SetRenderState(state >>> 0, value >>> 0);
            shadowOf(device)?.remirror({ renderStates: [state >>> 0] });
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        GetRenderState: (device, [state, out])=>{
            /** @type {{ value?: number }} */
            const held = {};
            const hr = device.GetRenderState(state >>> 0, held);
            if (hr === D3D_OK && (out >>> 0) !== 0)
            {
                fields.writeU32(out >>> 0, held.value ?? 0);
            }
            return hr;
        },

        // --- state blocks ---

        /** @param {any} device @param {number[]} args */
        CreateStateBlock: (device, [type, out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ block?: any }} */
            const held = {};
            const hr = device.CreateStateBlock(type >>> 0, held);
            if (hr === D3D_OK && held.block)
            {
                return handBackStateBlock(held.block, device, out >>> 0);
            }
            return hr;
        },
        /** @param {any} device */
        BeginStateBlock: (/** @type {any} */ device)=>{
            const hr = device.BeginStateBlock();
            if (hr === D3D_OK)
            {
                // Recording captures what is set, not what changed: the
                // guest's setters give way to the host until it ends.
                shadowOf(device)?.slowPath(true);
            }
            return hr;
        },
        /** @param {any} device @param {number[]} args */
        EndStateBlock: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ block?: any }} */
            const held = {};
            const hr = device.EndStateBlock(held);
            shadowOf(device)?.slowPath(false);
            if (hr === D3D_OK && held.block)
            {
                return handBackStateBlock(held.block, device, out >>> 0);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetClipStatus: (device, [pointer])=>((pointer >>> 0) === 0
            ? D3DERR_INVALIDCALL
            : device.SetClipStatus(fields.readStruct(pointer >>> 0, D3DCLIPSTATUS9))),

        /** @param {any} device @param {number[]} args */
        GetClipStatus: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ status?: any }} */
            const held = {};
            const hr = device.GetClipStatus(held);
            if (hr === D3D_OK && held.status)
            {
                fields.writeStruct(out >>> 0, D3DCLIPSTATUS9, held.status);
            }
            return hr;
        },

        // --- textures, stages and samplers ---

        /** @param {any} device @param {number[]} args */
        GetTexture: (device, [stage, out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ texture?: any }} */
            const held = {};
            const hr = device.GetTexture(stage >>> 0, held);
            if (hr === D3D_OK)
            {
                // Written whichever way it went: a stage with nothing bound
                // answers a null pointer rather than leaving the caller's
                // variable holding the texture it last read.
                fields.writeU32(out >>> 0, held.texture
                    ? publisher.publish(held.texture, textureInterfacesFor(held.texture),
                        textureInterfacesFor(held.texture)[0].id)
                    : 0);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetTexture: (device, [stage, texture])=>
            device.SetTexture(stage >>> 0, publisher.objectAt(texture)),

        /** @param {any} device @param {number[]} args */
        GetTextureStageState: (device, [stage, type, out])=>{
            /** @type {{ value?: number }} */
            const held = {};
            const hr = device.GetTextureStageState(stage >>> 0, type >>> 0, held);
            if (hr === D3D_OK && (out >>> 0) !== 0 && held.value !== undefined)
            {
                fields.writeU32(out >>> 0, held.value);
            }
            return hr;
        },
        /** @param {any} device @param {number[]} args */
        SetTextureStageState: (device, [stage, type, value])=>{
            const hr = device.SetTextureStageState(stage >>> 0, type >>> 0, value >>> 0);
            shadowOf(device)?.remirror({ stageStates: [(stage & 0xffffff) << 8 | type & 0xff] });
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        GetSamplerState: (device, [sampler, type, out])=>{
            /** @type {{ value?: number }} */
            const held = {};
            const hr = device.GetSamplerState(sampler >>> 0, type >>> 0, held);
            if (hr === D3D_OK && (out >>> 0) !== 0)
            {
                fields.writeU32(out >>> 0, held.value ?? 0);
            }
            return hr;
        },
        /** @param {any} device @param {number[]} args */
        SetSamplerState: (device, [sampler, type, value])=>{
            const hr = device.SetSamplerState(sampler >>> 0, type >>> 0, value >>> 0);
            shadowOf(device)?.remirror({
                samplerStates: [(sampler & 0xffffff) << 8 | type & 0xff],
            });
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        ValidateDevice: (device, [out])=>{
            /** @type {{ passes?: number }} */
            const held = {};
            const hr = device.ValidateDevice(held);
            if (hr === D3D_OK && (out >>> 0) !== 0)
            {
                fields.writeU32(out >>> 0, held.passes ?? 1);
            }
            return hr;
        },

        // A palette is state a program sets and reads back; no texel here is
        // ever looked up through one.
        /** @param {any} device @param {number[]} args */
        SetPaletteEntries: (device, [number, entries])=>((entries >>> 0) === 0
            ? D3DERR_INVALIDCALL
            : device.SetPaletteEntries(number >>> 0,
                memory.readMemory(entries >>> 0, PALETTE_BYTES))),
        /** @param {any} device @param {number[]} args */
        GetPaletteEntries: (device, [number, out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ entries?: Uint8Array }} */
            const held = {};
            const hr = device.GetPaletteEntries(number >>> 0, held);
            if (hr === D3D_OK && held.entries)
            {
                memory.writeMemory(out >>> 0, held.entries);
            }
            return hr;
        },
        /** @param {any} device @param {number[]} args */
        SetCurrentTexturePalette: (device, [number])=>
            device.SetCurrentTexturePalette(number >>> 0),
        /** @param {any} device @param {number[]} args */
        GetCurrentTexturePalette: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ number?: number }} */
            const held = {};
            const hr = device.GetCurrentTexturePalette(held);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0, held.number ?? 0);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetScissorRect: (device, [pointer])=>((pointer >>> 0) === 0
            ? D3DERR_INVALIDCALL
            : device.SetScissorRect(fields.readStruct(pointer >>> 0, RECT))),

        /** @param {any} device @param {number[]} args */
        GetScissorRect: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ rect?: any }} */
            const held = {};
            const hr = device.GetScissorRect(held);
            if (hr === D3D_OK && held.rect)
            {
                fields.writeStruct(out >>> 0, RECT, held.rect);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetSoftwareVertexProcessing: (device, [software])=>
            device.SetSoftwareVertexProcessing((software >>> 0) !== 0),
        /** @param {any} device */
        GetSoftwareVertexProcessing: (/** @type {any} */ device)=>(
            device.GetSoftwareVertexProcessing() ? 1 : 0),

        /** @param {any} device @param {number[]} args */
        SetNPatchMode: (device, [segments])=>device.SetNPatchMode(fields.asFloat(segments)),
        // Declared to return a float, which x86 hands back in the FPU's top
        // register and not in EAX; the bridge returns EAX. The value a program
        // reads is therefore not the one kept, and the call is reported so a
        // run knows -- a program that reads this is rare, and one that acts on
        // it rarer, since the capability block claims no patches.
        /** @param {any} device */
        GetNPatchMode: (/** @type {any} */ device)=>{
            divergence?.('Direct3D 9', 'GetNPatchMode returns a float in ST(0), which this'
                + ' seam cannot set; the caller reads an unrelated value');
            return device.GetNPatchMode() | 0;
        },

        // --- draws ---

        /** @param {any} device @param {number[]} args */
        DrawPrimitive: (device, [type, startVertex, primitiveCount])=>
            device.DrawPrimitive(type >>> 0, startVertex >>> 0, primitiveCount >>> 0),

        // The base vertex index is a signed integer: a program draws from
        // before the start of its stream by passing a negative one.
        /** @param {any} device @param {number[]} args */
        DrawIndexedPrimitive: (device, [type, base, minIndex, numVertices, startIndex, count])=>
            device.DrawIndexedPrimitive(type >>> 0, base | 0, minIndex >>> 0, numVertices >>> 0,
                startIndex >>> 0, count >>> 0),

        /** @param {any} device @param {number[]} args */
        DrawPrimitiveUP: (device, [type, primitiveCount, vertices, stride])=>
            device.DrawPrimitiveUP(type >>> 0, primitiveCount >>> 0,
                readArray(vertices,
                    vertexCountOf(type >>> 0, primitiveCount >>> 0) * (stride >>> 0)),
                stride >>> 0),

        /** @param {any} device @param {number[]} args */
        DrawIndexedPrimitiveUP: (device,
            [type, minIndex, numVertices, count, indices, format, vertices, stride])=>
            device.DrawIndexedPrimitiveUP(type >>> 0, minIndex >>> 0,
                numVertices >>> 0, count >>> 0,
                readArray(indices,
                    vertexCountOf(type >>> 0, count >>> 0) * indexWidth(format)),
                format >>> 0,
                // An index counts from the start of the vertices, so the
                // range reaches past its lowest by the count.
                readArray(vertices, ((minIndex >>> 0) + (numVertices >>> 0)) * (stride >>> 0)),
                stride >>> 0),

        /** @param {any} device @param {number[]} args */
        ProcessVertices: (device, [start, index, count, destination, declaration, flags])=>
            device.ProcessVertices(start >>> 0, index >>> 0, count >>> 0,
                publisher.objectAt(destination), publisher.objectAt(declaration), flags >>> 0),

        // --- declarations ---

        /** @param {any} device @param {number[]} args */
        CreateVertexDeclaration: (device, [elements, out])=>{
            if ((elements >>> 0) === 0 || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ declaration?: any }} */
            const held = {};
            const hr = device.CreateVertexDeclaration(readElements(elements), held);
            if (hr === D3D_OK && held.declaration)
            {
                return handBack(held.declaration, declarationInterfaces,
                    IID_IDirect3DVertexDeclaration9, out >>> 0, E_OUTOFMEMORY, device);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetVertexDeclaration: (device, [declaration])=>
            device.SetVertexDeclaration(publisher.objectAt(declaration)),

        /** @param {any} device @param {number[]} args */
        GetVertexDeclaration: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ declaration?: any }} */
            const held = {};
            const hr = device.GetVertexDeclaration(held);
            if (hr === D3D_OK)
            {
                // A declaration made by SetFVF is the device's own and has
                // never been handed out; it gets its owner as it goes.
                if (held.declaration && !owners.has(held.declaration))
                {
                    owners.set(held.declaration, device);
                }
                fields.writeU32(out >>> 0, held.declaration
                    ? publisher.publish(held.declaration, declarationInterfaces,
                        IID_IDirect3DVertexDeclaration9)
                    : 0);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetFVF: (device, [fvf])=>device.SetFVF(fvf >>> 0),
        /** @param {any} device @param {number[]} args */
        GetFVF: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ fvf?: number }} */
            const held = {};
            const hr = device.GetFVF(held);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0, held.fvf ?? 0);
            }
            return hr;
        },

        // --- shaders ---

        /** @param {any} device @param {number[]} args */
        CreateVertexShader: (device, [tokens, out])=>{
            if ((tokens >>> 0) === 0 || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ shader?: any }} */
            const held = {};
            const hr = device.CreateVertexShader(readTokens(tokens), held);
            if (hr === D3D_OK && held.shader)
            {
                return handBack(held.shader, vertexShaderInterfaces, IID_IDirect3DVertexShader9,
                    out >>> 0, E_OUTOFMEMORY, device);
            }
            fields.writeU32(out >>> 0, 0);
            return hr;
        },
        /** @param {any} device @param {number[]} args */
        SetVertexShader: (device, [shader])=>device.SetVertexShader(publisher.objectAt(shader)),
        /** @param {any} device @param {number[]} args */
        GetVertexShader: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ shader?: any }} */
            const held = {};
            const hr = device.GetVertexShader(held);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0, held.shader
                    ? publisher.publish(held.shader, vertexShaderInterfaces,
                        IID_IDirect3DVertexShader9)
                    : 0);
            }
            return hr;
        },
        SetVertexShaderConstantF: constantSetter('SetVertexShaderConstantF', readFloats, 4),
        GetVertexShaderConstantF: constantGetter('GetVertexShaderConstantF', writeFloats),
        SetVertexShaderConstantI: constantSetter('SetVertexShaderConstantI', readInts, 4),
        GetVertexShaderConstantI: constantGetter('GetVertexShaderConstantI', writeDwords),
        SetVertexShaderConstantB: constantSetter('SetVertexShaderConstantB', readDwords, 1),
        GetVertexShaderConstantB: constantGetter('GetVertexShaderConstantB', writeDwords),

        /** @param {any} device @param {number[]} args */
        CreatePixelShader: (device, [tokens, out])=>{
            if ((tokens >>> 0) === 0 || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ shader?: any }} */
            const held = {};
            const hr = device.CreatePixelShader(readTokens(tokens), held);
            if (hr === D3D_OK && held.shader)
            {
                return handBack(held.shader, pixelShaderInterfaces, IID_IDirect3DPixelShader9,
                    out >>> 0, E_OUTOFMEMORY, device);
            }
            fields.writeU32(out >>> 0, 0);
            return hr;
        },
        /** @param {any} device @param {number[]} args */
        SetPixelShader: (device, [shader])=>device.SetPixelShader(publisher.objectAt(shader)),
        /** @param {any} device @param {number[]} args */
        GetPixelShader: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ shader?: any }} */
            const held = {};
            const hr = device.GetPixelShader(held);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0, held.shader
                    ? publisher.publish(held.shader, pixelShaderInterfaces,
                        IID_IDirect3DPixelShader9)
                    : 0);
            }
            return hr;
        },
        SetPixelShaderConstantF: constantSetter('SetPixelShaderConstantF', readFloats, 4),
        GetPixelShaderConstantF: constantGetter('GetPixelShaderConstantF', writeFloats),
        SetPixelShaderConstantI: constantSetter('SetPixelShaderConstantI', readInts, 4),
        GetPixelShaderConstantI: constantGetter('GetPixelShaderConstantI', writeDwords),
        SetPixelShaderConstantB: constantSetter('SetPixelShaderConstantB', readDwords, 1),
        GetPixelShaderConstantB: constantGetter('GetPixelShaderConstantB', writeDwords),

        // --- streams ---

        /** @param {any} device @param {number[]} args */
        SetStreamSource: (device, [index, buffer, offset, stride])=>device.SetStreamSource(
            index >>> 0, publisher.objectAt(buffer), offset >>> 0, stride >>> 0),

        /** @param {any} device @param {number[]} args */
        GetStreamSource: (device, [index, out, offset, stride])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ buffer?: any, offset?: number, stride?: number }} */
            const held = {};
            const hr = device.GetStreamSource(index >>> 0, held);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0, held.buffer
                    ? publisher.publish(held.buffer, vertexBufferInterfaces,
                        IID_IDirect3DVertexBuffer9)
                    : 0);
                if ((offset >>> 0) !== 0)
                {
                    fields.writeU32(offset >>> 0, held.offset ?? 0);
                }
                if ((stride >>> 0) !== 0)
                {
                    fields.writeU32(stride >>> 0, held.stride ?? 0);
                }
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetStreamSourceFreq: (device, [index, setting])=>
            device.SetStreamSourceFreq(index >>> 0, setting >>> 0),
        /** @param {any} device @param {number[]} args */
        GetStreamSourceFreq: (device, [index, out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ frequency?: number }} */
            const held = {};
            const hr = device.GetStreamSourceFreq(index >>> 0, held);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0, held.frequency ?? 1);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetIndices: (device, [buffer])=>device.SetIndices(publisher.objectAt(buffer)),
        /** @param {any} device @param {number[]} args */
        GetIndices: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ buffer?: any }} */
            const held = {};
            const hr = device.GetIndices(held);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0, held.buffer
                    ? publisher.publish(held.buffer, indexBufferInterfaces,
                        IID_IDirect3DIndexBuffer9)
                    : 0);
            }
            return hr;
        },

        // --- patches and queries ---

        /** @param {any} device */
        DrawRectPatch: (/** @type {any} */ device)=>device.DrawRectPatch(),
        /** @param {any} device */
        DrawTriPatch: (/** @type {any} */ device)=>device.DrawTriPatch(),
        /** @param {any} device */
        DeletePatch: (/** @type {any} */ device)=>device.DeletePatch(),

        /** @param {any} device @param {number[]} args */
        CreateQuery: (device, [type, out])=>{
            /** @type {{ query?: any }} */
            const held = {};
            const hr = device.CreateQuery(type >>> 0, (out >>> 0) === 0 ? null : held);
            if (hr === D3D_OK && (out >>> 0) !== 0 && held.query)
            {
                const shadow = shadowOf(device);
                if (shadow)
                {
                    const query = held.query;
                    query.guestState = ()=>{
                        const block = shadow.attachQuery(query);
                        queryBlocks.set(query, block);
                        return block;
                    };
                }
                return handBack(held.query, queryInterfaces, IID_IDirect3DQuery9, out >>> 0,
                    E_OUTOFMEMORY, device);
            }
            return hr;
        },
    };

    /** @param {any} texture */
    const textureInterfacesFor = texture=>{
        if (texture.cube)
        {
            return cubeTextureInterfaces;
        }
        return texture.volume ? volumeTextureInterfaces : textureInterfaces;
    };

    /** A device method's failure, said once as a divergence (refusals.js). */
    const refusedLoudly = loudRefusals('Direct3D 9', divergence);
    /**
     * Every method first makes what the guest did since the host last looked
     * -- the buffers it let go of, then the calls in the command ring -- so a
     * read, a draw or a present sees the state the program set last, through
     * the same methods a trap would have called; and after it, what the
     * guest's routines check a call against is the device's again.
     *
     * @param {Record<string, any>} methods
     * @returns {Record<string, any>}
     */
    const synced = methods=>Object.fromEntries(Object.entries(methods)
        .map(([name, method])=>[name, (/** @type {any} */ device, /** @type {number[]} */ args)=>{
            return refusedLoudly(name, settledAfter(shadowOf(device), ()=>method(device, args)));
        }]));
    /** @type {Record<string, (builder: { trap: number }) => number>} */
    const deviceGuests = guestsBut(deviceGroup, allocate
        ? {
            GetRenderState: ({ trap })=>placeCode(at=>getRenderStateCode(at, trap)),
            GetTransform: ({ trap })=>placeCode(at=>getTransformCode(at, trap)),
            GetTextureStageState: ({ trap })=>placeCode(at=>getTextureStageStateCode(at, trap,
                STAGE_STATE_TYPES_9)),
            GetViewport: ({ trap })=>placeCode(at=>getViewportCode(at, trap)),
            GetSamplerState: ({ trap })=>placeCode(at=>getSamplerStateCode(at, trap)),
            TestCooperativeLevel: ({ trap })=>placeCode(at=>compiledAt(
                IN_GUEST.TestCooperativeLevel, at, trap)),
            ...Object.fromEntries(Object.entries(COMMANDS).map(([name, shape])=>[name,
                (/** @type {{ trap: number }} */ { trap })=>placeCode(at=>commandCode(at, trap,
                    { ...shape, slot: commandSlot(name), mirror: COMMAND_MIRRORS[name] }))])),
        }
        : {});
    /**
     * The device's setters its command ring carries: what the guest's call
     * would only have written into the ring, a host's call from driven steps
     * makes in place (`answerInPlace`). Not the draws, which may wait.
     */
    const words = guestWords(memory);
    /** @type {Record<string, (call: number[]) => number | undefined>} */
    const IN_PLACE = Object.fromEntries(Object.entries(COMMANDS).filter(([name, shape])=>
        !shape.draws && !shape.self && (!(name in COMMAND_MIRRORS) || name in HOST_COMMAND_MIRRORS))
        .map(([name, shape])=>{
            const placed = { ...shape, slot: commandSlot(name) };
            const mirror = /** @type {Record<string, any>} */ (HOST_COMMAND_MIRRORS)[name];
            return [name, (/** @type {number[]} */ call)=>appendCommand(words, placed, mirror,
                call)];
        }));
    const deviceInterfaces = [
        describe(IID_IDirect3DDevice9, IDIRECT3DDEVICE9_SLOTS, synced(deviceMethods), deviceGuests,
            undefined, IN_PLACE),
    ];

    /**
     * An Ex create: the plain one's surface with a usage beside, and the
     * shared handle the plain interface refuses refused here as well, since
     * nothing here shares a resource across devices.
     *
     * @param {string} method
     * @param {(args: number[]) => { out: number, shared: number,
     *     call: (device: any, held: { surface?: any }) => number }} read
     */
    const exSurfaceCreate = (method, read)=>
        (/** @type {any} */ device, /** @type {number[]} */ args)=>{
            const { out, shared, call } = read(args);
            if (sharedHandleRefused(shared) || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = call(device, held);
            if (hr === D3D_OK && held.surface)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface9,
                    out >>> 0, method === 'CreateOffscreenPlainSurfaceEx'
                        ? E_OUTOFMEMORY
                        : D3DERR_OUTOFVIDEOMEMORY, device);
            }
            return hr;
        };

    /**
     * IDirect3DDevice9Ex's own slots. SetConvolutionMonoKernel and
     * ComposeRects, which build a one-bit surface out of another's
     * rectangles, are absent.
     */
    const exDeviceMethods = {
        // The flags ask not to wait for the display, which nothing here
        // does, or not to show the frame, which is not honoured.
        /** @param {any} device */
        PresentEx: (/** @type {any} */ device)=>deviceMethods.Present(device),
        /** @param {any} device @param {number[]} args */
        GetGPUThreadPriority: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ priority?: number }} */
            const held = {};
            const hr = device.GetGPUThreadPriority(held);
            fields.writeU32(out >>> 0, (held.priority ?? 0) >>> 0);
            return hr;
        },
        /** @param {any} device @param {number[]} args */
        SetGPUThreadPriority: (device, [priority])=>device.SetGPUThreadPriority(priority | 0),
        /** @param {any} device @param {number[]} args */
        WaitForVBlank: (device, [chain])=>device.WaitForVBlank(chain >>> 0),
        /** @param {any} device @param {number[]} args */
        CheckResourceResidency: (device, [, count])=>device.CheckResourceResidency(count >>> 0),
        /** @param {any} device @param {number[]} args */
        SetMaximumFrameLatency: (device, [latency])=>device.SetMaximumFrameLatency(latency >>> 0),
        /** @param {any} device @param {number[]} args */
        GetMaximumFrameLatency: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ latency?: number }} */
            const held = {};
            const hr = device.GetMaximumFrameLatency(held);
            fields.writeU32(out >>> 0, held.latency ?? 0);
            return hr;
        },
        /** @param {any} device @param {number[]} args */
        CheckDeviceState: (device, [window])=>device.CheckDeviceState(window >>> 0),
        CreateRenderTargetEx: exSurfaceCreate('CreateRenderTargetEx',
            ([width, height, format, , , lockable, out, shared, usage])=>({
                out, shared,
                call: (device, held)=>device.CreateRenderTargetEx(width >>> 0, height >>> 0,
                    format >>> 0, lockable !== 0, usage >>> 0, held),
            })),
        CreateOffscreenPlainSurfaceEx: exSurfaceCreate('CreateOffscreenPlainSurfaceEx',
            ([width, height, format, pool, out, shared, usage])=>({
                out, shared,
                call: (device, held)=>device.CreateOffscreenPlainSurfaceEx(width >>> 0,
                    height >>> 0, format >>> 0, pool >>> 0, usage >>> 0, held),
            })),
        CreateDepthStencilSurfaceEx: exSurfaceCreate('CreateDepthStencilSurfaceEx',
            ([width, height, format, , , , out, shared, usage])=>({
                out, shared,
                call: (device, held)=>device.CreateDepthStencilSurfaceEx(width >>> 0,
                    height >>> 0, format >>> 0, usage >>> 0, held),
            })),
        /** @param {any} device @param {number[]} args */
        ResetEx: (device, [parameters, mode])=>((parameters >>> 0) === 0
            || !modeFits(parameters >>> 0, mode >>> 0)
            ? D3DERR_INVALIDCALL
            : deviceMethods.Reset(device, [parameters])),
        /** @param {any} device @param {number[]} args */
        GetDisplayModeEx: (device, [chain, mode, rotation])=>((chain >>> 0) !== 0
            ? D3DERR_INVALIDCALL
            : writeDisplayModeEx(mode, rotation)),
    };

    /**
     * A device made through IDirect3D9Ex, which answers IDirect3DDevice9Ex as
     * well; one made through the plain interface does not (Wine's d3d9ex.c
     * test_qi_base_to_ex and test_qi_ex_to_base).
     *
     * @type {import('./com.js').InterfaceDescriptor[]}
     */
    const exDeviceInterfaces = [
        describe(IID_IDirect3DDevice9Ex, [...IDIRECT3DDEVICE9_SLOTS, ...IDIRECT3DDEVICE9EX_SLOTS],
            synced({ ...deviceMethods, ...exDeviceMethods }), deviceGuests, undefined, IN_PLACE),
        ...deviceInterfaces,
    ];

    /** @param {any} device */
    const deviceInterfacesOf = device=>(device?.extended ? exDeviceInterfaces : deviceInterfaces);

    /**
     * Whether the display mode an Ex create or reset names fits its
     * parameters: none for a window, and for fullscreen one of the back
     * buffer's own size, which may not be zero (Wine's d3d9ex.c test_reset_ex).
     *
     * @param {number} parameters @param {number} mode
     */
    const modeFits = (parameters, mode)=>{
        const raw = fields.readStruct(parameters, D3DPRESENT_PARAMETERS9);
        if (raw.Windowed !== 0)
        {
            return mode === 0;
        }
        if (mode === 0)
        {
            return false;
        }
        const asked = fields.readStruct(mode, D3DDISPLAYMODEEX);
        return asked.Width !== 0 && asked.Height !== 0
            && asked.Width === (raw.BackBufferWidth >>> 0)
            && asked.Height === (raw.BackBufferHeight >>> 0);
    };

    /**
     * @param {number} address
     * @param {number} [window]
     *        The window the device presents into when the parameters name
     *        none: the focus window a creation was given, or the window a
     *        previous device was made into.
     */
    const readPresentParameters = (address, window = 0)=>{
        const raw = fields.readStruct(address, D3DPRESENT_PARAMETERS9);
        const display = screen();
        // A size asked for as zero by zero means the device window's client
        // area, which is what the real device answers and what the program's
        // own layout is measured against. Fullscreen has no window to measure
        // -- its window is about to become the mode -- so the display stands
        // for the mode there, and a windowed window this layer cannot measure
        // falls back to the display. Zero is not a size any device can be made
        // at: one made at zero leaves the program computing its layout against
        // a screen that is not there.
        const windowed = raw.Windowed !== 0;
        const named = windowed ? ((raw.hDeviceWindow >>> 0) || (window >>> 0)) : 0;
        const measured = named === 0 ? null : windowClientSize?.(named) ?? null;
        if (windowed && measured === null
            && ((raw.BackBufferWidth >>> 0) === 0 || (raw.BackBufferHeight >>> 0) === 0))
        {
            divergence?.('Direct3D 9',
                'a back buffer asked for as zero by zero is the size of the device window,'
                + ' and that window could not be measured: the configured display is'
                + ' used instead');
        }
        const taken = measured ?? display;
        return {
            backBufferWidth: (raw.BackBufferWidth >>> 0) || taken.width,
            backBufferHeight: (raw.BackBufferHeight >>> 0) || taken.height,
            backBufferFormat: raw.BackBufferFormat || D3DFMT.X8R8G8B8,
            backBufferCount: raw.BackBufferCount,
            multiSampleType: raw.MultiSampleType,
            swapEffect: raw.SwapEffect,
            hDeviceWindow: raw.hDeviceWindow,
            windowed,
            enableAutoDepthStencil: raw.EnableAutoDepthStencil !== 0,
            autoDepthStencilFormat: raw.AutoDepthStencilFormat,
            flags: raw.Flags,
            lockableBackBuffer: (raw.Flags & LOCKABLE_BACKBUFFER) !== 0,
            fullScreenRefreshRateInHz: raw.FullScreen_RefreshRateInHz,
            presentationInterval: raw.PresentationInterval,
        };
    };

    /**
     * Whether a full-screen back buffer is a size the display can be set to.
     * Windows refuses one that is not -- zero by zero among them, which only a
     * window can stand for -- and a program that asks for one goes another
     * way on the refusal (Wine's test_reset: 0x0, 32x32 and 801x600 are
     * D3DERR_INVALIDCALL). A windowed one is any size.
     *
     * @param {number} address
     */
    const fullScreenUnlikeAnyMode = address=>{
        const raw = fields.readStruct(address, D3DPRESENT_PARAMETERS9);
        if (raw.Windowed !== 0)
        {
            return false;
        }
        const width = raw.BackBufferWidth >>> 0;
        const height = raw.BackBufferHeight >>> 0;
        return !displayModes(screen()).some(mode=>mode.width === width && mode.height === height);
    };

    /**
     * What this version fills in on the way out: the size and format a zero
     * or unknown stood for, and the count a zero stood for.
     *
     * @param {number} address @param {any} parameters
     */
    const writePresentParameters = (address, parameters)=>{
        fields.writeStruct(address, D3DPRESENT_PARAMETERS9, {
            BackBufferWidth: parameters.backBufferWidth,
            BackBufferHeight: parameters.backBufferHeight,
            BackBufferFormat: parameters.backBufferFormat,
            BackBufferCount: parameters.backBufferCount || 1,
        });
    };

    /** @param {number} address @param {any} parameters */
    const writeAllPresentParameters = (address, parameters)=>{
        fields.writeStruct(address, D3DPRESENT_PARAMETERS9, {
            BackBufferWidth: parameters.backBufferWidth ?? 0,
            BackBufferHeight: parameters.backBufferHeight ?? 0,
            BackBufferFormat: parameters.backBufferFormat ?? 0,
            BackBufferCount: parameters.backBufferCount ?? 1,
            MultiSampleType: 0,
            MultiSampleQuality: 0,
            SwapEffect: parameters.swapEffect ?? 0,
            hDeviceWindow: parameters.hDeviceWindow ?? 0,
            Windowed: parameters.windowed === false ? 0 : 1,
            EnableAutoDepthStencil: parameters.enableAutoDepthStencil ? 1 : 0,
            AutoDepthStencilFormat: parameters.autoDepthStencilFormat ?? 0,
            Flags: parameters.flags ?? 0,
            FullScreen_RefreshRateInHz: 0,
            PresentationInterval: parameters.presentationInterval ?? 0,
        });
    };

    /**
     * D3DADAPTER_IDENTIFIER9, from what the assembling caller knows of the
     * hardware: the vendor, name and GUID every generation reports.
     *
     * @param {number} address @param {number} flags D3DENUM_*
     */
    const writeAdapterIdentifier = (address, flags)=>{
        const { vendorId, deviceId, description } = describeAdapter(identity?.() ?? null);
        const block = new Uint8Array(D3DADAPTER_IDENTIFIER9.FIELDS);
        /** @param {string} text @param {number} at @param {number} room */
        const ascii = (text, at, room)=>{
            for (let index = 0; index < Math.min(text.length, room - 1); index++)
            {
                block[at + index] = text.charCodeAt(index) & 0x7f;
            }
        };
        ascii('webgpu', D3DADAPTER_IDENTIFIER9.Driver, ADAPTER_STRING_LENGTH);
        ascii(description, D3DADAPTER_IDENTIFIER9.Description, ADAPTER_STRING_LENGTH);
        ascii('\\\\.\\DISPLAY1', D3DADAPTER_IDENTIFIER9.DeviceName, 32);
        const view = new DataView(block.buffer);
        view.setUint32(D3DADAPTER_IDENTIFIER9.DriverVersion + 4, 0x00010000, true);
        view.setUint32(D3DADAPTER_IDENTIFIER9.VendorId, vendorId, true);
        view.setUint32(D3DADAPTER_IDENTIFIER9.DeviceId, deviceId, true);
        block.set(ADAPTER_GUID, D3DADAPTER_IDENTIFIER9.DeviceIdentifier);
        view.setUint32(D3DADAPTER_IDENTIFIER9.WHQLLevel,
            (flags & D3DENUM_NO_WHQL_LEVEL) !== 0 ? 0 : 1, true);
        memory.writeMemory(address, block);
    };

    /**
     * The capability block. Zeroed first: the structure is long, a caller
     * allocates all of it, and every field has to read as something.
     *
     * @param {number} address @param {import('../d3d9/device.js').DeviceCaps} caps
     * @param {{ deviceType?: number, adapterOrdinal?: number }} [who]
     */
    const writeCaps = (address, caps, who = {})=>{
        memory.writeMemory(address, new Uint8Array(D3DCAPS9.SIZE));
        fields.writeStruct(address, D3DCAPS9, capabilityWords(caps, who), [...D3DCAPS9_FLOATS]);
    };

    /**
     * The modes the adapter offers in one format, in the order a program
     * walks them. This version enumerates per format, so the list is the
     * display's sizes and nothing else; a format the adapter does not show
     * has no modes.
     *
     * @param {number} format
     */
    const adapterModes = format=>(ADAPTER_FORMATS.has(format) ? displayModes(screen()) : []);

    /** @type {ReadonlySet<number>} the device types this version names */
    const DEVICE_TYPES = new Set(Object.values(D3DDEVTYPE));
    const VERTEX_PROCESSING = D3DCREATE.SOFTWARE_VERTEXPROCESSING
        | D3DCREATE.HARDWARE_VERTEXPROCESSING | D3DCREATE.MIXED_VERTEXPROCESSING;

    const rootMethods = {
        // Accepted and ignored: no software rasteriser is ever plugged in.
        RegisterSoftwareDevice: ()=>D3D_OK,
        GetAdapterCount: ()=>1,

        /** @param {any} root @param {number[]} args */
        GetAdapterIdentifier: (root, [adapter, flags, out])=>{
            if ((adapter >>> 0) !== 0 || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            writeAdapterIdentifier(out >>> 0, flags >>> 0);
            return D3D_OK;
        },

        /** @param {any} root @param {number[]} args */
        GetAdapterModeCount: (root, [adapter, format])=>((adapter >>> 0) !== 0
            ? 0
            : adapterModes(format >>> 0).length),

        /** @param {any} root @param {number[]} args */
        EnumAdapterModes: (root, [adapter, format, mode, out])=>{
            const listed = adapterModes(format >>> 0)[mode >>> 0];
            if ((adapter >>> 0) !== 0 || (out >>> 0) === 0 || !listed)
            {
                return D3DERR_INVALIDCALL;
            }
            fields.writeStruct(out >>> 0, D3DDISPLAYMODE, {
                Width: listed.width,
                Height: listed.height,
                RefreshRate: listed.refresh,
                Format: format >>> 0,
            });
            return D3D_OK;
        },

        /** @param {any} root @param {number[]} args */
        GetAdapterDisplayMode: (root, [adapter, out])=>{
            if ((adapter >>> 0) !== 0 || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            writeDisplayMode(out >>> 0);
            return D3D_OK;
        },

        /** @param {any} root @param {number[]} args */
        CheckDeviceType: (root, [adapter, , adapterFormat, backBufferFormat, windowed])=>(
            (adapter >>> 0) !== 0
                ? D3DERR_INVALIDCALL
                : root.CheckDeviceType(adapterFormat >>> 0, backBufferFormat >>> 0,
                    (windowed >>> 0) !== 0)),

        /** @param {any} root @param {number[]} args */
        CheckDeviceFormat: (root, [adapter, , , usage, resourceType, format])=>(
            (adapter >>> 0) !== 0
                ? D3DERR_INVALIDCALL
                : root.CheckDeviceFormat(usage >>> 0, resourceType >>> 0, format >>> 0)),

        /** @param {any} root @param {number[]} args */
        CheckDeviceMultiSampleType: (root, [adapter, , , , type, out])=>{
            if ((adapter >>> 0) !== 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ qualityLevels?: number }} */
            const held = {};
            const hr = root.CheckDeviceMultiSampleType(type >>> 0, held);
            if (hr === D3D_OK && (out >>> 0) !== 0)
            {
                fields.writeU32(out >>> 0, held.qualityLevels ?? 1);
            }
            return hr;
        },

        /** @param {any} root @param {number[]} args */
        CheckDepthStencilMatch: (root, [adapter, , , targetFormat, depthFormat])=>(
            (adapter >>> 0) !== 0
                ? D3DERR_INVALIDCALL
                : root.CheckDepthStencilMatch(targetFormat >>> 0, depthFormat >>> 0)),

        /** @param {any} root @param {number[]} args */
        CheckDeviceFormatConversion: (root, [adapter, , source, target])=>(
            (adapter >>> 0) !== 0
                ? D3DERR_INVALIDCALL
                : root.CheckDeviceFormatConversion(source >>> 0, target >>> 0)),

        /** @param {any} root @param {number[]} args */
        GetDeviceCaps: (root, [adapter, deviceType, out])=>{
            if ((adapter >>> 0) !== 0 || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            writeCaps(out >>> 0, root.caps, { deviceType: deviceType >>> 0, adapterOrdinal: 0 });
            return D3D_OK;
        },

        // The display user32 names for every window; no second adapter has one.
        /** @param {any} root @param {number[]} args */
        GetAdapterMonitor: (root, [adapter])=>((adapter >>> 0) === 0 ? PRIMARY_MONITOR : 0),

        /** @param {any} root @param {number[]} args */
        CreateDevice: (root, args)=>createDevice(root, args, IID_IDirect3DDevice9),
    };

    /**
     * The device, made the way a program makes one. The adapter must be the
     * one there is, the type one this version names, and the behaviour must
     * name exactly one kind of vertex processing. A device made through
     * IDirect3D9Ex is Direct3D 9Ex's, whichever create made it.
     *
     * @param {any} root @param {number[]} args
     * @param {string} id  The interface the pointer handed back is.
     */
    const createDevice = (root, args, id)=>{
        const [adapter, deviceType, focus, behaviourFlags, parameters, out] = args;
        if ((out >>> 0) === 0)
        {
            return D3DERR_INVALIDCALL;
        }
        const processing = (behaviourFlags >>> 0) & VERTEX_PROCESSING;
        if ((adapter >>> 0) !== 0 || !DEVICE_TYPES.has(deviceType >>> 0)
            || (parameters >>> 0) === 0
            || processing === 0 || (processing & (processing - 1)) !== 0)
        {
            fields.writeU32(out >>> 0, 0);
            return D3DERR_INVALIDCALL;
        }
        if (fullScreenUnlikeAnyMode(parameters >>> 0))
        {
            fields.writeU32(out >>> 0, 0);
            return D3DERR_INVALIDCALL;
        }
        const wanted = readPresentParameters(parameters >>> 0, focus >>> 0);
        /** @type {{ device?: any }} */
        const held = {};
        const hr = root.CreateDevice(wanted, held, behaviourFlags >>> 0, {
            AdapterOrdinal: adapter >>> 0,
            DeviceType: deviceType >>> 0,
            hFocusWindow: focus >>> 0,
        }, exRoots.has(root));
        if (hr !== D3D_OK || !held.device)
        {
            fields.writeU32(out >>> 0, 0);
            return hr;
        }
        writePresentParameters(parameters >>> 0, wanted);
        lastParameters = wanted;
        if (allocate)
        {
            // Made before the interface is published, because publishing is
            // when the block's address is written one word past `this`.
            /** @type {ReturnType<typeof createShadow>} */
            const shadow = createShadow({
                ringBytes,
                allocate,
                readMemory: memory.windowMemory ?? memory.readMemory,
                readU32: memory.readU32,
                writeMemory: memory.writeMemory,
                compareExchangeU32: memory.compareExchangeU32,
                device: held.device,
                divergence,
                phases,
                // The buffers settled and the ring played as one pause: a
                // recording compares a dynamic buffer once in it.
                still: work=>{
                    if (typeof held.device.whileStill === 'function')
                    {
                        held.device.whileStill(work);
                        return;
                    }
                    work();
                },
                name: 'IDirect3DDevice9',
                commands: { take: records=>{
                    const objects = commandObjects(records, publisher.objectAt);
                    const made = held.device.commands(records, objects);
                    if (shadow.stale())
                    {
                        // A state block applied or a target set in the ring:
                        // the block is brought to what the blocks the run
                        // names hold and to the viewport, and the getters may
                        // read it again.
                        for (const object of objects)
                        {
                            if (stateBlocks.has(object))
                            {
                                shadow.remirror(touchedBy(object.record));
                            }
                        }
                        shadow.remirror({ viewport: true });
                        // And what a draw is checked against: the bindings
                        // the block set are the device's now.
                        shadow.settled();
                        shadow.fresh();
                    }
                    return made;
                } },
            });
            shadows.set(held.device, shadow);
            held.device.guestState = ()=>shadow.address();
            // The device's count holds what is bound at a count of zero
            // until it is unbound, which may be a record in the ring.
            held.device.settleGuestRefs = ()=>shadow.sync();
        }
        // The window is now this resolution; the reported screen is too.
        // Fullscreen, the device's window follows the mode, as the real
        // device moves it; windowed, the window is the program's own. The
        // window is kept for a later Reset, whose present parameters need
        // not repeat it.
        deviceWindow = (wanted.hDeviceWindow >>> 0) || (focus >>> 0);
        takeScreen(held.device, wanted, deviceWindow);
        const result = handBack(held.device, deviceInterfacesOf(held.device), id,
            out >>> 0, D3DERR_OUTOFVIDEOMEMORY);
        if (result === D3D_OK)
        {
            lastDevice = held.device;
        }
        return result;
    };

    /** The roots Direct3DCreate9Ex made. @type {WeakSet<object>} */
    const exRoots = new WeakSet();

    /**
     * The modes an Ex enumeration lists: the display's sizes in the format
     * the filter names, the adapter's own format without one. Every mode is
     * progressive, so a filter asking for interlaced lines lists none.
     *
     * @param {number} filter
     */
    const filteredModes = filter=>{
        if ((filter >>> 0) === 0)
        {
            return adapterModes(D3DFMT.X8R8G8B8);
        }
        const asked = fields.readStruct(filter >>> 0, D3DDISPLAYMODEFILTER);
        return asked.ScanLineOrdering === D3DSCANLINEORDERING_INTERLACED
            ? []
            : adapterModes(asked.Format >>> 0);
    };

    /** IDirect3D9Ex's own slots. */
    const rootExMethods = {
        /** @param {any} root @param {number[]} args */
        GetAdapterModeCountEx: (root, [adapter, filter])=>((adapter >>> 0) !== 0
            ? 0
            : filteredModes(filter).length),
        /** @param {any} root @param {number[]} args */
        EnumAdapterModesEx: (root, [adapter, filter, mode, out])=>{
            const listed = (adapter >>> 0) === 0 ? filteredModes(filter)[mode >>> 0] : undefined;
            if (!listed || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            fields.writeStruct(out >>> 0, D3DDISPLAYMODEEX, {
                Size: D3DDISPLAYMODEEX.SIZE,
                Width: listed.width,
                Height: listed.height,
                RefreshRate: listed.refresh,
                Format: (filter >>> 0) === 0
                    ? D3DFMT.X8R8G8B8
                    : fields.readU32((filter >>> 0) + D3DDISPLAYMODEFILTER.Format),
                ScanLineOrdering: D3DSCANLINEORDERING_PROGRESSIVE,
            });
            return D3D_OK;
        },
        /** @param {any} root @param {number[]} args */
        GetAdapterDisplayModeEx: (root, [adapter, mode, rotation])=>((adapter >>> 0) !== 0
            ? D3DERR_INVALIDCALL
            : writeDisplayModeEx(mode, rotation)),
        /** @param {any} root @param {number[]} args */
        CreateDeviceEx: (root, args)=>{
            const [adapter, deviceType, focus, behaviourFlags, parameters, mode, out] = args;
            if ((parameters >>> 0) !== 0 && !modeFits(parameters >>> 0, mode >>> 0))
            {
                if ((out >>> 0) !== 0)
                {
                    fields.writeU32(out >>> 0, 0);
                }
                return D3DERR_INVALIDCALL;
            }
            return createDevice(root,
                [adapter, deviceType, focus, behaviourFlags, parameters, out],
                IID_IDirect3DDevice9Ex);
        },
        // The one adapter's locally unique identifier: any value that is its
        // own, and stays so.
        /** @param {any} root @param {number[]} args */
        GetAdapterLUID: (root, [adapter, out])=>{
            if ((adapter >>> 0) !== 0 || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            fields.writeU32(out >>> 0, ADAPTER_LUID);
            fields.writeU32((out >>> 0) + 4, 0);
            return D3D_OK;
        },
    };

    /** Tells the taker the cursor the device holds, when it changed. */
    const tellCursor = cursor ? createCursorTeller(cursor, memory.readMemory) : ()=>{};

    // A device made without FPU_PRESERVE sets the calling thread's x87 as
    // Direct3D does, in the guest, before the method's trap (`fpu.js`).
    /** @type {Record<string, (builder: { trap: number }) => number>} */
    const fpuGuests = allocate ? Object.fromEntries(['CreateDevice', 'CreateDeviceEx'].map(name=>
        [name, (/** @type {{ trap: number }} */ { trap })=>placeCode(at=>fpuSetupCode(at, trap))]))
        : {};
    const rootInterfaces = [describe(IID_IDirect3D9, IDIRECT3D9_SLOTS, rootMethods, fpuGuests)];

    /**
     * The object Direct3DCreate9Ex hands back, which answers IDirect3D9 as
     * well; the plain one does not answer IDirect3D9Ex.
     *
     * @type {import('./com.js').InterfaceDescriptor[]}
     */
    const rootExInterfaces = [
        describe(IID_IDirect3D9Ex, [...IDIRECT3D9_SLOTS, ...IDIRECT3D9EX_SLOTS],
            { ...rootMethods, ...rootExMethods }, fpuGuests),
        ...rootInterfaces,
    ];

    /** @type {any} */
    let lastDevice = null;
    /** The present parameters the last device was created or reset with. @type {any} */
    let lastParameters = null;
    /** @type {WeakSet<any>} devices whose window has been told the mode at a first frame */
    const announced = new WeakSet();
    // The window the last device was created into. A Reset's present
    // parameters name it too, but not always -- a program may leave it zero --
    // and the window a reset leaves at the wrong size is one the program then
    // clips its cursor to.
    let deviceWindow = 0;

    /**
     * The screen a windowed device takes, kept until it shows its first frame
     * (`showScreen`). A windowed device sets no display mode: it shows its
     * frames in its window, and here its window is the screen -- once it has
     * a frame to show. One made to convert textures or to read what the card
     * can do, on a window nobody sees, shows none and leaves the screen as it
     * was; taken at its creation, an 8 by 8 back buffer was the screen every
     * window after it was centred on.
     *
     * @type {WeakMap<any, { width: number, height: number, window: number }>}
     */
    const unshown = new WeakMap();

    /**
     * What a created or reset device does to the screen: a fullscreen one
     * takes it now, at its mode, with its window; a windowed one at its first
     * frame.
     *
     * @param {any} device @param {any} parameters @param {number} window
     */
    const takeScreen = (device, parameters, window)=>{
        const width = parameters.backBufferWidth >>> 0;
        const height = parameters.backBufferHeight >>> 0;
        if (parameters.windowed)
        {
            unshown.set(device, { width, height, window });
            return;
        }
        unshown.delete(device);
        resolution?.(width, height, { window, fullscreen: true });
    };

    /**
     * A windowed device's first frame: its window is the screen from now on.
     *
     * @param {any} device
     */
    const showScreen = device=>{
        const pending = device ? unshown.get(device) : undefined;
        if (pending)
        {
            unshown.delete(device);
            resolution?.(pending.width, pending.height,
                { window: pending.window, fullscreen: false });
        }
    };

    /** The device an implicit swap chain GetSwapChain handed out belongs to. @type {WeakMap<any, any>} */
    const chainOwners = new WeakMap();

    return {
        /**
         * Publishes the object Direct3DCreate9 hands back.
         *
         * @param {any} root  What graphics.create('d3d9') returned.
         */
        publishRoot: (/** @type {any} */ root)=>publisher.publish(root, rootInterfaces, IID_IDirect3D9),

        /**
         * What Direct3DCreate9Ex does with the object graphics.create('d3d9')
         * returned: an IDirect3D9Ex, through the pointer it was handed.
         *
         * @param {any} root  Null when this build has no Direct3D 9.
         * @param {number} out
         * @returns {number} HRESULT
         */
        publishRootEx: (/** @type {any} */ root, /** @type {number} */ out)=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            if (!root)
            {
                fields.writeU32(out >>> 0, 0);
                return D3DERR_NOTAVAILABLE;
            }
            exRoots.add(root);
            return handBack(root, rootExInterfaces, IID_IDirect3D9Ex, out >>> 0);
        },

        /** What the device this program is drawing through has counted. */
        diagnostics: ()=>lastDevice?.diagnostics?.() ?? null,

        /**
         * How Presents were paced (`createPresentQueue`): the interval and the
         * rate they were held to, and the mode the device asked for.
         */
        presentPacing: ()=>({ ...presents.diagnostics(),
            windowed: lastParameters ? Boolean(lastParameters.windowed) : null,
            askedHz: lastParameters ? lastParameters.fullScreenRefreshRateInHz >>> 0 : null }),

        /** What that device's program set in the guest, and the calls that never crossed. */
        shadow: ()=>(lastDevice ? shadowOf(lastDevice)?.diagnostics() ?? null : null),

        /** For tests, which have no guest to call through. */
        interfaces: {
            root: rootInterfaces, device: deviceInterfaces, surface: surfaceInterfaces,
            texture: textureInterfaces, vertexBuffer: vertexBufferInterfaces,
            indexBuffer: indexBufferInterfaces, declaration: declarationInterfaces,
            vertexShader: vertexShaderInterfaces, pixelShader: pixelShaderInterfaces,
            stateBlock: stateBlockInterfaces, query: queryInterfaces,
            swapChain: swapChainInterfaces, rootEx: rootExInterfaces,
            deviceEx: exDeviceInterfaces, swapChainEx: exSwapChainInterfaces,
        },
    };
}
