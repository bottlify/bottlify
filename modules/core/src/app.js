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
 * @property {Object} [media]             Video decoding, when this build has it.
 * @property {ArrayBuffer} [media.wasmBytes]
 *           The decoder binary. Absent, the media layer comes up and reports
 *           that nothing can be played, which is what a build without it is.
 * @property {number} [stackSize]
 * @property {number} [heapSize]     Bytes the guest's heap may allocate out of.
 * @property {boolean} [traceStrings]  Keep the text an argument pointed at, for a trace.
 * @property {(dll: string, name: string | null, ordinal: number | null)
 *     => ({ args: number } | null)} [watchImport]
 *     Asked about every import as it is bound. Answering with an argument count
 *     puts a watch in front of that function, so a call from one guest module
 *     into another shows up in the trace like a call into ours. This is the only
 *     way to see them, and a game's own libraries are where its decisions live.
 * @property {{ categories?: Record<string, string>, capacity?: number }} [log]
 *     Which call areas are recorded from the first instruction, and how much of
 *     the journal is kept. Everything a program decides about a device it
 *     decides while starting up, so a category switched on once the engine
 *     exists is switched on too late to see any of it.
 * @property {{ drained?: boolean, sampleRate?: number }} [audio]
 *     Sound leaves through a ring in shared memory. `drained` says that
 *     something on the other side of it is really reading -- a WebAudio
 *     worklet, usually -- which is what decides whether a program's play cursor
 *     follows the sound or a clock.
 * @property {(record: any) => void} [onCall]
 *           Every host call as it returns. The ring kept for a failure holds
 *           the end of a run; this holds all of it, for a tool willing to
 *           write it somewhere.
 * @property {number} [quantum]  Guest instructions per scheduler turn. Lowering
 *           it is what makes `sample` a profile rather than a rumour.
 * @property {(eip: number) => void} [sample]
 *           Called with the guest's instruction pointer at every turn boundary.
 *           This is the only view of what a program is doing between host calls,
 *           which is where a program that fails on its own computed state fails.
 * @property {string} [imagePath]    What the program believes it was loaded from.
 * @property {string} [commandLine]
 *           What the program believes it was started with. argv[0] ends at the
 *           first space unless it is quoted, so a line composed by hand must
 *           quote it. Defaults to the image path, quoted.
 * @property {boolean} [refuseReplacement]
 *           Stop rather than replace this process with a child it asked for. A
 *           replacement erases every log and ring of the run that asked for it,
 *           once per iteration of a loop that keeps asking, so this is how the
 *           machine is made to stand still at the point of the request with the
 *           evidence still in it.
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
 * @property {string} [bundle.prefix]  Where in the volume the bundle appears.
 *           Defaults to the directory a game is installed into.
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
 * One event's payload as a line.
 *
 * Built now rather than left as a template argument, which is the journal's
 * usual economy: an event carries an object, and an object read later is the
 * object as it ended up rather than as it was reported. Events are occasional
 * -- a library loading, a write, a failure -- so the string costs nothing that
 * matters, and it is the difference between a log that can be read and one
 * that says [object Object].
 *
 * @param {any} payload
 * @returns {string}
 */
export function describeEvent(payload){
    if (payload === null || payload === undefined)
    {
        return '';
    }
    if (typeof payload !== 'object')
    {
        return String(payload);
    }
    return Object.entries(payload)
        .map(([key, value])=>{
            if (value instanceof Error)
            {
                return `${key}=${value.message}`;
            }
            if (Array.isArray(value))
            {
                return `${key}=[${value.join(' ')}]`;
            }
            return `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`;
        })
        .join(' ');
}

/**
 * A yield to the macrotask queue, so everything the host has queued gets a turn.
 *
 * Through a message channel rather than a timer, and the difference is not
 * small: a browser clamps a zero timeout to four milliseconds and more once
 * they nest, so a loop yielding that way pays the clamp every time -- measured
 * at eight milliseconds a yield and fifteen seconds in one run, larger than the
 * emulation it was interrupting. A channel message is delivered on the same
 * macrotask turn without the clamp.
 *
 * A timer is still the fallback, because this file has to run in a worker, in a
 * page and under a test runner, and not all of them have a channel.
 *
 * The ports are the machine's for as long as it runs, so the yield carries its
 * own `close`: an open port is a live handle, and a host that counts them --
 * Node does, and will not exit while one is open -- never sees the end of a
 * process that only dropped its reference to it.
 *
 * @returns {(() => Promise<void>) & { close: () => void }}
 */
export function createMacrotask(){
    if (typeof MessageChannel !== 'function')
    {
        return Object.assign(
            ()=>new Promise(resolve=>{
                setTimeout(resolve, 0);
            }),
            { close: ()=>{} });
    }
    const channel = new MessageChannel();
    /** @type {(() => void)[]} */
    const waiting = [];
    // One channel for the life of the process rather than one per yield: a
    // channel is a pair of ports the host has to keep, and making one per turn
    // is the cost this was meant to remove.
    channel.port1.onmessage = ()=>waiting.shift()?.();
    channel.port1.start?.();
    return Object.assign(
        ()=>new Promise(resolve=>{
            waiting.push(/** @type {() => void} */ (resolve));
            channel.port2.postMessage(0);
        }),
        {
            close(){
                channel.port1.close();
                channel.port2.close();
                // Whoever was mid-yield is owed an answer: the port that would
                // have delivered it is gone, and a caller left awaiting it
                // would hold the run loop open for ever.
                while (waiting.length > 0)
                {
                    waiting.shift()?.();
                }
            },
        });
}

/**
 * Consecutive turns retiring no guest instruction at all before the run loop
 * stops spinning on the event loop and waits on a timer instead.
 *
 * Both waits are needed and neither will do alone. A machine whose threads are
 * running while one of its calls is parked has to come back at once, because
 * the turn after this one is real work -- and a zero timeout is clamped to four
 * milliseconds, and to more once they nest, which is that much wall clock per
 * turn for nothing. A machine where nothing ran at all has nothing to come back
 * to: only the host can change its mind, and spinning until it does burns a
 * processor to arrive no sooner while starving the very I/O it is waiting on.
 *
 * So the loop spins while the guest is still getting work done and backs off
 * once it stops. The count is small because of which way it is worse to be
 * wrong: a few spare turns cost microseconds and one turn too many on a timer
 * costs milliseconds.
 */
const IDLE_SPINS_BEFORE_TIMER = 4;

/**
 * What the run loop is waiting on when it cannot go straight on, and how.
 *
 * A range request, a message queue with nothing in it, and some other host call
 * that has not answered are one condition from inside the loop and three
 * different costs. Named apart, a profile says which of the three a run went
 * into; named together it can only say that the machine waited.
 *
 * @param {Object} state
 * @param {number} state.fetching   Range requests outstanding.
 * @param {number} state.idlers     Callers parked on an empty message queue.
 * @param {number} state.suspended  Host calls suspended on anything at all.
 * @param {number} state.spun       Turns in a row that retired no instruction.
 * @returns {{ phase: string, timer: boolean } | null} null to go straight on.
 */
export function idleWait({ fetching, idlers, suspended, spun }){
    if (idlers === 0 && suspended === 0)
    {
        return null;
    }
    const on = fetching > 0 ? 'fetch' : idlers > 0 ? 'message' : 'host';
    const timer = spun >= IDLE_SPINS_BEFORE_TIMER;
    return { phase: `idle-${on}${timer ? '-wait' : ''}`, timer };
}

