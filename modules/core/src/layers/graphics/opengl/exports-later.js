/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The marshalling of the entry points past OpenGL 1.1 that are new
 * functions rather than an extension's under another name (`exports.js`
 * answers those through the extension's handler): the shader and program
 * objects and their uniforms, the framebuffer objects, and the state calls
 * of 1.2 to 2.1.
 *
 * The same rules as `exports.js`: arguments arrive as raw words, a pointer
 * is a guest address, an answer a query writes goes where the caller said
 * and nowhere when it said null, and a string a call answers with is copied
 * out to at most the size the caller gave, terminated, with its length
 * written beside it. Strings and pointer arrays the program hands over --
 * a shader's source -- are read at the call.
 */

import { GL } from './constants.js';
import { TIMEOUT_IGNORED } from './context-sync.js';

/**
 * What `exports.js` lends: the current context, and its readers and writers
 * of guest memory.
 *
 * @typedef {Object} LaterHelpers
 * @property {() => any} current
 * @property {(body: (context: any) => any) => number} call
 * @property {(result: any) => number} answer
 * @property {(type: string, address: number, count: number) => number[]} readTyped
 * @property {(address: number, values: readonly number[]) => void} writeU32s
 * @property {(address: number, values: number[] | null,
 *     as: 'byte' | 'word' | 'float' | 'double' | 'pointer') => void} writeQuery
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number) => string} readName  a name, at most 256 bytes
 * @property {(address: number) => string} readText  a string of any length, to its NUL
 * @property {4 | 8} pointerSize
 */

const bits = new DataView(new ArrayBuffer(8));
/** @param {number} word */
const asFloat = word=>{
    bits.setUint32(0, word >>> 0, true);
    return bits.getFloat32(0, true);
};
/** @param {number} low @param {number} high */
const asDouble = (low, high)=>{
    bits.setUint32(0, low >>> 0, true);
    bits.setUint32(4, high >>> 0, true);
    return bits.getFloat64(0, true);
};

/**
 * @param {LaterHelpers} h
 * @returns {Record<string, (args: number[]) => number>}
 */
