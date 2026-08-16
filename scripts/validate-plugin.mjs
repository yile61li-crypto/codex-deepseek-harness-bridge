#!/usr/bin/env node

import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const errors = [];
const manifestPath = path.join(root, '.codex-plugin', 'plugin.json');
const mcpPath = path.join(root, '.mcp.json');
const packagePath = path.join(root, 'package.json');

const allowedManifestFields = new Set([
  'id',
  'name',
  'version',
  'description',
  'skills',
  'apps',
  'mcpServers',
  'interface',
  'author',
  'homepage',
  'repository',
  'license',
  'keywords'
]);

const allowedInterfaceFields = new Set([
  'displayName',
  'shortDescription',
  'longDescription',
  'developerName',
  'category',
  'capabilities',
  'websiteURL',
  'privacyPolicyURL',
  'termsOfServiceURL',
  'brandColor',
  'composerIcon',
  'logo',
  'logoDark',
  'screenshots',
  'defaultPrompt',
  'default_prompt'
]);

const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const pluginName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hexColor = /^#[0-9A-F]{6}$/i;

async function readJson(file, label) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    errors.push(`${label} must be readable, valid JSON (${error.message})`);
    return undefined;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireString(object, field, label) {
  if (typeof object?.[field] !== 'string' || object[field].trim() === '') {
    errors.push(`${label}.${field} must be a non-empty string`);
  }
}

function rejectUnknown(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) errors.push(`${label}.${key} is not a supported field`);
  }
}

function rejectPlaceholders(value, label = '$') {
  if (typeof value === 'string' && value.includes('[TODO:')) {
    errors.push(`${label} contains a [TODO: ...] placeholder`);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => rejectPlaceholders(item, `${label}[${index}]`));
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) rejectPlaceholders(item, `${label}.${key}`);
  }
}

async function requireFile(relativePath, label) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    errors.push(`${label} must be a non-empty relative path`);
    return;
  }
  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    errors.push(`${label} must stay inside the plugin archive`);
    return;
  }
  try {
    await access(resolved, constants.R_OK);
  } catch {
    errors.push(`${label} points to a missing or unreadable file: ${relativePath}`);
  }
}

const [manifest, mcp, packageJson] = await Promise.all([
  readJson(manifestPath, '.codex-plugin/plugin.json'),
  readJson(mcpPath, '.mcp.json'),
  readJson(packagePath, 'package.json')
]);

if (isObject(manifest)) {
  rejectUnknown(manifest, allowedManifestFields, 'plugin.json');
  rejectPlaceholders(manifest);
  for (const field of ['name', 'version', 'description', 'license']) {
    requireString(manifest, field, 'plugin.json');
  }
  if (typeof manifest.name === 'string' && !pluginName.test(manifest.name)) {
    errors.push('plugin.json.name must use lower-case hyphen-case');
  }
  if (typeof manifest.version === 'string' && !semver.test(manifest.version)) {
    errors.push('plugin.json.version must be strict semver');
  }
  if (manifest.mcpServers !== './.mcp.json') {
    errors.push('plugin.json.mcpServers must be ./.mcp.json');
  }
  if (manifest.skills !== './skills/') {
    errors.push('plugin.json.skills must be ./skills/');
  } else {
    await requireFile(manifest.skills, 'plugin.json.skills');
  }
  if (!isObject(manifest.author)) {
    errors.push('plugin.json.author must be an object');
  } else {
    requireString(manifest.author, 'name', 'plugin.json.author');
  }
  if (!isObject(manifest.interface)) {
    errors.push('plugin.json.interface must be an object');
  } else {
    rejectUnknown(manifest.interface, allowedInterfaceFields, 'plugin.json.interface');
    for (const field of [
      'displayName',
      'shortDescription',
      'longDescription',
      'developerName',
      'category'
    ]) {
      requireString(manifest.interface, field, 'plugin.json.interface');
    }
    if (!Array.isArray(manifest.interface.capabilities) ||
        manifest.interface.capabilities.some((item) => typeof item !== 'string' || item.trim() === '')) {
      errors.push('plugin.json.interface.capabilities must be an array of non-empty strings');
    }
    if (manifest.interface.brandColor !== undefined &&
        (typeof manifest.interface.brandColor !== 'string' ||
         !hexColor.test(manifest.interface.brandColor))) {
      errors.push('plugin.json.interface.brandColor must use #RRGGBB');
    }
    for (const field of ['websiteURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
      if (manifest.interface[field] !== undefined) {
        try {
          const url = new URL(manifest.interface[field]);
          if (url.protocol !== 'https:') throw new Error('not HTTPS');
        } catch {
          errors.push(`plugin.json.interface.${field} must be an absolute HTTPS URL`);
        }
      }
    }
    const prompts = manifest.interface.defaultPrompt ?? manifest.interface.default_prompt;
    const promptsValid = typeof prompts === 'string'
      ? prompts.trim() !== ''
      : Array.isArray(prompts) && prompts.length > 0 && prompts.every(
        (item) => typeof item === 'string' && item.trim() !== ''
      );
    if (!promptsValid) errors.push('plugin.json.interface must provide at least one default prompt');
    for (const field of ['composerIcon', 'logo', 'logoDark']) {
      if (manifest.interface[field] !== undefined) {
        await requireFile(manifest.interface[field], `plugin.json.interface.${field}`);
      }
    }
    if (manifest.interface.screenshots !== undefined) {
      if (!Array.isArray(manifest.interface.screenshots)) {
        errors.push('plugin.json.interface.screenshots must be an array');
      } else {
        await Promise.all(manifest.interface.screenshots.map(
          (file, index) => requireFile(file, `plugin.json.interface.screenshots[${index}]`)
        ));
      }
    }
  }
}

if (!isObject(mcp?.mcpServers) || Object.keys(mcp.mcpServers).length === 0) {
  errors.push('.mcp.json.mcpServers must be a non-empty object');
} else {
  for (const [name, server] of Object.entries(mcp.mcpServers)) {
    if (!isObject(server)) errors.push(`.mcp.json.mcpServers.${name} must be an object`);
  }
}

if (isObject(packageJson)) {
  if (packageJson.version !== manifest?.version) {
    errors.push('package.json.version must match plugin.json.version');
  }
  if (packageJson.license !== manifest?.license) {
    errors.push('package.json.license must match plugin.json.license');
  }
  if (packageJson.private !== false) errors.push('package.json.private must be false');
  if (!isObject(packageJson.bin) || Object.keys(packageJson.bin).length === 0) {
    errors.push('package.json.bin must expose the MCP server executable');
  } else {
    await Promise.all(Object.entries(packageJson.bin).map(
      ([name, file]) => requireFile(file, `package.json.bin.${name}`)
    ));
  }
  const requiredFiles = ['.codex-plugin', '.mcp.json', 'skills', 'scripts', 'src', 'SECURITY.md'];
  if (!Array.isArray(packageJson.files)) {
    errors.push('package.json.files must be an array');
  } else {
    for (const file of requiredFiles) {
      if (!packageJson.files.includes(file)) errors.push(`package.json.files must include ${file}`);
    }
  }
}

if (errors.length > 0) {
  console.error('Plugin validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Plugin validation passed: ${root}`);
}
