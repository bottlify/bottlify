/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a DirectSound buffer is, without any of the COM around it.
 *
 * What a program depends on is the pair of cursors. It asks where playback has
 * reached, fills the gap ahead of that, and asks again. A buffer whose cursor
 * never moves stalls it; one whose cursor jumps the whole length every time it
 * is asked spins it. So the cursor advances against the guest's clock at the
 * format's byte rate -- the same clock and the same arithmetic the wave-out
 * path already uses, because two notions of how far playback has got would
 * disagree the moment a program used both.
 *
 * The cursor is what a program watches; the bytes it moved over are what a
 * person hears, and `drainPlayed` is where they leave. Those are separate
 * enough that a buffer can be entirely correct in everything a program can
 * observe and still be silent, which is what this file used to be: every
 * cursor moved, every notification fired, and nothing was ever read out.
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
export function createSoundBuffer(
    { bytes, address, format: initialFormat, now, primary = false })
{
    // Not a constant: a program sets the format of the primary buffer to say
    // what the mix should run at, and everything below is in bytes derived from
    // it. Rebinding here is what makes the rest of this file follow.
    let format = initialFormat;
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
    /**
     * How far the bytes have been read out for mixing: the write cursor, not
     * the play cursor. The span between the two is what a real device has
     * already fetched, and fetching it here is what keeps the ring ahead of
     * the device by that much. Read only up to the play cursor, the ring holds
     * what the last turn produced and no more, and every turn longer than one
     * device block is heard as a click.
     */
    let fedByte = 0;
    /** How far ahead of the play cursor the read stood when it last advanced. */
    let fedLead = 0;
    // A non-looping buffer that reached its end since the last drain. Its play
    // cursor reads zero again, so the wrapped span drainPlayed forms collapses
    // to nothing for a sound short enough to finish between two fills of the
    // ring -- which every menu click is. The flag makes the last drain hand
    // over the rest of the buffer linearly instead.
    let reachedEnd = false;
    /** @type {{ offset: number, first: number, second: number } | null} */
    let lock = null;
    /**
     * Which bytes the program has written since they were last handed over.
     *
     * Everything a program can observe is right when its refill is late: the
     * cursor keeps moving and the bytes it passes are handed to the mixer as
     * usual. What a listener hears is the previous lap again, and this map is
     * the only thing that tells a lap replayed from a lap refilled.
     */
    const written = new Uint8Array(bytes);
    let staleBytes = 0;
    let staleDrains = 0;

    /** @param {number} from @param {number} count */
    const markWritten = (from, count)=>written.fill(1, from, from + count);

    /**
     * Clears what a drain hands over and counts what was already clear.
     *
     * A byte per byte rather than a coarser map: a lock and the drain that
     * follows it end in the same place, and any cell shared between the two
     * is either cleared under a fresh write or left marked for ever. The walk
     * is over what one turn played, which is the byte rate and no more.
     *
     * @param {{ from: number, bytes: number }[]} ranges
     */
    const takeWritten = ranges=>{
        let stale = 0;
        for (const range of ranges)
        {
            const end = range.from + range.bytes;
            for (let at = range.from; at < end; at++)
            {
                stale += 1 - written[at];
            }
            written.fill(0, range.from, end);
        }
        if (stale > 0)
        {
            staleBytes += stale;
            staleDrains++;
        }
    };

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
            reachedEnd = true;
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

    /**
     * The bytes playback has passed since this was last asked, as the one or
     * two ranges a circular buffer's span becomes.
     *
     * A lap is the most that can come back at once. Falling a whole buffer
     * behind means the machine spent longer between turns than the buffer
     * is long -- at which point the audio for that gap is already too late
     * to play, and handing it over would only push everything after it
     * further behind.
     *
     * @returns {{ from: number, bytes: number }[]}
     */
    const played = ()=>{
        const play = playCursor();
        if (reachedEnd)
        {
            // Everything from the last look to the end, once. The buffer
            // plays start to end and is not circular in doing it, so this
            // is a single contiguous range and never wraps.
            reachedEnd = false;
            const from = fedByte;
            fedByte = 0;
            return from < bytes ? [{ from, bytes: bytes - from }] : [];
        }
        const ahead = playing ? span(WRITE_LEAD_MS) : 0;
        if (!looping)
        {
            // Start to end and never round: the read runs up to the write
            // cursor and stops at the end of the buffer, where the rest
            // is handed over by the branch above once playback gets there.
            const target = Math.min(play + ahead, bytes);
            if (target <= fedByte)
            {
                return [];
            }
            const from = fedByte;
            fedByte = target;
            return [{ from, bytes: target - from }];
        }
        // Forward around the circle: a cursor that reads as behind the last
        // one has wrapped, and the span is the rest of the buffer plus what
        // it has covered since.
        const target = (play + ahead) % bytes;
        const covered = (target - fedByte + bytes) % bytes;
        // The read can stand ahead of the target by up to the lead it was
        // last advanced with: a stop drops the lead to nothing and a lower
        // rate shrinks it. Read as a wrap, that distance is nearly the whole
        // buffer, handed over again.
        if (covered === 0 || covered >= bytes - fedLead)
        {
            return [];
        }
        const from = fedByte;
        fedByte = target;
        fedLead = ahead;
        const first = Math.min(covered, bytes - from);
        return first === covered
            ? [{ from, bytes: covered }]
            : [{ from, bytes: first }, { from: 0, bytes: covered - first }];
    };

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

        /**
         * Adopts a new format. Only the primary buffer's is ever set, and only
         * before anything has been played through it.
         *
         * The allocation is left alone: the primary buffer holds no samples of
         * the program's own, so its length is a figure it reads back rather
         * than a place anything is written.
         *
         * @param {SoundFormat} next
         */
        setFormat(next){
            format = next;
            frequency = next.sampleRate;
            anchorByte = 0;
            anchorMs = now();
            fedByte = 0;
            fedLead = 0;
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
            // buffer has to report where it actually stopped. The read is
            // not pulled back to it: what was read ahead of here is in the
            // mixer and will be heard, and reading it again on resume plays
            // it twice -- for a pause between two sounds, the end of the
            // first one repeated. The same holds after a one-shot ran to
            // its end, where the cursor reads zero again and a read pulled
            // back there hands over the whole sound a second time.
            anchorByte = playCursor();
            anchorMs = now();
            playing = false;
        },

        /** @param {number} position */
        setCurrentPosition(position){
            reachedEnd = false;
            anchorByte = alignDown((position >>> 0) % bytes);
            anchorMs = now();
            lastNotified = anchorByte;
            // Moved with the cursor, or the next read hands over everything
            // between where playback used to be and where it has been put --
            // which is most of the buffer, played at once.
            fedByte = anchorByte;
            fedLead = 0;
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

        /**
         * That volume as a multiplier.
         *
         * DirectSound states attenuation in hundredths of a decibel, zero being
         * full and -10000 being silence, so the scale is logarithmic and the
         * number a program passes is not a fraction of anything. Treating it as
         * one makes every quiet sound far too loud.
         */
        get gain(){
            return volume <= DSBVOLUME_MIN ? 0 : 10 ** (volume / 2000);
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
         * The bytes playback has passed since this was last asked.
         *
         * This is the whole of what makes a buffer audible. A caller mixes
         * these; a build with nobody asking is the silent one this used to be.
         *
         * @returns {{ from: number, bytes: number }[]}
         */
        drainPlayed(){
            const ranges = played();
            takeWritten(ranges);
            return ranges;
        },

        /**
         * Bytes handed over that the program had not written since they were
         * last handed over: a lap replayed because the refill was late, or a
         * region played before it was ever filled. Heard as a short repeat.
         */
        get stale(){
            return { bytes: staleBytes, drains: staleDrains };
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
            if (held)
            {
                // Counted at the unlock, not the lock: the program writes in
                // between, and what is heard is what was there when it let go.
                markWritten(held.offset, held.first);
                markWritten(0, held.second);
            }
            return held;
        },
        get locked(){
            return lock !== null;
        },
    };
}