export function laterEntryPoints(h){
    const { current, call, answer, readTyped, writeU32s, writeQuery } = h;

    /** How many values a sampler parameter's vector form reads. @param {number} pname */
    const samplerCount = pname=>((pname >>> 0) === GL.TEXTURE_BORDER_COLOR ? 4 : 1);

    /**
     * A GLuint64 timeout from its two words, GL_TIMEOUT_IGNORED (all ones)
     * as the context names it.
     *
     * @param {number} low @param {number} high
     */
    const timeoutOf = (low, high)=>((low >>> 0) === 0xffffffff && (high >>> 0) === 0xffffffff
        ? TIMEOUT_IGNORED : (high >>> 0) * 0x100000000 + (low >>> 0));

    /**
     * glBlendFunci, glBlendFuncSeparatei, glBlendEquationi and
     * glBlendEquationSeparatei (4.0).
     *
     * @returns {Record<string, (args: number[]) => number>}
     */
    const blendsApart = ()=>({
        glBlendFunci: ([buffer, src, dst])=>answer(current()?.glBlendFuncSeparatei(buffer >>> 0,
            src >>> 0, dst >>> 0, src >>> 0, dst >>> 0)),
        glBlendFuncSeparatei: ([buffer, sr, dr, sa, da])=>answer(current()
            ?.glBlendFuncSeparatei(buffer >>> 0, sr >>> 0, dr >>> 0, sa >>> 0, da >>> 0)),
        glBlendEquationi: ([buffer, mode])=>answer(current()?.glBlendEquationSeparatei(
            buffer >>> 0, mode >>> 0, mode >>> 0)),
        glBlendEquationSeparatei: ([buffer, rgb, alpha])=>answer(current()
            ?.glBlendEquationSeparatei(buffer >>> 0, rgb >>> 0, alpha >>> 0)),
    });

    /**
     * The packed attribute forms (3.3), each word given or read from where
     * the program points.
     *
     * @returns {Record<string, (args: number[]) => number>}
     */
    const packedAttributes = ()=>{
        /** @type {Record<string, (args: number[]) => number>} */
        const forms = {};
        /**
         * @param {string} name @param {any} kind @param {number} count
         * @param {(args: number[]) => [number, number, boolean, number]} parts  index, type,
         *     normalised and the word's place in the arguments
         */
        const both = (name, kind, count, parts)=>{
            forms[`${name}ui`] = args=>{
                const [index, type, normalised, at] = parts(args);
                return answer(current()?.packedAttribute(kind, index, type >>> 0, normalised,
                    count, args[at]));
            };
            forms[`${name}uiv`] = args=>{
                const [index, type, normalised, at] = parts(args);
                return answer(current()?.packedAttribute(kind, index, type >>> 0, normalised,
                    count, readTyped('ui', args[at], 1)[0]));
            };
        };
        for (const count of [1, 2, 3, 4])
        {
            both(`glVertexAttribP${count}`, 'attrib', count,
                a=>[a[0] >>> 0, a[1], (a[2] & 0xff) !== 0, 3]);
            both(`glTexCoordP${count}`, 'texCoord', count, a=>[GL.TEXTURE0, a[0], false, 1]);
            both(`glMultiTexCoordP${count}`, 'texCoord', count,
                a=>[a[0] >>> 0, a[1], false, 2]);
            if (count > 1)
            {
                both(`glVertexP${count}`, 'vertex', count, a=>[0, a[0], false, 1]);
            }
        }
        both('glNormalP3', 'normal', 3, a=>[0, a[0], true, 1]);
        both('glColorP3', 'color', 3, a=>[0, a[0], true, 1]);
        both('glColorP4', 'color', 4, a=>[0, a[0], true, 1]);
        both('glSecondaryColorP3', 'secondary', 3, a=>[0, a[0], true, 1]);
        return forms;
    };

    /**
     * glVertexAttribI1i to glVertexAttribI4usv: each form's components, the
     * missing ones (0, 0, 1) as the 4i form fills them.
     *
     * @returns {Record<string, (args: number[]) => number>}
     */
    const integerAttributes = ()=>{
        /** @type {Record<string, (args: number[]) => number>} */
        const forms = {};
        /** @param {number} index @param {'int' | 'uint'} kind @param {number[]} given */
        const set = (index, kind, given)=>{
            const [x = 0, y = 0, z = 0, w = 1] = given;
            return answer(current()?.vertexAttribI(index >>> 0, kind, x, y, z, w));
        };
        for (const count of [1, 2, 3, 4])
        {
            forms[`glVertexAttribI${count}i`] = ([index, ...rest])=>
                set(index, 'int', rest.slice(0, count).map(v=>v | 0));
            forms[`glVertexAttribI${count}ui`] = ([index, ...rest])=>
                set(index, 'uint', rest.slice(0, count).map(v=>v >>> 0));
            forms[`glVertexAttribI${count}iv`] = ([index, v])=>
                set(index, 'int', readTyped('i', v, count));
            forms[`glVertexAttribI${count}uiv`] = ([index, v])=>
                set(index, 'uint', readTyped('ui', v, count));
        }
        for (const [suffix, type, kind] of /** @type {[string, string, 'int' | 'uint'][]} */ ([
            ['bv', 'b', 'int'], ['sv', 's', 'int'], ['ubv', 'ub', 'uint'], ['usv', 'us', 'uint'],
        ]))
        {
            forms[`glVertexAttribI4${suffix}`] = ([index, v])=>
                set(index, kind, readTyped(type, v, 4));
        }
        return forms;
    };

    /**
     * 64-bit answers, as GLint64s: what glGetInteger64v writes.
     *
     * @param {number} address @param {number[] | null} values
     */
    const writeInt64s = (address, values)=>{
        if (!values || (address >>> 0) === 0)
        {
            return;
        }
        const bytes = new Uint8Array(values.length * 8);
        const view = new DataView(bytes.buffer);
        values.forEach((value, k)=>view.setBigInt64(k * 8, BigInt(Math.trunc(value)), true));
        h.writeMemory(address >>> 0, bytes);
    };

    /** How many values glClearBuffer reads: four for a colour, one otherwise. @param {number} buffer */
    const clearCount = buffer=>((buffer >>> 0) === GL.COLOR ? 4 : 1);

    /**
     * An array of pointers the program hands over, each a pointer's width.
     *
     * @param {number} address @param {number} count
     * @returns {number[]}
     */
    const readPointers = (address, count)=>{
        if (count <= 0 || (address >>> 0) === 0)
        {
            return [];
        }
        const words = readTyped('ui', address, count * (h.pointerSize === 8 ? 2 : 1));
        return h.pointerSize === 8
            ? Array.from({ length: count }, (_, k)=>words[k * 2] >>> 0)
            : words.map(word=>word >>> 0);
    };

    /**
     * A string answered into the caller's buffer, as the GL's string getters
     * do: at most `size` bytes with the terminator, the length without it
     * written where asked.
     *
     * @param {string | null} text @param {number} size @param {number} lengthOut
     * @param {number} out
     */
    const answerString = (text, size, lengthOut, out)=>{
        if (text === null)
        {
            return;
        }
        const room = Math.max(0, (size | 0) - 1);
        const bytes = new Uint8Array(Math.min(room, text.length) + 1);
        for (let k = 0; k < bytes.length - 1; k++)
        {
            bytes[k] = text.charCodeAt(k) & 0xff;
        }
        if ((size | 0) > 0 && (out >>> 0) !== 0)
        {
            h.writeMemory(out >>> 0, bytes);
        }
        if ((lengthOut >>> 0) !== 0)
        {
            writeU32s(lengthOut, [(size | 0) > 0 ? bytes.length - 1 : 0]);
        }
    };

    /**
     * The handlers of glGen* and glDelete*: names written out, names read in.
     *
     * @param {(context: any, count: number) => number[]} gen
     */
    const generator = gen=>(/** @type {number[]} */ [count, out])=>call(context=>{
        const names = gen(context, count | 0);
        if (names.length > 0 && (out >>> 0) !== 0)
        {
            writeU32s(out, names);
        }
    });
    /** @param {(context: any, names: number[]) => void} remove */
    const deleter = remove=>(/** @type {number[]} */ [count, list])=>call(context=>remove(context,
        (count | 0) > 0 && (list >>> 0) !== 0 ? readTyped('ui', list, count | 0) : []));

    /** glGetAttachedShaders and its handle spelling: the names written out, and their count. */
    const attached = (/** @type {number[]} */ [program, most, countOut, out])=>call(context=>{
        const names = context.glGetAttachedShaders(program >>> 0);
        if (!names)
        {
            return;
        }
        const kept = names.slice(0, Math.max(0, most | 0));
        if (kept.length > 0 && (out >>> 0) !== 0)
        {
            writeU32s(out, kept);
        }
        if ((countOut >>> 0) !== 0)
        {
            writeU32s(countOut, [kept.length]);
        }
    });

    /** @type {Record<string, (args: number[]) => number>} */
    const handlers = {
        // --- shaders and programs ---

        glCreateShader: ([type])=>current()?.glCreateShader(type >>> 0) ?? 0,
        glShaderSource: ([shader, count, strings, lengths])=>call(context=>{
            const n = Math.max(0, count | 0);
            const pointers = readPointers(strings, n);
            const sizes = (lengths >>> 0) !== 0 ? readTyped('i', lengths, n) : null;
            const sources = pointers.map((pointer, k)=>{
                const size = sizes ? sizes[k] : -1;
                if (size < 0)
                {
                    return h.readText(pointer);
                }
                let text = '';
                const bytes = h.readMemory(pointer, size);
                for (let i = 0; i < size; i++)
                {
                    text += String.fromCharCode(bytes[i]);
                }
                return text;
            });
            if ((count | 0) < 0)
            {
                context.glShaderSource(shader >>> 0, null);
                return;
            }
            context.glShaderSource(shader >>> 0, sources);
        }),
        glCompileShader: ([shader])=>answer(current()?.glCompileShader(shader >>> 0)),
        glDeleteShader: ([shader])=>answer(current()?.glDeleteShader(shader >>> 0)),
        glIsShader: ([name])=>current()?.glIsShader(name >>> 0) ?? GL.FALSE,
        glGetShaderiv: ([shader, pname, out])=>call(context=>writeQuery(out,
            context.glGetShaderiv(shader >>> 0, pname >>> 0), 'word')),
        glGetShaderInfoLog: ([shader, size, length, out])=>call(context=>answerString(
            context.glGetShaderInfoLog(shader >>> 0), size, length, out)),
        glGetShaderSource: ([shader, size, length, out])=>call(context=>answerString(
            context.glGetShaderSource(shader >>> 0), size, length, out)),
        glCreateProgram: ()=>current()?.glCreateProgram() ?? 0,
        glAttachShader: ([program, shader])=>answer(
            current()?.glAttachShader(program >>> 0, shader >>> 0)),
        glDetachShader: ([program, shader])=>answer(
            current()?.glDetachShader(program >>> 0, shader >>> 0)),
        glBindAttribLocation: ([program, index, name])=>call(context=>
            context.glBindAttribLocation(program >>> 0, index >>> 0, h.readName(name))),
        glLinkProgram: ([program])=>answer(current()?.glLinkProgram(program >>> 0)),
        glUseProgram: ([program])=>answer(current()?.glUseProgram(program >>> 0)),
        glValidateProgram: ([program])=>answer(current()?.glValidateProgram(program >>> 0)),
        glDeleteProgram: ([program])=>answer(current()?.glDeleteProgram(program >>> 0)),
        glIsProgram: ([name])=>current()?.glIsProgram(name >>> 0) ?? GL.FALSE,
        glGetProgramiv: ([program, pname, out])=>call(context=>writeQuery(out,
            context.glGetProgramiv(program >>> 0, pname >>> 0), 'word')),
        glGetProgramInfoLog: ([program, size, length, out])=>call(context=>answerString(
            context.glGetProgramInfoLog(program >>> 0), size, length, out)),
        glGetAttachedShaders: attached,
        glGetAttachedObjectsARB: attached,
        glGetAttribLocation: ([program, name])=>(current()?.glGetAttribLocation(program >>> 0,
            h.readName(name)) ?? -1),
        glGetUniformLocation: ([program, name])=>(current()?.glGetUniformLocation(
            program >>> 0, h.readName(name)) ?? -1),
        glGetActiveAttrib: args=>active(args, 'glGetActiveAttrib'),
        glGetActiveUniform: args=>active(args, 'glGetActiveUniform'),
        glGetUniformfv: ([program, location, out])=>call(context=>{
            const answered = context.getUniform(program >>> 0, location | 0);
            if (answered)
            {
                writeQuery(out, answered.values, 'float');
            }
        }),
        glGetUniformiv: ([program, location, out])=>call(context=>{
            const answered = context.getUniform(program >>> 0, location | 0);
            if (answered)
            {
                writeQuery(out, answered.float ? answered.values.map(Math.trunc)
                    : answered.values, 'word');
            }
        }),

        // --- buffer ranges ---

        glMapBufferRange: ([target, offset, length, access])=>current()?.glMapBufferRange(
            target >>> 0, offset | 0, length | 0, access >>> 0) ?? 0,
        glFlushMappedBufferRange: ([target, offset, length])=>answer(
            current()?.glFlushMappedBufferRange(target >>> 0, offset | 0, length | 0)),
        // --- invalidation, barriers, sample shading, format queries (4.0 to 4.5) ---

        glInvalidateFramebuffer: ([target, count, list])=>call(context=>
            context.glInvalidateFramebuffer(target >>> 0, count | 0, (count | 0) > 0
                ? readTyped('ui', list, count | 0) : [], null)),
        glInvalidateSubFramebuffer: a=>call(context=>
            context.glInvalidateFramebuffer(a[0] >>> 0, a[1] | 0, (a[1] | 0) > 0
                ? readTyped('ui', a[2], a[1] | 0) : [], { width: a[5] | 0, height: a[6] | 0 })),
        glInvalidateBufferData: ([buffer])=>answer(current()?.glInvalidateBufferData(
            buffer >>> 0, null, 0)),
        glInvalidateBufferSubData: ([buffer, offset, length])=>answer(
            current()?.glInvalidateBufferData(buffer >>> 0, offset | 0, length | 0)),
        glInvalidateTexImage: ([texture, level])=>answer(current()?.glInvalidateTexImage(
            texture >>> 0, level | 0, null)),
        glInvalidateTexSubImage: a=>answer(current()?.glInvalidateTexImage(a[0] >>> 0,
            a[1] | 0, { x: a[2] | 0, y: a[3] | 0, z: a[4] | 0, width: a[5] | 0,
                height: a[6] | 0, depth: a[7] | 0 })),
        glMemoryBarrier: ([barriers])=>answer(current()?.glMemoryBarrier(barriers >>> 0, false)),
        glMemoryBarrierByRegion: ([barriers])=>answer(current()?.glMemoryBarrier(barriers >>> 0,
            true)),
        glTextureBarrier: ()=>answer(current()?.glTextureBarrier()),
        glMinSampleShading: ([value])=>answer(current()?.glMinSampleShading(asFloat(value))),
        glGetInternalformativ: ([target, internal, pname, size, out])=>call(context=>{
            const values = context.glGetInternalformativ(target >>> 0, internal >>> 0,
                pname >>> 0);
            if (values && (size | 0) > 0)
            {
                writeQuery(out, values.slice(0, size | 0), 'word');
            }
        }),

        glBufferStorage: ([target, size, data, flags])=>answer(current()?.glBufferStorage(
            target >>> 0, size | 0, (data >>> 0) || null, flags >>> 0)),
        glClearBufferData: ([target, internal, format, type, data])=>answer(
            current()?.clearBufferData('glClearBufferData', target >>> 0, internal >>> 0, null, 0,
                format >>> 0, type >>> 0, data >>> 0)),
        glClearBufferSubData: ([target, internal, offset, size, format, type, data])=>answer(
            current()?.clearBufferData('glClearBufferSubData', target >>> 0, internal >>> 0,
                offset | 0, size | 0, format >>> 0, type >>> 0, data >>> 0)),
        glCopyBufferSubData: ([read, write, readOffset, writeOffset, size])=>answer(
            current()?.glCopyBufferSubData(read >>> 0, write >>> 0, readOffset | 0,
                writeOffset | 0, size | 0)),

        // --- OpenGL ES 2.0's calls (4.1) ---

        glDepthRangef: ([near, far])=>answer(current()?.glDepthRange(asFloat(near),
            asFloat(far))),
        glClearDepthf: ([depth])=>answer(current()?.glClearDepth(asFloat(depth))),
        glReleaseShaderCompiler: ()=>answer(current()?.glReleaseShaderCompiler()),
        // The binary is never read: no format is known.
        glShaderBinary: ([count, shaders, format, , length])=>call(context=>
            context.glShaderBinary(readTyped('ui', shaders, Math.max(0, count | 0)),
                format >>> 0, length | 0)),
        glGetShaderPrecisionFormat: ([shaderType, precisionType, range, precision])=>
            call(context=>{
                const format = context.glGetShaderPrecisionFormat(shaderType >>> 0,
                    precisionType >>> 0);
                if (format)
                {
                    writeQuery(range, format.range, 'word');
                    writeQuery(precision, [format.precision], 'word');
                }
            }),

        glClampColor: ([target, clamp])=>answer(current()?.glClampColor(target >>> 0,
            clamp >>> 0)),
        glTexParameterIiv: ([target, pname, values])=>answer(current()?.texParameterI(
            target >>> 0, pname >>> 0, readTyped('i', values, samplerCount(pname)))),
        glTexParameterIuiv: ([target, pname, values])=>answer(current()?.texParameterI(
            target >>> 0, pname >>> 0, readTyped('ui', values, samplerCount(pname)))),
        glGetTexParameterIiv: ([target, pname, out])=>call(context=>writeQuery(out,
            context.glGetTexParameteriv(target >>> 0, pname >>> 0), 'word')),
        glGetTexParameterIuiv: ([target, pname, out])=>call(context=>writeQuery(out,
            context.glGetTexParameteriv(target >>> 0, pname >>> 0), 'word')),
        glGetBufferParameteri64v: ([target, pname, out])=>call(context=>writeInt64s(out,
            context.glGetBufferParameterivARB(target >>> 0, pname >>> 0))),
        glPrimitiveRestartIndex: ([index])=>answer(current()?.glPrimitiveRestartIndex(
            index >>> 0)),
        ...Object.fromEntries(['glPolygonOffsetClamp', 'glPolygonOffsetClampEXT'].map(name=>[name,
            (/** @type {number[]} */ [factor, units, clamp])=>answer(current()
                ?.glPolygonOffsetClamp(asFloat(factor), asFloat(units), asFloat(clamp)))])),

        // --- sampler objects (3.3) ---

        glGenSamplers: generator((context, count)=>context.glGenSamplers(count)),
        glDeleteSamplers: deleter((context, names)=>context.glDeleteSamplers(names)),
        glIsSampler: ([name])=>current()?.glIsSampler(name >>> 0) ?? GL.FALSE,
        glBindSampler: ([unit, name])=>answer(current()?.glBindSampler(unit >>> 0, name >>> 0)),
        glSamplerParameteri: ([name, pname, value])=>answer(current()?.samplerParameter(
            name >>> 0, pname >>> 0, [value | 0])),
        glSamplerParameterf: ([name, pname, value])=>answer(current()?.samplerParameter(
            name >>> 0, pname >>> 0, [asFloat(value)])),
        glSamplerParameteriv: ([name, pname, values])=>answer(current()?.samplerParameter(
            name >>> 0, pname >>> 0, readTyped('i', values, samplerCount(pname))
                .map(v=>((pname >>> 0) === GL.TEXTURE_BORDER_COLOR ? v / 0x7fffffff : v)))),
        glSamplerParameterfv: ([name, pname, values])=>answer(current()?.samplerParameter(
            name >>> 0, pname >>> 0, readTyped('f', values, samplerCount(pname)))),
        glSamplerParameterIiv: ([name, pname, values])=>answer(current()?.samplerParameter(
            name >>> 0, pname >>> 0, readTyped('i', values, samplerCount(pname)))),
        glSamplerParameterIuiv: ([name, pname, values])=>answer(current()?.samplerParameter(
            name >>> 0, pname >>> 0, readTyped('ui', values, samplerCount(pname)))),
        glGetSamplerParameteriv: ([name, pname, out])=>call(context=>writeQuery(out,
            context.getSamplerParameter(name >>> 0, pname >>> 0)?.map((/** @type {number} */ v)=>
                ((pname >>> 0) === GL.TEXTURE_BORDER_COLOR
                    ? Math.round(Math.max(-1, Math.min(1, v)) * 0x7fffffff) : Math.round(v)))
                ?? null, 'word')),
        glGetSamplerParameterfv: ([name, pname, out])=>call(context=>writeQuery(out,
            context.getSamplerParameter(name >>> 0, pname >>> 0), 'float')),
        glGetSamplerParameterIiv: ([name, pname, out])=>call(context=>writeQuery(out,
            context.getSamplerParameter(name >>> 0, pname >>> 0), 'word')),
        glGetSamplerParameterIuiv: ([name, pname, out])=>call(context=>writeQuery(out,
            context.getSamplerParameter(name >>> 0, pname >>> 0), 'word')),

        // --- sync objects (3.2) ---

        glFenceSync: ([condition, flags])=>current()?.glFenceSync(condition >>> 0, flags >>> 0)
            ?? 0,
        glIsSync: ([sync])=>current()?.glIsSync(sync >>> 0) ?? GL.FALSE,
        glDeleteSync: ([sync])=>answer(current()?.glDeleteSync(sync >>> 0)),
        glWaitSync: ([sync, flags, low, high])=>answer(current()?.glWaitSync(sync >>> 0,
            flags >>> 0, timeoutOf(low, high))),
        glGetSynciv: ([sync, pname, size, length, out])=>call(context=>{
            const values = (context.glGetSynciv(sync >>> 0, pname >>> 0) ?? [])
                .slice(0, Math.max(0, size | 0));
            if ((length >>> 0) !== 0)
            {
                writeU32s(length, [values.length]);
            }
            writeQuery(out, values, 'word');
        }),

        // --- packed attributes (3.3) ---

        ...packedAttributes(),

        // --- integer vertex attributes (3.0) ---

        ...integerAttributes(),
        glVertexAttribIPointer: ([index, size, type, stride, pointer])=>answer(current()
            ?.glVertexAttribIPointer(index >>> 0, size | 0, type >>> 0, stride | 0,
                pointer >>> 0)),
        glGetVertexAttribIiv: ([index, pname, out])=>call(context=>writeQuery(out,
            context.getVertexAttribI(index >>> 0, pname >>> 0, 'int'), 'word')),
        glGetVertexAttribIuiv: ([index, pname, out])=>call(context=>writeQuery(out,
            context.getVertexAttribI(index >>> 0, pname >>> 0, 'uint'), 'word')),

        // --- indexed state, 64-bit queries and one buffer's clears (3.0, 3.2) ---

        glEnablei: ([cap, index])=>answer(current()?.glEnablei(cap >>> 0, index >>> 0)),
        glDisablei: ([cap, index])=>answer(current()?.glDisablei(cap >>> 0, index >>> 0)),
        glIsEnabledi: ([cap, index])=>current()?.glIsEnabledi(cap >>> 0, index >>> 0)
            ?? GL.FALSE,
        glColorMaski: ([index, r, g, b, a])=>answer(current()?.glColorMaski(index >>> 0,
            r & 0xff, g & 0xff, b & 0xff, a & 0xff)),
        ...blendsApart(),
        glGetIntegeri_v: ([target, index, out])=>call(context=>writeQuery(out,
            context.glGetIntegeri_v(target >>> 0, index >>> 0), 'word')),
        glGetFloati_v: ([target, index, out])=>call(context=>writeQuery(out,
            context.glGetFloati_v(target >>> 0, index >>> 0), 'float')),
        glGetDoublei_v: ([target, index, out])=>call(context=>writeQuery(out,
            context.glGetFloati_v(target >>> 0, index >>> 0), 'double')),
        glViewportArrayv: ([first, count, values])=>call(context=>context.glViewportArrayv(
            first >>> 0, count | 0, readTyped('f', values, 4 * Math.max(0, count | 0)))),
        glViewportIndexedf: ([index, x, y, width, height])=>answer(current()?.glViewportArrayv(
            index >>> 0, 1, [x, y, width, height].map(asFloat))),
        glViewportIndexedfv: ([index, values])=>call(context=>context.glViewportArrayv(
            index >>> 0, 1, readTyped('f', values, 4))),
        glScissorArrayv: ([first, count, values])=>call(context=>context.glScissorArrayv(
            first >>> 0, count | 0, readTyped('i', values, 4 * Math.max(0, count | 0)))),
        glScissorIndexed: ([index, x, y, width, height])=>answer(current()?.glScissorArrayv(
            index >>> 0, 1, [x | 0, y | 0, width | 0, height | 0])),
        glScissorIndexedv: ([index, values])=>call(context=>context.glScissorArrayv(
            index >>> 0, 1, readTyped('i', values, 4))),
        glDepthRangeArrayv: ([first, count, values])=>call(context=>context.glDepthRangeArrayv(
            first >>> 0, count | 0, readTyped('d', values, 2 * Math.max(0, count | 0)))),
        glDepthRangeIndexed: ([index, nearLow, nearHigh, farLow, farHigh])=>answer(
            current()?.glDepthRangeArrayv(index >>> 0, 1, [asDouble(nearLow, nearHigh),
                asDouble(farLow, farHigh)])),
        glGetBooleani_v: ([target, index, out])=>call(context=>writeQuery(out,
            context.glGetBooleani_v(target >>> 0, index >>> 0), 'byte')),
        glGetInteger64i_v: ([target, index, out])=>call(context=>writeInt64s(out,
            context.glGetInteger64i_v(target >>> 0, index >>> 0))),
        glGetInteger64v: ([query, out])=>call(context=>writeInt64s(out,
            context.glGetInteger64v(query >>> 0))),
        glClearBufferiv: ([buffer, drawBuffer, value])=>call(context=>context.clearBuffer(
            buffer >>> 0, drawBuffer | 0, readTyped('i', value, clearCount(buffer)), 'int')),
        glClearBufferuiv: ([buffer, drawBuffer, value])=>call(context=>context.clearBuffer(
            buffer >>> 0, drawBuffer | 0, readTyped('ui', value, clearCount(buffer)), 'uint')),
        glClearBufferfv: ([buffer, drawBuffer, value])=>call(context=>context.clearBuffer(
            buffer >>> 0, drawBuffer | 0, readTyped('f', value, clearCount(buffer)), 'float')),
        glClearBufferfi: ([buffer, drawBuffer, depth, stencil])=>answer(current()
            ?.glClearBufferfi(buffer >>> 0, drawBuffer | 0, asFloat(depth), stencil | 0)),

        // --- vertex array objects ---

        glGenVertexArrays: generator((context, count)=>context.glGenVertexArrays(count)),
        glDeleteVertexArrays: deleter((context, names)=>context.glDeleteVertexArrays(names)),
        glBindVertexArray: ([name])=>answer(current()?.glBindVertexArray(name >>> 0)),
        glIsVertexArray: ([name])=>current()?.glIsVertexArray(name >>> 0) ?? GL.FALSE,

        // --- GL_ARB_shader_objects: the objects above by handle ---

        glCreateShaderObjectARB: ([type])=>current()?.glCreateShader(type >>> 0) ?? 0,
        glCreateProgramObjectARB: ()=>current()?.glCreateProgram() ?? 0,
        glAttachObjectARB: ([program, shader])=>answer(
            current()?.glAttachShader(program >>> 0, shader >>> 0)),
        glDetachObjectARB: ([program, shader])=>answer(
            current()?.glDetachShader(program >>> 0, shader >>> 0)),
        glUseProgramObjectARB: ([program])=>answer(current()?.glUseProgram(program >>> 0)),
        glDeleteObjectARB: ([name])=>answer(current()?.deleteObjectARB(name >>> 0)),
        glGetHandleARB: ([pname])=>current()?.getHandleARB(pname >>> 0) ?? 0,
        glGetObjectParameterivARB: ([name, pname, out])=>call(context=>writeQuery(out,
            context.getObjectParameterARB(name >>> 0, pname >>> 0), 'word')),
        glGetObjectParameterfvARB: ([name, pname, out])=>call(context=>writeQuery(out,
            context.getObjectParameterARB(name >>> 0, pname >>> 0), 'float')),
        glGetInfoLogARB: ([name, size, length, out])=>call(context=>answerString(
            context.getInfoLogARB(name >>> 0), size, length, out)),

        // --- framebuffer objects ---

        glGenFramebuffers: generator((context, count)=>context.glGenFramebuffers(count)),
        glDeleteFramebuffers: deleter((context, names)=>context.glDeleteFramebuffers(names)),
        glIsFramebuffer: ([name])=>current()?.glIsFramebuffer(name >>> 0) ?? GL.FALSE,
        glBindFramebuffer: ([target, name])=>answer(
            current()?.bindFramebuffer(target >>> 0, name >>> 0, false)),
        glBindFramebufferEXT: ([target, name])=>answer(
            current()?.bindFramebuffer(target >>> 0, name >>> 0, true)),
        glCheckFramebufferStatus: ([target])=>current()?.glCheckFramebufferStatus(target >>> 0)
            ?? 0,
        glFramebufferTexture1D: a=>answer(current()?.framebufferTexture(a[0] >>> 0, a[1] >>> 0,
            a[2] >>> 0, a[3] >>> 0, a[4] | 0)),
        glFramebufferTexture2D: a=>answer(current()?.framebufferTexture(a[0] >>> 0, a[1] >>> 0,
            a[2] >>> 0, a[3] >>> 0, a[4] | 0)),
        glFramebufferTexture3D: a=>answer(current()?.framebufferTexture(a[0] >>> 0, a[1] >>> 0,
            a[2] >>> 0, a[3] >>> 0, a[4] | 0)),
        // A layer of a 3D or array texture, of which there are none: only a
        // detach is not an error.
        glFramebufferTextureLayer: a=>answer(current()?.framebufferTexture(a[0] >>> 0,
            a[1] >>> 0, (a[2] >>> 0) === 0 ? GL.TEXTURE_2D : GL.TEXTURE_3D, a[2] >>> 0,
            a[3] | 0)),
        glFramebufferRenderbuffer: a=>answer(current()?.glFramebufferRenderbuffer(a[0] >>> 0,
            a[1] >>> 0, a[2] >>> 0, a[3] >>> 0)),
        glGetFramebufferAttachmentParameteriv: ([target, attachment, pname, out])=>call(
            context=>writeQuery(out, context.glGetFramebufferAttachmentParameteriv(
                target >>> 0, attachment >>> 0, pname >>> 0), 'word')),
        // GL_ARB_framebuffer_no_attachments, its 4.5 and EXT_direct_state_access forms.
        glFramebufferParameteri: ([target, pname, param])=>call(context=>context
            .framebufferParameter('glFramebufferParameteri',
                context.framebufferBoundTo(target >>> 0), pname >>> 0, param | 0)),
        glNamedFramebufferParameteri: ([name, pname, param])=>call(context=>context
            .framebufferParameter('glNamedFramebufferParameteri',
                context.framebufferNamed(name >>> 0), pname >>> 0, param | 0)),
        glNamedFramebufferParameteriEXT: ([name, pname, param])=>call(context=>context
            .framebufferParameter('glNamedFramebufferParameteri',
                context.framebufferNamed(name >>> 0), pname >>> 0, param | 0)),
        glGetFramebufferParameteriv: ([target, pname, out])=>call(context=>writeQuery(out,
            context.getFramebufferParameter('glGetFramebufferParameteriv',
                context.framebufferBoundTo(target >>> 0), pname >>> 0), 'word')),
        glGetNamedFramebufferParameteriv: ([name, pname, out])=>call(context=>writeQuery(out,
            context.getFramebufferParameter('glGetNamedFramebufferParameteriv',
                context.framebufferNamed(name >>> 0), pname >>> 0), 'word')),
        glGetNamedFramebufferParameterivEXT: ([name, pname, out])=>call(context=>writeQuery(out,
            context.getFramebufferParameter('glGetNamedFramebufferParameteriv',
                context.framebufferNamed(name >>> 0), pname >>> 0), 'word')),
        glGetFramebufferParameterivEXT: ([name, pname, out])=>call(context=>writeQuery(out,
            context.glGetFramebufferParameterivEXT(name >>> 0, pname >>> 0), 'word')),
        glCreateFramebuffers: generator((context, count)=>context.glCreateFramebuffers(count)),
        glCreateRenderbuffers: generator((context, count)=>context.glCreateRenderbuffers(count)),
        glGenRenderbuffers: generator((context, count)=>context.glGenRenderbuffers(count)),
        glDeleteRenderbuffers: deleter((context, names)=>context.glDeleteRenderbuffers(names)),
        glIsRenderbuffer: ([name])=>current()?.glIsRenderbuffer(name >>> 0) ?? GL.FALSE,
        glBindRenderbuffer: ([target, name])=>answer(
            current()?.bindRenderbuffer(target >>> 0, name >>> 0, false)),
        glBindRenderbufferEXT: ([target, name])=>answer(
            current()?.bindRenderbuffer(target >>> 0, name >>> 0, true)),
        glRenderbufferStorage: ([target, format, width, height])=>answer(
            current()?.glRenderbufferStorageMultisample(target >>> 0, 0, format >>> 0,
                width | 0, height | 0)),
        glRenderbufferStorageMultisample: ([target, samples, format, width, height])=>answer(
            current()?.glRenderbufferStorageMultisample(target >>> 0, samples | 0,
                format >>> 0, width | 0, height | 0)),
        glGetRenderbufferParameteriv: ([target, pname, out])=>call(context=>writeQuery(out,
            context.glGetRenderbufferParameteriv(target >>> 0, pname >>> 0), 'word')),
        glGenerateMipmap: ([target])=>answer(current()?.glGenerateMipmap(target >>> 0)),
        glBlitFramebuffer: a=>answer(current()?.glBlitFramebuffer(a[0] | 0, a[1] | 0, a[2] | 0,
            a[3] | 0, a[4] | 0, a[5] | 0, a[6] | 0, a[7] | 0, a[8] >>> 0, a[9] >>> 0)),

        // --- blending, stencil faces, draw buffers ---

        glBlendColor: ([r, g, b, a])=>answer(current()?.glBlendColor(asFloat(r), asFloat(g),
            asFloat(b), asFloat(a))),
        glBlendEquation: ([mode])=>answer(current()?.glBlendEquation(mode >>> 0)),
        glBlendEquationSeparate: ([rgb, alpha])=>answer(
            current()?.glBlendEquationSeparate(rgb >>> 0, alpha >>> 0)),
        glBlendFuncSeparate: a=>answer(current()?.glBlendFuncSeparate(a[0] >>> 0, a[1] >>> 0,
            a[2] >>> 0, a[3] >>> 0)),
        glStencilFuncSeparate: ([face, func, ref, mask])=>answer(
            current()?.glStencilFuncSeparate(face >>> 0, func >>> 0, ref | 0, mask >>> 0)),
        glStencilOpSeparate: a=>answer(current()?.glStencilOpSeparate(a[0] >>> 0, a[1] >>> 0,
            a[2] >>> 0, a[3] >>> 0)),
        glStencilMaskSeparate: ([face, mask])=>answer(
            current()?.glStencilMaskSeparate(face >>> 0, mask >>> 0)),
        glDrawBuffers: ([count, list])=>call(context=>context.glDrawBuffers(
            (count | 0) > 0 && (list >>> 0) !== 0 ? readTyped('ui', list, count | 0)
                : new Array(Math.max(0, count | 0)).fill(GL.NONE))),

        // --- points, samples, matrices, the window raster position ---

        glPointParameterf: ([pname, value])=>answer(
            current()?.glPointParameterfv(pname >>> 0, [asFloat(value)])),
        glPointParameteri: ([pname, value])=>answer(
            current()?.glPointParameterfv(pname >>> 0, [value | 0])),
        glPointParameterfv: ([pname, address])=>answer(current()?.glPointParameterfv(
            pname >>> 0, readTyped('f', address,
                (pname >>> 0) === GL.POINT_DISTANCE_ATTENUATION ? 3 : 1))),
        glPointParameteriv: ([pname, address])=>answer(current()?.glPointParameterfv(
            pname >>> 0, readTyped('i', address,
                (pname >>> 0) === GL.POINT_DISTANCE_ATTENUATION ? 3 : 1))),
        glSampleCoverage: ([value, invert])=>answer(
            current()?.glSampleCoverage(asFloat(value), invert & 0xff)),
        glLoadTransposeMatrixf: ([address])=>answer(
            current()?.glLoadTransposeMatrixf(readTyped('f', address, 16))),
        glLoadTransposeMatrixd: ([address])=>answer(
            current()?.glLoadTransposeMatrixf(readTyped('d', address, 16))),
        glMultTransposeMatrixf: ([address])=>answer(
            current()?.glMultTransposeMatrixf(readTyped('f', address, 16))),
        glMultTransposeMatrixd: ([address])=>answer(
            current()?.glMultTransposeMatrixf(readTyped('d', address, 16))),

        // --- draws of several ranges ---

        glMultiDrawArrays: ([mode, firsts, counts, primcount])=>call(context=>{
            const n = Math.max(0, primcount | 0);
            const first = readTyped('i', firsts, n);
            const count = readTyped('i', counts, n);
            for (let k = 0; k < n; k++)
            {
                context.glDrawArrays(mode >>> 0, first[k], count[k]);
            }
        }),
        glMultiDrawElements: ([mode, counts, type, indices, primcount])=>call(context=>{
            const n = Math.max(0, primcount | 0);
            const count = readTyped('i', counts, n);
            const pointers = readPointers(indices, n);
            for (let k = 0; k < n; k++)
            {
                context.glDrawElements(mode >>> 0, count[k], type >>> 0, pointers[k]);
            }
        }),

        // --- instances and base vertices ---

        glDrawArraysInstanced: ([mode, first, count, instances])=>answer(
            current()?.glDrawArraysInstanced(mode >>> 0, first | 0, count | 0, instances | 0)),
        glDrawArraysInstancedBaseInstance: ([mode, first, count, instances, baseInstance])=>
            answer(current()?.glDrawArraysInstancedBaseInstance(mode >>> 0, first | 0, count | 0,
                instances | 0, baseInstance >>> 0)),
        glDrawElementsInstanced: ([mode, count, type, indices, instances])=>answer(
            current()?.glDrawElementsInstanced(mode >>> 0, count | 0, type >>> 0, indices >>> 0,
                instances | 0)),
        glDrawElementsBaseVertex: ([mode, count, type, indices, baseVertex])=>answer(
            current()?.glDrawElementsBaseVertex(mode >>> 0, count | 0, type >>> 0, indices >>> 0,
                baseVertex | 0)),
        glDrawRangeElementsBaseVertex: ([mode, start, end, count, type, indices, baseVertex])=>
            answer(current()?.glDrawRangeElementsBaseVertex(mode >>> 0, start >>> 0, end >>> 0,
                count | 0, type >>> 0, indices >>> 0, baseVertex | 0)),
        glDrawElementsInstancedBaseVertex: ([mode, count, type, indices, instances, baseVertex])=>
            answer(current()?.glDrawElementsInstancedBaseVertex(mode >>> 0, count | 0,
                type >>> 0, indices >>> 0, instances | 0, baseVertex | 0)),
        glDrawElementsInstancedBaseInstance: a=>answer(
            current()?.glDrawElementsInstancedBaseInstance(a[0] >>> 0, a[1] | 0, a[2] >>> 0,
                a[3] >>> 0, a[4] | 0, a[5] >>> 0)),
        glDrawElementsInstancedBaseVertexBaseInstance: a=>answer(
            current()?.glDrawElementsInstancedBaseVertexBaseInstance(a[0] >>> 0, a[1] | 0,
                a[2] >>> 0, a[3] >>> 0, a[4] | 0, a[5] | 0, a[6] >>> 0)),
        glDrawArraysIndirect: ([mode, indirect])=>answer(
            current()?.glDrawArraysIndirect(mode >>> 0, indirect >>> 0)),
        glDrawElementsIndirect: ([mode, type, indirect])=>answer(
            current()?.glDrawElementsIndirect(mode >>> 0, type >>> 0, indirect >>> 0)),
        glMultiDrawArraysIndirect: ([mode, indirect, drawcount, stride])=>answer(
            current()?.glMultiDrawArraysIndirect(mode >>> 0, indirect >>> 0, drawcount | 0,
                stride | 0)),
        glMultiDrawElementsIndirect: ([mode, type, indirect, drawcount, stride])=>answer(
            current()?.glMultiDrawElementsIndirect(mode >>> 0, type >>> 0, indirect >>> 0,
                drawcount | 0, stride | 0)),
        glMultiDrawArraysIndirectCount: ([mode, indirect, drawcount, most, stride])=>answer(
            current()?.glMultiDrawArraysIndirectCount(mode >>> 0, indirect >>> 0,
                drawcount >>> 0, most | 0, stride | 0)),
        glMultiDrawElementsIndirectCount: ([mode, type, indirect, drawcount, most, stride])=>
            answer(current()?.glMultiDrawElementsIndirectCount(mode >>> 0, type >>> 0,
                indirect >>> 0, drawcount >>> 0, most | 0, stride | 0)),
        glMultiDrawElementsBaseVertex: ([mode, counts, type, indices, drawcount, bases])=>
            call(context=>{
                const n = Math.max(0, drawcount | 0);
                context.glMultiDrawElementsBaseVertex(mode >>> 0, readTyped('i', counts, n),
                    type >>> 0, readPointers(indices, n), drawcount | 0, readTyped('i', bases, n));
            }),
        glVertexAttribDivisor: ([index, divisor])=>answer(
            current()?.glVertexAttribDivisor(index >>> 0, divisor >>> 0)),

        // --- occlusion queries ---

        glGenQueries: generator((context, count)=>context.glGenQueries(count)),
        glDeleteQueries: deleter((context, names)=>context.glDeleteQueries(names)),
        glIsQuery: ([name])=>current()?.glIsQuery(name >>> 0) ?? GL.FALSE,
        glBeginQuery: ([target, name])=>answer(current()?.glBeginQuery(target >>> 0, name >>> 0)),
        glEndQuery: ([target])=>answer(current()?.glEndQuery(target >>> 0)),
        glGetQueryiv: ([target, pname, out])=>call(context=>writeQuery(out,
            context.glGetQueryiv(target >>> 0, pname >>> 0), 'word')),
        glQueryCounter: ([name, target])=>answer(current()?.glQueryCounter(name >>> 0,
            target >>> 0)),
        glBeginConditionalRender: ([name, mode])=>answer(current()
            ?.glBeginConditionalRender(name >>> 0, mode >>> 0)),
        glEndConditionalRender: ()=>answer(current()?.glEndConditionalRender()),

        // --- 3D textures and texture arrays ---

        glTexImage3D: a=>answer(current()?.glTexImage3D(a[0] >>> 0, a[1] | 0, a[2] | 0,
            a[3] | 0, a[4] | 0, a[5] | 0, a[6] | 0, a[7] >>> 0, a[8] >>> 0, a[9] >>> 0)),
        glTexSubImage3D: a=>answer(current()?.glTexSubImage3D(a[0] >>> 0, a[1] | 0, a[2] | 0,
            a[3] | 0, a[4] | 0, a[5] | 0, a[6] | 0, a[7] | 0, a[8] >>> 0, a[9] >>> 0,
            a[10] >>> 0)),
        glCopyTexSubImage3D: a=>answer(current()?.glCopyTexSubImage3D(a[0] >>> 0, a[1] | 0,
            a[2] | 0, a[3] | 0, a[4] | 0, a[5] | 0, a[6] | 0, a[7] | 0, a[8] | 0)),

        // --- 3.0's unsigned uniforms and fragment outputs ---

        glGetUniformuiv: ([program, location, out])=>call(context=>{
            const answered = context.getUniform(program >>> 0, location | 0);
            if (answered)
            {
                /** @param {number} v */
                const unsigned = v=>Math.trunc(v) >>> 0;
                writeQuery(out, answered.float ? answered.values.map(unsigned) : answered.values,
                    'word');
            }
        }),
        glBindFragDataLocation: ([program, colour, name])=>call(context=>
            context.bindFragData(program >>> 0, colour >>> 0, 0, h.readName(name))),
        glBindFragDataLocationIndexed: ([program, colour, index, name])=>call(context=>
            context.bindFragData(program >>> 0, colour >>> 0, index >>> 0, h.readName(name))),
        glGetFragDataLocation: ([program, name])=>(current()?.fragData(program >>> 0,
            h.readName(name), 'location') ?? -1),
        glGetFragDataIndex: ([program, name])=>(current()?.fragData(program >>> 0,
            h.readName(name), 'index') ?? -1),

        // --- 3.1's uniform buffers and blocks ---

        glBindBufferBase: ([target, index, buffer])=>answer(current()?.glBindBufferBase(
            target >>> 0, index >>> 0, buffer >>> 0)),
        glBindBufferRange: ([target, index, buffer, offset, size])=>answer(
            current()?.glBindBufferRange(target >>> 0, index >>> 0, buffer >>> 0, offset | 0,
                size | 0)),
        glGetUniformBlockIndex: ([program, name])=>(current()?.glGetUniformBlockIndex(
            program >>> 0, h.readName(name)) ?? GL.INVALID_INDEX),
        glGetActiveUniformBlockiv: ([program, index, pname, out])=>call(context=>writeQuery(
            out, context.glGetActiveUniformBlockiv(program >>> 0, index >>> 0, pname >>> 0),
            'word')),
        glGetActiveUniformBlockName: ([program, index, size, length, out])=>call(context=>
            answerString(context.glGetActiveUniformBlockName(program >>> 0, index >>> 0), size,
                length, out)),
        glUniformBlockBinding: ([program, index, binding])=>answer(
            current()?.glUniformBlockBinding(program >>> 0, index >>> 0, binding >>> 0)),
        glProvokingVertex: ([mode])=>answer(current()?.glProvokingVertex(mode >>> 0)),

        // --- transform feedback ---

        glTransformFeedbackVaryings: ([program, count, names, mode])=>answer(current()
            ?.glTransformFeedbackVaryings(program >>> 0, readPointers(names, Math.max(0,
                count | 0)).map(pointer=>h.readName(pointer)), mode >>> 0)),
        glGetTransformFeedbackVarying: args=>active(args, 'glGetTransformFeedbackVarying'),
        glBeginTransformFeedback: ([primitive])=>answer(current()
            ?.glBeginTransformFeedback(primitive >>> 0)),
        glEndTransformFeedback: ()=>answer(current()?.glEndTransformFeedback()),
        glPauseTransformFeedback: ()=>answer(current()?.glPauseTransformFeedback()),
        glResumeTransformFeedback: ()=>answer(current()?.glResumeTransformFeedback()),
        glGenTransformFeedbacks: generator((context, count)=>
            context.glGenTransformFeedbacks(count)),
        glDeleteTransformFeedbacks: deleter((context, names)=>
            context.glDeleteTransformFeedbacks(names)),
        glIsTransformFeedback: ([name])=>current()?.glIsTransformFeedback(name >>> 0) ?? GL.FALSE,
        glBindTransformFeedback: ([target, name])=>answer(current()
            ?.glBindTransformFeedback(target >>> 0, name >>> 0)),

        glGetUniformIndices: ([program, count, names, out])=>call(context=>{
            const indices = context.glGetUniformIndices(program >>> 0,
                readPointers(names, count | 0).map(pointer=>h.readName(pointer)));
            if (indices && indices.length > 0 && (out >>> 0) !== 0)
            {
                writeU32s(out, indices);
            }
        }),
        glGetActiveUniformsiv: ([program, count, indices, pname, out])=>call(context=>{
            const list = (count | 0) > 0 && (indices >>> 0) !== 0
                ? readTyped('ui', indices, count | 0).map(v=>v >>> 0) : [];
            const values = context.glGetActiveUniformsiv(program >>> 0, list, pname >>> 0);
            if (values && values.length > 0 && (out >>> 0) !== 0)
            {
                writeU32s(out, values);
            }
        }),
        glGetActiveUniformName: ([program, index, size, length, out])=>call(context=>
            answerString(context.glGetActiveUniformName(program >>> 0, index >>> 0), size,
                length, out)),
    };

    /**
     * glGetActiveAttrib and glGetActiveUniform: a name, a size and a type.
     *
     * @param {number[]} args
     * @param {'glGetActiveAttrib' | 'glGetActiveUniform' | 'glGetTransformFeedbackVarying'} which
     */
    function active([program, index, size, lengthOut, sizeOut, typeOut, out], which){
        return call(context=>{
            const entry = context[which](program >>> 0, index >>> 0);
            if (!entry)
            {
                return;
            }
            answerString(entry.name, size, lengthOut, out);
            if ((sizeOut >>> 0) !== 0)
            {
                writeU32s(sizeOut, [entry.size]);
            }
            if ((typeOut >>> 0) !== 0)
            {
                writeU32s(typeOut, [entry.type]);
            }
        });
    }

    // glUniform{1234}{f,i,ui} and their vector forms, and the matrices.
    for (const n of [1, 2, 3, 4])
    {
        for (const kind of /** @type {const} */ (['f', 'i', 'u']))
        {
            const decode = kind === 'f' ? asFloat : kind === 'u'
                ? (/** @type {number} */ w)=>w >>> 0 : (/** @type {number} */ w)=>w | 0;
            const suffix = kind === 'u' ? 'ui' : kind;
            handlers[`glUniform${n}${suffix}`] = args=>{
                const context = current();
                if (context)
                {
                    const values = [];
                    for (let k = 0; k < n; k++)
                    {
                        values.push(decode(args[1 + k]));
                    }
                    context.uniform(args[0] | 0, 1, values, kind, n);
                }
                return 0;
            };
            handlers[`glUniform${n}${suffix}v`] = ([location, count, address])=>call(context=>
                context.uniform(location | 0, count | 0,
                    (count | 0) > 0 ? readTyped(kind === 'f' ? 'f' : kind === 'u' ? 'ui' : 'i',
                        address, (count | 0) * n) : [], kind, n));
        }
    }
    for (const cols of [2, 3, 4])
    {
        for (const rows of [2, 3, 4])
        {
            const name = cols === rows ? `glUniformMatrix${cols}fv`
                : `glUniformMatrix${cols}x${rows}fv`;
            handlers[name] = ([location, count, transpose, address])=>call(context=>
                context.uniformMatrix(location | 0, count | 0, transpose & 0xff,
                    (count | 0) > 0 ? readTyped('f', address, (count | 0) * cols * rows) : [],
                    cols, rows));
        }
    }
    Object.assign(handlers, storageAndNamedEntryPoints(h));
    return handlers;
}

