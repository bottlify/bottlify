/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Frames through the whole seam, as a gate: whatever a program does in a
 * frame, the GPU is given what it would be given with every call a trap.
 *
 * The program runs on two machines side by side -- the real processor, the
 * bridge's tables and the seam's own handlers, one with the guest code off
 * and one with it on, each device drawing through a backend over a recording
 * GPU -- and is drawn from a seed out of what a frame of a real program is
 * made of, so that every part of the guest code is in it at once: buffer
 * locks of every kind (locks), texture uploads through the texture and
 * through its level (levels), references taken and given back (counts),
 * bindings, states, transforms and draws in the command ring (ring), and the
 * state read back (getters). Two vertex buffers of different formats are
 * switched between, an index buffer is read from a base vertex, and runs of
 * the ring are as long as a frame makes them.
 *
 * What is compared: every call's answer and what a getter wrote; and every
 * draw the GPU is given, as it would read it -- the indices, the vertices
 * they name in every buffer bound, the bytes of the uniform ranges bound and
 * the texels of the textures bound -- taken at each submit in queue order.
 * The guest code must have taken each part of the program in the guest, or
 * the gate would compare nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    D3D8, D3D9, HWND, SOFTWARE_VERTEXPROCESSING, machine, random,
} from './guest-machine.itest.js';

/** @typedef {import('./guest-machine.itest.js').Version} Version */
/** @typedef {import('./guest-machine.itest.js').Call} Call */

const D3DUSAGE_WRITEONLY = 0x8;
const D3DUSAGE_DYNAMIC = 0x200;
const D3DPOOL_DEFAULT = 0;
const D3DPOOL_MANAGED = 1;
const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_INDEX16 = 101;
const D3DLOCK_READONLY = 0x10;
const D3DLOCK_NOOVERWRITE = 0x1000;
const D3DLOCK_DISCARD = 0x2000;
const D3DPT_TRIANGLELIST = 4;
const D3DPT_TRIANGLESTRIP = 5;
const D3DPT_TRIANGLEFAN = 6;
/** The vertices a draw of each type reads for its triangles. */
const VERTICES_FOR = /** @type {Record<number, (triangles: number) => number>} */ ({
    [D3DPT_TRIANGLELIST]: triangles=>triangles * 3,
    [D3DPT_TRIANGLESTRIP]: triangles=>triangles + 2,
    [D3DPT_TRIANGLEFAN]: triangles=>triangles + 2,
});
const D3DTS_WORLD = 256;
const D3DRS_LIGHTING = 137;
const D3DRS_TEXTUREFACTOR = 60;
const D3DPOOL_SYSTEMMEM = 2;
const D3DSBT_ALL = 1;
const D3DCLEAR_TARGET = 1;
const ONE = 0x3f800000;
/** Where the program keeps the indices it draws from its own memory. */
const USER_INDICES = 0x20400;
/** Where the out-parameters are written (`guest-machine`). */
const OUT = 0x10000;
/** Where the program keeps the vertices it draws from its own memory. */
const USER = 0x20000;

/** The two vertex formats: position and colour, and position, colour and a texel. */
const FORMATS = /** @type {const} */ ([
    { fvf: 0x042, stride: 16 },
    { fvf: 0x142, stride: 24 },
]);
const VERTICES = 72;
/** The indices reach this far past the base, which goes up to the rest. */
const REACH = 64;
const BASES = VERTICES - REACH;
const INDICES = 96;
const INDEX_BYTES = INDICES * 2;
const TEXELS = 8;

const DEVICE = '#1';
/** The program's names for what it makes, in the order it makes them. */
const STREAMS = ['#2', '#3'];
const IB = '#4';
const TEXTURES = ['#5', '#6'];
/** A system-memory texture the program fills, and one in the default pool it copies it to. */
const SOURCE = '#7';
const COPY = '#8';
/** What a draw may sample: the textures it fills, and the one it copies into. */
const SAMPLED = [...TEXTURES, COPY];

/** @param {string} on */
const kindOf = on=>(on === IB ? 'indices' : STREAMS.includes(on) ? 'vertices' : 'texture');
/** @param {string} on */
const bytesOfBuffer = on=>(on === IB ? INDEX_BYTES
    : VERTICES * FORMATS[STREAMS.indexOf(on)].stride);

/**
 * What one version names differently.
 *
 * @param {Version} version
 */
