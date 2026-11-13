# Upstream-only tests, parked during the 0.6.1 integration

These `.parked` files test upstream features that Twig deliberately did not adopt
during the plugin-system milestone:

- `commit-input.test.tsx` — upstream's settings control contract where Escape
  commits the draft. Twig's ruling is Escape discards the draft; the Twig
  settings-dialog/controls tests cover that behavior.
- `headless-isolation.test.ts` — upstream's isolated-page browser service. Twig
  keeps its own sandboxed browser-service profile and native SVG rasterizer.
- `side-chat-*`, `side-conversation-*`, `side-plugin-*`, `side-thread-*`,
  `use-side-thread-*`, `side-chat.test.ts` — upstream's floating side companion
  and its rewritten core tests. Twig keeps inline side-question threads
  (`side-chat-flow`, `side-chat-ui`, `side-questions`).

The extension is `.parked` so neither `tsc` nor the test runner picks them up.
Re-enable or adapt them in the feature-reconciliation phase, after the host
wiring for the retained Twig implementation is final.
