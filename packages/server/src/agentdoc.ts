export const AGENTDOC_SCHEMA = 'agentdocs/v1';

const DOCUMENT_KINDS = {
  specification: 'SPECIFICATION',
  'implementation-plan': 'IMPLEMENTATION PLAN',
  exploration: 'EXPLORATION',
  handoff: 'HANDOFF',
  'design-doc': 'DESIGN DOC',
} as const;

type DocumentKind = keyof typeof DOCUMENT_KINDS;
type RichFormat = 'markdown' | 'html';

interface Node {
  name: string;
  line: number;
  value?: string;
  attrs: Record<string, string>;
  body?: string;
  children?: Node[];
}

interface RichContent {
  id?: string;
  title: string;
  format: RichFormat;
  body: string;
}

interface Evaluation {
  metric: 'size' | 'complexity' | 'risk';
  level: number;
  reason: string;
}

interface Reference {
  doc: string;
  label: string;
}

interface OpenDecision {
  id: string;
  status: 'open';
  question: string;
  layout: 'grid' | 'full';
  options: RichContent[];
  leaning: string;
  aiComment: string;
}

interface LockedDecision {
  id: string;
  status: 'locked';
  question: string;
  by: 'human' | 'ai';
  layout: 'grid' | 'full';
  selected: RichContent;
}

interface RemovedDecision {
  id: string;
  status: 'removed';
  question: string;
  reason: string;
}

type Decision = OpenDecision | LockedDecision | RemovedDecision;

interface Risk {
  id: string;
  kind: 'general' | 'edge-case';
  severity: number;
  description: string;
  tests: string[];
}

interface Test {
  id: string;
  tester: 'ai' | 'unit' | 'human';
  status: 'waiting' | 'fail' | 'success';
  description: string;
  method: string;
}

interface Step {
  id: string;
  action: string;
  verify: string;
}

export interface AgentDoc {
  schema: string;
  id: string;
  title: string;
  kind: DocumentKind;
  description: string;
  references: Reference[];
  evaluations: Evaluation[];
  decisions: Decision[];
  risks: Risk[];
  tests: Test[];
  steps: Step[];
  sections: RichContent[];
  css?: string;
  warnings: string[];
}

const SIMPLE_DIRECTIVES = new Set(['schema', 'id', 'title', 'kind', 'reference', 'leaning']);
const RAW_BLOCKS = new Set([
  'description', 'evaluation', 'question', 'option', 'ai-comment', 'selected', 'reason',
  'method', 'action', 'verify', 'section', 'css',
]);
const CONTAINER_BLOCKS = new Set(['references', 'evaluations', 'decisions', 'decision', 'risks', 'risk', 'tests', 'test', 'steps', 'step']);
const ALL_DIRECTIVES = new Set([...SIMPLE_DIRECTIVES, ...RAW_BLOCKS, ...CONTAINER_BLOCKS]);

class AgentDocError extends Error {
  constructor(readonly issues: string[]) {
    super(issues.join('\n'));
  }
}

function syntaxError(line: number, message: string): never {
  throw new AgentDocError([`line ${line}: ${message}`]);
}

function parseQuoted(input: string, line: number) {
  let value = '';
  let i = 1;
  while (i < input.length) {
    const char = input[i++];
    if (char === '"') return { value, rest: input.slice(i) };
    if (char === '\\') {
      const escaped = input[i++];
      if (escaped !== '"' && escaped !== '\\') syntaxError(line, `unsupported escape \\${escaped ?? ''}`);
      value += escaped;
    } else {
      value += char;
    }
  }
  syntaxError(line, 'unterminated quoted value');
}

function parseScalar(input: string, line: number) {
  const value = input.trim();
  if (!value) syntaxError(line, 'directive value required');
  if (value.startsWith('"')) {
    const parsed = parseQuoted(value, line);
    if (parsed.rest.trim()) syntaxError(line, 'unexpected text after quoted value');
    return parsed.value;
  }
  if (/\s/.test(value)) syntaxError(line, 'values containing spaces must be quoted');
  return value;
}

function parseAttributes(input: string, line: number) {
  const attrs: Record<string, string> = {};
  let rest = input.trim();
  while (rest) {
    const match = /^([a-z][a-z0-9-]*)=/.exec(rest);
    if (!match) syntaxError(line, 'expected a named attribute');
    const key = match[1];
    if (key in attrs) syntaxError(line, `duplicate attribute "${key}"`);
    rest = rest.slice(match[0].length);
    let value: string;
    if (rest.startsWith('"')) {
      const parsed = parseQuoted(rest, line);
      value = parsed.value;
      rest = parsed.rest.trimStart();
    } else {
      const end = rest.search(/\s/);
      value = end === -1 ? rest : rest.slice(0, end);
      rest = end === -1 ? '' : rest.slice(end).trimStart();
      if (!value) syntaxError(line, `attribute "${key}" requires a value`);
    }
    attrs[key] = value;
  }
  return attrs;
}