const callsOf = version=>{
    const nine = version === D3D9;
    /** @param {string} method @param {any[]} args @returns {Call} */
    const device = (method, args = [])=>({ on: DEVICE, kind: 'device', method, args });
    const tail = nine ? [0] : [];
    return {
        nine,
        make: [
            /** @type {Call} */ ({ on: '#0', kind: 'root', method: 'CreateDevice',
                args: [0, 1, HWND, SOFTWARE_VERTEXPROCESSING,
                    { words: version.presentParameters }, 'out'] }),
            ...FORMATS.map(({ fvf, stride })=>device('CreateVertexBuffer', [VERTICES * stride,
                D3DUSAGE_DYNAMIC | D3DUSAGE_WRITEONLY, fvf, D3DPOOL_DEFAULT, 'out', ...tail])),
            device('CreateIndexBuffer', [INDEX_BYTES, D3DUSAGE_DYNAMIC | D3DUSAGE_WRITEONLY,
                D3DFMT_INDEX16, D3DPOOL_DEFAULT, 'out', ...tail]),
            ...[...TEXTURES.map(()=>D3DPOOL_MANAGED), D3DPOOL_SYSTEMMEM, D3DPOOL_DEFAULT]
                .map(pool=>device('CreateTexture', [TEXELS, TEXELS, 1, 0, D3DFMT_A8R8G8B8, pool,
                    'out', ...tail])),
            device('SetRenderState', [D3DRS_LIGHTING, 0]),
        ],
        device,
        /** @param {number} which */
        stream: which=>[
            device(nine ? 'SetFVF' : 'SetVertexShader', [FORMATS[which].fvf]),
            device('SetStreamSource', nine ? [0, STREAMS[which], 0, FORMATS[which].stride]
                : [0, STREAMS[which], FORMATS[which].stride]),
        ],
        /** @param {number} base */
        indices: base=>device('SetIndices', nine ? [IB] : [IB, base]),
        /**
         * @param {number} type @param {number} base @param {number} start
         * @param {number} triangles
         */
        indexed: (type, base, start, triangles)=>device('DrawIndexedPrimitive', nine
            ? [type, base, 0, REACH, start, triangles]
            : [type, 0, REACH, start, triangles]),
        /** @param {string} on @param {number} offset @param {number} size @param {number} flags */
        lock: (on, offset, size, flags)=>/** @type {Call} */ ({ on, kind: kindOf(on),
            method: 'Lock', args: [offset, size, 'out', flags] }),
        /** @param {string} on */
        unlock: on=>/** @type {Call} */ ({ on, kind: kindOf(on), method: 'Unlock', args: [] }),
        present: device('Present', [0, 0, 0, 0]),
        /** Whether a draw from user memory unbinds the stream and the indices. */
        upUnbinds: !nine,
    };
};

/**
 * What each draw the GPU is given reads, as it would read it: at each submit,
 * the buffers as the queue's writes left them, the copies and the passes
 * encoded since the last one made in order, and every draw's indices, the
 * vertices they name in every buffer bound by the strides its pipeline gives,
 * the uniform ranges bound and -- once the submit has made its copies -- the
 * texels of the textures bound.
 *
 * @param {any} gpu  a recording GPU (`createFakeDevice`)
 * @returns {string[]}
 */
