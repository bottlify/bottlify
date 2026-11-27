/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D structures a guest call passes by pointer.
 *
 * Each is declared once as its header declares it (`system/layout.js`), its
 * offsets derived: a field read one slot early is a plausible number, and a
 * plausible number is what makes this class of mistake survive into a
 * picture that is merely wrong rather than into a crash.
 *
 * D3DPRESENT_PARAMETERS is the one that matters most and the one that differs
 * between versions. Direct3D 8 has no `Flags` before the refresh rate and no
 * `PresentationInterval` at the end in the place 9 puts them, so the two
 * layouts are declared separately rather than shared -- reading a 9 structure
 * with 8's offsets finds the windowed flag in the depth format's field, which
 * is a boolean that happens to be true.
 */

import { GUID, POINT as POINT_LAYOUT, RECT as RECT_LAYOUT, fieldOf, highOf, struct, union }
    from '../../../system/layout.js';

/** @typedef {import('../../../system/layout.js').Declared} Declared */

/** @param {string[]} names @param {'u32' | 'i32' | 'f32'} kind @returns {Declared[]} */
const all = (names, kind)=>names.map(name=>[name, kind]);

const PRESENT_HEAD = /** @type {const} */ ([['BackBufferWidth', 'u32'],
    ['BackBufferHeight', 'u32'], ['BackBufferFormat', 'u32'], ['BackBufferCount', 'u32'],
    ['MultiSampleType', 'u32']]);
const PRESENT_TAIL = /** @type {const} */ ([['SwapEffect', 'u32'], ['hDeviceWindow', 'handle'],
    ['Windowed', 'i32'], ['EnableAutoDepthStencil', 'i32'], ['AutoDepthStencilFormat', 'u32'],
    ['Flags', 'u32'], ['FullScreen_RefreshRateInHz', 'u32']]);

/** D3DPRESENT_PARAMETERS as Direct3D 8 declares it. */
export const D3DPRESENT_PARAMETERS8 = struct([...PRESENT_HEAD, ...PRESENT_TAIL,
    ['FullScreen_PresentationInterval', 'u32']]).at(4);

/**
 * D3DPRESENT_PARAMETERS as Direct3D 9 declares it.
 *
 * MultiSampleQuality is inserted after MultiSampleType, and the trailing pair
 * is renamed -- windowed presentation gained an interval, so the field is no
 * longer full-screen only. In a 64-bit process hDeviceWindow is a handle,
 * eight bytes on an eight-byte boundary, which moves every field after it.
 */
const PRESENT_PARAMETERS9 = struct([...PRESENT_HEAD, ['MultiSampleQuality', 'u32'],
    ...PRESENT_TAIL, ['PresentationInterval', 'u32']]);
export const D3DPRESENT_PARAMETERS9 = PRESENT_PARAMETERS9.at(4);
export const D3DPRESENT_PARAMETERS9_64 = PRESENT_PARAMETERS9.at(8);

/** D3DDISPLAYMODE. The same in both versions. */
export const D3DDISPLAYMODE = struct(all(['Width', 'Height', 'RefreshRate', 'Format'], 'u32'))
    .at(4);

/** D3DVIEWPORT8. Six dwords, the last two of which are floats. */
export const D3DVIEWPORT8 = struct([...all(['X', 'Y', 'Width', 'Height'], 'u32'),
    ['MinZ', 'f32'], ['MaxZ', 'f32']]).at(4);

/**
 * D3DVIEWPORT7: the same six dwords as D3D8's viewport, under the older
 * names. Declared separately so the name a reader checks against the header
 * is the one they find there.
 */
export const D3DVIEWPORT7 = struct([...all(['dwX', 'dwY', 'dwWidth', 'dwHeight'], 'u32'),
    ['dvMinZ', 'f32'], ['dvMaxZ', 'f32']]).at(4);

/** D3DVERTEXBUFFERDESC. */
export const D3DVERTEXBUFFERDESC = struct(all(['dwSize', 'dwCaps', 'dwFVF', 'dwNumVertices'],
    'u32')).at(4);

