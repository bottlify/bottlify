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

import { parseWave } from './wave.js';
import { MAX_PERIOD } from './timers.js';

/** Success, and the errors a caller distinguishes. */
const MMSYSERR_NOERROR = 0;
const MMSYSERR_BADDEVICEID = 2;
const MMSYSERR_INVALHANDLE = 5;
const MMSYSERR_BADERRNUM = 9;
const MMSYSERR_INVALPARAM = 11;
const WAVERR_STILLPLAYING = 33;
const WAVERR_UNPREPARED = 34;
const TIMERR_NOCANDO = 97;

/**
 * What the error-text calls say for the codes every device family shares. The
 * wording is this build's own; a program shows it to a person and compares
 * nothing against it.
 */
const SHARED_ERROR_TEXT = new Map([
    [0, 'The specified command was carried out.'],
    [1, 'An unspecified error occurred.'],
    [2, 'The device identifier is out of range for this system.'],
    [3, 'The driver could not be enabled.'],
    [4, 'The device is already in use.'],
    [5, 'The device handle is not valid.'],
    [6, 'No driver is installed for this device.'],
    [7, 'There is not enough memory for this operation.'],
    [8, 'The driver does not support this function.'],
    [9, 'The error number is not one this system knows.'],
    [10, 'A flag passed to the function is not valid.'],
    [11, 'A parameter passed to the function is not valid.'],
    [12, 'The handle is in use by another thread.'],
    [13, 'The alias is not one this system knows.'],
    [14, 'The registry database is damaged.'],
    [15, 'The registry key was not found.'],
    [16, 'The registry could not be read.'],
    [17, 'The registry could not be written.'],
    [18, 'The registry entry could not be deleted.'],
    [19, 'The registry value was not found.'],
    [20, 'The driver does not call back.'],
    [21, 'There is more data to return.'],
]);

/** The wave calls' codes: the shared ones and WAVERR_BASE's. */
const WAVE_ERROR_TEXT = new Map([
    ...SHARED_ERROR_TEXT,
    [32, 'The device does not support this wave format.'],
    [33, 'The device is still playing its buffers.'],
    [34, 'The wave header has not been prepared.'],
    [35, 'The device is synchronous and was not opened to allow that.'],
]);

/** The MIDI calls' codes: the shared ones and MIDIERR_BASE's. */
const MIDI_ERROR_TEXT = new Map([
    ...SHARED_ERROR_TEXT,
    [64, 'The MIDI header has not been prepared.'],
    [65, 'The MIDI device is still playing its buffers.'],
    [66, 'There is no MIDI map to use.'],
    [67, 'The MIDI port is still sending data to the device.'],
    [68, 'The MIDI device the setup names is not present.'],
    [69, 'The MIDI setup is not valid.'],
    [70, 'The operation is not possible in the mode the device was opened in.'],
    [71, 'The MIDI message is not to be passed on.'],
]);

/** MCI's error space begins above the shared one. */
const MCIERR_INVALID_DEVICE_ID = 257;
const MCIERR_UNRECOGNIZED_COMMAND = 261;
const MCIERR_INVALID_DEVICE_NAME = 263;
const MCIERR_CANNOT_LOAD_DRIVER = 266;
const MCIERR_MISSING_COMMAND_STRING = 267;
const MCIERR_CANNOT_USE_ALL = 279;
const MCIERR_EXTENSION_NOT_FOUND = 281;
const MCIERR_OUTOFRANGE = 282;
const MCIERR_MISSING_DEVICE_NAME = 292;
const MCIERR_NULL_PARAMETER_BLOCK = 297;

/** The id `all` names: every open device at once. */
const MCI_ALL_DEVICE_ID = 0xffffffff;

/**
 * mciGetDeviceID's answer for a name. No device is ever open here, so only
 * `all` names one.
 *
 * @param {string} name
 */
const deviceIdOf = name=>(name.trim().toLowerCase() === 'all' ? MCI_ALL_DEVICE_ID : 0);

/**
 * The MCI device types Windows registers a driver for. Naming one opens that
 * driver, and there being no hardware behind it here is what makes it fail
 * to load -- the answer a machine with no CD drive gives for `cdaudio`.
 */
const MCI_DEVICE_TYPES = new Set([
    'animation', 'avivideo', 'cdaudio', 'dat', 'digitalvideo', 'mpegvideo', 'other',
    'overlay', 'scanner', 'sequencer', 'vcr', 'videodisc', 'waveaudio',
]);

/** The file extensions a registered MCI driver would open by itself. */
const MCI_EXTENSIONS = new Set([
    'aif', 'aifc', 'aiff', 'asf', 'au', 'avi', 'cda', 'm1v', 'mid', 'midi', 'mp2', 'mp3',
    'mpa', 'mpe', 'mpeg', 'mpg', 'rmi', 'snd', 'wav', 'wma', 'wmv',
]);

/** The command verbs MCI's parser knows, for any device. */
const MCI_COMMANDS = new Set([
    'break', 'capability', 'capture', 'close', 'configure', 'copy', 'cue', 'cut', 'delete',
    'escape', 'freeze', 'info', 'list', 'load', 'monitor', 'open', 'paste', 'pause', 'play',
    'put', 'quality', 'realize', 'record', 'reserve', 'restore', 'resume', 'save', 'seek',
    'set', 'setaudio', 'setvideo', 'signal', 'sound', 'spin', 'status', 'step', 'stop',
    'sysinfo', 'undo', 'unfreeze', 'update', 'where', 'window',
]);

/** MCI_OPEN, its flags, and the device-type ids MCI_OPEN_TYPE_ID names. */
const MCI_OPEN = 0x0803;
const MCI_OPEN_ELEMENT = 0x0200;
const MCI_OPEN_TYPE_ID = 0x1000;
const MCI_OPEN_TYPE = 0x2000;
const MCI_DEVTYPE_FIRST = 0x0201;
const MCI_DEVTYPE_LAST = 0x020b;

