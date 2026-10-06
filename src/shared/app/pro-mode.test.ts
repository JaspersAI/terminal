import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ALLOW_CONVERSATION,
  ALLOW_SESSION,
  commandEnv,
  commandTimeout,
  isReadOnlyCommand,
  readOnlyFolders,
  sandboxProfile,
  ALLOW_ONCE,
  ALLOW_TASK,
  approvalChoices,
  approvalKey,
  capOutput,
  OUTPUT_DEFAULT,
  PRO_MODE_OFF,
  readApproval,
  readTaskApproval,
  taskApprovalChoices,
  readProMode,
  TIMEOUT_DEFAULT,
  TIMEOUT_MAX,
  TIMEOUT_MIN,
} from './pro-mode.ts'

test('a setting that is missing or malformed comes back off and inside its limits', () => {
  assert.deepEqual(readProMode(undefined), PRO_MODE_OFF)
  assert.deepEqual(readProMode({ enabled: 'yes' }), PRO_MODE_OFF)
  assert.equal(readProMode({ enabled: true }).enabled, true)
  assert.equal(readProMode({ timeoutSeconds: 0 }).timeoutSeconds, TIMEOUT_MIN)
  assert.equal(readProMode({ timeoutSeconds: 10_000 }).timeoutSeconds, TIMEOUT_MAX)
  assert.equal(readProMode({ timeoutSeconds: '45' }).timeoutSeconds, 45)
  assert.equal(readProMode({ timeoutSeconds: 'soon' }).timeoutSeconds, TIMEOUT_DEFAULT)
  assert.equal(readProMode({ outputMax: 10 }).outputMax, 1_000)
  assert.equal(readProMode({ outputMax: null }).outputMax, OUTPUT_DEFAULT)
  assert.equal(readProMode({ approval: 'never' }).approval, 'always')
  assert.equal(readProMode({ approval: 'once' }).approval, 'once')
  assert.equal(readProMode({ approval: 'session' }).approval, 'session')
  // Anything unknown is the narrowest setting, never the widest.
  assert.equal(readProMode({ approval: 'Session' }).approval, 'always')
  assert.equal(readProMode({ allowReadOnly: 'sure' }).allowReadOnly, false)
  assert.equal(readProMode({ allowReadOnly: true }).allowReadOnly, true)
})

test('only the two allowances allow, and one of them only while the setting offers it', () => {
  assert.equal(readApproval(ALLOW_ONCE, 'always'), 'once')
  assert.equal(readApproval(ALLOW_CONVERSATION, 'once'), 'conversation')
  // Offered only in "once" mode: an answer from before the setting changed cannot widen it.
  assert.equal(readApproval(ALLOW_CONVERSATION, 'always'), 'denied')
  assert.equal(readApproval('Deny', 'once'), 'denied')
  assert.equal(readApproval(null, 'once'), 'denied')
  assert.equal(readApproval('allow once', 'always'), 'denied')
  assert.equal(readApproval('sure, go ahead', 'once'), 'denied')
  assert.deepEqual(approvalChoices('always'), [ALLOW_ONCE, 'Deny'])
  assert.deepEqual(approvalChoices('once'), [ALLOW_ONCE, ALLOW_CONVERSATION, 'Deny'])
})

test('allowing every command in a conversation is only an allowance where the setting asks for it', () => {
  assert.equal(readApproval(ALLOW_SESSION, 'session'), 'session')
  // The wider allowance is not on offer in the narrower modes, whatever answer arrives.
  assert.equal(readApproval(ALLOW_SESSION, 'once'), 'denied')
  assert.equal(readApproval(ALLOW_SESSION, 'always'), 'denied')
  // Nor does the per-command allowance appear in session mode, where it is not offered.
  assert.equal(readApproval(ALLOW_CONVERSATION, 'session'), 'denied')
  assert.equal(readApproval(ALLOW_ONCE, 'session'), 'once')
  assert.equal(readApproval('yes to everything', 'session'), 'denied')
  assert.equal(readApproval(null, 'session'), 'denied')
  assert.deepEqual(approvalChoices('session'), [ALLOW_ONCE, ALLOW_SESSION, 'Deny'])
})

