// Appium scenario runner of the AutoTest React Native fixture (APM-001): one scenario per process, exit code 0 on
// success. It speaks the W3C WebDriver protocol to the Appium server with fetch, so it needs no packages.
//   node appium/run-scenario.mjs --scenario <name> --udid <device> --port <port> --platform <android|ios>
const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const scenario = arg('scenario');
const platform = arg('platform') ?? 'android';
const base = `http://127.0.0.1:${arg('port') ?? '4723'}`;

async function call(method, path, body) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await r.json();
  if (!r.ok) throw new Error(`${method} ${path}: ${json.value?.message ?? r.status}`);
  return json.value;
}

const capabilities =
  platform === 'android'
    ? {
        platformName: 'Android',
        'appium:automationName': 'UiAutomator2',
        'appium:udid': arg('udid'),
        'appium:appPackage': 'com.fixturern',
        'appium:appActivity': '.MainActivity',
        'appium:noReset': true,
        // A fresh app process per scenario, so the counter starts at 0.
        'appium:forceAppLaunch': true,
        'appium:shouldTerminateApp': true,
        'appium:newCommandTimeout': 120,
      }
    : {
        platformName: 'iOS',
        'appium:automationName': 'XCUITest',
        'appium:udid': arg('udid'),
        'appium:bundleId': 'com.fixturern',
        'appium:noReset': true,
        'appium:forceAppLaunch': true,
      };

async function byTestId(session, id) {
  // React Native's testID: the resource-id on Android, the accessibility id on iOS.
  const locator =
    platform === 'android'
      ? { using: '-android uiautomator', value: `new UiSelector().resourceId("${id}")` }
      : { using: 'accessibility id', value: id };
  const el = await call('POST', `/session/${session}/element`, locator);
  return Object.values(el)[0];
}

async function countText(session) {
  return call('GET', `/session/${session}/element/${await byTestId(session, 'count')}/text`);
}

const scenarios = {
  async counterIncrements(session) {
    await call('POST', `/session/${session}/element/${await byTestId(session, 'increment')}/click`, {});
    const text = await countText(session);
    if (text !== 'Count: 1') throw new Error(`AssertionError: expected "Count: 1", got "${text}"`);
  },
  async counterIsFiveOnPurpose(session) {
    const text = await countText(session);
    if (text !== 'Count: 5') throw new Error(`AssertionError: expected "Count: 5", got "${text}"`);
  },
};

const run = scenarios[scenario];
if (!run) {
  console.error(`unknown scenario ${scenario}`);
  process.exit(2);
}
let session;
try {
  session = (await call('POST', '/session', { capabilities: { alwaysMatch: capabilities } })).sessionId;
  await run(session);
  console.log(`scenario ${scenario}: passed`);
} catch (e) {
  console.log(`scenario ${scenario}: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (session) await call('DELETE', `/session/${session}`).catch(() => undefined);
}
