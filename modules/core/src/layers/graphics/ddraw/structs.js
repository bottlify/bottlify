/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The DirectDraw structures, laid out the way the guest compiled them.
 *
 * Two things make these harder than the user32 structures they are written in
 * the style of, and both are the reason every offset is spelled out rather
 * than counted:
 *
 * - **Almost every field past the first six is a union**, and the name a
 *   program uses depends on what the surface is. `dwZBufferBitDepth` and
 *   `dwRGBBitCount` are the same four bytes; so are `dwMipMapCount`,
 *   `dwRefreshRate` and, in the older layout, a second `dwZBufferBitDepth`.
 *   The aliases are listed at their shared offset so that reading one through
 *   the other's name is impossible.
 * - **`dwSize` is the version tag.** The two descriptor layouts differ only in
 *   their tail, so a `DDSURFACEDESC2` handed to an interface expecting a
 *   `DDSURFACEDESC` parses perfectly and means something else. DirectDraw
 *   therefore refuses any `dwSize` that is not exactly the layout's own --
 *   not too small, not too large, and specifically not the other layout's
 *   size. That is what `readSurfaceDesc` returning null encodes.
 */

/**
 * DDPIXELFORMAT. Five of its eight fields are unions; the alias names are
 * listed at the offset they share.
 */
export const DDPIXELFORMAT = Object.freeze({
    dwSize: 0x00,
    dwFlags: 0x04,
    dwFourCC: 0x08,
    dwRGBBitCount: 0x0c,
    dwZBufferBitDepth: 0x0c,
    dwAlphaBitDepth: 0x0c,
    dwLuminanceBitCount: 0x0c,
    dwRBitMask: 0x10,
    dwYBitMask: 0x10,
    dwStencilBitDepth: 0x10,
    dwGBitMask: 0x14,
    dwUBitMask: 0x14,
    dwZBitMask: 0x14,
    dwBBitMask: 0x18,
    dwVBitMask: 0x18,
    dwStencilBitMask: 0x18,
    dwRGBAlphaBitMask: 0x1c,
    dwRGBZBitMask: 0x1c,
    SIZE: 0x20,
});

/** DDSURFACEDESC: the layout IDirectDraw and IDirectDraw2 take. */
export const DDSURFACEDESC = Object.freeze({
    dwSize: 0x00,
    dwFlags: 0x04,
    dwHeight: 0x08,
    dwWidth: 0x0c,
    lPitch: 0x10,
    dwLinearSize: 0x10,
    dwBackBufferCount: 0x14,
    dwMipMapCount: 0x18,
    dwZBufferBitDepth: 0x18,
    dwRefreshRate: 0x18,
    dwAlphaBitDepth: 0x1c,
    dwReserved: 0x20,
    lpSurface: 0x24,
    ddckCKDestOverlay: 0x28,
    ddckCKDestBlt: 0x30,
    ddckCKSrcOverlay: 0x38,
    ddckCKSrcBlt: 0x40,
    ddpfPixelFormat: 0x48,
    dwCaps: 0x68,
    SIZE: 0x6c,
});

/**
 * DDSURFACEDESC2: the layout IDirectDraw4 and IDirectDraw7 take. Identical up
 * to the capabilities, where DDSCAPS grows into DDSCAPS2 and a texture-stage
 * field follows it.
 */
export const DDSURFACEDESC2 = Object.freeze({
    dwSize: 0x00,
    dwFlags: 0x04,
    dwHeight: 0x08,
    dwWidth: 0x0c,
    lPitch: 0x10,
    dwLinearSize: 0x10,
    dwBackBufferCount: 0x14,
    dwDepth: 0x14,
    dwMipMapCount: 0x18,
    dwRefreshRate: 0x18,
    dwAlphaBitDepth: 0x1c,
    dwReserved: 0x20,
    lpSurface: 0x24,
    ddckCKDestOverlay: 0x28,
    dwEmptyFaceColor: 0x28,
    ddckCKDestBlt: 0x30,
    ddckCKSrcOverlay: 0x38,
    ddckCKSrcBlt: 0x40,
    ddpfPixelFormat: 0x48,
    dwFVF: 0x48,
    dwCaps: 0x68,
    dwCaps2: 0x6c,
    dwCaps3: 0x70,
    dwCaps4: 0x74,
    dwTextureStage: 0x78,
    SIZE: 0x7c,
});

/**
 * @typedef {Object} DrawMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * @param {DrawMemory} memory
 * @param {number} address
 * @returns {number} the DWORD at that address, unsigned
 */
export function readU32(memory, address){
    const bytes = memory.readMemory(address, 4);
    return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
}

/**
 * @param {DrawMemory} memory
 * @param {number} address
 * @param {number} value
 */
export function writeU32(memory, address, value){
    const word = value >>> 0;
    memory.writeMemory(address, new Uint8Array([
        word & 0xff,
        (word >>> 8) & 0xff,
        (word >>> 16) & 0xff,
        (word >>> 24) & 0xff,
    ]));
}

/**
 * @typedef {Object} PixelFormatFields
 * @property {number} size
 * @property {number} flags
 * @property {number} fourCC
 * @property {number} bitCount     dwRGBBitCount, or whatever the flags call it.
 * @property {number} redMask      Also the Y mask, also the stencil bit depth.
 * @property {number} greenMask    Also the U mask, also the Z mask.
 * @property {number} blueMask     Also the V mask, also the stencil bit mask.
 * @property {number} alphaMask    Also the Z mask of an RGBZ format.
 */

/**
 * @param {DrawMemory} memory
 * @param {number} address
 * @returns {PixelFormatFields}
 */
