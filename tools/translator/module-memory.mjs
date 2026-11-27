/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a translated module costs the process past its own bytes: cork's
 * region modules for the micro benchmark's 32-bit and x86-64 images (the
 * first REGIONS each reaches breadth first) compiled and held, and the
 * resident memory they added, as a multiple of their wasm bytes. The
 * engine's flags decide what is compiled: by default nothing until it runs
 * (lazy compilation, the bytes and the engine's metadata only);
 * `--no-wasm-lazy-compilation --no-wasm-tier-up` every function by the
 * baseline compiler; `--no-wasm-lazy-compilation --no-liftoff` every
 * function by the optimising one. A running program pays the first for every
 * module and the others for what ran, cold and hot.
 *
 *     node --expose-gc [engine flags] tools/translator/module-memory.mjs [--regions N]
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const IMAGE_BASE = 0x401000;

const argv = process.argv.slice(2);
const at = argv.indexOf('--regions');
const regions = at < 0 ? 40 : Number(argv[at + 1]);
if (typeof globalThis.gc !== 'function')
{
    throw new Error('module-memory: run node with --expose-gc, or what is collectable is counted '
        + 'as held');
}
const cork = fileURLToPath(new URL('../../modules/cork', import.meta.url));
const { regionModule } = await import(`${cork}/src/region-module.js`);
const { formRegion } = await import(`${cork}/src/region.js`);
const { MODE_64 } = await import(`${cork}/src/decode/decoder.js`);
const hostFeatures = { simd: true, tailCalls: true, sharedMemory: true, defaultNaNNegative: true,
    armHost: false };

/** @type {Uint8Array[]} */
const modules = [];
for (const [bits, dir, suffix] of /** @type {const} */ ([[32, 'images', '-x87.bin'],
    [64, 'images64', '-x64.bin']]))
{
    const path = `${cork}/bench/micro/${dir}/`;
    for (const file of readdirSync(path).filter(name=>name.endsWith(suffix)).sort())
    {
        const image = new Uint8Array(readFileSync(path + file));
        const read = (/** @type {number} */ address)=>{
            const offset = address - IMAGE_BASE;
            return offset >= 0 && offset < image.length ? image[offset] : 0xf4;
        };
        const queue = [IMAGE_BASE];
        const seen = new Set(queue);
        for (let taken = 0; queue.length > 0 && taken < regions; taken++)
        {
            const entry = /** @type {number} */ (queue.shift());
            modules.push(regionModule({ code: image, at: IMAGE_BASE, entry, bits, hash: true,
                callReturn: true, looseStacks: true, hostFeatures }).wasm);
            const form = bits === 64 ? { mode: MODE_64 } : {};
            for (const block of formRegion(read, entry, form).blocks)
            {
                for (const target of [...block.exit.targets, ...block.exit.predicted ?? []])
                {
                    const inside = target >= IMAGE_BASE && target < IMAGE_BASE + image.length;
                    if (inside && !seen.has(target))
                    {
                        seen.add(target);
                        queue.push(target);
                    }
                }
            }
        }
    }
}

const settled = ()=>{
    for (let i = 0; i < 4; i++)
    {
        /** @type {() => void} */ (globalThis.gc)();
    }
    return process.memoryUsage().rss;
};
const bytes = modules.reduce((sum, wasm)=>sum + wasm.length, 0);
const before = settled();
const held = modules.map(wasm=>new WebAssembly.Module(wasm));
const added = settled() - before;
const mib = (/** @type {number} */ n)=>(n / 1048576).toFixed(1);
const flags = process.execArgv.filter(flag=>flag !== '--expose-gc').join(' ') || '(defaults)';
console.log(`node ${process.version} ${flags}: `
    + `${held.length} modules, ${mib(bytes)} MiB of wasm; resident +${mib(added)} MiB, `
    + `${(added / bytes).toFixed(2)} times their bytes`);
