/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where two runs of bytes differ, as spans: what a buffer the program writes
 * outside its locks holds now against what was last sent of it.
 *
 * It runs for every draw from such a buffer, so it compares four bytes at a
 * time, eight words to a test, where both runs lie on four-byte boundaries (a buffer's base and a
 * vertex's stride nearly always do) and stops looking inside a span only
 * after `gap` equal bytes, so a model rewritten vertex by vertex is one span
 * rather than a span a vertex.
 *
 * @param {Uint8Array} now  what the bytes are
 * @param {Uint8Array} was  what was sent, as long as `now` or longer
 * @param {number} [gap]  equal bytes that end a span
 * @returns {number[]}  start and end (exclusive) of each span, flat
 */
export function changedSpans(now, was, gap = 64){
    const length = Math.min(now.length, was.length);
    // Two runs off a four-byte boundary by the same amount -- a draw's
    // sixteen-bit indices from an odd first one -- are compared a byte at a
    // time to the boundary and by words after it, not a byte at a time
    // throughout, which is eight times as slow.
    const skew = now.byteOffset & 3;
    if (skew !== 0 && (was.byteOffset & 3) === skew && length > 8)
    {
        const head = 4 - skew;
        const spans = changedSpans(now.subarray(0, head), was.subarray(0, head), gap);
        const rest = changedSpans(now.subarray(head, length), was.subarray(head, length), gap);
        for (let index = 0; index < rest.length; index += 2)
        {
            const start = rest[index] + head;
            const end = rest[index + 1] + head;
            const last = spans.length - 1;
            if (last > 0 && start - spans[last] <= gap)
            {
                spans[last] = end;
            }
            else
            {
                spans.push(start, end);
            }
        }
        return spans;
    }
    /** @type {number[]} */
    const spans = [];
    let start = -1;
    let lastChanged = -1;
    let at = 0;
    if (((now.byteOffset | was.byteOffset) & 3) === 0 && length >= 4)
    {
        const words = length >>> 2;
        const a = new Int32Array(now.buffer, now.byteOffset, words);
        const b = new Int32Array(was.buffer, was.byteOffset, words);
        const gapWords = Math.max(1, gap >>> 2);
        const blocks = words & ~7;
        for (let word = 0; word < words; word++)
        {
            // Eight words at once, folded into one test: most of what a draw
            // reads is unchanged, and this goes four times as fast as a word
            // at a time. An equal run ends a span as the words one by one
            // would, since the gap only grows along it.
            if ((word & 7) === 0 && word < blocks)
            {
                const differ = (a[word] ^ b[word]) | (a[word + 1] ^ b[word + 1])
                    | (a[word + 2] ^ b[word + 2]) | (a[word + 3] ^ b[word + 3])
                    | (a[word + 4] ^ b[word + 4]) | (a[word + 5] ^ b[word + 5])
                    | (a[word + 6] ^ b[word + 6]) | (a[word + 7] ^ b[word + 7]);
                if (differ === 0)
                {
                    word += 7;
                    if (start >= 0 && word - lastChanged > gapWords)
                    {
                        spans.push(start << 2, (lastChanged + 1) << 2);
                        start = -1;
                    }
                    continue;
                }
                // Inside a span that no equal run in the block could end --
                // a model rewritten whole -- only its last change matters.
                if (start >= 0 && word + 7 - lastChanged <= gapWords)
                {
                    let last = word + 7;
                    while (a[last] === b[last])
                    {
                        last--;
                    }
                    lastChanged = last;
                    word += 7;
                    continue;
                }
            }
            if (a[word] === b[word])
            {
                if (start >= 0 && word - lastChanged > gapWords)
                {
                    spans.push(start << 2, (lastChanged + 1) << 2);
                    start = -1;
                }
                continue;
            }
            if (start < 0)
            {
                start = word;
            }
            lastChanged = word;
        }
        if (start >= 0)
        {
            spans.push(start << 2, (lastChanged + 1) << 2);
            start = -1;
        }
        at = words << 2;
    }
    for (; at < length; at++)
    {
        if (now[at] === was[at])
        {
            if (start >= 0 && at - lastChanged > gap)
            {
                spans.push(start, lastChanged + 1);
                start = -1;
            }
            continue;
        }
        if (start < 0)
        {
            // A byte tail after the words joins the words' last span when it
            // touches it.
            const previous = spans.length;
            if (previous > 0 && at - spans[previous - 1] <= gap)
            {
                start = spans[previous - 2];
                spans.length = previous - 2;
            }
            else
            {
                start = at;
            }
        }
        lastChanged = at;
    }
    if (start >= 0)
    {
        spans.push(start, lastChanged + 1);
    }
    return spans;
}

/**
 * The parts of a buffer's `[from, to)` on pages its write watch says were
 * written since they were last taken: what is sent or uploaded of them as it
 * is, with no comparison, since a write the watch saw is all a comparison
 * could have found. A page the range covers only in part is taken from the
 * watch but kept in `dirty` until a later range covers all of it the buffer
 * holds.
 *
 * @param {{ watch: { take: (address: number, length: number) => number[] },
 *     dirty: Set<number> }} tracked
 * @param {number} base @param {number} length  the buffer's
 * @param {number} from @param {number} to  within it
 * @returns {number[]}  start and end (exclusive) of each span, flat, in the buffer
 */
export function writtenSpans(tracked, base, length, from, to){
    if (to <= from)
    {
        return [];
    }
    for (const page of tracked.watch.take(base + from, to - from))
    {
        tracked.dirty.add(page);
    }
    /** @type {number[]} */
    const spans = [];
    if (tracked.dirty.size === 0)
    {
        return spans;
    }
    const last = (base + to - 1) >>> 12;
    for (let page = (base + from) >>> 12; page <= last; page++)
    {
        if (!tracked.dirty.has(page))
        {
            continue;
        }
        let end = page;
        while (end < last && tracked.dirty.has(end + 1))
        {
            end++;
        }
        const lo = Math.max(from, page * 4096 - base);
        const hi = Math.min(to, (end + 1) * 4096 - base);
        spans.push(lo, hi);
        for (let done = page; done <= end; done++)
        {
            if (Math.max(0, done * 4096 - base) >= lo
                && Math.min(length, (done + 1) * 4096 - base) <= hi)
            {
                tracked.dirty.delete(done);
            }
        }
        page = end;
    }
    return spans;
}

/**
 * The ranges of each buffer compared since a pause began, so a range is
 * compared once in it however many draws read it: while the program does not
 * run -- a run of the command ring played, one call made -- its memory cannot
 * change, and a game that names a whole buffer as every draw's vertices
 * compared the whole of it once a draw.
 *
 * @returns {{ take: (key: object, from: number, to: number) => number[],
 *     clear: () => void }}
 *     `take` answers the parts of `[from, to)` not compared yet in this pause,
 *     flat as `changedSpans` answers, and counts them compared from now
 */
export function createCompared(){
    /** By buffer, its compared ranges: sorted, apart, flat. @type {Map<object, number[]>} */
    let compared = new Map();
    return {
        take(key, from, to){
            const ranges = compared.get(key);
            if (!ranges)
            {
                compared.set(key, [from, to]);
                return [from, to];
            }
            /** @type {number[]} */
            const open = [];
            let at = from;
            for (let index = 0; index < ranges.length && at < to; index += 2)
            {
                const start = ranges[index];
                const end = ranges[index + 1];
                if (end <= at)
                {
                    continue;
                }
                if (start >= to)
                {
                    break;
                }
                if (start > at)
                {
                    open.push(at, start);
                }
                at = Math.max(at, end);
            }
            if (at < to)
            {
                open.push(at, to);
            }
            if (open.length > 0)
            {
                // Merged in: the union of what was there and [from, to).
                /** @type {number[]} */
                const merged = [];
                let placed = false;
                for (let index = 0; index <= ranges.length; index += 2)
                {
                    let start = index < ranges.length ? ranges[index] : Infinity;
                    let end = index < ranges.length ? ranges[index + 1] : Infinity;
                    if (!placed && from <= start)
                    {
                        [start, end] = [from, to];
                        index -= 2;
                        placed = true;
                    }
                    if (start === Infinity)
                    {
                        break;
                    }
                    const last = merged.length - 1;
                    if (last > 0 && start <= merged[last])
                    {
                        merged[last] = Math.max(merged[last], end);
                    }
                    else
                    {
                        merged.push(start, end);
                    }
                }
                compared.set(key, merged);
            }
            return open;
        },
        clear(){
            if (compared.size > 0)
            {
                compared = new Map();
            }
        },
    };
}
