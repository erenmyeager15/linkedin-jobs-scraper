import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesWorkplace, resolveWorkplace, workplaceTypesFromUrl } from './workplace.js';

test('public role criteria, TELECOMMUTE, title and location preserve inspectable evidence', () => {
  for (const input of [{ criteria: 'Remote' }, { structuredLocationTypes: ['TELECOMMUTE'] },
    { title: 'Senior Software Engineer - Remote' }, { location: 'Remote, United States' }]) {
    const result = resolveWorkplace(input);
    assert.equal(result.workplaceType, 'Remote');
    assert.equal(result.workplaceEvidenceStatus, 'explicit');
    assert.equal(result.workplaceEvidence.length, 1);
    assert.ok(result.workplaceEvidence[0].text.length <= 280);
    assert.equal(matchesWorkplace(result, ['remote']), true);
    assert.equal(matchesWorkplace(result, ['hybrid']), false);
  }
});

test('source-specific role sentences distinguish hybrid jobs and actual remote roles', () => {
  for (const description of ['This role is categorized as hybrid. You must report at least 3 times per week.',
    'You will work out of our Duluth, GA location on a Hybrid work schedule.']) {
    const result = resolveWorkplace({ description });
    assert.equal(result.workplaceType, 'Hybrid');
    assert.equal(result.workplaceEvidence[0].source, 'role-description');
  }
  const result = resolveWorkplace({ description: 'While this is a remote position, occasional travel is required. Home or Hybrid employees need internet access.' });
  assert.equal(result.workplaceType, 'Remote');
  assert.match(result.workplaceEvidence[0].text, /remote position/);
});

test('employee benefits and company-wide policies are not workplace evidence for a role', () => {
  for (const description of ['Benefits include on-site health and wellness centers.',
    'Our remote-first company lets most roles work from almost anywhere. Some positions require office attendance.',
    'Home-office reimbursement for remote employees.',
    'We foster a hybrid workplace and support all employees.',
    'For most roles we require 50% in-person time.',
    'Remote and Hybrid employees must meet our home internet requirements.']) {
    const result = resolveWorkplace({ description });
    assert.equal(result.workplaceType, null, description);
    assert.equal(result.workplaceEvidenceStatus, 'unknown', description);
  }
});

test('negation, preference and technical meanings cannot satisfy a remote filter', () => {
  for (const input of [{ title: 'Remote Sensing Software Engineer' }, { title: 'Remote Desktop Engineer' },
    { title: 'Software Engineer, remote optional' }, { description: 'This role is not remote.' },
    { description: 'This position is not eligible for remote work.' },
    { description: 'This is a remote position if preferred.' }]) {
    const result = resolveWorkplace(input);
    assert.equal(result.workplaceType, null, JSON.stringify(input));
    assert.equal(matchesWorkplace(result, ['remote']), false);
  }
});

test('contradictory role evidence remains conflicting instead of choosing the first keyword', () => {
  for (const input of [{ title: 'Software Engineer - Remote', description: 'This role is categorized as hybrid.' },
    { title: 'Software Engineer - Remote', description: 'This role is not remote.' },
    { criteria: 'Hybrid', structuredLocationTypes: ['TELECOMMUTE'] }, { criteria: 'Remote or Hybrid' }]) {
    const result = resolveWorkplace(input);
    assert.equal(result.workplaceEvidenceStatus, 'conflicting', JSON.stringify(input));
    assert.equal(result.workplaceType, null);
    assert.equal(matchesWorkplace(result, ['remote', 'hybrid']), false);
  }
});

test('generic optional policy does not invalidate explicit evidence for this position', () => {
  const result = resolveWorkplace({ description: 'Remote/Hybrid employees may need special internet equipment. While this is a remote position, occasional travel is required.' });
  assert.equal(result.workplaceType, 'Remote');
  assert.equal(result.workplaceEvidenceStatus, 'explicit');
});

test('workplace URL filters retain unions and direct/unfiltered requests do not inherit them', () => {
  assert.deepEqual(workplaceTypesFromUrl('https://www.linkedin.com/jobs/search/?f_WT=2,3&f_WT=1,2'), ['remote', 'hybrid', 'onsite']);
  assert.deepEqual(workplaceTypesFromUrl('https://www.linkedin.com/jobs/view/1234567'), []);
  const unknown = resolveWorkplace({});
  assert.equal(matchesWorkplace(unknown, []), true);
  assert.equal(matchesWorkplace(unknown, ['remote']), false);
});

test('evidence snippets include the matched arrangement even in a long source sentence', () => {
  const result = resolveWorkplace({ description: `${'Background information '.repeat(30)} While this is a remote position, occasional travel is required.` });
  assert.equal(result.workplaceType, 'Remote');
  assert.match(result.workplaceEvidence[0].text, /remote position/);
});
