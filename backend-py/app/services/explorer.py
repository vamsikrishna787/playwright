"""Crawls a live page and writes down what a test could actually touch.

Everything here uses Playwright's **sync** API and is expected to be called from
a worker thread (`asyncio.to_thread`, or the recorder's own thread). That keeps
browser work off the event loop without depending on which event loop policy
uvicorn installed — a real concern on Windows.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from playwright.sync_api import Frame, Locator, Page, sync_playwright

from ..config import SNAPSHOT_MAX_CHARS
from .node_cli import optional_package_file


@dataclass
class DiscoveredElement:
    #: Playwright locator expression, e.g. getByRole('button', { name: 'Search' }).
    locator: str
    role: str
    name: str
    tag: str
    type: str | None = None
    placeholder: str | None = None
    required: bool | None = None
    options: list[str] | None = None
    #: Only present once we've revealed it by interacting.
    revealed_by: str | None = None
    #: How many elements on the page share this role+name. Anything above 1 means a
    #: bare locator would fail strict mode, so the count has to reach the model.
    occurrences: int = 1


@dataclass
class AxeIssue:
    id: str
    impact: str
    help: str
    nodes: int
    sample: str


@dataclass
class PageReport:
    url: str
    title: str
    headings: list[str] = field(default_factory=list)
    elements: list[DiscoveredElement] = field(default_factory=list)
    axe: list[AxeIssue] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    #: Behavioural facts the model needs but cannot infer from a locator list.
    hints: list[str] = field(default_factory=list)


SUBMIT_WORDS = re.compile(
    r"\b(submit|save|buy|order|purchase|pay|checkout|delete|remove|confirm|send|register|"
    r"sign\s?up|subscribe|book|apply|continue|next|log\s?in|sign\s?in)\b",
    re.I,
)

LOCATION_FIELD = re.compile(
    r"where|origin|destination|airport|city|depart|arriv|from|to\b|location|place", re.I
)

PLACE = r"([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]+)?)"

AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]


def sample_value(type_: str, name: str, context: str | None = None) -> str:
    """Sample values by input type.

    Getting these right matters more than it looks: an autocomplete fed a
    meaningless string returns no suggestions, so the dependent UI never appears
    and the crawl misses half the page.
    """
    both = type_ + name

    if re.search(r"email", both, re.I):
        return "test@example.com"
    if re.search(r"password", both, re.I):
        return "Passw0rd!23"
    if re.search(r"tel|phone", both, re.I):
        return "5551234567"
    if type_ == "number":
        return "1"
    if type_ == "date":
        return "2026-01-01"
    if type_ == "time":
        return "12:00"
    if type_ == "url":
        return "https://example.com"
    if re.search(r"zip|postal", name, re.I):
        return "10001"

    if LOCATION_FIELD.search(name):
        # Pull the places out of the user's own scenario, and keep origin and
        # destination distinct — filling both with the same city gives the
        # destination field a useless suggestion list.
        origin_match = re.search(rf"\bfrom\s+{PLACE}", context) if context else None
        destination_match = re.search(rf"\bto\s+{PLACE}", context) if context else None
        origin = origin_match.group(1) if origin_match else None
        destination = destination_match.group(1) if destination_match else None

        if re.search(r"where to|destination|arriv|\bto\b", name, re.I):
            return destination or "Phoenix"
        if re.search(r"where from|origin|depart|\bfrom\b", name, re.I):
            return origin or "Dallas"
        return origin or destination or "Dallas"

    if re.search(r"full ?name|first ?name|last ?name|your name", name, re.I):
        return "Test User"
    if re.search(r"search|query|keyword", name, re.I):
        return "test"
    return "test"


def quote(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def build_locator(
    *,
    role: str,
    name: str,
    tag: str | None = None,
    placeholder: str | None = None,
    test_id: str | None = None,
    label: str | None = None,
) -> str:
    """Prefer a role+name locator, falling back through label, placeholder, then testid."""
    if test_id:
        return f"getByTestId({quote(test_id)})"
    if role and name:
        return f"getByRole({quote(role)}, {{ name: {quote(name)} }})"
    if label:
        return f"getByLabel({quote(label)})"
    if placeholder:
        return f"getByPlaceholder({quote(placeholder)})"

    # An unlabelled form control has no accessible name to match on, so a bare
    # role locator would be ambiguous the moment there are two of them. A tag
    # selector at least resolves deterministically with .first().
    if tag in ("select", "textarea"):
        return f"locator({quote(tag)})"

    if role:
        return f"getByRole({quote(role)})"
    return f"getByText({quote(name)})"


# Runs inside the page, so it is plain JS rather than anything Python touches.
HARVEST_JS = """() => {
  const visible = (node) => {
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none'
    );
  };

  const norm = (v) => String(v == null ? '' : v).replace(/\\s+/g, ' ').trim();

  const rendered = (node) => {
    if (node.closest && node.closest('[aria-hidden="true"]')) return false;
    if (typeof node.checkVisibility === 'function') {
      return node.checkVisibility({ checkVisibilityCSS: true });
    }
    return !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length);
  };

  const BLOCKISH = /^(block|flex|grid|list-item|table|table-row|table-cell|flow-root)/;

  // Approximates the ARIA text alternative. textContent welds words together
  // across block boundaries ("NextWriting tests"), picks up text that is never
  // rendered, and ignores both an <img alt> and an <svg><title> — each of which
  // Playwright counts as part of the name.
  const textAlternative = (node) => {
    let out = '';
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out += child.nodeValue;
        continue;
      }
      if (child.nodeType !== 1 || !rendered(child)) continue;

      const tag = (child.tagName || '').toLowerCase();
      const aria = child.getAttribute('aria-label');
      const svgTitle = tag === 'svg' ? child.querySelector('title') : null;
      const piece = aria
        ? aria
        : tag === 'img'
          ? child.getAttribute('alt') || ''
          : tag === 'svg'
            ? (svgTitle ? svgTitle.textContent : '')
            : textAlternative(child);

      // A replaced <img> stands apart from the words around it, but an inline
      // <svg> does not — Chromium runs its name straight on.
      out += tag === 'img' || BLOCKISH.test(window.getComputedStyle(child).display)
        ? ` ${piece} `
        : piece;
    }
    return out;
  };

  const accessibleName = (node) => {
    const aria = node.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = node.getAttribute('aria-labelledby');
    if (labelledBy) {
      const target = document.getElementById(labelledBy);
      if (target && target.textContent) return target.textContent.trim();
    }
    const id = node.getAttribute('id');
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label && label.textContent) return label.textContent.trim();
    }
    const wrapping = node.closest('label');
    if (wrapping && wrapping.textContent) return wrapping.textContent.trim();
    const alt = node.getAttribute('alt');
    if (alt) return alt.trim();
    const value = node.value;
    if (node.tagName === 'INPUT' && value && node.type === 'submit') {
      return value.trim();
    }
    // Form controls take their name from a label or ARIA only. Falling back to
    // textContent here would turn a <select>'s own options into a bogus name
    // like "VisaAmex", producing a locator that never matches at runtime.
    const title = node.getAttribute('title');
    if (['SELECT', 'INPUT', 'TEXTAREA'].includes(node.tagName)) return norm(title).slice(0, 80);
    // The title attribute is the last resort of the ARIA computation: it names an
    // element only when nothing else did.
    return (norm(textAlternative(node)) || norm(title)).slice(0, 80);
  };

  const roleOf = (node) => {
    const explicit = node.getAttribute('role');
    if (explicit) return explicit;
    const tag = node.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = node.type;
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button') return 'button';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    return '';
  };

  const selector =
    'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=checkbox], [role=combobox], [contenteditable=true], summary';

  return Array.from(document.querySelectorAll(selector))
    .filter(visible)
    .slice(0, 120)
    .map((node) => ({
      tag: node.tagName.toLowerCase(),
      role: roleOf(node),
      name: accessibleName(node),
      type: node.type || undefined,
      placeholder: node.placeholder || undefined,
      required: node.required || undefined,
      testId:
        node.getAttribute('data-testid') || node.getAttribute('data-test-id') || undefined,
      options:
        node.tagName === 'SELECT'
          ? Array.from(node.options || [])
              .slice(0, 12)
              .map((o) => o.label || o.value)
          : undefined,
    }))
    .filter((el) => el.name || el.placeholder || el.testId);
}"""


def harvest(page: Page) -> list[DiscoveredElement]:
    """Harvest every interactive element currently in the DOM."""
    try:
        raw: list[dict[str, Any]] = page.evaluate(HARVEST_JS)
    except Exception:
        return []

    return [
        DiscoveredElement(
            locator=build_locator(
                role=el.get("role") or "",
                name=el.get("name") or "",
                tag=el.get("tag"),
                placeholder=el.get("placeholder"),
                test_id=el.get("testId"),
            ),
            role=el.get("role") or "",
            name=el.get("name") or "",
            tag=el.get("tag") or "",
            type=el.get("type"),
            placeholder=el.get("placeholder"),
            required=el.get("required"),
            options=el.get("options"),
        )
        for el in raw
    ]


def _key(el: DiscoveredElement) -> str:
    return f"{el.role}|{el.name}|{el.placeholder or ''}"


def disambiguate(elements: list[DiscoveredElement]) -> list[DiscoveredElement]:
    """Make every locator in the inventory resolve to exactly one element.

    Two separate collisions to handle. getByRole name matching is substring-based,
    so "Password" also matches "Confirm Password" — that one exact: true fixes. But
    a page can equally hold two elements with the *same* role and an identical name
    (two sidebar links both called "Trace viewer"), and there exact: true changes
    nothing; only a position does. Both end in strict mode failures at runtime, so
    neither can be left for the model to notice on its own.
    """
    result: list[DiscoveredElement] = []

    for el in elements:
        if not el.name or not el.locator.startswith("getByRole"):
            result.append(el)
            continue

        collides = any(
            other is not el
            and other.role == el.role
            and other.name != el.name
            and el.name.lower() in other.name.lower()
            for other in elements
        )

        if collides:
            el.locator = re.sub(r"\s*\}\)$", ", exact: true })", el.locator)

        # Identical twins. .first() is the only choice that always runs; the count
        # is rendered alongside so the model can reach for .nth(k) when the
        # scenario wants a later one.
        if el.occurrences > 1:
            el.locator = f"{el.locator}.first()"

        result.append(el)

    return result


def resolve(page: Page, el: DiscoveredElement) -> Locator:
    if el.placeholder:
        return page.get_by_placeholder(el.placeholder)
    if el.role and el.name:
        return page.get_by_role(el.role, name=el.name, exact=False)  # type: ignore[arg-type]
    if el.name:
        return page.get_by_text(el.name, exact=False)
    return page.locator(el.tag)


def fill_inputs(
    page: Page,
    elements: list[DiscoveredElement],
    notes: list[str],
    hints: list[str],
    context: str | None = None,
) -> None:
    """Type into a field so dependent UI appears.

    Comboboxes get special handling: many apps (Google Flights, airline sites,
    address pickers) only unlock the rest of the form once a suggestion has
    actually been chosen, so filling alone leaves the submit control hidden and
    the generated test unrunnable.
    """
    # Only real text inputs. A select-style combobox (trip type, cabin class) is
    # also role=combobox, but clicking one opens a menu that swallows subsequent
    # clicks and changes form state we never wanted to touch.
    fillable = [
        el
        for el in elements
        if el.tag in ("input", "textarea")
        and (el.type or "") not in ("checkbox", "radio", "submit", "button", "file", "hidden")
    ]

    for el in fillable[:12]:
        label = el.name or el.placeholder or ""
        try:
            field_locator = resolve(page, el).first

            # Focus first. Some widgets (Google Flights' airport pickers) only open
            # their suggestion list on real focus, so fill() alone shows nothing.
            try:
                field_locator.click(timeout=2500)
            except Exception:
                pass
            field_locator.fill(sample_value(el.type or "", label, context), timeout=2500)
            page.wait_for_timeout(400)

            # Select-style comboboxes (trip type, cabin class) also use role=option,
            # and choosing one silently changes form state — only treat real text
            # inputs as autocompletes.
            if el.tag != "input":
                continue

            # Visibility matters: closed dropdowns elsewhere on the page keep their
            # options in the DOM, and picking one of those changes unrelated state.
            options = page.locator('[role="option"]:visible')
            try:
                count = options.count()
            except Exception:
                count = 0
            if count == 0:
                continue

            try:
                texts = options.all_inner_texts()
            except Exception:
                texts = []
            sample = [t for t in (re.sub(r"\s+", " ", t).strip()[:60] for t in texts) if t][:3]

            hints.append(
                f'"{label}" is an autocomplete. Click it, fill() it, then wait for '
                "page.getByRole('option') and click the matching one — the rest of the form "
                f"stays hidden until a suggestion is committed. Observed options: {' / '.join(sample)}"
            )

            options.first.click(timeout=2500)
            page.wait_for_timeout(600)
        except Exception:
            notes.append(f"Could not fill {el.locator}")


def expand_disclosures(page: Page, elements: list[DiscoveredElement], notes: list[str]) -> None:
    """Click only things that reveal UI — never anything that looks like it commits."""
    candidates = [
        el
        for el in elements
        if (el.role == "tab" or el.tag == "summary" or el.role == "button")
        and el.name
        and not SUBMIT_WORDS.search(el.name)
        and el.type != "submit"
    ]

    for el in candidates[:8]:
        try:
            before = page.url
            resolve(page, el).first.click(timeout=2000)
            page.wait_for_timeout(250)
            if page.url != before:
                # Navigation is a side effect we did not want — go back and stop clicking.
                try:
                    page.go_back(wait_until="domcontentloaded")
                except Exception:
                    pass
                notes.append(f"Clicking {el.locator} navigated away; skipped further clicks")
                return
        except Exception:
            notes.append(f"Could not expand {el.locator}")


def _axe_source() -> str | None:
    """axe-core's browser bundle, taken from the same node_modules the specs use."""
    path = optional_package_file("axe-core", "axe.min.js") or optional_package_file(
        "axe-core", "axe.js"
    )
    if not path:
        return None
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return None


