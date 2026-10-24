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
import {
    D3DERR_INVALIDCALL, D3DFMT, D3DPOOL, D3DRS, D3DSWAPEFFECT, D3DUSAGE, D3D_OK,
} from './constants.js';
import {
    D3DCLEAR, D3DFMT_INDEX, D3DLOCK, D3DPT, D3DTA, D3DTEXF, D3DTOP, D3DTSS,
} from '../d3d8/constants.js';
import { D3DISSUE, D3DQUERYTYPE, createDirect3D9 } from './device.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { FVF } from '../webgpu/internal/vertexformat.js';
import { UNIFORM_AT } from '../d3d8/render.js';
import { commandSlot } from './commands.js';
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
 * @param {{ width?: number, height?: number, depth?: boolean,
 *     occlusionSamples?: (slot: number) => number }} [options]
 */
function harness(options = {}){
    const gpu = createFakeDevice({ occlusionSamples: options.occlusionSamples });
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
    /** Every read of guest memory the device made, as [address, length]. @type {number[][]} */
    const reads = [];
    const d3d = createDirect3D9({
        backend,
        readMemory: (address, length)=>{
            reads.push([address, length]);
            return ram.slice(address - RAM_BASE, address - RAM_BASE + length);
        },
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
        reads,
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

test('a dynamic buffer written after its unlock draws what was written', async()=>{
    // A dynamic buffer's memory stays the buffer's after the unlock, as a
    // driver's does: a program that locks its skinning buffer once a frame
    // and writes each model's vertices through that address afterwards draws
    // them, where the bytes of the unlock drew every model a frame behind.
    const h = harness({ width: 8, height: 8 });
    const { device } = h;
    /** @type {{ buffer?: any }} */
    const created = {};
    assert.equal(device.CreateVertexBuffer(3 * TRIANGLE_STRIDE,
        D3DUSAGE.DYNAMIC | D3DUSAGE.WRITEONLY, FVF_TRIANGLE, D3DPOOL.DEFAULT, created), D3D_OK);
    /** @type {{ pBits?: number }} */
    const locked = {};
    assert.equal(created.buffer.Lock(0, 0, locked, D3DLOCK.DISCARD), D3D_OK);
    const at = /** @type {number} */ (locked.pBits);
    /** @param {number[][]} corners */
    const put = corners=>corners.forEach(([x, y], index)=>
        h.write(at + index * TRIANGLE_STRIDE, vertex(x, y, argb(0, 0, 255))));
    put([[0, 0], [1, 0], [0, 1]]);
    assert.equal(created.buffer.Unlock(), D3D_OK);
    const written = [[1, 1], [7, 1], [1, 4]];
    put(written);

    assert.equal(device.SetStreamSource(0, created.buffer, 0, TRIANGLE_STRIDE), D3D_OK);
    assert.equal(device.SetFVF(FVF_TRIANGLE), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const draws = h.device.diagnostics().lastFrame.filter(
        (/** @type {any} */ command)=>command.kind === 'draw');
    assert.equal(draws.length, 1);
    assert.deepEqual(queuedTriangle(h, draws[0]).map(point=>[point.x, point.y]), written,
        'the draw reads what the program wrote after the unlock');
    created.buffer.release();
});

test('every vertex a draw reads of streams bound at offsets into a dynamic buffer written after its'
    + ' unlock is where the binding reads it', async()=>{
    // Direct3D 9 reads a stream's vertex v at the stream's offset plus v times
    // its stride, v the base vertex plus the index. The device folds the whole
    // vertices of stream zero's offset into the first vertex and each binding
    // takes them back; what a draw uploads of a buffer written after its unlock
    // has to be counted the same way, since only the draw sends those bytes --
    // counted from a further stream's own offset it lay that many vertices
    // past what the GPU read. Positions in stream zero and colours in stream
    // one, out of one buffer at offsets of their own, drawn indexed and not:
    // each vertex the GPU reads through what the device bound is compared with
    // what the program wrote where Direct3D says the vertex is.
    const h = harness({ width: 8, height: 8 });
    const { device } = h;
    const BYTES = 64 << 10;
    /** @type {{ declaration?: any }} */
    const made = {};
    assert.equal(device.CreateVertexDeclaration([
        { Stream: 0, Offset: 0, Type: D3DDECLTYPE.FLOAT4, Method: 0,
            Usage: D3DDECLUSAGE.POSITIONT, UsageIndex: 0 },
        { Stream: 1, Offset: 0, Type: D3DDECLTYPE.D3DCOLOR, Method: 0,
            Usage: D3DDECLUSAGE.COLOR, UsageIndex: 0 },
    ], made), D3D_OK);
    assert.equal(device.SetVertexDeclaration(made.declaration), D3D_OK);
    /** @type {{ buffer?: any }} */
    const created = {};
    assert.equal(device.CreateVertexBuffer(BYTES, D3DUSAGE.DYNAMIC | D3DUSAGE.WRITEONLY, 0,
        D3DPOOL.DEFAULT, created), D3D_OK);
    /** @type {{ buffer?: any }} */
    const indices = {};
    assert.equal(device.CreateIndexBuffer(64, 0, D3DFMT_INDEX.INDEX16, D3DPOOL.MANAGED, indices),
        D3D_OK);
    assert.equal(device.SetIndices(indices.buffer), D3D_OK);
    let seed = 0x2545f491;
    /** @param {number} n */
    const below = n=>{
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return (seed >>> 8) % n;
    };
    /** @type {string[]} */
    const wrong = [];
    let folded = 0;
    for (let round = 0; round < 48; round++)
    {
        const strides = [16 + 4 * below(5), 4 * (1 + below(3))];
        // Stream zero in the buffer's first half, stream one in its second.
        const offsets = [4 * below(4096), (32 << 10) + 4 * below(4096)];
        const indexed = below(2) === 0;
        const count = 3 * (1 + below(3));
        const base = below(40);
        const low = below(10);
        /** The vertices Direct3D reads, in its numbering: base vertex plus each index. */
        const order = indexed ? Array.from({ length: count }, ()=>low + below(count))
            : Array.from({ length: count }, (unused, k)=>k);
        folded += Math.min(...offsets.map((offset, stream)=>
            Math.floor(offset / strides[stream]))) > 0 ? 1 : 0;
        /** @type {{ pBits?: number }} */
        const locked = {};
        assert.equal(created.buffer.Lock(0, 0, locked, D3DLOCK.DISCARD), D3D_OK);
        assert.equal(created.buffer.Unlock(), D3D_OK);
        const at = /** @type {number} */ (locked.pBits);
        /** Each vertex's bytes in each stream, as written after the unlock. @type {Map<string, Uint8Array>} */
        const wrote = new Map();
        for (const index of order)
        {
            const v = base + index;
            strides.forEach((stride, stream)=>{
                const bytes = Uint8Array.from({ length: stride },
                    (unused, k)=>(round * 31 + v * 7 + stream * 101 + k * 13 + 1) & 0xff);
                if (stream === 0)
                {
                    // A position the stage can take: x, y in the target, z, rhw.
                    const view = new DataView(bytes.buffer);
                    view.setFloat32(0, 1 + (v % 6), true);
                    view.setFloat32(4, 1 + (v % 5), true);
                    view.setFloat32(8, 0.5, true);
                    view.setFloat32(12, 1, true);
                }
                h.write(at + offsets[stream] + v * stride, bytes);
                wrote.set(`${stream}:${v}`, bytes);
            });
        }
        if (indexed)
        {
            /** @type {{ pBits?: number }} */
            const out = {};
            assert.equal(indices.buffer.Lock(0, 0, out, 0), D3D_OK);
            h.write(/** @type {number} */ (out.pBits),
                new Uint8Array(Uint16Array.from(order).buffer));
            assert.equal(indices.buffer.Unlock(), D3D_OK);
        }
        strides.forEach((stride, stream)=>assert.equal(
            device.SetStreamSource(stream, created.buffer, offsets[stream], stride), D3D_OK));
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(indexed
            ? device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, base, low, count, 0, count / 3)
            : device.DrawPrimitive(D3DPT.TRIANGLELIST, base, count / 3), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();

        const draws = device.diagnostics().lastFrame.filter(
            (/** @type {any} */ command)=>command.kind === 'draw');
        assert.equal(draws.length, 1, `round ${round}: the draw was made`);
        const [draw] = draws;
        /** Where the GPU reads each stream: the buffer and offset bound for it. */
        const bound = [draw.vertices, draw.streams?.[0]];
        order.forEach((index, k)=>{
            // The vertex the GPU fetches, numbered as the device bound it.
            const fetched = indexed ? draw.baseVertex + index : draw.first + k;
            strides.forEach((stride, stream)=>{
                const from = bound[stream].offset + fetched * stride;
                const read = /** @type {Uint8Array} */ (bound[stream].gpu.bytes)
                    .subarray(from, from + stride);
                if (!read.every((byte, i)=>byte === wrote.get(`${stream}:${base + index}`)?.[i]))
                {
                    wrong.push(`round ${round}: stream ${stream} (offset ${offsets[stream]},`
                        + ` stride ${stride}) vertex ${base + index} of a`
                        + ` ${indexed ? 'indexed' : 'plain'} draw`);
                }
            });
        });
    }
    assert.deepEqual(wrong.slice(0, 4), []);
    assert.ok(folded > 24, `stream zero's offset folded into the first vertex (${folded} of 48)`);
    created.buffer.release();
    indices.buffer.release();
});

test('models written one after another into a dynamic buffer after its unlock draw each its own'
    + ' vertices, and the buffer goes to the queue once a frame', async()=>{
    // A skinning buffer: locked with DISCARD and unlocked once a frame, then
    // each model's vertices written through the pointer and drawn. A write to
    // the queue at every draw was a trip to the GPU for every model.
    const h = harness({ width: 8, height: 8 });
    const { device } = h;
    const MODELS = 6;
    /** @type {{ buffer?: any }} */
    const created = {};
    assert.equal(device.CreateVertexBuffer(MODELS * 3 * TRIANGLE_STRIDE,
        D3DUSAGE.DYNAMIC | D3DUSAGE.WRITEONLY, FVF_TRIANGLE, D3DPOOL.DEFAULT, created), D3D_OK);
    assert.equal(device.SetStreamSource(0, created.buffer, 0, TRIANGLE_STRIDE), D3D_OK);
    assert.equal(device.SetFVF(FVF_TRIANGLE), D3D_OK);
    for (let frame = 0; frame < 2; frame++)
    {
        /** @type {{ pBits?: number }} */
        const locked = {};
        assert.equal(created.buffer.Lock(0, 0, locked, D3DLOCK.DISCARD), D3D_OK);
        assert.equal(created.buffer.Unlock(), D3D_OK);
        const at = /** @type {number} */ (locked.pBits);
        const before = h.gpu.of('writeBuffer').length;
        /** @type {number[][][]} */
        const models = [];
        assert.equal(device.BeginScene(), D3D_OK);
        for (let model = 0; model < MODELS; model++)
        {
            const corners = [[1 + model % 3, 1], [7, 1 + frame], [1, 4 + model % 2]];
            corners.forEach(([x, y], index)=>h.write(at + (model * 3 + index) * TRIANGLE_STRIDE,
                vertex(x, y, argb(0, 0, 255))));
            models.push(corners);
            assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, model * 3, 1), D3D_OK);
        }
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();
        const draws = h.device.diagnostics().lastFrame.filter(
            (/** @type {any} */ command)=>command.kind === 'draw');
        assert.equal(draws.length, MODELS);
        draws.forEach((/** @type {any} */ draw, /** @type {number} */ model)=>assert.deepEqual(
            queuedTriangle(h, draw).map(point=>[point.x, point.y]), models[model],
            `frame ${frame}: model ${model} reads what was written for it`));
        const buffer = draws[0].vertices.gpu;
        const writes = h.gpu.of('writeBuffer').slice(before)
            .filter((/** @type {any} */ call)=>call.buffer === buffer);
        assert.equal(writes.length, 1, `frame ${frame}: one write of the buffer, not one a model`);
    }
    created.buffer.release();
});

test('draws in one run of the command ring compare a dynamic buffer\'s range once, not once a'
    + ' draw', async()=>{
    // The program does not run while a run of the ring is played, so its
    // memory cannot change between the draws in it: a game that names a whole
    // buffer as every draw's vertices compared all of it at every draw.
    const h = harness({ width: 8, height: 8 });
    const { device } = h;
    const DRAWS = 10;
    /** @type {{ buffer?: any }} */
    const created = {};
    assert.equal(device.CreateVertexBuffer(DRAWS * 3 * TRIANGLE_STRIDE,
        D3DUSAGE.DYNAMIC | D3DUSAGE.WRITEONLY, FVF_TRIANGLE, D3DPOOL.DEFAULT, created), D3D_OK);
    /** @type {{ pBits?: number }} */
    const locked = {};
    assert.equal(created.buffer.Lock(0, 0, locked, D3DLOCK.DISCARD), D3D_OK);
    assert.equal(created.buffer.Unlock(), D3D_OK);
    const at = /** @type {number} */ (locked.pBits);
    const length = DRAWS * 3 * TRIANGLE_STRIDE;
    for (let index = 0; index < DRAWS * 3; index++)
    {
        h.write(at + index * TRIANGLE_STRIDE, vertex(1 + index % 5, 1 + index % 3,
            argb(0, 0, 255)));
    }
    assert.equal(device.SetStreamSource(0, created.buffer, 0, TRIANGLE_STRIDE), D3D_OK);
    assert.equal(device.SetFVF(FVF_TRIANGLE), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    /** @param {number[]} args */
    const draw = args=>[commandSlot('DrawPrimitive'), (2 + args.length) * 4, ...args];
    // Every draw reads the whole buffer: the first vertex and all the triangles.
    const records = new Uint32Array(Array.from({ length: DRAWS },
        ()=>draw([D3DPT.TRIANGLELIST, 0, DRAWS])).flat());
    const bytesRead = ()=>h.reads.filter(([address])=>address >= at && address < at + length)
        .reduce((sum, [, size])=>sum + size, 0);
    const before = bytesRead();
    assert.equal(device.commands(new Uint8Array(records.buffer)), DRAWS);
    assert.equal(bytesRead() - before, length, 'the buffer read once in the run');
    // Outside a run each draw is a call of its own: the program may have run
    // before it, so it compares again.
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, DRAWS), D3D_OK);
    assert.equal(bytesRead() - before, 2 * length, 'and again for a draw made on its own');
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();
    const draws = h.device.diagnostics().lastFrame.filter(
        (/** @type {any} */ command)=>command.kind === 'draw');
    assert.equal(draws.length, DRAWS + 1);
    created.buffer.release();
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

test('a frame says how many of its draws went into each target, and through how many viewports',
    async()=>{
        // A shadow map is one target drawn through a viewport a cascade: a
        // frame that draws four times as much after a small turn of the
        // camera says by this whether the draws went into the picture or
        // into such a pass, which a count of draws off the back buffer
        // cannot.
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
        /** @type {{ texture?: any }} */
        const map = {};
        assert.equal(device.CreateTexture(4, 8, 1, D3DUSAGE.RENDERTARGET, D3DFMT.A8R8G8B8,
            D3DPOOL.DEFAULT, map), D3D_OK);
        /** @type {{ surface?: any }} */
        const level = {};
        assert.equal(map.texture.GetSurfaceLevel(0, level), D3D_OK);
        /** @type {{ surface?: any }} */
        const back = {};
        assert.equal(device.GetBackBuffer(0, 0, 0, back), D3D_OK);

        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetRenderTarget(0, level.surface), D3D_OK);
        for (const y of [0, 4, 4])
        {
            assert.equal(device.SetViewport({ X: 0, Y: y, Width: 4, Height: 4, MinZ: 0,
                MaxZ: 1 }), D3D_OK);
            assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        }
        assert.equal(device.SetRenderTarget(0, back.surface), D3D_OK);
        assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();
        // A frame that drew nothing names no target.
        await h.present();

        const frames = h.device.diagnostics().recentFrames;
        assert.deepEqual(frames.map((/** @type {any} */ frame)=>frame.targets),
            ['4x8 x3 in 2 views, back 8x8 x1', '']);
        back.surface.release();
        level.surface.release();
        map.texture.release();
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

test('a viewport past its target is taken, and draws keep its mapping', async()=>{
    // Wine's d3d9 test_viewport: (0, 0, 1280, 960) and (100, 100, 640, 480) on
    // a 640x480 target are D3D_OK, and the picture is the viewport's mapping
    // cut to the target. Direct3D 8 refuses the same viewports.
    const h = harness({ width: 8, height: 8 });
    const wide = { X: 4, Y: 2, Width: 8, Height: 16, MinZ: 0, MaxZ: 1 };
    assert.equal(h.device.SetViewport(wide), D3D_OK);
    /** @type {{ viewport?: any }} */
    const out = {};
    assert.equal(h.device.GetViewport(out), D3D_OK);
    assert.deepEqual(out.viewport, wide);
    assert.notEqual(
        h.device.SetViewport({ X: 0, Y: 0, Width: 0, Height: 8, MinZ: 0, MaxZ: 1 }), D3D_OK,
        'an empty one is still refused');

    assert.equal(h.device.SetFVF(FVF_TRIANGLE), D3D_OK);
    assert.equal(h.device.BeginScene(), D3D_OK);
    assert.equal(h.device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, Uint8Array.from([
        ...vertex(4, 2, argb(255, 0, 0)), ...vertex(12, 2, argb(255, 0, 0)),
        ...vertex(4, 18, argb(255, 0, 0)),
    ]), TRIANGLE_STRIDE), D3D_OK);
    assert.equal(h.device.EndScene(), D3D_OK);
    await h.present();
    const viewports = h.gpu.of('setViewport').map((/** @type {any} */ call)=>call.rect);
    assert.ok(viewports.some((/** @type {number[]} */ args)=>args[0] === 4 && args[1] === 2
        && args[2] === 8 && args[3] === 16), 'the viewport reaches the pass as it was set');
});

test('a draw under the scissor test is cut to the scissor rectangle, and only then', async()=>{
    // D3DRS_SCISSORTESTENABLE with SetScissorRect "defines the rendering area
    // within the render target" (Microsoft's IDirect3DDevice9::SetScissorRect)
    // for draws, not only for Clear: each draw runs under the scissor cut to
    // the viewport, and with the test off under the viewport's own again.
    const h = harness({ width: 8, height: 8 });
    const triangle = Uint8Array.from([
        ...vertex(0, 0, argb(255, 0, 0)), ...vertex(8, 0, argb(255, 0, 0)),
        ...vertex(0, 8, argb(255, 0, 0)),
    ]);
    const draw = ()=>assert.equal(
        h.device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, triangle, TRIANGLE_STRIDE), D3D_OK);
    assert.equal(h.device.SetFVF(FVF_TRIANGLE), D3D_OK);
    assert.equal(h.device.SetScissorRect({ left: 2, top: 1, right: 20, bottom: 5 }), D3D_OK);
    assert.equal(h.device.BeginScene(), D3D_OK);
    draw();
    assert.equal(h.device.SetRenderState(D3DRS.SCISSORTESTENABLE, 1), D3D_OK);
    draw();
    draw();
    assert.equal(h.device.SetRenderState(D3DRS.SCISSORTESTENABLE, 0), D3D_OK);
    draw();
    assert.equal(h.device.EndScene(), D3D_OK);
    await h.present();

    const commands = h.device.diagnostics().lastFrame
        .filter((/** @type {any} */ command)=>command.kind === 'draw' || command.kind === 'scissor')
        .map((/** @type {any} */ command)=>(command.kind === 'draw' ? 'draw'
            : `${command.rect.x},${command.rect.y},${command.rect.width},${command.rect.height}`));
    assert.deepEqual(commands, ['draw', '2,1,6,4', 'draw', 'draw', '0,0,8,8', 'draw'],
        'the scissor cut to the viewport, set once for two draws and put back after');
    const scissors = h.gpu.of('setScissorRect').map((/** @type {any} */ call)=>call.rect);
    assert.deepEqual(scissors.slice(-2), [[2, 1, 6, 4], [0, 0, 8, 8]]);
});

test('a stream whose offset is part of a vertex in is bound there, by both kinds of draw',
    async()=>{
        const h = harness({ width: 8, height: 8 });
        const { device } = h;
        /** @type {{ buffer?: any }} */
        const created = {};
        assert.equal(device.CreateVertexBuffer(
            8 * TRIANGLE_STRIDE, 0, FVF_TRIANGLE, D3DPOOL.DEFAULT, created), D3D_OK);
        /** @type {{ pBits?: number }} */
        const locked = {};
        assert.equal(created.buffer.Lock(0, 0, locked, 0), D3D_OK);
        // Three whole vertices and eight bytes in, which no first vertex can say alone.
        const offset = 3 * TRIANGLE_STRIDE + 8;
        const wanted = [[1, 1], [7, 1], [1, 4], [2, 2]];
        wanted.forEach(([x, y], index)=>h.write(/** @type {number} */ (locked.pBits) + offset
            + index * TRIANGLE_STRIDE, vertex(x, y, argb(0, 0, 255))));
        assert.equal(created.buffer.Unlock(), D3D_OK);
        /** @type {{ buffer?: any }} */
        const indexBuffer = {};
        assert.equal(device.CreateIndexBuffer(6, 0, D3DFMT_INDEX.INDEX16, D3DPOOL.DEFAULT,
            indexBuffer), D3D_OK);
        /** @type {{ pBits?: number }} */
        const indexLock = {};
        assert.equal(indexBuffer.buffer.Lock(0, 0, indexLock, 0), D3D_OK);
        h.write(/** @type {number} */ (indexLock.pBits), new Uint8Array([0, 0, 1, 0, 2, 0]));
        assert.equal(indexBuffer.buffer.Unlock(), D3D_OK);

        assert.equal(device.SetStreamSource(0, created.buffer, offset, TRIANGLE_STRIDE), D3D_OK);
        assert.equal(device.SetIndices(indexBuffer.buffer), D3D_OK);
        assert.equal(device.SetFVF(FVF_TRIANGLE), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 1, 1), D3D_OK);
        assert.equal(device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, 1, 0, 3, 0, 1), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();

        const draws = h.device.diagnostics().lastFrame.filter(
            (/** @type {any} */ command)=>command.kind === 'draw');
        assert.equal(draws[0].vertices.offset, 8, 'bound at what is left past whole vertices');
        assert.equal(draws[0].first, 3 + 1, 'the whole vertices are in the first vertex');
        assert.deepEqual(queuedTriangle(h, draws[0]).map(point=>[point.x, point.y]),
            wanted.slice(1));
        assert.equal(draws[1].vertices.offset, 8);
        assert.equal(draws[1].baseVertex, 3 + 1, 'and in the base vertex of an indexed draw');
        const bound = h.gpu.of('setVertexBuffer').map((/** @type {any} */ call)=>call.offset);
        assert.ok(bound.length > 0 && bound.every(at=>at === 8), 'the GPU is given that offset');
    });

test('an indexed point list from a stream at an offset reads its vertices from there', async()=>{
    const h = harness({ width: 8, height: 8 });
    const { device } = h;
    /** @type {{ buffer?: any }} */
    const created = {};
    assert.equal(device.CreateVertexBuffer(
        8 * TRIANGLE_STRIDE, 0, FVF_TRIANGLE, D3DPOOL.DEFAULT, created), D3D_OK);
    /** @type {{ pBits?: number }} */
    const locked = {};
    assert.equal(created.buffer.Lock(0, 0, locked, 0), D3D_OK);
    const offset = 2 * TRIANGLE_STRIDE + 4;
    const points = [[1, 1], [3, 3], [5, 5], [6, 2]];
    points.forEach(([x, y], index)=>h.write(/** @type {number} */ (locked.pBits) + offset
        + index * TRIANGLE_STRIDE, vertex(x, y, argb(0, 255, 0))));
    assert.equal(created.buffer.Unlock(), D3D_OK);
    /** @type {{ buffer?: any }} */
    const indexBuffer = {};
    assert.equal(device.CreateIndexBuffer(4, 0, D3DFMT_INDEX.INDEX16, D3DPOOL.DEFAULT,
        indexBuffer), D3D_OK);
    /** @type {{ pBits?: number }} */
    const indexLock = {};
    assert.equal(indexBuffer.buffer.Lock(0, 0, indexLock, 0), D3D_OK);
    h.write(/** @type {number} */ (indexLock.pBits), new Uint8Array([2, 0, 0, 0]));
    assert.equal(indexBuffer.buffer.Unlock(), D3D_OK);

    assert.equal(device.SetStreamSource(0, created.buffer, offset, TRIANGLE_STRIDE), D3D_OK);
    assert.equal(device.SetIndices(indexBuffer.buffer), D3D_OK);
    assert.equal(device.SetFVF(FVF_TRIANGLE), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    // Base vertex one: indices 2 and 0 are the fourth and second vertex past the offset.
    assert.equal(device.DrawIndexedPrimitive(D3DPT.POINTLIST, 1, 0, 3, 0, 2), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const draw = h.device.diagnostics().lastFrame.find(
        (/** @type {any} */ command)=>command.kind === 'draw');
    const bytes = queuedBytes(h.gpu, draw.vertices, 2 * TRIANGLE_STRIDE);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.deepEqual([0, 1].map(at=>[view.getFloat32(at * TRIANGLE_STRIDE, true),
        view.getFloat32(at * TRIANGLE_STRIDE + 4, true)]), [points[3], points[1]],
    'the offset counted once: its whole vertices are the base vertex\'s already');
});

test('a stream whose offset leaves part of a word past whole vertices is refused', ()=>{
    const h = harness();
    const { device } = h;
    /** @type {{ buffer?: any }} */
    const created = {};
    assert.equal(device.CreateVertexBuffer(
        6 * TRIANGLE_STRIDE, 0, FVF_TRIANGLE, D3DPOOL.DEFAULT, created), D3D_OK);
    assert.equal(device.SetStreamSource(0, created.buffer, TRIANGLE_STRIDE + 2, TRIANGLE_STRIDE),
        D3D_OK);
    assert.equal(device.SetFVF(FVF_TRIANGLE), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);

    assert.notEqual(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK,
        'WebGPU binds a vertex buffer only at a multiple of four bytes');
    assert.equal(device.SetStreamSource(0, created.buffer, TRIANGLE_STRIDE + 4, TRIANGLE_STRIDE),
        D3D_OK);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
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

test('a draw needs a position in its format and a bound stream, and no scene', ()=>{
    const h = harness();
    const { device } = h;
    /** @type {{ buffer?: any }} */
    const created = {};
    assert.equal(device.CreateVertexBuffer(
        3 * TRIANGLE_STRIDE, 0, FVF_TRIANGLE, D3DPOOL.DEFAULT, created), D3D_OK);

    assert.equal(device.SetFVF(FVF_TRIANGLE), D3D_OK);
    assert.equal(device.SetStreamSource(0, created.buffer, 0, TRIANGLE_STRIDE), D3D_OK);
    // Wine's d3d9 draws check no scene, and Titan Quest draws its loading
    // screen between two Presents with none.
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK,
        'outside a scene, drawn');

    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetFVF(FVF.DIFFUSE), D3D_OK);
    assert.notEqual(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK,
        'a format with no position is not a format');

    assert.equal(device.SetFVF(FVF_TRIANGLE), D3D_OK);
    assert.equal(device.SetStreamSource(0, null, 0, 0), D3D_OK);
    assert.notEqual(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK,
        'and nothing is bound to read vertices from');
});

test('a lock reports guest memory, and a second lock of the same buffer nests', ()=>{
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
    // Locks of a buffer are counted, as the runtime counts them: a program
    // filling a dynamic buffer a piece at a time locks the next piece before
    // it unlocks the last.
    assert.equal(created.buffer.Lock(0, 16, second, 0), D3D_OK);
    assert.equal(created.buffer.Unlock(), D3D_OK);
    assert.equal(created.buffer.Unlock(), D3D_OK);
    assert.equal(created.buffer.Unlock(), 0x8876086c, 'and an unlock past the locks owes nothing');
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
    // A colour of four bytes read as R, G, B, A: this stage reads D3DCOLOR.
    // The draw must not throw into the program's thread; it is counted and
    // said once.
    const h = harness();
    const { device } = h;
    /** @type {{ declaration?: any }} */
    const made = {};
    assert.equal(device.CreateVertexDeclaration([
        { Stream: 0, Offset: 0, Type: D3DDECLTYPE.UBYTE4N, Method: 0,
            Usage: D3DDECLUSAGE.COLOR, UsageIndex: 0 },
        { Stream: 0, Offset: 4, Type: D3DDECLTYPE.FLOAT4, Method: 0,
            Usage: D3DDECLUSAGE.POSITIONT, UsageIndex: 0 },
    ], made), D3D_OK);
    assert.equal(device.SetVertexDeclaration(made.declaration), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(60), 20), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();
    assert.equal(device.diagnostics().skipped.layout, 1);
});

test('a fixed-function draw reads a member in another stream from that stream', async()=>{
    // Wine's d3d9 test_color_vertex: a declaration with its diffuse colour in
    // stream 1 draws through the fixed-function stage; with stream 1 bound the
    // colour is read from that buffer at its stride, and with nothing bound
    // there -- the Wine test's DrawPrimitiveUP -- it reads as zero, which is
    // what the test's lit colours come out as.
    const h = harness({ width: 8, height: 8 });
    const { device } = h;
    colourFirstDeclaration(device, 1);
    const positions = new DataView(new ArrayBuffer(60));
    [[1, 1], [7, 1], [1, 4]].forEach(([x, y], index)=>{
        positions.setFloat32(index * 20 + 4, x, true);
        positions.setFloat32(index * 20 + 8, y, true);
        positions.setFloat32(index * 20 + 12, 0.5, true);
        positions.setFloat32(index * 20 + 16, 1, true);
    });
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1,
        new Uint8Array(positions.buffer), 20), D3D_OK);
    /** @type {{ buffer?: any }} */
    const colours = {};
    assert.equal(device.CreateVertexBuffer(12, 0, 0, D3DPOOL.MANAGED, colours), D3D_OK);
    assert.equal(device.SetStreamSource(1, colours.buffer, 0, 4), D3D_OK);
    /** @type {{ buffer?: any }} */
    const vertices = {};
    assert.equal(device.CreateVertexBuffer(60, 0, 0, D3DPOOL.MANAGED, vertices), D3D_OK);
    assert.equal(device.SetStreamSource(0, vertices.buffer, 0, 20), D3D_OK);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    assert.equal(device.diagnostics().skipped.layout, 0);
    const pipelines = h.gpu.of('createRenderPipeline')
        .map((/** @type {any} */ call)=>call.descriptor.vertex.buffers)
        .filter((/** @type {any[]} */ buffers)=>buffers.length === 2);
    assert.deepEqual(pipelines.map((/** @type {any[]} */ buffers)=>buffers.map(buffer=>
        [buffer.arrayStride, buffer.attributes.map((/** @type {any} */ a)=>a.offset)])), [
        [[20, [4]], [0, [0]]],
        [[20, [4]], [4, [0]]],
    ], 'stream 1 as its own buffer: unbound at a stride of nothing, then at its own');
    const bound = h.gpu.of('setVertexBuffer')
        .filter((/** @type {any} */ call)=>call.slot === 1)
        .map((/** @type {any} */ call)=>call.buffer.descriptor.label);
    assert.equal(bound.length, 2);
    assert.match(bound[0], /zero/, 'nothing bound reads as zero');
    assert.doesNotMatch(bound[1], /zero/, 'and the bound buffer after');
    colours.buffer.release();
    vertices.buffer.release();
});

test('a stream zero deep in its buffer beside another at its start draws', async()=>{
    // Stream zero's offset is folded into the first vertex, which moves every
    // stream that steps with it; folded whole, a stream 1 bound at zero was
    // asked to start before its buffer and the draw was dropped.
    const h = harness({ width: 8, height: 8 });
    const { device } = h;
    colourFirstDeclaration(device, 1);
    /** @type {{ buffer?: any }} */
    const colours = {};
    assert.equal(device.CreateVertexBuffer(12, 0, 0, D3DPOOL.MANAGED, colours), D3D_OK);
    assert.equal(device.SetStreamSource(1, colours.buffer, 0, 4), D3D_OK);
    /** @type {{ buffer?: any }} */
    const vertices = {};
    assert.equal(device.CreateVertexBuffer(120, 0, 0, D3DPOOL.MANAGED, vertices), D3D_OK);
    assert.equal(device.SetStreamSource(0, vertices.buffer, 60, 20), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    assert.equal(device.diagnostics().skipped.stream, 0, 'the draw is made');
    const draw = device.diagnostics().lastFrame.filter(
        (/** @type {any} */ command)=>command.kind === 'draw').at(-1);
    // Vertex v of the draw reads stream zero at 60 + 20 v and stream 1 at 4 v:
    // where each is bound, and the first vertex every stream steps from.
    const further = draw.streams.find((/** @type {any} */ one)=>one.slot === 1);
    assert.equal(draw.vertices.offset + draw.first * 20, 60, 'stream zero from its offset');
    assert.equal(further.offset + draw.first * 4, 0, 'stream 1 from its start');
    colours.buffer.release();
    vertices.buffer.release();
});

test('a NOOVERWRITE lock over what a queued draw reads from another stream renames it', async()=>{
    // A program that keeps vertices from frame to frame -- a skinning cache --
    // writes its next stretch under NOOVERWRITE, and a frame's draws read at
    // its submit, after every write it made: a lock over bytes a draw of the
    // frame reads from stream 1 must leave that draw its bytes, as one over
    // stream zero's does.
    const h = harness({ width: 8, height: 8 });
    const { device } = h;
    colourFirstDeclaration(device, 1);
    /** @type {{ buffer?: any }} */
    const vertices = {};
    assert.equal(device.CreateVertexBuffer(60, 0, 0, D3DPOOL.MANAGED, vertices), D3D_OK);
    assert.equal(device.SetStreamSource(0, vertices.buffer, 0, 20), D3D_OK);
    /** @type {{ buffer?: any }} */
    const colours = {};
    assert.equal(device.CreateVertexBuffer(12, D3DUSAGE.DYNAMIC | D3DUSAGE.WRITEONLY, 0,
        D3DPOOL.DEFAULT, colours), D3D_OK);
    assert.equal(device.SetStreamSource(1, colours.buffer, 0, 4), D3D_OK);
    /** @param {number} value */
    const fill = value=>{
        /** @type {{ pBits?: number }} */
        const locked = {};
        assert.equal(colours.buffer.Lock(0, 12, locked, D3DLOCK.NOOVERWRITE), D3D_OK);
        h.write(/** @type {number} */ (locked.pBits), new Uint8Array(12).fill(value));
        assert.equal(colours.buffer.Unlock(), D3D_OK);
    };
    assert.equal(device.BeginScene(), D3D_OK);
    fill(0x11);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    fill(0x22);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const bound = h.gpu.of('setVertexBuffer')
        .filter((/** @type {any} */ call)=>call.slot === 1)
        .map((/** @type {any} */ call)=>call.buffer.descriptor.label);
    assert.equal(bound.length, 2);
    assert.notEqual(bound[0], bound[1], 'the first draw keeps the generation it read');
    colours.buffer.release();
    vertices.buffer.release();
});

/**
 * A draw of one textured triangle, the stage selecting the texture.
 *
 * @param {ReturnType<typeof harness>} h
 */
async function drawTextured(h){
    const { device } = h;
    assert.equal(device.SetTextureStageState(0, D3DTSS.COLOROP, D3DTOP.SELECTARG1), D3D_OK);
    assert.equal(device.SetTextureStageState(0, D3DTSS.COLORARG1, D3DTA.TEXTURE), D3D_OK);
    assert.equal(device.SetFVF(FVF.XYZRHW | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT)), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(84), 28), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();
}

/**
 * The passes that made a texture's levels, as the level each drew, the
 * level it read and the filter it read it through.
 *
 * @param {any} gpu @param {any} texture  The GPU texture.
 * @returns {any[][]}
 */
function mipPasses(gpu, texture){
    return gpu.of('beginRenderPass')
        .filter((/** @type {any} */ call)=>call.descriptor.label.startsWith('mips:')
            && call.descriptor.colorAttachments[0].view.texture === texture)
        .map((/** @type {any} */ call)=>{
            const binds = gpu.of('setBindGroup').filter(
                (/** @type {any} */ bound)=>bound.pass === call.pass);
            const source = binds[0].group.entries[0].resource;
            return [call.descriptor.colorAttachments[0].view.viewDescriptor.baseMipLevel,
                source.viewDescriptor.baseMipLevel, binds[0].group.entries[1].resource
                    .descriptor.magFilter];
        });
}

test('recorded: a texture that makes its own levels makes them before a draw samples them',
    async()=>{
        // Wine's d3d9 autogen_mipmap_test: the program writes the top level
        // alone, and a sample far enough away reads a level the device made
        // from it.
        const h = harness();
        const { device, gpu } = h;
        /** @type {{ texture?: any }} */
        const out = {};
        assert.equal(device.CreateTexture(8, 8, 0, D3DUSAGE.AUTOGENMIPMAP, D3DFMT.X8R8G8B8,
            D3DPOOL.MANAGED, out), D3D_OK);
        const texture = out.texture;
        assert.equal(texture.levels, 1, 'the program sees one level');
        const fill = (/** @type {number} */ value)=>{
            /** @type {{ pBits?: number }} */
            const locked = {};
            assert.equal(texture.LockRect(0, locked, null, 0), D3D_OK);
            h.write(/** @type {number} */ (locked.pBits), new Uint8Array(8 * 8 * 4).fill(value));
            assert.equal(texture.UnlockRect(0), D3D_OK);
        };
        fill(9);
        assert.equal(device.SetTexture(0, texture), D3D_OK);
        await drawTextured(h);

        const made = gpu.of('createTexture').find(
            (/** @type {any} */ call)=>call.descriptor.label === 'texture');
        assert.equal(made.descriptor.mipLevelCount, 4, 'the GPU holds the whole chain');
        const uploads = ()=>gpu.of('copyBufferToTexture').filter(
            (/** @type {any} */ call)=>call.destination.texture === made.texture).length;
        assert.equal(uploads(), 1, 'the top level alone goes up');
        assert.deepEqual(mipPasses(gpu, made.texture),
            [[1, 0, 'linear'], [2, 1, 'linear'], [3, 2, 'linear']],
            'each level from the one above');
        const order = gpu.calls.filter((/** @type {any} */ call)=>call.op === 'beginRenderPass'
            || call.op === 'draw').map((/** @type {any} */ call)=>(call.op === 'draw'
            ? 'draw' : call.descriptor.label.startsWith('mips:') ? 'mips' : 'pass'));
        assert.ok(order.lastIndexOf('mips') < order.lastIndexOf('draw'),
            'the levels are made before the draw that samples them');
        assert.equal(device.diagnostics().mipsGenerated, 1);

        await drawTextured(h);
        assert.equal(mipPasses(gpu, made.texture).length, 3, 'nothing changed, nothing made');

        // A new top level, or the program asking, makes them again; a point
        // filter makes them from one texel of each four.
        fill(12);
        await drawTextured(h);
        assert.equal(mipPasses(gpu, made.texture).length, 6);
        assert.equal(texture.SetAutoGenFilterType(D3DTEXF.POINT), D3D_OK);
        texture.GenerateMipSubLevels();
        await drawTextured(h);
        assert.deepEqual(mipPasses(gpu, made.texture).slice(6).map(each=>each[2]),
            ['nearest', 'nearest', 'nearest']);
    });

test('recorded: a render target that makes its own levels makes them from what was drawn',
    async()=>{
        const h = harness();
        const { device, gpu } = h;
        /** @type {{ texture?: any }} */
        const out = {};
        assert.equal(device.CreateTexture(4, 4, 0, D3DUSAGE.RENDERTARGET | D3DUSAGE.AUTOGENMIPMAP,
            D3DFMT.X8R8G8B8, D3DPOOL.DEFAULT, out), D3D_OK);
        const texture = out.texture;
        /** @type {{ surface?: any }} */
        const level = {};
        assert.equal(texture.GetSurfaceLevel(0, level), D3D_OK);
        /** @type {{ surface?: any }} */
        const back = {};
        assert.equal(device.GetRenderTarget(0, back), D3D_OK);
        const frame = async()=>{
            assert.equal(device.SetRenderTarget(0, level.surface), D3D_OK);
            assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, 0xff00ff00, 1, 0), D3D_OK);
            assert.equal(device.SetRenderTarget(0, back.surface), D3D_OK);
            assert.equal(device.SetTexture(0, texture), D3D_OK);
            await drawTextured(h);
        };
        await frame();
        const made = gpu.of('createTexture').find((/** @type {any} */ call)=>
            call.descriptor.label === 'texture' && call.descriptor.mipLevelCount === 3);
        assert.ok(made, 'a chain of three behind a target the program sees one level of');
        assert.deepEqual(mipPasses(gpu, made.texture).map(each=>each.slice(0, 2)),
            [[1, 0], [2, 1]]);
        await frame();
        assert.equal(mipPasses(gpu, made.texture).length, 4, 'drawn into again, made again');
        level.surface.release();
        back.surface.release();
        assert.equal(device.SetTexture(0, null), D3D_OK);
        texture.release();
    });

