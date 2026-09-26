/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityWords } from './caps.js';
import { DEFAULT_CAPS } from './device.js';
import { D3DCAPS9, D3DCAPS9_FLOATS } from './structs.js';

test('every field of the block has a value, and only fields of the block are named', ()=>{
    const words = capabilityWords(DEFAULT_CAPS);
    for (const name of Object.keys(D3DCAPS9))
    {
        if (name !== 'SIZE')
        {
            assert.ok(name in words, `${name} is written`);
        }
    }
    for (const name of Object.keys(words))
    {
        assert.ok(name in D3DCAPS9, `${name} is a field`);
    }
    for (const name of D3DCAPS9_FLOATS)
    {
        assert.ok(name in D3DCAPS9);
    }
});

test('no reserved bit is set in the words a conformance test masks', ()=>{
    const words = capabilityWords(DEFAULT_CAPS);
    assert.equal(words.Caps & ~(0x00020000 | 0x00800000), 0);
    assert.equal(words.Caps2 & ~(0x00020000 | 0x00100000 | 0x10000000 | 0x20000000 | 0x40000000
        | 0x80000000), 0);
    assert.equal(words.Caps3 & ~(0x00000020 | 0x00000080 | 0x00000100 | 0x00000200), 0);
    assert.equal(words.VertexProcessingCaps & ~(0x1 | 0x2 | 0x8 | 0x10 | 0x20 | 0x40 | 0x100
        | 0x200), 0);
    assert.equal(words.PrimitiveMiscCaps & ~0x003fdff2, 0);
    assert.equal(words.StencilCaps & ~0x1ff, 0);
    assert.equal(words.DeclTypes & ~0x3ff, 0);
});

test('a device that runs no shader says so with the version macros at zero', ()=>{
    const words = capabilityWords({
        ...DEFAULT_CAPS,
        vertexShaderVersion: { major: 0, minor: 0 },
        pixelShaderVersion: { major: 0, minor: 0 },
    });
    assert.equal(words.VertexShaderVersion, 0xfffe0000);
    assert.equal(words.PixelShaderVersion, 0xffff0000);
    assert.equal(words.MaxVertexShaderConst, 0);
    assert.equal(words.VS20Caps_NumTemps, 0);
    assert.equal(words.PS20Caps_NumInstructionSlots, 0);
    assert.equal(words.MaxVertexShader30InstructionSlots, 0);
});

test('a device that advertises shaders fills the fields a program checks alongside them', ()=>{
    const words = capabilityWords({
        ...DEFAULT_CAPS,
        vertexShaderVersion: { major: 3, minor: 0 },
        pixelShaderVersion: { major: 2, minor: 0 },
    });
    assert.equal(words.VertexShaderVersion, 0xfffe0300);
    assert.equal(words.PixelShaderVersion, 0xffff0200);
    assert.ok(words.MaxVertexShaderConst >= 96);
    assert.ok(words.VS20Caps_NumTemps >= 12);
    assert.ok(words.PS20Caps_NumTemps >= 12);
    assert.ok(words.PS20Caps_NumInstructionSlots >= 96);
    assert.ok(words.MaxVertexShader30InstructionSlots >= 512);
    assert.equal(words.MaxPixelShader30InstructionSlots, 0);
    assert.equal(words.PixelShader1xMaxValue, 1.0);
});

test('the default device advertises the model the renderer draws whole', ()=>{
    const words = capabilityWords(DEFAULT_CAPS);
    assert.equal(words.VertexShaderVersion, 0xfffe0200);
    assert.equal(words.PixelShaderVersion, 0xffff0200);
    assert.ok(words.MaxVertexShaderConst >= 96);
});

test('table fog is claimed over both depths it is taken over', ()=>{
    // W under a perspective projection, z under an affine one: the rule the
    // D3DCAPS9 documentation gives for a device claiming W-based fog.
    const words = capabilityWords(DEFAULT_CAPS);
    assert.equal(words.RasterCaps & 0x00100000, 0x00100000, 'D3DPRASTERCAPS_WFOG');
    assert.equal(words.RasterCaps & 0x00200000, 0x00200000, 'D3DPRASTERCAPS_ZFOG');
});

test('what the renderer does not do is not claimed', ()=>{
    const words = capabilityWords(DEFAULT_CAPS);
    assert.equal(words.TextureOpCaps, 0x0000ffff, 'the operations the combiner draws');
    assert.equal(words.StencilCaps, 0, 'no stencil test in the pipeline');
    assert.equal(words.RasterCaps & 0x00010000, 0x00010000, 'D3DPRASTERCAPS_FOGRANGE');
    assert.equal(words.MaxUserClipPlanes, 0, 'no clipping against user planes');
    assert.equal(words.RasterCaps & 0x01000000, 0x01000000,
        'D3DPRASTERCAPS_SCISSORTEST: draws and clears are cut to the scissor');
    assert.equal(words.StencilCaps & 0x100, 0, 'no two-sided stencil');
    assert.equal(words.TextureCaps & 0x800, 0, 'no cube maps');
    assert.equal(words.NumSimultaneousRTs, 1);
    assert.equal(words.StretchRectFilterCaps, 0);
    assert.equal(words.MaxAnisotropy, 1);
    assert.equal(words.Caps2 & 0x00020000, 0, 'no full-screen gamma');
    assert.ok(words.MaxTextureWidth > 0 && words.MaxTextureHeight > 0,
        'a zero here halves a texture for ever');
    assert.ok(words.MaxStreams >= 1);
    assert.ok(words.MaxTextureBlendStages >= words.MaxSimultaneousTextures);
});
