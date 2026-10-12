/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A process in a worker of its own (roadmap/v2, stage 2): its machine, its
 * memory and its translator here, and the run's system half -- registry,
 * volume, windows, ids -- asked across a link to the thread that started it.
 *
 * The thread is the process's alone, so it waits by blocking: on the link's
 * doorbell when it has nothing to run, and in every call it makes to the
 * system, answering what it is asked meanwhile. Its pacing is the engine's
 * ring pacing, read from the link rather than from a page's ring.
 *
 * The same file runs under a page's `Worker` and Node's `worker_threads`. It
 * is told `{ type: 'start', end, volume, graphics, display, options, run }` --
 * its side of the link, the run's volume memory (`volume-link.js`), its way in
 * to the run's graphics worker and the port its surfaces' pictures go out on
 * (or null), the process as
 * `createApp` takes it, how long it may run -- and answers
 * `{ type: 'exited', code, diagnostics }`, or `{ type: 'failed', message, diagnostics }`.
 */

import { createApp, createMacrotask } from '../app.js';
import { openLink } from '../system/link.js';
import { remoteSystem } from '../system-link.js';
import { remoteStore } from '../layers/cpu/internal/store-link.js';
import { ringPacing } from './ring-pacing.js';
import { traceOpfsRejections } from './opfs-trace.js';
import { portEnd } from '../layers/graphics/remote/connect.js';
import { plainEvent } from '../system/events-across.js';

if (import.meta.BOTTLIFY_DIAGNOSTICS !== false)
{
    traceOpfsRejections(globalThis);
}

/** How often a process with work to do gives its event loop a turn, as the engine's worker does. */
const YIELD_MS = 4;

/**
 * The pictures of this process's surfaces, sent on `port` as the graphics
 * worker sends its frames, for the thread with the GPU to show. What it says
 * back once one is shown is not waited on: this thread blocks while it idles,
 * and a picture painted just before would wait with it.
 *
 * @param {MessagePort} port
 */
const sendFrames = port=>{
    port.onmessage = ()=>{};
    let frameIndex = 0;
    return (/** @type {{ pixels: Uint8Array }} */ frame)=>port.postMessage(
        { type: 'frame', ...frame, frameIndex: ++frameIndex }, [frame.pixels.buffer]);
};

/**
 * The files the parent handed this process as its output and error: named by
 * path, at the position the parent's open file holds, which a write here
 * reads and moves across the link.
 *
 * @param {Record<string, { path: string }> | undefined} named
 * @param {(target: string, method: string, args: any[]) => any} ask
 */
const standardFilesOf = (named, ask)=>named && Object.fromEntries(Object.entries(named)
    .map(([which, { path }])=>[which, {
        path,
        get position(){
            return ask('standard', 'position', [which]);
        },
        set position(at){
            ask('standard', 'setPosition', [which, at]);
        },
    }]));

/**
 * What a report reads, as data that crosses to another thread; where reading
 * it fails or it holds something that does not cross, what `failed` makes of
 * the error -- null by default.
 *
 * @param {() => any} read
 * @param {(message: string) => any} [failed]
 */
export const plainOf = (read, failed = ()=>null)=>{
    try
    {
        return JSON.parse(JSON.stringify(read()));
    }
    catch (e){
        return failed(e instanceof Error ? e.message : String(e));
    }
};

/**
 * Runs one process to its end.
 *
 * @param {{ end: import('../system/link.js').LinkEnd,
 *     volume?: import('../layers/filesystem/internal/volume-link.js').VolumeMemory | null,
 *     graphics?: MessagePort | null,
 *     display?: MessagePort | null, options: any, run?: any,
 *     windowCells?: Int32Array | null }} start
 * @param {(message: any) => void} [send]  to the run, beside the link: what
 *     the link cannot carry
 * @returns {Promise<{ code: number, diagnostics: any, systemLibraries: any }>} its exit
 *     code, its layers' diagnostics as it ended and the system libraries it knew, as
 *     plain data, or null
 */
