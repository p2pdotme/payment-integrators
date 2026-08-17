"""The drip ledger.

Every daily cap in `policy.py` is a question about this table. SQLite because
the write rate is one row per funded wallet per few hours and the read is a
sum over one UTC day — anything larger would be pretence.

Rows are never deleted. A faucet that forgets what it paid out is a faucet
whose caps can be reset by restarting it.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from dataclasses import dataclass

_SCHEMA = """
CREATE TABLE IF NOT EXISTS drips (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    chain_id   INTEGER NOT NULL,
    wallet     TEXT    NOT NULL,
    nullifier  TEXT,
    amount_wei TEXT    NOT NULL,
    tx_hash    TEXT
);
CREATE INDEX IF NOT EXISTS drips_wallet_ts ON drips (wallet, ts);
CREATE INDEX IF NOT EXISTS drips_nullifier_ts ON drips (nullifier, ts);
CREATE INDEX IF NOT EXISTS drips_ts ON drips (ts);
"""


def utc_day_start(now: int | None = None) -> int:
    """Midnight UTC for the day containing `now`.

    The same day boundary the integrator's own daily counter uses
    (`block.timestamp / 1 days`), so "5 orders today" and "N drips today" can
    never disagree about which day it is.
    """
    stamp = int(time.time()) if now is None else now
    return stamp - (stamp % 86_400)


@dataclass(frozen=True)
class Usage:
    wallet_drips: int
    wallet_wei: int
    nullifier_wei: int
    global_wei: int


class Store:
    def __init__(self, path: str) -> None:
        # check_same_thread=False + an explicit lock: uvicorn runs handlers on
        # a threadpool, and the alternative (a connection per request) loses
        # SQLite's write serialisation right where it matters.
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(_SCHEMA)
            self._conn.commit()

    def usage(self, *, wallet: str, nullifier: str | None, now: int | None = None) -> Usage:
        """Everything the policy needs to know about today, in one trip."""
        since = utc_day_start(now)
        wallet = wallet.lower()
        with self._lock:
            cur = self._conn.execute(
                "SELECT COUNT(*), COALESCE(SUM(CAST(amount_wei AS INTEGER)), 0) "
                "FROM drips WHERE wallet = ? AND ts >= ?",
                (wallet, since),
            )
            wallet_drips, wallet_wei = cur.fetchone()

            nullifier_wei = 0
            if nullifier:
                cur = self._conn.execute(
                    "SELECT COALESCE(SUM(CAST(amount_wei AS INTEGER)), 0) "
                    "FROM drips WHERE nullifier = ? AND ts >= ?",
                    (nullifier.lower(), since),
                )
                (nullifier_wei,) = cur.fetchone()

            cur = self._conn.execute(
                "SELECT COALESCE(SUM(CAST(amount_wei AS INTEGER)), 0) "
                "FROM drips WHERE ts >= ?",
                (since,),
            )
            (global_wei,) = cur.fetchone()

        return Usage(
            wallet_drips=int(wallet_drips),
            wallet_wei=int(wallet_wei),
            nullifier_wei=int(nullifier_wei),
            global_wei=int(global_wei),
        )

    def nullifier_for(self, wallet: str) -> str | None:
        """The identity this wallet was last funded under, if we ever knew it.

        The per-identity cap is only enforced when a request carries an
        attestation — and `attestation` is optional, chosen by the caller. So
        omitting one field was a way to opt out of the cap entirely and spend a
        second, uncounted wallet allowance.

        The ledger already holds the mapping, written by the cold-start drip
        that was paid for under that very nullifier. Carrying it forward costs
        one indexed lookup and closes the hole.
        """
        wallet = wallet.lower()
        with self._lock:
            cur = self._conn.execute(
                "SELECT nullifier FROM drips "
                "WHERE wallet = ? AND nullifier IS NOT NULL "
                "ORDER BY id DESC LIMIT 1",
                (wallet,),
            )
            row = cur.fetchone()
        return row[0] if row else None

    def record(
        self,
        *,
        chain_id: int,
        wallet: str,
        nullifier: str | None,
        amount_wei: int,
        tx_hash: str | None,
        now: int | None = None,
    ) -> None:
        """Book a drip.

        Called even when the receipt wait times out. Recording a transaction
        that may not have landed only makes the faucet stingier; forgetting one
        that did lets the caps be walked straight through.
        """
        with self._lock:
            self._conn.execute(
                "INSERT INTO drips (ts, chain_id, wallet, nullifier, amount_wei, tx_hash) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    int(time.time()) if now is None else now,
                    chain_id,
                    wallet.lower(),
                    nullifier.lower() if nullifier else None,
                    str(amount_wei),
                    tx_hash,
                ),
            )
            self._conn.commit()
