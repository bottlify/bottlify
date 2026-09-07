/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D 8 numbers, and -- just as important -- the record of which of
 * them D3D8 shares with D3D9.
 *
 * Almost everything an application compiles against is the same bit pattern in
 * both versions, so the shared halves are re-exported from `../d3d9` rather
 * than written out again. A second copy of a table drifts from the first, and
 * then one of them is wrong with nothing to say which.
 *
 * What is genuinely D3D8's own is written here:
 *
 * - six render states D3D9 dropped, and the boundary above which every state
 *   number belongs to D3D9 alone;
 * - two states that kept their numbers and changed their names;
 * - a fourth swap effect;
 * - shader handles, which in this version are DWORDs rather than objects and
 *   share their number space with FVF codes.
 */

import { D3DRS as D3DRS9 } from '../d3d9/constants.js';

export {
    D3D_OK, D3DERR_DEVICELOST, D3DERR_DEVICENOTRESET, D3DERR_INVALIDCALL, D3DERR_NOTAVAILABLE,
    D3DERR_NOTFOUND, D3DBLEND, D3DBLENDOP, D3DCMP, D3DCUBEMAP_FACE, D3DCULL, D3DDMT, D3DFILL,
    D3DFMT, D3DFOG, D3DLIGHTTYPE, D3DMCS, D3DPATCHEDGE, D3DPOOL, D3DRTYPE, D3DSHADE, D3DSTENCILOP,
    D3DUSAGE, D3DVBF, D3DZB, FORMAT_INFO, dwordToFloat, floatToDword,
} from '../d3d9/constants.js';

/**
 * D3DORDERTYPE. The same four values D3D9 publishes as D3DDEGREE, under the
 * name the D3D8 header gives them.
 */
export { D3DDEGREE as D3DORDER } from '../d3d9/constants.js';

/**
 * The highest render state D3D8 knows. Every D3D9 state at or below it exists
 * in D3D8 too, and every state above it was added afterwards, which is what
 * makes a single comparison enough to split the two sets.
 */
export const D3DRS_MAX = 173;

/**
 * The six states D3D8 has and D3D9 does not. Five are fixed-function controls
 * D3D9 replaced or dropped outright; SOFTWAREVERTEXPROCESSING is a switch D3D9
 * moved onto the device itself.
 */
export const D3DRS_REMOVED_IN_D3D9 = Object.freeze({
    LINEPATTERN: 10,
    ZVISIBLE: 30,
    EDGEANTIALIAS: 40,
    ZBIAS: 47,
    SOFTWAREVERTEXPROCESSING: 153,
    PATCHSEGMENTS: 164,
});

/**
 * The two states whose number D3D9 kept and whose name it changed. Listed
 * separately because a reader checking one against the D3D8 header will not
 * find the D3D9 spelling there at all.
 */
export const D3DRS_RENAMED_IN_D3D9 = Object.freeze({
    POSITIONORDER: 172,
    NORMALORDER: 173,
});

/** The D3D9 spellings of the two renamed states, so the filter can drop them. */
const D3D9_NAMES_OF_RENAMED = ['POSITIONDEGREE', 'NORMALDEGREE'];

/** @type {Readonly<Record<string, number>>} */
export const D3DRS = Object.freeze({
    ...Object.fromEntries(Object.entries(D3DRS9).filter(([name, state])=>
        state <= D3DRS_MAX && !D3D9_NAMES_OF_RENAMED.includes(name))),
    ...D3DRS_REMOVED_IN_D3D9,
    ...D3DRS_RENAMED_IN_D3D9,
});

/**
 * D3DSWAPEFFECT. COPY_VSYNC is D3D8's alone: D3D9 dropped it and later reused
 * the value 4 for the Ex-only OVERLAY, so the two enumerations agree on their
 * first three members and on nothing after them.
 */
export const D3DSWAPEFFECT = Object.freeze({
    DISCARD: 1,
    FLIP: 2,
    COPY: 3,
    COPY_VSYNC: 4,
});

/**
 * D3DDEVTYPE. What a program asked CreateDevice for, and what the device
 * reports back as its own kind -- the two are the same number, because a
 * device that answered with a different kind than it was asked for would be a
 * device the program never created.
 */
export const D3DDEVTYPE = Object.freeze({
    HAL: 1,
    REF: 2,
    SW: 3,
});

/**
 * D3DSTATEBLOCKTYPE, which is what a state block made in one call rather than
 * recorded holds: the pixel half, the vertex half, or everything.
 */
export const D3DSBT = Object.freeze({
    ALL: 1,
    PIXELSTATE: 2,
    VERTEXSTATE: 3,
});

