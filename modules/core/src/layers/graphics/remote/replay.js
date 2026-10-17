/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A Direct3D device's calls replayed on a second device of the same build.
 *
 * The device the program talks to keeps its model and answers every call, with
 * no renderer behind it: its state, its return codes, the guest pointers its
 * locks hand out. Every call the program makes on it and on the objects it
 * hands out is recorded (`wire.js`) -- the method, the arguments with the
 * device's objects by number, the guest memory each allocation in the call
 * gave, and after an unlock the bytes the lock let the program write -- and
 * played, in the same order, on a device made with the renderer, wherever
 * that one lives. The two take the same calls, so they hold the same state,
 * and the renderer behind the second draws what the first was told to; the
 * guest memory the second reads is the bytes that were sent to it, as they
 * were when they were sent.
 *
 * What only the renderer can answer -- what a device's diagnostics say, when
 * its frames are done -- is asked of the second device (`answered`).
 */

import { OP, SECTION, SERVICE_REF, WAIT, createReader, createSite } from './wire.js';
import { changedSpans, createCompared, writtenSpans } from '../webgpu/internal/changed.js';

/**
 * The calls whose answer the played device holds back while it has too many
 * frames in flight, and the caller with it.
 */
const PACED = new Set(['Present']);

/**
 * Getters that answer with plain values from state the recording device holds
 * as the played one does, and hand out no object and take no reference: made
 * on the recording device alone, not sent. A getter that hands out an object
 * stays recorded, for the reference it takes on the played side too.
 */
const PURE_GETTERS = new Set([
    'GetRenderState', 'GetTransform', 'GetTextureStageState', 'GetSamplerState',
    'GetViewport', 'GetMaterial', 'GetLight', 'GetLightEnable', 'GetClipPlane',
    'GetClipStatus', 'GetScissorRect', 'GetNPatchMode', 'GetFVF',
    'GetSoftwareVertexProcessing', 'GetStreamSourceFreq', 'GetCurrentTexturePalette',
    'GetPaletteEntries', 'GetVertexShaderConstant', 'GetVertexShaderConstantF',
    'GetVertexShaderConstantI', 'GetVertexShaderConstantB', 'GetPixelShaderConstant',
    'GetPixelShaderConstantF', 'GetPixelShaderConstantI', 'GetPixelShaderConstantB',
    'GetDesc', 'GetLevelDesc', 'GetLevelCount', 'GetLOD', 'GetPriority', 'GetType',
    'GetAvailableTextureMem', 'GetCreationParameters', 'GetNumberOfSwapChains',
    'GetPresentParameters', 'GetGammaRamp',
    // Not Direct3D's: what the shadow block's routines check a call against,
    // read back after every entry of the host's -- 222 thousand sends in four
    // minutes of one title, each played for nothing -- and a pause the host's
    // entry runs its calls in.
    'ringState', 'whileStill',
]);

/**
 * Whether a method may hand out one of the device's objects through a
 * structure it is given -- what makes one, gets one or asks for one -- so
 * that the structures are looked through after it. Both sides ask this.
 *
 * @param {string} name
 */
function handsOut(name){
    return name.startsWith('Create') || name.startsWith('Get') || name.startsWith('Query')
        || name === 'EndStateBlock';
}

/** The calls that hand out one of a texture's levels as an object of its own. */
const LEVELS = new Set(['GetSurfaceLevel', 'GetCubeMapSurface', 'GetVolumeLevel']);

/** The calls after which the bytes a lock let the program write are sent. */
const UNLOCKS = new Set(['Unlock', 'UnlockRect', 'UnlockCubeRect', 'UnlockBox', 'ReleaseDC']);

/**
 * Whether a call reads no resource's bytes on the played side -- a state set,
 * a lock, a dirty region marked -- so that bytes unlocked before it wait for
 * one that may (`readBy` says which): a renderer takes a texture's bytes at
 * the first draw that samples it after the unlock, not at the unlock, and the
 * program's writes between the two are in what it draws. A buffer's are taken at the unlock,
 * there and here.
 *
 * @param {string} name
 */
function readsNothing(name){
    return (name.startsWith('Set') && name !== 'SetCursorProperties')
        || name.startsWith('Lock') || name.startsWith('Unlock')
        || name === 'BeginScene' || name === 'LightEnable' || name === 'AddRef'
        || name === 'addRef' || name.startsWith('AddDirty');
}

/**
 * Which part of a resource a lock or an unlock names: its leading numbers --
 * a level, a face and a level -- up to the structure the lock answers into.
 * A buffer's unlock names none, and so every lock of it.
 *
 * @param {any[]} args
 */
function partOf(args){
    let end = 0;
    while (end < args.length && typeof args[end] === 'number')
    {
        end++;
    }
    return args.slice(0, end).join(',');
}

/**
 * A lock's address and the bytes from it the program may write, null for the
 * rest of the block it lies in; none for a lock taken to read.
 *
 * @typedef {{ address: number, length: number | null, readOnly?: boolean }} Locked
 */

/**
 * What was last sent of a dynamic buffer a draw read: its address then and
 * its length, the watch over its writes since, null where the engine has
 * none, the pages written that have not been sent whole since, and -- only
 * without a watch, to compare against -- its bytes as sent.
 *
 * @typedef {{ base: number, length: number, bytes: Uint8Array | null,
 *     watch: { take: (address: number, length: number) => number[] } | null,
 *     dirty: Set<number> }} Sent
 */

/**
 * Direct3D 9's copies whose first argument is the surface or texture they
 * read: what they carry of it is the rows they wrote, not what was unlocked
 * of it.
 */
const MOVES_OUT_OF = new Set(['UpdateTexture', 'UpdateSurface']);

/** D3DPOOL_SYSTEMMEM, the same number in both versions of the API. */
const D3DPOOL_SYSTEMMEM = 2;

/** D3DLOCK_READONLY, the same number in both versions of the API. */
const LOCK_READ_ONLY = 0x10;

/** D3DLOCK_NOOVERWRITE and DISCARD, the same in both versions too. */
const D3DLOCK_NOOVERWRITE = 0x1000;
/** D3DQUERYTYPE_OCCLUSION. */
const D3DQUERYTYPE_OCCLUSION = 9;
/** What GetData answers while the count is not back. */
const S_FALSE = 1;
/** D3DISSUE_END: the flag that closes a measurement. */
const D3DISSUE_END = 1;
/** How many batches the played side goes without a present before it looks at its objects at zero. */
const SWEEP_BATCHES = 64;
/**
 * How many objects at a count of zero one look takes up, the next going on
 * where it stopped: a texture's levels sit there for as long as the texture
 * lives, and a program holding thousands had the worker look at every one,
 * every frame, while the queries behind them waited -- 21 ms a frame.
 */
export const SWEEP_SLICE = 512;
const D3DLOCK_DISCARD = 0x2000;

/**
 * Whether a lock was taken to read only: its flags are its last argument, in
 * every lock of both versions.
 *
 * @param {any[]} args
 */
const readOnlyLock = args=>{
    const flags = args[args.length - 1];
    return typeof flags === 'number' && (flags & LOCK_READ_ONLY) !== 0;
};

/**
 * How many bytes from the address a lock handed out it covers, where its
 * arguments say: a buffer's size (zero is the rest of the buffer), or a
 * rectangle's rows at the pitch the lock answered with. Null where they do
 * not -- a whole level, a box -- and the rest of the block is taken.
 *
 * @param {string} name @param {any[]} args @param {any} out  the structure the lock answered into
 * @returns {number | null}
 */
function lockedLength(name, args, out){
    // A buffer's lock -- Direct3D 8's and 9's, or Direct3D 7's of a range --
    // names its size second.
    if ((name === 'Lock' || name === 'LockRange') && typeof args[1] === 'number')
    {
        return args[1] > 0 ? args[1] : null;
    }
    if (name.startsWith('LockRect') && typeof out.Pitch === 'number' && out.Pitch > 0)
    {
        const rect = args.find(arg=>arg !== null && typeof arg === 'object'
            && typeof arg.top === 'number' && typeof arg.bottom === 'number');
        return rect ? Math.max(0, rect.bottom - rect.top) * out.Pitch : null;
    }
    return null;
}

/**
 * The call a recording sends for a reference taken or given back: the count
 * the object was left with (`countTo` in `createRecording`).
 */
const REFS_TO = '#refsTo';

/**
 * Takes or gives back references on a played object until its count is the
 * recorded one's, through its own AddRef and Release, so that a crossing of
 * zero does here what it did there.
 *
 * @param {any} target @param {number} count
 */
function refsTo(target, count){
    for (let guard = 0; target.refCount < count && guard < 0x10000; guard++)
    {
        target.addRef();
    }
    for (let guard = 0; target.refCount > count && guard < 0x10000; guard++)
    {
        target.release();
    }
    return count;
}

/** No arguments to look through. */
const NOTHING = /** @type {readonly unknown[]} */ (Object.freeze([]));

/** The objects found to be a device's: one never stops being one. @type {WeakSet<object>} */
const DEVICE_OBJECTS = new WeakSet();

/**
 * Objects of another model a recording names by number without wrapping
 * them -- a DirectDraw surface a Direct3D 7 device draws into -- which the
 * caller hands back as it got them. @type {WeakSet<object>}
 */
const ADOPTED = new WeakSet();

/**
 * Whether a value is one of a device's objects -- the device, a resource, a
 * swap chain: an object with methods. Descriptors, structures and the objects
 * a call writes its answers into have none.
 *
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isDeviceObject(value){
    if (value === null || typeof value !== 'object' || Array.isArray(value)
        || ArrayBuffer.isView(value) || value instanceof Promise)
    {
        return false;
    }
    if (ADOPTED.has(value))
    {
        return false;
    }
    if (DEVICE_OBJECTS.has(value))
    {
        return true;
    }
    // Asked of the same few objects on every call, each with a hundred
    // methods: a walk that stops at the first, and once known, never again.
    for (const key in value)
    {
        if (typeof /** @type {any} */ (value)[key] === 'function')
        {
            DEVICE_OBJECTS.add(value);
            return true;
        }
    }
    return false;
}

