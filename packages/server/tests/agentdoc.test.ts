import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAgentDoc, renderAgentDoc } from '../src/agentdoc.js';

const evaluations = `@evaluations
@evaluation metric=size level=1
The change stays within one system.
@end-evaluation
@evaluation metric=complexity level=1
The implementation has one clear path.
@end-evaluation
@evaluation metric=risk level=1
Existing formats remain isolated.
@end-evaluation
@end-evaluations`;

const header = `@schema agentdocs/v1
@id example-spec
@title "Example Specification"
@kind specification
@description
This document describes the example DSL. It remains intentionally small.
@end-description`;

describe('AgentDoc parser', () => {
  it('parses the repository specification as a representative document', () => {
    const source = readFileSync(path.resolve('../../architecture/agentdoc-dsl-specification.agentdoc'), 'utf8');
    const doc = parseAgentDoc(source);
    expect(doc).toMatchObject({
      id: 'agentdoc-dsl-specification',
      kind: 'specification',
      warnings: [],
    });
    expect(doc.decisions.find(decision => decision.id === 'D1')).toMatchObject({ status: 'locked', layout: 'grid' });
    expect(doc.decisions.find(decision => decision.id === 'D2')).toMatchObject({ status: 'locked', layout: 'full' });
    expect(doc.decisions.find(decision => decision.id === 'D17')).toMatchObject({ status: 'locked', selected: { id: 'F' } });
    expect(doc.decisions.find(decision => decision.id === 'D18')).toMatchObject({ status: 'locked', selected: { id: 'E' } });
    expect(doc.decisions.find(decision => decision.id === 'D21')).toMatchObject({ status: 'locked', selected: { id: 'A' } });
    const rendered = renderAgentDoc(source, value => value).html;
    expect(rendered.indexOf('<article class="locked full"><div class="decision-problem"')).toBeLessThan(rendered.indexOf('<article class="locked grid"><div class="decision-problem"'));
    expect(rendered).toContain('<article class="evaluation-row tone-warn">');
    expect(rendered).toContain('<div class="evaluation-scale" aria-label="size 2 of 3"><span>0</span><span>1</span><span class="active">2</span><span>3</span></div>');
    expect(rendered).not.toContain('evaluation-score');
    expect(rendered).toContain('grid-template-columns: 7.5rem 10rem minmax(0, 1fr)');
    expect(rendered).toContain('<span class="decision-id">D2</span><span>Problem</span>');
    expect(rendered).toContain('<span class="decision-field">Decision</span>');
    expect(rendered).toContain('<span class="decision-field">Description</span>');
    expect(rendered).toContain('<div class="table-wrap"><table>');
    expect(rendered).toContain('.table-wrap tbody tr:nth-child(even)');
    expect(rendered).toContain('.table-wrap table { display: table; width: 100%;');
  });

  it('parses the required specification fields', () => {
    const doc = parseAgentDoc(`${header}\n${evaluations}`);
    expect(doc).toMatchObject({
      schema: 'agentdocs/v1',
      id: 'example-spec',
      title: 'Example Specification',
      kind: 'specification',
    });
    expect(doc.evaluations.map(value => value.metric)).toEqual(['size', 'complexity', 'risk']);
  });

  it('makes top-level and named child placement irrelevant', () => {
    const reordered = `@evaluations
@evaluation metric=risk level=1
Existing formats remain isolated.
@end-evaluation
@evaluation metric=size level=1
The change stays within one system.
@end-evaluation
@evaluation metric=complexity level=1
The implementation has one clear path.
@end-evaluation
@end-evaluations
@description
This document describes the example DSL. It remains intentionally small.
@end-description
@kind specification
@title "Example Specification"
@id example-spec
@schema agentdocs/v1`;
    expect(parseAgentDoc(reordered)).toEqual(parseAgentDoc(`${header}\n${evaluations}`));
  });

  it('keeps rich bodies verbatim and unescapes doubled directive sigils', () => {
    const source = `${header}
${evaluations}
@section format=html title="Visual"
<div>
@@end-section
</div>
@end-section`;
    expect(parseAgentDoc(source).sections[0].body).toContain('@end-section');
  });

  it.each([
    [`@schema agentdocs/v2\n${header.replace('@schema agentdocs/v1\n', '')}\n${evaluations}`, 'unsupported version'],
    [`${header}\n@title "Duplicate"\n${evaluations}`, 'duplicate @title'],
    [`${header}`, 'evaluations: required'],
    [`${header}\n${evaluations}\n@section format=html title="Unsafe"\n<script>alert(1)</script>\n@end-section`, 'not allowed'],
    [`${header}\n${evaluations}\n@css\n} body { color: red; }\n@end-css`, 'must be balanced'],
  ])('rejects invalid source without guessing: %s', (source, message) => {
    expect(() => parseAgentDoc(source)).toThrow(message);
  });

  it('returns lint warnings without rejecting valid source', () => {
    const doc = parseAgentDoc(`${header.replace('This document describes the example DSL. It remains intentionally small.', 'Brief.')}\n${evaluations}\n@css\n.mock { min-height: 4rem; }\n@end-css`);
    expect(doc.warnings).toEqual([
      'document.description: prefer two or three sentences',
      'document.css: custom CSS should be used only when generated styles cannot express the design',
    ]);
  });

  it('reports invalid decision and risk references together', () => {
    const source = `${header}
${evaluations}
@decisions
@decision id=D1 status=open
@question
Choose one.
@end-question
@option id=A format=markdown title="Only"
Only one option.
@end-option
@leaning option=B
@ai-comment
Option B seems preferable.
@end-ai-comment
@end-decision
@end-decisions
@risks
@risk id=R1 kind=general severity=2 tests=T9
@description
The choice may be wrong.
@end-description
@end-risk
@end-risks`;
    expect(() => parseAgentDoc(source)).toThrowError(expect.objectContaining({
      message: expect.stringContaining('at least two options required'),
    }));
    try {
      parseAgentDoc(source);
    } catch (error) {
      expect((error as Error).message).toContain('unknown option "B"');
      expect((error as Error).message).toContain('unknown test "T9"');
    }
  });
});

