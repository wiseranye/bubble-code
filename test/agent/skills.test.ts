import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  stripTerminalSequences,
  type TuiMouseEvent,
} from '@earendil-works/pi-tui';
import { afterEach, expect, test, vi } from 'vitest';
import { Agent } from '../../src/agent/agent.ts';
import { createAgentFactory } from '../../src/agent/agent-factory.ts';
import { AgentSession } from '../../src/agent/agent-session.ts';
import {
  loadSessionFileEntries,
  SessionManager,
} from '../../src/agent/session-manager.ts';
import {
  buildSkillActivationMessage,
  createSkillActivation,
  discoverSkills,
  formatAvailableSkills,
  formatSkillActivation,
  type Skill,
} from '../../src/agent/skills.ts';
import {
  type AssistantMessage,
  AssistantMessageEventStream,
  type ModelApi,
} from '../../src/llm/types.ts';
import { newToolRegistry } from '../../src/tools/index.ts';
import { ToolRegistry } from '../../src/tools/types.ts';
import {
  createMessageView,
  SkillActivationMessageView,
} from '../../src/ui/message-view.ts';

const temporaryDirectories: string[] = [];
const openSessions: AgentSession[] = [];

afterEach(async () => {
  await Promise.all(openSessions.map(session => session.dispose()));
  openSessions.length = 0;
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openSession(agent: Agent, sessionFile?: string): AgentSession {
  const session = new AgentSession(agent, sessionFile);
  openSessions.push(session);
  return session;
}

class EmptyModel implements ModelApi {
  stream(): AssistantMessageEventStream {
    const stream = new AssistantMessageEventStream();
    const output: AssistantMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'stop',
      timestamp: Date.now(),
    };
    stream.push({ type: 'start', partial: output });
    stream.push({ type: 'done', reason: 'stop', message: output });
    stream.end();
    return stream;
  }
}

async function until(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (predicate()) {
      return;
    }
    await new Promise<void>(resolve => {
      setImmediate(resolve);
    });
  }
  throw new Error('condition not met');
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bubble-skills-'));
  temporaryDirectories.push(directory);
  return directory;
}

function writeRaw(location: string, content: string): void {
  mkdirSync(dirname(location), { recursive: true });
  writeFileSync(location, content);
}

function writeSkill(
  directory: string,
  name: string,
  description = `Use ${name}`,
  body = `# ${name}\n\nInstructions`,
): string {
  const location = join(directory, 'SKILL.md');
  writeRaw(
    location,
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
  );
  return location;
}

function discover(
  root: string,
  limits?: { maxDepth?: number; maxDirectories?: number },
) {
  return discoverSkills({
    cwd: join(root, 'cwd'),
    bubbleHome: join(root, 'bubble-home'),
    homeDir: join(root, 'user-home'),
    ...limits,
  });
}

test('discovery supports nesting, stops below a skill, and ignores the root file', () => {
  const root = temporaryDirectory();
  const skillsRoot = join(root, 'cwd', '.agents', 'skills');
  writeSkill(join(skillsRoot, 'a'), 'a', 'A', '# A body');
  writeSkill(join(skillsRoot, 'a', 'nested'), 'nested');
  writeRaw(join(skillsRoot, 'invalid-parent', 'SKILL.md'), 'not frontmatter');
  writeSkill(join(skillsRoot, 'invalid-parent', 'child'), 'invalid-child');
  writeSkill(join(skillsRoot, 'group', 'b'), 'b');
  writeSkill(join(skillsRoot, 'group', 'c', 'deep'), 'deep');
  writeSkill(join(skillsRoot, 'node_modules', 'ignored'), 'ignored');
  writeSkill(join(skillsRoot, '.git', 'ignored-git'), 'ignored-git');
  writeSkill(skillsRoot, 'root-file');

  const snapshot = discover(root);

  expect(snapshot.skills.map(skill => skill.name)).toEqual(['a', 'b', 'deep']);
  expect(snapshot.skills[0]?.body).toBe('# A body');
  expect(snapshot.skills[0]?.location).toBe(join(skillsRoot, 'a', 'SKILL.md'));
});

