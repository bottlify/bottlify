/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * X.500 names as text, both ways: the strings CertNameToStr and
 * CertGetNameString write (`CN=www.example.test, O=Example`), and the ones
 * CertStrToName reads back into a DER Name.
 *
 * The keys are the ones wincrypt.h's documentation lists for the X.500 form;
 * an attribute without one is written `OID.2.5.4.99=` in that form and read
 * back from it. A value holding a separator, a quote or leading or trailing
 * blanks is quoted, its quotes doubled, as CertNameToStr quotes it.
 */

import { TAG } from '../crypto/der.js';
import { derElement, oidContents, readName } from '../crypto/x509.js';

/** CertNameToStr's string types. */
export const NAME_STR = Object.freeze({
    SIMPLE: 1, OID: 2, X500: 3,
    SEMICOLON_FLAG: 0x40000000, NO_PLUS_FLAG: 0x20000000, NO_QUOTING_FLAG: 0x10000000,
    CRLF_FLAG: 0x08000000, COMMA_FLAG: 0x04000000, REVERSE_FLAG: 0x02000000,
});

/** The X.500 keys, by OID. */
const KEYS = new Map([
    ['2.5.4.3', 'CN'], ['2.5.4.4', 'SN'], ['2.5.4.5', 'SERIALNUMBER'], ['2.5.4.6', 'C'],
    ['2.5.4.7', 'L'], ['2.5.4.8', 'S'], ['2.5.4.9', 'STREET'], ['2.5.4.10', 'O'],
    ['2.5.4.11', 'OU'], ['2.5.4.12', 'T'], ['2.5.4.42', 'G'], ['2.5.4.43', 'I'],
    ['1.2.840.113549.1.9.1', 'E'], ['0.9.2342.19200300.100.1.25', 'DC'],
]);

/** The keys CertStrToName reads, by upper-case key; `ST` and `EMAIL` too. */
/** @type {Map<string, string>} */
const OIDS = new Map([...KEYS].map(([oid, key])=>/** @type {[string, string]} */ ([key, oid])));
OIDS.set('ST', '2.5.4.8').set('EMAIL', '1.2.840.113549.1.9.1').set('GN', '2.5.4.42');

/** Attributes that are IA5String whatever their text. */
const IA5 = new Set(['1.2.840.113549.1.9.1', '0.9.2342.19200300.100.1.25']);

/**
 * A value as CertNameToStr writes it: quoted when it would otherwise not
 * read back as one value.
 *
 * @param {string} value @param {number} flags
 */
