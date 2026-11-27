/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The BC6H and BC7 decoders' corpus: seeded blocks of every mode (random bits
 * under each mode's bits in turn, the reserved modes among them) and what an
 * independent decoder makes of each, kept in the repository as
 * `modules/core/src/layers/graphics/d3d10/bc67-corpus.json.gz` for
 * `bc67.test.js` to hold `bc67.js` to.
 *
 *   node tools/generators/bc-corpus.mjs ORACLE [--seed N] [--count N]
 *
 * ORACLE reads lines of `kind hex` (kind bc7, bc6hu or bc6hs; the block's 16
 * bytes in hex) and answers each with the decoded block in hex: BC7 as 64
 * bytes of RGBA, BC6H as 48 halves of RGB. The one the corpus was made with
 * is a driver around bcdec (https://github.com/iOrange/bcdec, MIT or the
 * Unlicense) built locally; nothing of it is in the repository.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const argv = process.argv.slice(2);
const oracle = argv.find(arg=>!arg.startsWith('--'));
if (!oracle)
{
    console.log('usage: node tools/generators/bc-corpus.mjs ORACLE [--seed N] [--count N]');
    process.exit(2);
}
/** @param {string} name @param {number} fallback */
const option = (name, fallback)=>(argv.includes(name) ? Number(argv[argv.indexOf(name) + 1])
    : fallback);
const seed = option('--seed', 0xbc67);
const count = option('--count', 3000);

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

/** BC6H's mode bits: the fourteen modes, then the four reserved. */
const BC6H_MODES = [0, 1, 2, 6, 10, 14, 18, 22, 26, 30, 3, 7, 11, 15, 19, 23, 27, 31];
/** @type {{ kind: string, block: string }[]} */
const cases = [];
for (let i = 0; i < count; i++)
{
    const kind = ['bc7', 'bc6hu', 'bc6hs'][i % 3];
    const turn = Math.floor(i / 3);
    const block = Uint8Array.from({ length: 16 }, ()=>Math.floor(next() * 256));
    if (kind === 'bc7')
    {
        // Mode m is the first one bit at m; nine turns, the last reserved.
        const mode = turn % 9;
        block[0] = mode < 8 ? (block[0] & ~((2 << mode) - 1)) | (1 << mode) : 0;
    }
    else
    {
        const mode = BC6H_MODES[turn % BC6H_MODES.length];
        const bits = mode < 2 ? 2 : 5;
        block[0] = (block[0] & ~((1 << bits) - 1)) | mode;
    }
    cases.push({ kind, block: Buffer.from(block).toString('hex') });
}
const lines = execFileSync(oracle, {
    input: `${cases.map(one=>`${one.kind} ${one.block}`).join('\n')}\n`, maxBuffer: 1 << 28,
}).toString().split('\n').filter(line=>line.length > 0);
if (lines.length !== cases.length)
{
    throw new Error(`bc-corpus: the oracle answered ${lines.length} of ${cases.length} blocks`);
}
const corpus = {
    seed,
    source: 'bcdec (iOrange), bcdec_bc7 and bcdec_bc6h_half',
    cases: cases.map((one, index)=>({ ...one, decoded: lines[index] })),
};
const packed = gzipSync(JSON.stringify(corpus), { level: 9 });
writeFileSync(new URL('../../modules/core/src/layers/graphics/d3d10/bc67-corpus.json.gz',
    import.meta.url), packed);
console.log(`${cases.length} blocks, ${packed.length} bytes`);
