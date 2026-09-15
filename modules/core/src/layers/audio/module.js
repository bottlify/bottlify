/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createDirectSound } from './dsound/seam.js';
import { createMixer } from './output/mixer.js';
import { createMp3Provider } from './asi/provider.js';
import { createSynchronousDecoder, createWebCodecsDecoder } from './asi/mp3.js';

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
        // The route into guest code. A sound library of this era hands the
        // system a callback and expects it run before the call returns -- an
        // enumeration that never calls back is read as "there is no device
        // here" -- so a table that cannot call the guest cannot answer those
        // calls truthfully. Optional, because a caller assembling this module
        // for a test has no bridge and no guest to call.
        const bridge = host.requireApi('bridge');

        // Whether the other end of the ring is being read. Told from outside,
        // because only the assembling caller knows whether it opened a device.
        const drained = config?.drained ?? false;
        const signal = config?.signal ?? null;
        let notified = 0;
        // The whole path a sound takes, counted at each stage. Without these a
        // silent run and a working one produce the same report, and the first
        // question -- did anything come out of a buffer at all -- has no answer.
        let fills = 0;
        let refusedFills = 0;
        let fedBytes = 0;
        let fedRanges = 0;
        let openTracks = 0;

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
            // The output a machine that replaced this program's predecessor
            // already handed whoever reads its far end. Absent on the first
            // process, which makes its own.
            memory: config?.memory,
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
            /**
             * Runs a guest routine and answers with what it returned. The
             * bridge parks the caller while it does, which is what makes a
             * callback delivered from inside a host call legal here.
             *
             * @param {number} entry @param {number[]} args
             * @returns {Promise<number>}
             */
            callGuest: config?.callGuest
                ?? ((/** @type {number} */ entry, /** @type {number[]} */ args)=>
                    bridge.callGuest({ entry, args })),
        });

        // What decodes behind the provider. The library asks for its samples
        // in a call and holds a lock while it asks, so a decoder that answers
        // later parks the guest thread and everything waiting on that lock
        // with it; the assembling caller's `openAudio` -- the media layer's
        // hosted decoder -- answers in the call, and the platform's decoder
        // is only the fallback for a build whose binary cannot.
        const decoder = config?.decoder
            ?? (config?.openAudio
                ? createSynchronousDecoder(config.openAudio, createWebCodecsDecoder())
                : createWebCodecsDecoder());

        // The MPEG decoder a sound library of this era loads beside a program
        // as a provider of its own. Hosted, because decoding it in the guest
        // costs a fifth of the machine; reached through the same library
        // table as everything else, because to the program it is a file it
        // ships that LoadLibrary found.
        const mp3 = createMp3Provider({
            /** @param {number} address @param {number} length */
            readMemory: (address, length)=>memory.readBytes(address, length),
            /** @param {number} address @param {Uint8Array} bytes */
            writeMemory: (address, bytes)=>memory.writeBytes(address, bytes),
            allocate,
            callGuest: config?.callGuest
                ?? ((/** @type {number} */ entry, /** @type {number[]} */ args,
                    /** @type {any} */ thread)=>bridge.callGuest({ entry, args, thread })),
            currentThread: config?.currentThread ?? (()=>undefined),
            resolveImport: config?.resolveImport ?? (()=>null),
            decoder,
            /** @param {string} text */
            warn: text=>config?.warn?.(text),
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
         * Times a track's backlog was thrown away for being past its moment.
         *
         * A count above zero is a machine that fell behind its own sound, which
         * a person hears as a break. It belongs in a report rather than in
         * nothing.
         */
        let behind = 0;

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
            fills++;
            // Told first, and told whatever else happens here.
            //
            // A program that streams into a sound buffer does not poll it: it
            // asks to be woken at positions and waits on an event, and the
            // thread that refills the buffer is that wait. Nothing ever tested
            // those positions, so the wake never came, the refill never
            // happened, and a program that had set its sound up correctly sat
            // in silence with several threads blocked for ever.
            //
            // Deliberately before the check below, because this is owed whether
            // or not anything is listening to the result. A build with no sound
            // device must still not hang the program that asked for one.
            for (const buffer of dsound.buffers())
            {
                for (const event of buffer.drainNotifications())
                {
                    notified++;
                    signal?.(event);
                }
            }
            // Nothing is reading the other end, so everything read out here
            // would be mixed and thrown away. The cursors still advance -- that
            // is DirectSound's own business and the program watches them -- but
            // the samples they pass over have nowhere to go, and this runs on
            // every mix of every turn.
            if (!drained)
            {
                refusedFills++;
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
                let track = tracks.get(buffer);
                const ranges = buffer.drainPlayed();
                if (ranges.length === 0)
                {
                    continue;
                }
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
                    openTracks++;
                }
                // Too far ahead to be worth playing: the cursor is driven by the
                // guest's clock and the ring drains at the pace of a real
                // device, so a queue past the ring's own depth is audio whose
                // moment has gone.
                //
                // What goes is the backlog, not the span just read. Refusing the
                // new span instead leaves the old one queued in front of it, so
                // the machine plays a fixed lateness for ever and never catches
                // up -- and the sound a program is making *now* is the one it
                // meant to be heard.
                if (track.pending() > mixer.capacityFrames)
                {
                    track.reset();
                    behind++;
                }
                track.gain = buffer.gain;
                for (const range of ranges)
                {
                    fedBytes += range.bytes;
                    fedRanges++;
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
            libraries: ()=>(config?.mp3 === false
                ? { ...dsound.libraries }
                : { ...dsound.libraries, ...mp3.libraries }),

            /** The MPEG provider, for whoever is measuring. */
            mp3: ()=>mp3,

            /** Which decoder stands behind it, and how its streams were served. */
            decoder: ()=>decoder.diagnostics?.() ?? { name: 'custom' },

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
             * What came out of the program's own sound buffers.
             *
             * `sink` is the one that decides everything else: with nothing
             * draining the other end this layer reads no samples at all, on
             * purpose, and every other number here is legitimately zero. A run
             * with no sound and no sink is not a defect in the sound path.
             */
            feeding: ()=>({
                sink: drained,
                fills,
                refusedFills,
                notified,
                fedRanges,
                fedBytes,
                tracksOpen: openTracks,
            }),

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

            /** Turns a buffer was left unread because its track was full. */
            behind: ()=>behind,
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
                mp3: current ? current.mp3().diagnostics() : null,
                decoder: current ? current.decoder() : null,
                ...(current ? current.output().diagnostics() : {}),
                behindTurns: current ? current.behind() : 0,
                ...(current ? current.feeding() : {}),
                // Every sound buffer's own state. A count of buffers says a
                // program made some; this says whether any of them is playing,
                // where its cursor stands and how much of it was ever filled --
                // which is what separates a silent buffer from a busy one.
                bufferDetail: current ? current.dsound().buffers()
                    .filter((/** @type {any} */ b)=>!b.primary)
                    .map((/** @type {any} */ b)=>{
                        const c = b.cursors();
                        return `st=${b.status()} play=${c.play} write=${c.write}`
                            + ` bytes=${b.bytes} freq=${b.frequency}`;
                    }) : [],
            },
        };
    },

    async dispose(){
        current = null;
    },
};
