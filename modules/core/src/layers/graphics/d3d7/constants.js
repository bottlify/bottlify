/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D 7 numbers, and the record of which of them D3D8 kept.
 *
 * Direct3D 7 and 8 number their render states, texture stage states, primitive
 * types, clear flags and vertex formats identically where both have them, so
 * those are re-exported from `../d3d8` rather than restated; a second copy of
 * a table drifts from the first. What is written here is D3D7's own: the
 * render states D3D8 dropped, the transform numbering (D3D7 counts world
 * matrices from one, D3D8 from 256), the device identifiers a program picks a
 * device by, and the result codes with no D3D8 counterpart.
 */

import { D3DRS as D3DRS8, D3DTS as D3DTS8 } from '../d3d8/constants.js';

export {
    D3DBLEND, D3DBLENDOP, D3DCLEAR, D3DCMP, D3DCULL, D3DFILL, D3DFMT, D3DFOG, D3DLIGHTTYPE,
    D3DPT, D3DSHADE, D3DSTENCILOP, D3DTA, D3DTOP, D3DZB, D3D_OK, dwordToFloat, floatToDword,
} from '../d3d8/constants.js';

/**
 * MAKE_DDHRESULT, as DirectDraw's own codes are minted: Direct3D 7's live in
 * the same facility.
 *
 * @param {number} code
 * @returns {number}
 */
function dderr(code){
    return ((0x88760000 | code) & 0xffffffff) >>> 0;
}

export const DDERR_INVALIDPARAMS = 0x80070057;
export const DDERR_INVALIDCAPS = dderr(100);
export const DDERR_INVALIDOBJECT = dderr(130);
export const DDERR_NOTFOUND = dderr(255);
export const DDERR_UNSUPPORTED = 0x80004001;
export const D3DERR_SURFACENOTINVIDMEM = dderr(747);
export const D3DERR_INVALIDPRIMITIVETYPE = dderr(736);
export const D3DERR_SCENE_IN_SCENE = dderr(760);
export const D3DERR_SCENE_NOT_IN_SCENE = dderr(761);
export const D3DERR_INVALIDVERTEXFORMAT = dderr(2048);
export const D3DERR_VERTEXBUFFEROPTIMIZED = dderr(2060);
export const D3DERR_VERTEXBUFFERLOCKED = dderr(2062);
export const D3DERR_ZBUFFER_NOTPRESENT = dderr(2070);
export const D3DERR_STENCILBUFFER_NOTPRESENT = dderr(2071);
export const D3DERR_INVALIDMATRIX = dderr(2084);
export const D3DERR_INVALIDSTATEBLOCK = dderr(2100);
export const D3DERR_INBEGINSTATEBLOCK = dderr(2101);
export const D3DERR_NOTINBEGINSTATEBLOCK = dderr(2102);

/**
 * The render states D3D8 dropped, under D3D7's own names. Every one is a
 * state a program can set and read back; none of them changes what the
 * renderer draws.
 */
export const D3DRENDERSTATE_D3D7_ONLY = Object.freeze({
    TEXTUREHANDLE: 1,
    ANTIALIAS: 2,
    TEXTUREADDRESS: 3,
    TEXTUREPERSPECTIVE: 4,
    WRAPU: 5,
    WRAPV: 6,
    LINEPATTERN: 10,
    MONOENABLE: 11,
    ROP2: 12,
    PLANEMASK: 13,
    TEXTUREMAG: 17,
    TEXTUREMIN: 18,
    TEXTUREMAPBLEND: 21,
    ZVISIBLE: 30,
    SUBPIXEL: 31,
    SUBPIXELX: 32,
    STIPPLEDALPHA: 33,
    STIPPLEENABLE: 39,
    EDGEANTIALIAS: 40,
    COLORKEYENABLE: 41,
    BORDERCOLOR: 43,
    TEXTUREADDRESSU: 44,
    TEXTUREADDRESSV: 45,
    MIPMAPLODBIAS: 46,
    ZBIAS: 47,
    ANISOTROPY: 49,
    FLUSHBATCH: 50,
    TRANSLUCENTSORTINDEPENDENT: 51,
    EXTENTS: 138,
    COLORKEYBLENDENABLE: 144,
    ...Object.fromEntries(Array.from({ length: 32 },
        (_, index)=>[`STIPPLEPATTERN${String(index).padStart(2, '0')}`, 64 + index])),
});

