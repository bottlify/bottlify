/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * winmm — the multimedia surface: a millisecond clock, wave audio, and the
 * device families this build does not have.
 *
 * Two things here carry weight and the rest is honest refusal.
 *
 * The clock is the first. `timeGetTime` is what a frame loop reads to decide
 * how much the world moved, and it has to be the same clock everything else in
 * this engine reads. Answering from the host's clock would let a program time
 * an interval with one clock and read it with another, and then disagree with
 * itself about how long its own frame took.
 *
 * The second is the wave-out queue. A program hands the system PCM in buffers
 * and learns that one is spent by watching a flag in a structure it owns; it
 * refills on that signal and on nothing else. So the flags are the contract,
 * not the sound: a buffer that never comes back stalls the program, and one
 * that comes back the instant it was written makes it spin. They are driven
 * here by a play cursor, and where that cursor comes from is the difference
 * between sound and the appearance of it. Given a real output the cursor is
 * what the device has consumed, so the flags a program watches and the sound a
 * person hears are the same fact. Given none it advances against the guest's
 * clock at the format's own byte rate -- which is what a device would do, keeps
 * a program running at the right speed, and produces silence.
 *
 * Everything else reports what is true: there are no midi, mixer, aux, joystick
 * or recording devices, and opening one fails the way it fails on a machine
 * that has none. A program handles that. Inventing a device it can write to and
 * hear nothing from would not be handled at all.
 */

/** Success, and the errors a caller distinguishes. */
const MMSYSERR_NOERROR = 0;
const MMSYSERR_BADDEVICEID = 2;
const MMSYSERR_INVALHANDLE = 5;
const MMSYSERR_INVALPARAM = 11;
const WAVERR_STILLPLAYING = 33;
const WAVERR_UNPREPARED = 34;

/** MCI's error space begins above the shared one. */
const MCIERR_INVALID_DEVICE_ID = 257;

/** joyGetDevCaps/joyGetPosEx on an id no device answers to. */
const JOYERR_PARMS = 165;

/**
 * WAVEHDR, the structure the caller owns and this reads and writes in place.
 *
 * `dwFlags` is the whole conversation: the caller sets nothing in it, and reads
 * WHDR_DONE to learn a buffer is spent.
 */
const WAVEHDR = Object.freeze({
    lpData: 0,
    dwBufferLength: 4,
    dwBytesRecorded: 8,
    dwUser: 12,
    dwFlags: 16,
    dwLoops: 20,
    lpNext: 24,
    reserved: 28,
    size: 32,
});

const WHDR_DONE = 0x00000001;
const WHDR_PREPARED = 0x00000002;
const WHDR_INQUEUE = 0x00000010;

/** WAVEFORMATEX. Only the byte rate matters here, but it is read where it is. */
const WAVEFORMATEX = Object.freeze({
    wFormatTag: 0,
    nChannels: 2,
    nSamplesPerSec: 4,
    nAvgBytesPerSec: 8,
    nBlockAlign: 12,
    wBitsPerSample: 14,
    cbSize: 16,
    size: 18,
});

/**
 * WAVEOUTCAPSA. The two paddings are the reason this is a table rather than a
 * running total: szPname ends at 38 and dwFormats is a DWORD, so it starts at
 * 40 rather than 38, and a reader that counts fields lands every later field
 * two bytes early.
 */
const WAVEOUTCAPS = Object.freeze({
    wMid: 0,
    wPid: 2,
    vDriverVersion: 4,
    szPname: 6,
    szPnameLength: 32,
    dwFormats: 40,
    wChannels: 44,
    wReserved1: 46,
    dwSupport: 48,
    size: 52,
});

/** The formats claimed: 44.1 kHz and 22.05 kHz, mono and stereo, 8 and 16 bit. */
const WAVE_FORMATS = 0x00000f00 | 0x000000f0;

/** WAVECAPS_VOLUME | WAVECAPS_LRVOLUME | WAVECAPS_SAMPLEACCURATE. */
const WAVE_SUPPORT = 0x0001 | 0x0008 | 0x0002;

