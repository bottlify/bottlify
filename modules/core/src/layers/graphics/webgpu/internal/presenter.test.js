/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Two kinds of test. The conversions are byte-exact: the bytes that reach the
 * queue for a surface this engine read are compared against the bytes they
 * must be, channel by channel. What the GPU is asked to do -- one upload,
 * one frame, one present per burst -- is checked through the recording
 * device, never by looking at a picture.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../backend.js';
import { createFakeDevice } from './fake-device.js';
import { createPresenter, expandRow } from './presenter.js';

/** Guest memory is a flat buffer; surfaces are wherever the test puts them. */
function harness(){
    const gpu = createFakeDevice();
    /** @type {any[]} */
    const presented = [];
    const backend = createBackend({
        device: gpu.device,
        queue: gpu.queue,
        presentTo: frame=>presented.push(frame),
        now: ()=>0,
    });
    const ram = new Uint8Array(0x10000);
    /** @type {(() => void)[]} */
    const scheduled = [];
    const presenter = createPresenter({
        backend: ()=>backend,
        readMemory: (address, length)=>ram.slice(address, address + length),
        schedule: flush=>scheduled.push(flush),
    });
    return {
        gpu,
        ram,
        presented,
        presenter,
        /** Runs the burst's flush, the way the microtask would. */
        settle(){
            const flushes = scheduled.splice(0);
            flushes.forEach(flush=>flush());
            return flushes.length;
        },
        /** @returns {Uint8Array} the bytes of the last texture upload */
        uploaded(){
            const writes = gpu.of('writeTexture');
            assert.ok(writes.length > 0, 'something reached the queue');
            return writes[writes.length - 1].bytes;
        },
    };
}

test('byte-exact: a 32-bit surface passes through in storage order with an opaque alpha', ()=>{
    const h = harness();
    // X8R8G8B8 in memory: B, G, R, X -- the X byte holds junk a program never wrote.
    h.ram.set([0x56, 0x34, 0x12, 0x99, 0xcc, 0xbb, 0xaa, 0x00], 0x1000);
    h.presenter.present({ buffer: 0x1000, width: 2, height: 1, pitch: 8, bitCount: 32,
        palette: null });
    h.settle();
    assert.deepEqual([...h.uploaded()], [0x56, 0x34, 0x12, 0xff, 0xcc, 0xbb, 0xaa, 0xff],
        'blue first, and the undefined byte became opaque');
});

test('byte-exact: a 16-bit surface expands 5-6-5 with the top bits replicated', ()=>{
    const h = harness();
    // 0xf800 red, 0x07e0 green, 0x001f blue, 0x8410 every channel at its midpoint.
    h.ram.set([0x00, 0xf8, 0xe0, 0x07, 0x1f, 0x00, 0x10, 0x84], 0x1000);
    h.presenter.present({ buffer: 0x1000, width: 4, height: 1, pitch: 8, bitCount: 16,
        palette: null });
    h.settle();
    assert.deepEqual([...h.uploaded()], [
        0, 0, 255, 255,
        0, 255, 0, 255,
        255, 0, 0, 255,
        132, 130, 132, 255,
    ]);
});

test('byte-exact: an 8-bit surface goes through its palette, entries read as r, g, b bytes', ()=>{
    const h = harness();
    // Two indices; PALETTEENTRY is red, green, blue, flags, so the dword for
    // (r=0x12, g=0x34, b=0x56) is 0x00563412.
    h.ram.set([1, 0], 0x1000);
    const palette = new Array(256).fill(0);
    palette[0] = 0x00aabbcc;
    palette[1] = 0x00563412;
    h.presenter.present({ buffer: 0x1000, width: 2, height: 1, pitch: 2, bitCount: 8, palette });
    h.settle();
    assert.deepEqual([...h.uploaded()], [0x56, 0x34, 0x12, 0xff, 0xaa, 0xbb, 0xcc, 0xff],
        'index one is (0x12, 0x34, 0x56) and lands as B, G, R');
});

test('byte-exact: a palette refreshed in place after the first present shows its new colours', ()=>{
    // The presenter coalesces and re-reads; the contract this pins is that
    // nothing about a surface's first presentation is remembered against it.
    // A palette-relative bitmap's table is refreshed in place -- same array,
    // new entries -- and a program may repaint nothing at all while doing it.
    const h = harness();
    h.ram.set([1, 2], 0x1000);
    // PALETTEENTRY order, as the presenter reads them: red is the low byte.
    const palette = new Array(256).fill(0);
    palette[1] = 0x000000ff; // red
    palette[2] = 0x00000000; // black
    const surface = { buffer: 0x1000, width: 2, height: 1, pitch: 2, bitCount: 8, palette };
    h.presenter.present(surface);
    h.settle();
    assert.deepEqual([...h.uploaded()], [0, 0, 255, 255, 0, 0, 0, 255],
        'the first present: red, then black');
    palette[1] = 0x0000ff00; // entry one is now green
    palette[2] = 0x000000ff; // and red moved to entry two
    h.presenter.present(surface);
    h.settle();
    assert.deepEqual([...h.uploaded()], [0, 255, 0, 255, 0, 0, 255, 255],
        'the same indices now mean the refreshed colours');
});