test('recorded: an additional swap chain shows its own back buffer in the device\'s window',
    async()=>{
        const h = harness();
        const { device } = h;
        /** @type {{ swapChain?: any }} */
        const out = {};
        assert.equal(device.CreateAdditionalSwapChain({
            swapEffect: D3DSWAPEFFECT.DISCARD, backBufferWidth: 8, backBufferHeight: 6,
            backBufferFormat: D3DFMT.X8R8G8B8, backBufferCount: 1, windowed: true,
        }, out), D3D_OK);
        const chain = out.swapChain;
        /** @type {{ surface?: any }} */
        const back = {};
        assert.equal(chain.GetBackBuffer(0, 0, back), D3D_OK);
        const draw = ()=>{
            assert.equal(device.SetRenderTarget(0, back.surface), D3D_OK);
            assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, 0xff00ff00, 1, 0), D3D_OK);
        };
        draw();
        assert.equal(chain.Present(true), D3D_OK);
        await device.idle();
        assert.equal(h.presented.length, 1);
        assert.deepEqual([h.presented[0].surface.width, h.presented[0].surface.height], [8, 6],
            'the chain\'s back buffer, not the device\'s');

        // Into a window the display does not show: drawn, submitted, not shown.
        draw();
        assert.equal(chain.Present(false), D3D_OK);
        await device.idle();
        assert.equal(h.presented.length, 1, 'nothing more reached the display');
        assert.ok(h.gpu.of('submit').length >= 2, 'the frame was drawn all the same');

        // A reset waits for the chain, a default-pool resource, to go.
        back.surface.release();
        assert.equal(device.Reset(), D3DERR_INVALIDCALL);
        assert.equal(chain.release(), 0);
        assert.equal(device.Reset(), D3D_OK);
    });

