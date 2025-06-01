const express = require("express")
const { MongoClient } = require("mongodb")
const cron = require("node-cron")
const cors = require("cors")
const helmet = require("helmet")
require("dotenv").config()

const app = express()
const PORT = process.env.PORT || 3000

// Middleware
app.use(helmet())
app.use(cors())
app.use(express.json({ limit: "10mb" }))

// MongoDB connection
let db
const MONGODB_URI = process.env.MONGODB_URI
const RENDER_SERVER_SECRET = process.env.RENDER_SERVER_SECRET

if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI environment variable is required")
  process.exit(1)
}

if (!RENDER_SERVER_SECRET) {
  console.error("❌ RENDER_SERVER_SECRET environment variable is required")
  process.exit(1)
}

// Connect to MongoDB
MongoClient.connect(MONGODB_URI)
  .then((client) => {
    console.log("✅ Connected to MongoDB")
    db = client.db("instaautodm")
  })
  .catch((error) => {
    console.error("❌ MongoDB connection error:", error)
    process.exit(1)
  })

// Middleware to verify requests
const verifyAuth = (req, res, next) => {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" })
  }

  const token = authHeader.substring(7)
  if (token !== RENDER_SERVER_SECRET) {
    return res.status(401).json({ error: "Invalid token" })
  }

  next()
}

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  })
})

// Keep-alive endpoint (for self-pinging)
app.get("/ping", (req, res) => {
  res.json({ pong: true, timestamp: new Date().toISOString() })
})

// Webhook processing endpoint
app.post("/webhook/process", verifyAuth, async (req, res) => {
  try {
    console.log("📥 Received webhook for processing:", JSON.stringify(req.body, null, 2))

    const webhookData = req.body

    if (webhookData.object === "instagram" && webhookData.entry) {
      await processWebhookEntries(webhookData.entry)

      // Log successful processing
      await logEvent("webhook_processed_on_render", webhookData, true)

      res.json({ success: true, message: "Webhook processed successfully" })
    } else {
      res.status(400).json({ error: "Invalid webhook format" })
    }
  } catch (error) {
    console.error("❌ Error processing webhook:", error)
    await logEvent("webhook_processing_error", { error: error.message }, false, error.message)
    res.status(500).json({ error: "Internal server error" })
  }
})

// Process unprocessed webhooks endpoint
app.post("/process/pending", verifyAuth, async (req, res) => {
  try {
    const pendingEvents = await db
      .collection("webhook_events")
      .find({ processed: false })
      .sort({ createdAt: 1 })
      .limit(50)
      .toArray()

    console.log(`📋 Processing ${pendingEvents.length} pending webhook events`)

    for (const event of pendingEvents) {
      try {
        if (event.data.object === "instagram" && event.data.entry) {
          await processWebhookEntries(event.data.entry)

          // Mark as processed
          await db
            .collection("webhook_events")
            .updateOne({ _id: event._id }, { $set: { processed: true, processedAt: new Date() } })
        }
      } catch (eventError) {
        console.error("❌ Error processing event:", eventError)
        await db
          .collection("webhook_events")
          .updateOne({ _id: event._id }, { $set: { error: eventError.message, processedAt: new Date() } })
      }
    }

    res.json({ success: true, processed: pendingEvents.length })
  } catch (error) {
    console.error("❌ Error processing pending events:", error)
    res.status(500).json({ error: "Internal server error" })
  }
})

async function processWebhookEntries(entries) {
  for (const entry of entries) {
    try {
      const instagramId = entry.id
      console.log(`📝 Processing entry for Instagram ID: ${instagramId}`)

      // Handle messaging webhooks
      if (entry.messaging && Array.isArray(entry.messaging)) {
        console.log("💬 Processing messaging webhooks")
        for (const message of entry.messaging) {
          await handleMessage(instagramId, message)
        }
      }

      // Handle changes webhooks (comments, etc.)
      if (entry.changes && Array.isArray(entry.changes)) {
        console.log("🔄 Processing changes webhooks")
        for (const change of entry.changes) {
          console.log(`📝 Change field: ${change.field}`)
          if (change.field === "comments" || change.field === "live_comments") {
            await handleComment(instagramId, change.value)
          }
        }
      }
    } catch (entryError) {
      console.error("❌ Error processing entry:", entryError)
      await logEvent("entry_processing_error", { entry, error: entryError.message }, false, entryError.message)
    }
  }
}

