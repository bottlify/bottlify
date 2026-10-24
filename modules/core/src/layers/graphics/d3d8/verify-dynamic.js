/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A diagnostic (`verifyDynamic`): whether what a draw reads of a dynamic
 * buffer is, on the played side, what that side was sent of it.
 *
 * The recording sends what a draw reads of a dynamic buffer (`drawsFrom`;
 * `checkDraws` compares that with guest memory), the played side keeps it in
 * its copy of guest memory, and a draw uploads what it decides changed
 * (`readHeld`) into the buffer's copy, which reaches the GPU at the frame's
 * end through renames, carries and copies. This compares, at each draw, the
 * bytes the draw reads -- the vertices its indices name, not the range it
 * declares -- in the played side's memory against the buffer's copy as the
 * draw is recorded, and against what the GPU buffer the draw binds holds once
 * its frame is submitted: on a device that keeps its bytes (the fake one)
 * read there, on any other copied out after the frame's draws and read back
 * (`readBack`), within a budget a frame. A byte that differs is one the draw
 * takes stale.
 */

/** D3DUSAGE_DYNAMIC. */
const DYNAMIC = 0x200;
/** How many of each kind of finding are kept as they were found. */
const SAMPLES = 16;
/** How many of the last moves are kept, for a finding's account. */
const MOVES_KEPT = 32;
/**
 * The bytes a frame copies out of the GPU at most: what the draws of a heavy
 * frame read of dynamic buffers, a few hundred kilobytes a frame in the
 * games measured, many times over. Past it a range is counted as skipped.
 */
const READ_BACK_BYTES = 4 * 1024 * 1024;
/** Bytes of each side shown from a finding's first differing byte. */
const SHOWN = 16;

/**
 * @param {Uint8Array} want @param {Uint8Array} have
 * @returns {{ count: number, first: number, last: number }}
 */
const differing = (want, have)=>{
    let count = 0;
    let first = -1;
    let last = -1;
    const length = Math.min(want.length, have.length);
    for (let at = 0; at < length; at++)
    {
        if (want[at] !== have[at])
        {
            count++;
            if (first < 0)
            {
                first = at;
            }
            last = at;
        }
    }
    return { count, first, last };
};

/** @param {Uint8Array} bytes @param {number} from */
const hex = (bytes, from)=>Array.from(bytes.subarray(Math.max(0, from), from + SHOWN),
    byte=>byte.toString(16).padStart(2, '0')).join('');

/**
 * @param {(address: number, length: number) => Uint8Array} read  the played side's memory
 */