function directiveAt(text: string, line: number) {
  const match = /^@([a-z][a-z0-9-]*)(?:\s+(.*))?$/.exec(text);
  if (!match) syntaxError(line, 'invalid directive syntax');
  return { name: match[1], rest: match[2] ?? '' };
}

function trimBlankEdges(lines: string[]) {
  while (lines[0]?.trim() === '') lines.shift();
  while (lines.at(-1)?.trim() === '') lines.pop();
  return lines.join('\n');
}

function parseNodes(lines: string[], start = 0, expectedEnd?: string): { nodes: Node[]; next: number } {
  const nodes: Node[] = [];
  let index = start;
  while (index < lines.length) {
    const text = lines[index];
    const line = index + 1;
    if (!text.trim()) {
      index++;
      continue;
    }
    if (!text.startsWith('@')) syntaxError(line, 'content must be inside a directive block');
    const directive = directiveAt(text, line);
    if (directive.name.startsWith('end-')) {
      if (directive.name === `end-${expectedEnd}` && !directive.rest.trim()) return { nodes, next: index + 1 };
      syntaxError(line, `unexpected @${directive.name}`);
    }
    if (!ALL_DIRECTIVES.has(directive.name)) syntaxError(line, `unknown directive @${directive.name}`);

    if (RAW_BLOCKS.has(directive.name)) {
      const attrs = parseAttributes(directive.rest, line);
      const body: string[] = [];
      index++;
      const closing = `@end-${directive.name}`;
      while (index < lines.length && lines[index] !== closing) {
        body.push(lines[index].startsWith('@@') ? lines[index].slice(1) : lines[index]);
        index++;
      }
      if (index === lines.length) syntaxError(line, `missing ${closing}`);
      nodes.push({ name: directive.name, line, attrs, body: trimBlankEdges(body) });
      index++;
      continue;
    }

    if (CONTAINER_BLOCKS.has(directive.name)) {
      const attrs = parseAttributes(directive.rest, line);
      const parsed = parseNodes(lines, index + 1, directive.name);
      nodes.push({ name: directive.name, line, attrs, children: parsed.nodes });
      index = parsed.next;
      continue;
    }

    const value = ['schema', 'id', 'title', 'kind'].includes(directive.name)
      ? parseScalar(directive.rest, line)
      : undefined;
    const attrs = value === undefined ? parseAttributes(directive.rest, line) : {};
    nodes.push({ name: directive.name, line, value, attrs });
    index++;
  }
  if (expectedEnd) syntaxError(lines.length || 1, `missing @end-${expectedEnd}`);
  return { nodes, next: index };
}

function rejectUnexpected(nodes: Node[], allowed: readonly string[], scope: string, issues: string[]) {
  const valid = new Set(allowed);
  for (const node of nodes) if (!valid.has(node.name)) issues.push(`${scope}: unexpected @${node.name} at line ${node.line}`);
}

function checkAttrs(node: Node, allowed: readonly string[], path: string, issues: string[]) {
  const valid = new Set(allowed);
  for (const key of Object.keys(node.attrs)) if (!valid.has(key)) issues.push(`${path}: unknown attribute "${key}" at line ${node.line}`);
}

function one(nodes: Node[], name: string, path: string, issues: string[], required = true) {
  const found = nodes.filter(node => node.name === name);
  if (found.length > 1) issues.push(`${path}: duplicate @${name} at lines ${found.map(node => node.line).join(', ')}`);
  if (required && found.length === 0) issues.push(`${path}: missing @${name}`);
  return found[0];
}

function requiredAttr(node: Node, name: string, path: string, issues: string[]) {
  const value = node.attrs[name]?.trim();
  if (!value) issues.push(`${path}: attribute "${name}" is required at line ${node.line}`);
  return value ?? '';
}

function body(node: Node | undefined, path: string, issues: string[]) {
  const value = node?.body?.trim() ?? '';
  if (node && !value) issues.push(`${path}: content is required at line ${node.line}`);
  return value;
}

function enumValue<T extends string>(value: string, values: readonly T[], path: string, issues: string[]): T {
  if (!(values as readonly string[]).includes(value)) issues.push(`${path}: expected ${values.join('|')}, got "${value}"`);
  return value as T;
}

function integer(value: string, min: number, max: number, path: string, issues: string[]) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) issues.push(`${path}: expected an integer from ${min} to ${max}, got "${value}"`);
  return parsed;
}

function ensureId(value: string, prefix: string, path: string, issues: string[]) {
  if (!new RegExp(`^${prefix}[1-9][0-9]*$`).test(value)) issues.push(`${path}: expected ${prefix}-prefixed numeric ID, got "${value}"`);
  return value;
}