test('source priority resolves conflicts from project bubble down to user agents', () => {
  const root = temporaryDirectory();
  const projectBubble = join(root, 'cwd', '.bubble', 'skills');
  const projectAgents = join(root, 'cwd', '.agents', 'skills');
  const bubbleHome = join(root, 'bubble-home', 'skills');
  const userAgents = join(root, 'user-home', '.agents', 'skills');

  writeSkill(join(projectBubble, 'one'), 'project-conflict', 'bubble');
  writeSkill(join(projectAgents, 'one'), 'project-conflict', 'agents');
  writeSkill(join(projectAgents, 'two'), 'home-conflict', 'agents');
  writeSkill(join(bubbleHome, 'two'), 'home-conflict', 'home');
  writeSkill(join(bubbleHome, 'three'), 'user-conflict', 'home');
  writeSkill(join(userAgents, 'three'), 'user-conflict', 'user');
  for (const directory of [
    projectBubble,
    projectAgents,
    bubbleHome,
    userAgents,
  ]) {
    writeSkill(join(directory, 'four'), 'all-conflict', directory);
  }

  const snapshot = discover(root);
  const descriptions = new Map(
    snapshot.skills.map(skill => [skill.name, skill.description]),
  );
  expect(descriptions.get('project-conflict')).toBe('bubble');
  expect(descriptions.get('home-conflict')).toBe('agents');
  expect(descriptions.get('user-conflict')).toBe('home');
  expect(descriptions.get('all-conflict')).toBe(projectBubble);
  expect(snapshot.warnings.some(warning => warning.includes('遮蔽'))).toBe(
    true,
  );
});

test('same-source conflicts use the lexicographically first SKILL.md path', () => {
  const root = temporaryDirectory();
  const skillsRoot = join(root, 'cwd', '.agents', 'skills');
  const first = writeSkill(
    join(skillsRoot, 'a', 'nested'),
    'duplicate',
    'first',
  );
  writeSkill(join(skillsRoot, 'z'), 'duplicate', 'second');

  const snapshot = discover(root);

  expect(snapshot.skills).toHaveLength(1);
  expect(snapshot.skills[0]?.description).toBe('first');
  expect(snapshot.skills[0]?.location).toBe(first);
  expect(snapshot.warnings.some(warning => warning.includes('遮蔽'))).toBe(
    true,
  );
});

test('missing required fields and malformed YAML skip skills without a name fallback', () => {
  const root = temporaryDirectory();
  const skillsRoot = join(root, 'cwd', '.agents', 'skills');
  writeRaw(
    join(skillsRoot, 'missing-name', 'SKILL.md'),
    '---\ndescription: Missing name\n---\nBody',
  );
  writeRaw(
    join(skillsRoot, 'blank-name', 'SKILL.md'),
    '---\nname: " "\ndescription: Blank name\n---\nBody',
  );
  writeRaw(
    join(skillsRoot, 'missing-description', 'SKILL.md'),
    '---\nname: missing-description\n---\nBody',
  );
  writeRaw(
    join(skillsRoot, 'blank-description', 'SKILL.md'),
    '---\nname: blank-description\ndescription: " "\n---\nBody',
  );
  writeRaw(
    join(skillsRoot, 'bad-yaml', 'SKILL.md'),
    '---\nname: bad-yaml\ndescription: "unterminated\n---\nBody',
  );
  writeRaw(join(skillsRoot, 'no-frontmatter', 'SKILL.md'), '# Body');
  writeSkill(join(skillsRoot, 'valid'), 'valid');

  const snapshot = discover(root);

  expect(snapshot.skills.map(skill => skill.name)).toEqual(['valid']);
  expect(snapshot.warnings.length).toBeGreaterThanOrEqual(6);
  expect(
    snapshot.warnings.some(warning => warning.includes('name 缺失或为空')),
  ).toBe(true);
  expect(
    snapshot.warnings.some(warning =>
      warning.includes('description 缺失或为空'),
    ),
  ).toBe(true);
  expect(
    snapshot.warnings.some(warning => warning.includes('YAML 无法解析')),
  ).toBe(true);
});

