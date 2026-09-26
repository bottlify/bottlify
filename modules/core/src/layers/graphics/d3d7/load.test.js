/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * IDirect3DDevice7::Load against Wine's ddraw7 test_device_load and
 * test_texture_load_ckey: which copies are refused, which texels land where
 * down both chains, and what goes along with them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTexture } from './load.js';
import { D3D_OK, DDERR_INVALIDPARAMS } from './constants.js';
import { createDirectDraw } from '../ddraw/objects.js';
import {
    DDCKEY_SRCBLT, DDERR_NOCOLORKEY, DDERR_NOPALETTEATTACHED, DDPCAPS_8BIT, DDPCAPS_ALLOW256,
    DDPF_PALETTEINDEXED8, DDPF_RGB, DDSCAPS_COMPLEX, DDSCAPS_MIPMAP, DDSCAPS_SYSTEMMEMORY,
    DDSCAPS_TEXTURE, DDSCL_NORMAL, DDSD_CAPS, DDSD_HEIGHT, DDSD_MIPMAPCOUNT, DDSD_PIXELFORMAT,
    DDSD_WIDTH,
} from '../ddraw/constants.js';

const XRGB32 = Object.freeze({
    size: 0x20, flags: DDPF_RGB, fourCC: 0, bitCount: 32,
    redMask: 0xff0000, greenMask: 0xff00, blueMask: 0xff, alphaMask: 0,
});

const PALETTED = Object.freeze({
    size: 0x20, flags: DDPF_RGB | DDPF_PALETTEINDEXED8, fourCC: 0, bitCount: 8,
    redMask: 0, greenMask: 0, blueMask: 0, alphaMask: 0,
});

/** A DirectDraw object whose surfaces live in a flat buffer the test can read. */
function world(){
    const ram = new Uint8Array(4 << 20);
    let next = 0x1000;
    const root = createDirectDraw({
        version: 7,
        allocate: bytes=>{
            const at = next;
            next += bytes + 0xfff & ~0xfff;
            return at;
        },
    });
    root.setCooperativeLevel(0x00010044, DDSCL_NORMAL);
    const memory = {
        /** @param {number} at @param {number} length */
        readMemory: (at, length)=>ram.slice(at, at + length),
        /** @param {number} at @param {Uint8Array} bytes */
        writeMemory: (at, bytes)=>ram.set(bytes, at),
    };
    const words = new DataView(ram.buffer);
    /**
     * @param {{ width: number, height: number, mip?: boolean, count?: number, caps?: number,
     *   format?: any }} spec
     */
    const texture = spec=>{
        const made = root.createSurface({
            flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT
                | (spec.count ? DDSD_MIPMAPCOUNT : 0),
            caps: DDSCAPS_TEXTURE | (spec.caps ?? 0)
                | (spec.mip ? DDSCAPS_COMPLEX | DDSCAPS_MIPMAP : 0),
            width: spec.width,
            height: spec.height,
            mipMapCount: spec.count ?? 0,
            pixelFormat: spec.format ?? XRGB32,
        });
        assert.equal(made.hr, D3D_OK);
        return /** @type {any} */ (made.surface);
    };
    /** @param {any} surface @returns {any[]} */
    const levels = surface=>(surface ? [surface, ...levels(surface.mipNext)] : []);
    /** Every level's texel is its level in red, x in green and y in blue. */
    const paint = (/** @type {any} */ surface)=>levels(surface).forEach((level, index)=>{
        for (let y = 0; y < level.height; y++)
        {
            for (let x = 0; x < level.width; x++)
            {
                words.setUint32(level.buffer + y * level.pitch + x * 4,
                    (index << 16) | (x << 8) | y, true);
            }
        }
    });
    /** @param {any} level @param {number} x @param {number} y */
    const texel = (level, x, y)=>words.getUint32(level.buffer + y * level.pitch + x * 4, true);
    return { root, memory, ram, texture, levels, paint, texel };
}

