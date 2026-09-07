/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D 9 numbers a program compiles against.
 *
 * Every value here is part of the ABI: the guest passes and compares these
 * exact bit patterns, so they are written out rather than derived. The names
 * keep their API spelling for the same reason -- a reader checking one against
 * a header should not have to translate.
 *
 * Floats are the subtle half. A render state is a DWORD, and a float one is the
 * bit pattern of the float, not the number: the guest writes
 * `*(DWORD*)&value` and reads it back the same way. Storing 1.0 as the number 1
 * would read back as 0x00000001 instead of 0x3f800000.
 */

export const D3D_OK = 0x00000000;
export const D3DERR_INVALIDCALL = 0x8876086c;
export const D3DERR_DEVICELOST = 0x88760868;
export const D3DERR_DEVICENOTRESET = 0x88760869;
export const D3DERR_NOTAVAILABLE = 0x8876086a;
export const D3DERR_NOTFOUND = 0x88760866;

/** D3DRENDERSTATETYPE. Sparse by design: the gaps are states D3D8 dropped. */
export const D3DRS = Object.freeze({
    ZENABLE: 7,
    FILLMODE: 8,
    SHADEMODE: 9,
    ZWRITEENABLE: 14,
    ALPHATESTENABLE: 15,
    LASTPIXEL: 16,
    SRCBLEND: 19,
    DESTBLEND: 20,
    CULLMODE: 22,
    ZFUNC: 23,
    ALPHAREF: 24,
    ALPHAFUNC: 25,
    DITHERENABLE: 26,
    ALPHABLENDENABLE: 27,
    FOGENABLE: 28,
    SPECULARENABLE: 29,
    FOGCOLOR: 34,
    FOGTABLEMODE: 35,
    FOGSTART: 36,
    FOGEND: 37,
    FOGDENSITY: 38,
    RANGEFOGENABLE: 48,
    STENCILENABLE: 52,
    STENCILFAIL: 53,
    STENCILZFAIL: 54,
    STENCILPASS: 55,
    STENCILFUNC: 56,
    STENCILREF: 57,
    STENCILMASK: 58,
    STENCILWRITEMASK: 59,
    TEXTUREFACTOR: 60,
    WRAP0: 128,
    WRAP1: 129,
    WRAP2: 130,
    WRAP3: 131,
    WRAP4: 132,
    WRAP5: 133,
    WRAP6: 134,
    WRAP7: 135,
    CLIPPING: 136,
    LIGHTING: 137,
    AMBIENT: 139,
    FOGVERTEXMODE: 140,
    COLORVERTEX: 141,
    LOCALVIEWER: 142,
    NORMALIZENORMALS: 143,
    DIFFUSEMATERIALSOURCE: 145,
    SPECULARMATERIALSOURCE: 146,
    AMBIENTMATERIALSOURCE: 147,
    EMISSIVEMATERIALSOURCE: 148,
    VERTEXBLEND: 151,
    CLIPPLANEENABLE: 152,
    POINTSIZE: 154,
    POINTSIZE_MIN: 155,
    POINTSPRITEENABLE: 156,
    POINTSCALEENABLE: 157,
    POINTSCALE_A: 158,
    POINTSCALE_B: 159,
    POINTSCALE_C: 160,
    MULTISAMPLEANTIALIAS: 161,
    MULTISAMPLEMASK: 162,
    PATCHEDGESTYLE: 163,
    DEBUGMONITORTOKEN: 165,
    POINTSIZE_MAX: 166,
    INDEXEDVERTEXBLENDENABLE: 167,
    COLORWRITEENABLE: 168,
    TWEENFACTOR: 170,
    BLENDOP: 171,
    POSITIONDEGREE: 172,
    NORMALDEGREE: 173,
    SCISSORTESTENABLE: 174,
    SLOPESCALEDEPTHBIAS: 175,
    ANTIALIASEDLINEENABLE: 176,
    MINTESSELLATIONLEVEL: 178,
    MAXTESSELLATIONLEVEL: 179,
    ADAPTIVETESS_X: 180,
    ADAPTIVETESS_Y: 181,
    ADAPTIVETESS_Z: 182,
    ADAPTIVETESS_W: 183,
    ENABLEADAPTIVETESSELLATION: 184,
    TWOSIDEDSTENCILMODE: 185,
    CCW_STENCILFAIL: 186,
    CCW_STENCILZFAIL: 187,
    CCW_STENCILPASS: 188,
    CCW_STENCILFUNC: 189,
    COLORWRITEENABLE1: 190,
    COLORWRITEENABLE2: 191,
    COLORWRITEENABLE3: 192,
    BLENDFACTOR: 193,
    SRGBWRITEENABLE: 194,
    DEPTHBIAS: 195,
    WRAP8: 198,
    WRAP9: 199,
    WRAP10: 200,
    WRAP11: 201,
    WRAP12: 202,
    WRAP13: 203,
    WRAP14: 204,
    WRAP15: 205,
    SEPARATEALPHABLENDENABLE: 206,
    SRCBLENDALPHA: 207,
    DESTBLENDALPHA: 208,
    BLENDOPALPHA: 209,
});

