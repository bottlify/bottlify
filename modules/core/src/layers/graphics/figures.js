/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The graphics layer's live figures: the few numbers a view that follows a
 * run reads once a second -- frames shown, draws, the GPU's time, the graphics
 * worker's -- published into the log's tables once a frame, so the log keeper
 * answers that view and the engine's thread is never asked.
 *
 * Every figure is one the layer keeps as it happens (a presenter's count, a
 * renderer's counter, the totals the graphics worker sends with every present);
 * the sampler copies a few dozen numbers and walks nothing. `diagnostics()`
 * stays the report's: everything, built on request.
 */

/**
 * The last frame a device presented, in numbers: draws, those into a target
 * not shown and how many such targets, clears and the last clear colour
 * (`-1` for none), the viewport and the size of the target shown.
 *
 * @typedef {Object} LastFrame
 * @property {number} index
 * @property {number} draws
 * @property {number} offscreenDraws
 * @property {number} offscreenTargets
 * @property {number} clears
 * @property {number} clearColor
 * @property {number} viewportX
 * @property {number} viewportY
 * @property {number} viewportWidth
 * @property {number} viewportHeight
 * @property {number} targetWidth
 * @property {number} targetHeight
 */

/**
 * What a device that draws offers a live view, cumulative since it was made:
 * its draws, the frames whose GPU time it measured and that time, and its
 * last frame (null before one).
 *
 * @typedef {Object} FrameFigures
 * @property {number} draws
 * @property {number} gpuFrames
 * @property {number} gpuMs
 * @property {LastFrame | null} last
 */

/**
 * The layer's counters row. `device` and `worker` are 1 when the figures after
 * them were said at all: a device that keeps none (Direct3D 7, OpenGL, a build
 * without a GPU) and a run without a graphics worker leave them 0, which a
 * reader says as "not measured" rather than as zero.
 */
export const GRAPHICS_COUNTERS = [
    'shown', 'device', 'draws', 'gpuFrames', 'gpuMs',
    'worker', 'workerBatches', 'workerReadSelfMs', 'workerSweepMs',
];

/** The last frame's row (`LastFrame`, in its order). */
export const LAST_FRAME_COLUMNS = [
    'index', 'draws', 'offscreenDraws', 'offscreenTargets', 'clears', 'clearColor',
    'viewportX', 'viewportY', 'viewportWidth', 'viewportHeight', 'targetWidth', 'targetHeight',
];

/** The surfaces the canvas copies are counted by: a run shows a handful. */
const SHOWN_ROWS = 32;

/**
 * Registers the layer's tables and answers the sampler that fills them, for
 * `log.metrics.onFrame`.
 *
 * @param {Object} options
 * @param {{ counters: (layer: string, names: string[]) => Float64Array,
 *     table: (layer: string, name: string, spec: { rows: number, columns: string[] }) =>
 *         { set: (row: number, column: number, value: number) => void,
 *             used: (count: number) => void } }} options.metrics
 *     The log's registry (`log.metrics`).
 * @param {(text: string) => number} options.intern
 * @param {() => { count: number, by: Readonly<Record<string, number>> } | null} options.shown
 *     The presenter's canvas copies, or null without one.
 * @param {() => FrameFigures | null} options.figures
 *     The device that draws, wherever it draws; null where none says.
 * @param {() => { 'batch-read': { count: number, selfMs: number },
 *     'batch-sweep': { ms: number } } | null} options.worker
 *     The graphics worker's thread totals (`remote/channel.js` WorkerPhases), or
 *     null without one.
 * @returns {() => void}
 */
export function publishFigures({ metrics, intern, shown, figures, worker }){
    const counters = metrics.counters('graphics', GRAPHICS_COUNTERS);
    const shownBy = metrics.table('graphics', 'shownBy',
        { rows: SHOWN_ROWS, columns: ['name', 'count'] });
    const last = metrics.table('graphics', 'lastFrame', { rows: 1, columns: LAST_FRAME_COLUMNS });
    return ()=>{
        const canvas = shown();
        counters[0] = canvas?.count ?? 0;
        if (canvas)
        {
            let row = 0;
            for (const name in canvas.by)
            {
                if (row === SHOWN_ROWS)
                {
                    break;
                }
                shownBy.set(row, 0, intern(name));
                shownBy.set(row, 1, canvas.by[name]);
                row++;
            }
            shownBy.used(row);
        }
        const device = figures();
        counters[1] = device ? 1 : 0;
        counters[2] = device?.draws ?? 0;
        counters[3] = device?.gpuFrames ?? 0;
        counters[4] = device?.gpuMs ?? 0;
        const frame = device?.last ?? null;
        if (frame)
        {
            for (let column = 0; column < LAST_FRAME_COLUMNS.length; column++)
            {
                last.set(0, column, /** @type {any} */ (frame)[LAST_FRAME_COLUMNS[column]]);
            }
        }
        last.used(frame ? 1 : 0);
        const phases = worker();
        counters[5] = phases ? 1 : 0;
        counters[6] = phases?.['batch-read'].count ?? 0;
        counters[7] = phases?.['batch-read'].selfMs ?? 0;
        counters[8] = phases?.['batch-sweep'].ms ?? 0;
    };
}