test('recorded: a GPU that says only that a sample passed is answered with what the draw reaches',
    async()=>{
        // WebGPU promises zero when no sample passed and something else when some did;
        // Dawn on D3D12 answers 1 whatever the number. A 1 stands for every pixel the
        // draw could reach -- its viewport, cut to the scissor -- so a program that
        // weighs the count against a threshold of a few pixels still sees what it
        // drew, and a 0 stays 0.
        const h = harness({ width: 8, height: 8, occlusionSamples: slot=>(slot === 2 ? 0 : 1) });
        const { device } = h;
        const queries = [0, 1, 2].map(()=>{
            /** @type {{ query?: any }} */
            const out = {};
            assert.equal(device.CreateQuery(D3DQUERYTYPE.OCCLUSION, out), D3D_OK);
            return out.query;
        });
        const triangle = new Uint8Array(3 * TRIANGLE_STRIDE);
        assert.equal(device.SetFVF(FVF_TRIANGLE), D3D_OK);
        /** @param {any} query */
        const counted = query=>{
            assert.equal(query.Issue(D3DISSUE.BEGIN), D3D_OK);
            assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, triangle,
                TRIANGLE_STRIDE), D3D_OK);
            assert.equal(query.Issue(D3DISSUE.END), D3D_OK);
        };
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetViewport({ X: 1, Y: 1, Width: 6, Height: 5, MinZ: 0, MaxZ: 1 }),
            D3D_OK);
        counted(queries[0]);
        assert.equal(device.SetScissorRect({ left: 2, top: 2, right: 4, bottom: 5 }), D3D_OK);
        assert.equal(device.SetRenderState(D3DRS.SCISSORTESTENABLE, 1), D3D_OK);
        counted(queries[1]);
        counted(queries[2]);
        assert.equal(device.EndScene(), D3D_OK);
        const values = [];
        for (const query of queries)
        {
            /** @type {{ value?: number }} */
            const data = {};
            assert.equal(await query.GetData(data, 4, 1), D3D_OK);
            values.push(data.value);
        }
        assert.deepEqual(values, [30, 6, 0], 'the viewport, the scissor inside it, and nothing');
    });