/**
 * Numbers every device object a call's answer or arguments reached, in one
 * order on both sides: the answer, then each argument, each with its own
 * members -- where a call puts what it makes, an out-structure's member --
 * and no deeper.
 *
 * @param {unknown} result @param {readonly unknown[]} args
 * @param {(object: Record<string, any>) => void} bind  numbers one not yet numbered
 */
function bindAll(result, args, bind){
    visit(result, bind);
    for (let index = 0; index < args.length; index++)
    {
        visit(args[index], bind);
    }
}

/**
 * @param {unknown} value
 * @param {(object: Record<string, any>) => void} bind
 */
function visit(value, bind){
    if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)
        || value instanceof Promise)
    {
        return;
    }
    if (isDeviceObject(value))
    {
        bind(value);
        return;
    }
    if (Array.isArray(value))
    {
        for (let index = 0; index < value.length; index++)
        {
            if (isDeviceObject(value[index]))
            {
                bind(value[index]);
            }
        }
        return;
    }
    for (const key in value)
    {
        const member = /** @type {any} */ (value)[key];
        if (isDeviceObject(member))
        {
            bind(member);
        }
    }
}

/**
 * What a played call answers a call the caller waits for: its answer, and the
 * structures it was given as the call left them.
 *
 * @typedef {Object} PlayedAnswer
 * @property {any} answer
 * @property {any[]} outs
 * @property {OcclusionCount[]} [counts]  beside an occlusion query's answer,
 *     the other occlusion counts the played side already holds
 */

/**
 * An occlusion query's count the played side holds: the query's number, how
 * many ENDs it has played on it -- the measurement the count is of -- and
 * the count.
 *
 * @typedef {[number, number, number]} OcclusionCount
 */

/**
 * Where a recording writes its calls, and what it is told of each: the
 * writer's end of `wire.js`, and the carrier that takes what is written.
 *
 * @typedef {Object} Transport
 * @property {ReturnType<typeof import('./wire.js').createWriter>} writer
 * @property {(wait: number, name: string) => any} called
 *     the call just written is whole but for how it is waited for, which this
 *     writes: what it gives back is a waited call's `PlayedAnswer` (or a
 *     promise of one), and for a paced call a promise when the caller is held
 * @property {() => void} recorded  a record that is not a call was written
 * @property {(kind: ShippedKind, bytes: number) => void} [shipped]
 *     bytes of guest memory just copied into the record, by what copied them
 * @property {(ms: number, polls: number, asks: number, beside: boolean, sentAfter: number,
 *     trip: number, events: OcclusionEvent[]) => void} [counted]
 *     an occlusion query was answered: this long after its END was issued, after
 *     this many polls of the program's and asks of the played side; `beside`
 *     when its count came with another query's answer; `sentAfter` how long
 *     after the END the ask that brought the count went, `trip` how long it took;
 *     `events` what happened to the measurement, in order
 * @property {(listener: (counts: OcclusionCount[]) => void) => void} [hearCounts]
 *     the listener is told the occlusion counts the played side sends unasked
 * @property {(name: string, bytes: number) => void} [recordedCall]
 *     a call's record is whole, this many bytes of the batch, copies included
 * @property {import('./lending.js').Lender | null} [lender]
 *     where the played side reads guest memory in place: what an unlock let
 *     the program write is lent rather than copied
 */

/**
 * What copied guest bytes into a record: a buffer's unlock, a texture's or a
 * surface's (a lent one is the lender's to count), what a call read out of
 * the program's memory, what one wrote into it here, or what a draw reads of
 * a dynamic buffer that the program wrote after its unlock.
 *
 * @typedef {'buffers' | 'surfaces' | 'reads' | 'writes' | 'dynamic' | 'compared'} ShippedKind
 */

/**
 * One thing that happened to an occlusion measurement on the recording side:
 * what, when on the clock every thread shares (`performance.timeOrigin` plus
 * `now`), and how many polls the program had made by then -- 'end', 'poll'
 * (the first), 'ask', 'came' (with the played side's answer), 'beside' (its
 * count come with another's), 'told'.
 *
 * @typedef {[kind: string, at: number, polls: number, answer?: number]} OcclusionEvent
 */

/** The time on the clock every thread shares. */
const sharedNow = ()=>performance.timeOrigin + performance.now();

/**
 * The recording side: a proxy of the root object the program is given, whose
 * every call -- and every call on what it hands out -- is made on the root and
 * recorded.
 *
 * @param {Object} options
 * @param {Record<string, any>} options.root
 *     the device's root (`IDirect3D9`), made with no renderer behind it
 * @param {(moves: any[]) => void} [options.applyMoves]
 *     makes the copies a call describes in guest memory, as the caller would
 *     have: for a copy back the program is answered before it is made
 * @param {(address: number, length: number) => Uint8Array} options.readMemory
 *     the guest memory the locked bytes are read from
 * @param {(address: number, length: number) => Uint8Array} [options.windowMemory]
 *     the same bytes in place, for those copied into the batch before anything
 *     can write them
 * @param {(address: number, length: number) => ({ take: (address: number, length: number)
 *     => number[] } | null)} [options.watchWrites]
 *     a watch over a range, the program's writes and the host's, whose `take`
 *     answers the pages that may differ since its last look; null, or absent,
 *     where the engine cannot say, and every byte is looked at
 * @param {Transport} options.transport
 * @param {(target: any, name: string, args: any[]) => boolean} [options.answered]
 *     whether a call's answer is the other side's: what only its renderer
 *     knows, which the recorded device has no say in. It is given the
 *     device's own objects, so what it asks of them is not recorded.
 * @param {ReadonlySet<string>} [options.answers]  the only methods `answered` is asked about
 * @param {(target: any, name: string, args: any[]) => void} [options.observe]
 *     told every call the recorded device has made, with its own objects, before
 *     `answered` is asked: what the call changed, for a question asked later
 * @returns {{ root: any, allocated: (address: number, bytes: number) => void,
 *     freed: (address: number) => void,
 *     writing: (address: number, length: number) => void,
 *     settled: () => Promise<void> | null,
 *     wrote: (address: number, bytes: Uint8Array) => void,
 *     read: (address: number, bytes: Uint8Array) => void, outward: (value: any) => any,
 *     drawsFrom: (buffer: any, from: number, to: number) => void,
 *     still: <T>(work: () => T) => T,
 *     adopt: (object: object) => void }}
 *     `allocated` and `freed` are told every allocation the recorded device
 *     makes and gives back, `writing` every write it is about to make into guest
 *     memory and `wrote` every one it made; `settled` is when every answer
 *     asked for so far has come, null when none is outstanding;
 *     and `read` -- by a device that reads the program's memory at the call
 *     rather than through its locks -- every read, whose bytes the played
 *     device is sent ahead of the call; `drawsFrom` the bytes of a dynamic
 *     buffer a draw reads, of which what the program wrote since they were
 *     last sent goes ahead of the call; `still` runs `work` as one pause of the
 *     program's, in which a range compared by one call is not compared by the next;
 *     `outward` is a value of the device's
 *     as the caller is given it; `adopt` numbers an object of another model,
 *     unwrapped, as the next the played side binds -- what the call just
 *     recorded answered there
 */
