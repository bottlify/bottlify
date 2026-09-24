/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * What every fixture here needs and nothing more: console output through
 * kernel32, with no C runtime linked in, so the program exercises exactly the
 * imports it names.
 */

#pragma once

#ifdef __cplusplus
extern "C" {
#endif

__declspec(dllimport) void __stdcall ExitProcess(unsigned code);
__declspec(dllimport) void *__stdcall GetStdHandle(unsigned which);
__declspec(dllimport) int __stdcall WriteFile(void *file, const void *bytes, unsigned count,
    unsigned *written, void *overlapped);

static void say(const char *text)
{
    unsigned length = 0, written;
    while (text[length])
    {
        length++;
    }
    WriteFile(GetStdHandle((unsigned)-11), text, length, &written, 0);
}

/* One line per property, so a reader of a failed run sees which one. */
static int failures = 0;
static void check(const char *what, int ok)
{
    say(ok ? "ok   " : "FAIL ");
    say(what);
    say("\r\n");
    failures += !ok;
}

#ifdef __cplusplus
}
#endif
