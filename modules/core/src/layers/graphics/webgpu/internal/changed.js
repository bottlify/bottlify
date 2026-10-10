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
 * time where both runs lie on four-byte boundaries (a buffer's base and a
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
        for (let word = 0; word < words; word++)
        {
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
