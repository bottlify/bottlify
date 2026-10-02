/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The two halves of a Direct3D 7 object whose devices draw somewhere else:
 * the recorded object the program's DirectDraw object hands out, and the
 * played object that draws, over stand-ins of that DirectDraw object's
 * surfaces.
 *
 * A Direct3D 7 device draws into and samples DirectDraw surfaces, which are
 * another model's objects: the program locks, blits and flips them through
 * DirectDraw, and the device learns of it by asking them -- their address,
 * their uniqueness value, their colour key, the depth buffer attached. So a
 * surface crosses by number, described when a device first meets it and
 * again before a call that reads it once anything it is asked changed, and
 * its bytes go ahead of the draw that samples it once its uniqueness value
 * says the program wrote them; a vertex buffer's go with its unlock, as any
 * buffer's do, and an index array's with the draw that names it. What DirectDraw tells a device
 * -- a depth fill, a target written, a target about to be read -- reaches the
 * played one as calls, and a frame is shown from the address a flip puts on
 * the screen by a present the played side paces.
 */

import { createDirect3D7 } from '../d3d7/device.js';
import { D3D_OK, DDERR_NOTFOUND } from '../d3d7/constants.js';
import { DDCKEY_SRCBLT, DDSCAPS_ZBUFFER } from '../ddraw/constants.js';
import { createMirror, createPlayer, createRecording } from './replay.js';

/** The calls whose answer only the renderer has. */
const ANSWERED = new Set(['diagnostics', 'idle', 'ReadBack']);

/** The device calls before which the surfaces it reads are brought up to date. */
const READS_SURFACES = new Set(['Clear', 'DrawPrimitive', 'DrawIndexedPrimitive',
    'DrawPrimitiveVB', 'DrawIndexedPrimitiveVB']);

/**
 * What both sides make: the Direct3D 7 object over a DirectDraw object, and
 * the calls that describe that object's surfaces to the side that has only
 * stand-ins of them.
 *
 * @param {any} ddraw
 * @param {import('../d3d7/device.js').RenderServices} services
 * @param {ReturnType<typeof createStandIns> | null} [surfaces]  the played side's
 */
export function direct3D7Root(ddraw, services, surfaces = null){
    return {
        ...createDirect3D7(ddraw, services),
        /** @param {SurfaceDescription} description */
        DescribeSurface: description=>surfaces?.describe(description),
        /** @param {any} surface @param {SurfaceDescription} description */
        UpdateSurface: (surface, description)=>{
            surfaces?.update(surface, description);
        },
    };
}

/**
 * @typedef {Object} SurfaceDescription
 * @property {number} width
 * @property {number} height
 * @property {number} caps
 * @property {any} pixelFormat
 * @property {boolean} palette
 * @property {number} mipMapCount
 * @property {{ buffer: number, width: number, height: number, pitch: number,
 *     uniqueness: number }[]} levels  the surface and each of its mip levels
 * @property {number | null} colorKey  the source blit key's low colour
 * @property {any} depth  the depth buffer attached, a surface already described
 */

/**
 * The depth buffer attached to a surface, without the reference the walk takes.
 *
 * @param {any} surface
 */
function depthOf(surface){
    const found = surface.getAttachedSurface?.(DDSCAPS_ZBUFFER);
    if (!found || found.hr !== D3D_OK || !found.surface)
    {
        return null;
    }
    found.surface.release();
    return found.surface;
}

/** @param {any} surface @returns {any[]} the surface and its mip levels */
function levelsOf(surface){
    const levels = [];
    for (let level = surface; level && levels.length < Math.max(1, surface.mipMapCount);
        level = level.mipNext)
    {
        levels.push(level);
    }
    return levels;
}

/**
 * The played side's surfaces: a stand-in for each one described, with what a
 * Direct3D 7 device asks of a surface, kept as the description last said.
 */
