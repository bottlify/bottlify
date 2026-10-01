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

/**
 * The offset a notification names to be told when playback stops, rather than
 * when the cursor reaches a place: dsound.h's -1, read as the dword it is.
 */
export const DSBPN_OFFSETSTOP = 0xffffffff;

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
 * @property {number} [averageBytes]   nAvgBytesPerSec as the program gave it, which
 *     GetFormat hands back; DirectSound accepts one that disagrees with the rest.
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
        ...format.averageBytes === undefined ? {} : { averageBytes: format.averageBytes },
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
 * @param {number} [options.capabilities]  The DSBCAPS flags it was created with.
 * @param {() => boolean} [options.kept]  Whether something besides the program's
 *                                     own references keeps it.
 */
export function createSoundBuffer({
    bytes, address, format: initialFormat, now, primary = false, capabilities = 0,
    kept = ()=>false,
})
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
    /** Playback stopped, by Stop or at the end, since notifications were tested. */
    let stopOwed = false;
    /**
     * A one-shot ran to its end since notifications were tested. Its cursor
     * reads zero again, as a wrapped one does, and what it passed on the way
     * is the rest of the buffer -- not the whole of it again from the start.
     */
    let ranOut = false;
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
    /**
     * The ranges locked and not yet let go of. Windows holds any number of
     * locks that do not overlap and takes each range back by its own Unlock
     * pointer (Wine's dsound.c test_lock); `lock` is the Lock call a range
     * came from, and `left` how many of its ranges are still held.
     *
     * @type {{ at: number, length: number,
     *          lock: { offset: number, length: number, left: number } }[]}
     */
    const held = [];
    /**
     * The sound device's voice for this buffer, once one is attached
     * (`attachDevice`): a mirror of the buffer that the device plays on its
     * own clock. From then on the play cursor, whether it is playing and when
     * a one-shot ended are the device's, not the guest clock's; nothing is
     * read out per turn, and what the program unlocks goes to the mirror.
     * @type {{ voice: any, copy: (from: number, count: number) => void } | null}
     */
    let device = null;
    /** The device's lap and end counts as last seen. */
    let seenLaps = 0;
    let seenEnds = 0;
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
    /**
     * When the last stale drains happened, host milliseconds (the engine
     * thread's `performance.now`), so a repeat can be laid beside whatever
     * held the thread at the time.
     * @type {number[]}
     */
    const staleAt = [];
    /**
     * The buffer's last unlocks and repeats, as `[kind, time, offset, bytes,
     * play, write]` -- `u` an unlock, `s` a drain that handed over bytes not
     * written since their last lap -- and the stretch of it that led up to the
     * last repeat: what the program wrote where, against where the cursors
     * stood, is the only thing that says why the refill came late.
     * @type {(string | number)[][]}
     */
    const trail = [];
    /** @type {(string | number)[][]} */
    let staleTrail = [];
    /** @param {(string | number)[]} entry */
    const note = entry=>{
        if (trail.length === 24)
        {
            trail.shift();
        }
        trail.push(entry);
    };
    /**
     * Where the last unlock ended, for telling a lock that continues the
     * stream from one that jumped ahead of it.
     *
     * A program streaming into a looping buffer fills it in consecutive
     * pieces. After a stall it may start again further along and never write
     * what it passed over, and that region plays as it was a lap ago. The
     * stale count above hears the result; this names the cause at the
     * moment it happens, which is the only place it can be tied to the
     * stall that produced it.
     */
    /** @type {number | null} */
    let streamEnd = null;
    let skippedBytes = 0;
    let skips = 0;
    /** Frames voices this buffer has given back had held, for a report. */
    let heldFrames = 0;

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
            // What led up to it, for a report; a production bundle keeps none.
            if (import.meta.BOTTLIFY_DIAGNOSTICS !== false)
            {
                const { play, write } = cursorsNow();
                note(['s', Math.round(now()), ranges[0]?.from ?? 0,
                    ranges.reduce((sum, range)=>sum + range.bytes, 0), play, write]);
                staleTrail = trail.slice();
                if (staleAt.length === 64)
                {
                    staleAt.shift();
                }
                staleAt.push(Math.round(performance.now()));
            }
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
        if (device)
        {
            const ends = device.voice.ends;
            if (ends !== seenEnds || (!looping && !device.voice.playing))
            {
                seenEnds = ends;
                playing = false;
                anchorByte = 0;
                anchorMs = now();
                stopOwed = true;
                ranOut = true;
            }
            return;
        }
        const advanced = Math.floor((now() - anchorMs) * byteRate() / 1000);
        if (!looping && anchorByte + advanced >= bytes)
        {
            playing = false;
            anchorByte = 0;
            anchorMs = now();
            reachedEnd = true;
            stopOwed = true;
            ranOut = true;
        }
    };

    /** The play cursor as a program sees it. */
    const playCursor = ()=>{
        settle();
        if (device)
        {
            return alignDown((playing ? device.voice.position : anchorByte) % bytes);
        }
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

    /** Both cursors, as `cursors()` answers them to the program. */
    const cursorsNow = ()=>{
        const play = playCursor();
        const lead = playing ? span(WRITE_LEAD_MS) : bytes - span(STOPPED_MARGIN_MS);
        return { play, write: alignDown((play + lead) % bytes) };
    };

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
     * @param {number} [lead]  How far past the play cursor the read runs: the
     *     write cursor's lead for a copy mixed ahead, none for the device, which
     *     reads at the play cursor itself.
     * @returns {{ from: number, bytes: number }[]}
     */
    const played = (lead = span(WRITE_LEAD_MS))=>{
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
        const ahead = playing ? lead : 0;
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

    /**
     * Lets go of one held range. Counted at the unlock, not the lock: the
     * program writes in between, and what is heard is what was there when it
     * let go. The stream moves on once the whole of a lock is back.
     *
     * @param {number} index
     */
    const release = index=>{
        const [{ at, length, lock }] = held.splice(index, 1);
        markWritten(at, length);
        device?.copy(at, length);
        if (--lock.left > 0)
        {
            return;
        }
        if (device && playing)
        {
            device.voice.wrote(lock.offset, lock.length);
        }
        if (import.meta.BOTTLIFY_DIAGNOSTICS !== false)
        {
            const { play, write } = cursorsNow();
            note(['u', Math.round(now()), lock.offset, lock.length, play, write]);
        }
        streamEnd = (lock.offset + lock.length) % bytes;
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
        get capabilities(){
            return capabilities;
        },

        addRef: ()=>++references,
        release: ()=>(references = Math.max(0, references - 1)),
        get references(){
            return references;
        },
        /** Whether it can still be reached: a count of zero is not the end of it while kept. */
        reachable: ()=>references > 0 || kept(),
        /** Whether the program's last reference has gone, whatever keeps it besides. */
        get destroyed(){
            return references === 0;
        },

        /**
         * Both cursors at once, because they are one answer: a program reads
         * them together and the gap between them is the whole point.
         *
         * @returns {{ play: number, write: number }}
         */
        cursors(){
            return cursorsNow();
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
            if (device)
            {
                device.voice.position = anchorByte;
                seenEnds = device.voice.ends;
                device.voice.play(looping);
            }
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
            device?.voice.stop();
            anchorByte = playCursor();
            anchorMs = now();
            // Only a buffer that was playing stops; one that already ran to
            // its end said so when it got there.
            stopOwed ||= playing;
            playing = false;
        },

        /** @param {number} position */
        setCurrentPosition(position){
            reachedEnd = false;
            anchorByte = alignDown((position >>> 0) % bytes);
            anchorMs = now();
            lastNotified = anchorByte;
            ranOut = false;
            // Moved with the cursor, or the next read hands over everything
            // between where playback used to be and where it has been put --
            // which is most of the buffer, played at once.
            fedByte = anchorByte;
            fedLead = 0;
            if (device)
            {
                device.voice.position = anchorByte;
            }
        },

        /** @param {number} hz  Zero means the format's own rate. */
        setFrequency(hz){
            // Taken from where the cursor is now, so changing the rate does not
            // move playback: the anchor is in bytes and the rate only decides
            // how fast the next byte arrives.
            anchorByte = playCursor();
            anchorMs = now();
            frequency = (hz >>> 0) === 0 ? format.sampleRate : hz >>> 0;
            device?.voice.retune(frequency);
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

        /**
         * That pan as a multiplier for each side, left then right.
         *
         * Hundredths of a decibel like volume, taken off the side the sound is
         * panned away from while the other stays whole -- not a crossfade
         * between the two. The bound is silence on the far side, as the floor
         * of volume is.
         *
         * @returns {[number, number]}
         */
        get balance(){
            const keep = (/** @type {number} */ cut)=>(cut >= DSBPAN_RIGHT ? 0 : 10 ** (-cut / 2000));
            return [keep(Math.max(0, pan)), keep(Math.max(0, -pan))];
        },

        /** @param {{ offset: number, event: number }[]} positions */
        setNotifications(positions){
            notifications = positions.map(entry=>({ ...entry }));
            lastNotified = playCursor();
            // A stop from before these were set is not theirs to report.
            stopOwed = false;
            ranOut = false;
        },
        get notifications(){
            return notifications;
        },

        /**
         * Which notification events the cursor has passed since this was last
         * asked, in the order it passed them, and then those waiting for
         * playback to stop if it has.
         *
         * Crossing is tested rather than compared, because the cursor wraps: a
         * position behind the current one may have been passed a moment ago or
         * not for another whole buffer, and only the direction of travel says
         * which. DSBPN_OFFSETSTOP is no position and never crossed; tested as
         * one, it is past everything and fires on every lap.
         *
         * A position is passed once the frame there has been played: the span
         * runs from where the cursor stood, inclusive, to where it stands now,
         * exclusive. So the position playback starts at is the first one it
         * passes, and a one-shot's last frame is passed as it ends.
         *
         * @returns {number[]}
         */
        drainNotifications(){
            const play = playCursor();
            const from = lastNotified;
            // A lap the device came round since the last look, however near
            // it now stands to where it stood.
            const laps = device ? device.voice.laps : seenLaps;
            const lapped = laps !== seenLaps;
            seenLaps = laps;
            const wrapped = ranOut || lapped || play < from;
            lastNotified = play;
            ranOut = false;
            const stopped = stopOwed;
            stopOwed = false;
            if (notifications.length === 0)
            {
                return [];
            }
            const passed = (/** @type {number} */ offset)=>offset !== DSBPN_OFFSETSTOP
                && (wrapped ? offset >= from || offset < play : offset >= from && offset < play);
            /** @param {{ offset: number }} entry */
            const travelled = entry=>((entry.offset >>> 0) - from + bytes) % bytes;
            return notifications
                .filter(entry=>passed(entry.offset >>> 0))
                .sort((a, b)=>travelled(a) - travelled(b))
                .concat(stopped
                    ? notifications.filter(entry=>(entry.offset >>> 0) === DSBPN_OFFSETSTOP)
                    : [])
                .map(entry=>entry.event);
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
            if (device)
            {
                // The device plays it; what it passed is still checked against
                // what the program wrote, which is how a late refill -- heard as
                // a repeat of the last lap -- is counted on this path too.
                takeWritten(played(0));
                return [];
            }
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
            return { bytes: staleBytes, drains: staleDrains, at: [...staleAt],
                trail: staleTrail.map(entry=>entry.join(':')) };
        },

        /**
         * Locks that began past where the previous one ended, on a looping
         * buffer being played: the bytes between were passed over and, unless
         * a later lock comes back for them, will play as they were a lap ago.
         */
        /** Output frames the device waited, silent, for this stream to be written. */
        get held(){
            return heldFrames + (device ? device.voice.held : 0);
        },

        get skipped(){
            return { bytes: skippedBytes, count: skips };
        },

        /**
         * The one or two ranges a lock hands back, or null where Windows
         * refuses it (Wine's dsound.c test_lock): nothing asked for, a start
         * or a length past the buffer, or a lock still held.
         *
         * @param {number} offset
         * @param {number} requested
         * @param {number} flags
         * @returns {{ first: { address: number, bytes: number },
         *             second: { address: number, bytes: number } } | null}
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
                // A whole lap from where the lock starts, wrapping.
                wanted = bytes;
            }
            if (wanted === 0 || wanted > bytes || start >= bytes)
            {
                return null;
            }

            const first = Math.min(wanted, bytes - start);
            const second = wanted - first;
            const overlaps = (/** @type {number} */ at, /** @type {number} */ length)=>
                length > 0
                && held.some(range=>at < range.at + range.length && range.at < at + length);
            if (overlaps(start, first) || overlaps(0, second))
            {
                return null;
            }
            // Only a lock at a place the program chose can skip: one placed
            // at the write cursor or over the whole buffer says nothing about
            // where the stream was. Forward by less than half a lap, because
            // a lock behind the stream is a rewrite, not a jump over it.
            if (playing && looping && streamEnd !== null
                && (flags & (DSBLOCK_FROMWRITECURSOR | DSBLOCK_ENTIREBUFFER)) === 0)
            {
                const gap = (start - streamEnd + bytes) % bytes;
                if (gap > 0 && gap < bytes / 2)
                {
                    skippedBytes += gap;
                    skips++;
                }
            }
            const lock = { offset: start, length: wanted, left: second > 0 ? 2 : 1 };
            held.push({ at: start, length: first, lock });
            if (second > 0)
            {
                held.push({ at: 0, length: second, lock });
            }
            return {
                first: { address: address + start, bytes: first },
                second: { address: second > 0 ? address : 0, bytes: second },
            };
        },

        /**
         * Lets go of the ranges the program hands back by their addresses, in
         * order, stopping at one that is not held -- the ones before it are
         * let go of all the same, as on Windows. Naming none lets go of all.
         * Answers whether every address named a held range (and, naming
         * none, whether anything was held).
         *
         * @param {number[]} [addresses]
         */
        unlock(addresses){
            if (!addresses || addresses.length === 0)
            {
                const any = held.length > 0;
                while (held.length > 0)
                {
                    release(0);
                }
                return any;
            }
            for (const at of addresses)
            {
                const index = held.findIndex(range=>address + range.at === at);
                if (index < 0)
                {
                    return false;
                }
                release(index);
            }
            return true;
        },
        get locked(){
            return held.length > 0;
        },

        /**
         * Hands the buffer to the sound device: the whole buffer into the
         * voice's mirror, the voice put where the cursor stands and set
         * playing if the buffer is. `copy` writes a span of the program's
         * buffer into the mirror, and is called again at every unlock.
         *
         * @param {any} voice @param {(from: number, count: number) => void} copy
         */
        attachDevice(voice, copy){
            const at = playCursor();
            device = { voice, copy };
            copy(0, bytes);
            voice.position = at;
            seenLaps = voice.laps;
            seenEnds = voice.ends;
            anchorByte = at;
            if (playing)
            {
                voice.play(looping);
            }
        },
        /**
         * Takes the buffer back from the sound device, the cursor kept where
         * the device left it, and answers the voice for its owner to close.
         * A voice is what plays now, as a sound card's are: a buffer that is
         * not playing needs none, and the next Play attaches one again.
         */
        detachDevice(){
            if (!device)
            {
                return null;
            }
            const { voice } = device;
            anchorByte = playCursor();
            heldFrames += voice.held;
            device = null;
            return voice;
        },
        get device(){
            return device?.voice ?? null;
        },
    };
}
