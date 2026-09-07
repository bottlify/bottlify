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
    D3DSURFACE_DESC8, D3DLOCKED_RECT, createFields } from './structs.js';
import { D3DFMT_INDEX } from '../d3d8/constants.js';
import { vertexCountOf } from '../d3d8/render.js';

const D3D_OK = 0;
const D3DERR_INVALIDCALL = 0x8876086c | 0;

/**
 * @param {Object} deps
 * @param {any} deps.publisher   From createPublisher.
 * @param {any} deps.memory      readMemory/writeMemory.
 * @param {() => any} deps.screen  The display this build is configured for.
 */
export function createDirect3D8Seam({ publisher, memory, screen }){
    const fields = createFields(memory);

    /**
     * A resource, published as whichever interface it is.
     *
     * Reached through the out-parameter of the call that made it, which is why
     * this both publishes and adds the reference: a program that receives an
     * interface owns a reference to it, and releases one when it is done.
     *
     * @param {any} object
     * @param {import('./com.js').InterfaceDescriptor[]} interfaces
     * @param {string} id
     * @param {number} out  Where to write the pointer.
     */
    const handBack = (object, interfaces, id, out)=>{
        const pointer = publisher.publish(object, interfaces, id);
        fields.writeU32(out, pointer);
        return pointer;
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
        /** @param {any} texture */
        GetLevelCount: texture=>texture.GetLevelCount?.() ?? 1,
        /** @param {any} texture @param {number[]} args */
        GetSurfaceLevel: (texture, [level, out])=>{
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = texture.GetSurfaceLevel(level >>> 0, held);
            if (hr === D3D_OK && held.surface && (out >>> 0) !== 0)
            {
                handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface8, out >>> 0);
            }
            return hr;
        },
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
                handBack(held.texture, textureInterfaces, IID_IDirect3DTexture8, out >>> 0);
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
                handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface8, out >>> 0);
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
                handBack(held.buffer, vertexBufferInterfaces,
                    IID_IDirect3DVertexBuffer8, out >>> 0);
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
                handBack(held.buffer, indexBufferInterfaces,
                    IID_IDirect3DIndexBuffer8, out >>> 0);
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
                handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface8, out >>> 0);
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
                handBack(held.surface, surfaceInterfaces, IID_IDirect3DSurface8, out >>> 0);
            }
            return hr;
        },

        /** @param {any} device @param {number[]} args */
        GetDepthStencilSurface: (device, [out])=>{
            /** @type {{ surface?: any }} */
            const held = {};
            const hr = device.GetDepthStencilSurface(held);
            if ((out >>> 0) !== 0)
            {
                // Written whatever the result: this call clears the caller's
                // pointer when it finds nothing, and a program tests the
                // pointer rather than the HRESULT.
                fields.writeU32(out >>> 0, hr === D3D_OK && held.surface
                    ? handBack(held.surface, surfaceInterfaces,
                        IID_IDirect3DSurface8, out >>> 0)
                    : 0);
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
    };

    const deviceInterfaces = [
        describe(IID_IDirect3DDevice8, IDIRECT3DDEVICE8_SLOTS, deviceMethods),
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

    /** @param {number} address @param {any} caps */
    const writeCaps = (address, caps)=>{
        // Zeroed first: the structure is long, a caller allocates all of it,
        // and every field this does not set has to read as "not supported"
        // rather than as whatever was on the stack.
        memory.writeMemory(address, new Uint8Array(D3DCAPS8.SIZE));
        fields.writeStruct(address, D3DCAPS8, {
            DeviceType: 1,
            MaxTextureWidth: caps.maxTextureWidth ?? 2048,
            MaxTextureHeight: caps.maxTextureHeight ?? 2048,
            MaxTextureBlendStages: caps.maxTextureBlendStages ?? 8,
            MaxSimultaneousTextures: caps.maxSimultaneousTextures ?? 8,
            MaxActiveLights: caps.maxActiveLights ?? 8,
            MaxStreams: caps.maxStreams ?? 16,
            MaxPrimitiveCount: caps.maxPrimitiveCount ?? 0xffff,
        });
        fields.writeStruct(address, D3DCAPS8, { MaxPointSize: caps.maxPointSize ?? 64 },
            ['MaxPointSize']);
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
        CreateDevice: (root, [, , , behaviourFlags, parameters, out])=>{
            if ((parameters >>> 0) === 0 || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            const wanted = readPresentParameters(parameters >>> 0);
            /** @type {{ device?: any }} */
            const held = {};
            const hr = root.CreateDevice(wanted, held, behaviourFlags >>> 0);
            writePresentParameters(parameters >>> 0, wanted);
            if (hr !== D3D_OK || !held.device)
            {
                // Cleared, because a caller checks the pointer it passed as
                // often as it checks the result.
                fields.writeU32(out >>> 0, 0);
                return hr;
            }
            handBack(held.device, deviceInterfaces, IID_IDirect3DDevice8, out >>> 0);
            return D3D_OK;
        },
    };

    const rootInterfaces = [describe(IID_IDirect3D8, IDIRECT3D8_SLOTS, rootMethods)];

    return {
        /**
         * Publishes the object Direct3DCreate8 hands back.
         *
         * @param {any} root  What graphics.create('d3d8') returned.
         * @returns {number}
         */
        publishRoot: root=>publisher.publish(root, rootInterfaces, IID_IDirect3D8),

        /** For tests, which have no guest to call through. */
        interfaces: { root: rootInterfaces, device: deviceInterfaces,
            surface: surfaceInterfaces, texture: textureInterfaces },
    };
}
