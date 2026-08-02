/**
 * Browser-side code, shipped as source strings so the same element description
 * and locator-building logic serves both the scraper and the recorder.
 *
 * Constraints: this runs inside the page, so it must be plain ES5-ish DOM code
 * with no imports, no backticks and no template placeholders.
 */

/** Defines window.__pwgen — element description, naming, and locator building. */
export const PAGE_AGENT = String.raw`
(() => {
  if (window.__pwgen) return;

  var SELECTOR = [
    'a[href]', 'button', 'input:not([type=hidden])', 'select', 'textarea',
    '[role=button]', '[role=link]', '[role=tab]', '[role=checkbox]', '[role=radio]',
    '[role=switch]', '[role=combobox]', '[role=menuitem]', '[role=searchbox]',
    '[role=textbox]', '[contenteditable=true]', 'summary'
  ].join(', ');

  var INTERACTIVE = SELECTOR + ', label, [onclick]';

  var clean = function (text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  };

  var visible = function (node) {
    var rect = node.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    var style = window.getComputedStyle(node);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };

  /* The <label> text associated with a form control, which is what getByLabel matches. */
  var labelOf = function (node) {
    var id = node.getAttribute('id');
    if (id) {
      var forLabel = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
      if (forLabel && clean(forLabel.textContent)) return clean(forLabel.textContent);
    }
    var wrapping = node.closest ? node.closest('label') : null;
    if (wrapping && clean(wrapping.textContent)) return clean(wrapping.textContent);
    return '';
  };

  var accessibleName = function (node) {
    var aria = node.getAttribute('aria-label');
    if (aria) return clean(aria);

    var labelledBy = node.getAttribute('aria-labelledby');
    if (labelledBy) {
      var parts = labelledBy.split(/\s+/).map(function (id) {
        var target = document.getElementById(id);
        return target ? clean(target.textContent) : '';
      }).filter(Boolean);
      if (parts.length) return parts.join(' ');
    }

    var label = labelOf(node);
    if (label) return label;

    var alt = node.getAttribute('alt');
    if (alt) return clean(alt);

    var tag = node.tagName;
    if (tag === 'INPUT') {
      var type = (node.getAttribute('type') || '').toLowerCase();
      if ((type === 'submit' || type === 'button' || type === 'reset') && node.value) {
        return clean(node.value);
      }
      /* A text input takes its name from a label or ARIA only. Falling back to
         surrounding text would invent a name no locator can ever match. */
      return '';
    }
    if (tag === 'SELECT' || tag === 'TEXTAREA') return '';

    var title = node.getAttribute('title');
    var text = clean(node.textContent);
    if (!text && title) return clean(title);
    return text.slice(0, 80);
  };

  var roleOf = function (node) {
    var explicit = node.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];

    var tag = node.tagName.toLowerCase();
    if (tag === 'a') return node.hasAttribute('href') ? 'link' : '';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return node.hasAttribute('multiple') ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'input') {
      var type = (node.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'search') return 'searchbox';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'file') return 'button';
      return 'textbox';
    }
    return '';
  };

  var quote = function (value) {
    return "'" + String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  };

  /* Whatever testIdAttribute the host project's playwright config declares.
     Set by the capture script; Playwright's own default is data-testid. */
  var testIdAttribute = function () {
    return window.__pwTestIdAttribute || 'data-testid';
  };

  var TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy'];

  /* Locator priority follows Playwright's own guidance: test id, then the
     accessible role plus name, then label, then placeholder. Everything after
     that is a fallback that should be treated as suspect. */
  var locatorFor = function (info) {
    if (info.testId) {
      /* getByTestId only reads the attribute the project configured (default
         data-testid). Emitting it for a data-test attribute produces a locator
         that silently matches nothing, so anything else becomes an explicit
         attribute selector instead. */
      if (info.testIdAttr === testIdAttribute()) return 'getByTestId(' + quote(info.testId) + ')';
      return 'locator(' + quote('[' + info.testIdAttr + '=' + JSON.stringify(info.testId) + ']') + ')';
    }
    if (info.role && info.name) {
      return 'getByRole(' + quote(info.role) + ', { name: ' + quote(info.name) + ' })';
    }
    if (info.label) return 'getByLabel(' + quote(info.label) + ')';
    if (info.placeholder) return 'getByPlaceholder(' + quote(info.placeholder) + ')';
    if (info.title) return 'getByTitle(' + quote(info.title) + ')';
    if (info.role) return 'getByRole(' + quote(info.role) + ')';
    if (info.name) return 'getByText(' + quote(info.name) + ')';
    /* Attribute form rather than #id: ids containing a colon or a dot are legal
       in HTML but are not valid CSS id selectors. */
    if (info.id) return 'locator(' + quote('[id=' + JSON.stringify(info.id) + ']') + ')';
    if (info.tag) return 'locator(' + quote(info.tag) + ')';
    return '';
  };

  var describe = function (node) {
    if (!node || node.nodeType !== 1) return null;

    var tag = node.tagName.toLowerCase();
    var testId = '';
    var testIdAttr = '';
    var attrs = [testIdAttribute()].concat(TEST_ID_ATTRS);
    for (var a = 0; a < attrs.length; a++) {
      var value = node.getAttribute(attrs[a]);
      if (value) {
        testId = value;
        testIdAttr = attrs[a];
        break;
      }
    }

    var info = {
      tag: tag,
      role: roleOf(node),
      name: accessibleName(node),
      label: labelOf(node),
      placeholder: node.getAttribute('placeholder') || '',
      title: node.getAttribute('title') || '',
      type: (node.getAttribute('type') || '').toLowerCase(),
      id: node.getAttribute('id') || '',
      testId: testId,
      testIdAttr: testIdAttr,
      required: node.hasAttribute('required') || node.getAttribute('aria-required') === 'true',
      disabled: node.hasAttribute('disabled'),
      href: tag === 'a' ? (node.getAttribute('href') || '') : '',
      options: null
    };

    if (tag === 'select') {
      info.options = Array.prototype.slice.call(node.options || [], 0, 15).map(function (option) {
        return clean(option.label || option.value);
      });
    }

    info.locator = locatorFor(info);
    /* Only value-bearing controls can leak a credential — a link named "Reset
       password" is not a secret, and flagging it would train the reader to
       ignore the marker. */
    var holdsValue = tag === 'input' || tag === 'textarea' || node.isContentEditable;
    info.secret =
      holdsValue &&
      (info.type === 'password' ||
        /pass(word|code)|secret|token|otp|cvv|cvc|card ?number|ssn/i.test(
          info.name + ' ' + info.label + ' ' + info.placeholder + ' ' + info.id
        ));
    return info;
  };

  /* The clicked node is often a span inside the button. Walk up to the thing a
     test would actually address. */
  var interactiveAncestor = function (node) {
    if (!node || !node.closest) return node;
    return node.closest(INTERACTIVE) || node;
  };

  var harvest = function (limit) {
    var nodes = Array.prototype.slice.call(document.querySelectorAll(SELECTOR));
    var out = [];
    for (var i = 0; i < nodes.length && out.length < (limit || 150); i++) {
      if (!visible(nodes[i])) continue;
      var info = describe(nodes[i]);
      if (!info || !info.locator) continue;
      if (!info.name && !info.placeholder && !info.testId && !info.label && !info.id) continue;
      out.push(info);
    }
    return out;
  };

  var context = function () {
    var headings = Array.prototype.slice.call(document.querySelectorAll('h1, h2'), 0, 12)
      .map(function (node) { return clean(node.textContent); })
      .filter(Boolean);
    var landmarks = Array.prototype.slice.call(
      document.querySelectorAll('main, nav, header, footer, [role=main], [role=navigation]')
    ).map(function (node) { return node.tagName.toLowerCase(); });
    return { title: document.title, headings: headings, landmarks: landmarks };
  };

  window.__pwgen = {
    harvest: harvest,
    describe: describe,
    locatorFor: locatorFor,
    interactiveAncestor: interactiveAncestor,
    context: context
  };
})();
`;

