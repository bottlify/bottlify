/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Environment table's variables. A row's name carries what to do in its
 * prefix: `=` set it, `+` set it only where it is missing, `!` take it away
 * on installation, `-` take it away on removal, `*` the machine's variable
 * rather than the user's; a name with none of `=`, `+`, `!` is set on
 * installation and taken away on removal. A value holding `[~]` is a part of
 * the variable's list -- `[~];part` goes at its end, `part;[~]` at its start
 * -- so installing adds the part and removing takes only that part out.
 */

import { HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE } from '../advapi32/registry.js';

const MACHINE_ENVIRONMENT = 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const USER_ENVIRONMENT = 'Environment';

/**
 * @typedef {Object} EnvironmentRow
 * @property {string} name
 * @property {string} value       The part, `[~]` and its separator taken off.
 * @property {'append' | 'prepend' | 'whole'} place
 * @property {string} separator   Between the part and the rest of a list.
 * @property {boolean} machine
 * @property {'set' | 'create' | 'remove' | 'none'} onInstall
 * @property {boolean} removeOnUninstall
 */

/**
 * A row's name and formatted value, read for what they ask.
 *
 * @param {string} rawName @param {string} rawValue @returns {EnvironmentRow}
 */
export function environmentRow(rawName, rawValue){
    const prefix = /^[=+\-!*]*/.exec(rawName)?.[0] ?? '';
    const name = rawName.slice(prefix.length);
    const has = (/** @type {string} */ mark)=>prefix.includes(mark);
    const plain = !has('=') && !has('+') && !has('!');
    /** @type {EnvironmentRow['onInstall']} */
    const onInstall = has('!') ? 'remove' : has('+') ? 'create' : has('=') || plain ? 'set'
        : 'none';
    // Formatting a row's value turns its [~] into a NUL; either marks the list.
    const value = rawValue.replace(/\0/g, '[~]');
    let place = /** @type {EnvironmentRow['place']} */ ('whole');
    let part = value;
    let separator = ';';
    const marker = value.indexOf('[~]');
    if (marker === 0 && value.length > 3)
    {
        place = 'append';
        separator = value[3];
        part = value.slice(4);
    }
    else if (marker > 0 && marker === value.length - 3)
    {
        place = 'prepend';
        separator = value[marker - 1];
        part = value.slice(0, marker - 1);
    }
    else if (marker >= 0)
    {
        part = value.replace('[~]', '');
    }
    return { name, value: part, place, separator, machine: has('*'), onInstall,
        removeOnUninstall: has('-') || plain };
}

/**
 * The key a variable lives under, made if it is missing.
 *
 * @param {import('./registration.js').Hive} hive @param {boolean} machine
 */
export const environmentKey = (hive, machine)=>hive.create(
    hive.root(machine ? HKEY_LOCAL_MACHINE : HKEY_CURRENT_USER),
    machine ? MACHINE_ENVIRONMENT : USER_ENVIRONMENT).key;

/** @param {string} list @param {string} separator */
const partsOf = (list, separator)=>list.split(separator).filter(part=>part !== '');

/**
 * The variable's value once installed: a string, null to delete it, or
 * undefined to leave it as it is.
 *
 * @param {EnvironmentRow} row @param {string | null} existing
 * @returns {string | null | undefined}
 */
export function installedValue(row, existing){
    if (row.onInstall === 'none')
    {
        return undefined;
    }
    if (row.onInstall === 'remove')
    {
        return existing !== null && (row.value === '' || existing === row.value) ? null
            : undefined;
    }
    if (row.onInstall === 'create' && existing !== null)
    {
        return undefined;
    }
    if (row.place === 'whole' || existing === null || existing === '')
    {
        return row.value;
    }
    const parts = partsOf(existing, row.separator);
    if (parts.some(part=>part.toLowerCase() === row.value.toLowerCase()))
    {
        return undefined;
    }
    return row.place === 'append' ? [...parts, row.value].join(row.separator)
        : [row.value, ...parts].join(row.separator);
}

/**
 * The variable's value once its component is removed, by the same three
 * answers.
 *
 * @param {EnvironmentRow} row @param {string | null} existing
 * @returns {string | null | undefined}
 */
export function removedValue(row, existing){
    if (!row.removeOnUninstall || existing === null)
    {
        return undefined;
    }
    if (row.place === 'whole')
    {
        return null;
    }
    const left = partsOf(existing, row.separator)
        .filter(part=>part.toLowerCase() !== row.value.toLowerCase());
    return left.length === 0 ? null : left.join(row.separator);
}
