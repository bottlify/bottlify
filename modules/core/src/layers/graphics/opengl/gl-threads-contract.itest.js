/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The OpenGL command ring with two threads, as a gate: whatever two threads
 * do with their contexts, interleaved however a scheduler interleaves them,
 * each context is left as the same calls made at once would leave it, and the
 * GPU is given what it would be given.
 *
 * A context's ring is its own, written by the routines of the thread it is
 * current on and played by that thread's next call into the host. So what is
 * at stake with two threads is everything a call of one thread does while the
 * other's ring holds calls it has not played: a make-current, a release or a
 * delete of either context -- refused or not -- from either thread, contexts
 * moved from one thread to the other, a thread with none, a thread stopped in
 * the middle of a routine -- before its record is whole, while it copies --
 * while the other runs, and between glBegin and glEnd; and, with the two
 * contexts sharing their objects, textures and buffer objects made, filled,
 * set and drawn from by both, uploads and draws among them.
 *
 * GL makes a change to a shared object certain to reach another context only
 * once the context that made it has flushed or finished (the specification's
 * appendix on shared objects), so the programs hand the objects from one
 * context to the other through glFlush or glFinish, and use them freely in
 * between. A hand-over with neither the specification leaves undefined; the
 * ring still leaves it as the calls made at once would (the test at the end).
 *
 * Each program runs on two libraries over one processor's memory: one with
 * every call its export's handler, made at the moment the program makes it;
 * the other with the routines the seam places, run by the real processor
 * with the calling thread's TEB behind `fs:` -- in slices, so that a thread
 * may stop inside a routine, often walked through it a few instructions at a
 * time, while the other calls into the host. The kernel's scheduler never
 * ends a slice there (`atomicCode`); the ring is meant not to need it, a
 * record counting once its length, written last, is there.
 *
 * Compared: every answer and what a getter wrote, the error flag, every piece
 * of state a getter reaches on each context at the end, what was reported,
 * and what was drawn -- on the processor, each frame as presented; on a
 * device, here and through a graphics worker, every draw the GPU is given, as
 * it reads it at its submit.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import * as cork from '../../../../../cork/src/index.js';
import { TEB_GL_CONTEXT, commandCode } from '../seam/shadow.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { playedAtOnce } from '../remote/direct3d.js';
import { playedOpengl, recordedOpengl } from '../remote/opengl.js';
import { GL_COMMANDS } from './commands.js';
import { createOpengl } from './exports.js';
import { GL } from './constants.js';

const ENTRY = 0x7000;
const TRAP = 0x7800;
/** Each thread's program, a page of its own: one is rewritten while the other stands in it. */
const PROGRAMS = [0x8000, 0x9000];
/** Every routine at a place of its own, so both threads may be inside the same one. */
const ROUTINES = 0x10000;
const ROUTINE_SPAN = 0x200;
const TEBS = [0x20000, 0x22000];
const STACKS = [0xf0000, 0xe0000];
/** What each thread's calls point at: written as its call starts, so never under the other's. */
const DATA = [0x30000, 0x40000];
/** Each thread's client arrays, written once: a pointer to them is drawn from much later. */
const ARRAYS = [0x50000, 0x52000];
/** Where a getter answers, one place per library. */
const OUT = [0x58000, 0x5c000];
const SCRATCH = { direct: 0x100000, ring: 0x400000, bytes: 0x300000 };
const HDCS = [0x900d, 0x900e];
const SIDE = 8;
/** A double-buffered format with depth and stencil. */
const FORMAT = 9;
/** A slice no routine outlasts. */
const WHOLE = 1000000;
const BAD = 0x1234;

/** What the callee keeps for its caller, each with a value the routine must give back. */
const KEPT = /** @type {const} */ ([['ebx', 0x0b0b0b0b], ['esi', 0x05050505],
    ['edi', 0x0d0d0d0d], ['ebp', 0x0e0e0e0e]]);
/** What a thread stopped inside a routine is resumed with. */
const REGISTERS = /** @type {const} */ (['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi',
    'eflags', 'eip']);

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const bits = new DataView(new ArrayBuffer(8));
/** A float's dword. @param {number} value */
const f = value=>{
    bits.setFloat32(0, value, true);
    return bits.getUint32(0, true);
};
/** A double's two dwords, low first. @param {number} value @returns {[number, number]} */
const d = value=>{
    bits.setFloat64(0, value, true);
    return [bits.getUint32(0, true), bits.getUint32(4, true)];
};
/** @param {Uint8Array} bytes */
const digest = bytes=>createHash('sha1').update(bytes).digest('hex').slice(0, 12);

/** A seeded source. @param {number} seed */
const random = seed=>{
    let drawn = 0;
    const next = ()=>createHash('sha256').update(`${seed}:${drawn++}`).digest()
        .readUInt32LE(0) / 4294967296;
    return {
        /** @param {number} n */
        below: n=>Math.floor(next() * n),
        /** @template T @param {readonly T[]} list @returns {T} */
        pick: list=>list[Math.floor(next() * list.length)],
    };
};

/**
 * What a routine left: the words its trap found on the stack, null when it
 * took the call -- or, not yet finished, the thread still inside it.
 *
 * @typedef {{ done: true, left: number[] | null } | { done: false }} Slice
 */

/**
 * The processor, with every ring routine placed once and its trap a `hlt`,
 * and two threads on it: each its program, stack and TEB, and the registers
 * of one stopped inside a routine kept while the other runs.
 */
