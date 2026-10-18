/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * MCI's digital-video devices -- `avivideo`, and `digitalvideo` for a file of
 * that kind -- as the string interface drives them: a film opened under an
 * alias, shown in a window of the program's, played to its end with `wait`
 * or behind the program's back without it.
 *
 * The film itself is quartz's (`Film`): the same decoder, clock, window
 * placement and presenter a filter graph plays with, so a program that plays
 * its intro through MCI is shown exactly as one that uses DirectShow.
 *
 * The commands are the ones such a program sends, with their keywords as
 * Windows documents them (MCI command strings, the digital-video set):
 *
 *     open <file> type avivideo alias <a> [parent <hwnd>] [style child] [wait]
 *     window <a> handle <hwnd> | handle default [state show|hide|restore|...]
 *     put <a> destination [at <x> <y> <width> <height>]
 *     seek <a> to start | end
 *     break <a> on <virtual key> | off
 *     play <a> [fullscreen] [wait]
 *     stop | pause <a>, resume <a>, close <a>
 *     status <a> mode | ready | length | position
 */

/** The MCI errors these devices answer with. */
export const MCIERR_INVALID_DEVICE_NAME = 263;
export const MCIERR_UNSUPPORTED_FUNCTION = 274;
export const MCIERR_FILE_NOT_FOUND = 275;
export const MCIERR_DUPLICATE_ALIAS = 289;
export const MCIERR_MISSING_PARAMETER = 273;
export const MCIERR_BAD_INTEGER = 270;

/** The types that name this driver, and the file extension that opens it unnamed. */
const VIDEO_TYPES = new Set(['avivideo', 'digitalvideo']);
const VIDEO_EXTENSION = /\.avi$/i;

/** ShowWindow's states as the `window ... state` keyword names them: shown or not. */
const SHOWN_STATES = new Map([
    ['hide', false], ['minimize', false], ['minimized', false],
    ['show', true], ['restore', true], ['maximize', true], ['maximized', true],
    ['normal', true], ['showna', true], ['shownormal', true], ['iconic', false],
]);

/**
 * @typedef {Object} MciVideoHost
 * @property {() => import('../quartz/graph.js').Film | null} film
 *           A new film, or null in a build with no decoder.
 * @property {(key: number) => boolean} keyDown
 *           Whether a virtual key is held now: the break key that ends a wait.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @typedef {Object} Device
 * @property {number} id
 * @property {string} alias
 * @property {import('../quartz/graph.js').Film} film
 * @property {number} parent  The window `open` named, where the picture goes by default.
 * @property {number} breakKey  The virtual key that ends a wait, zero for none.
 */

/**
 * @param {string} word
 * @returns {number | null} a decimal or 0x-prefixed integer, or null
 */
const integer = word=>{
    const value = /^0x[0-9a-f]+$/i.test(word) ? Number.parseInt(word.slice(2), 16)
        : /^-?\d+$/.test(word) ? Number.parseInt(word, 10) : Number.NaN;
    return Number.isFinite(value) ? value : null;
};

/**
 * @param {MciVideoHost} host
 */
