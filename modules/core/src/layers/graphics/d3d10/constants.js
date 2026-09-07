/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D 10 and DXGI numbers a program compiles against.
 *
 * Every value here is part of the ABI: the guest passes and compares these
 * exact bit patterns, so they are written out rather than derived, and the
 * names keep their API spelling so a reader checking one against a header does
 * not have to translate.
 *
 * Two things are worth knowing before reading the format table.
 *
 * - **A typeless format is not a format a view may use.** It names the bit
 *   layout a resource is stored in; a view over it must name one of the
 *   concrete formats of the same family, and a view that names no format at all
 *   cannot resolve one. That is why every entry carries its family rather than
 *   only its own id: the family is what decides whether a cast is legal.
 * - **Depth is a property of the format, not of the usage.** A depth format may
 *   only be bound as a depth stencil; a colour format may never be. The typeless
 *   family in between (`R24G8`, `R32`) is what lets a program sample a depth
 *   buffer, and it works precisely because the resource is typeless and the two
 *   views name different concrete formats over it.
 */

/** HRESULTs. The DXGI facility (0x87a) is distinct from Direct3D 10's own. */
export const S_OK = 0x00000000;
export const E_INVALIDARG = 0x80070057;
export const E_NOINTERFACE = 0x80004002;
export const E_OUTOFMEMORY = 0x8007000e;
export const DXGI_STATUS_OCCLUDED = 0x087a0001;
export const DXGI_ERROR_INVALID_CALL = 0x887a0001;
export const DXGI_ERROR_NOT_FOUND = 0x887a0002;
export const DXGI_ERROR_MORE_DATA = 0x887a0003;
export const DXGI_ERROR_UNSUPPORTED = 0x887a0004;

/**
 * The version tag `D3D10CreateDevice` is compiled with. It is not advisory:
 * any other value is refused, which is how a header/runtime mismatch is caught
 * at the entry point rather than somewhere inside the device.
 */
export const D3D10_SDK_VERSION = 29;

export const D3D_FEATURE_LEVEL = Object.freeze({
    LEVEL_9_1: 0x9100,
    LEVEL_9_2: 0x9200,
    LEVEL_9_3: 0x9300,
    LEVEL_10_0: 0xa000,
    LEVEL_10_1: 0xa100,
    LEVEL_11_0: 0xb000,
});

export const D3D10_DRIVER_TYPE = Object.freeze({
    HARDWARE: 0,
    REFERENCE: 1,
    NULL: 2,
    SOFTWARE: 3,
    WARP: 5,
});

/** 4 is deliberately absent: the enumeration has a hole there. */
export const D3D10_DRIVER_TYPES = Object.freeze([0, 1, 2, 3, 5]);

export const D3D10_CREATE_DEVICE = Object.freeze({
    SINGLETHREADED: 0x001,
    DEBUG: 0x002,
    SWITCH_TO_REF: 0x004,
    PREVENT_INTERNAL_THREADING_OPTIMIZATIONS: 0x008,
    ALLOW_NULL_FROM_MAP: 0x010,
    BGRA_SUPPORT: 0x020,
    PREVENT_ALTERING_LAYER_SETTINGS_FROM_REGISTRY: 0x080,
    STRICT_VALIDATION: 0x200,
    DEBUGGABLE: 0x400,
});

/** Every bit the flags word may carry; anything else is a caller's mistake. */
export const D3D10_CREATE_DEVICE_MASK = Object.values(D3D10_CREATE_DEVICE)
    .reduce((all, bit)=>all | bit, 0);

// --- DXGI ---

