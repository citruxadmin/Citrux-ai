import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { Pool } from "pg";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import crypto from "crypto";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MODEL =
  process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

// --------------------------------------------------
// CITRUX IDENTITY
// --------------------------------------------------

const CITRUX_NAME = "Citrux AI";
const CITRUX_CREATOR = "Sheik Faisal S";
const CITRUX_DEVELOPER = "Sheik Faisal S";
const CITRUX_OWNER = "Sheik Faisal S";

// --------------------------------------------------
// GEMINI
// --------------------------------------------------

if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is missing.");
  process.exit(1);
}

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});

// --------------------------------------------------
// PATHS
// --------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------------------------------------
// POSTGRESQL
// --------------------------------------------------

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    })
  : null;

// --------------------------------------------------
// DATABASE INITIALIZATION
// --------------------------------------------------

async function initializeDatabase() {
  if (!pool) {
    console.log(
      "DATABASE_URL not configured. PostgreSQL persistence is disabled locally."
    );

    return;
  }

  try {
    // ------------------------------------------------
    // USERS
    // ------------------------------------------------

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL DEFAULT 'Citrux User',
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ------------------------------------------------
    // MIGRATION FOR EXISTING USERS
    // ------------------------------------------------

    await pool.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT 'Citrux User';
    `);

    // ------------------------------------------------
    // CONVERSATIONS
    // ------------------------------------------------

    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id BIGSERIAL PRIMARY KEY,
        conversation_id TEXT UNIQUE NOT NULL,
        user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT 'New Chat',
        messages JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ------------------------------------------------
    // MIGRATION FOR EXISTING DATABASES
    // ------------------------------------------------

    await pool.query(`
      ALTER TABLE conversations
      ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE CASCADE;
    `);

    // ------------------------------------------------
    // SESSIONS
    // ------------------------------------------------

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id BIGSERIAL PRIMARY KEY,
        session_token_hash TEXT UNIQUE NOT NULL,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // ------------------------------------------------
    // INDEXES
    // ------------------------------------------------

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_user_id
      ON conversations(user_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
      ON conversations(updated_at DESC);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id
      ON sessions(user_id);
    `);

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at
      ON sessions(expires_at);
    `);

    console.log(
      "PostgreSQL database initialized."
    );

    console.log(
      "Users, conversations and sessions tables are ready."
    );
  } catch (error) {
    console.error(
      "PostgreSQL initialization error:",
      error
    );
  }
}

// --------------------------------------------------
// EXPRESS
// --------------------------------------------------

app.set("trust proxy", 1);

app.use(
  express.json({
    limit: "35mb"
  })
);

app.use(express.static(__dirname));

// --------------------------------------------------
// RATE LIMITING
// --------------------------------------------------

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error:
      "Too many requests. Please wait a moment and try again."
  }
});

// --------------------------------------------------
// AUTH RATE LIMITER
// --------------------------------------------------

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error:
      "Too many authentication attempts. Please try again later."
  }
});

// --------------------------------------------------
// DAILY MESSAGE LIMIT
// --------------------------------------------------

const DAILY_MESSAGE_LIMIT = 100;

const dailyUsage = new Map();

function getUserIdForUsage(userId, req) {
  if (userId) {
    return `user:${userId}`;
  }

  return `ip:${req.ip || "unknown-user"}`;
}

function getToday() {
  return new Date()
    .toISOString()
    .slice(0, 10);
}

function getDailyUsage(userId) {
  const today = getToday();

  const existing =
    dailyUsage.get(userId);

  if (
    !existing ||
    existing.date !== today
  ) {
    const usage = {
      date: today,
      count: 0
    };

    dailyUsage.set(
      userId,
      usage
    );

    return usage;
  }

  return existing;
}

// --------------------------------------------------
// COOKIE HELPERS
// --------------------------------------------------

const SESSION_COOKIE_NAME = "citrux_session";

const SESSION_DURATION_MS =
  7 * 24 * 60 * 60 * 1000;

function parseCookies(req) {
  const header =
    req.headers.cookie || "";

  const cookies = {};

  for (
    const part
    of header.split(";")
  ) {
    const index =
      part.indexOf("=");

    if (index === -1) {
      continue;
    }

    const name =
      part
        .slice(0, index)
        .trim();

    const value =
      part
        .slice(index + 1)
        .trim();

    if (!name) {
      continue;
    }

    cookies[name] =
      decodeURIComponent(value);
  }

  return cookies;
}

function setSessionCookie(
  res,
  token
) {
  const maxAge =
    SESSION_DURATION_MS;

  const secure =
    process.env.NODE_ENV ===
    "production";

  const cookieParts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAge / 1000)}`
  ];

  if (secure) {
    cookieParts.push("Secure");
  }

  res.setHeader(
    "Set-Cookie",
    cookieParts.join("; ")
  );
}

