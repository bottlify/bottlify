/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 7: the object a program reaches from its DirectDraw object, and
 * the device it makes on one of its surfaces.
 *
 * Almost everything a D3D7 device holds, D3D8's holds too -- render states,
 * texture stages, transforms, lights, a material, a viewport -- and the
 * numbers agree wherever both versions have a state. So the drawing is not
 * written twice: this device keeps its state in the shape the shared renderer
 * reads, and the renderer records and replays the frame exactly as it does
 * for D3D8. What this file owns is the part that is genuinely D3D7's:
 *
 * - **A render target is a DirectDraw surface.** It is chosen at creation,
 *   changed with SetRenderTarget, and its depth buffer is whatever surface is
 *   attached to it. The surface lives in guest memory by address, and a flip
 *   swaps addresses between surfaces -- so what the renderer draws into is
 *   keyed by the address, not the surface object, and a flip presents the
 *   texture that was drawn without copying anything.
 * - **A texture is a DirectDraw surface too.** The program writes its texels
 *   by locking or blitting, and the surface's uniqueness value is how this
 *   layer learns that the copy on the GPU is stale.
 * - **Vertices arrive by pointer, or in a vertex buffer that is a guest
 *   allocation.** Both are what the renderer already reads; a buffer of
 *   indices handed to DrawIndexedPrimitiveVB by pointer travels through a
 *   scratch record whose address is the program's own array.
 * - **The scene is a pair of states with their own codes**, and a state block
 *   records what is set between its begin and end.
 *
 * Nothing here is reached by a program directly; `seam/d3d7.js` translates.
 */

import {
    D3DERR_INBEGINSTATEBLOCK, D3DERR_INVALIDPRIMITIVETYPE, D3DERR_INVALIDSTATEBLOCK,
    D3DERR_INVALIDVERTEXFORMAT, D3DERR_NOTINBEGINSTATEBLOCK, D3DERR_SCENE_IN_SCENE,
    D3DERR_SCENE_NOT_IN_SCENE, D3DERR_VERTEXBUFFERLOCKED, D3DFMT, D3DLIGHTTYPE,
    D3DRENDERSTATE_D3D7_ONLY, D3DRENDERSTATE_MAX, D3DSBT, D3DTRANSFORMSTATE, D3DTSS_MAX,
    D3DVBCAPS_OPTIMIZED, D3D_OK, DDERR_INVALIDPARAMS, DDERR_NOTFOUND, DDLOCK_DISCARDCONTENTS,
    DDLOCK_NOOVERWRITE, DDLOCK_READONLY, DEVICE_IDS, transformStateOf,
} from './constants.js';
import { DEVICE_DESCRIPTIONS } from './caps.js';
import { D3DCLEAR, D3DLOCK, D3DFMT_INDEX, D3DTSS } from '../d3d8/constants.js';
import { createDefaultRenderStates } from '../d3d8/renderstates.js';
import { createDefaultStageStates } from '../d3d8/stagestates.js';
import {
    IDENTITY, STAGE_COUNT, createRenderer, multiplyMatrices, vertexCountOf,
} from '../d3d8/render.js';
import { fullTarget, viewportState } from '../webgpu/internal/viewport.js';
import { decodeFvf } from '../webgpu/internal/vertexformat.js';
import { validateDeviceTarget } from '../ddraw/caps.js';
import { validateStages } from '../d3d8/validity.js';
import { writePixels } from '../d3d9/resources.js';
import {
    DDCKEY_SRCBLT, DDPF_ALPHAPIXELS, DDPF_PALETTEINDEXED_ANY, DDPF_ZBUFFER, DDSCAPS_ZBUFFER,
} from '../ddraw/constants.js';

/**
 * Direct3D 7 numbers two of its filters apart from Direct3D 8, whose
 * numbering the stage states are kept in so the renderer reads them as they
 * are: D3DTFP counts from one where D3DTEXF counts from zero, and D3DTFG puts
 * the two cubic filters before anisotropic (d3dtypes.h). Each mapping is one
 * to one over the dword, so a value no header names reads back as it was set.
 *
 * @type {Readonly<Record<number, { stored: (value: number) => number,
 *   read: (value: number) => number }>>}
 */
const FILTER_NUMBERING = Object.freeze({
    [D3DTSS.MAGFILTER]: {
        stored: value=>[value, value, value, 4, 5, 3][value] ?? value,
        read: value=>[value, value, value, 5, 3, 4][value] ?? value,
    },
    [D3DTSS.MIPFILTER]: {
        stored: value=>(value - 1) >>> 0,
        read: value=>(value + 1) >>> 0,
    },
});

/**
 * @typedef {import('../d3d8/device.js').Light} Light
 * @typedef {import('../d3d8/device.js').Material} Material
 * @typedef {import('../d3d8/device.js').Viewport} Viewport
 */

/**
 * @typedef {Object} RenderServices
 *     What a device that draws needs; absent, the device is the pure model.
 * @property {any} [backend]
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {(address: number, bytes: Uint8Array) => void} [writeMemory]
 *     How a render target's pixels read back off the GPU reach its guest
 *     bytes; without it a lock of a target hands out bytes nobody drew.
 * @property {(descriptor: any) => any} [createSampler]
 * @property {{ claim: (buffer: number, show: () => void) => void,
 *              release: (buffer: number) => void }} [presenter]
 *     Where a flipped surface gets shown from. The device claims the address
 *     of every surface it renders into, so a present of that address shows
 *     the texture rather than the guest bytes nobody drew.
 * @property {boolean} [dumpDraws]  Every draw of the last frame, with its state,
 *     as Direct3D 8's renderer writes it.
 * @property {number} [dumpEvery]
 * @property {number} [maxDraws]
 * @property {string | null} [skipTexture]  A dump id (`tN`), as `--skip-texture` names it.
 * @property {string | null} [probeTexture]
 * @property {{ dumpFrames: number }} [liveDump]  frames to write down from now on, on
 *     asking (app.debug.dumpFrames), as Direct3D 8 and 9 devices take it
 * @property {(ddraw: any, services: RenderServices) => any} [remote]
 *     Makes the Direct3D 7 object in this one's place, whose devices draw
 *     elsewhere (`remote/d3d7.js`).
 */

/** How many indices the scratch record can carry; a bigger draw grows it. */
const INDEX_SCRATCH = 0x10000;

/** D3DRENDERSTATE_CLIPPLANEENABLE, and the user planes a D3DSTATUS word has bits for. */
const D3DRENDERSTATE_CLIPPLANEENABLE = 152;
const USER_CLIP_PLANES = 6;