export const DXGI_FORMAT = Object.freeze({
    UNKNOWN: 0x00,
    R32G32B32A32_TYPELESS: 0x01,
    R32G32B32A32_FLOAT: 0x02,
    R32G32B32A32_UINT: 0x03,
    R32G32B32A32_SINT: 0x04,
    R32G32B32_TYPELESS: 0x05,
    R16G16B16A16_TYPELESS: 0x09,
    R16G16B16A16_FLOAT: 0x0a,
    R16G16B16A16_UNORM: 0x0b,
    R32G32_TYPELESS: 0x0f,
    R32G8X24_TYPELESS: 0x13,
    D32_FLOAT_S8X24_UINT: 0x14,
    R10G10B10A2_TYPELESS: 0x17,
    R10G10B10A2_UNORM: 0x18,
    R8G8B8A8_TYPELESS: 0x1b,
    R8G8B8A8_UNORM: 0x1c,
    R8G8B8A8_UNORM_SRGB: 0x1d,
    R8G8B8A8_UINT: 0x1e,
    R8G8B8A8_SNORM: 0x1f,
    R8G8B8A8_SINT: 0x20,
    R16G16_TYPELESS: 0x21,
    R16G16_UNORM: 0x23,
    R16G16_SNORM: 0x25,
    R32_TYPELESS: 0x27,
    D32_FLOAT: 0x28,
    R32_FLOAT: 0x29,
    R32_UINT: 0x2a,
    R32_SINT: 0x2b,
    R24G8_TYPELESS: 0x2c,
    D24_UNORM_S8_UINT: 0x2d,
    R24_UNORM_X8_TYPELESS: 0x2e,
    R8G8_TYPELESS: 0x30,
    R8G8_UNORM: 0x31,
    R8G8_SNORM: 0x33,
    R16_TYPELESS: 0x35,
    R16_FLOAT: 0x36,
    D16_UNORM: 0x37,
    R16_UNORM: 0x38,
    R16_UINT: 0x39,
    R16_SINT: 0x3b,
    R8_TYPELESS: 0x3c,
    R8_UNORM: 0x3d,
    B8G8R8A8_UNORM: 0x57,
    B8G8R8X8_UNORM: 0x58,
});

/** What the validity tables distinguish about a format, and nothing more. */
export const FORMAT_KIND = Object.freeze({
    TYPELESS: 'typeless',
    COLOUR: 'colour',
    DEPTH: 'depth',
});

/**
 * @typedef {Object} FormatDescription
 * @property {string} kind    A FORMAT_KIND.
 * @property {number} family  The typeless format this one may be cast within.
 * @property {number} bytesPerPixel
 */

/**
 * The formats this layer knows, each with the typeless family it belongs to.
 * A typeless format is its own family, which is what makes the cast rule a
 * single comparison rather than a table of pairs.
 *
 * @type {Readonly<Record<number, FormatDescription>>}
 */
