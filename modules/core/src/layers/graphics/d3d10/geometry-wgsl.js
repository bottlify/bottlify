/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The compute passes around a geometry shader (`geometry.js`): the running
 * sums of what each invocation made, the index lists of its primitives, and
 * stream output.
 *
 * The device keeps one buffer of counters (`COUNTER`): each stream's
 * primitives written and the primitives it needed room for, which the
 * stream-output queries read, and each stream-output buffer's filled size,
 * which a draw appends at, a bind with an offset sets, and `DrawAuto` draws.
 */

/** The counters buffer's words: two a stream, then a buffer's filled bytes each. */
export const COUNTER = Object.freeze({ streams: 4, filled: 8 });

/**
 * The words a draw's stream takes in its arguments: an indexed indirect
 * draw's five, then the primitives the shader made, all of them.
 */
export const STREAM_ARGS_WORDS = 8;

/** Group 0 of the sums. */
export const GEOMETRY_SCAN_BINDING = Object.freeze({ counts: 0, offsets: 1, args: 2, params: 3 });

/**
 * Each invocation's first primitive of each stream, and the draw's
 * arguments for each stream: its primitives as far as the room holds
 * (`params.y` primitives a stream, of `params.z` vertices), where its room
 * starts, and how many it made. `counts` holds two vectors an invocation,
 * the primitives and the vertices of each stream.
 */
export const GEOMETRY_SCAN_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> counts: array<vec4u>;
@group(0) @binding(1) var<storage, read_write> offsets: array<vec4u>;
@group(0) @binding(2) var<storage, read_write> args: array<u32>;
@group(0) @binding(3) var<uniform> params: vec4u;

var<workgroup> sums: array<vec4u, 256>;

@compute @workgroup_size(256)
fn scanGeometry(@builtin(local_invocation_index) t: u32) {
    let n = params.x;
    let per = (n + 255u) / 256u;
    let first = min(t * per, n);
    let last = min(first + per, n);
    var sum = vec4u(0u);
    for (var i = first; i < last; i++) {
        sum += counts[i * 2u];
    }
    sums[t] = sum;
    workgroupBarrier();
    for (var d = 1u; d < 256u; d <<= 1u) {
        var add = vec4u(0u);
        if (t >= d) {
            add = sums[t - d];
        }
        workgroupBarrier();
        sums[t] += add;
        workgroupBarrier();
    }
    var run = vec4u(0u);
    if (t > 0u) {
        run = sums[t - 1u];
    }
    for (var i = first; i < last; i++) {
        offsets[i] = run;
        run += counts[i * 2u];
    }
    if (t == 0u) {
        let total = sums[255u];
        for (var s = 0u; s < 4u; s++) {
            let kept = min(total[s], params.y);
            args[s * 8u] = kept * params.z;
            args[s * 8u + 1u] = 1u;
            args[s * 8u + 2u] = s * params.y * params.z;
            args[s * 8u + 3u] = 0u;
            args[s * 8u + 4u] = 0u;
            args[s * 8u + 5u] = total[s];
        }
    }
}
`;

/** Group 0 of the index lists. */
export const GEOMETRY_INDEX_BINDING = Object.freeze({
    starts: 0, counts: 1, offsets: 2, indices: 3, params: 4,
});

/**
 * The index lists of what each invocation made, a stream's list in its own
 * room: each primitive its vertices made, a strip's as a list in the order
 * that keeps its winding (an odd triangle's first two swapped), at the place
 * the sums gave it; a primitive past the room is not listed.
 *
 * `last`: each primitive turned round so that its last vertex comes first,
 * which is the one a flat value is taken from on the device (OpenGL's
 * provoking vertex, where Direct3D's is the first); the winding is kept.
 *
 * @param {{ streams: number, maxOut: number, outputVertices: number, last?: boolean }} stage
 * @returns {string}
 */
export function geometryIndexWgsl({ streams, maxOut, outputVertices, last = false }){
    const made = {
        1: ['at'],
        2: ['at - 1u', 'at'],
        3: ['select(at - 2u, at - 1u, odd)', 'select(at - 1u, at - 2u, odd)', 'at'],
    }[outputVertices] ?? ['at'];
    const list = last ? [made[made.length - 1], ...made.slice(0, -1)] : made;
    return /* wgsl */ `
