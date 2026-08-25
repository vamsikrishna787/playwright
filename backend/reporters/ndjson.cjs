/**
 * Streams a run as it happens.
 *
 * Playwright's json reporter only speaks once, at the end. This one emits a line
 * per event so the API can tell the browser which step is running and which was
 * the last to pass — the difference between a spinner and a progress list.
 *
 * Lines are prefixed so the parent can pick them out of whatever else Playwright
 * and the test itself print to stdout. CommonJS on purpose: the repo is ESM, and
 * Playwright loads a reporter path with require().
 */
const MARKER = '@@PWEVT@@';

function emit(event) {
  process.stdout.write(`${MARKER}${JSON.stringify(event)}\n`);
}

/** Playwright's own step errors carry terminal colour and a long stack. */
function cleanError(error) {
  if (!error) return null;
  const message = error.message || String(error);
  return message.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 4000);
}

class NdjsonReporter {
  // Keeps the `list` reporter's contract: we write to stdout, so Playwright
  // should not try to render a live terminal UI over the top of us.
  printsToStdio() {
    return true;
  }

  onBegin(_config, suite) {
    emit({ type: 'begin', total: suite.allTests().length });
  }

  onTestBegin(test) {
    emit({ type: 'testBegin', test: test.title });
  }

  onStepBegin(test, _result, step) {
    // Only the steps a human wrote. pw:api and expect steps would flood the
    // stream with internals nobody authored.
    if (step.category !== 'test.step') return;
    emit({ type: 'stepBegin', test: test.title, title: step.title });
  }

  onStepEnd(test, _result, step) {
    if (step.category !== 'test.step') return;
    emit({
      type: 'stepEnd',
      test: test.title,
      title: step.title,
      duration: step.duration,
      error: cleanError(step.error),
    });
  }

  onTestEnd(test, result) {
    emit({
      type: 'testEnd',
      test: test.title,
      status: result.status,
      duration: result.duration,
      error: cleanError(result.error),
    });
  }

  onError(error) {
    emit({ type: 'error', error: cleanError(error) });
  }

  onEnd(result) {
    emit({ type: 'end', status: result.status });
  }
}

module.exports = NdjsonReporter;