/**
 * The D3DFMT a DirectDraw pixel format means, as the renderer names formats.
 * Null for one the renderer cannot take -- a palettised texture, say.
 *
 * @param {import('../ddraw/structs.js').PixelFormatFields} format
 * @returns {number | null}
 */
export function d3dFormatOf(format){
    if ((format.flags & DDPF_ZBUFFER) !== 0)
    {
        if (format.bitCount === 16)
        {
            return D3DFMT.D16;
        }
        // The stencil depth sits in the slot the red mask uses for colour. A
        // z-buffer of another depth is held in the nearest a driver has.
        return format.redMask === 8 ? D3DFMT.D24S8
            : format.bitCount > 16 ? D3DFMT.D24X8 : D3DFMT.D16;
    }
    if ((format.flags & DDPF_PALETTEINDEXED_ANY) !== 0)
    {
        return null;
    }
    const alpha = (format.flags & DDPF_ALPHAPIXELS) !== 0;
    switch (format.bitCount)
    {
        case 32:
            return alpha ? D3DFMT.A8R8G8B8 : D3DFMT.X8R8G8B8;
        case 16:
            if (format.greenMask === 0x07e0)
            {
                return D3DFMT.R5G6B5;
            }
            if (alpha && format.alphaMask === 0xf000)
            {
                return D3DFMT.A4R4G4B4;
            }
            return alpha ? D3DFMT.A1R5G5B5 : D3DFMT.X1R5G5B5;
        case 8:
            return alpha ? D3DFMT.A8 : null;
        default:
            return null;
    }
}

/**
 * The material a fresh device has: white diffuse and ambient, no highlight and
 * no glow.
 *
 * Not all zeros, which is what an unseeded structure would be. Geometry that
 * never calls SetMaterial and carries no vertex colour takes every lighting
 * term from here, so a black default lights the whole scene to black while
 * every state a program reads back still says what it expects.
 *
 * @returns {Material}
 */
function defaultMaterial(){
    const white = ()=>({ r: 1, g: 1, b: 1, a: 1 });
    const black = ()=>({ r: 0, g: 0, b: 0, a: 0 });
    return { Diffuse: white(), Ambient: white(), Specular: black(), Emissive: black(), Power: 0 };
}

/** @param {Material} material @returns {Material} */
const copyMaterial = material=>({
    Diffuse: { ...material.Diffuse },
    Ambient: { ...material.Ambient },
    Specular: { ...material.Specular },
    Emissive: { ...material.Emissive },
    Power: material.Power,
});

/** @returns {Light} what enabling an unwritten light brings into existence */
function defaultLight(){
    return {
        Type: D3DLIGHTTYPE.DIRECTIONAL,
        Diffuse: { r: 1, g: 1, b: 1, a: 0 },
        Specular: { r: 0, g: 0, b: 0, a: 0 },
        Ambient: { r: 0, g: 0, b: 0, a: 0 },
        Position: { x: 0, y: 0, z: 0 },
        Direction: { x: 0, y: 0, z: 1 },
        Range: 0,
        Falloff: 0,
        Attenuation0: 0,
        Attenuation1: 0,
        Attenuation2: 0,
        Theta: 0,
        Phi: 0,
    };
}

/**
 * @param {number} lockFlags DDLOCK
 * @returns {number} the D3DLOCK the renderer's buffer contract reads
 */
function bufferLockFlags(lockFlags){
    let flags = 0;
    if ((lockFlags & DDLOCK_DISCARDCONTENTS) !== 0)
    {
        flags |= D3DLOCK.DISCARD;
    }
    if ((lockFlags & DDLOCK_NOOVERWRITE) !== 0)
    {
        flags |= D3DLOCK.NOOVERWRITE;
    }
    if ((lockFlags & DDLOCK_READONLY) !== 0)
    {
        flags |= D3DLOCK.READONLY;
    }
    return flags;
}

/**
 * The Direct3D 7 object, which is a view of the DirectDraw object: it has
 * no count of its own (the seam routes its references to IDirectDraw7's),
 * and every surface it is handed belongs to that object.
 *
 * @param {any} ddraw  The DirectDraw model root.
 * @param {RenderServices} [services]
 */
