# tools/ — DST quality harness

Independent quality measurement for Stichai output, so the engine can't grade
its own homework. Decoder = **pyembroidery** (`pip install pyembroidery`),
not Stichai's own export code.

## dst_qa.py
Decode a DST and report the metrics that separate good embroidery from pro:
density (st/mm^2, hull + bbox), stitch-length distribution (min/p5/median/mean/p95/max),
travel & jump load, and long-run (>7mm "slash") risk.

```bash
python3 tools/dst_qa.py FILE.dst [FILE2.dst ...]
python3 tools/dst_qa.py --benchmark pro.dst yours.dst   # side-by-side
```

Reference target (from pro zambi_3_8_in.DST, decoded in a prior session):
density ~3.9 st/mm^2, stitch length p5=0.81mm .. max=10mm. Stichai is currently ~2.0.

## gen_test_dst.js
Builds a KNOWN synthetic fill, runs it through the REAL `lib/export.js encodeDST`,
and writes a .dst the harness can validate (encoder + decoder round-trip check).
Requires a `sharp` module to resolve `lib/image.js`'s require (a local dev stub in
node_modules/sharp is fine — the encode path never calls sharp).

```bash
node tools/gen_test_dst.js && python3 tools/dst_qa.py tools/_test_stichai.dst
```
