/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * MCI's `waveaudio` device as its command set documents it: a WAVE file
 * opened under an alias, or a new empty one, played from and to a position in
 * the time format set (milliseconds, bytes or samples), stopped, paused,
 * resumed and sought, its status and capabilities answered. Playing goes to
 * the same output waveOut and PlaySound play to (`host.output`); the file is
 * read and decoded once, by `parseWave`, when it is opened.
 *
 * There is no capture device here, so recording answers
 * MCIERR_WAVE_INPUTSUNSUITABLE, as a machine with sound input disabled does,
 * and a new file stays empty; `save` and `delete` are said and refused.
 */

import { parseWave } from './wave.js';

export const MCIERR_UNRECOGNIZED_KEYWORD = 259;
export const MCIERR_BAD_INTEGER = 270;
export const MCIERR_MISSING_PARAMETER = 273;
export const MCIERR_UNSUPPORTED_FUNCTION = 274;
export const MCIERR_FILE_NOT_FOUND = 275;
export const MCIERR_OUTOFRANGE = 282;
export const MCIERR_BAD_CONSTANT = 290;
export const MCIERR_INVALID_FILE = 296;
export const MCIERR_NONAPPLICABLE_FUNCTION = 302;
export const MCIERR_WAVE_INPUTSUNSUITABLE = 328;

/** MCI_FORMAT_* as `set ... time format` names them and `status` reports them. */
const TIME_FORMATS = new Map([
    ['milliseconds', 0], ['ms', 0], ['bytes', 8], ['samples', 9],
]);
const TIME_FORMAT_NAMES = new Map([[0, 'milliseconds'], [8, 'bytes'], [9, 'samples']]);

/** MCI_STATUS_* items, by the number a command string may name them by too. */
const STATUS_ITEMS = new Map([
    ['1', 'length'], ['2', 'position'], ['3', 'number of tracks'], ['4', 'mode'],
    ['5', 'media present'], ['6', 'time format'], ['7', 'ready'], ['8', 'current track'],
]);

/**
 * An integer as MCI's parser reads one: decimal, or up to four colon-separated
 * bytes, least significant first (`220:5` is 220 + 5 * 256); no hexadecimal.
 *
 * @param {string | undefined} word
 * @returns {number | null}
 */
export function mciInteger(word){
    if (word === undefined)
    {
        return null;
    }
    if (/^-?\d+$/.test(word))
    {
        return Number.parseInt(word, 10);
    }
    const parts = word.split(':');
    if (parts.length > 4 || !parts.every(part=>/^\d*$/.test(part)) || parts.every(p=>p === ''))
    {
        return null;
    }
    let value = 0;
    for (let at = 0; at < parts.length; at++)
    {
        const part = parts[at] === '' ? 0 : Number.parseInt(parts[at], 10);
        if (part > 255)
        {
            return null;
        }
        value += part * 2 ** (8 * at);
    }
    return value;
}

/**
 * @typedef {Object} WaveDevice
 * @property {Uint8Array} pcm
 * @property {import('./wave.js').WaveFormat} format
 * @property {string} file  the element opened, '' for a new one
 * @property {number} timeFormat  MCI_FORMAT_*
 * @property {number} position  in milliseconds
 * @property {'stopped' | 'playing' | 'paused'} mode
 * @property {any} track
 * @property {number} startedAt  the clock when play began, in milliseconds
 * @property {number} from  where play began, in milliseconds
 * @property {number} to  where play ends, in milliseconds
 * @property {(() => void) | null} ended  run when play reaches `to`
 */

/**
 * @typedef {Object} MciWaveHost
 * @property {() => number} now  the guest's clock, in milliseconds
 * @property {(path: string) => Promise<Uint8Array | null> | Uint8Array | null} [readFile]
 * @property {() => any} [output]  the mixer, or null when nothing is listening
 * @property {(api: string, detail: string) => void} [divergence]
 */

