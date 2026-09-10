/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The far end of the ring, running on the browser's audio thread.
 *
 * Loaded with `audioWorklet.addModule(<this file's URL>)` rather than imported:
 * an audio worklet has its own global scope, no DOM and no module graph shared
 * with the page, so this file has to stand alone. It is here rather than with
 * the page because it and `ring.js` are two halves of one contract, and a
 * change to either that is not matched in the other is silence.
 *
 * It does the least work that can be done in an audio callback: read a block,
 * or fill it with silence. No allocation, no branching on anything but the
 * count, and nothing that can throw -- a callback that overruns its deadline is
 * heard as a click by everyone listening.
 *
 * The ring is read here rather than in `ring.js` because importing across the
 * worklet boundary is not possible; the twenty lines are duplicated knowingly,
 * and the constants below are the whole of what has to stay in step.
 */

/** Where the indices live in the shared control block; see ring.js. */
const WRITTEN = 0;
const READ = 1;
const STARVED_BLOCKS = 2;
const STARVED_FRAMES = 3;
const BLOCKS = 4;

class BottlifyOutput extends AudioWorkletProcessor {
    /** @param {any} options */
    constructor(options){
        super();
        const { control, samples, channels } = options.processorOptions;
        this.control = new Int32Array(control);
        this.samples = new Float32Array(samples);
        this.channels = channels;
        this.capacity = this.samples.length / channels;
        this.mask = this.capacity - 1;
        /** Blocks that found the ring empty. Counted, never acted on here. */
        this.starved = 0;
        this.running = true;
        this.port.onmessage = (/** @type {any} */ event)=>{
            if (event.data === 'stop')
            {
                this.running = false;
            }
        };
    }

    /**
     * @param {Float32Array[][]} _inputs
     * @param {Float32Array[][]} outputs
     * @returns {boolean}
     */
    process(_inputs, outputs){
        const output = outputs[0];
        if (!output || output.length === 0)
        {
            return this.running;
        }
        const wanted = output[0].length;
        Atomics.add(this.control, BLOCKS, 1);
        const read = Atomics.load(this.control, READ);
        const have = Math.min(wanted, Atomics.load(this.control, WRITTEN) - read);

        for (let frame = 0; frame < have; frame++)
        {
            const at = (read + frame & this.mask) * this.channels;
            for (let channel = 0; channel < output.length; channel++)
            {
                // A mono graph over a stereo ring takes the left side rather
                // than reading past the end of a frame.
                const which = Math.min(channel, this.channels - 1);
                output[channel][frame] = this.samples[at + which];
            }
        }
        for (let channel = 0; channel < output.length; channel++)
        {
            output[channel].fill(0, have, wanted);
        }

        // Only what was really there is counted as consumed, so the engine's
        // play cursor does not run through a gap nobody filled.
        Atomics.store(this.control, READ, read + have);
        if (have < wanted)
        {
            this.starved++;
            // Published into the control block, because the engine cannot ask
            // this thread anything and a hole in the sound that nobody can
            // count is a defect that can only be argued about.
            Atomics.add(this.control, STARVED_BLOCKS, 1);
            Atomics.add(this.control, STARVED_FRAMES, wanted - have);
        }
        return this.running;
    }
}

registerProcessor('bottlify-output', BottlifyOutput);
