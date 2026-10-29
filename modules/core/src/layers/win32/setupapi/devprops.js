/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The unified device property model's values: a DEVPROPKEY -- a format
 * GUID and a property id -- names a value of a DEVPROPTYPE.
 *
 * A device's or an interface's own properties are kept under its key's
 * `Properties` subkey, one key a format and one a property, the id in four
 * hexadecimal digits; the value is the property key's unnamed value, its
 * registry type the DEVPROPTYPE with 0xffff0000 over it so that no reader
 * of the registry takes it for one of its own types.
 *
 * The properties the system keeps elsewhere -- an instance id, a class --
 * are the callers' to answer: this is the store, and the type rules.
 */

/** DEVPROPTYPE's base types and modifiers. */
export const DEVPROP_TYPE = Object.freeze({
    EMPTY: 0x0, NULL: 0x1, UINT32: 0x7, GUID: 0xd, STRING: 0x12, STRING_LIST: 0x2012,
});

const DEVPROP_TYPEMOD_ARRAY = 0x1000;
const DEVPROP_TYPEMOD_LIST = 0x2000;
const DEVPROP_MASK_TYPE = 0x0fff;
const DEVPROP_MASK_TYPEMOD = 0xf000;
/** DEVPROP_TYPE_STRING_INDIRECT: the last base type. */
const DEVPROP_TYPE_MAX = 0x19;

/** What a stored property's registry type carries over its DEVPROPTYPE. */
const STORED = 0xffff0000;

/** The size of a DEVPROPKEY: the format, then the id. */
export const DEVPROPKEY_SIZE = 20;

/**
 * Whether a DEVPROPTYPE is one: a base type with no modifier, an array of
 * one, or a list of strings.
 *
 * @param {number} type
 */
export function validType(type){
    const base = type & DEVPROP_MASK_TYPE;
    const modifier = type & DEVPROP_MASK_TYPEMOD;
    if ((type >>> 0) > 0xffff || base > DEVPROP_TYPE_MAX)
    {
        return false;
    }
    return modifier === 0 || modifier === DEVPROP_TYPEMOD_ARRAY
        || (modifier === DEVPROP_TYPEMOD_LIST && base === DEVPROP_TYPE.STRING);
}

/** @param {string} fmtid @param {number} pid */
const subkeyOf = (fmtid, pid)=>`Properties\\${fmtid}\\${pid.toString(16).padStart(4, '0')}`;

/**
 * A stored property, null for none.
 *
 * @param {any} hive @param {any} key @param {string} fmtid  Braced, lower case.
 * @param {number} pid
 * @returns {{ type: number, data: Uint8Array } | null}
 */
export function storedProperty(hive, key, fmtid, pid){
    const property = hive.open(key, subkeyOf(fmtid, pid));
    const value = property ? hive.getValue(property, '') : null;
    return value ? { type: (value.type & ~STORED) >>> 0, data: value.data } : null;
}

/**
 * Stores a property, replacing what was there.
 *
 * @param {any} hive @param {any} key @param {string} fmtid @param {number} pid
 * @param {number} type @param {Uint8Array} data
 */
export function storeProperty(hive, key, fmtid, pid, type, data){
    const { key: property } = hive.create(key, subkeyOf(fmtid, pid));
    hive.setValue(property, '', (STORED | type) >>> 0, data.slice());
}

/**
 * Deletes a stored property: whether there was one.
 *
 * @param {any} hive @param {any} key @param {string} fmtid @param {number} pid
 */
export function deleteProperty(hive, key, fmtid, pid){
    const format = hive.open(key, `Properties\\${fmtid}`);
    const name = pid.toString(16).padStart(4, '0');
    if (!format || !hive.open(format, name))
    {
        return false;
    }
    hive.remove(format, name);
    return true;
}

/**
 * The keys of the properties stored under a key, format by format.
 *
 * @param {any} hive @param {any} key
 * @returns {{ fmtid: string, pid: number }[]}
 */
export function storedKeys(hive, key){
    const properties = hive.open(key, 'Properties');
    if (!properties)
    {
        return [];
    }
    return hive.subkeys(properties).flatMap((/** @type {string} */ fmtid)=>
        hive.subkeys(hive.open(properties, fmtid))
            .filter((/** @type {string} */ name)=>/^[0-9a-f]{4}$/i.test(name))
            .map((/** @type {string} */ name)=>({ fmtid: fmtid.toLowerCase(),
                pid: Number.parseInt(name, 16) })));
}
