/**
 * Argument schema for the Appium server (APM-001; verified with Appium 3.4.2). Probes read the server version and
 * the installed drivers (`APPIUM_HOME` comes from the policy env allowlist). `server` listens on 127.0.0.1 only, on a
 * port in 4723 – 4799, logging into the run directory. Insecure features, plugins, extra capabilities and other
 * configuration files cannot be enabled; drivers cannot be installed or updated from here (that needs the network).
 */
import type { ArgSchema } from './types.ts';

const PORT = /^47(?:2[3-9]|[3-9][0-9])$/;

export const APPIUM_SCHEMA: ArgSchema = {
  executable: 'appium',
  forbiddenFlags: [
    '--relaxed-security',
    '--allow-insecure',
    '--deny-insecure',
    '--use-plugins',
    '--use-drivers',
    '--default-capabilities',
    '--config',
    '--allow-cors',
    '--webhook',
    '--callback-address',
    '--base-path',
    '-a',
    '-p',
    '-g',
  ],
  forms: [
    {
      id: 'appium.version',
      class: 'probe',
      words: [],
      flags: [{ name: '--version', value: { kind: 'none' } }],
      requiredFlags: ['--version'],
    },
    {
      id: 'appium.drivers',
      class: 'probe',
      words: ['driver', 'list'],
      flags: [
        { name: '--installed', value: { kind: 'none' } },
        { name: '--json', value: { kind: 'none' } },
      ],
      requiredFlags: ['--installed', '--json'],
    },
    {
      id: 'appium.server',
      class: 'test_runner',
      words: ['server'],
      flags: [
        { name: '--address', value: { kind: 'enum', values: ['127.0.0.1'] } },
        { name: '--port', value: { kind: 'pattern', pattern: PORT } },
        { name: '--log', value: { kind: 'runPath', prefix: '' } },
        { name: '--log-no-colors', value: { kind: 'none' } },
        { name: '--log-timestamp', value: { kind: 'none' } },
      ],
      requiredFlags: ['--address', '--port'],
    },
  ],
};
