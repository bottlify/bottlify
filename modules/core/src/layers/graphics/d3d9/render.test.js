/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a Direct3D 9 device puts on the queue, evaluated on the processor.
 *
 * These are the byte-exact kind: the frame is not looked at, it is recomputed
 * from the commands the device recorded and the bytes the backend actually sent
 * -- with the software reference in `webgpu/internal/reference.js` -- and
 * compared value for value. No tolerance, ever. What that proves is the
 * formula and the plumbing up to the queue: the channel order, the viewport
 * mapping, and that the bytes a program wrote through a lock are the bytes a
 * draw reads.
 *
 * Coverage is the one thing not asserted wholesale. A cleared frame is compared
 * as a whole image because every pixel of it is decided. A triangle is not: its
 * edge pixels are decided by a rasterisation rule this engine does not own, and
 * a stored image of one would freeze whatever rule the evaluator here happens
 * to use. So the triangle is asserted at named pixels, chosen so that no edge
 * passes through the centre of any of them and every rule agrees.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D3DFMT, D3DPOOL, D3DRS, D3DSWAPEFFECT, D3DUSAGE, D3D_OK } from './constants.js';
import { D3DCLEAR, D3DPT } from '../d3d8/constants.js';
import { createDirect3D9 } from './device.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { FVF } from '../webgpu/internal/vertexformat.js';
import { UNIFORM_AT } from '../d3d8/render.js';
import { D3DDECLTYPE, D3DDECLUSAGE } from './declaration.js';
import {
    blendPixel, clear as referenceClear, createReferenceSurface, toBase64,
} from '../webgpu/internal/reference.js';

/** Where the harness's allocator hands storage out from, backed by real bytes. */
const RAM_BASE = 0x40000000;
const RAM_SIZE = 8 << 20;

/** x, y, z, rhw and a packed colour. */
const FVF_TRIANGLE = FVF.XYZRHW | FVF.DIFFUSE;
const TRIANGLE_STRIDE = 20;

/** @param {number} r @param {number} g @param {number} b @param {number} [a] */
const argb = (r, g, b, a = 255)=>((a << 24) | (r << 16) | (g << 8) | b) >>> 0;

/**
 * A device over the recording GPU, with guest memory it can read and an
 * allocator that hands out addresses inside it.
 *
 * The allocator is the point of the arrangement: a lock hands the program the
 * address it returns, and the unlock reads those bytes back through
 * `readMemory`. An address invented for the purpose would read back as zeroes
 * with nothing reporting a failure.
 *
 * @param {{ width?: number, height?: number, depth?: boolean }} [options]
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
    const ram = new Uint8Array(RAM_SIZE);
    let next = RAM_BASE;
    const d3d = createDirect3D9({
        backend,
        readMemory: (address, length)=>ram.slice(address - RAM_BASE, address - RAM_BASE + length),
        createSampler: descriptor=>({ kind: 'sampler', descriptor }),
        allocate: bytes=>{
            const address = next;
            next += bytes + 0x100;
            return address;
        },
    });
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d.CreateDevice({
        swapEffect: D3DSWAPEFFECT.DISCARD,
        backBufferCount: 1,
        backBufferWidth: options.width ?? 4,
        backBufferHeight: options.height ?? 4,
        backBufferFormat: D3DFMT.X8R8G8B8,
        enableAutoDepthStencil: options.depth ?? true,
        autoDepthStencilFormat: D3DFMT.D24S8,
    }, out), D3D_OK);

    return {
        gpu,
        presented,
        device: out.device,
        /** Whether an address is one this harness's allocator handed out. */
        isGuestMemory: (/** @type {number} */ address)=>
            address >= RAM_BASE && address < RAM_BASE + RAM_SIZE,
        /** @param {number} address @param {Uint8Array} bytes */
        write(address, bytes){
            ram.set(bytes, address - RAM_BASE);
        },
        /** Draws the frame and waits for it to reach the queue. */
        async present(){
            assert.equal(out.device.Present(), D3D_OK);
            await out.device.idle();
        },
    };
}

/**
 * One pre-transformed vertex, as the guest lays it out.
 *
 * @param {number} x @param {number} y @param {number} color
 */
