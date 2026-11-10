import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, beforeEach, mock, test } from "node:test";

const directory = await mkdtemp(join(tmpdir(), "registry-auth-test-"));
const platform = Object.getOwnPropertyDescriptor(process, "platform");
const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalError = console.error;
const environmentKeys = [
  "HOME",
  "LOCALAPPDATA",
  "XDG_CACHE_HOME",
  "REGISTRY_AUTH_CLIENT_ID",
];
const originalEnv = Object.fromEntries(
  environmentKeys.map((name) => [name, process.env[name]]),
);
const originalArgv = process.argv;
const originalCwd = process.cwd();
const clientId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
let sequence = 0;
let state;

function nextTenant() {
  return `11111111-2222-4333-8444-${String(++sequence).padStart(12, "0")}`;
}

class InteractionRequiredAuthError extends Error {}

mock.module("@azure/msal-node", {
  namedExports: {
    InteractionRequiredAuthError,
    PublicClientApplication: class {
      constructor(config) {
        state.appConfigs.push(config);
      }
      async getAllAccounts() {
        return state.accounts;
      }
      async acquireTokenSilent(request) {
        state.silentRequests.push(request);
        if (state.silentError) throw state.silentError;
        return { accessToken: "fake-entra-token" };
      }
      async acquireTokenInteractive(request) {
        state.methods.push("browser");
        await request.openBrowser("https://login.microsoftonline.com/test");
        return { accessToken: "fake-entra-token" };
      }
      async acquireTokenByDeviceCode(request) {
        state.methods.push("device-code");
        request.deviceCodeCallback({ message: "fake device-code message" });
        return { accessToken: "fake-entra-token" };
      }
    },
  },
});

mock.module("@azure/msal-node-extensions", {
  namedExports: {
    DataProtectionScope: { CurrentUser: "CurrentUser" },
    PersistenceCreator: {
      async createPersistence(config) {
        state.persistenceConfigs.push(config);
        if (state.persistenceError) throw state.persistenceError;
        return { kind: "system" };
      },
    },
    PersistenceCachePlugin: class {
      constructor(persistence) {
        this.persistence = persistence;
      }
    },
  },
});

mock.module("node:readline/promises", {
  namedExports: {
    createInterface: () => ({
      async question() {
        state.prompts++;
        return state.choice;
      },
      close() {
        state.closed++;
      },
    }),
  },
});
mock.module("open", {
  defaultExport: async (url) => {
    state.opened.push(url);
  },
});

const { getAccessToken } = await import("../dist/auth.js");
const { createPat, verifyPat } = await import("../dist/ado.js");

beforeEach(() => {
  state = {
    accounts: [],
    appConfigs: [],
    silentRequests: [],
    methods: [],
    opened: [],
    persistenceConfigs: [],
    messages: [],
    prompts: 0,
    closed: 0,
    choice: "1",
  };
  process.env.HOME = directory;
  process.env.LOCALAPPDATA = directory;
  process.env.XDG_CACHE_HOME = directory;
  process.env.REGISTRY_AUTH_CLIENT_ID = clientId;
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  });
  console.log = console.error = (message) => {
    state.messages.push(String(message));
  };
  globalThis.fetch = async () => {
    throw new Error("Unexpected network request");
  };
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  if (tty) Object.defineProperty(process.stdin, "isTTY", tty);
  else delete process.stdin.isTTY;
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.error = originalError;
  process.argv = originalArgv;
  process.chdir(originalCwd);
  process.exitCode = 0;
  for (const name of environmentKeys) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
});
after(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("silent sign-in uses the matching tenant and reuses the client without UI", async () => {
  const tenant = nextTenant();
  state.accounts = [{ tenantId: nextTenant() }, { tenantId: tenant }];
  assert.equal(
    await getAccessToken(tenant, { nonInteractive: true }),
    "fake-entra-token",
  );
  await getAccessToken(tenant);
  assert.equal(state.appConfigs.length, 1);
  assert.equal(state.appConfigs[0].auth.clientId, clientId);
  assert.equal(state.appConfigs[0].broker, undefined);
  assert.equal(state.silentRequests[0].account, state.accounts[1]);
  assert.deepEqual(state.silentRequests[0].scopes, [
    "499b84ac-1321-427f-aa17-267ca6975798/.default",
  ]);
  assert.equal(state.prompts, 0);
});

test("interaction-required offers browser and device code, and closes the menu", async () => {
  for (const [choice, method] of [
    ["1", "browser"],
    ["2", "device-code"],
  ]) {
    const tenant = nextTenant();
    state.accounts = [{ tenantId: tenant }];
    state.silentError = new InteractionRequiredAuthError("Sign in again");
    state.choice = choice;
    assert.equal(await getAccessToken(tenant), "fake-entra-token");
    assert.equal(state.methods.at(-1), method);
  }
  assert.equal(state.closed, 2);
  assert.equal(state.opened.length, 1);
  assert.ok(state.messages.includes("fake device-code message"));
  state.choice = "9";
  await assert.rejects(
    getAccessToken(nextTenant()),
    /Invalid authentication method/,
  );
  assert.equal(state.closed, 3);
});

test("non-interactive, ambiguous accounts and no TTY never start a login", async () => {
  await assert.rejects(
    getAccessToken(nextTenant(), { nonInteractive: true }),
    /Interactive sign-in is required/,
  );
  const tenant = nextTenant();
  state.accounts = [{ tenantId: tenant }, { tenantId: tenant }];
  await assert.rejects(
    getAccessToken(tenant, { nonInteractive: true }),
    /Interactive sign-in is required/,
  );
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: false,
  });
  await assert.rejects(
    getAccessToken(nextTenant()),
    /Interactive sign-in is required/,
  );
  assert.equal(state.prompts, 0);
  assert.deepEqual(state.methods, []);
});

