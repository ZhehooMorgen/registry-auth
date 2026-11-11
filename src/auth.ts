import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type ICachePlugin,
} from "@azure/msal-node";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import open from "open";

export interface AuthOptions {
  nonInteractive?: boolean;
}

const defaultClientId = "d5a56ea4-7369-46b8-a538-c370805301bf";
const scopes = ["499b84ac-1321-427f-aa17-267ca6975798/.default"];
const applications = new Map<string, PublicClientApplication>();

async function createCachePlugin(): Promise<ICachePlugin | undefined> {
  let directory: string;
  switch (process.platform) {
    case "win32":
      directory = join(
        process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"),
        "registry-auth",
      );
      break;
    case "darwin":
      directory = join(homedir(), "Library", "Caches", "registry-auth");
      break;
    case "linux":
      directory = join(
        process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
        "registry-auth",
      );
      break;
    default:
      throw new Error("Unsupported platform for MSAL cache persistence");
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(directory, 0o700);

  try {
    const { DataProtectionScope, PersistenceCachePlugin, PersistenceCreator } =
      await import("@azure/msal-node-extensions");
    const persistence = await PersistenceCreator.createPersistence({
      cachePath: join(directory, "msal.cache"),
      dataProtectionScope: DataProtectionScope.CurrentUser,
      serviceName: "registry-auth",
      accountName: "msal",
      usePlaintextFileOnLinux: false,
    });
    return new PersistenceCachePlugin(persistence);
  } catch (error) {
    const { code, errorCode } = error as NodeJS.ErrnoException & {
      errorCode?: string;
    };
    if (process.platform !== "linux") throw error;
    const storageUnavailable =
      errorCode === "GnomeKeyringError" ||
      [
        "MODULE_NOT_FOUND",
        "ERR_MODULE_NOT_FOUND",
        "ERR_DLOPEN_FAILED",
      ].includes(code ?? "");
    if (!storageUnavailable) throw error;
    console.error(
      "System token storage is unavailable; using an in-memory cache for this run.",
    );
    return undefined;
  }
}

export async function getAccessToken(
  tenantId: string,
  options: AuthOptions = {},
): Promise<string> {
  const clientId = process.env.REGISTRY_AUTH_CLIENT_ID || defaultClientId;
  const key = `${tenantId}:${clientId}`;
  let app = applications.get(key);
  if (!app) {
    const cachePlugin = await createCachePlugin();
    app = new PublicClientApplication({
      auth: {
        clientId,
        authority: `https://login.microsoftonline.com/${tenantId}`,
      },
      cache: { cachePlugin },
    });
    applications.set(key, app);
  }

  const accounts = (await app.getAllAccounts()).filter(
    (account) => account.tenantId.toLowerCase() === tenantId.toLowerCase(),
  );
  if (accounts.length === 1) {
    try {
      const result = await app.acquireTokenSilent({
        account: accounts[0],
        scopes,
      });
      return result.accessToken;
    } catch (error) {
      if (!(error instanceof InteractionRequiredAuthError)) throw error;
    }
  }

  if (options.nonInteractive) {
    throw new Error(
      "Interactive sign-in is required. Run registry-auth without --non-interactive.",
    );
  }

  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  let choice: string;
  try {
    console.error(
      "1. Sign in with the system browser\n2. Sign in with a device code",
    );
    choice = (
      await terminal.question("Choose authentication method [1/2]: ")
    ).trim();
  } finally {
    terminal.close();
  }

  switch (choice) {
    case "1": {
      const result = await app.acquireTokenInteractive({
        scopes,
        prompt: "select_account",
        openBrowser: async (url) => {
          await open(url);
        },
      });
      return result.accessToken;
    }
    case "2": {
      const result = await app.acquireTokenByDeviceCode({
        scopes,
        deviceCodeCallback: (response) => {
          console.error(response.message);
        },
      });
      if (!result) throw new Error("Device code sign-in did not complete");
      return result.accessToken;
    }
    default:
      throw new Error("Invalid authentication method; choose 1 or 2");
  }
}
