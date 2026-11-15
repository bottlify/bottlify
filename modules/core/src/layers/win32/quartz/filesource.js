/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * File Source (Async.), CLSID_AsyncReader: a file as a stream of bytes a
 * parser pulls from, through the IAsyncReader of the one output pin it has
 * once IFileSourceFilter::Load has named a file.
 *
 * The pin offers the stream's type -- MEDIATYPE_Stream with the subtype the
 * file's first bytes name, the way Windows' check bytes under `Media Type`
 * name an AVI, a WAVE, an MPEG system or elementary stream -- and then the
 * same with no subtype; a type Load was given is offered instead. A sample's
 * times are byte positions in REFERENCE_TIME units, as IAsyncReader defines
 * them: a request reads [start / 10^7, stop / 10^7).
 */

import { describe } from './describe.js';
import {
    GUID_NULL, MEDIATYPE_STREAM, mediaType,
} from './filter.js';
import { CLSID_ASYNC_READER } from './interfaces.js';

const S_OK = 0x00000000;
const S_FALSE = 0x00000001;
const E_FAIL = 0x80004005 | 0;
const E_POINTER = 0x80004003 | 0;
const E_UNEXPECTED = 0x8000ffff | 0;
const E_INVALIDARG = 0x80070057 | 0;
const HRESULT_FILE_NOT_FOUND = 0x80070002 | 0;
const VFW_E_WRONG_STATE = 0x80040227 | 0;
const VFW_E_TIMEOUT = 0x8004022e | 0;
const VFW_E_BADALIGN = 0x8004020e | 0;

export const IID_IFILE_SOURCE_FILTER = '{56A868A6-0AD4-11CE-B03A-0020AF0BA770}';
export const IID_IASYNC_READER = '{56A868AA-0AD4-11CE-B03A-0020AF0BA770}';

/** IFileSourceFilter. @type {[string, number][]} */
const IFILE_SOURCE_FILTER_SLOTS = [['Load', 2], ['GetCurFile', 2]];
/** IAsyncReader. SyncRead takes a LONGLONG position: two words. @type {[string, number][]} */
const IASYNC_READER_SLOTS = [
    ['RequestAllocator', 3], ['Request', 2], ['WaitForNext', 3], ['SyncReadAligned', 1],
    ['SyncRead', 4], ['Length', 2], ['BeginFlush', 0], ['EndFlush', 0],
];

/** The stream subtypes Windows' check bytes name. */
export const MEDIASUBTYPE = {
    AVI: '{E436EB88-524F-11CE-9F53-0020AF0BA770}',
    WAVE: '{E436EB8B-524F-11CE-9F53-0020AF0BA770}',
    AU: '{E436EB8C-524F-11CE-9F53-0020AF0BA770}',
    AIFF: '{E436EB8D-524F-11CE-9F53-0020AF0BA770}',
    MPEG1_SYSTEM: '{E436EB84-524F-11CE-9F53-0020AF0BA770}',
    MPEG2_PROGRAM: '{E06D8022-DB46-11CF-B4D1-00805F6CBBEA}',
    MPEG1_VIDEO_CD: '{E436EB85-524F-11CE-9F53-0020AF0BA770}',
    MPEG1_VIDEO: '{E436EB86-524F-11CE-9F53-0020AF0BA770}',
    MPEG1_AUDIO: '{E436EB87-524F-11CE-9F53-0020AF0BA770}',
    MIDI: '{2E6E8300-C6F2-11CF-8F54-00A0C92202A5}',
};

/** IMediaSample's slots this calls on a sample it is handed. */
const SAMPLE = { GetPointer: 3, GetTime: 5, SetActualDataLength: 12 };
/** IMemAllocator's. */
const ALLOCATOR = { SetProperties: 3 };

/** A REFERENCE_TIME per byte: IAsyncReader's times are bytes times this. */
const UNITS = 10_000_000;

/**
 * @typedef {Object} OpenFile
 * @property {number} size
 * @property {(offset: number, length: number) => Promise<Uint8Array>} read
 * @property {() => void} close
 */

/**
 * @typedef {Object} FileSourceHost
 * @property {(path: string) => Promise<OpenFile | null>} open  A file of the volume, read only.
 */

/**
 * The subtype a file's first bytes name, GUID_NULL for none.
 *
 * @param {Uint8Array} head
 */
