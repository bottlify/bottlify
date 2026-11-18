/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a device's guest routines read and write without crossing into the
 * host, and the host's side of it.
 *
 * A program of this era sets render states, transforms and textures hundreds
 * of times a frame, draws between them, and locks and unlocks a buffer around
 * every draw; every one was a crossing into the host -- a trap, a dispatch and
 * a return. So the setters and the draws are guest code (`commandCode`) that
 * writes the call into a command ring of the device's, and the host makes the
 * calls, in order, through the device's own methods, on its way into any
 * method of its own. The order is what a block of latest values cannot keep
 * and a draw that waits needs. Space in the ring is taken with `lock
 * cmpxchg`, and a record counts once its length, written last, is there, so
 * two threads may share one device's ring.
 *
 * The getters that run in the guest -- GetRenderState, and Direct3D 9's
 * GetTransform and GetTextureStageState -- answer from the device's block.
 * The command routines of their setters write the value there as they record
 * the call, and the host writes what it changes on its own -- at creation,
 * after a reset, after a state block is applied, after MultiplyTransform --
 * so that the block holds what the device holds.
 *
 * A buffer's storage is guest memory already, so a lock in the guest is an
 * address handed back and a range remembered, and an unlock is the buffer's
 * block appended to a ring in the device's block. The host replays each
 * remembered lock and unlock against the real buffer when it next looks,
 * before it makes the calls the command ring holds, so a draw there meets the
 * bytes the program wrote. A lock the guest holds across a crossing is
 * mirrored as a lock the host holds, so a second lock, through either path,
 * is refused the way the real interface refuses it; and while the ring holds
 * a draw, a lock that may overwrite what the draw reads is the host's, which
 * makes the draw first.
 *
 * A texture's level is one surface however often it is asked for, so its
 * pointer sits in the texture's own block and GetSurfaceLevel in the guest
 * reads it there. What such a call owes is a reference, and a reference
 * cannot be taken without the host -- so the guest counts them and the host
 * charges the count before any reference of that texture is read or given
 * back.
 *
 * Nothing is taken on the guest's word. A record the routines could not have
 * written is refused, a call the device refuses was answered D3D_OK in the
 * guest and is reported as a divergence, and while a state block records --
 * when every call has to reach the host as it is made -- the host raises a
 * flag every routine checks first, and leaves to the trap.
 */

import { D3DPOOL, D3DUSAGE, FORMAT_INFO, surfacePitch } from '../d3d8/constants.js';
import { dword } from './routines/assemble.js';
import {
    BUFFER, COMMAND, COMMAND_RING_BYTES, COMMAND_SLACK, D3DFMT_D24S8, D3DLOCK_DISCARD,
    D3DLOCK_NOOVERWRITE, D3DLOCK_READONLY, D3DUSAGE_DYNAMIC, D3DUSAGE_RENDERTARGET,
    DEVICE_RING_BYTES, DRAW, FLAG_DRAW_STALE, FLAG_SLOW_PATH, FLAG_STALE, HELD_HOST, HELD_WAIT_MS,
    LEVEL, LOCK_IN_PLACE, PAGE, PAGES, QUERY, SHADOW, SURFACE, TEXTURE, VERTEX_BUFFER7, WORLD_SLOT,
    WORLD_TYPE, ZERO_WORD, replayedFlags, transformSlot, transformType,
} from './block.js';
import { RECT_BYTES, usagesOf } from './routines/command.js';
import { ANSWERED_TRANSFORMS } from './routines/getters.js';

/**
 * Writes an empty command ring into a block: `ring` is pages of its own,
 * zeroed so that a length is only ever a finished record's.
 *
 * @param {number} block @param {number} ring
 * @param {(address: number, bytes: Uint8Array) => void} writeMemory
 * @param {number} [bytes]  its size
 */
export function placeCommandRing(block, ring, writeMemory, bytes = COMMAND_RING_BYTES){
    writeMemory(ring, new Uint8Array(bytes));
    const header = new Uint32Array([ring, bytes]);
    writeMemory(block + SHADOW.COMMANDS, new Uint8Array(header.buffer));
}

/**
 * The host's end of a command ring (`commandCode`): what the guest wrote into
 * it since the host last read it, handed to `take` in order -- every record
 * whose length is there, up to the first one a routine has taken the space
 * for and not yet finished. The head is the guest's; the host starts the ring
 * over -- zeroing what it read, so that a length is only ever a finished
 * record's -- once it has read everything up to a head near the end.
 *
 * @param {Object} deps
 * @param {number} deps.block @param {number} deps.ring
 * @param {(address: number) => number} deps.readWord
 * @param {(address: number, words: number) => Uint32Array} deps.readWords
 * @param {(address: number, bytes: Uint8Array) => void} deps.writeMemory
 * @param {(records: Uint8Array) => number} deps.take  makes the calls, says how many
 * @param {(detail: string) => void} deps.refuse
 * @param {number} [deps.bytes]  the ring's size, `COMMAND_RING_BYTES` unless given
 * @param {(address: number, expected: number, value: number) => number} [deps.compareExchangeU32]
 *     the memory's, indivisible against the guest's threads on other executors
 * @param {(address: number) => number} [deps.loadU32]  the memory's atomic read: a
 *     record's length, which the routines publish with `xchg`, read so the record's
 *     words and what the program wrote before the call are seen after it
 */
export function createCommandReader(deps){
    const { block, ring, readWord, readWords, writeMemory, take, refuse,
        bytes = COMMAND_RING_BYTES, compareExchangeU32 } = deps;
    const lengthAt = deps.loadU32 ?? readWord;
    let tail = 0;
    let taken = 0;
    const zero = new Uint8Array(4);
    return {
        /**
         * @param {() => void} [before]  run once the ring is found to hold calls,
         *     before they are made
         */
        take(before){
            if (readWord(block + SHADOW.DRAWS_PENDING) !== 0)
            {
                // Lowered before the head is read: a draw written after this
                // raises it again, and one before it is read now.
                writeMemory(block + SHADOW.DRAWS_PENDING, zero);
            }
            const head = readWord(block + SHADOW.COMMAND_HEAD);
            if (head === tail)
            {
                return;
            }
            if (head < tail || head > bytes)
            {
                refuse('the command ring\'s head went back');
                tail = head;
                return;
            }
            // Each record's length first, each an atomic read of the routine's
            // `xchg`, and its words after: on a host that reorders stores
            // (arm64) a plain read could find a length whose record, or the
            // vertices the program wrote before the call, were not there yet.
            const available = (head - tail) >>> 2;
            let whole = 0;
            while (whole < available)
            {
                const length = lengthAt(ring + tail + whole * 4 + COMMAND.BYTES) >>> 2;
                if (length === 0)
                {
                    break;
                }
                if (length < (COMMAND.ARGS >>> 2) || whole + length > available)
                {
                    refuse('a command record the routines could not have written');
                    whole = available;
                    break;
                }
                whole += length;
            }
            if (whole > 0)
            {
                const words = readWords(ring + tail, whole);
                before?.();
                taken += take(new Uint8Array(words.buffer, words.byteOffset, whole * 4));
            }
            tail += whole * 4;
            if (tail === head && head > bytes - COMMAND_SLACK)
            {
                // A routine between reading the head and taking its space finds
                // the head moved and takes it again, from the start. One on
                // another executor may have taken space since the head was read
                // here: the head goes back only from where it was read, as one
                // compare-and-swap, and otherwise the next take starts it over.
                writeMemory(ring, new Uint8Array(head));
                if (compareExchangeU32 === undefined)
                {
                    writeMemory(block + SHADOW.COMMAND_HEAD, zero);
                    tail = 0;
                }
                else if (compareExchangeU32(block + SHADOW.COMMAND_HEAD, head, 0) === head)
                {
                    tail = 0;
                }
            }
        },
        /** How many calls the ring has carried. */
        taken: ()=>taken,
        /**
         * Whether a word of the records waiting passes `test`: an object's
         * pointer among them, which a record that binds it holds.
         *
         * @param {(word: number) => boolean} test
         */
        holds(test){
            const head = readWord(block + SHADOW.COMMAND_HEAD);
            if (head <= tail || head > bytes)
            {
                return false;
            }
            const words = readWords(ring + tail, (head - tail) >>> 2);
            for (let at = 0; at < words.length; at++)
            {
                if (test(words[at]))
                {
                    return true;
                }
            }
            return false;
        },
        /**
         * How many finished records wait in the ring for the host's next
         * entry: a program that writes a ring's worth and ends without one
         * leaves them there.
         */
        queued(){
            const head = readWord(block + SHADOW.COMMAND_HEAD);
            if (head <= tail || head > bytes)
            {
                return 0;
            }
            const words = readWords(ring + tail, (head - tail) >>> 2);
            let records = 0;
            for (let at = 0; at < words.length;)
            {
                const length = words[at + (COMMAND.BYTES >>> 2)] >>> 2;
                if (length < (COMMAND.ARGS >>> 2))
                {
                    break;
                }
                records++;
                at += length;
            }
            return records;
        },
    };
}

/**
 * @typedef {Object} ShadowBuffer
 * @property {number} base        Where its bytes are in guest memory.
 * @property {number} length
 * @property {number} type        D3DRTYPE, which says which interface it is published as.
 * @property {number} refCount
 * @property {number} [usage]     D3DUSAGE, of which DYNAMIC says it may be held locked while drawn.
 * @property {() => number} release
 * @property {(offset: number, size: number, out: { pBits?: number }, flags?: number) => number
 *     } Lock
 * @property {() => number} Unlock
 * @property {number[]} [storages]  a dynamic one's, the first the one it was made with
 * @property {() => number} [AddStorage]  one more of its length (`d3d8/storages.js`)
 * @property {(left: number) => void} [renamed]  told by the device that it moved off a
 *     storage, the ring's `Buffer.Rename` made
 */

/**
 * A call of the device's the host makes: what the guest did first, then the
 * call, then what the guest's routines check theirs against brought to the
 * device -- once the answer is there, for a call that answers late.
 *
 * @template T
 * @param {{ sync: () => void, settled: () => void } | null | undefined} shadow
 * @param {() => T} call
 * @returns {T}
 */
export function settledAfter(shadow, call){
    if (!shadow)
    {
        return call();
    }
    shadow.sync();
    const result = call();
    if (result instanceof Promise)
    {
        return /** @type {T} */ (/** @type {unknown} */ (result.then(value=>{
            shadow.settled();
            return value;
        })));
    }
    shadow.settled();
    return result;
}

/**
 * @typedef {Object} ShadowTexture
 * @property {number} levels
 *
 * @typedef {Object} ShadowLevel  A level the guest locks (`attachLevel`).
 * @property {{ refCount: number }} level  the surface or volume
 * @property {object} family  the texture it is a level of, or the surface itself: a device
 *     context held on one of them is every level's lock
 * @property {(box: { left: number, top: number, right: number, bottom: number,
 *     front: number, back: number } | null, flags: number) => number} lock
 *     the host's lock of it, with the box the guest's named or none
 * @property {() => number} unlock
 * @property {boolean} hostLocked
 * @property {boolean} lends  its bytes may be lent to the graphics worker by a recording
 *     that lends (`ShadowDevice.lendsMemory`): a draw may read it, or a twin copies from it
 * @property {number} base  where its bytes are, which the recording is asked about
 *     (`ShadowDevice.lendsAt`)
 * @property {boolean} slow  the guest never locks it: compressed, or a target
 *
 * @typedef {Object} ShadowDevice
 * @property {boolean} [lendsMemory]  a recording for the graphics worker that lends what is
 *     unlocked rather than copying it (`remote/replay.js`)
 * @property {(address: number) => boolean} [lendsAt]  whether that recording lends what is
 *     unlocked at an address, or copies it (a small allocation); absent, it lends all
 * @property {(state: number, out: { value?: number }) => number} GetRenderState
 * @property {(type: number, out: { matrix?: ArrayLike<number> }) => number} GetTransform
 * @property {(stage: number, type: number, out: { value?: number }) => number
 *     } GetTextureStageState
 * @property {(out: { viewport?: any }) => number} [GetViewport]
 * @property {(sampler: number, type: number, out: { value?: number }) => number
 *     } [GetSamplerState]
 * @property {() => ShadowRingState} [ringState]
 *
 * @typedef {Object} ShadowRingState  What the command routines check a call against.
 * @property {number} drawable  the `DRAW` bits the device has
 * @property {number} targetWidth @property {number} targetHeight
 * @property {number} clipPlanes
 * @property {readonly number[]} taken  per table of `SHADOW.VALIDATED`, a value the
 *     device holds that it takes for its value alone, zero for none
 * @property {readonly ((value: number) => boolean)[]} [takes]  per table, whether it
 *     still takes one
 * @property {number} [cooperative]  zero while TestCooperativeLevel answers D3D_OK
 * @property {number} [elsewhere]  one when the device records for one drawing elsewhere,
 *     or draws nothing (`SHADOW.ELSEWHERE`)
 * @property {readonly [number, number][]} [strides]  vertex formats drawn with and their
 *     widths, the latest first (`SHADOW.FVF_STRIDES`)
 * @property {readonly [number, boolean][]} [stateBlocks]  the state blocks held by
 *     token, each with whether it holds what a draw's checks read
 *     (`SHADOW.STATE_BLOCKS`)
 * @property {readonly [number, number]} [shaders]  the vertex and pixel shader as
 *     Direct3D 8's getters answer them (`SHADOW.SHADERS`)
 * @property {readonly [any, any]} [targets]  the render target and the depth
 *     surface, null for none, as GetRenderTarget and GetDepthStencilSurface
 *     answer them (`SHADOW.TARGETS`)
 */

