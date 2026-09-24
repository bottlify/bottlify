/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * The C runtime's variables, imported as data: the standard streams as the
 * records of `_iob`, the system version the runtime keeps, `HUGE_VAL`, and the
 * environment `main` is handed.
 */

#include "rt.h"

typedef struct { char *ptr; int cnt; char *base; int flag; int file; int charbuf; int bufsiz;
    char *tmpfname; } FILE;

__declspec(dllimport) extern FILE _iob[];
__declspec(dllimport) extern unsigned _osver, _winver, _winmajor, _winminor;
__declspec(dllimport) extern double _HUGE;
__declspec(dllimport) extern char **_environ;
__declspec(dllimport) int __cdecl fprintf(FILE *stream, const char *format, ...);
__declspec(dllimport) unsigned __cdecl fwrite(const void *data, unsigned size, unsigned count,
    FILE *stream);
__declspec(dllimport) unsigned __cdecl fread(void *data, unsigned size, unsigned count,
    FILE *stream);
__declspec(dllimport) FILE *__cdecl __iob_func(void);
__declspec(dllimport) unsigned __stdcall GetVersion(void);

int mainCRTStartup(void)
{
    check("stdin, stdout and stderr name their descriptors",
        _iob[0].file == 0 && _iob[1].file == 1 && _iob[2].file == 2);
    check("__iob_func is the same array", __iob_func() == _iob);
    check("fprintf to stdout reaches the console",
        fprintf(&_iob[1], "%s %d\r\n", "to stdout", 1) == 13);
    check("fwrite to stdout reaches the console", fwrite("written\r\n", 1, 9, &_iob[1]) == 9);
    char byte;
    check("stdin is at its end", fread(&byte, 1, 1, &_iob[0]) == 0);

    unsigned version = GetVersion();
    check("_winmajor and _winminor are GetVersion's",
        _winmajor == (version & 0xff) && _winminor == (version >> 8 & 0xff));
    check("_winver is the two together", _winver == (_winmajor << 8 | _winminor));
    check("_osver is the build", _osver == version >> 16);
    check("_HUGE is infinity", _HUGE > 1e308 && _HUGE == _HUGE * 2);
    check("_environ is a vector, however short", _environ != 0);

    ExitProcess(failures);
    return 0;
}
