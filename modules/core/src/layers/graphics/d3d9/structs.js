/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The structures only Direct3D 9 declares, as a guest lays them out.
 *
 * Every offset is written out rather than counted, because a field read one
 * slot early is still a plausible number. The capability block is the one
 * that matters most: it grew by a quarter over Direct3D 8's and the growth is
 * in the middle as well as at the end, so nothing about 8's table can be reused
 * past the point where the two diverge.
 */

/**
 * D3DCAPS9, every field of it, 304 bytes.
 *
 * The first fifty-three dwords are D3DCAPS8's; what follows is the second
 * generation of shader capabilities -- two small structures embedded in line,
 * of four and five dwords -- and the instruction budgets of the third.
 */
export const D3DCAPS9 = Object.freeze({
    DeviceType: 0x00,
    AdapterOrdinal: 0x04,
    Caps: 0x08,
    Caps2: 0x0c,
    Caps3: 0x10,
    PresentationIntervals: 0x14,
    CursorCaps: 0x18,
    DevCaps: 0x1c,
    PrimitiveMiscCaps: 0x20,
    RasterCaps: 0x24,
    ZCmpCaps: 0x28,
    SrcBlendCaps: 0x2c,
    DestBlendCaps: 0x30,
    AlphaCmpCaps: 0x34,
    ShadeCaps: 0x38,
    TextureCaps: 0x3c,
    TextureFilterCaps: 0x40,
    CubeTextureFilterCaps: 0x44,
    VolumeTextureFilterCaps: 0x48,
    TextureAddressCaps: 0x4c,
    VolumeTextureAddressCaps: 0x50,
    LineCaps: 0x54,
    MaxTextureWidth: 0x58,
    MaxTextureHeight: 0x5c,
    MaxVolumeExtent: 0x60,
    MaxTextureRepeat: 0x64,
    MaxTextureAspectRatio: 0x68,
    MaxAnisotropy: 0x6c,
    MaxVertexW: 0x70,
    GuardBandLeft: 0x74,
    GuardBandTop: 0x78,
    GuardBandRight: 0x7c,
    GuardBandBottom: 0x80,
    ExtentsAdjust: 0x84,
    StencilCaps: 0x88,
    FVFCaps: 0x8c,
    TextureOpCaps: 0x90,
    MaxTextureBlendStages: 0x94,
    MaxSimultaneousTextures: 0x98,
    VertexProcessingCaps: 0x9c,
    MaxActiveLights: 0xa0,
    MaxUserClipPlanes: 0xa4,
    MaxVertexBlendMatrices: 0xa8,
    MaxVertexBlendMatrixIndex: 0xac,
    MaxPointSize: 0xb0,
    MaxPrimitiveCount: 0xb4,
    MaxVertexIndex: 0xb8,
    MaxStreams: 0xbc,
    MaxStreamStride: 0xc0,
    VertexShaderVersion: 0xc4,
    MaxVertexShaderConst: 0xc8,
    PixelShaderVersion: 0xcc,
    PixelShader1xMaxValue: 0xd0,
    DevCaps2: 0xd4,
    MaxNpatchTessellationLevel: 0xd8,
    Reserved5: 0xdc,
    MasterAdapterOrdinal: 0xe0,
    AdapterOrdinalInGroup: 0xe4,
    NumberOfAdaptersInGroup: 0xe8,
    DeclTypes: 0xec,
    NumSimultaneousRTs: 0xf0,
    StretchRectFilterCaps: 0xf4,
    VS20Caps_Caps: 0xf8,
    VS20Caps_DynamicFlowControlDepth: 0xfc,
    VS20Caps_NumTemps: 0x100,
    VS20Caps_StaticFlowControlDepth: 0x104,
    PS20Caps_Caps: 0x108,
    PS20Caps_DynamicFlowControlDepth: 0x10c,
    PS20Caps_NumTemps: 0x110,
    PS20Caps_StaticFlowControlDepth: 0x114,
    PS20Caps_NumInstructionSlots: 0x118,
    VertexTextureFilterCaps: 0x11c,
    MaxVShaderInstructionsExecuted: 0x120,
    MaxPShaderInstructionsExecuted: 0x124,
    MaxVertexShader30InstructionSlots: 0x128,
    MaxPixelShader30InstructionSlots: 0x12c,
    SIZE: 0x130,
});