/**
 * What mciGetErrorString says for each MCI error, MCIERR_BASE (256) up, in
 * this build's own wording; a code with no text here is one MCI does not
 * know, and a driver's own codes, from MCIERR_CUSTOM_DRIVER_BASE, are the
 * driver's to explain.
 */
const MCI_ERROR_TEXT = new Map([
    [257, 'The device identifier is not one an open device has.'],
    [259, 'The command parameter is not one this command takes.'],
    [261, 'The command is not one MCI knows.'],
    [262, 'The device reported a hardware problem.'],
    [263, 'The device name is not a known device or alias.'],
    [264, 'There is not enough memory for this command.'],
    [265, 'The device name is already the alias of an open device.'],
    [266, 'The device driver could not be loaded.'],
    [267, 'No command was given.'],
    [268, 'The answer is longer than the buffer given for it.'],
    [269, 'The command needs a string that was not given.'],
    [270, 'An integer in the command is not valid.'],
    [271, 'The parser met an internal error.'],
    [272, 'The device driver met an internal error.'],
    [273, 'The command needs a parameter that was not given.'],
    [274, 'The device does not support this command.'],
    [275, 'The file was not found.'],
    [276, 'The device is not ready.'],
    [277, 'MCI met an internal error.'],
    [278, 'The device driver reported an error.'],
    [279, 'This command cannot be given to all devices at once.'],
    [280, 'Errors occurred in more than one device.'],
    [281, 'No device type is registered for the file\'s extension.'],
    [282, 'The parameter is out of range for this command.'],
    [284, 'The flags given cannot be used together.'],
    [286, 'The file was not saved.'],
    [287, 'The device type must be given.'],
    [288, 'The device is in use; wait and try again.'],
    [289, 'The alias is already in use by this application.'],
    [290, 'A constant in the command is not valid for it.'],
    [291, 'The device is already in use and must be opened shareable.'],
    [292, 'The command needs a device name or alias.'],
    [293, 'The time format is not valid.'],
    [294, 'A quotation mark in the command is not closed.'],
    [295, 'A flag is given more than once.'],
    [296, 'The file is not in a format the device can use.'],
    [297, 'The command was given a null parameter block.'],
    [298, 'The resource was not named.'],
    [299, 'A new file must be given an alias.'],
    [300, 'A device opened automatically cannot notify.'],
    [301, 'The device does not take a file name.'],
    [302, 'The command is not applicable to this device.'],
    [303, 'A device opened automatically cannot take this command.'],
    [304, 'The command needs a file name.'],
    [305, 'There are characters after the end of the command.'],
    [306, 'The device is not installed.'],
    [307, 'The current directory could not be read.'],
    [308, 'The current directory could not be set.'],
    [309, 'The current drive could not be set.'],
    [310, 'The device or driver name is too long.'],
    [311, 'The device or driver name is too long.'],
    [312, 'The command needs an integer.'],
    [320, 'Every wave output device is in use.'],
    [321, 'The wave output device set is in use.'],
    [322, 'Every wave input device is in use.'],
    [323, 'The wave input device set is in use.'],
    [324, 'No wave output device can play the file.'],
    [325, 'No wave input device can record.'],
    [326, 'No wave output device can play the file\'s format.'],
    [327, 'The wave output device set cannot play the file\'s format.'],
    [328, 'No wave input device can record the format.'],
    [329, 'The wave input device set cannot record the format.'],
    [336, 'The file\'s time division does not suit the sequencer.'],
    [337, 'The MIDI port is in use.'],
    [338, 'The MIDI port does not exist.'],
    [339, 'The MIDI map names a device that is not there.'],
    [340, 'The MIDI port reported an error.'],
    [341, 'The sequencer could not get a timer.'],
    [342, 'No MIDI port is set.'],
    [343, 'There is no MIDI device to play on.'],
    [346, 'There is no window to show the display in.'],
    [347, 'The window could not be made.'],
    [348, 'The file could not be read.'],
    [349, 'The file could not be written.'],
    [350, 'The device identity could not be established.'],
]);

/**
 * What opening an MCI device or file answers on a machine that has none: a
 * type a driver is registered for, or a file of an extension one opens, fails
 * to load its driver; anything else names no device at all. A `type!element`
 * name is its type.
 *
 * @param {string} name
 */
const openFailure = name=>{
    const lower = name.toLowerCase();
    const type = lower.includes('!') ? lower.slice(0, lower.indexOf('!')) : lower;
    if (MCI_DEVICE_TYPES.has(type))
    {
        return MCIERR_CANNOT_LOAD_DRIVER;
    }
    const dot = lower.lastIndexOf('.');
    if (dot > Math.max(lower.lastIndexOf('\\'), lower.lastIndexOf('/')))
    {
        return MCI_EXTENSIONS.has(lower.slice(dot + 1))
            ? MCIERR_CANNOT_LOAD_DRIVER : MCIERR_EXTENSION_NOT_FOUND;
    }
    return MCIERR_INVALID_DEVICE_NAME;
};

/**
 * mciSendString's answer and the text it returns. Nothing is ever open here,
 * so every command that needs a device opens one first, as the string
 * interface does for a device named by type or file -- and that open is where
 * it fails. Closing everything and counting devices are the two things that
 * succeed.
 *
 * @param {string} command
 * @returns {{ error: number, text: string }}
 */