export function createStandIns(){
    /** @param {any} level @param {SurfaceDescription['levels'][number]} described */
    const setLevel = (level, described)=>{
        level.buffer = described.buffer;
        level.width = described.width;
        level.height = described.height;
        level.pitch = described.pitch;
        level.uniqueness = described.uniqueness;
    };
    const level = ()=>({
        buffer: 0, width: 0, height: 0, pitch: 0, uniqueness: 0,
        /** @type {any} */
        mipNext: null,
        uniquenessValue(){
            return this.uniqueness;
        },
    });
    /** @param {any} surface @param {SurfaceDescription} description */
    const apply = (surface, description)=>{
        surface.width = description.width;
        surface.height = description.height;
        surface.caps = description.caps;
        surface.pixelFormat = description.pixelFormat;
        surface.palette = description.palette ? {} : null;
        surface.mipMapCount = description.mipMapCount;
        surface.colorKey = description.colorKey;
        surface.depth = description.depth ?? null;
        /** @type {any} */
        let at = surface;
        description.levels.forEach((described, index)=>{
            if (index > 0)
            {
                at.mipNext ??= level();
                at = at.mipNext;
            }
            setLevel(at, described);
        });
    };
    return {
        /** @param {SurfaceDescription} description */
        describe(description){
            const surface = {
                ...level(),
                width: 0,
                height: 0,
                caps: 0,
                pixelFormat: {},
                /** @type {object | null} */
                palette: null,
                mipMapCount: 1,
                /** @type {number | null} */
                colorKey: null,
                /** @type {any} */
                depth: null,
                destroyed: false,
                addRef: ()=>1,
                release: ()=>1,
                /** @param {number} which */
                getColorKey(which){
                    return which === DDCKEY_SRCBLT && this.colorKey !== null
                        ? { hr: D3D_OK, key: { low: this.colorKey, high: this.colorKey } }
                        : { hr: DDERR_NOTFOUND, key: null };
                },
                getAttachedSurface(){
                    return this.depth
                        ? { hr: D3D_OK, surface: this.depth }
                        : { hr: DDERR_NOTFOUND, surface: null };
                },
            };
            apply(surface, description);
            return surface;
        },
        update: apply,
    };
}

/**
 * The Direct3D 7 object the program's DirectDraw object hands out: every
 * call on it and on the devices and buffers it makes made on objects with no
 * renderer behind them, and sent.
 *
 * @param {any} ddraw  the DirectDraw model root
 * @param {import('../d3d7/device.js').RenderServices & { readMemory: (address: number,
 *     length: number) => Uint8Array }} services  what the device would be given;
 *     its backend is not used, and its presenter is told the addresses the
 *     played side draws into
 * @param {import('./replay.js').Transport} transport
 * @returns {any}
 */
