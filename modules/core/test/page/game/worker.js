/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The harness, in a worker: the page hands over its canvas and a request, and
 * everything else -- the device, the engine, the read-back -- happens here.
 *
 * The call log is sent across in batches as it grows rather than at the end,
 * because a run that never finishes is exactly the run whose log matters.
 */

import { createHarness } from './harness.js';
import { createMacrotask } from '../../../src/app.js';
import { workerPacing } from '../../../src/host/serve.js';

/** How often the call log so far is handed to the page. */
const CALLS_MS = 500;

/** @type {import('./harness.js').Harness | null} */
let harness = null;
let sentLines = 0;

// The loop of a thread that is nobody else's: an idle machine sleeps until
// the guest's next deadline or a message from the page, and turns otherwise
// run back to back. Nothing here counts what the page posts, so a yield is
// taken on the clock rather than on a signal word.
/** @type {(() => void) | null} */
let poked = null;
/** @type {Promise<void> | null} */
let poking = null;
const poke = ()=>{
    if (!poking)
    {
        poking = new Promise(resolve=>{
            poked = ()=>{
                poking = null;
                poked = null;
                resolve();
            };
        });
    }
    return poking;
};
const pacing = workerPacing({
    macrotask: createMacrotask(),
    poke,
    signalled: ()=>false,
    now: ()=>performance.now(),
});

self.addEventListener('error', event=>{
    self.postMessage({ type: 'error', text: event.message });
});
self.addEventListener('unhandledrejection', event=>{
    const reason = /** @type {any} */ (event).reason;
    self.postMessage({ type: 'error',
        text: `unhandled:${reason && reason.message ? reason.message : String(reason)}` });
});

const flushCalls = ()=>{
    if (!harness)
    {
        return;
    }
    const total = harness.logLines();
    if (total > sentLines)
    {
        const lines = harness.drainLog(sentLines, total - sentLines).split(String.fromCharCode(10));
        sentLines = total;
        self.postMessage({ type: 'calls', lines });
    }
};

self.onmessage = ({ data })=>{
    poked?.();
    switch (data.type)
    {
        case 'canvas':
            harness = createHarness(data.canvas, {
                pacing: data.pacing === 'event' ? pacing : undefined,
                // The sound is read on the page, off this thread, as a
                // launcher's worklet reads it: a device here would stand still
                // whenever the engine does, and hide every refill that came late.
                drainElsewhere: (table, sampleRate)=>self.postMessage(
                    { type: 'audioTable', table, sampleRate }),
            });
            harness.gpu.then(gpu=>self.postMessage({ type: 'gpu', gpu }));
            setInterval(flushCalls, CALLS_MS);
            break;
        case 'start':
            harness?.run(data.request).then(
                result=>{
                    flushCalls();
                    self.postMessage({ type: 'result', result });
                },
                error=>{
                    flushCalls();
                    self.postMessage({ type: 'result', result: {
                        ok: false,
                        error: String(error && error.message),
                        stack: String(error && error.stack).split('\n').slice(0, 8).join('\n'),
                    } });
                });
            break;
        case 'frameReport':
            self.postMessage({ type: 'answer', id: data.id,
                value: harness?.frameReport() ?? null });
            break;
        case 'frameShot':
            (harness ? harness.frameShot() : Promise.resolve(null)).then(value=>{
                self.postMessage({ type: 'answer', id: data.id, value });
            });
            break;
        case 'dumpFrames':
            try
            {
                self.postMessage({ type: 'answer', id: data.id,
                    value: harness?.dumpFrames(data.frames) ?? 0 });
            }
            catch (e){
                self.postMessage({ type: 'answer', id: data.id,
                    value: String(e instanceof Error ? e.message : e) });
            }
            break;
        case 'lastDumped':
            self.postMessage({ type: 'answer', id: data.id,
                value: harness?.lastDumped() ?? null });
            break;
        case 'debug':
            // A switch may answer later (`pick` waits for the graphics
            // worker): the answer goes when it settles, a refusal as its message.
            Promise.resolve()
                .then(()=>harness?.debug(data.name, ...data.args) ?? null)
                .then(value=>self.postMessage({ type: 'answer', id: data.id, value }),
                    error=>self.postMessage({ type: 'answer', id: data.id, value: {
                        error: String(error instanceof Error ? error.message : error) } }));
            break;
        case 'standing':
            (harness ? harness.standing(data.list) : Promise.resolve(null)).then(value=>{
                self.postMessage({ type: 'answer', id: data.id, value });
            });
            break;
        case 'journalRecent':
            self.postMessage({ type: 'answer', id: data.id,
                value: harness?.journalRecent(data.count) ?? [] });
            break;
        case 'input':
            self.postMessage({ type: 'answer', id: data.id,
                value: harness?.input(data.event) ?? false });
            break;
        case 'stop':
            self.postMessage({ type: 'answer', id: data.id, value: harness?.stop() ?? false });
            break;
        case 'clearLog':
            sentLines = 0;
            self.postMessage({ type: 'answer', id: data.id,
                value: harness?.clearLog() ?? false });
            break;
        default:
            break;
    }
};
