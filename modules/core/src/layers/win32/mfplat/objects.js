/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Media Foundation's plain objects: an attribute store, a media type, a
 * memory buffer, a sample and an event -- what MFCreateAttributes,
 * MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample and
 * MFCreateMediaEvent hand out.
 *
 * Their contract is Wine's mfplat tests (test_media_type,
 * test_MFCreateMediaEvent, test_attributes, test_sample,
 * test_system_memory_buffer, test_IMFMediaType_GetRepresentation), which
 * hold what Windows answers. Among what they say: a media type answers
 * IMFVideoMediaType or IMFAudioMediaType only while its major type is video
 * or audio, and every interface it answers leads back to one IUnknown; it is
 * compressed unless MF_MT_ALL_SAMPLES_INDEPENDENT is set; a buffer's memory
 * is one block for its life, locked any number of times; a sample's total
 * length is its buffers' current lengths, its contiguous buffer is its only
 * buffer or one new buffer holding them all, and a copy that does not fit
 * empties the destination and leaves its bytes alone.
 */

import { ATTRIBUTES_SLOT, IID_IMFATTRIBUTES, MATCH, MF_E_ATTRIBUTENOTFOUND, MF_E_INVALIDTYPE, TYPE,
    createAttributes, matches, sameItem } from './attributes.js';
import { E_INVALIDARG, E_OUTOFMEMORY, E_POINTER, E_UNEXPECTED, S_FALSE, S_OK, drive }
    from './kit.js';

export const MF_E_BUFFERTOOSMALL = 0xc00d36b1 | 0;
export const MF_E_UNSUPPORTED_REPRESENTATION = 0xc00d36b7 | 0;
export const MF_E_NO_SAMPLE_TIMESTAMP = 0xc00d36c8 | 0;
export const MF_E_NO_SAMPLE_DURATION = 0xc00d36c9 | 0;

export const IID = Object.freeze({
    ATTRIBUTES: IID_IMFATTRIBUTES,
    MEDIA_TYPE: '{44AE0FA8-EA31-4109-8D2E-4CAE4997C555}',
    AUDIO_MEDIA_TYPE: '{26A0ADC3-CE26-4672-9304-69552EDD3FAF}',
    VIDEO_MEDIA_TYPE: '{B99F381F-A8F9-47A2-A5AF-CA3A225A3890}',
    MEDIA_BUFFER: '{045FA593-8799-42B8-BC8D-8968C6453507}',
    SAMPLE: '{C40A00F2-B93A-4D80-AE8C-5A1C634F58E4}',
    MEDIA_EVENT: '{DF598932-F10C-4E39-BBA2-C308F101DAA3}',
});

/** The attribute keys these objects read. */
export const KEY = Object.freeze({
    MAJOR_TYPE: '{48EBA18E-F8C9-4687-BF11-0A74C9F96A8F}',
    SUBTYPE: '{F7E34C9A-42E8-4714-B74B-CB29D72C35E5}',
    ALL_SAMPLES_INDEPENDENT: '{C9173739-5E56-461C-B713-46FB995CB95F}',
    FIXED_SIZE_SAMPLES: '{B8EBEFAF-B718-4E04-B0A9-116775E3321B}',
    SAMPLE_SIZE: '{DAD3AB78-1990-408B-BCE2-EBA673DACC10}',
    USER_DATA: '{B6BC765F-4C3B-40A4-BD51-2535B66FE09D}',
    FRAME_RATE_RANGE_MIN: '{D2E7558C-DC1F-403F-9A72-D28BB1EB3B5E}',
    FRAME_RATE_RANGE_MAX: '{E3371D41-B4CF-4A05-BD4E-20B88BB2C4D6}',
    AUDIO_NUM_CHANNELS: '{37E48BF5-645E-4C5B-89DE-ADA9E29B696A}',
    AUDIO_SAMPLES_PER_SECOND: '{5FAEEAE7-0290-4C31-9E8A-C534F68D9DBA}',
    AUDIO_AVG_BYTES_PER_SECOND: '{1AAB75C8-CFEF-451C-AB95-AC034B8E1731}',
    AUDIO_BLOCK_ALIGNMENT: '{322DE230-9EEB-43BD-AB7A-FF412251541D}',
    AUDIO_BITS_PER_SAMPLE: '{F2DEB57F-40FA-4764-AA33-ED4F2D1FF669}',
    AUDIO_VALID_BITS_PER_SAMPLE: '{D9BF8D6A-9530-4B7C-9DDF-FF6FD58BBD06}',
    AUDIO_CHANNEL_MASK: '{55FB5765-644A-4CAF-8479-938983BB1588}',
});

