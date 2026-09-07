/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * What a DirectSound buffer is, without any of the COM around it.
 *
 * There is no audio device in this build, and this file is written so that the
 * absence changes nothing a program can observe except that nobody hears it.
 * What a program actually depends on is not sound: it is the pair of cursors.
 * It asks where playback has reached, fills the gap ahead of that, and asks
 * again. A buffer whose cursor never moves stalls it; one whose cursor jumps
 * the whole length every time it is asked spins it. So the cursor advances
 * against the guest's clock at the format's byte rate -- the same clock and the
 * same arithmetic the wave-out path already uses, because two notions of how
 * far playback has got would disagree the moment a program used both.
 *
 * Two properties of the pair are worth stating because getting either wrong
 * produces sound that is right for a while and then is not:
 *
 * - **The write cursor leads the play cursor while playing.** The span between
 *   them is what a real mixer has already committed and cannot take back, so a
 *   program writes ahead of the write cursor. Placing it behind the play cursor
 *   collapses that lead to nothing for any program that streams from it.
 * - **A locked range can be two ranges.** The buffer is circular; a request
 *   that runs off the end continues at the start. Handing back one range where
 *   two are needed silently drops the wrap, and the program writes half its
 *   audio into a pointer it was told was long enough.
 */

/** How far ahead of the play cursor the write cursor sits, in milliseconds. */
const WRITE_LEAD_MS = 30;

/**
 * How far behind the play cursor the write cursor sits when stopped.
 *
 * A stopped buffer is entirely writable, and a program that locks from the
 * write cursor expects to get nearly all of it. The margin is what keeps the
 * two cursors from being the same number, which a program reads as an empty
 * buffer rather than a full one.
 */
const STOPPED_MARGIN_MS = 15;

/** DSBSTATUS. */
export const DSBSTATUS_PLAYING = 0x0001;
export const DSBSTATUS_BUFFERLOST = 0x0002;
export const DSBSTATUS_LOOPING = 0x0004;

/** DSBPLAY_LOOPING, the only play flag that changes what the cursor does. */
export const DSBPLAY_LOOPING = 0x0001;

/** Lock flags. */
export const DSBLOCK_FROMWRITECURSOR = 0x0001;
export const DSBLOCK_ENTIREBUFFER = 0x0002;

/** Volume and pan are hundredths of a decibel, and both have documented bounds. */
export const DSBVOLUME_MIN = -10000;
export const DSBVOLUME_MAX = 0;
export const DSBPAN_LEFT = -10000;
export const DSBPAN_RIGHT = 10000;

/**
 * @typedef {Object} SoundFormat
 * @property {number} channels
 * @property {number} sampleRate
 * @property {number} bitsPerSample
 * @property {number} blockAlign      Bytes one frame occupies, across channels.
 */

/**
 * @param {Partial<SoundFormat>} format
 * @returns {SoundFormat}
 */
export function normaliseFormat(format){
    const channels = Math.max(1, format.channels ?? 2);
    const bitsPerSample = format.bitsPerSample ?? 16;
    return {
        channels,
        sampleRate: Math.max(1, format.sampleRate ?? 22050),
        bitsPerSample,
        // Taken from the format rather than trusted from the caller: a
        // structure that disagrees with itself is common, and every cursor here
        // is in bytes, so the frame size is what everything else derives from.
        blockAlign: Math.max(1, channels * (bitsPerSample >> 3)),
    };
}

/**
 * One buffer.
 *
 * @param {Object} options
 * @param {number} options.bytes       How long the buffer is.
 * @param {number} options.address     Where its bytes live in guest memory.
 * @param {SoundFormat} options.format
 * @param {() => number} options.now   The guest's clock, in milliseconds.
 * @param {boolean} [options.primary]  A primary buffer is the mix target and
 *                                     never holds a program's own samples.
 */
