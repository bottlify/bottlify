/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * VirtualAlloc and VirtualFree as a program drives them: a reservation placed
 * at an address it chose, pages committed and given back inside it, and every
 * refusal answered with the error Windows gives for it.
 */

#include "rt.h"

__declspec(dllimport) void *__stdcall VirtualAlloc(void *address, unsigned size, unsigned type,
    unsigned protect);
__declspec(dllimport) int __stdcall VirtualFree(void *address, unsigned size, unsigned type);
__declspec(dllimport) unsigned __stdcall GetLastError(void);
__declspec(dllimport) void __stdcall SetLastError(unsigned code);

#define MEM_COMMIT 0x1000
#define MEM_RESERVE 0x2000
#define MEM_DECOMMIT 0x4000
#define MEM_RELEASE 0x8000
#define MEM_RESET 0x80000
#define PAGE_READWRITE 0x04
#define ERROR_INVALID_PARAMETER 87
#define ERROR_INVALID_ADDRESS 487
#define GRANULE 0x10000
#define PAGE 0x1000

/* The call failed, and said why. */
static int refused(int result, unsigned error)
{
    return result == 0 && GetLastError() == error;
}

int mainCRTStartup(void)
{
    /* Somewhere known to be free: where a reservation just was. */
    char *first = (char *)VirtualAlloc(0, 4 * GRANULE, MEM_RESERVE, PAGE_READWRITE);
    check("a reservation anywhere", first && ((unsigned)first & (GRANULE - 1)) == 0);
    check("released", VirtualFree(first, 0, MEM_RELEASE));

    char *placed = (char *)VirtualAlloc(first + GRANULE + 0x234, 2 * PAGE, MEM_RESERVE,
        PAGE_READWRITE);
    check("placed where asked, on its granule", placed == first + GRANULE);
    check("its pages commit",
        VirtualAlloc(placed + PAGE, PAGE, MEM_COMMIT, PAGE_READWRITE) == placed + PAGE);
    placed[PAGE] = 42;
    check("and hold what is written", placed[PAGE] == 42);

    SetLastError(0);
    check("no reservation over another",
        refused(!!VirtualAlloc(placed, PAGE, MEM_RESERVE, PAGE_READWRITE), ERROR_INVALID_ADDRESS));
    check("no commit where nothing is reserved",
        refused(!!VirtualAlloc(first + 3 * GRANULE, PAGE, MEM_COMMIT, PAGE_READWRITE),
            ERROR_INVALID_ADDRESS));
    check("no type, no allocation",
        refused(!!VirtualAlloc(0, PAGE, 0, PAGE_READWRITE), ERROR_INVALID_PARAMETER));
    check("reset takes nothing else",
        refused(!!VirtualAlloc(placed, PAGE, MEM_RESET | MEM_COMMIT, PAGE_READWRITE),
            ERROR_INVALID_PARAMETER));
    check("reset keeps the pages",
        VirtualAlloc(placed + PAGE, PAGE, MEM_RESET, PAGE_READWRITE) == placed + PAGE);

    char *both = (char *)VirtualAlloc(first + 2 * GRANULE, PAGE, MEM_RESERVE | MEM_COMMIT,
        PAGE_READWRITE);
    check("reserved and committed at once", both == first + 2 * GRANULE && both[0] == 0);

    check("a decommit inside the reservation", VirtualFree(placed + PAGE, PAGE, MEM_DECOMMIT));
    VirtualAlloc(placed + PAGE, PAGE, MEM_COMMIT, PAGE_READWRITE);
    check("and a page given back comes back zero", placed[PAGE] == 0);

    check("release with a size",
        refused(VirtualFree(placed, PAGE, MEM_RELEASE), ERROR_INVALID_PARAMETER));
    check("release from inside",
        refused(VirtualFree(placed + PAGE, 0, MEM_RELEASE), ERROR_INVALID_ADDRESS));
    check("release and decommit both",
        refused(VirtualFree(placed, 0, MEM_RELEASE | MEM_DECOMMIT), ERROR_INVALID_PARAMETER));
    check("released by its base", VirtualFree(placed, 0, MEM_RELEASE)
        && VirtualFree(both, 0, MEM_RELEASE));
    check("and not twice", refused(VirtualFree(placed, 0, MEM_RELEASE), ERROR_INVALID_ADDRESS));

    ExitProcess(failures);
    return 0;
}