function ensureUnique(values: { id: string }[], path: string, issues: string[]) {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value.id)) issues.push(`${path}: duplicate ID "${value.id}"`);
    seen.add(value.id);
  }
}

function isOneSentence(value: string) {
  if (!/[.!?]["')\]]?$/.test(value.trim())) return false;
  return (value.match(/[.!?]["')\]]?(?=\s|$)/g) ?? []).length === 1;
}

function sentenceCount(value: string) {
  return (value.match(/[.!?]["')\]]?(?=\s|$)/g) ?? []).length;
}

function validateRich(format: RichFormat, value: string, path: string, issues: string[]) {
  if (/<\s*\/?\s*(script|style)\b/i.test(value) || /\son[a-z]+\s*=/i.test(value) || /javascript\s*:/i.test(value)) {
    issues.push(`${path}: script and style behavior is not allowed in rich content`);
  }
  if (!value.trim()) issues.push(`${path}: content is required`);
  return { format, body: value };
}

function hasBalancedCssBlocks(value: string) {
  let depth = 0;
  let quote = '';
  let comment = false;
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    const next = value[index + 1];
    if (comment) {
      if (char === '*' && next === '/') {
        comment = false;
        index++;
      }
      continue;
    }
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '*') {
      comment = true;
      index++;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '{') {
      depth++;
    } else if (char === '}' && --depth < 0) {
      return false;
    }
  }
  return depth === 0 && !quote && !comment;
}

function parseRich(node: Node, path: string, issues: string[], idRequired: boolean): RichContent {
  checkAttrs(node, idRequired ? ['id', 'format', 'title'] : ['format', 'title'], path, issues);
  const id = idRequired ? requiredAttr(node, 'id', path, issues) : undefined;
  const format = enumValue(requiredAttr(node, 'format', path, issues), ['markdown', 'html'] as const, `${path}.format`, issues);
  const title = requiredAttr(node, 'title', path, issues);
  const rich = validateRich(format, node.body ?? '', `${path}.body`, issues);
  return { id, title, ...rich };
}

type SchemaMigration = (nodes: Node[]) => { schema: string; nodes: Node[] };
const migrations = new Map<string, SchemaMigration>();

function migrate(nodes: Node[], schema: string) {
  const visited = new Set<string>();
  while (schema !== AGENTDOC_SCHEMA) {
    if (visited.has(schema)) throw new AgentDocError([`schema: migration cycle at "${schema}"`]);
    visited.add(schema);
    const migration = migrations.get(schema);
    if (!migration) throw new AgentDocError([`schema: unsupported version "${schema}"`]);
    const result = migration(nodes);
    nodes = result.nodes;
    schema = result.schema;
  }
  return nodes;
}

export function parseAgentDoc(source: string): AgentDoc {
  let nodes = parseNodes(source.replace(/\r\n?/g, '\n').split('\n')).nodes;
  const initialIssues: string[] = [];
  const schemaNode = one(nodes, 'schema', 'document', initialIssues);
  if (initialIssues.length) throw new AgentDocError(initialIssues);
  nodes = migrate(nodes, schemaNode!.value!);

  const issues: string[] = [];
  rejectUnexpected(nodes, ['schema', 'id', 'title', 'kind', 'description', 'references', 'evaluations', 'decisions', 'risks', 'tests', 'steps', 'section', 'css'], 'document', issues);
  const schema = one(nodes, 'schema', 'document', issues)?.value ?? '';
  const id = one(nodes, 'id', 'document', issues)?.value ?? '';
  const title = one(nodes, 'title', 'document', issues)?.value?.trim() ?? '';
  const kind = enumValue(one(nodes, 'kind', 'document', issues)?.value ?? '', Object.keys(DOCUMENT_KINDS) as DocumentKind[], 'document.kind', issues);
  const descriptionNode = one(nodes, 'description', 'document', issues);
  const description = body(descriptionNode, 'document.description', issues);
  const warnings: string[] = [];
  if (id && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) issues.push(`document.id: expected a lowercase slug, got "${id}"`);
  if (!title) issues.push('document.title: content is required');
  if (/\n\s*\n/.test(description)) issues.push('document.description: expected one paragraph');
  if (description && (sentenceCount(description) < 2 || sentenceCount(description) > 3)) warnings.push('document.description: prefer two or three sentences');

  const referencesNode = one(nodes, 'references', 'document', issues, false);
  const references: Reference[] = [];
  if (referencesNode) {
    rejectUnexpected(referencesNode.children ?? [], ['reference'], 'references', issues);
    for (const [index, node] of (referencesNode.children ?? []).entries()) {
      const path = `references[${index}]`;
      checkAttrs(node, ['doc', 'label'], path, issues);
      const doc = requiredAttr(node, 'doc', path, issues);
      if (doc && !/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(doc)) issues.push(`${path}.doc: expected project/id, got "${doc}"`);
      references.push({ doc, label: node.attrs.label?.trim() || doc });
    }
  }

  const evaluationsNode = one(nodes, 'evaluations', 'document', issues, false);
  const evaluations: Evaluation[] = [];
  if (evaluationsNode) {
    rejectUnexpected(evaluationsNode.children ?? [], ['evaluation'], 'evaluations', issues);
    for (const [index, node] of (evaluationsNode.children ?? []).entries()) {
      const path = `evaluations[${index}]`;
      checkAttrs(node, ['metric', 'level'], path, issues);
      const metric = enumValue(requiredAttr(node, 'metric', path, issues), ['size', 'complexity', 'risk'] as const, `${path}.metric`, issues);
      const level = integer(requiredAttr(node, 'level', path, issues), 0, 3, `${path}.level`, issues);
      const reason = body(node, `${path}.reason`, issues);
      if (reason && !isOneSentence(reason)) issues.push(`${path}.reason: expected exactly one sentence`);
      evaluations.push({ metric, level, reason });
    }
    const metrics = new Set(evaluations.map(item => item.metric));
    for (const metric of ['size', 'complexity', 'risk'] as const) if (!metrics.has(metric)) issues.push(`evaluations: missing ${metric}`);
    if (metrics.size !== evaluations.length) issues.push('evaluations: duplicate metric');
  } else if (kind === 'specification' || kind === 'implementation-plan') {
    issues.push(`document.evaluations: required for ${kind}`);
  }

  const decisionsNode = one(nodes, 'decisions', 'document', issues, false);
  const decisions: Decision[] = [];
  if (decisionsNode) {
    rejectUnexpected(decisionsNode.children ?? [], ['decision'], 'decisions', issues);
    for (const [index, node] of (decisionsNode.children ?? []).entries()) {
      const path = `decisions[${index}]`;
      checkAttrs(node, ['id', 'status', 'layout', 'by'], path, issues);
      const id = ensureId(requiredAttr(node, 'id', path, issues), 'D', `${path}.id`, issues);
      const status = enumValue(requiredAttr(node, 'status', path, issues), ['open', 'locked', 'removed'] as const, `${path}.status`, issues);
      const children = node.children ?? [];
      rejectUnexpected(children, ['question', 'option', 'leaning', 'ai-comment', 'selected', 'reason'], path, issues);
      const question = body(one(children, 'question', path, issues), `${path}.question`, issues);
      if (status === 'open') {
        if (node.attrs.by) issues.push(`${path}: open decision cannot have "by"`);
        const layout = enumValue(node.attrs.layout || 'grid', ['grid', 'full'] as const, `${path}.layout`, issues);
        const options = children.filter(child => child.name === 'option').map((child, optionIndex) => parseRich(child, `${path}.options[${optionIndex}]`, issues, true));
        if (options.length < 2) issues.push(`${path}.options: at least two options required`);
        ensureUnique(options as { id: string }[], `${path}.options`, issues);
        const leaningNode = one(children, 'leaning', path, issues);
        if (leaningNode) checkAttrs(leaningNode, ['option'], `${path}.leaning`, issues);
        const leaning = leaningNode ? requiredAttr(leaningNode, 'option', `${path}.leaning`, issues) : '';
        if (leaning && !options.some(option => option.id === leaning)) issues.push(`${path}.leaning: unknown option "${leaning}"`);
        const aiComment = body(one(children, 'ai-comment', path, issues), `${path}.ai-comment`, issues);
        if (children.some(child => ['selected', 'reason'].includes(child.name))) issues.push(`${path}: open decision contains locked/removed fields`);
        decisions.push({ id, status, question, layout, options, leaning, aiComment });
      } else if (status === 'locked') {
        const by = enumValue(requiredAttr(node, 'by', path, issues), ['human', 'ai'] as const, `${path}.by`, issues);
        const layout = enumValue(node.attrs.layout || 'grid', ['grid', 'full'] as const, `${path}.layout`, issues);
        const selectedNode = one(children, 'selected', path, issues);
        const selected = selectedNode ? parseRich(selectedNode, `${path}.selected`, issues, true) : { id: '', title: '', format: 'markdown' as const, body: '' };
        if (children.some(child => ['option', 'leaning', 'ai-comment', 'reason'].includes(child.name))) issues.push(`${path}: locked decision must retain only its selected option`);
        decisions.push({ id, status, question, by, layout, selected });
      } else {
        if (node.attrs.by || node.attrs.layout) issues.push(`${path}: removed decision cannot have "by" or "layout"`);
        const reason = body(one(children, 'reason', path, issues), `${path}.reason`, issues);
        if (children.some(child => ['option', 'leaning', 'ai-comment', 'selected'].includes(child.name))) issues.push(`${path}: removed decision contains open/locked fields`);
        decisions.push({ id, status, question, reason });
      }
    }
    ensureUnique(decisions, 'decisions', issues);
  }

  const risksNode = one(nodes, 'risks', 'document', issues, false);
  const risks: Risk[] = [];
  if (risksNode) {
    rejectUnexpected(risksNode.children ?? [], ['risk'], 'risks', issues);
    for (const [index, node] of (risksNode.children ?? []).entries()) {
      const path = `risks[${index}]`;
      checkAttrs(node, ['id', 'kind', 'severity', 'tests'], path, issues);
      const id = ensureId(requiredAttr(node, 'id', path, issues), 'R', `${path}.id`, issues);
      const riskKind = enumValue(requiredAttr(node, 'kind', path, issues), ['general', 'edge-case'] as const, `${path}.kind`, issues);
      const severity = integer(requiredAttr(node, 'severity', path, issues), 0, 3, `${path}.severity`, issues);
      const tests = requiredAttr(node, 'tests', path, issues).split(',').map(value => value.trim()).filter(Boolean);
      const children = node.children ?? [];
      rejectUnexpected(children, ['description'], path, issues);
      const description = body(one(children, 'description', path, issues), `${path}.description`, issues);
      risks.push({ id, kind: riskKind, severity, description, tests });
    }
    ensureUnique(risks, 'risks', issues);
  }

  const testsNode = one(nodes, 'tests', 'document', issues, false);
  const tests: Test[] = [];
  if (testsNode) {
    rejectUnexpected(testsNode.children ?? [], ['test'], 'tests', issues);
    for (const [index, node] of (testsNode.children ?? []).entries()) {
      const path = `tests[${index}]`;
      checkAttrs(node, ['id', 'tester', 'status'], path, issues);
      const id = ensureId(requiredAttr(node, 'id', path, issues), 'T', `${path}.id`, issues);
      const tester = enumValue(requiredAttr(node, 'tester', path, issues), ['ai', 'unit', 'human'] as const, `${path}.tester`, issues);
      const status = enumValue(requiredAttr(node, 'status', path, issues), ['waiting', 'fail', 'success'] as const, `${path}.status`, issues);
      const children = node.children ?? [];
      rejectUnexpected(children, ['description', 'method'], path, issues);
      const description = body(one(children, 'description', path, issues), `${path}.description`, issues);
      const method = body(one(children, 'method', path, issues), `${path}.method`, issues);
      tests.push({ id, tester, status, description, method });
    }
    ensureUnique(tests, 'tests', issues);
  }
  const testIds = new Set(tests.map(test => test.id));
  for (const [index, risk] of risks.entries()) {
    if (risk.tests.length === 0) issues.push(`risks[${index}].tests: at least one test required`);
    for (const test of risk.tests) if (!testIds.has(test)) issues.push(`risks[${index}].tests: unknown test "${test}"`);
  }

  const stepsNode = one(nodes, 'steps', 'document', issues, false);
  const steps: Step[] = [];
  if (stepsNode) {
    rejectUnexpected(stepsNode.children ?? [], ['step'], 'steps', issues);
    for (const [index, node] of (stepsNode.children ?? []).entries()) {
      const path = `steps[${index}]`;
      checkAttrs(node, ['id'], path, issues);
      const id = ensureId(requiredAttr(node, 'id', path, issues), 'S', `${path}.id`, issues);
      const children = node.children ?? [];
      rejectUnexpected(children, ['action', 'verify'], path, issues);
      const action = body(one(children, 'action', path, issues), `${path}.action`, issues);
      const verify = body(one(children, 'verify', path, issues), `${path}.verify`, issues);
      steps.push({ id, action, verify });
    }
    ensureUnique(steps, 'steps', issues);
  } else if (kind === 'implementation-plan') {
    issues.push('document.steps: required for implementation-plan');
  }

  const sections = nodes.filter(node => node.name === 'section').map((node, index) => parseRich(node, `sections[${index}]`, issues, false));
  const cssNode = one(nodes, 'css', 'document', issues, false);
  const css = cssNode?.body?.trim() || undefined;
  if (css && /<\s*\/?\s*(style|script)\b/i.test(css)) issues.push('document.css: HTML tags are not allowed');
  if (css && !hasBalancedCssBlocks(css)) issues.push('document.css: blocks, strings, and comments must be balanced');
  if (css) warnings.push('document.css: custom CSS should be used only when generated styles cannot express the design');

  if (issues.length) throw new AgentDocError(issues);
  references.sort((a, b) => a.label.localeCompare(b.label) || a.doc.localeCompare(b.doc));
  evaluations.sort((a, b) => ['size', 'complexity', 'risk'].indexOf(a.metric) - ['size', 'complexity', 'risk'].indexOf(b.metric));
  decisions.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  risks.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  tests.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { schema, id, title, kind, description, references, evaluations, decisions, risks, tests, steps, sections, css, warnings };
}

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function badgeClass(level: number) {
  if (level <= 1) return 'b-ok';
  if (level === 2) return 'b-warn';
  return 'b-bad';
}

function toneClass(level: number) {
  if (level <= 1) return 'tone-ok';
  if (level === 2) return 'tone-warn';
  return 'tone-bad';
}

function rich(content: RichContent, markdown: (source: string) => string) {
  return content.format === 'html' ? content.body : markdown(content.body);
}

function section(title: string, content: string) {
  return `<section><h2>${escapeHtml(title)}</h2>${content}</section>`;
}

export function renderAgentDoc(source: string, markdown: (source: string) => string) {
  const doc = parseAgentDoc(source);
  const { evaluations, decisions, risks, tests } = doc;
  const parts: string[] = [];

  if (doc.references.length) {
    const links = [...doc.references].sort((a, b) => a.label.localeCompare(b.label) || a.doc.localeCompare(b.doc)).map(reference =>
      `<li><a href="/${escapeHtml(reference.doc)}" data-vault-doc="${escapeHtml(reference.doc)}">${escapeHtml(reference.label)}</a></li>`).join('');
    parts.push(section('References', `<nav><ul>${links}</ul></nav>`));
  }

  if (evaluations.length) {
    const rows = evaluations.map(item => {
      const scale = [0, 1, 2, 3].map(level => `<span${level === item.level ? ' class="active"' : ''}>${level}</span>`).join('');
      const tone = toneClass(item.level);
      return `<article class="evaluation-row ${tone}"><strong class="evaluation-metric">${escapeHtml(item.metric)}</strong><div class="evaluation-scale" aria-label="${escapeHtml(item.metric)} ${item.level} of 3">${scale}</div><p class="evaluation-reason">${escapeHtml(item.reason)}</p></article>`;
    }).join('');
    parts.push(section('Evaluations', `<div class="evaluation-panel">${rows}</div>`));
  }

  if (decisions.length) {
    const rows = decisions.map(decision => {
      const status = decision.status === 'open' ? '<span class="badge b-warn">OPEN</span>' : decision.status === 'locked' ? '<span class="badge b-ok">LOCKED</span>' : '<span class="badge b-neutral">REMOVED</span>';
      const decider = decision.status === 'locked' ? `<span class="badge ${decision.by === 'human' ? 'b-ok' : 'b-neutral'}">${decision.by.toUpperCase()}</span>` : '—';
      const result = decision.status === 'locked' ? decision.selected.title : decision.status === 'removed' ? decision.reason : 'Pending';
      return `<tr><td>${decision.id}</td><td>${status}</td><td>${decider}</td><td>${escapeHtml(decision.question)}</td><td>${escapeHtml(result)}</td></tr>`;
    }).join('');
    parts.push(section('Decision Log', `<div class="table-wrap"><table><thead><tr><th>ID</th><th>Status</th><th>Decider</th><th>Decision</th><th>Outcome</th></tr></thead><tbody>${rows}</tbody></table></div>`));
  }

  const open = decisions.filter((decision): decision is OpenDecision => decision.status === 'open');
  if (open.length) {
    const content = open.map(decision => {
      const cards = decision.options.map(option => `<article class="option-card"><h4>${escapeHtml(option.id!)}. ${escapeHtml(option.title)}</h4>${rich(option, markdown)}</article>`).join('');
      return `<article><h3>${decision.id} — ${escapeHtml(decision.question)}</h3><div class="options-grid ${decision.layout}">${cards}</div><div class="opinion"><div class="tag">AI leaning — ${escapeHtml(decision.leaning)}</div><p>${escapeHtml(decision.aiComment)}</p></div></article>`;
    }).join('');
    parts.push(section('Open Decisions', content));
  }

  const locked = decisions.filter((decision): decision is LockedDecision => decision.status === 'locked');
  if (locked.length) {
    const ordered = [...locked.filter(decision => decision.layout === 'full'), ...locked.filter(decision => decision.layout === 'grid')];
    const content = ordered.map(decision => `<article class="locked ${decision.layout}"><div class="decision-problem"><div class="decision-kicker"><span class="decision-id">${decision.id}</span><span>Problem</span></div><h3>${escapeHtml(decision.question)}</h3></div><div class="decision-choice"><span class="decision-field">Decision</span><h4><span>${escapeHtml(decision.selected.id!)}</span>${escapeHtml(decision.selected.title)}</h4></div><div class="decision-description"><span class="decision-field">Description</span><div>${rich(decision.selected, markdown)}</div></div></article>`).join('');
    parts.push(section('Locked Decisions', `<div class="locked-grid">${content}</div>`));
  }

  if (risks.length) {
    const rows = risks.map(risk => `<tr><td>${risk.id}</td><td>${escapeHtml(risk.kind)}</td><td>${escapeHtml(risk.description)}</td><td><span class="badge ${badgeClass(risk.severity)}">${risk.severity}</span></td><td>${risk.tests.map(escapeHtml).join(', ')}</td></tr>`).join('');
    parts.push(section('Risks', `<div class="table-wrap"><table><thead><tr><th>ID</th><th>Kind</th><th>Risk / Edge Case</th><th>Severity</th><th>Tests</th></tr></thead><tbody>${rows}</tbody></table></div>`));
  }

  if (tests.length) {
    const rows = tests.map(test => {
      const testerClass = test.tester === 'unit' ? 'b-accent' : test.tester === 'human' ? 'b-warn' : 'b-neutral';
      const statusClass = test.status === 'success' ? 'b-ok' : test.status === 'fail' ? 'b-bad' : 'b-neutral';
      return `<tr><td>${test.id}</td><td><span class="badge ${testerClass}">${test.tester.toUpperCase()}</span></td><td>${escapeHtml(test.description)}</td><td>${escapeHtml(test.method)}</td><td><span class="badge ${statusClass}">${test.status.toUpperCase()}</span></td></tr>`;
    }).join('');
    parts.push(section('Testing', `<div class="table-wrap"><table><thead><tr><th>ID</th><th>Tester</th><th>What's Tested</th><th>How To Test</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`));
  }

  if (doc.steps.length) {
    const items = doc.steps.map(step => `<li><strong>${step.id}.</strong> ${escapeHtml(step.action)} <span class="verify">Verify: ${escapeHtml(step.verify)}</span></li>`).join('');
    parts.push(section('Implementation Steps', `<ol class="steps">${items}</ol>`));
  }

  for (const custom of doc.sections) parts.push(section(custom.title, rich(custom, markdown)));

  const customCss = doc.css ? `\n@scope (#agentdoc-root) {\n${doc.css}\n}` : '';
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(doc.title)}</title>
<style>
:root {
  --bg: #15181e; --fg: #e2e4e9; --muted: #9aa1ad;
  --border: rgba(148,163,184,0.25); --code-bg: rgba(148,163,184,0.12);
  --ok-bg: #064e3b; --ok-fg: #6ee7b7; --warn-bg: #78350f; --warn-fg: #fcd34d;
  --bad-bg: #7f1d1d; --bad-fg: #fca5a5; --accent: #a5b4fc;
  --accent-bg: rgba(165,180,252,0.08); --neutral-bg: #374151; --neutral-fg: #d1d5db;
}
* { box-sizing: border-box; }
body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; width: 100%; max-width: 900px; margin: 0 auto; padding: 2rem; color: var(--fg); background: var(--bg); overflow-wrap: break-word; }
h1 { font-size: 1.75rem; font-weight: 600; border-bottom: 2px solid currentColor; padding-bottom: .3rem; margin-bottom: .65rem; }
h2 { font-size: 1.35rem; font-weight: 600; margin-top: 2.5rem; }
h3 { font-size: 1.15rem; font-weight: 600; margin-top: 1.5rem; }
a { color: var(--accent); }
code, pre { font-family: 'SF Mono', Monaco, Consolas, monospace; background: var(--code-bg); border-radius: 4px; }
code { padding: .1em .3em; } pre { padding: 1rem; overflow-x: auto; }
table { border-collapse: collapse; display: block; max-width: 100%; overflow-x: auto; margin: 1rem 0; font-variant-numeric: tabular-nums; }
.table-wrap { max-width: 100%; overflow-x: auto; margin: 1rem 0; border: 1px solid var(--border); border-radius: 8px; }
.table-wrap table { display: table; width: 100%; margin: 0; overflow: visible; }
.table-wrap th { background: rgba(165,180,252,.1); color: var(--fg); }
.table-wrap th:first-child, .table-wrap td:first-child { background: rgba(165,180,252,.14); color: var(--accent); font-weight: 700; text-align: center; }
.table-wrap tbody tr:nth-child(even) { background: rgba(148,163,184,.06); }
.table-wrap tbody tr:last-child td { border-bottom: 0; }
th, td { padding: .5rem .6rem; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
th { font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
tbody tr:hover { background: var(--accent-bg); }
.description { font-size: 1.05rem; color: var(--muted); }
.badge { display: inline-block; padding: .15rem .6rem; border-radius: 999px; font-weight: 600; font-size: .85rem; white-space: nowrap; }
.b-ok { background: var(--ok-bg); color: var(--ok-fg); } .b-warn { background: var(--warn-bg); color: var(--warn-fg); }
.b-bad { background: var(--bad-bg); color: var(--bad-fg); } .b-neutral { background: var(--neutral-bg); color: var(--neutral-fg); }
.b-accent { background: var(--accent-bg); color: var(--accent); }
.evaluation-panel { margin: 1rem 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.evaluation-row { display: grid; grid-template-columns: 7.5rem 10rem minmax(0, 1fr); gap: .45rem; align-items: center; padding: .65rem .8rem; border-bottom: 1px solid var(--border); }
.evaluation-row:last-child { border-bottom: 0; }
.evaluation-metric { text-transform: uppercase; letter-spacing: .05em; font-size: .75rem; }
.evaluation-scale { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid var(--tone-fg); border-radius: 999px; overflow: hidden; }
.evaluation-scale span { padding: .08rem .3rem; border-right: 1px solid var(--border); color: var(--muted); font-size: .72rem; text-align: center; }
.evaluation-scale span:last-child { border-right: 0; }
.evaluation-scale span.active { background: var(--tone-bg); color: var(--tone-fg); font-weight: 700; }
.evaluation-reason { grid-column: 2 / -1; color: var(--muted); font-size: .9rem; margin: 0; }
.tone-ok { --tone-bg: var(--ok-bg); --tone-fg: var(--ok-fg); }
.tone-warn { --tone-bg: var(--warn-bg); --tone-fg: var(--warn-fg); }
.tone-bad { --tone-bg: var(--bad-bg); --tone-fg: var(--bad-fg); }
.options-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: .8rem; margin: .8rem 0; }
.options-grid.full { grid-template-columns: 1fr; }
.option-card { border: 1px solid var(--border); border-left: 4px solid var(--accent); border-radius: 6px; padding: .8rem 1rem; min-width: 0; }
.option-card h4 { margin: 0 0 .3rem; }
.opinion { border-left: 4px solid var(--accent); background: var(--accent-bg); padding: .8rem 1rem; margin: 1rem 0; border-radius: 0 6px 6px 0; }
.opinion .tag { color: var(--accent); font-size: .85rem; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
.locked-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .8rem; }
.locked { border: 1px solid var(--border); border-top: 4px solid var(--accent); border-radius: 6px; padding: .8rem 1rem; min-width: 0; }
.locked.full { grid-column: 1 / -1; }
.decision-kicker { display: flex; align-items: center; gap: .45rem; color: var(--muted); font-size: .68rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.decision-id { padding: .08rem .4rem; border-radius: 999px; background: var(--accent-bg); color: var(--accent); }
.decision-problem h3 { margin: .4rem 0 .75rem; }
.decision-choice { padding: .65rem .75rem; border: 1px solid rgba(165,180,252,.28); border-radius: 6px; background: var(--accent-bg); }
.decision-field { display: block; margin-bottom: .25rem; color: var(--muted); font-size: .66rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.decision-choice h4 { display: flex; align-items: baseline; gap: .45rem; margin: 0; }
.decision-choice h4 > span { color: var(--accent); }
.decision-description { margin-top: .75rem; padding-top: .65rem; border-top: 1px solid var(--border); }
.decision-description > div > :first-child { margin-top: 0; }
.decision-description > div > :last-child { margin-bottom: 0; }
.verify { display: block; color: var(--muted); font-size: .9rem; }
@media (max-width: 720px) { body { padding: 1rem; } .locked-grid { grid-template-columns: 1fr; } }
@media (max-width: 520px) { .evaluation-row { grid-template-columns: 1fr; } .evaluation-scale { grid-column: 1; grid-row: 2; width: 10rem; } .evaluation-reason { grid-column: 1; } }
${customCss}
</style>
</head>
<body id="agentdoc-root" class="agentdoc">
<header><h1>${escapeHtml(doc.title)}</h1><span class="badge b-accent">${DOCUMENT_KINDS[doc.kind]}</span><p class="description">${escapeHtml(doc.description).replaceAll('\n', ' ')}</p></header>
<main>${parts.join('\n')}</main>
<script>
document.addEventListener('click', event => {
  const target = event.target instanceof Element ? event.target.closest('a[data-vault-doc]') : null;
  const ref = target?.getAttribute('data-vault-doc');
  if (!ref || window.parent === window) return;
  const [project, slug, ...rest] = ref.split('/');
  if (rest.length || !/^[a-z0-9-]+$/.test(project) || !/^[a-z0-9-]+$/.test(slug)) return;
  window.parent.postMessage({ type: 'agentdocs:navigate', project, slug }, '*');
});
</script>
</body>
</html>`;
  return { html, title: doc.title, id: doc.id, schema: doc.schema, warnings: doc.warnings };
}
