/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D 9 device as a program observes it between draws.
 *
 * Nothing here draws. What it models is everything a program can find out about
 * a device without one: whether a scene is open, what a state reads back as,
 * what a resource costs in references, and whether the device is still usable.
 * All of it is what a title checks on startup and between frames, and all of it
 * is wrong in a way that is invisible until much later if it is guessed at.
 *
 * Three conventions run through the whole file:
 *
 * - **A method returns an HRESULT.** Anything else it produces is written into
 *   a record the caller supplies, the way the guest passes a pointer. That is
 *   not decoration: a failed call must leave that record alone, programs read
 *   it back without checking, and a model that returns values instead cannot
 *   express the difference.
 * - **Reference counting is the object model's, spelled `addRef`/`release`.**
 *   The Direct3D names stay on the Direct3D methods.
 * - **What loses a device is not this file's business.** The state machine is
 *   real and is driven by an injected signal, because in a browser the causes
 *   -- a lost adapter, a context taken away, a resize -- belong to the backend
 *   and are not decided here.
 */

import {
    D3DERR_DEVICELOST, D3DERR_DEVICENOTRESET, D3DERR_INVALIDCALL, D3DERR_NOTFOUND, D3DFMT,
    D3DLIGHTTYPE, D3DPOOL, D3DRTYPE, D3DUSAGE, D3D_OK, FORMAT_INFO,
} from './constants.js';
import { createDefaultRenderStates } from './renderstates.js';
import { createReferenceCount, createSurface, createTexture } from './resources.js';
import { SURFACE_TYPE, reportedBackBufferCount, validatePresentParameters } from './validity.js';

/** The three states a device is ever in, as far as a program can tell. */
export const DEVICE_STATE = Object.freeze({
    OK: 'ok',
    LOST: 'lost',
    NOT_RESET: 'notreset',
});

/**
 * The value a light's enable flag reads back as once it has been enabled. Not
 * one: the flag is written as a boolean and read back as this.
 */
export const LIGHT_ENABLED = 128;

/**
 * @typedef {Object} DeviceCaps
 * @property {number} maxPointSize     Decides the POINTSIZE_MAX default.
 * @property {boolean} depthTexture2d  Whether depth formats are usable as textures,
 * @property {boolean} depthCube       as cube maps,
 * @property {boolean} depthPlain      and as offscreen plain surfaces.
 */

/** @type {DeviceCaps} */
export const DEFAULT_CAPS = Object.freeze({
    maxPointSize: 64.0,
    depthTexture2d: false,
    depthCube: false,
    depthPlain: false,
});

/**
 * @typedef {Object} Light
 * @property {number} Type
 * @property {{ r: number, g: number, b: number, a: number }} Diffuse
 * @property {{ r: number, g: number, b: number, a: number }} Specular
 * @property {{ r: number, g: number, b: number, a: number }} Ambient
 * @property {{ x: number, y: number, z: number }} Position
 * @property {{ x: number, y: number, z: number }} Direction
 * @property {number} Range
 * @property {number} Falloff
 * @property {number} Attenuation0
 * @property {number} Attenuation1
 * @property {number} Attenuation2
 * @property {number} Theta
 * @property {number} Phi
 */

/**
 * What a light holds before anything has been written into it -- which is not
 * what an unwritten light reads back as. There is no such thing: reading a
 * light index that was never written fails. This is the record enabling one
 * brings into existence.
 *
 * @returns {Light}
 */
function defaultLight(){
    return {
        Type: D3DLIGHTTYPE.DIRECTIONAL,
        Diffuse: { r: 1.0, g: 1.0, b: 1.0, a: 0.0 },
        Specular: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
        Ambient: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
        Position: { x: 0.0, y: 0.0, z: 0.0 },
        Direction: { x: 0.0, y: 0.0, z: 1.0 },
        Range: 0.0,
        Falloff: 0.0,
        Attenuation0: 0.0,
        Attenuation1: 0.0,
        Attenuation2: 0.0,
        Theta: 0.0,
        Phi: 0.0,
    };
}

