"""DXF 검사 (11단계): ezdxf로 읽고 검사(audit)한 뒤 치수 요약을 JSON으로 출력한다.
사용: python3 scripts/check_dxf.py 도면.dxf
"""
import json
import sys

import ezdxf
from ezdxf import recover

doc, auditor = recover.readfile(sys.argv[1])
msp = doc.modelspace()
dims = []
for e in msp.query("DIMENSION"):
    blk = e.get_geometry_block()
    dims.append({
        "type": e.dimtype & 7 if (e.dimtype & 7) != 6 else 6,
        "raw": e.dimtype,
        "text": e.dxf.get("text", ""),
        "block": e.dxf.geometry,
        "blockEntities": len(blk) if blk is not None else -1,
    })
print(json.dumps({
    "version": doc.dxfversion,
    "errors": [str(x.message) for x in auditor.errors],
    "fixes": len(auditor.fixes),
    "insunits": doc.header.get("$INSUNITS"),
    "dims": dims,
    "lines": len(msp.query("LINE")),
    "texts": [t.dxf.text for t in msp.query("TEXT")][:80],
}, ensure_ascii=False))
