/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 7, between a guest call and the object that implements it.
 *
 * There is no entry point for Direct3D 7: a program reaches IDirect3D7 by
 * asking its DirectDraw object for it, and the object it gets is the same one
 * under another table. So this seam does not publish a root; it hands the
 * DirectDraw seam the descriptor to put beside its own, and keeps one D3D7
 * object per DirectDraw object to answer through it.
 *
 * As everywhere in `seam/`, this is translation: pointers become structures,
 * interface pointers become objects, out-parameters are written when the
 * call succeeded. Three things are D3D7's own here: a draw takes its vertex
 * format as an argument and its indices as sixteen-bit words by pointer; the
 * device description is written into a structure with no size field of its
 * own; and the enumerations call back into guest code, which makes them
 * promises the bridge suspends on.
 */

import { describe, IDIRECT3D7_SLOTS, IDIRECT3DDEVICE7_SLOTS, IDIRECT3DVERTEXBUFFER7_SLOTS }
    from './vtables.js';
import {
    IID_IDirect3D7, IID_IDirect3DDevice7, IID_IDirect3DVertexBuffer7, IID_IDirectDrawSurface7,
} from './iids.js';
import {
    D3DCLIPSTATUS, D3DDEVICEDESC7, D3DLIGHT7, D3DPRIMCAPS, D3DRECT, D3DVERTEXBUFFERDESC,
    D3DVIEWPORT7, createFields,
} from './structs.js';
import { readGuid } from './ddraw.js';
import { writePixelFormat } from '../ddraw/structs.js';
import { depthFormatForDepth, pixelFormatForDepth } from '../ddraw/objects.js';
import { DDERR_INVALIDPARAMS, D3D_OK } from '../d3d7/constants.js';
import { createDirect3D7 } from '../d3d7/device.js';
import { decodeFvf } from '../webgpu/internal/vertexformat.js';

/** What an enumeration callback answers to stop. */
const DDENUMRET_CANCEL = 0;

/** The texture formats EnumTextureFormats names: the ones the renderer uploads. */
const TEXTURE_DEPTHS = Object.freeze([32, 16]);

/**
 * A GUID as its sixteen bytes, the way a program reads one out of a structure:
 * three little-endian integers and eight raw bytes.
 *
 * @param {string} guid
 * @returns {Uint8Array}
 */
export function guidBytes(guid){
    const hex = guid.replace(/[{}-]/g, '');
    const word = (/** @type {number} */ from, /** @type {number} */ width)=>
        parseInt(hex.slice(from, from + width), 16);
    const out = new Uint8Array(16);
    const data1 = word(0, 8);
    out[0] = data1 & 0xff;
    out[1] = (data1 >>> 8) & 0xff;
    out[2] = (data1 >>> 16) & 0xff;
    out[3] = data1 >>> 24;
    out[4] = word(8, 4) & 0xff;
    out[5] = word(8, 4) >>> 8;
    out[6] = word(12, 4) & 0xff;
    out[7] = word(12, 4) >>> 8;
    for (let index = 0; index < 8; index++)
    {
        out[8 + index] = word(16 + index * 2, 2);
    }
    return out;
}

/**
 * @typedef {Object} Direct3D7Deps
 * @property {any} publisher
 * @property {any} memory
 * @property {import('../d3d7/device.js').RenderServices
 *            | (() => import('../d3d7/device.js').RenderServices)} [render]
 *           The backend and its company, for a device that draws. A function
 *           is called when the first D3D7 object is made, so that a build
 *           that never reaches Direct3D never builds a GPU.
 * @property {(call: { entry: number, args: number[] }) => Promise<number>} [callGuest]
 * @property {{ allocate: (bytes: number) => number }} [scratch]
 */

/**
 * @param {Direct3D7Deps} deps
 */
