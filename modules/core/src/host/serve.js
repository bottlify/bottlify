/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The engine's end of the wire: answers a page's requests over a port.
 *
 * Everything that is the engine lives on this side -- the emulator, the HLE,
 * the mixer's pump, the GPU device and the copy of each frame into the
 * canvas. The page keeps what only a page can do: the DOM events, the audio
 * context, the cursor style. A GPUDevice is neither transferable nor
 * cloneable, which is why the device is opened here rather than handed over,
 * and why every frame is presented from here into an OffscreenCanvas the page
 * transferred in. The page does nothing per frame.
 *
 * `serveEngine` takes the port and what it builds an application with, so a
 * test can drive it through a MessageChannel with a fake `createApp` and no
 * worker at all; `engine.worker.js` is the two lines that bind it to a real one.
 */

import { createMacrotask } from '../app.js';

/** How many presented frames are remembered for a diagnostic to read back. */
const PRESENT_HISTORY = 600;

/**
 * How long a worker runs turns back to back before giving its event loop a
 * turn regardless. Nothing the page sends needs it -- the signal word says
 * when a message is waiting -- but a decoder's output and a fetch's answer
 * are tasks too, and a loop that never yields never sees them.
 */
const YIELD_MS = 1;

/** `GPUTextureUsage` bits, as numbers: the typecheck has no WebGPU library. */
const TEXTURE_USAGE = { COPY_DST: 0x02, RENDER_ATTACHMENT: 0x10 };

/**
 * @typedef {Object} ServeDeps
 * @property {(options: import('../app.js').AppOptions) => Promise<any>} createApp
 * @property {any} [gpu]   `navigator.gpu`, or a stand-in; absent means no device.
 * @property {(canvas: any) => any} [screenOf]
 *     The WebGPU context of the canvas the frames land in. Defaults to asking
 *     the canvas; a test hands in a canvas that is only a size and a context
 *     of its own.
 * @property {boolean} [threaded]
 *     Whether this end has a thread of its own. It does in a worker, where a
 *     run may ask for the event-driven pacing; on a page's thread, behind a
 *     MessageChannel, the loop keeps the page's pacing whatever is asked.
 * @property {() => number} [now]
 */

/**
 * The pacing of a thread that is nobody else's: turns run back to back until
 * something is pending, and an idle machine sleeps until the guest's next
 * deadline, a host answer, or a message from the page -- never on a short
 * timer looked at again and again.
 *
 * @param {Object} deps
 * @param {() => Promise<void>} deps.macrotask
 * @param {() => Promise<void>} deps.poke   Settles on the next message from the page.
 * @param {() => boolean} deps.signalled    Whether the page has posted since the last look.
 * @param {() => number} deps.now
 * @returns {import('../app.js').RunPacing}
 */
export function workerPacing({ macrotask, poke, signalled, now }){
    let yielded = now();
    return {
        yield(pending){
            const at = now();
            if (pending.suspended > 0 || pending.fetching > 0 || pending.idlers > 0
                || signalled() || at - yielded >= YIELD_MS)
            {
                yielded = at;
                return macrotask();
            }
            return null;
        },
        wait({ sleep, deadlineMs, wakes }){
            if (!sleep)
            {
                return macrotask();
            }
            /** @type {ReturnType<typeof setTimeout> | null} */
            let timer = null;
            const waits = [...wakes, poke()];
            if (deadlineMs !== null)
            {
                waits.push(new Promise(resolve=>{
                    timer = setTimeout(resolve, deadlineMs);
                }));
            }
            return Promise.race(waits).then(()=>{
                if (timer !== null)
                {
                    clearTimeout(timer);
                }
            });
        },
    };
}

/**
 * One byte range of a bundle, by HTTP.
 *
 * A 206 is the only acceptable answer: a 200 means the server ignored the
 * range and is about to send the whole bundle, which is the one outcome this
 * transport exists to avoid.
 *
 * @param {string} url
 * @returns {(offset: number, length: number) => Promise<Uint8Array>}
 */