function clearSessionCookie(res) {
  const secure =
    process.env.NODE_ENV ===
    "production";

  const cookieParts = [
    `${SESSION_COOKIE_NAME}=`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    "Max-Age=0"
  ];

  if (secure) {
    cookieParts.push("Secure");
  }

  res.setHeader(
    "Set-Cookie",
    cookieParts.join("; ")
  );
}

// --------------------------------------------------
// SESSION HELPERS
// --------------------------------------------------

function createSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashSessionToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

async function getAuthenticatedUser(req) {
  if (!pool) {
    return null;
  }

  try {
    const cookies =
      parseCookies(req);

    const token =
      cookies[
        SESSION_COOKIE_NAME
      ];

    if (!token) {
      return null;
    }

    const tokenHash =
      hashSessionToken(token);

    const result =
      await pool.query(
        `
        SELECT
          users.id,
          users.name,
          users.email,
          users.created_at,
          users.updated_at
        FROM sessions
        INNER JOIN users
          ON users.id = sessions.user_id
        WHERE
          sessions.session_token_hash = $1
          AND sessions.expires_at > NOW()
        LIMIT 1
        `,
        [tokenHash]
      );

    if (
      result.rows.length === 0
    ) {
      return null;
    }

    return result.rows[0];
  } catch (error) {
    console.error(
      "Authentication lookup error:",
      error
    );

    return null;
  }
}

async function requireAuth(req, res, next) {
  const user =
    await getAuthenticatedUser(req);

  if (!user) {
    return res.status(401).json({
      error:
        "You must be logged in to perform this action."
    });
  }

  req.user = user;

  next();
}

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get(
  "/api/health",
  async (req, res) => {
    let database = "disabled";

    if (pool) {
      try {
        await pool.query(
          "SELECT 1"
        );

        database = "connected";
      } catch {
        database = "error";
      }
    }

    res.json({
      status: "ok",
      message:
        "Citrux backend is running",
      provider: "Google Gemini",
      database
    });
  }
);

// --------------------------------------------------
// REGISTER
// --------------------------------------------------

app.post(
  "/api/auth/register",
  authLimiter,
  async (req, res) => {
    try {
      if (!pool) {
        return res.status(503).json({
          error:
            "Database persistence is not configured."
        });
      }

      const name =
        String(
          req.body?.name ||
          "Citrux User"
        )
          .trim()
          .slice(0, 100) ||
        "Citrux User";

      const email =
        String(
          req.body?.email || ""
        )
          .trim()
          .toLowerCase();

      const password =
        String(
          req.body?.password || ""
        );

      if (
        !email ||
        !email.includes("@") ||
        email.length > 254
      ) {
        return res.status(400).json({
          error:
            "Please enter a valid email address."
        });
      }

      if (
        password.length < 8 ||
        password.length > 128
      ) {
        return res.status(400).json({
          error:
            "Password must be between 8 and 128 characters."
        });
      }

      const existing =
        await pool.query(
          `
          SELECT id
          FROM users
          WHERE email = $1
          LIMIT 1
          `,
          [email]
        );

      if (
        existing.rows.length > 0
      ) {
        return res.status(409).json({
          error:
            "An account with this email already exists."
        });
      }

      const passwordHash =
        await bcrypt.hash(
          password,
          12
        );

      const result =
        await pool.query(
          `
          INSERT INTO users (
            name,
            email,
            password_hash
          )
          VALUES ($1, $2, $3)
          RETURNING
            id,
            name,
            email,
            created_at
          `,
          [
            name,
            email,
            passwordHash
          ]
        );

      const user =
        result.rows[0];

      // Create login session immediately.
      const sessionToken =
        createSessionToken();

      const sessionHash =
        hashSessionToken(
          sessionToken
        );

      const expiresAt =
        new Date(
          Date.now() +
          SESSION_DURATION_MS
        );

      await pool.query(
        `
        INSERT INTO sessions (
          session_token_hash,
          user_id,
          expires_at
        )
        VALUES ($1, $2, $3)
        `,
        [
          sessionHash,
          user.id,
          expiresAt
        ]
      );

      setSessionCookie(
        res,
        sessionToken
      );

      res.status(201).json({
        success: true,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          created_at:
            user.created_at
        }
      });
    } catch (error) {
      console.error(
        "Registration error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to create your account."
      });
    }
  }
);

