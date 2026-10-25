/**
 * Argument schema for `java` running the Gradle wrapper (AND-003, AND-004; flags verified with Gradle 9.3.1 and
 * AGP 9.1.0, RL-018). The executable is the configured JDK, never the repository's `gradlew` script: the only JVM
 * option is `-classpath <workspace>/…/gradle/wrapper/gradle-wrapper.jar`, the main class is fixed, and Gradle gets one
 * test task (`test<Variant>UnitTest` or `connected<Variant>AndroidTest`, optionally module-qualified), offline,
 * without a daemon, with plain console output. Init scripts, other project or settings files, system properties and
 * arbitrary project properties cannot be passed. The build scripts themselves are repository code (T-02).
 */
import type { ArgSchema } from './types.ts';

const WRAPPER_JAR = /^(?:[A-Za-z0-9._-]{1,100}\/){0,3}gradle\/wrapper\/gradle-wrapper\.jar$/;
const TASK =
  /^(?:(?::[A-Za-z0-9_-]{1,60}){1,4}:)?(?:test[A-Z][A-Za-z0-9]{0,60}UnitTest|connected[A-Z][A-Za-z0-9]{0,60}AndroidTest)$/;
/** A test filter: a class or `Class.method` name, with `*` wildcards. */
const TEST_FILTER = /^[A-Za-z_*][A-Za-z0-9_.*$]{0,300}$/;
/** Class selection for instrumented tests (`Class` or `Class#method`, comma-separated). */
const INSTRUMENTATION_CLASS = /^android\.testInstrumentationRunnerArguments\.class=[A-Za-z0-9_.$#,]{1,4000}$/;

export const JAVA_SCHEMA: ArgSchema = {
  executable: 'java',
  forbiddenFlags: [
    '-jar',
    '-cp',
    '--class-path',
    '-D',
    '--init-script',
    '-I',
    '--project-dir',
    '-p',
    '--gradle-user-home',
    '-g',
    '--build-file',
    '-b',
    '--settings-file',
    '-c',
    '--include-build',
    '--system-prop',
    '-P',
    '--refresh-dependencies',
    '--write-verification-metadata',
    '--write-locks',
    '--scan',
    '--continuous',
    '-t',
    '--project-cache-dir',
    '--daemon',
  ],
  forms: [
    {
      id: 'java.gradle-wrapper.test',
      class: 'test_runner',
      leading: [{ name: '-classpath', value: { kind: 'workspacePath', pattern: WRAPPER_JAR } }],
      words: ['org.gradle.wrapper.GradleWrapperMain'],
      positionals: [{ kind: 'word', pattern: TASK }],
      flags: [
        { name: '--rerun', value: { kind: 'none' } },
        { name: '--tests', value: { kind: 'pattern', pattern: TEST_FILTER }, repeatable: true },
        { name: '--project-prop', value: { kind: 'pattern', pattern: INSTRUMENTATION_CLASS } },
        { name: '--offline', value: { kind: 'none' } },
        { name: '--no-daemon', value: { kind: 'none' } },
        { name: '--console', value: { kind: 'enum', values: ['plain'] } },
      ],
      requiredFlags: ['--offline', '--no-daemon', '--console'],
    },
  ],
};