describe('AgentDoc renderer', () => {
  it.each([
    ['specification', 'SPECIFICATION'],
    ['implementation-plan', 'IMPLEMENTATION PLAN'],
    ['exploration', 'EXPLORATION'],
    ['handoff', 'HANDOFF'],
    ['design-doc', 'DESIGN DOC'],
  ])('renders the %s kind label', (kind, label) => {
    let source = `${header.replace('@kind specification', `@kind ${kind}`)}\n${evaluations}`;
    if (kind === 'implementation-plan') source += `\n@steps\n@step id=S1\n@action\nDo it.\n@end-action\n@verify\nCheck it.\n@end-verify\n@end-step\n@end-steps`;
    expect(renderAgentDoc(source, value => value).html).toContain(`>${label}</span>`);
  });

  it('renders canonical order, decision states, risks, tests, steps, and rich sections', () => {
    const source = `${header}
${evaluations}
@references
@reference doc=demo/other label="Other Document"
@end-references
@decisions
@decision id=D2 status=locked by=human layout=full
@question
Who owns formatting?
@end-question
@selected id=A format=markdown title="Renderer"
The **renderer** owns it.
@end-selected
@end-decision
@decision id=D1 status=open layout=full
@question
Which layout?
@end-question
@option id=A format=markdown title="Cards"
Compact cards.
@end-option
@option id=B format=html title="Mock"
<figure>Mock</figure>
@end-option
@leaning option=A
@ai-comment
Cards are easier to compare.
@end-ai-comment
@end-decision
@decision id=D3 status=removed
@question
Keep a redundant section?
@end-question
@reason
It duplicates the decision log.
@end-reason
@end-decision
@end-decisions
@risks
@risk id=R1 kind=edge-case severity=2 tests=T1
@description
The renderer may reorder content incorrectly.
@end-description
@end-risk
@end-risks
@tests
@test id=T1 tester=unit status=waiting
@description
Canonical rendering order.
@end-description
@method
Compare heading positions.
@end-method
@end-test
@end-tests
@steps
@step id=S1
@action
Implement the parser.
@end-action
@verify
Run unit tests.
@end-verify
@end-step
@end-steps
@section format=html title="Visual Detail"
<figure>Trusted mock</figure>
@end-section
@css
.mock { min-height: 4rem; }
@end-css`;
    const result = renderAgentDoc(source, value => `<md>${value}</md>`);
    expect(result).toMatchObject({ title: 'Example Specification', id: 'example-spec', schema: 'agentdocs/v1' });
    expect(result.html).toContain('<title>Example Specification</title>');
    expect(result.html).toContain('data-vault-doc="demo/other"');
    expect(result.html).toContain('options-grid full');
    expect(result.html).toContain('<md>The **renderer** owns it.</md>');
    expect(result.html).toContain('<div class="locked-grid">');
    expect(result.html).toContain('<article class="locked full">');
    expect(result.html).toContain('grid-template-columns: repeat(3, minmax(0, 1fr))');
    expect(result.html).toContain('<figure>Trusted mock</figure>');
    expect(result.html).toContain('@scope (#agentdoc-root)');
    expect(result.html).toContain("postMessage({ type: 'agentdocs:navigate'");
    const headings = ['References', 'Evaluations', 'Decision Log', 'Open Decisions', 'Locked Decisions', 'Risks', 'Testing', 'Implementation Steps', 'Visual Detail'];
    const positions = headings.map(value => result.html.indexOf(`<h2>${value}</h2>`));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});
