#ifndef _STDIO_H
#define _STDIO_H
#include <stddef.h>
#include <stdarg.h>
typedef struct FILE FILE;
extern FILE *stdin, *stdout, *stderr;
#define EOF (-1)
#define BUFSIZ 512
#define L_tmpnam 20
int sprintf(char *s, const char *fmt, ...);
int snprintf(char *s, size_t n, const char *fmt, ...);
int vsnprintf(char *s, size_t n, const char *fmt, va_list ap);
int vsprintf(char *s, const char *fmt, va_list ap);
int fprintf(FILE *f, const char *fmt, ...);
int printf(const char *fmt, ...);
int fputs(const char *s, FILE *f);
int fputc(int c, FILE *f);
int putchar(int c);
size_t fwrite(const void *p, size_t s, size_t n, FILE *f);
size_t fread(void *p, size_t s, size_t n, FILE *f);
int fflush(FILE *f);
FILE *fopen(const char *p, const char *m);
FILE *freopen(const char *p, const char *m, FILE *f);
int fclose(FILE *f);
int getc(FILE *f);
int ungetc(int c, FILE *f);
int feof(FILE *f);
int ferror(FILE *f);
char *fgets(char *s, int n, FILE *f);
#endif
