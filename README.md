# registry-auth

Requires Node.js 22 or later. Run `registry-auth` from a project containing an
`.npmrc` file. Existing credentials are checked before new credentials are created.

## Authentication

Authentication uses MSAL Node, without Azure CLI or a native broker. The tool
discovers the Microsoft Entra tenant from the Azure Artifacts feed, then attempts
silent sign-in using its own cache. If interactive sign-in is required, choose:

1. System browser sign-in.
2. Device code sign-in, which can be completed in a browser on another device.

```sh
registry-auth --non-interactive
registry-auth -N
```

Non-interactive mode allows silent token refresh but never prompts or opens a
browser. It exits unsuccessfully when sign-in is required. Network and configuration
errors are reported directly, rather than starting an interactive login.

The default public client ID is the Azure Artifacts client used by
`vsts-npm-auth`: `d5a56ea4-7369-46b8-a538-c370805301bf`. Set
`REGISTRY_AUTH_CLIENT_ID` to use your own public client registration. Browser sign-in
requires the `http://localhost` redirect URI, and device code sign-in requires public
client flows. The registration, tenant consent and organization policies must allow
Azure DevOps access and PAT creation; the Microsoft-owned registration is not under
this project's control.

Created PATs are organization-scoped, valid for one day, and have the
`vso.packaging` read scope. This does not grant publishing or saving new packages
from upstream sources. PATs are Base64-encoded before writing `_password` entries.
No PAT or access token is printed. The project and user `.npmrc` files must already
exist; existing project credentials are updated in place, while new credentials
are added to the user file.

## Token Cache

- Windows: DPAPI `CurrentUser`, under `%LOCALAPPDATA%/registry-auth/msal.cache`.
- macOS: Keychain, with a synchronization file under
  `~/Library/Caches/registry-auth/msal.cache`.
- Linux: Secret Service via libsecret, with a synchronization file under
  `$XDG_CACHE_HOME/registry-auth/msal.cache` (default `~/.cache/registry-auth`).

The Keychain/Secret Service entry uses service `registry-auth` and account `msal`.
These are user-level storage protections, not isolation from all other processes
running as the same user. The cache is separate from other authentication tools.

If the Linux keyring or its native dependencies are unavailable, tokens are kept
only in memory for the current run. No plaintext token cache is written to disk.

## Development

```sh
npm install
npm run build
npm link
npm test
```

Tests require Node.js 24 or later for module mocking. They simulate MSAL, system
credential storage, and HTTP requests; they do not sign in or modify real credentials.
