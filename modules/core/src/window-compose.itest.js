/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The screen composed of two programs' pictures (roadmap/v2/windows.md, step
 * 3). The fixture's parent shows a red window at the screen's corner, its
 * child a blue one over the parent's lower right quarter; each draws only its
 * own desktop. The canvas, read back, has the parent's red where only its
 * window is, the child's blue where the child's window is -- over the parent's
 * too -- and neither where no window is. Where one process runs at a time,
 * the parent is held while its child runs, and its picture is the one it
 * showed last.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { createFakeDevice } from './layers/graphics/webgpu/internal/fake-device.js';

/**
 * What the canvas shows at a point, if it shows anything.
 *
 * @param {any} gpu @param {number} x @param {number} y
 * @returns {'red' | 'blue' | 'other' | null}
 */
const colourAt = (gpu, x, y)=>{
    const texture = gpu.screen.getCurrentTexture();
    const width = texture.extent?.width ?? 0;
    if (!texture.bytes || x >= width || (y + 1) * width * 4 > texture.bytes.length)
    {
        return null;
    }
    const at = (y * width + x) * 4;
    const [blue, green, red] = texture.bytes.subarray(at, at + 3);
    if (red === 0xff && green === 0 && blue === 0)
    {
        return 'red';
    }
    return blue === 0xff && green === 0 && red === 0 ? 'blue' : 'other';
};

for (const concurrency of /** @type {const} */ ([1, 2, 4]))
{
    test(`two programs' overlapping windows are on the screen in their order (concurrency ${
        concurrency})`, { timeout: 120000 }, async t=>{
        const program = new Uint8Array(await readFile(new URL('../test/fixtures/overlap.exe',
            import.meta.url)));
        const gpu = createFakeDevice();
        Object.assign(gpu.device, { queue: gpu.queue, features: new Set(),
            createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }) });
        const app = await createApp({
            executable: program,
            imagePath: 'C:\\App\\overlap.exe',
            engine: 'cork',
            concurrency,
            device: { device: gpu.device, queue: gpu.queue, screen: gpu.screen,
                canvas: gpu.canvas },
            storage: { load: async()=>({
                files: [{ path: 'C:\\App\\overlap.exe', bytes: program }],
            }) },
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        /** @type {(string | null)[]} */
        let seen = [];
        let composed = false;
        const looking = setInterval(()=>{
            seen = [[50, 50], [150, 150], [250, 250], [50, 250], [400, 400]]
                .map(([x, y])=>colourAt(gpu, x, y));
            composed ||= seen.join() === 'red,blue,blue,other,other';
            if (composed)
            {
                // Only once both pictures are up is the child told to go.
                app.input.send({ kind: 'key', code: 'KeyA', down: true });
            }
        }, 50);
        t.after(()=>clearInterval(looking));
        assert.equal(await app.run({ timeoutMs: 60000 }), 0, output.join(''));
        assert.doesNotMatch(output.join(''), /FAIL/);
        assert.ok(composed, `the screen showed both windows in their order; last seen ${
            seen.join()} at (50,50) (150,150) (250,250) (50,250) (400,400)`);
    });
}
