/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D 8 device as a program observes it between draws.
 *
 * Nothing here draws. What it models is what a program can find out about a
 * device without one: whether a scene is open, what a state reads back as,
 * what a resource costs in references, whether the device is still usable, and
 * where a vertex given in pixels ends up.
 *
 * D3D8 and D3D9 are one API with two object models, so most of what a device
 * has to know is imported rather than restated -- the resource validity table,
 * the surface and texture objects, the reference-count primitive, the shared
 * half of the render state defaults, the three states a device can be in. What
 * this file owns is the places the two versions genuinely part company:
 *
 * - **One call binds both targets.** SetRenderTarget takes the colour target
 *   and the depth stencil together. A null colour target keeps the current
 *   one; a null depth stencil unbinds. That asymmetry is measured, not guessed.
 * - **Reset refuses differently.** A device with an outstanding default-pool
 *   resource answers D3DERR_DEVICELOST here, where D3D9 answers
 *   D3DERR_INVALIDCALL. Both then report themselves resettable, so a program
 *   that only watches the first return code draws the wrong conclusion.
 * - **Shaders are handles, not objects.** Creating one takes no reference on
 *   the device; deleting the bound one unbinds it; and the same parameter that
 *   carries a handle also carries a vertex format.
 * - **CopyRects**, which D3D9 replaced with something else entirely.
 *
 * The viewport is the one thing here that is not a version difference at all,
 * and it is spelled out in `SetViewport`.
 *
 * Drawing is optional. A device built with a backend hands every clear and
 * draw to `render.js`; one built without keeps modelling what the program can
 * observe, so that a headless build behaves and a pure-state test needs no GPU
 * double. Either way this file decides whether a call is legal, and only a
 * legal one reaches the renderer.
 */

import {
    D3DCLEAR, D3DCREATE, D3DERR_DEVICELOST, D3DERR_DEVICENOTRESET, D3DERR_INVALIDCALL,
    D3DERR_NOTFOUND, D3DFMT, D3DLIGHTTYPE, D3DPOOL, D3DRTYPE, D3DTS, D3DUSAGE, D3D_OK,
    FORMAT_INFO, isShaderHandle,
} from './constants.js';
import { createDefaultRenderStates } from './renderstates.js';
import { createDefaultStageStates } from './stagestates.js';
import { IDENTITY, STAGE_COUNT, createRenderer, vertexCountOf } from './render.js';
import {
    SURFACE_TYPE, copyRectsResult, createResult, imageSurfaceCreateResult,
    reportedBackBufferCount, targetPairResult, validatePresentParameters,
} from './validity.js';
import { createReferenceCount, createSurface, createTexture } from '../d3d9/resources.js';
import { DEVICE_STATE, LIGHT_ENABLED } from '../d3d9/device.js';
import { fullTarget, viewportState } from '../webgpu/internal/viewport.js';

export { DEVICE_STATE, LIGHT_ENABLED };

/**
 * @typedef {Object} DeviceCaps
 * @property {number} maxPointSize     Decides the POINTSIZE_MAX default.
 * @property {boolean} depthTexture2d  Whether depth formats are usable as textures,
 * @property {boolean} depthCube       as cube maps,
 * @property {boolean} depthPlain      and as image surfaces.
 */

/** @type {DeviceCaps} */
export const DEFAULT_CAPS = Object.freeze({
    maxPointSize: 64.0,
    depthTexture2d: false,
    depthCube: false,
    depthPlain: false,
});

/**
 * @typedef {import('../d3d9/device.js').Light} Light
 */

/**
 * @typedef {Object} Material
 * @property {{ r: number, g: number, b: number, a: number }} Diffuse
 * @property {{ r: number, g: number, b: number, a: number }} Ambient
 * @property {{ r: number, g: number, b: number, a: number }} Specular
 * @property {{ r: number, g: number, b: number, a: number }} Emissive
 * @property {number} Power
 */

