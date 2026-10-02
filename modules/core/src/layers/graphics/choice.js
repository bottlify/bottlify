/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The graphics a bottle prefers, and what choosing it leaves on the machine:
 * every DirectX up to the one named -- a machine with DirectX 9 has 7 and 8
 * inside it -- or OpenGL alone, and the DirectX release the registry, the
 * setup library and DxDiag name. A program that wants exactly one DirectX
 * finds it, and a start builds only the wrappers the choice has. No choice is
 * every library and DirectX 9.0c.
 */

/** @typedef {'directx7' | 'directx8' | 'directx9' | 'directx10' | 'opengl'} GraphicsChoice */

/**
 * @typedef {Object} GraphicsStack
 * @property {readonly string[]} libraries  The system libraries the bottle has.
 * @property {readonly string[]} apis       The roots the drawing layer builds.
 * @property {'7' | '8' | '9' | null} directx  The release reported; null keeps the default.
 */

/** DirectX 7 is DirectDraw, which carries Direct3D 7 and every one before it. */
const DIRECTX7 = { libraries: ['DDRAW.dll'], apis: ['ddraw'] };
const DIRECTX8 = {
    libraries: [...DIRECTX7.libraries, 'D3D8.dll'], apis: [...DIRECTX7.apis, 'd3d8'] };
const DIRECTX9 = {
    libraries: [...DIRECTX8.libraries, 'D3D9.dll'], apis: [...DIRECTX8.apis, 'd3d9'] };

/** @type {Readonly<Record<GraphicsChoice, GraphicsStack>>} */
export const GRAPHICS_CHOICES = Object.freeze({
    directx7: Object.freeze({ ...DIRECTX7, directx: '7' }),
    directx8: Object.freeze({ ...DIRECTX8, directx: '8' }),
    directx9: Object.freeze({ ...DIRECTX9, directx: '9' }),
    // Vista and later still report 9.0c in the registry.
    directx10: Object.freeze({
        libraries: [...DIRECTX9.libraries, 'D3D10.dll', 'D3D10_1.dll', 'DXGI.dll'],
        apis: [...DIRECTX9.apis, 'd3d10'], directx: '9' }),
    opengl: Object.freeze({ libraries: ['OPENGL32.dll', 'GLU32.dll'], apis: ['opengl'],
        directx: null }),
});

/**
 * The choice itself, or undefined for none. Anything else is refused, naming
 * the choices: a bottle set to graphics nobody knows is a configuration error,
 * not a machine with no graphics.
 *
 * @param {unknown} value
 * @returns {GraphicsChoice | undefined}
 */
export function graphicsChoice(value){
    if (value === undefined || value === null)
    {
        return undefined;
    }
    if (typeof value !== 'string' || !Object.hasOwn(GRAPHICS_CHOICES, value))
    {
        throw new Error(`unknown graphics choice ${JSON.stringify(value)}: `
            + `the choices are ${Object.keys(GRAPHICS_CHOICES).join(', ')}`);
    }
    return /** @type {GraphicsChoice} */ (value);
}
