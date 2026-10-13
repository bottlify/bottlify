/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createBackend } from './webgpu/backend.js';
import { createDirectDraw } from './ddraw/objects.js';
import { createDirect3D8 } from './d3d8/device.js';
import { createDirect3D9 } from './d3d9/device.js';
import { profileBehaviour, profileCaps } from './seam/adapter.js';
import { connectGraphicsWorker } from './remote/connect.js';
import { createGraphicsLibraries } from './seam/exports.js';
import { createOpengl } from './opengl/exports.js';
import { createVulkan } from './vulkan/runtime.js';
import { createPresenter, expandRow } from './webgpu/internal/presenter.js';
import { createGdiDrawing } from './gdi/context.js';
import { createFontEngine } from './gdi/fonts.js';
import {
    createSurface, dibPitch, intersectRect, isEmptyRect, surfaceForDdb, surfaceForDibSection,
    viewOf,
} from './gdi/surface.js';
import { textExtent } from './gdi/text.js';
import { DEFAULT_VIDEO_MEMORY, GRAPHICS_CHOICES, graphicsChoice } from './choice.js';

/**
 * A window as the window manager lists it: enough to know where it is on
 * the screen, whether it is seen, and whether it is a top-level window or
 * inside one.
 *
 * @typedef {Object} ListedWindow
 * @property {string} hwnd
 * @property {import('./gdi/contract.js').Rect} rect     The whole window, on the screen.
 * @property {import('./gdi/contract.js').Rect} client   Its client area, on the screen.
 * @property {boolean} visible
 * @property {boolean} [child]   Placed inside its parent rather than owned by it.
 * @property {string | null} parent
 */

/** @param {import('./gdi/contract.js').Rect} a @param {import('./gdi/contract.js').Rect} b */
const sameRect = (a, b)=>a.left === b.left && a.top === b.top && a.right === b.right
    && a.bottom === b.bottom;

/**
 * What is left of a rectangle once another is taken out of it: up to four
 * pieces, the strips above and below the hole and the ones beside it.
 *
 * @param {import('./gdi/contract.js').Rect} rect
 * @param {import('./gdi/contract.js').Rect} hole
 * @returns {import('./gdi/contract.js').Rect[]}
 */
const subtractRect = (rect, hole)=>{
    const cut = intersectRect(rect, hole);
    if (isEmptyRect(cut))
    {
        return [rect];
    }
    return [
        { left: rect.left, top: rect.top, right: rect.right, bottom: cut.top },
        { left: rect.left, top: cut.bottom, right: rect.right, bottom: rect.bottom },
        { left: rect.left, top: cut.top, right: cut.left, bottom: cut.bottom },
        { left: cut.right, top: cut.top, right: rect.right, bottom: cut.bottom },
    ].filter(piece=>!isEmptyRect(piece));
};

/**
 * Where a primary surface's pixels show on the screen: its window's client
 * area -- or the whole screen in exclusive mode -- less every shown
 * top-level window above that window in z-order. Null when the program has
 * no window to own the picture, which leaves the primary shown as it is.
 *
 * The list is in the order the window manager paints: top-level windows
 * from the bottom up. A window inside another is inside its area and is
 * not counted as over it, which is what a primary without a clipper sees --
 * except in exclusive mode, where GDI paints the screen itself and a
 * control inside the program's window is drawn over the picture.
 *
 * @param {ListedWindow[]} windows
 * @param {number} owner      The cooperative window, or zero for the topmost.
 * @param {boolean} exclusive
 * @param {import('./gdi/contract.js').Rect} screen
 * @returns {import('./gdi/contract.js').Rect[] | null}
 */
export function uncoveredRegion(windows, owner, exclusive, screen){
    const byHandle = new Map(windows.map(window=>[window.hwnd, window]));
    /** @param {ListedWindow} window @returns {ListedWindow | null} the one it is inside */
    const parentOf = window=>(window.child && window.parent
        ? byHandle.get(window.parent) ?? null : null);
    /** @param {ListedWindow} window */
    const shown = window=>{
        for (let at = /** @type {ListedWindow | null} */ (window); at; at = parentOf(at))
        {
            if (!at.visible)
            {
                return false;
            }
        }
        return true;
    };
    /** @param {ListedWindow} window */
    const topLevelOf = window=>{
        let at = window;
        for (let up = parentOf(at); up; up = parentOf(at))
        {
            at = up;
        }
        return at;
    };
    const topLevels = windows.filter(window=>!window.child && shown(window));
    // A hidden window has no place on the screen to hold the picture, and in
    // exclusive mode a flip shows whatever the cooperative window's state: a
    // launcher that names its own dialog, hides it and runs the game in a
    // window of its own owns the picture through that window. Counting from
    // the hidden one put every shown window over the picture.
    const named = byHandle.get(`0x${(owner >>> 0).toString(16)}`);
    const namedTop = named ? topLevelOf(named) : null;
    const owning = namedTop && topLevels.includes(namedTop) ? namedTop : topLevels.at(-1);
    if (!owning)
    {
        return null;
    }
    const base = intersectRect(exclusive ? screen : owning.client, screen);
    if (isEmptyRect(base))
    {
        return [];
    }
    let region = [base];
    for (const above of topLevels.slice(topLevels.indexOf(owning) + 1))
    {
        region = region.flatMap(piece=>subtractRect(piece, above.rect));
    }
    if (exclusive)
    {
        // In exclusive mode GDI paints straight onto the screen the primary
        // is: a control inside the program's own window -- the edit box a
        // name is typed into -- shows over the picture, not under it.
        for (const inside of windows.filter(window=>window.child && shown(window)
            && window !== owning && topLevelOf(window) === owning))
        {
            region = region.flatMap(piece=>subtractRect(piece, inside.rect));
        }
    }
    return region;
}

/**
 * graphics — every drawing API a program might have been written against, over
 * one backend.
 *
 * The shape of this module follows from a fact about the work rather than a
 * preference: DirectDraw, Direct3D and OpenGL are separate APIs a program picks
 * between, and each is large. So each lives in its own directory, and this file
 * is only the place they are handed what they share -- the backend, the address
 * space, and the way a guest call reaches us. Nothing here implements anything.
 *
 * The backend is not created until someone asks for it. Building the module
 * graph must stay cheap and must not require a GPU: a build that never draws --
 * a console program, a test, an inspection of the configuration -- should not
 * pay for a device, and on a machine with no WebGPU at all it must still come
 * up rather than fail at assembly time.
 */

/**
 * The owner GDI's device ramp is set under. One for every machine, because
 * the ramp is the display's rather than a process's: the next process on the
 * same canvas replaces it rather than stacking another on top.
 */
