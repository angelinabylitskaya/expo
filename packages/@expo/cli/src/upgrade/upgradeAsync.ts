import { getConfig } from '@expo/config';
import * as PackageManager from '@expo/package-manager';
import spawnAsync from '@expo/spawn-async';
import chalk from 'chalk';
import semver from 'semver';

import { getVersionsAsync } from '../api/getVersions';
import { checkPackagesInternalAsync } from '../install/checkPackages';
import * as Log from '../log';
import {
  hasRequiredAndroidFilesAsync,
  hasRequiredIOSFilesAsync,
} from '../prebuild/clearNativeFolder';
import {
  getCombinedKnownVersionsAsync,
  getRemoteVersionsForSdkAsync,
} from '../start/doctor/dependencies/getVersionedPackages';
import { env } from '../utils/env';
import { CommandError } from '../utils/errors';
import { maybeBailOnGitStatusAsync } from '../utils/git';
import { attemptModification } from '../utils/modifyConfigAsync';

const debug = require('debug')('expo:upgrade') as typeof console.log;
const ALLOWED_TAGS = ['next', 'latest'];

function formatSdkVersion(sdkVersionString: string) {
  if (ALLOWED_TAGS.includes(sdkVersionString)) {
    return sdkVersionString;
  }

  // Convert a value like 2 or 2.0 to 2.0.0
  return semver.valid(semver.coerce(sdkVersionString, { loose: true }) || '');
}

export async function upgradeAsync(
  projectRoot: string,
  {
    version: versionArgument,
    ...options
  }: { version?: string; npm?: boolean; yarn?: boolean; pnpm?: boolean }
) {
  // Perform this early
  const versionToInstall = versionArgument ? formatSdkVersion(versionArgument) : 'latest';

  debug(`Requested Expo version: ${versionToInstall}`);
  if (!versionToInstall) {
    throw new CommandError(`Invalid version: ${versionArgument}`);
  }

  let projectConfig = getConfig(projectRoot);

  const initialExpoVersion = projectConfig.exp.sdkVersion!;
  const initialPackages: Record<string, string> = {
    ...projectConfig.pkg.dependencies,
    ...projectConfig.pkg.devDependencies,
  };

  if (
    // Allow downgrading for general testing
    !env.EXPO_DEBUG &&
    // Otherwise all downgrading is blocked
    !ALLOWED_TAGS.includes(versionToInstall) &&
    semver.lt(versionToInstall, initialExpoVersion)
  ) {
    throw new CommandError(
      `Downgrading is not supported. (current: ${initialExpoVersion}, requested: ${versionToInstall})`
    );
  }

  debug(`Current Expo version: ${initialExpoVersion}`);

  // Drop manual Expo SDK version from the config.
  // Users have no reason to ever define this manually with versioned Expo CLI.
  if (projectConfig.rootConfig.expo.sdkVersion) {
    await attemptModification(
      projectRoot,
      {
        sdkVersion: undefined,
      },
      { sdkVersion: undefined }
    );
  }

  // Run this after all sanity checks.
  if (await maybeBailOnGitStatusAsync()) {
    return;
  }

  // Do this first to ensure we have the latest versions locally
  const versionData = await getVersionsAsync({ skipCache: true });
  const initialVersion = await getRemoteVersionsForSdkAsync({ sdkVersion: initialExpoVersion });

  const packageManager = PackageManager.createForProject(projectRoot, {
    log: Log.log,
    ...options,
  });

  // Now perform versioned work...
  Log.log(`Upgrading Expo`);

  // Update Expo to the latest version.
  await packageManager.addAsync(
    // TODO: custom version
    [`expo@${versionToInstall}`]
  );

  Log.log();
  Log.log(chalk.bold`npx expo install --fix`);

  // Align dependencies with new Expo SDK version.
  await checkPackagesInternalAsync(projectRoot, {
    packages: [],
    options: { fix: true },
    packageManager,
    packageManagerArguments: [],
  });

  // Finalize the upgrade with changes from the new version
  await finalizeUpgrade(projectRoot, options);

  Log.log();

  // Read config again to get the new SDK version and package.json.
  projectConfig = getConfig(projectRoot);

  const nextExpoVersion = projectConfig.exp.sdkVersion!;
  const relatedVersionInfo = versionData.sdkVersions[nextExpoVersion];
  Log.log(chalk.greenBright`Project has been upgraded to Expo SDK ${nextExpoVersion}`);

  if (relatedVersionInfo?.releaseNoteUrl || env.EXPO_BETA) {
    Log.log(
      chalk`Release notes: {gray ${
        relatedVersionInfo.releaseNoteUrl || 'https://github.com/expo/expo/blob/main/CHANGELOG.md'
      }}`
    );
  } else {
    Log.log(
      chalk.red`Release notes: Not Found (this is a bug). Try checking https://blog.expo.dev`
    );
  }

  Log.log();

  // Print unknown packages

  const nextVersion = await getCombinedKnownVersionsAsync({
    projectRoot,
    sdkVersion: nextExpoVersion,
  });

  const finalDependencies = {
    ...projectConfig.pkg.dependencies,
    ...projectConfig.pkg.devDependencies,
  };

  const unmodifiedDependencies = Object.keys(initialPackages).filter(
    (key) => initialPackages[key] === finalDependencies[key] && key !== 'expo'
  );

  const unknownDependencies = unmodifiedDependencies.filter((key) => !nextVersion[key]);

  if (unknownDependencies.length) {
    Log.log(
      chalk`{bold The following dependencies may need to be upgraded manually:}\n${unknownDependencies
        .sort()
        .join('\n')}`
    );
    Log.log();
  }

  // Print native info

  if (
    (await hasRequiredAndroidFilesAsync(projectRoot)) ||
    (await hasRequiredIOSFilesAsync(projectRoot))
  ) {
    const upgradeHelperUrl = `https://react-native-community.github.io/upgrade-helper/?from=${initialVersion['react-native']}&to=${nextVersion['react-native']}`;

    Log.log(
      chalk`{yellow Native projects detected. Do one of the following:}\n- Automatically: {bold npx expo prebuild --clean} {gray Learn more: https://docs.expo.dev/workflow/prebuild/#clean}\n- Manually: {gray Learn more: ${upgradeHelperUrl}}`
    );
  }
}

async function finalizeUpgrade(
  projectRoot: string,
  options: Partial<Record<PackageManager.NodePackageManager['name'], boolean>>
) {
  const managerFlag = Object.entries(options)
    .map(([name, enabled]) => (enabled ? `--${name}` : undefined))
    .find((flag) => flag !== undefined);

  try {
    await spawnAsync('npx', ['expo', 'upgrade', '--finalize', managerFlag ?? ''], {
      stdio: 'inherit',
      cwd: projectRoot,
    });
  } catch (error) {
    debug('Failed to finalize upgrade', error);
    Log.warn(
      'Could not finalize the upgrade automatically, check the release notes for manual steps.'
    );
  }
}
