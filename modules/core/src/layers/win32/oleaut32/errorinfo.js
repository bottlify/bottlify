/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The error-information object: what CreateErrorInfo hands out, filled
 * through ICreateErrorInfo by the code that failed and read through
 * IErrorInfo by the code that caught it, with SetErrorInfo and GetErrorInfo
 * carrying it between the two.
 *
 * One object, two interfaces over the same five fields. The strings are
 * copied in on Set and copied out as fresh BSTRs on Get, because the caller
 * of Get frees what it is given and the caller of Set keeps what it passed.
 */

import { IUNKNOWN_METHODS } from '../ole32/objects.js';
import { readGuid, writeGuid } from '../ole32/guid.js';

/** The two interfaces. */
export const IID_ICREATEERRORINFO = '{22F03340-547D-101B-8E65-08002B2BD119}';
export const IID_IERRORINFO = '{1CF2B120-547D-101B-8E65-08002B2BD119}';

const S_OK = 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;

/**
 * @typedef {Object} ErrorInfoHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(object: any, interfaceId: string) => number} publish
 * @property {(text: string) => number} allocateBstr
 * @property {(state: ErrorInfoState, interfaces: Record<string, readonly any[]>) => any} adapt
 *           Makes the object the bridge publishes.
 */

/**
 * @typedef {Object} ErrorInfoState
 * @property {string | null} guid
 * @property {string | null} source
 * @property {string | null} description
 * @property {string | null} helpFile
 * @property {number} helpContext
 */

/**
 * @param {ErrorInfoHost} host
 * @returns {{ create: () => number }} the ICreateErrorInfo pointer, or 0
 */
export function createErrorInfoObjects(host){
    const memory = { readMemory: host.readMemory, writeMemory: host.writeMemory };

    /** @param {number} address @returns {string} */
    const readWide = address=>{
        let text = '';
        for (let at = address;; at += 2)
        {
            const bytes = host.readMemory(at, 2);
            const unit = bytes[0] | (bytes[1] << 8);
            if (unit === 0)
            {
                return text;
            }
            text += String.fromCharCode(unit);
        }
    };
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        host.writeMemory(address, Uint8Array.from([
            value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]));
    };

    /**
     * @param {string} name
     * @param {(state: ErrorInfoState, text: string | null) => void} set
     */
    const setter = (name, set)=>({
        name, argBytes: 8,
        /** @param {{ state: ErrorInfoState }} object @param {number[]} args */
        invoke: (object, [text])=>{
            set(object.state, (text >>> 0) === 0 ? null : readWide(text >>> 0));
            return S_OK;
        },
    });
    /**
     * @param {string} name
     * @param {(state: ErrorInfoState) => string | null} get
     */
    const getter = (name, get)=>({
        name, argBytes: 8,
        /** @param {{ state: ErrorInfoState }} object @param {number[]} args */
        invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const text = get(object.state);
            const bstr = text === null ? 0 : host.allocateBstr(text);
            writeU32(out >>> 0, bstr);
            return text !== null && bstr === 0 ? E_OUTOFMEMORY : S_OK;
        },
    });

    const CREATE_METHODS = Object.freeze([
        ...IUNKNOWN_METHODS,
        { name: 'SetGUID', argBytes: 8,
            /** @param {{ state: ErrorInfoState }} object @param {number[]} args */
            invoke: (object, [guid])=>{
                if ((guid >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                object.state.guid = readGuid(memory, guid >>> 0);
                return S_OK;
            } },
        setter('SetSource', (state, text)=>{
            state.source = text;
        }),
        setter('SetDescription', (state, text)=>{
            state.description = text;
        }),
        setter('SetHelpFile', (state, text)=>{
            state.helpFile = text;
        }),
        { name: 'SetHelpContext', argBytes: 8,
            /** @param {{ state: ErrorInfoState }} object @param {number[]} args */
            invoke: (object, [context])=>{
                object.state.helpContext = context >>> 0;
                return S_OK;
            } },
    ]);

    const ERROR_METHODS = Object.freeze([
        ...IUNKNOWN_METHODS,
        { name: 'GetGUID', argBytes: 8,
            /** @param {{ state: ErrorInfoState }} object @param {number[]} args */
            invoke: (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeGuid(memory, out >>> 0,
                    object.state.guid ?? '{00000000-0000-0000-0000-000000000000}');
                return S_OK;
            } },
        getter('GetSource', state=>state.source),
        getter('GetDescription', state=>state.description),
        getter('GetHelpFile', state=>state.helpFile),
        { name: 'GetHelpContext', argBytes: 8,
            /** @param {{ state: ErrorInfoState }} object @param {number[]} args */
            invoke: (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out >>> 0, object.state.helpContext);
                return S_OK;
            } },
    ]);
    const interfaces = Object.freeze({
        [IID_ICREATEERRORINFO]: CREATE_METHODS,
        [IID_IERRORINFO]: ERROR_METHODS,
    });

    return {
        create(){
            /** @type {ErrorInfoState} */
            const state = {
                guid: null, source: null, description: null, helpFile: null, helpContext: 0,
            };
            return host.publish(host.adapt(state, interfaces), IID_ICREATEERRORINFO) >>> 0;
        },
    };
}