const quote = (value, flags)=>((flags & NAME_STR.NO_QUOTING_FLAG) === 0
    && (/[,+=";<>#\n\r]/.test(value) || /^\s|\s$/.test(value) || value === '')
    ? `"${value.replace(/"/g, '""')}"` : value);

/**
 * A Name's text in one of CertNameToStr's string types: RDNs in their order
 * (or reversed), joined by `, ` (`; ` or CRLF when asked), an RDN's own
 * attributes by ` + `.
 *
 * @param {Uint8Array} encoded @param {number} type
 * @returns {string}
 */
export function nameToString(encoded, type){
    const kind = type & 0xffff;
    let rdns = readName(encoded);
    if ((type & NAME_STR.REVERSE_FLAG) !== 0)
    {
        rdns = [...rdns].reverse();
    }
    const separator = (type & NAME_STR.SEMICOLON_FLAG) !== 0 ? '; '
        : (type & NAME_STR.CRLF_FLAG) !== 0 ? '\r\n' : ', ';
    const plus = (type & NAME_STR.NO_PLUS_FLAG) !== 0 ? separator : ' + ';
    return rdns.map(rdn=>rdn.map(attribute=>{
        const value = quote(attribute.value, type);
        if (kind === NAME_STR.SIMPLE)
        {
            return value;
        }
        const key = kind === NAME_STR.X500 ? KEYS.get(attribute.oid) : undefined;
        const named = key ?? (kind === NAME_STR.X500 ? `OID.${attribute.oid}` : attribute.oid);
        return `${named}=${value}`;
    }).join(plus)).join(separator);
}

/** Whether every character fits a PrintableString. @param {string} text */
const printable = text=>/^[A-Za-z0-9 '()+,\-./:=?]*$/.test(text);

/**
 * An attribute value as CertStrToName encodes it: an IA5String for an email
 * address or a domain component, a PrintableString where every character is
 * one, a UTF8String otherwise.
 *
 * @param {string} oid @param {string} value
 */
function encodeValue(oid, value){
    if (IA5.has(oid))
    {
        return derElement(TAG.IA5_STRING, Uint8Array.from(value, ch=>ch.charCodeAt(0) & 0x7f));
    }
    if (printable(value))
    {
        return derElement(TAG.PRINTABLE_STRING, Uint8Array.from(value, ch=>ch.charCodeAt(0)));
    }
    return derElement(TAG.UTF8_STRING, new TextEncoder().encode(value));
}

/**
 * The DER Name a CertStrToName string names, or the offset of the character
 * it could not read.
 *
 * @param {string} text @param {number} type  The string type and flags.
 * @returns {{ encoded: Uint8Array } | { error: number }}
 */
export function stringToName(text, type){
    const separators = (type & NAME_STR.SEMICOLON_FLAG) !== 0 ? ';'
        : (type & NAME_STR.COMMA_FLAG) !== 0 ? ',' : ',;';
    const breaks = (type & NAME_STR.CRLF_FLAG) !== 0 ? /[\r\n]/ : /(?!)/;
    /** @type {Uint8Array[][]} */
    const rdns = [];
    /** @type {Uint8Array[]} */
    let rdn = [];
    let at = 0;
    const skipBlanks = ()=>{
        while (at < text.length && /[ \t]/.test(text[at]))
        {
            at++;
        }
    };
    skipBlanks();
    while (at < text.length)
    {
        const keyStart = at;
        const equals = text.indexOf('=', at);
        if (equals < 0)
        {
            return { error: keyStart };
        }
        const key = text.slice(at, equals).trim();
        const oid = /^OID\./i.test(key) ? key.slice(4)
            : /^\d+(\.\d+)+$/.test(key) ? key : OIDS.get(key.toUpperCase());
        if (!oid || !/^\d+(\.\d+)+$/.test(oid))
        {
            return { error: keyStart };
        }
        at = equals + 1;
        skipBlanks();
        let value = '';
        if (text[at] === '"' && (type & NAME_STR.NO_QUOTING_FLAG) === 0)
        {
            at++;
            for (;;)
            {
                if (at >= text.length)
                {
                    return { error: at };
                }
                if (text[at] === '"')
                {
                    if (text[at + 1] === '"')
                    {
                        value += '"';
                        at += 2;
                        continue;
                    }
                    at++;
                    break;
                }
                value += text[at++];
            }
            skipBlanks();
        }
        else
        {
            const start = at;
            while (at < text.length && !separators.includes(text[at]) && text[at] !== '+'
                && !breaks.test(text[at]))
            {
                at++;
            }
            value = text.slice(start, at).trim();
        }
        rdn.push(derElement(TAG.SEQUENCE, derElement(TAG.OID, oidContents(oid)),
            encodeValue(oid, value)));
        if (at < text.length && text[at] === '+' && (type & NAME_STR.NO_PLUS_FLAG) === 0)
        {
            at++;
        }
        else
        {
            rdns.push(rdn);
            rdn = [];
            if (at < text.length)
            {
                if (!separators.includes(text[at]) && !breaks.test(text[at]))
                {
                    return { error: at };
                }
                at++;
            }
        }
        while (at < text.length && /[ \t\r\n]/.test(text[at]))
        {
            at++;
        }
    }
    if (rdn.length > 0)
    {
        rdns.push(rdn);
    }
    if ((type & NAME_STR.REVERSE_FLAG) !== 0)
    {
        rdns.reverse();
    }
    return { encoded: derElement(TAG.SEQUENCE,
        ...rdns.map(attributes=>derElement(TAG.SET, ...attributes))) };
}
