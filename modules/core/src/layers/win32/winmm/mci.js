/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * MCI itself: the devices a process has open, by id and by alias, and the two
 * ways a program talks to them. A command string is the canonical form here:
 * its verb, its device and its keywords; mciSendCommand's messages and
 * parameter blocks are turned into that string's words and answered by the
 * same path, its answer turned back into the block's fields. What every
 * device shares - opening and naming, `close`, `sysinfo`, the `all` device,
 * `notify` and `wait` - is answered here; the rest goes to the driver of the
 * device's type: `waveaudio` (`mci-wave.js`) and the digital-video devices
 * (`mci-video.js`). Any other type a Windows install registers a driver for
 * fails to load it, as on a machine without that hardware.
 */

/** MCI's error space, MCIERR_BASE (256) up. */
const MCIERR_INVALID_DEVICE_ID = 257;
const MCIERR_UNRECOGNIZED_KEYWORD = 259;
const MCIERR_UNRECOGNIZED_COMMAND = 261;
const MCIERR_HARDWARE = 262;
const MCIERR_INVALID_DEVICE_NAME = 263;
const MCIERR_CANNOT_LOAD_DRIVER = 266;
const MCIERR_MISSING_COMMAND_STRING = 267;
const MCIERR_PARAM_OVERFLOW = 268;
const MCIERR_UNSUPPORTED_FUNCTION = 274;
const MCIERR_CANNOT_USE_ALL = 279;
const MCIERR_MULTIPLE = 280;
const MCIERR_EXTENSION_NOT_FOUND = 281;
const MCIERR_DEVICE_TYPE_REQUIRED = 287;
const MCIERR_DUPLICATE_ALIAS = 289;
const MCIERR_MISSING_DEVICE_NAME = 292;
const MCIERR_NULL_PARAMETER_BLOCK = 297;
const MCIERR_NEW_REQUIRES_ALIAS = 299;
const MCIERR_NOTIFY_ON_AUTO_OPEN = 300;

/** The id `all` names: every open device at once. */
export const MCI_ALL_DEVICE_ID = 0xffffffff;

const MM_MCINOTIFY = 0x03b9;
const MCI_NOTIFY_SUCCESSFUL = 1;
const MCI_NOTIFY_ABORTED = 4;

/** The device types by MCI_DEVTYPE_* id, 0x201 up: what `sysinfo` and MCI_OPEN_TYPE_ID name. */
const DEVICE_TYPES = ['vcr', 'videodisc', 'overlay', 'cdaudio', 'dat', 'scanner', 'animation',
    'digitalvideo', 'other', 'waveaudio', 'sequencer'];
const MCI_DEVTYPE_FIRST = 0x201;

/** The types a driver is registered for; `avivideo` and `mpegvideo` are digital video. */
const REGISTERED_TYPES = new Set([...DEVICE_TYPES, 'avivideo', 'mpegvideo']);
/** The file extensions a registered driver opens by itself, and which type that is. */
const EXTENSION_TYPES = new Map([
    ['wav', 'waveaudio'], ['avi', 'avivideo'], ['mid', 'sequencer'], ['midi', 'sequencer'],
    ['rmi', 'sequencer'], ['cda', 'cdaudio'], ['mpg', 'mpegvideo'], ['mpeg', 'mpegvideo'],
    ['mp3', 'mpegvideo'], ['mp2', 'mpegvideo'], ['mpa', 'mpegvideo'], ['m1v', 'mpegvideo'],
    ['mpe', 'mpegvideo'], ['asf', 'mpegvideo'], ['wma', 'mpegvideo'], ['wmv', 'mpegvideo'],
    ['aif', 'mpegvideo'], ['aifc', 'mpegvideo'], ['aiff', 'mpegvideo'], ['au', 'mpegvideo'],
    ['snd', 'mpegvideo'],
]);