// --------------------------------------------------
// LOGIN
// --------------------------------------------------

app.post(
  "/api/auth/login",
  authLimiter,
  async (req, res) => {
    try {
      if (!pool) {
        return res.status(503).json({
          error:
            "Database persistence is not configured."
        });
      }

      const email =
        String(
          req.body?.email || ""
        )
          .trim()
          .toLowerCase();

      const password =
        String(
          req.body?.password || ""
        );

      if (!email || !password) {
        return res.status(400).json({
          error:
            "Email and password are required."
        });
      }

      const result =
        await pool.query(
          `
          SELECT
            id,
            name,
            email,
            password_hash,
            created_at,
            updated_at
          FROM users
          WHERE email = $1
          LIMIT 1
          `,
          [email]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(401).json({
          error:
            "Invalid email or password."
        });
      }

      const user =
        result.rows[0];

      const passwordMatches =
        await bcrypt.compare(
          password,
          user.password_hash
        );

      if (!passwordMatches) {
        return res.status(401).json({
          error:
            "Invalid email or password."
        });
      }

      const sessionToken =
        createSessionToken();

      const sessionHash =
        hashSessionToken(
          sessionToken
        );

      const expiresAt =
        new Date(
          Date.now() +
          SESSION_DURATION_MS
        );

      await pool.query(
        `
        INSERT INTO sessions (
          session_token_hash,
          user_id,
          expires_at
        )
        VALUES ($1, $2, $3)
        `,
        [
          sessionHash,
          user.id,
          expiresAt
        ]
      );

      setSessionCookie(
        res,
        sessionToken
      );

      res.json({
        success: true,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          created_at:
            user.created_at
        }
      });
    } catch (error) {
      console.error(
        "Login error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to log you in."
      });
    }
  }
);

// --------------------------------------------------
// CURRENT USER
// --------------------------------------------------

app.get(
  "/api/auth/me",
  async (req, res) => {
    const user =
      await getAuthenticatedUser(req);

    if (!user) {
      return res.json({
        authenticated: false
      });
    }

    res.json({
      authenticated: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        created_at:
          user.created_at
      }
    });
  }
);

// --------------------------------------------------
// LOGOUT
// --------------------------------------------------

app.post(
  "/api/auth/logout",
  async (req, res) => {
    try {
      if (pool) {
        const cookies =
          parseCookies(req);

        const token =
          cookies[
            SESSION_COOKIE_NAME
          ];

        if (token) {
          const tokenHash =
            hashSessionToken(
              token
            );

          await pool.query(
            `
            DELETE FROM sessions
            WHERE session_token_hash = $1
            `,
            [tokenHash]
          );
        }
      }

      clearSessionCookie(res);

      res.json({
        success: true
      });
    } catch (error) {
      console.error(
        "Logout error:",
        error
      );

      clearSessionCookie(res);

      res.json({
        success: true
      });
    }
  }
);

// --------------------------------------------------
// SAVE CONVERSATION
// --------------------------------------------------

