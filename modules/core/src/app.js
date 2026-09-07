/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { assembleModules } from './core.js';
import { createEvents } from './events.js';
import { captureTrace, formatTrace } from './trace.js';
import { inflateRaw, resolveStorage } from './storage.js';
import { openBundle } from './layers/filesystem/internal/bundle/format.js';
import { parsePe, readExports, readImports } from './layers/loader/internal/pe.js';
import { planDependencies } from './layers/loader/internal/dependencies.js';
import { loadString } from './layers/loader/internal/resources.js';
import { readTls } from './layers/loader/internal/tls.js';
import { createProcessBlocks } from './layers/win32/kernel32/teb.js';
import { synthesiseProcessInit, DLL_PROCESS_ATTACH }
    from './layers/loader/internal/init.js';
import { createBundleSource } from './layers/filesystem/internal/bundle/source.js';
import { crc32 } from './layers/filesystem/internal/bundle/crc32.js';
import { createBlockCache, resolveBlockStore }
    from './layers/filesystem/internal/bundle/cache.js';

/**
 * createApp — the consumer-facing entry point: run a Win32 application.
 *
 * Everything below it is the module graph; this is the one place that wires the
 * cross-cutting step the graph deliberately does not express. An executable's
 * imports have to become guest addresses that call into win32, but win32 does
 * not know what a guest call looks like and the bridge does not know what win32
 * implements. Neither should. Assembling a process is what knows both.
 */

/**
 * @typedef {Object} AppOptions
 * @property {Uint8Array} executable      The program to run.
 * @property {Object} v86                 Emulator artifacts.
 * @property {string} v86.moduleUrl
 * @property {ArrayBuffer} v86.wasmBytes
 * @property {number} [stackSize]
 * @property {number} [heapSize]     Bytes the guest's heap may allocate out of.
 * @property {string} [imagePath]    What the program believes it was loaded from.
 * @property {any} [device]          The GPU to draw on, when there is one.
 * @property {{ width: number, height: number, bitsPerPixel: number }} [screen]
 *           What the program is told its display is.
 * @property {any} [storage]
 *           Where the session comes from and goes: a provider with `load` and
 *           `save`, a function that only loads, or the string `local`.
 * @property {string} [id]           Names the session when storage does not.
 * @property {Object} [bundle]       A .btl mounted as the volume's read-only source.
 * @property {(offset: number, length: number) => Promise<Uint8Array>} bundle.fetch
 *           Brings a byte range of the bundle in, from wherever it is kept.
 * @property {any} [bundle.store]  Where fetched blocks are kept. `'local'` is
 *           the default and means this machine; a synchronous store of your own
 *           is used as given; anything falsy keeps nothing, and a block the
 *           reader has let go is then fetched again.
 * @property {string} [bundle.id]  Names this bundle's cache. Two bundles sharing
 *           a name would read each other's blocks, so it has to be the bundle's.
 * @property {boolean} [bundle.prefetch]  Whether to fill the cache in the gaps
 *           when nothing is being read. On by default, and inert when there is
 *           nowhere durable to keep the blocks.
 * @property {string} [bundle.indexSha256]  From the manifest. Checked against
 *           the index this bundle actually carries, which is what makes the
 *           per-block checksums inside it worth trusting.
 * @property {Object} [bundle.retry] How hard to try when that fetch fails.
 * @property {number} [bundle.retry.attempts]     Including the first. Default 6.
 * @property {number} [bundle.retry.baseDelayMs]  Doubled each attempt. Default 250.
 * @property {number} [bundle.retry.maxDelayMs]   Ceiling for that. Default 10000.
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
const MAX_REQUEST_BYTES = 16 << 20;

/**
 * Blocks that are already here, between two that are not, are downloaded again
 * rather than split the request in two. A round trip costs more than this many
 * bytes on any connection worth having.
 */
const MAX_BRIDGED_GAP = 128 << 10;

/**
 * Requests in flight at once. Six is what a browser will open to one host over
 * HTTP/1.1; over HTTP/2 it is one connection and the limit stops mattering, but
 * asking for more would only queue behind this on the worse of the two.
 */
const MAX_CONCURRENT_REQUESTS = 6;

/**
 * How often the background filler looks up to see whether a read is parked.
 * Short enough that a demand fetch is never held up by much, long enough that
 * an idle session is not a timer running hot.
 */
const IDLE_CHECK_MS = 50;

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
 * What a mapped library's base is rounded up to.
 *
 * Where they start is not a constant: it is wherever the system modules end,
 * because a fixed address chosen in advance is a guess about how much memory
 * the emulator was given, and a wrong guess maps a library outside guest RAM.
 */
const LIBRARY_ALIGN = 0x10000;

/**
 * Reads a whole file off the volume, waiting for whatever is not here yet.
 *
 * A read of a block that has not been fetched reports which blocks it needs
 * rather than waiting -- that is what lets a guest read look synchronous -- so
 * a host-side reader has to do what the guest's would: fetch, and look again.
 * This runs before the first guest instruction, so it may simply wait.
 *
 * @param {any} filesystem
 * @param {any} blocks
 * @param {string} path
 * @returns {Promise<Uint8Array | null>}
 */
