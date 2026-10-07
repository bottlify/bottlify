/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's volume for a process in another thread (roadmap/v2, stage 2).
 *
 * A process reaches a drive through its overlay's operations, and each of
 * them is already in values: a path's components in, an entry or bytes out
 * -- every one looks its name up again, so nothing it answers points into the
 * tree. That makes the overlay the cut. The system's side answers the
 * operations of the drives it holds (`volumeHandlers`); a process in another
 * thread is handed drives that ask them across a link (`remoteVolume`), and
 * its filesystem layer stands on those as on its own. The sharing every open
 * is settled against goes the same way, settled and recorded on the system's
 * side in one call.
 *
 * What only the host asks of a drive -- a session's export and apply, the
 * writable layer's own pieces -- is not offered: it is the system's to do.
 */

import { createSharing } from './handles.js';
import { openSharedSharing } from './shared-sharing.js';

/** What a process may ask of a drive. */
const OPERATIONS = new Set(['stat', 'list', 'size', 'read', 'write', 'truncate', 'createFile',
    'createDirectory', 'moveFile', 'removeFile', 'removeDirectory', 'setModified']);

/**
 * What the system answers about the run's volume, as a link's handlers.
 *
 * @param {{ drives: Map<string, any>, volumes: Map<string, any>,
 *     sharing?: import('./handles.js').Sharing }} volume
 */
export function volumeHandlers(volume){
    if (!volume.sharing)
    {
        volume.sharing = createSharing();
    }
    const sharing = volume.sharing;
    return {
        volume: {
            /** The drives a process stands on, as it starts. */
            drives: ()=>[...volume.drives.keys()].map(letter=>({
                letter, readOnly: volume.drives.get(letter).readOnly === true,
                volume: volume.volumes.get(letter) ?? null,
            })),
            /**
             * @param {string} letter @param {string} operation @param {any[]} args
             */
            call(letter, operation, args){
                if (!OPERATIONS.has(operation))
                {
                    throw new Error(`volume: ${operation} is not asked of a drive from afar`);
                }
                const drive = volume.drives.get(letter);
                if (!drive)
                {
                    throw Object.assign(new Error(`No drive ${letter}: is mounted`),
                        { code: 'NO_SUCH_DRIVE' });
                }
                return drive[operation](...args);
            },
            /** @param {import('./handles.js').OpenTerms} terms */
            admit: terms=>sharing.admit(terms),
            /** @param {number} token */
            release: token=>sharing.release(token),
            /** @param {string} key */
            isOpen: key=>sharing.isOpen(key),
        },
    };
}

/**
 * An answer to `stat`, `list` or `size` as the caller may change it: an
 * entry, a listing of entries, a number.
 *
 * @param {any} answer
 */
const copyOf = answer=>(Array.isArray(answer) ? answer.map(entry=>({ ...entry }))
    : answer !== null && typeof answer === 'object' ? { ...answer } : answer);

/** What a process only reads of a drive, and may keep while the drive stands still. */
const READS = new Set(['stat', 'list', 'size']);

/**
 * How much of a file one read across fetches: a program reads an archive a
 * few hundred bytes at a time, and each of those across a link costs a round
 * trip of the system's thread, many times the copy of the bytes.
 */
export const CHUNK = 64 << 10;

/** What a process keeps of a drive's files, in chunks, before it drops the oldest. */
export const KEPT = 8 << 20;

/** A read at least this long goes across as it is, and is not kept. */
const LONG_READ = 1 << 20;

/**
 * What a process keeps of one drive: answers to reads, valid while the
 * drive's word in `revisions` stands where it stood when they were asked.
 * The word is raised on the system's thread after every change, and every
 * operation of a drive runs there, one after another: an answer asked after
 * the word was read is no older than the word, so one kept under it is
 * current for as long as the word has not moved.
 *
 * @param {(operation: string, args: any[]) => any} ask
 * @param {Int32Array} words @param {number} index
 */