export function rangeFetcher(url){
    return async(offset, length)=>{
        const response = await fetch(url, {
            headers: { Range: `bytes=${offset}-${offset + length - 1}` },
        });
        if (response.status !== 206)
        {
            throw new Error(`range ${offset}+${length} answered ${response.status}, not 206`);
        }
        return new Uint8Array(await response.arrayBuffer());
    };
}

/**
 * The watch predicate a `watch` option describes.
 *
 * `lib.dll` watches every import from it; `lib.dll#268+279` only those
 * ordinals, for a library whose every call would drown the log. The argument
 * count of a named import comes from its decoration (`_Name@N`); an
 * undecorated name is not watched, since nothing says how much it pops. An
 * import by ordinal says nothing about its arguments; six dwords are shown,
 * which is only what the trace prints -- a watch forwards into the real
 * function and never pops anything itself.
 *
 * @param {NonNullable<import('./messages.js').StartOptions['watch']>} watch
 * @returns {NonNullable<import('../app.js').AppOptions['watchImport']>}
 */
export function watchFrom({ libraries, strings }){
    return (dll, name, ordinal)=>{
        const only = libraries[String(dll).toLowerCase()];
        if (only === undefined)
        {
            return null;
        }
        if (only !== null)
        {
            return ordinal !== null && only.includes(ordinal) ? { args: 6, strings } : null;
        }
        if (!name)
        {
            return { args: 6 };
        }
        const decorated = /@(\d+)$/.exec(name);
        return decorated ? { args: Number(decorated[1]) / 4 } : null;
    };
}

/**
 * A failure as it travels. The properties a page shows are copied by name
 * because a structured clone of an Error keeps none of its own.
 *
 * @param {any} e
 * @returns {import('./messages.js').Failure}
 */
function describe(e){
    return {
        message: e?.message ?? String(e),
        reason: e?.reason,
        traceText: e?.traceText,
        stack: e?.stack,
    };
}

/**
 * A payload as it can be posted: as it is when a clone takes it, and through
 * JSON when it holds something that cannot cross -- a function, a GPU object.
 *
 * @param {unknown} value
 */
function cloneable(value){
    try
    {
        structuredClone(value);
        return value;
    }
    catch {
        return JSON.parse(JSON.stringify(value));
    }
}

/**
 * A diagnostics table as it can be posted: the same shape, with what a clone
 * refuses left out -- a function, a GPU handle, anything without data of its
 * own. Byte arrays cross as they are; they are the reader's to want or not,
 * and the reader that wants counters asks for one layer.
 *
 * Walked rather than passed through JSON: JSON writes the whole table out as
 * text and reads it back, which for a graphics table with the last frame's
 * commands in it cost tens of milliseconds of the engine's thread per call.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function plain(value){
    if (value === null || typeof value !== 'object')
    {
        return typeof value === 'function' ? undefined : value;
    }
    if (Array.isArray(value))
    {
        return value.map(plain);
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || value instanceof Date)
    {
        return value;
    }
    if (value instanceof Map)
    {
        return new Map([...value].map(([key, held])=>[key, plain(held)]));
    }
    if (value instanceof Set)
    {
        return new Set([...value].map(plain));
    }
    /** @type {Record<string, unknown>} */
    const copy = {};
    for (const [key, held] of Object.entries(value))
    {
        const kept = plain(held);
        if (kept !== undefined)
        {
            copy[key] = kept;
        }
    }
    return copy;
}

/**
 * @param {any} port   The worker's global scope, or a MessagePort.
 * @param {ServeDeps} deps
 * @returns {{ close: () => void }} stops serving; a worker never needs to, a
 *     port on a page does, since its channel is a live handle
 */
