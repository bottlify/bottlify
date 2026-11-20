/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A bundle mounted as a process's volume: its index and blocks fetched by range
 * in windows that grow with the round trip, read ahead, kept in the block
 * cache, the bottle's own directories found in it - all that needs no process
 * of its own (`app.js` mounts it for one).
 */

import { openBundle } from '../layers/filesystem/internal/bundle/format.js';
import {
    blockCacheName, createBlockCache, resolveBlockStore, storedLength,
} from '../layers/filesystem/internal/bundle/cache.js';
import { HEAP_POOLS, NOT_MEASURED } from '../memory-zones.js';
import { BLOCK_MISS, createBundleSource } from '../layers/filesystem/internal/bundle/source.js';
import { decompressZstd } from '../zstd.js';
import { inflateRaw } from '../storage.js';
import { crc32 } from '../layers/filesystem/internal/bundle/crc32.js';
import { createUnionSource } from '../layers/filesystem/internal/union-source.js';
import { keepOriginStorageWithin } from '../storage-budget.js';

/**
 * @typedef {{ source: any, fetch: (needed: any[]) => Promise<void>,
 *     stop: () => void, ahead: () => number,
 *     refetched: () => { blocks: number, bytes: number },
 *     ranges: () => { requests: number, bytes: number },
 *     decoded: () => { blocks: number, bytes: number, ms: number },
 *     held: () => Record<string, number | string>,
 *     registry: Promise<any>, layerRegistries?: Promise<any[]> }} MountedBundle
 *     `layerRegistries`: the hives the layers carry, the first layer's first.
 */

/**
 * A range fetch that survives the network going away for a moment.
 *
 * This belongs to the engine rather than to whoever supplies `fetch`, and the
 * reason is a property of the format rather than a preference: a range of a
 * bundle is immutable, so asking for it again is always safe and always yields
 * the same bytes. Nothing else in the system can say that about a retry.
 *
 * A short read counts as a failure. A truncated range is the ordinary shape of
 * a glitch -- a proxy closing a connection early answers with fewer bytes and
 * no error at all -- and accepting it would put wrong bytes into a guest's file
 * with nothing downstream in a position to notice.
 *
 * Each wait is jittered downwards. A stall usually strands many blocks at once,
 * and an unjittered backoff would march them all at the same instant into the
 * server that just failed.
 *
 * @param {any} deps
 * @returns {(offset: number, length: number,
 *            verify?: (bytes: Uint8Array) => string | null) => Promise<Uint8Array>}
 */
export function retryingFetch({ fetch, events, retry }){
    const attempts = retry?.attempts ?? 6;
    const baseDelayMs = retry?.baseDelayMs ?? 250;
    const maxDelayMs = retry?.maxDelayMs ?? 10000;

    return async(offset, length, verify)=>{
        /** @type {any} */
        let failure = null;
        for (let attempt = 1; attempt <= attempts; attempt++)
        {
            try
            {
                const bytes = await fetch(offset, length);
                if (bytes.length !== length)
                {
                    throw new Error(
                        `short read: ${bytes.length} of ${length} bytes`);
                }
                // Checked here rather than by the caller so that bytes which
                // arrived damaged are asked for again, like any other failure.
                // Damage is what a retry is for; a caller outside this loop
                // could only turn it into an error.
                const wrong = verify?.(bytes);
                if (wrong)
                {
                    throw new Error(wrong);
                }
                return bytes;
            }
            catch (e){
                failure = e;
                if (attempt === attempts)
                {
                    break;
                }
                const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
                const delayMs = Math.round(ceiling * (0.5 + Math.random() * 0.5));
                events.emit('bundle-retry', {
                    offset, length, attempt, attempts, delayMs,
                    reason: failure?.message ?? String(failure),
                });
                await new Promise(resolve=>setTimeout(resolve, delayMs));
            }
        }

        const reason = failure?.message ?? String(failure);
        events.emit('bundle-unavailable', { offset, length, attempts, reason });
        throw new Error(
            `bundle: ${length} bytes at ${offset} did not arrive in ${attempts} `
            + `attempts: ${reason}`);
    };
}

/**
 * How much one range request may ask for.
 *
 * The bound is not bandwidth but what a failure costs: a request that dies at
 * 95% is refetched whole, and a thread waiting on it is parked for all of it.
 *
 * This is a separate knob from the block size, and deliberately so: the block
 * decides how long one thread is held, this decides how many times the network
 * is asked. It only has to stay above one block, or a block would be split
 * across two requests and neither half could be checked against its checksum.
 * At the default block size a full request carries sixty-four blocks.
 *
 * A demand fetch never reaches this: a group is built only from blocks the read
 * actually wants, so a small read is a small request and is not made to wait
 * behind bytes it did not ask for. The cap is for the background filler and for
 * reads that genuinely span that much.
 */
export const MAX_REQUEST_BYTES = 16 << 20;

/**
 * Blocks that are already here, between two that are not, are downloaded again
 * rather than split the request in two. A round trip costs more than this many
 * bytes on any connection worth having.
 */
export const MAX_BRIDGED_GAP = 128 << 10;

/**
 * Requests in flight at once. Six is what a browser will open to one host over
 * HTTP/1.1; over HTTP/2 it is one connection and the limit stops mattering, but
 * asking for more would only queue behind this on the worse of the two.
 */
export const MAX_CONCURRENT_REQUESTS = 6;

