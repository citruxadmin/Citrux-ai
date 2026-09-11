import express from "express";
import dotenv from "dotenv";
import OpenAI, { toFile } from "openai";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";

if (!API_KEY) {
  console.error("OPENAI_API_KEY is missing.");
  process.exit(1);
}

const client = new OpenAI({
  apiKey: API_KEY
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Render runs behind a proxy.
// This allows Express to correctly identify visitors by IP.
app.set("trust proxy", 1);

app.use(express.json({
  limit: "35mb"
}));

app.use(express.static(__dirname));

// --------------------------------------------------
// SHORT-TERM RATE LIMIT
// Maximum 20 requests per minute per IP
// --------------------------------------------------

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests. Please wait a moment and try again."
  }
});

// --------------------------------------------------
// CITRUX FREE DAILY MESSAGE LIMIT
// 100 messages per user per day
// --------------------------------------------------

const DAILY_MESSAGE_LIMIT = 100;

// Temporary in-memory usage storage.
// This is suitable for the current prototype.
// Later we can move this to a database.
const dailyUsage = new Map();

function getUserId(req) {
  return req.ip || "unknown-user";
}

function getToday() {
  return new Date().toISOString().slice(0, 10);
}

function getDailyUsage(userId) {
  const today = getToday();
  const existing = dailyUsage.get(userId);

  // Start a new daily counter
  if (!existing || existing.date !== today) {
    const usage = {
      date: today,
      count: 0
    };

    dailyUsage.set(userId, usage);
    return usage;
  }

  return existing;
}

// --------------------------------------------------
// HEALTH CHECK
// --------------------------------------------------

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Citrux backend is running"
  });
});

// --------------------------------------------------
// DATA URL PARSER
// --------------------------------------------------

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(
    /^data:([^;]+);base64,(.+)$/
  );

  if (!match) {
    return null;
  }

  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64")
  };
}

// --------------------------------------------------
// CHAT API
// --------------------------------------------------

app.post("/api/chat", limiter, async (req, res) => {
  try {
    const {
      messages = [],
      attachments = []
    } = req.body;

    // ----------------------------------------------
    // CHECK DAILY USER LIMIT
    // ----------------------------------------------

    const userId = getUserId(req);
    const usage = getDailyUsage(userId);

    if (usage.count >= DAILY_MESSAGE_LIMIT) {
      return res.status(429).json({
        error:
          "You've reached your 100-message daily limit. Please try again tomorrow."
      });
    }

    // ----------------------------------------------
    // CLEAN MESSAGES
    // ----------------------------------------------

    const cleanMessages = Array.isArray(messages)
      ? messages
          .filter(
            (m) =>
              m &&
              (m.role === "user" || m.role === "assistant") &&
              typeof m.content === "string"
          )
          .slice(-20)
      : [];

    if (
      cleanMessages.length === 0 &&
      (!Array.isArray(attachments) || attachments.length === 0)
    ) {
      return res.status(400).json({
        error: "No message or attachment was provided."
      });
    }

    // ----------------------------------------------
    // BUILD OPENAI INPUT
    // ----------------------------------------------

    const input = [];

    input.push({
      role: "system",
      content:
        "You are Citrux AI, a helpful, intelligent and professional AI assistant. Give clear, accurate and useful answers. When the user provides an image or file, carefully analyze it and answer based on its contents."
    });

    for (const message of cleanMessages) {
      input.push({
        role: message.role,
        content: message.content
      });
    }

    // ----------------------------------------------
    // PROCESS ATTACHMENTS
    // ----------------------------------------------

    if (Array.isArray(attachments)) {
      for (const attachment of attachments) {
        if (!attachment?.dataUrl) {
          continue;
        }

        const parsed = parseDataUrl(attachment.dataUrl);

        if (!parsed) {
          continue;
        }

        const {
          mimeType,
          buffer
        } = parsed;

        // ------------------------------------------
        // IMAGE
        // ------------------------------------------

        if (mimeType.startsWith("image/")) {
          input.push({
            role: "user",
            content: [
              {
                type: "input_image",
                image_url: attachment.dataUrl
              }
            ]
          });

          continue;
        }

        // ------------------------------------------
        // TEXT / CSV
        // ------------------------------------------

        if (
          mimeType.startsWith("text/") ||
          attachment.name?.toLowerCase().endsWith(".csv")
        ) {
          const text = buffer.toString("utf8");

          input.push({
            role: "user",
            content:
              `Attached file: ${attachment.name}\n\n${text}`
          });

          continue;
        }

        // ------------------------------------------
        // OTHER FILE TYPES
        // ------------------------------------------

        const uploaded = await client.files.create({
          file: await toFile(
            buffer,
            attachment.name || "attachment",
            {
              type: mimeType
            }
          ),
          purpose: "user_data"
        });

        input.push({
          role: "user",
          content: [
            {
              type: "input_file",
              file_id: uploaded.id
            }
          ]
        });
      }
    }

    // ----------------------------------------------
    // OPENAI REQUEST TIMEOUT
    // ----------------------------------------------

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 60000);

    try {
      const response = await client.responses.create(
        {
          model: MODEL,
          input
        },
        {
          signal: controller.signal
        }
      );

      clearTimeout(timeout);

      // --------------------------------------------
      // COUNT SUCCESSFUL MESSAGE
      // --------------------------------------------

      usage.count++;

      res.json({
        reply:
          response.output_text ||
          "I couldn't generate a response.",

        usage: {
          used: usage.count,
          limit: DAILY_MESSAGE_LIMIT,
          remaining: Math.max(
            0,
            DAILY_MESSAGE_LIMIT - usage.count
          )
        }
      });
    } catch (error) {
      clearTimeout(timeout);
      throw error;
    }
  } catch (error) {
    console.error("Citrux API error:", error);

    // ----------------------------------------------
    // FRIENDLY OPENAI RATE LIMIT MESSAGE
    // ----------------------------------------------

    if (error?.code === "rate_limit_exceeded") {
      return res.status(429).json({
        error:
          "Citrux AI has temporarily reached its API limit. Please try again later."
      });
    }

    // ----------------------------------------------
    // TIMEOUT
    // ----------------------------------------------

    if (error?.name === "AbortError") {
      return res.status(504).json({
        error:
          "Citrux took too long to respond. Please try again."
      });
    }

    // ----------------------------------------------
    // GENERAL ERROR
    // ----------------------------------------------

    res.status(500).json({
      error:
        error?.message ||
        "Something went wrong."
    });
  }
});

// --------------------------------------------------
// FRONTEND FALLBACK
// --------------------------------------------------

app.get("/{*splat}", (req, res) => {
  res.sendFile(
    path.join(__dirname, "index.html")
  );
});

// --------------------------------------------------
// START SERVER
// --------------------------------------------------

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Citrux running on http://localhost:${PORT}`
    );
  }
);