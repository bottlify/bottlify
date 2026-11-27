/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A buffer object's bytes are held once on the drawing thread: the GPU
 * backing reads them from the context's store, where it once kept a shadow of
 * its own beside it. Seeded programs of buffer writes and draws run twice -
 * over the store, and over a backing that keeps a shadow filled as the store
 * was once copied into it - and every draw must read the same bytes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { roomy } from '../../cache/testing.fixture.js';

/** @param {number} seed @returns {() => number} 0 up to 2^32 */
function random(seed){
    let state = seed >>> 0 || 1;
    return ()=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
}

/**
 * A backend whose dynamic buffers are told nothing of the caller's store:
 * each keeps its own shadow, and a lock's bytes are copied into it from the
 * store before the unlock, as the renderer once did.
 *
 * @param {any} backend
 */
function shadowed(backend){
    const wrapped = Object.create(backend);
    wrapped.createDynamicBuffer = (/** @type {any} */ descriptor)=>{
        const { source, ...rest } = descriptor;
        const buffer = backend.createDynamicBuffer(rest);
        if (source)
        {
            const unlock = buffer.unlock;
            buffer.unlock = (/** @type {any} */ lock, /** @type {any[]} */ ...more)=>{
                lock.data.set(source().subarray(lock.offset, lock.offset + lock.length));
                return unlock(lock, ...more);
            };
        }
        return buffer;
    };
    return wrapped;
}

/**
 * One run of a seeded program.
 *
 * @param {number} seed @param {boolean} reference  over a shadow, as before
 * @returns {Promise<{ reads: string[], expected: string[], dynamic: any[] }>}
 *     each draw's bytes in order, what the specification says it reads, and
 *     the dynamic buffers made
 */
