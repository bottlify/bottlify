/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D structures a guest call passes by pointer.
 *
 * Every offset is spelled out rather than counted, for the reason the
 * DirectDraw structures give: a field read one slot early is a plausible
 * number, and a plausible number is what makes this class of mistake survive
 * into a picture that is merely wrong rather than into a crash.
 *
 * D3DPRESENT_PARAMETERS is the one that matters most and the one that differs
 * between versions. Direct3D 8 has no `Flags` before the refresh rate and no
 * `PresentationInterval` at the end in the place 9 puts them, so the two
 * layouts are declared separately rather than shared with an offset table --
 * reading a 9 structure with 8's offsets finds the windowed flag in the depth
 * format's field, which is a boolean that happens to be true.
 */

/** D3DPRESENT_PARAMETERS as Direct3D 8 declares it. */
export const D3DPRESENT_PARAMETERS8 = Object.freeze({
    BackBufferWidth: 0x00,
    BackBufferHeight: 0x04,
    BackBufferFormat: 0x08,
    BackBufferCount: 0x0c,
    MultiSampleType: 0x10,
    SwapEffect: 0x14,
    hDeviceWindow: 0x18,
    Windowed: 0x1c,
    EnableAutoDepthStencil: 0x20,
    AutoDepthStencilFormat: 0x24,
    Flags: 0x28,
    FullScreen_RefreshRateInHz: 0x2c,
    FullScreen_PresentationInterval: 0x30,
    SIZE: 0x34,
});

/**
 * D3DPRESENT_PARAMETERS as Direct3D 9 declares it.
 *
 * MultiSampleQuality is inserted after MultiSampleType, and the trailing pair
 * is renamed -- windowed presentation gained an interval, so the field is no
 * longer full-screen only.
 */
export const D3DPRESENT_PARAMETERS9 = Object.freeze({
    BackBufferWidth: 0x00,
    BackBufferHeight: 0x04,
    BackBufferFormat: 0x08,
    BackBufferCount: 0x0c,
    MultiSampleType: 0x10,
    MultiSampleQuality: 0x14,
    SwapEffect: 0x18,
    hDeviceWindow: 0x1c,
    Windowed: 0x20,
    EnableAutoDepthStencil: 0x24,
    AutoDepthStencilFormat: 0x28,
    Flags: 0x2c,
    FullScreen_RefreshRateInHz: 0x30,
    PresentationInterval: 0x34,
    SIZE: 0x38,
});

/** D3DDISPLAYMODE. The same in both versions. */
export const D3DDISPLAYMODE = Object.freeze({
    Width: 0x00,
    Height: 0x04,
    RefreshRate: 0x08,
    Format: 0x0c,
    SIZE: 0x10,
});

/** D3DVIEWPORT8. Six dwords, the last two of which are floats. */
export const D3DVIEWPORT8 = Object.freeze({
    X: 0x00,
    Y: 0x04,
    Width: 0x08,
    Height: 0x0c,
    MinZ: 0x10,
    MaxZ: 0x14,
    SIZE: 0x18,
});

/**
 * D3DVIEWPORT7: the same six dwords as D3D8's viewport, under the older
 * names. Declared separately so the name a reader checks against the header
 * is the one they find there.
 */
export const D3DVIEWPORT7 = Object.freeze({
    dwX: 0x00,
    dwY: 0x04,
    dwWidth: 0x08,
    dwHeight: 0x0c,
    dvMinZ: 0x10,
    dvMaxZ: 0x14,
    SIZE: 0x18,
});

/** D3DVERTEXBUFFERDESC. */
export const D3DVERTEXBUFFERDESC = Object.freeze({
    dwSize: 0x00,
    dwCaps: 0x04,
    dwFVF: 0x08,
    dwNumVertices: 0x0c,
    SIZE: 0x10,
});

/** D3DCLIPSTATUS: two dwords and six floats. */
export const D3DCLIPSTATUS = Object.freeze({
    dwFlags: 0x00,
    dwStatus: 0x04,
    minx: 0x08,
    maxx: 0x0c,
    miny: 0x10,
    maxy: 0x14,
    minz: 0x18,
    maxz: 0x1c,
    SIZE: 0x20,
});

/**
 * D3DLIGHT7: a type, three colours, two vectors and seven floats. The same
 * layout D3D8's light has.
 */