/**
 * The highest render state D3D7 knows. Everything D3D8 numbered above it was
 * added afterwards and is not a state here.
 */
export const D3DRENDERSTATE_MAX = 152;

/** @type {Readonly<Record<string, number>>} */
export const D3DRENDERSTATE = Object.freeze({
    ...Object.fromEntries(Object.entries(D3DRS8).filter(([, state])=>state <= D3DRENDERSTATE_MAX)),
    ...D3DRENDERSTATE_D3D7_ONLY,
});

/**
 * D3DTRANSFORMSTATETYPE, which D3D8 renumbered: the world matrix is one here
 * and 256 there, and the three extra world matrices follow it directly.
 */
export const D3DTRANSFORMSTATE = Object.freeze({
    WORLD: 1,
    VIEW: 2,
    PROJECTION: 3,
    WORLD1: 4,
    WORLD2: 5,
    WORLD3: 6,
    TEXTURE0: 16,
    TEXTURE7: 23,
});

/**
 * The D3D8 transform number a D3D7 one stands for, which is what the shared
 * renderer reads. Null for a number that is not a transform.
 *
 * @param {number} type
 * @returns {number | null}
 */
export function transformStateOf(type){
    switch (type)
    {
        case D3DTRANSFORMSTATE.WORLD:
            return D3DTS8.WORLD;
        case D3DTRANSFORMSTATE.WORLD1:
        case D3DTRANSFORMSTATE.WORLD2:
        case D3DTRANSFORMSTATE.WORLD3:
            return D3DTS8.WORLD + (type - D3DTRANSFORMSTATE.WORLD1 + 1);
        case D3DTRANSFORMSTATE.VIEW:
        case D3DTRANSFORMSTATE.PROJECTION:
            return type;
        default:
            return type >= D3DTRANSFORMSTATE.TEXTURE0 && type <= D3DTRANSFORMSTATE.TEXTURE7
                ? type
                : null;
    }
}

/** The highest texture stage state D3D7 knows: TEXTURETRANSFORMFLAGS. */
export const D3DTSS_MAX = 24;

/** D3DDP_* draw flags. Both are hints this layer does not need. */
export const D3DDP_WAIT = 0x00000001;
export const D3DDP_DONOTCLIP = 0x00000004;

/** D3DVBCAPS. */
export const D3DVBCAPS_SYSTEMMEMORY = 0x00000800;
export const D3DVBCAPS_WRITEONLY = 0x00010000;
export const D3DVBCAPS_OPTIMIZED = 0x80000000;
export const D3DVBCAPS_DONOTCLIP = 0x00000001;

/** The lock flags a vertex buffer takes, which are DirectDraw's. */
export const DDLOCK_READONLY = 0x00000010;
export const DDLOCK_WRITEONLY = 0x00000020;
export const DDLOCK_NOOVERWRITE = 0x00001000;
export const DDLOCK_DISCARDCONTENTS = 0x00002000;

/** D3DSTATEBLOCKTYPE. */
export const D3DSBT = Object.freeze({ ALL: 1, PIXELSTATE: 2, VERTEXSTATE: 3 });

/**
 * DDBD_*, the bit-depth bits a device description reports its render and
 * depth surfaces in. Recalled rather than read from a header.
 */
export const DDBD_8 = 0x00000800;
export const DDBD_16 = 0x00000400;
export const DDBD_24 = 0x00000200;
export const DDBD_32 = 0x00000100;

/** D3DFVFCAPS: the low nibble is how many texture coordinate sets a draw may carry. */
export const D3DFVFCAPS_TEXCOORDCOUNTMASK = 0x0000ffff;

