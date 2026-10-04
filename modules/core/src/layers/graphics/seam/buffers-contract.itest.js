/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Vertex and index buffers through the whole seam, as a gate: whatever a
 * program locks, writes, unlocks and draws, every draw reads the indices and
 * vertices it would read with every call a trap.
 *
 * The program runs on two machines side by side -- the real processor, the
 * bridge's tables and the seam's own handlers, one with the guest code off
 * and one with it on -- and is drawn from a seed out of what a program does
 * with a dynamic vertex buffer and an index buffer: locks of every kind (none,
 * DISCARD, NOOVERWRITE, both, READONLY, the whole buffer by a size of zero),
 * an unlock given twice, draws of both kinds, a draw from user memory (which
 * unbinds the stream and the indices in Direct3D 8), bindings made again, and
 * frames presented. It keeps the promises the flags make and nothing else.
 *
 * What a draw reads is taken on the host, from the device's own calls, as the
 * renderer takes it: each unlock copies the range its lock named out of guest
 * memory, and a draw reads those copies. Each call's answer is compared too.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3D8, D3D9, HWND, SOFTWARE_VERTEXPROCESSING, machine, random,
} from './guest-machine.itest.js';

/** @typedef {import('./guest-machine.itest.js').Version} Version */
/** @typedef {import('./guest-machine.itest.js').Call} Call */

const D3DUSAGE_WRITEONLY = 0x8;
const D3DUSAGE_DYNAMIC = 0x200;
const D3DPOOL_DEFAULT = 0;
const D3DFMT_INDEX16 = 101;
const D3DLOCK_READONLY = 0x10;
const D3DLOCK_NOOVERWRITE = 0x1000;
const D3DLOCK_DISCARD = 0x2000;
const D3DPT_TRIANGLELIST = 4;
/** Position and colour: sixteen bytes a vertex. */
const FVF = 0x042;
const STRIDE = 16;
const VERTICES = 64;
const VERTEX_BYTES = VERTICES * STRIDE;
const INDICES = 96;
const INDEX_BYTES = INDICES * 2;
/** Where the program keeps the vertices it draws from its own memory. */
const USER = 0x20000;

const DEVICE = '#1';
const VB = '#2';
const IB = '#3';

/**
 * What one version names differently.
 *
 * @param {Version} version
 */
const callsOf = version=>{
    const nine = version === D3D9;
    /** @param {string} method @param {any[]} args @returns {Call} */
    const device = (method, args = [])=>({ on: DEVICE, kind: 'device', method, args });
    return {
        createDevice: /** @type {Call} */ ({ on: '#0', kind: 'root', method: 'CreateDevice',
            args: [0, 1, HWND, SOFTWARE_VERTEXPROCESSING, { words: version.presentParameters },
                'out'] }),
        createVertices: device('CreateVertexBuffer', [VERTEX_BYTES,
            D3DUSAGE_DYNAMIC | D3DUSAGE_WRITEONLY, FVF, D3DPOOL_DEFAULT, 'out',
            ...nine ? [0] : []]),
        createIndices: device('CreateIndexBuffer', [INDEX_BYTES,
            D3DUSAGE_DYNAMIC | D3DUSAGE_WRITEONLY, D3DFMT_INDEX16, D3DPOOL_DEFAULT, 'out',
            ...nine ? [0] : []]),
        format: nine ? device('SetFVF', [FVF]) : device('SetVertexShader', [FVF]),
        stream: device('SetStreamSource', nine ? [0, VB, 0, STRIDE] : [0, VB, STRIDE]),
        indices: device('SetIndices', nine ? [IB] : [IB, 0]),
        device,
        /** @param {string} on @param {number} offset @param {number} size @param {number} flags */
        lock: (on, offset, size, flags)=>/** @type {Call} */ ({ on,
            kind: on === VB ? 'vertices' : 'indices', method: 'Lock',
            args: [offset, size, 'out', flags] }),
        /** @param {string} on */
        unlock: on=>/** @type {Call} */ ({ on, kind: on === VB ? 'vertices' : 'indices',
            method: 'Unlock', args: [] }),
        present: device('Present', [0, 0, 0, 0]),
        /** Whether a draw from user memory unbinds the stream and the indices. */
        upUnbinds: !nine,
    };
};