async function handleMessage(instagramId, message) {
  try {
    console.log("📩 Processing message:", JSON.stringify(message, null, 2))

    if (!message.message || message.message.is_echo) {
      console.log("ℹ️ Skipping echo message")
      return
    }

    const messageData = {
      instagramId,
      messageId: message.message.mid || `msg_${Date.now()}`,
      senderId: message.sender?.id,
      recipientId: message.recipient?.id,
      timestamp: new Date(message.timestamp || Date.now()),
      text: message.message.text || "",
      attachments: message.message.attachments || [],
      isEcho: false,
      createdAt: new Date(),
      processed: false,
    }

    const result = await db.collection("messages").insertOne(messageData)
    console.log("📥 Message stored with ID:", result.insertedId)

    await logEvent("message_stored", { messageId: result.insertedId, text: messageData.text })

    if (messageData.text) {
      await processMessageAutomation(instagramId, { ...messageData, _id: result.insertedId })
    }
  } catch (error) {
    console.error("❌ Error handling message:", error)
    await logEvent("message_handling_error", { message, error: error.message }, false, error.message)
  }
}

async function handleComment(instagramId, commentValue) {
  try {
    console.log("💬 Processing comment:", JSON.stringify(commentValue, null, 2))

    // Handle both Facebook Login and Business Login formats
    const commentData = {
      instagramId,
      commentId: commentValue.id || commentValue.comment_id || `comment_${Date.now()}`,
      mediaId: commentValue.media?.id,
      parentId: commentValue.parent_id,
      userId: commentValue.from?.id,
      username: commentValue.from?.username,
      text: commentValue.text || "",
      timestamp: new Date(commentValue.created_time || commentValue.timestamp || Date.now()),
      createdAt: new Date(),
      isProcessed: false,
    }

    const result = await db.collection("comments").insertOne(commentData)
    console.log("📥 Comment stored with ID:", result.insertedId)

    await logEvent("comment_stored", {
      commentId: result.insertedId,
      text: commentData.text,
      username: commentData.username,
    })

    if (commentData.text) {
      await processCommentAutomation(instagramId, { ...commentData, _id: result.insertedId })
    }
  } catch (error) {
    console.error("❌ Error handling comment:", error)
    await logEvent("comment_handling_error", { commentValue, error: error.message }, false, error.message)
  }
}

async function processMessageAutomation(instagramId, messageData) {
  try {
    console.log(`🤖 Processing message automation for: "${messageData.text}"`)

    const automations = await db
      .collection("automations")
      .find({
        instagramId,
        isActive: true,
        type: "message",
      })
      .toArray()

    console.log(`🔍 Found ${automations.length} active message automations`)

    if (automations.length === 0) {
      await logEvent("no_message_automations", { instagramId })
      return
    }

    const messageText = messageData.text.toLowerCase()

    for (const automation of automations) {
      const keywords = automation.triggerKeywords || []
      console.log(`🔑 Checking automation "${automation.name}" with keywords: ${keywords.join(", ")}`)

      const hasKeyword = keywords.some((keyword) => {
        const match = messageText.includes(keyword.toLowerCase())
        console.log(`  - "${keyword}" in "${messageText}": ${match}`)
        return match
      })

      if (hasKeyword) {
        console.log(`✅ Triggering automation: ${automation.name}`)

        const result = await sendDirectMessage(instagramId, messageData.senderId, automation.replyMessage)

        await logEvent("automation_triggered", {
          automationName: automation.name,
          triggerText: messageData.text,
          replyMessage: automation.replyMessage,
          success: result.success,
        })

        if (result.success) {
          await logAutomationTrigger(
            automation,
            instagramId,
            messageData.senderId,
            messageData.text,
            automation.replyMessage,
            "message",
          )
        }
        break
      }
    }
  } catch (error) {
    console.error("❌ Error processing message automation:", error)
    await logEvent("message_automation_error", { messageData, error: error.message }, false, error.message)
  }
}

async function processCommentAutomation(instagramId, commentData) {
  try {
    console.log(`🤖 Processing comment automation for: "${commentData.text}"`)

    const automations = await db
      .collection("automations")
      .find({
        instagramId,
        isActive: true,
        type: "comment",
      })
      .toArray()

    console.log(`🔍 Found ${automations.length} active comment automations`)

    if (automations.length === 0) {
      await logEvent("no_comment_automations", { instagramId })
      return
    }

    const commentText = commentData.text.toLowerCase()

    for (const automation of automations) {
      const keywords = automation.triggerKeywords || []
      console.log(`🔑 Checking automation "${automation.name}" with keywords: ${keywords.join(", ")}`)

      const hasKeyword = keywords.some((keyword) => {
        const match = commentText.includes(keyword.toLowerCase())
        console.log(`  - "${keyword}" in "${commentText}": ${match}`)
        return match
      })

      if (hasKeyword) {
        console.log(`✅ Triggering comment automation: ${automation.name}`)

        const result = await replyToComment(commentData.commentId, automation.replyMessage, instagramId)

        await logEvent("comment_automation_triggered", {
          automationName: automation.name,
          triggerText: commentData.text,
          replyMessage: automation.replyMessage,
          success: result.success,
        })

        if (result.success) {
          await logAutomationTrigger(
            automation,
            instagramId,
            commentData.userId,
            commentData.text,
            automation.replyMessage,
            "comment",
          )

          await db.collection("comments").updateOne(
            { _id: commentData._id },
            {
              $set: {
                isProcessed: true,
                automationId: automation._id,
                replyId: result.replyId,
                repliedAt: new Date(),
              },
            },
          )
        }
        break
      }
    }
  } catch (error) {
    console.error("❌ Error processing comment automation:", error)
    await logEvent("comment_automation_error", { commentData, error: error.message }, false, error.message)
  }
}

