/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * mfreadwrite - Media Foundation's source reader and sink writer: a file,
 * byte stream or media source read as decoded samples, and samples written
 * out as one.
 *
 * This build has no decoder for what a program reads through it (WMA, WMV,
 * MP4 and the rest are Media Foundation's own codecs) and no media sources
 * to read with, so a reader is never made: a file that is there is refused
 * as one of a type Windows has no source for (MF_E_UNSUPPORTED_BYTESTREAM_TYPE)
 * and the loss is said with the file's name, a file that is not there as
 * not found, a scheme other than a file's as unsupported. A sink writer is
 * refused as not implemented, also said. What a program does on that refusal
 * -- FAudio's xWMA playing silence, FNA's video not starting -- is its own.
 */

import { formatGuid } from '../ole32/guid.js';

const E_NOTIMPL = 0x80004001 | 0;
const E_POINTER = 0x80004003 | 0;
/** HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND). */
const FILE_NOT_FOUND = 0x80070002 | 0;
export const MF_E_UNSUPPORTED_SCHEME = 0xc00d36c3 | 0;
export const MF_E_UNSUPPORTED_BYTESTREAM_TYPE = 0xc00d36c4 | 0;

export const CLSID_MF_READ_WRITE_CLASS_FACTORY = '{48E2ED0F-98C2-4A37-BED5-166312DDD83F}';
export const IID_IMF_READ_WRITE_CLASS_FACTORY = '{E7FE2E12-661C-40DA-92F9-4F002AB67627}';
const CLSID_MF_SOURCE_READER = '{1777133C-0881-411B-A577-AD545F0714C4}';

/**
 * @typedef {Object} MfReadWriteHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(path: string) => boolean | Promise<boolean>} exists
 *     Whether a file is there, by the program's own path rules (its current
 *     directory, its drive).
 * @property {(api: string, detail: string, kind?: 'loss') => void} [divergence]
 */

/**
 * The file a URL names, or null for a scheme other than a file's. A plain
 * path is a file; `file:` URLs are decoded to one.
 *
 * @param {string} url
 * @returns {string | null}
 */
export function fileOfUrl(url){
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]+):/.exec(url);
    if (!scheme)
    {
        return url;
    }
    if (scheme[1].toLowerCase() !== 'file')
    {
        return null;
    }
    let rest = url.slice(scheme[0].length).replace(/^\/\/(localhost)?\//i, '').replace(/^\/+/, '');
    try
    {
        rest = decodeURIComponent(rest);
    }
    catch {
        // A malformed escape is left as it is: the name is then not found.
    }
    return rest.replace(/\//g, '\\');
}

/**
 * @param {MfReadWriteHost} host
 */
export function createMfReadWriteFunctions(host){
    /** @param {number} at @param {number} value */
    const putU32 = (at, value)=>{
        if ((at >>> 0) !== 0)
        {
            host.writeMemory(at >>> 0, new Uint8Array(Uint32Array.of(value >>> 0).buffer));
        }
    };
    /** A NUL-ended UTF-16 string, read a page at a time. @param {number} at */
    const wide = at=>{
        let text = '';
        for (let address = at >>> 0; text.length < 32768;)
        {
            const bytes = host.readMemory(address, 0x1000 - (address & 0xfff));
            for (let i = 0; i + 1 < bytes.length; i += 2)
            {
                const unit = bytes[i] | bytes[i + 1] << 8;
                if (unit === 0)
                {
                    return text;
                }
                text += String.fromCharCode(unit);
            }
            address += bytes.length;
        }
        return text;
    };

    /**
     * A source reader for a URL, refused; why depends on what the URL names.
     *
     * @param {string} api @param {number} url @param {number} out
     * @returns {number | Promise<number>}
     */
    const readerFromUrl = (api, url, out)=>{
        if ((out >>> 0) === 0 || (url >>> 0) === 0)
        {
            return E_POINTER;
        }
        putU32(out, 0);
        const text = wide(url);
        const file = fileOfUrl(text);
        if (file === null)
        {
            host.divergence?.(api, `no source reader for ${text}: the scheme is not supported`,
                'loss');
            return MF_E_UNSUPPORTED_SCHEME;
        }
        const answer = (/** @type {boolean} */ found)=>{
            if (!found)
            {
                return FILE_NOT_FOUND;
            }
            host.divergence?.(api, `no source reader for ${file}: no media source or decoder`
                + ' reads it in this build', 'loss');
            return MF_E_UNSUPPORTED_BYTESTREAM_TYPE;
        };
        const found = host.exists(file);
        return typeof found === 'boolean' ? answer(found) : found.then(answer);
    };

    /**
     * A source reader for a byte stream or media source the program made,
     * refused: nothing here could decode what it delivers.
     *
     * @param {string} api @param {number} out
     */
    const readerFromObject = (api, out)=>{
        if ((out >>> 0) === 0)
        {
            return E_POINTER;
        }
        putU32(out, 0);
        host.divergence?.(api, 'no source reader over a program\'s stream or source: no decoder'
            + ' reads it in this build', 'loss');
        return MF_E_UNSUPPORTED_BYTESTREAM_TYPE;
    };

    /** @param {string} api @param {number} out */
    const noWriter = (api, out)=>{
        putU32(out, 0);
        host.divergence?.(api, 'no sink writer: nothing is written', 'loss');
        return E_NOTIMPL;
    };

    const FROM_URL = 'IMFReadWriteClassFactory::CreateInstanceFromURL';
    const FROM_OBJECT = 'IMFReadWriteClassFactory::CreateInstanceFromObject';
    /** The class factory a program reaches through CoCreateInstance. */
    const factory = {
        id: IID_IMF_READ_WRITE_CLASS_FACTORY,
        methods: [
            /**
             * HRESULT CreateInstanceFromURL(REFCLSID clsid, LPCWSTR url,
             *     IMFAttributes *attributes, REFIID riid, void **object)
             */
            { name: 'CreateInstanceFromURL', argBytes: 24,
                invoke: (/** @type {any} */ object, /** @type {number[]} */ [clsid, url, , , out])=>
                    (isReader(clsid) ? readerFromUrl(FROM_URL, url, out)
                        : noWriter(FROM_URL, out)) },
            /**
             * HRESULT CreateInstanceFromObject(REFCLSID clsid, IUnknown *unknown,
             *     IMFAttributes *attributes, REFIID riid, void **object)
             */
            { name: 'CreateInstanceFromObject', argBytes: 24,
                invoke: (/** @type {any} */ object, /** @type {number[]} */ [clsid, , , , out])=>
                    (isReader(clsid) ? readerFromObject(FROM_OBJECT, out)
                        : noWriter(FROM_OBJECT, out)) },
        ],
    };
    /** @param {number} clsid */
    const isReader = clsid=>(clsid >>> 0) !== 0
        && formatGuid(host.readMemory(clsid >>> 0, 16)) === CLSID_MF_SOURCE_READER;

    const table = {
        /** HRESULT MFCreateSourceReaderFromURL(LPCWSTR url, IMFAttributes *attributes, IMFSourceReader **reader) */
        MFCreateSourceReaderFromURL: { argBytes: 12,
            handler: (/** @type {number[]} */ [url, , out])=>
                readerFromUrl('MFCreateSourceReaderFromURL', url, out) },
        /**
         * HRESULT MFCreateSourceReaderFromByteStream(IMFByteStream *stream,
         *     IMFAttributes *attributes, IMFSourceReader **reader)
         */
        MFCreateSourceReaderFromByteStream: { argBytes: 12,
            handler: (/** @type {number[]} */ [, , out])=>
                readerFromObject('MFCreateSourceReaderFromByteStream', out) },
        /**
         * HRESULT MFCreateSinkWriterFromURL(LPCWSTR url, IMFByteStream *stream,
         *     IMFAttributes *attributes, IMFSinkWriter **writer)
         */
        MFCreateSinkWriterFromURL: { argBytes: 16,
            handler: (/** @type {number[]} */ [, , , out])=>noWriter('MFCreateSinkWriterFromURL', out) },
    };

    return {
        table,
        /** The class factory's definition, for the COM registry. */
        factory: ()=>({ interfaces: [factory], state: null }),
    };
}
