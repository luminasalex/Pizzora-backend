import "dotenv/config"
import cors from "cors"
import express from "express"
import { toNodeHandler } from "better-auth/node"
import { auth, db, mongoClient } from "./auth.js"
import { createApiRouter } from "./api.js"
import { createStripeWebhookHandler, stripe } from "./stripe.js"

const app = express()
const port = process.env.PORT || 3001
const allowedOrigins = (process.env.CLIENT_URL || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)

app.disable("x-powered-by")
app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
  }),
)

app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json" }),
  createStripeWebhookHandler({ db, stripeClient: stripe }),
)
app.all("/api/auth/{*path}", toNodeHandler(auth))
app.use(express.json({ limit: "6mb" }))
app.use("/api", createApiRouter({ db, auth, stripe }))
app.use("/api", (_request, response) => {
  response.status(404).json({ error: "API route not found." })
})

app.get("/", (_request, response) => {
  response.json({ name: "Pizzora API", status: "ok" })
})

app.get("/health", (_request, response) => {
  response.json({ status: "ok" })
})

app.use((error, _request, response, _next) => {
  console.error(error)
  response.status(500).json({ error: "An unexpected server error occurred." })
})

const server = async () => {
  await mongoClient.connect()
  await db.collection("menuItems").createIndex({ vendorId: 1 })
  await db.collection("menuItems").createIndex({ status: 1, availability: 1 })
  await db.collection("menuItems").createIndex({ category: 1 })
  await db.collection("menuItems").createIndex({ location: 1 })
  await db.collection("menuItems").createIndex({ price: 1 })
  await db.collection("orders").createIndex(
    { activeOrderKey: 1 },
    { unique: true, sparse: true },
  )
  await db.collection("orders").createIndex({ customerId: 1, status: 1, createdAt: -1 })
  await db.collection("orders").createIndex({ vendorId: 1, status: 1, createdAt: -1 })
  await db.collection("transactions").createIndex(
    { stripeSessionId: 1 },
    { unique: true, sparse: true },
  )
  await db.collection("webhookEvents").createIndex({ type: 1, processedAt: -1 })

  app.listen(port, () => {
    console.log(`Pizzora API is listening on port ${port}.`)
  })
}

server().catch(async (error) => {
  console.error("Failed to start Pizzora API.", error)
  await mongoClient.close()
  process.exitCode = 1
})

process.on("SIGINT", async () => {
  await mongoClient.close()
  process.exit(0)
})

process.on("SIGTERM", async () => {
  await mongoClient.close()
  process.exit(0)
})

export default app ;