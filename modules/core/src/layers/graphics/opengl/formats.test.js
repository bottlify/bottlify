/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The sized formats: what each is (OpenGL 4.6 tables 8.12 to 8.14) and where
 * the device keeps it (the WebGPU format `gpuformats.js` picks for the DXGI
 * format of the same bytes).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import {
    SIZED_FORMATS, TEX, componentTypeOf, gpuStorageOf, isIntegerFormat, modelTexelBytes,
    sizedFormatOf,
} from './formats.js';

/** @param {number} internal */
function format(internal){
    const found = SIZED_FORMATS.get(internal);
    assert.ok(found, `0x${internal.toString(16)} is a sized format`);
    return found;
}

test('the eight-bit RGB(A) and other legacy formats stay on the RGBA path', ()=>{
    for (const legacy of [GL.RGB8, GL.RGBA8, GL.RGB16, GL.RGBA16, GL.RGB10_A2])
    {
        assert.equal(sizedFormatOf(legacy), null, legacy.toString(16));
    }
    assert.equal(sizedFormatOf(GL.RGB), null);
    assert.equal(sizedFormatOf(0x1234), null);
    assert.equal(sizedFormatOf(TEX.R8)?.name, 'R8');
    assert.equal(sizedFormatOf(GL.DEPTH_COMPONENT)?.kind, 'depth');
});

test('every format of tables 8.12 and 8.13 is there, with its base and bits', ()=>{
    /** @type {[number, number, string, number[]][]} */
    const rows = [
        [TEX.R8, GL.RED, 'unorm', [8, 0, 0, 0]],
        [TEX.RG16F, TEX.RG, 'float', [16, 16, 0, 0]],
        [TEX.RGB32F, GL.RGB, 'float', [32, 32, 32, 0]],
        [TEX.RGBA8_SNORM, GL.RGBA, 'snorm', [8, 8, 8, 8]],
        [TEX.R16_SNORM, GL.RED, 'snorm', [16, 0, 0, 0]],
        [TEX.RGBA32UI, GL.RGBA, 'uint', [32, 32, 32, 32]],
        [TEX.RG8I, TEX.RG, 'int', [8, 8, 0, 0]],
        [TEX.R11F_G11F_B10F, GL.RGB, 'float', [11, 11, 10, 0]],
        [TEX.RGB9_E5, GL.RGB, 'float', [9, 9, 9, 0]],
        [TEX.RGB10_A2UI, GL.RGBA, 'uint', [10, 10, 10, 2]],
        [TEX.SRGB8_ALPHA8, GL.RGBA, 'unorm', [8, 8, 8, 8]],
    ];
    for (const [internal, base, kind, bits] of rows)
    {
        const found = format(internal);
        assert.equal(found.base, base, found.name);
        assert.equal(found.kind, kind, found.name);
        assert.deepEqual(found.bits, bits, found.name);
    }
    assert.equal(format(TEX.RGB9_E5).shared, 5);
    assert.equal(format(TEX.SRGB8).srgb, true);
    assert.equal(format(TEX.DEPTH32F_STENCIL8).stencil, 8);
    assert.equal(format(TEX.DEPTH_COMPONENT16).depth, 16);
    assert.equal(format(TEX.STENCIL_INDEX8).base, GL.STENCIL_INDEX);
    // Forty-four colour formats of table 8.12 not kept as RGBA bytes, eight
    // of depth and stencil, sixteen compressed ones with the generic two.
    assert.ok(SIZED_FORMATS.size >= 64, `${SIZED_FORMATS.size} formats`);
});

test('a format lives on the device in the WebGPU format of its bytes', ()=>{
    const tier = { formatsTier1: true, compressed: true, depth32Stencil: true };
    /** @type {[number, string, string][]} */
    const rows = [
        [TEX.R8, 'r8unorm', 'float'],
        [TEX.RG8_SNORM, 'rg8snorm', 'float'],
        [TEX.RGB16F, 'rgba16float', 'float'],
        [TEX.RGBA32F, 'rgba32float', 'unfilterable-float'],
        [TEX.R32I, 'r32sint', 'sint'],
        [TEX.RGBA8UI, 'rgba8uint', 'uint'],
        [TEX.RGB10_A2UI, 'rgb10a2uint', 'uint'],
        [TEX.R11F_G11F_B10F, 'rg11b10ufloat', 'float'],
        [TEX.RGB9_E5, 'rgb9e5ufloat', 'float'],
        [TEX.SRGB8, 'rgba8unorm-srgb', 'float'],
        [TEX.R16, 'r16unorm', 'float'],
        [TEX.DEPTH_COMPONENT16, 'depth24plus-stencil8', 'depth'],
        [TEX.DEPTH_COMPONENT24, 'depth24plus-stencil8', 'depth'],
        [TEX.DEPTH_COMPONENT32F, 'depth32float-stencil8', 'depth'],
        [TEX.DEPTH24_STENCIL8, 'depth24plus-stencil8', 'depth'],
        [TEX.DEPTH32F_STENCIL8, 'depth32float-stencil8', 'depth'],
        [TEX.STENCIL_INDEX8, 'depth24plus-stencil8', 'uint'],
        [TEX.COMPRESSED_RED_RGTC1, 'bc4-r-unorm', 'float'],
        [TEX.COMPRESSED_RGBA_BPTC_UNORM, 'bc7-rgba-unorm', 'float'],
    ];
    for (const [internal, gpu, sampleType] of rows)
    {
        const kept = gpuStorageOf(format(internal), tier);
        assert.ok(kept, format(internal).name);
        assert.equal(kept.format, gpu, format(internal).name);
        assert.equal(kept.sampleType, sampleType, format(internal).name);
        assert.equal(kept.conversion, null, format(internal).name);
    }
});

