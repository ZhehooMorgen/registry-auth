#!/usr/bin/env node
import { parse as iniParse } from "ini";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createPat, verifyPat } from "./ado.ts";
import { logVerbose, type NpmConfig } from "./utility.ts";

function parseConfig(config: string): NpmConfig[] {
  const configs = new Map<string, NpmConfig>();

  config.split(/\r\n|\r|\n/).forEach((content, line) => {
    for (const [name, value] of Object.entries(iniParse(content))) {
      configs.set(name, { name, value, position: { line } });
    }
  });

  return [...configs.values()];
}

function parseRegistryConfigs(configs: NpmConfig[]): NpmConfig[] {
  return configs.filter((config) => {
    if (config.name === "registry") return true;
    const nameSections = config.name.split(":");
    if (nameSections.length === 2 && nameSections[1] === "registry")
      return true;
    return false;
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

function getPatConfigName(registryUrl: string): string {
  const url = new URL(registryUrl);
  const pathname = url.pathname.endsWith("/")
    ? url.pathname
    : `${url.pathname}/`;

  return `//${url.host}${pathname}:_password`;
}

function findPatConfig(
  configName: string,
  configs: NpmConfig[],
): NpmConfig | undefined {
  const configNameWithoutSlash = configName.replace(
    /\/:_password$/,
    ":_password",
  );
  return (
    configs.find((config) => config.name === configName) ??
    configs.find((config) => config.name === configNameWithoutSlash)
  );
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
    configs.find(
      (config) => config.name === `${configPrefix}:${field}` && config.value,
    );

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

  const registryConfigs = parseRegistryConfigs(npmrcConfigs);

  const repoPatConfigs = getPatConfigs(npmrcConfigs);
  const userPatConfigs = getPatConfigs(userNpmrcConfigs);

  const registryUrls = new Set(
    registryConfigs.map((config) => {
      const url = new URL(config.value);
      if (!url.pathname.endsWith("/")) url.pathname += "/";
      return url.href;
    }),
  );
  for (const registryUrl of registryUrls) {
    logVerbose(`Processing registry: ${registryUrl}`);
    const patConfigName = getPatConfigName(registryUrl);

    logVerbose(`trying to match PAT from repo .npmrc`);
    const repoPatConfig = findPatConfig(patConfigName, repoPatConfigs);
    if (repoPatConfig) {
      logVerbose(`Found PAT in repo .npmrc, verifying...`);
      if (await verifyPat(registryUrl, repoPatConfig)) {
        logVerbose(`PAT is valid`);
        continue;
      } else {
        logVerbose(`PAT is invalid`);
        // try to create a new PAT and put it in repo .npmrc
        logVerbose(`Creating new PAT for repo .npmrc`);
        const newPat = await createPat(registryUrl);
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
    const userPatConfig = findPatConfig(patConfigName, userPatConfigs);
    if (userPatConfig) {
      logVerbose(`Found PAT in user .npmrc, verifying...`);
      if (await verifyPat(registryUrl, userPatConfig)) {
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
    const newPat = await createPat(registryUrl);
    logVerbose(`Created new PAT`);
    if (userPatConfig) {
      console.log(`Update user .npmrc with new PAT`);
      const newUserPatConfig: NpmConfig = { ...userPatConfig, value: newPat };
      await updatePat(userNpmrcFilename, newUserPatConfig);
      continue;
    }
    console.log(`Add new PAT to user .npmrc`);
    await addPat(userNpmrcFilename, patConfigName, newPat);
  }
}

main();