@group(0) @binding(0) var<storage, read> starts: array<u32>;
@group(0) @binding(1) var<storage, read> counts: array<vec4u>;
@group(0) @binding(2) var<storage, read> offsets: array<vec4u>;
@group(0) @binding(3) var<storage, read_write> indices: array<u32>;
@group(0) @binding(4) var<uniform> params: vec4u;

@compute @workgroup_size(64)
fn listGeometry(@builtin(global_invocation_id) id: vec3u) {
    let inv = id.x;
    if (inv >= params.x) { return; }
    let emitted = counts[inv * 2u + 1u];
    let first = offsets[inv];
    for (var s = 0u; s < ${streams}u; s++) {
        var p = first[s];
        var strip = 0u;
        for (var v = 0u; v < min(emitted[s], ${maxOut}u); v++) {
            let at = (inv * ${streams}u + s) * ${maxOut}u + v;
            if (starts[at] == 1u) { strip = 0u; }
            strip += 1u;
            if (strip < ${outputVertices}u) { continue; }
            if (p < params.y) {
                let odd = ((strip - ${outputVertices}u) & 1u) == 1u;
                let base = (s * params.y + p) * ${outputVertices}u;
${list.map((index, j)=>`                indices[base + ${j}u] = ${index};`).join('\n')}
            }
            p += 1u;
        }
    }
}
`;
}

/** Group 0 of stream output. */
export const STREAM_OUT_BINDING = Object.freeze({
    vertices: 0, indices: 1, args: 2, counters: 3, params: 4, buffers: 5,
});

/**
 * @typedef {Object} StreamOutWrite
 * @property {number} slot       The output slot.
 * @property {number} stream
 * @property {{ register: number, component: number, word: number }[] } words
 *     What each word of a vertex's element is: a component of one of the
 *     shader's output registers, at that word of the element; the words a
 *     gap skips are not written.
 */

/**
 * Stream output of what a geometry shader made, two entry points over the
 * same declarations:
 *
 * `streamOut`, one invocation a vertex of each stream's list: the
 * primitives that fit in every buffer its stream writes, after what each
 * holds, are written, whole; the first that does not fit in one is written
 * to none, nor is any after it.
 *
 * `streamOutDone`, one invocation: each buffer's filled size moved past what
 * was written, and each stream's primitives written and needed counted.
 *
 * `params`: a slot each, the counter of its buffer's filled size, its size in
 * bytes, its stride, whether a buffer is bound there; then the room a stream
 * (primitives).
 *
 * @param {{ streams: number[], outputVertices: number, outputRegisters: number }} stage
 * @param {StreamOutWrite[]} writes  a slot each that the declaration writes
 * @returns {string}
 */
export function streamOutWgsl(stage, writes){
    const vpp = stage.outputVertices;
    const registers = stage.outputRegisters;
    // A stream's arguments and list are at its place among the shader's streams.
    const slot = (/** @type {number} */ stream)=>stage.streams.indexOf(stream);
    /** @param {number} stream */
    const fitOf = stream=>{
        const slots = writes.filter(write=>write.stream === stream);
        return [
            `    let total${stream} = args[${slot(stream)}u * 8u + 5u];`,
            `    var fit${stream} = select(0u, min(total${stream}, params.room.x), `
                + `${slots.map(write=>`params.slots[${write.slot}].w != 0u`).join(' || ')
                    || 'false'});`,
            ...slots.map(write=>[
                `    let filled${write.slot} = min(counters[params.slots[${write.slot}].x], `
                    + `params.slots[${write.slot}].y);`,
                `    if (params.slots[${write.slot}].w != 0u) {`,
                `        fit${stream} = min(fit${stream}, (params.slots[${write.slot}].y`
                    + ` - filled${write.slot}) / max(1u, ${vpp}u`
                    + ` * params.slots[${write.slot}].z));`,
                '    }'].join('\n')),
        ];
    };
    const streams = [...new Set(writes.map(write=>write.stream))]
        .filter(stream=>slot(stream) >= 0);
    return /* wgsl */ `
struct SoParams { slots: array<vec4u, 4>, room: vec4u, }
@group(0) @binding(0) var<storage, read> vertices: array<vec4u>;
@group(0) @binding(1) var<storage, read> indices: array<u32>;
@group(0) @binding(2) var<storage, read> args: array<u32>;
@group(0) @binding(3) var<storage, read_write> counters: array<u32>;
@group(0) @binding(4) var<uniform> params: SoParams;
${[0, 1, 2, 3].map(index=>`@group(0) @binding(${STREAM_OUT_BINDING.buffers + index})`
    + ` var<storage, read_write> so${index}: array<u32>;`).join('\n')}

@compute @workgroup_size(64)
fn streamOut(@builtin(global_invocation_id) id: vec3u) {
    let q = id.x;
${streams.map(stream=>[
        ...fitOf(stream),
        `    if (q < fit${stream} * ${vpp}u) {`,
        `        let v = indices[${slot(stream)}u * params.room.x * ${vpp}u + q];`,
        ...writes.filter(write=>write.stream === stream).map(write=>[
            `        if (params.slots[${write.slot}].w != 0u) {`,
            `            let base = (filled${write.slot}`
                + ` + q * params.slots[${write.slot}].z) / 4u;`,
            ...write.words.map(word=>`            so${write.slot}[base + ${word.word}u] = `
                + `vertices[v * ${registers}u + ${word.register}u][${word.component}];`),
            '        }'].join('\n')),
        '    }'].join('\n')).join('\n')}
}

@compute @workgroup_size(1)
fn streamOutDone() {
${streams.map(stream=>[
        ...fitOf(stream),
        ...writes.filter(write=>write.stream === stream).map(write=>
            `    if (params.slots[${write.slot}].w != 0u) {\n`
            + `        counters[params.slots[${write.slot}].x] = filled${write.slot}`
            + ` + fit${stream} * ${vpp}u * params.slots[${write.slot}].z;\n    }`),
        `    counters[${stream * 2}u] += fit${stream};`,
        `    counters[${stream * 2 + 1}u] += total${stream};`].join('\n')).join('\n')}
}
`;
}

/** Group 0 of the counters' own passes. */
export const COUNTER_BINDING = Object.freeze({ counters: 0, params: 1, args: 2 });

/**
 * Two small passes over the counters, in the order the program's calls came:
 * `setFilled` puts up to four buffers' filled sizes (a bind with an offset;
 * `params` a buffer each: its counter, the size, whether to set it), and
 * `drawAuto` writes the arguments of a draw of a buffer's vertices
 * (`params.x` its counter, `params.y` the stride, `params.z` the bytes before
 * its first vertex).
 */
export const COUNTER_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> counters: array<u32>;
@group(0) @binding(1) var<uniform> params: array<vec4u, 4>;
@group(0) @binding(2) var<storage, read_write> args: array<u32>;

@compute @workgroup_size(1)
fn setFilled() {
    for (var i = 0u; i < 4u; i++) {
        if (params[i].z != 0u) {
            counters[params[i].x] = params[i].y;
        }
    }
}

@compute @workgroup_size(1)
fn drawAuto() {
    let filled = counters[params[0].x];
    let skipped = min(filled, params[0].z);
    args[0] = select(0u, (filled - skipped) / params[0].y, params[0].y != 0u);
    args[1] = 1u;
    args[2] = 0u;
    args[3] = 0u;
}
`;
