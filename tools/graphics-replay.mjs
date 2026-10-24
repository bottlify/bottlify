/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a program's real frames cost the graphics worker, in node: a capture
 * of everything the worker was sent in a run (`game.mjs --graphics-capture
 * FILE`, the frames to measure marked with `captureFrames(n)`) played through
 * the played side of an engine -- this checkout's, or `--root DIR`'s -- over a
 * quiet fake GPU. Every root is made as it was, every batch is played in its
 * order; the frames after the mark are measured: the played side's own time
 * a frame, both the calls of its batches and the replay onto the device, and
 * what it handed the device -- draws, bind groups, bytes to copy.
 *
 *     node tools/graphics-replay.mjs FILE [--root DIR] [--reps N] [--profile OUT]
 *         [--all] [--uploads] [--json] [--digest OUT]
 *
 * `--reps` plays the capture that many times, each on a worker of its own,
 * and reports every one: the first frames of the measured window are warm
 * already, since the run's load and everything before the mark were played
 * before it. `--profile OUT` writes a CPU profile of the measured frames of
 * the last rep. `--all` measures every frame from the first, for a capture
 * that was never marked. `--uploads` prints what the played device's
 * buffers moved over the measured frames -- each dynamic buffer's writes,
 * bytes written and bytes marked by unlocks and draws, and the uniform
 * ring's -- from the diagnostics the run asked the device for in them (the
 * driver asks every few seconds), the first answer after the mark against
 * the last. The bytes a capture zeroed (vertices, texels) cost
 * as much to move as the program's; a device's own work -- a real GPU's
 * encoding, its copies -- is not here: what the frame costs on a device is
 * this plus that.
 *
 * `--digest OUT` writes, for every batch that presents, a digest of all the
 * device was asked meanwhile -- each call, the objects it names by the order
 * they were made, the bytes written by their content -- one line a batch: two
 * checkouts that play a capture into the same lines handed the GPU the same
 * work, and the first line that differs is where they parted. The device then
 * keeps its log, so the times are not a measurement.
 */

