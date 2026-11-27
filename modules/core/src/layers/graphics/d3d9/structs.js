/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The structures only Direct3D 9 declares, as a guest lays them out: each
 * declared once as d3d9types.h or d3d9caps.h declares it and laid out by
 * `system/layout.js`, because a field read one slot early is still a
 * plausible number. The capability block is the one that matters most: it
 * grew by a quarter over Direct3D 8's and the growth is in the middle as well
 * as at the end, so nothing about 8's declaration can be reused past the
 * point where the two diverge.
 */

import { GUID, fieldsOf, struct } from '../../../system/layout.js';

/** @typedef {import('../../../system/layout.js').Declared} Declared */

/** @param {readonly string[]} names @param {'u8' | 'u16' | 'u32' | 'i32' | 'f32'} kind @returns {Declared[]} */
const all = (names, kind)=>names.map(name=>[name, kind]);

/**
 * D3DCAPS9, every field of it, 304 bytes.
 *
 * The first fifty-three dwords are D3DCAPS8's; what follows is the second
 * generation of shader capabilities - D3DVSHADERCAPS2_0 and
 * D3DPSHADERCAPS2_0 embedded in line, of four and five dwords, their fields
 * named here under the member's name - and the instruction budgets of the
 * third.
 */
export const D3DCAPS9 = struct([...all(['DeviceType', 'AdapterOrdinal', 'Caps', 'Caps2', 'Caps3',
    'PresentationIntervals', 'CursorCaps', 'DevCaps', 'PrimitiveMiscCaps', 'RasterCaps',
    'ZCmpCaps', 'SrcBlendCaps', 'DestBlendCaps', 'AlphaCmpCaps', 'ShadeCaps', 'TextureCaps',
    'TextureFilterCaps', 'CubeTextureFilterCaps', 'VolumeTextureFilterCaps', 'TextureAddressCaps',
    'VolumeTextureAddressCaps', 'LineCaps', 'MaxTextureWidth', 'MaxTextureHeight',
    'MaxVolumeExtent', 'MaxTextureRepeat', 'MaxTextureAspectRatio', 'MaxAnisotropy'], 'u32'),
...all(['MaxVertexW', 'GuardBandLeft', 'GuardBandTop', 'GuardBandRight', 'GuardBandBottom',
    'ExtentsAdjust'], 'f32'),
...all(['StencilCaps', 'FVFCaps', 'TextureOpCaps', 'MaxTextureBlendStages',
    'MaxSimultaneousTextures', 'VertexProcessingCaps', 'MaxActiveLights', 'MaxUserClipPlanes',
    'MaxVertexBlendMatrices', 'MaxVertexBlendMatrixIndex'], 'u32'),
['MaxPointSize', 'f32'],
...all(['MaxPrimitiveCount', 'MaxVertexIndex', 'MaxStreams', 'MaxStreamStride',
    'VertexShaderVersion', 'MaxVertexShaderConst', 'PixelShaderVersion'], 'u32'),
['PixelShader1xMaxValue', 'f32'], ['DevCaps2', 'u32'], ['MaxNpatchTessellationLevel', 'f32'],
...all(['Reserved5', 'MasterAdapterOrdinal', 'AdapterOrdinalInGroup', 'NumberOfAdaptersInGroup',
    'DeclTypes', 'NumSimultaneousRTs', 'StretchRectFilterCaps', 'VS20Caps_Caps'], 'u32'),
...all(['VS20Caps_DynamicFlowControlDepth', 'VS20Caps_NumTemps',
    'VS20Caps_StaticFlowControlDepth'], 'i32'),
['PS20Caps_Caps', 'u32'],
...all(['PS20Caps_DynamicFlowControlDepth', 'PS20Caps_NumTemps',
    'PS20Caps_StaticFlowControlDepth', 'PS20Caps_NumInstructionSlots'], 'i32'),
...all(['VertexTextureFilterCaps', 'MaxVShaderInstructionsExecuted',
    'MaxPShaderInstructionsExecuted', 'MaxVertexShader30InstructionSlots',
    'MaxPixelShader30InstructionSlots'], 'u32')]).at(4);

/** The fields of D3DCAPS9 that are floats rather than dwords. */
export const D3DCAPS9_FLOATS = Object.freeze(fieldsOf(D3DCAPS9)
    .filter(field=>field.kind === 'f32').map(field=>field.name));

/**
 * D3DVERTEXELEMENT9: two words, then four bytes. Eight bytes each, and a
 * declaration is an array of them closed by D3DDECL_END, whose stream is 0xff.
 */