export function createDynamicVerify(read){
    const figures = {
        draws: 0, ranges: 0, bytes: 0,
        /** Ranges whose buffer copy differed as the draw was recorded. */
        copyStale: 0,
        /** Ranges whose GPU buffer was compared once the frame was submitted. */
        gpuChecked: 0,
        /** Ranges whose GPU buffer differed once the frame was submitted. */
        gpuStale: 0,
        /** Ranges whose GPU buffer keeps no bytes and was not read back. */
        gpuUnknown: 0,
        /** Ranges past a frame's budget of bytes read back. */
        gpuSkipped: 0,
        /** Reads back not answered yet, and those that failed. */
        readsPending: 0,
        readsFailed: 0,
        /** Ranges the indices reach past the range the draw declares. */
        beyond: 0,
        /** @type {Record<string, number>} */
        staleBySize: {},
        /** @type {Record<string, unknown>[]} */
        copySamples: [],
        /** @type {Record<string, unknown>[]} */
        gpuSamples: [],
        /** @type {Record<string, unknown>[]} */
        beyondSamples: [],
        /** The last moves onto another storage, oldest first. @type {Record<string, unknown>[]} */
        lastMoves: [],
    };
    /** The draw being recorded. */
    let at = { frame: 0, draw: 0 };
    /** @type {{ backing: any, offset: number, expected: Uint8Array, what: Record<string, unknown> }[]} */
    let pending = [];
    /** Each buffer's last move and lock, for a finding's account. @type {WeakMap<object, any>} */
    const story = new WeakMap();
    /** @param {any} source */
    const storyOf = source=>{
        let entry = story.get(source);
        if (!entry)
        {
            entry = { moves: 0, movedAt: null, locks: 0, lastLock: null, bases: new Set() };
            story.set(source, entry);
        }
        return entry;
    };
    /** @param {any} source @param {any} wrapper @param {string} kind @param {number} from @param {number} to */
    const account = (source, wrapper, kind, from, to)=>{
        const entry = storyOf(source);
        return {
            kind, size: source.length, base: (source.base >>> 0).toString(16), from, to,
            // Which of its storages the buffer was on (`d3d8/storages.js`), -1 without them.
            storage: Array.isArray(source.storages) ? source.storages.indexOf(source.base) : -1,
            frame: at.frame, draw: at.draw, moves: entry.moves,
            sinceMove: entry.movedAt
                ? `${at.frame - entry.movedAt.frame}f/${at.draw - entry.movedAt.draw}d` : null,
            lastLock: entry.lastLock, bases: entry.bases.size,
            backing: wrapper?.gpu?.descriptor?.label ?? wrapper?.gpu?.label ?? null,
            renames: wrapper?.renames,
        };
    };
    /**
     * What a GPU buffer held of a range once its frame was submitted.
     *
     * @param {{ backing: any, offset: number, expected: Uint8Array,
     *     what: Record<string, unknown> }} check
     * @param {Uint8Array} have
     */
    const compare = (check, have)=>{
        figures.gpuChecked++;
        const found = differing(check.expected, have);
        if (found.count === 0)
        {
            return;
        }
        figures.gpuStale++;
        const key = `${check.what.size}:gpu`;
        figures.staleBySize[key] = (figures.staleBySize[key] ?? 0) + 1;
        if (figures.gpuSamples.length < SAMPLES)
        {
            figures.gpuSamples.push({ ...check.what, differing: found.count,
                first: found.first, last: found.last,
                want: hex(check.expected, found.first), have: hex(have, found.first),
                backingNow: check.backing?.descriptor?.label ?? check.backing?.label ?? null });
        }
    };
    return {
        /**
         * A draw begins: whatever an earlier one left unrecorded is dropped.
         *
         * @param {number} frame @param {number} draw
         */
        draw(frame, draw){
            figures.draws++;
            at = { frame, draw };
            pending = [];
        },
        /**
         * @param {string} kind @param {any} source  the guest's buffer
         * @param {any} wrapper  its backend buffer
         * @param {number} from @param {number} to  what the draw reads
         * @param {{ from: number, to: number } | null} declared  what it said it reads
         * @param {boolean} bound  whether the GPU reads this buffer for the draw
         * @param {Record<string, unknown>} [more]
         */
        range(kind, source, wrapper, from, to, declared, bound, more = {}){
            if (((source?.usage ?? 0) & DYNAMIC) === 0 || typeof source?.base !== 'number'
                || to <= from)
            {
                return;
            }
            figures.ranges++;
            figures.bytes += to - from;
            storyOf(source).bases.add(source.base);
            if (declared && (from < declared.from || to > declared.to))
            {
                figures.beyond++;
                if (figures.beyondSamples.length < SAMPLES)
                {
                    figures.beyondSamples.push({ ...account(source, wrapper, kind, from, to),
                        declared: `${declared.from}..${declared.to}`, ...more });
                }
            }
            const expected = read(source.base + from, to - from).slice();
            const copy = wrapper.bytes(from, to - from);
            const found = differing(expected, copy);
            if (found.count > 0)
            {
                figures.copyStale++;
                const key = `${source.length}:copy`;
                figures.staleBySize[key] = (figures.staleBySize[key] ?? 0) + 1;
                if (figures.copySamples.length < SAMPLES)
                {
                    figures.copySamples.push({ ...account(source, wrapper, kind, from, to),
                        differing: found.count, first: found.first, last: found.last,
                        want: hex(expected, found.first), have: hex(copy, found.first), ...more });
                }
            }
            if (bound)
            {
                pending.push({ backing: wrapper.gpu, offset: from, expected,
                    what: { ...account(source, wrapper, kind, from, to), ...more } });
            }
        },
        /** The draw was recorded into `recording`: its checks wait for that frame's submit. */
        attach(/** @type {any} */ recording){
            if (pending.length > 0)
            {
                (recording.verifyChecks ??= []).push(...pending);
                pending = [];
            }
        },
        /**
         * The frame's draws are encoded and its end not yet made: what they
         * read of GPU buffers that keep no bytes of their own is copied out
         * after them, within the budget, to be read once it is submitted.
         *
         * @param {any} recording
         * @param {{ copyOut?: (ranges: { buffer: any, offset: number, size: number }[])
         *     => () => Promise<Uint8Array[]> }} frame
         */
        readBack(recording, frame){
            const checks = recording?.verifyChecks;
            if (!checks || typeof frame.copyOut !== 'function')
            {
                return;
            }
            let left = READ_BACK_BYTES;
            /** @type {{ backing: any, offset: number, expected: Uint8Array }[]} */
            const taken = [];
            for (const check of checks)
            {
                if (check.backing?.bytes instanceof Uint8Array)
                {
                    continue;
                }
                if (check.expected.length > left)
                {
                    check.skipped = true;
                    figures.gpuSkipped++;
                    continue;
                }
                left -= check.expected.length;
                taken.push(check);
            }
            if (taken.length > 0)
            {
                recording.verifyRead = { checks: taken, read: frame.copyOut(taken.map(check=>({
                    buffer: check.backing, offset: check.offset,
                    size: check.expected.length }))) };
            }
        },
        /**
         * A frame was submitted: what its draws' GPU buffers hold now, where
         * the device keeps it, and the read back of the rest begun.
         */
        submitted(/** @type {any} */ recording){
            const checks = recording?.verifyChecks;
            if (!checks)
            {
                return;
            }
            recording.verifyChecks = undefined;
            const reading = recording.verifyRead;
            recording.verifyRead = undefined;
            for (const check of checks)
            {
                const bytes = check.backing?.bytes;
                if (bytes instanceof Uint8Array)
                {
                    compare(check, bytes.subarray(check.offset,
                        check.offset + check.expected.length));
                }
                else if (!check.skipped && !reading?.checks.includes(check))
                {
                    figures.gpuUnknown++;
                }
            }
            if (reading)
            {
                figures.readsPending++;
                reading.read().then((/** @type {Uint8Array[]} */ results)=>{
                    figures.readsPending--;
                    reading.checks.forEach((/** @type {any} */ check, /** @type {number} */ index)=>
                        compare(check, results[index]));
                }, ()=>{
                    figures.readsPending--;
                    figures.readsFailed++;
                    figures.gpuUnknown += reading.checks.length;
                });
            }
        },
        /** @param {any} source */
        moved(source){
            const entry = storyOf(source);
            entry.moves++;
            entry.movedAt = { ...at };
            figures.lastMoves.push({ frame: at.frame, draw: at.draw, size: source.length,
                base: (source.base >>> 0).toString(16),
                storage: Array.isArray(source.storages)
                    ? source.storages.indexOf(source.base) : -1 });
            if (figures.lastMoves.length > MOVES_KEPT)
            {
                figures.lastMoves.shift();
            }
        },
        /** @param {any} source @param {number} flags @param {number} offset @param {number} length */
        locked(source, flags, offset, length){
            const entry = storyOf(source);
            entry.locks++;
            entry.lastLock = `${offset}+${length}/${flags.toString(16)}@${at.frame}:${at.draw}`;
        },
        figures: ()=>JSON.parse(JSON.stringify(figures)),
    };
}