function keptDrive(ask, words, index){
    let revision = Atomics.load(words, index) - 1;
    /** Answers to `stat`, `list` and `size`, by what was asked. @type {Map<string, any>} */
    const answers = new Map();
    /** A file's chunks, by path and chunk, oldest first. @type {Map<string, Uint8Array>} */
    const chunks = new Map();
    let keptBytes = 0;
    const counts = { hits: 0, misses: 0, dropped: 0 };
    /** The word now; what was kept under another is dropped. */
    const current = ()=>{
        const now = Atomics.load(words, index);
        if (now !== revision)
        {
            if (answers.size > 0 || chunks.size > 0)
            {
                counts.dropped++;
            }
            answers.clear();
            chunks.clear();
            keptBytes = 0;
            revision = now;
        }
        return now;
    };
    /** @param {string} key @param {Uint8Array} bytes @param {number} asked */
    const keep = (key, bytes, asked)=>{
        if (Atomics.load(words, index) !== asked)
        {
            return;
        }
        chunks.set(key, bytes);
        keptBytes += bytes.length;
        for (const [oldest, kept] of chunks)
        {
            if (keptBytes <= KEPT)
            {
                break;
            }
            chunks.delete(oldest);
            keptBytes -= kept.length;
        }
    };
    return {
        /** @param {string} operation @param {any[]} args */
        answer(operation, args){
            const asked = current();
            const key = `${operation}\0${JSON.stringify(args)}`;
            if (answers.has(key))
            {
                counts.hits++;
                return copyOf(answers.get(key));
            }
            counts.misses++;
            const answer = ask(operation, args);
            if (Atomics.load(words, index) === asked)
            {
                answers.set(key, copyOf(answer));
            }
            return answer;
        },
        /** @param {string[]} components @param {number} offset @param {number} length */
        read(components, offset, length){
            const asked = current();
            if (length >= LONG_READ || length <= 0 || offset < 0)
            {
                counts.misses++;
                return ask('read', [components, offset, length]);
            }
            const path = components.join('\\');
            const first = Math.floor(offset / CHUNK);
            const last = Math.floor((offset + length - 1) / CHUNK);
            /** @type {Uint8Array[]} */
            const pieces = [];
            for (let chunk = first; chunk <= last; chunk++)
            {
                const key = `${path}\0${chunk}`;
                let bytes = chunks.get(key);
                if (bytes)
                {
                    counts.hits++;
                    // Read again, it is the newest: the oldest goes first.
                    chunks.delete(key);
                    chunks.set(key, bytes);
                }
                else
                {
                    counts.misses++;
                    bytes = /** @type {Uint8Array} */ (ask('read', [components, chunk * CHUNK, CHUNK]));
                    keep(key, bytes, asked);
                }
                pieces.push(bytes);
                // A chunk short of whole is the end of the file.
                if (bytes.length < CHUNK)
                {
                    break;
                }
            }
            const start = offset - first * CHUNK;
            const out = new Uint8Array(Math.max(0, Math.min(length,
                pieces.reduce((sum, piece)=>sum + piece.length, 0) - start)));
            let at = -start;
            for (const piece of pieces)
            {
                const from = Math.max(0, -at);
                const to = Math.min(piece.length, out.length - at);
                if (to > from)
                {
                    out.set(piece.subarray(from, to), at + from);
                }
                at += piece.length;
            }
            return out;
        },
        diagnostics: ()=>({ ...counts, keptBytes }),
    };
}

/**
 * What of the run's volume is in memory every thread holds: a word per drive
 * letter, raised after every change to the drive (`tree.js`), and the
 * sharing every open is settled against (`shared-sharing.js`).
 *
 * @typedef {{ revisions?: Int32Array | null, sharing?: SharedArrayBuffer | null }} VolumeMemory
 */

/**
 * The run's volume as a process in another thread stands on it: the shape
 * the filesystem layer takes as `config.volume`, its drives and its sharing
 * asking the system's side through `ask`.
 *
 * @param {(method: string, args: any[]) => any} ask  a blocking call to `volumeHandlers`
 * @param {VolumeMemory | null} [memory]
 *     the run's memory of its volume, where it has any: with it, what a
 *     process reads of a drive is kept here until the drive changes, and an
 *     open is settled against every other here rather than asked
 * @param {((method: string, args: any[]) => void) | null} [tell]
 *     a call to `volumeHandlers` that does not wait for its answer, for what
 *     has none to wait for
 */
export function remoteVolume(ask, memory = null, tell = null){
    const revisions = memory?.revisions ?? null;
    /** @type {Map<string, any>} */
    const drives = new Map();
    /** @type {Map<string, any>} */
    const volumes = new Map();
    for (const { letter, readOnly, volume } of ask('drives', []))
    {
        /** @param {string} operation @param {any[]} args */
        const call = (operation, args)=>ask('call', [letter, operation, args]);
        const kept = revisions ? keptDrive(call, revisions, letter.charCodeAt(0) - 0x41) : null;
        /** @type {Record<string, any>} */
        const drive = { readOnly,
            // The run's report counts what is on its volume; a process
            // standing on it from afar says only that it does, and how much
            // of what it read it had kept.
            diagnostics: ()=>({ across: true, ...kept?.diagnostics() }) };
        for (const operation of OPERATIONS)
        {
            drive[operation] = (/** @type {any[]} */ ...args)=>call(operation, args);
        }
        if (kept)
        {
            for (const operation of READS)
            {
                drive[operation] = (/** @type {any[]} */ ...args)=>kept.answer(operation, args);
            }
            drive.read = (/** @type {string[]} */ components, /** @type {number} */ offset,
                /** @type {number} */ length)=>kept.read(components, offset, length);
        }
        drives.set(letter, drive);
        if (volume)
        {
            volumes.set(letter, volume);
        }
    }
    return {
        drives,
        volumes,
        writables: new Map(),
        watchers: new Set(),
        /** @type {import('./handles.js').Sharing} */
        sharing: memory?.sharing ? openSharedSharing(memory.sharing) : {
            admit: terms=>ask('admit', [terms]),
            // A close is never refused, and nothing waits on it: what the
            // process does next that another could see -- a child started,
            // an event set -- is asked of the system behind it, in order.
            release: token=>(tell ? tell('release', [token]) : ask('release', [token])),
            isOpen: key=>ask('isOpen', [key]),
        },
    };
}