export const MAJOR = Object.freeze({
    AUDIO: '{73647561-0000-0010-8000-00AA00389B71}',
    VIDEO: '{73646976-0000-0010-8000-00AA00389B71}',
});

/** The representations GetRepresentation knows of. */
export const REPRESENTATION = Object.freeze({
    AM_MEDIA_TYPE: '{E2E42AD2-132C-491E-A268-3C7C2DCA181F}',
    WAVE_FORMAT_EX: '{05589F81-C356-11CE-BF01-00AA0055595A}',
    VIDEO_INFO: '{05589F80-C356-11CE-BF01-00AA0055595A}',
    VIDEO_INFO2: '{F72A76A0-EB0A-11D0-ACE4-0000C0CC16BA}',
    MF_VIDEO_FORMAT: '{AED4AB2D-7326-43CB-9464-C879CAB9C43D}',
});

/** MF_MEDIATYPE_EQUAL_*. */
export const EQUAL = Object.freeze({ MAJOR_TYPES: 1, FORMAT_TYPES: 2, FORMAT_DATA: 4,
    FORMAT_USER_DATA: 8 });

/** Keys IsEqual's format data leaves out, as the documentation of IsEqual names them. */
/** @type {Set<string>} */
const NOT_FORMAT_DATA = new Set([KEY.USER_DATA, KEY.FRAME_RATE_RANGE_MIN,
    KEY.FRAME_RATE_RANGE_MAX]);

/** The tail every audio subtype made from a wave format tag ends with. */
const FORMAT_TAG_TAIL = '-0000-0010-8000-00AA00389B71}';
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
const WAVEFORMATEX_SIZE = 18;
const EXTENSIBLE_EXTRA = 22;

/** AM_MEDIA_TYPE's bytes: majortype, subtype, three words, formattype, pUnk, cbFormat, pbFormat. */
const AM_MEDIA_TYPE_SIZE = 72;

/** IMFMediaBuffer's slots, as a foreign buffer is called. */
const BUFFER_SLOT = Object.freeze({ Lock: 3, Unlock: 4, GetCurrentLength: 5, SetCurrentLength: 6,
    GetMaxLength: 7 });

/**
 * The WAVEFORMATEX a media type describes, or WAVEFORMATEXTENSIBLE for one
 * with more than two channels or a channel mask; null without a subtype made
 * from a format tag.
 *
 * @param {Map<string, import('./attributes.js').Item>} items
 * @returns {Uint8Array | null}
 */
export function waveFormatOf(items){
    const subtype = items.get(KEY.SUBTYPE);
    if (subtype?.vt !== TYPE.GUID || !subtype.value.endsWith(FORMAT_TAG_TAIL)
        || !subtype.value.startsWith('{0000'))
    {
        return null;
    }
    /** @param {string} key */
    const number = key=>{
        const item = items.get(key);
        return item?.vt === TYPE.UINT32 ? item.value : 0;
    };
    const channels = number(KEY.AUDIO_NUM_CHANNELS);
    const extensible = channels > 2 || items.has(KEY.AUDIO_CHANNEL_MASK);
    const userData = items.get(KEY.USER_DATA);
    const extra = extensible ? EXTENSIBLE_EXTRA
        : userData?.vt === TYPE.BLOB ? userData.value.length : 0;
    const bytes = new Uint8Array(WAVEFORMATEX_SIZE + extra);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, extensible ? WAVE_FORMAT_EXTENSIBLE : parseInt(subtype.value.slice(1, 9), 16),
        true);
    view.setUint16(2, channels, true);
    view.setUint32(4, number(KEY.AUDIO_SAMPLES_PER_SECOND), true);
    view.setUint32(8, number(KEY.AUDIO_AVG_BYTES_PER_SECOND), true);
    view.setUint16(12, number(KEY.AUDIO_BLOCK_ALIGNMENT), true);
    view.setUint16(14, number(KEY.AUDIO_BITS_PER_SAMPLE), true);
    view.setUint16(16, extra, true);
    if (extensible)
    {
        view.setUint16(18, number(KEY.AUDIO_VALID_BITS_PER_SAMPLE)
            || number(KEY.AUDIO_BITS_PER_SAMPLE), true);
        view.setUint32(20, number(KEY.AUDIO_CHANNEL_MASK), true);
        const guid = /** @type {string} */ (subtype.value);
        const sub = new DataView(bytes.buffer, 24, 16);
        sub.setUint32(0, parseInt(guid.slice(1, 9), 16), true);
        sub.setUint16(4, 0, true);
        sub.setUint16(6, 0x10, true);
        bytes.set([0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71], 32);
    }
    else if (extra > 0)
    {
        bytes.set(/** @type {Uint8Array} */ (userData?.value), WAVEFORMATEX_SIZE);
    }
    return bytes;
}

