import { scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

export const SCRYPT_PARAMS = Object.freeze({
  N: 2 ** 14,
  keylen: 32,
  maxmem: 32 * 1024 * 1024,
  p: 1,
  r: 8,
});

export const LOGIN_SUCCESS_STATUS = 200;
export const LOGIN_INVALID_STATUS = 400;

export const LOGIN_SUCCESS_BODY = JSON.stringify({
  ok: true,
  result: { authenticated: false },
});

export const LOGIN_INVALID_BODY = JSON.stringify({
  error: {
    code: "INVALID_LOGIN_REQUEST",
    message: "Invalid login request",
  },
});

const DEMO_SALT = "black-box-timing-demo-salt-v1";
const DEMO_DUMMY_SALT = "black-box-timing-demo-dummy-salt-v1";
const DEMO_PASSWORD = "demo-password";
const DEMO_DUMMY_PASSWORD = "demo-dummy-password";

// These fixed salts and passwords are demo-only and must never be reused for real accounts.
const SEEDED_USERS = Object.freeze([
  Object.freeze({
    password: DEMO_PASSWORD,
    salt: DEMO_SALT,
    userId: "demo-known-user",
    username: "known-user",
  }),
]);

const scryptAsync = promisify(scrypt);

function invalid(message) {
  throw new TypeError(message);
}

function toSaltBuffer(salt) {
  if (Buffer.isBuffer(salt)) {
    return salt;
  }
  if (typeof salt === "string" && salt.length > 0) {
    return Buffer.from(salt, "utf8");
  }
  invalid("salt must be a non-empty string or Buffer");
}

function validatePassword(password) {
  if (typeof password !== "string" || password.length === 0) {
    invalid("password must be a non-empty string");
  }
}

function validateScryptFn(scryptFn) {
  if (typeof scryptFn !== "function") {
    invalid("scryptFn must be a function");
  }
}

function asyncScrypt(password, salt, scryptFn) {
  const operation = scryptFn === scrypt ? scryptAsync : promisify(scryptFn);
  return operation(password, salt, SCRYPT_PARAMS.keylen, {
    maxmem: SCRYPT_PARAMS.maxmem,
    N: SCRYPT_PARAMS.N,
    p: SCRYPT_PARAMS.p,
    r: SCRYPT_PARAMS.r,
  });
}

/** Derive one password hash using async node:crypto scrypt; the function is injectable for tests. */
export async function hashPassword(password, {
  salt = DEMO_SALT,
  scryptFn = scrypt,
} = {}) {
  validatePassword(password);
  validateScryptFn(scryptFn);
  const derivedKey = await asyncScrypt(password, toSaltBuffer(salt), scryptFn);
  if (!Buffer.isBuffer(derivedKey)) {
    invalid("scryptFn must resolve to a Buffer");
  }
  return derivedKey;
}

function validateLoginInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  const keys = Object.keys(input).sort();
  if (keys.length !== 2 || keys[0] !== "password" || keys[1] !== "username") {
    return false;
  }
  return typeof input.username === "string"
    && input.username.length > 0
    && typeof input.password === "string"
    && input.password.length > 0;
}

function invalidResponse() {
  return { body: LOGIN_INVALID_BODY, statusCode: LOGIN_INVALID_STATUS };
}

function successResponse() {
  return { body: LOGIN_SUCCESS_BODY, statusCode: LOGIN_SUCCESS_STATUS };
}

/** Build the deterministic in-memory store and precompute its stored hashes once. */
export async function createDemoUserStore({
  hashPasswordFn = hashPassword,
} = {}) {
  if (typeof hashPasswordFn !== "function") {
    invalid("hashPasswordFn must be a function");
  }
  const users = new Map();
  for (const seededUser of SEEDED_USERS) {
    const passwordHash = await hashPasswordFn(seededUser.password, { salt: seededUser.salt });
    if (!Buffer.isBuffer(passwordHash)) {
      invalid("hashPasswordFn must resolve to a Buffer");
    }
    users.set(seededUser.username, Object.freeze({
      passwordHash,
      salt: seededUser.salt,
      userId: seededUser.userId,
      username: seededUser.username,
    }));
  }
  const dummyHash = await hashPasswordFn(DEMO_DUMMY_PASSWORD, { salt: DEMO_DUMMY_SALT });
  if (!Buffer.isBuffer(dummyHash)) {
    invalid("hashPasswordFn must resolve to a Buffer");
  }
  return Object.freeze({
    dummyHash,
    dummySalt: DEMO_DUMMY_SALT,
    findUser: (username) => users.get(username),
  });
}

/**
 * Create the shared login path. The only demo policy difference is whether a
 * missing user receives the same hash-and-compare work as an existing user.
 */
export function createDemoAuthenticator({
  hashPasswordFn = hashPassword,
  skipMissingUserHash = false,
  scryptFn = scrypt,
  timingSafeEqualFn = timingSafeEqual,
  userStore,
} = {}) {
  if (!userStore || typeof userStore.findUser !== "function") {
    invalid("userStore must provide findUser");
  }
  if (typeof hashPasswordFn !== "function") {
    invalid("hashPasswordFn must be a function");
  }
  validateScryptFn(scryptFn);
  if (typeof timingSafeEqualFn !== "function") {
    invalid("timingSafeEqualFn must be a function");
  }
  if (typeof skipMissingUserHash !== "boolean") {
    invalid("skipMissingUserHash must be a boolean");
  }

  return async function authenticateLogin(input) {
    if (!validateLoginInput(input)) {
      return invalidResponse();
    }

    const user = userStore.findUser(input.username);
    if (user) {
      const candidateHash = await hashPasswordFn(input.password, { salt: user.salt, scryptFn });
      timingSafeEqualFn(candidateHash, user.passwordHash);
    } else if (!skipMissingUserHash) {
      const candidateHash = await hashPasswordFn(input.password, {
        salt: userStore.dummySalt,
        scryptFn,
      });
      timingSafeEqualFn(candidateHash, userStore.dummyHash);
    }
    return successResponse();
  };
}