export const FORMAT_INFO = Object.freeze({
    [DXGI_FORMAT.R32G32B32A32_TYPELESS]: {
        kind: FORMAT_KIND.TYPELESS, family: DXGI_FORMAT.R32G32B32A32_TYPELESS, bytesPerPixel: 16,
    },
    [DXGI_FORMAT.R32G32B32A32_FLOAT]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R32G32B32A32_TYPELESS, bytesPerPixel: 16,
    },
    [DXGI_FORMAT.R32G32B32A32_UINT]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R32G32B32A32_TYPELESS, bytesPerPixel: 16,
    },
    [DXGI_FORMAT.R32G32B32A32_SINT]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R32G32B32A32_TYPELESS, bytesPerPixel: 16,
    },
    [DXGI_FORMAT.R32G32B32_TYPELESS]: {
        kind: FORMAT_KIND.TYPELESS, family: DXGI_FORMAT.R32G32B32_TYPELESS, bytesPerPixel: 12,
    },
    [DXGI_FORMAT.R16G16B16A16_TYPELESS]: {
        kind: FORMAT_KIND.TYPELESS, family: DXGI_FORMAT.R16G16B16A16_TYPELESS, bytesPerPixel: 8,
    },
    [DXGI_FORMAT.R16G16B16A16_FLOAT]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R16G16B16A16_TYPELESS, bytesPerPixel: 8,
    },
    [DXGI_FORMAT.R16G16B16A16_UNORM]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R16G16B16A16_TYPELESS, bytesPerPixel: 8,
    },
    [DXGI_FORMAT.R32G32_TYPELESS]: {
        kind: FORMAT_KIND.TYPELESS, family: DXGI_FORMAT.R32G32_TYPELESS, bytesPerPixel: 8,
    },
    [DXGI_FORMAT.R32G8X24_TYPELESS]: {
        kind: FORMAT_KIND.TYPELESS, family: DXGI_FORMAT.R32G8X24_TYPELESS, bytesPerPixel: 8,
    },
    [DXGI_FORMAT.D32_FLOAT_S8X24_UINT]: {
        kind: FORMAT_KIND.DEPTH, family: DXGI_FORMAT.R32G8X24_TYPELESS, bytesPerPixel: 8,
    },
    [DXGI_FORMAT.R10G10B10A2_TYPELESS]: {
        kind: FORMAT_KIND.TYPELESS, family: DXGI_FORMAT.R10G10B10A2_TYPELESS, bytesPerPixel: 4,
    },
    [DXGI_FORMAT.R10G10B10A2_UNORM]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R10G10B10A2_TYPELESS, bytesPerPixel: 4,
    },
    [DXGI_FORMAT.R8G8B8A8_TYPELESS]: {
        kind: FORMAT_KIND.TYPELESS, family: DXGI_FORMAT.R8G8B8A8_TYPELESS, bytesPerPixel: 4,
    },
    [DXGI_FORMAT.R8G8B8A8_UNORM]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R8G8B8A8_TYPELESS, bytesPerPixel: 4,
    },
    [DXGI_FORMAT.R8G8B8A8_UNORM_SRGB]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R8G8B8A8_TYPELESS, bytesPerPixel: 4,
    },
    [DXGI_FORMAT.R8G8B8A8_UINT]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R8G8B8A8_TYPELESS, bytesPerPixel: 4,
    },
    [DXGI_FORMAT.R8G8B8A8_SNORM]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R8G8B8A8_TYPELESS, bytesPerPixel: 4,
    },
    [DXGI_FORMAT.R8G8B8A8_SINT]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R8G8B8A8_TYPELESS, bytesPerPixel: 4,
    },
    [DXGI_FORMAT.R16G16_TYPELESS]: {
        kind: FORMAT_KIND.TYPELESS, family: DXGI_FORMAT.R16G16_TYPELESS, bytesPerPixel: 4,
    },
    [DXGI_FORMAT.R16G16_UNORM]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R16G16_TYPELESS, bytesPerPixel: 4,
    },
    [DXGI_FORMAT.R16G16_SNORM]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R16G16_TYPELESS, bytesPerPixel: 4,
    },
    [DXGI_FORMAT.R32_TYPELESS]: {
        kind: FORMAT_KIND.TYPELESS, family: DXGI_FORMAT.R32_TYPELESS, bytesPerPixel: 4,
    },
    [DXGI_FORMAT.D32_FLOAT]: {
        kind: FORMAT_KIND.DEPTH, family: DXGI_FORMAT.R32_TYPELESS, bytesPerPixel: 4,
    },
    [DXGI_FORMAT.R32_FLOAT]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R32_TYPELESS, bytesPerPixel: 4,
    },
    [DXGI_FORMAT.R32_UINT]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R32_TYPELESS, bytesPerPixel: 4,
    },
    [DXGI_FORMAT.R32_SINT]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R32_TYPELESS, bytesPerPixel: 4,
    },
    [DXGI_FORMAT.R24G8_TYPELESS]: {
        kind: FORMAT_KIND.TYPELESS, family: DXGI_FORMAT.R24G8_TYPELESS, bytesPerPixel: 4,
    },
    [DXGI_FORMAT.D24_UNORM_S8_UINT]: {
        kind: FORMAT_KIND.DEPTH, family: DXGI_FORMAT.R24G8_TYPELESS, bytesPerPixel: 4,
    },
    [DXGI_FORMAT.R24_UNORM_X8_TYPELESS]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R24G8_TYPELESS, bytesPerPixel: 4,
    },
    [DXGI_FORMAT.R8G8_TYPELESS]: {
        kind: FORMAT_KIND.TYPELESS, family: DXGI_FORMAT.R8G8_TYPELESS, bytesPerPixel: 2,
    },
    [DXGI_FORMAT.R8G8_UNORM]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R8G8_TYPELESS, bytesPerPixel: 2,
    },
    [DXGI_FORMAT.R8G8_SNORM]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R8G8_TYPELESS, bytesPerPixel: 2,
    },
    [DXGI_FORMAT.R16_TYPELESS]: {
        kind: FORMAT_KIND.TYPELESS, family: DXGI_FORMAT.R16_TYPELESS, bytesPerPixel: 2,
    },
    [DXGI_FORMAT.R16_FLOAT]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R16_TYPELESS, bytesPerPixel: 2,
    },
    [DXGI_FORMAT.D16_UNORM]: {
        kind: FORMAT_KIND.DEPTH, family: DXGI_FORMAT.R16_TYPELESS, bytesPerPixel: 2,
    },
    [DXGI_FORMAT.R16_UNORM]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R16_TYPELESS, bytesPerPixel: 2,
    },
    [DXGI_FORMAT.R16_UINT]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R16_TYPELESS, bytesPerPixel: 2,
    },
    [DXGI_FORMAT.R16_SINT]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R16_TYPELESS, bytesPerPixel: 2,
    },
    [DXGI_FORMAT.R8_TYPELESS]: {
        kind: FORMAT_KIND.TYPELESS, family: DXGI_FORMAT.R8_TYPELESS, bytesPerPixel: 1,
    },
    [DXGI_FORMAT.R8_UNORM]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.R8_TYPELESS, bytesPerPixel: 1,
    },
    [DXGI_FORMAT.B8G8R8A8_UNORM]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.B8G8R8A8_UNORM, bytesPerPixel: 4,
    },
    [DXGI_FORMAT.B8G8R8X8_UNORM]: {
        kind: FORMAT_KIND.COLOUR, family: DXGI_FORMAT.B8G8R8X8_UNORM, bytesPerPixel: 4,
    },
});

