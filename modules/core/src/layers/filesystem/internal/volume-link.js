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
 * The run's volume as a process in another thread stands on it: the shape
 * the filesystem layer takes as `config.volume`, its drives and its sharing
 * asking the system's side through `ask`.
 *
 * @param {(method: string, args: any[]) => any} ask  a blocking call to `volumeHandlers`
 */
export function remoteVolume(ask){
    /** @type {Map<string, any>} */
    const drives = new Map();
    /** @type {Map<string, any>} */
    const volumes = new Map();
    for (const { letter, readOnly, volume } of ask('drives', []))
    {
        /** @type {Record<string, any>} */
        const drive = { readOnly,
            // The run's report counts what is on its volume; a process
            // standing on it from afar says only that it does.
            diagnostics: ()=>({ across: true }) };
        for (const operation of OPERATIONS)
        {
            drive[operation] = (/** @type {any[]} */ ...args)=>
                ask('call', [letter, operation, args]);
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
        sharing: {
            admit: terms=>ask('admit', [terms]),
            release: token=>ask('release', [token]),
            isOpen: key=>ask('isOpen', [key]),
        },
    };
}