/** @param {MciWaveHost} host */
export function createMciWave(host){
    /** @param {WaveDevice} device */
    const bytesPerMs = device=>device.format.sampleRate * device.format.channels
        * (device.format.bitsPerSample / 8) / 1000;
    /** @param {WaveDevice} device */
    const length = device=>Math.floor(device.pcm.length / bytesPerMs(device));

    /** @param {WaveDevice} device @param {number} ms */
    const toFormat = (device, ms)=>(device.timeFormat === 8
        ? Math.round(ms * bytesPerMs(device))
        : device.timeFormat === 9 ? Math.round(ms * device.format.sampleRate / 1000) : ms);
    /** @param {WaveDevice} device @param {number} value */
    const fromFormat = (device, value)=>(device.timeFormat === 8
        ? value / bytesPerMs(device)
        : device.timeFormat === 9 ? value * 1000 / device.format.sampleRate : value);

    /** @param {WaveDevice} device */
    const where = device=>(device.mode === 'playing'
        ? Math.min(device.to, device.from + (host.now() - device.startedAt))
        : device.position);

    /** @param {WaveDevice} device */
    const halt = device=>{
        device.position = where(device);
        device.track?.close();
        device.track = null;
        device.mode = device.mode === 'playing' ? 'stopped' : device.mode;
        device.ended = null;
    };

    /**
     * Plays from `from` to `to` (milliseconds): the slice of the file between
     * goes to the output, and the device plays on the clock until `to`.
     *
     * @param {WaveDevice} device @param {number} from @param {number} to
     */
    const start = (device, from, to)=>{
        halt(device);
        const perMs = bytesPerMs(device);
        const align = Math.max(1, device.format.channels * device.format.bitsPerSample / 8);
        const first = Math.floor(from * perMs / align) * align;
        const last = Math.floor(to * perMs / align) * align;
        const track = host.output?.()?.open(device.format) ?? null;
        track?.write(device.pcm.subarray(first, last));
        Object.assign(device, { track, mode: 'playing', startedAt: host.now(), from, to,
            position: from });
    };

    /**
     * The value after a keyword in a command's words.
     *
     * @param {string[]} words @param {string} keyword
     */
    const after = (words, keyword)=>{
        const at = words.indexOf(keyword);
        return at >= 0 ? words[at + 1] : undefined;
    };

    /** @param {WaveDevice} device @param {string[]} words */
    const status = (device, words)=>{
        if (words.length === 0)
        {
            return { error: MCIERR_MISSING_PARAMETER };
        }
        if (words[0] === 'track')
        {
            return { error: mciInteger(words[1]) === null ? MCIERR_BAD_INTEGER
                : MCIERR_MISSING_PARAMETER };
        }
        const item = STATUS_ITEMS.get(words[0]) ?? words.join(' ');
        const format = device.format;
        /** @type {Record<string, string>} */
        const answers = {
            'length': String(toFormat(device, length(device))),
            'position': String(toFormat(device, where(device))),
            'start position': '0',
            'number of tracks': '1',
            'current track': '1',
            'mode': device.mode,
            'media present': 'true',
            'ready': 'true',
            'time format': TIME_FORMAT_NAMES.get(device.timeFormat) ?? 'milliseconds',
            'samplespersec': String(format.sampleRate),
            'channels': String(format.channels),
            'bitspersample': String(format.bitsPerSample),
            'bytespersec': String(Math.round(bytesPerMs(device) * 1000)),
            'alignment': String(format.channels * format.bitsPerSample / 8),
            'format tag': format.float ? '3' : 'pcm',
            'input': 'none',
            'output': 'Wave Mapper',
            'level': '0',
        };
        const text = answers[item];
        return text === undefined ? { error: MCIERR_BAD_CONSTANT } : { error: 0, text };
    };

    /** @param {WaveDevice} device @param {string[]} words */
    const set = (device, words)=>{
        for (let at = 0; at < words.length;)
        {
            if (words[at] === 'time' && words[at + 1] === 'format')
            {
                const name = words[at + 2];
                const format = TIME_FORMATS.get(name ?? '')
                    ?? ([0, 8, 9].includes(mciInteger(name) ?? -1) ? mciInteger(name) : null);
                if (format === null || format === undefined)
                {
                    return { error: MCIERR_BAD_CONSTANT };
                }
                device.timeFormat = format;
                at += 3;
                continue;
            }
            const value = mciInteger(words[at + 1]);
            const wave = ['samplespersec', 'channels', 'bitspersample', 'bytespersec',
                'alignment'].includes(words[at]);
            if (words[at] === 'format' && words[at + 1] === 'tag')
            {
                at += 3;
                continue;
            }
            if (!wave)
            {
                return { error: MCIERR_UNRECOGNIZED_KEYWORD };
            }
            if (device.file !== '' || device.pcm.length > 0)
            {
                return { error: MCIERR_NONAPPLICABLE_FUNCTION };
            }
            if (value === null)
            {
                return { error: MCIERR_BAD_INTEGER };
            }
            if (words[at] === 'bitspersample' && value !== 8 && value !== 16)
            {
                return { error: MCIERR_OUTOFRANGE };
            }
            const key = /** @type {Record<string, 'sampleRate' | 'channels' | 'bitsPerSample'>} */ (
                { samplespersec: 'sampleRate', channels: 'channels',
                    bitspersample: 'bitsPerSample' })[words[at]];
            if (key)
            {
                device.format = { ...device.format, [key]: value };
            }
            at += 2;
        }
        return { error: 0 };
    };

    /** @param {string[]} words */
    const capability = words=>{
        /** @type {Record<string, string>} */
        const answers = {
            'can play': 'true', 'can record': 'false', 'can save': 'true', 'can eject': 'false',
            'compound device': 'true', 'device type': 'waveaudio', 'has audio': 'true',
            'has video': 'false', 'uses files': 'true', 'inputs': '0', 'outputs': '1',
        };
        const text = answers[words.join(' ')];
        return text === undefined ? { error: MCIERR_BAD_CONSTANT } : { error: 0, text };
    };

    /**
     * `play [from x] [to y]`: refused when the range runs backwards or past
     * the end, or when, with no `from`, it ends before where the device is.
     *
     * @param {WaveDevice} device @param {string[]} words @param {boolean} wait
     * @param {() => void} done
     */
    const play = (device, words, wait, done)=>{
        const end = length(device);
        const fromWord = after(words, 'from');
        const toWord = after(words, 'to');
        const fromValue = fromWord === undefined ? null : mciInteger(fromWord);
        const toValue = toWord === undefined ? null : mciInteger(toWord);
        if ((fromWord !== undefined && fromValue === null)
            || (toWord !== undefined && toValue === null))
        {
            return { error: MCIERR_BAD_INTEGER };
        }
        const from = fromValue === null ? where(device) : fromFormat(device, fromValue);
        const to = toValue === null ? end : fromFormat(device, toValue);
        if (from > end || to > end || to < from)
        {
            return { error: MCIERR_OUTOFRANGE };
        }
        start(device, from, to);
        if (!wait)
        {
            device.ended = done;
            return { error: 0 };
        }
        return new Promise(resolve=>{
            device.ended = ()=>{
                done();
                resolve({ error: 0 });
            };
        });
    };

    return {
        type: 'waveaudio',

        /**
         * Opens a WAVE file, or a new empty one for an element of `new` or
         * none. A shareable waveaudio device is not supported.
         *
         * @param {string} file @param {string[]} words
         * @returns {Promise<{ error: number, device?: WaveDevice }>
         *     | { error: number, device?: WaveDevice }}
         */
        open(file, words){
            if (words.some(word=>word.toLowerCase() === 'shareable'))
            {
                return { error: MCIERR_UNSUPPORTED_FUNCTION };
            }
            /** @param {Uint8Array} pcm @param {WaveDevice['format']} format @param {string} name */
            const made = (pcm, format, name)=>({ error: 0, device: /** @type {WaveDevice} */ ({
                pcm, format, file: name, timeFormat: 0, position: 0, mode: 'stopped', track: null,
                startedAt: 0, from: 0, to: 0, ended: null }) });
            if (file === '' || file.toLowerCase() === 'new')
            {
                // A new file records in the device's default format.
                return made(new Uint8Array(0), { sampleRate: 11025, channels: 1, bitsPerSample: 8 },
                    '');
            }
            const read = (/** @type {Uint8Array | null} */ bytes)=>{
                if (!bytes)
                {
                    return { error: MCIERR_FILE_NOT_FOUND };
                }
                const wave = parseWave(bytes);
                return wave ? made(wave.pcm, wave.format, file) : { error: MCIERR_INVALID_FILE };
            };
            const bytes = host.readFile?.(file) ?? null;
            return bytes instanceof Promise ? bytes.then(read) : read(bytes);
        },

        /**
         * Every command but `open` on a device of this driver; `words` are
         * lower case, `wait` and `notify` taken off.
         *
         * @param {string} verb @param {WaveDevice} device @param {string[]} words
         * @param {{ wait: boolean, done: () => void }} how
         * @returns {{ error: number, text?: string } | Promise<{ error: number, text?: string }>}
         */
        command(verb, device, words, how){
            switch (verb)
            {
                case 'status':
                    return status(device, words);
                case 'set':
                    return set(device, words);
                case 'capability':
                    return capability(words);
                case 'info':
                    if (words[0] === 'file')
                    {
                        return device.file === '' ? { error: MCIERR_NONAPPLICABLE_FUNCTION }
                            : { error: 0, text: device.file };
                    }
                    return { error: 0, text: words[0] === 'product' ? 'Wave Audio' : '' };
                case 'play':
                    return play(device, words, how.wait, how.done);
                case 'stop':
                    halt(device);
                    device.mode = 'stopped';
                    return { error: 0 };
                case 'pause':
                    if (device.mode !== 'playing')
                    {
                        return { error: device.mode === 'paused' ? 0
                            : MCIERR_NONAPPLICABLE_FUNCTION };
                    }
                    halt(device);
                    device.mode = 'paused';
                    return { error: 0 };
                case 'resume':
                    if (device.mode === 'paused')
                    {
                        start(device, device.position, device.to || length(device));
                    }
                    return { error: 0 };
                case 'seek': {
                    halt(device);
                    device.mode = 'stopped';
                    const to = words[0] === 'to' ? words[1] : undefined;
                    if (to === 'start' || words[0] === 'start')
                    {
                        device.position = 0;
                        return { error: 0 };
                    }
                    if (to === 'end' || words[0] === 'end')
                    {
                        device.position = length(device);
                        return { error: 0 };
                    }
                    const value = mciInteger(to);
                    if (value === null)
                    {
                        return { error: MCIERR_BAD_INTEGER };
                    }
                    const ms = fromFormat(device, value);
                    if (ms > length(device))
                    {
                        return { error: MCIERR_OUTOFRANGE };
                    }
                    device.position = ms;
                    return { error: 0 };
                }
                case 'cue':
                    return { error: device.mode === 'playing' ? MCIERR_NONAPPLICABLE_FUNCTION : 0 };
                case 'record':
                    return { error: MCIERR_WAVE_INPUTSUNSUITABLE };
                case 'save':
                case 'delete':
                    host.divergence?.('MCI', `the waveaudio device does not ${verb} a file`);
                    return { error: MCIERR_UNSUPPORTED_FUNCTION };
                default:
                    return { error: MCIERR_UNSUPPORTED_FUNCTION };
            }
        },

        /** @param {WaveDevice} device */
        close(device){
            halt(device);
        },

        /**
         * Settles play that has reached its end: the device stops and its
         * notification goes out.
         *
         * @param {WaveDevice} device
         * @returns {boolean} whether the play ended now
         */
        settle(device){
            if (device.mode === 'playing' && where(device) >= device.to)
            {
                const ended = device.ended;
                halt(device);
                device.mode = 'stopped';
                ended?.();
                return true;
            }
            return false;
        },
    };
}
