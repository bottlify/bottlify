/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Code a 64-bit process runs from outside its image, through `createApp`
 * (`test/fixtures/src/jit64.c`): a loop in the image, the same bytes copied
 * into pages the program asked for as executable, the heap's own routines and
 * the C runtime's `strlen` - each with the image placed low, where one code
 * block holds everything, and with its relocations stripped, at 0x140000000
 * over a wide window, where the image's block and the one below 4 GiB are each
 * translated by a runtime of their own (cork-host's `twoBlockRuntime`), the
 * calls between them far exits. The answers are the same and so is the count
 * of instructions retired, wherever the code lay; over the window the code
 * below 4 GiB is translated, not left to the interpreter tier.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { allowMemory64 } from '../../cork/src/testing/memory64.js';
import { createApp } from './app.js';

/** @param {Uint8Array} bytes  the fixture as a game ships: no relocations, past 4 GiB */
function stripRelocations(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const pe = view.getUint32(0x3c, true);
    const optional = pe + 24;
    assert.ok(view.getBigUint64(optional + 24, true) >= 2n ** 32n, 'linked past 4 GiB');
    view.setUint16(pe + 22, view.getUint16(pe + 22, true) | 1, true);
    view.setBigUint64(optional + 112 + 5 * 8, 0n, true);
    view.setUint16(optional + 70, view.getUint16(optional + 70, true) & ~0x40, true);
    return bytes;
}

/**
 * @param {string} how  the fixture's letter
 * @param {boolean} wide
 */
async function run(how, wide){
    allowMemory64();
    const bytes = new Uint8Array(await readFile(
        new URL('../test/fixtures/jit64.exe', import.meta.url)));
    const app = await createApp({ executable: wide ? stripRelocations(bytes) : bytes,
        commandLine: `"C:\\jit64.exe" ${how}`, memorySize: 2 ** 32 });
    try
    {
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        const code = await app.run({ timeoutMs: 250000 });
        const cpu = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'cpu');
        return { code, lines: output.join('').split('\r\n').filter(Boolean),
            instructions: cpu?.metrics?.instructions, below: cpu?.metrics?.cork?.belowBlock };
    }
    finally
    {
        await app.dispose();
    }
}

const WHERE = { i: 'the image', j: 'pages it made executable', h: 'the heap\'s routines',
    s: 'the C runtime' };
for (const [how, what] of Object.entries(WHERE))
{
    test(`a loop in ${what} answers the same over a wide window as below 4 GiB`,
        { timeout: 300000 }, async()=>{
            const low = await run(how, false);
            const wide = await run(how, true);
            assert.equal(low.code, 0, low.lines.join('\n'));
            assert.equal(wide.code, 0, wide.lines.join('\n'));
            const sum = (/** @type {string[]} */ lines)=>lines.find(line=>line.startsWith('sum '));
            assert.ok(sum(low.lines), low.lines.join('\n'));
            assert.equal(sum(wide.lines), sum(low.lines));
            assert.ok(low.instructions > 1e6, `${low.instructions} instructions`);
            assert.equal(wide.instructions, low.instructions);
            if (how === 'j')
            {
                // The pages lie below 4 GiB in both: outside a wide window's code block.
                assert.ok(wide.lines.includes('code 0'), wide.lines.join('\n'));
            }
            if (how !== 'i')
            {
                // Translated below 4 GiB, its loop's instructions retired there.
                assert.ok(wide.below?.regions > 0, JSON.stringify(wide.below?.exits));
                assert.ok(wide.below?.retired > low.instructions / 4,
                    `${wide.below?.retired} of ${low.instructions} retired below 4 GiB`);
            }
        });
}
