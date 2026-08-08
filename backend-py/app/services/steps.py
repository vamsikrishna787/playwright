"""Turns a generated spec into plain English.

The script view is for whoever maintains the test; this is for everyone else.
It reads the file rather than asking a model, so it costs nothing, answers
instantly, and can never describe a test that is not the one on screen.

Deliberately line-based: generated specs follow the house structure the system
prompt dictates (a locators factory, one describe, test.step per action), so a
parser that leans on that shape stays short and predictable. Anything it does
not recognise is passed through verbatim instead of being dropped.
"""

from __future__ import annotations

import re

from ..models import ScriptStep

#: const locators = (page: Page) => ({ ... });
FACTORY_RE = re.compile(r"const\s+locators\s*=\s*\([^)]*\)\s*=>\s*\(\{([\s\S]*?)\n\s*\}\)\s*;")
FACTORY_ENTRY_RE = re.compile(r"^\s*(\w+)\s*:\s*page\.(.+?),?\s*$")

TEST_RE = re.compile(r"^\s*test\s*\(\s*(['\"`])(.*?)\1")
BEFORE_RE = re.compile(r"^\s*test\.beforeEach\s*\(")
AFTER_RE = re.compile(r"^\s*test\.afterEach\s*\(")
DESCRIBE_RE = re.compile(r"^\s*test\.describe\s*\(\s*(['\"`])(.*?)\1")
STEP_RE = re.compile(r"test\.step\s*\(\s*(['\"`])(.*?)\1")

GOTO_RE = re.compile(r"page\.goto\s*\(\s*([^)]*?)\s*\)")
ROLE_RE = re.compile(r"getByRole\(\s*['\"](\w+)['\"](?:\s*,\s*\{[^}]*?name:\s*['\"](.*?)['\"])?")
PLACEHOLDER_RE = re.compile(r"getByPlaceholder\(\s*['\"](.*?)['\"]")
LABEL_RE = re.compile(r"getByLabel\(\s*['\"](.*?)['\"]")
TEXT_RE = re.compile(r"getByText\(\s*['\"](.*?)['\"]")
TESTID_RE = re.compile(r"getByTestId\(\s*['\"](.*?)['\"]")
RAW_LOCATOR_RE = re.compile(r"\blocator\(\s*['\"](.*?)['\"]")

EL_REF_RE = re.compile(r"\bel\.(\w+)")

#: Roles that read naturally as "<name> <role>" in a sentence.
SPOKEN_ROLES = {
    "button": "button",
    "link": "link",
    "checkbox": "checkbox",
    "radio": "radio button",
    "tab": "tab",
    "textbox": "field",
    "searchbox": "search box",
    "combobox": "dropdown",
    "option": "option",
    "heading": "heading",
    "menuitem": "menu item",
    "listitem": "list item",
}

ASSERTIONS = {
    "toBeVisible": "is visible",
    "toBeHidden": "is hidden",
    "toBeEnabled": "is enabled",
    "toBeDisabled": "is disabled",
    "toBeChecked": "is ticked",
    "toBeEmpty": "is empty",
    "toBeFocused": "is focused",
    "toHaveText": "shows the text",
    "toContainText": "contains the text",
    "toHaveValue": "holds the value",
    "toHaveCount": "appears this many times:",
    "toHaveTitle": "has the page title",
    "toHaveAttribute": "has the attribute",
}


def _factory(code: str) -> dict[str, str]:
    """Maps the locator names a test uses (el.loginButton) to their expressions."""
    block = FACTORY_RE.search(code)
    if not block:
        return {}

    found: dict[str, str] = {}
    for line in block.group(1).splitlines():
        if match := FACTORY_ENTRY_RE.match(line):
            found[match.group(1)] = match.group(2).strip().rstrip(",")
    return found


CONST_RE = re.compile(r"^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(['\"`])(.*?)\2\s*;", re.M)


def _string_consts(code: str) -> dict[str, str]:
    """Top-level string constants, so page.goto(TARGET_URL) can name the URL."""
    return {match.group(1): match.group(3) for match in CONST_RE.finditer(code)}


def _humanise_key(key: str) -> str:
    """loginButton -> login button."""
    spaced = re.sub(r"(?<!^)(?=[A-Z])", " ", key).lower()
    return spaced.replace("_", " ").strip()


def describe_locator(expression: str, factory: dict[str, str]) -> str:
    """A phrase a non-technical reader recognises: "the Login button"."""
    if match := EL_REF_RE.search(expression):
        key = match.group(1)
        expression = factory.get(key, "") or _humanise_key(key)

    if match := ROLE_RE.search(expression):
        role, name = match.group(1), (match.group(2) or "").strip()
        spoken = SPOKEN_ROLES.get(role, role)
        return f'the "{name}" {spoken}' if name else f"the {spoken}"
    if match := PLACEHOLDER_RE.search(expression):
        return f'the "{match.group(1)}" field'
    if match := LABEL_RE.search(expression):
        return f'the "{match.group(1)}" field'
    if match := TEXT_RE.search(expression):
        return f'the text "{match.group(1)}"'
    if match := TESTID_RE.search(expression):
        return f'the "{match.group(1)}" element'
    if match := RAW_LOCATOR_RE.search(expression):
        return f"the element matching {match.group(1)}"

    cleaned = expression.strip().rstrip(";")
    return f"the {cleaned}" if cleaned else "the element"


