/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Playing a DirectMusic segment's wave items.
 *
 * A segment is a list of waves and the music time each begins at. Playing it
 * is therefore: on each mix, work out how far into the piece the guest's clock
 * has carried it, and open a mixer track for every wave whose moment has
 * arrived. The samples themselves are decoded once when the segment plays, so
 * what runs here is only bookkeeping.
 *
 * A track is opened on the mixer rather than a DirectSound buffer because that
 * is where the two APIs meet: the same tracks a program's buffers play through
 * carry its music, so the one device adds them together and one worklet reads
 * the result. A wave that outlives its segment is closed when the segment
 * ends, as DirectMusic does, rather than left to run past it.
 */

/**
 * Decibels (hundredths, as DirectMusic stores them) to a linear gain.
 *
 * Zero is full volume and the scale is attenuation, so every value is at or
 * below zero; 0 dB is a gain of one and -96 dB or quieter is silence, which is
 * also where the arithmetic underflows and is worth stating rather than
 * rounding through.
 *
 * @param {number} volume
 * @returns {number}
 */
export function volumeToGain(volume){
    return volume <= -9600 ? 0 : Math.pow(10, volume / 2000);
}

/**
 * @typedef {Object} WaveProgramItem
 * @property {number} timeMs      When into the segment this wave begins.
 * @property {Uint8Array} samples  Interleaved 16-bit PCM, as the mixer wants it.
 * @property {number} sampleRate
 * @property {number} channels
 * @property {number} gain        Already scaled by the item's own volume.
 */

/**
 * @typedef {Object} WaveProgram
 * @property {WaveProgramItem[]} items
 * @property {number} lengthMs    One pass through the segment.
 */

/**
 * @param {Object} deps
 * @param {() => number} deps.now          The guest's clock, in milliseconds.
 * @param {() => any} deps.output          The mixer, or null when nothing drains it.
 * @param {(voice: any, item: WaveProgramItem) => void} [deps.onVoice]
 */
