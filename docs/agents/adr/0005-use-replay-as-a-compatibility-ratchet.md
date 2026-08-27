# Use replay as an executor-compatibility ratchet

Recorded model responses validate whether a candidate executor preserves tool calls and workspace effects, not whether a changed prompt is better: the tape came from the old prompt and would otherwise approve a prompt-only change without exercising it. Promotion therefore rejects regressions from the live generation and separately requires supervisor-pinned canaries to pass; prompt-quality evaluation needs fresh, scored trials and remains a different future mechanism.
