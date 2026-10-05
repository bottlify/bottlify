/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's system half, across a link (roadmap/v2, stage 2): what a process
 * in a worker of its own is handed in place of the `system` object the
 * processes on the engine's thread share.
 *
 * Every service of that object already answers in values -- the registry
 * names keys by number, the window directory windows by handle, the volume
 * answers entries and bytes, ids are numbers -- so each crosses as it is:
 * `systemHandlers` answers a link's calls from the run's own services, and
 * `remoteSystem` gives the process objects of the same shape that make those
 * calls and wait. A process across a link answers for its own windows the same
 * way, asked back across it: the thread here blocks for the answer, and the
 * process gives it at its next look at the link -- between two turns, while
 * idle, or inside a call of its own that is waiting. What cannot cross is said
 * where it stops: a wait on a set holding another process's object is refused
 * (`sync.js`).
 */

import { volumeHandlers, remoteVolume } from './layers/filesystem/internal/volume-link.js';
import { takeId } from './layers/kernel/internal/processes.js';

/** What a process asks of the registry; the rest -- saving, loading -- is the system's. */
const REGISTRY = ['root', 'open', 'create', 'remove', 'subkeys', 'values', 'getValue', 'setValue',
    'rename', 'deleteValue', 'placeOf', 'throughClasses', 'detached', 'forget', 'revision'];

/** What a process asks of the window directory. */
const WINDOWS = ['open', 'close', 'ownerOf', 'describe', 'find', 'register', 'registeredName',
    'hold', 'send', 'answer', 'withdraw', 'post', 'detach'];

/** What a process answers about its own windows (`directory.js`'s `WindowEndpoint`). */
const ENDPOINT = ['find', 'describe', 'post', 'send', 'answer', 'withdraw'];

/**
 * @param {Record<string, any>} service @param {string[]} names
 * @returns {Record<string, (...args: any[]) => any>}
 */
const answering = (service, names)=>Object.fromEntries(names.map(name=>
    [name, (/** @type {any[]} */ ...args)=>service[name](...args)]));

/**
 * The link's handlers that answer for the run's system.
 *
 * @param {{ registry: any, ids: any, volume: any, windows: any }} system
 * @param {(target: string, method: string, args: any[]) => any} [askBack]
 *     a blocking call to the process across the link, for its windows
 */
export function systemHandlers(system, askBack){
    return {
        registry: answering(system.registry, REGISTRY),
        ids: { take: (/** @type {'thread' | 'process'} */ name, /** @type {number} */ step)=>
            takeId(system.ids, name, step) },
        ...volumeHandlers(system.volume),
        windows: {
            ...answering(system.windows, WINDOWS),
            /** @param {number} processId */
            attach: processId=>system.windows.attach(processId, Object.fromEntries(
                ENDPOINT.map(name=>[name, (/** @type {any[]} */ ...args)=>
                    (askBack ? askBack('endpoint', name, args) : null)]))),
        },
    };
}

/**
 * The run's system as a process across a link sees it.
 *
 * @param {(target: string, method: string, args: any[]) => any} ask
 *     a blocking call to `systemHandlers`
 * @param {Record<string, any>} [handlers]
 *     the process's side of the link, where what it answers for its own
 *     windows is put when its window manager attaches
 */
export function remoteSystem(ask, handlers = {}){
    /** @param {string} target @param {string[]} names */
    const asking = (target, names)=>Object.fromEntries(names.map(name=>
        [name, (/** @type {any[]} */ ...args)=>ask(target, name, args)]));
    return {
        // The run's named objects are asked there (`objects`); this table is
        // not consulted.
        namedObjects: new Map(),
        registry: {
            ...asking('registry', REGISTRY),
            // A change is the system's to save; nothing here listens for one.
            onChanged: ()=>()=>{},
        },
        ids: { take: (/** @type {string} */ name, /** @type {number} */ step)=>
            ask('ids', 'take', [name, step]) },
        volume: remoteVolume((method, args)=>ask('volume', method, args)),
        windows: {
            ...asking('windows', WINDOWS),
            /** @param {number} processId @param {any} endpoint */
            attach(processId, endpoint){
                handlers.endpoint = Object.fromEntries(ENDPOINT.map(name=>
                    [name, (/** @type {any[]} */ ...args)=>endpoint[name](...args)]));
                ask('windows', 'attach', [processId]);
            },
        },
        objects: remoteObjects(ask),
        bundle: null,
    };
}

/** What a process asks of the run's named objects (`system-objects.js`). */
const OBJECTS = ['peek', 'create', 'reference', 'close', 'wait', 'cancel', 'poll', 'set', 'reset',
    'release', 'releaseMutex'];

/**
 * The run's named objects, asked across a link; and where the word that one
 * of this process's waits ended there is delivered (`deliver`, from the
 * link's `kernel.wake`) to whoever listens (`onWake`, the kernel).
 *
 * @param {(target: string, method: string, args: any[]) => any} ask
 */
function remoteObjects(ask){
    /** @type {((token: number, result: number) => void) | null} */
    let listener = null;
    return {
        ...Object.fromEntries(OBJECTS.map(name=>
            [name, (/** @type {any[]} */ ...args)=>ask('objects', name, args)])),
        /** @param {(token: number, result: number) => void} handler */
        onWake(handler){
            listener = handler;
        },
        /** @param {number} token @param {number} result */
        deliver(token, result){
            listener?.(token, result);
        },
    };
}