const mciString = command=>{
    const words = (command.trim().match(/"[^"]*"|\S+/g) ?? [])
        .map(word=>word.replace(/^"(.*)"$/, '$1'));
    if (words.length === 0)
    {
        return { error: MCIERR_MISSING_COMMAND_STRING, text: '' };
    }
    const verb = words[0].toLowerCase();
    const device = words[1];
    const rest = words.slice(2).map(word=>word.toLowerCase());
    if (!MCI_COMMANDS.has(verb))
    {
        return { error: MCIERR_UNRECOGNIZED_COMMAND, text: '' };
    }
    if (device === undefined)
    {
        return { error: MCIERR_MISSING_DEVICE_NAME, text: '' };
    }
    const all = device.toLowerCase() === 'all';
    if (verb === 'sysinfo')
    {
        return rest.includes('quantity')
            ? { error: 0, text: '0' }
            : { error: MCIERR_OUTOFRANGE, text: '' };
    }
    if (verb === 'close')
    {
        return { error: all ? 0 : MCIERR_INVALID_DEVICE_NAME, text: '' };
    }
    if (all)
    {
        return { error: MCIERR_CANNOT_USE_ALL, text: '' };
    }
    const type = verb === 'open' ? rest.indexOf('type') : -1;
    return {
        error: openFailure(type >= 0 && words[type + 3] !== undefined ? words[type + 3] : device),
        text: '',
    };
};

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

/**
 * WAVECAPS_VOLUME | WAVECAPS_SAMPLEACCURATE. One level for both channels, not
 * WAVECAPS_LRVOLUME: a track has a single gain, and a device without separate
 * left and right control is documented to take the low word of a volume.
 */
const WAVE_SUPPORT = 0x0001 | 0x0002;

/** How the caller asked to be told. The low word of the flags is unrelated. */
const CALLBACK_TYPEMASK = 0x00070000;

/**
 * The one form that is not host-side bookkeeping: it runs guest code, so it can
 * only be delivered from somewhere a guest thread is stopped. Named here rather
 * than left to `notify` because deferring it is this file's decision -- see
 * `tick`.
 */
const CALLBACK_FUNCTION = 0x00030000;

/**
 * What a wave-out device says about itself. A window form is posted one of
 * these, a callback form is called with it, an event form ignores it and is
 * signalled.
 */
const MM_WOM_OPEN = 0x03bb;
const MM_WOM_CLOSE = 0x03bc;
const MM_WOM_DONE = 0x03bd;

/** PlaySound's flags: where the sound is, and whether the call waits for it. */
const SND_ASYNC = 0x0001;
const SND_MEMORY = 0x0004;
const SND_LOOP = 0x0008;
const SND_FILENAME = 0x00020000;
const SND_RESOURCE = 0x00040004;

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
 * @property {(() => any) | undefined} [currentThread]
 *           Whose call is being answered. Read before anything is awaited: a
 *           notice delivered after one would otherwise go to whoever is on the
 *           processor then, and a callback built on a stranger's stack is a
 *           crash with no author.
 * @property {(notice: import('./notify.js').WaveNotice, thread?: any) =>
 *               void | Promise<any>} [notify]
 *           Tells the caller a buffer came back, through whichever of the
 *           window, thread, callback or event forms it asked for. Answering
 *           with a promise means guest code is running and the notice is not
 *           delivered until it settles. Absent in a build that cannot reach
 *           guest code; the flags still behave, and a program that polls them
 *           still works.
 * @property {(notice: import('./notify.js').WaveNotice) => void} [deliverDone]
 *           Runs a callback-form WOM_DONE on a thread of its own, the way the
 *           device's driver would, and never on the thread whose call retired
 *           the buffer. A build without one falls back to `notify`, which
 *           parks the caller and runs the callback on its stack -- and a
 *           program whose write path and callback take the same lock recurses
 *           there until the stack runs out.
 * @property {() => any} [output]
 *           Where the samples go. Handed down rather than reached for: the
 *           audio layer sits above this one and cannot be imported from here.
 *           Absent, or answering null, means there is nothing listening and the
 *           cursor falls back to the clock.
 * @property {(api: string, detail: string) => void} [divergence]
 *           Where a call that answers differently from Windows says so.
 * @property {ReturnType<typeof import('./timers.js').createTimerService>} [timers]
 *           The multimedia timer service (`timers.js`). Absent in a build
 *           that cannot run a thread: `timeSetEvent` then answers no timer.
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
 * Which ordinal is which export, for a program that links WINMM.dll by number.
 * Windows exports PlaySoundA a second time as ordinal 2, with no name.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const WINMM_ORDINALS = Object.freeze({
    2: 'PlaySoundA',
});

/**
 * @param {WinmmHost} host
 */
export function createWinmmFunctions(host){
    /**
     * @typedef {Object} WaveOut
     * @property {number} handle
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
     * @property {import('./notify.js').WaveNotice[]} pending  Owed, not yet told.
     * @property {boolean} delivering  A flush() is walking `pending` right now.
     * @property {number} written      Buffers handed over, ever.
     * @property {number} retired      Of those, the ones handed back.
     * @property {number} bytesWritten
     * @property {number} bytesRetired
     */

    /** @type {Map<number, WaveOut>} */
    const devices = new Map();
    /** Handles start here, above every device id: one below it is an id. */
    const FIRST_HANDLE = 0x1000;
    let nextHandle = FIRST_HANDLE;

    /**
     * The device's volume as waveOutSetVolume last set it. There is one
     * device, so one level, heard through every track it plays.
     */
    let volume = 0xffffffff;

    /** The gain a track plays at for the volume's one level, the low word. */
    const gain = ()=>(volume & 0xffff) / 0xffff;

    /**
     * Which of MMSYSERR_NOERROR, MMSYSERR_BADDEVICEID and MMSYSERR_INVALHANDLE
     * an hwo names: the volume calls take an open device's handle or a device
     * id, WAVE_MAPPER included.
     *
     * @param {number} hwo
     */
    const volumeTarget = hwo=>{
        const value = hwo >>> 0;
        if (devices.has(value) || value === 0 || value === 0xffffffff)
        {
            return MMSYSERR_NOERROR;
        }
        return value < FIRST_HANDLE ? MMSYSERR_BADDEVICEID : MMSYSERR_INVALHANDLE;
    };

    /**
     * An ANSI string out of guest memory, read a piece at a time so a short
     * one near the end of mapped memory is not read past.
     *
     * @param {number} address @param {number} limit
     */
    const ansiAt = (address, limit)=>{
        let text = '';
        for (let at = address >>> 0; text.length < limit; at += 64)
        {
            const piece = host.readMemory(at, 64);
            const end = piece.indexOf(0);
            text += String.fromCharCode(...piece.subarray(0, end < 0 ? piece.length : end));
            if (end >= 0 || piece.length < 64)
            {
                break;
            }
        }
        return text.slice(0, limit);
    };

    /**
     * A UTF-16 string out of guest memory, read the same way.
     *
     * @param {number} address @param {number} limit
     */
    const wideAt = (address, limit)=>{
        let text = '';
        for (let at = address >>> 0; text.length < limit; at += 64)
        {
            const piece = host.readMemory(at, 64);
            for (let index = 0; index + 1 < piece.length; index += 2)
            {
                const unit = piece[index] | piece[index + 1] << 8;
                if (unit === 0)
                {
                    return text.slice(0, limit);
                }
                text += String.fromCharCode(unit);
            }
            if (piece.length < 64)
            {
                break;
            }
        }
        return text.slice(0, limit);
    };

    /**
     * A string into a caller's buffer of `room` characters, cut to fit with
     * its terminator; nothing at all when there is no room or no buffer.
     *
     * @param {number} address @param {number} room @param {string} text
     * @param {boolean} wide
     */
    const writeText = (address, room, text, wide)=>{
        if ((address >>> 0) === 0 || (room >>> 0) === 0)
        {
            return;
        }
        const kept = text.slice(0, (room >>> 0) - 1);
        const bytes = new Uint8Array((kept.length + 1) * (wide ? 2 : 1));
        for (let at = 0; at < kept.length; at++)
        {
            if (wide)
            {
                bytes[at * 2] = kept.charCodeAt(at) & 0xff;
                bytes[at * 2 + 1] = kept.charCodeAt(at) >>> 8;
            }
            else
            {
                bytes[at] = kept.charCodeAt(at) & 0xff;
            }
        }
        host.writeMemory(address >>> 0, bytes);
    };

    /**
     * A family's GetErrorText, for either width: the codes it knows are the
     * shared ones and its own.
     *
     * @param {boolean} wide @param {Map<number, string>} texts
     */
    const errorText = (wide, texts)=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([error, buffer, room])=>{
            const text = texts.get(error >>> 0);
            if (text === undefined)
            {
                return MMSYSERR_BADERRNUM;
            }
            if ((room >>> 0) !== 0 && (buffer >>> 0) === 0)
            {
                return MMSYSERR_INVALPARAM;
            }
            writeText(buffer, room, text, wide);
            return MMSYSERR_NOERROR;
        },
    });

    /**
     * mciSendString, for either width.
     *
     * @param {boolean} wide
     */
    const sendString = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([command, buffer, room])=>{
            const answer = (command >>> 0) === 0
                ? { error: MCIERR_MISSING_COMMAND_STRING, text: '' }
                : mciString(wide ? wideAt(command, 1024) : ansiAt(command, 1024));
            writeText(buffer, room, answer.text, wide);
            return answer.error;
        },
    });

    /**
     * mciSendCommand, for either width: MCI_OPEN_PARMS is one layout, its
     * strings of the call's width.
     *
     * @param {boolean} wide
     */
    const sendCommand = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([, message, flags, parameters])=>{
            if ((message >>> 0) !== MCI_OPEN)
            {
                return MCIERR_INVALID_DEVICE_ID;
            }
            if ((parameters >>> 0) === 0)
            {
                return MCIERR_NULL_PARAMETER_BLOCK;
            }
            /** @param {number} offset */
            const field = offset=>u32(host.readMemory((parameters >>> 0) + offset, 4), 0);
            /** @param {number} address @param {number} limit */
            const text = (address, limit)=>(wide ? wideAt(address, limit) : ansiAt(address, limit));
            if ((flags & MCI_OPEN_TYPE) !== 0)
            {
                const type = field(8);
                if ((flags & MCI_OPEN_TYPE_ID) !== 0)
                {
                    const id = type & 0xffff;
                    return id >= MCI_DEVTYPE_FIRST && id <= MCI_DEVTYPE_LAST
                        ? MCIERR_CANNOT_LOAD_DRIVER : MCIERR_INVALID_DEVICE_NAME;
                }
                return openFailure(text(type, 128));
            }
            if ((flags & MCI_OPEN_ELEMENT) !== 0)
            {
                return openFailure(text(field(12), 260));
            }
            return MCIERR_MISSING_DEVICE_NAME;
        },
    });

    /**
     * mciGetErrorString, for either width.
     *
     * @param {boolean} wide
     */
    const errorString = wide=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([error, buffer, room])=>{
            const text = MCI_ERROR_TEXT.get(error >>> 0);
            if (text === undefined || (buffer >>> 0) === 0)
            {
                return 0;
            }
            writeText(buffer, room, text, wide);
            return 1;
        },
    });

    /** @param {number} handle */
    const deviceOf = handle=>devices.get(handle >>> 0) ?? null;

    /** @param {number} header @returns {number} */
    const flagsOf = header=>
        u32(host.readMemory(header + WAVEHDR.dwFlags, 4), 0);

    /** @param {number} header @param {number} flags */
    const setFlags = (header, flags)=>
        host.writeMemory(header + WAVEHDR.dwFlags, dword(flags >>> 0));

    /**
     * Records that the caller is owed a notification.
     *
     * Queued rather than delivered, because delivering may mean running guest
     * code and this is called from `settle`, which several entry points reach
     * through a synchronous helper. Only the entry point itself can wait for
     * guest code -- by returning a promise -- so only the entry point delivers.
     *
     * A callback-form WOM_DONE is the exception: it goes straight to the
     * thread that exists for it, which is where Windows delivers it, and never
     * waits for an entry point. The open and close notices stay on the caller,
     * because on Windows they are delivered inside the call that caused them.
     *
     * @param {WaveOut} device @param {number} message @param {number} param
     */
    const notice = (device, message, param)=>{
        const owed = {
            kind: device.callbackKind,
            target: device.callbackTarget,
            instance: device.callbackInstance,
            device: device.handle,
            message,
            param,
        };
        if (host.deliverDone && message === MM_WOM_DONE && owed.kind === CALLBACK_FUNCTION)
        {
            host.deliverDone(owed);
            return;
        }
        device.pending.push(owed);
    };

    /**
     * Delivers what `notice` queued, then answers what the entry point was
     * going to answer.
     *
     * The answer is a plain number while nothing has to wait and a promise once
     * something does. That shape is forced: the callback form runs guest code,
     * the bridge can only run guest code by parking the calling thread on a
     * promise, and a handler parks by *returning* one. The window, thread and
     * event forms are host-side bookkeeping and never wait, so a program using
     * one of those pays nothing and no thread is held at all.
     *
     * One notice at a time is the contract rather than an implementation
     * detail: a callback re-entered while it is still running would see a
     * program half way through refilling the buffer it was told about. A notice
     * queued by a nested call -- a callback that writes another buffer, which is
     * the usual shape -- is drained by the loop already running instead of
     * starting a second one, which also keeps that nested call from waiting on
     * the callback it is itself inside.
     *
     * @param {WaveOut} device @param {number} result
     * @param {boolean} [canRunGuest]  False from `tick`, which has no thread.
     * @returns {number | Promise<number>}
     */
    const flush = (device, result, canRunGuest = true)=>{
        const notify = host.notify;
        if (!notify || device.delivering)
        {
            return result;
        }
        device.delivering = true;
        // Read now, before the first notice suspends anything: every notice in
        // this burst belongs to the call being answered, and after an await the
        // thread on the processor is somebody else.
        const asked = host.currentThread?.() ?? null;
        for (;;)
        {
            const next = device.pending[0];
            // Stopping rather than skipping: these are delivered in the order
            // they happened, and a later one overtaking a deferred callback
            // would tell a program about the second buffer first.
            if (!next || (!canRunGuest && next.kind === CALLBACK_FUNCTION))
            {
                device.delivering = false;
                return result;
            }
            device.pending.shift();
            const answer = notify(next, asked);
            if (typeof (/** @type {any} */ (answer))?.then === 'function')
            {
                return (async()=>{
                    try
                    {
                        await answer;
                        for (let more = device.pending.shift(); more;
                            more = device.pending.shift())
                        {
                            await notify(more, asked);
                        }
                    }
                    finally
                    {
                        device.delivering = false;
                    }
                    return result;
                })();
            }
        }
    };

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
            // What the device actually played, in the guest's own bytes. Asked
            // for in those terms rather than converted from frames by the rate:
            // that conversion floors, so a buffer played in full reports back a
            // fraction short and never retires -- which is exactly how a sound
            // library's one-buffer probe of a device hangs for ever.
            //
            // Taken as a difference rather than as a position because the
            // cursor is relative to the head of the queue, which moves.
            const played = device.track.playedBytes
                ? device.track.playedBytes()
                : device.track.played() * device.bytesPerSecond / device.track.rate;
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
            // The flag is set before the notice is queued, and so before any
            // callback runs: a program told a buffer is back reads the flag to
            // find out which, and finding it clear would be a lie about the
            // buffer it was just handed.
            setFlags(done.header, flagsOf(done.header) & ~WHDR_INQUEUE | WHDR_DONE);
            device.retired++;
            device.bytesRetired += done.length;
            notice(device, MM_WOM_DONE, done.header);
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

    /**
     * An entry point whose first argument is a device handle, and which settles
     * that device before doing anything else.
     *
     * Settling is what retires a buffer, and a retired buffer owes its caller a
     * notification -- so every one of these answers through `flush`, and every
     * one of them may therefore answer with a promise rather than a number.
     *
     * @param {number} argBytes
     * @param {(device: WaveOut, args: number[]) => number} body
     */
    const onDevice = (argBytes, body)=>({
        argBytes,
        /** @param {number[]} args */
        handler: args=>{
            const device = deviceOf(args[0]);
            if (!device)
            {
                return MMSYSERR_INVALHANDLE;
            }
            settle(device);
            return flush(device, body(device, args));
        },
    });

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

    const unprepare = onDevice(12, (device, [, header])=>{
        const flags = flagsOf(header >>> 0);
        if ((flags & WHDR_INQUEUE) !== 0)
        {
            // Unpreparing a buffer the device still owns would let the caller
            // reuse memory that is about to be read.
            return WAVERR_STILLPLAYING;
        }
        setFlags(header >>> 0, flags & ~WHDR_PREPARED);
        return MMSYSERR_NOERROR;
    });

    /** Devices this build does not have. @param {number} argBytes @param {number} error */
    const noDevice = (argBytes, error)=>({ argBytes, handler: ()=>error });

    /** @param {number} argBytes */
    const noDevices = argBytes=>({ argBytes, handler: ()=>0 });

    /**
     * The one sound PlaySound plays at a time: starting another stops it.
     *
     * @type {{ track: any, pcm: Uint8Array, frames: number, loop: boolean } | null}
     */
    let playing = null;

    const stopSound = ()=>{
        playing?.track?.close();
        playing = null;
    };

    /**
     * PlaySound's body, shared with sndPlaySound: null stops what is playing,
     * a WAVE image in memory replaces it. Waiting for the sound to finish --
     * what a call without SND_ASYNC does -- is not done, and is reported.
     *
     * @param {number} sound @param {number} flags
     */
    const playSound = (sound, flags)=>{
        if ((sound >>> 0) === 0)
        {
            stopSound();
            return 1;
        }
        // SND_RESOURCE includes the SND_MEMORY bit, so it is told apart first.
        if ((flags & SND_RESOURCE) === SND_RESOURCE || (flags & SND_MEMORY) === 0)
        {
            host.divergence?.('PlaySound', (flags & SND_RESOURCE) === SND_RESOURCE
                ? 'a resource is not played'
                : (flags & SND_FILENAME) !== 0 ? 'a file is not played'
                    : 'a registry alias is not played');
            return 0;
        }
        // The RIFF header carries the image's own length, so the whole of it
        // can be read without the caller saying how much there is.
        const head = host.readMemory(sound >>> 0, 8);
        const wave = parseWave(host.readMemory(sound >>> 0, 8 + u32(head, 4)));
        if (!wave)
        {
            return 0;
        }
        stopSound();
        if ((flags & SND_ASYNC) === 0)
        {
            host.divergence?.('PlaySound', 'a synchronous call does not wait for the sound');
        }
        const track = host.output?.()?.open(wave.format) ?? null;
        if (track)
        {
            track.gain = gain();
        }
        playing = {
            track,
            pcm: wave.pcm,
            frames: track ? track.write(wave.pcm) : 0,
            loop: (flags & SND_LOOP) !== 0,
        };
        return 1;
    };

    const table = {
        /**
         * DWORD timeGetTime(void)
         *
         * The guest's own clock. A frame loop divides by the difference between
         * two of these, so it must be the clock that advances with the guest.
         * Where kernel32 keeps its clock block the export is GetTickCount's
         * routine in the guest instead (`win32/module.js`); this answers for a
         * build without one, and is the reference that routine keeps to.
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

        /**
         * MMRESULT timeSetEvent(UINT uDelay, UINT uResolution, LPTIMECALLBACK lpTimeProc,
         *                       DWORD_PTR dwUser, UINT fuEvent)
         * MMRESULT timeKillEvent(UINT uTimerID)
         *
         * The timer's routine runs on the timer thread (`timers.js`), never
         * on the caller; the resolution is accepted and not honoured beyond
         * the clock's own millisecond.
         */
        timeSetEvent: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([delay, , proc, user, flags])=>
                host.timers ? host.timers.set(delay >>> 0, proc >>> 0, user >>> 0, flags >>> 0) : 0,
        },
        timeKillEvent: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([id])=>(host.timers ? host.timers.kill(id >>> 0) : MMSYSERR_INVALPARAM),
        },
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

        /**
         * MMRESULT timeGetDevCaps(LPTIMECAPS ptc, UINT cbtc)
         *
         * The periods timeSetEvent takes, one millisecond to MAX_PERIOD: the
         * clock has no finer grain than that, and a longer delay is refused.
         */
        timeGetDevCaps: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([caps, size])=>{
                if ((caps >>> 0) === 0 || (size >>> 0) < 8)
                {
                    return TIMERR_NOCANDO;
                }
                host.writeMemory(caps >>> 0, dword(1));
                host.writeMemory((caps >>> 0) + 4, dword(MAX_PERIOD));
                return MMSYSERR_NOERROR;
            },
        },

        /** UINT waveOutGetNumDevs(void) */
        waveOutGetNumDevs: { argBytes: 0, handler: ()=>1 },

        /**
         * MMRESULT waveOutGetVolume(HWAVEOUT hwo, LPDWORD pdwVolume)
         * MMRESULT waveOutSetVolume(HWAVEOUT hwo, DWORD dwVolume)
         *
         * One level, the low word, for the one device whichever handle or id
         * names it, and read back in both words as a device without separate
         * left and right control reports it.
         */
        waveOutGetVolume: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwo, out])=>{
                const target = volumeTarget(hwo);
                if (target !== MMSYSERR_NOERROR)
                {
                    return target;
                }
                if ((out >>> 0) === 0)
                {
                    return MMSYSERR_INVALPARAM;
                }
                const level = volume & 0xffff;
                host.writeMemory(out >>> 0, dword(level | level << 16));
                return MMSYSERR_NOERROR;
            },
        },
        waveOutSetVolume: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([hwo, level])=>{
                const target = volumeTarget(hwo);
                if (target !== MMSYSERR_NOERROR)
                {
                    return target;
                }
                volume = level >>> 0;
                for (const device of devices.values())
                {
                    if (device.track)
                    {
                        device.track.gain = gain();
                    }
                }
                if (playing?.track)
                {
                    playing.track.gain = gain();
                }
                return MMSYSERR_NOERROR;
            },
        },

        /**
         * MMRESULT waveOutGetErrorTextA(MMRESULT mmrError, LPSTR pszText, UINT cchText)
         * MMRESULT waveOutGetErrorTextW(MMRESULT, LPWSTR, UINT)
         *
         * waveIn's pair is this pair under another name, and midiIn's is
         * midiOut's: winmm exports each as the other.
         */
        waveOutGetErrorTextA: errorText(false, WAVE_ERROR_TEXT),
        waveOutGetErrorTextW: errorText(true, WAVE_ERROR_TEXT),
        waveInGetErrorTextA: errorText(false, WAVE_ERROR_TEXT),
        waveInGetErrorTextW: errorText(true, WAVE_ERROR_TEXT),
        midiOutGetErrorTextA: errorText(false, MIDI_ERROR_TEXT),
        midiOutGetErrorTextW: errorText(true, MIDI_ERROR_TEXT),
        midiInGetErrorTextA: errorText(false, MIDI_ERROR_TEXT),
        midiInGetErrorTextW: errorText(true, MIDI_ERROR_TEXT),

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
        waveOutGetID: onDevice(8, (device, [, out])=>{
            host.writeMemory(out >>> 0, dword(0));
            return MMSYSERR_NOERROR;
        }),

        /**
         * MMRESULT waveOutGetPosition(HWAVEOUT hwo, LPMMTIME pmmt, UINT cbmmt)
         *
         * Where the cursor has reached. This is what a program polls when it
         * does not wait on anything, and polling it is what moves the cursor at
         * all -- there is no interrupt here, so time is credited to the device
         * whenever the device is asked about.
         */
        waveOutGetPosition: onDevice(12, (device, [, time, size])=>{
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
        }),

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
                /** @type {WaveOut} */
                const opened = {
                    handle,
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
                    pending: [],
                    delivering: false,
                    written: 0,
                    retired: 0,
                    bytesWritten: 0,
                    bytesRetired: 0,
                };
                if (opened.track)
                {
                    opened.track.gain = gain();
                }
                devices.set(handle, opened);
                // The handle reaches the caller before the open notice does: the
                // callback is handed that same handle and a program may use it
                // straight away, so the variable it is going to read had better
                // already hold it.
                host.writeMemory(out >>> 0, dword(handle));
                notice(opened, MM_WOM_OPEN, 0);
                return flush(opened, MMSYSERR_NOERROR);
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
        waveOutWrite: onDevice(12, (device, [, header, size])=>{
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
            device.written++;
            device.bytesWritten += length;
            // The bytes are copied out now rather than referred to. The buffer
            // stays the caller's and it is entitled to refill it the moment the
            // header comes back, which is long before the sound in it has been
            // heard.
            if (device.track && length > 0)
            {
                const data = u32(host.readMemory(at + WAVEHDR.lpData, 4), 0);
                device.track.write(host.readMemory(data, length));
            }
            return MMSYSERR_NOERROR;
        }),

        /** MMRESULT waveOutPause / waveOutRestart */
        waveOutPause: onDevice(4, device=>{
            device.paused = true;
            if (device.track)
            {
                device.track.paused = true;
            }
            return MMSYSERR_NOERROR;
        }),
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
                    device.retired++;
                    device.bytesRetired += queued.length;
                    notice(device, MM_WOM_DONE, queued.header);
                }
                device.queue = [];
                device.playedBytes = 0;
                device.trackBytes = 0;
                device.track?.reset();
                device.sinceMs = host.now();
                // The whole queue comes back at once, so this is where a
                // callback form is held longest -- one guest call per buffer,
                // in order, before the reset answers.
                return flush(device, MMSYSERR_NOERROR);
            },
        },

        /** MMRESULT waveOutClose(HWAVEOUT hwo) */
        waveOutClose: onDevice(4, (device, [handle])=>{
            if (device.queue.length > 0)
            {
                // Documented, and a program depends on it: it closes, sees
                // this, resets, and closes again.
                return WAVERR_STILLPLAYING;
            }
            device.track?.close();
            devices.delete(handle >>> 0);
            notice(device, MM_WOM_CLOSE, 0);
            return MMSYSERR_NOERROR;
        }),

        /**
         * BOOL PlaySoundA(LPCSTR pszSound, HMODULE hmod, DWORD fdwSound)
         * BOOL sndPlaySoundA(LPCSTR pszSound, UINT fuSound)
         */
        PlaySoundA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([sound, , flags])=>playSound(sound, flags >>> 0),
        },
        sndPlaySoundA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([sound, flags])=>playSound(sound, flags >>> 0),
        },

        /**
         * Recording. There is no capture device, and saying so is what lets a
         * program fall back; the rest of the wave-in surface then answers on a
         * handle nothing ever opened.
         */
        waveInGetNumDevs: { argBytes: 0, handler: ()=>0 },
        waveInGetDevCapsA: noDevice(12, MMSYSERR_BADDEVICEID),
        waveInOpen: noDevice(24, MMSYSERR_BADDEVICEID),
        waveInPrepareHeader: noDevice(12, MMSYSERR_INVALHANDLE),
        waveInUnprepareHeader: noDevice(12, MMSYSERR_INVALHANDLE),
        waveInAddBuffer: noDevice(12, MMSYSERR_INVALHANDLE),
        waveInStart: noDevice(4, MMSYSERR_INVALHANDLE),
        waveInReset: noDevice(4, MMSYSERR_INVALHANDLE),
        waveInClose: noDevice(4, MMSYSERR_INVALHANDLE),

        /** Midi in: no port to record from. */
        midiInGetNumDevs: { argBytes: 0, handler: ()=>0 },
        midiInOpen: noDevice(20, MMSYSERR_BADDEVICEID),
        midiInGetDevCapsA: noDevice(12, MMSYSERR_BADDEVICEID),
        midiInGetDevCapsW: noDevice(12, MMSYSERR_BADDEVICEID),
        midiInClose: noDevice(4, MMSYSERR_INVALHANDLE),
        midiInStart: noDevice(4, MMSYSERR_INVALHANDLE),
        midiInStop: noDevice(4, MMSYSERR_INVALHANDLE),
        midiInReset: noDevice(4, MMSYSERR_INVALHANDLE),
        midiInAddBuffer: noDevice(12, MMSYSERR_INVALHANDLE),
        midiInPrepareHeader: noDevice(12, MMSYSERR_INVALHANDLE),
        midiInUnprepareHeader: noDevice(12, MMSYSERR_INVALHANDLE),
        midiInGetID: noDevice(8, MMSYSERR_INVALHANDLE),
        midiInMessage: noDevice(16, MMSYSERR_INVALHANDLE),

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

        /**
         * MCI, which drives CD audio and video among other things. No MCI
         * device is ever open here, so a command to a device id finds none,
         * and an open fails the way it fails where the driver has nothing to
         * drive.
         */
        mciSendCommandA: sendCommand(false),
        mciSendCommandW: sendCommand(true),

        /**
         * MCIERROR mciSendStringA(LPCSTR lpszCommand, LPSTR lpszReturnString,
         *                         UINT cchReturn, HWND hwndCallback)
         * MCIERROR mciSendStringW(LPCWSTR, LPWSTR, UINT, HWND)
         *
         * The string form of the same machine: what it answers is written to
         * the caller's buffer, and an error leaves the buffer empty.
         */
        mciSendStringA: sendString(false),
        mciSendStringW: sendString(true),

        /**
         * MCIDEVICEID mciGetDeviceIDA(LPCSTR pszDevice)
         * MCIDEVICEID mciGetDeviceIDW(LPCWSTR pszDevice)
         *
         * No device of any name is open, and `all` is every device's id.
         */
        mciGetDeviceIDA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([name])=>((name >>> 0) === 0 ? 0 : deviceIdOf(ansiAt(name, 128))),
        },
        mciGetDeviceIDW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([name])=>((name >>> 0) === 0 ? 0 : deviceIdOf(wideAt(name, 128))),
        },
        /**
         * MCIDEVICEID mciGetDeviceIDFromElementIDA(DWORD dwElementID, LPCSTR lpstrType)
         * MCIDEVICEID mciGetDeviceIDFromElementIDW(DWORD, LPCWSTR)
         *
         * An element id belongs to a device that opened it, and none is open.
         */
        mciGetDeviceIDFromElementIDA: { argBytes: 8, handler: ()=>0 },
        mciGetDeviceIDFromElementIDW: { argBytes: 8, handler: ()=>0 },

        /**
         * BOOL mciGetErrorStringA(MCIERROR mcierr, LPSTR pszText, UINT cchText)
         * BOOL mciGetErrorStringW(MCIERROR, LPWSTR, UINT)
         *
         * TRUE with the text of an MCI error, cut to the buffer; FALSE, and
         * the buffer left alone, for a code MCI has no text for.
         */
        mciGetErrorStringA: errorString(false),
        mciGetErrorStringW: errorString(true),

        /**
         * Joysticks. The input layer is a stub, so there are none -- and a
         * program polling one it was told about would read the same neutral
         * position for ever without knowing why.
         */
        joyGetNumDevs: noDevices(0),
        joyGetDevCapsA: { argBytes: 12, handler: ()=>JOYERR_PARMS },
        joyGetPosEx: { argBytes: 8, handler: ()=>JOYERR_PARMS },
        joyGetPos: { argBytes: 8, handler: ()=>JOYERR_PARMS },
    };

    return {
        table,

        /**
         * Moves every open device's cursor, from outside any guest call.
         *
         * This is what a device driver's interrupt does and there is nothing
         * here that does it otherwise: the cursor only advances inside `settle`,
         * and `settle` is only reached from an entry point. A program that waits
         * for a buffer by spinning on WHDR_DONE in its own header -- which is a
         * normal thing to write, because on Windows the flag is set by somebody
         * else's thread -- calls nothing while it spins, so without this the
         * flag it is waiting for can never be set and the wait is a deadlock by
         * construction. Whoever drives the machine calls this on its own
         * schedule; the cost is one pass over the open devices.
         *
         * The flag is set here, and so is the notification: the window and
         * event forms are host-side, and a callback-form WOM_DONE has a thread
         * of its own to run on. Only a build without that thread has to hold a
         * callback back, because then the one place it can run is inside the
         * next entry point the program calls.
         */
        tick(){
            for (const device of devices.values())
            {
                settle(device);
                flush(device, MMSYSERR_NOERROR, false);
            }
            // A looped sound is fed a copy ahead of the one being heard, so
            // the seam between two falls where the file's own end is.
            if (playing?.loop && playing.track && playing.track.pending() < playing.frames)
            {
                playing.track.write(playing.pcm);
            }
        },

        /**
         * What every open device is doing, for whoever is measuring.
         *
         * A program that stops because a buffer did not come back is silent
         * about it -- it is inside its own wait, and from outside the whole
         * machine merely looks slow. These are the figures that tell the two
         * apart, and each is here because its absence has cost time:
         *
         * - `cursor` says which of the two clocks is driving this device. The
         *   two paths behave differently and only one of them is exercised by a
         *   page with the sound off, so a defect that only appears with a real
         *   device is invisible until this says which one ran.
         * - `written` against `retired` is the stall itself: a program hands
         *   over buffers and waits for them back, and a gap that stops closing
         *   is the failure, whatever caused it.
         * - `owed` and `deferred` say the buffer *did* come back and the
         *   program has not been told. With the notice thread this is only
         *   ever the open and close notices between a call and its answer.
         *   Without it a callback waits for the next winmm call the program
         *   makes, a program that made its last one is never told again, and
         *   `deferred` with a growing `owed` is exactly that shape.
         */
        diagnostics: ()=>[...devices.values()].map(device=>({
            handle: device.handle,
            cursor: device.track ? 'device' : 'clock',
            bytesPerSecond: device.bytesPerSecond,
            paused: device.paused,
            queued: device.queue.length,
            written: device.written,
            retired: device.retired,
            bytesWritten: device.bytesWritten,
            bytesRetired: device.bytesRetired,
            owed: device.pending.length,
            deferred: device.pending[0]?.kind === CALLBACK_FUNCTION,
        })),
    };
}