export function streamSubtype(head){
    const text = (/** @type {number} */ at, /** @type {number} */ length)=>
        String.fromCharCode(...head.subarray(at, at + length));
    if (text(0, 4) === 'RIFF' && text(8, 4) === 'AVI ')
    {
        return MEDIASUBTYPE.AVI;
    }
    if (text(0, 4) === 'RIFF' && text(8, 4) === 'WAVE')
    {
        return MEDIASUBTYPE.WAVE;
    }
    if (text(0, 4) === 'RIFF' && text(8, 4) === 'CDXA')
    {
        return MEDIASUBTYPE.MPEG1_VIDEO_CD;
    }
    if (text(0, 4) === '.snd')
    {
        return MEDIASUBTYPE.AU;
    }
    if (text(0, 4) === 'FORM' && (text(8, 4) === 'AIFF' || text(8, 4) === 'AIFC'))
    {
        return MEDIASUBTYPE.AIFF;
    }
    if (text(0, 4) === 'MThd')
    {
        return MEDIASUBTYPE.MIDI;
    }
    if (head[0] === 0 && head[1] === 0 && head[2] === 1)
    {
        if (head[3] === 0xba)
        {
            // A pack header's first bits say which: '01' is MPEG-2's, '0010' MPEG-1's.
            return (head[4] & 0xc0) === 0x40 ? MEDIASUBTYPE.MPEG2_PROGRAM
                : MEDIASUBTYPE.MPEG1_SYSTEM;
        }
        if (head[3] === 0xb3)
        {
            return MEDIASUBTYPE.MPEG1_VIDEO;
        }
    }
    if (text(0, 3) === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0))
    {
        return MEDIASUBTYPE.MPEG1_AUDIO;
    }
    return GUID_NULL;
}

/** @param {number} value */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/**
 * File Source's class over the filter base.
 *
 * @param {ReturnType<typeof import('./filter.js').createFilterBase>} base
 * @param {import('./filter.js').FilterHost} host
 * @param {FileSourceHost} files
 */
