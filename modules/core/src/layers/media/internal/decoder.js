/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The JavaScript half of the video decoder: the C surface of the wasm module
 * built out of FFmpeg by scripts/video-decoder, wrapped so that nothing above this file handles
 * a raw pointer or an integer status.
 *
 * The module is a standalone wasm binary with no JavaScript glue of its own, so
 * every import it declares has to be answered here.
 */

/** Fields media_info() writes, in the order decoder.c writes them. */
const Info = {
    WIDTH: 0,
    HEIGHT: 1,
    PIXEL_FORMAT: 2,
    CODEC_ID: 3,
    FOURCC: 4,
    FRAME_COUNT: 5,
    FPS_NUM: 6,
    FPS_DEN: 7,
    SAMPLE_RATE: 8,
    CHANNELS: 9,
    HAS_VIDEO: 10,
    HAS_AUDIO: 11,
};
const INFO_FIELDS = 12;

/** What media_decode() answers with, by its status code. */
const Status = /** @type {const} */ (['frame', 'end', 'audio']);

/** Why media_open() refused. Named, because "it did not open" is the question
 * a bring-up spends the most time on. */
const Failure = new Map([
    [-1, 'invalid clip'],
    [-2, 'out of memory'],
    [-3, 'too many clips are open'],
    [-4, 'the container was not recognised'],
    [-5, 'the file carries neither video nor audio'],
    [-6, 'no decoder for this stream'],
    [-7, 'the stream description is unusable'],
    [-8, 'the decoded audio was not taken away'],
]);

/**
 * @typedef {Object} DecoderExports
 * @property {WebAssembly.Memory} memory
 * @property {(bytes: number) => number} media_alloc
 * @property {(block: number) => void} media_free
 * @property {(data: number, size: number) => number} media_open
 * @property {(id: number, out: number) => number} media_info
 * @property {(id: number) => number} media_codec_name
 * @property {(id: number) => number} media_decode
 * @property {(id: number) => number} media_frame
 * @property {(id: number) => number} media_audio_pending
 * @property {(id: number, out: number, max: number) => number} media_audio_read
 * @property {(id: number) => void} media_close
 */

/**
 * @typedef {Object} ClipInfo
 * @property {number} width
 * @property {number} height
 * @property {number} fps
 * @property {number} frameCount   Zero when the container does not say.
 * @property {string} codec        The decoder's own short name.
 * @property {string} fourcc       The container's tag, as its four characters.
 * @property {number} pixelFormat  The source format, before conversion to BGRA.
 * @property {number} sampleRate
 * @property {number} channels
 * @property {boolean} hasVideo
 * @property {boolean} hasAudio
 */

/**
 * One import namespace: what it declares, with anything else answered by a
 * function that returns zero.
 *
 * @param {Record<string, Function>} real
 * @returns {any}
 */
function namespace(real){
    return new Proxy(real, {
        get: (target, name)=>target[/** @type {string} */ (name)] ?? (()=>0),
    });
}

/**
 * Everything the module imports.
 *
 * It reaches the browser through nothing at all: the container comes from
 * memory, there is no clock, no argv and no filesystem behind it. But a curated
 * FFmpeg still *references* a handful of host entry points it never calls, and
 * which ones they are changes whenever the codec set does. Answering the whole
 * namespace with a function that returns zero keeps a rebuild from turning into
 * a link error here, and leaves the two that need real behaviour explicit.
 *
 * @returns {WebAssembly.Imports}
 */
function hostImports(){
    return {
        wasi_snapshot_preview1: namespace({
            // A decoder that decides to exit has nothing left to say through a
            // return code, so it says it by failing the call it was inside.
            proc_exit: (/** @type {number} */ code)=>{
                throw new Error(`media: the decoder aborted (exit ${code})`);
            },
        }),
        env: namespace({
            // Linear memory moves when it grows; every view here is taken from
            // the live buffer at the moment of use, so there is nothing to do.
            emscripten_notify_memory_growth: ()=>{},
        }),
    };
}

