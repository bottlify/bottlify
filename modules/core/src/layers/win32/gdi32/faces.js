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