export function createPlayer({ now, output, onVoice }){
    /** @type {Set<any>} */
    const voices = new Set();
    let opened = 0;
    let fedBytes = 0;
    let ended = 0;

    /**
     * Opens a track and hands it the first of the samples. Nothing is written
     * when no one is reading the other end: the clock still advances and the
     * segment still ends, which is what a program can observe, but the bytes
     * have nowhere to go.
     *
     * A wave is thousands of frames and a mixer track holds a bounded amount
     * -- the shared backend's slot is 64 KiB -- so the samples are handed over
     * in as many pieces as the track will take, topped up as the device drains
     * them, rather than in one call that drops all but the first moment. That
     * is what makes a piece of music, and not its first quarter second, the
     * thing a listener hears.
     *
     * @param {any} mixer @param {WaveProgramItem} item @param {number} volume
     */
    const sound = (mixer, item, volume)=>{
        if (!mixer?.open)
        {
            return null;
        }
        const track = mixer.open({
            sampleRate: item.sampleRate,
            channels: item.channels,
            bitsPerSample: 16,
        });
        track.gain = item.gain * volume;
        track.dmusicFeed = { samples: item.samples, at: 0, stride: item.channels * 2 };
        opened++;
        fedBytes += item.samples.length;
        onVoice?.(null, item);
        return track;
    };

    /**
     * Offers each open track the next of its wave's samples, as much as it
     * will hold. Called on the clock, so a track whose ring has a bounded
     * depth receives its wave at the rate the device plays it rather than all
     * at once and mostly lost.
     *
     * @param {any} voice
     */
    const pumpFeeds = voice=>{
        for (const track of voice.tracks)
        {
            const feed = track.dmusicFeed;
            if (!feed || feed.at >= feed.samples.length)
            {
                continue;
            }
            const capacity = track.capacityFrames ?? 0;
            const pending = typeof track.pending === 'function' ? track.pending() : 0;
            if (capacity > 0 && pending >= capacity)
            {
                continue;
            }
            const frames = capacity > 0 ? capacity - pending : 4096;
            const bytes = Math.min(feed.samples.length - feed.at, frames * feed.stride);
            if (bytes <= 0)
            {
                continue;
            }
            track.write(feed.samples.subarray(feed.at, feed.at + bytes));
            feed.at += bytes;
        }
    };

    /** @param {any} voice */
    const closeTracks = voice=>{
        for (const track of voice.tracks)
        {
            track.close();
        }
        voice.tracks = [];
    };

    /** @param {any} voice */
    const stop = voice=>{
        if (!voices.delete(voice))
        {
            return;
        }
        closeTracks(voice);
        ended++;
    };

    /**
     * Tells whoever asked that a segment reached a point worth reporting.
     *
     * DirectMusic's notifications are the only way a program learns that the
     * piece it queued has started, is about to end or has ended, and a music
     * manager waits on an event the performance signals for each one. The
     * event is raised here -- on the clock the mixer drives -- rather than
     * left for the program to poll, because a program that waits on a handle
     * cannot run the thing that would answer it.
     *
     * @param {any} voice @param {string} kind
     */
    const emit = (voice, kind)=>{
        voice.onEvent?.(kind, voice);
    };

    return {
        /**
         * Starts one pass (or several) through a program.
         *
         * `startMs` is how far into the guest's future the first wave waits;
         * zero means now. `plays` is the total number of passes, `Infinity`
         * for a segment that repeats for ever.
         *
         * @param {WaveProgram} program
         * @param {Object} [options]
         * @param {number} [options.delayMs]
         * @param {number} [options.plays]
         * @param {number} [options.volume]
         * @param {any} [options.state]
         * @param {any} [options.segment]
         * @param {number} [options.prepareMs]  How long before the end to say
         *     the segment is almost over.
         * @param {((kind: string, voice: any) => void) | null} [options.onEvent]
         * @returns {any} the voice, which is what a segment state names.
         */
        start(program, { delayMs = 0, plays = 1, volume = 1, state = null, segment = null,
            prepareMs = 0, onEvent = null } = {})
        {
            const voice = {
                program,
                startedAt: now(),
                delayMs: Math.max(0, delayMs),
                plays: plays > 0 ? plays : 1,
                volume,
                state,
                segment,
                prepareMs: Math.max(0, prepareMs),
                onEvent,
                cycle: -1,
                notifiedStart: false,
                almostEnded: false,
                started: new Array(program.items.length).fill(false),
                /** @type {any[]} */
                tracks: [],
            };
            voices.add(voice);
            // The first wave begins at time zero, so it is opened now rather
            // than left for the next tick: a tick is a frame away and a
            // program that plays and at once asks whether it is playing would
            // be told no.
            this.advance(voice, output());
            return voice;
        },

        /** @param {any} voice */
        stop,

        /** Stops every voice a predicate selects. @param {(voice: any) => boolean} match */
        stopWhere(match){
            for (const voice of [...voices])
            {
                if (match(voice))
                {
                    stop(voice);
                }
            }
        },

        /** @param {(voice: any) => boolean} match */
        playing(match){
            for (const voice of voices)
            {
                if (match(voice))
                {
                    return true;
                }
            }
            return false;
        },

        /** Every voice still playing. */
        voices: ()=>[...voices],

        /** Moves every voice to where the guest's clock now stands. */
        tick(){
            for (const voice of [...voices])
            {
                this.advance(voice, output());
            }
        },

        /**
         * One voice's turn of the clock.
         *
         * A pass that has run its length is either restarted -- every item's
         * `started` cleared and its tracks closed, so the next pass opens its
         * own -- or, the last one having run, ends the voice.
         *
         * @param {any} voice @param {any} mixer
         */
        advance(voice, mixer){
            const elapsed = now() - voice.startedAt - voice.delayMs;
            if (elapsed < 0)
            {
                return;
            }
            const length = voice.program.lengthMs;
            if (length > 0)
            {
                const cycle = Math.floor(elapsed / length);
                if (cycle >= voice.plays)
                {
                    emit(voice, 'end');
                    stop(voice);
                    return;
                }
                if (cycle !== voice.cycle)
                {
                    if (voice.cycle >= 0)
                    {
                        emit(voice, 'loop');
                    }
                    voice.cycle = cycle;
                    voice.almostEnded = false;
                    voice.started.fill(false);
                    closeTracks(voice);
                }
            }
            else if (voice.cycle < 0)
            {
                voice.cycle = 0;
            }
            if (!voice.notifiedStart)
            {
                voice.notifiedStart = true;
                emit(voice, 'start');
            }
            const into = length > 0 ? elapsed - voice.cycle * length : elapsed;
            // The last pass through a segment says it is nearly over once the
            // guest's clock is within the prepare time of its end, which is
            // where a program queues what plays next.
            if (length > 0 && voice.plays !== Infinity && voice.cycle === voice.plays - 1
                && length - into <= voice.prepareMs && !voice.almostEnded)
            {
                voice.almostEnded = true;
                emit(voice, 'almostEnd');
            }
            for (let index = 0; index < voice.program.items.length; index++)
            {
                const item = voice.program.items[index];
                if (!voice.started[index] && into >= item.timeMs)
                {
                    voice.started[index] = true;
                    const track = sound(mixer, item, voice.volume);
                    if (track)
                    {
                        voice.tracks.push(track);
                    }
                }
            }
            pumpFeeds(voice);
        },

        /** Open tracks, bytes handed over, and voices that ended. */
        diagnostics: ()=>({ opened, fedBytes, ended, playing: voices.size }),

        stopAll(){
            for (const voice of [...voices])
            {
                stop(voice);
            }
        },
    };
}
