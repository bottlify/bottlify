#ifndef _SETJMP_H
#define _SETJMP_H
#ifdef __x86_64__
/* rbx, rbp, r12-r15, rsp and the return address (setjmp64.S). */
typedef long long jmp_buf[8];
#else
typedef int jmp_buf[6];
#endif
int setjmp(jmp_buf b) __attribute__((returns_twice));
void longjmp(jmp_buf b, int v) __attribute__((noreturn));
#endif
