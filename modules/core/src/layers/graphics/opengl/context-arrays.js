/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Vertex arrays, the draw calls that read them, buffer objects and the
 * compiled-array lock.
 *
 * The pointer records here are the truth; the flat state table mirrors
 * their size, type and stride so that glGet answers, and is rewritten
 * whenever a pointer changes or the client-active texture unit does. A draw
 * call assembles whole vertices from the arrays -- current values standing
 * in for any array that is off -- and hands them to the same path glEnd
 * uses, so a program that draws by array and one that draws by glVertex
 * reach identical pixels.
 */

import { GL } from './constants.js';
import { INTERLEAVED_LAYOUTS, componentBytes, readElement, readIndex } from './arrays.js';
import { createBufferObject } from './objects.js';
import { TEXTURE_UNITS } from './state.js';
import { CLIENT_BITS, queriesSavedBy } from './attributes.js';

/** The conventional arrays after the position, in the order a draw reads them. */
const CONVENTIONAL = /** @type {const} */ (['color', 'secondary', 'normal', 'fogCoord']);

/** Each unit's coordinate array by name, asked for on every draw. */
const TEX_COORD_NAMES = Array.from({ length: TEXTURE_UNITS }, (_, unit)=>`texCoord${unit}`);

/**
 * The generic array a program reads under a canonical name, if one is on.
 *
 * @template {{ name: string }} T
 * @param {readonly T[]} generic @param {string} name
 * @returns {T | undefined}
 */
function genericNamed(generic, name){
    for (const entry of generic)
    {
        if (entry.name === name)
        {
            return entry;
        }
    }
    return undefined;
}

/** @type {Set<number>} */
const PRIMITIVE_MODES = new Set([
    GL.POINTS, GL.LINES, GL.LINE_LOOP, GL.LINE_STRIP, GL.TRIANGLES, GL.TRIANGLE_STRIP,
    GL.TRIANGLE_FAN, GL.QUADS, GL.QUAD_STRIP, GL.POLYGON,
]);

/**
 * The targets a buffer object binds to, and the query each binding answers:
 * vertex arrays and indices, and since OpenGL 2.1 the pixels a pack reads
 * into and an unpack reads from.
 *
 * @type {Map<number, number>}
 */
const BINDING_QUERIES = new Map([
    [GL.ARRAY_BUFFER, GL.ARRAY_BUFFER_BINDING],
    [GL.ELEMENT_ARRAY_BUFFER, GL.ELEMENT_ARRAY_BUFFER_BINDING],
    [GL.PIXEL_PACK_BUFFER, GL.PIXEL_PACK_BUFFER_BINDING],
    [GL.PIXEL_UNPACK_BUFFER, GL.PIXEL_UNPACK_BUFFER_BINDING],
    [GL.COPY_READ_BUFFER, GL.COPY_READ_BUFFER],
    [GL.COPY_WRITE_BUFFER, GL.COPY_WRITE_BUFFER],
    [GL.UNIFORM_BUFFER, GL.UNIFORM_BUFFER_BINDING],
]);

/** The access bits glMapBufferRange takes (OpenGL 3.0 section 2.9.3). */
const MAP_BITS = GL.MAP_READ_BIT | GL.MAP_WRITE_BIT | GL.MAP_INVALIDATE_RANGE_BIT
    | GL.MAP_INVALIDATE_BUFFER_BIT | GL.MAP_FLUSH_EXPLICIT_BIT | GL.MAP_UNSYNCHRONIZED_BIT;

/** BUFFER_ACCESS for a map's bits: what glMapBuffer's enum would have said. @param {number} bits */
const accessOfBits = bits=>((bits & GL.MAP_READ_BIT) === 0 ? GL.WRITE_ONLY
    : (bits & GL.MAP_WRITE_BIT) === 0 ? GL.READ_ONLY : GL.READ_WRITE);

/**
 * How many instances a draw makes and the first per-instance element.
 *
 * @typedef {{ instances: number, baseInstance: number }} Instancing
 */

/** @type {Instancing} */
const ONE_INSTANCE = Object.freeze({ instances: 1, baseInstance: 0 });

/** @type {Set<number>} */
const INDEX_TYPES = new Set([GL.UNSIGNED_BYTE, GL.UNSIGNED_SHORT, GL.UNSIGNED_INT]);

/** @type {Set<number>} */
const USAGES = new Set([
    GL.STREAM_DRAW, GL.STREAM_READ, GL.STREAM_COPY, GL.STATIC_DRAW, GL.STATIC_READ,
    GL.STATIC_COPY, GL.DYNAMIC_DRAW, GL.DYNAMIC_READ, GL.DYNAMIC_COPY,
]);

/**
 * Which types each array accepts, and the flat queries that mirror it.
 *
 * @type {Record<string, { types: number[], sizes: number[] | null,
 *        enable: number, size: number | null, type: number, stride: number,
 *        binding: number | null, normalised: boolean }>}
 */
const ARRAYS = {
    vertex: {
        types: [GL.SHORT, GL.INT, GL.FLOAT, GL.DOUBLE], sizes: [2, 3, 4],
        enable: GL.VERTEX_ARRAY, size: GL.VERTEX_ARRAY_SIZE, type: GL.VERTEX_ARRAY_TYPE,
        stride: GL.VERTEX_ARRAY_STRIDE, binding: GL.VERTEX_ARRAY_BUFFER_BINDING,
        normalised: false,
    },
    normal: {
        types: [GL.BYTE, GL.SHORT, GL.INT, GL.FLOAT, GL.DOUBLE], sizes: null,
        enable: GL.NORMAL_ARRAY, size: null, type: GL.NORMAL_ARRAY_TYPE,
        stride: GL.NORMAL_ARRAY_STRIDE, binding: GL.NORMAL_ARRAY_BUFFER_BINDING,
        normalised: true,
    },
    color: {
        types: [GL.BYTE, GL.UNSIGNED_BYTE, GL.SHORT, GL.UNSIGNED_SHORT, GL.INT,
            GL.UNSIGNED_INT, GL.FLOAT, GL.DOUBLE],
        sizes: [3, 4],
        enable: GL.COLOR_ARRAY, size: GL.COLOR_ARRAY_SIZE, type: GL.COLOR_ARRAY_TYPE,
        stride: GL.COLOR_ARRAY_STRIDE, binding: GL.COLOR_ARRAY_BUFFER_BINDING,
        normalised: true,
    },
    index: {
        types: [GL.UNSIGNED_BYTE, GL.SHORT, GL.INT, GL.FLOAT, GL.DOUBLE], sizes: null,
        enable: GL.INDEX_ARRAY, size: null, type: GL.INDEX_ARRAY_TYPE,
        stride: GL.INDEX_ARRAY_STRIDE, binding: GL.INDEX_ARRAY_BUFFER_BINDING,
        normalised: false,
    },
    texCoord: {
        types: [GL.SHORT, GL.INT, GL.FLOAT, GL.DOUBLE], sizes: [1, 2, 3, 4],
        enable: GL.TEXTURE_COORD_ARRAY, size: GL.TEXTURE_COORD_ARRAY_SIZE,
        type: GL.TEXTURE_COORD_ARRAY_TYPE, stride: GL.TEXTURE_COORD_ARRAY_STRIDE,
        binding: GL.TEXTURE_COORD_ARRAY_BUFFER_BINDING, normalised: false,
    },
    edgeFlag: {
        types: [GL.UNSIGNED_BYTE], sizes: null,
        enable: GL.EDGE_FLAG_ARRAY, size: null, type: GL.UNSIGNED_BYTE,
        stride: GL.EDGE_FLAG_ARRAY_STRIDE, binding: null, normalised: false,
    },
    secondary: {
        types: [GL.BYTE, GL.UNSIGNED_BYTE, GL.SHORT, GL.UNSIGNED_SHORT, GL.INT,
            GL.UNSIGNED_INT, GL.FLOAT, GL.DOUBLE],
        sizes: [3],
        enable: GL.SECONDARY_COLOR_ARRAY, size: GL.SECONDARY_COLOR_ARRAY_SIZE,
        type: GL.SECONDARY_COLOR_ARRAY_TYPE, stride: GL.SECONDARY_COLOR_ARRAY_STRIDE,
        binding: null, normalised: true,
    },
    fogCoord: {
        types: [GL.FLOAT, GL.DOUBLE], sizes: null,
        enable: GL.FOG_COORDINATE_ARRAY, size: null, type: GL.FOG_COORDINATE_ARRAY_TYPE,
        stride: GL.FOG_COORDINATE_ARRAY_STRIDE, binding: null, normalised: false,
    },
};

