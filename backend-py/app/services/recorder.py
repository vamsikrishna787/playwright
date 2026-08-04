"""Headed recording: a human walks the flow, we inventory every page they land on.

Each session owns one worker thread that holds the browser for its whole life,
because Playwright's sync API must stay on the thread that created it. HTTP
handlers only read the session state that thread publishes, under a lock.
"""

from __future__ import annotations

import asyncio
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Literal

from playwright.sync_api import Page, sync_playwright

from ..utils import now_iso
from .actions import CAPTURE_INIT_JS, RecordedAction
from .explorer import PageReport, capture_page

SessionStatus = Literal["recording", "finished", "error"]

#: Sessions left open forever would keep a browser and its memory alive.
MAX_SESSION_SECONDS = 30 * 60

#: How long the POST waits for the first page to be inventoried before answering.
FIRST_CAPTURE_TIMEOUT = 90.0

_TICK_MS = 250


@dataclass
class RecordingSession:
    id: str
    start_url: str
    status: SessionStatus
    pages: list[PageReport] = field(default_factory=list)
    #: What the human actually did, in order — the script is generated from this.
    actions: list[RecordedAction] = field(default_factory=list)
    error: str | None = None
    started_at: str = ""


@dataclass
class _Control:
    stop: threading.Event
    ready: threading.Event
    thread: threading.Thread | None = None
    launch_error: str | None = None


#: Live sessions, keyed by id. Recordings are short-lived and in-memory only.
_sessions: dict[str, RecordingSession] = {}
_controls: dict[str, _Control] = {}
_lock = threading.Lock()


def get_session(session_id: str) -> RecordingSession | None:
    with _lock:
        return _sessions.get(session_id)


def discard_session(session_id: str) -> None:
    with _lock:
        _sessions.pop(session_id, None)
        _controls.pop(session_id, None)


def _dismiss(dialog: Any) -> None:
    try:
        dialog.dismiss()
    except Exception:
        pass


def _store_page(session: RecordingSession, report: PageReport) -> None:
    # Re-landing on a page we already have (a redirect settling, or the user
    # going back) should refresh it rather than add a duplicate block.
    with _lock:
        for index, existing in enumerate(session.pages):
            if existing.url == report.url:
                session.pages[index] = report
                return
        session.pages.append(report)


def _capture(session: RecordingSession, target: Page) -> None:
    if session.status != "recording" or target.is_closed():
        return
    try:
        _store_page(session, capture_page(target, interact=False))
    except Exception:
        # A page that navigated mid-capture is normal while a human clicks around.
        pass


def _finish(session: RecordingSession, status: SessionStatus, error: str | None = None) -> None:
    with _lock:
        if session.status != "recording":
            return
        session.status = status
        if error:
            session.error = error


def _drive(session: RecordingSession, control: _Control) -> None:
    """Owns the browser for the session's whole life. Runs on its own thread."""
    try:
        with sync_playwright() as playwright:
            try:
                browser = playwright.chromium.launch(
                    headless=False, args=["--start-maximized"]
                )
            except Exception as err:
                control.launch_error = str(err)
                control.ready.set()
                return

            try:
                context = browser.new_context(no_viewport=True)

                # The page calls this on every click/fill/select. Like the load
                # handler below it only appends — no Playwright calls from inside.
                def on_action(_source: Any, payload: dict[str, Any]) -> None:
                    if session.status != "recording":
                        return
                    if (action := RecordedAction.from_payload(payload)) is not None:
                        with _lock:
                            session.actions.append(action)

                context.expose_binding("__pwRecordAction", on_action)
                # Installed before any page script runs, and re-applied on every
                # navigation, so actions keep being captured across page changes.
                context.add_init_script(CAPTURE_INIT_JS)

                # Handlers only record which page needs capturing. Calling into
                # Playwright from inside a sync event handler can deadlock, so the
                # actual capture happens on the pump loop below.
                pending: list[Page] = []

                def watch(target: Page) -> None:
                    target.on("load", lambda loaded: pending.append(loaded))
                    target.on("dialog", _dismiss)

                def on_new_page(opened: Page) -> None:
                    # Links that open a new tab are part of the journey too.
                    watch(opened)
                    pending.append(opened)

                context.on("page", on_new_page)

                page = context.new_page()
                watch(page)

                try:
                    page.goto(session.start_url, wait_until="domcontentloaded", timeout=30_000)
                    _capture(session, page)
                except Exception as err:
                    _finish(session, "error", str(err))
                    return
                finally:
                    control.ready.set()

                deadline = time.monotonic() + MAX_SESSION_SECONDS

                while not control.stop.is_set() and browser.is_connected():
                    if time.monotonic() >= deadline:
                        _finish(session, "finished", "Recording timed out after 30 minutes.")
                        return

                    while pending:
                        _capture(session, pending.pop(0))

                    live = next((p for p in context.pages if not p.is_closed()), None)
                    if live is None:
                        break
                    try:
                        # A real Playwright call, so queued page events get dispatched.
                        live.wait_for_timeout(_TICK_MS)
                    except Exception:
                        break

                # Stopped from the UI with the window still open: refresh whatever
                # screen the user ended on, so the last step of the flow is recorded.
                if browser.is_connected():
                    live = next((p for p in context.pages if not p.is_closed()), None)
                    if live is not None:
                        _capture(session, live)

                _finish(session, "finished")
            finally:
                control.ready.set()
                try:
                    browser.close()
                except Exception:
                    pass
    except Exception as err:  # pragma: no cover - the driver itself failed
        _finish(session, "error", str(err))
        control.ready.set()


async def start_recording(start_url: str) -> RecordingSession:
    """Opens a visible browser and inventories every page the user lands on.

    The human drives: they log in, dismiss banners, and navigate wherever the
    scenario needs to go. We only watch and take inventory, which is what makes
    locators on page 2 real instead of guessed. Closing the window ends it.
    """
    session_id = str(uuid.uuid4())
    session = RecordingSession(
        id=session_id,
        start_url=start_url,
        status="recording",
        pages=[],
        error=None,
        started_at=now_iso(),
    )
    control = _Control(stop=threading.Event(), ready=threading.Event())

    with _lock:
        _sessions[session_id] = session
        _controls[session_id] = control

    thread = threading.Thread(target=_drive, args=(session, control), daemon=True)
    control.thread = thread
    thread.start()

    # Answer only once the first page is inventoried, as the Express version did.
    await asyncio.to_thread(control.ready.wait, FIRST_CAPTURE_TIMEOUT)

    if control.launch_error:
        discard_session(session_id)
        raise RuntimeError(f"Could not launch a browser for recording: {control.launch_error}")

    return session


async def stop_recording(session_id: str) -> RecordingSession | None:
    """Ends a recording from the UI, for when the window is out of reach."""
    with _lock:
        session = _sessions.get(session_id)
        control = _controls.get(session_id)

    if not session:
        return None

    if control:
        control.stop.set()
        if control.thread and control.thread.is_alive():
            # The pump loop notices the flag within a tick; the join is just so the
            # browser is really gone before a generate() call reads session.pages.
            await asyncio.to_thread(control.thread.join, 15.0)

    if session.status == "recording":
        session.status = "finished"

    return session