/**
 * The texture storage, copy, clear and read-back calls of 4.2 to 4.5, and
 * the named calls of direct state access (`context-textures.js`,
 * `context-dsa.js`): each word converted as its bound form's handler
 * converts it, a box given as the six words it is, and what a getter answers
 * written where the program said.
 *
 * @param {LaterHelpers} h
 * @returns {Record<string, (args: number[]) => number>}
 */
function storageAndNamedEntryPoints(h){
    const { current, call, answer, readTyped, writeU32s, writeQuery } = h;

    /** @param {number[]} a @param {number} at @returns {import('./texture-levels.js').Box} */
    const boxAt = (a, at)=>({ x: a[at] | 0, y: a[at + 1] | 0, z: a[at + 2] | 0,
        width: a[at + 3] | 0, height: a[at + 4] | 0, depth: a[at + 5] | 0 });

    /** @param {number} address @param {Uint8Array | null} bytes */
    const deliver = (address, bytes)=>{
        if (bytes && (address >>> 0) !== 0)
        {
            h.writeMemory(address >>> 0, bytes);
        }
    };

    /** @param {(context: any, count: number) => number[]} make */
    const creator = make=>(/** @type {number[]} */ [count, out])=>call(context=>{
        const names = make(context, count | 0);
        if (names.length > 0 && (out >>> 0) !== 0)
        {
            writeU32s(out, names);
        }
    });

    /** How many values a texture parameter's vector form reads. @param {number} pname */
    const parameterCount = pname=>((pname >>> 0) === GL.TEXTURE_BORDER_COLOR ? 4 : 1);
    /** A signed integer as the normalised float an integer form's colour is (2.3.2). */
    const fromInt = (/** @type {number} */ value)=>(2 * value + 1) / 4294967295;

    /**
     * An integer answer of a normalised colour, as glGetTexParameteriv maps one.
     *
     * @param {number} pname @param {number[] | null} values
     */
    const toInts = (pname, values)=>(values && (pname >>> 0) === GL.TEXTURE_BORDER_COLOR
        ? values.map(value=>Math.round(Math.min(1, Math.max(0, value)) * 0x7fffffff))
        : values?.map(Math.round) ?? null);

    /** How many values glClearNamedFramebuffer reads: four for a colour, one otherwise. */
    const clearCount = (/** @type {number} */ buffer)=>((buffer >>> 0) === GL.COLOR ? 4 : 1);

    /**
     * A 64-bit answer, as GLint64s.
     *
     * @param {number} address @param {number[] | null} values
     */
    const writeInt64s = (address, values)=>{
        if (!values || (address >>> 0) === 0)
        {
            return;
        }
        const bytes = new Uint8Array(values.length * 8);
        const view = new DataView(bytes.buffer);
        values.forEach((value, k)=>view.setBigInt64(k * 8, BigInt(Math.trunc(value)), true));
        h.writeMemory(address >>> 0, bytes);
    };

    return {
        // --- GL_ARB_texture_storage, GL_ARB_copy_image, GL_ARB_clear_texture (4.2-4.4) ---

        glTexStorage1D: a=>answer(current()?.glTexStorage1D(a[0] >>> 0, a[1] | 0, a[2] >>> 0,
            a[3] | 0)),
        glTexStorage2D: a=>answer(current()?.glTexStorage2D(a[0] >>> 0, a[1] | 0, a[2] >>> 0,
            a[3] | 0, a[4] | 0)),
        glTexStorage3D: a=>answer(current()?.glTexStorage3D(a[0] >>> 0, a[1] | 0, a[2] >>> 0,
            a[3] | 0, a[4] | 0, a[5] | 0)),
        glCopyImageSubData: a=>answer(current()?.glCopyImageSubData(a[0] >>> 0, a[1] >>> 0,
            a[2] | 0, a[3] | 0, a[4] | 0, a[5] | 0, a[6] >>> 0, a[7] >>> 0, a[8] | 0, a[9] | 0,
            a[10] | 0, a[11] | 0, a[12] | 0, a[13] | 0, a[14] | 0)),
        glClearTexImage: ([texture, level, format, type, data])=>answer(current()?.clearTexImage(
            'glClearTexImage', texture >>> 0, level | 0, null, format >>> 0, type >>> 0,
            (data >>> 0) || null)),
        glClearTexSubImage: a=>answer(current()?.clearTexImage('glClearTexSubImage', a[0] >>> 0,
            a[1] | 0, boxAt(a, 2), a[8] >>> 0, a[9] >>> 0, (a[10] >>> 0) || null)),

        // --- GL_ARB_get_texture_sub_image (4.5) ---

        glGetTextureSubImage: a=>call(context=>deliver(a[11], context.glGetTextureSubImage(
            a[0] >>> 0, a[1] | 0, boxAt(a, 2), a[8] >>> 0, a[9] >>> 0, a[10] | 0))),
        glGetCompressedTextureSubImage: a=>call(context=>deliver(a[9],
            context.glGetCompressedTextureSubImage(a[0] >>> 0, a[1] | 0, boxAt(a, 2), a[8] | 0))),

        // --- direct state access (4.5): textures ---

        glCreateTextures: ([target, count, out])=>call(context=>{
            const names = context.glCreateTextures(target >>> 0, count | 0);
            if (names.length > 0 && (out >>> 0) !== 0)
            {
                writeU32s(out, names);
            }
        }),
        glTextureStorage1D: a=>answer(current()?.textureStorage(1, a[0] >>> 0, a[1] | 0,
            a[2] >>> 0, a[3] | 0, 1, 1)),
        glTextureStorage2D: a=>answer(current()?.textureStorage(2, a[0] >>> 0, a[1] | 0,
            a[2] >>> 0, a[3] | 0, a[4] | 0, 1)),
        glTextureStorage3D: a=>answer(current()?.textureStorage(3, a[0] >>> 0, a[1] | 0,
            a[2] >>> 0, a[3] | 0, a[4] | 0, a[5] | 0)),
        glTextureSubImage1D: a=>answer(current()?.textureSubImage(1, a[0] >>> 0, a[1] | 0,
            { x: a[2] | 0, y: 0, z: 0, width: a[3] | 0, height: 1, depth: 1 }, a[4] >>> 0,
            a[5] >>> 0, a[6] >>> 0)),
        glTextureSubImage2D: a=>answer(current()?.textureSubImage(2, a[0] >>> 0, a[1] | 0,
            { x: a[2] | 0, y: a[3] | 0, z: 0, width: a[4] | 0, height: a[5] | 0, depth: 1 },
            a[6] >>> 0, a[7] >>> 0, a[8] >>> 0)),
        glTextureSubImage3D: a=>answer(current()?.textureSubImage(3, a[0] >>> 0, a[1] | 0,
            boxAt(a, 2), a[8] >>> 0, a[9] >>> 0, a[10] >>> 0)),
        glCompressedTextureSubImage1D: a=>answer(current()?.compressedTextureSubImage(1,
            a[0] >>> 0, a[1] | 0, { x: a[2] | 0, y: 0, z: 0, width: a[3] | 0, height: 1,
                depth: 1 }, a[4] >>> 0, a[5] | 0, a[6] >>> 0)),
        glCompressedTextureSubImage2D: a=>answer(current()?.compressedTextureSubImage(2,
            a[0] >>> 0, a[1] | 0, { x: a[2] | 0, y: a[3] | 0, z: 0, width: a[4] | 0,
                height: a[5] | 0, depth: 1 }, a[6] >>> 0, a[7] | 0, a[8] >>> 0)),
        glCompressedTextureSubImage3D: a=>answer(current()?.compressedTextureSubImage(3,
            a[0] >>> 0, a[1] | 0, boxAt(a, 2), a[8] >>> 0, a[9] | 0, a[10] >>> 0)),
        glCopyTextureSubImage1D: a=>answer(current()?.copyTextureSubImage(1, a[0] >>> 0,
            a[1] | 0, a[2] | 0, 0, 0, a[3] | 0, a[4] | 0, a[5] | 0, 1)),
        glCopyTextureSubImage2D: a=>answer(current()?.copyTextureSubImage(2, a[0] >>> 0,
            a[1] | 0, a[2] | 0, a[3] | 0, 0, a[4] | 0, a[5] | 0, a[6] | 0, a[7] | 0)),
        glCopyTextureSubImage3D: a=>answer(current()?.copyTextureSubImage(3, a[0] >>> 0,
            a[1] | 0, a[2] | 0, a[3] | 0, a[4] | 0, a[5] | 0, a[6] | 0, a[7] | 0, a[8] | 0)),
        glTextureParameterf: ([texture, pname, value])=>answer(current()?.textureParameter(
            texture >>> 0, pname >>> 0, [asFloat(value)])),
        glTextureParameteri: ([texture, pname, value])=>answer(current()?.textureParameter(
            texture >>> 0, pname >>> 0, [value | 0])),
        glTextureParameterfv: ([texture, pname, values])=>answer(current()?.textureParameter(
            texture >>> 0, pname >>> 0, readTyped('f', values, parameterCount(pname)))),
        glTextureParameteriv: ([texture, pname, values])=>{
            const read = readTyped('i', values, parameterCount(pname));
            return answer(current()?.textureParameter(texture >>> 0, pname >>> 0,
                (pname >>> 0) === GL.TEXTURE_BORDER_COLOR ? read.map(fromInt) : read));
        },
        glTextureParameterIiv: ([texture, pname, values])=>answer(current()?.textureParameterI(
            texture >>> 0, pname >>> 0, readTyped('i', values, parameterCount(pname)))),
        glTextureParameterIuiv: ([texture, pname, values])=>answer(current()?.textureParameterI(
            texture >>> 0, pname >>> 0, readTyped('ui', values, parameterCount(pname)))),
        glGetTextureParameterfv: ([texture, pname, out])=>call(context=>writeQuery(out,
            context.getTextureParameter(texture >>> 0, pname >>> 0), 'float')),
        glGetTextureParameteriv: ([texture, pname, out])=>call(context=>writeQuery(out,
            toInts(pname, context.getTextureParameter(texture >>> 0, pname >>> 0)), 'word')),
        glGetTextureParameterIiv: ([texture, pname, out])=>call(context=>writeQuery(out,
            context.getTextureParameter(texture >>> 0, pname >>> 0), 'word')),
        glGetTextureParameterIuiv: ([texture, pname, out])=>call(context=>writeQuery(out,
            context.getTextureParameter(texture >>> 0, pname >>> 0), 'word')),
        glGetTextureLevelParameterfv: ([texture, level, pname, out])=>call(context=>writeQuery(
            out, context.glGetTextureLevelParameter(texture >>> 0, level | 0, pname >>> 0),
            'float')),
        glGetTextureLevelParameteriv: ([texture, level, pname, out])=>call(context=>writeQuery(
            out, context.glGetTextureLevelParameter(texture >>> 0, level | 0, pname >>> 0),
            'word')),
        glGenerateTextureMipmap: ([texture])=>answer(
            current()?.glGenerateTextureMipmap(texture >>> 0)),
        glBindTextureUnit: ([unit, texture])=>answer(
            current()?.glBindTextureUnit(unit >>> 0, texture >>> 0)),
        glGetTextureImage: ([texture, level, format, type, size, out])=>call(context=>deliver(
            out, context.glGetTextureImage(texture >>> 0, level | 0, format >>> 0, type >>> 0,
                size | 0))),
        glGetCompressedTextureImage: ([texture, level, size, out])=>call(context=>deliver(out,
            context.glGetCompressedTextureImage(texture >>> 0, level | 0, size | 0))),

        // --- direct state access: buffers ---

        glCreateBuffers: creator((context, count)=>context.glCreateBuffers(count)),
        glNamedBufferData: ([buffer, size, data, usage])=>answer(current()?.namedBuffer(
            'glBufferDataARB', buffer >>> 0, [size | 0, (data >>> 0) || null, usage >>> 0])),
        glNamedBufferSubData: ([buffer, offset, size, data])=>answer(current()?.namedBuffer(
            'glBufferSubDataARB', buffer >>> 0, [offset | 0, size | 0, data >>> 0])),
        glNamedBufferStorage: ([buffer, size, data, flags])=>answer(current()?.namedBuffer(
            'glBufferStorage', buffer >>> 0, [size | 0, (data >>> 0) || null, flags >>> 0])),
        glClearNamedBufferData: ([buffer, internal, format, type, data])=>answer(
            current()?.namedBuffer('glClearBufferData', buffer >>> 0, [internal >>> 0,
                format >>> 0, type >>> 0, data >>> 0])),
        glClearNamedBufferSubData: ([buffer, internal, offset, size, format, type, data])=>
            answer(current()?.namedBuffer('glClearBufferSubData', buffer >>> 0, [internal >>> 0,
                offset | 0, size | 0, format >>> 0, type >>> 0, data >>> 0])),
        glGetNamedBufferSubData: ([buffer, offset, size, out])=>call(context=>deliver(out,
            context.namedBuffer('glGetBufferSubDataARB', buffer >>> 0, [offset | 0, size | 0]))),
        glMapNamedBuffer: ([buffer, access])=>current()?.namedBuffer('glMapBufferARB',
            buffer >>> 0, [access >>> 0]) ?? 0,
        glMapNamedBufferRange: ([buffer, offset, length, access])=>current()?.namedBuffer(
            'glMapBufferRange', buffer >>> 0, [offset | 0, length | 0, access >>> 0]) ?? 0,
        glUnmapNamedBuffer: ([buffer])=>current()?.namedBuffer('glUnmapBufferARB', buffer >>> 0,
            []) ?? GL.FALSE,
        glFlushMappedNamedBufferRange: ([buffer, offset, length])=>answer(current()?.namedBuffer(
            'glFlushMappedBufferRange', buffer >>> 0, [offset | 0, length | 0])),
        glGetNamedBufferParameteriv: ([buffer, pname, out])=>call(context=>writeQuery(out,
            context.namedBuffer('glGetBufferParameterivARB', buffer >>> 0, [pname >>> 0]),
            'word')),
        glGetNamedBufferParameteri64v: ([buffer, pname, out])=>call(context=>writeInt64s(out,
            context.namedBuffer('glGetBufferParameterivARB', buffer >>> 0, [pname >>> 0]))),
        glGetNamedBufferPointerv: ([buffer, pname, out])=>call(context=>writeQuery(out,
            context.namedBuffer('glGetBufferPointervARB', buffer >>> 0, [pname >>> 0]),
            'pointer')),
        glCopyNamedBufferSubData: a=>answer(current()?.glCopyNamedBufferSubData(a[0] >>> 0,
            a[1] >>> 0, a[2] | 0, a[3] | 0, a[4] | 0)),

        // --- direct state access: framebuffers and renderbuffers ---

        glNamedFramebufferRenderbuffer: a=>answer(current()?.namedFramebuffer(
            'glFramebufferRenderbuffer', a[0] >>> 0, false, true, [a[1] >>> 0, a[2] >>> 0,
                a[3] >>> 0])),
        glNamedFramebufferTexture: a=>answer(current()?.namedFramebufferTexture(a[0] >>> 0,
            a[1] >>> 0, a[2] >>> 0, a[3] | 0, null)),
        glNamedFramebufferTextureLayer: a=>answer(current()?.namedFramebufferTexture(
            a[0] >>> 0, a[1] >>> 0, a[2] >>> 0, a[3] | 0, a[4] | 0)),
        glNamedFramebufferDrawBuffer: ([name, mode])=>answer(current()?.namedFramebuffer(
            'glDrawBuffer', name >>> 0, false, false, [mode >>> 0])),
        glNamedFramebufferDrawBuffers: ([name, count, list])=>call(context=>
            context.namedFramebuffer('glDrawBuffers', name >>> 0, false, false, [(count | 0) > 0
                && (list >>> 0) !== 0 ? readTyped('ui', list, count | 0)
                : new Array(Math.max(0, count | 0)).fill(GL.NONE)])),
        glNamedFramebufferReadBuffer: ([name, mode])=>answer(current()?.namedFramebuffer(
            'glReadBuffer', name >>> 0, true, false, [mode >>> 0])),
        glInvalidateNamedFramebufferData: ([name, count, list])=>call(context=>
            context.glInvalidateNamedFramebuffer(name >>> 0, count | 0, (count | 0) > 0
                ? readTyped('ui', list, count | 0) : [], null)),
        glInvalidateNamedFramebufferSubData: a=>call(context=>
            context.glInvalidateNamedFramebuffer(a[0] >>> 0, a[1] | 0, (a[1] | 0) > 0
                ? readTyped('ui', a[2], a[1] | 0) : [], { width: a[5] | 0, height: a[6] | 0 })),
        glClearNamedFramebufferiv: ([name, buffer, drawBuffer, value])=>call(context=>
            context.namedFramebuffer('clearBuffer', name >>> 0, false, false, [buffer >>> 0,
                drawBuffer | 0, readTyped('i', value, clearCount(buffer)), 'int'])),
        glClearNamedFramebufferuiv: ([name, buffer, drawBuffer, value])=>call(context=>
            context.namedFramebuffer('clearBuffer', name >>> 0, false, false, [buffer >>> 0,
                drawBuffer | 0, readTyped('ui', value, clearCount(buffer)), 'uint'])),
        glClearNamedFramebufferfv: ([name, buffer, drawBuffer, value])=>call(context=>
            context.namedFramebuffer('clearBuffer', name >>> 0, false, false, [buffer >>> 0,
                drawBuffer | 0, readTyped('f', value, clearCount(buffer)), 'float'])),
        glClearNamedFramebufferfi: ([name, buffer, drawBuffer, depth, stencil])=>answer(
            current()?.namedFramebuffer('glClearBufferfi', name >>> 0, false, false,
                [buffer >>> 0, drawBuffer | 0, asFloat(depth), stencil | 0])),
        glBlitNamedFramebuffer: a=>answer(current()?.glBlitNamedFramebuffer(a[0] >>> 0,
            a[1] >>> 0, [a[2] | 0, a[3] | 0, a[4] | 0, a[5] | 0, a[6] | 0, a[7] | 0, a[8] | 0,
                a[9] | 0, a[10] >>> 0, a[11] >>> 0])),
        glCheckNamedFramebufferStatus: ([name, target])=>current()
            ?.glCheckNamedFramebufferStatus(name >>> 0, target >>> 0) ?? 0,
        glGetNamedFramebufferAttachmentParameteriv: ([name, attachment, pname, out])=>call(
            context=>writeQuery(out, context.namedFramebuffer(
                'glGetFramebufferAttachmentParameteriv', name >>> 0, false, true,
                [attachment >>> 0, pname >>> 0]), 'word')),
        glNamedRenderbufferStorage: ([name, format, width, height])=>answer(current()
            ?.namedRenderbuffer('glRenderbufferStorageMultisample', name >>> 0,
                [0, format >>> 0, width | 0, height | 0])),
        glNamedRenderbufferStorageMultisample: ([name, samples, format, width, height])=>
            answer(current()?.namedRenderbuffer('glRenderbufferStorageMultisample', name >>> 0,
                [samples | 0, format >>> 0, width | 0, height | 0])),
        glGetNamedRenderbufferParameteriv: ([name, pname, out])=>call(context=>writeQuery(out,
            context.namedRenderbuffer('glGetRenderbufferParameteriv', name >>> 0,
                [pname >>> 0]), 'word')),

        // --- direct state access: samplers ---

        glCreateSamplers: creator((context, count)=>context.glCreateSamplers(count)),
    };
}