const machine = ()=>{
    const host = createCorkHost({
        memorySize: 16 * 1024 * 1024, trapPort: 0xb077, entryVector: ENTRY,
        initialStack: STACKS[0], engine: cork, cork: {},
    });
    host.writePhysical(TRAP, new Uint8Array([0xf4]));
    host.writePhysical(ENTRY, new Uint8Array(u32(PROGRAMS[0])));
    host.writePhysical(PROGRAMS[0], new Uint8Array([0xf4]));
    // The first slice starts at the entry vector; every later one where it is told.
    host.runSlice(16);
    const layout = host.blockLayout();
    const block = host.block();
    const state = new DataView(block.buffer, block.byteOffset, block.byteLength);
    /** @param {number} at */
    const read = at=>{
        const bytes = host.readPhysical(at, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @type {Map<string, { at: number, length: number }>} */
    const routines = new Map();
    Object.keys(GL_COMMANDS.COMMANDS).forEach((name, index)=>{
        const at = ROUTINES + index * ROUTINE_SPAN;
        const code = commandCode(at, TRAP, { ...GL_COMMANDS.COMMANDS[name],
            slot: GL_COMMANDS.commandSlot(name), thread: true });
        assert.ok(code.length <= ROUTINE_SPAN, `${name}'s routine fits its place`);
        host.writePhysical(at, code);
        routines.set(name, { at, length: code.length });
    });
    /**
     * Each thread's call in flight: what it called, where its program ends,
     * and its registers while it stands.
     *
     * @type {({ name: string, args: number[], end: number, registers: number[] } | null)[]}
     */
    const flights = [null, null];
    /** Slices that stopped a thread inside a routine, and inside one after its space was taken. */
    const stops = { inside: 0, reserved: 0 };

    /** @param {number} thread @param {number} budget @returns {Slice} */
    const slice = (thread, budget)=>{
        const flight = /** @type {NonNullable<(typeof flights)[number]>} */ (flights[thread]);
        state.setUint32(layout.fsBase, TEBS[thread], true);
        REGISTERS.forEach((register, i)=>host.writeReg32(register, flight.registers[i]));
        host.runSlice(budget);
        const eip = host.readReg32('eip') >>> 0;
        const where = `${flight.name} on thread ${thread}`;
        if (eip !== TRAP + 1 && eip !== flight.end)
        {
            flight.registers = REGISTERS.map(register=>host.readReg32(register) >>> 0);
            const routine = /** @type {{ at: number, length: number }} */ (
                routines.get(flight.name));
            if (eip >= routine.at && eip < routine.at + routine.length)
            {
                stops.inside++;
                // Past `push ebx; push esi; push edi`, with the record's
                // length in ESI: the space is taken or being taken.
                if ((host.readReg32('esp') >>> 0) === STACKS[thread] - 4 * flight.args.length
                    - 4 - 12)
                {
                    stops.reserved++;
                }
            }
            return { done: false };
        }
        flights[thread] = null;
        for (const [register, value] of KEPT)
        {
            assert.equal(host.readReg32(register) >>> 0, value, `${where} keeps ${register}`);
        }
        if (eip === TRAP + 1)
        {
            const esp = host.readReg32('esp') >>> 0;
            assert.equal(esp, STACKS[thread] - 4 * flight.args.length - 4,
                `${where} leaves its trap the frame it was called with`);
            return { done: true, left: flight.args.map((unused, i)=>read(esp + 4 + 4 * i)) };
        }
        assert.equal(host.readReg32('esp') >>> 0, STACKS[thread],
            `${where} popped what its export pops`);
        return { done: true, left: null };
    };

    return {
        host,
        stops,
        /** @param {number} thread */
        flying: thread=>flights[thread] !== null,
        /**
         * Calls the routine for `name` on `thread` with `args` pushed as a
         * program pushes them, and runs it for `budget` instructions.
         *
         * @param {string} name @param {number[]} args @param {number} thread
         * @param {number} budget
         * @returns {Slice}
         */
        start(name, args, thread, budget){
            assert.equal(flights[thread], null, 'a thread makes one call at a time');
            const routine = /** @type {{ at: number }} */ (routines.get(name));
            const program = PROGRAMS[thread];
            /** @type {number[]} */
            const code = [];
            for (const value of [...args].reverse())
            {
                code.push(0x68, ...u32(value));
            }
            code.push(0xe8, ...u32((routine.at - (program + code.length + 5)) | 0), 0xf4);
            host.writePhysical(program, new Uint8Array(code));
            /** @type {Record<string, number>} */
            const start = { eax: 0, ecx: 0, edx: 0, esp: STACKS[thread], eflags: 0x202,
                eip: program, ...Object.fromEntries(KEPT) };
            flights[thread] = { name, args, end: program + code.length,
                registers: REGISTERS.map(register=>start[register]) };
            return slice(thread, budget);
        },
        /** @param {number} thread @param {number} budget @returns {Slice} */
        resume: (thread, budget)=>slice(thread, budget),
    };
};

/**
 * What each draw the GPU is given reads, as it would read it: at each submit,
 * the buffers as the queue's writes left them, the copies and the passes
 * encoded since the last one made in order, and every draw's indices, the
 * vertices they name in every buffer bound by the strides its pipeline gives,
 * the uniform ranges bound and -- once the submit has made its copies -- the
 * texels of the textures bound (`seam/frames-contract.itest.js`).
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
        /** @type {{ line: string, textures: any[] }[]} */
        const drawn = [];
        /** @param {any} layout @param {number} slot @param {number} vertex */
        const vertexIn = (layout, slot, vertex)=>{
            const bound = vertexBuffers[slot];
            if (!layout || !bound)
            {
                return '-';
            }
            const at = bound.offset + vertex * layout.arrayStride;
            return [...bytesOf(bound.buffer).subarray(at, at + layout.arrayStride)].join('.');
        };
        /** @param {number} vertex */
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
            if (call.op === 'createRenderPipeline')
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
                    uniforms: call.resolved.map((/** @type {any} */ range)=>digest(
                        bytesOf(range.buffer).subarray(range.offset, range.offset + range.size)))
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
        }
        from = calls.length;
        const made = submit(buffers);
        for (const { line, textures } of drawn)
        {
            reads.push(`${line} texels ${textures.map(texture=>digest(texture.bytes)).join(',')}`);
        }
        return made;
    };
    return reads;
}

/**
 * Until the renderer has nothing left to hand the GPU: its frames are
 * replayed on a chain of its own after the swaps that queue them return.
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
 * Where the contexts draw: on the processor, on a device, or on a device in a
 * graphics worker -- a recorded root here and its twin played at once.
 *
 * @typedef {'processor' | 'device' | 'worker'} Mode
 */

/**
 * The two libraries over one machine's memory: `direct` with no TEB, so every
 * call is its handler's, and `ring` whose contexts the routines write.
 * `calling.thread` is the calling thread on both.
 *
 * @param {ReturnType<typeof machine>} processor @param {Mode} mode
 */
