/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The tessellator's corpus: patches drawn from a seed, every domain,
 * partitioning and output primitive, and what Microsoft's reference
 * tessellator (the D3D11.3 functional specification's tessellator.cpp, MIT,
 * THIRD-PARTY-NOTICES.md) makes of each, kept in the repository as
 * `modules/core/src/layers/graphics/d3d10/tess-corpus.json.gz` for
 * `tessellator.test.js` to hold the engine's tessellator to.
 *
 *   node tools/generators/tess-corpus.mjs ORACLE [--seed N] [--count N]
 *
 * ORACLE is the reference built with a small driver, which reads lines of
 * `domain partitioning output f0 .. f5` (domain 0 isoline, 1 tri, 2 quad; the
 * D3D11 enums' numbers) and answers each with its points, each `u,v` as the
 * float's bits in hex, a `|`, and its indices. Neither the reference nor the
 * driver is in the repository: tessellator.cpp and tessellator.hpp come from
 * https://microsoft.github.io/DirectX-Specs/d3d/archive/images/d3d11/, the
 * driver is the loop the corpus format describes.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const argv = process.argv.slice(2);
const oracle = argv.find(arg=>!arg.startsWith('--'));
if (!oracle)
{
    console.log('usage: node tools/generators/tess-corpus.mjs ORACLE [--seed N] [--count N]');
    process.exit(2);
}
/** @param {string} name @param {number} fallback */
const option = (name, fallback)=>(argv.includes(name) ? Number(argv[argv.indexOf(name) + 1])
    : fallback);
const seed = option('--seed', 0x7e55);
const count = option('--count', 1500);

/** xorshift32, the generator's only randomness. */
let state = seed >>> 0 || 1;
const next = ()=>{
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
};
/** @param {number} n */
const pick = n=>Math.floor(next() * n);

/** Values at the edges of what the stage clamps, rounds and culls. */
const SPECIAL = [0, -1, -0, NaN, Infinity, 1, 1.0000076, 1.5, 2, 2.0000153, 63, 63.5, 64, 64.5, 65,
    1e9, 0.5, 2 ** -20, 3.0000153, 2.9999847,
    // Halfway between two 16.16 values, the even one below and above: the
    // conversion to fixed point rounds them to the even one.
    1 + 2 ** -17, 3 + 3 * 2 ** -17, 7 + 7 * 2 ** -17, 4.5 + 2 ** -17, 9.25 + 3 * 2 ** -17];

/** A tess factor: mostly small, as patches are, now and then large or special. */
function factor(){
    const kind = pick(20);
    if (kind <= 2)
    {
        return SPECIAL[pick(SPECIAL.length)];
    }
    if (kind <= 6)
    {
        return 1 + pick(16);
    }
    if (kind === 7)
    {
        return Math.fround(next() * 66);
    }
    return Math.fround(0.5 + next() * 15);
}

/** @param {number} value */
const text = value=>(Number.isNaN(value) ? 'nan' : value === Infinity ? 'inf'
    : Object.is(value, -0) ? '-0' : Math.fround(value).toPrecision(9));
/** @param {number} value */
const bits = value=>{
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    return view.getUint32(0, true).toString(16);
};

const OUTPUTS = [[0, 1], [0, 2, 3], [0, 2, 3]];
/** @type {{ domain: number, partitioning: number, output: number, factors: number[] }[]} */
const cases = [];
for (let i = 0; i < count; i++)
{
    const domain = i % 3;
    const factors = Array.from({ length: [2, 4, 6][domain] }, factor);
    // One patch in four has its factors all alike, as an artist's often are.
    if (pick(4) === 0)
    {
        factors.fill(factors[0]);
    }
    cases.push({ domain, partitioning: pick(4),
        output: OUTPUTS[domain][pick(OUTPUTS[domain].length)], factors });
}
const input = cases.map(one=>[one.domain, one.partitioning, one.output,
    ...[...one.factors, 0, 0, 0, 0, 0, 0].slice(0, 6).map(text)].join(' ')).join('\n');
const lines = execFileSync(oracle, { input: `${input}\n`, maxBuffer: 1 << 30 }).toString()
    .split('\n').filter(line=>line.length > 0);
if (lines.length !== cases.length)
{
    throw new Error(`tess-corpus: the oracle answered ${lines.length} of ${cases.length} cases`);
}
const corpus = {
    seed,
    source: 'Microsoft D3D11 Fixed Function Tessellator Reference (May 7, 2012), CHWTessellator',
    cases: cases.map((one, index)=>{
        const [points, indices] = lines[index].split('|');
        return { domain: ['isoline', 'tri', 'quad'][one.domain], partitioning: one.partitioning,
            output: one.output, factors: one.factors.map(bits), points: points.trim(),
            indices: indices.trim() };
    }),
};
const out = new URL('../../modules/core/src/layers/graphics/d3d10/tess-corpus.json.gz',
    import.meta.url);
const packed = gzipSync(JSON.stringify(corpus), { level: 9 });
writeFileSync(out, packed);
console.log(`${cases.length} cases, ${packed.length} bytes`);
