/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { textureFormatOffered } from './texture-formats.js';

test('a texture format is offered when EnumTextureFormats names it, by its fields', ()=>{
    const argb = { flags: 0x40 | 1, fourCC: 0, bitCount: 32, redMask: 0xff0000,
        greenMask: 0xff00, blueMask: 0xff, alphaMask: 0xff000000 };
    assert.equal(textureFormatOffered(argb), true);
    assert.equal(textureFormatOffered({ ...argb, flags: 0x40, alphaMask: 0x12345678 }), true,
        'without DDPF_ALPHAPIXELS the alpha mask is not read');
    assert.equal(textureFormatOffered({ ...argb, redMask: 0xff }), false, 'BGR is not offered');
    assert.equal(textureFormatOffered({ flags: 0x20 | 0x40, fourCC: 0, bitCount: 8, redMask: 0,
        greenMask: 0, blueMask: 0, alphaMask: 0 }), false, 'nor P8');
    assert.equal(textureFormatOffered({ flags: 4, fourCC: 0x31545844, bitCount: 0, redMask: 0,
        greenMask: 0, blueMask: 0, alphaMask: 0 }), true, 'DXT1 by its code');
});