/** The behaviour flags CreateDevice takes. Only vertex processing matters here. */
export const D3DCREATE = Object.freeze({
    FPU_PRESERVE: 0x00000002,
    MULTITHREADED: 0x00000004,
    PUREDEVICE: 0x00000010,
    SOFTWARE_VERTEXPROCESSING: 0x00000020,
    HARDWARE_VERTEXPROCESSING: 0x00000040,
    MIXED_VERTEXPROCESSING: 0x00000080,
});

/**
 * D3DFVF_RESERVED0. No legal flexible vertex format sets it, which is what
 * lets one DWORD carry either an FVF code or a shader handle -- see
 * `isShaderHandle`.
 */
export const D3DFVF_RESERVED0 = 0x0001;

/**
 * Whether a DWORD passed to SetVertexShader names a created shader rather than
 * a vertex format.
 *
 * The discrimination has to be structural, because both arrive through one
 * parameter and a program never says which it meant. Handing out handles with
 * D3DFVF_RESERVED0 set is our choice of encoding; that a legal FVF never has
 * that bit is the fact the choice rests on. Zero is neither: it clears the
 * binding.
 *
 * @param {number} handle
 * @returns {boolean}
 */
export function isShaderHandle(handle){
    return handle !== 0 && (handle & D3DFVF_RESERVED0) !== 0;
}

/** D3DPRIMITIVETYPE. */
export const D3DPT = Object.freeze({
    POINTLIST: 1,
    LINELIST: 2,
    LINESTRIP: 3,
    TRIANGLELIST: 4,
    TRIANGLESTRIP: 5,
    TRIANGLEFAN: 6,
});

/** D3DCLEAR flags. */
export const D3DCLEAR = Object.freeze({
    TARGET: 0x1,
    ZBUFFER: 0x2,
    STENCIL: 0x4,
});

/** D3DLOCK flags, the ones a buffer lock's meaning depends on. */
export const D3DLOCK = Object.freeze({
    READONLY: 0x00000010,
    NOSYSLOCK: 0x00000800,
    NOOVERWRITE: 0x00001000,
    DISCARD: 0x00002000,
});

/**
 * The two index formats. Not in D3DFMT because that table is D3D9's and is
 * frozen; the numbers are the same in both versions.
 */
export const D3DFMT_INDEX = Object.freeze({
    INDEX16: 101,
    INDEX32: 102,
});

/**
 * D3DTRANSFORMSTATETYPE. A world matrix is numbered from 256 upward:
 * D3DTS_WORLD is D3DTS_WORLDMATRIX(0), and 255 more follow it.
 */
export const D3DTS = Object.freeze({
    VIEW: 2,
    PROJECTION: 3,
    TEXTURE0: 16,
    TEXTURE7: 23,
    WORLD: 256,
    WORLD_LAST: 511,
});

/**
 * D3DTEXTURESTAGESTATETYPE. In this version a stage carries its sampler with
 * it: the address modes and filters D3D9 moved to a separate sampler-state
 * table are stage states here, which is why they are numbered among the rest.
 */
export const D3DTSS = Object.freeze({
    COLOROP: 1,
    COLORARG1: 2,
    COLORARG2: 3,
    ALPHAOP: 4,
    ALPHAARG1: 5,
    ALPHAARG2: 6,
    BUMPENVMAT00: 7,
    BUMPENVMAT01: 8,
    BUMPENVMAT10: 9,
    BUMPENVMAT11: 10,
    TEXCOORDINDEX: 11,
    ADDRESSU: 13,
    ADDRESSV: 14,
    BORDERCOLOR: 15,
    MAGFILTER: 16,
    MINFILTER: 17,
    MIPFILTER: 18,
    MIPMAPLODBIAS: 19,
    MAXMIPLEVEL: 20,
    MAXANISOTROPY: 21,
    BUMPENVLSCALE: 22,
    BUMPENVLOFFSET: 23,
    TEXTURETRANSFORMFLAGS: 24,
    ADDRESSW: 25,
    COLORARG0: 26,
    ALPHAARG0: 27,
    RESULTARG: 28,
});

/** D3DTEXTUREFILTERTYPE. */
export const D3DTEXF = Object.freeze({
    NONE: 0,
    POINT: 1,
    LINEAR: 2,
    ANISOTROPIC: 3,
});

/** D3DTEXTUREADDRESS. */
export const D3DTADDRESS = Object.freeze({
    WRAP: 1,
    MIRROR: 2,
    CLAMP: 3,
    BORDER: 4,
    MIRRORONCE: 5,
});

/** The stage cascade's operations and argument selectors, shared with the shader generator. */
export { D3DTA, D3DTOP } from '../webgpu/internal/fixedfunction.js';
