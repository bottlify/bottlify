#ifndef _SETJMP_H
#define _SETJMP_H
typedef int jmp_buf[6];
int setjmp(jmp_buf b) __attribute__((returns_twice));
void longjmp(jmp_buf b, int v) __attribute__((noreturn));
#endif