/**
 * How often the background filler looks up to see whether a read is parked.
 * Short enough that a demand fetch is never held up by much, long enough that
 * an idle session is not a timer running hot.
 */
export const IDLE_CHECK_MS = 50;

/**
 * Turns blocks into range requests.
 *
 * This is what decides how many times the network is asked, and it matters far
 * more than the block size does: blocks sit in the container back to back in
 * file order, so a read that spans a run of them is one request rather than one
 * per block. A game reading a hundred megabytes of an archive asks perhaps
 * thirteen times, not four hundred.
 *
 * @param {any[]} blocks  Absent, in ascending offset order.
 * @returns {{ start: number, end: number, blocks: any[] }[]}
 */
export function groupBlocks(blocks){
    /** @type {{ start: number, end: number, blocks: any[] }[]} */
    const groups = [];
    for (const block of blocks)
    {
        const open = groups.at(-1);
        const grown = block.offset + block.packed - (open?.start ?? 0);
        if (open
            && block.offset - open.end <= MAX_BRIDGED_GAP
            && grown <= MAX_REQUEST_BYTES)
        {
            open.end = block.offset + block.packed;
            open.blocks.push(block);
            continue;
        }
        groups.push({
            start: block.offset,
            end: block.offset + block.packed,
            blocks: [block],
        });
    }
    return groups;
}

/**
 * How much a miss brings in beyond what the read wanted: the aligned window of
 * the container it falls in, and past a forward reader's miss, this many more
 * packed bytes of what follows.
 *
 * A miss is one round trip whatever its size, and on a real title a start is
 * a hundred of them for a few megabytes: latency, not bandwidth. Two mebibytes
 * is small against a request's ceiling and large against a block, and a
 * program that touches one block of a region it never returns to pays for this
 * much extra at most.
 */
export const READ_AHEAD_BYTES = 2 << 20;

/**
 * The round trip below which a bundle is near: a disk, or a server on the
 * network beside the browser. A window is `READ_AHEAD_BYTES` there; each
 * multiple of this a request takes widens it by as much again, up to
 * `MAX_WINDOW_SCALE` of them.
 *
 * A miss costs one round trip whatever it brings, and a bucket a continent's
 * edge away answers in a third of a second: a game loading a level waited that
 * long for every two mebibytes, though the line carries twenty-five of them in
 * that time.
 */
export const NEAR_ROUND_TRIP_MS = 50;

export const MAX_WINDOW_SCALE = 8;

/**
 * How much a miss brings in, by how far away the bundle is.
 *
 * @param {number} roundTripMs  The shortest of the bundle's recent requests;
 *     0 before there is one.
 * @returns {number} bytes
 */
export function windowFor(roundTripMs){
    return READ_AHEAD_BYTES
        * Math.min(MAX_WINDOW_SCALE, Math.max(1, Math.floor(roundTripMs / NEAR_ROUND_TRIP_MS)));
}

/**
 * Widens every miss to the aligned window of the container that holds it.
 *
 * Whatever the read wanted, the request is the window: the blocks around a
 * miss are the rest of the file it is in, or the file beside it, and a start
 * that comes back for them one miss at a time pays a round trip for each.
 * Blocks already resident are stepped over, and a window is clipped at the
 * container's end. Two misses in one window are one request.
 *
 * @param {any[]} blocks  Wanted and not resident, ascending by offset.
 * @param {{ block: (index: number) => any, blockCount: number }} bundle
 * @param {(index: number) => boolean} resident
 * @param {number} [bytes]  The window, and its alignment.
 * @returns {any[]} the same blocks and the rest of their windows, ascending
 */
export function withWindow(blocks, bundle, resident, bytes = READ_AHEAD_BYTES){
    /** @type {Map<number, any>} */
    const chosen = new Map(blocks.map(block=>[block.index, block]));
    /** @param {number} index */
    const add = index=>{
        if (!chosen.has(index) && !resident(index))
        {
            const block = bundle.block(index);
            chosen.set(index, { index, offset: block.offset, packed: block.packed, ahead: true });
        }
    };
    // A neighbour by index is a neighbour in the container only while the
    // offsets keep going the same way: a bottle an installation wrote lays its
    // files where they arrived, and the block before a file's first can be
    // gigabytes away -- still "past the window's start" by offset, so a walk
    // that only checked the start took every block below it.
    for (const block of blocks)
    {
        const start = Math.floor(block.offset / bytes) * bytes;
        for (let index = block.index - 1, after = block.offset; index >= 0; index--)
        {
            const offset = bundle.block(index).offset;
            if (offset < start || offset >= after)
            {
                break;
            }
            add(index);
            after = offset;
        }
        for (let index = block.index + 1, before = block.offset; index < bundle.blockCount;
            index++)
        {
            const offset = bundle.block(index).offset;
            if (offset >= start + bytes || offset <= before)
            {
                break;
            }
            add(index);
            before = offset;
        }
    }
    return [...chosen.values()].sort((left, right)=>left.offset - right.offset);
}

/**
 * The blocks a request would bring in for the second time.
 *
 * A block downloaded once must not be downloaded again, and this is where
 * that is checked rather than assumed: everything inside a request's span
 * that is already resident, whether asked for by name or bridged over as a
 * gap, is a byte paid for twice. Counted before the request goes out, so the
 * number is about what was asked, not about what arrived.
 *
 * @param {{ blocks: any[] }} group
 * @param {{ block: (index: number) => any }} bundle
 * @param {(index: number) => boolean} resident
 * @returns {{ blocks: number, bytes: number }}
 */
