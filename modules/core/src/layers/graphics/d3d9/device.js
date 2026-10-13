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
 * What the renderer does not draw, this device refuses or reports. A shader is
 * created only when the device advertises the version it is written for, and
 * the version advertised is the one the renderer's translator builds a
 * pipeline from whole: a program that checks -- most do -- takes a path the
 * renderer draws, and one asking past it is told no at the create rather
 * than drawn wrong at every frame after it. A fixed-function draw through a
 * vertex declaration is drawn when the declaration describes a flexible
 * vertex format, and reported once when it does not.
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
 * - **A state set while a block is recording goes into the block, not the
 *   device.** That is this version's rule, and it is the opposite of Direct3D
 *   8's: a program that turns lighting off between Begin and End reads it
 *   back as on until it applies the block.
 */

import {
    D3DERR_DEVICELOST, D3DERR_DEVICENOTRESET, D3DERR_DEVICEREMOVED, D3DERR_INVALIDCALL,
    D3DERR_NOTAVAILABLE,
    D3DERR_NOTFOUND, D3DFMT, D3DLIGHTTYPE, D3DOK_NOAUTOGEN, D3DPOOL, D3DRS, D3DRTYPE, D3DUSAGE,
    D3D_OK, FORMAT_INFO, blockAligned, isCompressed, surfaceBytes, surfacePitch, videoPoolAllowed,
} from './constants.js';
import { D3DCLEAR, D3DTS } from '../d3d8/constants.js';
import {
    IDENTITY, STAGE_COUNT, createRenderer, gpuFormatOf, multiplyMatrices, sameLight,
    vertexCountOf,
} from '../d3d8/render.js';
import { createDefaultStageStates } from '../d3d8/stagestates.js';
import { createDefaultRenderStates } from './renderstates.js';
import {
    chainBytes, createPriority, createReferenceCount, createSurface, createTexture,
    createVideoMemory, createVolumeTexture, packColour, rectMoveOf, regionAtLevel, volumeUpdate,
    writeFrontBuffer, writePixels,
} from './resources.js';
import {
    SURFACE_TYPE, reportedBackBufferCount, validatePresentParameters, volumeCreateResult,
    volumeLevelCount,
} from './validity.js';
import { createAdditionalChain } from './swapchain.js';
import { runCommands } from './commands.js';
import { validateStages } from '../d3d8/validity.js';
import { processStreams } from '../d3d8/process.js';
import { reportDynamicReads } from '../d3d8/drawn.js';
import { decodeFvf } from '../webgpu/internal/vertexformat.js';
import { fullTarget, viewportState } from '../webgpu/internal/viewport.js';
import { formatTraits } from '../webgpu/internal/textures.js';
import {
    D3DDECLUSAGE, MAX_STREAMS, createVertexDeclaration, elementsOfFvf, fixedFunctionLayoutOf,
    fvfOfElements, validateElements,
} from './declaration.js';
import {
    CONSTANT_FILE, SHADER_KIND, createConstantFile, createShader, validateShader, versionOf,
} from './shader.js';
import {
    D3DSBT, applyRecord, captureRecord, createStateBlock, emptyRecord, fillRecord,
} from './stateblock.js';
import {
    D3DSAMP, D3DTSS9, SAMPLER_STATE_KEY, addDirect3D9StageDefaults, isSampler,
} from './samplerstates.js';

/** D3DUSAGE_QUERY_SRGBREAD and D3DUSAGE_QUERY_SRGBWRITE, asked of CheckDeviceFormat. */
const USAGE_QUERY_SRGBREAD = 0x00010000;
const USAGE_QUERY_SRGBWRITE = 0x00040000;
/**
 * D3DUSAGE_QUERY_FILTER, whether a texture of the format is filtered by more
 * than D3DTEXF_POINT, and D3DUSAGE_QUERY_POSTPIXELSHADER_BLENDING, whether a
 * target of it takes what comes after the pixel shader: the blend, the alpha
 * test, fog and the colour write mask.
 */
const USAGE_QUERY_FILTER = 0x00020000;
const USAGE_QUERY_POSTPIXELSHADER_BLENDING = 0x00080000;

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

/** D3DDEVTYPE. */
export const D3DDEVTYPE = Object.freeze({ HAL: 1, REF: 2, SW: 3, NULLREF: 4 });

/** The behaviour flags CreateDevice takes. */
export const D3DCREATE = Object.freeze({
    FPU_PRESERVE: 0x00000002,
    MULTITHREADED: 0x00000004,
    PUREDEVICE: 0x00000010,
    SOFTWARE_VERTEXPROCESSING: 0x00000020,
    HARDWARE_VERTEXPROCESSING: 0x00000040,
    MIXED_VERTEXPROCESSING: 0x00000080,
});

/** D3DQUERYTYPE, the two this device answers and the rest it names. */
export const D3DQUERYTYPE = Object.freeze({
    VCACHE: 4,
    RESOURCEMANAGER: 5,
    VERTEXSTATS: 6,
    EVENT: 8,
    OCCLUSION: 9,
    TIMESTAMP: 10,
    TIMESTAMPDISJOINT: 11,
    TIMESTAMPFREQ: 12,
    PIPELINETIMINGS: 13,
    INTERFACETIMINGS: 14,
    VERTEXTIMINGS: 15,
    PIXELTIMINGS: 16,
    BANDWIDTHTIMINGS: 17,
    CACHEUTILIZATION: 18,
});

/** D3DISSUE flags. */
export const D3DISSUE = Object.freeze({ END: 1, BEGIN: 2 });

/** D3DGETDATA_FLUSH: send what was issued to the GPU. */
const D3DGETDATA_FLUSH = 1;

/** The last D3DTEXTUREFILTERTYPE StretchRect accepts. */
const D3DTEXF_ANISOTROPIC = 3;
/** D3DTEXF_LINEAR: a stretch filtered between texels; POINT and NONE take the nearest. */
const D3DTEXF_LINEAR = 2;

/** D3DSTREAMSOURCE_INDEXEDDATA and D3DSTREAMSOURCE_INSTANCEDATA. */
const STREAMSOURCE_INDEXEDDATA = 0x40000000;
const STREAMSOURCE_INSTANCEDATA = 0x80000000;

/** The numbers this version's stage and sampler state types take. */
const STAGE_STATE_TYPES = new Set(/** @type {number[]} */ (Object.values(D3DTSS9)));
const SAMPLER_STATE_TYPES = new Set(/** @type {number[]} */ (Object.values(D3DSAMP)));


/** S_FALSE: a query whose answer is not ready yet. */
const S_FALSE = 1;

/** What GetAvailableTextureMem reports, rounded the way the call always is. */
const AVAILABLE_TEXTURE_MEMORY = 256 << 20;

/** How many entries each channel of a gamma ramp has. */
const GAMMA_RAMP_ENTRIES = 256;

/** A palette: 256 entries of PALETTEENTRY, four bytes each. */
export const PALETTE_BYTES = 256 * 4;

/**
 * The texture palettes a program sets, by number, and which one is current.
 *
 * Nothing here is palettised, so no draw reads one; they are kept because a
 * program sets them and reads them back regardless. A device that does not
 * claim D3DPTEXTURECAPS_ALPHAPALETTE takes an entry only with its peFlags at
 * 0xff, fully opaque (Wine's d3d8 and d3d9 test_set_palette).
 */
export function createPalettes(){
    /** @type {Map<number, Uint8Array>} */
    const palettes = new Map();
    let current = 0;
    return {
        /**
         * @param {number} number
         * @param {Uint8Array} entries  256 PALETTEENTRY of four bytes, peFlags last.
         */
        SetPaletteEntries(number, entries){
            if (!entries || entries.length !== PALETTE_BYTES
                || entries.some((byte, index)=>index % 4 === 3 && byte !== 0xff))
            {
                return D3DERR_INVALIDCALL;
            }
            palettes.set(number >>> 0, Uint8Array.from(entries));
            return D3D_OK;
        },

        /**
         * @param {number} number
         * @param {{ entries?: Uint8Array }} out
         */
        GetPaletteEntries(number, out){
            const held = palettes.get(number >>> 0);
            if (!held)
            {
                return D3DERR_INVALIDCALL;
            }
            out.entries = Uint8Array.from(held);
            return D3D_OK;
        },

        /** @param {number} number */
        SetCurrentTexturePalette(number){
            current = number >>> 0;
            return D3D_OK;
        },

        /** @param {{ number?: number }} out */
        GetCurrentTexturePalette(out){
            out.number = current;
            return D3D_OK;
        },
    };
}

/**
 * @typedef {Object} DeviceCaps
 * @property {number} maxPointSize     Decides the POINTSIZE_MAX default.
 * @property {boolean} depthTexture2d  Whether depth formats are usable as textures,
 * @property {boolean} depthCube       as cube maps,
 * @property {boolean} depthPlain      and as offscreen plain surfaces.
 * @property {number} [videoMemory]  Bytes GetAvailableTextureMem reports: the card's
 *           memory as the graphics layer gives every API.
 * @property {boolean} [compressedTextures]  Whether an upload keeps DXT blocks as BC
 *           on the GPU (true) or decodes them to `bgra8unorm` (false); every DXT
 *           format is creatable either way.
 * @property {{ major: number, minor: number }} vertexShaderVersion
 *     The highest vertex shader a create accepts, which is the highest the
 *     renderer's translator builds a pipeline from.
 * @property {{ major: number, minor: number }} pixelShaderVersion
 * @property {number} maxUserClipPlanes
 * @property {number} maxActiveLights
 * @property {number} maxTextureWidth
 * @property {number} maxTextureHeight
 * @property {number} maxVolumeExtent
 * @property {number} maxAnisotropy
 * @property {number} maxPrimitiveCount
 * @property {number} maxVertexIndex
 * @property {number} maxStreamStride
 * @property {number} maxTextureBlendStages
 * @property {number} maxSimultaneousTextures
 * @property {number} maxVertexBlendMatrices
 * @property {number} maxVertexW
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
    // Model 3, which the translator turns into a pipeline whole: predication,
    // subroutines, indexed outputs and vertex texture reads among it, held
    // to the reference machine by the shader gate.
    vertexShaderVersion: Object.freeze({ major: 3, minor: 0 }),
    pixelShaderVersion: Object.freeze({ major: 3, minor: 0 }),
    // None: the renderer clips against no user plane, and a plane a program
    // sets and finds not clipping is worse than a plane it is refused.
    maxUserClipPlanes: 6,
    maxActiveLights: 8,
    maxTextureWidth: 4096,
    maxTextureHeight: 4096,
    maxVolumeExtent: 256,
    // WebGPU's ceiling for a sampler's maxAnisotropy.
    maxAnisotropy: 16,
    maxPrimitiveCount: 0xffff,
    // Thirty-two-bit indices are read, so the highest index is not sixteen bits.
    maxVertexIndex: 0x00ffffff,
    maxStreamStride: 256,
    maxTextureBlendStages: 8,
    maxSimultaneousTextures: 8,
    maxVertexBlendMatrices: 0,
    maxVertexW: 1e10,
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
 * Not all zeros, which is what an unseeded structure would be. Geometry that
 * never calls SetMaterial and carries no vertex colour takes every term from
 * here, so a black default lights it to black -- and the whole model
 * disappears while every state a program can read back still says what it
 * expects. The ambient term costs nothing by default because D3DRS_AMBIENT
 * starts black; it matters the moment a program sets one.
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
 * @typedef {Object} Rect
 * @property {number} left
 * @property {number} top
 * @property {number} right
 * @property {number} bottom
 */

/**
 * @typedef {Object} GammaRamp
 * @property {Uint16Array} red
 * @property {Uint16Array} green
 * @property {Uint16Array} blue
 */

/** @returns {GammaRamp} the identity ramp: each entry is its own index, scaled to sixteen bits */
function identityRamp(){
    const channel = ()=>Uint16Array.from({ length: GAMMA_RAMP_ENTRIES }, (_, i)=>i * 257);
    return { red: channel(), green: channel(), blue: channel() };
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
        lockableBackBuffer: parameters.lockableBackBuffer === true,
    };
}

/** @param {number} format */
const isColourFormat = format=>FORMAT_INFO[format] !== undefined && !FORMAT_INFO[format].depth;

/** The same layout with or without its alpha: A8R8G8B8 for X8R8G8B8 and back. @type {Map<number, number>} */
const ALPHA_TWINS = new Map([
    [D3DFMT.A8R8G8B8, D3DFMT.X8R8G8B8], [D3DFMT.X8R8G8B8, D3DFMT.A8R8G8B8],
    [D3DFMT.A1R5G5B5, D3DFMT.X1R5G5B5], [D3DFMT.X1R5G5B5, D3DFMT.A1R5G5B5],
    [D3DFMT.A4R4G4B4, D3DFMT.X4R4G4B4], [D3DFMT.X4R4G4B4, D3DFMT.A4R4G4B4],
]);
/** @param {number} format @returns {number | undefined} */
const alphaTwin = format=>ALPHA_TWINS.get(format);
/** @param {number} format */
const isDepthFormat = format=>FORMAT_INFO[format] !== undefined && FORMAT_INFO[format].depth;

/**
 * @typedef {Object} DeviceServices
 *     Everything a device needs from outside itself. All of it is optional, and
 *     a device given none of it draws nothing while still answering every
 *     question about its own state.
 * @property {any} [backend]
 *     What draws. Its absence is what makes a headless build work.
 * @property {(address: number, length: number)=>Uint8Array} [readMemory]
 *     Required alongside a backend: the bytes a draw reads are the guest's.
 * @property {(address: number, length: number)=>Uint8Array} [windowMemory]
 * @property {(address: number, bytes: Uint8Array)=>void} [writeMemory]
 *     Where a fill or a copy between surfaces writes. Without it those calls
 *     describe their moves for the caller to make.
 * @property {(descriptor: any)=>any} [createSampler]
 * @property {(bytes: number)=>number} [allocate]
 *     Where a resource's storage goes. It has to be memory the guest can write
 *     through, because a lock hands the program this address and the unlock
 *     reads back exactly what it wrote there.
 * @property {(address: number)=>void} [free]
 * @property {(api: string, detail: string)=>void} [divergence]
 *     Where "this call succeeded and did not do all of what it promises" goes.
 * @property {boolean} [dumpDraws]
 * @property {number} [dumpEvery]
 * @property {{ dumpFrames: number }} [liveDump]
 *     Set on a running program to have its next frames with draws written
 *     down as `dumpDraws` writes them; counts down as they are.
 * @property {number} [maxDraws]
 * @property {string} [skipTexture]
 * @property {string} [probeTexture]
 * @property {boolean} [fog]
 * @property {'legacy' | 'current'} [driverRules]  The renderer's (`createRenderer`).
 * @property {boolean} [rectangleBump]  The renderer's (`createRenderer`).
 * @property {boolean} [keepMemory]  Released resources' memory is never given back (debugging).
 * @property {boolean} [rereadBuffers]  The renderer's (`createRenderer`).
 * @property {boolean} [mips]
 * @property {(watcher: () => void) => () => void} [onDeviceLost]
 *     Calls the watcher once the GPU underneath is gone for good, at once if it
 *     already is; returns how to stop watching. Absent, the GPU never goes.
 * @property {import('../webgpu/internal/presenter.js').DisplayGamma} [gamma]
 *     Where a full-screen device's gamma ramp reaches the picture. Absent, a
 *     ramp is kept and read back only.
 * @property {() => void} [occlusionCounted]
 *     Told whenever an occlusion count has come back from the GPU: where the
 *     program is told counts across a thread, so they can go to it unasked.
 * @property {import('../webgpu/internal/latency.js').FrameQueued} [frameQueued]
 *     Told of every frame a present queues; what it answers is what the
 *     present waits on before it answers the program. Absent, a present never
 *     waits.
 * @property {boolean} [renderedElsewhere]  the device records for one that draws in
 *     another thread, which makes the GPU's copies there
 * @property {(buffer: any, from: number, to: number) => void} [drawsFrom]
 *     Told the bytes of each dynamic buffer a draw reads (`drawn.js`), by a
 *     device that records for one drawing elsewhere, which has to be sent
 *     what the program wrote there after the unlock.
 */

/**
 * @typedef {Object} CreationParameters
 * @property {number} AdapterOrdinal
 * @property {number} DeviceType
 * @property {number} hFocusWindow
 * @property {number} BehaviorFlags
 */

/**
 * The object a program gets from Direct3DCreate9. It exists here for one
 * reason: device creation can fail on its parameters, and the caller has to be
 * able to see that failure without already holding a device.
 *
 * @param {Partial<DeviceCaps> & DeviceServices} [options]
 */