export const D3DZB = Object.freeze({ FALSE: 0, TRUE: 1, USEW: 2 });
export const D3DFILL = Object.freeze({ POINT: 1, WIREFRAME: 2, SOLID: 3 });
export const D3DSHADE = Object.freeze({ FLAT: 1, GOURAUD: 2, PHONG: 3 });
export const D3DCULL = Object.freeze({ NONE: 1, CW: 2, CCW: 3 });
export const D3DFOG = Object.freeze({ NONE: 0, EXP: 1, EXP2: 2, LINEAR: 3 });
export const D3DMCS = Object.freeze({ MATERIAL: 0, COLOR1: 1, COLOR2: 2 });
export const D3DPATCHEDGE = Object.freeze({ DISCRETE: 0, CONTINUOUS: 1 });
export const D3DDEGREE = Object.freeze({ LINEAR: 1, QUADRATIC: 2, CUBIC: 3, QUINTIC: 5 });
export const D3DLIGHTTYPE = Object.freeze({ POINT: 1, SPOT: 2, DIRECTIONAL: 3 });
export const D3DDMT = Object.freeze({ ENABLE: 0, DISABLE: 1 });

export const D3DBLEND = Object.freeze({
    ZERO: 1,
    ONE: 2,
    SRCCOLOR: 3,
    INVSRCCOLOR: 4,
    SRCALPHA: 5,
    INVSRCALPHA: 6,
    DESTALPHA: 7,
    INVDESTALPHA: 8,
    DESTCOLOR: 9,
    INVDESTCOLOR: 10,
    SRCALPHASAT: 11,
    BOTHSRCALPHA: 12,
    BOTHINVSRCALPHA: 13,
    BLENDFACTOR: 14,
    INVBLENDFACTOR: 15,
});

export const D3DBLENDOP = Object.freeze({
    ADD: 1,
    SUBTRACT: 2,
    REVSUBTRACT: 3,
    MIN: 4,
    MAX: 5,
});

export const D3DCMP = Object.freeze({
    NEVER: 1,
    LESS: 2,
    EQUAL: 3,
    LESSEQUAL: 4,
    GREATER: 5,
    NOTEQUAL: 6,
    GREATEREQUAL: 7,
    ALWAYS: 8,
});

export const D3DSTENCILOP = Object.freeze({
    KEEP: 1,
    ZERO: 2,
    REPLACE: 3,
    INCRSAT: 4,
    DECRSAT: 5,
    INVERT: 6,
    INCR: 7,
    DECR: 8,
});

export const D3DVBF = Object.freeze({
    DISABLE: 0,
    '1WEIGHTS': 1,
    '2WEIGHTS': 2,
    '3WEIGHTS': 3,
    TWEENING: 255,
    '0WEIGHTS': 256,
});

