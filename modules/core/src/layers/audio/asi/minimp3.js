/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The hosted MPEG Layer 3 decoder: minimp3 built to WebAssembly (see
 * THIRD-PARTY-NOTICES.md and minimp3.LICENSE), one instance per stream.
 *
 * It answers inside feed, so a stream never waits on it. The instance is kept
 * for the whole stream: a frame's audio may begin in the frames before it, and
 * the decoder carries those bytes from one call to the next.
 */

import { MINIMP3_WASM } from './minimp3.wasm.js';

const module = new WebAssembly.Module(Uint8Array.from(atob(MINIMP3_WASM), c=>c.charCodeAt(0)));

/**
 * A frame that decodes short is padded with silence to its whole length, so
 * the samples a stream owes the library stay on the frame grid.
 *
 * @returns {import('./mp3.js').Decoder}
 */
export function createMinimp3Decoder(){
    let opens = 0;
    let padded = 0;
    return {
        open(header, onPcm, onError){
            opens++;
            const w = /** @type {any} */ (new WebAssembly.Instance(module, {}).exports);
            w.decoder_init();
            return {
                feed(bytes, frame){
                    try
                    {
                        w.decoder_set_mp3_data_size(bytes.length);
                        new Uint8Array(w.memory.buffer, w.decoder_mp3_data_offset(), bytes.length)
                            .set(bytes);
                        w.decoder_seek(0);
                        w.decoder_decode(1.5 * frame.samples / frame.sampleRate);
                        const n = w.decode_results_num_samples();
                        const owed = frame.samples * frame.channels;
                        const pcm = new Int16Array(Math.max(n, owed));
                        if (n < owed)
                        {
                            padded++;
                        }
                        pcm.set(new Int16Array(w.memory.buffer, w.decoder_pcm_data_offset(), n));
                        onPcm(pcm);
                    }
                    catch (e){
                        onError(e instanceof Error ? e : new Error(String(e)));
                    }
                },
                flush: ()=>Promise.resolve(),
                close(){},
            };
        },
        diagnostics: ()=>({ name: 'minimp3', opens, paddedFrames: padded }),
    };
}
