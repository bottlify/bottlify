/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Property sets: the summary information a document carries, kept in a
 * stream of its storage named after the set's FMTID.
 *
 * A set's stream or storage is named for its format: the two summary sets
 * by their documented names, every other by the FMTID itself written in 26
 * characters of five bits each ([MS-OLEPS] 2.23), the stream's name taking
 * the 0x05 that marks a property set in front.
 */

import { formatGuid, parseGuid } from './guid.js';

const S_OK = 0;
const E_INVALIDARG = 0x80070057 | 0;
const STG_E_INVALIDNAME = 0x800300fc | 0;

export const FMTID_SUMMARY_INFORMATION = '{F29F85E0-4FF9-1068-AB91-08002B27B3D9}';
export const FMTID_DOC_SUMMARY_INFORMATION = '{D5CDD502-2E9C-101B-9397-08002B2CF9AE}';
export const FMTID_USER_DEFINED_PROPERTIES = '{D5CDD505-2E9C-101B-9397-08002B2CF9AE}';

/** What marks an element of a storage as a property set. */
const PROPERTY_SET_MARK = '\x05';
const SUMMARY_NAME = `${PROPERTY_SET_MARK}SummaryInformation`;
const DOC_SUMMARY_NAME = `${PROPERTY_SET_MARK}DocumentSummaryInformation`;

/** The 32 characters a name is written in, a 5-bit value each. */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz012345';
/** Characters in a name made of an FMTID: 128 bits, five at a time. */
const ENCODED_LENGTH = 26;
/** CCH_MAX_PROPSTG_NAME, the longest name a caller's buffer is sized for. */
export const MAX_NAME_LENGTH = 31;

/**
 * The name a property set of `fmtid` is stored under, the 0x05 included.
 *
 * A character that starts a byte is a capital when it is a letter, so the
 * name says where each byte begins.
 *
 * @param {string} fmtid
 * @returns {string}
 */
export function nameOfFormat(fmtid){
    const key = fmtid.toUpperCase();
    if (key === FMTID_SUMMARY_INFORMATION)
    {
        return SUMMARY_NAME;
    }
    if (key === FMTID_DOC_SUMMARY_INFORMATION || key === FMTID_USER_DEFINED_PROPERTIES)
    {
        return DOC_SUMMARY_NAME;
    }
    const bytes = /** @type {Uint8Array} */ (parseGuid(fmtid));
    let bits = 0n;
    for (let index = bytes.length - 1; index >= 0; index--)
    {
        bits = (bits << 8n) | BigInt(bytes[index]);
    }
    let name = PROPERTY_SET_MARK;
    for (let at = 0; at < ENCODED_LENGTH; at++)
    {
        const character = ALPHABET[Number((bits >> BigInt(at * 5)) & 31n)];
        name += (at * 5) % 8 === 0 ? character.toUpperCase() : character;
    }
    return name;
}

/**
 * The FMTID a stored name stands for, letters of either case; null when it
 * names none.
 *
 * @param {string} name  With or without its 0x05.
 * @returns {string | null}
 */
export function formatOfName(name){
    const lower = name.toLowerCase();
    if (lower === SUMMARY_NAME.toLowerCase())
    {
        return FMTID_SUMMARY_INFORMATION;
    }
    if (lower === DOC_SUMMARY_NAME.toLowerCase())
    {
        return FMTID_DOC_SUMMARY_INFORMATION;
    }
    const text = lower.startsWith(PROPERTY_SET_MARK) ? lower.slice(1) : lower;
    if (text.length !== ENCODED_LENGTH)
    {
        return null;
    }
    let bits = 0n;
    for (let at = 0; at < ENCODED_LENGTH; at++)
    {
        const value = ALPHABET.indexOf(text[at]);
        if (value < 0)
        {
            return null;
        }
        bits |= BigInt(value) << BigInt(at * 5);
    }
    // The last character carries three bits; more than that is no FMTID.
    if (bits >> 128n !== 0n)
    {
        return null;
    }
    const bytes = new Uint8Array(16);
    for (let index = 0; index < bytes.length; index++)
    {
        bytes[index] = Number((bits >> BigInt(index * 8)) & 0xffn);
    }
    return formatGuid(bytes);
}

/**
 * @typedef {Object} PropertySetHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/** @param {PropertySetHost} host */
export function createPropertySetFunctions(host){
    /** @param {number} address @param {string} text */
    const writeWide = (address, text)=>{
        const bytes = new Uint8Array((text.length + 1) * 2);
        for (let index = 0; index < text.length; index++)
        {
            bytes[index * 2] = text.charCodeAt(index) & 0xff;
            bytes[index * 2 + 1] = text.charCodeAt(index) >>> 8;
        }
        host.writeMemory(address, bytes);
    };
    /** @param {number} address @returns {string} */
    const readWide = address=>{
        let text = '';
        for (let at = address; text.length <= MAX_NAME_LENGTH + 1; at += 2)
        {
            const bytes = host.readMemory(at, 2);
            const unit = bytes[0] | (bytes[1] << 8);
            if (unit === 0)
            {
                break;
            }
            text += String.fromCharCode(unit);
        }
        return text;
    };

    return {
        /**
         * HRESULT FmtIdToPropStgName(const FMTID *pfmtid, LPOLESTR oszName)
         *
         * The caller's buffer holds CCH_MAX_PROPSTG_NAME + 1 characters.
         */
        FmtIdToPropStgName: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([fmtid, out])=>{
                if ((fmtid >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeWide(out >>> 0, nameOfFormat(formatGuid(host.readMemory(fmtid >>> 0, 16))));
                return S_OK;
            },
        },

        /**
         * HRESULT PropStgNameToFmtId(const LPOLESTR oszName, FMTID *pfmtid)
         *
         * The out-pointer is checked first: a NULL name with somewhere to
         * answer is a bad name (stg_prop.c testFmtId).
         */
        PropStgNameToFmtId: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const fmtid = (name >>> 0) === 0 ? null : formatOfName(readWide(name >>> 0));
                if (fmtid === null)
                {
                    return STG_E_INVALIDNAME;
                }
                host.writeMemory(out >>> 0, /** @type {Uint8Array} */ (parseGuid(fmtid)));
                return S_OK;
            },
        },
    };
}
