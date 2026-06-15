#!/usr/bin/env python3
"""
render_dst.py — render a DST's actual stitch geometry, layer by layer, so we can
SEE alignment independent of any viewer's color guessing.

- Each color block (split on COLOR_CHANGE) drawn in a distinct colour.
- Sewn stitches = solid lines; JUMP/TRIM travels = thin RED dashed = defects.
Usage: python3 render_dst.py IN.dst OUT.png [scale_px_per_mm]
"""
import sys
import pyembroidery as pe
from PIL import Image, ImageDraw

PALETTE = [(0,0,0),(200,30,30),(30,120,220),(20,160,60),(220,150,0),
           (150,40,200),(0,170,170),(230,90,160),(120,90,40),(90,90,90),
           (180,180,0),(0,90,200)]

def render(inp, outp, ppmm=4.0):
    patt = pe.read(inp)
    cmds = patt.stitches
    xs=[c[0] for c in cmds if c[2]==pe.STITCH]; ys=[c[1] for c in cmds if c[2]==pe.STITCH]
    minx,miny,maxx,maxy=min(xs),min(ys),max(xs),max(ys)
    sc = ppmm/10.0   # 0.1mm units -> px
    W=int((maxx-minx)*sc)+40; H=int((maxy-miny)*sc)+40
    img=Image.new("RGB",(W,H),(245,245,245)); d=ImageDraw.Draw(img)
    def P(x,y): return (int((x-minx)*sc)+20, int((y-miny)*sc)+20)

    ci=0; last=None; lastcmd=None
    travels=0
    for x,y,c in cmds:
        if c==pe.COLOR_CHANGE: ci+=1; last=None; lastcmd=c; continue
        if c in (pe.STITCH,):
            if last is not None and lastcmd==pe.STITCH:
                d.line([P(*last),P(x,y)], fill=PALETTE[ci%len(PALETTE)], width=1)
            last=(x,y); lastcmd=c
        elif c in (pe.JUMP,pe.TRIM):
            if last is not None:
                a,b=P(*last),P(x,y)
                # draw travels as thin red so defects are obvious
                d.line([a,b], fill=(255,0,0), width=1)
                travels+=1
            last=(x,y); lastcmd=c
        else:
            last=(x,y); lastcmd=c
    img.save(outp)
    print(f"rendered {outp}  ({W}x{H}px, {ppmm}px/mm)  colorblocks~{ci+1}  travel-lines(red)={travels}")

if __name__=="__main__":
    inp=sys.argv[1]; outp=sys.argv[2]; ppmm=float(sys.argv[3]) if len(sys.argv)>3 else 4.0
    render(inp,outp,ppmm)