/**
 * @param {import("./validity.js").PresentParameters} parameters
 * @returns {import("./validity.js").PresentParameters}
 */
function normalisePresentParameters(parameters){
    return {
        swapEffect: parameters.swapEffect,
        backBufferCount: reportedBackBufferCount(parameters),
        windowed: parameters.windowed ?? true,
        backBufferWidth: parameters.backBufferWidth ?? 640,
        backBufferHeight: parameters.backBufferHeight ?? 480,
        backBufferFormat: parameters.backBufferFormat ?? D3DFMT.X8R8G8B8,
        enableAutoDepthStencil: parameters.enableAutoDepthStencil ?? false,
        autoDepthStencilFormat: parameters.autoDepthStencilFormat ?? D3DFMT.D24S8,
    };
}

/**
 * The object a program gets from Direct3DCreate9. It exists here for one
 * reason: device creation can fail on its parameters, and the caller has to be
 * able to see that failure without already holding a device.
 *
 * @param {Partial<DeviceCaps>} [caps]
 */
export function createDirect3D9(caps = {}){
    /** @type {DeviceCaps} */
    const resolved = { ...DEFAULT_CAPS, ...caps };
    return {
        caps: resolved,

        /**
         * @param {import("./validity.js").PresentParameters} parameters
         * @param {{ device?: ReturnType<typeof createDeviceObject> }} out
         * @returns {number}
         */
        CreateDevice(parameters, out){
            const hr = validatePresentParameters(parameters);
            if (hr !== D3D_OK)
            {
                return hr;
            }
            out.device = createDeviceObject(normalisePresentParameters(parameters), resolved);
            return D3D_OK;
        },
    };
}

/**
 * @param {import("./validity.js").PresentParameters} parameters
 * @param {DeviceCaps} caps
 */
