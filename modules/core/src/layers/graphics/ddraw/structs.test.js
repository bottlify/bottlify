/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DDPF_PALETTEINDEXED8,
    DDPF_RGB,
    DDPF_ZBUFFER,
    DDSCAPS2_TEXTUREMANAGE,
    DDSCAPS_OFFSCREENPLAIN,
    DDSD_CAPS,
    DDSD_HEIGHT,
    DDSD_PIXELFORMAT,
    DDSD_WIDTH,
} from './constants.js';
import {
    DDPIXELFORMAT,
    DDSURFACEDESC,
    DDSURFACEDESC2,
    bytesPerPixel,
    readPixelFormat,
    readSurfaceDesc,
    readU32,
    writePixelFormat,
    writeSurfaceDesc,
    writeU32,
} from './structs.js';

const DESC = 0x20000;

/** Fills a buffer so that "wrote nothing" is distinguishable from "wrote zero". */
const UNTOUCHED = 0xa5a5a5a5;

/**
 * Guest memory as a flat array. The real memory layer hands back copies, so
 * this one does too: a fake that hands out a window onto its own bytes invents
 * aliasing bugs rather than finding them.
 */
function fakeMemory(size = 0x21000){
    const bytes = new Uint8Array(size);
    return {
        bytes,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address @param {number} count */
        fill(address, count){
            for (let index = 0; index < count; index++)
            {
                writeU32(this, address + (index * 4), UNTOUCHED);
            }
        },
    };
}

/**
 * @param {ReturnType<typeof fakeMemory>} memory
 * @param {typeof DDSURFACEDESC | typeof DDSURFACEDESC2} layout
 * @param {{ size?: number }} [options]
 */
function putDesc(memory, layout, options = {}){
    memory.fill(DESC, layout.SIZE / 4);
    writeU32(memory, DESC + layout.dwSize, options.size ?? layout.SIZE);
    writeU32(memory, DESC + layout.dwFlags, DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT
        | DDSD_PIXELFORMAT);
    writeU32(memory, DESC + layout.dwWidth, 128);
    writeU32(memory, DESC + layout.dwHeight, 64);
    writeU32(memory, DESC + layout.lPitch, 512);
    writeU32(memory, DESC + layout.dwBackBufferCount, 3);
    writeU32(memory, DESC + layout.dwMipMapCount, 5);
    writeU32(memory, DESC + layout.dwCaps, DDSCAPS_OFFSCREENPLAIN);
    if ('dwCaps2' in layout)
    {
        writeU32(memory, DESC + layout.dwCaps2, DDSCAPS2_TEXTUREMANAGE);
    }

    const format = DESC + layout.ddpfPixelFormat;
    writeU32(memory, format + DDPIXELFORMAT.dwSize, DDPIXELFORMAT.SIZE);
    writeU32(memory, format + DDPIXELFORMAT.dwFlags, DDPF_RGB);
    writeU32(memory, format + DDPIXELFORMAT.dwRGBBitCount, 16);
    writeU32(memory, format + DDPIXELFORMAT.dwRBitMask, 0xf800);
    writeU32(memory, format + DDPIXELFORMAT.dwGBitMask, 0x07e0);
    writeU32(memory, format + DDPIXELFORMAT.dwBBitMask, 0x001f);
    writeU32(memory, format + DDPIXELFORMAT.dwRGBAlphaBitMask, 0);
}

