/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { serveGraphics } from './worker.js';
import { createSender } from './channel.js';
import { recordedDirect3D } from './direct3d.js';
import { CAPTURE, ZEROED_FROM, captureRecords, createCapture } from './capture.js';
import { OP, SECTION, WAIT, createReader, createWriter } from './wire.js';
import { D3DFMT, D3DPOOL, D3DSWAPEFFECT, D3D_OK } from '../d3d9/constants.js';
import { D3DCLEAR, D3DFMT_INDEX, D3DPT, D3DRS } from '../d3d8/constants.js';
import { createDirect3D9 } from '../d3d9/device.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { FVF } from '../webgpu/internal/vertexformat.js';

/** Turns of the event loop, for what crosses ports and settles in promises. */
const settle = async(turns = 20)=>{
    for (let turn = 0; turn < turns; turn++)
    {
        await new Promise(resolve=>setImmediate(resolve));
    }
};

const RAM_BASE = 0x40000000;
/** What the program writes into its vertex buffer, beyond any chance of a match. */
const PATTERN = [0x5a, 0xc3, 0x96, 0x3c, 0xe1, 0x0f, 0x87, 0x78];

/** @param {Uint8Array} bytes @returns {boolean} */
const holdsPattern = bytes=>{
    for (let at = 0; at + PATTERN.length <= bytes.length; at++)
    {
        if (PATTERN.every((value, index)=>bytes[at + index] === value))
        {
            return true;
        }
    }
    return false;
};

/**
 * A worker over a fake GPU, as the graphics worker runs one.
 *
 * @param {boolean} capture
 */
const worker = async capture=>{
    const gpu = createFakeDevice();
    Object.assign(gpu.device, { queue: gpu.queue, features: new Set(),
        createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }) });
    /** @type {any[]} */
    const posted = [];
    /** @type {Map<string, (message: any) => void>} */
    const waiting = new Map();
    /** @type {any} */
    const scope = { postMessage: (/** @type {any} */ message)=>{
        posted.push(message);
        waiting.get(message?.type)?.(message);
    }, onmessage: null };
    /**
     * The first message of a type the worker posts from now: the capture
     * comes once its compressor has drained, however many turns that takes.
     *
     * @param {string} type @returns {Promise<any>}
     */
    const next = type=>new Promise(resolve=>waiting.set(type, resolve));
    serveGraphics(scope, {
        gpu: { requestAdapter: async()=>({ features: new Set(), info: {},
            requestDevice: async()=>gpu.device }) },
        canvas: (width, height)=>Object.assign(gpu.canvas, { width, height,
            transferToImageBitmap: ()=>({ width, height, close: ()=>{} }) }),
    });
    scope.onmessage({ data: { type: 'open', frames: 'count', capture } });
    await settle();
    return { gpu, scope, posted, next };
};

/**
 * What a GPU was asked, without the bytes a capture zeroes: the calls in
 * order, a draw with its numbers, a copy with its size.
 *
 * @param {any[]} calls
 */
const asked = calls=>calls.map(call=>[call.op,
    call.op === 'drawIndexed' || call.op === 'draw' ? call.args.join(',')
        : call.op === 'writeBuffer' ? `${call.bufferOffset}+${call.size}`
            : call.op === 'writeTexture' ? `${call.size?.width ?? call.size?.[0]}`
                : ''].join(' '));