def _first_argument(line: str, call: str) -> str | None:
    """The literal passed to .fill('x') / .press('Enter') and friends."""
    match = re.search(rf"{call}\(\s*(['\"`])(.*?)\1", line)
    return match.group(2) if match else None


def _target_of(line: str, call: str, factory: dict[str, str]) -> str:
    before = line.split(call)[0]
    return describe_locator(before, factory)


def _url_expectation(line: str) -> str:
    match = re.search(r"toHaveURL\s*\(\s*(.+?)\s*\)\s*;?\s*$", line)
    if not match:
        return "the page URL is correct"
    pattern = match.group(1).strip().strip("'\"")
    return f"the page URL matches {pattern}"


def _classify(
    line: str, factory: dict[str, str], consts: dict[str, str]
) -> tuple[str, str, str, str | None] | None:
    """(action, text, target, value) for one source line, or None to skip it."""
    stripped = line.strip()
    if not stripped or stripped.startswith("//") or stripped.startswith("*"):
        return None

    if "AxeBuilder" in stripped and "new AxeBuilder" in stripped:
        return (
            "accessibility",
            "Scan the whole page for WCAG 2.1 A/AA accessibility problems",
            "the page",
            None,
        )

    if match := GOTO_RE.search(stripped):
        raw = match.group(1).strip()
        # page.goto(TARGET_URL) is the house style, so resolve the const rather
        # than telling the reader the test opens "the site".
        target = consts.get(raw) or raw.strip("'\"`")
        return ("navigate", f"Open {target}", target, None)

    if ".fill(" in stripped:
        target = _target_of(stripped, ".fill(", factory)
        value = _first_argument(stripped, r"\.fill") or ""
        return ("fill", f'Type "{value}" into {target}', target, value)

    if ".selectOption(" in stripped:
        target = _target_of(stripped, ".selectOption(", factory)
        value = _first_argument(stripped, r"\.selectOption") or ""
        return ("select", f'Choose "{value}" from {target}', target, value)

    if ".setInputFiles(" in stripped:
        target = _target_of(stripped, ".setInputFiles(", factory)
        value = _first_argument(stripped, r"\.setInputFiles") or ""
        return ("fill", f"Upload {value or 'a file'} to {target}", target, value)

    if ".check(" in stripped:
        target = _target_of(stripped, ".check(", factory)
        return ("check", f"Tick {target}", target, None)

    if ".uncheck(" in stripped:
        target = _target_of(stripped, ".uncheck(", factory)
        return ("check", f"Untick {target}", target, None)

    if ".press(" in stripped:
        target = _target_of(stripped, ".press(", factory)
        value = _first_argument(stripped, r"\.press") or ""
        return ("press", f'Press the {value} key on {target}', target, value)

    if ".hover(" in stripped:
        target = _target_of(stripped, ".hover(", factory)
        return ("click", f"Hover over {target}", target, None)

    if ".click(" in stripped:
        target = _target_of(stripped, ".click(", factory)
        return ("click", f"Click {target}", target, None)

    if "expect(" in stripped:
        if "toHaveURL" in stripped:
            return ("assert", f"Check {_url_expectation(stripped)}", "the page", None)
        if "violations" in stripped or re.search(r"expect\(\s*summary\s*\)", stripped):
            return (
                "assert",
                "Check that no accessibility violations were found",
                "the page",
                None,
            )

        matcher = next((name for name in ASSERTIONS if f".{name}(" in stripped), None)
        inner = re.search(r"expect\(\s*(.+?)\s*\)", stripped)
        target = describe_locator(inner.group(1), factory) if inner else "the page"
        if matcher:
            phrase = ASSERTIONS[matcher]
            argument = re.search(rf"\.{matcher}\(\s*(['\"`])(.*?)\1", stripped)
            suffix = f' "{argument.group(2)}"' if argument else ""
            return ("assert", f"Check {target} {phrase}{suffix}".rstrip(), target, None)
        return ("assert", f"Check {target}", target, None)

    return None


def parse_steps(code: str) -> list[ScriptStep]:
    """Every action in the file, in the order it runs."""
    if not code.strip():
        return []

    factory = _factory(code)
    consts = _string_consts(code)
    steps: list[ScriptStep] = []

    current_test = ""
    current_step = ""
    skipping = False

    for line in code.splitlines():
        if DESCRIBE_RE.match(line):
            continue

        if BEFORE_RE.match(line):
            current_test, current_step, skipping = "Setup — runs before each test", "", False
            continue
        if AFTER_RE.match(line):
            # Teardown is screenshot plumbing for failures; it is not part of
            # the scenario and only confuses a reader following the flow.
            skipping = True
            continue
        if match := TEST_RE.match(line):
            current_test, current_step, skipping = match.group(2), "", False
            continue

        if skipping:
            continue

        if match := STEP_RE.search(line):
            current_step = match.group(2)
            # A step whose body sits on the same line still needs classifying.

        classified = _classify(line, factory, consts)
        if not classified:
            continue

        action, text, target, value = classified
        steps.append(
            ScriptStep(
                index=len(steps) + 1,
                action=action,
                text=text,
                title=current_step,
                test=current_test,
                target=target,
                value=value,
            )
        )

    return steps
