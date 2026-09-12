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
import {
    D3DDISPLAYMODE, D3DLIGHT7, D3DLOCKED_RECT, D3DPRESENT_PARAMETERS9, POINT, RECT, createFields,
} from './structs.js';
import {
    IDIRECT3DCUBETEXTURE9_SLOTS, IDIRECT3DDEVICE9_SLOTS, IDIRECT3DINDEXBUFFER9_SLOTS,
    IDIRECT3DQUERY9_SLOTS, IDIRECT3DSHADER9_SLOTS, IDIRECT3DSTATEBLOCK9_SLOTS,
    IDIRECT3DSURFACE9_SLOTS, IDIRECT3DSWAPCHAIN9_SLOTS, IDIRECT3DTEXTURE9_SLOTS,
    IDIRECT3DVERTEXBUFFER9_SLOTS, IDIRECT3DVERTEXDECLARATION9_SLOTS, IID_IDirect3D9,
    IID_IDirect3DCubeTexture9, IID_IDirect3DDevice9, IID_IDirect3DIndexBuffer9,
    IID_IDirect3DPixelShader9, IID_IDirect3DQuery9, IID_IDirect3DStateBlock9,
    IID_IDirect3DSurface9, IID_IDirect3DSwapChain9, IID_IDirect3DTexture9,
    IID_IDirect3DVertexBuffer9, IID_IDirect3DVertexDeclaration9, IID_IDirect3DVertexShader9,
} from '../d3d9/interfaces.js';
import {
    D3DADAPTER_IDENTIFIER9, D3DCAPS9, D3DCAPS9_FLOATS, D3DCLIPSTATUS9, D3DDECL_END_STREAM,
    D3DINDEXBUFFER_DESC9, D3DSURFACE_DESC9, D3DVERTEXBUFFER_DESC9, D3DVERTEXELEMENT9,
    D3DVIEWPORT9,
} from '../d3d9/structs.js';
import {
    ADAPTER_STRING_LENGTH, D3DDEVICE_CREATION_PARAMETERS, D3DGAMMARAMP, D3DRASTER_STATUS,
    GAMMA_RAMP_ENTRIES,
} from '../d3d8/structs.js';
import { D3DFMT_INDEX, D3DFMT, D3DRTYPE } from '../d3d8/constants.js';
import { expandTexels, vertexCountOf } from '../d3d8/render.js';
import { capabilityWords } from '../d3d9/caps.js';
import { D3DCREATE, D3DDEVTYPE } from '../d3d9/device.js';
import { MAX_DECLARATION_LENGTH } from '../d3d9/declaration.js';
import { END_TOKEN } from '../d3d9/shader.js';
import { REFRESH_HZ, displayModes } from '../../win32/user32/display.js';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c | 0;
const D3DERR_NOTAVAILABLE = 0x8876086a | 0;
const D3DERR_OUTOFVIDEOMEMORY = 0x8876017c | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
/** D3DENUM_NO_WHQL_LEVEL: skip the certification lookup, which took seconds on real Windows. */
const D3DENUM_NO_WHQL_LEVEL = 0x00000002;
/** D3DPRESENTFLAG_LOCKABLE_BACKBUFFER. */
const LOCKABLE_BACKBUFFER = 0x00000001;
/** D3DTEXF_LINEAR, what an automatic mip filter reads back as. */
const D3DTEXF_LINEAR = 2;

/**
 * The adapter formats a display mode is listed in: 32-bit and 16-bit.
 *
 * @type {ReadonlySet<number>}
 */
const ADAPTER_FORMATS = new Set([D3DFMT.X8R8G8B8, D3DFMT.R5G6B5]);

/**
 * WebGPU's word for a vendor against the PCI id a program's card database is
 * keyed by. Only vendors with a WebGPU spelling appear; anything else is
 * reported as zero, an unknown card.
 *
 * @type {Readonly<Record<string, number>>}
 */
const PCI_VENDOR_IDS = Object.freeze({
    nvidia: 0x10de,
    amd: 0x1002,
    intel: 0x8086,
    apple: 0x106b,
    qualcomm: 0x5143,
    arm: 0x13b5,
    microsoft: 0x1414,
});

/**
 * The identifier's GUID: one per adapter and driver on Windows, and one for
 * this engine here -- a program keeps it to recognise the same hardware next
 * run, and the same engine is the same hardware for that purpose.
 */
