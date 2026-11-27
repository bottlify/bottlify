/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The texture D3DX 10 and 11 plan of an image and its load information, as
 * Wine's d3dx11 tests say Windows makes it.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DIMENSION } from './dds10.js';
import { dds10 } from './dds10.fixture.js';
import { readImage10 } from './image10.js';
import { DEFAULT_LOAD, D3DX10_FROM_FILE, planTexture } from './load.js';
import { decodeLevel } from './texels.js';

const E_FAIL = 0x80004005 | 0;
const INVALIDCALL = 0x8876086c | 0;

/** @param {import('./dds10.js').DxgiImage} image @param {Partial<import('./load.js').LoadInfo>} [info] */
const plan = (image, info = {})=>{
    /** @type {string[]} */
    const said = [];
    const made = planTexture(image, { ...DEFAULT_LOAD, ...info }, detail=>said.push(detail));
    return { made, said };
};

/** @param {ReturnType<typeof plan>['made']} made */
const desc = made=>('hr' in made ? made.hr : [made.width, made.height, made.depth, made.mips,
    made.arraySize, made.format, made.misc]);

/** An 8x8 R8G8B8A8 file whose four levels are each one colour (red, green, blue, black). */
function levels(){
    const colours = [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [0, 0, 0, 255]];
    const file = dds10({ width: 8, height: 8, format: 28, mips: 4, bytes: (64 + 16 + 4 + 1) * 4 });
    let at = 148;
    [8, 4, 2, 1].forEach((side, level)=>{
        for (let t = 0; t < side * side; t++, at += 4)
        {
            file.set(colours[level], at);
        }
    });
    return readImage10(file);
}

test('the file\'s own levels as they are when nothing differs; the full chain by default', ()=>{
    const image = levels();
    const { made } = plan(image, { mips: D3DX10_FROM_FILE });
    assert.deepEqual(desc(made), [8, 8, 1, 4, 1, 28, 0]);
    assert.ok(!('hr' in made) && made.subresources[0].data === image.levels[0].data);
    const single = readImage10(dds10({ width: 4, height: 4, format: 61, bytes: 16 }));
    assert.deepEqual(desc(plan(single).made), [4, 4, 1, 3, 1, 61, 0]);
});

test('FirstMipLevel loads from that level into a texture of the file\'s own size; past the last'
    + ' it is 0', ()=>{
    const image = levels();
    for (const [first, expected] of [[1, [0, 255, 0]], [5, [255, 0, 0]]])
    {
        const { made } = plan(image, { firstMip: Number(first), mips: D3DX10_FROM_FILE });
        assert.deepEqual(desc(made), [8, 8, 1, 4, 1, 28, 0]);
        assert.ok(!('hr' in made));
        // The file's data is R8G8B8A8 already: FirstMipLevel 1 copies 4x4 into 8x8
        // with NONE, nothing differing but the level.
        assert.deepEqual([...made.subresources[0].data.subarray(0, 3)], expected);
    }
});

test('the filter is checked only when the texture differs from the file; the mip filter only'
    + ' when levels are made', ()=>{
    const image = levels();
    assert.deepEqual(desc(plan(image, { mips: D3DX10_FROM_FILE, filter: 7 }).made),
        [8, 8, 1, 4, 1, 28, 0], 'nothing differs: the filter is not looked at');
    assert.equal(desc(plan(image, { width: 4, height: 4, filter: 7 }).made), INVALIDCALL);
    assert.deepEqual(desc(plan(image, { mips: D3DX10_FROM_FILE, mipFilter: 7 }).made),
        [8, 8, 1, 4, 1, 28, 0], 'no level made');
    const single = readImage10(dds10({ width: 4, height: 4, format: 61, bytes: 16 }));
    assert.equal(desc(plan(single, { mipFilter: 7 }).made), INVALIDCALL);
});

test('a depth above 1 is refused for a file that is not a volume; a dimension past 3D too', ()=>{
    const flat = readImage10(dds10({ width: 4, height: 4, format: 61, bytes: 16 }));
    assert.equal(desc(plan(flat, { depth: 2 }).made), E_FAIL);
    assert.deepEqual(desc(plan(flat, { depth: 1 }).made), [4, 4, 1, 3, 1, 61, 0]);
    const odd = readImage10(dds10({ width: 4, height: 4, format: 61, dimension: 500,
        bytes: 16 }));
    assert.equal(desc(plan(odd).made), E_FAIL);
    const volume = readImage10(dds10({ width: 4, height: 4, depth: 4, format: 61,
        dimension: DIMENSION.TEXTURE3D, bytes: 64 }));
    const { made } = plan(volume, { depth: 2 });
    assert.deepEqual(desc(made), [4, 4, 2, 3, 1, 61, 0]);
});

test('a block format\'s size is whole blocks: a 2x2 asked of BC1 is 4x4, a 4x2 file\'s texels'
    + ' wrapped into its block', ()=>{
    // One BC1 block: colour 0 white, colour 1 black; rows 0 and 2 white, 1 and 3 black.
    const block = [0xff, 0xff, 0x00, 0x00, 0x00, 0x55, 0x00, 0x55];
    const file = dds10({ width: 4, height: 4, format: 71, bytes: 8 });
    file.set(block, 148);
    const asked = plan(readImage10(file), { width: 2, height: 2, mips: 1 }).made;
    assert.deepEqual(desc(asked), [4, 4, 1, 1, 1, 71, 0]);
    const short = dds10({ width: 4, height: 2, format: 71, bytes: 8 });
    short.set(block, 148);
    const { made } = plan(readImage10(short), { mips: 1 });
    assert.ok(!('hr' in made));
    const texels = decodeLevel(71, made.subresources[0].data, 4, 4);
    assert.deepEqual([0, 1, 2, 3].map(row=>texels[row * 16]), [1, 0, 1, 0],
        'rows 2 and 3 are rows 0 and 1 again');
});

test('a cube\'s flag is added to what the program asks; a format with no codec takes a level of'
    + ' the size asked (A234), and is refused another', ()=>{
    const cube = readImage10(dds10({ width: 1, height: 1, format: 61, misc: 0x4, bytes: 6 }));
    assert.deepEqual(desc(plan(cube, { misc: 0x1 }).made), [1, 1, 1, 1, 6, 61, 0x5]);
    const bc7 = readImage10(dds10({ width: 8, height: 8, format: 98, mips: 2, bytes: 80 }),
        { bc6and7: true });
    const { made } = plan(bc7, { width: 4, height: 4 });
    assert.deepEqual(desc(made), [4, 4, 1, 1, 1, 98, 0]);
    assert.ok(!('hr' in made) && made.subresources[0].data[0] === 64);
    const refused = plan(bc7, { width: 16, height: 16 });
    assert.equal(desc(refused.made), E_FAIL);
    assert.match(refused.said.join('\n'), /no codec/);
});