/** Wine's test_device_load table, the rows that need no cube map. */
const TABLE = [
    [128, 128, 0, [0, 0, 0, 0], 'mip', 128, 128, 0, [0, 0], 'mip', DDERR_INVALIDPARAMS],
    [128, 128, 0, [0, 0, 100, 100], 'mip', 128, 128, 0, [50, 50], 'mip', DDERR_INVALIDPARAMS],
    [128, 128, 0, [30, 20, 93, 52], 'mip', 128, 128, 0, [31, 31], 'mip', D3D_OK],
    [128, 128, 0, null, '', 128, 128, 0, null, '', D3D_OK],
    [128, 128, 0, null, '', 256, 128, 0, null, '', DDERR_INVALIDPARAMS],
    [256, 128, 0, null, '', 128, 128, 0, null, '', DDERR_INVALIDPARAMS],
    [128, 128, 0, [30, 20, 93, 52], 'mip', 128, 128, 4, [31, 31], 'mip', D3D_OK],
    [128, 128, 4, [30, 20, 93, 52], 'mip', 128, 128, 0, [31, 31], 'mip', DDERR_INVALIDPARAMS],
    [128, 128, 0, [32, 32, 96, 96], 'mip', 32, 32, 0, [32, 32], '', D3D_OK],
    [128, 128, 0, [0, 0, 64, 64], 'mip', 32, 32, 4, [0, 0], 'mip', D3D_OK],
];

test('Load copies the rectangle down both chains, from the source level the size of the top', ()=>{
    for (const [srcW, srcH, srcCount, rectAt, srcMip, dstW, dstH, dstCount, pointAt, dstMip, hr]
        of /** @type {any[][]} */ (TABLE))
    {
        const w = world();
        const src = w.texture({ width: srcW, height: srcH, mip: srcMip === 'mip',
            count: srcCount });
        const dest = w.texture({ width: dstW, height: dstH, mip: dstMip === 'mip',
            count: dstCount });
        w.paint(src);
        const srcRect = rectAt
            ? { left: rectAt[0], top: rectAt[1], right: rectAt[2], bottom: rectAt[3] }
            : null;
        const destPoint = pointAt ? { x: pointAt[0], y: pointAt[1] } : null;
        const row = `${srcW}x${srcH} ${JSON.stringify(rectAt)} to ${dstW}x${dstH}`;
        assert.equal(loadTexture({ memory: w.memory, dest, destPoint, src, srcRect }), hr, row);
        if (hr !== D3D_OK)
        {
            assert.ok(w.levels(dest).every(level=>w.texel(level, 0, 0) === 0), 'nothing moved');
            continue;
        }

        let offset = 0;
        for (let k = srcW; k > dstW; k /= 2)
        {
            offset++;
        }
        let rect = srcRect ?? { left: 0, top: 0, right: srcW, bottom: srcH };
        let point = destPoint ?? { x: 0, y: 0 };
        const halve = ()=>{
            rect = { left: rect.left >> 1, top: rect.top >> 1,
                right: (rect.right + 1) >> 1, bottom: (rect.bottom + 1) >> 1 };
            point = { x: point.x >> 1, y: point.y >> 1 };
        };
        for (let k = 0; k < offset; k++)
        {
            halve();
        }
        w.levels(dest).forEach((level, index)=>{
            let wrong = 0;
            for (let y = 0; y < level.height; y++)
            {
                for (let x = 0; x < level.width; x++)
                {
                    const inside = x >= point.x && x < point.x + rect.right - rect.left
                        && y >= point.y && y < point.y + rect.bottom - rect.top;
                    const expected = inside
                        ? ((index + offset) << 16) | ((x + rect.left - point.x) << 8)
                            | (y + rect.top - point.y)
                        : 0;
                    wrong += w.texel(level, x, y) === expected ? 0 : 1;
                }
            }
            assert.equal(wrong, 0, `${row}, level ${index}`);
            halve();
        });
    }
});