async function readWholeFile(filesystem, blocks, path){
    let handle;
    try
    {
        handle = filesystem.open(path, { create: false });
    }
    catch {
        return null;
    }

    try
    {
        const size = filesystem.size(handle);
        const bytes = new Uint8Array(size);
        let at = 0;
        while (at < size)
        {
            let chunk;
            try
            {
                chunk = filesystem.read(handle, size - at);
            }
            catch (e){
                const miss = /** @type {any} */ (e);
                if (miss?.code !== 'BLOCK_MISS' || !blocks)
                {
                    throw miss;
                }
                await blocks.fetch(miss.blocks);
                continue;
            }
            if (chunk.length === 0)
            {
                break;
            }
            bytes.set(chunk, at);
            at += chunk.length;
        }
        return bytes.subarray(0, at);
    }
    finally
    {
        filesystem.close(handle);
    }
}

/**
 * Maps every library the program brought with it, in dependency order.
 *
 * Nothing is bound here. A set of libraries that import each other has to be
 * mapped first -- every base settled, every export directory readable -- and
 * bound afterwards, or the first one binds against a library that has no
 * address yet.
 *
 * A library is looked for beside the executable, which is where a program's own
 * libraries live and where its loader would look.
 *
 * @param {any} options
 * @returns {Promise<any[]>}
 */
async function mapShippedLibraries(options){
    const { executable, imagePath, filesystem, loader, blocks, events, isSystem,
        byName, byBase } = options;
    const directory = imagePath.slice(0, imagePath.lastIndexOf('\\') + 1);

    const { order, missing } = await planDependencies({
        entry: executable,
        isSystem,
        readLibrary: name=>readWholeFile(filesystem, blocks, `${directory}${name}`),
    });

    if (missing.length > 0)
    {
        // Not fatal: a program that never calls into one of these runs, and one
        // that does fails where it called, which says far more than a refusal
        // here would.
        events.emit('libraries-missing', { names: missing });
    }

    let base = options.base;
    /** @type {any[]} */
    const mapped = [];
    for (const { name, file } of order)
    {
        const image = parsePe(file);
        if (base + image.sizeOfImage > options.memoryBytes)
        {
            // Refused here rather than as a RangeError from a write past the
            // end of RAM, which says nothing about which library or why.
            events.emit('libraries-missing', { names: [name], reason: 'no room' });
            continue;
        }
        const record = loader.map(file, { base, name });
        const { exports } = readExports(file, image);

        const addresses = new Map(exports
            .filter(entry=>entry.name !== null && entry.forwards === null)
            .map(entry=>[String(entry.name), base + entry.rva]));
        const ordinals = new Map(exports
            .filter(entry=>entry.forwards === null)
            .map(entry=>[entry.ordinal, base + entry.rva]));

        const held = {
            name,
            base,
            size: image.sizeOfImage,
            /** @param {string} exported */
            addressOf: exported=>addresses.get(exported) ?? null,
            /** @param {number} ordinal */
            addressOfOrdinal: ordinal=>ordinals.get(ordinal) ?? null,
            entryPoint: record.record.entryPoint,
            mapped: record,
        };
        byName.set(name.toLowerCase().replace(/\.dll$/, ''), held);
        byBase.set(base, held);
        mapped.push(held);

        base += Math.ceil(image.sizeOfImage / LIBRARY_ALIGN) * LIBRARY_ALIGN;
    }

    events.emit('libraries', { loaded: mapped.map(entry=>entry.name), missing });
    return mapped;
}

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
function expectIndex(expected){
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
 * Mounts a bundle as the read-only half of the volume.
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
 * @param {any} deps
 * @returns {Promise<{ fetch: (needed: any[]) => Promise<void>,
 *                     stop: () => void } | null>}
 */
async function mountBundle({ options, cpu, filesystem, events }){
    if (!options.bundle?.fetch)
    {
        return null;
    }
    // Everything below fetches through this, the index included: the first
    // range of the run is as exposed to a dropped connection as the last.
    const fetchRange = retryingFetch({
        fetch: options.bundle.fetch,
        events,
        retry: options.bundle.retry,
    });

    /**
     * A block, turned back into bytes, without awaiting anything.
     *
     * zstd is decoded here because the emulator carries a decoder that answers
     * synchronously. Deflate has no synchronous decoder in a browser at all, so
     * a deflate block is inflated when it is *fetched* -- which is already an
     * asynchronous step -- and by the time a read reaches it, it is plain. That
     * is why codec 1 is passed through rather than refused.
     *
     * @param {number} codec
     * @param {Uint8Array} bytes
     * @param {number | null} expectedLength
     */
    const decode = (codec, bytes, expectedLength)=>{
        if (codec === 2)
        {
            return cpu.decompressZstd(bytes, expectedLength ?? 0);
        }
        return bytes;
    };

    // The index is deflated, and opening is asynchronous anyway, so it may use
    // the decoder a guest read cannot.
    const bundle = await openBundle(
        fetchRange,
        (codec, bytes)=>codec === 1 ? inflateRaw(bytes) : decode(codec, bytes, null),
        { verifyIndex: expectIndex(options.bundle.indexSha256) });

    // How much of a block its slot holds: a zstd block is kept packed, because
    // the decoder that answers a guest read runs synchronously, and everything
    // else is kept in the form a read can use as it stands.
    /** @param {any} block */
    const storedLength = block=>block.codec === 2 ? block.packed : block.length;

    const cache = await createBlockCache({
        // Absent means local, and only an explicit falsy value turns it off --
        // so `??` will not do here: `store: null` has to mean no cache.
        store: await resolveBlockStore(
            options.bundle.store === undefined ? 'local' : options.bundle.store),
        name: options.bundle.id ?? options.id ?? 'bundle',
        blockSize: bundle.blockSize,
        blockCount: bundle.blockCount,
    });

    const source = createBundleSource({
        bundle,
        /** @param {number} index */
        readBlock: index=>cache.read(index, storedLength(bundle.block(index))),
        decode,
    });

    filesystem.mount('C', { source });
    events.emit('bundle', {
        files: bundle.files.length,
        blockSize: bundle.blockSize,
        blocks: bundle.blockCount,
        cached: cache.diagnostics().resident,
        backed: cache.backed,
    });

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
        const span = group.end - group.start;
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
            cache.put(block.index,
                bundle.block(block.index).codec === 1 ? await inflateRaw(raw) : raw);
        }
    };

    // What a read is waiting on right now. The background filler stands aside
    // whenever this is above zero: a block a parked thread wants is worth more
    // than any block nobody has asked for.
    let waiting = 0;
    let stopped = false;

    /** @param {any[]} needed */
    const demand = async needed=>{
        const absent = [...new Map(needed
            .filter(block=>!cache.has(block.index))
            .map(block=>[block.index, block])).values()]
            .sort((left, right)=>left.offset - right.offset);

        waiting++;
        try
        {
            await inParallel(groupBlocks(absent), MAX_CONCURRENT_REQUESTS, fetchGroup);
        }
        finally
        {
            waiting--;
        }

        // Once per batch, not once per block: losing the record of a block that
        // is already on disk costs one refetch, and writing it every time would
        // cost far more than that.
        await cache.persist();
    };

    /**
     * Fills the rest of the cache while the game is not asking for anything.
     *
     * Not a guess about what will be read next -- it is the whole bundle, in
     * container order, taken one request at a time out of the gaps. That makes
     * it the opposite of a heuristic: nothing about it can be wrong about the
     * game's access pattern, it can only be early or late.
     *
     * One request at a time, and only while no read is parked. Both follow from
     * what this is for: it exists to use idle time, so the moment the time stops
     * being idle it has to give the connections back to the read that a player
     * is actually waiting on.
     *
     * Off when the blocks have nowhere to go. Filling a bounded heap cache with
     * a whole bundle would evict as fast as it fills, and pay for every byte of
     * it twice.
     */
    const fill = async()=>{
        if (!cache.backed || options.bundle.prefetch === false)
        {
            return;
        }

        const all = Array.from({ length: bundle.blockCount },
            (unused, index)=>bundle.block(index));

        for (const group of groupBlocks(all))
        {
            while (true)
            {
                if (stopped)
                {
                    return;
                }
                if (waiting === 0)
                {
                    break;
                }
                await new Promise(resolve=>setTimeout(resolve, IDLE_CHECK_MS));
            }
            const missing = group.blocks.filter(block=>!cache.has(block.index));
            if (missing.length === 0)
            {
                continue;
            }

            try
            {
                await fetchGroup(group);
                await cache.persist();
            }
            catch (e){
                // A run that cannot be filled in the background is still a run.
                // The blocks it failed on will be asked for again, in front of a
                // parked thread, where the failure belongs.
                events.emit('bundle-prefetch-failed',
                    { start: group.start, reason: /** @type {any} */ (e).message });
                return;
            }
            events.emit('bundle-prefetch', {
                resident: cache.diagnostics().resident,
                blocks: bundle.blockCount,
            });
        }
    };

    // Deliberately not awaited: it runs for as long as the bundle has blocks
    // left, which is the whole session.
    fill();
    return {
        fetch: demand,
        stop(){
            stopped = true;
        },
    };
}

