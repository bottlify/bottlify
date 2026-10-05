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
import {
    GAMMA_ENTRIES, GAMMA_WGSL, createPresenter, expandRow, gammaTable, isIdentityRamp,
} from './presenter.js';

/**
 * Guest memory is a flat buffer; surfaces are wherever the test puts them.
 *
 * @param {{ windowed?: boolean }} [options]  Whether the machine offers a window.
 */
function harness(options = {}){
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
    const reads = { copies: 0, windows: 0 };
    const presenter = createPresenter({
        backend: ()=>backend,
        readMemory: (address, length)=>{
            reads.copies++;
            return ram.slice(address, address + length);
        },
        windowMemory: options.windowed
            ? (address, length)=>{
                reads.windows++;
                return ram.subarray(address, address + length);
            }
            : undefined,
        schedule: flush=>scheduled.push(flush),
    });
    return {
        reads,
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
        presents: 3, uploads: 1, bytes: 64, shownByOwner: 0, shown: 0, gammaShown: 0,
        dropped: 0, shownBy: {}, lastBuffer: 0x1000, pending: false, claimed: 0,
        attached: 0, gamma: false, failures: [], disposed: false,
        // No queue was handed over, so nothing is counted against the bound.
        latency: { limit: 3, counting: false, inFlight: 0, peak: 0, frames: 0, held: 0,
            heldMs: 0, waiting: 0 },
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
            const view = presenter.attach({
                backend: ()=>backend,
                readMemory: (address, length)=>ram.slice(address, address + length),
            });
            return { backend, view };
        };

        ram.set([0x56, 0x34, 0x12, 0xff], 0x100);
        const first = presentFrom();
        first.view.present({ buffer: 0x100, width: 1, height: 1, pitch: 4, bitCount: 32,
            palette: null });
        presenter.flush();
        assert.equal(gpu.count('configure'), 1, 'the first frame configured the canvas');
        assert.equal(presenter.diagnostics().presents, 1);
        assert.equal(presenter.diagnostics().shown, 1);

        // The replacement: the old backend's resources go, the presenter stays.
        first.view.detach();
        first.backend.dispose();
        ram.set([0x11, 0x22, 0x33, 0xff], 0x200);
        const second = presentFrom();
        second.view.present({ buffer: 0x200, width: 1, height: 1, pitch: 4, bitCount: 32,
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

test('a machine that goes takes its pending frame and its claims with it', ()=>{
    // A child started beside its parent attaches on top of it and goes while
    // the parent stands. The parent then presents from its own address space,
    // through its own backend, and an address the child's GPU owned is guest
    // bytes to the parent; a frame the child presented and that was not shown
    // yet is dropped, since the address space it named has gone.
    const gpu = createFakeDevice();
    const presenter = createPresenter({
        device: gpu.device, queue: gpu.queue, screen: gpu.screen, canvas: gpu.canvas,
        now: ()=>0,
    });
    /** @param {Uint8Array} ram */
    const machine = ram=>{
        const reached = { backend: 0 };
        const backend = createBackend({
            device: gpu.device, queue: gpu.queue,
            presentTo: frame=>presenter.show(frame), now: ()=>0,
        });
        const view = presenter.attach({
            backend: ()=>{
                reached.backend++;
                return backend;
            },
            readMemory: (address, length)=>ram.slice(address, address + length),
        });
        return { view, reached };
    };
    const parentRam = new Uint8Array(0x1000);
    parentRam.set([0x56, 0x34, 0x12, 0xff], 0x100);
    const childRam = new Uint8Array(0x1000);
    childRam.set([0x11, 0x22, 0x33, 0xff], 0x100);
    const pixel = { buffer: 0x100, width: 1, height: 1, pitch: 4, bitCount: 32, palette: null };

    const parent = machine(parentRam);
    const child = machine(childRam);
    assert.equal(presenter.diagnostics().attached, 2);
    let ownerShown = 0;
    child.view.claim(0x100, ()=>{
        ownerShown++;
    });
    assert.equal(parent.view.isClaimed(0x100), false, 'a claim is the claiming machine\'s');
    child.view.present(pixel);
    child.view.detach();
    presenter.flush();
    assert.equal(child.reached.backend, 0, 'the gone machine\'s backend was not reached');
    assert.equal(gpu.count('writeTexture'), 0, 'nor its address space read');
    assert.equal(presenter.diagnostics().dropped, 1);
    assert.equal(presenter.diagnostics().attached, 1);
    assert.equal(presenter.diagnostics().claimed, 0, 'its claims went with it');

    parent.view.present(pixel);
    presenter.flush();
    assert.equal(ownerShown, 0);
    assert.equal(parent.reached.backend, 1);
    assert.deepEqual([...gpu.of('writeTexture').at(-1).bytes], [0x56, 0x34, 0x12, 0xff]);
    assert.equal(presenter.diagnostics().shown, 1);
});

test('a flip\'s frame is the burst it is in: on the queue once that burst is flushed',
    async()=>{
        // A DirectDraw flip counts a frame against the bound, and the frame is
        // what the presenter makes of the burst -- guest bytes uploaded at the
        // flush, or a Direct3D 7 target's replay, which reaches the queue when
        // the promise its owner answers with settles.
        const h = harness();
        const surface = { buffer: 0x1000, width: 4, height: 4, pitch: 16, bitCount: 32,
            palette: null };
        assert.equal(h.presenter.flushed(), null, 'nothing pending, nothing to wait for');
        h.presenter.present(surface);
        const burst = h.presenter.flushed();
        assert.ok(burst instanceof Promise);
        h.presenter.present(surface);
        assert.equal(h.presenter.flushed(), burst, 'every present of a burst is its one frame');
        let settled = false;
        burst.then(()=>{
            settled = true;
        });
        await Promise.resolve();
        assert.equal(settled, false, 'nothing is on the queue before the flush');
        h.settle();
        await burst;
        assert.equal(h.gpu.count('submit'), 1, 'settled with the upload submitted');

        /** @type {() => void} */
        let replayed = ()=>{};
        const replay = new Promise(resolve=>{
            replayed = ()=>resolve(undefined);
        });
        h.presenter.claim(0x2000, ()=>replay);
        h.presenter.present({ ...surface, buffer: 0x2000 });
        const owned = h.presenter.flushed();
        let ownedSettled = false;
        owned?.then(()=>{
            ownedSettled = true;
        });
        h.settle();
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(ownedSettled, false, 'an owner\'s frame is on the queue once its replay is');
        replayed();
        await owned;

        h.presenter.present(surface);
        const dropped = h.presenter.flushed();
        h.presenter.dispose();
        await dropped;
    });

test('every machine attached to one presenter counts against one bound', async()=>{
    // One queue under every machine of a run: a child started beside its
    // parent presents onto the queue its parent's frames are on.
    const gpu = createFakeDevice({ workDone: true });
    const presenter = createPresenter({
        device: gpu.device, queue: gpu.queue, screen: gpu.screen, canvas: gpu.canvas,
        now: ()=>0, maxFrameLatency: 2,
    });
    const reader = ()=>new Uint8Array(4);
    const parent = presenter.attach({ backend: ()=>null, readMemory: reader });
    const child = presenter.attach({ backend: ()=>null, readMemory: reader });
    gpu.queue.submit([]);
    assert.equal(parent.queued(), null);
    gpu.queue.submit([]);
    assert.equal(child.queued(), null);
    gpu.queue.submit([]);
    const held = parent.queued();
    assert.ok(held instanceof Promise, 'the parent\'s third frame waits on the child\'s too');
    assert.equal(presenter.diagnostics().latency.inFlight, 3);
    gpu.finish(1);
    await held;
    assert.equal(presenter.diagnostics().latency.held, 1);
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

// --- the gamma ramp, on the way to the canvas ---

/** @param {(index: number) => number} entry @returns {any} one ramp, the same on every channel */
const rampOf = entry=>{
    const channel = Uint16Array.from({ length: GAMMA_ENTRIES }, (_, index)=>entry(index));
    return { red: channel, green: channel.slice(), blue: channel.slice() };
};

/** A presenter over the recording device's canvas, and a backend presenting through it. */
function canvasHarness(){
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
    return {
        gpu, presenter, backend,
        /** Shows a one-pixel primary through the whole path. */
        show(){
            presenter.present({ buffer: 0x100, width: 1, height: 1, pitch: 4, bitCount: 32,
                palette: null });
            presenter.flush();
        },
    };
}

test('a ramp counts by the high byte of each entry, so both identities show values as they are',
    ()=>{
        assert.ok(isIdentityRamp(rampOf(index=>index * 257)), 'each index times 257');
        assert.ok(isIdentityRamp(rampOf(index=>index << 8)), 'each index shifted up by eight');
        assert.ok(!isIdentityRamp(rampOf(index=>(255 - index) * 257)));

        const table = gammaTable({ ...rampOf(index=>index * 257),
            green: Uint16Array.from({ length: GAMMA_ENTRIES }, (_, index)=>(255 - index) << 8) });
        assert.equal(table.length, GAMMA_ENTRIES * 4, 'four floats a row: a uniform array stride');
        assert.deepEqual([...table.subarray(0, 4)], [0, 1, 0, 0]);
        assert.deepEqual([...table.subarray(255 * 4, 256 * 4)], [1, 0, 1, 0]);
        assert.equal(table[128 * 4], Math.fround(128 / 255));
    });

test('recorded: with a ramp in effect a frame is drawn onto the canvas through it', ()=>{
    const h = canvasHarness();
    h.show();
    assert.equal(h.gpu.count('copyTextureToTexture'), 1, 'no ramp: the frame is copied');
    assert.equal(h.presenter.diagnostics().gamma, false);

    const inverted = rampOf(index=>(255 - index) * 257);
    h.presenter.setGammaRamp('program', inverted);
    h.gpu.reset();
    h.show();

    assert.equal(h.gpu.count('copyTextureToTexture'), 0, 'not copied');
    const [module] = h.gpu.of('createShaderModule');
    assert.equal(module.descriptor.code, GAMMA_WGSL);
    const [pipeline] = h.gpu.of('createRenderPipeline');
    assert.deepEqual(pipeline.descriptor.fragment.targets, [{ format: 'bgra8unorm' }],
        'the canvas is drawn in the frame\'s own format');
    const pass = h.gpu.of('beginRenderPass').find(call=>call.descriptor.label === 'present-gamma');
    assert.ok(pass, 'a pass onto the canvas');
    assert.equal(pass.descriptor.colorAttachments[0].view.texture,
        h.gpu.screen.getCurrentTexture());
    const draws = h.gpu.of('draw').filter(call=>call.pass === pass.pass);
    assert.deepEqual(draws.map(call=>call.args), [[3]], 'one triangle over the canvas');
    const [written] = h.gpu.of('writeBuffer').filter(call=>call.buffer.descriptor.label
        === 'present-gamma');
    assert.deepEqual([...new Float32Array(written.bytes.buffer)], [...gammaTable(inverted)],
        'the table is the ramp');
    assert.equal(h.presenter.diagnostics().gammaShown, 1);

    h.gpu.reset();
    h.show();
    assert.equal(h.gpu.of('writeBuffer').filter(call=>call.buffer.descriptor.label
        === 'present-gamma').length, 0, 'an unchanged ramp is not written again');
    assert.equal(h.gpu.count('createRenderPipeline'), 0, 'nor is the pass built again');
});

test('the latest ramp set is in effect, and taking it back shows the one before', ()=>{
    const h = canvasHarness();
    const dim = rampOf(index=>(index >> 1) * 257);
    const inverted = rampOf(index=>(255 - index) * 257);
    h.presenter.setGammaRamp('display', dim);
    h.presenter.setGammaRamp('device', inverted);
    assert.deepEqual([...(h.presenter.gammaRamp()?.red ?? [])], [...inverted.red]);
    h.presenter.setGammaRamp('device', null);
    assert.deepEqual([...(h.presenter.gammaRamp()?.red ?? [])], [...dim.red],
        'a device that goes gives the display back its ramp');
    h.show();
    const [written] = h.gpu.of('writeBuffer').filter(call=>call.buffer.descriptor.label
        === 'present-gamma');
    assert.deepEqual([...new Float32Array(written.bytes.buffer)], [...gammaTable(dim)]);

    h.presenter.setGammaRamp('display', rampOf(index=>index * 257));
    h.gpu.reset();
    h.show();
    assert.equal(h.gpu.count('copyTextureToTexture'), 1, 'the identity is copied, not drawn');
    h.presenter.setGammaRamp('display', null);
    assert.equal(h.presenter.gammaRamp(), null);
});

test('a frame the pass cannot read is copied as it is', ()=>{
    const h = canvasHarness();
    h.presenter.setGammaRamp('program', rampOf(index=>(255 - index) * 257));
    const target = h.backend.createSurface({ width: 1, height: 1, format: 'bgra8unorm',
        label: 'target', usage: h.backend.TextureUsage.RENDER_ATTACHMENT
            | h.backend.TextureUsage.COPY_SRC });
    const frame = h.backend.beginFrame();
    frame.present(target);
    frame.end();
    assert.equal(h.gpu.count('copyTextureToTexture'), 1);
    assert.equal(h.presenter.diagnostics().gammaShown, 0);
});

test('without a canvas no ramp reaches the picture, and the presenter says so', ()=>{
    const h = harness();
    assert.equal(h.presenter.appliesGamma(), false);
    assert.equal(canvasHarness().presenter.appliesGamma(), true);
});

test('byte-exact: a surface read through a window is the picture its rows copied give', ()=>{
    // One window over the rows in place of a copy of each: the padding past
    // each row is still no part of the picture, whatever the depth.
    /** @type {[number, number[] | null][]} */
    const depths = [[32, null], [16, null], [8, Array.from({ length: 256 }, (_, i)=>i * 0x010203)]];
    for (const [bitCount, palette] of depths)
    {
        const copied = harness();
        const windowed = harness({ windowed: true });
        const width = 5;
        const height = 3;
        const pitch = width * (bitCount >>> 3) + 6;
        for (const h of [copied, windowed])
        {
            for (let at = 0; at < pitch * height; at++)
            {
                h.ram[0x2000 + at] = (at * 37 + 11) & 0xff;
            }
            h.presenter.present({ buffer: 0x2000, width, height, pitch, bitCount, palette });
            h.settle();
        }
        assert.deepEqual([...windowed.uploaded()], [...copied.uploaded()], `${bitCount} bits`);
        assert.equal(windowed.reads.copies, 0, 'no row was copied');
        assert.equal(windowed.reads.windows, 1, 'one window for the surface');
        assert.equal(copied.reads.copies, height);
    }
});

test('a row expanded a word at a time is the row expanded a byte at a time, at every depth', ()=>{
    // A row that starts off its pixel's alignment is expanded a byte at a
    // time; the same bytes where they align, a word at a time.
    let seed = 3;
    const random = ()=>{
        seed = (seed * 1103515245 + 12345) >>> 0;
        return (seed >>> 16) & 0xff;
    };
    const palette = Array.from({ length: 256 }, ()=>(random() << 16) | (random() << 8) | random());
    for (const bitCount of [8, 16, 32])
    {
        const width = 37;
        const bytes = Uint8Array.from({ length: width * 4 + 8 }, random);
        const aligned = new Uint8Array(width * 4);
        const unaligned = new Uint8Array(width * 4 + 1);
        expandRow(bytes, width, bitCount, palette, aligned, 4, 0);
        const shifted = new Uint8Array(bytes.length + 1);
        shifted.set(bytes, 1);
        expandRow(shifted, width, bitCount, palette, unaligned, 5, 1);
        assert.deepEqual([...aligned], [...unaligned.subarray(1)], `${bitCount} bits`);
        expandRow(bytes, width, bitCount, null, aligned, 4, 0);
        expandRow(shifted, width, bitCount, null, unaligned, 5, 1);
        assert.deepEqual([...aligned], [...unaligned.subarray(1)], `${bitCount} bits, no palette`);
    }
    palette[7] = 0x123456;
    const row = Uint8Array.of(7, 7, 7, 7);
    const out = new Uint8Array(16);
    expandRow(row, 4, 8, palette, out);
    assert.deepEqual([...out.subarray(0, 4)], [0x12, 0x34, 0x56, 0xff],
        'a palette changed in place is read as it is now');
});

/**
 * A process with no GPU of its own -- one in a worker of its own -- sends the
 * bytes a present would upload, for the thread that has the GPU to show. Two
 * paths to one picture: seeded surfaces of every depth, pitch and palette go
 * down both, and what each hands on must be the same bytes at the same size.
 */
test('gate: the bytes a presenter sends are the bytes it would upload, for every surface', ()=>{
    let seed = 0x5eed;
    const next = ()=>{
        seed = (seed * 1103515245 + 12345) >>> 0;
        return seed >>> 8;
    };
    for (let round = 0; round < 200; round++)
    {
        const windowed = round % 2 === 0;
        const h = harness({ windowed });
        for (let at = 0; at < h.ram.length; at++)
        {
            h.ram[at] = next() & 0xff;
        }
        /** @type {any[]} */
        const sent = [];
        /** @type {(() => void)[]} */
        const scheduled = [];
        const sending = createPresenter({
            readMemory: (address, length)=>h.ram.slice(address, address + length),
            windowMemory: windowed
                ? (address, length)=>h.ram.subarray(address, address + length) : undefined,
            schedule: flush=>scheduled.push(flush),
            sendFrame: frame=>sent.push(frame),
        });
        const bitCount = [8, 16, 32][next() % 3];
        const width = 1 + next() % 40;
        const height = 1 + next() % 20;
        const pitch = width * (bitCount >>> 3) + next() % 9;
        const palette = bitCount === 8 ? Array.from({ length: 256 }, ()=>next()) : null;
        const surface = { buffer: 0x400 + next() % 0x400, width, height, pitch, bitCount,
            palette };
        h.presenter.present(surface);
        h.settle();
        sending.present(surface);
        scheduled.splice(0).forEach(flush=>flush());
        const detail = JSON.stringify({ round, bitCount, width, height, pitch, windowed });
        assert.equal(sent.length, 1, detail);
        const [frame] = sent;
        assert.deepEqual([frame.width, frame.height, frame.bytesPerRow, frame.format],
            [width, height, width * 4, 'bgra8unorm'], detail);
        assert.deepEqual(frame.pixels, h.uploaded(), detail);
        assert.equal(sending.diagnostics().uploads, 1, 'counted as the upload it stands for');
    }
});

test('a sending presenter hands each frame its own bytes, which the receiver may take', ()=>{
    /** @type {any[]} */
    const sent = [];
    /** @type {(() => void)[]} */
    const scheduled = [];
    const ram = new Uint8Array(64);
    const presenter = createPresenter({
        readMemory: (address, length)=>ram.slice(address, address + length),
        schedule: flush=>scheduled.push(flush),
        sendFrame: frame=>sent.push(frame),
    });
    const surface = { buffer: 0, width: 2, height: 2, pitch: 8, bitCount: 32, palette: null };
    presenter.present(surface);
    scheduled.splice(0).forEach(flush=>flush());
    ram[0] = 0x7f;
    presenter.present(surface);
    scheduled.splice(0).forEach(flush=>flush());
    assert.equal(sent.length, 2);
    assert.notEqual(sent[0].pixels.buffer, sent[1].pixels.buffer,
        'a buffer handed over is never written again');
    assert.deepEqual([sent[0].pixels[0], sent[1].pixels[0]], [0, 0x7f]);
});
