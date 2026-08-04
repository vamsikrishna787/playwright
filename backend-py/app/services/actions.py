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
from urllib.parse import urlsplit

#: Installed in every page before its own scripts run. Mirrors the locator
#: preference order used by the crawler so recorded locators and inventoried
#: locators are the same strings.
CAPTURE_JS = r"""() => {
  if (window.__pwRecorderInstalled) return;
  window.__pwRecorderInstalled = true;

  const q = (v) => "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

  // getByRole matches against the accessibility tree, so anything hidden from it
  // is not a competing match. Counting hidden elements would push every nth()
  // index out by one — a page with collapsed tab panels breaks immediately.
  const inAccessibilityTree = (node) => {
    if (node.closest && node.closest('[aria-hidden="true"]')) return false;
    if (typeof node.checkVisibility === 'function') {
      return node.checkVisibility({ checkVisibilityCSS: true });
    }
    return !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
  };

  // Displays that put a child on its own line, so its text cannot run into its
  // neighbour's: "Next" + "Writing tests", never "NextWriting tests".
  const BLOCKISH = /^(block|flex|grid|list-item|table|table-row|table-cell|flow-root)/;

  const textAlternative = (node) => {
    // Approximates the ARIA text alternative. textContent is not good enough on
    // three counts: it welds words together across block boundaries, it picks up
    // text that is never rendered, and it drops the alt of a nested image even
    // though that alt is part of the name Playwright computes.
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out += child.nodeValue;
        continue;
      }
      if (child.nodeType !== 1 || !inAccessibilityTree(child)) continue;

      // SVG tag names are lower case, HTML ones upper — normalise before testing.
      const tag = (child.tagName || '').toLowerCase();
      const aria = child.getAttribute('aria-label');
      // An <svg> is named by its <title> child, and that name belongs to whatever
      // contains it: a logo link wrapping <svg><title>MDN</title></svg> is called
      // "MDN" by Playwright. Miss it and the link looks nameless, which both
      // yields a junk positional locator and hides a genuine name collision.
      const svgTitle = tag === 'svg' ? child.querySelector('title') : null;
      const piece = aria
        ? aria
        : tag === 'img'
          ? child.getAttribute('alt') || ''
          : tag === 'svg'
            ? (svgTitle ? svgTitle.textContent : '')
            : textAlternative(child);

      // A replaced <img> stands apart from the words around it ("Playwright logo
      // Playwright"), but an inline <svg> does not — Chromium runs its name
      // straight on, giving "Playwright Training(opens in new tab)".
      const display = window.getComputedStyle(child).display;
      out += tag === 'img' || BLOCKISH.test(display) ? ` ${piece} ` : piece;
    }
    return out;
  };

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
    const title = node.getAttribute('title');
    if (['SELECT', 'INPUT', 'TEXTAREA'].includes(node.tagName)) return norm(title);
    // The title attribute is the last resort of the ARIA computation: it names an
    // element only when nothing else did.
    return norm(textAlternative(node)) || norm(title);
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
    // Landmarks. Not interactive, but a named one is the best thing to scope an
    // otherwise ambiguous locator into.
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'header') return 'banner';
    if (tag === 'footer') return 'contentinfo';
    if (tag === 'aside') return 'complementary';
    if (tag === 'form') return 'form';
    if (tag === 'section') return 'region';
    if (tag === 'article') return 'article';
    if (tag === 'dialog') return 'dialog';
    if (tag === 'table') return 'table';
    return '';
  };

  // A recorded step is only replayable if its locator resolves to exactly ONE
  // element — Playwright's strict mode throws otherwise, and that is far and away
  // the most common reason a recorded journey fails on replay. The clicked node is
  // still in hand here, so ambiguity is resolved now: once this becomes a string,
  // the identity of the element is gone for good.

  const nameMatches = (node, name, exact) => {
    const actual = norm(accessibleName(node));
    return exact ? actual === name : actual.toLowerCase().includes(name.toLowerCase());
  };

  const candidatesFor = (node) => {
    const out = [];

    const testId = node.getAttribute('data-testid') || node.getAttribute('data-test-id');
    if (testId) {
      out.push({
        expr: `getByTestId(${q(testId)})`,
        match: (n) =>
          (n.getAttribute('data-testid') || n.getAttribute('data-test-id')) === testId,
      });
    }

    const role = roleOf(node);
    const full = norm(accessibleName(node));
    // Long names make unreadable locators, but a clipped name can only ever be
    // used as a substring — asserting a clipped name exactly matches nothing.
    const name = full.slice(0, 80);

    if (role && name) {
      // Both forms, loosest first. getByRole name matching is a case-insensitive
      // SUBSTRING by default, so 'Writing tests' also matches the pagination link
      // 'Next Writing tests »'; exact: true settles that case but not two links
      // whose names are genuinely identical.
      out.push({
        expr: `getByRole(${q(role)}, { name: ${q(name)} })`,
        match: (n) => roleOf(n) === role && nameMatches(n, name, false),
      });
      if (name === full) {
        out.push({
          expr: `getByRole(${q(role)}, { name: ${q(name)}, exact: true })`,
          match: (n) => roleOf(n) === role && nameMatches(n, name, true),
        });
      }
    }

    const placeholder = norm(node.getAttribute('placeholder'));
    if (placeholder) {
      out.push({
        expr: `getByPlaceholder(${q(placeholder)})`,
        match: (n) => norm(n.getAttribute('placeholder')).includes(placeholder),
      });
    }

    if (role && !name) {
      out.push({ expr: `getByRole(${q(role)})`, match: (n) => roleOf(n) === role });
    }

    if (name && !role) {
      out.push({
        expr: `getByText(${q(name)})`,
        // getByText resolves to the innermost element carrying the text, so an
        // ancestor that merely contains it is not a competing match.
        match: (n) =>
          norm(n.textContent).toLowerCase().includes(name.toLowerCase()) &&
          !Array.from(n.children).some((c) =>
            norm(c.textContent).toLowerCase().includes(name.toLowerCase())
          ),
      });
    }

    return out;
  };

  const SCOPE_ROLES = [
    'navigation', 'main', 'banner', 'contentinfo', 'complementary', 'form',
    'search', 'region', 'dialog', 'table', 'tablist', 'article', 'listbox',
  ];

  // A landmark is named by ARIA only. Falling back to its text content the way
  // accessibleName does would name a sidebar after every link inside it.
  const landmarkName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return norm(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const target = document.getElementById(by);
      if (target) return norm(target.textContent);
    }
    return '';
  };

  const scopesFor = (node) => {
    const chain = [];
    for (let el = node.parentElement; el; el = el.parentElement) {
      const role = roleOf(el);
      if (SCOPE_ROLES.indexOf(role) === -1) continue;
      const name = landmarkName(el);
      if (!name) continue;
      // A scope that is itself ambiguous solves nothing.
      const hits = Array.from(document.querySelectorAll('*'))
        .filter((n) => roleOf(n) === role && landmarkName(n) === name)
        .filter(inAccessibilityTree);
      if (hits.length === 1 && hits[0] === el) {
        chain.push({ el, expr: `getByRole(${q(role)}, { name: ${q(name)}, exact: true })` });
      }
    }
    return chain; // nearest enclosing landmark first
  };

  const locatorFor = (node) => {
    if (!node || node.nodeType !== 1 || !node.getAttribute) return null;

    const candidates = candidatesFor(node);
    if (!candidates.length) return null;

    const everything = Array.from(document.querySelectorAll('*'));
    // match runs first and short-circuits on role, so the expensive visibility
    // check only ever sees the handful of elements that could actually compete.
    const hitsIn = (candidate, root) =>
      (root === document ? everything : Array.from(root.querySelectorAll('*')))
        .filter(candidate.match)
        .filter(inAccessibilityTree);

    // 1. Unique on its own — the locator a human would have written by hand.
    for (const c of candidates) {
      const hits = hitsIn(c, document);
      if (hits.length === 1 && hits[0] === node) return c.expr;
    }

    // 2. Unique inside an enclosing named landmark. Preferred over an index
    //    because a named region survives a rerender and a position does not.
    for (const scope of scopesFor(node)) {
      for (const c of candidates) {
        const hits = hitsIn(c, scope.el);
        if (hits.length === 1 && hits[0] === node) return `${scope.expr}.${c.expr}`;
      }
    }

    // 3. Position among the matches. Blunt, but exact, and only reached when the
    //    page offers nothing else to tell the elements apart — two sidebar links
    //    both named "Trace viewer", say. The tightest candidate wins, so nth()
    //    indexes the smallest set possible.
    let best = null;
    for (const c of candidates) {
      const hits = hitsIn(c, document);
      const index = hits.indexOf(node);
      if (index === -1) continue;
      if (!best || hits.length < best.total) {
        best = { expr: `${c.expr}.nth(${index})`, total: hits.length };
      }
    }
    return best ? best.expr : null;
  };

  const INTERACTIVE = 'a,button,input,select,textarea,summary,[role],[contenteditable=true]';

  // Exposed so the locator builder can be exercised against a real page without
  // driving a whole recording session. Nothing in the recorder reads it.
  window.__pwLocatorFor = locatorFor;
  window.__pwProbe = { name: accessibleName, role: roleOf, visible: inAccessibilityTree };

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


def _url_pattern(url: str) -> str:
    """The body of a JS regex literal matching this URL.

    toHaveURL with a plain string demands a whole-URL match, which is brittle, so
    the path is used instead — and escaped, since it is going between slashes.
    """
    parts = urlsplit(url)
    fragment = parts.path if parts.path not in ("", "/") else f"{parts.netloc}{parts.path}"
    return re.sub(r"([.*+?^${}()|\[\]\\/])", r"\\\1", fragment)


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
        "Every locator below was checked against the live page at the moment it was",
        "recorded and resolves to exactly one element. Any exact: true, .nth(n) or",
        ".first() it carries is load-bearing — it is what keeps the locator off",
        "Playwright's strict mode. Copy each expression character for character and",
        "never shorten, clean up or 'improve' one.",
        "",
    ]

    index = 0
    current_url = ""
    for action in steps:
        if action.url and action.url != current_url:
            if current_url:
                index += 1
                lines.append(
                    f"  {index}. the previous step navigated to {action.url} — settle on it "
                    f"with await expect(page).toHaveURL(/{_url_pattern(action.url)}/) "
                    "before going on"
                )
            else:
                lines.append(f"  (the recording starts on {action.url})")
            current_url = action.url
        index += 1
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