test("network or configuration errors from silent auth propagate without prompting", async () => {
  const tenant = nextTenant();
  state.accounts = [{ tenantId: tenant }];
  const failure = new Error("network unavailable");
  state.silentError = failure;
  await assert.rejects(getAccessToken(tenant), (error) => error === failure);
  assert.equal(state.prompts, 0);
});

test("system cache uses platform storage and the registry-auth namespace", async () => {
  for (const name of ["win32", "darwin", "linux"]) {
    Object.defineProperty(process, "platform", { value: name });
    const tenant = nextTenant();
    state.accounts = [{ tenantId: tenant }];
    await getAccessToken(tenant);
    const config = state.persistenceConfigs.at(-1);
    assert.ok(config.cachePath.endsWith(join("registry-auth", "msal.cache")));
    assert.equal(config.dataProtectionScope, "CurrentUser");
    assert.equal(config.usePlaintextFileOnLinux, false);
    assert.equal(config.serviceName, "registry-auth");
    assert.equal(config.accountName, "msal");
  }
  assert.equal(state.persistenceConfigs.length, 3);
});

test("Linux does not persist tokens when encrypted storage is unavailable", async () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  process.env.XDG_CACHE_HOME = join(directory, "headless");
  for (const reason of [
    { errorCode: "GnomeKeyringError" },
    { code: "MODULE_NOT_FOUND" },
    { code: "ERR_MODULE_NOT_FOUND" },
    { code: "ERR_DLOPEN_FAILED" },
  ]) {
    state.persistenceError = Object.assign(
      new Error("Encrypted storage unavailable"),
      reason,
    );
    assert.equal(await getAccessToken(nextTenant()), "fake-entra-token");
    assert.equal(state.appConfigs.at(-1).cache.cachePlugin, undefined);
  }
  assert.equal(state.methods.length, 4);
  assert.ok(
    state.persistenceConfigs.every(
      (config) => config.usePlaintextFileOnLinux === false,
    ),
  );
  assert.deepEqual(
    await readdir(join(process.env.XDG_CACHE_HOME, "registry-auth")),
    [],
  );
});

test("PAT creation discovers the tenant, preserves endpoint style and returns Base64", async () => {
  for (const [host, tokenOrigin] of [
    ["pkgs.dev.azure.com/example", "vssps.dev.azure.com/example"],
    ["example.pkgs.visualstudio.com", "example.vssps.visualstudio.com"],
  ]) {
    const tenant = nextTenant();
    state.accounts = [{ tenantId: tenant }];
    const registry = `https://${host}/project/_packaging/feed/npm/registry/`;
    let requests = 0;
    globalThis.fetch = async (url, options) => {
      requests++;
      assert.equal(options.redirect, "error");
      if (requests === 1) {
        assert.equal(String(url), registry);
        assert.equal(options.headers.Authorization, undefined);
        return new Response(null, {
          status: 401,
          headers: { "X-VSS-ResourceTenant": tenant },
        });
      }
      assert.equal(
        String(url),
        `https://${tokenOrigin}/_apis/tokens/pats?api-version=7.1-preview.1`,
      );
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, "Bearer fake-entra-token");
      const body = JSON.parse(options.body);
      assert.equal(body.scope, "vso.packaging_write");
      assert.equal(body.allOrgs, false);
      assert.ok(
        Math.abs(Date.parse(body.validTo) - Date.now() - 7 * 86_400_000) < 5000,
      );
      return Response.json({
        patToken: { token: "fake-new-pat" },
        patTokenError: "none",
      });
    };
    assert.equal(
      await createPat(registry, { nonInteractive: true }),
      Buffer.from("fake-new-pat").toString("base64"),
    );
    assert.equal(requests, 2);
  }
  assert.ok(
    !state.messages.some(
      (message) =>
        message.includes("fake-entra-token") ||
        message.includes("fake-new-pat"),
    ),
  );
});

