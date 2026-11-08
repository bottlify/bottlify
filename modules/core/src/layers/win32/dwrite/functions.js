/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * DirectWrite (dwrite.dll): the factory and the font system behind it - the
 * system collection and collections a program loads itself, families, fonts,
 * faces, font files and their loaders and streams - with the text analyzer
 * and glyph run analysis of `analyzer.js`.
 *
 * The system collection's faces are made here (`system.js`); a face a
 * program loads from a file is read from the file's tables, and is measured
 * and shaped like any, but has no rasteriser: its glyphs are not drawn
 * (decision A238). Text formats and layouts are not made: what asks for them
 * is refused, and said.
 *
 * The contract is the public dwrite.h (interfaces, layouts, GUIDs) and
 * Wine's dwrite tests (what Windows answers).
 */

import { createComObject } from '../ole32/objects.js';
import { createDeviceCalls } from '../d3dx9/device.js';
import { createAnalysis } from './analyzer.js';
import { createRenderTargets } from './render-target.js';
import { FONT_STYLE, SIMULATION, familiesOf, localized, matching, readFace } from './fonts.js';
import { FontFormatError, analyzeFile, openTypeTag, tagText } from './sfnt.js';
import { GLYPH_COUNT, SYSTEM_FAMILIES, UNITS_PER_EM, createSystemFace } from './system.js';

const S_OK = 0;
const E_NOTIMPL = 0x80004001 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_FAIL = 0x80004005 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
export const E_NOT_SUFFICIENT_BUFFER = 0x8007007a | 0;
const DWRITE_E_FILEFORMAT = 0x88985000 | 0;
const DWRITE_E_NOFONT = 0x88985002 | 0;
const DWRITE_E_FILENOTFOUND = 0x88985003 | 0;
const DWRITE_E_ALREADYREGISTERED = 0x88985006 | 0;
const DWRITE_E_UNSUPPORTEDOPERATION = 0x88985009 | 0;
/** DWRITE_FONT_FACE_TYPE values the factory reads before the file. */
const FACE_TYPE_UNKNOWN = 6;
const FACE_TYPE_RAW_CFF = 7;
/** GetCurrentObject's kind for a font. */
const OBJ_FONT = 6;

/** Interface ids, as dwrite.h declares them. */
export const IID = Object.freeze({
    UNKNOWN: '{00000000-0000-0000-C000-000000000046}',
    FACTORY: '{B859EE5A-D838-4B5B-A2E8-1ADC7D93DB48}',
    FONT_FILE_LOADER: '{727CAD4E-D6AF-4C9E-8A08-D695B11CAA49}',
    LOCAL_FONT_FILE_LOADER: '{B2D9F3EC-C9FE-4A11-A2EC-D86208F7C0A2}',
    FONT_FILE_STREAM: '{6D4865FE-0AB8-4D91-8F62-5DD6BE34A3E0}',
    FONT_FILE: '{739D886A-CEF5-47DC-8769-1A8B41BEBBB0}',
    RENDERING_PARAMS: '{2F0DA53A-2ADD-47CD-82EE-D9EC34688E75}',
    FONT_FACE: '{5F49804D-7024-4D43-BFA9-D25984F53849}',
    LOCALIZED_STRINGS: '{08256209-099A-4B34-B86D-C22B110E7771}',
    FONT_COLLECTION: '{A84CEE02-3EEA-4EEE-A827-87C1A02A0FCC}',
    FONT_LIST: '{1A0D8438-1D97-4EC1-AEF9-A2FB86ED6ACB}',
    FONT_FAMILY: '{DA20D8EF-812A-4C43-9802-62EC4ABD7ADD}',
    FONT: '{ACD16696-8C14-4F5D-877E-FE3FC1D32737}',
    NUMBER_SUBSTITUTION: '{14885CC9-BAB0-4F90-B6ED-5C366A2CD03D}',
    TEXT_ANALYZER: '{B7E6163E-7F46-43B4-84B3-E4E6249C365D}',
    GDI_INTEROP: '{1EDD9491-9853-4299-898F-6432983B6F3A}',
    GLYPH_RUN_ANALYSIS: '{7D97DBF7-E085-42D4-81E3-6A883BDED118}',
    BITMAP_RENDER_TARGET: '{5E5A32A3-8DFF-4773-9FF6-0696EAB77267}',
});

/** @typedef {import('../ole32/objects.js').ComMethod} ComMethod */

/** DWRITE_FACTORY_TYPE. */
const SHARED = 0;
const ISOLATED = 1;

/** @typedef {import('./host.js').DwriteHost} DwriteHost */

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);
/** A float argument's bits as the number. @param {number} bits */
export const f32 = bits=>{
    U32[0] = bits >>> 0;
    return F32[0];
};
/** A number as a float's bits. @param {number} value */
export const bitsOf = value=>{
    F32[0] = value;
    return U32[0];
};

/**
 * @param {DwriteHost} host
 */