function vertex(x, y, color){
    const bytes = new DataView(new ArrayBuffer(TRIANGLE_STRIDE));
    bytes.setFloat32(0, x, true);
    bytes.setFloat32(4, y, true);
    bytes.setFloat32(8, 0.5, true);
    bytes.setFloat32(12, 1, true);
    bytes.setUint32(16, color >>> 0, true);
    return new Uint8Array(bytes.buffer);
}

/**
 * The bytes the queue received for a range of a buffer: the last write that
 * covered it.
 *
 * @param {any} gpu @param {{ gpu: any, offset: number }} at @param {number} length
 */
function queuedBytes(gpu, at, length){
    const writes = gpu.of('writeBuffer').filter((/** @type {any} */ call)=>
        call.buffer === at.gpu && call.bufferOffset <= at.offset
            && call.bufferOffset + call.size >= at.offset + length);
    assert.ok(writes.length > 0, 'the vertices this draw reads reached the queue');
    const write = writes[writes.length - 1];
    const from = at.offset - write.bufferOffset;
    return write.bytes.subarray(from, from + length);
}

/** @param {any} surface @param {number} x @param {number} y */
const pixelAt = (surface, x, y)=>
    [...surface.bytes.subarray((y * surface.width + x) * 4, (y * surface.width + x) * 4 + 4)];

/**
 * The three positions and the colour a draw actually sent, read back out of the
 * queue rather than out of what the test wrote.
 *
 * @param {ReturnType<typeof harness>} h @param {any} command
 */
function queuedTriangle(h, command){
    // Through the first vertex, not from it: the draw names its start as an
    // index into the buffer, which is where an offset stream ends up.
    const bytes = queuedBytes(
        h.gpu, command.vertices, (command.first + command.count) * TRIANGLE_STRIDE);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const points = [];
    for (let index = 0; index < command.count; index++)
    {
        const at = (command.first + index) * TRIANGLE_STRIDE;
        points.push({
            x: view.getFloat32(at, true),
            y: view.getFloat32(at + 4, true),
            colour: view.getUint32(at + 16, true),
        });
    }
    return points;
}

/**
 * Fills the pixels whose centre is inside a triangle.
 *
 * The rule is the same half-space test on all three edges, taken in whichever
 * winding the triangle has, and strict -- so a centre exactly on an edge is
 * outside. Which way that boundary case falls is a rasteriser's own business;
 * the tests here only assert pixels no edge passes through.
 *
 * @param {any} surface
 * @param {{ x: number, y: number }[]} points
 * @param {{ r: number, g: number, b: number, a: number }} colour
 */
function fillTriangle(surface, points, colour){
    const [a, b, c] = points;
    /** @param {any} p @param {any} q @param {number} x @param {number} y */
    const edge = (p, q, x, y)=>((q.x - p.x) * (y - p.y)) - ((q.y - p.y) * (x - p.x));
    const winding = Math.sign(edge(a, b, c.x, c.y));
    for (let y = 0; y < surface.height; y++)
    {
        for (let x = 0; x < surface.width; x++)
        {
            const cx = x + 0.5;
            const cy = y + 0.5;
            const inside = [[a, b], [b, c], [c, a]].every(([p, q])=>
                Math.sign(edge(p, q, cx, cy)) === winding);
            if (inside)
            {
                blendPixel(surface, x, y, colour);
            }
        }
    }
}

/**
 * The software evaluation of the last frame the device replayed: the clear from
 * the pass, and every triangle from the vertices that reached the queue.
 *
 * @param {ReturnType<typeof harness>} h @param {number} width @param {number} height
 */