export async function serveProcess(start, send){
    const { end, volume, graphics, display, options, run, windowCells = null } = start;
    /** @type {Record<string, Record<string, (...args: any[]) => any>>} */
    const handlers = {};
    const link = openLink(end, handlers);
    /** @type {any} */
    let app = null;
    /**
     * The code its parent ended it with before it was made, to end it with
     * once it is.
     *
     * @type {number | null}
     */
    let terminated = null;
    // What the page asks of the process it drives, as it would of a machine on
    // its own thread: pausing it, and looking inside it; and its parent's
    // TerminateProcess, which may come while it is still being made -- in
    // the first call it makes to the system, below.
    handlers.control = {
        pause: ()=>app?.pause(),
        resume: ()=>app?.resume(),
        stop: ()=>app?.stop(),
        terminate: (/** @type {number} */ code)=>{
            terminated ??= code;
            app?.terminate(code);
        },
    };
    /** @param {string} target @param {string} method @param {any[]} args */
    const ask = (target, method, args)=>link.callWaiting(target, method, args);
    const system = remoteSystem(ask, handlers, (target, method, args)=>
        link.call(target, method, args), volume, windowCells);
    // A wait on another process's object ended there: its word comes in
    // with whatever else the link carries, at a turn's end or while idle.
    handlers.kernel = { wake: (/** @type {number} */ token, /** @type {number} */ result)=>
        system.objects.deliver(token, result) };
    /** What the translator raises with each batch it posts. */
    const posted = { buffer: new SharedArrayBuffer(4), index: 0 };
    // The page's input, while this process stands, measured on the canvas
    // the run shows it on when the run says how large that is.
    const viewport = { width: 0, height: 0 };
    let measured = false;
    handlers.input = {
        send: (/** @type {any} */ event, /** @type {{ width: number, height: number } | null} */ size)=>{
            if (size && app)
            {
                viewport.width = size.width;
                viewport.height = size.height;
                if (!measured)
                {
                    app.input.attach(viewport, { listen: false });
                    measured = true;
                }
            }
            return app?.input.send(event);
        },
    };
    /** The machine's tables, and what it waited on the system for. */
    const tables = ()=>[...app.diagnostics(),
        { name: 'link', status: 'ready', metrics: link.diagnostics() }];
    /** The tables as data, or a table that says why they could not be read: a
     * report that loses them unsaid looks like a process that had none. */
    const plainTables = ()=>plainOf(tables, message=>[{ name: 'diagnostics', status: 'error',
        metrics: { error: message } }]);
    handlers.report = { diagnostics: ()=>(app ? plainTables() : null) };
    handlers.facade = {
        /** @param {string} path  a member of the machine, `debug.read` @param {any[]} args */
        call: async(path, args)=>{
            const names = path.split('.');
            const method = /** @type {string} */ (names.pop());
            const owner = names.reduce((at, name)=>at?.[name], app);
            if (typeof owner?.[method] !== 'function')
            {
                throw new Error(`${path}: no such call on a process`);
            }
            return plainEvent(await owner[method](...args));
        },
    };
    // The link is served on the event loop for as long as the process
    // stands, beside the program's turns, which look at it too: while the
    // machine is built nothing runs turns, and a block of the bundle a
    // library is read from is answered there; and once the program is over,
    // what it waits on as it ends -- a class it served taken out of the run's
    // table, a release sent to another process's object -- is answered there.
    const serving = link.serve();
    try
    {
        app = await createApp({
            ...options,
            standardFiles: standardFilesOf(options.standardFiles, ask),
            graphics: { ...options.graphics, worker: graphics ? portEnd(graphics) : undefined,
                display: display ? sendFrames(display) : undefined },
            system,
            // Its output is written in order with its calls, below; the rest is
            // told as it happens, and not waited on.
            relay: (/** @type {string} */ name, /** @type {any} */ payload)=>{
                // A child beside it in this worker plays into a table of its
                // own too, named and let go of as its own machine's is, below.
                if (name === 'sound-table')
                {
                    send?.({ type: 'sound', id: payload.id, table: payload.table });
                }
                else if (name === 'sound-table-closed')
                {
                    send?.({ type: 'sound-closed', id: payload.id });
                }
                else if (name !== 'output')
                {
                    link.call('events', 'emit', [name, plainEvent(payload)]).catch(()=>{});
                }
            },
            // The translator rings the link's bell after each batch it posts, so
            // the batch is taken at the next turn rather than at the next timed
            // yield, as the engine's thread takes its own.
            cork: { ...options.cork, config: { ...options.cork?.config,
                // The run's store, kept by the system's thread.
                store: options.cork?.config?.store === 'run'
                    ? remoteStore({ ask: (method, args)=>ask('store', method, args),
                        call: (method, args)=>link.call('store', method, args) })
                    : options.cork?.config?.store,
                doorbell: { posted, bell: link.bell } } },
            pacing: ringPacing({ inbound: { bell: link.bell, drain: link.pump },
                macrotask: createMacrotask(), now: ()=>performance.now(), intervalMs: YIELD_MS,
                posted, pendingMs: options.pendingYieldMs }),
        });
    }
    catch (e){
        link.close();
        await serving;
        throw e;
    }
    app.attachLog((/** @type {number} */ handle, /** @type {string} */ text)=>
        ask('process', 'output', [handle, text]));
    // Its sound is a table of its own, which the run names to the page. Shared
    // memory crosses as a message: the link carries values as bytes. Its
    // number is 0, which none of its children beside it here is given.
    const sound = soundOf(app);
    if (sound)
    {
        send?.({ type: 'sound', id: 0, table: sound });
    }
    if (terminated !== null)
    {
        app.terminate(terminated);
    }
    lendings.apply = ()=>{
        for (const { type, port, token } of lendings.splice(0))
        {
            if (type === 'translator')
            {
                app.lendTranslator(port, token);
            }
            else
            {
                app.recallTranslator(token);
            }
        }
    };
    lendings.apply();
    try
    {
        let code;
        try
        {
            code = await app.run(run ?? {});
        }
        catch (e){
            // A run that failed is read as one that ended: what it did up to
            // the failure is what is asked of it next.
            throw Object.assign(e instanceof Error ? e : new Error(String(e)),
                { diagnostics: plainTables() });
        }
        return { code, diagnostics: plainTables(),
            // What an installer's output is sorted against, read while the
            // machine that knows it still stands.
            systemLibraries: plainOf(()=>app.systemLibraries?.() ?? []) };
    }
    finally
    {
        await app.dispose();
        link.close();
        await serving;
        graphics?.postMessage({ type: 'close' });
        graphics?.close();
        display?.close();
    }
}