export function createDwriteFunctions(host){
    const { u32, putU32s, method, string } = createDeviceCalls(host);
    /** @type {Set<string>} */
    const said = new Set();
    /** @param {string} api @param {string} detail @param {'loss'} [kind] */
    const say = (api, detail, kind)=>{
        if (!said.has(`${api}|${detail}`))
        {
            said.add(`${api}|${detail}`);
            host.divergence?.(api, detail, kind);
        }
    };
    /** @param {number} at @param {string} text */
    const putWide = (at, text)=>{
        const bytes = new Uint8Array((text.length + 1) * 2);
        for (let i = 0; i < text.length; i++)
        {
            bytes[i * 2] = text.charCodeAt(i) & 0xff;
            bytes[i * 2 + 1] = text.charCodeAt(i) >> 8;
        }
        host.writeMemory(at >>> 0, bytes);
    };
    /** @param {number} at @param {number} count */
    const readU16s = (at, count)=>{
        const bytes = host.readMemory(at >>> 0, count * 2);
        return Array.from({ length: count }, (_, i)=>bytes[i * 2] | bytes[i * 2 + 1] << 8);
    };

    /**
     * An object of these interfaces, its first the class's name.
     *
     * @param {any[]} interfaces @param {any} state @param {() => void} [destroy]
     */
    const newObject = (interfaces, state, destroy)=>createComObject(interfaces[0].id,
        { interfaces, state, destroy });

    /**
     * An interface of an object written to `out`: the program's reference, the
     * one the object was made with or one taken now.
     *
     * @param {number} out @param {any} object @param {string} iid @param {boolean} [taken]
     *     whether the reference was taken for this pointer already
     */
    const give = (out, object, iid, taken = true)=>{
        const pointer = host.vtables.publish(object, iid) >>> 0;
        if (pointer === 0)
        {
            putU32s(out, [0]);
            return E_NOINTERFACE;
        }
        if (!taken)
        {
            object.addRef();
        }
        putU32s(out, [pointer]);
        return S_OK;
    };

    /** A program's COM object's AddRef or Release. @param {number} pointer @param {1 | 2} slot */
    const touch = (pointer, slot)=>method(host.currentThread(), pointer, slot, []);

    /** Scratch guest memory for a call's out-parameters. @param {number} bytes */
    const scratch = bytes=>{
        const at = host.heap.allocate(Math.max(4, bytes));
        if (at === 0)
        {
            throw new Error('dwrite: the heap is full');
        }
        host.writeMemory(at, new Uint8Array(Math.max(4, bytes)));
        return at;
    };

    /** Guest copies of files and tables, kept while a face or stream lives. @type {Map<Uint8Array, number>} */
    const guestCopies = new Map();
    /** @param {Uint8Array} bytes */
    const inGuest = bytes=>{
        let at = guestCopies.get(bytes);
        if (at === undefined)
        {
            at = host.heap.allocate(Math.max(1, bytes.length)) >>> 0;
            if (at === 0)
            {
                throw new Error('dwrite: the heap is full');
            }
            host.writeMemory(at, bytes);
            guestCopies.set(bytes, at);
        }
        return at;
    };

    // ----- Files -----

    /** A quadword as its two words, low first. @param {bigint} value */
    const words = value=>[Number(value & 0xffffffffn), Number(value >> 32n & 0xffffffffn)];

    /**
     * The local loader's key for a file: its last write (a FILETIME) and its
     * path, NUL-ended, as Windows keys a file it reads itself.
     *
     * @param {string} path @param {bigint} modified
     */
    const localKey = (path, modified)=>{
        const key = new Uint8Array(8 + (path.length + 1) * 2);
        const view = new DataView(key.buffer);
        view.setBigUint64(0, BigInt.asUintN(64, modified), true);
        for (let i = 0; i < path.length; i++)
        {
            view.setUint16(8 + i * 2, path.charCodeAt(i), true);
        }
        return key;
    };
    /** A local key's path and last write. @param {Uint8Array} key */
    const fromLocalKey = key=>{
        const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
        let path = '';
        for (let at = 8; at + 1 < key.length; at += 2)
        {
            const unit = view.getUint16(at, true);
            if (unit === 0)
            {
                break;
            }
            path += String.fromCharCode(unit);
        }
        return { path, modified: key.length >= 8 ? view.getBigUint64(0, true) : 0n };
    };

    /** The system faces, made once: by path. */
    const systemFiles = new Map(SYSTEM_FAMILIES.flatMap(family=>family.fonts.map(font=>[
        font.path.toLowerCase(), font])));
    /** @type {Map<string, ReturnType<typeof createSystemFace>>} */
    const systemFaces = new Map();
    /** @param {string} path */
    const systemFace = path=>{
        const font = systemFiles.get(path.toLowerCase());
        if (!font)
        {
            return null;
        }
        let face = systemFaces.get(font.path);
        if (!face)
        {
            face = createSystemFace(font, host.measure);
            systemFaces.set(font.path, face);
        }
        return face;
    };

    /** @type {Map<string, import('./fonts.js').FileRef>} */
    const files = new Map();
    /**
     * The file a key names through a loader, one record per key.
     *
     * @param {number} loader @param {Uint8Array} key
     * @returns {import('./fonts.js').FileRef}
     */
    const fileRef = (loader, key)=>{
        const id = `${loader}:${[...key].join(',')}`;
        let file = files.get(id);
        if (!file)
        {
            const path = loader === 0 ? fromLocalKey(key).path : null;
            file = { id, key, loader, path, bytes: null,
                system: path === null ? null : systemFace(path) };
            files.set(id, file);
        }
        return file;
    };

    /**
     * A program's stream's bytes: its size, then the whole file as one
     * fragment, given back.
     *
     * @param {number} stream @param {any} thread
     */
    const readStream = async(stream, thread)=>{
        const out = scratch(16);
        try
        {
            // IDWriteFontFileStream: ReadFileFragment 3, ReleaseFileFragment 4, GetFileSize 5.
            let hr = await method(thread, stream, 5, [out]);
            const size = u32(out);
            if (hr !== 0 || u32(out + 4) !== 0)
            {
                return null;
            }
            hr = await method(thread, stream, 3, [out, 0, 0, size, 0, out + 8]);
            if (hr !== 0)
            {
                return null;
            }
            const bytes = host.readMemory(u32(out), size).slice();
            await method(thread, stream, 4, [u32(out + 8)]);
            return bytes;
        }
        finally
        {
            host.heap.free(out);
        }
    };

    /** Why a program's loader gave no bytes, by file. @type {WeakMap<object, number>} */
    const failures = new WeakMap();
    /** The HRESULT a file not read answers with. @param {import('./fonts.js').FileRef} file */
    const failureOf = file=>failures.get(file) ?? DWRITE_E_FILENOTFOUND;
    /**
     * A file's bytes: a system face's tables, the local file's, or what the
     * program's loader streams.
     *
     * @param {import('./fonts.js').FileRef} file
     * @param {any} [thread]  the caller's, taken before any await
     * @returns {Promise<Uint8Array | null>}
     */
    const bytesOf = async(file, thread = host.currentThread())=>{
        if (file.bytes)
        {
            return file.bytes;
        }
        if (file.system)
        {
            file.bytes = file.system.bytes();
        }
        else if (file.loader === 0)
        {
            file.bytes = await host.readFile(/** @type {string} */ (file.path)) ?? null;
        }
        else
        {
            const key = inGuest(file.key);
            const out = scratch(4);
            try
            {
                // IDWriteFontFileLoader::CreateStreamFromKey(key, size, &stream).
                const hr = await method(thread, file.loader, 3, [key, file.key.length, out]);
                const stream = u32(out);
                if (hr === 0 && stream !== 0)
                {
                    file.bytes = await readStream(stream, thread);
                    await method(thread, stream, 2, []);
                }
                // What the program's loader answered is what reading the file answers.
                if (!file.bytes)
                {
                    failures.set(file, hr !== 0 ? hr | 0 : E_FAIL);
                }
            }
            finally
            {
                host.heap.free(out);
            }
        }
        return file.bytes;
    };

    // ----- Interfaces -----

    /** @param {number} count  arguments after `this` @returns {number} */
    const bytes = count=>4 + count * 4;

    /** @type {Record<string, import('../ole32/objects.js').ComInterfaceDescriptor>} */
    const descriptors = {};

    /**
     * IDWriteLocalizedStrings over [locale, text] pairs.
     *
     * @param {import('./fonts.js').Localized} entries
     */
    const newStrings = entries=>newObject([descriptors.strings], { entries });

    descriptors.strings = { id: IID.LOCALIZED_STRINGS, methods: [
        /** UINT32 GetCount() */
        { name: 'GetCount', argBytes: bytes(0), invoke: o=>
            o.state.entries.length },
        /** HRESULT FindLocaleName(WCHAR const*, UINT32 *index, BOOL *exists) */
        { name: 'FindLocaleName', argBytes: bytes(3), invoke: (o, [name, indexAt, existsAt])=>{
            const wanted = (name >>> 0) === 0 ? '' : string(name, true, 85).toLowerCase();
            const index = o.state.entries.findIndex((/** @type {[string, string]} */ [locale])=>
                locale === wanted);
            putU32s(indexAt, [index < 0 ? 0xffffffff : index]);
            putU32s(existsAt, [index < 0 ? 0 : 1]);
            return S_OK;
        } },
        ...['Locale', 'String'].flatMap(/** @returns {ComMethod[]} */ kind=>{
            const pick = kind === 'Locale' ? 0 : 1;
            return [
                /** HRESULT Get{Locale,String}Length(UINT32 index, UINT32 *length) */
                { name: `Get${kind === 'Locale' ? 'LocaleName' : 'String'}Length`,
                    argBytes: bytes(2), invoke: (o, [index, lengthAt])=>{
                        const entry = o.state.entries[index >>> 0];
                        if (!entry)
                        {
                            putU32s(lengthAt, [0xffffffff]);
                            return E_FAIL;
                        }
                        putU32s(lengthAt, [entry[pick].length]);
                        return S_OK;
                    } },
                /** HRESULT Get{LocaleName,String}(UINT32 index, WCHAR *buffer, UINT32 size) */
                { name: kind === 'Locale' ? 'GetLocaleName' : 'GetString', argBytes: bytes(3),
                    invoke: (o, [index, buffer, size])=>{
                        const entry = o.state.entries[index >>> 0];
                        if ((buffer >>> 0) !== 0 && (size >>> 0) > 0)
                        {
                            putWide(buffer, '');
                        }
                        if (!entry)
                        {
                            return E_FAIL;
                        }
                        if ((size >>> 0) <= entry[pick].length)
                        {
                            return E_NOT_SUFFICIENT_BUFFER;
                        }
                        putWide(buffer, entry[pick]);
                        return S_OK;
                    } },
            ];
        }),
    ] };
    // The interface's order: FindLocaleName, GetLocaleNameLength, GetLocaleName,
    // GetStringLength, GetString.

    /**
     * IDWriteRenderingParams: gamma, enhanced contrast, ClearType level, pixel
     * geometry, rendering mode.
     *
     * @param {number[]} values  the three floats, then the two enums
     */
    const newParams = values=>newObject([descriptors.params], { values });
    /** A float answered in ST(0). @param {string} api @param {number} value */
    const floatAnswer = (api, value)=>{
        if (host.fpu)
        {
            host.fpu.setResult(value);
        }
        else
        {
            say(api, 'a float answer with no floating-point register to give it in', 'loss');
        }
        return 0;
    };
    descriptors.params = { id: IID.RENDERING_PARAMS, methods: [
        ...['GetGamma', 'GetEnhancedContrast', 'GetClearTypeLevel'].map(
            /** @returns {ComMethod} */ (name, i)=>({ name, argBytes: bytes(0),
                invoke: o=>floatAnswer(`IDWriteRenderingParams::${name}`, o.state.values[i]) })),
        { name: 'GetPixelGeometry', argBytes: bytes(0), invoke: o=>
            o.state.values[3] },
        { name: 'GetRenderingMode', argBytes: bytes(0), invoke: o=>
            o.state.values[4] },
    ] };

    /** IDWriteNumberSubstitution: the method, locale and override it was made with. */
    descriptors.numberSubstitution = { id: IID.NUMBER_SUBSTITUTION, methods: [] };

    /** A key a program passes, copied. @param {number} at @param {number} size */
    const keyAt = (at, size)=>host.readMemory(at >>> 0, size >>> 0).slice();
    const createStream = async(/** @type {Uint8Array} */ key, /** @type {number} */ out)=>{
        if ((out >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        putU32s(out, [0]);
        const file = fileRef(0, key);
        const data = await bytesOf(file);
        if (!data)
        {
            return DWRITE_E_FILENOTFOUND;
        }
        return give(out, newStream(data, fromLocalKey(key).modified), IID.FONT_FILE_STREAM);
    };
    /** @type {ComMethod[]} */
    const loaderMethods = [
        /** HRESULT CreateStreamFromKey(void const *key, UINT32 size, IDWriteFontFileStream**) */
        { name: 'CreateStreamFromKey', argBytes: bytes(3), invoke: (_o, [key, size, out])=>
            ((key >>> 0) === 0 ? E_INVALIDARG : createStream(keyAt(key, size), out)) },
    ];
    descriptors.fileLoader = { id: IID.FONT_FILE_LOADER, methods: loaderMethods };
    descriptors.localLoader = { id: IID.LOCAL_FONT_FILE_LOADER, methods: [...loaderMethods,
        /** HRESULT GetFilePathLengthFromKey(void const *key, UINT32 size, UINT32 *length) */
        { name: 'GetFilePathLengthFromKey', argBytes: bytes(3), invoke: (_o, [key, size, out])=>{
            if ((key >>> 0) === 0 || (out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [fromLocalKey(keyAt(key, size)).path.length]);
            return S_OK;
        } },
        /** HRESULT GetFilePathFromKey(void const *key, UINT32 size, WCHAR *path, UINT32 length) */
        { name: 'GetFilePathFromKey', argBytes: bytes(4), invoke: (_o, args)=>{
            const [key, size, buffer, length] = args;
            if ((key >>> 0) === 0 || (buffer >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const { path } = fromLocalKey(keyAt(key, size));
            if ((length >>> 0) <= path.length)
            {
                return E_NOT_SUFFICIENT_BUFFER;
            }
            putWide(buffer, path);
            return S_OK;
        } },
        /** HRESULT GetLastWriteTimeFromKey(void const *key, UINT32 size, FILETIME*) */
        { name: 'GetLastWriteTimeFromKey', argBytes: bytes(3), invoke: (_o, [key, size, out])=>{
            if ((key >>> 0) === 0 || (out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const { modified } = fromLocalKey(keyAt(key, size));
            putU32s(out, words(modified));
            return S_OK;
        } },
    ] };
    // The local font file loader: one for the process, alive as long as it is.
    const localLoader = createComObject(IID.LOCAL_FONT_FILE_LOADER, { owned: true,
        interfaces: [descriptors.localLoader, descriptors.fileLoader], state: null });

    /**
     * IDWriteFontFileStream over bytes, kept in guest memory while it lives.
     *
     * @param {Uint8Array} data @param {bigint} modified
     */
    const newStream = (data, modified)=>newObject([descriptors.stream], { data, at: 0,
        modified }, ()=>{});
    descriptors.stream = { id: IID.FONT_FILE_STREAM, methods: [
        /**
         * HRESULT ReadFileFragment(void const **start, UINT64 offset, UINT64 size,
         *     void **context)
         */
        { name: 'ReadFileFragment', argBytes: bytes(6), invoke: (o, args)=>{
            const [startAt, offsetLow, offsetHigh, sizeLow, sizeHigh, contextAt] = args;
            putU32s(startAt, [0]);
            putU32s(contextAt, [0]);
            const offset = (offsetLow >>> 0) + (offsetHigh >>> 0) * 0x100000000;
            const size = (sizeLow >>> 0) + (sizeHigh >>> 0) * 0x100000000;
            if (offset > o.state.data.length || size > o.state.data.length - offset)
            {
                return E_FAIL;
            }
            putU32s(startAt, [inGuest(o.state.data) + offset]);
            return S_OK;
        } },
        /** void ReleaseFileFragment(void *context) */
        { name: 'ReleaseFileFragment', argBytes: bytes(1), invoke: ()=>0 },
        /** HRESULT GetFileSize(UINT64 *size) */
        { name: 'GetFileSize', argBytes: bytes(1), invoke: (o, [out])=>{
            putU32s(out, [o.state.data.length, 0]);
            return S_OK;
        } },
        /** HRESULT GetLastWriteTime(UINT64 *time) */
        { name: 'GetLastWriteTime', argBytes: bytes(1), invoke: (o, [out])=>{
            putU32s(out, words(o.state.modified));
            return S_OK;
        } },
    ] };

    /**
     * IDWriteFontFile: a file reference, its key in guest memory while it lives.
     *
     * @param {import('./fonts.js').FileRef} file
     */
    const newFile = file=>newObject([descriptors.file], { file, key: inGuest(file.key) });
    // A file holds no reference of its loader's: the factory's registration
    // holds it, and a program's AddRef and Release cannot be called from a
    // Release, which is where a file's would go.
    descriptors.file = { id: IID.FONT_FILE, methods: [
        /** HRESULT GetReferenceKey(void const **key, UINT32 *size) */
        { name: 'GetReferenceKey', argBytes: bytes(2), invoke: (o, [keyOut, sizeOut])=>{
            putU32s(keyOut, [o.state.key]);
            putU32s(sizeOut, [o.state.file.key.length]);
            return S_OK;
        } },
        /** HRESULT GetLoader(IDWriteFontFileLoader**) */
        { name: 'GetLoader', argBytes: bytes(1), invoke: async(o, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const { loader } = o.state.file;
            if (loader !== 0)
            {
                await touch(loader, 1);
                putU32s(out, [loader]);
                return S_OK;
            }
            return give(out, localLoader, IID.FONT_FILE_LOADER, false);
        } },
        /**
         * HRESULT Analyze(BOOL *isSupported, DWRITE_FONT_FILE_TYPE*, DWRITE_FONT_FACE_TYPE*,
         *     UINT32 *numberOfFaces)
         */
        { name: 'Analyze', argBytes: bytes(4), invoke: async(o, args)=>{
            const [supportedAt, fileTypeAt, faceTypeAt, countAt] = args;
            const data = await bytesOf(o.state.file);
            const kind = data ? analyzeFile(data) : { fileType: 0, faceType: 6, faces: [] };
            putU32s(supportedAt, [kind.faces.length ? 1 : 0]);
            if ((fileTypeAt >>> 0) !== 0)
            {
                putU32s(fileTypeAt, [kind.fileType]);
            }
            if ((faceTypeAt >>> 0) !== 0)
            {
                putU32s(faceTypeAt, [kind.faceType]);
            }
            putU32s(countAt, [kind.faces.length]);
            return data ? S_OK : failureOf(o.state.file);
        } },
    ] };

    // ----- Faces -----

    /** @type {Map<string, import('./fonts.js').Face>} */
    const faceData = new Map();
    /**
     * A face of a file, read once for each index and simulations.
     *
     * @param {import('./fonts.js').FileRef} file @param {Uint8Array} data
     * @param {number} index @param {number} simulations
     */
    const faceOf = (file, data, index, simulations)=>{
        const id = `${file.id}|${index}|${simulations}`;
        let face = faceData.get(id);
        if (!face)
        {
            face = readFace(file, data, index, simulations);
            faceData.set(id, face);
        }
        return face;
    };

    /**
     * A face's glyph's design metrics: its advance, side bearings and the
     * vertical ones (the em box's, a face here has no vertical metrics).
     *
     * @param {import('./fonts.js').Face} face @param {number} glyph
     */
    const designMetrics = (face, glyph)=>{
        const advance = face.system ? face.system.advance(glyph) : face.glyphs.advance(glyph);
        const box = face.system ? face.system.box(glyph) : face.glyphs.box(glyph);
        const lsb = box ? box.xMin : face.system ? 0 : face.glyphs.leftBearing(glyph);
        const { ascent, descent } = face.metrics;
        const height = ascent + descent;
        return { leftSideBearing: lsb, advanceWidth: advance,
            rightSideBearing: box ? advance - box.xMax : advance - lsb,
            topSideBearing: box ? ascent - box.yMax : 0, advanceHeight: height,
            bottomSideBearing: box ? descent + box.yMin : 0, verticalOriginY: ascent };
    };

    /** IDWriteFontFace objects alive, one for each face, per factory. */
    const newFace = (/** @type {any} */ factory, /** @type {import('./fonts.js').Face} */ face)=>{
        const cache = factory.state.faces;
        const alive = cache.get(face);
        if (alive)
        {
            alive.addRef();
            return alive;
        }
        factory.addRef();
        const object = newObject([descriptors.face], { face, factory, fileObject: null },
            ()=>{
                cache.delete(face);
                object.state.fileObject?.release();
                factory.release();
            });
        cache.set(face, object);
        return object;
    };
    /** @param {number} pointer @returns {import('./fonts.js').Face | null} */
    const faceAt = pointer=>{
        const object = (pointer >>> 0) === 0 ? null : host.objectAt(pointer >>> 0);
        return object?.state?.face ?? null;
    };
    /** DWRITE_FONT_METRICS, 20 bytes. @param {number} at @param {import('./fonts.js').Face} face */
    const putMetrics = (at, face)=>{
        const m = face.metrics;
        const bytesOut = new Uint8Array(20);
        const view = new DataView(bytesOut.buffer);
        [m.designUnitsPerEm, m.ascent, m.descent, m.lineGap, m.capHeight, m.xHeight,
            m.underlinePosition, m.underlineThickness, m.strikethroughPosition,
            m.strikethroughThickness].forEach((value, i)=>view.setUint16(i * 2, value & 0xffff,
            true));
        host.writeMemory(at >>> 0, bytesOut);
    };
    /**
     * DWRITE_GLYPH_METRICS of each glyph, 28 bytes each; glyph numbers past the
     * face's count refused.
     *
     * @param {import('./fonts.js').Face} face @param {number} indicesAt @param {number} count
     * @param {number} out @param {(units: number) => number} [round]
     */
    const putGlyphMetrics = (face, indicesAt, count, out, round = units=>units)=>{
        if ((indicesAt >>> 0) === 0 || (out >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        const glyphs = readU16s(indicesAt, count >>> 0);
        if (glyphs.some(glyph=>glyph >= face.glyphs.count))
        {
            return E_INVALIDARG;
        }
        const data = new Uint8Array((count >>> 0) * 28);
        const view = new DataView(data.buffer);
        glyphs.forEach((glyph, i)=>{
            const g = designMetrics(face, glyph);
            [g.leftSideBearing, round(g.advanceWidth), g.rightSideBearing, g.topSideBearing,
                g.advanceHeight, g.bottomSideBearing, g.verticalOriginY].forEach((value, k)=>
                view.setInt32(i * 28 + k * 4, value, true));
        });
        host.writeMemory(out >>> 0, data);
        return S_OK;
    };
    /** A half rounded away from zero, as C's round(). @param {number} value */
    const roundAway = value=>Math.sign(value) * Math.round(Math.abs(value));
    /**
     * The pixels an em is drawn at: the size times pixels a DIP, times the
     * transform's vertical scale.
     *
     * @param {number} emSize @param {number} pixelsPerDip @param {number} transform
     */
    const pixelsPerEm = (emSize, pixelsPerDip, transform)=>{
        const m22 = (transform >>> 0) === 0 ? 1 : f32(u32(transform + 12));
        const m21 = (transform >>> 0) === 0 ? 0 : f32(u32(transform + 8));
        return emSize * pixelsPerDip * Math.hypot(m21, m22);
    };
    descriptors.face = { id: IID.FONT_FACE, methods: [
        /** DWRITE_FONT_FACE_TYPE GetType() */
        { name: 'GetType', argBytes: bytes(0), invoke: o=>
            o.state.face.type },
        /** HRESULT GetFiles(UINT32 *numberOfFiles, IDWriteFontFile **files) */
        { name: 'GetFiles', argBytes: bytes(2), invoke: (o, [countAt, filesAt])=>{
            if ((countAt >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            if ((filesAt >>> 0) === 0)
            {
                putU32s(countAt, [1]);
                return S_OK;
            }
            if (u32(countAt) < 1)
            {
                return E_INVALIDARG;
            }
            o.state.fileObject ??= newFile(o.state.face.file);
            return give(filesAt, o.state.fileObject, IID.FONT_FILE, false);
        } },
        /** UINT32 GetIndex() */
        { name: 'GetIndex', argBytes: bytes(0), invoke: o=>
            o.state.face.index },
        /** DWRITE_FONT_SIMULATIONS GetSimulations() */
        { name: 'GetSimulations', argBytes: bytes(0), invoke: o=>
            o.state.face.simulations },
        /** BOOL IsSymbolFont() */
        { name: 'IsSymbolFont', argBytes: bytes(0), invoke: o=>
            (o.state.face.cmap.symbol ? 1 : 0) },
        /** void GetMetrics(DWRITE_FONT_METRICS*) */
        { name: 'GetMetrics', argBytes: bytes(1), invoke: (o, [out])=>{
            putMetrics(out, o.state.face);
            return 0;
        } },
        /** UINT16 GetGlyphCount() */
        { name: 'GetGlyphCount', argBytes: bytes(0), invoke: o=>
            o.state.face.glyphs.count },
        /**
         * HRESULT GetDesignGlyphMetrics(UINT16 const *indices, UINT32 count,
         *     DWRITE_GLYPH_METRICS*, BOOL isSideways)
         */
        { name: 'GetDesignGlyphMetrics', argBytes: bytes(4), invoke: (o, [indices, count, out])=>
            putGlyphMetrics(o.state.face, indices, count, out) },
        /** HRESULT GetGlyphIndices(UINT32 const *codepoints, UINT32 count, UINT16 *indices) */
        { name: 'GetGlyphIndices', argBytes: bytes(3), invoke: (o, [codes, count, out])=>{
            const n = count >>> 0;
            if ((out >>> 0) === 0 || (codes >>> 0) === 0)
            {
                if ((out >>> 0) !== 0)
                {
                    host.writeMemory(out >>> 0, new Uint8Array(n * 2));
                }
                return E_INVALIDARG;
            }
            if (n === 0)
            {
                return S_OK;
            }
            const read = host.readMemory(codes >>> 0, n * 4);
            const view = new DataView(read.buffer, read.byteOffset, read.byteLength);
            const glyphs = new Uint8Array(n * 2);
            for (let i = 0; i < n; i++)
            {
                const glyph = o.state.face.cmap.lookup(view.getUint32(i * 4, true));
                glyphs[i * 2] = glyph & 0xff;
                glyphs[i * 2 + 1] = glyph >> 8;
            }
            host.writeMemory(out >>> 0, glyphs);
            return S_OK;
        } },
        /**
         * HRESULT TryGetFontTable(UINT32 tag, void const **data, UINT32 *size, void **context,
         *     BOOL *exists)
         */
        { name: 'TryGetFontTable', argBytes: bytes(5), invoke: (o, args)=>{
            const [tag, dataAt, sizeAt, contextAt, existsAt] = args;
            if ((dataAt >>> 0) === 0 || (sizeAt >>> 0) === 0 || (contextAt >>> 0) === 0
                || (existsAt >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const face = o.state.face;
            const table = face.tables.get(tagText(tag >>> 0));
            if (!table)
            {
                putU32s(dataAt, [0]);
                putU32s(sizeAt, [0]);
                putU32s(contextAt, [0]);
                putU32s(existsAt, [0]);
                return S_OK;
            }
            const at = inGuest(face.bytes) + table.byteOffset - face.bytes.byteOffset;
            putU32s(dataAt, [at]);
            putU32s(sizeAt, [table.length]);
            // The whole file stays in memory while the face lives: nothing to release.
            putU32s(contextAt, [0]);
            putU32s(existsAt, [1]);
            return S_OK;
        } },
        /** void ReleaseFontTable(void *context) */
        { name: 'ReleaseFontTable', argBytes: bytes(1), invoke: ()=>0 },
        /**
         * HRESULT GetGlyphRunOutline(FLOAT emSize, UINT16 const*, FLOAT const*,
         *     DWRITE_GLYPH_OFFSET const*, UINT32 count, BOOL isSideways, BOOL isRtl,
         *     IDWriteGeometrySink*)
         */
        { name: 'GetGlyphRunOutline', argBytes: bytes(8), invoke: ()=>{
            say('IDWriteFontFace::GetGlyphRunOutline', 'refused: glyph outlines are not read'
                + ' here (the faces are drawn by the browser)');
            return E_NOTIMPL;
        } },
        /**
         * HRESULT GetRecommendedRenderingMode(FLOAT emSize, FLOAT pixelsPerDip,
         *     DWRITE_MEASURING_MODE, IDWriteRenderingParams*, DWRITE_RENDERING_MODE*)
         */
        { name: 'GetRecommendedRenderingMode', argBytes: bytes(5), invoke: (_o, args)=>{
            const [em, ppd, measuring, params, out] = args;
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [0]);
            const values = (params >>> 0) === 0 ? null
                : host.objectAt(params >>> 0)?.state?.values;
            if (!values || (measuring >>> 0) > 2)
            {
                return E_INVALIDARG;
            }
            const pixels = f32(em) * f32(ppd);
            // Outlines past a size (larger for GDI's measuring); then GDI's
            // measuring draws as GDI does, and natural text smooths
            // symmetrically past 20 pixels (no face here has a 'gasp' saying
            // otherwise).
            const mode = values[4] !== 0 ? values[4]
                : pixels >= ((measuring >>> 0) === 0 ? 100 : 350) ? 6
                    : (measuring >>> 0) === 1 ? 2 : (measuring >>> 0) === 2 ? 3
                        : pixels <= 20 ? 4 : 5;
            putU32s(out, [mode]);
            return S_OK;
        } },
        /**
         * HRESULT GetGdiCompatibleMetrics(FLOAT emSize, FLOAT pixelsPerDip,
         *     DWRITE_MATRIX const*, DWRITE_FONT_METRICS*)
         */
        { name: 'GetGdiCompatibleMetrics', argBytes: bytes(4), invoke: (o, args)=>{
            const [em, ppd, transform, out] = args;
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const ppem = pixelsPerEm(f32(em), f32(ppd), transform);
            if (!(f32(em) > 0) || !(f32(ppd) > 0) || !(ppem > 0))
            {
                host.writeMemory(out >>> 0, new Uint8Array(20));
                return E_INVALIDARG;
            }
            const face = o.state.face;
            const units = face.metrics.designUnitsPerEm;
            // Each metric to whole pixels at the size, back in design units.
            /** @param {number} value */
            const snap = value=>roundAway(roundAway(value * ppem / units) * units / ppem);
            const m = face.metrics;
            putMetrics(out, { ...face, metrics: { ...m, ascent: snap(m.ascent),
                descent: snap(m.descent), lineGap: snap(m.lineGap), capHeight: snap(m.capHeight),
                xHeight: snap(m.xHeight), underlinePosition: snap(m.underlinePosition),
                underlineThickness: snap(m.underlineThickness),
                strikethroughPosition: snap(m.strikethroughPosition),
                strikethroughThickness: snap(m.strikethroughThickness) } });
            return S_OK;
        } },
        /**
         * HRESULT GetGdiCompatibleGlyphMetrics(FLOAT emSize, FLOAT pixelsPerDip,
         *     DWRITE_MATRIX const*, BOOL useGdiNatural, UINT16 const*, UINT32 count,
         *     DWRITE_GLYPH_METRICS*, BOOL isSideways)
         */
        { name: 'GetGdiCompatibleGlyphMetrics', argBytes: bytes(8), invoke: (o, args)=>{
            const [em, ppd, transform, , indices, count, out] = args;
            const ppem = pixelsPerEm(f32(em), f32(ppd), transform);
            if (!(ppem > 0))
            {
                return E_INVALIDARG;
            }
            const units = o.state.face.metrics.designUnitsPerEm;
            return putGlyphMetrics(o.state.face, indices, count, out, advance=>roundAway(
                roundAway(advance * ppem / units) * units / ppem));
        } },
    ] };

    // ----- Collections, families, fonts -----

    /** The system collection's families, made once. @type {import('./fonts.js').FamilyEntry[]} */
    let systemFamilies = [];
    const systemCollection = ()=>{
        if (systemFamilies.length)
        {
            return systemFamilies;
        }
        systemFamilies = SYSTEM_FAMILIES.map(family=>({ names: [['en-us', family.name]],
            fonts: family.fonts.map(font=>{
                const file = fileRef(0, localKey(font.path, host.modified?.(font.path) ?? 0n));
                /** @type {import('./fonts.js').Face | null} */
                let face = null;
                return { file, index: 0, simulations: 0, weight: font.weight, stretch: 5,
                    style: font.italic ? FONT_STYLE.ITALIC : FONT_STYLE.NORMAL,
                    faceNames: /** @type {import('./fonts.js').Localized} */ (
                        [['en-us', font.faceName]]),
                    face: ()=>(face ??= faceOf(file, /** @type {Uint8Array} */ (
                        file.system?.bytes()), 0, 0)) };
            }) }));
        return systemFamilies;
    };

    /**
     * IDWriteFontCollection over families.
     *
     * @param {any} factory @param {import('./fonts.js').FamilyEntry[]} families
     * @param {boolean} system
     */
    const newCollection = (factory, families, system)=>{
        // The system collection holds its factory; one a program loads does not.
        if (system)
        {
            factory.addRef();
        }
        /** @type {any} */
        const collection = newObject([descriptors.collection], { factory, families, system },
            ()=>{
                // The factory keeps its system collection only while a program holds it.
                if (factory.state.system === collection)
                {
                    factory.state.system = null;
                }
                if (system)
                {
                    factory.release();
                }
            });
        return collection;
    };

    /**
     * IDWriteFontFamily of a collection.
     *
     * @param {any} collection @param {import('./fonts.js').FamilyEntry} family
     */
    const newFamily = (collection, family)=>{
        collection.addRef();
        return newObject([descriptors.family, descriptors.list], { collection, family,
            fonts: family.fonts }, ()=>collection.release());
    };
    /**
     * IDWriteFontList of a family's fonts, nearest first.
     *
     * @param {any} family @param {import('./fonts.js').FontEntry[]} fonts
     */
    const newList = (family, fonts)=>{
        family.addRef();
        return newObject([descriptors.list], { owner: family,
            collection: family.state.collection, fonts }, ()=>family.release());
    };
    /**
     * IDWriteFont of a family.
     *
     * @param {any} family @param {import('./fonts.js').FontEntry} font
     */
    const newFont = (family, font)=>{
        family.addRef();
        return newObject([descriptors.font], { family, font }, ()=>family.release());
    };
    /** A font's face with its simulations. @param {import('./fonts.js').FontEntry} font */
    const faceOfFont = font=>{
        const face = font.face();
        return font.simulations === face.simulations ? face
            : faceOf(face.file, face.bytes, face.index, font.simulations);
    };

    /** @type {ComMethod[]} */
    const listMethods = [
        /** HRESULT GetFontCollection(IDWriteFontCollection**) */
        { name: 'GetFontCollection', argBytes: bytes(1), invoke: (o, [out])=>((out >>> 0) === 0
            ? E_INVALIDARG : give(out, o.state.collection, IID.FONT_COLLECTION, false)) },
        /** UINT32 GetFontCount() */
        { name: 'GetFontCount', argBytes: bytes(0), invoke: o=>
            o.state.fonts.length },
        /** HRESULT GetFont(UINT32 index, IDWriteFont**) */
        { name: 'GetFont', argBytes: bytes(2), invoke: (o, [index, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [0]);
            const font = o.state.fonts[index >>> 0];
            if (!font)
            {
                return E_INVALIDARG;
            }
            return give(out, newFont(o.state.owner ?? o, font), IID.FONT);
        } },
    ];
    descriptors.list = { id: IID.FONT_LIST, methods: listMethods };
    descriptors.family = { id: IID.FONT_FAMILY, methods: [...listMethods,
        /** HRESULT GetFamilyNames(IDWriteLocalizedStrings**) */
        { name: 'GetFamilyNames', argBytes: bytes(1), invoke: (o, [out])=>((out >>> 0) === 0
            ? E_INVALIDARG : give(out, newStrings(o.state.family.names), IID.LOCALIZED_STRINGS)) },
        /**
         * HRESULT GetFirstMatchingFont(DWRITE_FONT_WEIGHT, DWRITE_FONT_STRETCH,
         *     DWRITE_FONT_STYLE, IDWriteFont**)
         */
        { name: 'GetFirstMatchingFont', argBytes: bytes(4), invoke: (o, args)=>{
            const [weight, stretch, style, out] = args;
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const [best] = matching(o.state.family, weight >>> 0, stretch >>> 0, style >>> 0);
            return best ? give(out, newFont(o, best), IID.FONT) : DWRITE_E_NOFONT;
        } },
        /**
         * HRESULT GetMatchingFonts(DWRITE_FONT_WEIGHT, DWRITE_FONT_STRETCH, DWRITE_FONT_STYLE,
         *     IDWriteFontList**)
         */
        { name: 'GetMatchingFonts', argBytes: bytes(4), invoke: (o, [weight, stretch, style, out])=>
            ((out >>> 0) === 0 ? E_INVALIDARG : give(out, newList(o, matching(o.state.family,
                weight >>> 0, stretch >>> 0, style >>> 0)), IID.FONT_LIST)) },
    ] };

    /** Informational string ids to 'name' ids. */
    const INFORMATIONAL = [0, 0, 5, 7, 8, 9, 12, 10, 11, 13, 14, 1, 2, 16, 17, 19, 4, 6, 20];

    descriptors.font = { id: IID.FONT, methods: [
        /** HRESULT GetFontFamily(IDWriteFontFamily**) */
        { name: 'GetFontFamily', argBytes: bytes(1), invoke: (o, [out])=>((out >>> 0) === 0
            ? E_INVALIDARG : give(out, o.state.family, IID.FONT_FAMILY, false)) },
        { name: 'GetWeight', argBytes: bytes(0), invoke: o=>
            o.state.font.weight },
        { name: 'GetStretch', argBytes: bytes(0), invoke: o=>
            o.state.font.stretch },
        { name: 'GetStyle', argBytes: bytes(0), invoke: o=>
            o.state.font.style },
        { name: 'IsSymbolFont', argBytes: bytes(0), invoke: o=>
            (faceOfFont(o.state.font).cmap.symbol ? 1 : 0) },
        /** HRESULT GetFaceNames(IDWriteLocalizedStrings**) */
        { name: 'GetFaceNames', argBytes: bytes(1), invoke: (o, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const { font } = o.state;
            /** @type {import('./fonts.js').Localized} */
            let names = font.faceNames;
            if (font.simulations & SIMULATION.OBLIQUE)
            {
                names = names.map(([locale, text])=>[locale, `${text === 'Regular' ? ''
                    : `${text} `}Oblique`]);
            }
            return give(out, newStrings(names), IID.LOCALIZED_STRINGS);
        } },
        /**
         * HRESULT GetInformationalStrings(DWRITE_INFORMATIONAL_STRING_ID,
         *     IDWriteLocalizedStrings**, BOOL *exists)
         */
        { name: 'GetInformationalStrings', argBytes: bytes(3), invoke: (o, args)=>{
            const [id, out, existsAt] = args;
            if ((out >>> 0) === 0 || (existsAt >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [0]);
            putU32s(existsAt, [0]);
            const nameId = INFORMATIONAL[id >>> 0];
            if (!nameId && (id >>> 0) !== 1)
            {
                return S_OK;
            }
            const strings = localized(faceOfFont(o.state.font).names, [nameId]);
            if (!strings.length)
            {
                return S_OK;
            }
            putU32s(existsAt, [1]);
            return give(out, newStrings(strings), IID.LOCALIZED_STRINGS);
        } },
        { name: 'GetSimulations', argBytes: bytes(0), invoke: o=>
            o.state.font.simulations },
        /** void GetMetrics(DWRITE_FONT_METRICS*) */
        { name: 'GetMetrics', argBytes: bytes(1), invoke: (o, [out])=>{
            putMetrics(out, faceOfFont(o.state.font));
            return 0;
        } },
        /** HRESULT HasCharacter(UINT32 code, BOOL *exists) */
        { name: 'HasCharacter', argBytes: bytes(2), invoke: (o, [code, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [faceOfFont(o.state.font).cmap.lookup(code >>> 0) ? 1 : 0]);
            return S_OK;
        } },
        /** HRESULT CreateFontFace(IDWriteFontFace**) */
        { name: 'CreateFontFace', argBytes: bytes(1), invoke: (o, [out])=>((out >>> 0) === 0
            ? E_INVALIDARG : give(out, newFace(o.state.family.state.collection.state.factory,
                faceOfFont(o.state.font)), IID.FONT_FACE, true)) },
    ] };

    /**
     * A family's index in a collection by a name in any of its locales.
     *
     * @param {import('./fonts.js').FamilyEntry[]} families @param {string} name
     */
    const familyIndex = (families, name)=>{
        const wanted = name.toLowerCase();
        return families.findIndex(family=>family.names.some(([, text])=>text.toLowerCase()
            === wanted));
    };

    descriptors.collection = { id: IID.FONT_COLLECTION, methods: [
        { name: 'GetFontFamilyCount', argBytes: bytes(0), invoke: o=>
            o.state.families.length },
        /** HRESULT GetFontFamily(UINT32 index, IDWriteFontFamily**) */
        { name: 'GetFontFamily', argBytes: bytes(2), invoke: (o, [index, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [0]);
            const family = o.state.families[index >>> 0];
            return family ? give(out, newFamily(o, family), IID.FONT_FAMILY) : E_FAIL;
        } },
        /** HRESULT FindFamilyName(WCHAR const *name, UINT32 *index, BOOL *exists) */
        { name: 'FindFamilyName', argBytes: bytes(3), invoke: (o, [name, indexAt, existsAt])=>{
            if ((name >>> 0) === 0 || (indexAt >>> 0) === 0 || (existsAt >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const index = familyIndex(o.state.families, string(name, true, 256));
            putU32s(indexAt, [index < 0 ? 0xffffffff : index]);
            putU32s(existsAt, [index < 0 ? 0 : 1]);
            return S_OK;
        } },
        /** HRESULT GetFontFromFontFace(IDWriteFontFace*, IDWriteFont**) */
        { name: 'GetFontFromFontFace', argBytes: bytes(2), invoke: (o, [facePointer, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [0]);
            const face = faceAt(facePointer);
            if (!face)
            {
                return E_INVALIDARG;
            }
            for (const family of o.state.families)
            {
                const font = family.fonts.find((/** @type {import('./fonts.js').FontEntry} */
                    candidate)=>candidate.file === face.file && candidate.index === face.index);
                if (font)
                {
                    const familyObject = newFamily(o, family);
                    const made = newFont(familyObject, face.simulations === font.simulations
                        ? font : { ...font, simulations: face.simulations });
                    familyObject.release();
                    return give(out, made, IID.FONT);
                }
            }
            return DWRITE_E_NOFONT;
        } },
    ] };

    // ----- GDI interop -----

    /** LOGFONTW: its weight, italic and face name. @param {number} at */
    const readLogFont = at=>{
        const raw = host.readMemory(at >>> 0, 92);
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        let name = '';
        for (let i = 0; i < 32; i++)
        {
            const unit = view.getUint16(28 + i * 2, true);
            if (unit === 0)
            {
                break;
            }
            name += String.fromCharCode(unit);
        }
        return { height: view.getInt32(0, true), weight: view.getInt32(16, true),
            italic: raw[20] !== 0, name };
    };
    /**
     * LOGFONTW for a font: its weight, italic, the outline precision, its
     * family's name.
     *
     * @param {number} at @param {{ weight: number, style: number, simulations: number }} font
     * @param {string} family
     */
    const writeLogFont = (at, font, family)=>{
        const raw = new Uint8Array(92);
        const view = new DataView(raw.buffer);
        view.setInt32(16, font.weight, true);
        raw[20] = font.style !== FONT_STYLE.NORMAL ? 1 : 0;
        // DEFAULT_CHARSET, OUT_OUTLINE_PRECIS.
        raw[23] = 1;
        raw[24] = 8;
        for (let i = 0; i < Math.min(31, family.length); i++)
        {
            view.setUint16(28 + i * 2, family.charCodeAt(i), true);
        }
        host.writeMemory(at >>> 0, raw);
    };
    /**
     * The font a device context holds as GDI realized it: its LOGFONT's weight
     * and italic, and the face GDI drew it with, or null for no context.
     *
     * @param {number} hdc
     */
    const fontOfContext = hdc=>{
        const call = /** @type {NonNullable<DwriteHost['gdi']>} */ (gdi);
        const font = call('GetCurrentObject', [hdc, OBJ_FONT]);
        if (font === 0)
        {
            return null;
        }
        const cell = scratch(92 + 64);
        try
        {
            if (call('GetObjectW', [font, 92, cell]) === 0)
            {
                return null;
            }
            const asked = readLogFont(cell);
            const length = call('GetTextFaceW', [hdc, 32, cell + 92]);
            const name = length > 0 ? string(cell + 92, true, 32) : asked.name;
            return { ...asked, name };
        }
        finally
        {
            host.heap.free(cell);
        }
    };

    descriptors.interop = { id: IID.GDI_INTEROP, methods: [
        /** HRESULT CreateFontFromLOGFONT(LOGFONTW const*, IDWriteFont**) */
        { name: 'CreateFontFromLOGFONT', argBytes: bytes(2), invoke: (o, [logfont, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [0]);
            if ((logfont >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const asked = readLogFont(logfont);
            const families = systemCollection();
            const index = familyIndex(families, asked.name);
            if (index < 0)
            {
                return DWRITE_E_NOFONT;
            }
            const collection = systemCollectionObject(o.state.factory);
            const family = newFamily(collection, families[index]);
            collection.release();
            const [best] = matching(families[index], asked.weight || 400, 5,
                asked.italic ? FONT_STYLE.ITALIC : FONT_STYLE.NORMAL);
            const font = newFont(family, best);
            family.release();
            return give(out, font, IID.FONT);
        } },
        /** HRESULT ConvertFontToLOGFONT(IDWriteFont*, LOGFONTW*, BOOL *isSystemFont) */
        { name: 'ConvertFontToLOGFONT', argBytes: bytes(3), invoke: (_o, args)=>{
            const [fontPointer, out, systemAt] = args;
            if ((out >>> 0) === 0 || (systemAt >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            host.writeMemory(out >>> 0, new Uint8Array(92));
            putU32s(systemAt, [0]);
            const font = (fontPointer >>> 0) === 0 ? null : host.objectAt(fontPointer >>> 0);
            if (!font?.state?.font)
            {
                return E_INVALIDARG;
            }
            const family = font.state.family.state.family;
            writeLogFont(out, font.state.font, family.names[0]?.[1] ?? '');
            putU32s(systemAt, [font.state.family.state.collection.state.system ? 1 : 0]);
            return S_OK;
        } },
        /** HRESULT ConvertFontFaceToLOGFONT(IDWriteFontFace*, LOGFONTW*) */
        { name: 'ConvertFontFaceToLOGFONT', argBytes: bytes(2), invoke: (_o, args)=>{
            const [facePointer, out] = args;
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            host.writeMemory(out >>> 0, new Uint8Array(92));
            const face = faceAt(facePointer);
            if (!face)
            {
                return E_INVALIDARG;
            }
            const family = localized(face.names, [1, 16])[0]?.[1] ?? '';
            writeLogFont(out, { weight: face.simulations & SIMULATION.BOLD ? 700
                : face.style.weight, style: face.simulations & SIMULATION.OBLIQUE
                ? FONT_STYLE.OBLIQUE : face.style.style, simulations: face.simulations }, family);
            return S_OK;
        } },
        /** HRESULT CreateFontFaceFromHdc(HDC, IDWriteFontFace**) */
        { name: 'CreateFontFaceFromHdc', argBytes: bytes(2), invoke: (o, [hdc, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [0]);
            if ((hdc >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const realized = gdi ? fontOfContext(hdc >>> 0) : null;
            if (!realized)
            {
                return E_FAIL;
            }
            // The face GDI realized the context's font as: a bitmap face is no
            // DirectWrite font.
            const families = systemCollection();
            const index = familyIndex(families, realized.name);
            if (index < 0)
            {
                return DWRITE_E_FILEFORMAT;
            }
            const [best] = matching(families[index], realized.weight || 400, 5,
                realized.italic ? FONT_STYLE.ITALIC : FONT_STYLE.NORMAL);
            return give(out, newFace(o.state.factory, faceOfFont(best)), IID.FONT_FACE);
        } },
        /** HRESULT CreateBitmapRenderTarget(HDC, UINT32 width, UINT32 height, target**) */
        { name: 'CreateBitmapRenderTarget', argBytes: bytes(4), invoke: (_o, args)=>{
            const [hdc, width, height, out] = args;
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [0]);
            if (!renderTargets)
            {
                say('IDWriteGdiInterop::CreateBitmapRenderTarget', 'refused: no GDI to make'
                    + ' its memory context with');
                return E_NOTIMPL;
            }
            const target = renderTargets.create(hdc >>> 0, width >>> 0, height >>> 0);
            return target ? give(out, target, IID.BITMAP_RENDER_TARGET) : E_OUTOFMEMORY;
        } },
    ] };

    /**
     * The factory's system collection, made once and kept while it lives.
     *
     * @param {any} factory
     */
    const systemCollectionObject = factory=>{
        const kept = factory.state.system;
        if (kept)
        {
            kept.addRef();
            return kept;
        }
        const made = newCollection(factory, systemCollection(), true);
        factory.state.system = made;
        return made;
    };

    // ----- The factory -----

    const analysis = createAnalysis({ host, method, u32, putU32s, readU16s, scratch, say,
        f32, bitsOf, faceAt, designMetrics });
    const gdi = host.gdi;
    const renderTargets = gdi ? createRenderTargets({ host, gdi, u32, putU32s, scratch, f32,
        bitsOf, floatAnswer, glyphRun: analysis.glyphRun, coverageOf: analysis.coverageOf })
        : null;

    /** @param {string} api @param {number} out */
    const notMade = (api, out)=>{
        if ((out >>> 0) !== 0)
        {
            putU32s(out, [0]);
        }
        say(`IDWriteFactory::${api}`, 'refused: DirectWrite\'s text formats and layouts are'
            + ' not made here');
        return E_NOTIMPL;
    };

    /**
     * A program's loader registered with a factory, AddRef'd while it is.
     *
     * @param {Set<number>} set @param {number} loader
     */
    const register = async(set, loader)=>{
        if ((loader >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        if (set.has(loader >>> 0) || host.objectAt(loader >>> 0) === localLoader)
        {
            return DWRITE_E_ALREADYREGISTERED;
        }
        set.add(loader >>> 0);
        await touch(loader >>> 0, 1);
        return S_OK;
    };
    /** @param {Set<number>} set @param {number} loader */
    const unregister = async(set, loader)=>{
        if ((loader >>> 0) === 0 || !set.delete(loader >>> 0))
        {
            return E_INVALIDARG;
        }
        await touch(loader >>> 0, 2);
        return S_OK;
    };

    /** @type {any} */
    let sharedFactory = null;

    descriptors.factory = { id: IID.FACTORY, methods: [
        /** HRESULT GetSystemFontCollection(IDWriteFontCollection**, BOOL checkForUpdates) */
        { name: 'GetSystemFontCollection', argBytes: bytes(2), invoke: (o, [out])=>
            ((out >>> 0) === 0 ? E_INVALIDARG
                : give(out, systemCollectionObject(o), IID.FONT_COLLECTION)) },
        /**
         * HRESULT CreateCustomFontCollection(IDWriteFontCollectionLoader*, void const *key,
         *     UINT32 size, IDWriteFontCollection**)
         */
        { name: 'CreateCustomFontCollection', argBytes: bytes(4), invoke: async(o, args)=>{
            const [loader, key, size, out] = args;
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [0]);
            if (!o.state.collectionLoaders.has(loader >>> 0))
            {
                return E_INVALIDARG;
            }
            const thread = host.currentThread();
            const factoryPointer = host.vtables.publish(o, IID.FACTORY);
            const cell = scratch(8);
            /** @type {import('./fonts.js').Face[]} */
            const faces = [];
            try
            {
                // IDWriteFontCollectionLoader::CreateEnumeratorFromKey(factory, key, size, &e).
                let hr = await method(thread, loader >>> 0, 3, [factoryPointer, key >>> 0,
                    size >>> 0, cell]);
                if (hr !== 0)
                {
                    return hr | 0;
                }
                const enumerator = u32(cell);
                for (;;)
                {
                    // IDWriteFontFileEnumerator: MoveNext 3, GetCurrentFontFile 4.
                    hr = await method(thread, enumerator, 3, [cell]);
                    if (hr !== 0 || u32(cell) === 0)
                    {
                        break;
                    }
                    hr = await method(thread, enumerator, 4, [cell + 4]);
                    const filePointer = u32(cell + 4);
                    if (hr !== 0 || filePointer === 0)
                    {
                        break;
                    }
                    const file = host.objectAt(filePointer)?.state?.file;
                    if (!file)
                    {
                        say('IDWriteFactory::CreateCustomFontCollection', 'a font file the'
                            + ' program made itself is left out: only files the factory made'
                            + ' are read', 'loss');
                    }
                    const data = file ? await bytesOf(file, thread) : null;
                    if (data)
                    {
                        const count = analyzeFile(data).faces.length;
                        for (let index = 0; index < count; index++)
                        {
                            try
                            {
                                faces.push(faceOf(file, data, index, 0));
                            }
                            catch (e){
                                if (!(e instanceof FontFormatError))
                                {
                                    throw e;
                                }
                            }
                        }
                    }
                    await method(thread, filePointer, 2, []);
                }
                await method(thread, enumerator, 2, []);
            }
            finally
            {
                host.heap.free(cell);
            }
            return give(out, newCollection(o, familiesOf(faces), false), IID.FONT_COLLECTION);
        } },
        /** HRESULT RegisterFontCollectionLoader(IDWriteFontCollectionLoader*) */
        { name: 'RegisterFontCollectionLoader', argBytes: bytes(1), invoke: (o, [loader])=>
            register(o.state.collectionLoaders, loader) },
        /** HRESULT UnregisterFontCollectionLoader(IDWriteFontCollectionLoader*) */
        { name: 'UnregisterFontCollectionLoader', argBytes: bytes(1), invoke: (o, [loader])=>
            unregister(o.state.collectionLoaders, loader) },
        /** HRESULT CreateFontFileReference(WCHAR const *path, FILETIME const*, IDWriteFontFile**) */
        { name: 'CreateFontFileReference', argBytes: bytes(3), invoke: async(_o, args)=>{
            const [pathAt, timeAt, out] = args;
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [0]);
            if ((pathAt >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const path = string(pathAt, true, 260);
            // A file named with its last write need not exist yet.
            if ((timeAt >>> 0) === 0 && !systemFace(path) && !(await host.readFile(path)))
            {
                return DWRITE_E_FILENOTFOUND;
            }
            const modified = (timeAt >>> 0) !== 0
                ? BigInt(u32(timeAt)) | BigInt(u32(timeAt + 4)) << 32n
                : host.modified?.(path) ?? 0n;
            return give(out, newFile(fileRef(0, localKey(path, modified))), IID.FONT_FILE);
        } },
        /**
         * HRESULT CreateCustomFontFileReference(void const *key, UINT32 size,
         *     IDWriteFontFileLoader*, IDWriteFontFile**)
         */
        { name: 'CreateCustomFontFileReference', argBytes: bytes(4), invoke: (o, args)=>{
            const [key, size, loader, out] = args;
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [0]);
            if ((key >>> 0) === 0 || (loader >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const local = host.objectAt(loader >>> 0) === localLoader;
            if (!local && !o.state.fileLoaders.has(loader >>> 0))
            {
                return E_INVALIDARG;
            }
            return give(out, newFile(fileRef(local ? 0 : loader >>> 0, keyAt(key, size))),
                IID.FONT_FILE);
        } },
        /**
         * HRESULT CreateFontFace(DWRITE_FONT_FACE_TYPE, UINT32 files, IDWriteFontFile* const*,
         *     UINT32 index, DWRITE_FONT_SIMULATIONS, IDWriteFontFace**)
         */
        { name: 'CreateFontFace', argBytes: bytes(6), invoke: async(o, args)=>{
            const [type, count, filesAt, index, simulations, out] = args;
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [0]);
            // Type 1, vector and bitmap faces are not DirectWrite's; a bare CFF
            // table is a face type it names and does not make.
            if ((count >>> 0) !== 1 || (filesAt >>> 0) === 0 || (simulations >>> 0) > 3
                || [3, 4, 5].includes(type >>> 0) || (type >>> 0) > FACE_TYPE_RAW_CFF)
            {
                return E_INVALIDARG;
            }
            if ((type >>> 0) === FACE_TYPE_RAW_CFF)
            {
                return DWRITE_E_UNSUPPORTEDOPERATION;
            }
            const file = host.objectAt(u32(filesAt))?.state?.file;
            if (!file)
            {
                return E_INVALIDARG;
            }
            const data = await bytesOf(file);
            if (!data)
            {
                return failureOf(file);
            }
            const kind = analyzeFile(data);
            // DWRITE_FONT_FACE_TYPE_UNKNOWN takes the file's own type.
            if (!kind.faces.length || (type >>> 0) !== FACE_TYPE_UNKNOWN
                && kind.faceType !== (type >>> 0))
            {
                return DWRITE_E_FILEFORMAT;
            }
            if ((index >>> 0) >= kind.faces.length)
            {
                return E_INVALIDARG;
            }
            try
            {
                return give(out, newFace(o, faceOf(file, data, index >>> 0, simulations >>> 0)),
                    IID.FONT_FACE);
            }
            catch (e){
                if (e instanceof FontFormatError)
                {
                    return DWRITE_E_FILEFORMAT;
                }
                throw e;
            }
        } },
        /** HRESULT CreateRenderingParams(IDWriteRenderingParams**) */
        { name: 'CreateRenderingParams', argBytes: bytes(1), invoke: (_o, [out])=>
            ((out >>> 0) === 0 ? E_INVALIDARG
                : give(out, newParams([1.8, 0.5, 1, 1, 0]), IID.RENDERING_PARAMS)) },
        /** HRESULT CreateMonitorRenderingParams(HMONITOR, IDWriteRenderingParams**) */
        { name: 'CreateMonitorRenderingParams', argBytes: bytes(2), invoke: (_o, [monitor, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [0]);
            return (monitor >>> 0) === 0 ? E_INVALIDARG
                : give(out, newParams([1.8, 0.5, 1, 1, 0]), IID.RENDERING_PARAMS);
        } },
        /**
         * HRESULT CreateCustomRenderingParams(FLOAT gamma, FLOAT enhancedContrast,
         *     FLOAT clearTypeLevel, DWRITE_PIXEL_GEOMETRY, DWRITE_RENDERING_MODE, params**)
         */
        { name: 'CreateCustomRenderingParams', argBytes: bytes(6), invoke: (_o, args)=>{
            const [gamma, contrast, level, geometry, mode, out] = args;
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [0]);
            const values = [f32(gamma), f32(contrast), f32(level), geometry >>> 0, mode >>> 0];
            if (!(values[0] > 0) || !(values[1] >= 0) || !(values[2] >= 0) || values[3] > 2
                || values[4] > 6)
            {
                return E_INVALIDARG;
            }
            return give(out, newParams(values), IID.RENDERING_PARAMS);
        } },
        /** HRESULT RegisterFontFileLoader(IDWriteFontFileLoader*) */
        { name: 'RegisterFontFileLoader', argBytes: bytes(1), invoke: (o, [loader])=>
            register(o.state.fileLoaders, loader) },
        /** HRESULT UnregisterFontFileLoader(IDWriteFontFileLoader*) */
        { name: 'UnregisterFontFileLoader', argBytes: bytes(1), invoke: (o, [loader])=>
            unregister(o.state.fileLoaders, loader) },
        /** CreateTextFormat(family, collection, weight, style, stretch, size, locale, format**) */
        { name: 'CreateTextFormat', argBytes: bytes(8), invoke: (_o, args)=>
            notMade('CreateTextFormat', args[7]) },
        /** HRESULT CreateTypography(IDWriteTypography**) */
        { name: 'CreateTypography', argBytes: bytes(1), invoke: (_o, [out])=>
            notMade('CreateTypography', out) },
        /** HRESULT GetGdiInterop(IDWriteGdiInterop**) */
        { name: 'GetGdiInterop', argBytes: bytes(1), invoke: (o, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const kept = o.state.interop;
            if (kept)
            {
                return give(out, kept, IID.GDI_INTEROP, false);
            }
            o.addRef();
            const interop = newObject([descriptors.interop], { factory: o }, ()=>{
                o.state.interop = null;
                o.release();
            });
            o.state.interop = interop;
            return give(out, interop, IID.GDI_INTEROP);
        } },
        /** CreateTextLayout(string, length, format, maxWidth, maxHeight, layout**) */
        { name: 'CreateTextLayout', argBytes: bytes(6), invoke: (_o, args)=>
            notMade('CreateTextLayout', args[5]) },
        /** CreateGdiCompatibleTextLayout(..., layout**): nine arguments */
        { name: 'CreateGdiCompatibleTextLayout', argBytes: bytes(9), invoke: (_o, args)=>notMade(
            'CreateGdiCompatibleTextLayout', args[8]) },
        /** CreateEllipsisTrimmingSign(format, sign**) */
        { name: 'CreateEllipsisTrimmingSign', argBytes: bytes(2), invoke: (_o, args)=>notMade(
            'CreateEllipsisTrimmingSign', args[1]) },
        /** HRESULT CreateTextAnalyzer(IDWriteTextAnalyzer**) */
        { name: 'CreateTextAnalyzer', argBytes: bytes(1), invoke: (_o, [out])=>
            ((out >>> 0) === 0 ? E_INVALIDARG
                : give(out, analysis.analyzer(), IID.TEXT_ANALYZER, false)) },
        /**
         * HRESULT CreateNumberSubstitution(DWRITE_NUMBER_SUBSTITUTION_METHOD, WCHAR const
         *     *locale, BOOL ignoreUserOverride, IDWriteNumberSubstitution**)
         */
        { name: 'CreateNumberSubstitution', argBytes: bytes(4), invoke: (_o, args)=>{
            const [kind, locale, ignore, out] = args;
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [0]);
            const name = (locale >>> 0) === 0 ? null : string(locale, true, 85);
            // DWRITE_NUMBER_SUBSTITUTION_METHOD_NONE is the one that reads no locale.
            if ((kind >>> 0) > 4 || (kind >>> 0) !== 2 && (name === null
                || !/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(name)))
            {
                return E_INVALIDARG;
            }
            return give(out, newObject([descriptors.numberSubstitution], { kind: kind >>> 0,
                locale: name ?? '', ignore: ignore !== 0 }),
            IID.NUMBER_SUBSTITUTION);
        } },
        /**
         * HRESULT CreateGlyphRunAnalysis(DWRITE_GLYPH_RUN const*, FLOAT pixelsPerDip,
         *     DWRITE_MATRIX const*, DWRITE_RENDERING_MODE, DWRITE_MEASURING_MODE,
         *     FLOAT baselineOriginX, FLOAT baselineOriginY, IDWriteGlyphRunAnalysis**)
         */
        { name: 'CreateGlyphRunAnalysis', argBytes: bytes(8), invoke: (_o, args)=>{
            const out = args[7] >>> 0;
            if (out === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [0]);
            const made = analysis.glyphRun(args);
            return typeof made === 'number' ? made : give(out, made, IID.GLYPH_RUN_ANALYSIS);
        } },
    ] };

    /** A factory: its system collection and interop kept, its registered loaders. */
    const newFactory = ()=>newObject([descriptors.factory], { system: null, interop: null,
        faces: new Map(), fileLoaders: new Set(), collectionLoaders: new Set() });

    return {
        /** HRESULT DWriteCreateFactory(DWRITE_FACTORY_TYPE, REFIID, IUnknown **factory) */
        DWriteCreateFactory: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([type, iid, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                putU32s(out, [0]);
                if ((type >>> 0) !== SHARED && (type >>> 0) !== ISOLATED)
                {
                    return E_INVALIDARG;
                }
                const wanted = (iid >>> 0) === 0 ? '' : guidAt(iid);
                if (wanted !== IID.FACTORY && wanted !== IID.UNKNOWN)
                {
                    return E_NOINTERFACE;
                }
                if ((type >>> 0) === SHARED)
                {
                    if (sharedFactory)
                    {
                        return give(out, sharedFactory, IID.FACTORY, false);
                    }
                    // The shared factory lives as long as the process: the
                    // program's last release does not end it.
                    sharedFactory = newFactory();
                    sharedFactory.addRef();
                    return give(out, sharedFactory, IID.FACTORY);
                }
                return give(out, newFactory(), IID.FACTORY);
            },
        },
    };

    /** A GUID in guest memory, as the canonical text. @param {number} at */
    function guidAt(at){
        const raw = host.readMemory(at >>> 0, 16);
        const view = new DataView(raw.buffer, raw.byteOffset, 16);
        const hex = (/** @type {number} */ value, /** @type {number} */ digits)=>value
            .toString(16).toUpperCase().padStart(digits, '0');
        const tail = [...raw.subarray(8)].map(b=>hex(b, 2)).join('');
        return `{${hex(view.getUint32(0, true), 8)}-${hex(view.getUint16(4, true), 4)}-`
            + `${hex(view.getUint16(6, true), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}}`;
    }
}

export { GLYPH_COUNT, UNITS_PER_EM, openTypeTag };