export function createFileSource(base, host, files){
    /** @param {number} address */
    const readQuad = address=>(host.readU32(address + 4) | 0) * 0x1_0000_0000
        + host.readU32(address);

    /**
     * @typedef {Object} SourceState
     * @property {string | null} path
     * @property {import('./filter.js').MediaType | null} given
     * @property {string} subtype
     * @property {OpenFile | null} file
     * @property {{ sample: number, user: number, answer: number }[]} done
     *           Requests read and not yet collected by WaitForNext.
     * @property {boolean} flushing
     * @property {(() => void)[]} waiting
     * @property {number} align   What RequestAllocator settled: a request starts and
     *           ends on a multiple of it.
     */

    /**
     * Reads a sample's range into its buffer: the part of it past the file's end
     * is not there, and a short read is S_FALSE.
     *
     * @param {OpenFile} file @param {number} sample
     */
    const fill = async(file, sample, align = 1)=>{
        const times = host.allocate(16);
        await base.call(sample, SAMPLE.GetTime, [times, times + 8]);
        const start = Math.floor(readQuad(times) / UNITS);
        const stop = Math.floor(readQuad(times + 8) / UNITS);
        host.free(times);
        if (start % align !== 0 || (stop - start) % align !== 0)
        {
            return VFW_E_BADALIGN;
        }
        const slot = host.allocate(4);
        await base.call(sample, SAMPLE.GetPointer, [slot]);
        const buffer = host.readU32(slot);
        host.free(slot);
        const length = Math.max(0, Math.min(stop, file.size) - start);
        if (length > 0)
        {
            host.writeMemory(buffer, await file.read(start, length));
        }
        await base.call(sample, SAMPLE.SetActualDataLength, [length]);
        return length === stop - start ? S_OK : S_FALSE;
    };

    /** @param {import('./filter.js').Pin} pin @returns {SourceState} */
    const sourceOf = pin=>pin.filter.state2;

    /** @type {Record<string, (pin: import('./filter.js').Pin, args: number[]) => number | Promise<number>>} */
    const reader = {
        /**
         * HRESULT RequestAllocator(IMemAllocator *pPreferred, ALLOCATOR_PROPERTIES *pProps,
         *                          IMemAllocator **ppActual)
         */
        RequestAllocator: async(pin, [preferred, props, out])=>{
            if ((props >>> 0) === 0 || (out >>> 0) === 0)
            {
                return E_POINTER;
            }
            // Any alignment is taken: a read lands where the sample's buffer is.
            if ((host.readU32((props >>> 0) + 8) | 0) <= 0)
            {
                host.writeMemory((props >>> 0) + 8, dword(1));
            }
            let allocator = preferred >>> 0;
            if (allocator !== 0)
            {
                await base.addRef(allocator);
            }
            else
            {
                allocator = await host.createInstance('{1E651CC0-B199-11D0-8212-00C04FC32C45}',
                    '{56A8689C-0AD4-11CE-B03A-0020AF0BA770}');
            }
            if (allocator === 0)
            {
                return E_FAIL;
            }
            const actual = host.allocate(16);
            const set = await base.call(allocator, ALLOCATOR.SetProperties, [props >>> 0, actual]);
            host.free(actual);
            if ((set | 0) < 0)
            {
                await base.release(allocator);
                host.writeMemory(out >>> 0, dword(0));
                return set === VFW_E_BADALIGN ? VFW_E_BADALIGN : set;
            }
            sourceOf(pin).align = Math.max(1, host.readU32((props >>> 0) + 8) | 0);
            host.writeMemory(out >>> 0, dword(allocator));
            return S_OK;
        },
        /** HRESULT Request(IMediaSample *pSample, DWORD_PTR dwUser) */
        Request: async(pin, [sample, user])=>{
            const source = sourceOf(pin);
            if ((sample >>> 0) === 0)
            {
                return E_POINTER;
            }
            if (source.flushing)
            {
                return VFW_E_WRONG_STATE;
            }
            if (!source.file)
            {
                return E_UNEXPECTED;
            }
            const answer = await fill(source.file, sample >>> 0, source.align);
            if (answer === VFW_E_BADALIGN)
            {
                return answer;
            }
            await base.addRef(sample >>> 0);
            source.done.push({ sample: sample >>> 0, user: user >>> 0, answer });
            source.waiting.shift()?.();
            return S_OK;
        },
        /** HRESULT WaitForNext(DWORD dwTimeout, IMediaSample **ppSample, DWORD_PTR *pdwUser) */
        WaitForNext: async(pin, [timeout, out, user])=>{
            const source = sourceOf(pin);
            if ((out >>> 0) === 0 || (user >>> 0) === 0)
            {
                return E_POINTER;
            }
            if (source.done.length === 0 && !source.flushing && timeout !== 0)
            {
                // A request is read when it is made, so one still owed is never
                // coming unless a flush ends the wait.
                await new Promise(resolve=>{
                    source.waiting.push(()=>resolve(undefined));
                    if (timeout !== 0xffffffff)
                    {
                        setTimeout(()=>resolve(undefined), timeout);
                    }
                });
            }
            const next = source.done.shift();
            if (!next)
            {
                host.writeMemory(out >>> 0, dword(0));
                host.writeMemory(user >>> 0, dword(0));
                return source.flushing ? VFW_E_WRONG_STATE : VFW_E_TIMEOUT;
            }
            // The reference the request took goes with the sample handed back.
            host.writeMemory(out >>> 0, dword(next.sample));
            host.writeMemory(user >>> 0, dword(next.user));
            await base.release(next.sample);
            return source.flushing ? VFW_E_WRONG_STATE : next.answer;
        },
        /** HRESULT SyncReadAligned(IMediaSample *pSample) */
        SyncReadAligned: (pin, [sample])=>{
            const source = sourceOf(pin);
            if ((sample >>> 0) === 0)
            {
                return E_POINTER;
            }
            return source.file ? fill(source.file, sample >>> 0, source.align) : E_UNEXPECTED;
        },
        /** HRESULT SyncRead(LONGLONG llPosition, LONG lLength, BYTE *pBuffer) */
        SyncRead: async(pin, [low, high, length, buffer])=>{
            const source = sourceOf(pin);
            if (!source.file)
            {
                return E_UNEXPECTED;
            }
            if ((length | 0) < 0)
            {
                return E_INVALIDARG;
            }
            const position = (high | 0) * 0x1_0000_0000 + (low >>> 0);
            const count = Math.max(0,
                Math.min(position + (length | 0), source.file.size) - position);
            if (count > 0)
            {
                host.writeMemory(buffer >>> 0, await source.file.read(position, count));
            }
            return count === (length | 0) ? S_OK : S_FALSE;
        },
        /** HRESULT Length(LONGLONG *pTotal, LONGLONG *pAvailable) */
        Length: (pin, [total, available])=>{
            const source = sourceOf(pin);
            if ((total >>> 0) === 0 || (available >>> 0) === 0)
            {
                return E_POINTER;
            }
            const size = source.file?.size ?? 0;
            const quad = new Uint8Array(8);
            new DataView(quad.buffer).setBigInt64(0, BigInt(size), true);
            host.writeMemory(total >>> 0, quad);
            host.writeMemory(available >>> 0, quad);
            return S_OK;
        },
        BeginFlush: pin=>{
            const source = sourceOf(pin);
            source.flushing = true;
            for (const wake of source.waiting.splice(0))
            {
                wake();
            }
            return S_OK;
        },
        EndFlush: pin=>{
            sourceOf(pin).flushing = false;
            return S_OK;
        },
    };

    /**
     * The stream's type, the one Load was given in its place, then the stream
     * with no subtype, which any parser of the stream takes.
     *
     * @param {SourceState} source
     */
    const offered = source=>[
        source.given ?? mediaType({ major: MEDIATYPE_STREAM, sub: source.subtype }),
        mediaType({ major: MEDIATYPE_STREAM, sub: GUID_NULL }),
    ];

    /** @type {import('./filter.js').PinSpec} */
    const outputPin = {
        name: 'Output',
        direction: 'output',
        types: pin=>offered(sourceOf(pin)),
        // What the pin offers, by its major type and subtype.
        accepts: (pin, type)=>offered(sourceOf(pin)).some(each=>each.major === type.major
            && each.sub === type.sub),
        interfaces: [describe(IID_IASYNC_READER, IASYNC_READER_SLOTS, reader)],
    };

    /** @type {Record<string, (filter: import('./filter.js').Filter, args: number[]) => number | Promise<number>>} */
    const fileSource = {
        /** HRESULT Load(LPCOLESTR pszFileName, const AM_MEDIA_TYPE *pmt) */
        Load: async(filter, [name, given])=>{
            /** @type {SourceState} */
            const source = filter.state2;
            if ((name >>> 0) === 0)
            {
                return E_POINTER;
            }
            if (source.path !== null)
            {
                return E_UNEXPECTED;
            }
            const path = host.readWideString(name >>> 0, 32767 * 2);
            const file = await files.open(path);
            if (!file)
            {
                return HRESULT_FILE_NOT_FOUND;
            }
            source.path = path;
            source.file = file;
            source.given = (given >>> 0) === 0 ? null : base.readMediaType(given >>> 0);
            source.subtype = streamSubtype(await file.read(0, Math.min(file.size, 16)));
            filter.pins.push(base.makePin(filter, outputPin));
            return S_OK;
        },
        /** HRESULT GetCurFile(LPOLESTR *ppszFileName, AM_MEDIA_TYPE *pmt) */
        GetCurFile: (filter, [nameOut, typeOut])=>{
            /** @type {SourceState} */
            const source = filter.state2;
            if ((nameOut >>> 0) === 0)
            {
                return E_POINTER;
            }
            // Before Load there is no file and no type, and that is the answer.
            if (source.path === null)
            {
                host.writeMemory(nameOut >>> 0, dword(0));
                if ((typeOut >>> 0) !== 0)
                {
                    host.writeMemory(typeOut >>> 0, new Uint8Array(0x48));
                }
                return S_OK;
            }
            const text = new Uint8Array(Uint16Array.from([...source.path, '\0'],
                char=>char.charCodeAt(0)).buffer);
            const at = host.allocate(text.length);
            host.writeMemory(at, text);
            host.writeMemory(nameOut >>> 0, dword(at));
            if ((typeOut >>> 0) !== 0)
            {
                base.writeMediaType(typeOut >>> 0, offered(source)[0]);
            }
            return S_OK;
        },
    };

    return base.defineFilter({
        clsid: CLSID_ASYNC_READER,
        /** @returns {SourceState} */
        state: ()=>({ path: null, given: null, subtype: GUID_NULL, file: null, done: [],
            flushing: false, waiting: [], align: 1 }),
        // The pin comes with the file Load names.
        pins: ()=>[],
        interfaces: ()=>[describe(IID_IFILE_SOURCE_FILTER, IFILE_SOURCE_FILTER_SLOTS, fileSource)],
        destroy: filter=>{
            /** @type {SourceState} */
            const source = filter.state2;
            source.file?.close();
            source.file = null;
        },
    });
}
