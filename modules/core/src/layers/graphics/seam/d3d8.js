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
 * making the same point more loudly: the shaders, the cube and volume textures,
 * the additional swap chain, the palettes, the cursor and the transformed-vertex
 * path are all refused, each because the renderer behind this cannot honour
 * what succeeding would promise. Every one of them says so where it stands. A
 * refusal is a reply a program acts on -- usually by taking the path this build
 * does draw -- where a success it cannot see through leaves it drawing nothing
 * and looking somewhere else for the reason.
 *
 * Out-parameters are where this is easy to get wrong in a way nothing reports.
 * A method that hands back an interface writes a pointer *and* takes a
 * reference; one that hands back a number writes it only if the caller passed
 * somewhere to put it. Both are done here rather than in the API objects,
 * because both are facts about the ABI rather than about Direct3D.
 */

import { describe, IDIRECT3D8_SLOTS, IDIRECT3DDEVICE8_SLOTS, IDIRECT3DSURFACE8_SLOTS,
    IDIRECT3DTEXTURE8_SLOTS, IDIRECT3DVERTEXBUFFER8_SLOTS,
    IDIRECT3DINDEXBUFFER8_SLOTS } from './vtables.js';
import { IID_IDirect3D8, IID_IDirect3DDevice8, IID_IDirect3DSurface8,
    IID_IDirect3DTexture8, IID_IDirect3DVertexBuffer8,
    IID_IDirect3DIndexBuffer8 } from './iids.js';
import { D3DPRESENT_PARAMETERS8, D3DDISPLAYMODE, D3DVIEWPORT8, D3DCAPS8,
    D3DSURFACE_DESC8, D3DLOCKED_RECT, D3DLIGHT7, RECT, POINT, createFields } from './structs.js';
import { D3DDEVTYPE, D3DFMT_INDEX } from '../d3d8/constants.js';
import { D3DCLIPSTATUS8, D3DDEVICE_CREATION_PARAMETERS, D3DGAMMARAMP, D3DRASTER_STATUS,
    GAMMA_RAMP_ENTRIES } from '../d3d8/structs.js';
import { vertexCountOf } from '../d3d8/render.js';
import { createShadow, setRenderStateCode, setTransformCode } from './shadow.js';

/**
 * The capability bits reported by GetDeviceCaps.
 *
 * Named from d3d8caps.h rather than written as one hexadecimal blob, because a
 * blob is unreviewable: nobody can tell a claim we can honour from one we
 * cannot, and every one of these is a claim a program acts on.
 */
const D3DCAPS2_FULLSCREENGAMMA = 0x00020000;
const D3DCAPS2_CANRENDERWINDOWED = 0x00080000;

const D3DPRESENT_INTERVAL_ONE = 0x00000001;
const D3DPRESENT_INTERVAL_IMMEDIATE = 0x80000000;

const D3DDEVCAPS_EXECUTESYSTEMMEMORY = 0x00000010;
const D3DDEVCAPS_TEXTUREVIDEOMEMORY = 0x00000800;
const D3DDEVCAPS_DRAWPRIMTLVERTEX = 0x00001000;
const D3DDEVCAPS_HWTRANSFORMANDLIGHT = 0x00010000;
const D3DDEVCAPS_DRAWPRIMITIVES2 = 0x00002000;
const D3DDEVCAPS_DRAWPRIMITIVES2EX = 0x00008000;
const D3DDEVCAPS_TEXTURENONLOCALVIDMEM = 0x00000200;
const D3DDEVCAPS_HWRASTERIZATION = 0x00080000;

const D3DPMISCCAPS_MASKZ = 0x00000002;
const D3DPMISCCAPS_CULLNONE = 0x00000010;
const D3DPMISCCAPS_CULLCW = 0x00000020;
const D3DPMISCCAPS_CULLCCW = 0x00000040;
const D3DPMISCCAPS_COLORWRITEENABLE = 0x00000080;
const D3DPMISCCAPS_BLENDOP = 0x00000800;