function gpuReads(gpu){
    /** @type {string[]} */
    const reads = [];
    /** @type {Map<any, any>} */
    const pipelines = new Map();
    let from = 0;
    const submit = gpu.queue.submit.bind(gpu.queue);
    gpu.queue.submit = (/** @type {any[]} */ buffers)=>{
        /** @type {Map<any, Uint8Array>} */
        const held = new Map();
        /** @param {any} buffer @returns {Uint8Array} */
        const bytesOf = buffer=>{
            let bytes = held.get(buffer);
            if (!bytes)
            {
                bytes = /** @type {Uint8Array} */ (buffer.bytes.slice());
                held.set(buffer, bytes);
            }
            return bytes;
        };
        /** @type {any} */
        let pipeline = null;
        /** @type {any[]} */
        const vertexBuffers = [];
        /** @type {any} */
        let indexBuffer = null;
        /** @type {Map<number, { uniforms: string, textures: any[] }>} */
        const groups = new Map();
        /** The draws of this submit, their texels read once its copies are made. */
        /** @type {{ line: string, textures: any[] }[]} */
        const drawn = [];
        /**
         * @param {any} layout @param {number} slot @param {number} vertex
         * @returns {string} the vertex's bytes in the buffer bound there
         */
        const vertexIn = (layout, slot, vertex)=>{
            const bound = vertexBuffers[slot];
            if (!layout || !bound)
            {
                return '-';
            }
            const at = bound.offset + vertex * layout.arrayStride;
            return [...bytesOf(bound.buffer).subarray(at, at + layout.arrayStride)].join('.');
        };
        /** One vertex out of every buffer the pipeline reads. @param {number} vertex */
        const vertexAt = vertex=>(pipeline?.vertex?.buffers ?? [])
            .map((/** @type {any} */ layout, /** @type {number} */ slot)=>vertexIn(layout, slot,
                vertex)).join('|');
        /** @param {string} line */
        const draw = line=>{
            const bound = [...groups.entries()].sort(([a], [b])=>a - b);
            drawn.push({
                line: `${line} uniforms ${bound.map(([, group])=>group.uniforms).join('/')}`,
                textures: bound.flatMap(([, group])=>group.textures),
            });
        };
        const calls = gpu.calls;
        for (let i = from; i < calls.length; i++)
        {
            const call = calls[i];
            if (call.op === 'beginRenderPass')
            {
                const clears = (call.descriptor.colorAttachments ?? [])
                    .filter((/** @type {any} */ each)=>each?.loadOp === 'clear')
                    .map((/** @type {any} */ each)=>JSON.stringify(each.clearValue));
                if (clears.length > 0)
                {
                    drawn.push({ line: `clear ${clears.join(',')}`, textures: [] });
                }
            }
            else if (call.op === 'createRenderPipeline')
            {
                pipelines.set(call.createRenderPipeline, call.descriptor);
            }
            else if (call.op === 'copyBufferToBuffer')
            {
                bytesOf(call.destination).set(bytesOf(call.source).subarray(call.sourceOffset,
                    call.sourceOffset + call.size), call.destinationOffset);
            }
            else if (call.op === 'setPipeline')
            {
                pipeline = pipelines.get(call.pipeline) ?? null;
            }
            else if (call.op === 'setVertexBuffer')
            {
                vertexBuffers[call.slot] = call;
            }
            else if (call.op === 'setIndexBuffer')
            {
                indexBuffer = call;
            }
            else if (call.op === 'setBindGroup')
            {
                groups.set(call.index, {
                    uniforms: call.resolved.map((/** @type {any} */ range)=>createHash('sha1')
                        .update(bytesOf(range.buffer).subarray(range.offset,
                            range.offset + range.size)).digest('hex').slice(0, 12)).join(','),
                    textures: (call.group?.entries ?? [])
                        .map((/** @type {any} */ entry)=>entry.resource?.texture)
                        .filter((/** @type {any} */ texture)=>texture?.bytes),
                });
            }
            else if (call.op === 'draw')
            {
                const [count, , first = 0] = call.args;
                draw(`draw ${Array.from({ length: count }, (unused, k)=>vertexAt(first + k))
                    .join(' ')}`);
            }
            else if (call.op === 'drawIndexed')
            {
                const [count, , first = 0, base = 0] = call.args;
                const size = indexBuffer.format === 'uint32' ? 4 : 2;
                const bytes = bytesOf(indexBuffer.buffer);
                const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
                const order = Array.from({ length: count }, (unused, k)=>{
                    const at = indexBuffer.offset + (first + k) * size;
                    return size === 4 ? view.getUint32(at, true) : view.getUint16(at, true);
                });
                draw(`drawIndexed ${order.map(index=>`${index}:${vertexAt(base + index)}`)
                    .join(' ')}`);
            }
        }
        from = calls.length;
        const made = submit(buffers);
        for (const { line, textures } of drawn)
        {
            reads.push(`${line} texels ${textures.map(texture=>createHash('sha1')
                .update(texture.bytes).digest('hex').slice(0, 12)).join(',')}`);
        }
        return made;
    };
    return reads;
}

/**
 * Until the renderer has nothing left to hand the GPU: its frames are replayed
 * on a chain of its own, and its shaders compiled, after the calls that made
 * them return.
 *
 * @param {any} gpu
 */
async function idle(gpu){
    let quiet = 0;
    let seen = -1;
    while (quiet < 4)
    {
        await new Promise(resolve=>setImmediate(resolve));
        quiet = gpu.calls.length === seen ? quiet + 1 : 0;
        seen = gpu.calls.length;
    }
}

/**
 * The program's writes into what a lock handed back: each byte a function of
 * the fill and its place, so a stale byte differs; an index buffer's indices
 * stay within the vertices a base leaves.
 *
 * @param {boolean} indices @param {number} length @param {number} fill
 */
const bytesFor = (indices, length, fill)=>(indices
    ? new Uint8Array(Uint16Array.from({ length: length / 2 },
        (unused, i)=>(fill + i * 7) % REACH).buffer)
    : Uint8Array.from({ length }, (unused, i)=>(fill + i * 13) & 0xff));

