/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the system places for a 64-bit process lies below 4 GiB, through
 * `createApp`: thread and process blocks, stacks, heap blocks, pages from
 * VirtualAlloc, the C runtime's strings and structures, the system's
 * libraries and their functions, handles, and COM objects with their method
 * tables (`test/fixtures/src/low64.c` asks for each and says where it lies).
 * A guest routine keeps such an address in a dword, and the bridge's tables
 * are keyed by one (`dispatch.js` `byAddress`, `vtable.js` `owners`): this is
 * the rule they stand on.
 *
 * Run twice: the image where its relocations let it be put, and with them
 * stripped, as a 64-bit game ships - at 0x140000000, over a wide window of
 * 8 GiB, where the guest's memory does reach past 4 GiB and only the image
 * is there. Direct3D 9's device, buffer and locked pointer are d3d9_64.exe's
 * own checks (`whole`), run over the wide window too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { allowMemory64 } from '../../cork/src/testing/memory64.js';
import { createApp } from './app.js';
import { fixedPastFourGiB } from './fixed-base.fixture.js';
import { createFakeDevice } from './layers/graphics/webgpu/internal/fake-device.js';

/** @param {string} name */
const fixture = name=>new URL(`../test/fixtures/${name}.exe`, import.meta.url);

/**
 * @param {Uint8Array} executable @param {string} name @param {Record<string, unknown>} [more]
 * @returns {Promise<{ code: number, lines: string[], wide: boolean, app: any }>}
 */
async function run(executable, name, more = {}){
    const app = await createApp({ executable, commandLine: `"C:\\${name}.exe"`, ...more });
    /** @type {string[]} */
    const output = [];
    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>output.push(text));
    const code = await app.run({ timeoutMs: 100000 });
    const cpu = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'cpu');
    return { code, lines: output.join('').split('\r\n').filter(Boolean), app,
        wide: cpu?.metrics?.guestMemory?.window > 2 ** 32 };
}

/** A device for Direct3D 9 to draw on. */
function standInDevice(){
    const gpu = createFakeDevice();
    const gpuDevice = /** @type {any} */ (gpu.device);
    gpuDevice.features = new Set();
    gpuDevice.createSampler = (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor });
    return { device: { device: gpu.device, queue: gpu.queue, screen: gpu.screen,
        canvas: gpu.canvas,
        adapter: { vendor: 'fake', architecture: '', description: 'a stand-in' } } };
}

for (const stripped of [false, true])
{
    const where = stripped ? 'with its image at 0x140000000, over a wide window'
        : 'with its image placed below 2 GiB';
    test(`what the system places for a 64-bit process lies below 4 GiB, ${where}`,
        { timeout: 150000 }, async t=>{
            allowMemory64();
            const bytes = new Uint8Array(await readFile(fixture('low64')));
            const { code, lines, app } = await run(stripped ? fixedPastFourGiB(bytes) : bytes,
                'low64', standInDevice());
            t.after(()=>app.dispose());
            assert.deepEqual(lines.filter(line=>!line.startsWith('ok   ')),
                [`note the image lies ${stripped ? 'past' : 'below'} 4 GiB`, 'all below 4 GiB'],
                lines.join('\n'));
            assert.ok(lines.length >= 40, `${lines.length} places asked`);
            assert.equal(code, 0);
        });
}

test('Direct3D 9\'s device, buffer and locked pointer lie below 4 GiB over a wide window',
    { timeout: 150000 }, async t=>{
        allowMemory64();
        const bytes = fixedPastFourGiB(new Uint8Array(await readFile(fixture('d3d9_64'))));
        const { code, lines, app } = await run(bytes, 'd3d9_64', standInDevice());
        t.after(()=>app.dispose());
        assert.deepEqual(lines.filter(line=>!line.startsWith('ok   ')), [], lines.join('\n'));
        assert.ok(lines.some(line=>line.includes('Lock writes the pointer whole')));
        assert.equal(code, 0);
    });
