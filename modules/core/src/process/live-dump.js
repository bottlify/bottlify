/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A running program's frames taken apart while it runs: written down by the
 * graphics worker on asking, picked out, frozen on screen - for a person
 * looking at what it draws (`app.debug`).
 */

/**
 * A running program's frames written down on asking, by the devices the
 * graphics worker plays: `dumpFrames(n)` has the next n frames with draws
 * written down, every draw with its shaders, stages and state, and
 * `dumped()` is the last of them as the worker sent it -- from the device
 * that drew it, which a diagnostics table read a report later need not be.
 *
 * @param {any} worker  the graphics worker, when the run has one
 * @param {{ pause: () => void, resume: () => void, paused: () => boolean }} [control]
 *     the run's pause, which `pick` holds while it takes a frame apart and
 *     `freeze` while it shows one
 */
export function liveDumpOf(worker, control){
    /** @type {{ lines: string[], frame: number } | null} */
    let last = null;
    let listening = false;
    /** Whether `freeze` paused the run, and so is the one to resume it. */
    let frozePaused = false;
    /** The textures read off the GPU on asking (`snapshot`), by the id a dump gives. @type {Map<string, any>} */
    const shots = new Map();
    const listen = ()=>{
        if (listening || !worker)
        {
            return;
        }
        listening = true;
        worker.addEventListener('message', (/** @type {{ data: any }} */ event)=>{
            if (event.data?.type === 'dumped')
            {
                last = { lines: event.data.lines, frame: event.data.frame };
            }
            if (event.data?.type === 'frozen')
            {
                // The frame a pause holds, as a dump: what `snapshot` then reads from.
                last = { lines: event.data.lines, frame: -1 };
            }
            if (event.data?.type === 'snapped')
            {
                const { id, width, height, format, data, info } = event.data;
                shots.set(id, { width, height, format, data, info: info ?? null });
            }
        });
    };
    /** @param {number} [frames] */
    const dumpFrames = (frames = 1)=>{
        if (!worker)
        {
            throw new Error('dumpFrames: this run draws without a graphics worker');
        }
        listen();
        worker.postMessage({ type: 'debug', dumpFrames: frames });
        return frames;
    };
    return {
        dumpFrames,
        /**
         * The graphics worker's capture of what it is sent (a worker opened
         * with `capture`, `remote/capture.js`) keeps `frames` more presents
         * from now and ends: the frames `tools/read/graphics-replay.mjs` measures.
         *
         * @param {number} [frames]
         */
        captureFrames: (frames = 300)=>{
            if (!worker)
            {
                throw new Error('captureFrames: this run draws without a graphics worker');
            }
            worker.postMessage({ type: 'debug', captureFrames: frames });
            return frames;
        },
        /**
         * The capture, ended: its gzip bytes and what it counted, or null
         * bytes when the worker was opened without one.
         *
         * @returns {Promise<{ bytes: Uint8Array | null, counts: any }>}
         */
        captured: ()=>{
            if (!worker)
            {
                return Promise.reject(
                    new Error('captured: this run draws without a graphics worker'));
            }
            return new Promise(resolve=>{
                /** @param {{ data: any }} event */
                const take = event=>{
                    if (event.data?.type === 'captured')
                    {
                        worker.removeEventListener('message', take);
                        resolve({ bytes: event.data.bytes ?? null,
                            counts: event.data.counts ?? null });
                    }
                };
                worker.addEventListener('message', take);
                worker.postMessage({ type: 'debug', captured: true });
            });
        },
        /**
         * A texture as the GPU holds it at the end of the next frame -- `t4414`
         * as a frame dump names it, its top level, in its GPU format -- for
         * `snapped` to hand over: what an intermediate target or a shadow
         * map holds, which a dump of the draws cannot show.
         *
         * @param {string} id
         */
        snapshot: id=>{
            if (!worker)
            {
                throw new Error('snapshot: this run draws without a graphics worker');
            }
            listen();
            shots.delete(String(id));
            worker.postMessage({ type: 'debug', snapshot: String(id) });
            return String(id);
        },
        /**
         * The texture `snapshot` asked for, once the frame has read it: its size,
         * GPU format and texels, or null until then.
         *
         * @param {string} id
         */
        snapped: id=>shots.get(String(id)) ?? null,
        /**
         * How the worker's devices take buffer locks from now on: '' as the
         * program asked, 'rename' renaming at every one.
         *
         * @param {string} [mode]
         */
        bufferLocks: (mode = '')=>{
            if (!worker)
            {
                throw new Error('bufferLocks: this run draws without a graphics worker');
            }
            worker.postMessage({ type: 'debug', bufferLocks: mode });
            return mode;
        },
        /**
         * Drops every draw that samples one of these textures from now on --
         * `t12,t40` as a frame dump names them, '' none -- so two frames
         * differ by those draws and nothing else.
         *
         * @param {string} [ids]
         */
        skipTexture: (ids = '')=>{
            if (!worker)
            {
                throw new Error('skipTexture: this run draws without a graphics worker');
            }
            worker.postMessage({ type: 'debug', skipTexture: ids });
            return ids;
        },
        /**
         * Drops every draw made with one of these shaders from now on --
         * `vs12,ps40` as a frame dump names them, '' none: the effect one
         * shader paints, found by taking it away.
         *
         * @param {string} [ids]
         */
        /**
         * Significant digits a frame dump writes constants with from now on
         * (4, up to 9 -- every digit a float holds).
         *
         * @param {number} [digits]
         */
        dumpDigits: (digits = 4)=>{
            if (!worker)
            {
                throw new Error('dumpDigits: this run draws without a graphics worker');
            }
            worker.postMessage({ type: 'debug', dumpDigits: digits });
            return digits;
        },
        /**
         * Does sRGB reads and writes (D3DSAMP_SRGBTEXTURE, D3DRS_SRGBWRITEENABLE),
         * or with false reads and writes every texel as stored from the next draw.
         *
         * @param {boolean} [on]
         */
        srgb: (on = true)=>{
            if (!worker)
            {
                throw new Error('srgb: this run draws without a graphics worker');
            }
            worker.postMessage({ type: 'debug', srgb: on });
            return on;
        },
        skipShader: (ids = '')=>{
            if (!worker)
            {
                throw new Error('skipShader: this run draws without a graphics worker');
            }
            worker.postMessage({ type: 'debug', skipShader: ids });
            return ids;
        },
        /**
         * Keeps the first `count` texture stages of every fixed-function draw
         * from now on, the rest as if disabled, -1 all: the cost or the look a
         * stage adds, found by taking it away -- the stages have no shader of
         * the program's for `skipShader` to name.
         *
         * @param {number} [count]
         */
        /**
         * Adds to every frame dump from now on a line for each of these
         * textures -- `t642` as a dump names it, '' none -- with what its top
         * level holds in guest memory: least, most, mean and the share zero.
         *
         * @param {string} [ids]
         */
        textureStats: (ids = '')=>{
            if (!worker)
            {
                throw new Error('textureStats: this run draws without a graphics worker');
            }
            worker.postMessage({ type: 'debug', textureStats: ids });
            return ids;
        },
        stageLimit: (count = -1)=>{
            if (!worker)
            {
                throw new Error('stageLimit: this run draws without a graphics worker');
            }
            worker.postMessage({ type: 'debug', stageLimit: count });
            return count;
        },
        /**
         * Keeps the first `count` draws of every frame from now on and drops
         * the rest, -1 none dropped: halving it finds the draw that painted a
         * part of the picture, numbered as a frame dump numbers them.
         *
         * @param {number} [count]
         */
        maxDraws: (count = -1)=>{
            if (!worker)
            {
                throw new Error('maxDraws: this run draws without a graphics worker');
            }
            worker.postMessage({ type: 'debug', maxDraws: count });
            return count;
        },
        /**
         * How the worker's devices answer occlusion counts from now on: ''
         * as counted, 'visible' as if every sample passed -- what a program
         * culls by its counts shows up.
         *
         * @param {string} [mode]
         */
        occlusion: (mode = '')=>{
            if (!worker)
            {
                throw new Error('occlusion: this run draws without a graphics worker');
            }
            worker.postMessage({ type: 'debug', occlusion: mode });
            return mode;
        },
        dumped: ()=>last,
        /**
         * Shows the last frame again and again, the program paused, so a cut
         * (`maxDraws`) is seen on a picture that holds still; false stops it.
         * A running program is paused here and resumed by `freeze(false)`: a
         * program left running presents new frames, and the frame shown again
         * becomes each new one, so a switch is never seen on one picture. A
         * pause someone else holds stays theirs.
         *
         * @param {boolean} [on]
         */
        freeze: (on = true)=>{
            if (!worker)
            {
                throw new Error('freeze: this run draws without a graphics worker');
            }
            listen();
            if (on && !frozePaused && control && !control.paused())
            {
                control.pause();
                frozePaused = true;
            }
            else if (!on && frozePaused)
            {
                control?.resume();
                frozePaused = false;
            }
            worker.postMessage({ type: 'debug', freeze: on });
            return on;
        },
        /**
         * A shader the program drew with, by the id a dump names it ('ps585',
         * 'vs31'): its bytecode and every WGSL translation made of it, or null
         * when nothing drew with it yet.
         *
         * @param {string} id
         * @returns {Promise<{ tokens: number[], translations: { tag: string, wgsl: string,
         *     error: string | null }[] } | null>}
         */
        shader: id=>new Promise((resolve, reject)=>{
            if (!worker)
            {
                reject(new Error('shader: this run draws without a graphics worker'));
                return;
            }
            const hear = (/** @type {{ data: any }} */ event)=>{
                if (event.data?.type === 'shaderText' && event.data.id === id)
                {
                    worker.removeEventListener('message', hear);
                    resolve(event.data.result);
                }
            };
            worker.addEventListener('message', hear);
            worker.postMessage({ type: 'debug', shader: id });
        }),
        /**
         * Which draw painted a pixel of the picture: the program is paused and
         * the graphics worker plays its last frame again cut after fewer and
         * fewer draws, reading the pixel back each time, halving to the first
         * count at which it is as the scene leaves it (before the frame's
         * post-processing). The centre -- a crosshair -- by default; the run
         * is left paused as it was found.
         *
         * @param {number} [x] @param {number} [y]  the shown frame's pixels
         * @param {{ tolerance?: number, depth?: number }} [options]  how far a
         *     channel may differ and still be the same pixel; how many of the
         *     draws that changed it to list, latest first (4)
         */
        pick: async(x, y, options = {})=>{
            if (!worker)
            {
                throw new Error('pick: this run draws without a graphics worker');
            }
            const wasPaused = control?.paused() ?? true;
            if (!wasPaused)
            {
                control?.pause();
                // The frames on their way when it paused land first.
                await new Promise(done=>setTimeout(done, 400));
            }
            try
            {
                return await new Promise((resolve, reject)=>{
                    const hear = (/** @type {{ data: any }} */ event)=>{
                        if (event.data?.type !== 'picked')
                        {
                            return;
                        }
                        worker.removeEventListener('message', hear);
                        if (event.data.error)
                        {
                            reject(new Error(event.data.error));
                        }
                        else
                        {
                            resolve(event.data.result);
                        }
                    };
                    worker.addEventListener('message', hear);
                    worker.postMessage({ type: 'debug',
                        pick: { x, y, tolerance: options.tolerance, depth: options.depth } });
                });
            }
            finally
            {
                if (!wasPaused)
                {
                    control?.resume();
                }
            }
        },
    };
}