/**
 * What every dynamic buffer of the backend uploaded, summed: writes to the
 * queue, bytes, and the renames a DISCARD asked for or a hazard forced.
 *
 * @param {any} backend
 */
const bufferTotals = backend=>{
    /** @type {any[]} */
    const buffers = backend?.diagnostics?.().buffers ?? [];
    const sum = (/** @type {string} */ key)=>buffers.reduce(
        (total, one)=>total + (one[key] ?? 0), 0);
    return {
        bufferWrites: sum('writes'), bufferBytes: sum('written'),
        bufferDiscards: sum('discards'), bufferHazards: sum('hazards'),
        bufferLocks: sum('locks'), bufferWholeLocks: sum('wholeLocks'),
        bufferLocked: sum('locked'), dynamicBuffers: buffers.length,
    };
};

const DISPLAY_RAMP = 'display';

/** The graphics layer's module for one graph; see `defaultModules`. */
export function createGraphicsModule(){
    /**
     * The instance this module object made last, for `diagnostics()` and
     * `dispose()`. Every graph is given module objects of its own
     * (`defaultModules`), so a child's graph built beside its parent's has
     * its own and neither one's going reaches the other's.
     *
     * The module contract puts both on the module rather than on the api, so
     * something outside a `create()` call has to be able to see in. That is
     * the only reason this exists, and it holds a reference rather than the
     * state itself -- the backend, the factories, the published interfaces
     * and the run's presenter belong to the closure `create()` returns, so a
     * second instance in one realm cannot take the first one's GPU. Disposing
     * marks the instance closed, so a call still in flight when the machine
     * went away is answered the way a build with no graphics layer at all
     * answers it -- the stub's refusal -- rather than dereferencing what is
     * gone.
     *
     * @type {any}
     */
    let current = null;

    return {
        name: 'graphics',
        version: '0.1.0',
        requires: /** @type {readonly string[]} */ (['win32', 'bridge', 'memory']),

        /**
         * @param {any} config
         * @param {import('../../system/contract.js').ScopedModuleHost} host
         * @returns {Promise<any>}
         */
        async create(config, host){
            // The bottle's own graphics API, when it names one: its roots and
            // libraries alone are built. Refused before anything else if unknown.
            const choice = graphicsChoice(config?.choice);
            const stack = choice ? GRAPHICS_CHOICES[choice] : null;
            // The card's memory, in bytes: the configuration's figure where it
            // names one, else the choice's era, else a DirectX 9 card's. Every
            // API reports this one figure; a program that asks two of them
            // and compares is asking whether it is on one card.
            const videoMemory = (Number.isFinite(config?.videoMemory) && config.videoMemory > 0
                ? config.videoMemory : stack?.videoMemory ?? DEFAULT_VIDEO_MEMORY) * 1024 * 1024;
            const memory = host.requireApi('memory');
            const win32 = host.requireApi('win32');
            const bridge = host.requireApi('bridge');
            /**
             * Everything this instance owns, and whether it is still open.
             *
             * The calls an api hands out close over this object rather than over
             * module-level bindings, because `create()` may run more than once in
             * one realm -- a process replacement does, and the plan for more than
             * one machine in a worker needs two at once -- so each run keeps its
             * own backend. The presenter is in the state too, but its lifetime is
             * the run's: a given one is attached, never disposed here.
             *
             * @type {{ backend: any, factories: any, created: string[], seam: any,
             *     presenter: any, presenterGiven: boolean, shown: any, disposed: boolean,
             *     gammaOwners: Set<any>, remote: any }}
             */
            const state = {
                remote: null,
                backend: null,
                factories: null,
                created: [],
                seam: null,
                presenter: null,
                presenterGiven: false,
                shown: null,
                disposed: false,
                gammaOwners: new Set(),
            };

            /**
             * The display's gamma ramp, which is the run presenter's: whichever
             * ramp was set last is shown through. The owners this machine set one
             * for are kept, so that its devices' ramps go with it -- a presenter
             * the caller handed in outlives the process.
             *
             * @type {import('./webgpu/internal/presenter.js').DisplayGamma}
             */
            const displayGamma = {
                set(owner, ramp){
                    if (ramp)
                    {
                        state.gammaOwners.add(owner);
                    }
                    else
                    {
                        state.gammaOwners.delete(owner);
                    }
                    state.presenter?.setGammaRamp?.(owner, ramp);
                },
                applies: ()=>state.presenter?.appliesGamma?.() === true,
            };

            /**
             * The GPU, when there is one.
             *
             * Injected rather than discovered, for the same reason the filesystem's
             * stores are: this layer should be testable without a browser, and what
             * device to draw on is the assembling caller's decision, not ours.
             *
             * `draw: false` sets it aside: every API keeps the state a program
             * sets and answers what it asks, as in a build without one, and
             * nothing reaches a GPU or the processor's raster -- a run that
             * measures the program and the layers, not the drawing.
             */
            const drawing = config?.draw !== false;
            const device = drawing ? config?.device ?? null : null;

            // Data, not code: whether a title's kept-block-compressed art travels as
            // BC blocks is a configuration decision, not something the adapter's
            // feature bit alone should switch on for every title on this build --
            // a change that is faster on paper and jams the GPU process on some
            // hardware is not a fix until it is asked for. The feature bit still
            // has the final say either way: a device without it never samples BC.
            const hasBcFeature = device?.device?.features?.has('texture-compression-bc') === true;
            const compressedTextures = config?.compressedTextures === true && hasBcFeature;
            /** A factory's own override still cannot ask for BC on a device that cannot sample it. */
            const gatedCompressedTextures = (/** @type {any} */ caps)=>
                (caps?.compressedTextures ?? compressedTextures) && hasBcFeature;

            /**
             * The GPU going away. WebGPU settles `device.lost` once, for good; the
             * Direct3D 8 and 9 devices made on it are then lost the way a lost
             * display loses them, and one made afterwards starts lost. Nothing
             * here recovers: a Reset still answers D3DERR_DEVICELOST, because
             * there is no second GPU device to rebuild on. A device the host
             * destroyed is the run ending, not the GPU failing under the program.
             */
            const loss = { happened: false, /** @type {Set<() => void>} */ watchers: new Set() };
            const lose = ()=>{
                if (loss.happened)
                {
                    return;
                }
                loss.happened = true;
                for (const watcher of [...loss.watchers])
                {
                    watcher();
                }
                loss.watchers.clear();
            };
            device?.device?.lost?.then?.((/** @type {{ reason?: string }} */ info)=>{
                if (info?.reason !== 'destroyed')
                {
                    lose();
                }
            });
            /**
             * @param {() => void} watcher
             * @returns {() => void} how to stop watching
             */
            const onDeviceLost = watcher=>{
                if (loss.happened)
                {
                    watcher();
                    return ()=>{};
                }
                loss.watchers.add(watcher);
                return ()=>{
                    loss.watchers.delete(watcher);
                };
            };

            /**
             * A presenting call queued a frame: what it waits on before it
             * answers, or null. The count is the run presenter's, since every
             * machine's frames go onto the one queue.
             *
             * @type {import('./webgpu/internal/latency.js').FrameQueued}
             */
            const frameQueued = submitted=>state.shown?.queued(submitted) ?? null;

            /**
             * The graphics worker, when the assembling caller made one: the
             * Direct3D 8 and 9 devices draw there, on a GPU device of its own,
             * and this thread keeps only their state (`remote/`). Its frames
             * come back to be shown as this thread's own are, and its GPU
             * going away is this one's as far as those devices are concerned.
             *
             * A process in a worker of its own has no GPU and shows nothing: it
             * is handed only a way in to the run's graphics worker
             * (`config.worker`), and the frames its devices present go to the
             * thread that shows the run's.
             */
            const workerEnd = drawing ? device?.worker ?? config?.worker ?? null : null;
            const remote = workerEnd
                ? connectGraphicsWorker({
                    worker: workerEnd,
                    device: device?.device,
                    presentTo: device?.presentTo,
                    writeMemory: (address, bytes)=>memory.writeBytes(address, bytes),
                    // Where the memory is shared the worker writes what it reads
                    // back in place, and says only where.
                    sharedMemory: ()=>memory.shared?.() ?? null,
                    adoptMemory: (address, length)=>memory.adopt?.(address, length),
                    lendMemory: config?.lendMemory !== false,
                    // The process its frames are told apart by on the screen.
                    source: typeof config?.processId === 'number' ? config.processId : undefined,
                    divergence: config?.divergence,
                    lost: lose,
                    failed: message=>config?.divergence?.('graphics',
                        `the graphics worker stopped playing a device's calls: ${message}`),
                })
                : null;
            state.remote = remote;
            /**
             * A Direct3D 8 or 9 root, drawn here or in the graphics worker.
             *
             * @param {'d3d8' | 'd3d9'} name @param {(services: any) => any} factory
             * @param {any} services
             */
            const direct3d = (name, factory, services)=>(remote
                ? remote.root(name, factory, services)
                : factory(services));

            /** Everything an API needs from outside itself, in one place. */
            const services = {
                /** @param {number} address @param {number} length */
                readMemory: (address, length)=>memory.readBytes(address, length),
                /**
                 * The bytes themselves rather than a copy, valid until the guest
                 * runs again: for a path that reads a block on every call.
                 *
                 * @param {number} address @param {number} length
                 */
                windowMemory: (address, length)=>(memory.window
                    ? memory.window(address, length)
                    : memory.readBytes(address, length)),
                /** A dword, read in place. @param {number} address */
                readU32: address=>memory.readU32(address),
                /**
                 * A dword, written in place: an out-parameter without an array
                 * made to carry its four bytes. Absent where the memory given
                 * writes only bytes, and then the bytes carry it.
                 */
                writeU32: typeof memory.writeU32 === 'function'
                    ? (/** @type {number} */ address, /** @type {number} */ value)=>
                        memory.writeU32(address, value)
                    : undefined,
                /**
                 * `count` floats, decoded straight into `into` -- no window, no
                 * copy, no `DataView` -- for a fixed-count vector argument a
                 * handler consumes before it returns.
                 *
                 * @param {number} address @param {number} count @param {number[]} into
                 */
                readF32sInto: (address, count, into)=>memory.readF32sInto(address, count, into),
                /** @param {number} address @param {Uint8Array} bytes */
                writeMemory: (address, bytes)=>memory.writeBytes(address, bytes),
                /**
                 * Whether the guest may write `length` bytes at an address: an
                 * out-parameter the system probes before it writes through it,
                 * answering E_INVALIDARG where Windows could not write.
                 *
                 * @param {number} address @param {number} length
                 */
                writable: (address, length)=>{
                    const region = memory.find?.(address >>> 0);
                    return !!region && (address >>> 0) + length <= region.base + region.size
                        && region.access.includes('w');
                },
                /** How many bytes a surface of this size needs. */
                allocate: (/** @type {number} */ bytes)=>new Uint8Array(bytes),
                screen: config?.screen ?? { width: 640, height: 480, bitsPerPixel: 32 },
            };

            /** @type {Record<string, any>} */
            const factories = {
                /** @returns {any} */
                ddraw: (/** @type {any} */ options)=>createDirectDraw({
                    ...services,
                    // A surface's pixels are an address the program writes through
                    // and the presenter reads back, so they come out of the guest's
                    // heap -- not the byte arrays the services hand the others.
                    allocate: config?.allocate,
                    free: config?.free,
                    screenWidth: services.screen.width,
                    screenHeight: services.screen.height,
                    ...options,
                }),
                // The backend draws but does not make samplers, so the device it
                // draws through is the one that hands it that ability. Asking for
                // the backend here is what builds it: a program reaching this call
                // is about to draw.
                /** @returns {any} */
                d3d8: (/** @type {any} */ caps)=>direct3d('d3d8', createDirect3D8, {
                    ...caps,
                    // What the configuration asks for and the adapter actually
                    // offers, rather than a default that says yes on every machine
                    // with the feature. A device that can sample compressed blocks
                    // lets a program keep its art compressed: four to eight times
                    // less to upload, and it spares the program decompressing every
                    // texture in its own code -- once the configuration says the
                    // path is safe to take on this build.
                    compressedTextures: gatedCompressedTextures(caps),
                    videoMemory,
                    // Asked for only when this build has a GPU, as Direct3D 9's
                    // is: a device made in a headless assembly still keeps and
                    // answers every state a program sets.
                    backend: device && !remote ? api.backend() : undefined,
                    readMemory: services.readMemory,
                    windowMemory: services.windowMemory,
                    // A lock of a render target brings its pixels back into the
                    // guest's bytes before the pointer is handed out.
                    writeMemory: services.writeMemory,
                    createSampler: device ? (/** @type {any} */ descriptor)=>
                        device.device.createSampler(descriptor) : undefined,
                    // Where a locked surface or buffer's bytes live. It has to be
                    // memory the guest can write through, because the unlock reads
                    // back exactly what it wrote.
                    allocate: config?.allocate,
                    // And the way to give it back. A texture's pixels come out of
                    // the one arena the guest allocates from, and a program sizes
                    // its own asset cache from what that arena reports free -- so
                    // holding the pixels of a texture nobody references tells the
                    // program to stop keeping things.
                    free: config?.free,
                    // Rides on the device handle because that object reaches this
                    // layer exactly as the assembling caller wrote it, and a
                    // per-draw account of a frame is a thing only that caller can
                    // decide it wants: it costs a transform of every vertex.
                    dumpDraws: device?.dumpDraws === true,
                    dumpEvery: device?.dumpEvery,
                    maxDraws: device?.maxDraws,
                    divergence: config?.divergence,
                    skipTexture: device?.skipTexture,
                    probeTexture: device?.probeTexture,
                    fog: device?.fog,
                    mips: device?.mips,
                    nanProbe: device?.nanProbe,
                    driverRules: config?.driverRules,
                    ...profileBehaviour(device?.adapter),
                    keepMemory: config?.keepMemory,
                    rereadBuffers: config?.rereadBuffers,
                    onDeviceLost,
                    // Where a full-screen device's gamma ramp is shown.
                    gamma: displayGamma,
                    frameQueued,
                }),
                // The same wiring, except that the backend is asked for only when
                // this build has a GPU: a Direct3D 9 object made in a headless
                // assembly still answers everything a program can ask about state,
                // which is what "degraded, not broken" means for this layer.
                /** @returns {any} */
                d3d9: (/** @type {any} */ caps)=>direct3d('d3d9', createDirect3D9, {
                    ...caps,
                    // The adapter shown with a profile has that profile's shaders.
                    ...profileCaps(device?.adapter),
                    // The same configuration-and-adapter answer Direct3D 8 gets:
                    // Direct3D 9 put the question in CheckDeviceFormat rather than
                    // a cap bit, and a title that never asks still expects its DXT
                    // art to load. A device told no decompresses on its own CPU, in
                    // emulated x86, and hands over surfaces four times the size.
                    compressedTextures: gatedCompressedTextures(caps),
                    videoMemory,
                    backend: device && !remote ? api.backend() : undefined,
                    // Nothing drawn on purpose: an occlusion query answers that
                    // everything was seen, so the program culls nothing it would
                    // draw on a GPU and runs the work it would run there.
                    drawsNothing: !drawing,
                    readMemory: services.readMemory,
                    // What a draw from a dynamic buffer compares, in place: as a
                    // copy, it was most of a frame in a game that skins into one.
                    windowMemory: services.windowMemory,
                    // The copies between surfaces (UpdateSurface, StretchRect,
                    // GetRenderTargetData) move bytes only through this; the
                    // seam makes none of them itself.
                    writeMemory: services.writeMemory,
                    createSampler: device
                        ? (/** @type {any} */ descriptor)=>device.device.createSampler(descriptor)
                        : undefined,
                    allocate: config?.allocate,
                    free: config?.free,
                    // The same per-draw account and the same knobs Direct3D 8
                    // takes, for the same reason.
                    dumpDraws: device?.dumpDraws === true,
                    dumpEvery: device?.dumpEvery,
                    maxDraws: device?.maxDraws,
                    divergence: config?.divergence,
                    skipTexture: device?.skipTexture,
                    probeTexture: device?.probeTexture,
                    fog: device?.fog,
                    mips: device?.mips,
                    nanProbe: device?.nanProbe,
                    driverRules: config?.driverRules,
                    ...profileBehaviour(device?.adapter),
                    keepMemory: config?.keepMemory,
                    rereadBuffers: config?.rereadBuffers,
                    onDeviceLost,
                    gamma: displayGamma,
                    frameQueued,
                }),
                // OpenGL asks for a device only when there is one, so it is the
                // one API here that a headless build can run to a finished frame.
                /** @returns {any} */
                opengl: (/** @type {any} */ options)=>createOpengl({
                    readMemory: services.readMemory,
                    windowMemory: services.windowMemory,
                    readF32sInto: services.readF32sInto,
                    writeMemory: services.writeMemory,
                    screen: ()=>services.screen,
                    // With a device, contexts draw on it through the one backend
                    // and claim their pictures with the presenter; without one
                    // they draw on the processor, which is the headless build.
                    backend: device ? ()=>api.backend() : undefined,
                    createSampler: device
                        ? (/** @type {any} */ descriptor)=>device.device.createSampler(descriptor)
                        : undefined,
                    // The same configuration-and-adapter answer the other APIs get:
                    // kept blocks are four to eight times fewer bytes to upload,
                    // and spare the processor decoding every S3TC texture in the
                    // guest's own code.
                    compressedTextures,
                    presenter: ()=>state.shown,
                    frameQueued,
                    // The same per-draw account the Direct3D 8 device takes, on
                    // the device handle for the same reason: only the assembling
                    // caller decides it wants one.
                    dumpDraws: device?.dumpDraws === true,
                    dumpEvery: device?.dumpEvery,
                    maxDraws: device?.maxDraws,
                    skipTexture: device?.skipTexture,
                    probeTexture: device?.probeTexture,
                    keepImages: device?.keepImages,
                    // Which window a DC belongs to is GDI's knowledge, and the
                    // pixel format belongs to the window: without this every DC
                    // would be a drawable of its own and a format set on one
                    // would be lost to the next.
                    /** @param {number} hdc */
                    describeDrawable: hdc=>win32.gdi().describeDrawable(hdc),
                    // WGL's refusals are read with GetLastError.
                    /** @param {number} code */
                    setLastError: code=>win32.setLastError?.(code),
                    // A context is current on one thread at a time, and another
                    // thread's MakeCurrent or DeleteContext of it is ERROR_BUSY.
                    currentThread: ()=>bridge.callerThread?.()?.id ?? 0,
                    // Where the routines of a context's command ring find its
                    // block: the calling thread's TEB.
                    currentTeb: ()=>bridge.callerThread?.()?.tebAddress ?? 0,
                    // On the configuration rather than the device handle: it
                    // concerns the build that has no device.
                    raster: drawing ? config?.raster : false,
                    // With a graphics worker, contexts keep their state here and
                    // draw there, as Direct3D 8 and 9 devices do.
                    remote: remote
                        ? (/** @type {any} */ factory, /** @type {any} */ rootServices)=>
                            remote.root('opengl', factory, rootServices)
                        : undefined,
                    ...options,
                }),
                // Direct3D 10's seam makes the device itself from what a program
                // passes; this hands it the GPU, reached only when one is made.
                /** @returns {import('./d3d10/device.js').DeviceOptions} */
                d3d10: (/** @type {any} */ caps)=>({
                    backend: device ? api.backend() : undefined,
                    createSampler: device
                        ? (/** @type {any} */ descriptor)=>device.device.createSampler(descriptor)
                        : undefined,
                    createTexture: device
                        ? (/** @type {any} */ descriptor)=>device.device.createTexture(descriptor)
                        : undefined,
                    divergence: config?.divergence,
                    // The configuration-and-adapter answer the other APIs get.
                    compressedTextures: gatedCompressedTextures(caps),
                    // A timestamp query is read against the program's own timers,
                    // which run on the guest's clock, as the raster does.
                    now: config?.guestNow,
                    // Only a device made with the feature can leave depth
                    // unclipped, which is what DepthClipEnable = FALSE asks.
                    depthClipControl: device?.device?.features?.has('depth-clip-control') === true,
                    frameQueued,
                }),
                /** @returns {any} */
                vulkan: (/** @type {any} */ options)=>createVulkan({
                    readMemory: services.readMemory,
                    writeMemory: services.writeMemory,
                    backend: ()=>api.backend(),
                    screen: ()=>services.screen,
                    compressedTextures,
                    adapter: ()=>api.adapter(),
                    divergence: config?.divergence,
                    ...options,
                }),
            };
            for (const name of Object.keys(factories))
            {
                if (stack && !stack.apis.includes(name))
                {
                    delete factories[name];
                }
            }

            /**
             * The libraries a program links against to reach any of this.
             *
             * Built here rather than in the seam because it needs both halves: the
             * factories above, and the bridge's vtable publisher. Nothing is
             * created until a program calls one of these -- the tables are entry
             * points, not objects.
             */
            const api = {
                /**
                 * The backend, built on first use.
                 *
                 * Throws rather than returning null when there is no device: a
                 * caller that has got this far is about to draw, and a null here
                 * would fail somewhere further away with less to say.
                 */
                backend(){
                    if (!state.backend)
                    {
                        if (!device)
                        {
                            throw new Error(
                                'graphics: no GPU device was supplied to this build');
                        }
                        state.backend = createBackend({
                            device: device.device,
                            queue: device.queue,
                            presentTo: device.presentTo,
                        });
                    }
                    return state.backend;
                },

                /** Whether this build can draw at all. */
                available: ()=>device !== null,

                /**
                 * Settles once the devices drawing in the graphics worker have
                 * answered the diagnostics asked of them so far: what they say
                 * comes back a message later, and a reader that asks once and
                 * reads at once reads nothing.
                 *
                 * @returns {Promise<void>}
                 */
                answered: ()=>state.remote?.answered() ?? Promise.resolve(),

                /**
                 * The hardware behind the device, as the assembling caller knows
                 * it: vendor, architecture and description as WebGPU reports them.
                 * A program asks who made its adapter before deciding how much to
                 * ask of it, and an answer it can act on has to come from here.
                 *
                 * @returns {{ vendor?: string, architecture?: string, description?: string }
                 *     | null}
                 */
                adapter: ()=>device?.adapter ?? null,

                /** The card's memory in bytes, as every API reports it. */
                videoMemory: ()=>videoMemory,

                /**
                 * Shows a surface the guest owns.
                 *
                 * Presentation is this layer's own responsibility and was reachable
                 * only from inside it: the drawing libraries were handed a way to
                 * present and nothing else was. Anything else that has pixels for
                 * the screen -- a film a filter graph decoded, a surface another
                 * layer composed -- had nowhere to send them, and asking silently
                 * found nothing to call.
                 *
                 * Shown the way a DirectDraw primary is: as the picture of a
                 * window, under whatever is over that window.
                 *
                 * @param {import('./webgpu/internal/presenter.js').PresentableSurface} surface
                 * @param {number} [window]  The window the picture belongs to; zero
                 *     for the program's topmost.
                 * @param {boolean} [exclusive]  Whether it covers the screen.
                 */
                present: (surface, window = 0, exclusive = false)=>
                    presentPrimary(surface, window, exclusive),

                /**
                 * The display the program asked for. Anything drawn outside the
                 * drawing libraries -- a film, an overlay -- has to fit into this
                 * rather than resize it.
                 */
                screen: ()=>services.screen,

                /**
                 * Makes one of the APIs a program may have been written against.
                 * Named rather than exported directly, so that adding one does not
                 * change this module's shape.
                 *
                 * @param {string} name
                 * @param {any} [options]
                 */
                create(name, options){
                    const factory = factories[name];
                    if (!factory)
                    {
                        throw new Error(`graphics: no such API "${name}"`);
                    }
                    state.created.push(name);
                    return factory(options);
                },

                /** Which APIs this build can hand out. */
                apis: ()=>Object.keys(factories),
            };
            state.factories = factories;

            // The presenter is a service of the run, not of this machine. The
            // canvas, the format it was configured in, the pacer that decides when
            // a burst is delivered and the texture the primary is copied into all
            // outlive the process being drawn for -- so the assembling caller makes
            // one and hands it in, and this layer attaches its own backend and
            // address space to it rather than making a second. A build assembled
            // without one -- a test, an inspection -- gets its own, so the layer
            // still presents on its own.
            state.presenterGiven = config?.presenter != null;
            state.presenter = config?.presenter ?? createPresenter({
                device: device?.device,
                queue: device?.queue,
                screen: device?.screen,
                canvas: device?.canvas,
                now: config?.now,
                schedule: config?.schedule,
                maxFps: config?.maxFps,
                maxFrameLatency: config?.maxFrameLatency,
            });
            // The backend is asked for on the first present rather than now, so a
            // build that never shows one of these surfaces never builds a GPU.
            // Everything this machine presents or claims goes through what the
            // attachment answers, so none of it outlives the machine.
            state.shown = state.presenter.attach({
                backend: ()=>api.backend(),
                readMemory: services.readMemory,
                windowMemory: services.windowMemory,
            });

            /**
             * The desktop: one software surface the size of the display, in guest
             * memory so the presenter can read it the way it reads a DirectDraw
             * primary. Every window's device context is a view of it. Made on the
             * first window context rather than at start-up, so a program that
             * draws only through a device never pays for it, and remade if the
             * program's display changes size under it.
             *
             * @type {(import('./webgpu/internal/presenter.js').PresentableSurface
             *     & { surface: import('./gdi/contract.js').Surface }) | null}
             */
            let desktopSurface = null;
            /**
             * @param {number} buffer @param {number} pitch
             * @param {{ width: number, height: number }} screen
             */
            const viewOfDesktop = (buffer, pitch, screen)=>createSurface({
                width: screen.width, height: screen.height, pitch,
                bytes: services.windowMemory(buffer, pitch * screen.height),
            });
            const desktop = ()=>{
                const screen = services.screen;
                if (desktopSurface && (desktopSurface.width !== screen.width
                    || desktopSurface.height !== screen.height))
                {
                    config?.free?.(desktopSurface.buffer);
                    desktopSurface = null;
                }
                if (!desktopSurface)
                {
                    const pitch = dibPitch(screen.width, 32);
                    const buffer = win32.heap().allocate(pitch * screen.height) >>> 0;
                    if (buffer === 0)
                    {
                        return null;
                    }
                    desktopSurface = {
                        buffer, pitch, bitCount: 32, palette: null,
                        width: screen.width, height: screen.height,
                        surface: viewOfDesktop(buffer, pitch, screen),
                    };
                }
                else if (desktopSurface.surface.bytes.length === 0)
                {
                    // The emulator grew its memory, and every view of the old
                    // buffer went with it: the pixels are still at the same
                    // guest address, so the view is taken again over the new one.
                    desktopSurface.surface = viewOfDesktop(desktopSurface.buffer,
                        desktopSurface.pitch, screen);
                }
                return desktopSurface;
            };

            // The exclusive-mode picture and its window, while one holds the
            // screen; null when the screen is the desktop's.
            /** @type {{ surface: any, window: number } | null} */
            let fullScreen = null;

            /**
             * Shows a DirectDraw primary surface.
             *
             * There is one screen. A primary belongs to a window -- the one the
             * program named when it set its cooperative level, else its topmost
             * -- and its pixels are that window's client area on the desktop;
             * exclusive mode is the same window covering the screen. So
             * presenting the primary means copying it into the desktop where
             * the window is, minus every window above it, and showing the
             * desktop: a dialog over the picture stays over it. A primary with
             * nothing over it and the whole screen to itself is shown as it is,
             * which is the common case and costs no copy; that is decided from
             * the window list rather than from any flag.
             *
             * @param {import('./webgpu/internal/presenter.js').PresentableSurface} surface
             * @param {number} [window]    The cooperative window, or zero.
             * @param {boolean} [exclusive]
             */
            const presentPrimary = (surface, window = 0, exclusive = false)=>{
                fullScreen = exclusive ? { surface, window } : null;
                const screen = services.screen;
                // A picture the GPU owns has nothing worth reading in guest
                // memory, and a primary of another size than the screen has no
                // place on it. The ceiling on this: such a primary is shown as
                // it is, and anything over it is not seen.
                const wholeScreen = { left: 0, top: 0, right: screen.width, bottom: screen.height };
                const region = state.shown.isClaimed(surface.buffer)
                    || surface.width !== screen.width || surface.height !== screen.height
                    ? null
                    : uncoveredRegion(win32.windows?.() ?? [], window, exclusive, wholeScreen);
                if (!region || (region.length === 1 && sameRect(region[0], wholeScreen)))
                {
                    state.shown.present(surface);
                    return;
                }
                const target = desktop();
                if (!target)
                {
                    state.shown.present(surface);
                    return;
                }
                const bytesPerPixel = surface.bitCount >>> 3;
                const out = target.surface.bytes;
                for (const rect of region)
                {
                    const width = rect.right - rect.left;
                    if (width <= 0 || rect.bottom <= rect.top)
                    {
                        continue;
                    }
                    const rows = services.windowMemory(
                        surface.buffer + rect.top * surface.pitch + rect.left * bytesPerPixel,
                        (rect.bottom - rect.top - 1) * surface.pitch + width * bytesPerPixel);
                    for (let y = rect.top; y < rect.bottom; y++)
                    {
                        const from = (y - rect.top) * surface.pitch;
                        const at = target.surface.offset + y * target.pitch + rect.left * 4;
                        if (surface.bitCount === 32)
                        {
                            for (let byte = 0; byte < width * 4; byte++)
                            {
                                out[at + byte] = rows[from + byte];
                            }
                            continue;
                        }
                        expandRow(rows, width, surface.bitCount, surface.palette, out, from, at);
                        // The desktop's fourth byte is padding, as GDI keeps it,
                        // not the alpha a presented row carries.
                        for (let x = at + 3; x < at + width * 4; x += 4)
                        {
                            out[x] = 0;
                        }
                    }
                }
                state.shown.present(target);
            };

            /**
             * The font engine: the browser's own faces through a canvas, when the
             * platform has one. Made once for every context and every font, so a
             * glyph rasterised for one dialog is the same bitmap in the next.
             */
            const fonts = createFontEngine();
            /**
             * The cell a font measures as, with its glyphs, so an extent asked
             * without a device context is summed the way a drawn string is.
             *
             * @param {import('../win32/gdi32/structs.js').LogFontFields} font
             * @returns {import('./gdi/contract.js').TextMetrics | null}
             */
            const cellOf = font=>{
                const measured = fonts.metrics(font);
                return measured ? {
                    cellWidth: measured.aveCharWidth,
                    cellHeight: measured.height,
                    ascent: measured.ascent,
                    glyphs: code=>fonts.glyph(code, font),
                } : null;
            };

            state.seam = createGraphicsLibraries({
                graphics: api,
                only: stack?.libraries,
                memory: services,
                // Guest memory for the state a program sets without crossing,
                // and where to say when what it set there is not what the device
                // would have accepted.
                allocate: config?.allocate,
                allocateCode: config?.allocateCode,
                guestCode: config?.guestCode !== false,
                guestTraps: config?.guestTraps,
                free: config?.free,
                // What a program is handed to free with HeapFree itself.
                processHeapAllocate: (/** @type {number} */ bytes)=>
                    win32.processHeapAllocate?.(bytes) ?? 0,
                divergence: config?.divergence,
                // Where the work a device call does before its method -- the
                // guest's state brought to the device -- is timed, inside the
                // host call it is part of.
                phases: bridge.innerPhase,
                // The address of one of OPENGL32's own exports, which only the
                // assembling caller knows once the module is placed.
                exportAddress: config?.exportAddress,
                // Where a program's cursor goes, when the host shows one.
                cursor: config?.cursor,
                // The clock the display's raster -- the vertical blank and the
                // scan line -- runs on: the guest's, from the assembling caller
                // that owns it, because a program that spins on the blank times
                // the spin with its own timers. The host's without one.
                now: config?.guestNow,
                // Told the resolution a device is created at, so the reported
                // screen becomes that resolution.
                resolution: config?.resolution,
                // The client area of a window, which is the size a back buffer
                // asked for as zero by zero takes. Only the layer that owns the
                // windows can measure one, and only here is it asked for.
                windowClientSize: config?.windowClientSize,
                // Absent in a build with no bridge behind it -- a test, an
                // inspection -- which then gets tables that refuse rather than
                // tables that publish into nowhere.
                publishInterface: config?.publishInterface ?? (()=>0),
                // And the way to give back an interface with no Release -- a
                // reflection's constant buffer -- when what handed it out ends.
                unpublishInterface: config?.unpublishInterface,
                screen: ()=>services.screen,
                // What makes GetDC on a surface mean anything: gdi32 hands back a
                // context whose bitmap addresses the surface's own bytes, so a
                // program that gets a context and draws with GDI is drawing into
                // the surface rather than into a copy of it. Without this the
                // handle is one nothing else recognises.
                // Reached when a program asks rather than now: a build assembled
                // without win32 gets a stub, and a stub refuses -- which is the
                // right answer to GetDC and the wrong answer to starting up.
                gdi: {
                    /** @param {any} attributes */
                    createSurfaceDc: attributes=>win32.gdi().createSurfaceDc(attributes),
                    /** @param {number} handle */
                    deleteSurfaceDc: handle=>win32.gdi().deleteSurfaceDc(handle),
                },

                present: presentPrimary,
                // A flip ends a frame of the primary: the one the presenter
                // makes of the burst the flip is in, once that is on the queue
                // -- a Direct3D 7 target's replay, or the guest bytes' upload.
                flipQueued: ()=>{
                    const burst = state.shown?.flushed() ?? null;
                    return burst ? frameQueued(burst) : null;
                },
                // A DirectDraw primary's gamma ramp is the display's.
                gamma: displayGamma,
                // What exclusive mode is lost on. Asked on each TestCooperativeLevel
                // rather than now: win32 answers about windows made later.
                deactivated: ()=>win32.applicationDeactivated?.() === true,
                deactivations: ()=>win32.applicationDeactivations?.() ?? 0,

                // What a Direct3D 7 device draws with. Reached when a program
                // first asks its DirectDraw object for Direct3D, not now, so a
                // build that never gets there never builds a GPU.
                //
                // The presenter goes with it rather than only its `present`
                // function: a surface the GPU rendered into has nothing worth
                // reading in guest memory, so the device claims that address and
                // the presenter shows the texture instead of the stale bytes.
                render: ()=>({
                    // With a graphics worker, devices keep their state here and
                    // draw there, as Direct3D 8 and 9 devices do.
                    remote: remote
                        ? (/** @type {any} */ ddraw, /** @type {any} */ renderServices)=>
                            remote.root('d3d7', ()=>null, { ...renderServices, ddraw })
                        : undefined,
                    backend: device && !remote ? api.backend() : undefined,
                    readMemory: services.readMemory,
                    // A lock, a device context or a blit of a render target brings
                    // what the GPU drew back into the guest's bytes first.
                    writeMemory: services.writeMemory,
                    createSampler: device
                        ? (/** @type {any} */ descriptor)=>device.device.createSampler(descriptor)
                        : undefined,
                    // The same per-draw account Direct3D 8 and 9 take.
                    dumpDraws: device?.dumpDraws === true,
                    dumpEvery: device?.dumpEvery,
                    maxDraws: device?.maxDraws,
                    skipTexture: device?.skipTexture,
                    probeTexture: device?.probeTexture,
                    presenter: state.shown,
                }),

                // Enumeration is the one thing here that runs guest code: the
                // program passes a function and expects to be called back once per
                // mode or surface, with a descriptor it can read for the duration
                // of the call.
                /** @param {any} call */
                callGuest: call=>bridge.callGuest(call),
                currentThread: ()=>bridge.callerThread(),
                scratch: {
                    /** @param {number} bytes */
                    allocate: bytes=>win32.heap().allocate(bytes),
                },
            });

            /**
             * Whether this instance is still open. There is no value that stands
             * in for a drawing API -- a backend, a device factory, a GDI drawing
             * -- so a call into a machine that has been disposed is answered the
             * way a build with no graphics layer at all answers it: the stub's
             * refusal. `graphics: null` in a configuration gets the same shape,
             * and a program that reaches it fails where it can see it rather than
             * dereferencing what disposal took away.
             */
            const live = ()=>!state.disposed;
            /** @param {string} name */
            const refuse = name=>{
                const error = /** @type {Error & { code: string }} */ (
                    new Error(`NOT_IMPLEMENTED: graphics.${name}`));
                error.code = 'NOT_IMPLEMENTED';
                throw error;
            };
            /**
             * @param {string} name
             * @param {(...args: any[]) => any} method
             * @returns {(...args: any[]) => any}
             */
            const guarded = (name, method)=>(...args)=>{
                if (!live())
                {
                    refuse(name);
                }
                return method(...args);
            };

            /**
             * GDI's own drawing, for the device contexts win32 keeps: the
             * engine a context is bound to, and the pixels a context draws
             * into -- a bitmap's own bytes in guest memory for a memory
             * context, a view of the desktop for a context over a window.
             */
            const gdiDrawing = ()=>({
                /** @param {{ objects: any, metrics: (font: number) => any }} options */
                create: options=>createGdiDrawing({ ...options, fonts }),
                /**
                 * What the font engine measures for a font, or null when
                 * there is no engine and the bookkeeping half's estimate stands.
                 *
                 * @param {import('../win32/gdi32/structs.js').LogFontFields} font
                 */
                fontMetrics: font=>fonts.metrics(font),
                /**
                 * One character's coverage in a font, or null without an engine:
                 * what D3DX's font draws its text from, as GDI does.
                 *
                 * @param {number} code
                 * @param {import('../win32/gdi32/structs.js').LogFontFields} font
                 */
                glyph: (code, font)=>fonts.glyph(code, font),
                /**
                 * A program's own font, under its family name, for as long as
                 * the run lasts: AddFontMemResourceEx's.
                 *
                 * @param {string} family @param {Uint8Array} bytes
                 */
                addFont: (family, bytes)=>fonts.addFace(family, bytes),
                /**
                 * How wide a string is in a font, or null without an engine.
                 *
                 * @param {import('../win32/gdi32/structs.js').LogFontFields} font
                 * @param {string} text
                 */
                textWidth: (font, text)=>{
                    const cell = cellOf(font);
                    return cell ? textExtent(text, cell) : null;
                },
                /**
                 * @param {{ kind: string, bounds?: { left: number, top: number,
                 *     right: number, bottom: number } }} dc
                 *     A window context names the screen rectangle it may
                 *     draw in, in screen coordinates; absent, the whole screen.
                 * @param {{ width: number, height: number, bitCount: number, bits?: number,
                 *     topDown?: boolean, palette?: number[], format?: string,
                 *     pixels?: Uint8Array, pitch?: number }} bitmap
                 *     A device-dependent bitmap carries its own `pixels`; a DIB
                 *     section's `bits` are a guest address.
                 */
                surfaceFor: (dc, bitmap)=>{
                    if (dc.kind !== 'memory')
                    {
                        const screen = desktop();
                        if (!screen)
                        {
                            return null;
                        }
                        return viewOf(screen.surface, dc.bounds ?? {
                            left: 0, top: 0, right: screen.width, bottom: screen.height,
                        });
                    }
                    if (bitmap.pixels)
                    {
                        return surfaceForDdb(bitmap);
                    }
                    const bits = bitmap.bits ?? 0;
                    if (bits === 0)
                    {
                        return null;
                    }
                    // The bitmap's own bytes, not a copy: a program draws into
                    // a DIB section and reads the pixels back through the
                    // pointer it was given, so the drawing has to land there.
                    // A section over memory the program laid out says its own stride.
                    const bytes = services.windowMemory(bits,
                        (bitmap.pitch ?? dibPitch(bitmap.width, bitmap.bitCount)) * bitmap.height);
                    return surfaceForDibSection({ ...bitmap, bits }, bytes, bits);
                },
                /** The desktop's pixels, or null in a build with no heap for them. */
                desktop: ()=>desktop()?.surface ?? null,
                /**
                 * Shows the desktop. Called after a paint pass rather than
                 * after every draw; the presenter coalesces what arrives
                 * within one flush anyway.
                 */
                presentDesktop: ()=>{
                    // A picture that has the screen to itself is what is on it:
                    // the windows under it are not seen, and the ones over it
                    // are composed onto it, so a paint pass shows the picture
                    // again rather than the desktop over it.
                    const held = fullScreen;
                    const owner = held && `0x${(held.window >>> 0).toString(16)}`;
                    if (held && !win32.applicationDeactivated?.()
                        && (win32.windows?.() ?? []).some(
                            (/** @type {ListedWindow} */ listed)=>listed.visible
                                && listed.hwnd === owner))
                    {
                        presentPrimary(held.surface, held.window, true);
                        return;
                    }
                    const screen = desktop();
                    if (screen)
                    {
                        state.shown.present({ ...screen, label: 'desktop' });
                    }
                },
                /**
                 * The display's ramp, as SetDeviceGammaRamp sets it: three
                 * channels of 256 sixteen-bit entries; null takes it back. A
                 * full-screen device's or a DirectDraw primary's ramp set after
                 * it is shown instead, until that one is taken back.
                 *
                 * @param {import('./webgpu/internal/presenter.js').GammaRamp | null} ramp
                 */
                setDisplayGamma: ramp=>displayGamma.set(DISPLAY_RAMP, ramp),
                /**
                 * The ramp the display shows through, whoever set it, or null
                 * when none was: GetDeviceGammaRamp answers the identity then.
                 */
                displayGamma: ()=>state.presenter?.gammaRamp?.() ?? null,
                /** Whether a ramp set reaches the picture at all. */
                appliesGamma: ()=>displayGamma.applies(),
            });

            current = state;
            return {
                backend: guarded('backend', api.backend),
                available: guarded('available', api.available),
                adapter: guarded('adapter', api.adapter),
                videoMemory: guarded('videoMemory', api.videoMemory),
                present: guarded('present', api.present),
                screen: guarded('screen', api.screen),
                create: guarded('create', api.create),
                apis: guarded('apis', api.apis),
                // A report may come after the machine went: nothing is asked
                // of a disposed worker end, so there is nothing to wait for.
                answered: ()=>(live() ? api.answered() : Promise.resolve()),

                /**
                 * The libraries, keyed as an import descriptor names them. The
                 * assembling caller merges these with win32's and hands the lot to
                 * the loader; nothing here needs a special case.
                 */
                libraries: guarded('libraries', ()=>state.seam.libraries),

                /**
                 * The pixel-format negotiation and frame presentation whose entry
                 * points GDI32 exports. win32 sits below this layer and cannot
                 * reach it, so the assembling caller hands this down.
                 */
                opengl: guarded('opengl', ()=>state.seam.opengl),

                gdiDrawing: guarded('gdiDrawing', gdiDrawing),
            };
        },

        /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
        diagnostics(){
            const instance = current;
            if (!instance || instance.disposed)
            {
                return {
                    name: 'graphics',
                    version: '0.1.0',
                    status: 'created',
                    metrics: {
                        apis: [],
                        libraries: [],
                        created: [],
                        seam: null,
                        shadow: null,
                        backend: null,
                        presenter: null,
                        pacing: null,
                    },
                };
            }
            return {
                name: 'graphics',
                version: '0.1.0',
                status: 'ready',
                metrics: {
                    apis: Object.keys(instance.factories),
                    // Which libraries a program can reach this layer through. It
                    // exports its own, and anything counting what is synthesised
                    // into guest memory has to include them.
                    libraries: Object.keys(instance.seam.libraries),
                    // What a program actually asked for says more about a run than
                    // what the build could have offered.
                    created: instance.created,
                    // Whether Direct3D 8 and 9 draw in the graphics worker, and
                    // how many roots it plays.
                    worker: instance.remote ? instance.remote.diagnostics() : null,
                    // Kept flat, where a report drops the structure above.
                    workerAnswers: instance.remote ? instance.remote.diagnostics().answers : null,
                    seam: instance.seam.diagnostics(),
                    // State the program set in the guest, and the calls that never
                    // crossed: the saving is a number here, not a belief.
                    shadow: instance.seam.shadow(),
                    backend: instance.backend ? instance.backend.diagnostics() : null,
                    // The dynamic buffers' uploads as numbers, which a report keeps
                    // where it drops the structure above.
                    ...bufferTotals(instance.backend),
                    // Counted separately from the backend's own: a surface shown
                    // through DirectDraw never enters a drawing pass, so nothing
                    // in those numbers says whether anything reached the screen.
                    presenter: instance.presenter ? instance.presenter.diagnostics() : null,
                    // Absent in a build with no display to pace against. The pacer
                    // is the presenter's now, because the rhythm it enforces is a
                    // property of the canvas rather than of the process.
                    pacing: instance.presenter ? instance.presenter.pacing() : null,
                },
            };
        },

        async dispose(){
            const instance = current;
            if (instance)
            {
                instance.remote?.dispose();
                if (instance.backend)
                {
                    instance.backend.dispose();
                }
                // A process's devices go with it, and so do their ramps; the
                // display's own is the display's, and the next process sees it.
                for (const owner of instance.gammaOwners)
                {
                    if (owner !== DISPLAY_RAMP)
                    {
                        instance.presenter?.setGammaRamp?.(owner, null);
                    }
                }
                instance.gammaOwners.clear();
                // The presenter belongs to the run, not to this machine: what
                // replaces this process draws into the same canvas and the same
                // texture, so it is left as it is but for this machine's
                // attachment, which goes with it. Only a presenter this layer
                // made itself -- a build assembled without one -- is disposed
                // here.
                instance.shown?.detach();
                if (instance.presenter && !instance.presenterGiven)
                {
                    instance.presenter.dispose?.();
                }
                instance.disposed = true;
            }
            current = null;
        },
    };
}

/** One graph's worth, for the boundary check and for a test that builds this layer alone. */
export const graphicsModule = createGraphicsModule();
