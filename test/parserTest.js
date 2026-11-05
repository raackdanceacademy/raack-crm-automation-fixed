// test/parserTest.js — run with:  npm run test:parser
// Checks the message parser against real and edge-case messages. No server,
// no WhatsApp, no Google Sheet needed.

import assert from 'assert';
import { parseIssueMessage } from '../services/messageParser.js';

let passed = 0;
function ok(label, fn) {
  try { fn(); passed++; console.log(`✅ ${label}`); }
  catch (e) { console.error(`❌ ${label}\n   ${e.message}`); process.exitCode = 1; }
}

// 1) The exact message that used to be rejected (labeled, multi-line, dots in date,
//    several names/phone inside the code line, free-form description).
ok('real labeled message (Mannivakkam) is accepted', () => {
  const r = parseIssueMessage(`Date: 17.9.2026
Studio: Mannivakkam
Student Code / Phone Number: RK02125466 /Guhan Krish.D.S/9710067007
Issue Description:  The above mentioned kid has joined the flow batch. Their fees amount is not showing while making the payment. Please rectify the issue earliest. This issue sent September 17th.Still not solve the issue. parents asking sir,`);
  assert.equal(r.date, '17.9.2026');
  assert.equal(r.studio, 'Mannivakkam');
  assert.equal(r.student_code_or_phone, 'RK02125466 /Guhan Krish.D.S/9710067007');
  assert.match(r.issue_description, /^The above mentioned kid has joined the flow batch\./);
  assert.match(r.issue_description, /parents asking sir,$/);
});

// 2) Unlabeled 4-line format (the earlier working one).
ok('unlabeled 4-line message still works', () => {
  const r = parseIssueMessage('24-09-2026\nVelachery\nRK04222193\nRemove August month fees');
  assert.deepEqual(r, { date: '24-09-2026', studio: 'Velachery', student_code_or_phone: 'RK04222193', issue_description: 'Remove August month fees' });
});

// 3) One-line labeled format still works.
ok('one-line labeled message still works', () => {
  const r = parseIssueMessage('Date 24-09-2026 ,Studio : Guduvanchery , Student code / Phone Number : RK00313948 , Issue Description : Remove october month fees');
  assert.equal(r.date, '24-09-2026');
  assert.equal(r.studio, 'Guduvanchery');
  assert.equal(r.student_code_or_phone, 'RK00313948');
  assert.equal(r.issue_description, 'Remove october month fees');
});

// 4) Description is free — any wording, multi-line, colons, dashes, other languages.
ok('description may be multi-line and contain colons/dashes', () => {
  const r = parseIssueMessage('Date: 24-09-2026\nStudio: Adyar\nStudent Code / Phone Number: 9876543210\nIssue Description: Fee - not showing.\nNote: parent called twice:\nplease check');
  assert.equal(r.student_code_or_phone, '9876543210');
  assert.equal(r.issue_description, 'Fee - not showing. Note: parent called twice: please check');
});
ok('unlabeled description on many lines / any wording', () => {
  const r = parseIssueMessage('24/09/2026\nAdyar\n9876543210\nfees not coming\nkindly check sir\nurgent!!');
  assert.equal(r.issue_description, 'fees not coming kindly check sir urgent!!');
});
ok('label spelled differently / bold WhatsApp markup', () => {
  const r = parseIssueMessage('*Date:* 17.9.2026\n*Studio:* Adyar\n*Student code/Phone number:* RK0001234\n*Issue description:* not able to pay');
  assert.equal(r.studio, 'Adyar');
  assert.equal(r.student_code_or_phone, 'RK0001234');
  assert.equal(r.issue_description, 'not able to pay');
});
ok('labeled message with description label missing', () => {
  const r = parseIssueMessage('Date: 17.9.2026\nStudio: Adyar\nStudent Code: RK0001234\nfees not showing');
  assert.equal(r.issue_description, 'fees not showing');
});
ok('empty description is still accepted (3 required items present)', () => {
  const r = parseIssueMessage('17-09-2026\nAdyar\nRK0001234');
  assert.equal(r.studio, 'Adyar');
  assert.equal(r.issue_description, '');
});
ok('textual date accepted', () => {
  const r = parseIssueMessage('17th Sep 2026\nAdyar\nRK0001234\nfees issue');
  assert.equal(r.date, '17th Sep 2026');
});

// 5) Things that must NOT become rows.
ok('chit-chat is skipped', () => assert.equal(parseIssueMessage('Good morning!'), null));
ok('thank you is skipped', () => assert.equal(parseIssueMessage('Thank you sir'), null));
ok('missing student code is skipped', () => assert.equal(parseIssueMessage('24-09-2026\nkandigai\nplease remove fees for this month'), null));
ok('missing studio (labeled) is skipped', () => assert.equal(parseIssueMessage('Date: 17.9.2026\nStudent Code: RK0001234\nIssue: fees'), null));
ok('empty / non-string input is skipped', () => { assert.equal(parseIssueMessage(''), null); assert.equal(parseIssueMessage(undefined), null); });

console.log(`\n${passed} checks passed${process.exitCode ? ' — SOME FAILED' : ''}.`);