export function recordedDirect3D7(ddraw, services, transport){
    const { readMemory, presenter } = services;
    /** @type {ReturnType<typeof createRecording> | null} */
    let recording = null;
    // The device's own allocations, a vertex buffer's, are made through the
    // DirectDraw object; the played side is handed the same addresses.
    const seen = Object.create(ddraw);
    seen.allocateStorage = (/** @type {number} */ bytes)=>{
        const address = ddraw.allocateStorage(bytes);
        recording?.allocated(address, Math.max(bytes, 1));
        return address;
    };
    const root = direct3D7Root(seen, { readMemory });
    recording = createRecording({
        root,
        readMemory,
        transport,
        answered: (_, name)=>ANSWERED.has(name),
        answers: ANSWERED,
    });
    const live = recording;
    const recorded = live.root;

    /** @param {number} address @param {number} length */
    const ship = (address, length)=>{
        if (length > 0)
        {
            live.read(address >>> 0, readMemory(address >>> 0, length));
        }
    };

    /**
     * What a surface was last described as, and the levels whose bytes went
     * as a texture's.
     *
     * @type {Map<any, { key: string, format: any, sent: Map<number, string> }>}
     */
    const known = new Map();

    /** Each depth buffer met, by the order it was met. @type {Map<any, number>} */
    const depths = new Map();
    /**
     * Everything a description says, as one string: a surface whose string
     * is the one last sent is described as it stands.
     *
     * @param {any} surface @param {any} depth
     */
    const keyOf = (surface, depth)=>{
        let key = `${surface.width},${surface.height},${surface.caps},`
            + `${surface.palette === null ? 0 : 1},${surface.mipMapCount},`
            + `${surface.getColorKey(DDCKEY_SRCBLT).key?.low ?? 'n'}`;
        for (const level of levelsOf(surface))
        {
            key += `|${level.buffer}:${level.uniquenessValue()}:${level.pitch}`;
        }
        if (!depth)
        {
            return key;
        }
        let number = depths.get(depth);
        if (number === undefined)
        {
            number = depths.size;
            depths.set(depth, number);
        }
        return `${key}|d${number}`;
    };

    /** @param {any} surface @param {any} depth @returns {SurfaceDescription} */
    const describe = (surface, depth)=>({
        width: surface.width,
        height: surface.height,
        caps: surface.caps,
        pixelFormat: { ...surface.pixelFormat },
        palette: surface.palette !== null,
        mipMapCount: surface.mipMapCount,
        levels: levelsOf(surface).map(level=>({ buffer: level.buffer, width: level.width,
            height: level.height, pitch: level.pitch, uniqueness: level.uniquenessValue() })),
        colorKey: surface.getColorKey(DDCKEY_SRCBLT).key?.low ?? null,
        depth,
    });

    /**
     * Brings the played side's stand-in of a surface up to date with it, and
     * its depth buffer's first.
     *
     * @param {any} surface
     */
    const ensure = surface=>{
        const depth = (surface.caps & DDSCAPS_ZBUFFER) === 0 ? depthOf(surface) : null;
        if (depth)
        {
            ensure(depth);
        }
        const key = keyOf(surface, depth);
        const last = known.get(surface);
        if (!last)
        {
            recorded.DescribeSurface(describe(surface, depth));
            live.adopt(surface);
            known.set(surface, { key, format: surface.pixelFormat, sent: new Map() });
            return;
        }
        if (last.key !== key || last.format !== surface.pixelFormat)
        {
            recorded.UpdateSurface(surface, describe(surface, depth));
            last.key = key;
            last.format = surface.pixelFormat;
        }
    };

    /**
     * A texture's levels the program wrote since they last went, sent: a
     * renderer takes a texture's bytes at the first draw that samples it.
     *
     * @param {any} surface
     */
    const shipTexture = surface=>{
        ensure(surface);
        const sent = /** @type {{ sent: Map<number, string> }} */ (known.get(surface)).sent;
        levelsOf(surface).forEach((level, index)=>{
            const at = `${level.buffer}:${level.uniquenessValue()}`;
            if (sent.get(index) !== at)
            {
                sent.set(index, at);
                ship(level.buffer, level.pitch * level.height);
            }
        });
    };

    /**
     * The devices made, each with the target and textures it was last given,
     * and the addresses it was found to draw into.
     *
     * @type {Set<{ proxy: any, target: any, textures: Map<number, any>, claimed: Set<number> }>}
     */
    const devices = new Set();

    /**
     * @param {any} proxy
     * @param {{ target: any, textures: Map<number, any>, claimed: Set<number> }} state
     */
    const syncTarget = (proxy, state)=>{
        ensure(state.target);
        const buffer = state.target.buffer >>> 0;
        if (presenter && !state.claimed.has(buffer))
        {
            state.claimed.add(buffer);
            presenter.claim(buffer, ()=>{
                syncTarget(proxy, state);
                return proxy.Present(buffer);
            });
        }
    };

    /** @param {any} surface */
    const drawingInto = surface=>{
        for (const device of devices)
        {
            if (device.claimed.has(surface.buffer >>> 0))
            {
                return device;
            }
        }
        return null;
    };

    // What DirectDraw tells a device of its surfaces, told the played one.
    const stopWatchingPixels = ddraw.watchPixels?.({
        readBack: (/** @type {any} */ surface)=>{
            const device = (surface.caps & DDSCAPS_ZBUFFER) === 0 ? drawingInto(surface) : null;
            if (!device)
            {
                return null;
            }
            ensure(surface);
            const answer = device.proxy.ReadBack(surface);
            return answer instanceof Promise ? answer.then(()=>undefined) : null;
        },
        written: (/** @type {any} */ surface)=>{
            const device = (surface.caps & DDSCAPS_ZBUFFER) === 0 ? drawingInto(surface) : null;
            if (device)
            {
                ship(surface.buffer, surface.pitch * surface.height);
                ensure(surface);
                device.proxy.PixelsWritten(surface);
            }
        },
    }) ?? (()=>{});
    const stopWatchingDepth = ddraw.watchDepthFills?.(
        (/** @type {any} */ surface, /** @type {any} */ rect, /** @type {number} */ value)=>{
            for (const device of devices)
            {
                if (known.has(surface) && depthOf(device.target) === surface)
                {
                    ensure(surface);
                    device.proxy.DepthFilled(surface, rect ? { ...rect } : null, value);
                }
            }
        }) ?? (()=>{});

    /**
     * A device as the program is given it: its calls recorded, and before
     * one that reads surfaces, what it reads brought up to date.
     *
     * @param {any} proxy @param {any} target
     */
    const deviceOf = (proxy, target)=>{
        const state = { proxy, target, textures: new Map(), claimed: new Set() };
        devices.add(state);
        syncTarget(proxy, state);
        const sync = ()=>{
            syncTarget(proxy, state);
            for (const surface of state.textures.values())
            {
                shipTexture(surface);
            }
        };
        /** @type {Record<string, Function>} */
        const own = {
            /** @param {number} stage @param {any} surface */
            SetTexture(stage, surface){
                if (surface)
                {
                    ensure(surface);
                }
                const hr = proxy.SetTexture(stage, surface);
                if (hr === D3D_OK)
                {
                    if (surface)
                    {
                        state.textures.set(stage, surface);
                    }
                    else
                    {
                        state.textures.delete(stage);
                    }
                }
                return hr;
            },
            /** @param {any} surface */
            SetRenderTarget(surface){
                if (surface)
                {
                    ensure(surface);
                }
                const hr = proxy.SetRenderTarget(surface);
                if (hr === D3D_OK)
                {
                    state.target = surface;
                    syncTarget(proxy, state);
                }
                return hr;
            },
            /** @param {any[]} args */
            DrawIndexedPrimitiveVB(...args){
                sync();
                ship(args[4], args[5] * 2);
                return proxy.DrawIndexedPrimitiveVB(...args);
            },
            release(){
                const count = proxy.release();
                if (count === 0)
                {
                    devices.delete(state);
                    for (const buffer of state.claimed)
                    {
                        presenter?.release(buffer);
                    }
                }
                return count;
            },
        };
        return new Proxy(proxy, {
            get(inner, key){
                if (typeof key === 'string')
                {
                    const mine = own[key];
                    if (mine)
                    {
                        return mine;
                    }
                    if (READS_SURFACES.has(key))
                    {
                        return (/** @type {any[]} */ ...args)=>{
                            sync();
                            return inner[key](...args);
                        };
                    }
                }
                return Reflect.get(inner, key);
            },
        });
    };

    return {
        enumDevices: ()=>recorded.enumDevices(),
        /** @param {string} deviceId @param {any} surface */
        createDevice(deviceId, surface){
            if (surface)
            {
                ensure(surface);
            }
            const made = recorded.createDevice(deviceId, surface);
            return made.device ? { hr: made.hr, device: deviceOf(made.device, surface) } : made;
        },
        /**
         * A vertex buffer's bytes go with its unlock, as any buffer's whose
         * block the recording was told of.
         *
         * @param {any} desc
         */
        createVertexBuffer: desc=>recorded.createVertexBuffer(desc),
        /** Stops telling the played side of DirectDraw's surfaces. */
        dispose(){
            stopWatchingPixels();
            stopWatchingDepth();
        },
    };
}