export const D3DLIGHT7 = Object.freeze({
    dltType: 0x00,
    dcvDiffuse: 0x04,
    dcvSpecular: 0x14,
    dcvAmbient: 0x24,
    dvPosition: 0x34,
    dvDirection: 0x40,
    dvRange: 0x4c,
    dvFalloff: 0x50,
    dvAttenuation0: 0x54,
    dvAttenuation1: 0x58,
    dvAttenuation2: 0x5c,
    dvTheta: 0x60,
    dvPhi: 0x64,
    SIZE: 0x68,
});

/** D3DPRIMCAPS, which a device description holds two of. */
export const D3DPRIMCAPS = Object.freeze({
    dwSize: 0x00,
    dwMiscCaps: 0x04,
    dwRasterCaps: 0x08,
    dwZCmpCaps: 0x0c,
    dwSrcBlendCaps: 0x10,
    dwDestBlendCaps: 0x14,
    dwAlphaCmpCaps: 0x18,
    dwShadeCaps: 0x1c,
    dwTextureCaps: 0x20,
    dwTextureFilterCaps: 0x24,
    dwTextureBlendCaps: 0x28,
    dwTextureAddressCaps: 0x2c,
    dwStippleWidth: 0x30,
    dwStippleHeight: 0x34,
    SIZE: 0x38,
});

/**
 * D3DDEVICEDESC7. No size field of its own: the first dword is the device
 * capabilities. The three WORD pairs are the only fields narrower than a
 * dword, and the GUID is four-byte aligned, so nothing is padded.
 */
export const D3DDEVICEDESC7 = Object.freeze({
    dwDevCaps: 0x00,
    dpcLineCaps: 0x04,
    dpcTriCaps: 0x3c,
    dwDeviceRenderBitDepth: 0x74,
    dwDeviceZBufferBitDepth: 0x78,
    dwMinTextureWidth: 0x7c,
    dwMinTextureHeight: 0x80,
    dwMaxTextureWidth: 0x84,
    dwMaxTextureHeight: 0x88,
    dwMaxTextureRepeat: 0x8c,
    dwMaxTextureAspectRatio: 0x90,
    dwMaxAnisotropy: 0x94,
    dvGuardBandLeft: 0x98,
    dvGuardBandTop: 0x9c,
    dvGuardBandRight: 0xa0,
    dvGuardBandBottom: 0xa4,
    dvExtentsAdjust: 0xa8,
    dwStencilCaps: 0xac,
    dwFVFCaps: 0xb0,
    dwTextureOpCaps: 0xb4,
    wMaxTextureBlendStages: 0xb8,
    wMaxSimultaneousTextures: 0xba,
    dwMaxActiveLights: 0xbc,
    dvMaxVertexW: 0xc0,
    deviceGUID: 0xc4,
    wMaxUserClipPlanes: 0xd4,
    wMaxVertexBlendMatrices: 0xd6,
    dwVertexProcessingCaps: 0xd8,
    SIZE: 0xec,
});

/** D3DRECT: four longs, and the order is left, top, right, bottom. */
export const D3DRECT = Object.freeze({
    x1: 0x00,
    y1: 0x04,
    x2: 0x08,
    y2: 0x0c,
    SIZE: 0x10,
});

/** POINT, which CopyRects takes an array of. */
export const POINT = Object.freeze({ x: 0x00, y: 0x04, SIZE: 0x08 });

/**
 * D3DLOCKED_RECT, written back by a lock: the row stride first, then the
 * address of the first byte. A caller that reads them the other way round
 * treats a pointer as a pitch and walks off the surface on its second row.
 */
export const D3DLOCKED_RECT = Object.freeze({ Pitch: 0x00, pBits: 0x04, SIZE: 0x08 });

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
 * @returns {number | Promise<number>}
 */
export function lockRectInto(fields, out, lock){
    /** @type {{ Pitch?: number, pBits?: number }} */
    const locked = {};
    /** @param {number} hr */
    const answer = hr=>{
        if (hr === 0 && (out >>> 0) !== 0)
        {
            fields.writeStruct(out >>> 0, D3DLOCKED_RECT,
                { Pitch: locked.Pitch ?? 0, pBits: locked.pBits ?? 0 });
        }
        return hr;
    };
    const hr = lock(locked);
    return hr instanceof Promise ? hr.then(answer) : answer(hr);
}