function rasterise(h, width, height){
    const surface = createReferenceSurface(width, height);
    for (const command of h.device.diagnostics().lastFrame)
    {
        if (command.kind === 'pass' && command.clearColor)
        {
            const c = command.clearColor;
            referenceClear(surface, {
                r: Math.round(c.r * 255), g: Math.round(c.g * 255), b: Math.round(c.b * 255),
            });
            continue;
        }
        if (command.kind !== 'draw')
        {
            continue;
        }
        assert.equal(command.state.fvf, FVF_TRIANGLE, 'the evaluator knows one format');
        assert.equal(command.count % 3, 0, 'and triangles only');
        const points = queuedTriangle(h, command);
        for (let first = 0; first < points.length; first += 3)
        {
            const colour = points[first].colour;
            assert.ok(points.slice(first, first + 3).every(point=>point.colour === colour),
                'one colour across the triangle: the evaluator interpolates nothing');
            fillTriangle(surface, points.slice(first, first + 3), {
                r: (colour >>> 16) & 0xff,
                g: (colour >>> 8) & 0xff,
                b: colour & 0xff,
                a: (colour >>> 24) & 0xff,
            });
        }
    }
    return surface;
}

test('byte-exact: a cleared frame is that colour in every pixel, blue byte first', async()=>{
    const h = harness();

    // Channels all different, because a channel swap is invisible in grey.
    assert.equal(h.device.Clear(0, null, D3DCLEAR.TARGET, argb(0x12, 0x34, 0x56), 1, 0), D3D_OK);
    await h.present();

    const surface = rasterise(h, 4, 4);
    // BGRX: the byte at the lowest address is blue. A D3DCOLOR is 0xaarrggbb
    // and a pixel is 0x00rrggbb, so the clear colour lands as 56 34 12.
    assert.deepEqual(pixelAt(surface, 0, 0), [0x56, 0x34, 0x12, 0xff]);
    assert.deepEqual(pixelAt(surface, 3, 3), [0x56, 0x34, 0x12, 0xff]);
    assert.equal(toBase64(surface),
        'VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/w==',
        'the whole image, every pixel of which the clear decides');
});

test('Clear with a count of zero clears nothing, and with no array clears the whole', ()=>{
    // Wine's d3d9 visual tests: Clear(0, rects) and Clear(1, NULL) both
    // succeed; the first leaves the target alone, the second clears all of it.
    const h = harness();
    const everything = [{ x1: 0, y1: 0, x2: 4, y2: 4 }];
    assert.equal(h.device.Clear(0, everything, D3DCLEAR.TARGET, argb(255, 0, 0), 0, 0), D3D_OK);
    assert.equal(h.device.diagnostics().clears, 0);
    assert.equal(h.device.Clear(1, null, D3DCLEAR.TARGET, argb(0, 255, 0), 0, 0), D3D_OK);
    assert.equal(h.device.diagnostics().clears, 1);
});

test('byte-exact: a triangle from a locked vertex buffer covers the pixels it names',
    async()=>{
        const h = harness({ width: 8, height: 8 });
        const { device } = h;
        /** @type {{ buffer?: any }} */
        const created = {};
        assert.equal(device.CreateVertexBuffer(3 * TRIANGLE_STRIDE, D3DUSAGE.WRITEONLY,
            FVF_TRIANGLE, D3DPOOL.DEFAULT, created), D3D_OK);

        // The program's own bytes, written through the address the lock reports.
        /** @type {{ pBits?: number }} */
        const locked = {};
        assert.equal(created.buffer.Lock(0, 0, locked, 0), D3D_OK);
        const at = /** @type {number} */ (locked.pBits);
        assert.ok(h.isGuestMemory(at), 'a lock reports memory the guest can write through');
        // A right triangle whose third edge is x + 2y = 9: no pixel centre,
        // which is always at a half-integer, can satisfy that.
        const corners = [[1, 1], [7, 1], [1, 4]];
        corners.forEach(([x, y], index)=>
            h.write(at + index * TRIANGLE_STRIDE, vertex(x, y, argb(0, 0, 255))));
        assert.equal(created.buffer.Unlock(), D3D_OK);

        assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, argb(0x12, 0x34, 0x56), 1, 0), D3D_OK);
        assert.equal(device.SetStreamSource(0, created.buffer, 0, TRIANGLE_STRIDE), D3D_OK);
        assert.equal(device.SetFVF(FVF_TRIANGLE), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();

        const draws = h.device.diagnostics().lastFrame.filter(
            (/** @type {any} */ command)=>command.kind === 'draw');
        assert.equal(draws.length, 1);
        assert.deepEqual(queuedTriangle(h, draws[0]).map(point=>[point.x, point.y]), corners,
            'the vertices the program wrote through the lock are the ones the queue got');

        const surface = rasterise(h, 8, 8);
        assert.deepEqual(pixelAt(surface, 1, 1), [0xff, 0, 0, 0xff], 'the corner is covered');
        assert.deepEqual(pixelAt(surface, 5, 1), [0xff, 0, 0, 0xff], 'and the far end of the leg');
        assert.deepEqual(pixelAt(surface, 1, 3), [0xff, 0, 0, 0xff], 'and of the other');
        assert.deepEqual(pixelAt(surface, 6, 1), [0x56, 0x34, 0x12, 0xff],
            'past the sloped edge is the clear colour');
        assert.deepEqual(pixelAt(surface, 1, 4), [0x56, 0x34, 0x12, 0xff], 'and below it');
        assert.deepEqual(pixelAt(surface, 0, 1), [0x56, 0x34, 0x12, 0xff],
            'and left of the vertical edge');
    });