/** D3DCLIPSTATUS: two dwords and six floats. */
export const D3DCLIPSTATUS = struct([['dwFlags', 'u32'], ['dwStatus', 'u32'],
    ...all(['minx', 'maxx', 'miny', 'maxy', 'minz', 'maxz'], 'f32')]).at(4);

const COLORVALUE = struct(all(['r', 'g', 'b', 'a'], 'f32'));
const VECTOR = struct(all(['x', 'y', 'z'], 'f32'));

/**
 * D3DLIGHT7: a type, three colours, two vectors and seven floats. The same
 * layout D3D8's light has.
 */
export const D3DLIGHT7 = struct([['dltType', 'u32'], ['dcvDiffuse', COLORVALUE],
    ['dcvSpecular', COLORVALUE], ['dcvAmbient', COLORVALUE], ['dvPosition', VECTOR],
    ['dvDirection', VECTOR], ...all(['dvRange', 'dvFalloff', 'dvAttenuation0', 'dvAttenuation1',
        'dvAttenuation2', 'dvTheta', 'dvPhi'], 'f32')]).at(4);

/** D3DPRIMCAPS, which a device description holds two of. */
const PRIMCAPS = struct(all(['dwSize', 'dwMiscCaps', 'dwRasterCaps', 'dwZCmpCaps',
    'dwSrcBlendCaps', 'dwDestBlendCaps', 'dwAlphaCmpCaps', 'dwShadeCaps', 'dwTextureCaps',
    'dwTextureFilterCaps', 'dwTextureBlendCaps', 'dwTextureAddressCaps', 'dwStippleWidth',
    'dwStippleHeight'], 'u32'));
export const D3DPRIMCAPS = PRIMCAPS.at(4);

/**
 * D3DDEVICEDESC7. No size field of its own: the first dword is the device
 * capabilities. The three WORD pairs are the only fields narrower than a
 * dword, and the GUID is four-byte aligned, so nothing is padded.
 */
export const D3DDEVICEDESC7 = struct([['dwDevCaps', 'u32'], ['dpcLineCaps', PRIMCAPS],
    ['dpcTriCaps', PRIMCAPS], ...all(['dwDeviceRenderBitDepth', 'dwDeviceZBufferBitDepth',
        'dwMinTextureWidth', 'dwMinTextureHeight', 'dwMaxTextureWidth', 'dwMaxTextureHeight',
        'dwMaxTextureRepeat', 'dwMaxTextureAspectRatio', 'dwMaxAnisotropy'], 'u32'),
    ...all(['dvGuardBandLeft', 'dvGuardBandTop', 'dvGuardBandRight', 'dvGuardBandBottom',
        'dvExtentsAdjust'], 'f32'),
    ...all(['dwStencilCaps', 'dwFVFCaps', 'dwTextureOpCaps'], 'u32'),
    ['wMaxTextureBlendStages', 'u16'], ['wMaxSimultaneousTextures', 'u16'],
    ['dwMaxActiveLights', 'u32'], ['dvMaxVertexW', 'f32'], ['deviceGUID', GUID],
    ['wMaxUserClipPlanes', 'u16'], ['wMaxVertexBlendMatrices', 'u16'],
    ['dwVertexProcessingCaps', 'u32'], [null, 'u32', 4]]).at(4);

/** D3DRECT: four longs, and the order is left, top, right, bottom. */
export const D3DRECT = struct(all(['x1', 'y1', 'x2', 'y2'], 'i32')).at(4);

/** POINT, which CopyRects takes an array of. */
export const POINT = POINT_LAYOUT.at(4);

/**
 * D3DLOCKED_RECT, written back by a lock: the row stride first, then the
 * address of the first byte. A caller that reads them the other way round
 * treats a pointer as a pitch and walks off the surface on its second row.
 * In a 64-bit process the address is eight bytes, on an eight-byte boundary.
 */
const LOCKED_RECT = struct([['Pitch', 'i32'], ['pBits', 'ptr']]);
export const D3DLOCKED_RECT = LOCKED_RECT.at(4);
export const D3DLOCKED_RECT64 = LOCKED_RECT.at(8);

