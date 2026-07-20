import {
  CURRENT_HOST_PLATFORM,
  type HostPlatform,
} from "../../src/platform/index.js";

/**
 * Keeps tests focused on repository and runtime behavior rather than the
 * privilege level of whichever machine happens to execute the suite.
 * Production callers never receive this host.
 */
export function createStandardUserHost(
  base: HostPlatform = CURRENT_HOST_PLATFORM,
): HostPlatform {
  return new Proxy(base, {
    get(target, property) {
      if (property === "assertNonPrivileged") {
        return (): void => undefined;
      }
      if (property === "verifyEligibility") {
        return async (
          options: Parameters<HostPlatform["verifyEligibility"]>[0],
        ): Promise<Awaited<ReturnType<HostPlatform["verifyEligibility"]>>> => ({
          standardUserVerified: true,
          guiSessionVerified: options.liveBrowser,
        });
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