/**
 * Instantiates the decoder.
 *
 * The returned instance is the shared half: the compiled module, its linear
 * memory, the codec set and the counters of everything decoded through them. It
 * can be built once and used by one machine after another -- see
 * `decoderSession`, which is the half that belongs to a single machine.
 *
 * @param {BufferSource} wasmBytes The video-decoder.wasm binary.
 * @returns {Promise<any>}
 */
export async function createDecoder(wasmBytes){
    const { instance } = await WebAssembly.instantiate(wasmBytes, hostImports());
    const wasm = /** @type {DecoderExports} */ (/** @type {unknown} */ (instance.exports));

    const infoBuffer = wasm.media_alloc(INFO_FIELDS * 4);
    if (!infoBuffer)
    {
        throw new Error('media: the decoder would not give up its first allocation');
    }

    const counters = { opened: 0, frames: 0, audioBytes: 0 };
    /** @type {Set<{ close: () => void }>} */
    const open = new Set();

    /** @param {number} pointer @param {number} length @returns {Uint8Array} */
    const view = (pointer, length)=>new Uint8Array(wasm.memory.buffer, pointer, length);

    /** @param {number} pointer @returns {string} */
    const stringAt = pointer=>{
        if (!pointer)
        {
            return '';
        }
        const memory = new Uint8Array(wasm.memory.buffer);
        let end = pointer;
        while (end < memory.length && memory[end] !== 0)
        {
            end++;
        }
        return new TextDecoder().decode(memory.subarray(pointer, end));
    };

    /** @param {number} id @returns {ClipInfo} */
    const infoOf = id=>{
        if (wasm.media_info(id, infoBuffer) < 0)
        {
            throw new Error('media: the clip is closed');
        }
        const fields = new Int32Array(wasm.memory.buffer, infoBuffer, INFO_FIELDS);
        const tag = fields[Info.FOURCC] >>> 0;
        return {
            width: fields[Info.WIDTH],
            height: fields[Info.HEIGHT],
            fps: fields[Info.FPS_DEN] > 0 ? fields[Info.FPS_NUM] / fields[Info.FPS_DEN] : 0,
            frameCount: fields[Info.FRAME_COUNT],
            codec: stringAt(wasm.media_codec_name(id)),
            fourcc: tag === 0 ? '' : String.fromCharCode(
                tag & 0xff, (tag >>> 8) & 0xff, (tag >>> 16) & 0xff, (tag >>> 24) & 0xff),
            pixelFormat: fields[Info.PIXEL_FORMAT],
            sampleRate: fields[Info.SAMPLE_RATE],
            channels: fields[Info.CHANNELS],
            hasVideo: fields[Info.HAS_VIDEO] !== 0,
            hasAudio: fields[Info.HAS_AUDIO] !== 0,
        };
    };

    const decoder = {
        /**
         * Opens a container held in host memory.
         *
         * @param {Uint8Array} bytes The whole file.
         * @returns {any} the clip
         */
        open(bytes){
            const size = bytes.byteLength;
            const block = wasm.media_alloc(size);
            if (!block)
            {
                throw new Error(`media: no room for ${size} bytes in the decoder`);
            }
            view(block, size).set(bytes);
            // The decoder owns the block from here, whether or not it succeeds.
            const id = wasm.media_open(block, size);
            if (id < 0)
            {
                throw new Error(`media: ${Failure.get(id) ?? `unknown failure ${id}`}`);
            }
            counters.opened++;

            const info = infoOf(id);
            let closed = false;
            /** @param {string} what */
            const alive = what=>{
                if (closed)
                {
                    throw new Error(`media: ${what} on a closed clip`);
                }
            };

            const clip = {
                ...info,

                /**
                 * Advances the clip by one video frame, or until the audio it
                 * is holding has to be taken away from it.
                 *
                 * @returns {"frame" | "audio" | "end"}
                 */
                decode(){
                    alive('decode');
                    const status = wasm.media_decode(id);
                    if (status < 0)
                    {
                        throw new Error(`media: decode failed (${status})`);
                    }
                    if (status === 0)
                    {
                        counters.frames++;
                        // A stream that only settles its size once a frame
                        // exists is the reason this is read back rather than
                        // trusted from the header.
                        const now = infoOf(id);
                        clip.width = now.width;
                        clip.height = now.height;
                    }
                    return Status[status];
                },

                /**
                 * The current frame as BGRA, which is the byte order a Windows
                 * 32-bit surface is in, so a caller blits rather than converts.
                 *
                 * A view into the decoder's memory, valid until the next call
                 * into it. Copy anything that has to outlive that.
                 *
                 * @returns {Uint8Array | null}
                 */
                frame(){
                    alive('frame');
                    const pointer = wasm.media_frame(id);
                    if (!pointer || clip.width <= 0 || clip.height <= 0)
                    {
                        return null;
                    }
                    return view(pointer, clip.width * clip.height * 4);
                },

                /** Bytes of interleaved 16-bit PCM waiting to be read. */
                audioPending(){
                    alive('audioPending');
                    return wasm.media_audio_pending(id);
                },

                /**
                 * Takes the decoded PCM, interleaved and signed 16-bit at the
                 * clip's own sample rate. A copy, not a view: what consumes it
                 * outlives the next call into the decoder.
                 *
                 * @returns {Int16Array | null}
                 */
                readAudio(){
                    alive('readAudio');
                    const pending = wasm.media_audio_pending(id);
                    if (pending <= 0)
                    {
                        return null;
                    }
                    const scratch = wasm.media_alloc(pending);
                    if (!scratch)
                    {
                        return null;
                    }
                    const count = wasm.media_audio_read(id, scratch, pending);
                    const pcm = new Int16Array(
                        view(scratch, count).slice().buffer, 0, count >> 1);
                    wasm.media_free(scratch);
                    counters.audioBytes += count;
                    return pcm;
                },

                close(){
                    if (closed)
                    {
                        return;
                    }
                    closed = true;
                    open.delete(clip);
                    wasm.media_close(id);
                },
            };
            open.add(clip);
            return clip;
        },

        /** Closes every clip still open. */
        closeAll(){
            for (const clip of [...open])
            {
                clip.close();
            }
        },

        diagnostics(){
            return {
                ...counters,
                clips: open.size,
                heapBytes: wasm.memory.buffer.byteLength,
            };
        },
    };
    return decoder;
}

/**
 * A view of one decoder instance for one owner.
 *
 * A machine is a process, and the decoder is not: the compiled module and its
 * linear memory outlive the machine that first needed them, so the process that
 * replaces it -- or the next game in the same session -- opens clips over the
 * same instance instead of paying for another instantiation. What does belong
 * to the machine is the clips it opened: closing this view closes exactly those
 * and leaves the instance ready for whoever holds it next.
 *
 * The counters and the open-clip count this reports are the instance's, so a
 * reader watching them sees one decoder's life across however many machines
 * used it.
 *
 * @param {any} instance  A decoder built by `createDecoder`.
 * @returns {any}
 */
export function decoderSession(instance){
    /** @type {Set<{ close: () => void }>} */
    const mine = new Set();
    return {
        /** @param {Uint8Array} bytes @returns {any} */
        open(bytes){
            const clip = instance.open(bytes);
            mine.add(clip);
            return clip;
        },
        /** Closes the clips this view opened; the instance stays. */
        closeAll(){
            for (const clip of [...mine])
            {
                clip.close();
            }
            mine.clear();
        },
        diagnostics: ()=>instance.diagnostics(),
        /** The shared instance, for handing to the machine that replaces this one. */
        instance: ()=>instance,
    };
}
