# registry-auth

Authenticate npm with Azure Artifacts. Requires Node.js 22 or later.

## Install

```sh
npm install -g registry-auth
```

## Use

Run from a project whose `.npmrc` contains an Azure Artifacts registry URL.
Your user-level `.npmrc` must also exist (`~/.npmrc`, or `%USERPROFILE%\.npmrc`
on Windows); create an empty file if needed.

```sh
cd /path/to/your/project
registry-auth
npm install
```

When prompted, enter **1** to sign in with your system browser, or **2** to use a
device code from another device (useful over SSH).

Existing valid credentials are reused. New credentials are saved to your user
configuration; existing project credentials are updated in place. Generated PATs
last seven days and request package read/write access, including publishing and
saving upstream packages, subject to your feed permissions.
Run `registry-auth` again when credentials expire.

Verbose output is disabled by default. Use `registry-auth --verbose` to enable it.
Use `registry-auth --version` (or `-v`) to print the installed version.

## Non-interactive Use

For scripts that must not prompt:

```sh
registry-auth --non-interactive
```

The short form is `registry-auth -N`. The command exits with an error if sign-in
is required. Run `registry-auth --help` to see available options.

## Development

Requires Node.js 24 or later to run tests.

```sh
npm install
npm run build
npm link
npm test
```
