import { execSync } from 'child_process';
import prompts from 'prompts';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBSPEC = path.join(__dirname, '..', 'mobile', 'pubspec.yaml');

function safeExec(cmd, opts = {}) {
    return execSync(cmd, {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 30000,
        ...opts
    }).toString().trim();
}

function readVersion() {
    const text = fs.readFileSync(PUBSPEC, 'utf8');
    const m = text.match(/^version:\s*(\d+)\.(\d+)\.(\d+)\+(\d+)\s*$/m);
    if (!m) throw new Error(`Cannot parse version line in ${PUBSPEC}`);
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), build: Number(m[4]), line: m[0] };
}

function tagExists(tagName) {
    try {
        if (safeExec('git tag -l').split('\n').includes(tagName)) return 'local';
    } catch (e) { }
    try {
        if (safeExec('git ls-remote --tags origin').includes(`refs/tags/${tagName}`)) return 'remote';
    } catch (e) {
        console.log(chalk.yellow('⚠️  Could not check remote tags (connection issue?)'));
    }
    return false;
}

async function main() {
    const v = readVersion();
    console.log(chalk.blue(`\n📱 Selah Mobile release — current: ${v.major}.${v.minor}.${v.patch}+${v.build}`));

    const dirty = safeExec('git status --porcelain -- mobile/').trim();
    if (dirty) {
        console.log(chalk.red('❌ mobile/ has uncommitted changes. Commit or stash first.'));
        process.exit(1);
    }

    const { bump } = await prompts({
        type: 'select',
        name: 'bump',
        message: 'Version bump?',
        choices: [
            { title: `Patch  → ${v.major}.${v.minor}.${v.patch + 1}`, value: 'patch' },
            { title: `Minor  → ${v.major}.${v.minor + 1}.0`, value: 'minor' },
            { title: `Major  → ${v.major + 1}.0.0`, value: 'major' },
        ],
        initial: 0
    });
    if (!bump) { console.log(chalk.gray('Aborted.')); return; }

    const next = bump === 'patch'
        ? { ...v, patch: v.patch + 1, build: v.build + 1 }
        : bump === 'minor'
            ? { ...v, minor: v.minor + 1, patch: 0, build: v.build + 1 }
            : { major: v.major + 1, minor: 0, patch: 0, build: v.build + 1 };
    const versionName = `${next.major}.${next.minor}.${next.patch}`;
    const tag = `mobile-v${versionName}`;

    const exists = tagExists(tag);
    if (exists) {
        console.log(chalk.red(`❌ Tag ${tag} already exists (${exists}).`));
        process.exit(1);
    }

    const { confirm } = await prompts({
        type: 'confirm',
        name: 'confirm',
        message: `Bump pubspec to ${versionName}+${next.build}, commit, tag ${tag}, push? (CI builds APK + AAB)`,
        initial: true
    });
    if (!confirm) { console.log(chalk.gray('Aborted.')); return; }

    const text = fs.readFileSync(PUBSPEC, 'utf8');
    fs.writeFileSync(PUBSPEC, text.replace(v.line, `version: ${versionName}+${next.build}`));
    console.log(chalk.green(`✅ pubspec.yaml → ${versionName}+${next.build}`));

    safeExec('git add mobile/pubspec.yaml');
    safeExec(`git commit -m "chore(mobile): release ${versionName}+${next.build}"`);
    safeExec(`git tag -a ${tag} -m "Selah Mobile ${versionName}"`);
    console.log(chalk.green(`✅ Committed + tagged ${tag}`));

    safeExec('git push origin HEAD');
    safeExec(`git push origin ${tag}`);
    console.log(chalk.green(`✅ Pushed. Watch: gh run watch --workflow=mobile-release.yml`));
    console.log(chalk.gray(`APK (sideload) + AAB (Play Store) will attach to the ${tag} GitHub Release.`));
}

main().catch((e) => { console.error(chalk.red(e.message)); process.exit(1); });
