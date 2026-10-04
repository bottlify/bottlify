/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpengl } from '../opengl/exports.js';
import { GL } from '../opengl/constants.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { createReceiver, createSender } from './channel.js';
import { playedAtOnce } from './direct3d.js';
import { playedOpengl, recordedOpengl } from './opengl.js';

/** The dword a guest pushes for a GLfloat. @param {number} value */
function floatBits(value){
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    return view.getUint32(0, true);
}

/** The two dwords a guest pushes for a GLdouble, low word first. @param {number} value */
function doubleBits(value){
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return [view.getUint32(0, true), view.getUint32(4, true)];
}

/**
 * A value as the GPU was asked it, comparable across two runs: the device's
 * objects by their ids, their bytes as numbers.
 *
 * @param {any} value @param {number} [depth]
 * @returns {any}
 */
function plain(value, depth = 0){
    if (value === null || typeof value !== 'object')
    {
        return value;
    }
    if (ArrayBuffer.isView(value))
    {
        return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)].join(',');
    }
    if (typeof value.id === 'string' && typeof value.kind === 'string' && depth > 0)
    {
        return value.id;
    }
    if (depth > 6)
    {
        return '...';
    }
    if (Array.isArray(value))
    {
        return value.map(item=>plain(item, depth + 1));
    }
    /** @type {Record<string, any>} */
    const out = {};
    for (const key of Object.keys(value).sort())
    {
        if (typeof value[key] !== 'function')
        {
            out[key] = plain(value[key], depth + 1);
        }
    }
    return out;
}

/**
 * Three frames through OPENGL32's exports on a device, and every call they
 * asked of the GPU, frame by frame: two contexts sharing their objects, a
 * texture from guest memory and redefined in part between frames, a buffer
 * object from guest memory and one written through its mapping, client
 * arrays the program rewrites between frames, client indices, and a
 * primitive in immediate mode.
 *
 * @param {(factory: any, services: any) => any} [remote]
 */
