/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The streaming half of a filter graph: a source that feeds a filter the
 * program wrote itself.
 *
 * A program that wants a film's frames in a texture rather than in a window
 * builds a renderer on the SDK's base classes, adds it with AddFilter, adds the
 * file with AddSourceFilter and connects the source's pin to the renderer's.
 * On Windows the graph puts a splitter, a decompressor and a colour converter
 * between the two. Here the source's pin already offers what such a renderer
 * accepts -- uncompressed bottom-up RGB24 described by a VIDEOINFOHEADER --
 * because the decoder behind it is the media layer's. What the renderer can
 * observe is the same either way: a connection made through its
 * ReceiveConnection, an allocator handed to NotifyAllocator, and samples
 * arriving through IMemInputPin::Receive on a thread that is not the program's
 * own, then EndOfStream.
 *
 * Every call into the program's objects that is not made on behalf of a call
 * the program is in the middle of goes through one thread, in order: a sample
 * owed by the clock, the end of the stream, a flush for a seek, the releases a
 * torn-down graph owes. That order is what the base classes assume of an
 * upstream pin -- no Receive overlaps another, a flush is not overtaken by the
 * sample before it -- and one queue gives it for nothing.
 *
 * The samples carry no time stamps and the renderer is given no clock, so it
 * shows each one as it arrives; the pace is kept here instead, by the film's
 * own rate against the host clock, which is the same pace a clocked renderer
 * would keep.
 */

import { createComObject } from '../ole32/objects.js';
import { parseGuid } from '../ole32/guid.js';
import { describe } from './describe.js';
import {
    CLSID_ASYNC_READER, IBASE_FILTER_SLOTS, IID_IBASE_FILTER, IID_IMEDIA_FILTER,
    IID_IMEDIA_SAMPLE, IID_IMEM_ALLOCATOR, IID_IMEM_INPUT_PIN, IID_IPERSIST, IID_IPIN,
    IMEDIA_FILTER_SLOTS, IMEDIA_SAMPLE_SLOTS, IMEM_ALLOCATOR_SLOTS, IPIN_SLOTS, VTABLE,
} from './interfaces.js';

const S_OK = 0x00000000;
const S_FALSE = 0x00000001;
const E_POINTER = 0x80004003;
const E_UNEXPECTED = 0x8000ffff;
const VFW_E_NOT_FOUND = 0x80040216;
const VFW_E_CANNOT_CONNECT = 0x80040217;
const VFW_E_ALREADY_CONNECTED = 0x80040204;
const VFW_E_INVALID_DIRECTION = 0x80040208;
const VFW_E_NOT_CONNECTED = 0x80040209;
const VFW_E_NO_TRANSPORT = 0x80040266;
const VFW_E_SAMPLE_TIME_NOT_SET = 0x80040249;
const VFW_E_MEDIA_TIME_NOT_SET = 0x80040251;

const MEDIATYPE_VIDEO = '{73646976-0000-0010-8000-00AA00389B71}';
const MEDIASUBTYPE_RGB24 = '{E436EB7D-524F-11CE-9F53-0020AF0BA770}';
const FORMAT_VIDEO_INFO = '{05589F80-C356-11CE-BF01-00AA0055595A}';

/** AM_MEDIA_TYPE's fields. */
const MEDIA_TYPE = {
    MAJOR: 0x00, SUB: 0x10, FIXED_SIZE: 0x20, TEMPORAL: 0x24, SAMPLE_SIZE: 0x28,
    FORMAT_TYPE: 0x2c, UNKNOWN: 0x3c, FORMAT_BYTES: 0x40, FORMAT: 0x44, SIZE: 0x48,
};

/** VIDEOINFOHEADER: two RECTs, two rates, the frame time, then a BITMAPINFOHEADER. */
const VIDEO_INFO = { AVERAGE_TIME: 0x28, BITMAP: 0x30, SIZE: 0x58 };
const BITMAP_INFO_SIZE = 40;

const PINDIR_OUTPUT = 1;
const PIN_NAME = 'Output';
/** PIN_INFO and FILTER_INFO hold their names inline, this many wide characters. */
const MAX_NAME = 128;