test('what a device lacks changes where a format lives, and says how', ()=>{
    const r16 = gpuStorageOf(format(TEX.RG16), { formatsTier1: false });
    assert.equal(r16?.format, 'rg16float');
    assert.equal(r16?.conversion, 'unorm16-as-float');
    const bc = gpuStorageOf(format(TEX.COMPRESSED_RG_RGTC2), { compressed: false });
    assert.equal(bc?.conversion, 'decode');
    assert.equal(bc?.renderable, false);
    assert.equal(gpuStorageOf(format(TEX.R32F), {})?.filterable, false);
    assert.equal(gpuStorageOf(format(TEX.R32F), { float32Filterable: true })?.filterable, true);
    assert.equal(gpuStorageOf(format(TEX.R32F), { float32Filterable: true })?.sampleType,
        'float');
});

test('a depth format keeps a stencil aspect, and float depth only where the device can', ()=>{
    assert.equal(gpuStorageOf(format(TEX.DEPTH_COMPONENT32F), {})?.format,
        'depth24plus-stencil8');
    assert.equal(gpuStorageOf(format(TEX.DEPTH_COMPONENT32F), { depth32Stencil: true })?.format,
        'depth32float-stencil8');
    assert.equal(gpuStorageOf(format(TEX.DEPTH_COMPONENT16), { depth32Stencil: true })?.format,
        'depth24plus-stencil8');
    assert.equal(gpuStorageOf(format(TEX.DEPTH_COMPONENT24), {})?.renderable, true);
});

test('integer and depth formats are never filtered', ()=>{
    for (const internal of [TEX.R8I, TEX.RGBA16UI, TEX.RGB10_A2UI, TEX.DEPTH_COMPONENT16,
        TEX.DEPTH24_STENCIL8])
    {
        assert.equal(gpuStorageOf(format(internal), { float32Filterable: true })?.filterable,
            false, format(internal).name);
    }
    assert.equal(isIntegerFormat(format(TEX.RGBA32I)), true);
    assert.equal(isIntegerFormat(format(TEX.RGBA32F)), false);
});

test('renderability follows the device: RG11B10 only with its feature', ()=>{
    assert.equal(gpuStorageOf(format(TEX.R11F_G11F_B10F), { rg11b10Renderable: false })
        ?.renderable, false);
    assert.equal(gpuStorageOf(format(TEX.R11F_G11F_B10F), { rg11b10Renderable: true })
        ?.renderable, true);
    assert.equal(gpuStorageOf(format(TEX.RGB9_E5), {})?.renderable, false);
    assert.equal(gpuStorageOf(format(TEX.RGBA16F), {})?.renderable, true);
    assert.equal(gpuStorageOf(format(TEX.DEPTH32F_STENCIL8), {})?.renderable, true);
});

test('the model keeps a texel in the bytes of its own layout', ()=>{
    /** @type {[number, number][]} */
    const rows = [
        [TEX.R8, 1], [TEX.RG8, 2], [TEX.RGB8_SNORM, 4], [TEX.RGBA16F, 8], [TEX.RGB32F, 16],
        [TEX.RG32UI, 8], [TEX.R16, 2], [TEX.RGB10_A2UI, 4], [TEX.R11F_G11F_B10F, 4],
        [TEX.RGB9_E5, 4], [TEX.DEPTH_COMPONENT16, 2], [TEX.DEPTH_COMPONENT24, 4],
        [TEX.DEPTH_COMPONENT32F, 4], [TEX.DEPTH24_STENCIL8, 4], [TEX.DEPTH32F_STENCIL8, 8],
        [TEX.STENCIL_INDEX8, 1], [TEX.COMPRESSED_RED_RGTC1, 0],
    ];
    for (const [internal, bytes] of rows)
    {
        assert.equal(modelTexelBytes(format(internal)), bytes, format(internal).name);
    }
});

test('each component answers its type (table 6.17 of OpenGL 3.0)', ()=>{
    assert.equal(componentTypeOf(format(TEX.R8), 'colour'), GL.UNSIGNED_NORMALIZED);
    assert.equal(componentTypeOf(format(TEX.R8_SNORM), 'colour'), TEX.SIGNED_NORMALIZED);
    assert.equal(componentTypeOf(format(TEX.R16F), 'colour'), GL.FLOAT);
    assert.equal(componentTypeOf(format(TEX.R16I), 'colour'), GL.INT);
    assert.equal(componentTypeOf(format(TEX.RGB10_A2UI), 'colour'), GL.UNSIGNED_INT);
    assert.equal(componentTypeOf(format(TEX.DEPTH_COMPONENT24), 'colour'), GL.NONE);
    assert.equal(componentTypeOf(format(TEX.DEPTH_COMPONENT24), 'depth'),
        GL.UNSIGNED_NORMALIZED);
    assert.equal(componentTypeOf(format(TEX.DEPTH_COMPONENT32F), 'depth'), GL.FLOAT);
    assert.equal(componentTypeOf(format(TEX.DEPTH32F_STENCIL8), 'depth'), GL.FLOAT);
    assert.equal(componentTypeOf(format(TEX.R32F), 'depth'), GL.NONE);
});
