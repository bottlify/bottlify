/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * DirectMusic's classes, as a program reaches them with CoCreateInstance, and
 * the objects behind them.
 *
 * A program of this era does not link DirectMusic's behaviour; it asks for a
 * class by CLSID and calls through the interface it gets back. That is why the
 * classes are registered here and the implementation lives beside this file:
 * the registry and the bridge between them turn a definition at each class
 * into the vtable slots, the reference counting and the pointer identity the
 * guest walks.
 *
 * Nothing is answered by a class that a program did not ask for: a class that
 * fails to produce an object is a class the program takes another path around,
 * which is a better report of "this is not built" than a table full of stubs.
 */

import { createDirectMusic } from './objects.js';
import * as ids from './ids.js';

export * from './ids.js';

/**
 * @typedef {Object} DirectMusicHost
 * @property {{ registerClass: (clsid: string, factory: () => any) => void }} registry
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {any} [memory]
 * @property {(object: any, iid: string) => number} [publishInterface]
 * @property {(pointer: number) => any} [objectAt]
 * @property {(bytes: number) => number} [allocate]
 * @property {(address: number) => void} [free]
 * @property {(entry: number, args: number[], thread?: any) => Promise<number>} [callGuest]
 * @property {() => any} [callerThread]
 * @property {() => any} [output]
 * @property {() => number} [now]
 * @property {(path: string) => Promise<Uint8Array | null>} [readFile]
 * @property {(bytes: Uint8Array, shape: any) => Promise<any>} [decodeWave]
 */

/**
 * The classes this engine answers for, and what drives them.
 *
 * @param {DirectMusicHost} host
 * @returns {{ tick: () => void, diagnostics: () => any }}
 */
export function registerDirectMusic(host){
    const music = createDirectMusic(/** @type {any} */ (host));
    host.registry.registerClass(ids.CLSID_DIRECTMUSIC_PERFORMANCE, ()=>music.performance());
    host.registry.registerClass(ids.CLSID_DIRECTMUSIC_LOADER, ()=>music.loader());
    host.registry.registerClass(ids.CLSID_DIRECTMUSIC, ()=>music.directMusic());
    // A program of this era makes a segment with CoCreateInstance and then
    // hands it the bytes it loaded itself, so the class has to exist even
    // though the loader is the other way one arrives.
    host.registry.registerClass(ids.CLSID_DIRECTMUSIC_SEGMENT, ()=>music.segment());
    // A segment's wave references are resolved by the program's own loader,
    // which creates each wave by this class and loads the file into the
    // object this engine owns -- so the samples reach the wave track through
    // here and nowhere else.
    host.registry.registerClass(ids.CLSID_DIRECTSOUND_WAVE, ()=>music.wave());
    return {
        tick: music.tick,
        diagnostics: music.diagnostics,
    };
}
