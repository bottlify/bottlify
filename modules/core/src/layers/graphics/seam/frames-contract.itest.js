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
 * the ring are as long as a frame makes them. The program also draws into a
 * texture and samples it, copies into it and out of it, and polls an event
 * query.
 *
 * Each program also runs with its device recording for a twin that draws, as
 * in a graphics worker, against the device drawing itself: what the recording
 * device answers on its own -- an event query, a copy between two surfaces
 * whose pixels are on the GPU -- must be what the drawing one answers, and
 * leave the program's memory as that one leaves it.
 *
 * What is compared: every call's answer, what a getter wrote and what the
 * program read back of a surface; and every draw the GPU is given, as it
 * would read it -- the indices, the vertices they name in every buffer bound,
 * the bytes of the uniform ranges bound and the texels of the textures bound
 * -- taken at each submit in queue order. The guest code must have taken each
 * part of the program in the guest, and each copy, target and query must have
 * been made, or the gate would compare nothing.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    D3D9, HWND, SOFTWARE_VERTEXPROCESSING, machine, random,
} from './guest-machine.itest.js';

/** @typedef {import('./guest-machine.itest.js').Version} Version */
/** @typedef {import('./guest-machine.itest.js').Call} Call */

const D3DUSAGE_RENDERTARGET = 0x1;
const D3DUSAGE_WRITEONLY = 0x8;
const D3DUSAGE_DYNAMIC = 0x200;
const D3DPOOL_DEFAULT = 0;
const D3DPOOL_MANAGED = 1;
const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_X8R8G8B8 = 22;
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
const D3DRS_SCISSORTESTENABLE = 174;
const D3DTSS_COLOROP = 1;
/** The colour operations a stage is set to: MODULATE, its first, SELECTARG1 and ADD. */
const COLOROPS = [4, 2, 7];
/**
 * The sampler states a program sets -- Direct3D 9's own, and the texture
 * stage states Direct3D 8 has for them -- and the values each takes:
 * ADDRESSU, ADDRESSV, MAGFILTER, MINFILTER, MIPFILTER.
 */
const SAMPLER_STATES = [
    { nine: 1, eight: 13, values: [1, 2, 3] },
    { nine: 2, eight: 14, values: [1, 2, 3] },
    { nine: 5, eight: 16, values: [1, 2] },
    { nine: 6, eight: 17, values: [1, 2] },
    { nine: 7, eight: 18, values: [0, 1, 2] },
];
/** D3DLIGHT_DIRECTIONAL. */
const DIRECTIONAL = 3;
/** @param {number} value @returns {number} the float's bits */
const floatWord = value=>new Uint32Array(new Float32Array([value]).buffer)[0];
const D3DPOOL_SYSTEMMEM = 2;
const D3DSBT_ALL = 1;
const D3DCLEAR_TARGET = 1;
const D3DQUERYTYPE_EVENT = 8;
const D3DISSUE_END = 1;
const D3DGETDATA_FLUSH = 1;
const D3DTEXF_NONE = 0;
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
/** A texture the program draws into and copies into, and samples like the rest. */
const TARGET = '#9';
/** A surface off any texture the program fills and copies to the target (`stretch`). */
const PLAIN = '#10';
/** Direct3D 9's event query. */
const QUERY = '#11';
/** What a draw may sample: the textures it fills, the one it copies into, and the target. */
const SAMPLED = [...TEXTURES, COPY, TARGET];

/** @param {string} on */
const kindOf = on=>(on === IB ? 'indices' : STREAMS.includes(on) ? 'vertices'
    : on === PLAIN ? 'surface' : on === QUERY ? 'query' : 'texture');
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
            device('CreateTexture', [TEXELS, TEXELS, 1, D3DUSAGE_RENDERTARGET, D3DFMT_X8R8G8B8,
                D3DPOOL_DEFAULT, 'out', ...tail]),
            nine ? device('CreateOffscreenPlainSurface', [TEXELS, TEXELS, D3DFMT_X8R8G8B8,
                D3DPOOL_DEFAULT, 'out', 0])
                : device('CreateImageSurface', [TEXELS, TEXELS, D3DFMT_X8R8G8B8, 'out']),
            ...nine ? [device('CreateQuery', [D3DQUERYTYPE_EVENT, 'out'])] : [],
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
        /**
         * @param {string} surface @param {string | number} depth  the depth surface Direct3D 8
         *     sets with it
         */
        target: (surface, depth)=>device('SetRenderTarget', nine ? [0, surface]
            : [surface, depth]),
        /**
         * The target's level given what it holds of a surface: from a surface
         * off any texture, or the corner of the back buffer -- a copy between
         * two surfaces whose pixels are on the GPU.
         *
         * @param {string} from @param {string} to @param {boolean} corner
         */
        stretch: (from, to, corner)=>{
            const rect = corner ? { words: [0, 0, TEXELS, TEXELS] } : 0;
            return nine ? device('StretchRect', [from, rect, to, 0, D3DTEXF_NONE])
                : device('CopyRects', [from, rect, corner ? 1 : 0, to, 0]);
        },
        /** Whether a draw from user memory unbinds the stream and the indices. */
        upUnbinds: !nine,
    };
};

/**
 * What each draw the GPU is given reads, as it would read it: at each submit,
 * the buffers as the queue's writes left them, the copies and the passes
 * encoded since the last one made in order, and every draw's pipeline, the
 * pass's viewport and scissor, its indices, the vertices they name in every
 * buffer bound by the strides its pipeline gives, the uniform ranges and the
 * samplers bound and -- once the submit has made its copies -- the texels of
 * the textures bound.
 *
 * @param {any} gpu  a recording GPU (`createFakeDevice`)
 * @returns {string[]}
 */
