/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { createDirectSound } from './dsound/seam.js';

/**
 * audio — the sound APIs a program was written against.
 *
 * Everything this layer needs from outside itself is injected rather than
 * reached for, and each of the four has a reason:
 *
 * - **Guest memory to put samples in.** A program locks a buffer and is handed
 *   a pointer it writes through, so the bytes have to be somewhere it can
 *   address. The allocator belongs to whoever assembled the process; the
 *   default here hands out distinct, page-aligned addresses and never touches
 *   them, so the model is testable with no guest at all.
 * - **The guest's clock.** Cursors advance against time, and the wave-out path
 *   already advances against `kernel.clock`. Two clocks would disagree the
 *   moment a program used both APIs, which is the ordinary case: a game plays
 *   its music through one and its effects through the other.
 * - **A way to signal an event.** IDirectSoundNotify names event handles, and
 *   setting one is the kernel's business.
 * - **The bridge's vtable publisher.** Without it the tables refuse rather than
 *   publishing into nowhere, which is what a build with no bridge behind it --
 *   a test, an inspection of the configuration -- should get.
 *
 * There is no output device. Nothing here opens WebAudio, and the file that
 * models a buffer says why that changes nothing a program can observe: what it
 * depends on is the pair of cursors, not the sound.
 */

/** @type {any} */
let current = null;

export const audioModule = {
    name: 'audio',
    version: '0.1.0',
    requires: /** @type {readonly string[]} */ (['win32', 'bridge', 'memory']),

    /**
     * @param {any} config
     * @param {import('../../system/contract.js').ScopedModuleHost} host
     * @returns {Promise<any>}
     */
    async create(config, host){
        const memory = host.requireApi('memory');

        let nextAddress = 0x50000000;
        const allocate = config?.allocate ?? ((/** @type {number} */ bytes)=>{
            const address = nextAddress;
            nextAddress += (bytes + 0xfff) & ~0xfff;
            return address;
        });

        const dsound = createDirectSound({
            memory: {
                /** @param {number} address @param {number} length */
                readMemory: (address, length)=>memory.readBytes(address, length),
                /** @param {number} address @param {Uint8Array} bytes */
                writeMemory: (address, bytes)=>memory.writeBytes(address, bytes),
            },
            allocate,
            now: config?.now ?? (()=>Date.now()),
            publishInterface: config?.publishInterface ?? (()=>0),
            signal: config?.signal,
        });

        current = {
            /**
             * The libraries, keyed as an import descriptor names them. The
             * assembling caller merges these with win32's and hands the lot to
             * the loader; nothing here needs a special case.
             */
            libraries: ()=>dsound.libraries,

            /** Whether anything can actually be heard. Nothing can, yet. */
            available: ()=>false,

            /** The buffers a program has created, for whoever is measuring. */
            buffers: ()=>dsound.buffers(),

            dsound: ()=>dsound,
        };
        return current;
    },

    /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
    diagnostics(){
        return {
            name: 'audio',
            version: '0.1.0',
            status: current ? 'ready' : 'created',
            metrics: {
                libraries: current ? Object.keys(current.libraries()) : [],
                ...(current ? current.dsound().diagnostics() : {}),
            },
        };
    },

    async dispose(){
        current = null;
    },
};
