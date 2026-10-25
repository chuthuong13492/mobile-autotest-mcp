/** TL-13 `list_devices` and TL-14 `manage_simulator` (DEV-001, DEV-002): the use cases live in `@autotest/workflow`. */
import { listDevicesUseCase, manageSimulator, type DeviceDeps, type UseCases } from '@autotest/workflow';

export function deviceUseCases(deps: DeviceDeps): Pick<UseCases, 'list_devices' | 'manage_simulator'> {
  return {
    list_devices: (input) => listDevicesUseCase(deps, input),
    manage_simulator: (input, ctx) => manageSimulator(deps, input, ctx),
  };
}
