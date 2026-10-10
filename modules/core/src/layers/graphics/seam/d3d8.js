/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 8, between a guest call and the object that implements it.
 *
 * Everything here is translation and nothing is behaviour: a slot reads the
 * arguments the guest pushed, turns pointers into structures and interface
 * pointers into objects, calls the method that already exists in `d3d8/`, and
 * writes back whatever the caller left room for. When a method is missing from
 * a table below it is missing on purpose -- the slot is still declared, so
 * every later slot is at the index the guest compiled against, and calling it
 * answers E_NOTIMPL, which is a reply a program handles.
 *
 * A slot that answers a failure code rather than doing the thing asked of it is
 * making the same point more loudly: a shader of a version the caps do not
 * claim is refused, because the renderer behind this cannot honour what
 * succeeding would promise. A refusal is a reply a program acts on -- usually
 * by taking the path this build does draw -- where a success it cannot see
 * through leaves it drawing nothing and looking somewhere else for the reason.
 *
 * Out-parameters are where this is easy to get wrong in a way nothing reports.
 * A method that hands back an interface writes a pointer *and* takes a
 * reference; one that hands back a number writes it only if the caller passed
 * somewhere to put it. Both are done here rather than in the API objects,
 * because both are facts about the ABI rather than about Direct3D.
 */

import { describe, IDIRECT3D8_SLOTS, IDIRECT3DBASETEXTURE8_SLOTS, IDIRECT3DCUBETEXTURE8_SLOTS,
    IDIRECT3DDEVICE8_SLOTS, IDIRECT3DSWAPCHAIN8_SLOTS,
    IDIRECT3DRESOURCE8_SLOTS, IDIRECT3DSURFACE8_SLOTS, IDIRECT3DTEXTURE8_SLOTS,
    IDIRECT3DVERTEXBUFFER8_SLOTS, IDIRECT3DINDEXBUFFER8_SLOTS, IDIRECT3DVOLUME8_SLOTS,
    IDIRECT3DVOLUMETEXTURE8_SLOTS } from './vtables.js';
import { IID_IDirect3D8, IID_IDirect3DBaseTexture8, IID_IDirect3DCubeTexture8,
    IID_IDirect3DDevice8,
    IID_IDirect3DIndexBuffer8, IID_IDirect3DResource8, IID_IDirect3DSurface8,
    IID_IDirect3DTexture8, IID_IDirect3DVertexBuffer8, IID_IDirect3DVolume8,
    IID_IDirect3DVolumeTexture8, IID_IDirect3DSwapChain8 } from './iids.js';
import { D3DINDEXBUFFER_DESC9, D3DVERTEXBUFFER_DESC9 } from '../d3d9/structs.js';
import { queryAs, readGuid } from './guid.js';
import { D3DPRESENT_PARAMETERS8, D3DDISPLAYMODE, D3DVIEWPORT8, D3DCAPS8,
    D3DSURFACE_DESC8, D3DLOCKED_RECT, D3DLIGHT7, RECT, POINT, createFields,
    D3DBOX, D3DLOCKED_BOX, D3DVOLUME_DESC8, createLightReader, dwordsOf, floatsOf, putLight,
    putMaterial } from './structs.js';
import { D3DDEVTYPE, D3DFMT_INDEX, D3DRTYPE, PRIMARY_MONITOR } from '../d3d8/constants.js';
import { REFRESH_HZ, displayModes } from '../../win32/user32/display.js';
import { ADAPTER_STRING_LENGTH, D3DADAPTER_IDENTIFIER8, D3DCLIPSTATUS8,
    D3DDEVICE_CREATION_PARAMETERS, D3DGAMMARAMP, D3DRASTER_STATUS,
    GAMMA_RAMP_ENTRIES } from '../d3d8/structs.js';
import { vertexCountOf } from '../d3d8/render.js';
import { PALETTE_BYTES } from '../d3d9/device.js';
import { createCursorTeller } from './cursor.js';
import { ADAPTER_GUID, describeAdapter } from './adapter.js';
import { createRaster, rasterStatus } from './raster.js';
import { TEXTURE_OP_CAPS } from '../d3d8/validity.js';
import { D3D_PRIVATE_DATA, createPrivateData } from './privatedata.js';
import { declarationLength } from '../d3d8/declaration.js';
import { END_TOKEN } from '../d3d9/shader.js';
import {
    DRAWABLE_MIRRORS, RENDER_STATE_MIRROR, TRANSFORM_MIRROR, VIEWPORT_GUARD_8, VIEWPORT_MIRROR,
    commandCode, createShadow, settledAfter,
    getRenderStateCode, getSurfaceLevelCode, getTextureStageStateCode, getTransformCode,
    getViewportCode, lockCode, stageStateMirror, unlockCode,
} from './shadow.js';
import { D3D8_COMMANDS, materialOf } from '../d3d8/commands.js';
import { D3DTSS } from '../d3d8/constants.js';
import { loudRefusals } from './refusals.js';

/** Direct3D 8's stage state types below 32, a bit each: what the block keeps for them. */
const STAGE_STATE_TYPES_8 = Object.values(D3DTSS)
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
    SetTextureStageState: stageStateMirror(STAGE_STATE_TYPES_8),
    SetViewport: [...VIEWPORT_GUARD_8, ...VIEWPORT_MIRROR],
    BeginScene: [...DRAWABLE_MIRRORS.BeginScene],
    EndScene: [...DRAWABLE_MIRRORS.EndScene],
    SetVertexShader: [...DRAWABLE_MIRRORS.SetVertexShader8],
    SetStreamSource: [...DRAWABLE_MIRRORS.SetStreamSource8],
    SetIndices: [...DRAWABLE_MIRRORS.SetIndices],
    DrawPrimitiveUP: [...DRAWABLE_MIRRORS.DrawPrimitiveUP],
};

/**
 * The capability bits reported by GetDeviceCaps.
 *
 * Named from d3d8caps.h rather than written as one hexadecimal blob, because a
 * blob is unreviewable: nobody can tell a claim we can honour from one we
 * cannot, and every one of these is a claim a program acts on.
 */
const D3DCAPS_READ_SCANLINE = 0x00020000;
const D3DVS_VERSION_MARK = 0xfffe0000;
const D3DPS_VERSION_MARK = 0xffff0000;

/** Past this many tokens a shader function with no end token is not one. */
const MAX_SHADER_DWORDS = 1 << 16;

/** A pixel shader's constant registers, c0 to c7. */
const PIXEL_SHADER_CONSTANTS = 8;

// A colour cursor at any resolution: the device keeps the bitmap a program
// hands it and the host shows it over the frame. A device that claims neither
// sends a program down its own drawing path for the cursor, which a program
// tests far less than the one it takes on hardware.
const D3DCURSORCAPS_COLOR = 0x00000001;
const D3DCURSORCAPS_LOWRES = 0x00000002;
const D3DCAPS2_CANRENDERWINDOWED = 0x00080000;
const D3DCAPS2_FULLSCREENGAMMA = 0x00020000;

const D3DPRESENT_INTERVAL_ONE = 0x00000001;
const D3DPRESENT_INTERVAL_IMMEDIATE = 0x80000000;

const D3DDEVCAPS_EXECUTESYSTEMMEMORY = 0x00000010;
const D3DDEVCAPS_TEXTUREVIDEOMEMORY = 0x00000200;
const D3DDEVCAPS_DRAWPRIMTLVERTEX = 0x00000400;
const D3DDEVCAPS_CANRENDERAFTERFLIP = 0x00000800;
const D3DDEVCAPS_TEXTURENONLOCALVIDMEM = 0x00001000;
const D3DDEVCAPS_DRAWPRIMITIVES2 = 0x00002000;
const D3DDEVCAPS_DRAWPRIMITIVES2EX = 0x00008000;
const D3DDEVCAPS_HWTRANSFORMANDLIGHT = 0x00010000;
const D3DDEVCAPS_HWRASTERIZATION = 0x00080000;

const D3DPMISCCAPS_MASKZ = 0x00000002;
const D3DPMISCCAPS_CULLNONE = 0x00000010;
const D3DPMISCCAPS_CULLCW = 0x00000020;
const D3DPMISCCAPS_CULLCCW = 0x00000040;
const D3DPMISCCAPS_COLORWRITEENABLE = 0x00000080;
const D3DPMISCCAPS_TSSARGTEMP = 0x00000400;
const D3DPMISCCAPS_BLENDOP = 0x00000800;

const D3DPRASTERCAPS_DITHER = 0x00000001;
const D3DPRASTERCAPS_ZTEST = 0x00000010;
const D3DPRASTERCAPS_FOGVERTEX = 0x00000080;
const D3DPRASTERCAPS_FOGTABLE = 0x00000100;
const D3DPRASTERCAPS_FOGRANGE = 0x00010000;
const D3DPRASTERCAPS_WFOG = 0x00100000;
const D3DPRASTERCAPS_ZFOG = 0x00200000;

/** NEVER, LESS, EQUAL, LESSEQUAL, GREATER, NOTEQUAL, GREATEREQUAL, ALWAYS. */
const ALL_COMPARE_CAPS = 0x000000ff;

/**
 * Every source and destination blend factor D3D8 names, including the two
 * BOTH* forms. The renderer maps each onto its own; a factor left unclaimed
 * makes a program pick a worse path for an effect we can draw exactly.
 */
const ALL_BLEND_CAPS = 0x00003fff;

const D3DPSHADECAPS_COLORGOURAUDRGB = 0x00000008;
const D3DPSHADECAPS_SPECULARGOURAUDRGB = 0x00000200;
const D3DPSHADECAPS_ALPHAGOURAUDBLEND = 0x00004000;
const D3DPSHADECAPS_FOGGOURAUD = 0x00080000;

const D3DPTEXTURECAPS_PERSPECTIVE = 0x00000001;
const D3DPTEXTURECAPS_ALPHA = 0x00000004;
const D3DPTEXTURECAPS_PROJECTED = 0x00000400;
const D3DPTEXTURECAPS_MIPMAP = 0x00004000;
const D3DPTEXTURECAPS_CUBEMAP = 0x00000800;
const D3DPTEXTURECAPS_MIPCUBEMAP = 0x00010000;
const D3DPTEXTURECAPS_VOLUMEMAP = 0x00002000;
const D3DPTEXTURECAPS_MIPVOLUMEMAP = 0x00008000;

/**
 * Point and linear, for minification, magnification and mip. An anisotropic
 * filter is sampled linearly and D3DTSS_MAXANISOTROPY is not read, so neither
 * it nor a maximum above one is claimed.
 */
/** Point and linear for each filter, and anisotropic minification and magnification. */
const FILTER_CAPS = 0x03030300 | 0x00000400 | 0x04000000;
/** KEEP through DECR, every operation the pipeline maps; Direct3D 8 has no two-sided set. */
const STENCIL_CAPS = 0xff;
const D3DPRASTERCAPS_ZBIAS = 0x00004000;
const D3DPRASTERCAPS_MIPMAPLODBIAS = 0x00002000;
const D3DPRASTERCAPS_ANISOTROPY = 0x00020000;

const D3DPTADDRESSCAPS_WRAP = 0x00000001;
const D3DPTADDRESSCAPS_MIRROR = 0x00000002;
const D3DPTADDRESSCAPS_CLAMP = 0x00000004;
const D3DPTADDRESSCAPS_BORDER = 0x00000008;
const D3DPTADDRESSCAPS_INDEPENDENTUV = 0x00000010;
const D3DPTADDRESSCAPS_MIRRORONCE = 0x00000020;
/**
 * Every mode: border and mirror-once, which no WebGPU sampler has, are the
 * shader's over a clamping sampler (`addressVariantOf` in the renderer).
 */