const pair = (processor, mode)=>{
    const { host } = processor;
    const calling = { thread: 0 };
    /** @param {number} from @param {boolean} routines */
    const library = (from, routines)=>{
        let next = from;
        /** @type {string[]} */
        const divergences = [];
        /** What each swap presented. @type {string[]} */
        const presented = [];
        const gpu = mode === 'processor' ? null : createFakeDevice();
        const reads = gpu ? gpuReads(gpu) : [];
        const backend = gpu ? createBackend({ device: gpu.device, queue: gpu.queue,
            presentTo: ()=>{}, now: ()=>0 }) : null;
        const opengl = createOpengl({
            readMemory: (at, length)=>host.readPhysical(at >>> 0, length).slice(),
            windowMemory: (at, length)=>host.readPhysical(at >>> 0, length),
            writeMemory: (at, bytes)=>host.writePhysical(at >>> 0, bytes),
            screen: ()=>({ width: SIDE, height: SIDE }),
            currentThread: ()=>calling.thread + 1,
            currentTeb: routines ? ()=>TEBS[calling.thread] : undefined,
            scratch: { allocate: bytes=>{
                const at = next;
                next += (bytes + 0xfff) & ~0xfff;
                assert.ok(next <= from + SCRATCH.bytes, 'the scratch holds what is made');
                return at;
            } },
            divergence: (api, detail)=>divergences.push(detail),
            present: frame=>presented.push(`${frame.width}x${frame.height} `
                + (gpu ? '' : digest(host.readPhysical(frame.buffer >>> 0,
                    frame.pitch * frame.height)))),
            ...(backend ? {
                backend: ()=>backend,
                createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler',
                    id: `sampler-${JSON.stringify(descriptor)}`, descriptor }),
            } : {}),
            ...(mode === 'worker' ? {
                remote: (/** @type {any} */ factory, /** @type {any} */ services)=>
                    recordedOpengl(factory, services, playedAtOnce(/** @type {any} */ (
                        playedOpengl(factory, services)))),
            } : {}),
        });
        const table = /** @type {Record<string, { handler: (args: number[]) => any }>} */ (
            /** @type {unknown} */ (opengl.table));
        return { opengl, table, divergences, presented, gpu, reads };
    };
    for (const teb of TEBS)
    {
        host.writePhysical(teb + TEB_GL_CONTEXT, new Uint8Array(4));
    }
    const direct = library(SCRATCH.direct, false);
    const ring = library(SCRATCH.ring, true);
    return { direct, ring, calling };
};

/**
 * One step of a program, on thread `on`: a call the routine is given
 * (`ring`) -- for `budget` instructions, the rest when the thread next runs
 * -- or one through the export (`host`), whose answer and the `out` bytes it
 * wrote are compared, kept under `keep` for a later step; or the thread in
 * the middle of a routine run on for `budget` (`resume`). `data` is written
 * at the thread's DATA as the call starts; an argument may be 'out' or a name
 * kept before.
 *
 * @typedef {{ on: number, ring?: string, host?: string, args?: (number | string)[],
 *     data?: Uint8Array, out?: number, keep?: string, budget?: number,
 *     resume?: boolean }} Step
 */

/** Everything of a context's fixed state a getter reaches, by enumerant. */
const ENUMS = [...new Set(Object.values(GL).map(value=>value >>> 0))].sort((a, b)=>a - b);

/**
 * Everything of a context a program can read, an error a query raises kept
 * with it: the queries and capabilities, two units' environment and bound
 * texture, every texture and buffer object the programs name, the picture,
 * and the matrix stacks popped to the bottom.
 *
 * @param {any} context
 * @returns {unknown[]}
 */
function snapshot(context){
    /** @type {unknown[]} */
    const out = [];
    /** @param {string} what @param {unknown} value */
    const keep = (what, value)=>{
        const error = context.glGetError();
        out.push([what, ArrayBuffer.isView(value) ? [.../** @type {any} */ (value)] : value,
            error]);
    };
    for (const query of ENUMS)
    {
        keep(`float ${query}`, context.glGetFloatv(query));
        keep(`enabled ${query}`, context.glIsEnabled(query));
        keep(`pointer ${query}`, context.glGetPointerv(query));
    }
    for (let unit = 0; unit < 2; unit++)
    {
        context.glActiveTextureARB(GL.TEXTURE0 + unit);
        for (const query of [GL.TEXTURE_ENV_MODE, GL.TEXTURE_ENV_COLOR])
        {
            keep(`env ${unit} ${query}`, context.glGetTexEnvfv(GL.TEXTURE_ENV, query));
        }
    }
    context.glActiveTextureARB(GL.TEXTURE0);
    for (const name of TEXTURE_NAMES)
    {
        context.glBindTexture(GL.TEXTURE_2D, name);
        for (const query of [GL.TEXTURE_MIN_FILTER, GL.TEXTURE_MAG_FILTER, GL.TEXTURE_WRAP_S,
            GL.TEXTURE_WRAP_T])
        {
            keep(`texture ${name} ${query}`, context.glGetTexParameterfv(GL.TEXTURE_2D, query));
        }
        for (const query of [GL.TEXTURE_WIDTH, GL.TEXTURE_HEIGHT])
        {
            keep(`texture ${name} level ${query}`,
                context.glGetTexLevelParameteriv(GL.TEXTURE_2D, 0, query));
        }
    }
    for (const name of BUFFER_NAMES)
    {
        context.glBindBufferARB(GL.ARRAY_BUFFER, name);
        const size = context.glGetBufferParameterivARB(GL.ARRAY_BUFFER, GL.BUFFER_SIZE)?.[0] ?? 0;
        keep(`buffer ${name} size`, size);
        keep(`buffer ${name} bytes`, context.glGetBufferSubDataARB(GL.ARRAY_BUFFER, 0, size));
    }
    keep('colour', context.glReadPixels(0, 0, SIDE, SIDE, GL.RGBA, GL.UNSIGNED_BYTE));
    keep('depth', context.glReadPixels(0, 0, SIDE, SIDE, GL.DEPTH_COMPONENT, GL.FLOAT));
    keep('surface', context.framebuffer.bytes);
    for (const [mode, query] of [[GL.MODELVIEW, GL.MODELVIEW_MATRIX],
        [GL.PROJECTION, GL.PROJECTION_MATRIX]])
    {
        context.glMatrixMode(mode);
        for (let depth = 0; depth < 40; depth++)
        {
            keep(`stack ${mode} ${depth}`, context.glGetFloatv(query));
            context.glPopMatrix();
            if (context.glGetError() !== GL.NO_ERROR)
            {
                break;
            }
        }
    }
    return out;
}

const TEXTURE_NAMES = [1, 2, 3];
const BUFFER_NAMES = [1, 2];
/** The vertices a buffer object or a thread's client arrays hold: a position, a colour, a texel. */
const VERTICES = 16;
const VERTEX_BYTES = 32;
const INDICES = 24;