/**
 * IsEqual's flags for two stores, or null when either has no major type.
 *
 * @param {Map<string, import('./attributes.js').Item>} ours
 * @param {Map<string, import('./attributes.js').Item>} theirs
 */
export function equalFlags(ours, theirs){
    if (!ours.has(KEY.MAJOR_TYPE) || !theirs.has(KEY.MAJOR_TYPE))
    {
        return null;
    }
    /** @param {string} key */
    const same = key=>(ours.has(key) || theirs.has(key)
        ? sameItem(ours.get(key), theirs.get(key)) : true);
    /** @param {Map<string, import('./attributes.js').Item>} store */
    const data = store=>new Map([...store].filter(([key])=>!NOT_FORMAT_DATA.has(key)));
    return (same(KEY.MAJOR_TYPE) ? EQUAL.MAJOR_TYPES : 0)
        | (same(KEY.SUBTYPE) ? EQUAL.FORMAT_TYPES : 0)
        | (matches(data(ours), data(theirs), MATCH.SMALLER) ? EQUAL.FORMAT_DATA : 0)
        | (same(KEY.USER_DATA) ? EQUAL.FORMAT_USER_DATA : 0);
}

/**
 * @param {import('./kit.js').MfKit} kit
 * @param {import('./kit.js').MfHost & {
 *     propVariant?: { copy: (dest: number, src: number) => number | Promise<number>,
 *         clear: (at: number) => number | Promise<number> } }} host
 */
