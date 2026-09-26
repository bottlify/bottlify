/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A method that answers the way QueryInterface does -- GetContainer, a
 * swap chain's device -- over the publisher's own interfaces.
 */

import { IID_IUNKNOWN } from '../../win32/ole32/objects.js';

const S_OK = 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;

/**
 * A GUID in guest memory as the braced string interfaces are keyed by: three
 * little-endian integers, then eight bytes as they stand.
 *
 * @param {{ readMemory: (address: number, length: number) => Uint8Array }} memory
 * @param {number} address
 * @returns {string}
 */
export function readGuid(memory, address){
    const bytes = memory.readMemory(address >>> 0, 16);
    const view = new DataView(bytes.buffer, bytes.byteOffset, 16);
    /** @param {number} value @param {number} width */
    const hex = (value, width)=>value.toString(16).toUpperCase().padStart(width, '0');
    const tail = [...bytes.subarray(8)].map(byte=>hex(byte, 2)).join('');
    return `{${hex(view.getUint32(0, true), 8)}-${hex(view.getUint16(4, true), 4)}-`
        + `${hex(view.getUint16(6, true), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}}`;
}

/**
 * Hands `object` back as the interface `id` names, the way QueryInterface on
 * it would: the pointer the publisher gives that interface, with a reference
 * taken, or a null pointer and E_NOINTERFACE for an interface it does not
 * have.
 *
 * @param {{ publish: (api: any, interfaces: any[], id: string) => number }} publisher
 * @param {{ writeU32: (address: number, value: number) => void }} fields
 * @param {any} object
 * @param {import('./com.js').InterfaceDescriptor[]} interfaces  Every one it has.
 * @param {string} id
 * @param {number} out
 * @returns {number} an HRESULT
 */
export function queryAs(publisher, fields, object, interfaces, id, out){
    if (id !== IID_IUNKNOWN && !interfaces.some(entry=>entry.id === id))
    {
        fields.writeU32(out >>> 0, 0);
        return E_NOINTERFACE;
    }
    const pointer = publisher.publish(object, interfaces, id);
    fields.writeU32(out >>> 0, pointer);
    if (pointer === 0)
    {
        return E_OUTOFMEMORY;
    }
    object.addRef();
    return S_OK;
}