export const DXGI_SWAP_EFFECT = Object.freeze({
    DISCARD: 0,
    SEQUENTIAL: 1,
    FLIP_SEQUENTIAL: 3,
    FLIP_DISCARD: 4,
});

export const DXGI_USAGE = Object.freeze({
    SHADER_INPUT: 0x010,
    RENDER_TARGET_OUTPUT: 0x020,
    BACK_BUFFER: 0x040,
    SHARED: 0x080,
    READ_ONLY: 0x100,
    DISCARD_ON_PRESENT: 0x200,
    UNORDERED_ACCESS: 0x400,
});

export const DXGI_SWAP_CHAIN_FLAG = Object.freeze({
    NONPREROTATED: 0x0001,
    ALLOW_MODE_SWITCH: 0x0002,
    GDI_COMPATIBLE: 0x0004,
    RESTRICTED_CONTENT: 0x0008,
    RESTRICT_SHARED_RESOURCE_DRIVER: 0x0010,
    DISPLAY_ONLY: 0x0020,
});

export const DXGI_MODE_SCANLINE_ORDER = Object.freeze({
    UNSPECIFIED: 0,
    PROGRESSIVE: 1,
    UPPER_FIELD_FIRST: 2,
    LOWER_FIELD_FIRST: 3,
});

export const DXGI_MODE_SCALING = Object.freeze({
    UNSPECIFIED: 0,
    CENTERED: 1,
    STRETCHED: 2,
});

/**
 * Interface ids, canonical and upper-case. Programs compare the pointer two
 * `QueryInterface` calls hand back to decide whether two interfaces belong to
 * one object, so the identity of these strings is load-bearing, not decorative.
 */