/**
 * Defines the recorder. Listens in the capture phase so the page's own handlers
 * cannot swallow an interaction before it is seen, and reports every step
 * through the __pwRecordStep binding.
 *
 * Password-ish values are masked here, inside the browser, so a real credential
 * never reaches the Node process or the transcript at all.
 */
export const RECORDER_AGENT = String.raw`
(() => {
  if (window.__pwrec) return;
  window.__pwrec = true;

  var MASK = '<<REDACTED>>';

  var send = function (step) {
    try {
      step.url = location.href;
      step.at = Date.now();
      window.__pwRecordStep(step);
    } catch (err) { /* binding not ready yet, or page tearing down */ }
  };

  var describe = function (node) {
    return window.__pwgen ? window.__pwgen.describe(node) : null;
  };

  var resolveTarget = function (node) {
    if (!node) return null;
    return window.__pwgen ? window.__pwgen.interactiveAncestor(node) : node;
  };

  var valueOf = function (element, info) {
    if (info && info.secret && !window.__pwKeepSecrets) return MASK;
    return String(element.value == null ? '' : element.value).slice(0, 200);
  };

  document.addEventListener('click', function (event) {
    var node = resolveTarget(event.target);
    var info = describe(node);
    if (!info || !info.locator) return;
    /* Typing into a field fires no click, but focusing an autocomplete does —
       keep both, the click is often what opens the suggestion list. */
    send({ kind: 'click', element: info });
  }, true);

  document.addEventListener('input', function (event) {
    var element = event.target;
    if (!element || !element.tagName) return;
    var tag = element.tagName.toLowerCase();
    if (tag !== 'input' && tag !== 'textarea' && !element.isContentEditable) return;

    var type = (element.getAttribute('type') || 'text').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return;

    var info = describe(element);
    if (!info || !info.locator) return;
    send({ kind: 'fill', element: info, value: valueOf(element, info) });
  }, true);

  document.addEventListener('change', function (event) {
    var element = event.target;
    if (!element || !element.tagName) return;
    var tag = element.tagName.toLowerCase();
    var info = describe(element);
    if (!info || !info.locator) return;

    if (tag === 'select') {
      var chosen = Array.prototype.slice.call(element.selectedOptions || []).map(function (option) {
        return { label: (option.label || option.text || '').trim(), value: option.value };
      });
      send({ kind: 'selectOption', element: info, options: chosen });
      return;
    }

    var type = (element.getAttribute('type') || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      send({ kind: element.checked ? 'check' : 'uncheck', element: info });
    }
  }, true);

  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    var info = describe(resolveTarget(event.target));
    send({ kind: 'press', key: event.key, element: info });
  }, true);
})();
`;
