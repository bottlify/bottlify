/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The frame profiler: where the time went, what was uploaded, and how much of
 * the per-frame work was avoided.
 *
 * This exists because reading code does not find this class of defect. A
 * contract mistake that multiplied upload traffic by two orders of magnitude
 * survived months of review and was located by one profiling run -- and the row
 * that gave it away was not near the top of the table. So the snapshot keeps the
 * whole per-buffer breakdown rather than a top-N, and a ring of recent frames
 * rather than an average: an average hides the frame that stalled.
 */

/** Ends a phase that was never timed. */
const NOTHING = ()=>{};

/**
 * The profiler a production bundle has in its place: every call answered,
 * nothing measured, nothing kept.
 *
 * @type {any}
 */
export const ABSENT_PROFILER = Object.freeze({
    beginFrame(){},
    phase: ()=>NOTHING,
    bufferUpload(){},
    textureUpload(){},
    endFrame(){},
    count(){},
    countDraw(){},
    countBindGroup(){},
    countUniformBlock(){},
    snapshot: ()=>({ frames: 0, counters: {}, uploadsByLabel: {}, recentFrames: [] }),
});

/**
 * @param {Object} options
 * @param {()=>number} options.now
 * @param {number} [options.frameHistory]
 * @returns {any}
 */
export function createProfiler(options){
    const historySize = options.frameHistory === undefined ? 240 : options.frameHistory;
    /** @type {Record<string, number>} */
    const counters = {
        frames: 0,
        submits: 0,
        passes: 0,
        draws: 0,
        bufferUploads: 0,
        bufferUploadBytes: 0,
        textureUploads: 0,
        textureUploadBytes: 0,
        stagedTextureUploads: 0,
        bindGroupsCreated: 0,
        bindGroupsReused: 0,
        uniformBlocks: 0,
        surfacesCreated: 0,
        presents: 0,
    };
    /** @type {Record<string, { count: number, bytes: number }>} */
    const uploadsByLabel = {};
    /** @type {any[]} */
    const recent = [];
    /** @type {any} */
    let frame = null;

    /** @returns {any} */
    const blankFrame = ()=>({
        index: counters.frames,
        startedAt: options.now(),
        totalMs: 0,
        passes: 0,
        draws: 0,
        bufferUploads: 0,
        bufferUploadBytes: 0,
        textureUploads: 0,
        textureUploadBytes: 0,
        bindGroupsCreated: 0,
        bindGroupsReused: 0,
        uniformBlocks: 0,
        phases: {},
    });

    /**
     * @param {string} name
     * @param {number} [amount]
     */
    const count = (name, amount = 1)=>{
        counters[name] += amount;
        if (frame && name in frame)
        {
            frame[name] += amount;
        }
    };

    return {
        beginFrame(){
            frame = blankFrame();
        },

        // What every draw counts, by name in the code rather than in a
        // string: `count` looks a name up, and a draw made six such looks.
        countDraw(){
            counters.draws++;
            if (frame)
            {
                frame.draws++;
            }
        },
        /** @param {boolean} created  a group made for this binding, not one kept */
        countBindGroup(created){
            if (created)
            {
                counters.bindGroupsCreated++;
                if (frame)
                {
                    frame.bindGroupsCreated++;
                }
            }
            else
            {
                counters.bindGroupsReused++;
                if (frame)
                {
                    frame.bindGroupsReused++;
                }
            }
        },
        countUniformBlock(){
            counters.uniformBlocks++;
            if (frame)
            {
                frame.uniformBlocks++;
            }
        },

        /**
         * Opens a named phase; the returned function closes it. Phases nest by
         * name rather than by stack, so an unclosed one shows up as a missing
         * row instead of corrupting its parent.
         *
         * @param {string} name
         * @returns {()=>void}
         */
        phase(name){
            const startedAt = options.now();
            return ()=>{
                if (!frame)
                {
                    return;
                }
                const elapsed = options.now() - startedAt;
                frame.phases[name] = (frame.phases[name] || 0) + elapsed;
            };
        },

        count,

        /**
         * @param {string} label
         * @param {number} bytes
         */
        bufferUpload(label, bytes){
            count('bufferUploads');
            count('bufferUploadBytes', bytes);
            const row = uploadsByLabel[label] || { count: 0, bytes: 0 };
            row.count++;
            row.bytes += bytes;
            uploadsByLabel[label] = row;
        },

        /**
         * @param {{ staged: boolean, bytes: number, format: string }} record
         */
        textureUpload(record){
            count('textureUploads');
            count('textureUploadBytes', record.bytes);
            if (record.staged)
            {
                count('stagedTextureUploads');
            }
            const label = `texture:${record.format}`;
            const row = uploadsByLabel[label] || { count: 0, bytes: 0 };
            row.count++;
            row.bytes += record.bytes;
            uploadsByLabel[label] = row;
        },

        endFrame(){
            if (!frame)
            {
                return;
            }
            frame.totalMs = options.now() - frame.startedAt;
            counters.frames++;
            recent.push(frame);
            while (recent.length > historySize)
            {
                recent.shift();
            }
            frame = null;
        },

        /** @returns {any} */
        snapshot(){
            return {
                frames: counters.frames,
                counters: { ...counters },
                uploadsByLabel: JSON.parse(JSON.stringify(uploadsByLabel)),
                recentFrames: recent.map(entry=>({ ...entry, phases: { ...entry.phases } })),
            };
        },
    };
}