/**
 * @typedef {{ kind: 'lock', on: string, offset: number, size: number, flags: number,
 *     fill: number, twice: boolean, between: string | null }
 *     | { kind: 'texels', on: string, through: 'texture' | 'level', fill: number }
 *     | { kind: 'texture', on: string | null }
 *     | { kind: 'stream', which: number }
 *     | { kind: 'indices', base: number }
 *     | { kind: 'draw', type: number, start: number, triangles: number }
 *     | { kind: 'indexed', type: number, start: number, triangles: number, base: number }
 *     | { kind: 'user' }
 *     | { kind: 'world', seed: number } | { kind: 'factor', value: number }
 *     | { kind: 'reference', on: string }
 *     | { kind: 'copy', through: 'texture' | 'surface' }
 *     | { kind: 'record', texture: string | null, seed: number }
 *     | { kind: 'capture' } | { kind: 'apply', block: number }
 *     | { kind: 'recapture', block: number }
 *     | { kind: 'clear', color: number, viewport: number[] | null }
 *     | { kind: 'indexedUser' }
 *     | { kind: 'present' }} Step
 */

/**
 * A program that keeps the promises a lock's flags make: a NOOVERWRITE lock
 * writes nothing a draw since the buffer's last lock without it read, and a
 * draw reads only what was written since that buffer's last DISCARD.
 *
 * @param {number} seed @param {number} steps  how many @param {boolean} upUnbinds
 * @returns {Step[]}
 */