export function createRecording(options){
    const { root, readMemory, transport, answered = ()=>false, answers = new Set(),
        observe = null, applyMoves = null, watchWrites = null } = options;
    const windowMemory = options.windowMemory ?? readMemory;
    const { writer } = transport;
    const lender = transport.lender ?? null;
    /**
     * The answers asked for and not yet come: the played side writes what it
     * read back into guest memory ahead of each, at addresses the recorded
     * device gave out when it was asked.
     *
     * @type {Set<Promise<unknown>>}
     */
    const unanswered = new Set();
    /** @param {string} name */
    const ask = name=>{
        const reply = transport.called(WAIT.ANSWER, name);
        if (reply instanceof Promise)
        {
            unanswered.add(reply);
            const done = ()=>unanswered.delete(reply);
            reply.then(done, done);
        }
        return reply;
    };
    /** @param {ShippedKind} kind @param {{ bytes: Uint8Array }[]} ranges */
    const shippedAs = (kind, ranges)=>{
        if (transport.shipped && ranges.length > 0)
        {
            transport.shipped(kind, ranges.reduce((sum, range)=>sum + range.bytes.length, 0));
        }
    };
    /** @type {WeakMap<object, number>} */
    const numbers = new WeakMap([[root, 0]]);
    let next = 1;
    /** @type {WeakMap<object, any>} */
    const proxies = new WeakMap();
    /** @type {WeakMap<object, object>} */
    const raws = new WeakMap();
    /**
     * The guest address each lock of an object handed out and that is not
     * yet unlocked, by the part of it the lock named, with the bytes from it
     * the lock covers where its arguments say -- null for the rest of the
     * block it lies in.
     *
     * @type {WeakMap<object, Map<string, Locked>>}
     */
    const lockedAt = new WeakMap();
    /**
     * A texture's levels handed out as surfaces or volumes, by the part a
     * lock on the texture names: a level is one lock, whichever of the two
     * takes it and whichever gives it back.
     *
     * @type {WeakMap<object, Map<string, object>>}
     */
    const levelsOf = new WeakMap();
    /** And the other way: the texture a level, a face or a volume is part of. @type {WeakMap<object, object>} */
    const containerOf = new WeakMap();
    /** The stand-ins of the caller's services, passed where the services were. @type {WeakSet<object>} */
    const services = new WeakSet();
    /** The functions the caller put on the device's objects, its own. @type {WeakMap<object, Set<string>>} */
    const owned = new WeakMap();
    /** The allocations held, by address, for the extent of a locked block. */
    const blocks = { starts: /** @type {number[]} */ ([]), ends: /** @type {number[]} */ ([]) };
    /** The current call's allocations. @type {number[] | null} */
    let allocs = null;
    /** What the current call wrote into guest memory. @type {{ address: number, bytes: Uint8Array }[] | null} */
    let writes = null;
    /** What the current call read of guest memory. @type {{ address: number, bytes: Uint8Array }[] | null} */
    let reads = null;
    /** How deep in calls the program is: a call the device makes back through the caller is part of its own. */
    let depth = 0;
    /**
     * The parts of each object (`partOf`) an unlock has sent the bytes of:
     * a part not among them the played side has only as it was made.
     *
     * @type {WeakMap<object, Set<string>>}
     */
    const sentParts = new WeakMap();
    /**
     * What the played side's memory holds of each dynamic buffer a draw has
     * read, by the buffer: it is what was last sent of it, by its unlocks
     * and by draws (`drawsFrom`), and a draw sends only what differs from it.
     *
     * `watch`: the writes to it since (`changedIn`), where the engine says.
     *
     * @type {WeakMap<object, Sent>}
     */
    const sentOf = new WeakMap();
    /** What the current call's draws read of dynamic buffers that had changed. @type {{ address: number, bytes: Uint8Array }[] | null} */
    let drawn = null;
    /**
     * What the current call's draws compared: the program does not run until
     * the call is done -- a run of the command ring among them -- so a range
     * is compared once in it, however many draws read it.
     */
    const compared = createCompared();
    /**
     * How deep in pauses that span several calls (`still`): while in one, the
     * program does not run between the calls either -- a host entry's buffers
     * settled, then its command ring played -- and what one call compared
     * stays compared for the next.
     */
    let still = 0;
    /**
     * Where a buffer's bytes in guest memory differ from what was sent of
     * them, made what is sent: four bytes at a time against the copy on this
     * side, since it runs for every draw from such a buffer. Only where the
     * engine has no write watch to say what was written.
     *
     * @param {{ base: number, bytes: Uint8Array }} sent
     * @param {number} from @param {number} to  in the buffer
     * @param {{ address: number, bytes: Uint8Array }[]} into
     */
    const changedSince = (sent, from, to, into)=>{
        const now = windowMemory(sent.base + from, to - from);
        const spans = changedSpans(now, sent.bytes.subarray(from, to));
        for (let index = 0; index < spans.length; index += 2)
        {
            const start = from + spans[index];
            const end = from + spans[index + 1];
            sent.bytes.set(now.subarray(spans[index], spans[index + 1]), start);
            into.push({ address: sent.base + start, bytes: sent.bytes.subarray(start, end) });
        }
        return into;
    };

    /**
     * What of `[from, to)` the played side may not have: with the engine's
     * write watch, the pages written since they were last sent, as they are
     * -- a write the watch saw is all a comparison could find, and comparing
     * them against a copy of the buffer kept here was most of a skinning
     * game's draws on the engine thread, and the played side compared them
     * again; without one, `changedSince` over the range.
     *
     * @param {Sent} sent
     * @param {number} from @param {number} to  in the buffer
     * @param {{ address: number, bytes: Uint8Array }[]} into
     * @returns {number} the bytes compared
     */
    const changedIn = (sent, from, to, into)=>{
        if (sent.watch === null)
        {
            changedSince(/** @type {{ base: number, bytes: Uint8Array }} */ (sent), from, to,
                into);
            return to - from;
        }
        const spans = writtenSpans(/** @type {any} */ (sent), sent.base, sent.length, from, to);
        for (let index = 0; index < spans.length; index += 2)
        {
            into.push({ address: sent.base + spans[index],
                bytes: windowMemory(sent.base + spans[index], spans[index + 1] - spans[index]) });
        }
        return 0;
    };

    /**
     * Numbers an object, under itself and under its proxy, so that either is
     * found by one look.
     *
     * @param {object} object
     */
    const bind = object=>{
        const own = raws.get(object) ?? object;
        if (!numbers.has(own) && !services.has(own))
        {
            const number = next++;
            numbers.set(own, number);
            const proxy = proxies.get(own);
            if (proxy)
            {
                numbers.set(proxy, number);
            }
        }
    };

    /**
     * What one of the values a call is given is on the wire.
     *
     * @type {import('./wire.js').RefOf}
     */
    const refOf = value=>numbers.get(value) ?? (services.has(value) ? SERVICE_REF : undefined);

    /**
     * An argument as the recorded device takes it: its own objects rather than
     * their proxies, one level into an array.
     *
     * @param {any} value @returns {any}
     */
    const unwrap = value=>{
        const object = raws.get(value);
        if (object)
        {
            return object;
        }
        if (Array.isArray(value) && value.some(one=>raws.has(one)))
        {
            return value.map(one=>raws.get(one) ?? one);
        }
        return value;
    };
    /**
     * After a call: what it wrote into a structure the caller passed, the
     * device's objects in it given as their proxies.
     *
     * @param {any} value
     */
    const wrapInto = value=>{
        if (ArrayBuffer.isView(value) || isDeviceObject(value) || raws.has(value))
        {
            return;
        }
        for (const key in value)
        {
            const member = value[key];
            if (!raws.has(member) && isDeviceObject(member))
            {
                value[key] = proxyOf(member);
            }
        }
    };

    /**
     * The bytes the locks an unlock ends let the program write -- all of the
     * object's locks, when it names no part -- each from the address its lock
     * handed out, for as many bytes as it covered; the object's own bytes when
     * no lock handed any out, as a context over a surface writes them.
     *
     * @param {object} object @param {string} part
     * @returns {Locked[]}
     */
    const lockedRanges = (object, part)=>{
        const locks = lockedAt.get(object);
        /** @type {Locked[]} */
        const ranges = [];
        for (const [named, locked] of locks ?? [])
        {
            if (part === '' || named === part)
            {
                ranges.push(locked);
                locks?.delete(named);
            }
        }
        if (ranges.length === 0)
        {
            for (const [named, level] of levelsOf.get(object) ?? [])
            {
                if (part === '' || named === part)
                {
                    ranges.push(...lockedAt.get(level)?.values() ?? []);
                    lockedAt.delete(level);
                }
            }
        }
        if (ranges.length === 0 && typeof (/** @type {any} */ (object).base) === 'number')
        {
            ranges.push({ address: /** @type {any} */ (object).base, length: null });
        }
        return ranges;
    };

    /**
     * Textures' and surfaces' bytes unlocked and not yet sent, by where they
     * begin, and what each waits on: the texture, for a level's bytes as for
     * its own, or the surface. Sent with the next call that may read them, or
     * that is made on what they belong to.
     */
    const pending = { addresses: /** @type {Map<number, number | null>} */ (new Map()),
        owners: /** @type {Map<number, object>} */ (new Map()) };

    /** What an object's unlocked bytes wait on. @param {object} object */
    const keyOf = object=>containerOf.get(object) ?? object;

    /**
     * Whether bytes waiting on this are a texture's, which the device that
     * draws itself reads at the first draw that samples the texture -- the
     * program's writes up to there are in what it draws -- rather than at the
     * next call that may read anything, as it does a surface's.
     *
     * @param {object} key
     */
    const isTexture = key=>typeof (/** @type {any} */ (key).base) !== 'number';

    /** @param {object} key @returns {(locked: Locked) => void} */
    const pendFor = key=>({ address, length })=>{
        const held = pending.addresses.get(address);
        pending.addresses.set(address, held === undefined ? length
            : held === null || length === null ? null : Math.max(held, length));
        pending.owners.set(address, key);
    };

    /**
     * Which pending bytes a call may read before it answers: a surface's
     * always; a texture's when the call names it, or one of its levels; when
     * it draws, those of the textures bound to the device then; when it is a
     * run of the command ring, those bound before it and those its records
     * name -- all of them when a record applies a state block, whose bindings
     * the run does not name.
     *
     * @param {any} target @param {string} name @param {any[]} args
     * @returns {(key: object) => boolean}
     */
    const readBy = (target, name, args)=>{
        /** @type {Set<object>} */
        const named = new Set([keyOf(target)]);
        let applies = false;
        /** @param {any} value */
        const note = value=>{
            const raw = raws.get(value) ?? value;
            if (raw !== null && typeof raw === 'object')
            {
                named.add(keyOf(raw));
                applies ||= typeof raw.Apply === 'function';
            }
        };
        for (const arg of args)
        {
            if (Array.isArray(arg))
            {
                arg.forEach(note);
            }
            else
            {
                note(arg);
            }
        }
        const run = name === 'commands';
        // A state block applied by its token names nothing either.
        applies ||= run && typeof target.appliesStateBlocks === 'function'
            && args[0] instanceof Uint8Array && target.appliesStateBlocks(args[0]) === true;
        if (!run && !name.startsWith('Draw'))
        {
            return key=>!isTexture(key) || named.has(key);
        }
        const bound = target.boundTextures;
        if (!bound || (run && applies))
        {
            return ()=>true;
        }
        const sampled = new Set(bound);
        return key=>!isTexture(key) || named.has(key) || sampled.has(key);
    };

    /**
     * Whether a resource's bytes live only in system memory, where Direct3D
     * 8 and 9 draw nothing from: a texture or volume texture made so, or a
     * surface or volume whose description says so.
     *
     * @param {any} object
     */
    const inSystemMemory = object=>{
        if (typeof object?.pool === 'number')
        {
            return object.pool === D3DPOOL_SYSTEMMEM;
        }
        if (typeof object?.GetDesc !== 'function')
        {
            return false;
        }
        /** @type {{ desc?: { Pool?: number } }} */
        const out = {};
        object.GetDesc(out);
        return out.desc?.Pool === D3DPOOL_SYSTEMMEM;
    };

    /**
     * The pending bytes a call may read, as a record of their own ahead of
     * it: copied into the batch now, out of the guest's memory in place,
     * before the call can write over them. The rest wait on.
     *
     * @param {(key: object) => boolean} [which]
     */
    const shipPending = (which = ()=>true)=>{
        /** @type {{ address: number, length: number, slot: number }[]} */
        const lent = [];
        /** @type {{ address: number, bytes: Uint8Array }[]} */
        const taken = [];
        for (const [address, length] of pending.addresses)
        {
            if (!which(/** @type {object} */ (pending.owners.get(address))))
            {
                continue;
            }
            pending.addresses.delete(address);
            pending.owners.delete(address);
            const extent = extentOf(address, length);
            const slot = extent > 0 && lender ? lender.lend(address, extent) : -1;
            if (slot >= 0)
            {
                lent.push({ address, length: extent, slot });
            }
            else
            {
                taken.push(...rangeFrom({ address, length }, windowMemory));
            }
        }
        if (lent.length > 0)
        {
            writer.u8(OP.LENT);
            writer.u32(lent.length);
            for (const { address, length, slot } of lent)
            {
                writer.u32(address);
                writer.u32(length);
                writer.u32(slot);
            }
        }
        if (taken.length > 0)
        {
            writer.u8(OP.WROTE);
            writeMemory(taken);
            shippedAs('surfaces', taken);
        }
        if (lent.length > 0 || taken.length > 0)
        {
            transport.recorded();
        }
    };

    /**
     * Before something on this side lets the program, or the device, write a
     * range: a lend of it the played side has not read yet keeps its bytes.
     *
     * @param {number} address @param {number | null} length  null to its block's end
     */
    const claim = (address, length)=>{
        if (lender)
        {
            const extent = extentOf(address, length);
            if (extent > 0)
            {
                lender.claim(address, extent);
            }
        }
    };

    /**
     * What a call let be written that is not a lock's: a surface's bytes a
     * context draws on until it is released, and the copies the caller makes
     * in guest memory after a call that described them.
     *
     * @param {any} target @param {string} name @param {any[]} args
     */
    const claimWritten = (target, name, args)=>{
        if (name === 'GetDC' && typeof target.base === 'number')
        {
            claim(target.base, null);
        }
        for (const arg of args)
        {
            for (const move of Array.isArray(arg?.moves) ? arg.moves : [])
            {
                if (move.rows > 0)
                {
                    claim(move.to, (move.rows - 1) * move.toPitch + move.rowBytes);
                }
            }
        }
    };

    /**
     * How many bytes from an address a range covers: to the end of the
     * allocation it lies in, and never past that; none outside every one.
     *
     * @param {number} address @param {number | null} length
     */
    const extentOf = (address, length)=>{
        const found = blockAt(address);
        if (found < 0)
        {
            return 0;
        }
        const rest = blocks.ends[found] - address;
        return length === null ? rest : Math.min(length, rest);
    };

    /**
     * Where an address's block lies among those held: its index, or -1.
     *
     * @param {number} address
     */
    const blockAt = address=>{
        let lo = 0;
        let hi = blocks.starts.length - 1;
        let found = -1;
        while (lo <= hi)
        {
            const mid = (lo + hi) >> 1;
            if (blocks.starts[mid] <= address)
            {
                found = mid;
                lo = mid + 1;
            }
            else
            {
                hi = mid - 1;
            }
        }
        return found >= 0 && address < blocks.ends[found] ? found : -1;
    };

    /**
     * A locked range's bytes: as many as the lock covered, or from its
     * address to the end of the allocation it lies in, and never past that.
     *
     * @param {Locked} locked
     * @param {(address: number, length: number) => Uint8Array} [read]
     * @returns {{ address: number, bytes: Uint8Array }[]}
     */
    const rangeFrom = ({ address, length }, read = readMemory)=>{
        const extent = extentOf(address, length);
        return extent > 0 ? [{ address, bytes: read(address, extent) }] : [];
    };

    /**
     * A call's answer as the caller is given it: one of the device's objects
     * as its proxy, and a structure holding some as a copy holding theirs --
     * the device's own is left as it is, since it may be its state.
     *
     * @param {any} result
     */
    const answerOf = result=>{
        if (result === null || typeof result !== 'object' || ArrayBuffer.isView(result)
            || result instanceof Promise || Array.isArray(result))
        {
            return result;
        }
        if (isDeviceObject(result))
        {
            return proxyOf(result);
        }
        /** @type {Record<string, any> | null} */
        let copy = null;
        for (const key in result)
        {
            if (isDeviceObject(result[key]))
            {
                /** @type {Record<string, any>} */
                const held = copy ?? { ...result };
                held[key] = proxyOf(result[key]);
                copy = held;
            }
        }
        return copy ?? result;
    };

    /**
     * Each occlusion query's count as the renderer answers it, asked once its
     * end is issued and taken when it comes: a driver answers S_FALSE until the
     * GPU has counted, and a program polls. Waiting for the answer instead held
     * the program for the replay of everything recorded before the ask, every
     * frame -- tens of milliseconds, a quarter of a second at worst.
     *
     * @type {WeakMap<object, { reply: PlayedAnswer | null, beside?: boolean, sentAt?: number,
     *     cameAt?: number }>}
     */
    const counts = new WeakMap();
    /**
     * The ENDs recorded on each occlusion query, and the queries by number: a
     * count the played side sends beside another's answer is taken for a
     * query only if it is of the measurement the program last closed.
     *
     * @type {WeakMap<object, number>}
     */
    const ends = new WeakMap();
    /** @type {Map<number, WeakRef<object>>} */
    const occlusionQueries = new Map();
    /**
     * Each occlusion measurement the program closed and has not been told the
     * count of: when, and how often it has asked since.
     *
     * @type {WeakMap<object, { at: number, polls: number, asks: number,
     *     events: OcclusionEvent[] }>}
     */
    const waiting = new WeakMap();
    const timed = import.meta.BOTTLIFY_DIAGNOSTICS !== false && Boolean(transport.counted);
    /**
     * Counts sent beside an answer, held as answers: a program that waits on
     * its queries one after another -- polling each until it is counted --
     * crossed to the played side and back for every one, where the GPU had
     * counted them all in one read.
     *
     * @param {object | null} asked  the query whose answer they came with, none when sent unasked
     * @param {OcclusionCount[] | undefined} given
     * @param {number} [sentAt] @param {number} [cameAt]  when that ask went and came back
     */
    const takeCounts = (asked, given, sentAt = 0, cameAt = 0)=>{
        for (const [number, ended, value] of given ?? [])
        {
            const query = occlusionQueries.get(number)?.deref();
            if (!query)
            {
                occlusionQueries.delete(number);
                continue;
            }
            if (query === asked || (ends.get(query) ?? 0) !== ended
                || counts.get(query)?.reply)
            {
                continue;
            }
            counts.set(query, { reply: { answer: 0, outs: [{ value }] }, beside: true, sentAt,
                cameAt });
            /** @type {any} */ (query).whenCounted?.(value);
            const measured = timed ? waiting.get(query) : undefined;
            measured?.events.push(['beside', sharedNow(), measured.polls]);
        }
    };

    // The played side sends a count as soon as the GPU has it: asked for at
    // the program's first poll, it came a crossing later, polled thousands of
    // times in between.
    transport.hearCounts?.(given=>{
        const at = timed ? performance.now() : 0;
        takeCounts(null, given, at, at);
    });

    /**
     * The system-memory surfaces a GetRenderTargetData is still filling, each
     * with when it will have: the copy is queued as a driver queues it, and
     * only reading the surface waits for its pixels. Waiting at the copy held
     * the program for every frame the renderer had still to play, a quarter of
     * a second at worst, though it read the pixels frames later.
     *
     * @type {WeakMap<object, Promise<void>>}
     */
    const readbacks = new WeakMap();
    /**
     * Whether a copy into this surface can be answered before it is made:
     * one the recording can wait on later, at whatever reads it.
     *
     * @param {any} surface
     */
    const copiesBack = surface=>surface !== null && typeof surface === 'object';

    /**
     * What a played call wrote into a structure the caller passed, into the
     * caller's: its plain values, the device's objects left as the recorded
     * call gave them.
     *
     * @param {any} into @param {any} from
     */
    const copyOut = (into, from)=>{
        if (into === null || typeof into !== 'object' || from === null || typeof from !== 'object'
            || ArrayBuffer.isView(into) || raws.has(into) || isDeviceObject(into)
            || services.has(into) || ADOPTED.has(into))
        {
            return;
        }
        for (const key of Object.keys(from))
        {
            const value = from[key];
            if (value === null || typeof value !== 'object')
            {
                if (value !== undefined)
                {
                    into[key] = value;
                }
            }
            else if (ArrayBuffer.isView(value))
            {
                into[key] = /** @type {any} */ (value).slice();
            }
            else if (!isDeviceObject(value) && !isDeviceObject(into[key]))
            {
                if (into[key] === null || typeof into[key] !== 'object')
                {
                    into[key] = Array.isArray(value) ? [] : {};
                }
                copyOut(into[key], value);
            }
        }
    };

    /**
     * A service of the caller's as a call is given it: each of its functions
     * the service's own, what it answers kept for the played side.
     *
     * @param {Record<string, any>} service @param {any[]} replies
     */
    const serviceOf = (service, replies)=>{
        /** @type {Record<string, any>} */
        const standIn = {};
        for (const key of Object.keys(service))
        {
            const value = service[key];
            standIn[key] = typeof value === 'function'
                ? (/** @type {any[]} */ ...args)=>{
                    const answer = value.apply(service, args);
                    replies.push(answer);
                    return answer;
                }
                : value;
        }
        services.add(standIn);
        return standIn;
    };

    /**
     * `applied` with the argument at `index` as the device takes it, copied
     * from `args` the first time one differs.
     *
     * @param {any[]} applied @param {any[]} args @param {number} index
     */
    const unwrapInto = (applied, args, index)=>{
        const arg = args[index];
        if (arg === null || typeof arg !== 'object')
        {
            return applied;
        }
        const own = unwrap(arg);
        if (own === arg)
        {
            return applied;
        }
        const copy = applied === args ? args.slice() : applied;
        copy[index] = own;
        return copy;
    };

    /** @param {{ address: number, bytes: Uint8Array }[]} list */
    const writeMemory = list=>{
        writer.u32(list.length);
        for (let index = 0; index < list.length; index++)
        {
            writer.memory(list[index].address, list[index].bytes);
        }
    };

    /** The number `refsTo` has in the writer's table, once it has one. */
    let refsToId = -1;
    const countSite = createSite();
    /**
     * Each method's argument places, shared by every object of one kind: the
     * structures one method is given have one shape whichever buffer it is
     * called on. Kept per object, every buffer a level made defined its
     * shapes anew, and the table of shapes on both sides grew with them.
     *
     * @type {Map<string, import('./wire.js').Site[]>}
     */
    const sitesByMethod = new Map();

    /**
     * A reference taken or given back here, sent as the count it left. The
     * guest takes and gives back references the host never sees -- every one
     * that is not a zero crossing (`bridge/internal/vtable.js`) -- so the
     * played object's count follows them only by being told what this one's
     * is whenever it comes through here; a last Release then ends it there
     * too, however many references the guest took and gave back on the way.
     *
     * @param {object} target @param {number} number @param {Function} method
     * @param {any[]} applied
     */
    const countTo = (target, number, method, applied)=>{
        depth++;
        let result;
        try
        {
            result = method.apply(target, applied);
        }
        finally
        {
            depth--;
        }
        if (refsToId < 0)
        {
            writer.u8(OP.CALL);
            writer.u32(number);
            refsToId = writer.string(REFS_TO);
            writer.u8(1);
        }
        else
        {
            writer.call(number, refsToId, 1);
        }
        writer.value(result >>> 0, refOf, 0, countSite);
        writer.u8(0);
        transport.called(WAIT.NONE, REFS_TO);
        return result;
    };

    /**
     * A method of one of the device's objects as the caller calls it: made on
     * the object, recorded and sent.
     *
     * @param {object} target @param {string} name @param {Function} method
     * @returns {(...args: any[]) => any}
     */
    const methodOf = (target, name, method)=>{
        const unlocking = UNLOCKS.has(name);
        // A buffer's bytes go with its unlock; a texture's or a surface's
        // wait (`readsNothing`).
        const deferring = unlocking && name !== 'Unlock';
        const quiet = readsNothing(name);
        const locking = name.startsWith('Lock');
        const paced = PACED.has(name);
        const mayAnswer = answers.has(name);
        const making = handsOut(name);
        const pure = PURE_GETTERS.has(name);
        const counting = name === 'addRef' || name === 'release';
        /** The method's number in the writer's table, once it has one. */
        let nameId = -1;
        /** @type {number | undefined} */
        let number;
        /** Each argument's place, for the shapes of the structures passed there. */
        const kind = `${name}:${/** @type {any} */ (target).type ?? ''}`;
        const sites = sitesByMethod.get(kind) ?? sitesByMethod.set(kind, []).get(kind)
            ?? [];
        /** @type {(...args: any[]) => any} */
        const call = (...args)=>{
            const count = args.length;
            // A read of a surface a copy back from the GPU is still filling
            // waits for it, then is made: a lock or a DC on it, and a copy out
            // of it or of its texture, which moves the bytes it holds here.
            const filling = name === 'LockRect' || name === 'GetDC' ? readbacks.get(target)
                : name === 'UpdateSurface' || name === 'UpdateTexture' || name === 'CopyRects'
                    ? readbacks.get(unwrap(args[0])) : undefined;
            if (filling)
            {
                return filling.then(()=>call(...args));
            }
            /** What the device is given: its own objects rather than their proxies. */
            let applied = args;
            if (depth > 0 || pure)
            {
                for (let index = 0; index < count; index++)
                {
                    applied = unwrapInto(applied, args, index);
                }
                return method.apply(target, applied);
            }
            // A poll of an occlusion count already asked is answered here and
            // recorded nowhere: the played side has nothing to do with it, and
            // a program polls hundreds of thousands of times a minute.
            const known = name === 'GetData' ? counts.get(target) : undefined;
            const measured = timed && name === 'GetData' ? waiting.get(target) : undefined;
            if (measured)
            {
                if (measured.polls++ === 0)
                {
                    measured.events.push(['poll', sharedNow(), 1]);
                }
            }
            if (known)
            {
                if (!known.reply)
                {
                    return S_FALSE;
                }
                if (measured && known.reply.answer === 0)
                {
                    waiting.delete(target);
                    measured.events.push(['told', sharedNow(), measured.polls]);
                    transport.counted?.(performance.now() - measured.at, measured.polls,
                        measured.asks, known.beside === true,
                        (known.sentAt ?? measured.at) - measured.at,
                        (known.cameAt ?? 0) - (known.sentAt ?? 0), measured.events);
                }
                for (let index = 0; index < count; index++)
                {
                    copyOut(args[index], known.reply.outs[index]);
                }
                return known.reply.answer;
            }
            // Direct3D 9's copy out of a surface or a texture in system memory
            // carries what it moves, not what was unlocked of its source: the
            // recording device makes the copy in guest memory and sends the
            // rows it wrote over the twin's. A game that locks a system-memory
            // volume every frame, marks a few boxes dirty and updates its twin
            // from it sent and stashed the whole volume each frame for the
            // boxes. Direct3D 8's device -- the one with CopyRects -- leaves
            // its copies to the caller, and its twin copies from what it was
            // sent of the source, which goes first as before.
            const raw = MOVES_OUT_OF.has(name) && typeof (/** @type {any} */ (target)).CopyRects
                !== 'function' && args[0] !== null && typeof args[0] === 'object'
                ? keyOf(raws.get(args[0]) ?? args[0]) : null;
            const source = raw && inSystemMemory(raw) ? raw : null;
            if (pending.addresses.size > 0 && !quiet)
            {
                const readable = readBy(target, name, args);
                shipPending(source ? key=>key !== source && readable(key) : readable);
            }
            else if (pending.addresses.size > 0 && !unlocking && !name.startsWith('AddDirty')
                && !(locking && inSystemMemory(keyOf(target)))
                && [...pending.owners.values()].includes(keyOf(target)))
            {
                // A lock of a resource the played side reads -- a texture its
                // draws sample, a target its renderer answers for -- has what
                // was unlocked there first. One in system memory it never
                // reads: a copy out of it carries the rows it moves, and the
                // bytes sent ahead of the lock were stashed again by the lock.
                // A dirty region marked reads nothing: whatever reads it later
                // has the bytes sent first.
                shipPending();
            }
            number ??= /** @type {number} */ (numbers.get(target));
            if (counting && typeof (/** @type {any} */ (target)).refCount === 'number')
            {
                return countTo(target, number, method, applied);
            }
            /** @type {any[] | null} */
            let replies = null;
            const start = writer.size();
            if (nameId < 0)
            {
                writer.u8(OP.CALL);
                writer.u32(number);
                nameId = writer.string(name);
                writer.u8(count);
            }
            else
            {
                writer.call(number, nameId, count);
            }
            for (let index = 0; index < count; index++)
            {
                const arg = args[index];
                if (writer.value(arg, refOf, 0, sites[index] ??= createSite()))
                {
                    // A service of the caller's: the device is given one that
                    // keeps what it answers.
                    replies ??= [];
                    args[index] = serviceOf(arg, replies);
                }
                applied = unwrapInto(applied, args, index);
            }
            /** @type {{ address: number, bytes: Uint8Array }[] | null} */
            let shipped = null;
            if (unlocking)
            {
                // What a lock taken to read let the program see is the device's
                // own, and goes nowhere: a program that reads its back buffer
                // every frame would otherwise send the whole frame back.
                const ranges = lockedRanges(target, name === 'ReleaseDC' ? '' : partOf(args))
                    .filter(range=>!range.readOnly);
                if (deferring)
                {
                    ranges.forEach(pendFor(keyOf(target)));
                    if (ranges.length > 0)
                    {
                        const part = name === 'ReleaseDC' ? '' : partOf(args);
                        const parts = sentParts.get(target) ?? new Set();
                        parts.add(part);
                        sentParts.set(target, parts);
                    }
                }
                else
                {
                    // A dynamic buffer a draw has read is known on the other
                    // side, so its unlock sends only what differs: a program
                    // that unlocks all of a large one every frame sends what
                    // it wrote, not the buffer.
                    const sent = sentOf.get(target);
                    const unlocked = sent && sent.base === /** @type {any} */ (target).base
                        ? ranges.flatMap(range=>{
                            const from = range.address - sent.base;
                            const to = from + extentOf(range.address, range.length);
                            if (from < 0 || to > sent.length)
                            {
                                return rangeFrom(range);
                            }
                            // In a pause (`still`) counted compared, so that the
                            // draws after the unlock find it done. Outside one, what
                            // the last call compared is not what the program left.
                            const open = still > 0 ? compared.take(target, from, to)
                                : [from, to];
                            /** @type {{ address: number, bytes: Uint8Array }[]} */
                            const into = [];
                            for (let part = 0; part < open.length; part += 2)
                            {
                                changedIn(sent, open[part], open[part + 1], into);
                            }
                            return into;
                        })
                        : ranges.flatMap(range=>rangeFrom(range));
                    shippedAs('buffers', unlocked);
                    shipped = [...shipped ?? [], ...unlocked];
                }
            }
            allocs = null;
            writes = null;
            reads = null;
            drawn = null;
            if (depth === 0 && still === 0)
            {
                compared.clear();
            }
            depth++;
            let result;
            let failed = true;
            try
            {
                result = method.apply(target, applied);
                failed = false;
            }
            finally
            {
                depth--;
                // What the call set, which the checker cannot follow into it.
                const made = /** @type {number[] | null} */ (allocs);
                const wrote = /** @type {{ address: number, bytes: Uint8Array }[] | null} */ (writes);
                const read = /** @type {{ address: number, bytes: Uint8Array }[] | null} */ (reads);
                const drew = /** @type {{ address: number, bytes: Uint8Array }[] | null} */ (drawn);
                allocs = null;
                writes = null;
                reads = null;
                drawn = null;
                if (read)
                {
                    shippedAs('reads', read);
                    shipped = shipped ? [...shipped, ...read] : read;
                }
                if (drew)
                {
                    shippedAs('dynamic', drew);
                    shipped = shipped ? [...shipped, ...drew] : drew;
                }
                // Whatever the call did, the record is finished, so the next
                // one starts where it should.
                const shipping = shipped !== null && shipped.length > 0;
                writer.u8((made ? SECTION.ALLOCS : 0) | (replies ? SECTION.REPLIES : 0)
                    | (shipping ? SECTION.SHIP : 0) | (wrote ? SECTION.WROTE : 0));
                if (made)
                {
                    writer.u32(made.length);
                    for (let index = 0; index < made.length; index++)
                    {
                        writer.u32(made[index]);
                    }
                }
                if (replies)
                {
                    writer.u32(replies.length);
                    for (let index = 0; index < replies.length; index++)
                    {
                        writer.value(replies[index], refOf, 1);
                    }
                }
                if (shipping)
                {
                    writeMemory(/** @type {{ address: number, bytes: Uint8Array }[]} */ (shipped));
                }
                if (wrote)
                {
                    writeMemory(wrote);
                    shippedAs('writes', wrote);
                }
                // Which calls the batches are made of, for a report; a batch
                // sent while the record was written leaves it uncounted.
                if (import.meta.BOTTLIFY_DIAGNOSTICS !== false && writer.size() >= start)
                {
                    transport.recordedCall?.(name, writer.size() - start);
                }
                if (failed)
                {
                    // The record is sent as it is, and what the played device
                    // makes of it is its own failure, not this one's.
                    try
                    {
                        transport.called(WAIT.NONE, name);
                    }
                    catch {
                        // The caller is told of the recorded call's failure.
                    }
                }
            }
            bindAll(result, making ? args : NOTHING, bind);
            if (LEVELS.has(name))
            {
                const out = args[count - 1];
                const level = out?.surface ?? out?.volume;
                if (level)
                {
                    const levels = levelsOf.get(target) ?? new Map();
                    levels.set(partOf(args), raws.get(level) ?? level);
                    levelsOf.set(target, levels);
                    containerOf.set(raws.get(level) ?? level, target);
                }
            }
            // A lock taken to read is marked so whatever the answer: a render
            // target's comes from the played device later, and an unlock with
            // no lock on record sends the whole surface. But not the first of
            // a part the played side was never sent: what it has there is
            // what the part held when it was made, and a managed texture's
            // first upload takes its system copy whatever the locks said -- a
            // program that fills a level under D3DLOCK_READONLY is drawn with
            // what it wrote on Windows. That first one goes as a write.
            const readOnly = locking && readOnlyLock(args)
                && (sentParts.get(target)?.has(partOf(args)) === true
                    || typeof (/** @type {any} */ (result))?.then === 'function');
            if (readOnly)
            {
                const locks = lockedAt.get(target) ?? new Map();
                locks.set(partOf(args), { address: 0, length: 0, readOnly });
                lockedAt.set(target, locks);
            }
            if (making || (locking && !readOnly))
            {
                for (let index = 0; index < count; index++)
                {
                    const arg = args[index];
                    if (arg === null || typeof arg !== 'object')
                    {
                        continue;
                    }
                    if (making)
                    {
                        wrapInto(arg);
                    }
                    const bits = arg.pBits;
                    if (locking && typeof bits === 'number')
                    {
                        const length = lockedLength(name, args, arg);
                        const locks = lockedAt.get(target) ?? new Map();
                        locks.set(partOf(args), { address: bits, length });
                        lockedAt.set(target, locks);
                        if (name === 'Lock' && ((args[3] ?? 0)
                            & (D3DLOCK_NOOVERWRITE | D3DLOCK_DISCARD)) !== D3DLOCK_NOOVERWRITE)
                        {
                            // A buffer's lock but NOOVERWRITE alone lets the program write
                            // anywhere in it afterwards -- DISCARD's fresh storage, or a
                            // plain lock's wait for the GPU -- under NOOVERWRITE locks
                            // the guest takes itself (`seam/shadow.js`): all of it is
                            // claimed now.
                            claim(bits - (args[0] ?? 0), null);
                        }
                        else
                        {
                            claim(bits, length);
                        }
                    }
                }
            }
            if (lender)
            {
                claimWritten(target, name, args);
            }
            if (!failed)
            {
                observe?.(target, name, applied);
            }
            if (paced)
            {
                const held = transport.called(WAIT.PACED, name);
                return held instanceof Promise ? held.then(()=>result) : result;
            }
            if (name === 'Issue')
            {
                // A new measurement: what was counted before is not its count.
                counts.delete(target);
                waiting.delete(target);
                if (/** @type {any} */ (target).type === D3DQUERYTYPE_OCCLUSION
                    && (applied[0] & D3DISSUE_END) !== 0 && result === 0)
                {
                    if (timed)
                    {
                        waiting.set(target, { at: performance.now(), polls: 0, asks: 0,
                            events: [['end', sharedNow(), 0]] });
                    }
                    ends.set(target, (ends.get(target) ?? 0) + 1);
                    occlusionQueries.set(/** @type {number} */ (number), new WeakRef(target));
                }
            }
            if (!mayAnswer || !answered(target, name, applied))
            {
                transport.called(WAIT.NONE, name);
                return typeof result === 'object' ? answerOf(result) : result;
            }
            if (name === 'GetRenderTargetData' && applied[1])
            {
                const into = applied[1];
                const filled = Promise.resolve(ask(name))
                    .then(()=>{}, ()=>{});
                // A texture's level is read through its texture as well; the
                // copies back are answered in order, so the last one asked is
                // the one to wait for.
                const filledNow = [into, into.container].filter(
                    one=>one !== null && typeof one === 'object');
                for (const one of filledNow)
                {
                    readbacks.set(one, filled);
                }
                filled.then(()=>{
                    for (const one of filledNow)
                    {
                        if (readbacks.get(one) === filled)
                        {
                            readbacks.delete(one);
                        }
                    }
                });
                return typeof result === 'object' ? answerOf(result) : result;
            }
            // A copy out of a render target is queued as GetRenderTargetData
            // is: the program goes on, and only what reads the destination --
            // a lock, a DC, a copy out of it -- waits for its pixels. Into a
            // surface the GPU holds, the played device copies there and has no
            // bytes to send at all. Waiting at the copy held the program for the
            // replay of everything recorded before, twice a frame in a program
            // that copies its targets.
            if (name === 'CopyRects' && applyMoves && copiesBack(applied[3]))
            {
                const into = applied[3];
                const filled = Promise.resolve(ask(name)).then(played=>{
                    if (played.answer === 0)
                    {
                        applyMoves(played.outs[5]?.moves ?? []);
                    }
                }, ()=>{});
                const filledNow = [into, into.container].filter(
                    one=>one !== null && typeof one === 'object');
                for (const one of filledNow)
                {
                    readbacks.set(one, filled);
                }
                filled.then(()=>{
                    for (const one of filledNow)
                    {
                        if (readbacks.get(one) === filled)
                        {
                            readbacks.delete(one);
                        }
                    }
                });
                // The copies are made when the pixels come; made now, they
                // would copy what the target's memory held before.
                if (args[5] && typeof args[5] === 'object')
                {
                    args[5].moves = [];
                }
                // Not the recorded device's own answer: it reads the target
                // back too, a promise the caller would wait on.
                return result instanceof Promise ? 0 : result;
            }
            if (name === 'GetData' && /** @type {any} */ (target)?.type === D3DQUERYTYPE_OCCLUSION)
            {
                const asking = { reply: /** @type {PlayedAnswer | null} */ (null), beside: false,
                    sentAt: timed ? performance.now() : 0, cameAt: 0 };
                counts.set(target, asking);
                // Its answer is told (`whenCounted`) as it comes, a count or
                // null for one to ask for again: a caller may poll it without
                // asking here.
                /** @type {any} */ (target).countsLater = true;
                const asked = timed ? waiting.get(target) : undefined;
                if (asked)
                {
                    asked.asks++;
                    asked.events.push(['ask', sharedNow(), asked.polls]);
                }
                Promise.resolve(ask(name)).then(played=>{
                    asking.cameAt = timed ? performance.now() : 0;
                    asked?.events.push(['came', sharedNow(), asked.polls, played.answer]);
                    // Still this measurement's; an answer that is not a count
                    // yet is asked again at the next poll.
                    if (counts.get(target) === asking)
                    {
                        if (played.answer === 0)
                        {
                            asking.reply = played;
                            /** @type {any} */ (target).whenCounted?.(
                                /** @type {any} */ (played.outs[0])?.value ?? 0);
                        }
                        else
                        {
                            counts.delete(target);
                            /** @type {any} */ (target).whenCounted?.(null);
                        }
                    }
                    takeCounts(target, played.counts, asking.sentAt, asking.cameAt);
                }, ()=>{
                    if (counts.get(target) === asking)
                    {
                        counts.delete(target);
                        /** @type {any} */ (target).whenCounted?.(null);
                    }
                });
                return S_FALSE;
            }
            /** @param {PlayedAnswer} played */
            const take = played=>{
                for (let index = 0; index < args.length; index++)
                {
                    copyOut(args[index], played.outs[index]);
                }
                return played.answer;
            };
            const reply = /** @type {PlayedAnswer | Promise<PlayedAnswer>} */ (
                ask(name));
            return reply instanceof Promise ? reply.then(take) : take(reply);
        };
        return call;
    };

    /**
     * A proxy's handler, its own: what the proxy's methods are as the caller
     * calls them is kept in it, found without a look-up by object.
     *
     * @returns {ProxyHandler<any>}
     */
    const handlerOf = ()=>{
        /**
         * Each method as the caller calls it, made once for each method the
         * object has under that name.
         *
         * @type {Map<string, { of: Function, as: Function }>}
         */
        const made = new Map();
        return {
            get(target, key){
                if (key === 'lendsMemory')
                {
                    // Asked by the seam's guest routines (`seam/shadow.js`):
                    // what is unlocked is read later, and a lock in the
                    // guest must come here to claim it first.
                    return lender !== null;
                }
                const value = Reflect.get(target, key);
                if (typeof value === 'function' && typeof key === 'string')
                {
                    const known = made.get(key);
                    if (known !== undefined && known.of === value)
                    {
                        return known.as;
                    }
                    if (owned.get(target)?.has(key))
                    {
                        return value;
                    }
                    const method = methodOf(target, key, value);
                    made.set(key, { of: value, as: method });
                    return method;
                }
                return typeof key === 'string' ? reached(target, key, value) : value;
            },
            set,
        };
    };

    /**
     * A property read that is not a method: one of the device's objects is
     * given as its proxy, and numbered on both sides the first time.
     *
     * @param {object} target @param {string} key @param {any} value
     */
    const reached = (target, key, value)=>{
        // An object's count is this side's bookkeeping, kept where the guest
        // moves it: the played object is told what it comes to (`countTo`).
        if (key === 'counter' || !isDeviceObject(value))
        {
            return value;
        }
        if (!numbers.has(value))
        {
            bind(value);
            writer.u8(OP.GET);
            writer.u32(/** @type {number} */ (numbers.get(target)));
            writer.string(key);
            transport.recorded();
        }
        return proxyOf(value);
    };

    /** @type {NonNullable<ProxyHandler<any>['set']>} */
    const set = (target, key, value)=>{
        if (typeof key === 'string' && typeof value === 'function')
        {
            // The caller's own wrapping of a method, on its side alone:
            // what it calls through is recorded as it is called.
            const keys = owned.get(target) ?? new Set();
            keys.add(key);
            owned.set(target, keys);
            return Reflect.set(target, key, value);
        }
        if (typeof key === 'string')
        {
            writer.u8(OP.SET);
            writer.u32(/** @type {number} */ (numbers.get(target)));
            writer.string(key);
            writer.value(value, refOf);
            transport.recorded();
        }
        return Reflect.set(target, key, unwrap(value));
    };
    /** @param {object} given */
    const proxyOf = given=>{
        const object = raws.get(given) ?? given;
        let proxy = proxies.get(object);
        if (!proxy)
        {
            proxy = new Proxy(object, handlerOf());
            proxies.set(object, proxy);
            raws.set(proxy, object);
            const number = numbers.get(object);
            if (number !== undefined)
            {
                numbers.set(proxy, number);
            }
        }
        return proxy;
    };

    return {
        root: proxyOf(root),
        outward: answerOf,
        allocated(address, bytes){
            if (depth > 0)
            {
                (allocs ??= []).push(address);
            }
            let at = blocks.starts.length;
            while (at > 0 && blocks.starts[at - 1] > address)
            {
                at--;
            }
            blocks.starts.splice(at, 0, address);
            blocks.ends.splice(at, 0, address + bytes);
        },
        freed(address){
            const found = blockAt(address);
            if (found >= 0 && blocks.starts[found] === address)
            {
                claim(address, null);
                blocks.starts.splice(found, 1);
                blocks.ends.splice(found, 1);
            }
        },
        writing: (address, length)=>{
            // What the device writes is no longer what was compared.
            if (still > 0)
            {
                compared.clear();
            }
            claim(address, length);
        },
        still(work){
            if (still === 0)
            {
                compared.clear();
            }
            still++;
            try
            {
                return work();
            }
            finally
            {
                still--;
            }
        },
        settled(){
            return unanswered.size === 0 ? null
                : Promise.allSettled([...unanswered]).then(()=>{});
        },
        wrote(address, bytes){
            if (depth > 0)
            {
                (writes ??= []).push({ address, bytes: bytes.slice() });
                return;
            }
            writer.u8(OP.WROTE);
            writer.u32(1);
            writer.memory(address, bytes);
            shippedAs('writes', [{ bytes }]);
            transport.recorded();
        },
        adopt(object){
            ADOPTED.add(object);
            numbers.set(object, next++);
        },
        drawsFrom(buffer, from, to){
            const base = buffer?.base;
            if (typeof base !== 'number' || depth === 0)
            {
                return;
            }
            const sent = sentOf.get(buffer);
            if (!sent || sent.base !== base)
            {
                // What the played side holds of the buffer is not known until
                // something is sent of all of it: once, at its first draw,
                // watched from before the read.
                const watch = watchWrites?.(base, buffer.length) ?? null;
                const bytes = readMemory(base, buffer.length);
                // Kept only to compare against where there is no watch to say.
                sentOf.set(buffer, { base, length: buffer.length, bytes: watch ? null : bytes,
                    watch, dirty: new Set() });
                compared.take(buffer, 0, buffer.length);
                (drawn ??= []).push({ address: base, bytes });
                return;
            }
            const open = compared.take(buffer, from, to);
            let length = 0;
            for (let part = 0; part < open.length; part += 2)
            {
                length += changedIn(sent, open[part], open[part + 1], drawn ??= []);
            }
            if (length > 0)
            {
                transport.shipped?.('compared', length);
            }
        },
        read(address, bytes){
            // Written into the record when the call is finished, before the
            // program runs again: a window the read handed out still holds
            // the bytes it read, since no call writes what it read.
            if (depth > 0)
            {
                (reads ??= []).push({ address, bytes });
                return;
            }
            writer.u8(OP.WROTE);
            writer.u32(1);
            writer.memory(address, bytes);
            shippedAs('reads', [{ bytes }]);
            transport.recorded();
        },
    };
}

