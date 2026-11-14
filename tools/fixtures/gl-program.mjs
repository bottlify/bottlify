/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The pieces of an OpenGL program built by `make-pe.mjs`, for the tests that
 * drive OPENGL32 and GLU32 as a program does: a window, its DC, a pixel
 * format, a context made current; a call through the import table; and a
 * dump of a data blob to the console as hex, which the test reads back.
 *
 * Dev tooling, like `make-pe.mjs`: never imported by a package.
 */

/** @param {number} value */
export const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff,
    value >>> 24 & 0xff];

/** A float's bits. @param {number} value */
export const floatBits = value=>{
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    return view.getUint32(0, true);
};

/** A double's two words, low first. @param {number} value */
export const doubleWords = value=>{
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return [view.getUint32(0, true), view.getUint32(4, true)];
};

/** `push imm32` @param {number} value */
export const push = value=>[0x68, ...u32(value >>> 0)];

/** Pushes a call's arguments, given in C order, last first. @param {number[]} words */
export const pushArgs = words=>[...words].reverse().flatMap(push);

/**
 * `call [iat]`, the arguments pushed first.
 *
 * @param {(name: string) => number} iat @param {string} name @param {number[]} [words]
 */
export const call = (iat, name, words = [])=>[...pushArgs(words), 0xff, 0x15, ...u32(iat(name))];

/** `mov [address], eax` @param {number} address */
export const storeEax = address=>[0xa3, ...u32(address)];

/** What a program that makes a context imports for it. */
export const SETUP_IMPORTS = {
    'USER32.dll': ['RegisterClassA', 'CreateWindowExA', 'DefWindowProcA', 'GetDC'],
    'GDI32.dll': ['ChoosePixelFormat', 'SetPixelFormat', 'SwapBuffers'],
    'OPENGL32.dll': ['wglCreateContext', 'wglMakeCurrent'],
    'KERNEL32.dll': ['ExitProcess', 'GetStdHandle', 'WriteFile'],
};

/**
 * The imports of a program: the setup's and the ones given, merged.
 *
 * @param {Record<string, string[]>} more
 */
export const importsWith = more=>{
    /** @type {Record<string, string[]>} */
    const out = {};
    for (const [dll, names] of [...Object.entries(SETUP_IMPORTS), ...Object.entries(more)])
    {
        out[dll] = [...new Set([...out[dll] ?? [], ...names])];
    }
    return out;
};

/** The data blobs the setup and the dump use. */
export const setupData = ()=>{
    const pfd = new Array(40).fill(0);
    pfd[0] = 40;
    pfd[2] = 1;
    // PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER, 32-bit colour, 24-bit depth.
    pfd.splice(4, 4, ...u32(0x25));
    pfd[9] = 32;
    pfd[23] = 24;
    pfd[24] = 8;
    return {
        className: [...'BottlifyGl'].map(c=>c.charCodeAt(0)).concat(0),
        wndclass: new Array(40).fill(0),
        pfd,
        hdc: [0, 0, 0, 0],
        hglrc: [0, 0, 0, 0],
        written: [0, 0, 0, 0],
        digits: [...'0123456789abcdef'].map(c=>c.charCodeAt(0)),
    };
};

/**
 * A window, its DC, a pixel format, and a context made current: the DC in
 * `hdc`, the context in `hglrc`.
 *
 * @param {(name: string) => number} iat @param {(name: string) => number} at
 * @returns {number[]}
 */
export const setupCode = (iat, at)=>[
    0xa1, ...u32(iat('DefWindowProcA')), 0xa3, ...u32(at('wndclass') + 4),
    0xc7, 0x05, ...u32(at('wndclass') + 36), ...u32(at('className')),
    ...call(iat, 'RegisterClassA', [at('wndclass')]),
    ...call(iat, 'CreateWindowExA', [0, at('className'), at('className'), 0x00cf0000, 0, 0, 320,
        240, 0, 0, 0, 0]),
    0x50, 0xff, 0x15, ...u32(iat('GetDC')), ...storeEax(at('hdc')),
    ...push(at('pfd')), 0x50, 0xff, 0x15, ...u32(iat('ChoosePixelFormat')),
    ...push(at('pfd')), 0x50, 0xff, 0x35, ...u32(at('hdc')), 0xff, 0x15,
    ...u32(iat('SetPixelFormat')),
    0xff, 0x35, ...u32(at('hdc')), 0xff, 0x15, ...u32(iat('wglCreateContext')),
    ...storeEax(at('hglrc')),
    0x50, 0xff, 0x35, ...u32(at('hdc')), 0xff, 0x15, ...u32(iat('wglMakeCurrent')),
];

/**
 * The bytes of a blob to the console as hex, then ExitProcess(0).
 *
 * @param {(name: string) => number} iat @param {(name: string) => number} at
 * @param {string} blob @param {number} length  How many of its bytes.
 * @param {string} [hex]  Where the text is put together: a blob of twice the length.
 */
export const dumpAndExit = (iat, at, blob, length, hex = 'hex')=>{
    const byte = [
        0x0f, 0xb6, 0x06, 0x89, 0xc2, 0xc1, 0xe8, 0x04, 0x83, 0xe2, 0x0f,
        0x8a, 0x80, ...u32(at('digits')), 0x88, 0x07,
        0x8a, 0x92, ...u32(at('digits')), 0x88, 0x57, 0x01,
        0x46, 0x83, 0xc7, 0x02, 0x49,
    ];
    return [
        0xbe, ...u32(at(blob)), 0xbf, ...u32(at(hex)), 0xb9, ...u32(length),
        ...byte, 0x75, 0x100 - byte.length - 2,
        ...push(0), ...push(at('written')), ...push(length * 2), ...push(at(hex)),
        0x6a, 0xf5, 0xff, 0x15, ...u32(iat('GetStdHandle')), 0x50,
        0xff, 0x15, ...u32(iat('WriteFile')),
        ...call(iat, 'ExitProcess', [0]),
    ];
};

/** The console's hex back into bytes. @param {string} text */
export const bytesOfHex = text=>{
    const bytes = new Uint8Array(text.length >> 1);
    for (let i = 0; i < bytes.length; i++)
    {
        bytes[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
};
