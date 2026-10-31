/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An OpenGL 2.0 program built by `make-pe.mjs`: it finds the version's
 * functions with wglGetProcAddress, as OPENGL32.dll exports 1.1 alone;
 * compiles and links a GLSL program, sets its uniforms (through the command
 * ring's routines); draws a red quad into the lower left quarter of a
 * texture attached to a framebuffer object with a depth renderbuffer; then
 * draws the whole window sampling that texture, swaps, and dumps what it was
 * answered (`OUT`) to the console as hex. Run by `gl-glsl.itest.js` on the
 * recording device and by `cdp_test/triangle.mjs --glsl` on a real one.
 *
 * Dev tooling: never imported by a package.
 */

import { buildExe } from './make-pe.mjs';
import {
    dumpAndExit, floatBits, importsWith, setupCode, setupData, storeEax, u32,
} from './gl-program.mjs';

const GL = {
    TEXTURE_2D: 0x0de1, TEXTURE_MIN_FILTER: 0x2801, LINEAR: 0x2601, RGBA: 0x1908,
    UNSIGNED_BYTE: 0x1401, FLOAT: 0x1406, VERTEX_SHADER: 0x8b31, FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81, LINK_STATUS: 0x8b82, FRAMEBUFFER: 0x8d40, RENDERBUFFER: 0x8d41,
    COLOR_ATTACHMENT0: 0x8ce0, DEPTH_STENCIL_ATTACHMENT: 0x821a, DEPTH24_STENCIL8: 0x88f0,
    COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x100, TRIANGLE_FAN: 6,
};

export const VS = `#version 120
uniform mat4 projection;
uniform mat4 modelview;
attribute vec2 vTex;
attribute vec4 vColor;
attribute vec3 vPosition;
varying vec4 color;
varying vec2 texCoord;
void main()
{
  color = vColor;
  texCoord = vTex;
  gl_Position = projection * modelview * vec4(vPosition, 1.0);
}
`;
export const FS = `#version 120
uniform sampler2D texture;
uniform bool useTexture;
varying vec4 color;
varying vec2 texCoord;
void main()
{
  vec4 outColor = color;
  if (useTexture) {
    outColor *= texture2D(texture, texCoord);
  }
  gl_FragColor = outColor;
}
`;

/** What the version gives, found through wglGetProcAddress. */
const PROCS = ['glCreateShader', 'glShaderSource', 'glCompileShader', 'glGetShaderiv',
    'glCreateProgram', 'glAttachShader', 'glBindAttribLocation', 'glLinkProgram',
    'glGetProgramiv', 'glUseProgram', 'glGetUniformLocation', 'glUniform1i',
    'glUniformMatrix4fv', 'glGenFramebuffers', 'glBindFramebuffer', 'glFramebufferTexture2D',
    'glGenRenderbuffers', 'glBindRenderbuffer', 'glRenderbufferStorage',
    'glFramebufferRenderbuffer', 'glCheckFramebufferStatus', 'glVertexAttribPointer',
    'glEnableVertexAttribArray'];

/** Where each answer is in the dumped blob. */
export const OUT = { vs: 0, fs: 4, link: 8, framebuffer: 12, error: 16, projection: 20,
    useTexture: 24, procs: 28, SIZE: 32 };

/** @param {string} text */
const cstring = text=>[...new TextEncoder().encode(text), 0];

export function glslProgram(){
    /** @type {Record<string, number[]>} */
    const names = Object.fromEntries(PROCS.map(name=>[`n_${name}`, cstring(name)]));
    /** @type {Record<string, number[]>} */
    const slots = Object.fromEntries(PROCS.map(name=>[`p_${name}`, [0, 0, 0, 0]]));
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const quad = [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]].flatMap(
        ([x, y, s, t])=>[...u32(floatBits(x)), ...u32(floatBits(y)), ...u32(0),
            0xff, 0x00, 0x00, 0xff, ...u32(floatBits(s)), ...u32(floatBits(t))]);
    return buildExe({
        imports: importsWith({
            'OPENGL32.dll': ['wglGetProcAddress', 'glGenTextures', 'glBindTexture',
                'glTexParameteri', 'glTexImage2D', 'glViewport', 'glClear', 'glDrawArrays',
                'glGetError'],
        }),
        codeSize: 0x1000,
        data: {
            ...setupData(),
            ...names,
            ...slots,
            out: new Array(OUT.SIZE).fill(0),
            hex: new Array(OUT.SIZE * 2).fill(0),
            vsText: cstring(VS),
            fsText: cstring(FS),
            vsPointer: [0, 0, 0, 0],
            fsPointer: [0, 0, 0, 0],
            names: [...cstring('vPosition'), ...cstring('vColor'), ...cstring('vTex')],
            uniformNames: [...cstring('projection'), ...cstring('modelview'),
                ...cstring('useTexture')],
            matrix: identity.flatMap(value=>u32(floatBits(value))),
            quad,
            vs: [0, 0, 0, 0], fs: [0, 0, 0, 0], prog: [0, 0, 0, 0], tex: [0, 0, 0, 0],
            fbo: [0, 0, 0, 0], rb: [0, 0, 0, 0], loc: [0, 0, 0, 0],
        },
        code: ({ iat, at })=>{
            /** @param {number | { mem: number }} value */
            const arg = value=>(typeof value === 'number' ? [0x68, ...u32(value >>> 0)]
                : [0xff, 0x35, ...u32(value.mem)]);
            /** @param {(number | { mem: number })[]} args */
            const push = args=>[...args].reverse().flatMap(arg);
            /** @param {string} name @param {(number | { mem: number })[]} [args] */
            const proc = (name, args = [])=>[...push(args), 0xff, 0x15, ...u32(at(`p_${name}`))];
            /** @param {string} name @param {(number | { mem: number })[]} [args] */
            const gl = (name, args = [])=>[...push(args), 0xff, 0x15, ...u32(iat(name))];
            /** @param {string} name */
            const mem = name=>({ mem: at(name) });
            const out = (/** @type {number} */ offset)=>at('out') + offset;
            const uniformName = (/** @type {number} */ k)=>at('uniformNames')
                + ['projection', 'modelview'].slice(0, k).reduce((sum, n)=>sum + n.length + 1, 0);
            const attributeName = (/** @type {number} */ k)=>at('names')
                + ['vPosition', 'vColor'].slice(0, k).reduce((sum, n)=>sum + n.length + 1, 0);
            return [
                ...setupCode(iat, at),
                // The version's functions; a null one is counted.
                ...PROCS.flatMap(name=>[
                    ...gl('wglGetProcAddress', [at(`n_${name}`)]),
                    ...storeEax(at(`p_${name}`)),
                    0x85, 0xc0, 0x75, 0x06, 0xff, 0x05, ...u32(out(OUT.procs)),
                ]),
                // The shaders, the program.
                0xc7, 0x05, ...u32(at('vsPointer')), ...u32(at('vsText')),
                0xc7, 0x05, ...u32(at('fsPointer')), ...u32(at('fsText')),
                ...proc('glCreateShader', [GL.VERTEX_SHADER]), ...storeEax(at('vs')),
                ...proc('glShaderSource', [mem('vs'), 1, at('vsPointer'), 0]),
                ...proc('glCompileShader', [mem('vs')]),
                ...proc('glGetShaderiv', [mem('vs'), GL.COMPILE_STATUS, out(OUT.vs)]),
                ...proc('glCreateShader', [GL.FRAGMENT_SHADER]), ...storeEax(at('fs')),
                ...proc('glShaderSource', [mem('fs'), 1, at('fsPointer'), 0]),
                ...proc('glCompileShader', [mem('fs')]),
                ...proc('glGetShaderiv', [mem('fs'), GL.COMPILE_STATUS, out(OUT.fs)]),
                ...proc('glCreateProgram'), ...storeEax(at('prog')),
                ...proc('glAttachShader', [mem('prog'), mem('vs')]),
                ...proc('glAttachShader', [mem('prog'), mem('fs')]),
                ...[0, 1, 2].flatMap(k=>proc('glBindAttribLocation',
                    [mem('prog'), k, attributeName(k)])),
                ...proc('glLinkProgram', [mem('prog')]),
                ...proc('glGetProgramiv', [mem('prog'), GL.LINK_STATUS, out(OUT.link)]),
                ...proc('glUseProgram', [mem('prog')]),
                // The uniforms, through the ring.
                ...proc('glGetUniformLocation', [mem('prog'), uniformName(0)]),
                ...storeEax(out(OUT.projection)), ...storeEax(at('loc')),
                ...proc('glUniformMatrix4fv', [mem('loc'), 1, 0, at('matrix')]),
                ...proc('glGetUniformLocation', [mem('prog'), uniformName(1)]),
                ...storeEax(at('loc')),
                ...proc('glUniformMatrix4fv', [mem('loc'), 1, 0, at('matrix')]),
                ...proc('glGetUniformLocation', [mem('prog'), uniformName(2)]),
                ...storeEax(out(OUT.useTexture)), ...storeEax(at('loc')),
                ...proc('glUniform1i', [mem('loc'), 0]),
                // The texture, the framebuffer and its depth.
                ...gl('glGenTextures', [1, at('tex')]),
                ...gl('glBindTexture', [GL.TEXTURE_2D, mem('tex')]),
                ...gl('glTexParameteri', [GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR]),
                ...gl('glTexImage2D', [GL.TEXTURE_2D, 0, GL.RGBA, 32, 16, 0, GL.RGBA,
                    GL.UNSIGNED_BYTE, 0]),
                ...gl('glBindTexture', [GL.TEXTURE_2D, 0]),
                ...proc('glGenFramebuffers', [1, at('fbo')]),
                ...proc('glBindFramebuffer', [GL.FRAMEBUFFER, mem('fbo')]),
                ...proc('glFramebufferTexture2D', [GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0,
                    GL.TEXTURE_2D, mem('tex'), 0]),
                ...proc('glGenRenderbuffers', [1, at('rb')]),
                ...proc('glBindRenderbuffer', [GL.RENDERBUFFER, mem('rb')]),
                ...proc('glRenderbufferStorage', [GL.RENDERBUFFER, GL.DEPTH24_STENCIL8, 32, 16]),
                ...proc('glFramebufferRenderbuffer', [GL.FRAMEBUFFER, GL.DEPTH_STENCIL_ATTACHMENT,
                    GL.RENDERBUFFER, mem('rb')]),
                ...proc('glCheckFramebufferStatus', [GL.FRAMEBUFFER]),
                ...storeEax(out(OUT.framebuffer)),
                // The quad's arrays.
                ...proc('glVertexAttribPointer', [0, 3, GL.FLOAT, 0, 24, at('quad')]),
                ...proc('glVertexAttribPointer', [1, 4, GL.UNSIGNED_BYTE, 1, 24, at('quad') + 12]),
                ...proc('glVertexAttribPointer', [2, 2, GL.FLOAT, 0, 24, at('quad') + 16]),
                ...[0, 1, 2].flatMap(k=>proc('glEnableVertexAttribArray', [k])),
                // Into the texture, then the window sampling it.
                // The quad covers the lower left quarter of the texture alone,
                // the rest cleared black: the window shows the quarter where
                // GL puts it only when the texture is neither flipped nor
                // mirrored on its way.
                ...gl('glViewport', [0, 0, 16, 8]),
                ...gl('glClear', [GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT]),
                ...gl('glDrawArrays', [GL.TRIANGLE_FAN, 0, 4]),
                ...proc('glBindFramebuffer', [GL.FRAMEBUFFER, 0]),
                ...gl('glViewport', [0, 0, 320, 240]),
                ...proc('glUniform1i', [mem('loc'), 1]),
                ...gl('glBindTexture', [GL.TEXTURE_2D, mem('tex')]),
                ...gl('glDrawArrays', [GL.TRIANGLE_FAN, 0, 4]),
                ...push([mem('hdc')]), 0xff, 0x15, ...u32(iat('SwapBuffers')),
                ...gl('glGetError'), ...storeEax(out(OUT.error)),
                ...dumpAndExit(iat, at, 'out', OUT.SIZE),
            ];
        },
    });
}

/**
 * The window's pixels, 320x240 from its top: red in its lower left quarter,
 * where the quad was drawn in the texture, black elsewhere; each away from
 * the edges a linear filter blends.
 */
export const GLSL_SAMPLES = Object.freeze([
    { name: 'drawn-lower-left', x: 80, y: 180, colour: 0xffff0000 },
    { name: 'cleared-upper-left', x: 80, y: 60, colour: 0xff000000 },
    { name: 'cleared-lower-right', x: 240, y: 180, colour: 0xff000000 },
    { name: 'cleared-upper-right', x: 240, y: 60, colour: 0xff000000 },
]);