/**
 * @typedef {Object} ShadowCommands
 * @property {(records: Uint8Array) => number} take  makes the calls a run of
 *     whole records holds, in order, and says how many it made
 */

/**
 * @typedef {Object} ShadowDeps
 * @property {(bytes: number) => number} allocate     Guest memory.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 *     May answer with the guest's own bytes rather than a copy; nothing here
 *     keeps what it returns past the call that read it.
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number) => number} [readU32]
 *     A dword read in place, for the words looked at on every call: a view
 *     per call was a measured share of a frame.
 * @property {(address: number, expected: number, value: number) => number} [compareExchangeU32]
 *     A dword swapped only if it holds `expected`, indivisible against the
 *     guest's threads on the process's other executors; answers what it held.
 * @property {(address: number) => number} [loadU32]  A dword read atomically,
 *     in order after the store it finds: a command record's length.
 * @property {ShadowDevice} device
 * @property {(surface: any) => number[]} [handedOut]  the pointer the program was
 *     handed for a surface and the word its count is kept in, zeros for one it
 *     was not handed or whose count the host keeps: the targets the guest's
 *     getters answer with (`SHADOW.TARGETS`)
 * @property {(api: string, detail: string, severity?: 'loss') => void} [divergence]
 * @property {string} [name]  The device interface a refusal names.
 * @property {ShadowCommands} [commands]  The methods the device's command
 *     ring carries (`commandCode`), and how the host makes one: a device
 *     without them gets no ring.
 * @property {ShadowPhases} [phases]  Where `sync`'s time is accounted.
 * @property {number} [ringBytes]  The command ring's size, `DEVICE_RING_BYTES` unless
 *     given: a gate that fills it many times over gives a smaller one.
 * @property {(work: () => void) => void} [still]  Runs `work` as one pause of the
 *     program's, which does not run until it is done: what the device compares of
 *     guest memory in it is compared once, however many of its calls read it.
 */

/**
 * The phases `sync` opens, inside the host call it runs at the start of
 * (`bridge`'s `innerPhase`): `begin` answers 0 when the call is not one being
 * timed, and `end` takes what `begin` answered.
 *
 * @typedef {Object} ShadowPhases
 * @property {(name: string) => number} begin
 * @property {(name: string, weight: number) => void} end
 */

/**
 * The host's side of one device's block.
 *
 * @param {ShadowDeps} deps
 */
