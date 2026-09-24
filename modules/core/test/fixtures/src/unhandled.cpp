/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/* A C++ exception nothing catches: the process ends with its code. */

#include "rt.h"

struct Problem { int what; };

extern "C" int mainCRTStartup()
{
    say("throwing\r\n");
    throw Problem{ 1 };
}