test('byte-exact: rows are read by the pitch, so padding never reaches the picture', ()=>{
    const h = harness();
    // Two rows of one 8-bit pixel each, with three bytes of padding between.
    h.ram.set([7, 0xee, 0xee, 0xee, 9, 0xee, 0xee, 0xee], 0x1000);
    const palette = new Array(256).fill(0);
    palette[7] = 0x00010203;
    palette[9] = 0x00040506;
    h.presenter.present({ buffer: 0x1000, width: 1, height: 2, pitch: 4, bitCount: 8, palette });
    h.settle();
    assert.deepEqual([...h.uploaded()], [1, 2, 3, 0xff, 4, 5, 6, 0xff]);
    const out = new Uint8Array(4);
    assert.throws(()=>expandRow(new Uint8Array(3), 1, 24, null, out), /cannot be presented/);
});

test('recorded: a burst of changes is one upload, one frame and one present', ()=>{
    const h = harness();
    const surface = { buffer: 0x1000, width: 4, height: 4, pitch: 16, bitCount: 32,
        palette: null };
    h.presenter.present(surface);
    h.presenter.present(surface);
    h.presenter.present(surface);
    assert.equal(h.gpu.count('writeTexture'), 0, 'nothing travels until the burst ends');
    assert.equal(h.settle(), 1, 'one flush was scheduled for the three');

    assert.equal(h.gpu.count('writeTexture'), 1);
    assert.equal(h.gpu.count('createCommandEncoder'), 1);
    assert.equal(h.gpu.count('submit'), 1);
    assert.equal(h.presented.length, 1);
    assert.equal(h.presented[0].surface.format, 'bgra8unorm');
    assert.deepEqual(h.presenter.diagnostics(), {
        presents: 3, uploads: 1, bytes: 64, shownByOwner: 0, shown: 0, shownBy: {},
        lastBuffer: 0x1000, pending: false, claimed: 0, failures: [], disposed: false,
    });

    h.presenter.present(surface);
    h.settle();
    assert.equal(h.gpu.count('createTexture'), 1, 'the same texture serves the same shape');
    assert.equal(h.presented.length, 2);
});

test('recorded: a primary of a new size gets a new texture', ()=>{
    const h = harness();
    h.presenter.present({ buffer: 0x1000, width: 4, height: 4, pitch: 16, bitCount: 32,
        palette: null });
    h.settle();
    h.presenter.present({ buffer: 0x1000, width: 8, height: 2, pitch: 32, bitCount: 32,
        palette: null });
    h.settle();
    const textures = h.gpu.of('createTexture').map(call=>call.descriptor.size);
    assert.deepEqual(textures.map(size=>[size.width, size.height]), [[4, 4], [8, 2]]);
    assert.equal(h.presented[1].surface.width, 8);
});

test('recorded: with no GPU the change is noted and nothing is shown', ()=>{
    /** @type {(() => void)[]} */
    const scheduled = [];
    const presenter = createPresenter({
        backend: ()=>{
            throw new Error('graphics: no GPU device was supplied to this build');
        },
        readMemory: ()=>new Uint8Array(4),
        schedule: flush=>scheduled.push(flush),
    });
    presenter.present({ buffer: 0, width: 1, height: 1, pitch: 4, bitCount: 32, palette: null });
    scheduled.forEach(flush=>flush());
    const report = presenter.diagnostics();
    assert.equal(report.uploads, 0);
    assert.match(report.failures[0], /no GPU/);
});

test('recorded: a claimed address is shown by its owner and its bytes are never read', ()=>{
    const h = harness();
    let shown = 0;
    let read = 0;
    const presenter = createPresenter({
        backend: ()=>{
            throw new Error('the owner shows it, not the backend');
        },
        readMemory: ()=>{
            read++;
            return new Uint8Array(4);
        },
        schedule: flush=>flush(),
    });
    presenter.claim(0x1000, ()=>{
        shown++;
    });
    const surface = { buffer: 0x1000, width: 1, height: 1, pitch: 4, bitCount: 32,
        palette: null };
    presenter.present(surface);
    assert.equal(shown, 1);
    assert.equal(read, 0, 'guest memory holds nothing worth reading for a GPU-drawn surface');
    assert.equal(presenter.diagnostics().shownByOwner, 1);
    assert.equal(presenter.diagnostics().claimed, 1);

    presenter.release(0x1000);
    presenter.present(surface);
    assert.equal(shown, 1, 'released, the address is guest bytes again');
    assert.equal(presenter.diagnostics().failures.length, 1, 'and this build has no GPU for them');
    void h;
});

