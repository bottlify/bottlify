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
     * Opens a track and hands it the samples. Nothing is written when no one
     * is reading the other end: the clock still advances and the segment
     * still ends, which is what a program can observe, but the bytes have
     * nowhere to go.
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
        track.write(item.samples);
        opened++;
        fedBytes += item.samples.length;
        onVoice?.(null, item);
        return track;
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
         * @returns {any} the voice, which is what a segment state names.
         */
        start(program, { delayMs = 0, plays = 1, volume = 1, state = null, segment = null } = {}){
            const voice = {
                program,
                startedAt: now(),
                delayMs: Math.max(0, delayMs),
                plays: plays > 0 ? plays : 1,
                volume,
                state,
                segment,
                cycle: -1,
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
                    stop(voice);
                    return;
                }
                if (cycle !== voice.cycle)
                {
                    voice.cycle = cycle;
                    voice.started.fill(false);
                    closeTracks(voice);
                }
            }
            else if (voice.cycle < 0)
            {
                voice.cycle = 0;
            }
            const into = length > 0 ? elapsed - voice.cycle * length : elapsed;
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