/** Vertices: a position in the view, a colour, a coordinate. @param {number} fill */
const vertexBytes = fill=>{
    const bytes = new Uint8Array(VERTICES * VERTEX_BYTES);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < VERTICES; i++)
    {
        const at = i * VERTEX_BYTES;
        view.setFloat32(at, ((i * 7 + fill) % 17) / 8 - 1, true);
        view.setFloat32(at + 4, ((i * 5 + fill * 3) % 13) / 6 - 1, true);
        view.setFloat32(at + 8, ((i + fill) % 5) / 5, true);
        view.setUint32(at + 12, (0xff000000 | (fill * 0x10325476 + i * 0x01030507)) >>> 0, true);
        view.setFloat32(at + 16, (i % 4) / 3, true);
        view.setFloat32(at + 20, ((i + fill) % 3) / 2, true);
    }
    return bytes;
};
/** Indices within the vertices. @param {number} fill @param {number} count */
const indexBytes = (fill, count)=>new Uint8Array(Uint16Array.from({ length: count },
    (unused, i)=>(fill + i * 5) % VERTICES).buffer);
/** A texture's texels. @param {number} fill @param {number} count */
const texelBytes = (fill, count)=>Uint8Array.from({ length: count * 4 },
    (unused, i)=>(fill * 31 + i * 13) & 0xff);

/**
 * A program of two threads: what each does, and how their calls interleave.
 * Each thread holds a context or none -- 'A' and 'B' are made on threads 0
 * and 1 and may change hands -- and with `shared` the two share their
 * objects, which only the context holding `token` uses: another takes it
 * after the holder's glFlush or glFinish.
 *
 * @param {number} seed @param {number} length @param {boolean} shared
 * @returns {Step[]}
 */