app.post(
  "/api/conversations",
  requireAuth,
  async (req, res) => {
    try {
      if (!pool) {
        return res.status(503).json({
          error:
            "Database persistence is not configured."
        });
      }

      const {
        conversationId,
        title = "New Chat",
        messages = []
      } = req.body;

      if (
        !conversationId ||
        typeof conversationId !==
          "string"
      ) {
        return res.status(400).json({
          error:
            "A valid conversationId is required."
        });
      }

      if (!Array.isArray(messages)) {
        return res.status(400).json({
          error:
            "Messages must be an array."
        });
      }

      const existing =
        await pool.query(
          `
          SELECT
            id,
            user_id
          FROM conversations
          WHERE conversation_id = $1
          LIMIT 1
          `,
          [conversationId]
        );

      if (
        existing.rows.length > 0
      ) {
        const existingUserId =
          existing.rows[0].user_id;

        if (
          existingUserId &&
          String(existingUserId) !==
            String(req.user.id)
        ) {
          return res.status(403).json({
            error:
              "You do not have permission to modify this conversation."
          });
        }

        // Claim legacy conversation only
        // when it has no owner.
        if (!existingUserId) {
          await pool.query(
            `
            UPDATE conversations
            SET
              user_id = $1,
              title = $2,
              messages = $3,
              updated_at = NOW()
            WHERE conversation_id = $4
            `,
            [
              req.user.id,
              String(title).slice(
                0,
                200
              ),
              JSON.stringify(messages),
              conversationId
            ]
          );
        } else {
          await pool.query(
            `
            UPDATE conversations
            SET
              title = $1,
              messages = $2,
              updated_at = NOW()
            WHERE
              conversation_id = $3
              AND user_id = $4
            `,
            [
              String(title).slice(
                0,
                200
              ),
              JSON.stringify(messages),
              conversationId,
              req.user.id
            ]
          );
        }
      } else {
        await pool.query(
          `
          INSERT INTO conversations (
            conversation_id,
            user_id,
            title,
            messages
          )
          VALUES ($1, $2, $3, $4)
          `,
          [
            conversationId,
            req.user.id,
            String(title).slice(
              0,
              200
            ),
            JSON.stringify(messages)
          ]
        );
      }

      res.json({
        success: true,
        conversationId
      });
    } catch (error) {
      console.error(
        "Conversation save error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to save conversation."
      });
    }
  }
);

// --------------------------------------------------
// LOAD CONVERSATION
// --------------------------------------------------

app.get(
  "/api/conversations/:conversationId",
  requireAuth,
  async (req, res) => {
    try {
      if (!pool) {
        return res.status(503).json({
          error:
            "Database persistence is not configured."
        });
      }

      const conversationId =
        req.params.conversationId;

      const result =
        await pool.query(
          `
          SELECT
            conversation_id,
            title,
            messages,
            created_at,
            updated_at
          FROM conversations
          WHERE
            conversation_id = $1
            AND user_id = $2
          LIMIT 1
          `,
          [
            conversationId,
            req.user.id
          ]
        );

      if (
        result.rows.length === 0
      ) {
        return res.status(404).json({
          error:
            "Conversation not found."
        });
      }

      res.json({
        conversation:
          result.rows[0]
      });
    } catch (error) {
      console.error(
        "Conversation load error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to load conversation."
      });
    }
  }
);

// --------------------------------------------------
// LIST RECENT CONVERSATIONS
// --------------------------------------------------

app.get(
  "/api/conversations",
  requireAuth,
  async (req, res) => {
    try {
      if (!pool) {
        return res.status(503).json({
          error:
            "Database persistence is not configured."
        });
      }

      const result =
        await pool.query(
          `
          SELECT
            conversation_id,
            title,
            created_at,
            updated_at
          FROM conversations
          WHERE user_id = $1
          ORDER BY updated_at DESC
          LIMIT 50
          `,
          [req.user.id]
        );

      res.json({
        conversations:
          result.rows
      });
    } catch (error) {
      console.error(
        "Conversation list error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to load conversations."
      });
    }
  }
);

// --------------------------------------------------
// DELETE CONVERSATION
// --------------------------------------------------

app.delete(
  "/api/conversations/:conversationId",
  requireAuth,
  async (req, res) => {
    try {
      if (!pool) {
        return res.status(503).json({
          error:
            "Database persistence is not configured."
        });
      }

      const conversationId =
        req.params.conversationId;

      await pool.query(
        `
        DELETE FROM conversations
        WHERE
          conversation_id = $1
          AND user_id = $2
        `,
        [
          conversationId,
          req.user.id
        ]
      );

      res.json({
        success: true
      });
    } catch (error) {
      console.error(
        "Conversation delete error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to delete conversation."
      });
    }
  }
);

// --------------------------------------------------
// CLEAN EXPIRED SESSIONS
// --------------------------------------------------

