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
    D3DCLEAR, D3DCREATE, D3DDEVTYPE, D3DERR_DEVICELOST, D3DERR_DEVICENOTRESET,
    D3DERR_INVALIDCALL, D3DERR_NOTAVAILABLE, D3DERR_NOTFOUND, D3DFMT, D3DLIGHTTYPE, D3DPOOL,
    D3DFMT_VERTEXDATA, D3DPRESENTFLAG, D3DRTYPE, D3DSBT, D3DTS, D3DUSAGE, D3D_OK, FORMAT_INFO,
    blockAligned, isCompressed, isShaderHandle,
    surfaceBytes, surfacePitch,
} from './constants.js';
import { GAMMA_RAMP_ENTRIES } from './structs.js';
import { DEFAULT_RENDER_STATES, createDefaultRenderStates } from './renderstates.js';
import { createDefaultStageStates } from './stagestates.js';
import { IDENTITY, STAGE_COUNT, createRenderer, sameLight, vertexCountOf } from './render.js';
import { applyBlock, captureBlock, emptyBlock, fillBlock } from './stateblock.js';
import { processStreams } from './process.js';
import { POSITION_MASK, decodeFvf } from '../webgpu/internal/vertexformat.js';
import {
    SURFACE_TYPE, copyRectsResult, createResult, imageSurfaceCreateResult,
    reportedBackBufferCount, targetPairResult, validatePresentParameters, validateStages,
} from './validity.js';
import {
    createPriority, createReferenceCount, createSurface, createTexture, createVolumeTexture,
    rectMoveOf, regionAtLevel, volumeUpdate, writeFrontBuffer, writePixels,
} from '../d3d9/resources.js';
import { volumeCreateResult, volumeLevelCount } from '../d3d9/validity.js';
import { DEVICE_STATE, LIGHT_ENABLED, createPalettes } from '../d3d9/device.js';
import { createAdditionalChain } from '../d3d9/swapchain.js';
import { fullTarget, viewportState } from '../webgpu/internal/viewport.js';
import {
    constantsWithin, declaredShader, parseDeclaration, readableByFixedFunction,
} from './declaration.js';
import { elementsOfFvf, fixedFunctionLayoutOf } from '../d3d9/declaration.js';
import { SHADER_KIND, createConstantFile, functionOf, parseShader } from '../d3d9/shader.js';

export { DEVICE_STATE, LIGHT_ENABLED };

/**
 * @typedef {Object} DeviceCaps
 * @property {number} maxPointSize     Decides the POINTSIZE_MAX default.
 * @property {boolean} [compressedTextures]  Whether an upload keeps DXT blocks as BC
 *           on the GPU (true) or decodes them to `bgra8unorm` (false); every DXT
 *           format is creatable either way.
 * @property {boolean} depthTexture2d  Whether depth formats are usable as textures,
 * @property {boolean} depthCube       as cube maps,
 * @property {boolean} depthPlain      and as image surfaces.
 * @property {number} [maxVolumeExtent]  The longest axis a volume texture may have.
 * @property {{ major: number, minor: number }} [vertexShaderVersion]
 *           The newest vertex shader a create accepts; 0.0 makes none.
 * @property {number} [maxVertexShaderConst]  The vertex shader's float constant registers.
 * @property {{ major: number, minor: number }} [pixelShaderVersion]
 *           The newest pixel shader a create accepts; 0.0 makes none.
 * @property {boolean} [fullscreenGamma]
 *     Whether a full-screen device's gamma ramp reaches the picture, which
 *     D3DCAPS2_FULLSCREENGAMMA claims. Decided by the display, not asked for.
 */

/** @type {DeviceCaps} */
export const DEFAULT_CAPS = Object.freeze({
    maxPointSize: 64.0,
    depthTexture2d: false,
    compressedTextures: false,
    depthCube: false,
    depthPlain: false,
    maxVolumeExtent: 256,
    vertexShaderVersion: Object.freeze({ major: 1, minor: 1 }),
    maxVertexShaderConst: 256,
    pixelShaderVersion: Object.freeze({ major: 1, minor: 4 }),
});

/** Direct3D 8's pixel shader constant registers, c0 to c7. */
const PIXEL_CONSTANTS = 8;

/**
 * @typedef {Object} VertexShader8
 *     What a vertex shader handle names.
 * @property {number} handle
 * @property {import('./declaration.js').Declaration8} declaration
 * @property {Uint32Array | null} tokens  The function as the program gave it, if any.
 * @property {import('../d3d9/shader.js').ParsedShader | null} parsed
 *           The function as the translator reads it, its inputs declared.
 * @property {import('../d3d9/declaration.js').FixedFunctionLayout | null} layout
 *           How the fixed-function stage reads the declaration, for a handle
 *           with no function.
 */

/**
 * @typedef {Object} PixelShader8
 *     What a pixel shader handle names.
 * @property {number} handle
 * @property {Uint32Array} tokens  The function as the program gave it.
 * @property {import('../d3d9/shader.js').ParsedShader} parsed
 */

/**
 * Whether a function is a shader of this kind no newer than a version.
 *
 * @param {import('../d3d9/shader.js').ParsedShader} parsed
 * @param {string} kind  A SHADER_KIND.
 * @param {{ major: number, minor: number } | undefined} newest
 */
function withinVersion(parsed, kind, newest){
    const { major, minor } = parsed.version;
    const limit = newest ?? { major: 0, minor: 0 };
    return !parsed.error && parsed.version.kind === kind && major === 1
        && (major < limit.major || (major === limit.major && minor <= limit.minor));
}

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

/**
 * What the device reports as texture memory.
 *
 * A program asking this is sizing a cache rather than allocating anything, and
 * what it does with a small answer is evict and reload -- so the number has to
 * describe what this device actually does with a texture, which is hold it.
 * Nothing here is ever discarded to make room: a texture's storage is the
 * guest's own memory, and the copy on the GPU lives as long as the texture
 * does. An answer that implies otherwise makes a program work to avoid a
 * pressure that does not exist.
 *
 * Two hundred and fifty-six megabytes: comfortably above what a program of this
 * era will try to keep resident, and far enough below a signed 32-bit boundary
 * that arithmetic on it cannot go negative in a caller that treats it as one.
 */
const AVAILABLE_TEXTURE_MEMORY = 256 << 20;

/** The render states a state block leaves alone, by their own declaration. */
const NOT_CAPTURED_BY_STATE_BLOCK = new Set(DEFAULT_RENDER_STATES
    .filter(entry=>entry.capturedByStateBlock === false)
    .map(entry=>entry.state));

/**
 * @typedef {Object} GammaRamp
 * @property {Uint16Array} red
 * @property {Uint16Array} green
 * @property {Uint16Array} blue
 */

/**
 * The ramp a display has before a program sets one, each entry standing for
 * itself. The scale is the eight-bit index widened to sixteen bits by 257, so
 * that the last entry is the largest value rather than one short of it.
 *
 * @returns {GammaRamp}
 */
