# Security policy

## Supported versions

Security fixes are developed on the latest release. Version 0.1.x supports OpenCode CLI `>=2.0.26 <2.1.0`.

## Reporting a vulnerability

Please use GitHub's private **Report a vulnerability** feature for this repository. Do not open a public issue with exploit details. Include the affected version, a concise impact description, and a safe reproduction when possible.

## Data handling

The plugin has no telemetry and makes no network requests of its own. It stores queue metadata using OpenCode plugin storage and writes its non-secret configuration locally. Prompts are sent only through the OpenCode session and provider selected by the user.