export const D3DPOOL = Object.freeze({ DEFAULT: 0, MANAGED: 1, SYSTEMMEM: 2, SCRATCH: 3 });

export const D3DUSAGE = Object.freeze({
    RENDERTARGET: 0x00000001,
    DEPTHSTENCIL: 0x00000002,
    WRITEONLY: 0x00000008,
    DYNAMIC: 0x00000200,
});

/** OVERLAY and FLIPEX exist only in the Ex API; plain d3d9 rejects them. */
export const D3DSWAPEFFECT = Object.freeze({
    DISCARD: 1,
    FLIP: 2,
    COPY: 3,
    OVERLAY: 4,
    FLIPEX: 5,
});

export const D3DRTYPE = Object.freeze({
    SURFACE: 1,
    VOLUME: 2,
    TEXTURE: 3,
    VOLUMETEXTURE: 4,
    CUBETEXTURE: 5,
    VERTEXBUFFER: 6,
    INDEXBUFFER: 7,
});

export const D3DCUBEMAP_FACE = Object.freeze({
    POSITIVE_X: 0,
    NEGATIVE_X: 1,
    POSITIVE_Y: 2,
    NEGATIVE_Y: 3,
    POSITIVE_Z: 4,
    NEGATIVE_Z: 5,
});

export const D3DFMT = Object.freeze({
    UNKNOWN: 0,
    A8R8G8B8: 21,
    X8R8G8B8: 22,
    R5G6B5: 23,
    X1R5G5B5: 24,
    A1R5G5B5: 25,
    A8: 28,
    A2R10G10B10: 35,
    D32: 71,
    D24S8: 75,
    D24X8: 77,
    D16: 80,
});

/**
 * Bytes per pixel of the uncompressed formats this layer lays out, and whether
 * a format is a depth one -- the validity tables branch on that and on nothing
 * else about a format.
 *
 * Block-compressed formats are deliberately absent: their lock arithmetic
 * counts blocks rather than pixels, and nothing here does that yet.
 *
 * @type {Readonly<Record<number, { bytesPerPixel: number, depth: boolean }>>}
 */
export const FORMAT_INFO = Object.freeze({
    [D3DFMT.A8R8G8B8]: Object.freeze({ bytesPerPixel: 4, depth: false }),
    [D3DFMT.X8R8G8B8]: Object.freeze({ bytesPerPixel: 4, depth: false }),
    [D3DFMT.A2R10G10B10]: Object.freeze({ bytesPerPixel: 4, depth: false }),
    [D3DFMT.R5G6B5]: Object.freeze({ bytesPerPixel: 2, depth: false }),
    [D3DFMT.X1R5G5B5]: Object.freeze({ bytesPerPixel: 2, depth: false }),
    [D3DFMT.A1R5G5B5]: Object.freeze({ bytesPerPixel: 2, depth: false }),
    [D3DFMT.A8]: Object.freeze({ bytesPerPixel: 1, depth: false }),
    [D3DFMT.D32]: Object.freeze({ bytesPerPixel: 4, depth: true }),
    [D3DFMT.D24S8]: Object.freeze({ bytesPerPixel: 4, depth: true }),
    [D3DFMT.D24X8]: Object.freeze({ bytesPerPixel: 4, depth: true }),
    [D3DFMT.D16]: Object.freeze({ bytesPerPixel: 2, depth: true }),
});

const reinterpret = new DataView(new ArrayBuffer(4));

/**
 * @param {number} value
 * @returns {number} the DWORD a float render state is stored as
 */
export function floatToDword(value){
    reinterpret.setFloat32(0, value, true);
    return reinterpret.getUint32(0, true);
}

/**
 * @param {number} value
 * @returns {number} the float a render-state DWORD stands for
 */
export function dwordToFloat(value){
    reinterpret.setUint32(0, value >>> 0, true);
    return reinterpret.getFloat32(0, true);
}
