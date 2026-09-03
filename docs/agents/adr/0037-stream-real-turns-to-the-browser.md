# Stream real turns to the browser

> **Review:** Human-approved

Version 0 streams a main harness turn to the browser while Pi produces it. The browser shows text,
tool calls, tool results, and terminal turn state as they arrive instead of waiting for one buffered
response.

The Supervisor must not treat an HTTP status or the start of a stream as a completed real turn. A
turn earns completion evidence only after Pi reaches terminal success and cf-stumble saves the
resulting thread state. The implementation must define and test what happens when the browser
disconnects; reconnect, steering, and background execution are separate choices rather than
reasons to remove streaming from version 0.