function generate(seed, steps, upUnbinds){
    const { below, pick } = random(seed);
    /** @type {Record<string, { read: Uint8Array, defined: Uint8Array, unit: number }>} */
    const book = Object.fromEntries([...STREAMS, IB].map(on=>[on, {
        read: new Uint8Array(bytesOfBuffer(on)), defined: new Uint8Array(bytesOfBuffer(on)),
        unit: on === IB ? 2 : FORMATS[STREAMS.indexOf(on)].stride }]));
    /** @type {Step[]} */
    const program = [];
    let stream = 0;
    let base = 0;
    let bound = true;
    /**
     * The state blocks made so far, by the order they were made in: what one
     * of everything holds of the stream and its base, none for one recorded.
     *
     * @type {({ stream: number, base: number, bound: boolean } | null)[]}
     */
    const blocks = [];
    while (program.length < steps)
    {
        const roll = below(52);
        if (roll < 12)
        {
            const on = pick([...STREAMS, IB]);
            const entry = book[on];
            const length = entry.read.length;
            const flags = pick([0, D3DLOCK_DISCARD, D3DLOCK_NOOVERWRITE, D3DLOCK_NOOVERWRITE,
                D3DLOCK_DISCARD | D3DLOCK_NOOVERWRITE, D3DLOCK_READONLY]);
            const units = length / entry.unit;
            const first = (flags & D3DLOCK_DISCARD) !== 0 ? 0 : below(units);
            const whole = below(4) === 0 || (flags & D3DLOCK_DISCARD) !== 0;
            const span = whole ? units - first : 1 + below(Math.min(24, units - first));
            const offset = first * entry.unit;
            const bytes = span * entry.unit;
            if (flags === D3DLOCK_NOOVERWRITE
                && entry.read.subarray(offset, offset + bytes).includes(1))
            {
                continue;
            }
            if (flags !== D3DLOCK_READONLY)
            {
                if (flags !== D3DLOCK_NOOVERWRITE)
                {
                    entry.read = new Uint8Array(length);
                }
                if ((flags & D3DLOCK_DISCARD) !== 0)
                {
                    entry.defined = new Uint8Array(length);
                }
                entry.defined.fill(1, offset, offset + bytes);
            }
            // Now and then another call reaches the host while the lock is
            // held and half written -- the program's own, or another thread's
            // loading a texture.
            program.push({ kind: 'lock', on, offset, size: whole && below(2) === 0 ? 0 : bytes,
                flags, fill: 1 + below(250), twice: below(8) === 0,
                between: below(4) === 0 ? pick(TEXTURES) : null });
        }
        else if (roll < 14)
        {
            program.push({ kind: 'texels', on: pick(TEXTURES), through: pick(['texture', 'level']),
                fill: below(256) });
        }
        else if (roll < 16)
        {
            program.push({ kind: 'texture', on: pick([...SAMPLED, null]) });
        }
        else if (roll < 18)
        {
            stream = below(STREAMS.length);
            program.push({ kind: 'stream', which: stream });
            bound = true;
        }
        else if (roll < 19 && !upUnbinds)
        {
            base = below(BASES + 1);
        }
        else if (roll < 20)
        {
            base = below(BASES + 1);
            program.push({ kind: 'indices', base });
        }
        else if (roll < 25 && bound)
        {
            const on = STREAMS[stream];
            const unit = book[on].unit;
            const type = pick([D3DPT_TRIANGLELIST, D3DPT_TRIANGLESTRIP, D3DPT_TRIANGLEFAN]);
            const triangles = 1 + below(4);
            const count = VERTICES_FOR[type](triangles);
            const start = below(VERTICES - count + 1);
            const range = [start * unit, (start + count) * unit];
            if (book[on].defined.subarray(...range).includes(0))
            {
                continue;
            }
            book[on].read.fill(1, ...range);
            program.push({ kind: 'draw', type, start, triangles });
        }
        else if (roll < 31 && bound)
        {
            const on = STREAMS[stream];
            const unit = book[on].unit;
            const type = pick([D3DPT_TRIANGLELIST, D3DPT_TRIANGLESTRIP, D3DPT_TRIANGLEFAN]);
            const triangles = 1 + below(4);
            const count = VERTICES_FOR[type](triangles);
            const start = below(INDICES - count + 1);
            const range = [start * 2, (start + count) * 2];
            const reach = [base * unit, (base + REACH) * unit];
            if (book[IB].defined.subarray(...range).includes(0)
                || book[on].defined.subarray(...reach).includes(0))
            {
                continue;
            }
            book[IB].read.fill(1, ...range);
            book[on].read.fill(1, ...reach);
            program.push({ kind: 'indexed', type, start, triangles, base });
        }
        else if (roll < 32)
        {
            program.push({ kind: 'user' });
            bound = !upUnbinds;
        }
        else if (roll < 34)
        {
            program.push({ kind: 'world', seed: below(1000) });
        }
        else if (roll < 36)
        {
            program.push({ kind: 'factor', value: below(0x1000000) });
        }
        else if (roll < 38)
        {
            program.push({ kind: 'reference', on: pick([...STREAMS, IB, ...SAMPLED, SOURCE]) });
        }
        else if (roll < 40)
        {
            program.push({ kind: 'texels', on: SOURCE, through: 'texture', fill: below(256) });
            program.push({ kind: 'copy', through: pick(['texture', 'surface']) });
        }
        else if (roll < 42)
        {
            blocks.push(null);
            program.push({ kind: 'record', texture: pick([...SAMPLED, null]), seed: below(1000) });
        }
        else if (roll < 43)
        {
            blocks.push({ stream, base, bound });
            program.push({ kind: 'capture' });
        }
        else if (roll < 45 && blocks.length > 0)
        {
            const block = below(blocks.length);
            const held = blocks[block];
            if (held)
            {
                ({ stream, base, bound } = held);
            }
            program.push({ kind: 'apply', block });
        }
        else if (roll < 46 && blocks.length > 0)
        {
            const block = below(blocks.length);
            if (blocks[block])
            {
                blocks[block] = { stream, base, bound };
            }
            program.push({ kind: 'recapture', block });
        }
        else if (roll < 48)
        {
            program.push({ kind: 'clear', color: below(0x1000000) | 0xff000000,
                viewport: below(2) === 0 ? null : [below(16), below(16), 8 + below(32),
                    8 + below(32)] });
        }
        else if (roll < 49)
        {
            program.push({ kind: 'indexedUser' });
            bound = !upUnbinds;
        }
        else
        {
            program.push({ kind: 'present' });
        }
    }
    return program;
}

/**
 * The program run on one machine: its answers, what it read back, what the
 * GPU was given, and which calls the guest code took.
 *
 * @param {Version} version @param {boolean} guestCode @param {Step[]} steps
 * @param {boolean} [worker]  whether the device records for a twin that draws, as in a
 *     graphics worker
 */
