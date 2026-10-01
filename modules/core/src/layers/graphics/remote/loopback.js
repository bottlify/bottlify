/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A recorded device and its played twin in one thread, call for call: the
 * program talks to a device with no renderer behind it, and every call is
 * played at once on a device made with the caller's renderer, over a guest
 * memory of only the bytes the recording sent. What a renderer draws through
 * it is what the replay carries, so a scene that draws the same through this
 * as through a device of its own is one the replay misses nothing of -- the
 * test of the replay without a port between the two.
 */

import { playedAtOnce, playedDirect3D, recordedDirect3D } from './direct3d.js';

/**
 * @param {(services: any) => any} factory  `createDirect3D9` or `createDirect3D8`
 * @param {any} [services]  what the factory would be given: its backend draws for the played device
 * @param {(services: any) => any} [playedFactory]  the same, as the played device's
 *     thread has it: of a module graph of its own, as another thread's would be
 * @returns {any} the root the program is given
 */
export function loopbackDirect3D(factory, services = {}, playedFactory = factory){
    return recordedDirect3D(factory, services,
        playedAtOnce(playedDirect3D(playedFactory, services)));
}
