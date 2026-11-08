/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The GIF and TIFF decoders against ImageMagick's decoding of the same files
 * (`pictures.fixture.js`): plain and interlaced GIF, a GIF whose codes grow to
 * nine bits and more, TIFF plain, LZW (with horizontal differencing), PackBits,
 * with alpha, bilevel and palette.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GifError, decodeGif, isGif } from './gif.js';
import { TiffError, decodeTiff, isTiff } from './tiff.js';
import { PICTURES } from './pictures.fixture.js';

/** @param {ArrayLike<number>} bytes */
const fnv = bytes=>{
    let hash = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++)
    {
        hash = Math.imul(hash ^ bytes[i], 0x01000193) >>> 0;
    }
    return hash;
};

/** @param {string} b64 */
const bytesOf = b64=>Uint8Array.from(Buffer.from(b64, 'base64'));

for (const [name, picture] of Object.entries(PICTURES))
{
    test(`${name}: the texels ImageMagick decodes it to`, ()=>{
        const bytes = bytesOf(picture.file);
        const gif = name.startsWith('gif');
        assert.equal(gif ? isGif(bytes) : isTiff(bytes), true);
        const decoded = gif ? decodeGif(bytes) : decodeTiff(bytes);
        assert.deepEqual([decoded.width, decoded.height], [picture.width, picture.height]);
        if (picture.rgba)
        {
            assert.deepEqual([...decoded.rgba], picture.rgba);
        }
        assert.equal(fnv(decoded.rgba), picture.hash);
    });
}

test('a file cut short or of a kind not read is refused with the reason', ()=>{
    const gif = bytesOf(PICTURES.gif_plain.file);
    assert.throws(()=>decodeGif(gif.subarray(0, 12)), GifError);
    assert.throws(()=>decodeGif(Uint8Array.of(0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0,
        0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 1, 0, 0x3b)), /no colour table/);
    const tiff = bytesOf(PICTURES.tiff_rgb_raw.file);
    assert.throws(()=>decodeTiff(tiff.subarray(0, 12)), TiffError);
    assert.equal(isTiff(Uint8Array.of(0x49, 0x49, 0x2b, 0, 0, 0, 0, 0)), false, 'BigTIFF');
});
