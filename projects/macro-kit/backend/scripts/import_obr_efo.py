"""Import an OBR Economic and fiscal outlook PDF into backend/data/obr/ (or a folder).

    python scripts/import_obr_efo.py <efo.pdf> [--url <page>] [--out <dir>]

The PDF is on obr.uk and on GOV.UK (assets.publishing.service.gov.uk); obr.uk blocks
scripts, so download it in a browser. The page's "Upload" button does the same.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import fiscal_data as fd  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", type=Path)
    ap.add_argument("--url", default="")
    ap.add_argument("--out", type=Path, default=fd.DATA_DIR / "obr")
    args = ap.parse_args()
    efo = fd.parse_efo_pdf(args.pdf, args.url)
    args.out.mkdir(parents=True, exist_ok=True)
    stamp = fd._edition_date(efo["edition"]).strftime("%Y-%m")
    path = args.out / f"efo_{stamp}.json"
    path.write_text(json.dumps(efo, indent=1), encoding="utf-8")
    print(f"{efo['edition']}: {len(efo['years'])} years ({efo['years'][0]} to {efo['years'][-1]}) → {path}")


if __name__ == "__main__":
    main()