/**
 * D3DTEXOPCAPS: one bit per D3DTOP, bit zero for DISABLE. The mapping is
 * the header's rule (bit n-1 for operation n); the rule is recalled, the
 * operations it is applied to are the ones the shader generator implements.
 *
 * @param {readonly number[]} operations D3DTOP values
 * @returns {number}
 */
export function textureOpCaps(operations){
    return operations.reduce((bits, op)=>(bits | (1 << (op - 1))) >>> 0, 0);
}

/** D3DPMISCCAPS. */
export const D3DPMISCCAPS_CULLNONE = 0x00000010;
export const D3DPMISCCAPS_CULLCW = 0x00000020;
export const D3DPMISCCAPS_CULLCCW = 0x00000040;

/** D3DPRASTERCAPS. */
export const D3DPRASTERCAPS_ZTEST = 0x00000010;
export const D3DPRASTERCAPS_FOGRANGE = 0x00010000;

/** D3DPSHADECAPS. */
export const D3DPSHADECAPS_COLORGOURAUDRGB = 0x00000008;
export const D3DPSHADECAPS_ALPHAGOURAUDBLEND = 0x00004000;

/** D3DPTEXTURECAPS. */
export const D3DPTEXTURECAPS_PERSPECTIVE = 0x00000001;
export const D3DPTEXTURECAPS_ALPHA = 0x00000004;

/** D3DPTFILTERCAPS. */
export const D3DPTFILTERCAPS_NEAREST = 0x00000001;
export const D3DPTFILTERCAPS_LINEAR = 0x00000002;
export const D3DPTFILTERCAPS_MINFPOINT = 0x00000100;
export const D3DPTFILTERCAPS_MINFLINEAR = 0x00000200;
export const D3DPTFILTERCAPS_MIPFPOINT = 0x00010000;
export const D3DPTFILTERCAPS_MIPFLINEAR = 0x00020000;
export const D3DPTFILTERCAPS_MAGFPOINT = 0x01000000;
export const D3DPTFILTERCAPS_MAGFLINEAR = 0x02000000;

/** D3DPTBLENDCAPS, the legacy single-stage blends. */
export const D3DPTBLENDCAPS_DECAL = 0x00000001;
export const D3DPTBLENDCAPS_MODULATE = 0x00000002;
export const D3DPTBLENDCAPS_DECALALPHA = 0x00000004;
export const D3DPTBLENDCAPS_MODULATEALPHA = 0x00000008;
export const D3DPTBLENDCAPS_COPY = 0x00000040;
export const D3DPTBLENDCAPS_ADD = 0x00000080;

/** D3DPTADDRESSCAPS. */
export const D3DPTADDRESSCAPS_WRAP = 0x00000001;
export const D3DPTADDRESSCAPS_MIRROR = 0x00000002;
export const D3DPTADDRESSCAPS_CLAMP = 0x00000004;
export const D3DPTADDRESSCAPS_INDEPENDENTUV = 0x00000010;

/** D3DPBLENDCAPS: one bit per D3DBLEND, bit zero for ZERO. */
export const D3DPBLENDCAPS_ALL_BUT_BOTH = 0x000007ff;

/** D3DPCMPCAPS: one bit per D3DCMP, bit zero for NEVER. */
export const D3DPCMPCAPS_ALL = 0x000000ff;

/** D3DDEVCAPS bits this build reports. */
export const D3DDEVCAPS_FLOATTLVERTEX = 0x00000001;
export const D3DDEVCAPS_EXECUTESYSTEMMEMORY = 0x00000010;
export const D3DDEVCAPS_EXECUTEVIDEOMEMORY = 0x00000020;
export const D3DDEVCAPS_TLVERTEXSYSTEMMEMORY = 0x00000040;
export const D3DDEVCAPS_TLVERTEXVIDEOMEMORY = 0x00000080;
export const D3DDEVCAPS_TEXTURESYSTEMMEMORY = 0x00000100;
export const D3DDEVCAPS_TEXTUREVIDEOMEMORY = 0x00000200;
export const D3DDEVCAPS_DRAWPRIMTLVERTEX = 0x00000400;
export const D3DDEVCAPS_CANRENDERAFTERFLIP = 0x00000800;
export const D3DDEVCAPS_TEXTURENONLOCALVIDMEM = 0x00001000;
export const D3DDEVCAPS_DRAWPRIMITIVES2 = 0x00002000;
export const D3DDEVCAPS_DRAWPRIMITIVES2EX = 0x00008000;
export const D3DDEVCAPS_HWTRANSFORMANDLIGHT = 0x00010000;
export const D3DDEVCAPS_HWRASTERIZATION = 0x00080000;

