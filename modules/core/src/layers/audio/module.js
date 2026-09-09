/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createDirectSound } from './dsound/seam.js';
import { createMixer } from './output/mixer.js';

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
 * The mixer is where sound leaves. It is host-independent on purpose: it adds
 * every open source together, converts to one format, and writes ahead into a
 * ring in shared memory. What turns that into something audible is a WebAudio
 * worklet reading the other end of the ring, and that lives with whoever
 * assembled the process -- the same division as the GPU device the graphics
 * layer is handed rather than opens.
 *
 * A build with nothing draining the ring is not a broken build. The ring fills,
 * writes are refused, and a program's cursor stops advancing -- which is what a
 * device that is not consuming looks like from inside a program, and is
 * therefore the honest thing for it to look like from inside this one.
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

        // Whether the other end of the ring is being read. Told from outside,
        // because only the assembling caller knows whether it opened a device.
        const drained = config?.drained ?? false;

        let nextAddress = 0x50000000;
        const allocate = config?.allocate ?? ((/** @type {number} */ bytes)=>{
            const address = nextAddress;
            nextAddress += (bytes + 0xfff) & ~0xfff;
            return address;
        });

        // The mixer asks for sound before every mix, and that is where the
        // DirectSound buffers are read out. Whoever drives the machine reaches
        // the mixer directly, so hooking this anywhere else in this module
        // would leave it never called.
        const mixer = createMixer({
            sampleRate: config?.sampleRate,
            fill: ()=>feedBuffers(),
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

        /**
         * One mixer track per sound buffer, made when it first plays.
         *
         * Per buffer rather than per format, because each carries its own
         * volume and a track is where a gain lives. Weak, so a buffer the
         * program has finished with takes its track's name with it.
         *
         * @type {WeakMap<any, any>}
         */
        const tracks = new WeakMap();

        /**
         * Spans of a buffer that were never handed over because the output was
         * already further ahead than it can play.
         *
         * Counted rather than silent: this is sound the program produced and
         * nobody will hear, which is a difference from the machine it was
         * written for and belongs in a report rather than in nothing.
         */
        let dropped = 0;

        /**
         * Hands every playing buffer's newly-played bytes to the mixer.
         *
         * DirectSound's cursors used to advance with nobody reading what they
         * passed over, so every buffer behaved correctly in everything a
         * program can observe and none of it was ever heard. This is the seam
         * that was missing: the wave-out path writes into the mixer when a
         * program hands over a buffer, and this one reads out of a buffer the
         * program wrote into long ago, at the rate the cursor moves.
         */
        const feedBuffers = ()=>{
            // Nothing is reading the other end, so everything read out here
            // would be mixed and thrown away. The cursors still advance -- that
            // is DirectSound's own business and the program watches them -- but
            // the samples they pass over have nowhere to go, and this runs on
            // every mix of every turn.
            if (!drained)
            {
                return;
            }
            for (const buffer of dsound.buffers())
            {
                // The primary buffer is the mix target and holds no samples of
                // the program's own; reading it would play whatever the
                // allocator left there.
                if (buffer.primary)
                {
                    continue;
                }
                const ranges = buffer.drainPlayed();
                if (ranges.length === 0)
                {
                    continue;
                }
                let track = tracks.get(buffer);
                if (!track)
                {
                    track = mixer.open({
                        // The rate playback actually runs at, which a program
                        // may have retuned away from the format's own.
                        sampleRate: buffer.frequency,
                        channels: buffer.format.channels,
                        bitsPerSample: buffer.format.bitsPerSample,
                    });
                    tracks.set(buffer, track);
                }
                track.gain = buffer.gain;
                // A track this far ahead is not behind on work, it is holding
                // audio whose moment has passed: the cursor is driven by the
                // guest's clock and the ring drains at the speed of a real
                // device, so anything the clock produces beyond the ring's own
                // depth would only ever be played late, and later still the
                // next time. Dropped and counted rather than queued, because a
                // queue with nothing bounding it grows for as long as the sound
                // plays.
                if (track.pending() > mixer.capacityFrames)
                {
                    dropped++;
                    continue;
                }
                for (const range of ranges)
                {
                    track.write(memory.readBytes(buffer.address + range.from, range.bytes));
                }
            }
        };

        current = {
            /**
             * The libraries, keyed as an import descriptor names them. The
             * assembling caller merges these with win32's and hands the lot to
             * the loader; nothing here needs a special case.
             */
            libraries: ()=>dsound.libraries,

            /**
             * Where a sound API sends its samples.
             *
             * Handed out rather than reached for: win32's wave-out surface
             * sits below this layer and cannot import it, so the assembling
             * caller passes this down as a thunk the same way it passes down
             * the thread's last error.
             */
            output: ()=>mixer,

            /**
             * Mixes ahead into the ring. Called once a scheduler turn by
             * whoever is driving the machine, which is the only place that
             * knows a turn has happened.
             *
             * @param {number} [frames]
             */
            pump: frames=>mixer.pump(frames),

            /** Whether anything is draining the ring. */
            available: ()=>drained,

            /** The buffers a program has created, for whoever is measuring. */
            buffers: ()=>dsound.buffers(),

            dsound: ()=>dsound,

            /** Spans the output was too far ahead to take. */
            dropped: ()=>dropped,
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
                ...(current ? current.output().diagnostics() : {}),
                droppedSpans: current ? current.dropped() : 0,
            },
        };
    },

    async dispose(){
        current = null;
    },
};