import { createReadStream, writeFileSync } from 'node:fs';
import { createGunzip } from 'node:zlib';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Session } from 'node:inspector/promises';
import { CAPTURE, captureRecords } from '../modules/core/src/layers/graphics/remote/capture.js';

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const flag = (name, fallback)=>(args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const file = args.find((arg, index)=>!arg.startsWith('--')
    && (index === 0 || !['--root', '--reps', '--profile', '--digest'].includes(args[index - 1])));
if (!file)
{
    console.error('usage: node tools/graphics-replay.mjs FILE [--root DIR] [--reps N]'
        + ' [--profile OUT] [--all] [--uploads] [--json] [--digest OUT]');
    process.exit(2);
}
const root = pathToFileURL(`${resolve(flag('--root', '.'))}/`).href;
const reps = Number(flag('--reps', '1'));
const profileOut = flag('--profile', '');
const json = args.includes('--json');
const all = args.includes('--all');
const uploads = args.includes('--uploads');
const digestOut = flag('--digest', '');

const graphics = `${root}modules/core/src/layers/graphics/`;
const { serveGraphics } = await import(`${graphics}remote/worker.js`);
const { createFakeDevice } = await import(`${graphics}webgpu/internal/fake-device.js`);
const { LEND, LEND_SLOTS, createLendingBuffers } = await import(`${graphics}remote/lending.js`);

/**
 * The capture's records as they are decompressed: zeros keep their places, so
 * a run's capture is gigabytes once open, and a rep reads it again.
 */
const records = ()=>captureRecords(createReadStream(file)
    .pipe(createGunzip({ chunkSize: 1 << 20 })));

/** Turns of the event loop: what a played frame leaves to promises settles in them. */
const settle = async(turns = 2)=>{
    for (let turn = 0; turn < turns; turn++)
    {
        await new Promise(done=>setImmediate(done));
    }
};

/** @param {number[]} values @param {number} q */
const quantile = (values, q)=>{
    const sorted = [...values].sort((a, b)=>a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};

/**
 * A running digest of what the device is asked: two FNV-1a lanes over every
 * call's operation and arguments, a device object by its id (the order it
 * was made in), bytes by their content, a dictionary by its keys in order.
 */
const createDigest = ()=>{
    let a = 0x811c9dc5;
    let b = 0x2f6b1a77;
    let count = 0;
    const scratch = new Float64Array(1);
    const words = new Int32Array(scratch.buffer);
    /** @param {number} word */
    const mix = word=>{
        a = Math.imul(a ^ word, 0x01000193);
        b = Math.imul(b ^ word, 0x5bd1e995);
    };
    /** @param {string} text */
    const mixText = text=>{
        mix(text.length);
        for (let index = 0; index < text.length; index++)
        {
            mix(text.charCodeAt(index));
        }
    };
    /** @param {Uint8Array} bytes */
    const mixBytes = bytes=>{
        mix(bytes.length);
        for (let index = 0; index < bytes.length; index++)
        {
            mix(bytes[index]);
        }
    };
    /** @param {any} value @param {number} depth */
    const visit = (value, depth)=>{
        if (value === null || value === undefined)
        {
            mixText(String(value));
            return;
        }
        if (typeof value === 'number')
        {
            scratch[0] = value;
            mix(words[0]);
            mix(words[1]);
            return;
        }
        if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint')
        {
            mixText(String(value));
            return;
        }
        if (typeof value !== 'object')
        {
            return;
        }
        if (typeof value.kind === 'string' && typeof value.id === 'string')
        {
            mixText(value.id);
            return;
        }
        if (ArrayBuffer.isView(value))
        {
            mixBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
            return;
        }
        if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer)
        {
            mixBytes(new Uint8Array(value));
            return;
        }
        if (depth > 8)
        {
            mixText('deeper');
            return;
        }
        if (Array.isArray(value))
        {
            mix(value.length);
            for (const item of value)
            {
                visit(item, depth + 1);
            }
            return;
        }
        for (const key of Object.keys(value).sort())
        {
            mixText(key);
            visit(value[key], depth + 1);
        }
    };
    return {
        /** @param {any} call */
        add: call=>{
            count++;
            visit(call, 0);
            return 0;
        },
        /** The digest of the calls since the last take, and how many they were. */
        take: ()=>{
            const line = `${(a >>> 0).toString(16).padStart(8, '0')}`
                + `${(b >>> 0).toString(16).padStart(8, '0')} ${count}`;
            a = 0x811c9dc5;
            b = 0x2f6b1a77;
            count = 0;
            return line;
        },
    };
};

/** @param {boolean} profiled */
const play = async profiled=>{
    const gpu = createFakeDevice({ quiet: digestOut === '' });
    const digest = digestOut === '' ? null : createDigest();
    if (digest)
    {
        gpu.device.calls.push = digest.add;
    }
    /** One line a batch that presented: its place, its presents, the digest. @type {string[]} */
    const digests = [];
    let batches = 0;
    Object.assign(gpu.device, { queue: gpu.queue, features: new Set(),
        createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }) });
    /** @type {any} */
    const scope = { postMessage: ()=>{}, onmessage: null };
    serveGraphics(scope, {
        gpu: { requestAdapter: async()=>({ features: new Set(), info: { vendor: 'fake' },
            requestDevice: async()=>gpu.device }) },
        canvas: (/** @type {number} */ width, /** @type {number} */ height)=>
            Object.assign(gpu.canvas, { width, height,
                transferToImageBitmap: ()=>({ width, height, close: ()=>{} }) }),
    });
    scope.onmessage({ data: { type: 'open', frames: 'count' } });
    await settle();
    /** @type {Map<number, MessagePort>} */
    const ports = new Map();
    /**
     * A lending root's slots: what the run lent it was read in place, not
     * captured, so each batch finds every slot lent and reads its bytes out
     * of a memory of zeros the size of the run's.
     *
     * @type {Map<number, Int32Array>}
     */
    const lent = new Map();
    /** @type {MessagePort[]} */
    const others = [];
    let measuring = all;
    /**
     * The device's diagnostics the run asked for while measuring: the first
     * and the last answer.
     *
     * @type {any[]}
     */
    const told = [];
    /** @type {{ ms: number, draws: number, bindGroups: number, written: number, writes: number,
     *     texels: number }[]} */
    const frames = [];
    let frame = { ms: 0, draws: 0, bindGroups: 0, written: 0, writes: 0, texels: 0 };
    let before = { ...gpu.stats };
    /** @type {Session | null} */
    let session = null;
    for await (const record of records())
    {
        if (record.kind === CAPTURE.ROOT)
        {
            const { port1, port2 } = new MessageChannel();
            // What the played side answers goes nowhere: the capture is what
            // the program did with the answers it had. Its diagnostics are
            // kept, for `--uploads`.
            port1.onmessage = (/** @type {MessageEvent} */ event)=>{
                if (measuring && event.data?.type === 'diagnostics')
                {
                    told[told.length === 0 ? 0 : 1] = { diagnostics: event.data.diagnostics,
                        frames: frames.length };
                }
            };
            others.push(port1);
            const made = record.json;
            const lending = made.lending && made.memory > 0 ? createLendingBuffers() : null;
            if (lending)
            {
                lent.set(record.root, new Int32Array(lending.slots));
            }
            scope.onmessage({ data: { type: 'root', api: made.api, options: made.options ?? {},
                port: port2, lending, source: made.source,
                memory: lending ? new Uint8Array(new SharedArrayBuffer(made.memory)) : null } });
            while (!port2.onmessage)
            {
                await settle(1);
            }
            ports.set(record.root, port2);
        }
        else if (record.kind === CAPTURE.CALLS)
        {
            const port = /** @type {any} */ (ports.get(record.root));
            const states = lent.get(record.root);
            if (states)
            {
                for (let slot = 0; slot < LEND_SLOTS; slot++)
                {
                    states[slot * 2] = LEND.LENT;
                }
            }
            const began = performance.now();
            port.onmessage({ data: { type: 'calls', buffer: record.buffer, at: 0 } });
            batches++;
            if ((record.presents ?? 0) > 0)
            {
                await settle();
                if (digest)
                {
                    digests.push(`${batches} ${record.presents} ${digest.take()}`);
                }
            }
            if (measuring)
            {
                frame.ms += performance.now() - began;
                for (let left = record.presents ?? 0; left > 0; left--)
                {
                    const now = gpu.stats;
                    frame.draws = now.draws - before.draws;
                    frame.bindGroups = now.bindGroups - before.bindGroups;
                    frame.written = now.written - before.written;
                    frame.writes = now.writes - before.writes;
                    frame.texels = now.texels - before.texels;
                    before = { ...now };
                    frames.push(frame);
                    frame = { ms: 0, draws: 0, bindGroups: 0, written: 0, writes: 0, texels: 0 };
                }
            }
        }
        else if (record.kind === CAPTURE.CLOSE)
        {
            /** @type {any} */ (ports.get(record.root))?.onmessage({ data: { type: 'close' } });
            ports.delete(record.root);
        }
        else if (record.kind === CAPTURE.MARK)
        {
            measuring = true;
            before = { ...gpu.stats };
            if (profiled)
            {
                session = new Session();
                session.connect();
                await session.post('Profiler.enable');
                await session.post('Profiler.start');
            }
        }
    }
    if (session)
    {
        const { profile } = await session.post('Profiler.stop');
        writeFileSync(profileOut, JSON.stringify(profile));
        session.disconnect();
    }
    // Answers posted in the last batches arrive before the ports close.
    await settle(4);
    for (const port of [...ports.values(), ...others])
    {
        port.close();
    }
    return { frames, told, digests };
};