async function run(seed, reference){
    const next = random(seed);
    const pick = (/** @type {number} */ n)=>next() % n;
    const fake = createFakeDevice({});
    const plain = createBackend({ scratches: roomy.api.scratch,
        device: fake.device, queue: fake.queue, presentTo: ()=>{} });
    /** @type {any[]} */
    const dynamic = [];
    const counted = Object.create(reference ? shadowed(plain) : plain);
    counted.createDynamicBuffer = (/** @type {any} */ descriptor)=>{
        const made = Object.getPrototypeOf(counted).createDynamicBuffer(descriptor);
        if (descriptor.label?.startsWith('gl-buffer'))
        {
            dynamic.push(made);
        }
        return made;
    };
    const renderer = createGpuRenderer({
        backend: counted,
        createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }),
    });
    const guest = new Uint8Array(0x40000);
    let free = 0x1000;
    const gl = /** @type {any} */ (createGlContext({ holds: roomy.api.hold, gpu: renderer, memory: {
        read: (/** @type {number} */ at, /** @type {number} */ n)=>guest.slice(at, at + n),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>guest.set(value, at),
        allocate: (/** @type {number} */ size)=>{
            const at = free;
            free += (size + 16) & ~15;
            return at;
        },
        free: ()=>{},
    } }));
    gl.attach({ width: 8, height: 8, doubleBuffered: true, depthBits: 24 });
    gl.glEnableClientState(GL.VERTEX_ARRAY);

    /** What each draw read, as the GPU holds it at the submit that runs it. @type {string[]} */
    const reads = [];
    /** What each draw reads by the specification. @type {string[]} */
    const expected = [];
    let seen = 0;
    const submit = fake.queue.submit;
    fake.queue.submit = (/** @type {any[]} */ buffers)=>{
        submit.call(fake.queue, buffers);
        /** @type {Map<any, Map<number, { buffer: any, offset: number }>>} */
        const slots = new Map();
        for (; seen < fake.calls.length; seen++)
        {
            const call = fake.calls[seen];
            if (call.op === 'setVertexBuffer')
            {
                if (!slots.has(call.pass))
                {
                    slots.set(call.pass, new Map());
                }
                slots.get(call.pass)?.set(call.slot, { buffer: call.buffer, offset: call.offset });
            }
            else if (call.op === 'draw')
            {
                const [count, , first] = call.args;
                for (const { buffer, offset } of slots.get(call.pass)?.values() ?? [])
                {
                    if (buffer.descriptor?.label?.startsWith('gl-buffer'))
                    {
                        const start = offset + first * 8;
                        reads.push(`${buffer.descriptor.label.split('#')[0]}:`
                            + [...buffer.bytes.subarray(start, start + count * 8)].join(','));
                    }
                }
            }
        }
    };

    const names = gl.glGenBuffersARB(3);
    /** @type {Map<number, number>} */
    const sizes = new Map();
    const bytes = (/** @type {number} */ n)=>Uint8Array.from({ length: n }, ()=>pick(256));
    for (const name of names)
    {
        const size = 16 + pick(300);
        gl.glBindBufferARB(GL.ARRAY_BUFFER, name);
        gl.glBufferDataARB(GL.ARRAY_BUFFER, size, bytes(size), GL.DYNAMIC_DRAW);
        sizes.set(name, size);
    }
    for (let step = 0; step < 160; step++)
    {
        const name = names[pick(names.length)];
        const size = /** @type {number} */ (sizes.get(name));
        gl.glBindBufferARB(GL.ARRAY_BUFFER, name);
        const op = pick(16);
        if (op === 0)
        {
            // Orphaned, at its size or another: larger, or smaller and
            // kept in the backing it fits.
            const resized = pick(3) === 0 ? 8 + pick(600) : size;
            gl.glBufferDataARB(GL.ARRAY_BUFFER, resized, pick(4) === 0 ? null : bytes(resized),
                GL.STREAM_DRAW);
            sizes.set(name, resized);
        }
        else if (op <= 4)
        {
            const offset = pick(size);
            const length = 1 + pick(size - offset);
            gl.glBufferSubDataARB(GL.ARRAY_BUFFER, offset, length, bytes(length));
        }
        else if (op <= 6)
        {
            const offset = pick(size);
            const length = 1 + pick(size - offset);
            const flags = GL.MAP_WRITE_BIT | [0, GL.MAP_INVALIDATE_RANGE_BIT,
                GL.MAP_UNSYNCHRONIZED_BIT][pick(3)];
            const at = gl.glMapBufferRange(GL.ARRAY_BUFFER, offset, length, flags);
            assert.notEqual(at, 0);
            guest.set(bytes(length), at);
            gl.glUnmapBufferARB(GL.ARRAY_BUFFER);
        }
        else if (op === 7)
        {
            const other = names[pick(names.length)];
            const otherSize = /** @type {number} */ (sizes.get(other));
            const length = 1 + pick(Math.min(size, otherSize));
            const from = pick(size - length + 1);
            const to = pick(otherSize - length + 1);
            if (other !== name || from + length <= to || to + length <= from)
            {
                gl.glBindBufferARB(GL.COPY_READ_BUFFER, name);
                gl.glBindBufferARB(GL.COPY_WRITE_BUFFER, other);
                gl.glCopyBufferSubData(GL.COPY_READ_BUFFER, GL.COPY_WRITE_BUFFER, from, to, length);
            }
        }
        else if (op <= 13)
        {
            // A draw of points reading [offset, offset + 8 count) of the store.
            const offset = 4 * pick(Math.floor(size / 8));
            const count = Math.floor((size - offset) / 8);
            if (count > 0)
            {
                const drawn = 1 + pick(count);
                gl.glVertexPointer(2, GL.FLOAT, 8, offset);
                gl.glDrawArrays(GL.POINTS, 0, drawn);
                // What GL says the draw reads: the store as it is now.
                expected.push(`gl-buffer:${name}:`
                    + [...gl.glGetBufferSubDataARB(GL.ARRAY_BUFFER, offset, drawn * 8)].join(','));
            }
        }
        else
        {
            // Replayed now, or later behind frames recorded after it.
            renderer.present(gl);
            if (pick(2) === 0)
            {
                await renderer.settled();
            }
        }
        assert.equal(gl.glGetError(), GL.NO_ERROR, `step ${step}`);
    }
    renderer.present(gl);
    await renderer.settled();
    return { reads, expected, dynamic };
}

test('every draw reads the store as it was at the draw, as a shadow beside it gave it', async()=>{
    let draws = 0;
    for (let seed = 1; seed <= 40; seed++)
    {
        const store = await run(seed, false);
        const shadow = await run(seed, true);
        assert.ok(store.reads.length > 0, `seed ${seed} drew`);
        assert.deepEqual(store.reads, store.expected, `seed ${seed}: as the store was`);
        assert.deepEqual(store.reads, shadow.reads, `seed ${seed}: as through a shadow`);
        draws += store.reads.length;
    }
    assert.ok(draws > 1000, `${draws} draws compared`);
});

test('a buffer object\'s backing keeps no copy of the store', async()=>{
    const store = await run(7, false);
    const shadow = await run(7, true);
    const held = (/** @type {any[]} */ made)=>made.reduce((sum, one)=>sum + one.held.shadow, 0);
    assert.ok(store.dynamic.length > 0);
    assert.equal(held(store.dynamic), 0, 'nothing beside the store');
    assert.ok(held(shadow.dynamic) > 0, 'the shadow the reference keeps');
});