function generate(seed, length, shared){
    const { below, pick } = random(seed);
    /** @type {Step[]} */
    const steps = [];
    /** @type {(string | null)[]} */
    const holds = ['A', 'B'];
    /** @type {number[]} */
    const hdcs = [HDCS[0], HDCS[1]];
    /** @type {Record<string, boolean>} between glBegin and glEnd */
    const inside = { A: false, B: false };
    /** The vertices given since glBegin. @type {Record<string, number>} */
    const given = { A: 0, B: 0 };
    /**
     * Whether the context's array binding is the vertex buffer: a pointer is
     * an offset into it then, and its vertices are all a draw may read --
     * past a buffer object's end is what no program can rely on.
     *
     * @type {Record<string, boolean>}
     */
    const inBuffer = { A: true, B: true };
    /**
     * And whether its index binding is the index buffer, which its indices
     * are offsets into.
     *
     * @type {Record<string, boolean>}
     */
    const inIndices = { A: true, B: true };
    /** @param {string} context */
    const otherOf = context=>(context === 'A' ? 'B' : 'A');
    let token = 'A';
    /** @param {number} on @param {string} name @param {(number | string)[]} [args] @param {Partial<Step>} [more] */
    const call = (on, name, args = [], more = {})=>steps.push({ on, host: name, args, ...more });
    /**
     * A call to a routine, often stopped part of the way in; and then, as
     * often, walked through a few instructions at a time with the other
     * thread calling into the host at each stop -- which, with the objects
     * shared, is where a record not yet whole would be read.
     *
     * @param {number} on @param {string} name @param {(number | string)[]} args
     * @param {Partial<Step>} [more]
     */
    const ring = (on, name, args, more = {})=>{
        const partial = below(3) === 0;
        steps.push({ on, ring: name, args, budget: partial ? 1 + below(60) : WHOLE, ...more });
        if (partial && below(2) === 0)
        {
            for (let stop = below(4); stop >= 0; stop--)
            {
                call(1 - on, pick(['glGetError', 'glFlush', 'glFinish', 'wglGetCurrentContext']));
                steps.push({ on, resume: true, budget: 1 + below(8) });
            }
        }
    };

    /** The objects, made and filled by `on` through its context. @param {number} on */
    const objects = on=>{
        for (const name of TEXTURE_NAMES.slice(0, 2))
        {
            ring(on, 'glBindTexture', [GL.TEXTURE_2D, name]);
            ring(on, 'glTexParameteri', [GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST]);
            call(on, 'glTexImage2D', [GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, GL.RGBA,
                GL.UNSIGNED_BYTE, DATA[on]], { data: texelBytes(name, 16) });
        }
        ring(on, 'glBindBufferARB', [GL.ARRAY_BUFFER, 1]);
        ring(on, 'glBufferDataARB', [GL.ARRAY_BUFFER, VERTICES * VERTEX_BYTES, DATA[on],
            GL.DYNAMIC_DRAW], { data: vertexBytes(on + 1) });
        ring(on, 'glBindBufferARB', [GL.ELEMENT_ARRAY_BUFFER, 2]);
        ring(on, 'glBufferDataARB', [GL.ELEMENT_ARRAY_BUFFER, INDICES * 2, DATA[on],
            GL.STATIC_DRAW], { data: indexBytes(on + 3, INDICES) });
        ring(on, 'glMatrixMode', [GL.PROJECTION]);
        ring(on, 'glOrtho', [...d(-1), ...d(1), ...d(-1), ...d(1), ...d(-1), ...d(1)]);
        ring(on, 'glMatrixMode', [GL.MODELVIEW]);
    };
    objects(0);
    if (shared)
    {
        // B's own view; the objects A made reach it through A's finish.
        call(0, 'glFinish');
        token = 'B';
        inBuffer.B = false;
        inIndices.B = false;
        ring(1, 'glMatrixMode', [GL.PROJECTION]);
        ring(1, 'glOrtho', [...d(-1), ...d(1), ...d(-1), ...d(1), ...d(-1), ...d(1)]);
        ring(1, 'glMatrixMode', [GL.MODELVIEW]);
    }
    else
    {
        objects(1);
    }

    /**
     * Takes the objects for `context` on `on`, held by the other: its holder
     * flushes first, unless it is current nowhere -- its release or its
     * deletion played its ring. What the holder left in them is read at once
     * more often than not, so a change still in its ring shows.
     *
     * @param {number} on @param {string} context @returns {boolean} whether it may use them now
     */
    const take = (on, context)=>{
        if (!shared || token === context)
        {
            return true;
        }
        const holder = holds.indexOf(token);
        if (holder >= 0)
        {
            if (inside[token])
            {
                return false;
            }
            call(holder, pick(['glFlush', 'glFinish']));
        }
        token = context;
        const read = below(3);
        if (read === 0)
        {
            if (!inBuffer[context])
            {
                ring(on, 'glBindBufferARB', [GL.ARRAY_BUFFER, 1]);
                inBuffer[context] = true;
            }
            call(on, 'glGetBufferSubDataARB', [GL.ARRAY_BUFFER, 0, VERTICES * VERTEX_BYTES,
                'out'], { out: VERTICES * VERTEX_BYTES });
        }
        else if (read === 1)
        {
            call(on, 'glGetTexParameteriv', [GL.TEXTURE_2D, pick([GL.TEXTURE_MIN_FILTER,
                GL.TEXTURE_MAG_FILTER]), 'out'], { out: 4 });
        }
        return true;
    };

    /** One thing `on` does with the context it holds. @param {number} on @param {string} context */
    const work = (on, context)=>{
        if (inside[context])
        {
            const roll = below(12);
            if (roll < 3)
            {
                ring(on, 'glColor4ub', [below(256), below(256), below(256), 0x80 + below(128)]);
            }
            else if (roll < 5)
            {
                ring(on, 'glTexCoord2f', [f(below(4) / 3), f(below(4) / 3)]);
            }
            else if (roll < 10 || given[context] < 3)
            {
                given[context]++;
                const xyz = [f(below(9) / 4 - 1), f(below(9) / 4 - 1), f(below(3) / 2 - 0.5)];
                if (below(2) === 0)
                {
                    ring(on, 'glVertex2f', xyz.slice(0, 2));
                }
                else
                {
                    ring(on, 'glVertex3f', xyz);
                }
            }
            else if (roll < 11)
            {
                // Not taken between glBegin and glEnd: an error there.
                ring(on, 'glMatrixMode', [GL.PROJECTION]);
            }
            else
            {
                ring(on, 'glEnd', []);
                inside[context] = false;
            }
            return;
        }
        const roll = below(40);
        if (roll < 3)
        {
            ring(on, pick(['glEnable', 'glDisable']), [pick([GL.BLEND, GL.DEPTH_TEST,
                GL.CULL_FACE, GL.TEXTURE_2D, GL.TEXTURE_2D, GL.SCISSOR_TEST, GL.ALPHA_TEST,
                BAD])]);
        }
        else if (roll < 5)
        {
            ring(on, 'glClearColor', [f(below(5) / 4), f(below(5) / 4), f(below(5) / 4), f(1)]);
            ring(on, 'glClear', [pick([GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT,
                GL.COLOR_BUFFER_BIT, 1])]);
        }
        else if (roll < 8)
        {
            const which = below(7);
            if (which === 0)
            {
                ring(on, 'glMatrixMode', [pick([GL.MODELVIEW, GL.PROJECTION, BAD])]);
            }
            else if (which === 1)
            {
                ring(on, 'glLoadIdentity', []);
            }
            else if (which === 2)
            {
                ring(on, 'glTranslatef', [f(below(5) / 8 - 0.25), f(below(5) / 8 - 0.25), f(0)]);
            }
            else if (which === 3)
            {
                ring(on, 'glRotatef', [f(below(8) * 45), f(0), f(0), f(1)]);
            }
            else if (which === 4)
            {
                ring(on, 'glScalef', [f(0.5 + below(4) / 4), f(0.5 + below(4) / 4), f(1)]);
            }
            else
            {
                ring(on, pick(['glPushMatrix', 'glPopMatrix']), []);
            }
        }
        else if (roll < 10)
        {
            if (below(2) === 0)
            {
                ring(on, 'glColor4ub', [below(256), below(256), below(256), below(256)]);
            }
            else
            {
                ring(on, 'glColor3f', [f(below(5) / 4), f(below(5) / 4), f(below(5) / 4)]);
            }
        }
        else if (roll < 11)
        {
            ring(on, pick(['glViewport', 'glScissor']), [below(3), below(3), SIDE - below(4),
                pick([SIDE - below(4), -1])]);
        }
        else if (roll < 13)
        {
            const which = below(4);
            if (which === 0)
            {
                ring(on, 'glBlendFunc', pick([[GL.SRC_ALPHA, GL.ONE_MINUS_SRC_ALPHA],
                    [GL.ONE, GL.ONE], [GL.ONE, BAD]]));
            }
            else if (which === 1)
            {
                ring(on, 'glDepthFunc', [pick([GL.LESS, GL.ALWAYS, GL.GREATER])]);
            }
            else if (which === 2)
            {
                ring(on, 'glColorMask', [1, below(2), 1, below(2)]);
            }
            else
            {
                ring(on, 'glTexEnvi', [GL.TEXTURE_ENV, GL.TEXTURE_ENV_MODE,
                    pick([GL.MODULATE, GL.REPLACE, GL.DECAL])]);
            }
        }
        else if (roll < 15)
        {
            // Where arrays are drawn from: the bound buffer's offsets or the thread's memory.
            const base = inBuffer[context] ? 0 : ARRAYS[on];
            const which = below(4);
            if (which === 0)
            {
                ring(on, 'glVertexPointer', [pick([2, 3]), GL.FLOAT, VERTEX_BYTES, base]);
            }
            else if (which === 1)
            {
                ring(on, 'glColorPointer', [4, GL.UNSIGNED_BYTE, VERTEX_BYTES, base + 12]);
            }
            else if (which === 2)
            {
                ring(on, 'glTexCoordPointer', [2, GL.FLOAT, VERTEX_BYTES, base + 16]);
            }
            else
            {
                ring(on, pick(['glEnableClientState', 'glDisableClientState']),
                    [pick([GL.VERTEX_ARRAY, GL.COLOR_ARRAY, GL.TEXTURE_COORD_ARRAY])]);
            }
        }
        else if (roll < 16)
        {
            ring(on, pick(['glLineWidth', 'glPointSize']), [f(below(3))]);
        }
        else if (roll < 22)
        {
            const query = below(6);
            if (query < 3)
            {
                call(on, 'glGetError');
            }
            else if (query === 3)
            {
                call(on, 'glGetFloatv', [pick([GL.CURRENT_COLOR, GL.MODELVIEW_MATRIX,
                    GL.COLOR_CLEAR_VALUE, GL.VIEWPORT, GL.PROJECTION_MATRIX]), 'out'], { out: 64 });
            }
            else if (query === 4)
            {
                call(on, 'glIsEnabled', [pick([GL.BLEND, GL.TEXTURE_2D, GL.DEPTH_TEST])]);
            }
            else
            {
                call(on, pick(['glFlush', 'glFinish', 'wglGetCurrentContext']));
            }
        }
        else if (roll < 23)
        {
            call(on, 'wglSwapBuffers', [hdcs[on]]);
        }
        else if (roll < 25)
        {
            // The other thread's context, refused here: it is current there.
            const other = holds[1 - on];
            if (other && below(2) === 0)
            {
                call(on, 'wglMakeCurrent', [hdcs[on], other]);
            }
            else if (other)
            {
                call(on, 'wglDeleteContext', [other]);
            }
        }
        else if (take(on, context))
        {
            useObjects(on, context);
        }
    };

    /**
     * One thing `on` does with the objects, its context holding them.
     *
     * @param {number} on @param {string} context
     */
    const useObjects = (on, context)=>{
        const roll = below(14);
        if (roll < 2)
        {
            ring(on, 'glBindTexture', [pick([GL.TEXTURE_2D, GL.TEXTURE_2D, GL.TEXTURE_2D,
                GL.TEXTURE_1D]), pick([0, ...TEXTURE_NAMES])]);
        }
        else if (roll < 3)
        {
            ring(on, 'glTexParameteri', [GL.TEXTURE_2D, pick([GL.TEXTURE_MIN_FILTER,
                GL.TEXTURE_MAG_FILTER]), pick([GL.NEAREST, GL.LINEAR])]);
        }
        else if (roll < 4)
        {
            call(on, 'glTexSubImage2D', [GL.TEXTURE_2D, 0, below(3), below(3), 2, 2, GL.RGBA,
                GL.UNSIGNED_BYTE, DATA[on]], { data: texelBytes(below(1000), 4) });
        }
        else if (roll < 5)
        {
            call(on, 'glTexImage2D', [GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, GL.RGBA,
                GL.UNSIGNED_BYTE, DATA[on]], { data: texelBytes(below(1000), 16) });
        }
        else if (roll < 6)
        {
            // Each target only ever names its own buffer, or none.
            if (below(2) === 0)
            {
                inBuffer[context] = below(2) === 0;
                ring(on, 'glBindBufferARB', [GL.ARRAY_BUFFER, inBuffer[context] ? 1 : 0]);
            }
            else
            {
                inIndices[context] = below(2) === 0;
                ring(on, 'glBindBufferARB', [GL.ELEMENT_ARRAY_BUFFER, inIndices[context] ? 2 : 0]);
            }
        }
        else if (roll < 8)
        {
            // Within the vertices or the indices whichever is bound, so a draw reads them.
            const first = below(VERTICES);
            const count = 1 + below(VERTICES - first);
            ring(on, 'glBufferSubDataARB', [GL.ARRAY_BUFFER, first * VERTEX_BYTES,
                count * VERTEX_BYTES, DATA[on]], { data: vertexBytes(below(1000))
                .subarray(0, count * VERTEX_BYTES) });
        }
        else if (roll < 9)
        {
            ring(on, 'glBufferSubDataARB', [GL.ELEMENT_ARRAY_BUFFER, 2 * below(INDICES / 2),
                12, DATA[on]], { data: indexBytes(below(1000), 6) });
        }
        else if (roll < 10)
        {
            ring(on, 'glBufferDataARB', [GL.ARRAY_BUFFER, VERTICES * VERTEX_BYTES,
                pick([DATA[on], 0]), pick([GL.DYNAMIC_DRAW, GL.STREAM_DRAW])],
            { data: vertexBytes(below(1000)) });
        }
        else if (roll < 12)
        {
            const count = pick([3, 6]);
            if (below(2) === 0)
            {
                call(on, 'glDrawArrays', [GL.TRIANGLES, below(VERTICES - count), count]);
            }
            else
            {
                // From the bound index buffer, or the thread's own indices.
                call(on, 'glDrawElements', [GL.TRIANGLES, count, GL.UNSIGNED_SHORT,
                    inIndices[context] ? 2 * below(INDICES - count) : DATA[on]],
                { data: indexBytes(below(1000), count) });
            }
        }
        else if (roll < 13)
        {
            call(on, pick(['glGetBufferSubDataARB', 'glGetTexParameteriv']), [], { out: 64 });
            const last = /** @type {Step} */ (steps.at(-1));
            last.args = last.host === 'glGetTexParameteriv'
                ? [GL.TEXTURE_2D, pick([GL.TEXTURE_MIN_FILTER, GL.TEXTURE_MAG_FILTER]), 'out']
                : [GL.ARRAY_BUFFER, VERTEX_BYTES * below(VERTICES - 2), 64, 'out'];
        }
        else
        {
            ring(on, 'glBegin', [pick([GL.TRIANGLES, GL.TRIANGLES, GL.TRIANGLE_FAN, BAD])]);
            inside[context] = (/** @type {Step} */ (steps.at(-1)).args ?? [])[0] !== BAD;
            given[context] = 0;
        }
    };

    /**
     * `context` made again on `on` after its deletion, under its old name:
     * sharing the other's objects again, and with none of its state.
     *
     * @param {number} on @param {string} context
     */
    const remake = (on, context)=>{
        call(on, 'wglCreateContext', [hdcs[on]], { keep: context });
        if (shared)
        {
            call(on, 'wglShareLists', [otherOf(context), context]);
        }
        inBuffer[context] = false;
        inIndices[context] = false;
        inside[context] = false;
    };

    /**
     * A context changing hands: released, or deleted and made again, by the
     * thread holding it; taken by a thread holding none, or deleted by it
     * first, current nowhere.
     *
     * @param {number} on
     */
    const hands = on=>{
        const held = holds[on];
        if (held)
        {
            if (inside[held])
            {
                return;
            }
            if (below(3) === 0)
            {
                call(on, 'wglDeleteContext', [held]);
                remake(on, held);
                call(on, 'wglMakeCurrent', [hdcs[on], held]);
                return;
            }
            call(on, 'wglMakeCurrent', [pick([hdcs[on], 0]), 0]);
            holds[on] = null;
            return;
        }
        const free = ['A', 'B'].filter(context=>!holds.includes(context));
        if (free.length === 0)
        {
            return;
        }
        const context = pick(free);
        if (below(4) === 0)
        {
            call(on, 'wglDeleteContext', [context]);
            remake(on, context);
        }
        hdcs[on] = pick(HDCS);
        call(on, 'wglMakeCurrent', [hdcs[on], context]);
        holds[on] = context;
    };

    let on = 0;
    while (steps.length < length)
    {
        if (below(10) < 3)
        {
            on = 1 - on;
        }
        const roll = below(60);
        if (roll < 2)
        {
            hands(on);
        }
        else if (roll === 2)
        {
            steps.push({ on, resume: true, budget: 1 + below(40) });
        }
        else if (holds[on] === null)
        {
            // No context: a routine leaves its call to the host, which does nothing.
            const which = below(8);
            if (which < 2)
            {
                hands(on);
            }
            else if (which < 4)
            {
                ring(on, 'glEnable', [GL.BLEND]);
            }
            else if (which < 6)
            {
                ring(on, 'glClearColor', [f(1), f(0), f(0), f(1)]);
            }
            else
            {
                call(on, pick(['glGetError', 'wglGetCurrentContext']));
            }
        }
        else
        {
            work(on, /** @type {string} */ (holds[on]));
        }
    }
    // Both threads with their contexts again, out of glBegin/glEnd.
    for (const thread of [0, 1])
    {
        const held = holds[thread];
        if (held && inside[held])
        {
            for (; given[held] < 3; given[held]++)
            {
                ring(thread, 'glVertex2f', [f(given[held] / 2), f(0)]);
            }
            ring(thread, 'glEnd', []);
        }
    }
    for (const thread of [0, 1])
    {
        if (holds[thread] !== null)
        {
            call(thread, 'wglMakeCurrent', [hdcs[thread], 0]);
            holds[thread] = null;
        }
    }
    call(0, 'wglMakeCurrent', [HDCS[0], 'A']);
    call(1, 'wglMakeCurrent', [HDCS[1], 'B']);
    return steps;
}