/**
 * What each dynamic buffer and the uniform ring moved between two of the
 * device's diagnostics, the heaviest first, and over how many frames.
 *
 * @param {{ diagnostics: any, frames: number }} from
 * @param {{ diagnostics: any, frames: number }} to
 */
const uploadsBetween = (from, to)=>{
    const first = from.diagnostics;
    const last = to.diagnostics;
    // By number: buffers of one size share a label.
    const before = new Map((first?.uploads?.buffers ?? []).map((/** @type {any} */ one)=>
        [one.id, one]));
    const lines = [];
    for (const one of last?.uploads?.buffers ?? [])
    {
        const was = before.get(one.id);
        if (was === undefined)
        {
            // Not among the heaviest at the first answer: what it moved since
            // is not known.
            continue;
        }
        lines.push({ label: `${one.label} #${one.id}`, size: one.size,
            writes: one.writes - was.writes, written: one.written - was.written,
            marked: one.marked - was.marked });
    }
    const ring = last?.uploads?.uniforms ?? {};
    const ringBefore = first?.uploads?.uniforms ?? {};
    return {
        frames: to.frames - from.frames,
        buffers: lines.sort((a, b)=>b.written - a.written),
        uniforms: { writes: (ring.writes ?? 0) - (ringBefore.writes ?? 0),
            written: (ring.written ?? 0) - (ringBefore.written ?? 0),
            laid: (ring.laid ?? 0) - (ringBefore.laid ?? 0) },
    };
};

