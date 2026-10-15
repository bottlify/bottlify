/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Whether V8 keeps a call's parameters in registers: the parameter sweep's
 * modules compiled by TurboFan with their machine code printed, and for each
 * parameter count the stores of arguments to the stack before the call
 * counted -- `push` on x64, `str`/`stp` to `[sp...]` on arm64. A count above
 * zero is the parameters past the registers passed in memory.
 *
 *     node modules/cork/bench/calls/inspect.mjs
 *
 * Needs a Node whose V8 prints code (`--print-wasm-code`); one that does not
 * says so rather than answering zero.
 */

import { spawnSync } from 'node:child_process';
import { arch } from 'node:os';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === 'child')
{
    const { sweepModule } = await import('./calls.mjs');
    const { bytes } = sweepModule(Number(process.argv[3]));
    const { instance } = await WebAssembly.instantiate(bytes);
    const run = /** @type {(n: number) => number} */ (instance.exports.run);
    for (let i = 0; i < 3000; i++)
    {
        run(1000);
    }
    process.exit(0);
}

const self = fileURLToPath(import.meta.url);
console.log(`${arch()}, node ${process.version}, V8 ${process.versions.v8}`);
for (const k of [2, 4, 5, 6, 7, 8, 10, 12, 16, 20])
{
    const child = spawnSync(process.execPath, ['--no-liftoff', '--print-wasm-code', self, 'child',
        String(k)], { encoding: 'utf8', maxBuffer: 1 << 28 });
    const text = child.stdout;
    if (!text.includes('compiler: TurboFan'))
    {
        console.log('not measured: this Node prints no wasm code (--print-wasm-code)');
        process.exit(1);
    }
    // The root, the loop that calls the chain: the function after sixteen depths of eight.
    const functions = text.split('--- WebAssembly code ---').filter(one=>one.includes('TurboFan'));
    const root = functions.find(one=>/index: 128\b/.test(one)) ?? functions[functions.length - 1];
    const lines = root.split('\n');
    const call = lines.findIndex(line=>/\s(call|bl|blr)\s/.test(line) && !/stack|Stack/.test(line)
        && lines.indexOf(line) > 20);
    const before = lines.slice(0, call < 0 ? lines.length : call);
    const loopStart = Math.max(0, before.findLastIndex(line=>/\s(j\w+|b\.\w+|b)\s.*<\+0x/.test(line)
        || /nop/.test(line)));
    const stores = before.slice(loopStart).filter(line=>/\spush\s/.test(line)
        || /\s(str|stp|stur)\s[^;]*\[sp/.test(line)).length;
    console.log(`k=${String(k).padStart(2)}  arguments stored to the stack before the call:`
        + ` ${stores}`);
}