async function sendDirectMessage(instagramId, recipientId, message) {
  try {
    const account = await db.collection("accounts").findOne({ instagramId })

    if (!account?.accessToken) {
      console.error("❌ No access token found for account:", instagramId)
      return { success: false, error: "No access token" }
    }

    const response = await fetch(`https://graph.instagram.com/v19.0/${instagramId}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: message },
        access_token: account.accessToken,
      }),
    })

    const responseData = await response.json()

    if (response.ok) {
      console.log("✅ Direct message sent successfully")
      return { success: true, messageId: responseData.id }
    } else {
      console.error("❌ Failed to send direct message:", responseData)
      return { success: false, error: responseData }
    }
  } catch (error) {
    console.error("❌ Error sending direct message:", error)
    return { success: false, error: error.message }
  }
}

async function replyToComment(commentId, replyMessage, instagramId) {
  try {
    const account = await db.collection("accounts").findOne({ instagramId })

    if (!account?.accessToken) {
      console.error("❌ No access token found for account:", instagramId)
      return { success: false, error: "No access token" }
    }

    // Use the correct Instagram Graph API endpoint for comment replies
    const response = await fetch(`https://graph.instagram.com/v19.0/${commentId}/replies`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: replyMessage,
        access_token: account.accessToken,
      }),
    })

    const responseData = await response.json()

    if (response.ok) {
      console.log("✅ Comment reply sent successfully")
      return { success: true, replyId: responseData.id }
    } else {
      console.error("❌ Failed to reply to comment:", responseData)
      return { success: false, error: responseData }
    }
  } catch (error) {
    console.error("❌ Error replying to comment:", error)
    return { success: false, error: error.message }
  }
}

async function logAutomationTrigger(automation, instagramId, triggeredBy, triggerText, replyMessage, triggerType) {
  try {
    await db.collection("automation_logs").insertOne({
      automationId: automation._id,
      automationName: automation.name,
      instagramId,
      triggeredBy,
      triggerText,
      replyMessage,
      triggerType,
      timestamp: new Date(),
    })

    console.log("✅ Automation trigger logged")
  } catch (error) {
    console.error("❌ Error logging automation trigger:", error)
  }
}

async function logEvent(eventType, data, success = true, error) {
  try {
    await db.collection("webhook_logs").insertOne({
      eventType,
      data,
      success,
      error,
      timestamp: new Date(),
      createdAt: new Date(),
      source: "render_server",
    })
  } catch (logError) {
    console.error("Failed to log event:", logError)
  }
}

// Self-ping to prevent sleeping (every 14 minutes)
cron.schedule("*/14 * * * *", async () => {
  try {
    const response = await fetch(`${process.env.RENDER_APP_URL || "http://localhost:" + PORT}/ping`)
    console.log("🏓 Self-ping successful:", response.status)
  } catch (error) {
    console.error("❌ Self-ping failed:", error)
  }
})

// Process pending webhooks every minute
cron.schedule("* * * * *", async () => {
  try {
    const pendingCount = await db.collection("webhook_events").countDocuments({ processed: false })
    if (pendingCount > 0) {
      console.log(`📋 Found ${pendingCount} pending webhook events, processing...`)

      const response = await fetch(`${process.env.RENDER_APP_URL || "http://localhost:" + PORT}/process/pending`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RENDER_SERVER_SECRET}`,
          "Content-Type": "application/json",
        },
      })

      if (response.ok) {
        const result = await response.json()
        console.log(`✅ Processed ${result.processed} pending events`)
      }
    }
  } catch (error) {
    console.error("❌ Error in pending webhook processing:", error)
  }
})

app.listen(PORT, () => {
  console.log(`🚀 Instagram Automation Server running on port ${PORT}`)
  console.log(`📡 Health check: http://localhost:${PORT}/health`)
  console.log(`🏓 Ping endpoint: http://localhost:${PORT}/ping`)
})