function createDeviceObject(parameters, caps){
    let presentParameters = parameters;
    /** @type {string} */
    let deviceState = DEVICE_STATE.OK;
    let inScene = false;
    let nextAddress = 0x40000000;

    /** @type {Map<number, number>} */
    let renderStates = createDefaultRenderStates({
        enableAutoDepthStencil: presentParameters.enableAutoDepthStencil === true,
        maxPointSize: caps.maxPointSize,
    });

    /** @type {Map<number, { light: Light, enabled: boolean }>} */
    let lights = new Map();

    /** @type {Map<number, { buffer: any, offset: number, stride: number }>} */
    const streams = new Map();
    /** @type {Map<number, any>} */
    const textures = new Map();
    /** @type {Map<number, any>} */
    const renderTargets = new Map();
    /** @type {any} */
    let indices = null;

    const count = createReferenceCount();

    /**
     * Storage addresses are handed out rather than computed, so that two
     * surfaces never overlap and the offset a lock reports means something.
     *
     * @param {number} bytes
     */
    const allocate = bytes=>{
        const address = nextAddress;
        // Aligned generously: a lock's reported pitch is the row stride, and
        // nothing here should ever depend on two surfaces being adjacent.
        nextAddress += Math.max(bytes, 1) + 0x1000;
        return address;
    };

    /** A resource that the program owns: it took a reference on the device. */
    const explicitCount = ()=>{
        count.addRef();
        return createReferenceCount({ onLastRef: ()=>count.release() });
    };

    /** A resource the device owns: its first reference is one on the device. */
    const implicitCount = ()=>createReferenceCount({
        implicit: true,
        onFirstRef: ()=>count.addRef(),
        onLastRef: ()=>count.release(),
    });

    /** @type {any[]} */
    const backBuffers = [];
    for (let index = 0; index < (presentParameters.backBufferCount ?? 1); index++)
    {
        backBuffers.push(createSurface({
            type: SURFACE_TYPE.RENDER_TARGET,
            width: presentParameters.backBufferWidth ?? 640,
            height: presentParameters.backBufferHeight ?? 480,
            format: presentParameters.backBufferFormat ?? D3DFMT.X8R8G8B8,
            pool: D3DPOOL.DEFAULT,
            usage: D3DUSAGE.RENDERTARGET,
            lockable: false,
            base: allocate(0x100000),
            count: implicitCount(),
        }));
    }

    const depthStencil = presentParameters.enableAutoDepthStencil
        ? createSurface({
            type: SURFACE_TYPE.DEPTH_STENCIL,
            width: presentParameters.backBufferWidth ?? 640,
            height: presentParameters.backBufferHeight ?? 480,
            format: presentParameters.autoDepthStencilFormat ?? D3DFMT.D24S8,
            pool: D3DPOOL.DEFAULT,
            usage: D3DUSAGE.DEPTHSTENCIL,
            base: allocate(0x100000),
            count: implicitCount(),
        })
        : null;

    const swapChainCount = implicitCount();
    const swapChain = {
        get refCount(){
            return swapChainCount.value;
        },
        addRef: ()=>swapChainCount.addRef(),
        release: ()=>swapChainCount.release(),

        /**
         * @param {number} index
         * @param {number} _type
         * @param {{ surface?: any }} out
         */
        GetBackBuffer(index, _type, out){
            const surface = backBuffers[index];
            if (!surface)
            {
                return D3DERR_INVALIDCALL;
            }
            surface.addRef();
            out.surface = surface;
            return D3D_OK;
        },

        /** @param {{ parameters?: import("./validity.js").PresentParameters }} out */
        GetPresentParameters(out){
            out.parameters = { ...presentParameters };
            return D3D_OK;
        },
    };

    renderTargets.set(0, backBuffers[0]);

    /** @param {number} index */
    const stream = index=>{
        const existing = streams.get(index);
        if (existing)
        {
            return existing;
        }
        const record = { buffer: null, offset: 0, stride: 0 };
        streams.set(index, record);
        return record;
    };

    /**
     * @param {{ length: number, usage: number, pool: number, type: number }} options
     */
    const createBuffer = options=>{
        const bufferCount = explicitCount();
        return {
            ...options,
            get refCount(){
                return bufferCount.value;
            },
            addRef: ()=>bufferCount.addRef(),
            release: ()=>bufferCount.release(),
        };
    };

    const device = {
        caps,
        get refCount(){
            return count.value;
        },
        addRef: ()=>count.addRef(),
        release: ()=>count.release(),

        /** The state machine's only input, and deliberately not a D3D method. */
        injectDeviceLoss(restorable = false){
            deviceState = restorable ? DEVICE_STATE.NOT_RESET : DEVICE_STATE.LOST;
        },

        get deviceState(){
            return deviceState;
        },

        TestCooperativeLevel(){
            if (deviceState === DEVICE_STATE.LOST)
            {
                return D3DERR_DEVICELOST;
            }
            if (deviceState === DEVICE_STATE.NOT_RESET)
            {
                return D3DERR_DEVICENOTRESET;
            }
            return D3D_OK;
        },

        /**
         * A device that can be reset still cannot present: the two answers
         * differ, and a program that resets on the strength of Present alone
         * never learns that the device came back.
         */
        Present(){
            return deviceState === DEVICE_STATE.OK ? D3D_OK : D3DERR_DEVICELOST;
        },

        BeginScene(){
            if (inScene)
            {
                // The nested call fails without opening anything, so the scene
                // is still one deep and the next EndScene closes it. A counter
                // incremented here would leave the scene open for ever.
                return D3DERR_INVALIDCALL;
            }
            inScene = true;
            return D3D_OK;
        },

        EndScene(){
            if (!inScene)
            {
                return D3DERR_INVALIDCALL;
            }
            inScene = false;
            return D3D_OK;
        },

        get inScene(){
            return inScene;
        },

        /**
         * Reset puts the device back to what it was created as: no scene open,
         * default state, usable again. A device that is lost beyond recovery
         * refuses.
         *
         * @param {import("./validity.js").PresentParameters} [next]
         */
        Reset(next){
            if (deviceState === DEVICE_STATE.LOST)
            {
                return D3DERR_DEVICELOST;
            }
            if (next)
            {
                const hr = validatePresentParameters(next);
                if (hr !== D3D_OK)
                {
                    return hr;
                }
                presentParameters = normalisePresentParameters(next);
            }
            inScene = false;
            deviceState = DEVICE_STATE.OK;
            renderStates = createDefaultRenderStates({
                enableAutoDepthStencil: presentParameters.enableAutoDepthStencil === true,
                maxPointSize: caps.maxPointSize,
            });
            lights = new Map();
            return D3D_OK;
        },

        /**
         * @param {number} state
         * @param {number} value
         */
        SetRenderState(state, value){
            if (!renderStates.has(state))
            {
                return D3DERR_INVALIDCALL;
            }
            renderStates.set(state, value >>> 0);
            return D3D_OK;
        },

        /**
         * @param {number} state
         * @param {{ value?: number }} out
         */
        GetRenderState(state, out){
            if (!renderStates.has(state))
            {
                return D3DERR_INVALIDCALL;
            }
            out.value = renderStates.get(state);
            return D3D_OK;
        },

        /**
         * @param {number} index
         * @param {Light} light
         */
        SetLight(index, light){
            const existing = lights.get(index);
            lights.set(index, { light: { ...light }, enabled: existing?.enabled ?? false });
            return D3D_OK;
        },

        /**
         * @param {number} index
         * @param {{ light?: Light }} out
         *        Untouched when the index was never written: there is no default
         *        to report, and inventing one hides the failure.
         */
        GetLight(index, out){
            const record = lights.get(index);
            if (!record)
            {
                return D3DERR_INVALIDCALL;
            }
            out.light = { ...record.light };
            return D3D_OK;
        },

        /**
         * Enabling an index that was never written brings a light into
         * existence, so the read that follows succeeds.
         *
         * @param {number} index
         * @param {boolean} enable
         */
        LightEnable(index, enable){
            const record = lights.get(index) ?? { light: defaultLight(), enabled: false };
            record.enabled = enable === true;
            lights.set(index, record);
            return D3D_OK;
        },

        /**
         * @param {number} index
         * @param {{ enabled?: number }} out
         */
        GetLightEnable(index, out){
            const record = lights.get(index);
            if (!record)
            {
                return D3DERR_INVALIDCALL;
            }
            out.enabled = record.enabled ? LIGHT_ENABLED : 0;
            return D3D_OK;
        },

        /**
         * @param {number} stage
         * @param {any} texture
         */
        SetTexture(stage, texture){
            if (texture)
            {
                textures.set(stage, texture);
            }
            else
            {
                textures.delete(stage);
            }
            return D3D_OK;
        },

        /**
         * @param {number} stage
         * @param {{ texture?: any }} out
         */
        GetTexture(stage, out){
            const texture = textures.get(stage) ?? null;
            if (texture)
            {
                texture.addRef();
            }
            out.texture = texture;
            return D3D_OK;
        },

        /** @param {any} buffer */
        SetIndices(buffer){
            indices = buffer ?? null;
            return D3D_OK;
        },

        /** @param {{ buffer?: any }} out */
        GetIndices(out){
            if (indices)
            {
                indices.addRef();
            }
            out.buffer = indices;
            return D3D_OK;
        },

        /**
         * Unbinding leaves the stride and offset where they were. That is not
         * tidiness lost: a program reads them back after unbinding and expects
         * the previous values, so clearing the whole record is a defect.
         *
         * @param {number} index
         * @param {any} buffer
         * @param {number} offset
         * @param {number} stride
         */
        SetStreamSource(index, buffer, offset, stride){
            const record = stream(index);
            record.buffer = buffer ?? null;
            if (buffer)
            {
                record.offset = offset;
                record.stride = stride;
            }
            return D3D_OK;
        },

        /**
         * @param {number} index
         * @param {{ buffer?: any, offset?: number, stride?: number }} out
         */
        GetStreamSource(index, out){
            const record = stream(index);
            if (record.buffer)
            {
                record.buffer.addRef();
            }
            out.buffer = record.buffer;
            out.offset = record.offset;
            out.stride = record.stride;
            return D3D_OK;
        },

        /**
         * @param {number} index
         * @param {any} surface
         */
        SetRenderTarget(index, surface){
            if (!surface && index === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            if (surface)
            {
                renderTargets.set(index, surface);
            }
            else
            {
                renderTargets.delete(index);
            }
            return D3D_OK;
        },

        /**
         * @param {number} index
         * @param {{ surface?: any }} out
         */
        GetRenderTarget(index, out){
            const surface = renderTargets.get(index);
            if (!surface)
            {
                return D3DERR_NOTFOUND;
            }
            surface.addRef();
            out.surface = surface;
            return D3D_OK;
        },

        /**
         * @param {number} swapChainIndex
         * @param {number} backBufferIndex
         * @param {number} type
         * @param {{ surface?: any }} out
         */
        GetBackBuffer(swapChainIndex, backBufferIndex, type, out){
            if (swapChainIndex !== 0)
            {
                return D3DERR_INVALIDCALL;
            }
            return swapChain.GetBackBuffer(backBufferIndex, type, out);
        },

        /** @param {{ surface?: any }} out */
        GetDepthStencilSurface(out){
            if (!depthStencil)
            {
                // The caller's pointer is cleared, not left alone. Programs pass
                // a variable that already holds a live surface and then test it
                // rather than the HRESULT, so leaving it stale hands them a
                // pointer they go on to release.
                out.surface = null;
                return D3DERR_NOTFOUND;
            }
            depthStencil.addRef();
            out.surface = depthStencil;
            return D3D_OK;
        },

        /**
         * @param {number} index
         * @param {{ swapChain?: any }} out
         */
        GetSwapChain(index, out){
            if (index !== 0)
            {
                return D3DERR_INVALIDCALL;
            }
            swapChain.addRef();
            out.swapChain = swapChain;
            return D3D_OK;
        },

        /**
         * @param {number} width
         * @param {number} height
         * @param {number} levels
         * @param {number} usage
         * @param {number} format
         * @param {number} pool
         * @param {{ texture?: any }} out
         */
        CreateTexture(width, height, levels, usage, format, pool, out){
            const hr = checkTextureArguments(usage, format, pool, caps, false);
            if (hr !== D3D_OK)
            {
                return hr;
            }
            out.texture = createTexture({
                width,
                height,
                levels: levels || 1,
                format,
                pool,
                usage,
                count: explicitCount(),
                allocate,
            });
            return D3D_OK;
        },

        /**
         * @param {number} edgeLength
         * @param {number} levels
         * @param {number} usage
         * @param {number} format
         * @param {number} pool
         * @param {{ texture?: any }} out
         */
        CreateCubeTexture(edgeLength, levels, usage, format, pool, out){
            const hr = checkTextureArguments(usage, format, pool, caps, true);
            if (hr !== D3D_OK)
            {
                return hr;
            }
            out.texture = createTexture({
                width: edgeLength,
                height: edgeLength,
                levels: levels || 1,
                format,
                pool,
                usage,
                count: explicitCount(),
                allocate,
                cube: true,
            });
            return D3D_OK;
        },

        /**
         * @param {number} width
         * @param {number} height
         * @param {number} format
         * @param {boolean} lockable
         * @param {{ surface?: any }} out
         */
        CreateRenderTarget(width, height, format, lockable, out){
            const info = FORMAT_INFO[format];
            if (!info || info.depth)
            {
                return D3DERR_INVALIDCALL;
            }
            out.surface = createSurface({
                type: SURFACE_TYPE.RENDER_TARGET,
                width,
                height,
                format,
                pool: D3DPOOL.DEFAULT,
                usage: D3DUSAGE.RENDERTARGET,
                lockable,
                base: allocate(width * height * info.bytesPerPixel),
                count: explicitCount(),
            });
            return D3D_OK;
        },

        /**
         * @param {number} width
         * @param {number} height
         * @param {number} format
         * @param {{ surface?: any }} out
         */
        CreateDepthStencilSurface(width, height, format, out){
            const info = FORMAT_INFO[format];
            if (!info || !info.depth)
            {
                return D3DERR_INVALIDCALL;
            }
            out.surface = createSurface({
                type: SURFACE_TYPE.DEPTH_STENCIL,
                width,
                height,
                format,
                pool: D3DPOOL.DEFAULT,
                usage: D3DUSAGE.DEPTHSTENCIL,
                base: allocate(width * height * info.bytesPerPixel),
                count: explicitCount(),
            });
            return D3D_OK;
        },

        /**
         * @param {number} width
         * @param {number} height
         * @param {number} format
         * @param {number} pool
         * @param {{ surface?: any }} out
         */
        CreateOffscreenPlainSurface(width, height, format, pool, out){
            const info = FORMAT_INFO[format];
            if (!info || pool === D3DPOOL.MANAGED || (info.depth && !caps.depthPlain))
            {
                return D3DERR_INVALIDCALL;
            }
            out.surface = createSurface({
                type: SURFACE_TYPE.PLAIN,
                width,
                height,
                format,
                pool,
                usage: 0,
                base: allocate(width * height * info.bytesPerPixel),
                count: explicitCount(),
            });
            return D3D_OK;
        },

        /**
         * @param {number} length
         * @param {number} usage
         * @param {number} pool
         * @param {{ buffer?: any }} out
         */
        CreateVertexBuffer(length, usage, pool, out){
            out.buffer = createBuffer({ length, usage, pool, type: D3DRTYPE.VERTEXBUFFER });
            return D3D_OK;
        },

        /**
         * @param {number} length
         * @param {number} usage
         * @param {number} pool
         * @param {{ buffer?: any }} out
         */
        CreateIndexBuffer(length, usage, pool, out){
            out.buffer = createBuffer({ length, usage, pool, type: D3DRTYPE.INDEXBUFFER });
            return D3D_OK;
        },
    };

    return device;
}

/**
 * The pool/usage/format table, applied to the two entry points that take all
 * three. It is the table that decides, not a chain of conditions here.
 *
 * @param {number} usage
 * @param {number} format
 * @param {number} pool
 * @param {DeviceCaps} caps
 * @param {boolean} cube
 * @returns {number}
 */
function checkTextureArguments(usage, format, pool, caps, cube){
    const info = FORMAT_INFO[format];
    if (!info)
    {
        return D3DERR_INVALIDCALL;
    }
    // A write-only texture is a contradiction the API rejects outright.
    if ((usage & D3DUSAGE.WRITEONLY) !== 0)
    {
        return D3DERR_INVALIDCALL;
    }
    const wantsRenderTarget = (usage & D3DUSAGE.RENDERTARGET) !== 0;
    const wantsDepthStencil = (usage & D3DUSAGE.DEPTHSTENCIL) !== 0;
    const dynamic = (usage & D3DUSAGE.DYNAMIC) !== 0;

    if (wantsRenderTarget && (info.depth || dynamic || pool !== D3DPOOL.DEFAULT))
    {
        return D3DERR_INVALIDCALL;
    }
    if (wantsDepthStencil && (!info.depth || dynamic || pool !== D3DPOOL.DEFAULT))
    {
        return D3DERR_INVALIDCALL;
    }
    if (info.depth)
    {
        if (pool !== D3DPOOL.DEFAULT)
        {
            return D3DERR_INVALIDCALL;
        }
        if (!(cube ? caps.depthCube : caps.depthTexture2d))
        {
            return D3DERR_INVALIDCALL;
        }
    }
    return D3D_OK;
}