export function createShadow(deps){
    const ringBytes = deps.ringBytes ?? DEVICE_RING_BYTES;
    const { device } = deps;
    // Nothing timed in a production bundle, and no phase looked for.
    const phases = import.meta.BOTTLIFY_DIAGNOSTICS !== false ? deps.phases ?? null : null;
    const name = deps.name ?? 'IDirect3DDevice8';
    let address = 0;
    let refused = 0;
    let slow = false;
    /** The guest's lock and unlock counts, as the last entry that settled a buffer read them. */
    let lockCalls = 0;
    let unlockCalls = 0;
    /**
     * The buffers with a block, by block address, with whether the host
     * holds a lock on the buffer to mirror one the guest holds.
     *
     * @type {Map<number, { buffer: ShadowBuffer, hostLocked: boolean }>}
     */
    const blocks = new Map();
    /** @type {WeakMap<object, number>} */
    const blockOf = new WeakMap();
    /**
     * The blocks of buffers the guest has locked and unlocked itself: the ones
     * that can be held locked in the guest across a host entry.
     *
     * @type {Set<number>}
     */
    const lockedInGuest = new Set();
    /** Locks the host took and let go of in a block (`noteLocked`), beside the routines' counts. */
    let hostTaken = 0;
    let hostReleased = 0;
    /**
     * The host's buffer locks by what sent them past the routine: the buffer
     * already locked, a lock for reading, a lock but NOOVERWRITE alone under
     * a draw the ring held (`pending`) or, with none, over what was unlocked
     * on a lending device (`lent`), and any other case (the device's lock
     * busy, a bad range, no block).
     */
    const hostLocks = { locked: 0, readonly: 0, pending: 0, lent: 0, other: 0 };
    /**
     * The guest's moves of a buffer onto another storage the device has made
     * (`leftBehind`), the storages the host gave buffers for them, and the
     * buffers whose replay waited for the ring's move (`renamedPending`).
     */
    const moved = { made: 0, storages: 0, deferred: 0 };
    /**
     * Locks the guest held across a host entry with a draw in the ring: those
     * replayed, and a dynamic buffer's left to its draws (`flushHeld`).
     */
    const heldReplays = { replayed: 0, left: 0 };
    /**
     * The host's level locks, as `hostLocks` the buffers': a level with no
     * block yet (the first two of each, and a cube's face), one the guest
     * never locks (`slow`), one a device context is held on (`busy`), one
     * locked already (`held`), one whose bytes may be lent (`lent`, and of
     * those `lentPending`, under a draw the ring held too), one a draw the
     * ring held may sample (`pending`), and any other case. By kind too
     * (`hostLevelKinds`: width x height, format, usage, pool), for the most
     * frequent few.
     */
    const hostLevelLocks = { unplaced: 0, slow: 0, busy: 0, held: 0, lent: 0, lentPending: 0,
        pending: 0, other: 0 };
    /** @type {Map<string, number>} */
    const hostLevelKinds = new Map();
    /** The textures with a block. @type {WeakMap<object, { block: number }>} */
    const textureBlocks = new WeakMap();
    /**
     * The levels the guest locks, by their blocks (`attachLevel`): one is
     * forgotten when its block is settled after its texture has gone.
     * ponytail: a level released while not on the ring keeps its entry and its block;
     * free them from the texture's release if a program that streams textures shows it.
     *
     * @type {Map<number, ShadowLevel>}
     */
    const levels = new Map();
    /** @type {WeakMap<object, number>} */
    const levelBlocks = new WeakMap();
    /**
     * The textures, or surfaces of their own, a device context is held on:
     * their levels' locks are the host's, which refuses them while it is.
     *
     * @type {WeakSet<object>}
     */
    const busyFamilies = new WeakSet();
    /** The surfaces with a block. @type {WeakMap<object, number>} */
    const surfaceBlocks = new WeakMap();
    /** @type {WeakMap<object, number>} */
    const queryBlocks = new WeakMap();
    /** The textures surfaces are levels of, numbered (`SURFACE.CONTAINER`). @type {WeakMap<object, number>} */
    const containerNumbers = new WeakMap();
    let containersNumbered = 0;
    /** Resource blocks are carved from pages of their own, for the same reason as the device's. */
    const pool = { at: 0, left: 0 };
    /** The command ring's bytes in guest memory, 0 for none, and how far the host has read it. */
    let commands = 0;
    /**
     * How deep the host is in holding the device's lock (`SHADOW.HELD`): it
     * is one thread, and its operations call one another.
     */
    let holds = 0;
    /** Takes of the lock that found a routine holding it, the time they waited, and those that broke it. */
    const heldWaits = { count: 0, ms: 0, broken: 0 };
    /** Whether the ring is being taken: a mirror written from inside does not take it again. */
    let taking = false;

    /**
     * A dword's bytes, in one array reused by every write: whoever is handed
     * it copies it at once, and an array made per state written was most of
     * what bringing the block back after a state block allocated.
     */
    const dwordScratch = new Uint8Array(4);
    const dwordScratchWords = new Uint32Array(dwordScratch.buffer);
    /** @param {number} value */
    const dwordBytes = value=>{
        dwordScratchWords[0] = value;
        return dwordScratch;
    };
    /** @param {number[]} values */
    const dwordsBytes = values=>new Uint8Array(values.flatMap(dword));
    /**
     * Guest bytes as words, in place when they are aligned for it and copied
     * when they are not.
     *
     * @param {Uint8Array} bytes
     */
    const wordsOf = bytes=>((bytes.byteOffset & 3) === 0
        ? new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >>> 2)
        : new Uint32Array(
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
    /** @param {number} at @param {number} words */
    const readWords = (at, words)=>wordsOf(deps.readMemory(at, words * 4));
    /** @param {number} at */
    const readWord = deps.readU32 ?? (at=>readWords(at, 1)[0]);
    /** @param {number} bytes @returns {number} a page-aligned span, or 0 */
    const allocatePage = bytes=>{
        // Two pages, so that a whole page is ours whichever boundary the
        // allocation straddles.
        const span = deps.allocate(bytes + PAGE);
        // Unsigned: a block above 2 GB is a key of the host's maps, and the
        // guest hands it back as the unsigned word it reads.
        return span === 0 ? 0 : ((span + PAGE - 1) & ~(PAGE - 1)) >>> 0;
    };
    /** @param {number} bytes @returns {number} a span out of the resource pages, or 0 */
    const carve = bytes=>{
        if (pool.left < bytes)
        {
            pool.at = allocatePage(PAGE);
            pool.left = pool.at === 0 ? 0 : PAGE;
            if (pool.at === 0)
            {
                return 0;
            }
        }
        const block = pool.at;
        pool.at += bytes;
        pool.left -= bytes;
        return block;
    };
    /** @param {string} api @param {string} detail */
    const refuse = (api, detail)=>{
        refused++;
        deps.divergence?.(api, detail);
    };

    /**
     * The device's lock taken for the host, once, however deep its calls go:
     * with threads on other executors a routine of theirs may hold it, for
     * some instructions.
     */
    const hold = ()=>{
        if (holds++ !== 0 || address === 0 || deps.compareExchangeU32 === undefined)
        {
            return;
        }
        const at = address + SHADOW.HELD;
        if (deps.compareExchangeU32(at, 0, HELD_HOST) === 0)
        {
            return;
        }
        const from = performance.now();
        while (deps.compareExchangeU32(at, 0, HELD_HOST) !== 0)
        {
            if (performance.now() - from > HELD_WAIT_MS)
            {
                deps.writeMemory(at, dwordBytes(HELD_HOST));
                heldWaits.broken++;
                refuse(`${name}::lock`, `a routine held the device past ${HELD_WAIT_MS} ms`
                    + ' -- a thread that faulted inside one: taken from it');
                break;
            }
        }
        heldWaits.count++;
        heldWaits.ms += performance.now() - from;
    };
    const letGo = ()=>{
        if (--holds !== 0 || address === 0 || deps.compareExchangeU32 === undefined)
        {
            return;
        }
        // An atomic store, as a routine's own letting go is: what the host
        // wrote under the lock -- a buffer's block settled, a storage freed --
        // is there for the routine on another executor that takes it next. A
        // routine that found the lock taken has written its own mark over the
        // host's, so the word is cleared whatever it holds.
        const at = address + SHADOW.HELD;
        for (let was = readWord(at); ;)
        {
            const seen = deps.compareExchangeU32(at, was, 0);
            if (seen === was)
            {
                break;
            }
            was = seen;
        }
    };
    /**
     * `work` with the device's lock held.
     *
     * @template T @param {() => T} work @returns {T}
     */
    const holding = work=>{
        hold();
        try
        {
            return work();
        }
        finally
        {
            letGo();
        }
    };

    // The host writes what the getters in the guest read: what the device
    // holds, so that the block agrees with the device before the guest reads
    // it, and again whenever the host changed state on its own.

    /** @param {number} state @returns {number | null} what the device holds, if it answers */
    const renderStateOf = state=>{
        /** @type {{ value?: number }} */
        const out = {};
        return device.GetRenderState(state, out) === 0 ? (out.value ?? 0) >>> 0 : null;
    };

    const mirrorRenderStates = ()=>{
        const states = new Uint8Array(SHADOW.RENDER_STATE_COUNT * 4);
        const view = new DataView(states.buffer);
        const valid = new Uint8Array(SHADOW.RENDER_STATE_COUNT / 8);
        for (let state = 0; state < SHADOW.RENDER_STATE_COUNT; state++)
        {
            const answered = renderStateOf(state);
            view.setUint32(state * 4, answered ?? 0, true);
            if (answered !== null)
            {
                valid[state >>> 3] |= 1 << (state & 7);
            }
        }
        deps.writeMemory(address + SHADOW.RENDER_STATES, states);
        deps.writeMemory(address + SHADOW.RENDER_STATE_VALID, valid);
    };

    const mirrorTransforms = ()=>{
        const matrices = new Uint8Array(SHADOW.TRANSFORM_SLOTS * 64);
        const floats = new Float32Array(matrices.buffer);
        for (let slot = 0; slot < SHADOW.TRANSFORM_SLOTS; slot++)
        {
            /** @type {{ matrix?: ArrayLike<number> }} */
            const out = {};
            if (device.GetTransform(transformType(slot), out) === 0 && out.matrix)
            {
                floats.set(out.matrix, slot * 16);
            }
        }
        deps.writeMemory(address + SHADOW.TRANSFORMS, matrices);
    };

    /** @param {number} stage @param {number} type */
    const stageStateOf = (stage, type)=>{
        /** @type {{ value?: number }} */
        const out = {};
        return device.GetTextureStageState(stage, type, out) === 0 ? (out.value ?? 0) >>> 0 : 0;
    };

    const mirrorStageStates = ()=>{
        const values = new Uint32Array(SHADOW.STAGE_COUNT * SHADOW.STAGE_STATE_STRIDE);
        for (let stage = 0; stage < SHADOW.STAGE_COUNT; stage++)
        {
            for (let type = 0; type < SHADOW.STAGE_STATE_STRIDE; type++)
            {
                values[stage * SHADOW.STAGE_STATE_STRIDE + type] = stageStateOf(stage, type);
            }
        }
        deps.writeMemory(address + SHADOW.STAGE_STATES, new Uint8Array(values.buffer));
    };

    /** @param {number} type */
    const refreshTransform = type=>{
        const slot = transformSlot(type);
        if (address === 0 || slot < 0)
        {
            return;
        }
        /** @type {{ matrix?: ArrayLike<number> }} */
        const out = {};
        if (device.GetTransform(type, out) !== 0 || !out.matrix)
        {
            return;
        }
        deps.writeMemory(address + SHADOW.TRANSFORMS + slot * 64,
            new Uint8Array(new Float32Array(out.matrix).buffer));
    };

    const mirrorViewport = ()=>{
        /** @type {{ viewport?: { X: number, Y: number, Width: number, Height: number,
         *     MinZ: number, MaxZ: number }, depthWords?: [number, number] }} */
        const out = {};
        if (typeof device.GetViewport !== 'function' || device.GetViewport(out) !== 0
            || !out.viewport)
        {
            return;
        }
        const { X, Y, Width, Height, MinZ, MaxZ } = out.viewport;
        const words = new Uint32Array([X, Y, Width, Height, 0, 0]);
        new Float32Array(words.buffer, 16, 2).set([MinZ, MaxZ]);
        // The words the program set, where the device kept them: a
        // signalling NaN through a number would come out quiet.
        if (out.depthWords)
        {
            words[4] = out.depthWords[0];
            words[5] = out.depthWords[1];
        }
        deps.writeMemory(address + SHADOW.VIEWPORT, new Uint8Array(words.buffer));
    };

    /** @param {number} sampler @param {number} type */
    const samplerStateOf = (sampler, type)=>{
        /** @type {{ value?: number }} */
        const out = {};
        return device.GetSamplerState?.(sampler, type, out) === 0 ? (out.value ?? 0) >>> 0 : 0;
    };

    const mirrorSamplerStates = ()=>{
        if (typeof device.GetSamplerState !== 'function')
        {
            return;
        }
        const values = new Uint32Array(SHADOW.SAMPLER_COUNT * SHADOW.SAMPLER_STATE_STRIDE);
        for (let sampler = 0; sampler < SHADOW.SAMPLER_COUNT; sampler++)
        {
            for (let type = 0; type < SHADOW.SAMPLER_STATE_STRIDE; type++)
            {
                values[sampler * SHADOW.SAMPLER_STATE_STRIDE + type] =
                    samplerStateOf(sampler, type);
            }
        }
        deps.writeMemory(address + SHADOW.SAMPLER_STATES, new Uint8Array(values.buffer));
    };

    /**
     * The values the host has seen the device take that the guest may take
     * on its own (`SHADOW.VALIDATED`), a list per table, newest last; the
     * oldest goes when there is no room.
     *
     * @type {number[][]}
     */
    const validated = Array.from({ length: SHADOW.VALIDATED_TABLES }, ()=>[]);

    /**
     * What the command routines check a call against (`commandChecks`):
     * whether a draw would be taken, the target's size, the clip planes,
     * and the values the device has taken that are taken for their value.
     */
    const mirrorCommandState = ()=>{
        const state = device.ringState?.();
        if (!state)
        {
            return;
        }
        const words = new Uint32Array((SHADOW.LOCK_RING - SHADOW.DRAWABLE) / 4);
        words[0] = state.drawable;
        words[1] = state.targetWidth;
        words[2] = state.targetHeight;
        words[3] = state.clipPlanes;
        validated.forEach((list, table)=>{
            const taken = state.taken[table] ?? 0;
            if (taken !== 0 && !list.includes(taken))
            {
                list.push(taken);
                if (list.length > SHADOW.VALIDATED_SLOTS)
                {
                    list.shift();
                }
            }
            // A value the device no longer takes -- a shader since deleted --
            // is not one to take again.
            const takes = state.takes?.[table];
            for (let index = list.length - 1; index >= 0; index--)
            {
                if (takes && !takes(list[index]))
                {
                    list.splice(index, 1);
                }
            }
            words.set(list, (SHADOW.VALIDATED - SHADOW.DRAWABLE) / 4
                + table * SHADOW.VALIDATED_SLOTS);
        });
        deps.writeMemory(address + SHADOW.DRAWABLE, new Uint8Array(words.buffer));
        deps.writeMemory(address + SHADOW.COOPERATIVE,
            dwordsBytes([state.cooperative ?? 1, state.elsewhere ?? 0]));
        if (state.strides)
        {
            const pairs = new Uint32Array(SHADOW.FVF_STRIDE_PAIRS * 2);
            state.strides.slice(0, SHADOW.FVF_STRIDE_PAIRS).forEach(([fvf, stride], index)=>{
                pairs[index * 2] = fvf;
                pairs[index * 2 + 1] = stride;
            });
            deps.writeMemory(address + SHADOW.FVF_STRIDES, new Uint8Array(pairs.buffer));
        }
        if (state.stateBlocks)
        {
            const bits = new Uint8Array(SHADOW.STATE_BLOCK_TOKENS / 4);
            for (const [token, draws] of state.stateBlocks)
            {
                if (token < SHADOW.STATE_BLOCK_TOKENS)
                {
                    bits[token >>> 3] |= 1 << (token & 7);
                    bits[SHADOW.STATE_BLOCK_TOKENS / 8 + (token >>> 3)] |= draws ? 1 << (token & 7)
                        : 0;
                }
            }
            deps.writeMemory(address + SHADOW.STATE_BLOCKS, bits);
        }
        if (state.shaders)
        {
            deps.writeMemory(address + SHADOW.SHADERS,
                dwordsBytes([state.shaders[0] >>> 0, state.shaders[1] >>> 0, 1]));
        }
        if (state.targets && deps.handedOut)
        {
            /** A surface's pair, or null for one the guest cannot hand out. @param {any} surface */
            const pairOf = surface=>{
                const [pointer, cell] = /** @type {(surface: any) => number[]} */ (deps.handedOut)(
                    surface);
                return pointer !== 0 && cell !== 0 ? [pointer >>> 0, cell >>> 0] : null;
            };
            const target = state.targets[0] ? pairOf(state.targets[0]) : null;
            // No depth surface is an answer the guest gives too.
            const depth = state.targets[1] ? pairOf(state.targets[1]) : [0, 0];
            deps.writeMemory(address + SHADOW.TARGETS, dwordsBytes([...target ?? [0, 0],
                ...depth ?? [0, 0], (target ? 1 : 0) | (depth ? 2 : 0)]));
        }
    };

    const mirror = ()=>{
        mirrorRenderStates();
        mirrorTransforms();
        mirrorStageStates();
        mirrorViewport();
        mirrorSamplerStates();
        mirrorCommandState();
    };

    /**
     * What was just unlocked on the host may be lent to the graphics worker:
     * the guest's next lock that may write over it comes to the host.
     *
     * @param {number} block
     */
    const markLent = block=>{
        if (device.lendsMemory === true)
        {
            deps.writeMemory(block + BUFFER.LENT, dwordBytes(1));
        }
    };

    /**
     * Whether the host holds a lock of the buffer the guest may let go of:
     * the host's unlock reads the bytes only when it next looks, so until
     * then a lock that may write over them -- a DISCARD or one with neither
     * flag, in place -- comes to the host, which lets its own go first, or
     * moves the buffer off them. Said as what was lent is (`LENT`), which the
     * routine already treats so; a device that lends keeps it set.
     *
     * @param {number} block @param {boolean} held
     */
    const noteHostHolds = (block, held)=>{
        if (held)
        {
            deps.writeMemory(block + BUFFER.LENT, dwordBytes(1));
        }
        else if (device.lendsMemory !== true)
        {
            deps.writeMemory(block + BUFFER.LENT, ZERO_WORD);
        }
    };

    /**
     * Whether a recording may lend a level's bytes, as it decides: a level it
     * copies instead is the guest's to lock.
     *
     * @param {ShadowLevel} entry
     */
    const lentLevel = entry=>device.lendsMemory === true && entry.lends
        && device.lendsAt?.(entry.base) !== false;

    /**
     * Whether a level's locks are the host's: a level the guest cannot lock,
     * one a device context is held on, and one whose bytes a recording may
     * lend to the graphics worker (`ShadowLevel.lends`), which only the
     * host's lock claims back before the program writes over them.
     *
     * @param {ShadowLevel} entry
     */
    const levelFlags = entry=>(entry.slow || busyFamilies.has(entry.family) || lentLevel(entry)
        ? FLAG_SLOW_PATH : 0);

    /**
     * Replays what the guest did to a level, as `settle` a buffer's: the lock
     * it took, with its box and flags, and the unlock if it has let go since.
     *
     * @param {number} block @param {ShadowLevel} entry
     */
    const settleLevel = (block, entry)=>{
        if (entry.level.refCount <= 0)
        {
            levels.delete(block);
            return;
        }
        const words = readWords(block, LEVEL.SIZE / 4);
        const locked = words[LEVEL.LOCKED / 4] !== 0;
        if (words[LEVEL.TAKEN / 4] !== 0)
        {
            const at = LEVEL.BOX / 4;
            const box = words[LEVEL.BOXED / 4] === 0 ? null : {
                left: words[at], top: words[at + 1], right: words[at + 2],
                bottom: words[at + 3], front: words[at + 4], back: words[at + 5],
            };
            const flags = words[LEVEL.LOCK_FLAGS / 4];
            if (entry.hostLocked)
            {
                // The host's own lock, let go of in the guest before this one.
                entry.unlock();
                entry.hostLocked = false;
            }
            entry.hostLocked = entry.lock(box, flags) === 0;
            if (!entry.hostLocked)
            {
                refuse('LockRect', 'a lock of a level taken in the guest was accepted;'
                    + ' the level refuses it');
            }
            deps.writeMemory(block + LEVEL.TAKEN, ZERO_WORD);
        }
        if (entry.hostLocked && !locked)
        {
            entry.unlock();
            entry.hostLocked = false;
        }
    };

    /**
     * The device made a move the guest wrote into the ring (`lockCode`): the
     * storage left sits in the spare's place in the block, and the guest may
     * move onto it again -- every draw before the move has been made, its
     * bytes sent, and the recording has claimed what was lent of it.
     *
     * @param {number} block @param {number} left
     */
    const leftBehind = (block, left)=>{
        moved.made++;
        const slot = readWords(block + BUFFER.SPARES, BUFFER.SPARE_COUNT).indexOf(left);
        if (slot >= 0)
        {
            deps.writeMemory(block + BUFFER.SPARE_FREE + slot * 4, dwordBytes(1));
        }
    };

    /**
     * A DISCARD of a dynamic buffer came to the host under draws the ring
     * held, or over lent bytes: the buffer gets another storage, which the
     * guest's next such lock moves it onto instead (`d3d8/storages.js`).
     * Memory only for a buffer a program discards that way.
     *
     * @param {number} block @param {ShadowBuffer} buffer
     */
    const addSpare = (block, buffer)=>{
        if (typeof buffer.AddStorage !== 'function'
            || ((buffer.usage ?? 0) & D3DUSAGE_DYNAMIC) === 0)
        {
            return;
        }
        const slot = readWords(block + BUFFER.SPARES, BUFFER.SPARE_COUNT).indexOf(0);
        if (slot < 0)
        {
            return;
        }
        const storage = buffer.AddStorage();
        if (storage === 0)
        {
            return;
        }
        moved.storages++;
        holding(()=>{
            deps.writeMemory(block + BUFFER.SPARES + slot * 4, dwordBytes(storage));
            deps.writeMemory(block + BUFFER.SPARE_FREE + slot * 4, dwordBytes(1));
        });
    };

    /**
     * Buffers the guest moved onto another storage whose move the ring has
     * not had made yet: what the block says the guest locked is the new
     * storage's, which the device does not hold until the move, so it is
     * replayed after the ring's run (`settleMoved`); the draws in the run
     * have sent what they read of either storage (`drawsFrom`).
     *
     * @type {Set<number>}
     */
    const renamedPending = new Set();
    /** @param {number} block @param {{ buffer: ShadowBuffer }} entry */
    const movedAhead = (block, entry)=>readWord(block + BUFFER.BASE) !== entry.buffer.base;
    /** After a run of the ring: the replays the moves held back. */
    const settleMoved = ()=>{
        for (const block of renamedPending)
        {
            const entry = blocks.get(block);
            if (entry && movedAhead(block, entry))
            {
                continue;
            }
            renamedPending.delete(block);
            if (readWord(block + BUFFER.LOCKED) !== 0)
            {
                flushHeld(block);
            }
            else
            {
                settle(block);
            }
        }
    };

    /** Ranges the guest unlocked, as `settle` met them: sent, or why not. */
    const settled = { sent: 0, unknown: 0, released: 0, unattached: 0 };
    /**
     * A range the guest unlocked that reaches no buffer of the device: said
     * as a loss, since a draw from it reads bytes never sent.
     *
     * @param {number} block @param {'unknown' | 'released'} why
     */
    const unsent = (block, why)=>{
        if (readWord(block + BUFFER.TO) <= readWord(block + BUFFER.FROM))
        {
            return;
        }
        settled[why]++;
        deps.divergence?.('IDirect3DVertexBuffer::Unlock', why === 'unknown'
            ? 'a range unlocked in the guest is of a block this device does not know'
            : 'a range unlocked in the guest is of a buffer its program released', 'loss');
    };

    /**
     * Replays what the guest did to one buffer against the real one. The
     * block says whether a lock is held and what range was locked since the
     * host last looked; the host's own lock mirrors the guest's, so that the
     * real buffer refuses a second lock the way the guest's block does.
     *
     * @param {number} block
     */
    const settle = block=>{
        const entry = blocks.get(block);
        if (!entry)
        {
            unsent(block, 'unknown');
            return;
        }
        if (entry.buffer.refCount <= 0)
        {
            // Released by the program with an unlock still on the ring.
            unsent(block, 'released');
            blocks.delete(block);
            return;
        }
        if (movedAhead(block, entry))
        {
            // A lock of the host's the guest let go of before it moved: its
            // bytes are the storage the device still holds.
            if (entry.hostLocked)
            {
                entry.buffer.Unlock();
                entry.hostLocked = false;
                noteHostHolds(block, false);
            }
            moved.deferred++;
            renamedPending.add(block);
            return;
        }
        const words = readWords(block, BUFFER.SIZE / 4);
        const locked = words[BUFFER.LOCKED / 4] !== 0;
        const from = words[BUFFER.FROM / 4];
        const to = words[BUFFER.TO / 4];
        if (to > from)
        {
            if (entry.hostLocked)
            {
                entry.buffer.Unlock();
                entry.hostLocked = false;
            }
            if (entry.buffer.Lock(from, to - from, {},
                replayedFlags(words[BUFFER.LOCK_FLAGS / 4])) === 0)
            {
                entry.hostLocked = true;
                if (locked)
                {
                    // Still being written in the guest -- another thread came
                    // in, or the program's own call between its lock and its
                    // unlock. What it unlocked before reaches the device now,
                    // for the draws in the ring that read it; what it is
                    // writing comes at its unlock, under a lock taken again
                    // that keeps what the buffer holds.
                    entry.buffer.Unlock();
                    entry.hostLocked = entry.buffer.Lock(from, to - from, {},
                        D3DLOCK_NOOVERWRITE) === 0;
                }
            }
            else
            {
                refuse('IDirect3DVertexBuffer8::Lock',
                    `a lock of ${from}..${to} taken in the guest was accepted;`
                    + ' the buffer refuses it');
            }
            deps.writeMemory(block + BUFFER.FROM, new Uint8Array(12));
            markLent(block);
            settled.sent++;
        }
        if (entry.hostLocked && !locked)
        {
            entry.buffer.Unlock();
            entry.hostLocked = false;
        }
        noteHostHolds(block, entry.hostLocked);
    };


    /**
     * What the guest has written into buffers it still holds locked reaches
     * the device before the ring's calls are made: a draw in the ring may
     * read it. A buffer is settled at its unlock, and a host entry while it
     * was still locked -- another call between two quads of one lock -- made
     * the ring's draws of it before what they read was there.
     * Dynamic buffers, those the guest has unlocked once, and those its lock
     * routine named since the last look are looked at.
     */
    const settleHeld = ()=>{
        // Every lock taken and every one let go of is counted -- by the
        // routines that made it, or by `noteLocked` for the host's -- so the
        // difference is what is held. None, and the usual entry costs two
        // words instead of a look at every buffer the guest ever let go of.
        const locks = readWord(address + SHADOW.LOCK_CALLS);
        if (locks + hostTaken === readWord(address + SHADOW.UNLOCK_CALLS) + hostReleased)
        {
            heldLocks.clear();
            heldSince = locks;
            return;
        }
        // What may be held: what was at the last look, and what the routine
        // has locked since, which its ring names -- unless it has gone round.
        const taken = (locks - heldSince) >>> 0;
        if (taken > SHADOW.LOCK_RING_CAPACITY)
        {
            heldLocks.clear();
            for (const block of lockedInGuest)
            {
                heldLocks.add(block);
            }
        }
        else if (taken > 0)
        {
            // A buffer locked for the first time and drawn from before its
            // unlock reads what is written so far, as one locked again does
            // (Wine's d3d9 test_draw_mapped_buffer): from here on it is one
            // the guest locks itself.
            const ring = readWords(address + SHADOW.LOCK_RING, SHADOW.LOCK_RING_CAPACITY);
            for (let n = heldSince; n !== locks; n = (n + 1) >>> 0)
            {
                const block = ring[n & (SHADOW.LOCK_RING_CAPACITY - 1)];
                heldLocks.add(block);
                if (blocks.has(block))
                {
                    lockedInGuest.add(block);
                }
            }
        }
        heldSince = locks;
        for (const block of heldLocks)
        {
            if (!live(block) || !lockedInGuest.has(block))
            {
                lockedInGuest.delete(block);
                heldLocks.delete(block);
                continue;
            }
            if (!flushHeld(block))
            {
                heldLocks.delete(block);
            }
        }
    };
    /**
     * A block's entry while its buffer is the program's; one released --
     * which a dynamic buffer may be while it still counts as held -- is
     * forgotten here, so the host never locks it again: the played device has
     * let it go.
     *
     * @param {number} block
     */
    const live = block=>{
        const entry = blocks.get(block);
        if (entry && entry.buffer.refCount <= 0)
        {
            blocks.delete(block);
            lockedInGuest.delete(block);
            heldLocks.delete(block);
            return undefined;
        }
        return entry;
    };
    /** The blocks that may be held locked in the guest, as `settleHeld` last found them. */
    const heldLocks = new Set();
    /** The lock routine's count at that look. */
    let heldSince = 0;

    /**
     * What the guest has written so far into a buffer it holds locked, sent
     * through a lock and unlock on the host; the range stays in the block for
     * the unlock to send again with what is written after, less its DISCARD,
     * which this has done. The host keeps no lock of its own: a draw it made
     * of a locked buffer reads the locked range as guest memory holds it at
     * the draw, and a draw from the ring is made after the program wrote on.
     *
     * @param {number} block
     * @returns {boolean}  whether the guest holds it locked
     */
    const flushHeld = block=>{
        const entry = live(block);
        if (!entry || readWord(block + BUFFER.LOCKED) === 0)
        {
            return false;
        }
        if (entry.hostLocked)
        {
            return true;
        }
        const words = readWords(block, BUFFER.SIZE / 4);
        const flags = words[BUFFER.LOCK_FLAGS / 4];
        if (((entry.buffer.usage ?? 0) & D3DUSAGE_DYNAMIC) !== 0
            && (flags & (D3DLOCK_DISCARD | LOCK_IN_PLACE)) === 0)
        {
            // A dynamic buffer's draws read what they reach out of guest
            // memory at the draw, so what is written under NOOVERWRITE needs
            // no replay until the unlock; only a lock in place, whose rename
            // has to come before the draws after it, is replayed here. Call
            // of Duty 4 holds a 4.5 MB skinning buffer all frame: replayed at
            // each of a frame's calls into the host, each replay over draws
            // not yet submitted renamed and carried all of it.
            heldReplays.left++;
            return true;
        }
        if (movedAhead(block, entry))
        {
            moved.deferred++;
            renamedPending.add(block);
            return true;
        }
        const from = words[BUFFER.FROM / 4];
        const to = words[BUFFER.TO / 4];
        if (words[BUFFER.LOCKED / 4] === 0 || to <= from)
        {
            return true;
        }
        heldReplays.replayed++;
        if (entry.buffer.Lock(from, to - from, {}, replayedFlags(flags)) === 0)
        {
            entry.buffer.Unlock();
            markLent(block);
        }
        // Replayed before the run, as the lock in place has to be.
        if ((flags & (D3DLOCK_DISCARD | LOCK_IN_PLACE)) !== 0)
        {
            flagWord[0] = flags & ~(D3DLOCK_DISCARD | LOCK_IN_PLACE);
            deps.writeMemory(block + BUFFER.LOCK_FLAGS, flagBytes);
        }
        return true;
    };
    /** The flags word written back, without a buffer made for each. */
    const flagWord = new Uint32Array(1);
    const flagBytes = new Uint8Array(flagWord.buffer);

    /** What settleUnlocked read: the two counts, a word of room, the ring. */
    const settledWords = new Uint32Array(3 + SHADOW.RING_CAPACITY);
    /** The command ring's reader, once the block has one. @type {ReturnType<typeof createCommandReader> | null} */
    let commandReader = null;

    /**
     * Replays the locks and unlocks of buffers the guest let go of since the
     * host last looked, and empties the ring of them. The routines' two
     * counts lie just before the ring, so one read takes them with it.
     *
     * @param {number} heads  how many the ring holds
     */
    const settleUnlocked = heads=>{
        const count = Math.min(heads, SHADOW.RING_CAPACITY);
        const read = readWords(address + SHADOW.LOCK_CALLS, 3 + count);
        if (read.length < 3 + count)
        {
            // No memory to read -- a machine that has stopped.
            return;
        }
        // Copied before the writes below change what was read, into a buffer
        // kept for it: this runs at every sync, and a copy each was garbage.
        settledWords.set(read);
        const words = settledWords;
        lockCalls = words[0];
        unlockCalls = words[1];
        for (let at = 3; at < 3 + count; at++)
        {
            const buffer = words[at];
            deps.writeMemory(buffer + BUFFER.QUEUED, ZERO_WORD);
            const level = levels.get(buffer);
            if (level)
            {
                settleLevel(buffer, level);
                continue;
            }
            lockedInGuest.add(buffer);
            settle(buffer);
        }
        deps.writeMemory(address + SHADOW.RING_HEAD, ZERO_WORD);
    };

    /**
     * `sync` with its parts as phases of their own, in a host call being
     * timed: the buffers let go of, and the ring's calls with the held
     * buffers settled before them.
     */
    const timedSync = ()=>{
        const held = /** @type {ShadowPhases} */ (phases);
        const unlocked = readWord(address + SHADOW.RING_HEAD);
        if (unlocked !== 0)
        {
            const weight = held.begin('ring-unlocked');
            try
            {
                settleUnlocked(unlocked);
            }
            finally
            {
                held.end('ring-unlocked', weight);
            }
        }
        if (commands !== 0 && commandReader !== null)
        {
            const weight = held.begin('ring-take');
            try
            {
                taking = true;
                commandReader.take(()=>{
                    const inner = held.begin('ring-held');
                    try
                    {
                        settleHeld();
                    }
                    finally
                    {
                        held.end('ring-held', inner);
                    }
                });
                if (renamedPending.size > 0)
                {
                    settleMoved();
                }
            }
            finally
            {
                taking = false;
                held.end('ring-take', weight);
            }
        }
    };

    /** `sync`'s work: the buffers the guest let go of, then the ring. */
    const syncNow = ()=>{
        // The work every host call starts with, outside the method it was
        // asked for: unaccounted, it was read as the call's own time, and
        // a share of the thread that a profile found only here.
        const weight = phases === null ? 0 : phases.begin('ring-sync');
        if (weight !== 0)
        {
            try
            {
                timedSync();
            }
            finally
            {
                /** @type {ShadowPhases} */ (phases).end('ring-sync', weight);
            }
            return;
        }
        const unlocked = readWord(address + SHADOW.RING_HEAD);
        if (unlocked !== 0)
        {
            settleUnlocked(unlocked);
        }
        if (commands !== 0)
        {
            // Held buffers only when the ring has calls that may read
            // them: settling at every entry read every held range again
            // at each of thousands of host calls a frame.
            taking = true;
            try
            {
                commandReader?.take(settleHeld);
                if (renamedPending.size > 0)
                {
                    settleMoved();
                }
            }
            finally
            {
                taking = false;
            }
        }
    };

    /**
     * `sync`'s work in one pause of the program's: a dynamic buffer compared
     * at its unlock is not compared again by the ring's draws from it.
     */
    const syncAll = ()=>{
        if (address === 0)
        {
            return;
        }
        if (deps.still)
        {
            deps.still(syncNow);
            return;
        }
        syncNow();
    };
    /**
     * Before the host writes a mirror from what the device holds: the calls
     * other threads' routines recorded meanwhile made first, so the mirror is
     * not put back behind them -- unless this is the ring being made.
     */
    const caughtUp = ()=>{
        if (!taking)
        {
            syncAll();
        }
    };

    /** The block, made and mirrored on first use. */
    const place = ()=>{
        if (address === 0)
        {
            address = allocatePage(PAGES * PAGE);
            if (address !== 0)
            {
                deps.writeMemory(address, new Uint8Array(SHADOW.SIZE));
                mirror();
                // Pages of its own, as the block's are: the routines write it
                // on every command.
                commands = deps.commands ? allocatePage(ringBytes) : 0;
                if (commands !== 0)
                {
                    placeCommandRing(address, commands, deps.writeMemory, ringBytes);
                    commandReader = createCommandReader({ block: address, ring: commands,
                        readWord, readWords, writeMemory: deps.writeMemory,
                        compareExchangeU32: deps.compareExchangeU32, loadU32: deps.loadU32,
                        take: /** @type {ShadowCommands} */ (deps.commands).take,
                        refuse: detail=>refuse(`${name}::commands`, detail),
                        bytes: ringBytes });
                }
            }
        }
        return address;
    };


    /**
     * `noteLocked`'s work, the device's lock held.
     *
     * @param {number} block @param {{ hostLocked: boolean }} entry @param {boolean} locked
     */
    const noteLockedNow = (block, entry, locked)=>{
        entry.hostLocked = locked;
        // The routines count only the locks and unlocks they make; one
        // the host makes is counted here, so that what is held can be
        // told from the four numbers (`settleHeld`).
        const was = readWord(block + BUFFER.LOCKED) !== 0;
        if (was !== locked)
        {
            if (locked)
            {
                hostTaken++;
            }
            else
            {
                hostReleased++;
            }
        }
        deps.writeMemory(block + BUFFER.LOCKED, dwordBytes(locked ? 1 : 0));
        // Never cleared: a lock claims only its own range, and what was
        // lent elsewhere in the buffer may still be unread.
        // ponytail: a lending device's DISCARD and plain locks all come to the host; clear
        // it after a lock of the whole buffer if those traps show up in a profile.
        if (!locked)
        {
            markLent(block);
        }
        noteHostHolds(block, locked);
    };

    /**
     * The block brought to what the device holds: the states named, or all
     * of it (`remirror`).
     *
     * @param {{ renderStates?: Iterable<number>, transforms?: Iterable<number>,
     *     stageStates?: true | Iterable<number>, viewport?: boolean,
     *     samplerStates?: Iterable<number> }} [touched]
     */
    const remirrorNow = touched=>{
        if (!touched)
        {
            mirror();
            return;
        }
        for (const state of touched.renderStates ?? [])
        {
            if (state >= 0 && state < SHADOW.RENDER_STATE_COUNT)
            {
                deps.writeMemory(address + SHADOW.RENDER_STATES + state * 4,
                    dwordBytes(renderStateOf(state) ?? 0));
            }
        }
        for (const type of touched.transforms ?? [])
        {
            refreshTransform(type);
        }
        if (touched.viewport)
        {
            mirrorViewport();
        }
        for (const key of touched.samplerStates ?? [])
        {
            const sampler = key >>> 8;
            const type = key & 0xff;
            if (sampler < SHADOW.SAMPLER_COUNT && type < SHADOW.SAMPLER_STATE_STRIDE)
            {
                deps.writeMemory(address + SHADOW.SAMPLER_STATES
                    + (sampler * SHADOW.SAMPLER_STATE_STRIDE + type) * 4,
                dwordBytes(samplerStateOf(sampler, type)));
            }
        }
        if (touched.stageStates === true)
        {
            mirrorStageStates();
            return;
        }
        for (const key of touched.stageStates ?? [])
        {
            const stage = key >>> 8;
            const type = key & 0xff;
            if (stage < SHADOW.STAGE_COUNT && type < SHADOW.STAGE_STATE_STRIDE)
            {
                const slot = stage * SHADOW.STAGE_STATE_STRIDE + type;
                deps.writeMemory(address + SHADOW.STAGE_STATES + slot * 4,
                    dwordBytes(stageStateOf(stage, type)));
            }
        }
    };

    return {
        address: place,

        /**
         * Whether the fast path is to stand aside. Raised while a state block
         * records, so every call reaches the host as it is made.
         *
         * @param {boolean} on
         */
        slowPath(on){
            slow = on;
            if (address !== 0)
            {
                holding(()=>{
                    const flags = readWord(address + SHADOW.FLAGS) & ~FLAG_SLOW_PATH;
                    deps.writeMemory(address + SHADOW.FLAGS,
                        dwordBytes(flags | (on ? FLAG_SLOW_PATH : 0)));
                });
            }
        },

        /**
         * Whether a state block applied in the ring may have left what the
         * block mirrors behind the device (`FLAG_STALE`).
         */
        stale: ()=>address !== 0 && (readWord(address + SHADOW.FLAGS) & FLAG_STALE) !== 0,

        /** What the block mirrors is the device's again. */
        fresh(){
            if (address !== 0)
            {
                holding(()=>deps.writeMemory(address + SHADOW.FLAGS,
                    dwordBytes(readWord(address + SHADOW.FLAGS) & ~(FLAG_STALE
                        | FLAG_DRAW_STALE))));
            }
        },

        /**
         * After the host changed state on its own -- a state block applied, a
         * reset -- the block is brought to what the device now holds: the
         * states named, or all of it. A small state block applied between
         * draws is common, and reading back every state the block holds cost
         * each Apply hundreds of calls into the device.
         *
         * @param {{ renderStates?: Iterable<number>, transforms?: Iterable<number>,
         *     stageStates?: true | Iterable<number>, viewport?: boolean,
         *     samplerStates?: Iterable<number> }} [touched]  stage states by
         *     (stage << 8) | type, or every one of them (true); sampler states
         *     by (sampler << 8) | type
         */
        remirror(touched){
            if (address !== 0)
            {
                holding(()=>{
                    caughtUp();
                    remirrorNow(touched);
                });
            }
        },

        /**
         * The same for a transform the host changed itself -- one multiplied
         * by MultiplyTransform, which works on what the device holds.
         *
         * @param {number} type
         */
        refreshTransform: type=>holding(()=>{
            caughtUp();
            refreshTransform(type);
        }),

        /**
         * After the host made a call of the device's itself: what the command
         * routines check a call against is the device's again.
         */
        settled(){
            if (address !== 0)
            {
                holding(()=>{
                    caughtUp();
                    mirrorCommandState();
                });
            }
        },

        /**
         * Makes what the guest did since the last entry reach the device: the
         * buffers it let go of first, then the calls in the command ring that
         * may read them.
         */
        sync(){
            if (address !== 0)
            {
                holding(syncAll);
            }
        },

        /**
         * `sync` before an object's count is read or lowered on the host, when
         * what waits in the ring can bind or unbind it: it is bound now (a
         * record may let it go), a record names one of its pointers, a state
         * block applied in the ring may hold it, or it shares a container's
         * count, which a record names by the container. Otherwise the ring
         * waits for the next entry: a texture let go of mid-frame played a
         * frame's records for nothing.
         *
         * @param {{ container?: any, counter?: { held?: number } }} object
         * @param {Set<number>} [pointers]  where it was published
         */
        syncFor(object, pointers){
            if (address === 0)
            {
                return;
            }
            const free = pointers !== undefined && pointers.size > 0
                && object.container === undefined && object.counter?.held === 0
                && (readWord(address + SHADOW.FLAGS) & FLAG_STALE) === 0
                && !(commandReader?.holds(word=>pointers.has(word)) ?? false);
            if (!free)
            {
                holding(syncAll);
            }
        },

        /**
         * A buffer's block, made on first use: where its bytes are, and the
         * device's block for the counters and the ring.
         *
         * @param {ShadowBuffer} buffer
         * @returns {number} the block, or 0 when there is no memory for one
         */
        attachBuffer(buffer){
            const existing = blockOf.get(buffer);
            if (existing !== undefined)
            {
                return existing;
            }
            const owner = place();
            if (owner === 0)
            {
                return 0;
            }
            const block = carve(BUFFER.SIZE);
            if (block === 0)
            {
                return 0;
            }
            const spares = (buffer.storages ?? []).filter(storage=>storage !== buffer.base)
                .slice(0, BUFFER.SPARE_COUNT);
            deps.writeMemory(block, dwordsBytes([0, buffer.base, buffer.length, 0, 0, 0, 0, owner,
                0, 0, spares[0] ?? 0, spares[1] ?? 0, spares.length > 0 ? 1 : 0,
                spares.length > 1 ? 1 : 0]));
            blocks.set(block, { buffer, hostLocked: false });
            buffer.renamed = left=>leftBehind(block, left);
            // A dynamic buffer is the kind a program holds locked while it
            // draws from it, from its very first lock.
            if (((buffer.usage ?? 0) & D3DUSAGE_DYNAMIC) !== 0)
            {
                lockedInGuest.add(block);
            }
            blockOf.set(buffer, block);
            return block;
        },

        /**
         * A Direct3D 7 vertex buffer's block, made beside its interface when
         * the buffer was (`VERTEX_BUFFER7`), taken by this device's block:
         * its storage and this block written into it, so the guest's Lock and
         * Unlock keep it from here on and the host replays what they did, as
         * `attachBuffer`'s. A buffer another device's block took stays that
         * one's.
         *
         * @param {ShadowBuffer} buffer @param {number} block
         * @returns {boolean} whether this device's block holds it
         */
        adoptBuffer(buffer, block){
            const existing = blockOf.get(buffer);
            if (existing !== undefined)
            {
                return existing === block;
            }
            const owner = place();
            if (owner === 0 || block === 0 || readWord(block + BUFFER.DEVICE) !== 0)
            {
                return false;
            }
            holding(()=>{
                deps.writeMemory(block + BUFFER.BASE, dwordsBytes([buffer.base, buffer.length]));
                deps.writeMemory(block + BUFFER.DEVICE, dwordBytes(owner));
            });
            blocks.set(block, { buffer, hostLocked: readWord(block + BUFFER.LOCKED) !== 0 });
            blockOf.set(buffer, block);
            return true;
        },

        /**
         * A texture's block, made on first use: how many levels it has, where
         * its count is kept, and a table of their pointers the host fills in
         * as it publishes them.
         *
         * @param {ShadowTexture} texture
         * @param {number} [count]  the word its count is kept in, 0 for none
         * @param {number[]} [extent]  its top level's width, height and depth, which
         *     a dirty rectangle or box in the guest may not leave
         * @returns {number} the block, or 0 when there is no memory for one
         */
        attachTexture(texture, count = 0, extent = [0, 0, 0]){
            const existing = textureBlocks.get(texture);
            if (existing)
            {
                return existing.block;
            }
            const owner = place();
            const block = carve(TEXTURE.SIZE);
            if (block === 0)
            {
                return 0;
            }
            const zeroed = new Uint8Array(TEXTURE.SIZE);
            zeroed.set(dwordBytes(texture.levels ?? 1), TEXTURE.LEVEL_COUNT);
            zeroed.set(dwordBytes(count), TEXTURE.COUNT);
            // No extent, no dirty region in the guest: an empty one refuses them all.
            zeroed.set(dwordsBytes([owner, ...extent]), TEXTURE.DEVICE);
            deps.writeMemory(block, zeroed);
            textureBlocks.set(texture, { block });
            return block;
        },

        /**
         * A surface's block, made on first use, with its description, which
         * `describe` writes at the address it is given.
         *
         * @param {object} surface @param {(at: number) => void} describe
         * @returns {number} the block, or 0 when there is no memory for one
         */
        attachSurface(surface, describe){
            const existing = surfaceBlocks.get(surface);
            if (existing !== undefined)
            {
                return existing;
            }
            const block = carve(SURFACE.SIZE);
            if (block === 0)
            {
                return 0;
            }
            deps.writeMemory(block, new Uint8Array(SURFACE.SIZE));
            describe(block + SURFACE.DESC);
            deps.writeMemory(block + SURFACE.LEVEL, dwordBytes(levelBlocks.get(surface) ?? 0));
            deps.writeMemory(block + SURFACE.OWNER, dwordBytes(address));
            const container = /** @type {{ container?: object }} */ (surface).container;
            if (container)
            {
                let number = containerNumbers.get(container);
                if (number === undefined)
                {
                    number = ++containersNumbered;
                    containerNumbers.set(container, number);
                }
                deps.writeMemory(block + SURFACE.CONTAINER, dwordBytes(number));
            }
            surfaceBlocks.set(surface, block);
            return block;
        },

        /**
         * A query's block, made on first use: its type, for the guest's
         * methods of an event query.
         *
         * @param {{ type: number }} query
         * @returns {number} the block, or 0 when there is no memory for one
         */
        attachQuery(query){
            const existing = queryBlocks.get(query);
            if (existing !== undefined)
            {
                return existing;
            }
            const block = carve(QUERY.SIZE);
            if (block === 0)
            {
                return 0;
            }
            deps.writeMemory(block, dwordsBytes([0, query.type, 0, 0, 0]));
            queryBlocks.set(query, block);
            return block;
        },

        /**
         * A level's block (`LEVEL`), made the first time the guest is to lock
         * it -- the second the host locked it, so that a level written once
         * as it loads gets none -- and written where the guest finds it: the
         * texture's table, at `index`, and the surface's own block.
         *
         * @param {ShadowLevel['level']} level
         * @param {{ family: object, lock: ShadowLevel['lock'], unlock: ShadowLevel['unlock'],
         *     locked: boolean, lends: boolean, slow: boolean, base: number,
         *     rowPitch: number, slicePitch: number, width: number, height: number,
         *     depth: number, texelBytes: number, sampled: boolean,
         *     texture?: ShadowTexture, index?: number }} info
         * @returns {number} the block, or 0 when there is no memory for one
         */
        attachLevel(level, info){
            let block = levelBlocks.get(level);
            if (block === undefined)
            {
                const owner = place();
                block = owner === 0 ? 0 : carve(LEVEL.SIZE);
                if (block === 0)
                {
                    return 0;
                }
                /** @type {ShadowLevel} */
                const entry = { level, family: info.family, lock: info.lock, unlock: info.unlock,
                    hostLocked: info.locked, lends: info.lends, slow: info.slow, base: info.base };
                const words = new Uint32Array(LEVEL.SIZE / 4);
                words[LEVEL.FLAGS / 4] = levelFlags(entry);
                words[LEVEL.BASE / 4] = info.base;
                words[LEVEL.LOCKED / 4] = info.locked ? 1 : 0;
                words[LEVEL.ROW_PITCH / 4] = info.rowPitch;
                words[LEVEL.DEVICE / 4] = owner;
                words[LEVEL.SLICE_PITCH / 4] = info.slicePitch;
                words[LEVEL.WIDTH / 4] = info.width;
                words[LEVEL.HEIGHT / 4] = info.height;
                words[LEVEL.DEPTH / 4] = info.depth;
                words[LEVEL.TEXEL_BYTES / 4] = info.texelBytes;
                words[LEVEL.SAMPLED / 4] = info.sampled ? 1 : 0;
                deps.writeMemory(block, new Uint8Array(words.buffer));
                levels.set(block, entry);
                levelBlocks.set(level, block);
                const surface = surfaceBlocks.get(level);
                if (surface !== undefined)
                {
                    deps.writeMemory(surface + SURFACE.LEVEL, dwordBytes(block));
                }
            }
            const table = info.texture ? textureBlocks.get(info.texture) : undefined;
            const index = info.index ?? TEXTURE.LEVEL_SLOTS;
            if (table && index < TEXTURE.LEVEL_SLOTS)
            {
                deps.writeMemory(table.block + TEXTURE.LOCKS + index * 4, dwordBytes(block));
            }
            return block;
        },

        /**
         * After the host locked or unlocked a level itself, what the guest did
         * to it replayed first (`sync`): the block says so, and the guest's
         * routines refuse a second lock the way the host would.
         *
         * @param {object} level @param {boolean} locked
         */
        noteLevelLocked(level, locked){
            const block = levelBlocks.get(level);
            const entry = block === undefined ? undefined : levels.get(block);
            if (block === undefined || !entry)
            {
                return;
            }
            holding(()=>{
                entry.hostLocked = locked;
                deps.writeMemory(block + LEVEL.LOCKED, dwordBytes(locked ? 1 : 0));
                deps.writeMemory(block + LEVEL.FLAGS, dwordBytes(levelFlags(entry)));
            });
        },

        /**
         * A device context taken or given back on a texture's level, or on a
         * surface of its own: while it is held, every level's lock is the
         * host's, which refuses it.
         *
         * @param {object} family @param {boolean} busy
         */
        familyBusy(family, busy){
            if (busy)
            {
                busyFamilies.add(family);
            }
            else
            {
                busyFamilies.delete(family);
            }
            holding(()=>{
                for (const [block, entry] of levels)
                {
                    if (entry.family === family)
                    {
                        deps.writeMemory(block + LEVEL.FLAGS, dwordBytes(levelFlags(entry)));
                    }
                }
            });
        },

        /**
         * The host published a level's surface: the guest may hand that
         * pointer out itself from now on.
         *
         * @param {ShadowTexture} texture @param {number} level @param {number} pointer
         */
        noteLevel(texture, level, pointer){
            const entry = textureBlocks.get(texture);
            if (!entry || level >= TEXTURE.LEVEL_SLOTS || pointer === 0)
            {
                return;
            }
            deps.writeMemory(entry.block + TEXTURE.LEVELS + level * 4, dwordBytes(pointer));
        },

        /**
         * Before the host locks or unlocks a buffer itself: what the guest
         * did to it is replayed first, so the host's call meets the state the
         * program left.
         *
         * @param {ShadowBuffer} buffer
         */
        settleBuffer(buffer){
            const block = blockOf.get(buffer);
            if (block !== undefined)
            {
                holding(()=>settle(block));
            }
            else
            {
                settled.unattached++;
            }
        },

        /**
         * After the host locked or unlocked a buffer itself: the block says
         * so, and the guest routine refuses a second lock or a stray unlock
         * the way the host would.
         *
         * @param {ShadowBuffer} buffer @param {boolean} locked
         */
        noteLocked(buffer, locked){
            const block = blockOf.get(buffer);
            const entry = block === undefined ? undefined : blocks.get(block);
            if (block === undefined || !entry)
            {
                return;
            }
            holding(()=>noteLockedNow(block, entry, locked));
        },

        /**
         * A buffer's Lock reached the host: which of the routine's reasons
         * sent it here (`hostLocks`), read from the words the routine read,
         * before the ring is played and clears them.
         *
         * @param {ShadowBuffer} buffer @param {number} flags
         */
        noteHostLock(buffer, flags){
            const block = blockOf.get(buffer);
            const why = block === undefined || address === 0 ? 'other'
                : readWord(block + BUFFER.LOCKED) !== 0 ? 'locked'
                    : (flags & D3DLOCK_READONLY) !== 0 ? 'readonly'
                        : (flags & (D3DLOCK_NOOVERWRITE | D3DLOCK_DISCARD)) === D3DLOCK_NOOVERWRITE
                            ? 'other'
                            : readWord(address + SHADOW.DRAWS_PENDING) !== 0 ? 'pending'
                                : readWord(block + BUFFER.LENT) !== 0 ? 'lent' : 'other';
            hostLocks[why]++;
            if ((why === 'pending' || why === 'lent') && block !== undefined
                && (flags & (D3DLOCK_NOOVERWRITE | D3DLOCK_DISCARD)) === D3DLOCK_DISCARD)
            {
                addSpare(block, buffer);
            }
        },

        /**
         * A level's LockRect or LockBox reached the host: counted as
         * `noteHostLock` counts a buffer's, before the ring is played.
         *
         * @param {object | null} level  null for one with no block to look at
         * @param {string} kind
         */
        noteHostLevelLock(level, kind){
            const block = level === null ? undefined : levelBlocks.get(level);
            const entry = block === undefined ? undefined : levels.get(block);
            const placed = block !== undefined && entry !== undefined && address !== 0;
            const pending = placed && readWord(block + LEVEL.SAMPLED) !== 0
                && readWord(address + SHADOW.DRAWS_PENDING) !== 0;
            const held = placed
                && (readWord(block + LEVEL.LOCKED) !== 0 || readWord(block + LEVEL.TAKEN) !== 0);
            const why = !placed ? 'unplaced'
                : entry.slow ? 'slow'
                    : busyFamilies.has(entry.family) ? 'busy'
                        : held ? 'held'
                            : lentLevel(entry) ? 'lent'
                                : pending ? 'pending' : 'other';
            hostLevelLocks[why]++;
            if (why === 'lent' && pending)
            {
                hostLevelLocks.lentPending++;
            }
            if (hostLevelKinds.size < 64 || hostLevelKinds.has(kind))
            {
                hostLevelKinds.set(kind, (hostLevelKinds.get(kind) ?? 0) + 1);
            }
        },

        diagnostics: ()=>({
            // Numbers rather than booleans: a report keeps a flat structure of
            // numbers and drops anything else.
            placed: address !== 0 ? 1 : 0,
            slowPath: slow ? 1 : 0,
            // Buffer locks and unlocks that never crossed into the host, as of
            // the last entry that settled a buffer the guest let go of.
            lockCalls,
            unlockCalls,
            buffers: blocks.size,
            refused,
            // The host's takes of the device's lock that waited for a routine,
            // how long in all, and how many it broke at HELD_WAIT_MS.
            heldWaits: heldWaits.count,
            heldWaitMs: Math.round(heldWaits.ms),
            heldBroken: heldWaits.broken,
            hostLocks: { ...hostLocks },
            // Ranges unlocked in the guest: sent to the device, or lost and why.
            settled: { ...settled },
            // And the bytes those moves copied in the guest (`moveCopyCode`).
            moved: { ...moved, copied: address === 0 ? 0
                : readWord(address + SHADOW.MOVE_COPIED)
                    + readWord(address + SHADOW.MOVE_COPIED + 4) * 2 ** 32 },
            held: { ...heldReplays },
            hostLevelLocks: { ...hostLevelLocks },
            hostLevelKinds: Object.fromEntries([...hostLevelKinds].sort((a, b)=>b[1] - a[1])
                .slice(0, 12)),
            // Calls the command ring carried past the bridge, and those it holds yet.
            commandCalls: commandReader?.taken() ?? 0,
            commandsQueued: commandReader?.queued() ?? 0,
            // Why routines left for the host, as they counted (`LEFT_HELD`...).
            left: address === 0 ? { held: 0, full: 0, checks: 0 } : {
                held: readWord(address + SHADOW.LEFT_HELD),
                full: readWord(address + SHADOW.LEFT_FULL),
                checks: readWord(address + SHADOW.LEFT_CHECKS),
            },
        }),
    };
}

/**
 * Guest memory as `appendCommand` reads and writes it, over a reader and a
 * writer of bytes.
 *
 * @param {{ readMemory: (at: number, length: number) => Uint8Array,
 *     writeMemory: (at: number, bytes: Uint8Array) => void,
 *     readU32?: (at: number) => number, writeU32?: (at: number, value: number) => void,
 *     compareExchangeU32?: (at: number, expected: number, value: number) => number }} memory
 *     a word read and written in place where the memory layer offers it: a
 *     command's every word through a four-byte copy was most of its cost; the
 *     device's lock taken atomically where it offers that
 * @returns {GuestWords}
 */
export function guestWords(memory){
    const word = new Uint8Array(4);
    const view = new DataView(word.buffer);
    const { readU32, writeU32, compareExchangeU32: exchange } = memory;
    return {
        u32: readU32 ? at=>readU32(at >>> 0) >>> 0 : at=>{
            const bytes = memory.readMemory(at >>> 0, 4);
            return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
        },
        setU32: writeU32 ? (at, value)=>writeU32(at >>> 0, value >>> 0) : (at, value)=>{
            view.setUint32(0, value >>> 0, true);
            memory.writeMemory(at >>> 0, word);
        },
        read: (at, length)=>memory.readMemory(at >>> 0, length),
        write: (at, bytes)=>memory.writeMemory(at >>> 0, bytes),
        ...(exchange ? { compareExchangeU32: (at, expected, value)=>
            exchange(at >>> 0, expected >>> 0, value >>> 0) >>> 0 } : {}),
    };
}

/**
 * Guest memory as `appendCommand` reads and writes it.
 *
 * @typedef {Object} GuestWords
 * @property {(at: number) => number} u32
 * @property {(at: number, value: number) => void} setU32
 * @property {(at: number, length: number) => Uint8Array} read
 * @property {(at: number, bytes: Uint8Array) => void} write
 * @property {(at: number, expected: number, value: number) => number} [compareExchangeU32]
 *     the word's value before, swapped for `value` where it was `expected`: atomic, where
 *     other executors share the memory
 */

/**
 * A mirror as the host keeps it (`HOST_MIRRORS`): the x86 one's work on the
 * block, from the call's arguments (`this` not among them); false where the
 * x86 one goes to the host, 'same' where it answers with no record (`storeState`).
 *
 * @typedef {(memory: GuestWords, block: number, args: number[]) => boolean | 'same'} HostMirror
 */

/**
 * `storeState` as the host keeps it.
 *
 * @param {GuestWords} m @param {number} block @param {number} at @param {number} value
 * @returns {true | 'same'}
 */
const storeStateWord = (m, block, at, value)=>{
    if ((m.u32(block + SHADOW.FLAGS) & FLAG_STALE) === 0 && m.u32(at) === value)
    {
        return 'same';
    }
    m.setU32(at, value);
    return true;
};

/**
 * Whether bit `index` of the bit string at `at` is set, as `bt` reads one.
 *
 * @param {GuestWords} m @param {number} at @param {number} index
 */
const bitAt = (m, at, index)=>((m.u32(at + 4 * (index >>> 5)) >>> (index & 31)) & 1) === 1;

/**
 * The DRAWABLE word changed: `clear` bits off, then `set` on.
 *
 * @param {GuestWords} m @param {number} block @param {number} clear @param {number} set
 */
const drawable = (m, block, clear, set)=>m.setU32(block + SHADOW.DRAWABLE,
    ((m.u32(block + SHADOW.DRAWABLE) & ~clear) | set) >>> 0);

/**
 * `rectWithin` as the host checks it: no rectangle, or one within the
 * surface whose block is `owner` and not empty, its words unsigned.
 *
 * @param {GuestWords} m @param {number} rect @param {number} owner
 */
const hostRectWithin = (m, rect, owner)=>{
    if (rect === 0)
    {
        return true;
    }
    const right = m.u32(rect + 8);
    const bottom = m.u32(rect + 12);
    return m.u32(rect) < right && m.u32(rect + 4) < bottom
        && right <= m.u32(owner + SURFACE.DESC + 24)
        && bottom <= m.u32(owner + SURFACE.DESC + 28);
};

/**
 * The mirrors of `RENDER_STATE_MIRROR` and its kin, in JavaScript: what the
 * host does in place of a command routine (`appendCommand`) keeps the block
 * as the routine would, which the gate holds them to, input by input.
 */
export const HOST_MIRRORS = Object.freeze({
    /** @type {HostMirror} */
    renderState: (m, block, [state, value])=>{
        if (state >= SHADOW.RENDER_STATE_COUNT
            || !bitAt(m, block + SHADOW.RENDER_STATE_VALID, state))
        {
            return false;
        }
        return storeStateWord(m, block, block + SHADOW.RENDER_STATES + 4 * state, value);
    },
    /** @type {HostMirror} */
    transform: (m, block, [type, matrix])=>{
        let slot = type;
        if (type < WORLD_SLOT)
        {
            if (((ANSWERED_TRANSFORMS >>> type) & 1) === 0)
            {
                return false;
            }
        }
        else
        {
            slot = (type - (WORLD_TYPE - WORLD_SLOT)) >>> 0;
            if (slot < WORLD_SLOT || slot >= SHADOW.TRANSFORM_SLOTS)
            {
                return false;
            }
        }
        if (matrix === 0)
        {
            return false;
        }
        m.write(block + SHADOW.TRANSFORMS + slot * 64, m.read(matrix, 64).slice());
        return true;
    },
    /** @type {HostMirror} */
    viewport9: (m, block, [viewport])=>{
        if (viewport === 0 || (m.u32(viewport) | 0) < 0 || (m.u32(viewport + 4) | 0) < 0
            || m.u32(viewport + 8) === 0 || m.u32(viewport + 12) === 0)
        {
            return false;
        }
        m.write(block + SHADOW.VIEWPORT, m.read(viewport, 24).slice());
        return true;
    },
    /** @type {HostMirror} */
    renderTarget: (m, block, [, surface])=>{
        const desc = m.u32(surface + 4) + SURFACE.DESC;
        const width = m.u32(desc + 24);
        const height = m.u32(desc + 28);
        m.setU32(block + SHADOW.VIEWPORT + 8, width);
        m.setU32(block + SHADOW.TARGET_WIDTH, width);
        m.setU32(block + SHADOW.VIEWPORT + 12, height);
        m.setU32(block + SHADOW.TARGET_HEIGHT, height);
        m.setU32(block + SHADOW.VIEWPORT, 0);
        m.setU32(block + SHADOW.VIEWPORT + 4, 0);
        m.setU32(block + SHADOW.VIEWPORT + 16, 0);
        m.setU32(block + SHADOW.VIEWPORT + 20, 0x3f800000);
        m.setU32(block + SHADOW.TARGETS_VALID, m.u32(block + SHADOW.TARGETS_VALID) & ~1);
        const cell = m.u32(surface + 8);
        if (cell !== 0)
        {
            m.setU32(block + SHADOW.TARGETS + 4, cell);
            m.setU32(block + SHADOW.TARGETS, surface);
            m.setU32(block + SHADOW.TARGETS_VALID, m.u32(block + SHADOW.TARGETS_VALID) | 1);
        }
        return true;
    },
    /** @type {HostMirror} */
    stretch: (m, block, [source, sourceRect, target, targetRect])=>{
        if (m.u32(block + SHADOW.ELSEWHERE) === 0 || source === 0 || target === 0)
        {
            return false;
        }
        const from = m.u32(source + 4);
        const to = m.u32(target + 4);
        if (from === 0 || to === 0 || from === to
            || m.u32(from + SURFACE.DESC + 12) !== 0 || m.u32(to + SURFACE.DESC + 12) !== 0
            || (m.u32(from + SURFACE.DESC + 8) & D3DUSAGE_RENDERTARGET) === 0
            || (m.u32(to + SURFACE.DESC + 8) & D3DUSAGE_RENDERTARGET) === 0)
        {
            return false;
        }
        const container = m.u32(from + SURFACE.CONTAINER);
        return (container === 0 || container !== m.u32(to + SURFACE.CONTAINER))
            && hostRectWithin(m, sourceRect, from) && hostRectWithin(m, targetRect, to);
    },
    /** @type {HostMirror} */
    depthStencil: (m, block, [surface])=>{
        const depth = surface === 0 ? 0
            : DRAW.DEPTH | (m.u32(m.u32(surface + 4) + SURFACE.DESC) === D3DFMT_D24S8
                ? DRAW.STENCIL : 0);
        drawable(m, block, DRAW.DEPTH | DRAW.STENCIL, depth);
        m.setU32(block + SHADOW.TARGETS_VALID, m.u32(block + SHADOW.TARGETS_VALID) & ~2);
        const cell = surface === 0 ? 0 : m.u32(surface + 8);
        if (surface === 0 || cell !== 0)
        {
            m.setU32(block + SHADOW.TARGETS + 12, cell);
            m.setU32(block + SHADOW.TARGETS + 8, surface);
            m.setU32(block + SHADOW.TARGETS_VALID, m.u32(block + SHADOW.TARGETS_VALID) | 2);
        }
        return true;
    },
    /** Direct3D 8's CopyRects, as `COPY_GUARD_8` takes it. @type {HostMirror} */
    copy8: (m, block, [source, rects, , target])=>{
        if (rects !== 0 || !HOST_MIRRORS.stretch(m, block, [source, 0, target, 0]))
        {
            return false;
        }
        const from = m.u32(source + 4) + SURFACE.DESC;
        const to = m.u32(target + 4) + SURFACE.DESC;
        return [0, 24, 28].every(offset=>m.u32(from + offset) === m.u32(to + offset));
    },
    /** Direct3D 8's SetRenderTarget: the target, then its depth surface or none. @type {HostMirror} */
    renderTarget8: (m, block, [target, depth])=>HOST_MIRRORS.renderTarget(m, block, [0, target])
        && HOST_MIRRORS.depthStencil(m, block, [depth]),
    /** @type {HostMirror} */
    samplerState: (m, block, [sampler, type, value])=>{
        if (sampler >= SHADOW.SAMPLER_COUNT || type >= SHADOW.SAMPLER_STATE_STRIDE)
        {
            return false;
        }
        return storeStateWord(m, block, block + SHADOW.SAMPLER_STATES + 4 * ((sampler << 4) + type),
            value);
    },
    /** @param {number} types @returns {HostMirror} */
    stageState: types=>(m, block, [stage, type, value])=>{
        if (type >= SHADOW.STAGE_STATE_STRIDE || ((types >>> type) & 1) === 0
            || stage >= SHADOW.STAGE_COUNT)
        {
            return false;
        }
        return storeStateWord(m, block, block + SHADOW.STAGE_STATES + 4 * ((stage << 5) + type),
            value);
    },
    /** @type {HostMirror} */
    beginScene: (m, block)=>{
        drawable(m, block, 0, DRAW.SCENE);
        return true;
    },
    /** @type {HostMirror} */
    endScene: (m, block)=>{
        drawable(m, block, DRAW.SCENE, 0);
        return true;
    },
    /** @type {HostMirror} */
    fvf: (m, block, [fvf])=>{
        if (fvf !== 0)
        {
            drawable(m, block, DRAW.DECLARED, (fvf & 0x0e) !== 0 ? DRAW.DECLARED : 0);
        }
        return true;
    },
    /** @type {HostMirror} */
    declaration: (m, block, [declaration])=>{
        drawable(m, block, DRAW.DECLARED, declaration !== 0 ? DRAW.DECLARED : 0);
        return true;
    },
    /** @type {HostMirror} */
    streamSource9: (m, block, [stream, buffer, offset, stride])=>{
        if (stream === 0)
        {
            drawable(m, block, DRAW.STREAM, buffer !== 0 && stride !== 0
                && ((offset % stride) & 3) === 0 ? DRAW.STREAM : 0);
        }
        return true;
    },
    /** @type {HostMirror} */
    streamSource8: (m, block, [stream, buffer])=>{
        if (stream === 0)
        {
            drawable(m, block, DRAW.STREAM, buffer !== 0 ? DRAW.STREAM : 0);
        }
        return true;
    },
    /** @type {HostMirror} */
    indices: (m, block, [indices])=>{
        drawable(m, block, DRAW.INDEXED, indices !== 0 ? DRAW.INDEXED : 0);
        return true;
    },
});

/**
 * Which level a LockRect or LockBox names, told by how many arguments the
 * method takes: a surface's or a volume's (out, rectangle or box, flags) is
 * its own, null; a texture's takes the level first; a cube's the face and the
 * level, undefined, a face the guest never locks.
 *
 * @param {number[]} args
 * @returns {number | null | undefined}
 */
export const levelIndex = args=>(args.length === 3 ? null : args.length === 4 ? args[0] >>> 0
    : undefined);

/**
 * The host's side of the levels the guest locks, as both versions' seams
 * keep it: after each lock or unlock the host made itself, the level's block
 * is told (`noteLevelLocked`), and the second time the host locks a level it
 * gets one (`attachLevel`), described from the level -- its bytes, pitches
 * and extent, whether a draw may read it -- with the lock and unlock the host
 * replays the guest's through. A level of a texture is reached by its index,
 * once; a surface of its own is its own level.
 *
 * @param {{ shadowOf: (object: any) => (ReturnType<typeof createShadow> | null | undefined),
 *     twinCopies: boolean }} seam  `twinCopies`: the version's played device copies an
 *     update out of the source's bytes as they were sent (Direct3D 8's), so a level
 *     in system memory is lent too
 */
export function createLevelLocks({ shadowOf, twinCopies }){
    /** Each texture's levels the host has reached, by index. @type {WeakMap<object, any[]>} */
    const reached = new WeakMap();
    /** Levels the host has locked once. @type {WeakSet<object>} */
    const lockedOnce = new WeakSet();

    /**
     * A texture's level, taken and given back as GetSurfaceLevel and a
     * Release would, and kept.
     *
     * @param {any} texture @param {number} index
     */
    const levelOf = (texture, index)=>{
        let levels = reached.get(texture);
        if (!levels)
        {
            levels = [];
            reached.set(texture, levels);
        }
        if (!levels[index])
        {
            /** @type {{ surface?: any, volume?: any }} */
            const out = {};
            const hr = typeof texture.GetVolumeLevel === 'function'
                ? texture.GetVolumeLevel(index, out) : texture.GetSurfaceLevel(index, out);
            const level = out.volume ?? out.surface;
            if (hr !== 0 || !level)
            {
                return null;
            }
            level.release();
            levels[index] = level;
        }
        return levels[index];
    };

    /**
     * What the guest's routines need of a level: null for one it does not
     * lock at all.
     *
     * @param {any} level
     */
    const describe = level=>{
        /** @type {{ desc?: any }} */
        const held = {};
        if (typeof level.base !== 'number' || level.GetDesc(held) !== 0 || !held.desc)
        {
            return null;
        }
        const { Format, Usage, Pool, Width, Height, Depth = 1 } = held.desc;
        const format = FORMAT_INFO[Format];
        // A block of texels, or a pair of them sharing their colour, is not
        // addressed a texel at a time; a target or a depth surface reads back.
        const whole = format !== undefined && format.blockSize === undefined
            && format.video !== true;
        const rowPitch = surfacePitch(Format, Width);
        const sampled = Pool !== D3DPOOL.SYSTEMMEM && Pool !== D3DPOOL.SCRATCH;
        return {
            base: level.base, rowPitch, slicePitch: rowPitch * Height, width: Width,
            height: Height, depth: Depth, texelBytes: whole ? format.bytesPerPixel : 0, sampled,
            lends: sampled || twinCopies,
            slow: !whole || (Usage & (D3DUSAGE.RENDERTARGET | D3DUSAGE.DEPTHSTENCIL)) !== 0,
        };
    };

    return {
        /**
         * A level's lock reached the host, before the ring is played: told to
         * the device's shadow with the level's kind. A level the host has not
         * reached yet is not reached here -- getting one is a call the
         * recording sends -- and has no block to look at anyway.
         *
         * @param {any} owner  the device
         * @param {any} object  the texture, or the surface or volume
         * @param {number | null | undefined} index  the texture's level, null for a surface or
         *     a volume, undefined for a cube's face
         */
        hostLock(owner, object, index){
            const shadow = shadowOf(owner);
            if (!shadow)
            {
                return;
            }
            if (index === undefined)
            {
                shadow.noteHostLevelLock(null, 'cube');
                return;
            }
            const level = index === null ? object : reached.get(object)?.[index] ?? null;
            /** @type {{ desc?: any }} */
            const held = {};
            const desc = level !== null && level.GetDesc(held) === 0 ? held.desc : undefined;
            shadow.noteHostLevelLock(level, desc
                ? `${desc.Width}x${desc.Height} ${desc.Format} u${desc.Usage} p${desc.Pool}`
                : 'unreached');
        },

        /**
         * After the host's own lock or unlock of a level that answered D3D_OK.
         *
         * @param {any} owner  the device
         * @param {any} object  the texture, or the surface
         * @param {number | null} index  the texture's level, null for a surface
         * @param {boolean} locked
         */
        locked(owner, object, index, locked){
            const shadow = shadowOf(owner);
            const level = index === null ? object : levelOf(object, index);
            if (!shadow || !level)
            {
                return;
            }
            if (locked && !lockedOnce.has(level))
            {
                lockedOnce.add(level);
                return;
            }
            const info = locked ? describe(level) : null;
            if (info)
            {
                const volume = typeof level.LockBox === 'function';
                shadow.attachLevel(level, {
                    ...info, locked: true, family: level.container ?? level,
                    texture: index === null ? undefined : object, index: index ?? undefined,
                    lock: volume
                        ? (box, flags)=>level.LockBox({}, box, flags)
                        : (box, flags)=>level.LockRect({}, box && { left: box.left,
                            top: box.top, right: box.right, bottom: box.bottom }, flags),
                    unlock: volume ? ()=>level.UnlockBox() : ()=>level.UnlockRect(),
                });
            }
            shadow.noteLevelLocked(level, locked);
        },
    };
}

/**
 * A command routine's work done by the host (`commandCode`): for a call the
 * host makes to a device's method from driven steps, the record the routine
 * would write is written into the ring, the block's mirrors kept as the
 * routine keeps them, and the call answered D3D_OK -- with no entry into the
 * guest, and nothing made before the ring is played, as the routine's call
 * is made. Undefined where the routine would go to the host: the slow path,
 * a check that fails, a full ring; the call then goes into the guest as it
 * came. A function or a state block's method (`thread`, `self`) is not one
 * this takes.
 *
 * @param {GuestWords} m @param {import('./routines/command.js').CommandShape} shape
 * @param {HostMirror | undefined} mirror  the routine's mirror, as the host keeps it
 * @param {number[]} call  the interface pointer, then the arguments
 * @returns {number | undefined}
 */
export function appendCommand(m, shape, mirror, call){
    const { fresh = false } = shape;
    if (shape.thread || shape.self)
    {
        return undefined;
    }
    // The arguments as unsigned words, `this` before them: read in place, not copied.
    /** @type {number[]} */
    const a = ARGUMENTS;
    for (let i = 1; i < call.length; i++)
    {
        a[i - 1] = call[i] >>> 0;
    }
    const block = m.u32(call[0] + 4);
    if (block === 0 || (m.u32(block) & (fresh ? FLAG_SLOW_PATH | FLAG_DRAW_STALE
        : FLAG_SLOW_PATH)) !== 0 || m.u32(block + SHADOW.COMMANDS) === 0)
    {
        return undefined;
    }
    // The device's lock, where the routine takes it (`takeHeld`): held -- by a
    // routine on another executor, or the host's own reading of the block --
    // the call goes into the guest as it came, and the routine goes to the host.
    const held = block + SHADOW.HELD;
    if ((m.compareExchangeU32 ? m.compareExchangeU32(held, 0, HELD_HOST) : m.u32(held)) !== 0)
    {
        return undefined;
    }
    m.setU32(held, HELD_HOST);
    try
    {
        return recordCommand(m, shape, mirror, block, a);
    }
    finally
    {
        m.setU32(held, 0);
    }
}

/**
 * `appendCommand`'s work past the device's lock: the routine's checks, its
 * mirror and its record.
 *
 * @param {GuestWords} m @param {import('./routines/command.js').CommandShape} shape
 * @param {HostMirror | undefined} mirror @param {number} block @param {number[]} a
 * @returns {number | undefined}
 */
function recordCommand(m, shape, mirror, block, a){
    const { slot, args, pointer = -1, bytes = 0, count, draws = false, stale = false,
        staleDraws = false } = shape;
    const able = m.u32(block + SHADOW.DRAWABLE);
    if ((shape.needs && (able & shape.needs) !== shape.needs)
        || (shape.refuses && (able & shape.refuses) !== 0))
    {
        return undefined;
    }
    for (const { arg, ranges } of shape.within ?? [])
    {
        if (!ranges.some(([low, high])=>((a[arg] - low) >>> 0) <= ((high - low) >>> 0)))
        {
            return undefined;
        }
    }
    const paired = shape.refusedWhen;
    if (paired && a[paired.arg] === paired.equals >>> 0 && (a[paired.flagsOf] & paired.mask) !== 0)
    {
        return undefined;
    }
    if (shape.span !== undefined && count)
    {
        const end = a[shape.span] + a[count.arg];
        if (end > 0xffffffff || end > count.most)
        {
            return undefined;
        }
    }
    if (shape.below && a[shape.below.arg] >= m.u32(block + shape.below.word))
    {
        return undefined;
    }
    const validated = shape.validated;
    if (validated && (a[validated.arg] & validated.when) !== 0)
    {
        const table = block + SHADOW.VALIDATED
            + (validated.table ?? 0) * SHADOW.VALIDATED_SLOTS * 4;
        let seen = false;
        for (let index = 0; index < SHADOW.VALIDATED_SLOTS && !seen; index++)
        {
            seen = m.u32(table + 4 * index) === a[validated.arg];
        }
        if (!seen)
        {
            return undefined;
        }
    }
    for (const [flag, bits] of shape.flagNeeds?.pairs ?? [])
    {
        if ((a[shape.flagNeeds?.arg ?? 0] & flag) !== 0 && (able & bits) !== bits)
        {
            return undefined;
        }
    }
    for (const usage of usagesOf(shape))
    {
        const surface = a[usage.arg];
        const owner = surface === 0 ? 0 : m.u32(surface + 4);
        if (surface === 0 ? !usage.nullable
            : owner === 0 || m.u32(owner + SURFACE.OWNER) !== block
                || (m.u32(owner + SURFACE.DESC + 8) & usage.mask) === 0)
        {
            return undefined;
        }
    }
    if (shape.depthCovers && a[shape.depthCovers.depth] !== 0)
    {
        const depth = m.u32(a[shape.depthCovers.depth] + 4);
        const target = m.u32(a[shape.depthCovers.target] + 4);
        if ([24, 28].some(side=>m.u32(depth + SURFACE.DESC + side)
            < m.u32(target + SURFACE.DESC + side)))
        {
            return undefined;
        }
    }
    const range = shape.vertexRange;
    if (shape.token !== undefined
        && !(a[shape.token] < SHADOW.STATE_BLOCK_TOKENS && tokenBit(m, block, a[shape.token])))
    {
        return undefined;
    }
    if (range)
    {
        const owner = a[range.buffer] === 0 ? 0 : m.u32(a[range.buffer] + 4);
        const end = a[range.start] + a[range.count];
        if (owner === 0 || m.u32(owner + VERTEX_BUFFER7.LOCKED) !== 0 || end > 0xffffffff
            || end > m.u32(owner + VERTEX_BUFFER7.VERTICES))
        {
            return undefined;
        }
    }
    const size = copiedBytes(shape, a, pointer, bytes);
    if (size === null)
    {
        return undefined;
    }
    const mirrored = mirror?.(m, block, a) ?? true;
    if (mirrored !== true)
    {
        // A call the mirror found changes nothing is answered with no record.
        return mirrored === 'same' ? 0 : undefined;
    }
    const header = COMMAND.ARGS + 4 * args;
    const length = count !== undefined && count.shift < 2 ? (size + header + 3) & ~3
        : size + header;
    const head = m.u32(block + SHADOW.COMMAND_HEAD);
    if (head + length > m.u32(block + SHADOW.COMMAND_BYTES))
    {
        return undefined;
    }
    m.setU32(block + SHADOW.COMMAND_HEAD, head + length);
    const record = (m.u32(block + SHADOW.COMMANDS) + head) >>> 0;
    m.setU32(record + COMMAND.SLOT, slot);
    const rects = shape.rects ?? [];
    for (let arg = 0; arg < args; arg++)
    {
        const rect = rects.indexOf(arg);
        const copy = rect >= 0 ? record + header + RECT_BYTES * rect : record + header;
        m.setU32(record + COMMAND.ARGS + 4 * arg, arg === pointer || rect >= 0
            ? (a[arg] === 0 ? 0 : copy) : a[arg]);
    }
    if (pointer >= 0 && size > 0)
    {
        m.write(record + header, m.read(a[pointer], size).slice());
    }
    rects.forEach((arg, rect)=>{
        if (a[arg] !== 0)
        {
            m.write(record + header + RECT_BYTES * rect, m.read(a[arg], RECT_BYTES).slice());
        }
    });
    m.setU32(record + COMMAND.BYTES, length);
    if (draws)
    {
        m.setU32(block + SHADOW.DRAWS_PENDING, 1);
    }
    if (stale)
    {
        const drawsToo = staleDraws || (shape.token !== undefined
            && tokenBit(m, block + SHADOW.STATE_BLOCK_DRAWS - SHADOW.STATE_BLOCKS, a[shape.token]));
        m.setU32(block, m.u32(block) | (drawsToo ? FLAG_STALE | FLAG_DRAW_STALE : FLAG_STALE));
    }
    return 0;
}

/**
 * A token's bit in the block's map of state blocks (`SHADOW.STATE_BLOCKS`).
 *
 * @param {GuestWords} m @param {number} block @param {number} token  below the tokens kept
 */
const tokenBit = (m, block, token)=>
    ((m.u32(block + SHADOW.STATE_BLOCKS + 4 * (token >>> 5)) >>> (token & 31)) & 1) === 1;

/** The arguments of the call `appendCommand` is writing, one array for every call. */
const ARGUMENTS = /** @type {number[]} */ (new Array(16).fill(0));

/**
 * How many bytes a command routine copies of what the call points at, as it
 * works it out; null where it goes to the host.
 *
 * @param {import('./routines/command.js').CommandShape} shape @param {number[]} a @param {number} pointer @param {number} bytes
 * @returns {number | null}
 */
function copiedBytes(shape, a, pointer, bytes){
    const { count, choose, vertices, nullable = false } = shape;
    if (pointer >= 0 && a[pointer] === 0)
    {
        if (!nullable)
        {
            return null;
        }
        return nullable === 'empty' && count && a[count.arg] !== 0 ? null : 0;
    }
    if (choose)
    {
        return choose.cases.find(([value])=>value === a[choose.arg])?.[1] ?? choose.otherwise;
    }
    if (vertices)
    {
        const n = a[vertices.count];
        if (n === 0 || n > vertices.most)
        {
            return null;
        }
        /** @type {Record<number, number>} */
        const spans = { 1: n, 2: n + n, 3: n + 1, 4: 3 * n, 5: n + 2, 6: n + 2 };
        const spanned = spans[a[vertices.type]];
        const stride = a[vertices.stride];
        if (spanned === undefined || (stride & 3) !== 0 || stride > vertices.most)
        {
            return null;
        }
        const total = Math.imul(spanned, stride) >>> 0;
        return total === 0 || total > vertices.most ? null : total;
    }
    if (count)
    {
        const n = a[count.arg];
        return n === 0 || n > count.most ? null : (n << count.shift) >>> 0;
    }
    return pointer >= 0 ? bytes : RECT_BYTES * (shape.rects?.length ?? 0);
}

