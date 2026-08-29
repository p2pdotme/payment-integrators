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
    fee_wei    TEXT,
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
            try:
                # Ledgers written before fees were booked lack the column.
                self._conn.execute("ALTER TABLE drips ADD COLUMN fee_wei TEXT")
            except sqlite3.OperationalError:
                pass  # already present
            self._conn.commit()

    # What a row COSTS, not just what it sent. Fees are booked after the
    # receipt lands, so a cap that ignored them would let real spend exceed
    # booked spend by an amount the recipient's own receive() code influences.
    #
    # SQLite integers are 64-bit signed (max ~9.2e18 wei, ~9.2 ETH). Every sum
    # here is bounded by the caps it feeds, which sit orders of magnitude
    # below that, so CAST cannot overflow while the caps hold.
    _SPENT = "CAST(amount_wei AS INTEGER) + COALESCE(CAST(fee_wei AS INTEGER), 0)"

    def usage(
        self,
        *,
        wallet: str,
        nullifier: str | None,
        chain_id: int | None = None,
        now: int | None = None,
    ) -> Usage:
        """Everything the policy needs to know about today, in one trip.

        `chain_id` scopes the per-wallet and per-nullifier sums: the same
        address exists on every chain with independent balances, so pooling a
        wallet's allowance across chains would under-fund a legitimate
        cross-chain user. The GLOBAL sum is deliberately unscoped — one process
        holds one key and one float, and the circuit breaker protects the
        float, which every chain draws from.
        """
        since = utc_day_start(now)
        wallet = wallet.lower()
        chain_filter = " AND chain_id = ?" if chain_id is not None else ""
        chain_args: tuple = (chain_id,) if chain_id is not None else ()
        with self._lock:
            # COUNT only rows that MOVED value. A sponsored submission books
            # amount_wei=0 (its fee still sums below), and counting it against
            # max_drips_per_wallet meant every sponsored user started the day
            # with 3 of their documented 4 drips.
            cur = self._conn.execute(
                f"SELECT "
                f"COALESCE(SUM(CASE WHEN CAST(amount_wei AS INTEGER) > 0 THEN 1 ELSE 0 END), 0), "
                f"COALESCE(SUM({self._SPENT}), 0) "
                f"FROM drips WHERE wallet = ? AND ts >= ?{chain_filter}",
                (wallet, since, *chain_args),
            )
            wallet_drips, wallet_wei = cur.fetchone()

            nullifier_wei = 0
            if nullifier:
                cur = self._conn.execute(
                    f"SELECT COALESCE(SUM({self._SPENT}), 0) "
                    f"FROM drips WHERE nullifier = ? AND ts >= ?{chain_filter}",
                    (nullifier.lower(), since, *chain_args),
                )
                (nullifier_wei,) = cur.fetchone()

            cur = self._conn.execute(
                f"SELECT COALESCE(SUM({self._SPENT}), 0) FROM drips WHERE ts >= ?",
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
        """The identity this wallet was enrolled under, from its sponsor row.

        The per-identity budget in policy.decide was severed when the
        cold-start drip path was deleted — every usage() call passed
        nullifier=None, making identity_daily_budget_reached unreachable and
        its env knob a silently inert setting. Sponsored submissions DO record
        the nullifier, so the mapping exists; this recalls it for the drip
        path, and the knob means what it says again.
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

    def reserve(
        self,
        *,
        chain_id: int,
        wallet: str,
        nullifier: str | None,
        amount_wei: int,
        now: int | None = None,
    ) -> int:
        """Claim a drip's cap slot BEFORE the money moves. Returns its rowid.

        This is the whole point of the book-before-send order. Every cap is a
        SUM or COUNT over this table, so the row that will feed those caps has
        to exist before the ETH leaves, not after. If this write fails, the
        caller has learned the ledger is unavailable while nothing has been
        spent — so it refuses, and the caps stay intact.

        Booking AFTER the send (the old order) meant a write failure left the
        money gone and the ledger blind: reads kept returning stale sums, the
        policy saw room under every cap, and a read-only volume turned the
        faucet into an uncapped tap. An uncapped faucet is worse than an
        unavailable one, which is why a failure here must reach the caller.
        """
        with self._lock:
            cur = self._conn.execute(
                "INSERT INTO drips (ts, chain_id, wallet, nullifier, amount_wei, tx_hash) "
                "VALUES (?, ?, ?, ?, ?, NULL)",
                (
                    int(time.time()) if now is None else now,
                    chain_id,
                    wallet.lower(),
                    nullifier.lower() if nullifier else None,
                    str(amount_wei),
                ),
            )
            self._conn.commit()
            return int(cur.lastrowid)

    def release(self, drip_id: int) -> None:
        """Drop a reservation whose send never happened.

        Best-effort: if this fails the row simply stays, which over-counts by
        one drip until the UTC rollover — stingy, and stingy is the safe
        direction to fail.
        """
        with self._lock:
            self._conn.execute("DELETE FROM drips WHERE id = ?", (drip_id,))
            self._conn.commit()

    def attach_tx(self, drip_id: int, tx_hash: str) -> None:
        """Link the broadcast tx to its reserved row. The cap is already
        claimed, so a failure here costs only the hash linkage and the row's
        later fee."""
        with self._lock:
            self._conn.execute(
                "UPDATE drips SET tx_hash = ? WHERE id = ?", (tx_hash, drip_id)
            )
            self._conn.commit()

    def record_fee(self, drip_id: int, fee_wei: int) -> None:
        """Book what a drip's transaction actually cost, keyed by ITS ROW.

        By id, not by tx_hash: a hash-keyed UPDATE credits every row sharing a
        hash (there is no uniqueness constraint) and silently no-ops after a
        reservation whose tx was never attached. The fee only exists once the
        transfer mines; a receipt that never arrives leaves NULL, a bounded
        under-count the chain.py clamps bound.
        """
        # The caller clamps to what the signed transaction could have cost;
        # this is the ledger's own floor and ceiling — never negative, never
        # past the 64-bit integer the daily SUM is computed in.
        fee_wei = max(0, min(int(fee_wei), 2**63 - 1))
        with self._lock:
            self._conn.execute(
                "UPDATE drips SET fee_wei = ? WHERE id = ?", (str(fee_wei), drip_id)
            )
            self._conn.commit()
