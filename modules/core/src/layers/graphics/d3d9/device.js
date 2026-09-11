/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D 9 device.
 *
 * Most of the file models what a program can find out about a device without
 * drawing: whether a scene is open, what a state reads back as, what a resource
 * costs in references, and whether the device is still usable. All of it is
 * what a title checks on startup and between frames, and all of it is wrong in
 * a way that is invisible until much later if it is guessed at.
 *
 * Drawing is optional and is not this file's own. A device built with a backend
 * hands every clear, draw and present to the fixed-function renderer; one built
 * without keeps modelling what the program can observe, so a headless build
 * behaves and a pure-state test needs no GPU double. Either way this file
 * decides whether a call is legal, and only a legal one reaches the renderer.
 *
 * That renderer, and the two constant tables the draw path needs, live under
 * `../d3d8/` today. D3D8 and D3D9 drive one fixed-function pipeline with one
 * set of numbers, and a second copy of either would drift from the first with
 * nothing to say which had gone wrong; where they belong is a shared directory,
 * which is a move rather than a rewrite.
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
    D3DLIGHTTYPE, D3DPOOL, D3DRTYPE, D3DUSAGE, D3D_OK, FORMAT_INFO, isCompressed, surfaceBytes,
} from './constants.js';
import { D3DCLEAR } from '../d3d8/constants.js';
import { IDENTITY, STAGE_COUNT, createRenderer, vertexCountOf } from '../d3d8/render.js';
import { createDefaultStageStates } from '../d3d8/stagestates.js';
import { createDefaultRenderStates } from './renderstates.js';
import { createReferenceCount, createSurface, createTexture } from './resources.js';
import { SURFACE_TYPE, reportedBackBufferCount, validatePresentParameters } from './validity.js';
import { fullTarget, viewportState } from '../webgpu/internal/viewport.js';

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
 * @property {boolean} [compressedTextures]  Whether the backend samples DXT blocks.
 */

/** @type {DeviceCaps} */
export const DEFAULT_CAPS = Object.freeze({
    maxPointSize: 64.0,
    depthTexture2d: false,
    compressedTextures: false,
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
 * @typedef {Object} Material
 * @property {{ r: number, g: number, b: number, a: number }} Diffuse
 * @property {{ r: number, g: number, b: number, a: number }} Ambient
 * @property {{ r: number, g: number, b: number, a: number }} Specular
 * @property {{ r: number, g: number, b: number, a: number }} Emissive
 * @property {number} Power
 */

/**
 * The material a fresh device has: white diffuse and ambient, no highlight and
 * no glow.
 *
 * Not all zeros, which is what an unseeded structure would be and what this
 * used to return. Geometry that never calls SetMaterial and carries no vertex
 * colour takes every term from here, so a black default lights it to black --
 * and the whole model disappears while every state a program can read back
 * still says what it expects. The ambient term costs nothing by default because
 * D3DRS_AMBIENT starts black; it matters the moment a program sets one.
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
 * @typedef {Object} DeviceServices
 *     Everything a device needs from outside itself. All of it is optional, and
 *     a device given none of it draws nothing while still answering every
 *     question about its own state.
 * @property {any} [backend]
 *     What draws. Its absence is what makes a headless build work.
 * @property {(address: number, length: number)=>Uint8Array} [readMemory]
 *     Required alongside a backend: the bytes a draw reads are the guest's.
 * @property {(descriptor: any)=>any} [createSampler]
 * @property {(bytes: number)=>number} [allocate]
 *     Where a resource's storage goes. It has to be memory the guest can write
 *     through, because a lock hands the program this address and the unlock
 *     reads back exactly what it wrote there.
 */

/**
 * The object a program gets from Direct3DCreate9. It exists here for one
 * reason: device creation can fail on its parameters, and the caller has to be
 * able to see that failure without already holding a device.
 *
 * @param {Partial<DeviceCaps> & DeviceServices} [options]
 */
export function createDirect3D9(options = {}){
    const { backend, readMemory, createSampler, allocate: guestMemory, ...caps } = options;
    /** @type {DeviceCaps} */
    const resolved = { ...DEFAULT_CAPS, ...caps };
    /** @type {DeviceServices} */
    const services = { backend, readMemory, createSampler, allocate: guestMemory };
    if (backend && !readMemory)
    {
        throw new Error('graphics/d3d9: a device that draws needs readMemory as well as a backend');
    }
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
            out.device = createDeviceObject(
                normalisePresentParameters(parameters), resolved, services);
            return D3D_OK;
        },
    };
}

