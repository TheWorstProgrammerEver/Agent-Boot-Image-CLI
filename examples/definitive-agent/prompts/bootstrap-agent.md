# Bootstrap {{agent-name}}

Audit the deterministic setup already completed from the configured working
root. Confirm only that the workspace marker and declared credential path are
present; never read credential contents. Write the single line
`agent bootstrap verified` to `bootstrap-report.txt`.

Do not install packages, change services, alter the Codex permission profile,
or expose credential material in output. Those deterministic operations belong
to explicit runner steps.
