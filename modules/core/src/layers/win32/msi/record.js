/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Records: the installer's one container for a row, a message or a set of
 * parameters -- fields numbered from zero, each null, an integer, a string
 * or a stream.
 *
 * What a field reads back as depends on what it holds, not on what is asked:
 * an integer asked for as a string is its decimal digits, and a string asked
 * for as an integer is one only if it is nothing but digits behind an
 * optional minus sign. An empty string is not stored; it makes the field
 * null. A stream is read from where the last read stopped, and asking its
 * size starts it over.
 */

/** What MsiRecordGetInteger answers for a field that holds no integer. */
export const MSI_NULL_INTEGER = 0x80000000 | 0;

/** The most fields a record may have. */
export const MAX_FIELDS = 0xffff;

/**
 * Where a stream field's bytes come from.
 *
 * @typedef {Object} StreamSource
 * @property {number} size
 * @property {(offset: number, length: number) => Uint8Array | Promise<Uint8Array>} read
 */

/**
 * @typedef {null | number | string | { stream: StreamSource, position: number }} Field
 * @typedef {{ fields: Field[] }} Record   `fields[0]` through `fields[count]`.
 */

/** @param {number} count @returns {Record} */
export const createRecord = count=>({ fields: new Array(count + 1).fill(null) });

/** @param {Record} record */
export const fieldCount = record=>record.fields.length - 1;

/**
 * A string as an integer the way a record reads one: digits behind an
 * optional minus sign and nothing else, wrapping at 32 bits as the
 * multiplication does.
 *
 * @param {string} text @returns {number | null}
 */
export function integerOf(text){
    if (!/^-?[0-9]*$/.test(text) || text === '')
    {
        return null;
    }
    let value = 0;
    for (const digit of text.replace(/^-/, ''))
    {
        value = Math.imul(value, 10) + (digit.charCodeAt(0) - 48) | 0;
    }
    return text.startsWith('-') ? -value | 0 : value;
}

/** @param {Record} record @param {number} index */
export const isNull = (record, index)=>index < 0 || index >= record.fields.length
    || record.fields[index] === null;

/** @param {Record} record @param {number} index @returns {number} */
export function getInteger(record, index){
    const field = record.fields[index] ?? null;
    if (typeof field === 'number')
    {
        return field;
    }
    if (typeof field === 'string')
    {
        return integerOf(field) ?? MSI_NULL_INTEGER;
    }
    return MSI_NULL_INTEGER;
}

/**
 * The field as text: an integer's digits, a string as it is, '' for null.
 * A stream has no text.
 *
 * @param {Record} record @param {number} index @returns {string}
 */
export function getString(record, index){
    const field = record.fields[index] ?? null;
    if (typeof field === 'number')
    {
        return String(field);
    }
    return typeof field === 'string' ? field : '';
}

/**
 * What MsiRecordDataSize answers: a string's length, four for an integer,
 * a stream's size, nothing for null.
 *
 * @param {Record} record @param {number} index
 */
export function dataSize(record, index){
    const field = record.fields[index] ?? null;
    if (typeof field === 'number')
    {
        return 4;
    }
    if (typeof field === 'string')
    {
        return field.length;
    }
    return field === null ? 0 : field.stream.size;
}

/**
 * @param {Record} record @param {number} index @param {number} value
 * @returns {boolean} false when the field is out of range
 */
export function setInteger(record, index, value){
    if (index < 0 || index >= record.fields.length)
    {
        return false;
    }
    record.fields[index] = value === MSI_NULL_INTEGER ? null : value | 0;
    return true;
}

/**
 * @param {Record} record @param {number} index @param {string | null} value
 * @returns {boolean} false when the field is out of range
 */
export function setString(record, index, value){
    if (index < 0 || index >= record.fields.length)
    {
        return false;
    }
    record.fields[index] = value === null || value === '' ? null : value;
    return true;
}

/**
 * @param {Record} record @param {number} index @param {StreamSource} stream
 * @returns {boolean} false for field 0, which takes no stream, or out of range
 */
export function setStream(record, index, stream){
    if (index < 1 || index >= record.fields.length)
    {
        return false;
    }
    record.fields[index] = { stream, position: 0 };
    return true;
}

/** @param {Record} record */
export function clearRecord(record){
    record.fields.fill(null);
}

/** @param {Record} record @returns {Record} a copy that shares no stream position */
export const copyRecord = record=>({ fields: record.fields.map(field=>(
    field !== null && typeof field === 'object' ? { stream: field.stream, position: 0 } : field)),
});

/** @param {Uint8Array} bytes @returns {StreamSource} */
export const bytesStream = bytes=>({
    size: bytes.length,
    read: (offset, length)=>bytes.subarray(offset, offset + length),
});