test('a capture played again asks of the GPU what the run asked, with the program\'s bytes zeroed',
    async()=>{
        const run = await worker(true);
        const { port1, port2 } = new MessageChannel();
        run.scope.onmessage({ data: { type: 'root', api: 'd3d9', options: {}, port: port2 } });
        const sender = createSender({ post: (message, transfer)=>port1.postMessage(message,
            transfer), framesAhead: 100 });
        port1.onmessage = event=>sender.receive(event.data);
        const ram = new Uint8Array(4 << 20);
        let next = RAM_BASE + (1 << 20);
        const d3d = recordedDirect3D(createDirect3D9, {
            readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
                ram.slice(at - RAM_BASE, at - RAM_BASE + length),
            writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
                ram.set(bytes, at - RAM_BASE),
            allocate: (/** @type {number} */ bytes)=>{
                const at = next;
                next += bytes + 0x100;
                return at;
            },
        }, sender);
        /** @param {number} value */
        const ok = value=>assert.equal(value, D3D_OK);
        /** @type {{ device?: any }} */
        const out = {};
        ok(d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1,
            backBufferWidth: 16, backBufferHeight: 16, backBufferFormat: D3DFMT.X8R8G8B8 }, out));
        const device = out.device;
        const stride = 16;
        const fvf = FVF.XYZ | FVF.DIFFUSE;
        /** @type {{ buffer?: any }} */
        const vertices = {};
        /** @type {{ buffer?: any }} */
        const indices = {};
        // Larger than the pieces of guest memory a capture keeps whole.
        const count = 4096;
        ok(device.CreateVertexBuffer(count * stride, 0, fvf, D3DPOOL.MANAGED, vertices));
        ok(device.CreateIndexBuffer(12, 0, D3DFMT_INDEX.INDEX16, D3DPOOL.MANAGED, indices));
        /** @type {{ pBits?: number }} */
        const locked = {};
        ok(vertices.buffer.Lock(0, 0, locked, 0));
        const at = /** @type {number} */ (locked.pBits) - RAM_BASE;
        for (let vertex = 0; vertex < count; vertex++)
        {
            ram.set(PATTERN, at + vertex * stride);
            ram.set(PATTERN, at + vertex * stride + 8);
        }
        ok(vertices.buffer.Unlock());
        ok(indices.buffer.Lock(0, 0, locked, 0));
        new Uint16Array(ram.buffer, /** @type {number} */ (locked.pBits) - RAM_BASE, 6)
            .set([0, 1, 2, 2, 1, 3]);
        ok(indices.buffer.Unlock());
        ok(device.SetStreamSource(0, vertices.buffer, 0, stride));
        ok(device.SetIndices(indices.buffer));
        ok(device.SetFVF(fvf));
        ok(device.SetRenderState(D3DRS.LIGHTING, 0));
        const frame = async(/** @type {number} */ index)=>{
            ok(device.BeginScene());
            ok(device.Clear(0, null, D3DCLEAR.TARGET, 0xff000000 + index, 1, 0));
            ok(device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, 0, 0, 4, 0, 2));
            ok(device.EndScene());
            await device.Present();
            await device.idle();
            await settle();
        };
        /** @param {any} call */
        const vertexBytes = call=>call.op === 'writeBuffer' && holdsPattern(call.bytes);
        /** @type {string[]} */
        let ran;
        try
        {
            await frame(0);
            // The frames to measure: this one more, then the capture ends.
            run.scope.onmessage({ data: { type: 'debug', captureFrames: 1 } });
            await frame(1);
            ran = asked(run.gpu.calls);
            assert.ok(run.gpu.calls.some(vertexBytes),
                'the program\'s vertices reached the GPU of the run');
            await frame(2);
        }
        finally
        {
            port1.close();
            port2.close();
        }
        const handed = run.next('captured');
        run.scope.onmessage({ data: { type: 'debug', captured: true } });
        const captured = await handed;
        assert.ok(captured.bytes instanceof Uint8Array, 'the capture handed over');
        const bytes = gunzipSync(captured.bytes);
        assert.equal(holdsPattern(bytes), false, 'none of the program\'s bytes kept');
        const records = [];
        for await (const record of captureRecords([bytes]))
        {
            records.push(record);
        }
        const kinds = records.map(record=>record.kind);
        assert.equal(kinds[0], CAPTURE.OPEN);
        assert.equal(kinds[1], CAPTURE.ROOT);
        assert.equal(kinds.filter(kind=>kind === CAPTURE.MARK).length, 1);
        assert.equal(records.reduce((sum, record)=>sum + (record.presents ?? 0), 0), 2,
            'two presents kept: the one before the mark and the one after, not the third');

        // The capture played on a worker of its own, as tools/graphics-replay.mjs plays it.
        const again = await worker(false);
        /** @type {Map<number, MessagePort>} */
        const ports = new Map();
        /** @type {MessagePort[]} */
        const others = [];
        for (const record of records)
        {
            if (record.kind === CAPTURE.ROOT)
            {
                const channel = new MessageChannel();
                channel.port1.onmessage = ()=>{};
                others.push(channel.port1);
                again.scope.onmessage({ data: { type: 'root', api: record.json.api,
                    options: record.json.options, port: channel.port2 } });
                await settle();
                ports.set(record.root, channel.port2);
            }
            else if (record.kind === CAPTURE.CALLS)
            {
                /** @type {any} */ (ports.get(record.root)).onmessage({ data: { type: 'calls',
                    buffer: record.buffer, at: 0 } });
                await settle();
            }
        }
        for (const port of [...ports.values(), ...others])
        {
            port.close();
        }
        assert.deepEqual(asked(again.gpu.calls), ran, 'the same calls asked of the GPU');
        assert.ok(!again.gpu.calls.some(vertexBytes), 'with zeros where the program\'s bytes were');
    });