async function play(version, guestCode, steps, worker = false){
    const calls = callsOf(version);
    const m = machine(version, guestCode, { gpu: true, worker });
    const gpu = gpuReads(m.gpu);
    /** @type {string[]} */
    const answers = [];
    /** @type {Map<string, number>} */
    const inGuest = new Map();
    /** @param {Call} call @param {number} [readBack]  bytes of an answer to keep */
    const run = (call, readBack = 0)=>{
        const answer = m.run(call);
        const back = readBack > 0 ? [...m.memory.readBytes(OUT, readBack)].join(',') : '';
        answers.push(`${call.method} ${answer.eax.toString(16)} ${back}`);
        if (answer.traps.length === 0)
        {
            inGuest.set(call.method, (inGuest.get(call.method) ?? 0) + 1);
        }
        return answer;
    };
    /** Writes through what a lock handed back. @param {number} at @param {Uint8Array} bytes */
    const write = (at, bytes)=>m.memory.writeBytes(at, bytes);
    /** @param {string} on @param {'texture' | 'level'} through @param {number} fill */
    const texels = (on, through, fill)=>{
        const bytes = Uint8Array.from({ length: TEXELS * TEXELS * 4 },
            (unused, i)=>(fill + i * 5) & 0xff);
        if (through === 'texture')
        {
            if (run({ on, kind: 'texture', method: 'LockRect', args: [0, 'out', 0, 0] }).eax
                === 0)
            {
                write(m.memory.readU32(OUT + 4), bytes);
            }
            run({ on, kind: 'texture', method: 'UnlockRect', args: [0] });
            return;
        }
        const level = run({ on, kind: 'texture', method: 'GetSurfaceLevel', args: [0, 'out'] });
        const surface = /** @type {string} */ (level.out);
        if (run({ on: surface, kind: 'level', method: 'LockRect', args: ['out', 0, 0] }).eax
            === 0)
        {
            write(m.memory.readU32(OUT + 4), bytes);
        }
        run({ on: surface, kind: 'level', method: 'UnlockRect', args: [] });
        run({ on: surface, kind: 'level', method: 'Release', args: [] });
    };
    /** @param {string} on @param {number} seed */
    const fill = (on, seed)=>{
        const length = bytesOfBuffer(on);
        if (run(calls.lock(on, 0, 0, D3DLOCK_DISCARD)).eax === 0)
        {
            write(m.memory.readU32(OUT), bytesFor(on === IB, length, seed));
        }
        run(calls.unlock(on));
    };

    /** @param {string} on @returns {string} a level's surface, to be released */
    const levelOf = on=>/** @type {string} */ (run({ on, kind: 'texture',
        method: 'GetSurfaceLevel', args: [0, 'out'] }).out);
    /** @param {string} surface */
    const release = surface=>run({ on: surface, kind: 'level', method: 'Release', args: [] });
    /** @param {'texture' | 'surface'} through */
    const copy = through=>{
        if (through === 'texture')
        {
            run(calls.device('UpdateTexture', [SOURCE, COPY]));
            return;
        }
        const from = levelOf(SOURCE);
        const to = levelOf(COPY);
        run(calls.nine ? calls.device('UpdateSurface', [from, 0, to, 0])
            : calls.device('CopyRects', [from, 0, 0, to, 0]));
        release(to);
        release(from);
    };
    /** The state blocks made, as the program holds each: a pointer, or a token. */
    /** @type {(string | number)[]} */
    const blocks = [];
    /** What each block made of everything holds of the stream, as `generate` tracks it. */
    /** @type {(number | null)[]} */
    const blockStreams = [];
    /** @param {string} method @param {any[]} args */
    const makeBlock = (method, args)=>{
        const answer = run(calls.device(method, args));
        blocks.push(calls.nine ? /** @type {string} */ (answer.out) : m.memory.readU32(OUT));
    };
    /** @param {number} block @param {'Apply' | 'Capture'} what */
    const onBlock = (block, what)=>{
        const held = blocks[block];
        run(typeof held === 'string'
            ? { on: held, kind: 'block', method: what, args: [] }
            : calls.device(`${what}StateBlock`, [held]));
    };

    for (const call of calls.make)
    {
        run(call);
    }
    m.memory.writeBytes(USER, bytesFor(false, 3 * FORMATS[0].stride, 99));
    m.memory.writeBytes(USER_INDICES, new Uint8Array(new Uint16Array([0, 1, 2]).buffer));
    // A frame of every kind of draw, from either buffer, with a texture and
    // without, and time for the shaders it needs to be compiled: a draw whose
    // pipeline is not ready yet is left out of its frame, and the two
    // machines would leave out different ones.
    [...STREAMS, IB].forEach((on, i)=>fill(on, 1 + i));
    [...TEXTURES, SOURCE].forEach((on, i)=>texels(on, 'texture', 7 + i));
    copy('texture');
    for (let pass = 0; pass < 2; pass++)
    {
        run(calls.device('BeginScene'));
        for (const texture of [TEXTURES[0], 0])
        {
            run(calls.device('SetTexture', [0, texture]));
            for (let which = 0; which < STREAMS.length; which++)
            {
                calls.stream(which).forEach(call=>run(call));
                run(calls.indices(0));
                for (const type of [D3DPT_TRIANGLELIST, D3DPT_TRIANGLESTRIP, D3DPT_TRIANGLEFAN])
                {
                    run(calls.device('DrawPrimitive', [type, 0, 1]));
                    run(calls.indexed(type, 0, 0, 1));
                }
                run(calls.device('DrawPrimitiveUP', [D3DPT_TRIANGLELIST, 1, USER,
                    FORMATS[0].stride]));
                run(calls.device('DrawIndexedPrimitiveUP', [D3DPT_TRIANGLELIST, 0, 3, 1,
                    USER_INDICES, D3DFMT_INDEX16, USER, FORMATS[0].stride]));
            }
        }
        run(calls.device('SetViewport', [{ words: [4, 4, 16, 16, 0, ONE] }]));
        run(calls.device('Clear', [0, 0, D3DCLEAR_TARGET, 0xff102030, ONE, 0]));
        run(calls.device('SetViewport', [{ words: [0, 0, 64, 64, 0, ONE] }]));
        run(calls.device('Clear', [0, 0, D3DCLEAR_TARGET, 0xff302010, ONE, 0]));
        calls.stream(0).forEach(call=>run(call));
        run(calls.indices(0));
        run(calls.device('EndScene'));
        run(calls.present);
        await idle(m.gpu);
    }
    answers.length = 0;
    gpu.length = 0;
    inGuest.clear();

    run(calls.device('BeginScene'));
    let stream = 0;
    for (const step of steps)
    {
        if (step.kind === 'lock')
        {
            const answer = run(calls.lock(step.on, step.offset, step.size, step.flags));
            const at = m.memory.readU32(OUT);
            const length = step.size === 0 ? bytesOfBuffer(step.on) - step.offset : step.size;
            const bytes = bytesFor(step.on === IB, length, step.fill);
            const writing = answer.eax === 0 && step.flags !== D3DLOCK_READONLY;
            const half = Math.floor(length / 4) * 2;
            if (writing)
            {
                write(at, bytes.subarray(0, half));
            }
            if (step.between)
            {
                texels(step.between, 'level', step.fill);
            }
            if (writing)
            {
                write(at + half, bytes.subarray(half));
            }
            run(calls.unlock(step.on));
            if (step.twice)
            {
                run(calls.unlock(step.on));
            }
        }
        else if (step.kind === 'texels')
        {
            texels(step.on, step.through, step.fill);
        }
        else if (step.kind === 'texture')
        {
            run(calls.device('SetTexture', [0, step.on ?? 0]));
        }
        else if (step.kind === 'stream')
        {
            stream = step.which;
            calls.stream(step.which).forEach(call=>run(call));
            run(calls.indices(0));
        }
        else if (step.kind === 'indices')
        {
            run(calls.indices(step.base));
        }
        else if (step.kind === 'draw')
        {
            run(calls.device('DrawPrimitive', [step.type, step.start, step.triangles]));
        }
        else if (step.kind === 'indexed')
        {
            run(calls.indexed(step.type, step.base, step.start, step.triangles));
        }
        else if (step.kind === 'user')
        {
            // From the program's memory in the first format, then the
            // buffer's own again where the draw unbound it.
            calls.stream(0).forEach(call=>run(call));
            run(calls.device('DrawPrimitiveUP', [D3DPT_TRIANGLELIST, 1, USER,
                FORMATS[0].stride]));
            calls.stream(stream).forEach(call=>run(call));
        }
        else if (step.kind === 'world')
        {
            const words = Array.from({ length: 16 }, (unused, i)=>new Uint32Array(
                new Float32Array([i % 5 === 0 ? 1 : (step.seed % (i + 3)) / 7]).buffer)[0]);
            run(calls.device('SetTransform', [D3DTS_WORLD, { words }]));
            run(calls.device('GetTransform', [D3DTS_WORLD, 'out']), 64);
        }
        else if (step.kind === 'factor')
        {
            run(calls.device('SetRenderState', [D3DRS_TEXTUREFACTOR, step.value]));
            run(calls.device('GetRenderState', [D3DRS_TEXTUREFACTOR, 'out']), 4);
        }
        else if (step.kind === 'copy')
        {
            copy(step.through);
        }
        else if (step.kind === 'record')
        {
            run(calls.device('BeginStateBlock'));
            run(calls.device('SetTexture', [0, step.texture ?? 0]));
            const words = Array.from({ length: 16 }, (unused, i)=>new Uint32Array(
                new Float32Array([i % 5 === 0 ? 1 : (step.seed % (i + 2)) / 5]).buffer)[0]);
            run(calls.device('SetTransform', [D3DTS_WORLD, { words }]));
            run(calls.device('SetRenderState', [D3DRS_TEXTUREFACTOR, step.seed * 4099]));
            makeBlock('EndStateBlock', ['out']);
            blockStreams.push(null);
        }
        else if (step.kind === 'capture')
        {
            makeBlock('CreateStateBlock', [D3DSBT_ALL, 'out']);
            blockStreams.push(stream);
        }
        else if (step.kind === 'apply')
        {
            onBlock(step.block, 'Apply');
            stream = blockStreams[step.block] ?? stream;
        }
        else if (step.kind === 'recapture')
        {
            onBlock(step.block, 'Capture');
            if (blockStreams[step.block] !== null)
            {
                blockStreams[step.block] = stream;
            }
        }
        else if (step.kind === 'clear')
        {
            if (step.viewport)
            {
                run(calls.device('SetViewport', [{ words: [...step.viewport, 0, ONE] }]));
            }
            run(calls.device('Clear', [0, 0, D3DCLEAR_TARGET, step.color, ONE, 0]));
            run(calls.device('SetViewport', [{ words: [0, 0, 64, 64, 0, ONE] }]));
        }
        else if (step.kind === 'indexedUser')
        {
            calls.stream(0).forEach(call=>run(call));
            run(calls.device('DrawIndexedPrimitiveUP', [D3DPT_TRIANGLELIST, 0, 3, 1,
                USER_INDICES, D3DFMT_INDEX16, USER, FORMATS[0].stride]));
            calls.stream(stream).forEach(call=>run(call));
        }
        else if (step.kind === 'reference')
        {
            run({ on: step.on, kind: kindOf(step.on), method: 'AddRef', args: [] });
            run({ on: step.on, kind: kindOf(step.on), method: 'Release', args: [] });
        }
        else
        {
            run(calls.device('EndScene'));
            run(calls.present);
            run(calls.device('BeginScene'));
        }
    }
    // What is still in the ring is made before the frame is shown, and every
    // frame presented reaches the queue before what it was given is read.
    run(calls.device('EndScene'));
    run(calls.present);
    await idle(m.gpu);
    return { answers, gpu, inGuest };
}