export const D3DVERTEXELEMENT9 = struct([...all(['Stream', 'Offset'], 'u16'),
    ...all(['Type', 'Method', 'Usage', 'UsageIndex'], 'u8')]).at(4);

/** The stream number that closes a declaration. */
export const D3DDECL_END_STREAM = 0xff;

const RESOURCE_HEAD = all(['Format', 'Type', 'Usage', 'Pool'], 'u32');

/**
 * D3DSURFACE_DESC as Direct3D 9 declares it: MultiSampleQuality is inserted
 * after the multisample type, and the byte size D3D8 reported is gone.
 */
export const D3DSURFACE_DESC9 = struct([...RESOURCE_HEAD, ...all(['MultiSampleType',
    'MultiSampleQuality', 'Width', 'Height'], 'u32')]).at(4);

/** D3DVOLUME_DESC as Direct3D 9 declares it: Direct3D 8's without the size. */
export const D3DVOLUME_DESC9 = struct([...RESOURCE_HEAD,
    ...all(['Width', 'Height', 'Depth'], 'u32')]).at(4);

/** D3DVERTEXBUFFER_DESC: the same first four dwords as a surface, then the size, FVF. */
export const D3DVERTEXBUFFER_DESC9 = struct([...RESOURCE_HEAD, ...all(['Size', 'FVF'], 'u32')])
    .at(4);

/** D3DINDEXBUFFER_DESC: a vertex buffer's description without the FVF. */
export const D3DINDEXBUFFER_DESC9 = struct([...RESOURCE_HEAD, ['Size', 'u32']]).at(4);

/** D3DVIEWPORT9: D3D8's six dwords under the newer name, the last two floats. */
export const D3DVIEWPORT9 = struct([...all(['X', 'Y', 'Width', 'Height'], 'u32'),
    ...all(['MinZ', 'MaxZ'], 'f32')]).at(4);

/** D3DDISPLAYMODEEX, whose first field is its own size, as the caller sets it. */
export const D3DDISPLAYMODEEX = struct(all(['Size', 'Width', 'Height', 'RefreshRate', 'Format',
    'ScanLineOrdering'], 'u32')).at(4);

/** D3DDISPLAYMODEFILTER: which of an adapter's modes an Ex enumeration lists. */
export const D3DDISPLAYMODEFILTER = struct(all(['Size', 'Format', 'ScanLineOrdering'], 'u32'))
    .at(4);

/** MAX_DEVICE_IDENTIFIER_STRING: the length of the driver and description strings. */
const MAX_DEVICE_IDENTIFIER_STRING = 512;
/** The length of the device name field, terminator included. */
export const DEVICE_NAME_LENGTH = 32;

/**
 * D3DADAPTER_IDENTIFIER9: D3D8's identifier with the device name inserted
 * after the description - thirty-two bytes, the length of a display device
 * name - which moves everything after it by that much. The version is a
 * LARGE_INTEGER, so the whole is padded to eight at the end as 8's was.
 */
export const D3DADAPTER_IDENTIFIER9 = struct([
    ['Driver', 'u8', MAX_DEVICE_IDENTIFIER_STRING],
    ['Description', 'u8', MAX_DEVICE_IDENTIFIER_STRING], ['DeviceName', 'u8', DEVICE_NAME_LENGTH],
    ['DriverVersion', 'i64'],
    ...all(['VendorId', 'DeviceId', 'SubSysId', 'Revision'], 'u32'),
    ['DeviceIdentifier', GUID], ['WHQLLevel', 'u32']]).at(4);

/**
 * Where D3DADAPTER_IDENTIFIER9's fields end, short of its padding: only the
 * fields are written, because a program built with the structure packed has
 * a buffer that ends there.
 */
export const D3DADAPTER_IDENTIFIER9_FIELDS = D3DADAPTER_IDENTIFIER9.WHQLLevel + 4;

/** D3DCLIPSTATUS9: D3D8's two dwords, unchanged. */
export const D3DCLIPSTATUS9 = struct(all(['ClipUnion', 'ClipIntersection'], 'u32')).at(4);

/**
 * D3DRECTPATCH_INFO and D3DTRIPATCH_INFO are read by nothing here: both patch
 * draws are refused before their arguments are looked at.
 */

/** D3DBOX: six dwords, front and back last. */
export const D3DBOX = struct(all(['Left', 'Top', 'Right', 'Bottom', 'Front', 'Back'], 'u32'))
    .at(4);