export function createSoundBuffer({ bytes, address, format, now, primary = false }){
    /** Where the play cursor was when playback last started or was placed. */
    let anchorByte = 0;
    /** When that was. */
    let anchorMs = now();
    let playing = false;
    let looping = false;
    let frequency = format.sampleRate;
    let volume = DSBVOLUME_MAX;
    let pan = 0;
    let references = 1;
    /** @type {{ offset: number, event: number }[]} */
    let notifications = [];
    /** Where the play cursor stood the last time notifications were tested. */
    let lastNotified = 0;
    /** @type {{ offset: number, first: number, second: number } | null} */
    let lock = null;

    /** Bytes a second of playback consumes, honouring a program's own rate. */
    const byteRate = ()=>Math.max(1, frequency) * format.blockAlign;

    /** @param {number} value */
    const alignDown = value=>value - value % format.blockAlign;

    /**
     * Where playback has reached, computed rather than stored.
     *
     * A non-looping buffer stops at the end and says so: a program waits on
     * the status, and one that never stopped would wait for ever.
     */
    const settle = ()=>{
        if (!playing)
        {
            return;
        }
        const advanced = Math.floor((now() - anchorMs) * byteRate() / 1000);
        if (!looping && anchorByte + advanced >= bytes)
        {
            playing = false;
            anchorByte = 0;
            anchorMs = now();
        }
    };

    /** The play cursor as a program sees it. */
    const playCursor = ()=>{
        settle();
        if (!playing)
        {
            return alignDown(anchorByte % bytes);
        }
        const advanced = Math.floor((now() - anchorMs) * byteRate() / 1000);
        return alignDown((anchorByte + advanced) % bytes);
    };

    /** @param {number} milliseconds */
    const span = milliseconds=>Math.min(
        Math.max(format.blockAlign, alignDown(Math.floor(byteRate() * milliseconds / 1000))),
        alignDown(Math.floor(bytes / 2)),
    );

    return {
        get bytes(){
            return bytes;
        },
        get address(){
            return address;
        },
        get format(){
            return format;
        },
        get primary(){
            return primary;
        },

        addRef: ()=>++references,
        release: ()=>Math.max(0, --references),
        get references(){
            return references;
        },

        /**
         * Both cursors at once, because they are one answer: a program reads
         * them together and the gap between them is the whole point.
         *
         * @returns {{ play: number, write: number }}
         */
        cursors(){
            const play = playCursor();
            const lead = playing ? span(WRITE_LEAD_MS) : bytes - span(STOPPED_MARGIN_MS);
            return { play, write: alignDown((play + lead) % bytes) };
        },

        status(){
            settle();
            return (playing ? DSBSTATUS_PLAYING : 0) | (playing && looping
                ? DSBSTATUS_LOOPING
                : 0);
        },

        /** @param {number} flags */
        play(flags){
            settle();
            if (!playing)
            {
                // The cursor starts from where it was left, not from the
                // beginning: a program that stops and starts again expects to
                // continue, and one that wanted the beginning said so.
                anchorMs = now();
                playing = true;
            }
            looping = (flags & DSBPLAY_LOOPING) !== 0;
        },

        stop(){
            // The position is kept, because GetCurrentPosition on a stopped
            // buffer has to report where it actually stopped.
            anchorByte = playCursor();
            anchorMs = now();
            playing = false;
        },

        /** @param {number} position */
        setCurrentPosition(position){
            anchorByte = alignDown((position >>> 0) % bytes);
            anchorMs = now();
            lastNotified = anchorByte;
        },

        /** @param {number} hz  Zero means the format's own rate. */
        setFrequency(hz){
            // Taken from where the cursor is now, so changing the rate does not
            // move playback: the anchor is in bytes and the rate only decides
            // how fast the next byte arrives.
            anchorByte = playCursor();
            anchorMs = now();
            frequency = (hz >>> 0) === 0 ? format.sampleRate : hz >>> 0;
        },
        get frequency(){
            return frequency;
        },

        /** @param {number} value */
        setVolume(value){
            volume = Math.min(DSBVOLUME_MAX, Math.max(DSBVOLUME_MIN, value | 0));
        },
        get volume(){
            return volume;
        },

        /** @param {number} value */
        setPan(value){
            pan = Math.min(DSBPAN_RIGHT, Math.max(DSBPAN_LEFT, value | 0));
        },
        get pan(){
            return pan;
        },

        /** @param {{ offset: number, event: number }[]} positions */
        setNotifications(positions){
            notifications = positions.map(entry=>({ ...entry }));
            lastNotified = playCursor();
        },
        get notifications(){
            return notifications;
        },

        /**
         * Which notification events the cursor has passed since this was last
         * asked, in the order it passed them.
         *
         * Crossing is tested rather than compared, because the cursor wraps: a
         * position behind the current one may have been passed a moment ago or
         * not for another whole buffer, and only the direction of travel says
         * which.
         *
         * @returns {number[]}
         */
        drainNotifications(){
            const play = playCursor();
            const from = lastNotified;
            lastNotified = play;
            if (notifications.length === 0 || from === play)
            {
                return [];
            }
            const passed = (/** @type {number} */ offset)=>(from < play
                ? offset > from && offset <= play
                : offset > from || offset <= play);
            return notifications.filter(entry=>passed(entry.offset)).map(entry=>entry.event);
        },

        /**
         * The one or two ranges a lock hands back.
         *
         * @param {number} offset
         * @param {number} requested
         * @param {number} flags
         * @returns {{ first: { address: number, bytes: number },
         *             second: { address: number, bytes: number } }}
         */
        lockRange(offset, requested, flags){
            let start = offset >>> 0;
            let wanted = requested >>> 0;
            if ((flags & DSBLOCK_FROMWRITECURSOR) !== 0)
            {
                start = this.cursors().write;
            }
            if ((flags & DSBLOCK_ENTIREBUFFER) !== 0)
            {
                // The whole buffer from its beginning, not a buffer-sized span
                // from wherever the cursor happens to be -- which would wrap
                // and overwrite audio that has not been played.
                start = 0;
                wanted = bytes;
            }

            start = Math.min(start, bytes);
            const target = Math.min(wanted, bytes);
            const first = Math.min(target, bytes - start);
            const second = target - first;
            lock = { offset: start, first, second };
            return {
                first: { address: address + start, bytes: first },
                second: { address: second > 0 ? address : 0, bytes: second },
            };
        },

        unlock(){
            const held = lock;
            lock = null;
            return held;
        },
        get locked(){
            return lock !== null;
        },
    };
}