const STATE_STOPPED = 0;

/** A REFERENCE_TIME is a hundred nanoseconds. */
const TICKS_PER_SECOND = 10_000_000;

/** The same catch-up budget the window path keeps; see graph.js. */
const FRAMES_PER_TICK = 4;
const STEPS_PER_TICK = 16;

/**
 * What of a clip a source reads: the graph's clip, seen from here.
 *
 * @typedef {Object} VideoClip
 * @property {number} width
 * @property {number} height
 * @property {number} fps
 * @property {boolean} hasVideo
 * @property {() => 'frame' | 'audio' | 'end'} decode
 * @property {() => Uint8Array | null} frame
 * @property {(() => Int16Array | null) | undefined} [readAudio]
 * @property {() => void} close
 *
 * @typedef {import('../ole32/objects.js').ComObject} ComObject
 */

/**
 * @typedef {Object} StreamHost
 * @property {(address: number) => number} readU32
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} free
 * @property {(entry: number, args: number[], thread: any) => Promise<number>} callGuest
 * @property {() => any} currentThread
 * @property {(object: ComObject, iid: string) => number} publish
 * @property {(pointer: number) => any} objectAt
 * @property {{ deliver: (entry: number, args: number[], done?: () => void) => void }} notices
 *           The thread calls owed to the program's objects are made on.
 */

/**
 * @typedef {Object} Source
 * @property {string} path
 * @property {VideoClip | null} clip
 * @property {ComObject} filter
 * @property {ComObject} pin
 * @property {ComObject} allocator
 * @property {ComObject} sample
 * @property {number} filterState
 * @property {number} width
 * @property {number} height
 * @property {number} stride
 * @property {number} size
 * @property {number} buffer       Guest memory a sample's bytes are in.
 * @property {Uint8Array} pixels   The same, staged on this side.
 * @property {number} actual
 * @property {boolean} discontinuity
 * @property {number} peer         The renderer's input pin, one reference held; 0 unconnected.
 * @property {number} memInput     Its IMemInputPin, one reference held.
 * @property {boolean} busy        A Receive is queued or running.
 * @property {boolean} ended       EndOfStream has been sent.
 * @property {number} shown
 * @property {number | null} startedAt
 */