test("discovery and creation failures do not produce replacement credentials", async () => {
  const registry =
    "https://pkgs.dev.azure.com/example/_packaging/feed/npm/registry/";
  globalThis.fetch = async () => new Response(null, { status: 500 });
  await assert.rejects(
    createPat(registry),
    /tenant discovery failed: HTTP 500/,
  );
  globalThis.fetch = async () => new Response(null, { status: 401 });
  await assert.rejects(
    createPat(registry),
    /did not identify a Microsoft Entra tenant/,
  );
  assert.equal(state.appConfigs.length, 0);
  const tenant = nextTenant();
  state.accounts = [{ tenantId: tenant }];
  for (const result of [
    new Response(null, { status: 403 }),
    Response.json({ patTokenError: "accessDenied" }),
  ]) {
    globalThis.fetch = async (_url, options) =>
      options.method === "POST"
        ? result
        : new Response(null, {
            status: 401,
            headers: { "X-VSS-ResourceTenant": tenant },
          });
    await assert.rejects(
      createPat(registry),
      /PAT creation failed: HTTP 403|did not return a PAT/,
    );
  }
});

test("verification retains decoded Basic auth and HTTP failure semantics", async () => {
  const registry =
    "https://example.pkgs.visualstudio.com/project/_packaging/feed/npm/registry/";
  const pat = {
    name: "_password",
    value: Buffer.from("fake-pat").toString("base64"),
    position: { line: 0 },
  };
  for (const status of [200, 401, 403, 404, 500]) {
    globalThis.fetch = async (url, options) => {
      assert.equal(
        String(url),
        "https://example.feeds.visualstudio.com/project/_apis/packaging/feeds/feed?api-version=7.1",
      );
      assert.equal(
        options.headers.Authorization,
        `Basic ${Buffer.from("me:fake-pat").toString("base64")}`,
      );
      return new Response(null, { status });
    };
    if (status === 200 || status === 401)
      assert.equal(await verifyPat(registry, pat), status === 200);
    else
      await assert.rejects(
        verifyPat(registry, pat),
        new RegExp(`HTTP ${status}`),
      );
  }
  for (const url of [
    "https://example.test/",
    "https://pkgs.dev.azure.com:12345/example/_packaging/feed/npm/registry/",
  ]) {
    await assert.rejects(verifyPat(url, pat), /Not supported registry type/);
  }
});

test("CLI makes verbose output opt-in and passes -N without changing configuration", async () => {
  const project = join(directory, "project");
  await mkdir(project);
  const original =
    "registry=https://pkgs.dev.azure.com/example/_packaging/feed/npm/registry/\n";
  await writeFile(join(project, ".npmrc"), original);
  await writeFile(join(directory, ".npmrc"), "");
  process.chdir(project);
  for (const flags of [[], ["--verbose"], ["-v"]]) {
    state.messages = [];
    process.exitCode = 0;
    process.argv = [process.execPath, "registry-auth", "-N", ...flags];
    const tenant = nextTenant();
    globalThis.fetch = async (_url, options) => {
      assert.notEqual(options.method, "POST");
      return new Response(null, {
        status: 401,
        headers: { "X-VSS-ResourceTenant": tenant },
      });
    };
    await import(
      new URL(`../dist/main.js?noninteractive=${sequence}`, import.meta.url)
    );
    assert.equal(process.exitCode, 1);
    assert.equal(state.prompts, 0);
    assert.equal(
      state.messages.includes("verbose: @zhehoo/registry-auth"),
      flags.length > 0,
    );
    assert.equal(
      state.messages.filter((message) => !message.startsWith("verbose: "))
        .length,
      1,
    );
    assert.ok(
      state.messages.some((message) =>
        message.startsWith("Interactive sign-in is required."),
      ),
    );
    assert.equal(await readFile(join(project, ".npmrc"), "utf8"), original);
    assert.equal(await readFile(join(directory, ".npmrc"), "utf8"), "");
  }
});