/**
 * The Direct3D 7 object that draws, over stand-ins of the program's surfaces
 * and a guest memory of only the bytes it was sent.
 *
 * @param {import('../d3d7/device.js').RenderServices} services  what the device
 *     is given but for memory: `writeMemory` is where pixels read back go
 * @returns {{ root: any, play: (call: import('./wire.js').ReadCall) => any,
 *     read: (buffer: ArrayBuffer, each: (call: import('./wire.js').ReadCall) => boolean | void)
 *         => void }}
 */
export function playedDirect3D7(services){
    const mirror = createMirror();
    /** @type {ReturnType<typeof createPlayer> | null} */
    let player = null;
    let playing = false;
    const write = services.writeMemory;
    const ddraw = {
        addRef: ()=>1,
        release: ()=>1,
        allocateStorage: ()=>/** @type {ReturnType<typeof createPlayer>} */ (player).allocate(),
        freeStorage: ()=>{},
        watchDepthFills: ()=>()=>{},
        watchPixels: ()=>()=>{},
    };
    const root = direct3D7Root(ddraw, {
        ...services,
        readMemory: mirror.read,
        writeMemory: (address, bytes)=>{
            mirror.write(address, bytes);
            if (!playing)
            {
                write?.(address, bytes);
            }
        },
        presenter: undefined,
    }, createStandIns());
    player = createPlayer({ root, ship: mirror.write, read: mirror.read });
    const live = player;
    return {
        root,
        play: call=>{
            playing = true;
            try
            {
                return live.play(call);
            }
            finally
            {
                playing = false;
            }
        },
        read: live.read,
    };
}