def _inject_axe(frame: Frame, source: str) -> None:
    try:
        frame.evaluate(source)
    except Exception:
        # A strict CSP can reject the eval; a script tag is the usual way around it.
        try:
            frame.add_script_tag(content=source)
        except Exception:
            pass


def run_axe(page: Page) -> list[AxeIssue]:
    source = _axe_source()
    if not source:
        return []

    try:
        for frame in page.frames:
            _inject_axe(frame, source)

        results = page.evaluate(
            "(tags) => axe.run(document, { runOnly: { type: 'tag', values: tags } })",
            AXE_TAGS,
        )

        return [
            AxeIssue(
                id=v.get("id", ""),
                impact=v.get("impact") or "unknown",
                help=v.get("help", ""),
                nodes=len(v.get("nodes") or []),
                sample=str(((v.get("nodes") or [{}])[0].get("target") or [""])[0])[:120],
            )
            for v in (results.get("violations") or [])[:15]
        ]
    except Exception:
        return []


def capture_page(
    page: Page, *, interact: bool = True, context: str | None = None
) -> PageReport:
    """Inventories whatever page is currently loaded: harvests every interactive
    element, runs an axe audit, and returns a report.

    `interact` controls whether it also fills inputs and expands disclosures to
    surface elements that only exist after interaction. That is right for the
    automatic crawl, but wrong while recording — there a human is driving, and
    typing into their form underneath them would corrupt the flow.
    """
    notes: list[str] = []
    hints: list[str] = []

    try:
        page.wait_for_load_state("networkidle", timeout=8000)
    except Exception:
        pass

    try:
        title = page.title()
    except Exception:
        title = ""

    try:
        headings = [h.strip() for h in page.locator("h1, h2").all_inner_texts() if h.strip()][:12]
    except Exception:
        headings = []

    initial = harvest(page)

    # Collapsing duplicates keeps the report inside its token budget, but the fact
    # that there WERE duplicates has to survive the collapse — it is exactly what
    # makes a bare locator unusable.
    seen: dict[str, DiscoveredElement] = {}

    def merge(elements: list[DiscoveredElement], revealed_by: str | None = None) -> None:
        for el in elements:
            if (existing := seen.get(_key(el))) is not None:
                if existing.revealed_by == revealed_by:
                    existing.occurrences += 1
                continue
            el.revealed_by = revealed_by
            seen[_key(el)] = el

    merge(initial)

    if interact:
        fill_inputs(page, initial, notes, hints, context)
        expand_disclosures(page, initial, notes)

        # Anything new here only existed after we interacted.
        merge(harvest(page), revealed_by="interaction")

    return PageReport(
        url=page.url,
        title=title,
        headings=headings,
        elements=disambiguate(list(seen.values())),
        axe=run_axe(page),
        notes=notes,
        hints=hints,
    )


