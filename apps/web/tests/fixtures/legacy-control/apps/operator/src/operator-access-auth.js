import { timingSafeEqual } from "node:crypto";

import { createRemoteJWKSet, jwtVerify } from "jose";

export function createAccessAuthenticator({
  issuer,
  audience,
  operatorSubjects,
  jwtVerifyImpl = jwtVerify,
} = {}) {
  if (
    typeof issuer !== "string" ||
    typeof audience !== "string" ||
    !Array.isArray(operatorSubjects) ||
    typeof jwtVerifyImpl !== "function"
  ) {
    throw new TypeError("ACCESS_AUTH_CONFIGURATION_INVALID");
  }
  const operators = new Set(operatorSubjects);
  const jwks = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", `${issuer}/`));

  return {
    async authenticate(assertion) {
      if (typeof assertion !== "string" || assertion.length === 0) {
        throw new Error("ACCESS_ASSERTION_REQUIRED");
      }
      if (assertion.length > 32_768) throw new Error("ACCESS_ASSERTION_INVALID");
      let payload;
      try {
        ({ payload } = await jwtVerifyImpl(assertion, jwks, {
          issuer,
          audience,
          algorithms: ["RS256"],
        }));
      } catch {
        throw new Error("ACCESS_ASSERTION_INVALID");
      }
      if (
        typeof payload?.sub !== "string" ||
        payload.sub.length === 0 ||
        typeof payload.email !== "string" ||
        payload.email.length === 0
      ) {
        throw new Error("ACCESS_IDENTITY_INVALID");
      }
      const identityKey = `${issuer}|${payload.sub}`;
      return {
        issuer,
        subject: payload.sub,
        email: payload.email,
        role: operators.has(identityKey) ? "operator" : "viewer",
      };
    },
  };
}

export function verifyProxyCredential({ presented, expected } = {}) {
  if (typeof presented !== "string" || typeof expected !== "string") return false;
  const presentedBytes = Buffer.from(presented, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (presentedBytes.length !== expectedBytes.length || expectedBytes.length < 32) return false;
  return timingSafeEqual(presentedBytes, expectedBytes);
}
