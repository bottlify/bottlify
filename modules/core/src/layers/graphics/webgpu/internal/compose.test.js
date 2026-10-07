/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the composed screen: on seeded random layouts of two and three
 * processes' windows over random layers, the plan carried out as copies gives
 * every pixel the reference gives it: the pixel of the topmost visible window
 * over it, from its process's layer, and the base layer's where no window is.
 * And the presenter, handed each process's frame on a device that keeps its
 * texels, puts on the canvas what the reference does -- or, with one process
 * showing, that process's frame as it is.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseOf, compositionPlan, needsComposing } from './compose.js';
import { createFakeDevice } from './fake-device.js';
import { createPresenter } from './presenter.js';

/** A small generator, so a failing seed runs again the same. @param {number} seed */
function random(seed){
    let state = seed >>> 0 || 1;
    return (/** @type {number} */ below)=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) % below;
    };
}

/**
 * @param {import('./compose.js').Copy[]} plan
 * @param {Map<number, { width: number, height: number, pixels: Uint32Array }>} layers
 * @param {{ width: number, height: number }} screen
 */
const carryOut = (plan, layers, screen)=>{
    const out = new Uint32Array(screen.width * screen.height);
    for (const copy of plan)
    {
        const layer = /** @type {any} */ (layers.get(copy.source));
        for (let y = 0; y < copy.height; y++)
        {
            for (let x = 0; x < copy.width; x++)
            {
                out[(copy.toY + y) * screen.width + copy.toX + x]
                    = layer.pixels[(copy.y + y) * layer.width + copy.x + x];
            }
        }
    }
    return out;
};

/**
 * @param {import('./compose.js').PlacedWindow[]} windows  the topmost first
 * @param {Map<number, { width: number, height: number, pixels: Uint32Array }>} layers
 * @param {number} base @param {{ width: number, height: number }} screen
 */
const reference = (windows, layers, base, screen)=>{
    const out = new Uint32Array(screen.width * screen.height);
    for (let y = 0; y < screen.height; y++)
    {
        for (let x = 0; x < screen.width; x++)
        {
            const over = windows.find(window=>{
                const layer = layers.get(window.processId);
                return window.visible && layer && x >= window.rect.left
                    && x < window.rect.right && y >= window.rect.top && y < window.rect.bottom
                    && x < layer.width && y < layer.height;
            });
            const layer = layers.get(over ? over.processId : base);
            out[y * screen.width + x] = layer && x < layer.width && y < layer.height
                ? layer.pixels[y * layer.width + x] : 0;
        }
    }
    return out;
};

/**
 * A random layout: the screen, each process's picture, the run's windows
 * (topmost first) and the foreground window's process.
 *
 * @param {number} seed
 */
const layout = seed=>{
    const next = random(seed);
    const screen = { width: 48 + next(32), height: 40 + next(24) };
    const processes = 2 + next(2);
    /** @type {Map<number, { width: number, height: number, pixels: Uint32Array }>} */
    const layers = new Map();
    for (let p = 1; p <= processes; p++)
    {
        // Mostly the screen's size; now and then a smaller picture, as a
        // device's back buffer is.
        const width = next(4) === 0 ? 10 + next(screen.width) : screen.width;
        const height = next(4) === 0 ? 10 + next(screen.height) : screen.height;
        const pixels = Uint32Array.from({ length: width * height }, ()=>
            (p << 24) | next(0xffffff));
        layers.set(p, { width, height, pixels });
    }
    /** @type {import('./compose.js').PlacedWindow[]} */
    const windows = Array.from({ length: 3 + next(8) }, ()=>{
        const left = next(screen.width + 20) - 10;
        const top = next(screen.height + 20) - 10;
        return {
            processId: 1 + next(processes + 1),
            visible: next(5) !== 0,
            rect: { left, top, right: left + 1 + next(screen.width),
                bottom: top + 1 + next(screen.height) },
        };
    });
    const foreground = next(3) === 0 ? null : windows[next(windows.length)].processId;
    return { screen, layers, windows, foreground };
};

for (let seed = 1; seed <= 40; seed++)
{
    test(`the composed screen is the reference's, pixel for pixel (seed ${seed})`, ()=>{
        const { screen, layers, windows, foreground } = layout(seed);
        const base = baseOf(windows, layers, foreground);
        assert.ok(base !== null);
        const plan = compositionPlan({ windows, layers, base, screen });
        assert.deepEqual(carryOut(plan, layers, screen), reference(windows, layers, base, screen));
    });
}

