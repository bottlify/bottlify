/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The page a driver reaches: `window.__bottlify__`, answering the same
 * questions whichever thread the engine is on.
 *
 * `?worker=1` runs the harness inside a worker, with this canvas transferred
 * to it; otherwise it runs on this thread. The two differ in one thing a
 * driver can see: on this thread nothing is answered while the guest runs, so
 * a result is polled for rather than awaited, and a call log is read
 * synchronously; from a worker the answers arrive as messages, so the log is
 * mirrored here in batches and `frameReport` answers with a promise.
 */

import { createHarness, drainTable, packCapture } from './harness.js';

const out = /** @type {HTMLElement} */ (document.querySelector('#out'));
const canvas = /** @type {HTMLCanvasElement} */ (document.querySelector('#frame'));
const inWorker = new URLSearchParams(window.location.search).get('worker') === '1';

/** Written out rather than escaped, so no tooling can mangle it. */
const NEWLINE = String.fromCharCode(10);

/**
 * Long tasks on this thread, whatever is on it: with the engine here they are
 * its turns, with the engine elsewhere they are whatever the page itself did.
 * That difference is the point of measuring them.
 */
const longTasks = { count: 0, totalMs: 0, maxMs: 0 };
try
{
    new PerformanceObserver(list=>{
        for (const entry of list.getEntries())
        {
            longTasks.count++;
            longTasks.totalMs += entry.duration;
            longTasks.maxMs = Math.max(longTasks.maxMs, entry.duration);
        }
    }).observe({ type: 'longtask', buffered: true });
}
catch {
    // No long-task observer here; the count stays at zero and says so.
}

/** @type {any} */
const namespace = { errors: [], result: null, longTasks: ()=>({ ...longTasks }) };
/** @type {any} */ (window).__bottlify__ = namespace;

window.addEventListener('error', event=>{
    namespace.errors.push(`page:${event.message}`);
});
window.addEventListener('unhandledrejection', event=>{
    const reason = /** @type {any} */ (event).reason;
    namespace.errors.push(
        `unhandled:${reason && reason.message ? reason.message : String(reason)}`);
});

/** @param {any} result */
const finish = result=>{
    namespace.result = { ...result, longTasks: { ...longTasks } };
    out.textContent = `${result.stopped ?? result.error}\n`
        + `${result.instructions ?? '?'} instructions`;
};

if (inWorker)
{
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    /** @type {string[]} */
    const callLog = [];
    let nextId = 1;
    /** @type {Map<number, (value: any) => void>} */
    const waiting = new Map();
    /** @param {string} method @param {Record<string, any>} [extra] */
    const ask = (method, extra)=>new Promise(resolve=>{
        const id = nextId++;
        waiting.set(id, resolve);
        worker.postMessage({ type: method, id, ...extra });
    });
    /** What the page's device mixed, when the run asked for it. @type {any} */
    let capture = null;
    let sampleRate = 48000;
    /** @type {(gpu: any) => void} */
    let gpuAnswered = ()=>{};
    namespace.gpu = new Promise(resolve=>{
        gpuAnswered = resolve;
    });
    worker.onmessage = ({ data })=>{
        switch (data.type)
        {
            case 'gpu':
                gpuAnswered(data.gpu);
                break;
            case 'calls':
                // One at a time: a batch of a busy run is more lines than a
                // spread passes as arguments.
                for (const line of data.lines)
                {
                    callLog.push(line);
                }
                break;
            case 'audioTable':
                sampleRate = data.sampleRate;
                drainTable(data.table, data.sampleRate, capture);
                break;
            case 'result':
                finish(capture && capture.blocks.length > 0
                    ? { ...data.result,
                        audioCapture: packCapture(capture, sampleRate) }
                    : data.result);
                break;
            case 'error':
                namespace.errors.push(`worker:${data.text}`);
                break;
            case 'answer':
                waiting.get(data.id)?.(data.value);
                waiting.delete(data.id);
                break;
            default:
                break;
        }
    };
    worker.onerror = event=>{
        // Where it was thrown, which the message alone does not say.
        const where = event.filename ? ` at ${event.filename}:${event.lineno}:${event.colno}` : '';
        namespace.errors.push(`worker:${event.message}${where}`);
        if (!namespace.result)
        {
            finish({ ok: false, error: event.message, stopped: `${event.message}${where}` });
        }
    };
    const offscreen = canvas.transferControlToOffscreen();
    // `?pacing=event`: the loop sleeps for events rather than looking on a
    // short timer; see the host's messages for what was measured.
    worker.postMessage({ type: 'canvas', canvas: offscreen,
        pacing: new URLSearchParams(window.location.search).get('pacing') ?? 'page' },
    [offscreen]);

    namespace.start = (/** @type {any} */ request)=>{
        namespace.result = null;
        capture = request.captureAudio
            ? { fromMs: request.captureAudio.fromMs, toMs: request.captureAudio.toMs,
                blocks: /** @type {Int16Array[]} */ ([]) }
            : null;
        worker.postMessage({ type: 'start', request });
    };
    namespace.drainLog = (/** @type {number} */ from, /** @type {number} */ count)=>
        callLog.slice(from, from + count).join(NEWLINE);
    namespace.logLines = ()=>callLog.length;
    namespace.frameReport = ()=>ask('frameReport');
    namespace.frameShot = ()=>ask('frameShot');
    namespace.dumpFrames = (/** @type {number} */ frames)=>ask('dumpFrames', { frames });
    namespace.lastDumped = ()=>ask('lastDumped');
    namespace.journalRecent = (/** @type {number} */ count)=>ask('journalRecent', { count });
    namespace.standing = (/** @type {string | undefined} */ list)=>ask('standing', { list });
    namespace.input = (/** @type {any} */ event)=>ask('input', { event });
    namespace.stop = ()=>ask('stop');
    namespace.clearLog = ()=>{
        callLog.length = 0;
        return ask('clearLog');
    };
    out.textContent = 'starting the engine in a worker';
}
else
{
    const harness = createHarness(canvas);
    namespace.gpu = harness.gpu;
    namespace.drainLog = harness.drainLog;
    namespace.logLines = harness.logLines;
    namespace.frameReport = harness.frameReport;
    namespace.frameShot = harness.frameShot;
    namespace.dumpFrames = harness.dumpFrames;
    namespace.lastDumped = harness.lastDumped;
    namespace.journalRecent = harness.journalRecent;
    namespace.standing = harness.standing;
    namespace.input = harness.input;
    namespace.stop = harness.stop;
    namespace.clearLog = harness.clearLog;
    namespace.errors = harness.errors;

    /**
     * Starts a run and leaves the result here rather than returning it.
     *
     * The engine runs on this thread, so for long stretches nothing on this
     * page is answered -- a driver waiting on a returned promise would be
     * waiting on a thread that cannot answer it. So it is polled for instead.
     *
     * @param {any} request
     */
    namespace.start = request=>{
        namespace.result = null;
        harness.run(request).then(finish, error=>finish({
            ok: false,
            error: String(error && error.message),
            stack: String(error && error.stack).split('\n').slice(0, 8).join('\n'),
        }));
    };
    harness.gpu.then(handle=>{
        out.textContent = handle.available
            ? 'ready: a device answered, waiting for a title'
            : `no device: ${handle.reason}`;
    });
}
