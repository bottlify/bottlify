/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One workload run WARM then ITERS times, for counting the machine
 * instructions an iteration takes under valgrind (`ir.sh`): cork's
 * translation of the i386 image, or the same C compiled straight to wasm
 * (`native/`). The warm-up waits for every translation it asked for, so the
 * counted iterations run translated code and no translator.
 *
 *     node ir.mjs NAME WARM ITERS [native]   env VARIANT (x87), CORK (json), APP_ROOT
 */

import { readFileSync } from 'node:fs';

const root = process.env.APP_ROOT ?? new URL('../../', import.meta.url).pathname;
const [name, warm, iters, native] = process.argv.slice(2);
let step;
if (native === 'native')
{
    const bytes = readFileSync(new URL(`native/${name}.wasm`, import.meta.url));
    const { instance } = await WebAssembly.instantiate(bytes, {});
    step = /** @type {() => void} */ (instance.exports.main);
    for (let i = 0; i < Number(warm); i++) step();
}
else
{
    const host = await import(`${root}/modules/core/src/layers/cpu/internal/cork-host.js`);
    const engine = await import(`${root}/modules/cork/src/index.js`);
    const { hostOf } = await import(`${root}/tools/cork-bench/paired.js`);
    const image = readFileSync(`${root}/tools/cork-bench/images/${name}-${process.env.VARIANT ?? 'x87'}.bin`);
    const made = hostOf({ ...host, engine, cork: JSON.parse(process.env.CORK ?? '{}'), executors: 1,
        executor: 0, bits: 32 }, new Uint8Array(image));
    const cork = made.host.cork();
    step = made.iteration;
    for (let i = 0; i < Number(warm); i++)
    {
        step();
        await cork.translatePending();
    }
}
for (let i = 0; i < Number(iters); i++)
{
    step();
}
process.exit(0);