test('the two descriptor layouts differ where they are documented to', ()=>{
    // Everything up to the capabilities is shared; the caps field is where one
    // structure grew a second word and a texture stage behind it.
    const older = /** @type {Record<string, number>} */ (DDSURFACEDESC);
    const newer = /** @type {Record<string, number>} */ (DDSURFACEDESC2);
    for (const field of ['dwSize', 'dwFlags', 'dwHeight', 'dwWidth', 'lPitch',
        'dwBackBufferCount', 'dwMipMapCount', 'dwAlphaBitDepth', 'lpSurface',
        'ddckCKDestBlt', 'ddpfPixelFormat', 'dwCaps'])
    {
        assert.equal(newer[field], older[field], `${field} sits at one offset`);
    }
    assert.equal(DDSURFACEDESC.SIZE, 0x6c);
    assert.equal(DDSURFACEDESC2.SIZE, 0x7c);
    assert.equal(DDSURFACEDESC2.dwCaps2, 0x6c);
    assert.equal(DDSURFACEDESC2.dwTextureStage, 0x78);
    assert.equal(DDPIXELFORMAT.SIZE, 0x20);
});

test('the union members of a pixel format share the offsets they are documented to share', ()=>{
    assert.equal(DDPIXELFORMAT.dwZBufferBitDepth, DDPIXELFORMAT.dwRGBBitCount);
    assert.equal(DDPIXELFORMAT.dwStencilBitDepth, DDPIXELFORMAT.dwRBitMask);
    assert.equal(DDPIXELFORMAT.dwZBitMask, DDPIXELFORMAT.dwGBitMask);
    assert.equal(DDPIXELFORMAT.dwStencilBitMask, DDPIXELFORMAT.dwBBitMask);
    assert.equal(DDPIXELFORMAT.dwRGBZBitMask, DDPIXELFORMAT.dwRGBAlphaBitMask);

    // The older descriptor keeps a Z depth where the newer one has only a mip
    // count and a refresh rate, and all of them are the same four bytes.
    assert.equal(DDSURFACEDESC.dwZBufferBitDepth, DDSURFACEDESC.dwMipMapCount);
    assert.equal(DDSURFACEDESC.dwRefreshRate, DDSURFACEDESC.dwMipMapCount);
    assert.equal(DDSURFACEDESC2.dwDepth, DDSURFACEDESC2.dwBackBufferCount);
    assert.equal(DDSURFACEDESC2.dwFVF, DDSURFACEDESC2.ddpfPixelFormat);
});

test('both layouts read back the values they were given', ()=>{
    const memory = fakeMemory();

    for (const layout of [DDSURFACEDESC, DDSURFACEDESC2])
    {
        putDesc(memory, layout);
        const desc = readSurfaceDesc(memory, DESC, layout);
        assert.ok(desc);
        assert.equal(desc.width, 128);
        assert.equal(desc.height, 64);
        assert.equal(desc.pitch, 512);
        assert.equal(desc.backBufferCount, 3);
        assert.equal(desc.mipMapCount, 5);
        assert.equal(desc.caps, DDSCAPS_OFFSCREENPLAIN);
        assert.equal(desc.pixelFormat.flags, DDPF_RGB);
        assert.equal(desc.pixelFormat.bitCount, 16);
        assert.equal(desc.pixelFormat.redMask, 0xf800);
    }

    putDesc(memory, DDSURFACEDESC);
    assert.equal(readSurfaceDesc(memory, DESC, DDSURFACEDESC)?.caps2, 0,
        'the older layout has no second caps word and reports none');
});

test('a size that is not exactly the layout\'s own is refused', ()=>{
    const memory = fakeMemory();

    for (const layout of [DDSURFACEDESC, DDSURFACEDESC2])
    {
        for (const size of [layout.SIZE - 1, layout.SIZE + 1, 0])
        {
            putDesc(memory, layout, { size });
            assert.equal(readSurfaceDesc(memory, DESC, layout), null);
        }
    }

    // The two layouts share their first 0x68 bytes, so each other's size is
    // exactly the mistake that would otherwise parse into believable values.
    putDesc(memory, DDSURFACEDESC, { size: DDSURFACEDESC2.SIZE });
    assert.equal(readSurfaceDesc(memory, DESC, DDSURFACEDESC), null);
    putDesc(memory, DDSURFACEDESC2, { size: DDSURFACEDESC.SIZE });
    assert.equal(readSurfaceDesc(memory, DESC, DDSURFACEDESC2), null);
});