/**
 * The playing side: the calls a recording wrote, made in their order on a
 * root of the same build, with the same objects by the same numbers.
 *
 * @param {Object} options
 * @param {Record<string, any>} options.root
 * @param {(address: number, bytes: Uint8Array) => void} options.ship
 *     where the bytes a lock let the program write are put: the guest memory
 *     this side reads
 * @param {(address: number, length: number) => Uint8Array} options.read
 *     that memory read, for the copies a call describes and its caller makes
 * @param {ReturnType<typeof import('./lending.js').createBorrower>} [options.borrow]
 *     the guest memory a recording lent, read in place
 * @returns {{ play: (call: import('./wire.js').ReadCall) => any, allocate: () => number,
 *     object: (number: number) => any, counts: () => OcclusionCount[],
 *     read: (buffer: ArrayBuffer, each: (call: import('./wire.js').ReadCall) => boolean | void)
 *         => number | undefined }}
 *     `play` answers a waited call with its `PlayedAnswer` (or a promise of
 *     one), a paced one with the promise its device holds the caller on, and
 *     any other with what the call answered;
 *     `allocate` is the played device's, the next address its recorded call
 *     was given; `read` reads a batch of calls, and answers how long the look
 *     at the objects at a count of zero took when the batch made one
 */
export function createPlayer({ root, ship, read, borrow }){
    /**
     * The played objects by the number the recording gave each. One is held
     * here until it says it is destroyed, and weakly after: an object at a
     * count of zero may still be called through the pointer the program kept
     * while its device owns it (a level of a texture, a back buffer), so the
     * count alone does not say it is done. Held strongly for good, every
     * buffer a level's loading made and dropped stayed for the rest of the
     * run.
     *
     * @type {(object | WeakRef<object>)[]}
     */
    const objects = [root];
    /** A slot held weakly is emptied once its object is collected. */
    const collected = new FinalizationRegistry((/** @type {number} */ number)=>{
        const held = objects[number];
        if (held instanceof WeakRef && held.deref() === undefined)
        {
            delete objects[number];
        }
    });
    /** @param {number} number @returns {any} */
    const objectAt = number=>{
        const held = objects[number];
        return held instanceof WeakRef ? held.deref() : held;
    };
    /**
     * The objects at a count of zero not destroyed yet -- one released while
     * a stream still binds it goes when the stream lets go, with no call on
     * it -- looked at again after each batch.
     *
     * @type {Set<number>}
     */
    const uncounted = new Set();
    /** Whether a present was played since `uncounted` was last looked at, and the batches since. */
    let presentedSinceSweep = false;
    let batchesSinceSweep = 0;
    /** Where the last look stopped (`SWEEP_SLICE`); a set's iterator follows its changes. */
    let sweeping = uncounted.values();
    /**
     * After a call on one, or a batch: held weakly once destroyed.
     *
     * @param {number} number @param {any} object
     */
    const holdAsCounted = (number, object)=>{
        if (!object || objects[number] instanceof WeakRef)
        {
            return;
        }
        if (object.destroyed === true)
        {
            uncounted.delete(number);
            objects[number] = new WeakRef(object);
            collected.register(object, number);
        }
        else if (object.refCount === 0)
        {
            uncounted.add(number);
        }
        else
        {
            uncounted.delete(number);
        }
    };
    /** @type {WeakSet<object>} */
    const known = new WeakSet([root]);
    /** @type {number[]} */
    let allocs = [];
    /** The call being played, for what a failure says. @type {string} */
    let playing = '';
    /**
     * The ENDs played on each occlusion query, by its number: what a count
     * sent beside another query's answer is said to be of.
     *
     * @type {Map<number, number>}
     */
    const occlusionEnds = new Map();
    /**
     * The counts the played device holds for the occlusion queries but one,
     * each with the END it is of.
     *
     * @param {number} asked
     * @returns {OcclusionCount[]}
     */
    const heldCounts = asked=>{
        /** @type {OcclusionCount[]} */
        const held = [];
        for (const [number, ended] of occlusionEnds)
        {
            const query = objectAt(number);
            if (!query)
            {
                occlusionEnds.delete(number);
                continue;
            }
            /** @type {{ value?: number }} */
            const count = {};
            if (number !== asked && query.GetData(count, 4, 0) === 0
                && typeof count.value === 'number')
            {
                held.push([number, ended, count.value]);
            }
        }
        return held;
    };
    /**
     * The END of each query whose count was last sent unasked, so a count goes
     * once.
     *
     * @type {Map<number, number>}
     */
    const sentCounts = new Map();
    /** @type {any[]} */
    let replies = [];
    /**
     * Every service of the caller's, played: whatever is asked of it, the
     * answer the caller's gave in the recorded call.
     */
    const standIn = new Proxy({}, {
        get: (_, key)=>(typeof key === 'string' ? ()=>replies.shift() : undefined),
    });
    const reader = createReader({ ref: objectAt, service: ()=>standIn });

    /** @param {object} object */
    const bind = object=>{
        if (!known.has(object))
        {
            known.add(object);
            objects.push(object);
        }
    };

    /**
     * The copies a call described in a structure it was given, made in the
     * memory this side reads as the caller makes them in the guest's.
     *
     * @param {any[]} args
     */
    const move = args=>{
        for (const arg of args)
        {
            for (const one of Array.isArray(arg?.moves) ? arg.moves : [])
            {
                for (let row = 0; row < one.rows; row++)
                {
                    ship(one.to + row * one.toPitch,
                        read(one.from + row * one.fromPitch, one.rowBytes));
                }
            }
        }
    };

    return {
        play(call){
            const target = /** @type {any} */ (objectAt(call.t));
            if (call.op === OP.GET)
            {
                bindAll(target[/** @type {string} */ (call.m)], [], bind);
                return undefined;
            }
            if (call.op === OP.SET)
            {
                target[/** @type {string} */ (call.m)] = call.v;
                return undefined;
            }
            if (call.op === OP.LENT)
            {
                if (!borrow)
                {
                    throw new Error('remote: guest memory lent to a side that cannot read it');
                }
                for (const { address, length, slot } of call.lent ?? [])
                {
                    borrow(slot, address, length, bytes=>ship(address, bytes));
                }
                return undefined;
            }
            if (call.op !== OP.CALL)
            {
                for (const { address, bytes } of call.wrote ?? [])
                {
                    ship(address, bytes);
                }
                return undefined;
            }
            for (const { address, bytes } of call.ship ?? [])
            {
                ship(address, bytes);
            }
            allocs = call.allocs ?? [];
            replies = call.replies ?? [];
            playing = /** @type {string} */ (call.m);
            if (playing === 'Present')
            {
                presentedSinceSweep = true;
            }
            const args = /** @type {any[]} */ (call.a);
            // A slot is emptied only once its object said it was destroyed and
            // was collected, and a destroyed object is reachable through no
            // pointer: the bridge asks again of one it held at a count of zero.
            if (target === undefined && playing === 'reachable')
            {
                return call.wait === WAIT.ANSWER ? { answer: false, outs: args } : false;
            }
            if (playing === REFS_TO)
            {
                const counted = refsTo(target, args[0]);
                holdAsCounted(call.t, target);
                return counted;
            }
            // A Reset the recording answered is played as answered: what the
            // program holds is the recording's count, not this side's.
            const answer = playing === 'Reset' ? target.Reset(...args, allocs.length > 0)
                : target[playing](...args);
            holdAsCounted(call.t, target);
            bindAll(answer, handsOut(playing) ? args : NOTHING, bind);
            const occlusion = target?.type === D3DQUERYTYPE_OCCLUSION;
            if (occlusion && playing === 'Issue' && (args[0] & D3DISSUE_END) !== 0
                && answer === 0)
            {
                occlusionEnds.set(call.t, (occlusionEnds.get(call.t) ?? 0) + 1);
            }
            /** What goes beside an answer: for an occlusion count, the others held. */
            const beside = occlusion && playing === 'GetData' && call.wait === WAIT.ANSWER
                ? ()=>({ counts: heldCounts(call.t) }) : ()=>({});
            if (allocs.length > 0)
            {
                // What the played device answered says which way it went: a
                // refusal (a Reset the device took as lost, with resources it
                // still counts live) or a call that made fewer objects.
                const said = typeof answer === 'number' ? `0x${(answer >>> 0).toString(16)}`
                    : answer instanceof Promise ? 'a promise' : typeof answer;
                throw new Error(`remote: ${playing} allocated less on the played device: it`
                    + ` answered ${said}, ${allocs.length} of the recording's objects not made`);
            }
            const later = answer instanceof Promise;
            if (!later)
            {
                move(args);
            }
            for (const { address, bytes } of call.wrote ?? [])
            {
                ship(address, bytes);
            }
            if (later)
            {
                const settled = answer.then(value=>{
                    move(args);
                    return { answer: value, outs: args, ...beside() };
                });
                if (call.wait === WAIT.ANSWER)
                {
                    return settled;
                }
                return call.wait === WAIT.PACED ? answer : undefined;
            }
            // An unwaited call's answer is what a carrier that is asked for
            // it after the call -- what a device says of itself -- passes on.
            return call.wait === WAIT.ANSWER ? { answer, outs: args, ...beside() } : answer;
        },
        object: objectAt,
        /**
         * The counts the played device holds that have not been sent since
         * their END: what goes to the recording side unasked once the GPU has
         * counted, rather than at the program's next ask.
         */
        counts(){
            const fresh = heldCounts(-1)
                .filter(([number, ended])=>sentCounts.get(number) !== ended);
            for (const [number, ended] of fresh)
            {
                sentCounts.set(number, ended);
            }
            return fresh;
        },
        allocate(){
            const address = allocs.shift();
            if (address === undefined)
            {
                throw new Error('remote: the played device allocated more than the recorded one'
                    + ` in ${playing}`);
            }
            return address;
        },
        read: (buffer, each)=>{
            reader.read(buffer, each);
            // Looked at once a frame, or every so many batches for a program
            // that is not presenting: what it decides is only when a
            // destroyed object is let go, and a look after every batch went
            // through thousands of them hundreds of times a second.
            if (presentedSinceSweep || ++batchesSinceSweep >= SWEEP_BATCHES)
            {
                presentedSinceSweep = false;
                batchesSinceSweep = 0;
                // Timed for the receiver's account of the worker's time: at
                // most once a frame, so two clock readings cost nothing.
                const began = import.meta.BOTTLIFY_DIAGNOSTICS !== false ? performance.now() : 0;
                for (let looked = 0; looked < Math.min(SWEEP_SLICE, uncounted.size); looked++)
                {
                    let next = sweeping.next();
                    if (next.done)
                    {
                        sweeping = uncounted.values();
                        next = sweeping.next();
                    }
                    if (next.done)
                    {
                        break;
                    }
                    holdAsCounted(next.value, objects[next.value]);
                }
                return import.meta.BOTTLIFY_DIAGNOSTICS !== false
                    ? performance.now() - began : undefined;
            }
            return undefined;
        },
    };
}

