/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a Direct3D 9 device says it can do.
 *
 * Every number here is a claim a program acts on, in one of two ways. A
 * capability claimed and not honoured sends a program down a path where its
 * picture comes out wrong with nothing to say why -- a clip plane that does
 * not clip, a scissor that does not cut, a stencil that ignores its back
 * face. A capability not claimed sends it down the other path it has, which
 * is the one it tests on the cards that lack the feature. So the rule is
 * that a bit is set here only when the renderer behind this device does what
 * the bit promises, and the zeroes are as deliberate as the ones.
 *
 * The bits are named from the header rather than written as blobs, because a
 * blob is unreviewable: nobody can tell a claim that can be honoured from one
 * that cannot.
 */

import { TEXTURE_OP_CAPS } from '../d3d8/validity.js';

const D3DCAPS_READ_SCANLINE = 0x00020000;
const D3DCAPS2_DYNAMICTEXTURES = 0x20000000;

const D3DPRESENT_INTERVAL_ONE = 0x00000001;
const D3DPRESENT_INTERVAL_IMMEDIATE = 0x80000000;

const D3DCURSORCAPS_COLOR = 0x00000001;
const D3DCURSORCAPS_LOWRES = 0x00000002;

const D3DDEVCAPS_EXECUTESYSTEMMEMORY = 0x00000010;
const D3DDEVCAPS_EXECUTEVIDEOMEMORY = 0x00000020;
const D3DDEVCAPS_TLVERTEXSYSTEMMEMORY = 0x00000040;
const D3DDEVCAPS_TLVERTEXVIDEOMEMORY = 0x00000080;
const D3DDEVCAPS_TEXTURESYSTEMMEMORY = 0x00000100;
const D3DDEVCAPS_TEXTUREVIDEOMEMORY = 0x00000200;
const D3DDEVCAPS_DRAWPRIMTLVERTEX = 0x00000400;
const D3DDEVCAPS_CANRENDERAFTERFLIP = 0x00000800;
const D3DDEVCAPS_TEXTURENONLOCALVIDMEM = 0x00001000;
const D3DDEVCAPS_DRAWPRIMITIVES2 = 0x00002000;
const D3DDEVCAPS_DRAWPRIMITIVES2EX = 0x00008000;
const D3DDEVCAPS_HWTRANSFORMANDLIGHT = 0x00010000;
const D3DDEVCAPS_CANBLTSYSTONONLOCAL = 0x00020000;
const D3DDEVCAPS_HWRASTERIZATION = 0x00080000;
const D3DDEVCAPS_PUREDEVICE = 0x00100000;

const D3DPMISCCAPS_MASKZ = 0x00000002;
const D3DPMISCCAPS_CULLNONE = 0x00000010;
const D3DPMISCCAPS_CULLCW = 0x00000020;
const D3DPMISCCAPS_CULLCCW = 0x00000040;
const D3DPMISCCAPS_COLORWRITEENABLE = 0x00000080;
const D3DPMISCCAPS_BLENDOP = 0x00000800;

const D3DPRASTERCAPS_DITHER = 0x00000001;
const D3DPRASTERCAPS_ZTEST = 0x00000010;
const D3DPRASTERCAPS_FOGVERTEX = 0x00000080;
const D3DPRASTERCAPS_FOGTABLE = 0x00000100;
const D3DPRASTERCAPS_FOGRANGE = 0x00010000;
const D3DPRASTERCAPS_WFOG = 0x00100000;
const D3DPRASTERCAPS_ZFOG = 0x00200000;
const D3DPRASTERCAPS_SCISSORTEST = 0x01000000;

/** NEVER, LESS, EQUAL, LESSEQUAL, GREATER, NOTEQUAL, GREATEREQUAL, ALWAYS. */
const ALL_COMPARE_CAPS = 0x000000ff;

/** Every blend factor up to and including BOTHINVSRCALPHA; not the constant factor. */
const BLEND_CAPS = 0x00001fff;

const D3DPSHADECAPS_COLORGOURAUDRGB = 0x00000008;
const D3DPSHADECAPS_SPECULARGOURAUDRGB = 0x00000200;
const D3DPSHADECAPS_ALPHAGOURAUDBLEND = 0x00004000;
const D3DPSHADECAPS_FOGGOURAUD = 0x00080000;

const D3DPTEXTURECAPS_PERSPECTIVE = 0x00000001;
const D3DPTEXTURECAPS_ALPHA = 0x00000004;
const D3DPTEXTURECAPS_MIPMAP = 0x00004000;

const D3DPTFILTERCAPS_MINFPOINT = 0x00000100;
const D3DPTFILTERCAPS_MINFLINEAR = 0x00000200;
const D3DPTFILTERCAPS_MIPFPOINT = 0x00010000;
const D3DPTFILTERCAPS_MIPFLINEAR = 0x00020000;
const D3DPTFILTERCAPS_MAGFPOINT = 0x01000000;
const D3DPTFILTERCAPS_MAGFLINEAR = 0x02000000;

