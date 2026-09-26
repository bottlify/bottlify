/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The structures the Direct3D of DirectX 3, 5 and 6 passes by pointer.
 *
 * Offsets are spelled out, as everywhere in `seam/`. Most of these carry a
 * `dwSize`, and in these versions the size is not only a version tag but the
 * version: one D3DDEVICEDESC grew twice, and a program compiled against the
 * DirectX 3 header hands over the 172 bytes it knows, which is all that may be
 * written.
 */

/** D3DVIEWPORT: a scale and a clip extent, DirectX 3's way of naming the clip volume. */
export const D3DVIEWPORT = Object.freeze({
    dwSize: 0x00,
    dwX: 0x04,
    dwY: 0x08,
    dwWidth: 0x0c,
    dwHeight: 0x10,
    dvScaleX: 0x14,
    dvScaleY: 0x18,
    dvMaxX: 0x1c,
    dvMaxY: 0x20,
    dvMinZ: 0x24,
    dvMaxZ: 0x28,
    SIZE: 0x2c,
});

/** D3DVIEWPORT2: the same rectangle and a clip volume given by its corner and extent. */
export const D3DVIEWPORT2 = Object.freeze({
    dwSize: 0x00,
    dwX: 0x04,
    dwY: 0x08,
    dwWidth: 0x0c,
    dwHeight: 0x10,
    dvClipX: 0x14,
    dvClipY: 0x18,
    dvClipWidth: 0x1c,
    dvClipHeight: 0x20,
    dvMinZ: 0x24,
    dvMaxZ: 0x28,
    SIZE: 0x2c,
});

/** D3DLIGHT, and D3DLIGHT2 which is it with dwFlags after. */
export const D3DLIGHT = Object.freeze({
    dwSize: 0x00,
    dltType: 0x04,
    dcvColor: 0x08,
    dvPosition: 0x18,
    dvDirection: 0x24,
    dvRange: 0x30,
    dvFalloff: 0x34,
    dvAttenuation0: 0x38,
    dvAttenuation1: 0x3c,
    dvAttenuation2: 0x40,
    dvTheta: 0x44,
    dvPhi: 0x48,
    dwFlags: 0x4c,
    SIZE: 0x4c,
    SIZE2: 0x50,
});

/** D3DMATERIAL: four colours, a power, and the texture and ramp of the ramp driver. */
export const D3DMATERIAL = Object.freeze({
    dwSize: 0x00,
    diffuse: 0x04,
    ambient: 0x14,
    specular: 0x24,
    emissive: 0x34,
    power: 0x44,
    hTexture: 0x48,
    dwRampSize: 0x4c,
    SIZE: 0x50,
});

/** D3DSTATS. */
export const D3DSTATS = Object.freeze({
    dwSize: 0x00,
    dwTrianglesDrawn: 0x04,
    dwLinesDrawn: 0x08,
    dwPointsDrawn: 0x0c,
    dwSpansDrawn: 0x10,
    dwVerticesProcessed: 0x14,
    SIZE: 0x18,
});

/**
 * D3DDEVICEDESC. Three sizes are valid, one per version it grew in:
 * DirectX 3's ends before the texture sizes, DirectX 5's before the texture
 * repeat, DirectX 6's is the whole structure.
 */
export const D3DDEVICEDESC = Object.freeze({
    dwSize: 0x00,
    dwFlags: 0x04,
    dcmColorModel: 0x08,
    dwDevCaps: 0x0c,
    dtcTransformCaps: 0x10,
    bClipping: 0x18,
    dlcLightingCaps: 0x1c,
    dpcLineCaps: 0x2c,
    dpcTriCaps: 0x64,
    dwDeviceRenderBitDepth: 0x9c,
    dwDeviceZBufferBitDepth: 0xa0,
    dwMaxBufferSize: 0xa4,
    dwMaxVertexCount: 0xa8,
    dwMinTextureWidth: 0xac,
    dwMinTextureHeight: 0xb0,
    dwMaxTextureWidth: 0xb4,
    dwMaxTextureHeight: 0xb8,
    dwMinStippleWidth: 0xbc,
    dwMaxStippleWidth: 0xc0,
    dwMinStippleHeight: 0xc4,
    dwMaxStippleHeight: 0xc8,
    dwMaxTextureRepeat: 0xcc,
    dwMaxTextureAspectRatio: 0xd0,
    dwMaxAnisotropy: 0xd4,
    dvGuardBandLeft: 0xd8,
    dvGuardBandTop: 0xdc,
    dvGuardBandRight: 0xe0,
    dvGuardBandBottom: 0xe4,
    dvExtentsAdjust: 0xe8,
    dwStencilCaps: 0xec,
    dwFVFCaps: 0xf0,
    dwTextureOpCaps: 0xf4,
    wMaxTextureBlendStages: 0xf8,
    SIZE_V1: 0xac,
    SIZE_V2: 0xcc,
    SIZE: 0xfc,
});

/** D3DFINDDEVICESEARCH. */
export const D3DFINDDEVICESEARCH = Object.freeze({
    dwSize: 0x00,
    dwFlags: 0x04,
    bHardware: 0x08,
    dcmColorModel: 0x0c,
    guid: 0x10,
    dwCaps: 0x20,
    dpcPrimCaps: 0x24,
    SIZE: 0x5c,
});

/** D3DFINDDEVICERESULT: its two descriptions are whichever size the result's own size implies. */
export const D3DFINDDEVICERESULT = Object.freeze({
    dwSize: 0x00,
    guid: 0x04,
    ddHwDesc: 0x14,
});

/** D3DEXECUTEBUFFERDESC. */
export const D3DEXECUTEBUFFERDESC = Object.freeze({
    dwSize: 0x00,
    dwFlags: 0x04,
    dwCaps: 0x08,
    dwBufferSize: 0x0c,
    lpData: 0x10,
    SIZE: 0x14,
});

/** D3DEXECUTEDATA, with the D3DSTATUS it ends in. */
export const D3DEXECUTEDATA = Object.freeze({
    dwSize: 0x00,
    dwVertexOffset: 0x04,
    dwVertexCount: 0x08,
    dwInstructionOffset: 0x0c,
    dwInstructionLength: 0x10,
    dwHVertexOffset: 0x14,
    dsStatus: 0x18,
    SIZE: 0x30,
});