export function createMfObjects(kit, host){
    const attributes = createAttributes(kit, host);
    const { putU32s, u32, putGuid } = kit;

    const attributesInterface = { id: IID.ATTRIBUTES, methods: attributes.methods };

    /**
     * A store of attributes, given back when its object goes.
     *
     * @param {Record<string, any>} [more]
     * @returns {any}
     */
    const storeState = (more = {})=>({ items: new Map(), ...more });

    /** @param {any} state */
    const forget = state=>()=>{
        attributes.clear(state.items);
    };

    /** IMFAttributes alone: MFCreateAttributes's object. */
    const createStore = ()=>{
        const state = storeState();
        return kit.make({ primary: attributesInterface, state, destroy: forget(state) });
    };

    // A media type.

    /** @param {any} object @param {string} key */
    const guidItem = (object, key)=>{
        const item = object.state.items.get(key);
        return item?.vt === TYPE.GUID ? item.value : null;
    };

    /**
     * An AM_MEDIA_TYPE for a media type in task memory, its format block
     * beside it, or why there is none.
     *
     * @param {any} object @param {string} representation
     * @returns {number}  the record's address, or a failing HRESULT
     */
    const amMediaType = (object, representation)=>{
        const known = /** @type {string[]} */ (Object.values(REPRESENTATION)).includes(representation);
        if (!known)
        {
            return MF_E_UNSUPPORTED_REPRESENTATION;
        }
        const major = object.state.items.get(KEY.MAJOR_TYPE);
        if (!major)
        {
            return MF_E_ATTRIBUTENOTFOUND;
        }
        const subtype = object.state.items.get(KEY.SUBTYPE);
        if (major.value === MAJOR.AUDIO)
        {
            if (!subtype)
            {
                return MF_E_ATTRIBUTENOTFOUND;
            }
            if (representation !== REPRESENTATION.AM_MEDIA_TYPE
                && representation !== REPRESENTATION.WAVE_FORMAT_EX)
            {
                return E_INVALIDARG;
            }
            const format = waveFormatOf(object.state.items);
            if (!format)
            {
                kit.sayOnce('IMFMediaType::GetRepresentation',
                    `an audio subtype ${subtype.value} with no wave format tag is not represented`);
                return MF_E_UNSUPPORTED_REPRESENTATION;
            }
            const record = host.heap.allocate(AM_MEDIA_TYPE_SIZE) >>> 0;
            const block = kit.taskCopy(format);
            if (record === 0 || block === 0)
            {
                host.heap.free(record);
                host.heap.free(block);
                return E_OUTOFMEMORY;
            }
            /** @param {string} key */
            const word = key=>{
                const item = object.state.items.get(key);
                return item?.vt === TYPE.UINT32 ? item.value : null;
            };
            const blockAlign = new DataView(format.buffer).getUint16(12, true);
            host.writeMemory(record, new Uint8Array(AM_MEDIA_TYPE_SIZE));
            putGuid(record, MAJOR.AUDIO);
            putGuid(record + 16, subtype.value);
            putU32s(record + 32, [word(KEY.FIXED_SIZE_SAMPLES) ?? 1,
                word(KEY.ALL_SAMPLES_INDEPENDENT) ? 0 : 1,
                word(KEY.SAMPLE_SIZE) ?? blockAlign]);
            putGuid(record + 44, REPRESENTATION.WAVE_FORMAT_EX);
            putU32s(record + 60, [0, format.length, block]);
            return record;
        }
        if (major.value === MAJOR.VIDEO)
        {
            if (!subtype)
            {
                return MF_E_ATTRIBUTENOTFOUND;
            }
            kit.sayOnce('IMFMediaType::GetRepresentation',
                'a video media type is not represented as an AM_MEDIA_TYPE');
            return MF_E_UNSUPPORTED_REPRESENTATION;
        }
        return MF_E_UNSUPPORTED_REPRESENTATION;
    };

    /** @param {any} object @param {number[]} words @param {number} out */
    const representation = (object, words, out)=>{
        if ((out >>> 0) === 0)
        {
            return E_POINTER;
        }
        const made = amMediaType(object, kit.guidOf(words));
        if (made < 0)
        {
            return made;
        }
        putU32s(out, [made]);
        return S_OK;
    };

    /** @type {import('../ole32/objects.js').ComMethod[]} */
    const mediaTypeMethods = [
        ...attributes.methods,
        /** HRESULT GetMajorType(GUID *major) */
        { name: 'GetMajorType', argBytes: 8, invoke: (object, [out])=>{
            const item = object.state.items.get(KEY.MAJOR_TYPE);
            if (!item)
            {
                return MF_E_ATTRIBUTENOTFOUND;
            }
            if (item.vt !== TYPE.GUID)
            {
                return MF_E_INVALIDTYPE;
            }
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            putGuid(out, item.value);
            return S_OK;
        } },
        /** HRESULT IsCompressedFormat(BOOL *compressed) */
        { name: 'IsCompressedFormat', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const independent = object.state.items.get(KEY.ALL_SAMPLES_INDEPENDENT);
            putU32s(out, [independent?.vt === TYPE.UINT32 && independent.value !== 0 ? 0 : 1]);
            return S_OK;
        } },
        /** HRESULT IsEqual(IMFMediaType *theirs, DWORD *flags) */
        { name: 'IsEqual', argBytes: 12, invoke: (object, [theirs, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            putU32s(out, [0]);
            if ((theirs >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            return drive((function* (){
                const other = yield attributes.itemsOf(theirs, host.callerThread?.());
                const flags = equalFlags(object.state.items, other);
                if (flags === null)
                {
                    return E_INVALIDARG;
                }
                putU32s(out, [flags]);
                return flags === 15 ? S_OK : S_FALSE;
            })());
        } },
        /** HRESULT GetRepresentation(GUID representation, void **out) */
        { name: 'GetRepresentation', argBytes: 24, invoke: (object, [a, b, c, d, out])=>
            representation(object, [a, b, c, d], out) },
        /**
         * HRESULT FreeRepresentation(GUID representation, void *record)
         *
         * Whatever the GUID: GetRepresentation makes only one kind.
         */
        { name: 'FreeRepresentation', argBytes: 24, invoke: (object, [, , , , record])=>{
            if ((record >>> 0) !== 0)
            {
                host.heap.free(u32(record + 68));
                host.heap.free(record >>> 0);
            }
            return S_OK;
        } },
    ];

    const mediaTypeInterface = { id: IID.MEDIA_TYPE, methods: mediaTypeMethods };
    const audioInterface = { id: IID.AUDIO_MEDIA_TYPE, methods: [
        ...mediaTypeMethods,
        /**
         * const WAVEFORMATEX *GetAudioFormat(void)
         *
         * Kept by the media type until it is asked again or goes.
         */
        { name: 'GetAudioFormat', argBytes: 4, invoke: (/** @type {any} */ object)=>{
            host.heap.free(object.state.audioFormat);
            const format = waveFormatOf(object.state.items);
            object.state.audioFormat = format ? kit.taskCopy(format) : 0;
            return object.state.audioFormat;
        } },
    ] };
    const videoInterface = { id: IID.VIDEO_MEDIA_TYPE, methods: [
        ...mediaTypeMethods,
        /** const MFVIDEOFORMAT *GetVideoFormat(void) */
        { name: 'GetVideoFormat', argBytes: 4, invoke: ()=>{
            kit.sayOnce('IMFVideoMediaType::GetVideoFormat', 'no MFVIDEOFORMAT is made: NULL');
            return 0;
        } },
        /** HRESULT GetVideoRepresentation(GUID representation, void **out, LONG stride) */
        { name: 'GetVideoRepresentation', argBytes: 28,
            invoke: (/** @type {any} */ object, /** @type {number[]} */ [a, b, c, d, out])=>
                representation(object, [a, b, c, d], out) },
    ] };

    /** @param {string} major */
    const majorIs = major=>(/** @type {any} */ object)=>guidItem(object, KEY.MAJOR_TYPE) === major;

    const createMediaType = ()=>{
        const state = storeState({ audioFormat: 0 });
        return kit.make({ primary: mediaTypeInterface, aliases: [IID.ATTRIBUTES], state,
            extras: [{ descriptor: videoInterface, when: majorIs(MAJOR.VIDEO) },
                { descriptor: audioInterface, when: majorIs(MAJOR.AUDIO) }],
            destroy: ()=>{
                host.heap.free(state.audioFormat);
                attributes.clear(state.items);
            } });
    };

    // A memory buffer.

    /** @type {import('../ole32/objects.js').ComMethod[]} */
    const bufferMethods = [
        /** HRESULT Lock(BYTE **data, DWORD *max, DWORD *current) */
        { name: 'Lock', argBytes: 16, invoke: (object, [data, max, current])=>{
            if ((data >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(data, [object.state.data]);
            if ((max >>> 0) !== 0)
            {
                putU32s(max, [object.state.max]);
            }
            if ((current >>> 0) !== 0)
            {
                putU32s(current, [object.state.current]);
            }
            return S_OK;
        } },
        /** HRESULT Unlock(void): the memory never moves, so nothing is held. */
        { name: 'Unlock', argBytes: 4, invoke: ()=>S_OK },
        /** HRESULT GetCurrentLength(DWORD *current) */
        { name: 'GetCurrentLength', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [object.state.current]);
            return S_OK;
        } },
        /** HRESULT SetCurrentLength(DWORD current) */
        { name: 'SetCurrentLength', argBytes: 8, invoke: (object, [current])=>{
            if ((current >>> 0) > object.state.max)
            {
                return E_INVALIDARG;
            }
            object.state.current = current >>> 0;
            return S_OK;
        } },
        /** HRESULT GetMaxLength(DWORD *max) */
        { name: 'GetMaxLength', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [object.state.max]);
            return S_OK;
        } },
    ];
    const bufferInterface = { id: IID.MEDIA_BUFFER, methods: bufferMethods };

    /**
     * A buffer over a block of the process heap, its memory starting on the
     * boundary `mask` (MF_16_BYTE_ALIGNMENT and the rest) names; null when
     * there is no room for one.
     *
     * @param {number} max @param {number} [mask]
     */
    const createBuffer = (max, mask = 0)=>{
        const block = host.heap.allocate(Math.max(max >>> 0, 1) + (mask >>> 0)) >>> 0;
        if (block === 0)
        {
            return null;
        }
        const data = ((block + (mask >>> 0)) & ~(mask >>> 0)) >>> 0;
        return kit.make({ primary: bufferInterface, state: { data, max: max >>> 0, current: 0 },
            destroy: ()=>host.heap.free(block) });
    };

    /**
     * A buffer's lengths and memory: ours read on the host, a foreign one's
     * through its own methods.
     *
     * @param {number} pointer @param {any} thread
     */
    const bufferOps = (pointer, thread)=>{
        const own = kit.ownAt(pointer);
        if (own)
        {
            const { state } = own;
            return {
                current: ()=>state.current,
                max: ()=>state.max,
                lock: ()=>state.data,
                unlock: ()=>S_OK,
                /** @param {number} n */
                setCurrent: n=>{
                    state.current = Math.min(n, state.max);
                    return S_OK;
                },
            };
        }
        /** @param {number} slot */
        const word = slot=>drive((function* (){
            const scratch = host.heap.allocate(4) >>> 0;
            try
            {
                putU32s(scratch, [0]);
                yield kit.guest(thread, pointer, slot, slot === BUFFER_SLOT.Lock
                    ? [scratch, 0, 0] : [scratch]);
                return u32(scratch);
            }
            finally
            {
                host.heap.free(scratch);
            }
        })());
        return {
            current: ()=>word(BUFFER_SLOT.GetCurrentLength),
            max: ()=>word(BUFFER_SLOT.GetMaxLength),
            lock: ()=>word(BUFFER_SLOT.Lock),
            unlock: ()=>kit.guest(thread, pointer, BUFFER_SLOT.Unlock, []),
            /** @param {number} n */
            setCurrent: (/** @type {number} */ n)=>kit.guest(thread, pointer,
                BUFFER_SLOT.SetCurrentLength, [n]),
        };
    };

    // A sample.

    /**
     * @param {any} object @param {any} thread
     * @returns {Generator<any, number, any>}
     */
    const totalOf = function* (object, thread){
        let total = 0;
        for (const pointer of object.state.buffers)
        {
            total += yield bufferOps(pointer, thread).current();
        }
        return total;
    };

    /**
     * Every buffer's current bytes, one after another, into memory at `to`.
     *
     * @param {any} object @param {number} to @param {any} thread
     * @returns {Generator<any, void, any>}
     */
    const gather = function* (object, to, thread){
        let at = to;
        for (const pointer of object.state.buffers)
        {
            const ops = bufferOps(pointer, thread);
            const length = yield ops.current();
            const data = yield ops.lock();
            if (length > 0)
            {
                host.writeMemory(at, host.readMemory(data, length).slice());
            }
            yield ops.unlock();
            at += length;
        }
    };

    /** @param {'time' | 'duration'} field @param {number} missing */
    const timeGetter = (field, missing)=>(/** @type {any} */ object, /** @type {number[]} */ [out])=>{
        if (object.state[field] === null)
        {
            return missing;
        }
        if ((out >>> 0) === 0)
        {
            return E_POINTER;
        }
        kit.putU64(out, object.state[field]);
        return S_OK;
    };
    /** @param {'time' | 'duration'} field */
    const timeSetter = field=>(/** @type {any} */ object, /** @type {number[]} */ [low, high])=>{
        object.state[field] = kit.wide(low, high);
        return S_OK;
    };

    /** @type {import('../ole32/objects.js').ComMethod[]} */
    const sampleMethods = [
        ...attributes.methods,
        /** HRESULT GetSampleFlags(DWORD *flags) */
        { name: 'GetSampleFlags', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            putU32s(out, [object.state.flags]);
            return S_OK;
        } },
        /** HRESULT SetSampleFlags(DWORD flags) */
        { name: 'SetSampleFlags', argBytes: 8, invoke: (object, [flags])=>{
            object.state.flags = flags >>> 0;
            return S_OK;
        } },
        /** HRESULT GetSampleTime(LONGLONG *time) */
        { name: 'GetSampleTime', argBytes: 8,
            invoke: timeGetter('time', MF_E_NO_SAMPLE_TIMESTAMP) },
        /** HRESULT SetSampleTime(LONGLONG time) */
        { name: 'SetSampleTime', argBytes: 12, invoke: timeSetter('time') },
        /** HRESULT GetSampleDuration(LONGLONG *duration) */
        { name: 'GetSampleDuration', argBytes: 8,
            invoke: timeGetter('duration', MF_E_NO_SAMPLE_DURATION) },
        /** HRESULT SetSampleDuration(LONGLONG duration) */
        { name: 'SetSampleDuration', argBytes: 12, invoke: timeSetter('duration') },
        /** HRESULT GetBufferCount(DWORD *count) */
        { name: 'GetBufferCount', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            putU32s(out, [object.state.buffers.length]);
            return S_OK;
        } },
        /** HRESULT GetBufferByIndex(DWORD index, IMFMediaBuffer **buffer) */
        { name: 'GetBufferByIndex', argBytes: 12, invoke: (object, [index, out])=>{
            const pointer = object.state.buffers[index >>> 0];
            if (pointer === undefined || (out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const thread = host.callerThread?.();
            return drive((function* (){
                yield kit.addRef(pointer, thread);
                putU32s(out, [pointer]);
                return S_OK;
            })());
        } },
        /** HRESULT ConvertToContiguousBuffer(IMFMediaBuffer **buffer) */
        { name: 'ConvertToContiguousBuffer', argBytes: 8, invoke: (object, [out])=>{
            const { buffers } = object.state;
            if (buffers.length === 0)
            {
                return E_UNEXPECTED;
            }
            const thread = host.callerThread?.();
            return drive((function* (){
                if (buffers.length > 1)
                {
                    const total = yield* totalOf(object, thread);
                    const joined = createBuffer(total);
                    if (!joined)
                    {
                        return E_OUTOFMEMORY;
                    }
                    const pointer = host.vtables?.publish(joined, joined.clsid) ?? 0;
                    if (pointer === 0)
                    {
                        joined.release();
                        return E_OUTOFMEMORY;
                    }
                    yield* gather(object, joined.state.data, thread);
                    joined.state.current = total;
                    const old = buffers.splice(0, buffers.length, pointer);
                    for (const before of old)
                    {
                        yield kit.release(before, thread);
                    }
                }
                if ((out >>> 0) !== 0)
                {
                    yield kit.addRef(buffers[0], thread);
                    putU32s(out, [buffers[0]]);
                }
                return yield kit.settle(S_OK, thread);
            })());
        } },
        /** HRESULT AddBuffer(IMFMediaBuffer *buffer) */
        { name: 'AddBuffer', argBytes: 8, invoke: (object, [pointer])=>{
            if ((pointer >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const thread = host.callerThread?.();
            return drive((function* (){
                yield kit.addRef(pointer, thread);
                object.state.buffers.push(pointer >>> 0);
                return S_OK;
            })());
        } },
        /** HRESULT RemoveBufferByIndex(DWORD index) */
        { name: 'RemoveBufferByIndex', argBytes: 8, invoke: (object, [index])=>{
            if ((index >>> 0) >= object.state.buffers.length)
            {
                return E_INVALIDARG;
            }
            const [pointer] = object.state.buffers.splice(index >>> 0, 1);
            const thread = host.callerThread?.();
            return drive((function* (){
                yield kit.release(pointer, thread);
                return yield kit.settle(S_OK, thread);
            })());
        } },
        /** HRESULT RemoveAllBuffers(void) */
        { name: 'RemoveAllBuffers', argBytes: 4, invoke: object=>{
            const old = object.state.buffers.splice(0);
            const thread = host.callerThread?.();
            return drive((function* (){
                for (const pointer of old)
                {
                    yield kit.release(pointer, thread);
                }
                return yield kit.settle(S_OK, thread);
            })());
        } },
        /** HRESULT GetTotalLength(DWORD *length) */
        { name: 'GetTotalLength', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            const thread = host.callerThread?.();
            return drive((function* (){
                putU32s(out, [yield* totalOf(object, thread)]);
                return S_OK;
            })());
        } },
        /** HRESULT CopyToBuffer(IMFMediaBuffer *buffer) */
        { name: 'CopyToBuffer', argBytes: 8, invoke: (object, [pointer])=>{
            if ((pointer >>> 0) === 0)
            {
                return E_POINTER;
            }
            const thread = host.callerThread?.();
            return drive((function* (){
                const destination = bufferOps(pointer, thread);
                const total = yield* totalOf(object, thread);
                if (total > (yield destination.max()))
                {
                    yield destination.setCurrent(0);
                    return MF_E_BUFFERTOOSMALL;
                }
                const data = yield destination.lock();
                yield* gather(object, data, thread);
                yield destination.unlock();
                yield destination.setCurrent(total);
                return S_OK;
            })());
        } },
    ];
    const sampleInterface = { id: IID.SAMPLE, methods: sampleMethods };

    const createSample = ()=>{
        const state = storeState({ flags: 0, time: null, duration: null,
            /** @type {number[]} */ buffers: [] });
        return kit.make({ primary: sampleInterface, aliases: [IID.ATTRIBUTES], state,
            destroy: ()=>{
                for (const pointer of state.buffers.splice(0))
                {
                    kit.release(pointer);
                }
                attributes.clear(state.items);
            } });
    };

    // An event.

    /** @type {import('../ole32/objects.js').ComMethod[]} */
    const eventMethods = [
        ...attributes.methods,
        /** HRESULT GetType(MediaEventType *type) */
        { name: 'GetType', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            putU32s(out, [object.state.type]);
            return S_OK;
        } },
        /** HRESULT GetExtendedType(GUID *type) */
        { name: 'GetExtendedType', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            putGuid(out, object.state.extended);
            return S_OK;
        } },
        /** HRESULT GetStatus(HRESULT *status) */
        { name: 'GetStatus', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            putU32s(out, [object.state.status]);
            return S_OK;
        } },
        /** HRESULT GetValue(PROPVARIANT *value) */
        { name: 'GetValue', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            if (!host.propVariant)
            {
                host.writeMemory(out >>> 0, new Uint8Array(16));
                return S_OK;
            }
            return host.propVariant.copy(out >>> 0, object.state.value);
        } },
    ];
    const eventInterface = { id: IID.MEDIA_EVENT, methods: eventMethods };

    /**
     * An event, its value a copy of the program's (PropVariantCopy's, so
     * whatever a PROPVARIANT may hold); null when there is no room.
     *
     * @param {number} type @param {string} extended @param {number} status @param {number} value
     * @returns {{ object: any, copied: number | Promise<number> } | null}
     */
    const createEvent = (type, extended, status, value)=>{
        const held = host.heap.allocate(16) >>> 0;
        if (held === 0)
        {
            return null;
        }
        host.writeMemory(held, new Uint8Array(16));
        const copied = (value >>> 0) !== 0 && host.propVariant
            ? host.propVariant.copy(held, value >>> 0) : S_OK;
        const state = storeState({ type: type >>> 0, extended, status: status >>> 0, value: held });
        /** @type {any} */
        const object = kit.make({ primary: eventInterface, aliases: [IID.ATTRIBUTES], state,
            destroy: ()=>attributes.clear(state.items) });
        // The value's own references go once the event does, through
        // PropVariantClear, which may call into the program.
        const owedBefore = object.afterRelease;
        /** @type {any} */ (object).afterRelease = ()=>{
            if (!object.destroyed)
            {
                return owedBefore?.();
            }
            const cleared = host.propVariant ? host.propVariant.clear(held) : S_OK;
            return drive((function* (){
                yield cleared;
                host.heap.free(held);
                return yield owedBefore?.();
            })());
        };
        return { object, copied };
    };

    return { attributes, createStore, createMediaType, createBuffer, createSample, createEvent,
        bufferOps, ATTRIBUTES_SLOT };
}

/** @typedef {ReturnType<typeof createMfObjects>} MfObjects */
