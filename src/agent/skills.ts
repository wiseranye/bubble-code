import { type Dirent, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import type { SkillActivation } from '../llm/types.ts';
import { stripBom } from '../utils/text.ts';

export type { SkillActivation } from '../llm/types.ts';

const defaultMaxDepth = 6;
const defaultMaxDirectories = 2000;
const skippedDirectories = new Set(['.git', 'node_modules']);
const validSkillName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly location: string;
  readonly body: string;
}

export interface SkillSnapshot {
  readonly skills: readonly Skill[];
  readonly warnings: readonly string[];
}

export interface DiscoverSkillsOptions {
  readonly cwd: string;
  readonly bubbleHome: string;
  readonly homeDir?: string;
  // 测试可用较小预算验证停止条件；产品使用规范建议的固定上限
  readonly maxDepth?: number;
  readonly maxDirectories?: number;
}

type ScanState = {
  visited: number;
  stopped: boolean;
  depthWarned: boolean;
  directoryWarned: boolean;
  readonly maxDepth: number;
  readonly maxDirectories: number;
  readonly warnings: string[];
};

// 高优先级先扫描；同名时先进入 Map 的记录胜出。
// 根目录只作为容器，根自己的 SKILL.md 不参与发现。
export function discoverSkills(options: DiscoverSkillsOptions): SkillSnapshot {
  const cwd = resolve(options.cwd);
  const userHome = resolve(options.homeDir ?? homedir());
  const roots = uniquePaths([
    join(cwd, '.bubble', 'skills'),
    join(cwd, '.agents', 'skills'),
    join(resolve(options.bubbleHome), 'skills'),
    join(userHome, '.agents', 'skills'),
  ]);
  const warnings: string[] = [];
  const winners = new Map<string, Skill>();

  for (const root of roots) {
    const locations = scanRoot(root, options, warnings);
    for (const location of locations) {
      const skill = loadSkill(location, warnings);
      if (skill === undefined) {
        continue;
      }

      const winner = winners.get(skill.name);
      if (winner !== undefined) {
        warnings.push(
          `${location}: Skill "${skill.name}" 被 ${winner.location} 遮蔽`,
        );
      } else {
        winners.set(skill.name, skill);
      }
    }
  }

  const skills = [...winners.values()].sort(
    (a, b) =>
      compareStrings(a.name, b.name) || compareStrings(a.location, b.location),
  );
  return { skills, warnings };
}

function uniquePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.filter(path => {
    if (seen.has(path)) {
      return false;
    }

    seen.add(path);
    return true;
  });
}

function scanRoot(
  root: string,
  options: DiscoverSkillsOptions,
  warnings: string[],
): string[] {
  try {
    if (!statSync(root).isDirectory()) {
      warnings.push(`${root}: Skill 扫描根不是目录，已跳过`);
      return [];
    }
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT') {
      warnings.push(`${root}: 无法读取 Skill 扫描根：${errorMessage(error)}`);
    }
    return [];
  }

  const state: ScanState = {
    visited: 0,
    stopped: false,
    depthWarned: false,
    directoryWarned: false,
    maxDepth: options.maxDepth ?? defaultMaxDepth,
    maxDirectories: options.maxDirectories ?? defaultMaxDirectories,
    warnings,
  };
  const locations: string[] = [];
  scanChildren(root, 1, state, locations);
  return locations.sort(compareStrings);
}

function scanChildren(
  directory: string,
  childDepth: number,
  state: ScanState,
  locations: string[],
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      compareStrings(a.name, b.name),
    );
  } catch (error: unknown) {
    state.warnings.push(
      `${directory}: 无法扫描 Skill 目录：${errorMessage(error)}`,
    );
    return;
  }

  for (const entry of entries) {
    if (state.stopped) {
      return;
    }
    if (
      skippedDirectories.has(entry.name) ||
      (!entry.isDirectory() && !entry.isSymbolicLink())
    ) {
      continue;
    }

    if (childDepth > state.maxDepth) {
      if (!state.depthWarned) {
        state.depthWarned = true;
        state.warnings.push(
          `${directory}: 已达到 Skill 最大递归深度 ${state.maxDepth}，更深层级不再扫描`,
        );
      }
      continue;
    }

    scanDirectory(join(directory, entry.name), childDepth, state, locations);
  }
}

function scanDirectory(
  directory: string,
  depth: number,
  state: ScanState,
  locations: string[],
): void {
  if (state.visited >= state.maxDirectories) {
    state.stopped = true;
    if (!state.directoryWarned) {
      state.directoryWarned = true;
      state.warnings.push(
        `${directory}: 已达到 Skill 扫描目录上限 ${state.maxDirectories}，本扫描根提前结束`,
      );
    }
    return;
  }
  state.visited++;

  try {
    // stat 而非 lstat：有意跟随目录符号链接；不查真实路径，也不做循环检测。
    if (!statSync(directory).isDirectory()) {
      return;
    }
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT') {
      state.warnings.push(
        `${directory}: 无法读取 Skill 目录：${errorMessage(error)}`,
      );
    }
    return;
  }

  const location = join(directory, 'SKILL.md');
  try {
    if (statSync(location).isFile()) {
      locations.push(location);
      // 一个目录成为 Skill 后，其子目录即使还有 SKILL.md 也不再发现。
      return;
    }
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT') {
      state.warnings.push(
        `${location}: 无法检查 SKILL.md：${errorMessage(error)}`,
      );
    }
  }

  scanChildren(directory, depth + 1, state, locations);
}

