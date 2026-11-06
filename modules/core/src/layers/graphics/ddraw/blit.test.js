/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Every test here is byte-exact: guest memory is a Uint8Array the test owns,
 * and after a blit the surface's bytes are compared byte for byte against what
 * the arithmetic says they must be. Nothing is a GPU's to get wrong, so nothing
 * is compared within a tolerance.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    DDBLTFAST_DESTCOLORKEY, DDBLTFAST_SRCCOLORKEY, DDBLT_COLORFILL, DDBLT_KEYDEST, DDBLT_KEYSRC,
    DDBLT_WAIT, DDERR_INVALIDPARAMS, DDERR_INVALIDRECT, DDERR_UNSUPPORTED, DDBLT_ROP, DDBLT_DDFX,
    DDBLTFX_MIRRORLEFTRIGHT, DDBLTFX_MIRRORUPDOWN, DDERR_NORASTEROPHW, ROP,
} from './constants.js';
import { blt, bltFast, readPixel, writePixel } from './blit.js';

const BASE = 0x100;

/** A flat address space holding whatever surfaces a test lays out in it. */
function ram(size = 0x800){
    const bytes = new Uint8Array(size);
    return {
        bytes,
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.slice(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>
            bytes.set(value, at),
    };
}

/**
 * @param {number} buffer @param {number} width @param {number} height
 * @param {number} bytesPerPixel @param {number} [pitch]
 */
function surface(buffer, width, height, bytesPerPixel, pitch = width * bytesPerPixel){
    return { buffer, width, height, bytesPerPixel, pitch };
}

/** The bytes of a surface, row by row, padding included. */
const bytesOf = (/** @type {any} */ memory, /** @type {any} */ s)=>[
    ...memory.bytes.subarray(s.buffer, s.buffer + s.pitch * s.height)];

/**
 * Fills a surface so that every pixel is its own index, at the surface's width.
 *
 * @param {any} memory @param {any} s
 */
function number(memory, s){
    for (let y = 0; y < s.height; y++)
    {
        for (let x = 0; x < s.width; x++)
        {
            writePixel(memory, s, x, y, y * s.width + x + 1);
        }
    }
}

/** @param {any} memory @param {any} s */
const grid = (memory, s)=>Array.from({ length: s.height }, (_, y)=>
    Array.from({ length: s.width }, (_unused, x)=>readPixel(memory, s, x, y)));

test('byte-exact: a colour fill writes the value at the pixel width, low byte first', ()=>{
    const memory = ram();
    const fill = 0x11223344;

    const wide = surface(BASE, 2, 1, 4);
    assert.equal(blt({ memory, dest: wide, flags: DDBLT_COLORFILL, fx: { fillColor: fill } }), 0);
    assert.deepEqual(bytesOf(memory, wide), [0x44, 0x33, 0x22, 0x11, 0x44, 0x33, 0x22, 0x11]);

    const half = surface(BASE + 0x20, 2, 1, 2);
    assert.equal(blt({ memory, dest: half, flags: DDBLT_COLORFILL, fx: { fillColor: fill } }), 0);
    assert.deepEqual(bytesOf(memory, half), [0x44, 0x33, 0x44, 0x33], 'the top word is dropped');

    const byte = surface(BASE + 0x40, 2, 1, 1);
    assert.equal(blt({ memory, dest: byte, flags: DDBLT_COLORFILL, fx: { fillColor: fill } }), 0);
    assert.deepEqual(bytesOf(memory, byte), [0x44, 0x44]);
});

test('byte-exact: a fill of a rectangle leaves everything outside it alone', ()=>{
    const memory = ram();
    const dest = surface(BASE, 4, 4, 1);
    number(memory, dest);
    assert.equal(blt({
        memory, dest, destRect: { left: 1, top: 1, right: 3, bottom: 3 },
        flags: DDBLT_COLORFILL | DDBLT_WAIT, fx: { fillColor: 0xee },
    }), 0);
    assert.deepEqual(grid(memory, dest), [
        [1, 2, 3, 4],
        [5, 0xee, 0xee, 8],
        [9, 0xee, 0xee, 12],
        [13, 14, 15, 16],
    ]);
});

test('byte-exact: a straight copy reproduces the source, whole and by rectangle', ()=>{
    const memory = ram();
    const src = surface(BASE, 4, 4, 4);
    const dest = surface(BASE + 0x100, 4, 4, 4);
    number(memory, src);

    assert.equal(blt({ memory, dest, src, flags: 0 }), 0);
    assert.deepEqual(bytesOf(memory, dest), bytesOf(memory, src));

    number(memory, dest);
    assert.equal(blt({
        memory, dest, destRect: { left: 2, top: 2, right: 4, bottom: 4 },
        src, srcRect: { left: 0, top: 0, right: 2, bottom: 2 }, flags: 0,
    }), 0);
    assert.deepEqual(grid(memory, dest), [
        [1, 2, 3, 4],
        [5, 6, 7, 8],
        [9, 10, 1, 2],
        [13, 14, 5, 6],
    ]);
});

test('byte-exact: a copy between surfaces of different pitch leaves the padding untouched', ()=>{
    const memory = ram();
    const src = surface(BASE, 2, 2, 2, 8);
    const dest = surface(BASE + 0x100, 2, 2, 2, 6);
    memory.bytes.fill(0xaa, dest.buffer, dest.buffer + 12);
    number(memory, src);

    assert.equal(blt({ memory, dest, src, flags: 0 }), 0);
    // Two pixels, two bytes each, then two bytes of padding the blit never saw.
    assert.deepEqual(bytesOf(memory, dest), [
        1, 0, 2, 0, 0xaa, 0xaa,
        3, 0, 4, 0, 0xaa, 0xaa,
    ]);
});

test('byte-exact: a stretch samples by flooring, magnified and shrunk', ()=>{
    const memory = ram();
    const src = surface(BASE, 2, 2, 1);
    number(memory, src);

    const big = surface(BASE + 0x100, 4, 4, 1);
    assert.equal(blt({ memory, dest: big, src, flags: 0 }), 0);
    // Each texel becomes a 2x2 block; the boundary is after column and row one.
    assert.deepEqual(grid(memory, big), [
        [1, 1, 2, 2],
        [1, 1, 2, 2],
        [3, 3, 4, 4],
        [3, 3, 4, 4],
    ]);

    const small = surface(BASE + 0x200, 2, 2, 1);
    number(memory, big);
    assert.equal(blt({ memory, dest: small, src: big, flags: 0 }), 0);
    // Shrinking 2:1 takes the first of each pair, not the average and not the second.
    assert.deepEqual(grid(memory, small), [[1, 3], [9, 11]]);
});

test('byte-exact: a source colour key skips exactly the keyed pixels', ()=>{
    const memory = ram();
    const src = surface(BASE, 4, 1, 1);
    const dest = surface(BASE + 0x100, 4, 1, 1);
    number(memory, src);
    memory.bytes.fill(0x77, dest.buffer, dest.buffer + 4);

    assert.equal(blt({
        memory, dest, src, flags: DDBLT_KEYSRC, fx: { srcColorKey: { low: 2, high: 3 } },
    }), 0);
    assert.deepEqual(grid(memory, dest), [[1, 0x77, 0x77, 4]], 'the range is inclusive both ends');
});

test('byte-exact: a destination colour key writes only where the destination is keyed', ()=>{
    const memory = ram();
    const src = surface(BASE, 4, 1, 2);
    const dest = surface(BASE + 0x100, 4, 1, 2);
    number(memory, src);
    [0x10, 0x20, 0x30, 0x40].forEach((value, x)=>writePixel(memory, dest, x, 0, value));

    assert.equal(blt({
        memory, dest, src, flags: DDBLT_KEYDEST, fx: { destColorKey: { low: 0x20, high: 0x30 } },
    }), 0);
    assert.deepEqual(grid(memory, dest), [[0x10, 2, 3, 0x40]]);
});

test('byte-exact: a self-overlapping copy is the same in both directions as via a copy', ()=>{
    const layout = ()=>{
        const memory = ram();
        const s = surface(BASE, 4, 4, 4);
        number(memory, s);
        return { memory, s };
    };
    const shift = (/** @type {number} */ dx, /** @type {number} */ dy)=>{
        const { memory, s } = layout();
        const from = { left: 1, top: 1, right: 4, bottom: 4 };
        assert.equal(blt({
            memory, dest: s, src: s, flags: 0, srcRect: from,
            destRect: { left: from.left + dx, top: from.top + dy,
                right: from.right + dx, bottom: from.bottom + dy },
        }), 0);
        return grid(memory, s);
    };
    // Written out by hand: the 3x3 block at (1,1) moved to (0,0) and to (1,1)
    // stays itself, and moved by (-1,-1) lands where a copy through a
    // temporary puts it. A copy in the wrong direction would smear row two
    // into row three.
    assert.deepEqual(shift(-1, -1), [
        [6, 7, 8, 4],
        [10, 11, 12, 8],
        [14, 15, 16, 12],
        [13, 14, 15, 16],
    ], 'up and to the left');
    const { memory, s } = layout();
    assert.equal(blt({
        memory, dest: s, src: s, flags: 0,
        srcRect: { left: 0, top: 0, right: 3, bottom: 3 },
        destRect: { left: 1, top: 1, right: 4, bottom: 4 },
    }), 0);
    assert.deepEqual(grid(memory, s), [
        [1, 2, 3, 4],
        [5, 1, 2, 3],
        [9, 5, 6, 7],
        [13, 9, 10, 11],
    ], 'down and to the right');
});

test('byte-exact: a clip list limits writes to the union of its rectangles', ()=>{
    const memory = ram();
    const dest = surface(BASE, 4, 4, 1);
    assert.equal(blt({
        memory, dest, flags: DDBLT_COLORFILL, fx: { fillColor: 9 },
        clipList: [
            { left: 0, top: 0, right: 2, bottom: 2 },
            { left: 2, top: 2, right: 4, bottom: 4 },
        ],
    }), 0);
    assert.deepEqual(grid(memory, dest), [
        [9, 9, 0, 0],
        [9, 9, 0, 0],
        [0, 0, 9, 9],
        [0, 0, 9, 9],
    ]);
    // Evidence the whole surface is as above and nothing outside the two
    // squares was touched: 16 bytes, base64.
    assert.equal(Buffer.from(bytesOf(memory, dest)).toString('base64'), 'CQkAAAkJAAAAAAkJAAAJCQ==');
});

test('byte-exact: each refusal has its own code and writes nothing', ()=>{
    const memory = ram();
    const dest = surface(BASE, 4, 4, 4);
    const src = surface(BASE + 0x100, 4, 4, 4);
    const narrow = surface(BASE + 0x200, 4, 4, 2);
    number(memory, dest);
    const before = bytesOf(memory, dest);

    assert.equal(blt({ memory, dest, src, flags: 0,
        destRect: { left: 0, top: 0, right: 5, bottom: 4 } }), DDERR_INVALIDRECT, 'past the edge');
    assert.equal(blt({ memory, dest, src, flags: 0,
        destRect: { left: 3, top: 0, right: 1, bottom: 4 } }), DDERR_INVALIDRECT, 'inverted');
    assert.equal(blt({ memory, dest, src, flags: 0,
        srcRect: { left: -1, top: 0, right: 2, bottom: 2 } }), DDERR_INVALIDRECT, 'source too');
    assert.equal(blt({ memory, dest, flags: 0 }), DDERR_INVALIDPARAMS, 'a copy needs a source');
    assert.equal(blt({ memory, dest, src: narrow, flags: 0 }), DDERR_UNSUPPORTED,
        'no conversion between widths');
    assert.deepEqual(bytesOf(memory, dest), before);
});

/** A4R4G4B4, the 16-bit texture format with four bits of alpha. */
const ARGB4444 = { red: 0xf00, green: 0xf0, blue: 0xf, alpha: 0xf000 };

test('byte-exact: a copy between RGB formats re-encodes every channel, opaque where the source '
    + 'has no alpha', ()=>{
    const memory = ram();
    const src = { ...surface(BASE, 2, 1, 3),
        channels: { red: 0xff0000, green: 0xff00, blue: 0xff, alpha: 0 } };
    const dest = { ...surface(BASE + 0x100, 2, 1, 2), channels: ARGB4444 };
    memory.bytes.set([0x00, 0x80, 0xff, 0x11, 0x22, 0x33], BASE);

    assert.equal(blt({ memory, dest, src, flags: DDBLT_WAIT }), 0);
    assert.equal(readPixel(memory, dest, 0, 0), 0xff80, 'red 255, green 128, blue 0');
    assert.equal(readPixel(memory, dest, 1, 0), 0xf321, 'red 0x33, green 0x22, blue 0x11');

    const keyed = { memory, dest, src, flags: DDBLT_KEYSRC,
        fx: { srcColorKey: { low: 0, high: 0 } } };
    assert.equal(blt(keyed), DDERR_UNSUPPORTED, 'a source key is a value of the source format');
    assert.equal(bltFast({ memory, dest, src, x: 0, y: 0, flags: 0 }), 0, 'BltFast converts too');
});

test('byte-exact: a DXT5 source is decompressed into the destination format', ()=>{
    const memory = ram();
    // Two 4x4 blocks: opaque alpha (both endpoints 255), and colour 0 pure
    // red, colour 1 pure blue; the first block selects colour 0 everywhere,
    // the second colour 1.
    const block = (/** @type {number} */ selectors)=>[255, 255, 0, 0, 0, 0, 0, 0,
        0x00, 0xf8, 0x1f, 0x00, selectors, selectors, selectors, selectors];
    memory.bytes.set([...block(0x00), ...block(0x55)], BASE);
    const src = { ...surface(BASE, 8, 4, 0, 32), compressed: /** @type {const} */ ('dxt5') };
    const dest = { ...surface(BASE + 0x100, 8, 4, 2), channels: ARGB4444 };

    assert.equal(blt({ memory, dest, src, flags: DDBLT_WAIT }), 0);
    assert.equal(readPixel(memory, dest, 0, 0), 0xff00);
    assert.equal(readPixel(memory, dest, 3, 3), 0xff00);
    assert.equal(readPixel(memory, dest, 4, 0), 0xf00f);
    assert.equal(readPixel(memory, dest, 7, 3), 0xf00f);

    const corner = { ...surface(BASE + 0x200, 2, 2, 2), channels: ARGB4444 };
    assert.equal(blt({ memory, dest: corner, src, flags: 0,
        srcRect: { left: 3, top: 2, right: 5, bottom: 4 } }), 0);
    assert.deepEqual([0, 1].map(x=>readPixel(memory, corner, x, 1)), [0xff00, 0xf00f],
        'a rectangle across two blocks');

    assert.equal(blt({ memory, dest: surface(BASE + 0x300, 8, 4, 2), src, flags: 0 }),
        DDERR_UNSUPPORTED, 'only into an RGB format');
});

test('byte-exact: BltFast copies at an offset and refuses to fall off the surface', ()=>{
    const memory = ram();
    const src = surface(BASE, 2, 2, 1);
    const dest = surface(BASE + 0x100, 4, 4, 1);
    number(memory, src);

    assert.equal(bltFast({ memory, dest, x: 2, y: 1, src, flags: 0 }), 0);
    assert.deepEqual(grid(memory, dest), [
        [0, 0, 0, 0],
        [0, 0, 1, 2],
        [0, 0, 3, 4],
        [0, 0, 0, 0],
    ]);
    assert.equal(bltFast({ memory, dest, x: 3, y: 0, src, flags: 0 }), DDERR_INVALIDRECT);
    assert.equal(bltFast({ memory, dest, x: 0, y: 0, flags: 0 }), DDERR_INVALIDPARAMS);

    assert.equal(bltFast({
        memory, dest, x: 0, y: 0, src, flags: DDBLTFAST_SRCCOLORKEY,
        srcColorKey: { low: 1, high: 1 },
    }), 0);
    assert.deepEqual(grid(memory, dest)[0], [0, 2, 0, 0], 'the keyed source pixel stayed away');
    assert.equal(bltFast({
        memory, dest, x: 0, y: 2, src, flags: DDBLTFAST_DESTCOLORKEY,
        destColorKey: { low: 0, high: 0 },
    }), 0);
    assert.deepEqual(grid(memory, dest)[2], [1, 2, 3, 4], 'only the zero destination pixels took');
});

test('a fill, a copy and a source-keyed copy with nothing clipped land as the clipped loop lands '
    + 'them, at every depth, over a window that sees the writes', ()=>{
    // A clip list holding the whole destination clips nothing and takes the
    // pixel-at-a-time loop; without one the same blit is done a row at a time.
    let seed = 7;
    const random = ()=>{
        seed = (seed * 1103515245 + 12345) >>> 0;
        return seed >>> 8;
    };
    for (const bytesPerPixel of [1, 2, 4])
    {
        for (let trial = 0; trial < 40; trial++)
        {
            const runs = [false, true].map(clipped=>{
                seed = trial * 31 + bytesPerPixel;
                const bytes = new Uint8Array(0x4000);
                for (let at = 0; at < bytes.length; at++)
                {
                    bytes[at] = random() & 3;
                }
                const memory = {
                    bytes,
                    readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
                        bytes.slice(at, at + length),
                    windowMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
                        bytes.subarray(at, at + length),
                    writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>
                        bytes.set(value, at),
                };
                const dest = { ...surface(0x100, 13, 9, bytesPerPixel, 13 * bytesPerPixel + 3),
                    keyMask: trial % 3 === 0 ? 0x0f0f0f0f : undefined };
                const src = { ...surface(0x1000, 7, 5, bytesPerPixel), keyMask: dest.keyMask };
                const destRect = { left: 1 + random() % 5, top: random() % 4, right: 0, bottom: 0 };
                destRect.right = destRect.left + 7;
                destRect.bottom = destRect.top + 5;
                const clipList = clipped ? [{ left: 0, top: 0, right: 13, bottom: 9 }] : undefined;
                const key = { low: 1, high: 1 + (trial & 1) };
                const kind = trial % 3;
                if (kind === 0)
                {
                    assert.equal(blt({ memory, dest, destRect, flags: DDBLT_COLORFILL,
                        fx: { fillColor: 0x01020304 + trial }, clipList }), 0);
                }
                else
                {
                    assert.equal(blt({ memory, dest, destRect, src,
                        flags: kind === 2 ? DDBLT_KEYSRC : 0, fx: { srcColorKey: key },
                        clipList }), 0);
                }
                return bytesOf(memory, dest);
            });
            assert.deepEqual(runs[0], runs[1], `${bytesPerPixel} bytes a pixel, trial ${trial}`);
        }
    }
});

test('a raster operation: BLACKNESS and WHITENESS fill without a source, SRCCOPY copies, '
    + 'any other is refused', ()=>{
    const memory = ram();
    const dest = surface(BASE, 2, 2, 2);
    number(memory, dest);
    assert.equal(blt({ memory, dest, flags: DDBLT_ROP, fx: { rop: ROP.WHITENESS } }), 0);
    assert.deepEqual(grid(memory, dest), [[0xffff, 0xffff], [0xffff, 0xffff]]);
    assert.equal(blt({ memory, dest, flags: DDBLT_ROP, fx: { rop: ROP.BLACKNESS },
        destRect: { left: 1, top: 0, right: 2, bottom: 2 } }), 0);
    assert.deepEqual(grid(memory, dest), [[0xffff, 0], [0xffff, 0]]);
    const src = surface(BASE + 0x40, 2, 2, 2);
    number(memory, src);
    assert.equal(blt({ memory, dest, src, flags: DDBLT_ROP, fx: { rop: ROP.SRCCOPY } }), 0);
    assert.deepEqual(grid(memory, dest), [[1, 2], [3, 4]]);
    // SRCINVERT, which nothing here makes.
    assert.equal(blt({ memory, dest, src, flags: DDBLT_ROP, fx: { rop: 0x00660046 } }),
        DDERR_NORASTEROPHW);
    assert.deepEqual(grid(memory, dest), [[1, 2], [3, 4]], 'and nothing is written');
});

test('the effects a blit makes: mirrored either way or both, stretched too; any other is refused',
    ()=>{
        const memory = ram();
        const src = surface(BASE, 3, 2, 1);
        number(memory, src);
        const dest = surface(BASE + 0x40, 3, 2, 1);
        const mirrored = (/** @type {number} */ ddfx, /** @type {any} */ to = dest)=>{
            assert.equal(blt({ memory, dest: to, src, flags: DDBLT_DDFX, fx: { ddfx } }), 0);
            return grid(memory, to);
        };
        assert.deepEqual(mirrored(DDBLTFX_MIRRORLEFTRIGHT), [[3, 2, 1], [6, 5, 4]]);
        assert.deepEqual(mirrored(DDBLTFX_MIRRORUPDOWN), [[4, 5, 6], [1, 2, 3]]);
        assert.deepEqual(mirrored(DDBLTFX_MIRRORLEFTRIGHT | DDBLTFX_MIRRORUPDOWN),
            [[6, 5, 4], [3, 2, 1]]);
        assert.deepEqual(mirrored(DDBLTFX_MIRRORLEFTRIGHT, surface(BASE + 0x80, 6, 2, 1)),
            [[3, 3, 2, 2, 1, 1], [6, 6, 5, 5, 4, 4]], 'stretched and mirrored');
        assert.deepEqual(mirrored(0), [[1, 2, 3], [4, 5, 6]], 'no effect is a copy');
        // DDBLTFX_ROTATE90.
        assert.equal(blt({ memory, dest, src, flags: DDBLT_DDFX, fx: { ddfx: 0x00000200 } }),
            DDERR_UNSUPPORTED);
    });

test('a rectangle past the surface is cut by a clipper, the source with it; without one refused',
    ()=>{
        const memory = ram();
        const src = surface(BASE, 4, 2, 1);
        number(memory, src);
        const dest = surface(BASE + 0x40, 4, 2, 1);
        const destRect = { left: -2, top: 0, right: 2, bottom: 2 };
        assert.equal(blt({ memory, dest, src, flags: 0, destRect }), DDERR_INVALIDRECT);
        const clipList = [{ left: 0, top: 0, right: 4, bottom: 2 }];
        assert.equal(blt({ memory, dest, src, flags: 0, destRect, clipList }), 0);
        assert.deepEqual(grid(memory, dest), [[3, 4, 0, 0], [7, 8, 0, 0]],
            'the source columns that land on the surface');
        assert.equal(blt({ memory, dest, src, flags: 0, clipList,
            destRect: { left: 8, top: 0, right: 12, bottom: 2 } }), 0, 'wholly off: nothing');
    });

test('a fill or raster operation is checked before its rectangles: it needs its DDBLTFX, a fill'
    + ' takes no source, a colour fill no raster operation (test_color_fill)', ()=>{
    const memory = ram();
    const dest = surface(BASE, 4, 4, 4);
    const src = surface(BASE + 0x100, 4, 4, 4);
    const DEPTHFILL = 0x02000000;
    const inverted = { left: 3, top: 3, right: 1, bottom: 1 };
    const outside = { left: 0, top: 0, right: 5, bottom: 5 };
    const fx = { fillColor: 0x11223344, rop: ROP.WHITENESS };
    for (const flags of [DDBLT_COLORFILL, DDBLT_ROP, DEPTHFILL])
    {
        assert.equal(blt({ memory, dest, flags, fx, fxGiven: false }), DDERR_INVALIDPARAMS);
    }
    assert.equal(blt({ memory, dest, src, destRect: inverted, flags: DDBLT_COLORFILL, fx }),
        DDERR_INVALIDPARAMS, 'a source, before the inverted rectangle');
    assert.equal(blt({ memory, dest, src, srcRect: inverted, flags: DDBLT_COLORFILL, fx }),
        DDERR_INVALIDPARAMS);
    assert.equal(blt({ memory, dest, destRect: outside, flags: DDBLT_COLORFILL | DDBLT_ROP, fx }),
        DDERR_INVALIDPARAMS);
    assert.equal(blt({ memory, dest, srcRect: inverted, flags: DDBLT_COLORFILL, fx }), 0,
        'a source rectangle with no source is not read');
    // A raster operation that reads no source still checks the one it is given.
    for (const srcRect of [inverted, outside])
    {
        assert.equal(blt({ memory, dest, src, srcRect, flags: DDBLT_ROP, fx }), DDERR_INVALIDRECT);
    }
    assert.equal(blt({ memory, dest, src, flags: DDBLT_ROP, fx }), 0);
    // A copy with no source, before its inverted rectangle (test_blt).
    assert.equal(blt({ memory, dest, destRect: inverted, flags: 0 }), DDERR_INVALIDPARAMS);
    // Both fills on a colour surface: the colour fill is made.
    assert.equal(blt({ memory, dest, flags: DDBLT_COLORFILL | DEPTHFILL, fx }), 0);
    assert.equal(readPixel(memory, dest, 2, 2), 0x11223344);
    // A depth buffer takes a raster fill, and refuses a colour fill whatever else is asked.
    const depth = { ...surface(BASE + 0x200, 2, 2, 2), depth: true };
    assert.equal(blt({ memory, dest: depth, flags: DDBLT_ROP, fx: { rop: ROP.WHITENESS } }), 0);
    assert.deepEqual(grid(memory, depth), [[0xffff, 0xffff], [0xffff, 0xffff]]);
    assert.equal(blt({ memory, dest: depth, flags: DDBLT_COLORFILL | DEPTHFILL, fx }),
        DDERR_INVALIDPARAMS);
});

test('a copy into DXTn blocks encodes the blocks it touched and leaves the rest'
    + ' (test_compressed_surface_stretch)', ()=>{
    const memory = ram(0x1000);
    // 8x8 DXT1: four blocks of eight bytes, all 0xab.
    const dest = { ...surface(BASE, 8, 8, 0, 16), compressed: /** @type {const} */ ('dxt1') };
    memory.bytes.fill(0xab, BASE, BASE + 32);
    // 2x2 of A1R5G5B5 opaque blue, stretched into the dest's (2,2)-(4,4).
    const src = { ...surface(BASE + 0x100, 2, 2, 2),
        channels: { red: 0x7c00, green: 0x3e0, blue: 0x1f, alpha: 0x8000 } };
    for (let k = 0; k < 4; k++)
    {
        writePixel(memory, src, k & 1, k >> 1, 0x801f);
    }
    assert.equal(blt({ memory, dest, src, flags: 0,
        destRect: { left: 2, top: 2, right: 4, bottom: 4 } }), 0);
    assert.deepEqual([...memory.bytes.subarray(BASE + 8, BASE + 32)], new Array(24).fill(0xab),
        'blocks 1 to 3 untouched');
    const view = new DataView(memory.bytes.buffer);
    const c0 = view.getUint16(BASE, true);
    const c1 = view.getUint16(BASE + 2, true);
    const indices = view.getUint32(BASE + 4, true);
    // Texel (2,2) is index 10 of the block: its colour is pure blue.
    const picked = (indices >>> 20) & 3;
    assert.equal(picked === 0 ? c0 : picked === 1 ? c1 : -1, 0x001f);
});

test('a copy between the same colours, the source without alpha, moves the bits as they are'
    + ' (test_surface_format_conversion_alpha)', ()=>{
    const memory = ram();
    const x1 = { ...surface(BASE, 2, 1, 2),
        channels: { red: 0x7c00, green: 0x3e0, blue: 0x1f, alpha: 0 } };
    const a1 = { ...surface(BASE + 0x40, 2, 1, 2),
        channels: { red: 0x7c00, green: 0x3e0, blue: 0x1f, alpha: 0x8000 } };
    writePixel(memory, x1, 0, 0, 0x03e0);
    writePixel(memory, x1, 1, 0, 0x001f);
    assert.equal(blt({ memory, dest: a1, src: x1, flags: 0 }), 0);
    assert.deepEqual(grid(memory, a1), [[0x03e0, 0x001f]], 'the top bit stays clear');
    // With alpha on the source side the alpha is converted as before.
    const r5g6b5 = { ...surface(BASE + 0x80, 2, 1, 2),
        channels: { red: 0xf800, green: 0x7e0, blue: 0x1f, alpha: 0 } };
    writePixel(memory, r5g6b5, 0, 0, 0x07e0);
    writePixel(memory, r5g6b5, 1, 0, 0x001f);
    assert.equal(blt({ memory, dest: a1, src: r5g6b5, flags: 0 }), 0);
    assert.deepEqual(grid(memory, a1), [[0x83e0, 0x801f]], 'another layout is made opaque');
});

test('blocks decoded into a format without alpha fill its unused bits with the texels\' alpha'
    + ' (test_surface_format_conversion_alpha)', ()=>{
    const memory = ram();
    // One DXT1 block, every texel colour 0 = pure blue, opaque.
    const block = new Uint8Array([0x1f, 0x00, 0x00, 0x00, 0, 0, 0, 0]);
    memory.bytes.set(block, BASE);
    const src = { ...surface(BASE, 4, 4, 0, 8), compressed: /** @type {const} */ ('dxt1') };
    const rgbx = { ...surface(BASE + 0x100, 4, 4, 4),
        channels: { red: 0xff0000, green: 0xff00, blue: 0xff, alpha: 0 } };
    assert.equal(blt({ memory, dest: rgbx, src, flags: 0 }), 0);
    assert.equal(readPixel(memory, rgbx, 0, 0) >>> 0, 0xff0000ff);
    const x1 = { ...surface(BASE + 0x200, 4, 4, 2),
        channels: { red: 0x7c00, green: 0x3e0, blue: 0x1f, alpha: 0 } };
    assert.equal(blt({ memory, dest: x1, src, flags: 0 }), 0);
    assert.equal(readPixel(memory, x1, 3, 3), 0x801f);
    const r5g6b5 = { ...surface(BASE + 0x280, 4, 4, 2),
        channels: { red: 0xf800, green: 0x7e0, blue: 0x1f, alpha: 0 } };
    assert.equal(blt({ memory, dest: r5g6b5, src, flags: 0 }), 0);
    assert.equal(readPixel(memory, r5g6b5, 0, 0), 0x001f, 'no bits to spare');
});
