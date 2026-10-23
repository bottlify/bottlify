/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the graphics worker was sent, written down to be played again in node
 * (`tools/graphics-replay.mjs`): every root as it was made and every batch of
 * calls in the order it came. What a frame costs the played side is its calls
 * and how many bytes of guest memory they move, not what those bytes hold --
 * the renderer finds what a program wrote by the pages it was sent, and a
 * draw is told the vertices it reaches -- while a run sends gigabytes of
 * vertices and texels. So the guest memory a batch carries is kept as zeros,
 * which compress to nothing, and everything else whole: the calls' own
 * arguments are what the played side parses -- a ring of commands, a
 * shader's tokens, a frame's constants -- and a small piece of memory may be
 * a structure it reads. The capture of a whole run, its load included, is
 * its calls.
 *
 * It begins with the worker, since a frame names objects made at any time
 * before it, and ends a number of presents after it is told to (`mark`):
 * the frames to measure and everything they need.
 *
 * A capture is a gzip stream of records, each a kind (one byte), the root it
 * belongs to and the length of what follows (four bytes each, little-endian),
 * then that many bytes: JSON for `OPEN`, `ROOT` and `MARK`; for `CALLS`, the
 * number of presents in the batch (four bytes) and the batch.
 */

import { WAIT, createReader } from './wire.js';

export const CAPTURE = Object.freeze({ OPEN: 1, ROOT: 2, CALLS: 3, CLOSE: 4, MARK: 5 });

/**
 * Pieces of guest memory this large are zeroed: a buffer's vertices and
 * indices, a surface's texels. Smaller ones are few and stay whole.
 */
export const ZEROED_FROM = 4 << 10;

/** The record header's size: kind, root and length. */
const HEAD = 9;

/**
 * Zeroes, in place, the pieces of guest memory large enough: a view the
 * reader made is a view of the batch's own bytes.
 *
 * @param {{ bytes: Uint8Array }[] | undefined} parts
 * @returns {number}  how many bytes it zeroed
 */
const zeroMemory = parts=>{
    let zeroed = 0;
    for (const part of parts ?? [])
    {
        if (part.bytes.byteLength >= ZEROED_FROM)
        {
            part.bytes.fill(0);
            zeroed += part.bytes.byteLength;
        }
    }
    return zeroed;
};

/** @param {unknown} value @returns {Uint8Array} */
const jsonBytes = value=>new TextEncoder().encode(JSON.stringify(value ?? null,
    (_, one)=>(typeof one === 'function' || typeof one === 'bigint' ? undefined : one)));

/**
 * @param {{ CompressionStream?: any }} [deps]  the compressor's maker, the
 *     global one where there is one
 */