/**
 * One machine with the host's view of the buffers kept beside it: what each
 * unlock copied, and what each draw read of it.
 *
 * @param {Version} version @param {boolean} guestCode
 */
function observed(version, guestCode){
    /** @type {string[]} */
    const reads = [];
    /** @type {Map<any, { bytes: Uint8Array, locking: { offset: number, length: number } | null }>} */
    const held = new Map();
    /** @type {any} */
    let stream = null;
    /** @type {any} */
    let indexBuffer = null;
    let baseVertex = 0;
    /** @type {ReturnType<typeof machine>} */
    let m;
    /** @param {any} buffer @param {number} length */
    const watchBuffer = (buffer, length)=>{
        const record = { bytes: new Uint8Array(length), locking: /** @type {any} */ (null) };
        held.set(buffer, record);
        const lock = buffer.Lock.bind(buffer);
        const unlock = buffer.Unlock.bind(buffer);
        /**
         * @param {number} offset @param {number} size @param {any} out @param {number} flags
         */
        buffer.Lock = (offset, size, out, flags)=>{
            const hr = lock(offset, size, out, flags);
            if (hr === 0 && (flags & D3DLOCK_READONLY) === 0)
            {
                record.locking = { offset, length: size === 0 ? length - offset : size };
            }
            return hr;
        };
        buffer.Unlock = ()=>{
            const hr = unlock();
            if (hr === 0 && record.locking)
            {
                const { offset, length: span } = record.locking;
                record.bytes.set(m.memory.readBytes(buffer.base + offset, span), offset);
                record.locking = null;
            }
            return hr;
        };
    };
    /** @param {number} first @param {number} count */
    const vertexBytes = (first, count)=>{
        const bytes = held.get(stream)?.bytes;
        return bytes ? [...bytes.subarray(first * STRIDE, (first + count) * STRIDE)].join(',')
            : 'no stream';
    };
    /** @param {any} device */
    const onDevice = device=>{
        for (const [method, length] of /** @type {[string, number][]} */ ([
            ['CreateVertexBuffer', VERTEX_BYTES], ['CreateIndexBuffer', INDEX_BYTES]]))
        {
            const make = device[method].bind(device);
            device[method] = (/** @type {any[]} */ ...args)=>{
                const hr = make(...args);
                const out = args.find(arg=>arg && typeof arg === 'object' && 'buffer' in arg);
                if (hr === 0 && out?.buffer)
                {
                    watchBuffer(out.buffer, length);
                }
                return hr;
            };
        }
        const setStream = device.SetStreamSource.bind(device);
        device.SetStreamSource = (/** @type {any[]} */ ...args)=>{
            const hr = setStream(...args);
            if (hr === 0 && args[0] === 0)
            {
                stream = args[1];
            }
            return hr;
        };
        const setIndices = device.SetIndices.bind(device);
        device.SetIndices = (/** @type {any[]} */ ...args)=>{
            const hr = setIndices(...args);
            if (hr === 0)
            {
                indexBuffer = args[0];
                baseVertex = args.length > 1 ? args[1] >>> 0 : 0;
            }
            return hr;
        };
        const draw = device.DrawPrimitive.bind(device);
        /** @param {number} type @param {number} start @param {number} count */
        device.DrawPrimitive = (type, start, count)=>{
            const hr = draw(type, start, count);
            reads.push(`DrawPrimitive ${hr}: ${hr === 0 ? vertexBytes(start, count * 3) : ''}`);
            return hr;
        };
        const drawIndexed = device.DrawIndexedPrimitive.bind(device);
        device.DrawIndexedPrimitive = (/** @type {any[]} */ ...args)=>{
            const hr = drawIndexed(...args);
            // Direct3D 9 names the base vertex in the draw, Direct3D 8 in SetIndices.
            const [base, startIndex, count] = args.length === 6
                ? [args[1] >>> 0, args[4] >>> 0, args[5] >>> 0]
                : [baseVertex, args[3] >>> 0, args[4] >>> 0];
            const indices = held.get(indexBuffer)?.bytes;
            let read = 'no indices';
            if (hr === 0 && indices)
            {
                const order = new Uint16Array(indices.slice(startIndex * 2,
                    (startIndex + count * 3) * 2).buffer);
                read = [...order].map(index=>`${index}:${vertexBytes(base + index, 1)}`).join(' ');
            }
            reads.push(`DrawIndexedPrimitive ${hr}: ${read}`);
            return hr;
        };
        const drawUser = device.DrawPrimitiveUP.bind(device);
        device.DrawPrimitiveUP = (/** @type {any[]} */ ...args)=>{
            const hr = drawUser(...args);
            if (hr === 0 && callsOf(version).upUnbinds)
            {
                stream = null;
                indexBuffer = null;
            }
            return hr;
        };
    };
    m = machine(version, guestCode, { onDevice });
    return { m, reads };
}

