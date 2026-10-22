// Remembering the last request makes the app useful from the second launch
// onwards. Only the request is stored: responses are potentially large and
// stale by definition.

export const STORAGE_KEY = "jqui.last-request.v1";
export const MAX_SAVED_BODY = 128 * 1024;

export const DEFAULT_REQUEST = {
  method: "GET",
  url: "https://jsonplaceholder.typicode.com/posts/1",
  headers: "Accept: application/json",
  body: "",
  jq: ".",
};

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function loadLastRequest() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_REQUEST };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_REQUEST };
    return {
      method: METHODS.includes(parsed.method) ? parsed.method : DEFAULT_REQUEST.method,
      url: typeof parsed.url === "string" && parsed.url ? parsed.url : DEFAULT_REQUEST.url,
      headers: typeof parsed.headers === "string" ? parsed.headers : DEFAULT_REQUEST.headers,
      body: typeof parsed.body === "string" ? parsed.body : "",
      jq: typeof parsed.jq === "string" && parsed.jq.trim() ? parsed.jq : ".",
    };
  } catch (error) {
    return { ...DEFAULT_REQUEST };
  }
}

export function saveLastRequest(request) {
  try {
    const body = String(request.body ?? "").slice(0, MAX_SAVED_BODY);
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
        jq: request.jq,
      }),
    );
  } catch (error) {
    // Storage may be denied or full; losing the remembered request is not a
    // reason to disturb the send path.
  }
}

export function isMethod(value) {
  return METHODS.includes(value);
}

export { METHODS };