def explore_page(url: str, context: str | None = None) -> PageReport:
    """Opens the URL in a headless browser and inventories it. Blocking — call in a thread."""
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True)
        try:
            browser_context = browser.new_context(viewport={"width": 1280, "height": 900})
            page = browser_context.new_page()

            page.on("dialog", lambda dialog: _dismiss(dialog))

            page.goto(url, wait_until="domcontentloaded", timeout=30_000)
            return capture_page(page, interact=True, context=context)
        finally:
            try:
                browser.close()
            except Exception:
                pass


def _dismiss(dialog: Any) -> None:
    try:
        dialog.dismiss()
    except Exception:
        pass


def format_report(report: PageReport) -> str:
    """Compact, token-bounded rendering of the report for the model."""
    lines: list[str] = [
        f"URL: {report.url}",
        f"Title: {report.title}",
        f"Headings: {' | '.join(report.headings)}" if report.headings else "",
        "",
        "INTERACTIVE ELEMENTS (use these locator expressions verbatim):",
    ]

    for el in report.elements:
        bits = [
            f"page.{el.locator}",
            f"type={el.type}" if el.type and el.type != "text" else "",
            "required" if el.required else "",
            f"options=[{', '.join(el.options[:6])}]" if el.options else "",
            "appears-after-interaction" if el.revealed_by else "",
            # Without this the .first() above reads like a stylistic tic, and a
            # model that drops it gets a strict mode failure at runtime.
            f"{el.occurrences} identical matches on the page — .first() is required; "
            f"use .nth(0)….nth({el.occurrences - 1}) to reach a specific one"
            if el.occurrences > 1
            else "",
        ]
        lines.append(f"- {'  '.join(bit for bit in bits if bit)}")

    if report.hints:
        lines.append("")
        lines.append("PAGE BEHAVIOUR — observed while crawling, you MUST honour these:")
        lines.extend(f"- {hint}" for hint in report.hints)

    if report.axe:
        lines.append("")
        lines.append("KNOWN ACCESSIBILITY VIOLATIONS ON THIS PAGE (axe, WCAG 2.1 A/AA):")
        lines.extend(
            f"- {issue.id} [{issue.impact}] {issue.help} ({issue.nodes} node(s))"
            for issue in report.axe
        )
    else:
        lines.append("")
        lines.append("axe found no WCAG 2.1 A/AA violations on the initial page state.")

    if report.notes:
        lines.append("")
        lines.append(f"Exploration notes: {'; '.join(report.notes[:5])}")

    text = "\n".join(line for line in lines if line != "")
    if len(text) > SNAPSHOT_MAX_CHARS:
        return f"{text[:SNAPSHOT_MAX_CHARS]}\n... [truncated]"
    return text


def format_journey(pages: list[PageReport]) -> str:
    """Renders a recorded journey.

    Each page gets its own numbered block so the model can tell which locators
    belong to which screen — the whole point of recording is that page 2's
    elements are observed rather than guessed.
    """
    budget = SNAPSHOT_MAX_CHARS // max(len(pages), 1)

    blocks = []
    for i, page in enumerate(pages):
        body = format_report(page)
        trimmed = f"{body[:budget]}\n... [truncated]" if len(body) > budget else body
        blocks.append(
            "\n".join(
                [
                    f"═══ PAGE {i + 1} OF {len(pages)} ═══",
                    "This is the starting page — the test must goto() this URL."
                    if i == 0
                    else (
                        f"Reached by the user acting on page {i}. Your test must perform the "
                        "actions that navigate here before using any locator from this block."
                    ),
                    trimmed,
                ]
            )
        )

    return "\n\n".join(blocks)
