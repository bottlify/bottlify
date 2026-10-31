/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A tool's view of the run (`debug.windows`, `debug.desktop`) is the run's,
 * not the one process's the facade speaks for: a harness that lists the
 * windows and writes the screen to a file sees a dialog a setup's helper
 * process shows as the page does. The fixture's parent shows a red window at
 * the screen's corner, its child a blue one over the parent's lower right
 * quarter; with no GPU, the screen read back is composed on bytes by the same
 * plan the presenter carries out as texture copies. And a call the tool is
 * handed says which process's image made it, on which thread.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

/**
 * What a picture shows at a point.
 *
 * @param {{ width: number, height: number, pitch: number, bytes: Uint8Array } | null} picture
 * @param {number} x @param {number} y
 * @returns {'red' | 'blue' | 'other' | null}
 */
const colourAt = (picture, x, y)=>{
    if (!picture || x >= picture.width || y >= picture.height)
    {
        return null;
    }
    const at = y * picture.pitch + x * 4;
    const [blue, green, red] = picture.bytes.subarray(at, at + 3);
    if (red === 0xff && green === 0 && blue === 0)
    {
        return 'red';
    }
    return blue === 0xff && green === 0 && red === 0 ? 'blue' : 'other';
};

test('a tool sees every process\'s windows and the screen they compose', { timeout: 120000 },
    async t=>{
        const program = new Uint8Array(await readFile(new URL('../test/fixtures/overlap.exe',
            import.meta.url)));
        /** @type {Set<string>} */
        const callers = new Set();
        const app = await createApp({
            executable: program,
            imagePath: 'C:\\App\\overlap.exe',
            concurrency: 1,
            storage: { load: async()=>({
                files: [{ path: 'C:\\App\\overlap.exe', bytes: program }],
            }) },
            // A tool's trace of the calls: each says whose it is.
            onCall: (/** @type {any} */ call)=>{
                callers.add(`${call.image} ${typeof call.thread}`);
            },
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        /** @type {any[]} */
        let windows = [];
        /** @type {(string | null)[]} */
        let seen = [];
        let both = false;
        let tick = 0;
        const looking = setInterval(()=>{
            if (!both)
            {
                windows = app.debug.windows();
                const desktop = app.debug.desktop();
                seen = [[50, 50], [150, 150], [250, 250], [50, 250], [400, 400]]
                    .map(([x, y])=>colourAt(desktop, x, y));
                both = new Set(windows.filter(window=>window.visible && !window.child)
                    .map(window=>window.processId)).size === 2
                    && seen.join() === 'red,blue,blue,other,other';
                return;
            }
            // Then on as the fixture asks, to its end: a click on each
            // window, then a key to the child's.
            tick++;
            /** @param {number} x @param {number} y */
            const click = (x, y)=>{
                app.input.send({ kind: 'pointerMove', x, y });
                app.input.send({ kind: 'pointerButton', button: 'left', down: true, x, y });
                app.input.send({ kind: 'pointerButton', button: 'left', down: false, x, y });
            };
            if (tick === 1)
            {
                click(50, 50);
            }
            else if (tick === 20)
            {
                click(250, 250);
            }
            else if (tick > 40)
            {
                app.input.send({ kind: 'key', code: 'KeyA', down: true });
            }
        }, 50);
        t.after(()=>clearInterval(looking));
        assert.equal(await app.run({ timeoutMs: 60000 }), 0, output.join(''));
        assert.doesNotMatch(output.join(''), /FAIL/);
        assert.ok(both, `the view showed both processes' windows, composed; last seen ${
            seen.join()} at (50,50) (150,150) (250,250) (50,250) (400,400), windows ${
            JSON.stringify(windows.map(window=>[window.processId, window.title]))}`);
        const top = windows.filter(window=>!window.child);
        assert.ok(top.every(window=>/^0x[0-9a-f]+$/.test(window.hwnd)
            && window.width > 0 && window.height > 0), 'each listed with its place');
        assert.deepEqual([...callers], ['overlap.exe string'],
            'a call names the image of the process that made it, and its thread');
        assert.ok(windows.indexOf(top[0]) === 0 && windows.every((window, at)=>!window.child
            || windows.slice(0, at).some(earlier=>earlier.hwnd === window.parent)),
        'the topmost first, each child after its parent');
    });