export function createDirect3D7(ddraw, services = {}){
    const renderer = services.backend
        ? createRenderer({
            backend: services.backend,
            readMemory: /** @type {(address: number, length: number) => Uint8Array} */ (
                services.readMemory),
            createSampler: services.createSampler ?? null,
            dumpDraws: services.dumpDraws === true,
            dumpEvery: services.dumpEvery,
            maxDraws: services.maxDraws,
            skipTexture: services.skipTexture ?? null,
            probeTexture: services.probeTexture ?? null,
            liveDump: services.liveDump,
        })
        : null;

    /** A guest allocation is a buffer to the renderer; the address is the program's. */
    const allocate = (/** @type {number} */ bytes)=>ddraw.allocateStorage(bytes);

    return {
        /** The three devices, in the order a program enumerates them. */
        enumDevices: ()=>DEVICE_DESCRIPTIONS.map(device=>({ ...device })),

        /**
         * @param {string} deviceId
         * @param {any} surface  A DirectDraw surface with DDSCAPS_3DDEVICE.
         * @returns {{ hr: number, device: any }}
         */
        createDevice(deviceId, surface){
            const description = DEVICE_DESCRIPTIONS.find(device=>device.id === deviceId);
            if (!description)
            {
                // The reference and null devices exist in the header and not
                // in this build; asking for one is asking for nothing.
                return { hr: DDERR_NOTFOUND, device: null };
            }
            if (!surface)
            {
                return { hr: DDERR_INVALIDPARAMS, device: null };
            }
            const hr = validateDeviceTarget({
                caps: surface.caps,
                pixelFormatFlags: surface.pixelFormat.flags,
                hasPalette: surface.palette !== null,
            }, description.id !== DEVICE_IDS.RGB);
            if (hr !== D3D_OK)
            {
                return { hr, device: null };
            }
            return { hr: D3D_OK, device: createDevice(description, surface) };
        },

        /**
         * A vertex buffer: a guest allocation the renderer reads as a stream.
         * The FVF is fixed at creation and a draw has to use it.
         *
         * @param {{ caps: number, fvf: number, numVertices: number }} desc
         * @returns {{ hr: number, buffer: any }}
         */
        createVertexBuffer(desc){
            let layout;
            try
            {
                layout = decodeFvf(desc.fvf >>> 0);
            }
            catch (e){
                void e;
                return { hr: D3DERR_INVALIDVERTEXFORMAT, buffer: null };
            }
            if (!(desc.numVertices > 0))
            {
                return { hr: DDERR_INVALIDPARAMS, buffer: null };
            }
            return { hr: D3D_OK, buffer: createVertexBuffer(desc, layout) };
        },
    };

    /**
     * @param {{ caps: number, fvf: number, numVertices: number }} desc
     * @param {import('../webgpu/internal/vertexformat.js').VertexLayout} layout
     */
    function createVertexBuffer(desc, layout){
        const length = layout.stride * desc.numVertices;
        const base = allocate(length);
        let locked = false;
        let count = 1;
        // A buffer takes a reference on the DirectDraw object, as a surface
        // made through the seventh generation does.
        ddraw.addRef('IDirectDraw7');

        const buffer = {
            length,
            usage: 0,
            pool: 0,
            fvf: desc.fvf >>> 0,
            caps: desc.caps >>> 0,
            numVertices: desc.numVertices,
            stride: layout.stride,
            base,
            get refCount(){
                return count;
            },
            addRef(){
                count++;
                return count;
            },
            release(){
                count--;
                if (count === 0)
                {
                    ddraw.freeStorage(base);
                    ddraw.release('IDirectDraw7');
                }
                return Math.max(count, 0);
            },

            /**
             * The whole buffer, always: D3D7 has no offset or size to lock.
             *
             * @param {number} flags DDLOCK
             * @param {{ data?: number, size?: number }} out
             */
            Lock(flags, out){
                if (locked)
                {
                    return D3DERR_VERTEXBUFFERLOCKED;
                }
                locked = true;
                out.data = base;
                out.size = length;
                if (renderer)
                {
                    renderer.lockBuffer(buffer, 0, length, bufferLockFlags(flags >>> 0));
                }
                return D3D_OK;
            },

            Unlock(){
                if (!locked)
                {
                    return D3D_OK;
                }
                locked = false;
                if (renderer)
                {
                    renderer.unlockBuffer(buffer);
                }
                return D3D_OK;
            },

            get locked(){
                return locked;
            },

            GetVertexBufferDesc(/** @type {{ desc?: any }} */ out){
                out.desc = { caps: buffer.caps, fvf: buffer.fvf, numVertices: buffer.numVertices };
                return D3D_OK;
            },

            /** Optimising is a promise about performance this build keeps by doing nothing. */
            Optimize(){
                buffer.caps = (buffer.caps | D3DVBCAPS_OPTIMIZED) >>> 0;
                return D3D_OK;
            },
        };
        return buffer;
    }

    /**
     * @param {typeof DEVICE_DESCRIPTIONS[number]} description
     * @param {any} target
     */
    function createDevice(description, target){
        let inScene = false;
        /** @type {Map<number, number>} */
        let renderStates = createDefaultRenderStates({
            enableAutoDepthStencil: attachedDepth(target) !== null,
            maxPointSize: 1,
            softwareVertexProcessing: false,
        });
        // D3D8's table with D3D7's own added. The states past D3D7's last
        // stay for the renderer, which is Direct3D 8's: a D3D7 device always
        // adds what it blends and writes every channel, which is what BLENDOP
        // and COLORWRITEENABLE say at their defaults -- dropped, they read as
        // no blend operation and a write mask of nothing, and no pixel of any
        // draw reaches the target. A program cannot reach them: a state this
        // version never had is not one it can set or read.
        for (const state of Object.values(D3DRENDERSTATE_D3D7_ONLY))
        {
            if (!renderStates.has(state))
            {
                renderStates.set(state, 0);
            }
        }
        /** @param {number} state */
        const isProgramState = state=>state <= D3DRENDERSTATE_MAX && renderStates.has(state);
        /** @type {Map<number, Map<number, number>>} */
        const stageStates = new Map();
        /** @type {Map<number, any>} stage -> DirectDraw surface */
        const textures = new Map();
        /** @type {Map<number, Float32Array>} D3D8-numbered */
        const transforms = new Map();
        /** @type {Map<number, { light: Light, enabled: boolean }>} */
        const lights = new Map();
        let material = defaultMaterial();
        let renderTarget = target;
        /** @type {import('../webgpu/contract.js').ViewportState} */
        let viewport = fullTarget({ width: target.width, height: target.height });
        let clipStatus = { flags: 0, status: 0, extents: [0, 0, 0, 0, 0, 0] };
        /** @type {Map<number, number[]>} */
        const clipPlanes = new Map();
        let count = 1;
        target.addRef();
        ddraw.addRef('IDirectDraw7');

        /** @type {Map<number, any>} state block handle -> record */
        const stateBlocks = new Map();
        let nextBlock = 1;
        /** @type {any} the block being recorded, if one is */
        let recording = null;

        /**
         * The renderer's view of a DirectDraw surface, by the address of its
         * pixels: after a flip the surface object shows other pixels, and it
         * is those that were drawn into.
         *
         * @type {Map<number, any>}
         */
        const targetAdapters = new Map();
        /** @type {WeakMap<object, any>} texture surface -> its adapter */
        const textureAdapters = new WeakMap();

        /** @param {any} surface */
        const targetAdapterFor = surface=>{
            const buffer = surface.buffer;
            const existing = targetAdapters.get(buffer);
            if (existing)
            {
                return existing;
            }
            // A z-buffer is one whatever its descriptor said of its format.
            const format = d3dFormatOf(surface.pixelFormat)
                ?? ((surface.caps & DDSCAPS_ZBUFFER) !== 0 ? D3DFMT.D16 : null);
            const adapter = {
                buffer,
                // Where a read-back is written and a write taken up from.
                base: buffer,
                /** @param {{ desc?: any }} out */
                GetDesc(out){
                    out.desc = {
                        Format: format,
                        Width: surface.width,
                        Height: surface.height,
                        Usage: (surface.caps & DDSCAPS_ZBUFFER) !== 0 ? 2 : 1,
                        Pool: 0,
                        Type: 1,
                    };
                    return D3D_OK;
                },
            };
            targetAdapters.set(buffer, adapter);
            if (services.presenter && (surface.caps & DDSCAPS_ZBUFFER) === 0)
            {
                services.presenter.claim(buffer, ()=>device.present(buffer));
            }
            return adapter;
        };

        /**
         * @param {any} surface
         * @returns {any | null} the texture adapter, or null for a format the renderer cannot take
         */
        const textureAdapterFor = surface=>{
            const existing = textureAdapters.get(surface);
            if (existing)
            {
                return existing;
            }
            const format = d3dFormatOf(surface.pixelFormat);
            if (format === null || !renderer)
            {
                return null;
            }
            // A DirectDraw mip chain is a surface per level, each with pixels
            // and a uniqueness value of its own.
            /** @type {any[]} */
            const levels = [];
            for (let level = surface; level && levels.length < Math.max(1, surface.mipMapCount);
                level = level.mipNext)
            {
                levels.push(level);
            }
            const views = levels.map(level=>({ base: level.buffer, release: ()=>0 }));
            const adapter = {
                levels,
                seen: levels.map(()=>-1),
                /** @param {number} level @param {{ surface?: any }} out */
                GetSurfaceLevel(level, out){
                    if (!views[level])
                    {
                        return DDERR_INVALIDPARAMS;
                    }
                    views[level].base = levels[level].buffer;
                    out.surface = views[level];
                    return D3D_OK;
                },
                /** Replaced by the renderer with the one that marks the copy stale. */
                UnlockRect(){
                    return D3D_OK;
                },
                /**
                 * The source colour key COLORKEYENABLE draws against, as the
                 * surface holds it now, or null for none.
                 */
                colorKey(){
                    const { key } = surface.getColorKey(DDCKEY_SRCBLT);
                    return key ? key.low >>> 0 : null;
                },
            };
            renderer.trackTexture(adapter,
                { width: surface.width, height: surface.height, format, levels: levels.length });
            textureAdapters.set(surface, adapter);
            return adapter;
        };

        // The target is the GPU's from the moment the device exists on it:
        // a present of its address before anything is drawn shows the
        // texture, empty, rather than the guest bytes nobody drew either.
        if (renderer)
        {
            targetAdapterFor(target);
        }

        /**
         * The renderer sees a texture as stale when its unlock is called;
         * here the program's writes are known by the surface's uniqueness
         * value, so a changed value is turned into that call before a draw.
         *
         * @param {any} surface
         */
        const refreshedTexture = surface=>{
            const adapter = textureAdapterFor(surface);
            if (!adapter)
            {
                return null;
            }
            adapter.levels.forEach((/** @type {any} */ level, /** @type {number} */ index)=>{
                const now = level.uniquenessValue();
                if (now !== adapter.seen[index])
                {
                    adapter.seen[index] = now;
                    adapter.UnlockRect(index);
                }
            });
            return adapter;
        };

        /** @param {number} stage */
        const stageStatesFor = stage=>{
            const existing = stageStates.get(stage);
            if (existing)
            {
                return existing;
            }
            const made = createDefaultStageStates(stage);
            stageStates.set(stage, made);
            return made;
        };

        /** The textures the renderer samples: adapters, refreshed. */
        const rendererTextures = {
            /** @param {number} stage */
            get: stage=>{
                const surface = textures.get(stage);
                return surface ? refreshedTexture(surface) : null;
            },
        };

        /**
         * A stream the renderer reads: the buffer the last DrawPrimitiveVB
         * named, at its own stride. Set per draw.
         */
        const stream = { buffer: /** @type {any} */ (null), stride: 0 };
        /**
         * The indices DrawIndexedPrimitiveVB hands over by pointer, as a
         * record whose address is the program's own array: locking it is what
         * makes the renderer read them.
         */
        const indexScratch = {
            length: INDEX_SCRATCH * 2,
            format: D3DFMT_INDEX.INDEX16,
            base: 0,
        };
        let baseVertexIndex = 0;
        let drawFvf = 0;
        /** @type {number} the address a present shows; the render target's until a flip */
        let presenting = 0;

        /** @type {import('../d3d8/render.js').RenderModel} */
        const model = {
            get renderStates(){
                return renderStates;
            },
            stageStates: stageStatesFor,
            textures: /** @type {any} */ (rendererTextures),
            get stream(){
                return stream;
            },
            get indices(){
                return indexScratch;
            },
            get baseVertexIndex(){
                return baseVertexIndex;
            },
            get viewport(){
                return viewport;
            },
            get renderTarget(){
                return targetAdapterFor(renderTarget);
            },
            get depthStencil(){
                const depth = attachedDepth(renderTarget);
                return depth ? targetAdapterFor(depth) : null;
            },
            get transforms(){
                return transforms;
            },
            get lights(){
                return lights;
            },
            get material(){
                return material;
            },
            get backBuffer(){
                return targetAdapters.get(presenting) ?? targetAdapterFor(renderTarget);
            },
            get stageProcessing(){
                return { vertexShader: 0, fvf: drawFvf, pixelShader: 0 };
            },
        };

        /**
         * What every draw is refused for before its arguments are looked at.
         * A draw of nothing -- no vertices, or no indices -- is not refused
         * for having no primitives: it draws nothing and succeeds, whatever
         * its arrays are (Wine's ddraw7.c test_draw_primitive).
         *
         * @param {number} type @param {number} fvf @param {number} primitiveCount
         * @param {number} elements  The vertices or indices the draw names.
         */
        const drawPreconditions = (type, fvf, primitiveCount, elements)=>{
            if (!inScene)
            {
                return D3DERR_SCENE_NOT_IN_SCENE;
            }
            if (elements !== 0 && vertexCountOf(type, primitiveCount) === 0)
            {
                return primitiveCount > 0 ? D3DERR_INVALIDPRIMITIVETYPE : DDERR_INVALIDPARAMS;
            }
            try
            {
                decodeFvf(fvf);
            }
            catch (e){
                void e;
                return D3DERR_INVALIDVERTEXFORMAT;
            }
            return D3D_OK;
        };

        /** @param {number} type @param {number} vertexCount */
        const primitiveCountOf = (type, vertexCount)=>{
            for (let primitives = vertexCount; primitives > 0; primitives--)
            {
                if (vertexCountOf(type, primitives) === vertexCount)
                {
                    return primitives;
                }
            }
            return 0;
        };

        /** Records a state set while a block is being recorded. */
        /**
         * @param {string} kind @param {number} key @param {any} value
         */
        function record(kind, key, value){
            if (recording)
            {
                recording[kind].set(key, value);
            }
        }

        /** @param {any} block */
        const applyBlock = block=>{
            for (const [state, value] of block.renderStates)
            {
                renderStates.set(state, value);
            }
            for (const [key, value] of block.stageStates)
            {
                stageStatesFor(key >>> 8).set(key & 0xff, value);
            }
            for (const [type, matrix] of block.transforms)
            {
                transforms.set(type, Float32Array.from(matrix));
            }
        };

        /**
         * The depth this device draws against is the GPU's copy, so a
         * DirectDraw depth fill of the buffer attached to its target is a
         * depth clear there, over the rectangle filled and nothing else.
         *
         * @param {any} surface @param {any} rect @param {number} value
         */
        const depthFilled = (surface, rect, value)=>{
            if (!renderer || attachedDepth(renderTarget) !== surface)
            {
                return;
            }
            const range = surface.pixelFormat.greenMask >>> 0 || 0xffff;
            const kept = viewport;
            viewport = fullTarget({ width: renderTarget.width, height: renderTarget.height });
            renderer.clear(model, rect
                ? [{ x1: rect.left, y1: rect.top, x2: rect.right, y2: rect.bottom }]
                : [], D3DCLEAR.ZBUFFER, 0, ((value & range) >>> 0) / range, 0);
            viewport = kept;
        };
        const stopWatchingDepth = ddraw.watchDepthFills?.(depthFilled) ?? (()=>{});

        /**
         * The colour target drawn at the address a surface shows, if this
         * device draws there: after a flip that is another surface's target.
         *
         * @param {any} surface
         */
        const drawnAt = surface=>((surface.caps & DDSCAPS_ZBUFFER) === 0
            ? targetAdapters.get(surface.buffer) ?? null
            : null);
        const write = services.writeMemory;
        /**
         * A surface this device renders into has its picture on the GPU and
         * stale bytes in guest memory. Before a program reads those bytes --
         * a lock, a device context, a blit out of it -- they are read back,
         * and the caller waits; once it has written them, they go up to the
         * target at its next use. A depth buffer has no way back.
         *
         * @param {any} surface
         * @returns {Promise<void> | null}
         */
        const readBack = surface=>{
            const adapter = drawnAt(surface);
            if (!adapter || !renderer || !write)
            {
                return null;
            }
            return renderer.readSurface(adapter).then(
                (/** @type {{ data: Uint8Array }} */ pixels)=>{
                    writePixels(adapter, pixels.data, write);
                });
        };
        /** @param {any} surface */
        const written = surface=>{
            const adapter = drawnAt(surface);
            if (adapter && renderer)
            {
                renderer.markDirty(adapter);
            }
        };
        const stopWatchingPixels = ddraw.watchPixels?.({ readBack, written }) ?? (()=>{});

        const device = {
            description,
            get refCount(){
                return count;
            },
            addRef(){
                count++;
                return count;
            },
            release(){
                count--;
                if (count > 0)
                {
                    return count;
                }
                // A device holds its target, its textures and the object
                // that made it, and gives them all back with its last reference.
                for (const adapter of targetAdapters.values())
                {
                    services.presenter?.release(adapter.buffer);
                }
                targetAdapters.clear();
                for (const surface of textures.values())
                {
                    surface.release();
                }
                textures.clear();
                stopWatchingDepth();
                stopWatchingPixels();
                renderTarget.release();
                ddraw.release('IDirectDraw7');
                return 0;
            },

            get inScene(){
                return inScene;
            },

            /** @param {{ caps?: any }} out */
            GetCaps(out){
                out.caps = { ...description.caps };
                return D3D_OK;
            },

            BeginScene(){
                if (inScene)
                {
                    return D3DERR_SCENE_IN_SCENE;
                }
                inScene = true;
                return D3D_OK;
            },

            EndScene(){
                if (!inScene)
                {
                    return D3DERR_SCENE_NOT_IN_SCENE;
                }
                inScene = false;
                return D3D_OK;
            },

            /**
             * A new target must be one a device could have been created on.
             * The reference moves with it: the old target is released, the
             * new one held.
             *
             * @param {any} surface
             */
            SetRenderTarget(surface){
                if (!surface)
                {
                    return DDERR_INVALIDPARAMS;
                }
                const hr = validateDeviceTarget({
                    caps: surface.caps,
                    pixelFormatFlags: surface.pixelFormat.flags,
                    hasPalette: surface.palette !== null,
                }, description.id !== DEVICE_IDS.RGB);
                if (hr !== D3D_OK)
                {
                    return hr;
                }
                if (surface !== renderTarget)
                {
                    surface.addRef();
                    renderTarget.release();
                    renderTarget = surface;
                    viewport = fullTarget({ width: surface.width, height: surface.height });
                    if (renderer)
                    {
                        targetAdapterFor(surface);
                    }
                }
                return D3D_OK;
            },

            /** @param {{ surface?: any }} out */
            GetRenderTarget(out){
                renderTarget.addRef();
                out.surface = renderTarget;
                return D3D_OK;
            },

            /**
             * @param {number} rectCount
             * @param {readonly { x1: number, y1: number, x2: number, y2: number }[] | null} rects
             * @param {number} flags D3DCLEAR
             * @param {number} color
             * @param {number} z
             * @param {number} stencil
             */
            Clear(rectCount, rects, flags, color, z, stencil){
                if ((flags & 7) === 0 || (rectCount > 0 && !rects))
                {
                    return DDERR_INVALIDPARAMS;
                }
                if ((flags & 6) !== 0 && attachedDepth(renderTarget) === null)
                {
                    return DDERR_INVALIDPARAMS;
                }
                if (renderer)
                {
                    renderer.clear(model, rectCount > 0 ? (rects ?? []).slice(0, rectCount) : [],
                        flags, color >>> 0, z, stencil);
                }
                return D3D_OK;
            },

            /**
             * @param {number} type D3DTRANSFORMSTATE
             * @param {ArrayLike<number>} matrix
             */
            SetTransform(type, matrix){
                const key = transformStateOf(type);
                if (key === null || !matrix || matrix.length !== 16)
                {
                    return DDERR_INVALIDPARAMS;
                }
                transforms.set(key, Float32Array.from(matrix));
                record('transforms', key, Float32Array.from(matrix));
                return D3D_OK;
            },

            /** @param {number} type @param {{ matrix?: Float32Array }} out */
            GetTransform(type, out){
                const key = transformStateOf(type);
                if (key === null)
                {
                    return DDERR_INVALIDPARAMS;
                }
                out.matrix = Float32Array.from(transforms.get(key) ?? IDENTITY);
                return D3D_OK;
            },

            /**
             * The product is the given matrix times the existing one, as
             * Direct3D documents it ("lpD3DMatrix times" the state) and Wine
             * computes it: the given transform is applied first, inside what
             * was there -- an object's own placement under its parent's.
             *
             * @param {number} type @param {ArrayLike<number>} matrix
             */
            MultiplyTransform(type, matrix){
                const key = transformStateOf(type);
                if (key === null || !matrix || matrix.length !== 16)
                {
                    return DDERR_INVALIDPARAMS;
                }
                const current = transforms.get(key) ?? IDENTITY;
                const product = new Float32Array(16);
                for (let row = 0; row < 4; row++)
                {
                    for (let column = 0; column < 4; column++)
                    {
                        let sum = 0;
                        for (let k = 0; k < 4; k++)
                        {
                            sum += matrix[row * 4 + k] * current[k * 4 + column];
                        }
                        product[row * 4 + column] = sum;
                    }
                }
                transforms.set(key, product);
                return D3D_OK;
            },

            /** @param {Viewport} value */
            SetViewport(value){
                if (!value || !(value.Width > 0) || !(value.Height > 0)
                    || value.X < 0 || value.Y < 0
                    || value.X + value.Width > renderTarget.width
                    || value.Y + value.Height > renderTarget.height)
                {
                    return DDERR_INVALIDPARAMS;
                }
                viewport = viewportState({
                    x: value.X,
                    y: value.Y,
                    width: value.Width,
                    height: value.Height,
                    minDepth: value.MinZ,
                    maxDepth: value.MaxZ,
                });
                return D3D_OK;
            },

            /** @param {{ viewport?: Viewport }} out */
            GetViewport(out){
                const rect = viewport.rect;
                out.viewport = {
                    X: rect.x,
                    Y: rect.y,
                    Width: rect.width,
                    Height: rect.height,
                    MinZ: rect.minDepth,
                    MaxZ: rect.maxDepth,
                };
                return D3D_OK;
            },

            /** @param {Material} value */
            SetMaterial(value){
                if (!value)
                {
                    return DDERR_INVALIDPARAMS;
                }
                material = copyMaterial(value);
                return D3D_OK;
            },

            /** @param {{ material?: Material }} out */
            GetMaterial(out){
                out.material = copyMaterial(material);
                return D3D_OK;
            },

            /** @param {number} index @param {Light} light */
            SetLight(index, light){
                if (!light)
                {
                    return DDERR_INVALIDPARAMS;
                }
                const existing = lights.get(index);
                lights.set(index, { light: { ...light }, enabled: existing?.enabled ?? false });
                return D3D_OK;
            },

            /** @param {number} index @param {{ light?: Light }} out */
            GetLight(index, out){
                const entry = lights.get(index);
                if (!entry)
                {
                    return DDERR_INVALIDPARAMS;
                }
                out.light = { ...entry.light };
                return D3D_OK;
            },

            /** @param {number} index @param {boolean} enable */
            LightEnable(index, enable){
                const entry = lights.get(index) ?? { light: defaultLight(), enabled: false };
                entry.enabled = enable === true;
                lights.set(index, entry);
                return D3D_OK;
            },

            /** @param {number} index @param {{ enabled?: boolean }} out */
            GetLightEnable(index, out){
                const entry = lights.get(index);
                if (!entry)
                {
                    return DDERR_INVALIDPARAMS;
                }
                out.enabled = entry.enabled;
                return D3D_OK;
            },

            /** @param {number} state @param {number} value */
            SetRenderState(state, value){
                if (!isProgramState(state))
                {
                    return DDERR_INVALIDPARAMS;
                }
                renderStates.set(state, value >>> 0);
                record('renderStates', state, value >>> 0);
                return D3D_OK;
            },

            /** @param {number} state @param {{ value?: number }} out */
            GetRenderState(state, out){
                if (!isProgramState(state))
                {
                    return DDERR_INVALIDPARAMS;
                }
                out.value = renderStates.get(state);
                return D3D_OK;
            },

            /**
             * @param {number} stage
             * @param {any} surface  A DirectDraw surface, or null to unbind.
             */
            SetTexture(stage, surface){
                if (stage < 0 || stage >= STAGE_COUNT)
                {
                    return DDERR_INVALIDPARAMS;
                }
                const previous = textures.get(stage);
                if (previous === surface)
                {
                    return D3D_OK;
                }
                // Binding owns, in this version: the device holds the texture
                // until it is unbound or replaced.
                if (surface)
                {
                    surface.addRef();
                    textures.set(stage, surface);
                }
                else
                {
                    textures.delete(stage);
                }
                previous?.release();
                return D3D_OK;
            },

            /** @param {number} stage @param {{ surface?: any }} out */
            GetTexture(stage, out){
                const surface = textures.get(stage) ?? null;
                if (surface)
                {
                    surface.addRef();
                }
                out.surface = surface;
                return D3D_OK;
            },

            /** @param {number} stage @param {number} type @param {number} value */
            SetTextureStageState(stage, type, value){
                if (stage < 0 || stage >= STAGE_COUNT || type < 1 || type > D3DTSS_MAX
                    || type === D3DTSS.ADDRESSW - 13)
                {
                    return DDERR_INVALIDPARAMS;
                }
                const states = stageStatesFor(stage);
                if (!states.has(type))
                {
                    return DDERR_INVALIDPARAMS;
                }
                const stored = FILTER_NUMBERING[type]?.stored(value >>> 0) ?? value >>> 0;
                states.set(type, stored);
                record('stageStates', (stage << 8) | type, stored);
                return D3D_OK;
            },

            /** @param {number} stage @param {number} type @param {{ value?: number }} out */
            GetTextureStageState(stage, type, out){
                if (stage < 0 || stage >= STAGE_COUNT || type < 1 || type > D3DTSS_MAX)
                {
                    return DDERR_INVALIDPARAMS;
                }
                const states = stageStatesFor(stage);
                if (!states.has(type))
                {
                    return DDERR_INVALIDPARAMS;
                }
                const stored = /** @type {number} */ (states.get(type));
                out.value = FILTER_NUMBERING[type]?.read(stored) ?? stored;
                return D3D_OK;
            },

            /**
             * One pass when the combiner draws the cascade.
             *
             * @param {{ passes?: number }} out  Written only on success.
             */
            ValidateDevice(out){
                const hr = validateStages(stageStatesFor, STAGE_COUNT);
                if (hr === D3D_OK)
                {
                    out.passes = 1;
                }
                return hr;
            },

            PreLoad(){
                return D3D_OK;
            },

            /** @param {{ flags: number, status: number, extents: number[] }} status */
            SetClipStatus(status){
                clipStatus = { ...status, extents: [...status.extents] };
                return D3D_OK;
            },

            /** @param {{ status?: any }} out */
            GetClipStatus(out){
                out.status = { ...clipStatus, extents: [...clipStatus.extents] };
                return D3D_OK;
            },

            /** @param {number} index @param {number[]} plane */
            SetClipPlane(index, plane){
                if (index < 0 || index >= 32 || !plane || plane.length !== 4)
                {
                    return DDERR_INVALIDPARAMS;
                }
                clipPlanes.set(index, [...plane]);
                return D3D_OK;
            },

            /**
             * What ProcessVertices reads of this device.
             *
             * @returns {import('./process.js').ProcessingState}
             */
            processingState(){
                return {
                    transform: type=>transforms.get(type) ?? IDENTITY,
                    viewport: viewport.rect,
                    renderState: state=>renderStates.get(state) ?? 0,
                    lights: [...lights.values()].filter(entry=>entry.enabled)
                        .map(entry=>entry.light),
                    material,
                };
            },

            /**
             * Where each sphere lies against the six sides of the view volume
             * and the user clip planes enabled, as D3DSTATUS bits: a plane the
             * sphere crosses or lies beyond sets its union bit (D3DCLIP_*), and
             * one it lies wholly beyond its intersection bit too, twelve places
             * up. The volume's sides come out of world, view and projection
             * together, a user plane out of the world transform alone.
             *
             * @param {readonly number[][]} centers @param {readonly number[]} radii
             * @param {{ results?: number[] }} out
             */
            ComputeSphereVisibility(centers, radii, out){
                const world = transforms.get(transformStateOf(D3DTRANSFORMSTATE.WORLD) ?? 0)
                    ?? IDENTITY;
                const all = multiplyMatrices(multiplyMatrices(world,
                    transforms.get(D3DTRANSFORMSTATE.VIEW) ?? IDENTITY),
                transforms.get(D3DTRANSFORMSTATE.PROJECTION) ?? IDENTITY);
                /** @param {ArrayLike<number>} m @param {number} c */
                const column = (m, c)=>[m[c], m[4 + c], m[8 + c], m[12 + c]];
                /** @param {number[]} a @param {number[]} b @param {number} sign */
                const combine = (a, b, sign)=>a.map((value, k)=>value + sign * b[k]);
                const [x, y, z, w] = [0, 1, 2, 3].map(c=>column(all, c));
                // Left, right, top, bottom, front, back: D3DCLIP_LEFT up to _BACK.
                /** @type {(number[] | null)[]} */
                const planes = [
                    combine(w, x, 1), combine(w, x, -1), combine(w, y, -1), combine(w, y, 1),
                    z, combine(w, z, -1),
                ];
                const enabled = renderStates.get(D3DRENDERSTATE_CLIPPLANEENABLE) ?? 0;
                for (let index = 0; index < USER_CLIP_PLANES; index++)
                {
                    if ((enabled & (1 << index)) !== 0)
                    {
                        // A plane in world space tests a point in model space
                        // as the world matrix times the plane.
                        const p = clipPlanes.get(index) ?? [0, 0, 0, 0];
                        planes.push([0, 1, 2, 3].map(row=>world[row * 4] * p[0]
                            + world[row * 4 + 1] * p[1] + world[row * 4 + 2] * p[2]
                            + world[row * 4 + 3] * p[3]));
                    }
                    else
                    {
                        planes.push(null);
                    }
                }
                out.results = centers.map((center, sphere)=>{
                    const radius = radii[sphere];
                    let result = 0;
                    planes.forEach((plane, bit)=>{
                        if (!plane)
                        {
                            return;
                        }
                        const length = Math.hypot(plane[0], plane[1], plane[2]) || 1;
                        const distance = (plane[0] * center[0] + plane[1] * center[1]
                            + plane[2] * center[2] + plane[3]) / length;
                        if (distance < -radius)
                        {
                            result |= (1 << bit) | (1 << (bit + 12));
                        }
                        else if (distance < radius)
                        {
                            result |= 1 << bit;
                        }
                    });
                    return result >>> 0;
                });
                return D3D_OK;
            },

            /** @param {number} index @param {{ plane?: number[] }} out */
            GetClipPlane(index, out){
                if (index < 0 || index >= 32)
                {
                    return DDERR_INVALIDPARAMS;
                }
                out.plane = [...(clipPlanes.get(index) ?? [0, 0, 0, 0])];
                return D3D_OK;
            },

            // --- state blocks ---

            BeginStateBlock(){
                if (recording)
                {
                    return D3DERR_INBEGINSTATEBLOCK;
                }
                recording = emptyBlock();
                return D3D_OK;
            },

            /** @param {{ handle?: number }} out */
            EndStateBlock(out){
                if (!recording)
                {
                    return D3DERR_NOTINBEGINSTATEBLOCK;
                }
                const handle = nextBlock++;
                stateBlocks.set(handle, recording);
                recording = null;
                out.handle = handle;
                return D3D_OK;
            },

            /** @param {number} handle */
            ApplyStateBlock(handle){
                const block = stateBlocks.get(handle);
                if (!block)
                {
                    return D3DERR_INVALIDSTATEBLOCK;
                }
                applyBlock(block);
                return D3D_OK;
            },

            /**
             * The block's states take their current values; which states it
             * holds does not change.
             *
             * @param {number} handle
             */
            CaptureStateBlock(handle){
                const block = stateBlocks.get(handle);
                if (!block)
                {
                    return D3DERR_INVALIDSTATEBLOCK;
                }
                for (const state of block.renderStates.keys())
                {
                    block.renderStates.set(state, renderStates.get(state) ?? 0);
                }
                for (const key of block.stageStates.keys())
                {
                    block.stageStates.set(key, stageStatesFor(key >>> 8).get(key & 0xff) ?? 0);
                }
                for (const type of block.transforms.keys())
                {
                    block.transforms.set(type, Float32Array.from(transforms.get(type) ?? IDENTITY));
                }
                return D3D_OK;
            },

            /** @param {number} handle */
            DeleteStateBlock(handle){
                return stateBlocks.delete(handle) ? D3D_OK : D3DERR_INVALIDSTATEBLOCK;
            },

            /**
             * A block of every state of one kind, captured as it stands now.
             * Pixel state is the render and stage states, vertex state the
             * transforms; all is both.
             *
             * @param {number} type D3DSBT
             * @param {{ handle?: number }} out
             */
            CreateStateBlock(type, out){
                if (!/** @type {number[]} */ (Object.values(D3DSBT)).includes(type))
                {
                    return DDERR_INVALIDPARAMS;
                }
                const block = emptyBlock();
                if (type !== D3DSBT.VERTEXSTATE)
                {
                    for (const [state, value] of renderStates)
                    {
                        block.renderStates.set(state, value);
                    }
                    for (let stage = 0; stage < STAGE_COUNT; stage++)
                    {
                        for (const [tss, value] of stageStatesFor(stage))
                        {
                            block.stageStates.set((stage << 8) | tss, value);
                        }
                    }
                }
                if (type !== D3DSBT.PIXELSTATE)
                {
                    for (const [key, matrix] of transforms)
                    {
                        block.transforms.set(key, Float32Array.from(matrix));
                    }
                }
                const handle = nextBlock++;
                stateBlocks.set(handle, block);
                out.handle = handle;
                return D3D_OK;
            },

            // --- drawing ---

            /**
             * Vertices by pointer: the bytes, as the seam read them.
             *
             * @param {number} type
             * @param {number} fvf
             * @param {Uint8Array} vertices
             * @param {number} vertexCount
             */
            DrawPrimitive(type, fvf, vertices, vertexCount){
                const primitiveCount = primitiveCountOf(type, vertexCount);
                const hr = drawPreconditions(type, fvf, primitiveCount, vertexCount);
                if (hr !== D3D_OK || vertexCount === 0)
                {
                    return hr;
                }
                const stride = decodeFvf(fvf).stride;
                if (!vertices || vertices.byteLength < vertexCount * stride)
                {
                    return DDERR_INVALIDPARAMS;
                }
                drawFvf = fvf;
                renderer?.drawPrimitiveUp(model, type, primitiveCount, vertices, stride);
                return D3D_OK;
            },

            /**
             * @param {number} type
             * @param {number} fvf
             * @param {Uint8Array} vertices
             * @param {number} vertexCount
             * @param {Uint8Array} indices  16-bit, as D3D7's are.
             * @param {number} indexCount
             */
            DrawIndexedPrimitive(type, fvf, vertices, vertexCount, indices, indexCount){
                const primitiveCount = primitiveCountOf(type, indexCount);
                const hr = drawPreconditions(type, fvf, primitiveCount, indexCount);
                if (hr !== D3D_OK || indexCount === 0)
                {
                    return hr;
                }
                const stride = decodeFvf(fvf).stride;
                if (!vertices || !indices || vertices.byteLength < vertexCount * stride
                    || indices.byteLength < indexCount * 2)
                {
                    return DDERR_INVALIDPARAMS;
                }
                drawFvf = fvf;
                renderer?.drawIndexedPrimitiveUp(model, type, vertexCount, primitiveCount,
                    indices, D3DFMT_INDEX.INDEX16, vertices, stride);
                return D3D_OK;
            },

            /**
             * @param {number} type
             * @param {any} buffer   A vertex buffer this object made.
             * @param {number} startVertex
             * @param {number} vertexCount
             */
            DrawPrimitiveVB(type, buffer, startVertex, vertexCount){
                const primitiveCount = primitiveCountOf(type, vertexCount);
                const hr = buffer
                    ? drawPreconditions(type, buffer.fvf, primitiveCount, vertexCount)
                    : DDERR_INVALIDPARAMS;
                if (hr !== D3D_OK || vertexCount === 0)
                {
                    return hr;
                }
                if (buffer.locked || startVertex + vertexCount > buffer.numVertices)
                {
                    return DDERR_INVALIDPARAMS;
                }
                drawFvf = buffer.fvf;
                stream.buffer = buffer;
                stream.stride = buffer.stride;
                renderer?.drawPrimitive(model, type, startVertex, primitiveCount);
                return D3D_OK;
            },

            /**
             * Indices by pointer and vertices in a buffer. The indices are the
             * program's array, read through the scratch record whose address
             * is set to it for the duration of the lock.
             *
             * @param {number} type
             * @param {any} buffer
             * @param {number} startVertex
             * @param {number} vertexCount
             * @param {number} indexAddress  Guest address of the 16-bit indices.
             * @param {number} indexCount
             */
            DrawIndexedPrimitiveVB(
                type, buffer, startVertex, vertexCount, indexAddress, indexCount,
            )
            {
                const primitiveCount = primitiveCountOf(type, indexCount);
                const hr = buffer
                    ? drawPreconditions(type, buffer.fvf, primitiveCount, indexCount)
                    : DDERR_INVALIDPARAMS;
                if (hr !== D3D_OK || indexCount === 0)
                {
                    return hr;
                }
                if (buffer.locked || (indexAddress >>> 0) === 0
                    || startVertex + vertexCount > buffer.numVertices)
                {
                    return DDERR_INVALIDPARAMS;
                }
                drawFvf = buffer.fvf;
                stream.buffer = buffer;
                stream.stride = buffer.stride;
                baseVertexIndex = startVertex;
                if (renderer)
                {
                    if (indexCount * 2 > indexScratch.length)
                    {
                        indexScratch.length = indexCount * 2;
                    }
                    indexScratch.base = indexAddress >>> 0;
                    renderer.lockBuffer(indexScratch, 0, indexCount * 2, D3DLOCK.DISCARD);
                    renderer.unlockBuffer(indexScratch);
                    renderer.drawIndexedPrimitive(model, type, 0, primitiveCount);
                }
                return D3D_OK;
            },

            /**
             * Shows the texture drawn at an address. Called by the presenter
             * when a DirectDraw flip or blit puts that address on the screen.
             *
             * @param {number} buffer
             * @returns {Promise<void> | undefined} settled once the frame is on the queue
             */
            present(buffer){
                presenting = buffer;
                return renderer?.present(model);
            },

            // What DirectDraw tells the device of its surfaces, as calls: what
            // a device drawn elsewhere is told the same things through.
            /** @param {number} buffer */
            Present: buffer=>device.present(buffer),
            DepthFilled: depthFilled,
            ReadBack: readBack,
            PixelsWritten: written,

            /** Settled when every presented frame has reached the backend. */
            idle(){
                return renderer ? renderer.idle() : Promise.resolve();
            },

            diagnostics(){
                return renderer ? renderer.diagnostics() : null;
            },
        };

        return device;
    }
}

/** A state block with nothing in it yet. */
function emptyBlock(){
    return {
        /** @type {Map<number, number>} */
        renderStates: new Map(),
        /** @type {Map<number, number>} */
        stageStates: new Map(),
        /** @type {Map<number, Float32Array>} */
        transforms: new Map(),
    };
}

/**
 * The depth buffer attached to a target, if one is.
 *
 * @param {any} surface
 * @returns {any | null}
 */
function attachedDepth(surface){
    const found = surface.getAttachedSurface(DDSCAPS_ZBUFFER);
    if (found.hr !== D3D_OK || !found.surface)
    {
        return null;
    }
    // The walk took a reference this layer does not keep.
    found.surface.release();
    return found.surface;
}
