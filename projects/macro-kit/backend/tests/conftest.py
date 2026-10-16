"""Shared test setup.

Tests snapshot the simulated/CSV data, so pin the data source before any
backend module imports settings: a developer's .env may say bloomberg.
Some tools (egb_rv, momentum, print_analysis) call Bloomberg whatever the
data source says, so also point bbg at a closed port: on a machine with a
Terminal running they would otherwise pull live data into the snapshots.
"""

import os

os.environ["ANALYTICS_DATA_SOURCE"] = "csv"
os.environ["BBG_PORT"] = "1"
