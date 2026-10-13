#ifndef _MATH_H
#define _MATH_H
#define HUGE_VAL (__builtin_huge_val())
double floor(double x); double ceil(double x); double fabs(double x); double fmod(double x, double y);
double pow(double x, double y); double sqrt(double x); double frexp(double x, int *e); double ldexp(double x, int e);
double sin(double x); double cos(double x); double tan(double x); double asin(double x); double acos(double x);
double atan(double x); double atan2(double y, double x); double exp(double x); double log(double x);
double log10(double x); double sinh(double x); double cosh(double x); double tanh(double x); double modf(double x, double *i);
#endif
