/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rgbHeader, videoInfo } from './transforms.js';
import { FORMAT_VIDEO_INFO, MEDIATYPE_VIDEO } from './filter.js';

test('an RGB header\'s rows are padded to four bytes, and its image is every row', ()=>{
    const header = new DataView(rgbHeader(3, 2, 24).buffer);
    assert.equal(header.getUint32(0, true), 40);
    assert.equal(header.getInt32(4, true), 3);
    assert.equal(header.getInt32(8, true), 2);
    assert.equal(header.getUint16(14, true), 24);
    assert.equal(header.getUint32(16, true), 0, 'BI_RGB');
    assert.equal(header.getUint32(20, true), 12 * 2, 'nine bytes a row, padded to twelve');
});

test('a decompressed type keeps the source\'s rectangles and frame time over the new header', ()=>{
    const like = new Uint8Array(0x30 + 40);
    new DataView(like.buffer).setUint32(0x28, 400_000, true);
    const type = videoInfo(rgbHeader(4, 4, 32), like);
    assert.equal(type.major, MEDIATYPE_VIDEO);
    assert.equal(type.sub, '{E436EB7E-524F-11CE-9F53-0020AF0BA770}', 'RGB32');
    assert.equal(type.formatType, FORMAT_VIDEO_INFO);
    assert.equal(type.fixed, true);
    assert.equal(type.temporal, false);
    assert.equal(type.sampleSize, 64);
    assert.equal(new DataView(type.format.buffer).getUint32(0x28, true), 400_000);
});
