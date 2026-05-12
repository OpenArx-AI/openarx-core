# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in OpenArx, please report it
privately rather than opening a public issue.

**Contact:** security@openarx.ai

When reporting, please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, ideally including affected versions, components,
  and a minimal proof-of-concept if possible.
- Your contact information if you would like updates or recognition.

## What to Expect

- **Acknowledgement** within 3 business days of your report.
- **Initial assessment** within 7 business days, including severity
  classification and likely timeline for a fix.
- **Updates** as the investigation and fix progress.
- **Coordinated disclosure** once a fix is available. We aim to credit
  reporters who follow this responsible disclosure process, unless they
  prefer to remain anonymous.

## Supported Versions

OpenArx is in Public Alpha (`v0.x.x`). Security fixes are applied to
the latest published release. Earlier alpha versions are not maintained.

## Scope

This policy covers the code in this repository — the MCP service, the
ingest pipeline, and supporting services.

Vulnerabilities in third-party dependencies should be reported to the
respective upstream maintainers. If a dependency vulnerability affects
OpenArx specifically and is not yet patched upstream, you may still
report it here so we can track mitigation.

## Out of Scope

- Issues that require physical access to a user's device or account.
- Denial-of-service attacks based purely on volume, without an
  underlying code-level weakness.
- Findings from automated scanners that have not been verified by a
  human and lack a clear demonstration of impact.
