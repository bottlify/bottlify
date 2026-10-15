#ifndef _STDLIB_H
#define _STDLIB_H
#include <stddef.h>
#define EXIT_SUCCESS 0
#define EXIT_FAILURE 1
#define RAND_MAX 0x7fff
void *malloc(size_t n);
void *calloc(size_t n, size_t s);
void *realloc(void *p, size_t n);
void free(void *p);
void abort(void) __attribute__((noreturn));
void exit(int c) __attribute__((noreturn));
double strtod(const char *s, char **end);
unsigned long strtoul(const char *s, char **end, int base);
long strtol(const char *s, char **end, int base);
char *getenv(const char *n);
int abs(int v);
long labs(long v);
int rand(void);
void srand(unsigned s);
#endif