/** The verbs MCI's core command table carries, which any device takes. */
const CORE_VERBS = new Set(['break', 'capability', 'close', 'info', 'load', 'open', 'pause',
    'play', 'record', 'resume', 'save', 'seek', 'set', 'sound', 'status', 'stop', 'sysinfo']);
/** The verbs a device's own table adds. */
const DEVICE_VERBS = new Set(['capture', 'configure', 'copy', 'cue', 'cut', 'delete', 'escape',
    'freeze', 'list', 'monitor', 'paste', 'put', 'quality', 'realize', 'reserve', 'restore',
    'setaudio', 'setvideo', 'signal', 'spin', 'step', 'undo', 'unfreeze', 'update', 'where',
    'window']);

/** mciSendCommand's messages, and the flags every one takes. */
const MCI_OPEN = 0x0803;
const MCI_CLOSE = 0x0804;
const MCI_PLAY = 0x0806;
const MCI_SEEK = 0x0807;
const MCI_STOP = 0x0808;
const MCI_PAUSE = 0x0809;
const MCI_INFO = 0x080a;
const MCI_GETDEVCAPS = 0x080b;
const MCI_SET = 0x080d;
const MCI_SYSINFO = 0x0810;
const MCI_STATUS = 0x0814;
const MCI_CUE = 0x0830;
const MCI_RESUME = 0x0855;
const MCI_NOTIFY = 0x1;
const MCI_WAIT = 0x2;
const MCI_FROM = 0x4;
const MCI_TO = 0x8;

/** The answers a status item has as numbers in a parameter block. */
const MODES = new Map([['not ready', 524], ['stopped', 525], ['playing', 526],
    ['recording', 527], ['seeking', 528], ['paused', 529], ['open', 530]]);
const TIME_FORMAT_IDS = new Map([['milliseconds', 0], ['bytes', 8], ['samples', 9]]);
const STATUS_KEYWORDS = new Map([[1, 'length'], [2, 'position'], [3, 'number of tracks'],
    [4, 'mode'], [5, 'media present'], [6, 'time format'], [7, 'ready'], [8, 'current track'],
    [0x4001, 'input'], [0x4002, 'output'], [0x4003, 'format tag'], [0x4004, 'channels'],
    [0x4005, 'samplespersec'], [0x4006, 'bytespersec'], [0x4007, 'alignment'],
    [0x4008, 'bitspersample'], [0x4009, 'level']]);
const CAPABILITY_KEYWORDS = new Map([[1, 'can record'], [2, 'has audio'], [3, 'has video'],
    [4, 'device type'], [5, 'uses files'], [6, 'compound device'], [7, 'can eject'],
    [8, 'can play'], [9, 'can save'], [0x4001, 'inputs'], [0x4002, 'outputs']]);

/**
 * A command string's words, quotes taken off.
 *
 * @param {string} command
 */
