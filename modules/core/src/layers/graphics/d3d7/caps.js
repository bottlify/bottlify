/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What this build says it can do, as the three devices a program enumerates.
 *
 * A capability bit is a promise about what draws correctly, and every bit
 * claimed is a path a program may take: a claim the renderer cannot honour
 * sends the program down a fast path to a wrong picture, where the absence
 * of the claim would have sent it down a slow path to a right one. So the
 * lists below are what the shader generator and pipeline actually implement
 * today -- the cull modes, the depth compares, the blend factors, the stage
 * operations, the filters and address modes, range fog, eight lights -- and
 * grow as the renderer grows, not ahead of it. No stencil, no bump mapping,
 * no cube maps, no W-buffer, because none of those draws yet.
 *
 * Three devices are offered, in the order DirectX 7 offers them with a
 * transform-and-lighting card present: RGB emulation, HAL, and T&L HAL. All
 * three are the same renderer; their descriptions differ in what they claim
 * about where the work happens, which is what a program branches on.
 */

import {
    D3DDEVCAPS_CANRENDERAFTERFLIP, D3DDEVCAPS_DRAWPRIMITIVES2, D3DDEVCAPS_DRAWPRIMITIVES2EX,
    D3DDEVCAPS_DRAWPRIMTLVERTEX, D3DDEVCAPS_EXECUTESYSTEMMEMORY, D3DDEVCAPS_EXECUTEVIDEOMEMORY,
    D3DDEVCAPS_FLOATTLVERTEX, D3DDEVCAPS_HWRASTERIZATION, D3DDEVCAPS_HWTRANSFORMANDLIGHT,
    D3DDEVCAPS_TEXTURESYSTEMMEMORY, D3DDEVCAPS_TEXTUREVIDEOMEMORY, D3DDEVCAPS_TLVERTEXSYSTEMMEMORY,
    D3DDEVCAPS_TLVERTEXVIDEOMEMORY, D3DPBLENDCAPS_ALL_BUT_BOTH, D3DPCMPCAPS_ALL,
    D3DPMISCCAPS_CULLCCW, D3DPMISCCAPS_CULLCW, D3DPMISCCAPS_CULLNONE, D3DPRASTERCAPS_FOGRANGE,
    D3DPRASTERCAPS_ZTEST, D3DPSHADECAPS_ALPHAGOURAUDBLEND, D3DPSHADECAPS_COLORGOURAUDRGB,
    D3DPTADDRESSCAPS_CLAMP, D3DPTADDRESSCAPS_INDEPENDENTUV, D3DPTADDRESSCAPS_MIRROR,
    D3DPTADDRESSCAPS_WRAP, D3DPTBLENDCAPS_ADD, D3DPTBLENDCAPS_COPY, D3DPTBLENDCAPS_DECAL,
    D3DPTBLENDCAPS_DECALALPHA, D3DPTBLENDCAPS_MODULATE, D3DPTBLENDCAPS_MODULATEALPHA,
    D3DPTEXTURECAPS_ALPHA, D3DPTEXTURECAPS_PERSPECTIVE, D3DPTFILTERCAPS_LINEAR,
    D3DPTFILTERCAPS_MAGFLINEAR, D3DPTFILTERCAPS_MAGFPOINT, D3DPTFILTERCAPS_MINFLINEAR,
    D3DPTFILTERCAPS_MINFPOINT, D3DPTFILTERCAPS_MIPFLINEAR, D3DPTFILTERCAPS_MIPFPOINT,
    D3DPTFILTERCAPS_NEAREST, D3DTOP, DDBD_16, DDBD_32, DEVICE_IDS, textureOpCaps,
} from './constants.js';

/** The stage operations the shader generator implements. */
const OPERATIONS = Object.freeze([
    D3DTOP.DISABLE, D3DTOP.SELECTARG1, D3DTOP.SELECTARG2, D3DTOP.MODULATE, D3DTOP.MODULATE2X,
    D3DTOP.MODULATE4X, D3DTOP.ADD, D3DTOP.ADDSIGNED, D3DTOP.SUBTRACT,
]);