export function readPixelFormat(memory, address){
    /** @param {number} offset */
    const field = offset=>readU32(memory, address + offset);
    return {
        size: field(DDPIXELFORMAT.dwSize),
        flags: field(DDPIXELFORMAT.dwFlags),
        fourCC: field(DDPIXELFORMAT.dwFourCC),
        bitCount: field(DDPIXELFORMAT.dwRGBBitCount),
        redMask: field(DDPIXELFORMAT.dwRBitMask),
        greenMask: field(DDPIXELFORMAT.dwGBitMask),
        blueMask: field(DDPIXELFORMAT.dwBBitMask),
        alphaMask: field(DDPIXELFORMAT.dwRGBAlphaBitMask),
    };
}

/**
 * @param {DrawMemory} memory
 * @param {number} address
 * @param {PixelFormatFields} format
 */
export function writePixelFormat(memory, address, format){
    writeU32(memory, address + DDPIXELFORMAT.dwSize, DDPIXELFORMAT.SIZE);
    writeU32(memory, address + DDPIXELFORMAT.dwFlags, format.flags);
    writeU32(memory, address + DDPIXELFORMAT.dwFourCC, format.fourCC);
    writeU32(memory, address + DDPIXELFORMAT.dwRGBBitCount, format.bitCount);
    writeU32(memory, address + DDPIXELFORMAT.dwRBitMask, format.redMask);
    writeU32(memory, address + DDPIXELFORMAT.dwGBitMask, format.greenMask);
    writeU32(memory, address + DDPIXELFORMAT.dwBBitMask, format.blueMask);
    writeU32(memory, address + DDPIXELFORMAT.dwRGBAlphaBitMask, format.alphaMask);
}

/**
 * @typedef {Object} SurfaceDescFields
 * @property {number} flags        dwFlags: which of the rest the caller filled in.
 * @property {number} width
 * @property {number} height
 * @property {number} pitch
 * @property {number} backBufferCount
 * @property {number} mipMapCount  Also the refresh rate, also a Z depth on the older layout.
 * @property {number} [zBufferBitDepth]  The same slot, under the name a depth request uses.
 * @property {number} caps
 * @property {number} caps2        Zero for the older layout, which has no such field.
 * @property {PixelFormatFields} pixelFormat
 */

/**
 * Reads either descriptor layout, refusing one whose `dwSize` is not exactly
 * the layout's own.
 *
 * The refusal is the point: the two layouts share their first 0x68 bytes, so a
 * mismatched one would parse into believable values and be wrong only in the
 * tail. Null here is what the caller turns into DDERR_INVALIDPARAMS.
 *
 * @param {DrawMemory} memory
 * @param {number} address
 * @param {typeof DDSURFACEDESC | typeof DDSURFACEDESC2} layout
 * @returns {SurfaceDescFields | null}
 */
export function readSurfaceDesc(memory, address, layout){
    if (readU32(memory, address + layout.dwSize) !== layout.SIZE)
    {
        return null;
    }
    /** @param {number} offset */
    const field = offset=>readU32(memory, address + offset);
    return {
        flags: field(layout.dwFlags),
        width: field(layout.dwWidth),
        height: field(layout.dwHeight),
        pitch: field(layout.lPitch),
        backBufferCount: field(layout.dwBackBufferCount),
        mipMapCount: field(layout.dwMipMapCount),
        zBufferBitDepth: field(layout.dwMipMapCount),
        caps: field(layout.dwCaps),
        caps2: 'dwCaps2' in layout ? field(layout.dwCaps2) : 0,
        pixelFormat: readPixelFormat(memory, address + layout.ddpfPixelFormat),
    };
}

/**
 * Fills in a descriptor for GetSurfaceDesc and Lock.
 *
 * `dwSize` is rewritten with the layout's own value rather than left alone:
 * the caller had to set it correctly for the call to be accepted at all, so
 * writing it back cannot surprise anyone, and leaving the field out of the
 * write would make a partially-filled structure indistinguishable from an
 * untouched one.
 *
 * @param {DrawMemory} memory
 * @param {number} address
 * @param {typeof DDSURFACEDESC | typeof DDSURFACEDESC2} layout
 * @param {SurfaceDescFields & { surfacePointer?: number }} desc
 */
export function writeSurfaceDesc(memory, address, layout, desc){
    writeU32(memory, address + layout.dwSize, layout.SIZE);
    writeU32(memory, address + layout.dwFlags, desc.flags);
    writeU32(memory, address + layout.dwHeight, desc.height);
    writeU32(memory, address + layout.dwWidth, desc.width);
    writeU32(memory, address + layout.lPitch, desc.pitch);
    writeU32(memory, address + layout.dwBackBufferCount, desc.backBufferCount);
    writeU32(memory, address + layout.dwMipMapCount, desc.mipMapCount);
    writeU32(memory, address + layout.lpSurface, desc.surfacePointer ?? 0);
    writeU32(memory, address + layout.dwCaps, desc.caps);
    if ('dwCaps2' in layout)
    {
        writeU32(memory, address + layout.dwCaps2, desc.caps2);
    }
    writePixelFormat(memory, address + layout.ddpfPixelFormat, desc.pixelFormat);
}

/**
 * Bytes per pixel for the lock arithmetic. A format that names no bit count --
 * a block-compressed one, say -- has no such number, and answering with a
 * plausible one would put a lock rectangle's origin in the wrong place; zero
 * says so instead.
 *
 * @param {PixelFormatFields} format
 * @returns {number}
 */
export function bytesPerPixel(format){
    return format.bitCount > 0 ? (format.bitCount + 7) >> 3 : 0;
}