function identityGammaRamp(){
    const channel = ()=>Uint16Array.from(
        { length: GAMMA_RAMP_ENTRIES }, (_, index)=>index * 257);
    return { red: channel(), green: channel(), blue: channel() };
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
 * @property {(address: number, length: number)=>Uint8Array} [windowMemory]
 *     The same bytes without the copy, for a reader done with them at once.
 * @property {(address: number, bytes: Uint8Array)=>void} [writeMemory]
 *     How a lock of a render target brings the drawn pixels into the guest's
 *     bytes. Absent, the lock hands out the bytes as they are and says so.
 * @property {(descriptor: any)=>any} [createSampler]
 * @property {(bytes: number)=>number} [allocate]
 *     Guest memory for a resource's bytes. A lock hands the program an address
 *     it writes through and the unlock reads those bytes back, so it has to be
 *     memory the guest can reach. Absent, addresses are invented -- which works
 *     exactly until something reads one.
 * @property {(address: number)=>void} [free]
 *     Gives that memory back when the last reference to a resource goes.
 *     Absent, storage is held for the life of the process -- which the program
 *     reads back as memory disappearing, and answers by evicting its own
 *     assets and loading them again.
 * @property {boolean} [dumpDraws]
 *     Ask the renderer for a per-draw account of the last frame. Off by
 *     default: it costs a transform of every vertex of every draw.
 * @property {number} [maxDraws]
 *     Cut every frame short after this many draws. Negative keeps all of them.
 * @property {(api: string, detail: string)=>void} [divergence]
 *     Where "this call succeeded and did not do all of what it promises" goes.
 * @property {string} [skipTexture]
 *     Drop every draw that samples the texture with this dump id.
 * @property {string} [probeTexture]
 *     Copy the target out after each dumped draw that samples this texture.
 * @property {boolean} [fog]
 *     Whether fog is applied at all. Off, every draw renders as if the
 *     program had never enabled it: a frame that clears up with it was fog.
 * @property {boolean} [mips]
 *     Whether textures are sampled below their top level. Off, every sample
 *     comes from the top level, so a frame that changes with it was mips.
 * @property {(watcher: () => void) => () => void} [onDeviceLost]
 *     Calls the watcher once the GPU underneath is gone for good, at once if it
 *     already is; returns how to stop watching. Absent, the GPU never goes.
 * @property {import('../webgpu/internal/presenter.js').DisplayGamma} [gamma]
 *     Where a full-screen device's gamma ramp reaches the picture. Absent, a
 *     ramp is kept and read back only.
 * @property {import('../webgpu/internal/latency.js').FrameQueued} [frameQueued]
 *     Told of every frame a present queues; what it answers is what the
 *     present waits on before it answers the program. Absent, a present never
 *     waits.
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
/**
 * How many levels a texture has when a program asks for zero: every one down
 * to a single texel, which is what zero means and what the program then locks.
 *
 * @param {number} width @param {number} height
 */
function fullChainOf(width, height){
    return Math.floor(Math.log2(Math.max(width, height, 1))) + 1;
}

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
        // Rebuilt field by field, so anything left out here is dropped however
        // faithfully it was read in. The flags decide what the swap chain will
        // allow at all, which is not a detail to lose in transit.
        flags: parameters.flags ?? 0,
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
    const {
        backend, readMemory, windowMemory, writeMemory, createSampler, allocate: guestMemory,
        free: giveBack, dumpDraws, maxDraws, divergence, skipTexture, probeTexture, fog, mips,
        onDeviceLost, gamma, frameQueued, ...caps
    } = options;
    /** @type {DeviceCaps} */
    const resolved = { ...DEFAULT_CAPS, ...caps, fullscreenGamma: gamma?.applies() === true };
    /** @type {DeviceServices} */
    const services = {
        backend, readMemory, windowMemory, writeMemory, createSampler, allocate: guestMemory,
        free: giveBack, dumpDraws, maxDraws, divergence, skipTexture, probeTexture, fog, mips,
        onDeviceLost, gamma, frameQueued,
    };
    if (backend && !readMemory)
    {
        throw new Error('graphics/d3d8: a device that draws needs readMemory as well as a backend');
    }
    const count = createReferenceCount();
    const root = {
        caps: resolved,
        get refCount(){
            return count.value;
        },
        addRef: ()=>count.addRef(),
        release: ()=>count.release(),

        /**
         * Whether a resource of this kind could be made in this format.
         *
         * Answered by the table the creates themselves consult rather than by a
         * list of its own, so that a program told yes here is told yes there.
         * A kind of resource this build does not make in a format -- a buffer
         * -- is not available in any.
         *
         * @param {number} usage
         * @param {number} resourceType  D3DRTYPE
         * @param {number} format
         * @returns {number} D3D_OK or D3DERR_NOTAVAILABLE
         */
        CheckDeviceFormat(usage, resourceType, format){
            if (resourceType === D3DRTYPE.VOLUMETEXTURE)
            {
                return volumeCreateResult({
                    width: 1, height: 1, depth: 1, levels: 1, usage, format,
                    pool: D3DPOOL.DEFAULT, maxExtent: 1,
                }) === D3D_OK ? D3D_OK : D3DERR_NOTAVAILABLE;
            }
            const surfaceType = resourceType === D3DRTYPE.TEXTURE
                ? SURFACE_TYPE.TEXTURE_2D
                : resourceType === D3DRTYPE.CUBETEXTURE
                    ? SURFACE_TYPE.CUBE
                    : surfaceTypeOfUsage(resourceType, usage);
            if (!surfaceType)
            {
                return D3DERR_NOTAVAILABLE;
            }
            return createResult(surfaceType, format, D3DPOOL.DEFAULT, usage, resolved) === D3D_OK
                ? D3D_OK
                : D3DERR_NOTAVAILABLE;
        },

        /**
         * @param {number} adapterFormat
         * @param {number} backBufferFormat
         * @returns {number}
         */
        CheckDeviceType(adapterFormat, backBufferFormat){
            return isColourFormat(adapterFormat) && isColourFormat(backBufferFormat)
                ? D3D_OK
                : D3DERR_NOTAVAILABLE;
        },

        /**
         * One sample per pixel and no other count. This build renders no
         * multisampled target, so every other type is unavailable -- which is
         * the answer that keeps a program from asking for one.
         *
         * @param {number} multiSampleType
         */
        CheckDeviceMultiSampleType(multiSampleType){
            return multiSampleType === 0 ? D3D_OK : D3DERR_NOTAVAILABLE;
        },

        /**
         * @param {number} renderTargetFormat
         * @param {number} depthStencilFormat
         */
        CheckDepthStencilMatch(renderTargetFormat, depthStencilFormat){
            return isColourFormat(renderTargetFormat) && isDepthFormat(depthStencilFormat)
                ? D3D_OK
                : D3DERR_NOTAVAILABLE;
        },

        /**
         * @param {import('./validity.js').PresentParameters} parameters
         *        Written back through, the way the guest passes a pointer.
         * @param {{ device?: ReturnType<typeof createDeviceObject> }} out
         * @param {number} [behaviourFlags]
         * @param {Partial<CreationParameters>} [creation]
         *        What the call was made with, kept so the device can answer with
         *        it rather than with a description of itself.
         * @returns {number}
         */
        CreateDevice(parameters, out, behaviourFlags = 0, creation = {}){
            const hr = validatePresentParameters(parameters);
            if (hr !== D3D_OK)
            {
                return hr;
            }
            // A device holds a reference on the object that made it, which it
            // gives back when it goes: a program may release that object at
            // once and still reach it through GetDirect3D (Wine's d3d8 and
            // d3d9 test_refcount).
            root.addRef();
            out.device = createDeviceObject(
                normalisePresentParameters(parameters), resolved, behaviourFlags, services, {
                    direct3D: root,
                    AdapterOrdinal: creation.AdapterOrdinal ?? 0,
                    DeviceType: creation.DeviceType ?? D3DDEVTYPE.HAL,
                    hFocusWindow: creation.hFocusWindow ?? 0,
                    BehaviorFlags: behaviourFlags,
                });
            reportPresentParameters(parameters);
            return D3D_OK;
        },
    };
    return root;
}

/**
 * @typedef {Object} CreationParameters
 * @property {number} AdapterOrdinal
 * @property {number} DeviceType
 * @property {number} hFocusWindow
 * @property {number} BehaviorFlags
 */

/**
 * @typedef {CreationParameters & { direct3D: any }} DeviceIdentity
 *     Everything about a device that came from the call that made it, including
 *     the object it was made through.
 */

/** @typedef {import('./stateblock.js').StateBlock} StateBlock */

/**
 * @typedef {Object} SurfaceMove
 *     One rectangle of one copy, as addresses in the guest's own memory.
 * @property {number} from
 * @property {number} to
 * @property {number} rowBytes
 * @property {number} rows
 * @property {number} fromPitch
 * @property {number} toPitch
 */

/**
 * @param {import('./validity.js').PresentParameters} parameters
 * @param {DeviceCaps} caps
 * @param {number} behaviourFlags
 * @param {DeviceServices} services
 * @param {DeviceIdentity} [identity]
 */
