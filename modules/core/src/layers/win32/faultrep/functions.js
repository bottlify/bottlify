/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * faultrep — Windows Error Reporting's client library, as XP shipped it.
 *
 * A program's own crash handler imports ReportFault to hand its exception to
 * the error reporting client (dwwin.exe), which shows the "send a report"
 * dialog. This machine has no such client: the answer is the documented one
 * for a client that could not be started, and the handler goes on to whatever
 * it does after a report.
 */

/** EFaultRepRetVal's frrvErrNoDW: the reporting client could not be launched. */
export const FRRV_ERR_NO_DW = 4;

export function createFaultrepFunctions(){
    return {
        /** EFaultRepRetVal ReportFault(LPEXCEPTION_POINTERS pep, DWORD dwMode) */
        ReportFault: { argBytes: 8, handler: ()=>FRRV_ERR_NO_DW },
    };
}