test('the frame record says what was cleared, what was drawn and where, and what is shown',
    async()=>{
        // The datum that decides a black or a frozen picture without a
        // screenshot: a frame that only cleared, or drew only into a target
        // that is not the one presented, reads as such in the history.
        const h = harness({ width: 8, height: 8 });
        const { device } = h;
        /** @type {{ buffer?: any }} */
        const created = {};
        assert.equal(device.CreateVertexBuffer(3 * TRIANGLE_STRIDE, D3DUSAGE.WRITEONLY,
            FVF_TRIANGLE, D3DPOOL.DEFAULT, created), D3D_OK);
        /** @type {{ pBits?: number }} */
        const locked = {};
        assert.equal(created.buffer.Lock(0, 0, locked, 0), D3D_OK);
        const at = /** @type {number} */ (locked.pBits);
        [[1, 1], [7, 1], [1, 4]].forEach(([x, y], index)=>
            h.write(at + index * TRIANGLE_STRIDE, vertex(x, y, argb(0, 0, 255))));
        assert.equal(created.buffer.Unlock(), D3D_OK);
        assert.equal(device.SetStreamSource(0, created.buffer, 0, TRIANGLE_STRIDE), D3D_OK);
        assert.equal(device.SetFVF(FVF_TRIANGLE), D3D_OK);

        // Frame 1: a clear of the back buffer and nothing drawn.
        assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, argb(0x12, 0x34, 0x56), 1, 0), D3D_OK);
        await h.present();

        // Frame 2: one draw into an offscreen target, then one into the back buffer.
        /** @type {{ surface?: any }} */
        const target = {};
        assert.equal(device.CreateRenderTarget(4, 4, D3DFMT.A8R8G8B8, false, target), D3D_OK);
        /** @type {{ surface?: any }} */
        const back = {};
        assert.equal(device.GetBackBuffer(0, 0, 0, back), D3D_OK);
        assert.equal(device.SetRenderTarget(0, target.surface), D3D_OK);
        assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, argb(1, 2, 3), 1, 0), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        assert.equal(device.SetRenderTarget(0, back.surface), D3D_OK);
        assert.equal(device.SetViewport({ X: 2, Y: 2, Width: 4, Height: 4, MinZ: 0, MaxZ: 1 }),
            D3D_OK);
        assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();

        const frames = h.device.diagnostics().recentFrames;
        assert.equal(frames.length, 2);
        const pick = (/** @type {any} */ frame)=>({
            draws: frame.draws, clears: frame.clears, clearColor: frame.clearColor,
            offscreenDraws: frame.offscreenDraws, offscreenTargets: frame.offscreenTargets,
            viewport: frame.viewport, target: frame.target,
        });
        assert.deepEqual(pick(frames[0]), {
            draws: 0, clears: 1, clearColor: '#ff123456', offscreenDraws: 0,
            offscreenTargets: 0, viewport: '0,0 8x8', target: '8x8',
        });
        assert.deepEqual(pick(frames[1]), {
            // The offscreen clear is counted but its colour is not the back buffer's.
            draws: 2, clears: 1, clearColor: '', offscreenDraws: 1, offscreenTargets: 1,
            viewport: '2,2 4x4', target: '8x8',
        });
        back.surface.release();
        target.surface.release();
    });