test('recorded: a presenter with no canvas hands every frame to the caller\'s own sink',
    ()=>{
        // A build with no display -- the unit tests, a headless harness reading
        // one frame back -- still has somewhere to put a frame. Without this the
        // presenter would swallow it, and a run would look like one that drew
        // nothing.
        const gpu = createFakeDevice();
        const ram = new Uint8Array(0x1000);
        /** @type {any[]} */
        const shown = [];
        const backend = createBackend({
            device: gpu.device, queue: gpu.queue,
            presentTo: (/** @type {any} */ frame)=>presenter.show(frame), now: ()=>0,
        });
        const presenter = createPresenter({
            backend: ()=>backend,
            readMemory: (address, length)=>ram.slice(address, address + length),
            presentTo: (/** @type {any} */ frame)=>shown.push(frame),
        });
        presenter.present({ buffer: 0, width: 1, height: 1, pitch: 4, bitCount: 32,
            palette: null });
        presenter.flush();
        assert.equal(shown.length, 1, 'the frame went where the caller asked');
        assert.equal(gpu.count('configure'), 0, 'and no canvas was configured');
    });

test('the run\'s presenter serves two machine lifetimes, configures the canvas once',
    ()=>{
        // A machine is a process: its backend and its address space die with it.
        // The presenter is not: the canvas, the format it was configured in and
        // the texture the primary is copied into belong to the run. This is the
        // shape a process replacement has -- one presenter, a new backend and a
        // new address space -- and the canvas must be configured for the first
        // lifetime only, because reconfiguring it clears the frame the parent
        // last presented.
        const gpu = createFakeDevice();
        const ram = new Uint8Array(0x10000);
        const presenter = createPresenter({
            device: gpu.device, queue: gpu.queue, screen: gpu.screen, canvas: gpu.canvas,
            now: ()=>0,
        });
        const presentFrom = ()=>{
            const backend = createBackend({
                device: gpu.device, queue: gpu.queue,
                presentTo: frame=>presenter.show(frame), now: ()=>0,
            });
            presenter.attach({
                backend: ()=>backend,
                readMemory: (address, length)=>ram.slice(address, address + length),
            });
            return backend;
        };

        ram.set([0x56, 0x34, 0x12, 0xff], 0x100);
        const first = presentFrom();
        presenter.present({ buffer: 0x100, width: 1, height: 1, pitch: 4, bitCount: 32,
            palette: null });
        presenter.flush();
        assert.equal(gpu.count('configure'), 1, 'the first frame configured the canvas');
        assert.equal(presenter.diagnostics().presents, 1);
        assert.equal(presenter.diagnostics().shown, 1);

        // The replacement: the old backend's resources go, the presenter stays.
        first.dispose();
        ram.set([0x11, 0x22, 0x33, 0xff], 0x200);
        presentFrom();
        presenter.present({ buffer: 0x200, width: 1, height: 1, pitch: 4, bitCount: 32,
            palette: null });
        presenter.flush();

        assert.equal(gpu.count('configure'), 1, 'the canvas was not reconfigured at the swap');
        assert.equal(presenter.diagnostics().presents, 2, 'the count continued, not restarted');
        assert.equal(presenter.diagnostics().shown, 2);
        assert.equal(presenter.diagnostics().lastBuffer, 0x200);
        // And what the second lifetime uploaded is what the canvas was shown,
        // rather than the cleared target a fresh presenter would have made.
        assert.deepEqual([...gpu.of('writeTexture').at(-1).bytes], [0x11, 0x22, 0x33, 0xff]);
        assert.equal(gpu.of('copyTextureToTexture').length, 2,
            'each lifetime showed its own frame');
    });

test('every canvas copy is recorded under the label of what was shown', ()=>{
    // A device draws the picture and something else paints the desktop over
    // it: on the canvas both are "a frame". The record of copies names each
    // one's source, so the two are told apart without a screenshot.
    const gpu = createFakeDevice();
    const ram = new Uint8Array(0x1000);
    const presenter = createPresenter({
        device: gpu.device, queue: gpu.queue, screen: gpu.screen, canvas: gpu.canvas,
        now: ()=>0,
    });
    const backend = createBackend({
        device: gpu.device, queue: gpu.queue,
        presentTo: frame=>presenter.show(frame), now: ()=>0,
    });
    presenter.attach({
        backend: ()=>backend,
        readMemory: (address, length)=>ram.slice(address, address + length),
    });

    presenter.present({ buffer: 0x100, width: 1, height: 1, pitch: 4, bitCount: 32,
        palette: null, label: 'desktop' });
    presenter.flush();
    presenter.present({ buffer: 0x100, width: 1, height: 1, pitch: 4, bitCount: 32,
        palette: null });
    presenter.flush();

    // A target the GPU drew, shown through the same path a device's present takes.
    const target = backend.createSurface({ width: 1, height: 1, format: 'bgra8unorm',
        label: 'target', usage: backend.TextureUsage.RENDER_ATTACHMENT });
    const frame = backend.beginFrame();
    frame.present(target);
    frame.end();

    assert.deepEqual(presenter.diagnostics().shownBy, { desktop: 1, 'guest bytes': 1, target: 1 });
    assert.deepEqual(presenter.presented().history.map(record=>record.label),
        ['desktop', 'guest bytes', 'target']);
});