export function createDirect3D9(options = {}){
    const {
        backend, readMemory, windowMemory, writeMemory, createSampler, allocate: guestMemory,
        free: giveBack, divergence, dumpDraws, dumpEvery, liveDump, maxDraws, skipTexture,
        probeTexture, fog, mips, driverRules, onDeviceLost, gamma, frameQueued, renderedElsewhere,
        occlusionCounted,
        keepMemory, rereadBuffers, drawsFrom, rectangleBump, ...caps
    } = options;
    /** @type {DeviceCaps} */
    const resolved = { ...DEFAULT_CAPS, ...caps, fullscreenGamma: gamma?.applies() === true };
    /** @type {DeviceServices} */
    const services = {
        backend, readMemory, windowMemory, writeMemory, createSampler, allocate: guestMemory,
        // `keepMemory`: what a released resource held is never given back to
        // the guest's heap -- a debugging aid, for telling memory handed out
        // twice apart from a defect elsewhere.
        free: keepMemory === true ? undefined : giveBack, divergence, dumpDraws, dumpEvery,
        liveDump, maxDraws, skipTexture,
        probeTexture, fog, mips, driverRules, onDeviceLost, gamma, frameQueued, renderedElsewhere,
        occlusionCounted,
        rereadBuffers, drawsFrom, rectangleBump,
    };
    if (backend && !readMemory)
    {
        throw new Error('graphics/d3d9: a device that draws needs readMemory as well as a backend');
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
         * Whether a resource of this kind could be made in this format, from
         * the same table the creates consult, so that a program told yes here
         * is told yes there.
         *
         * @param {number} usage
         * @param {number} resourceType  D3DRTYPE
         * @param {number} format
         * @returns {number} D3D_OK or D3DERR_NOTAVAILABLE
         */
        CheckDeviceFormat(usage, resourceType, format){
            const info = FORMAT_INFO[format];
            if (!info || info.video)
            {
                return D3DERR_NOTAVAILABLE;
            }
            // D3DUSAGE_QUERY_SRGBREAD and _SRGBWRITE: nothing here reads or
            // writes a texture as sRGB, so a program told yes would draw in
            // the wrong space -- told no, it does its own correction or none.
            if ((usage & (USAGE_QUERY_SRGBREAD | USAGE_QUERY_SRGBWRITE)) !== 0)
            {
                return D3DERR_NOTAVAILABLE;
            }
            // Answered by what the WebGPU format the surface is made in does,
            // not by what a card of the era did with the format: A32B32G32R32F
            // narrowed to half floats is filtered and blended, where an
            // unfiltered answer would only send a program to filter it by hand.
            // A depth format's filter answer is left as it was; nothing blends
            // into one.
            const traits = info.depth ? null : formatTraits(gpuFormatOf(format, 4, 4, true));
            if ((usage & USAGE_QUERY_FILTER) !== 0 && traits && !traits.filterable)
            {
                return D3DERR_NOTAVAILABLE;
            }
            if ((usage & USAGE_QUERY_POSTPIXELSHADER_BLENDING) !== 0 && !traits?.blendable)
            {
                return D3DERR_NOTAVAILABLE;
            }
            const wantsTarget = (usage & D3DUSAGE.RENDERTARGET) !== 0;
            const wantsDepth = (usage & D3DUSAGE.DEPTHSTENCIL) !== 0;
            // Wine's d3d9 test_mipmap_gen: never for a dynamic texture, and
            // for a format no level is drawn into the texture is made
            // without them, which D3DOK_NOAUTOGEN says.
            if ((usage & D3DUSAGE.AUTOGENMIPMAP) !== 0)
            {
                if ((usage & D3DUSAGE.DYNAMIC) !== 0
                    || (resourceType !== D3DRTYPE.TEXTURE && resourceType !== D3DRTYPE.CUBETEXTURE))
                {
                    return D3DERR_NOTAVAILABLE;
                }
                const plain = root.CheckDeviceFormat(usage & ~D3DUSAGE.AUTOGENMIPMAP,
                    resourceType, format);
                return plain === D3D_OK && !generatesMips(format) ? D3DOK_NOAUTOGEN : plain;
            }
            // Legal on every device of the era regardless of `compressedTextures`,
            // which only chooses how a created texture's bytes travel to the
            // GPU; nothing draws into blocks, so a target or depth usage is
            // still refused.
            if ((isCompressed(format) || info.signed) && (wantsTarget || wantsDepth))
            {
                return D3DERR_NOTAVAILABLE;
            }
            switch (resourceType)
            {
                case D3DRTYPE.TEXTURE:
                    return (info.depth ? resolved.depthTexture2d && !wantsTarget : !wantsDepth)
                        ? D3D_OK
                        : D3DERR_NOTAVAILABLE;
                case D3DRTYPE.CUBETEXTURE:
                    return (info.depth ? resolved.depthCube && !wantsTarget : !wantsDepth)
                        ? D3D_OK
                        : D3DERR_NOTAVAILABLE;
                // A volume is sampled, never drawn into, and never made in
                // blocks here.
                case D3DRTYPE.VOLUMETEXTURE:
                    return !info.depth && !isCompressed(format) && !wantsTarget && !wantsDepth
                        ? D3D_OK
                        : D3DERR_NOTAVAILABLE;
                case D3DRTYPE.SURFACE:
                    if (wantsTarget)
                    {
                        return info.depth ? D3DERR_NOTAVAILABLE : D3D_OK;
                    }
                    if (wantsDepth)
                    {
                        return info.depth ? D3D_OK : D3DERR_NOTAVAILABLE;
                    }
                    return !info.depth || resolved.depthPlain ? D3D_OK : D3DERR_NOTAVAILABLE;
                default:
                    // Buffers have no format to ask about.
                    return D3DERR_NOTAVAILABLE;
            }
        },

        /**
         * @param {number} adapterFormat
         * @param {number} backBufferFormat
         * @param {boolean} [windowed]
         */
        CheckDeviceType(adapterFormat, backBufferFormat, windowed = true){
            // D3DFMT_UNKNOWN as the back buffer means "the adapter's", and is
            // legal only windowed.
            const back = backBufferFormat === D3DFMT.UNKNOWN
                ? (windowed ? adapterFormat : -1)
                : backBufferFormat;
            return isColourFormat(adapterFormat) && isColourFormat(back)
                ? D3D_OK
                : D3DERR_NOTAVAILABLE;
        },

        /**
         * One sample per pixel and no other count: this build renders no
         * multisampled target, which is the answer that keeps a program from
         * asking for one.
         *
         * @param {number} multiSampleType
         * @param {{ qualityLevels?: number }} [out]
         */
        CheckDeviceMultiSampleType(multiSampleType, out = {}){
            if (multiSampleType !== 0)
            {
                return D3DERR_NOTAVAILABLE;
            }
            out.qualityLevels = 1;
            return D3D_OK;
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
         * Whether a present can convert between two formats. Any two colour
         * formats: the back buffer is always drawn into the same surface and
         * the presentation makes no distinction.
         *
         * @param {number} sourceFormat
         * @param {number} targetFormat
         */
        CheckDeviceFormatConversion(sourceFormat, targetFormat){
            return isColourFormat(sourceFormat) && isColourFormat(targetFormat)
                ? D3D_OK
                : D3DERR_NOTAVAILABLE;
        },

        /**
         * @param {import("./validity.js").PresentParameters} parameters
         * @param {{ device?: ReturnType<typeof createDeviceObject> }} out
         * @param {number} [behaviourFlags]
         * @param {Partial<CreationParameters>} [creation]
         * @param {boolean} [extended]  Made through IDirect3D9Ex: see `createDeviceObject`.
         * @returns {number}
         */
        CreateDevice(parameters, out, behaviourFlags = 0, creation = {}, extended = false){
            const hr = validatePresentParameters(parameters, extended);
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
                normalisePresentParameters(parameters), resolved, services, {
                    direct3D: root,
                    AdapterOrdinal: creation.AdapterOrdinal ?? 0,
                    DeviceType: creation.DeviceType ?? D3DDEVTYPE.HAL,
                    hFocusWindow: creation.hFocusWindow ?? 0,
                    BehaviorFlags: behaviourFlags,
                }, extended);
            return D3D_OK;
        },
    };
    return root;
}

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

/** The resources one CheckResourceResidency may ask about. */
const MAX_RESIDENCY_QUERY = 65535;
/** The frames a device may queue ahead of the display, and how many it starts with. */
const MAX_FRAME_LATENCY = 30;
const DEFAULT_FRAME_LATENCY = 3;
/** What an Ex create's usage may carry beside the surface's own. */
const EX_SURFACE_USAGE = D3DUSAGE.RESTRICTED_CONTENT | D3DUSAGE.RESTRICT_SHARED_RESOURCE
    | D3DUSAGE.RESTRICT_SHARED_RESOURCE_DRIVER;

/**
 * A device made through IDirect3D9Ex -- `extended` -- is Direct3D 9Ex's:
 * never lost (TestCooperativeLevel always succeeds, and a GPU that went away
 * is D3DERR_DEVICEREMOVED), with no managed pool, resources a reset does not
 * wait for, and a reset that keeps the state (Wine's d3d9ex.c test_lost_device,
 * test_resource_access, test_reset_resources and test_reset_ex).
 *
 * @param {import("./validity.js").PresentParameters} parameters
 * @param {DeviceCaps} caps
 * @param {DeviceServices} services
 * @param {CreationParameters & { direct3D: any }} identity
 * @param {boolean} [extended]
 */
