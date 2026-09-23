/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * A native harness for zstd.c: decodes one file into another so the decoder
 * can be judged on a machine with any C compiler before it is built to wasm.
 *
 *   driver <in.zst> <out.bin> <capacity> [repeat]
 *
 * Prints the decoder's answer (bytes written, or the negative code) and, with
 * a repeat count, the milliseconds the decode loop took, so the decoder's own
 * speed can be read apart from the file traffic. Exits 0 when it decoded, 1
 * otherwise. Not part of the wasm build.
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <time.h>

int32_t zstd_decompress(const uint8_t* in, uint32_t inLength, uint8_t* out, uint32_t outCapacity);

int main(int argc, char** argv){
    FILE* f;
    long size;
    uint8_t* in;
    uint8_t* out;
    uint32_t capacity;
    int32_t answer = 0;
    int repeat = 1, i;
    clock_t started;
    if (argc != 4 && argc != 5)
    {
        fprintf(stderr, "usage: driver <in.zst> <out.bin> <capacity> [repeat]\n");
        return 2;
    }
    f = fopen(argv[1], "rb");
    if (!f) { perror(argv[1]); return 2; }
    fseek(f, 0, SEEK_END);
    size = ftell(f);
    fseek(f, 0, SEEK_SET);
    in = (uint8_t*)malloc(size > 0 ? (size_t)size : 1);
    if (size > 0 && fread(in, 1, (size_t)size, f) != (size_t)size) { perror("read"); return 2; }
    fclose(f);
    capacity = (uint32_t)strtoul(argv[3], NULL, 10);
    if (argc == 5) repeat = atoi(argv[4]);
    out = (uint8_t*)malloc(capacity > 0 ? capacity : 1);
    started = clock();
    for (i = 0; i < repeat; i++)
    {
        answer = zstd_decompress(in, (uint32_t)size, out, capacity);
    }
    printf("%d\n", answer);
    if (argc == 5)
    {
        printf("ms %.2f\n", (double)(clock() - started) * 1000.0 / CLOCKS_PER_SEC / repeat);
    }
    if (answer < 0) return 1;
    f = fopen(argv[2], "wb");
    if (!f) { perror(argv[2]); return 2; }
    fwrite(out, 1, (size_t)answer, f);
    fclose(f);
    return 0;
}
