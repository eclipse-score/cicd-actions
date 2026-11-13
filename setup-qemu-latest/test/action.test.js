'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { parse } = require('yaml');

const action = parse(fs.readFileSync(path.join(__dirname, '../action.yml'), 'utf8'));
const policy = action.runs.steps.find(step => step.id === 'qemu-policy');

for (const scenario of [
  { name: 'relative prefix', prefix: 'local-qemu' },
  { name: 'relative prefix with spaces', prefix: 'local qemu' },
  { name: 'relative prefix with dot segments', prefix: './build/../local-qemu/' },
  { name: 'absolute prefix', prefix: '/opt/qemu/' },
]) {
  test(`${scenario.name} is normalized once against the workspace`, () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qemu-prefix-test-'));
    try {
      const workspace = path.join(temporary, 'workspace');
      const source = path.join(workspace, 'qemu-11.1.3');
      fs.mkdirSync(source, { recursive: true });
      const compute = action.runs.steps.find(step => step.id === 'vars');
      const output = path.join(temporary, 'output');
      const run = prefix => {
        fs.writeFileSync(output, '');
        const result = spawnSync('bash', ['-c', compute.run.replace('${{ runner.os }}', 'Linux')], {
          cwd: source,
          encoding: 'utf8',
          env: {
            ...process.env,
            GITHUB_WORKSPACE: workspace,
            GITHUB_OUTPUT: output,
            INSTALL_PREFIX_BASE: prefix,
            QEMU_VERSION: '11.1.3',
            QEMU_TARGETS: 'x86_64-softmmu',
            CONFIGURE_ARGS: '',
            EXTRA_BUILD_DEPS: '',
          },
        });
        assert.equal(result.status, 0, result.stderr);
        return Object.fromEntries(fs.readFileSync(output, 'utf8').trimEnd().split('\n').map(line => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }));
      };
      const expectedBase = path.resolve(workspace, scenario.prefix);
      const outputs = run(scenario.prefix);
      assert.equal(outputs['install-base'], expectedBase);
      assert.equal(outputs['install-prefix'], path.join(expectedBase, '11.1.3'));
      assert.equal(outputs['bin-path'], path.join(expectedBase, '11.1.3/bin'));
      assert.equal(outputs['cache-key'], run(expectedBase)['cache-key']);
      const prepare = action.runs.steps.find(step => step.name === 'Prepare QEMU install base');
      assert.equal(prepare.env.INSTALL_PREFIX_BASE, '${{ steps.vars.outputs.install-base }}');
      const build = action.runs.steps.find(step => step.name === 'Build and install QEMU and cleanup QEMU sources.');
      assert.equal(build.env.INSTALL_PREFIX, '${{ steps.vars.outputs.install-prefix }}');
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  { name: 'exact versions are kept', versions: ['11.1.3', '11.1.3'], keep: true },
  { name: 'newer versions are kept', versions: ['99.0.0', '99.0.0'], keep: true },
  { name: 'matching linux-user targets are kept', versions: ['11.1.3', '11.1.3'], targetKind: 'linux-user', keep: true },
  { name: 'newer linux-user targets are kept', versions: ['99.0.0', '99.0.0'], targetKind: 'linux-user', keep: true },
  { name: 'older linux-user target selects a build', versions: ['11.1.3', '1.0.0'], targetKind: 'linux-user', keep: false },
  { name: 'linux-user forced downgrade selects a build', versions: ['99.0.0', '99.0.0'], targetKind: 'linux-user', downgrade: 'true', keep: false },
  { name: 'forced downgrade handles unowned binaries', versions: ['99.0.0', '99.0.0'], downgrade: 'true', keep: false },
  { name: 'missing second target selects a build', versions: ['11.1.3', null], keep: false },
  { name: 'missing linux-user target selects a build', versions: ['11.1.3', null], targetKind: 'linux-user', keep: false },
  { name: 'older second target selects a build', versions: ['11.1.3', '1.0.0'], keep: false },
  { name: 'unrecognized second target selects a build', versions: ['11.1.3', 'unknown'], keep: false },
  { name: 'no installed targets selects a build', versions: [null, null], keep: false },
  { name: 'cache hit selects the cached build', versions: [null, null], cache: 'true', keep: false },
]) {
  test(scenario.name, () => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qemu-policy-test-'));
    try {
      const bin = path.join(temporary, 'bin');
      fs.mkdirSync(bin);
      const targets = ['review_aarch64', 'review_x86_64'];
      targets.forEach((target, index) => {
        if (scenario.versions[index] === null) return;
        const executable = scenario.targetKind === 'linux-user' ? `qemu-${target}` : `qemu-system-${target}`;
        const banner = scenario.targetKind === 'linux-user' ? executable : 'QEMU emulator';
        fs.writeFileSync(path.join(bin, executable),
          `#!/bin/sh\necho '${banner} version ${scenario.versions[index]}'\n`, { mode: 0o755 });
      });
      const output = path.join(temporary, 'output');
      const result = spawnSync('bash', ['-c', `
        dpkg() {
          if [[ "$1" == '-S' || "$1" == '-s' ]]; then return 1; fi
          command dpkg "$@"
        }
        sudo() { echo 'Unexpected privileged command' >&2; return 90; }
        ${policy.run}
      `], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CACHE_HIT: scenario.cache || '',
          QEMU_TARGETS: targets.map(target => `${target}-${scenario.targetKind || 'softmmu'}`).join(','),
          QEMU_VERSION: '11.1.3',
          ALLOW_DOWNGRADE: scenario.downgrade || 'false',
          BUILT_INSTALL_PREFIX: '/opt/qemu/11.1.3',
          BUILT_BIN_PATH: '/opt/qemu/11.1.3/bin',
          GITHUB_OUTPUT: output,
        },
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const outputs = Object.fromEntries(fs.readFileSync(output, 'utf8').trimEnd().split('\n').map(line => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }));
      assert.equal(outputs['use-system'], String(scenario.keep));
      assert.equal(outputs['install-prefix'], scenario.keep ? '' : '/opt/qemu/11.1.3');
      assert.equal(outputs['bin-path'], scenario.keep ? bin : '/opt/qemu/11.1.3/bin');
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
}

for (const glibPackage of ['libglib2.0-0', 'libglib2.0-0t64']) {
  test(`runtime provisioning installs default and custom libraries with ${glibPackage} on cache hits`, () => {
    const runtime = action.runs.steps.find(step => step.name === 'Install QEMU runtime dependencies');
    assert.equal(runtime.if, undefined);
    assert(action.runs.steps.indexOf(runtime) < action.runs.steps.findIndex(step => step.id === 'cache'));
    assert.equal(runtime.env.EXTRA_BUILD_DEPS, '${{ inputs.extra-build-deps }}');
    const result = spawnSync('bash', ['-c', `
      apt-cache() { [[ "$GLIB_PACKAGE" == 'libglib2.0-0t64' ]]; }
      sudo() { printf '%s\\n' "$@"; }
      ${runtime.run}
    `], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GLIB_PACKAGE: glibPackage,
        EXTRA_BUILD_DEPS: 'libslirp-dev libaio-dev',
        CACHE_HIT: 'true',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), [
      'apt-get', 'update', 'apt-get', 'install', '-y',
      'libfdt1', glibPackage, 'libpixman-1-0', 'zlib1g', 'libstdc++6', 'libgcc-s1',
      'libslirp-dev', 'libaio-dev',
    ]);
  });
}