export function refetchedIn(group, bundle, resident){
    let blocks = 0;
    let bytes = 0;
    const first = group.blocks[0]?.index ?? 0;
    const last = group.blocks[group.blocks.length - 1]?.index ?? -1;
    for (let index = first; index <= last; index++)
    {
        if (resident(index))
        {
            blocks++;
            bytes += bundle.block(index).packed;
        }
    }
    return { blocks, bytes };
}

/**
 * Extends a miss with the blocks that follow it in the container.
 *
 * Only when the miss continues where the last fetch stopped: that is a program
 * reading forward, and reaching past it turns the run into a few requests.
 * Measured on a real title's cinematic, one block a request for two hundred
 * and forty blocks. A miss anywhere else gets its window and no more. Blocks
 * already resident count against the reach but are not asked for again.
 *
 * @param {any[]} absent  Wanted and not resident, ascending by offset.
 * @param {{ block: (index: number) => any, blockCount: number }} bundle
 * @param {(index: number) => boolean} resident
 * @param {number[]} expected
 *        The blocks a forward reader would want next: one per recent fetch,
 *        because a program streams one file while it reads another, and the
 *        two runs take turns at missing.
 * @param {number} [bytes]
 * @returns {any[]} the same blocks, then the ones reached, ascending
 */
export function withReadAhead(absent, bundle, resident, expected, bytes = READ_AHEAD_BYTES){
    if (absent.length === 0 || !expected.includes(absent[0].index))
    {
        return absent;
    }
    const last = absent[absent.length - 1];
    /** @type {any[]} */
    const reached = [];
    let reach = 0;
    for (let index = last.index + 1; index < bundle.blockCount && reach < bytes; index++)
    {
        const block = bundle.block(index);
        reach += block.packed;
        if (!resident(index))
        {
            reached.push({ index, offset: block.offset, packed: block.packed, ahead: true });
        }
    }
    return reached.length === 0 ? absent : [...absent, ...reached];
}

/** The system directory, on the volume, without its drive or a trailing separator. */
export const SYSTEM_DIRECTORY = 'WINDOWS\\system32';

/**
 * Runs `work` over `items`, at most `limit` at a time.
 *
 * Bounded rather than all at once: the point of issuing requests together is to
 * overlap their latency, and past the connection limit they queue anyway, with
 * the ones that queue holding their errors until the end.
 *
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} work
 */
export async function inParallel(items, limit, work){
    let next = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async()=>{
        while (next < items.length)
        {
            await work(items[next++]);
        }
    });
    await Promise.all(runners);
}

/**
 * Where a mounted game appears inside the guest's volume: its files sit
 * directly in this directory, the way an installation's do.
 *
 * A directory of its own rather than the root, because a program of this era
 * finds its own data by asking where it is itself and looking beside that. At
 * the root those two places coincide, so a wrong answer to that question still
 * works and stays hidden until something depends on it being right.
 */
export const BUNDLE_DIRECTORY = 'App';

/**
 * Where in a bottle the registry its installation left is kept: beside the
 * files, as one of them, so an unpacked bottle describes itself. The installer
 * writes it there (`@bottlify/installer`'s `REGISTRY_PATH`).
 */
export const BOTTLE_REGISTRY_PATH = '.bottlify\\registry.json';

/**
 * Where in a bottle the files its installation added to `C:\WINDOWS\system32`
 * are kept -- the libraries its DirectX setup installed, say -- beside the
 * registry, and mounted back where Windows keeps them. The installer puts
 * them there (`@bottlify/installer`'s `SYSTEM_PATH`, the same path).
 */
export const BOTTLE_SYSTEM_PATH = '.bottlify\\system32';

/**
 * Where in a bottle what its installation wrote elsewhere on C: is kept, by its
 * path from the drive's root -- a shared runtime in Common Files, a settings
 * file beside Windows -- and mounted back there (`@bottlify/installer`'s
 * `DRIVE_PATH`, the same path).
 */
export const BOTTLE_DRIVE_PATH = '.bottlify\\drive_c';

/**
 * The check that makes every block's checksum worth something.
 *
 * The index carries them, so nothing inside the container can vouch for the
 * index itself: a bundle replaced wholesale would arrive with an index that
 * agrees with its own blocks perfectly. The digest that settles it has to come
 * from somewhere else, and the manifest -- fetched to decide whether to
 * download at all -- is that somewhere.
 *
 * The whole-bundle digest in the manifest answers the same question, but over
 * gigabytes. This one is over the index alone, which is already being fetched,
 * so it is affordable on every launch rather than on request.
 *
 * @param {string | undefined} expected
 * @returns {((stored: Uint8Array) => Promise<string | null>) | undefined}
 */
export function expectIndex(expected){
    if (!expected)
    {
        return undefined;
    }
    return async stored=>{
        const digest = await crypto.subtle.digest('SHA-256', stored.slice());
        const found = [...new Uint8Array(digest)]
            .map(byte=>byte.toString(16).padStart(2, '0')).join('');
        return found === expected.toLowerCase()
            ? null
            : `its digest is ${found}, not ${expected}`;
    };
}