/** The fields of D3DCAPS9 that are floats rather than dwords. */
export const D3DCAPS9_FLOATS = Object.freeze([
    'MaxVertexW', 'GuardBandLeft', 'GuardBandTop', 'GuardBandRight', 'GuardBandBottom',
    'ExtentsAdjust', 'MaxPointSize', 'PixelShader1xMaxValue', 'MaxNpatchTessellationLevel',
]);

/**
 * D3DVERTEXELEMENT9: two words, then four bytes. Eight bytes each, and a
 * declaration is an array of them closed by D3DDECL_END, whose stream is 0xff.
 */
export const D3DVERTEXELEMENT9 = Object.freeze({
    Stream: 0x00,
    Offset: 0x02,
    Type: 0x04,
    Method: 0x05,
    Usage: 0x06,
    UsageIndex: 0x07,
    SIZE: 0x08,
});

/** The stream number that closes a declaration. */
export const D3DDECL_END_STREAM = 0xff;

/**
 * D3DSURFACE_DESC as Direct3D 9 declares it: MultiSampleQuality is inserted
 * after the multisample type, and the byte size D3D8 reported is gone.
 */
export const D3DSURFACE_DESC9 = Object.freeze({
    Format: 0x00,
    Type: 0x04,
    Usage: 0x08,
    Pool: 0x0c,
    MultiSampleType: 0x10,
    MultiSampleQuality: 0x14,
    Width: 0x18,
    Height: 0x1c,
    SIZE: 0x20,
});

/** D3DVOLUME_DESC as Direct3D 9 declares it: Direct3D 8's without the size. */
export const D3DVOLUME_DESC9 = Object.freeze({
    Format: 0x00,
    Type: 0x04,
    Usage: 0x08,
    Pool: 0x0c,
    Width: 0x10,
    Height: 0x14,
    Depth: 0x18,
    SIZE: 0x1c,
});

/** D3DVERTEXBUFFER_DESC: the same first four dwords as a surface, then the size, FVF. */
export const D3DVERTEXBUFFER_DESC9 = Object.freeze({
    Format: 0x00,
    Type: 0x04,
    Usage: 0x08,
    Pool: 0x0c,
    Size: 0x10,
    FVF: 0x14,
    SIZE: 0x18,
});

/** D3DINDEXBUFFER_DESC: a vertex buffer's description without the FVF. */
export const D3DINDEXBUFFER_DESC9 = Object.freeze({
    Format: 0x00,
    Type: 0x04,
    Usage: 0x08,
    Pool: 0x0c,
    Size: 0x10,
    SIZE: 0x14,
});

/**
 * D3DVIEWPORT9: D3D8's six dwords under the newer name, the last two floats.
 */
export const D3DVIEWPORT9 = Object.freeze({
    X: 0x00,
    Y: 0x04,
    Width: 0x08,
    Height: 0x0c,
    MinZ: 0x10,
    MaxZ: 0x14,
    SIZE: 0x18,
});

/**
 * D3DADAPTER_IDENTIFIER9: D3D8's identifier with the device name inserted
 * after the description -- thirty-two bytes, the length of a display device
 * name -- which moves everything after it by that much. The whole is padded
 * to eight at the end as 8's was, and only the fields are written, for the
 * same reason.
 */
export const D3DADAPTER_IDENTIFIER9 = Object.freeze({
    Driver: 0x000,
    Description: 0x200,
    DeviceName: 0x400,
    DriverVersion: 0x420,
    VendorId: 0x428,
    DeviceId: 0x42c,
    SubSysId: 0x430,
    Revision: 0x434,
    DeviceIdentifier: 0x438,
    WHQLLevel: 0x448,
    FIELDS: 0x44c,
    SIZE: 0x450,
});

/** The length of the device name field, terminator included. */
export const DEVICE_NAME_LENGTH = 32;

/** D3DCLIPSTATUS9: D3D8's two dwords, unchanged. */
export const D3DCLIPSTATUS9 = Object.freeze({
    ClipUnion: 0x00,
    ClipIntersection: 0x04,
    SIZE: 0x08,
});

/**
 * D3DRECTPATCH_INFO and D3DTRIPATCH_INFO are read by nothing here: both patch
 * draws are refused before their arguments are looked at.
 */

/** D3DBOX: six dwords, front and back last. */
export const D3DBOX = Object.freeze({
    Left: 0x00,
    Top: 0x04,
    Right: 0x08,
    Bottom: 0x0c,
    Front: 0x10,
    Back: 0x14,
    SIZE: 0x18,
});
