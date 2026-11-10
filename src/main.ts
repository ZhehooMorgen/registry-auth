#!/usr/bin/env node
import { parse as iniParse } from "ini";
import { appendFile, readFile, writeFile } from "node:fs/promises";

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

function getPatConfigName(registryConfig: RegistryConfig): string {
  const registryUrl = new URL(registryConfig.value);
  const pathname = registryUrl.pathname.endsWith("/")
    ? registryUrl.pathname
    : `${registryUrl.pathname}/`;

  return `//${registryUrl.host}${pathname}:_password`;
}

function findPatConfig(
  registryConfig: RegistryConfig,
  configs: NpmConfig[],
): NpmConfig | undefined {
  const configName = getPatConfigName(registryConfig);
  const configNameWithoutSlash = configName.replace(/\/:_password$/, ":_password");
  return (
    configs.find((config) => config.name === configName) ??
    configs.find((config) => config.name === configNameWithoutSlash)
  );
}

async function verifyPat(
  registryConfig: RegistryConfig,
  patConfig: NpmConfig,
): Promise<boolean> {
  return false; // Placeholder implementation
}

async function createPat(registryConfig: RegistryConfig): Promise<string> {
  // Placeholder implementation
  return "PLACEHOLDER_PAT";
}

async function updatePat(filename: string, patConfig: NpmConfig) {
  const content = await readFile(filename, "utf8");
  const config = parseConfig(content).find(
    (config) => config.name === patConfig.name,
  );
  if (!config) {
    throw new Error(`Config not found: ${patConfig.name}`);
  }

  const lines = content.split(/(\r\n|\r|\n)/);
  const index = config.position.line * 2;
  lines[index] = `${config.name}=${patConfig.value}`;
  await writeFile(filename, lines.join(""), "utf8");
}

async function addPat(filename: string, configName: string, pat: string) {
  const content = await readFile(filename, "utf8");
  const configs = parseConfig(content);
  const configPrefix = configName.slice(0, configName.lastIndexOf(":"));
  // npm pairs username and _password only when their prefixes match exactly, including the trailing slash.
  const findField = (field: string) =>
    configs.find((config) => config.name === `${configPrefix}:${field}` && config.value);

  const lines: string[] = [];
  const username = findField("username");
  if (!username) {
    lines.push(`${configPrefix}:username=registry-auth`);
  }

  const email = findField("email");
  if (!email) {
    lines.push(`${configPrefix}:email=registry-auth@example.com`);
  }

  lines.push(`${configName}=${pat}`);

  const newline = content.match(/\r\n|\r|\n/)?.[0] ?? "\n";
  const separator = content && !/[\r\n]$/.test(content) ? newline : "";
  await appendFile(filename, separator + lines.join(newline) + newline, "utf8");
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

  for (const registryConfig of knownRegistryConfigs) {
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
      if (await verifyPat(registryConfig, repoPatConfig)) {
        logVerbose(`PAT is valid`);
        continue;
      } else {
        logVerbose(`PAT is invalid`);
        // try to create a new PAT and put it in repo .npmrc
        logVerbose(`Creating new PAT for repo .npmrc`);
        const newPat = await createPat(registryConfig);
        logVerbose(`Created new PAT`);
        console.log(`Update repo .npmrc with new PAT`);
        const newRepoPatConfig: NpmConfig = { ...repoPatConfig, value: newPat };
        await updatePat(npmrcFilename, newRepoPatConfig);
        continue;
      }
    } else {
      logVerbose(`No PAT found in repo .npmrc`);
    }
    logVerbose(`trying to match PAT from user .npmrc`);
    const userPatConfig = findPatConfig(registryConfig, userPatConfigs);
    if (userPatConfig) {
      logVerbose(`Found PAT in user .npmrc`);
      if (await verifyPat(registryConfig, userPatConfig)) {
        logVerbose(`PAT is valid`);
        continue;
      } else {
        logVerbose(`PAT is invalid`);
      }
    } else {
      logVerbose(`No PAT found in user .npmrc`);
    }

    // try to create a new PAT and put it in user .npmrc
    logVerbose(`Creating new PAT for user .npmrc`);
    const newPat = await createPat(registryConfig);
    logVerbose(`Created new PAT`);
    if (userPatConfig) {
      console.log(`Update user .npmrc with new PAT`);
      const newUserPatConfig: NpmConfig = { ...userPatConfig, value: newPat };
      await updatePat(userNpmrcFilename, newUserPatConfig);
      continue;
    }
    console.log(`Add new PAT to repo .npmrc`);
    const patConfigName = getPatConfigName(registryConfig);
    await addPat(npmrcFilename, patConfigName, newPat);
  }
}

main();