test('length and name violations warn while optional fields stay silent', () => {
  const root = temporaryDirectory();
  const skillsRoot = join(root, 'cwd', '.agents', 'skills');
  const longName = 'a'.repeat(65);
  writeSkill(join(skillsRoot, 'long'), longName, 'd'.repeat(1025));
  writeSkill(join(skillsRoot, 'invalid'), 'Bad--Name');
  writeRaw(
    join(skillsRoot, 'optional', 'SKILL.md'),
    `---\nname: optional\ndescription: Optional\ncompatibility: "${'x'.repeat(501)}"\nmetadata:\n  version: 1\nallowed-tools: [read]\nlicense: 42\n---\nBody`,
  );

  const snapshot = discover(root);

  expect(snapshot.skills.map(skill => skill.name)).toEqual([
    'Bad--Name',
    longName,
    'optional',
  ]);
  for (const text of ['64', '1024', '不符合小写字母']) {
    expect(snapshot.warnings.some(warning => warning.includes(text))).toBe(
      true,
    );
  }
  for (const text of [
    'compatibility',
    'metadata',
    'allowed-tools',
    'license',
  ]) {
    expect(snapshot.warnings.some(warning => warning.includes(text))).toBe(
      false,
    );
  }
});

test('directory symlinks are followed without changing the exposed location', () => {
  const root = temporaryDirectory();
  const target = join(root, 'external', 'real');
  writeSkill(target, 'real');
  const link = join(root, 'cwd', '.agents', 'skills', 'linked');
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');

  const snapshot = discover(root);

  expect(snapshot.skills.map(skill => skill.name)).toEqual(['real']);
  expect(snapshot.skills[0]?.location).toBe(join(link, 'SKILL.md'));
});

test('depth and directory limits warn and return already discovered skills', () => {
  const depthRoot = temporaryDirectory();
  const depthSkills = join(depthRoot, 'cwd', '.agents', 'skills');
  writeSkill(join(depthSkills, 'one', 'two'), 'two');
  writeSkill(join(depthSkills, 'one', 'two-deep', 'three'), 'three');
  const depthSnapshot = discover(depthRoot, { maxDepth: 2 });
  expect(depthSnapshot.skills.map(skill => skill.name)).toEqual(['two']);
  expect(
    depthSnapshot.warnings.some(warning => warning.includes('最大递归深度')),
  ).toBe(true);

  const countRoot = temporaryDirectory();
  const countSkills = join(countRoot, 'cwd', '.agents', 'skills');
  writeSkill(join(countSkills, 'a'), 'a');
  writeSkill(join(countSkills, 'b'), 'b');
  writeSkill(join(countSkills, 'c'), 'c');
  const countSnapshot = discover(countRoot, { maxDirectories: 2 });
  expect(countSnapshot.skills.map(skill => skill.name)).toEqual(['a', 'b']);
  expect(
    countSnapshot.warnings.some(warning => warning.includes('目录上限')),
  ).toBe(true);
});

test('default depth loads level six and skips level seven', () => {
  const root = temporaryDirectory();
  const skillsRoot = join(root, 'cwd', '.agents', 'skills');
  writeSkill(join(skillsRoot, 'd1', 'd2', 'd3', 'd4', 'd5', 'd6'), 'deep-six');
  writeSkill(
    join(skillsRoot, 'e1', 'e2', 'e3', 'e4', 'e5', 'e6', 'e7'),
    'deep-seven',
  );

  const snapshot = discover(root);

  expect(snapshot.skills.map(skill => skill.name)).toEqual(['deep-six']);
  expect(
    snapshot.warnings.some(warning => warning.includes('最大递归深度 6')),
  ).toBe(true);
});

