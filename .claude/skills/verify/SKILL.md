---
name: verify
summary: Drive Cope's terminal interface through a real pseudo-terminal.
---

# Verify Cope terminal behavior

1. Build before launching: `npm run build`.
2. Run the public CLI through a PTY, not by importing CLI functions. Use Python's `pty.fork()`, set `TIOCSWINSZ`, then exec `node dist/src/cli/main.js demo`.
3. Capture raw stdout and strip ANSI only for the human-readable evidence excerpt.
4. For terminal UI changes, drive at least:
   - a wide session (110 columns), submit a task, then `/exit`;
   - a compact session (54 columns);
   - a resize while the prompt is active;
   - Ctrl+C while the prompt is active, expecting exit status 130.
5. Confirm the startup panel, framed task input, one-line footer, submitted user message, and clean close/cancel output are visible in the captured CLI output.

The demo command is side-effect free and is the preferred verification surface on non-Windows development machines.