const ADDRESS_CAPS = D3DPTADDRESSCAPS_WRAP | D3DPTADDRESSCAPS_MIRROR | D3DPTADDRESSCAPS_CLAMP
    | D3DPTADDRESSCAPS_BORDER | D3DPTADDRESSCAPS_INDEPENDENTUV | D3DPTADDRESSCAPS_MIRRORONCE;

const D3DLINECAPS_TEXTURE = 0x00000001;
const D3DLINECAPS_ZTEST = 0x00000002;
const D3DLINECAPS_BLEND = 0x00000004;
const D3DLINECAPS_ALPHACMP = 0x00000008;
const D3DLINECAPS_FOG = 0x00000010;


const D3DFVFCAPS_PSIZE = 0x00100000;

const D3DVTXPCAPS_TEXGEN = 0x00000001;
const D3DVTXPCAPS_MATERIALSOURCE7 = 0x00000002;
const D3DVTXPCAPS_DIRECTIONALLIGHTS = 0x00000008;
const D3DVTXPCAPS_POSITIONALLIGHTS = 0x00000010;
const D3DVTXPCAPS_LOCALVIEWER = 0x00000020;

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c | 0;

/** D3DENUM_NO_WHQL_LEVEL: skip the certification lookup, which took seconds on real Windows. */
const D3DENUM_NO_WHQL_LEVEL = 0x00000002;

/** What a device answers for something it could do on other hardware and cannot here. */
const D3DERR_NOTAVAILABLE = 0x8876086a | 0;

/**
 * The two failures a create documents when it cannot allocate. Which one a
 * method answers is the method's own contract: a resource that would live in
 * video memory says so, and everything else reports the plain out-of-memory
 * that COM defines.
 */
const D3DERR_OUTOFVIDEOMEMORY = 0x8876017c | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;

/** Succeeded, and answered nothing -- which is what GetInfo does outside a debug runtime. */
const S_FALSE = 1;

/**
 * The program's cursor, as the device was given it.
 *
 * @typedef {Object} CursorNotice
 * @property {number} width
 * @property {number} height
 * @property {{ x: number, y: number }} hotSpot
 * @property {Uint8Array} bgra   Four bytes a texel, blue first, as the surface holds them.
 * @property {boolean} shown
 */

/**
 * @param {Object} deps
 * @param {any} deps.publisher   From createPublisher.
 * @param {(cursor: CursorNotice) => void} [deps.cursor]
 *     Where the program's cursor goes: nothing composites a bitmap over the
 *     presented frame, so whoever shows the frame is told and shows it.
 * @param {any} deps.memory      readMemory/writeMemory.
 * @param {() => any} deps.screen  The display this build is configured for.
 * @param {(bytes: number) => number} [deps.allocate]
 *        Guest memory for the state a program sets without crossing into the
 *        host; without it every setter stays a trap.
 * @param {(bytes: number) => number} [deps.allocateCode]
 *        Pages of their own for the guest code this seam writes, where a store
 *        into the state beside it cannot invalidate it; `allocate` without it.
 * @param {(api: string, detail: string) => void} [deps.divergence]
 *        Where a value set in the guest that the device refuses is reported.
 * @param {(cursor: CursorNotice) => void} [deps.cursor]  A program cursor for the host.
 * @param {(width: number, height: number,
 *          where?: { window?: number, fullscreen?: boolean, announce?: boolean },
 *          ) => void} [deps.resolution]
 *        Told the resolution a device is created at, to report as the screen --
 *        and which window it presents into, so a fullscreen one can be placed.
 * @param {() => import('./adapter.js').AdapterIdentity | null} [deps.identity]
 *        The hardware behind the device, as the assembling caller knows it.
 * @param {(window: number) => { width: number, height: number } | null} [deps.windowClientSize]
 *        The client area of a window, which is the size a back buffer asked
 *        for as zero by zero takes. Without it the configured display is the
 *        nearest size this layer knows.
 * @param {() => number} [deps.now]  The clock the display's raster runs on, in milliseconds.
 * @param {Set<string>} [deps.traps]  Guest routines kept as traps, by name or group
 *     (`guestsBut`).
 */