test('a call may ask for longer than usual, and never for longer than the setting allows', () => {
  assert.equal(TIMEOUT_DEFAULT, 120)
  // Nothing asked for: the setting stands.
  assert.equal(commandTimeout(undefined, 120), 120)
  assert.equal(commandTimeout(null, 120), 120)
  assert.equal(commandTimeout('soon', 120), 120)
  assert.equal(commandTimeout({}, 120), 120)
  assert.equal(commandTimeout(300, 300), 300)
  assert.equal(commandTimeout(240, 300), 240)
  assert.equal(commandTimeout('240', 300), 240)
  assert.equal(commandTimeout(90.4, 120), 90)
  // The setting is the ceiling: a call asking for more is held to it, however it asks.
  assert.equal(commandTimeout(600, 120), 120)
  assert.equal(commandTimeout(Number.MAX_SAFE_INTEGER, 120), 120)
  assert.equal(commandTimeout(Infinity, 120), 120)
  // And the floor is a second, so nothing is killed before it starts.
  assert.equal(commandTimeout(0, 120), TIMEOUT_MIN)
  assert.equal(commandTimeout(-30, 120), TIMEOUT_MIN)
  assert.equal(commandTimeout(TIMEOUT_MAX + 1, TIMEOUT_MAX), TIMEOUT_MAX)
})

test('an allowance is remembered for one command in one conversation, exactly as written', () => {
  assert.notEqual(approvalKey('w1:thread', 'ls -la'), approvalKey('w1:thread', 'ls -la '))
  assert.notEqual(approvalKey('w1:thread', 'ls'), approvalKey('w2:thread', 'ls'))
  assert.equal(approvalKey('w1:thread', 'ls'), approvalKey('w1:thread', 'ls'))
})

test('output over the cap is cut, and says it was cut', () => {
  assert.equal(capOutput('short', 10), 'short')
  assert.equal(capOutput('0123456789', 10), '0123456789')
  assert.equal(capOutput('0123456789x', 10), '0123456789\n… 1 more character was cut.')
  assert.equal(capOutput('0123456789xyz', 10), '0123456789\n… 3 more characters were cut.')
})

test("a command is given the few variables a program needs and nothing else of the app's", () => {
  const env = commandEnv({
    PATH: '/usr/local/bin:/usr/bin',
    HOME: '/Users/seth',
    ANTHROPIC_API_KEY: 'sk-should-not-travel',
    JASPERS_HOME: '/Users/seth/Jaspers',
    LANG: 'en_US.UTF-8',
    TMPDIR: '',
    TERM: 'xterm-256color',
  })
  assert.deepEqual(env, {
    TERM: 'dumb',
    PATH: '/usr/local/bin:/usr/bin',
    HOME: '/Users/seth',
    LANG: 'en_US.UTF-8',
  })
})

test('a plain read is read-only; anything that could do more is not', () => {
  for (const command of [
    'ls',
    'ls -la subfolder',
    'cat notes.md',
    'grep -n total sheet.csv',
    'git status',
    'git log --oneline -5',
    'wc -l data.csv',
    'find . -name data.csv',
    'sw_vers',
  ]) {
    assert.equal(isReadOnlyCommand(command), true, command)
  }
  for (const command of [
    'rm notes.md',
    'git push',
    // The subcommand has to come first: an option before it takes a value, and reading past one fools the list.
    'git -C repo diff',
    'git commit -m x',
    'cat notes.md | sh',
    'cat notes.md > out.txt',
    'ls; rm -rf .',
    'ls && rm x',
    'echo $(whoami)',
    'echo `whoami`',
    'find . -delete',
    'find . -exec rm {} +',
    'tail -f log.txt',
    'cat ~/.ssh/id_rsa',
    // A glob or a ~ is expanded by the shell before the program sees it, so it is asked about.
    'ls *',
    'ls ~',
    'curl https://example.com',
    './script.sh',
    '',
  ]) {
    assert.equal(isReadOnlyCommand(command), false, command)
  }
})

