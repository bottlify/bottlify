/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
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