async function framesThrough(remote){
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    const bytes = new Uint8Array(0x40000);
    const view = new DataView(bytes.buffer);
    let next = 0x20000;
    /** Every swap's replay, as the renderer queued it. @type {PromiseLike<unknown>[]} */
    const queued = [];
    const opengl = createOpengl({
        readMemory: (at, length)=>bytes.subarray(at, at + length),
        windowMemory: (at, length)=>bytes.subarray(at, at + length),
        writeMemory: (at, value)=>bytes.set(value, at),
        scratch: { allocate: size=>{
            const at = next;
            next += size + 15 & ~15;
            return at;
        } },
        screen: ()=>({ width: 16, height: 16 }),
        present: ()=>{},
        presenter: ()=>({ claim: ()=>{} }),
        backend: ()=>backend,
        createSampler: descriptor=>({ kind: 'sampler',
            id: `sampler-${JSON.stringify(descriptor)}`, descriptor }),
        frameQueued: settled=>{
            if (settled)
            {
                queued.push(settled);
            }
            return null;
        },
        remote,
    });
    const table = /** @type {Record<string, { handler: (args: number[]) => any }>} */ (
        opengl.table);
    /** @param {string} name @param {number[]} args */
    const gl = (name, ...args)=>table[name].handler(args);

    const contexts = [0x900d, 0x900e].map(hdc=>{
        assert.equal(gl('wglSetPixelFormat', hdc, 1, 0), 1);
        const context = gl('wglCreateContext', hdc);
        assert.notEqual(context, 0);
        return { hdc, context };
    });
    assert.equal(gl('wglShareLists', contexts[0].context, contexts[1].context), 1);
    const [first, second] = contexts;
    assert.equal(gl('wglMakeCurrent', first.hdc, first.context), 1);
    /** @param {number} size */
    const ortho = size=>{
        gl('glMatrixMode', GL.PROJECTION);
        gl('glLoadIdentity');
        const [zl, zh] = doubleBits(0);
        const [sl, sh] = doubleBits(size);
        const [nl, nh] = doubleBits(-1);
        const [fl, fh] = doubleBits(1);
        gl('glOrtho', zl, zh, sl, sh, zl, zh, sl, sh, nl, nh, fl, fh);
        gl('glMatrixMode', GL.MODELVIEW);
        gl('glLoadIdentity');
    };
    ortho(16);

    for (let i = 0; i < 64; i++)
    {
        bytes[0x1000 + i] = i * 4;
    }
    gl('glGenTextures', 1, 0x3000);
    const texture = view.getUint32(0x3000, true);
    gl('glBindTexture', GL.TEXTURE_2D, texture);
    gl('glTexParameteri', GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    gl('glTexImage2D', GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE, 0x1000);

    [0, 0, 8, 0, 0, 8, 8, 8].forEach((value, i)=>view.setFloat32(0x1100 + i * 4, value, true));
    gl('glGenBuffersARB', 2, 0x3000);
    const vertices = view.getUint32(0x3000, true);
    const colours = view.getUint32(0x3004, true);
    gl('glBindBufferARB', GL.ARRAY_BUFFER, vertices);
    gl('glBufferDataARB', GL.ARRAY_BUFFER, 32, 0x1100, GL.STATIC_DRAW);
    gl('glBindBufferARB', GL.ARRAY_BUFFER, colours);
    gl('glBufferDataARB', GL.ARRAY_BUFFER, 16, 0, GL.DYNAMIC_DRAW);
    const mapped = gl('glMapBufferARB', GL.ARRAY_BUFFER, GL.WRITE_ONLY);
    assert.notEqual(mapped, 0);
    bytes.set([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255], mapped);
    assert.equal(gl('glUnmapBufferARB', GL.ARRAY_BUFFER), 1);
    gl('glBindBufferARB', GL.ARRAY_BUFFER, 0);
    [0, 1, 2, 2, 1, 3].forEach((index, i)=>view.setUint32(0x1200 + i * 4, index, true));

    /** @type {string[]} */
    const frames = [];
    for (let frame = 0; frame < 3; frame++)
    {
        const current = frame === 1 ? second : first;
        assert.equal(gl('wglMakeCurrent', current.hdc, current.context), 1);
        if (frame === 1)
        {
            ortho(16);
        }
        gl('glClearColor', floatBits(frame / 4), floatBits(0), floatBits(0), floatBits(1));
        gl('glClear', GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT);

        // Client arrays the program rewrote since the last frame.
        [0, 0, 4 + frame, 0, 0, 4 + frame].forEach((value, i)=>
            view.setFloat32(0x1400 + i * 4, value, true));
        [0, 0, 1, 0, 0, 1].forEach((value, i)=>view.setFloat32(0x1500 + i * 4, value, true));
        gl('glEnable', GL.TEXTURE_2D);
        gl('glBindTexture', GL.TEXTURE_2D, texture);
        gl('glEnableClientState', GL.VERTEX_ARRAY);
        gl('glEnableClientState', GL.TEXTURE_COORD_ARRAY);
        gl('glVertexPointer', 2, GL.FLOAT, 0, 0x1400);
        gl('glTexCoordPointer', 2, GL.FLOAT, 0, 0x1500);
        gl('glDrawArrays', GL.TRIANGLES, 0, 3);
        gl('glDisableClientState', GL.TEXTURE_COORD_ARRAY);
        gl('glDisable', GL.TEXTURE_2D);

        // A buffer object's vertices and colours, through client indices.
        gl('glEnableClientState', GL.COLOR_ARRAY);
        gl('glBindBufferARB', GL.ARRAY_BUFFER, vertices);
        gl('glVertexPointer', 2, GL.FLOAT, 0, 0);
        gl('glBindBufferARB', GL.ARRAY_BUFFER, colours);
        gl('glColorPointer', 4, GL.UNSIGNED_BYTE, 0, 0);
        gl('glBindBufferARB', GL.ARRAY_BUFFER, 0);
        gl('glDrawElements', GL.TRIANGLES, 6, GL.UNSIGNED_INT, 0x1200);
        gl('glDisableClientState', GL.COLOR_ARRAY);
        gl('glDisableClientState', GL.VERTEX_ARRAY);

        gl('glBegin', GL.TRIANGLES);
        gl('glColor3f', floatBits(0), floatBits(0), floatBits(1));
        gl('glVertex2f', floatBits(8), floatBits(8));
        gl('glVertex2f', floatBits(16), floatBits(8));
        gl('glVertex2f', floatBits(8), floatBits(16));
        gl('glEnd');

        await gl('wglSwapBuffers', current.hdc);
        // A renderer elsewhere queues the frame once the swap reaches it.
        while (queued.length <= frame)
        {
            await new Promise(resolve=>setTimeout(resolve, 0));
        }
        await queued[frame];
        frames.push(JSON.stringify(plain(gpu.calls)));
        gpu.reset();

        bytes.fill(0xc0 + frame, 0x1000, 0x1010);
        gl('glBindTexture', GL.TEXTURE_2D, texture);
        gl('glTexSubImage2D', GL.TEXTURE_2D, 0, 0, 0, 2, 2, GL.RGBA, GL.UNSIGNED_BYTE, 0x1000);
    }
    assert.equal(gl('wglMakeCurrent', 0, 0), 1);
    return { frames, opengl };
}

/**
 * A recorded OpenGL root whose every call is played at once on its twin.
 *
 * @param {any} factory @param {any} services
 */
const loopback = (factory, services)=>recordedOpengl(factory, services,
    playedAtOnce(/** @type {any} */ (playedOpengl(factory, services))));

test('OpenGL frames played from a record ask of the GPU what the contexts themselves asked',
    async()=>{
        const direct = await framesThrough();
        const played = await framesThrough(loopback);
        assert.equal(played.frames.length, direct.frames.length);
        assert.ok(direct.frames.every(frame=>frame.includes('drawIndexed')),
            'every frame drew');
        played.frames.forEach((frame, index)=>assert.ok(frame === direct.frames[index],
            `frame ${index} asked the same`));
    });

test('a recorded context answers the program as a context on a device does', async()=>{
    const { opengl } = await framesThrough(loopback);
    const table = /** @type {Record<string, { handler: (args: number[]) => any }>} */ (
        opengl.table);
    assert.equal(table.wglMakeCurrent.handler([0x900d, 0x0e000000]), 1);
    assert.equal(table.glGetError.handler([]), GL.NO_ERROR);
    assert.equal(opengl.diagnostics().contexts, 2);
});

/**
 * A recorded OpenGL root whose calls cross a port to their played twin, as
 * they cross to the graphics worker.
 *
 * @param {any} factory @param {any} services
 */
const acrossAPort = (factory, services)=>{
    const { port1, port2 } = new MessageChannel();
    const played = playedOpengl(factory, services);
    const receiver = createReceiver({ played: /** @type {any} */ (played),
        post: (message, transfer)=>port2.postMessage(message, transfer ?? []) });
    port2.onmessage = event=>receiver.receive(event.data);
    const sender = createSender({
        post: (message, transfer)=>port1.postMessage(message, transfer),
    });
    port1.onmessage = event=>sender.receive(event.data);
    ports.push(port1, port2);
    return recordedOpengl(factory, services, sender);
};
/** @type {MessagePort[]} */
const ports = [];

test('OpenGL frames whose calls cross a port draw as the contexts themselves drew, and the '
    + 'renderer\'s account of them comes back', async()=>{
    try
    {
        const direct = await framesThrough();
        const played = await framesThrough(acrossAPort);
        played.frames.forEach((frame, index)=>assert.ok(frame === direct.frames[index],
            `frame ${index} asked the same`));
        // The account is the one the played renderer gave when last asked:
        // it comes back once the question has crossed the port and the answer
        // crossed back, however long a loaded machine takes to carry them.
        let account = played.opengl.diagnostics();
        for (let turn = 0; turn < 500 && account.gpu?.frames !== 3; turn++)
        {
            await new Promise(resolve=>setTimeout(resolve, 2));
            account = played.opengl.diagnostics();
        }
        assert.equal(account.gpu?.frames, 3);
    }
    finally
    {
        for (const port of ports.splice(0))
        {
            port.close();
        }
    }
});
