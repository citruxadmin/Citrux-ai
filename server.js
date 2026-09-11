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

app.use(express.json({
  limit: "35mb"
}));

app.use(express.static(__dirname));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Citrux backend is running"
  });
});

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

app.post(
  "/api/chat",
  limiter,
  async (req, res) => {

    try {

      const {
        messages = [],
        attachments = []
      } = req.body;

      const cleanMessages = Array.isArray(messages)
        ? messages
            .filter(
              m =>
                m &&
                (m.role === "user" ||
                 m.role === "assistant") &&
                typeof m.content === "string"
            )
            .slice(-20)
        : [];

      if (
        cleanMessages.length === 0 &&
        attachments.length === 0
      ) {
        return res.status(400).json({
          error: "No message or attachment was provided."
        });
      }

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

      // Process attachments
      for (const attachment of attachments) {

        if (!attachment?.dataUrl) {
          continue;
        }

        const parsed =
          parseDataUrl(attachment.dataUrl);

        if (!parsed) {
          continue;
        }

        const {
          mimeType,
          buffer
        } = parsed;

        // IMAGE
        if (
          mimeType.startsWith("image/")
        ) {

          input.push({
            role: "user",
            content: [
              {
                type: "input_image",
                image_url:
                  attachment.dataUrl
              }
            ]
          });

          continue;
        }

        // TEXT / CSV
        if (
          mimeType.startsWith("text/") ||
          attachment.name?.toLowerCase().endsWith(".csv")
        ) {

          const text =
            buffer.toString("utf8");

          input.push({
            role: "user",
            content:
              `Attached file: ${attachment.name}\n\n${text}`
          });

          continue;
        }

        // OTHER FILES
        const uploaded =
          await client.files.create({
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

      const controller =
        new AbortController();

      const timeout =
        setTimeout(
          () => controller.abort(),
          60000
        );

      try {

        const response =
          await client.responses.create(
            {
              model: MODEL,
              input
            },
            {
              signal:
                controller.signal
            }
          );

        clearTimeout(timeout);

        res.json({
          reply:
            response.output_text ||
            "I couldn't generate a response."
        });

      } catch (error) {

        clearTimeout(timeout);

        throw error;
      }

    } catch (error) {

      console.error(
        "Citrux API error:",
        error
      );

      res.status(500).json({
        error:
          error.name === "AbortError"
            ? "Citrux took too long to respond. Please try again."
            : error.message ||
              "Something went wrong."
      });
    }
  }
);

app.get("/{*splat}", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Citrux running on http://localhost:${PORT}`
    );
  }
);