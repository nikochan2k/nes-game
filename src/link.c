#include "link.h"
#include "worldgen.h"

void link_fetch(unsigned x, unsigned y, unsigned char vertical,
                unsigned char len, unsigned char *buf)
{
    unsigned char i;
    for (i = 0; i < len; ++i) {
        buf[i] = worldgen_cell(vertical ? x : x + i, vertical ? y + i : y);
    }
}
