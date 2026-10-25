/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The page's speaker: the audio context and the worklet that play what the
 * engine mixes.
 *
 * A browser starts sound only off the back of a person's gesture, and how
 * strictly it means that differs: a desktop browser lets a page that was
 * clicked once start it any time after, a phone's WebKit only inside the
 * touch's own handler -- not after an await, not from an effect a click led
 * to. So the speaker is opened synchronously, inside the gesture, before
 * anything about the run is known; the worklet loads and the engine is built
 * afterwards, around a context that is already running.
 *
 * What a phone does to sound after that is handled here too, since every
 * page would otherwise have to learn it:
 *
 * - its ring/silent switch mutes Web Audio unless the page's audio session
 *   says it plays (`navigator.audioSession.type = 'playback'`), as a game
 *   does;
 * - a call, an alarm or the app going to the background leaves the context
 *   `interrupted` (or suspended), and a context that stops drains nothing --
 *   the engine, told something drains its ring, would then wait on a play
 *   cursor nobody moves. So a context that stopped without being asked to is
 *   resumed when it says so, and again at the person's next gesture, which is
 *   what a phone needs before it lets sound start again.
 */

/** Events that count as a person's gesture for starting sound again. */
const GESTURES = Object.freeze(['pointerup', 'touchend', 'click', 'keydown']);

/** How long `ready` waits for the context to run, by default. */
const READY_MS = 1000;

/**
 * @typedef {Object} SpeakerScope  What the speaker takes from the page, so a
 *     test can hand it stand-ins.
 * @property {new (options: any) => any} AudioContext
 * @property {new (context: any, name: string, options: any) => any} AudioWorkletNode
 * @property {new () => { port1: any, port2: any }} [MessageChannel]
 * @property {any} [navigator]
 * @property {any} [document]
 * @property {boolean} [crossOriginIsolated]
 * @property {(callback: () => void, ms: number) => any} setTimeout
 * @property {(timer: any) => void} clearTimeout
 */

/**
 * @typedef {Object} Speaker
 * @property {any} context  The AudioContext.
 * @property {() => string} state  The context's state.
 * @property {(timeoutMs?: number) => Promise<{ running: boolean, reason?: string }>} ready
 *     Settles once the worklet is loaded and the context runs, or says why not
 *     within the time given; a context still stopped then is left open and
 *     started at the next gesture.
 * @property {() => void} resume  Starts it again; call inside a gesture.
 * @property {() => void} suspend  Stops it on purpose (a paused run): nothing but
 *     `resume` starts it again.
 * @property {() => { drained: boolean, sampleRate: number, port?: any }} audioOptions
 *     The `audio` options `createApp` takes for this speaker: something drains
 *     the ring, at the device's own rate, and -- with no shared memory -- the
 *     port the engine posts its mix down.
 * @property {(app: any) => void} connect  Plays the built app: the worklet node, fed
 *     from the app's track table (and every process's beside it) or its port.
 * @property {(level: number) => void} volume  0 is silent; the program is not told.
 * @property {() => Promise<void>} close
 */

/**
 * Opens the speaker. Call it inside the gesture that starts the run (a
 * click's or a touch's own handler), before any await.
 *
 * @param {{ worklet?: string | URL, latencyHint?: string, scope?: SpeakerScope }} [options]
 *     `worklet`: where the engine's `worklet.js` is served; beside this file
 *     in the package by default.
 * @returns {Speaker}
 */
