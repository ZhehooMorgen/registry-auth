import { getAccessToken, type AuthOptions } from "./auth.ts";
import type { NpmConfig } from "./utility.ts";

const adoRegistryDomain = "pkgs.dev.azure.com";
const legacyAdoRegistryDomain = "pkgs.visualstudio.com";

function getAdoEndpoints(registryUrl: string) {
  const url = new URL(registryUrl);
  if (url.protocol !== "https:") {
    throw new Error("Azure DevOps registry must use HTTPS");
  }
  const pathSegments = url.pathname.split("/").slice(1);
  if (pathSegments.at(-1) === "") pathSegments.pop();
  const pathPrefix = pathSegments.slice(0, -4);
  const [packaging, feed, npm, registry] = pathSegments.slice(-4);
  let apiOrigin: string;
  let patUrl: URL;

  if (url.host === adoRegistryDomain) {
    if (pathPrefix.length !== 1 && pathPrefix.length !== 2) {
      throw new Error("Invalid Azure DevOps organization/project path");
    }
    apiOrigin = "https://feeds.dev.azure.com";
    patUrl = new URL(
      `https://vssps.dev.azure.com/${pathPrefix[0]}/_apis/tokens/pats`,
    );
  } else if (url.host.endsWith(`.${legacyAdoRegistryDomain}`)) {
    if (pathPrefix.length > 1) {
      throw new Error("Invalid legacy Azure DevOps project path");
    }
    const organization = url.host.slice(
      0,
      -`.${legacyAdoRegistryDomain}`.length,
    );
    apiOrigin = `https://${organization}.feeds.visualstudio.com`;
    patUrl = new URL(
      `https://${organization}.vssps.visualstudio.com/_apis/tokens/pats`,
    );
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
  patUrl.searchParams.set("api-version", "7.1-preview.1");
  return { feedUrl, patUrl };
}

export async function verifyPat(
  registryUrl: string,
  patConfig: NpmConfig,
): Promise<boolean> {
  const { feedUrl } = getAdoEndpoints(registryUrl);
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

export async function createPat(
  registryUrl: string,
  options: AuthOptions = {},
): Promise<string> {
  const { patUrl } = getAdoEndpoints(registryUrl);
  const probe = await fetch(registryUrl, {
    headers: { "X-TFS-FedAuthRedirect": "Suppress" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const tenantId = probe.headers.get("X-VSS-ResourceTenant");
  await probe.body?.cancel();
  if (probe.status !== 200 && probe.status !== 401) {
    throw new Error(`ADO tenant discovery failed: HTTP ${probe.status}`);
  }
  if (
    !tenantId ||
    !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(
      tenantId,
    ) ||
    tenantId === "00000000-0000-0000-0000-000000000000"
  ) {
    throw new Error(
      "ADO did not identify a Microsoft Entra tenant for this registry",
    );
  }

  const accessToken = await getAccessToken(tenantId, options);
  const response = await fetch(patUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      displayName: "registry-auth",
      scope: "vso.packaging_write",
      validTo: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      allOrgs: false,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`PAT creation failed: HTTP ${response.status}`);
  }
  const result = (await response.json()) as {
    patToken?: { token?: string };
    patTokenError?: string;
  } | null;
  const token = result?.patToken?.token;
  if (
    (result?.patTokenError && result.patTokenError !== "none") ||
    typeof token !== "string" ||
    !token
  ) {
    throw new Error("Azure DevOps did not return a PAT");
  }
  return Buffer.from(token).toString("base64");
}