export function createMciVideo(host){
    /** @type {Map<string, Device>} by alias, lower case */
    const devices = new Map();
    let nextId = 1;

    /**
     * The value after a keyword, or undefined.
     *
     * @param {string[]} words @param {string} keyword
     */
    const after = (words, keyword)=>{
        const at = words.findIndex(word=>word.toLowerCase() === keyword);
        return at >= 0 ? words[at + 1] : undefined;
    };
    /** @param {string[]} words @param {string} keyword */
    const has = (words, keyword)=>words.some(word=>word.toLowerCase() === keyword);

    /**
     * `open`: ours when the type names this driver, or when none is named and
     * the file is an AVI. Null for anything else, which the caller answers.
     *
     * @param {string} element @param {string[]} rest
     * @returns {number | Promise<number> | null}
     */
    const open = (element, rest)=>{
        const named = after(rest, 'type');
        let file = element;
        let type = named?.toLowerCase();
        if (type === undefined && element.includes('!'))
        {
            type = element.slice(0, element.indexOf('!')).toLowerCase();
            file = element.slice(element.indexOf('!') + 1);
        }
        if (type !== undefined ? !VIDEO_TYPES.has(type) : !VIDEO_EXTENSION.test(file))
        {
            return null;
        }
        const film = host.film();
        if (!film)
        {
            return null;
        }
        const alias = after(rest, 'alias') ?? file;
        if (devices.has(alias.toLowerCase()))
        {
            return MCIERR_DUPLICATE_ALIAS;
        }
        const parentWord = after(rest, 'parent');
        const parent = parentWord === undefined ? 0 : integer(parentWord);
        if (parent === null)
        {
            return MCIERR_BAD_INTEGER;
        }
        if (has(rest, 'notify'))
        {
            host.divergence?.('MCI', 'notify is not posted by the video device: '
                + 'a program waiting for MM_MCINOTIFY polls status instead');
        }
        return film.open(file).then(opened=>{
            if (!opened)
            {
                film.close();
                return MCIERR_FILE_NOT_FOUND;
            }
            const { width, height } = film.size();
            // The window MCI makes for a film is the parent's child at its
            // corner, the film's size, hidden until the film plays.
            film.place({ owner: parent >>> 0, left: 0, top: 0, width, height, visible: false });
            devices.set(alias.toLowerCase(),
                { id: nextId++, alias, film, parent: parent >>> 0, breakKey: 0 });
            return 0;
        });
    };

    /**
     * `play`: from where the film is. With `wait` the call returns once the
     * film ends or its break key is held, as MCI's own wait loop does.
     *
     * @param {Device} device @param {string[]} rest
     * @returns {number | Promise<number>}
     */
    const play = (device, rest)=>{
        const { film } = device;
        film.place({ visible: true, ...has(rest, 'fullscreen') ? { fullScreen: true } : {} });
        if (has(rest, 'from') || has(rest, 'to') || has(rest, 'repeat'))
        {
            host.divergence?.('MCI', 'play from/to/repeat plays the film once from where it is');
        }
        if (!has(rest, 'wait'))
        {
            film.whenEnded(null);
            film.stopWhen(null);
            film.play();
            return 0;
        }
        return new Promise(done=>{
            film.whenEnded(()=>{
                film.whenEnded(null);
                film.stopWhen(null);
                done(0);
            });
            const key = device.breakKey;
            film.stopWhen(key === 0 ? null : ()=>host.keyDown(key));
            film.play();
            // A film that ended before it began -- nothing left to show -- is
            // over now, and its listener has already been told or never will.
            if (film.mode() !== 'playing')
            {
                film.whenEnded(null);
                film.stopWhen(null);
                done(0);
            }
        });
    };

    /**
     * Every command but `open` on a device of ours.
     *
     * @param {string} verb @param {Device} device @param {string[]} rest
     * @returns {{ error: number, text?: string } | Promise<{ error: number, text?: string }>}
     */
    const command = (verb, device, rest)=>{
        const { film } = device;
        switch (verb)
        {
            case 'close':
                film.close();
                devices.delete(device.alias.toLowerCase());
                return { error: 0 };
            case 'play':
            {
                const answer = play(device, rest);
                return typeof answer === 'number' ? { error: answer }
                    : answer.then(error=>({ error }));
            }
            case 'stop':
            case 'pause':
                film.stop();
                return { error: 0 };
            case 'resume':
                return { error: /** @type {number} */ (play(device, [])) };
            case 'seek':
            {
                const to = after(rest, 'to')?.toLowerCase();
                if (to !== 'start' || film.position().shown > 0)
                {
                    host.divergence?.('MCI', `seek to ${to ?? '?'} is not honoured: `
                        + 'this decoder reads forward only');
                }
                return { error: 0 };
            }
            case 'break':
            {
                if (has(rest, 'off'))
                {
                    device.breakKey = 0;
                    return { error: 0 };
                }
                const key = integer(after(rest, 'on') ?? '');
                if (key === null)
                {
                    return { error: MCIERR_MISSING_PARAMETER };
                }
                device.breakKey = key & 0xff;
                return { error: 0 };
            }
            case 'window':
            {
                const handle = after(rest, 'handle');
                if (handle !== undefined)
                {
                    const hwnd = handle.toLowerCase() === 'default'
                        ? device.parent : integer(handle);
                    if (hwnd === null)
                    {
                        return { error: MCIERR_BAD_INTEGER };
                    }
                    film.place({ owner: hwnd >>> 0 });
                }
                const state = after(rest, 'state')?.toLowerCase();
                if (state !== undefined && SHOWN_STATES.has(state))
                {
                    film.place({ visible: SHOWN_STATES.get(state) });
                }
                return { error: 0 };
            }
            case 'put':
            {
                const at = rest.findIndex(word=>word.toLowerCase() === 'at');
                if (at < 0)
                {
                    return { error: 0 };
                }
                const [left, top, width, height] = rest.slice(at + 1, at + 5).map(integer);
                if ([left, top, width, height].some(value=>value === null || value === undefined))
                {
                    return { error: MCIERR_BAD_INTEGER };
                }
                film.place({ left: /** @type {number} */ (left), top: /** @type {number} */ (top),
                    width: /** @type {number} */ (width), height: /** @type {number} */ (height) });
                return { error: 0 };
            }
            case 'status':
            {
                const item = rest.find(word=>word.toLowerCase() !== 'wait')?.toLowerCase();
                const { frames, shown } = film.position();
                const text = item === 'mode' ? film.mode()
                    : item === 'ready' ? 'true'
                        : item === 'length' ? String(frames)
                            : item === 'position' ? String(shown) : null;
                return text === null ? { error: MCIERR_UNSUPPORTED_FUNCTION } : { error: 0, text };
            }
            case 'where':
            {
                const { left, top, width, height } = film.placement();
                return { error: 0, text: `${left} ${top} ${width} ${height}` };
            }
            case 'realize':
            case 'update':
            case 'set':
            case 'setvideo':
            case 'setaudio':
                return { error: 0 };
            default:
                host.divergence?.('MCI', `the video device does not answer "${verb}"`);
                return { error: MCIERR_UNSUPPORTED_FUNCTION };
        }
    };

    return {
        /**
         * Answers a command string's words when they are this driver's: an
         * `open` of a film, or any command on an alias it opened. Null for
         * anything else.
         *
         * @param {string[]} words  the command's words, quotes taken off
         * @returns {{ error: number, text?: string }
         *     | Promise<{ error: number, text?: string }> | null}
         */
        command(words){
            const verb = words[0]?.toLowerCase();
            const name = words[1];
            if (verb === undefined || name === undefined)
            {
                return null;
            }
            const rest = words.slice(2);
            if (verb === 'open')
            {
                const answer = open(name, rest);
                return answer === null ? null
                    : typeof answer === 'number' ? { error: answer }
                        : answer.then(error=>({ error }));
            }
            if (verb === 'close' && name.toLowerCase() === 'all')
            {
                for (const device of devices.values())
                {
                    device.film.close();
                }
                devices.clear();
                return null;
            }
            const device = devices.get(name.toLowerCase());
            return device ? command(verb, device, rest) : null;
        },

        /** @param {string} name @returns {number} the device id an alias of ours has, else 0 */
        deviceId: name=>devices.get(name.trim().toLowerCase())?.id ?? 0,
    };
}