export const IID = Object.freeze({
    IUnknown: '{00000000-0000-0000-C000-000000000046}',
    IDXGIObject: '{AEC22FB8-76F3-4639-9BE0-28EB43A67A2E}',
    IDXGIDeviceSubObject: '{3D3E0379-F9DE-4D58-BB6C-18D62992F1A6}',
    IDXGIResource: '{035F3AB4-482E-4E50-B41F-8A7F8BD8960B}',
    IDXGISurface: '{CAFCB56C-6AC3-4889-BF47-9E23BBD260EC}',
    IDXGIOutput: '{AE02EEDB-C735-4690-8D52-5A8DC20213AA}',
    IDXGIAdapter: '{2411E7E1-12AC-4CCF-BD14-9798E8534DC0}',
    IDXGIAdapter1: '{29038F61-3839-4626-91FD-086879011A05}',
    IDXGISwapChain: '{310D36A0-D2E7-4C0A-AA04-6A9D23B8886A}',
    IDXGIFactory: '{7B7166EC-21C7-44AE-B21A-C9AE321AE369}',
    IDXGIFactory1: '{770AAE78-F26F-4DBA-A829-253C83D1B387}',
    IDXGIDevice: '{54EC77FA-1377-44E6-8C32-88FD5F44C84C}',
    IDXGIDevice1: '{77DB970F-6276-48BA-BA28-070143B4392C}',
    ID3D10Device: '{9B7E4C0F-342C-4106-A19F-4F2704F689F0}',
    ID3D10Multithread: '{9B7E4E00-342C-4106-A19F-4F2704F689F0}',
    ID3D10Buffer: '{9B7E4C02-342C-4106-A19F-4F2704F689F0}',
    ID3D10Texture1D: '{9B7E4C03-342C-4106-A19F-4F2704F689F0}',
    ID3D10Texture2D: '{9B7E4C04-342C-4106-A19F-4F2704F689F0}',
    ID3D10Texture3D: '{9B7E4C05-342C-4106-A19F-4F2704F689F0}',
    ID3D10ShaderResourceView: '{9B7E4C07-342C-4106-A19F-4F2704F689F0}',
    ID3D10RenderTargetView: '{9B7E4C08-342C-4106-A19F-4F2704F689F0}',
    ID3D10DepthStencilView: '{9B7E4C09-342C-4106-A19F-4F2704F689F0}',
    ID3D10BlendState: '{EDAD8D19-8A35-4D6D-8566-2EA276CDE161}',
    ID3D10DepthStencilState: '{2B4B1CC8-A4AD-41F8-8322-CA86FC3EC675}',
    ID3D10RasterizerState: '{A2A07292-89AF-4345-BE2E-C53D9FBB6E9F}',
    ID3D10SamplerState: '{9B7E4C0C-342C-4106-A19F-4F2704F689F0}',
    ID3D10InputLayout: '{9B7E4C0B-342C-4106-A19F-4F2704F689F0}',
    ID3D10VertexShader: '{9B7E4C0A-342C-4106-A19F-4F2704F689F0}',
    ID3D10GeometryShader: '{6316BE88-54CD-4040-AB44-20461BC81F68}',
    ID3D10PixelShader: '{4968B601-9D00-4CDE-8346-8E7F675819B6}',
});

// --- Direct3D 10 ---

export const D3D10_USAGE = Object.freeze({
    DEFAULT: 0,
    IMMUTABLE: 1,
    DYNAMIC: 2,
    STAGING: 3,
});

export const D3D10_BIND = Object.freeze({
    VERTEX_BUFFER: 0x01,
    INDEX_BUFFER: 0x02,
    CONSTANT_BUFFER: 0x04,
    SHADER_RESOURCE: 0x08,
    STREAM_OUTPUT: 0x10,
    RENDER_TARGET: 0x20,
    DEPTH_STENCIL: 0x40,
});

export const D3D10_CPU_ACCESS = Object.freeze({
    WRITE: 0x10000,
    READ: 0x20000,
});

export const D3D10_RESOURCE_MISC = Object.freeze({
    GENERATE_MIPS: 0x01,
    SHARED: 0x02,
    TEXTURECUBE: 0x04,
    SHARED_KEYEDMUTEX: 0x10,
    GDI_COMPATIBLE: 0x20,
});

