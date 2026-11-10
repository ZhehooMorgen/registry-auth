import type { NpmConfig } from "./utility.ts";

const adoRegistryDomain = "pkgs.dev.azure.com";
const legacyAdoRegistryDomain = "pkgs.visualstudio.com";

enum RegistryType {
  Unknown,
  Ado,
  AdoLegacy,
}

export async function verifyPat(
  registryUrl: string,
  patConfig: NpmConfig,
): Promise<boolean> {
  const url = new URL(registryUrl);
  const pathSegments = url.pathname.split("/").slice(1);
  if (pathSegments.at(-1) === "") pathSegments.pop();
  const pathPrefix = pathSegments.slice(0, -4);
  const [packaging, feed, npm, registry] = pathSegments.slice(-4);
  let apiOrigin: string;

  if (url.host === adoRegistryDomain) {
    if (pathPrefix.length !== 1 && pathPrefix.length !== 2) {
      throw new Error("Invalid Azure DevOps organization/project path");
    }
    apiOrigin = "https://feeds.dev.azure.com";
  } else if (url.host.endsWith(`.${legacyAdoRegistryDomain}`)) {
    if (pathPrefix.length > 1) {
      throw new Error("Invalid legacy Azure DevOps project path");
    }
    const organization = url.host.slice(
      0,
      -`.${legacyAdoRegistryDomain}`.length,
    );
    apiOrigin = `https://${organization}.feeds.visualstudio.com`;
  } else {
    throw new Error("Not supported registry type!");
  }

  if (
    pathSegments.some((segment) => segment === "") ||
    packaging !== "_packaging" ||
    !feed ||
    npm !== "npm" ||
    registry !== "registry"
  ) {
    throw new Error("Invalid Azure DevOps registry path");
  }
  const feedUrl = new URL(apiOrigin);
  feedUrl.pathname = [...pathPrefix, "_apis", "packaging", "feeds", feed].join(
    "/",
  );
  feedUrl.searchParams.set("api-version", "7.1");

  const pat = Buffer.from(patConfig.value, "base64").toString("utf8").trim();
  if (!pat) return false;

  const response = await fetch(feedUrl, {
    headers: {
      Authorization: `Basic ${Buffer.from(`me:${pat}`).toString("base64")}`,
      Accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();

  if (response.status === 401) return false;
  if (response.status !== 200) {
    throw new Error(`PAT verification failed: HTTP ${response.status}`);
  }
  return true;
}

export async function createPat(registryUrl: string): Promise<string> {
  // Placeholder implementation
  return "PLACEHOLDER_PAT";
}