const results = [];
for (let rep = 0; rep < reps; rep++)
{
    const { frames, told, digests } = await play(rep === reps - 1 && profileOut !== '');
    if (digestOut !== '' && rep === reps - 1)
    {
        writeFileSync(digestOut, `${digests.join('\n')}\n`);
        console.log(`digests of ${digests.length} presenting batches: ${digestOut}`
            + ' (the device kept its log: the times below are not a measurement)');
    }
    if (frames.length === 0)
    {
        console.error(`${file}: no frame after a mark in the capture -- nothing to measure`
            + ' (the run is marked with captureFrames(n); --all measures every frame)');
        process.exit(1);
    }
    const ms = frames.map(one=>one.ms);
    const total = ms.reduce((sum, one)=>sum + one, 0);
    const draws = frames.reduce((sum, one)=>sum + one.draws, 0);
    const sum = (/** @type {'bindGroups' | 'written' | 'writes' | 'texels'} */ key)=>
        frames.reduce((acc, one)=>acc + one[key], 0);
    results.push({
        rep, frames: frames.length,
        msPerFrame: total / Math.max(1, frames.length),
        median: quantile(ms, 0.5), p90: quantile(ms, 0.9),
        drawsPerFrame: draws / Math.max(1, frames.length),
        usPerDraw: draws > 0 ? total * 1000 / draws : 0,
        bindGroupsPerFrame: sum('bindGroups') / Math.max(1, frames.length),
        writesPerFrame: sum('writes') / Math.max(1, frames.length),
        writtenKBPerFrame: sum('written') / 1024 / Math.max(1, frames.length),
        texelsKBPerFrame: sum('texels') / 1024 / Math.max(1, frames.length),
        ...(uploads ? { uploads: told.length < 2 ? null
            : uploadsBetween(told[0], told[1]) } : {}),
    });
}
if (json)
{
    console.log(JSON.stringify({ file, root, results }));
}
else
{
    for (const one of results)
    {
        console.log(`rep ${one.rep}: ${one.frames} frames, ${one.msPerFrame.toFixed(2)} ms a frame`
            + ` (median ${one.median.toFixed(2)}, p90 ${one.p90.toFixed(2)}),`
            + ` ${one.drawsPerFrame.toFixed(0)} draws, ${one.usPerDraw.toFixed(2)} us a draw,`
            + ` ${one.bindGroupsPerFrame.toFixed(0)} bind groups,`
            + ` ${one.writesPerFrame.toFixed(0)} buffer writes`
            + ` of ${one.writtenKBPerFrame.toFixed(0)} KB,`
            + ` ${one.texelsKBPerFrame.toFixed(0)} KB of texels a frame`);
        if (uploads)
        {
            if (!one.uploads)
            {
                console.log('  uploads: not measured (fewer than two diagnostics asked for'
                    + ' while measuring)');
                continue;
            }
            const mb = (/** @type {number} */ bytes)=>(bytes / 1048576).toFixed(1);
            console.log(`  over ${one.uploads.frames} frames:`);
            console.log(`  uniform ring: ${one.uploads.uniforms.writes} writes,`
                + ` ${mb(one.uploads.uniforms.written)} MB written,`
                + ` ${mb(one.uploads.uniforms.laid)} MB of blocks`);
            for (const buffer of one.uploads.buffers.slice(0, 12))
            {
                console.log(`  ${buffer.label} (${mb(buffer.size)} MB): ${buffer.writes} writes,`
                    + ` ${mb(buffer.written)} MB written, ${mb(buffer.marked)} MB marked`);
            }
        }
    }
    if (profileOut)
    {
        console.log(`profile of the measured frames: ${profileOut}`);
    }
}
