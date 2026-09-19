/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * msacm32 — the Audio Compression Manager, behind which this machine has no
 * codec drivers.
 *
 * Audio middleware of the era links against it statically, so the library
 * has to load for the middleware to load at all -- every exported entry
 * point is declared with its stack width, whether or not anything answers
 * it. What is answered is what a machine with no ACM drivers installed
 * answers: no version to speak of beyond the manager's own, no drivers to
 * enumerate, and a conversion stream that cannot be opened because nothing
 * converts. Middleware that asks (an MP3 decoder probe at initialisation)
 * takes the refusal and uses its own decoder, as it does on such a machine.
 */

/** The manager reports itself as version 4.0 with no driver-specific build. */
const ACM_VERSION = 0x04000000;
/** MMSYSERR_NOTSUPPORTED: the function is not supported here. */
const MMSYSERR_NOTSUPPORTED = 8;
/** ACMERR_NOTPOSSIBLE: no driver can perform the requested conversion. */
const ACMERR_NOTPOSSIBLE = 0x200 + 3;

/**
 * An entry point of `argBytes` stack bytes answering `result`.
 *
 * @param {number} argCount  dword arguments
 * @param {number} result
 */
const answers = (argCount, result)=>({ argBytes: argCount * 4, handler: ()=>result });

/**
 * @param {Record<string, { argBytes: number, handler: () => number }>} into
 * @param {string} base  the name without its A/W suffix
 * @param {number} argCount
 * @param {number} result
 */
const addPair = (into, base, argCount, result)=>{
    into[`${base}A`] = answers(argCount, result);
    into[`${base}W`] = answers(argCount, result);
};

export function createAcmFunctions(){
    /** @type {Record<string, { argBytes: number, handler: () => number }>} */
    const functions = {
        /** DWORD acmGetVersion(void) */
        acmGetVersion: answers(0, ACM_VERSION),
        /** MMRESULT acmMetrics(HACMOBJ hao, UINT uMetric, LPVOID pMetric) */
        acmMetrics: answers(3, MMSYSERR_NOTSUPPORTED),

        // Drivers: none installed, so nothing to enumerate, open or address.
        acmDriverEnum: answers(3, MMSYSERR_NOTSUPPORTED),
        acmDriverOpen: answers(3, MMSYSERR_NOTSUPPORTED),
        acmDriverClose: answers(2, MMSYSERR_NOTSUPPORTED),
        acmDriverID: answers(3, MMSYSERR_NOTSUPPORTED),
        acmDriverMessage: answers(4, MMSYSERR_NOTSUPPORTED),
        acmDriverPriority: answers(3, MMSYSERR_NOTSUPPORTED),
        acmDriverRemove: answers(2, MMSYSERR_NOTSUPPORTED),

        // Format negotiation and conversion streams: no driver, no conversion.
        acmFormatSuggest: answers(5, ACMERR_NOTPOSSIBLE),
        /**
         * MMRESULT acmStreamOpen(LPHACMSTREAM phas, HACMDRIVER had, LPWAVEFORMATEX pwfxSrc,
         *     LPWAVEFORMATEX pwfxDst, LPWAVEFILTER pwfltr, DWORD_PTR dwCallback,
         *     DWORD_PTR dwInstance, DWORD fdwOpen)
         */
        acmStreamOpen: answers(8, ACMERR_NOTPOSSIBLE),
        acmStreamClose: answers(2, MMSYSERR_NOTSUPPORTED),
        acmStreamConvert: answers(3, MMSYSERR_NOTSUPPORTED),
        acmStreamMessage: answers(4, MMSYSERR_NOTSUPPORTED),
        acmStreamPrepareHeader: answers(3, MMSYSERR_NOTSUPPORTED),
        acmStreamReset: answers(2, MMSYSERR_NOTSUPPORTED),
        acmStreamSize: answers(4, MMSYSERR_NOTSUPPORTED),
        acmStreamUnprepareHeader: answers(3, MMSYSERR_NOTSUPPORTED),
    };
    addPair(functions, 'acmDriverAdd', 5, MMSYSERR_NOTSUPPORTED);
    addPair(functions, 'acmDriverDetails', 3, MMSYSERR_NOTSUPPORTED);
    addPair(functions, 'acmFormatChoose', 1, MMSYSERR_NOTSUPPORTED);
    addPair(functions, 'acmFormatDetails', 3, MMSYSERR_NOTSUPPORTED);
    addPair(functions, 'acmFormatEnum', 5, MMSYSERR_NOTSUPPORTED);
    addPair(functions, 'acmFormatTagDetails', 3, MMSYSERR_NOTSUPPORTED);
    addPair(functions, 'acmFormatTagEnum', 5, MMSYSERR_NOTSUPPORTED);
    addPair(functions, 'acmFilterChoose', 1, MMSYSERR_NOTSUPPORTED);
    addPair(functions, 'acmFilterDetails', 3, MMSYSERR_NOTSUPPORTED);
    addPair(functions, 'acmFilterEnum', 5, MMSYSERR_NOTSUPPORTED);
    addPair(functions, 'acmFilterTagDetails', 3, MMSYSERR_NOTSUPPORTED);
    addPair(functions, 'acmFilterTagEnum', 5, MMSYSERR_NOTSUPPORTED);
    return functions;
}
