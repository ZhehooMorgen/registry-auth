#!/usr/bin/env node
import { parse as iniParse } from "ini";
import { readFile } from "node:fs/promises";

const verbose = true;

function logVerbose(content: string) {
  if (verbose) {
    console.log(`verbose: ${content}`);
  }
}

const adoRegistryDomain = "pkgs.dev.azure.com";
const legacyAdoRegistryDomain = "pkgs.visualstudio.com";

enum RegistryType {
  Unknown,
  Ado,
  AdoLegacy,
}

interface NpmConfig {
  name: string;
  value: string;
  position: {
    line: number;
  };
}

function parseConfig(config: string): NpmConfig[] {
  const configs = new Map<string, NpmConfig>();

  config.split(/\r\n|\r|\n/).forEach((content, line) => {
    for (const [name, value] of Object.entries(iniParse(content))) {
      configs.set(name, { name, value, position: { line } });
    }
  });

  return [...configs.values()];
}

interface RegistryConfig extends NpmConfig {
  type: RegistryType;
}

function parseRegistryConfigs(configs: NpmConfig[]): RegistryConfig[] {
  const registryConfigs = configs.filter((config) => {
    if (config.name === "registry") return true;
    const nameSections = config.name.split(":");
    if (nameSections.length === 2 && nameSections[1] === "registry")
      return true;
    return false;
  });
  return registryConfigs.map((config) => {
    let type = RegistryType.Unknown;
    try {
      const registryUrl = new URL(config.value);
      if (registryUrl.host === adoRegistryDomain) {
        type = RegistryType.Ado;
      }
      if (registryUrl.host.endsWith(legacyAdoRegistryDomain)) {
        type = RegistryType.AdoLegacy;
      }
    } catch (e) {
      // ignore cases we cannot process
    }
    return {
      ...config,
      type,
    };
  });
}

function getPatConfigs(configs: NpmConfig[]): NpmConfig[] {
  return configs.filter((c) => {
    const nameSections = c.name.split(":");
    if (nameSections.length === 2 && nameSections[1] === "_password")
      return true;
    return false;
  });
}

function findPatConfig(
  registryConfig: RegistryConfig,
  configs: NpmConfig[],
): NpmConfig | undefined {
  const registryUrl = new URL(registryConfig.value);
  const pathname = registryUrl.pathname.endsWith("/")
    ? registryUrl.pathname
    : `${registryUrl.pathname}/`;

  const patName = `//${registryUrl.host}${pathname}:_password`;
  const patNameWithoutSlash = `//${registryUrl.host}${pathname.slice(0, -1)}:_password`;
  return (
    configs.find((config) => config.name === patName) ??
    configs.find((config) => config.name === patNameWithoutSlash)
  );
}

function verifyPat(
  registryConfig: RegistryConfig,
  patConfig: NpmConfig,
): boolean {
  return false; // Placeholder implementation
}

async function createPat(registryConfig: RegistryConfig): Promise<string> {
  // Placeholder implementation
  return "PLACEHOLDER_PAT";
}

async function main() {
  logVerbose(`@zhehoo/registry-auth`);

  const npmrcFilename = ".npmrc";
  const userNpmrcFilename = `${process.env.HOME}/.npmrc`;

  const npmrcConfigs = parseConfig(await readFile(npmrcFilename, "utf-8"));

  const userNpmrcContent = await readFile(userNpmrcFilename, "utf-8");
  const userNpmrcConfigs = parseConfig(userNpmrcContent);

  const knownRegistryConfigs = parseRegistryConfigs(npmrcConfigs).filter(
    (c) => c.type !== RegistryType.Unknown,
  );

  const repoPatConfigs = getPatConfigs(npmrcConfigs);
  const userPatConfigs = getPatConfigs(userNpmrcConfigs);

  knownRegistryConfigs.forEach(async (registryConfig) => {
    logVerbose(
      `Processing registry: ${registryConfig.name}=${registryConfig.value}`,
    );
    const registryTypeName = (() => {
      switch (registryConfig.type) {
        case RegistryType.Ado:
          return "Azure DevOps";
        case RegistryType.AdoLegacy:
          return "Azure DevOps (Legacy style)";
        default:
          return "Unknown";
      }
    })();
    logVerbose(`this is a ${registryTypeName} registry`);

    logVerbose(`trying to match PAT from repo .npmrc`);
    const repoPatConfig = findPatConfig(registryConfig, repoPatConfigs);
    if (repoPatConfig) {
      logVerbose(`Found PAT in repo .npmrc`);
      if (verifyPat(registryConfig, repoPatConfig)) {
        logVerbose(`PAT is valid`);
        return;
      } else {
        logVerbose(`PAT is invalid`);
      }
    } else {
      logVerbose(`No PAT found in repo .npmrc`);
    }
    logVerbose(`trying to match PAT from user .npmrc`);
    const userPatConfig = findPatConfig(registryConfig, userPatConfigs);
    if (userPatConfig) {
      logVerbose(`Found PAT in user .npmrc`);
      if (verifyPat(registryConfig, userPatConfig)) {
        logVerbose(`PAT is valid`);
        return;
      } else {
        logVerbose(`PAT is invalid`);
      }
    } else {
      logVerbose(`No PAT found in user .npmrc`);
    }
    logVerbose(`Trying to create PAT for registry`);
    const newPat = await createPat(registryConfig);
    logVerbose(`Created new PAT: ${newPat}`);
    if (repoPatConfig) {
      console.log(`Update repo .npmrc with new PAT`);
      // Placeholder for updating user .npmrc with the new PAT
      return;
    }
    if (userPatConfig) {
      console.log(`Update user .npmrc with new PAT`);
      // Placeholder for updating user .npmrc with the new PAT
      return;
    }
    console.log(`Add new PAT to repo .npmrc`);
    // Placeholder for adding new PAT to repo .npmrc
    return;
  });
}

main();