test('a stream bound at an offset draws from there, not from the start of the buffer',
    async()=>{
        const h = harness({ width: 8, height: 8 });
        const { device } = h;
        /** @type {{ buffer?: any }} */
        const created = {};
        assert.equal(device.CreateVertexBuffer(
            6 * TRIANGLE_STRIDE, 0, FVF_TRIANGLE, D3DPOOL.DEFAULT, created), D3D_OK);
        /** @type {{ pBits?: number }} */
        const locked = {};
        assert.equal(created.buffer.Lock(0, 0, locked, 0), D3D_OK);
        const at = /** @type {number} */ (locked.pBits);
        // Three vertices of one colour, then the three the draw must find.
        [[0, 0], [1, 0], [0, 1]].forEach(([x, y], index)=>
            h.write(at + index * TRIANGLE_STRIDE, vertex(x, y, argb(255, 0, 0))));
        const wanted = [[1, 1], [7, 1], [1, 4]];
        wanted.forEach(([x, y], index)=>
            h.write(at + (3 + index) * TRIANGLE_STRIDE, vertex(x, y, argb(0, 0, 255))));
        assert.equal(created.buffer.Unlock(), D3D_OK);

        assert.equal(device.SetStreamSource(
            0, created.buffer, 3 * TRIANGLE_STRIDE, TRIANGLE_STRIDE), D3D_OK);
        assert.equal(device.SetFVF(FVF_TRIANGLE), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();

        const draw = h.device.diagnostics().lastFrame.find(
            (/** @type {any} */ command)=>command.kind === 'draw');
        assert.deepEqual(queuedTriangle(h, draw).map(point=>[point.x, point.y]), wanted);
    });

test('a reset puts the viewport back over the whole target', ()=>{
    const h = harness({ width: 8, height: 8 });
    const { device } = h;
    /** @type {{ viewport?: any }} */
    const out = {};

    assert.equal(device.SetViewport({ X: 2, Y: 2, Width: 4, Height: 4, MinZ: 0, MaxZ: 1 }), D3D_OK);
    assert.equal(device.GetViewport(out), D3D_OK);
    assert.deepEqual([out.viewport.X, out.viewport.Width], [2, 4]);

    assert.equal(device.Reset(), D3D_OK);
    assert.equal(device.GetViewport(out), D3D_OK);
    assert.deepEqual(
        [out.viewport.X, out.viewport.Y, out.viewport.Width, out.viewport.Height], [0, 0, 8, 8],
        'a viewport left over from before the reset would misplace every vertex');
});

test('a reset gives the previous back buffer and depth back to the GPU', async()=>{
    // A program that resets its device a few times a second leaves a
    // screen-sized target and depth behind each time; the collector does not
    // watch the GPU's memory, so the renderer has to give them back itself.
    const h = harness({ width: 8, height: 8 });
    const { device } = h;
    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER, argb(1, 2, 3), 1, 0),
        D3D_OK);
    await h.present();
    const made = h.gpu.of('createTexture')
        .filter((/** @type {any} */ call)=>['target', 'depth'].includes(call.descriptor.label));
    assert.equal(made.length, 2, 'the frame made the back buffer and its depth');
    assert.equal(h.gpu.count('destroyTexture'), 0);

    // A frame recorded against the old target before the reset -- a program
    // clears, then resets on a message it pumps -- still draws into it: the
    // old pair is destroyed after that frame is presented, not before.
    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, argb(4, 5, 6), 1, 0), D3D_OK);
    assert.equal(device.Reset(), D3D_OK);
    await device.idle();
    assert.equal(h.gpu.count('destroyTexture'), 0, 'the frame in hand still holds them');
    assert.equal(device.Present(), D3D_OK);
    await device.idle();
    assert.deepEqual(h.gpu.of('destroyTexture').map((/** @type {any} */ call)=>call.texture),
        made.map((/** @type {any} */ call)=>call.texture),
        'both of the old ones are destroyed once that frame is submitted, and nothing else');

    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER, argb(1, 2, 3), 1, 0),
        D3D_OK);
    await h.present();
    assert.equal(h.gpu.of('createTexture')
        .filter((/** @type {any} */ call)=>['target', 'depth'].includes(call.descriptor.label))
        .length, 4, 'the new back buffer and depth are new textures');
});