export const mciWords = command=>(command.trim().match(/"[^"]*"|\S+/g) ?? [])
    .map(word=>word.replace(/^"(.*)"$/, '$1'));

/**
 * @typedef {{ error: number, text?: string, mustFit?: boolean }} Answer
 *
 * @typedef {Object} Driver
 * @property {(file: string, words: string[]) => any} open
 *           `{ error, device }`, or a promise of it.
 * @property {(verb: string, device: any, words: string[],
 *     how: { wait: boolean, done: () => void, original: string[] }) =>
 *     Answer | Promise<Answer>} command
 * @property {(device: any) => void} close
 * @property {(device: any) => boolean} [settle]  whether the device's play just ended
 *
 * @typedef {Object} Device
 * @property {number} id
 * @property {string} alias
 * @property {string} type
 * @property {Driver} driver
 * @property {any} state
 * @property {number} pending  The window a play's notification goes to, 0 for none.
 * @property {boolean} [closeWhenDone]  Opened for one command, by its type or file.
 */

/**
 * @param {{ drivers: Record<string, Driver | null>,
 *     post?: (hwnd: number, message: number, wParam: number, lParam: number) => void }} host
 */
export function createMci(host){
    /** @type {Map<number, Device>} */
    const devices = new Map();

    /** @param {number} hwnd @param {number} flag @param {number} id */
    const notify = (hwnd, flag, id)=>{
        if ((hwnd >>> 0) !== 0)
        {
            host.post?.(hwnd >>> 0, MM_MCINOTIFY, flag, id);
        }
    };
    /** @param {string} name */
    const byAlias = name=>[...devices.values()]
        .find(device=>device.alias.toLowerCase() === name.toLowerCase()) ?? null;
    /** @param {string} type */
    const driverFor = type=>(type === 'waveaudio' ? host.drivers.waveaudio
        : type === 'avivideo' || type === 'digitalvideo' ? host.drivers.video : null) ?? null;
    /** The lowest id no open device holds. */
    const freeId = ()=>{
        let id = 1;
        while (devices.has(id))
        {
            id++;
        }
        return id;
    };
    /** @param {Device} device */
    const abortPending = device=>{
        notify(device.pending, MCI_NOTIFY_ABORTED, device.id);
        device.pending = 0;
    };
    /** @param {Device} device */
    const close = device=>{
        abortPending(device);
        device.driver.close(device.state);
        devices.delete(device.id);
    };

    /**
     * `open`: the device named by type, by `type!element`, by a `type`
     * keyword or by the element's extension; aliased by `alias`, by its
     * element, or by its type.
     *
     * @param {string[]} words @param {number} callback @param {boolean} wantsNotify
     * @returns {Answer | Promise<Answer>}
     */
    const open = (words, callback, wantsNotify)=>{
        const name = words[1];
        if (name === undefined)
        {
            return { error: MCIERR_MISSING_DEVICE_NAME };
        }
        const rest = words.slice(2);
        const lower = rest.map(word=>word.toLowerCase());
        const keyword = (/** @type {string} */ key)=>{
            const at = lower.indexOf(key);
            return at >= 0 ? rest[at + 1] : undefined;
        };
        if (name.toLowerCase() === 'all')
        {
            return { error: MCIERR_CANNOT_USE_ALL };
        }
        let type = keyword('type')?.toLowerCase();
        let element = name;
        const bang = name.indexOf('!');
        const prefix = bang >= 0 ? name.slice(0, bang).toLowerCase() : '';
        if (type === undefined && REGISTERED_TYPES.has(prefix))
        {
            type = name.slice(0, bang).toLowerCase();
            element = name.slice(bang + 1);
        }
        else if (type === undefined && REGISTERED_TYPES.has(name.toLowerCase()))
        {
            type = name.toLowerCase();
            element = '';
        }
        const isNew = element.toLowerCase() === 'new';
        const alias = keyword('alias') ?? (element === '' ? name : element);
        if (isNew && keyword('alias') === undefined)
        {
            return { error: MCIERR_NEW_REQUIRES_ALIAS };
        }
        if (type === undefined)
        {
            const leaf = element.slice(Math.max(element.lastIndexOf('\\'),
                element.lastIndexOf('/')) + 1);
            const dot = leaf.lastIndexOf('.');
            if (dot < 0 || element === '!' || element === '')
            {
                return { error: MCIERR_INVALID_DEVICE_NAME };
            }
            type = EXTENSION_TYPES.get(leaf.slice(dot + 1).toLowerCase());
            if (type === undefined)
            {
                return { error: MCIERR_EXTENSION_NOT_FOUND };
            }
        }
        if (byAlias(alias))
        {
            return { error: MCIERR_DUPLICATE_ALIAS };
        }
        const driver = driverFor(type);
        if (!driver)
        {
            return { error: REGISTERED_TYPES.has(type) ? MCIERR_CANNOT_LOAD_DRIVER
                : MCIERR_INVALID_DEVICE_NAME };
        }
        /** @param {{ error: number, device?: any }} opened @returns {Answer} */
        const opened = ({ error, device })=>{
            if (error !== 0)
            {
                return { error };
            }
            const id = freeId();
            devices.set(id, { id, alias, type, driver, state: device, pending: 0,
                closeWhenDone: false });
            if (wantsNotify)
            {
                notify(callback, MCI_NOTIFY_SUCCESSFUL, id);
            }
            return { error: 0, text: String(id) };
        };
        const answer = driver.open(isNew ? '' : element, rest);
        return 'then' in answer ? answer.then(opened) : opened(answer);
    };

    /**
     * `sysinfo`: counting and naming the types installed and the devices open.
     *
     * @param {string[]} words  lower case, the device name first
     * @returns {Answer}
     */
    const sysinfo = words=>{
        const [name, ...items] = words;
        if (name === undefined)
        {
            return { error: MCIERR_MISSING_DEVICE_NAME };
        }
        const openOnly = items.includes('open');
        if (items[0] === 'installname')
        {
            if (name === 'all')
            {
                return { error: MCIERR_CANNOT_USE_ALL };
            }
            const device = byAlias(name);
            return device ? { error: 0, text: device.type } : { error: MCIERR_INVALID_DEVICE_NAME };
        }
        const all = name === 'all';
        if (!all && !DEVICE_TYPES.includes(name))
        {
            return { error: MCIERR_DEVICE_TYPE_REQUIRED };
        }
        /** @param {string} type */
        const kind = type=>(type === 'avivideo' || type === 'mpegvideo' ? 'digitalvideo' : type);
        const opened = [...devices.values()].filter(device=>all || kind(device.type) === name);
        const installed = DEVICE_TYPES.filter(type=>(all || type === name) && driverFor(type)
            && type !== 'digitalvideo');
        if (items[0] === 'quantity')
        {
            return { error: 0, text: String(openOnly ? opened.length : installed.length) };
        }
        if (items[0] === 'name')
        {
            const index = Number.parseInt(items[1] ?? '', 10);
            const named = openOnly ? opened.map(device=>device.alias) : installed;
            return index >= 1 && index <= named.length
                ? { error: 0, text: named[index - 1] }
                : { error: 282 };
        }
        return { error: MCIERR_UNRECOGNIZED_KEYWORD };
    };

    /**
     * A command on one device: notify and wait taken off, the driver asked.
     *
     * @param {Device} device @param {string} verb @param {string[]} rest
     * @param {number} callback @param {boolean} wantsNotify @param {boolean} wait
     * @returns {Answer | Promise<Answer>}
     */
    const onDevice = (device, verb, rest, callback, wantsNotify, wait)=>{
        if (verb === 'close')
        {
            close(device);
            if (wantsNotify)
            {
                notify(callback, MCI_NOTIFY_SUCCESSFUL, device.id);
            }
            return { error: 0 };
        }
        if (['play', 'stop', 'seek', 'pause'].includes(verb))
        {
            abortPending(device);
        }
        const lower = rest.map(word=>word.toLowerCase());
        const later = verb === 'play' && wantsNotify && !wait;
        const answer = device.driver.command(verb, device.state, lower, {
            wait,
            done: ()=>{
                if (device.pending !== 0)
                {
                    notify(device.pending, MCI_NOTIFY_SUCCESSFUL, device.id);
                    device.pending = 0;
                }
            },
            original: rest,
        });
        /** @param {Answer} result */
        const settled = result=>{
            if (result.error === 0 && wantsNotify && !later)
            {
                notify(callback, MCI_NOTIFY_SUCCESSFUL, device.id);
            }
            return result;
        };
        if (later)
        {
            device.pending = callback >>> 0;
        }
        return 'then' in answer ? answer.then(settled) : settled(answer);
    };

    /**
     * A command string, split into words.
     *
     * @param {string[]} words @param {number} callback  the window notify posts to
     * @returns {Answer | Promise<Answer>}
     */
    const send = (words, callback)=>{
        if (words.length === 0)
        {
            return { error: MCIERR_MISSING_COMMAND_STRING };
        }
        const verb = words[0].toLowerCase();
        if (!CORE_VERBS.has(verb) && !DEVICE_VERBS.has(verb))
        {
            return { error: MCIERR_UNRECOGNIZED_COMMAND };
        }
        const flagged = words.map(word=>word.toLowerCase());
        const wantsNotify = flagged.slice(2).includes('notify');
        const wait = flagged.slice(2).includes('wait');
        if (verb === 'open')
        {
            return open(words.filter((_, at)=>at < 2
                || !['notify', 'wait'].includes(flagged[at])), callback, wantsNotify);
        }
        const name = words[1];
        if (name === undefined)
        {
            return { error: MCIERR_MISSING_DEVICE_NAME };
        }
        const rest = words.slice(2).filter((_, at)=>!['notify', 'wait'].includes(flagged[at + 2]));
        if (verb === 'sysinfo')
        {
            // MCI writes this answer itself, and one that does not fit the
            // caller's buffer - none at all included - overflows it.
            return { ...sysinfo([name.toLowerCase(), ...rest.map(word=>word.toLowerCase())]),
                mustFit: true };
        }
        if (verb === 'sound')
        {
            // A system sound by its name: none is defined here, which MCI
            // answers as a machine without a default sound does.
            return { error: MCIERR_HARDWARE };
        }
        if (name.toLowerCase() === 'all')
        {
            if (!CORE_VERBS.has(verb))
            {
                return { error: MCIERR_UNRECOGNIZED_COMMAND };
            }
            if (['status', 'info', 'capability'].includes(verb))
            {
                return { error: MCIERR_CANNOT_USE_ALL };
            }
            const errors = [...devices.values()].map(device=>{
                const answer = onDevice(device, verb, rest, callback, wantsNotify, false);
                return 'then' in answer ? 0 : answer.error;
            });
            const distinct = new Set(errors.filter(error=>error !== 0));
            return { error: distinct.size === 0 ? 0 : distinct.size === 1 ? [...distinct][0]
                : MCIERR_MULTIPLE };
        }
        const device = byAlias(name);
        if (device)
        {
            return onDevice(device, verb, rest, callback, wantsNotify, wait);
        }
        if (!CORE_VERBS.has(verb))
        {
            return { error: MCIERR_UNRECOGNIZED_COMMAND };
        }
        if (verb === 'close' || verb === 'break')
        {
            return { error: MCIERR_INVALID_DEVICE_NAME };
        }
        if (wantsNotify)
        {
            return { error: MCIERR_NOTIFY_ON_AUTO_OPEN };
        }
        // A device named by its type or its file is opened for the command
        // ("play sound.wav") and closed again once the command is done - a
        // play once it reaches its end.
        /** @param {Answer} opened @returns {Answer | Promise<Answer>} */
        const run = opened=>{
            const auto = opened.error === 0 ? devices.get(Number(opened.text)) : undefined;
            if (!auto)
            {
                return { error: opened.error };
            }
            const finish = (/** @type {Answer} */ answer)=>{
                if (devices.has(auto.id) && (answer.error !== 0 || verb !== 'play' || wait))
                {
                    close(auto);
                }
                return answer;
            };
            auto.closeWhenDone = true;
            const answer = onDevice(auto, verb, rest, callback, wantsNotify, wait);
            return 'then' in answer ? answer.then(finish) : finish(answer);
        };
        const opened = open(['open', name], 0, false);
        return 'then' in opened ? opened.then(run) : run(opened);
    };

    /**
     * mciSendCommand: the message and its block turned into a command
     * string's words, answered by `send`, and the answer written back.
     *
     * @param {number} id @param {number} message @param {number} flags
     * @param {{ address: number, u32: (offset: number) => number,
     *     setU32: (offset: number, value: number) => void,
     *     putU32: (address: number, value: number) => void,
     *     text: (address: number, limit: number) => string,
     *     write: (address: number, room: number, text: string) => void }} block
     * @returns {number | Promise<number>}
     */
    const command = (id, message, flags, block)=>{
        const has = (/** @type {number} */ flag)=>(flags & flag) !== 0;
        const callback = block.address === 0 ? 0 : block.u32(0);
        const tail = [...has(MCI_NOTIFY) ? ['notify'] : [], ...has(MCI_WAIT) ? ['wait'] : []];
        const all = (id >>> 0) === MCI_ALL_DEVICE_ID;
        const device = all ? null : devices.get(id >>> 0) ?? null;
        const name = all ? 'all' : device?.alias ?? '';
        /** @param {Answer | Promise<Answer>} answer @param {(a: Answer) => number} then */
        const after = (answer, then)=>('then' in answer ? answer.then(then) : then(answer));
        if (message === MCI_OPEN)
        {
            if (block.address === 0)
            {
                return MCIERR_NULL_PARAMETER_BLOCK;
            }
            const words = ['open'];
            const typeField = block.u32(8);
            const type = !has(0x2000) ? null : has(0x1000)
                ? DEVICE_TYPES[(typeField & 0xffff) - MCI_DEVTYPE_FIRST] ?? null
                : block.text(typeField, 128);
            if (has(0x2000) && type === null)
            {
                return MCIERR_INVALID_DEVICE_NAME;
            }
            const element = has(0x200) ? block.text(block.u32(12), 260) : null;
            words.push(element === null ? type ?? '' : element === '' ? 'new' : element);
            if (type !== null && element !== null)
            {
                words.push('type', type);
            }
            if (has(0x400))
            {
                words.push('alias', block.text(block.u32(16), 128));
            }
            if (has(0x100))
            {
                words.push('shareable');
            }
            if (words[1] === '')
            {
                return MCIERR_MISSING_DEVICE_NAME;
            }
            return after(open(words, callback, has(MCI_NOTIFY)), answer=>{
                if (answer.error === 0)
                {
                    block.setU32(4, Number(answer.text));
                }
                return answer.error;
            });
        }
        if (message === MCI_SYSINFO)
        {
            const subject = all ? 'all' : device?.alias ?? '#';
            const item = has(0x100) ? ['quantity'] : has(0x400) ? ['name', String(block.u32(12))]
                : has(0x800) ? ['installname'] : [];
            const answer = sysinfo([subject.toLowerCase(), ...item,
                ...has(0x200) ? ['open'] : []]);
            if (answer.error !== 0 || block.address === 0)
            {
                return answer.error;
            }
            const room = block.u32(8);
            if (has(0x100))
            {
                if (room < 4)
                {
                    return MCIERR_PARAM_OVERFLOW;
                }
                block.putU32(block.u32(4), Number(answer.text));
                return 0;
            }
            const text = answer.text ?? '';
            if (room <= text.length)
            {
                return MCIERR_PARAM_OVERFLOW;
            }
            block.write(block.u32(4), room, text);
            if (has(MCI_NOTIFY))
            {
                notify(callback, MCI_NOTIFY_SUCCESSFUL, all ? 0 : id);
            }
            return 0;
        }
        if (!all && !device)
        {
            return MCIERR_INVALID_DEVICE_ID;
        }
        if (message === MCI_CLOSE)
        {
            return after(send(['close', name, ...tail], callback), answer=>answer.error);
        }
        if (block.address === 0 && [MCI_STATUS, MCI_GETDEVCAPS, MCI_INFO, MCI_SET]
            .includes(message))
        {
            return MCIERR_NULL_PARAMETER_BLOCK;
        }
        if (message === MCI_STATUS || message === MCI_GETDEVCAPS)
        {
            const table = message === MCI_STATUS ? STATUS_KEYWORDS : CAPABILITY_KEYWORDS;
            const keyword = table.get(block.u32(8));
            if (keyword === undefined)
            {
                return MCIERR_UNSUPPORTED_FUNCTION;
            }
            const verb = message === MCI_STATUS ? 'status' : 'capability';
            return after(send([verb, name, ...keyword.split(' '), ...tail], callback), answer=>{
                if (answer.error === 0)
                {
                    const text = answer.text ?? '';
                    const value = MODES.get(text) ?? TIME_FORMAT_IDS.get(text)
                        ?? (text === 'true' ? 1 : text === 'false' ? 0
                            : DEVICE_TYPES.includes(text)
                                ? DEVICE_TYPES.indexOf(text) + MCI_DEVTYPE_FIRST
                                : Number.parseInt(text, 10) || 0);
                    block.setU32(4, value);
                }
                return answer.error;
            });
        }
        if (message === MCI_INFO)
        {
            const item = has(0x100) ? 'product' : has(0x200) ? 'file' : null;
            if (item === null)
            {
                return MCIERR_UNRECOGNIZED_KEYWORD;
            }
            return after(send(['info', name, item, ...tail], callback), answer=>{
                if (answer.error === 0)
                {
                    block.write(block.u32(4), block.u32(8), answer.text ?? '');
                }
                return answer.error;
            });
        }
        /** @type {string[] | null} */
        let words = null;
        if (message === MCI_SET)
        {
            words = ['set', name];
            if (has(0x400))
            {
                words.push('time', 'format', String(block.u32(4)));
            }
            const wave = [[0x40000, 'samplespersec', 28], [0x20000, 'channels', 24],
                [0x200000, 'bitspersample', 40], [0x80000, 'bytespersec', 32],
                [0x100000, 'alignment', 36]];
            for (const [flag, key, offset] of /** @type {[number, string, number][]} */ (wave))
            {
                if (has(flag))
                {
                    words.push(key, String(block.u32(offset) & (offset === 28
                        || offset === 32 ? 0xffffffff : 0xffff)));
                }
            }
        }
        else if (message === MCI_PLAY)
        {
            words = ['play', name,
                ...has(MCI_FROM) ? ['from', String(block.u32(4))] : [],
                ...has(MCI_TO) ? ['to', String(block.u32(8))] : []];
        }
        else if (message === MCI_SEEK)
        {
            words = ['seek', name, ...has(0x100) ? ['to', 'start'] : has(0x200) ? ['to', 'end']
                : has(MCI_TO) ? ['to', String(block.u32(4))] : []];
        }
        else if (message === MCI_STOP || message === MCI_PAUSE || message === MCI_RESUME
            || message === MCI_CUE)
        {
            words = [{ [MCI_STOP]: 'stop', [MCI_PAUSE]: 'pause', [MCI_RESUME]: 'resume',
                [MCI_CUE]: 'cue' }[message] ?? 'stop', name];
        }
        if (words === null)
        {
            return MCIERR_UNSUPPORTED_FUNCTION;
        }
        return after(send([...words, ...tail], callback), answer=>answer.error);
    };

    return {
        send,
        command,
        /**
         * mciGetDeviceID: the id an alias names, MCI_ALL_DEVICE_ID for `all`,
         * 0 for anything else - a type or a file name is not looked up.
         *
         * @param {string} name
         */
        deviceId: name=>(name.trim().toLowerCase() === 'all' ? MCI_ALL_DEVICE_ID
            : byAlias(name.trim())?.id ?? 0),
        /**
         * Settles devices whose play has reached its end; one opened for that
         * play alone is closed.
         */
        tick(){
            for (const device of [...devices.values()])
            {
                if (device.driver.settle?.(device.state) && device.closeWhenDone)
                {
                    close(device);
                }
            }
        },
    };
}