test('runtime dependency installation errors fail setup rather than using an incomplete cache', () => {
  const runtime = action.runs.steps.find(step => step.name === 'Install QEMU runtime dependencies');
  const result = spawnSync('bash', ['-c', `
    apt-cache() { return 1; }
    sudo() { [[ "$2" == 'update' ]] || return 42; }
    ${runtime.run}
  `], {
    encoding: 'utf8',
    env: { ...process.env, EXTRA_BUILD_DEPS: '' },
  });
  assert.equal(result.status, 42);
});

test('source extraction and cleanup stay in runner temp and preserve a caller directory', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qemu-source-dir-test-'));
  try {
    const workspace = path.join(temporary, 'workspace');
    const runnerTemp = path.join(temporary, 'runner-temp');
    const callerSource = path.join(workspace, 'qemu-11.1.3');
    fs.mkdirSync(callerSource, { recursive: true });
    fs.mkdirSync(runnerTemp);
    const sentinel = path.join(callerSource, 'caller-file');
    fs.writeFileSync(sentinel, 'keep');

    const sourceStep = action.runs.steps.find(step => step.id === 'qemu-source');
    const downloadStep = action.runs.steps.find(step => step.name.startsWith('Download, verify, extract QEMU source'));
    const buildStep = action.runs.steps.find(step => step.name.startsWith('Build and install QEMU'));
    const cleanupStep = action.runs.steps.find(step => step.name === 'Clean QEMU source');
    assert.equal(downloadStep['working-directory'], '${{ steps.qemu-source.outputs.path }}');
    assert.equal(buildStep['working-directory'], '${{ steps.qemu-source.outputs.path }}/qemu-${{ inputs.qemu-version }}');

    const output = path.join(temporary, 'output');
    const prepared = spawnSync('bash', ['-c', sourceStep.run], {
      cwd: workspace,
      encoding: 'utf8',
      env: { ...process.env, RUNNER_TEMP: runnerTemp, GITHUB_OUTPUT: output },
    });
    assert.equal(prepared.status, 0, prepared.stderr);
    const sourceDir = fs.readFileSync(output, 'utf8').trim().slice('path='.length);
    assert(sourceDir.startsWith(`${runnerTemp}${path.sep}`));
    assert(fs.existsSync(sourceDir));

    const cleaned = spawnSync('bash', ['-c', cleanupStep.run], {
      encoding: 'utf8',
      env: { ...process.env, SOURCE_DIR: sourceDir },
    });
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(fs.existsSync(sourceDir), false);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('install prefix is not evaluated as shell code when added to PATH', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qemu-path-injection-test-'));
  try {
    const marker = path.join(temporary, 'executed');
    const pathFile = path.join(temporary, 'github-path');
    const addPath = action.runs.steps.find(step => step.name === 'Add QEMU to PATH');
    const maliciousPath = `$(touch ${marker})`;
    assert.equal(addPath.env.BIN_PATH, '${{ steps.qemu-policy.outputs.bin-path }}');
    assert(!addPath.run.includes('${{'));

    const result = spawnSync('bash', ['-c', addPath.run], {
      encoding: 'utf8',
      env: { ...process.env, BIN_PATH: maliciousPath, GITHUB_PATH: pathFile },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.readFileSync(pathFile, 'utf8'), `${maliciousPath}\n`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('install prefix rejects newlines that could forge step outputs', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qemu-prefix-newline-test-'));
  try {
    const compute = action.runs.steps.find(step => step.id === 'vars');
    const output = path.join(temporary, 'output');
    const result = spawnSync('bash', ['-c', compute.run.replace('${{ runner.os }}', 'Linux')], {
      cwd: temporary,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_WORKSPACE: temporary,
        GITHUB_OUTPUT: output,
        INSTALL_PREFIX_BASE: 'safe\nbin-path=/tmp/attacker',
        QEMU_VERSION: '11.1.3',
        QEMU_TARGETS: 'x86_64-softmmu',
        CONFIGURE_ARGS: '',
        EXTRA_BUILD_DEPS: '',
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not contain newline/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('source build leaves qemu-utils installed when no requested binary owns it', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qemu-utils-policy-test-'));
  try {
    const output = path.join(temporary, 'output');
    const result = spawnSync('bash', ['-c', `
      dpkg() {
        if [[ "$1" == '-S' ]]; then return 1; fi
        if [[ "$1" == '-s' && "$2" == 'qemu-utils' ]]; then return 0; fi
        command dpkg "$@"
      }
      sudo() { printf 'sudo %s\\n' "$*"; }
      ${policy.run}
    `], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${temporary}:${process.env.PATH}`,
        CACHE_HIT: '',
        QEMU_TARGETS: 'review_missing-softmmu',
        QEMU_VERSION: '11.1.3',
        ALLOW_DOWNGRADE: 'false',
        BUILT_INSTALL_PREFIX: '/opt/qemu/11.1.3',
        BUILT_BIN_PATH: '/opt/qemu/11.1.3/bin',
        GITHUB_OUTPUT: output,
      },
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.doesNotMatch(result.stdout, /sudo apt-get remove/);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('workflow isolates caches across jobs and attempts but reuses the cache within a job', () => {
  const workflow = parse(fs.readFileSync(path.join(__dirname, '../../.github/workflows/test-setup-qemu-latest.yml'), 'utf8'));
  const cacheSteps = workflow.jobs['cache-miss-then-hit'].steps;
  const first = cacheSteps.find(step => step.id === 'setup-qemu-1');
  const second = cacheSteps.find(step => step.id === 'setup-qemu-2');
  assert.equal(first.with['configure-args'], second.with['configure-args']);
  assert.equal(first.with['extra-build-deps'], second.with['extra-build-deps']);
  const removal = cacheSteps.findIndex(step => step.name === 'Remove installation before cache restore');
  assert(removal > cacheSteps.indexOf(first));
  assert(removal < cacheSteps.indexOf(second));
  const render = (configuration, attempt) => configuration
    .replace('${{ github.run_id }}', '123')
    .replace('${{ github.run_attempt }}', String(attempt));
  const configuration = first.with['configure-args'];
  assert(configuration.includes('${{ github.run_id }}'));
  assert(configuration.includes('${{ github.run_attempt }}'));
  assert(configuration.includes('_CACHE'));
  assert.notEqual(render(configuration, 1), render(configuration, 2));
  const downgrade = workflow.jobs['allow-downgrade-rebuilds'].steps.find(step => step.id === 'setup-qemu');
  assert.notEqual(render(configuration, 1), render(downgrade.with['configure-args'], 1));
  const configurations = [];
  for (const [job, definition] of Object.entries(workflow.jobs)) {
    const setup = definition.steps.find(step => step.id === 'setup-qemu' || step.id === 'setup-qemu-1');
    if (!setup?.with['configure-args']) continue;
    const rendered = render(setup.with['configure-args'], 1).trim();
    const isolationFlags = rendered.split('\n').filter(line => line.startsWith('--extra-cflags='));
    assert.equal(isolationFlags.length, 1);
    assert.match(isolationFlags[0], /^--extra-cflags=-D[A-Za-z_][A-Za-z0-9_]*$/);
    configurations.push([job, isolationFlags[0]]);
  }
  assert.equal(new Set(configurations.map(([, value]) => value)).size, configurations.length);
  const buildSteps = workflow.jobs['build-from-source'].steps;
  assert.equal(buildSteps[0].with, undefined);
  assert.equal(buildSteps[1].uses, './setup-qemu-latest');
  assert.equal(buildSteps[1].with['enable-kvm-access'], 'true');
});
