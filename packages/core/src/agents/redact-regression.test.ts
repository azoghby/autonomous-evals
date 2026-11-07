import { describe, expect, it } from "vitest";
import { containsSecret, redactSecrets, redactValue } from "./redact";

describe("credential redaction regressions (D1)", () => {
  it('does not flag a redacted assignment again after nested JSON serialization', () => {
    const scrubbed = redactSecrets('DB_PASSWORD=hunter2hunter2').text;
    const event = JSON.stringify({ error: scrubbed });
    const prompt = JSON.stringify({ events: [{ text: event }] });
    expect(containsSecret(prompt)).toBe(false);
    expect(redactSecrets(prompt).text).toBe(prompt);
    expect(containsSecret('DB_PASSWORD=[REDACTED]still-secret')).toBe(true);
  });
  it.each([
    ["DB_PASSWORD=hunter2hunter2", "DB_PASSWORD=[REDACTED]"],
    ["export STRIPE_SECRET=abcdefgh12345678", "export STRIPE_SECRET=[REDACTED]"],
    ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "AWS_SECRET_ACCESS_KEY=[REDACTED]"],
    ["OPENAI_API_KEY=abcdefgh12345678", "OPENAI_API_KEY=[REDACTED]"],
    ["authToken=abcdefgh12345678", "authToken=[REDACTED]"],
    ['{"token":"abcdef1234567890zz"}', '{"token":"[REDACTED]"}'],
    ['{"password":"correct horse battery staple"}', '{"password":"[REDACTED]"}'],
    ["password: 'my pass phrase here'", "password: '[REDACTED]'"],
    ['{"password":"say \\"hello\\" and go","id":4}', '{"password":"[REDACTED]","id":4}'],
    ["password='it\\'s a secret'; status=ready", "password='[REDACTED]'; status=ready"],
    ['{"message":"DB_PASSWORD=hunter2hunter2"}', '{"message":"DB_PASSWORD=[REDACTED]"}'],
    ["password=a; token=b", "password=[REDACTED]; token=[REDACTED]"],
    ["Authorization: 'Bearer a long credential'", "Authorization: '[REDACTED]'"],
    ["Authorization: Bearer aLongToken12345678", "Authorization: [REDACTED]"],
    ["Cookie: session=abc123; csrf=def456", "Cookie: [REDACTED]"],
  ])("scrubs the entire assignment and preserves its surroundings: %s", (input, expected) => {
    const result = redactSecrets(input);
    expect(result.text).toBe(expected);
    expect(result.redactions).toBeGreaterThan(0);
    expect(containsSecret(input)).toBe(true);
    expect(containsSecret(result.text)).toBe(false);
  });

  it.each(["mysql", "postgres", "postgresql", "mongodb+srv", "redis", "mssql"])("scrubs %s URL passwords without changing location", (scheme) => {
    expect(redactSecrets(`Connect ${scheme}://user:p%40ssword@host:123/db?mode=read`).text)
      .toBe(`Connect ${scheme}://user:[REDACTED]@host:123/db?mode=read`);
    expect(containsSecret(`${scheme}://user:[REDACTED]@host/db`)).toBe(false);
  });

  it.each([
    `hf_${"a".repeat(30)}`, `SG.${"a".repeat(22)}.${"b".repeat(43)}`,
    `npm_${"a".repeat(36)}`, `napi_${"a".repeat(36)}`, `glpat-${"a".repeat(20)}`,
  ])("recognizes standalone provider tokens: %s", (token) => {
    expect(redactSecrets(`before ${token} after`).text).toBe("before [REDACTED] after");
    expect(containsSecret(token)).toBe(true);
  });

  it.each([
    "The password should contain multiple words. Your token expires tomorrow.",
    '{"tokenizer":"ordinary text","secretary":"Alice","passwordless":true,"status":"created","error":null}',
    "https://host/path?mode=read", "mysql://host/db", "hf_example SG.example npm_install glpat-example",
    "password=null token=false secret=true", "password=''",
  ])("preserves harmless text exactly: %s", (text) => {
    expect(redactSecrets(text)).toMatchObject({ text, redactions: 0 });
  });

  it("scrubs both literal and JSON-encoded known secrets, longest first", () => {
    const secret = 'pa"ss\\word12345';
    const input = `${secret} ${JSON.stringify({ note: secret })}`;
    const red = redactSecrets(input, [secret.slice(0, 5), secret]);
    expect(red.text).toBe('[REDACTED] {"note":"[REDACTED]"}');
    expect(containsSecret(JSON.stringify(secret), [secret])).toBe(true);
  });

  it("scrubs before clipping log values", () => {
    const value = "x".repeat(1_990) + "sk-ant-" + "a".repeat(40);
    expect(redactValue(value)).not.toContain("sk-ant-");
  });
});