/**
 * A guest memory of only the bytes sent to it, in 64 KiB pages made as they
 * are written: what a renderer behind a played device reads. It is written
 * only by what is sent, so it says which 4 KiB pages were written since a
 * reader last looked (`watch`), as the engine's write watch does for guest
 * memory: a dynamic buffer's upload is those pages, not a comparison.
 */
export function createMirror(){
    const SHIFT = 16;
    const SIZE = 1 << SHIFT;
    /** @type {Map<number, Uint8Array>} */
    const pages = new Map();
    /**
     * Each 4 KiB page's last write, numbered; a watch keeps the number it last
     * saw of each.
     *
     * @type {Map<number, number>}
     */
    const stamps = new Map();
    let stamp = 0;
    /** @param {number} page */
    const pageOf = page=>{
        let bytes = pages.get(page);
        if (!bytes)
        {
            bytes = new Uint8Array(SIZE);
            pages.set(page, bytes);
        }
        return bytes;
    };
    return {
        /** @param {number} address @param {Uint8Array} bytes */
        write(address, bytes){
            if (bytes.length > 0)
            {
                stamp++;
                const last = (address + bytes.length - 1) >>> 12;
                for (let page = address >>> 12; page <= last; page++)
                {
                    stamps.set(page, stamp);
                }
            }
            let done = 0;
            while (done < bytes.length)
            {
                const at = (address + done) >>> 0;
                const offset = at & (SIZE - 1);
                const take = Math.min(SIZE - offset, bytes.length - done);
                pageOf(at >>> SHIFT).set(bytes.subarray(done, done + take), offset);
                done += take;
            }
        },
        /**
         * A watch over a range, as the engine's (`watchWrites`): its `take`
         * answers the pages written since its own last look at them, every
         * page ever written at its first.
         *
         * @param {number} address @param {number} length
         * @returns {{ take: (from: number, bytes: number) => number[] }}
         */
        watch(address, length){
            /** @type {Map<number, number>} */
            const seen = new Map();
            const first = address >>> 12;
            const end = (address + Math.max(length, 1) - 1) >>> 12;
            return {
                take(from, bytes){
                    /** @type {number[]} */
                    const taken = [];
                    const last = Math.min(end, (from + Math.max(bytes, 1) - 1) >>> 12);
                    for (let page = Math.max(first, from >>> 12); page <= last; page++)
                    {
                        const at = stamps.get(page);
                        if (at !== undefined && at !== seen.get(page))
                        {
                            seen.set(page, at);
                            taken.push(page);
                        }
                    }
                    return taken;
                },
            };
        },
        /** @param {number} address @param {number} length @returns {Uint8Array} */
        read(address, length){
            const out = new Uint8Array(length);
            let done = 0;
            while (done < length)
            {
                const at = (address + done) >>> 0;
                const offset = at & (SIZE - 1);
                const take = Math.min(SIZE - offset, length - done);
                const page = pages.get(at >>> SHIFT);
                if (page)
                {
                    out.set(page.subarray(offset, offset + take), done);
                }
                done += take;
            }
            return out;
        },
        /**
         * The bytes in place when they lie in one page that holds them, a
         * copy otherwise: a window, which its reader copies from before the
         * next call writes the mirror again.
         *
         * @param {number} address @param {number} length @returns {Uint8Array}
         */
        window(address, length){
            const at = address >>> 0;
            const offset = at & (SIZE - 1);
            const page = offset + length <= SIZE ? pages.get(at >>> SHIFT) : undefined;
            return page ? page.subarray(offset, offset + length) : this.read(address, length);
        },
    };
}