test('recorded: an occlusion query counts the samples of the draws between its BEGIN and END',
    async()=>{
        // Wine's d3d9 test_occlusion_query: S_FALSE while the answer is on
        // its way, and a flush that waits for it. The recording GPU's query
        // at slot n of a frame counts 10 to the n + 1, so a count says which
        // draws it took in.
        const h = harness({ occlusionSamples: slot=>10 ** (slot + 1) });
        const { device, gpu } = h;
        /** @type {{ query?: any }} */
        const out = {};
        assert.equal(device.CreateQuery(D3DQUERYTYPE.OCCLUSION, out), D3D_OK);
        const query = out.query;
        const triangle = new Uint8Array(3 * TRIANGLE_STRIDE);
        assert.equal(device.SetFVF(FVF_TRIANGLE), D3D_OK);
        const draw = ()=>assert.equal(
            device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, triangle, TRIANGLE_STRIDE), D3D_OK);

        assert.equal(device.BeginScene(), D3D_OK);
        draw();
        assert.equal(query.Issue(D3DISSUE.BEGIN), D3D_OK);
        draw();
        draw();
        assert.equal(query.Issue(D3DISSUE.END), D3D_OK);
        draw();
        assert.equal(device.EndScene(), D3D_OK);
        /** @type {{ value?: number }} */
        const data = {};
        assert.equal(query.GetData(data, 4, 0), 1, 'S_FALSE: nothing has gone to the GPU yet');
        const flushed = query.GetData(data, 4, 1);
        assert.ok(flushed instanceof Promise, 'a flush has the caller wait');
        assert.equal(await flushed, D3D_OK);
        assert.equal(data.value, 110, 'the two draws inside, not the two outside');
        assert.equal(gpu.of('createQuerySet')[0].descriptor.type, 'occlusion');
        assert.equal(query.GetData(data, 4, 0), D3D_OK, 'and it stays answered');
        assert.equal(data.value, 110);

        // Across a change of target and across a present, one count.
        /** @type {{ surface?: any }} */
        const other = {};
        assert.equal(device.CreateRenderTarget(4, 4, D3DFMT.X8R8G8B8, false, other), D3D_OK);
        /** @type {{ surface?: any }} */
        const back = {};
        assert.equal(device.GetRenderTarget(0, back), D3D_OK);
        assert.equal(query.Issue(D3DISSUE.BEGIN), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        draw();
        assert.equal(device.SetRenderTarget(0, other.surface), D3D_OK);
        draw();
        assert.equal(device.SetRenderTarget(0, back.surface), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();
        assert.equal(query.GetData(data, 4, 0), 1, 'still open');
        assert.equal(device.BeginScene(), D3D_OK);
        draw();
        assert.equal(query.Issue(D3DISSUE.END), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();
        assert.equal(await query.GetData(data, 4, 1), D3D_OK);
        assert.equal(data.value, 120,
            'three draws, in two passes of one frame and one of the next');
        const begun = gpu.of('beginOcclusionQuery').map((/** @type {any} */ call)=>call.index);
        assert.deepEqual(begun, [0, 1, 0, 1, 0], 'a query a draw, from the first slot each frame');
        assert.equal(gpu.count('endOcclusionQuery'), 5);

        other.surface.release();
        back.surface.release();
        assert.equal(query.release(), 0);
    });

test('StretchRect scales one target over another on the GPU, filtered as asked', async()=>{
    // A program that draws its interface into a small target and stretches it over the
    // back buffer: the stretch is drawn, its viewport the destination's rectangle.
    const h = harness({ width: 8, height: 8 });
    const { device } = h;
    /** @type {{ surface?: any }} */
    const small = {};
    assert.equal(device.CreateRenderTarget(4, 4, D3DFMT.A8R8G8B8, false, small), D3D_OK);
    /** @type {{ surface?: any }} */
    const back = {};
    assert.equal(device.GetBackBuffer(0, 0, 0, back), D3D_OK);
    assert.equal(device.SetRenderTarget(0, small.surface), D3D_OK);
    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, argb(4, 5, 6), 1, 0), D3D_OK);
    assert.equal(device.SetRenderTarget(0, back.surface), D3D_OK);
    assert.equal(device.StretchRect(small.surface, null, back.surface,
        { left: 0, top: 0, right: 8, bottom: 6 }, D3DTEXF.LINEAR), D3D_OK);
    await h.present();
    const stretch = h.device.diagnostics().lastFrame
        .find((/** @type {any} */ command)=>command.kind === 'stretch');
    assert.ok(stretch, 'a stretch was recorded');
    assert.deepEqual([stretch.destRect, stretch.linear],
        [{ left: 0, top: 0, right: 8, bottom: 6 }, true]);
    const viewports = h.gpu.of('setViewport').map((/** @type {any} */ call)=>call.rect ?? call);
    assert.ok(viewports.some((/** @type {any} */ v)=>JSON.stringify(v).includes('8')
        && JSON.stringify(v).includes('6')), JSON.stringify(viewports));
});