/**
 * @typedef {Object} PrimitiveCaps
 * @property {number} miscCaps
 * @property {number} rasterCaps
 * @property {number} zCmpCaps
 * @property {number} srcBlendCaps
 * @property {number} destBlendCaps
 * @property {number} alphaCmpCaps
 * @property {number} shadeCaps
 * @property {number} textureCaps
 * @property {number} textureFilterCaps
 * @property {number} textureBlendCaps
 * @property {number} textureAddressCaps
 * @property {number} stippleWidth
 * @property {number} stippleHeight
 */

/**
 * @typedef {Object} DeviceCaps
 *     D3DDEVICEDESC7, field for field, in the names the seam writes it out by.
 * @property {number} devCaps
 * @property {PrimitiveCaps} lineCaps
 * @property {PrimitiveCaps} triCaps
 * @property {number} deviceRenderBitDepth
 * @property {number} deviceZBufferBitDepth
 * @property {number} minTextureWidth
 * @property {number} minTextureHeight
 * @property {number} maxTextureWidth
 * @property {number} maxTextureHeight
 * @property {number} maxTextureRepeat
 * @property {number} maxTextureAspectRatio
 * @property {number} maxAnisotropy
 * @property {number} guardBandLeft
 * @property {number} guardBandTop
 * @property {number} guardBandRight
 * @property {number} guardBandBottom
 * @property {number} extentsAdjust
 * @property {number} stencilCaps
 * @property {number} fvfCaps
 * @property {number} textureOpCaps
 * @property {number} maxTextureBlendStages
 * @property {number} maxSimultaneousTextures
 * @property {number} maxActiveLights
 * @property {number} maxVertexW
 * @property {string} deviceGuid
 * @property {number} maxUserClipPlanes
 * @property {number} maxVertexBlendMatrices
 * @property {number} vertexProcessingCaps
 */

/** @returns {PrimitiveCaps} what one primitive kind can be drawn with */
function primitiveCaps(){
    return {
        miscCaps: D3DPMISCCAPS_CULLNONE | D3DPMISCCAPS_CULLCW | D3DPMISCCAPS_CULLCCW,
        rasterCaps: D3DPRASTERCAPS_ZTEST | D3DPRASTERCAPS_FOGRANGE,
        zCmpCaps: D3DPCMPCAPS_ALL,
        srcBlendCaps: D3DPBLENDCAPS_ALL_BUT_BOTH,
        destBlendCaps: D3DPBLENDCAPS_ALL_BUT_BOTH,
        alphaCmpCaps: D3DPCMPCAPS_ALL,
        shadeCaps: D3DPSHADECAPS_COLORGOURAUDRGB | D3DPSHADECAPS_ALPHAGOURAUDBLEND,
        textureCaps: D3DPTEXTURECAPS_PERSPECTIVE | D3DPTEXTURECAPS_ALPHA,
        textureFilterCaps: D3DPTFILTERCAPS_NEAREST | D3DPTFILTERCAPS_LINEAR
            | D3DPTFILTERCAPS_MINFPOINT | D3DPTFILTERCAPS_MINFLINEAR
            | D3DPTFILTERCAPS_MIPFPOINT | D3DPTFILTERCAPS_MIPFLINEAR
            | D3DPTFILTERCAPS_MAGFPOINT | D3DPTFILTERCAPS_MAGFLINEAR,
        textureBlendCaps: D3DPTBLENDCAPS_DECAL | D3DPTBLENDCAPS_MODULATE
            | D3DPTBLENDCAPS_DECALALPHA | D3DPTBLENDCAPS_MODULATEALPHA | D3DPTBLENDCAPS_COPY
            | D3DPTBLENDCAPS_ADD,
        textureAddressCaps: D3DPTADDRESSCAPS_WRAP | D3DPTADDRESSCAPS_MIRROR
            | D3DPTADDRESSCAPS_CLAMP | D3DPTADDRESSCAPS_INDEPENDENTUV,
        stippleWidth: 0,
        stippleHeight: 0,
    };
}

