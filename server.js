const express = require("express")
const bodyParser = require("body-parser")
const { MongoClient } = require("mongodb")
require("dotenv").config()

const app = express()
const PORT = process.env.PORT || 3000

// MongoDB connection
let db
const MONGODB_URI = process.env.MONGODB_URI
const PROCESSOR_SECRET_KEY = process.env.PROCESSOR_SECRET_KEY || "default-secret"

if (!MONGODB_URI) {
  console.error("❌ MONGODB_URI environment variable is required")
  process.exit(1)
}

// Connect to MongoDB
MongoClient.connect(MONGODB_URI, {
  connectTimeoutMS: 30000,
  socketTimeoutMS: 45000,
  serverSelectionTimeoutMS: 60000,
  maxPoolSize: 10,
  minPoolSize: 5,
  maxIdleTimeMS: 120000,
})
  .then((client) => {
    console.log("✅ Connected to MongoDB")
    db = client.db("instaautodm")
  })
  .catch((error) => {
    console.error("❌ MongoDB connection error:", error)
    process.exit(1)
  })

// Middleware
app.use(bodyParser.json())

// Health check
app.get("/", (req, res) => {
  res.json({
    status: "Automation processor is running",
    timestamp: new Date(),
    mongodb: db ? "connected" : "disconnected",
  })
})

// Process webhook data forwarded from Vercel
app.post("/process-webhook", async (req, res) => {
  try {
    // Verify authorization
    const authHeader = req.headers.authorization
    if (!authHeader || authHeader !== `Bearer ${PROCESSOR_SECRET_KEY}`) {
      console.log("❌ Unauthorized request")
      return res.status(401).json({ error: "Unauthorized" })
    }

    if (!db) {
      console.log("❌ Database not connected")
      return res.status(500).json({ error: "Database not connected" })
    }

    const webhookData = req.body
    console.log("📨 Processing webhook data:", JSON.stringify(webhookData, null, 2))

    // Update webhook log as processed
    try {
      await db.collection("webhook_logs").updateOne(
        { "data.entry.0.id": webhookData.entry?.[0]?.id },
        {
          $set: {
            processed: true,
            processedAt: new Date(),
            processorResponse: "Processing started",
          },
        },
      )
    } catch (logError) {
      console.error("❌ Error updating webhook log:", logError)
    }

    if (webhookData.object === "instagram" && webhookData.entry) {
      await processWebhookEntries(webhookData.entry)
    }

    res.json({ success: true, message: "Webhook processed successfully" })
  } catch (error) {
    console.error("💥 Webhook processing error:", error)
    res.status(500).json({ error: error.message })
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

      // Handle direct field access (alternative structure)
      if (entry.field === "comments" || entry.field === "live_comments") {
        console.log("🔄 Processing direct field webhook")
        await handleComment(instagramId, entry.value)
      }
    } catch (entryError) {
      console.error("❌ Error processing entry:", entryError)
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

    // Store message in database
    const result = await db.collection("messages").insertOne(messageData)
    console.log("📥 Message stored with ID:", result.insertedId)

    // Process automation immediately
    if (messageData.text) {
      await processMessageAutomation(instagramId, { ...messageData, _id: result.insertedId })
    }
  } catch (error) {
    console.error("❌ Error handling message:", error)
  }
}

async function handleComment(instagramId, commentValue) {
  try {
    console.log("💬 Processing comment:", JSON.stringify(commentValue, null, 2))

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

    // Store comment in database
    const result = await db.collection("comments").insertOne(commentData)
    console.log("📥 Comment stored with ID:", result.insertedId)

    // Process automation immediately
    if (commentData.text) {
      await processCommentAutomation(instagramId, { ...commentData, _id: result.insertedId })
    }
  } catch (error) {
    console.error("❌ Error handling comment:", error)
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
      console.log("ℹ️ No active message automations found")
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

        if (result.success) {
          await logAutomationTrigger(
            automation,
            instagramId,
            messageData.senderId,
            messageData.text,
            automation.replyMessage,
            "message",
          )
          console.log("🎉 Message automation completed successfully!")
        } else {
          console.error("❌ Message automation failed:", result.error)
        }
        break
      }
    }
  } catch (error) {
    console.error("❌ Error processing message automation:", error)
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
      console.log("ℹ️ No active comment automations found")
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
          console.log("🎉 Comment automation completed successfully!")
        } else {
          console.error("❌ Comment automation failed:", result.error)
        }
        break
      }
    }
  } catch (error) {
    console.error("❌ Error processing comment automation:", error)
  }
}

async function sendDirectMessage(instagramId, recipientId, message) {
  try {
    console.log(`📤 Sending direct message to ${recipientId}: "${message}"`)

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
      console.log("✅ Direct message sent successfully:", responseData.id)
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
    console.log(`💬 Replying to comment ${commentId}: "${replyMessage}"`)

    const account = await db.collection("accounts").findOne({ instagramId })

    if (!account?.accessToken) {
      console.error("❌ No access token found for account:", instagramId)
      return { success: false, error: "No access token" }
    }

    // Use correct Instagram Graph API endpoint for comment replies
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
      console.log("✅ Comment reply sent successfully:", responseData.id)
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

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received, shutting down gracefully")
  process.exit(0)
})

process.on("SIGINT", () => {
  console.log("🛑 SIGINT received, shutting down gracefully")
  process.exit(0)
})

app.listen(PORT, () => {
  console.log(`🚀 Automation processor running on port ${PORT}`)
  console.log(`📊 Health check available at: http://localhost:${PORT}`)
})