test('a target smaller than the bound depth surface gets a depth of its own size', async()=>{
    // Direct3D binds a depth surface at least as large as the target and
    // uses its corner; WebGPU attaches equal sizes only, and a pass that
    // disagrees invalidates the whole frame. A quarter-size glow target
    // drawn with the screen's depth still bound is the ordinary case.
    const h = harness({ width: 8, height: 8 });
    const { device } = h;
    /** @type {{ surface?: any }} */
    const small = {};
    assert.equal(device.CreateRenderTarget(4, 4, D3DFMT.A8R8G8B8, false, small), D3D_OK);
    /** @type {{ surface?: any }} */
    const back = {};
    assert.equal(device.GetBackBuffer(0, 0, 0, back), D3D_OK);

    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER, argb(1, 2, 3), 1, 0),
        D3D_OK);
    assert.equal(device.SetRenderTarget(0, small.surface), D3D_OK);
    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER, argb(4, 5, 6), 1, 0),
        D3D_OK);
    assert.equal(device.SetRenderTarget(0, back.surface), D3D_OK);
    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER, argb(7, 8, 9), 1, 0),
        D3D_OK);
    await h.present();

    const passes = h.gpu.of('beginRenderPass').map((/** @type {any} */ call)=>call.descriptor);
    const depthOf = (/** @type {any} */ pass)=>pass.depthStencilAttachment.view.texture.descriptor;
    const colourOf = (/** @type {any} */ pass)=>pass.colorAttachments[0].view.texture.descriptor;
    assert.equal(passes.length, 3);
    assert.deepEqual(passes.map(pass=>[colourOf(pass).size.width, depthOf(pass).size.width]),
        [[8, 8], [4, 4], [8, 8]], 'each pass has a depth the size of its target');
    assert.equal(depthOf(passes[1]).label, 'depth-stand-in');
    assert.equal(depthOf(passes[0]).label, 'depth');
    assert.equal(depthOf(passes[2]), depthOf(passes[0]), 'the bound depth surface, when it fits');

    // The stand-in is kept, not remade per pass.
    assert.equal(device.SetRenderTarget(0, small.surface), D3D_OK);
    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, argb(4, 5, 6), 1, 0), D3D_OK);
    await h.present();
    assert.equal(h.gpu.of('createTexture')
        .filter((/** @type {any} */ call)=>call.descriptor.label === 'depth-stand-in').length, 1);

    assert.equal(device.SetRenderTarget(0, back.surface), D3D_OK);
    back.surface.release();
    small.surface.release();
});

test('a viewport wider than its target is refused', ()=>{
    const h = harness({ width: 8, height: 8 });

    assert.notEqual(
        h.device.SetViewport({ X: 4, Y: 0, Width: 8, Height: 8, MinZ: 0, MaxZ: 1 }), D3D_OK);
    assert.notEqual(
        h.device.SetViewport({ X: 0, Y: 0, Width: 0, Height: 8, MinZ: 0, MaxZ: 1 }), D3D_OK);
});

