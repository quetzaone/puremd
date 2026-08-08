# Preflight warning test

This fixture is intentionally unusual. Opening it should show the native
preflight warning before the document is rendered.

<script>this text must never execute</script>

<img src="https://example.invalid/tracker.png" onerror="this_must_never_run()">

[Unsafe JavaScript URI](javascript:alert('not executed'))

![Remote image](https://example.invalid/image.png)

The viewer's existing sanitizer, CSP, remote-image placeholder, and URL policy
remain the real protections. This file only exercises the warning UI.