/** @returns {Material} the material a fresh device has: everything zero */
function defaultMaterial(){
    const black = ()=>({ r: 0, g: 0, b: 0, a: 0 });
    return { Diffuse: black(), Ambient: black(), Specular: black(), Emissive: black(), Power: 0 };
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
 * Whether a number names a transform: the view, the projection, one of the
 * eight texture matrices, or one of the 256 world matrices.
 *
 * @param {number} type
 */
function isTransformType(type){
    return type === D3DTS.VIEW || type === D3DTS.PROJECTION
        || (type >= D3DTS.TEXTURE0 && type <= D3DTS.TEXTURE7)
        || (type >= D3DTS.WORLD && type <= D3DTS.WORLD_LAST);
}

/**
 * @typedef {Object} DeviceServices
 *     What a device that draws needs from outside itself. Absent, the device
 *     is the pure state model.
 * @property {any} [backend]         The rendering backend.
 * @property {(address: number, length: number)=>Uint8Array} [readMemory]
 * @property {(descriptor: any)=>any} [createSampler]
 */

/**
 * @typedef {Object} Viewport
 * @property {number} X
 * @property {number} Y
 * @property {number} Width
 * @property {number} Height
 * @property {number} MinZ
 * @property {number} MaxZ
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
 * @param {import('./validity.js').PresentParameters} parameters
 * @returns {import('./validity.js').PresentParameters}
 */
function normalisePresentParameters(parameters){
    return {
        swapEffect: parameters.swapEffect,
        backBufferCount: reportedBackBufferCount(parameters),
        windowed: parameters.windowed ?? true,
        backBufferWidth: parameters.backBufferWidth || 640,
        backBufferHeight: parameters.backBufferHeight || 480,
        backBufferFormat: parameters.backBufferFormat ?? D3DFMT.X8R8G8B8,
        enableAutoDepthStencil: parameters.enableAutoDepthStencil ?? false,
        autoDepthStencilFormat: parameters.autoDepthStencilFormat ?? D3DFMT.D24S8,
    };
}

/**
 * What a device writes back into the presentation parameters it was handed.
 *
 * Only the back buffer count. A zero width or height is a request for the
 * client area's size and is left as the zero the caller wrote, which is where
 * D3D9 differs: it reports the size it resolved. A program that reads the
 * width back after creating a device gets nothing useful in this version.
 *
 * @param {import('./validity.js').PresentParameters} parameters
 */
function reportPresentParameters(parameters){
    parameters.backBufferCount = reportedBackBufferCount(parameters);
}

/**
 * The object a program gets from Direct3DCreate8. It exists here for one
 * reason: device creation can fail on its parameters, and the caller has to be
 * able to see that failure without already holding a device.
 *
 * @param {Partial<DeviceCaps> & DeviceServices} [options]
 */
export function createDirect3D8(options = {}){
    const { backend, readMemory, createSampler, ...caps } = options;
    /** @type {DeviceCaps} */
    const resolved = { ...DEFAULT_CAPS, ...caps };
    /** @type {DeviceServices} */
    const services = { backend, readMemory, createSampler };
    if (backend && !readMemory)
    {
        throw new Error('graphics/d3d8: a device that draws needs readMemory as well as a backend');
    }
    return {
        caps: resolved,

        /**
         * @param {import('./validity.js').PresentParameters} parameters
         *        Written back through, the way the guest passes a pointer.
         * @param {{ device?: ReturnType<typeof createDeviceObject> }} out
         * @param {number} [behaviourFlags]
         * @returns {number}
         */
        CreateDevice(parameters, out, behaviourFlags = 0){
            const hr = validatePresentParameters(parameters);
            if (hr !== D3D_OK)
            {
                return hr;
            }
            out.device = createDeviceObject(
                normalisePresentParameters(parameters), resolved, behaviourFlags, services);
            reportPresentParameters(parameters);
            return D3D_OK;
        },
    };
}

/**
 * @param {import('./validity.js').PresentParameters} parameters
 * @param {DeviceCaps} caps
 * @param {number} behaviourFlags
 * @param {DeviceServices} services
 */
function createDeviceObject(parameters, caps, behaviourFlags, services){
    let presentParameters = parameters;
    /** @type {string} */
    let deviceState = DEVICE_STATE.OK;
    let inScene = false;
    let nextAddress = 0x40000000;
    const softwareVertexProcessing =
        (behaviourFlags & D3DCREATE.SOFTWARE_VERTEXPROCESSING) !== 0;

    /** @type {Map<number, number>} */
    let renderStates = defaultStates();

    /** @type {Map<number, { light: Light, enabled: boolean }>} */
    let lights = new Map();

    /** @type {Map<number, Map<number, number>>} stage -> its states, made on first touch */
    let stageStates = new Map();
    /** @type {Map<number, Float32Array>} D3DTS -> the matrix; absent means identity */
    let transforms = new Map();
    /** @type {Material} */
    let material = defaultMaterial();

    /** @type {Map<number, { buffer: any, stride: number }>} */
    const streams = new Map();
    /** @type {Map<number, any>} */
    const textures = new Map();
    /** @type {any} */
    let indices = null;
    let baseVertexIndex = 0;

    /**
     * Live shader handles, keyed by the DWORD the program holds. Two maps
     * rather than one: the two entry points have separate number spaces, so
     * deleting a pixel shader with a vertex shader's handle has to fail.
     *
     * @type {Map<number, any>}
     */
    const vertexShaders = new Map();
    /** @type {Map<number, any>} */
    const pixelShaders = new Map();
    let nextShaderHandle = 1;
    let boundVertexShader = 0;
    let boundPixelShader = 0;

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
     * What stops a Reset. A default-pool resource the program still holds, or
     * a reference it still holds on one of the device's own surfaces -- either
     * one means storage the device cannot rebuild yet.
     */
    let liveDefaultPoolResources = 0;
    let liveImplicitReferences = 0;

    function defaultStates(){
        return createDefaultRenderStates({
            enableAutoDepthStencil: presentParameters.enableAutoDepthStencil === true,
            maxPointSize: caps.maxPointSize,
            softwareVertexProcessing,
        });
    }

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

    /**
     * A resource the program owns: it took a reference on the device, and
     * while it lives in the default pool it also blocks a Reset.
     *
     * @param {number} pool
     */
    const explicitCount = pool=>{
        count.addRef();
        const blocking = pool === D3DPOOL.DEFAULT;
        if (blocking)
        {
            liveDefaultPoolResources++;
        }
        return createReferenceCount({
            onLastRef: ()=>{
                count.release();
                if (blocking)
                {
                    liveDefaultPoolResources--;
                }
            },
        });
    };

    /** A resource the device owns: its first reference is one on the device. */
    const implicitCount = ()=>createReferenceCount({
        implicit: true,
        onFirstRef: ()=>{
            count.addRef();
            liveImplicitReferences++;
        },
        onLastRef: ()=>{
            count.release();
            liveImplicitReferences--;
        },
    });

    /** @type {any[]} */
    let backBuffers = [];
    /** @type {any} */
    let autoDepthStencil = null;
    /** @type {any} */
    let renderTarget = null;
    /** @type {any} */
    let depthStencil = null;
    /** @type {import('../webgpu/contract.js').ViewportState} */
    let viewport;

    /**
     * The implicit resources, rebuilt from the presentation parameters. Called
     * once at creation and again on every successful Reset, which is why the
     * automatic depth stencil can appear and disappear across one.
     */
    function buildImplicitResources(){
        const width = presentParameters.backBufferWidth ?? 640;
        const height = presentParameters.backBufferHeight ?? 480;
        backBuffers = [];
        for (let index = 0; index < (presentParameters.backBufferCount ?? 1); index++)
        {
            backBuffers.push(createSurface({
                type: SURFACE_TYPE.RENDER_TARGET,
                width,
                height,
                format: presentParameters.backBufferFormat ?? D3DFMT.X8R8G8B8,
                pool: D3DPOOL.DEFAULT,
                usage: D3DUSAGE.RENDERTARGET,
                lockable: false,
                base: allocate(0x100000),
                count: implicitCount(),
            }));
        }
        autoDepthStencil = presentParameters.enableAutoDepthStencil
            ? createSurface({
                type: SURFACE_TYPE.DEPTH_STENCIL,
                width,
                height,
                format: presentParameters.autoDepthStencilFormat ?? D3DFMT.D24S8,
                pool: D3DPOOL.DEFAULT,
                usage: D3DUSAGE.DEPTHSTENCIL,
                base: allocate(0x100000),
                count: implicitCount(),
            })
            : null;
        renderTarget = backBuffers[0];
        depthStencil = autoDepthStencil;
        viewport = fullTarget({ width, height });
    }

    buildImplicitResources();

    /** @param {number} index */
    const stream = index=>{
        const existing = streams.get(index);
        if (existing)
        {
            return existing;
        }
        const record = { buffer: null, stride: 0 };
        streams.set(index, record);
        return record;
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

    /**
     * A vertex or index buffer. Its storage is guest memory at `base`, which
     * is what a lock hands back; the renderer reads the locked range from
     * there on unlock, under the flags the lock was taken with.
     *
     * @param {{ length: number, usage: number, pool: number, type: number, fvf?: number,
     *           format?: number }} spec
     */
    const createBuffer = spec=>{
        const bufferCount = explicitCount(spec.pool);
        const base = allocate(spec.length);
        let locked = false;
        const buffer = {
            ...spec,
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
             * @param {number} [flags]
             */
            Lock(offset, size, out, flags = 0){
                const length = size === 0 ? spec.length - offset : size;
                if (locked || offset < 0 || !(length > 0) || offset + length > spec.length)
                {
                    return D3DERR_INVALIDCALL;
                }
                locked = true;
                out.pBits = base + offset;
                if (renderer)
                {
                    renderer.lockBuffer(buffer, offset, length, flags);
                }
                return D3D_OK;
            },

            Unlock(){
                if (!locked)
                {
                    return D3DERR_INVALIDCALL;
                }
                locked = false;
                if (renderer)
                {
                    renderer.unlockBuffer(buffer);
                }
                return D3D_OK;
            },
        };
        return buffer;
    };

    /**
     * A shader handle. Bit zero is set so the DWORD can never be mistaken for
     * a vertex format, and the counter never yields zero, which means "none".
     */
    const nextHandle = ()=>{
        const handle = (nextShaderHandle++ << 1) | 1;
        return handle >>> 0;
    };

    /**
     * @param {any} surface
     * @returns {import('../d3d9/resources.js').SurfaceDesc}
     */
    const describe = surface=>{
        /** @type {{ desc?: any }} */
        const out = {};
        surface.GetDesc(out);
        return out.desc;
    };

    /**
     * What the renderer reads at the moment of a draw. Live views, so that a
     * state set after this object was made is the state a later draw sees.
     *
     * @type {import('./render.js').RenderModel}
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
            return renderTarget;
        },
        get depthStencil(){
            return depthStencil;
        },
        get transforms(){
            return transforms;
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
        if (!inScene || vertexCountOf(type, primitiveCount) === 0)
        {
            return D3DERR_INVALIDCALL;
        }
        const processing = device.stageProcessing;
        // A vertex format with no position is not a format, and there is
        // nothing to draw without either that or a shader.
        if (processing.vertexShader === 0 && (processing.fvf & 0xe) === 0)
        {
            return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    /**
     * The user-pointer draws leave stream zero and the index binding empty:
     * the data they drew came from neither, and a program that draws from a
     * buffer afterwards has to bind it again.
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
            if (renderer)
            {
                renderer.present(model);
            }
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
         * Reset puts the device back to what it was created as, against new
         * presentation parameters: implicit resources rebuilt, the back buffer
         * bound again, no scene open, default state, usable.
         *
         * The two refusals are the version difference. A device lost beyond
         * recovery answers D3DERR_DEVICELOST and stays lost. A device the
         * program has not finished emptying -- a default-pool resource it
         * still holds, or a reference on one of the device's own surfaces --
         * *also* answers D3DERR_DEVICELOST, and this is where D3D9 answers
         * D3DERR_INVALIDCALL instead. Either way the device is left resettable,
         * so the code alone does not say which happened and
         * TestCooperativeLevel does not distinguish them either.
         *
         * @param {import('./validity.js').PresentParameters} [next]
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
            }
            if (liveDefaultPoolResources > 0 || liveImplicitReferences > 0)
            {
                deviceState = DEVICE_STATE.NOT_RESET;
                return D3DERR_DEVICELOST;
            }
            if (next)
            {
                presentParameters = normalisePresentParameters(next);
                reportPresentParameters(next);
            }
            inScene = false;
            deviceState = DEVICE_STATE.OK;
            renderStates = defaultStates();
            stageStates = new Map();
            transforms = new Map();
            material = defaultMaterial();
            lights = new Map();
            buildImplicitResources();
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
            if (!isTransformType(type) || !matrix || matrix.length !== 16)
            {
                return D3DERR_INVALIDCALL;
            }
            transforms.set(type, Float32Array.from(matrix));
            return D3D_OK;
        },

        /**
         * @param {number} type
         * @param {{ matrix?: Float32Array }} out
         *        The identity for a transform never written, which is what a
         *        fresh device holds.
         */
        GetTransform(type, out){
            if (!isTransformType(type))
            {
                return D3DERR_INVALIDCALL;
            }
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
                if ((flags & D3DCLEAR.STENCIL) !== 0
                    && describe(depthStencil).Format !== D3DFMT.D24S8)
                {
                    return D3DERR_INVALIDCALL;
                }
            }
            if (renderer)
            {
                renderer.clear(model, rectCount > 0 ? (rects ?? []).slice(0, rectCount) : [],
                    flags, color >>> 0, z, stencil);
            }
            return D3D_OK;
        },

        /**
         * @param {number} type D3DPRIMITIVETYPE
         * @param {number} startVertex
         * @param {number} primitiveCount
         */
        DrawPrimitive(type, startVertex, primitiveCount){
            const hr = drawPreconditions(type, primitiveCount);
            if (hr !== D3D_OK || !stream(0).buffer)
            {
                return D3DERR_INVALIDCALL;
            }
            if (renderer)
            {
                renderer.drawPrimitive(model, type, startVertex, primitiveCount);
            }
            return D3D_OK;
        },

        /**
         * The minimum index and vertex count are the hints this version's
         * signature carries; nothing here needs them.
         *
         * @param {number} type
         * @param {number} _minIndex
         * @param {number} _numVertices
         * @param {number} startIndex
         * @param {number} primitiveCount
         */
        DrawIndexedPrimitive(type, _minIndex, _numVertices, startIndex, primitiveCount){
            const hr = drawPreconditions(type, primitiveCount);
            if (hr !== D3D_OK || !stream(0).buffer || !indices)
            {
                return D3DERR_INVALIDCALL;
            }
            if (renderer)
            {
                renderer.drawIndexedPrimitive(model, type, startIndex, primitiveCount);
            }
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
            const hr = drawPreconditions(type, primitiveCount);
            if (hr !== D3D_OK || !vertexData || !(stride > 0)
                || vertexData.byteLength < vertexCountOf(type, primitiveCount) * stride)
            {
                return D3DERR_INVALIDCALL;
            }
            if (renderer)
            {
                renderer.drawPrimitiveUp(model, type, primitiveCount, vertexData, stride);
            }
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
            const hr = drawPreconditions(type, primitiveCount);
            if (hr !== D3D_OK || !vertexData || !indexData || !(stride > 0)
                || vertexData.byteLength < numVertices * stride)
            {
                return D3DERR_INVALIDCALL;
            }
            if (renderer)
            {
                renderer.drawIndexedPrimitiveUp(model, type, numVertices, primitiveCount,
                    indexData, indexFormat, vertexData, stride);
            }
            unbindStreamZero();
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
         * existence, so the read that follows succeeds. An index far past the
         * reported maximum is still a light.
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
         * The viewport, both halves of it, which is the whole reason this
         * method does not just keep the rectangle.
         *
         * A viewport is a hardware rectangle *and* the inverse offset and
         * extent the fixed-function vertex stage needs, and the two cancel so
         * that a vertex given in target pixels lands on the pixel it names.
         * Setting only the rectangle leaves pre-transformed vertices in the
         * wrong place; feeding only the constants tears the frame apart. So
         * this device never stores a rectangle: it stores the paired value the
         * backend produces, and there is no accessor that hands back one half
         * without the other. A fixed-function draw and a shader draw read the
         * same object, so they cannot disagree about where the frame is.
         *
         * @param {Viewport} value
         */
        SetViewport(value){
            const target = describe(renderTarget);
            if (!(value.Width > 0) || !(value.Height > 0)
                || value.X < 0 || value.Y < 0
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

        /**
         * The paired value itself, for whoever is about to record a draw. It is
         * exposed instead of the rectangle precisely so that no consumer has to
         * derive the vertex-stage constants and get them subtly wrong.
         */
        get viewportState(){
            return viewport;
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
         * The base vertex index travels with the binding in this version; D3D9
         * moved it onto the draw call.
         *
         * @param {any} buffer
         * @param {number} [base]
         */
        SetIndices(buffer, base = 0){
            indices = buffer ?? null;
            baseVertexIndex = base;
            return D3D_OK;
        },

        /** @param {{ buffer?: any, baseVertexIndex?: number }} out */
        GetIndices(out){
            if (indices)
            {
                indices.addRef();
            }
            out.buffer = indices;
            out.baseVertexIndex = baseVertexIndex;
            return D3D_OK;
        },

        /**
         * Unbinding leaves the stride where it was. That is not tidiness lost:
         * a program reads it back after unbinding and expects the previous
         * value, so clearing the whole record is a defect.
         *
         * There is no offset here. D3D9 added one; in this version a stream is
         * a buffer and a stride and nothing else.
         *
         * @param {number} index
         * @param {any} buffer
         * @param {number} stride
         */
        SetStreamSource(index, buffer, stride){
            const record = stream(index);
            record.buffer = buffer ?? null;
            if (buffer)
            {
                record.stride = stride;
            }
            return D3D_OK;
        },

        /**
         * @param {number} index
         * @param {{ buffer?: any, stride?: number }} out
         */
        GetStreamSource(index, out){
            const record = stream(index);
            if (record.buffer)
            {
                record.buffer.addRef();
            }
            out.buffer = record.buffer;
            out.stride = record.stride;
            return D3D_OK;
        },

        /**
         * Both targets at once. A null colour target means "keep the one that
         * is bound", which is how a program changes only the depth stencil; a
         * null depth stencil unbinds it. Neither opens or closes a scene.
         *
         * A successful change resets the viewport to the whole new target, so a
         * small viewport left over from an earlier pass cannot stay latched.
         *
         * @param {any} target
         * @param {any} depth
         */
        SetRenderTarget(target, depth){
            const hr = targetPairResult(
                target ? describe(target) : null, depth ? describe(depth) : null);
            if (hr !== D3D_OK)
            {
                return hr;
            }
            if (target)
            {
                renderTarget = target;
            }
            depthStencil = depth ?? null;
            const bound = describe(renderTarget);
            viewport = fullTarget({ width: bound.Width, height: bound.Height });
            return D3D_OK;
        },

        /**
         * There is always a colour target, so this cannot fail. D3D9 takes an
         * index here; this version has exactly one.
         *
         * @param {{ surface?: any }} out
         */
        GetRenderTarget(out){
            renderTarget.addRef();
            out.surface = renderTarget;
            return D3D_OK;
        },

        /**
         * @param {{ surface?: any }} out
         *        Set to null when there is no depth stencil. The failure writes
         *        rather than leaving the caller's pointer alone, which is what a
         *        program that checks the pointer instead of the code relies on.
         */
        GetDepthStencilSurface(out){
            if (!depthStencil)
            {
                out.surface = null;
                return D3DERR_NOTFOUND;
            }
            depthStencil.addRef();
            out.surface = depthStencil;
            return D3D_OK;
        },

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
            const hr = createResult(SURFACE_TYPE.TEXTURE_2D, format, pool, usage, caps);
            if (hr !== D3D_OK)
            {
                return hr;
            }
            const texture = createTexture({
                width,
                height,
                levels: levels || 1,
                format,
                pool,
                usage,
                count: explicitCount(pool),
                allocate,
            });
            if (renderer)
            {
                renderer.trackTexture(texture, { width, height, format });
            }
            out.texture = texture;
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
            const hr = createResult(SURFACE_TYPE.CUBE, format, pool, usage, caps);
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
                count: explicitCount(pool),
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
            const hr = createResult(
                SURFACE_TYPE.RENDER_TARGET, format, D3DPOOL.DEFAULT, D3DUSAGE.RENDERTARGET, caps);
            if (hr !== D3D_OK)
            {
                return hr;
            }
            const info = FORMAT_INFO[format];
            out.surface = createSurface({
                type: SURFACE_TYPE.RENDER_TARGET,
                width,
                height,
                format,
                pool: D3DPOOL.DEFAULT,
                usage: D3DUSAGE.RENDERTARGET,
                lockable,
                base: allocate(width * height * info.bytesPerPixel),
                count: explicitCount(D3DPOOL.DEFAULT),
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
            const hr = createResult(
                SURFACE_TYPE.DEPTH_STENCIL, format, D3DPOOL.DEFAULT, D3DUSAGE.DEPTHSTENCIL, caps);
            if (hr !== D3D_OK)
            {
                return hr;
            }
            const info = FORMAT_INFO[format];
            out.surface = createSurface({
                type: SURFACE_TYPE.DEPTH_STENCIL,
                width,
                height,
                format,
                pool: D3DPOOL.DEFAULT,
                usage: D3DUSAGE.DEPTHSTENCIL,
                base: allocate(width * height * info.bytesPerPixel),
                count: explicitCount(D3DPOOL.DEFAULT),
            });
            return D3D_OK;
        },

        /**
         * Where D3D9 has CreateOffscreenPlainSurface. The pool is not a
         * parameter: an image surface is always system memory with no usage,
         * which is also why it never blocks a Reset and always answers a lock.
         *
         * @param {number} width
         * @param {number} height
         * @param {number} format
         * @param {{ surface?: any }} out
         */
        CreateImageSurface(width, height, format, out){
            const hr = imageSurfaceCreateResult(format, caps);
            if (hr !== D3D_OK)
            {
                return hr;
            }
            out.surface = createSurface({
                type: SURFACE_TYPE.PLAIN,
                width,
                height,
                format,
                pool: D3DPOOL.SYSTEMMEM,
                usage: 0,
                base: allocate(width * height * FORMAT_INFO[format].bytesPerPixel),
                count: explicitCount(D3DPOOL.SYSTEMMEM),
            });
            return D3D_OK;
        },

        /**
         * @param {number} length
         * @param {number} usage
         * @param {number} fvf
         * @param {number} pool
         * @param {{ buffer?: any }} out
         */
        CreateVertexBuffer(length, usage, fvf, pool, out){
            out.buffer = createBuffer({ length, usage, pool, fvf, type: D3DRTYPE.VERTEXBUFFER });
            return D3D_OK;
        },

        /**
         * @param {number} length
         * @param {number} usage
         * @param {number} format
         * @param {number} pool
         * @param {{ buffer?: any }} out
         */
        CreateIndexBuffer(length, usage, format, pool, out){
            out.buffer = createBuffer({ length, usage, pool, format, type: D3DRTYPE.INDEXBUFFER });
            return D3D_OK;
        },

        /**
         * A blit between two surfaces, which D3D9 does not have. Neither side
         * may be a depth stencil, and it cannot stretch.
         *
         * @param {any} source
         * @param {readonly import('./validity.js').CopyRect[] | null} rects
         * @param {number} rectCount
         * @param {any} destination
         * @param {readonly { x: number, y: number }[] | null} points
         */
        CopyRects(source, rects, rectCount, destination, points){
            if (!source || !destination)
            {
                return D3DERR_INVALIDCALL;
            }
            const from = describe(source);
            const to = describe(destination);
            return copyRectsResult(
                { type: surfaceTypeOf(from), format: from.Format, width: from.Width,
                    height: from.Height },
                { type: surfaceTypeOf(to), format: to.Format, width: to.Width,
                    height: to.Height },
                rectCount > 0 ? (rects ?? []).slice(0, rectCount) : null,
                rectCount > 0 ? (points ?? []).slice(0, rectCount) : null);
        },

        // --- shaders, which in this version are handles rather than objects ---

        /**
         * Creating a shader takes no reference on the device: a handle is not
         * an object, so there is nothing for the device to outlive. The new
         * shader is not bound either, whatever the documentation says.
         *
         * @param {readonly number[]} declaration
         * @param {readonly number[] | null} functionCode
         * @param {{ handle?: number }} out
         */
        CreateVertexShader(declaration, functionCode, out){
            if (!declaration)
            {
                return D3DERR_INVALIDCALL;
            }
            const handle = nextHandle();
            vertexShaders.set(handle, { declaration, functionCode: functionCode ?? null });
            out.handle = handle;
            return D3D_OK;
        },

        /**
         * One DWORD, two meanings. A value with D3DFVF_RESERVED0 clear is a
         * vertex format and is stored verbatim -- a program reads back exactly
         * what it wrote. A value with the bit set names a created shader and
         * has to be one. Zero clears the binding.
         *
         * Which of the two is bound decides whether the vertex stage is fixed
         * function, and it is the only thing that decides it: the pixel shader
         * is a separate question, and a fixed-function vertex stage with a
         * pixel shader bound is an ordinary combination rather than a
         * contradiction.
         *
         * @param {number} handle
         */
        SetVertexShader(handle){
            if (isShaderHandle(handle) && !vertexShaders.has(handle))
            {
                return D3DERR_INVALIDCALL;
            }
            boundVertexShader = handle >>> 0;
            return D3D_OK;
        },

        /** @param {{ handle?: number }} out */
        GetVertexShader(out){
            out.handle = boundVertexShader;
            return D3D_OK;
        },

        /**
         * Deleting the bound shader unbinds it; deleting any other leaves the
         * binding alone. A handle that is not live fails, which is what makes a
         * double delete an error rather than a no-op.
         *
         * @param {number} handle
         */
        DeleteVertexShader(handle){
            if (!vertexShaders.delete(handle))
            {
                return D3DERR_INVALIDCALL;
            }
            if (boundVertexShader === handle)
            {
                boundVertexShader = 0;
            }
            return D3D_OK;
        },

        /**
         * @param {readonly number[]} functionCode
         * @param {{ handle?: number }} out
         */
        CreatePixelShader(functionCode, out){
            if (!functionCode)
            {
                return D3DERR_INVALIDCALL;
            }
            const handle = nextHandle();
            pixelShaders.set(handle, { functionCode });
            out.handle = handle;
            return D3D_OK;
        },

        /** @param {number} handle */
        SetPixelShader(handle){
            if (handle !== 0 && !pixelShaders.has(handle))
            {
                return D3DERR_INVALIDCALL;
            }
            boundPixelShader = handle >>> 0;
            return D3D_OK;
        },

        /** @param {{ handle?: number }} out */
        GetPixelShader(out){
            out.handle = boundPixelShader;
            return D3D_OK;
        },

        /** @param {number} handle */
        DeletePixelShader(handle){
            if (!pixelShaders.delete(handle))
            {
                return D3DERR_INVALIDCALL;
            }
            if (boundPixelShader === handle)
            {
                boundPixelShader = 0;
            }
            return D3D_OK;
        },

        /**
         * What the two stages are running, decided once here so that no caller
         * has to read the vertex shader handle and reach its own conclusion.
         * The two answers are independent: a draw can have a fixed-function
         * vertex stage and a programmable fragment stage at the same time, and
         * a flag that looks only at the vertex side drops the pixel shader.
         */
        get stageProcessing(){
            const shader = isShaderHandle(boundVertexShader);
            return {
                vertexShader: shader ? boundVertexShader : 0,
                fvf: shader ? 0 : boundVertexShader,
                fixedFunctionVertex: !shader,
                pixelShader: boundPixelShader,
            };
        },
    };

    return device;
}

/**
 * @param {{ Usage: number, Pool: number, Type: number }} desc
 * @returns {string} the SURFACE_TYPE the validity tables distinguish
 */
function surfaceTypeOf(desc){
    if ((desc.Usage & D3DUSAGE.DEPTHSTENCIL) !== 0)
    {
        return SURFACE_TYPE.DEPTH_STENCIL;
    }
    if ((desc.Usage & D3DUSAGE.RENDERTARGET) !== 0)
    {
        return SURFACE_TYPE.RENDER_TARGET;
    }
    return SURFACE_TYPE.PLAIN;
}