/**
 * Where two runs part: the first line that differs.
 *
 * @param {string[]} trap @param {string[]} guest @param {string} what
 */
const parting = (trap, guest, what)=>{
    const at = trap.findIndex((line, i)=>line !== guest[i]);
    if (at < 0 && trap.length === guest.length)
    {
        return null;
    }
    const index = at < 0 ? Math.min(trap.length, guest.length) : at;
    return `${what} ${index} of ${trap.length}/${guest.length}: every call a trap gives `
        + `${(trap[index] ?? 'nothing').slice(0, 400)}, the guest code `
        + `${(guest[index] ?? 'nothing').slice(0, 400)}`;
};

/** The calls each part of the guest code takes, which a run must have taken in the guest. */
const COVERED = ['Lock', 'Unlock', 'GetSurfaceLevel', 'AddRef', 'Release', 'SetTexture',
    'SetStreamSource', 'SetIndices', 'DrawPrimitive', 'DrawIndexedPrimitive', 'DrawPrimitiveUP',
    'SetTransform', 'GetTransform', 'SetRenderState', 'GetRenderState', 'Clear', 'SetViewport'];
/** And those only Direct3D 9's ring carries: a state block's own Capture and Apply. */
const COVERED_9 = ['Apply', 'Capture'];

for (const [version, worker] of /** @type {[Version, boolean][]} */ ([[D3D8, false],
    [D3D9, false], [D3D8, true], [D3D9, true]]))
{
    const name = `${version === D3D9 ? 'Direct3D 9' : 'Direct3D 8'}${worker
        ? ', in a graphics worker' : ''}`;
    test(`${name}: the GPU is given what it would be with every call a trap, whatever a frame`
        + ' locked, uploaded, bound, referenced and drew', async()=>{
        /** @type {string[]} */
        const wrong = [];
        /** @type {Map<string, number>} */
        const taken = new Map();
        for (let seed = 1; seed <= 40 && wrong.length === 0; seed++)
        {
            const steps = generate(seed, 200, callsOf(version).upUnbinds);
            const trap = await play(version, false, steps, worker);
            const guest = await play(version, true, steps, worker);
            for (const [method, times] of guest.inGuest)
            {
                taken.set(method, (taken.get(method) ?? 0) + times);
            }
            for (const found of [parting(trap.answers, guest.answers, 'answer'),
                parting(trap.gpu, guest.gpu, 'GPU draw')])
            {
                if (found)
                {
                    wrong.push(`seed ${seed}: ${found}`);
                }
            }
        }
        assert.deepEqual(wrong, []);
        const covered = [...COVERED, ...version === D3D9 ? COVERED_9 : []];
        assert.deepEqual(covered.filter(method=>!((taken.get(method) ?? 0) > 20)), [],
            `each part of the guest code took calls: ${JSON.stringify([...taken])}`);
    });
}
