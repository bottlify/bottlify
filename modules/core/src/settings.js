/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import raw from '../config.json' with { type: 'json' };

/**
 * The settings the core is tuned by, from `config.json` beside `package.json`:
 * what the processor is called, the performance counter's rate, the frame
 * rate the presenter paces to, the translation cache's version. A key the
 * file leaves out takes the default of the layer that reads it, so the file
 * may name as little as it likes; a value of the wrong kind is an error here,
 * before anything is built on it.
 *
 * @typedef {Object} Settings
 * @property {{ name?: string }} processor
 *     The name the registry's processor key shows, as `name v<version>`: the
 *     version is the translator's own (`processorName`).
 * @property {{ frequency?: number }} qpc
 *     Ticks a second of QueryPerformanceCounter, a whole number up to 4294967295.
 * @property {{ maxFps?: number }} frame
 *     Frames a second the presenter may deliver; 0 does not pace.
 * @property {{ cacheVersion?: number }} cork
 *     A floor for the translation cache's version: the stores of every lower version
 *     are misses, so raising it empties them, and a value below the version the
 *     translator ships is ignored, since a record of the older emitter is wrong code.
 */

/**
 * @param {unknown} value @param {string} path @param {'string' | 'number'} type
 * @param {(value: any) => boolean} [accept]
 */
function check(value, path, type, accept = ()=>true){
    if (value !== undefined && (typeof value !== type || !accept(value)))
    {
        throw new Error(`config.json: "${path}" is not a valid ${type}: ${JSON.stringify(value)}`);
    }
}

/**
 * @param {any} source
 * @returns {Readonly<Settings>}
 */
export function readSettings(source){
    const section = (/** @type {string} */ name)=>{
        const value = source?.[name];
        if (value !== undefined && (value === null || typeof value !== 'object'
            || Array.isArray(value)))
        {
            throw new Error(`config.json: "${name}" is not an object`);
        }
        return { ...value };
    };
    const known = ['processor', 'qpc', 'frame', 'cork'];
    for (const key of Object.keys(source ?? {}))
    {
        if (!known.includes(key))
        {
            throw new Error(`config.json: unknown section "${key}". Known: ${known.join(', ')}`);
        }
    }
    const settings = {
        processor: section('processor'), qpc: section('qpc'), frame: section('frame'),
        cork: section('cork'),
    };
    const whole = (/** @type {number} */ n)=>Number.isInteger(n) && n >= 0;
    check(settings.processor.name, 'processor.name', 'string', name=>name.length > 0);
    check(settings.qpc.frequency, 'qpc.frequency', 'number',
        n=>whole(n) && n >= 1 && n <= 0xffffffff);
    check(settings.frame.maxFps, 'frame.maxFps', 'number', whole);
    check(settings.cork.cacheVersion, 'cork.cacheVersion', 'number', n=>whole(n) && n >= 1);
    return Object.freeze(settings);
}

/** The settings of this build. */
export const SETTINGS = readSettings(raw);

/**
 * The name the registry shows for the processor: the file's name and the
 * translator's version, which its entry module says (`version`), or nothing
 * where the file names no processor.
 *
 * @param {Readonly<Settings>} settings
 * @param {string} [version]
 * @returns {string | undefined}
 */
export function processorName({ processor }, version){
    if (processor.name === undefined)
    {
        return undefined;
    }
    return version === undefined ? processor.name : `${processor.name} v${version}`;
}