function createDeviceObject(parameters, caps, services, identity, extended = false){
    let presentParameters = parameters;
    /** Presents that reached the display, for GetLastPresentCount. */
    let presents = 0;
    let gpuThreadPriority = 0;
    let frameLatency = DEFAULT_FRAME_LATENCY;
    /** What a device that cannot be used answers: lost, or for an Ex device removed. */
    const lostAnswer = ()=>(extended ? D3DERR_DEVICEREMOVED : D3DERR_DEVICELOST);
    /**
     * A create in the managed pool, which an Ex device does not have (Wine's
     * d3d9ex.c test_resource_access).
     *
     * @param {number} pool
     */
    const unmanaged = pool=>extended && pool === D3DPOOL.MANAGED;
    /** @type {string} */
    let deviceState = DEVICE_STATE.OK;
    let inScene = false;
    let nextAddress = 0x40000000;
    /** Addresses this layer invented rather than took from the guest's heap. */
    const fabricated = new Set();
    /** What has already been reported, so a divergence in a loop says it once. */
    const reported = new Set();

    /**
     * @param {string} key   What makes the report one of a kind.
     * @param {string} detail
     */
    const report = (key, detail)=>{
        if (!services.divergence || reported.has(key))
        {
            return;
        }
        reported.add(key);
        services.divergence('Direct3D 9', detail);
    };

    /** @type {Map<number, number>} */
    let renderStates = createDefaultRenderStates({
        enableAutoDepthStencil: presentParameters.enableAutoDepthStencil === true,
        maxPointSize: caps.maxPointSize,
    });

    /** @type {Map<number, { light: Light, enabled: boolean }>} */
    let lights = new Map();
    let lightsVersion = 0;
    /**
     * Raised by every change of the state a draw's preparation is built from
     * -- through `setState`, a state block applied, a reset, a target -- so a
     * renderer prepares once per change rather than once per draw. The world
     * transform is left out, as the Direct3D 8 device leaves it out: it moves
     * between most draws, and whoever reads this owes it a fresh read on every
     * draw. A binding raises `bindingVersion` too, so the difference versions
     * everything beside the bindings: a texture, a buffer bound at the stride
     * its stream already had, and the shaders and the declaration, which a
     * renderer keys its preparations by apart from the rest -- a program that
     * switches shaders between draws has changed no render state.
     */
    let drawStateVersion = 1;
    let bindingVersion = 0;

    /** @type {Map<number, Map<number, number>>} stage -> its states, made on first touch */
    let stageStates = new Map();
    /** @type {Map<number, Float32Array>} D3DTS -> the matrix; absent means identity */
    let transforms = new Map();
    /** @type {Material} */
    let material = defaultMaterial();
    /** @type {Map<number, Float32Array>} */
    let clipPlanes = new Map();
    let nPatchMode = 0;
    let clipStatus = { ClipUnion: 0, ClipIntersection: 0 };
    let gammaRamp = identityRamp();
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
    let dialogBoxMode = false;
    let softwareVertexProcessing =
        (identity.BehaviorFlags & D3DCREATE.SOFTWARE_VERTEXPROCESSING) !== 0;
    const mixedVertexProcessing =
        (identity.BehaviorFlags & D3DCREATE.MIXED_VERTEXPROCESSING) !== 0;
    /** @type {{ hotSpot: { x: number, y: number }, surface: any, shown: boolean }} */
    let cursor = { hotSpot: { x: 0, y: 0 }, surface: null, shown: false };

    /**
     * The vertex layout: a declaration, and the format it was made from when
     * SetFVF made it. Both null and zero means nothing is set.
     *
     * @type {{ declaration: any, fvf: number }}
     */
    let vertexDeclaration = { declaration: null, fvf: 0 };
    /**
     * What `stageProcessing` last answered, and the bindings it answered for:
     * the shader objects and the declaration record, each replaced, never
     * written into, when it changes.
     *
     * @type {{ vertexShader: unknown, pixelShader: unknown, declaration: unknown,
     *     answer: any }}
     */
    const heldProcessing = { vertexShader: null, pixelShader: null, declaration: null,
        answer: null };
    /**
     * The declarations SetFVF has made, one per format, so that setting the
     * same format twice hands back the same object.
     *
     * @type {Map<number, any>}
     */
    const fvfDeclarations = new Map();
    /** @type {any} */
    let vertexShader = null;
    /** @type {any} */
    let pixelShader = null;
    const vertexConstants = createConstantFile(CONSTANT_FILE.vertex);
    const pixelConstants = createConstantFile(CONSTANT_FILE.pixel);

    /** @type {Map<number, { buffer: any, offset: number, stride: number }>} */
    const streams = new BindingMap();
    /** @type {Map<number, number>} */
    const streamFrequencies = new Map();
    /** @type {Map<number, any>} */
    const textures = new Map();
    /** @type {Map<number, any>} */
    const renderTargets = new Map();
    /** @type {any} */
    let indices = null;
    let baseVertexIndex = 0;

    /** @type {import('./stateblock.js').StateBlockRecord | null} */
    let recording = null;

    const count = createReferenceCount();

    const renderer = services.backend
        ? createRenderer({
            backend: services.backend,
            readMemory: /** @type {(address: number, length: number)=>Uint8Array} */ (
                services.readMemory),
            windowMemory: services.windowMemory,
            createSampler: services.createSampler ?? null,
            dumpDraws: services.dumpDraws,
            dumpEvery: services.dumpEvery,
            liveDump: services.liveDump,
            maxDraws: services.maxDraws,
            divergence: services.divergence,
            skipTexture: services.skipTexture,
            probeTexture: services.probeTexture,
            fog: services.fog,
            mips: services.mips,
            driverRules: services.driverRules,
            rectangleBump: services.rectangleBump,
            occlusionCounted: services.occlusionCounted,
            rereadBuffers: services.rereadBuffers,
            compressedTextures: caps.compressedTextures,
        })
        : null;

    /**
     * How a lockable render target reaches its pixels: read back off the GPU
     * before the lock, uploaded after the unlock. Absent when the renderer
     * cannot do either, and the lock then says so as a divergence.
     *
     * @returns {import('./resources.js').TargetPixels | undefined}
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
            written: surface=>renderer.markDirty?.(surface),
        };
    };

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
        fabricated.add(address);
        return address;
    };

    /** @param {number} address */
    const free = address=>{
        if (!fabricated.has(address))
        {
            services.free?.(address);
        }
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
        const made = addDirect3D9StageDefaults(createDefaultStageStates(stage));
        stageStates.set(stage, made);
        return made;
    };

    /**
     * Every resource the program holds that lives in the default pool, and so
     * has to be released before a reset. The set holds the counts rather than
     * the resources, so nothing here keeps a resource alive.
     *
     * @type {Set<{ pool: number, count: import('./resources.js').ReferenceCount }>}
     */
    const pooled = new Set();

    const videoMemory = createVideoMemory(caps.videoMemory ?? AVAILABLE_TEXTURE_MEMORY);

    /**
     * A resource that the program owns: it took a reference on the device.
     *
     * @param {number} [pool]
     * @param {() => void} [onGone]  What the resource gives back when its last
     *     reference goes, before the device's is released.
     */
    const explicitCount = (pool = D3DPOOL.MANAGED, onGone = ()=>{}, bytes = 0)=>{
        // The reference a resource holds on the device follows the program's
        // count: one the device keeps bound past the program's last Release
        // holds none, and taking it back takes one again (Wine's d3d9ex
        // test_reset_ex ends with the device's count at zero).
        count.addRef();
        const giveBack = videoMemory.take(pool, bytes);
        const made = createReferenceCount({
            onFirstRef: ()=>count.addRef(),
            onZero: ()=>count.release(),
            // Out of the set as soon as it is gone, not at the next reset: a
            // program that makes and releases buffers while it loads, and never
            // resets, would otherwise keep one entry for every buffer it made.
            onLastRef: ()=>{
                pooled.delete(entry);
                giveBack();
                onGone();
            },
        });
        const entry = { pool, count: made };
        pooled.add(entry);
        return made;
    };

    /** A resource the device owns: its first reference is one on the device. */
    const implicitCount = ()=>createReferenceCount({
        implicit: true,
        onFirstRef: ()=>count.addRef(),
        onLastRef: ()=>count.release(),
    });

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

    /**
     * Whether a default-pool resource is still held by the program, which is
     * what a reset is refused for.
     */
    const defaultPoolResourcesHeld = ()=>{
        for (const entry of pooled)
        {
            if (entry.count.destroyed)
            {
                pooled.delete(entry);
            }
            else if (entry.pool === D3DPOOL.DEFAULT && entry.count.value > 0)
            {
                return true;
            }
        }
        return backBuffers.some(surface=>surface.refCount > 0)
            || (autoDepthStencil !== null && autoDepthStencil.refCount > 0);
    };

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
            report(`released-while-bound:${what}`, `${what} answers NULL for a resource released `
                + 'to nothing while bound, which Windows keeps until it is unbound');
            return null;
        }
        resource.addRef();
        return resource;
    };

    /** @type {any[]} */
    let backBuffers = [];
    /** @type {any} */
    let autoDepthStencil = null;

    /**
     * The device's own surfaces give their storage back: those a Reset
     * replaces, and all of them when the device's last reference goes -- no
     * program can hold one then, since each it holds is a reference on the
     * device.
     */
    const retireImplicitSurfaces = ()=>{
        for (const surface of backBuffers)
        {
            retireSurface(surface);
            // A back buffer a program still holds past a reset is the
            // chain's no longer: its container is the device (Wine's
            // d3d9ex test_backbuffer_resize).
            surface.container = null;
        }
        if (autoDepthStencil)
        {
            retireSurface(autoDepthStencil);
        }
        backBuffers = [];
        autoDepthStencil = null;
    };

    /** The implicit surfaces at the size the presentation parameters name. */
    const makeImplicitSurfaces = ()=>{
        retireImplicitSurfaces();
        const width = presentParameters.backBufferWidth ?? 640;
        const height = presentParameters.backBufferHeight ?? 480;
        const format = presentParameters.backBufferFormat ?? D3DFMT.X8R8G8B8;
        backBuffers = [];
        for (let index = 0; index < (presentParameters.backBufferCount ?? 1); index++)
        {
            backBuffers.push(createSurface({
                type: SURFACE_TYPE.RENDER_TARGET,
                width,
                height,
                format,
                pool: D3DPOOL.DEFAULT,
                usage: D3DUSAGE.RENDERTARGET,
                lockable: presentParameters.lockableBackBuffer === true,
                base: allocate(surfaceBytes(format, width, height)),
                count: implicitCount(),
                rejectsMalformedRects: true,
                divergence: services.divergence ?? null,
                pixels: targetPixels(),
            }));
        }
        const depthFormat = presentParameters.autoDepthStencilFormat ?? D3DFMT.D24S8;
        autoDepthStencil = presentParameters.enableAutoDepthStencil
            ? createSurface({
                type: SURFACE_TYPE.DEPTH_STENCIL,
                width,
                height,
                format: depthFormat,
                pool: D3DPOOL.DEFAULT,
                usage: D3DUSAGE.DEPTHSTENCIL,
                base: allocate(surfaceBytes(depthFormat, width, height)),
                count: implicitCount(),
                rejectsMalformedRects: true,
            })
            : null;
    };
    makeImplicitSurfaces();

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
    /** @type {Rect} */
    let scissor = {
        left: 0, top: 0,
        right: presentParameters.backBufferWidth ?? 640,
        bottom: presentParameters.backBufferHeight ?? 480,
    };

    const swapChainCount = implicitCount();
    const swapChain = {
        get refCount(){
            return swapChainCount.value;
        },
        addRef: ()=>swapChainCount.addRef(),
        release: ()=>swapChainCount.release(),
        // The device keeps its implicit chain: a program that released the one
        // GetSwapChain answered may call through it while the device lives
        // (Wine's d3d9 test_swapchain does), so its pointer outlives its count.
        reachable: ()=>count.value > 0,

        /**
         * The type is not looked at: a stereo buffer asked for is the mono
         * one (Wine's d3d9 test_swapchain).
         *
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

        Present: ()=>device.Present(),

        get presentCount(){
            return presents;
        },

        /** @param {any} destination */
        GetFrontBufferData: destination=>device.GetFrontBufferData(0, destination),

        /** @param {{ device?: any }} out */
        GetDevice(out){
            device.addRef();
            out.device = device;
            return D3D_OK;
        },
    };

    /** The back buffers are the swap chain's, which is what GetContainer answers. */
    const adoptBackBuffers = ()=>{
        for (const surface of backBuffers)
        {
            surface.container = swapChain;
        }
    };
    adoptBackBuffers();

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
        // Its storage goes back when the last reference does, the program's or
        // the device's binding, whichever is later.
        const bufferCount = explicitCount(options.pool, ()=>free(base), options.length);
        const base = allocate(options.length);
        let locked = false;
        const buffer = {
            ...options,
            base,
            ...createPriority(options.pool),
            get refCount(){
                return bufferCount.value;
            },
            get destroyed(){
                return bufferCount.destroyed;
            },
            reachable: ()=>!bufferCount.destroyed,
            // Where guest code may count its references (`ReferenceCount.place`).
            counter: bufferCount,
            addRef: ()=>bufferCount.addRef(),
            release: ()=>bufferCount.release(),
            /** The device binds it (see `createReferenceCount`). */
            hold: ()=>bufferCount.hold?.(),
            letGo: ()=>bufferCount.letGo?.(),

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

            /** @param {{ desc?: any }} out */
            GetDesc(out){
                out.desc = {
                    Format: options.type === D3DRTYPE.INDEXBUFFER ? options.format : D3DFMT.UNKNOWN,
                    Type: options.type,
                    Usage: options.usage,
                    Pool: options.pool,
                    Size: options.length,
                    FVF: options.fvf ?? 0,
                };
                return D3D_OK;
            },
        };
        return buffer;
    };

    /**
     * The flexible vertex format a fixed-function draw reads its stream with:
     * the one SetFVF set, or the one a program's own declaration describes.
     * Zero when the declaration describes no format, which is a draw the
     * renderer cannot read.
     */
    const effectiveFvf = ()=>{
        const declaration = vertexDeclaration.declaration;
        if (!declaration)
        {
            return 0;
        }
        if (vertexDeclaration.fvf)
        {
            return vertexDeclaration.fvf;
        }
        // Asked on every draw; a declaration never changes, and working the
        // format out makes the elements the format would spell to compare.
        let fvf = declaredFvfs.get(declaration);
        if (fvf === undefined)
        {
            fvf = fvfOfElements(declaration.elements);
            declaredFvfs.set(declaration, fvf);
        }
        return fvf;
    };
    /** @type {WeakMap<object, number>} */
    const declaredFvfs = new WeakMap();

    /**
     * Whether a matrix a program is setting is the one already there, bit for
     * bit: a zero's sign is a different matrix to read back.
     *
     * @param {Float32Array} held @param {ArrayLike<number>} given
     */
    const sameMatrix = (held, given)=>{
        for (let at = 0; at < 16; at++)
        {
            const value = given[at];
            if (held[at] !== value || (value === 0 && 1 / held[at] !== 1 / value))
            {
                return false;
            }
        }
        return true;
    };

    /** @type {WeakMap<object, boolean>} */
    const transformedDeclarations = new WeakMap();
    /**
     * The vertex shader a draw runs: the bound one, unless the bound
     * declaration carries a POSITIONT element. Vertices already in target
     * pixels skip vertex processing altogether, a bound shader included --
     * which stays bound for the next draw through untransformed vertices. A
     * program that draws its screen quads that way without unbinding its
     * shader would otherwise run the shader on a position it never feeds.
     */
    const drawnVertexShader = ()=>{
        const declaration = vertexDeclaration.declaration;
        if (!vertexShader || !declaration)
        {
            return vertexShader;
        }
        let transformed = transformedDeclarations.get(declaration);
        if (transformed === undefined)
        {
            transformed = /** @type {boolean} */ (declaration.elements.some(
                (/** @type {any} */ element)=>element.Usage === D3DDECLUSAGE.POSITIONT));
            transformedDeclarations.set(declaration, transformed);
        }
        return transformed ? null : vertexShader;
    };

    /**
     * The layout the fixed-function pipeline reads the bound declaration
     * through when no vertex format spells it, worked out once per declaration.
     *
     * @type {WeakMap<object, import('./declaration.js').FixedFunctionLayout | null>}
     */
    const fixedFunctionLayouts = new WeakMap();
    const fixedFunctionLayout = ()=>{
        const declaration = vertexDeclaration.declaration;
        if (!declaration || drawnVertexShader() || effectiveFvf() !== 0)
        {
            return null;
        }
        let layout = fixedFunctionLayouts.get(declaration);
        if (layout === undefined)
        {
            layout = fixedFunctionLayoutOf(declaration);
            fixedFunctionLayouts.set(declaration, layout);
        }
        return layout;
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
        // Which streams step by instance, and how many instances a draw has.
        streamFrequencies,
        get stream(){
            return stream(0);
        },
        streamAt: stream,
        get scissor(){
            return scissor;
        },
        get indices(){
            return indices;
        },
        /** How many vertices of stream zero's offset the draw being made folded into its first. */
        get streamZeroBias(){
            return foldedBias;
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
        // The user clip planes, which D3DRS_CLIPPLANEENABLE says are in force.
        get clipPlanes(){
            return clipPlanes;
        },
        get lightsVersion(){
            return lightsVersion;
        },
        get drawStateVersion(){
            return drawStateVersion;
        },
        get stateVersionBesideTextures(){
            return drawStateVersion - bindingVersion;
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
     * The device's state as a block reads and writes it.
     *
     * @type {import('./stateblock.js').StateView}
     */
    const view = {
        get renderStates(){
            return renderStates;
        },
        stageStates: stageStatesFor,
        textures,
        get transforms(){
            return transforms;
        },
        get lights(){
            return lights;
        },
        lightsChanged: ()=>{
            lightsVersion++;
        },
        defaultLight,
        vertexConstants,
        pixelConstants,
        streams,
        streamFrequencies,
        get clipPlanes(){
            return clipPlanes;
        },
        maxClipPlanes: caps.maxUserClipPlanes,
        get material(){
            return copyMaterial(material);
        },
        set material(value){
            material = copyMaterial(value);
        },
        get viewport(){
            return viewport;
        },
        set viewport(value){
            viewport = value;
        },
        get scissor(){
            return { ...scissor };
        },
        set scissor(value){
            scissor = { ...value };
        },
        get vertexDeclaration(){
            return vertexDeclaration;
        },
        set vertexDeclaration(value){
            vertexDeclaration = value;
        },
        get vertexShader(){
            return vertexShader;
        },
        set vertexShader(value){
            vertexShader = value;
        },
        get pixelShader(){
            return pixelShader;
        },
        set pixelShader(value){
            pixelShader = value;
        },
        get indices(){
            return indices;
        },
        set indices(value){
            indices = rebound(indices, value);
        },
        get nPatchMode(){
            return nPatchMode;
        },
        set nPatchMode(value){
            nPatchMode = value;
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
        // Each refusal says which: the draw is simply missing from the picture otherwise.
        if (!inScene)
        {
            report('draw-scene', 'a draw outside BeginScene and EndScene was refused');
            return D3DERR_INVALIDCALL;
        }
        if (vertexCountOf(type, primitiveCount) === 0)
        {
            report('draw-count', `a draw of no vertices (type ${type}, ${primitiveCount}`
                + ' primitives) was refused');
            return D3DERR_INVALIDCALL;
        }
        if (!vertexDeclaration.declaration)
        {
            report('draw-declaration', 'a draw with no vertex declaration or FVF was refused');
            return D3DERR_INVALIDCALL;
        }
        // A format without one of the three position bits is not a format: a
        // program that set one is refused, where one whose own declaration
        // has no position is drawing something this device reports instead.
        if (vertexDeclaration.fvf !== 0 && (vertexDeclaration.fvf & 0xe) === 0)
        {
            report('draw-fvf', `a draw through FVF 0x${vertexDeclaration.fvf.toString(16)},`
                + ' which has no position, was refused');
            return D3DERR_INVALIDCALL;
        }
        return D3D_OK;
    };

    /**
     * Whether the renderer can read the vertices a draw is about to hand it.
     *
     * A draw the renderer cannot read still succeeds -- the program has done
     * nothing wrong -- and is reported once per cause, so a picture with
     * something missing says what is missing. The renderer counts the draw
     * as declined on its own.
     */
    const noteUndrawable = ()=>{
        if (drawnVertexShader() || pixelShader)
        {
            // The renderer builds the program and says what it could not.
            return;
        }
        if (vertexDeclaration.declaration && effectiveFvf() === 0 && !fixedFunctionLayout())
        {
            report('declaration',
                'a draw through a vertex declaration the fixed-function stage cannot read'
                + ' was not drawn');
        }
    };

    /**
     * How many whole vertices into its buffer stream zero starts.
     *
     * D3D9's stream binding carries a byte offset D3D8's does not. The whole
     * vertices of it are folded into the first vertex, and the renderer binds
     * the buffer at what is left (`streamZeroBias`). WebGPU binds a vertex
     * buffer only at a multiple of four bytes, so a remainder that is not one
     * is the one offset refused.
     *
     * @returns {number | null} null when the binding is unusable
     */
    /** The whole vertices the last draw folded into its first (`streamBias`), for the renderer. */
    let foldedBias = 0;
    const streamBias = ()=>{
        // Read, not made: `stream` keeps an entry for the index it is asked,
        // and a state block of everything captures every entry there is.
        const source = streams.get(0);
        // A declaration that reads nothing from stream zero -- none of its elements there, as
        // a vertex shader that makes its vertices from constants has it -- draws whatever
        // stream zero holds, nothing included, as Direct3D does.
        const elements = vertexDeclaration.declaration?.elements ?? [];
        if (vertexDeclaration.fvf === 0 && !elements.some((/** @type {any} */ e)=>e.Stream === 0))
        {
            foldedBias = 0;
            return 0;
        }
        if (!source?.buffer || !(source.stride > 0))
        {
            const read = [...new Set(elements.map((/** @type {any} */ e)=>e.Stream))].join(',');
            report(`draw-stream-${source?.buffer ? 'stride' : 'buffer'}-${read}`,
                `a draw with ${source?.buffer ? `stride ${source.stride}` : 'no vertex buffer'}`
                + ` on stream 0 was refused; its declaration reads streams ${read || 'none'}`
                + ` (FVF 0x${(vertexDeclaration.fvf ?? 0).toString(16)})`);
            return null;
        }
        // The first vertex moves every stream that steps with it, so no more
        // vertices are folded than each further stream the declaration reads
        // has whole in its own offset: one bound at its start beside a stream
        // zero far into a shared buffer would otherwise begin before its
        // buffer, and the renderer dropped the draw.
        let bias = Math.floor(source.offset / source.stride);
        for (const element of vertexDeclaration.fvf === 0 ? elements : [])
        {
            const further = element.Stream === 0 ? null : streams.get(element.Stream);
            const instanced = ((streamFrequencies.get(element.Stream) ?? 1)
                & STREAMSOURCE_INSTANCEDATA) !== 0;
            if (further?.buffer && further.stride > 0 && !instanced)
            {
                bias = Math.min(bias, Math.floor(further.offset / further.stride));
            }
        }
        if ((source.offset - bias * source.stride) % 4 !== 0)
        {
            report('draw-offset', `a draw from stream 0 at offset ${source.offset}, stride`
                + ` ${source.stride}, was refused: what is left past whole vertices is not`
                + ' a whole number of four bytes');
            return null;
        }
        foldedBias = bias;
        return bias;
    };

    /**
     * The streams a draw reads, for `drawsFrom`: those its declaration names,
     * or stream zero's for a vertex format.
     *
     * @returns {{ buffer: any, offset: number, stride: number, whole: boolean }[]}
     */
    const drawnStreams = ()=>{
        const elements = vertexDeclaration.declaration?.elements;
        const read = elements && vertexDeclaration.fvf === 0
            ? new Set(elements.map((/** @type {any} */ e)=>e.Stream)) : [0];
        const drawn = [];
        for (const index of read)
        {
            const bound = streams.get(index);
            if (bound?.buffer)
            {
                // D3DSTREAMSOURCE_INSTANCEDATA: read once per instance.
                const whole = ((streamFrequencies.get(index) ?? 1) & 0x80000000) !== 0;
                drawn.push({ buffer: bound.buffer, offset: bound.offset, stride: bound.stride,
                    whole });
            }
        }
        return drawn;
    };

    /**
     * The user-pointer draws leave stream zero and the index binding empty: the
     * data they drew came from neither, and a program that draws from a buffer
     * afterwards has to bind it again.
     */
    const unbindStreamZero = ()=>{
        stream(0).buffer = rebound(stream(0).buffer, null);
        indices = rebound(indices, null);
        baseVertexIndex = 0;
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
        if (!texture || typeof texture.GetSurfaceLevel !== 'function'
            || (texture.cube
                ? texture.GetCubeMapSurface(face, level, held)
                : texture.GetSurfaceLevel(level, held)) !== D3D_OK || !held.surface)
        {
            return null;
        }
        held.surface.release();
        return held.surface;
    };

    /** @param {import('./resources.js').SurfaceDesc} desc */
    const pitchOf = desc=>surfacePitch(desc.Format, desc.Width);

    const rectMove = rectMoveOf;

    /**
     * Makes the moves, when this device can reach guest memory; otherwise
     * leaves them for the caller, which is how the seam without a writer and a
     * test without a machine both get them.
     *
     * @param {SurfaceMove[]} moves
     * @param {{ moves?: SurfaceMove[] }} out
     */
    const deliverMoves = (moves, out)=>{
        out.moves = moves;
        const read = services.windowMemory ?? services.readMemory;
        if (!services.writeMemory || !read)
        {
            return;
        }
        for (const move of moves)
        {
            if (move.rowBytes === move.fromPitch && move.rowBytes === move.toPitch)
            {
                services.writeMemory(move.to, read(move.from, move.rowBytes * move.rows));
                continue;
            }
            for (let row = 0; row < move.rows; row++)
            {
                services.writeMemory(move.to + row * move.toPitch,
                    read(move.from + row * move.fromPitch, move.rowBytes));
            }
        }
    };

    /**
     * Whether a surface is one the renderer keeps on the GPU, as it decides
     * (`onGpu` in d3d8/render.js): a colour surface that is a texture's level
     * or a render target.
     *
     * @param {any} surface
     */
    const drawnOnGpu = surface=>{
        const desc = describe(surface);
        return !FORMAT_INFO[desc.Format].depth
            && (Boolean(surface.container) || (desc.Usage & D3DUSAGE.RENDERTARGET) !== 0);
    };

    /**
     * Two surfaces the GPU holds in one texture, which it cannot draw from one
     * into the other.
     *
     * @param {any} a @param {any} b
     */
    const oneTexture = (a, b)=>a === b || (Boolean(a.container) && a.container === b.container);

    /**
     * A surface that lives on the GPU: what was drawn into it is not in the
     * guest's bytes, and a copy out of those bytes copies something else.
     *
     * @param {any} surface
     */
    const isGpuResident = surface=>{
        const desc = describe(surface);
        return (desc.Usage & (D3DUSAGE.RENDERTARGET | D3DUSAGE.DEPTHSTENCIL)) !== 0;
    };

    /**
     * Whether a rectangle lies within a surface, edges the right way round.
     *
     * @param {Rect} rect @param {import('./resources.js').SurfaceDesc} desc
     */
    const rectWithin = (rect, desc)=>rect.left >= 0 && rect.top >= 0 && rect.right > rect.left
        && rect.bottom > rect.top && rect.right <= desc.Width && rect.bottom <= desc.Height;

    /** @param {import('./resources.js').SurfaceDesc} desc @returns {Rect} */
    const wholeOf = desc=>({ left: 0, top: 0, right: desc.Width, bottom: desc.Height });

    /**
     * Fills a rectangle of a surface's guest bytes with one colour, packed the
     * way the format lays a pixel out.
     *
     * @param {any} surface @param {Rect} rect @param {number} colour
     */
    const fillBytes = (surface, rect, colour)=>{
        if (!services.writeMemory)
        {
            return;
        }
        const desc = describe(surface);
        const bytes = FORMAT_INFO[desc.Format].bytesPerPixel;
        const pixel = packColour(desc.Format, colour);
        const row = new Uint8Array((rect.right - rect.left) * bytes);
        for (let x = 0; x < rect.right - rect.left; x++)
        {
            row.set(pixel, x * bytes);
        }
        const pitch = pitchOf(desc);
        for (let y = rect.top; y < rect.bottom; y++)
        {
            services.writeMemory(surface.base + y * pitch + rect.left * bytes, row);
        }
    };

    /**
     * A texture's storage, for whoever needs to know what a lock hands out.
     *
     * @param {{ width: number, height: number, levels: number, format: number, pool: number,
     *           usage: number, cube?: boolean, allocate?: (bytes: number) => number,
     *           free?: (address: number) => void }} spec
     *        `allocate` and `free`: where the levels are kept, when not in
     *        memory of the device's own.
     */
    const makeTexture = spec=>{
        const texture = createTexture({
            ...spec,
            count: explicitCount(spec.pool, undefined,
                chainBytes(spec.format, spec.width, spec.height, 1, spec.levels)
                * (spec.cube ? 6 : 1)),
            allocate: spec.allocate ?? allocate,
            free: spec.free ?? free,
            // This version refuses a lock rectangle that is not one.
            rejectsMalformedRects: true,
        });
        renderer?.trackTexture?.(texture, spec);
        return texture;
    };

    /**
     * Sets one value, into the recording block if one is open and into the
     * device otherwise.
     *
     * @param {(record: import('./stateblock.js').StateBlockRecord) => void} record
     * @param {() => void} apply
     * @param {boolean} [binding]  the value is a binding: a texture, a buffer at
     *     its stream's stride, a shader or the declaration
     */
    const setState = (record, apply, binding = false)=>{
        if (recording)
        {
            record(recording);
        }
        else
        {
            apply();
            drawStateVersion++;
            if (binding)
            {
                bindingVersion++;
            }
        }
        return D3D_OK;
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
     * A swap chain's back buffer presented: onto the display when it goes
     * into the window the display shows, and otherwise drawn and kept, which
     * is reported once.
     *
     * @param {any} backBuffer @param {boolean} shown
     * @returns {number | Promise<number>}
     */
    const presentChain = (backBuffer, shown)=>{
        if (deviceState !== DEVICE_STATE.OK)
        {
            return lostAnswer();
        }
        if (shown)
        {
            return presented(renderer?.present(
                Object.create(model, { backBuffer: { get: ()=>backBuffer } })));
        }
        report('chain-window', 'a swap chain presented into a window the display does not'
            + ' show: its frame is drawn and its picture is not shown');
        return presented(renderer?.submit());
    };

    /** The state a plain device's reset puts back to what a new device has. */
    const resetState = ()=>{
        renderStates = createDefaultRenderStates({
            enableAutoDepthStencil: presentParameters.enableAutoDepthStencil === true,
            maxPointSize: caps.maxPointSize,
        });
        lights = new Map();
        lightsVersion++;
        stageStates = new Map();
        transforms = new Map();
        material = defaultMaterial();
        clipPlanes = new Map();
        nPatchMode = 0;
        vertexDeclaration = { declaration: null, fvf: 0 };
        vertexShader = null;
        pixelShader = null;
        streams.clear();
        streamFrequencies.clear();
        textures.clear();
        indices = rebound(indices, null);
        baseVertexIndex = 0;
    };

    /**
     * What a front buffer holds, as A8R8G8B8, into a system-memory surface:
     * the display's picture, or what an additional swap chain last presented
     * -- black before it presented anything.
     *
     * @param {any} destination
     * @param {any} chain  An additional swap chain, or null for the display.
     * @returns {number | Promise<number>}
     */
    const readFrontInto = (destination, chain)=>{
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
            report('frontbuffer', 'GetFrontBufferData was refused: this build draws nothing'
                + ' it can read back');
            return D3DERR_INVALIDCALL;
        }
        if (presentParameters.windowed)
        {
            report('frontbuffer-windowed', 'GetFrontBufferData puts a windowed device\'s'
                + ' picture at the surface\'s corner, not where the window stands on the'
                + ' desktop');
        }
        const read = chain
            ? chain.presented ? renderer.readFront(chain.presented) : Promise.resolve(null)
            : renderer.readFront();
        return read.then((/** @type {any} */ image)=>{
            writeFrontBuffer(destination, image, write);
            renderer.markDirty?.(destination);
            return D3D_OK;
        });
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
                // What it kept bound goes with it.
                streams.clear();
                indices = rebound(indices, null);
                rebound(renderTargets.get(0), null);
                renderTargets.clear();
                depthStencil = rebound(depthStencil, null);
                retireImplicitSurfaces();
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

        get recording(){
            return recording !== null;
        },

        TestCooperativeLevel(){
            if (extended)
            {
                return D3D_OK;
            }
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

        /** @param {{ direct3D?: any }} out */
        GetDirect3D(out){
            identity.direct3D.addRef();
            out.direct3D = identity.direct3D;
            return D3D_OK;
        },

        /** @param {{ parameters?: CreationParameters }} out */
        GetCreationParameters(out){
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
            return videoMemory.available();
        },

        /**
         * Nothing here is managed on the device's behalf: a texture's storage
         * is the guest's own memory and is uploaded when it changes, so there
         * is nothing to evict and the call has already done all it can.
         */
        EvictManagedResources(){
            return D3D_OK;
        },

        GetNumberOfSwapChains(){
            return 1;
        },

        /**
         * A device that can be reset still cannot present: the two answers
         * differ, and a program that resets on the strength of Present alone
         * never learns that the device came back.
         */
        /** @returns {number | Promise<number>} */
        Present(){
            if (deviceState !== DEVICE_STATE.OK)
            {
                return lostAnswer();
            }
            const submitted = renderer?.present(model);
            presents++;
            return presented(submitted);
        },

        /** Made through IDirect3D9Ex. */
        get extended(){
            return extended;
        },

        // --- Direct3D 9Ex's own ---

        /**
         * D3D_OK while the device can be used, D3DERR_DEVICEREMOVED once its
         * GPU is gone. Whether the window is covered is not known here, so
         * S_PRESENT_OCCLUDED is never answered.
         */
        CheckDeviceState(){
            return deviceState === DEVICE_STATE.OK ? D3D_OK : D3DERR_DEVICEREMOVED;
        },

        /** @param {{ priority?: number }} out */
        GetGPUThreadPriority(out){
            out.priority = gpuThreadPriority;
            return D3D_OK;
        },

        /** @param {number} priority  -7 to 7. */
        SetGPUThreadPriority(priority){
            if (priority < -7 || priority > 7)
            {
                return D3DERR_INVALIDCALL;
            }
            gpuThreadPriority = priority;
            return D3D_OK;
        },

        /**
         * The device's own chain is the one there is to wait on; the wait is
         * the display's and not this device's to make.
         *
         * @param {number} chain
         */
        WaitForVBlank(chain){
            return chain === 0 ? D3D_OK : D3DERR_INVALIDCALL;
        },

        /**
         * Every resource is resident: a texture's storage is the guest's own
         * memory and its GPU copy lives as long as it does.
         *
         * @param {number} resources  How many were asked about.
         */
        CheckResourceResidency(resources){
            return resources > MAX_RESIDENCY_QUERY ? D3DERR_INVALIDCALL : D3D_OK;
        },

        /**
         * Up to 30 frames; zero stands for the default of three (Wine's
         * d3d9ex.c test_frame_latency).
         *
         * @param {number} latency
         */
        SetMaximumFrameLatency(latency){
            if (latency > MAX_FRAME_LATENCY)
            {
                return D3DERR_INVALIDCALL;
            }
            frameLatency = latency || DEFAULT_FRAME_LATENCY;
            return D3D_OK;
        },

        /** @param {{ latency?: number }} out */
        GetMaximumFrameLatency(out){
            out.latency = frameLatency;
            return D3D_OK;
        },

        /**
         * The Ex creates: the plain ones with a usage beside, which may only
         * be the restrictions on sharing and protected content (Wine's
         * d3d9ex.c test_create_depth_stencil_surface_ex).
         *
         * @param {number} width @param {number} height @param {number} format
         * @param {boolean} lockable @param {number} usage @param {{ surface?: any }} out
         */
        CreateRenderTargetEx(width, height, format, lockable, usage, out){
            return (usage & ~EX_SURFACE_USAGE) !== 0
                ? D3DERR_INVALIDCALL
                : device.CreateRenderTarget(width, height, format, lockable, out, usage);
        },

        /**
         * @param {number} width @param {number} height @param {number} format
         * @param {number} usage @param {{ surface?: any }} out
         */
        CreateDepthStencilSurfaceEx(width, height, format, usage, out){
            return (usage & ~EX_SURFACE_USAGE) !== 0
                ? D3DERR_INVALIDCALL
                : device.CreateDepthStencilSurface(width, height, format, out, usage);
        },

        /**
         * @param {number} width @param {number} height @param {number} format
         * @param {number} pool @param {number} usage @param {{ surface?: any }} out
         */
        CreateOffscreenPlainSurfaceEx(width, height, format, pool, usage, out){
            return (usage & ~EX_SURFACE_USAGE) !== 0
                ? D3DERR_INVALIDCALL
                : device.CreateOffscreenPlainSurface(width, height, format, pool, out, usage);
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

        /**
         * The calls a run of the command ring carried, made in order
         * (`commands.js`). The program was told D3D_OK for each when it made
         * it, so one this device refuses is a divergence, said once.
         *
         * @param {Uint8Array} records
         * @param {readonly any[]} [objects]  what the records' object arguments name, in order
         * @returns {number} how many calls were made
         */
        commands(records, objects = []){
            renderer?.pause(true);
            try
            {
                return runCommands(/** @type {any} */ (device), records, objects, (name, hr)=>report(
                    `commands:${name}`, name === 'commands'
                        ? 'a command ring held a record its routines could not have written'
                        : `${name} made in the guest was answered D3D_OK; the device answers ${
                            hr.toString(16)}`));
            }
            finally
            {
                renderer?.pause(false);
            }
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
         * What the command ring's routines check a call against in the guest
         * (`seam/shadow.js`): what a draw needs that this device has -- the
         * conditions `drawPreconditions`, `streamBias` and the indexed draw
         * refuse without -- the target's size, the clip planes, and the format
         * just set, which the device takes or not for its value alone.
         */
        ringState(){
            const declared = vertexDeclaration.declaration !== null
                && (vertexDeclaration.fvf === 0 || (vertexDeclaration.fvf & 0xe) !== 0);
            const target = renderTargets.get(0);
            return {
                drawable: (inScene ? 1 : 0) | (declared ? 2 : 0)
                    | (streamBias() !== null ? 4 : 0) | (indices ? 8 : 0),
                targetWidth: target ? describe(target).Width : 0,
                targetHeight: target ? describe(target).Height : 0,
                clipPlanes: caps.maxUserClipPlanes,
                taken: [vertexDeclaration.fvf >>> 0],
            };
        },

        /**
         * Reset puts the device back to what it was created as: no scene open,
         * default state, implicit surfaces at the new size, usable again.
         *
         * Two refusals. A device lost beyond recovery cannot be reset at all.
         * And a reset while the program still holds a default-pool resource --
         * its own, or one of the device's back buffers -- fails and leaves the
         * device needing a reset, which is how a program that forgot to
         * release something finds out: it sees DEVICENOTRESET from then on.
         *
         * An Ex device's resources outlive a reset, so none stops one, and its
         * state is kept but for the targets, the viewport's rectangle and the
         * scissor, which take the new back buffer.
         *
         * A Reset played from a recording (`asRecorded`) has already been
         * answered to the program by the recording device, which counts what
         * the program holds: one this side still counts held is a reference
         * of its own the program never took, said once rather than refused.
         *
         * @param {import("./validity.js").PresentParameters} [next]
         * @param {boolean} [asRecorded]
         */
        Reset(next, asRecorded = false){
            if (deviceState === DEVICE_STATE.LOST)
            {
                return lostAnswer();
            }
            if (next)
            {
                const hr = validatePresentParameters(next, extended);
                if (hr !== D3D_OK)
                {
                    return hr;
                }
            }
            if (!extended && defaultPoolResourcesHeld() && asRecorded)
            {
                report('reset-held', 'a Reset the program was answered D3D_OK went ahead here'
                    + ' with a default-pool resource or back buffer held that the program does'
                    + ' not hold');
            }
            else if (!extended && defaultPoolResourcesHeld())
            {
                deviceState = DEVICE_STATE.NOT_RESET;
                return D3DERR_INVALIDCALL;
            }
            if (next)
            {
                presentParameters = normalisePresentParameters(next);
            }
            inScene = false;
            recording = null;
            deviceState = DEVICE_STATE.OK;
            if (!extended)
            {
                resetState();
            }
            makeImplicitSurfaces();
            adoptBackBuffers();
            renderTargets.set(0, rebound(renderTargets.get(0), backBuffers[0]));
            depthStencil = rebound(depthStencil, autoDepthStencil);
            const target = describe(backBuffers[0]);
            // An extended device keeps the depth range it had.
            viewport = viewportState({
                x: 0, y: 0, width: target.Width, height: target.Height,
                ...(extended
                    ? { minDepth: viewport.rect.minDepth, maxDepth: viewport.rect.maxDepth }
                    : {}),
            });
            scissor = wholeOf(target);
            drawStateVersion++;
            // The ramp outlasts the reset; whether it is shown follows the mode.
            showGamma();
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
            // A program sets the value already there constantly; doing nothing
            // keeps a renderer's preparation of the state it already has.
            if (!recording && renderStates.get(state) === value >>> 0)
            {
                return D3D_OK;
            }
            return setState(
                record=>record.renderStates.set(state, value >>> 0),
                ()=>renderStates.set(state, value >>> 0));
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
            if (!light)
            {
                return D3DERR_INVALIDCALL;
            }
            // Set again with what it holds, as a program that sets its lights
            // before every model does: observably nothing, and a new version
            // would have every draw after it name its state again.
            if (recording)
            {
                const held = recording.lights.get(index);
                recording.lights.set(index,
                    { light: { ...light }, enabled: held?.enabled ?? false });
                return D3D_OK;
            }
            const existing = lights.get(index);
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
         * existence, so the read that follows succeeds.
         *
         * @param {number} index
         * @param {boolean} enable
         */
        LightEnable(index, enable){
            if (!recording && lights.get(index)?.enabled === (enable === true))
            {
                return D3D_OK;
            }
            return setState(
                record=>{
                    const held = record.lights.get(index);
                    record.lights.set(index,
                        { light: held?.light ?? null, enabled: enable === true });
                },
                ()=>{
                    const record = lights.get(index) ?? { light: defaultLight(), enabled: false };
                    record.enabled = enable === true;
                    lights.set(index, record);
                    lightsVersion++;
                });
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
            if (stage < 0 || (stage >= STAGE_COUNT && !isSampler(stage)))
            {
                return D3DERR_INVALIDCALL;
            }
            if (!recording && (textures.get(stage) ?? null) === (texture ?? null))
            {
                return D3D_OK;
            }
            return setState(
                record=>record.textures.set(stage, texture ?? null),
                ()=>{
                    if (texture)
                    {
                        textures.set(stage, texture);
                    }
                    else
                    {
                        textures.delete(stage);
                    }
                }, true);
        },

        /**
         * @param {number} stage
         * @param {{ texture?: any }} out
         */
        GetTexture(stage, out){
            if (stage < 0 || (stage >= STAGE_COUNT && !isSampler(stage)))
            {
                return D3DERR_INVALIDCALL;
            }
            out.texture = handOut(textures.get(stage) ?? null, 'GetTexture');
            return D3D_OK;
        },

        /**
         * A type outside this version's list is accepted and ignored, which is
         * what the runtime does with one; a stage past the last is refused.
         *
         * @param {number} stage
         * @param {number} type   D3DTSS, as Direct3D 9 numbers them
         * @param {number} value
         */
        SetTextureStageState(stage, type, value){
            if (stage < 0 || stage >= STAGE_COUNT)
            {
                return D3DERR_INVALIDCALL;
            }
            if (!STAGE_STATE_TYPES.has(type))
            {
                return D3D_OK;
            }
            if (!recording && stageStatesFor(stage).get(type) === value >>> 0)
            {
                return D3D_OK;
            }
            return setState(
                record=>record.stageStates.set((stage << 8) | type, value >>> 0),
                ()=>stageStatesFor(stage).set(type, value >>> 0));
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
            if (!STAGE_STATE_TYPES.has(type))
            {
                return D3D_OK;
            }
            out.value = stageStatesFor(stage).get(type) ?? 0;
            return D3D_OK;
        },

        /**
         * @param {number} sampler
         * @param {number} type   D3DSAMP
         * @param {number} value
         */
        SetSamplerState(sampler, type, value){
            if (!isSampler(sampler) || !SAMPLER_STATE_TYPES.has(type))
            {
                return D3DERR_INVALIDCALL;
            }
            if (!recording
                && stageStatesFor(sampler).get(SAMPLER_STATE_KEY[type]) === value >>> 0)
            {
                return D3D_OK;
            }
            return setState(
                record=>record.samplerStates.set((sampler << 8) | type, value >>> 0),
                ()=>stageStatesFor(sampler).set(SAMPLER_STATE_KEY[type], value >>> 0));
        },

        /**
         * @param {number} sampler
         * @param {number} type   D3DSAMP
         * @param {{ value?: number }} out
         */
        GetSamplerState(sampler, type, out){
            if (!isSampler(sampler) || !SAMPLER_STATE_TYPES.has(type))
            {
                return D3DERR_INVALIDCALL;
            }
            out.value = stageStatesFor(sampler).get(SAMPLER_STATE_KEY[type]) ?? 0;
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
            if (recording)
            {
                recording.transforms.set(type, new Float32Array(matrix));
                return D3D_OK;
            }
            // Setting the matrix already there is nothing, as for every other
            // state. The world moves before most draws, and the renderer
            // reads it afresh on every draw rather than by the version; nothing
            // keeps the matrix the device holds past the call that reads it
            // -- a state block, GetTransform and the renderer copy it -- so a
            // new world is written over it rather than made.
            const held = transforms.get(type);
            if (held && sameMatrix(held, matrix))
            {
                return D3D_OK;
            }
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
         *        A type never written reads back as the identity, which is what
         *        an untouched transform is, rather than as a failure.
         */
        GetTransform(type, out){
            out.matrix = Float32Array.from(transforms.get(type) ?? IDENTITY);
            return D3D_OK;
        },

        /**
         * The given matrix times the current one, as Direct3D documents it
         * ("pMatrix times" the state) and Wine computes it: the given matrix
         * is applied first, inside what was there.
         *
         * @param {number} type
         * @param {ArrayLike<number>} matrix
         */
        MultiplyTransform(type, matrix){
            if (!matrix || matrix.length !== 16)
            {
                return D3DERR_INVALIDCALL;
            }
            const product = multiplyMatrices(matrix, transforms.get(type) ?? IDENTITY);
            return setState(
                record=>record.transforms.set(type, product),
                ()=>transforms.set(type, product));
        },

        /** @param {Material} value */
        SetMaterial(value){
            if (!value)
            {
                return D3DERR_INVALIDCALL;
            }
            return setState(
                record=>{
                    record.material = copyMaterial(value);
                },
                ()=>{
                    material = copyMaterial(value);
                });
        },

        /** @param {{ material?: Material }} out */
        GetMaterial(out){
            out.material = copyMaterial(material);
            return D3D_OK;
        },

        /**
         * @param {number} index
         * @param {ArrayLike<number>} plane  Four floats.
         */
        SetClipPlane(index, plane){
            if (index < 0 || index >= caps.maxUserClipPlanes || !plane || plane.length !== 4)
            {
                return D3DERR_INVALIDCALL;
            }
            return setState(
                record=>record.clipPlanes.set(index, Float32Array.from(plane)),
                ()=>clipPlanes.set(index, Float32Array.from(plane)));
        },

        /**
         * @param {number} index
         * @param {{ plane?: Float32Array }} out
         */
        GetClipPlane(index, out){
            if (index < 0 || index >= caps.maxUserClipPlanes)
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
            clipStatus = { ClipUnion: status.ClipUnion >>> 0,
                ClipIntersection: status.ClipIntersection >>> 0 };
            return D3D_OK;
        },

        /** @param {{ status?: { ClipUnion: number, ClipIntersection: number } }} out */
        GetClipStatus(out){
            out.status = { ...clipStatus };
            return D3D_OK;
        },

        /**
         * The rectangle is kept as given: a program sets one larger than the
         * target and expects it back, and the clip to the target is the
         * renderer's business at the draw.
         *
         * @param {Rect} rect
         */
        SetScissorRect(rect){
            if (!rect)
            {
                return D3DERR_INVALIDCALL;
            }
            return setState(
                record=>{
                    record.scissor = { ...rect };
                },
                ()=>{
                    scissor = { ...rect };
                });
        },

        /** @param {{ rect?: Rect }} out */
        GetScissorRect(out){
            out.rect = { ...scissor };
            return D3D_OK;
        },

        /**
         * Only a device created for mixed processing can switch; the others
         * are what they were created as.
         *
         * @param {boolean} software
         */
        SetSoftwareVertexProcessing(software){
            if (!mixedVertexProcessing)
            {
                return software === softwareVertexProcessing ? D3D_OK : D3DERR_INVALIDCALL;
            }
            softwareVertexProcessing = software === true;
            return D3D_OK;
        },

        /** @returns {boolean} */
        GetSoftwareVertexProcessing(){
            return softwareVertexProcessing;
        },

        /**
         * Kept and read back; nothing tessellates. A program that checks the
         * capability block finds no N-patch support and never sets this.
         *
         * @param {number} segments
         */
        SetNPatchMode(segments){
            return setState(
                record=>{
                    record.nPatchMode = segments;
                },
                ()=>{
                    nPatchMode = segments;
                });
        },

        /** @returns {number} */
        GetNPatchMode(){
            return nPatchMode;
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

        /** @param {{ ramp?: GammaRamp }} out */
        GetGammaRamp(out){
            out.ramp = {
                red: Uint16Array.from(gammaRamp.red),
                green: Uint16Array.from(gammaRamp.green),
                blue: Uint16Array.from(gammaRamp.blue),
            };
        },

        ...createPalettes(),

        /**
         * Noted and nothing else. The mode exists so that a GDI dialog can be
         * drawn over a full-screen device; here the window is the browser's
         * and every dialog is drawn by the same path as the frame.
         *
         * @param {boolean} enable
         */
        SetDialogBoxMode(enable){
            dialogBoxMode = enable === true;
            return D3D_OK;
        },

        get dialogBoxMode(){
            return dialogBoxMode;
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
            const desc = describe(surface);
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

        /**
         * The vertex format: in this version a declaration made from it, so
         * that a program reading the declaration back gets one. Zero is
         * accepted and does nothing, which is what the runtime does with it.
         *
         * @param {number} value
         */
        SetFVF(value){
            const fvf = value >>> 0;
            if (fvf === 0)
            {
                return D3D_OK;
            }
            let declaration = fvfDeclarations.get(fvf);
            if (!declaration)
            {
                const elements = elementsOfFvf(fvf);
                if (!elements)
                {
                    return D3DERR_INVALIDCALL;
                }
                // Owned by the device: the count keeps it alive for as long as
                // the device is, so the same object comes back every time.
                declaration = createVertexDeclaration({
                    elements, fvf, count: createReferenceCount(),
                });
                fvfDeclarations.set(fvf, declaration);
            }
            if (!recording && vertexDeclaration.declaration === declaration)
            {
                return D3D_OK;
            }
            const next = { declaration, fvf };
            return setState(
                record=>{
                    record.vertexDeclaration = next;
                },
                ()=>{
                    vertexDeclaration = next;
                }, true);
        },

        /**
         * The format the current declaration was made from. A declaration the
         * program made itself has none, even when its elements describe one.
         *
         * @param {{ fvf?: number }} out
         */
        GetFVF(out){
            out.fvf = vertexDeclaration.fvf;
            return D3D_OK;
        },

        /**
         * @param {readonly import('./declaration.js').VertexElement[] | null} elements
         *        Without the sentinel.
         * @param {{ declaration?: any }} out
         */
        CreateVertexDeclaration(elements, out){
            if (!elements || !out)
            {
                return D3DERR_INVALIDCALL;
            }
            const hr = validateElements(elements);
            if (hr !== D3D_OK)
            {
                return hr;
            }
            out.declaration = createVertexDeclaration({ elements, count: explicitCount() });
            return D3D_OK;
        },

        /** @param {any} declaration  null unbinds. */
        SetVertexDeclaration(declaration){
            // Set again, it changes nothing a draw reads. A program that sets
            // its declaration before every draw would otherwise move the
            // state's version every draw, and every preparation keyed to it.
            if (!recording && vertexDeclaration.declaration === (declaration ?? null))
            {
                return D3D_OK;
            }
            const next = { declaration: declaration ?? null, fvf: declaration?.fvf ?? 0 };
            return setState(
                record=>{
                    record.vertexDeclaration = next;
                },
                ()=>{
                    vertexDeclaration = next;
                }, true);
        },

        /** @param {{ declaration?: any }} out */
        GetVertexDeclaration(out){
            const declaration = vertexDeclaration.declaration;
            if (declaration)
            {
                declaration.addRef();
            }
            out.declaration = declaration;
            return D3D_OK;
        },

        /**
         * A shader is made only when the device advertises its version: a
         * program that checked the capability block has already taken the other
         * path, and one that did not is told at the create rather than drawn
         * wrong at every frame after it.
         *
         * @param {Uint32Array | ArrayLike<number> | null} tokens
         * @param {{ shader?: any }} out
         */
        CreateVertexShader(tokens, out){
            return createShaderObject(SHADER_KIND.VERTEX, caps.vertexShaderVersion, tokens, out);
        },

        /** @param {any} shader  null unbinds. */
        SetVertexShader(shader){
            if (!recording && vertexShader === (shader ?? null))
            {
                return D3D_OK;
            }
            return setState(
                record=>{
                    record.vertexShader = shader ?? null;
                },
                ()=>{
                    vertexShader = shader ?? null;
                }, true);
        },

        /** @param {{ shader?: any }} out */
        GetVertexShader(out){
            if (vertexShader)
            {
                vertexShader.addRef();
            }
            out.shader = vertexShader;
            return D3D_OK;
        },

        /**
         * @param {Uint32Array | ArrayLike<number> | null} tokens
         * @param {{ shader?: any }} out
         */
        CreatePixelShader(tokens, out){
            return createShaderObject(SHADER_KIND.PIXEL, caps.pixelShaderVersion, tokens, out);
        },

        /** @param {any} shader */
        SetPixelShader(shader){
            if (!recording && pixelShader === (shader ?? null))
            {
                return D3D_OK;
            }
            return setState(
                record=>{
                    record.pixelShader = shader ?? null;
                },
                ()=>{
                    pixelShader = shader ?? null;
                }, true);
        },

        /** @param {{ shader?: any }} out */
        GetPixelShader(out){
            if (pixelShader)
            {
                pixelShader.addRef();
            }
            out.shader = pixelShader;
            return D3D_OK;
        },

        // The six constant setters and their readers. A set while recording
        // goes into the block one register at a time; a get reads the device.

        /** @param {number} start @param {ArrayLike<number>} values @param {number} n */
        SetVertexShaderConstantF: (start, values, n)=>setConstants(
            vertexConstants, 'floats', start, values, n, record=>record.vertexConstantsF),
        /** @param {number} start @param {number} n @param {{ values?: Float32Array }} out */
        GetVertexShaderConstantF: (start, n, out)=>vertexConstants.getF(start, n, out),
        /** @param {number} start @param {ArrayLike<number>} values @param {number} n */
        SetVertexShaderConstantI: (start, values, n)=>setConstants(
            vertexConstants, 'ints', start, values, n, record=>record.vertexConstantsI),
        /** @param {number} start @param {number} n @param {{ values?: Int32Array }} out */
        GetVertexShaderConstantI: (start, n, out)=>vertexConstants.getI(start, n, out),
        /** @param {number} start @param {ArrayLike<number>} values @param {number} n */
        SetVertexShaderConstantB: (start, values, n)=>setConstants(
            vertexConstants, 'bools', start, values, n, record=>record.vertexConstantsB),
        /** @param {number} start @param {number} n @param {{ values?: Uint32Array }} out */
        GetVertexShaderConstantB: (start, n, out)=>vertexConstants.getB(start, n, out),
        /** @param {number} start @param {ArrayLike<number>} values @param {number} n */
        SetPixelShaderConstantF: (start, values, n)=>setConstants(
            pixelConstants, 'floats', start, values, n, record=>record.pixelConstantsF),
        /** @param {number} start @param {number} n @param {{ values?: Float32Array }} out */
        GetPixelShaderConstantF: (start, n, out)=>pixelConstants.getF(start, n, out),
        /** @param {number} start @param {ArrayLike<number>} values @param {number} n */
        SetPixelShaderConstantI: (start, values, n)=>setConstants(
            pixelConstants, 'ints', start, values, n, record=>record.pixelConstantsI),
        /** @param {number} start @param {number} n @param {{ values?: Int32Array }} out */
        GetPixelShaderConstantI: (start, n, out)=>pixelConstants.getI(start, n, out),
        /** @param {number} start @param {ArrayLike<number>} values @param {number} n */
        SetPixelShaderConstantB: (start, values, n)=>setConstants(
            pixelConstants, 'bools', start, values, n, record=>record.pixelConstantsB),
        /** @param {number} start @param {number} n @param {{ values?: Uint32Array }} out */
        GetPixelShaderConstantB: (start, n, out)=>pixelConstants.getB(start, n, out),

        /**
         * What the two stages are running: the format a fixed-function draw
         * reads, and -- when a shader is bound -- everything the renderer
         * needs to build the program: the parsed shaders, the declaration
         * and the constant files, all live views.
         */
        get stageProcessing(){
            // Asked for by every draw: the answer is kept while the shaders and
            // the declaration it was made from are the ones bound.
            const held = heldProcessing;
            if (held.answer !== null && held.vertexShader === vertexShader
                && held.pixelShader === pixelShader && held.declaration === vertexDeclaration)
            {
                return held.answer;
            }
            held.vertexShader = vertexShader;
            held.pixelShader = pixelShader;
            held.declaration = vertexDeclaration;
            const vertex = drawnVertexShader();
            held.answer = {
                vertexShader: vertex ? vertex.id : 0,
                fvf: effectiveFvf(),
                fixedFunctionLayout: fixedFunctionLayout(),
                fixedFunctionVertex: !vertex,
                pixelShader: pixelShader ? pixelShader.id : 0,
                program: vertex || pixelShader
                    ? {
                        vertex: vertex?.parsed ?? null,
                        vertexShader: vertex ?? null,
                        vertexId: vertex?.id ?? 0,
                        pixel: pixelShader?.parsed ?? null,
                        pixelShader: pixelShader ?? null,
                        pixelId: pixelShader?.id ?? 0,
                        declaration: vertexDeclaration.declaration?.elements ?? null,
                        declarationId: vertexDeclaration.declaration?.id ?? 0,
                        vertexConstants,
                        pixelConstants,
                    }
                    : null,
            };
            return held.answer;
        },

        /**
         * Clears the viewport, or the given rectangles within it, and within
         * the scissor rectangle when the scissor test is on: a viewport smaller
         * than the target leaves everything outside it alone, and so does the
         * scissor. An array with a count of zero names no rectangle and clears
         * nothing; a count without an array is the whole viewport.
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
            let areas = rects ? rects.slice(0, rectCount) : [];
            if ((renderStates.get(D3DRS.SCISSORTESTENABLE) ?? 0) !== 0)
            {
                const box = { x1: scissor.left, y1: scissor.top, x2: scissor.right,
                    y2: scissor.bottom };
                const rect = viewport.rect;
                const whole = { x1: rect.x, y1: rect.y, x2: rect.x + rect.width,
                    y2: rect.y + rect.height };
                areas = (areas.length > 0 ? areas : [whole]).map(area=>({
                    x1: Math.max(area.x1, box.x1),
                    y1: Math.max(area.y1, box.y1),
                    x2: Math.min(area.x2, box.x2),
                    y2: Math.min(area.y2, box.y2),
                })).filter(area=>area.x2 > area.x1 && area.y2 > area.y1);
                if (areas.length === 0)
                {
                    return D3D_OK;
                }
            }
            renderer?.clear(model, areas, flags, color >>> 0, z, stencil);
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
            noteUndrawable();
            if (services.drawsFrom)
            {
                reportDynamicReads(services.drawsFrom, drawnStreams(), startVertex,
                    vertexCountOf(type, primitiveCount));
            }
            renderer?.drawPrimitive(model, type, startVertex + bias, primitiveCount);
            return D3D_OK;
        },

        /**
         * The base vertex is an argument of the draw in this version, where
         * D3D8 carried it on the index binding. The minimum index and vertex
         * count are hints, which say only which bytes a later lock must not
         * overwrite under the draw.
         *
         * @param {number} type
         * @param {number} base
         * @param {number} minIndex
         * @param {number} numVertices
         * @param {number} startIndex
         * @param {number} primitiveCount
         */
        DrawIndexedPrimitive(type, base, minIndex, numVertices, startIndex, primitiveCount){
            const bias = streamBias();
            if (drawPreconditions(type, primitiveCount) !== D3D_OK || bias === null || !indices)
            {
                return D3DERR_INVALIDCALL;
            }
            noteUndrawable();
            baseVertexIndex = base + bias;
            if (services.drawsFrom)
            {
                reportDynamicReads(services.drawsFrom, drawnStreams(), base + minIndex, numVertices,
                    indices, startIndex, vertexCountOf(type, primitiveCount));
            }
            renderer?.drawIndexedPrimitive(model, type, startIndex, primitiveCount, minIndex,
                numVertices);
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
            noteUndrawable();
            renderer?.drawPrimitiveUp(model, type, primitiveCount, vertexData, stride);
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
            // The indices count from the first vertex; minIndex only says where
            // the range they use begins.
            const reach = minIndex + numVertices;
            if (drawPreconditions(type, primitiveCount) !== D3D_OK || !vertexData || !indexData
                || !(stride > 0) || vertexData.byteLength < reach * stride)
            {
                return D3DERR_INVALIDCALL;
            }
            noteUndrawable();
            renderer?.drawIndexedPrimitiveUp(model, type, reach, primitiveCount, indexData,
                indexFormat, vertexData, stride);
            unbindStreamZero();
            return D3D_OK;
        },

        // Nothing tessellates: the capability block claims no patches, and a
        // program that draws one anyway is refused rather than drawn wrong.
        DrawRectPatch: ()=>D3DERR_INVALIDCALL,
        DrawTriPatch: ()=>D3DERR_INVALIDCALL,
        DeletePatch: ()=>D3DERR_INVALIDCALL,

        /**
         * The fixed-function transform and lighting of `vertices` vertices from
         * `start`, read through the bound declaration as a draw reads them,
         * into a vertex buffer from `destinationIndex`, laid out as
         * `declaration` describes or, without one, as the buffer's own format
         * (Wine's d3d9 visual.c test_sysmem_draw). A vertex shader would run
         * in software here, which nothing does, so it is refused.
         *
         * @param {number} start @param {number} destinationIndex @param {number} vertices
         * @param {any} destination @param {any} declaration @param {number} flags D3DPV
         */
        ProcessVertices(start, destinationIndex, vertices, destination, declaration, flags){
            if (!destination || destination.type !== D3DRTYPE.VERTEXBUFFER)
            {
                return D3DERR_INVALIDCALL;
            }
            if (vertexShader || !services.readMemory || !services.writeMemory)
            {
                report('process', vertexShader
                    ? 'ProcessVertices through a vertex shader was refused: no shader runs on'
                        + ' the processor'
                    : 'ProcessVertices was refused: this build cannot write guest memory');
                return D3DERR_INVALIDCALL;
            }
            const fvf = effectiveFvf();
            const attributes = fvf !== 0
                ? decodeFvf(fvf).attributes.map(attribute=>({ ...attribute, stream: 0 }))
                : fixedFunctionLayout()?.attributes ?? null;
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
                            base: source.buffer.base + source.offset,
                            stride: source.stride,
                            vertices: Math.floor(
                                (source.buffer.length - source.offset) / source.stride),
                        }
                        : null;
                },
                start, count: vertices, destination, destinationIndex, flags,
                destinationFvf: declaration
                    ? declaration.fvf || fvfOfElements(declaration.elements)
                    : destination.fvf ?? 0,
                renderer,
            });
        },

        /** @param {any} buffer */
        SetIndices(buffer){
            if (!recording && indices === (buffer ?? null))
            {
                return D3D_OK;
            }
            // Which buffer the indices come from shapes no preparation.
            return setState(
                record=>{
                    record.indices = buffer ?? null;
                },
                ()=>{
                    indices = rebound(indices, buffer ?? null);
                }, true);
        },

        /** @param {{ buffer?: any }} out */
        GetIndices(out){
            out.buffer = handOut(indices, 'GetIndices');
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
            if (index < 0 || index >= MAX_STREAMS)
            {
                return D3DERR_INVALIDCALL;
            }
            const bound = stream(index);
            if (!recording && bound.buffer === (buffer ?? null)
                && (!buffer || (bound.offset === offset && bound.stride === stride)))
            {
                return D3D_OK;
            }
            // Another buffer at the stride the stream had is a binding: a
            // preparation reads the stride, never the buffer.
            const sameStride = !buffer || bound.stride === stride;
            return setState(
                record=>{
                    const held = record.streams.get(index) ?? stream(index);
                    record.streams.set(index, {
                        buffer: buffer ?? null,
                        offset: buffer ? offset : held.offset,
                        stride: buffer ? stride : held.stride,
                    });
                },
                ()=>{
                    bound.buffer = rebound(bound.buffer, buffer ?? null);
                    if (buffer)
                    {
                        bound.offset = offset;
                        bound.stride = stride;
                    }
                }, sameStride);
        },

        /**
         * @param {number} index
         * @param {{ buffer?: any, offset?: number, stride?: number }} out
         */
        GetStreamSource(index, out){
            if (index < 0 || index >= MAX_STREAMS)
            {
                return D3DERR_INVALIDCALL;
            }
            const record = stream(index);
            out.buffer = handOut(record.buffer, 'GetStreamSource');
            out.offset = record.offset;
            out.stride = record.stride;
            return D3D_OK;
        },

        /**
         * A frequency is a count, or a count with one of two flags; both flags
         * at once is nothing, and instance data on stream zero is refused
         * because that stream carries the geometry.
         *
         * @param {number} index
         * @param {number} frequency
         */
        SetStreamSourceFreq(index, frequency){
            const both = (STREAMSOURCE_INDEXEDDATA | STREAMSOURCE_INSTANCEDATA) >>> 0;
            const flags = (frequency & both) >>> 0;
            const divider = (frequency & ~both) >>> 0;
            if (index < 0 || index >= MAX_STREAMS || divider === 0
                || flags === both
                || (index === 0 && flags === STREAMSOURCE_INSTANCEDATA))
            {
                return D3DERR_INVALIDCALL;
            }
            return setState(
                record=>record.streamFrequencies.set(index, frequency >>> 0),
                ()=>streamFrequencies.set(index, frequency >>> 0));
        },

        /**
         * @param {number} index
         * @param {{ frequency?: number }} out
         */
        GetStreamSourceFreq(index, out){
            if (index < 0 || index >= MAX_STREAMS)
            {
                return D3DERR_INVALIDCALL;
            }
            out.frequency = streamFrequencies.get(index) ?? 1;
            return D3D_OK;
        },

        /**
         * One target: the renderer draws into index zero, and the capability
         * block says so, which is what makes refusing a higher index right.
         *
         * @param {number} index
         * @param {any} surface
         */
        SetRenderTarget(index, surface){
            if (index !== 0 || !surface)
            {
                return D3DERR_INVALIDCALL;
            }
            const target = describe(surface);
            if ((target.Usage & D3DUSAGE.RENDERTARGET) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            renderTargets.set(index, rebound(renderTargets.get(index), surface));
            // A new target resets the viewport and the scissor to all of it,
            // so that one left over from a smaller target cannot stay latched.
            viewport = fullTarget({ width: target.Width, height: target.Height });
            scissor = wholeOf(target);
            drawStateVersion++;
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
            // A viewport may reach past the target: what falls outside it is
            // not drawn, and what falls inside keeps the viewport's mapping.
            // Direct3D 8 refuses the same rectangle; this version takes it.
            if (!value || !(value.Width > 0) || !(value.Height > 0) || value.X < 0 || value.Y < 0)
            {
                return D3DERR_INVALIDCALL;
            }
            // The same rectangle again keeps the object a renderer names the
            // state by, so the state it names is still the one it has.
            /** @type {{ viewport?: any, depthWords?: [number, number] }} */
            const held = {};
            answerViewport(viewport, held);
            const words = depthWordsOf(value);
            if (!recording && held.viewport.X === value.X && held.viewport.Y === value.Y
                && held.viewport.Width === value.Width && held.viewport.Height === value.Height
                && held.depthWords?.[0] === words[0] && held.depthWords?.[1] === words[1])
            {
                return D3D_OK;
            }
            const next = viewportState({
                x: value.X,
                y: value.Y,
                width: value.Width,
                height: value.Height,
                minDepth: value.MinZ,
                maxDepth: value.MaxZ,
            });
            next.depthWords = words;
            return setState(
                record=>{
                    record.viewport = next;
                },
                ()=>{
                    viewport = next;
                });
        },

        /** @param {{ viewport?: any, depthWords?: [number, number] }} out */
        GetViewport(out){
            answerViewport(viewport, out);
            return D3D_OK;
        },

        /**
         * The textures bound to the stages, without the reference GetTexture
         * hands out: what a draw made now samples, for a recording that sends
         * a texture's bytes before the first draw that reads them.
         */
        get boundTextures(){
            return textures.values();
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
            if (index !== 0)
            {
                return D3DERR_INVALIDCALL;
            }
            const surface = handOut(renderTargets.get(index), 'GetRenderTarget');
            if (!surface)
            {
                return D3DERR_NOTFOUND;
            }
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
         * a null colour target meant "keep the current one". A surface that is
         * not a depth stencil is refused.
         *
         * @param {any} surface
         */
        SetDepthStencilSurface(surface){
            if (surface && (describe(surface).Usage & D3DUSAGE.DEPTHSTENCIL) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            depthStencil = rebound(depthStencil, surface ?? null);
            drawStateVersion++;
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
            out.surface = handOut(depthStencil, 'GetDepthStencilSurface');
            return out.surface ? D3D_OK : D3DERR_NOTFOUND;
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
         * @param {number} [userMemory]  An Ex device's memory of the program's
         *     own for the texture's one level, in the system-memory pool alone.
         */
        CreateTexture(width, height, levels, usage, format, pool, out, userMemory = 0){
            if (unmanaged(pool) || !blockAligned(format, width, height))
            {
                return D3DERR_INVALIDCALL;
            }
            const hr = checkTextureArguments(usage, format, pool, caps, false);
            if (hr !== D3D_OK)
            {
                reportRefusedFormat(format);
                return hr;
            }
            if (!(width > 0) || !(height > 0) || !autoGenAllowed(usage, levels, pool))
            {
                return D3DERR_INVALIDCALL;
            }
            if (userMemory !== 0 && (pool !== D3DPOOL.SYSTEMMEM || levels !== 1))
            {
                return D3DERR_INVALIDCALL;
            }
            out.texture = makeTexture({
                width, height, format, pool, usage,
                ...chainOf(usage, format, levels, fullMipCount(width, height)),
                ...userMemory === 0 ? {} : { allocate: ()=>userMemory, free: ()=>{} },
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
            if (unmanaged(pool) || !blockAligned(format, edgeLength, edgeLength))
            {
                return D3DERR_INVALIDCALL;
            }
            const hr = checkTextureArguments(usage, format, pool, caps, true);
            if (hr !== D3D_OK)
            {
                reportRefusedFormat(format);
                return hr;
            }
            if (!(edgeLength > 0) || !autoGenAllowed(usage, levels, pool))
            {
                return D3DERR_INVALIDCALL;
            }
            out.texture = makeTexture({
                width: edgeLength,
                height: edgeLength,
                format,
                pool,
                usage,
                cube: true,
                ...chainOf(usage, format, levels, fullMipCount(edgeLength, edgeLength)),
            });
            return D3D_OK;
        },

        /**
         * @param {number} width @param {number} height @param {number} depth
         * @param {number} levels  Zero for the whole chain.
         * @param {number} usage @param {number} format @param {number} pool
         * @param {{ texture?: any }} out
         */
        CreateVolumeTexture(width, height, depth, levels, usage, format, pool, out){
            if (unmanaged(pool))
            {
                return D3DERR_INVALIDCALL;
            }
            const hr = volumeCreateResult({
                width, height, depth, levels, usage, format, pool,
                maxExtent: caps.maxVolumeExtent,
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
                count: explicitCount(pool, undefined,
                    chainBytes(format, width, height, depth, chain)), allocate, free,
            });
            renderer?.trackTexture?.(texture,
                { width, height, depth, format, levels: chain, usage });
            out.texture = texture;
            return D3D_OK;
        },

        /**
         * The multisample type is dropped rather than refused: this device
         * renders one sample per pixel whatever it is asked for, and a target
         * that differs from the back buffer only in that is still a target it
         * can draw into.
         *
         * @param {number} width
         * @param {number} height
         * @param {number} format
         * @param {boolean} lockable
         * @param {{ surface?: any }} out
         * @param {number} [usage]  What an Ex create adds to the target's own.
         */
        CreateRenderTarget(width, height, format, lockable, out, usage = 0){
            const info = FORMAT_INFO[format];
            if (!info || info.depth || info.signed || isCompressed(format)
                || !(width > 0) || !(height > 0))
            {
                return D3DERR_INVALIDCALL;
            }
            const surface = createSurface({
                type: SURFACE_TYPE.RENDER_TARGET,
                width,
                height,
                format,
                pool: D3DPOOL.DEFAULT,
                usage: D3DUSAGE.RENDERTARGET | usage,
                lockable,
                base: allocate(surfaceBytes(format, width, height)),
                count: explicitCount(D3DPOOL.DEFAULT, ()=>retireSurface(surface),
                    surfaceBytes(format, width, height)),
                rejectsMalformedRects: true,
                divergence: services.divergence ?? null,
                pixels: targetPixels(),
            });
            out.surface = surface;
            return D3D_OK;
        },

        /**
         * @param {number} width
         * @param {number} height
         * @param {number} format
         * @param {{ surface?: any }} out
         * @param {number} [usage]  What an Ex create adds to the surface's own.
         */
        CreateDepthStencilSurface(width, height, format, out, usage = 0){
            const info = FORMAT_INFO[format];
            if (!info || !info.depth || !(width > 0) || !(height > 0))
            {
                return D3DERR_INVALIDCALL;
            }
            const surface = createSurface({
                type: SURFACE_TYPE.DEPTH_STENCIL,
                width,
                height,
                format,
                pool: D3DPOOL.DEFAULT,
                usage: D3DUSAGE.DEPTHSTENCIL | usage,
                base: allocate(surfaceBytes(format, width, height)),
                count: explicitCount(D3DPOOL.DEFAULT, ()=>retireSurface(surface),
                    surfaceBytes(format, width, height)),
                rejectsMalformedRects: true,
            });
            out.surface = surface;
            return D3D_OK;
        },

        /**
         * @param {number} width
         * @param {number} height
         * @param {number} format
         * @param {number} pool
         * @param {{ surface?: any }} out
         * @param {number} [usage]  What an Ex create adds.
         * @param {number} [userMemory]  An Ex device's memory of the program's own
         *     for the surface, in the system-memory pool alone.
         */
        CreateOffscreenPlainSurface(width, height, format, pool, out, usage = 0, userMemory = 0){
            const info = FORMAT_INFO[format];
            if (!info || pool === D3DPOOL.MANAGED || (info.depth && !caps.depthPlain)
                || (info.video && !videoPoolAllowed(pool, true))
                || !(width > 0) || !(height > 0) || !blockAligned(format, width, height)
                || (userMemory !== 0 && pool !== D3DPOOL.SYSTEMMEM))
            {
                return D3DERR_INVALIDCALL;
            }
            const surface = createSurface({
                type: SURFACE_TYPE.PLAIN,
                width,
                height,
                format,
                pool,
                usage,
                base: userMemory || allocate(surfaceBytes(format, width, height)),
                // The program's own memory stays the program's.
                count: explicitCount(pool, ()=>(userMemory === 0 ? retireSurface(surface)
                    : renderer?.retire(surface)), surfaceBytes(format, width, height)),
                rejectsMalformedRects: true,
            });
            out.surface = surface;
            return D3D_OK;
        },

        /**
         * The format is kept and nothing reads it: a draw takes its layout from
         * the device's own vertex declaration, which is the one a program is
         * obliged to set. It is a parameter here because it is one in the call.
         *
         * @param {number} length
         * @param {number} usage
         * @param {number} vertexFormat
         * @param {number} pool
         * @param {{ buffer?: any }} out
         */
        CreateVertexBuffer(length, usage, vertexFormat, pool, out){
            if (!(length > 0) || unmanaged(pool))
            {
                return D3DERR_INVALIDCALL;
            }
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
            if (!(length > 0) || unmanaged(pool))
            {
                return D3DERR_INVALIDCALL;
            }
            out.buffer = createBuffer({
                length, usage, pool, format, type: D3DRTYPE.INDEXBUFFER,
            });
            return D3D_OK;
        },

        // --- copies between surfaces ---

        /**
         * A rectangle of a system-memory surface into a default-pool one, at a
         * point. Same format, no depth, nothing that lives on the GPU as the
         * source. The moves are described as addresses, and made when this
         * device can write guest memory.
         *
         * @param {any} source @param {Rect | null} sourceRect
         * @param {any} destination @param {{ x: number, y: number } | null} point
         * @param {{ moves?: SurfaceMove[] }} [out]
         */
        UpdateSurface(source, sourceRect, destination, point, out = {}){
            if (!source || !destination || source === destination)
            {
                return D3DERR_INVALIDCALL;
            }
            const from = describe(source);
            const to = describe(destination);
            if (from.Pool !== D3DPOOL.SYSTEMMEM || to.Pool !== D3DPOOL.DEFAULT
                || from.Format !== to.Format || FORMAT_INFO[from.Format].depth)
            {
                return D3DERR_INVALIDCALL;
            }
            const rect = sourceRect ?? wholeOf(from);
            const at = point ?? { x: 0, y: 0 };
            if (!rectWithin(rect, from) || at.x < 0 || at.y < 0
                || at.x + (rect.right - rect.left) > to.Width
                || at.y + (rect.bottom - rect.top) > to.Height)
            {
                return D3DERR_INVALIDCALL;
            }
            deliverMoves([rectMove(source, rect, destination, at)], out);
            renderer?.markDirty?.(destination);
            return D3D_OK;
        },

        /**
         * Every level of a system-memory texture into the matching level of a
         * default-pool one. The destination may have fewer levels, in which
         * case the source's top levels are the ones copied. Matched levels
         * must be the same size: the move takes its rows from the source and
         * its pitch from the destination, and a larger source would run past
         * the destination's bytes.
         *
         * @param {any} source @param {any} destination
         * @param {{ moves?: SurfaceMove[] }} [out]
         */
        UpdateTexture(source, destination, out = {}){
            if (!source || !destination || source === destination)
            {
                return D3DERR_INVALIDCALL;
            }
            if (source.volume || destination.volume)
            {
                const update = source.volume && destination.volume
                    && source.pool === D3DPOOL.SYSTEMMEM && destination.pool === D3DPOOL.DEFAULT
                    ? volumeUpdate(source, destination)
                    : null;
                if (!update)
                {
                    return D3DERR_INVALIDCALL;
                }
                deliverMoves(update.moves, out);
                for (const volume of update.written)
                {
                    renderer?.markDirty?.(volume);
                }
                return D3D_OK;
            }
            const top = levelSurface(source, 0);
            const target = levelSurface(destination, 0);
            if (!top || !target)
            {
                return D3DERR_INVALIDCALL;
            }
            const from = describe(top);
            const to = describe(target);
            if (from.Pool !== D3DPOOL.SYSTEMMEM || to.Pool !== D3DPOOL.DEFAULT
                || from.Format !== to.Format
                || (source.cube ?? false) !== (destination.cube ?? false))
            {
                return D3DERR_INVALIDCALL;
            }
            // A destination that makes its own levels takes the source's top
            // one and makes the rest from it.
            const skipped = destination.autoGen
                ? 0
                : Math.max(0, source.levels - destination.levels);
            const faces = source.cube ? 6 : 1;
            /** @type {{ one: any, other: any, level: number, face: number }[]} */
            const pairs = [];
            for (let face = 0; face < faces; face++)
            {
                for (let level = 0; level < destination.levels; level++)
                {
                    const one = levelSurface(source, level + skipped, face);
                    const other = levelSurface(destination, level, face);
                    if (!one || !other)
                    {
                        break;
                    }
                    const desc = describe(one);
                    const into = describe(other);
                    if (desc.Width !== into.Width || desc.Height !== into.Height)
                    {
                        return D3DERR_INVALIDCALL;
                    }
                    pairs.push({ one, other, level: level + skipped, face });
                }
            }
            // What the source was written in since it was last carried, and
            // nothing more: an update of a source nobody touched moves nothing
            // (Wine's d3d9 add_dirty_rect_test). A cube's faces are carried
            // each by its own region.
            const regions = Array.from({ length: faces },
                (_, face)=>source.takeDirtyRegion?.(face) ?? null);
            /** @type {SurfaceMove[]} */
            const moves = [];
            const carried = pairs.filter(pair=>regions[pair.face] !== null);
            for (const { one, other, level, face } of carried)
            {
                const desc = describe(one);
                const rect = regionAtLevel(regions[face], level, desc.Width, desc.Height);
                moves.push(rectMove(one, rect, other, { x: rect.left, y: rect.top }));
            }
            deliverMoves(moves, out);
            for (const { other } of carried)
            {
                renderer?.markDirty?.(other);
            }
            return D3D_OK;
        },

        /**
         * A render target into a system-memory surface of the same size and
         * format. With a renderer that can read the GPU back, the pixels are
         * the target's as drawn, and the caller waits for them; without one,
         * what is copied is the target's guest bytes, and the call is reported
         * so a run that reads a frame back knows what it got -- refusing it
         * would send a program down a path it was not written for.
         *
         * @param {any} target @param {any} destination
         * @param {{ moves?: SurfaceMove[] }} [out]
         * @returns {number | Promise<number>}
         */
        GetRenderTargetData(target, destination, out = {}){
            if (!target || !destination)
            {
                return D3DERR_INVALIDCALL;
            }
            const from = describe(target);
            const to = describe(destination);
            if ((from.Usage & D3DUSAGE.RENDERTARGET) === 0 || to.Pool !== D3DPOOL.SYSTEMMEM
                || from.Format !== to.Format || from.Width !== to.Width
                || from.Height !== to.Height)
            {
                return D3DERR_INVALIDCALL;
            }
            if (renderer?.readSurface && services.writeMemory)
            {
                const write = services.writeMemory;
                return renderer.readSurface(target).then(
                    (/** @type {{ data: Uint8Array }} */ pixels)=>{
                        writePixels(destination, pixels.data, write);
                        return D3D_OK;
                    });
            }
            report('readback', 'GetRenderTargetData copies a target\'s guest bytes, which the'
                + ' rendered pixels are never read back into');
            deliverMoves([rectMove(target, wholeOf(from), destination, { x: 0, y: 0 })], out);
            return D3D_OK;
        },

        /**
         * The picture the last present showed, as A8R8G8B8, into a
         * system-memory surface (Wine's d3d9 test_multisample_get_front_buffer_data);
         * the caller waits for it to come back from the GPU. The front buffer
         * of a windowed device is the desktop's, with the window where it
         * stands; here it is the window's picture at the surface's top-left
         * corner, and said so once. Without a renderer that can read back
         * there is no picture to copy, and the call is refused.
         *
         * @param {number} swapChainIndex
         * @param {any} destination
         * @returns {number | Promise<number>}
         */
        GetFrontBufferData(swapChainIndex, destination){
            return swapChainIndex === 0
                ? readFrontInto(destination, null)
                : D3DERR_INVALIDCALL;
        },

        /**
         * A swap chain beside the device's own, windowed only (Wine's d3d9
         * test_swapchain): its back buffers are its own, at the size and in
         * the format its parameters give, and GetSwapChain never names it.
         *
         * @param {any} asked  PresentParameters, with the window it presents
         *        into as `hDeviceWindow`, which the caller resolves.
         * @param {{ swapChain?: any }} out
         */
        CreateAdditionalSwapChain(asked, out){
            if (!asked || asked.windowed === false
                || validatePresentParameters(asked, extended) !== D3D_OK)
            {
                return D3DERR_INVALIDCALL;
            }
            const wanted = {
                ...normalisePresentParameters(asked),
                hDeviceWindow: asked.hDeviceWindow ?? 0,
            };
            const width = wanted.backBufferWidth ?? 640;
            const height = wanted.backBufferHeight ?? 480;
            const format = wanted.backBufferFormat ?? D3DFMT.X8R8G8B8;
            const chain = createAdditionalChain({
                parameters: wanted,
                count: explicitCount(D3DPOOL.DEFAULT),
                // A back buffer's count is its own, as Direct3D 8's is: one
                // released to nothing is the chain's to hand out again (Wine's
                // d3d9 test_refcount).
                makeBackBuffer: ()=>createSurface({
                    type: SURFACE_TYPE.RENDER_TARGET,
                    width,
                    height,
                    format,
                    pool: D3DPOOL.DEFAULT,
                    usage: D3DUSAGE.RENDERTARGET,
                    lockable: wanted.lockableBackBuffer,
                    base: allocate(surfaceBytes(format, width, height)),
                    count: implicitCount(),
                    rejectsMalformedRects: true,
                    divergence: services.divergence ?? null,
                    pixels: targetPixels(),
                }),
                present: presentChain,
                retire: surface=>{
                    free(surface.base);
                    renderer?.retire(surface);
                },
            });
            const made = Object.assign(chain, {
                /** @param {any} destination */
                GetFrontBufferData: (/** @type {any} */ destination)=>
                    readFrontInto(destination, chain),
                /** @param {{ device?: any }} held */
                GetDevice(/** @type {{ device?: any }} */ held){
                    device.addRef();
                    held.device = device;
                    return D3D_OK;
                },
            });
            for (const surface of chain.backBuffers)
            {
                surface.container = made;
            }
            out.swapChain = made;
            return D3D_OK;
        },

        /**
         * A rectangle of one default-pool surface into a rectangle of another,
         * same format, same size: this device stretches nothing, and a
         * rectangle pair of different sizes is refused and reported rather
         * than copied at the wrong scale. Between two surfaces that live on
         * the GPU the copy is made there; otherwise guest bytes move, and a
         * source that lives on the GPU is reported, with the same report a
         * read-back gets.
         *
         * @param {any} source @param {Rect | null} sourceRect
         * @param {any} destination @param {Rect | null} destinationRect
         * @param {number} filter  D3DTEXTUREFILTERTYPE
         * @param {{ moves?: SurfaceMove[] }} [out]
         */
        StretchRect(source, sourceRect, destination, destinationRect, filter, out = {}){
            if (!source || !destination || filter > D3DTEXF_ANISOTROPIC)
            {
                report('stretch-arguments', `StretchRect refused: ${!source ? 'no source surface'
                    : !destination ? 'no destination surface' : `filter ${filter}`}`);
                return D3DERR_INVALIDCALL;
            }
            const from = describe(source);
            const to = describe(destination);
            // Every refusal says why: a program told INVALIDCALL here carries on without the
            // copy, and the picture it meant to show is simply not there.
            const refuse = (/** @type {string} */ key, /** @type {string} */ why)=>{
                report(`stretch-${key}`, `StretchRect from format ${from.Format} to ${
                    to.Format} refused: ${why}`);
                return D3DERR_INVALIDCALL;
            };
            if (from.Pool !== D3DPOOL.DEFAULT || to.Pool !== D3DPOOL.DEFAULT)
            {
                return refuse('pool', 'a surface outside the default pool');
            }
            const depth = FORMAT_INFO[from.Format].depth;
            if (depth !== FORMAT_INFO[to.Format].depth || (depth && from.Format !== to.Format))
            {
                return refuse('depth', 'a depth surface with a colour one, or two depth formats');
            }
            const rect = sourceRect ?? wholeOf(from);
            const target = destinationRect ?? wholeOf(to);
            if (!rectWithin(rect, from) || !rectWithin(target, to))
            {
                return refuse('rect', 'a rectangle outside its surface');
            }
            const stretched = rect.right - rect.left !== target.right - target.left
                || rect.bottom - rect.top !== target.bottom - target.top;
            // A stretch, or two formats the GPU stores apart, is drawn on the GPU: a program
            // that renders its interface small and stretches it over the screen is shown it
            // there, filtered as it asked.
            if (stretched || from.Format !== to.Format)
            {
                if ((!stretched && renderer?.copySurface?.(source, rect, destination,
                    { x: target.left, y: target.top }))
                    || renderer?.stretchSurface?.(source, rect, destination, target,
                        filter >= D3DTEXF_LINEAR))
                {
                    out.moves = [];
                    return D3D_OK;
                }
                // Recording for a device that draws elsewhere, there is no
                // renderer here to ask: the played one draws the stretch
                // whenever both sides are its GPU's and not one texture, and
                // the program is answered as it will be.
                if (services.renderedElsewhere === true && drawnOnGpu(source)
                    && drawnOnGpu(destination) && !oneTexture(source, destination))
                {
                    out.moves = [];
                    return D3D_OK;
                }
                if (stretched)
                {
                    return refuse('scale', 'rectangles of different sizes, which only the GPU'
                        + ' scales here, and one of these surfaces is not on it');
                }
            }
            // Between colour formats a device converts, as CheckDeviceFormatConversion says it
            // can: a scene drawn into an A8R8G8B8 target is copied onto the X8R8G8B8 back
            // buffer this way. On the GPU two formats stored alike copy as they are (the
            // destination's alpha, undefined in Direct3D, then holds the source's); in guest
            // bytes only formats that differ in whether they keep an alpha do.
            if (renderer?.copySurface?.(source, rect, destination,
                { x: target.left, y: target.top }))
            {
                out.moves = [];
                return D3D_OK;
            }
            if (from.Format !== to.Format && alphaTwin(from.Format) !== to.Format)
            {
                return refuse('convert', 'a conversion between these formats is not made here');
            }
            if (isGpuResident(source))
            {
                // Recording for a device that draws elsewhere, the copy
                // between two surfaces that live on the GPU is made there,
                // and their guest bytes hold no pixels: moving them was a
                // render target's worth of bytes copied on the program's
                // thread for nothing.
                if (services.renderedElsewhere === true && isGpuResident(destination))
                {
                    out.moves = [];
                    return D3D_OK;
                }
                report('readback', 'StretchRect copies a target\'s guest bytes, which the'
                    + ' rendered pixels are never read back into');
            }
            deliverMoves([rectMove(source, rect, destination, { x: target.left, y: target.top })],
                out);
            renderer?.markDirty?.(destination);
            return D3D_OK;
        },

        /**
         * One colour over a rectangle of a default-pool surface that is a
         * render target or an offscreen plain surface -- a texture level with
         * no target usage is refused, as is anything compressed or depth. The
         * bytes are written in guest memory; a target is also cleared on the
         * GPU, which is where its pixels live.
         *
         * @param {any} surface @param {Rect | null} rect @param {number} colour
         */
        ColorFill(surface, rect, colour){
            if (!surface)
            {
                return D3DERR_INVALIDCALL;
            }
            const desc = describe(surface);
            const info = FORMAT_INFO[desc.Format];
            const plain = surface.kind === SURFACE_TYPE.PLAIN;
            if (desc.Pool !== D3DPOOL.DEFAULT || !info || info.depth || isCompressed(desc.Format)
                || (!plain && (desc.Usage & D3DUSAGE.RENDERTARGET) === 0))
            {
                return D3DERR_INVALIDCALL;
            }
            const area = rect ?? wholeOf(desc);
            if (!rectWithin(area, desc))
            {
                return D3DERR_INVALIDCALL;
            }
            fillBytes(surface, area, colour >>> 0);
            if ((desc.Usage & D3DUSAGE.RENDERTARGET) !== 0 && renderer)
            {
                renderer.clear(targetModel(surface),
                    [{ x1: area.left, y1: area.top, x2: area.right, y2: area.bottom }],
                    D3DCLEAR.TARGET, colour >>> 0, 1, 0);
            }
            else
            {
                renderer?.markDirty?.(surface);
            }
            return D3D_OK;
        },

        // --- state blocks ---

        BeginStateBlock(){
            if (recording)
            {
                return D3DERR_INVALIDCALL;
            }
            recording = emptyRecord();
            return D3D_OK;
        },

        /**
         * @param {{ block?: any }} out
         *        Untouched when nothing was being recorded: a program tests
         *        the pointer it passed, and leaving it alone is what tells it.
         */
        EndStateBlock(out){
            if (!recording || !out)
            {
                return D3DERR_INVALIDCALL;
            }
            const record = recording;
            recording = null;
            out.block = makeStateBlock(record);
            return D3D_OK;
        },

        /**
         * @param {number} type  D3DSBT
         * @param {{ block?: any }} out
         */
        CreateStateBlock(type, out){
            if (recording || !out || type < D3DSBT.ALL || type > D3DSBT.VERTEXSTATE)
            {
                return D3DERR_INVALIDCALL;
            }
            const record = emptyRecord();
            fillRecord(record, type, view);
            out.block = makeStateBlock(record);
            return D3D_OK;
        },

        // --- queries ---

        /**
         * Two kinds are offered. An event query asks whether the GPU has
         * caught up, and it has, as far as the program can tell, the moment it
         * asks. An occlusion query asks how many pixels a set of draws
         * produced, which this device cannot count: it answers with every
         * pixel of the target, the one number that never culls what should be
         * drawn, and says so once. Every other kind is the timing family, and
         * is not offered.
         *
         * A null out-pointer is the documented way to ask whether a kind is
         * offered at all.
         *
         * @param {number} type  D3DQUERYTYPE
         * @param {{ query?: any } | null} out
         */
        CreateQuery(type, out){
            if (type !== D3DQUERYTYPE.EVENT && type !== D3DQUERYTYPE.OCCLUSION)
            {
                return D3DERR_NOTAVAILABLE;
            }
            if (!out)
            {
                return D3D_OK;
            }
            out.query = createQuery(type);
            return D3D_OK;
        },

        /**
         * One pass when the combiner draws the cascade, which it draws in one
         * shader; the refusal naming what it cannot draw otherwise. A pixel
         * shader replaces the cascade.
         *
         * @param {{ passes?: number }} out  Written only on success.
         */
        ValidateDevice(out){
            const hr = pixelShader ? D3D_OK
                : validateStages(stageStatesFor, STAGE_COUNT, { temp: true, constant: true });
            if (hr === D3D_OK)
            {
                out.passes = 1;
            }
            return hr;
        },
    };

    /** @param {number} format */
    const reportRefusedFormat = format=>{
        const name = Object.entries(D3DFMT).find(entry=>entry[1] === format);
        report(`format:${format}`,
            `a texture in format ${name ? name[0] : format} was refused: this device`
            + ' does not offer it, and a program with no other copy of the art will'
            + ' either convert it itself or go without');
    };

    /**
     * @param {string} kind
     * @param {{ major: number, minor: number }} supported
     * @param {Uint32Array | ArrayLike<number> | null} tokens
     * @param {{ shader?: any }} out
     */
    const createShaderObject = (kind, supported, tokens, out)=>{
        if (!tokens || !out)
        {
            return D3DERR_INVALIDCALL;
        }
        const hr = validateShader(tokens, kind, supported);
        if (hr !== D3D_OK)
        {
            const version = versionOf(tokens[0]);
            report(`create:${kind}:${version ? `${version.major}.${version.minor}` : 'bad'}`,
                version && version.kind === kind
                    ? `a ${kind} shader of version ${version.major}.${version.minor} was refused:`
                        + ` this device advertises ${supported.major}.${supported.minor}`
                    : `a ${kind} shader was refused: its bytecode could not be read`);
            return hr;
        }
        out.shader = createShader({ kind, tokens, count: explicitCount() });
        return D3D_OK;
    };

    /**
     * @param {import('./shader.js').ConstantFile} file
     * @param {'floats' | 'ints' | 'bools'} which
     * @param {number} start @param {ArrayLike<number>} values @param {number} n
     * @param {(record: import('./stateblock.js').StateBlockRecord) => Map<number, any>} pick
     */
    const setConstants = (file, which, start, values, n, pick)=>{
        const width = which === 'bools' ? 1 : 4;
        const limit = file[which].length / width;
        if (!values || start < 0 || n < 0 || start + n > limit)
        {
            return D3DERR_INVALIDCALL;
        }
        if (!recording)
        {
            return which === 'floats'
                ? file.setF(start, values, n)
                : which === 'ints' ? file.setI(start, values, n) : file.setB(start, values, n);
        }
        const map = pick(recording);
        for (let register = 0; register < n; register++)
        {
            const at = register * width;
            if (which === 'floats')
            {
                map.set(start + register, Float32Array.from(
                    { length: 4 }, (_, i)=>values[at + i]));
            }
            else if (which === 'ints')
            {
                map.set(start + register, Int32Array.from({ length: 4 }, (_, i)=>values[at + i]));
            }
            else
            {
                map.set(start + register, values[at] ? 1 : 0);
            }
        }
        return D3D_OK;
    };

    /** @param {import('./stateblock.js').StateBlockRecord} record */
    const makeStateBlock = record=>createStateBlock({
        record,
        count: explicitCount(),
        // Neither is legal while another block is recording.
        capture: ()=>{
            if (recording)
            {
                return D3DERR_INVALIDCALL;
            }
            captureRecord(record, view);
            return D3D_OK;
        },
        apply: ()=>{
            if (recording)
            {
                return D3DERR_INVALIDCALL;
            }
            applyRecord(record, view);
            drawStateVersion++;
            return D3D_OK;
        },
    });

    /** @param {number} type */
    const createQuery = type=>{
        const queryCount = explicitCount();
        const occlusion = type === D3DQUERYTYPE.OCCLUSION;
        // An occlusion query counts what the GPU drew between its BEGIN and
        // its END; a device that draws nothing counts nothing.
        const counted = occlusion && renderer?.createOcclusionQuery
            ? renderer.createOcclusionQuery()
            : null;
        // A query is signalled as created: its data is available, if empty,
        // until a BEGIN opens it, and again once END closes it. A program
        // that waits for the GPU by polling an event query it never issued
        // spins for ever on a query that answers "not yet" from the start.
        let building = false;
        /** Whether an END has closed a count this device kept without a GPU. */
        let ended = false;
        return {
            type,
            get refCount(){
                return queryCount.value;
            },
            addRef: ()=>queryCount.addRef(),
            release: ()=>queryCount.release(),
            GetType: ()=>type,
            /** Four bytes: a BOOL, or a pixel count. */
            GetDataSize: ()=>4,
            /**
             * An event query has no beginning and only its end may be issued;
             * an occlusion query has both, and its answer is complete at the
             * end.
             *
             * @param {number} flags  D3DISSUE
             */
            Issue(flags){
                if ((flags & D3DISSUE.BEGIN) !== 0)
                {
                    if (!occlusion)
                    {
                        return D3DERR_INVALIDCALL;
                    }
                    building = true;
                    if (counted)
                    {
                        renderer.beginOcclusion(counted);
                    }
                    return D3D_OK;
                }
                building = false;
                ended = true;
                if (counted)
                {
                    renderer.endOcclusion(counted);
                }
                return D3D_OK;
            },
            /**
             * The answer: for an event that the work is done, for an
             * occlusion query the samples its draws passed, once they are
             * back from the GPU -- S_FALSE until then, and while BEGIN has
             * no END yet. D3DGETDATA_FLUSH sends the draws to the GPU and has
             * the caller wait for the count (Wine's d3d9 test_occlusion_query,
             * whose loop polls with it). An event's buffer too small for its
             * BOOL is refused; an occlusion count is written in as many of
             * its bytes as there is room for, and a query never ended writes
             * nothing.
             *
             * @param {{ value?: number } | null} out
             * @param {number} size  Bytes the caller has room for; zero asks nothing.
             * @param {number} [flags]  D3DGETDATA_FLUSH or nothing.
             * @returns {number | Promise<number>}
             */
            GetData(out, size, flags = 0){
                if (!occlusion && size !== 0 && size < 4)
                {
                    return D3DERR_INVALIDCALL;
                }
                if (building)
                {
                    return S_FALSE;
                }
                /** @param {number} value */
                const answer = value=>{
                    if (out && size > 0)
                    {
                        out.value = value;
                    }
                    return D3D_OK;
                };
                if (!occlusion)
                {
                    return answer(1);
                }
                if (!counted)
                {
                    return ended ? answer(0) : D3D_OK;
                }
                const result = renderer.occlusionResult(counted,
                    (flags & D3DGETDATA_FLUSH) !== 0);
                switch (result.state)
                {
                    case 'done':
                        return answer(result.value);
                    case 'pending':
                        return (flags & D3DGETDATA_FLUSH) !== 0
                            ? result.settled.then(answer)
                            : S_FALSE;
                    case 'building':
                        return S_FALSE;
                    default:
                        return D3D_OK;
                }
            },
        };
    };

    /**
     * The model with another surface as its target and no depth, for a fill:
     * the renderer clears what the model names.
     *
     * @param {any} surface
     */
    const targetModel = surface=>{
        const desc = describe(surface);
        return Object.create(model, {
            renderTarget: { get: ()=>surface },
            depthStencil: { get: ()=>null },
            viewport: { get: ()=>fullTarget({ width: desc.Width, height: desc.Height }) },
        });
    };

    // A GPU that is gone takes the device with it, beyond a reset.
    stopWatchingLoss = services.onDeviceLost?.(()=>device.injectDeviceLoss(false));
    return device;
}

/**
 * Whether a texture asking for D3DUSAGE_AUTOGENMIPMAP may have it (Wine's
 * d3d9 test_mipmap_gen): not in system memory, and with one level or the
 * whole chain asked for -- the program sees one level either way.
 *
 * @param {number} usage @param {number} levels @param {number} pool
 */
function autoGenAllowed(usage, levels, pool){
    return (usage & D3DUSAGE.AUTOGENMIPMAP) === 0 || (pool !== D3DPOOL.SYSTEMMEM && levels <= 1);
}

/**
 * The levels a texture shows the program and the levels its GPU copy has.
 * An automatically mipmapped texture shows its top level alone and the
 * device makes the rest -- except in a format no level is drawn into, a
 * block-compressed or depth one, which D3DOK_NOAUTOGEN says gets none.
 *
 * @param {number} usage @param {number} format @param {number} levels
 * @param {number} full  The whole chain's length.
 * @returns {{ levels: number, gpuLevels: number }}
 */
function chainOf(usage, format, levels, full){
    if ((usage & D3DUSAGE.AUTOGENMIPMAP) === 0)
    {
        const chain = levels || full;
        return { levels: chain, gpuLevels: chain };
    }
    return { levels: 1, gpuLevels: generatesMips(format) ? full : 1 };
}

/** @param {number} format */
function generatesMips(format){
    return !isCompressed(format) && !FORMAT_INFO[format]?.depth && !FORMAT_INFO[format]?.signed;
}

/**
 * How many mip levels a texture of this size has when a program asks for all
 * of them by passing zero: down to a single texel.
 *
 * @param {number} width @param {number} height
 */
function fullMipCount(width, height){
    let levels = 1;
    let extent = Math.max(width, height);
    while (extent > 1)
    {
        extent >>>= 1;
        levels++;
    }
    return levels;
}

/**
 * The depth range's words as the program gave them. A float taken through a
 * number loses a signalling NaN's bits, and GetViewport answers the words the
 * program set, as the block the guest reads from holds them.
 *
 * @param {{ MinZ?: number, MaxZ?: number, MinZWord?: number, MaxZWord?: number }} value
 * @returns {[number, number]}
 */
export function depthWordsOf(value){
    const words = new Uint32Array(new Float32Array([value.MinZ ?? 0, value.MaxZ ?? 1]).buffer);
    return [(value.MinZWord ?? words[0]) >>> 0, (value.MaxZWord ?? words[1]) >>> 0];
}

/**
 * GetViewport's answer: the viewport, and the depth range's words beside it
 * for whoever writes it out to the program.
 *
 * @param {import('../webgpu/contract.js').ViewportState} state
 * @param {{ viewport?: any, depthWords?: [number, number] }} out
 */
export function answerViewport(state, out){
    const rect = state.rect;
    out.viewport = { X: rect.x, Y: rect.y, Width: rect.width, Height: rect.height,
        MinZ: rect.minDepth, MaxZ: rect.maxDepth };
    out.depthWords = state.depthWords
        ?? depthWordsOf({ MinZ: rect.minDepth, MaxZ: rect.maxDepth });
}

/**
 * A binding's move from one resource to another: the device holds what it
 * binds, so a resource the program released to nothing while bound lives on
 * until it is unbound, as Windows keeps it (Wine's d3d9ex test_reset_ex).
 *
 * @param {any} previous @param {any} next
 * @returns {any} next
 */
export function rebound(previous, next){
    if (previous !== next)
    {
        next?.hold?.();
        previous?.letGo?.();
    }
    return next;
}

/**
 * The device's streams, whose records carry the binding's hold with them:
 * a record set over another moves it, and clearing them lets every one go.
 *
 * @extends {Map<number, { buffer: any, offset: number, stride: number }>}
 */
class BindingMap extends Map {
    /** @param {number} index @param {{ buffer: any, offset: number, stride: number }} record */
    set(index, record){
        rebound(this.get(index)?.buffer ?? null, record?.buffer ?? null);
        return super.set(index, record);
    }

    /** @param {number} index */
    delete(index){
        this.get(index)?.buffer?.letGo?.();
        return super.delete(index);
    }

    clear(){
        for (const record of this.values())
        {
            record.buffer?.letGo?.();
        }
        super.clear();
    }
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
    if (info.video)
    {
        return usage === 0 && videoPoolAllowed(pool, false) ? D3D_OK : D3DERR_INVALIDCALL;
    }
    // A write-only texture is a contradiction the API rejects outright.
    if ((usage & D3DUSAGE.WRITEONLY) !== 0)
    {
        return D3DERR_INVALIDCALL;
    }
    // Legal regardless of `caps.compressedTextures` -- that flag only chooses
    // how the surface's bytes travel to the GPU (blocks or a decode) -- and
    // never as something the pipeline draws into: the blocks are not writable
    // by it.
    if ((isCompressed(format) || info.signed)
        && (usage & (D3DUSAGE.RENDERTARGET | D3DUSAGE.DEPTHSTENCIL)) !== 0)
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