test('the sandbox profile writes only in the folder and reads nothing of the user but it and their tools', () => {
  const profile = sandboxProfile('/Users/seth/Jaspers/shell', ['/usr/bin', '/Users/seth/.nvm/versions/node/v24/bin'])
  assert.match(profile, /^\(version 1\)\n\(allow default\)/)
  assert.match(profile, /\(deny file-write\* \(subpath "\/"\)\)/)
  assert.match(profile, /\(allow file-write\* \(subpath "\/Users\/seth\/Jaspers\/shell"\)/)
  assert.match(profile, /\(deny file-read\* \(subpath "\/Users"\)\)/)
  // A toolchain the user installed under their home stays readable, so `node` still runs; the rest does not.
  assert.match(profile, /\(allow file-read\*.*\(subpath "\/Users\/seth\/\.nvm\/versions\/node\/v24\/bin"\)/)
  assert.equal(profile.includes('(subpath "/Users/seth/Documents")'), false)
})

test('the profile reads Desktop and Downloads and writes neither', () => {
  const folders = readOnlyFolders('/Users/seth/')
  assert.deepEqual(folders, ['/Users/seth/Desktop', '/Users/seth/Downloads'])
  const profile = sandboxProfile('/Users/seth/Jaspers/shell', ['/usr/bin'], folders)
  const [, , , write, , read] = profile.split('\n')
  for (const folder of folders) {
    assert.equal(read!.includes(`(subpath ${JSON.stringify(folder)})`), true, folder)
    assert.equal(write!.includes(folder), false, folder)
  }
  // The read allowance comes after the deny of /Users, which is what lets it win.
  assert.equal(profile.indexOf('(deny file-read*') < profile.indexOf('Desktop'), true)
  // Nothing else of the home folder comes with them.
  assert.equal(profile.includes('(subpath "/Users/seth")'), false)
  assert.equal(profile.includes('Documents'), false)
})

test('the profile leaves a file workflow room to work: subfolders, the tools on the system, and the network', () => {
  const profile = sandboxProfile('/Users/seth/Jaspers/shell', ['/usr/bin'])
  // A subpath rule covers everything under it, so a script may make its own folders and write in them.
  assert.match(profile, /\(allow file-write\* \(subpath "\/Users\/seth\/Jaspers\/shell"\)/)
  // Where a heredoc and a program's scratch files go.
  for (const path of ['/private/var/folders', '/private/tmp', '/dev']) {
    assert.equal(profile.includes(`(subpath ${JSON.stringify(path)})`), true, path)
  }
  // python3, curl, grep, awk, and diff all live under these, and only /Users is denied for reading.
  for (const path of ['/usr', '/bin', '/etc', '/private', '/System', '/Library']) {
    assert.equal(profile.includes(`(subpath ${JSON.stringify(path)})`), true, path)
  }
  assert.deepEqual(
    profile.split('\n').filter((line) => line.startsWith('(deny')),
    ['(deny file-write* (subpath "/"))', '(deny file-read* (subpath "/Users"))'],
  )
  // Nothing denies the network: curl has to reach EDGAR, and files are what the profile is about.
  assert.equal(/network/.test(profile), false)
})

test("a task's command is allowed for the task or not at all while it is made, and once as well at a run", () => {
  assert.deepEqual(taskApprovalChoices('scheduling'), [ALLOW_TASK, 'Deny'])
  assert.deepEqual(taskApprovalChoices('run'), [ALLOW_ONCE, ALLOW_TASK, 'Deny'])
  assert.equal(readTaskApproval(ALLOW_TASK, 'scheduling'), 'task')
  assert.equal(readTaskApproval(ALLOW_TASK, 'run'), 'task')
  assert.equal(readTaskApproval(ALLOW_ONCE, 'run'), 'once')
  // There is no run yet for once to mean anything, so it is not an answer while the task is made.
  assert.equal(readTaskApproval(ALLOW_ONCE, 'scheduling'), 'denied')
  // Nobody there: a question that timed out or was closed is a no, as everywhere else.
  assert.equal(readTaskApproval(null, 'run'), 'denied')
  assert.equal(readTaskApproval(ALLOW_SESSION, 'run'), 'denied')
  assert.equal(readTaskApproval('allow for this task', 'run'), 'denied')
})