test('a stream whose offset straddles the stride is refused rather than drawn wrong', ()=>{
    const h = harness();
    const { device } = h;
    /** @type {{ buffer?: any }} */
    const created = {};
    assert.equal(device.CreateVertexBuffer(
        6 * TRIANGLE_STRIDE, 0, FVF_TRIANGLE, D3DPOOL.DEFAULT, created), D3D_OK);
    assert.equal(device.SetStreamSource(0, created.buffer, 4, TRIANGLE_STRIDE), D3D_OK);
    assert.equal(device.SetFVF(FVF_TRIANGLE), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);

    assert.notEqual(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
});

test('a device with no backend answers every drawing call and records nothing', async()=>{
    const d3d = createDirect3D9({});
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d.CreateDevice({
        swapEffect: D3DSWAPEFFECT.DISCARD,
        backBufferWidth: 8,
        backBufferHeight: 8,
        enableAutoDepthStencil: true,
    }, out), D3D_OK);
    const device = out.device;

    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, argb(1, 2, 3), 1, 0), D3D_OK);
    assert.equal(device.SetFVF(FVF_TRIANGLE), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(
        D3DPT.TRIANGLELIST, 1,
        new Uint8Array(3 * TRIANGLE_STRIDE), TRIANGLE_STRIDE), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    assert.equal(device.Present(), D3D_OK);

    assert.equal(device.diagnostics(), null, 'there is no renderer to report on');
    await device.idle();
});

test('a draw needs a scene, a position in its format, and a bound stream', ()=>{
    const h = harness();
    const { device } = h;
    /** @type {{ buffer?: any }} */
    const created = {};
    assert.equal(device.CreateVertexBuffer(
        3 * TRIANGLE_STRIDE, 0, FVF_TRIANGLE, D3DPOOL.DEFAULT, created), D3D_OK);

    assert.equal(device.SetFVF(FVF_TRIANGLE), D3D_OK);
    assert.equal(device.SetStreamSource(0, created.buffer, 0, TRIANGLE_STRIDE), D3D_OK);
    assert.notEqual(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK,
        'outside a scene');

    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetFVF(FVF.DIFFUSE), D3D_OK);
    assert.notEqual(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK,
        'a format with no position is not a format');

    assert.equal(device.SetFVF(FVF_TRIANGLE), D3D_OK);
    assert.equal(device.SetStreamSource(0, null, 0, 0), D3D_OK);
    assert.notEqual(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK,
        'and nothing is bound to read vertices from');
});

test('a lock reports guest memory, and a second lock of the same buffer is refused', ()=>{
    const h = harness();
    /** @type {{ buffer?: any }} */
    const created = {};
    assert.equal(
        h.device.CreateVertexBuffer(256, 0, FVF_TRIANGLE, D3DPOOL.DEFAULT, created), D3D_OK);
    /** @type {{ pBits?: number }} */
    const first = {};
    /** @type {{ pBits?: number }} */
    const second = {};

    assert.equal(created.buffer.Lock(64, 0, first, 0), D3D_OK);
    assert.ok(h.isGuestMemory(/** @type {number} */ (first.pBits)));
    assert.equal(created.buffer.Lock(0, 16, second, 0), 0x8876086c);
    assert.equal(second.pBits, undefined, 'a failed lock leaves the caller its own pointer');

    assert.equal(created.buffer.Unlock(), D3D_OK);
    assert.equal(created.buffer.Unlock(), 0x8876086c, 'and a second unlock owes nothing');
    assert.equal(created.buffer.Lock(0, 16, second, 0), D3D_OK);
    assert.equal(second.pBits, /** @type {number} */ (first.pBits) - 64,
        'the range a lock reports is measured from the buffer, not from the last lock');
});

/** A triangle's three vertices, packed, for a DrawPrimitiveUP. */
const triangleUP = ()=>{
    const bytes = new Uint8Array(3 * TRIANGLE_STRIDE);
    [[0, 0], [4, 0], [0, 4]].forEach(([x, y], index)=>
        bytes.set(vertex(x, y, argb(255, 0, 0)), index * TRIANGLE_STRIDE));
    return bytes;
};

test('draws that change no state are prepared once, and a value set again is no change', async()=>{
    // Recorded commands. The device publishes its state version, so a run of
    // draws of one state reuses the preparation, and a program setting the
    // value already there -- which programs do constantly -- does not end it.
    const h = harness();
    const { device } = h;
    const geometry = triangleUP();
    assert.equal(device.SetFVF(FVF_TRIANGLE), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    for (let index = 0; index < 20; index++)
    {
        assert.equal(device.SetRenderState(D3DRS.ALPHAREF, 0), D3D_OK);
        assert.equal(device.SetTexture(0, null), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, geometry, TRIANGLE_STRIDE),
            D3D_OK);
    }
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();
    assert.deepEqual(device.diagnostics().prepared, { built: 1, reused: 19 });
});