test('ancestor symlink cycles terminate at the default depth without realpath checks', () => {
  const root = temporaryDirectory();
  const directory = join(root, 'cwd', '.agents', 'skills', 'a');
  mkdirSync(directory, { recursive: true });
  symlinkSync(
    directory,
    join(directory, 'loop'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const snapshot = discover(root);

  expect(snapshot.skills).toEqual([]);
  expect(
    snapshot.warnings.some(warning => warning.includes('最大递归深度 6')),
  ).toBe(true);
});

test('default directory budget stops before directory 2001', () => {
  const root = temporaryDirectory();
  const skillsRoot = join(root, 'cwd', '.agents', 'skills');
  for (let index = 0; index <= 2000; index++) {
    const directory = join(skillsRoot, `d${String(index).padStart(4, '0')}`);
    if (index >= 1999) {
      writeSkill(directory, `skill-${index}`);
    } else {
      mkdirSync(directory, { recursive: true });
    }
  }

  const snapshot = discover(root);

  expect(snapshot.skills.map(skill => skill.name)).toEqual(['skill-1999']);
  expect(
    snapshot.warnings.some(warning => warning.includes('目录上限 2000')),
  ).toBe(true);
});

test('available skills XML escapes values and is omitted when empty', () => {
  const skill: Skill = {
    name: 'a&<',
    description: 'd & < > " \'',
    location: '/tmp/a&/SKILL.md',
    body: '# Body',
  };

  const content = formatAvailableSkills([skill]);
  expect(content).toContain('<available_skills>');
  expect(content).toContain('<name>a&amp;&lt;</name>');
  expect(content).toContain(
    '<description>d &amp; &lt; &gt; &quot; &apos;</description>',
  );
  expect(content).toContain('<location>/tmp/a&amp;/SKILL.md</location>');
  expect(content).not.toContain('# Body');
  expect(formatAvailableSkills([])).toBeUndefined();
});

test('agent exposes a cached skills prompt section from the supplied snapshot', () => {
  const skill: Skill = {
    name: 'demo',
    description: 'Demo skill',
    location: '/tmp/demo/SKILL.md',
    body: '# Demo',
  };
  const agent = new Agent({
    tools: new ToolRegistry(),
    skillSnapshot: { skills: [skill], warnings: [] },
  });

  const first = agent.systemPrompt.build();
  const second = agent.systemPrompt.build();
  expect(first.content).toContain('<available_skills>');
  expect(first.content).toContain('<name>demo</name>');
  expect(first.sections.skills).toBe(second.sections.skills);
});

test('agent factory scans once per new or resumed session and never during prompts', async () => {
  const root = temporaryDirectory();
  const bubbleHome = join(root, 'bubble-home');
  vi.stubEnv('BUBBLE_HOME', bubbleHome);
  const skillDirectory = join(root, 'cwd', '.agents', 'skills', 'demo');
  writeSkill(skillDirectory, 'demo', 'before');
  let scans = 0;
  const factory = createAgentFactory({
    tools: newToolRegistry(),
    createModelApi: () => new EmptyModel(),
    discoveryOptions: {
      cwd: join(root, 'cwd'),
      bubbleHome,
      homeDir: join(root, 'user-home'),
    },
    discover: options => {
      scans++;
      return discoverSkills(options);
    },
  });

  const initialAgent = factory();
  expect(scans).toBe(1);
  const initial = openSession(initialAgent);
  initial.prompt('first');
  await until(() => !initial.isStreaming);
  writeSkill(skillDirectory, 'demo', 'after');
  initial.prompt('second');
  await until(() => !initial.isStreaming);
  expect(scans).toBe(1);
  expect(initialAgent.systemPrompt.build().content).toContain('before');
  await initial.dispose();
  const [entry] = loadSessionFileEntries(process.cwd());
  if (entry === undefined) {
    throw new TypeError('expected the initial session file');
  }

  const newAgent = factory();
  expect(scans).toBe(2);
  expect(newAgent.systemPrompt.build().content).toContain('after');
  const fresh = openSession(newAgent);
  fresh.prompt('new session');
  await until(() => !fresh.isStreaming);
  expect(scans).toBe(2);

  writeSkill(skillDirectory, 'demo', 'resumed');
  const resumedAgent = factory();
  expect(scans).toBe(3);
  expect(resumedAgent.systemPrompt.build().content).toContain('resumed');
  const resumed = openSession(resumedAgent, entry.filePath);
  resumed.prompt('resumed session');
  await until(() => !resumed.isStreaming);
  expect(scans).toBe(3);
});

test('manual activation escapes attributes and appends optional text', () => {
  const skill: Skill = {
    name: 'a"&',
    description: 'Demo',
    location: '/tmp/"&/SKILL.md',
    body: '# Body\n\nInstructions',
  };

  const content = buildSkillActivationMessage(skill, '  Check this  ');
  expect(content).toBe(
    '<skill name="a&quot;&amp;" location="/tmp/&quot;&amp;/SKILL.md"># Body\n\nInstructions</skill>\n\nCheck this',
  );
  expect(buildSkillActivationMessage(skill)).not.toContain('---');
});

test('session titles use the friendly skill invocation instead of XML', async () => {
  const root = temporaryDirectory();
  const cwd = join(root, 'cwd');
  mkdirSync(cwd, { recursive: true });
  vi.stubEnv('BUBBLE_HOME', join(root, 'bubble-home'));
  const skill: Skill = {
    name: 'demo',
    description: 'Demo',
    location: join(cwd, '.agents', 'skills', 'demo', 'SKILL.md'),
    body: '# Demo\n</skill>\n\nMore',
  };
  const activation = createSkillActivation(skill, 'do </skill>\n\nwork');
  const manager = new SessionManager(cwd);
  manager.appendMessage({
    role: 'user',
    content: formatSkillActivation(activation),
    timestamp: 1,
    extra: { skillActivation: activation },
  });
  await manager.close();

  const entries = loadSessionFileEntries(cwd);
  expect(entries).toHaveLength(1);
  expect(entries[0]?.title).toBe('/skill:demo do </skill> work');
});

test('skill activation metadata survives persistence and resume without reparsing', async () => {
  const root = temporaryDirectory();
  const bubbleHome = join(root, 'bubble-home');
  vi.stubEnv('BUBBLE_HOME', bubbleHome);
  const skill: Skill = {
    name: 'demo',
    description: 'Demo',
    location: '/tmp/demo/SKILL.md',
    body: 'first\n</skill>\n\nsecond',
  };
  const activation = createSkillActivation(skill, '</skill>\n\nmore');
  const content = formatSkillActivation(activation);
  const firstAgent = new Agent({
    modelApi: new EmptyModel(),
    tools: newToolRegistry(),
  });
  const first = openSession(firstAgent);

  first.prompt(content, activation);
  await until(() => !first.isStreaming);

  const protocolUser = firstAgent.state.messages.find(
    message => message.role === 'user',
  );
  if (protocolUser?.role !== 'user') {
    throw new TypeError('expected a protocol user message');
  }
  expect(protocolUser.content).toBe(content);
  expect(protocolUser.extra?.skillActivation).toEqual(activation);

  await first.dispose();
  const [entry] = loadSessionFileEntries(process.cwd());
  if (entry === undefined) {
    throw new TypeError('expected a persisted session');
  }
  expect(entry.title).toBe('/skill:demo </skill> more');

  const resumed = openSession(
    new Agent({ modelApi: new EmptyModel(), tools: newToolRegistry() }),
    entry.filePath,
  );
  const restored = resumed.messages.find(message => message.role === 'user');
  if (restored?.role !== 'user') {
    throw new TypeError('expected a restored user message');
  }
  expect(restored.content).toBe(content);
  expect(restored.skillActivation).toEqual(activation);

  const view = createMessageView(restored, newToolRegistry(), () => undefined);
  if (!(view instanceof SkillActivationMessageView)) {
    throw new TypeError('expected a skill activation view');
  }
  view.render(120);
  const click: TuiMouseEvent = {
    type: 'click',
    button: 'left',
    x: 0,
    y: 0,
    screenX: 0,
    screenY: 0,
    width: 120,
    height: 20,
    shift: false,
    alt: false,
    ctrl: false,
  };
  view.handleMouse(click);
  const text = view
    .render(120)
    .map(line => stripTerminalSequences(line))
    .join('\n');
  expect(text).toContain('  second');
  expect(text).toContain('● </skill>');
  expect(text).toContain('  more');
  expect(text).not.toContain('● more');
});

test('skill diagnostics are one UI-only notice and are not persisted', async () => {
  const root = temporaryDirectory();
  vi.stubEnv('BUBBLE_HOME', join(root, 'bubble-home'));
  const agent = new Agent({
    tools: new ToolRegistry(),
    skillSnapshot: { skills: [], warnings: ['first', 'second'] },
  });
  const session = new AgentSession(agent);

  try {
    const notices = session.messages.flatMap(message =>
      message.role === 'system' && message.content.startsWith('Skill 加载警告')
        ? [message.content]
        : [],
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('- first\n- second');
    expect(agent.state.messages).toEqual([]);
  } finally {
    await session.dispose();
  }

  expect(loadSessionFileEntries(process.cwd())).toEqual([]);
});
