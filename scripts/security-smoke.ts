const baseUrl = (process.env.SECURITY_SMOKE_BASE_URL || process.env.PUBLIC_ORIGIN || "https://stakewars.ai").replace(/\/+$/, "");

const checks: Array<{
  label: string;
  path: string;
  method?: string;
  expected: number[];
  headers?: Record<string, string>;
}> = [
  { label: "unauthenticated /api/me is protected", path: "/api/me", expected: [401] },
  { label: "unauthenticated open wagers are protected", path: "/api/wagers/open", expected: [401] },
  { label: "unauthenticated admin users are protected", path: "/api/admin/user-display-map", expected: [401, 403] },
  { label: "unauthenticated support chat is protected", path: "/api/support/conversations", method: "POST", expected: [401] },
  { label: "Devvit claim endpoint is gone", path: "/api/devvit/reddit/claim", method: "POST", expected: [404] }
];

const assert = (condition: boolean, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

const headerIncludes = (response: Response, name: string, expected: string) =>
  (response.headers.get(name) ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .includes(expected.toLowerCase());

for (const check of checks) {
  const response = await fetch(`${baseUrl}${check.path}`, {
    method: check.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(check.headers ?? {})
    }
  });
  assert(
    check.expected.includes(response.status),
    `${check.label}: expected ${check.expected.join("/")} but received ${response.status}`
  );
  console.log(`ok - ${check.label}`);
}

const home = await fetch(`${baseUrl}/`);
assert(home.ok, `homepage expected 2xx but received ${home.status}`);
assert(headerIncludes(home, "x-content-type-options", "nosniff"), "missing X-Content-Type-Options: nosniff");
assert(headerIncludes(home, "referrer-policy", "strict-origin-when-cross-origin"), "missing strict referrer policy");
assert(headerIncludes(home, "x-frame-options", "DENY"), "missing X-Frame-Options: DENY");
assert(Boolean(home.headers.get("content-security-policy")), "missing Content-Security-Policy");
if (baseUrl.startsWith("https://")) {
  assert(Boolean(home.headers.get("strict-transport-security")), "missing Strict-Transport-Security");
}
console.log("ok - security headers present");
