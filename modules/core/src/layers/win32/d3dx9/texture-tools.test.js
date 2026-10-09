/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTextureTools, textureRequirements } from './texture-tools.js';
import { deviceRig } from './device.fixture.js';
import { D3DX_DEFAULT } from './texture.js';
import { FMT } from './pixels.js';

const D3DERR_INVALIDCALL = 0x8876086c;
const POW2 = 0x2;
const SQUAREONLY = 0x20;
const NONPOW2CONDITIONAL = 0x100;
const AUTOGENMIPMAP = 0x400;
const ANY = { textureCaps: 0, maxWidth: 4096, maxHeight: 4096 };

/** @param {Partial<Parameters<typeof textureRequirements>[0]>} asked @param {any} [caps] */
const check = (asked, caps = ANY)=>textureRequirements({ width: D3DX_DEFAULT,
    height: D3DX_DEFAULT, levels: D3DX_DEFAULT, usage: 0, format: FMT.UNKNOWN, ...asked }, caps);

test('requirements: defaults, zeros and the full chain', ()=>{
    assert.deepEqual(check({}), { width: 256, height: 256, levels: 9, usage: 0,
        format: FMT.A8R8G8B8 });
    assert.deepEqual(check({ width: 0, height: 0, levels: 0 }), { width: 1, height: 1,
        levels: 1, usage: 0, format: FMT.A8R8G8B8 });
    assert.equal(check({ width: 64 }).height, 64, 'a default height follows the width');
    assert.equal(check({ height: 32 }).width, 32, 'and a default width the height');
    assert.equal(check({ width: 64, height: 16, levels: 20 }).levels, 7, 'at most the chain');
    assert.equal(check({ width: 64, height: 16, levels: 3 }).levels, 3);
    assert.equal(check({ format: D3DX_DEFAULT, usage: D3DX_DEFAULT }).format, FMT.A8R8G8B8);
    assert.equal(check({ format: D3DX_DEFAULT, usage: D3DX_DEFAULT }).usage, 0);
    assert.equal(check({ format: FMT.R5G6B5 }).format, FMT.R5G6B5, 'a format kept as asked');
    assert.equal(check({ width: 64, usage: AUTOGENMIPMAP }).levels, 1,
        'the device makes the levels');
});

test('requirements: what the device cannot do corrects the size', ()=>{
    const pow2 = { ...ANY, textureCaps: POW2 };
    assert.deepEqual([check({ width: 100, height: 30 }, pow2).width,
        check({ width: 100, height: 30 }, pow2).height], [128, 32]);
    const conditional = { ...ANY, textureCaps: POW2 | NONPOW2CONDITIONAL };
    assert.equal(check({ width: 100, height: 30, levels: 1 }, conditional).width, 100,
        'a single level may be any size');
    assert.equal(check({ width: 100, height: 30, levels: 0 }, conditional).width, 128,
        'a chain may not');
    const square = check({ width: 64, height: 16 }, { ...ANY, textureCaps: SQUAREONLY });
    assert.deepEqual([square.width, square.height], [64, 64]);
    const small = check({ width: 4096, height: 100 }, { ...ANY, maxWidth: 2048 });
    assert.deepEqual([small.width, small.height, small.levels], [2048, 100, 12]);
    const blocks = check({ width: 10, height: 6, format: FMT.DXT1 });
    assert.deepEqual([blocks.width, blocks.height], [12, 8], 'whole 4x4 blocks');
});

test('D3DXCheckTextureRequirements writes the corrections through the pointers it is given',
    async()=>{
        const r = deviceRig({ caps: { textureCaps: POW2 } });
        const tools = /** @type {any} */ (createTextureTools(r.host));
        const at = r.heap.allocate(16);
        new Uint32Array(r.memory.buffer, at, 4).set([100, 0, 0, FMT.UNKNOWN]);
        assert.equal(await r.call(tools.D3DXCheckTextureRequirements,
            [r.device, at, at + 4, at + 8, 0, at + 12, 1]), 0);
        assert.deepEqual([...new Uint32Array(r.memory.buffer, at, 4)],
            [128, 1, 8, FMT.A8R8G8B8]);
        assert.equal(await r.call(tools.D3DXCheckTextureRequirements,
            [r.device, 0, 0, 0, 0, 0, 1]), 0, 'every pointer may be null');
        assert.equal(r.call(tools.D3DXCheckTextureRequirements, [0, at, at + 4, 0, 0, 0, 1]),
            D3DERR_INVALIDCALL);
    });

test('D3DXCreateTexture makes the corrected texture with the device\'s CreateTexture', async()=>{
    const r = deviceRig({ caps: { textureCaps: POW2 } });
    const tools = /** @type {any} */ (createTextureTools(r.host));
    const out = r.heap.allocate(4);
    assert.equal(await r.call(tools.D3DXCreateTexture,
        [r.device, 200, 50, 0, 0, FMT.X8R8G8B8, 1, out]), 0);
    assert.deepEqual(r.calls.find(c=>c[0] === 'CreateTexture')?.slice(1, 9),
        [256, 64, 9, 0, FMT.X8R8G8B8, 1, out, 0]);
    const texture = r.objects.get(r.view.getUint32(out, true));
    assert.equal(texture.surfaces.length, 9);
    assert.equal(r.call(tools.D3DXCreateTexture, [0, 1, 1, 1, 0, 21, 1, out]),
        D3DERR_INVALIDCALL);
    assert.equal(r.view.getUint32(out, true), 0, 'the out-pointer cleared');
    assert.equal(r.call(tools.D3DXCreateTexture, [r.device, 1, 1, 1, 0, 21, 1, 0]),
        D3DERR_INVALIDCALL);
});