/**
 * The flat queries a vertex array object holds (OpenGL 3.0, table 6.6 and
 * 6.7): the client vertex array group but for the array buffer binding, the
 * client-active texture unit and the compiled-array lock, which are the
 * context's.
 */
const VERTEX_ARRAY_OBJECT_QUERIES = Object.freeze(queriesSavedBy(CLIENT_BITS,
    GL.CLIENT_VERTEX_ARRAY_BIT).filter(query=>query !== GL.ARRAY_BUFFER_BINDING
    && query !== GL.CLIENT_ACTIVE_TEXTURE && query !== GL.ARRAY_ELEMENT_LOCK_FIRST
    && query !== GL.ARRAY_ELEMENT_LOCK_COUNT));

/** The glGetPointerv name of each array. */
const POINTER_QUERIES = Object.freeze({
    [GL.VERTEX_ARRAY_POINTER]: 'vertex',
    [GL.NORMAL_ARRAY_POINTER]: 'normal',
    [GL.COLOR_ARRAY_POINTER]: 'color',
    [GL.INDEX_ARRAY_POINTER]: 'index',
    [GL.TEXTURE_COORD_ARRAY_POINTER]: 'texCoord',
    [GL.EDGE_FLAG_ARRAY_POINTER]: 'edgeFlag',
    [GL.SECONDARY_COLOR_ARRAY_POINTER]: 'secondary',
    [GL.FOG_COORDINATE_ARRAY_POINTER]: 'fogCoord',
});

/**
 * The entry point that sets each array's pointer, the name a display list and
 * the glBegin rule know the call by.
 *
 * @type {Readonly<Record<string, string>>}
 */
const POINTER_CALLS = Object.freeze(Object.fromEntries(Object.keys(ARRAYS).map(name=>[name,
    `gl${name === 'texCoord' ? 'TexCoord' : name === 'edgeFlag' ? 'EdgeFlag'
        : name === 'secondary' ? 'SecondaryColor' : name === 'fogCoord' ? 'FogCoord'
            : name[0].toUpperCase() + name.slice(1)}Pointer${
        name === 'secondary' || name === 'fogCoord' ? 'EXT' : ''}`])));

/**
 * The array each client-state enumerant names, the first in `ARRAYS` whose
 * `enable` it is.
 *
 * @type {ReadonlyMap<number, string>}
 */
const ARRAY_OF_CAP = new Map(Object.entries(ARRAYS).reverse()
    .map(([name, spec])=>[spec.enable, name]));

/**
 * @param {number} size
 * @param {number} type
 * @returns {import('./arrays.js').ArrayPointer}
 */
function createPointer(size, type){
    return { size, type, stride: 0, pointer: 0, buffer: 0, normalised: 0, divisor: 0 };
}

/**
 * @param {any} context
 * @param {import('./kernel.js').ContextKernel} kernel
 */
