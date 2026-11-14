#ifndef _LOCALE_H
#define _LOCALE_H
struct lconv { char *decimal_point; };
struct lconv *localeconv(void);
#endif
