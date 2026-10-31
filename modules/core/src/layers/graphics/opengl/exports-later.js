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

/**
 * @param {LaterHelpers} h
 * @returns {Record<string, (args: number[]) => number>}
 */
export function laterEntryPoints(h){
    const { current, call, answer, readTyped, writeU32s, writeQuery } = h;

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
        glGetAttachedShaders: ([program, most, countOut, out])=>call(context=>{
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
        }),
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

        // --- occlusion queries ---

        glGenQueries: generator((context, count)=>context.glGenQueries(count)),
        glDeleteQueries: deleter((context, names)=>context.glDeleteQueries(names)),
        glIsQuery: ([name])=>current()?.glIsQuery(name >>> 0) ?? GL.FALSE,
        glBeginQuery: ([target, name])=>answer(current()?.glBeginQuery(target >>> 0, name >>> 0)),
        glEndQuery: ([target])=>answer(current()?.glEndQuery(target >>> 0)),
        glGetQueryiv: ([target, pname, out])=>call(context=>writeQuery(out,
            context.glGetQueryiv(target >>> 0, pname >>> 0), 'word')),
        glGetQueryObjectiv: ([name, pname, out])=>call(context=>writeQuery(out,
            context.glGetQueryObject(name >>> 0, pname >>> 0), 'word')),
        glGetQueryObjectuiv: ([name, pname, out])=>call(context=>writeQuery(out,
            context.glGetQueryObject(name >>> 0, pname >>> 0), 'word')),

        // --- 3D textures, by their target and size ---

        glTexImage3D: a=>answer(current()?.texImage3D('glTexImage3D', a[0] >>> 0, a[1] | 0,
            a[3] | 0, a[4] | 0, a[5] | 0)),
        glTexSubImage3D: a=>answer(current()?.texImage3D('glTexSubImage3D', a[0] >>> 0,
            a[1] | 0, a[5] | 0, a[6] | 0, a[7] | 0)),
        glCopyTexSubImage3D: a=>answer(current()?.texImage3D('glCopyTexSubImage3D', a[0] >>> 0,
            a[1] | 0, a[7] | 0, a[8] | 0, 1)),
    };

    /**
     * glGetActiveAttrib and glGetActiveUniform: a name, a size and a type.
     *
     * @param {number[]} args @param {'glGetActiveAttrib' | 'glGetActiveUniform'} which
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

    // glUniform{1234}{fi} and their vector forms, and the matrices.
    for (const n of [1, 2, 3, 4])
    {
        for (const kind of /** @type {const} */ (['f', 'i']))
        {
            const decode = kind === 'f' ? asFloat : (/** @type {number} */ w)=>w | 0;
            handlers[`glUniform${n}${kind}`] = args=>{
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
            handlers[`glUniform${n}${kind}v`] = ([location, count, address])=>call(context=>
                context.uniform(location | 0, count | 0,
                    (count | 0) > 0 ? readTyped(kind === 'f' ? 'f' : 'i', address,
                        (count | 0) * n) : [], kind, n));
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
    return handlers;
}

