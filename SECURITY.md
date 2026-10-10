# Security policy

## Report privately when possible

Do not publish credentials, private prompts/reports, or a working permission-bypass exploit in a public issue or PR.

Use GitHub's **Report a vulnerability** option in this repository's [Security tab](https://github.com/mothieras/pi-subagent/security) when private reporting is enabled. If that option is unavailable, open a minimal public issue requesting a private reporting channel, without exploit details or sensitive attachments. The maintainer must establish that channel before you share the report.

Include the affected tag/commit, Pi/Node versions, OS, minimal reproduction, expected boundary, and observed impact through the private channel. A local fake-provider reproduction is preferred; real credentials and paid inference should not be needed.

This is a small maintained project: reports are reviewed on a best-effort basis, with no promised response SLA. Reproduce on the latest tagged release or default branch when practical; fixes for older tags are not guaranteed.

## Relevant boundaries

Potential security defects include bypassing declared tool/call gates, running unapproved executable sources, granting approval in a non-interactive session, leaking retained configuration/credentials, or treating child output as new authority.

**The extension is not an OS sandbox.** Explicitly allowed shell tools, extensions, and MCP programs retain host permissions. Working directories and writer-collision checks do not constrain filesystem/network access. Those documented capabilities are not themselves permission-bypass vulnerabilities; use external OS/container isolation when that boundary is needed.

Cancellation and cleanup are best-effort. SIGKILL, system crashes, and deliberately detached/escaped processes cannot guarantee rollback or process cleanup. See the [API permission and lifecycle contract](docs/API.md).

## Maintainer handling

Confirm the affected contract, preserve a redacted reproducer, agree on disclosure timing where possible, and add regression coverage. Publish user-facing mitigation/fix notes in [CHANGELOG.md](CHANGELOG.md) without disclosing secrets or an unfixed exploit.