/**
 * The devices a program can ask for by identifier. Three are offered and
 * two exist in the header only to be refused: no reference rasteriser and
 * no null device ship with this build.
 */
export const DEVICE_IDS = Object.freeze({
    RGB: '{A4665C60-2673-11CF-A31A-00AA00B93356}',
    HAL: '{84E63DE0-46AA-11CF-816F-0000C020156E}',
    TNLHAL: '{F5049E78-4861-11D2-A407-00A0C90629A8}',
    REF: '{50936643-13E9-11D1-89AA-00A0C9054129}',
    NULL: '{8767DF22-BACC-11D1-8969-00A0C90629B8}',
    RAMP: '{F2086B20-259F-11CF-A31A-00AA00B93356}',
    MMX: '{881949A1-D6F3-11D0-89AB-00A0C9054129}',
});

// --- the versions before 7 (d3d.h, d3dtypes.h, d3dcaps.h) ---

export const DDERR_ALREADYINITIALIZED = dderr(5);
export const D3DERR_INVALIDCURRENTVIEWPORT = dderr(735);
export const D3DERR_INVALIDVERTEXTYPE = dderr(737);
export const D3DERR_LIGHTHASVIEWPORT = dderr(751);
export const D3DERR_LIGHTNOTINTHISVIEWPORT = dderr(752);
export const D3DERR_INBEGIN = dderr(770);
export const D3DERR_NOTINBEGIN = dderr(771);
export const D3DERR_VIEWPORTDATANOTSET = dderr(773);
export const D3DERR_VIEWPORTHASNODEVICE = dderr(774);
export const D3DERR_NOCURRENTVIEWPORT = dderr(775);
export const D3DERR_EXECUTE_LOCKED = dderr(714);
export const D3DERR_EXECUTE_NOT_LOCKED = dderr(715);
export const D3DERR_MATRIX_DESTROY_FAILED = dderr(731);
export const D3DERR_MATRIX_GETDATA_FAILED = dderr(733);
export const D3DERR_MATRIX_SETDATA_FAILED = dderr(732);

/** D3DLIGHTSTATETYPE: the lighting state DirectX 3 to 6 keep apart from the render states. */
export const D3DLIGHTSTATE = Object.freeze({
    MATERIAL: 1,
    AMBIENT: 2,
    COLORMODEL: 3,
    FOGMODE: 4,
    FOGSTART: 5,
    FOGEND: 6,
    FOGDENSITY: 7,
    COLORVERTEX: 8,
});

/** D3DCOLORMODEL. */
export const D3DCOLOR_MONO = 1;
export const D3DCOLOR_RGB = 2;

/** D3DLIGHT2.dwFlags. */
export const D3DLIGHT_ACTIVE = 0x00000001;
export const D3DLIGHT_NO_SPECULAR = 0x00000002;

/** D3DLIGHTTYPE, with the two kinds Direct3D 7 dropped. */
export const D3DLIGHT_PARALLELPOINT = 4;
export const D3DLIGHT_GLSPOT = 5;

/** NextViewport and NextLight: where in the list to go. */
export const D3DNEXT_NEXT = 0x01;
export const D3DNEXT_HEAD = 0x02;
export const D3DNEXT_TAIL = 0x04;

/** DrawPrimitive flags the versions before 7 read. */
export const D3DDP_DONOTUPDATEEXTENTS = 0x00000008;
export const D3DDP_DONOTLIGHT = 0x00000010;