const D3DPTADDRESSCAPS_WRAP = 0x00000001;
const D3DPTADDRESSCAPS_MIRROR = 0x00000002;
const D3DPTADDRESSCAPS_CLAMP = 0x00000004;
const D3DPTADDRESSCAPS_INDEPENDENTUV = 0x00000010;

const D3DLINECAPS_TEXTURE = 0x00000001;
const D3DLINECAPS_ZTEST = 0x00000002;
const D3DLINECAPS_BLEND = 0x00000004;
const D3DLINECAPS_ALPHACMP = 0x00000008;
const D3DLINECAPS_FOG = 0x00000010;

const D3DFVFCAPS_PSIZE = 0x00100000;

const D3DVTXPCAPS_TEXGEN = 0x00000001;
const D3DVTXPCAPS_MATERIALSOURCE7 = 0x00000002;
const D3DVTXPCAPS_DIRECTIONALLIGHTS = 0x00000008;
const D3DVTXPCAPS_POSITIONALLIGHTS = 0x00000010;
const D3DVTXPCAPS_LOCALVIEWER = 0x00000020;

/** The high words of a shader version, which the two macros put there. */
const D3DVS_VERSION_MARK = 0xfffe0000;
const D3DPS_VERSION_MARK = 0xffff0000;

/**
 * @param {number} mark @param {{ major: number, minor: number }} version
 * @returns {number} D3DVS_VERSION or D3DPS_VERSION, as the header's macro spells it
 */
const shaderVersion = (mark, version)=>(mark | (version.major << 8) | version.minor) >>> 0;

/**
 * The value of every field of D3DCAPS9, from what the device knows of
 * itself. Names are the header's, so a reader can check each against it.
 *
 * @param {import('./device.js').DeviceCaps} caps
 * @param {{ deviceType?: number, adapterOrdinal?: number }} [identity]
 * @returns {Record<string, number>}
 */
