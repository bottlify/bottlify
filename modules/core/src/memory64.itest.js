/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How much memory a 64-bit process is given, through `createApp`
 * (`test/fixtures/src/big64.c` commits 64 MiB at a time until it is refused and
 * says how many it had): a `memorySize` of 4 GiB gives a program its 4 GiB
 * layout nearly whole, one of 8 GiB is 4 GiB and not an error, and under a
 * machine's memory (`machineMemory`, `memory-budget.js`) a commit past it is
 * refused, a null and not a fault, the run never holding more than the machine
 * has - in the 4 GiB layout and over a wide window alike. A wide window is
 * 8 GiB long whatever the program takes of it: it is counted by what the
 * program was given even where a guest's memory counts by its length.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { allowMemory64 } from '../../cork/src/testing/memory64.js';
import { createApp } from './app.js';

const MiB = 2 ** 20;
const GiB = 2 ** 30;
/** What big64.c commits at a time. */
const STEP = 64 * MiB;

/**
 * The fixture as a game ships: no relocations, its base fixed past 4 GiB.
 *
 * @param {Uint8Array} bytes
 */
function stripRelocations(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const pe = view.getUint32(0x3c, true);
    const optional = pe + 24;
    assert.ok(view.getBigUint64(optional + 24, true) >= 2n ** 32n, 'linked past 4 GiB');
    view.setUint16(pe + 22, view.getUint16(pe + 22, true) | 1, true); // RELOCS_STRIPPED
    view.setBigUint64(optional + 112 + 5 * 8, 0n, true); // no base relocation directory
    view.setUint16(optional + 70, view.getUint16(optional + 70, true) & ~0x40, true);
    return bytes;
}

/**
 * @param {Record<string, unknown>} options  createApp's, past the program
 * @param {boolean} [wide]  the image at its own base past 4 GiB
 * @returns {Promise<{ code: number, pages: number, heap: number, lines: string[],
 *     machine: any, guest: any }>}
 */
async function run(options, wide = false){
    allowMemory64();
    const bytes = new Uint8Array(await readFile(
        new URL('../test/fixtures/big64.exe', import.meta.url)));
    const app = await createApp({ executable: wide ? stripRelocations(bytes) : bytes,
        commandLine: '"C:\\big64.exe"', ...options });
    try
    {
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        const code = await app.run({ timeoutMs: 250000 });
        const lines = output.join('').split('\r\n').filter(Boolean);
        /** @param {string} what */
        const count = what=>Number(lines.find(line=>line.startsWith(`${what} `))
            ?.slice(what.length + 1) ?? NaN);
        const cpu = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'cpu');
        return { code, pages: count('pages'), heap: count('heap'), lines,
            machine: cpu?.metrics?.machineMemory, guest: cpu?.metrics?.guestMemory };
    }
    finally
    {
        await app.dispose();
    }
}

/** @param {string[]} lines */
const right = lines=>assert.deepEqual(lines.filter(line=>/^(ok|FAIL)/.test(line)),
    ['ok   every block below 4 GiB', 'ok   every byte read back'], lines.join('\n'));

for (const megabytes of [4096, 8192])
{
    test(`a 64-bit process with a memorySize of ${megabytes} MiB is given its 4 GiB layout`,
        { timeout: 300000 }, async()=>{
            const { code, pages, lines, guest } = await run({ memorySize: megabytes * MiB });
            right(lines);
            assert.equal(code, 0);
            assert.equal(guest.ceiling, 4 * GiB);
            // All but the images, the stacks, the engine's range and the top the
            // system keeps: past 3 GiB of the 4.
            assert.ok(pages * STEP >= 3 * GiB && pages * STEP < 4 * GiB, `${pages} blocks`);
        });
}

/** A machine with room for less than the program asks: 1.5 GiB. */
const MACHINE = 1536 * MiB;
for (const wide of [false, true])
{
    for (const guestCharge of /** @type {const} */ (['given', 'length']))
    {
        test(`a commit past the machine's memory is refused, not a fault, ${wide
            ? 'over a wide window' : 'in the 4 GiB layout'} (guests counted by ${guestCharge})`,
        { timeout: 300000 }, async()=>{
            const { code, pages, heap, lines, machine, guest } = await run({
                memorySize: 4 * GiB, machineMemory: MACHINE, cpu: { guestCharge } }, wide);
            right(lines);
            assert.equal(code, 0);
            assert.ok(machine && machine.limit === MACHINE, JSON.stringify(machine));
            assert.ok(machine.peak <= machine.limit, JSON.stringify(machine));
            assert.ok(machine.refused > 0, 'the machine refused an ask');
            assert.ok((pages + heap) * STEP < MACHINE, `${pages} + ${heap} blocks`);
            // The program had most of the machine: nothing refused it early.
            assert.ok(pages * STEP >= MACHINE / 2, `${pages} blocks`);
            if (wide)
            {
                // The window's length is no charge: what the program took is.
                assert.ok(guest.held > MACHINE, JSON.stringify(guest));
                assert.ok(machine.byKind.guest >= pages * STEP, JSON.stringify(machine));
            }
        });
    }
}
