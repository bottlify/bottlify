/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One run of `modules/core/src/sound-delivery.itest.js`, in a worker of its own: the engine on
 * that worker's thread as on a page's engine thread, the audio worklet on a
 * worker beside it, and what the worklet played measured. Not on the test's
 * own thread: `node:test` tracks every promise there (async hooks), which on
 * the engine's thread cost a collection every 75 ms and stalls of 10 to 30 ms
 * nothing on a page has - the very gaps the test is there to find.
 *
 * Its `workerData`: `{ program, windows, stall?, across? }`, `stall` holding the
 * engine's thread `{ ms }` every `{ everyMs }`, `across` the program in a worker
 * of its own as where processes run at once (`concurrency` 2); it posts back
 * `{ exit, heard: { first, frames, hz, gaps }, win32 }`.
 */

import { MessageChannel, Worker, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { createApp } from '../../modules/core/src/index.js';
import { RATE, TONE_HZ, directSoundTone, waveOutTone, wasapiTone } from './tone-program.mjs';

const WORKLET = fileURLToPath(new URL('../../modules/core/src/layers/audio/output/worklet.js',
    import.meta.url));

/** A game's frame on the main thread, in rounds of the busy loop. */
const HEAVY_FRAME = 10_000_000;

/** The programs a run may play, by name. */
const PROGRAMS = { wasapi: ()=>wasapiTone(), 'wasapi-busy': ()=>wasapiTone({ busy: true }),
    'wasapi-heavy': ()=>wasapiTone({ busy: true,
        work: Number(process.env.SOUND_WORK ?? HEAVY_FRAME) }),
    waveout: waveOutTone, dsound: directSoundTone };

/**
 * The page's audio thread: a worker that runs the real worklet over the
 * run's sound table, a block of 128 frames every 128/48000 s by its own clock
 * whatever the engine is doing, and keeps the left channel it played. The
 * tables each process plays into are handed to it as the page's speaker
 * hands them (`speaker.js`), and taken between two blocks.
 *
 * @param {any} app @param {number} seconds
 */
function listen(app, seconds){
    const heard = new SharedArrayBuffer(Math.ceil(seconds * RATE) * 4);
    const stop = new SharedArrayBuffer(4);
    const { port1: tables, port2: tablesThere } = new MessageChannel();
    const unsubscribe = [
        app.on('sound-table', (/** @type {any} */ event)=>
            tables.postMessage({ type: 'table', id: event.id, table: event.table })),
        app.on('sound-table-closed', (/** @type {any} */ event)=>
            tables.postMessage({ type: 'untable', id: event.id })),
    ];
    const worker = new Worker(`
        const { workerData, receiveMessageOnPort } = require('node:worker_threads');
        const vm = require('node:vm');
        const { readFileSync } = require('node:fs');
        let registered = null;
        class AudioWorkletProcessor {
            constructor(){ this.port = { onmessage: null, postMessage(){} }; }
        }
        const context = vm.createContext({ AudioWorkletProcessor,
            registerProcessor: (name, cls)=>{ registered = cls; },
            Atomics, Math, Float32Array, Int32Array, Uint8Array, ArrayBuffer, SharedArrayBuffer,
            sampleRate: ${RATE} });
        vm.runInContext(readFileSync(workerData.worklet, 'utf8'), context);
        const processor = new registered({
            processorOptions: { table: workerData.table, channels: 2 } });
        const heard = new Float32Array(workerData.heard);
        const stop = new Int32Array(workerData.stop);
        const nap = new Int32Array(new SharedArrayBuffer(4));
        const block = 128;
        const started = performance.now();
        for (let at = 0; at + block <= heard.length && Atomics.load(stop, 0) === 0; at += block)
        {
            const due = started + at / ${RATE} * 1000;
            const wait = due - performance.now();
            if (wait > 0) Atomics.wait(nap, 0, 0, wait);
            for (let message; (message = receiveMessageOnPort(workerData.tables));)
            {
                processor.port.onmessage({ data: message.message });
            }
            const out = [[new Float32Array(block), new Float32Array(block)]];
            processor.process([], out);
            heard.set(out[0][0], at);
        }
    `, { eval: true, workerData: { table: app.audio.memory().table, heard, stop,
        worklet: WORKLET, tables: tablesThere }, transferList: [tablesThere] });
    // Taken now: a run longer than the listening has the worker gone before it is asked to stop.
    const exited = new Promise(resolve=>worker.once('exit', resolve));
    return {
        heard: new Float32Array(heard),
        done: ()=>{
            Atomics.store(new Int32Array(stop), 0, 1);
            unsubscribe.forEach(off=>off?.());
            tables.close();
            return exited;
        },
    };
}

/**
 * What came out: where the tone starts and ends, how long it lasted, its
 * pitch by zero crossings, and every run of silence inside it longer than a
 * sine at this pitch ever sits at zero.
 *
 * @param {Float32Array} heard
 */
function measure(heard){
    let first = -1;
    let last = -1;
    for (let at = 0; at < heard.length; at++)
    {
        if (Math.abs(heard[at]) > 0.01)
        {
            if (first < 0)
            {
                first = at;
            }
            last = at;
        }
    }
    /** @type {{ at: number, frames: number }[]} */
    const gaps = [];
    let crossings = 0;
    let quiet = 0;
    for (let at = first + 1; at <= last; at++)
    {
        if ((heard[at - 1] < 0) !== (heard[at] < 0))
        {
            crossings++;
        }
        if (heard[at] === 0)
        {
            quiet++;
        }
        else
        {
            if (quiet > 8)
            {
                gaps.push({ at: at - first - quiet, frames: quiet });
            }
            quiet = 0;
        }
    }
    // Where the tone skipped: a half period between two crossings that is not
    // the tone's, by more than a frame - sound dropped, not silence.
    /** @type {{ at: number, frames: number }[]} */
    const skips = [];
    let crossed = -1;
    for (let at = first + 1; at <= last; at++)
    {
        if ((heard[at - 1] < 0) !== (heard[at] < 0))
        {
            const half = RATE / TONE_HZ / 2;
            if (crossed >= 0 && Math.abs(at - crossed - half) > 1.5)
            {
                skips.push({ at: at - first, frames: at - crossed - half });
            }
            crossed = at;
        }
    }
    const frames = last - first + 1;
    return { first, frames, hz: crossings / 2 / (frames / RATE), gaps, skips };
}

const program = PROGRAMS[/** @type {keyof typeof PROGRAMS} */ (workerData.program)];
// The engine on this thread, in the mode a cross-origin isolated page runs it in,
// translating in a worker as a page does: node has no global Worker, and cork
// translated on the engine's thread here, 110 ms at once on a slow machine as the
// tone started - a gap the page never has.
const app = await createApp({ host: 'thread', mode: 'isolated', executable: program(),
    imagePath: 'C:\\tone.exe', windows: workerData.windows,
    audio: { drained: true, sampleRate: RATE }, cork: { config: { worker: true } },
    ...workerData.across ? { concurrency: 2 } : {} });
const ear = listen(app, 12);
// The engine's thread held now and then, as a busy frame holds a page's: the
// worklet plays on regardless, and what reaches it must already be there.
const { everyMs, ms } = workerData.stall ?? {};
const stalls = everyMs ? setInterval(()=>{
    const until = performance.now() + ms;
    while (performance.now() < until)
    {
        // Held.
    }
}, everyMs) : null;
const exit = await app.run({ timeoutMs: 20000 }).catch((/** @type {any} */ error)=>
    String(error?.message ?? error));
if (stalls)
{
    clearInterval(stalls);
}
await ear.done();
const layers = await app.diagnostics();
const win32 = layers.find((/** @type {any} */ table)=>table.name === 'win32')?.metrics;
const audio = layers.find((/** @type {any} */ table)=>table.name === 'audio')?.metrics;
parentPort?.postMessage({ exit, heard: measure(ear.heard),
    win32: { streams: win32?.wasapiStreams ?? null, timers: win32?.multimediaTimers ?? null,
        audio: audio ?? null } });
await app.dispose();