export const D3D10_RESOURCE_DIMENSION = Object.freeze({
    UNKNOWN: 0,
    BUFFER: 1,
    TEXTURE1D: 2,
    TEXTURE2D: 3,
    TEXTURE3D: 4,
});

export const D3D10_BLEND = Object.freeze({
    ZERO: 1,
    ONE: 2,
    SRC_COLOR: 3,
    INV_SRC_COLOR: 4,
    SRC_ALPHA: 5,
    INV_SRC_ALPHA: 6,
    DEST_ALPHA: 7,
    INV_DEST_ALPHA: 8,
    DEST_COLOR: 9,
    INV_DEST_COLOR: 10,
    SRC_ALPHA_SAT: 11,
    BLEND_FACTOR: 14,
    INV_BLEND_FACTOR: 15,
    SRC1_COLOR: 16,
    INV_SRC1_COLOR: 17,
    SRC1_ALPHA: 18,
    INV_SRC1_ALPHA: 19,
});

export const D3D10_BLEND_OP = Object.freeze({
    ADD: 1,
    SUBTRACT: 2,
    REV_SUBTRACT: 3,
    MIN: 4,
    MAX: 5,
});

export const D3D10_COLOR_WRITE_ENABLE = Object.freeze({
    RED: 0x1,
    GREEN: 0x2,
    BLUE: 0x4,
    ALPHA: 0x8,
    ALL: 0xf,
});

export const D3D10_DEPTH_WRITE_MASK = Object.freeze({ ZERO: 0, ALL: 1 });

export const D3D10_COMPARISON = Object.freeze({
    NEVER: 1,
    LESS: 2,
    EQUAL: 3,
    LESS_EQUAL: 4,
    GREATER: 5,
    NOT_EQUAL: 6,
    GREATER_EQUAL: 7,
    ALWAYS: 8,
});

export const D3D10_STENCIL_OP = Object.freeze({
    KEEP: 1,
    ZERO: 2,
    REPLACE: 3,
    INCR_SAT: 4,
    DECR_SAT: 5,
    INVERT: 6,
    INCR: 7,
    DECR: 8,
});

export const D3D10_FILL_MODE = Object.freeze({ WIREFRAME: 2, SOLID: 3 });

export const D3D10_CULL_MODE = Object.freeze({ NONE: 1, FRONT: 2, BACK: 3 });

/**
 * The filter is a bit field wearing an enumeration's clothes: bit 0 is the mip
 * filter, bit 2 the magnification filter, bit 4 the minification filter, 0x40
 * marks anisotropy and 0x80 marks a comparison filter. That structure is why
 * the valid values are not contiguous, and why the two masks below can decide
 * which of a sampler description's fields mean anything.
 */
export const D3D10_FILTER = Object.freeze({
    MIN_MAG_MIP_POINT: 0x00,
    MIN_MAG_POINT_MIP_LINEAR: 0x01,
    MIN_POINT_MAG_LINEAR_MIP_POINT: 0x04,
    MIN_POINT_MAG_MIP_LINEAR: 0x05,
    MIN_LINEAR_MAG_MIP_POINT: 0x10,
    MIN_LINEAR_MAG_POINT_MIP_LINEAR: 0x11,
    MIN_MAG_LINEAR_MIP_POINT: 0x14,
    MIN_MAG_MIP_LINEAR: 0x15,
    ANISOTROPIC: 0x55,
    COMPARISON_MIN_MAG_MIP_POINT: 0x80,
    COMPARISON_MIN_MAG_POINT_MIP_LINEAR: 0x81,
    COMPARISON_MIN_POINT_MAG_LINEAR_MIP_POINT: 0x84,
    COMPARISON_MIN_POINT_MAG_MIP_LINEAR: 0x85,
    COMPARISON_MIN_LINEAR_MAG_MIP_POINT: 0x90,
    COMPARISON_MIN_LINEAR_MAG_POINT_MIP_LINEAR: 0x91,
    COMPARISON_MIN_MAG_LINEAR_MIP_POINT: 0x94,
    COMPARISON_MIN_MAG_MIP_LINEAR: 0x95,
    COMPARISON_ANISOTROPIC: 0xd5,
    TEXT_1BIT: 0x80000000,
});

