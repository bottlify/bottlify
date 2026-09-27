/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How far the device is behind the engine.
 *
 * A present waits for the device only once it is the graphics layer's bound
 * of frames behind (`maxFrameLatency`), so with no bound a device slower than
 * the program -- a software adapter is -- finishes frames long after the
 * engine submitted them, and the page's report, which reads the last frame
 * back, waits for every submit queued before it. A run whose program has long
 * stopped then looks like a page that does not answer. This counts the
 * submits of the realm the engine runs in and when the device finished them,
 * so a run that waits says what it is waiting for.
 */

/**
 * Installed in the engine's realm (the page, or its worker): wraps
 * `GPUQueue.submit` to count every submit and, through
 * `onSubmittedWorkDone`, when the device finished it. A queue finishes its
 * work in order, so the oldest unfinished submit is the one after the last
 * finished.
 */
export const DEVICE_HOOK = `(()=>{
    if (self.__bottlifyDevice)
    {
        return true;
    }
    const queued = [];
    let head = 0;
    let submitted = 0;
    let done = 0;
    const submit = GPUQueue.prototype.submit;
    GPUQueue.prototype.submit = function(buffers){
        const answer = submit.call(this, buffers);
        submitted++;
        queued.push(performance.now());
        this.onSubmittedWorkDone().then(()=>{
            done++;
            head++;
            if (head >= 4096)
            {
                queued.splice(0, head);
                head = 0;
            }
        });
        return answer;
    };
    self.__bottlifyDevice = ()=>JSON.stringify({
        submitted,
        done,
        oldestMs: done < submitted ? Math.round(performance.now() - queued[head]) : 0,
    });
    return true;
})()`;

/**
 * @typedef {Object} DeviceState
 * @property {number} submitted  Submits the engine made.
 * @property {number} done       How many of them the device has finished.
 * @property {number} oldestMs   How long ago the oldest unfinished one was made; 0 if none.
 */

/**
 * @param {DeviceState | null} state
 * @returns {string}
 */
export function describeDevice(state){
    if (!state)
    {
        return 'the device was not watched';
    }
    if (state.done >= state.submitted)
    {
        return `the device had finished all ${state.submitted} submits`;
    }
    return `the device had finished ${state.done} of ${state.submitted} submits, the oldest`
        + ` unfinished made ${(state.oldestMs / 1000).toFixed(1)} s before`;
}

/**
 * Watches the realm the engine runs in. Made before any other auto-attach is
 * asked for (the CPU profiler's), so the engine worker's session is seen when
 * either request attaches it.
 *
 * @param {import('./cdp.mjs').CdpEndpoint} cdp
 * @param {string} pageSession
 * @param {{ worker: boolean }} options
 */
export function watchDevice(cdp, pageSession, { worker }){
    /** @type {string | null} */
    let engine = worker ? null : pageSession;
    if (worker)
    {
        cdp.on('Target.attachedToTarget', (/** @type {any} */ params)=>{
            if (String(params.targetInfo?.url ?? '').endsWith('/game/worker.js'))
            {
                engine = params.sessionId;
            }
        });
    }
    return {
        /**
         * Puts the hook in place. `attach` asks for the page's workers itself,
         * for a run that has no profiler to have asked already.
         *
         * @param {{ attach: boolean }} how
         * @returns {Promise<boolean>} whether the device is watched
         */
        async install({ attach }){
            if (worker && attach)
            {
                await cdp.send('Target.setAutoAttach',
                    { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
                    pageSession).catch(()=>{});
            }
            // The worker's session arrives as an event, set by the listener above.
            const seen = ()=>engine;
            for (let attempt = 0; attempt < 20 && seen() === null; attempt++)
            {
                await new Promise(done=>setTimeout(done, 250));
            }
            const session = seen();
            if (session === null)
            {
                return false;
            }
            const answer = await cdp.send('Runtime.evaluate',
                { expression: DEVICE_HOOK, returnByValue: true }, session).catch(()=>null);
            return answer?.result?.value === true;
        },
        /**
         * The counts now, or null when the realm does not answer -- the page
         * does not while the engine holds its thread.
         *
         * @returns {Promise<DeviceState | null>}
         */
        async read(){
            if (engine === null)
            {
                return null;
            }
            const answer = await cdp.send('Runtime.evaluate', {
                expression: 'self.__bottlifyDevice ? self.__bottlifyDevice() : null',
                returnByValue: true,
            }, engine).catch(()=>null);
            const value = answer?.result?.value;
            return typeof value === 'string' ? JSON.parse(value) : null;
        },
    };
}
