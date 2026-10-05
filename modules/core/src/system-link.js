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
 * calls and wait. What cannot cross is said where it stops: a named kernel
 * object is the process's own, and the windows of a process across a link are
 * not yet found or sent to by another process.
 */

import { volumeHandlers, remoteVolume } from './layers/filesystem/internal/volume-link.js';
import { takeId } from './layers/kernel/internal/processes.js';

/** What a process asks of the registry; the rest -- saving, loading -- is the system's. */
const REGISTRY = ['root', 'open', 'create', 'remove', 'subkeys', 'values', 'getValue', 'setValue',
    'rename', 'deleteValue', 'placeOf', 'throughClasses', 'detached', 'forget', 'revision'];

/** What a process asks of the window directory. */
const WINDOWS = ['open', 'close', 'ownerOf', 'describe', 'find', 'register', 'registeredName',
    'hold', 'send', 'answer', 'withdraw', 'post', 'detach'];

/**
 * A process across a link answers nothing about its windows yet: they are
 * its own to find and send to.
 */
const ACROSS = {
    find: ()=>0,
    describe: ()=>null,
    post: ()=>false,
    send: ()=>null,
    answer: ()=>null,
    withdraw: ()=>{},
};

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
 */
export function systemHandlers(system){
    return {
        registry: answering(system.registry, REGISTRY),
        ids: { take: (/** @type {'thread' | 'process'} */ name, /** @type {number} */ step)=>
            takeId(system.ids, name, step) },
        ...volumeHandlers(system.volume),
        windows: {
            ...answering(system.windows, WINDOWS),
            /** @param {number} processId */
            attach: processId=>system.windows.attach(processId, ACROSS),
        },
    };
}

/**
 * The run's system as a process across a link sees it.
 *
 * @param {(target: string, method: string, args: any[]) => any} ask
 *     a blocking call to `systemHandlers`
 */
export function remoteSystem(ask){
    /** @param {string} target @param {string[]} names */
    const asking = (target, names)=>Object.fromEntries(names.map(name=>
        [name, (/** @type {any[]} */ ...args)=>ask(target, name, args)]));
    return {
        // A process's named objects are its own across a link: the waits on
        // them are its scheduler's, and no other process's can wake them yet.
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
            /** @param {number} processId */
            attach: processId=>ask('windows', 'attach', [processId]),
        },
        bundle: null,
    };
}
