/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A device's registry properties, SPDRP_*: values of its instance key, by
 * the names Windows keeps them under, and the one it works out instead --
 * the enumerator, the instance id's first part.
 *
 * The hive keeps strings in the ANSI page, as the registry layer does; a W
 * call's strings are UTF-16 on the way in and out. A property is read with
 * the type it was stored with. A property with no value name (SPDRP_UNUSED0
 * and the ones only a running driver answers) or no value is
 * ERROR_INVALID_DATA; past the last, ERROR_INVALID_REG_PROPERTY. A program
 * sets only the properties Windows lets it, each with its own type; setting
 * one with no data deletes it.
 */

import {
    REG_BINARY, REG_DWORD, REG_EXPAND_SZ, REG_MULTI_SZ, REG_SZ,
} from '../advapi32/registry.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';

export const ERROR_INVALID_DATA = 13;
export const ERROR_INVALID_REG_PROPERTY = 0xe0000209;

/** SPDRP_ENUMERATOR_NAME: worked out from the instance id, not stored. */
export const SPDRP_ENUMERATOR_NAME = 0x16;

/** SPDRP_MAXIMUM_PROPERTY: the first index past the last property. */
const SPDRP_MAXIMUM_PROPERTY = 0x25;

/**
 * Each property's value name and the type a program sets it with; null for
 * one that is not a value of the instance key, `settable` false for one
 * only the system writes.
 *
 * @type {ReadonlyMap<number, { name: string, type: number, settable: boolean }>}
 */
const PROPERTIES = new Map([
    [0x00, { name: 'DeviceDesc', type: REG_SZ, settable: true }],
    [0x01, { name: 'HardwareID', type: REG_MULTI_SZ, settable: true }],
    [0x02, { name: 'CompatibleIDs', type: REG_MULTI_SZ, settable: true }],
    [0x04, { name: 'Service', type: REG_SZ, settable: true }],
    [0x07, { name: 'Class', type: REG_SZ, settable: true }],
    [0x08, { name: 'ClassGUID', type: REG_SZ, settable: true }],
    [0x09, { name: 'Driver', type: REG_SZ, settable: true }],
    [0x0a, { name: 'ConfigFlags', type: REG_DWORD, settable: true }],
    [0x0b, { name: 'Mfg', type: REG_SZ, settable: true }],
    [0x0c, { name: 'FriendlyName', type: REG_SZ, settable: true }],
    [0x0d, { name: 'LocationInformation', type: REG_SZ, settable: true }],
    [0x0f, { name: 'Capabilities', type: REG_DWORD, settable: false }],
    [0x10, { name: 'UINumber', type: REG_DWORD, settable: false }],
    [0x11, { name: 'UpperFilters', type: REG_MULTI_SZ, settable: true }],
    [0x12, { name: 'LowerFilters', type: REG_MULTI_SZ, settable: true }],
    [0x17, { name: 'Security', type: REG_BINARY, settable: true }],
    [0x19, { name: 'DeviceType', type: REG_DWORD, settable: true }],
    [0x1a, { name: 'Exclusive', type: REG_DWORD, settable: true }],
    [0x1b, { name: 'DeviceCharacteristics', type: REG_DWORD, settable: true }],
    [0x1d, { name: 'UINumberDescFormat', type: REG_SZ, settable: true }],
    [0x21, { name: 'RemovalPolicy', type: REG_DWORD, settable: true }],
]);

/**
 * A property's entry -- its value name, type and whether a program sets
 * it -- null for an index with no value.
 *
 * @param {number} property
 */
export const propertyEntry = property=>PROPERTIES.get(property) ?? null;

/** The string types, whose data changes width between the hive and a W call. */
const STRINGS = new Set([REG_SZ, REG_EXPAND_SZ, REG_MULTI_SZ]);

/** @param {Uint8Array} ansi */
const widen = ansi=>{
    const text = decodeAnsi(ansi);
    const bytes = new Uint8Array(text.length * 2);
    const view = new DataView(bytes.buffer);
    for (let at = 0; at < text.length; at++)
    {
        view.setUint16(at * 2, text.charCodeAt(at), true);
    }
    return bytes;
};

/** @param {Uint8Array} wide */
const narrow = wide=>{
    const view = new DataView(wide.buffer, wide.byteOffset, wide.byteLength & ~1);
    let text = '';
    for (let at = 0; at + 1 < wide.byteLength; at += 2)
    {
        text += String.fromCharCode(view.getUint16(at, true));
    }
    return encodeAnsi(text);
};

/** @param {string} text  Terminated in the call's width. @param {boolean} wide */
const encoded = (text, wide)=>{
    const ansi = encodeAnsi(`${text}\0`);
    return wide ? widen(ansi) : ansi;
};

/**
 * A property's value as the call answers it: its type and its data, in the
 * call's width; or the error.
 *
 * @param {any} hive @param {any} key  The instance key.
 * @param {string} id @param {number} property @param {boolean} wide
 * @returns {{ type: number, data: Uint8Array } | { error: number }}
 */
export function readProperty(hive, key, id, property, wide){
    if (property >= SPDRP_MAXIMUM_PROPERTY)
    {
        return { error: ERROR_INVALID_REG_PROPERTY };
    }
    if (property === SPDRP_ENUMERATOR_NAME)
    {
        return { type: REG_SZ, data: encoded(id.split('\\')[0], wide) };
    }
    const entry = PROPERTIES.get(property);
    const value = entry && key ? hive.getValue(key, entry.name) : null;
    if (!value)
    {
        return { error: ERROR_INVALID_DATA };
    }
    return { type: value.type,
        data: wide && STRINGS.has(value.type) ? widen(value.data) : value.data };
}

/**
 * Sets a property from a call's data, or deletes it for none; the error, 0
 * for none.
 *
 * @param {any} hive @param {any} key  The instance key.
 * @param {number} property @param {Uint8Array | null} data @param {boolean} wide
 */
export function writeProperty(hive, key, property, data, wide){
    const entry = PROPERTIES.get(property);
    if (property >= SPDRP_MAXIMUM_PROPERTY || !entry?.settable)
    {
        return ERROR_INVALID_REG_PROPERTY;
    }
    if (!data || data.length === 0)
    {
        // Nothing to delete is a failure, as Windows answers it.
        return hive.deleteValue(key, entry.name) ? 0 : ERROR_INVALID_DATA;
    }
    hive.setValue(key, entry.name, entry.type,
        wide && STRINGS.has(entry.type) ? narrow(data) : data.slice());
    return 0;
}
