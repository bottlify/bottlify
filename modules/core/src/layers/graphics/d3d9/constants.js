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
/** A success: the format is available, and a texture made in it gets no generated levels. */
export const D3DOK_NOAUTOGEN = 0x0876086f;
/** Direct3D 9Ex's answer for a device whose adapter is gone. */
export const D3DERR_DEVICEREMOVED = 0x88760870;

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
    AUTOGENMIPMAP: 0x00000400,
    RESTRICTED_CONTENT: 0x00000800,
    RESTRICT_SHARED_RESOURCE_DRIVER: 0x00001000,
    RESTRICT_SHARED_RESOURCE: 0x00002000,
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
    A4R4G4B4: 26,
    A8: 28,
    X4R4G4B4: 30,
    // The luminance formats. A program of this era keeps its interface and its
    // fonts in one of these: four bits of alpha is what a soft edge needs, and
    // eight bits of colour is more than a glyph does.
    L8: 50,
    A8L8: 51,
    A4L4: 52,
    A2R10G10B10: 35,
    // Signed bump-map offsets, which a pixel shader's texbem and the
    // fixed-function BUMPENVMAP read as -1..1.
    V8U8: 60,
    Q8W8V8U8: 63,
    D32: 71,
    D24S8: 75,
    D24X8: 77,
    D16: 80,
    // The block-compressed formats are named by four character codes rather
    // than by a number in the enumeration, because they arrived as an
    // extension. Every card of this era carried them, so a program that keeps
    // its art compressed -- which is most of them, since it is four to eight
    // times less memory -- expects to find them and has a slower path it falls
    // back to when it does not.
    DXT1: 0x31545844,
    DXT2: 0x32545844,
    DXT3: 0x33545844,
    DXT4: 0x34545844,
    DXT5: 0x35545844,
    // Packed 4:2:2 video, two pixels to four bytes.
    YUY2: 0x32595559,
    UYVY: 0x59565955,
});

/**
 * Bytes per pixel of the uncompressed formats this layer lays out, and whether
 * a format is a depth one -- the validity tables branch on that and on nothing
 * else about a format.
 *
 * Block-compressed formats are deliberately absent: their lock arithmetic
 * counts blocks rather than pixels, and nothing here does that yet.
 *
 * `alpha` says whether the format has an alpha channel at all. A format whose
 * name begins with X does not, and Direct3D says what lies in those bits is
 * undefined and never read -- so a target of one must never be written with an
 * alpha, whatever the surface it is really rendered into happens to carry.
 *
 * `signed` marks a format whose channels are -1..1: sampled, never drawn into.
 *
 * @type {Readonly<Record<number,
 *     { bytesPerPixel: number, depth: boolean, alpha: boolean,
 *       blockBytes?: number, blockSize?: number, video?: boolean, signed?: boolean }>>}
 */