/**
 * A rectangle lock -- a surface's, a texture level's, a cube face's -- with
 * its D3DLOCKED_RECT written to `out` once it is taken. A lock of something a
 * GetRenderTargetData is still filling settles only when the pixels are in
 * guest memory, so the answer may be a promise, and the structure is written
 * when it resolves: written only for a plain answer, the caller read a stale
 * pointer and the pixels it asked for never reached it.
 *
 * @param {{ writeStruct: (address: number, layout: any, values: any) => void }} fields
 * @param {number} out
 * @param {(locked: { Pitch?: number, pBits?: number }) => number | Promise<number>} lock
 * @param {Record<string, number>} [layout]  D3DLOCKED_RECT64 for a 64-bit process.
 * @returns {number | Promise<number>}
 */
export function lockRectInto(fields, out, lock, layout = D3DLOCKED_RECT){
    /** @type {{ Pitch?: number, pBits?: number }} */
    const locked = {};
    /** @param {number} hr */
    const answer = hr=>{
        if (hr === 0 && (out >>> 0) !== 0)
        {
            fields.writeStruct(out >>> 0, layout, { Pitch: locked.Pitch ?? 0,
                pBits: locked.pBits ?? 0 });
        }
        return hr;
    };
    const hr = lock(locked);
    return hr instanceof Promise ? hr.then(answer) : answer(hr);
}

const DESC_HEAD = /** @type {const} */ ([['Format', 'u32'], ['Type', 'u32'], ['Usage', 'u32'],
    ['Pool', 'u32'], ['Size', 'u32']]);

/** D3DSURFACE_DESC as Direct3D 8 declares it. */
export const D3DSURFACE_DESC8 = struct([...DESC_HEAD, ['MultiSampleType', 'u32'],
    ['Width', 'u32'], ['Height', 'u32']]).at(4);

/** D3DVOLUME_DESC as Direct3D 8 declares it, with the size Direct3D 9 dropped. */
export const D3DVOLUME_DESC8 = struct([...DESC_HEAD, ['Width', 'u32'], ['Height', 'u32'],
    ['Depth', 'u32']]).at(4);

/**
 * D3DLOCKED_BOX, the same in both versions: two pitches, then the address;
 * in a 64-bit process the address is eight bytes and the end padded to eight.
 */
const LOCKED_BOX = struct([['RowPitch', 'i32'], ['SlicePitch', 'i32'], ['pBits', 'ptr']]);
export const D3DLOCKED_BOX = LOCKED_BOX.at(4);
export const D3DLOCKED_BOX64 = LOCKED_BOX.at(8);

/** D3DBOX, the same in both versions: the rectangle's four edges, then front and back. */
export const D3DBOX = struct(all(['Left', 'Top', 'Right', 'Bottom', 'Front', 'Back'], 'u32'))
    .at(4);

/**
 * D3DCAPS8, every field of it.
 *
 * Declared in full rather than as the handful anyone fills in, because a
 * partial table is where the offsets go wrong: five guard-band floats and an
 * adjustment sit between the texture limits and the blend-stage counts, and a
 * table that skips them puts every later field somewhere else. That is not a
 * missing capability, it is a wrong one -- a maximum texture size written into
 * the repeat limit leaves the real maximum reading as zero, and a program that
 * halves a texture until it fits a maximum of zero halves it for ever.
 */