export function createDirect3D7Seam({ publisher, memory, render, callGuest, scratch }){
    const fields = createFields(memory);

    /** One D3D7 object per DirectDraw object, made when first asked for. */
    /** @type {WeakMap<object, any>} */
    const objects = new WeakMap();
    /** @param {any} root */
    const d3dFor = root=>{
        const existing = objects.get(root);
        if (existing)
        {
            return existing;
        }
        const made = createDirect3D7(root, typeof render === 'function' ? render() : render ?? {});
        objects.set(root, made);
        return made;
    };

    /** Guest memory for what a callback is shown, taken once. */
    let block = 0;
    const scratchBlock = ()=>{
        if (block === 0 && scratch)
        {
            // Two strings, a description and a pixel format share the block;
            // nothing outlives the callback it was written for.
            block = scratch.allocate(0x200);
        }
        return block;
    };
    const canEnumerate = ()=>callGuest !== undefined && scratchBlock() !== 0;

    /** @param {number} pointer @param {number} count @returns {Float32Array} */
    const readFloats = (pointer, count)=>new Float32Array(
        memory.readMemory(pointer >>> 0, count * 4).slice().buffer);

    /** @param {number} pointer @returns {import('../d3d7/device.js').Material} */
    const readMaterial = pointer=>{
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

    /** @param {number} pointer @param {import('../d3d7/device.js').Material} material */
    const writeMaterial = (pointer, material)=>{
        const values = [
            material.Diffuse, material.Ambient, material.Specular, material.Emissive,
        ].flatMap(colour=>[colour.r, colour.g, colour.b, colour.a]);
        values.push(material.Power);
        values.forEach((value, index)=>fields.writeF32((pointer >>> 0) + index * 4, value));
    };

    /** @param {number} pointer @returns {import('../d3d7/device.js').Light} */
    const readLight = pointer=>{
        const at = pointer >>> 0;
        const colour = (/** @type {number} */ offset)=>{
            const f = readFloats(at + offset, 4);
            return { r: f[0], g: f[1], b: f[2], a: f[3] };
        };
        const vector = (/** @type {number} */ offset)=>{
            const f = readFloats(at + offset, 3);
            return { x: f[0], y: f[1], z: f[2] };
        };
        return {
            Type: fields.readU32(at + D3DLIGHT7.dltType),
            Diffuse: colour(D3DLIGHT7.dcvDiffuse),
            Specular: colour(D3DLIGHT7.dcvSpecular),
            Ambient: colour(D3DLIGHT7.dcvAmbient),
            Position: vector(D3DLIGHT7.dvPosition),
            Direction: vector(D3DLIGHT7.dvDirection),
            Range: fields.readF32(at + D3DLIGHT7.dvRange),
            Falloff: fields.readF32(at + D3DLIGHT7.dvFalloff),
            Attenuation0: fields.readF32(at + D3DLIGHT7.dvAttenuation0),
            Attenuation1: fields.readF32(at + D3DLIGHT7.dvAttenuation1),
            Attenuation2: fields.readF32(at + D3DLIGHT7.dvAttenuation2),
            Theta: fields.readF32(at + D3DLIGHT7.dvTheta),
            Phi: fields.readF32(at + D3DLIGHT7.dvPhi),
        };
    };

    /** @param {number} pointer @param {import('../d3d7/device.js').Light} light */
    const writeLight = (pointer, light)=>{
        const at = pointer >>> 0;
        fields.writeU32(at + D3DLIGHT7.dltType, light.Type);
        const colour = (/** @type {number} */ offset, /** @type {any} */ c)=>{
            [c.r, c.g, c.b, c.a].forEach((value, index)=>fields.writeF32(at + offset + index * 4,
                value));
        };
        const vector = (/** @type {number} */ offset, /** @type {any} */ v)=>{
            [v.x, v.y, v.z].forEach((value, index)=>
                fields.writeF32(at + offset + index * 4, value));
        };
        colour(D3DLIGHT7.dcvDiffuse, light.Diffuse);
        colour(D3DLIGHT7.dcvSpecular, light.Specular);
        colour(D3DLIGHT7.dcvAmbient, light.Ambient);
        vector(D3DLIGHT7.dvPosition, light.Position);
        vector(D3DLIGHT7.dvDirection, light.Direction);
        fields.writeF32(at + D3DLIGHT7.dvRange, light.Range);
        fields.writeF32(at + D3DLIGHT7.dvFalloff, light.Falloff);
        fields.writeF32(at + D3DLIGHT7.dvAttenuation0, light.Attenuation0);
        fields.writeF32(at + D3DLIGHT7.dvAttenuation1, light.Attenuation1);
        fields.writeF32(at + D3DLIGHT7.dvAttenuation2, light.Attenuation2);
        fields.writeF32(at + D3DLIGHT7.dvTheta, light.Theta);
        fields.writeF32(at + D3DLIGHT7.dvPhi, light.Phi);
    };

    /**
     * Bytes a draw reads straight out of the program's own arrays; null when
     * there is nothing to read, which the device refuses.
     *
     * @param {number} pointer @param {number} length @returns {Uint8Array | null}
     */
    const readArray = (pointer, length)=>((pointer >>> 0) === 0 || !(length > 0)
        ? null
        : memory.readMemory(pointer >>> 0, length));

    /** @param {number} fvf @returns {number} the stride of a format, or zero for a bad one */
    const strideOf = fvf=>{
        try
        {
            return decodeFvf(fvf >>> 0).stride;
        }
        catch (e){
            void e;
            return 0;
        }
    };

    /**
     * @param {number} pointer
     * @param {import('../d3d7/caps.js').DeviceCaps} caps
     */
    const writeDeviceDescription = (pointer, caps)=>{
        const at = pointer >>> 0;
        memory.writeMemory(at, new Uint8Array(D3DDEVICEDESC7.SIZE));
        const primitive = (/** @type {number} */ offset, /** @type {any} */ p)=>{
            fields.writeStruct(at + offset, D3DPRIMCAPS, {
                dwSize: D3DPRIMCAPS.SIZE,
                dwMiscCaps: p.miscCaps,
                dwRasterCaps: p.rasterCaps,
                dwZCmpCaps: p.zCmpCaps,
                dwSrcBlendCaps: p.srcBlendCaps,
                dwDestBlendCaps: p.destBlendCaps,
                dwAlphaCmpCaps: p.alphaCmpCaps,
                dwShadeCaps: p.shadeCaps,
                dwTextureCaps: p.textureCaps,
                dwTextureFilterCaps: p.textureFilterCaps,
                dwTextureBlendCaps: p.textureBlendCaps,
                dwTextureAddressCaps: p.textureAddressCaps,
                dwStippleWidth: p.stippleWidth,
                dwStippleHeight: p.stippleHeight,
            });
        };
        primitive(D3DDEVICEDESC7.dpcLineCaps, caps.lineCaps);
        primitive(D3DDEVICEDESC7.dpcTriCaps, caps.triCaps);
        fields.writeStruct(at, D3DDEVICEDESC7, {
            dwDevCaps: caps.devCaps,
            dwDeviceRenderBitDepth: caps.deviceRenderBitDepth,
            dwDeviceZBufferBitDepth: caps.deviceZBufferBitDepth,
            dwMinTextureWidth: caps.minTextureWidth,
            dwMinTextureHeight: caps.minTextureHeight,
            dwMaxTextureWidth: caps.maxTextureWidth,
            dwMaxTextureHeight: caps.maxTextureHeight,
            dwMaxTextureRepeat: caps.maxTextureRepeat,
            dwMaxTextureAspectRatio: caps.maxTextureAspectRatio,
            dwMaxAnisotropy: caps.maxAnisotropy,
            dvGuardBandLeft: caps.guardBandLeft,
            dvGuardBandTop: caps.guardBandTop,
            dvGuardBandRight: caps.guardBandRight,
            dvGuardBandBottom: caps.guardBandBottom,
            dvExtentsAdjust: caps.extentsAdjust,
            dwStencilCaps: caps.stencilCaps,
            dwFVFCaps: caps.fvfCaps,
            dwTextureOpCaps: caps.textureOpCaps,
            dwMaxActiveLights: caps.maxActiveLights,
            dvMaxVertexW: caps.maxVertexW,
            dwVertexProcessingCaps: caps.vertexProcessingCaps,
        }, ['dvGuardBandLeft', 'dvGuardBandTop', 'dvGuardBandRight', 'dvGuardBandBottom',
            'dvExtentsAdjust', 'dvMaxVertexW']);
        // The two WORD pairs share a dword each, low word first.
        fields.writeU32(at + D3DDEVICEDESC7.wMaxTextureBlendStages,
            (caps.maxTextureBlendStages & 0xffff) | (caps.maxSimultaneousTextures << 16));
        fields.writeU32(at + D3DDEVICEDESC7.wMaxUserClipPlanes,
            (caps.maxUserClipPlanes & 0xffff) | (caps.maxVertexBlendMatrices << 16));
        memory.writeMemory(at + D3DDEVICEDESC7.deviceGUID, guidBytes(caps.deviceGuid));
    };

    /** @param {number} pointer @param {string} text NUL-terminated ANSI, as a name travels */
    const writeString = (pointer, text)=>{
        const bytes = new Uint8Array(text.length + 1);
        for (let index = 0; index < text.length; index++)
        {
            bytes[index] = text.charCodeAt(index) & 0x7f;
        }
        memory.writeMemory(pointer, bytes);
    };

    // --- vertex buffer ---

    const bufferInterfaces = [describe(IID_IDirect3DVertexBuffer7, IDIRECT3DVERTEXBUFFER7_SLOTS, {
        /** @param {any} buffer @param {number[]} args */
        Lock: (buffer, [flags, out, sizeOut])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ data?: number, size?: number }} */
            const locked = {};
            const hr = buffer.Lock(flags >>> 0, locked);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0, locked.data ?? 0);
                if ((sizeOut >>> 0) !== 0)
                {
                    fields.writeU32(sizeOut >>> 0, locked.size ?? 0);
                }
            }
            return hr;
        },
        /** @param {any} buffer */
        Unlock: (/** @type {any} */ buffer)=>buffer.Unlock(),
        /** @param {any} buffer @param {number[]} args */
        GetVertexBufferDesc: (buffer, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ desc?: any }} */
            const held = {};
            buffer.GetVertexBufferDesc(held);
            fields.writeStruct(out >>> 0, D3DVERTEXBUFFERDESC, {
                dwSize: D3DVERTEXBUFFERDESC.SIZE,
                dwCaps: held.desc.caps,
                dwFVF: held.desc.fvf,
                dwNumVertices: held.desc.numVertices,
            });
            return D3D_OK;
        },
        /** @param {any} buffer */
        Optimize: (/** @type {any} */ buffer)=>buffer.Optimize(),
    })];

    // --- device ---

    const deviceMethods = {
        /** @param {any} device @param {number[]} args */
        GetCaps: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ caps?: any }} */
            const held = {};
            device.GetCaps(held);
            writeDeviceDescription(out, held.caps);
            return D3D_OK;
        },

        /**
         * The formats a texture may have, one callback each. A program that
         * cannot be called back is told there are none, which it handles as
         * a device with no textures would be handled.
         *
         * @param {any} device @param {number[]} args
         */
        EnumTextureFormats: (device, [callback, context])=>{
            if ((callback >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            if (!canEnumerate())
            {
                return D3D_OK;
            }
            const call = /** @type {NonNullable<typeof callGuest>} */ (callGuest);
            return (async()=>{
                for (const depth of TEXTURE_DEPTHS)
                {
                    const format = /** @type {any} */ (pixelFormatForDepth(depth));
                    const at = scratchBlock();
                    writePixelFormat(memory, at, format);
                    const answer = await call({ entry: callback >>> 0, args: [at, context >>> 0] });
                    if ((answer >>> 0) === DDENUMRET_CANCEL)
                    {
                        break;
                    }
                }
                return D3D_OK;
            })();
        },

        /** @param {any} device */
        BeginScene: (/** @type {any} */ device)=>device.BeginScene(),
        /** @param {any} device */
        EndScene: (/** @type {any} */ device)=>device.EndScene(),

        /** @param {any} device @param {number[]} args */
        GetDirect3D: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            // IDirect3D7 shares IDirectDraw7's count, and the object it is
            // published on is the one CreateDevice was called through.
            const root = device.ddraw;
            root.addRef(IID_IDirect3D7);
            fields.writeU32(out >>> 0, publisher.publish(root, [], IID_IDirect3D7));
            return D3D_OK;
        },

        /** @param {any} device @param {number[]} args */
        SetRenderTarget: (device, [surface])=>device.SetRenderTarget(publisher.objectAt(surface)),

        /** @param {any} device @param {number[]} args */
        GetRenderTarget: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ surface?: any }} */
            const held = {};
            device.GetRenderTarget(held);
            fields.writeU32(out >>> 0,
                publisher.publish(held.surface, [], IID_IDirectDrawSurface7));
            return D3D_OK;
        },

        // Z arrives as a float in a slot read as a dword; the bytes are the
        // caller's, only the interpretation differs.
        /** @param {any} device @param {number[]} args */
        Clear: (device, [count, rects, flags, colour, z, stencil])=>device.Clear(
            count >>> 0,
            (rects >>> 0) === 0
                ? null
                : Array.from({ length: count >>> 0 }, (_, index)=>
                    fields.readStruct((rects >>> 0) + index * D3DRECT.SIZE, D3DRECT)),
            flags >>> 0, colour >>> 0, fields.asFloat(z), stencil >>> 0),

        /** @param {any} device @param {number[]} args */
        SetTransform: (device, [type, matrix])=>((matrix >>> 0) === 0
            ? DDERR_INVALIDPARAMS
            : device.SetTransform(type >>> 0, readFloats(matrix, 16))),

        /** @param {any} device @param {number[]} args */
        GetTransform: (device, [type, out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ matrix?: Float32Array }} */
            const held = {};
            const hr = device.GetTransform(type >>> 0, held);
            if (hr === D3D_OK && held.matrix)
            {
                held.matrix.forEach((value, index)=>
                    fields.writeF32((out >>> 0) + index * 4, value));
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        MultiplyTransform: (device, [type, matrix])=>((matrix >>> 0) === 0
            ? DDERR_INVALIDPARAMS
            : device.MultiplyTransform(type >>> 0, readFloats(matrix, 16))),

        /** @param {any} device @param {number[]} args */
        SetViewport: (device, [pointer])=>{
            if ((pointer >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const raw = fields.readStruct(pointer >>> 0, D3DVIEWPORT7, ['dvMinZ', 'dvMaxZ']);
            return device.SetViewport({
                X: raw.dwX, Y: raw.dwY, Width: raw.dwWidth, Height: raw.dwHeight,
                MinZ: raw.dvMinZ, MaxZ: raw.dvMaxZ,
            });
        },

        /** @param {any} device @param {number[]} args */
        GetViewport: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ viewport?: any }} */
            const held = {};
            device.GetViewport(held);
            const v = held.viewport;
            fields.writeStruct(out >>> 0, D3DVIEWPORT7, {
                dwX: v.X, dwY: v.Y, dwWidth: v.Width, dwHeight: v.Height,
                dvMinZ: v.MinZ, dvMaxZ: v.MaxZ,
            }, ['dvMinZ', 'dvMaxZ']);
            return D3D_OK;
        },

        /** @param {any} device @param {number[]} args */
        SetMaterial: (device, [pointer])=>((pointer >>> 0) === 0
            ? DDERR_INVALIDPARAMS
            : device.SetMaterial(readMaterial(pointer))),

        /** @param {any} device @param {number[]} args */
        GetMaterial: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ material?: any }} */
            const held = {};
            device.GetMaterial(held);
            writeMaterial(out, held.material);
            return D3D_OK;
        },

        /** @param {any} device @param {number[]} args */
        SetLight: (device, [index, pointer])=>((pointer >>> 0) === 0
            ? DDERR_INVALIDPARAMS
            : device.SetLight(index >>> 0, readLight(pointer))),

        /** @param {any} device @param {number[]} args */
        GetLight: (device, [index, out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ light?: any }} */
            const held = {};
            const hr = device.GetLight(index >>> 0, held);
            if (hr === D3D_OK && held.light)
            {
                writeLight(out, held.light);
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

        /** @param {any} device */
        BeginStateBlock: (/** @type {any} */ device)=>device.BeginStateBlock(),

        /** @param {any} device @param {number[]} args */
        EndStateBlock: (device, [out])=>{
            /** @type {{ handle?: number }} */
            const held = {};
            const hr = device.EndStateBlock(held);
            if (hr === D3D_OK && (out >>> 0) !== 0)
            {
                fields.writeU32(out >>> 0, held.handle ?? 0);
            }
            return hr;
        },

        PreLoad: ()=>D3D_OK,

        /**
         * Vertices by pointer: the count of vertices, times the stride the
         * format implies, is how far to read.
         *
         * @param {any} device @param {number[]} args
         */
        DrawPrimitive: (device, [type, fvf, vertices, count])=>device.DrawPrimitive(
            type >>> 0, fvf >>> 0,
            readArray(vertices, (count >>> 0) * strideOf(fvf)), count >>> 0),

        /** @param {any} device @param {number[]} args */
        DrawIndexedPrimitive: (device, [type, fvf, vertices, count, indices, indexCount])=>
            device.DrawIndexedPrimitive(type >>> 0, fvf >>> 0,
                readArray(vertices, (count >>> 0) * strideOf(fvf)), count >>> 0,
                readArray(indices, (indexCount >>> 0) * 2), indexCount >>> 0),

        /** @param {any} device @param {number[]} args */
        SetClipStatus: (device, [pointer])=>{
            if ((pointer >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const raw = fields.readStruct(pointer >>> 0, D3DCLIPSTATUS,
                ['minx', 'maxx', 'miny', 'maxy', 'minz', 'maxz']);
            return device.SetClipStatus({
                flags: raw.dwFlags,
                status: raw.dwStatus,
                extents: [raw.minx, raw.maxx, raw.miny, raw.maxy, raw.minz, raw.maxz],
            });
        },

        /** @param {any} device @param {number[]} args */
        GetClipStatus: (device, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ status?: any }} */
            const held = {};
            device.GetClipStatus(held);
            const s = held.status;
            fields.writeStruct(out >>> 0, D3DCLIPSTATUS, {
                dwFlags: s.flags, dwStatus: s.status,
                minx: s.extents[0], maxx: s.extents[1], miny: s.extents[2], maxy: s.extents[3],
                minz: s.extents[4], maxz: s.extents[5],
            }, ['minx', 'maxx', 'miny', 'maxy', 'minz', 'maxz']);
            return D3D_OK;
        },

        /** @param {any} device @param {number[]} args */
        DrawPrimitiveVB: (device, [type, buffer, start, count])=>device.DrawPrimitiveVB(
            type >>> 0, publisher.objectAt(buffer), start >>> 0, count >>> 0),

        /** @param {any} device @param {number[]} args */
        DrawIndexedPrimitiveVB: (device, [type, buffer, start, count, indices, indexCount])=>
            device.DrawIndexedPrimitiveVB(type >>> 0, publisher.objectAt(buffer), start >>> 0,
                count >>> 0, indices >>> 0, indexCount >>> 0),

        /** @param {any} device @param {number[]} args */
        GetTexture: (device, [stage, out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = device.GetTexture(stage >>> 0, held);
            if (hr === D3D_OK)
            {
                fields.writeU32(out >>> 0, held.surface
                    ? publisher.publish(held.surface, [], IID_IDirectDrawSurface7)
                    : 0);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetTexture: (device, [stage, surface])=>
            device.SetTexture(stage >>> 0, publisher.objectAt(surface)),

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
        SetTextureStageState: (device, [stage, type, value])=>
            device.SetTextureStageState(stage >>> 0, type >>> 0, value >>> 0),

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

        /** @param {any} device @param {number[]} args */
        ApplyStateBlock: (device, [handle])=>device.ApplyStateBlock(handle >>> 0),
        /** @param {any} device @param {number[]} args */
        CaptureStateBlock: (device, [handle])=>device.CaptureStateBlock(handle >>> 0),
        /** @param {any} device @param {number[]} args */
        DeleteStateBlock: (device, [handle])=>device.DeleteStateBlock(handle >>> 0),

        /** @param {any} device @param {number[]} args */
        CreateStateBlock: (device, [type, out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
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

        /** @param {any} device @param {number[]} args */
        LightEnable: (device, [index, enable])=>device.LightEnable(index >>> 0, enable !== 0),

        /** @param {any} device @param {number[]} args */
        GetLightEnable: (device, [index, out])=>{
            /** @type {{ enabled?: boolean }} */
            const held = {};
            const hr = device.GetLightEnable(index >>> 0, held);
            if (hr === D3D_OK && (out >>> 0) !== 0)
            {
                fields.writeU32(out >>> 0, held.enabled ? 1 : 0);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        SetClipPlane: (device, [index, pointer])=>((pointer >>> 0) === 0
            ? DDERR_INVALIDPARAMS
            : device.SetClipPlane(index >>> 0, [...readFloats(pointer, 4)])),

        /** @param {any} device @param {number[]} args */
        GetClipPlane: (device, [index, out])=>{
            if ((out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            /** @type {{ plane?: number[] }} */
            const held = {};
            const hr = device.GetClipPlane(index >>> 0, held);
            if (hr === D3D_OK && held.plane)
            {
                held.plane.forEach((value, index2)=>
                    fields.writeF32((out >>> 0) + index2 * 4, value));
            }
            return hr;
        },
    };

    const deviceInterfaces = [
        describe(IID_IDirect3DDevice7, IDIRECT3DDEVICE7_SLOTS, deviceMethods),
    ];

    // A surface handed back here was made through IDirectDraw7 and published
    // by the DirectDraw seam as that generation's surface; asking the
    // publisher for the same identifier answers the same pointer.

    // --- the IDirect3D7 slots, on the DirectDraw object ---

    const d3dMethods = {
        /**
         * Each device is named to the callback with its description and
         * name written into the scratch block and its capabilities beside
         * them; the callback gets pointers to all three.
         *
         * @param {any} root @param {number[]} args
         */
        EnumDevices: (root, [callback, context])=>{
            if ((callback >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            if (!canEnumerate())
            {
                return D3D_OK;
            }
            const call = /** @type {NonNullable<typeof callGuest>} */ (callGuest);
            const d3d = d3dFor(root);
            return (async()=>{
                for (const device of d3d.enumDevices())
                {
                    const at = scratchBlock();
                    const description = at + D3DDEVICEDESC7.SIZE;
                    const name = description + 0x80;
                    writeDeviceDescription(at, device.caps);
                    writeString(description, device.text);
                    writeString(name, device.name);
                    const answer = await call({ entry: callback >>> 0,
                        args: [description, name, at, context >>> 0] });
                    if ((answer >>> 0) === DDENUMRET_CANCEL)
                    {
                        break;
                    }
                }
                return D3D_OK;
            })();
        },

        /** @param {any} root @param {number[]} args */
        CreateDevice: (root, [riid, surface, out])=>{
            if ((riid >>> 0) === 0 || (out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const made = d3dFor(root).createDevice(readGuid(memory, riid),
                publisher.objectAt(surface));
            if (made.hr !== D3D_OK)
            {
                fields.writeU32(out >>> 0, 0);
                return made.hr;
            }
            made.device.ddraw = root;
            fields.writeU32(out >>> 0,
                publisher.publish(made.device, deviceInterfaces, IID_IDirect3DDevice7));
            return D3D_OK;
        },

        /** @param {any} root @param {number[]} args */
        CreateVertexBuffer: (root, [desc, out])=>{
            if ((desc >>> 0) === 0 || (out >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            const raw = fields.readStruct(desc >>> 0, D3DVERTEXBUFFERDESC);
            if (raw.dwSize !== D3DVERTEXBUFFERDESC.SIZE)
            {
                return DDERR_INVALIDPARAMS;
            }
            const made = d3dFor(root).createVertexBuffer({
                caps: raw.dwCaps, fvf: raw.dwFVF, numVertices: raw.dwNumVertices,
            });
            if (made.hr !== D3D_OK)
            {
                return made.hr;
            }
            fields.writeU32(out >>> 0,
                publisher.publish(made.buffer, bufferInterfaces, IID_IDirect3DVertexBuffer7));
            return D3D_OK;
        },

        /**
         * The depth formats a device can have: sixteen bits of depth, and
         * twenty-four with eight of stencil.
         *
         * @param {any} root @param {number[]} args
         */
        EnumZBufferFormats: (root, [, callback, context])=>{
            if ((callback >>> 0) === 0)
            {
                return DDERR_INVALIDPARAMS;
            }
            if (!canEnumerate())
            {
                return D3D_OK;
            }
            const call = /** @type {NonNullable<typeof callGuest>} */ (callGuest);
            return (async()=>{
                for (const depth of [16, 32])
                {
                    const at = scratchBlock();
                    writePixelFormat(memory, at, depthFormatForDepth(depth));
                    const answer = await call({ entry: callback >>> 0, args: [at, context >>> 0] });
                    if ((answer >>> 0) === DDENUMRET_CANCEL)
                    {
                        break;
                    }
                }
                return D3D_OK;
            })();
        },

        EvictManagedTextures: ()=>D3D_OK,
    };

    return {
        /** The descriptor the DirectDraw seam puts beside its own generations. */
        interface: describe(IID_IDirect3D7, IDIRECT3D7_SLOTS, d3dMethods),

        /** For tests, which have no guest to call through. */
        interfaces: { device: deviceInterfaces, buffer: bufferInterfaces },
    };
}