/**
 * Runs `steps` on both libraries, in lockstep: a call is made on the direct
 * side as it starts, and on the ring's side by the routine, which may stop
 * inside and finish when its thread next runs. What differed, and how many
 * calls the routines took in the guest.
 *
 * @param {Step[]} steps @param {boolean} shared @param {Mode} mode
 */
async function play(steps, shared, mode){
    const processor = machine();
    const { direct, ring, calling } = pair(processor, mode);
    const sides = [direct, ring];
    /** @type {Map<string, number>[]} */
    const named = [new Map(), new Map()];
    /** @type {string[]} */
    const wrong = [];
    let taken = 0;
    let trapped = 0;

    /** @param {number} thread @param {number} side @param {string} name @param {number[]} args */
    const make = (thread, side, name, args)=>{
        calling.thread = thread;
        return sides[side].table[name].handler(args);
    };
    for (const side of [0, 1])
    {
        for (const [thread, hdc] of HDCS.entries())
        {
            assert.equal(make(thread, side, 'wglSetPixelFormat', [hdc, FORMAT, 0]), 1);
            named[side].set('AB'[thread], make(thread, side, 'wglCreateContext', [hdc]));
        }
        if (shared)
        {
            const [a, b] = ['A', 'B'].map(name=>/** @type {number} */ (named[side].get(name)));
            assert.equal(make(0, side, 'wglShareLists', [a, b]), 1);
        }
        for (const [thread, hdc] of HDCS.entries())
        {
            assert.equal(make(thread, side, 'wglMakeCurrent',
                [hdc, /** @type {number} */ (named[side].get('AB'[thread]))]), 1);
        }
    }
    for (const thread of [0, 1])
    {
        processor.host.writePhysical(ARRAYS[thread], vertexBytes(10 + thread));
    }

    /** What each thread last gave a routine, for its trap's handler. @type {string[]} */
    const called = ['', ''];
    /** A routine's call, once it has finished. @param {number} thread @param {Slice} slice */
    const settle = (thread, slice)=>{
        if (!slice.done)
        {
            return;
        }
        if (slice.left)
        {
            trapped++;
            calling.thread = thread;
            ring.table[called[thread]].handler(slice.left);
        }
        else
        {
            taken++;
        }
    };
    /**
     * The thread's call in flight run to its end: a slice also ends early
     * when the translator has a hot start to form.
     *
     * @param {number} thread
     */
    const land = thread=>{
        for (let tries = 0; processor.flying(thread); tries++)
        {
            assert.ok(tries < 100, `the call in flight on thread ${thread} ends`);
            settle(thread, processor.resume(thread, WHOLE));
        }
    };

    steps.forEach((step, at)=>{
        const { on, ring: routine, host, args = [], data, out = 0, keep, budget = WHOLE } = step;
        const where = `step ${at}, ${routine ?? host ?? 'resume'} on thread ${on}`;
        if (step.resume)
        {
            if (processor.flying(on))
            {
                settle(on, processor.resume(on, budget));
            }
            return;
        }
        land(on);
        if (data)
        {
            processor.host.writePhysical(DATA[on], data);
        }
        /** @param {number} side */
        const values = side=>args.map(arg=>(typeof arg === 'number' ? arg >>> 0
            : arg === 'out' ? OUT[side] : /** @type {number} */ (named[side].get(arg))));
        if (routine)
        {
            make(on, 0, routine, values(0));
            called[on] = routine;
            settle(on, processor.start(routine, values(1), on, budget));
            return;
        }
        /** @type {unknown[]} */
        const answers = [0, 1].map(side=>{
            processor.host.writePhysical(OUT[side], new Uint8Array(out));
            const answer = make(on, side, /** @type {string} */ (host), values(side));
            if (keep)
            {
                named[side].set(keep, answer);
            }
            return out ? [answer, [...processor.host.readPhysical(OUT[side], out)]] : answer;
        });
        if (!isDeepStrictEqual(answers[0], answers[1]))
        {
            wrong.push(`${where}: ${JSON.stringify(answers[0])} made at once, `
                + `${JSON.stringify(answers[1])} through the ring`);
        }
    });
    land(0);
    land(1);

    for (const thread of [0, 1])
    {
        calling.thread = thread;
        const states = sides.map(side=>side.opengl.withContext(snapshot));
        const differs = states[0]?.findIndex((entry, i)=>!isDeepStrictEqual(entry,
            states[1]?.[i])) ?? -1;
        if (differs >= 0 || (states[0] === null) !== (states[1] === null))
        {
            wrong.push(`thread ${thread}'s context differs at `
                + `${JSON.stringify(states[0]?.[differs])} against `
                + `${JSON.stringify(states[1]?.[differs])}`);
        }
        // What is drawn after the last swap reaches the GPU too.
        for (const side of [0, 1])
        {
            make(thread, side, 'wglSwapBuffers', [HDCS[thread]]);
        }
    }
    for (const side of sides)
    {
        if (side.gpu)
        {
            await idle(side.gpu);
        }
    }
    for (const what of /** @type {const} */ (['presented', 'divergences', 'reads']))
    {
        if (!isDeepStrictEqual(direct[what], ring[what]))
        {
            const first = direct[what].findIndex((line, i)=>line !== ring[what][i]);
            wrong.push(`${what} differ from ${first} of ${direct[what].length} made at once and `
                + `${ring[what].length} through the ring: ${JSON.stringify(direct[what][first])} `
                + `against ${JSON.stringify(ring[what][first])}`);
        }
    }
    return { wrong, taken, trapped, stops: processor.stops, draws: ring.reads.length,
        presented: ring.presented.length };
}