test('a state block applied between two draws is a new preparation for the second', async()=>{
    // Recorded commands. Apply writes the device's state behind the setters'
    // backs, so it has to raise the version itself, or the second draw is
    // served the first one's preparation.
    const h = harness();
    const { device } = h;
    const geometry = triangleUP();
    assert.equal(device.BeginStateBlock(), D3D_OK);
    assert.equal(device.SetRenderState(D3DRS.ALPHAREF, 5), D3D_OK);
    /** @type {{ block?: any }} */
    const recorded = {};
    assert.equal(device.EndStateBlock(recorded), D3D_OK);
    assert.equal(device.SetFVF(FVF_TRIANGLE), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, geometry, TRIANGLE_STRIDE), D3D_OK);
    assert.equal(recorded.block.Apply(), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, geometry, TRIANGLE_STRIDE), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();
    assert.equal(device.diagnostics().prepared.built, 2);
    const refs = device.diagnostics().lastFrame
        .filter((/** @type {any} */ command)=>command.kind === 'draw')
        .map((/** @type {any} */ command)=>Math.round(command.uniforms[UNIFORM_AT.alphaRef] * 255));
    assert.deepEqual(refs, [0, 5]);
});

/**
 * A declaration of a colour before a pre-transformed position: legal, and no
 * vertex format spells it, since a format puts the position first.
 *
 * @param {any} device @param {number} [colourStream]
 */
function colourFirstDeclaration(device, colourStream = 0){
    /** @type {{ declaration?: any }} */
    const made = {};
    assert.equal(device.CreateVertexDeclaration([
        { Stream: colourStream, Offset: 0, Type: D3DDECLTYPE.D3DCOLOR, Method: 0,
            Usage: D3DDECLUSAGE.COLOR, UsageIndex: 0 },
        { Stream: 0, Offset: 4, Type: D3DDECLTYPE.FLOAT4, Method: 0,
            Usage: D3DDECLUSAGE.POSITIONT, UsageIndex: 0 },
    ], made), D3D_OK);
    assert.equal(device.SetVertexDeclaration(made.declaration), D3D_OK);
}

test('a fixed-function draw reads a declaration no format spells at its offsets', async()=>{
    // Direct3D's fixed-function pipeline reads any declaration of the members
    // it knows. The colour is at offset 0 and the position at 4 here, where a
    // format would put them the other way round; the pipeline has to read
    // them where the declaration says.
    const h = harness({ width: 8, height: 8 });
    const { device } = h;
    colourFirstDeclaration(device);
    const bytes = new DataView(new ArrayBuffer(60));
    [[1, 1], [7, 1], [1, 4]].forEach(([x, y], index)=>{
        bytes.setUint32(index * 20, argb(0, 0, 255), true);
        bytes.setFloat32(index * 20 + 4, x, true);
        bytes.setFloat32(index * 20 + 8, y, true);
        bytes.setFloat32(index * 20 + 12, 0.5, true);
        bytes.setFloat32(index * 20 + 16, 1, true);
    });
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(bytes.buffer), 20),
        D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const diagnostics = device.diagnostics();
    assert.equal(diagnostics.skipped.layout, 0);
    const layout = h.gpu.of('createRenderPipeline')
        .map((/** @type {any} */ call)=>call.descriptor.vertex.buffers[0])
        .find((/** @type {any} */ buffer)=>buffer && buffer.arrayStride === 20);
    assert.ok(layout, 'a pipeline over the declared stride');
    assert.deepEqual(layout.attributes.map((/** @type {any} */ attribute)=>
        [attribute.offset, attribute.format]), [[0, 'unorm8x4'], [4, 'float32x4']]);
});

test('a declaration the fixed-function stage cannot read is dropped, not raised', async()=>{
    // A colour in a second stream: this stage reads one stream. The draw must
    // not throw into the program's thread; it is counted and said once.
    const h = harness();
    const { device } = h;
    colourFirstDeclaration(device, 1);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(60), 20), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();
    assert.equal(device.diagnostics().skipped.layout, 1);
});
