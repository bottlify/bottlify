/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The faces a program can ask for by name: the classic Windows ones, each
 * with the family a LOGFONT names it by.
 *
 * No font file ships. The font engine draws a face through the browser,
 * under its own name first and the generic family its LOGFONT family maps to
 * when the browser has no face of that name -- so this table is both what
 * EnumFontFamiliesEx lists and what the engine falls back on, and it lives
 * here, where both halves of gdi32 can read it.
 *
 * A substitute is a name Windows answers for with another face's -- a
 * registry FontSubstitutes entry. It is found when asked for by name and is
 * never listed among the faces.
 */

/** A LOGFONT's family, the high nibble of lfPitchAndFamily. */
export const FF_ROMAN = 0x10;
export const FF_SWISS = 0x20;
export const FF_MODERN = 0x30;

/** And its pitch, the low bits. */
export const FIXED_PITCH = 1;
export const VARIABLE_PITCH = 2;

/**
 * @typedef {Object} Face
 * @property {string} name
 * @property {number} family       FF_ROMAN, FF_SWISS or FF_MODERN.
 * @property {number} pitch        FIXED_PITCH or VARIABLE_PITCH.
 * @property {string} [substitute] The face a substitute's name stands for.
 */

/** @param {string} name @param {number} family @param {number} pitch @param {string} [substitute] */
const face = (name, family, pitch, substitute)=>Object.freeze({ name, family, pitch, substitute });

/** @type {readonly Face[]} */
export const FACES = Object.freeze([
    face('MS Sans Serif', FF_SWISS, VARIABLE_PITCH),
    face('Microsoft Sans Serif', FF_SWISS, VARIABLE_PITCH),
    face('MS Shell Dlg', FF_SWISS, VARIABLE_PITCH, 'Microsoft Sans Serif'),
    face('MS Shell Dlg 2', FF_SWISS, VARIABLE_PITCH, 'Tahoma'),
    face('Tahoma', FF_SWISS, VARIABLE_PITCH),
    face('Arial', FF_SWISS, VARIABLE_PITCH),
    face('Helv', FF_SWISS, VARIABLE_PITCH, 'MS Sans Serif'),
    face('Verdana', FF_SWISS, VARIABLE_PITCH),
    face('System', FF_SWISS, VARIABLE_PITCH),
    face('Segoe UI', FF_SWISS, VARIABLE_PITCH),
    face('Times New Roman', FF_ROMAN, VARIABLE_PITCH),
    face('MS Serif', FF_ROMAN, VARIABLE_PITCH),
    face('Georgia', FF_ROMAN, VARIABLE_PITCH),
    face('Courier New', FF_MODERN, FIXED_PITCH),
    face('Courier', FF_MODERN, FIXED_PITCH),
    face('Fixedsys', FF_MODERN, FIXED_PITCH),
    face('Terminal', FF_MODERN, FIXED_PITCH),
    face('Lucida Console', FF_MODERN, FIXED_PITCH),
]);

/**
 * A face by name, as GDI compares names: without regard to case.
 *
 * @param {string} name
 * @returns {Face | null}
 */
export function faceNamed(name){
    const wanted = name.toLowerCase();
    return FACES.find(entry=>entry.name.toLowerCase() === wanted) ?? null;
}

/**
 * What Windows measures for the faces dialogs are laid out in, at the sizes
 * they are laid out at (96 DPI): GetTextMetrics' answer, and the cell a
 * template's dialog units count in -- the alphabet's average width as the
 * dialog manager takes it, and the cell's height.
 *
 * The browser draws these faces with whatever it has in their place, and a
 * substitute's proportions are its own: a dialog sized from them is wider or
 * taller than the program drew its pictures for, and a skin painted for
 * Windows' size leaves the rest of the window bare. So for these requests the
 * measurements are Windows', whatever face draws the glyphs -- as Wine ships
 * faces made to Windows' metrics for the same reason. MS Sans Serif is a
 * bitmap face whose 8-point size is 13 pixels high; MS Shell Dlg and MS Shell
 * Dlg 2 are the TrueType faces of that size the shell's dialogs use, with the
 * same cell; the System font is the one a dialog without a font of its own
 * is counted in.
 *
 * @typedef {Object} WindowsMetrics
 * @property {number} height
 * @property {number} ascent
 * @property {number} descent
 * @property {number} internalLeading
 * @property {number} aveCharWidth
 * @property {{ width: number, height: number }} cell
 */

/** @type {WindowsMetrics} */
const DIALOG_8PT = Object.freeze({ height: 13, ascent: 11, descent: 2, internalLeading: 2,
    aveCharWidth: 5, cell: Object.freeze({ width: 6, height: 13 }) });
/** @type {WindowsMetrics} */
const SYSTEM_CELL = Object.freeze({ height: 16, ascent: 13, descent: 3, internalLeading: 3,
    aveCharWidth: 7, cell: Object.freeze({ width: 8, height: 16 }) });

/** The faces of DIALOG_8PT, substitutes resolved. */
const DIALOG_FACES = new Set(['ms sans serif', 'microsoft sans serif', 'tahoma']);

/**
 * Windows' measurements of a font, for the requests whose Windows answer is
 * known; null for every other, which the font engine or the estimate answers.
 *
 * @param {{ faceName: string, height: number, weight: number }} font
 * @returns {WindowsMetrics | null}
 */
export function windowsMetrics(font){
    const named = faceNamed(font.faceName ?? '');
    const resolved = (named?.substitute ?? named?.name ?? '').toLowerCase();
    const height = font.height | 0;
    const weight = font.weight || 400;
    if (DIALOG_FACES.has(resolved) && weight < 600 && (height === -11 || height === 13))
    {
        return DIALOG_8PT;
    }
    if (resolved === 'system' && (height === 16 || height === -13))
    {
        return SYSTEM_CELL;
    }
    return null;
}
