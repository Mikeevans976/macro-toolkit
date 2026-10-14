"""
Contract calendar for ICE Euribor futures.

Contract ID format: {root}_{YYYY}{code}
  - root: "FEI" (Euribor) or "FEF" (ESTR)
  - YYYY: 4-digit year of expiry
  - code: H/M/U/Z for quarterly, B/G/J/K/N/Q/V/X for serial months
           (ICE uses standard CME month codes)

Month codes (CME/ICE standard):
  F=Jan, G=Feb, H=Mar, J=Apr, K=May, M=Jun
  N=Jul, Q=Aug, U=Sep, V=Oct, X=Nov, Z=Dec
"""

import datetime

MONTH_CODES = {
    1: "F", 2: "G", 3: "H", 4: "J", 5: "K", 6: "M",
    7: "N", 8: "Q", 9: "U", 10: "V", 11: "X", 12: "Z",
}
CODE_TO_MONTH = {v: k for k, v in MONTH_CODES.items()}
IMM_MONTHS = {3, 6, 9, 12}  # quarterly cycle


def make_contract_id(root: str, year: int, month: int) -> str:
    return f"{root}_{year}{MONTH_CODES[month]}"


def third_wednesday(year: int, month: int) -> datetime.date:
    """Return the 3rd Wednesday of the given year/month."""
    d = datetime.date(year, month, 1)
    # Find first Wednesday
    days_to_wed = (2 - d.weekday()) % 7  # Wednesday is weekday 2
    first_wed = d + datetime.timedelta(days=days_to_wed)
    return first_wed + datetime.timedelta(weeks=2)


def last_trading_day(expiry_year: int, expiry_month: int) -> datetime.date:
    """
    Last trading day = 2 business days before the 3rd Wednesday.
    Typically the Monday of that week.
    """
    edsp = third_wednesday(expiry_year, expiry_month)
    bd_count = 0
    d = edsp - datetime.timedelta(days=1)
    while bd_count < 2:
        if d.weekday() < 5:
            bd_count += 1
            if bd_count < 2:
                d -= datetime.timedelta(days=1)
        else:
            d -= datetime.timedelta(days=1)
    return d


def expiry_date(expiry_year: int, expiry_month: int) -> datetime.date:
    """Expiry = 3rd Wednesday (EDSP date)."""
    return third_wednesday(expiry_year, expiry_month)


def generate_contracts(
    root: str,
    start_year: int,
    end_year: int,
    include_serials: bool = True,
) -> list[dict]:
    """
    Generate all contracts from start_year to end_year inclusive.
    Returns list of dicts suitable for inserting into contracts table.
    """
    rows = []
    for year in range(start_year, end_year + 1):
        for month in range(1, 13):
            ctype = "quarterly" if month in IMM_MONTHS else "serial"
            if not include_serials and ctype == "serial":
                continue
            ltd = last_trading_day(year, month)
            exp = expiry_date(year, month)
            rows.append({
                "contract_id": make_contract_id(root, year, month),
                "root": root,
                "expiry_date": exp.isoformat(),
                "last_trading_day": ltd.isoformat(),
                "contract_type": ctype,
                "listing_date": None,
            })
    return rows


def parse_contract_id(contract_id: str) -> tuple[str, int, int]:
    """Parse 'FEI_2027H' -> ('FEI', 2027, 3)."""
    root, rest = contract_id.split("_", 1)
    year = int(rest[:4])
    code = rest[4]
    month = CODE_TO_MONTH[code]
    return root, year, month


def cot_publication_date(report_date: datetime.date) -> datetime.date:
    """
    COT report_date is the Tuesday the positions describe.
    It is published the following Friday.
    """
    days_to_friday = (4 - report_date.weekday()) % 7
    return report_date + datetime.timedelta(days=days_to_friday)