function createDeviceObject(parameters, caps, behaviourFlags, services, identity){
    /** Formats already reported, so a refusal in a loop says it once. */
    const refusedFormats = new Set();
    /** Divergences already reported, by what makes each one of a kind. */
    const reported = new Set();
    /** @param {string} key @param {string} detail */
    const reportOnce = (key, detail)=>{
        if (!services.divergence || reported.has(key))
        {
            return;
        }
        reported.add(key);
        services.divergence('Direct3D 8', detail);
    };

    /**
     * A refusal a program can act on, but only if it is told which format was
     * refused. Saying nothing is how an unsupported format costs a run its art
     * with no trace anywhere: the program takes a slower path of its own, and
     * everything after that looks merely slow rather than wrong.
     *
     * @param {number} format D3DFMT
     */
    const reportRefusedFormat = format=>{
        if (!services.divergence || refusedFormats.has(format))
        {
            return;
        }
        refusedFormats.add(format);
        const name = Object.entries(D3DFMT).find(entry=>entry[1] === format);
        services.divergence('Direct3D 8',
            `a texture in format ${name ? name[0] : format} was refused: this device`
            + ' does not offer it, and a program with no other copy of the art will'
            + ' either convert it itself or go without');
    };

    let presentParameters = parameters;
    /** @type {string} */
    let deviceState = DEVICE_STATE.OK;
    let inScene = false;
    /**
     * Where storage goes when nobody gave us real memory to put it in.
     *
     * A locked surface or buffer hands the program an address it writes
     * through, and the unlock reads those bytes back -- so the address has to
     * be memory the guest can actually reach. Fabricating one works only until
     * something reads it, which is the moment a program stops merely creating
     * resources and starts filling them.
     */
    let nextAddress = 0x40000000;
    /** Addresses this layer invented rather than took from the guest's heap. */
    const fabricated = new Set();
    const softwareVertexProcessing =
        (behaviourFlags & D3DCREATE.SOFTWARE_VERTEXPROCESSING) !== 0;

    /** @type {Map<number, number>} */
    let renderStates = defaultStates();

    /** @type {Map<number, { light: Light, enabled: boolean }>} */
    let lights = new Map();
    // Raised whenever the lights change, so a reader that keeps a sorted list
    // of the enabled ones knows when it is stale, without building it per draw.
    let lightsVersion = 0;
    /**
     * Raised by every state change a draw's preparation depends on, so that a
     * renderer prepares once per change instead of once per draw.
     *
     * The world transform is the one state deliberately left out, because it
     * moves between most draws and a counter it raised would never hold still.
     * Whoever reads this therefore owes the world matrix a fresh read on every
     * draw -- and nothing else derived from it may be kept across draws.
     */
    let drawStateVersion = 1;
    /**
     * The share of `drawStateVersion` that texture bindings raised. The
     * difference is a version of every other piece of that state, which is
     * what a program that binds a new texture before most draws leaves still.
     */
    let textureBindingVersion = 0;

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
     * @type {Map<number, VertexShader8>}
     */
    const vertexShaders = new Map();
    /** @type {Map<number, PixelShader8>} */
    const pixelShaders = new Map();
    /**
     * The elements a vertex format spells, for a pixel shader drawn over the
     * fixed-function vertex stage: made once a format.
     *
     * @type {Map<number, readonly import('../d3d9/declaration.js').VertexElement[] | null>}
     */
    const formatElements = new Map();
    let nextShaderHandle = 1;
    let boundVertexShader = 0;
    let boundPixelShader = 0;
    // This version has float constants only; the integer and boolean files
    // are there because the translator's constant blocks carry all three.
    const vertexConstants = createConstantFile(
        { floats: caps.maxVertexShaderConst ?? 256, ints: 16, bools: 16 });
    const pixelConstants = createConstantFile({ floats: PIXEL_CONSTANTS, ints: 16, bools: 16 });

    /** @type {Map<number, Float32Array>} index -> the four coefficients */
    let clipPlanes = new Map();

    /**
     * The two clip words a program reads back. Nothing here computes them --
     * this device transforms on the GPU and never reports which planes a vertex
     * fell outside of -- so what comes back is what went in.
     */
    let clipStatus = { ClipUnion: 0, ClipIntersection: 0 };

    /** @type {GammaRamp} */
    let gammaRamp = identityGammaRamp();
    /** Whether the program set a ramp, and whether the display shows it now. */
    let gammaSet = false;
    let gammaShown = false;
    /**
     * Puts the device's ramp on the display, or takes it back. A full-screen
     * device's ramp is the display's (D3DCAPS2_FULLSCREENGAMMA); a windowed
     * one's is kept and read back and changes nothing on the screen, and a
     * device that goes gives the display back the ramp it had before.
     *
     * @param {boolean} [going]
     */
    const showGamma = (going = false)=>{
        const shown = caps.fullscreenGamma === true && gammaSet && !going
            && !presentParameters.windowed;
        if (shown)
        {
            services.gamma?.set(device, gammaRamp);
        }
        else if (gammaShown)
        {
            services.gamma?.set(device, null);
        }
        gammaShown = shown;
    };
    /**
     * The cursor the program asked the device to draw over its frames: the
     * surface it gave and where the hot spot is in it, and whether it is to
     * be shown. Nothing here draws it; whoever shows the presented frame
     * is told and shows it the way its own screen can.
     *
     * @type {{ hotSpot: { x: number, y: number }, surface: any, shown: boolean }}
     */
    let cursor = { hotSpot: { x: 0, y: 0 }, surface: null, shown: false };

    /** @type {Map<number, StateBlock>} */
    const stateBlocks = new Map();
    /** @type {StateBlock | null} The block being recorded, if one is. */
    let recording = null;
    // How many times a program set a matrix it had already set. A large share
    // says the saving is worth chasing further -- into a stub the guest can run
    // without leaving the machine at all, which is the only way the crossing
    // itself goes away too.
    let redundantTransforms = 0;
    /**
     * What `stageProcessing` last answered, and the bindings it answered for.
     * A shader object is made once and never changed, so the same objects
     * bound the same way are the same answer.
     *
     * @type {{ vertexShader: number, pixelShader: number, shader: unknown, pixel: unknown,
     *     answer: any }}
     */
    const heldProcessing = { vertexShader: 0, pixelShader: 0, shader: null, pixel: null,
        answer: null };
    let nextStateBlock = 1;

    const count = createReferenceCount();

    const renderer = services.backend
        ? createRenderer({
            backend: services.backend,
            readMemory: /** @type {(address: number, length: number)=>Uint8Array} */ (
                services.readMemory),
            windowMemory: services.windowMemory,
            createSampler: services.createSampler ?? null,
            dumpDraws: services.dumpDraws === true,
            maxDraws: services.maxDraws,
            divergence: services.divergence,
            skipTexture: services.skipTexture ?? null,
            probeTexture: services.probeTexture ?? null,
            fog: services.fog,
            mips: services.mips,
            compressedTextures: caps.compressedTextures,
        })
        : null;

    /**
     * How a lockable render target reaches its pixels: read back off the GPU
     * before the lock, uploaded after the unlock. Absent when the renderer
     * cannot do either, and the lock then says so as a divergence.
     *
     * @returns {import('../d3d9/resources.js').TargetPixels | undefined}
     */
    const targetPixels = ()=>{
        const write = services.writeMemory;
        if (!renderer?.readSurface || !write)
        {
            return undefined;
        }
        return {
            readBack: surface=>renderer.readSurface(surface).then(
                (/** @type {{ data: Uint8Array }} */ pixels)=>{
                    writePixels(surface, pixels.data, write);
                }),
            written: surface=>renderer.markDirty(surface),
        };
    };

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
        // Real guest memory when the assembling caller supplied a way to get
        // some, and given back when the last reference goes -- see `free`.
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
        fabricated.add(address);
        return address;
    };

    /**
     * Gives a resource's storage back.
     *
     * The arena a texture's pixels come out of is the one the program's own
     * allocator draws from, and the program sizes its asset cache from what
     * that arena reports free -- so storage held for a resource nobody
     * references does not merely cost address space, it tells the program to
     * evict what it has and load it again.
     *
     * An address this layer invented for itself was never the allocator's to
     * begin with; handing it back would free somebody else's block.
     *
     * @param {number} address
     */
    const free = address=>{
        if (address === 0 || fabricated.has(address))
        {
            return;
        }
        services.free?.(address);
    };

    /**
     * A resource the program owns: it took a reference on the device, and
     * while it lives in the default pool it also blocks a Reset.
     *
     * @param {number} pool
     * @param {() => void} [onGone]  What the resource gives back when its last
     *     reference goes, before the device's is released.
     */
    const explicitCount = (pool, onGone = ()=>{})=>{
        count.addRef();
        const blocking = pool === D3DPOOL.DEFAULT;
        if (blocking)
        {
            liveDefaultPoolResources++;
        }
        return createReferenceCount({
            onLastRef: ()=>{
                onGone();
                count.release();
                if (blocking)
                {
                    liveDefaultPoolResources--;
                }
            },
        });
    };

    /**
     * A surface made on its own, not a level of anything: its storage goes
     * back once the program's last reference does, as a texture's does, or
     * every render target a program makes and releases stays taken until the
     * heap is gone.
     *
     * @param {any} surface
     */
    const retireSurface = surface=>{
        free(surface.base);
        renderer?.retire(surface);
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

    /**
     * A bound resource handed back with the reference the call owes. One the
     * program released to nothing while it stayed bound is gone here, where
     * Windows keeps it until it is unbound; it is answered as nothing, and
     * said once, rather than ending the run on a reference it cannot take.
     *
     * @param {any} resource @param {string} what  The getter, for the report.
     * @returns {any}
     */
    const handOut = (resource, what)=>{
        if (!resource)
        {
            return null;
        }
        if (resource.refCount === 0 && resource.destroyed !== false)
        {
            reportOnce(`released-while-bound:${what}`, `${what} answers NULL for a resource `
                + 'released to nothing while bound, which Windows keeps until it is unbound');
            return null;
        }
        resource.addRef();
        return resource;
    };

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
        // The surfaces a Reset replaces give their storage back, as Direct3D 9's
        // do: each Reset to another size kept the old ones' otherwise.
        retireImplicitResources();
        for (let index = 0; index < (presentParameters.backBufferCount ?? 1); index++)
        {
            backBuffers.push(createSurface({
                type: SURFACE_TYPE.RENDER_TARGET,
                width,
                height,
                format: presentParameters.backBufferFormat ?? D3DFMT.X8R8G8B8,
                pool: D3DPOOL.DEFAULT,
                usage: D3DUSAGE.RENDERTARGET,
                // A back buffer is lockable exactly when the program asked for
                // one, and a program that asked reads it back every frame. The
                // flag was parsed out of the parameters and then never looked
                // at, so every such read was refused.
                lockable: ((presentParameters.flags ?? 0)
                    & D3DPRESENTFLAG.LOCKABLE_BACKBUFFER) !== 0,
                divergence: services.divergence ?? null,
                pixels: targetPixels(),
                // The surface's own size, like every other surface's. A fixed
                // megabyte covered nothing above 512x512 at four bytes a pixel:
                // a lock hands out this address and the program reads and writes
                // the whole surface through it, so a mode any larger ran off the
                // end of the allocation and into whatever the heap put next --
                // further past it the larger the mode, which is a corruption
                // whose reach depends on the display the run was configured for.
                base: allocate(surfaceBytes(
                    presentParameters.backBufferFormat ?? D3DFMT.X8R8G8B8, width, height)),
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
                base: allocate(surfaceBytes(
                    presentParameters.autoDepthStencilFormat ?? D3DFMT.D24S8, width, height)),
                count: implicitCount(),
            })
            : null;
        renderTarget = backBuffers[0];
        depthStencil = autoDepthStencil;
        viewport = fullTarget({ width, height });
    }

    /**
     * The device's own surfaces give their storage back: those a Reset
     * replaces, and all of them when the device's last reference goes -- no
     * program can hold one then, since each it holds is a reference on the
     * device.
     */
    function retireImplicitResources(){
        for (const surface of backBuffers)
        {
            retireSurface(surface);
        }
        if (autoDepthStencil)
        {
            retireSurface(autoDepthStencil);
        }
        backBuffers = [];
        autoDepthStencil = null;
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
     * Whether a matrix a program is setting is the one already there.
     *
     * @param {Float32Array} held @param {ArrayLike<number>} given
     */
    const sameMatrix = (held, given)=>{
        for (let at = 0; at < 16; at++)
        {
            if (held[at] !== given[at])
            {
                return false;
            }
        }
        return true;
    };

    /**
     * The device's state, as a state block reads and writes it.
     *
     * @type {import('./stateblock.js').StateView}
     */
    const stateView = {
        get renderStates(){
            return renderStates;
        },
        stageStates: stageStatesFor,
        stageCount: STAGE_COUNT,
        textures,
        get transforms(){
            return transforms;
        },
        get lights(){
            return lights;
        },
        defaultLight,
        stream,
        streams,
        get clipPlanes(){
            return clipPlanes;
        },
        get material(){
            return material;
        },
        set material(value){
            material = value;
        },
        get viewport(){
            return viewport;
        },
        set viewport(value){
            viewport = value;
        },
        get indices(){
            return { buffer: indices, base: baseVertexIndex };
        },
        set indices(value){
            indices = value.buffer;
            baseVertexIndex = value.base;
        },
        get vertexShader(){
            return boundVertexShader;
        },
        set vertexShader(value){
            boundVertexShader = value;
        },
        get pixelShader(){
            return boundPixelShader;
        },
        set pixelShader(value){
            boundPixelShader = value;
        },
        vertexConstants: vertexConstants.floats,
        pixelConstants: pixelConstants.floats,
    };

    /**
     * How far apart two rows of a surface are. The surfaces here are laid out
     * tightly, so this is the same arithmetic `createSurface` does; a format
     * whose lock counts blocks rather than pixels would need its own answer,
     * and this layer creates none.
     *
     * @param {import('../d3d9/resources.js').SurfaceDesc} desc
     */
    const pitchOf = desc=>surfacePitch(desc.Format, desc.Width);

    /**
     * A whole surface, as one move.
     *
     * @param {any} source
     * @param {any} destination
     * @returns {SurfaceMove}
     */
    const wholeSurfaceMove = (source, destination)=>{
        const from = describe(source);
        const to = describe(destination);
        return {
            from: source.base,
            to: destination.base,
            rowBytes: Math.min(pitchOf(from), pitchOf(to)),
            rows: Math.min(from.Height, to.Height),
            fromPitch: pitchOf(from),
            toPitch: pitchOf(to),
        };
    };

    /**
     * The surface of a texture level, without leaving a reference behind: the
     * count is the texture's own, so taking one and giving it straight back
     * leaves the caller's ownership exactly as it found it.
     *
     * @param {any} texture
     * @param {number} level
     * @param {number} [face]  A cube map's; a texture of one face has only the first.
     */
    const levelSurface = (texture, level, face = 0)=>{
        /** @type {{ surface?: any }} */
        const held = {};
        if ((texture.cube
            ? texture.GetCubeMapSurface(face, level, held)
            : texture.GetSurfaceLevel(level, held)) !== D3D_OK || !held.surface)
        {
            return null;
        }
        held.surface.release();
        return held.surface;
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
        const base = allocate(spec.length);
        // Its storage goes back with its last reference, as a Direct3D 9
        // buffer's does.
        const bufferCount = explicitCount(spec.pool, ()=>free(base));
        let locked = false;
        const buffer = {
            ...spec,
            base,
            ...createPriority(spec.pool),
            get refCount(){
                return bufferCount.value;
            },
            addRef: ()=>bufferCount.addRef(),
            release: ()=>bufferCount.release(),
            get destroyed(){
                return bufferCount.destroyed;
            },
            /** The device binds it (see `createReferenceCount`). */
            hold: ()=>bufferCount.hold?.(),
            letGo: ()=>bufferCount.letGo?.(),

            /**
             * What the buffer was made as. A vertex buffer's format is
             * D3DFMT_VERTEXDATA whatever it holds; the vertex it holds is the
             * FVF it was made with, zero for none.
             *
             * @param {{ desc?: any }} out
             */
            GetDesc(out){
                out.desc = {
                    Format: spec.type === D3DRTYPE.INDEXBUFFER ? spec.format : D3DFMT_VERTEXDATA,
                    Type: spec.type,
                    Usage: spec.usage,
                    Pool: spec.pool,
                    Size: spec.length,
                    FVF: spec.fvf ?? 0,
                };
                return D3D_OK;
            },

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
     * Tokens handed to a caller who says how much room it has: its size in
     * bytes with no room given, the tokens when they fit, and a refusal that
     * leaves the caller's size alone when they do not.
     *
     * @param {Uint32Array} tokens
     * @param {{ bytes?: number, tokens?: Uint32Array }} out
     * @param {number | null} room
     */
    const handOver = (tokens, out, room)=>{
        if (room !== null && room < tokens.length * 4)
        {
            return D3DERR_INVALIDCALL;
        }
        out.bytes = tokens.length * 4;
        if (room !== null)
        {
            out.tokens = tokens;
        }
        return D3D_OK;
    };

    /**
     * @param {number} fvf
     * @returns {readonly import('../d3d9/declaration.js').VertexElement[] | null}
     */
    const elementsOfFormat = fvf=>{
        if ((fvf & POSITION_MASK) === 0)
        {
            return null;
        }
        if (!formatElements.has(fvf))
        {
            formatElements.set(fvf, elementsOfFvf(fvf));
        }
        return formatElements.get(fvf) ?? null;
    };

    /**
     * @param {import('../d3d9/shader.js').ConstantFile} file
     * @param {'vertexConstants' | 'pixelConstants'} recorded  The block's map of them.
     * @param {number} register @param {ArrayLike<number>} values @param {number} registers
     */
    const setConstants = (file, recorded, register, values, registers)=>{
        if (!values || register < 0 || registers < 0
            || register + registers > file.floats.length / 4)
        {
            return D3DERR_INVALIDCALL;
        }
        if (!recording)
        {
            return file.setF(register, values, registers);
        }
        for (let at = 0; at < registers; at++)
        {
            recording[recorded].set(register + at,
                Float32Array.from({ length: 4 }, (_, index)=>values[at * 4 + index]));
        }
        return D3D_OK;
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
        streamAt: stream,
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
        get lights(){
            return lights;
        },
        get lightsVersion(){
            return lightsVersion;
        },
        get drawStateVersion(){
            return drawStateVersion;
        },
        get stateVersionBesideTextures(){
            return drawStateVersion - textureBindingVersion;
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
        if (!inScene || vertexCountOf(type, primitiveCount) === 0)
        {
            return D3DERR_INVALIDCALL;
        }
        // A vertex format with no position is not a format, and there is
        // nothing to draw without either that or a shader.
        if (!isShaderHandle(boundVertexShader) && (boundVertexShader & 0xe) === 0)
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
        stream(0).buffer?.letGo?.();
        stream(0).buffer = null;
        indices?.letGo?.();
        indices = null;
        baseVertexIndex = 0;
    };

    /** @type {(() => void) | undefined} */
    let stopWatchingLoss;

    /**
     * A present's answer, once its frame is queued: at once, or once the
     * device has finished enough of the frames before it.
     *
     * @param {Promise<void> | undefined} submitted  settled when the frame is on the queue
     * @returns {number | Promise<number>}
     */
    const presented = submitted=>{
        const held = submitted ? services.frameQueued?.(submitted) ?? null : null;
        return held ? held.then(()=>D3D_OK) : D3D_OK;
    };

    /**
     * An additional swap chain's back buffer presented: onto the display
     * when it goes into the window the display shows, and otherwise drawn and
     * kept, which is reported once.
     *
     * @param {any} backBuffer @param {boolean} shown
     * @returns {number | Promise<number>}
     */
    const presentChain = (backBuffer, shown)=>{
        if (deviceState !== DEVICE_STATE.OK)
        {
            return D3DERR_DEVICELOST;
        }
        if (shown)
        {
            return presented(renderer?.present(
                Object.create(model, { backBuffer: { get: ()=>backBuffer } })));
        }
        reportOnce('chain-window', 'a swap chain presented into a window the display does'
            + ' not show: its frame is drawn and its picture is not shown');
        return presented(renderer?.submit());
    };

    const device = {
        caps,
        get refCount(){
            return count.value;
        },
        addRef: ()=>count.addRef(),
        release: ()=>{
            const before = count.value;
            const left = count.release();
            if (left === 0 && before > 0)
            {
                stopWatchingLoss?.();
                showGamma(true);
                retireImplicitResources();
                // The reference CreateDevice took on the object that made it.
                identity?.direct3D?.release?.();
            }
            return left;
        },

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
         * The object this device was made through, which a program asks for so
         * that it can enumerate or check a format without having kept one.
         *
         * @param {{ direct3D?: any }} out
         */
        GetDirect3D(out){
            if (!identity?.direct3D)
            {
                return D3DERR_INVALIDCALL;
            }
            identity.direct3D.addRef();
            out.direct3D = identity.direct3D;
            return D3D_OK;
        },

        /**
         * What CreateDevice was called with, unaltered. Nothing here is this
         * device describing itself, which is why none of it can be wrong.
         *
         * @param {{ parameters?: CreationParameters }} out
         */
        GetCreationParameters(out){
            if (!identity)
            {
                return D3DERR_INVALIDCALL;
            }
            out.parameters = {
                AdapterOrdinal: identity.AdapterOrdinal,
                DeviceType: identity.DeviceType,
                hFocusWindow: identity.hFocusWindow,
                BehaviorFlags: identity.BehaviorFlags,
            };
            return D3D_OK;
        },

        /** @returns {number} bytes, rounded the way this call always reports them */
        GetAvailableTextureMem(){
            return AVAILABLE_TEXTURE_MEMORY;
        },

        /**
         * Nothing here is managed on the device's behalf: a texture's storage
         * is the guest's own memory and is uploaded when it changes, so there
         * is nothing to discard however many bytes the caller asked for, and
         * the call has already done all it can.
         */
        ResourceManagerDiscardBytes(){
            return D3D_OK;
        },

        /**
         * The ramp is kept and handed back, and shown while the device is
         * full-screen on a display that applies one -- which is what
         * D3DCAPS2_FULLSCREENGAMMA says. Windowed, or where the capability is
         * not claimed, a program gets the state it wrote and the picture it
         * drew.
         *
         * @param {GammaRamp} ramp
         */
        SetGammaRamp(ramp){
            gammaRamp = {
                red: Uint16Array.from(ramp.red),
                green: Uint16Array.from(ramp.green),
                blue: Uint16Array.from(ramp.blue),
            };
            gammaSet = true;
            showGamma();
        },

        /**
         * The bitmap has to be A8R8G8B8 and the hot spot inside it, as the
         * interface demands of a program; the surface is kept rather than
         * copied, because the program keeps it too.
         *
         * @param {number} x @param {number} y @param {any} surface
         */
        SetCursorProperties(x, y, surface){
            if (!surface)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {{ desc?: any }} */
            const out = {};
            surface.GetDesc(out);
            const desc = out.desc;
            if (!desc || desc.Format !== D3DFMT.A8R8G8B8
                || x < 0 || y < 0 || x >= desc.Width || y >= desc.Height)
            {
                return D3DERR_INVALIDCALL;
            }
            cursor = { hotSpot: { x, y }, surface, shown: cursor.shown };
            return D3D_OK;
        },

        /**
         * @param {boolean} show
         * @returns {boolean} whether it was shown before
         */
        ShowCursor(show){
            const was = cursor.shown;
            cursor.shown = show;
            return was;
        },

        /** The cursor as set: for whoever shows it. */
        GetCursor(){
            return cursor;
        },

        ...createPalettes(),

        /** @param {{ ramp?: GammaRamp }} out */
        GetGammaRamp(out){
            out.ramp = {
                red: Uint16Array.from(gammaRamp.red),
                green: Uint16Array.from(gammaRamp.green),
                blue: Uint16Array.from(gammaRamp.blue),
            };
        },

        /**
         * A device that can be reset still cannot present: the two answers
         * differ, and a program that resets on the strength of Present alone
         * never learns that the device came back.
         *
         * @returns {number | Promise<number>}
         */
        Present(){
            if (deviceState !== DEVICE_STATE.OK)
            {
                return D3DERR_DEVICELOST;
            }
            return presented(renderer?.present(model));
        },

        /**
         * A swap chain beside the device's own, windowed only (Wine's d3d8
         * test_swapchain): back buffers of its own, at the size and in the
         * format its parameters give. As a creation does, it writes back the
         * back buffer count a zero stood for.
         *
         * @param {import('./validity.js').PresentParameters} asked
         * @param {{ swapChain?: any }} out
         */
        CreateAdditionalSwapChain(asked, out){
            if (!asked || asked.windowed === false || validatePresentParameters(asked) !== D3D_OK)
            {
                return D3DERR_INVALIDCALL;
            }
            reportPresentParameters(asked);
            const wanted = normalisePresentParameters(asked);
            const width = wanted.backBufferWidth ?? 640;
            const height = wanted.backBufferHeight ?? 480;
            const format = wanted.backBufferFormat ?? D3DFMT.X8R8G8B8;
            out.swapChain = createAdditionalChain({
                parameters: wanted,
                count: explicitCount(D3DPOOL.DEFAULT),
                // A back buffer's count is its own and not the chain's, as the
                // device's own back buffer's is: a reference on it is one on
                // the device, and one released to nothing leaves it the
                // chain's to take again (Wine's d3d8 test_refcount).
                makeBackBuffer: ()=>createSurface({
                    type: SURFACE_TYPE.RENDER_TARGET,
                    width,
                    height,
                    format,
                    pool: D3DPOOL.DEFAULT,
                    usage: D3DUSAGE.RENDERTARGET,
                    lockable: ((wanted.flags ?? 0) & D3DPRESENTFLAG.LOCKABLE_BACKBUFFER) !== 0,
                    divergence: services.divergence ?? null,
                    pixels: targetPixels(),
                    base: allocate(surfaceBytes(format, width, height)),
                    count: implicitCount(),
                }),
                present: presentChain,
                retire: surface=>{
                    free(surface.base);
                    renderer?.retire(surface);
                },
            });
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
            const drawn = renderer ? renderer.diagnostics() : null;
            // Reported whether or not this build draws: a program setting the
            // same matrix over and over is doing it for its own reasons, and
            // that is worth knowing before anyone builds a stub to spare it.
            return { ...drawn, redundantTransforms };
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
            lightsVersion++;
            drawStateVersion++;
            clipPlanes = new Map();
            clipStatus = { ClipUnion: 0, ClipIntersection: 0 };
            buildImplicitResources();
            // The ramp outlasts the reset; whether it is shown follows the mode.
            showGamma();
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
            if (recording)
            {
                recording.stageStates.set((stage << 8) | type, value >>> 0);
                return D3D_OK;
            }
            if (states.get(type) !== value >>> 0)
            {
                states.set(type, value >>> 0);
                drawStateVersion++;
            }
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
            // A program of this era sets the same matrix again constantly --
            // measured at three and a half sets per draw on a real title's
            // menu, most of them the value already there. Setting it again is
            // observably nothing, and doing nothing costs nothing: the copy is
            // the expensive part, and there were two of them on every call,
            // including one built for a state block that was not recording.
            //
            // A recording takes every set, because a block captures what a
            // program set rather than what changed, and a block applied later
            // when another matrix is current must still put this one back.
            if (recording)
            {
                recording.transforms.set(type, new Float32Array(matrix));
                return D3D_OK;
            }
            const held = transforms.get(type);
            if (held && sameMatrix(held, matrix))
            {
                redundantTransforms++;
                return D3D_OK;
            }
            // The world moves before most draws, and nothing keeps the matrix
            // the device holds past the call that reads it -- a state block,
            // GetTransform and the renderer copy it -- so a new one is written
            // over it rather than made. Every other transform is a new object,
            // which is how the renderer knows it changed.
            if (type === D3DTS.WORLD && held)
            {
                held.set(matrix);
                return D3D_OK;
            }
            transforms.set(type, new Float32Array(matrix));
            if (type !== D3DTS.WORLD)
            {
                drawStateVersion++;
            }
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

        /**
         * The transform already there, times the one given, in the order a
         * row-vector convention multiplies them: the new matrix is applied
         * after the old, which is what makes a chain of these read left to
         * right.
         *
         * @param {number} type
         * @param {ArrayLike<number>} matrix
         */
        MultiplyTransform(type, matrix){
            if (!isTransformType(type) || !matrix || matrix.length !== 16)
            {
                return D3DERR_INVALIDCALL;
            }
            const current = transforms.get(type) ?? IDENTITY;
            const product = new Float32Array(16);
            for (let row = 0; row < 4; row++)
            {
                for (let column = 0; column < 4; column++)
                {
                    let sum = 0;
                    for (let step = 0; step < 4; step++)
                    {
                        sum += current[row * 4 + step] * matrix[step * 4 + column];
                    }
                    product[row * 4 + column] = sum;
                }
            }
            if (recording)
            {
                recording.transforms.set(type, product);
                return D3D_OK;
            }
            transforms.set(type, product);
            if (type !== D3DTS.WORLD)
            {
                drawStateVersion++;
            }
            return D3D_OK;
        },

        /** @param {Material} value */
        SetMaterial(value){
            if (!value)
            {
                return D3DERR_INVALIDCALL;
            }
            if (recording)
            {
                recording.material = copyMaterial(value);
                return D3D_OK;
            }
            material = copyMaterial(value);
            drawStateVersion++;
            return D3D_OK;
        },

        /** @param {{ material?: Material }} out */
        GetMaterial(out){
            out.material = copyMaterial(material);
            return D3D_OK;
        },

        /**
         * Clears the viewport, or the given rectangles within it: a viewport
         * smaller than the target leaves everything outside it alone. An array
         * with a count of zero names no rectangle and clears nothing; a count
         * without an array is the whole viewport.
         *
         * @param {number} rectCount
         * @param {readonly { x1: number, y1: number, x2: number, y2: number }[] | null} rects
         * @param {number} flags D3DCLEAR
         * @param {number} color D3DCOLOR
         * @param {number} z
         * @param {number} stencil
         */
        Clear(rectCount, rects, flags, color, z, stencil){
            if ((flags & (D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER | D3DCLEAR.STENCIL)) === 0)
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
            if (rects && rectCount === 0)
            {
                return D3D_OK;
            }
            if (renderer)
            {
                renderer.clear(model, rects ? rects.slice(0, rectCount) : [],
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
         * @param {number} minIndex
         * @param {number} numVertices  How many vertices `vertexData` holds.
         * @param {number} primitiveCount
         * @param {Uint8Array} indexData
         * @param {number} indexFormat  D3DFMT_INDEX
         * @param {Uint8Array} vertexData
         * @param {number} stride
         */
        DrawIndexedPrimitiveUP(
            type, minIndex, numVertices, primitiveCount, indexData, indexFormat, vertexData,
            stride,
        )
        {
            // The indices count from the first vertex, not from minIndex, which
            // only says where the range they use begins (Wine's d3d8
            // test_drawindexedprimitiveup).
            const reach = minIndex + numVertices;
            const hr = drawPreconditions(type, primitiveCount);
            if (hr !== D3D_OK || !vertexData || !indexData || !(stride > 0)
                || vertexData.byteLength < reach * stride)
            {
                return D3DERR_INVALIDCALL;
            }
            if (renderer)
            {
                renderer.drawIndexedPrimitiveUp(model, type, reach, primitiveCount,
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
            if (recording)
            {
                recording.renderStates.set(state, value >>> 0);
                return D3D_OK;
            }
            if (renderStates.get(state) !== value >>> 0)
            {
                renderStates.set(state, value >>> 0);
                drawStateVersion++;
            }
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
            if (recording)
            {
                const held = recording.lights.get(index);
                recording.lights.set(index, { ...held, light: { ...light } });
                return D3D_OK;
            }
            const existing = lights.get(index);
            // Set again with what it holds, as a program that sets its lights
            // before every model does: observably nothing, and a new version
            // would have every draw after it name its state again.
            if (existing && sameLight(existing.light, light))
            {
                return D3D_OK;
            }
            lights.set(index, { light: { ...light }, enabled: existing?.enabled ?? false });
            lightsVersion++;
            // A draw's preparation is shaped by a light's type, and packs its
            // values into the block for each draw by `lightsVersion`: a light
            // that moves keeps the preparation it had.
            if (existing?.light.Type !== light.Type)
            {
                drawStateVersion++;
            }
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
            if (recording)
            {
                const held = recording.lights.get(index);
                recording.lights.set(index, { ...held, enabled: enable === true });
                return D3D_OK;
            }
            const held = lights.get(index);
            if (held && held.enabled === (enable === true))
            {
                return D3D_OK;
            }
            const record = held ?? { light: defaultLight(), enabled: false };
            record.enabled = enable === true;
            lights.set(index, record);
            lightsVersion++;
            drawStateVersion++;
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
         * A user clip plane, as its four coefficients. Which of them are in
         * force is D3DRS_CLIPPLANEENABLE's business, so an index is writable
         * whether or not anything reads it.
         *
         * @param {number} index
         * @param {ArrayLike<number>} plane
         */
        SetClipPlane(index, plane){
            if (index < 0 || index >= 32 || !plane || plane.length !== 4)
            {
                return D3DERR_INVALIDCALL;
            }
            (recording?.clipPlanes ?? clipPlanes).set(index, Float32Array.from(plane));
            return D3D_OK;
        },

        /**
         * @param {number} index
         * @param {{ plane?: Float32Array }} out
         *        Zeroes for a plane never written, which is what a fresh device
         *        holds -- a plane of no coefficients clips nothing.
         */
        GetClipPlane(index, out){
            if (index < 0 || index >= 32)
            {
                return D3DERR_INVALIDCALL;
            }
            out.plane = Float32Array.from(clipPlanes.get(index) ?? [0, 0, 0, 0]);
            return D3D_OK;
        },

        /** @param {{ ClipUnion: number, ClipIntersection: number }} status */
        SetClipStatus(status){
            if (!status)
            {
                return D3DERR_INVALIDCALL;
            }
            clipStatus = {
                ClipUnion: status.ClipUnion >>> 0,
                ClipIntersection: status.ClipIntersection >>> 0,
            };
            return D3D_OK;
        },

        /** @param {{ status?: { ClipUnion: number, ClipIntersection: number } }} out */
        GetClipStatus(out){
            out.status = { ...clipStatus };
            return D3D_OK;
        },

        /**
         * How many passes the state as it stands would take.
         *
         * One, when the combiner draws the cascade: the whole of it becomes a
         * single generated shader, so a cascade drawn at all is drawn in one
         * pass. A stage it cannot draw is named instead, and a pixel shader
         * replaces the cascade altogether.
         *
         * @param {{ passes?: number }} out  Written only on success.
         */
        ValidateDevice(out){
            const hr = boundPixelShader !== 0
                ? D3D_OK
                : validateStages(stageStatesFor, STAGE_COUNT);
            if (hr === D3D_OK)
            {
                out.passes = 1;
            }
            return hr;
        },

        // --- state blocks ---

        BeginStateBlock(){
            if (recording)
            {
                return D3DERR_INVALIDCALL;
            }
            recording = emptyBlock();
            return D3D_OK;
        },

        /** @param {{ handle?: number }} out */
        EndStateBlock(out){
            if (!recording)
            {
                return D3DERR_INVALIDCALL;
            }
            const handle = nextStateBlock++;
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
                return D3DERR_INVALIDCALL;
            }
            applyBlock(block, stateView);
            drawStateVersion++;
            textureBindingVersion++;
            lightsVersion++;
            return D3D_OK;
        },

        /** @param {number} handle */
        CaptureStateBlock(handle){
            const block = stateBlocks.get(handle);
            if (!block)
            {
                return D3DERR_INVALIDCALL;
            }
            captureBlock(block, stateView);
            return D3D_OK;
        },

        /** @param {number} handle */
        DeleteStateBlock(handle){
            return stateBlocks.delete(handle) ? D3D_OK : D3DERR_INVALIDCALL;
        },

        /**
         * @param {number} type D3DSBT
         * @param {{ handle?: number }} out
         */
        CreateStateBlock(type, out){
            if (!/** @type {number[]} */ (Object.values(D3DSBT)).includes(type))
            {
                return D3DERR_INVALIDCALL;
            }
            const block = fillBlock(type, stateView, NOT_CAPTURED_BY_STATE_BLOCK);
            const handle = nextStateBlock++;
            stateBlocks.set(handle, block);
            out.handle = handle;
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
            const next = viewportState({
                x: value.X,
                y: value.Y,
                width: value.Width,
                height: value.Height,
                minDepth: value.MinZ,
                maxDepth: value.MaxZ,
            });
            if (recording)
            {
                recording.viewport = next;
                return D3D_OK;
            }
            viewport = next;
            drawStateVersion++;
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
            if (stage < 0 || stage >= STAGE_COUNT)
            {
                return D3DERR_INVALIDCALL;
            }
            if (recording)
            {
                recording.textures.set(stage, texture ?? null);
                return D3D_OK;
            }
            if ((textures.get(stage) ?? null) !== (texture ?? null))
            {
                if (texture)
                {
                    textures.set(stage, texture);
                }
                else
                {
                    textures.delete(stage);
                }
                drawStateVersion++;
                textureBindingVersion++;
            }
            return D3D_OK;
        },

        /**
         * @param {number} stage
         * @param {{ texture?: any }} out
         */
        GetTexture(stage, out){
            if (stage < 0 || stage >= STAGE_COUNT)
            {
                return D3DERR_INVALIDCALL;
            }
            out.texture = handOut(textures.get(stage) ?? null, 'GetTexture');
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
            if (recording)
            {
                recording.indices = { buffer: buffer ?? null, base };
                return D3D_OK;
            }
            buffer?.hold?.();
            indices?.letGo?.();
            indices = buffer ?? null;
            baseVertexIndex = base;
            return D3D_OK;
        },

        /** @param {{ buffer?: any, baseVertexIndex?: number }} out */
        GetIndices(out){
            out.buffer = handOut(indices, 'GetIndices');
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
            if (recording)
            {
                const held = recording.streams.get(index) ?? { buffer: null, stride: 0 };
                recording.streams.set(index,
                    { buffer: buffer ?? null, stride: buffer ? stride : held.stride });
                return D3D_OK;
            }
            const record = stream(index);
            buffer?.hold?.();
            record.buffer?.letGo?.();
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
            out.buffer = handOut(record.buffer, 'GetStreamSource');
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
            drawStateVersion++;
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
            if (!blockAligned(format, width, height))
            {
                return D3DERR_INVALIDCALL;
            }
            const hr = createResult(SURFACE_TYPE.TEXTURE_2D, format, pool, usage, caps);
            if (hr !== D3D_OK)
            {
                // A refusal a program can act on, but only if it is told which
                // format was refused. Saying nothing is how an unsupported
                // format costs a run its art with no trace anywhere: the
                // program takes a slower path of its own and everything after
                // looks merely slow rather than wrong.
                reportRefusedFormat(format);
                return hr;
            }
            const chain = levels || fullChainOf(width, height);
            const texture = createTexture({
                width,
                height,
                levels: chain,
                format,
                pool,
                usage,
                count: explicitCount(pool),
                allocate,
                free,
            });
            if (renderer)
            {
                renderer.trackTexture(texture, { width, height, format, levels: chain, usage });
            }
            out.texture = texture;
            return D3D_OK;
        },

        /**
         * @param {number} width @param {number} height @param {number} depth
         * @param {number} levels  Zero for the whole chain.
         * @param {number} usage @param {number} format @param {number} pool
         * @param {{ texture?: any }} out
         */
        CreateVolumeTexture(width, height, depth, levels, usage, format, pool, out){
            const hr = volumeCreateResult({
                width, height, depth, levels, usage, format, pool,
                maxExtent: caps.maxVolumeExtent ?? 256,
            });
            if (hr !== D3D_OK)
            {
                if (isCompressed(format))
                {
                    reportRefusedFormat(format);
                }
                return hr;
            }
            const chain = levels || volumeLevelCount(width, height, depth);
            const texture = createVolumeTexture({
                width, height, depth, levels: chain, format, pool, usage,
                count: explicitCount(pool), allocate, free,
            });
            renderer?.trackTexture(texture, { width, height, depth, format, levels: chain, usage });
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
            if (!blockAligned(format, edgeLength, edgeLength))
            {
                return D3DERR_INVALIDCALL;
            }
            const hr = createResult(SURFACE_TYPE.CUBE, format, pool, usage, caps);
            if (hr !== D3D_OK)
            {
                return hr;
            }
            const chain = levels || fullChainOf(edgeLength, edgeLength);
            const texture = createTexture({
                width: edgeLength,
                height: edgeLength,
                levels: chain,
                format,
                pool,
                usage,
                count: explicitCount(pool),
                allocate,
                free,
                cube: true,
            });
            renderer?.trackTexture(texture,
                { width: edgeLength, height: edgeLength, format, levels: chain, usage });
            out.texture = texture;
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
            const surface = createSurface({
                type: SURFACE_TYPE.RENDER_TARGET,
                width,
                height,
                format,
                pool: D3DPOOL.DEFAULT,
                usage: D3DUSAGE.RENDERTARGET,
                divergence: services.divergence ?? null,
                lockable,
                pixels: targetPixels(),
                base: allocate(surfaceBytes(format, width, height)),
                count: explicitCount(D3DPOOL.DEFAULT, ()=>retireSurface(surface)),
            });
            out.surface = surface;
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
            const surface = createSurface({
                type: SURFACE_TYPE.DEPTH_STENCIL,
                width,
                height,
                format,
                pool: D3DPOOL.DEFAULT,
                usage: D3DUSAGE.DEPTHSTENCIL,
                divergence: services.divergence ?? null,
                base: allocate(surfaceBytes(format, width, height)),
                count: explicitCount(D3DPOOL.DEFAULT, ()=>retireSurface(surface)),
            });
            out.surface = surface;
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
            if (!blockAligned(format, width, height))
            {
                return D3DERR_INVALIDCALL;
            }
            const hr = imageSurfaceCreateResult(format, caps);
            if (hr !== D3D_OK)
            {
                return hr;
            }
            const surface = createSurface({
                type: SURFACE_TYPE.PLAIN,
                width,
                height,
                format,
                pool: D3DPOOL.SYSTEMMEM,
                usage: 0,
                base: allocate(surfaceBytes(format, width, height)),
                count: explicitCount(D3DPOOL.SYSTEMMEM, ()=>retireSurface(surface)),
            });
            out.surface = surface;
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
         * The picture the last present showed, as A8R8G8B8, into an image
         * surface; the caller waits for it to come back from the GPU. The
         * front buffer of a windowed device is the desktop's, with the window
         * where it stands; here it is the window's picture at the surface's
         * top-left corner, and said so once. Without a renderer that can read
         * back there is no picture to copy, and the call is refused.
         *
         * @param {any} destination
         * @returns {number | Promise<number>}
         */
        GetFrontBuffer(destination){
            if (!destination)
            {
                return D3DERR_INVALIDCALL;
            }
            const desc = describe(destination);
            if (desc.Format !== D3DFMT.A8R8G8B8 || desc.Pool !== D3DPOOL.SYSTEMMEM)
            {
                return D3DERR_INVALIDCALL;
            }
            const write = services.writeMemory;
            if (!renderer?.readFront || !write)
            {
                reportOnce('frontbuffer', 'GetFrontBuffer was refused: this build draws nothing'
                    + ' it can read back');
                return D3DERR_INVALIDCALL;
            }
            if (presentParameters.windowed)
            {
                reportOnce('frontbuffer-windowed', 'GetFrontBuffer puts a windowed device\'s'
                    + ' picture at the surface\'s corner, not where the window stands on the'
                    + ' desktop');
            }
            return renderer.readFront().then((/** @type {any} */ image)=>{
                writeFrontBuffer(destination, image, write);
                renderer.markDirty(destination);
                return D3D_OK;
            });
        },

        /**
         * A blit between two surfaces, which D3D9 does not have. Neither side
         * may be a depth stencil, and it cannot stretch.
         *
         * Between two surfaces that live on the GPU -- a render target, a
         * texture level -- the copy is made there, and no bytes move. Otherwise
         * the bytes are not moved here: both surfaces live in the guest's own
         * memory and this file cannot reach it, so what a successful call hands
         * back is where they are and how they are laid out; whoever can read
         * that memory does the moving. The destination is marked for upload
         * before it is written rather than after, because what the mark decides
         * is only whether the next draw re-reads it.
         *
         * @param {any} source
         * @param {readonly import('./validity.js').CopyRect[] | null} rects
         * @param {number} rectCount
         * @param {any} destination
         * @param {readonly { x: number, y: number }[] | null} points
         * @param {{ moves?: SurfaceMove[] }} [out]
         */
        CopyRects(source, rects, rectCount, destination, points, out = {}){
            if (!source || !destination)
            {
                return D3DERR_INVALIDCALL;
            }
            const from = describe(source);
            const to = describe(destination);
            const chosen = rectCount > 0 ? (rects ?? []).slice(0, rectCount) : null;
            const targets = rectCount > 0 ? (points ?? []).slice(0, rectCount) : null;
            const hr = copyRectsResult(
                { type: surfaceTypeOf(from), format: from.Format, width: from.Width,
                    height: from.Height },
                { type: surfaceTypeOf(to), format: to.Format, width: to.Width,
                    height: to.Height },
                chosen, targets);
            if (hr !== D3D_OK)
            {
                return hr;
            }
            const whole = { left: 0, top: 0, right: from.Width, bottom: from.Height };
            const copies = chosen && targets
                ? chosen.map((rect, index)=>({ rect, at: targets[index] }))
                : [{ rect: whole, at: { x: 0, y: 0 } }];
            // A system-memory surface lives in memory, whatever copy of it the
            // renderer keeps: copied into on the GPU, a lock of it read nothing.
            if (renderer?.copySurface && to.Pool !== D3DPOOL.SYSTEMMEM
                && copies.every(copy=>
                    renderer.copySurface(source, copy.rect, destination, copy.at)))
            {
                out.moves = [];
                return D3D_OK;
            }
            const bytesPerPixel = FORMAT_INFO[from.Format].bytesPerPixel;
            const describeMoves = ()=>{
                out.moves = chosen && targets
                    ? chosen.map((rect, index)=>({
                        from: source.base + rect.top * pitchOf(from) + rect.left * bytesPerPixel,
                        to: destination.base + targets[index].y * pitchOf(to)
                            + targets[index].x * bytesPerPixel,
                        rowBytes: (rect.right - rect.left) * bytesPerPixel,
                        rows: rect.bottom - rect.top,
                        fromPitch: pitchOf(from),
                        toPitch: pitchOf(to),
                    }))
                    : [wholeSurfaceMove(source, destination)];
                // A texture level written this way is written as a lock writes
                // it, which is what the next UpdateTexture from it carries.
                for (const copy of copies)
                {
                    destination.noteWritten?.({
                        left: copy.at.x, top: copy.at.y,
                        right: copy.at.x + copy.rect.right - copy.rect.left,
                        bottom: copy.at.y + copy.rect.bottom - copy.rect.top,
                    });
                }
                renderer?.markDirty(destination);
                return D3D_OK;
            };
            // A render target's pixels are the GPU's, and its memory holds
            // nothing drawn: copied from there, a back buffer read back through
            // an image surface -- how a program samples what it drew -- was
            // black. They are read back first, as a lock of the target reads.
            const pixels = surfaceTypeOf(from) === SURFACE_TYPE.RENDER_TARGET
                ? targetPixels() : undefined;
            return pixels ? pixels.readBack(source).then(describeMoves) : describeMoves();
        },

        /**
         * Every level a system-memory texture and a device-memory one share.
         *
         * The source is system memory and the destination is not. A smaller
         * destination starts from the source level of its own size, the
         * source's larger levels skipped, and takes as many levels as it has.
         * Windows also accepts a destination whose size no source level has,
         * and one of another format; this layer carries the overlap of the
         * level it lines up by the larger side, and bytes only between formats
         * of one texel size, and says so.
         *
         * As with CopyRects, the moves are described rather than made.
         *
         * @param {any} source
         * @param {any} destination
         * @param {{ moves?: SurfaceMove[] }} [out]
         */
        UpdateTexture(source, destination, out = {}){
            if (!source || !destination)
            {
                return D3DERR_INVALIDCALL;
            }
            if (source.volume || destination.volume)
            {
                const update = source.volume && destination.volume && source !== destination
                    && source.pool === D3DPOOL.SYSTEMMEM && destination.pool !== D3DPOOL.SYSTEMMEM
                    && source.width >= destination.width && source.height >= destination.height
                    && source.depth >= destination.depth
                    ? volumeUpdate(source, destination, { bySize: true })
                    : null;
                if (!update)
                {
                    return D3DERR_INVALIDCALL;
                }
                if (update.overlapped)
                {
                    reportOnce('update-size', 'UpdateTexture between volumes with no level of'
                        + ' one size: they were carried where they overlap');
                }
                if (update.converted)
                {
                    reportOnce('update-format', 'UpdateTexture between volume formats of two'
                        + ' texel sizes carried nothing: the texels are not converted');
                }
                for (const volume of update.written)
                {
                    renderer?.markDirty(volume);
                }
                out.moves = update.moves;
                return D3D_OK;
            }
            const top = levelSurface(source, 0);
            const into = levelSurface(destination, 0);
            if (!top || !into)
            {
                return D3DERR_INVALIDCALL;
            }
            const from = describe(top);
            const to = describe(into);
            if (from.Pool !== D3DPOOL.SYSTEMMEM || to.Pool === D3DPOOL.SYSTEMMEM
                || (source.cube ?? false) !== (destination.cube ?? false)
                || from.Width < to.Width || from.Height < to.Height)
            {
                return D3DERR_INVALIDCALL;
            }
            const sourceLevels = source.levels ?? 1;
            const sizeAt = (/** @type {number} */ level)=>[
                Math.max(1, from.Width >>> level), Math.max(1, from.Height >>> level)];
            let skip = 0;
            const side = Math.max(to.Width, to.Height);
            while (skip < sourceLevels - 1 && Math.max(...sizeAt(skip)) > side)
            {
                skip++;
            }
            const [skippedWidth, skippedHeight] = sizeAt(skip);
            if (skippedWidth !== to.Width || skippedHeight !== to.Height)
            {
                reportOnce('update-size', `UpdateTexture into ${to.Width}x${to.Height}, a size`
                    + ` no level of the ${from.Width}x${from.Height} source has: its level`
                    + ` ${skip} was carried where the two overlap`);
            }
            const sameTexel = from.Format === to.Format
                || FORMAT_INFO[from.Format]?.bytesPerPixel === FORMAT_INFO[to.Format]?.bytesPerPixel
                    && !isCompressed(from.Format) && !isCompressed(to.Format);
            if (!sameTexel)
            {
                reportOnce('update-format', `UpdateTexture from format ${from.Format} into`
                    + ` ${to.Format} carried nothing: the texels are not converted`);
            }
            /** @type {SurfaceMove[]} */
            const moves = [];
            const levels = Math.min(sourceLevels - skip, destination.levels ?? 1);
            for (let face = 0; face < (source.cube ? 6 : 1); face++)
            {
                // What the face was written in since it was last carried, and
                // nothing more: an update of a source nobody touched moves nothing.
                const region = source.takeDirtyRegion?.(face) ?? null;
                for (let level = 0; level < (region && sameTexel ? levels : 0); level++)
                {
                    const one = levelSurface(source, skip + level, face);
                    const other = levelSurface(destination, level, face);
                    if (one && other)
                    {
                        const desc = describe(one);
                        const bounds = describe(other);
                        const rect = regionAtLevel(region, skip + level,
                            Math.min(desc.Width, bounds.Width),
                            Math.min(desc.Height, bounds.Height));
                        moves.push(rectMoveOf(one, rect, other, { x: rect.left, y: rect.top }));
                        renderer?.markDirty(other);
                    }
                }
            }
            out.moves = moves;
            return D3D_OK;
        },

        /**
         * The fixed-function transform and lighting of `vertices` vertices,
         * read under the vertex format or the declaration bound, from
         * `start`, into a vertex buffer from `destinationIndex`, in the format
         * the buffer was made with (Wine's d3d8 visual.c test_sysmem_draw). A
         * vertex shader would run in software here, which nothing does, so it
         * is refused.
         *
         * @param {number} start @param {number} destinationIndex @param {number} vertices
         * @param {any} destination @param {number} flags D3DPV
         */
        ProcessVertices(start, destinationIndex, vertices, destination, flags){
            const processing = device.stageProcessing;
            const attributes = (processing.fvf & POSITION_MASK) !== 0
                ? decodeFvf(processing.fvf).attributes
                    .map(attribute=>({ ...attribute, stream: 0 }))
                : processing.fixedFunctionLayout?.attributes ?? null;
            if (!destination || destination.type !== D3DRTYPE.VERTEXBUFFER)
            {
                return D3DERR_INVALIDCALL;
            }
            if (processing.vertexShader !== 0 || !services.readMemory || !services.writeMemory)
            {
                reportOnce('process', processing.vertexShader !== 0
                    ? 'ProcessVertices through a vertex shader was refused: no shader runs on'
                        + ' the processor'
                    : 'ProcessVertices was refused: this build cannot write guest memory');
                return D3DERR_INVALIDCALL;
            }
            if (!attributes)
            {
                return D3DERR_INVALIDCALL;
            }
            return processStreams({
                memory: { readMemory: services.readMemory, writeMemory: services.writeMemory },
                model,
                attributes,
                streamAt: index=>{
                    const source = streams.get(index);
                    return source?.buffer && source.stride > 0
                        ? {
                            base: source.buffer.base,
                            stride: source.stride,
                            vertices: Math.floor(source.buffer.length / source.stride),
                        }
                        : null;
                },
                start, count: vertices, destination, destinationIndex, flags,
                destinationFvf: destination.fvf ?? 0,
                renderer,
            });
        },

        // --- shaders, which in this version are handles rather than objects ---

        /**
         * Creating a shader takes no reference on the device: a handle is not
         * an object, so there is nothing for the device to outlive. The new
         * shader is not bound either, whatever the documentation says.
         *
         * A declaration alone is a fixed-function vertex stage reading the
         * registers it loads. With a function, the function is a vs_1_x of
         * no newer version than the caps claim, naming no constant past the
         * file (Wine's d3d8 test_shader and test_unsupported_shaders).
         *
         * @param {ArrayLike<number> | null} declaration
         * @param {ArrayLike<number> | null} functionCode
         * @param {{ handle?: number }} out
         */
        CreateVertexShader(declaration, functionCode, out){
            if (!declaration)
            {
                return D3DERR_INVALIDCALL;
            }
            const declared = parseDeclaration(declaration);
            if (declared.error)
            {
                return D3DERR_INVALIDCALL;
            }
            /** @type {import('../d3d9/shader.js').ParsedShader | null} */
            let parsed = null;
            /** @type {Uint32Array | null} */
            let tokens = null;
            if (functionCode)
            {
                tokens = functionOf(functionCode);
                const read = parseShader(tokens);
                if (!withinVersion(read, SHADER_KIND.VERTEX, caps.vertexShaderVersion)
                    || !constantsWithin(read, vertexConstants.floats.length / 4))
                {
                    return D3DERR_INVALIDCALL;
                }
                parsed = declaredShader(read);
            }
            else if (!readableByFixedFunction(declared))
            {
                return D3DERR_INVALIDCALL;
            }
            const handle = nextHandle();
            vertexShaders.set(handle, {
                handle, declaration: declared, tokens, parsed,
                layout: parsed
                    ? null
                    : fixedFunctionLayoutOf({ id: handle, elements: declared.elements }),
            });
            out.handle = handle;
            return D3D_OK;
        },

        /**
         * The declaration a shader was made with, token for token. A caller
         * with no buffer is told its size in bytes; one whose buffer is too
         * small is refused and told nothing (Wine's d3d8 test_shader).
         *
         * @param {number} handle
         * @param {{ bytes?: number, tokens?: Uint32Array }} out
         * @param {number | null} room  The caller's buffer in bytes, or null for none.
         */
        GetVertexShaderDeclaration(handle, out, room){
            const shader = vertexShaders.get(handle);
            return shader ? handOver(shader.declaration.tokens, out, room) : D3DERR_INVALIDCALL;
        },

        /**
         * The function a shader was made with, as `GetVertexShaderDeclaration`
         * hands its declaration over: nothing, for a declaration made alone.
         *
         * @param {number} handle
         * @param {{ bytes?: number, tokens?: Uint32Array }} out
         * @param {number | null} room
         */
        GetVertexShaderFunction(handle, out, room){
            const shader = vertexShaders.get(handle);
            return shader
                ? handOver(shader.tokens ?? new Uint32Array(0), out, room)
                : D3DERR_INVALIDCALL;
        },

        /**
         * Four floats a register, refused past the file. Recording, the
         * registers go into the block and the device keeps its own (Wine's
         * d3d8 test_shader_constant_apply).
         *
         * @param {number} register @param {ArrayLike<number>} values @param {number} registers
         */
        SetVertexShaderConstant(register, values, registers){
            return setConstants(vertexConstants, 'vertexConstants', register, values, registers);
        },

        /**
         * @param {number} register @param {number} registers
         * @param {{ values?: Float32Array }} out
         */
        GetVertexShaderConstant(register, registers, out){
            return vertexConstants.getF(register, registers, out);
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
         * Setting a shader loads the constants its declaration carries.
         *
         * @param {number} handle
         */
        SetVertexShader(handle){
            if (isShaderHandle(handle) && !vertexShaders.has(handle))
            {
                return D3DERR_INVALIDCALL;
            }
            if (recording)
            {
                recording.vertexShader = handle >>> 0;
                return D3D_OK;
            }
            for (const { register, values } of vertexShaders.get(handle)?.declaration.constants
                ?? [])
            {
                vertexConstants.setF(register, values, values.length / 4);
            }
            if (boundVertexShader !== handle >>> 0)
            {
                boundVertexShader = handle >>> 0;
                drawStateVersion++;
            }
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
                drawStateVersion++;
            }
            return D3D_OK;
        },

        /**
         * A ps_1_x of no newer version than the caps claim, naming none of
         * c8 on; like a vertex shader, it is not bound by being made (Wine's
         * d3d8 test_shader and test_unsupported_shaders).
         *
         * @param {ArrayLike<number> | null} functionCode
         * @param {{ handle?: number }} out
         */
        CreatePixelShader(functionCode, out){
            if (!functionCode)
            {
                return D3DERR_INVALIDCALL;
            }
            const tokens = functionOf(functionCode);
            const parsed = parseShader(tokens);
            if (!withinVersion(parsed, SHADER_KIND.PIXEL, caps.pixelShaderVersion)
                || !constantsWithin(parsed, PIXEL_CONSTANTS))
            {
                return D3DERR_INVALIDCALL;
            }
            const handle = nextHandle();
            pixelShaders.set(handle, { handle, tokens, parsed });
            out.handle = handle;
            return D3D_OK;
        },

        /**
         * @param {number} handle
         * @param {{ bytes?: number, tokens?: Uint32Array }} out
         * @param {number | null} room  See `GetVertexShaderDeclaration`.
         */
        GetPixelShaderFunction(handle, out, room){
            const shader = pixelShaders.get(handle);
            return shader ? handOver(shader.tokens, out, room) : D3DERR_INVALIDCALL;
        },

        /**
         * c0 to c7, recorded into a state block as the vertex shader's are.
         *
         * @param {number} register @param {ArrayLike<number>} values @param {number} registers
         */
        SetPixelShaderConstant(register, values, registers){
            return setConstants(pixelConstants, 'pixelConstants', register, values, registers);
        },

        /**
         * @param {number} register @param {number} registers
         * @param {{ values?: Float32Array }} out
         */
        GetPixelShaderConstant(register, registers, out){
            return pixelConstants.getF(register, registers, out);
        },

        /** @param {number} handle */
        SetPixelShader(handle){
            if (handle !== 0 && !pixelShaders.has(handle))
            {
                return D3DERR_INVALIDCALL;
            }
            if (recording)
            {
                recording.pixelShader = handle >>> 0;
                return D3D_OK;
            }
            if (boundPixelShader !== handle >>> 0)
            {
                boundPixelShader = handle >>> 0;
                drawStateVersion++;
            }
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
                drawStateVersion++;
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
            const handle = isShaderHandle(boundVertexShader);
            const shader = handle ? vertexShaders.get(boundVertexShader) ?? null : null;
            const programmed = shader?.parsed ? shader : null;
            const pixel = pixelShaders.get(boundPixelShader) ?? null;
            // Asked for by every draw: the answer is kept while the bindings
            // and the shader objects they name are the ones it was made from.
            const held = heldProcessing;
            if (held.answer !== null && held.vertexShader === boundVertexShader
                && held.pixelShader === boundPixelShader && held.shader === shader
                && held.pixel === pixel)
            {
                return held.answer;
            }
            // A handle naming no live shader -- a block applied after a
            // delete -- is a stage nothing can draw, so it has no program.
            const drawable = (!handle || shader) && (boundPixelShader === 0 || pixel);
            held.vertexShader = boundVertexShader;
            held.pixelShader = boundPixelShader;
            held.shader = shader;
            held.pixel = pixel;
            held.answer = {
                vertexShader: programmed || (handle && !shader) ? boundVertexShader : 0,
                fvf: handle ? 0 : boundVertexShader,
                fixedFunctionLayout: shader && !programmed ? shader.layout : null,
                fixedFunctionVertex: !programmed,
                pixelShader: boundPixelShader,
                program: drawable && (programmed || pixel)
                    ? {
                        vertex: programmed?.parsed ?? null,
                        vertexShader: programmed,
                        vertexId: programmed?.handle ?? 0,
                        pixel: pixel?.parsed ?? null,
                        pixelShader: pixel,
                        pixelId: pixel?.handle ?? 0,
                        // The declaration a handle carries, or the one its
                        // vertex format spells; a format is never odd, so its
                        // number is never a handle's.
                        declaration: shader
                            ? shader.declaration.elements
                            : elementsOfFormat(boundVertexShader),
                        declarationId: shader ? shader.handle : boundVertexShader,
                        vertexConstants,
                        pixelConstants,
                    }
                    : null,
            };
            return held.answer;
        },
    };

    // A GPU that is gone takes the device with it, beyond a reset.
    stopWatchingLoss = services.onDeviceLost?.(()=>device.injectDeviceLoss(false));
    return device;
}

/** @param {number} format @returns {boolean} a format this layer lays out, and a colour one */
function isColourFormat(format){
    return FORMAT_INFO[format] !== undefined && !FORMAT_INFO[format].depth;
}

/** @param {number} format */
function isDepthFormat(format){
    return FORMAT_INFO[format] !== undefined && FORMAT_INFO[format].depth === true;
}

/**
 * Which kind of surface a plain resource of this usage would be, or null for a
 * kind of resource this build does not make at all.
 *
 * @param {number} resourceType D3DRTYPE
 * @param {number} usage
 * @returns {string | null}
 */
function surfaceTypeOfUsage(resourceType, usage){
    if (resourceType !== D3DRTYPE.SURFACE)
    {
        return null;
    }
    if ((usage & D3DUSAGE.DEPTHSTENCIL) !== 0)
    {
        return SURFACE_TYPE.DEPTH_STENCIL;
    }
    return (usage & D3DUSAGE.RENDERTARGET) !== 0
        ? SURFACE_TYPE.RENDER_TARGET
        : SURFACE_TYPE.PLAIN;
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