export function openSpeaker(options = {}){
    const scope = /** @type {SpeakerScope} */ (options.scope ?? globalThis);
    const worklet = String(options.worklet ?? new URL('./worklet.js', import.meta.url));

    const session = scope.navigator?.audioSession;
    if (session && 'type' in session)
    {
        try
        {
            session.type = 'playback';
        }
        catch {
            // A session type this browser refuses: the switch then mutes, as before.
        }
    }

    const context = new scope.AudioContext({ latencyHint: options.latencyHint ?? 'interactive' });
    let wanted = true;
    let closed = false;
    const wake = ()=>{
        if (wanted && !closed && context.state !== 'running' && context.state !== 'closed')
        {
            // The state says whether it took, not the promise: a context the
            // browser keeps stopped leaves `resume` pending for good.
            Promise.resolve(context.resume()).catch(()=>{});
        }
    };

    // A silent sample started inside the gesture: an older phone's WebKit
    // starts its output for a source played in one and for nothing else.
    try
    {
        const source = context.createBufferSource();
        source.buffer = context.createBuffer(1, 1, context.sampleRate);
        source.connect(context.destination);
        source.start(0);
    }
    catch {
        // Nothing to unlock with; `resume` is the rest of it.
    }
    wake();
    context.addEventListener?.('statechange', wake);
    const page = scope.document;
    for (const type of GESTURES)
    {
        page?.addEventListener?.(type, wake, { capture: true, passive: true });
    }

    /** @type {Promise<{ running: boolean, reason?: string }> | null} */
    let loading = null;
    /** @type {{ port1: any, port2: any } | null} */
    let channel = null;
    /** @type {any} */
    let node = null;
    /** @type {any} */
    let gain = null;
    let level = 1;
    /** @type {(() => void)[]} */
    const unsubscribe = [];

    /** @param {number} timeoutMs */
    const running = timeoutMs=>new Promise(settle=>{
        if (context.state === 'running')
        {
            settle(true);
            return;
        }
        const done = ()=>{
            context.removeEventListener?.('statechange', check);
            scope.clearTimeout(timer);
            settle(context.state === 'running');
        };
        const check = ()=>{
            if (context.state === 'running')
            {
                done();
            }
        };
        const timer = scope.setTimeout(done, timeoutMs);
        context.addEventListener?.('statechange', check);
    });

    return {
        context,
        state: ()=>context.state,
        ready(timeoutMs = READY_MS){
            loading ??= Promise.resolve(context.audioWorklet.addModule(worklet)).then(
                ()=>({ running: true }),
                (/** @type {any} */ error)=>({ running: false,
                    reason: `the audio worklet did not load: ${error?.message ?? error}` }));
            return loading.then(loaded=>(!loaded.running ? loaded
                : running(timeoutMs).then(on=>(on ? { running: true }
                    : { running: false, reason: `the audio context stayed ${context.state}` }))));
        },
        resume(){
            wanted = true;
            wake();
        },
        suspend(){
            wanted = false;
            Promise.resolve(context.suspend?.()).catch(()=>{});
        },
        audioOptions(){
            if (!scope.crossOriginIsolated && !channel && scope.MessageChannel)
            {
                // Without shared memory the engine posts its mix to the worklet:
                // one end goes to the engine, the other to the worklet.
                channel = new scope.MessageChannel();
            }
            return { drained: true, sampleRate: context.sampleRate,
                ...(channel ? { port: channel.port2 } : {}) };
        },
        connect(app){
            if (node)
            {
                throw new Error('this speaker already plays a run');
            }
            const { channels } = app.audio.format();
            const feed = channel;
            node = new scope.AudioWorkletNode(context, 'bottlify-output', {
                outputChannelCount: [channels],
                processorOptions: feed ? { channels }
                    : { table: app.audio.memory().table, channels },
            });
            if (feed)
            {
                node.port.postMessage({ type: 'feed', port: feed.port1 }, [feed.port1]);
            }
            else
            {
                // Each process started beside another plays into a table of its
                // own; the worklet mixes every one with the run's and drops it
                // when the process is gone.
                const playing = node;
                unsubscribe.push(app.on('sound-table', (/** @type {any} */ event)=>
                    playing.port.postMessage({ type: 'table', id: event.id, table: event.table })));
                unsubscribe.push(app.on('sound-table-closed', (/** @type {any} */ event)=>
                    playing.port.postMessage({ type: 'untable', id: event.id })));
            }
            // A gain on the way out, so the page can silence or turn down what
            // is heard while the guest's cursors keep advancing as they would.
            gain = context.createGain();
            gain.gain.value = level;
            node.connect(gain);
            gain.connect(context.destination);
        },
        volume(value){
            level = Math.max(0, value);
            if (gain)
            {
                gain.gain.value = level;
            }
        },
        async close(){
            if (closed)
            {
                return;
            }
            closed = true;
            for (const off of unsubscribe.splice(0))
            {
                off?.();
            }
            context.removeEventListener?.('statechange', wake);
            for (const type of GESTURES)
            {
                page?.removeEventListener?.(type, wake, { capture: true });
            }
            node?.port.postMessage('stop');
            node?.disconnect();
            await Promise.resolve(context.close()).catch(()=>{});
        },
    };
}