/** The programs each mode runs: as many seeds as a gate's minute allows on each. */
const SEEDS = /** @type {Record<Mode, number>} */ ({ processor: 120, device: 80, worker: 40 });
const STEPS = 300;

for (const mode of /** @type {Mode[]} */ (['processor', 'device', 'worker']))
{
    test(`two threads drawing through the ring ${mode === 'processor' ? 'on the processor'
        : mode === 'device' ? 'on a device' : 'through a graphics worker'} leave their contexts`
        + ' and the picture as every call made at once would', { timeout: 600000 }, async()=>{
        /** @type {string[]} */
        const wrong = [];
        const total = { taken: 0, trapped: 0, inside: 0, reserved: 0, draws: 0, presented: 0 };
        for (let seed = 0; seed < SEEDS[mode]; seed++)
        {
            const shared = seed % 2 === 1;
            const outcome = await play(generate(seed, STEPS, shared), shared, mode);
            wrong.push(...outcome.wrong.slice(0, 3).map(line=>`seed ${seed}`
                + `${shared ? ' (shared)' : ''}: ${line}`));
            total.taken += outcome.taken;
            total.trapped += outcome.trapped;
            total.inside += outcome.stops.inside;
            total.reserved += outcome.stops.reserved;
            total.draws += outcome.draws;
            total.presented += outcome.presented;
        }
        assert.deepEqual(wrong, [],
            'the ring leaves both threads\' contexts as calls made at once');
        // Not vacuous: the routines took the calls, threads stood inside them
        // -- with their space taken -- while the other ran, and frames were drawn.
        assert.ok(total.taken > 10 * total.trapped, `${total.taken} taken in the guest, `
            + `${total.trapped} left to the host`);
        assert.ok(total.inside > 0 && total.reserved > 0, `${total.inside} stops inside a routine, `
            + `${total.reserved} with its space taken`);
        assert.ok(total.presented > 0, 'frames were presented');
        if (mode !== 'processor')
        {
            assert.ok(total.draws > 0, 'the GPU was given draws');
        }
    });
}