/**
 * The program's writes into what a lock handed back: each byte a function of
 * the fill and its place, so a stale byte differs; an index buffer's indices
 * stay within the vertices.
 *
 * @param {boolean} indices @param {number} length @param {number} fill
 */
const bytesFor = (indices, length, fill)=>(indices
    ? new Uint8Array(Uint16Array.from({ length: length / 2 },
        (unused, i)=>(fill + i * 7) % VERTICES).buffer)
    : Uint8Array.from({ length }, (unused, i)=>(fill + i * 13) & 0xff));

/**
 * @typedef {{ kind: 'lock', on: string, offset: number, size: number, flags: number,
 *     fill: number, twice: boolean }
 *     | { kind: 'draw', start: number, triangles: number }
 *     | { kind: 'indexed', start: number, triangles: number }
 *     | { kind: 'user' } | { kind: 'rebind' } | { kind: 'present' }} Step
 */

/**
 * A program that keeps the promises a lock's flags make: a NOOVERWRITE lock
 * writes nothing a draw since the buffer's last lock without it read, and a
 * draw reads only what was written since that buffer's last DISCARD.
 *
 * @param {number} seed @param {number} count @param {boolean} upUnbinds
 * @returns {Step[]}
 */
function generate(seed, count, upUnbinds){
    const { below, pick } = random(seed);
    /** @type {Record<string, { read: Uint8Array, defined: Uint8Array, unit: number }>} */
    const book = {
        [VB]: { read: new Uint8Array(VERTEX_BYTES), defined: new Uint8Array(VERTEX_BYTES),
            unit: STRIDE },
        [IB]: { read: new Uint8Array(INDEX_BYTES), defined: new Uint8Array(INDEX_BYTES),
            unit: 2 },
    };
    /** @type {Step[]} */
    const steps = [];
    let bound = true;
    while (steps.length < count)
    {
        const roll = below(20);
        if (roll < 8)
        {
            const on = pick([VB, IB]);
            const entry = book[on];
            const length = entry.read.length;
            const flags = pick([0, D3DLOCK_DISCARD, D3DLOCK_NOOVERWRITE,
                D3DLOCK_DISCARD | D3DLOCK_NOOVERWRITE, D3DLOCK_READONLY]);
            const units = length / entry.unit;
            const first = (flags & D3DLOCK_DISCARD) !== 0 ? 0 : below(units);
            const whole = below(4) === 0 || (flags & D3DLOCK_DISCARD) !== 0;
            const span = whole ? units - first : 1 + below(Math.min(24, units - first));
            const offset = first * entry.unit;
            const bytes = span * entry.unit;
            if (flags === D3DLOCK_NOOVERWRITE && entry.read.subarray(offset, offset + bytes)
                .includes(1))
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
            steps.push({ kind: 'lock', on, offset, size: whole && below(2) === 0 ? 0 : bytes,
                flags, fill: 1 + below(250), twice: below(8) === 0 });
        }
        else if (roll < 12 && bound)
        {
            const triangles = 1 + below(4);
            const start = below(VERTICES - triangles * 3 + 1);
            const range = [start * STRIDE, (start + triangles * 3) * STRIDE];
            if (book[VB].defined.subarray(...range).includes(0))
            {
                continue;
            }
            book[VB].read.fill(1, ...range);
            steps.push({ kind: 'draw', start, triangles });
        }
        else if (roll < 17 && bound)
        {
            const triangles = 1 + below(4);
            const start = below(INDICES - triangles * 3 + 1);
            const range = [start * 2, (start + triangles * 3) * 2];
            // Every index reaches any vertex, so the vertices must all be there.
            if (book[IB].defined.subarray(...range).includes(0)
                || book[VB].defined.includes(0))
            {
                continue;
            }
            book[IB].read.fill(1, ...range);
            book[VB].read.fill(1);
            steps.push({ kind: 'indexed', start, triangles });
        }
        else if (roll < 18)
        {
            steps.push({ kind: 'user' });
            bound = !upUnbinds;
        }
        else if (roll < 19)
        {
            steps.push({ kind: 'rebind' });
            bound = true;
        }
        else
        {
            steps.push({ kind: 'present' });
        }
    }
    return steps;
}

