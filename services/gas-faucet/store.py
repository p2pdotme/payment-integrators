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

    def record_fee(self, tx_hash: str, fee_wei: int) -> None:
        """Book what a drip's transaction actually cost, once the receipt says.

        Written after the fact because the true fee (gasUsed x
        effectiveGasPrice) only exists once the transfer is mined. A drip whose
        receipt never arrives keeps a NULL fee — a bounded gap, one in-flight
        transaction wide, and always in the conservative direction is wrong:
        under-booking. The clamps in chain.py bound how far.
        """
        with self._lock:
            self._conn.execute(
                "UPDATE drips SET fee_wei = ? WHERE tx_hash = ?",
                (str(fee_wei), tx_hash),
            )
            self._conn.commit()

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
