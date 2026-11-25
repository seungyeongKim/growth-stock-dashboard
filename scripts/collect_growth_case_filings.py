"""Download exact public reports without logging a private OpenDART key."""

import argparse
import io
import json
import os
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from scan_market_growth import DART, DART_ENGLISH, fetch, parallel


CASES = {
    'soop': {'prior': '20181109000417', 'base': '20191113000456', 'later': '20241114001271'},
    'me2on': {'prior': '20181114001696', 'base': '20191114002336', 'later': '20241114002937'},
    'neooto': {'prior': '20201113000204', 'base': '20211112001142', 'later': '20261113000537'},
    'nara': {'prior': '20201116000960', 'base': '20211115001222', 'later': '20261113000859'},
    'skhynix': {'base': '20211115001474', 'later': '20261116001715'},
    'kinx': {'base': '20191114001256', 'later': '20241114001491'},
}


def collect(key, case, stage, receipt, directory):
    attempts = []
    for base in (DART, DART_ENGLISH):
        try:
            body = fetch(base + '/document.xml', {'crtfc_key': key, 'rcept_no': receipt}, attempts=2, timeout=24)
            if not zipfile.is_zipfile(io.BytesIO(body)):
                root = ET.fromstring(body)
                attempts.append(root.findtext('status') or 'not-zip')
                continue
            name = f'{case}-{stage}-{receipt}.zip'
            (directory / name).write_bytes(body)
            return {'case': case, 'stage': stage, 'receipt': receipt, 'file': name, 'bytes': len(body)}
        except (RuntimeError, ET.ParseError):
            attempts.append('unavailable')
    return {'case': case, 'stage': stage, 'receipt': receipt, 'status': attempts}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    key = os.environ.get('DART_API_KEY') or os.environ.get('OPENDART_API_KEY')
    if not key:
        raise SystemExit('DART_API_KEY is required')
    args.directory.mkdir(parents=True, exist_ok=True)
    inputs = [(case, stage, receipt) for case, reports in CASES.items() for stage, receipt in reports.items()]
    results = parallel(lambda r: collect(key, *r, args.directory), inputs, workers=4)
    (args.directory / 'manifest.json').write_text(json.dumps(results, indent=2) + '\n', encoding='utf-8')
    print(f'{sum("file" in row for row in results)}/{len(results)} public filings downloaded', flush=True)


if __name__ == '__main__':
    main()