/**
 * Where a LoadLibrary at run time actually looks.
 *
 * A name that already says where it is, is where it is. Windows searches for a
 * bare name and takes a qualified one as given, and a program that has worked
 * out an absolute path -- a runtime loading its own plug-ins out of a directory
 * beside the executable, say -- passes one. Prefixing it again asks for
 * C:\App\C:\App\..., which is not there, and the plug-in is reported missing
 * while sitting exactly where it was asked for.
 *
 * @param {string} name        What the guest passed to LoadLibrary.
 * @param {string} imagePath   The running executable, whose directory is searched.
 */
export function resolveLibraryPath(name, imagePath){
    const qualified = /^[A-Za-z]:[\\/]/.test(name) || /^[\\/]/.test(name);
    if (qualified)
    {
        return name;
    }
    return `${imagePath.slice(0, imagePath.lastIndexOf('\\') + 1)}${name}`;
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
 * Sorts a parent's deferred writes into the ones that land in the child's image
 * and the ones that do not.
 *
 * A launcher that hollows its child writes into it while it is suspended, which
 * here is a write against an image nothing has mapped yet. The writes are kept
 * and replayed at the addresses they name -- but only inside the image they were
 * meant for. One outside it was addressing a mapping this process does not have,
 * and putting those bytes down anyway would corrupt whatever really is there
 * while looking, from the guest's side, like the child being wrong.
 *
 * @param {{ address: number, bytes: Uint8Array }[]} patches
 * @param {number} base
 * @param {number} size
 * @returns {{ applied: { address: number, bytes: Uint8Array }[],
 *             refused: { address: number, bytes: Uint8Array }[] }}
 */
export function placePatches(patches, base, size){
    /** @type {{ address: number, bytes: Uint8Array }[]} */
    const applied = [];
    /** @type {{ address: number, bytes: Uint8Array }[]} */
    const refused = [];
    for (const patch of patches)
    {
        const inside = patch.address >= base
            && patch.address + patch.bytes.length <= base + size;
        (inside ? applied : refused).push(patch);
    }
    return { applied, refused };
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
 * Where a mounted game appears inside the guest's volume: its files sit
 * directly in this directory, the way an installation's do.
 *
 * A directory of its own rather than the root, because a program of this era
 * finds its own data by asking where it is itself and looking beside that. At
 * the root those two places coincide, so a wrong answer to that question still
 * works and stays hidden until something depends on it being right.
 */
const BUNDLE_DIRECTORY = 'App';

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
            // Kept for the same reason the program's own image is: a resource
            // is read out of the file rather than out of the mapping, and a
            // library a program ships carries the strings, icons, dialogs and
            // version information that program asks for. Without these a
            // module answers nothing for every resource call -- including the
            // one it makes to tell a person what went wrong.
            file,
            image,
            // Where it came from. A program asks a library where it lives and
            // then looks for its own data beside it, so answering with a
            // system directory sends it looking in the wrong place -- and a
            // library a game ships does not live in a system directory.
            path: `${directory}${name}`,
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
        // A game lives in a directory of its own, the way an installation does.
        // At the root of the volume a program's own directory and the system
        // root are the same place, so every answer to "where do I live" happens
        // to work and a wrong one is invisible until it is not.
        prefix: options.bundle.prefix ?? BUNDLE_DIRECTORY,
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
 * One machine, running one image.
 *
 * `createApp` below is what a caller reaches for; this is what it builds, once
 * per process. A child process is a second call to this against the child's
 * image, after the first has been disposed -- so everything here belongs to the
 * program it was built for, and nothing survives except what is passed back in.
 *
 * @param {AppOptions & {
 *     events?: any,
 *     seed?: { path: string, bytes?: Uint8Array, delete?: boolean }[],
 *     patches?: { address: number, bytes: Uint8Array }[],
 *     spawned?: (request: any) => void,
 * }} options
 * @returns {Promise<any>} an AppController
 */
async function buildApp(options){
    // Handed in across a replacement, so a caller's subscriptions outlive the
    // process they were made against: the program has changed, the machine it
    // is running in has not.
    const events = options.events ?? createEvents();

    // The address space above the program: the system modules first, then the
    // libraries a game brought with it, and the heap above all of them with
    // everything that is left.
    //
    // The heap is last because it is the part that has to be big. A game of
    // this era loads its textures, its models and its sound into ordinary
    // memory and expects hundreds of megabytes of it; a heap wedged between
    // the image and the modules can only ever be a few, and what a program
    // does when it runs out is not fail gracefully -- one real title writes a
    // crash report saying there was not enough memory and stops, tens of
    // millions of instructions after everything else had worked.
    //
    // The gap left for modules is generous for the same reason in reverse: a
    // library a game ships can itself be twelve megabytes, and a library
    // placed inside the heap would be overwritten by the first large
    // allocation.
    const MODULE_BASE = 0x02000000;
    const MODULE_STRIDE = 0x00100000;
    const HEAP_BASE = 0x0c000000;
    const HEAP_SIZE = options.heapSize ?? 0x14000000;

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

    /** Range requests outstanding: what a parked guest thread is really on. */
    let fetching = 0;
    /**
     * Resolved when the last of them answers, so the loop can wait for the
     * thing itself rather than poll a timer until it happens.
     *
     * @type {Promise<void> | null}
     */
    let fetched = null;
    /** @type {() => void} */
    let arrived = ()=>{};

    /**
     * What the guest has waited on the network for, and how much of it twice.
     *
     * A block asked for a second time is one the cache had and let go, and
     * there is no other way to tell that apart from a program simply reading
     * more of its own archives -- both look like a run that spends its time
     * fetching. One is a bound to raise; the other is nothing to do with us.
     */
    const bundleReads = { requests: 0, blocks: 0, bytes: 0, again: 0, againBytes: 0 };
    /** @type {Set<number>} */
    const blocksSeen = new Set();

    // A call that is waiting -- a message loop with an empty queue -- is let go
    // once per scheduler turn to look again.
    /** @type {(() => void)[]} */
    let idlers = [];

    /** What the program is told its display is, where it was told anything. */
    const display = options.screen ?? null;

    /**
     * Divergences already reported, so each is said once.
     *
     * A layer notices a divergence where it happens, which for a graphics state
     * is every draw. Reported per call it would fill a frame's journal with one
     * repeated line and bury everything else; reported once it is a short list
     * of what this build does differently, which is what a reader wants.
     *
     * @type {Set<string>}
     */
    const divergences = new Set();

    /**
     * Says that a call succeeded but did not do all of what it promises.
     *
     * Not a failure: a program is entitled to make the call, and refusing it
     * changes what the program does -- usually by stopping it. But accepting a
     * state and not honouring it is the defect class that produces a picture
     * rather than an error, and the only thing separating it from correct
     * behaviour is somebody saying so.
     *
     * @param {string} api      Which surface diverged, as a program names it.
     * @param {string} detail   What was accepted and not acted on.
     */
    const reportDivergence = (api, detail)=>{
        const key = `${api}: ${detail}`;
        if (divergences.has(key))
        {
            return;
        }
        divergences.add(key);
        events.emit('divergence', { api, detail });
    };

    /**
     * Which part of the machine a host call belongs to.
     *
     * A program of this age reaches one engine through a dozen libraries, and
     * the question a reader has is never "which DLL" but "what was it doing" --
     * drawing, making a sound, reading a file, asking the processor something.
     * So the libraries are grouped the way the work is, and the group is the
     * journal's category, which is what makes a filter possible at all.
     *
     * @type {Record<string, string>}
     */
    const CALL_AREAS = {
        'D3D8.dll': 'gpu', 'D3D9.dll': 'gpu', 'DDRAW.dll': 'gpu',
        'OPENGL32.dll': 'gpu', 'GDI32.dll': 'gpu',
        'DSOUND.dll': 'audio', 'WINMM.dll': 'audio', 'mss32.dll': 'audio',
        'quartz.dll': 'video', 'blizzard.ax': 'video',
        'DINPUT.dll': 'input', 'DINPUT8.dll': 'input', 'USER32.dll': 'input',
        'WSOCK32.dll': 'net', 'WS2_32.dll': 'net', 'MSWSOCK.dll': 'net',
        'WININET.dll': 'net',
    };

    /**
     * The journal category one call is written under.
     *
     * A COM method arrives named by its interface rather than by a library, and
     * there is no library to look up -- so it gets its own group instead of
     * being filed under a guess. Everything else that is not drawing, sound,
     * video, input or the network is the processor's own business: memory,
     * files, threads, the registry, the C runtime.
     *
     * @param {any} call
     */
    const areaOf = call=>{
        const name = String(call?.name ?? '');
        const at = name.indexOf('!');
        if (at === -1)
        {
            return 'call.com';
        }
        return `call.${CALL_AREAS[name.slice(0, at)] ?? 'cpu'}`;
    };

    /**
     * Writes one host call to the journal.
     *
     * Every one of them, which is why the categories start switched off: a
     * short run makes tens of thousands of calls, and a reader who has not
     * asked for them should pay a map lookup and a comparison rather than a
     * formatted line. Turning one on is what a filter does.
     *
     * @param {any} call
     */
    const journalCall = call=>{
        const category = areaOf(call);
        if (!journal.enabled(category, journal.Level.TRACE))
        {
            return;
        }
        // Named by the thread that made it. A program of this age runs a dozen
        // of them and the interleaving is the whole story: without this, a loop
        // that is one thread waiting and another working reads as a single
        // thread doing something incoherent, and a thread that has stopped
        // calling anything at all cannot be picked out from the noise of the
        // ones that have not.
        journal.write('trace', category, '[{3}] {0}({1}) = {2}',
            call.name, (call.args ?? []).slice(0, 4)
                .map((/** @type {number} */ value)=>`0x${(value >>> 0).toString(16)}`)
                .join(', '), call.result,
            core.api('kernel').currentThread()?.name ?? '?');
    };

    const core = await assembleModules({
        kernel: {
            // How many guest instructions a thread runs before the next one
            // gets a turn. Lowering it is how a sampled profile gets enough
            // points to say anything; raising it costs nothing but resolution.
            quantum: options.quantum,
        },
        bridge: {
            // win32 sits above the bridge and cannot be reached from it, so the
            // reader is handed down from here. It costs one call per traced
            // call and buys a trace that says which call left an error behind.
            lastError: ()=>core.api('win32').lastError(),
            // Costly and off unless asked for; see the dispatcher.
            traceStrings: options.traceStrings ?? false,
            onCall: (/** @type {any} */ call)=>{
                journalCall(call);
                options.onCall?.(call);
            },
        },
        media: {
            // The decoder, handed down the same way the emulator's binary is:
            // this layer is one module over one wasm blob, and which blob is
            // the assembling caller's decision rather than something to fetch
            // from inside a worker. Absent, the layer comes up and says so.
            wasmBytes: options.media?.wasmBytes,
        },
        log: {
            // Every call area starts switched off. A short run makes tens of
            // thousands of host calls; a reader who has not asked for them
            // should pay a map lookup and a comparison, not a formatted line.
            // A filter turning one on is what makes them appear.
            //
            // A caller may ask for some of them on from the first instruction,
            // and has to be able to: everything a program decides about a
            // device it decides while starting up, and a category switched on
            // once the engine exists is switched on after that has happened.
            categories: {
                'call.cpu': 'off', 'call.gpu': 'off', 'call.audio': 'off',
                'call.video': 'off', 'call.input': 'off', 'call.net': 'off',
                'call.com': 'off',
                ...options.log?.categories,
            },
            // Likewise the ring: a run whose interesting part is its first
            // second needs it no bigger, and one that has to hold a whole
            // startup needs it much bigger.
            capacity: options.log?.capacity,
            // The guest's clock, for the same reason the sound buffers use it:
            // a phase timed against the host and a phase timed against the
            // guest cannot be added together, and the number this layer exists
            // to produce -- how much of a frame was ours -- is a sum.
            now: ()=>core.api('kernel').clock.virtualTime(),
        },
        audio: {
            publishInterface: (/** @type {any} */ object, /** @type {string} */ iid)=>
                core.api('bridge').publishInterface(object, iid),
            // The guest's clock, never the host's. A program that fills a sound
            // buffer reads how far playback has got and compares it with a time
            // it took from somewhere else; two clocks make it disagree with
            // itself about whether it is behind.
            now: ()=>core.api('kernel').clock.virtualTime(),
            allocate: (/** @type {number} */ bytes)=>core.api('win32').heap().allocate(bytes),
            // Whether anything is reading the other end of the ring. Told from
            // outside because only the assembling caller knows whether it
            // opened a device, and it decides whether a program's play cursor
            // follows the sound or the clock.
            drained: options.audio?.drained ?? false,
            sampleRate: options.audio?.sampleRate,
        },
        input: {
            publishInterface: (/** @type {any} */ object, /** @type {string} */ iid)=>
                core.api('bridge').publishInterface(object, iid),
            now: ()=>core.api('kernel').clock.virtualTime(),
            // Where a keystroke goes. The same window win32 reports as
            // foreground, because a person types into what they are looking at
            // and only this side of the assembly knows which that is.
            foreground: ()=>foreground,
            // The cursor is confined to the display the program was told it
            // has: a program that reads a position outside its own screen
            // concludes the mouse left the window.
            bounds: display && (()=>({ width: display.width, height: display.height })),
        },
        graphics: {
            // Where a COM interface goes when a program asks for one. Without
            // it the drawing entry points refuse rather than publishing into
            // nowhere, which is what a build with no bridge should do.
            publishInterface: (/** @type {any} */ object, /** @type {string} */ iid)=>
                core.api('bridge').publishInterface(object, iid),
            device: options.device ?? null,
            screen: options.screen,
            // Where a locked surface or vertex buffer's bytes live. A lock
            // hands the program an address it writes through and the unlock
            // reads those bytes back, so it has to be memory the guest can
            // reach -- an address invented for the purpose is one the program
            // writes into nothing and we read nothing out of.
            allocate: (/** @type {number} */ bytes)=>win32.heap().allocate(bytes),
            // Where "this call succeeded and did not do all of what it
            // promises" goes. Every drawing API has states it accepts and does
            // not honour yet, and a state accepted in silence is the defect
            // class that produces a picture rather than an error.
            divergence: reportDivergence,
        },
        win32: {
            // Sound leaves through the audio layer's mixer, and win32 sits
            // below it. Handed down as a thunk and asked for only when a
            // program opens a device: audio is created after win32, and a build
            // with nothing draining the ring answers null, which is what keeps
            // the wave cursor on the clock rather than stalling it against a
            // device nobody is listening to.
            output: ()=>{
                const audio = core.api('audio');
                return audio?.available?.() ? audio.output() : null;
            },
            // Where the pointer is and what is held down, for the calls that
            // ask rather than wait for a message. Handed down for the same
            // reason as the mixer: input is above win32 and cannot be reached
            // from it, and it does not exist yet when this is read.
            // The pixel-format negotiation and the end of an OpenGL frame,
            // whose entry points GDI32 exports but whose answers belong to the
            // graphics layer above. Every call goes through a thunk for the
            // reason the mixer does: graphics is created after win32.
            graphics: {
                pixelFormat: {
                    size: ()=>core.api('graphics').opengl().pixelFormat.size(),
                    count: ()=>core.api('graphics').opengl().pixelFormat.count(),
                    /** @param {Uint8Array} bytes */
                    choose: bytes=>core.api('graphics').opengl().pixelFormat.choose(bytes),
                    /** @param {number} index @param {number} bytes */
                    describe: (index, bytes)=>
                        core.api('graphics').opengl().pixelFormat.describe(index, bytes),
                },
                /** @param {number} hdc */
                swapBuffers: hdc=>core.api('graphics').opengl().swapBuffers(hdc),
            },
            cursor: ()=>core.api('input')?.cursor?.() ?? { x: 0, y: 0 },
            /** @param {number} key */
            keyState: key=>core.api('input')?.keyState?.(key) ?? 0,
            // The same reporter the graphics layer gets: a Win32 function that
            // accepts a flag it does not act on owes the reader the same
            // warning as a Direct3D state that is stored and unused.
            divergence: reportDivergence,
            /**
             * A message box the program put up.
             *
             * Carried with the guest's own backtrace, because the sentence and
             * the place it was said from answer different halves of the same
             * question -- and the backtrace is only capturable at the moment of
             * the call, since by the time anyone reads a report the stack that
             * explains it is gone. Captured only when somebody is listening:
             * walking the stack costs real work, and a build with no consumer
             * would pay it for nothing.
             *
             * @param {{ text: string, caption: string, type: number }} notice
             */
            onMessageBox: notice=>events.emit('message-box', {
                ...notice,
                trace: events.listening('message-box')
                    ? formatTrace(captureTrace({ cpu, memory, kernel, bridge }))
                    : null,
            }),
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
            commandLine: options.commandLine,
            // Every child a program asks for, while the stack that asked is
            // still standing. Kept by the caller above this, because honouring
            // one of these tears the machine down and takes the logs with it.
            /** @param {any} request */
            spawned: request=>{
                events.emit('process-create', {
                    image: request.imagePath,
                    commandLine: request.commandLine,
                    suspended: request.suspended,
                });
                options.spawned?.({
                    imagePath: request.imagePath,
                    commandLine: request.commandLine,
                    suspended: request.suspended,
                    trace: formatTrace(captureTrace({ cpu, memory, kernel, bridge })),
                });
            },
            idle: ()=>new Promise(resolve=>idlers.push(()=>resolve(undefined))),
            /** @param {any[]} needed */
            /** @param {any[]} needed */
            fetchBlocks: needed=>{
                if (!blocks)
                {
                    return Promise.resolve();
                }
                // Counted, because from the run loop every parked thread looks
                // the same and they are not: a thread waiting on a range
                // request is waiting on the network, and a thread waiting on
                // its own message queue is waiting on nothing at all. Told
                // apart, one of them is a number to reduce and the other is a
                // loop to stop taking so seriously.
                bundleReads.requests++;
                for (const block of needed)
                {
                    bundleReads.blocks++;
                    bundleReads.bytes += block.packed;
                    if (blocksSeen.has(block.index))
                    {
                        bundleReads.again++;
                        bundleReads.againBytes += block.packed;
                    }
                    else
                    {
                        blocksSeen.add(block.index);
                    }
                }
                fetching++;
                if (fetching === 1)
                {
                    // The loop is about to have nothing to do until this
                    // answers, and it can be told exactly when that is. Without
                    // it the only way to find out was to sleep and look again,
                    // on a timeout a browser clamps to a millisecond -- which
                    // measured out at nineteen wake-ups per range request and a
                    // fifth of a whole run spent asking.
                    fetched = new Promise(resolve=>{
                        arrived = resolve;
                    });
                }
                return blocks.fetch(needed).finally(()=>{
                    fetching--;
                    if (fetching === 0)
                    {
                        const open = arrived;
                        fetched = null;
                        arrived = ()=>{};
                        open();
                    }
                });
            },
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

    // And what the process this one replaces had written. A self-extracting
    // installer unpacks its payload and then starts it; without this the
    // payload goes with the machine that wrote it and the child is started
    // against files that are no longer there.
    if (options.seed && options.seed.length > 0)
    {
        filesystem.apply(options.seed);
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

    // Every event the engine reports also goes to the journal, so that one
    // ordered stream carries the whole story. A consumer that subscribes to a
    // name still gets it exactly as before -- a watcher never answers, so it
    // cannot take an event away from a handler that would have.
    //
    // The severity is the event's own: a failure the program cannot see is an
    // error whether or not anybody was listening for it, and a library that
    // could not be found is the warning that explains a program's next
    // decision. Everything else is what happened, at info.
    const journal = core.api('log');
    const SEVERITY = /** @type {Record<string, string>} */ ({
        error: 'error',
        'bundle-unavailable': 'error',
        'library-missing': 'warn',
        'libraries-missing': 'warn',
        unimplemented: 'warn',
        divergence: 'warn',
        // The program's own words about why it is stopping. It is not our
        // failure, but it is never good news.
        'message-box': 'warn',
        'bundle-retry': 'warn',
        'bundle-prefetch-failed': 'warn',
    });
    events.onAny((/** @type {string} */ name, /** @type {any} */ payload)=>{
        journal.write(SEVERITY[name] ?? 'info', name, '{0}', describeEvent(payload));
    });

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

    // The first thread gets the stack its own image asked the linker for.
    //
    // A fixed default is a guess, and the guess is wrong for anything but a
    // trivial program: a C runtime starting up inside a library the program
    // ships will walk past sixty-four kilobytes on its way to `main`. What
    // that produces is not a stack-overflow exception -- it is a read below
    // the mapped stack, reported at whichever call happened to be crossing
    // the boundary, with nothing pointing at the code that wanted the space.
    //
    // Clamped to what actually fits under the initial stack pointer, because
    // the region below it is finite and a request larger than the room is a
    // layout question rather than something to honour silently.
    const stackRoom = initialStack - (thunkBase + cpu.layout.thunkCapacity);
    const stackSize = options.stackSize
        ?? Math.min(Math.max(parsePe(options.executable).stackReserve, 0x10000), stackRoom);

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
    // Our own boot ROM, so that a report can name it. A fault leaves the
    // processor standing in the stub behind its vector, and until this was here
    // that address came back as unmapped -- which sent every reader of a crash
    // looking for a guest bug at an address belonging to the engine.
    memory.register({
        name: 'boot-rom', base: cpu.layout.romBase, size: cpu.layout.romSize,
        kind: memory.RegionKind.LOW_MEM, access: memory.Access.READ_EXECUTE,
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
        const address = name !== null
            ? module.addressOf(name)
            : ordinal === null ? null : module.addressOfOrdinal(ordinal);
        return address === null ? null : watched(dll, name, ordinal, address);
    };

    /**
     * Which imports to stand in front of, and what each one's arguments are.
     * One stub per import, kept because a library is imported by many others
     * and a second stub for the same function would report the same call twice.
     *
     * @type {Map<string, number>}
     */
    const watches = new Map();

    /**
     * Puts a watch in front of an import when the caller asked for one.
     *
     * Only a guest module's exports are worth watching: a call into one of our
     * own is already a trap and already recorded, and pointing a watch at a
     * stub would trap twice for one call.
     *
     * @param {string} dll @param {string | null} name
     * @param {number | null} ordinal @param {number} address
     * @returns {number}
     */
    const watched = (dll, name, ordinal, address)=>{
        if (!options.watchImport)
        {
            return address;
        }
        const asked = options.watchImport(dll, name, ordinal);
        if (!asked)
        {
            return address;
        }
        const label = `${dll}!${name ?? `#${ordinal}`}`;
        const already = watches.get(label);
        if (already !== undefined)
        {
            return already;
        }
        const stub = bridge.watch(label, {
            argBytes: asked.args * 4,
            target: address,
            // The call is about to reach the real function, which will leave
            // its own result in EAX; nothing here answers it. What this does
            // instead is arrange to be told what that answer was, by sending
            // the function home through a stub of ours.
            handler: ()=>{
                const esp = cpu.readReg32('esp') >>> 0;
                pending.push({ label, esp, returnTo: memory.readU32(esp) });
                memory.writeU32(esp, catcher());
                return 0;
            },
        });
        watches.set(label, stub);
        return stub;
    };

    /**
     * Watched calls that have not returned yet, innermost last.
     *
     * A stack rather than a map, because a return address is not enough to tell
     * two calls apart and the answer is wanted per call. Threads can interleave
     * and would confuse it; this is a diagnostic taken with a handful of
     * functions watched, where they do not.
     *
     * @type {{ label: string, esp: number, returnTo: number }[]}
     */
    const pending = [];

    /** @type {number | null} */
    let catcherStub = null;

    /**
     * Where a watched function returns to instead of its caller: a stub that
     * reports the answer and then sends it the rest of the way.
     *
     * Reached by the callee's own `ret`, so the return address is gone from the
     * stack by the time this runs and has to be put back for the stub's own
     * `ret` to find. EAX is the answer and is preserved into ECX by the stub,
     * because the trap needs EAX to say which stub fired.
     */
    const catcher = ()=>{
        catcherStub ??= bridge.register('<watch-return>', {
            argBytes: 0,
            preserveResult: true,
            handler: ()=>{
                const answer = cpu.readReg32('ecx') >>> 0;
                const frame = pending.pop();
                if (!frame)
                {
                    return answer;
                }
                events.emit('guest-return', { name: frame.label, result: answer });
                const esp = (cpu.readReg32('esp') >>> 0) - 4;
                memory.writeU32(esp, frame.returnTo);
                cpu.writeReg32('esp', esp);
                return answer;
            },
        });
        return catcherStub;
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
     * Where a call to an import nothing claims lands.
     *
     * Left alone, the slot keeps what the file wrote into it -- the relative
     * address of the name block -- so a call through it jumps to a small
     * number, runs whatever bytes are there, and dies as an invalid opcode
     * naming an address that has nothing to do with the import. What is wanted
     * instead is the name.
     *
     * The stub pops nothing, so the caller's stack is left wrong. That is
     * accepted deliberately: it never returns. Deriving the right count needs
     * a decorated name and most of these have none, and a stack that survives
     * a call to a function nobody wrote is not worth the pretence.
     *
     * One stub per name, because a program is quite capable of calling the
     * same missing import a thousand times before it gives up.
     *
     * @type {Map<string, number>}
     */
    const missingImports = new Map();

    /**
     * How many argument bytes a stub for an unknown name must pop.
     *
     * Returning at all makes this matter: a stdcall callee cleans up and a
     * caller that gets its stack back four bytes short is corrupted from there
     * on, which surfaces nowhere near the call.
     *
     * The decoration is the only evidence there is, and it is enough for both
     * cases. `_name@N` is stdcall with N bytes of arguments; an undecorated
     * name is a C function, where the caller cleans up and popping nothing is
     * exactly right. A name that is neither -- a C++ mangling, an ordinal -- is
     * refused rather than guessed at, because a wrong count is worse than a
     * loud stop.
     *
     * @param {string | null} name
     * @returns {number}
     */
    const cleanupFor = name=>{
        const decorated = name === null ? null : /@(\d+)$/.exec(name);
        return decorated ? Number(decorated[1]) : 0;
    };

    /** @param {string} dll @param {string | null} name @param {number | null} ordinal */
    const missingImport = (dll, name, ordinal)=>{
        const label = `${dll}!${name ?? `#${ordinal}`}`;
        const known = missingImports.get(label);
        if (known !== undefined)
        {
            return known;
        }
        const address = bridge.register(label, {
            argBytes: cleanupFor(name),
            handler: ()=>{
                events.emit('unimplemented', { import: label });
                // Zero, and back to the caller. It is the only value that reads
                // as failure under every convention at once -- a null pointer,
                // a null handle, FALSE, a count of none -- so a caller that
                // checks its result takes its own failure path and says
                // something about what it wanted.
                //
                // Not every convention: zero is S_OK to a caller expecting an
                // HRESULT and ERROR_SUCCESS to one expecting a status, and both
                // then read an out-parameter nobody wrote. That is the trade,
                // and it is the better half of it -- stopping the process here
                // reports one missing import per run, where continuing reports
                // every one a program actually calls.
                return 0;
            },
        });
        missingImports.set(label, address);
        return address;
    };

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
        // A library already here is handed back rather than loaded again, which
        // is what Windows does: LoadLibrary on a loaded module raises its
        // reference count and returns the handle it already has.
        //
        // Loading it twice is not merely wasteful. A program that asks for the
        // same library in a loop -- and they do, because asking is how a
        // program checks something is there -- gets a second copy of the image
        // at a second address every time: its exports resolve to code whose
        // globals are not the ones the first copy's callers hold, the address
        // space fills until there is no room left, and re-reading, re-parsing,
        // re-mapping and re-binding a megabyte of library is most of what the
        // machine then does with its time.
        const loaded = findModule(name);
        if (loaded)
        {
            return loaded.base;
        }
        return (async()=>{
            const wanted = resolveLibraryPath(name, options.imagePath ?? 'C:\\app.exe');
            const file = await readWholeFile(filesystem, blocks, wanted);
            if (!file)
            {
                absentLibraries.add(key);
                // Said out loud, because this is the failure a program reports
                // as "could not open" and then exits on. Without it the only
                // trace is a zero, and a zero says nothing about which path was
                // tried -- which is the whole question.
                events.emit('library-missing', { name, path: wanted });
                return 0;
            }

            const image = parsePe(file);
            if (nextLibraryBase + image.sizeOfImage > HEAP_BASE)
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
                // As above: resources come from the file, so a library loaded
                // at run time has to keep its own.
                file,
                image,
                path: wanted,
            };
            // Registered before its own imports are bound, so a library that
            // imports back into itself -- or into one still being loaded --
            // finds an address rather than nothing.
            byName.set(key, held);
            byBase.set(base, held);
            nextLibraryBase = base
                + Math.ceil(image.sizeOfImage / LIBRARY_ALIGN) * LIBRARY_ALIGN;

            // Its own libraries first, then binding.
            //
            // The order is the whole of it. A library brought in by this one is
            // where half of this one's imports come from, so binding before
            // they are loaded leaves every one of those slots unclaimed -- and
            // a program that calls through such a slot does not fail at the
            // call, it runs whatever bytes the slot happened to name. What is
            // seen is an invalid opcode at an address belonging to nothing.
            for (const dependency of readImports(file, image))
            {
                if (findModule(dependency.dll) === null)
                {
                    await loadLibraryAtRuntime(dependency.dll);
                }
            }

            loader.bind(mapped, resolveImport, missingImport);
            // Both tables, and in this order: the delay-load pass adds to what
            // the first one recorded rather than replacing it.
            loader.bindDelayed(mapped, resolveImport, missingImport);

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
        loader.bind(library.mapped, resolveImport, missingImport);
        loader.bindDelayed(library.mapped, resolveImport, missingImport);
    }
    // Where a library asked for later goes: after the ones that came with the
    // program, or after the system modules when there were none.
    nextLibraryBase = shipped.reduce(
        (highest, library)=>Math.max(highest, library.base + library.size),
        MODULE_BASE + Object.keys(allLibraries).length * MODULE_STRIDE);

    const image = loader.load(options.executable, { resolveImport, missing: missingImport });

    mainModule = {
        name: 'app.exe',
        base: image.base,
        addressOf: ()=>null,
        addressOfOrdinal: ()=>null,
        // Kept because a program reads its own resources, and a resource
        // directory is read out of the file rather than out of the mapping.
        file: options.executable,
        image: parsePe(options.executable),
        // The same answer whether a program asks by null handle or by its own
        // image base, which are the two ways of asking the same question. A
        // program that asks the second way and is told a system directory goes
        // looking for its own data there.
        path: options.imagePath ?? 'C:\\app.exe',
    };
    byBase.set(image.base, mainModule);

    // What the process that asked for this one wrote into it before it existed.
    // This is the first moment at which the addresses those writes name mean
    // anything, because it is the first moment the image is there.
    if (options.patches && options.patches.length > 0)
    {
        const { applied, refused } = placePatches(
            options.patches, image.base, mainModule.image.sizeOfImage);
        for (const patch of applied)
        {
            memory.writeBytes(patch.address, patch.bytes);
        }
        events.emit('process-patched', {
            applied: applied.length,
            refused: refused.map(patch=>
                `${patch.address.toString(16)}+${patch.bytes.length}`),
        });
    }

    const stubs = cpu.thunkImage();
    memory.register({
        // Sized to what the table may grow to rather than to what it holds
        // now. Slots go on being taken for the life of the process -- one per
        // method of every COM interface a program asks for, one per import
        // nothing claims -- and each is written straight into the guest, which
        // needs somewhere inside the map to write to.
        name: 'thunks', base: thunkBase, size: cpu.layout.thunkCapacity,
        kind: memory.RegionKind.THUNK_CODE, access: memory.Access.READ_WRITE_EXECUTE,
    });
    memory.writeBytes(thunkBase, stubs);
    // Read-execute from the guest's side. Later slots are written from ours,
    // which does not go through this permission -- so a guest writing here is
    // still corruption and is still refused.
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
        // A line chosen by whoever started this process wins, because a child
        // is entitled to the arguments its parent gave it.
        commandLine: options.commandLine ?? `"${options.imagePath ?? 'C:\\app.exe'}"`,
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

    /** The mixer, when this build has one. Read once; it does not change. */
    const sound = core.api('audio')?.output?.() ?? null;

    /** The guest's own clock, and the host clock it is credited from. */
    const clock = core.api('kernel').clock;
    const clockSource = ()=>Date.now();

    /**
     * How often the run loop leaves the microtask queue entirely.
     *
     * A whole turn is a hundred thousand guest instructions by default, so this
     * is a handful of milliseconds of guest time -- short enough that a person
     * clicking a button is answered at once, long enough that the loop is not
     * paying for a trip round the event loop on every turn.
     */
    const TURNS_PER_YIELD = 16;

    const breathe = createMacrotask();

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
        // The exception frame, when there is one. Without it the report names
        // the ROM stub the processor is standing in rather than the instruction
        // that faulted, and every register it prints is read from a machine
        // that has already left the scene.
        const trace = captureTrace({ cpu, memory, kernel, bridge, fault: cpu.fault?.() ?? null });
        const text = formatTrace(trace);
        const thrown = error instanceof Error ? error : new Error(String(error));
        Object.assign(thrown, { reason, trace, traceText: text });
        return events.emit('error', { reason, error: thrown, trace, text }) ?? thrown;
    };

    /**
     * Ends the run because a child is to take this process's place.
     *
     * Reached from the two places a parent can be finished: it exited, or it is
     * waiting on a handle only the replacement could ever signal. Nothing is
     * torn down here -- `run` returns and the caller above rebuilds, which is
     * the one place in the engine that owns a process lifecycle.
     *
     * @param {any} request
     */
    const handOver = request=>{
        events.emit('process-replace', {
            image: request.imagePath,
            commandLine: request.commandLine,
            patches: request.patches.length,
        });
        if (options.refuseReplacement)
        {
            throw fail('process-replacement-refused', new Error(
                `refusing to replace this process with ${request.imagePath}`));
        }
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
            // How many turns in a row have retired nothing. This is what tells
            // a machine waiting on its own next instruction from one waiting on
            // the host, which are the same shape from here and want opposite
            // waits.
            let spun = 0;
            for (let turn = 0; turn < maxTurns; turn++)
            {
                if (paused)
                {
                    await paused.gate;
                }

                // A turn is a phase, and everything inside it is a phase of its
                // own. Not decoration: a region nobody opened a phase around
                // measures nothing, so unaccounted time reads as no cost at all
                // and the largest item in a run can be the one item nobody
                // bracketed. `turn` is what the rest is checked against -- the
                // sum of its occurrences is the run -- and its own self time is
                // the loop's overhead and nothing else.
                journal.begin('turn', journal.PhaseKind.HOST);
                try
                {
                    // One yield per turn, so a host function suspended on a
                    // guest callback can make progress between them. Without it
                    // the loop never returns to the event loop on its normal
                    // path and such a handler would be resumed exactly never.
                    //
                    // Bracketed because that handler runs here: whatever a
                    // resumed host call then does is this turn's cost, and it is
                    // charged to nothing if nobody opened a phase around it.
                    journal.begin('microtasks', journal.PhaseKind.HOST);
                    await Promise.resolve();
                    journal.end('microtasks');

                    // And a real one now and then, because that one is a
                    // microtask and microtasks do not let anything else happen.
                    // A program running hot never leaves the microtask queue, so
                    // nothing outside gets a turn: a click on a pause button is
                    // not delivered, a timer does not fire, and a page looks hung
                    // while the guest is working perfectly. Every few turns is
                    // enough to keep the outside responsive and rare enough that
                    // the cost of going round the event loop does not show.
                    if (turn % TURNS_PER_YIELD === 0)
                    {
                        journal.begin('yield', journal.PhaseKind.HOST);
                        await breathe();
                        journal.end('yield');
                    }

                    // Sound is written ahead here rather than on demand: the
                    // device reads on a thread of its own and must never find the
                    // ring empty because the emulator was inside a long
                    // instruction.
                    journal.begin('pump', journal.PhaseKind.HOST);
                    sound?.pump();
                    journal.end('pump');

                    // And devices that keep a cursor are moved on, whether or not
                    // the guest asked anything. A program is entitled to hand a
                    // buffer to a device and then spin on the flag the device sets
                    // in it -- the flag is the contract, and a real device honours
                    // it from its own clock. A cursor advanced only when the guest
                    // calls in is a cursor that never advances for such a program,
                    // and the spin is then forever: the machine is running, the
                    // clock is running, and the one thing that would end it is
                    // waiting for a call that will not come.
                    journal.begin('waveTick', journal.PhaseKind.HOST);
                    win32.waveTick?.();
                    journal.end('waveTick');

                    // And a turn is also when anything waiting for something to
                    // arrive -- a message loop with an empty queue -- gets to look
                    // again. Taken as a batch: a waiter that goes back to waiting
                    // must not be released twice by its own turn.
                    if (idlers.length > 0)
                    {
                        journal.begin('idlers', journal.PhaseKind.HOST);
                        const waiting = idlers;
                        idlers = [];
                        for (const release of waiting)
                        {
                            release();
                        }
                        await Promise.resolve();
                        journal.end('idlers');
                    }

                    // Still waiting after being let look, or a host call
                    // suspended on something outside the microtask queue -- a
                    // fetch, a file read -- means the machine has nothing to do
                    // until the host gets a turn. A microtask does not give it
                    // one, so this is the one place the loop hands it back.
                    //
                    // Through the unclamped yield while the guest is still
                    // getting work done, and on a timer once it has stopped.
                    // A program sitting in its own message loop takes this
                    // branch on most turns while running perfectly well, and a
                    // zero timeout is clamped to four milliseconds and more once
                    // they nest -- so this branch, the one for a machine with
                    // nothing to do, was the largest cost in a run by far,
                    // bigger than every host call and all the emulation
                    // together. The timer is kept for the case it is right for,
                    // which is a machine that really can do nothing until the
                    // host answers.
                    const wait = idleWait({
                        fetching,
                        idlers: idlers.length,
                        suspended: bridge.suspended(),
                        spun,
                    });
                    if (wait)
                    {
                        journal.begin(wait.phase, journal.PhaseKind.HOST);
                        const idledAt = clockSource();
                        // Whichever comes first: the range request answering,
                        // or the timer coming round again.
                        //
                        // Not the request alone, however much cheaper that
                        // reads. A thread waiting on the network is not the
                        // only thread there is, and waiting for the answer
                        // stops the machine for the whole of a request that can
                        // take four seconds -- measured at two and a half times
                        // the wall clock of looking again and finding work.
                        const timer = wait.timer
                            ? new Promise(resolve=>setTimeout(resolve, 0))
                            : breathe();
                        await (fetched && wait.timer
                            ? Promise.race([fetched, timer])
                            : timer);
                        // This time passed for the guest too, and it is the only
                        // time nothing credits. A thread suspended on a host call
                        // is parked on `hlt` and still counts as runnable, so the
                        // scheduler never reaches the branch that moves the clock
                        // to the next deadline -- and the clock is otherwise
                        // credited only for turns the guest actually ran. A
                        // machine that idles for most of its wall time then holds
                        // its own clock nearly still, and every timed wait in the
                        // guest waits far longer than it asked for: a sleep, a
                        // timeout, a WM_TIMER, a wave cursor. The wait that would
                        // end the idling is itself the thing the idling stops
                        // from expiring.
                        clock.advance(Math.max(0, clockSource() - idledAt));
                        journal.end(wait.phase);
                    }

                    // What the machine's state says before it is given another
                    // slice: a failed host call, a pending replacement, an exit,
                    // a fault. Each is a call across a layer boundary and there
                    // are four of them per turn, so they are worth a phase of
                    // their own rather than an unmeasured constant.
                    journal.begin('poll', journal.PhaseKind.HOST);
                    const failure = bridge.failure();
                    const replacing = kernel.processes.pending();
                    const code = win32.exitCode();
                    const fault = cpu.fault();
                    journal.end('poll');

                    if (failure)
                    {
                        throw fail('host-call', failure);
                    }

                    if (code !== null)
                    {
                        // A parent that exits after starting a child has handed
                        // over; it has not finished. Saying so as an exit would
                        // report the launcher's code as the program's.
                        if (replacing)
                        {
                            handOver(replacing);
                            return code;
                        }
                        events.emit('exit', { code });
                        return code;
                    }

                    // A processor exception stops the machine rather than raising
                    // anything: the report cannot be thrown from where it is
                    // noticed, so it is left here to be found. Checked before the
                    // next turn, because from outside a halted processor and a
                    // program that finished look exactly alike.
                    if (fault)
                    {
                        const error = new Error(fault.text);
                        Object.assign(error, { code: 'GUEST_FAULT', fault });
                        throw fail('guest-fault', error);
                    }

                    let step;
                    const startedAt = clockSource();
                    try
                    {
                        // The one measurement that separates emulation from our
                        // own code. Host calls trap out from inside this and open
                        // their own phase, so what is left as this phase's self
                        // time is the guest actually executing -- which is the
                        // number every question about speed starts from.
                        journal.begin('guest', journal.PhaseKind.GUEST);
                        step = kernel.runOnce();
                        // Where the guest stood when its slice ran out. Sampled
                        // here because this is the only boundary the host owns: a
                        // program that decides something inside its own code makes
                        // no call to record, and the instruction pointer is the
                        // only thing that says which code that was.
                        if (options.sample && step.ran)
                        {
                            options.sample(cpu.eip());
                        }
                    }
                    catch (e){
                        // A fault inside the guest, or inside a host function
                        // answering it. Either way the program cannot be told, and
                        // the state that explains it is about to be lost.
                        journal.end('guest');
                        throw fail('guest', e);
                    }
                    journal.end('guest');

                    spun = step.instructions === 0 ? spun + 1 : 0;

                    // The guest ran for real, so its clock moves. Nothing else in
                    // the engine does this, and without it the clock only ever
                    // advanced when a program waited -- so a program that does not
                    // wait sees no time pass at all. That is not a small error: a
                    // frame loop concludes its frame took no time, a timed wait
                    // never expires, and a device whose cursor runs on the clock
                    // never finishes a buffer, which strands a program spinning on
                    // the flag that buffer would have set.
                    //
                    // Credited from the host's wall clock rather than from retired
                    // instructions, because what a program is measuring is how long
                    // its own work took, and on a machine this slow that really is
                    // the wall time. A slow machine is a slow machine; a machine
                    // where no time passes is a broken one.
                    clock.advance(Math.max(0, clockSource() - startedAt));

                    if (!step.ran)
                    {
                        // Nobody is ready. When a child is waiting to be started
                        // that is not a deadlock but the handover: the parent's
                        // last thread has ended, or it is blocked on the child's
                        // own handle, which nothing in this process can signal.
                        if (replacing)
                        {
                            handOver(replacing);
                            return 0;
                        }
                        // Either everything finished without the program exiting,
                        // or every thread is waiting on something no one will
                        // signal -- and the diagnostics name what.
                        const waiting = kernel.diagnosticsSnapshot().waiting;
                        if (waiting.length > 0)
                        {
                            throw fail('deadlock',
                                new Error(`deadlock: ${waiting.join('; ')}`));
                        }
                        throw fail('no-threads',
                            new Error('every thread ended without the process exiting'));
                    }
                }
                finally
                {
                    journal.end('turn');
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

        /**
         * The journal: everything the engine reported, in one ordered stream.
         *
         * Every event the engine emits is written here as it happens, under its
         * own name as the category, so a reader that wants the whole story does
         * not have to know the names in advance and subscribe to each. That is
         * the point of it: a program's behaviour is the interleaving, and three
         * separate views of three kinds of event cannot be interleaved after
         * the fact.
         *
         * `drain(since, limit)` reads forward and says where to resume, which
         * is what a live view polls with; `recent(count)` reads the tail
         * without moving anything, which is what a snapshot of a failure wants.
         * `setLevel` decides how much is kept, per category.
         */
        log: {
            /** @param {number} [since] @param {number} [limit] */
            drain: (since, limit)=>core.api('log').drain(since, limit),
            /** @param {number} [count] */
            recent: count=>core.api('log').recent(count),
            /** @param {string} category @param {string | number} level */
            setLevel: (category, level)=>core.api('log').setLevel(category, level),
            /** @param {string | number} level */
            setDefaultLevel: level=>core.api('log').setDefaultLevel(level),
            /**
             * The areas a host call can be filed under, for a reader offering a
             * filter. Named here rather than discovered from what has been
             * logged, so a filter can offer an area before anything in it has
             * happened.
             */
            areas: ()=>['cpu', 'gpu', 'audio', 'video', 'input', 'net', 'com']
                .map(area=>`call.${area}`),
        },

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

        /**
         * Input, which a program reads two ways at once: `attach` listens to
         * the viewport the game draws into and turns what happens there into
         * both a window message and a change of DirectInput state.
         *
         * `send` is the same road without a browser on it, for a test or a
         * recorded session; `poll` reads what has no events of its own -- a
         * gamepad -- and belongs on whatever already runs once a frame, since
         * a scheduler turn is far too often to ask.
         */
        input: {
            /** @param {any} canvas @param {{ pointerLock?: boolean }} [inputOptions] */
            attach: (canvas, inputOptions)=>input.attach(canvas, inputOptions),
            detach: ()=>input.detach(),
            /** @param {any} event */
            send: event=>input.send(event),
            poll: ()=>input.poll(),
        },

        /**
         * A window on the running machine, for a tool that has to look at it.
         *
         * Deliberately narrow and read-only: what a diagnostic needs is to see
         * what a program was given, and everything else it might ask for is
         * already an event or a diagnostics counter.
         */
        debug: {
            /** @param {number} address @param {number} length */
            read: (address, length)=>memory.readBytes(address >>> 0, length),
            /** @param {string} name */
            register: name=>cpu.readReg32(name),
            eip: ()=>cpu.eip(),
        },

        /**
         * The sound this process is making, for whoever is playing it.
         *
         * `ring.memory` is what goes to an audio worklet: it is shared memory,
         * so the two sides never wait for each other. `pump` fills it and is
         * called once a scheduler turn by `run` below.
         */
        audio: {
            ring: ()=>core.api('audio').output().ring,
            format: ()=>{
                const mixer = core.api('audio').output();
                return { sampleRate: mixer.sampleRate, channels: mixer.channels };
            },
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

        /**
         * The child that is to take this process's place, once `run` has
         * returned. Null while the program is still its own.
         */
        replacement: ()=>kernel.processes.pending(),

        /**
         * A file off this process's volume, waited for if it is not here yet.
         * How the caller reads a child's image before this process -- and the
         * volume with it -- is torn down.
         *
         * @param {string} path
         */
        readImage: path=>readWholeFile(filesystem, blocks, path),

        diagnostics: ()=>[
            ...core.diagnostics(),
            {
                name: 'app',
                version: '0.1.0',
                status: 'ready',
                metrics: {
                    ...events.diagnostics(),
                    bundle: { ...bundleReads, distinct: blocksSeen.size },
                },
            },
        ],

        /**
         * Where the machine is standing, right now, asked from outside.
         *
         * The same report a failure carries, except that nothing has failed. A
         * run that stops without stopping -- a call that never answers, a
         * window procedure that never returns -- produces no error to attach a
         * trace to, and the call log is no help either: a call is written when
         * it returns, so the one holding everything is the one call absent from
         * it. This is the only way to see it.
         *
         * @returns {string}
         */
        trace: ()=>formatTrace(captureTrace({ cpu, memory, kernel, bridge })),
        dispose(){
            // Before the graph goes: the background filler would otherwise go
            // on asking for blocks nobody can put anywhere.
            blocks?.stop();
            breathe.close();
            return core.dispose();
        },
    };
}

/**
 * How many replacement requests are remembered.
 *
 * The ring exists because a replacement erases its own evidence: the machine it
 * was asked for in is gone, and every log and counter in it with it. A launcher
 * that re-execs in a loop would otherwise leave nothing but its last iteration.
 */
const REPLACEMENT_HISTORY = 16;

/**
 * createApp — the consumer-facing entry point.
 *
 * One machine, one program at a time, and a process lifecycle over the top:
 * when the program starts a child and then has nothing left to do, the machine
 * is torn down and rebuilt on the child's image. That is what a child process
 * is here. A parent that genuinely runs alongside its child is not covered, and
 * the honest answer for a title that needs one is a second machine rather than
 * a second process inside this one.
 *
 * @param {AppOptions} options
 * @returns {Promise<any>} an AppController
 */
export async function createApp(options){
    // Both outlive every process: subscriptions a caller made before the first
    // child existed still have to fire for the last one, and the record of what
    // asked for a replacement is worthless if it dies with the asker.
    const events = createEvents();
    /** @type {any[]} */
    const requested = [];

    /** @param {any} request */
    const remember = request=>{
        requested.push(request);
        if (requested.length > REPLACEMENT_HISTORY)
        {
            requested.shift();
        }
    };

    /** @type {any} */
    let current = await buildApp({ ...options, events, spawned: remember });

    /** What a caller holds. Rebound to the live process on every replacement. */
    const facade = /** @type {any} */ ({});

    const own = {
        /**
         * Runs the program, and whatever replaces it, to completion.
         *
         * @param {Object} [runOptions]
         * @param {number} [runOptions.maxTurns]
         * @returns {Promise<number>} the last program's exit code
         */
        async run(runOptions){
            while (true)
            {
                const code = await current.run(runOptions);
                const request = current.replacement();
                if (!request)
                {
                    return code;
                }

                // Read before the tear-down, because the volume it comes off
                // belongs to the process being torn down. So does everything
                // that process wrote: an extractor that unpacked its payload
                // and then started it has to hand that payload across, or the
                // child is launched against files that no longer exist.
                const child = await current.readImage(request.imagePath);
                const carried = current.session.export();
                await current.dispose();

                if (!child)
                {
                    throw new Error(
                        `cannot start ${request.imagePath}: it is not on the volume`);
                }

                current = await buildApp({
                    ...options,
                    events,
                    spawned: remember,
                    executable: child,
                    imagePath: request.imagePath,
                    commandLine: request.commandLine,
                    patches: request.patches,
                    seed: carried,
                });
                Object.assign(facade, current, own);
            }
        },

        dispose: ()=>current.dispose(),

        /**
         * The last few replacement requests, each with the guest's stack at the
         * call that made it -- kept out here so that honouring one does not
         * take the record of it away.
         */
        replacements: ()=>[...requested],
    };

    Object.assign(facade, current, own);
    return facade;
}
