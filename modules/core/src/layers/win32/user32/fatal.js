/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Which of a program's message boxes report that it is going down, as against
 * the boxes it asks or tells through and goes on after.
 *
 * Two signs, neither a title's words:
 *
 * - The process has already handed an exception to the error reporting client
 *   (faultrep's ReportFault): a crash handler's own box comes after that, the
 *   .NET runtime's "Application Error" among them, whatever icon it carries
 *   (MB_ICONEXCLAMATION for the runtime's).
 * - The box is drawn as the system's own fatal ones are: the stop icon,
 *   modal to the whole task or system rather than to a window of the
 *   program's - the style of the hard-error box an unhandled exception raises
 *   and of the C runtime's "Runtime Error!" before abort. A program's ordinary
 *   error box is modal to its own window (MB_APPLMODAL, zero).
 */

const MB_ICONMASK = 0x00f0;
const MB_ICONHAND = 0x0010;
const MB_SYSTEMMODAL = 0x1000;
const MB_TASKMODAL = 0x2000;

/**
 * @param {number} type  The box's MB_ flags.
 * @param {boolean} faultReported  Whether the process has reported a fault.
 */
export function isFatalBox(type, faultReported){
    return faultReported || ((type & MB_ICONMASK) === MB_ICONHAND
        && (type & (MB_SYSTEMMODAL | MB_TASKMODAL)) !== 0);
}
