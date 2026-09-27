/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The decoding end of a film, on a thread of its own.
 *
 * Decoding a cinematic is the heaviest thing the engine's thread did that was
 * not the program: a frame of a 640x480 film costs milliseconds of FFmpeg, and
 * the thread that pays them is the one translating and running the guest. Here
 * the decoder runs beside it and works ahead: every open clip is decoded until
 * `AHEAD` frames are waiting to be taken, and each frame taken buys one more.
 * The engine's side (`remote-clip.js`) only picks up what is ready.
 *
 * What travels is the decoder's own sequence of events -- a frame, a block of
 * sound, the end -- in the order it produced them, so the filter graph that
 * consumes them sees exactly what it saw when it called the decoder itself.
 */

/** Frames decoded and not yet taken, per clip: a quarter of a second at 24 fps. */
export const AHEAD = 6;

/** Decoder steps one round may take for a clip, so one clip cannot hold the thread. */
const STEPS_PER_ROUND = 64;

/**
 * @typedef {Object} ClipPort
 * @property {(message: any, transfer?: Transferable[]) => void} post
 */

/**
 * Serves clips over a port.
 *
 * @param {ClipPort} port
 * @param {Promise<any>} decoderReady  A decoder made by `createDecoder`.
 * @param {((picture: { width: number, height: number, bgra: Uint8Array },
 *     out: Uint8Array, shape: any) => void) | null} [fit]
 *     Lays a frame out on the screen the engine last described, so the engine
 *     shows it as it comes rather than scaling it on its own thread.
 * @returns {(message: any) => void} what to do with each message that arrives
 */
export function serveClips(port, decoderReady, fit = null){
    /** The screen and placement frames are laid out for, with the key naming it. */
    /** @type {{ key: string, width: number, height: number } | null} */
    let shape = null;
    /** @type {Map<number, { clip: any, owed: number, ended: boolean }>} */
    const clips = new Map();
    let scheduled = false;

    /** @param {number} id @param {{ clip: any, owed: number, ended: boolean }} entry */
    const advance = (id, entry)=>{
        let steps = 0;
        while (!entry.ended && entry.owed > 0 && steps++ < STEPS_PER_ROUND)
        {
            let what;
            try
            {
                what = entry.clip.decode();
            }
            catch (e){
                entry.ended = true;
                port.post({ type: 'event', id, kind: 'end',
                    error: e instanceof Error ? e.message : String(e) });
                return;
            }
            if (what === 'frame')
            {
                const view = entry.clip.frame();
                const width = entry.clip.width;
                const height = entry.clip.height;
                let bgra = null;
                let fitted = null;
                if (view && fit && shape)
                {
                    bgra = new Uint8Array(shape.width * shape.height * 4);
                    fit({ width, height, bgra: view }, bgra, shape);
                    fitted = shape.key;
                }
                else if (view)
                {
                    bgra = view.slice();
                }
                entry.owed--;
                port.post({ type: 'event', id, kind: 'frame', bgra, width, height, fitted },
                    bgra ? [bgra.buffer] : []);
            }
            else if (what === 'audio')
            {
                const pcm = entry.clip.readAudio();
                if (pcm)
                {
                    port.post({ type: 'event', id, kind: 'audio', pcm }, [pcm.buffer]);
                }
            }
            else
            {
                const residue = entry.clip.readAudio();
                if (residue)
                {
                    port.post({ type: 'event', id, kind: 'audio', pcm: residue },
                        [residue.buffer]);
                }
                entry.ended = true;
                port.post({ type: 'event', id, kind: 'end' });
            }
        }
    };

    // One round over every clip, then a return to the thread's own queue, so a
    // credit or a close that arrived meanwhile is seen before more decoding.
    const round = ()=>{
        scheduled = false;
        let more = false;
        for (const [id, entry] of clips)
        {
            advance(id, entry);
            more ||= !entry.ended && entry.owed > 0;
        }
        if (more)
        {
            schedule();
        }
    };
    const schedule = ()=>{
        if (!scheduled)
        {
            scheduled = true;
            setTimeout(round, 0);
        }
    };

    return async message=>{
        switch (message?.type)
        {
            case 'open':
            {
                try
                {
                    const decoder = await decoderReady;
                    const clip = decoder.open(message.bytes);
                    const info = Object.fromEntries(Object.entries(clip)
                        .filter(([, value])=>typeof value !== 'function'));
                    clips.set(message.id, { clip, owed: AHEAD, ended: false });
                    port.post({ type: 'opened', id: message.id, info });
                    schedule();
                }
                catch (e){
                    port.post({ type: 'failed', id: message.id,
                        message: e instanceof Error ? e.message : String(e) });
                }
                break;
            }
            case 'fit':
                shape = message.shape;
                break;
            case 'credit':
            {
                const entry = clips.get(message.id);
                if (entry)
                {
                    entry.owed += message.frames;
                    schedule();
                }
                break;
            }
            case 'close':
            {
                clips.get(message.id)?.clip.close();
                clips.delete(message.id);
                break;
            }
            default:
                break;
        }
    };
}