const D3DPRASTERCAPS_DITHER = 0x00000001;
const D3DPRASTERCAPS_ZTEST = 0x00000010;
const D3DPRASTERCAPS_FOGVERTEX = 0x00000080;
const D3DPRASTERCAPS_FOGTABLE = 0x00000100;
const D3DPRASTERCAPS_MIPMAPLODBIAS = 0x00002000;
const D3DPRASTERCAPS_ZBIAS = 0x00004000;
const D3DPRASTERCAPS_ANISOTROPY = 0x00020000;
const D3DPRASTERCAPS_ZFOG = 0x00100000;

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
const D3DPTEXTURECAPS_CUBEMAP = 0x00000800;
const D3DPTEXTURECAPS_MIPMAP = 0x00004000;
const D3DPTEXTURECAPS_MIPCUBEMAP = 0x00010000;
const D3DPTEXTURECAPS_ALPHAPALETTE = 0x00000080;

/** Point, linear and anisotropic, for minification, magnification and mip. */
const ALL_FILTER_CAPS = 0x07070700 | 0x00000700;

const D3DPTADDRESSCAPS_WRAP = 0x00000001;
const D3DPTADDRESSCAPS_MIRROR = 0x00000002;
const D3DPTADDRESSCAPS_CLAMP = 0x00000004;
const D3DPTADDRESSCAPS_BORDER = 0x00000008;
const D3DPTADDRESSCAPS_INDEPENDENTUV = 0x00000010;
const D3DPTADDRESSCAPS_MIRRORONCE = 0x00000020;

const D3DLINECAPS_TEXTURE = 0x00000001;
const D3DLINECAPS_ZTEST = 0x00000002;
const D3DLINECAPS_BLEND = 0x00000004;
const D3DLINECAPS_ALPHACMP = 0x00000008;
const D3DLINECAPS_FOG = 0x00000010;

/** Keep, zero, replace, incr/decr saturating and wrapping, invert. */
const ALL_STENCIL_CAPS = 0x000001ff;

/** Every texture-stage operation d3d8caps.h defines, which is bits 1..25. */
const ALL_TEXTURE_OP_CAPS = 0x03ffffff;

const D3DFVFCAPS_PSIZE = 0x00100000;

const D3DVTXPCAPS_TEXGEN = 0x00000001;
const D3DVTXPCAPS_MATERIALSOURCE7 = 0x00000002;
const D3DVTXPCAPS_DIRECTIONALLIGHTS = 0x00000008;
const D3DVTXPCAPS_POSITIONALLIGHTS = 0x00000010;
const D3DVTXPCAPS_LOCALVIEWER = 0x00000020;

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c | 0;

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
 * @param {Object} deps
 * @param {any} deps.publisher   From createPublisher.
 * @param {any} deps.memory      readMemory/writeMemory.
 * @param {() => any} deps.screen  The display this build is configured for.
 * @param {(bytes: number) => number} [deps.allocate]
 *        Guest memory for the state a program sets without crossing into the
 *        host; without it every setter stays a trap.
 * @param {(api: string, detail: string) => void} [deps.divergence]
 *        Where a value set in the guest that the device refuses is reported.
 */