export const FORMAT_INFO = Object.freeze({
    [D3DFMT.A8R8G8B8]: Object.freeze({ bytesPerPixel: 4, depth: false, alpha: true }),
    [D3DFMT.X8R8G8B8]: Object.freeze({ bytesPerPixel: 4, depth: false, alpha: false }),
    [D3DFMT.A2R10G10B10]: Object.freeze({ bytesPerPixel: 4, depth: false, alpha: true }),
    [D3DFMT.R5G6B5]: Object.freeze({ bytesPerPixel: 2, depth: false, alpha: false }),
    [D3DFMT.X1R5G5B5]: Object.freeze({ bytesPerPixel: 2, depth: false, alpha: false }),
    [D3DFMT.A1R5G5B5]: Object.freeze({ bytesPerPixel: 2, depth: false, alpha: true }),
    // Four bits an channel, and worth having rather than refusing: a program of
    // this era keeps its interface and its fonts in it, because four bits of
    // alpha is what a soft edge needs and eight bits of colour is more than a
    // glyph does. Refusing it does not degrade the picture, it removes the
    // text.
    [D3DFMT.A4R4G4B4]: Object.freeze({ bytesPerPixel: 2, depth: false, alpha: true }),
    [D3DFMT.X4R4G4B4]: Object.freeze({ bytesPerPixel: 2, depth: false, alpha: false }),
    [D3DFMT.A8]: Object.freeze({ bytesPerPixel: 1, depth: false, alpha: true }),
    // Luminance is replicated into all three colour channels when sampled, so
    // a grey glyph atlas is a grey glyph atlas; alpha is the fourth channel
    // where the format has one. A4L4 packs both into one byte, low nibble
    // luminance first, which is why it is one byte per texel and not two.
    [D3DFMT.L8]: Object.freeze({ bytesPerPixel: 1, depth: false, alpha: false }),
    [D3DFMT.A8L8]: Object.freeze({ bytesPerPixel: 2, depth: false, alpha: true }),
    [D3DFMT.A4L4]: Object.freeze({ bytesPerPixel: 1, depth: false, alpha: true }),
    // U in the low byte, then V (and W and Q): a device that runs ps_1_1
    // samples them, and a program that has one expects its bump map to load.
    [D3DFMT.V8U8]: Object.freeze({ bytesPerPixel: 2, depth: false, alpha: false, signed: true }),
    [D3DFMT.Q8W8V8U8]: Object.freeze({
        bytesPerPixel: 4, depth: false, alpha: true, signed: true }),
    [D3DFMT.D32]: Object.freeze({ bytesPerPixel: 4, depth: true, alpha: false }),
    [D3DFMT.D24S8]: Object.freeze({ bytesPerPixel: 4, depth: true, alpha: false }),
    [D3DFMT.D24X8]: Object.freeze({ bytesPerPixel: 4, depth: true, alpha: false }),
    [D3DFMT.D16]: Object.freeze({ bytesPerPixel: 2, depth: true, alpha: false }),
    // Video the runtime holds and no device samples or draws into: made in the
    // scratch pool, and as a plain surface in system memory, and nowhere else
    // (Wine's test_surface_blocks and test_volume_blocks, in any size).
    [D3DFMT.YUY2]: Object.freeze({ bytesPerPixel: 2, depth: false, alpha: false, video: true }),
    [D3DFMT.UYVY]: Object.freeze({ bytesPerPixel: 2, depth: false, alpha: false, video: true }),
    // A compressed format has no bytes per pixel at all: its unit is a 4x4
    // block, and a size in pixels only becomes a size in bytes after rounding
    // up to whole blocks. `bytesPerPixel` is left at zero deliberately -- any
    // arithmetic that still reaches for it gives a zero-length surface, which
    // fails loudly, rather than a plausible wrong answer.
    [D3DFMT.DXT1]: Object.freeze({
        bytesPerPixel: 0, depth: false, alpha: true, blockBytes: 8, blockSize: 4 }),
    // DXT2 and DXT4 differ from DXT3 and DXT5 only in whether the colour is
    // premultiplied by the alpha, which the block layout does not record and
    // the sampler cannot tell apart. The bytes are identical.
    [D3DFMT.DXT2]: Object.freeze({
        bytesPerPixel: 0, depth: false, alpha: true, blockBytes: 16, blockSize: 4 }),
    [D3DFMT.DXT3]: Object.freeze({
        bytesPerPixel: 0, depth: false, alpha: true, blockBytes: 16, blockSize: 4 }),
    [D3DFMT.DXT4]: Object.freeze({
        bytesPerPixel: 0, depth: false, alpha: true, blockBytes: 16, blockSize: 4 }),
    [D3DFMT.DXT5]: Object.freeze({
        bytesPerPixel: 0, depth: false, alpha: true, blockBytes: 16, blockSize: 4 }),
});

/**
 * Where in a locked surface a sub-rectangle begins.
 *
 * A compressed surface can only be addressed by whole blocks, so a rectangle
 * into one is counted in blocks; Direct3D requires such a rectangle to be
 * block-aligned and this rounds down rather than inventing a partial block.
 *
 * @param {number} format  D3DFMT
 * @param {number} pitch   As `surfacePitch` reports it.
 * @param {{ top: number, left: number }} rect
 * @returns {number} bytes from the start of the surface
 */