/**
 * The capabilities every device shares: what the one renderer draws. What
 * differs between the three is only where the work is said to happen.
 */
const SHARED_DEVCAPS = D3DDEVCAPS_FLOATTLVERTEX | D3DDEVCAPS_EXECUTESYSTEMMEMORY
    | D3DDEVCAPS_EXECUTEVIDEOMEMORY | D3DDEVCAPS_TLVERTEXSYSTEMMEMORY
    | D3DDEVCAPS_TLVERTEXVIDEOMEMORY | D3DDEVCAPS_TEXTURESYSTEMMEMORY
    | D3DDEVCAPS_TEXTUREVIDEOMEMORY | D3DDEVCAPS_DRAWPRIMTLVERTEX | D3DDEVCAPS_CANRENDERAFTERFLIP
    | D3DDEVCAPS_DRAWPRIMITIVES2 | D3DDEVCAPS_DRAWPRIMITIVES2EX;

/**
 * @param {string} deviceGuid
 * @param {number} devCaps
 * @returns {DeviceCaps}
 */
function description(deviceGuid, devCaps){
    return {
        devCaps,
        lineCaps: primitiveCaps(),
        triCaps: primitiveCaps(),
        deviceRenderBitDepth: DDBD_16 | DDBD_32,
        deviceZBufferBitDepth: DDBD_16 | DDBD_32,
        minTextureWidth: 1,
        minTextureHeight: 1,
        maxTextureWidth: 2048,
        maxTextureHeight: 2048,
        maxTextureRepeat: 8192,
        maxTextureAspectRatio: 0,
        maxAnisotropy: 1,
        guardBandLeft: 0,
        guardBandTop: 0,
        guardBandRight: 0,
        guardBandBottom: 0,
        extentsAdjust: 0,
        stencilCaps: 0,
        fvfCaps: 8,
        textureOpCaps: textureOpCaps(OPERATIONS),
        maxTextureBlendStages: 8,
        maxSimultaneousTextures: 8,
        maxActiveLights: 8,
        maxVertexW: 1e10,
        deviceGuid,
        maxUserClipPlanes: 0,
        maxVertexBlendMatrices: 0,
        vertexProcessingCaps: 0,
    };
}

/**
 * @typedef {Object} DeviceDescription
 * @property {string} id            The identifier a program asks CreateDevice for.
 * @property {string} name          What EnumDevices shows as the device name.
 * @property {string} text          And as its description.
 * @property {DeviceCaps} caps
 */

/** @type {readonly DeviceDescription[]} */
export const DEVICE_DESCRIPTIONS = Object.freeze([
    {
        id: DEVICE_IDS.RGB,
        name: 'RGB Emulation',
        text: 'Microsoft Direct3D RGB Software Emulation',
        caps: description(DEVICE_IDS.RGB, SHARED_DEVCAPS),
    },
    {
        id: DEVICE_IDS.HAL,
        name: 'Direct3D HAL',
        text: 'Microsoft Direct3D Hardware acceleration through Direct3D HAL',
        caps: description(DEVICE_IDS.HAL, SHARED_DEVCAPS | D3DDEVCAPS_HWRASTERIZATION),
    },
    {
        id: DEVICE_IDS.TNLHAL,
        name: 'Direct3D T&L HAL',
        text: 'Microsoft Direct3D Hardware Transform and Lighting acceleration capable device',
        caps: description(DEVICE_IDS.TNLHAL,
            SHARED_DEVCAPS | D3DDEVCAPS_HWRASTERIZATION | D3DDEVCAPS_HWTRANSFORMANDLIGHT),
    },
]);