export function installArrayCalls(context, kernel){
    const { enter, setError, record, setState, lose } = kernel;

    /** @type {Record<string, import('./arrays.js').ArrayPointer>} */
    const pointers = {
        vertex: createPointer(4, GL.FLOAT),
        normal: createPointer(3, GL.FLOAT),
        color: createPointer(4, GL.FLOAT),
        index: createPointer(1, GL.FLOAT),
        edgeFlag: createPointer(1, GL.UNSIGNED_BYTE),
        secondary: createPointer(3, GL.FLOAT),
        fogCoord: createPointer(1, GL.FLOAT),
    };
    const texCoordPointers = Array.from({ length: TEXTURE_UNITS }, ()=>createPointer(4, GL.FLOAT));
    const texCoordEnabled = new Array(TEXTURE_UNITS).fill(0);
    // The kinds whose conventional pointer normalises what it reads; a generic
    // write through the aliasing table overwrites the flag either way.
    pointers.normal.normalised = 1;
    pointers.color.normalised = 1;
    pointers.secondary.normalised = 1;
    let clientActive = 0;
    /** @type {{ first: number, count: number, epoch: number } | null} */
    let locked = null;
    /** How many locks the arrays have had: the epoch the next one is. */
    let lockEpoch = 0;

    /** @param {string} name @returns {import('./arrays.js').ArrayPointer} */
    const pointerOf = name=>(name === 'texCoord' ? texCoordPointers[clientActive] : pointers[name]);

    /**
     * One value of the mirror, replaced only when it differs: a record's
     * values are replaced whole on a change and never written in place, and
     * a program sets its pointers before nearly every draw, mostly to what
     * they already were.
     *
     * @param {number} query @param {number} value
     */
    const mirrorOne = (query, value)=>{
        const values = record(query).values;
        if (values.length !== 1 || values[0] !== value)
        {
            setState(query, [value]);
        }
    };

    /** Rewrites the flat mirror of one array's record. @param {string} name */
    const mirror = name=>{
        const spec = ARRAYS[name];
        const pointer = pointerOf(name);
        if (spec.size !== null)
        {
            mirrorOne(spec.size, pointer.size);
        }
        if (name !== 'edgeFlag')
        {
            mirrorOne(spec.type, pointer.type);
        }
        mirrorOne(spec.stride, pointer.stride);
        if (spec.binding !== null)
        {
            mirrorOne(spec.binding, pointer.buffer);
        }
        if (name === 'texCoord')
        {
            mirrorOne(GL.TEXTURE_COORD_ARRAY, texCoordEnabled[clientActive]);
        }
    };

    /**
     * Where an array's bytes come from: a buffer object's store when one was
     * bound as the pointer was set, guest memory otherwise.
     *
     * @param {import('./arrays.js').ArrayPointer} pointer
     * @returns {((address: number, length: number) => Uint8Array) | null}
     */
    const readerFor = pointer=>{
        if (pointer.buffer !== 0)
        {
            const buffer = kernel.shareGroup().buffers.objects.get(pointer.buffer);
            if (!buffer)
            {
                return null;
            }
            return (at, length)=>{
                const bytes = buffer.data.subarray(at, at + length);
                if (bytes.length === length)
                {
                    return bytes;
                }
                // Past the store's end GL leaves what a draw reads undefined:
                // zeros, rather than a call that throws out of the program's.
                const whole = new Uint8Array(length);
                whole.set(bytes);
                return whole;
            };
        }
        const memory = kernel.memory();
        // A window: whatever reads an array copies what it keeps before the
        // call returns -- the processor's vertices, the device's scratch ring.
        const view = memory?.window ?? memory?.read;
        return view ? (at, length)=>view(at, length) : null;
    };

    /**
     * @param {string} name
     * @param {number} size
     * @param {number} type
     * @param {number} stride
     * @param {number} address
     * @param {boolean} [sized]  whether the entry point takes a size at all
     */
    function setPointer(name, size, type, stride, address, sized = true){
        if (!enter(POINTER_CALLS[name], [size, type, stride, address]))
        {
            return;
        }
        const spec = ARRAYS[name];
        if (!spec.types.includes(type))
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        if (stride < 0 || (sized && spec.sizes && !spec.sizes.includes(size)))
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        const pointer = pointerOf(name);
        pointer.size = spec.sizes ? size : pointer.size;
        pointer.type = type;
        pointer.stride = stride;
        pointer.pointer = address;
        pointer.buffer = record(GL.ARRAY_BUFFER_BINDING).values[0];
        pointer.normalised = spec.normalised ? 1 : 0;
        mirror(name);
    }

    /**
     * @param {number} cap
     * @returns {string | null} the array a client-state enum names
     */
    function arrayOfCap(cap){
        return ARRAY_OF_CAP.get(cap) ?? null;
    }

    /**
     * @param {string} name
     * @param {number} cap
     * @param {number} value
     */
    function setClientState(name, cap, value){
        if (!enter(name, [cap]))
        {
            return;
        }
        const array = arrayOfCap(cap);
        if (!array)
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        if (array === 'texCoord')
        {
            texCoordEnabled[clientActive] = value;
        }
        setState(cap, [value]);
    }

    /**
     * One whole vertex out of the arrays, current values standing in for
     * arrays that are off.
     *
     * @param {number} index
     * @param {number} [instance]  the instance it is drawn for
     * @param {number} [baseInstance]
     * @returns {any | null} null when the vertex array itself cannot be read
     */
    function gather(index, instance = 0, baseInstance = 0){
        const vertex = kernel.currentVertex();
        const enabled = (/** @type {string} */ name)=>record(ARRAYS[name].enable).values[0] !== 0;
        const fetch = (/** @type {string} */ name, /** @type {number} */ unit)=>{
            const pointer = name === 'texCoord' ? texCoordPointers[unit] : pointers[name];
            const read = readerFor(pointer);
            // A divided array reads by instance (glVertexAttribDivisor).
            const element = pointer.divisor
                ? Math.floor(instance / pointer.divisor) + baseInstance : index;
            return read ? readElement(read, pointer, element, pointer.normalised !== 0) : null;
        };
        if (enabled('vertex'))
        {
            const p = fetch('vertex', 0);
            if (!p)
            {
                return null;
            }
            vertex.position = [p[0], p[1], p[2] ?? 0, p[3] ?? 1];
        }
        if (enabled('color'))
        {
            const c = fetch('color', 0);
            if (c)
            {
                vertex.color = [c[0], c[1], c[2], c[3] ?? 1];
            }
        }
        if (enabled('normal'))
        {
            const n = fetch('normal', 0);
            if (n)
            {
                vertex.normal = n;
            }
        }
        if (enabled('secondary'))
        {
            const s = fetch('secondary', 0);
            if (s)
            {
                vertex.secondary = [s[0], s[1], s[2], 1];
            }
        }
        if (enabled('fogCoord'))
        {
            const f = fetch('fogCoord', 0);
            if (f)
            {
                vertex.fogCoord = f[0];
            }
        }
        for (let unit = 0; unit < TEXTURE_UNITS; unit++)
        {
            if (texCoordEnabled[unit] === 0)
            {
                continue;
            }
            const t = fetch('texCoord', unit);
            if (t)
            {
                vertex.texCoords[unit] = [t[0], t[1] ?? 0, t[2] ?? 0, t[3] ?? 1];
            }
        }
        vertex.texCoord = vertex.texCoords[0];
        return vertex;
    }

    /**
     * The enabled arrays as a renderer takes them, the vertex array first.
     * Under a vertex program or a GLSL program the generic attribute arrays
     * join them: an index whose canonical name a conventional array already
     * feeds stays out, because the conventional array is the one the
     * aliasing table resolves, and the rest arrive under their `attribN`
     * names.
     *
     * @returns {import('./gpu-layout.js').ArrayRequest[]}
     */
    function enabledArrays(){
        /** @type {{ name: string, normalised: boolean,
         *           pointer: import('./arrays.js').ArrayPointer }[]} */
        const generic = record(GL.VERTEX_PROGRAM_ARB).values[0] !== 0
            || kernel.side.glslExecutable?.()
            ? kernel.side.programs?.genericArrays() ?? []
            : [];
        /** @type {import('./gpu-layout.js').ArrayRequest[]} */
        const arrays = [];
        const fromGeneric = genericNamed(generic, 'position');
        if (record(ARRAYS.vertex.enable).values[0] !== 0 || !fromGeneric)
        {
            arrays.push({ name: 'position', pointer: pointers.vertex, normalised: false });
        }
        else
        {
            arrays.push({ name: 'position', pointer: fromGeneric.pointer,
                normalised: fromGeneric.normalised });
        }
        for (const name of CONVENTIONAL)
        {
            if (record(ARRAYS[name].enable).values[0] !== 0)
            {
                arrays.push({ name, pointer: pointers[name],
                    normalised: pointers[name].normalised !== 0 });
                continue;
            }
            const entry = genericNamed(generic, name);
            if (entry)
            {
                arrays.push({ name, pointer: entry.pointer, normalised: entry.normalised });
            }
        }
        for (let unit = 0; unit < TEXTURE_UNITS; unit++)
        {
            const name = TEX_COORD_NAMES[unit];
            if (texCoordEnabled[unit] !== 0)
            {
                arrays.push({ name, pointer: texCoordPointers[unit],
                    normalised: texCoordPointers[unit].normalised !== 0 });
                continue;
            }
            const entry = genericNamed(generic, name);
            if (entry)
            {
                arrays.push({ name, pointer: entry.pointer, normalised: entry.normalised });
            }
        }
        for (const entry of generic)
        {
            if (!arrays.some(array=>array.name === entry.name))
            {
                arrays.push({ name: entry.name, pointer: entry.pointer,
                    normalised: entry.normalised });
            }
        }
        return arrays;
    }

    /**
     * Whether a draw has a position to read: the conventional vertex array,
     * or the generic attribute zero array under a vertex program, which the
     * aliasing table makes the same attribute.
     */
    function hasVertexSource(){
        // Attribute 0's enable is the vertex array's enable: the aliasing
        // table's pairs are one array, whichever entry point enabled it.
        return record(GL.VERTEX_ARRAY).values[0] !== 0;
    }

    /**
     * Hands a draw to the renderer as arrays, when there is one and it takes
     * them; otherwise the vertices are assembled here.
     *
     * @param {number} mode
     * @param {number} first
     * @param {number} count
     * @param {{ type: number, indices: number | Uint8Array, baseVertex?: number } | null} indexed
     * @param {Instancing} [instancing]
     * @returns {boolean}
     */
    function drawFromArrays(mode, first, count, indexed, instancing = ONE_INSTANCE){
        if (!kernel.drawArrays)
        {
            refusal = 'no device';
            return false;
        }
        const arrays = enabledArrays();
        // The position array, conventional or generic, is the one a draw
        // cannot be read without.
        if (!readerFor(arrays[0].pointer))
        {
            refusal = 'unreadable';
            return false;
        }
        refusal = 'refused';
        /** @type {{ bytes: Uint8Array, type: number,
         *           buffer: import('./objects.js').BufferObject | null, offset: number } | null} */
        let indices = null;
        if (indexed)
        {
            const length = count * componentBytes(indexed.type);
            const bound = record(GL.ELEMENT_ARRAY_BUFFER_BINDING).values[0];
            const read = indexed.indices instanceof Uint8Array
                ? (/** @type {number} */ at, /** @type {number} */ n)=>
                    /** @type {Uint8Array} */ (indexed.indices).subarray(at, at + n)
                : readerFor({ size: 1, type: indexed.type, stride: 0, pointer: 0, buffer: bound });
            if (!read)
            {
                refusal = 'unreadable';
                return false;
            }
            const base = indexed.indices instanceof Uint8Array ? 0 : indexed.indices;
            // The scan cache in gpu.js needs the object itself, not just its
            // bytes, to tell "still what it scanned" from "redefined since":
            // present only for an index list that actually lives in a bound
            // ELEMENT_ARRAY_BUFFER, never for one already dereferenced into
            // its own scratch bytes or read from client memory.
            const bufferObject = !(indexed.indices instanceof Uint8Array) && bound !== 0
                ? kernel.shareGroup().buffers.objects.get(bound) ?? null
                : null;
            indices = { bytes: read(base, length), type: indexed.type,
                buffer: bufferObject, offset: base };
        }
        const memory = kernel.memory();
        const view = memory?.window ?? memory?.read;
        return kernel.drawArrays({
            mode,
            first,
            count,
            indices,
            arrays,
            baseVertex: indexed?.baseVertex ?? 0,
            instances: instancing.instances,
            baseInstance: instancing.baseInstance,
            lock: locked,
            read: view ? (at, n)=>view(at, n) : ()=>new Uint8Array(0),
            bufferObject: name=>kernel.shareGroup().buffers.objects.get(name),
        });
    }

    /**
     * Why the last draw by arrays was not handed over as arrays: the device's
     * renderer said no (`refused`: a layout it cannot bind, a list being
     * compiled), there is none, or an array cannot be read.
     */
    let refusal = 'refused';

    /**
     * @param {string} name
     * @param {number} mode
     * @param {number[]} indices
     * @param {string} [why]  the refusal that sent the draw here
     * @param {Instancing} [instancing]
     */
    function drawIndexed(name, mode, indices, why = 'refused', instancing = ONE_INSTANCE){
        if (kernel.inPrimitive())
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        if (!PRIMITIVE_MODES.has(mode))
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        if (record(GL.VERTEX_ARRAY).values[0] === 0)
        {
            return;
        }
        if (!readerFor(pointers.vertex))
        {
            lose(`${name} was called with no way to read the vertex array, and drew nothing`);
            return;
        }
        // Each instance a draw of its own, in order, as the GPU draws them.
        for (let instance = 0; instance < instancing.instances; instance++)
        {
            const vertices = [];
            for (const index of indices)
            {
                const vertex = gather(index, instance, instancing.baseInstance);
                if (vertex)
                {
                    vertices.push(vertex);
                }
            }
            kernel.drawVertices(mode, vertices, why);
        }
    }

    /**
     * @param {number} count
     * @param {number} type
     * @param {number | Uint8Array} indices
     * @returns {number[] | null}
     */
    function readIndices(count, type, indices){
        const bound = record(GL.ELEMENT_ARRAY_BUFFER_BINDING).values[0];
        const base = indices instanceof Uint8Array ? 0 : indices;
        const read = indices instanceof Uint8Array
            ? (/** @type {number} */ at, /** @type {number} */ length)=>
                indices.subarray(at, at + length)
            : readerFor({ size: 1, type, stride: 0, pointer: 0, buffer: bound });
        if (!read)
        {
            return null;
        }
        const out = [];
        for (let i = 0; i < count; i++)
        {
            out.push(readIndex(read, base, type, i));
        }
        return out;
    }

    /** @param {number} target @returns {import('./objects.js').BufferObject | null} */
    function boundBuffer(target){
        const query = BINDING_QUERIES.get(target) ?? null;
        if (query === null)
        {
            setError(GL.INVALID_ENUM);
            return null;
        }
        const name = record(query).values[0];
        const buffer = name === 0 ? null : kernel.shareGroup().buffers.objects.get(name);
        if (!buffer)
        {
            setError(GL.INVALID_OPERATION);
            return null;
        }
        return buffer;
    }

    /**
     * The conventional array name a generic attribute index aliases, or null
     * for the indices the aliasing table leaves generic of their own.
     *
     * @param {number} index
     * @returns {string | null}
     */
    const conventionalName = index=>index === 0 ? 'vertex'
        : index === 2 ? 'normal'
            : index === 3 ? 'color'
                : index === 4 ? 'secondary'
                    : index === 5 ? 'fogCoord'
                        : null;

    /**
     * The conventional pointer record a generic attribute index aliases: the
     * pair is one array, so a generic pointer or enable write lands here and
     * a conventional write lands where the generic queries read.
     *
     * @param {number} index
     * @returns {import('./arrays.js').ArrayPointer | null}
     */
    const aliasRecord = index=>{
        if (index >= 8 && index < 8 + TEXTURE_UNITS)
        {
            return texCoordPointers[index - 8];
        }
        const name = conventionalName(index);
        return name === null ? null : pointers[name];
    };

    /** @param {number} index @param {number} value */
    const aliasSetEnable = (index, value)=>{
        if (index >= 8 && index < 8 + TEXTURE_UNITS)
        {
            const unit = index - 8;
            texCoordEnabled[unit] = value;
            if (unit === clientActive)
            {
                setState(GL.TEXTURE_COORD_ARRAY, [value]);
            }
            return;
        }
        setState(ARRAYS[/** @type {string} */ (conventionalName(index))].enable, [value]);
    };

    /** @param {number} index @returns {number} */
    const aliasEnabled = index=>index >= 8 && index < 8 + TEXTURE_UNITS
        ? texCoordEnabled[index - 8]
        : record(ARRAYS[/** @type {string} */ (conventionalName(index))].enable).values[0];

    /**
     * Bytes of the store the program changed, for the copies kept elsewhere.
     *
     * @param {import('./objects.js').BufferObject} buffer @param {number} offset
     * @param {number} size
     */
    const noteWritten = (buffer, offset, size)=>{
        buffer.written = buffer.written
            ? { start: Math.min(buffer.written.start, offset),
                end: Math.max(buffer.written.end, offset + size) }
            : { start: offset, end: offset + size };
        buffer.version++;
    };

    /**
     * Maps part of a store into guest memory: a copy of the bytes there, as
     * the range's own allocation, unless the map discards them anyway.
     *
     * @param {import('./objects.js').BufferObject} buffer @param {number} offset
     * @param {number} length @param {number} bits  MAP_*_BIT @param {string} call
     * @returns {number}
     */
    const mapRange = (buffer, offset, length, bits, call)=>{
        const memory = kernel.memory();
        const address = memory?.allocate ? memory.allocate(Math.max(1, length)) : 0;
        if (address === 0)
        {
            lose(`${call} could not map a buffer into guest memory: a program that`
                + ' fills its buffers by mapping gets null and draws nothing from them');
            setError(GL.OUT_OF_MEMORY);
            return 0;
        }
        const discards = (bits
            & (GL.MAP_INVALIDATE_RANGE_BIT | GL.MAP_INVALIDATE_BUFFER_BIT)) !== 0;
        if (!discards && length > 0)
        {
            /** @type {NonNullable<typeof memory>} */ (memory).write(address,
                buffer.data.subarray(offset, offset + length));
        }
        buffer.mapped = address;
        buffer.access = accessOfBits(bits);
        buffer.accessFlags = bits;
        buffer.mapOffset = offset;
        buffer.mapLength = length;
        return address;
    };

    /**
     * Copies what the program wrote in a mapped range back into the store.
     *
     * @param {import('./objects.js').BufferObject} buffer @param {number} offset
     * @param {number} length  in the store
     */
    const writeBack = (buffer, offset, length)=>{
        const memory = kernel.memory();
        if (!memory || length <= 0)
        {
            return;
        }
        buffer.data.set(memory.read(buffer.mapped + offset - buffer.mapOffset, length), offset);
        noteWritten(buffer, offset, length);
    };

    /** The map ended: its memory given back and its state the unmapped one. */
    /** @param {import('./objects.js').BufferObject} buffer */
    const unmap = buffer=>{
        kernel.memory()?.free?.(buffer.mapped);
        buffer.mapped = 0;
        buffer.accessFlags = 0;
        buffer.mapOffset = 0;
        buffer.mapLength = 0;
    };

    Object.assign(kernel.side, {
        pointers,
        texCoordPointers,
        arrayAlias: {
            record: aliasRecord, setEnable: aliasSetEnable, enabled: aliasEnabled,
        },
        clientActiveUnit: ()=>clientActive,

        /**
         * What a vertex array object holds, taken from the context as it is:
         * every array's pointer and enable, the generic ones', and the
         * element array buffer binding.
         *
         * @returns {any}
         */
        vertexArrayState(){
            return {
                values: new Map(VERTEX_ARRAY_OBJECT_QUERIES.map(query=>
                    [query, [...record(query).values]])),
                pointers: structuredClone(pointers),
                texCoordPointers: structuredClone(texCoordPointers),
                texCoordEnabled: [...texCoordEnabled],
                programs: kernel.side.saveClientPrograms(GL.CLIENT_VERTEX_ARRAY_BIT),
            };
        },

        /**
         * Makes a vertex array object's state the context's (glBindVertexArray);
         * the client-active unit and the lock stay as they are.
         *
         * @param {any} state  as `vertexArrayState` gave it
         */
        useVertexArrayState(state){
            for (const [query, values] of state.values)
            {
                setState(query, [...values]);
            }
            for (const name of Object.keys(pointers))
            {
                Object.assign(pointers[name], state.pointers[name]);
            }
            texCoordPointers.forEach((pointer, i)=>{
                Object.assign(pointer, state.texCoordPointers[i]);
            });
            state.texCoordEnabled.forEach((/** @type {number} */ v, /** @type {number} */ i)=>{
                texCoordEnabled[i] = v;
            });
            for (const name of Object.keys(ARRAYS))
            {
                mirror(name);
            }
            kernel.side.restoreClientPrograms(state.programs);
        },

        /** @param {number} mask @returns {any} */
        saveClient(mask){
            if ((mask & GL.CLIENT_VERTEX_ARRAY_BIT) === 0)
            {
                return null;
            }
            return {
                pointers: structuredClone(pointers),
                texCoordPointers: structuredClone(texCoordPointers),
                texCoordEnabled: [...texCoordEnabled],
                clientActive,
                locked,
            };
        },

        /** @param {number} mask @param {any} saved */
        restoreClient(mask, saved){
            if (!saved)
            {
                return;
            }
            for (const name of Object.keys(pointers))
            {
                Object.assign(pointers[name], saved.pointers[name]);
            }
            texCoordPointers.forEach((pointer, i)=>{
                Object.assign(pointer, saved.texCoordPointers[i]);
            });
            saved.texCoordEnabled.forEach((/** @type {number} */ v, /** @type {number} */ i)=>{
                texCoordEnabled[i] = v;
            });
            clientActive = saved.clientActive;
            locked = saved.locked;
            for (const name of Object.keys(ARRAYS))
            {
                mirror(name);
            }
        },
    });

    /**
     * A draw by a range of the arrays, as many times as there are instances.
     *
     * @param {string} name @param {number} mode @param {number} first @param {number} count
     * @param {Instancing} instancing
     */
    function drawArraysWith(name, mode, first, count, instancing){
        if (count < 0 || first < 0 || instancing.instances < 0)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        if (!PRIMITIVE_MODES.has(mode))
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        if (kernel.inPrimitive())
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        if (!hasVertexSource() || drawFromArrays(mode, first, count, null, instancing))
        {
            return;
        }
        drawIndexed(name, mode, Array.from({ length: count }, (unused, i)=>first + i), refusal,
            instancing);
    }

    /**
     * A draw by an index list, each index moved by the base vertex (OpenGL 3.2)
     * before the arrays are read, as many times as there are instances.
     *
     * @param {string} name @param {number} mode @param {number} count @param {number} type
     * @param {number | Uint8Array} indices  an address, an offset into the
     *        bound element buffer, or the bytes themselves
     * @param {number} baseVertex @param {Instancing} instancing
     */
    function drawElementsWith(name, mode, count, type, indices, baseVertex, instancing){
        if (count < 0 || instancing.instances < 0)
        {
            setError(GL.INVALID_VALUE);
            return;
        }
        if (!INDEX_TYPES.has(type) || !PRIMITIVE_MODES.has(mode))
        {
            setError(GL.INVALID_ENUM);
            return;
        }
        if (kernel.inPrimitive())
        {
            setError(GL.INVALID_OPERATION);
            return;
        }
        if (restarting(name, mode, count, type, indices, baseVertex, instancing))
        {
            return;
        }
        if (!hasVertexSource()
            || drawFromArrays(mode, 0, count, { type, indices, baseVertex }, instancing))
        {
            return;
        }
        const list = readIndices(count, type, indices);
        if (!list)
        {
            lose(`${name} was called with no way to read its indices, and drew nothing`);
            return;
        }
        drawIndexed(name, mode, baseVertex === 0 ? list : list.map(index=>index + baseVertex),
            refusal, instancing);
    }

    /**
     * Primitive restart (OpenGL 3.1 section 2.8.1, 4.3's fixed index): with it
     * on, an index equal to the restart index ends the primitive and starts
     * the next, so the draw is made as the draws of the runs between them,
     * each its own strip, fan, loop or list, as the specification describes
     * it. False when it is off or no index is the restart index, for the
     * draw to go on as one.
     *
     * @param {string} name @param {number} mode @param {number} count @param {number} type
     * @param {number | Uint8Array} indices @param {number} baseVertex
     * @param {Instancing} instancing
     * @returns {boolean} whether the draw was made here
     */
    function restarting(name, mode, count, type, indices, baseVertex, instancing){
        const fixed = record(GL.PRIMITIVE_RESTART_FIXED_INDEX).values[0] !== 0;
        if (!fixed && record(GL.PRIMITIVE_RESTART).values[0] === 0)
        {
            return false;
        }
        const size = componentBytes(type);
        const restart = fixed ? 2 ** (size * 8) - 1
            : record(GL.PRIMITIVE_RESTART_INDEX).values[0] >>> 0;
        const list = readIndices(count, type, indices);
        if (!list || !list.includes(restart))
        {
            return false;
        }
        let start = 0;
        for (let at = 0; at <= list.length; at++)
        {
            if (at === list.length || list[at] === restart)
            {
                if (at > start)
                {
                    const from = typeof indices === 'number' ? indices + start * size
                        : indices.subarray(start * size);
                    // A run holds no restart index, and draws as one.
                    drawElementsWith(name, mode, at - start, type, from, baseVertex,
                        instancing);
                }
                start = at + 1;
            }
        }
        return true;
    }

    Object.assign(context, {
        /**
         * glPrimitiveRestartIndex (3.1): the index that restarts while
         * GL_PRIMITIVE_RESTART is on.
         *
         * @param {number} index
         */
        glPrimitiveRestartIndex(index){
            if (enter('glPrimitiveRestartIndex', [index]))
            {
                setState(GL.PRIMITIVE_RESTART_INDEX, [index >>> 0]);
            }
        },

        /**
         * @param {number} size
         * @param {number} type
         * @param {number} stride
         * @param {number} address
         */
        glVertexPointer(size, type, stride, address){
            setPointer('vertex', size, type, stride, address);
        },

        /** @param {number} type @param {number} stride @param {number} address */
        glNormalPointer(type, stride, address){
            setPointer('normal', 3, type, stride, address, false);
        },

        /**
         * @param {number} size
         * @param {number} type
         * @param {number} stride
         * @param {number} address
         */
        glColorPointer(size, type, stride, address){
            setPointer('color', size, type, stride, address);
        },

        /** @param {number} type @param {number} stride @param {number} address */
        glIndexPointer(type, stride, address){
            setPointer('index', 1, type, stride, address, false);
        },

        /**
         * @param {number} size
         * @param {number} type
         * @param {number} stride
         * @param {number} address
         */
        glTexCoordPointer(size, type, stride, address){
            setPointer('texCoord', size, type, stride, address);
        },

        /** @param {number} stride @param {number} address */
        glEdgeFlagPointer(stride, address){
            setPointer('edgeFlag', 1, GL.UNSIGNED_BYTE, stride, address, false);
        },

        /**
         * @param {number} size
         * @param {number} type
         * @param {number} stride
         * @param {number} address
         */
        glSecondaryColorPointerEXT(size, type, stride, address){
            setPointer('secondary', size, type, stride, address);
        },

        /** @param {number} type @param {number} stride @param {number} address */
        glFogCoordPointerEXT(type, stride, address){
            setPointer('fogCoord', 1, type, stride, address, false);
        },

        /** @param {number} cap */
        glEnableClientState(cap){
            setClientState('glEnableClientState', cap, 1);
        },

        /** @param {number} cap */
        glDisableClientState(cap){
            setClientState('glDisableClientState', cap, 0);
        },

        /** @param {number} unit */
        glClientActiveTextureARB(unit){
            if (!enter('glClientActiveTextureARB', [unit]))
            {
                return;
            }
            if (unit < GL.TEXTURE0 || unit >= GL.TEXTURE0 + TEXTURE_UNITS)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            clientActive = unit - GL.TEXTURE0;
            setState(GL.CLIENT_ACTIVE_TEXTURE, [unit]);
            mirror('texCoord');
        },

        /**
         * @param {number} query
         * @returns {number[] | null} the pointer, as an address
         */
        glGetPointerv(query){
            if (!enter('glGetPointerv', [query]))
            {
                return null;
            }
            const name = /** @type {any} */ (POINTER_QUERIES)[query];
            if (!name)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            return [pointerOf(name).pointer];
        },

        /**
         * @param {number} format
         * @param {number} stride
         * @param {number} address
         */
        glInterleavedArrays(format, stride, address){
            if (!enter('glInterleavedArrays', [format, stride, address]))
            {
                return;
            }
            const layout = INTERLEAVED_LAYOUTS.get(format);
            if (!layout)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (stride < 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            const step = stride === 0 ? layout.stride : stride;
            for (const cap of [GL.EDGE_FLAG_ARRAY, GL.INDEX_ARRAY, GL.SECONDARY_COLOR_ARRAY,
                GL.FOG_COORDINATE_ARRAY])
            {
                setState(cap, [0]);
            }
            const set = (/** @type {number} */ cap, /** @type {boolean} */ on)=>{
                if (cap === GL.TEXTURE_COORD_ARRAY)
                {
                    texCoordEnabled[clientActive] = on ? 1 : 0;
                }
                setState(cap, [on ? 1 : 0]);
            };
            set(GL.TEXTURE_COORD_ARRAY, layout.texCoord !== null);
            if (layout.texCoord)
            {
                setPointer('texCoord', layout.texCoord.size, GL.FLOAT, step,
                    address + layout.texCoord.offset);
            }
            set(GL.COLOR_ARRAY, layout.color !== null);
            if (layout.color)
            {
                setPointer('color', layout.color.size, layout.color.type, step,
                    address + layout.color.offset);
            }
            set(GL.NORMAL_ARRAY, layout.normal !== null);
            if (layout.normal)
            {
                setPointer('normal', 3, GL.FLOAT, step, address + layout.normal.offset, false);
            }
            set(GL.VERTEX_ARRAY, true);
            setPointer('vertex', layout.vertex.size, GL.FLOAT, step,
                address + layout.vertex.offset);
        },

        /** @param {number} index */
        glArrayElement(index){
            if (index < 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (!readerFor(pointers.vertex))
            {
                return;
            }
            const vertex = gather(index);
            if (!vertex)
            {
                return;
            }
            // As the specification defines it: the sequence of current-value
            // calls the arrays imply, then the vertex. Each one records into a
            // list on its own and leaves the current values changed.
            if (record(GL.COLOR_ARRAY).values[0] !== 0)
            {
                context.glColor4f(...vertex.color);
            }
            if (record(GL.NORMAL_ARRAY).values[0] !== 0)
            {
                context.glNormal3f(...vertex.normal);
            }
            if (record(GL.SECONDARY_COLOR_ARRAY).values[0] !== 0)
            {
                context.glSecondaryColor3fEXT(...vertex.secondary.slice(0, 3));
            }
            if (record(GL.FOG_COORDINATE_ARRAY).values[0] !== 0)
            {
                context.glFogCoordfEXT(vertex.fogCoord);
            }
            texCoordEnabled.forEach((on, unit)=>{
                if (on)
                {
                    context.glMultiTexCoord4fARB(GL.TEXTURE0 + unit, ...vertex.texCoords[unit]);
                }
            });
            if (record(GL.VERTEX_ARRAY).values[0] !== 0)
            {
                context.glVertex4f(...vertex.position);
            }
        },

        /** @param {number} mode @param {number} first @param {number} count */
        glDrawArrays(mode, first, count){
            drawArraysWith('glDrawArrays', mode, first, count, ONE_INSTANCE);
        },

        /**
         * @param {number} mode
         * @param {number} count
         * @param {number} type
         * @param {number | Uint8Array} indices  an address, an offset into the
         *        bound element buffer, or the bytes themselves
         */
        glDrawElements(mode, count, type, indices){
            drawElementsWith('glDrawElements', mode, count, type, indices, 0, ONE_INSTANCE);
        },

        /**
         * @param {number} mode
         * @param {number} start
         * @param {number} end
         * @param {number} count
         * @param {number} type
         * @param {number | Uint8Array} indices
         */
        glDrawRangeElementsEXT(mode, start, end, count, type, indices){
            if (end < start)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            context.glDrawElements(mode, count, type, indices);
        },

        // --- instances and base vertices (OpenGL 3.1, 3.2, 4.2) ---

        /**
         * @param {number} mode @param {number} first @param {number} count
         * @param {number} instances
         */
        glDrawArraysInstanced(mode, first, count, instances){
            drawArraysWith('glDrawArraysInstanced', mode, first, count,
                { instances, baseInstance: 0 });
        },

        /**
         * @param {number} mode @param {number} first @param {number} count
         * @param {number} instances @param {number} baseInstance
         */
        glDrawArraysInstancedBaseInstance(mode, first, count, instances, baseInstance){
            drawArraysWith('glDrawArraysInstancedBaseInstance', mode, first, count,
                { instances, baseInstance: baseInstance >>> 0 });
        },

        /**
         * @param {number} mode @param {number} count @param {number} type
         * @param {number | Uint8Array} indices @param {number} instances
         */
        glDrawElementsInstanced(mode, count, type, indices, instances){
            drawElementsWith('glDrawElementsInstanced', mode, count, type, indices, 0,
                { instances, baseInstance: 0 });
        },

        /**
         * @param {number} mode @param {number} count @param {number} type
         * @param {number | Uint8Array} indices @param {number} baseVertex
         */
        glDrawElementsBaseVertex(mode, count, type, indices, baseVertex){
            drawElementsWith('glDrawElementsBaseVertex', mode, count, type, indices, baseVertex,
                ONE_INSTANCE);
        },

        /**
         * The range is the program's promise of what the indices reach; it
         * is checked and not otherwise used, as glDrawRangeElements' is.
         *
         * @param {number} mode @param {number} start @param {number} end
         * @param {number} count @param {number} type @param {number | Uint8Array} indices
         * @param {number} baseVertex
         */
        glDrawRangeElementsBaseVertex(mode, start, end, count, type, indices, baseVertex){
            if (end < start)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            drawElementsWith('glDrawRangeElementsBaseVertex', mode, count, type, indices,
                baseVertex, ONE_INSTANCE);
        },

        /**
         * @param {number} mode @param {number} count @param {number} type
         * @param {number | Uint8Array} indices @param {number} instances
         * @param {number} baseVertex
         */
        glDrawElementsInstancedBaseVertex(mode, count, type, indices, instances, baseVertex){
            drawElementsWith('glDrawElementsInstancedBaseVertex', mode, count, type, indices,
                baseVertex, { instances, baseInstance: 0 });
        },

        /**
         * @param {number} mode @param {number} count @param {number} type
         * @param {number | Uint8Array} indices @param {number} instances
         * @param {number} baseInstance
         */
        glDrawElementsInstancedBaseInstance(mode, count, type, indices, instances, baseInstance){
            drawElementsWith('glDrawElementsInstancedBaseInstance', mode, count, type, indices, 0,
                { instances, baseInstance: baseInstance >>> 0 });
        },

        /**
         * @param {number} mode @param {number} count @param {number} type
         * @param {number | Uint8Array} indices @param {number} instances
         * @param {number} baseVertex @param {number} baseInstance
         */
        glDrawElementsInstancedBaseVertexBaseInstance(mode, count, type, indices, instances,
            baseVertex, baseInstance)
        {
            drawElementsWith('glDrawElementsInstancedBaseVertexBaseInstance', mode, count, type,
                indices, baseVertex, { instances, baseInstance: baseInstance >>> 0 });
        },

        /**
         * One draw per list, each with its own count, indices and base vertex.
         *
         * @param {number} mode @param {number[]} counts @param {number} type
         * @param {(number | Uint8Array)[]} indices @param {number} drawcount
         * @param {number[]} baseVertices
         */
        glMultiDrawElementsBaseVertex(mode, counts, type, indices, drawcount, baseVertices){
            if (drawcount < 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            counts.forEach((count, k)=>{
                drawElementsWith('glMultiDrawElementsBaseVertex', mode, count, type, indices[k],
                    baseVertices[k] ?? 0, ONE_INSTANCE);
            });
        },

        // --- GL_EXT_compiled_vertex_array ---

        /** @param {number} first @param {number} count */
        glLockArraysEXT(first, count){
            if (!enter('glLockArraysEXT', [first, count]))
            {
                return;
            }
            if (first < 0 || count <= 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (locked)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            // The program's promise that the arrays in the range do not
            // change until the unlock: each lock is a new epoch, and a
            // renderer copies the range once an epoch rather than at every
            // pass of a multi-pass surface drawn from it.
            locked = { first, count, epoch: ++lockEpoch };
            setState(GL.ARRAY_ELEMENT_LOCK_FIRST, [first]);
            setState(GL.ARRAY_ELEMENT_LOCK_COUNT, [count]);
        },

        glUnlockArraysEXT(){
            if (!enter('glUnlockArraysEXT', []))
            {
                return;
            }
            if (!locked)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            locked = null;
            setState(GL.ARRAY_ELEMENT_LOCK_FIRST, [0]);
            setState(GL.ARRAY_ELEMENT_LOCK_COUNT, [0]);
        },

        // --- GL_ARB_vertex_buffer_object ---

        /** @param {number} count @returns {number[]} */
        glGenBuffersARB(count){
            if (!enter('glGenBuffersARB', [count]))
            {
                return [];
            }
            if (count < 0)
            {
                setError(GL.INVALID_VALUE);
                return [];
            }
            return kernel.shareGroup().buffers.reserve(count);
        },

        /** @param {number} target @param {number} name */
        glBindBufferARB(target, name){
            if (!enter('glBindBufferARB', [target, name]))
            {
                return;
            }
            const query = BINDING_QUERIES.get(target) ?? null;
            if (query === null)
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            const group = kernel.shareGroup();
            if (name !== 0 && !group.buffers.objects.has(name))
            {
                group.buffers.define(name, createBufferObject(name));
                group.used = true;
            }
            setState(query, [name]);
        },

        /** @param {number[]} names */
        glDeleteBuffersARB(names){
            if (!enter('glDeleteBuffersARB', [names]))
            {
                return;
            }
            const group = kernel.shareGroup();
            for (const name of names)
            {
                const object = name === 0 ? undefined : group.buffers.objects.get(name);
                if (!object)
                {
                    continue;
                }
                kernel.bufferDeleted?.(object);
                group.buffers.remove(name);
                for (const query of BINDING_QUERIES.values())
                {
                    if (record(query).values[0] === name)
                    {
                        setState(query, [0]);
                    }
                }
                for (const pointer of [...Object.values(pointers), ...texCoordPointers])
                {
                    if (pointer.buffer === name)
                    {
                        pointer.buffer = 0;
                    }
                }
            }
            for (const array of Object.keys(ARRAYS))
            {
                mirror(array);
            }
        },

        /** @param {number} name @returns {number} */
        glIsBufferARB(name){
            if (!enter('glIsBufferARB', [name]))
            {
                return GL.FALSE;
            }
            return kernel.shareGroup().buffers.objects.has(name) ? GL.TRUE : GL.FALSE;
        },

        /**
         * @param {number} target
         * @param {number} size
         * @param {number | Uint8Array | null} data
         * @param {number} usage
         */
        glBufferDataARB(target, size, data, usage){
            if (!enter('glBufferDataARB', [target, size, data, usage]))
            {
                return;
            }
            if (!USAGES.has(usage))
            {
                setError(GL.INVALID_ENUM);
                return;
            }
            if (size < 0)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            const buffer = boundBuffer(target);
            if (!buffer)
            {
                return;
            }
            if (buffer.mapped !== 0)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            buffer.data = new Uint8Array(size);
            buffer.size = size;
            buffer.usage = usage;
            buffer.written = size > 0 ? { start: 0, end: size } : null;
            buffer.version++;
            if (data instanceof Uint8Array)
            {
                buffer.data.set(data.subarray(0, size));
            }
            else if (data)
            {
                const memory = kernel.memory();
                if (memory)
                {
                    buffer.data.set((memory.window ?? memory.read)(data, size));
                }
            }
        },

        /**
         * @param {number} target
         * @param {number} offset
         * @param {number} size
         * @param {number | Uint8Array} data
         */
        glBufferSubDataARB(target, offset, size, data){
            if (!enter('glBufferSubDataARB', [target, offset, size, data]))
            {
                return;
            }
            const buffer = boundBuffer(target);
            if (!buffer)
            {
                return;
            }
            if (offset < 0 || size < 0 || offset + size > buffer.size)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (buffer.mapped !== 0)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            const memory = kernel.memory();
            const bytes = data instanceof Uint8Array ? data.subarray(0, size)
                : memory ? (memory.window ?? memory.read)(data, size) : null;
            if (bytes && size > 0)
            {
                buffer.data.set(bytes, offset);
                buffer.written = buffer.written
                    ? { start: Math.min(buffer.written.start, offset),
                        end: Math.max(buffer.written.end, offset + size) }
                    : { start: offset, end: offset + size };
                buffer.version++;
            }
        },

        /**
         * @param {number} target
         * @param {number} offset
         * @param {number} size
         * @returns {Uint8Array | null} the bytes, for the caller to write out
         */
        glGetBufferSubDataARB(target, offset, size){
            if (!enter('glGetBufferSubDataARB', [target, offset, size]))
            {
                return null;
            }
            const buffer = boundBuffer(target);
            if (!buffer)
            {
                return null;
            }
            if (offset < 0 || size < 0 || offset + size > buffer.size)
            {
                setError(GL.INVALID_VALUE);
                return null;
            }
            if (buffer.mapped !== 0)
            {
                setError(GL.INVALID_OPERATION);
                return null;
            }
            return buffer.data.slice(offset, offset + size);
        },

        /**
         * @param {number} target
         * @param {number} access
         * @returns {number} the guest address the store is mapped at, or zero
         */
        glMapBufferARB(target, access){
            if (!enter('glMapBufferARB', [target, access]))
            {
                return 0;
            }
            if (access !== GL.READ_ONLY && access !== GL.WRITE_ONLY && access !== GL.READ_WRITE)
            {
                setError(GL.INVALID_ENUM);
                return 0;
            }
            const buffer = boundBuffer(target);
            if (!buffer)
            {
                return 0;
            }
            if (buffer.mapped !== 0)
            {
                setError(GL.INVALID_OPERATION);
                return 0;
            }
            const bits = access === GL.READ_ONLY ? GL.MAP_READ_BIT
                : access === GL.WRITE_ONLY ? GL.MAP_WRITE_BIT : GL.MAP_READ_BIT | GL.MAP_WRITE_BIT;
            return mapRange(buffer, 0, buffer.size, bits, 'glMapBuffer');
        },

        /**
         * glMapBufferRange (OpenGL 3.0 section 2.9.3): part of the store, with
         * the access the bits say. Its errors are checked in the order the
         * specification lists them.
         *
         * @param {number} target @param {number} offset @param {number} length
         * @param {number} access  MAP_*_BIT
         * @returns {number} the guest address of the range, or zero
         */
        glMapBufferRange(target, offset, length, access){
            if (!enter('glMapBufferRange', [target, offset, length, access]))
            {
                return 0;
            }
            const buffer = boundBuffer(target);
            if (!buffer)
            {
                return 0;
            }
            if (offset < 0 || length < 0 || offset + length > buffer.size
                || (access & ~MAP_BITS) !== 0)
            {
                setError(GL.INVALID_VALUE);
                return 0;
            }
            const reads = (access & GL.MAP_READ_BIT) !== 0;
            const writes = (access & GL.MAP_WRITE_BIT) !== 0;
            if (length === 0 || buffer.mapped !== 0 || (!reads && !writes)
                || (reads && (access & (GL.MAP_INVALIDATE_RANGE_BIT
                    | GL.MAP_INVALIDATE_BUFFER_BIT | GL.MAP_UNSYNCHRONIZED_BIT)) !== 0)
                || ((access & GL.MAP_FLUSH_EXPLICIT_BIT) !== 0 && !writes))
            {
                setError(GL.INVALID_OPERATION);
                return 0;
            }
            return mapRange(buffer, offset, length, access, 'glMapBufferRange');
        },

        /**
         * Writes back part of an explicitly flushed map, relative to the range
         * mapped; what is not flushed by the unmap is not written back.
         *
         * @param {number} target @param {number} offset @param {number} length
         */
        glFlushMappedBufferRange(target, offset, length){
            if (!enter('glFlushMappedBufferRange', [target, offset, length]))
            {
                return;
            }
            const buffer = boundBuffer(target);
            if (!buffer)
            {
                return;
            }
            if (offset < 0 || length < 0 || offset + length > buffer.mapLength)
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (buffer.mapped === 0 || (buffer.accessFlags & GL.MAP_FLUSH_EXPLICIT_BIT) === 0)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            writeBack(buffer, buffer.mapOffset + offset, length);
        },

        /** @param {number} target @returns {number} GL_TRUE when the data survived */
        glUnmapBufferARB(target){
            if (!enter('glUnmapBufferARB', [target]))
            {
                return GL.FALSE;
            }
            const buffer = boundBuffer(target);
            if (!buffer)
            {
                return GL.FALSE;
            }
            if (buffer.mapped === 0)
            {
                setError(GL.INVALID_OPERATION);
                return GL.FALSE;
            }
            if ((buffer.accessFlags & GL.MAP_WRITE_BIT) !== 0
                && (buffer.accessFlags & GL.MAP_FLUSH_EXPLICIT_BIT) === 0)
            {
                writeBack(buffer, buffer.mapOffset, buffer.mapLength);
            }
            unmap(buffer);
            return GL.TRUE;
        },

        /**
         * glCopyBufferSubData (OpenGL 3.1, GL_ARB_copy_buffer): bytes of one
         * bound buffer into another, or within one where the ranges do not
         * overlap.
         *
         * @param {number} readTarget @param {number} writeTarget
         * @param {number} readOffset @param {number} writeOffset @param {number} size
         */
        glCopyBufferSubData(readTarget, writeTarget, readOffset, writeOffset, size){
            if (!enter('glCopyBufferSubData',
                [readTarget, writeTarget, readOffset, writeOffset, size]))
            {
                return;
            }
            const source = boundBuffer(readTarget);
            const destination = source ? boundBuffer(writeTarget) : null;
            if (!source || !destination)
            {
                return;
            }
            if (readOffset < 0 || writeOffset < 0 || size < 0
                || readOffset + size > source.size || writeOffset + size > destination.size
                || (source === destination && readOffset < writeOffset + size
                    && writeOffset < readOffset + size))
            {
                setError(GL.INVALID_VALUE);
                return;
            }
            if (source.mapped !== 0 || destination.mapped !== 0)
            {
                setError(GL.INVALID_OPERATION);
                return;
            }
            if (size > 0)
            {
                destination.data.set(source.data.subarray(readOffset, readOffset + size),
                    writeOffset);
                noteWritten(destination, writeOffset, size);
            }
        },

        /**
         * @param {number} target
         * @param {number} parameter
         * @returns {number[] | null}
         */
        glGetBufferParameterivARB(target, parameter){
            if (!enter('glGetBufferParameterivARB', [target, parameter]))
            {
                return null;
            }
            const buffer = boundBuffer(target);
            if (!buffer)
            {
                return null;
            }
            switch (parameter)
            {
                case GL.BUFFER_SIZE:
                    return [buffer.size];
                case GL.BUFFER_USAGE:
                    return [buffer.usage];
                case GL.BUFFER_ACCESS:
                    return [buffer.access];
                case GL.BUFFER_MAPPED:
                    return [buffer.mapped !== 0 ? 1 : 0];
                case GL.BUFFER_ACCESS_FLAGS:
                    return [buffer.accessFlags];
                case GL.BUFFER_MAP_OFFSET:
                    return [buffer.mapOffset];
                case GL.BUFFER_MAP_LENGTH:
                    return [buffer.mapLength];
                default:
                    setError(GL.INVALID_ENUM);
                    return null;
            }
        },

        /**
         * @param {number} target
         * @param {number} parameter
         * @returns {number[] | null}
         */
        glGetBufferPointervARB(target, parameter){
            if (!enter('glGetBufferPointervARB', [target, parameter]))
            {
                return null;
            }
            const buffer = boundBuffer(target);
            if (!buffer)
            {
                return null;
            }
            if (parameter !== GL.BUFFER_MAP_POINTER)
            {
                setError(GL.INVALID_ENUM);
                return null;
            }
            return [buffer.mapped];
        },
    });

    /** @param {number} type @returns {number} */
    Object.assign(kernel.side, { indexBytes: componentBytes });
}