export const D3DCAPS8 = struct([...all(['DeviceType', 'AdapterOrdinal', 'Caps', 'Caps2', 'Caps3',
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
['MaxPixelShaderValue', 'f32']]).at(4);

/** RECT, as DirectDraw's Blt and Lock take it: four longs. */
export const RECT = RECT_LAYOUT.at(4);

/** DDCOLORKEY: a low and a high value, inclusive. */
const COLORKEY = struct([['low', 'u32'], ['high', 'u32']]);
export const DDCOLORKEY = COLORKEY.at(4);

/** DDSCAPS2, which the newer surface generations take where the old took one dword. */
const SCAPS2 = struct(all(['dwCaps', 'dwCaps2', 'dwCaps3', 'dwCaps4'], 'u32'));
export const DDSCAPS2 = SCAPS2.at(4);

/** One of DDBLTFX's constants: a value, or the surface it is taken from. @type {Declared} */
const CONSTANT = [null, union([[null, 'u32'], [null, 'ptr']])];

/**
 * DDBLTFX. Only the fields a blit here reads are named; the rest is depth
 * and alpha state this layer does not honour: the ROP's and the Z buffer's
 * words, and the four constants each with its bit depth before it. The fill
 * colour is a union with the fill depth, the fill pixel and the pattern
 * surface, all at one offset.
 */
export const DDBLTFX = struct([['dwSize', 'u32'], ['dwDDFX', 'u32'], ['dwROP', 'u32'],
    [null, 'u32', 7], CONSTANT, [null, 'u32'], CONSTANT, [null, 'u32', 4], CONSTANT,
    [null, 'u32'], CONSTANT, [null, union([['dwFillColor', 'u32'], [null, 'ptr']])],
    ['ddckDestColorkey', COLORKEY], ['ddckSrcColorkey', COLORKEY]]).at(4);

/**
 * DDCAPS as DirectX 7 lays it out. The structure grew twice, and a caller
 * says which one it allocated through dwSize; the three sizes are the ones
 * GetCaps accepts, and everything a caller's version lacks is simply not
 * written. The members nothing here fills in are room: the alpha bit depths,
 * the overlay counts and alignments, the stretch limits and the reserved
 * words, and each blit direction's colour-key, FX and ROP words after its caps.
 */
export const DDCAPS = struct([...all(['dwSize', 'dwCaps', 'dwCaps2', 'dwCKeyCaps', 'dwFXCaps',
    'dwFXAlphaCaps', 'dwPalCaps', 'dwSVCaps'], 'u32'), [null, 'u32', 6],
['dwZBufferBitDepths', 'u32'], ['dwVidMemTotal', 'u32'], ['dwVidMemFree', 'u32'],
[null, 'u32', 2], ['dwNumFourCCCodes', 'u32'], [null, 'u32', 5], ['dwRops', 'u32', 8],
['ddsOldCaps', 'u32'], [null, 'u32', 9], ['dwSVBCaps', 'u32'], [null, 'u32', 10],
['dwVSBCaps', 'u32'], [null, 'u32', 10], ['dwSSBCaps', 'u32'], [null, 'u32', 13],
['dwNLVBCaps', 'u32'], [null, 'u32', 11], ['ddsCaps', SCAPS2]]).at(4);

/** The sizes of DDCAPS across the versions that declared it. */
export const DDCAPS_SIZES = Object.freeze([0x13c, 0x16c, 0x17c]);

/** Where `floatsOf`, `intsOf` and `dwordsOf` put the bytes they decode. */
let staging = new ArrayBuffer(256);
let stagingBytes = new Uint8Array(staging);
let stagingFloats = new Float32Array(staging);
let stagingInts = new Int32Array(staging);
let stagingDwords = new Uint32Array(staging);

/**
 * Puts `bytes` where the three readers below take `count` values from, zero
 * past what a short read gave, as a fresh array of that many would be.
 *
 * The obvious way -- a fresh typed array of `count`, and a byte view over its
 * buffer to copy into -- asks a small typed array for its buffer, which moves
 * its elements out of V8's heap into a store of their own and costs several
 * times the copy. A slice of a buffer that already has one does not.
 *
 * @param {Uint8Array} bytes
 * @param {number} count
 */
function stage(bytes, count){
    const length = count * 4;
    if (bytes.length > length)
    {
        throw new RangeError(`${bytes.length} bytes do not fit ${count} values`);
    }
    if (length > staging.byteLength)
    {
        staging = new ArrayBuffer(length);
        stagingBytes = new Uint8Array(staging);
        stagingFloats = new Float32Array(staging);
        stagingInts = new Int32Array(staging);
        stagingDwords = new Uint32Array(staging);
    }
    stagingBytes.set(bytes);
    if (bytes.length < length)
    {
        stagingBytes.fill(0, bytes.length, length);
    }
}

/**
 * `count` floats out of bytes read from guest memory, in an array of their
 * own: the caller may keep it.
 *
 * @param {Uint8Array} bytes
 * @param {number} count
 * @returns {Float32Array}
 */
export function floatsOf(bytes, count){
    if (!(count >= 0))
    {
        return new Float32Array(count);
    }
    stage(bytes, count);
    return stagingFloats.slice(0, count);
}

/**
 * `count` signed dwords, as `floatsOf` reads floats.
 *
 * @param {Uint8Array} bytes
 * @param {number} count
 * @returns {Int32Array}
 */
export function intsOf(bytes, count){
    if (!(count >= 0))
    {
        return new Int32Array(count);
    }
    stage(bytes, count);
    return stagingInts.slice(0, count);
}

/**
 * `count` unsigned dwords, as `floatsOf` reads floats.
 *
 * @param {Uint8Array} bytes
 * @param {number} count
 * @returns {Uint32Array}
 */
export function dwordsOf(bytes, count){
    if (!(count >= 0))
    {
        return new Uint32Array(count);
    }
    stage(bytes, count);
    return stagingDwords.slice(0, count);
}

/**
 * A colour of four floats, as D3DCOLORVALUE lays it out.
 *
 * @typedef {{ r: number, g: number, b: number, a: number }} Colour
 */

/**
 * A material into seventeen floats from `at`: four colours of four, in the
 * order D3DMATERIAL7, 8 and 9 lay them out, then the power.
 *
 * @param {Float32Array} floats
 * @param {{ Diffuse: Colour, Ambient: Colour, Specular: Colour, Emissive: Colour,
 *     Power: number }} material
 */
export function putMaterial(floats, material){
    putColour(floats, 0, material.Diffuse);
    putColour(floats, 4, material.Ambient);
    putColour(floats, 8, material.Specular);
    putColour(floats, 12, material.Emissive);
    floats[16] = material.Power;
}

/**
 * A light into the 26 dwords of D3DLIGHT7, whose layout D3D8's and D3D9's
 * lights keep under their own names: the type as a dword, three colours, a
 * position and a direction, and seven floats. `floats` and `dwords` are two
 * views of the same bytes.
 *
 * @param {Float32Array} floats @param {Uint32Array} dwords @param {any} light
 */
export function putLight(floats, dwords, light){
    dwords[D3DLIGHT7.dltType >>> 2] = light.Type >>> 0;
    putColour(floats, D3DLIGHT7.dcvDiffuse >>> 2, light.Diffuse);
    putColour(floats, D3DLIGHT7.dcvSpecular >>> 2, light.Specular);
    putColour(floats, D3DLIGHT7.dcvAmbient >>> 2, light.Ambient);
    const position = D3DLIGHT7.dvPosition >>> 2;
    floats[position] = light.Position.x;
    floats[position + 1] = light.Position.y;
    floats[position + 2] = light.Position.z;
    const direction = D3DLIGHT7.dvDirection >>> 2;
    floats[direction] = light.Direction.x;
    floats[direction + 1] = light.Direction.y;
    floats[direction + 2] = light.Direction.z;
    floats[D3DLIGHT7.dvRange >>> 2] = light.Range;
    floats[D3DLIGHT7.dvFalloff >>> 2] = light.Falloff;
    floats[D3DLIGHT7.dvAttenuation0 >>> 2] = light.Attenuation0;
    floats[D3DLIGHT7.dvAttenuation1 >>> 2] = light.Attenuation1;
    floats[D3DLIGHT7.dvAttenuation2 >>> 2] = light.Attenuation2;
    floats[D3DLIGHT7.dvTheta >>> 2] = light.Theta;
    floats[D3DLIGHT7.dvPhi >>> 2] = light.Phi;
}

/**
 * A reader of D3DLIGHT7, and of Direct3D 8's and 9's lights, which are its
 * layout under their own names, for the setter of each device.
 *
 * A program may set its lights before every model, most often with what they
 * already hold: the dwords are read in place and compared with those the same
 * device's light at that index was last read from, and the same dwords are
 * answered with the same light -- which the device, comparing it with what it
 * holds, takes as nothing set -- where every call made a light and the arrays
 * to read it through.
 *
 * @param {{ readU32: (address: number) => number }} fields
 * @returns {(device: object, index: number, pointer: number) => any}
 */
export function createLightReader(fields){
    const words = new Uint32Array(D3DLIGHT7.SIZE >>> 2);
    const floats = new Float32Array(words.buffer);
    /** @type {WeakMap<object, Map<number, { words: Uint32Array, light: any }>>} */
    const read = new WeakMap();
    return (device, index, pointer)=>{
        for (let at = 0; at < words.length; at++)
        {
            words[at] = fields.readU32(pointer + at * 4);
        }
        let held = read.get(device);
        if (held === undefined)
        {
            held = new Map();
            read.set(device, held);
        }
        const last = held.get(index);
        if (last !== undefined && sameDwords(last.words, words))
        {
            return last.light;
        }
        const light = lightOf(floats, words);
        if (last !== undefined)
        {
            last.words.set(words);
            last.light = light;
        }
        else
        {
            held.set(index, { words: words.slice(), light });
        }
        return light;
    };
}

/** @param {Uint32Array} a @param {Uint32Array} b */
function sameDwords(a, b){
    for (let at = 0; at < a.length; at++)
    {
        if (a[at] !== b[at])
        {
            return false;
        }
    }
    return true;
}

/**
 * A light out of the 26 dwords of D3DLIGHT7, whose layout Direct3D 8's and
 * 9's lights share, given as dwords and as the same bits seen as floats.
 * Neither is kept.
 *
 * @param {Float32Array} floats @param {Uint32Array} dwords
 */
export function lightFromDwords(floats, dwords){
    return lightOf(floats, dwords);
}

/**
 * A light out of its dwords, as `putLight` lays one out.
 *
 * @param {Float32Array} floats @param {Uint32Array} dwords
 */
function lightOf(floats, dwords){
    /** @param {number} offset */
    const colour = offset=>{
        const at = offset >>> 2;
        return { r: floats[at], g: floats[at + 1], b: floats[at + 2], a: floats[at + 3] };
    };
    /** @param {number} offset */
    const vector = offset=>{
        const at = offset >>> 2;
        return { x: floats[at], y: floats[at + 1], z: floats[at + 2] };
    };
    return {
        Type: dwords[D3DLIGHT7.dltType >>> 2],
        Diffuse: colour(D3DLIGHT7.dcvDiffuse),
        Specular: colour(D3DLIGHT7.dcvSpecular),
        Ambient: colour(D3DLIGHT7.dcvAmbient),
        Position: vector(D3DLIGHT7.dvPosition),
        Direction: vector(D3DLIGHT7.dvDirection),
        Range: floats[D3DLIGHT7.dvRange >>> 2],
        Falloff: floats[D3DLIGHT7.dvFalloff >>> 2],
        Attenuation0: floats[D3DLIGHT7.dvAttenuation0 >>> 2],
        Attenuation1: floats[D3DLIGHT7.dvAttenuation1 >>> 2],
        Attenuation2: floats[D3DLIGHT7.dvAttenuation2 >>> 2],
        Theta: floats[D3DLIGHT7.dvTheta >>> 2],
        Phi: floats[D3DLIGHT7.dvPhi >>> 2],
    };
}

/** @param {Float32Array} floats @param {number} at @param {Colour} colour */
function putColour(floats, at, colour){
    floats[at] = colour.r;
    floats[at + 1] = colour.g;
    floats[at + 2] = colour.b;
    floats[at + 3] = colour.a;
}

/**
 * A layout's fields in the order of their offsets, and whether two of them
 * share one -- worked out once per layout, not per structure written.
 *
 * @type {WeakMap<Record<string, number>, { order: [string, number][], shared: boolean }>}
 */
const fieldOrders = new WeakMap();

/** @param {Record<string, number>} layout */
function fieldOrder(layout){
    let known = fieldOrders.get(layout);
    if (!known)
    {
        /** @type {[string, number][]} */
        const order = Object.entries(layout).filter(([name])=>name !== 'SIZE');
        order.sort((a, b)=>a[1] - b[1]);
        const shared = order.some(([, offset], i)=>i > 0 && order[i - 1][1] + 4 > offset);
        known = { order, shared };
        fieldOrders.set(layout, known);
    }
    return known;
}

/**
 * How a field eight bytes wide widens - an address or a handle of a 64-bit
 * layout - or null for a dword, and for any field of a table no layout made.
 *
 * @param {Record<string, number>} layout @param {string} name
 * @returns {'ptr' | 'handle' | null}
 */
const wideKind = (layout, name)=>{
    const field = fieldOf(layout, name);
    return field?.size === 8 && (field.kind === 'ptr' || field.kind === 'handle')
        ? field.kind : null;
};

/**
 * Reading and writing dwords through the memory service, in one place.
 *
 * What a call answers through a structure or an array is written as one
 * block: it is put together in a buffer of the module's and handed to
 * `writeMemory` whole. A write into guest memory costs the same checks and
 * bookkeeping whether it carries four bytes or sixty-four, so a matrix
 * written a float at a time paid for sixteen.
 *
 * @param {any} memory  readMemory/writeMemory, as the graphics services give them.
 */
export function createFields(memory){
    /** @param {number} address */
    const readU32 = address=>{
        // The memory layer reads a dword in place where it can; every field a
        // call reads went through a four-byte copy otherwise.
        if (typeof memory.readU32 === 'function')
        {
            return memory.readU32(address >>> 0) >>> 0;
        }
        const bytes = memory.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        // In place too, where the memory layer offers it: every out-parameter
        // a call answers through went through a four-byte array otherwise.
        if (typeof memory.writeU32 === 'function')
        {
            memory.writeU32(address >>> 0, value >>> 0);
            return;
        }
        memory.writeMemory(address >>> 0, new Uint8Array([
            value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
        ]));
    };

    /** A float shares its four bytes with a dword; only the reading differs. */
    const scratch = new DataView(new ArrayBuffer(4));

    /**
     * Where a block is put together before it is written: the views are the
     * same bytes, so a structure mixing floats and dwords is put in with
     * whichever each field needs. Valid until the next write through here;
     * `writeMemory` copies what it is handed.
     */
    const outgoing = { bytes: new Uint8Array(0), floats: new Float32Array(0),
        dwords: new Uint32Array(0) };
    /** @param {number} count  Dwords the block needs. */
    const staged = count=>{
        if (count > outgoing.dwords.length)
        {
            const buffer = new ArrayBuffer(Math.max(256, count * 4));
            outgoing.bytes = new Uint8Array(buffer);
            outgoing.floats = new Float32Array(buffer);
            outgoing.dwords = new Uint32Array(buffer);
        }
        return outgoing;
    };
    /**
     * The first `count` dwords put together, written at `address` as one block.
     *
     * @param {number} address @param {number} count @param {number} [from]  The first dword.
     */
    const writeStaged = (address, count, from = 0)=>{
        memory.writeMemory(address >>> 0, outgoing.bytes.subarray(from * 4, (from + count) * 4));
    };

    return {
        readU32,
        writeU32,
        /**
         * A pointer of `bytes` (4 or 8), whole, through the memory service's
         * reader and writer (the memory layer's): never a dword and a zero
         * made here.
         *
         * @param {number} address @param {4 | 8} bytes
         */
        readPointer: (address, bytes)=>memory.readPointer(address, bytes),
        /** @param {number} address @param {number} value @param {4 | 8} bytes */
        writePointer: (address, value, bytes)=>memory.writePointer(address, value, bytes),
        staged,
        writeStaged,

        /**
         * Floats, as one block.
         *
         * @param {number} address @param {ArrayLike<number>} values
         */
        writeFloats(address, values){
            const { floats } = staged(values.length);
            if (values instanceof Float32Array)
            {
                // Copied as the bits they are: a signalling NaN taken through
                // a number comes out quiet, and the program set it as it was.
                floats.set(values);
            }
            else
            {
                for (let index = 0; index < values.length; index++)
                {
                    floats[index] = values[index];
                }
            }
            writeStaged(address, values.length);
        },

        /**
         * Dwords, as one block; each value as a dword stores it, modulo 2^32.
         *
         * @param {number} address @param {ArrayLike<number>} values
         */
        writeDwords(address, values){
            const { dwords } = staged(values.length);
            for (let index = 0; index < values.length; index++)
            {
                dwords[index] = values[index];
            }
            writeStaged(address, values.length);
        },
        /** @param {number} address */
        readF32(address){
            scratch.setUint32(0, readU32(address), true);
            return scratch.getFloat32(0, true);
        },

        /**
         * A float that arrived in a stack slot rather than through memory: an
         * argument declared float is pushed as its four bytes, and this seam
         * reads every slot as a dword before it knows which is which.
         *
         * @param {number} bits
         */
        asFloat(bits){
            scratch.setUint32(0, bits >>> 0, true);
            return scratch.getFloat32(0, true);
        },
        /** @param {number} address @param {number} value */
        writeF32(address, value){
            scratch.setFloat32(0, value, true);
            writeU32(address, scratch.getUint32(0, true));
        },

        /**
         * A whole structure as named fields, given its offset table.
         *
         * @param {number} address
         * @param {Record<string, number>} layout
         * @param {string[]} [floats]  Fields to read as floats rather than dwords.
         * @returns {Record<string, number>}
         */
        readStruct(address, layout, floats = []){
            /** @type {Record<string, number>} */
            const out = {};
            for (const [name, offset] of Object.entries(layout))
            {
                if (name === 'SIZE')
                {
                    continue;
                }
                out[name] = floats.includes(name)
                    ? scratchFloat(readU32(address + offset))
                    : readU32(address + offset);
            }
            return out;
        },

        /**
         * A structure, one block for each run of fields named in `values`
         * that follow one another -- the whole of it, where every field is
         * named. A field not named is left as it was, and so is a field of
         * a layout whose fields share an offset, which is written one at a
         * time in the order `values` names them. A pointer-sized field of a
         * 64-bit layout (`system/layout.js`) is its two dwords, the high one
         * as its kind widens it.
         *
         * @param {number} address
         * @param {Record<string, number>} layout
         * @param {Record<string, number>} values  Only the named fields are written.
         * @param {readonly string[]} [floats]
         */
        writeStruct(address, layout, values, floats = []){
            const { order, shared } = fieldOrder(layout);
            if (shared)
            {
                for (const [name, value] of Object.entries(values))
                {
                    const offset = layout[name];
                    if (offset === undefined)
                    {
                        continue;
                    }
                    if (floats.includes(name))
                    {
                        scratch.setFloat32(0, value, true);
                        writeU32(address + offset, scratch.getUint32(0, true));
                    }
                    else
                    {
                        writeU32(address + offset, value);
                    }
                    const wide = wideKind(layout, name);
                    if (wide)
                    {
                        writeU32(address + offset + 4, highOf(value, wide));
                    }
                }
                return;
            }
            const block = staged(2 * order.length);
            // The run being put together: its first field's offset, and
            // where its next field would have to start to join it.
            let first = -1;
            let end = -1;
            let at = 0;
            for (let index = 0; index < order.length; index++)
            {
                const [name, offset] = order[index];
                if (!Object.hasOwn(values, name))
                {
                    continue;
                }
                if (offset !== end)
                {
                    if (first >= 0)
                    {
                        writeStaged(address + first, (end - first) >>> 2);
                    }
                    first = offset;
                    at = 0;
                }
                if (floats.includes(name))
                {
                    block.floats[at] = values[name];
                }
                else
                {
                    block.dwords[at] = values[name];
                }
                at++;
                end = offset + 4;
                const wide = wideKind(layout, name);
                if (wide)
                {
                    block.dwords[at++] = highOf(values[name], wide);
                    end += 4;
                }
            }
            if (first >= 0)
            {
                writeStaged(address + first, (end - first) >>> 2);
            }
        },
    };

    /** @param {number} bits */
    function scratchFloat(bits){
        scratch.setUint32(0, bits, true);
        return scratch.getFloat32(0, true);
    }
}