export function createDirect3D8Seam({ publisher, memory, screen, allocate, divergence }){
    const fields = createFields(memory);

    /**
     * Each device's block of state the guest sets without crossing, and the
     * host's side of it. Only with somewhere to put one: a build without an
     * allocator keeps every setter a trap.
     *
     * @type {WeakMap<any, ReturnType<typeof createShadow>>}
     */
    const shadows = new WeakMap();
    /** @param {any} device */
    const shadowOf = device=>shadows.get(device) ?? null;
    /** @param {(at: number) => Uint8Array} code */
    const placeCode = code=>{
        if (!allocate)
        {
            return 0;
        }
        // Sized by a throwaway rendering: the bytes depend on where they
        // land only through relative jumps, never in length.
        const at = allocate(code(0).length);
        memory.writeMemory(at, code(at));
        return at;
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
     * @returns {number} D3D_OK, or `failure`.
     */
    const handBack = (object, interfaces, id, out, failure = E_OUTOFMEMORY)=>{
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
     */
    const clearAndRefuse = out=>{
        if ((out >>> 0) !== 0)
        {
            fields.writeU32(out >>> 0, 0);
        }
        return D3DERR_NOTAVAILABLE;
    };

    // Resources carry no behaviour of their own here beyond what the API
    // objects already do, so their descriptors are built once.
    const surfaceInterfaces = [describe(IID_IDirect3DSurface8, IDIRECT3DSURFACE8_SLOTS, {
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
            const hr = surface.LockRect(locked, readRect(rect), flags >>> 0);
            if (hr === D3D_OK && (out >>> 0) !== 0)
            {
                fields.writeStruct(out >>> 0, D3DLOCKED_RECT, {
                    Pitch: locked.Pitch ?? 0,
                    pBits: locked.pBits ?? 0,
                });
            }
            return hr;
        },
        /** @param {any} surface */
        UnlockRect: surface=>surface.UnlockRect(),
    })];

    const textureInterfaces = [describe(IID_IDirect3DTexture8, IDIRECT3DTEXTURE8_SLOTS, {
        // The count is a property of the object rather than a method on it, and
        // this answers a number rather than an HRESULT.
        /** @param {any} texture */
        GetLevelCount: texture=>texture.levels ?? 1,
        /** @param {any} texture @param {number[]} args */
        GetSurfaceLevel: (texture, [level, out])=>{
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = texture.GetSurfaceLevel(level >>> 0, held);
            if (hr === D3D_OK && held.surface && (out >>> 0) !== 0)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface8,
                    out >>> 0);
            }
            return hr;
        },

        // A level's description is the description of its surface, which is
        // also the only way to reach one. The reference that reaching it took
        // is given straight back: this call hands out no interface, so a
        // program owes nothing for it.
        /** @param {any} texture @param {number[]} args */
        GetLevelDesc: (texture, [level, out])=>{
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = texture.GetSurfaceLevel(level >>> 0, held);
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
        },

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

        // Noted and nothing else: an unlock already marks the whole level for
        // upload, so there is no smaller area for this to narrow it to.
        AddDirtyRect: ()=>D3D_OK,
    })];

    /**
     * A buffer hands back an address in the guest's own memory, so locking is
     * one out-parameter and nothing else: the program writes there itself, and
     * the unlock is what tells this engine to look.
     */
    const bufferMethods = {
        /** @param {any} buffer @param {number[]} args */
        Lock: (buffer, [offset, size, out, flags])=>{
            /** @type {{ pBits?: number }} */
            const locked = {};
            const hr = buffer.Lock(offset >>> 0, size >>> 0, locked, flags >>> 0);
            if (hr === D3D_OK && (out >>> 0) !== 0)
            {
                fields.writeU32(out >>> 0, locked.pBits ?? 0);
            }
            return hr;
        },
        /** @param {any} buffer */
        Unlock: (/** @type {any} */ buffer)=>buffer.Unlock(),
    };

    const vertexBufferInterfaces = [
        describe(IID_IDirect3DVertexBuffer8, IDIRECT3DVERTEXBUFFER8_SLOTS, bufferMethods),
    ];
    const indexBufferInterfaces = [
        describe(IID_IDirect3DIndexBuffer8, IDIRECT3DINDEXBUFFER8_SLOTS, bufferMethods),
    ];

    /** @param {number} pointer @returns {any} */
    const readRect = pointer=>((pointer >>> 0) === 0
        ? null
        : fields.readStruct(pointer >>> 0, { left: 0, top: 4, right: 8, bottom: 12 }));

    /** @param {number} pointer @param {number} count @returns {Float32Array} */
    const readFloats = (pointer, count)=>new Float32Array(
        memory.readMemory(pointer >>> 0, count * 4).slice().buffer);

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

    /** @param {number} address @param {ArrayLike<number>} values */
    const writeFloats = (address, values)=>{
        for (let index = 0; index < values.length; index++)
        {
            fields.writeF32(address + index * 4, values[index]);
        }
    };

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
        const colours = [material.Diffuse, material.Ambient, material.Specular,
            material.Emissive];
        writeFloats(address, [
            ...colours.flatMap(one=>[one.r, one.g, one.b, one.a]),
            material.Power,
        ]);
    };

    /**
     * D3DLIGHT8, which is D3DLIGHT7's layout under D3D8's names: a type, three
     * colours of four floats, two vectors of three, and seven floats after
     * them.
     *
     * @param {number} pointer
     */
    const readLight = pointer=>{
        const colour = (/** @type {number} */ at)=>{
            const f = readFloats(pointer + at, 4);
            return { r: f[0], g: f[1], b: f[2], a: f[3] };
        };
        const vector = (/** @type {number} */ at)=>{
            const f = readFloats(pointer + at, 3);
            return { x: f[0], y: f[1], z: f[2] };
        };
        return {
            Type: fields.readU32(pointer + D3DLIGHT7.dltType),
            Diffuse: colour(D3DLIGHT7.dcvDiffuse),
            Specular: colour(D3DLIGHT7.dcvSpecular),
            Ambient: colour(D3DLIGHT7.dcvAmbient),
            Position: vector(D3DLIGHT7.dvPosition),
            Direction: vector(D3DLIGHT7.dvDirection),
            Range: fields.readF32(pointer + D3DLIGHT7.dvRange),
            Falloff: fields.readF32(pointer + D3DLIGHT7.dvFalloff),
            Attenuation0: fields.readF32(pointer + D3DLIGHT7.dvAttenuation0),
            Attenuation1: fields.readF32(pointer + D3DLIGHT7.dvAttenuation1),
            Attenuation2: fields.readF32(pointer + D3DLIGHT7.dvAttenuation2),
            Theta: fields.readF32(pointer + D3DLIGHT7.dvTheta),
            Phi: fields.readF32(pointer + D3DLIGHT7.dvPhi),
        };
    };

    /** @param {number} address @param {any} light */
    const writeLight = (address, light)=>{
        fields.writeU32(address + D3DLIGHT7.dltType, light.Type >>> 0);
        const colour = (/** @type {number} */ at, /** @type {any} */ value)=>
            writeFloats(address + at, [value.r, value.g, value.b, value.a]);
        const vector = (/** @type {number} */ at, /** @type {any} */ value)=>
            writeFloats(address + at, [value.x, value.y, value.z]);
        colour(D3DLIGHT7.dcvDiffuse, light.Diffuse);
        colour(D3DLIGHT7.dcvSpecular, light.Specular);
        colour(D3DLIGHT7.dcvAmbient, light.Ambient);
        vector(D3DLIGHT7.dvPosition, light.Position);
        vector(D3DLIGHT7.dvDirection, light.Direction);
        writeFloats(address + D3DLIGHT7.dvRange, [
            light.Range, light.Falloff,
            light.Attenuation0, light.Attenuation1, light.Attenuation2,
            light.Theta, light.Phi,
        ]);
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
        Present: (/** @type {any} */ device)=>device.Present(),

        /** @param {any} device @param {number[]} args */
        Reset: (device, [parameters])=>{
            if ((parameters >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            const next = readPresentParameters(parameters >>> 0);
            const hr = device.Reset(next);
            writePresentParameters(parameters >>> 0, next);
            // The block is brought to what the device now holds, not to what
            // it held before: a reset is the host changing state on its own.
            shadowOf(device)?.remirror();
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetRenderState: (device, [state, value])=>device.SetRenderState(state >>> 0, value >>> 0),

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
            return device.SetViewport(
                fields.readStruct(pointer >>> 0, D3DVIEWPORT8, ['MinZ', 'MaxZ']));
        },

        /** @param {any} device @param {number[]} args */
        GetViewport: (device, [out])=>{
            /** @type {{ viewport?: any }} */
            const held = {};
            const hr = device.GetViewport(held);
            if (hr === D3D_OK && (out >>> 0) !== 0 && held.viewport)
            {
                fields.writeStruct(out >>> 0, D3DVIEWPORT8, held.viewport, ['MinZ', 'MaxZ']);
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
                return handBack(held.texture, textureInterfaces, IID_IDirect3DTexture8,
                    out >>> 0, D3DERR_OUTOFVIDEOMEMORY);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        CreateImageSurface: (device, [width, height, format, out])=>{
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = device.CreateImageSurface(width >>> 0, height >>> 0, format >>> 0, held);
            if (hr === D3D_OK && held.surface && (out >>> 0) !== 0)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface8,
                    out >>> 0);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        CreateVertexBuffer: (device, [length, usage, fvf, pool, out])=>{
            /** @type {{ buffer?: any }} */
            const held = {};
            const hr = device.CreateVertexBuffer(
                length >>> 0, usage >>> 0, fvf >>> 0, pool >>> 0, held);
            if (hr === D3D_OK && held.buffer && (out >>> 0) !== 0)
            {
                return handBack(held.buffer, vertexBufferInterfaces,
                    IID_IDirect3DVertexBuffer8, out >>> 0, D3DERR_OUTOFVIDEOMEMORY);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        CreateIndexBuffer: (device, [length, usage, format, pool, out])=>{
            /** @type {{ buffer?: any }} */
            const held = {};
            const hr = device.CreateIndexBuffer(
                length >>> 0, usage >>> 0, format >>> 0, pool >>> 0, held);
            if (hr === D3D_OK && held.buffer && (out >>> 0) !== 0)
            {
                return handBack(held.buffer, indexBufferInterfaces,
                    IID_IDirect3DIndexBuffer8, out >>> 0, D3DERR_OUTOFVIDEOMEMORY);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        GetBackBuffer: (device, [index, type, out])=>{
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = device.GetBackBuffer(index >>> 0, type >>> 0, held);
            if (hr === D3D_OK && held.surface && (out >>> 0) !== 0)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface8,
                    out >>> 0);
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
        SetTextureStageState: (device, [stage, type, value])=>
            device.SetTextureStageState(stage >>> 0, type >>> 0, value >>> 0),

        // Sixteen floats, in the order D3DMATRIX lays them out. Read here
        // rather than passed as an address because everything past this point
        // works in numbers.
        /** @param {any} device @param {number[]} args */
        SetTransform: (device, [type, matrix])=>((matrix >>> 0) === 0
            ? D3DERR_INVALIDCALL
            : device.SetTransform(type >>> 0, readFloats(matrix, 16))),

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
            device.DrawPrimitiveUP(type >>> 0, primitiveCount >>> 0,
                readArray(vertices,
                    vertexCountOf(type >>> 0, primitiveCount >>> 0) * (stride >>> 0)),
                stride >>> 0),

        /** @param {any} device @param {number[]} args */
        DrawIndexedPrimitiveUP: (device,
            [type, minIndex, numVertices, count, indices, format, vertices, stride])=>
            device.DrawIndexedPrimitiveUP(type >>> 0, minIndex >>> 0, numVertices >>> 0,
                count >>> 0,
                readArray(indices,
                    vertexCountOf(type >>> 0, count >>> 0) * indexWidth(format)),
                format >>> 0,
                readArray(vertices, (numVertices >>> 0) * (stride >>> 0)),
                stride >>> 0),

        /** @param {any} device @param {number[]} args */
        SetRenderTarget: (device, [target, depth])=>
            device.SetRenderTarget(publisher.objectAt(target), publisher.objectAt(depth)),

        /** @param {any} device @param {number[]} args */
        GetRenderTarget: (device, [out])=>{
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = device.GetRenderTarget(held);
            if (hr === D3D_OK && held.surface && (out >>> 0) !== 0)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface8,
                    out >>> 0);
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
                    out >>> 0);
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

        // Nothing here scans a frame out, so there is no beam to be behind and
        // no blanking interval to be inside: both fields read as the start of a
        // frame, which is what DirectDraw's scan line reports for the same
        // reason. A program polling this to pace itself sees a display that
        // never moves, and one that reads it once sees a legal answer.
        /** @param {any} device @param {number[]} args */
        GetRasterStatus: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            fields.writeStruct(out >>> 0, D3DRASTER_STATUS, { InVBlank: 0, ScanLine: 0 });
            return D3D_OK;
        },

        // --- the desktop, none of which this build owns ---

        // Both gamma calls are declared void, so what they leave in EAX is not
        // read; the ramp is state a program reads back rather than a picture.
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

        // Nothing composites a bitmap over the presented frame, so a cursor set
        // here would never appear. Refusing is the only answer that says so: a
        // program told its cursor was accepted has no reason to draw one
        // itself, and a program told otherwise usually does.
        SetCursorProperties: ()=>D3DERR_INVALIDCALL,

        // Declared void, and there is no cursor to move.
        SetCursorPosition: ()=>0,

        // The previous visibility, which is always false because none is shown.
        ShowCursor: ()=>0,

        // One swap chain exists and it is the device's own. There is no second
        // one to publish -- not even an interface for it -- and NOTAVAILABLE is
        // what a device that cannot do something answers.
        /** @param {any} device @param {number[]} args */
        CreateAdditionalSwapChain: (device, [, out])=>clearAndRefuse(out),

        // The presented frame lives on the backend's device and is never read
        // back into guest memory, so there is nothing to copy into the caller's
        // surface. Answering with an untouched surface would hand a program
        // whatever that memory happened to hold and call it a screenshot.
        GetFrontBuffer: ()=>D3DERR_INVALIDCALL,

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
                    out >>> 0, D3DERR_OUTOFVIDEOMEMORY);
            }
            return hr;
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
                    out >>> 0, D3DERR_OUTOFVIDEOMEMORY);
            }
            return hr;
        },

        // A cube map and a volume texture are refused rather than made. The
        // renderer samples neither, and there is no vtable for either interface
        // here -- a texture handed back through a table transcribed from memory
        // would be worse than one that was never made, because the program
        // would call into it. The refusal is what sends a program to the
        // two-dimensional path it also has.
        /** @param {any} device @param {number[]} args */
        CreateCubeTexture: (device, [, , , , , out])=>clearAndRefuse(out),

        /** @param {any} device @param {number[]} args */
        CreateVolumeTexture: (device, [, , , , , , , out])=>clearAndRefuse(out),

        /** @param {any} device @param {number[]} args */
        CopyRects: (device, [source, rects, count, destination, points])=>{
            /** @type {{ moves?: any[] }} */
            const held = {};
            const hr = device.CopyRects(
                publisher.objectAt(source),
                readArrayOf(rects, count >>> 0, RECT), count >>> 0,
                publisher.objectAt(destination),
                readArrayOf(points, count >>> 0, POINT), held);
            if (hr === D3D_OK)
            {
                applyMoves(held.moves ?? []);
            }
            return hr;
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
        MultiplyTransform: (device, [type, matrix])=>((matrix >>> 0) === 0
            ? D3DERR_INVALIDCALL
            : device.MultiplyTransform(type >>> 0, readFloats(matrix, 16))),

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
            : device.SetLight(index >>> 0, readLight(pointer >>> 0))),

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
                    ? publisher.publish(held.texture, textureInterfaces, IID_IDirect3DTexture8)
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
            const hr = device.ApplyStateBlock(handle >>> 0);
            shadowOf(device)?.remirror();
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

        // No format here is palettised, so a palette could never reach a texel.
        // All four calls refuse for that one reason.
        SetPaletteEntries: ()=>D3DERR_INVALIDCALL,
        GetPaletteEntries: ()=>D3DERR_INVALIDCALL,
        SetCurrentTexturePalette: ()=>D3DERR_INVALIDCALL,
        GetCurrentTexturePalette: ()=>D3DERR_INVALIDCALL,

        // Transforming happens inside a draw, on the backend's device. There is
        // no path that transforms vertices and writes them back into a buffer
        // the program can read, and a call that answered success while leaving
        // the destination untouched would draw whatever that buffer held.
        ProcessVertices: ()=>D3DERR_INVALIDCALL,

        // CreateVertexShader and CreatePixelShader are absent on purpose, and
        // this is the one absence here that is a decision rather than a gap.
        // The renderer draws the fixed-function pipeline and counts a draw with
        // either shader bound as one it declined; a create that succeeded would
        // send a program down the programmable path, where every draw would be
        // silently dropped, and it would never look back. Refusing sends it
        // down the fixed-function path it also has, which draws.
        //
        // The declaration and function readers, and the shader constants, are
        // absent for the same reason: they are only reachable through a handle
        // that cannot exist.
        //
        // Setting is a different matter, because this one dword carries two
        // meanings: a vertex format goes through it, and that is how every
        // fixed-function draw declares its vertices.
        /** @param {any} device @param {number[]} args */
        SetVertexShader: (device, [handle])=>device.SetVertexShader(handle >>> 0),

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
        SetPixelShader: (device, [handle])=>device.SetPixelShader(handle >>> 0),

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

    // Every method of the device adopts what the guest set on its way in, so
    // a read, a draw or a present sees the state the program set last --
    // through the same setters a trap would have called, which is where
    // validation and invalidation live.
    /** @type {Record<string, (device: any, args: number[]) => number | Promise<number>>} */
    const syncedMethods = Object.fromEntries(Object.entries(deviceMethods)
        .map(([name, method])=>[name, (/** @type {any} */ device, /** @type {number[]} */ args)=>{
            shadowOf(device)?.sync();
            return method(device, args);
        }]));
    /** @type {Record<string, (builder: { trap: number }) => number>} */
    const deviceGuests = allocate
        ? {
            SetRenderState: ({ trap })=>placeCode(at=>setRenderStateCode(at, trap)),
            SetTransform: ({ trap })=>placeCode(at=>setTransformCode(at, trap)),
        }
        : {};
    const deviceInterfaces = [
        describe(IID_IDirect3DDevice8, IDIRECT3DDEVICE8_SLOTS, syncedMethods, deviceGuests),
    ];

    /** @param {number} address */
    const readPresentParameters = address=>{
        const raw = fields.readStruct(address, D3DPRESENT_PARAMETERS8);
        return {
            backBufferWidth: raw.BackBufferWidth,
            backBufferHeight: raw.BackBufferHeight,
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

    /** @param {number} address */
    const writeDisplayMode = address=>{
        const display = screen();
        fields.writeStruct(address, D3DDISPLAYMODE, {
            Width: display.width,
            Height: display.height,
            RefreshRate: 0,
            // D3DFMT_X8R8G8B8, which is what a 32-bit display reports.
            Format: 22,
        });
    };

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
     * The values describe what the renderer behind this actually does: fixed
     * function only, no shaders, two texture stages combined per pass, and
     * filtering and addressing a GPU of any generation has.
     *
     * @param {number} address @param {any} caps
     */
    const writeCaps = (address, caps)=>{
        // Zeroed first: the structure is long, a caller allocates all of it,
        // and every field this does not set has to read as "not supported"
        // rather than as whatever was on the stack. Two of those zeroes are
        // load-bearing -- the shader versions say this device runs neither,
        // which is the claim the shader entry points make good on.
        memory.writeMemory(address, new Uint8Array(D3DCAPS8.SIZE));
        fields.writeStruct(address, D3DCAPS8, {
            DeviceType: D3DDEVTYPE.HAL,
            // D3DCAPS_READ_SCANLINE is not claimed: there is no scanline.
            Caps2: D3DCAPS2_CANRENDERWINDOWED | D3DCAPS2_FULLSCREENGAMMA,
            PresentationIntervals: D3DPRESENT_INTERVAL_IMMEDIATE | D3DPRESENT_INTERVAL_ONE,
            DevCaps: D3DDEVCAPS_HWTRANSFORMANDLIGHT | D3DDEVCAPS_HWRASTERIZATION
                | D3DDEVCAPS_DRAWPRIMTLVERTEX | D3DDEVCAPS_DRAWPRIMITIVES2
                | D3DDEVCAPS_DRAWPRIMITIVES2EX | D3DDEVCAPS_EXECUTESYSTEMMEMORY
                | D3DDEVCAPS_TEXTUREVIDEOMEMORY | D3DDEVCAPS_TEXTURENONLOCALVIDMEM,
            PrimitiveMiscCaps: D3DPMISCCAPS_CULLNONE | D3DPMISCCAPS_CULLCW
                | D3DPMISCCAPS_CULLCCW | D3DPMISCCAPS_MASKZ
                | D3DPMISCCAPS_COLORWRITEENABLE | D3DPMISCCAPS_BLENDOP,
            RasterCaps: D3DPRASTERCAPS_DITHER | D3DPRASTERCAPS_ZTEST
                | D3DPRASTERCAPS_FOGVERTEX | D3DPRASTERCAPS_FOGTABLE
                | D3DPRASTERCAPS_MIPMAPLODBIAS | D3DPRASTERCAPS_ZBIAS
                | D3DPRASTERCAPS_ANISOTROPY | D3DPRASTERCAPS_ZFOG,
            // Every comparison a depth test can ask for; the backend maps them
            // one to one onto its own.
            ZCmpCaps: ALL_COMPARE_CAPS,
            SrcBlendCaps: ALL_BLEND_CAPS,
            DestBlendCaps: ALL_BLEND_CAPS,
            AlphaCmpCaps: ALL_COMPARE_CAPS,
            ShadeCaps: D3DPSHADECAPS_COLORGOURAUDRGB | D3DPSHADECAPS_SPECULARGOURAUDRGB
                | D3DPSHADECAPS_ALPHAGOURAUDBLEND | D3DPSHADECAPS_FOGGOURAUD,
            TextureCaps: D3DPTEXTURECAPS_PERSPECTIVE | D3DPTEXTURECAPS_ALPHA
                | D3DPTEXTURECAPS_PROJECTED | D3DPTEXTURECAPS_CUBEMAP
                | D3DPTEXTURECAPS_MIPMAP | D3DPTEXTURECAPS_MIPCUBEMAP
                | D3DPTEXTURECAPS_ALPHAPALETTE,
            TextureFilterCaps: ALL_FILTER_CAPS,
            CubeTextureFilterCaps: ALL_FILTER_CAPS,
            TextureAddressCaps: D3DPTADDRESSCAPS_WRAP | D3DPTADDRESSCAPS_MIRROR
                | D3DPTADDRESSCAPS_CLAMP | D3DPTADDRESSCAPS_BORDER
                | D3DPTADDRESSCAPS_INDEPENDENTUV | D3DPTADDRESSCAPS_MIRRORONCE,
            LineCaps: D3DLINECAPS_TEXTURE | D3DLINECAPS_ZTEST | D3DLINECAPS_BLEND
                | D3DLINECAPS_ALPHACMP | D3DLINECAPS_FOG,
            MaxTextureWidth: caps.maxTextureWidth ?? 4096,
            MaxTextureHeight: caps.maxTextureHeight ?? 4096,
            MaxVolumeExtent: caps.maxVolumeExtent ?? 256,
            MaxTextureRepeat: caps.maxTextureRepeat ?? 8192,
            MaxTextureAspectRatio: caps.maxTextureAspectRatio ?? 4096,
            MaxAnisotropy: caps.maxAnisotropy ?? 16,
            StencilCaps: ALL_STENCIL_CAPS,
            FVFCaps: D3DFVFCAPS_PSIZE | 8,
            TextureOpCaps: ALL_TEXTURE_OP_CAPS,
            MaxTextureBlendStages: caps.maxTextureBlendStages ?? 8,
            MaxSimultaneousTextures: caps.maxSimultaneousTextures ?? 8,
            VertexProcessingCaps: D3DVTXPCAPS_TEXGEN | D3DVTXPCAPS_MATERIALSOURCE7
                | D3DVTXPCAPS_DIRECTIONALLIGHTS | D3DVTXPCAPS_POSITIONALLIGHTS
                | D3DVTXPCAPS_LOCALVIEWER,
            MaxActiveLights: caps.maxActiveLights ?? 8,
            MaxUserClipPlanes: caps.maxUserClipPlanes ?? 6,
            MaxVertexBlendMatrices: caps.maxVertexBlendMatrices ?? 4,
            MaxVertexBlendMatrixIndex: caps.maxVertexBlendMatrixIndex ?? 0,
            MaxPrimitiveCount: caps.maxPrimitiveCount ?? 0xffff,
            MaxVertexIndex: caps.maxVertexIndex ?? 0xffff,
            MaxStreams: caps.maxStreams ?? 16,
            MaxStreamStride: caps.maxStreamStride ?? 256,
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
        }, ['MaxPointSize', 'MaxVertexW', 'GuardBandLeft', 'GuardBandTop',
            'GuardBandRight', 'GuardBandBottom', 'ExtentsAdjust']);
    };

    const rootMethods = {
        GetAdapterCount: ()=>1,

        /** @param {any} root @param {number[]} args */
        GetAdapterDisplayMode: (root, [, out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            writeDisplayMode(out >>> 0);
            return D3D_OK;
        },

        // One mode, and it is the one the display is already in. A longer list
        // would be a list of modes this build cannot set: there is one surface
        // and it is the size the assembling caller gave it.
        GetAdapterModeCount: ()=>1,

        /** @param {any} root @param {number[]} args */
        EnumAdapterModes: (root, [, mode, out])=>{
            if ((out >>> 0) === 0 || (mode >>> 0) !== 0)
            {
                return D3DERR_INVALIDCALL;
            }
            writeDisplayMode(out >>> 0);
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
            const wanted = readPresentParameters(parameters >>> 0);
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
                const shadow = createShadow({
                    allocate,
                    readMemory: memory.readMemory,
                    writeMemory: memory.writeMemory,
                    device: held.device,
                    divergence,
                });
                shadows.set(held.device, shadow);
                held.device.guestState = ()=>shadow.address();
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

    const rootInterfaces = [describe(IID_IDirect3D8, IDIRECT3D8_SLOTS, rootMethods)];

    /** @type {any} */
    let lastDevice = null;

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
