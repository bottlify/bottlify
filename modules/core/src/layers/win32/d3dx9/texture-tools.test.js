/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTextureTools, formatCandidates, shaderProfile, textureRequirements }
    from './texture-tools.js';
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

test('the shader profile functions name the highest profile the device\'s caps run', async()=>{
    const r = deviceRig({ caps: { vertexShader: 0xfffe0200, pixelShader: 0xffff0104 } });
    const tools = /** @type {any} */ (createTextureTools(r.host));
    const bytes = new Uint8Array(r.memory.buffer);
    /** @param {number} at */
    const text = at=>{
        let end = at;
        while (bytes[end] !== 0)
        {
            end++;
        }
        return String.fromCharCode(...bytes.subarray(at, end));
    };
    const vs = await r.call(tools.D3DXGetVertexShaderProfile, [r.device]);
    assert.equal(text(vs), 'vs_2_0');
    assert.equal(text(await r.call(tools.D3DXGetPixelShaderProfile, [r.device])), 'ps_1_4');
    assert.equal(await r.call(tools.D3DXGetVertexShaderProfile, [r.device]), vs,
        'the same constant string each time');
    assert.equal(r.call(tools.D3DXGetPixelShaderProfile, [0]), 0, 'NULL for no device');
    const bare = deviceRig();
    assert.equal(await bare.call(/** @type {any} */ (createTextureTools(bare.host))
        .D3DXGetPixelShaderProfile, [bare.device]), 0, 'and for no shaders');
    assert.equal(shaderProfile('ps', 0xffff0300), 'ps_3_0');
    assert.equal(shaderProfile('vs', 0xfffe0101), 'vs_1_1');
    assert.equal(shaderProfile('ps', 0xffff0201), 'ps_2_0', 'a 2.x card is told ps_2_0');
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

test('D3DXFillTexture asks the function for each texel\'s colour at its centre', async()=>{
    const r = deviceRig();
    const tools = /** @type {any} */ (createTextureTools(r.host));
    /** @type {number[][]} */
    const asked = [];
    const fill = r.guestFunction(([out, coord, size, data])=>{
        const [u, v] = r.floats(coord, 2);
        asked.push([u, v, ...r.floats(size, 2), data]);
        // Red across, green down, blue a half, alpha one.
        r.putFloats(out, [u, v, 0.5, 1]);
        return 0;
    });
    const texture = r.texture(4, 2, 0, 0, FMT.A8R8G8B8, 1);
    assert.equal(await r.call(tools.D3DXFillTexture, [texture, fill, 0x1234]), 0);
    assert.equal(asked.length, 4 * 2 + 2 * 1 + 1, 'every texel of every level');
    assert.deepEqual(asked[0], [0.125, 0.25, 0.25, 0.5, 0x1234]);
    assert.deepEqual(asked[5], [0.375, 0.75, 0.25, 0.5, 0x1234]);
    assert.deepEqual(asked.at(-1), [0.5, 0.5, 1, 1, 0x1234]);
    const level0 = r.objects.get(r.objects.get(texture).surfaces[0]);
    // B, G, R, A of the texel at (1, 1): u 0.375, v 0.75.
    assert.deepEqual([...r.memory.subarray(level0.data + 20, level0.data + 24)],
        [128, 191, 96, 255]);
    assert.equal(level0.locked, false, 'unlocked again');
});

test('D3DXFillTexture writes float formats from the floats, halves as the library rounds',
    async()=>{
        const r = deviceRig();
        const tools = /** @type {any} */ (createTextureTools(r.host));
        const fill = r.guestFunction(([out])=>{
            r.putFloats(out, [1.5, -2, 0.1, 70000]);
            return 0;
        });
        const single = r.texture(1, 1, 1, 0, 116, 1);
        assert.equal(await r.call(tools.D3DXFillTexture, [single, fill, 0]), 0);
        const at = r.objects.get(r.objects.get(single).surfaces[0]).data;
        assert.deepEqual(r.floats(at, 4), [1.5, -2, Math.fround(0.1), 70000]);
        const half = r.texture(1, 1, 1, 0, 113, 1);
        assert.equal(await r.call(tools.D3DXFillTexture, [half, fill, 0]), 0);
        const h = r.objects.get(r.objects.get(half).surfaces[0]).data;
        assert.deepEqual([0, 1, 2, 3].map(i=>r.view.getUint16(h + i * 2, true)),
            [0x3e00, 0xc000, 0x2e66, 0x7c46], '70000 past the half range, as the library keeps it');
        assert.equal(r.call(tools.D3DXFillTexture, [0, fill, 0]), D3DERR_INVALIDCALL);
        assert.equal(r.call(tools.D3DXFillTexture, [half, 0, 0]), D3DERR_INVALIDCALL);
        const odd = r.texture(1, 1, 1, 0, 0x3159564b, 1);
        assert.equal(await r.call(tools.D3DXFillTexture, [odd, fill, 0]), D3DERR_INVALIDCALL);
        assert.equal(r.diverged.at(-1)?.[0], 'D3DXFillTexture');
    });

/** A surface's texels, packed. @param {ReturnType<typeof deviceRig>} r @param {number} at */
const texelsOf = (r, at)=>{
    const surface = r.objects.get(at);
    return [...r.memory.subarray(surface.data, surface.data + surface.pitch * surface.height)];
};

test('D3DXFilterTexture makes each level below the source from the one above, a box of two by'
    + ' two', async()=>{
    const r = deviceRig();
    const tools = /** @type {any} */ (createTextureTools(r.host));
    const texture = r.texture(4, 2, 0, 0, FMT.A8R8G8B8, 1);
    const [top, second, third] = r.objects.get(texture).surfaces;
    r.memory.set([0, 0, 0, 0, 4, 8, 12, 16, 100, 100, 100, 100, 50, 50, 50, 50,
        8, 8, 8, 8, 4, 0, 4, 0, 0, 0, 0, 0, 10, 10, 10, 10], r.objects.get(top).data);
    r.memory.fill(0xee, r.objects.get(third).data, r.objects.get(third).data + 4);
    assert.equal(tools.D3DXFilterTexture.argBytes, 16);
    assert.equal(await r.call(tools.D3DXFilterTexture, [texture, 0, D3DX_DEFAULT,
        D3DX_DEFAULT]), 0);
    assert.deepEqual(texelsOf(r, second), [4, 4, 6, 6, 40, 40, 40, 40], 'each the mean, rounded');
    assert.deepEqual(texelsOf(r, third), [22, 22, 23, 23], 'from the second, not the first');
    assert.deepEqual(r.calls.filter(c=>c[0] === 'LockRect').map(c=>[c[1], c[4]]),
        [[0, 0x10], [1, 0], [2, 0]], 'the source only read');

    r.memory.fill(0, r.objects.get(third).data, r.objects.get(third).data + 4);
    assert.equal(await r.call(tools.D3DXFilterTexture, [texture, 0, 1, 5]), 0);
    assert.deepEqual(texelsOf(r, third), [22, 22, 23, 23], 'from level one down');
    assert.deepEqual(texelsOf(r, top).slice(0, 4), [0, 0, 0, 0], 'the source untouched');
});

test('D3DXFilterTexture filters every face of a cube texture and refuses what it cannot',
    async()=>{
        const r = deviceRig();
        const tools = /** @type {any} */ (createTextureTools(r.host));
        const cube = r.cubeTexture(2, 2, 0, FMT.X8R8G8B8, 1);
        const faces = r.objects.get(cube).faces;
        faces.forEach((/** @type {number[]} */ levels, /** @type {number} */ n)=>
            r.memory.fill(n * 10, r.objects.get(levels[0]).data,
                r.objects.get(levels[0]).data + 16));
        assert.equal(await r.call(tools.D3DXFilterTexture, [cube, 0, 0, 2]), 0);
        faces.forEach((/** @type {number[]} */ levels, /** @type {number} */ n)=>
            assert.deepEqual(texelsOf(r, levels[1]), [n * 10, n * 10, n * 10, 255],
                `face ${n}, made opaque as X8R8G8B8 is`));
        assert.ok(r.calls.some(c=>c[0] === 'LockRect' && c[1] === 5 && c[2] === 1),
            'the face named before the level');

        const texture = r.texture(2, 2, 2, 0, FMT.A8R8G8B8, 1);
        assert.equal(await r.call(tools.D3DXFilterTexture, [texture, 0, 2, D3DX_DEFAULT]),
            D3DERR_INVALIDCALL, 'no third level');
        assert.equal(r.call(tools.D3DXFilterTexture, [texture, 0, 0, 0]), D3DERR_INVALIDCALL,
            'no filter');
        assert.equal(r.call(tools.D3DXFilterTexture, [texture, 0, 0, 6]), D3DERR_INVALIDCALL);
        assert.equal(r.call(tools.D3DXFilterTexture, [0, 0, 0, 5]), D3DERR_INVALIDCALL);
        const floats = r.texture(2, 2, 2, 0, 116, 1);
        assert.equal(await r.call(tools.D3DXFilterTexture, [floats, 0, 0, 5]), 0x80004001);
        assert.match(r.diverged.flat().join(' '), /format 116 is not one a filter reads/);
    });

test('D3DXCreateCubeTexture makes a square of the size asked, a power of two where cubes need it',
    async()=>{
        const r = deviceRig({ caps: { textureCaps: 0x20000 } });
        const tools = /** @type {any} */ (createTextureTools(r.host));
        const out = r.heap.allocate(4);
        assert.equal(await r.call(tools.D3DXCreateCubeTexture,
            [r.device, 100, 0, 0, FMT.A8R8G8B8, 1, out]), 0);
        assert.deepEqual(r.calls.find(c=>c[0] === 'CreateCubeTexture')?.slice(1, 8),
            [128, 8, 0, FMT.A8R8G8B8, 1, out, 0]);
        assert.equal(r.call(tools.D3DXCreateCubeTexture, [r.device, 1, 1, 0, 21, 1, 0]),
            D3DERR_INVALIDCALL);
    });

test('D3DXCreateVolumeTexture corrects its three sides by the volume caps', async()=>{
    const r = deviceRig({ caps: { textureCaps: 0x40000, maxVolume: 64 } });
    const tools = /** @type {any} */ (createTextureTools(r.host));
    const out = r.heap.allocate(4);
    assert.equal(await r.call(tools.D3DXCreateVolumeTexture,
        [r.device, 30, 100, 0, D3DX_DEFAULT, 0, FMT.A8R8G8B8, 1, out]), 0);
    assert.deepEqual(r.calls.find(c=>c[0] === 'CreateVolumeTexture')?.slice(1, 10),
        [32, 64, 1, 7, 0, FMT.A8R8G8B8, 1, out, 0],
        'powers of two, the height cut to the largest extent, a depth of one, the full chain');
});

test('D3DXFillVolumeTexture asks the function for each texel of each slice', async()=>{
    const r = deviceRig();
    const tools = /** @type {any} */ (createTextureTools(r.host));
    /** @type {number[][]} */
    const asked = [];
    const fill = r.guestFunction(([out, coord, size])=>{
        const [u, v, w] = r.floats(coord, 3);
        asked.push([u, v, w, ...r.floats(size, 3)]);
        r.putFloats(out, [u, v, w, 1]);
        return 0;
    });
    const out = r.heap.allocate(4);
    await r.call(tools.D3DXCreateVolumeTexture, [r.device, 2, 2, 2, 1, 0, FMT.A8R8G8B8, 1, out]);
    const volume = r.view.getUint32(out, true);
    assert.equal(await r.call(tools.D3DXFillVolumeTexture, [volume, fill, 0]), 0);
    assert.equal(asked.length, 8);
    assert.deepEqual(asked[7], [0.75, 0.75, 0.75, 0.5, 0.5, 0.5]);
    const level = r.objects.get(volume).levels[0];
    // B, G, R, A of the last texel: (1, 1, 1), u v w 0.75.
    assert.deepEqual([...r.memory.subarray(level.data + level.slicePitch + 12,
        level.data + level.slicePitch + 16)], [191, 191, 191, 255]);
    assert.equal(level.locked, false, 'unlocked again');
});

const D3DERR_NOTAVAILABLE = 0x8876086a;
const D3DUSAGE_WRITEONLY = 0x8;
const R3G3B2 = 27;
const X4R4G4B4 = 30;
const P8 = 41;
const V8U8 = 60;

test('the nearest formats: the one asked first, then what loses no bits, its own kind first', ()=>{
    assert.deepEqual(formatCandidates(FMT.R8G8B8).slice(0, 2), [FMT.R8G8B8, FMT.X8R8G8B8],
        'R8G8B8 stands in as X8R8G8B8');
    assert.equal(formatCandidates(R3G3B2)[1], X4R4G4B4, 'the fewest bits added');
    assert.equal(formatCandidates(FMT.A8R8G8B8).includes(FMT.R8G8B8), false,
        'a three-byte format only for a three-byte one');
    assert.ok(formatCandidates(P8).indexOf(FMT.A8R8G8B8) > 0, 'a palette as eight bits of each');
    assert.ok(formatCandidates(V8U8).every(format=>[V8U8, 63, 64].includes(format)),
        'a signed format only for a signed one');
    assert.deepEqual(formatCandidates(0x32595559), [0x32595559], 'an unknown format alone');
});

test('D3DXCheckTextureRequirements takes the nearest format the device\'s CheckDeviceFormat takes',
    async()=>{
        const r = deviceRig();
        const tools = /** @type {any} */ (createTextureTools(r.host));
        const at = r.heap.allocate(16);
        new Uint32Array(r.memory.buffer, at, 4).set([64, 64, 1, FMT.R8G8B8]);
        assert.equal(await r.call(tools.D3DXCheckTextureRequirements,
            [r.device, at, at + 4, at + 8, 0x200, at + 12, 0]), 0);
        assert.equal(r.view.getUint32(at + 12, true), FMT.X8R8G8B8);
        // Adapter, device type and display format as the device was made, the
        // usage, a texture, and each format in turn.
        assert.deepEqual(r.calls.filter(c=>c[0] === 'CheckDeviceFormat'),
            [['CheckDeviceFormat', 0, 1, 22, 0x200, 3, FMT.R8G8B8],
                ['CheckDeviceFormat', 0, 1, 22, 0x200, 3, FMT.X8R8G8B8]]);
        assert.equal(r.calls.filter(c=>c[0] === 'GetDirect3D').length,
            r.calls.filter(c=>c[0] === 'Release').length, 'the Direct3D object released');
        new Uint32Array(r.memory.buffer, at + 12, 1).set([FMT.R5G6B5]);
        assert.equal(await r.call(tools.D3DXCheckTextureRequirements,
            [r.device, 0, 0, 0, 0, at + 12, 0]), 0);
        assert.equal(r.view.getUint32(at + 12, true), FMT.R5G6B5, 'a format it takes is kept');
        assert.equal(await r.call(tools.D3DXCheckTextureRequirements,
            [r.device, 0, 0, 0, D3DUSAGE_WRITEONLY, 0, 0]), D3DERR_INVALIDCALL,
        'a buffer\'s usage');
        const none = deviceRig({ refused: formatCandidates(FMT.R8G8B8) });
        const format = none.heap.allocate(4);
        none.view.setUint32(format, FMT.R8G8B8, true);
        assert.equal(await none.call(/** @type {any} */ (createTextureTools(none.host))
            .D3DXCheckTextureRequirements, [none.device, 0, 0, 0, 0, format, 0]),
        D3DERR_NOTAVAILABLE, 'nothing near');
        assert.equal(none.view.getUint32(format, true), FMT.R8G8B8, 'and nothing written');
    });

test('D3DXCreateTexture makes the nearest format the device takes', async()=>{
    const r = deviceRig();
    const tools = /** @type {any} */ (createTextureTools(r.host));
    const out = r.heap.allocate(4);
    assert.equal(await r.call(tools.D3DXCreateTexture,
        [r.device, 32, 32, 1, 0, FMT.R8G8B8, 1, out]), 0);
    assert.deepEqual(r.calls.find(c=>c[0] === 'CreateTexture')?.slice(1, 6),
        [32, 32, 1, 0, FMT.X8R8G8B8]);
});

test('the cube and volume checks correct the size, levels and format by their own caps',
    async()=>{
        const r = deviceRig({ caps: { textureCaps: 0x20000 | 0x40000, maxVolume: 64 } });
        const tools = /** @type {any} */ (createTextureTools(r.host));
        const at = r.heap.allocate(20);
        new Uint32Array(r.memory.buffer, at, 3).set([100, 0, FMT.R8G8B8]);
        assert.equal(await r.call(tools.D3DXCheckCubeTextureRequirements,
            [r.device, at, at + 4, 0, at + 8, 1]), 0);
        assert.deepEqual([...new Uint32Array(r.memory.buffer, at, 3)],
            [128, 8, FMT.X8R8G8B8]);
        assert.equal(r.calls.filter(c=>c[0] === 'CheckDeviceFormat').at(-1)?.[5], 5,
            'asked of a cube texture');
        new Uint32Array(r.memory.buffer, at, 5).set([100, 20, 3, D3DX_DEFAULT, FMT.UNKNOWN]);
        assert.equal(await r.call(tools.D3DXCheckVolumeTextureRequirements,
            [r.device, at, at + 4, at + 8, at + 12, 0, at + 16, 1]), 0);
        assert.deepEqual([...new Uint32Array(r.memory.buffer, at, 5)],
            [64, 32, 4, 7, FMT.A8R8G8B8]);
        assert.equal(r.calls.filter(c=>c[0] === 'CheckDeviceFormat').at(-1)?.[5], 4,
            'asked of a volume texture');
        assert.equal(await r.call(tools.D3DXCheckVolumeTextureRequirements,
            [r.device, 0, 0, 0, 0, 0, 0, 1]), 0, 'every pointer may be null');
        assert.equal(r.call(tools.D3DXCheckCubeTextureRequirements, [0, 0, 0, 0, 0, 1]),
            D3DERR_INVALIDCALL);
    });