test('a texture left bound while it is the target samples a copy of it taken before the draw,'
    + ' and the frame is drawn', async()=>{
    // Direct3D draws a stage bound to the texture being rendered into, and a
    // card gives each pixel what the target held before the draw: a post
    // effect blending a glow into the scene copy it reads relies on it, and the
    // placeholder made its picture black. WebGPU refuses the pass that does
    // both, and with it the frame's command buffer.
    const h = harness({ width: 8, height: 8 });
    const device = h.device;
    /** @type {{ texture?: any }} */
    const made = {};
    assert.equal(device.CreateTexture(8, 8, 1, D3DUSAGE.RENDERTARGET, D3DFMT.X8R8G8B8,
        D3DPOOL.DEFAULT, made), D3D_OK);
    /** @type {{ surface?: any }} */
    const level = {};
    assert.equal(made.texture.GetSurfaceLevel(0, level), D3D_OK);
    /** @type {{ surface?: any }} */
    const back = {};
    assert.equal(device.GetBackBuffer(0, 0, 0, back), D3D_OK);
    const triangle = Uint8Array.from([
        ...vertex(0, 0, argb(255, 0, 0)), ...vertex(8, 0, argb(255, 0, 0)),
        ...vertex(0, 8, argb(255, 0, 0)),
    ]);
    assert.equal(device.SetFVF(FVF_TRIANGLE), D3D_OK);
    assert.equal(device.SetTexture(0, made.texture), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    // Into the texture with it bound, then onto the back buffer reading it.
    assert.equal(device.SetRenderTarget(0, level.surface), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, triangle, TRIANGLE_STRIDE),
        D3D_OK);
    assert.equal(device.SetRenderTarget(0, back.surface), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, triangle, TRIANGLE_STRIDE),
        D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    assert.deepEqual(h.gpu.errors, [], 'the device took the frame');
    const draws = h.device.diagnostics().lastFrame
        .filter((/** @type {any} */ command)=>command.kind === 'draw');
    assert.equal(draws.length, 2);
    const snapshot = draws[0].stageBindings[0].view;
    assert.ok(!draws[0].stageBindings[0].placeholder, 'not the placeholder');
    assert.equal(snapshot.texture.descriptor.label, 'target-snapshot');
    assert.equal(draws[1].stageBindings[0].placeholder, false,
        'drawn elsewhere, the texture is sampled as bound');
    const order = h.gpu.calls.filter((/** @type {any} */ call)=>call.op === 'draw'
        || call.op === 'copyTextureToTexture');
    assert.deepEqual(order.map((/** @type {any} */ call)=>call.op),
        ['copyTextureToTexture', 'draw', 'draw'], 'copied before the draw that reads it');
    assert.equal(order[0].destination.texture, snapshot.texture);
    assert.equal(order[0].source.texture, draws[1].stageBindings[0].view.texture,
        'the copy is of the bound texture');
});
