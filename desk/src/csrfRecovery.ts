import { toast } from "frappe-ui";
import {
  errorFromFrappeResponse,
  isCsrfTokenError,
  recoverFromStaleCsrf,
  type CsrfRecovery,
} from "./csrfSession";

export { isCsrfTokenError };
export type { CsrfRecovery };

const FETCH_GUARD = "__helpdeskCsrfFetchGuard";

function sessionUser(): string | null {
  const cookies = new URLSearchParams(document.cookie.split("; ").join("&"));
  const user = cookies.get("user_id");
  if (!user || user === "Guest") return null;
  return user;
}

/** Browser binding for {@link recoverFromStaleCsrf}. Login is a full page load. */
export function recoverDeskCsrf(error: unknown): CsrfRecovery {
  return recoverFromStaleCsrf(error, {
    now: () => Date.now(),
    storage: window.sessionStorage,
    notify: (message) => toast.warning(message),
    reload: () => window.location.reload(),
    redirectToLogin: () => {
      window.location.assign("/login");
    },
    isGuest: () => sessionUser() === null,
  });
}

/**
 * `call()` does not use `resourceFetcher`, so watch `fetch` as well. The
 * resource wrapper still hangs a reloading request so the list does not
 * resolve as an empty success before the navigation.
 */
export function installCsrfFetchGuard(): void {
  const host = window as Window & { [FETCH_GUARD]?: boolean };
  if (host[FETCH_GUARD] || typeof window.fetch !== "function") return;
  host[FETCH_GUARD] = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await original(input, init);
    if (response.status === 400) {
      try {
        const body = await response.clone().json();
        const error = errorFromFrappeResponse(response.status, body);
        if (isCsrfTokenError(error)) recoverDeskCsrf(error);
      } catch {
        // A non-JSON 400 is not this session failure.
      }
    }
    return response;
  };
}