async function cleanExpiredSessions() {
  if (!pool) {
    return;
  }

  try {
    await pool.query(
      `
      DELETE FROM sessions
      WHERE expires_at <= NOW()
      `
    );
  } catch (error) {
    console.error(
      "Session cleanup error:",
      error
    );
  }
}

setInterval(
  cleanExpiredSessions,
  60 * 60 * 1000
);

// --------------------------------------------------
// CHAT API
// --------------------------------------------------

app.post(
  "/api/chat",
  limiter,
  requireAuth,
  async (req, res) => {
    try {
      const {
        messages = [],
        attachments = []
      } = req.body;

      const usageUserId =
        getUserIdForUsage(
          req.user.id,
          req
        );

      const usage =
        getDailyUsage(
          usageUserId
        );

      if (
        usage.count >=
        DAILY_MESSAGE_LIMIT
      ) {
        return res.status(429).json({
          error:
            "You've reached your 100-message daily limit. Please try again tomorrow."
        });
      }

      const cleanMessages =
        Array.isArray(messages)
          ? messages
              .filter(
                (m) =>
                  m &&
                  (
                    m.role === "user" ||
                    m.role === "assistant"
                  ) &&
                  typeof m.content === "string"
              )
              .slice(-20)
          : [];

      if (
        cleanMessages.length === 0 &&
        (
          !Array.isArray(attachments) ||
          attachments.length === 0
        )
      ) {
        return res.status(400).json({
          error:
            "No message or attachment was provided."
        });
      }

      // ------------------------------------------------
      // DETERMINISTIC CITRUX IDENTITY
      // ------------------------------------------------

      const latestUserMessage =
        cleanMessages
          .filter(
            (m) => m.role === "user"
          )
          .at(-1)?.content || "";

      const identityQuestion =
        latestUserMessage
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .replace(/\s+/g, " ")
          .trim();

      const mentionsCitrux =
        /\b(you|your|yourself|citrux|citrux ai)\b/i.test(
          identityQuestion
        );

      const asksCreator =
        /\b(creator|created|create|made|maker|founded|founder|built|builder)\b/i.test(
          identityQuestion
        ) &&
        mentionsCitrux;

      const asksDeveloper =
        /\b(developer|developed|development|programmer|programmed|coded|coder)\b/i.test(
          identityQuestion
        ) &&
        mentionsCitrux;

      const asksOwner =
        /\b(owner|owns|ownership|owned)\b/i.test(
          identityQuestion
        ) &&
        mentionsCitrux;

      if (
        asksCreator ||
        asksDeveloper ||
        asksOwner
      ) {
        let reply;

        if (asksOwner) {
          reply =
            `${CITRUX_NAME} is owned by ${CITRUX_OWNER}.`;
        } else if (asksDeveloper) {
          reply =
            `${CITRUX_NAME} was developed by ${CITRUX_DEVELOPER}.`;
        } else {
          reply =
            `${CITRUX_NAME} was created by ${CITRUX_CREATOR}.`;
        }

        usage.count++;

        return res.json({
          reply,

          usage: {
            used:
              usage.count,

            limit:
              DAILY_MESSAGE_LIMIT,

            remaining:
              Math.max(
                0,
                DAILY_MESSAGE_LIMIT -
                  usage.count
              )
          }
        });
      }

      // ------------------------------------------------
      // CITRUX AI CONVERSATION
      // ------------------------------------------------

      const conversation = [];

      conversation.push(
        `
You are ${CITRUX_NAME}, a helpful, intelligent, accurate and professional AI assistant.

PRODUCT IDENTITY:
- Product name: ${CITRUX_NAME}
- Creator: ${CITRUX_CREATOR}
- Developer: ${CITRUX_DEVELOPER}
- Owner: ${CITRUX_OWNER}
- AI model/provider: Google Gemini

IMPORTANT IDENTITY RULES:
- ${CITRUX_CREATOR} created ${CITRUX_NAME}.
- ${CITRUX_DEVELOPER} developed ${CITRUX_NAME}.
- ${CITRUX_OWNER} owns ${CITRUX_NAME}.
- If the user asks who created, developed, built, made, founded, owns, or is responsible for ${CITRUX_NAME}, clearly answer with the appropriate Citrux identity.
- If the user asks "Who is your creator?", answer that ${CITRUX_CREATOR} is the creator of ${CITRUX_NAME}.
- If the user asks "Who is your developer?", answer that ${CITRUX_DEVELOPER} is the developer of ${CITRUX_NAME}.
- If the user asks "Who is your owner?", answer that ${CITRUX_OWNER} is the owner of ${CITRUX_NAME}.
- Do not say that Google or Gemini created, developed, founded, or owns ${CITRUX_NAME}.
- Google Gemini is the AI model/provider powering ${CITRUX_NAME}; it is not the creator, developer, founder, or owner of the Citrux product.
- Do not reveal private API keys, database credentials, passwords, environment variables, or other secrets.
- Give clear, accurate and useful answers.
- When the user provides an image or file, carefully analyze it and answer based on its contents.
        `.trim()
      );

      // ------------------------------------------------
      // CONVERSATION HISTORY
      // ------------------------------------------------

      for (
        const message
        of cleanMessages
      ) {
        const role =
          message.role === "assistant"
            ? "Citrux AI"
            : "User";

        conversation.push(
          `${role}: ${message.content}`
        );
      }

      // ------------------------------------------------
      // ATTACHMENTS
      // ------------------------------------------------

      if (
        Array.isArray(attachments)
      ) {
        for (
          const attachment
          of attachments
        ) {
          if (
            !attachment?.dataUrl
          ) {
            continue;
          }

          const match =
            String(
              attachment.dataUrl
            ).match(
              /^data:([^;]+);base64,(.+)$/
            );

          if (!match) {
            continue;
          }

          const mimeType =
            match[1];

          const base64Data =
            match[2];

          // IMAGE ATTACHMENT
          if (
            mimeType.startsWith(
              "image/"
            )
          ) {
            conversation.push(
              `User attached an image named "${
                attachment.name ||
                "image"
              }".`
            );

            conversation.push({
              inlineData: {
                mimeType,
                data: base64Data
              }
            });

            continue;
          }

          // TEXT / CSV ATTACHMENT
          if (
            mimeType.startsWith(
              "text/"
            ) ||
            attachment.name
              ?.toLowerCase()
              .endsWith(".csv")
          ) {
            try {
              const text =
                Buffer.from(
                  base64Data,
                  "base64"
                ).toString(
                  "utf8"
                );

              conversation.push(
                `Attached file: ${
                  attachment.name ||
                  "file"
                }\n\n${text}`
              );
            } catch {
              conversation.push(
                `The user attached a file named "${
                  attachment.name ||
                  "file"
                }", but it could not be read as text.`
              );
            }

            continue;
          }

          // OTHER FILES
          conversation.push(
            `The user attached a file named "${
              attachment.name ||
              "file"
            }".`
          );
        }
      }

      // ------------------------------------------------
      // GEMINI REQUEST
      // ------------------------------------------------

      const response =
        await ai.models.generateContent(
          {
            model: MODEL,
            contents:
              conversation
          }
        );

      const reply =
        response.text ||
        "I couldn't generate a response.";

      usage.count++;

      res.json({
        reply,

        usage: {
          used:
            usage.count,

          limit:
            DAILY_MESSAGE_LIMIT,

          remaining:
            Math.max(
              0,
              DAILY_MESSAGE_LIMIT -
                usage.count
            )
        }
      });

    } catch (error) {
      console.error(
        "Citrux Gemini API error:",
        error
      );

      const status =
        error?.status ||
        error?.statusCode;

      if (
        status === 429 ||
        error?.code === 429 ||
        String(
          error?.message || ""
        )
          .toLowerCase()
          .includes(
            "rate limit"
          )
      ) {
        return res
          .status(429)
          .json({
            error:
              "Citrux AI has temporarily reached its Gemini API limit. Please try again later."
          });
      }

      res.status(500).json({
        error:
          error?.message ||
          "Something went wrong while connecting to Gemini."
      });
    }
  }
);

// --------------------------------------------------
// FRONTEND FALLBACK
// --------------------------------------------------

app.get(
  "/{*splat}",
  (req, res) => {
    res.sendFile(
      path.join(
        __dirname,
        "index.html"
      )
    );
  }
);

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

async function startServer() {
  await initializeDatabase();

  await cleanExpiredSessions();

  app.listen(
    PORT,
    "0.0.0.0",
    () => {
      console.log(
        `Citrux running on http://localhost:${PORT}`
      );
    }
  );
}

startServer();