export function createDirect3D8Seam(
    { publisher, memory, screen, allocate, allocateCode, divergence, cursor, resolution, identity,
        windowClientSize, now = ()=>performance.now(), traps = new Set() },
)
{
    /** The getters a device answers in the guest, as against the calls its ring carries. */
    const GUEST_GETTERS = new Set(['GetRenderState', 'GetTransform', 'GetTextureStageState',
        'GetViewport', 'GetSamplerState']);
    /**
     * The guest routines a table offers, less those `traps` keeps as traps: by
     * method name, or by the group a routine belongs to -- `getters`, `ring`,
     * `locks`, `levels`.
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
    const raster = createRaster({
        now, refresh: ()=>REFRESH_HZ, height: ()=>screen().height,
    });
    const privateData = createPrivateData({ memory, publisher, rules: D3D_PRIVATE_DATA });

    /**
     * Each device's block (`shadow.js`): its command ring, the buffers its
     * guest unlocked, and what the getters in the guest read; and the host's
     * side of it. Only with somewhere to put one: a build without an
     * allocator keeps every setter a trap.
     *
     * @type {WeakMap<any, ReturnType<typeof createShadow>>}
     */
    const shadows = new WeakMap();
    /**
     * The shadow of the device each buffer and texture belongs to, for the
     * host's own lock and unlock to settle the guest's first, and for a
     * release to make the calls in the ring that may still name the object.
     *
     * @type {WeakMap<object, ReturnType<typeof createShadow>>}
     */
    const resourceShadows = new WeakMap();
    /** @param {any} device */
    const shadowOf = device=>shadows.get(device) ?? null;

    /**
     * A resource's interface, whose methods the host makes after the calls
     * the program made before them: those its device's command ring still
     * holds are made first, as the device's own methods make them. A draw in
     * the ring that samples a texture, or reads a buffer, then meets it as it
     * was rather than as the lock about to be taken leaves it.
     *
     * @type {typeof describe}
     */
    const describeResource = (id, slots, methods, ...rest)=>describe(id, slots,
        Object.fromEntries(Object.entries(methods ?? {}).map(([name, method])=>[name,
            (/** @type {any} */ object, /** @type {number[]} */ args)=>{
                (resourceShadows.get(object) ?? shadowOf(ownerOf(object)))?.sync();
                return method(object, args);
            }])), ...rest);
    /**
     * The program let go of a resource. A call in the command ring that names
     * it is made now, while its pointer still resolves; after this the pointer
     * is nobody's.
     *
     * @param {any} resource
     */
    const retire = resource=>{
        privateData.released(resource);
        resourceShadows.get(resource)?.sync();
    };
    /** @param {(at: number) => Uint8Array} code */
    const placeCode = code=>{
        if (!allocate)
        {
            return 0;
        }
        // Sized by a throwaway rendering: the bytes depend on where they
        // land only through relative jumps, never in length.
        const at = (allocateCode ?? allocate)(code(0).length);
        memory.writeMemory(at, code(at));
        return at;
    };

    /** @type {Record<string, (builder: { trap: number }) => number>} */
    const textureGuests = guestsBut('levels', allocate
        ? { GetSurfaceLevel: ({ trap })=>placeCode(at=>getSurfaceLevelCode(at, trap)) }
        : {});

    /**
     * A texture gets its block before it is handed out, for the same reason a
     * buffer does: the block's address is written when the interface is
     * published.
     *
     * @param {any} device @param {any} texture
     */
    const attachTexture = (device, texture)=>{
        const shadow = shadowOf(device);
        if (!shadow)
        {
            return;
        }
        resourceShadows.set(texture, shadow);
        texture.guestState = ()=>shadow.attachTexture(texture, publisher.countCell?.(texture) ?? 0);
    };

    /**
     * A level's surface has been published, so the guest may answer with its
     * pointer from now on.
     *
     * @param {any} texture @param {number} level @param {any} surface
     */
    const noteLevel = (texture, level, surface)=>{
        const shadow = resourceShadows.get(texture);
        if (!shadow)
        {
            return;
        }
        // Publishing is memoised, so this is the pointer the program now holds.
        shadow.noteLevel(texture, level,
            publisher.publish(surface, surfaceInterfaces, IID_IDirect3DSurface8));
    };

    /**
     * A resource, published as whichever interface it is.
     *
     * Reached through the out-parameter of the call that made it, which is why
     * this both publishes and adds the reference: a program that receives an
     * interface owns a reference to it, and releases one when it is done.
     *
     * Publishing can fail -- there is a finite amount of guest memory to lay a
     * vtable in and a finite number of stubs to fill it with -- and a failure
     * here is the whole call's failure. The pointer written is the zero the
     * publisher answered, and the result is the one the method documents:
     * telling a program D3D_OK next to a null interface is how it comes to call
     * through that pointer.
     *
     * @param {any} object
     * @param {import('./com.js').InterfaceDescriptor[]} interfaces
     * @param {string} id
     * @param {number} out  Where to write the pointer.
     * @param {number} [failure]  What this method answers when it cannot allocate.
     * @param {any} [owner]  The device that made it, for GetDevice.
     * @returns {number} D3D_OK, or `failure`.
     */
    const handBack = (object, interfaces, id, out, failure = E_OUTOFMEMORY, owner = null)=>{
        if (owner)
        {
            owners.set(object, owner);
        }
        // A record in the device's ring may name it -- or, for a level, a
        // face or a volume, the container whose count it shares: the ring is
        // played before its count is touched on the host, which the last
        // reference's Release always is.
        const device = ownerOf(object);
        if (device)
        {
            object.settleGuestRefs ??= ()=>shadowOf(device)?.sync();
        }
        const pointer = publisher.publish(object, interfaces, id);
        fields.writeU32(out, pointer);
        return pointer === 0 ? failure : D3D_OK;
    };

    /**
     * A create this build cannot do.
     *
     * The caller's pointer is cleared as well as the result reported, because a
     * program tests the one as often as the other, and a stale interface
     * pointer left there is one it goes on to call.
     *
     * @param {number} out
     * @param {number} [hr]  The refusal; D3DERR_NOTAVAILABLE unless the create said otherwise.
     */
    const clearAndRefuse = (out, hr = D3DERR_NOTAVAILABLE)=>{
        if ((out >>> 0) !== 0)
        {
            fields.writeU32(out >>> 0, 0);
        }
        return hr;
    };

    /**
     * A level's description is the description of its surface, which is also
     * the only way to reach one. The reference that reaching it took is given
     * straight back: the call hands out no interface, so a program owes
     * nothing for it.
     *
     * @param {(held: { surface?: any }) => number} reach
     * @param {number} out
     */
    const writeLevelDesc = (reach, out)=>{
        /** @type {{ surface?: any }} */
        const held = {};
        const hr = reach(held);
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
            fields.writeStruct(out >>> 0, D3DSURFACE_DESC8, described.desc);
        }
        return D3D_OK;
    };

    /**
     * The window each additional swap chain presents into. The display shows
     * the device's window; a chain presenting anywhere else has its frame
     * drawn and not shown.
     *
     * @type {WeakMap<object, number>}
     */
    const chainWindows = new WeakMap();

    // IDirect3DSwapChain8: a present, whose rectangles and dirty region are
    // not honoured and whose window decides whether the display shows the
    // picture, and the back buffers.
    const swapChainInterfaces = [describeResource(IID_IDirect3DSwapChain8,
        IDIRECT3DSWAPCHAIN8_SLOTS, {
        /** @param {any} chain @param {number[]} args */
            Present: (chain, [, , override])=>chain.Present(
                ((override >>> 0) || chainWindows.get(chain) || deviceWindow) === deviceWindow),
            /** @param {any} chain @param {number[]} args */
            GetBackBuffer: (chain, [index, type, out])=>{
                if ((out >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                /** @type {{ surface?: any }} */
                const held = {};
                const hr = chain.GetBackBuffer(index >>> 0, type >>> 0, held);
                if (hr !== D3D_OK || !held.surface)
                {
                    return hr;
                }
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface8, out >>> 0,
                    E_OUTOFMEMORY, owners.get(chain));
            },
        })];

    /**
     * The device each resource was made by, for GetDevice. A texture's levels
     * are found through the texture. Weak, so this keeps nothing alive.
     *
     * @type {WeakMap<object, any>}
     */
    const owners = new WeakMap();
    /** @param {any} resource @returns {any} */
    const ownerOf = resource=>owners.get(resource)
        ?? (resource.container ? owners.get(resource.container) : undefined) ?? null;

    /**
     * The device a resource was made by: the same pointer the program already
     * holds, with the reference the call owes.
     *
     * @param {any} resource @param {number[]} args
     */
    const getDevice = (resource, [out])=>{
        const device = ownerOf(resource);
        if ((out >>> 0) === 0 || !device)
        {
            return D3DERR_INVALIDCALL;
        }
        device.addRef();
        fields.writeU32(out >>> 0,
            publisher.publish(device, deviceInterfaces, IID_IDirect3DDevice8));
        return D3D_OK;
    };

    /**
     * What IDirect3DResource8 answers for every resource: GetType returns the
     * kind rather than an HRESULT, and the two priority calls a DWORD.
     *
     * @param {number} type  D3DRTYPE
     */
    const resourceMethods = type=>({
        ...privateData.methods,
        GetDevice: getDevice,
        /** @param {any} resource @param {number[]} args */
        SetPriority: (resource, [priority])=>resource.SetPriority(priority >>> 0),
        /** @param {any} resource */
        GetPriority: resource=>resource.GetPriority(),
        // Declared void: a resource here is uploaded when it changes.
        PreLoad: ()=>0,
        GetType: ()=>type,
    });

    // Resources carry no behaviour of their own here beyond what the API
    // objects already do, so their descriptors are built once.
    const surfaceInterfaces = [describeResource(IID_IDirect3DSurface8, IDIRECT3DSURFACE8_SLOTS, {
        ...privateData.methods,
        GetDevice: getDevice,

        /**
         * QueryInterface on what holds the surface: the texture a level
         * belongs to, and the device for a surface of its own -- a back
         * buffer included, this version having no swap chain object (Wine's
         * d3d8 test_surface_get_container and test_refcount).
         *
         * @param {any} surface @param {number[]} args
         */
        GetContainer: (surface, [riid, out])=>{
            if ((riid >>> 0) === 0 || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            const id = readGuid(memory, riid);
            if (surface.container)
            {
                return queryAs(publisher, fields, surface.container,
                    textureKind(surface.container).interfaces, id, out);
            }
            const device = ownerOf(surface);
            if (!device)
            {
                return D3DERR_INVALIDCALL;
            }
            return queryAs(publisher, fields, device, deviceInterfaces, id, out);
        },
        /** @param {any} surface @param {number[]} args */
        GetDesc: (surface, [out])=>{
            /** @type {{ desc?: any }} */
            const held = {};
            const hr = surface.GetDesc(held);
            if (hr === D3D_OK && (out >>> 0) !== 0 && held.desc)
            {
                fields.writeStruct(out >>> 0, D3DSURFACE_DESC8, held.desc);
            }
            return hr;
        },
        /** @param {any} surface @param {number[]} args */
        LockRect: (surface, [out, rect, flags])=>{
            /** @type {any} */
            const locked = {};
            /** @param {number} hr */
            const answer = hr=>{
                if (hr === D3D_OK && (out >>> 0) !== 0)
                {
                    fields.writeStruct(out >>> 0, D3DLOCKED_RECT, {
                        Pitch: locked.Pitch ?? 0,
                        pBits: locked.pBits ?? 0,
                    });
                }
                return hr;
            };
            // A render target's lock settles once its pixels are back in
            // guest memory; the caller waits, and reads the rectangle then.
            const hr = surface.LockRect(locked, readRect(rect), flags >>> 0);
            return hr instanceof Promise ? hr.then(answer) : answer(hr);
        },
        /** @param {any} surface */
        UnlockRect: surface=>surface.UnlockRect(),
    }, {}, retire)];

    const textureMethods = {
        ...resourceMethods(D3DRTYPE.TEXTURE),
        // Both answer a level rather than an HRESULT.
        /** @param {any} texture @param {number[]} args */
        SetLOD: (texture, [lod])=>texture.SetLOD(lod >>> 0),
        /** @param {any} texture */
        GetLOD: texture=>texture.GetLOD(),
        // The count is a property of the object rather than a method on it, and
        // this answers a number rather than an HRESULT.
        /** @param {any} texture */
        GetLevelCount: texture=>texture.levels ?? 1,
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
            if (hr !== D3D_OK || !held.surface || (out >>> 0) === 0)
            {
                return hr;
            }
            const answer = handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface8,
                out >>> 0);
            if (answer === D3D_OK)
            {
                noteLevel(texture, level >>> 0, held.surface);
            }
            return answer;
        },

        /** @param {any} texture @param {number[]} args */
        GetLevelDesc: (texture, [level, out])=>writeLevelDesc(
            held=>texture.GetSurfaceLevel(level >>> 0, held), out),

        // Locking a level through the texture and through the level's own
        // surface are one lock, which is what makes taking both an error.
        /** @param {any} texture @param {number[]} args */
        LockRect: (texture, [level, out, rect, flags])=>{
            /** @type {any} */
            const locked = {};
            const hr = texture.LockRect(level >>> 0, locked, readRect(rect), flags >>> 0);
            if (hr === D3D_OK && (out >>> 0) !== 0)
            {
                fields.writeStruct(out >>> 0, D3DLOCKED_RECT, {
                    Pitch: locked.Pitch ?? 0,
                    pBits: locked.pBits ?? 0,
                });
            }
            return hr;
        },

        /** @param {any} texture @param {number[]} args */
        UnlockRect: (texture, [level])=>texture.UnlockRect(level >>> 0),

        /** @param {any} texture @param {number[]} args */
        AddDirtyRect: (texture, [rect])=>texture.AddDirtyRect(readRect(rect)),
    };
    // The two interfaces a texture derives from are answered too, over the
    // same methods: their slots are the front of the texture's own.
    const textureInterfaces = [
        describeResource(IID_IDirect3DTexture8, IDIRECT3DTEXTURE8_SLOTS, textureMethods,
            textureGuests, retire),
        describeResource(IID_IDirect3DBaseTexture8, IDIRECT3DBASETEXTURE8_SLOTS, textureMethods),
        describeResource(IID_IDirect3DResource8, IDIRECT3DRESOURCE8_SLOTS, textureMethods),
    ];

    // A cube map: the base texture's methods, then each of its own naming a
    // face before the level.
    const cubeTextureMethods = {
        ...resourceMethods(D3DRTYPE.CUBETEXTURE),
        SetLOD: textureMethods.SetLOD,
        GetLOD: textureMethods.GetLOD,
        GetLevelCount: textureMethods.GetLevelCount,
        /** @param {any} texture @param {number[]} args */
        GetLevelDesc: (texture, [level, out])=>writeLevelDesc(
            held=>texture.GetCubeMapSurface(0, level >>> 0, held), out),
        /** @param {any} texture @param {number[]} args */
        GetCubeMapSurface: (texture, [face, level, out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = texture.GetCubeMapSurface(face >>> 0, level >>> 0, held);
            if (hr !== D3D_OK || !held.surface || (out >>> 0) === 0)
            {
                return hr;
            }
            return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface8, out >>> 0);
        },
        /** @param {any} texture @param {number[]} args */
        LockRect: (texture, [face, level, out, rect, flags])=>{
            /** @type {any} */
            const locked = {};
            const hr = texture.LockCubeRect(face >>> 0, level >>> 0, locked, readRect(rect),
                flags >>> 0);
            if (hr === D3D_OK && (out >>> 0) !== 0)
            {
                fields.writeStruct(out >>> 0, D3DLOCKED_RECT, {
                    Pitch: locked.Pitch ?? 0,
                    pBits: locked.pBits ?? 0,
                });
            }
            return hr;
        },
        /** @param {any} texture @param {number[]} args */
        UnlockRect: (texture, [face, level])=>texture.UnlockCubeRect(face >>> 0, level >>> 0),
        /** @param {any} texture @param {number[]} args */
        AddDirtyRect: (texture, [face, rect])=>texture.AddDirtyRect(readRect(rect), face >>> 0),
    };
    const cubeTextureInterfaces = [
        describeResource(IID_IDirect3DCubeTexture8, IDIRECT3DCUBETEXTURE8_SLOTS, cubeTextureMethods,
            {}, retire),
        describeResource(IID_IDirect3DBaseTexture8, IDIRECT3DBASETEXTURE8_SLOTS,
            cubeTextureMethods),
        describeResource(IID_IDirect3DResource8, IDIRECT3DRESOURCE8_SLOTS, cubeTextureMethods),
    ];

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
     * through (Wine's d3d8 test_volume_locking).
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
            fields.writeStruct(out >>> 0, D3DVOLUME_DESC8, described.desc);
        }
        return D3D_OK;
    };

    // A volume texture's level: not a resource, so it answers for itself and
    // for IUnknown alone, and names its texture as its container.
    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const volumeInterfaces = [describeResource(IID_IDirect3DVolume8, IDIRECT3DVOLUME8_SLOTS, {
        ...privateData.methods,
        GetDevice: getDevice,
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
        SetLOD: textureMethods.SetLOD,
        GetLOD: textureMethods.GetLOD,
        GetLevelCount: textureMethods.GetLevelCount,
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
            return handBack(held.volume, volumeInterfaces, IID_IDirect3DVolume8, out >>> 0);
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
    const volumeTextureInterfaces = [
        describeResource(IID_IDirect3DVolumeTexture8, IDIRECT3DVOLUMETEXTURE8_SLOTS,
            volumeTextureMethods, {}, retire),
        describeResource(IID_IDirect3DBaseTexture8, IDIRECT3DBASETEXTURE8_SLOTS,
            volumeTextureMethods),
        describeResource(IID_IDirect3DResource8, IDIRECT3DRESOURCE8_SLOTS, volumeTextureMethods),
    ];

    /**
     * Whichever interfaces a texture is published with, by its kind.
     *
     * @param {any} texture
     * @returns {{ interfaces: import('./com.js').InterfaceDescriptor[], id: string }}
     */
    const textureKind = texture=>{
        if (texture.cube)
        {
            return { interfaces: cubeTextureInterfaces, id: IID_IDirect3DCubeTexture8 };
        }
        return texture.volume
            ? { interfaces: volumeTextureInterfaces, id: IID_IDirect3DVolumeTexture8 }
            : { interfaces: textureInterfaces, id: IID_IDirect3DTexture8 };
    };

    /**
     * A buffer hands back an address in the guest's own memory, so locking is
     * one out-parameter and nothing else: the program writes there itself, and
     * the unlock is what tells this engine to look.
     */
    //
    // Both usually run in the guest; the host's path is the one the guest
    // routine leaves for it -- a lock already held, a full ring -- and it
    // settles what the guest did to the buffer first, then tells the block
    // what it did, so the two paths see one lock.
    const bufferMethods = {
        /** @param {any} buffer @param {number[]} args */
        Lock: (buffer, [offset, size, out, flags])=>{
            const shadow = resourceShadows.get(buffer);
            shadow?.settleBuffer(buffer);
            /** @type {{ pBits?: number }} */
            const locked = {};
            const hr = buffer.Lock(offset >>> 0, size >>> 0, locked, flags >>> 0);
            if (hr === D3D_OK)
            {
                shadow?.noteLocked(buffer, true);
                if ((out >>> 0) !== 0)
                {
                    fields.writeU32(out >>> 0, locked.pBits ?? 0);
                }
            }
            return hr;
        },
        /** @param {any} buffer */
        Unlock: (/** @type {any} */ buffer)=>{
            const shadow = resourceShadows.get(buffer);
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
     * The one method the two buffers' layouts differ in: an index buffer's
     * description has no FVF.
     *
     * @param {Record<string, number>} layout
     */
    const describeBuffer = layout=>(/** @type {any} */ buffer, /** @type {number[]} */ [out])=>{
        /** @type {{ desc?: any }} */
        const held = {};
        const hr = buffer.GetDesc(held);
        if (hr === D3D_OK && (out >>> 0) !== 0 && held.desc)
        {
            fields.writeStruct(out >>> 0, layout, held.desc);
        }
        return (out >>> 0) === 0 ? D3DERR_INVALIDCALL : hr;
    };

    const vertexBufferInterfaces = [
        describeResource(IID_IDirect3DVertexBuffer8, IDIRECT3DVERTEXBUFFER8_SLOTS, {
            ...resourceMethods(D3DRTYPE.VERTEXBUFFER),
            ...bufferMethods,
            GetDesc: describeBuffer(D3DVERTEXBUFFER_DESC9),
        }, bufferGuests, retire),
    ];
    const indexBufferInterfaces = [
        describeResource(IID_IDirect3DIndexBuffer8, IDIRECT3DINDEXBUFFER8_SLOTS, {
            ...resourceMethods(D3DRTYPE.INDEXBUFFER),
            ...bufferMethods,
            GetDesc: describeBuffer(D3DINDEXBUFFER_DESC9),
        }, bufferGuests, retire),
    ];

    /**
     * A buffer the device just made gets its block before it is handed out,
     * for the same reason the device does: the block's address is written
     * when the interface is published.
     *
     * @param {any} device @param {any} buffer
     */
    const attach = (device, buffer)=>{
        const shadow = shadowOf(device);
        if (shadow)
        {
            resourceShadows.set(buffer, shadow);
            buffer.guestState = ()=>shadow.attachBuffer(buffer);
        }
    };

    /** @param {number} pointer @returns {any} */
    const readRect = pointer=>((pointer >>> 0) === 0
        ? null
        : fields.readStruct(pointer >>> 0, { left: 0, top: 4, right: 8, bottom: 12 }));

    /** @param {number} pointer @param {number} count @returns {Float32Array} */
    const readFloats = (pointer, count)=>{
        // Out of the window where there is one, rather than a copy of the
        // bytes: the floats are the caller's to keep, and `floatsOf` answers
        // an array of their own.
        const read = memory.windowMemory ?? memory.readMemory;
        return floatsOf(read(pointer >>> 0, count * 4), count);
    };

    /**
     * Bytes a drawing call reads straight out of the program's own arrays.
     *
     * Nothing is copied when the count comes out empty or the pointer is null:
     * the object behind this refuses such a call, and refusing it there keeps
     * one answer to what a malformed draw does.
     *
     * @param {number} pointer @param {number} length @returns {Uint8Array | null}
     */
    const readArray = (pointer, length)=>((pointer >>> 0) === 0 || !(length > 0)
        ? null
        : memory.readMemory(pointer >>> 0, length));

    /**
     * An answer of floats -- a matrix, a plane, shader constants -- as one
     * block rather than a write per float.
     *
     * @param {number} address @param {ArrayLike<number>} values
     */
    const writeFloats = (address, values)=>fields.writeFloats(address, values);

    /** @param {number} pointer @param {number} count @returns {Uint32Array} */
    const readDwords = (pointer, count)=>dwordsOf(memory.readMemory(pointer >>> 0, count * 4),
        count);

    /**
     * A shader function's tokens, read to its end token. The stream carries
     * no length; a comment's own length is honoured, since one may hold
     * anything.
     *
     * @param {number} pointer
     * @returns {Uint32Array | null}
     */
    const readFunction = pointer=>{
        /** @type {number[]} */
        const tokens = [];
        let skip = 0;
        while (tokens.length < MAX_SHADER_DWORDS)
        {
            const token = fields.readU32(pointer + tokens.length * 4);
            tokens.push(token);
            if (skip > 0)
            {
                skip--;
            }
            else if (tokens.length > 1 && (token & 0xffff) === 0xfffe)
            {
                skip = (token >>> 16) & 0x7fff;
            }
            else if (token === END_TOKEN)
            {
                return Uint32Array.from(tokens);
            }
        }
        return null;
    };

    /**
     * A reader of a shader's declaration or function by handle: the size
     * pointer is required, the buffer optional, and a buffer too small is
     * refused with the size left as the caller wrote it.
     *
     * @param {'GetVertexShaderDeclaration' | 'GetVertexShaderFunction'
     *     | 'GetPixelShaderFunction'} name
     */
    const tokensOf = name=>(/** @type {any} */ device, /** @type {number[]} */ args)=>{
        const [handle, data, size] = args;
        if ((size >>> 0) === 0)
        {
            return D3DERR_INVALIDCALL;
        }
        /** @type {{ bytes?: number, tokens?: Uint32Array }} */
        const held = {};
        const hr = device[name](handle >>> 0, held,
            (data >>> 0) === 0 ? null : fields.readU32(size >>> 0));
        if (hr === D3D_OK)
        {
            fields.writeU32(size >>> 0, held.bytes ?? 0);
            if (held.tokens)
            {
                memory.writeMemory(data >>> 0,
                    new Uint8Array(Uint32Array.from(held.tokens).buffer));
            }
        }
        return hr;
    };

    /** @param {number} pointer */
    const readMaterial = pointer=>materialOf(readFloats(pointer, 17));

    /** @param {number} address @param {any} material */
    const writeMaterial = (address, material)=>{
        putMaterial(fields.staged(17).floats, material);
        fields.writeStaged(address, 17);
    };

    /** D3DLIGHT8 is D3DLIGHT7's layout under D3D8's names. */
    const readLight = createLightReader(fields);

    /** @param {number} address @param {any} light */
    const writeLight = (address, light)=>{
        const { floats, dwords } = fields.staged(D3DLIGHT7.SIZE >>> 2);
        putLight(floats, dwords, light);
        fields.writeStaged(address, D3DLIGHT7.SIZE >>> 2);
    };

    /**
     * A gamma ramp is three channels of 256 sixteen-bit entries, in one block.
     *
     * @param {number} pointer
     */
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
     * The rectangles and the destination points CopyRects was given. Both are
     * optional together: no rectangles means the whole surface, and the object
     * behind this refuses one without the other.
     *
     * @param {number} pointer @param {number} count @param {Record<string, number>} layout
     */
    const readArrayOf = (pointer, count, layout)=>((pointer >>> 0) === 0 || count === 0
        ? null
        : Array.from({ length: count }, (_, index)=>
            fields.readStruct((pointer >>> 0) + index * layout.SIZE, layout)));

    /**
     * Moves the bytes a copy between two surfaces named.
     *
     * The device decided what to move and where from: both surfaces are in the
     * guest's own memory, which it cannot reach and this can. A row at a time
     * unless the two runs are contiguous, which the whole-surface case always
     * is and is worth the branch -- that is the case a program uploading a
     * texture takes every frame.
     *
     * @param {import('../d3d8/device.js').SurfaceMove[]} moves
     */
    const applyMoves = moves=>{
        for (const move of moves)
        {
            if (move.rowBytes === move.fromPitch && move.rowBytes === move.toPitch)
            {
                memory.writeMemory(move.to,
                    memory.readMemory(move.from, move.rowBytes * move.rows));
                continue;
            }
            for (let row = 0; row < move.rows; row++)
            {
                memory.writeMemory(move.to + row * move.toPitch,
                    memory.readMemory(move.from + row * move.fromPitch, move.rowBytes));
            }
        }
    };

    /** How many indices a draw of this shape reads, and how wide each one is. */
    const indexWidth = (/** @type {number} */ format)=>(format >>> 0) === D3DFMT_INDEX.INDEX32
        ? 4
        : 2;

    /**
     * The device's slots. Written out rather than generated because each one
     * differs in which arguments are pointers.
     */
    const deviceMethods = {
        /** @param {any} device */
        TestCooperativeLevel: (/** @type {any} */ device)=>device.TestCooperativeLevel(),
        /** @param {any} device */
        BeginScene: (/** @type {any} */ device)=>device.BeginScene(),
        /** @param {any} device */
        EndScene: (/** @type {any} */ device)=>device.EndScene(),

        // Present's four arguments are all optional and all ignored by the
        // object behind this: it has no rectangles to honour until something
        // draws.
        /** @param {any} device */
        Present: (/** @type {any} */ device)=>{
            showScreen(device);
            return device.Present();
        },

        /** @param {any} device @param {number[]} args */
        Reset: (device, [parameters])=>{
            if ((parameters >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            const next = readPresentParameters(parameters >>> 0, deviceWindow);
            const hr = device.Reset(next);
            writePresentParameters(parameters >>> 0, next);
            if (hr === D3D_OK)
            {
                // The window is this resolution now, fullscreen or back to
                // windowed; a window left at the old size has the program
                // clipping its cursor to a rectangle the picture no longer
                // fills.
                deviceWindow = (next.hDeviceWindow >>> 0) || deviceWindow;
                takeScreen(device, next, deviceWindow);
            }
            // The block is brought to what the device now holds, not to what
            // it held before: a reset is the host changing state on its own.
            shadowOf(device)?.remirror();
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

        /** @param {any} device @param {number[]} args */
        SetViewport: (device, [pointer])=>{
            if ((pointer >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            const hr = device.SetViewport({
                ...fields.readStruct(pointer >>> 0, D3DVIEWPORT8, ['MinZ', 'MaxZ']),
                MinZWord: fields.readU32((pointer >>> 0) + 16),
                MaxZWord: fields.readU32((pointer >>> 0) + 20),
            });
            shadowOf(device)?.remirror({ viewport: true });
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        GetViewport: (device, [out])=>{
            /** @type {{ viewport?: any, depthWords?: [number, number] }} */
            const held = {};
            const hr = device.GetViewport(held);
            if (hr === D3D_OK && (out >>> 0) !== 0 && held.viewport)
            {
                // The depth range as the words the program set: a float
                // written from a number would quiet a signalling NaN.
                fields.writeStruct(out >>> 0, D3DVIEWPORT8, held.depthWords
                    ? { ...held.viewport, MinZ: held.depthWords[0], MaxZ: held.depthWords[1] }
                    : held.viewport, held.depthWords ? [] : ['MinZ', 'MaxZ']);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        CreateTexture: (device, [width, height, levels, usage, format, pool, out])=>{
            /** @type {{ texture?: any }} */
            const held = {};
            const hr = device.CreateTexture(
                width >>> 0, height >>> 0, levels >>> 0, usage >>> 0,
                format >>> 0, pool >>> 0, held);
            if (hr === D3D_OK && held.texture && (out >>> 0) !== 0)
            {
                attachTexture(device, held.texture);
                return handBack(held.texture, textureInterfaces, IID_IDirect3DTexture8,
                    out >>> 0, D3DERR_OUTOFVIDEOMEMORY, device);
            }
            return clearAndRefuse(out, hr);
        },

        /** @param {any} device @param {number[]} args */
        CreateImageSurface: (device, [width, height, format, out])=>{
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = device.CreateImageSurface(width >>> 0, height >>> 0, format >>> 0, held);
            if (hr === D3D_OK && held.surface && (out >>> 0) !== 0)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface8,
                    out >>> 0, E_OUTOFMEMORY, device);
            }
            return clearAndRefuse(out, hr);
        },

        /** @param {any} device @param {number[]} args */
        CreateVertexBuffer: (device, [length, usage, fvf, pool, out])=>{
            /** @type {{ buffer?: any }} */
            const held = {};
            const hr = device.CreateVertexBuffer(
                length >>> 0, usage >>> 0, fvf >>> 0, pool >>> 0, held);
            if (hr === D3D_OK && held.buffer && (out >>> 0) !== 0)
            {
                attach(device, held.buffer);
                return handBack(held.buffer, vertexBufferInterfaces,
                    IID_IDirect3DVertexBuffer8, out >>> 0, D3DERR_OUTOFVIDEOMEMORY, device);
            }
            return clearAndRefuse(out, hr);
        },

        /** @param {any} device @param {number[]} args */
        CreateIndexBuffer: (device, [length, usage, format, pool, out])=>{
            /** @type {{ buffer?: any }} */
            const held = {};
            const hr = device.CreateIndexBuffer(
                length >>> 0, usage >>> 0, format >>> 0, pool >>> 0, held);
            if (hr === D3D_OK && held.buffer && (out >>> 0) !== 0)
            {
                attach(device, held.buffer);
                return handBack(held.buffer, indexBufferInterfaces,
                    IID_IDirect3DIndexBuffer8, out >>> 0, D3DERR_OUTOFVIDEOMEMORY, device);
            }
            return clearAndRefuse(out, hr);
        },

        /** @param {any} device @param {number[]} args */
        GetBackBuffer: (device, [index, type, out])=>{
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = device.GetBackBuffer(index >>> 0, type >>> 0, held);
            if (hr === D3D_OK && held.surface && (out >>> 0) !== 0)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface8,
                    out >>> 0, E_OUTOFMEMORY, device);
            }
            return hr;
        },

        // An interface pointer arriving from the guest is turned back into the
        // object it names; a null one is unbinding, which is legitimate.
        /** @param {any} device @param {number[]} args */
        SetTexture: (device, [stage, texture])=>
            device.SetTexture(stage >>> 0, publisher.objectAt(texture)),

        /** @param {any} device @param {number[]} args */
        SetStreamSource: (device, [index, buffer, stride])=>
            device.SetStreamSource(index >>> 0, publisher.objectAt(buffer), stride >>> 0),

        /** @param {any} device @param {number[]} args */
        SetIndices: (device, [buffer, base])=>
            device.SetIndices(publisher.objectAt(buffer), base >>> 0),

        /** @param {any} device @param {number[]} args */
        SetTextureStageState: (device, [stage, type, value])=>{
            const hr = device.SetTextureStageState(stage >>> 0, type >>> 0, value >>> 0);
            shadowOf(device)?.remirror({ stageStates: [(stage & 0xffffff) << 8 | type & 0xff] });
            return hr;
        },

        // Sixteen floats, in the order D3DMATRIX lays them out. Read here
        // rather than passed as an address because everything past this point
        // works in numbers.
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
        SetMaterial: (device, [pointer])=>((pointer >>> 0) === 0
            ? D3DERR_INVALIDCALL
            : device.SetMaterial(readMaterial(pointer))),

        // Z arrives as a float in a slot this seam otherwise reads as a dword:
        // the bytes are the caller's, only the interpretation differs.
        /** @param {any} device @param {number[]} args */
        Clear: (device, [count, rects, flags, colour, z, stencil])=>device.Clear(
            count >>> 0,
            (rects >>> 0) === 0
                ? null
                : Array.from({ length: count >>> 0 }, (_, index)=>fields.readStruct(
                    (rects >>> 0) + index * 16, { x1: 0, y1: 4, x2: 8, y2: 12 })),
            flags >>> 0, colour >>> 0, fields.asFloat(z), stencil >>> 0),

        /** @param {any} device @param {number[]} args */
        DrawPrimitive: (device, [type, startVertex, primitiveCount])=>
            device.DrawPrimitive(type >>> 0, startVertex >>> 0, primitiveCount >>> 0),

        /** @param {any} device @param {number[]} args */
        DrawIndexedPrimitive: (device, [type, minIndex, numVertices, startIndex, count])=>
            device.DrawIndexedPrimitive(type >>> 0, minIndex >>> 0, numVertices >>> 0,
                startIndex >>> 0, count >>> 0),

        // The UP calls draw from the program's own arrays, so the seam is what
        // decides how far to read: the vertex count the primitive shape implies,
        // times the stride the caller declared.
        /** @param {any} device @param {number[]} args */
        DrawPrimitiveUP: (device, [type, primitiveCount, vertices, stride])=>
            device.DrawPrimitiveUP(
                type >>> 0, primitiveCount >>> 0,
                readArray(vertices,
                    vertexCountOf(type >>> 0, primitiveCount >>> 0) * (stride >>> 0)),
                stride >>> 0),

        /** @param {any} device @param {number[]} args */
        DrawIndexedPrimitiveUP: (device,
            [type, minIndex, numVertices, count, indices, format, vertices, stride])=>
            device.DrawIndexedPrimitiveUP(
                type >>> 0, minIndex >>> 0, numVertices >>> 0, count >>> 0,
                readArray(indices,
                    vertexCountOf(type >>> 0, count >>> 0) * indexWidth(format)),
                format >>> 0,
                // An index counts from the start of the vertices, so the
                // range reaches past its lowest by the count.
                readArray(vertices, ((minIndex >>> 0) + (numVertices >>> 0)) * (stride >>> 0)),
                stride >>> 0),

        /** @param {any} device @param {number[]} args */
        SetRenderTarget: (device, [target, depth])=>{
            const hr = device.SetRenderTarget(publisher.objectAt(target),
                publisher.objectAt(depth));
            // A new target is a new viewport, which the guest's GetViewport reads.
            shadowOf(device)?.remirror({ viewport: true });
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        GetRenderTarget: (device, [out])=>{
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = device.GetRenderTarget(held);
            if (hr === D3D_OK && held.surface && (out >>> 0) !== 0)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface8,
                    out >>> 0, E_OUTOFMEMORY, device);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        GetDepthStencilSurface: (device, [out])=>{
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = device.GetDepthStencilSurface(held);
            if (hr === D3D_OK && held.surface && (out >>> 0) !== 0)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface8,
                    out >>> 0, E_OUTOFMEMORY, device);
            }
            if ((out >>> 0) !== 0)
            {
                // Cleared when there is nothing to hand back: this call is how
                // a program asks whether the device has a depth buffer, and it
                // tests the pointer rather than the HRESULT.
                fields.writeU32(out >>> 0, 0);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        GetDeviceCaps: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            writeCaps(out >>> 0, device.caps ?? {});
            return D3D_OK;
        },

        /** @param {any} device @param {number[]} args */
        GetDisplayMode: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            writeDisplayMode(out >>> 0);
            return D3D_OK;
        },

        // --- what a program asks before it draws anything ---

        // A byte count rather than an HRESULT: there is no failure to report,
        // so a caller reads the answer as the number it is.
        /** @param {any} device */
        GetAvailableTextureMem: (/** @type {any} */ device)=>device.GetAvailableTextureMem(),

        /** @param {any} device */
        ResourceManagerDiscardBytes: (/** @type {any} */ device)=>
            device.ResourceManagerDiscardBytes(),

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
                // The same object the device was made through, so the pointer
                // is the one the program already holds; the reference the call
                // owes was taken by the device.
                fields.writeU32(out >>> 0,
                    publisher.publish(held.direct3D, rootInterfaces, IID_IDirect3D8));
            }
            return hr;
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

        // The raster the clock gives, the one DirectDraw reports: a program
        // polling this for the blank sees it come round once a refresh.
        /** @param {any} device @param {number[]} args */
        GetRasterStatus: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            fields.writeStruct(out >>> 0, D3DRASTER_STATUS, rasterStatus(raster));
            return D3D_OK;
        },

        // --- the desktop, none of which this build owns ---

        // Both gamma calls are declared void, so what they leave in EAX is not
        // read.
        /** @param {any} device @param {number[]} args */
        SetGammaRamp: (device, [, ramp])=>{
            if ((ramp >>> 0) !== 0)
            {
                device.SetGammaRamp(readGammaRamp(ramp >>> 0));
            }
            return 0;
        },

        /** @param {any} device @param {number[]} args */
        GetGammaRamp: (device, [out])=>{
            if ((out >>> 0) !== 0)
            {
                /** @type {{ ramp?: any }} */
                const held = {};
                device.GetGammaRamp(held);
                writeGammaRamp(out >>> 0, held.ramp);
            }
            return 0;
        },

        // Nothing composites a bitmap over the presented frame; the cursor is
        // handed to whoever shows the frame, who shows it the way its own
        // screen can. Without such a taker the call is refused, which is the
        // one answer that says so: a program told its cursor was accepted
        // has no reason to draw one itself, and a program told otherwise
        // usually does.
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

        // Declared void. The position is the host's own pointer, and a cursor
        // the program moves itself is moved by the program's own drawing.
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
            // for a size asked for as zero; only the count is written back.
            const wanted = readPresentParameters(parameters >>> 0, deviceWindow);
            const window = (wanted.hDeviceWindow >>> 0) || deviceWindow;
            /** @type {{ swapChain?: any }} */
            const held = {};
            const hr = device.CreateAdditionalSwapChain(wanted, held);
            if (hr !== D3D_OK || !held.swapChain)
            {
                return clearAndRefuse(out, hr);
            }
            writePresentParameters(parameters >>> 0, wanted);
            chainWindows.set(held.swapChain, window);
            return handBack(held.swapChain, swapChainInterfaces, IID_IDirect3DSwapChain8,
                out >>> 0, D3DERR_OUTOFVIDEOMEMORY, device);
        },

        // The caller waits while the picture comes back from the GPU.
        /** @param {any} device @param {number[]} args */
        GetFrontBuffer: (device, [destination])=>
            device.GetFrontBuffer(publisher.objectAt(destination)),

        // --- resources ---

        // The multisample type is dropped rather than refused, the same way the
        // presentation parameters' is: this device renders one sample per pixel
        // whatever it is asked for, and a target that differs from the back
        // buffer only in that is still a target it can draw into.
        /** @param {any} device @param {number[]} args */
        CreateRenderTarget: (device, [width, height, format, , lockable, out])=>{
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = device.CreateRenderTarget(
                width >>> 0, height >>> 0, format >>> 0, lockable !== 0, held);
            if (hr === D3D_OK && held.surface && (out >>> 0) !== 0)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface8,
                    out >>> 0, D3DERR_OUTOFVIDEOMEMORY, device);
            }
            return clearAndRefuse(out, hr);
        },

        /** @param {any} device @param {number[]} args */
        CreateDepthStencilSurface: (device, [width, height, format, , out])=>{
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = device.CreateDepthStencilSurface(
                width >>> 0, height >>> 0, format >>> 0, held);
            if (hr === D3D_OK && held.surface && (out >>> 0) !== 0)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface8,
                    out >>> 0, D3DERR_OUTOFVIDEOMEMORY, device);
            }
            return clearAndRefuse(out, hr);
        },

        /** @param {any} device @param {number[]} args */
        CreateCubeTexture: (device, [edgeLength, levels, usage, format, pool, out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ texture?: any }} */
            const held = {};
            const hr = device.CreateCubeTexture(edgeLength >>> 0, levels >>> 0, usage >>> 0,
                format >>> 0, pool >>> 0, held);
            if (hr === D3D_OK && held.texture)
            {
                attachTexture(device, held.texture);
                return handBack(held.texture, cubeTextureInterfaces, IID_IDirect3DCubeTexture8,
                    out >>> 0, D3DERR_OUTOFVIDEOMEMORY, device);
            }
            return clearAndRefuse(out, hr);
        },

        /** @param {any} device @param {number[]} args */
        CreateVolumeTexture: (device, [width, height, depth, levels, usage, format, pool, out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ texture?: any }} */
            const held = {};
            const hr = device.CreateVolumeTexture(width >>> 0, height >>> 0, depth >>> 0,
                levels >>> 0, usage >>> 0, format >>> 0, pool >>> 0, held);
            if (hr === D3D_OK && held.texture)
            {
                attachTexture(device, held.texture);
                return handBack(held.texture, volumeTextureInterfaces,
                    IID_IDirect3DVolumeTexture8, out >>> 0, D3DERR_OUTOFVIDEOMEMORY, device);
            }
            return clearAndRefuse(out, hr);
        },

        /** @param {any} device @param {number[]} args */
        CopyRects: (device, [source, rects, count, destination, points])=>{
            /** @type {{ moves?: any[] }} */
            const held = {};
            const hr = device.CopyRects(
                publisher.objectAt(source),
                readArrayOf(rects, count >>> 0, RECT), count >>> 0,
                publisher.objectAt(destination),
                readArrayOf(points, count >>> 0, POINT), held);
            /** @param {number} code */
            const settle = code=>{
                if (code === D3D_OK)
                {
                    applyMoves(held.moves ?? []);
                }
                return code;
            };
            // A copy out of a render target waits for its pixels to be read back.
            return typeof hr === 'number' ? settle(hr) : hr.then(settle);
        },

        /** @param {any} device @param {number[]} args */
        UpdateTexture: (device, [source, destination])=>{
            /** @type {{ moves?: any[] }} */
            const held = {};
            const hr = device.UpdateTexture(
                publisher.objectAt(source), publisher.objectAt(destination), held);
            if (hr === D3D_OK)
            {
                applyMoves(held.moves ?? []);
            }
            return hr;
        },

        // --- state a program reads back ---

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
            // The product is the device's own, and the block holds the matrix
            // before it.
            shadowOf(device)?.refreshTransform(type >>> 0);
            return hr;
        },

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

        // The dword written back is the device's own answer rather than a
        // boolean made here: this call reports a value a program compares
        // against zero and nothing else.
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
        SetClipStatus: (device, [pointer])=>{
            if ((pointer >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            const raw = fields.readStruct(pointer >>> 0, D3DCLIPSTATUS8);
            return device.SetClipStatus({
                ClipUnion: raw.ClipUnion,
                ClipIntersection: raw.ClipIntersection,
            });
        },

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
                fields.writeStruct(out >>> 0, D3DCLIPSTATUS8, held.status);
            }
            return hr;
        },

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
                    ? publisher.publish(held.texture, textureKind(held.texture).interfaces,
                        textureKind(held.texture).id)
                    : 0);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        GetTextureStageState: (device, [stage, type, out])=>{
            /** @type {{ value?: number }} */
            const held = {};
            const hr = device.GetTextureStageState(stage >>> 0, type >>> 0, held);
            if (hr === D3D_OK && (out >>> 0) !== 0)
            {
                fields.writeU32(out >>> 0, held.value ?? 0);
            }
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

        // The retail answer: the call succeeded and there is nothing to report,
        // which is what a program checks for before reading the structure it
        // passed. Nothing is written into it.
        GetInfo: ()=>S_FALSE,

        // --- state blocks ---

        /** @param {any} device */
        BeginStateBlock: (/** @type {any} */ device)=>{
            const hr = device.BeginStateBlock();
            if (hr === D3D_OK)
            {
                // A block captures what the program set, not what changed, so
                // every setter crosses while one is recording.
                shadowOf(device)?.slowPath(true);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        EndStateBlock: (device, [out])=>{
            /** @type {{ handle?: number }} */
            const held = {};
            const hr = device.EndStateBlock(held);
            shadowOf(device)?.slowPath(false);
            if (hr === D3D_OK && (out >>> 0) !== 0)
            {
                fields.writeU32(out >>> 0, held.handle ?? 0);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        ApplyStateBlock: (device, [handle])=>{
            /** @type {import('../d3d8/stateblock.js').StateBlock | undefined} */
            const block = device.stateBlocks?.get(handle >>> 0);
            const hr = device.ApplyStateBlock(handle >>> 0);
            // What the block holds is all it changed: the guest's copy is
            // brought to those states and no others, rather than read back
            // whole -- every render state, matrix and stage state -- on
            // every apply.
            shadowOf(device)?.remirror(block && {
                renderStates: block.renderStates.keys(),
                transforms: block.transforms.keys(),
                stageStates: block.stageStates.keys(),
                viewport: block.viewport !== undefined,
            });
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        CaptureStateBlock: (device, [handle])=>device.CaptureStateBlock(handle >>> 0),

        /** @param {any} device @param {number[]} args */
        DeleteStateBlock: (device, [handle])=>device.DeleteStateBlock(handle >>> 0),

        /** @param {any} device @param {number[]} args */
        CreateStateBlock: (device, [type, out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ handle?: number }} */
            const held = {};
            const hr = device.CreateStateBlock(type >>> 0, held);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0, held.handle ?? 0);
            }
            return hr;
        },

        // --- streams, palettes and shaders ---

        /** @param {any} device @param {number[]} args */
        GetStreamSource: (device, [index, out, stride])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ buffer?: any, stride?: number }} */
            const held = {};
            const hr = device.GetStreamSource(index >>> 0, held);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0, held.buffer
                    ? publisher.publish(held.buffer, vertexBufferInterfaces,
                        IID_IDirect3DVertexBuffer8)
                    : 0);
                if ((stride >>> 0) !== 0)
                {
                    fields.writeU32(stride >>> 0, held.stride ?? 0);
                }
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        GetIndices: (device, [out, base])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ buffer?: any, baseVertexIndex?: number }} */
            const held = {};
            const hr = device.GetIndices(held);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0, held.buffer
                    ? publisher.publish(held.buffer, indexBufferInterfaces,
                        IID_IDirect3DIndexBuffer8)
                    : 0);
                if ((base >>> 0) !== 0)
                {
                    fields.writeU32(base >>> 0, held.baseVertexIndex ?? 0);
                }
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
        ProcessVertices: (device, [start, index, count, destination, flags])=>{
            // The guest's own writes into the source and destination are in
            // guest memory already; a lock it holds in the guest is settled
            // first, so the renderer sees one lock.
            const buffer = publisher.objectAt(destination);
            resourceShadows.get(buffer)?.settleBuffer(buffer);
            return device.ProcessVertices(start >>> 0, index >>> 0, count >>> 0, buffer,
                flags >>> 0);
        },

        /**
         * The declaration is read to its end token, and the function, when
         * there is one, to its own. The usage asks for software vertex
         * processing, which the one stage there is serves either way.
         *
         * @param {any} device @param {number[]} args
         */
        CreateVertexShader: (device, [declaration, code, out])=>{
            if ((declaration >>> 0) === 0 || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            const length = declarationLength(
                index=>fields.readU32((declaration >>> 0) + index * 4));
            const tokens = (code >>> 0) === 0 ? null : readFunction(code >>> 0);
            if (length < 0 || ((code >>> 0) !== 0 && !tokens))
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ handle?: number }} */
            const held = {};
            const hr = device.CreateVertexShader(readDwords(declaration >>> 0, length), tokens,
                held);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0, held.handle ?? 0);
            }
            return hr;
        },

        // One dword, two meanings: a vertex format goes through it as well
        // as a handle, and that is how every fixed-function draw declares its
        // vertices.
        /** @param {any} device @param {number[]} args */
        SetVertexShader: (device, [handle])=>device.SetVertexShader(handle >>> 0),

        GetVertexShaderDeclaration: tokensOf('GetVertexShaderDeclaration'),
        GetVertexShaderFunction: tokensOf('GetVertexShaderFunction'),

        /** @param {any} device @param {number[]} args */
        SetVertexShaderConstant: (device, [register, data, count])=>((data >>> 0) === 0
            ? D3DERR_INVALIDCALL
            // No more is read than the file holds; a count past it is refused.
            : device.SetVertexShaderConstant(register >>> 0, readFloats(data >>> 0,
                Math.min(count >>> 0, device.caps.maxVertexShaderConst ?? 0) * 4), count >>> 0)),

        /** @param {any} device @param {number[]} args */
        GetVertexShaderConstant: (device, [register, data, count])=>{
            if ((data >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ values?: Float32Array }} */
            const held = {};
            const hr = device.GetVertexShaderConstant(register >>> 0, count >>> 0, held);
            if (hr === D3D_OK && held.values)
            {
                writeFloats(data >>> 0, held.values);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        GetVertexShader: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ handle?: number }} */
            const held = {};
            const hr = device.GetVertexShader(held);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0, held.handle ?? 0);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        DeleteVertexShader: (device, [handle])=>device.DeleteVertexShader(handle >>> 0),

        /** @param {any} device @param {number[]} args */
        CreatePixelShader: (device, [code, out])=>{
            const tokens = (code >>> 0) === 0 ? null : readFunction(code >>> 0);
            if (!tokens || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ handle?: number }} */
            const held = {};
            const hr = device.CreatePixelShader(tokens, held);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0, held.handle ?? 0);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetPixelShader: (device, [handle])=>device.SetPixelShader(handle >>> 0),

        GetPixelShaderFunction: tokensOf('GetPixelShaderFunction'),

        /** @param {any} device @param {number[]} args */
        SetPixelShaderConstant: (device, [register, data, count])=>((data >>> 0) === 0
            ? D3DERR_INVALIDCALL
            : device.SetPixelShaderConstant(register >>> 0, readFloats(data >>> 0,
                Math.min(count >>> 0, PIXEL_SHADER_CONSTANTS) * 4), count >>> 0)),

        /** @param {any} device @param {number[]} args */
        GetPixelShaderConstant: (device, [register, data, count])=>{
            if ((data >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ values?: Float32Array }} */
            const held = {};
            const hr = device.GetPixelShaderConstant(register >>> 0, count >>> 0, held);
            if (hr === D3D_OK && held.values)
            {
                writeFloats(data >>> 0, held.values);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        GetPixelShader: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ handle?: number }} */
            const held = {};
            const hr = device.GetPixelShader(held);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0, held.handle ?? 0);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        DeletePixelShader: (device, [handle])=>device.DeletePixelShader(handle >>> 0),
    };

    // Every method of the device first makes what the guest did since the
    // host last looked -- the buffers it let go of, then the calls in the
    // command ring -- so a read, a draw or a present sees the state the
    // program set last, through the same methods a trap would have called,
    // which is where validation and invalidation live; and after it, what
    // the guest's routines check a call against is the device's again.
    const refusedLoudly = loudRefusals('Direct3D 8', divergence);
    /** @type {Record<string, (device: any, args: number[]) => number | Promise<number>>} */
    const syncedMethods = Object.fromEntries(Object.entries(deviceMethods)
        .map(([name, method])=>[name, (/** @type {any} */ device, /** @type {number[]} */ args)=>
            refusedLoudly(name, settledAfter(shadowOf(device), ()=>method(device, args)))]));
    /** @type {Record<string, (builder: { trap: number }) => number>} */
    const deviceGuests = guestsBut(deviceGroup, allocate
        ? {
            GetRenderState: ({ trap })=>placeCode(at=>getRenderStateCode(at, trap)),
            GetTransform: ({ trap })=>placeCode(at=>getTransformCode(at, trap)),
            GetTextureStageState: ({ trap })=>placeCode(at=>getTextureStageStateCode(at, trap,
                STAGE_STATE_TYPES_8)),
            GetViewport: ({ trap })=>placeCode(at=>getViewportCode(at, trap)),
            ...Object.fromEntries(Object.entries(D3D8_COMMANDS.COMMANDS).map(([name, shape])=>[
                name, (/** @type {{ trap: number }} */ { trap })=>placeCode(at=>commandCode(at,
                    trap, { ...shape, slot: D3D8_COMMANDS.commandSlot(name),
                        mirror: COMMAND_MIRRORS[name] }))])),
        }
        : {});
    const deviceInterfaces = [
        describe(IID_IDirect3DDevice8, IDIRECT3DDEVICE8_SLOTS, syncedMethods, deviceGuests),
    ];

    /**
     * The presentation parameters, with a back buffer size that is a size.
     *
     * A windowed device may ask for zero by zero, which means "the size of the
     * device window" -- and the layer below has no window to measure, so the
     * display this build is configured for is the nearest true answer. Resolved
     * here because this is the only side that knows the display, and because
     * both CreateDevice and Reset come through it.
     *
     * A zero left alone describes a surface with no rows, no pitch and no
     * storage, which the program then reads with its own idea of the mode. What
     * kept that from being visible was an implicit back buffer allocated a fixed
     * megabyte whatever its size: a read past a zero-sized surface landed in
     * slack. Sized properly, it lands in the next allocation instead, so the
     * zero has to be answered rather than carried.
     *
     * @param {number} address
     * @param {number} [window]
     *        The window the device presents into when the parameters name
     *        none: the focus window a creation was given, or the window a
     *        previous device was made into.
     */
    const readPresentParameters = (address, window = 0)=>{
        const raw = fields.readStruct(address, D3DPRESENT_PARAMETERS8);
        const display = screen();
        const asked = { width: raw.BackBufferWidth >>> 0, height: raw.BackBufferHeight >>> 0 };
        // A size asked for as zero by zero means the device window's client
        // area, which is what the real device answers and what the program's
        // own layout is measured against. Fullscreen has no window to measure
        // -- its window is about to become the mode -- so the display stands
        // for the mode there, and a windowed window this layer cannot measure
        // falls back to the display and says so: the program then has a size
        // its window does not, and every layout computed from it is for
        // another screen.
        const windowed = raw.Windowed !== 0;
        const named = windowed ? ((raw.hDeviceWindow >>> 0) || (window >>> 0)) : 0;
        const measured = named === 0 ? null : windowClientSize?.(named) ?? null;
        if ((asked.width === 0 || asked.height === 0) && windowed && measured === null)
        {
            divergence?.('Direct3D 8',
                'a back buffer asked for as zero by zero is the size of the device window,'
                + ' and that window could not be measured: the configured display is'
                + ' used instead');
        }
        const taken = measured ?? display;
        return {
            backBufferWidth: asked.width === 0 ? taken.width : asked.width,
            backBufferHeight: asked.height === 0 ? taken.height : asked.height,
            backBufferFormat: raw.BackBufferFormat,
            backBufferCount: raw.BackBufferCount,
            multiSampleType: raw.MultiSampleType,
            swapEffect: raw.SwapEffect,
            hDeviceWindow: raw.hDeviceWindow,
            windowed: raw.Windowed !== 0,
            enableAutoDepthStencil: raw.EnableAutoDepthStencil !== 0,
            autoDepthStencilFormat: raw.AutoDepthStencilFormat,
            flags: raw.Flags,
            fullScreenRefreshRateInHz: raw.FullScreen_RefreshRateInHz,
            fullScreenPresentationInterval: raw.FullScreen_PresentationInterval,
        };
    };

    /**
     * Only the fields this version reports back are written.
     *
     * Direct3D 8 fills in the back buffer count and leaves the width and height
     * at whatever the caller wrote -- including zero. Writing them would be
     * helpful and wrong: a program that asked for a zero and reads back a size
     * concludes it got a mode it never requested.
     *
     * @param {number} address
     * @param {any} parameters
     */
    const writePresentParameters = (address, parameters)=>{
        fields.writeStruct(address, D3DPRESENT_PARAMETERS8, {
            BackBufferCount: parameters.backBufferCount ?? 1,
        });
    };

    /**
     * D3DADAPTER_IDENTIFIER8, from what the assembling caller knows of the
     * hardware: the vendor, name and GUID every generation reports. A vendor
     * with no PCI id is reported as zero, which every program reads as a card
     * it does not know rather than as a refusal.
     *
     * @param {number} address @param {number} flags D3DENUM_*
     */
    const writeAdapterIdentifier = (address, flags)=>{
        const { vendorId, description } = describeAdapter(identity?.() ?? null);
        const block = new Uint8Array(D3DADAPTER_IDENTIFIER8.FIELDS);
        /** @param {string} text @param {number} at */
        const ascii = (text, at)=>{
            for (let index = 0; index < Math.min(text.length, ADAPTER_STRING_LENGTH - 1); index++)
            {
                block[at + index] = text.charCodeAt(index) & 0x7f;
            }
        };
        ascii('webgpu', D3DADAPTER_IDENTIFIER8.Driver);
        ascii(description, D3DADAPTER_IDENTIFIER8.Description);
        const view = new DataView(block.buffer);
        // A version of 1.0.0.0: the product word of the LARGE_INTEGER is its
        // high dword, and a program that prints it prints something sane.
        view.setUint32(D3DADAPTER_IDENTIFIER8.DriverVersion + 4, 0x00010000, true);
        view.setUint32(D3DADAPTER_IDENTIFIER8.VendorId, vendorId, true);
        block.set(ADAPTER_GUID, D3DADAPTER_IDENTIFIER8.DeviceIdentifier);
        // Certified unless the caller said not to ask: the flag exists because
        // asking took seconds on real Windows, and a program that passes it
        // expects a zero rather than an answer.
        view.setUint32(D3DADAPTER_IDENTIFIER8.WHQLLevel,
            (flags & D3DENUM_NO_WHQL_LEVEL) !== 0 ? 0 : 1, true);
        memory.writeMemory(address, block);
    };

    /** @param {number} address */
    const writeDisplayMode = address=>{
        const display = screen();
        fields.writeStruct(address, D3DDISPLAYMODE, {
            Width: display.width,
            Height: display.height,
            RefreshRate: REFRESH_HZ,
            // D3DFMT_X8R8G8B8, which is what a 32-bit display reports.
            Format: 22,
        });
    };

    /**
     * The formats an adapter's modes are offered in, as a driver of the era
     * lists them: 32-bit colour and 16-bit. Direct3D 8 lists every mode in
     * every format under one index, and a program given both takes whichever
     * it finds first, so every 32-bit mode comes before the first 16-bit one.
     */
    const ADAPTER_FORMATS = Object.freeze([22, 23]);

    /**
     * Every mode the adapter offers, in the order a program walks them: each
     * size in each format, sizes smallest first.
     *
     * @returns {{ width: number, height: number, refresh: number, format: number }[]}
     */
    const adapterModes = ()=>ADAPTER_FORMATS.flatMap(format=>displayModes(screen())
        .map(mode=>({ width: mode.width, height: mode.height, refresh: mode.refresh, format })));

    /**
     * What this device says it can do.
     *
     * Every number here is a claim something acts on, and the ones that read as
     * zero are the dangerous half: a program takes zero as an answer, not as a
     * gap. The maximum texture size is the clearest case -- a program that
     * halves a texture until it fits the maximum halves it for ever against a
     * maximum of zero, and what that looks like from outside is a machine that
     * is running perfectly and getting nowhere.
     *
     * The values describe what the renderer behind this actually does: the
     * fixed-function stages, vertex shaders to 1.1 and pixel shaders to 1.4
     * translated to the GPU's own, and filtering and addressing a GPU of any
     * generation has.
     *
     * @param {number} address @param {any} caps
     */
    const writeCaps = (address, caps)=>{
        // Zeroed first: the structure is long, a caller allocates all of it,
        // and every field this does not set has to read as "not supported"
        // rather than as whatever was on the stack.
        memory.writeMemory(address, new Uint8Array(D3DCAPS8.SIZE));
        fields.writeStruct(address, D3DCAPS8, {
            DeviceType: D3DDEVTYPE.HAL,
            Caps: D3DCAPS_READ_SCANLINE,
            // A full-screen device's ramp is claimed where the display shows it.
            Caps2: D3DCAPS2_CANRENDERWINDOWED
                | (caps.fullscreenGamma === true ? D3DCAPS2_FULLSCREENGAMMA : 0),
            PresentationIntervals: D3DPRESENT_INTERVAL_IMMEDIATE | D3DPRESENT_INTERVAL_ONE,
            CursorCaps: D3DCURSORCAPS_COLOR | D3DCURSORCAPS_LOWRES,
            DevCaps: D3DDEVCAPS_HWTRANSFORMANDLIGHT | D3DDEVCAPS_HWRASTERIZATION
                | D3DDEVCAPS_DRAWPRIMTLVERTEX | D3DDEVCAPS_DRAWPRIMITIVES2
                | D3DDEVCAPS_DRAWPRIMITIVES2EX | D3DDEVCAPS_EXECUTESYSTEMMEMORY
                | D3DDEVCAPS_TEXTUREVIDEOMEMORY | D3DDEVCAPS_TEXTURENONLOCALVIDMEM
                | D3DDEVCAPS_CANRENDERAFTERFLIP,
            // The stages' temporary register is the generated cascade's own.
            PrimitiveMiscCaps: D3DPMISCCAPS_CULLNONE | D3DPMISCCAPS_CULLCW
                | D3DPMISCCAPS_CULLCCW | D3DPMISCCAPS_MASKZ
                | D3DPMISCCAPS_COLORWRITEENABLE | D3DPMISCCAPS_BLENDOP | D3DPMISCCAPS_TSSARGTEMP,
            // D3DRS_ZBIAS and MAXANISOTROPY are read, and the level bias, which
            // the shader adds where no WebGPU sampler takes one.
            RasterCaps: D3DPRASTERCAPS_DITHER | D3DPRASTERCAPS_ZTEST
                | D3DPRASTERCAPS_FOGVERTEX | D3DPRASTERCAPS_FOGTABLE | D3DPRASTERCAPS_FOGRANGE
                | D3DPRASTERCAPS_WFOG | D3DPRASTERCAPS_ZFOG | D3DPRASTERCAPS_ZBIAS
                | D3DPRASTERCAPS_ANISOTROPY | D3DPRASTERCAPS_MIPMAPLODBIAS,
            // Every comparison a depth test can ask for; the backend maps them
            // one to one onto its own.
            ZCmpCaps: ALL_COMPARE_CAPS,
            SrcBlendCaps: ALL_BLEND_CAPS,
            DestBlendCaps: ALL_BLEND_CAPS,
            AlphaCmpCaps: ALL_COMPARE_CAPS,
            ShadeCaps: D3DPSHADECAPS_COLORGOURAUDRGB | D3DPSHADECAPS_SPECULARGOURAUDRGB
                | D3DPSHADECAPS_ALPHAGOURAUDBLEND | D3DPSHADECAPS_FOGGOURAUD,
            // No palette alpha: no palettised format is ever made.
            TextureCaps: D3DPTEXTURECAPS_PERSPECTIVE | D3DPTEXTURECAPS_ALPHA
                | D3DPTEXTURECAPS_PROJECTED | D3DPTEXTURECAPS_MIPMAP
                | D3DPTEXTURECAPS_CUBEMAP | D3DPTEXTURECAPS_MIPCUBEMAP
                | D3DPTEXTURECAPS_VOLUMEMAP | D3DPTEXTURECAPS_MIPVOLUMEMAP,
            TextureFilterCaps: FILTER_CAPS,
            CubeTextureFilterCaps: FILTER_CAPS,
            VolumeTextureFilterCaps: FILTER_CAPS,
            TextureAddressCaps: ADDRESS_CAPS,
            VolumeTextureAddressCaps: ADDRESS_CAPS,
            LineCaps: D3DLINECAPS_TEXTURE | D3DLINECAPS_ZTEST | D3DLINECAPS_BLEND
                | D3DLINECAPS_ALPHACMP | D3DLINECAPS_FOG,
            MaxTextureWidth: caps.maxTextureWidth ?? 4096,
            MaxTextureHeight: caps.maxTextureHeight ?? 4096,
            MaxVolumeExtent: caps.maxVolumeExtent ?? 256,
            MaxTextureRepeat: caps.maxTextureRepeat ?? 8192,
            MaxTextureAspectRatio: caps.maxTextureAspectRatio ?? 4096,
            MaxAnisotropy: caps.maxAnisotropy ?? 16,
            StencilCaps: STENCIL_CAPS,
            FVFCaps: D3DFVFCAPS_PSIZE | 8,
            TextureOpCaps: TEXTURE_OP_CAPS,
            MaxTextureBlendStages: caps.maxTextureBlendStages ?? 8,
            MaxSimultaneousTextures: caps.maxSimultaneousTextures ?? 8,
            VertexProcessingCaps: D3DVTXPCAPS_TEXGEN | D3DVTXPCAPS_MATERIALSOURCE7
                | D3DVTXPCAPS_DIRECTIONALLIGHTS | D3DVTXPCAPS_POSITIONALLIGHTS
                | D3DVTXPCAPS_LOCALVIEWER,
            MaxActiveLights: caps.maxActiveLights ?? 8,
            // Nothing clips against a program's planes or blends by vertex
            // weights, which is what Direct3D 9 answers for the same reason.
            MaxUserClipPlanes: caps.maxUserClipPlanes ?? 0,
            MaxVertexBlendMatrices: caps.maxVertexBlendMatrices ?? 0,
            MaxVertexBlendMatrixIndex: caps.maxVertexBlendMatrixIndex ?? 0,
            MaxPrimitiveCount: caps.maxPrimitiveCount ?? 0xffff,
            MaxVertexIndex: caps.maxVertexIndex ?? 0xffff,
            MaxStreams: caps.maxStreams ?? 16,
            MaxStreamStride: caps.maxStreamStride ?? 256,
            VertexShaderVersion: (D3DVS_VERSION_MARK | ((caps.vertexShaderVersion?.major ?? 0) << 8)
                | (caps.vertexShaderVersion?.minor ?? 0)) >>> 0,
            MaxVertexShaderConst: caps.vertexShaderVersion?.major
                ? caps.maxVertexShaderConst ?? 0 : 0,
            PixelShaderVersion: (D3DPS_VERSION_MARK | ((caps.pixelShaderVersion?.major ?? 0) << 8)
                | (caps.pixelShaderVersion?.minor ?? 0)) >>> 0,
        });
        // The floats, which the same writer cannot place without being told.
        // MaxVertexW is the largest homogeneous W a vertex may carry; a zero
        // there is read as "no clipping headroom at all".
        fields.writeStruct(address, D3DCAPS8, {
            MaxPointSize: caps.maxPointSize ?? 64,
            MaxVertexW: caps.maxVertexW ?? 1e10,
            GuardBandLeft: -1e9,
            GuardBandTop: -1e9,
            GuardBandRight: 1e9,
            GuardBandBottom: 1e9,
            ExtentsAdjust: 0,
            // A 1.x shader's registers hold [-1, 1]: its constants read so.
            MaxPixelShaderValue: caps.pixelShaderVersion?.major ? 1 : 0,
        }, ['MaxPointSize', 'MaxVertexW', 'GuardBandLeft', 'GuardBandTop',
            'GuardBandRight', 'GuardBandBottom', 'ExtentsAdjust', 'MaxPixelShaderValue']);
    };

    const rootMethods = {
        // Accepted and ignored: no software rasteriser is ever plugged in.
        RegisterSoftwareDevice: ()=>D3D_OK,
        GetAdapterCount: ()=>1,

        // An HMONITOR rather than an HRESULT: the display user32 names for
        // every window, and none for an adapter that does not exist.
        /** @param {any} root @param {number[]} args */
        GetAdapterMonitor: (root, [adapter])=>((adapter >>> 0) === 0 ? PRIMARY_MONITOR : 0),

        /**
         * Who made the adapter, as a program's card database wants to know.
         *
         * Not optional, whatever the rest of this build can say about the
         * hardware: a program of this era looks its adapter up before deciding
         * how much to ask of it, and one refused an answer takes the refusal as
         * the most cautious hardware it knows -- sixteen-bit textures, a
         * sixteen-bit depth buffer -- and draws a worse picture than the device
         * behind this can make.
         *
         * @param {any} root @param {number[]} args
         */
        GetAdapterIdentifier: (root, [adapterIndex, flags, out])=>{
            if ((adapterIndex >>> 0) !== 0 || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            writeAdapterIdentifier(out >>> 0, flags >>> 0);
            return D3D_OK;
        },

        /** @param {any} root @param {number[]} args */
        GetAdapterDisplayMode: (root, [, out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            writeDisplayMode(out >>> 0);
            return D3D_OK;
        },

        // The whole list, because a program builds its resolution menu from
        // it and every entry can be set: the surface follows the size a device
        // is created at. Answering one mode gave such a program a menu of one.
        GetAdapterModeCount: ()=>adapterModes().length,

        /** @param {any} root @param {number[]} args */
        EnumAdapterModes: (root, [, mode, out])=>{
            const listed = adapterModes()[mode >>> 0];
            if ((out >>> 0) === 0 || !listed)
            {
                return D3DERR_INVALIDCALL;
            }
            fields.writeStruct(out >>> 0, D3DDISPLAYMODE, {
                Width: listed.width,
                Height: listed.height,
                RefreshRate: listed.refresh,
                Format: listed.format,
            });
            return D3D_OK;
        },

        // The four questions a program asks before it settles on a device. Each
        // is answered by the object behind this from the same tables its own
        // creates consult, so a format approved here is one that can be made.
        /** @param {any} root @param {number[]} args */
        CheckDeviceType: (root, [, , adapterFormat, backBufferFormat])=>
            root.CheckDeviceType(adapterFormat >>> 0, backBufferFormat >>> 0),

        /** @param {any} root @param {number[]} args */
        CheckDeviceFormat: (root, [, , , usage, resourceType, format])=>
            root.CheckDeviceFormat(usage >>> 0, resourceType >>> 0, format >>> 0),

        /** @param {any} root @param {number[]} args */
        CheckDeviceMultiSampleType: (root, [, , , , type])=>
            root.CheckDeviceMultiSampleType(type >>> 0),

        /** @param {any} root @param {number[]} args */
        CheckDepthStencilMatch: (root, [, , , targetFormat, depthFormat])=>
            root.CheckDepthStencilMatch(targetFormat >>> 0, depthFormat >>> 0),

        /** @param {any} root @param {number[]} args */
        GetDeviceCaps: (root, [, , out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            writeCaps(out >>> 0, root.caps ?? {});
            return D3D_OK;
        },

        /** @param {any} root @param {number[]} args */
        CreateDevice: (root, [adapter, deviceType, focus, behaviourFlags, parameters, out])=>{
            if ((parameters >>> 0) === 0 || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            const wanted = readPresentParameters(parameters >>> 0, focus >>> 0);
            /** @type {{ device?: any }} */
            const held = {};
            // The first three arguments are kept rather than dropped: they are
            // what GetCreationParameters has to answer with, and a device that
            // described itself instead would be describing a device the program
            // never asked for.
            const hr = root.CreateDevice(wanted, held, behaviourFlags >>> 0, {
                AdapterOrdinal: adapter >>> 0,
                DeviceType: deviceType >>> 0,
                hFocusWindow: focus >>> 0,
            });
            writePresentParameters(parameters >>> 0, wanted);
            if (hr === D3D_OK && held.device)
            {
                // The window is now this resolution; the reported screen is too.
                // Fullscreen, the device's window follows the mode, as the real
                // device moves it; windowed, the window is the program's own.
                // The window is kept for a later Reset, whose present
                // parameters need not repeat it.
                deviceWindow = (wanted.hDeviceWindow >>> 0) || (focus >>> 0);
                takeScreen(held.device, wanted, deviceWindow);
            }
            if (hr !== D3D_OK || !held.device)
            {
                // Cleared, because a caller checks the pointer it passed as
                // often as it checks the result.
                fields.writeU32(out >>> 0, 0);
                return hr;
            }
            if (allocate)
            {
                // The device's block, which the guest methods find one word
                // past the interface pointer. Made before the interface is
                // published, because publishing is when that word is written:
                // a device given out first would carry a zero there, and the
                // guest methods would keep the program's state at address
                // zero, out of the host's sight.
                /** @type {ReturnType<typeof createShadow>} */
                const shadow = createShadow({
                    allocate,
                    // The block is read on every device call and compared
                    // in place, so the window, where there is one.
                    readMemory: memory.windowMemory ?? memory.readMemory,
                    readU32: memory.readU32,
                    writeMemory: memory.writeMemory,
                    device: held.device,
                    divergence,
                    commands: { take: records=>{
                        const made = held.device.commands(records,
                            D3D8_COMMANDS.commandObjects(records, publisher.objectAt));
                        // A target set in the ring is a new viewport, and
                        // what a draw is checked against is the device's.
                        if (shadow.stale())
                        {
                            shadow.remirror({ viewport: true });
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
            const result = handBack(held.device, deviceInterfaces, IID_IDirect3DDevice8,
                out >>> 0, D3DERR_OUTOFVIDEOMEMORY);
            if (result === D3D_OK)
            {
                // Held so the layer's diagnostics can reach the renderer's
                // counters. The most recent one only: a program makes one
                // device and remakes it on a reset, and keeping every one it
                // ever had would hold a released device's resources alive to
                // say nothing new about them. A device the program was never
                // given is not one of them.
                lastDevice = held.device;
            }
            return result;
        },
    };

    /** Tells the taker the cursor the device holds, when it changed. */
    const tellCursor = cursor ? createCursorTeller(cursor, memory.readMemory) : ()=>{};

    const rootInterfaces = [describe(IID_IDirect3D8, IDIRECT3D8_SLOTS, rootMethods)];

    /** @type {any} */
    let lastDevice = null;
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

    return {
        /**
         * Publishes the object Direct3DCreate8 hands back.
         *
         * @param {any} root  What graphics.create('d3d8') returned.
         * @returns {number}
         */
        publishRoot: root=>publisher.publish(root, rootInterfaces, IID_IDirect3D8),

        /** What the device this program is drawing through has counted. */
        diagnostics: ()=>lastDevice?.diagnostics?.() ?? null,

        /** What the guest set without crossing, for the most recent device. */
        shadow: ()=>(lastDevice ? shadowOf(lastDevice)?.diagnostics() ?? null : null),

        /** For tests, which have no guest to call through. */
        interfaces: { root: rootInterfaces, device: deviceInterfaces,
            surface: surfaceInterfaces, texture: textureInterfaces },
    };
}