function gpuReads(gpu){
    /** @type {string[]} */
    const reads = [];
    /** @type {Map<any, any>} */
    const pipelines = new Map();
    /**
     * A pipeline by what it is made of: its shaders' code and its states,
     * and of every other object it names only the kind, which a machine
     * numbers in its own order.
     *
     * @type {Map<any, string>}
     */
    const pipelineKeys = new Map();
    /** @param {any} pipeline */
    const keyOf = pipeline=>{
        let key = pipelineKeys.get(pipeline);
        if (key === undefined)
        {
            const descriptor = pipelines.get(pipeline);
            key = descriptor === undefined ? '-' : createHash('sha1').update(JSON.stringify(
                descriptor, (name, value)=>(value?.kind === 'shaderModule'
                    ? value.descriptor.code : value?.kind && value.id ? value.kind : value)))
                .digest('hex').slice(0, 12);
            pipelineKeys.set(pipeline, key);
        }
        return key;
    };
    let from = 0;
    /**
     * Calls recorded into command buffers not submitted yet, and the encoder
     * of each pass: a submit's buffers run in the order it names them, which
     * is not the order their calls were recorded in -- the copies a rename
     * carries are encoded at a frame's end and run before its draws.
     *
     * @type {any[]}
     */
    let pending = [];
    /** @type {Map<any, any>} */
    const passEncoders = new Map();
    const createEncoder = gpu.device.createCommandEncoder.bind(gpu.device);
    gpu.device.createCommandEncoder = (/** @type {any} */ descriptor)=>{
        const encoder = createEncoder(descriptor);
        const beginRenderPass = encoder.beginRenderPass;
        encoder.beginRenderPass = (/** @type {any} */ passDescriptor)=>{
            const pass = beginRenderPass(passDescriptor);
            passEncoders.set(pass, encoder);
            return pass;
        };
        return encoder;
    };
    /** @param {any} call */
    const encoderOf = call=>call.encoder ?? (call.pass ? passEncoders.get(call.pass) : undefined);
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
        /** The pass's viewport and scissor as last set; the whole target until then. */
        let viewport = 'whole';
        let scissor = 'whole';
        /** @type {any[]} */
        const vertexBuffers = [];
        /** @type {any} */
        let indexBuffer = null;
        /** @type {Map<number, { uniforms: string, samplers: string, textures: any[] }>} */
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
        const vertexAt = vertex=>(pipelines.get(pipeline)?.vertex?.buffers ?? [])
            .map((/** @type {any} */ layout, /** @type {number} */ slot)=>vertexIn(layout, slot,
                vertex)).join('|');
        /** @param {string} line */
        const draw = line=>{
            const bound = [...groups.entries()].sort(([a], [b])=>a - b);
            drawn.push({
                line: `pipeline ${keyOf(pipeline)} viewport ${viewport} scissor ${scissor} ${line}`
                    + ` uniforms ${bound.map(([, group])=>group.uniforms).join('/')}`
                    + ` samplers ${bound.map(([, group])=>group.samplers).join('/')}`,
                textures: bound.flatMap(([, group])=>group.textures),
            });
        };
        /** @param {any} call */
        const apply = call=>{
            if (call.op === 'beginRenderPass')
            {
                viewport = 'whole';
                scissor = 'whole';
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
                pipeline = call.pipeline;
            }
            else if (call.op === 'setViewport')
            {
                viewport = call.rect.join(',');
            }
            else if (call.op === 'setScissorRect')
            {
                scissor = call.rect.join(',');
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
                    samplers: (call.group?.entries ?? [])
                        .filter((/** @type {any} */ entry)=>entry.resource?.kind === 'sampler')
                        .map((/** @type {any} */ entry)=>JSON.stringify(entry.resource.descriptor))
                        .join(','),
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
        };
        const calls = gpu.calls;
        for (let i = from; i < calls.length; i++)
        {
            const call = calls[i];
            if (encoderOf(call) === undefined)
            {
                apply(call);
            }
            else
            {
                pending.push(call);
            }
        }
        from = calls.length;
        for (const buffer of buffers)
        {
            for (const call of pending)
            {
                if (encoderOf(call) === buffer.encoder)
                {
                    apply(call);
                }
            }
        }
        const submitted = new Set(buffers.map(buffer=>buffer.encoder));
        pending = pending.filter(call=>!submitted.has(encoderOf(call)));
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
 *     | { kind: 'target', on: boolean }
 *     | { kind: 'stretch', from: 'plain' | 'back' | 'target', fill: number }
 *     | { kind: 'query', issue: boolean, flush: boolean }
 *     | { kind: 'sampler', state: number, value: number } | { kind: 'stage', op: number }
 *     | { kind: 'scissor', rect: number[], on: boolean }
 *     | { kind: 'frequency', index: number, value: number }
 *     | { kind: 'light', seed: number, on: boolean }
 *     | { kind: 'clip', index: number, seed: number }
 *     | { kind: 'viewport', rect: number[] }
 *     | { kind: 'present' }
 *     | { kind: 'hold', on: string, offset: number, size: number, flags: number }
 *     | { kind: 'write', on: string, offset: number, size: number, fill: number }
 *     | { kind: 'release', on: string }
 *     | { kind: 'refused', on: string, offset: number, size: number, flags: number }} Step
 *
 * A hold is a lock left held, written through by the writes after it; a write
 * goes through what the buffer's last lock handed back, held or let go of; a
 * refused lock is one past the buffer's end, which the program does not
 * unlock.
 */

/**
 * A program that keeps the promises a lock's flags make: a NOOVERWRITE lock
 * writes nothing a draw since the buffer's last lock without it read, and a
 * draw reads only what was written since that buffer's last DISCARD.
 *
 * @param {number} seed @param {number} steps  how many @param {boolean} upUnbinds
 * @param {boolean} nine  whether the device is Direct3D 9's, which has event queries
 * @returns {Step[]}
 */
function generate(seed, steps, upUnbinds, nine){
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
    let onTarget = false;
    /**
     * The state blocks made so far, by the order they were made in: what one
     * of everything holds of the stream and its base, none for one recorded.
     *
     * @type {({ stream: number, base: number, bound: boolean } | null)[]}
     */
    const blocks = [];
    while (program.length < steps)
    {
        const roll = below(66);
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
        else if (roll < 51)
        {
            onTarget = !onTarget;
            program.push({ kind: 'target', on: onTarget });
        }
        else if (roll < 53)
        {
            // Direct3D 8's copy out of a target waits for the pixels the
            // device in a graphics worker draws, which this machine cannot.
            program.push({ kind: 'stretch', from: pick(nine ? ['plain', 'back', 'target']
                : ['plain', 'back']), fill: below(256) });
        }
        else if (roll < 55 && nine)
        {
            program.push({ kind: 'query', issue: below(4) !== 0, flush: below(2) === 0 });
        }
        else if (roll < 57)
        {
            const state = below(SAMPLER_STATES.length);
            program.push({ kind: 'sampler', state, value: pick(SAMPLER_STATES[state].values) });
        }
        else if (roll < 58)
        {
            program.push({ kind: 'stage', op: pick(COLOROPS) });
        }
        else if (roll < 59 && nine && below(2) === 0)
        {
            const left = below(32);
            const top = below(32);
            program.push({ kind: 'scissor', rect: [left, top, left + 1 + below(32),
                top + 1 + below(32)], on: below(3) !== 0 });
        }
        else if (roll < 59 && nine)
        {
            // A stream's divider: the geometry drawn twice, an instance each, once
            // again, and the ones the device refuses.
            program.push({ kind: 'frequency', index: pick([0, 1, 0, 1, 16]),
                value: pick([1, 1, 0x40000002, 0x80000001, 0x40000000, 0xc0000001, 0]) });
        }
        else if (roll < 60)
        {
            program.push({ kind: 'light', seed: below(1000), on: below(2) === 0 });
        }
        else if (roll < 61)
        {
            program.push({ kind: 'clip', index: below(6), seed: below(1000) });
        }
        else if (roll < 62)
        {
            const x = below(32);
            const y = below(32);
            program.push({ kind: 'viewport', rect: [x, y, 1 + below(64 - x), 1 + below(64 - y)] });
        }
        else
        {
            program.push({ kind: 'present' });
        }
    }
    return program;
}

/**
 * A program that streams its geometry through the dynamic buffers as a
 * game's renderer does, and keeps the promises `generate` keeps: each draw's
 * vertices or indices written under NOOVERWRITE after the last ones, a
 * DISCARD at the buffer's end or now and then before it, the vertex buffer an
 * indexed draw reaches refilled whole. Now and then a buffer is held locked
 * across draws from it and calls into the host, as a skinning cache is, a
 * buffer is written through the pointer its last lock handed back after the
 * unlock, and a lock past a buffer's end is refused. What `generate` makes
 * only now and then is here in every frame: a DISCARD under draws the ring
 * holds, which the guest's lock answers by moving the buffer onto another
 * storage of its own (`d3d8/storages.js`), and locks, writes and draws of a
 * storage the device has not moved onto yet.
 *
 * @param {number} seed @param {number} steps  how many
 * @param {boolean} nine  whether the device is Direct3D 9's, which has event queries
 * @returns {Step[]}
 */
export function streaming(seed, steps, nine){
    const { below, pick } = random(seed);
    const buffers = [...STREAMS, IB];
    /** @type {Record<string, { read: Uint8Array, defined: Uint8Array, unit: number }>} */
    const book = Object.fromEntries(buffers.map(on=>[on, {
        read: new Uint8Array(bytesOfBuffer(on)), defined: new Uint8Array(bytesOfBuffer(on)),
        unit: on === IB ? 2 : FORMATS[STREAMS.indexOf(on)].stride }]));
    /** Where each buffer's next units go, in units. @type {Record<string, number>} */
    const cursor = Object.fromEntries(buffers.map(on=>[on, 0]));
    /** The bytes each buffer's last lock handed out, written through after it. */
    /** @type {Record<string, [number, number] | null>} */
    const handed = Object.fromEntries(buffers.map(on=>[on, null]));
    /** The buffer held locked, and its lock's end in units. */
    /** @type {{ now: { on: string, end: number } | null }} */
    const held = { now: null };
    /** @type {Step[]} */
    const program = [];
    let stream = 0;
    let base = 0;
    // Half the programs call into the host a quarter as often, so that a
    // buffer is discarded again and again before the host looks and moves
    // round all its storages.
    const calm = below(2) === 0;
    /** @param {string} on @param {number} from @param {number} to  bytes */
    const unread = (on, from, to)=>!book[on].read.subarray(from, to).includes(1);
    /**
     * Locks a buffer for `units` more, held or not: after the last ones under
     * NOOVERWRITE where they fit and nothing drawn since the last lock without
     * it read them, from the start under a DISCARD otherwise; sometimes a
     * DISCARD for no reason, sometimes a plain lock, which keeps the bytes and
     * waits for the draws. The lock reaches `units` or further, to the end.
     *
     * @param {string} on @param {number} units @param {boolean} hold
     * @returns {number} the first unit
     */
    const lock = (on, units, hold)=>{
        const entry = book[on];
        const total = entry.read.length / entry.unit;
        let first = cursor[on];
        let flags = D3DLOCK_NOOVERWRITE;
        if (first + units > total || below(10) === 0
            || !unread(on, first * entry.unit, (first + units) * entry.unit))
        {
            first = 0;
            flags = pick([D3DLOCK_DISCARD, D3DLOCK_DISCARD, D3DLOCK_DISCARD, D3DLOCK_DISCARD,
                D3DLOCK_DISCARD | D3DLOCK_NOOVERWRITE, 0]);
        }
        const toEnd = hold || below(5) === 0;
        const end = toEnd ? total : first + units;
        if (flags === D3DLOCK_NOOVERWRITE && !unread(on, first * entry.unit, end * entry.unit))
        {
            return lock(on, units, false);
        }
        const offset = first * entry.unit;
        const bytes = (end - first) * entry.unit;
        if ((flags & D3DLOCK_NOOVERWRITE) === 0)
        {
            entry.read = new Uint8Array(entry.read.length);
        }
        if ((flags & D3DLOCK_DISCARD) !== 0)
        {
            entry.defined = new Uint8Array(entry.defined.length);
        }
        const size = toEnd && below(2) === 0 ? 0 : bytes;
        handed[on] = [offset, offset + bytes];
        if (hold)
        {
            program.push({ kind: 'hold', on, offset, size, flags });
            program.push({ kind: 'write', on, offset, size: units * entry.unit,
                fill: 1 + below(250) });
            entry.defined.fill(1, offset, offset + units * entry.unit);
            held.now = { on, end };
        }
        else
        {
            program.push({ kind: 'lock', on, offset, size, flags, fill: 1 + below(250),
                twice: below(16) === 0, between: below(6) === 0 ? pick(TEXTURES) : null });
            entry.defined.fill(1, offset, offset + bytes);
        }
        cursor[on] = first + units;
        return first;
    };
    /**
     * Room for `units` more in a buffer: in the held lock where it has room
     * left, written there; otherwise let go of and locked again.
     *
     * @param {string} on @param {number} units
     * @returns {number} the first unit
     */
    const place = (on, units)=>{
        const entry = book[on];
        if (held.now?.on === on)
        {
            const first = cursor[on];
            if (first + units <= held.now.end
                && unread(on, first * entry.unit, (first + units) * entry.unit))
            {
                program.push({ kind: 'write', on, offset: first * entry.unit,
                    size: units * entry.unit, fill: 1 + below(250) });
                entry.defined.fill(1, first * entry.unit, (first + units) * entry.unit);
                cursor[on] = first + units;
                return first;
            }
            program.push({ kind: 'release', on });
            held.now = null;
        }
        return lock(on, units, false);
    };
    while (program.length < steps)
    {
        const roll = below(100);
        if (roll < 30)
        {
            const on = STREAMS[stream];
            const type = pick([D3DPT_TRIANGLELIST, D3DPT_TRIANGLESTRIP, D3DPT_TRIANGLEFAN]);
            const triangles = 1 + below(4);
            const count = VERTICES_FOR[type](triangles);
            const start = place(on, count);
            const unit = book[on].unit;
            book[on].read.fill(1, start * unit, (start + count) * unit);
            program.push({ kind: 'draw', type, start, triangles });
        }
        else if (roll < 58)
        {
            const on = STREAMS[stream];
            const unit = book[on].unit;
            if (book[on].defined.subarray(base * unit, (base + REACH) * unit).includes(0))
            {
                // The vertices the indices name, written whole.
                if (held.now?.on === on)
                {
                    program.push({ kind: 'release', on });
                    held.now = null;
                }
                program.push({ kind: 'lock', on, offset: 0, size: 0, flags: D3DLOCK_DISCARD,
                    fill: 1 + below(250), twice: false, between: null });
                book[on].read = new Uint8Array(book[on].read.length);
                book[on].defined = new Uint8Array(book[on].defined.length).fill(1);
                handed[on] = [0, book[on].read.length];
                cursor[on] = VERTICES;
            }
            const type = pick([D3DPT_TRIANGLELIST, D3DPT_TRIANGLESTRIP, D3DPT_TRIANGLEFAN]);
            const triangles = 1 + below(4);
            const count = VERTICES_FOR[type](triangles);
            const start = place(IB, count);
            book[IB].read.fill(1, start * 2, (start + count) * 2);
            book[on].read.fill(1, base * unit, (base + REACH) * unit);
            program.push({ kind: 'indexed', type, start, triangles, base });
        }
        else if (roll < 62 && held.now === null)
        {
            const on = pick([...STREAMS, ...STREAMS, IB]);
            const entry = book[on];
            lock(on, 1 + below(Math.min(24, entry.read.length / entry.unit)), true);
        }
        else if (roll < 64 && held.now !== null)
        {
            program.push({ kind: 'release', on: held.now.on });
            held.now = null;
        }
        else if (roll < 67)
        {
            // Through the pointer the last lock handed back, over what no
            // draw since has read.
            const on = pick(buffers);
            const range = handed[on];
            const unit = book[on].unit;
            if (range === null)
            {
                continue;
            }
            const units = (range[1] - range[0]) / unit;
            const first = range[0] / unit + below(units);
            const span = 1 + below(Math.min(8, range[1] / unit - first));
            if (!unread(on, first * unit, (first + span) * unit))
            {
                continue;
            }
            program.push({ kind: 'write', on, offset: first * unit, size: span * unit,
                fill: 1 + below(250) });
            book[on].defined.fill(1, first * unit, (first + span) * unit);
        }
        else if (roll < 69)
        {
            const on = pick(buffers.filter(each=>each !== held.now?.on));
            const length = bytesOfBuffer(on);
            const unit = book[on].unit;
            const offset = below(2) === 0 ? length : unit * (1 + below(length / unit - 1));
            program.push({ kind: 'refused', on, offset, size: offset === length ? 0
                : length - offset + unit, flags: pick([D3DLOCK_DISCARD, D3DLOCK_NOOVERWRITE, 0]) });
        }
        else if (roll < 72)
        {
            stream = below(STREAMS.length);
            base = 0;
            program.push({ kind: 'stream', which: stream });
        }
        else if (roll < 75)
        {
            base = below(BASES + 1);
            program.push({ kind: 'indices', base });
        }
        else if (roll < 81)
        {
            program.push(pick([{ kind: 'world', seed: below(1000) },
                { kind: 'factor', value: below(0x1000000) },
                { kind: 'reference', on: pick(buffers) }]));
        }
        else if (roll >= 81 && calm && below(4) !== 0)
        {
            continue;
        }
        else if (roll < 84)
        {
            program.push({ kind: 'texels', on: pick(TEXTURES), through: pick(['texture', 'level']),
                fill: below(256) });
        }
        else if (roll < 86)
        {
            program.push({ kind: 'texels', on: SOURCE, through: 'texture', fill: below(256) });
            program.push({ kind: 'copy', through: pick(['texture', 'surface']) });
        }
        else if (roll < 88 && nine)
        {
            program.push({ kind: 'query', issue: below(4) !== 0, flush: below(2) === 0 });
        }
        else if (roll < 90)
        {
            program.push({ kind: 'texture', on: pick([...TEXTURES, null]) });
        }
        else
        {
            program.push({ kind: 'present' });
        }
    }
    if (held.now !== null)
    {
        program.push({ kind: 'release', on: held.now.on });
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
export async function play(version, guestCode, steps, worker = false){
    const calls = callsOf(version);
    // Clip planes, which a Direct3D 9 device has none of until it is told it
    // has: its guest code takes a plane only below the count.
    const m = machine(version, guestCode, { gpu: true, worker, caps: { maxUserClipPlanes: 6 } });
    const gpu = gpuReads(m.gpu);
    /** @type {string[]} */
    const answers = [];
    /** @type {Map<string, number>} */
    const inGuest = new Map();
    /** How many times each call was answered D3D_OK, so the gate knows it took the path. */
    /** @type {Map<string, number>} */
    const done = new Map();
    /**
     * The guest's DISCARDs that moved a buffer onto another storage of its own
     * (`d3d8/storages.js`): the lock handed back an address off the storage
     * the device still holds, whose move waits in the ring.
     */
    let moves = 0;
    /** @param {Call} call @param {number} [readBack]  bytes of an answer to keep */
    const run = (call, readBack = 0)=>{
        const answer = m.run(call);
        const back = readBack > 0 ? [...m.memory.readBytes(OUT, readBack)].join(',') : '';
        answers.push(`${call.method} ${answer.eax.toString(16)} ${back}`);
        if (answer.traps.length === 0)
        {
            inGuest.set(call.method, (inGuest.get(call.method) ?? 0) + 1);
        }
        if (answer.eax === 0)
        {
            done.set(call.method, (done.get(call.method) ?? 0) + 1);
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
    // What the program keeps to draw into and copy between: the target's
    // level, the back buffer, and the depth surface Direct3D 8 sets with them.
    const targetLevel = levelOf(TARGET);
    const back = /** @type {string} */ (run(calls.device('GetBackBuffer',
        version.getBackBuffer)).out);
    const depth = calls.nine ? 0
        : /** @type {string} */ (run(calls.device('GetDepthStencilSurface', ['out'])).out);
    /** @param {boolean} on */
    const target = on=>run(calls.target(on ? targetLevel : back, depth));
    /** @param {number} seed */
    const fillPlain = seed=>{
        if (run({ on: PLAIN, kind: 'surface', method: 'LockRect', args: ['out', 0, 0] }).eax
            === 0)
        {
            write(m.memory.readU32(OUT + 4), Uint8Array.from({ length: TEXELS * TEXELS * 4 },
                (unused, i)=>(seed + i * 3) & 0xff));
        }
        run({ on: PLAIN, kind: 'surface', method: 'UnlockRect', args: [] });
    };
    /**
     * A copy into the target, from the plain surface the program fills first
     * or from the back buffer; or out of the target into the plain surface,
     * filled first with what the copy must overwrite, which the program then
     * reads.
     *
     * @param {'plain' | 'back' | 'target'} from @param {number} seed
     */
    const stretch = (from, seed)=>{
        if (from === 'target')
        {
            fillPlain(seed);
            run(calls.stretch(targetLevel, PLAIN, false));
            if (run({ on: PLAIN, kind: 'surface', method: 'LockRect',
                args: ['out', 0, D3DLOCK_READONLY] }).eax === 0)
            {
                answers.push(`read ${createHash('sha1').update(m.memory.readBytes(
                    m.memory.readU32(OUT + 4), TEXELS * TEXELS * 4)).digest('hex')}`);
            }
            run({ on: PLAIN, kind: 'surface', method: 'UnlockRect', args: [] });
            return;
        }
        if (from === 'plain')
        {
            fillPlain(seed);
        }
        run(calls.stretch(from === 'plain' ? PLAIN : back, targetLevel, from === 'back'));
    };
    /** @param {number} op */
    const stage = op=>{
        run(calls.device('SetTextureStageState', [0, D3DTSS_COLOROP, op]));
        run(calls.device('GetTextureStageState', [0, D3DTSS_COLOROP, 'out']), 4);
    };
    /** @param {boolean} issue @param {boolean} flush */
    const query = (issue, flush)=>{
        if (issue)
        {
            run({ on: QUERY, kind: 'query', method: 'Issue', args: [D3DISSUE_END] });
        }
        run({ on: QUERY, kind: 'query', method: 'GetData',
            args: ['out', 4, flush ? D3DGETDATA_FLUSH : 0] }, 4);
    };
    m.memory.writeBytes(USER, bytesFor(false, 3 * FORMATS[0].stride, 99));
    m.memory.writeBytes(USER_INDICES, new Uint8Array(new Uint16Array([0, 1, 2]).buffer));
    // A frame of every kind of draw, from either buffer, with a texture and
    // without, and time for the shaders it needs to be compiled: a draw whose
    // pipeline is not ready yet is left out of its frame, and the two
    // machines would leave out different ones.
    [...STREAMS, IB].forEach((on, i)=>fill(on, 1 + i));
    [...TEXTURES, SOURCE].forEach((on, i)=>texels(on, 'texture', 7 + i));
    copy('texture');
    stretch('plain', 3);
    for (let pass = 0; pass < 4; pass++)
    {
        target(pass % 2 === 1);
        run(calls.device('BeginScene'));
        for (const texture of [TEXTURES[0], TARGET, 0])
        {
            run(calls.device('SetTexture', [0, texture]));
            for (let which = 0; which < STREAMS.length; which++)
            {
                calls.stream(which).forEach(call=>run(call));
                run(calls.indices(0));
                for (const op of COLOROPS)
                {
                    stage(op);
                    for (const type of [D3DPT_TRIANGLELIST, D3DPT_TRIANGLESTRIP,
                        D3DPT_TRIANGLEFAN])
                    {
                        run(calls.device('DrawPrimitive', [type, 0, 1]));
                        run(calls.indexed(type, 0, 0, 1));
                    }
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
        stretch('back', 5);
        if (calls.nine)
        {
            query(true, true);
        }
        run(calls.present);
        await idle(m.gpu);
    }
    target(false);
    answers.length = 0;
    gpu.length = 0;
    inGuest.clear();
    done.clear();
    moves = 0;

    /** Where each buffer's last lock put its first byte, for the writes after it. */
    /** @type {Map<string, number>} */
    const lockedAt = new Map();
    /** The storages each buffer's locks handed out, by where each begins. */
    /** @type {Map<string, Set<number>>} */
    const storages = new Map();
    /**
     * The held locks whose storage the device had not moved onto when the
     * program took them, and the calls into the host made while one was held.
     */
    /** @type {Set<string>} */
    const heldAhead = new Set();
    let heldAcross = 0;
    /**
     * A lock as the program takes it, and whether it was handed a storage the
     * device still holds.
     *
     * @param {string} on @param {number} offset @param {number} size @param {number} flags
     */
    const lockOf = (on, offset, size, flags)=>{
        const answer = run(calls.lock(on, offset, size, flags));
        const at = m.memory.readU32(OUT);
        if (answer.eax !== 0)
        {
            return { answer, at, ahead: false };
        }
        const ahead = at - offset !== m.countOf(on)?.base;
        if (ahead && answer.traps.length === 0)
        {
            moves++;
        }
        lockedAt.set(on, at - offset);
        storages.set(on, (storages.get(on) ?? new Set()).add(at - offset));
        return { answer, at, ahead };
    };

    run(calls.device('BeginScene'));
    let stream = 0;
    for (const step of steps)
    {
        if (heldAhead.size > 0 && ['texels', 'copy', 'query', 'stretch', 'target', 'present']
            .includes(step.kind))
        {
            heldAcross++;
        }
        if (step.kind === 'hold')
        {
            if (lockOf(step.on, step.offset, step.size, step.flags).ahead)
            {
                heldAhead.add(step.on);
            }
        }
        else if (step.kind === 'write')
        {
            write(/** @type {number} */ (lockedAt.get(step.on)) + step.offset,
                bytesFor(step.on === IB, step.size, step.fill));
        }
        else if (step.kind === 'release')
        {
            run(calls.unlock(step.on));
            heldAhead.delete(step.on);
        }
        else if (step.kind === 'refused')
        {
            run(calls.lock(step.on, step.offset, step.size, step.flags));
        }
        else if (step.kind === 'lock')
        {
            const { answer, at } = lockOf(step.on, step.offset, step.size, step.flags);
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
        else if (step.kind === 'target')
        {
            target(step.on);
        }
        else if (step.kind === 'stretch')
        {
            stretch(step.from, step.fill);
        }
        else if (step.kind === 'query')
        {
            query(step.issue, step.flush);
        }
        else if (step.kind === 'sampler')
        {
            const { nine: type, eight } = SAMPLER_STATES[step.state];
            if (calls.nine)
            {
                run(calls.device('SetSamplerState', [0, type, step.value]));
                run(calls.device('GetSamplerState', [0, type, 'out']), 4);
            }
            else
            {
                run(calls.device('SetTextureStageState', [0, eight, step.value]));
                run(calls.device('GetTextureStageState', [0, eight, 'out']), 4);
            }
        }
        else if (step.kind === 'stage')
        {
            stage(step.op);
        }
        else if (step.kind === 'frequency')
        {
            run(calls.device('SetStreamSourceFreq', [step.index, step.value]));
        }
        else if (step.kind === 'scissor')
        {
            run(calls.device('SetScissorRect', [{ words: step.rect }]));
            run(calls.device('SetRenderState', [D3DRS_SCISSORTESTENABLE, step.on ? 1 : 0]));
        }
        else if (step.kind === 'light')
        {
            /** @param {number} i */
            const part = i=>floatWord(((step.seed * (i + 7)) % 97) / 97);
            run(calls.device('SetMaterial', [{ words: Array.from({ length: 17 },
                (unused, i)=>part(i)) }]));
            // Directional, its colours from the seed, pointing down the z axis.
            run(calls.device('SetLight', [0, { words: [DIRECTIONAL,
                ...Array.from({ length: 12 }, (unused, i)=>part(i)), 0, 0, 0,
                0, 0, floatWord(1), floatWord(100), 0, floatWord(1), 0, 0, 0, 0] }]));
            run(calls.device('LightEnable', [0, step.on ? 1 : 0]));
        }
        else if (step.kind === 'clip')
        {
            run(calls.device('SetClipPlane', [step.index, { words: [0, 1, 2, 3].map(i=>floatWord(
                ((step.seed * (i + 3)) % 11) - 5)) }]));
        }
        else if (step.kind === 'viewport')
        {
            run(calls.device('SetViewport', [{ words: [...step.rect, 0, ONE] }]));
            run(calls.device('GetViewport', ['out']), 24);
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
    return { answers, gpu, inGuest, done, moves, heldAcross,
        storages: Object.fromEntries([...storages].map(([on, set])=>[on, set.size])) };
}

/** @typedef {Awaited<ReturnType<typeof play>>} Played */

/**
 * Where two runs part: the first line that differs.
 *
 * @param {[string, string[]]} one @param {[string, string[]]} other  each run's name and lines
 * @param {string} what
 */
const parting = ([oneName, one], [otherName, other], what)=>{
    const at = one.findIndex((line, i)=>line !== other[i]);
    if (at < 0 && one.length === other.length)
    {
        return null;
    }
    const index = at < 0 ? Math.min(one.length, other.length) : at;
    return `${what} ${index} of ${one.length}/${other.length}: ${oneName} gives `
        + `${(one[index] ?? 'nothing').slice(0, 400)}, ${otherName} `
        + `${(other[index] ?? 'nothing').slice(0, 400)}`;
};

/** The calls each part of the guest code takes, which a run must have taken in the guest. */
const COVERED = ['Lock', 'Unlock', 'GetSurfaceLevel', 'AddRef', 'Release', 'SetTexture',
    'SetStreamSource', 'SetIndices', 'DrawPrimitive', 'DrawIndexedPrimitive', 'DrawPrimitiveUP',
    'SetTransform', 'GetTransform', 'SetRenderState', 'GetRenderState', 'Clear', 'SetViewport',
    'GetViewport', 'SetTextureStageState', 'GetTextureStageState', 'SetMaterial', 'SetLight',
    'LightEnable', 'SetClipPlane'];
/**
 * And those only Direct3D 9's guest code takes: a state block's own Capture
 * and Apply, the sampler states, the scissor and a stream's divider.
 */
const COVERED_9 = ['Apply', 'Capture', 'SetSamplerState', 'GetSamplerState', 'SetScissorRect',
    'SetStreamSourceFreq'];

/** The calls whose path is the device's own, which each run must have had answered D3D_OK. */
const DONE = ['SetRenderTarget', 'LockRect'];
/** And each version's copy into the target, and Direct3D 9's event query. */
const DONE_8 = ['CopyRects'];
const DONE_9 = ['StretchRect', 'Issue', 'GetData'];

/**
 * The arms each gate plays a program down, and the pairs it compares. The
 * guest code and the device recording for a graphics worker are two
 * mechanisms with a slow path each, so two gates: one compares the guest code
 * with every call a trap, the other the device recording with the device
 * drawing itself -- with every call a trap and with the guest code, so that
 * the recording is seen under both.
 *
 * @type {Record<'guest' | 'worker', { arms: [string, boolean, boolean][],
 *     pairs: [string, string][], subject: string }>}
 */
const GATES = {
    guest: {
        arms: [['every call a trap', false, false], ['the guest code', true, false]],
        pairs: [['every call a trap', 'the guest code']],
        subject: 'with every call a trap',
    },
    worker: {
        arms: [['the device drawing itself', false, false],
            ['the device recording', false, true],
            ['the guest code recorded', true, true]],
        pairs: [['the device drawing itself', 'the device recording'],
            ['the device recording', 'the guest code recorded']],
        subject: 'with the device drawing on the program\'s thread',
    },
};

/**
 * Where the GPU draws of one program part, down each pair of a gate's arms.
 *
 * @param {Version} version @param {typeof GATES[keyof typeof GATES]} gate
 * @param {Step[]} steps @param {Map<string, Played>} [played]  each arm's run, filled
 * @returns {Promise<string[]>}
 */
async function partings(version, gate, steps, played = new Map()){
    for (const [name, guestCode, worker] of gate.arms)
    {
        played.set(name, await play(version, guestCode, steps, worker));
    }
    /** @type {string[]} */
    const wrong = [];
    for (const [one, other] of gate.pairs)
    {
        const a = /** @type {Played} */ (played.get(one));
        const b = /** @type {Played} */ (played.get(other));
        const found = parting([one, a.gpu], [other, b.gpu], 'GPU draw');
        if (found)
        {
            wrong.push(found);
        }
    }
    return wrong;
}

/**
 * One gate for one version, each a file of its own
 * (`frames-contract-<version>-<gate>.itest.js`): all four in one file ran
 * past the minute a file is given.
 *
 * @param {Version} version @param {'guest' | 'worker'} which
 */
export function frameGate(version, which){
    const nine = version === D3D9;
    const gate = GATES[which];
    test(`${nine ? 'Direct3D 9' : 'Direct3D 8'}: the GPU is given what it would be ${gate.subject},`
        + ' whatever a frame locked, uploaded, bound, referenced, drew and copied', async()=>{
        /** @type {string[]} */
        const wrong = [];
        /** @type {Map<string, number>} */
        const taken = new Map();
        /** @type {Map<string, number>} */
        const answered = new Map();
        let moves = 0;
        for (let seed = 1; seed <= 40 && wrong.length === 0; seed++)
        {
            const steps = generate(seed, 200, callsOf(version).upUnbinds, nine);
            /** @type {Map<string, Played>} */
            const played = new Map();
            for (const [name, guestCode, worker] of gate.arms)
            {
                const run = await play(version, guestCode, steps, worker);
                played.set(name, run);
                moves += run.moves;
                for (const [method, times] of run.inGuest)
                {
                    taken.set(method, (taken.get(method) ?? 0) + times);
                }
                if (!guestCode && !worker)
                {
                    for (const [method, times] of run.done)
                    {
                        answered.set(method, (answered.get(method) ?? 0) + times);
                    }
                }
            }
            for (const [one, other] of gate.pairs)
            {
                const a = /** @type {Played} */ (played.get(one));
                const b = /** @type {Played} */ (played.get(other));
                for (const found of [
                    parting([one, a.answers], [other, b.answers], 'answer'),
                    parting([one, a.gpu], [other, b.gpu], 'GPU draw')])
                {
                    if (found)
                    {
                        wrong.push(`seed ${seed}: ${found}`);
                    }
                }
            }
        }
        assert.deepEqual(wrong, []);
        const covered = [...COVERED, ...nine ? COVERED_9 : []];
        assert.deepEqual(covered.filter(method=>!((taken.get(method) ?? 0) > 20)), [],
            `each part of the guest code took calls: ${JSON.stringify([...taken])}`);
        const done = [...DONE, ...nine ? DONE_9 : DONE_8];
        assert.deepEqual(done.filter(method=>!((answered.get(method) ?? 0) > 20)), [],
            `each copy, target and query was made: ${JSON.stringify([...answered])}`);
        assert.ok(moves > 10, `DISCARDs under draws moved buffers onto storages of their own (${
            moves})`);
    });

    test(`${nine ? 'Direct3D 9' : 'Direct3D 8'}: an index buffer moved off a storage the guest`
        + ` wrote since the host last looked draws what was written there, ${gate.subject}`,
    async()=>{
        // Indices read at each draw, a DISCARD under them that comes to the
        // host and gives the buffer another storage, one the guest's lock
        // moves the buffer onto, a present that makes the move; then a
        // NOOVERWRITE write of the storage moved onto, a draw of it, and a
        // DISCARD that moves the buffer back before the host has looked: the
        // draw reads what that write left on the storage it was made with.
        const lock = (/** @type {number} */ flags, /** @type {number} */ fill,
            offset = 0, size = 0)=>/** @type {Step} */ ({ kind: 'lock', on: IB, offset, size,
            flags, fill, twice: false, between: null });
        const draw = (/** @type {number} */ start, /** @type {number} */ triangles)=>
            /** @type {Step} */ ({ kind: 'indexed', type: D3DPT_TRIANGLELIST, start, triangles,
                base: 0 });
        const steps = [draw(0, 2), lock(D3DLOCK_DISCARD, 11), draw(0, 2),
            lock(D3DLOCK_DISCARD, 22), draw(0, 2), /** @type {Step} */ ({ kind: 'present' }),
            lock(D3DLOCK_NOOVERWRITE, 33, 96, 24), draw(48, 4), lock(D3DLOCK_DISCARD, 44),
            draw(0, 2), draw(24, 2)];
        /** @type {Map<string, Played>} */
        const played = new Map();
        assert.deepEqual(await partings(version, gate, steps, played), []);
        const guestArms = gate.arms.filter(([, guestCode])=>guestCode);
        assert.ok(guestArms.every(([name])=>(played.get(name)?.moves ?? 0) === 2),
            `the guest moved the buffer twice: ${guestArms.map(([name])=>
                played.get(name)?.moves).join(', ')}`);
    });

    test(`${nine ? 'Direct3D 9' : 'Direct3D 8'}: a buffer discarded in place and then moved under`
        + ` draws has the discard made before the draws after it, ${gate.subject}`, async()=>{
        // A DISCARD under a draw comes to the host and gives the buffer
        // another storage; a call into the host makes the draws; a DISCARD
        // in place, with no draw in the ring, which the host replays before
        // the ring's next run; a draw; and a DISCARD under it, which the
        // guest's lock may not answer with a move: that would hold the
        // replay of the one in place back past the draw, and the draw before
        // it would read what was written after.
        const STREAM = STREAMS[0];
        const lock = (/** @type {number} */ fill)=>/** @type {Step} */ ({ kind: 'lock',
            on: STREAM, offset: 0, size: 0, flags: D3DLOCK_DISCARD, fill, twice: false,
            between: null });
        const draw = /** @type {Step} */ ({ kind: 'draw', type: D3DPT_TRIANGLELIST, start: 0,
            triangles: 2 });
        const steps = [draw, lock(11), draw, /** @type {Step} */ ({ kind: 'refused', on: STREAM,
            offset: bytesOfBuffer(STREAM), size: 0, flags: 0 }), lock(22), draw, lock(33), draw];
        const wrong = await partings(version, gate, steps);
        assert.deepEqual(wrong, []);
    });

    test(`${nine ? 'Direct3D 9' : 'Direct3D 8'}: a DISCARD the buffer refuses leaves it where it`
        + ` was, under draws, ${gate.subject}`, async()=>{
        // The buffer has another storage the guest could move it onto, a draw
        // is in the ring, and a DISCARD past the buffer's end fails: what the
        // buffer held is what the draw after reads.
        const STREAM = STREAMS[0];
        const draw = /** @type {Step} */ ({ kind: 'draw', type: D3DPT_TRIANGLELIST, start: 0,
            triangles: 2 });
        const steps = [draw, /** @type {Step} */ ({ kind: 'lock', on: STREAM, offset: 0, size: 0,
            flags: D3DLOCK_DISCARD, fill: 11, twice: false, between: null }), draw,
        /** @type {Step} */ ({ kind: 'refused', on: STREAM, offset: 16,
            size: bytesOfBuffer(STREAM), flags: D3DLOCK_DISCARD }), draw];
        const wrong = await partings(version, gate, steps);
        assert.deepEqual(wrong, []);
    });

    test(`${nine ? 'Direct3D 9' : 'Direct3D 8'}: a lock the host took and the guest let go of`
        + ` keeps what it was drawn with when the guest locks again, ${gate.subject}`, async()=>{
        // A lock with neither flag under a draw is the host's; the program
        // writes, draws and presents with it held, lets go of it in the guest,
        // and discards the buffer, with no draw in the ring, before the host
        // looks again: the host's unlock must not take what the DISCARD wrote
        // for the bytes the draw before it read.
        const STREAM = STREAMS[0];
        const length = bytesOfBuffer(STREAM);
        const draw = /** @type {Step} */ ({ kind: 'draw', type: D3DPT_TRIANGLELIST, start: 0,
            triangles: 2 });
        const steps = /** @type {Step[]} */ ([draw,
            { kind: 'hold', on: STREAM, offset: 0, size: 0, flags: 0 },
            { kind: 'write', on: STREAM, offset: 0, size: length, fill: 41 }, draw,
            { kind: 'present' }, { kind: 'release', on: STREAM },
            { kind: 'lock', on: STREAM, offset: 0, size: 0, flags: D3DLOCK_DISCARD, fill: 118,
                twice: false, between: null }, draw]);
        const wrong = await partings(version, gate, steps);
        assert.deepEqual(wrong, []);
    });

    test(`${nine ? 'Direct3D 9' : 'Direct3D 8'}: the GPU is given what it would be ${gate.subject},`
        + ' whatever a frame streamed through its dynamic buffers', async()=>{
        /** @type {string[]} */
        const wrong = [];
        let moves = 0;
        let heldAcross = 0;
        /** The most storages the guest code handed out of each buffer in one program. */
        /** @type {Record<string, number>} */
        const storages = {};
        for (let seed = 1; seed <= 60 && wrong.length === 0; seed++)
        {
            const steps = streaming(seed, 300, nine);
            /** @type {Map<string, Played>} */
            const played = new Map();
            for (const [name, guestCode, worker] of gate.arms)
            {
                const run = await play(version, guestCode, steps, worker);
                played.set(name, run);
                if (guestCode)
                {
                    moves += run.moves;
                    heldAcross += run.heldAcross;
                    for (const [on, count] of Object.entries(run.storages))
                    {
                        storages[on] = Math.max(storages[on] ?? 0, count);
                    }
                }
            }
            for (const [one, other] of gate.pairs)
            {
                const a = /** @type {Played} */ (played.get(one));
                const b = /** @type {Played} */ (played.get(other));
                for (const found of [
                    parting([one, a.answers], [other, b.answers], 'answer'),
                    parting([one, a.gpu], [other, b.gpu], 'GPU draw')])
                {
                    if (found)
                    {
                        wrong.push(`seed ${seed}: ${found}`);
                    }
                }
            }
        }
        assert.deepEqual(wrong, []);
        // Every buffer moved round all its storages, and calls into the host
        // came while a lock of a storage the device had not moved onto was held.
        assert.ok(moves > 1500, `locks handed out storages the device had not moved onto (${
            moves})`);
        assert.deepEqual([...STREAMS, IB].filter(on=>!(storages[on] >= 3)), [],
            `each buffer moved round its storages: ${JSON.stringify(storages)}`);
        assert.ok(heldAcross > 30, `calls into the host under a held lock of a storage the`
            + ` device had not moved onto (${heldAcross})`);
    });
}