export function createCapture(deps = {}){
    const Compressor = deps.CompressionStream ?? /** @type {any} */ (globalThis).CompressionStream;
    const stream = new Compressor('gzip');
    const writer = stream.writable.getWriter();
    /** @type {Uint8Array[]} */
    const chunks = [];
    const drained = (async()=>{
        const reader = stream.readable.getReader();
        for (;;)
        {
            const { done, value } = await reader.read();
            if (done)
            {
                return;
            }
            chunks.push(value);
        }
    })();
    /**
     * Each root's own reading of its batches: a reader keeps the strings and
     * shapes of every batch before, as the played root's does.
     *
     * @type {Map<number, ReturnType<typeof createReader>>}
     */
    const readers = new Map();
    let roots = 0;
    /** Presents still to be kept once marked; below zero, not marked yet. */
    let left = -1;
    let stopped = false;
    /** Why it stopped before its end, when something could not be written down. */
    let failed = '';
    const counts = { batches: 0, presents: 0, sent: 0, kept: 0, zeroed: 0 };

    /** @param {number} kind @param {number} root @param {Uint8Array[]} parts */
    const put = (kind, root, parts)=>{
        const length = parts.reduce((sum, part)=>sum + part.byteLength, 0);
        const head = new Uint8Array(HEAD);
        const view = new DataView(head.buffer);
        view.setUint8(0, kind);
        view.setUint32(1, root, true);
        view.setUint32(5, length, true);
        writer.write(head);
        for (const part of parts)
        {
            if (part.byteLength > 0)
            {
                writer.write(part);
            }
        }
        counts.kept += HEAD + length;
    };

    return {
        /** @param {string} frames  what the worker was opened to do with frames */
        open(frames){
            if (!stopped)
            {
                put(CAPTURE.OPEN, 0, [jsonBytes({ frames })]);
            }
        },

        /**
         * A root as it was made: with `lending`, what it was sent of guest
         * memory it read in place (`lending.js`) and the capture has not, so a
         * replay lends it zeros out of `memory` bytes of its own.
         *
         * @param {{ api: string, options: any, source?: number, lending: boolean,
         *     memory: number }} made
         * @returns {number}  the root's number in the capture
         */
        root(made){
            const id = ++roots;
            readers.set(id, createReader({ ref: number=>number, service: ()=>null }));
            if (!stopped)
            {
                put(CAPTURE.ROOT, id, [jsonBytes(made)]);
            }
            return id;
        },

        /**
         * A batch as it came, before it is played: copied, since the played
         * side keeps views of what it reads.
         *
         * @param {number} id @param {ArrayBuffer} buffer
         */
        calls(id, buffer){
            const reader = readers.get(id);
            if (stopped || !reader)
            {
                return;
            }
            const copy = buffer.slice(0);
            let presents = 0;
            reader.read(copy, call=>{
                counts.zeroed += zeroMemory(call.ship) + zeroMemory(call.wrote);
                if (call.wait === WAIT.PACED)
                {
                    presents++;
                }
            });
            const count = new Uint8Array(4);
            new DataView(count.buffer).setUint32(0, presents, true);
            put(CAPTURE.CALLS, id, [count, new Uint8Array(copy)]);
            counts.batches++;
            counts.presents += presents;
            counts.sent += buffer.byteLength;
            if (left >= 0)
            {
                left -= presents;
                if (left <= 0)
                {
                    stopped = true;
                }
            }
        },

        /** @param {number} id */
        close(id){
            readers.delete(id);
            if (!stopped)
            {
                put(CAPTURE.CLOSE, id, []);
            }
        },

        /**
         * The frames to measure begin here; the capture ends `frames` presents
         * later.
         *
         * @param {number} frames
         */
        mark(frames){
            if (stopped || left >= 0)
            {
                return;
            }
            put(CAPTURE.MARK, 0, [jsonBytes({ frames, presents: counts.presents })]);
            left = Math.max(1, Math.floor(frames));
        },

        /** Whether it has ended: marked, and that many presents written since. */
        done: ()=>stopped,

        /**
         * It stops here, keeping what it has, because something sent could
         * not be written down: a capture with a hole is no capture of the run.
         *
         * @param {unknown} error
         */
        fail(error){
            stopped = true;
            failed ||= String(/** @type {any} */ (error)?.message ?? error);
        },

        /** What it has seen and kept, in batches, presents and bytes before compression. */
        counts: ()=>({ ...counts, stopped, left, failed }),

        /**
         * Ends it, if not ended, and answers it whole: the gzip stream.
         *
         * @returns {Promise<Uint8Array>}
         */
        async finish(){
            stopped = true;
            await writer.close();
            await drained;
            const out = new Uint8Array(chunks.reduce((sum, chunk)=>sum + chunk.byteLength, 0));
            let at = 0;
            for (const chunk of chunks)
            {
                out.set(chunk, at);
                at += chunk.byteLength;
            }
            return out;
        },
    };
}

/**
 * The records of a capture, read as its bytes come: a capture keeps the
 * zeroed bytes' places, so a run's is gigabytes once decompressed, and only
 * a record at a time is held. A record is yielded once all of it has come.
 *
 * @param {AsyncIterable<Uint8Array> | Iterable<Uint8Array>} chunks
 *     the capture after gunzip, in pieces of any size
 * @returns {AsyncGenerator<{ kind: number, root: number, json?: any, presents?: number,
 *     buffer?: ArrayBuffer }>}
 */
export async function* captureRecords(chunks){
    const decoder = new TextDecoder();
    /** @type {Uint8Array[]} */
    const queue = [];
    /** Bytes queued, and how far into the first piece they begin. */
    let queued = 0;
    let head = 0;
    const source = /** @type {any} */ (chunks)[Symbol.asyncIterator]?.()
        ?? /** @type {any} */ (chunks)[Symbol.iterator]();
    /** @param {number} need @returns {Promise<boolean>} whether that many came */
    const fill = async need=>{
        while (queued < need)
        {
            const { done, value } = await source.next();
            if (done)
            {
                return false;
            }
            if (value.length > 0)
            {
                queue.push(value);
                queued += value.length;
            }
        }
        return true;
    };
    /**
     * The next `count` bytes, in an ArrayBuffer of their own: a batch is
     * read from its first byte.
     *
     * @param {number} count
     */
    const take = count=>{
        const out = new Uint8Array(count);
        let at = 0;
        while (at < count)
        {
            const first = queue[0];
            const length = Math.min(first.length - head, count - at);
            out.set(first.subarray(head, head + length), at);
            at += length;
            head += length;
            if (head === first.length)
            {
                queue.shift();
                head = 0;
            }
        }
        queued -= count;
        return out;
    };
    while (await fill(HEAD))
    {
        const view = new DataView(take(HEAD).buffer);
        const kind = view.getUint8(0);
        const root = view.getUint32(1, true);
        const length = view.getUint32(5, true);
        if (!await fill(length))
        {
            throw new Error(`capture: a record of ${length} bytes runs past the end`);
        }
        if (kind === CAPTURE.CALLS)
        {
            const presents = new DataView(take(4).buffer).getUint32(0, true);
            yield { kind, root, presents, buffer: take(length - 4).buffer };
        }
        else if (kind === CAPTURE.CLOSE)
        {
            take(length);
            yield { kind, root };
        }
        else
        {
            yield { kind, root, json: JSON.parse(decoder.decode(take(length))) };
        }
    }
}