export function serveEngine(port, { createApp, gpu, screenOf, threaded = false, now }){
    const adapters = gpu ?? /** @type {any} */ (globalThis.navigator)?.gpu;
    const clock = now ?? (()=>performance.now());
    const breathe = createMacrotask();
    // Whoever is waiting for the page to say something: every message settles
    // it, so an idle loop wakes for an input event or a request the moment it
    // arrives rather than at its next look.
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
    // The page counts what it posts in a shared word, so a loop between
    // turns can tell that a message is waiting without giving up the thread
    // to find out. Absent -- no shared memory on this origin -- the loop
    // yields on a short clock instead.
    /** @type {Int32Array | null} */
    let signal = null;
    let signalSeen = 0;
    const signalled = ()=>{
        if (!signal)
        {
            return false;
        }
        const count = Atomics.load(signal, 0);
        if (count === signalSeen)
        {
            return false;
        }
        signalSeen = count;
        return true;
    };
    const contextOf = screenOf ?? ((/** @type {any} */ canvas)=>canvas.getContext('webgpu'));
    /** @type {any} */
    let app = null;
    let hidden = false;
    /** @type {import('./messages.js').Presented[]} */
    const presented = [];
    let frames = 0;
    /** @type {import('./messages.js').StartOptions | null} */
    let started = null;
    /**
     * The OffscreenCanvas the frames land in. Kept across programs: a canvas
     * can be transferred once, so a page that runs a second program in the
     * same viewport starts it in the same worker and does not hand the canvas
     * over again.
     *
     * @type {any}
     */
    let viewport = null;
    /** The GPU device of the running program. @type {any} */
    let device = null;

    /** @param {import('./messages.js').FromEngine} message */
    const post = message=>port.postMessage(message);
    /** @param {string} name @param {unknown} payload */
    const emit = (name, payload)=>post({ type: 'event', name, payload: cloneable(payload) });

    /**
     * The device, or a refusal that says which part was missing.
     *
     * Block compression is asked for when the adapter has it: the art of this
     * era is DXT, and a device without the feature makes the engine refuse
     * every compressed texture -- which a program answers by decompressing on
     * its own CPU, in emulated x86, and handing over surfaces four times the
     * size.
     */
    const openDevice = async()=>{
        if (!adapters)
        {
            throw Object.assign(new Error('this worker exposes no navigator.gpu, so there '
                + 'is no device to draw on'), { reason: 'no WebGPU' });
        }
        const adapter = await adapters.requestAdapter();
        if (!adapter)
        {
            throw Object.assign(new Error('WebGPU is present but no adapter answered '
                + 'requestAdapter'), { reason: 'no GPU adapter' });
        }
        const features = adapter.features.has('texture-compression-bc')
            ? ['texture-compression-bc']
            : [];
        const opened = await adapter.requestDevice({ requiredFeatures: features });
        // A validation error the engine did not catch drops the whole frame
        // it was in, silently; the console is where a person looks for why.
        opened.addEventListener('uncapturederror', (/** @type {any} */ event)=>{
            console.error('WebGPU:', event.error?.message ?? event.error);
        });
        return {
            device: opened,
            adapter: {
                vendor: adapter.info?.vendor ?? '',
                architecture: adapter.info?.architecture ?? '',
                description: adapter.info?.description ?? '',
            },
        };
    };

    /**
     * Copies each frame into the canvas on the GPU, one command, and reads
     * nothing back.
     *
     * @param {any} gpuDevice
     * @param {any} canvas   An OffscreenCanvas the page transferred.
     */
    const presenter = (gpuDevice, canvas)=>{
        const screen = contextOf(canvas);
        if (!screen)
        {
            throw Object.assign(new Error('the canvas would not give a WebGPU context'),
                { reason: 'gpu' });
        }
        let screenFormat = '';
        /** @param {any} frame */
        return frame=>{
            const surface = frame.surface;
            const startedAt = clock();
            try
            {
                const resized = canvas.width !== surface.width
                    || canvas.height !== surface.height;
                if (resized)
                {
                    canvas.width = surface.width;
                    canvas.height = surface.height;
                }
                if (screenFormat !== surface.format)
                {
                    // Configured in the frame's own format, so the copy is a
                    // copy and not a conversion.
                    screen.configure({
                        device: gpuDevice,
                        format: surface.format,
                        usage: TEXTURE_USAGE.COPY_DST | TEXTURE_USAGE.RENDER_ATTACHMENT,
                        alphaMode: 'opaque',
                    });
                    screenFormat = surface.format;
                }
                const encoder = gpuDevice.createCommandEncoder({ label: 'present' });
                encoder.copyTextureToTexture(
                    { texture: surface.texture },
                    { texture: screen.getCurrentTexture() },
                    { width: surface.width, height: surface.height, depthOrArrayLayers: 1 });
                gpuDevice.queue.submit([encoder.finish()]);
                frames++;
                if (resized || frames === 1)
                {
                    /** @type {import('./messages.js').FramePayload} */
                    const payload = {
                        width: surface.width, height: surface.height, presented: frames,
                    };
                    emit('frame', payload);
                }
                presented.push({
                    index: frame.frameIndex, at: startedAt, ms: clock() - startedAt,
                    w: surface.width, h: surface.height, failed: false,
                });
            }
            catch (e){
                presented.push({
                    index: frame.frameIndex, at: startedAt, ms: -1, w: 0, h: 0, failed: true,
                });
                emit('present-failed', { index: frame.frameIndex, message: describe(e).message });
            }
            if (presented.length > PRESENT_HISTORY)
            {
                presented.shift();
            }
        };
    };

    /**
     * Puts a watch in front of the routines the hooks name, as each module
     * they live in is loaded. A diagnostic, and a rewrite of the program's code.
     *
     * @param {import('./messages.js').HookSpec[]} hooks
     */
    const installHooks = hooks=>{
        app.on('library-loaded', (/** @type {{ name: string, base: number }} */ { name, base })=>{
            for (const spec of hooks)
            {
                if (String(name).toLowerCase() !== spec.module)
                {
                    continue;
                }
                try
                {
                    app.debug.hook(base + spec.offset, spec);
                    emit('hook', { label: spec.label, address: base + spec.offset });
                }
                catch (e){
                    emit('hook', { label: spec.label, refused: describe(e).message });
                }
            }
        });
    };

    /** @type {Record<string, (...args: any[]) => unknown>} */
    const methods = {
        /**
         * @param {import('./messages.js').StartOptions} options
         * @param {any} canvas   Absent, the one a previous start was given;
         *     none at all is a run without a display, as a headless test wants.
         * @returns {Promise<import('./messages.js').Started>}
         */
        async start(options, canvas){
            if (app)
            {
                throw new Error('this worker is already running a program');
            }
            viewport = canvas ?? viewport;
            frames = 0;
            presented.length = 0;
            signal = options.signal ? new Int32Array(options.signal) : null;
            signalSeen = signal ? Atomics.load(signal, 0) : 0;
            const opened = viewport ? await openDevice() : null;
            device = opened?.device ?? null;
            const adapter = opened?.adapter ?? { vendor: '', architecture: '', description: '' };
            const { bundle, storage, watch, hooks, device: knobs, signal: word, ...rest } = options;
            void word;
            app = await createApp({
                ...rest,
                pacing: threaded && options.pacing === 'event'
                    ? workerPacing({ macrotask: breathe, poke, signalled, now: clock })
                    : undefined,
                bundle: bundle ? {
                    ...bundle,
                    fetch: rangeFetcher(bundle.url),
                } : undefined,
                storage: storage && typeof storage === 'object'
                    ? { load: async()=>storage.files }
                    : storage,
                watchImport: watch ? watchFrom(watch) : undefined,
                pageHidden: ()=>hidden,
                device: opened
                    ? {
                        ...knobs,
                        device,
                        queue: device.queue,
                        adapter,
                        presentTo: presenter(device, viewport),
                    }
                    : undefined,
            });
            started = options;
            if (hooks && hooks.length > 0)
            {
                installHooks(hooks);
            }
            // Confined to the canvas the frames land in: its pixels are the
            // picture, so they are the space a pointer position lives in. The
            // events themselves come from the page, through `input`.
            if (viewport)
            {
                app.input.attach(viewport, { listen: false });
            }

            /** @type {import('./messages.js').Started['audio']} */
            let audio = null;
            try
            {
                audio = { memory: app.audio.ring().memory, ...app.audio.format() };
            }
            catch {
                // No mixer in this build: a run without sound is a run.
            }
            return { audio, adapter };
        },

        /**
         * Runs to the end, and answers with what an exit leaves behind: the
         * registry always, and the volume when asked for -- an installer's
         * output is the whole point of having run it, and the process it was
         * written on is what the page disposes of next.
         *
         * @param {{ maxTurns?: number }} [runOptions]
         */
        async run(runOptions){
            const code = await app.run(runOptions);
            /** @type {unknown} */
            let registry = null;
            try
            {
                registry = app.registry().toJSON();
            }
            catch {
                // A build without a registry has none to hand over.
            }
            return {
                code,
                registry,
                files: started?.collectOnExit ? app.session.export() : [],
            };
        },
        pause: ()=>app.pause(),
        resume: ()=>app.resume(),
        stop: ()=>app.stop(),
        /**
         * Ends the program and frees its device, and keeps the canvas for
         * the next one: the worker is the page's to end.
         */
        async dispose(){
            const ending = app;
            app = null;
            started = null;
            await ending?.dispose();
            device?.destroy?.();
            device = null;
        },
        /**
         * Every layer's table, or one layer's: a reader after a few counters
         * pays for the one table it reads rather than for all of them.
         *
         * @param {string} [layer]
         */
        diagnostics: layer=>{
            const tables = app.diagnostics();
            return plain(layer === undefined
                ? tables
                : tables.filter((/** @type {{ name: string }} */ table)=>table.name === layer));
        },
        trace: ()=>app.trace(),
        presented: ()=>({ count: frames, history: presented.slice() }),
        'log.recent': (/** @type {number} */ count)=>app.log.recent(count),
        'log.drain': (/** @type {number} */ since, /** @type {number} */ limit)=>
            app.log.drain(since, limit),
        'log.setLevel': (/** @type {string} */ category, /** @type {string | number} */ level)=>
            app.log.setLevel(category, level),
        'log.setDefaultLevel': (/** @type {string | number} */ level)=>
            app.log.setDefaultLevel(level),
        'log.profile': (/** @type {number} */ worst)=>app.log.profile(worst),
        'log.frames': (/** @type {number} */ count)=>app.log.frames(count),
        'input.attach': ()=>viewport && app.input.attach(viewport, { listen: false }),
        'input.detach': ()=>app.input.detach(),
        /**
         * Subscribes the page to an event. Observing only: a handler on the
         * other side of a port cannot answer, so nothing it returns is waited for.
         *
         * @param {string} name
         */
        on: name=>{
            app.on(name, (/** @type {unknown} */ payload)=>{
                emit(name, payload);
            });
        },
    };

    port.onmessage = async(/** @type {{ data: import('./messages.js').ToEngine }} */ { data })=>{
        const message = data;
        poked?.();
        switch (message.type)
        {
            case 'input':
                app?.input.send(message.event);
                return;
            case 'visibility':
                hidden = message.hidden;
                return;
            case 'request':
            {
                const method = methods[message.method];
                try
                {
                    if (!method)
                    {
                        throw new Error(`no such method: ${message.method}`);
                    }
                    if (!app && message.method !== 'start' && message.method !== 'dispose')
                    {
                        throw new Error(`${message.method}: nothing has been started`);
                    }
                    const result = await method(...message.args);
                    post({ type: 'answer', id: message.id,
                        result: message.method === 'diagnostics' ? result : cloneable(result) });
                }
                catch (e){
                    post({ type: 'answer', id: message.id, error: describe(e) });
                }
                return;
            }
            default:
                return;
        }
    };

    return {
        close(){
            port.onmessage = null;
            breathe.close();
        },
    };
}