test('a capture keeps every argument whole and zeroes the guest memory a batch carries from 4 KB',
    async()=>{
        const capture = createCapture();
        const id = capture.root({ api: 'd3d9', options: {}, lending: false, memory: 0 });
        /** @param {number} length @param {number} seed */
        const filled = (length, seed)=>Uint8Array.from({ length },
            (_, index)=>((index * 7 + seed) & 0xff) | 1);
        // A frame's draws as Direct3D 9's device sends them: a ring of
        // commands, larger than any piece of memory zeroed.
        const ring = Uint32Array.from({ length: 16 << 10 },
            (_, index)=>Math.imul(index, 0x9e3779b1) | 1);
        const small = filled(ZEROED_FROM - 1, 3);
        const large = filled(ZEROED_FROM, 5);
        const written = filled(64 << 10, 9);
        const writer = createWriter();
        writer.u8(OP.CALL);
        writer.u32(1);
        writer.string('commands');
        writer.u8(1);
        writer.value(ring, ()=>undefined);
        writer.u8(SECTION.SHIP);
        writer.u32(2);
        writer.memory(0x10000, small);
        writer.memory(0x20000, large);
        writer.u8(WAIT.PACED);
        writer.u8(OP.WROTE);
        writer.u32(1);
        writer.memory(0x30000, written);
        capture.calls(id, writer.take());
        assert.equal(capture.counts().zeroed, large.length + written.length);
        const records = [];
        for await (const record of captureRecords([gunzipSync(await capture.finish())]))
        {
            records.push(record);
        }
        const batch = records.find(record=>record.kind === CAPTURE.CALLS);
        assert.equal(batch?.presents, 1);
        /** @type {import('./wire.js').ReadCall[]} */
        const calls = [];
        createReader({ ref: number=>number, service: ()=>null })
            .read(/** @type {ArrayBuffer} */ (batch?.buffer), call=>{
                calls.push(call);
            });
        assert.equal(calls.length, 2);
        assert.equal(calls[0].m, 'commands');
        assert.deepEqual(calls[0].a?.[0], ring, 'the ring of commands kept whole');
        const [kept, zeroed] = calls[0].ship ?? [];
        assert.deepEqual([kept.address, zeroed.address], [0x10000, 0x20000]);
        assert.deepEqual(kept.bytes, small, 'memory under 4 KB kept');
        assert.deepEqual(zeroed.bytes, new Uint8Array(large.length), 'memory from 4 KB zeroed');
        assert.equal(calls[1].op, OP.WROTE);
        assert.deepEqual(calls[1].wrote?.[0].bytes, new Uint8Array(written.length),
            'what a call wrote zeroed as what it shipped');
    });