/** @param {number} value @param {number} [count] */
const words = (value, count = 1)=>{
    const bytes = new Uint8Array(4 * count);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/** @param {string} text @param {number} units */
const wide = (text, units)=>{
    const bytes = new Uint8Array(units * 2);
    const view = new DataView(bytes.buffer);
    [...text.slice(0, units - 1)].forEach((ch, at)=>view.setUint16(at * 2, ch.charCodeAt(0), true));
    return bytes;
};

/**
 * Converts a BGRA frame into the bottom-up rows of a 24-bit DIB.
 *
 * @param {Uint8Array} bgra @param {Uint8Array} out
 * @param {number} width @param {number} height @param {number} stride
 */
export function packBottomUpRgb24(bgra, out, width, height, stride){
    for (let y = 0; y < height; y++)
    {
        let to = (height - 1 - y) * stride;
        let from = y * width * 4;
        for (let x = 0; x < width; x++, from += 4, to += 3)
        {
            out[to] = bgra[from];
            out[to + 1] = bgra[from + 1];
            out[to + 2] = bgra[from + 2];
        }
    }
}

/**
 * @param {StreamHost} host
 */
export function createStreaming(host){
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        if ((address >>> 0) === 0)
        {
            return E_POINTER;
        }
        host.writeMemory(address >>> 0, words(value));
        return S_OK;
    };

    /** @param {number} self @param {number} slot */
    const entryOf = (self, slot)=>host.readU32((host.readU32(self >>> 0) + slot * 4) >>> 0);

    /**
     * A method of one of the program's objects, called on the thread the
     * program is calling in on.
     *
     * @param {any} thread @param {number} self @param {number} slot @param {number[]} [args]
     */
    const call = async(thread, self, slot, args = [])=>
        (await host.callGuest(entryOf(self, slot), [self >>> 0, ...args], thread)) >>> 0;

    /**
     * The same, owed from no call in particular: queued on the streaming thread,
     * behind whatever is already owed.
     *
     * @param {number} self @param {number} slot @param {number[]} [args] @param {() => void} [done]
     */
    const later = (self, slot, args = [], done)=>
        host.notices.deliver(entryOf(self, slot), [self >>> 0, ...args], done);

    /** @param {number} result */
    const failed = result=>(result | 0) < 0;

    /** @param {any} thread @param {number} self @param {string} iid @returns {Promise<number>} */
    const queryInterface = async(thread, self, iid)=>{
        const scratch = host.allocate(20);
        host.writeMemory(scratch, /** @type {Uint8Array} */ (parseGuid(iid)));
        writeU32(scratch + 16, 0);
        const result = await call(thread, self, VTABLE.QueryInterface, [scratch, scratch + 16]);
        const pointer = host.readU32(scratch + 16);
        host.free(scratch);
        return failed(result) ? 0 : pointer;
    };

    /** The media type a connection is offered, written where the renderer can read it. @param {Source} source */
    const writeMediaType = source=>{
        const at = host.allocate(MEDIA_TYPE.SIZE + VIDEO_INFO.SIZE);
        const format = at + MEDIA_TYPE.SIZE;
        const bytes = new Uint8Array(MEDIA_TYPE.SIZE + VIDEO_INFO.SIZE);
        const view = new DataView(bytes.buffer);
        bytes.set(/** @type {Uint8Array} */ (parseGuid(MEDIATYPE_VIDEO)), MEDIA_TYPE.MAJOR);
        bytes.set(/** @type {Uint8Array} */ (parseGuid(MEDIASUBTYPE_RGB24)), MEDIA_TYPE.SUB);
        view.setUint32(MEDIA_TYPE.FIXED_SIZE, 1, true);
        view.setUint32(MEDIA_TYPE.TEMPORAL, 0, true);
        view.setUint32(MEDIA_TYPE.SAMPLE_SIZE, source.size, true);
        bytes.set(/** @type {Uint8Array} */ (parseGuid(FORMAT_VIDEO_INFO)), MEDIA_TYPE.FORMAT_TYPE);
        view.setUint32(MEDIA_TYPE.FORMAT_BYTES, VIDEO_INFO.SIZE, true);
        view.setUint32(MEDIA_TYPE.FORMAT, format, true);
        const fps = source.clip?.fps ?? 0;
        const info = MEDIA_TYPE.SIZE;
        view.setBigInt64(info + VIDEO_INFO.AVERAGE_TIME,
            BigInt(fps > 0 ? Math.round(TICKS_PER_SECOND / fps) : 0), true);
        const bitmap = info + VIDEO_INFO.BITMAP;
        view.setUint32(bitmap, BITMAP_INFO_SIZE, true);
        view.setInt32(bitmap + 4, source.width, true);
        // Positive: bottom-up, as every uncompressed RGB DIB a decoder hands out.
        view.setInt32(bitmap + 8, source.height, true);
        view.setUint16(bitmap + 12, 1, true);
        view.setUint16(bitmap + 14, 24, true);
        view.setUint32(bitmap + 20, source.size, true);
        host.writeMemory(at, bytes);
        return at;
    };

    /** @param {Source} source @param {() => void} [done] */
    const disconnect = (source, done)=>{
        if (source.peer === 0)
        {
            done?.();
            return S_FALSE;
        }
        later(source.peer, VTABLE.PinDisconnect);
        later(source.peer, VTABLE.Release);
        later(source.memInput, VTABLE.Release, [], done);
        source.peer = 0;
        source.memInput = 0;
        return S_OK;
    };

    /**
     * What a program's renderer is connected to: our pin, offering RGB24.
     *
     * The renderer copies the media type while it accepts it, so the copy here
     * is gone once ReceiveConnection returns. The allocator is ours -- an output
     * pin may insist on its own -- and is handed over the way CBaseOutputPin
     * hands over the one it decided on.
     *
     * @param {Source} source @param {number} peer @returns {Promise<number>}
     */
    const connect = async(source, peer)=>{
        const thread = host.currentThread();
        if (source.peer !== 0)
        {
            return VFW_E_ALREADY_CONNECTED;
        }
        if ((peer >>> 0) === 0)
        {
            return E_POINTER;
        }
        const mediaType = writeMediaType(source);
        const accepted = await call(thread, peer, VTABLE.PinReceiveConnection,
            [host.publish(source.pin, IID_IPIN), mediaType]);
        host.free(mediaType);
        if (failed(accepted))
        {
            return VFW_E_CANNOT_CONNECT;
        }
        const memInput = await queryInterface(thread, peer, IID_IMEM_INPUT_PIN);
        if (memInput === 0)
        {
            await call(thread, peer, VTABLE.PinDisconnect);
            return VFW_E_NO_TRANSPORT;
        }
        await call(thread, peer, VTABLE.AddRef);
        source.peer = peer >>> 0;
        source.memInput = memInput;
        const notified = await call(thread, memInput, VTABLE.MemNotifyAllocator,
            [host.publish(source.allocator, IID_IMEM_ALLOCATOR), 0]);
        if (failed(notified))
        {
            disconnect(source);
            return notified;
        }
        return S_OK;
    };

    /**
     * Advances a connected source as far as the clock says and sends the
     * newest frame, or the end of the stream. One sample at a time: the next
     * waits for the renderer to have returned from this one.
     *
     * @param {Source} source @param {number} nowMs
     */
    const feed = (source, nowMs)=>{
        const clip = source.clip;
        if (!clip || source.peer === 0 || source.busy || source.ended)
        {
            return;
        }
        if (source.startedAt === null)
        {
            source.startedAt = nowMs;
        }
        // The first frame is due the moment the stream starts.
        const want = Math.floor((nowMs - source.startedAt) * clip.fps / 1000) + 1;
        let packed = false;
        let decoded = 0;
        let steps = 0;
        while (source.shown < want && decoded < FRAMES_PER_TICK && steps++ < STEPS_PER_TICK)
        {
            const what = clip.decode();
            if (what === 'frame')
            {
                source.shown++;
                decoded++;
                const frame = clip.frame();
                if (frame)
                {
                    packBottomUpRgb24(frame, source.pixels, source.width, source.height,
                        source.stride);
                    packed = true;
                }
                continue;
            }
            if (what === 'audio')
            {
                // Nothing is connected to hear it.
                clip.readAudio?.();
                continue;
            }
            source.ended = true;
            break;
        }
        if (source.shown < want && !source.ended)
        {
            // A stall slows the film rather than throwing frames away.
            source.startedAt = nowMs - source.shown * 1000 / clip.fps;
        }
        if (packed)
        {
            host.writeMemory(source.buffer, source.pixels);
            source.actual = source.size;
            source.busy = true;
            const sample = host.publish(source.sample, IID_IMEDIA_SAMPLE);
            later(source.memInput, VTABLE.MemReceive, [sample],
                ()=>{
                    source.busy = false;
                    source.discontinuity = false;
                });
        }
        if (source.ended)
        {
            later(source.peer, VTABLE.PinEndOfStream);
        }
    };

    /**
     * Back to the start: the decoder reads forward only, so the file is opened
     * again, and the renderer is flushed the way a seek flushes it -- which is
     * also what clears the end of stream it was holding.
     *
     * @param {Source} source @param {VideoClip | null} clip
     */
    const restart = (source, clip)=>{
        source.clip?.close();
        source.clip = clip;
        source.shown = 0;
        source.startedAt = null;
        source.ended = false;
        source.discontinuity = true;
        if (source.peer !== 0)
        {
            later(source.peer, VTABLE.PinBeginFlush);
            later(source.peer, VTABLE.PinEndFlush);
        }
    };

    /** @param {Source} source */
    const close = source=>{
        source.clip?.close();
        source.clip = null;
        // The renderer may hold the last sample to repaint with until it is
        // disconnected, so its bytes go only once that has happened.
        disconnect(source, ()=>host.free(source.buffer));
    };

    /**
     * A source for a clip, with its pin, allocator and one sample.
     *
     * @param {VideoClip} clip @param {string} path @param {string} name
     * @param {() => number} graph  The graph's IFilterGraph, for QueryFilterInfo.
     * @returns {Source}
     */
    const createSource = (clip, path, name, graph)=>{
        const width = clip.width;
        const height = clip.height;
        const stride = (width * 3 + 3) & ~3;
        const size = stride * height;
        /** @type {Source} */
        const source = /** @type {any} */ ({
            path, clip, filterState: STATE_STOPPED, width, height, stride, size,
            buffer: host.allocate(size), pixels: new Uint8Array(size), actual: 0,
            discontinuity: true, peer: 0, memInput: 0, busy: false, ended: false,
            shown: 0, startedAt: null,
        });

        /** @type {Record<string, (state: Source, args: number[]) => number>} */
        const sample = {
            GetPointer: (s, [out])=>writeU32(out, s.buffer),
            GetSize: s=>s.size,
            // No time stamps: the renderer, which has no clock either, shows a
            // sample as it arrives, and the pace is kept on this side.
            GetTime: ()=>VFW_E_SAMPLE_TIME_NOT_SET,
            SetTime: ()=>S_OK,
            IsSyncPoint: ()=>S_OK,
            SetSyncPoint: ()=>S_OK,
            IsPreroll: ()=>S_FALSE,
            SetPreroll: ()=>S_OK,
            GetActualDataLength: s=>s.actual,
            SetActualDataLength: (s, [length])=>{
                s.actual = Math.min(length >>> 0, s.size);
                return S_OK;
            },
            GetMediaType: (s, [out])=>{
                writeU32(out, 0);
                return S_FALSE;
            },
            SetMediaType: ()=>S_OK,
            IsDiscontinuity: s=>(s.discontinuity ? S_OK : S_FALSE),
            SetDiscontinuity: (s, [value])=>{
                s.discontinuity = value !== 0;
                return S_OK;
            },
            GetMediaTime: ()=>VFW_E_MEDIA_TIME_NOT_SET,
            SetMediaTime: ()=>S_OK,
        };
        source.sample = createComObject(IID_IMEDIA_SAMPLE, {
            state: source, interfaces: [describe(IID_IMEDIA_SAMPLE, IMEDIA_SAMPLE_SLOTS, sample)],
        });

        /** ALLOCATOR_PROPERTIES: cBuffers, cbBuffer, cbAlign, cbPrefix. @param {Source} s @param {number} out */
        const properties = (s, out)=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            [1, s.size, 1, 0].forEach((value, at)=>writeU32(out + at * 4, value));
            return S_OK;
        };
        /** @type {Record<string, (state: Source, args: number[]) => number>} */
        const allocator = {
            // One buffer of the frame's size, whatever was asked: the actual
            // properties say so, which is how an allocator answers a request it
            // cannot meet exactly.
            SetProperties: (s, [, actual])=>properties(s, actual),
            GetProperties: (s, [out])=>properties(s, out),
            Commit: ()=>S_OK,
            Decommit: ()=>S_OK,
            GetBuffer: (s, [out])=>{
                s.sample.addRef();
                return writeU32(out, host.publish(s.sample, IID_IMEDIA_SAMPLE));
            },
            ReleaseBuffer: ()=>S_OK,
        };
        source.allocator = createComObject(IID_IMEM_ALLOCATOR, {
            state: source,
            interfaces: [describe(IID_IMEM_ALLOCATOR, IMEM_ALLOCATOR_SLOTS, allocator)],
        });

        /** @type {Record<string, (state: Source, args: number[]) => number | Promise<number>>} */
        const pin = {
            Connect: (s, [peer])=>connect(s, peer),
            ReceiveConnection: ()=>VFW_E_INVALID_DIRECTION,
            Disconnect: s=>disconnect(s),
            ConnectedTo: (s, [out])=>{
                if (s.peer === 0)
                {
                    writeU32(out, 0);
                    return VFW_E_NOT_CONNECTED;
                }
                const thread = host.currentThread();
                return call(thread, s.peer, VTABLE.AddRef).then(()=>writeU32(out, s.peer));
            },
            QueryPinInfo: (s, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                s.filter.addRef();
                writeU32(out, host.publish(s.filter, IID_IBASE_FILTER));
                writeU32(out + 4, PINDIR_OUTPUT);
                host.writeMemory(out + 8, wide(PIN_NAME, MAX_NAME));
                return S_OK;
            },
            QueryDirection: (s, [out])=>writeU32(out, PINDIR_OUTPUT),
            QueryAccept: ()=>S_OK,
            EndOfStream: ()=>E_UNEXPECTED,
            BeginFlush: ()=>E_UNEXPECTED,
            EndFlush: ()=>E_UNEXPECTED,
            NewSegment: ()=>S_OK,
        };
        source.pin = createComObject(IID_IPIN, {
            state: source, interfaces: [describe(IID_IPIN, IPIN_SLOTS, pin)],
        });

        /** @type {Record<string, (state: Source, args: number[]) => number>} */
        const filter = {
            GetClassID: (s, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                host.writeMemory(out, /** @type {Uint8Array} */ (parseGuid(CLSID_ASYNC_READER)));
                return S_OK;
            },
            Stop: s=>{
                s.filterState = 0;
                return S_OK;
            },
            Pause: s=>{
                s.filterState = 1;
                return S_OK;
            },
            Run: s=>{
                s.filterState = 2;
                return S_OK;
            },
            GetState: (s, [, out])=>writeU32(out, s.filterState),
            SetSyncSource: ()=>S_OK,
            GetSyncSource: (s, [out])=>writeU32(out, 0),
            FindPin: (s, [id, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                if ((id >>> 0) === 0 || host.readWideString(id, MAX_NAME) !== PIN_NAME)
                {
                    writeU32(out, 0);
                    return VFW_E_NOT_FOUND;
                }
                s.pin.addRef();
                return writeU32(out, host.publish(s.pin, IID_IPIN));
            },
            QueryFilterInfo: (s, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_POINTER;
                }
                host.writeMemory(out, wide(name, MAX_NAME));
                return writeU32(out + MAX_NAME * 2, graph());
            },
            JoinFilterGraph: ()=>S_OK,
        };
        source.filter = createComObject(CLSID_ASYNC_READER, {
            state: source,
            interfaces: [
                describe(IID_IPERSIST, IMEDIA_FILTER_SLOTS.slice(0, 1), filter),
                describe(IID_IMEDIA_FILTER, IMEDIA_FILTER_SLOTS, filter),
                describe(IID_IBASE_FILTER, IBASE_FILTER_SLOTS, filter),
            ],
        });
        return source;
    };

    /**
     * Calls one IMediaFilter method on each of the program's filters in turn,
     * on the calling thread; the first failure is the answer.
     *
     * @param {number[]} filters @param {number} slot @param {number[]} [args]
     */
    const each = async(filters, slot, args = [])=>{
        const thread = host.currentThread();
        let result = S_OK;
        for (const filter of filters)
        {
            const answer = await call(thread, filter, slot, args);
            result = failed(result) ? result : answer;
        }
        return result;
    };

    /** The program's own filter, now in a graph. @param {number} filter @param {number} graph @param {number} name */
    const join = async(filter, graph, name)=>{
        const thread = host.currentThread();
        await call(thread, filter, VTABLE.AddRef);
        const joined = await call(thread, filter, VTABLE.FilterJoinGraph, [graph, name]);
        if (failed(joined))
        {
            await call(thread, filter, VTABLE.Release);
        }
        return joined;
    };

    /** Out of the graph, from any thread: queued. @param {number} filter @param {boolean} running */
    const leave = (filter, running)=>{
        if (running)
        {
            later(filter, VTABLE.FilterStop);
        }
        later(filter, VTABLE.FilterJoinGraph, [0, 0]);
        later(filter, VTABLE.Release);
    };

    /** The same, on the calling thread. @param {number} filter */
    const remove = async filter=>{
        const thread = host.currentThread();
        await call(thread, filter, VTABLE.FilterJoinGraph, [0, 0]);
        await call(thread, filter, VTABLE.Release);
        return S_OK;
    };

    return { createSource, connect, feed, restart, close, each, join, leave, remove };
}