test('the second caps word is read from the offset the newer layout gave it', ()=>{
    const memory = fakeMemory();
    putDesc(memory, DDSURFACEDESC2);

    const desc = readSurfaceDesc(memory, DESC, DDSURFACEDESC2);
    assert.equal(desc?.caps2, DDSCAPS2_TEXTUREMANAGE);
    assert.equal(readU32(memory, DESC + 0x6c), DDSCAPS2_TEXTUREMANAGE,
        'which is four bytes past the first, not four bytes past the end');
});

test('writing a descriptor fills the fields a reader will look at', ()=>{
    const memory = fakeMemory();
    memory.fill(DESC, DDSURFACEDESC2.SIZE / 4);

    writeSurfaceDesc(memory, DESC, DDSURFACEDESC2, {
        flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT,
        width: 320,
        height: 200,
        pitch: 1280,
        backBufferCount: 2,
        mipMapCount: 0,
        caps: DDSCAPS_OFFSCREENPLAIN,
        caps2: DDSCAPS2_TEXTUREMANAGE,
        surfacePointer: 0x40001000,
        pixelFormat: {
            size: DDPIXELFORMAT.SIZE,
            flags: DDPF_PALETTEINDEXED8,
            fourCC: 0,
            bitCount: 8,
            redMask: 0,
            greenMask: 0,
            blueMask: 0,
            alphaMask: 0,
        },
    });

    const readBack = readSurfaceDesc(memory, DESC, DDSURFACEDESC2);
    assert.ok(readBack, 'the size it wrote is the one the reader demands');
    assert.equal(readBack.width, 320);
    assert.equal(readBack.height, 200);
    assert.equal(readBack.caps2, DDSCAPS2_TEXTUREMANAGE);
    assert.equal(readBack.pixelFormat.flags, DDPF_PALETTEINDEXED8);
    assert.equal(readU32(memory, DESC + DDSURFACEDESC2.lpSurface), 0x40001000);
    assert.equal(readU32(memory, DESC + DDSURFACEDESC2.dwTextureStage), UNTOUCHED,
        'and it stops where the structure it was asked for stops');
});

test('a pixel format survives a round trip through guest memory', ()=>{
    const memory = fakeMemory();
    const zBuffer = {
        size: DDPIXELFORMAT.SIZE,
        flags: DDPF_ZBUFFER,
        fourCC: 0,
        bitCount: 16,
        redMask: 8,
        greenMask: 0x0000ffff,
        blueMask: 0x00ff0000,
        alphaMask: 0,
    };

    writePixelFormat(memory, DESC, zBuffer);
    assert.deepEqual(readPixelFormat(memory, DESC), zBuffer);
    assert.equal(readU32(memory, DESC + DDPIXELFORMAT.dwZBufferBitDepth), 16,
        'a depth written as a bit count is read back under its own name');
    assert.equal(readU32(memory, DESC + DDPIXELFORMAT.dwZBitMask), 0x0000ffff);
});

test('a format that names no bit count has no bytes per pixel to give', ()=>{
    /** @param {number} bitCount */
    const format = bitCount=>({
        size: DDPIXELFORMAT.SIZE,
        flags: DDPF_RGB,
        fourCC: 0,
        bitCount,
        redMask: 0,
        greenMask: 0,
        blueMask: 0,
        alphaMask: 0,
    });

    assert.equal(bytesPerPixel(format(8)), 1);
    assert.equal(bytesPerPixel(format(16)), 2);
    assert.equal(bytesPerPixel(format(24)), 3);
    assert.equal(bytesPerPixel(format(32)), 4);
    assert.equal(bytesPerPixel(format(4)), 1, 'a sub-byte format still occupies one');
    assert.equal(bytesPerPixel(format(0)), 0,
        'and a compressed one says nothing rather than something plausible');
});
