import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import path from "path";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || ""gemini-3.5-flash-lite"";

if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is missing.");
  process.exit(1);
}

const ai = new GoogleGenAI({
  apiKey: GEMINI_API_KEY
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.set("trust proxy", 1);

app.use(
  express.json({
    limit: "35mb"
  })
);

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
// CITRUX DAILY MESSAGE LIMIT
// 100 messages per user per day
// --------------------------------------------------

const DAILY_MESSAGE_LIMIT = 100;

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
    message: "Citrux backend is running",
    provider: "Google Gemini"
  });
});

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
    // DAILY LIMIT
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
    // BUILD GEMINI PROMPT
    // ----------------------------------------------

    const conversation = [];

    conversation.push(
      "You are Citrux AI, a helpful, intelligent and professional AI assistant. " +
      "Give clear, accurate and useful answers. " +
      "When the user provides an image or file, carefully analyze it and answer based on its contents."
    );

    for (const message of cleanMessages) {
      const role = message.role === "assistant" ? "Citrux AI" : "User";

      conversation.push(
        `${role}: ${message.content}`
      );
    }

    // ----------------------------------------------
    // PROCESS ATTACHMENTS
    // ----------------------------------------------

    if (Array.isArray(attachments)) {
      for (const attachment of attachments) {
        if (!attachment?.dataUrl) {
          continue;
        }

        const match = String(attachment.dataUrl).match(
          /^data:([^;]+);base64,(.+)$/
        );

        if (!match) {
          continue;
        }

        const mimeType = match[1];
        const base64Data = match[2];

        // IMAGE
        if (mimeType.startsWith("image/")) {
          conversation.push(
            `User attached an image named "${attachment.name || "image"}".`
          );

          conversation.push({
            inlineData: {
              mimeType,
              data: base64Data
            }
          });

          continue;
        }

        // TEXT / CSV
        if (
          mimeType.startsWith("text/") ||
          attachment.name?.toLowerCase().endsWith(".csv")
        ) {
          try {
            const text = Buffer.from(
              base64Data,
              "base64"
            ).toString("utf8");

            conversation.push(
              `Attached file: ${attachment.name || "file"}\n\n${text}`
            );
          } catch {
            conversation.push(
              `The user attached a file named "${attachment.name || "file"}", but it could not be read as text.`
            );
          }

          continue;
        }

        // OTHER FILE TYPES
        conversation.push(
          `The user attached a file named "${attachment.name || "file"}".`
        );
      }
    }

    // ----------------------------------------------
    // GEMINI REQUEST
    // ----------------------------------------------

    const response = await ai.models.generateContent({
      model: MODEL,
      contents: conversation
    });

    const reply =
      response.text ||
      "I couldn't generate a response.";

    // ----------------------------------------------
    // COUNT SUCCESSFUL MESSAGE
    // ----------------------------------------------

    usage.count++;

    res.json({
      reply,

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
    console.error("Citrux Gemini API error:", error);

    const status =
      error?.status ||
      error?.statusCode;

    // GEMINI RATE LIMIT
    if (
      status === 429 ||
      error?.code === 429 ||
      String(error?.message || "").toLowerCase().includes("rate limit")
    ) {
      return res.status(429).json({
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