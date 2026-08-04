"""Capturing what the human actually did while recording.

Inventorying each page tells the model which elements exist; it does not tell it
what the user *did*. Without that the model invents a plausible flow from the
prompt, which is why a recorded journey could come back as a script that did not
match the session. This module records the real click/fill/select/press sequence
so the generated test can replay it exactly.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

#: Installed in every page before its own scripts run. Mirrors the locator
#: preference order used by the crawler so recorded locators and inventoried
#: locators are the same strings.
CAPTURE_JS = r"""() => {
  if (window.__pwRecorderInstalled) return;
  window.__pwRecorderInstalled = true;

  const q = (v) => "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";

  const accessibleName = (node) => {
    if (!node || !node.getAttribute) return '';
    const aria = node.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = node.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = document.getElementById(labelledBy);
      if (t && t.textContent) return t.textContent.trim();
    }
    const id = node.getAttribute('id');
    if (id) {
      const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (l && l.textContent) return l.textContent.trim();
    }
    const wrapping = node.closest && node.closest('label');
    if (wrapping && wrapping.textContent) return wrapping.textContent.trim();
    const alt = node.getAttribute('alt');
    if (alt) return alt.trim();
    if (node.tagName === 'INPUT' && node.type === 'submit' && node.value) return node.value.trim();
    if (['SELECT', 'INPUT', 'TEXTAREA'].includes(node.tagName)) return '';
    return (node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  };

  const roleOf = (node) => {
    const explicit = node.getAttribute && node.getAttribute('role');
    if (explicit) return explicit;
    const tag = node.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const t = node.type;
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button') return 'button';
      if (t === 'search') return 'searchbox';
      return 'textbox';
    }
    return '';
  };

  const locatorFor = (node) => {
    if (!node || node.nodeType !== 1) return null;
    const testId = node.getAttribute('data-testid') || node.getAttribute('data-test-id');
    if (testId) return `getByTestId(${q(testId)})`;
    const role = roleOf(node);
    const name = accessibleName(node);
    if (role && name) return `getByRole(${q(role)}, { name: ${q(name)} })`;
    if (node.placeholder) return `getByPlaceholder(${q(node.placeholder)})`;
    if (role) return `getByRole(${q(role)})`;
    if (name) return `getByText(${q(name)})`;
    return null;
  };

  const INTERACTIVE = 'a,button,input,select,textarea,summary,[role],[contenteditable=true]';

  const send = (action) => {
    try {
      action.url = location.href;
      window.__pwRecordAction(action);
    } catch (e) { /* binding gone: the page is unloading */ }
  };

  document.addEventListener('click', (event) => {
    const target = (event.target.closest && event.target.closest(INTERACTIVE)) || event.target;
    const locator = locatorFor(target);
    if (!locator) return;
    // A click that lands on an option inside an open listbox is a suggestion pick.
    const kind = target.getAttribute && target.getAttribute('role') === 'option' ? 'option' : 'click';
    send({ type: kind, locator });
  }, true);

  document.addEventListener('change', (event) => {
    const el = event.target;
    if (!el || el.nodeType !== 1) return;
    const locator = locatorFor(el);
    if (!locator) return;
    if (el.type === 'checkbox' || el.type === 'radio') {
      send({ type: el.checked ? 'check' : 'uncheck', locator });
    } else if (el.tagName === 'SELECT') {
      const opt = el.selectedOptions && el.selectedOptions[0];
      send({ type: 'select', locator, value: el.value, label: opt ? opt.label : '' });
    } else if ('value' in el) {
      send({ type: 'fill', locator, value: el.value, inputType: el.type || '' });
    }
  }, true);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const locator = locatorFor(event.target);
    if (locator) send({ type: 'press', locator, value: 'Enter' });
  }, true);
}"""


#: add_init_script runs raw source, not a function, so the capture is wrapped in an
#: IIFE. (page.evaluate would take CAPTURE_JS itself.)
CAPTURE_INIT_JS = f"({CAPTURE_JS})();"


@dataclass
class RecordedAction:
    type: str
    locator: str | None
    url: str
    value: str | None = None
    label: str | None = None
    input_type: str | None = None

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "RecordedAction | None":
        kind = payload.get("type")
        if not isinstance(kind, str):
            return None
        return cls(
            type=kind,
            locator=payload.get("locator"),
            url=str(payload.get("url") or ""),
            value=payload.get("value") if isinstance(payload.get("value"), str) else None,
            label=payload.get("label") if isinstance(payload.get("label"), str) else None,
            input_type=payload.get("inputType") if isinstance(payload.get("inputType"), str) else None,
        )


def compress(actions: list[RecordedAction]) -> list[RecordedAction]:
    """Collapses the noise a real session produces.

    Typing fires a change per field visit, and clicking a control often fires a
    click on it and again on a child. Keeping only the last value per consecutive
    field, and dropping immediate duplicates, gives the sequence a human would
    describe.
    """
    out: list[RecordedAction] = []
    for action in actions:
        if not action.locator:
            continue
        previous = out[-1] if out else None

        if (
            previous
            and previous.type == "fill"
            and action.type == "fill"
            and previous.locator == action.locator
        ):
            out[-1] = action  # keep the final value typed into this field
            continue

        if (
            previous
            and previous.type == action.type
            and previous.locator == action.locator
            and previous.value == action.value
            and action.type in ("click", "press", "option", "check", "uncheck")
        ):
            continue

        # A click on the field immediately before typing into it is implied by fill().
        if (
            previous
            and previous.type == "click"
            and action.type == "fill"
            and previous.locator == action.locator
        ):
            out[-1] = action
            continue

        out.append(action)

    return out


def _render(action: RecordedAction) -> str:
    locator = f"page.{action.locator}"
    if action.type == "fill":
        return f"fill {locator} with {action.value!r}"
    if action.type == "select":
        chosen = action.label or action.value
        return f"selectOption on {locator} choosing {chosen!r}"
    if action.type == "option":
        return f"click the suggestion {locator} (an autocomplete option)"
    if action.type == "press":
        return f"press {action.value!r} on {locator}"
    if action.type in ("check", "uncheck"):
        return f"{action.type} {locator}"
    return f"click {locator}"


def format_actions(actions: list[RecordedAction]) -> str:
    """The ordered action list handed to the model alongside the page reports."""
    steps = compress(actions)
    if not steps:
        return ""

    lines = [
        "USER ACTIONS — the exact sequence the human performed while recording.",
        "This is ground truth, not a suggestion. The functional test MUST reproduce",
        "these steps in this order, using these locator expressions verbatim, one",
        "await test.step(...) per numbered line. Do not add steps that are not listed,",
        "do not reorder them, and do not substitute a different locator.",
        "",
    ]

    page_urls: list[str] = []
    for index, action in enumerate(steps, start=1):
        if action.url and action.url not in page_urls:
            page_urls.append(action.url)
            lines.append(f"  (now on {action.url})")
        lines.append(f"  {index}. {_render(action)}")

    secrets = [a for a in steps if a.type == "fill" and a.input_type == "password"]
    if secrets:
        lines += [
            "",
            "One of the filled fields is a password input; its literal value is above and",
            "must be used as-is so the test can log in.",
        ]

    return "\n".join(lines)


def summarise_actions(actions: list[RecordedAction]) -> list[dict[str, Any]]:
    """Compact form for the UI, so a user can see what was captured."""
    return [
        {
            "type": a.type,
            "locator": a.locator,
            # Never echo a typed password back to the browser UI.
            "value": "********" if a.input_type == "password" else a.value,
            "url": a.url,
        }
        for a in compress(actions)
    ]


def looks_like_secret(name: str) -> bool:
    return bool(re.search(r"pass|secret|token|otp|cvv", name, re.I))