for (let seed = 1; seed <= 24; seed++)
{
    test(`the presenter puts the reference's screen on the canvas (seed ${seed})`, ()=>{
        const { layers, windows, foreground } = layout(seed);
        const gpu = createFakeDevice();
        const presenter = createPresenter({
            device: gpu.device, queue: gpu.queue, screen: gpu.screen, canvas: gpu.canvas,
            now: ()=>0, windows: ()=>windows, foreground: ()=>foreground,
        });
        let frameIndex = 0;
        /** @type {number} */
        let last = 0;
        for (const [source, layer] of layers)
        {
            const texture = gpu.device.createTexture({
                size: { width: layer.width, height: layer.height }, format: 'bgra8unorm',
                usage: 0x01 | 0x02 | 0x04 });
            texture.bytes.set(new Uint8Array(layer.pixels.buffer));
            presenter.show({ surface: { texture, width: layer.width, height: layer.height,
                format: 'bgra8unorm' }, frameIndex: frameIndex++, source });
            last = source;
        }
        const canvas = gpu.screen.getCurrentTexture();
        const shown = new Uint32Array(canvas.bytes.buffer.slice(0));
        if (!needsComposing(windows))
        {
            // The process with windows showing, whoever presented last; with
            // none showing, the last frame.
            const showing = windows.find(window=>window.visible && layers.has(window.processId));
            const expected = showing ? showing.processId : last;
            assert.deepEqual(shown, /** @type {any} */ (layers.get(expected)).pixels,
                'one process showing: its frame, as it is');
            return;
        }
        const base = /** @type {number} */ (baseOf(windows, layers, foreground));
        const under = /** @type {any} */ (layers.get(base));
        const screen = { width: under.width, height: under.height };
        assert.deepEqual(shown, reference(windows, layers, base, screen));
        assert.equal(presenter.diagnostics().composed, layers.size,
            'composed on every frame while two processes show windows');
    });
}

test('one process\'s windows need no composing; two do', ()=>{
    const rect = { left: 0, top: 0, right: 10, bottom: 10 };
    assert.equal(needsComposing([{ processId: 1, rect, visible: true },
        { processId: 1, rect, visible: true }, { processId: 2, rect, visible: false }]), false);
    assert.equal(needsComposing([{ processId: 1, rect, visible: true },
        { processId: 2, rect, visible: true }]), true);
});

test('the base is the foreground window\'s process, else the topmost visible window\'s', ()=>{
    const rect = { left: 0, top: 0, right: 10, bottom: 10 };
    const layers = new Map([[1, { width: 10, height: 10 }], [2, { width: 10, height: 10 }]]);
    const windows = [{ processId: 3, rect, visible: true }, { processId: 2, rect, visible: false },
        { processId: 1, rect, visible: true }];
    assert.equal(baseOf(windows, layers, 2), 2);
    assert.equal(baseOf(windows, layers, 3), 1, 'a process with no picture is passed over');
    assert.equal(baseOf(windows, layers, null), 1);
});

test('a frame of a process with no window showing is kept, not shown over the one that has',
    ()=>{
        const gpu = createFakeDevice();
        const rect = { left: 0, top: 0, right: 4, bottom: 4 };
        const windows = [{ processId: 1, rect, visible: true },
            { processId: 2, rect, visible: false }];
        const presenter = createPresenter({
            device: gpu.device, queue: gpu.queue, screen: gpu.screen, canvas: gpu.canvas,
            now: ()=>0, windows: ()=>windows, foreground: ()=>null,
        });
        /** @param {number} source @param {number} value */
        const present = (source, value)=>{
            const texture = gpu.device.createTexture({ size: { width: 4, height: 4 },
                format: 'bgra8unorm', usage: 0x01 | 0x02 | 0x04 });
            texture.bytes.fill(value);
            presenter.show({ surface: { texture, width: 4, height: 4, format: 'bgra8unorm' },
                frameIndex: 0, source });
        };
        present(1, 0x11);
        present(2, 0x22);
        assert.equal(gpu.screen.getCurrentTexture().bytes[0], 0x11, 'the showing process\'s');
        assert.equal(presenter.diagnostics().unshown, 1);
        presenter.forget(1);
        windows.shift();
        present(2, 0x33);
        assert.equal(gpu.screen.getCurrentTexture().bytes[0], 0x33,
            'none showing: the newest frame, as before');
    });