const ADAPTER_GUID = Uint8Array.from([
    0x7a, 0x1b, 0x6c, 0x0d, 0x3e, 0x9f, 0x40, 0x11,
    0x8a, 0x2b, 0x5c, 0x6d, 0x7e, 0x8f, 0x90, 0xa1,
]);

/** The most dwords a shader read from guest memory may run to before it is given up on. */
const MAX_SHADER_DWORDS = 1 << 16;

/**
 * @typedef {Object} AdapterIdentity
 * @property {string} [vendor]
 * @property {string} [architecture]
 * @property {string} [description]
 */

/**
 * @param {Object} deps
 * @param {any} deps.publisher   From createPublisher.
 * @param {any} deps.memory      readMemory/writeMemory.
 * @param {() => any} deps.screen  The display this build is configured for.
 * @param {(api: string, detail: string) => void} [deps.divergence]
 * @param {(cursor: import('./d3d8.js').CursorNotice) => void} [deps.cursor]
 *     Where the program's cursor goes; without a taker the call is refused.
 * @param {(width: number, height: number) => void} [deps.resolution]
 *     Told the resolution a device is created at, to report as the screen.
 * @param {() => AdapterIdentity | null} [deps.identity]
 */
export function createDirect3D9Seam(
    { publisher, memory, screen, divergence, cursor, resolution, identity },
)
{
    const fields = createFields(memory);

    /**
     * The device each resource was made by, for GetDevice. Weak, so this map
     * keeps nothing alive.
     *
     * @type {WeakMap<object, any>}
     */
    const owners = new WeakMap();

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
        }
        const pointer = publisher.publish(object, interfaces, id);
        fields.writeU32(out, pointer);
        return pointer === 0 ? failure : D3D_OK;
    };

    /**
     * A create this build cannot do: the caller's pointer is cleared as well
     * as the result reported, because a program tests the one as often as the
     * other.
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
     * What every resource interface answers in its first eight slots. Private
     * data is not kept, so those three slots stay E_NOTIMPL; priorities are
     * accepted and read back as zero, since nothing here manages residency.
     *
     * @param {number} type  D3DRTYPE, or a function of the object for a texture.
     */
    const resourceMethods = (/** @type {number | ((object: any) => number)} */ type)=>({
        GetDevice: getDevice,
        SetPriority: ()=>0,
        GetPriority: ()=>0,
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
        const floats = new Float32Array(count);
        new Uint8Array(floats.buffer).set(read(pointer >>> 0, count * 4));
        return floats;
    };

    /** @param {number} pointer @param {number} count @returns {Int32Array} */
    const readInts = (pointer, count)=>{
        const read = memory.windowMemory ?? memory.readMemory;
        const ints = new Int32Array(count);
        new Uint8Array(ints.buffer).set(read(pointer >>> 0, count * 4));
        return ints;
    };

    /** @param {number} pointer @param {number} count @returns {Uint32Array} */
    const readDwords = (pointer, count)=>{
        const read = memory.windowMemory ?? memory.readMemory;
        const dwords = new Uint32Array(count);
        new Uint8Array(dwords.buffer).set(read(pointer >>> 0, count * 4));
        return dwords;
    };

    /** @param {number} address @param {ArrayLike<number>} values */
    const writeDwords = (address, values)=>{
        const dwords = Uint32Array.from(values);
        memory.writeMemory(address >>> 0, new Uint8Array(dwords.buffer));
    };

    /** @param {number} address @param {ArrayLike<number>} values */
    const writeFloats = (address, values)=>{
        const floats = Float32Array.from(values);
        memory.writeMemory(address >>> 0, new Uint8Array(floats.buffer));
    };

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
        const colours = [material.Diffuse, material.Ambient, material.Specular,
            material.Emissive];
        writeFloats(address, [
            ...colours.flatMap(one=>[one.r, one.g, one.b, one.a]),
            material.Power,
        ]);
    };

    /** D3DLIGHT9 is D3DLIGHT7's layout under this version's names. */
    const readLight = (/** @type {number} */ pointer)=>{
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

    const surfaceInterfaces = [describe(IID_IDirect3DSurface9, IDIRECT3DSURFACE9_SLOTS, {
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
        // No device context is drawn through here: GDI reaches a surface
        // through DirectDraw, and a Direct3D 9 surface is not one.
        GetDC: ()=>D3DERR_INVALIDCALL,
        ReleaseDC: ()=>D3DERR_INVALIDCALL,
    })];

    /**
     * The six every texture kind shares, over the resource eight.
     *
     * @param {any} texture
     */
    const baseTextureMethods = {
        SetLOD: ()=>0,
        GetLOD: ()=>0,
        /** @param {any} texture */
        GetLevelCount: texture=>texture.levels ?? 1,
        SetAutoGenFilterType: ()=>D3D_OK,
        GetAutoGenFilterType: ()=>D3DTEXF_LINEAR,
        GenerateMipSubLevels: ()=>0,
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
        const hr = texture.GetSurfaceLevel(level, held);
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

    const textureInterfaces = [describe(IID_IDirect3DTexture9, IDIRECT3DTEXTURE9_SLOTS, {
        ...resourceMethods(D3DRTYPE.TEXTURE),
        ...baseTextureMethods,
        /** @param {any} texture @param {number[]} args */
        GetLevelDesc: (texture, [level, out])=>writeLevelDesc(texture, level >>> 0, out),
        /** @param {any} texture @param {number[]} args */
        GetSurfaceLevel: (texture, [level, out])=>{
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = texture.GetSurfaceLevel(level >>> 0, held);
            if (hr === D3D_OK && held.surface && (out >>> 0) !== 0)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface9,
                    out >>> 0, E_OUTOFMEMORY, owners.get(texture));
            }
            return hr;
        },
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
        // An unlock already marks the whole level for upload.
        AddDirtyRect: ()=>D3D_OK,
    })];

    const cubeTextureInterfaces = [
        describe(IID_IDirect3DCubeTexture9, IDIRECT3DCUBETEXTURE9_SLOTS, {
            ...resourceMethods(D3DRTYPE.CUBETEXTURE),
            ...baseTextureMethods,
        }),
    ];

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
        describe(IID_IDirect3DVertexBuffer9, IDIRECT3DVERTEXBUFFER9_SLOTS, {
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
        }),
    ];
    const indexBufferInterfaces = [
        describe(IID_IDirect3DIndexBuffer9, IDIRECT3DINDEXBUFFER9_SLOTS, {
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
        }),
    ];

    const declarationInterfaces = [
        describe(IID_IDirect3DVertexDeclaration9, IDIRECT3DVERTEXDECLARATION9_SLOTS, {
            GetDevice: getDevice,
            /**
             * The count pointer is required; the element pointer is optional
             * and, when given, must have room for the count already there.
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
                const hr = declaration.GetDeclaration(held,
                    (elements >>> 0) === 0 ? null : fields.readU32(count >>> 0));
                fields.writeU32(count >>> 0, held.count ?? 0);
                if (hr === D3D_OK && held.elements)
                {
                    writeElements(elements >>> 0, held.elements);
                }
                return hr;
            },
        }),
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
        describe(IID_IDirect3DVertexShader9, IDIRECT3DSHADER9_SLOTS, shaderMethods),
    ];
    const pixelShaderInterfaces = [
        describe(IID_IDirect3DPixelShader9, IDIRECT3DSHADER9_SLOTS, shaderMethods),
    ];

    const stateBlockInterfaces = [
        describe(IID_IDirect3DStateBlock9, IDIRECT3DSTATEBLOCK9_SLOTS, {
            GetDevice: getDevice,
            /** @param {any} block */
            Capture: block=>block.Capture(),
            /** @param {any} block */
            Apply: block=>block.Apply(),
        }),
    ];

    const queryInterfaces = [describe(IID_IDirect3DQuery9, IDIRECT3DQUERY9_SLOTS, {
        GetDevice: getDevice,
        /** @param {any} query */
        GetType: query=>query.GetType(),
        /** @param {any} query */
        GetDataSize: query=>query.GetDataSize(),
        /** @param {any} query @param {number[]} args */
        Issue: (query, [flags])=>query.Issue(flags >>> 0),
        /** @param {any} query @param {number[]} args */
        GetData: (query, [data, size])=>{
            /** @type {{ value?: number }} */
            const held = {};
            const hr = query.GetData((data >>> 0) === 0 ? null : held, size >>> 0);
            if (hr === D3D_OK && (data >>> 0) !== 0 && held.value !== undefined)
            {
                fields.writeU32(data >>> 0, held.value);
            }
            return hr;
        },
    })];

    /** @param {number} address */
    const writeDisplayMode = address=>{
        const display = screen();
        fields.writeStruct(address, D3DDISPLAYMODE, {
            Width: display.width,
            Height: display.height,
            RefreshRate: 0,
            Format: D3DFMT.X8R8G8B8,
        });
    };

    /** @param {number} address */
    const writeRasterStatus = address=>{
        // Nothing scans a frame out, so there is no beam to be behind and no
        // blanking interval to be inside: both read as the start of a frame.
        fields.writeStruct(address, D3DRASTER_STATUS, { InVBlank: 0, ScanLine: 0 });
    };

    const swapChainInterfaces = [describe(IID_IDirect3DSwapChain9, IDIRECT3DSWAPCHAIN9_SLOTS, {
        /** @param {any} chain */
        Present: chain=>chain.Present(),
        GetFrontBufferData: ()=>D3DERR_INVALIDCALL,
        /** @param {any} chain @param {number[]} args */
        GetBackBuffer: (chain, [index, type, out])=>{
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = chain.GetBackBuffer(index >>> 0, type >>> 0, held);
            if (hr === D3D_OK && held.surface && (out >>> 0) !== 0)
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
    })];

    /**
     * A create that ends in a shared-handle pointer, which the plain interface
     * requires to be null: sharing is the extended interface's.
     *
     * @param {number} shared
     */
    const sharedHandleRefused = shared=>(shared >>> 0) !== 0;

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
                fields.writeU32(out >>> 0,
                    publisher.publish(held.direct3D, rootInterfaces, IID_IDirect3D9));
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

        // One swap chain exists and it is the device's own.
        /** @param {any} device @param {number[]} args */
        CreateAdditionalSwapChain: (device, [, out])=>clearAndRefuse(out),

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
                return handBack(held.swapChain, swapChainInterfaces, IID_IDirect3DSwapChain9,
                    out >>> 0, E_OUTOFMEMORY, device);
            }
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
            const next = readPresentParameters(parameters >>> 0);
            const hr = device.Reset(next);
            if (hr === D3D_OK)
            {
                writePresentParameters(parameters >>> 0, next);
                resolution?.(next.backBufferWidth >>> 0, next.backBufferHeight >>> 0);
            }
            return hr;
        },

        // Present's four arguments are all optional and all ignored: there
        // are no rectangles to honour, and the window is the browser's.
        /** @param {any} device */
        Present: (/** @type {any} */ device)=>device.Present(),

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

        // Both gamma calls are declared void; the ramp is state a program
        // reads back rather than a picture.
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
            if (sharedHandleRefused(shared) || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ texture?: any }} */
            const held = {};
            const hr = device.CreateTexture(
                width >>> 0, height >>> 0, levels >>> 0, usage >>> 0,
                format >>> 0, pool >>> 0, held);
            if (hr === D3D_OK && held.texture)
            {
                return handBack(held.texture, textureInterfaces, IID_IDirect3DTexture9,
                    out >>> 0, D3DERR_OUTOFVIDEOMEMORY, device);
            }
            return hr;
        },

        // A volume texture is refused rather than made: the renderer samples
        // none, and there is no interface for one here. A cube texture is
        // refused for the same reason -- the capability block claims no cube
        // maps, and a program that read it never asks.
        /** @param {any} device @param {number[]} args */
        CreateVolumeTexture: (device, [, , , , , , , out])=>clearAndRefuse(out),
        /** @param {any} device @param {number[]} args */
        CreateCubeTexture: (device, [, , , , , out])=>clearAndRefuse(out),

        /** @param {any} device @param {number[]} args */
        CreateVertexBuffer: (device, [length, usage, fvf, pool, out, shared])=>{
            if (sharedHandleRefused(shared) || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ buffer?: any }} */
            const held = {};
            const hr = device.CreateVertexBuffer(
                length >>> 0, usage >>> 0, fvf >>> 0, pool >>> 0, held);
            if (hr === D3D_OK && held.buffer)
            {
                return handBack(held.buffer, vertexBufferInterfaces,
                    IID_IDirect3DVertexBuffer9, out >>> 0, D3DERR_OUTOFVIDEOMEMORY, device);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        CreateIndexBuffer: (device, [length, usage, format, pool, out, shared])=>{
            if (sharedHandleRefused(shared) || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ buffer?: any }} */
            const held = {};
            const hr = device.CreateIndexBuffer(
                length >>> 0, usage >>> 0, format >>> 0, pool >>> 0, held);
            if (hr === D3D_OK && held.buffer)
            {
                return handBack(held.buffer, indexBufferInterfaces,
                    IID_IDirect3DIndexBuffer9, out >>> 0, D3DERR_OUTOFVIDEOMEMORY, device);
            }
            return hr;
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
            return hr;
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
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        CreateOffscreenPlainSurface: (device, [width, height, format, pool, out, shared])=>{
            if (sharedHandleRefused(shared) || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = device.CreateOffscreenPlainSurface(
                width >>> 0, height >>> 0, format >>> 0, pool >>> 0, held);
            if (hr === D3D_OK && held.surface)
            {
                return handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface9,
                    out >>> 0, E_OUTOFMEMORY, device);
            }
            return hr;
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
        GetFrontBufferData: (/** @type {any} */ device)=>device.GetFrontBufferData(),

        /** @param {any} device @param {number[]} args */
        StretchRect: (device, [source, sourceRect, destination, destinationRect, filter])=>
            device.StretchRect(publisher.objectAt(source), readRect(sourceRect),
                publisher.objectAt(destination), readRect(destinationRect), filter >>> 0),

        /** @param {any} device @param {number[]} args */
        ColorFill: (device, [surface, rect, colour])=>device.ColorFill(
            publisher.objectAt(surface), readRect(rect), colour >>> 0),

        // --- targets ---

        /** @param {any} device @param {number[]} args */
        SetRenderTarget: (device, [index, surface])=>
            device.SetRenderTarget(index >>> 0, publisher.objectAt(surface)),

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
        SetTransform: (device, [type, matrix])=>((matrix >>> 0) === 0
            ? D3DERR_INVALIDCALL
            : device.SetTransform(type >>> 0, readFloats(matrix, 16))),

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
        SetViewport: (device, [pointer])=>((pointer >>> 0) === 0
            ? D3DERR_INVALIDCALL
            : device.SetViewport(
                fields.readStruct(pointer >>> 0, D3DVIEWPORT9, ['MinZ', 'MaxZ']))),

        /** @param {any} device @param {number[]} args */
        GetViewport: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ viewport?: any }} */
            const held = {};
            const hr = device.GetViewport(held);
            if (hr === D3D_OK && held.viewport)
            {
                fields.writeStruct(out >>> 0, D3DVIEWPORT9, held.viewport, ['MinZ', 'MaxZ']);
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
                return handBack(held.block, stateBlockInterfaces, IID_IDirect3DStateBlock9,
                    out >>> 0, E_OUTOFMEMORY, device);
            }
            return hr;
        },
        /** @param {any} device */
        BeginStateBlock: (/** @type {any} */ device)=>device.BeginStateBlock(),
        /** @param {any} device @param {number[]} args */
        EndStateBlock: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ block?: any }} */
            const held = {};
            const hr = device.EndStateBlock(held);
            if (hr === D3D_OK && held.block)
            {
                return handBack(held.block, stateBlockInterfaces, IID_IDirect3DStateBlock9,
                    out >>> 0, E_OUTOFMEMORY, device);
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
                        held.texture.cube ? IID_IDirect3DCubeTexture9 : IID_IDirect3DTexture9)
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
        SetTextureStageState: (device, [stage, type, value])=>
            device.SetTextureStageState(stage >>> 0, type >>> 0, value >>> 0),

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
        SetSamplerState: (device, [sampler, type, value])=>
            device.SetSamplerState(sampler >>> 0, type >>> 0, value >>> 0),

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

        // No format here is palettised, so a palette could never reach a texel.
        SetPaletteEntries: ()=>D3DERR_INVALIDCALL,
        GetPaletteEntries: ()=>D3DERR_INVALIDCALL,
        SetCurrentTexturePalette: ()=>D3DERR_INVALIDCALL,
        GetCurrentTexturePalette: ()=>D3DERR_INVALIDCALL,

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
            device.DrawIndexedPrimitiveUP(type >>> 0, minIndex >>> 0, numVertices >>> 0,
                count >>> 0,
                readArray(indices,
                    vertexCountOf(type >>> 0, count >>> 0) * indexWidth(format)),
                format >>> 0,
                readArray(vertices, (numVertices >>> 0) * (stride >>> 0)),
                stride >>> 0),

        /** @param {any} device */
        ProcessVertices: (/** @type {any} */ device)=>device.ProcessVertices(),

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
                return handBack(held.query, queryInterfaces, IID_IDirect3DQuery9, out >>> 0,
                    E_OUTOFMEMORY, device);
            }
            return hr;
        },
    };

    /** @param {any} texture */
    const textureInterfacesFor = texture=>(texture.cube
        ? cubeTextureInterfaces
        : textureInterfaces);

    const deviceInterfaces = [
        describe(IID_IDirect3DDevice9, IDIRECT3DDEVICE9_SLOTS, deviceMethods),
    ];

    /** @param {number} address */
    const readPresentParameters = address=>{
        const raw = fields.readStruct(address, D3DPRESENT_PARAMETERS9);
        const display = screen();
        // A zero size windowed means the window's client area, which this
        // seam does not know; the display is the nearest thing it does.
        const windowed = raw.Windowed !== 0;
        return {
            backBufferWidth: raw.BackBufferWidth || (windowed ? display.width : 0),
            backBufferHeight: raw.BackBufferHeight || (windowed ? display.height : 0),
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
     * hardware. The vendor is the one number a program acts on -- its card
     * database is keyed by PCI vendor id -- so WebGPU's word for the vendor is
     * turned into that id, and a vendor not in the table is reported as zero.
     *
     * @param {number} address @param {number} flags D3DENUM_*
     */
    const writeAdapterIdentifier = (address, flags)=>{
        const known = identity?.() ?? null;
        const vendor = (known?.vendor ?? '').toLowerCase();
        const description = known?.description
            || [known?.vendor, known?.architecture].filter(Boolean).join(' ')
            || 'WebGPU adapter';
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
        view.setUint32(D3DADAPTER_IDENTIFIER9.VendorId, PCI_VENDOR_IDS[vendor] ?? 0, true);
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
                RefreshRate: REFRESH_HZ,
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

        // No monitor handle exists on this side; a null one is what a program
        // checks for and falls back from.
        GetAdapterMonitor: ()=>0,

        /**
         * The device, made the way a program makes one. The adapter must be
         * the one there is, the type one this version names, and the
         * behaviour must name exactly one kind of vertex processing.
         *
         * @param {any} root @param {number[]} args
         */
        CreateDevice: (root, [adapter, deviceType, focus, behaviourFlags, parameters, out])=>{
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
            const wanted = readPresentParameters(parameters >>> 0);
            /** @type {{ device?: any }} */
            const held = {};
            const hr = root.CreateDevice(wanted, held, behaviourFlags >>> 0, {
                AdapterOrdinal: adapter >>> 0,
                DeviceType: deviceType >>> 0,
                hFocusWindow: focus >>> 0,
            });
            if (hr !== D3D_OK || !held.device)
            {
                fields.writeU32(out >>> 0, 0);
                return hr;
            }
            writePresentParameters(parameters >>> 0, wanted);
            resolution?.(wanted.backBufferWidth >>> 0, wanted.backBufferHeight >>> 0);
            const result = handBack(held.device, deviceInterfaces, IID_IDirect3DDevice9,
                out >>> 0, D3DERR_OUTOFVIDEOMEMORY);
            if (result === D3D_OK)
            {
                lastDevice = held.device;
            }
            return result;
        },
    };

    /**
     * What the device holds as its cursor, as the taker wants it.
     *
     * @param {any} device
     */
    const tellCursor = device=>{
        const held = device.GetCursor();
        if (!cursor || !held.surface)
        {
            return;
        }
        /** @type {{ desc?: any }} */
        const out = {};
        held.surface.GetDesc(out);
        const { Width: width, Height: height, Format: format } = out.desc;
        const bytes = memory.readMemory(held.surface.base, width * height * 4);
        cursor({
            width, height,
            hotSpot: { ...held.hotSpot },
            bgra: expandTexels(format, bytes, width * height),
            shown: held.shown,
        });
    };

    const rootInterfaces = [describe(IID_IDirect3D9, IDIRECT3D9_SLOTS, rootMethods)];

    /** @type {any} */
    let lastDevice = null;

    return {
        /**
         * Publishes the object Direct3DCreate9 hands back.
         *
         * @param {any} root  What graphics.create('d3d9') returned.
         */
        publishRoot: (/** @type {any} */ root)=>publisher.publish(root, rootInterfaces, IID_IDirect3D9),

        /** What the device this program is drawing through has counted. */
        diagnostics: ()=>lastDevice?.diagnostics?.() ?? null,

        /** For tests, which have no guest to call through. */
        interfaces: {
            root: rootInterfaces, device: deviceInterfaces, surface: surfaceInterfaces,
            texture: textureInterfaces, vertexBuffer: vertexBufferInterfaces,
            indexBuffer: indexBufferInterfaces, declaration: declarationInterfaces,
            vertexShader: vertexShaderInterfaces, pixelShader: pixelShaderInterfaces,
            stateBlock: stateBlockInterfaces, query: queryInterfaces,
            swapChain: swapChainInterfaces,
        },
    };
}
