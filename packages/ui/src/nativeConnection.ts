export { registerNativeConnectionAdapter, type NativeConnectionAdapter } from "./runtime.ts";
import { loadServerUrl, loadToken } from "./runtime.ts";

/**
 * Read the current configured server URL and credential synchronously for native shell code.
 * Returns unavailable when either value is missing and leaves storage untouched.
 * Use the credential only in the authorization header for the configured server's origin.
 * Keep it out of URLs, logs, diagnostics and error messages.
 */
export function nativeConnection(): { serverUrl: string; token: string } | { unavailable: true } {
  const serverUrl = loadServerUrl();
  const token = loadToken();
  if (!serverUrl || !token) return { unavailable: true };
  return { serverUrl, token };
}