/** D3DSURFACE_DESC as Direct3D 8 declares it. */
export const D3DSURFACE_DESC8 = Object.freeze({
    Format: 0x00,
    Type: 0x04,
    Usage: 0x08,
    Pool: 0x0c,
    Size: 0x10,
    MultiSampleType: 0x14,
    Width: 0x18,
    Height: 0x1c,
    SIZE: 0x20,
});

/** D3DVOLUME_DESC as Direct3D 8 declares it, with the size Direct3D 9 dropped. */
export const D3DVOLUME_DESC8 = Object.freeze({
    Format: 0x00,
    Type: 0x04,
    Usage: 0x08,
    Pool: 0x0c,
    Size: 0x10,
    Width: 0x14,
    Height: 0x18,
    Depth: 0x1c,
    SIZE: 0x20,
});

/** D3DLOCKED_BOX, the same in both versions: two pitches, then the address. */
export const D3DLOCKED_BOX = Object.freeze({
    RowPitch: 0x00, SlicePitch: 0x04, pBits: 0x08, SIZE: 0x0c,
});

/** D3DBOX, the same in both versions: the rectangle's four edges, then front and back. */
export const D3DBOX = Object.freeze({
    Left: 0x00, Top: 0x04, Right: 0x08, Bottom: 0x0c, Front: 0x10, Back: 0x14, SIZE: 0x18,
});

/**
 * D3DCAPS8, every field of it.
 *
 * Written out in full rather than as the handful anyone fills in, because a
 * partial table is where the offsets go wrong: five guard-band floats and an
 * adjustment sit between the texture limits and the blend-stage counts, and a
 * table that skips them puts every later field somewhere else. That is not a
 * missing capability, it is a wrong one -- a maximum texture size written into
 * the repeat limit leaves the real maximum reading as zero, and a program that
 * halves a texture until it fits a maximum of zero halves it for ever.
 */
export const D3DCAPS8 = Object.freeze({
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
    MaxPixelShaderValue: 0xd0,
    SIZE: 0xd4,
});
/** RECT, as DirectDraw's Blt and Lock take it: four longs. */
export const RECT = Object.freeze({ left: 0x00, top: 0x04, right: 0x08, bottom: 0x0c, SIZE: 0x10 });

/** DDCOLORKEY: a low and a high value, inclusive. */
export const DDCOLORKEY = Object.freeze({ low: 0x00, high: 0x04, SIZE: 0x08 });

/** DDSCAPS2, which the newer surface generations take where the old took one dword. */
export const DDSCAPS2 = Object.freeze({
    dwCaps: 0x00,
    dwCaps2: 0x04,
    dwCaps3: 0x08,
    dwCaps4: 0x0c,
    SIZE: 0x10,
});

/**
 * DDBLTFX. Only the fields a blit here reads are named; the rest is depth
 * and alpha state this layer does not honour. The fill colour is a union
 * with the fill depth and the pattern surface, all at one offset.
 */
export const DDBLTFX = Object.freeze({
    dwSize: 0x00,
    dwDDFX: 0x04,
    dwROP: 0x08,
    dwFillColor: 0x50,
    ddckDestColorkey: 0x54,
    ddckSrcColorkey: 0x5c,
    SIZE: 0x64,
});

/**
 * DDCAPS as DirectX 7 lays it out. The structure grew twice, and a caller
 * says which one it allocated through dwSize; the three sizes are the ones
 * GetCaps accepts, and everything a caller's version lacks is simply not
 * written.
 */
export const DDCAPS = Object.freeze({
    dwSize: 0x00,
    dwCaps: 0x04,
    dwCaps2: 0x08,
    dwCKeyCaps: 0x0c,
    dwFXCaps: 0x10,
    dwFXAlphaCaps: 0x14,
    dwPalCaps: 0x18,
    dwSVCaps: 0x1c,
    dwZBufferBitDepths: 0x38,
    dwVidMemTotal: 0x3c,
    dwVidMemFree: 0x40,
    dwNumFourCCCodes: 0x4c,
    dwRops: 0x64,
    ddsOldCaps: 0x84,
    dwSVBCaps: 0xac,
    dwVSBCaps: 0xd8,
    dwSSBCaps: 0x104,
    dwNLVBCaps: 0x13c,
    ddsCaps: 0x16c,
    SIZE: 0x17c,
});

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
         * time in the order `values` names them.
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
                }
                return;
            }
            const block = staged(order.length);
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