/**
 * The program run on one machine: its answers, and what its draws read.
 *
 * @param {Version} version @param {boolean} guestCode @param {Step[]} steps
 */
function play(version, guestCode, steps){
    const calls = callsOf(version);
    const { m, reads } = observed(version, guestCode);
    /** @type {string[]} */
    const answers = [];
    /** @param {Call} call */
    const run = call=>{
        const answer = m.run(call);
        answers.push(`${call.method} ${answer.eax.toString(16)}`);
        return answer;
    };
    for (const call of [calls.createDevice, calls.createVertices, calls.createIndices,
        calls.format, calls.stream, calls.indices, calls.device('BeginScene')])
    {
        run(call);
    }
    // Vertices the program draws from its own memory.
    m.memory.writeBytes(USER, bytesFor(false, 3 * STRIDE, 99));
    for (const step of steps)
    {
        if (step.kind === 'lock')
        {
            const answer = run(calls.lock(step.on, step.offset, step.size, step.flags));
            if (answer.eax === 0 && step.flags !== D3DLOCK_READONLY)
            {
                const length = step.size === 0
                    ? (step.on === VB ? VERTEX_BYTES : INDEX_BYTES) - step.offset : step.size;
                m.memory.writeBytes(m.memory.readU32(0x10000),
                    bytesFor(step.on === IB, length, step.fill));
            }
            run(calls.unlock(step.on));
            if (step.twice)
            {
                run(calls.unlock(step.on));
            }
        }
        else if (step.kind === 'draw')
        {
            run(calls.device('DrawPrimitive', [D3DPT_TRIANGLELIST, step.start, step.triangles]));
        }
        else if (step.kind === 'indexed')
        {
            run(calls.device('DrawIndexedPrimitive', version === D3D9
                ? [D3DPT_TRIANGLELIST, 0, 0, VERTICES, step.start, step.triangles]
                : [D3DPT_TRIANGLELIST, 0, VERTICES, step.start, step.triangles]));
        }
        else if (step.kind === 'user')
        {
            run(calls.device('DrawPrimitiveUP', [D3DPT_TRIANGLELIST, 1, USER, STRIDE]));
        }
        else if (step.kind === 'rebind')
        {
            run(calls.stream);
            run(calls.indices);
        }
        else
        {
            run(calls.device('EndScene'));
            run(calls.present);
            run(calls.device('BeginScene'));
        }
    }
    // What is still in the ring is made before the frame is shown.
    run(calls.device('EndScene'));
    run(calls.present);
    return { answers, reads };
}

/**
 * Where two runs part: the first answer or draw that differs, with what led
 * up to it.
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
    return `${what} ${index}: every call a trap gives ${trap[index] ?? 'nothing'}, the guest`
        + ` code ${guest[index] ?? 'nothing'}`;
};

for (const version of [D3D8, D3D9])
{
    const name = version === D3D9 ? 'Direct3D 9' : 'Direct3D 8';
    test(`${name}: a draw reads the indices and vertices it would with every call a trap,`
        + ' whatever was locked, written and unlocked before it', ()=>{
        /** @type {string[]} */
        const wrong = [];
        for (let seed = 1; seed <= 60 && wrong.length === 0; seed++)
        {
            const steps = generate(seed, 160, callsOf(version).upUnbinds);
            const trap = play(version, false, steps);
            const guest = play(version, true, steps);
            for (const found of [parting(trap.answers, guest.answers, 'answer'),
                parting(trap.reads, guest.reads, 'draw')])
            {
                if (found)
                {
                    wrong.push(`seed ${seed}: ${found}`);
                }
            }
        }
        assert.deepEqual(wrong, []);
    });
}
