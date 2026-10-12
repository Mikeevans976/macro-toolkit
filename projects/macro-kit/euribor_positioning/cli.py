"""
CLI for the Euribor positioning tracker.

Commands:
  init            Initialise (or re-initialise) the SQLite database.
  ingest-eod      Ingest an ICE EOD settlement file.
  ingest-cot      Ingest an ICE COT report file.
  check           Run §4.8 integrity checks.
  simulate        Populate DB with synthetic data for testing.
  contracts seed  Seed the contracts table from the built-in calendar.
"""

import datetime
import sys
import argparse
from pathlib import Path

from .data.db import init_db, connect, load_params, get_db_path
from .data.contract_calendar import generate_contracts
from .data.ingest_ice_eod import ingest_eod_file, simulate_eod_data
from .data.ingest_ice_cot import ingest_cot_file, simulate_cot_data
from .data.ingest_bloomberg import ingest_bloomberg_eod
from .tests.test_integrity import run_all_checks


def cmd_init(args, params):
    db_path = get_db_path(params)
    init_db(db_path)


def cmd_seed_contracts(args, params):
    db_path = get_db_path(params)
    root = params["contracts"]["euribor_root"]
    start_year = int(args.start_year)
    end_year   = int(args.end_year)
    include_serials = not args.quarterly_only

    contracts = generate_contracts(root, start_year, end_year, include_serials)
    if args.estr:
        estr_root = params["contracts"]["estr_root"]
        contracts += generate_contracts(estr_root, start_year, end_year, include_serials=False)

    with connect(db_path) as conn:
        conn.executemany(
            """INSERT OR IGNORE INTO contracts
               (contract_id, root, expiry_date, last_trading_day, contract_type, listing_date)
               VALUES (:contract_id, :root, :expiry_date, :last_trading_day, :contract_type, :listing_date)""",
            contracts,
        )
    print(f"Seeded {len(contracts)} contracts ({start_year}-{end_year})")


def cmd_ingest_eod(args, params):
    trade_date = datetime.date.fromisoformat(args.trade_date)
    stats = ingest_eod_file(args.file, trade_date, db_path=get_db_path(params), params=params)
    print(f"EOD ingest: inserted={stats['inserted']} updated={stats['updated']} "
          f"skipped={stats['skipped']} errors={len(stats['errors'])}")
    for e in stats["errors"]:
        print(f"  ERROR: {e}", file=sys.stderr)


def cmd_ingest_cot(args, params):
    report_date = datetime.date.fromisoformat(args.report_date)
    stats = ingest_cot_file(args.file, report_date, db_path=get_db_path(params), params=params)
    print(f"COT ingest: inserted={stats['inserted']} updated={stats['updated']} "
          f"skipped={stats['skipped']} errors={len(stats['errors'])}")
    for e in stats["errors"]:
        print(f"  ERROR: {e}", file=sys.stderr)


def cmd_ingest_bloomberg(args, params):
    trade_date = datetime.date.fromisoformat(args.trade_date)
    stats = ingest_bloomberg_eod(trade_date, db_path=get_db_path(params), params=params)
    print(f"Bloomberg EOD ingest: inserted={stats['inserted']} updated={stats['updated']} "
          f"skipped={stats['skipped']} errors={len(stats['errors'])}")
    for e in stats["errors"]:
        print(f"  ERROR: {e}", file=sys.stderr)


def cmd_check(args, params):
    db_path = get_db_path(params)
    as_of = datetime.date.fromisoformat(args.as_of) if args.as_of else None
    with connect(db_path) as conn:
        results = run_all_checks(conn, as_of_date=as_of, raise_on_failure=False)
    all_pass = True
    for check, violations in results.items():
        status = "PASS" if not violations else "FAIL"
        print(f"  [{status}] {check}")
        for v in violations:
            print(f"         {v}", file=sys.stderr)
            all_pass = False
    if all_pass:
        print("All §4.8 integrity checks passed.")
        sys.exit(0)
    else:
        print("INTEGRITY CHECK FAILURES -- do not use this data.", file=sys.stderr)
        sys.exit(1)


def cmd_simulate(args, params):
    db_path = get_db_path(params)
    start = datetime.date.fromisoformat(args.start)
    end   = datetime.date.fromisoformat(args.end)
    root  = params["contracts"]["euribor_root"]

    contracts = generate_contracts(root, start.year - 1, end.year + 1, include_serials=False)
    with connect(db_path) as conn:
        conn.executemany(
            """INSERT OR IGNORE INTO contracts
               (contract_id, root, expiry_date, last_trading_day, contract_type, listing_date)
               VALUES (:contract_id, :root, :expiry_date, :last_trading_day, :contract_type, :listing_date)""",
            contracts,
        )

    simulate_eod_data(start, end, contracts, params, db_path=db_path)
    simulate_cot_data(start, end, params, db_path=db_path)
    print(f"Simulation complete: {start} to {end} at {db_path}")


def main():
    params = load_params()

    parser = argparse.ArgumentParser(
        prog="euribor-positioning",
        description="Euribor Futures Positioning Tracker -- Stage 1 CLI",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # init
    sub.add_parser("init", help="Initialise the SQLite database")

    # seed-contracts
    p_seed = sub.add_parser("seed-contracts", help="Populate the contracts table")
    p_seed.add_argument("--start-year", default="2010")
    p_seed.add_argument("--end-year", default="2030")
    p_seed.add_argument("--quarterly-only", action="store_true")
    p_seed.add_argument("--estr", action="store_true", help="Also seed ESTR contracts")

    # ingest-eod
    p_eod = sub.add_parser("ingest-eod", help="Ingest an ICE EOD settlement file")
    p_eod.add_argument("file")
    p_eod.add_argument("--trade-date", required=True, help="YYYY-MM-DD")

    # ingest-bloomberg
    p_bbg = sub.add_parser("ingest-bloomberg", help="Fetch EOD data from Bloomberg Terminal")
    p_bbg.add_argument("--trade-date", required=True, help="YYYY-MM-DD")

    # ingest-cot
    p_cot = sub.add_parser("ingest-cot", help="Ingest an ICE COT report")
    p_cot.add_argument("file")
    p_cot.add_argument("--report-date", required=True, help="Tuesday YYYY-MM-DD")

    # check
    p_chk = sub.add_parser("check", help="Run §4.8 integrity checks")
    p_chk.add_argument("--as-of", help="YYYY-MM-DD cutoff (optional)")

    # simulate
    p_sim = sub.add_parser("simulate", help="Populate DB with synthetic test data")
    p_sim.add_argument("--start", default="2024-01-02")
    p_sim.add_argument("--end", default="2025-12-31")

    args = parser.parse_args()

    dispatch = {
        "init":              cmd_init,
        "seed-contracts":    cmd_seed_contracts,
        "ingest-bloomberg":  cmd_ingest_bloomberg,
        "ingest-eod":        cmd_ingest_eod,
        "ingest-cot":        cmd_ingest_cot,
        "check":             cmd_check,
        "simulate":          cmd_simulate,
    }
    dispatch[args.command](args, params)


if __name__ == "__main__":
    main()
