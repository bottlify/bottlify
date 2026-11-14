/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a piece of work cost this thread, for a test that compares two costs
 * or bounds one: the processor time the thread spent, not the wall time it
 * took. The two are the same on an idle machine; on one other processes keep
 * busy the wall time stretches by however long the thread waited for a core,
 * and a bound on it, or a ratio of two of them taken at different moments,
 * follows the machine's load rather than the code.
 */

/** Milliseconds of processor time this thread has spent so far, user and system. */
export function threadCpuMs(){
    const { user, system } = process.threadCpuUsage();
    return (user + system) / 1000;
}