export function capabilityWords(caps, identity = {}){
    const vs = caps.vertexShaderVersion;
    const ps = caps.pixelShaderVersion;
    const runsVertexShaders = vs.major >= 1;
    const runsPixelShaders = ps.major >= 1;
    return {
        DeviceType: identity.deviceType ?? 1,
        AdapterOrdinal: identity.adapterOrdinal ?? 0,
        // The raster the clock gives can be read; there is no overlay.
        Caps: D3DCAPS_READ_SCANLINE,
        // Textures may be made dynamic, and are uploaded when they change.
        // Gamma is kept and not applied, so it is not claimed.
        Caps2: D3DCAPS2_DYNAMICTEXTURES,
        // No copy between video and system memory through StretchRect.
        Caps3: 0,
        PresentationIntervals: D3DPRESENT_INTERVAL_IMMEDIATE | D3DPRESENT_INTERVAL_ONE,
        CursorCaps: D3DCURSORCAPS_COLOR | D3DCURSORCAPS_LOWRES,
        DevCaps: D3DDEVCAPS_EXECUTESYSTEMMEMORY | D3DDEVCAPS_EXECUTEVIDEOMEMORY
            | D3DDEVCAPS_TLVERTEXSYSTEMMEMORY | D3DDEVCAPS_TLVERTEXVIDEOMEMORY
            | D3DDEVCAPS_TEXTURESYSTEMMEMORY | D3DDEVCAPS_TEXTUREVIDEOMEMORY
            | D3DDEVCAPS_DRAWPRIMTLVERTEX | D3DDEVCAPS_CANRENDERAFTERFLIP
            | D3DDEVCAPS_TEXTURENONLOCALVIDMEM | D3DDEVCAPS_DRAWPRIMITIVES2
            | D3DDEVCAPS_DRAWPRIMITIVES2EX | D3DDEVCAPS_HWTRANSFORMANDLIGHT
            | D3DDEVCAPS_CANBLTSYSTONONLOCAL | D3DDEVCAPS_HWRASTERIZATION
            | D3DDEVCAPS_PUREDEVICE,
        PrimitiveMiscCaps: D3DPMISCCAPS_MASKZ | D3DPMISCCAPS_CULLNONE | D3DPMISCCAPS_CULLCW
            | D3DPMISCCAPS_CULLCCW | D3DPMISCCAPS_COLORWRITEENABLE | D3DPMISCCAPS_BLENDOP,
        // No depth bias, no anisotropy, no level bias: the renderer reads none
        // of those states.
        RasterCaps: D3DPRASTERCAPS_DITHER | D3DPRASTERCAPS_ZTEST | D3DPRASTERCAPS_FOGVERTEX
            | D3DPRASTERCAPS_FOGTABLE | D3DPRASTERCAPS_FOGRANGE | D3DPRASTERCAPS_WFOG
            | D3DPRASTERCAPS_ZFOG | D3DPRASTERCAPS_SCISSORTEST,
        ZCmpCaps: ALL_COMPARE_CAPS,
        SrcBlendCaps: BLEND_CAPS,
        DestBlendCaps: BLEND_CAPS,
        AlphaCmpCaps: ALL_COMPARE_CAPS,
        ShadeCaps: D3DPSHADECAPS_COLORGOURAUDRGB | D3DPSHADECAPS_SPECULARGOURAUDRGB
            | D3DPSHADECAPS_ALPHAGOURAUDBLEND | D3DPSHADECAPS_FOGGOURAUD,
        // No cube maps and no volumes: the renderer samples neither.
        TextureCaps: D3DPTEXTURECAPS_PERSPECTIVE | D3DPTEXTURECAPS_ALPHA | D3DPTEXTURECAPS_MIPMAP,
        TextureFilterCaps: D3DPTFILTERCAPS_MINFPOINT | D3DPTFILTERCAPS_MINFLINEAR
            | D3DPTFILTERCAPS_MIPFPOINT | D3DPTFILTERCAPS_MIPFLINEAR
            | D3DPTFILTERCAPS_MAGFPOINT | D3DPTFILTERCAPS_MAGFLINEAR,
        CubeTextureFilterCaps: 0,
        VolumeTextureFilterCaps: 0,
        // Border and mirror-once are folded into clamp and mirror by the
        // sampler, so neither is promised.
        TextureAddressCaps: D3DPTADDRESSCAPS_WRAP | D3DPTADDRESSCAPS_MIRROR
            | D3DPTADDRESSCAPS_CLAMP | D3DPTADDRESSCAPS_INDEPENDENTUV,
        VolumeTextureAddressCaps: 0,
        LineCaps: D3DLINECAPS_TEXTURE | D3DLINECAPS_ZTEST | D3DLINECAPS_BLEND
            | D3DLINECAPS_ALPHACMP | D3DLINECAPS_FOG,
        MaxTextureWidth: caps.maxTextureWidth,
        MaxTextureHeight: caps.maxTextureHeight,
        MaxVolumeExtent: 0,
        MaxTextureRepeat: 8192,
        MaxTextureAspectRatio: caps.maxTextureWidth,
        MaxAnisotropy: 1,
        MaxVertexW: caps.maxVertexW,
        GuardBandLeft: -1e9,
        GuardBandTop: -1e9,
        GuardBandRight: 1e9,
        GuardBandBottom: 1e9,
        ExtentsAdjust: 0,
        // The pipeline has no stencil test, so no stencil operation is promised.
        StencilCaps: 0,
        FVFCaps: D3DFVFCAPS_PSIZE | 8,
        TextureOpCaps: TEXTURE_OP_CAPS,
        MaxTextureBlendStages: caps.maxTextureBlendStages,
        MaxSimultaneousTextures: caps.maxSimultaneousTextures,
        VertexProcessingCaps: D3DVTXPCAPS_TEXGEN | D3DVTXPCAPS_MATERIALSOURCE7
            | D3DVTXPCAPS_DIRECTIONALLIGHTS | D3DVTXPCAPS_POSITIONALLIGHTS
            | D3DVTXPCAPS_LOCALVIEWER,
        MaxActiveLights: caps.maxActiveLights,
        MaxUserClipPlanes: caps.maxUserClipPlanes,
        MaxVertexBlendMatrices: caps.maxVertexBlendMatrices,
        MaxVertexBlendMatrixIndex: 0,
        MaxPointSize: caps.maxPointSize,
        MaxPrimitiveCount: caps.maxPrimitiveCount,
        MaxVertexIndex: caps.maxVertexIndex,
        MaxStreams: 16,
        MaxStreamStride: caps.maxStreamStride,
        VertexShaderVersion: shaderVersion(D3DVS_VERSION_MARK, vs),
        MaxVertexShaderConst: runsVertexShaders ? 256 : 0,
        PixelShaderVersion: shaderVersion(D3DPS_VERSION_MARK, ps),
        PixelShader1xMaxValue: runsPixelShaders ? 1.0 : 0,
        DevCaps2: 0,
        MaxNpatchTessellationLevel: 0,
        Reserved5: 0,
        MasterAdapterOrdinal: 0,
        AdapterOrdinalInGroup: 0,
        NumberOfAdaptersInGroup: 1,
        // The declaration types beyond a flexible vertex format's own: none,
        // because the renderer reads formats.
        DeclTypes: 0,
        NumSimultaneousRTs: 1,
        // StretchRect copies and never filters, so no filter is offered.
        StretchRectFilterCaps: 0,
        VS20Caps_Caps: 0,
        VS20Caps_DynamicFlowControlDepth: 0,
        VS20Caps_NumTemps: vs.major >= 2 ? 32 : 0,
        VS20Caps_StaticFlowControlDepth: 0,
        PS20Caps_Caps: 0,
        PS20Caps_DynamicFlowControlDepth: 0,
        PS20Caps_NumTemps: ps.major >= 2 ? 32 : 0,
        PS20Caps_StaticFlowControlDepth: 0,
        PS20Caps_NumInstructionSlots: ps.major >= 2 ? 96 : 0,
        VertexTextureFilterCaps: 0,
        MaxVShaderInstructionsExecuted: vs.major >= 2 ? 65535 : 0,
        MaxPShaderInstructionsExecuted: ps.major >= 2 ? 65535 : 0,
        MaxVertexShader30InstructionSlots: vs.major >= 3 ? 512 : 0,
        MaxPixelShader30InstructionSlots: ps.major >= 3 ? 512 : 0,
    };
}