/**
 * The hand-over with no glFlush between: thread 0 changes a texture and a
 * buffer object of the two contexts' objects through its ring, and thread 1,
 * told by the program's own means -- an event, a flag -- reads them back
 * before thread 0 calls into the host again. Made at once, the changes are
 * there, and so they are through the ring: an entry plays the rings of the
 * contexts that share its objects and are current on other threads before
 * its own. GL promises the changes only after a flush; a program that relies
 * on less still sees what it saw with every call made at once.
 */
const UNFLUSHED = 'a change to a shared object waiting in one thread\'s ring is seen by the other '
    + 'thread\'s context with no glFlush between, as the calls made at once show it';
test(UNFLUSHED, async()=>{
    const { wrong } = await play([
        { on: 0, ring: 'glBindTexture', args: [GL.TEXTURE_2D, 1] },
        { on: 0, ring: 'glTexParameteri', args: [GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR] },
        { on: 0, ring: 'glBindBufferARB', args: [GL.ARRAY_BUFFER, 1] },
        { on: 0, ring: 'glBufferDataARB', args: [GL.ARRAY_BUFFER, 16, DATA[0], GL.STATIC_DRAW],
            data: Uint8Array.from({ length: 16 }, (unused, i)=>i + 1) },
        { on: 1, ring: 'glBindTexture', args: [GL.TEXTURE_2D, 1] },
        { on: 1, host: 'glGetTexParameteriv', args: [GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, 'out'],
            out: 4 },
        { on: 1, ring: 'glBindBufferARB', args: [GL.ARRAY_BUFFER, 1] },
        { on: 1, host: 'glGetBufferSubDataARB', args: [GL.ARRAY_BUFFER, 0, 16, 'out'], out: 16 },
    ], true, 'processor');
    assert.deepEqual(wrong, []);
});

/**
 * One context on its own, for what goes wrong with no ring and no second
 * thread in it: the calls made through the exports, answering what a call
 * threw.
 *
 * @param {Mode} mode
 */
const alone = mode=>{
    const processor = machine();
    const { direct, calling } = pair(processor, mode);
    calling.thread = 0;
    /** @param {string} name @param {number[]} args @returns {unknown} */
    const gl = (name, ...args)=>{
        try
        {
            return direct.table[name].handler(args.map(arg=>arg >>> 0));
        }
        catch (e){
            return `${name} threw: ${e instanceof Error ? e.message : e}`;
        }
    };
    assert.equal(gl('wglSetPixelFormat', HDCS[0], FORMAT, 0), 1);
    assert.equal(gl('wglMakeCurrent', HDCS[0], /** @type {number} */ (gl('wglCreateContext',
        HDCS[0]))), 1);
    return { gl, host: processor.host };
};

const FEW = 'a fan between glBegin and glEnd with too few vertices for a triangle draws nothing '
    + 'on a device';
test(FEW, ()=>{
    const { gl } = alone('device');
    gl('glBegin', GL.TRIANGLE_FAN);
    gl('glVertex2f', f(0.5), f(-0.5));
    assert.equal(gl('glEnd'), 0);
    assert.equal(gl('glGetError'), GL.NO_ERROR);
});

const PAST = 'a draw that reads past the end of a buffer object is an answer, not a call '
    + 'that throws';
test(PAST, ()=>{
    /** @type {unknown[]} */
    const answers = [];
    for (const mode of /** @type {Mode[]} */ (['processor', 'device']))
    {
        const { gl, host } = alone(mode);
        host.writePhysical(DATA[0], new Uint8Array(new Float32Array([0, 0, 1]).buffer));
        gl('glBindBufferARB', GL.ARRAY_BUFFER, 1);
        gl('glBufferDataARB', GL.ARRAY_BUFFER, 12, DATA[0], GL.STATIC_DRAW);
        gl('glEnableClientState', GL.VERTEX_ARRAY);
        gl('glVertexPointer', 2, GL.FLOAT, 0, 0);
        // Vertices past the store's end, then indices past it.
        answers.push(gl('glDrawArrays', GL.TRIANGLES, 0, 3));
        gl('glBindBufferARB', GL.ELEMENT_ARRAY_BUFFER, 2);
        gl('glBufferDataARB', GL.ELEMENT_ARRAY_BUFFER, 4, DATA[0], GL.STATIC_DRAW);
        answers.push(gl('glDrawElements', GL.TRIANGLES, 3, GL.UNSIGNED_SHORT, 0));
    }
    assert.deepEqual(answers, [0, 0, 0, 0]);
});