/**
 * @param {import("./validity.js").PresentParameters} parameters
 * @param {DeviceCaps} caps
 * @param {DeviceServices} [services]
 */
function createDeviceObject(parameters, caps, services = {}){
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

    /** @type {Map<number, Map<number, number>>} stage -> its states, made on first touch */
    let stageStates = new Map();
    /** @type {Map<number, Float32Array>} D3DTS -> the matrix; absent means identity */
    let transforms = new Map();
    /** The vertex format a fixed-function draw reads its stream with. */
    let fvf = 0;
    /** @type {Material} */
    let material = defaultMaterial();

    /** @type {Map<number, { buffer: any, offset: number, stride: number }>} */
    const streams = new Map();
    /** @type {Map<number, any>} */
    const textures = new Map();
    /** @type {Map<number, any>} */
    const renderTargets = new Map();
    /** @type {any} */
    let indices = null;
    let baseVertexIndex = 0;

    const count = createReferenceCount();

    const renderer = services.backend
        ? createRenderer({
            backend: services.backend,
            readMemory: /** @type {(address: number, length: number)=>Uint8Array} */ (
                services.readMemory),
            createSampler: services.createSampler ?? null,
        })
        : null;

    /**
     * Storage addresses are handed out rather than computed, so that two
     * surfaces never overlap and the offset a lock reports means something.
     *
     * @param {number} bytes
     */
    const allocate = bytes=>{
        // Real guest memory when the assembling caller supplied a way to get
        // some. An address invented here has nothing behind it, so a program
        // that locks, writes and unlocks loses everything it wrote and no call
        // reports a failure.
        if (services.allocate)
        {
            const address = services.allocate(Math.max(bytes, 1));
            if (address !== 0)
            {
                return address;
            }
        }
        const address = nextAddress;
        // Aligned generously: a lock's reported pitch is the row stride, and
        // nothing here should ever depend on two surfaces being adjacent.
        nextAddress += Math.max(bytes, 1) + 0x1000;
        return address;
    };

    /**
     * @param {any} surface
     * @returns {import('./resources.js').SurfaceDesc}
     */
    const describe = surface=>{
        /** @type {{ desc?: any }} */
        const out = {};
        surface.GetDesc(out);
        return out.desc;
    };

    /** @param {number} stage @returns {Map<number, number>} */
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

    const autoDepthStencil = presentParameters.enableAutoDepthStencil
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

    /**
     * What a draw tests and writes depth against, which starts as the automatic
     * one and is a separate binding in this version -- D3D8 changed both
     * targets in one call, D3D9 has one call for each.
     *
     * @type {any}
     */
    let depthStencil = autoDepthStencil;

    /** @type {import('../webgpu/contract.js').ViewportState} */
    let viewport = fullTarget({
        width: presentParameters.backBufferWidth ?? 640,
        height: presentParameters.backBufferHeight ?? 480,
    });

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
     * A vertex or index buffer. Its storage is guest memory at `base`, which is
     * what a lock hands back; the renderer reads the locked range from there on
     * unlock, under the flags the lock was taken with.
     *
     * @param {{ length: number, usage: number, pool: number, type: number, fvf?: number,
     *           format?: number }} options
     */
    const createBuffer = options=>{
        const bufferCount = explicitCount();
        const base = allocate(options.length);
        let locked = false;
        const buffer = {
            ...options,
            base,
            get refCount(){
                return bufferCount.value;
            },
            addRef: ()=>bufferCount.addRef(),
            release: ()=>bufferCount.release(),

            /**
             * A size of zero means "to the end", which is the only way a
             * program asks for the whole buffer.
             *
             * @param {number} offset
             * @param {number} size
             * @param {{ pBits?: number }} out
             *        Left alone when the lock fails: callers read it back
             *        unconditionally and would otherwise write through an
             *        address the failed call invented.
             * @param {number} [flags] D3DLOCK
             */
            Lock(offset, size, out, flags = 0){
                const length = size === 0 ? options.length - offset : size;
                if (locked || offset < 0 || !(length > 0) || offset + length > options.length)
                {
                    return D3DERR_INVALIDCALL;
                }
                locked = true;
                out.pBits = base + offset;
                renderer?.lockBuffer(buffer, offset, length, flags);
                return D3D_OK;
            },

            Unlock(){
                if (!locked)
                {
                    return D3DERR_INVALIDCALL;
                }
                locked = false;
                renderer?.unlockBuffer(buffer);
                return D3D_OK;
            },
        };
        return buffer;
    };

    /**
     * What the renderer reads at the moment of a draw. Live views, so that a
     * state set after this object was made is the state a later draw sees.
     *
     * @type {import('../d3d8/render.js').RenderModel}
     */
    const model = {
        get renderStates(){
            return renderStates;
        },
        stageStates: stageStatesFor,
        textures,
        get stream(){
            return stream(0);
        },
        get indices(){
            return indices;
        },
        get baseVertexIndex(){
            return baseVertexIndex;
        },
        get viewport(){
            return viewport;
        },
        get renderTarget(){
            return renderTargets.get(0);
        },
        get depthStencil(){
            return depthStencil;
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
            return backBuffers[0];
        },
        get stageProcessing(){
            return device.stageProcessing;
        },
    };

    /**
     * What every draw is refused for before its own arguments are looked at.
     *
     * @param {number} type
     * @param {number} primitiveCount
     * @returns {number} D3D_OK, or the refusal
     */
    const drawPreconditions = (type, primitiveCount)=>{
        // The three position bits. A vertex format without one is not a format,
        // and this build has no shader to draw without it.
        if (!inScene || vertexCountOf(type, primitiveCount) === 0 || (fvf & 0xe) === 0)
        {
            return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    /**
     * How many vertices into its buffer stream zero starts.
     *
     * D3D9's stream binding carries a byte offset D3D8's does not, and the
     * renderer reads a stream from its beginning -- so the offset is folded
     * into the first vertex instead, which is exact whenever it divides by the
     * stride. An offset that does not divide describes a vertex straddling the
     * stride, which is not a stream a fixed-function draw can read at all.
     *
     * @returns {number | null} null when the binding is unusable
     */
    const streamBias = ()=>{
        const source = stream(0);
        if (!source.buffer || !(source.stride > 0) || source.offset % source.stride !== 0)
        {
            return null;
        }
        return source.offset / source.stride;
    };

    /**
     * The user-pointer draws leave stream zero and the index binding empty: the
     * data they drew came from neither, and a program that draws from a buffer
     * afterwards has to bind it again.
     */
    const unbindStreamZero = ()=>{
        stream(0).buffer = null;
        indices = null;
        baseVertexIndex = 0;
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
            if (deviceState !== DEVICE_STATE.OK)
            {
                return D3DERR_DEVICELOST;
            }
            renderer?.present(model);
            return D3D_OK;
        },

        /**
         * Settled when every frame presented so far has reached the backend.
         * Present answers the program before that happens, so this is how a
         * test -- or a caller that can park the program -- waits for pixels.
         *
         * @returns {Promise<void>}
         */
        idle(){
            return renderer ? renderer.idle() : Promise.resolve();
        },

        /** What the renderer has done and declined to do. Null without a backend. */
        diagnostics(){
            return renderer ? renderer.diagnostics() : null;
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
            stageStates = new Map();
            transforms = new Map();
            material = defaultMaterial();
            renderTargets.set(0, backBuffers[0]);
            depthStencil = autoDepthStencil;
            // The viewport follows the target rather than surviving the reset:
            // one left over from a larger frame puts every pre-transformed
            // vertex somewhere other than the pixel it names. It is taken from
            // the surface and not from the new presentation parameters because
            // this device does not rebuild its implicit resources yet, and a
            // viewport wider than the surface it covers is not a viewport.
            const target = describe(backBuffers[0]);
            viewport = fullTarget({ width: target.Width, height: target.Height });
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

        /**
         * @param {number} stage
         * @param {number} type   D3DTSS
         * @param {number} value
         */
        SetTextureStageState(stage, type, value){
            if (stage < 0 || stage >= STAGE_COUNT)
            {
                return D3DERR_INVALIDCALL;
            }
            const states = stageStatesFor(stage);
            if (!states.has(type))
            {
                return D3DERR_INVALIDCALL;
            }
            states.set(type, value >>> 0);
            return D3D_OK;
        },

        /**
         * @param {number} stage
         * @param {number} type   D3DTSS
         * @param {{ value?: number }} out
         */
        GetTextureStageState(stage, type, out){
            if (stage < 0 || stage >= STAGE_COUNT)
            {
                return D3DERR_INVALIDCALL;
            }
            const states = stageStatesFor(stage);
            if (!states.has(type))
            {
                return D3DERR_INVALIDCALL;
            }
            out.value = states.get(type);
            return D3D_OK;
        },

        /**
         * @param {number} type      D3DTS
         * @param {ArrayLike<number>} matrix  Sixteen floats, row-major as D3DMATRIX lays them.
         */
        SetTransform(type, matrix){
            if (!matrix || matrix.length !== 16)
            {
                return D3DERR_INVALIDCALL;
            }
            transforms.set(type, Float32Array.from(matrix));
            return D3D_OK;
        },

        /**
         * @param {number} type
         * @param {{ matrix?: Float32Array }} out
         *        A type never written reads back as the identity, which is what
         *        an untouched transform is, rather than as a failure.
         */
        GetTransform(type, out){
            out.matrix = Float32Array.from(transforms.get(type) ?? IDENTITY);
            return D3D_OK;
        },

        /** @param {Material} value */
        SetMaterial(value){
            if (!value)
            {
                return D3DERR_INVALIDCALL;
            }
            material = copyMaterial(value);
            return D3D_OK;
        },

        /** @param {{ material?: Material }} out */
        GetMaterial(out){
            out.material = copyMaterial(material);
            return D3D_OK;
        },

        /**
         * The vertex format, which in this version is its own state rather than
         * a DWORD shared with a shader handle.
         *
         * @param {number} value
         */
        SetFVF(value){
            fvf = value >>> 0;
            return D3D_OK;
        },

        /** @param {{ fvf?: number }} out */
        GetFVF(out){
            out.fvf = fvf;
            return D3D_OK;
        },

        /**
         * What the two stages are running. This build makes no shader objects,
         * so every draw is fixed-function; the shape is the renderer's, which
         * has to serve a version where that is not true.
         */
        get stageProcessing(){
            return { vertexShader: 0, fvf, fixedFunctionVertex: true, pixelShader: 0 };
        },

        /**
         * Clears the viewport, or the given rectangles within it: a viewport
         * smaller than the target leaves everything outside it alone.
         *
         * @param {number} rectCount
         * @param {readonly { x1: number, y1: number, x2: number, y2: number }[] | null} rects
         * @param {number} flags D3DCLEAR
         * @param {number} color D3DCOLOR
         * @param {number} z
         * @param {number} stencil
         */
        Clear(rectCount, rects, flags, color, z, stencil){
            if ((flags & (D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER | D3DCLEAR.STENCIL)) === 0
                || (rectCount > 0 && !rects))
            {
                return D3DERR_INVALIDCALL;
            }
            if ((flags & (D3DCLEAR.ZBUFFER | D3DCLEAR.STENCIL)) !== 0)
            {
                if (!depthStencil)
                {
                    return D3DERR_INVALIDCALL;
                }
                /** @type {{ desc?: import('./resources.js').SurfaceDesc }} */
                const bound = {};
                depthStencil.GetDesc(bound);
                if ((flags & D3DCLEAR.STENCIL) !== 0 && bound.desc?.Format !== D3DFMT.D24S8)
                {
                    return D3DERR_INVALIDCALL;
                }
            }
            renderer?.clear(model, rectCount > 0 ? (rects ?? []).slice(0, rectCount) : [],
                flags, color >>> 0, z, stencil);
            return D3D_OK;
        },

        /**
         * @param {number} type D3DPRIMITIVETYPE
         * @param {number} startVertex
         * @param {number} primitiveCount
         */
        DrawPrimitive(type, startVertex, primitiveCount){
            const bias = streamBias();
            if (drawPreconditions(type, primitiveCount) !== D3D_OK || bias === null)
            {
                return D3DERR_INVALIDCALL;
            }
            renderer?.drawPrimitive(model, type, startVertex + bias, primitiveCount);
            return D3D_OK;
        },

        /**
         * The base vertex is an argument of the draw in this version, where
         * D3D8 carried it on the index binding. The minimum index and vertex
         * count are hints; nothing here needs them.
         *
         * @param {number} type
         * @param {number} base
         * @param {number} _minIndex
         * @param {number} _numVertices
         * @param {number} startIndex
         * @param {number} primitiveCount
         */
        DrawIndexedPrimitive(type, base, _minIndex, _numVertices, startIndex, primitiveCount){
            const bias = streamBias();
            if (drawPreconditions(type, primitiveCount) !== D3D_OK || bias === null || !indices)
            {
                return D3DERR_INVALIDCALL;
            }
            baseVertexIndex = base + bias;
            renderer?.drawIndexedPrimitive(model, type, startIndex, primitiveCount);
            return D3D_OK;
        },

        /**
         * The bytes rather than the pointer: whoever reads guest memory reads
         * `vertexCountOf(type, primitiveCount) * stride` of them.
         *
         * @param {number} type
         * @param {number} primitiveCount
         * @param {Uint8Array} vertexData
         * @param {number} stride
         */
        DrawPrimitiveUP(type, primitiveCount, vertexData, stride){
            if (drawPreconditions(type, primitiveCount) !== D3D_OK || !vertexData || !(stride > 0)
                || vertexData.byteLength < vertexCountOf(type, primitiveCount) * stride)
            {
                return D3DERR_INVALIDCALL;
            }
            renderer?.drawPrimitiveUp(model, type, primitiveCount, vertexData, stride);
            unbindStreamZero();
            return D3D_OK;
        },

        /**
         * @param {number} type
         * @param {number} _minIndex
         * @param {number} numVertices  How many vertices `vertexData` holds.
         * @param {number} primitiveCount
         * @param {Uint8Array} indexData
         * @param {number} indexFormat  D3DFMT_INDEX
         * @param {Uint8Array} vertexData
         * @param {number} stride
         */
        DrawIndexedPrimitiveUP(
            type, _minIndex, numVertices, primitiveCount, indexData, indexFormat, vertexData,
            stride,
        )
        {
            if (drawPreconditions(type, primitiveCount) !== D3D_OK || !vertexData || !indexData
                || !(stride > 0) || vertexData.byteLength < numVertices * stride)
            {
                return D3DERR_INVALIDCALL;
            }
            renderer?.drawIndexedPrimitiveUp(model, type, numVertices, primitiveCount, indexData,
                indexFormat, vertexData, stride);
            unbindStreamZero();
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
            if (index === 0)
            {
                // A new target resets the viewport to all of it, so that one
                // left over from a smaller target cannot stay latched.
                const target = describe(surface);
                viewport = fullTarget({ width: target.Width, height: target.Height });
            }
            return D3D_OK;
        },

        /**
         * The viewport, both halves of it, which is the whole reason this
         * method does not just keep the rectangle.
         *
         * A viewport is a hardware rectangle *and* the inverse offset and
         * extent the fixed-function vertex stage needs, and the two cancel so
         * that a vertex given in target pixels lands on the pixel it names.
         * Setting only the rectangle leaves pre-transformed vertices in the
         * wrong place; feeding only the constants tears the frame apart. So
         * this device never stores a rectangle: it stores the paired value, and
         * there is no accessor that hands back one half without the other.
         *
         * @param {{ X: number, Y: number, Width: number, Height: number,
         *           MinZ?: number, MaxZ?: number }} value
         */
        SetViewport(value){
            const target = describe(renderTargets.get(0));
            if (!(value.Width > 0) || !(value.Height > 0) || value.X < 0 || value.Y < 0
                || value.X + value.Width > target.Width
                || value.Y + value.Height > target.Height)
            {
                return D3DERR_INVALIDCALL;
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

        /** @param {{ viewport?: any }} out */
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

        /**
         * The paired value itself, for whoever is about to record a draw. It is
         * exposed instead of the rectangle precisely so that no consumer has to
         * derive the vertex-stage constants and get them subtly wrong.
         */
        get viewportState(){
            return viewport;
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

        /**
         * The depth stencil is bound on its own here, and unbinding it is what
         * a null means -- unlike D3D8, where one call changed both targets and
         * a null colour target meant "keep the current one".
         *
         * @param {any} surface
         */
        SetDepthStencilSurface(surface){
            depthStencil = surface ?? null;
            return D3D_OK;
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
                base: allocate(surfaceBytes(format, width, height)),
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
                base: allocate(surfaceBytes(format, width, height)),
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
                base: allocate(surfaceBytes(format, width, height)),
                count: explicitCount(),
            });
            return D3D_OK;
        },

        /**
         * The format is kept and nothing reads it: a draw takes its layout from
         * the device's own vertex format, which is the one a program is obliged
         * to set. It is a parameter here because it is one in the call, and a
         * signature short by an argument reads every later one from the wrong
         * place.
         *
         * @param {number} length
         * @param {number} usage
         * @param {number} vertexFormat
         * @param {number} pool
         * @param {{ buffer?: any }} out
         */
        CreateVertexBuffer(length, usage, vertexFormat, pool, out){
            out.buffer = createBuffer({
                length, usage, pool, fvf: vertexFormat, type: D3DRTYPE.VERTEXBUFFER,
            });
            return D3D_OK;
        },

        /**
         * The format is the index width, and it is what tells a buffer apart
         * from a vertex one: a draw asks the buffer how wide its indices are
         * rather than being told again at the draw.
         *
         * @param {number} length
         * @param {number} usage
         * @param {number} format  D3DFMT_INDEX16 or D3DFMT_INDEX32
         * @param {number} pool
         * @param {{ buffer?: any }} out
         */
        CreateIndexBuffer(length, usage, format, pool, out){
            out.buffer = createBuffer({
                length, usage, pool, format, type: D3DRTYPE.INDEXBUFFER,
            });
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
    // Offered only when the backend can sample blocks, and never as something
    // the pipeline draws into: the blocks are not writable by it.
    if (isCompressed(format)
        && (!caps.compressedTextures
            || (usage & (D3DUSAGE.RENDERTARGET | D3DUSAGE.DEPTHSTENCIL)) !== 0))
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
