'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const { test } = require('node:test');
const { parse } = require('yaml');

function runHelper(file, options = {}) {
  const commands = [];
  const states = [];
  const logs = [];
  let failure;
  const context = {
    Buffer,
    process: { env: options.env || { GITHUB_STATE: '/state' } },
    console: { log: message => logs.push(message) },
    require(name) {
      if (name === 'child_process') return {
        execFileSync(command, args, settings) {
          commands.push({ command, args: Array.from(args), settings });
          if (command === 'getfacl') return options.acl;
          if (options.failGrant && args.includes('-m')) throw new Error('grant failed');
          if (options.failRestore && args.includes('--restore=-')) throw new Error('restore failed');
          if (options.executeAcl && command === 'sudo') {
            execAcl(args.slice(1).map(arg => arg === '/dev/kvm' ? options.device : arg), settings);
          }
        },
      };
      if (name === 'fs') return {
        existsSync: () => options.deviceExists !== false,
        appendFileSync: (destination, content) => states.push({ destination, content }),
      };
      if (name === 'os') return { userInfo: () => ({ username: options.user || 'runner' }) };
      if (name === './common') return { KVM_DEVICE: '/dev/kvm', hasCommand: () => options.hasAcl !== false };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  };
  try {
    vm.runInNewContext(fs.readFileSync(path.join(options.helperPath || path.join(__dirname, '../kvm-access'), file), 'utf8'), context);
  } catch (error) {
    failure = error;
  }
  return { commands, states, logs, failure };
}

function execAcl(args, options = {}) {
  const result = spawnSync('setfacl', args, { encoding: 'utf8', input: options.input });
  assert.equal(result.status, 0, result.stderr);
}

function readAcl(device) {
  const result = spawnSync('getfacl', ['--absolute-names', '--numeric', device], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('registered KVM post hook restores the ACL after workspace checkout cleanup', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qemu-kvm-checkout-test-'));
  try {
    const action = parse(fs.readFileSync(path.join(__dirname, '../action.yml'), 'utf8'));
    const enable = action.runs.steps.find(step => step.name === 'Enable KVM access');
    assert.match(enable.uses, /^eclipse-score\/cicd-actions\/setup-qemu-latest\/kvm-access@[0-9a-f]{40}$/);
    const [actionName, ref] = enable.uses.split('@');
    const workspace = path.join(temporary, 'workspace');
    const helperPath = path.join(temporary, '_actions', actionName, ref);
    fs.mkdirSync(workspace);
    fs.cpSync(path.join(__dirname, '../kvm-access'), helperPath, { recursive: true });
    const helper = parse(fs.readFileSync(path.join(helperPath, 'action.yml'), 'utf8'));
    const acl = '# file: /dev/kvm\nuser::rw-\ngroup::rw-\nmask::r--\nother::---\n';
    const main = runHelper(helper.runs.main, { acl, helperPath });
    assert.equal(main.failure, undefined);
    assert.equal(main.states.length, 1);
    const encoded = main.states[0].content.trim().slice('original-acl='.length);

    const initialized = spawnSync('git', ['init', '--quiet', workspace], { encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    const alias = path.join(workspace, '.setup-qemu-latest-kvm-access');
    fs.symlinkSync(helperPath, alias);
    const cleaned = spawnSync('git', ['clean', '-ffdx'], { cwd: workspace, encoding: 'utf8' });
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(fs.existsSync(alias), false);

    const post = runHelper(helper.runs.post, { helperPath, env: { 'STATE_original-acl': encoded } });
    assert.equal(post.failure, undefined);
    assert.deepEqual(post.commands[0].args, ['setfacl', '--restore=-']);
    assert.equal(post.commands[0].settings.input, acl);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

for (const existingUser of ['', 'user:runner:r--\n', 'user:runner:rw-\n']) {
  test(`KVM cleanup restores the original ACL, including mask and user ${JSON.stringify(existingUser)}`, () => {
    const acl = `# file: /dev/kvm\n# owner: root\n# group: kvm\nuser::rw-\n${existingUser}group::rw-\nmask::r--\nother::---\n`;
    const main = runHelper('main.js', { acl });
    assert.equal(main.failure, undefined);
    assert.equal(main.states.length, 1);
    assert.equal(main.states[0].destination, '/state');
    const encoded = main.states[0].content.trim().slice('original-acl='.length);
    assert.equal(Buffer.from(encoded, 'base64').toString(), acl);
    assert.deepEqual(main.commands.at(-1).args,
      ['setfacl', '--no-mask', '-m', 'group::r--,user:runner:rw-,mask::rw-', '/dev/kvm']);
    const post = runHelper('post.js', { env: { 'STATE_original-acl': encoded } });
    assert.equal(post.failure, undefined);
    assert.deepEqual(post.commands[0].args, ['setfacl', '--restore=-']);
    assert.equal(post.commands[0].settings.input, acl);
  });
}

test('KVM setup with no device records no state and cleanup does nothing', () => {
  const main = runHelper('main.js', { deviceExists: false });
  assert.equal(main.commands.length, 0);
  assert.equal(main.states.length, 0);
  assert.equal(runHelper('post.js', { env: {} }).commands.length, 0);
});

test('KVM saves the original ACL before a grant failure', () => {
  const main = runHelper('main.js', { acl: 'user::rw-\ngroup::r--\nother::---\n', failGrant: true });
  assert.match(main.failure.message, /grant failed/);
  assert.equal(main.states.length, 1);
});

test('KVM installs ACL tools before reading the original ACL', () => {
  const main = runHelper('main.js', { acl: 'user::rw-\ngroup::r--\nother::---\n', hasAcl: false });
  assert.equal(main.failure, undefined);
  assert.deepEqual(main.commands[0].args, ['apt-get', 'update']);
  assert.deepEqual(main.commands[1].args, ['apt-get', 'install', '-y', 'acl']);
  assert.equal(main.commands[2].command, 'getfacl');
});

test('KVM rejects unexpected ACL entries without changing permissions', () => {
  const main = runHelper('main.js', { acl: 'user::rw-\nunexpected entry\n' });
  assert.match(main.failure.message, /Unexpected KVM ACL entry/);
  assert.equal(main.states.length, 1);
  assert.equal(main.commands.length, 1);
});

for (const mask of ['r--', 'r-x', '---', null]) {
  test(`KVM grant preserves unrelated effective permissions with mask ${mask}`, () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qemu-kvm-mask-test-'));
    try {
      const device = path.join(temporary, 'device');
      fs.writeFileSync(device, '');
      const user = '12345';
      const entries = ['user::rw-', 'group::rw-', 'other::---'];
      if (mask !== null) {
        entries.push(`user:${user}:r-x`, 'user:12346:rwx', 'group:12347:-wx', `mask::${mask}`);
      }
      execAcl(['--no-mask', '--set', entries.join(','), device]);
      const original = readAcl(device);
      const main = runHelper('main.js', { acl: original, user, device, executeAcl: true });
      assert.equal(main.failure, undefined);
      const granted = readAcl(device);
      const permissions = acl => {
        const parsed = Object.fromEntries(acl.split('\n').filter(line => /^(user|group|mask|other):/.test(line))
          .map(line => {
            const [type, name, value] = line.split(/\s+#/)[0].split(':');
            return [`${type}:${name}`, value];
          }));
        const aclMask = parsed['mask:'] || 'rwx';
        return Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'mask:').map(([key, value]) => {
          const masked = key.startsWith('group:') || (key.startsWith('user:') && key !== 'user:');
          return [key, masked ? Array.from(value, (permission, index) =>
            permission === aclMask[index] ? permission : '-').join('') : value];
        }));
      };
      const before = permissions(original);
      const after = permissions(granted);
      assert.equal(after[`user:${user}`], 'rw-');
      for (const [entry, effective] of Object.entries(before)) {
        if (entry !== `user:${user}`) assert.equal(after[entry], effective, entry);
      }
      const encoded = main.states[0].content.trim().slice('original-acl='.length);
      const post = runHelper('post.js', {
        device, executeAcl: true, env: { 'STATE_original-acl': encoded },
      });
      assert.equal(post.failure, undefined);
      assert.equal(readAcl(device), original);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
}

test('KVM cleanup reports a restore failure', () => {
  const post = runHelper('post.js', {
    env: { 'STATE_original-acl': Buffer.from('original ACL').toString('base64') },
    failRestore: true,
  });
  assert.equal(post.failure, undefined);
  assert.match(post.logs[0], /::warning::Failed to restore/);
});