/** How the caller asked to be told. The low word of the flags is unrelated. */
const CALLBACK_TYPEMASK = 0x00070000;

/** MMTIME's wType values. Milliseconds is 1, not 0 -- zero is no unit at all. */
const TIME_MS = 0x0001;
const TIME_BYTES = 0x0004;

/**
 * @typedef {Object} WinmmHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {() => number} now
 *           Guest milliseconds since boot -- the same clock the rest of the
 *           engine reads, never the host's.
 * @property {(notice: { kind: number, target: number, message: number,
 *                       instance: number, param: number }) => void} [notify]
 *           Tells the caller a buffer came back, through whichever of the
 *           window, callback or event forms it asked for. Absent in a build
 *           that cannot reach guest code; the flags still behave, and a program
 *           that polls them still works.
 * @property {() => any} [output]
 *           Where the samples go. Handed down rather than reached for: the
 *           audio layer sits above this one and cannot be imported from here.
 *           Absent, or answering null, means there is nothing listening and the
 *           cursor falls back to the clock.
 */

/** @param {Uint8Array} bytes @param {number} at */
const u32 = (bytes, at)=>(bytes[at] | bytes[at + 1] << 8
    | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0;

/** @param {Uint8Array} bytes @param {number} at */
const u16 = (bytes, at)=>bytes[at] | bytes[at + 1] << 8;

/** @param {number} value */
const dword = value=>new Uint8Array([
    value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
]);

/**
 * @param {WinmmHost} host
 */
export function createWinmmFunctions(host){
    /**
     * @typedef {Object} WaveOut
     * @property {number} bytesPerSecond
     * @property {number} callbackKind
     * @property {number} callbackTarget
     * @property {number} callbackInstance
     * @property {{ header: number, length: number }[]} queue
     * @property {number} playedBytes  Into the buffer at the head of the queue.
     * @property {number} sinceMs      When the cursor was last settled.
     * @property {boolean} paused
     * @property {any} track           The mixer's source, or null.
     * @property {number} trackBytes   Guest bytes the device had played last time.
     */

    /** @type {Map<number, WaveOut>} */
    const devices = new Map();
    let nextHandle = 0x1000;

    /** @param {number} handle */
    const deviceOf = handle=>devices.get(handle >>> 0) ?? null;

    /** @param {number} header @returns {number} */
    const flagsOf = header=>
        u32(host.readMemory(header + WAVEHDR.dwFlags, 4), 0);

    /** @param {number} header @param {number} flags */
    const setFlags = (header, flags)=>
        host.writeMemory(header + WAVEHDR.dwFlags, dword(flags >>> 0));

    /**
     * Advances the play cursor to now, and returns whatever finished.
     *
     * Nothing queued means the cursor does not run: a device that kept counting
     * through silence would hand back the next buffer written to it the instant
     * it arrived, and the program would spin refilling a queue that was never
     * full.
     *
     * @param {WaveOut} device
     */
    const settle = device=>{
        const now = host.now();
        if (device.paused)
        {
            device.sinceMs = now;
            return;
        }

        const elapsed = Math.max(0, now - device.sinceMs);
        device.sinceMs = now;
        if (device.track)
        {
            // What the device actually played, in the guest's own byte rate.
            // Taken as a difference rather than as a position because the
            // cursor is relative to the head of the queue, which moves.
            const played = device.track.played() * device.bytesPerSecond
                / device.track.rate;
            device.playedBytes += Math.max(0, played - device.trackBytes);
            device.trackBytes = played;
        }
        else
        {
            device.playedBytes += elapsed * device.bytesPerSecond / 1000;
        }

        while (device.queue.length > 0 && device.playedBytes >= device.queue[0].length)
        {
            const done = /** @type {{ header: number, length: number }} */
                (device.queue.shift());
            device.playedBytes -= done.length;
            setFlags(done.header, flagsOf(done.header) & ~WHDR_INQUEUE | WHDR_DONE);
            host.notify?.({
                kind: device.callbackKind,
                target: device.callbackTarget,
                // MM_WOM_DONE. A window form is posted it; a callback form is
                // called with it; an event form ignores it and is signalled.
                message: 0x03bd,
                instance: device.callbackInstance,
                param: done.header,
            });
        }
        if (device.queue.length === 0)
        {
            // The cursor is reset rather than left where it reached, and this
            // is what keeps a drained device from counting through silence: a
            // device that kept its position would hand back the next buffer
            // written to it instantly and the program would spin.
            device.playedBytes = 0;
        }
    };

    /** Every entry point that touches a device settles it first. @param {number} handle */
    const settled = handle=>{
        const device = deviceOf(handle);
        if (device)
        {
            settle(device);
        }
        return device;
    };

    /** The header-preparing pair, which differs between wave in and out only in name. */
    const prepare = {
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([handle, header, size])=>{
            if (!deviceOf(handle))
            {
                return MMSYSERR_INVALHANDLE;
            }
            if ((size >>> 0) < WAVEHDR.size)
            {
                return MMSYSERR_INVALPARAM;
            }
            setFlags(header >>> 0, flagsOf(header >>> 0) | WHDR_PREPARED);
            return MMSYSERR_NOERROR;
        },
    };

    const unprepare = {
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([handle, header])=>{
            if (!settled(handle))
            {
                return MMSYSERR_INVALHANDLE;
            }
            const flags = flagsOf(header >>> 0);
            if ((flags & WHDR_INQUEUE) !== 0)
            {
                // Unpreparing a buffer the device still owns would let the
                // caller reuse memory that is about to be read.
                return WAVERR_STILLPLAYING;
            }
            setFlags(header >>> 0, flags & ~WHDR_PREPARED);
            return MMSYSERR_NOERROR;
        },
    };

    /** Devices this build does not have. @param {number} argBytes @param {number} error */
    const noDevice = (argBytes, error)=>({ argBytes, handler: ()=>error });

    /** @param {number} argBytes */
    const noDevices = argBytes=>({ argBytes, handler: ()=>0 });

    return {
        /**
         * DWORD timeGetTime(void)
         *
         * The guest's own clock. A frame loop divides by the difference between
         * two of these, so it must be the clock that advances with the guest.
         */
        timeGetTime: {
            argBytes: 0,
            handler: ()=>host.now() >>> 0,
        },

        /**
         * MMRESULT timeBeginPeriod(UINT uPeriod) / timeEndPeriod(UINT)
         *
         * A request for finer timer resolution. There is one clock here and it
         * is as fine as it is, so the request is granted by having nothing to
         * do -- which is also what happens on a machine already at that period.
         */
        timeBeginPeriod: { argBytes: 4, handler: ()=>MMSYSERR_NOERROR },
        timeEndPeriod: { argBytes: 4, handler: ()=>MMSYSERR_NOERROR },

        /** MMRESULT timeGetSystemTime(LPMMTIME pmmt, UINT cbmmt) */
        timeGetSystemTime: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([time, size])=>{
                if ((size >>> 0) < 8)
                {
                    return MMSYSERR_INVALPARAM;
                }
                host.writeMemory(time >>> 0, dword(TIME_MS));
                host.writeMemory((time >>> 0) + 4, dword(host.now() >>> 0));
                return MMSYSERR_NOERROR;
            },
        },

        /** UINT waveOutGetNumDevs(void) */
        waveOutGetNumDevs: { argBytes: 0, handler: ()=>1 },

        /**
         * MMRESULT waveOutGetDevCapsA(UINT_PTR uDeviceID, LPWAVEOUTCAPSA pwoc,
         *                             UINT cbwoc)
         */
        waveOutGetDevCapsA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([device, caps, size])=>{
                // WAVE_MAPPER is -1 and names whichever device the system would
                // pick, which here is the only one.
                if ((device | 0) !== -1 && (device >>> 0) !== 0)
                {
                    return MMSYSERR_BADDEVICEID;
                }
                const bytes = new Uint8Array(WAVEOUTCAPS.size);
                const name = 'Bottlify Wave Out';
                for (let at = 0; at < name.length; at++)
                {
                    bytes[WAVEOUTCAPS.szPname + at] = name.charCodeAt(at);
                }
                bytes.set(dword(WAVE_FORMATS), WAVEOUTCAPS.dwFormats);
                bytes[WAVEOUTCAPS.wChannels] = 2;
                bytes.set(dword(WAVE_SUPPORT), WAVEOUTCAPS.dwSupport);
                // Truncated to what the caller offered: an older header is
                // shorter, and writing the whole of ours past it would land in
                // whatever follows.
                host.writeMemory(caps >>> 0,
                    bytes.subarray(0, Math.min(size >>> 0, WAVEOUTCAPS.size)));
                return MMSYSERR_NOERROR;
            },
        },

        /** MMRESULT waveOutGetID(HWAVEOUT hwo, LPUINT puDeviceID) */
        waveOutGetID: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, out])=>{
                if (!settled(handle))
                {
                    return MMSYSERR_INVALHANDLE;
                }
                host.writeMemory(out >>> 0, dword(0));
                return MMSYSERR_NOERROR;
            },
        },

        /**
         * MMRESULT waveOutGetPosition(HWAVEOUT hwo, LPMMTIME pmmt, UINT cbmmt)
         *
         * Where the cursor has reached. This is what a program polls when it
         * does not wait on anything, and polling it is what moves the cursor at
         * all -- there is no interrupt here, so time is credited to the device
         * whenever the device is asked about.
         */
        waveOutGetPosition: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, time, size])=>{
                const device = settled(handle);
                if (!device)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                if ((size >>> 0) < 8)
                {
                    return MMSYSERR_INVALPARAM;
                }
                const wanted = u32(host.readMemory(time >>> 0, 4), 0);
                const bytes = Math.floor(device.playedBytes);
                host.writeMemory(time >>> 0, dword(wanted === TIME_BYTES
                    ? TIME_BYTES
                    : TIME_MS));
                host.writeMemory((time >>> 0) + 4, dword(wanted === TIME_BYTES
                    ? bytes
                    : Math.floor(bytes * 1000 / device.bytesPerSecond)));
                return MMSYSERR_NOERROR;
            },
        },

        /**
         * MMRESULT waveOutOpen(LPHWAVEOUT phwo, UINT_PTR uDeviceID,
         *                      LPCWAVEFORMATEX pwfx, DWORD_PTR dwCallback,
         *                      DWORD_PTR dwInstance, DWORD fdwOpen)
         *
         * WAVE_FORMAT_QUERY asks whether the format would be accepted without
         * opening anything, and a program uses it to choose among formats.
         */
        waveOutOpen: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([out, device, format, callback, instance, flags])=>{
                if ((device | 0) !== -1 && (device >>> 0) !== 0)
                {
                    return MMSYSERR_BADDEVICEID;
                }

                const header = host.readMemory(format >>> 0, WAVEFORMATEX.size);
                let bytesPerSecond = u32(header, WAVEFORMATEX.nAvgBytesPerSec);
                if (bytesPerSecond === 0)
                {
                    // Derivable, and worth deriving: a zero rate would make the
                    // cursor stand still and every buffer queue for ever.
                    bytesPerSecond = u32(header, WAVEFORMATEX.nSamplesPerSec)
                        * u16(header, WAVEFORMATEX.nChannels)
                        * Math.max(1, u16(header, WAVEFORMATEX.wBitsPerSample) / 8);
                }
                if (bytesPerSecond === 0)
                {
                    return MMSYSERR_INVALPARAM;
                }

                if (((flags >>> 0) & 0x0001) !== 0)
                {
                    return MMSYSERR_NOERROR; // WAVE_FORMAT_QUERY
                }

                const handle = nextHandle++;
                const mixer = host.output?.() ?? null;
                devices.set(handle, {
                    bytesPerSecond,
                    callbackKind: (flags >>> 0) & CALLBACK_TYPEMASK,
                    callbackTarget: callback >>> 0,
                    callbackInstance: instance >>> 0,
                    queue: [],
                    playedBytes: 0,
                    sinceMs: host.now(),
                    paused: false,
                    track: mixer?.open({
                        sampleRate: u32(header, WAVEFORMATEX.nSamplesPerSec),
                        channels: u16(header, WAVEFORMATEX.nChannels),
                        bitsPerSample: u16(header, WAVEFORMATEX.wBitsPerSample) || 16,
                    }) ?? null,
                    trackBytes: 0,
                });
                host.writeMemory(out >>> 0, dword(handle));
                return MMSYSERR_NOERROR;
            },
        },

        /** MMRESULT waveOutPrepareHeader / waveOutUnprepareHeader */
        waveOutPrepareHeader: prepare,
        waveOutUnprepareHeader: unprepare,

        /**
         * MMRESULT waveOutWrite(HWAVEOUT hwo, LPWAVEHDR pwh, UINT cbwh)
         *
         * The buffer stays the caller's; only its length is taken. Refusing an
         * unprepared header is not pedantry -- preparing is what tells the
         * caller its memory is about to be read by something else.
         */
        waveOutWrite: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, header, size])=>{
                const device = settled(handle);
                if (!device)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                if ((size >>> 0) < WAVEHDR.size)
                {
                    return MMSYSERR_INVALPARAM;
                }

                const at = header >>> 0;
                const flags = flagsOf(at);
                if ((flags & WHDR_PREPARED) === 0)
                {
                    return WAVERR_UNPREPARED;
                }
                if ((flags & WHDR_INQUEUE) !== 0)
                {
                    return WAVERR_STILLPLAYING;
                }

                const length = u32(host.readMemory(at + WAVEHDR.dwBufferLength, 4), 0);
                setFlags(at, flags & ~WHDR_DONE | WHDR_INQUEUE);
                if (device.queue.length === 0)
                {
                    // The cursor starts now, not whenever the device was opened.
                    device.sinceMs = host.now();
                    device.playedBytes = 0;
                }
                device.queue.push({ header: at, length });
                // The bytes are copied out now rather than referred to. The
                // buffer stays the caller's and it is entitled to refill it the
                // moment the header comes back, which is long before the sound
                // in it has been heard.
                if (device.track && length > 0)
                {
                    const data = u32(host.readMemory(at + WAVEHDR.lpData, 4), 0);
                    device.track.write(host.readMemory(data, length));
                }
                return MMSYSERR_NOERROR;
            },
        },

        /** MMRESULT waveOutPause / waveOutRestart */
        waveOutPause: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const device = settled(handle);
                if (!device)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                device.paused = true;
                if (device.track)
                {
                    device.track.paused = true;
                }
                return MMSYSERR_NOERROR;
            },
        },
        waveOutRestart: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const device = deviceOf(handle);
                if (!device)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                device.paused = false;
                if (device.track)
                {
                    device.track.paused = false;
                }
                device.sinceMs = host.now();
                return MMSYSERR_NOERROR;
            },
        },

        /**
         * MMRESULT waveOutReset(HWAVEOUT hwo)
         *
         * Every queued buffer comes back marked done. A program calls this to
         * stop, and then waits for its buffers -- so they have to arrive, or the
         * wait never ends.
         */
        waveOutReset: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const device = deviceOf(handle);
                if (!device)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                for (const queued of device.queue)
                {
                    setFlags(queued.header,
                        flagsOf(queued.header) & ~WHDR_INQUEUE | WHDR_DONE);
                    host.notify?.({
                        kind: device.callbackKind,
                        target: device.callbackTarget,
                        message: 0x03bd,
                        instance: device.callbackInstance,
                        param: queued.header,
                    });
                }
                device.queue = [];
                device.playedBytes = 0;
                device.trackBytes = 0;
                device.track?.reset();
                device.sinceMs = host.now();
                return MMSYSERR_NOERROR;
            },
        },

        /** MMRESULT waveOutClose(HWAVEOUT hwo) */
        waveOutClose: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const device = settled(handle);
                if (!device)
                {
                    return MMSYSERR_INVALHANDLE;
                }
                if (device.queue.length > 0)
                {
                    // Documented, and a program depends on it: it closes, sees
                    // this, resets, and closes again.
                    return WAVERR_STILLPLAYING;
                }
                device.track?.close();
                devices.delete(handle >>> 0);
                return MMSYSERR_NOERROR;
            },
        },

        /**
         * Recording. There is no capture device, and saying so is what lets a
         * program fall back; the rest of the wave-in surface then answers on a
         * handle nothing ever opened.
         */
        waveInGetNumDevs: { argBytes: 0, handler: ()=>0 },
        waveInOpen: noDevice(24, MMSYSERR_BADDEVICEID),
        waveInPrepareHeader: noDevice(12, MMSYSERR_INVALHANDLE),
        waveInUnprepareHeader: noDevice(12, MMSYSERR_INVALHANDLE),
        waveInAddBuffer: noDevice(12, MMSYSERR_INVALHANDLE),
        waveInStart: noDevice(4, MMSYSERR_INVALHANDLE),
        waveInReset: noDevice(4, MMSYSERR_INVALHANDLE),
        waveInClose: noDevice(4, MMSYSERR_INVALHANDLE),

        /** Midi out: no synthesiser and no port. */
        midiOutGetNumDevs: { argBytes: 0, handler: ()=>0 },
        midiOutOpen: noDevice(20, MMSYSERR_BADDEVICEID),
        midiOutClose: noDevice(4, MMSYSERR_INVALHANDLE),
        midiOutReset: noDevice(4, MMSYSERR_INVALHANDLE),
        midiOutShortMsg: noDevice(8, MMSYSERR_INVALHANDLE),
        midiOutLongMsg: noDevice(12, MMSYSERR_INVALHANDLE),
        midiOutPrepareHeader: noDevice(12, MMSYSERR_INVALHANDLE),
        midiOutUnprepareHeader: noDevice(12, MMSYSERR_INVALHANDLE),

        /** The mixer, which a program uses to find the volume controls. */
        mixerGetNumDevs: noDevices(0),
        mixerOpen: noDevice(20, MMSYSERR_BADDEVICEID),
        mixerClose: noDevice(4, MMSYSERR_INVALHANDLE),
        mixerGetLineInfoA: noDevice(12, MMSYSERR_INVALHANDLE),
        mixerGetLineControlsA: noDevice(12, MMSYSERR_INVALHANDLE),
        mixerGetControlDetailsA: noDevice(12, MMSYSERR_INVALHANDLE),
        mixerSetControlDetails: noDevice(12, MMSYSERR_INVALHANDLE),

        /** The auxiliary output, an older way to the same volume. */
        auxGetNumDevs: noDevices(0),
        auxGetDevCapsA: noDevice(12, MMSYSERR_BADDEVICEID),
        auxGetVolume: noDevice(8, MMSYSERR_BADDEVICEID),
        auxSetVolume: noDevice(8, MMSYSERR_BADDEVICEID),

        /** MCI, which drives CD audio and video among other things. */
        mciSendCommandA: { argBytes: 16, handler: ()=>MCIERR_INVALID_DEVICE_ID },

        /**
         * Joysticks. The input layer is a stub, so there are none -- and a
         * program polling one it was told about would read the same neutral
         * position for ever without knowing why.
         */
        joyGetNumDevs: noDevices(0),
        joyGetDevCapsA: { argBytes: 12, handler: ()=>JOYERR_PARMS },
        joyGetPosEx: { argBytes: 8, handler: ()=>JOYERR_PARMS },
    };
}