/**
 * Mounts the run's bundle and the layers it stands on (`bundle.layers`) as the
 * read-only half of the volume: one source, the bundle's file over a layer's
 * of the same path (`union-source.js`), each bundle with a block cache of its
 * own, named by its own id - a layer shared by bottles is cached once.
 *
 * A miss names the blocks of one bundle, a layer's tagged with its number
 * (`layer`, from 1), and the run's `fetch` hands each to its bundle.
 *
 * @param {any} deps
 * @returns {Promise<MountedBundle | null>}
 */
export async function mountBundle({ options, events, translationStore }){
    // A run with no bundle of its own - an installer writing its whole
    // volume - may still stand on layers (`layers`): a setup whose wizard is
    // a managed program needs the Framework while it installs.
    const hasOwn = typeof options.bundle?.fetch === 'function';
    /** @type {any[]} */
    const layers = (hasOwn ? options.bundle?.layers : options.layers) ?? [];
    if (!hasOwn && layers.length === 0)
    {
        return null;
    }
    const id = options.bundle?.id ?? options.id ?? 'bundle';
    for (const layer of layers)
    {
        if (typeof layer?.id !== 'string' || typeof layer.fetch !== 'function')
        {
            throw new TypeError('bundle.layers: each layer needs an id and a fetch');
        }
    }
    const specs = [...hasOwn ? [{ spec: options.bundle, id, layer: false }] : [],
        ...layers.map(layer=>({ spec: layer, id: layer.id, layer: true }))];

    // Every cache of the run named before any opens: the origin is kept under
    // its budget with all of them kept, and a full store lets none of them go.
    /** @type {string[]} */
    const held = [];
    /** @type {() => void} */
    let allNamed = ()=>{};
    /** @type {(reason: any) => void} */
    let noneNamed = ()=>{};
    const named = new Promise((resolve, reject)=>{
        allNamed = ()=>resolve(undefined);
        noneNamed = reject;
    });
    // Nobody may be waiting on it when one bundle fails.
    named.catch(()=>{});
    /** @param {string} name */
    const opened = name=>{
        held.push(name);
        if (held.length === specs.length)
        {
            // Absent means local; `store: null` is no cache, so not `??`.
            if ([undefined, 'local'].includes(options.bundle?.store)
                && options.bundle?.evictOthers !== false)
            {
                // The origin's caches kept under its budget, the oldest let
                // go: in the background, as nothing of this run's own is touched.
                keepOriginStorageWithin({ blocks: [...held], translations: id })
                    .then(result=>events.emit('storage-budget', result), ()=>{});
            }
            allNamed();
        }
        return named;
    };
    // One bundle that fails fails the run: the others stop waiting for its
    // cache's name, and those already mounted stop fetching and close theirs.
    const outcomes = await Promise.allSettled(specs.map(one=>mountOneBundle({ ...one, held,
        opened,
        // A layer's events say whose they are.
        events: one.layer ? { emit: (/** @type {string} */ name, /** @type {any} */ payload)=>
            events.emit(name, { ...payload, layer: one.id }) } : events,
        translationStore: one.layer ? undefined : translationStore })
        .catch(e=>{
            noneNamed(e);
            throw e;
        })));
    const failed = outcomes.find(one=>one.status === 'rejected');
    if (failed)
    {
        for (const one of outcomes)
        {
            if (one.status === 'fulfilled')
            {
                one.value.stop();
            }
        }
        throw failed.reason;
    }
    const layered = outcomes.map(one=>/** @type {PromiseFulfilledResult<MountedBundle>} */ (one).value);
    if (hasOwn && layered.length === 1)
    {
        return layered[0];
    }
    // With no bundle of its own, the bottle's place over the layers is empty.
    const mounted = hasOwn ? layered : [NO_BOTTLE, ...layered];

    /** @param {(one: MountedBundle) => Record<string, number | string>} get */
    const added = get=>{
        /** @type {Record<string, number | string>} */
        const out = {};
        for (const one of mounted)
        {
            for (const [key, value] of Object.entries(get(one)))
            {
                const before = out[key] ?? 0;
                out[key] = typeof value === 'number' && typeof before === 'number'
                    ? before + value : NOT_MEASURED;
            }
        }
        return out;
    };
    const [bottle, ...under] = mounted;
    return {
        source: createUnionSource([bottle.source,
            ...under.map((one, at)=>missesNamed(one.source, at + 1))]),
        fetch: needed=>Promise.all(mounted.map((one, at)=>{
            const own = needed.filter(block=>(block.layer ?? 0) === at);
            return own.length === 0 ? null : one.fetch(own);
        })).then(()=>{}),
        registry: bottle.registry,
        layerRegistries: Promise.all(under.map(one=>one.registry)),
        ahead: ()=>mounted.reduce((sum, one)=>sum + one.ahead(), 0),
        refetched: ()=>/** @type {any} */ (added(one=>one.refetched())),
        decoded: ()=>/** @type {any} */ (added(one=>one.decoded())),
        ranges: ()=>/** @type {any} */ (added(one=>one.ranges())),
        held: ()=>added(one=>one.held()),
        stop(){
            for (const one of mounted)
            {
                one.stop();
            }
        },
    };
}

/**
 * The bottle's place over its layers in a run that has no bundle: nothing
 * there, nothing to fetch, no hive.
 *
 * @type {MountedBundle}
 */
