/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A thread's error mode in its two spellings: kernel32's SEM_* bits, which
 * GetThreadErrorMode answers, and ntdll's RTL_SEM_* bits, which the thread's
 * block holds and RtlGetThreadErrorMode answers.
 */

const SEM_FAILCRITICALERRORS = 0x0001;
const SEM_NOGPFAULTERRORBOX = 0x0002;
const SEM_NOOPENFILEERRORBOX = 0x8000;

/** The three a thread may have. */
export const THREAD_ERROR_MODES = SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX
    | SEM_NOOPENFILEERRORBOX;
/** RTL_SEM_FAILCRITICALERRORS, RTL_SEM_NOGPFAULTERRORBOX, RTL_SEM_NOOPENFILEERRORBOX. */
export const RTL_THREAD_ERROR_MODES = 0x70;

/** @type {[number, number][]} */
const PAIRS = [[SEM_FAILCRITICALERRORS, 0x10], [SEM_NOGPFAULTERRORBOX, 0x20],
    [SEM_NOOPENFILEERRORBOX, 0x40]];

/** @param {number} mode  SEM_* @returns {number} RTL_SEM_* */
export const toRtlMode = mode=>PAIRS.reduce((rtl, [sem, bit])=>rtl | (mode & sem ? bit : 0), 0);

/** @param {number} rtl  RTL_SEM_* @returns {number} SEM_* */
export const fromRtlMode = rtl=>PAIRS.reduce((mode, [sem, bit])=>mode | (rtl & bit ? sem : 0), 0);