export function offsetOfRect(format, pitch, rect){
    const info = FORMAT_INFO[format];
    if (!info)
    {
        return 0;
    }
    const { blockBytes, blockSize } = info;
    if (blockBytes === undefined || blockSize === undefined)
    {
        return (rect.top * pitch) + (rect.left * info.bytesPerPixel);
    }
    return (Math.floor(rect.top / blockSize) * pitch)
        + (Math.floor(rect.left / blockSize) * blockBytes);
}

/**
 * @param {number} format  D3DFMT
 * @returns {boolean} whether its unit is a block rather than a pixel
 */
export function isCompressed(format){
    const info = FORMAT_INFO[format];
    return !!info && info.blockBytes !== undefined;
}

/**
 * @param {number} format  D3DFMT
 * @returns {boolean} whether it is packed video the runtime only holds
 */
export function isVideo(format){
    return FORMAT_INFO[format]?.video === true;
}

/**
 * Where a video format may be made: any resource of the scratch pool, and a
 * plain surface of system memory.
 *
 * @param {number} pool @param {boolean} plain
 */
export function videoPoolAllowed(pool, plain){
    return pool === D3DPOOL.SCRATCH || (plain && pool === D3DPOOL.SYSTEMMEM);
}

/**
 * Whether a resource's top level is whole blocks of its format: Direct3D 8
 * and 9 refuse a compressed texture or surface that is not, in every pool
 * (Wine's test_surface_blocks), where the levels below it may be any size.
 *
 * @param {number} format @param {number} width @param {number} height
 */
export function blockAligned(format, width, height){
    return !isCompressed(format) || ((width | height) & 3) === 0;
}

/**
 * The distance in bytes between one row of a surface and the next.
 *
 * For a compressed format that is a row of blocks, not a row of pixels, and it
 * covers four rows of pixels -- which is what Direct3D reports as the pitch of
 * a locked DXT surface, and what a program writing into one relies on.
 *
 * @param {number} format  D3DFMT
 * @param {number} width   In pixels.
 * @returns {number}
 */
export function surfacePitch(format, width){
    const info = FORMAT_INFO[format];
    if (!info)
    {
        return 0;
    }
    const { blockBytes, blockSize } = info;
    if (blockBytes === undefined || blockSize === undefined)
    {
        return width * info.bytesPerPixel;
    }
    return Math.ceil(width / blockSize) * blockBytes;
}

/**
 * The bytes a whole surface level occupies.
 *
 * A compressed level is rounded up to whole blocks in both directions, so a
 * 2x2 DXT1 level still costs one 8-byte block. Sizing it by pixels instead is
 * how a texture ends up short of its last row and samples as garbage there.
 *
 * @param {number} format  D3DFMT
 * @param {number} width   In pixels.
 * @param {number} height  In pixels.
 * @returns {number}
 */
export function surfaceBytes(format, width, height){
    const info = FORMAT_INFO[format];
    if (!info)
    {
        return 0;
    }
    const { blockSize } = info;
    if (blockSize === undefined)
    {
        return width * height * info.bytesPerPixel;
    }
    return surfacePitch(format, width) * Math.ceil(height / blockSize);
}

const reinterpret = new DataView(new ArrayBuffer(4));

/**
 * D3DCOLORWRITEENABLE's alpha bit.
 *
 * A format whose name begins with X has no alpha channel: Direct3D says what
 * lies there is undefined and never read, so a target of one must never be
 * written with an alpha at all. Rendering into a four-channel surface anyway
 * -- which every backend does, because three-channel targets are not a thing
 * -- turns that undefined channel into a real one, and whatever the draws
 * leave in it then decides how opaque the frame is.
 */
export const COLORWRITEENABLE_ALPHA = 8;

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