test('Load carries the source colour key, and takes the destination\'s away with none', ()=>{
    // Wine's ddraw7 test_texture_load_ckey.
    const w = world();
    const src = w.texture({ width: 128, height: 128, caps: DDSCAPS_SYSTEMMEMORY });
    const dest = w.texture({ width: 128, height: 128 });

    assert.equal(loadTexture({ memory: w.memory, dest, destPoint: null, src, srcRect: null }),
        D3D_OK);
    assert.equal(dest.getColorKey(DDCKEY_SRCBLT).hr, DDERR_NOCOLORKEY);

    assert.equal(src.setColorKey(DDCKEY_SRCBLT, { low: 0xff00, high: 0xff00 }), D3D_OK);
    assert.equal(loadTexture({ memory: w.memory, dest, destPoint: null, src, srcRect: null }),
        D3D_OK);
    assert.deepEqual(dest.getColorKey(DDCKEY_SRCBLT).key, { low: 0xff00, high: 0xff00 });

    assert.equal(dest.setColorKey(DDCKEY_SRCBLT, { low: 0xff, high: 0xff }), D3D_OK);
    assert.equal(loadTexture({ memory: w.memory, dest, destPoint: null, src, srcRect: null }),
        D3D_OK);
    assert.deepEqual(dest.getColorKey(DDCKEY_SRCBLT).key, { low: 0xff00, high: 0xff00 },
        'the destination\'s is overwritten');

    assert.equal(src.setColorKey(DDCKEY_SRCBLT, null), D3D_OK);
    assert.equal(loadTexture({ memory: w.memory, dest, destPoint: null, src, srcRect: null }),
        D3D_OK);
    assert.equal(dest.getColorKey(DDCKEY_SRCBLT).hr, DDERR_NOCOLORKEY);

    assert.equal(src.release(), 0);
    assert.equal(dest.release(), 0);
});

test('Load copies palette entries into a palette the destination has, and sets none', ()=>{
    // Wine's ddraw7 test_device_load, the palette and colour-key part.
    const w = world();
    const src = w.texture({ width: 128, height: 128, mip: true, format: PALETTED });
    const dest = w.texture({ width: 128, height: 128, mip: true, format: PALETTED });
    const entry = (/** @type {number} */ blue)=>[blue << 16, ...new Array(255).fill(0)];
    const srcPalette = /** @type {any} */ (w.root.createPalette(DDPCAPS_ALLOW256 | DDPCAPS_8BIT,
        entry(1)).palette);
    const destPalette = /** @type {any} */ (w.root.createPalette(DDPCAPS_ALLOW256 | DDPCAPS_8BIT,
        entry(3)).palette);
    assert.equal(src.setPalette(srcPalette), D3D_OK);

    assert.equal(loadTexture({ memory: w.memory, dest, destPoint: null, src, srcRect: null }),
        D3D_OK);
    assert.equal(dest.getPalette().hr, DDERR_NOPALETTEATTACHED);

    assert.equal(dest.setPalette(destPalette), D3D_OK);
    assert.equal(loadTexture({ memory: w.memory, dest, destPoint: null, src, srcRect: null }),
        D3D_OK);
    const held = dest.getPalette();
    assert.equal(held.palette, destPalette, 'the destination keeps its own palette');
    assert.equal((held.palette.entries[0] >>> 16) & 0xff, 1, 'with the source\'s colours');
    held.palette.release();

    assert.equal(src.setColorKey(DDCKEY_SRCBLT, { low: 32, high: 64 }), D3D_OK);
    assert.equal(loadTexture({ memory: w.memory, dest, destPoint: null, src, srcRect: null }),
        D3D_OK);
    assert.deepEqual(dest.getColorKey(DDCKEY_SRCBLT).key, { low: 32, high: 32 });

    assert.equal(src.release(), 0);
    assert.equal(dest.release(), 0);
    assert.equal(srcPalette.release(), 0);
    assert.equal(destPalette.release(), 0);
});

test('Load marks every destination level it wrote as changed', ()=>{
    const w = world();
    const src = w.texture({ width: 8, height: 8, mip: true });
    const dest = w.texture({ width: 8, height: 8, mip: true });
    const before = w.levels(dest).map(level=>level.uniquenessValue());
    assert.equal(loadTexture({ memory: w.memory, dest, destPoint: null, src, srcRect: null }),
        D3D_OK);
    w.levels(dest).forEach((level, index)=>
        assert.notEqual(level.uniquenessValue(), before[index], `level ${index}`));
    assert.equal(src.release(), 0);
    assert.equal(dest.release(), 0);
});