/** D3DTEXTUREBLEND: the one render state a DirectX 5 program blends a texture by. */
export const D3DTBLEND = Object.freeze({
    DECAL: 1,
    MODULATE: 2,
    DECALALPHA: 3,
    MODULATEALPHA: 4,
    DECALMASK: 5,
    MODULATEMASK: 6,
    COPY: 7,
    ADD: 8,
});

/** D3DTEXTUREFILTER, as TEXTUREMAG and TEXTUREMIN take it. */
export const D3DFILTER = Object.freeze({
    NEAREST: 1,
    LINEAR: 2,
    MIPNEAREST: 3,
    MIPLINEAR: 4,
    LINEARMIPNEAREST: 5,
    LINEARMIPLINEAR: 6,
});

/** D3DVERTEXTYPE, and the vertex formats they are. */
export const D3DVT = Object.freeze({ VERTEX: 1, LVERTEX: 2, TLVERTEX: 3 });
export const D3DFVF_RESERVED1 = 0x020;
export const D3DFVF_VERTEX = 0x002 | 0x010 | 0x100;
export const D3DFVF_LVERTEX = 0x002 | D3DFVF_RESERVED1 | 0x040 | 0x080 | 0x100;
export const D3DFVF_TLVERTEX = 0x004 | 0x040 | 0x080 | 0x100;

/** D3DFINDDEVICESEARCH.dwFlags that name a device rather than a capability. */
export const D3DFDS_GUID = 0x00000002;
export const D3DFDS_HARDWARE = 0x00000004;

/** D3DDEVICEDESC.dwFlags: which of its fields hold something. */
export const D3DDD = Object.freeze({
    COLORMODEL: 0x001,
    DEVCAPS: 0x002,
    TRANSFORMCAPS: 0x004,
    LIGHTINGCAPS: 0x008,
    BCLIPPING: 0x010,
    LINECAPS: 0x020,
    TRICAPS: 0x040,
    DEVICERENDERBITDEPTH: 0x080,
    DEVICEZBUFFERBITDEPTH: 0x100,
    MAXBUFFERSIZE: 0x200,
    MAXVERTEXCOUNT: 0x400,
});
export const D3DTRANSFORMCAPS_CLIP = 0x00000001;
export const D3DLIGHTINGMODEL_RGB = 0x00000001;
export const D3DLIGHTCAPS_POINT = 0x00000001;
export const D3DLIGHTCAPS_SPOT = 0x00000002;
export const D3DLIGHTCAPS_DIRECTIONAL = 0x00000004;
export const D3DLIGHTCAPS_PARALLELPOINT = 0x00000008;

/** Every texture must be a power of two on a side, which the software device says. */
export const D3DPTEXTURECAPS_POW2 = 0x00000002;

/** D3DOPCODE: the instructions of an execute buffer. */
export const D3DOP = Object.freeze({
    POINT: 1,
    LINE: 2,
    TRIANGLE: 3,
    MATRIXLOAD: 4,
    MATRIXMULTIPLY: 5,
    STATETRANSFORM: 6,
    STATELIGHT: 7,
    STATERENDER: 8,
    PROCESSVERTICES: 9,
    TEXTURELOAD: 10,
    EXIT: 11,
    BRANCHFORWARD: 12,
    SPAN: 13,
    SETSTATUS: 14,
});

/** D3DPROCESSVERTICES.dwFlags. */
export const D3DPROCESSVERTICES = Object.freeze({
    TRANSFORMLIGHT: 0x0,
    TRANSFORM: 0x1,
    COPY: 0x2,
    OPMASK: 0x7,
    UPDATEEXTENTS: 0x8,
    NOCOLOR: 0x10,
});

/** D3DEXECUTEBUFFERDESC.dwFlags and dwCaps. */
export const D3DDEB_BUFSIZE = 0x00000001;
export const D3DDEB_CAPS = 0x00000002;
export const D3DDEB_LPDATA = 0x00000004;
export const D3DDEBCAPS_SYSTEMMEMORY = 0x00000001;
export const D3DDEBCAPS_VIDEOMEMORY = 0x00000002;
