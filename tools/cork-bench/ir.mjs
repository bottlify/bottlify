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
 * The runtime's budgets are timed (`holdMs` and the rest), and under valgrind
 * a millisecond is fifty times the work: what it forms, and what forming it
 * goes on doing between the counted slices, follows the machine's load. game-sse
 * counted 1.047 M, 1.088 M and 1.115 M an iteration in three runs of one tree,
 * vcall 1.33 M or 2.00 M. `CLOCK` gives the run a clock of its own, moving that
 * many milliseconds a reading, which every run reads alike. A hundred counted
 * iterations still differ under it (tree 3.21 M or 3.42 M at 0.001; not
 * explained, the runtime's timers, which fire by the real clock, a suspect); a
 * thousand (`ir.sh`'s ITERS) agreed within 0.23 % on every workload, two runs
 * of two trees each.
 *
 * BITS=64 runs the workload's x86-64 twin (`images64/NAME-x64.bin`) on the
 * 64-bit translator.
 *
 *     node ir.mjs NAME WARM ITERS [native]   env VARIANT (x87), BITS (32), CORK (json), APP_ROOT,
 *         CLOCK
 */

import { readFileSync } from 'node:fs';

if (process.env.CLOCK)
{
    let now = 0;
    const tick = Number(process.env.CLOCK);
    performance.now = ()=>(now += tick);
    Date.now = ()=>Math.floor(1.7e12 + now);
}

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
    const bits = process.env.BITS === '64' ? 64 : 32;
    const image = readFileSync(bits === 64 ? `${root}/tools/cork-bench/images64/${name}-x64.bin`
        : `${root}/tools/cork-bench/images/${name}-${process.env.VARIANT ?? 'x87'}.bin`);
    const made = hostOf({ ...host, engine, cork: JSON.parse(process.env.CORK ?? '{}'), executors: 1,
        executor: 0, bits }, new Uint8Array(image));
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
