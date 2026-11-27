/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { OUTPUT, PARTITIONING, tessellate } from './tessellator.js';

/**
 * Patches drawn from a seed and what Microsoft's reference tessellator made
 * of each (`tools/generators/tess-corpus.mjs`): every point's u and v as float bits,
 * every index.
 *
 * @type {{ cases: { domain: 'isoline' | 'tri' | 'quad', partitioning: number, output: number,
 *     factors: string[], points: string, indices: string }[] }}
 */
const corpus = JSON.parse(gunzipSync(readFileSync(new URL('tess-corpus.json.gz',
    import.meta.url))).toString());

const view = new DataView(new ArrayBuffer(4));
/** @param {string} hex */
const floatOf = hex=>{
    view.setUint32(0, Number.parseInt(hex, 16), true);
    return view.getFloat32(0, true);
};
/** @param {number} value */
const bitsOf = value=>{
    view.setFloat32(0, value, true);
    return view.getUint32(0, true).toString(16);
};

test('every patch of the corpus is tessellated as the reference tessellates it, bit for bit',
    ()=>{
        let points = 0;
        for (const one of corpus.cases)
        {
            const made = tessellate(one.domain, one.partitioning, one.output,
                one.factors.map(floatOf));
            const said = `${one.domain} ${one.partitioning}/${one.output} [${
                one.factors.map(floatOf).join(', ')}]`;
            const got = [];
            for (let at = 0; at < made.points.length; at += 2)
            {
                got.push(`${bitsOf(made.points[at])},${bitsOf(made.points[at + 1])}`);
            }
            assert.equal(got.join(' '), one.points, `${said}: points`);
            assert.equal([...made.indices].join(' '), one.indices, `${said}: indices`);
            points += got.length;
        }
        assert.ok(points > corpus.cases.length * 10, `${points} points in all`);
    });

test('the corpus reaches every domain, partitioning and output, culled and whole', ()=>{
    const seen = new Set(corpus.cases.map(one=>`${one.domain}:${one.partitioning}:${one.output}`));
    for (const domain of ['isoline', 'tri', 'quad'])
    {
        for (const partitioning of Object.values(PARTITIONING))
        {
            const outputs = domain === 'isoline' ? [OUTPUT.POINT, OUTPUT.LINE]
                : [OUTPUT.POINT, OUTPUT.TRIANGLE_CW, OUTPUT.TRIANGLE_CCW];
            for (const output of outputs)
            {
                assert.ok(seen.has(`${domain}:${partitioning}:${output}`),
                    `${domain} ${partitioning} ${output}`);
            }
        }
    }
    assert.ok(corpus.cases.some(one=>one.points === ''), 'a culled patch');
});

test('a quad of factor 1 is two triangles over its corners, wound as asked', ()=>{
    const cw = tessellate('quad', PARTITIONING.INTEGER, OUTPUT.TRIANGLE_CW, [1, 1, 1, 1, 1, 1]);
    assert.deepEqual([...cw.points], [0, 0, 1, 0, 1, 1, 0, 1]);
    assert.deepEqual([...cw.indices], [0, 1, 3, 1, 2, 3]);
    const ccw = tessellate('quad', PARTITIONING.INTEGER, OUTPUT.TRIANGLE_CCW, [1, 1, 1, 1, 1, 1]);
    assert.deepEqual([...ccw.indices], [0, 3, 1, 1, 3, 2]);
    assert.equal(tessellate('tri', PARTITIONING.INTEGER, OUTPUT.TRIANGLE_CW, [0, 1, 1, 1])
        .points.length, 0, 'an edge factor of 0 culls the patch');
});