/**
 * @param {AppOptions} options
 * @returns {Promise<any>} an AppController
 */
export async function createApp(options){
    const events = createEvents();

    // The address space above the program: a heap first, then the system
    // modules one after another. Both sit well clear of an executable's own
    // preferred base (0x400000) and inside the memory the emulator was given,
    // which is what an address beyond it fails against.
    const HEAP_BASE = 0x01000000;
    const HEAP_SIZE = options.heapSize ?? 0x00800000;
    const MODULE_BASE = 0x02000000;
    const MODULE_STRIDE = 0x00100000;

    /**
     * The modules win32 implements, filled in below. win32 is built before they
     * exist -- it is what says which functions they export -- so it is handed
     * these lookups rather than the answers, and only ever calls them while the
     * guest is running.
     *
     * @type {Map<string, any>}
     */
    const byName = new Map();
    /** @type {Map<number, any>} */
    const byBase = new Map();
    /** @type {any} */
    let mainModule = null;

    /** @param {string | null} name */
    const findModule = name=>{
        if (name === null || name === '')
        {
            return mainModule;
        }
        // A name may arrive with or without its extension, and case never
        // matters: the same library is asked for both ways in one program.
        const wanted = name.toLowerCase().replace(/\.dll$/, '');
        return byName.get(wanted) ?? null;
    };

    // Where input goes when nobody says otherwise: the most recently created
    // window, which is what a person would be looking at.
    let foreground = 0;

    // Filled in once the emulator is up and a bundle, if any, is mounted. win32
    // is built before that and is handed the lookup rather than the answer.
    /** @type {{ fetch: (needed: any[]) => Promise<void>, stop: () => void } | null} */
    let blocks = null;

    // A call that is waiting -- a message loop with an empty queue -- is let go
    // once per scheduler turn to look again.
    /** @type {(() => void)[]} */
    let idlers = [];

    const core = await assembleModules({
        audio: {
            publishInterface: (/** @type {any} */ object, /** @type {string} */ iid)=>
                core.api('bridge').publishInterface(object, iid),
            // The guest's clock, never the host's. A program that fills a sound
            // buffer reads how far playback has got and compares it with a time
            // it took from somewhere else; two clocks make it disagree with
            // itself about whether it is behind.
            now: ()=>core.api('kernel').clock.virtualTime(),
            allocate: (/** @type {number} */ bytes)=>core.api('win32').heap().allocate(bytes),
        },
        input: {
            publishInterface: (/** @type {any} */ object, /** @type {string} */ iid)=>
                core.api('bridge').publishInterface(object, iid),
            now: ()=>core.api('kernel').clock.virtualTime(),
        },
        graphics: {
            // Where a COM interface goes when a program asks for one. Without
            // it the drawing entry points refuse rather than publishing into
            // nowhere, which is what a build with no bridge should do.
            publishInterface: (/** @type {any} */ object, /** @type {string} */ iid)=>
                core.api('bridge').publishInterface(object, iid),
            device: options.device ?? null,
            screen: options.screen,
        },
        win32: {
            /** @param {number} handle @param {string} text */
            onOutput: (handle, text)=>events.emit('output', { handle, text }),
            /** @param {string} text */
            onTrace: text=>events.emit('debug', { text }),
            registers: {
                /** @param {string} name */
                read: name=>core.api('cpu').readReg32(name),
                /** @param {string} name @param {number} value */
                write: (name, value)=>core.api('cpu').writeReg32(name, value),
            },
            // A C runtime returns a double on the floating-point stack, not in
            // a register, so the functions that do are exported only when this
            // is here to leave one there.
            fpu: {
                /** @param {number} value */
                setResult: value=>core.api('cpu').fpu.setResult(value),
                /** @param {number} index */
                get: index=>core.api('cpu').fpu.get(index),
                pop: ()=>core.api('cpu').fpu.pop(),
            },
            arena: { base: HEAP_BASE, size: HEAP_SIZE },
            modules: {
                /** @param {string | null} name */
                find: name=>findModule(name),
                /** @param {number} base */
                byBase: base=>byBase.get(base >>> 0) ?? null,
                imagePath: ()=>options.imagePath ?? 'C:\\app.exe',
                /** @param {string} name */
                load: name=>loadLibraryAtRuntime(name),
                /** @param {any} asked */
                resolved: asked=>events.emit('resolved', asked),
                /**
                 * A string out of a module's own resources.
                 *
                 * An HINSTANCE is the base a module was mapped at, and zero
                 * means the running program -- which is what a program passes
                 * when it asks for its own strings, which is nearly always.
                 *
                 * @param {number} instance @param {number} id
                 */
                loadString: (instance, id)=>{
                    const module = instance === 0
                        ? mainModule
                        : byBase.get(instance >>> 0) ?? null;
                    return module?.file
                        ? loadString(module.file, module.image, id)
                        : null;
                },
            },
            idle: ()=>new Promise(resolve=>idlers.push(()=>resolve(undefined))),
            /** @param {any[]} needed */
            fetchBlocks: needed=>blocks ? blocks.fetch(needed) : Promise.resolve(),
            /** @param {number} hwnd */
            created: hwnd=>{
                foreground = hwnd;
            },
        },
    });

    const filesystem = core.api('filesystem');
    const storage = resolveStorage(options.storage, options.id ?? 'session');

    // Seeded before the program's first instruction, and awaited: a save that
    // arrives after the program has looked for it is a save that was not there.
    const seeded = await storage.load();
    if (seeded.length > 0)
    {
        filesystem.apply(seeded);
    }

    // One way out. What the program writes is announced once the writes settle;
    // nothing is ever pulled back in while it runs.
    const persist = storage.save;
    if (persist)
    {
        filesystem.onChanged((/** @type {any[]} */ changes)=>{
            events.emit('session', { changes });
            Promise.resolve(persist(filesystem.export(), changes)).catch(
                (/** @type {Error} */ error)=>{
                    events.emit('error', { reason: 'session-save', error });
                });
        });
    }

    const cpu = core.api('cpu');
    const memory = core.api('memory');
    const kernel = core.api('kernel');
    const loader = core.api('loader');
    const win32 = core.api('win32');
    const bridge = core.api('bridge');
    const graphics = core.api('graphics');
    const audio = core.api('audio');
    const input = core.api('input');

    await cpu.boot(options.v86);

    // Mounted after the emulator is up, because the decoder for a compressed
    // block is inside it: zstd is the only decompressor available here that
    // answers a guest's read without a promise.
    blocks = await mountBundle({ options, cpu, filesystem, events });

    const { entryVector, initialStack, thunkBase } = cpu.layout;
    const stackSize = options.stackSize ?? 0x10000;

    memory.register({
        name: 'entry-vector', base: entryVector, size: 4,
        kind: memory.RegionKind.THUNK_DATA, access: memory.Access.READ_WRITE,
    });
    memory.register({
        name: 'stack', base: initialStack - stackSize, size: stackSize,
        kind: memory.RegionKind.STACK, access: memory.Access.READ_WRITE,
    });
    memory.register({
        name: 'heap', base: HEAP_BASE, size: HEAP_SIZE,
        kind: memory.RegionKind.THUNK_DATA, access: memory.Access.READ_WRITE,
    });

    // Every system module exists in guest memory before the program's first
    // instruction, not when something first asks for it. An address taken early
    // has to be the address that works later (§13.3), and a module conjured on
    // demand cannot promise that.
    const ordinalsOf = win32.ordinals ? win32.ordinals() : {};
    // The drawing APIs are libraries like any other as far as a program is
    // concerned: it imports Direct3DCreate8 exactly as it imports CreateFileA,
    // and nothing about how they are reached should differ.
    const allLibraries = {
        ...win32.libraries(),
        ...graphics.libraries?.() ?? {},
        ...audio.libraries?.() ?? {},
        ...input.libraries?.() ?? {},
    };
    Object.entries(allLibraries).forEach(([name, table], index)=>{
        // A library imported by number has to be synthesised with the numbers
        // the program compiled against; one we assigned ourselves would bind to
        // a different function, silently.
        /** @type {Record<number, string>} */
        const byOrdinal = ordinalsOf[name] ?? {};
        const declared = new Map(Object.entries(byOrdinal)
            .map(([ordinal, exported])=>[exported, Number(ordinal)]));

        const exports = Object.entries(table).map(([exported, fn])=>({
            name: exported,
            ordinal: declared.get(exported),
            target: bridge.register(`${name}!${exported}`, fn),
        }));

        const base = MODULE_BASE + index * MODULE_STRIDE;
        const placed = loader.synthesise({ name, base, exports });

        // An export's address is its trampoline inside the module, and that is
        // what both the import table and GetProcAddress hand out -- so a program
        // comparing the two finds them equal, as it does on Windows.
        const addresses = new Map(exports.map(entry=>[entry.name, placed.addressOf(entry.name)]));
        const ordinals = new Map([...addresses]
            .map(([exported, address])=>[placed.ordinalOf(exported), address]));
        for (const [exported, address] of addresses)
        {
            bridge.label(Number(address), `${name}!${exported}`);
        }

        const record = {
            name,
            base,
            size: placed.size,
            /** @param {string} exported */
            addressOf: exported=>addresses.get(exported) ?? null,
            /** @param {number} ordinal */
            addressOfOrdinal: ordinal=>ordinals.get(ordinal) ?? null,
        };
        byName.set(name.toLowerCase().replace(/\.dll$/, ''), record);
        byBase.set(base, record);
    });

    /**
     * An import's address, wherever the library that provides it came from.
     *
     * By ordinal as well as by name, because a library may be imported either
     * way and some are imported only by number -- a descriptor that gives an
     * ordinal and no name is not exotic, it is how a whole class of libraries
     * has always been linked against.
     *
     * @param {string} dll
     * @param {string | null} name
     * @param {number | null} ordinal
     */
    const resolveImport = (dll, name, ordinal)=>{
        const module = findModule(dll);
        if (!module)
        {
            return null;
        }
        if (name !== null)
        {
            return module.addressOf(name);
        }
        return ordinal === null ? null : module.addressOfOrdinal(ordinal);
    };

    /**
     * Libraries asked for while the program runs, and the ones that are not
     * there. Both are remembered, and the second matters as much as the first:
     * a title probes for hardware support once a frame by asking for a library
     * that does not exist, and a probe that has to wait is a stall per frame.
     *
     * @type {Set<string>}
     */
    const absentLibraries = new Set();
    /** Where the next runtime library goes. Set once the shipped ones are placed. */
    let nextLibraryBase = 0;

    /**
     * LoadLibrary, for a library nothing has loaded yet.
     *
     * Synchronous unless a PE actually has to be read, because the dispatcher
     * treats a promise as "park the guest thread" and the two cheap answers --
     * already here, known absent -- must not cost that.
     *
     * @param {string} name
     * @returns {number | Promise<number>}
     */
    const loadLibraryAtRuntime = name=>{
        const key = name.toLowerCase().replace(/\.dll$/, '');
        if (absentLibraries.has(key))
        {
            return 0;
        }
        return (async()=>{
            const path = options.imagePath ?? 'C:\\app.exe';
            const directory = path.slice(0, path.lastIndexOf('\\') + 1);
            const file = await readWholeFile(filesystem, blocks, `${directory}${name}`);
            if (!file)
            {
                absentLibraries.add(key);
                return 0;
            }

            const image = parsePe(file);
            if (nextLibraryBase + image.sizeOfImage > cpu.layout.memorySize)
            {
                absentLibraries.add(key);
                events.emit('libraries-missing', { names: [name], reason: 'no room' });
                return 0;
            }

            const base = nextLibraryBase;
            const mapped = loader.map(file, { base, name });
            const { exports } = readExports(file, image);
            const addresses = new Map(exports
                .filter(entry=>entry.name !== null && entry.forwards === null)
                .map(entry=>[String(entry.name), base + entry.rva]));
            const ordinals = new Map(exports
                .filter(entry=>entry.forwards === null)
                .map(entry=>[entry.ordinal, base + entry.rva]));

            const held = {
                name, base, size: image.sizeOfImage,
                /** @param {string} exported */
                addressOf: exported=>addresses.get(exported) ?? null,
                /** @param {number} ordinal */
                addressOfOrdinal: ordinal=>ordinals.get(ordinal) ?? null,
                entryPoint: mapped.record.entryPoint,
            };
            // Registered before its own imports are bound, so a library that
            // imports back into itself -- or into one still being loaded --
            // finds an address rather than nothing.
            byName.set(key, held);
            byBase.set(base, held);
            nextLibraryBase = base
                + Math.ceil(image.sizeOfImage / LIBRARY_ALIGN) * LIBRARY_ALIGN;

            loader.bind(mapped, resolveImport);

            // Its own libraries, if it brought any, before it is attached.
            for (const dependency of parsePe(file) && readImports(file, image))
            {
                if (findModule(dependency.dll) === null)
                {
                    await loadLibraryAtRuntime(dependency.dll);
                }
            }

            if (held.entryPoint && held.entryPoint !== base)
            {
                await bridge.callGuest({
                    entry: held.entryPoint,
                    args: [base, DLL_PROCESS_ATTACH, 0],
                });
            }
            events.emit('library-loaded', { name, base });
            return base;
        })();
    };

    // The libraries the program brought with it, before the program itself.
    //
    // Every one is mapped before any is bound, because they import each other:
    // binding the first needs the second's exports, which need the second's
    // base. This is also why the executable is bound last, below, rather than
    // here -- by then every library it names has an address.
    const shipped = await mapShippedLibraries({
        executable: options.executable,
        imagePath: options.imagePath ?? 'C:\\app.exe',
        filesystem, loader, blocks, events,
        isSystem: (/** @type {string} */ name)=>findModule(name) !== null,
        byName, byBase,
        // Straight after the system modules, which is the first address nothing
        // else has claimed.
        base: MODULE_BASE + Object.keys(allLibraries).length * MODULE_STRIDE,
        memoryBytes: cpu.layout.memorySize,
    });
    for (const library of shipped)
    {
        loader.bind(library.mapped, resolveImport);
    }
    // Where a library asked for later goes: after the ones that came with the
    // program, or after the system modules when there were none.
    nextLibraryBase = shipped.reduce(
        (highest, library)=>Math.max(highest, library.base + library.size),
        MODULE_BASE + Object.keys(allLibraries).length * MODULE_STRIDE);

    const image = loader.load(options.executable, { resolveImport });

    mainModule = {
        name: 'app.exe',
        base: image.base,
        addressOf: ()=>null,
        addressOfOrdinal: ()=>null,
        // Kept because a program reads its own resources, and a resource
        // directory is read out of the file rather than out of the mapping.
        file: options.executable,
        image: parsePe(options.executable),
    };
    byBase.set(image.base, mainModule);

    const stubs = cpu.thunkImage();
    memory.register({
        name: 'thunks', base: thunkBase, size: stubs.length,
        kind: memory.RegionKind.THUNK_CODE, access: memory.Access.READ_WRITE_EXECUTE,
    });
    memory.writeBytes(thunkBase, stubs);
    // Written once; from here a write into the stubs would be corruption.
    memory.protect('thunks', memory.Access.READ_EXECUTE);

    // Every library the program brought with it is attached before the program
    // runs, on the process's first thread, in dependency order -- which is what
    // a real loader does and where a library expects to build the state its
    // exports assume. It is guest code because the calls belong on a guest
    // stack; the stub's last instruction enters the program.
    // Somewhere to put what a process needs before it starts: thread-local
    // blocks, and the stub that sets them up. Its own span rather than the
    // guest heap, because the heap is the program's and this is written before
    // the program exists to allocate from it.
    const STARTUP_ARENA = 0x100000;
    const startupArena = nextLibraryBase;
    memory.register({
        name: 'process-startup', base: startupArena, size: STARTUP_ARENA,
        // Executable because the stub that runs before the program lives here
        // too, and it is guest code.
        kind: memory.RegionKind.THUNK_CODE, access: memory.Access.READ_WRITE_EXECUTE,
    });
    nextLibraryBase += STARTUP_ARENA;

    let scratch = startupArena;
    /** @param {number} size */
    const allocateFromHeap = size=>{
        const at = scratch;
        // Aligned, because a thread-local block holds whatever the compiler put
        // in it and some of that wants alignment the program never restates.
        scratch += size + 15 & ~15;
        if (scratch > startupArena + STARTUP_ARENA)
        {
            throw new Error('process startup needs more room than it was given');
        }
        return at;
    };

    // Thread-local storage, for every image that declares any.
    //
    // The block is filled here, on the host, because it is only bytes; the slot
    // number has to come from the guest's own TlsAlloc, because a runtime later
    // reads it with TlsGetValue and the two have to be talking about the same
    // pool. So the stub does the asking and this does the filling.
    const withTls = [mainModule, ...shipped].map(held=>{
        const directory = held.file ? readTls(held.file, held.image ?? parsePe(held.file)) : null;
        if (!directory)
        {
            return held;
        }
        const size = directory.templateSize + directory.zeroFillSize;
        const blockAddress = allocateFromHeap(size);
        memory.writeBytes(blockAddress, new Uint8Array(size));
        memory.writeBytes(blockAddress, directory.template);

        return {
            ...held,
            tls: {
                indexAddress: held.base + directory.indexRva,
                blockAddress,
                callbacks: directory.callbackRvas.map(rva=>held.base + rva),
            },
        };
    });

    const kernel32 = findModule('kernel32');
    const startup = synthesiseProcessInit({
        libraries: withTls.filter(held=>held !== mainModule || held.tls),
        entryPoint: image.entryPoint,
        tlsApi: kernel32 && {
            alloc: kernel32.addressOf('TlsAlloc') ?? 0,
            set: kernel32.addressOf('TlsSetValue') ?? 0,
        },
    });
    // Inside the same span the blocks came from, rather than beside it: it is
    // written once, before anything runs, and giving it a region of its own
    // only creates a boundary two allocations can land on either side of.
    const start = startup.attached.length === 0 && startup.tlsImages === 0
        ? image.entryPoint
        : (()=>{
            const at = allocateFromHeap(startup.bytes.length);
            memory.writeBytes(at, startup.bytes);
            events.emit('libraries-attached', {
                names: startup.attached,
                tlsImages: startup.tlsImages,
            });
            return at;
        })();

    memory.writeU32(entryVector, start);

    // What FS points at. A program reaches this in code its compiler emitted
    // rather than code anybody wrote -- a thread-local variable is an index off
    // FS:[0x2c], an exception handler's prologue writes FS:[0] -- so a thread
    // running without one reads linear address 0x2c, finds nothing, and carries
    // on with a null.
    const process = createProcessBlocks({
        allocate: allocateFromHeap,
        writeMemory: (address, bytes)=>memory.writeBytes(address, bytes),
        processId: 0x1000,
        version: { major: 5, minor: 1, build: 2600 },
        imageBase: image.base,
        imagePath: options.imagePath ?? 'C:\\app.exe',
        // Quoted, and this is not cosmetic: a program is handed one string and
        // argv[0] ends at the first space, so an unquoted path with a space in
        // it hands the rest of the path to the program as its first argument.
        commandLine: `"${options.imagePath ?? 'C:\\app.exe'}"`,
        currentDirectory: 'C:\\',
        standardHandles: { input: 0, output: 0, error: 0 },
    });

    // The program's first thread. Everything after this runs under the
    // scheduler, including the main thread -- there is no privileged path.
    const mainBlock = process.createThreadBlock({
        id: 1,
        stackBase: initialStack,
        stackLimit: initialStack - stackSize,
    });
    const mainThread = kernel.createThread({
        entry: start,
        stackTop: initialStack,
        tebAddress: mainBlock.teb,
        name: 'main',
    });

    /**
     * Pausing is a gate rather than a flag polled in a loop: a paused caller
     * waits on a promise that resuming resolves, so nothing spins.
     *
     * @type {{ gate: Promise<void>, open: () => void } | null}
     */
    let paused = null;

    // attachLog is sugar over the registry: the same subscription, remembered
    // by the sink the caller gave, so detaching still takes what it was given.
    /** @type {Map<Function, (payload: any) => void>} */
    const logSinks = new Map();

    /**
     * Announces a failure the program itself cannot see, and hands back what to
     * throw. A handler may answer with an error of its own to throw instead.
     *
     * The trace is taken here rather than by whoever catches it: by then the
     * machine has moved on, and the registers that say where it went wrong are
     * gone. It is attached to the error too, so a caller that only catches the
     * throw still has it.
     *
     * @param {string} reason
     * @param {any} error
     * @returns {any}
     */
    const fail = (reason, error)=>{
        const trace = captureTrace({ cpu, memory, kernel, bridge });
        const text = formatTrace(trace);
        const thrown = error instanceof Error ? error : new Error(String(error));
        Object.assign(thrown, { reason, trace, traceText: text });
        return events.emit('error', { reason, error: thrown, trace, text }) ?? thrown;
    };

    return {
        /** Where the program was mapped and where it starts. */
        image,

        /**
         * Runs the program to completion, one scheduler turn at a time.
         *
         * Turns rather than a free-running emulator: a turn is where a thread
         * can be preempted, where a blocked one is put back on the road, and
         * where "nothing can run" becomes visible instead of looking like work.
         *
         * @param {Object} [runOptions]
         * @param {number} [runOptions.maxTurns]
         * @returns {Promise<number>} the guest's exit code
         */
        async run({ maxTurns = 200000 } = {}){
            for (let turn = 0; turn < maxTurns; turn++)
            {
                if (paused)
                {
                    await paused.gate;
                }

                // One yield per turn, so a host function suspended on a guest
                // callback can make progress between them. Without it the loop
                // never returns to the event loop on its normal path and such a
                // handler would be resumed exactly never.
                await Promise.resolve();

                // And a turn is also when anything waiting for something to
                // arrive -- a message loop with an empty queue -- gets to look
                // again. Taken as a batch: a waiter that goes back to waiting
                // must not be released twice by its own turn.
                if (idlers.length > 0)
                {
                    const waiting = idlers;
                    idlers = [];
                    for (const release of waiting)
                    {
                        release();
                    }
                    await Promise.resolve();
                }

                // Still waiting after being let look, or a host call suspended
                // on something outside the microtask queue -- a fetch, a file
                // read -- means the machine has nothing to do until the host
                // gets a turn. A microtask does not give it one, so this is the
                // one place the loop hands it back, and it costs nothing
                // precisely because the guest is not running.
                if (idlers.length > 0 || bridge.suspended() > 0)
                {
                    await new Promise(resolve=>setTimeout(resolve, 0));
                }

                const failure = bridge.failure();
                if (failure)
                {
                    throw fail('host-call', failure);
                }

                const code = win32.exitCode();
                if (code !== null)
                {
                    events.emit('exit', { code });
                    return code;
                }

                // A processor exception stops the machine rather than raising
                // anything: the report cannot be thrown from where it is
                // noticed, so it is left here to be found. Checked before the
                // next turn, because from outside a halted processor and a
                // program that finished look exactly alike.
                const fault = cpu.fault();
                if (fault)
                {
                    const error = new Error(fault.text);
                    Object.assign(error, { code: 'GUEST_FAULT', fault });
                    throw fail('guest-fault', error);
                }

                let step;
                try
                {
                    step = kernel.runOnce();
                }
                catch (e){
                    // A fault inside the guest, or inside a host function
                    // answering it. Either way the program cannot be told, and
                    // the state that explains it is about to be lost.
                    throw fail('guest', e);
                }

                if (!step.ran)
                {
                    // Nobody is ready. Either everything finished without the
                    // program exiting, or every thread is waiting on something
                    // no one will signal -- and the diagnostics name what.
                    const waiting = kernel.diagnosticsSnapshot().waiting;
                    if (waiting.length > 0)
                    {
                        throw fail('deadlock', new Error(`deadlock: ${waiting.join('; ')}`));
                    }
                    throw fail('no-threads',
                        new Error('every thread ended without the process exiting'));
                }
            }
            throw fail('runaway',
                new Error(`program did not finish within ${maxTurns} turns`));
        },

        /** The program's first thread. */
        mainThread,

        /**
         * Stops handing out turns without ending anything; `resume` continues
         * from the same place, since no thread's state was touched.
         */
        pause(){
            if (paused)
            {
                return;
            }
            /** @type {() => void} */
            let open = ()=>{};
            const gate = new Promise(resolve=>{
                open = ()=>resolve(undefined);
            });
            paused = { gate, open };
        },
        resume(){
            if (!paused)
            {
                return;
            }
            paused.open();
            paused = null;
        },
        stop: ()=>cpu.stop(),

        /**
         * Watches, answers, or swallows something the program did.
         *
         * Handlers run in registration order and the first to return anything
         * other than `undefined` decides and stops the rest -- so observing and
         * intercepting are the same mechanism, and a handler that returns
         * nothing has not intervened.
         *
         * What is emitted today: `output` ({ handle, text }) for a write to a
         * standard handle, `debug` ({ text }) for the program's own tracing,
         * `error` ({ reason, error }) for a failure the program cannot see,
         * and `exit` ({ code }) when it ends.
         *
         * @param {string} name
         * @param {(payload: any) => any} handler
         * @returns {() => void} stops this handler
         */
        on: (name, handler)=>events.on(name, handler),
        /** @param {string} name @param {(payload: any) => any} handler */
        off: (name, handler)=>events.off(name, handler),

        /** @param {(handle: number, text: string) => void} sink */
        attachLog(sink){
            /** @param {any} payload */
            const handler = payload=>{
                sink(payload.handle, payload.text);
            };
            logSinks.set(sink, handler);
            events.on('output', handler);
        },
        /** @param {(handle: number, text: string) => void} sink */
        detachLog(sink){
            const handler = logSinks.get(sink);
            if (handler)
            {
                events.off('output', handler);
                logSinks.delete(sink);
            }
        },

        /**
         * Puts a message in the guest's queue: a keystroke, a mouse move, a
         * request to close. This is the seam the input layer will post through,
         * and the way a test drives a program that is waiting for a user.
         *
         * @param {{ hwnd?: number, message: number, wParam?: number, lParam?: number }} message
         */
        post(message){
            win32.queue().post({
                hwnd: message.hwnd ?? foreground,
                message: message.message,
                wParam: message.wParam ?? 0,
                lParam: message.lParam ?? 0,
            });
        },

        /** The registry the program reads and writes; it outlives the process. */
        registry: ()=>win32.registry(),

        /**
         * The session: everything the program has written, and the way to put
         * files in from outside.
         */
        session: {
            /** @returns {{ path: string, bytes: Uint8Array }[]} */
            export: ()=>filesystem.export(),
            /** @param {{ path: string, bytes?: Uint8Array, delete?: boolean }[]} changes */
            apply: changes=>filesystem.apply(changes),
        },

        exitCode: ()=>win32.exitCode(),
        diagnostics: ()=>[
            ...core.diagnostics(),
            { name: 'app', version: '0.1.0', status: 'ready', metrics: events.diagnostics() },
        ],
        dispose(){
            // Before the graph goes: the background filler would otherwise go
            // on asking for blocks nobody can put anywhere.
            blocks?.stop();
            return core.dispose();
        },
    };
}