/**
 * The shared table a machine's sound output is, or null: a build with no
 * sound layer has none, and an output with no shared memory is a ring only
 * its own thread reads.
 *
 * @param {any} app
 * @returns {SharedArrayBuffer | null}
 */
const soundOf = app=>{
    try
    {
        const memory = app.audio?.memory?.();
        return memory && 'table' in memory && typeof SharedArrayBuffer === 'function'
            && memory.table instanceof SharedArrayBuffer ? memory.table : null;
    }
    catch {
        return null;
    }
};

/**
 * The pool's lendings and recalls, in the order they came, and what hands them
 * to the machine once it stands.
 * @type {any[] & { apply?: () => void }}
 */
const lendings = [];

/**
 * @param {(handler: (data: any) => void) => void} listen
 * @param {(message: any) => void} send
 */
const bind = (listen, send)=>listen(data=>{
    // A worker of the run's translation pool, lent to this process or asked
    // back: taken by the machine, or kept until the machine is built.
    if (data?.type === 'translator' || data?.type === 'recall')
    {
        lendings.push(data);
        lendings.apply?.();
        return;
    }
    if (data?.type !== 'start')
    {
        return;
    }
    serveProcess(data, send).then(
        ({ code, diagnostics, systemLibraries })=>
            send({ type: 'exited', code, diagnostics, systemLibraries }),
        (/** @type {any} */ e)=>send({ type: 'failed', message: String(e?.stack ?? e),
            diagnostics: e?.diagnostics ?? null }));
});

if (typeof self !== 'undefined' && typeof (/** @type {any} */ (self)).postMessage === 'function')
{
    const scope = /** @type {any} */ (self);
    bind(handler=>{
        scope.onmessage = (/** @type {{ data: any }} */ event)=>handler(event.data);
    }, message=>scope.postMessage(message));
}
else
{
    const { parentPort, isMainThread } = await import('node:worker_threads');
    if (!isMainThread && parentPort)
    {
        bind(handler=>parentPort.on('message', handler),
            message=>parentPort.postMessage(message));
    }
}
