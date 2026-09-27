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
 * Reading and writing dwords through the memory service, in one place.
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

    return {
        readU32,
        writeU32,
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
         * @param {number} address
         * @param {Record<string, number>} layout
         * @param {Record<string, number>} values  Only the named fields are written.
         * @param {string[]} [floats]
         */
        writeStruct(address, layout, values, floats = []){
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
        },
    };

    /** @param {number} bits */
    function scratchFloat(bits){
        scratch.setUint32(0, bits, true);
        return scratch.getFloat32(0, true);
    }
}
