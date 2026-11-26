/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createTextureObject, isTextureComplete, levelKey } from './objects.js';
import { bytesAllocatedBy } from './allocation.fixture.js';

/**
 * Completeness as it was written before it was asked of every bound texture
 * on every draw without making anything: the reference the scalar form must
 * answer alike.
 *
 * @param {any} texture
 */
function completeAsSpecified(texture){
    /** @param {number} target @param {any} image */
    const interiorOf = (target, image)=>{
        const border = image.border ?? 0;
        const flat = target === GL.TEXTURE_1D || target === 0x8c18;
        return [image.width - 2 * border, image.height - (flat ? 0 : 2 * border),
            (image.depth ?? 1) - (target === GL.TEXTURE_3D ? 2 * border : 0)];
    };
    const mipmapFilters = [GL.NEAREST_MIPMAP_NEAREST, GL.LINEAR_MIPMAP_NEAREST,
        GL.NEAREST_MIPMAP_LINEAR, GL.LINEAR_MIPMAP_LINEAR];
    const faces = texture.target === GL.TEXTURE_CUBE_MAP ? 6 : 1;
    const first = texture.parameters.get(GL.TEXTURE_BASE_LEVEL) ?? 0;
    const base = texture.levels.get(levelKey(first));
    if (!base || base.width === 0 || base.height === 0)
    {
        return false;
    }
    const [width, height, depth] = interiorOf(texture.target, base);
    const mipmapped = mipmapFilters.includes(texture.parameters.get(GL.TEXTURE_MIN_FILTER) ?? 0);
    const last = texture.parameters.get(GL.TEXTURE_MAX_LEVEL) ?? 1000;
    if (mipmapped && first > last)
    {
        return false;
    }
    const solid = texture.target === GL.TEXTURE_3D;
    const layeredRows = texture.target === 0x8c18;
    /** @param {any} image @param {number[]} size */
    const matches = (image, size)=>!!image && image.internalFormat === base.internalFormat
        && (image.border ?? 0) === (base.border ?? 0)
        && interiorOf(texture.target, image).every((extent, k)=>extent === size[k]);
    for (let face = 0; face < faces; face++)
    {
        if (!matches(texture.levels.get(levelKey(first, face)), [width, height, depth])
            || (faces > 1 && width !== height))
        {
            return false;
        }
        if (!mipmapped)
        {
            continue;
        }
        const levels = Math.floor(Math.log2(Math.max(width, layeredRows ? 1 : height,
            solid ? depth : 1)));
        for (let step = 1; step <= Math.min(levels, last - first); step++)
        {
            const size = [Math.max(1, width >> step),
                layeredRows ? height : Math.max(1, height >> step),
                solid ? Math.max(1, depth >> step) : depth];
            if (!matches(texture.levels.get(levelKey(first + step, face)), size))
            {
                return false;
            }
        }
    }
    return true;
}

/** @param {number} seed */
function random(seed){
    let state = seed >>> 0;
    return (/** @type {number} */ below)=>{
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state % below;
    };
}

const TARGETS = [GL.TEXTURE_1D, GL.TEXTURE_2D, GL.TEXTURE_3D, GL.TEXTURE_CUBE_MAP, 0x8c18];
const FILTERS = [GL.NEAREST, GL.LINEAR, GL.NEAREST_MIPMAP_NEAREST, GL.LINEAR_MIPMAP_LINEAR];

/**
 * A texture of random levels: mostly a well formed chain, each level now and
 * then of another size, format or border, missing, or past MAX_LEVEL.
 *
 * @param {(below: number) => number} pick
 */
function randomTexture(pick){
    const target = TARGETS[pick(TARGETS.length)];
    const texture = createTextureObject(1, target);
    texture.parameters.set(GL.TEXTURE_MIN_FILTER, FILTERS[pick(FILTERS.length)]);
    const first = pick(4) === 0 ? pick(3) : 0;
    if (first !== 0 || pick(3) === 0)
    {
        texture.parameters.set(GL.TEXTURE_BASE_LEVEL, first);
    }
    if (pick(3) === 0)
    {
        texture.parameters.set(GL.TEXTURE_MAX_LEVEL, pick(8));
    }
    const border = pick(6) === 0 ? 1 : 0;
    const width = 1 << pick(7);
    const height = target === GL.TEXTURE_CUBE_MAP && pick(5) !== 0 ? width : 1 << pick(7);
    const depth = target === GL.TEXTURE_3D || target === 0x8c18 ? 1 + pick(8) : 1;
    const faces = target === GL.TEXTURE_CUBE_MAP ? 6 : 1;
    for (let face = 0; face < faces; face++)
    {
        for (let step = 0; step < 9; step++)
        {
            if (pick(14) === 0)
            {
                continue;
            }
            const odd = pick(16) === 0;
            const level = {
                width: Math.max(1, width >> step) + 2 * border + (odd ? 1 : 0),
                height: (target === GL.TEXTURE_1D || target === 0x8c18 ? height
                    : Math.max(1, height >> step) + 2 * border),
                depth: target === GL.TEXTURE_3D ? Math.max(1, depth >> step) + 2 * border : depth,
                internalFormat: pick(20) === 0 ? GL.RGB : GL.RGBA,
                border: pick(24) === 0 ? 1 - border : border,
                baseFormat: GL.RGBA,
                texels: null,
            };
            if (pick(30) === 0)
            {
                level.width = 0;
            }
            texture.levels.set(levelKey(first + step, face), level);
        }
    }
    return texture;
}

test('completeness answers as specified for random textures of every target, chain and fault', ()=>{
    const pick = random(0x1e57);
    let complete = 0;
    for (let n = 0; n < 20000; n++)
    {
        const texture = randomTexture(pick);
        const expected = completeAsSpecified(texture);
        complete += expected ? 1 : 0;
        assert.equal(isTextureComplete(texture), expected, `texture ${n}`);
    }
    // Both answers drawn from: a gate whose cases all came out alike would prove nothing.
    assert.ok(complete > 2000 && complete < 18000, `${complete} of 20000 complete`);
});

test('completeness, asked of a bound texture on every draw, makes nothing for the collector',
    async()=>{
        const texture = createTextureObject(1, GL.TEXTURE_2D);
        texture.parameters.set(GL.TEXTURE_MIN_FILTER, GL.LINEAR_MIPMAP_LINEAR);
        for (let step = 0; step <= 8; step++)
        {
            texture.levels.set(levelKey(step), { width: 256 >> step, height: 256 >> step, depth: 1,
                internalFormat: GL.RGBA, border: 0, baseFormat: GL.RGBA, texels: null });
        }
        assert.equal(isTextureComplete(texture), true);
        // Warm: what compiling the loop makes is not the check's.
        for (let n = 0; n < 100000; n++)
        {
            isTextureComplete(texture);
        }
        const bytes = await bytesAllocatedBy(()=>{
            for (let n = 0; n < 100000; n++)
            {
                isTextureComplete(texture);
            }
        });
        // Under a byte a check, which the sampler's own few samples come to; the
        // closure and extent arrays it made before came to 2 KB a check.
        assert.ok(bytes < 100000, `${bytes} bytes for 100000 checks`);
    });
