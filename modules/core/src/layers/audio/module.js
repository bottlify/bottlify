/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createDirectSound } from './dsound/seam.js';
import { registerDirectMusic } from './dmusic/classes.js';
import { DSBSTATUS_PLAYING } from './dsound/buffers.js';
import { createMixer } from './output/mixer.js';
import { createMp3Provider } from './asi/provider.js';
import { createSynchronousDecoder, createWebCodecsDecoder, splitFrames } from './asi/mp3.js';

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

/** The audio layer's module for one graph; see `defaultModules`. */
export function createAudioModule(){
    /**
     * The instance this module object made last, for `diagnostics()` and
     * `dispose()`. Every graph is given module objects of its own
     * (`defaultModules`), so a child's graph built beside its parent's has
     * its own and neither one's going reaches the other's.
     *
     * @type {any}
     */
    let current = null;

    return {
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

            // DirectMusic's classes, which a program asks for by CLSID rather
            // than through an export. Held until the mixer and the decoder
            // exist, because what plays a segment's waves is the one and what
            // decodes them is the other.
            const win32 = host.requireApi('win32');
            // A build with win32 stubbed -- one where nothing asked for win32
            // and it was switched off -- has no class registry to put
            // DirectMusic's classes in. Asking for it would throw the stub's
            // refusal, which is the right answer to a *call* and the wrong
            // one to a graph being assembled: DirectMusic is simply absent.
            /** @type {any} */
            let com;
            try
            {
                com = win32?.com?.() ?? null;
            }
            catch {
                com = null;
            }
            /** @type {any} */
            let dmusic = null;

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
            /** Sound buffers handed to the sound device, over the run. */
            let voices = 0;
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
                // Told from outside because only the assembling caller knows
                // whether shared memory reaches a worklet on the other end: a
                // reader without it -- the test-page harness, any page that is
                // not cross-origin isolated -- can only read on this thread, and
                // the engine mixer is the only backend that thread can drive.
                shared: config?.shared ?? false,
            });
            /** The sound device, when there is one: the shared backend opens voices. @type {any} */
            const output = mixer;

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
                 * @param {number} entry @param {number[]} args @param {any} [thread]
                 * @returns {Promise<number>}
                 */
                callGuest: config?.callGuest
                    ?? ((/** @type {number} */ entry, /** @type {number[]} */ args,
                        /** @type {any} */ thread)=>bridge.callGuest({ entry, args, thread })),
                callerThread: config?.callerThread ?? (()=>bridge.callerThread()),
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

            /**
             * Decodes a compressed wave's frames into interleaved 16-bit PCM.
             *
             * A segment's wave track names a `.wav`, and a `.wav` in a
             * DirectMusic library is very often an MPEG Layer 3 stream inside
             * a RIFF header. The mixer behind this layer plays PCM, so the
             * stream is cut at its own frame boundaries and run through the
             * same decoder the program's sound library would have used.
             *
             * @param {Uint8Array} bytes
             * @returns {Promise<{ samples: Int16Array, sampleRate: number,
             *     channels: number } | null>}
             */
            const decodeWave = async bytes=>{
                const frames = splitFrames(bytes);
                if (frames.length === 0)
                {
                    return null;
                }
                return await new Promise((resolve, reject)=>{
                    /** @type {Int16Array[]} */
                    const parts = [];
                    let total = 0;
                    const stream = decoder.open(frames[0].header,
                        (/** @type {Int16Array} */ pcm)=>{
                            parts.push(pcm);
                            total += pcm.length;
                        },
                        (/** @type {Error} */ error)=>reject(error));
                    for (const frame of frames)
                    {
                        const end = frame.offset + frame.header.length;
                        stream.feed(bytes.subarray(frame.offset, end), frame.header);
                    }
                    Promise.resolve(stream.flush()).then(()=>{
                        stream.close();
                        const samples = new Int16Array(total);
                        let at = 0;
                        for (const part of parts)
                        {
                            samples.set(part, at);
                            at += part.length;
                        }
                        resolve({ samples, sampleRate: frames[0].header.sampleRate,
                            channels: frames[0].header.channels });
                    }, reject);
                });
            };

            if (com)
            {
                dmusic = registerDirectMusic({
                    registry: com,
                    divergence: config?.divergence ?? (()=>{}),
                    memory: {
                        readBytes: (/** @type {number} */ address, /** @type {number} */ length)=>
                            memory.readBytes(address, length),
                        writeBytes: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
                            memory.writeBytes(address, bytes),
                    },
                    publishInterface: config?.publishInterface ?? (()=>0),
                    // The bridge owns the map from a published pointer back to
                    // its object; a segment a program made by class id is
                    // published there and not by this module, so a
                    // performance asked to play it has to look there.
                    objectAt: (/** @type {number} */ pointer)=>
                        bridge?.interfaceObject?.(pointer) ?? null,
                    allocate: config?.allocate,
                    free: config?.free,
                    // DirectMusic's notification message is the event the
                    // performance sets when a segment reaches a point a
                    // program asked about; it is signalled from the audio
                    // tick, the same place the sound notifier's is.
                    signal: config?.signal,
                    // A segment's bytes may arrive through an IStream, which is
                    // guest code: reading it is a callback the bridge makes on
                    // the thread whose call is running.
                    callGuest: (/** @type {number} */ entry, /** @type {number[]} */ args,
                        /** @type {any} */ thread)=>bridge.callGuest({ entry, args, thread }),
                    callerThread: ()=>bridge.callerThread(),
                    output: ()=>output,
                    now: config?.now ?? (()=>Date.now()),
                    readFile: config?.readFile,
                    decodeWave,
                });
            }

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
                // DirectMusic first: a segment's waves are due at a moment on
                // the guest's clock, and this is the one place a turn of that
                // clock reaches the mixer. Opening a track just before the mix
                // that will play it is what keeps a wave's first frame from
                // being a turn late.
                dmusic?.tick?.();
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
                    // No tracks are ever opened here, so a released buffer has
                    // nothing to close first; it still has to leave the walk
                    // above, or that walk grows with every buffer ever made.
                    dsound.pruneReleased();
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
                    // The program let this buffer go. A track's slot in the
                    // shared backend is spent for as long as it is STATE_OPEN,
                    // not for as long as its queue is non-empty -- so a track
                    // that outlives its buffer is a slot the engine can never get
                    // back, and the ceiling becomes every buffer *ever* played in
                    // the session rather than every buffer open at once.
                    if (buffer.references <= 0)
                    {
                        tracks.get(buffer)?.close();
                        tracks.delete(buffer);
                        buffer.device?.close();
                        continue;
                    }
                    // The sound device plays it, as a sound card does: a voice with
                    // a mirror of the whole buffer, read on the device's own clock,
                    // so what the engine thread is doing is not heard. Given once;
                    // after that only what a program can change between two looks
                    // is carried over, and nothing is read out here.
                    const sounding = (buffer.status() & DSBSTATUS_PLAYING) !== 0;
                    if (buffer.device && !sounding)
                    {
                        buffer.detachDevice()?.close();
                    }
                    if (!buffer.device && sounding && output.openVoice)
                    {
                        const voice = output.openVoice({
                            sampleRate: buffer.frequency,
                            channels: buffer.format.channels,
                            bitsPerSample: buffer.format.bitsPerSample,
                            bytes: buffer.bytes,
                        });
                        if (voice)
                        {
                            /** @param {number} from @param {number} count */
                            const copy = (from, count)=>{
                                if (count > 0)
                                {
                                    voice.write(from, memory.window(buffer.address + from, count));
                                }
                            };
                            buffer.attachDevice(voice, copy);
                            voices++;
                        }
                    }
                    const voice = buffer.device;
                    if (voice)
                    {
                        voice.gain = buffer.gain;
                        voice.balance = buffer.balance;
                        // Nothing to hand over; what the device passed is still
                        // checked against what the program wrote (stale).
                        buffer.drainPlayed();
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
                    // A program may retune a buffer while it plays, and its cursor
                    // hands over bytes at the new rate from that moment. A track
                    // left at the old one plays them at the wrong pitch and makes
                    // more or less sound than the guest's clock allows for, which
                    // the backlog policy below then throws away or starves on.
                    if (track.format.sampleRate !== buffer.frequency)
                    {
                        track.retune(buffer.frequency);
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
                    if (track.pending() > track.capacityFrames)
                    {
                        track.reset();
                        behind++;
                    }
                    track.gain = buffer.gain;
                    track.balance = buffer.balance;
                    for (const range of ranges)
                    {
                        fedBytes += range.bytes;
                        fedRanges++;
                        // A window, not a copy: the shared backend copies these
                        // bytes into its own ring on `write` regardless, and the
                        // engine backend's `convert` only ever reads them
                        // synchronously within this call, so a second copy here
                        // first -- what `readBytes` used to hand over -- bought
                        // nothing.
                        track.write(memory.window(buffer.address + range.from, range.bytes));
                    }
                }
                // Drops whatever was just released above from the seam's own
                // walk too, so a session that opens and releases many buffers
                // keeps this loop to the ones still reachable rather than
                // growing it for as long as the program runs.
                dsound.pruneReleased();
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

                /**
                 * Which ordinal is which export, for the libraries a program
                 * imports by number, keyed like `libraries`. The assembling caller
                 * synthesises each library with these, as it does win32's.
                 */
                ordinals: ()=>({ ...dsound.ordinals }),

                /**
                 * Which of those are redistributable runtimes this engine answers
                 * for whoever's copy the program brought (`roadmap/decisions.md`):
                 * the MPEG provider a sound library loads out of its own directory
                 * is one, where DirectSound is a system library like any other.
                 */
                runtimes: ()=>(config?.mp3 === false ? [] : Object.keys(mp3.libraries)),

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
                    voices,
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

                /** DirectMusic, for whoever is measuring its playback. */
                dmusic: ()=>dmusic,

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
                    // What DirectMusic played: mixer tracks opened, bytes
                    // handed over, and how many segments are still running.
                    dmusic: current?.dmusic?.()?.diagnostics?.() ?? null,
                    // Every sound buffer's own state. A count of buffers says a
                    // program made some; this says whether any of them is playing,
                    // where its cursor stands and how much of it was ever filled --
                    // which is what separates a silent buffer from a busy one.
                    bufferDetail: current ? current.dsound().buffers()
                        .filter((/** @type {any} */ b)=>!b.primary)
                        .map((/** @type {any} */ b)=>{
                            const c = b.cursors();
                            return `st=${b.status()} play=${c.play} write=${c.write}`
                                + ` bytes=${b.bytes} freq=${b.frequency} held=${b.held}`;
                        }) : [],
                },
            };
        },

        async dispose(){
            current = null;
        },
    };
}

/** One graph's worth, for the boundary check and for a test that builds this layer alone. */
export const audioModule = createAudioModule();
