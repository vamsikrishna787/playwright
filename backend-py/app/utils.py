from __future__ import annotations

from datetime import datetime, timezone


def now_iso() -> str:
    """UTC timestamp in the exact shape JS `new Date().toISOString()` produces.

    The frontend parses these and existing runs.json rows use this format, so the
    millisecond precision and trailing `Z` both matter.
    """
    now = datetime.now(timezone.utc)
    return f"{now.strftime('%Y-%m-%dT%H:%M:%S')}.{now.microsecond // 1000:03d}Z"


def parse_iso(value: str) -> float:
    """Sortable epoch seconds for a stored timestamp.

    Anything unparseable sorts oldest rather than raising — these values order
    records for display, and one bad row should not break a listing.
    """
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except (ValueError, AttributeError, TypeError):
        return 0.0