function loadSkill(location: string, warnings: string[]): Skill | undefined {
  let source: string;
  try {
    source = stripBom(readFileSync(location, 'utf8'));
  } catch (error: unknown) {
    warn(warnings, location, `无法读取：${errorMessage(error)}`);
    return undefined;
  }

  const frontmatter = splitFrontmatter(source);
  if (frontmatter === undefined) {
    warn(warnings, location, '缺少完整的 YAML frontmatter，已跳过');
    return undefined;
  }

  let data: unknown;
  try {
    const document = parseDocument(frontmatter.yaml);
    for (const warning of document.warnings) {
      warn(warnings, location, warning.message);
    }
    if (document.errors.length > 0) {
      for (const error of document.errors) {
        warn(warnings, location, `YAML 无法解析：${error.message}`);
      }
      return undefined;
    }
    data = document.toJS() as unknown;
  } catch (error: unknown) {
    warn(warnings, location, `YAML 无法解析：${errorMessage(error)}`);
    return undefined;
  }

  if (!isRecord(data)) {
    warn(warnings, location, 'frontmatter 必须是键值映射，已跳过');
    return undefined;
  }

  const rawName = data.name;
  const rawDescription = data.description;
  if (typeof rawName !== 'string' || rawName.trim() === '') {
    warn(warnings, location, 'name 缺失或为空，已跳过');
    return undefined;
  }
  if (typeof rawDescription !== 'string' || rawDescription.trim() === '') {
    warn(warnings, location, 'description 缺失或为空，已跳过');
    return undefined;
  }

  const name = rawName.trim();
  const description = rawDescription.trim();
  validateMetadata(data, name, location, warnings);
  return { name, description, location, body: frontmatter.body };
}

function validateMetadata(
  data: Record<string, unknown>,
  name: string,
  location: string,
  warnings: string[],
): void {
  if (characterLength(name) > 64) {
    warn(warnings, location, 'name 超过 64 字符，仍继续加载');
  }
  if (!validSkillName.test(name)) {
    warn(
      warnings,
      location,
      'name 不符合小写字母、数字和连字符规范，仍继续加载',
    );
  }
  const parentName = basename(dirname(location));
  if (name !== parentName) {
    warn(
      warnings,
      location,
      `name 与父目录名 "${parentName}" 不一致，仍继续加载`,
    );
  }

  const description = data.description;
  if (
    typeof description === 'string' &&
    characterLength(description.trim()) > 1024
  ) {
    warn(warnings, location, 'description 超过 1024 字符，仍继续加载');
  }
}

function splitFrontmatter(
  source: string,
): { yaml: string; body: string } | undefined {
  const firstNewline = source.indexOf('\n');
  if (
    firstNewline === -1 ||
    source.slice(0, firstNewline).trimEnd() !== '---'
  ) {
    return undefined;
  }

  const yamlStart = firstNewline + 1;
  let lineStart = yamlStart;
  while (lineStart <= source.length) {
    const newline = source.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? source.length : newline;
    if (source.slice(lineStart, lineEnd).trimEnd() === '---') {
      const bodyStart = newline === -1 ? source.length : newline + 1;
      return {
        yaml: source.slice(yamlStart, lineStart),
        body: source.slice(bodyStart).trim(),
      };
    }
    if (newline === -1) {
      break;
    }
    lineStart = newline + 1;
  }

  return undefined;
}

export function formatAvailableSkills(
  skills: readonly Skill[],
): string | undefined {
  if (skills.length === 0) {
    return undefined;
  }

  const records = skills.map(skill =>
    [
      '<skill>',
      `<name>${escapeXml(skill.name)}</name>`,
      `<description>${escapeXml(skill.description)}</description>`,
      `<location>${escapeXml(skill.location)}</location>`,
      '</skill>',
    ].join('\n'),
  );
  return `The following skills provide specialized instructions for specific tasks.
When a task matches a skill's description, use the read tool to load the SKILL.md at the listed location before proceeding.
Resolve relative paths referenced by a skill against the directory containing its SKILL.md.
<available_skills>
${records.join('\n')}
</available_skills>`;
}

export function createSkillActivation(
  skill: Skill,
  additionalDescription = '',
): SkillActivation {
  return {
    name: skill.name,
    location: skill.location,
    body: skill.body,
    additionalDescription: additionalDescription.trim(),
  };
}

export function formatSkillActivation(activation: SkillActivation): string {
  const block = `<skill name="${escapeXml(activation.name)}" location="${escapeXml(activation.location)}">${activation.body}</skill>`;
  return activation.additionalDescription === ''
    ? block
    : `${block}\n\n${activation.additionalDescription}`;
}

export function buildSkillActivationMessage(
  skill: Skill,
  additionalDescription = '',
): string {
  return formatSkillActivation(
    createSkillActivation(skill, additionalDescription),
  );
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, character => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&apos;',
    };
    return entities[character]!;
  });
}

function characterLength(value: string): number {
  return Array.from(value).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function warn(warnings: string[], location: string, message: string): void {
  warnings.push(`${location}: ${message}`);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string'
    ? error.code
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