export const NO_BOTTLE = Object.freeze({
    source: Object.freeze({
        list: ()=>[],
        stat: ()=>null,
        read: ()=>{
            throw new Error('the run has no bundle of its own to read from');
        },
    }),
    fetch: ()=>Promise.resolve(),
    stop: ()=>{},
    ahead: ()=>0,
    refetched: ()=>({ blocks: 0, bytes: 0 }),
    ranges: ()=>({ requests: 0, bytes: 0 }),
    decoded: ()=>({ blocks: 0, bytes: 0, ms: 0 }),
    held: ()=>({}),
    registry: Promise.resolve(null),
});

/**
 * A layer's source whose misses say whose blocks they want: each block tagged
 * with the layer's number, which crosses a link to another thread with it.
 *
 * @param {any} source @param {number} layer
 */
export function missesNamed(source, layer){
    return {
        list: ()=>source.list(),
        /** @param {string} path */
        stat: path=>source.stat(path),
        /** @param {string} path @param {number} offset @param {number} length */
        read(path, offset, length){
            try
            {
                return source.read(path, offset, length);
            }
            catch (e){
                const miss = /** @type {any} */ (e);
                if (miss?.code === BLOCK_MISS)
                {
                    for (const block of miss.blocks)
                    {
                        block.layer = layer;
                    }
                }
                throw miss;
            }
        },
    };
}

/**
 * Mounts one bundle as (part of) the read-only half of the volume.
 *
 * The blocks that have been brought in are held here rather than inside the
 * source, because what fetches them is the caller's business -- a file, a range
 * request, a cache -- and the source only has to know whether a block is
 * resident. A read of an absent block reports which ones it needs; this is what
 * goes and gets them.
 *
 * They are held in storage rather than in the heap. A bundle can be larger than
 * any single buffer a browser will hand out, and a program that plays a lot of
 * a large game eventually touches nearly all of it, so blocks accumulating in
 * memory is not a cost that levels off -- it is the run failing later instead
 * of sooner. The source keeps its own bounded cache of decoded blocks in front
 * of this, which is what a repeated read actually hits.
 *
 * A layer (`bundle.layers`) is mounted the same way, and only its system files
 * are: `prefix` is null for it, and nothing seeds the translator from it.
 *
 * @param {{ spec: any, id: string, layer: boolean, events: any, translationStore?: any,
 *     held: string[], opened: (name: string) => Promise<void> }} deps
 *     `spec`: the bundle's options. `held`: the names of every block cache the
 *     run reads, this one's among them. `opened`: told this bundle's cache's
 *     name once its index is read, and waited on before the cache is opened.
 * @returns {Promise<MountedBundle>}
 */