export const D3D10_FILTER_ANISOTROPIC_BIT = 0x40;
export const D3D10_FILTER_COMPARISON_BIT = 0x80;

export const D3D10_TEXTURE_ADDRESS = Object.freeze({
    WRAP: 1,
    MIRROR: 2,
    CLAMP: 3,
    BORDER: 4,
    MIRROR_ONCE: 5,
});

export const D3D10_RTV_DIMENSION = Object.freeze({
    UNKNOWN: 0,
    BUFFER: 1,
    TEXTURE1D: 2,
    TEXTURE1DARRAY: 3,
    TEXTURE2D: 4,
    TEXTURE2DARRAY: 5,
    TEXTURE2DMS: 6,
    TEXTURE2DMSARRAY: 7,
    TEXTURE3D: 8,
});

export const D3D10_DSV_DIMENSION = Object.freeze({
    UNKNOWN: 0,
    TEXTURE1D: 1,
    TEXTURE1DARRAY: 2,
    TEXTURE2D: 3,
    TEXTURE2DARRAY: 4,
    TEXTURE2DMS: 5,
    TEXTURE2DMSARRAY: 6,
});

export const D3D10_SRV_DIMENSION = Object.freeze({
    UNKNOWN: 0,
    BUFFER: 1,
    TEXTURE1D: 2,
    TEXTURE1DARRAY: 3,
    TEXTURE2D: 4,
    TEXTURE2DARRAY: 5,
    TEXTURE2DMS: 6,
    TEXTURE2DMSARRAY: 7,
    TEXTURE3D: 8,
    TEXTURECUBE: 9,
});

export const D3D10_PRIMITIVE_TOPOLOGY = Object.freeze({
    UNDEFINED: 0,
    POINTLIST: 1,
    LINELIST: 2,
    LINESTRIP: 3,
    TRIANGLELIST: 4,
    TRIANGLESTRIP: 5,
    LINELIST_ADJ: 10,
    LINESTRIP_ADJ: 11,
    TRIANGLELIST_ADJ: 12,
    TRIANGLESTRIP_ADJ: 13,
});

export const D3D10_INPUT_CLASSIFICATION = Object.freeze({
    PER_VERTEX_DATA: 0,
    PER_INSTANCE_DATA: 1,
});

/** Pipeline limits. Every one of them is a slot count a `Get` reports against. */
export const D3D10_LIMITS = Object.freeze({
    CONSTANT_BUFFER_SLOTS: 14,
    SHADER_RESOURCE_SLOTS: 128,
    SAMPLER_SLOTS: 16,
    VERTEX_INPUT_SLOTS: 16,
    INPUT_ELEMENTS: 16,
    SIMULTANEOUS_RENDER_TARGETS: 8,
    VIEWPORT_AND_SCISSOR_SLOTS: 16,
    SO_BUFFER_SLOTS: 4,
    MAX_TEXTURE1D_DIMENSION: 8192,
    MAX_TEXTURE2D_DIMENSION: 8192,
    MAX_TEXTURE3D_DIMENSION: 2048,
    MAX_MULTISAMPLE_SAMPLE_COUNT: 32,
    MAX_SWAP_CHAIN_BUFFERS: 16,
    CONSTANT_BUFFER_SIZE_GRANULARITY: 16,
});

/** State a device holds before anything has been set, and after ClearState. */
export const D3D10_DEFAULTS = Object.freeze({
    STENCIL_READ_MASK: 0xff,
    STENCIL_WRITE_MASK: 0xff,
    SAMPLE_MASK: 0xffffffff,
    BLEND_FACTOR: Object.freeze([1.0, 1.0, 1.0, 1.0]),
});

/** `~0u` in a view description: "as many as the resource has left". */
export const ALL_REMAINING = 0xffffffff;