export async function mountOneBundle({ spec, id, layer, events, translationStore, held, opened }){
    // Everything below fetches through this, the index included: the first
    // range of the run is as exposed to a dropped connection as the last.
    const retrying = retryingFetch({
        fetch: spec.fetch,
        events,
        retry: spec.retry,
    });
    /**
     * How long the bundle's last requests took. The shortest of them is the
     * round trip with the least transfer in it: what a miss costs whatever it
     * brings (`windowFor`).
     *
     * @type {number[]}
     */
    const recentMs = [];
    const ROUND_TRIPS_KEPT = 8;
    /** @type {typeof retrying} */
    const fetchRange = async(offset, length, verify)=>{
        const began = performance.now();
        const bytes = await retrying(offset, length, verify);
        recentMs.push(performance.now() - began);
        if (recentMs.length > ROUND_TRIPS_KEPT)
        {
            recentMs.shift();
        }
        return bytes;
    };
    const roundTrip = ()=>(recentMs.length === 0 ? 0 : Math.min(...recentMs));

    /**
     * A block, turned back into bytes, without awaiting anything.
     *
     * zstd is decoded by this project's own decoder (`zstd.js`), which
     * answers synchronously. Deflate has
     * no synchronous decoder in a browser at all, so a deflate block is
     * inflated when it is *fetched* -- which is already an asynchronous step --
     * and by the time a read reaches it, it is plain. That is why codec 1 is
     * passed through rather than refused.
     *
     * @param {number} codec
     * @param {Uint8Array} bytes
     * @param {number | null} expectedLength
     */
    const decode = (codec, bytes, expectedLength)=>{
        if (codec === 2)
        {
            // Counted: the decoding a guest read waits for is what a pool
            // worker would take off this thread.
            const startedAt = performance.now();
            const plain = decompressZstd(bytes, expectedLength ?? 0);
            decoded.blocks++;
            decoded.bytes += plain.length;
            decoded.ms += performance.now() - startedAt;
            return plain;
        }
        return bytes;
    };
    const decoded = { blocks: 0, bytes: 0, ms: 0 };

    // The index is deflated, and opening is asynchronous anyway, so it may use
    // the decoder a guest read cannot.
    const bundle = await openBundle(
        fetchRange,
        (codec, bytes)=>codec === 1 ? inflateRaw(bytes) : decode(codec, bytes, null),
        { verifyIndex: expectIndex(spec.indexSha256) });

    const blockStore = spec.store === undefined ? 'local' : spec.store;
    const evictOthers = spec.evictOthers !== false;
    await opened(blockCacheName(id, bundle.fingerprint));
    const cache = await createBlockCache({
        // Absent means local, and only an explicit falsy value turns it off --
        // so `??` will not do here: `store: null` has to mean no cache.
        store: await resolveBlockStore(blockStore),
        // A cache of this bundle as it was packed before stays on the store
        // until the origin's budget lets it go (`storage-budget.js`).
        name: blockCacheName(id, bundle.fingerprint),
        blockSize: bundle.blockSize,
        blockCount: bundle.blockCount,
        // Where the blocks have no store but the heap, the heaps' pool for them:
        // a read in flight keeps its blocks past it, and nothing else does.
        maxHeapBytes: HEAP_POOLS.blockCache,
        evictOthers,
        held,
        // Nothing left to let go: the run goes on with what it fetches in the
        // heap, and the person is told there is no room, once.
        onFull: reason=>events.emit('storage-full', { bundle: id, reason }),
    });

    const source = createBundleSource({
        bundle,
        /** @param {number} index */
        readBlock: index=>cache.read(index, storedLength(bundle.block(index))),
        decode,
        maxDecodedBytes: HEAP_POOLS.decodedBlocks,
        // A game lives in a directory of its own, the way an installation does.
        // At the root of the volume a program's own directory and the system
        // root are the same place, so every answer to "where do I live" happens
        // to work and a wrong one is invisible until it is not.
        // A layer has no program directory: its system files are all of it.
        prefix: layer ? null : spec.prefix ?? BUNDLE_DIRECTORY,
        // What the installation left in system32 is found there again, read
        // from the bundle a block at a time like any of its files.
        // So is what it wrote anywhere else on C:, at the drive's root.
        relocate: { [BOTTLE_SYSTEM_PATH]: SYSTEM_DIRECTORY, [BOTTLE_DRIVE_PATH]: '' },
    });

    /**
     * A member's bytes, read before the program runs: one request for its run
     * of blocks, each checked against the index and decoded as a guest read's
     * block is. Not kept in the block cache, where nothing would read it
     * again: whoever asked keeps what it takes.
     *
     * @param {import('../layers/filesystem/internal/bundle/format.js').BundleMember} of
     * @param {string} what  named in a damaged block's report
     */
    const readMember = async(of, what)=>{
        const first = bundle.block(of.firstBlock);
        const last = bundle.block(of.firstBlock + of.blocks - 1);
        const whole = await fetchRange(first.offset, last.offset + last.packed - first.offset,
            bytes=>{
                for (let at = of.firstBlock; at < of.firstBlock + of.blocks; at++)
                {
                    const block = bundle.block(at);
                    const from = block.offset - first.offset;
                    if (block.crc !== null
                        && crc32(bytes.subarray(from, from + block.packed)) !== block.crc)
                    {
                        return `block ${at} of ${what} arrived damaged`;
                    }
                }
                return null;
            });
        const out = new Uint8Array(of.size);
        let written = 0;
        for (let at = of.firstBlock; at < of.firstBlock + of.blocks; at++)
        {
            const block = bundle.block(at);
            const from = block.offset - first.offset;
            const raw = whole.subarray(from, from + block.packed);
            const bytes = block.codec === 1 ? await inflateRaw(raw) : decode(block.codec, raw,
                block.length);
            out.set(bytes, written);
            written += bytes.length;
        }
        return written === of.size ? out : null;
    };

    // The bundle's translation seed goes into the translator's store before
    // the program's first instruction, and every lookup waits for it, so the
    // first run of the bundle on this machine starts from the regions a run
    // elsewhere made instead of from none. Once a store has taken this seed
    // it is not fetched again. Only an engine with the translator has a use
    // for it, the default among them.
    const member = bundle.translations;
    if (member !== null && typeof translationStore?.seed === 'function')
    {
        const seeding = (async()=>(await translationStore.seededWith() === member.sha256
            ? null : readMember(member, 'the translations'))
        )();
        translationStore.seed(seeding, member.sha256).then((/** @type {any} */ result)=>{
            events.emit('bundle-translations', { size: member.size, ...result });
        });
    }

    // The registry the installation left, which travels in the bottle beside
    // its files: read now, while nothing else is, and parsed once.
    const registryFile = bundle.find(BOTTLE_REGISTRY_PATH);
    const registry = registryFile === null ? Promise.resolve(null)
        : readMember(registryFile, 'the registry').then(bytes=>(bytes === null ? null
            : JSON.parse(new TextDecoder().decode(bytes)))).catch((/** @type {any} */ e)=>{
            events.emit('bundle-registry-unreadable', { reason: e?.message ?? String(e) });
            return null;
        });

    // What a layer holds outside its system files is not on the volume.
    const stray = layer ? source.unplaced - (registryFile === null ? 0 : 1) : 0;
    if (stray > 0)
    {
        events.emit('layer-files-unmounted', { files: stray });
    }

    events.emit('bundle', {
        files: bundle.files.length,
        blockSize: bundle.blockSize,
        blocks: bundle.blockCount,
        cached: cache.diagnostics().resident,
        backed: cache.backed,
        remembered: cache.order().length,
    });
    if (!cache.backed)
    {
        // Said out loud, in the words of the setting it defeats: a store that
        // quietly failed to open reads from outside as a cache that never
        // worked, and every block of this run will be fetched again next time.
        events.emit('bundle-unbacked', {
            reason: cache.reason,
            effect: 'fetched blocks are not kept on this machine',
        });
    }

    /**
     * Brings in one run of blocks: one request, then split and checked.
     *
     * The checksums are per block, so a group is verified block by block and a
     * group with one bad block is asked for again whole. Damage is rare enough
     * that paying for the neighbours beats tracking which part to re-ask for.
     *
     * Each block is copied out with `slice`, not viewed with `subarray`: a view
     * would keep the entire request's buffer alive for as long as any one block
     * of it is held, which for a 8 MiB request holding one 256 KiB block is
     * thirty-one blocks of the group nobody wanted.
     *
     * @param {{ start: number, end: number, blocks: any[] }} group
     */
    const fetchGroup = async group=>{
        const twice = refetchedIn(group, bundle, has);
        refetched.blocks += twice.blocks;
        refetched.bytes += twice.bytes;
        const span = group.end - group.start;
        ranges.requests++;
        ranges.bytes += span;
        const whole = await fetchRange(group.start, span, bytes=>{
            for (const block of group.blocks)
            {
                const expected = bundle.block(block.index).crc;
                if (expected === null)
                {
                    continue;
                }
                const at = block.offset - group.start;
                const found = crc32(bytes.subarray(at, at + block.packed));
                if (found !== expected)
                {
                    return `block ${block.index} arrived damaged `
                        + `(checksum ${found}, expected ${expected})`;
                }
            }
            return null;
        });

        for (const block of group.blocks)
        {
            const at = block.offset - group.start;
            const raw = whole.slice(at, at + block.packed);
            // Inflated here, once, rather than on every read: this is the only
            // place a deflate block can be decoded at all, since the read side
            // is synchronous and the browser's inflate is not.
            await cache.put(block.index,
                bundle.block(block.index).codec === 1 ? await inflateRaw(raw) : raw);
        }
    };

    /** @param {number} index */
    const has = index=>cache.has(index);
    /** Blocks a request went out for that were already here. */
    const refetched = { blocks: 0, bytes: 0 };
    /**
     * What went over the wire: range requests and the bytes they spanned. The
     * count of reads that waited is a different number -- one read may be
     * several requests, and a request may serve a read that never waited.
     */
    const ranges = { requests: 0, bytes: 0 };
    /**
     * Blocks a request is out for right now, each with the promise of it. A
     * second read that wants one of them waits for that request rather than
     * sending its own: two threads reading neighbouring files would otherwise
     * fetch the same window twice, once each.
     *
     * @type {Map<number, Promise<void>>}
     */
    const inFlight = new Map();

    // What a read is waiting on right now. The background filler stands aside
    // whenever this is above zero: a block a parked thread wants is worth more
    // than any block nobody has asked for.
    let waiting = 0;
    let stopped = false;
    /** Blocks brought in ahead of a read, ever. */
    let ahead = 0;
    /**
     * The block after each of the last few fetches: where a forward reader's
     * next miss lands. A few rather than one, because two files streamed at
     * once take turns at missing and each turn would otherwise start over.
     */
    /** @type {number[]} */
    const expected = [];
    const EXPECTED_KEPT = 4;

    /** @param {any[]} needed */
    const demand = async needed=>{
        for (const block of needed)
        {
            cache.demanded(block.index);
        }
        const absent = [...new Map(needed
            .filter(block=>!cache.has(block.index))
            .map(block=>[block.index, block])).values()]
            .sort((left, right)=>left.offset - right.offset);

        // Wide only where the blocks are kept: a cache in the heap is a few
        // windows, and windows of 16 MiB evicted each other's blocks before
        // the read that wanted them came back for them -- a start fetched
        // four times its bundle and never got going.
        const window = cache.backed ? windowFor(roundTrip()) : READ_AHEAD_BYTES;
        const reaching = withWindow(withReadAhead(absent, bundle, has, expected, window),
            bundle, has, window);
        ahead += reaching.length - absent.length;
        if (reaching.length > 0)
        {
            expected.push(reaching[reaching.length - 1].index + 1);
            if (expected.length > EXPECTED_KEPT)
            {
                expected.shift();
            }
        }
        const borrowed = [...new Set(reaching.map(block=>inFlight.get(block.index)))]
            .filter(promise=>promise !== undefined);
        const own = reaching.filter(block=>!inFlight.has(block.index));
        waiting++;
        const request = inParallel(groupBlocks(own), MAX_CONCURRENT_REQUESTS, fetchGroup);
        for (const block of own)
        {
            inFlight.set(block.index, request);
        }
        try
        {
            // A borrowed request that fails is the other read's failure to
            // report; this one comes back for the block if it is still absent.
            await Promise.all([request, ...borrowed.map(promise=>promise.catch(()=>{}))]);
        }
        finally
        {
            waiting--;
            for (const block of own)
            {
                inFlight.delete(block.index);
            }
        }

        // Once per batch, not once per block: losing the record of a block that
        // is already on disk costs one refetch, and writing it every time would
        // cost far more than that.
        await cache.persist();
    };

    /**
     * Brings groups in one at a time, and only while no read is parked. Both
     * follow from what the filler is for: it exists to use idle time, so the
     * moment the time stops being idle it has to give the connections back to
     * the read that a player is actually waiting on.
     *
     * Except where the bundle is far (`NEAR_ROUND_TRIP_MS`): there a parked
     * read is a round trip's wait however wide the line, and a level loading is
     * a read parked nearly all the time, so a filler that stood aside never ran
     * while it mattered. It goes on beside the read, one request against the
     * read's six, and a read that wants a block of its request waits for it
     * rather than asking again.
     *
     * @param {{ start: number, end: number, blocks: any[] }[]} groups
     * @returns {Promise<boolean>} whether to go on
     */
    const fillGroups = async groups=>{
        for (const group of groups)
        {
            while (true)
            {
                // A store that is full keeps no more: filling it would fetch
                // the rest of the bundle into the heap and let it go again.
                if (stopped || cache.diagnostics().full)
                {
                    return false;
                }
                if (waiting === 0 || roundTrip() >= NEAR_ROUND_TRIP_MS)
                {
                    break;
                }
                await new Promise(resolve=>setTimeout(resolve, IDLE_CHECK_MS));
            }
            // Only what is still missing, regrouped: a read may have brought
            // part of this group in while the filler stood aside.
            const missing = group.blocks
                .filter(block=>!has(block.index) && !inFlight.has(block.index));
            if (missing.length === 0)
            {
                continue;
            }

            try
            {
                for (const part of groupBlocks(missing))
                {
                    const request = fetchGroup(part);
                    for (const block of part.blocks)
                    {
                        inFlight.set(block.index, request);
                    }
                    try
                    {
                        await request;
                    }
                    finally
                    {
                        for (const block of part.blocks)
                        {
                            if (inFlight.get(block.index) === request)
                            {
                                inFlight.delete(block.index);
                            }
                        }
                    }
                }
                await cache.persist();
            }
            catch (e){
                // A run that cannot be filled in the background is still a run.
                // The blocks it failed on will be asked for again, in front of a
                // parked thread, where the failure belongs.
                events.emit('bundle-prefetch-failed',
                    { start: group.start, reason: /** @type {any} */ (e).message });
                return false;
            }
            events.emit('bundle-prefetch', {
                resident: cache.diagnostics().resident,
                blocks: bundle.blockCount,
            });
        }
        return true;
    };

    /**
     * Fills the rest of the cache while the game is not asking for anything.
     *
     * First what the last run asked for, in the order it asked: a start reads
     * the same things in the same order every time, so that is the one thing
     * known about what will be read next, and each of those blocks comes in
     * with its window the way a miss would. Then the whole bundle, in container
     * order, taken one request at a time out of the gaps -- not a guess about
     * what will be read next, so nothing about it can be wrong about the game's
     * access pattern, it can only be early or late.
     *
     * Off when the blocks have nowhere to go. Filling a bounded heap cache with
     * a whole bundle would evict as fast as it fills, and pay for every byte of
     * it twice.
     */
    const fill = async()=>{
        if (!cache.backed || spec.prefetch === false)
        {
            return;
        }

        for (const index of cache.order())
        {
            if (!has(index)
                && !await fillGroups(groupBlocks(withWindow([bundle.block(index)], bundle, has))))
            {
                return;
            }
        }

        // The translation seed's blocks are the store's business, read once.
        const all = Array.from({ length: bundle.blockCount },
            (unused, index)=>bundle.block(index))
            .filter(block=>member === null || block.index < member.firstBlock
                || block.index >= member.firstBlock + member.blocks);
        await fillGroups(groupBlocks(all));
    };

    /**
     * The whole bundle before the program starts (`bundle.preload`): every
     * block not kept yet, as many requests at once as a read may have, each
     * kept and recorded as it lands, so a preload cut short is resumed where it
     * stopped. Not the translation seed, which the translator's store reads.
     */
    const preload = async()=>{
        const progress = spec.progress ?? (()=>{});
        if (!cache.backed)
        {
            progress({ unbacked: cache.reason ?? 'nowhere to keep the blocks' });
            return;
        }
        const all = Array.from({ length: bundle.blockCount }, (unused, index)=>bundle.block(index))
            .filter(block=>member === null || block.index < member.firstBlock
                || block.index >= member.firstBlock + member.blocks);
        const total = all.reduce((sum, block)=>sum + block.packed, 0);
        const missing = all.filter(block=>!has(block.index));
        let bytes = total - missing.reduce((sum, block)=>sum + block.packed, 0);
        progress({ bytes, total });
        await inParallel(groupBlocks(missing), MAX_CONCURRENT_REQUESTS, async group=>{
            if (cache.diagnostics().full)
            {
                return;
            }
            await fetchGroup(group);
            await cache.persist();
            bytes += group.blocks.reduce((sum, block)=>sum + block.packed, 0);
            progress({ bytes, total });
        });
        // Past the origin's quota the rest is not kept: the game loads as it
        // plays, which the page says in the words it has for that.
        const full = cache.diagnostics().full;
        if (full)
        {
            progress({ unbacked: full });
        }
    };
    if (spec.preload === true)
    {
        await preload();
    }
    else
    {
        // Deliberately not awaited: it runs for as long as the bundle has
        // blocks left, which is the whole session.
        fill();
    }
    return {
        /** The bundle's files as a drive's read-only layer, for each machine to mount. */
        source,
        fetch: demand,
        registry,
        /** How many blocks were brought in ahead of a read, ever. */
        ahead: ()=>ahead,
        /** Blocks a request went out for that were already here: the number
         *  that has to stay at zero. */
        refetched: ()=>({ ...refetched }),
        decoded: ()=>({ ...decoded }),
        /** What the bundle's pools hold of the tab's heaps (`memory-zones.js`). */
        held: ()=>({
            blockCache: cache.diagnostics().heapBytes ?? NOT_MEASURED,
            decodedBlocks: source.heldBytes(),
        }),
        /** Range requests made and bytes asked for, ever. */
        ranges: ()=>({ ...ranges }),
        stop(){
            stopped = true;
            cache.close();
        },
    };
}
